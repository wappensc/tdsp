import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import type { DocumentId, MemberId } from "@tdsp/messenger-port";
import { deletePlainText, getPlainText, insertPlainText } from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFrame } from "./framing";
import { DocumentEngine } from "./index";

/**
 * Digests (SPECIFICATION.md §10, LOS-12, LOS-24): what a state vector or a control clock cannot show —
 * a lost deletion, a lost close — shows as different digests at equal vectors or clocks, is evidence,
 * and is answered.
 */

const DOCUMENT_ID: DocumentId = "doc-1";
const WATCHED = {
  batchWindowMs: 0,
  syncPolicy: { maxIntervalMs: 20_000, expectedLatencyMs: 5_000 },
};
const AS_ALICE = { ...WATCHED, creatorMemberId: "alice", resyncResponseThrottleMs: 0 };

/** Time passes in steps, and every engine reads after each. */
async function run(engines: readonly DocumentEngine[], ms: number, step = 1_000): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    await vi.advanceTimersByTimeAsync(step);
    for (const engine of engines) {
      await engine.sync();
    }
  }
}

/** The next frame of `kind` `member` sends is accepted and never delivered; everything else goes. */
function dropNextEdit(port: InMemoryMessengerPort, member: MemberId, kind = "edit"): void {
  const original = port.send.bind(port);
  let dropped = false;
  port.send = async (documentId, sender, payload) => {
    if (!dropped && sender === member && decodeFrame(payload).kind === kind) {
      dropped = true;
      return "lost";
    }
    return original(documentId, sender, payload);
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a lost deletion (LOS-12, RSY-17)", () => {
  async function aliceAndBob() {
    const port = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
    await alice.setMembership("bob", "write");
    alice.edit((fragment) => insertPlainText(fragment, 0, "abc"));
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, AS_ALICE);
    // Long enough for every request either kept to expire (RSY-19): what heals below is the
    // evidence the digest gives, not an old request that now finds something to offer.
    await run([alice, bob], 6 * 60_000, 10_000);
    expect(getPlainText(bob.fragment)).toBe("abc");
    expect(alice.syncHealth.suspicions).toEqual([]);
    return { port, alice, bob };
  }

  it("of a member is noticed by the creator at equal vectors, and healed by the answer it asks for", async () => {
    const { port, alice, bob } = await aliceAndBob();
    dropNextEdit(port, "bob");
    bob.edit((fragment) => deletePlainText(fragment, 1, 1)); // lost
    // Every vector stays equal: only the digests, in Bob's heartbeat and requests, differ.
    await run([alice, bob], 90_000);
    expect(getPlainText(alice.fragment)).toBe("ac");
    expect(alice.syncHealth.suspicions).toEqual([]);
    expect(bob.syncHealth.suspicions).toEqual([]);
  });

  it("of the creator is noticed by a member at equal vectors, and healed by the creator's answer", async () => {
    const { port, alice, bob } = await aliceAndBob();
    dropNextEdit(port, "alice");
    alice.edit((fragment) => deletePlainText(fragment, 1, 1)); // lost
    await run([alice, bob], 90_000);
    expect(getPlainText(bob.fragment)).toBe("ac");
    expect(bob.syncHealth.suspicions).toEqual([]);
    expect(alice.syncHealth.suspicions).toEqual([]);
  });
});

describe("an answer's last piece (RSY-18)", () => {
  it("states the responder's state vector and digest, and no other piece does", async () => {
    const port = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
    alice.edit((fragment) => insertPlainText(fragment, 0, "abc"));
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, AS_ALICE);
    await run([alice, bob], 3_000);
    const answers = (await port.receive(DOCUMENT_ID, "x"))
      .map((delivery) => decodeFrame(delivery.payload))
      .filter((frame) => frame.kind === "resync-response");
    expect(answers.length).toBeGreaterThan(0);
    for (const answer of answers) {
      expect(answer.kind === "resync-response" && answer.stateVector).not.toBeNull();
      expect(answer.kind === "resync-response" && answer.stateDigest).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});

describe("a lost close (LOS-12, RSY-17)", () => {
  it("shows a member another control digest at an equal control clock, and the answer it asks for closes it", async () => {
    const port = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
    await alice.setMembership("bob", "write");
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, AS_ALICE);
    await run([alice, bob], 6 * 60_000, 10_000);
    expect(bob.controlClock).toEqual(alice.controlClock);
    expect(bob.controlState.targets).toEqual(alice.controlState.targets);

    dropNextEdit(port, "alice", "control");
    await alice.closeDocument(); // lost
    // The close is no register: the control clock stays where it was, only the digest differs.
    expect(alice.controlClock).toEqual(bob.controlClock);
    expect(bob.closed).toBe(false);
    await run([alice, bob], 120_000);
    expect(bob.closed).toBe(true);
    expect(bob.syncHealth.suspicions).toEqual([]);
  });

  it("is no evidence where the clocks differ: the greater one is evidence of its own (LOS-10)", async () => {
    const port = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
    await alice.setMembership("bob", "write");
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, AS_ALICE);
    await run([alice, bob], 6 * 60_000, 10_000);

    dropNextEdit(port, "alice", "control");
    await alice.setMembership("carol", "read"); // lost
    await run([alice, bob], 60_000);
    // The heartbeat after it states a control clock above Bob's: Bob asks and gets the register.
    expect(bob.permissionOf("carol")).toBe("read");
    expect(bob.controlClock).toEqual(alice.controlClock);
    expect(bob.syncHealth.suspicions).toEqual([]);
  });
});
