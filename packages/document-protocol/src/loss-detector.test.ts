import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LOSS_GRACE_MS,
  LossDetector,
  MAX_ANSWER_PIECES,
  OPEN_TRANSFERS_PER_MEMBER,
  type StateReport,
} from "./loss-detector";
import { resolveSyncPolicy, type SyncPolicy } from "./sync-policy";

// The detector is exercised against a fake clock and fake views of the document, so each
// kind of evidence and each wait is tested on its own; the real Yjs situations they stand for
// are in reconciliation's tests, and the whole path through a DocumentEngine is in index.test.ts.

const T0 = 1_000_000;
const STATE = new Uint8Array([1, 2, 3]);
/** This client's request, and another member's: what an answer's `respondsTo` names. */
const MINE = "0f0f0f0f0f0f0f0f";
const THEIRS = "e1e1e1e1e1e1e1e1";

interface World {
  detector: LossDetector;
  gaps: number[];
  behind: boolean;
  /** Heartbeats whose state vector, by its first byte, accounts for changes we lack. */
  lacking: Set<number>;
  /** What this client holds of the creator's operations: its control vector. */
  held: Record<string, number>;
  holes: boolean;
  policy: SyncPolicy;
  creator: string | undefined;
  /**
   * This client's digest of what it deleted within a reported vector, and whether it holds every
   * insertion that vector counts (LOS-12).
   */
  stateDigest: string;
  sameState: boolean;
  controlDigest: string;
  sameControl: boolean;
  creatorDevice: boolean;
}

function world(policy: Partial<SyncPolicy> = {}): World {
  const w: World = {
    detector: undefined as unknown as LossDetector,
    gaps: [],
    behind: false,
    lacking: new Set(),
    held: {},
    holes: false,
    policy: resolveSyncPolicy({ expectedLatencyMs: 10_000, maxIntervalMs: 60_000, ...policy }),
    creator: "alice",
    stateDigest: "aaaaaaaaaaaaaaaa",
    sameState: true,
    controlDigest: "cccccccccccccccc",
    sameControl: true,
    creatorDevice: false,
  };
  w.detector = new LossDetector({
    creatorMemberId: () => w.creator,
    policy: () => w.policy,
    pendingGapClients: () => w.gaps,
    lacksUpdatesOf: (stateVector) => w.behind || w.lacking.has(stateVector[0] as number),
    controlHoles: () => w.holes,
    lacksControlOf: (vector) =>
      Object.entries(vector).some(([device, counter]) => counter > (w.held[device] ?? 0)),
    stateDigestWithin: () => (w.sameState ? w.stateDigest : undefined),
    sameControlVector: () => w.sameControl,
    controlDigest: () => w.controlDigest,
    isCreatorDevice: () => w.creatorDevice,
  });
  return w;
}

