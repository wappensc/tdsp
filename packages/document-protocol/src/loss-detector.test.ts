import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerDelayMs, answerWindowMs } from "./answer-turn";
import type { Clock } from "./clock";
import {
  DEFAULT_LOSS_GRACE_MS,
  GAP_SPACING_CAP_MS,
  LossDetector,
  MAX_ANSWER_PIECES,
  MAX_GAP_TRIES,
  OPEN_TRANSFERS_PER_MEMBER,
  type StateReport,
  WAKE_SPACING_MS,
} from "./loss-detector";
import { resolveSyncPolicy, type SyncPolicy } from "./sync-policy";

// The detector is exercised against a fake clock and fake views of the document, so each
// kind of evidence and each wait is tested on its own; the real Yjs situations they stand for
// are in reconciliation's tests, and the whole path through a DocumentEngine is in index.test.ts.

const T0 = 1_000_000;
/** The absence threshold the engine gives its detector (RSY-1, Appendix B): 10 min. */
const ABSENCE_MS = 600_000;
/** This client's request, and another member's: what an answer's `respondsTo` names. */
const MINE = "0f0f0f0f0f0f0f0f";
const THEIRS = "e1e1e1e1e1e1e1e1";
/** This client's own stream (LOS-13), from which the slot of each gap's first try derives (LOS-6). */
const STREAM = "5e5e5e5e5e5e5e5e";

interface World {
  detector: LossDetector;
  gaps: number[];
  /** Of the CRDT clients a state vector, by its first byte, counts more of: which and how far (LOS-25). */
  ahead: Map<number, Map<number, number>> | undefined;
  behind: boolean;
  /** Heartbeats whose state vector, by its first byte, accounts for changes we lack. */
  lacking: Set<number>;
  /** This client's control clock: the greatest clock among the registers it holds (LOS-10). */
  held: Clock;
  policy: SyncPolicy;
  creator: string | undefined;
  /**
   * This client's digest of what it deleted within a reported vector, and whether it holds every
   * insertion that vector counts (LOS-12).
   */
  stateDigest: string;
  sameState: boolean;
  controlDigest: string;
  /** This client's own stream (LOS-13). */
  stream: string;
}

function world(policy: Partial<SyncPolicy> = {}): World {
  const w: World = {
    detector: undefined as unknown as LossDetector,
    gaps: [],
    ahead: undefined,
    behind: false,
    lacking: new Set(),
    held: [0, 0],
    policy: resolveSyncPolicy({ expectedLatencyMs: 10_000, maxIntervalMs: 60_000, ...policy }),
    creator: "alice",
    stateDigest: "aaaaaaaaaaaaaaaa",
    sameState: true,
    controlDigest: "cccccccccccccccc",
    stream: STREAM,
  };
  w.detector = new LossDetector({
    absenceMs: ABSENCE_MS,
    creatorMemberId: () => w.creator,
    policy: () => w.policy,
    pendingGapClients: () => w.gaps,
    lacksUpdatesOf: (stateVector) => w.behind || w.lacking.has(stateVector[0] as number),
    clientsAhead: (stateVector) => w.ahead?.get(stateVector[0] as number) ?? new Map(),
    controlClock: () => w.held,
    stateDigestWithin: () => (w.sameState ? w.stateDigest : undefined),
    controlDigest: () => w.controlDigest,
    stream: () => w.stream,
  });
  return w;
}

/** A report of `stream` at `sequence` (LOS-13); its state vector is the one byte `first`. */
function report(
  stream: string,
  sequence: number,
  stateDigest = "aaaaaaaaaaaaaaaa",
  first = 1,
  controlClock: Clock | null = null,
  controlDigest: string | null = null,
): StateReport {
  return {
    stream,
    sequence,
    stateVector: new Uint8Array([first]),
    stateDigest,
    controlClock,
    controlDigest,
  };
}

/** The slot of the first try of the gap `key` on a client of `stream`, at 10 s of latency (LOS-6): as RSY-20 derives a turn. */
const slotOf = (key: string, stream = STREAM): number =>
  answerDelayMs(key, stream, answerWindowMs(10_000));

/** What the detector reports, without the gap's key and tries, which the tests of gaps hold (LOS-25). */
function seen(w: World): { kind: string; sender?: string; since: number }[] {
  return w.detector.suspicions().map(({ kind, sender, since }) => ({
    kind,
    ...(sender === undefined ? {} : { sender }),
    since,
  }));
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
    expect(seen(w)).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen(w)).toEqual([{ kind: "pending-gap", since: T0 }]);
  });

  it("counts from the first sighting, not from the most recent poll", () => {
    const w = world();
    w.gaps = [42];
    w.detector.observe();
    vi.advanceTimersByTime(6_000);
    w.detector.observe(); // seen again, but not new
    vi.advanceTimersByTime(4_000);
    expect(seen(w)).toHaveLength(1);
  });

  it("goes away when the predecessor arrives, and starts counting afresh for the next gap", () => {
    const w = world();
    w.gaps = [42];
    w.detector.observe();
    vi.advanceTimersByTime(20_000);
    expect(seen(w)).toHaveLength(1);
    w.gaps = [];
    w.detector.observe();
    expect(seen(w)).toEqual([]);
    w.gaps = [42];
    w.detector.observe();
    vi.advanceTimersByTime(5_000);
    expect(seen(w)).toEqual([]); // a new gap, only 5 s old
  });

  it("names the sender when the client id is known from an earlier single-author edit", () => {
    const w = world();
    w.detector.learnClient(42, "bob");
    w.gaps = [42];
    w.detector.observe();
    vi.advanceTimersByTime(10_000);
    expect(seen(w)).toEqual([{ kind: "pending-gap", sender: "bob", since: T0 }]);
  });

  it("does not guess a sender it has not learned", () => {
    const w = world();
    w.gaps = [42];
    w.detector.observe();
    vi.advanceTimersByTime(10_000);
    expect(seen(w)[0]).not.toHaveProperty("sender");
  });

  it("waits DEFAULT_LOSS_GRACE_MS when the policy does not say how long a message takes", () => {
    const w = world({ expectedLatencyMs: 0 });
    w.gaps = [1];
    w.detector.observe();
    vi.advanceTimersByTime(DEFAULT_LOSS_GRACE_MS - 1);
    expect(seen(w)).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen(w)).toHaveLength(1);
  });
});

