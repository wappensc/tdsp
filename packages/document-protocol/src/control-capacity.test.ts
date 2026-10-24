import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import type {
  Delivery,
  DeliveryId,
  DocumentId,
  MemberId,
  MessengerPort,
  RawChannel,
} from "@tdsp/messenger-port";
import { insertPlainText } from "@tdsp/reconciliation";
import { describe, expect, it } from "vitest";
import { MAX_CONTROL_BYTES } from "./control-state";
import { encodeControlFrame } from "./framing";
import { ControlFrameRejectedError, DocumentEngine, type PersistedControlState } from "./index";

/**
 * A capacity conflict (SPECIFICATION.md CTL-30, CTL-32) as the engine shows it: a client that
 * cannot hold an operation or a snapshot of the creator for the bytes of control state says so,
 * takes no new member or layer right, refuses its own edits as `read` does, keeps the conflict
 * across a restart, and is not bootstrapped by a snapshot it could not hold (CTL-13).
 */

const DOCUMENT_ID = "doc-1";
const AS_ALICE = { batchWindowMs: 0, resyncResponseThrottleMs: 0, creatorMemberId: "alice" };

/** An in-memory transport that hides the deliveries it is told to from one member. */
class HidingPort implements MessengerPort {
  readonly inner = new InMemoryMessengerPort();
  readonly #hidden = new Map<MemberId, Set<DeliveryId>>();

  createDocument(documentId: DocumentId, creator: MemberId): Promise<void> {
    return this.inner.createDocument(documentId, creator);
  }

  send(documentId: DocumentId, sender: MemberId, payload: string): Promise<DeliveryId> {
    return this.inner.send(documentId, sender, payload);
  }

  /** Sends as `sender`, and `from` never sees it. */
  async sendHiddenFrom(from: MemberId, sender: MemberId, payload: string): Promise<void> {
    const id = await this.inner.send(DOCUMENT_ID, sender, payload);
    const hidden = this.#hidden.get(from) ?? new Set<DeliveryId>();
    hidden.add(id);
    this.#hidden.set(from, hidden);
  }

  listChannels(member: MemberId): Promise<readonly RawChannel[]> {
    return this.inner.listChannels(member);
  }

  async receive(documentId: DocumentId, member: MemberId): Promise<readonly Delivery[]> {
    const hidden = this.#hidden.get(member);
    return (await this.inner.receive(documentId, member)).filter(
      (delivery) => !hidden?.has(delivery.id),
    );
  }
}

/** What the operations below had seen of 40 other devices: it makes each about 2 540 bytes of control state. */
const PADDING = Object.fromEntries(
  Array.from({ length: 40 }, (_, k) => [`P${String(k).padStart(21, "0")}`, 7]),
);
const GRANT_BYTES = 2_540;

/**
 * One operation of a device of Alice's, as her account could send it. Large, so that the bytes of
 * control state bind before the bound on targets, whatever the bytes a client holds (CTL-30).
 */
const grant = (device: string, counter: number, prefix: string) =>
  encodeControlFrame({
    documentId: DOCUMENT_ID,
    device,
    counter,
    target: `member:@${prefix}${String(counter).padStart(250, "x")}` as "member:bob",
    value: "read",
    seen: PADDING,
  });

