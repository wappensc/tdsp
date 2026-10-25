import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import { encodeUpdate } from "@tdsp/reconciliation";
import { describe, expect, it } from "vitest";
import { decodeFrame, type ResyncRequestFrame } from "./framing";
import { DocumentEngine, type PersistedControlState } from "./index";

/**
 * What a restarted participant's request and persisted control state say (SPECIFICATION.md
 * RSY-16, CTL-13, CTL-40, LIF-8): `control` is `null` in a request until the engine is
 * bootstrapped, whatever control state it restored, and the engine reports every change of its
 * control state before its cursor reads past the delivery that brought it — so an application that
 * persists a cursor only behind the control state reported before it never restores a cursor ahead
 * of it.
 */

const DOCUMENT_ID = "doc-1";
const AS_ALICE = {
  batchWindowMs: 0,
  resyncResponseThrottleMs: 0,
  creatorMemberId: "alice",
  autoResync: false,
};

async function settle(...engines: DocumentEngine[]): Promise<void> {
  for (let round = 0; round < 4; round++) {
    for (const engine of engines) {
      await engine.sync();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

/** The resync requests `member` sent, newest last. */
async function requestsOf(
  port: InMemoryMessengerPort,
  member: string,
): Promise<ResyncRequestFrame[]> {
  return (await port.receive(DOCUMENT_ID, "observer"))
    .filter((delivery) => delivery.sender === member)
    .map((delivery) => decodeFrame(delivery.payload))
    .filter((frame): frame is ResyncRequestFrame => frame.kind === "resync-request");
}

describe("a restarted participant's request (RSY-16, CTL-13)", () => {
  it("carries no control vector until the engine is bootstrapped, though it restored the creator's operations", async () => {
    const port = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
    await alice.setMembership("bob", "write");
    let saved: PersistedControlState | undefined;
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, {
      ...AS_ALICE,
      onControlStateChange: (state) => {
        saved = state;
      },
    });
    await settle(alice, bob);
    expect((await requestsOf(port, "bob")).at(-1)?.control).toBeNull(); // the first join
    bob.dispose();
    // Restored without a cursor: its state shows at once, and an answer must bootstrap it (CTL-41).
    const restarted = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, {
      ...AS_ALICE,
      controlState: saved as PersistedControlState,
    });
    expect(restarted.permissionOf("bob")).toBe("write");
    expect(restarted.hasCompletedBootstrap).toBe(false);
    expect((await requestsOf(port, "bob")).at(-1)?.control).toBeNull();
    // A device of the creator sends its control vector, bootstrapped or not, once it has a basis
    // (CTL-28): a new one that read every operation from the history still asks with `null`.
    const phone = await DocumentEngine.join(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
    expect(phone.controlConfirmed).toBe(false);
    expect((await requestsOf(port, "alice")).at(-1)?.control).toBeNull();
    await settle(alice, phone); // the other device answers it, which gives it its basis
    expect(phone.controlConfirmed).toBe(true);
    await phone.requestResync();
    expect((await requestsOf(port, "alice")).at(-1)?.control).toEqual(alice.controlVector);
  });
});

describe("the control state an engine reports, and its cursor (CTL-40, LIF-8)", () => {
  it("reports a change of its control state before its cursor reads past the delivery that brought it", async () => {
    const port = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
    await alice.setMembership("bob", "write");
    const reported: { readonly cursor: string | undefined; readonly revoked: boolean }[] = [];
    const engine: { bob?: DocumentEngine } = {};
    engine.bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, {
      ...AS_ALICE,
      onControlStateChange: (state) => {
        const heads = state.control.targets["member:bob"]?.heads ?? [];
        reported.push({
          cursor: engine.bob?.cursor,
          revoked: heads.some((head) => head.value === null),
        });
      },
    });
    const bob = engine.bob;
    await settle(alice, bob);
    await alice.setMembership("bob", null);
    const revocation = (await port.receive(DOCUMENT_ID, "observer")).at(-1)?.id;
    await bob.sync();
    const first = reported.find((entry) => entry.revoked);
    expect(first).toBeDefined();
    // Reported while the cursor still stood before the revocation, which it reads past only now.
    expect(first?.cursor).not.toBe(revocation);
    expect(bob.cursor).toBe(revocation);
  });
});

describe("a creator that has issued nothing yet (CTL-26, CTL-28)", () => {
  it("reports its control state when it creates, so its own restart still has a basis", async () => {
    const port = new InMemoryMessengerPort();
    const reported: PersistedControlState[] = [];
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, {
      ...AS_ALICE,
      onControlStateChange: (state) => reported.push(state),
    });
    // Nothing decided: no member, no pace. What the creator's device has is still a basis.
    expect(reported).toHaveLength(1);
    expect(reported[0]?.basis).toBe(true);
    expect(reported[0]?.device).toBe(alice.deviceTag);
    const state = encodeUpdate(alice.document);
    alice.dispose();

    const restarted = await DocumentEngine.join(DOCUMENT_ID, "alice", port, undefined, {
      ...AS_ALICE,
      controlState: reported.at(-1),
      restore: { state },
    });
    expect(restarted.controlConfirmed).toBe(true);
    expect(restarted.deviceTag).toBe(reported[0]?.device);
    restarted.dispose();
  });

  it("creates nothing when the control state cannot be persisted", async () => {
    const port = new InMemoryMessengerPort();
    await expect(
      DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, {
        ...AS_ALICE,
        onControlStateChange: () => {
          throw new Error("disk full");
        },
      }),
    ).rejects.toThrow(/disk full/);
    // LIF-5, CTL-26: no start frame left the device, so a later create is not a second one.
    expect(await port.receive(DOCUMENT_ID, "observer")).toHaveLength(0);
  });
});
