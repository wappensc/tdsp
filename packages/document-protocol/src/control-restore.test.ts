import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import { encodeUpdate } from "@tdsp/reconciliation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compareClocks } from "./clock";
import { CURRENT_FRAME_VERSION, decodeFrame, type ResyncRequestFrame } from "./framing";
import { DocumentEngine, type PersistedControlState } from "./index";

/**
 * What a restarted participant's request and persisted control state say (SPECIFICATION.md
 * RSY-14, RSY-16, CTL-13, CTL-26, CTL-40, CTL-45, LIF-8): `controlClock` is `null` in a request
 * until the engine is bootstrapped, whatever control state it restored; a device of the creator is
 * bootstrapped after a restart only if it was, and its own clock goes on; and the engine reports
 * every change of its control state before its cursor reads past the delivery that brought it — so
 * an application that persists a cursor only behind the control state reported before it never
 * restores a cursor ahead of it.
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
  it("carries no control clock until the engine is bootstrapped, though it restored the creator's registers", async () => {
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
    expect((await requestsOf(port, "bob")).at(-1)?.controlClock).toBeNull(); // the first join
    bob.dispose();
    // Restored without a cursor: its state shows at once, and an answer must bootstrap it (CTL-41).
    const restarted = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, {
      ...AS_ALICE,
      controlState: saved as PersistedControlState,
    });
    expect(restarted.permissionOf("bob")).toBe("write");
    expect(restarted.hasCompletedBootstrap).toBe(false);
    expect((await requestsOf(port, "bob")).at(-1)?.controlClock).toBeNull();
    restarted.dispose();
  });

  it("of a device of the creator carries its control clock once it is bootstrapped, not before (RSY-14, RSY-16)", async () => {
    const port = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
    await alice.setMembership("bob", "write");
    // A new device that read every control frame from the history still asks with `null`: a frame
    // shows part of the creator's decisions, not all of them.
    const phone = await DocumentEngine.join(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
    expect(phone.controlStanding).toStrictEqual({ kind: "none" });
    expect(phone.permissionOf("bob")).toBe("write");
    expect((await requestsOf(port, "alice")).at(-1)?.controlClock).toBeNull();
    await settle(alice, phone); // the other device answers it with its snapshot, which bootstraps it
    expect(phone.controlStanding).toStrictEqual({ kind: "bootstrapped" });
    await phone.requestResync();
    const request = (await requestsOf(port, "alice")).at(-1);
    expect(request?.controlClock).toEqual(alice.controlClock);
    expect(request?.controlDigest).toMatch(/^[0-9a-f]{16}$/);
  });

  it("of a new device of the creator merges a snapshot of another device of the creator it overheard, but is bootstrapped only by an answer to its own request (RSY-12, RSY-14)", async () => {
    const port = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
    await alice.setMembership("bob", "write");
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, AS_ALICE);
    await settle(alice, bob);
    alice.dispose();
    // The history holds Alice's answer to Bob: merged, as every answer of the creator is (RSY-12,
    // CTL-25), but no answer to the phone's own request.
    const phone = await DocumentEngine.join(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
    expect(phone.permissionOf("bob")).toBe("write");
    expect(phone.controlStanding).toStrictEqual({ kind: "none" });
    expect((await requestsOf(port, "alice")).at(-1)?.controlClock).toBeNull();
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
        reported.push({
          cursor: engine.bob?.cursor,
          revoked: state.control.targets["member:bob"]?.value === null,
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

describe("a creator that has decided nothing yet (CTL-26, RSY-14)", () => {
  it("reports its control state when it creates, so its own restart is still bootstrapped", async () => {
    const port = new InMemoryMessengerPort();
    const reported: PersistedControlState[] = [];
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, {
      ...AS_ALICE,
      onControlStateChange: (state) => reported.push(state),
    });
    // Nothing decided: no member, no pace. What the creator's device holds is still its word.
    expect(reported).toHaveLength(1);
    expect(reported[0]?.bootstrapped).toBe(true);
    expect(reported[0]?.tdsp).toBe(CURRENT_FRAME_VERSION);
    expect(reported[0]?.clock).toEqual([0, 0]);
    expect(reported[0]?.device).toBe(alice.deviceTag);
    const state = encodeUpdate(alice.document);
    alice.dispose();

    const restarted = await DocumentEngine.join(DOCUMENT_ID, "alice", port, undefined, {
      ...AS_ALICE,
      controlState: reported.at(-1),
      restore: { state },
    });
    expect(restarted.controlStanding).toStrictEqual({ kind: "bootstrapped" });
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

describe("a restarted device of the creator (CTL-26, RSY-14, CTL-45)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Alice creates, grants Bob, and persists; what she persisted last, and her content. */
  async function persistedAlice() {
    const port = new InMemoryMessengerPort();
    const reported: PersistedControlState[] = [];
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, {
      ...AS_ALICE,
      onControlStateChange: (state) => reported.push(state),
    });
    await alice.setMembership("bob", "write");
    const state = encodeUpdate(alice.document);
    alice.dispose();
    return { port, saved: reported.at(-1) as PersistedControlState, state };
  }

  it("is bootstrapped only if it was when persisted", async () => {
    const { port, saved, state } = await persistedAlice();
    expect(saved.bootstrapped).toBe(true);
    const { bootstrapped: _bootstrapped, ...unbootstrapped } = saved;
    const fresh = await DocumentEngine.join(DOCUMENT_ID, "alice", port, undefined, {
      ...AS_ALICE,
      controlState: unbootstrapped,
      restore: { state },
    });
    expect(fresh.controlStanding).toStrictEqual({ kind: "none" });
    expect(fresh.permissionOf("bob")).toBe("write");
    // Not bootstrapped, it states no control clock (RSY-16).
    expect((await requestsOf(port, "alice")).at(-1)?.controlClock).toBeNull();
    fresh.dispose();
    // Bootstrapped, not knowing how long it was away, it makes a start request, an automatic one (RSY-1).
    const restored = await DocumentEngine.join(DOCUMENT_ID, "alice", port, undefined, {
      ...AS_ALICE,
      autoResync: true,
      controlState: saved,
      restore: { state },
    });
    expect(restored.controlStanding).toStrictEqual({ kind: "bootstrapped" });
    expect((await requestsOf(port, "alice")).at(-1)?.controlClock).toEqual(restored.controlClock);
    restored.dispose();
  });

  it("without a tag continues under a new one, with what it held", async () => {
    const { port, saved, state } = await persistedAlice();
    const { device: _device, ...untagged } = saved;
    const restarted = await DocumentEngine.join(DOCUMENT_ID, "alice", port, undefined, {
      ...AS_ALICE,
      controlState: untagged,
      restore: { state },
    });
    expect(restarted.deviceTag).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(restarted.deviceTag).not.toBe(saved.device);
    expect(restarted.permissionOf("bob")).toBe("write");
    restarted.dispose();
  });

  it("goes on with its own clock, so its next decision holds over what it held, its wall clock behind", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_793_008_800_000);
    const { port, saved, state } = await persistedAlice();
    const bobBefore = saved.control.targets["member:bob"];
    expect(bobBefore?.clock).toEqual([1_793_008_800_000, 0]);
    expect(saved.clock).toEqual([1_793_008_800_000, 0]);
    // Restarted with its wall clock an hour behind: the restored own clock orders the next decision.
    vi.setSystemTime(1_793_008_800_000 - 3_600_000);
    const restarted = await DocumentEngine.join(DOCUMENT_ID, "alice", port, undefined, {
      ...AS_ALICE,
      controlState: saved,
      restore: { state },
    });
    await restarted.setMembership("bob", "read");
    const bobAfter = restarted.controlState.targets["member:bob"];
    expect(compareClocks(bobAfter?.clock ?? [0, 0], bobBefore?.clock ?? [0, 0])).toBeGreaterThan(0);
    expect(restarted.permissionOf("bob")).toBe("read");
    restarted.dispose();
  });
});

