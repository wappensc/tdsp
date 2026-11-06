import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import { describe, expect, it } from "vitest";
import { ControlState, channelInconsistencies, type Register } from "./control-state";
import { DocumentEngine } from "./index";

/**
 * Where the channel and the control state differ (SPECIFICATION.md LIF-10): channel members no
 * register names, the creator aside, members whose register gives `read` or `write` who are not
 * in the channel, and members whose permission is revoked who are still in it — apart where the
 * application is removing them right now. The application lists the channel (TRN-17) and shows what
 * the engine compares; the engine asks the transport for nothing.
 */

const DOC = "doc-1";
const AS_ALICE = { batchWindowMs: 0, resyncResponseThrottleMs: 0, creatorMemberId: "alice" };
const TAG = "C".repeat(22);

const register = (value: Register["value"], ms: number): Register => ({
  value,
  clock: [ms, 0],
  device: TAG,
});

function stateOf(targets: Record<string, Register>): ControlState {
  const state = new ControlState();
  state.take({ closed: false, targets });
  return state;
}

async function settle(...engines: DocumentEngine[]): Promise<void> {
  for (let round = 0; round < 6; round++) {
    for (const engine of engines) {
      await engine.sync();
      await engine.flush().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

describe("comparing the channel with the control state (LIF-10)", () => {
  it("lists channel members no register names, and granted members outside the channel, sorted", () => {
    const state = stateOf({
      "member:bob": register("write", 1),
      "member:carol": register(null, 2),
      "member:dave": register("read", 3),
      "member:erin": register("write", 4),
      "layer:com.example.comments/1:member:frank": register("write", 5),
      pace: register(1_000, 6),
    });
    const channel = ["zoe", "alice", "bob", "carol", "frank", "mallory", "bob"];
    expect(channelInconsistencies(state, "alice", channel)).toStrictEqual({
      // Carol is revoked, which names her; Frank holds only a right on a layer, so his permission on
      // the document is unknown (LAY-5); the creator is never a target.
      unnamed: ["frank", "mallory", "zoe"],
      // Dave and Erin hold rights but are not in the channel: they receive nothing (§15.2).
      notInChannel: ["dave", "erin"],
      // Carol is revoked and still in the channel: she still receives every frame (§15.2).
      revokedInChannel: ["carol"],
      beingRemoved: [],
    });
  });

  it("lists a revoked member still in the channel apart while the application removes it, and not once it is out", () => {
    const state = stateOf({
      "member:bob": register(null, 1),
      "member:carol": register(null, 2),
      "member:dave": register(null, 3),
    });
    expect(
      channelInconsistencies(state, "alice", ["alice", "bob", "carol"], ["carol", "dave"]),
    ).toStrictEqual({
      unnamed: [],
      notInChannel: [],
      // Bob was revoked and is still in the channel, as when removing him failed or someone took
      // him back in the messenger; Carol is being removed right now; Dave is out.
      revokedInChannel: ["bob"],
      beingRemoved: ["carol"],
    });
  });

  it("finds nothing where the channel and the rights are in step", () => {
    const state = stateOf({
      "member:bob": register("write", 1),
      "member:carol": register("read", 2),
    });
    expect(channelInconsistencies(state, "alice", ["alice", "bob", "carol"])).toStrictEqual({
      unnamed: [],
      notInChannel: [],
      revokedInChannel: [],
      beingRemoved: [],
    });
  });

  it("is the engine's only once its control state is known, and then as it holds it", async () => {
    const port = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOC, "alice", port, undefined, AS_ALICE);
    await alice.setMembership("bob", "write");
    await alice.setMembership("dave", "read");
    const bob = await DocumentEngine.join(DOC, "bob", port, undefined, AS_ALICE);
    const channel = ["alice", "bob", "carol"];
    // Before its bootstrap everyone would look unnamed.
    expect(bob.channelInconsistencies(channel)).toBeUndefined();
    await settle(alice, bob);
    for (const engine of [alice, bob]) {
      expect(engine.channelInconsistencies(channel)).toStrictEqual({
        unnamed: ["carol"],
        notInChannel: ["dave"],
        revokedInChannel: [],
        beingRemoved: [],
      });
    }
    // Bob revoked while he is still in the channel; then the application removes him.
    await alice.setMembership("bob", null);
    await settle(alice, bob);
    for (const engine of [alice, bob]) {
      expect(engine.channelInconsistencies(channel)).toMatchObject({
        revokedInChannel: ["bob"],
        beingRemoved: [],
      });
      expect(engine.channelInconsistencies(channel, { removing: ["bob"] })).toMatchObject({
        revokedInChannel: [],
        beingRemoved: ["bob"],
      });
    }
    expect(alice.channelInconsistencies(["alice", "carol"])).toMatchObject({
      revokedInChannel: [],
      beingRemoved: [],
    });
    // A device of the creator that is not bootstrapped holds nothing it could compare (RSY-14).
    const empty = new InMemoryMessengerPort();
    await empty.createDocument(DOC, "alice");
    const fresh = await DocumentEngine.join(DOC, "alice", empty, undefined, AS_ALICE);
    expect(fresh.controlStanding).toStrictEqual({ kind: "none" });
    expect(fresh.channelInconsistencies(channel)).toBeUndefined();
  });
});
