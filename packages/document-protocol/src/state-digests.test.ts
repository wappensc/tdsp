import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import type {
  Delivery,
  DeliveryId,
  DocumentId,
  MemberId,
  MessengerPort,
} from "@tdsp/messenger-port";
import { deletePlainText, getPlainText, insertPlainText } from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFrame } from "./framing";
import { ControlFrameRejectedError, DocumentEngine, type PersistedControlState } from "./index";

/**
 * State digests (SPECIFICATION.md §10, LOS-12, CTL-31): what a vector cannot show — a lost
 * deletion, two operations under one device and counter — shows as different digests at equal
 * vectors, is evidence, and is answered.
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

/** `port` as one device sees it: the deliveries in `hidden` never reach it. */
function hiding(port: InMemoryMessengerPort, hidden: Set<DeliveryId>): MessengerPort {
  const visible = (deliveries: readonly Delivery[]) =>
    deliveries.filter((delivery) => !hidden.has(delivery.id));
  return {
    transportProfile: () => port.transportProfile(),
    createDocument: (documentId, creator) => port.createDocument(documentId, creator),
    send: (documentId, sender, payload) => port.send(documentId, sender, payload),
    receive: async (documentId, member) => visible(await port.receive(documentId, member)),
    receiveSince: async (documentId, member, after) => {
      const answer = await port.receiveSince(documentId, member, after);
      return { ...answer, deliveries: visible(answer.deliveries) };
    },
    listChannels: (member: MemberId) => port.listChannels(member),
  };
}

/** The next `edit` frame `member` sends is accepted and never delivered; everything else goes. */
function dropNextEdit(port: InMemoryMessengerPort, member: MemberId): void {
  const original = port.send.bind(port);
  let dropped = false;
  port.send = async (documentId, sender, payload) => {
    if (!dropped && sender === member && decodeFrame(payload).kind === "edit") {
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

describe("two operations under one device and counter (CTL-24, CTL-31)", () => {
  it("are found by the creator's device in a member's report, which gives it nothing else, and end once decided again", async () => {
    const port = new InMemoryMessengerPort();
    let persisted: PersistedControlState | undefined;
    const hidden = new Set<DeliveryId>();
    const laptopErrors: unknown[] = [];
    const laptop = await DocumentEngine.create(
      DOCUMENT_ID,
      "alice",
      hiding(port, hidden),
      (error) => laptopErrors.push(error),
      {
        ...AS_ALICE,
        onControlStateChange: (state) => {
          persisted = state;
        },
      },
    );
    await laptop.setMembership("bob", "write");
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, AS_ALICE);
    await run([laptop, bob], 30_000);

    // A copy of the laptop's state on another computer — a migration — decides under the same
    // counter as the laptop, and the laptop never sees it.
    const copy = await DocumentEngine.join(DOCUMENT_ID, "alice", port, undefined, {
      ...AS_ALICE,
      controlState: persisted,
    });
    expect(copy.deviceTag).toBe(laptop.deviceTag);
    const before = (await port.receive(DOCUMENT_ID, "x")).length;
    await copy.setMembership("carol", "read");
    for (const delivery of (await port.receive(DOCUMENT_ID, "x")).slice(before))
      hidden.add(delivery.id);
    copy.dispose();
    await laptop.setMembership("carol", "write");

    await run([laptop, bob], 120_000);
    // Bob holds both and keeps the narrower (CTL-24); the laptop holds its own only.
    expect(bob.permissionOf("carol")).toBe("read");
    expect(laptop.permissionOf("carol")).toBe("write");
    const tag = laptop.deviceTag as string;
    expect(laptop.controlAnomalies).toContainEqual({
      device: tag,
      counter: laptop.controlVector[tag],
    });
    expect(
      laptopErrors.some(
        (error) =>
          error instanceof ControlFrameRejectedError && error.message.includes("decide it again"),
      ),
    ).toBe(true);

    // Deciding again supersedes both, and the two agree.
    await laptop.setMembership("carol", "read");
    await run([laptop, bob], 60_000);
    expect(bob.permissionOf("carol")).toBe("read");
    expect(laptop.syncHealth.suspicions.filter((s) => s.kind === "control-diverged")).toEqual([]);
    expect(bob.syncHealth.suspicions.filter((s) => s.kind === "control-diverged")).toEqual([]);
  });
});
