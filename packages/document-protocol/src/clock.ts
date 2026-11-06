/**
 * The clock of a decision on control state (SPECIFICATION.md CTL-21, CTL-45): a pair `[ms, counter]`
 * of integers, `ms` from 0 to 2^48 − 1 and `counter` from 0 to 65 535, ordered by `ms` and then
 * `counter`. Two integers, since one 64-bit number would not be exact in every JSON parser.
 *
 * A device of the creator keeps a clock of its own. It raises it to its control clock — the greatest
 * clock it holds — after every merge and restore, never beyond its wall clock plus the span, 24
 * hours, and gives every decision a clock above its own and above the register it holds on the
 * decision's target:
 *
 * - **Above the register of its target**: merging is per target (CTL-22), so this alone makes a
 *   decision hold over everything its device knew of that target, however far the devices' wall
 *   clocks disagree — and over a register far in the future, without the own clock following it
 *   there.
 * - **Above its own clock**, which follows what the device merged: a decision is ordered after
 *   what its device knew on any target, where the span capped nothing, and every decision of a
 *   device lies above its previous one.
 * - **The span** keeps one register far ahead — from a device of the creator whose wall clock ran
 *   far ahead — from dragging the clocks of all of the creator's devices along.
 *
 * Nothing here judges a register by a receiver's time: a receiver that set aside registers ahead of
 * its own time would hold what another receiver does not, for good. These functions only form
 * clocks for the device that decides.
 *
 * Pure: the caller passes the wall clock.
 */

/** A clock: milliseconds since 1970-01-01 UTC, or a time a clock was raised to, and a counter. */
export type Clock = readonly [ms: number, counter: number];

/** The greatest `ms` of a clock: 2^48 − 1, exact in every JSON parser. */
export const MAX_CLOCK_MS = 2 ** 48 - 1;

/** The greatest `counter` of a clock. */
export const MAX_CLOCK_COUNTER = 65_535;

/** The least clock, the control clock of a state without registers. */
export const ZERO_CLOCK: Clock = Object.freeze([0, 0] as const);

/**
 * How far its own clock may run ahead of a device's wall clock (SPECIFICATION.md CTL-45,
 * Appendix B): a day, past every plausible error of a wall clock, short of dragging decisions far
 * into the future.
 */
export const CLOCK_SPAN_MS = 24 * 60 * 60 * 1000;

/** Whether `value` is a clock: an array of exactly two integers within their ranges. */
export function isClock(value: unknown): value is Clock {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    inRange(value[0], MAX_CLOCK_MS) &&
    inRange(value[1], MAX_CLOCK_COUNTER)
  );
}

function inRange(value: unknown, max: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
}

/** Negative when `a` is the lesser clock, positive when the greater, 0 when they are equal. */
export function compareClocks(a: Clock, b: Clock): number {
  if (a[0] !== b[0]) {
    return a[0] < b[0] ? -1 : 1;
  }
  return a[1] === b[1] ? 0 : a[1] < b[1] ? -1 : 1;
}

/** The greater of two clocks. */
export function maxClock(a: Clock, b: Clock): Clock {
  return compareClocks(a, b) >= 0 ? a : b;
}

/**
 * The least clock above `clock`: `counter` one higher, or at 65 535 `ms` one higher and `counter`
 * 0; `undefined` at the end of the range, above which no decision can be ordered.
 */
export function nextClock(clock: Clock): Clock | undefined {
  if (clock[1] < MAX_CLOCK_COUNTER) {
    return [clock[0], clock[1] + 1];
  }
  if (clock[0] < MAX_CLOCK_MS) {
    return [clock[0] + 1, 0];
  }
  return undefined;
}

/**
 * The wall clock as a clock's `ms`: whole milliseconds, within the range. Before 1970 or after
 * the range's end (the year 10889) no wall clock is right, and a clock formed from it must still
 * be one.
 */
function wallMs(now: number): number {
  if (!Number.isFinite(now)) {
    throw new RangeError(`not a wall clock: ${now}`);
  }
  return Math.min(Math.max(Math.floor(now), 0), MAX_CLOCK_MS);
}

/**
 * The greatest clock not beyond the wall clock plus `span`: what merging may raise a device's own
 * clock to at most.
 */
export function clockCap(now: number, span: number = CLOCK_SPAN_MS): Clock {
  return [Math.min(wallMs(now) + Math.max(span, 0), MAX_CLOCK_MS), MAX_CLOCK_COUNTER];
}

/**
 * A device's own clock after a merge or a restore, `clock` its control clock then
 * (CTL-45): raised to it, but not beyond the wall clock plus the span, and never lowered.
 */
export function raiseClock(
  own: Clock,
  clock: Clock,
  now: number,
  span: number = CLOCK_SPAN_MS,
): Clock {
  const cap = clockCap(now, span);
  return maxClock(own, compareClocks(clock, cap) > 0 ? cap : clock);
}

/** A decision's clock, and its device's own clock after it. */
export interface DecisionClock {
  readonly clock: Clock;
  readonly own: Clock;
}

/**
 * The clock of a decision on one target (CTL-21): the greatest of `[now, 0]`, the next clock above
 * the device's own, and the next clock above each clock in `onTarget` — the register the device
 * holds on that target. `undefined` when one of them cannot be
 * formed, at the end of the range: then no clock orders the decision above what it must hold over,
 * and the device refuses it.
 *
 * The device's own clock after the decision is the decision's base — `[now, 0]` or the next above
 * its own, so that it grows with every decision — raised to the decision's clock within the span:
 * after a decision above a register far ahead only that target lies beyond the span, while the own
 * clock, and with it the next decision on another target, goes no further than the span.
 */
export function clockForDecision(
  own: Clock,
  now: number,
  onTarget: readonly Clock[],
  span: number = CLOCK_SPAN_MS,
): DecisionClock | undefined {
  const afterOwn = nextClock(own);
  if (afterOwn === undefined) {
    return undefined;
  }
  const base = maxClock([wallMs(now), 0], afterOwn);
  let clock = base;
  for (const held of onTarget) {
    const after = nextClock(held);
    if (after === undefined) {
      return undefined;
    }
    clock = maxClock(clock, after);
  }
  return { clock, own: maxClock(base, raiseClock(own, clock, now, span)) };
}
