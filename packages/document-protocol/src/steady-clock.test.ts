import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SteadyClock } from "./steady-clock";

/** The clock durations are measured on (SND-25, SPECIFICATION.md §1.6). */

const T0 = Date.parse("2026-10-28T10:00:00Z");
const HOUR = 3_600_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("SteadyClock (SND-25)", () => {
  it("reads the wall clock while it runs on, and follows a jump forward", () => {
    const clock = new SteadyClock();
    expect(clock.now()).toBe(T0);
    vi.advanceTimersByTime(1_000);
    expect(clock.now()).toBe(T0 + 1_000);
    vi.setSystemTime(Date.now() + HOUR);
    expect(clock.now()).toBe(T0 + 1_000 + HOUR);
  });

  it("goes on by the time measured where the wall clock jumped back, and then runs with it", () => {
    const clock = new SteadyClock();
    clock.now();
    vi.advanceTimersByTime(5_000);
    vi.setSystemTime(Date.now() - HOUR);
    expect(clock.now()).toBe(T0 + 5_000);
    vi.advanceTimersByTime(2_000);
    expect(clock.now()).toBe(T0 + 7_000);
    // A jump forward afterwards counts from where it stands.
    vi.setSystemTime(Date.now() + 10_000);
    expect(clock.now()).toBe(T0 + 17_000);
  });

  it("reports a time on the wall clock as it reads now: as far from now as it is", () => {
    const clock = new SteadyClock();
    const at = clock.now();
    expect(clock.toWall(at)).toBe(T0);
    expect(clock.toWall(null)).toBeNull();
    vi.setSystemTime(Date.now() - HOUR);
    expect(clock.toWall(at)).toBe(T0 - HOUR);
    expect(clock.toWall(at + 2_000) - Date.now()).toBe(2_000);
  });
});
