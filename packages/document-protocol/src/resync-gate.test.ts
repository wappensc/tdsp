import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResyncGate } from "./resync-gate";

const T0 = 1_000_000;
const ASK = { expiryMs: 60_000, floorMs: 0, automatic: false };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ResyncGate", () => {
  it("lets the first request through and coalesces every further one while it is outstanding", () => {
    const gate = new ResyncGate();
    expect(gate.begin(ASK)).toEqual({ sent: true });
    for (let click = 0; click < 5; click += 1) {
      expect(gate.begin(ASK)).toEqual({ sent: false, reason: "in-flight" });
    }
    expect(gate.status().state).toBe("requested");
  });

  it("shares one slot between a manual and an automatic request", () => {
    const gate = new ResyncGate();
    expect(gate.begin({ ...ASK, automatic: true })).toEqual({ sent: true });
    expect(gate.begin({ ...ASK, automatic: false })).toEqual({ sent: false, reason: "in-flight" });
    expect(gate.status().automatic).toBe(true);
  });

  it("frees the slot when the request expires, and reports that nobody answered", () => {
    const gate = new ResyncGate();
    gate.begin(ASK);
    vi.advanceTimersByTime(59_999);
    expect(gate.status().state).toBe("requested");
    vi.advanceTimersByTime(1);
    expect(gate.status()).toMatchObject({ state: "idle", lastOutcome: "unanswered" });
    expect(gate.begin(ASK)).toEqual({ sent: true });
  });

  it("frees the slot when the request is answered, and says so", () => {
    const gate = new ResyncGate();
    gate.begin(ASK);
    gate.answered();
    expect(gate.status()).toMatchObject({ state: "idle", lastOutcome: "answered" });
    expect(gate.begin(ASK)).toEqual({ sent: true });
  });

  it("reports the expiry time so a button can say how long it will wait", () => {
    const gate = new ResyncGate();
    gate.begin(ASK);
    expect(gate.status()).toMatchObject({ requestedAt: T0, expiresAt: T0 + 60_000 });
  });

  it("holds a rate floor between requests, which neither an answer nor an expiry lifts", () => {
    const gate = new ResyncGate();
    const paced = { ...ASK, floorMs: 30_000 };
    gate.begin(paced);
    gate.answered();
    vi.advanceTimersByTime(29_999);
    expect(gate.begin(paced)).toEqual({ sent: false, reason: "rate-floor" });
    vi.advanceTimersByTime(1);
    expect(gate.begin(paced)).toEqual({ sent: true });
  });

  it("gives the slot and the floor back when the send failed: nothing went out", () => {
    const gate = new ResyncGate();
    const before = gate.lastRequestAt;
    gate.begin({ ...ASK, floorMs: 30_000 });
    gate.abort(before);
    expect(gate.status().state).toBe("idle");
    expect(gate.begin({ ...ASK, floorMs: 30_000 })).toEqual({ sent: true });
  });

  it("starts with no outcome to report", () => {
    expect(new ResyncGate().status()).toEqual({
      state: "idle",
      requestedAt: null,
      expiresAt: null,
      automatic: false,
      lastOutcome: null,
    });
  });
});