describe("persisted control state of an earlier draft (CTL-26, CTL-39)", () => {
  /** The form an earlier draft persisted: operations per target, a control vector, a counter. */
  const draft5 = {
    profile: "yjs-paragraphs/1",
    control: {
      vector: { QUFBQUFBQUFBQUFBQUFBQQ: 1 },
      targets: {
        "member:bob": {
          seen: {},
          heads: [{ device: "QUFBQUFBQUFBQUFBQUFBQQ", counter: 1, value: "write", seen: {} }],
        },
      },
    },
    device: "QUFBQUFBQUFBQUFBQUFBQQ",
    counter: 1,
    basis: true,
    bootstrapped: true,
    unsent: [
      '{"tdsp":"de.wappensc.together.tdsp.probe.draft-5","kind":"control","documentId":"doc-1","device":"QUFBQUFBQUFBQUFBQUFBQQ","counter":1,"target":"member:bob","value":"write","seen":{},"due":0}',
    ],
  } as unknown as PersistedControlState;

  it("counts as none on a device of the creator: not bootstrapped, a new tag, no register, nothing resent", async () => {
    const port = new InMemoryMessengerPort();
    (await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_ALICE)).dispose();
    const alice = await DocumentEngine.join(DOCUMENT_ID, "alice", port, undefined, {
      ...AS_ALICE,
      controlState: draft5,
    });
    expect(alice.controlStanding).toStrictEqual({ kind: "none" });
    expect(alice.deviceTag).not.toBe("QUFBQUFBQUFBQUFBQUFBQQ");
    expect(alice.permissionOf("bob")).toBeUndefined();
    expect(alice.controlState.targets).toEqual({});
    await settle(alice);
    const sent = (await port.receive(DOCUMENT_ID, "observer")).map(
      (delivery) => decodeFrame(delivery.payload).kind,
    );
    expect(sent).not.toContain("control");
    alice.dispose();
  });

  it("counts as none for anyone else: not bootstrapped, no right shown", async () => {
    const port = new InMemoryMessengerPort();
    (await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_ALICE)).dispose();
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, {
      ...AS_ALICE,
      controlState: draft5,
    });
    expect(bob.hasCompletedBootstrap).toBe(false);
    expect(bob.permissionOf("bob")).toBeUndefined();
    expect((await requestsOf(port, "bob")).at(-1)?.controlClock).toBeNull();
    bob.dispose();
  });
});