describe("a different digest where this client holds the reported vector (LOS-12)", () => {
  it("is evidence after the waiting time, only where this client holds the vector, and ends once the digests agree", () => {
    const w = world(); // 10 s of latency
    w.detector.heardReport("bob", report("b0b0b0b0b0b0b0b0", 1, "bbbbbbbbbbbbbbbb"));
    vi.advanceTimersByTime(9_999);
    expect(seen(w)).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen(w)).toEqual([{ kind: "diverged", sender: "bob", since: T0 }]);
    w.sameState = false; // a vector this client lacks shows it itself (LOS-4)
    expect(seen(w)).toEqual([]);
    w.sameState = true;
    w.stateDigest = "bbbbbbbbbbbbbbbb"; // this client healed
    expect(seen(w)).toEqual([]);
  });

  it("is judged as the report was heard: what this client deletes since — the sender's own later edits among it — starts none (LOS-12)", () => {
    const w = world();
    w.detector.heardReport("bob", report("b0b0b0b0b0b0b0b0", 1)); // the same digest as ours
    w.stateDigest = "dddddddddddddddd"; // Bob's next edit deleted, and reached us before his next report
    vi.advanceTimersByTime(60_000);
    expect(seen(w)).toEqual([]);
  });

  it("of a report heard while this client lacked an insertion it counts, is judged once it holds them all (LOS-12)", () => {
    const w = world();
    w.sameState = false;
    w.detector.heardReport("carol", report("cacacacacacacaca", 1, "bbbbbbbbbbbbbbbb"));
    w.detector.observe();
    vi.advanceTimersByTime(10_000);
    expect(seen(w)).toEqual([]); // not to be compared yet; the vector shows it (LOS-4)
    w.sameState = true; // the insertion arrived, and the deletion Carol stated did not
    w.detector.observe();
    expect(seen(w)).toEqual([{ kind: "diverged", sender: "carol", since: T0 }]);
    w.stateDigest = "dddddddddddddddd"; // what this client deletes since changes nothing of that
    expect(seen(w)).toEqual([{ kind: "diverged", sender: "carol", since: T0 }]);

    // Judged equal once, it stays no evidence, whatever this client deletes later.
    w.sameState = false;
    w.detector.heardReport("dave", report("dadadadadadadada", 1, "eeeeeeeeeeeeeeee"));
    w.detector.observe();
    w.sameState = true;
    w.stateDigest = "eeeeeeeeeeeeeeee";
    w.detector.observe();
    w.stateDigest = "ffffffffffffffff";
    vi.advanceTimersByTime(60_000);
    expect(seen(w).filter((s) => s.sender === "dave")).toEqual([]);
  });

  it("is replaced by a newer report of the same stream, which said it healed (LOS-17, LOS-18)", () => {
    const w = world();
    w.detector.heardReport("bob", report("b0b0b0b0b0b0b0b0", 1, "bbbbbbbbbbbbbbbb"));
    vi.advanceTimersByTime(5_000);
    w.detector.heardReport("bob", report("b0b0b0b0b0b0b0b0", 2)); // Bob healed, and said so
    vi.advanceTimersByTime(20_000);
    expect(seen(w)).toEqual([]);
  });

  it("is not replaced by an older report of the same stream, offered again or late (LOS-17)", () => {
    const w = world();
    w.detector.heardReport("bob", report("b0b0b0b0b0b0b0b0", 5, "bbbbbbbbbbbbbbbb"));
    w.detector.heardReport("bob", report("b0b0b0b0b0b0b0b0", 4)); // older, saying what we hold
    w.detector.heardReport("bob", report("b0b0b0b0b0b0b0b0", 5)); // the same number again
    vi.advanceTimersByTime(10_000);
    expect(seen(w)).toEqual([{ kind: "diverged", sender: "bob", since: T0 }]);
  });

  it("is not replaced by another stream's report, however new: another device of the member (LOS-17)", () => {
    const w = world();
    w.detector.heardReport("bob", report("1a1a1a1a1a1a1a1a", 1, "bbbbbbbbbbbbbbbb")); // the laptop deleted
    vi.advanceTimersByTime(3_000);
    w.detector.heardReport("bob", report("2b2b2b2b2b2b2b2b", 9)); // the phone, lagging, holds what we hold
    vi.advanceTimersByTime(7_000);
    expect(seen(w)).toEqual([{ kind: "diverged", sender: "bob", since: T0 }]);
    vi.advanceTimersByTime(60_000);
    expect(seen(w)).toEqual([{ kind: "diverged", sender: "bob", since: T0 }]);
  });

  it("keeps when it began across a newer report of the stream that shows the same, without a second wait (LOS-1)", () => {
    const w = world();
    w.detector.heardReport("bob", report("b0b0b0b0b0b0b0b0", 1, "bbbbbbbbbbbbbbbb"));
    vi.advanceTimersByTime(12_000);
    expect(seen(w)).toEqual([{ kind: "diverged", sender: "bob", since: T0 }]);
    w.detector.heardReport("bob", report("b0b0b0b0b0b0b0b0", 2, "bbbbbbbbbbbbbbbb"));
    expect(seen(w)).toEqual([{ kind: "diverged", sender: "bob", since: T0 }]);
  });

  it("keeps four streams of a member; a fifth replaces the one heard from least recently (LOS-17)", () => {
    const w = world();
    w.detector.heardReport("bob", report("0000000000000001", 1, "bbbbbbbbbbbbbbbb"));
    for (const stream of ["0000000000000002", "0000000000000003", "0000000000000004"]) {
      w.detector.heardReport("bob", report(stream, 1));
    }
    vi.advanceTimersByTime(10_000);
    expect(seen(w)).toHaveLength(1);
    w.detector.heardReport("bob", report("0000000000000005", 1));
    expect(seen(w)).toEqual([]);
  });

  it("counts for control state only at an equal control clock, and only from the creator (LOS-12)", () => {
    const w = world();
    w.held = [5, 1];
    w.detector.heardReport(
      "alice",
      report("a1a1a1a1a1a1a1a1", 1, "aaaaaaaaaaaaaaaa", 1, [5, 1], "dddddddddddddddd"),
    );
    // A member's report counts for what the member holds, not for control state: its control clock is
    // evidence only on a device of the creator (LOS-10, LOS-12).
    w.detector.heardReport(
      "bob",
      report("b0b0b0b0b0b0b0b0", 1, "aaaaaaaaaaaaaaaa", 1, [5, 1], "dddddddddddddddd"),
    );
    vi.advanceTimersByTime(10_000);
    expect(seen(w)).toEqual([{ kind: "control-diverged", sender: "alice", since: T0 }]);
    // The same digest: no difference.
    w.controlDigest = "dddddddddddddddd";
    expect(seen(w)).toEqual([]);
    w.controlDigest = "cccccccccccccccc";
    // At another clock the digests describe different states: the clocks say which is ahead (LOS-10).
    w.held = [5, 2];
    expect(seen(w)).toEqual([]);
    w.held = [5, 0];
    expect(seen(w).filter((s) => s.kind === "control-diverged")).toEqual([]);
  });
});

