import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LOSS_GRACE_MS, LossDetector } from "./loss-detector";
import { resolveSyncPolicy, type SyncPolicy } from "./sync-policy";

// The detector is exercised against a fake clock and fake views of the document, so each
// kind of evidence and each wait is tested on its own; the real Yjs situations they stand for
// are in reconciliation's tests, and the whole path through a DocumentEngine is in index.test.ts.

const T0 = 1_000_000;
const STATE = new Uint8Array([1, 2, 3]);

interface World {
  detector: LossDetector;
  gaps: number[];
  behind: boolean;
  highestControl: number;
  controlGaps: number[];
  policy: SyncPolicy;
  creator: string | undefined;
}

function world(policy: Partial<SyncPolicy> = {}): World {
  const w: World = {
    detector: undefined as unknown as LossDetector,
    gaps: [],
    behind: false,
    highestControl: 0,
    controlGaps: [],
    policy: resolveSyncPolicy({ expectedLatencyMs: 10_000, maxIntervalMs: 60_000, ...policy }),
    creator: "alice",
  };
  w.detector = new LossDetector({
    memberId: "me",
    creatorMemberId: () => w.creator,
    policy: () => w.policy,
    pendingGapClients: () => w.gaps,
    lacksUpdatesOf: () => w.behind,
    highestControlSequence: () => w.highestControl,
    controlGaps: () => w.controlGaps,
  });
  return w;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a pending gap", () => {
  it("is not reported until it has lasted one expected latency: a late predecessor looks the same", () => {
    const w = world();
    w.gaps = [42];
    w.detector.observe();
    vi.advanceTimersByTime(9_999);
    w.detector.observe();
    expect(w.detector.suspicions()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(w.detector.suspicions()).toEqual([{ kind: "pending-gap", since: T0 }]);
  });

  it("counts from the first sighting, not from the most recent poll", () => {
    const w = world();
    w.gaps = [42];
    w.detector.observe();
    vi.advanceTimersByTime(6_000);
    w.detector.observe(); // seen again, but not new
    vi.advanceTimersByTime(4_000);
    expect(w.detector.suspicions()).toHaveLength(1);
  });

  it("goes away when the predecessor arrives, and starts counting afresh for the next gap", () => {
    const w = world();
    w.gaps = [42];
    w.detector.observe();
    vi.advanceTimersByTime(20_000);
    expect(w.detector.suspicions()).toHaveLength(1);
    w.gaps = [];
    w.detector.observe();
    expect(w.detector.suspicions()).toEqual([]);
    w.gaps = [42];
    w.detector.observe();
    vi.advanceTimersByTime(5_000);
    expect(w.detector.suspicions()).toEqual([]); // a new gap, only 5 s old
  });

  it("names the sender when the client id is known from an earlier single-author edit", () => {
    const w = world();
    w.detector.learnClient(42, "bob");
    w.gaps = [42];
    w.detector.observe();
    vi.advanceTimersByTime(10_000);
    expect(w.detector.suspicions()).toEqual([{ kind: "pending-gap", sender: "bob", since: T0 }]);
  });

  it("does not guess a sender it has not learned", () => {
    const w = world();
    w.gaps = [42];
    w.detector.observe();
    vi.advanceTimersByTime(10_000);
    expect(w.detector.suspicions()[0]).not.toHaveProperty("sender");
  });

  it("waits DEFAULT_LOSS_GRACE_MS when the policy does not say how long a message takes", () => {
    const w = world({ expectedLatencyMs: 0 });
    w.gaps = [1];
    w.detector.observe();
    vi.advanceTimersByTime(DEFAULT_LOSS_GRACE_MS - 1);
    expect(w.detector.suspicions()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(w.detector.suspicions()).toHaveLength(1);
  });
});

describe("an overdue sender", () => {
  it("is reported when an edit is followed by nothing for maxInterval plus one expected latency", () => {
    const w = world(); // 60 s + 10 s
    w.detector.heardEdit("bob");
    vi.advanceTimersByTime(69_999);
    expect(w.detector.suspicions()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(w.detector.suspicions()).toEqual([{ kind: "sender-overdue", sender: "bob", since: T0 }]);
  });

  it("is cleared by any later message from the sender", () => {
    const w = world();
    w.detector.heardEdit("bob");
    vi.advanceTimersByTime(60_000);
    w.detector.heardEdit("bob"); // more edits
    vi.advanceTimersByTime(60_000);
    expect(w.detector.suspicions()).toEqual([]);
  });

  it("is not reported after a heartbeat: it says nothing further is due, however long the silence", () => {
    const w = world();
    w.detector.heardEdit("bob");
    w.detector.heardHeartbeat("bob", STATE, 0);
    vi.advanceTimersByTime(24 * 3_600_000);
    expect(w.detector.suspicions().filter((s) => s.kind === "sender-overdue")).toEqual([]);
  });

  it("is a soft signal that needs a maxInterval: with none, silence means nothing", () => {
    const w = world({ maxIntervalMs: Number.POSITIVE_INFINITY });
    w.detector.heardEdit("bob");
    vi.advanceTimersByTime(24 * 3_600_000);
    expect(w.detector.suspicions()).toEqual([]);
  });

  it("is spent by a resync answer, so a sender who simply went offline is not reported forever", () => {
    const w = world();
    w.detector.heardEdit("bob");
    vi.advanceTimersByTime(80_000);
    expect(w.detector.suspicions()).toHaveLength(1);
    w.detector.answered();
    expect(w.detector.suspicions()).toEqual([]);
  });

  it("never reports the client's own messages", () => {
    const w = world();
    w.detector.heardEdit("me");
    w.detector.heardHeartbeat("me", STATE, 0);
    vi.advanceTimersByTime(24 * 3_600_000);
    expect(w.detector.suspicions()).toEqual([]);
  });
});

describe("a heartbeat that shows we are behind", () => {
  it("is reported once it has lasted one expected latency, since the missing changes may be in flight", () => {
    const w = world();
    w.behind = true;
    w.detector.heardHeartbeat("bob", STATE, 0);
    vi.advanceTimersByTime(9_999);
    expect(w.detector.suspicions().filter((s) => s.kind === "behind-heartbeat")).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(w.detector.suspicions()).toEqual([
      { kind: "behind-heartbeat", sender: "bob", since: T0 },
    ]);
  });

  it("is not reported when the heartbeat's state is one we already have", () => {
    const w = world();
    w.behind = false;
    w.detector.heardHeartbeat("bob", STATE, 0);
    vi.advanceTimersByTime(60_000);
    expect(w.detector.suspicions()).toEqual([]);
  });

  it("goes away by itself once the changes arrive, because it is judged against the document as it is now", () => {
    const w = world();
    w.behind = true;
    w.detector.heardHeartbeat("bob", STATE, 0);
    vi.advanceTimersByTime(20_000);
    expect(w.detector.suspicions()).toHaveLength(1);
    w.behind = false; // the late edit arrived
    expect(w.detector.suspicions()).toEqual([]);
  });

  it("ignores a heartbeat whose state vector is not one, rather than reporting a loss on garbage", () => {
    const w = new LossDetector({
      memberId: "me",
      creatorMemberId: () => undefined,
      policy: () => resolveSyncPolicy({ expectedLatencyMs: 1000 }),
      pendingGapClients: () => [],
      lacksUpdatesOf: () => {
        throw new Error("not a state vector");
      },
      highestControlSequence: () => 0,
      controlGaps: () => [],
    });
    w.heardHeartbeat("bob", STATE, 0);
    vi.advanceTimersByTime(60_000);
    expect(w.suspicions()).toEqual([]);
  });
});

describe("control state that is behind", () => {
  it("is reported when the creator's heartbeat names a control sequence we have not seen", () => {
    const w = world();
    w.highestControl = 3;
    w.detector.heardHeartbeat("alice", STATE, 5);
    w.detector.observe();
    vi.advanceTimersByTime(10_000);
    expect(w.detector.suspicions().filter((s) => s.kind === "control-behind")).toEqual([
      { kind: "control-behind", since: T0 },
    ]);
  });

  it("believes a control sequence only from the creator: anyone else's heartbeat cannot claim one", () => {
    const w = world();
    w.highestControl = 3;
    w.detector.heardHeartbeat("mallory", STATE, 4_000_000_000);
    w.detector.observe();
    vi.advanceTimersByTime(60_000);
    expect(w.detector.suspicions().filter((s) => s.kind === "control-behind")).toEqual([]);
  });

  it("is reported for a gap in the numbers we have, with no heartbeat needed", () => {
    const w = world();
    w.controlGaps = [2];
    w.detector.observe();
    vi.advanceTimersByTime(10_000);
    expect(w.detector.suspicions()).toEqual([{ kind: "control-behind", since: T0 }]);
  });

  it("goes away when we catch up to the creator's number", () => {
    const w = world();
    w.highestControl = 3;
    w.detector.heardHeartbeat("alice", STATE, 5);
    w.detector.observe();
    vi.advanceTimersByTime(20_000);
    expect(w.detector.suspicions()).toHaveLength(1);
    w.highestControl = 5;
    w.detector.observe();
    expect(w.detector.suspicions()).toEqual([]);
  });
});

describe("several kinds of evidence at once", () => {
  it("are all reported, each with its own start", () => {
    const w = world();
    w.gaps = [1];
    w.behind = true;
    w.detector.observe();
    w.detector.heardHeartbeat("bob", STATE, 0);
    w.detector.heardEdit("carol");
    vi.advanceTimersByTime(70_000);
    expect(
      w.detector
        .suspicions()
        .map((s) => s.kind)
        .sort(),
    ).toEqual(["behind-heartbeat", "pending-gap", "sender-overdue"]);
  });
});