/** A report of `stream` at `sequence` (LOS-13); its state vector is the one byte `first`. */
function report(
  stream: string,
  sequence: number,
  stateDigest = "aaaaaaaaaaaaaaaa",
  first = 1,
  control: Record<string, number> | null = null,
  controlDigest: string | null = null,
): StateReport {
  return {
    stream,
    sequence,
    stateVector: new Uint8Array([first]),
    stateDigest,
    control,
    controlDigest,
  };
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

describe("a different digest where this client holds the reported vector (LOS-12)", () => {
  it("is evidence after the waiting time, only where this client holds the vector, and ends once the digests agree", () => {
    const w = world(); // 10 s of latency
    w.detector.heardReport("bob", report("b0b0b0b0b0b0b0b0", 1, "bbbbbbbbbbbbbbbb"));
    vi.advanceTimersByTime(9_999);
    expect(w.detector.suspicions()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(w.detector.suspicions()).toEqual([{ kind: "diverged", sender: "bob", since: T0 }]);
    w.sameState = false; // a vector this client lacks shows it itself (LOS-4)
    expect(w.detector.suspicions()).toEqual([]);
    w.sameState = true;
    w.stateDigest = "bbbbbbbbbbbbbbbb"; // this client healed
    expect(w.detector.suspicions()).toEqual([]);
  });

  it("is judged as the report was heard: what this client deletes since — the sender's own later edits among it — starts none (LOS-12)", () => {
    const w = world();
    w.detector.heardReport("bob", report("b0b0b0b0b0b0b0b0", 1)); // the same digest as ours
    w.stateDigest = "dddddddddddddddd"; // Bob's next edit deleted, and reached us before his next report
    vi.advanceTimersByTime(60_000);
    expect(w.detector.suspicions()).toEqual([]);
  });

  it("of a report heard while this client lacked an insertion it counts, is judged once it holds them all (LOS-12)", () => {
    const w = world();
    w.sameState = false;
    w.detector.heardReport("carol", report("cacacacacacacaca", 1, "bbbbbbbbbbbbbbbb"));
    w.detector.observe();
    vi.advanceTimersByTime(10_000);
    expect(w.detector.suspicions()).toEqual([]); // not to be compared yet; the vector shows it (LOS-4)
    w.sameState = true; // the insertion arrived, and the deletion Carol stated did not
    w.detector.observe();
    expect(w.detector.suspicions()).toEqual([{ kind: "diverged", sender: "carol", since: T0 }]);
    w.stateDigest = "dddddddddddddddd"; // what this client deletes since changes nothing of that
    expect(w.detector.suspicions()).toEqual([{ kind: "diverged", sender: "carol", since: T0 }]);

    // Judged equal once, it stays no evidence, whatever this client deletes later.
    w.sameState = false;
    w.detector.heardReport("dave", report("dadadadadadadada", 1, "eeeeeeeeeeeeeeee"));
    w.detector.observe();
    w.sameState = true;
    w.stateDigest = "eeeeeeeeeeeeeeee";
    w.detector.observe();
    w.stateDigest = "ffffffffffffffff";
    vi.advanceTimersByTime(60_000);
    expect(w.detector.suspicions().filter((s) => s.sender === "dave")).toEqual([]);
  });

  it("is replaced by a newer report of the same stream, which said it healed (LOS-17, LOS-18)", () => {
    const w = world();
    w.detector.heardReport("bob", report("b0b0b0b0b0b0b0b0", 1, "bbbbbbbbbbbbbbbb"));
    vi.advanceTimersByTime(5_000);
    w.detector.heardReport("bob", report("b0b0b0b0b0b0b0b0", 2)); // Bob healed, and said so
    vi.advanceTimersByTime(20_000);
    expect(w.detector.suspicions()).toEqual([]);
  });

  it("is not replaced by an older report of the same stream, offered again or late (LOS-17)", () => {
    const w = world();
    w.detector.heardReport("bob", report("b0b0b0b0b0b0b0b0", 5, "bbbbbbbbbbbbbbbb"));
    w.detector.heardReport("bob", report("b0b0b0b0b0b0b0b0", 4)); // older, saying what we hold
    w.detector.heardReport("bob", report("b0b0b0b0b0b0b0b0", 5)); // the same number again
    vi.advanceTimersByTime(10_000);
    expect(w.detector.suspicions()).toEqual([{ kind: "diverged", sender: "bob", since: T0 }]);
  });

  it("is not replaced by another stream's report, however new: another device of the member (LOS-17)", () => {
    const w = world();
    w.detector.heardReport("bob", report("1a1a1a1a1a1a1a1a", 1, "bbbbbbbbbbbbbbbb")); // the laptop deleted
    vi.advanceTimersByTime(3_000);
    w.detector.heardReport("bob", report("2b2b2b2b2b2b2b2b", 9)); // the phone, lagging, holds what we hold
    vi.advanceTimersByTime(7_000);
    expect(w.detector.suspicions()).toEqual([{ kind: "diverged", sender: "bob", since: T0 }]);
    vi.advanceTimersByTime(60_000);
    expect(w.detector.suspicions()).toEqual([{ kind: "diverged", sender: "bob", since: T0 }]);
  });

  it("keeps when it began across a newer report of the stream that shows the same, without a second wait (LOS-1)", () => {
    const w = world();
    w.detector.heardReport("bob", report("b0b0b0b0b0b0b0b0", 1, "bbbbbbbbbbbbbbbb"));
    vi.advanceTimersByTime(12_000);
    expect(w.detector.suspicions()).toEqual([{ kind: "diverged", sender: "bob", since: T0 }]);
    w.detector.heardReport("bob", report("b0b0b0b0b0b0b0b0", 2, "bbbbbbbbbbbbbbbb"));
    expect(w.detector.suspicions()).toEqual([{ kind: "diverged", sender: "bob", since: T0 }]);
  });

  it("keeps four streams of a member; a fifth replaces the one heard from least recently (LOS-17)", () => {
    const w = world();
    w.detector.heardReport("bob", report("0000000000000001", 1, "bbbbbbbbbbbbbbbb"));
    for (const stream of ["0000000000000002", "0000000000000003", "0000000000000004"]) {
      w.detector.heardReport("bob", report(stream, 1));
    }
    vi.advanceTimersByTime(10_000);
    expect(w.detector.suspicions()).toHaveLength(1);
    w.detector.heardReport("bob", report("0000000000000005", 1));
    expect(w.detector.suspicions()).toEqual([]);
  });

  it("counts for control state from the creator, and from a member only on a device of the creator (CTL-31)", () => {
    const w = world();
    w.detector.heardReport(
      "alice",
      report("a1a1a1a1a1a1a1a1", 1, "aaaaaaaaaaaaaaaa", 1, { D: 1 }, "dddddddddddddddd"),
    );
    w.detector.heardReport(
      "bob",
      report("b0b0b0b0b0b0b0b0", 1, "aaaaaaaaaaaaaaaa", 1, { D: 1 }, "dddddddddddddddd"),
    );
    vi.advanceTimersByTime(10_000);
    expect(w.detector.suspicions()).toEqual([
      { kind: "control-diverged", sender: "alice", since: T0 },
    ]);
    w.creatorDevice = true;
    expect(w.detector.suspicions()).toEqual([
      { kind: "control-diverged", sender: "alice", since: T0 },
      { kind: "control-diverged", sender: "bob", since: T0 },
    ]);
    w.sameControl = false;
    expect(w.detector.suspicions()).toEqual([]);
  });
});

describe("an overdue sender", () => {
  it("is reported when an edit is followed by nothing for maxInterval plus one expected latency", () => {
    const w = world(); // 60 s + 10 s
    w.detector.heardEdit("bob", 60_000);
    vi.advanceTimersByTime(69_999);
    expect(w.detector.suspicions()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(w.detector.suspicions()).toEqual([
      { kind: "sender-overdue", sender: "bob", since: T0, due: 60_000 },
    ]);
  });

  it("is judged by the due the sender announced, not by this client's own pacing (LOS-11)", () => {
    const w = world({ maxIntervalMs: 600_000 }); // this client would wait ten minutes itself
    w.detector.heardEdit("bob", 20_000);
    vi.advanceTimersByTime(29_999);
    expect(w.detector.suspicions()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(w.detector.suspicions()).toEqual([
      { kind: "sender-overdue", sender: "bob", since: T0, due: 20_000 },
    ]);
  });

  it("waits for the pace when it is longer than what the sender promised (LOS-11, SND-15)", () => {
    const w = world(); // 10 s of latency
    let pace: number | undefined = 30_000;
    const detector = new LossDetector({
      creatorMemberId: () => w.creator,
      policy: () => w.policy,
      pendingGapClients: () => [],
      lacksUpdatesOf: () => false,
      controlHoles: () => false,
      lacksControlOf: () => false,
      stateDigestWithin: () => w.stateDigest,
      sameControlVector: () => true,
      controlDigest: () => w.controlDigest,
      isCreatorDevice: () => false,
      pace: () => pace,
    });
    // Announced before its sender learned the pace, which now keeps it from sending sooner.
    detector.heardEdit("bob", 20_000);
    vi.advanceTimersByTime(39_999);
    expect(detector.suspicions()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(detector.suspicions()).toEqual([
      { kind: "sender-overdue", sender: "bob", since: T0, due: 30_000 },
    ]);
    pace = undefined; // without a pace, the promise alone
    expect(detector.suspicions()).toEqual([
      { kind: "sender-overdue", sender: "bob", since: T0, due: 20_000 },
    ]);
  });

  it("is cleared by any later message from the sender", () => {
    const w = world();
    w.detector.heardEdit("bob", 60_000);
    vi.advanceTimersByTime(60_000);
    w.detector.heardEdit("bob", 60_000); // more edits
    vi.advanceTimersByTime(60_000);
    expect(w.detector.suspicions()).toEqual([]);
  });

  it("is ended only by a heartbeat that holds the frame, or a further frame of its source (LOS-16)", () => {
    const w = world(); // 60 s + 10 s
    // Two devices of bob, each its own source; a heartbeat holds what its first byte names.
    w.detector.heardEdit("bob", 60_000, "edit:1", (stateVector) => stateVector[0] === 1);
    vi.advanceTimersByTime(1_000);
    w.detector.heardEdit("bob", 60_000, "edit:2", (stateVector) => stateVector[0] === 2);
    // The second device's heartbeat, which crossed the first device's edit.
    w.detector.heardHeartbeat("bob", new Uint8Array([2]), null);
    vi.advanceTimersByTime(69_000);
    expect(w.detector.suspicions()).toEqual([
      { kind: "sender-overdue", sender: "bob", since: T0, due: 60_000 },
    ]);
    // The first device's next edit ends what its earlier one left open, and leaves its own.
    w.detector.heardEdit("bob", 60_000, "edit:1", (stateVector) => stateVector[0] === 1);
    expect(w.detector.suspicions()).toEqual([]);
    w.detector.heardHeartbeat("bob", new Uint8Array([1]), null);
    vi.advanceTimersByTime(24 * 3_600_000);
    expect(w.detector.suspicions().filter((s) => s.kind === "sender-overdue")).toEqual([]);
  });

  it("is ended by no heartbeat whose bytes are not a state vector", () => {
    const w = world();
    w.detector.heardEdit("bob", 60_000, "edit:1", () => {
      throw new Error("not a state vector");
    });
    w.detector.heardHeartbeat("bob", STATE, null);
    vi.advanceTimersByTime(70_000);
    expect(w.detector.suspicions()).toEqual([
      { kind: "sender-overdue", sender: "bob", since: T0, due: 60_000 },
    ]);
  });

  it("is not reported after a heartbeat: it says nothing further is due, however long the silence", () => {
    const w = world();
    w.detector.heardEdit("bob", 60_000);
    w.detector.heardHeartbeat("bob", STATE, null);
    vi.advanceTimersByTime(24 * 3_600_000);
    expect(w.detector.suspicions().filter((s) => s.kind === "sender-overdue")).toEqual([]);
  });

  it("is a soft signal that needs a promise: a sender that announced due 0 may be silent (SND-14)", () => {
    const w = world({ maxIntervalMs: Number.POSITIVE_INFINITY });
    w.detector.heardEdit("bob", 0);
    vi.advanceTimersByTime(24 * 3_600_000);
    expect(w.detector.suspicions()).toEqual([]);
  });

  it("is spent by a resync answer, so a sender who simply went offline is not reported forever", () => {
    const w = world();
    w.detector.heardEdit("bob", 60_000);
    vi.advanceTimersByTime(80_000);
    expect(w.detector.suspicions()).toHaveLength(1);
    w.detector.answered();
    expect(w.detector.suspicions()).toEqual([]);
  });

  it("counts the client's own member like anyone: what reaches it from there comes from another device (LOS-11)", () => {
    const w = world();
    w.detector.heardEdit("me", 60_000); // another device of "me"; the engine leaves out its own echoes
    vi.advanceTimersByTime(60_000 + 10_000);
    expect(w.detector.suspicions()).toEqual([
      { kind: "sender-overdue", sender: "me", since: T0, due: 60_000 },
    ]);
  });
});

describe("a report that shows we are behind (LOS-4)", () => {
  it("is reported once it has lasted one expected latency, since the missing changes may be in flight", () => {
    const w = world();
    w.behind = true;
    w.detector.heardReport("bob", report("b0b0b0b0b0b0b0b0", 1));
    vi.advanceTimersByTime(9_999);
    expect(w.detector.suspicions().filter((s) => s.kind === "behind-heartbeat")).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(w.detector.suspicions()).toEqual([
      { kind: "behind-heartbeat", sender: "bob", since: T0 },
    ]);
  });

  it("is not reported when the report's state is one we already have", () => {
    const w = world();
    w.behind = false;
    w.detector.heardReport("bob", report("b0b0b0b0b0b0b0b0", 1));
    vi.advanceTimersByTime(60_000);
    expect(w.detector.suspicions()).toEqual([]);
  });

  it("goes away by itself once the changes arrive, because it is judged against the document as it is now", () => {
    const w = world();
    w.behind = true;
    w.detector.heardReport("bob", report("b0b0b0b0b0b0b0b0", 1));
    vi.advanceTimersByTime(20_000);
    expect(w.detector.suspicions()).toHaveLength(1);
    w.behind = false; // the late edit arrived
    expect(w.detector.suspicions()).toEqual([]);
  });

  it("judges the latest report of each of a member's streams, so one device's does not hide another's (LOS-4, LOS-17)", () => {
    const w = world();
    w.lacking.add(7); // the laptop's report accounts for a change we lack
    w.detector.heardReport("bob", report("1a1a1a1a1a1a1a1a", 1, undefined, 7));
    vi.advanceTimersByTime(1_000);
    for (let sequence = 1; sequence <= 6; sequence += 1) {
      w.detector.heardReport("bob", report("2b2b2b2b2b2b2b2b", sequence, undefined, 8)); // the phone's, which never saw it
    }
    vi.advanceTimersByTime(10_000);
    expect(w.detector.suspicions()).toEqual([
      { kind: "behind-heartbeat", sender: "bob", since: T0 },
    ]);
  });

  it("keeps a device's report however many answers another device of the member sends meanwhile (LOS-4, LOS-17)", () => {
    const w = world();
    w.lacking.add(1);
    w.detector.heardReport("alice", report("1a1a1a1a1a1a1a1a", 1)); // the laptop holds what we lack
    for (let sequence = 1; sequence <= 6; sequence += 1) {
      // Another device of hers answers joiners: last pieces stating a state we already hold.
      w.detector.heardAnswerPiece("alice", {
        stream: "2b2b2b2b2b2b2b2b",
        sequence,
        piece: 1,
        pieces: 1,
        report: report("2b2b2b2b2b2b2b2b", sequence, undefined, 2),
        own: false,
        request: THEIRS,
      });
    }
    vi.advanceTimersByTime(10_000);
    expect(w.detector.suspicions()).toEqual([
      expect.objectContaining({ kind: "behind-heartbeat", sender: "alice", since: T0 }),
    ]);
  });

  it("judges an answer's last piece that holds what we lack, like a heartbeat (LOS-4)", () => {
    const w = world();
    w.lacking.add(3);
    w.detector.heardAnswerPiece("alice", {
      stream: "a1a1a1a1a1a1a1a1",
      sequence: 1,
      piece: 1,
      pieces: 1,
      report: report("a1a1a1a1a1a1a1a1", 1, undefined, 3),
      own: false,
      request: THEIRS,
    });
    vi.advanceTimersByTime(10_000);
    expect(w.detector.suspicions()).toEqual([
      expect.objectContaining({ kind: "behind-heartbeat", sender: "alice" }),
    ]);
  });

  it("counts a report of the client's own member: another device may hold what this one lacks (LOS-4)", () => {
    const w = world();
    w.behind = true;
    w.detector.heardReport("me", report("2b2b2b2b2b2b2b2b", 1));
    vi.advanceTimersByTime(10_000);
    expect(w.detector.suspicions()).toEqual([
      { kind: "behind-heartbeat", sender: "me", since: T0 },
    ]);
  });

  it("ignores a report whose state vector is not one, rather than reporting a loss on garbage", () => {
    const w = new LossDetector({
      creatorMemberId: () => undefined,
      policy: () => resolveSyncPolicy({ expectedLatencyMs: 1000 }),
      pendingGapClients: () => [],
      lacksUpdatesOf: () => {
        throw new Error("not a state vector");
      },
      controlHoles: () => false,
      lacksControlOf: () => false,
      stateDigestWithin: () => {
        throw new Error("not a state vector");
      },
      sameControlVector: () => false,
      controlDigest: () => "cccccccccccccccc",
      isCreatorDevice: () => false,
    });
    w.heardReport("bob", report("b0b0b0b0b0b0b0b0", 1, "bbbbbbbbbbbbbbbb"));
    vi.advanceTimersByTime(60_000);
    expect(w.suspicions()).toEqual([]);
  });
});

describe("the pieces of an answer to this client's own request (LOS-14)", () => {
  const STREAM = "a1a1a1a1a1a1a1a1";
  const piece = (
    number: number,
    pieces: number | null,
    sequence = 1,
    digest = "aaaaaaaaaaaaaaaa",
  ) => ({
    stream: STREAM,
    sequence,
    piece: number,
    pieces,
    report: pieces === null ? null : report(STREAM, sequence, digest),
    own: true,
    request: MINE,
  });

  it("are complete once every number up to the count has arrived, in any order, the last first", () => {
    const w = world(); // floor 0, 10 s of latency
    w.behind = true; // until the other pieces are here, the last piece's state is more than this client holds
    w.detector.heardAnswerPiece("alice", piece(3, 3));
    expect(w.detector.incompleteAnswers()).toEqual([
      { sender: "alice", received: 1, pieces: 3, since: T0 },
    ]);
    vi.advanceTimersByTime(4_000);
    w.detector.heardAnswerPiece("alice", piece(1, null));
    vi.advanceTimersByTime(4_000);
    w.detector.heardAnswerPiece("alice", piece(2, null));
    w.behind = false;
    expect(w.detector.incompleteAnswers()).toEqual([]);
    vi.advanceTimersByTime(60_000);
    expect(w.detector.suspicions()).toEqual([]);
  });

  it("lacking one is evidence once no piece has come for a floor and the waiting time, and names the responder", () => {
    const w = world({ minIntervalMs: 2_000 }); // 2 s floor, 10 s of latency
    w.stateDigest = "bbbbbbbbbbbbbbbb"; // what this client deleted differs from what the last piece states
    w.detector.heardAnswerPiece("alice", piece(1, null));
    w.detector.heardAnswerPiece("alice", piece(3, 3)); // the delete piece, number 2, never comes
    vi.advanceTimersByTime(11_999);
    expect(w.detector.suspicions().filter((s) => s.kind === "answer-incomplete")).toEqual([]);
    expect(w.detector.incompleteAnswers()).toEqual([
      { sender: "alice", received: 2, pieces: 3, since: T0 },
    ]);
    vi.advanceTimersByTime(1);
    expect(w.detector.suspicions()).toContainEqual({
      kind: "answer-incomplete",
      sender: "alice",
      since: T0 + 2_000,
    });
  });

  it("lacking the last is evidence too: pieces came, and the count never did", () => {
    const w = world();
    w.detector.heardAnswerPiece("alice", piece(1, null));
    w.detector.heardAnswerPiece("alice", piece(2, null));
    vi.advanceTimersByTime(10_000);
    expect(w.detector.suspicions()).toEqual([
      { kind: "answer-incomplete", sender: "alice", since: T0 },
    ]);
  });

  it("ends with a later answer of the same stream that is complete, not with an earlier one's copies", () => {
    const w = world();
    w.stateDigest = "bbbbbbbbbbbbbbbb"; // what this client deleted differs from what the last piece states
    w.detector.heardAnswerPiece("alice", piece(2, 2, 4));
    vi.advanceTimersByTime(10_000);
    expect(w.detector.suspicions().map((s) => s.kind)).toContain("answer-incomplete");
    w.detector.heardAnswerPiece("alice", piece(1, null, 3)); // a piece of an older answer, late
    expect(w.detector.suspicions().map((s) => s.kind)).toContain("answer-incomplete");
    w.detector.heardAnswerPiece("alice", piece(1, 1, 5, "cccccccccccccccc")); // asked again: a whole answer
    expect(w.detector.incompleteAnswers()).toEqual([]);
    expect(w.detector.suspicions()).toEqual([]); // held whole, though the digests differ
  });

  it("is no evidence when this client holds what the last piece states anyway", () => {
    const w = world();
    w.detector.heardAnswerPiece("alice", piece(2, 2)); // piece 1 lost, but its content came by edits
    vi.advanceTimersByTime(60_000);
    expect(w.detector.suspicions()).toEqual([]);
  });

  it("are not counted for an answer to another client's request", () => {
    const w = world();
    w.detector.heardAnswerPiece("alice", { ...piece(1, null), own: false, request: THEIRS });
    vi.advanceTimersByTime(60_000);
    expect(w.detector.incompleteAnswers()).toEqual([]);
    expect(w.detector.suspicions()).toEqual([]);
  });
});

describe("transfers, kept apart from reports by sender, stream and number (LOS-14, LOS-21, LOS-22)", () => {
  const STREAM = "a1a1a1a1a1a1a1a1";
  const OTHER_REQUEST = "0e0e0e0e0e0e0e0e";
  /** A piece of the answer numbered `sequence` in `stream`; the last one states the responder's state, the first byte of its vector `first`. */
  const piece = (
    sequence: number,
    number: number,
    pieces: number | null,
    options: {
      own?: boolean;
      request?: string;
      stream?: string;
      first?: number;
      digest?: string;
    } = {},
  ) => {
    const stream = options.stream ?? STREAM;
    return {
      stream,
      sequence,
      piece: number,
      pieces,
      report: pieces === null ? null : report(stream, sequence, options.digest, options.first ?? 1),
      own: options.own ?? true,
      request: options.request ?? ((options.own ?? true) ? MINE : THEIRS),
    };
  };
  const incompleteSince = (w: World) =>
    w.detector
      .suspicions()
      .filter((s) => s.kind === "answer-incomplete")
      .map((s) => s.since);

  it("a later answer of the stream to someone else, of which a piece that is not the last came, ends nothing", () => {
    const w = world(); // floor 0, 10 s of latency
    w.detector.heardReport("alice", report(STREAM, 1)); // her earlier report, which this client holds
    w.detector.heardAnswerPiece("alice", piece(2, 1, null)); // our answer: piece 1, the last never comes
    vi.advanceTimersByTime(10_000);
    expect(w.detector.incompleteAnswers()).toEqual([
      { sender: "alice", received: 1, pieces: null, since: T0 },
    ]);
    expect(w.detector.suspicions()).toEqual([
      { kind: "answer-incomplete", sender: "alice", since: T0 },
    ]);
    w.detector.heardAnswerPiece("alice", piece(3, 1, null, { own: false })); // her answer to Carol, piece 1
    vi.advanceTimersByTime(10_000);
    expect(w.detector.incompleteAnswers()).toEqual([
      { sender: "alice", received: 1, pieces: null, since: T0 },
    ]);
    expect(w.detector.suspicions()).toEqual([
      { kind: "answer-incomplete", sender: "alice", since: T0 },
    ]);
    // Nor does its last piece, while this client lacks what it states.
    w.lacking.add(9);
    w.detector.heardAnswerPiece("alice", piece(3, 2, 2, { own: false, first: 9 }));
    expect(w.detector.incompleteAnswers()).toEqual([
      { sender: "alice", received: 1, pieces: null, since: T0 },
    ]);
    // Healing ends it: the missing piece comes after all.
    w.detector.heardAnswerPiece("alice", piece(2, 2, 2));
    expect(w.detector.incompleteAnswers()).toEqual([]);
    vi.advanceTimersByTime(10_000);
    expect(w.detector.suspicions().map((s) => s.kind)).toEqual(["behind-heartbeat"]); // what Carol's answer stated
  });

  it("two overlapping answers to this client's own requests are counted apart, in either order", () => {
    const w = world();
    w.lacking.add(1); // until an answer is whole, what its last piece states is more than this client holds
    w.detector.heardAnswerPiece("alice", piece(3, 2, null, { request: OTHER_REQUEST })); // the later one first
    w.detector.heardAnswerPiece("alice", piece(2, 2, 2)); // the earlier one's last piece
    w.detector.heardAnswerPiece("alice", piece(3, 1, null, { request: OTHER_REQUEST }));
    expect(w.detector.incompleteAnswers()).toEqual([
      { sender: "alice", received: 2, pieces: null, since: T0 },
      { sender: "alice", received: 1, pieces: 2, since: T0 },
    ]);
    // The earlier one whole: the later one is still missing its last piece.
    w.detector.heardAnswerPiece("alice", piece(2, 1, null));
    expect(w.detector.incompleteAnswers()).toEqual([
      { sender: "alice", received: 2, pieces: null, since: T0 },
    ]);
    vi.advanceTimersByTime(10_000);
    expect(incompleteSince(w)).toEqual([T0]);
    // The later one whole too.
    w.detector.heardAnswerPiece("alice", piece(3, 3, 3, { request: OTHER_REQUEST }));
    w.lacking.clear();
    expect(w.detector.incompleteAnswers()).toEqual([]);
    expect(w.detector.suspicions()).toEqual([]);
  });

  it("a later answer of the stream, whole, ends an earlier one: the stream's state only grows", () => {
    const w = world();
    w.lacking.add(1);
    w.detector.heardAnswerPiece("alice", piece(2, 1, null));
    w.detector.heardAnswerPiece("alice", piece(3, 1, null, { request: OTHER_REQUEST }));
    w.detector.heardAnswerPiece("alice", piece(4, 1, 1, { request: OTHER_REQUEST, first: 2 }));
    expect(w.detector.incompleteAnswers()).toEqual([]);
    // A piece of the earlier answers, late, brings nothing this client lacks, and is not counted.
    w.detector.heardAnswerPiece("alice", piece(2, 2, null));
    expect(w.detector.incompleteAnswers()).toEqual([]);
    vi.advanceTimersByTime(60_000);
    expect(w.detector.suspicions().filter((s) => s.kind === "answer-incomplete")).toEqual([]);
  });

  it("with both last pieces lost, both stay until a later report of the stream shows this client holds its state", () => {
    const w = world();
    w.lacking.add(5);
    w.detector.heardAnswerPiece("alice", piece(2, 1, null));
    w.detector.heardAnswerPiece("alice", piece(3, 1, null, { request: OTHER_REQUEST }));
    w.detector.heardReport("alice", report(STREAM, 4, undefined, 5)); // her heartbeat: this client lacks what it states
    vi.advanceTimersByTime(10_000);
    expect(w.detector.incompleteAnswers()).toHaveLength(2);
    expect(
      w.detector
        .suspicions()
        .map((s) => s.kind)
        .sort(),
    ).toEqual(["answer-incomplete", "behind-heartbeat"]);
    // Her next heartbeat states what this client holds, digest and all.
    w.detector.heardReport("alice", report(STREAM, 5));
    w.lacking.clear();
    expect(w.detector.incompleteAnswers()).toEqual([]);
    expect(w.detector.suspicions()).toEqual([]);
  });

  it("a later report of the stream ends a transfer only once this client can compare its digest, and it is the same", () => {
    const w = world();
    w.detector.heardAnswerPiece("alice", piece(2, 1, null));
    w.sameState = false; // a profile that cannot restrict deletions to a vector it does not equal
    w.detector.heardReport("alice", report(STREAM, 3));
    expect(w.detector.incompleteAnswers()).toHaveLength(1);
    w.sameState = true;
    w.stateDigest = "bbbbbbbbbbbbbbbb";
    w.detector.heardReport("alice", report(STREAM, 4)); // a deletion one of the two lacks
    expect(w.detector.incompleteAnswers()).toHaveLength(1);
    w.detector.heardReport("alice", report(STREAM, 5, "bbbbbbbbbbbbbbbb"));
    expect(w.detector.incompleteAnswers()).toEqual([]);
  });

  it("a report of another stream of the member, or another member's, ends none", () => {
    const w = world();
    w.detector.heardAnswerPiece("alice", piece(2, 1, null));
    w.detector.heardReport("alice", report("2b2b2b2b2b2b2b2b", 9)); // her phone, which holds what this client holds
    w.detector.heardReport("bob", report(STREAM, 9));
    w.detector.heardAnswerPiece("alice", piece(1, 1, 1, { stream: "2b2b2b2b2b2b2b2b" })); // a whole answer of the phone
    expect(w.detector.incompleteAnswers()).toEqual([
      { sender: "alice", received: 1, pieces: null, since: T0 },
    ]);
  });

  it("a responder that starts again, with a new stream, ends nothing of the old one's transfer; the old one's late piece does", () => {
    const w = world();
    w.detector.heardAnswerPiece("alice", piece(2, 1, null)); // the old engine's answer, cut short
    const NEW = "c3c3c3c3c3c3c3c3";
    w.detector.heardReport("alice", report(NEW, 1)); // the new engine's request: what it holds, which this client holds
    w.detector.heardAnswerPiece("alice", piece(2, 1, 1, { stream: NEW, request: OTHER_REQUEST })); // its whole answer
    vi.advanceTimersByTime(10_000);
    // Another engine's state says nothing of what the old one sent (LOS-13, LOS-21): its transfer stays evidence.
    expect(w.detector.incompleteAnswers()).toEqual([
      { sender: "alice", received: 1, pieces: null, since: T0 },
    ]);
    expect(w.detector.suspicions()).toEqual([
      { kind: "answer-incomplete", sender: "alice", since: T0 },
    ]);
    // What the old engine sent before it stopped may still come.
    w.detector.heardAnswerPiece("alice", piece(2, 2, 2));
    expect(w.detector.incompleteAnswers()).toEqual([]);
    expect(w.detector.suspicions()).toEqual([]);
  });

  it("an identical copy of a piece counts once", () => {
    const w = world();
    w.lacking.add(1);
    w.detector.heardAnswerPiece("alice", piece(2, 1, null));
    w.detector.heardAnswerPiece("alice", piece(2, 1, null));
    w.detector.heardAnswerPiece("alice", piece(2, 2, 3));
    w.detector.heardAnswerPiece("alice", piece(2, 2, 3));
    expect(w.detector.incompleteAnswers()).toEqual([
      { sender: "alice", received: 2, pieces: 3, since: T0 },
    ]);
    w.detector.heardAnswerPiece("alice", piece(2, 3, 3));
    expect(w.detector.incompleteAnswers()).toEqual([]);
  });

  it.each([
    ["two counts", [piece(2, 2, 2), piece(2, 3, 3)]],
    ["two states in last pieces of one count", [piece(2, 2, 2), piece(2, 2, 2, { first: 7 })]],
    ["a piece numbered above the count", [piece(2, 3, null), piece(2, 2, 2)]],
    ["two requests", [piece(2, 1, null), piece(2, 2, 2, { request: OTHER_REQUEST })]],
    [
      "a piece of its number answering someone else",
      [piece(2, 2, 2), piece(2, 1, null, { own: false })],
    ],
    [
      "a piece numbered above what is counted",
      [piece(2, MAX_ANSWER_PIECES + 1, null), piece(2, 2, 2)],
    ],
  ])(
    "whose pieces disagree (%s) is never whole, and ends only with a later report this client holds",
    (_, pieces) => {
      const w = world();
      w.lacking.add(1);
      for (const each of pieces) {
        w.detector.heardAnswerPiece("alice", each);
      }
      w.detector.heardAnswerPiece("alice", piece(2, 1, null));
      w.lacking.clear(); // this client holds what the last piece states: no proof for an answer that disagrees
      vi.advanceTimersByTime(10_000);
      expect(w.detector.incompleteAnswers()).toEqual([
        expect.objectContaining({ sender: "alice", pieces: null }),
      ]);
      expect(incompleteSince(w)).toEqual([T0]);
      w.detector.heardReport("alice", report(STREAM, 3));
      expect(w.detector.incompleteAnswers()).toEqual([]);
      expect(w.detector.suspicions()).toEqual([]);
    },
  );

  it("past the bound, the transfer heard from least recently is given up and stays evidence, by its stream and number", () => {
    const w = world();
    w.lacking.add(1);
    for (let sequence = 1; sequence <= OPEN_TRANSFERS_PER_MEMBER + 1; sequence += 1) {
      w.detector.heardAnswerPiece(
        "alice",
        piece(sequence, 1, null, { request: `${sequence}`.padStart(16, "0") }),
      );
      vi.advanceTimersByTime(1_000);
    }
    // The first is no longer counted, and is no transfer under way; it is unresolved still.
    expect(w.detector.incompleteAnswers()).toHaveLength(OPEN_TRANSFERS_PER_MEMBER);
    expect(w.detector.incompleteAnswers().map((answer) => answer.since)).not.toContain(T0);
    vi.advanceTimersByTime(10_000);
    expect(incompleteSince(w)).toEqual([T0]);
    // A report of the stream this client holds, above its number, ends it; one at a lower number would not.
    w.lacking.clear();
    w.detector.heardReport("alice", report(STREAM, OPEN_TRANSFERS_PER_MEMBER + 2));
    expect(w.detector.incompleteAnswers()).toEqual([]);
    expect(w.detector.suspicions()).toEqual([]);
  });

  it("past the bound of streams with transfers given up, the member's evidence stays as long as the engine runs", () => {
    const w = world();
    w.lacking.add(1);
    const streams = Array.from({ length: 2 * OPEN_TRANSFERS_PER_MEMBER + 1 }, (_, i) =>
      `${i}`.padStart(16, "d"),
    );
    for (const stream of streams) {
      w.detector.heardAnswerPiece("alice", piece(1, 1, null, { stream }));
      vi.advanceTimersByTime(1_000);
    }
    w.lacking.clear();
    // Every stream still kept reports what this client holds; the oldest's is gone.
    for (const stream of streams) {
      w.detector.heardReport("alice", report(stream, 2));
    }
    expect(w.detector.incompleteAnswers()).toEqual([]);
    vi.advanceTimersByTime(60_000);
    expect(w.detector.suspicions()).toEqual([
      { kind: "answer-incomplete", sender: "alice", since: T0 },
    ]);
  });

  it("keeps a stream with a transfer besides the four kept for their reports", () => {
    const w = world();
    w.detector.heardAnswerPiece("alice", piece(2, 1, null));
    for (const stream of [
      "1b1b1b1b1b1b1b1b",
      "2b2b2b2b2b2b2b2b",
      "3b3b3b3b3b3b3b3b",
      "4b4b4b4b4b4b4b4b",
      "5b5b5b5b5b5b5b5b",
    ]) {
      w.detector.heardReport("alice", report(stream, 1));
    }
    w.detector.heardReport("alice", report(STREAM, 3)); // its later report, which this client holds
    expect(w.detector.incompleteAnswers()).toEqual([]);
  });
});

describe("a report this client holds by a whole answer (LOS-18)", () => {
  const STREAM = "a1a1a1a1a1a1a1a1";

  it("shows no digest difference: what differs is what this client deleted itself", () => {
    const w = world();
    w.stateDigest = "bbbbbbbbbbbbbbbb"; // this client deleted something within the responder's vector
    w.detector.heardReport("alice", report(STREAM, 1)); // the responder's heartbeat, before it answered
    vi.advanceTimersByTime(10_000);
    expect(w.detector.suspicions()).toEqual([{ kind: "diverged", sender: "alice", since: T0 }]);
    // Asked; the responder's whole answer, newer in its stream, ends it without a second request.
    w.detector.heardAnswerPiece("alice", {
      stream: STREAM,
      sequence: 2,
      piece: 1,
      pieces: 1,
      report: report(STREAM, 2),
      own: true,
      request: MINE,
    });
    expect(w.detector.suspicions()).toEqual([]);
    // Its heartbeat after the answer, saying the same, is held too.
    w.detector.heardReport("alice", report(STREAM, 3));
    vi.advanceTimersByTime(60_000);
    expect(w.detector.suspicions()).toEqual([]);
    // One saying something else is judged again.
    w.detector.heardReport("alice", report(STREAM, 4, "cccccccccccccccc"));
    vi.advanceTimersByTime(10_000);
    expect(w.detector.suspicions()).toEqual([
      { kind: "diverged", sender: "alice", since: T0 + 70_000 },
    ]);
  });

  it("is not held by an answer to someone else, or by one with a piece missing", () => {
    const w = world();
    w.stateDigest = "bbbbbbbbbbbbbbbb";
    w.detector.heardAnswerPiece("alice", {
      stream: STREAM,
      sequence: 1,
      piece: 1,
      pieces: 1,
      report: report(STREAM, 1),
      own: false,
      request: THEIRS,
    });
    vi.advanceTimersByTime(10_000);
    expect(w.detector.suspicions()).toEqual([{ kind: "diverged", sender: "alice", since: T0 }]);
    w.detector.heardAnswerPiece("alice", {
      stream: STREAM,
      sequence: 2,
      piece: 2,
      pieces: 2,
      report: report(STREAM, 2),
      own: true,
      request: MINE,
    });
    vi.advanceTimersByTime(10_000);
    expect(
      w.detector
        .suspicions()
        .map((s) => s.kind)
        .sort(),
    ).toEqual(["answer-incomplete", "diverged"]);
  });
});

describe("control state that is behind (LOS-10)", () => {
  const TAG = "A".repeat(22);
  const OTHER = "B".repeat(22);

  it("is reported when the creator's heartbeat holds an operation we lack", () => {
    const w = world();
    w.held = { [TAG]: 3 };
    w.detector.heardHeartbeat("alice", STATE, { [TAG]: 5 });
    w.detector.observe();
    vi.advanceTimersByTime(10_000);
    expect(w.detector.suspicions().filter((s) => s.kind === "control-behind")).toEqual([
      { kind: "control-behind", since: T0 },
    ]);
  });

  it("believes a control vector only from the creator: anyone else's heartbeat cannot claim one", () => {
    const w = world();
    w.detector.heardHeartbeat("mallory", STATE, { [TAG]: 4_000_000_000 });
    w.detector.observe();
    vi.advanceTimersByTime(60_000);
    expect(w.detector.suspicions().filter((s) => s.kind === "control-behind")).toEqual([]);
  });

  it("is no evidence when the creator's device knows less than we do", () => {
    const w = world();
    w.held = { [TAG]: 5, [OTHER]: 2 };
    w.detector.heardHeartbeat("alice", STATE, { [TAG]: 4 });
    w.detector.observe();
    vi.advanceTimersByTime(60_000);
    expect(w.detector.suspicions()).toEqual([]);
  });

  it("keeps what each of the creator's devices said: one device's later heartbeat does not hide another's", () => {
    const w = world();
    w.held = { [TAG]: 5 };
    w.detector.heardHeartbeat("alice", STATE, { [OTHER]: 2 });
    w.detector.heardHeartbeat("alice", STATE, { [TAG]: 5 });
    w.detector.observe();
    vi.advanceTimersByTime(10_000);
    expect(w.detector.suspicions()).toEqual([{ kind: "control-behind", since: T0 }]);
  });

  it("is reported for a hole in the counters we have, with no heartbeat needed", () => {
    const w = world();
    w.holes = true;
    w.detector.observe();
    vi.advanceTimersByTime(10_000);
    expect(w.detector.suspicions()).toEqual([{ kind: "control-behind", since: T0 }]);
  });

  it("goes away when we catch up to what the creator holds", () => {
    const w = world();
    w.held = { [TAG]: 3 };
    w.detector.heardHeartbeat("alice", STATE, { [TAG]: 5 });
    w.detector.observe();
    vi.advanceTimersByTime(20_000);
    expect(w.detector.suspicions()).toHaveLength(1);
    w.held = { [TAG]: 5 };
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
    w.detector.heardReport("bob", report("b0b0b0b0b0b0b0b0", 1));
    w.detector.heardEdit("carol", 60_000);
    vi.advanceTimersByTime(70_000);
    expect(
      w.detector
        .suspicions()
        .map((s) => s.kind)
        .sort(),
    ).toEqual(["behind-heartbeat", "pending-gap", "sender-overdue"]);
  });
});