async function settle(...engines: DocumentEngine[]): Promise<void> {
  for (let round = 0; round < 4; round++) {
    for (const engine of engines) {
      await engine.sync();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

describe("a capacity conflict (CTL-30, CTL-32)", () => {
  it("a member that cannot hold the creator's operations for their bytes says so, refuses its edits and takes no new right", async () => {
    const port = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
    await alice.setMembership("bob", "write");
    let saved: PersistedControlState | undefined;
    const errors: unknown[] = [];
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, (error) => errors.push(error), {
      ...AS_ALICE,
      onControlStateChange: (state) => {
        saved = state;
      },
    });
    await settle(alice, bob);
    expect(bob.mayEdit).toBe(true);
    expect(bob.capacityConflict).toBe(false);

    // Alice's account sends more than this client holds, from a device of its own.
    const device = "X".repeat(22);
    const count = Math.ceil(MAX_CONTROL_BYTES / GRANT_BYTES) + 100;
    for (let counter = 1; counter <= count; counter++)
      await port.send(DOCUMENT_ID, "alice", grant(device, counter, "a"));
    await bob.sync();
    expect(bob.capacityConflict).toBe(true);
    expect(
      errors.some(
        (error) => error instanceof ControlFrameRejectedError && error.reason === "refused",
      ),
    ).toBe(true);
    expect(bob.mayEdit).toBe(false);
    await expect(bob.resync()).rejects.toMatchObject({ reason: "capacity-conflict" });
    bob.edit((fragment) => insertPlainText(fragment, 0, "x"));
    await bob.flush().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      errors.some((error) => (error as { reason?: string }).reason === "capacity-conflict"),
    ).toBe(true);

    // Changes of what it holds still apply; a new member does not, even one that would fit.
    await alice.setMembership("bob", "read");
    await alice.setMembership("carol", "write");
    await bob.sync();
    expect(bob.permissionOf("bob")).toBe("read");
    expect(bob.permissionOf("carol")).toBeUndefined();

    // Persisted with the control state, and restored with it.
    expect(saved?.capacityConflict).toBe(true);
    bob.dispose();
    const restarted = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, {
      ...AS_ALICE,
      controlState: saved as PersistedControlState,
    });
    expect(restarted.capacityConflict).toBe(true);
    expect(restarted.mayEdit).toBe(false);
  });

  it("an answer whose snapshot the joiner could not hold does not bootstrap it (CTL-13, KZ-10)", async () => {
    const port = new HidingPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
    // Two devices of Alice's that each decided about 60 % of what a client holds, apart: Alice's engine holds one set,
    // and the joiner the other, read as frames from the channel's history.
    const count = Math.floor((MAX_CONTROL_BYTES * 0.6) / GRANT_BYTES);
    for (let counter = 1; counter <= count; counter++) {
      await port.sendHiddenFrom("dave", "alice", grant("B".repeat(22), counter, "b"));
      await port.sendHiddenFrom("alice", "alice", grant("A".repeat(22), counter, "a"));
    }
    await alice.sync();
    const errors: unknown[] = [];
    const dave = await DocumentEngine.join(
      DOCUMENT_ID,
      "dave",
      port,
      (error) => errors.push(error),
      AS_ALICE,
    );
    expect(dave.capacityConflict).toBe(false);
    await settle(alice, dave);
    // Alice answered with her snapshot; the union is over the bytes, so the joiner refused it whole.
    expect(
      errors.some(
        (error) => error instanceof ControlFrameRejectedError && error.reason === "refused",
      ),
    ).toBe(true);
    expect(dave.capacityConflict).toBe(true);
    expect(dave.hasCompletedBootstrap).toBe(false);
    expect(dave.mayEdit).toBe(false);
    expect(alice.capacityConflict).toBe(false);
  });

  it("two devices' decisions of 609 011 bytes each, each valid alone, converge in every order, over 1 MiB", async () => {
    const port = new HidingPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
    /** Operations near the bound: 1 600 of one device, ids of 245 characters, `read`, nothing seen. */
    const nearBound = (device: string, counter: number, prefix: string) =>
      encodeControlFrame({
        documentId: DOCUMENT_ID,
        device,
        counter,
        target:
          `member:${prefix}${String(counter - 1).padStart(4, "0")}${"x".repeat(240)}` as "member:bob",
        value: "read",
        seen: {},
      });
    for (let counter = 1; counter <= 1_600; counter++) {
      await port.sendHiddenFrom("dave", "alice", nearBound("B".repeat(22), counter, "b"));
      await port.sendHiddenFrom("alice", "alice", nearBound("A".repeat(22), counter, "a"));
    }
    await alice.sync();
    expect(
      new TextEncoder().encode(
        JSON.stringify({ vector: alice.controlState.vector, targets: alice.controlState.targets }),
      ).length,
    ).toBe(609_011);
    // The joiner holds the other device's decisions, read as frames, and merges Alice's snapshot.
    const dave = await DocumentEngine.join(DOCUMENT_ID, "dave", port, undefined, AS_ALICE);
    await settle(alice, dave);
    expect(dave.capacityConflict).toBe(false);
    expect(dave.hasCompletedBootstrap).toBe(true);
    // Alice gets them as frames later: the other order, the same union.
    for (let counter = 1; counter <= 1_600; counter++)
      await port.sendHiddenFrom("dave", "alice", nearBound("A".repeat(22), counter, "a"));
    await settle(alice, dave);
    expect(alice.capacityConflict).toBe(false);
    expect(Object.keys(alice.controlState.targets)).toHaveLength(3_200);
    expect(dave.controlState).toEqual(alice.controlState);
    expect(new TextEncoder().encode(JSON.stringify(dave.controlState)).length).toBeGreaterThan(
      1_048_576,
    );
  });

  it("a device of the creator in a conflict issues no new member, and still revokes and closes", async () => {
    const port = new InMemoryMessengerPort();
    const persisted: PersistedControlState[] = [];
    const laptop = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, {
      ...AS_ALICE,
      onControlStateChange: (state) => {
        persisted.push(state);
      },
    });
    await laptop.setMembership("bob", "write");
    const device = "X".repeat(22);
    const count = Math.ceil(MAX_CONTROL_BYTES / GRANT_BYTES) + 100;
    for (let counter = 1; counter <= count; counter++)
      await port.send(DOCUMENT_ID, "alice", grant(device, counter, "a"));
    await laptop.sync();
    expect(laptop.capacityConflict).toBe(true);
    expect(laptop.mayEdit).toBe(false);
    await expect(laptop.setMembership("carol", "read")).rejects.toMatchObject({
      reason: "capacity-conflict",
    });
    const before = persisted.length;
    await laptop.setMembership("bob", null);
    expect(laptop.rightOf("bob")).toBe("revoked");
    await laptop.closeDocument();
    expect(laptop.closed).toBe(true);
    // Every state it persisted meanwhile, the one before each send included, keeps the conflict.
    expect(persisted.length).toBeGreaterThan(before);
    expect(persisted.slice(before).every((state) => state.capacityConflict === true)).toBe(true);
  });
});
