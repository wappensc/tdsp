import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import {
  CLOCK_SPAN_MS,
  type Clock,
  clockCap,
  clockForDecision,
  compareClocks,
  isClock,
  MAX_CLOCK_COUNTER,
  MAX_CLOCK_MS,
  maxClock,
  nextClock,
  raiseClock,
  ZERO_CLOCK,
} from "./clock";
import { canonicalJson } from "./digest";

/**
 * The clock of a decision (CTL-21, CTL-45):
 * a pair of integers in their ranges, ordered by `ms` and then `counter`; a decision's clock above
 * the device's own and above every register of its target; the own clock raised to what it merges,
 * but never beyond the wall clock plus a span.
 */

const NOW = Date.UTC(2026, 9, 26, 10, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const YEAR = 365 * DAY;

describe("a clock", () => {
  it("is an array of exactly two integers in their ranges", () => {
    expect(isClock([0, 0])).toBe(true);
    expect(isClock([NOW, 7])).toBe(true);
    expect(isClock([MAX_CLOCK_MS, MAX_CLOCK_COUNTER])).toBe(true);
    for (const bad of [
      [MAX_CLOCK_MS + 1, 0],
      [0, MAX_CLOCK_COUNTER + 1],
      [-1, 0],
      [0, -1],
      [1.5, 0],
      [0, 0.5],
      ["1", 0],
      [0],
      [0, 0, 0],
      { 0: 0, 1: 0, length: 2 },
      NOW,
      null,
      [Number.NaN, 0],
      [Number.POSITIVE_INFINITY, 0],
    ]) {
      expect(isClock(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("orders by ms and then by counter", () => {
    expect(compareClocks([1, 9], [2, 0])).toBeLessThan(0);
    expect(compareClocks([2, 1], [2, 0])).toBeGreaterThan(0);
    expect(compareClocks([2, 1], [2, 1])).toBe(0);
    expect(maxClock([2, 0], [1, 9])).toEqual([2, 0]);
    expect(maxClock([2, 0], [2, 3])).toEqual([2, 3]);
  });

  it("counts on past 65 535 into the next millisecond, and ends at 2^48 − 1, 65 535", () => {
    expect(nextClock([NOW, 4])).toEqual([NOW, 5]);
    expect(nextClock([NOW, MAX_CLOCK_COUNTER])).toEqual([NOW + 1, 0]);
    expect(nextClock([MAX_CLOCK_MS, MAX_CLOCK_COUNTER - 1])).toEqual([
      MAX_CLOCK_MS,
      MAX_CLOCK_COUNTER,
    ]);
    expect(nextClock([MAX_CLOCK_MS, MAX_CLOCK_COUNTER])).toBeUndefined();
  });

  it("is written in JSON as two exact integers", () => {
    const clock: Clock = [MAX_CLOCK_MS, MAX_CLOCK_COUNTER];
    expect(canonicalJson(clock)).toBe("[281474976710655,65535]");
    expect(JSON.parse(canonicalJson(clock))).toEqual([MAX_CLOCK_MS, MAX_CLOCK_COUNTER]);
    expect(canonicalJson(ZERO_CLOCK)).toBe("[0,0]");
  });
});

describe("the own clock of a device of the creator", () => {
  it("rises to a clock it merges, never falls, and stops at the wall clock plus the span", () => {
    const own: Clock = [NOW, 3];
    expect(raiseClock(own, [NOW + 5_000, 0], NOW)).toEqual([NOW + 5_000, 0]);
    expect(raiseClock(own, [NOW - 5_000, 9], NOW)).toEqual(own);
    expect(raiseClock(own, [NOW + CLOCK_SPAN_MS, 12], NOW)).toEqual([NOW + CLOCK_SPAN_MS, 12]);
    expect(raiseClock(own, [NOW + YEAR, 0], NOW)).toEqual([NOW + CLOCK_SPAN_MS, MAX_CLOCK_COUNTER]);
    expect(raiseClock(own, [NOW + YEAR, 0], NOW)).toEqual(clockCap(NOW));
    // Already beyond the cap (its wall clock went back): it stays where it is.
    const ahead: Clock = [NOW + 2 * DAY, 0];
    expect(raiseClock(ahead, [NOW + YEAR, 0], NOW)).toEqual(ahead);
  });

  it("caps at the end of the range, whatever the span", () => {
    expect(clockCap(MAX_CLOCK_MS - 10)).toEqual([MAX_CLOCK_MS, MAX_CLOCK_COUNTER]);
    expect(clockCap(NOW, 0)).toEqual([NOW, MAX_CLOCK_COUNTER]);
  });
});

describe("the clock of a decision", () => {
  it("is the wall clock when nothing it knows is later", () => {
    const decided = clockForDecision([NOW - 60_000, 2], NOW, [[NOW - 1_000, 0]]);
    expect(decided).toEqual({ clock: [NOW, 0], own: [NOW, 0] });
  });

  it("lies above its own clock, also when the wall clock lags behind it", () => {
    const decided = clockForDecision([NOW + 60_000, 2], NOW, []);
    expect(decided).toEqual({ clock: [NOW + 60_000, 3], own: [NOW + 60_000, 3] });
  });

  it("lies above every register of its target, and the own clock follows it only within the span", () => {
    const far: Clock = [NOW + YEAR, 0];
    const decided = clockForDecision([NOW - 60_000, 0], NOW, [[NOW - 1_000, 0], far]);
    expect(decided?.clock).toEqual([NOW + YEAR, 1]);
    expect(decided?.own).toEqual(clockCap(NOW));
    // The next decision on another target lies within the span, not a year ahead.
    assert(decided);
    const next = clockForDecision(decided.own, NOW, []);
    assert(next);
    expect(next.clock[0] - NOW).toBeLessThanOrEqual(CLOCK_SPAN_MS + 1);
    // Every decision raises the own clock, also at the cap.
    expect(compareClocks(next.own, decided.own)).toBeGreaterThan(0);
  });

  it("counts on within one millisecond", () => {
    const first = clockForDecision([NOW, 0], NOW, []);
    assert(first);
    const second = clockForDecision(first.own, NOW, []);
    assert(second);
    expect(first.clock).toEqual([NOW, 1]);
    expect(second.clock).toEqual([NOW, 2]);
  });

  it("cannot be formed above a register at the end of the range: the decision is refused", () => {
    expect(clockForDecision([NOW, 0], NOW, [[MAX_CLOCK_MS, MAX_CLOCK_COUNTER]])).toBeUndefined();
    expect(clockForDecision([MAX_CLOCK_MS, MAX_CLOCK_COUNTER], NOW, [])).toBeUndefined();
    // One below the end still orders one more decision.
    expect(clockForDecision([NOW, 0], NOW, [[MAX_CLOCK_MS, MAX_CLOCK_COUNTER - 1]])?.clock).toEqual(
      [MAX_CLOCK_MS, MAX_CLOCK_COUNTER],
    );
  });

  it("takes a wall clock outside the range as its nearest end, and refuses one that is not a number", () => {
    expect(clockForDecision(ZERO_CLOCK, -5, [])?.clock).toEqual([0, 1]);
    expect(clockForDecision(ZERO_CLOCK, NOW + 0.7, [])?.clock).toEqual([NOW, 0]);
    expect(() => clockForDecision(ZERO_CLOCK, Number.NaN, [])).toThrow(RangeError);
  });
});