describe("a report that shows we are behind (LOS-4)", () => {
  it("is reported once it has lasted one expected latency, since the missing changes may be in flight", () => {
    const w = world();
    w.behind = true;
    w.detector.heardReport("bob", report("b0b0b0b0b0b0b0b0", 1));
    vi.advanceTimersByTime(9_999);
    expect(seen(w).filter((s) => s.kind === "behind-heartbeat")).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen(w)).toEqual([{ kind: "behind-heartbeat", sender: "bob", since: T0 }]);
  });

  it("is not reported when the report's state is one we already have", () => {
    const w = world();
    w.behind = false;
    w.detector.heardReport("bob", report("b0b0b0b0b0b0b0b0", 1));
    vi.advanceTimersByTime(60_000);
    expect(seen(w)).toEqual([]);
  });

  it("goes away by itself once the changes arrive, because it is judged against the document as it is now", () => {
    const w = world();
    w.behind = true;
    w.detector.heardReport("bob", report("b0b0b0b0b0b0b0b0", 1));
    vi.advanceTimersByTime(20_000);
    expect(seen(w)).toHaveLength(1);
    w.behind = false; // the late edit arrived
    expect(seen(w)).toEqual([]);
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
    expect(seen(w)).toEqual([{ kind: "behind-heartbeat", sender: "bob", since: T0 }]);
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
    expect(seen(w)).toEqual([
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
    expect(seen(w)).toEqual([
      expect.objectContaining({ kind: "behind-heartbeat", sender: "alice" }),
    ]);
  });

  it("counts a report of the client's own member: another device may hold what this one lacks (LOS-4)", () => {
    const w = world();
    w.behind = true;
    w.detector.heardReport("me", report("2b2b2b2b2b2b2b2b", 1));
    vi.advanceTimersByTime(10_000);
    expect(seen(w)).toEqual([{ kind: "behind-heartbeat", sender: "me", since: T0 }]);
  });

  it("ignores a report whose state vector is not one, rather than reporting a loss on garbage", () => {
    const w = new LossDetector({
      absenceMs: ABSENCE_MS,
      creatorMemberId: () => undefined,
      policy: () => resolveSyncPolicy({ expectedLatencyMs: 1000 }),
      pendingGapClients: () => [],
      lacksUpdatesOf: () => {
        throw new Error("not a state vector");
      },
      controlClock: () => [0, 0],
      stateDigestWithin: () => {
        throw new Error("not a state vector");
      },
      controlDigest: () => "cccccccccccccccc",
      stream: () => STREAM,
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
    expect(seen(w)).toEqual([]);
  });

  it("lacking one is evidence once no piece has come for a floor and the waiting time, and names the responder", () => {
    const w = world({ minIntervalMs: 2_000 }); // 2 s floor, 10 s of latency
    w.stateDigest = "bbbbbbbbbbbbbbbb"; // what this client deleted differs from what the last piece states
    w.detector.heardAnswerPiece("alice", piece(1, null));
    w.detector.heardAnswerPiece("alice", piece(3, 3)); // the delete piece, number 2, never comes
    vi.advanceTimersByTime(11_999);
    expect(seen(w).filter((s) => s.kind === "answer-incomplete")).toEqual([]);
    expect(w.detector.incompleteAnswers()).toEqual([
      { sender: "alice", received: 2, pieces: 3, since: T0 },
    ]);
    vi.advanceTimersByTime(1);
    expect(seen(w)).toContainEqual({
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
    expect(seen(w)).toEqual([{ kind: "answer-incomplete", sender: "alice", since: T0 }]);
  });

  it("ends with a later answer of the same stream that is complete, not with an earlier one's copies", () => {
    const w = world();
    w.stateDigest = "bbbbbbbbbbbbbbbb"; // what this client deleted differs from what the last piece states
    w.detector.heardAnswerPiece("alice", piece(2, 2, 4));
    vi.advanceTimersByTime(10_000);
    expect(seen(w).map((s) => s.kind)).toContain("answer-incomplete");
    w.detector.heardAnswerPiece("alice", piece(1, null, 3)); // a piece of an older answer, late
    expect(seen(w).map((s) => s.kind)).toContain("answer-incomplete");
    w.detector.heardAnswerPiece("alice", piece(1, 1, 5, "cccccccccccccccc")); // asked again: a whole answer
    expect(w.detector.incompleteAnswers()).toEqual([]);
    expect(seen(w)).toEqual([]); // held whole, though the digests differ
  });

  it("is no evidence when this client holds what the last piece states anyway", () => {
    const w = world();
    w.detector.heardAnswerPiece("alice", piece(2, 2)); // piece 1 lost, but its content came by edits
    vi.advanceTimersByTime(60_000);
    expect(seen(w)).toEqual([]);
  });

  it("are not counted for an answer to another client's request", () => {
    const w = world();
    w.detector.heardAnswerPiece("alice", { ...piece(1, null), own: false, request: THEIRS });
    vi.advanceTimersByTime(60_000);
    expect(w.detector.incompleteAnswers()).toEqual([]);
    expect(seen(w)).toEqual([]);
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
    expect(seen(w)).toEqual([{ kind: "answer-incomplete", sender: "alice", since: T0 }]);
    w.detector.heardAnswerPiece("alice", piece(3, 1, null, { own: false })); // her answer to Carol, piece 1
    vi.advanceTimersByTime(10_000);
    expect(w.detector.incompleteAnswers()).toEqual([
      { sender: "alice", received: 1, pieces: null, since: T0 },
    ]);
    expect(seen(w)).toEqual([{ kind: "answer-incomplete", sender: "alice", since: T0 }]);
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
    expect(seen(w).map((s) => s.kind)).toEqual(["behind-heartbeat"]); // what Carol's answer stated
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
    expect(seen(w)).toEqual([]);
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
    expect(seen(w).filter((s) => s.kind === "answer-incomplete")).toEqual([]);
  });

  it("with both last pieces lost, both stay until a later report of the stream shows this client holds its state", () => {
    const w = world();
    w.lacking.add(5);
    w.detector.heardAnswerPiece("alice", piece(2, 1, null));
    w.detector.heardAnswerPiece("alice", piece(3, 1, null, { request: OTHER_REQUEST }));
    w.detector.heardReport("alice", report(STREAM, 4, undefined, 5)); // her heartbeat: this client lacks what it states
    vi.advanceTimersByTime(10_000);
    expect(w.detector.incompleteAnswers()).toHaveLength(2);
    // A gap of each answer, and one of what her report shows missing (LOS-25).
    expect(
      w.detector
        .suspicions()
        .map((s) => s.kind)
        .sort(),
    ).toEqual(["answer-incomplete", "answer-incomplete", "behind-heartbeat"]);
    // Her next heartbeat states what this client holds, digest and all.
    w.detector.heardReport("alice", report(STREAM, 5));
    w.lacking.clear();
    expect(w.detector.incompleteAnswers()).toEqual([]);
    expect(seen(w)).toEqual([]);
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
    expect(seen(w)).toEqual([{ kind: "answer-incomplete", sender: "alice", since: T0 }]);
    // What the old engine sent before it stopped may still come.
    w.detector.heardAnswerPiece("alice", piece(2, 2, 2));
    expect(w.detector.incompleteAnswers()).toEqual([]);
    expect(seen(w)).toEqual([]);
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
      expect(seen(w)).toEqual([]);
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
    // A gap of each, the one given up among them (LOS-25).
    expect(incompleteSince(w)).toHaveLength(OPEN_TRANSFERS_PER_MEMBER + 1);
    expect(w.detector.suspicions().find((s) => s.since === T0)?.key).toBe(
      `answer:alice:${STREAM}:1`,
    );
    // A report of the stream this client holds, above its number, ends it; one at a lower number would not.
    w.lacking.clear();
    w.detector.heardReport("alice", report(STREAM, OPEN_TRANSFERS_PER_MEMBER + 2));
    expect(w.detector.incompleteAnswers()).toEqual([]);
    expect(seen(w)).toEqual([]);
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
    expect(seen(w)).toEqual([{ kind: "answer-incomplete", sender: "alice", since: T0 }]);
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
    expect(seen(w)).toEqual([{ kind: "diverged", sender: "alice", since: T0 }]);
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
    expect(seen(w)).toEqual([]);
    // Its heartbeat after the answer, saying the same, is held too.
    w.detector.heardReport("alice", report(STREAM, 3));
    vi.advanceTimersByTime(60_000);
    expect(seen(w)).toEqual([]);
    // One saying something else is judged again.
    w.detector.heardReport("alice", report(STREAM, 4, "cccccccccccccccc"));
    vi.advanceTimersByTime(10_000);
    expect(seen(w)).toEqual([{ kind: "diverged", sender: "alice", since: T0 + 70_000 }]);
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
    expect(seen(w)).toEqual([{ kind: "diverged", sender: "alice", since: T0 }]);
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

describe("a report this client holds by the state an answer's last piece states, a piece still missing (LOS-14, LOS-18)", () => {
  const STREAM = "a2a2a2a2a2a2a2a2";
  const lastPiece = (sequence: number, stateDigest = "aaaaaaaaaaaaaaaa") => ({
    stream: STREAM,
    sequence,
    piece: 2,
    pieces: 2,
    report: report(STREAM, sequence, stateDigest),
    own: true,
    request: MINE,
  });

  it("shows no digest difference later where it crossed a deletion of this client's own, as with a whole answer", () => {
    const w = world();
    // The last piece arrives, its first piece never does: this client holds what it states anyway,
    // so the answer covers (LOS-21).
    w.detector.heardAnswerPiece("alice", lastPiece(2));
    expect(seen(w)).toEqual([]);
    expect(w.detector.incompleteAnswers()).toEqual([]);
    // This client deletes something; the responder's heartbeat, sent before it had that deletion,
    // states the same state as the answer: what differs is what this client deleted itself.
    w.stateDigest = "bbbbbbbbbbbbbbbb";
    w.detector.heardReport("alice", report(STREAM, 3));
    vi.advanceTimersByTime(60_000);
    expect(seen(w)).toEqual([]);
    // One stating another state is judged again.
    w.detector.heardReport("alice", report(STREAM, 4, "cccccccccccccccc"));
    vi.advanceTimersByTime(10_000);
    expect(seen(w)).toEqual([{ kind: "diverged", sender: "alice", since: T0 + 60_000 }]);
  });

  it("holds nothing where this client does not hold what the last piece states: a later report of that state that differs stays evidence", () => {
    const w = world();
    // The missing piece carried deletions this client lacks: its digest differs from the stated one.
    w.stateDigest = "bbbbbbbbbbbbbbbb";
    w.detector.heardAnswerPiece("alice", lastPiece(2));
    w.detector.heardReport("alice", report(STREAM, 3));
    vi.advanceTimersByTime(60_000);
    expect(seen(w)).toEqual([
      { kind: "diverged", sender: "alice", since: T0 },
      { kind: "answer-incomplete", sender: "alice", since: T0 + w.policy.minIntervalMs },
    ]);
  });
});

describe("control state that is behind (LOS-10)", () => {
  it("is reported when the creator's heartbeat states a control clock above ours", () => {
    const w = world();
    w.held = [1_000, 3];
    w.detector.heardControlClock("alice", [1_000, 4]);
    w.detector.observe();
    vi.advanceTimersByTime(10_000);
    expect(seen(w).filter((s) => s.kind === "control-behind")).toEqual([
      { kind: "control-behind", since: T0 },
    ]);
  });

  it("counts a control clock only from the creator: anyone else's states no decision of the creator's", () => {
    const w = world();
    w.detector.heardControlClock("mallory", [2 ** 48 - 1, 65_535]);
    w.detector.heardReport(
      "mallory",
      report(
        "e0e0e0e0e0e0e0e0",
        1,
        "aaaaaaaaaaaaaaaa",
        1,
        [2 ** 48 - 1, 65_535],
        "dddddddddddddddd",
      ),
    );
    w.detector.observe();
    vi.advanceTimersByTime(60_000);
    expect(seen(w).filter((s) => s.kind.startsWith("control"))).toEqual([]);
  });

  it("is no evidence when the creator's device states a lower or an equal clock: it may know less", () => {
    const w = world();
    w.held = [2_000, 0];
    w.detector.heardControlClock("alice", [1_999, 65_535]);
    w.detector.heardControlClock("alice", [2_000, 0]);
    w.detector.observe();
    vi.advanceTimersByTime(60_000);
    expect(seen(w)).toEqual([]);
  });

  it("counts a request of the creator as a heartbeat does", () => {
    const w = world();
    w.held = [1_000, 0];
    // A request is a report (LOS-13); its clock counts as a heartbeat's.
    w.detector.heardReport(
      "alice",
      report("a1a1a1a1a1a1a1a1", 1, "aaaaaaaaaaaaaaaa", 1, [1_000, 1], "dddddddddddddddd"),
    );
    w.detector.observe();
    vi.advanceTimersByTime(10_000);
    expect(seen(w).filter((s) => s.kind === "control-behind")).toEqual([
      { kind: "control-behind", since: T0 },
    ]);
  });

  it("keeps the greatest clock any of the creator's devices stated: a lagging device does not hide it", () => {
    const w = world();
    w.held = [1_000, 0];
    w.detector.heardControlClock("alice", [5_000, 0]);
    w.detector.heardControlClock("alice", [500, 0]);
    w.detector.heardControlClock("alice", null);
    w.detector.observe();
    vi.advanceTimersByTime(10_000);
    expect(seen(w)).toEqual([{ kind: "control-behind", since: T0 }]);
  });

  it("goes away when we catch up to what the creator holds", () => {
    const w = world();
    w.held = [1_000, 3];
    w.detector.heardControlClock("alice", [1_000, 5]);
    w.detector.observe();
    vi.advanceTimersByTime(20_000);
    expect(seen(w)).toHaveLength(1);
    w.held = [1_000, 5];
    w.detector.observe();
    expect(seen(w)).toEqual([]);
  });
});

describe("several kinds of evidence at once", () => {
  it("are all reported, each with its own start", () => {
    const w = world();
    w.gaps = [1];
    w.behind = true;
    w.detector.heardControlClock("alice", [9, 0]);
    w.detector.observe();
    w.detector.heardReport("bob", report("b0b0b0b0b0b0b0b0", 1));
    vi.advanceTimersByTime(70_000);
    expect(
      w.detector
        .suspicions()
        .map((s) => s.kind)
        .sort(),
    ).toEqual(["behind-heartbeat", "control-behind", "pending-gap"]);
  });
});

describe("a wall clock that jumps back (§1.6, LOS-1)", () => {
  const HOUR = 3_600_000;

  it("a pending gap is reported once it lasted one expected latency as measured, not as long again as the wall clock went back", () => {
    const w = world();
    w.gaps = [42];
    w.detector.observe();
    vi.advanceTimersByTime(4_000);
    vi.setSystemTime(Date.now() - HOUR); // as a time service may set it
    vi.advanceTimersByTime(5_999);
    w.detector.observe();
    expect(seen(w)).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen(w).map((s) => s.kind)).toEqual(["pending-gap"]);
  });
});

describe("what a report of a device of the creator states of control state (LOS-12, LOS-17, LOS-18)", () => {
  const LAPTOP = "a1a1a1a1a1a1a1a1";
  const PHONE = "a2a2a2a2a2a2a2a2";
  /** A report of the creator's `stream` at `sequence`, stating control clock `clock` and digest `digest`. */
  const stating = (stream: string, sequence: number, clock: Clock, digest: string) =>
    report(stream, sequence, "aaaaaaaaaaaaaaaa", 1, clock, digest);
  /**
   * Piece `number` of `pieces` of an answer of the creator's `stream` at `sequence` to this client's own
   * request, carrying control clock `clock` and digest `digest` in its snapshot, which this client merged.
   */
  const answering = (
    stream: string,
    sequence: number,
    clock: Clock,
    digest: string,
    number = 1,
    pieces = 1,
  ) => ({
    stream,
    sequence,
    piece: number,
    pieces: number === pieces ? pieces : null,
    report: number === pieces ? report(stream, sequence) : null,
    own: true,
    request: MINE,
    control: number === pieces ? { clock, digest } : null,
  });

  it("a stream's newer report replaces its older one, and an older one arriving late replaces nothing", () => {
    const w = world();
    w.held = [5, 1];
    w.detector.heardReport("alice", stating(LAPTOP, 2, [5, 1], "dddddddddddddddd"));
    w.detector.heardReport("alice", stating(LAPTOP, 1, [5, 1], "cccccccccccccccc"));
    vi.advanceTimersByTime(10_000);
    expect(seen(w)).toEqual([{ kind: "control-diverged", sender: "alice", since: T0 }]);
    w.detector.heardReport("alice", stating(LAPTOP, 3, [5, 1], "cccccccccccccccc"));
    expect(seen(w)).toEqual([]);
    w.detector.heardReport("alice", stating(LAPTOP, 2, [5, 1], "dddddddddddddddd"));
    vi.advanceTimersByTime(10_000);
    expect(seen(w)).toEqual([]);
  });

  it("ends with a merged answer of that stream that states its clock and digest, not with another stream's (LOS-18)", () => {
    const w = world();
    w.held = [5, 1];
    w.detector.heardReport("alice", stating(LAPTOP, 1, [5, 1], "dddddddddddddddd"));
    w.detector.heardReport("alice", stating(PHONE, 1, [5, 1], "eeeeeeeeeeeeeeee"));
    vi.advanceTimersByTime(10_000);
    expect(w.detector.suspicions().map((s) => s.key)).toEqual([
      `control-report:${LAPTOP}`,
      `control-report:${PHONE}`,
    ]);
    // The phone's whole answer says what the phone held, nothing of the laptop's.
    w.detector.heardAnswerPiece("alice", answering(PHONE, 2, [5, 1], "eeeeeeeeeeeeeeee"));
    expect(w.detector.suspicions().map((s) => s.key)).toEqual([`control-report:${LAPTOP}`]);
    // The phone stating again what it held as it answered is no evidence.
    w.detector.heardReport("alice", stating(PHONE, 3, [5, 1], "eeeeeeeeeeeeeeee"));
    vi.advanceTimersByTime(10_000);
    expect(w.detector.suspicions().map((s) => s.key)).toEqual([`control-report:${LAPTOP}`]);
  });

  it("a gap that ended — this client came to hold that digest, or its clock moved on — restarts the wait of LOS-1 when a later report of the stream differs again", () => {
    const EXPIRY = 30_000;
    const w = world(); // 10 s of latency: believed after 10 s, first asked for after 20 s and its slot
    const slot = slotOf(`control-report:${LAPTOP}`);
    w.held = [5, 1];
    w.detector.heardReport("alice", stating(LAPTOP, 1, [5, 1], "dddddddddddddddd"));
    vi.advanceTimersByTime(20_000 + slot);
    expect(w.detector.dueGaps(Date.now(), EXPIRY)).toStrictEqual([`control-report:${LAPTOP}`]);
    w.detector.tried(Date.now());
    // This client merged what the report states: the gap ends.
    w.controlDigest = "dddddddddddddddd";
    w.detector.observe();
    expect(seen(w)).toEqual([]);
    vi.advanceTimersByTime(60_000);
    // It merged more under that clock; the stream's next report states another digest again.
    w.controlDigest = "eeeeeeeeeeeeeeee";
    const again = Date.now();
    w.detector.heardReport("alice", stating(LAPTOP, 2, [5, 1], "ffffffffffffffff"));
    vi.advanceTimersByTime(9_999);
    expect(seen(w)).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(w.detector.suspicions()).toMatchObject([
      { kind: "control-diverged", since: again, tries: 0 },
    ]);
    expect(w.detector.dueGaps(Date.now(), EXPIRY)).toStrictEqual([]);
    vi.advanceTimersByTime(10_000 + slot);
    expect(w.detector.dueGaps(Date.now(), EXPIRY)).toStrictEqual([`control-report:${LAPTOP}`]);
    // Ended by its clock moving on, past what the report states, the same holds.
    w.detector.tried(Date.now());
    w.held = [6, 0];
    w.detector.observe();
    expect(seen(w)).toEqual([]);
    vi.advanceTimersByTime(60_000);
    const third = Date.now();
    w.detector.heardReport("alice", stating(LAPTOP, 3, [6, 0], "ffffffffffffffff"));
    vi.advanceTimersByTime(10_000);
    expect(w.detector.suspicions()).toMatchObject([
      { kind: "control-diverged", since: third, tries: 0 },
    ]);
  });

  it("ends with no member's merged answer, whatever it states (LOS-10, LOS-12)", () => {
    const w = world();
    w.held = [5, 1];
    w.detector.heardReport("alice", stating(LAPTOP, 1, [5, 1], "dddddddddddddddd"));
    vi.advanceTimersByTime(10_000);
    w.detector.heardAnswerPiece("bob", answering(LAPTOP, 2, [5, 1], "dddddddddddddddd"));
    expect(w.detector.suspicions().map((s) => s.key)).toEqual([`control-report:${LAPTOP}`]);
  });

  // A whole answer covers its stream's state up to its number, and later reports of that same state —
  // not a newer state of the stream (LOS-17, LOS-18). Here the laptop's report no. 4 states the close
  // this client missed; the answer no. 3 was taken before it, and arrives after it.
  it("a whole answer older than the stream's report that states another control state leaves the evidence, with its time (LOS-17, LOS-18)", () => {
    const w = world();
    w.held = [5, 1];
    w.sameState = false; // the answer's content is not held otherwise: only its pieces show it whole
    w.detector.heardReport("alice", stating(LAPTOP, 4, [5, 1], "dddddddddddddddd"));
    vi.advanceTimersByTime(10_000);
    expect(seen(w)).toEqual([{ kind: "control-diverged", sender: "alice", since: T0 }]);
    w.detector.heardAnswerPiece("alice", answering(LAPTOP, 3, [5, 1], "cccccccccccccccc"));
    vi.advanceTimersByTime(10_000);
    expect(seen(w)).toEqual([{ kind: "control-diverged", sender: "alice", since: T0 }]);
  });

  it("a whole answer newer than the report ends it, whatever control state it held (LOS-18)", () => {
    const w = world();
    w.held = [5, 1];
    w.sameState = false;
    w.detector.heardReport("alice", stating(LAPTOP, 4, [5, 1], "dddddddddddddddd"));
    vi.advanceTimersByTime(10_000);
    w.detector.heardAnswerPiece("alice", answering(LAPTOP, 3, [5, 1], "cccccccccccccccc"));
    // The laptop's answer no. 5 brings the close; this client, which merged it, holds more under that
    // clock than the laptop stated: no report of the laptop's up to no. 5 is evidence.
    w.detector.heardAnswerPiece("alice", answering(LAPTOP, 5, [5, 1], "eeeeeeeeeeeeeeee"));
    expect(seen(w)).toEqual([]);
  });

  it("an answer in pieces covers nothing before it is whole, the piece with the control state come first (LOS-14, LOS-18)", () => {
    const w = world();
    w.held = [5, 1];
    w.sameState = false;
    w.detector.heardReport("alice", stating(LAPTOP, 1, [5, 1], "dddddddddddddddd"));
    vi.advanceTimersByTime(10_000);
    w.detector.heardAnswerPiece("alice", answering(LAPTOP, 2, [5, 1], "eeeeeeeeeeeeeeee", 3, 3));
    w.detector.heardAnswerPiece("alice", answering(LAPTOP, 2, [5, 1], "eeeeeeeeeeeeeeee", 1, 3));
    expect(w.detector.suspicions().map((s) => s.key)).toEqual([`control-report:${LAPTOP}`]);
    w.detector.heardAnswerPiece("alice", answering(LAPTOP, 2, [5, 1], "eeeeeeeeeeeeeeee", 2, 3));
    expect(seen(w)).toEqual([]);
  });

  it("an answer in pieces covers once this client holds what its last piece states, a piece still missing (LOS-14, LOS-18)", () => {
    const w = world();
    w.held = [5, 1];
    w.behind = true; // until it holds the last piece's state from elsewhere
    w.detector.heardReport("alice", stating(LAPTOP, 1, [5, 1], "dddddddddddddddd"));
    vi.advanceTimersByTime(10_000);
    w.detector.heardAnswerPiece("alice", answering(LAPTOP, 2, [5, 1], "eeeeeeeeeeeeeeee", 2, 2));
    expect(w.detector.suspicions().map((s) => s.key)).toContain(`control-report:${LAPTOP}`);
    w.behind = false;
    expect(seen(w)).toEqual([]);
  });

  it("an answer numbered no higher than what this client holds of the stream covers what it held at once (LOS-14, LOS-18)", () => {
    const w = world();
    w.held = [5, 1];
    // The laptop's report no. 2 states what this client holds of the content, and a control digest that
    // differs from this client's: a register under a lower clock the laptop lacks, say.
    w.detector.heardReport("alice", stating(LAPTOP, 2, [5, 1], "dddddddddddddddd"));
    vi.advanceTimersByTime(10_000);
    expect(seen(w)).toEqual([{ kind: "control-diverged", sender: "alice", since: T0 }]);
    // Its answer no. 1, which held the same control state, arrives late: not counted, it covers it all the same.
    w.detector.heardAnswerPiece("alice", answering(LAPTOP, 1, [5, 1], "dddddddddddddddd"));
    expect(seen(w)).toEqual([]);
  });

  it("a later report stating exactly what a whole answer held is covered; one stating another state is not (LOS-18)", () => {
    const w = world();
    w.held = [5, 1];
    w.detector.heardReport("alice", stating(LAPTOP, 1, [5, 1], "dddddddddddddddd"));
    vi.advanceTimersByTime(10_000);
    w.detector.heardAnswerPiece("alice", answering(LAPTOP, 2, [5, 1], "eeeeeeeeeeeeeeee"));
    w.detector.heardReport("alice", stating(LAPTOP, 3, [5, 1], "eeeeeeeeeeeeeeee"));
    expect(seen(w)).toEqual([]);
    vi.advanceTimersByTime(10_000);
    expect(seen(w)).toEqual([]);
    const later = Date.now();
    w.detector.heardReport("alice", stating(LAPTOP, 4, [5, 1], "ffffffffffffffff"));
    vi.advanceTimersByTime(10_000);
    expect(seen(w)).toEqual([{ kind: "control-diverged", sender: "alice", since: later }]);
  });

  it("an older whole answer arriving late leaves the newer one's cover: its state stated again is no evidence, nor a report numbered below it (LOS-17, LOS-18)", () => {
    const w = world();
    w.held = [5, 1];
    w.detector.heardAnswerPiece("alice", answering(LAPTOP, 5, [5, 1], "eeeeeeeeeeeeeeee"));
    w.detector.heardAnswerPiece("alice", answering(LAPTOP, 3, [5, 1], "dddddddddddddddd"));
    w.detector.heardReport("alice", stating(LAPTOP, 6, [5, 1], "eeeeeeeeeeeeeeee"));
    vi.advanceTimersByTime(10_000);
    expect(seen(w)).toEqual([]);
    // A report numbered below the newer answer, arriving late, states nothing that answer does not cover.
    const v = world();
    v.held = [5, 1];
    v.detector.heardAnswerPiece("alice", answering(LAPTOP, 5, [5, 1], "eeeeeeeeeeeeeeee"));
    v.detector.heardReport("alice", stating(LAPTOP, 4, [5, 1], "dddddddddddddddd"));
    vi.advanceTimersByTime(10_000);
    expect(seen(v)).toEqual([]);
  });
});

describe("a report of the creator that shows another control digest again (LOS-6, LOS-12)", () => {
  it("keeps the time the first showed it, so a device that reports after every change does not start it afresh", () => {
    const w = world();
    w.held = [5, 1];
    w.detector.heardReport(
      "alice",
      report("a1a1a1a1a1a1a1a1", 1, "aaaaaaaaaaaaaaaa", 1, [5, 1], "dddddddddddddddd"),
    );
    vi.advanceTimersByTime(4_000);
    w.detector.heardReport(
      "alice",
      report("a1a1a1a1a1a1a1a1", 2, "aaaaaaaaaaaaaaaa", 1, [5, 1], "dddddddddddddddd"),
    );
    vi.advanceTimersByTime(4_000);
    w.detector.heardReport(
      "alice",
      report("a1a1a1a1a1a1a1a1", 3, "aaaaaaaaaaaaaaaa", 1, [5, 1], "dddddddddddddddd"),
    );
    vi.advanceTimersByTime(4_000);
    expect(seen(w)).toEqual([{ kind: "control-diverged", sender: "alice", since: T0 }]);
  });
});

describe("gaps: one of each stream, with tries of its own, which rest and are woken (LOS-6, LOS-25, LOS-26)", () => {
  /** 10 s of latency: a gap is believed after 10 s and first asked for after 20 s and its slot in a window of 60 s. */
  const EXPIRY = 30_000;

  it("a report that counts updates of two writers this client lacks is a gap of each, named by its writer where known", () => {
    const w = world();
    w.ahead = new Map([
      [
        7,
        new Map([
          [42, 5],
          [43, 9],
        ]),
      ],
    ]);
    w.lacking.add(7);
    w.detector.learnClient(42, "dave");
    w.detector.heardReport("carol", report("cacacacacacacaca", 1, undefined, 7));
    vi.advanceTimersByTime(10_000);
    expect(w.detector.suspicions()).toStrictEqual([
      { kind: "behind-heartbeat", sender: "dave", since: T0, key: "content:42", tries: 0 },
      { kind: "behind-heartbeat", sender: "carol", since: T0, key: "content:43", tries: 0 },
    ]);
  });

  it("a pending gap and a report showing the same writer's stream are one gap", () => {
    const w = world();
    w.gaps = [42];
    w.detector.observe();
    w.ahead = new Map([[7, new Map([[42, 5]])]]);
    w.lacking.add(7);
    w.detector.heardReport("carol", report("cacacacacacacaca", 1, undefined, 7));
    vi.advanceTimersByTime(10_000);
    expect(w.detector.suspicions().map((s) => [s.key, s.kind])).toStrictEqual([
      ["content:42", "pending-gap"],
    ]);
  });

  it("is first due after twice the waiting time and its slot, then after the expiry times two to its tries, never more than 10 min apart; after three it rests", () => {
    const w = world();
    w.gaps = [42];
    w.detector.observe();
    const due = () => w.detector.dueGaps(Date.now(), EXPIRY);
    vi.advanceTimersByTime(20_000 + slotOf("content:42") - 1);
    expect(due()).toStrictEqual([]);
    vi.advanceTimersByTime(1);
    expect(due()).toStrictEqual(["content:42"]);
    w.detector.tried(Date.now());
    vi.advanceTimersByTime(2 * EXPIRY - 1);
    expect(due()).toStrictEqual([]);
    vi.advanceTimersByTime(1);
    expect(due()).toStrictEqual(["content:42"]);
    w.detector.tried(Date.now());
    vi.advanceTimersByTime(4 * EXPIRY);
    expect(due()).toStrictEqual(["content:42"]);
    w.detector.tried(Date.now());
    expect(w.detector.suspicions()).toMatchObject([
      { key: "content:42", tries: MAX_GAP_TRIES, resting: true },
    ]);
    vi.advanceTimersByTime(24 * 3_600_000);
    expect(due()).toStrictEqual([]);
  });

  it("never waits more than 10 min between two tries", () => {
    const w = world();
    w.gaps = [42];
    w.detector.observe();
    const long = 400_000;
    vi.advanceTimersByTime(20_000);
    w.detector.tried(Date.now());
    vi.advanceTimersByTime(GAP_SPACING_CAP_MS);
    expect(w.detector.dueGaps(Date.now(), long)).toStrictEqual(["content:42"]);
  });

  it("keeps its time while it lasts: a gap seen again is not a new one, a gap after it ended is", () => {
    const w = world();
    w.gaps = [42];
    w.detector.observe();
    vi.advanceTimersByTime(20_000);
    w.detector.tried(Date.now());
    w.detector.observe();
    expect(w.detector.suspicions()).toMatchObject([{ since: T0, tries: 1 }]);
    w.gaps = [];
    w.detector.observe();
    w.gaps = [42];
    w.detector.observe();
    vi.advanceTimersByTime(10_000);
    expect(w.detector.suspicions()).toMatchObject([{ since: T0 + 20_000, tries: 0 }]);
  });

  it("a request counts for every gap whose wait had passed, and for none that is newer", () => {
    const w = world();
    w.gaps = [42];
    w.detector.observe();
    vi.advanceTimersByTime(20_000);
    w.gaps = [42, 43];
    w.detector.observe();
    w.detector.tried(Date.now());
    vi.advanceTimersByTime(10_000);
    expect(w.detector.suspicions().map((s) => [s.key, s.tries])).toStrictEqual([
      ["content:42", 1],
      ["content:43", 0],
    ]);
  });

  /** A gap of client 42 that rests: three tries made. */
  function resting(): World {
    const w = world();
    w.gaps = [42];
    w.detector.heardClocks(new Map([[42, 5]]));
    w.detector.observe();
    for (let tried = 0; tried < MAX_GAP_TRIES; tried++) {
      vi.advanceTimersByTime(GAP_SPACING_CAP_MS);
      w.detector.tried(Date.now());
    }
    return w;
  }

  /** How long after a wake by a frame its request is due: the wait and the slot of a first try (LOS-6, LOS-26). */
  const WOKEN_AFTER = 20_000 + slotOf("content:42");

  it("a resting gap is woken by an update that carries its writer further: once, in its slot, and not again within 10 min", () => {
    const w = resting();
    w.detector.heardClocks(new Map([[42, 5]])); // the same position, from anyone
    expect(w.detector.dueGaps(Date.now(), EXPIRY)).toStrictEqual([]);
    w.detector.heardClocks(new Map([[42, 6]]));
    w.detector.observe(); // the poll that read it
    vi.advanceTimersByTime(WOKEN_AFTER - 1);
    expect(w.detector.dueGaps(Date.now(), EXPIRY)).toStrictEqual([]);
    vi.advanceTimersByTime(1);
    expect(w.detector.dueGaps(Date.now(), EXPIRY)).toStrictEqual(["content:42"]);
    w.detector.tried(Date.now());
    expect(w.detector.dueGaps(Date.now(), EXPIRY)).toStrictEqual([]);
    w.detector.heardClocks(new Map([[42, 7]]));
    w.detector.observe();
    vi.advanceTimersByTime(WAKE_SPACING_MS + WOKEN_AFTER - 1);
    expect(w.detector.dueGaps(Date.now(), EXPIRY)).toStrictEqual([]);
    vi.advanceTimersByTime(1);
    expect(w.detector.dueGaps(Date.now(), EXPIRY)).toStrictEqual(["content:42"]);
    w.detector.tried(Date.now());
    expect(w.detector.suspicions()).toMatchObject([{ tries: MAX_GAP_TRIES, resting: true }]);
  });

  it("a resting gap of a client whose writer is known is woken by any frame of that writer, once, in its slot, and not again within 10 min; a frame of anyone else wakes nothing (LOS-2, LOS-26)", () => {
    const w = resting();
    w.detector.learnClient(42, "carol");
    const due = () => w.detector.dueGaps(Date.now(), EXPIRY);
    w.detector.heardFrom("dave");
    vi.advanceTimersByTime(WOKEN_AFTER);
    expect(due()).toStrictEqual([]);
    w.detector.heardFrom("carol");
    vi.advanceTimersByTime(WOKEN_AFTER - 1);
    expect(due()).toStrictEqual([]);
    vi.advanceTimersByTime(1);
    expect(due()).toStrictEqual(["content:42"]);
    w.detector.tried(Date.now());
    expect(due()).toStrictEqual([]);
    w.detector.heardFrom("carol");
    vi.advanceTimersByTime(WAKE_SPACING_MS + WOKEN_AFTER - 1);
    expect(due()).toStrictEqual([]);
    vi.advanceTimersByTime(1);
    expect(due()).toStrictEqual(["content:42"]);
    w.detector.tried(Date.now());
    expect(w.detector.suspicions()).toMatchObject([
      { key: "content:42", sender: "carol", tries: MAX_GAP_TRIES, resting: true },
    ]);
  });

  it("a frame of the writer read while the gap still has tries leaves no wake for when it rests; nor does one of a gap whose writer is not known", () => {
    const w = world();
    w.gaps = [42, 43];
    w.detector.learnClient(42, "carol");
    w.detector.observe();
    const due = () => w.detector.dueGaps(Date.now(), EXPIRY);
    for (let tried = 0; tried < MAX_GAP_TRIES; tried++) {
      vi.advanceTimersByTime(GAP_SPACING_CAP_MS);
      w.detector.heardFrom("carol");
      w.detector.tried(Date.now());
    }
    expect(w.detector.suspicions().map((s) => s.resting)).toStrictEqual([true, true]);
    vi.advanceTimersByTime(24 * 3_600_000);
    expect(due()).toStrictEqual([]);
    w.detector.heardFrom("carol");
    vi.advanceTimersByTime(WOKEN_AFTER);
    expect(due()).toStrictEqual(["content:42"]);
  });

  it("its first try waits, after twice the waiting time, for a slot derived from the gap and this client's own stream over the answer window: clients with the same gap ask apart, and one client's gaps too (LOS-6, RSY-20)", () => {
    const window = answerWindowMs(10_000);
    const streams = [STREAM, "a7a7a7a7a7a7a7a7"];
    const slots = streams.map((stream) => slotOf("content:42", stream));
    expect(new Set([...slots, slotOf("content:43")]).size).toBe(3);
    for (const slot of [...slots, slotOf("content:43")]) {
      expect(slot).toBeGreaterThan(0);
      expect(slot).toBeLessThan(window);
    }
    for (const stream of streams) {
      const w = world();
      w.stream = stream;
      w.gaps = [42, 43];
      w.detector.observe();
      // Both gaps arose at T0; each is due once it lasted 20 s and its own slot, not before.
      for (const key of ["content:42", "content:43"]) {
        const slot = slotOf(key, stream);
        expect(w.detector.dueGaps(T0 + 20_000 + slot - 1, EXPIRY)).not.toContain(key);
        expect(w.detector.dueGaps(T0 + 20_000 + slot, EXPIRY)).toContain(key);
      }
    }
  });

  it("wakeAll wakes every resting gap at once, whatever its last wake; its one request is theirs", () => {
    const w = resting();
    w.detector.heardClocks(new Map([[42, 6]]));
    w.detector.tried(Date.now());
    w.detector.wakeAll();
    expect(w.detector.dueGaps(Date.now(), EXPIRY)).toStrictEqual(["content:42"]);
    w.detector.tried(Date.now());
    expect(w.detector.dueGaps(Date.now(), EXPIRY)).toStrictEqual([]);
    vi.advanceTimersByTime(3_600_000);
    expect(w.detector.dueGaps(Date.now(), EXPIRY)).toStrictEqual([]);
  });

  it("a truncated history is a gap of its own, due at once and shown at once (LOS-19)", () => {
    let truncated: number | undefined;
    const w = world();
    w.detector = new LossDetector({
      absenceMs: ABSENCE_MS,
      creatorMemberId: () => w.creator,
      policy: () => w.policy,
      pendingGapClients: () => w.gaps,
      lacksUpdatesOf: () => false,
      controlClock: () => w.held,
      stateDigestWithin: () => w.stateDigest,
      controlDigest: () => w.controlDigest,
      truncatedSince: () => truncated,
      stream: () => STREAM,
    });
    truncated = Date.now();
    expect(w.detector.dueGaps(Date.now(), EXPIRY)).toStrictEqual(["truncated"]);
    expect(w.detector.suspicions()).toStrictEqual([
      { kind: "history-truncated", since: T0, key: "truncated", tries: 0 },
    ]);
    truncated = undefined;
    expect(w.detector.suspicions()).toStrictEqual([]);
  });
});

describe("a difference in digests lapses once its stream is silent for longer than the absence threshold (LOS-12, LOS-13, RSY-1)", () => {
  const BOB = "b0b0b0b0b0b0b0b0";
  const LAPTOP = "a1a1a1a1a1a1a1a1";
  /** 10 s of latency: a gap is believed after 10 s and first asked for after 20 s. */
  const EXPIRY = 30_000;
  /** A piece of an answer of `stream` at `sequence` that is not the last, to someone else's request: it states nothing. */
  const passing = (stream: string, sequence: number) => ({
    stream,
    sequence,
    piece: 1,
    pieces: null,
    report: null,
    own: false,
    request: THEIRS,
  });
  const keys = (w: World) => w.detector.suspicions().map((s) => s.key);

  it("a report's state digest at a vector this client holds: shown up to the threshold, lapsed past it, and back only with a newer report of the stream that still differs, its gap keeping its tries", () => {
    const w = world();
    const slot = slotOf(`deletions:bob:${BOB}`);
    w.detector.heardReport("bob", report(BOB, 2, "bbbbbbbbbbbbbbbb"));
    vi.advanceTimersByTime(20_000 + slot);
    expect(w.detector.dueGaps(Date.now(), EXPIRY)).toStrictEqual([`deletions:bob:${BOB}`]);
    w.detector.tried(Date.now());
    vi.advanceTimersByTime(ABSENCE_MS - 20_000 - slot);
    expect(w.detector.suspicions()).toMatchObject([
      { kind: "diverged", key: `deletions:bob:${BOB}`, since: T0, tries: 1 },
    ]);
    vi.advanceTimersByTime(1);
    expect(w.detector.suspicions()).toStrictEqual([]);
    expect(w.detector.hasGaps).toBe(false);
    expect(w.detector.dueGaps(Date.now(), EXPIRY)).toStrictEqual([]);
    // A request to all meanwhile — the person's, say — is no try of it.
    w.detector.tried(Date.now());
    // The same report offered again, or an older one arriving late, brings nothing back.
    w.detector.heardReport("bob", report(BOB, 2, "bbbbbbbbbbbbbbbb"));
    w.detector.heardReport("bob", report(BOB, 1, "bbbbbbbbbbbbbbbb"));
    vi.advanceTimersByTime(20_000);
    expect(w.detector.suspicions()).toStrictEqual([]);
    // A newer one that still differs does: the gap it lapsed from, with its time and its try.
    w.detector.heardReport("bob", report(BOB, 3, "bbbbbbbbbbbbbbbb"));
    expect(w.detector.suspicions()).toMatchObject([
      { kind: "diverged", key: `deletions:bob:${BOB}`, since: T0, tries: 1 },
    ]);
    // One that does not differ ends it.
    w.detector.heardReport("bob", report(BOB, 4));
    expect(w.detector.suspicions()).toStrictEqual([]);
  });

  it("a report of the creator's control digest at this client's control clock lapses the same way", () => {
    const w = world();
    w.held = [5, 1];
    w.detector.heardReport(
      "alice",
      report(LAPTOP, 1, "aaaaaaaaaaaaaaaa", 1, [5, 1], "dddddddddddddddd"),
    );
    vi.advanceTimersByTime(ABSENCE_MS);
    expect(keys(w)).toStrictEqual([`control-report:${LAPTOP}`]);
    vi.advanceTimersByTime(1);
    expect(keys(w)).toStrictEqual([]);
    w.detector.heardReport(
      "alice",
      report(LAPTOP, 1, "aaaaaaaaaaaaaaaa", 1, [5, 1], "dddddddddddddddd"),
    );
    expect(keys(w)).toStrictEqual([]);
    w.detector.heardReport(
      "alice",
      report(LAPTOP, 2, "aaaaaaaaaaaaaaaa", 1, [5, 1], "dddddddddddddddd"),
    );
    expect(keys(w)).toStrictEqual([`control-report:${LAPTOP}`]);
  });

  it("only a frame with a number above every one heard of the stream counts as heard: copies and older frames of it do not keep the difference, a later piece of an answer does, and brings back nothing once it lapsed", () => {
    const w = world();
    w.detector.heardReport("bob", report(BOB, 5, "bbbbbbbbbbbbbbbb"));
    vi.advanceTimersByTime(ABSENCE_MS - 60_000);
    w.detector.heardReport("bob", report(BOB, 5, "bbbbbbbbbbbbbbbb"));
    w.detector.heardReport("bob", report(BOB, 4, "bbbbbbbbbbbbbbbb"));
    w.detector.heardAnswerPiece("bob", passing(BOB, 5));
    w.detector.heardStream("bob", BOB, 3);
    vi.advanceTimersByTime(60_001);
    expect(keys(w)).toStrictEqual([]);

    const v = world();
    const t1 = Date.now();
    v.detector.heardReport("bob", report(BOB, 5, "bbbbbbbbbbbbbbbb"));
    vi.advanceTimersByTime(ABSENCE_MS - 60_000);
    // A piece of its answer to someone else, numbered above its report: the stream is heard, though the
    // piece states nothing and replaces no report.
    v.detector.heardAnswerPiece("bob", passing(BOB, 6));
    vi.advanceTimersByTime(60_001);
    expect(v.detector.suspicions()).toMatchObject([{ kind: "diverged", since: t1 }]);
    // A piece of an answer it does not take, numbered above again, as the engine tells it.
    vi.advanceTimersByTime(ABSENCE_MS - 70_000);
    v.detector.heardStream("bob", BOB, 7);
    vi.advanceTimersByTime(ABSENCE_MS);
    expect(v.detector.suspicions()).toMatchObject([{ kind: "diverged", since: t1 }]);
    vi.advanceTimersByTime(1);
    expect(v.detector.suspicions()).toStrictEqual([]);
    // Heard again after the lapse by a frame that is no report: still lapsed.
    v.detector.heardStream("bob", BOB, 8);
    v.detector.heardAnswerPiece("bob", passing(BOB, 9));
    expect(v.detector.suspicions()).toStrictEqual([]);
  });

  it("a silent stream's difference lapses while another stream of the member goes on reporting", () => {
    const w = world();
    w.detector.heardReport("bob", report(BOB, 1, "bbbbbbbbbbbbbbbb"));
    for (let minute = 1; minute <= 11; minute++) {
      vi.advanceTimersByTime(60_000);
      w.detector.heardReport("bob", report("b1b1b1b1b1b1b1b1", minute));
    }
    expect(keys(w)).toStrictEqual([]);
  });

  it("a lapsed gap that rested is not due, woken by an absence the application tells of or by the person; back with a newer report, it rests on with its tries, and the newer report wakes it once, its request in its slot", () => {
    const w = world();
    w.detector.heardReport("bob", report(BOB, 1, "bbbbbbbbbbbbbbbb"));
    // Its three tries within five minutes: 20 s, then 60 s and 120 s apart (LOS-6).
    for (let second = 0; second < 300; second++) {
      vi.advanceTimersByTime(1_000);
      w.detector.tried(Date.now(), w.detector.dueGaps(Date.now(), EXPIRY));
    }
    expect(w.detector.suspicions()).toMatchObject([
      { kind: "diverged", tries: MAX_GAP_TRIES, resting: true },
    ]);
    vi.advanceTimersByTime(ABSENCE_MS);
    w.detector.wakeAll();
    expect(w.detector.dueGaps(Date.now(), EXPIRY)).toStrictEqual([]);
    expect(w.detector.suspicions()).toStrictEqual([]);
    // Back with a newer report: it rests on, with its tries, and the newer report woke it.
    w.detector.heardReport("bob", report(BOB, 2, "bbbbbbbbbbbbbbbb"));
    w.detector.observe();
    expect(w.detector.suspicions()).toMatchObject([
      { kind: "diverged", tries: MAX_GAP_TRIES, resting: true },
    ]);
    vi.advanceTimersByTime(20_000 + slotOf(`deletions:bob:${BOB}`) - 1);
    expect(w.detector.dueGaps(Date.now(), EXPIRY)).toStrictEqual([]);
    vi.advanceTimersByTime(1);
    expect(w.detector.dueGaps(Date.now(), EXPIRY)).toStrictEqual([`deletions:bob:${BOB}`]);
  });
});

describe("a lapsed gap waiting for the slot of its first try (LOS-6, LOS-12, RSY-22)", () => {
  const BOB = "b0b0b0b0b0b0b0b0";
  const KEY = `deletions:bob:${BOB}`;
  /** 400 s of latency: a gap is first asked for after 800 s, its stream lapsing after 600 s unheard; the window is 300 s. */
  const slow = { expectedLatencyMs: 400_000 };
  const slot = answerDelayMs(KEY, STREAM, answerWindowMs(400_000));

  it("is not about to be asked for, nor is a request let go for another's for it; heard meanwhile, it is", () => {
    expect(slot).toBeGreaterThan(1);
    const lapsed = world(slow);
    const heard = world(slow);
    for (const w of [lapsed, heard])
      w.detector.heardReport("bob", report(BOB, 2, "bbbbbbbbbbbbbbbb"));
    vi.advanceTimersByTime(500_000);
    heard.detector.heardStream("bob", BOB, 3);
    vi.advanceTimersByTime(300_001);
    expect(lapsed.detector.awaitingSlot(Date.now(), 30_000)).toStrictEqual([]);
    expect(heard.detector.awaitingSlot(Date.now(), 30_000)).toStrictEqual([KEY]);
    // Neither is due before its slot; the one heard is, after it.
    vi.advanceTimersByTime(slot);
    expect(lapsed.detector.dueGaps(Date.now(), 30_000)).toStrictEqual([]);
    expect(heard.detector.dueGaps(Date.now(), 30_000)).toStrictEqual([KEY]);
  });
});

describe("nothing else lapses with its stream's silence (LOS-12)", () => {
  const BOB = "b0b0b0b0b0b0b0b0";
  const LAPTOP = "a1a1a1a1a1a1a1a1";
  const PAST = ABSENCE_MS + 60_000;
  const kinds = (w: World) => w.detector.suspicions().map((s) => s.kind);

  it("missing predecessors (LOS-2)", () => {
    const w = world();
    w.gaps = [42];
    w.detector.observe();
    vi.advanceTimersByTime(PAST);
    expect(kinds(w)).toStrictEqual(["pending-gap"]);
  });

  it("updates a report shows this client lacks, of a writer it names (LOS-4, LOS-25)", () => {
    const w = world();
    w.ahead = new Map([[1, new Map([[7, 12]])]]);
    w.lacking.add(1);
    w.sameState = false;
    w.detector.heardReport("bob", report(BOB, 1, "bbbbbbbbbbbbbbbb"));
    vi.advanceTimersByTime(PAST);
    expect(w.detector.suspicions()).toMatchObject([{ kind: "behind-heartbeat", key: "content:7" }]);
    expect(w.detector.suspicions()).toHaveLength(1);
  });

  it("updates a report shows this client lacks, where the profile cannot name the writer (LOS-4)", () => {
    const w = world();
    w.lacking.add(1);
    w.sameState = false; // lacking an insertion the report counts, this client cannot compare digests
    w.detector.heardReport("bob", report(BOB, 1, "bbbbbbbbbbbbbbbb"));
    vi.advanceTimersByTime(PAST);
    expect(w.detector.suspicions()).toMatchObject([
      { kind: "behind-heartbeat", key: `content-of:bob:${BOB}` },
    ]);
    expect(w.detector.suspicions()).toHaveLength(1);
  });

  it("an answer to this client's own request missing a piece (LOS-14)", () => {
    const w = world();
    w.lacking.add(1);
    w.detector.heardAnswerPiece("alice", {
      stream: LAPTOP,
      sequence: 1,
      piece: 2,
      pieces: 2,
      report: report(LAPTOP, 1),
      own: true,
      request: MINE,
    });
    vi.advanceTimersByTime(PAST);
    expect(kinds(w)).toContain("answer-incomplete");
  });

  it("an answer given up for the bound (LOS-22)", () => {
    const w = world();
    w.lacking.add(1);
    for (let sequence = 1; sequence <= OPEN_TRANSFERS_PER_MEMBER + 1; sequence++) {
      w.detector.heardAnswerPiece("alice", {
        stream: LAPTOP,
        sequence,
        piece: 1,
        pieces: 2,
        report: null,
        own: true,
        request: `${sequence}`.padStart(16, "0"),
      });
    }
    expect(w.detector.incompleteAnswers()).toHaveLength(OPEN_TRANSFERS_PER_MEMBER);
    vi.advanceTimersByTime(PAST);
    expect(w.detector.suspicions().map((s) => s.key)).toContain(`answer:alice:${LAPTOP}:1`);
  });

  it("a truncated history (LOS-19)", () => {
    const w = world();
    const truncated = Date.now();
    w.detector = new LossDetector({
      absenceMs: ABSENCE_MS,
      creatorMemberId: () => w.creator,
      policy: () => w.policy,
      pendingGapClients: () => [],
      lacksUpdatesOf: () => false,
      controlClock: () => w.held,
      stateDigestWithin: () => w.stateDigest,
      controlDigest: () => w.controlDigest,
      truncatedSince: () => truncated,
      stream: () => STREAM,
    });
    vi.advanceTimersByTime(PAST);
    expect(kinds(w)).toStrictEqual(["history-truncated"]);
  });

  it("a control clock above this client's in a report of the creator (LOS-10)", () => {
    const w = world();
    w.held = [5, 1];
    w.detector.heardReport(
      "alice",
      report(LAPTOP, 1, "aaaaaaaaaaaaaaaa", 1, [6, 0], "dddddddddddddddd"),
    );
    w.detector.observe();
    vi.advanceTimersByTime(PAST);
    expect(kinds(w)).toStrictEqual(["control-behind"]);
  });
});
