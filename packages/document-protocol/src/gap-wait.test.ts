import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerDelayMs, answerWindowMs } from "./answer-turn";
import { LossDetector, MAX_GAP_TRIES } from "./loss-detector";
import { resolveSyncPolicy } from "./sync-policy";

/**
 * A gap's wait and its place (SPECIFICATION.md LOS-6, LOS-26, RSY-22): a gap's wait is LOS-1's multiple
 * without its place; only from when it passed is the gap about to be asked for, and only then may
 * another's request to all stand in for its first try while it waits for its place. Before, the gap
 * may still be closed by what is on its way (LOS-1), and nothing is let go for it. A resting gap a
 * frame woke waits so from the wake; a further try after one let go for another's request, from when
 * that one expired.
 */

const T0 = 1_000_000;
/** This client's own stream (LOS-13), from which the place of each gap's first try derives (LOS-6). */
const STREAM = "5e5e5e5e5e5e5e5e";
/** A message takes 10 s: LOS-1's wait is 10 s, a gap's wait twice that, and its place within the answer window. */
const LATENCY = 10_000;

/** A detector of a client that waits on the updates of CRDT client 42: a pending gap (LOS-2). */
function detector(): LossDetector {
  return new LossDetector({
    absenceMs: 600_000,
    creatorMemberId: () => "alice",
    policy: () => resolveSyncPolicy({ expectedLatencyMs: LATENCY, maxIntervalMs: 60_000 }),
    pendingGapClients: () => [42],
    lacksUpdatesOf: () => false,
    clientsAhead: () => new Map(),
    controlClock: () => [0, 0],
    stateDigestWithin: () => "aaaaaaaaaaaaaaaa",
    controlDigest: () => "cccccccccccccccc",
    stream: () => STREAM,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a gap waits for its place only once its wait has passed (LOS-6, RSY-22)", () => {
  it("before the wait it is not about to be asked for; from the wait to its place it is; at its place it is due", () => {
    const d = detector();
    d.observe();
    const place = answerDelayMs("content:42", STREAM, answerWindowMs(LATENCY));
    expect(place).toBeGreaterThan(0);
    const expiry = 20_000;
    vi.advanceTimersByTime(1_000);
    expect(d.awaitingSlot(Date.now(), expiry)).toStrictEqual([]);
    vi.advanceTimersByTime(18_999);
    expect(d.awaitingSlot(Date.now(), expiry)).toStrictEqual([]);
    vi.advanceTimersByTime(1);
    expect(d.awaitingSlot(Date.now(), expiry)).toStrictEqual(["content:42"]);
    expect(d.dueGaps(Date.now(), expiry)).toStrictEqual([]);
    vi.advanceTimersByTime(place);
    expect(d.awaitingSlot(Date.now(), expiry)).toStrictEqual([]);
    expect(d.dueGaps(Date.now(), expiry)).toStrictEqual(["content:42"]);
  });
});

describe("a woken gap waits for its place only once its wait after the wake has passed (LOS-26, LOS-6, RSY-22)", () => {
  it("woken by its writer's frame: not about to be asked for before the wait; from the wait to its place it is; at its place it is due", () => {
    const d = detector();
    d.observe();
    const expiry = 20_000;
    // Three tries, the waits doubling, then it rests.
    for (let tries = 0; tries < MAX_GAP_TRIES; tries++) {
      vi.advanceTimersByTime(10 * 60_000);
      expect(d.dueGaps(Date.now(), expiry)).toStrictEqual(["content:42"]);
      d.tried(Date.now());
    }
    vi.advanceTimersByTime(10 * 60_000);
    expect(d.dueGaps(Date.now(), expiry)).toStrictEqual([]);
    expect(d.awaitingSlot(Date.now(), expiry)).toStrictEqual([]);
    d.learnClient(42, "carol");
    d.heardFrom("carol");
    const place = answerDelayMs("content:42", STREAM, answerWindowMs(LATENCY));
    vi.advanceTimersByTime(1_000);
    expect(d.awaitingSlot(Date.now(), expiry)).toStrictEqual([]);
    vi.advanceTimersByTime(18_999);
    expect(d.awaitingSlot(Date.now(), expiry)).toStrictEqual([]);
    vi.advanceTimersByTime(1);
    expect(d.awaitingSlot(Date.now(), expiry)).toStrictEqual(["content:42"]);
    expect(d.dueGaps(Date.now(), expiry)).toStrictEqual([]);
    vi.advanceTimersByTime(place);
    expect(d.awaitingSlot(Date.now(), expiry)).toStrictEqual([]);
    expect(d.dueGaps(Date.now(), expiry)).toStrictEqual(["content:42"]);
  });
});

describe("a further try after one let go for another's request waits for its place once that one expired (LOS-6, RSY-22)", () => {
  const expiry = 20_000;
  const place = answerDelayMs("content:42", STREAM, answerWindowMs(LATENCY));

  /** A detector whose gap let its first try go for another's request, heard now, whose wait ends `after` ms from now. */
  function adopted(after: number): LossDetector {
    const d = detector();
    d.observe();
    vi.advanceTimersByTime(20_000);
    expect(d.awaitingSlot(Date.now(), expiry)).toStrictEqual(["content:42"]);
    d.tried(Date.now(), ["content:42"], Date.now() + after);
    return d;
  }

  it("the other's request waits longer than the doubled wait: about to be made once it expired, due in its place after that", () => {
    expect(place).toBeGreaterThan(1);
    // A request to all waits 80 s; the doubled wait from the try, 40 s, passed before.
    const d = adopted(80_000);
    vi.advanceTimersByTime(79_999);
    expect(d.awaitingSlot(Date.now(), expiry)).toStrictEqual([]);
    expect(d.dueGaps(Date.now(), expiry)).toStrictEqual([]);
    vi.advanceTimersByTime(1);
    expect(d.awaitingSlot(Date.now(), expiry)).toStrictEqual(["content:42"]);
    expect(d.dueGaps(Date.now(), expiry)).toStrictEqual([]);
    vi.advanceTimersByTime(place - 1);
    expect(d.awaitingSlot(Date.now(), expiry)).toStrictEqual(["content:42"]);
    expect(d.dueGaps(Date.now(), expiry)).toStrictEqual([]);
    vi.advanceTimersByTime(1);
    expect(d.awaitingSlot(Date.now(), expiry)).toStrictEqual([]);
    expect(d.dueGaps(Date.now(), expiry)).toStrictEqual(["content:42"]);
    // A request of its own then: the try after it is due once the doubled wait passed, without a place.
    d.tried(Date.now());
    vi.advanceTimersByTime(4 * expiry - 1);
    expect(d.dueGaps(Date.now(), expiry)).toStrictEqual([]);
    expect(d.awaitingSlot(Date.now(), expiry)).toStrictEqual([]);
    vi.advanceTimersByTime(1);
    expect(d.dueGaps(Date.now(), expiry)).toStrictEqual(["content:42"]);
  });

  it("the doubled wait is the longer: about to be made once it passed, due in its place after that", () => {
    const d = adopted(10_000);
    vi.advanceTimersByTime(2 * expiry - 1);
    expect(d.awaitingSlot(Date.now(), expiry)).toStrictEqual([]);
    vi.advanceTimersByTime(1);
    expect(d.awaitingSlot(Date.now(), expiry)).toStrictEqual(["content:42"]);
    expect(d.dueGaps(Date.now(), expiry)).toStrictEqual([]);
    vi.advanceTimersByTime(place);
    expect(d.awaitingSlot(Date.now(), expiry)).toStrictEqual([]);
    expect(d.dueGaps(Date.now(), expiry)).toStrictEqual(["content:42"]);
  });
});
