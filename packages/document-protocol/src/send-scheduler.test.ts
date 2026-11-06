import {
  applyUpdate,
  createDocument,
  encodeStateVector,
  encodeUpdate,
  ensureParagraph,
  getFragment,
  getPlainText,
  insertPlainText,
  observeUpdates,
  type ReconciledDocument,
  transact,
} from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADAPT_DECAY_STREAK,
  ADAPT_GROWTH,
  REPORT_AFTER_MS,
  RETRY_AFTER_MAX_MS,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  type ReportCarry,
  type SendFailureClass,
  SendScheduler,
} from "./send-scheduler";
import { resolveSyncPolicy, type SyncPolicy } from "./sync-policy";

// The scheduler is exercised against a fake clock and a fake `send`, with real Yjs
// updates so "every change arrives, once merged, in the right document" is checked
// by applying what was sent to a second document — not by counting calls only.

const T0 = 1_000_000;

// The scheduler never looks inside a frame; these tests stand a slice of bytes in for one, as text.
const toFrame = (bytes: Uint8Array): string => Array.from(bytes).join(",");
const fromFrame = (frame: string): Uint8Array =>
  Uint8Array.from(
    frame
      .split(",")
      .filter((part) => part !== "")
      .map(Number),
  );

// Every writer and every receiver starts from this one seeded paragraph, the way a
// real document does (`DocumentEngine.create()` seeds it before anyone can see it).
const SEED = (() => {
  const doc = createDocument();
  transact(doc, () => ensureParagraph(getFragment(doc)));
  return encodeUpdate(doc);
})();

function seededDocument(): ReconciledDocument {
  const doc = createDocument();
  applyUpdate(doc, SEED);
  return doc;
}

/** A writer producing real, causally ordered updates, one character each. */
function typist() {
  const doc = seededDocument();
  const captured: Uint8Array[] = [];
  observeUpdates(doc, (update) => captured.push(update));
  let count = 0;
  return {
    doc,
    /** Inserts a run of `size` characters as ONE update, the way a paste does, and returns it. */
    paste(size: number): Uint8Array {
      transact(doc, () => insertPlainText(getFragment(doc), count, "P".repeat(size)));
      count += size;
      const update = captured.at(-1);
      if (!update) {
        throw new Error("no update produced");
      }
      return update;
    },
    /** Types one character and returns the update it produced. */
    type(char = "x"): Uint8Array {
      transact(doc, () => insertPlainText(getFragment(doc), count, char));
      count += 1;
      const update = captured.at(-1);
      if (!update) {
        throw new Error("no update produced");
      }
      return update;
    },
  };
}

/** What a receiver ends up with after applying everything a fake transport was sent. */
function receive(sent: readonly Uint8Array[]): string {
  const doc = seededDocument();
  for (const update of sent) {
    applyUpdate(doc, update);
  }
  return getPlainText(getFragment(doc));
}

interface Harness {
  scheduler: SendScheduler;
  /** The updates that reached the transport (successful sends only). */
  sent: Uint8Array[];
  /** When each attempt, failed or not, was made. */
  attemptTimes: number[];
  dropped: unknown[];
  readonly statusChanges: number;
  /** Makes the next `send` calls fail with these errors, in order; then they succeed. */
  failWith: (...errors: unknown[]) => void;
  type: (char?: string, chars?: number) => void;
}

function harness(options: {
  quietMs?: number;
  policy?: Partial<SyncPolicy>;
  classify?: (error: unknown) => SendFailureClass;
}): Harness {
  const sent: Uint8Array[] = [];
  const attemptTimes: number[] = [];
  const dropped: unknown[] = [];
  const failures: unknown[] = [];
  const writer = typist();
  const state = { statusChanges: 0 };
  const scheduler = new SendScheduler({
    quietMs: options.quietMs ?? 500,
    policy: resolveSyncPolicy(options.policy),
    send: async (update) => {
      attemptTimes.push(Date.now());
      const failure = failures.shift();
      if (failure !== undefined) {
        throw failure;
      }
      sent.push(update);
    },
    classify: options.classify ?? (() => ({ retryable: true })),
    onDropped: (error) => dropped.push(error),
    onStatusChange: () => {
      state.statusChanges += 1;
    },
  });
  return {
    scheduler,
    sent,
    attemptTimes,
    dropped,
    get statusChanges() {
      return state.statusChanges;
    },
    failWith: (...errors) => failures.push(...errors),
    type: (char = "x", chars = 1) => scheduler.enqueue(writer.type(char), chars),
  };
}

/** The gaps between consecutive attempts. */
function gaps(times: readonly number[]): number[] {
  return times.slice(1).map((time, i) => time - (times[i] as number));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SendScheduler timing", () => {
  it("merges only updates that change the same top-level types (LAY-7)", async () => {
    const sent: { update: Uint8Array; roots: ReadonlySet<string> }[] = [];
    const writer = typist();
    const scheduler = new SendScheduler({
      quietMs: 500,
      policy: resolveSyncPolicy({}),
      send: async (update, roots) => {
        sent.push({ update, roots });
      },
      classify: () => ({ retryable: true }),
      onDropped: () => {},
    });
    const layer = new Set(["com.example.comments/1"]);
    scheduler.enqueue(writer.type("a"), 1, new Set(["content"]));
    scheduler.enqueue(writer.type("b"), 1, new Set(["content"]));
    scheduler.enqueue(writer.type("c"), 1, layer);
    scheduler.enqueue(writer.type("d"), 1, new Set(["content"]));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent.map((message) => [...message.roots])).toEqual([
      ["content"],
      ["com.example.comments/1"],
      ["content"],
    ]);
    expect(receive(sent.map((message) => message.update))).toBe("abcd");
  });

  it("sends after the quiet time, and merges everything queued into one message", async () => {
    const h = harness({ quietMs: 500 });
    h.type("a");
    h.type("b");
    h.type("c");
    await vi.advanceTimersByTimeAsync(499);
    expect(h.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sent).toHaveLength(1);
    expect(receive(h.sent)).toBe("abc");
  });

  it("with no quiet time sends inside the edit that caused it", () => {
    const h = harness({ quietMs: 0 });
    h.type("a");
    expect(h.attemptTimes).toHaveLength(1);
    h.type("b");
    expect(h.attemptTimes).toHaveLength(2);
  });

  it("holds a second message back until the floor has passed, and merges what arrives meanwhile", async () => {
    const h = harness({ quietMs: 500, policy: { minIntervalMs: 10_000 } });
    h.type("a");
    await vi.advanceTimersByTimeAsync(500);
    expect(h.sent).toHaveLength(1); // at t = 500

    h.type("b");
    await vi.advanceTimersByTimeAsync(5000); // the quiet time is long past, the floor is not
    h.type("c");
    await vi.advanceTimersByTimeAsync(4999);
    expect(h.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); // exactly 10 s after the first send
    expect(h.sent).toHaveLength(2);
    expect(gaps(h.attemptTimes)).toEqual([10_000]);
    expect(receive(h.sent)).toBe("abc");
  });

  it("the floor is measured from the last attempt, so a send that was refused for good still counts against it", async () => {
    const h = harness({
      quietMs: 0,
      policy: { minIntervalMs: 10_000 },
      classify: () => ({ retryable: false }),
    });
    h.failWith(new Error("rejected"));
    h.type("a"); // attempted at t0, dropped
    await vi.advanceTimersByTimeAsync(1000);
    h.type("b"); // the quiet time has long passed; only the floor holds it
    await vi.advanceTimersByTimeAsync(8999);
    expect(h.attemptTimes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(gaps(h.attemptTimes)).toEqual([10_000]);
  });

  it("sends after maxIntervalMs even while typing never pauses", async () => {
    const h = harness({ quietMs: 500, policy: { maxIntervalMs: 2000 } });
    // A keystroke every 200 ms: the quiet time never elapses.
    for (let i = 0; i < 9; i += 1) {
      h.type("k");
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(h.sent).toHaveLength(0);
    h.type("k");
    await vi.advanceTimersByTimeAsync(200);
    expect(h.sent).toHaveLength(1);
    expect((h.attemptTimes[0] as number) - T0).toBe(2000); // measured from the oldest pending edit
  });

  it("does not send fewer than minChars at a typing pause, only when maxIntervalMs forces it", async () => {
    const h = harness({ quietMs: 500, policy: { minChars: 5, maxIntervalMs: 20_000 } });
    h.type("a");
    h.type("b");
    await vi.advanceTimersByTimeAsync(19_999);
    expect(h.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sent).toHaveLength(1);
  });

  it("sends at the typing pause once minChars have accumulated", async () => {
    const h = harness({ quietMs: 500, policy: { minChars: 3, maxIntervalMs: 20_000 } });
    h.type("a");
    h.type("b");
    h.type("c");
    await vi.advanceTimersByTimeAsync(500);
    expect(h.sent).toHaveLength(1);
  });

  it("sends as soon as maxChars is reached, without waiting for the quiet time", async () => {
    const h = harness({ quietMs: 5000, policy: { maxChars: 100 } });
    h.type("a", 60);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.sent).toHaveLength(0);
    h.type("b", 60); // 120 pending now
    expect(h.sent).toHaveLength(1);
    expect(receive(h.sent)).toBe("ab");
  });

  it("maxChars still respects the floor: a big paste waits for it and goes out as one message", async () => {
    const h = harness({ quietMs: 500, policy: { minIntervalMs: 10_000, maxChars: 100 } });
    h.type("a");
    await vi.advanceTimersByTimeAsync(500);
    expect(h.sent).toHaveLength(1);
    h.type("P", 5000);
    await vi.advanceTimersByTimeAsync(9000);
    expect(h.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.sent).toHaveLength(2);
    expect(receive(h.sent)).toBe("aP");
  });
});

describe("SendScheduler retry", () => {
  it("keeps a change whose send failed and delivers it on the retry", async () => {
    const h = harness({ quietMs: 500 });
    h.failWith(new Error("smtp 450 try later"));
    h.type("a");
    await vi.advanceTimersByTimeAsync(500);
    expect(h.attemptTimes).toHaveLength(1);
    expect(h.sent).toHaveLength(0);
    expect(h.scheduler.hasPending).toBe(true); // kept, not dropped
    expect(h.scheduler.status.state).toBe("retrying");
    expect(h.scheduler.status.failures).toBe(1);
    expect(h.scheduler.status.lastError).toBe("smtp 450 try later");
    expect(h.dropped).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
    expect(h.sent).toHaveLength(1);
    expect(receive(h.sent)).toBe("a");
    expect(h.scheduler.hasPending).toBe(false);
    expect(h.scheduler.status.state).toBe("idle");
    expect(h.scheduler.status.lastError).toBeNull();
  });

  it("merges edits made while retrying into the retried batch, so nothing is lost or reordered", async () => {
    const h = harness({ quietMs: 500 });
    h.failWith(new Error("boom"), new Error("boom"));
    h.type("a");
    await vi.advanceTimersByTimeAsync(500); // fails
    h.type("b");
    h.type("c");
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS); // fails again
    h.type("d");
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS * 2);
    expect(h.sent).toHaveLength(1); // one message with everything
    expect(receive(h.sent)).toBe("abcd");
  });

  it("does not send new edits past a failed batch while it is backing off", async () => {
    const h = harness({ quietMs: 0 });
    h.failWith(new Error("boom"));
    h.type("a"); // fails at once
    await vi.advanceTimersByTimeAsync(0);
    h.type("b"); // would go out at once if nothing were failing
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS - 1);
    expect(h.attemptTimes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.attemptTimes).toHaveLength(2);
    expect(receive(h.sent)).toBe("ab");
  });

  it("backs off exponentially, up to the cap", async () => {
    const h = harness({ quietMs: 0 });
    h.failWith(...Array.from({ length: 30 }, () => new Error("down")));
    h.type("a");
    await vi.advanceTimersByTimeAsync(20_000_000);
    const waits = gaps(h.attemptTimes);
    expect(waits.slice(0, 5)).toEqual([1000, 2000, 4000, 8000, 16_000]);
    expect(Math.max(...waits)).toBe(RETRY_MAX_MS);
    expect(waits.at(-1)).toBe(RETRY_MAX_MS);
    expect(h.sent).toHaveLength(1); // and it does get through in the end
  });

  it("caps the back-off at maxIntervalMs when there is one", async () => {
    const h = harness({ quietMs: 0, policy: { maxIntervalMs: 5000 } });
    h.failWith(...Array.from({ length: 10 }, () => new Error("down")));
    h.type("a");
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(gaps(h.attemptTimes).slice(0, 5)).toEqual([1000, 2000, 4000, 5000, 5000]);
    expect(Math.max(...gaps(h.attemptTimes))).toBe(5000);
  });

  it("resets the back-off after a success", async () => {
    const h = harness({ quietMs: 0 });
    h.failWith(new Error("down"), new Error("down"));
    h.type("a");
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS * 3); // fails twice, then succeeds
    expect(h.sent).toHaveLength(1);
    h.failWith(new Error("down"));
    h.type("b");
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
    expect(gaps(h.attemptTimes).at(-1)).toBe(RETRY_BASE_MS); // 1 s again, not 4 s
  });

  it("drops a change whose failure is permanent, reports it once, and never retries it", async () => {
    const h = harness({ quietMs: 0, classify: () => ({ retryable: false }) });
    const refusal = new Error("too large");
    h.failWith(refusal);
    h.type("a");
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 2);
    expect(h.attemptTimes).toHaveLength(1);
    expect(h.dropped).toEqual([refusal]);
    expect(h.scheduler.hasPending).toBe(false);
    expect(h.scheduler.status.state).toBe("idle");
  });

  it("a permanent failure drops only the failed change, not what was queued behind it", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent: Uint8Array[] = [];
    const dropped: unknown[] = [];
    const writer = typist();
    let first = true;
    const scheduler = new SendScheduler({
      quietMs: 0,
      policy: resolveSyncPolicy({ minIntervalMs: 1000 }),
      send: async (update) => {
        if (first) {
          first = false;
          await gate; // in flight while the second edit queues behind it
          throw new Error("permanent");
        }
        sent.push(update);
      },
      classify: () => ({ retryable: false }),
      onDropped: (error) => dropped.push(error),
    });
    scheduler.enqueue(writer.type("a"), 1);
    scheduler.enqueue(writer.type("b"), 1);
    expect(scheduler.hasPending).toBe(true);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(dropped).toHaveLength(1);
    expect(sent).toHaveLength(1); // "b" still went out
    expect(scheduler.hasPending).toBe(false);
  });

  it("keeps what was queued while the failed send was still in flight, and sends it with the retry", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent: Uint8Array[] = [];
    const writer = typist();
    let first = true;
    const scheduler = new SendScheduler({
      quietMs: 0,
      policy: resolveSyncPolicy({ minIntervalMs: 1000 }),
      send: async (update) => {
        if (first) {
          first = false;
          await gate; // in flight while the second edit queues behind it
          throw new Error("transient");
        }
        sent.push(update);
      },
      classify: () => ({ retryable: true }),
      onDropped: () => {},
    });
    scheduler.enqueue(writer.type("a"), 1);
    scheduler.enqueue(writer.type("b"), 1);
    release();
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS * 2);
    expect(sent).toHaveLength(1); // one message, with both
    expect(receive(sent)).toBe("ab");
  });

  it("honours the provider's own retryAfterMs when it is longer than the back-off", async () => {
    const h = harness({ quietMs: 0, classify: () => ({ retryable: true, retryAfterMs: 45_000 }) });
    h.failWith(new Error("429"));
    h.type("a");
    await vi.advanceTimersByTimeAsync(44_999);
    expect(h.attemptTimes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.attemptTimes).toHaveLength(2);
  });

  it("never waits longer than RETRY_AFTER_MAX_MS whatever the provider asks", async () => {
    const h = harness({
      quietMs: 0,
      classify: () => ({ retryable: true, retryAfterMs: 10 * RETRY_AFTER_MAX_MS }),
    });
    h.failWith(new Error("429"));
    h.type("a");
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MAX_MS);
    expect(h.attemptTimes).toHaveLength(2);
  });
});

describe("SendScheduler: a refusal only the person can lift (SPECIFICATION.md TRN-20, TRN-22)", () => {
  const needsPerson = (): SendFailureClass => ({ retryable: true, needsPerson: true });

  it("keeps the change, says it waits for the person, and tries again only after the longest back-off", async () => {
    const h = harness({ quietMs: 0, classify: needsPerson });
    h.failWith(...Array.from({ length: 3 }, () => new Error("an identity to trust")));
    h.type("a");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.scheduler.status.state).toBe("needs-person");
    expect(h.scheduler.status.lastError).toBe("an identity to trust");
    expect(h.scheduler.hasPending).toBe(true);
    expect(h.dropped).toHaveLength(0);
    // No growing back-off that would offer the same refused message again and again: every
    // attempt waits the longest back-off.
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 4);
    expect(gaps(h.attemptTimes)).toEqual([RETRY_MAX_MS, RETRY_MAX_MS, RETRY_MAX_MS]);
    expect(receive(h.sent)).toBe("a");
    expect(h.scheduler.status.state).toBe("idle");
  });

  it("waits the policy's maxIntervalMs where that caps the back-off", async () => {
    const h = harness({ quietMs: 0, policy: { maxIntervalMs: 5000 }, classify: needsPerson });
    h.failWith(new Error("a device to confirm"), new Error("a device to confirm"));
    h.type("a");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(gaps(h.attemptTimes)).toEqual([5000, 5000]);
  });

  it("does not send a later edit past it, but merges it into the change it keeps", async () => {
    const h = harness({ quietMs: 0, classify: needsPerson });
    h.failWith(new Error("signed out"));
    h.type("a");
    await vi.advanceTimersByTimeAsync(0);
    h.type("b");
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS - 1);
    expect(h.attemptTimes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sent).toHaveLength(1);
    expect(receive(h.sent)).toBe("ab");
  });

  it("sends at once on flush(), once the person acted", async () => {
    const h = harness({ quietMs: 0, classify: needsPerson });
    h.failWith(new Error("an identity to trust"));
    h.type("a");
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.scheduler.status.state).toBe("needs-person");
    await h.scheduler.flush();
    expect(receive(h.sent)).toBe("a");
    expect(h.scheduler.status.state).toBe("idle");
    expect(h.attemptTimes).toEqual([T0, T0 + 1000]);
  });

  it("shows a failure of another kind once the person acted: a send at once after it that fails as unavailable is retried, not waiting for the person", async () => {
    const h = harness({
      quietMs: 0,
      classify: (error) =>
        String(error).includes("not now") ? { retryable: true } : needsPerson(),
    });
    h.failWith(new Error("an identity to trust"), new Error("not now"));
    h.type("a");
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.scheduler.status.state).toBe("needs-person");
    await h.scheduler.flush().catch(() => {});
    expect(h.attemptTimes).toEqual([T0, T0 + 1000]);
    expect(h.scheduler.status).toMatchObject({ state: "retrying", lastError: "not now" });
  });

  it("shows a failure of another kind once its wait ended: the next try that fails as unavailable is retried, not waiting for the person", async () => {
    const h = harness({
      quietMs: 0,
      classify: (error) =>
        String(error).includes("not now") ? { retryable: true } : needsPerson(),
    });
    h.failWith(new Error("an identity to trust"), new Error("not now"));
    h.type("a");
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS);
    expect(h.attemptTimes).toEqual([T0, T0 + RETRY_MAX_MS]);
    expect(h.scheduler.status).toMatchObject({ state: "retrying", lastError: "not now" });
  });

  it("holds back every other message too, as long", async () => {
    const h = harness({ quietMs: 0, classify: needsPerson });
    const submitted: number[] = [];
    await expect(
      h.scheduler.submit(async () => {
        throw new Error("no account");
      }),
    ).rejects.toThrow("no account");
    void h.scheduler.submit(async () => submitted.push(Date.now()));
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS - 1);
    expect(submitted).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(submitted).toEqual([T0 + RETRY_MAX_MS]);
  });
});

describe("SendScheduler adaptive spacing", () => {
  const rateLimited = (): SendFailureClass => ({ retryable: true, rateLimited: true });

  it("widens the spacing between sends after a rate-limit refusal", async () => {
    const h = harness({ quietMs: 0, classify: rateLimited });
    expect(h.scheduler.effectiveMinIntervalMs).toBe(0);
    h.failWith(new Error("429"));
    h.type("a"); // refused at t0
    await vi.advanceTimersByTimeAsync(0);
    expect(h.scheduler.effectiveMinIntervalMs).toBe(RETRY_BASE_MS * ADAPT_GROWTH);

    // The back-off alone would retry after 1 s; the learned floor makes it 1.5 s.
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS * ADAPT_GROWTH - 1);
    expect(h.attemptTimes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.attemptTimes).toHaveLength(2); // the retry, which succeeds

    h.type("b");
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS * ADAPT_GROWTH - 1);
    expect(h.attemptTimes).toHaveLength(2); // spaced by the learned floor too
    await vi.advanceTimersByTimeAsync(1);
    expect(h.attemptTimes).toHaveLength(3);
  });

  it("does not learn from a failure that is not a rate limit", async () => {
    const h = harness({ quietMs: 0, classify: () => ({ retryable: true }) });
    h.failWith(new Error("connection reset"));
    h.type("a");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.scheduler.effectiveMinIntervalMs).toBe(0);
  });

  it("grows with each refusal but never beyond the retry cap", async () => {
    const h = harness({ quietMs: 0, classify: rateLimited });
    h.failWith(...Array.from({ length: 40 }, () => new Error("429")));
    h.type("a");
    await vi.advanceTimersByTimeAsync(40 * RETRY_MAX_MS);
    expect(h.scheduler.effectiveMinIntervalMs).toBeLessThanOrEqual(RETRY_MAX_MS);
    expect(h.scheduler.effectiveMinIntervalMs).toBeGreaterThan(RETRY_BASE_MS * ADAPT_GROWTH);
  });

  it("relaxes again after a run of successful sends", async () => {
    const h = harness({ quietMs: 0, classify: rateLimited });
    h.failWith(new Error("429"), new Error("429"), new Error("429"));
    h.type("a");
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS);
    const widened = h.scheduler.effectiveMinIntervalMs;
    expect(widened).toBeGreaterThan(RETRY_BASE_MS * ADAPT_GROWTH);
    for (let i = 0; i < ADAPT_DECAY_STREAK * 6; i += 1) {
      h.type("z");
      await vi.advanceTimersByTimeAsync(widened + 1);
    }
    expect(h.scheduler.effectiveMinIntervalMs).toBeLessThan(widened);
    expect(h.scheduler.effectiveMinIntervalMs).toBe(0);
  });
});

describe("SendScheduler splitting a change larger than one message", () => {
  // A frame is the update plus this many header bytes, and a message carries at most this many.
  const HEADER = 20;
  const LIMIT = 200;
  /** What the spread tests type: "a", then forty more characters. */
  const TYPED = `a${Array.from({ length: 40 }, (_, i) => String.fromCharCode(98 + (i % 20))).join("")}`;

  /** A scheduler whose transport records every message it is asked to carry, and enforces the limit. */
  function limited(
    options: { minIntervalMs?: number; maxIntervalMs?: number; quietMs?: number } = {},
  ) {
    const messages: { kind: "update" | "frame"; bytes: Uint8Array; at: number }[] = [];
    const dropped: unknown[] = [];
    const failures: unknown[] = [];
    const writer = typist();
    let cutFails = false;
    const scheduler = new SendScheduler({
      quietMs: options.quietMs ?? 0,
      policy: resolveSyncPolicy(options),
      send: async (update) => {
        if (update.length + HEADER > LIMIT) {
          throw new Error(`the transport refuses ${update.length + HEADER} bytes`);
        }
        const failure = failures.shift();
        if (failure !== undefined) {
          throw failure;
        }
        messages.push({ kind: "update", bytes: update, at: Date.now() });
      },
      classify: () => ({ retryable: true }),
      onDropped: (error) => dropped.push(error),
      splitting: {
        maxBytes: LIMIT,
        frameSize: (update) => update.length + HEADER,
        // Slices of 50 bytes, tagged so the test can tell which update they came from.
        pieces: (update: Uint8Array) => {
          if (cutFails) {
            throw new Error("cannot be cut");
          }
          const slices: string[] = [];
          for (let at = 0; at < update.length; at += 50) {
            slices.push(toFrame(update.slice(at, at + 50)));
          }
          return slices;
        },
        sendFrame: async (frame) => {
          const failure = failures.shift();
          if (failure !== undefined) {
            throw failure;
          }
          messages.push({ kind: "frame", bytes: fromFrame(frame), at: Date.now() });
        },
      },
    });
    return {
      scheduler,
      messages,
      dropped,
      failWith: (...errors: unknown[]) => failures.push(...errors),
      breakCutting: () => {
        cutFails = true;
      },
      type: (char = "x", chars = 1) => scheduler.enqueue(writer.type(char), chars),
      /** One update that alone is `size` bytes: an inserted run of that many characters. */
      paste: (size: number) => scheduler.enqueue(writer.paste(size), size),
      writer,
    };
  }

  it("leaves a change that fits as one message, as before", async () => {
    const h = limited({ quietMs: 500 });
    for (let i = 0; i < 5; i += 1) {
      h.type("a");
    }
    await vi.advanceTimersByTimeAsync(500);
    expect(h.messages).toHaveLength(1);
  });

  it("spreads a change that does not fit over several messages, each within the limit, in order", async () => {
    const h = limited({ minIntervalMs: 1000 });
    // Enough typed characters that their merged update is over the 180 bytes a message has room for.
    h.type("a"); // goes at once
    for (let i = 0; i < 40; i += 1) {
      h.type(String.fromCharCode(98 + (i % 20)));
    }
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.messages.length).toBeGreaterThan(2);
    for (const message of h.messages) {
      expect(message.bytes.length + (message.kind === "update" ? HEADER : 0)).toBeLessThanOrEqual(
        LIMIT,
      );
    }
    // One per slot: the floor between them.
    const gaps = h.messages.slice(1).map((m, i) => m.at - (h.messages[i] as { at: number }).at);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(1000);
    }
    // Together they are everything typed, and the receiver ends up with the whole text.
    expect(receive(h.messages.map((m) => m.bytes))).toBe(TYPED);
  });

  it("every message of a spread change is a valid update on its own: the receiver holds a usable prefix at each step", async () => {
    const h = limited({ minIntervalMs: 1000 });
    h.type("a");
    for (let i = 0; i < 40; i += 1) {
      h.type(String.fromCharCode(98 + (i % 20)));
    }
    await vi.advanceTimersByTimeAsync(20_000);
    const seen: string[] = [];
    const doc = seededDocument();
    for (const message of h.messages) {
      applyUpdate(doc, message.bytes);
      seen.push(getPlainText(getFragment(doc)));
    }
    // Each step adds to the last: never a hole, never out of order.
    for (let i = 1; i < seen.length; i += 1) {
      expect((seen[i] as string).startsWith(seen[i - 1] as string)).toBe(true);
      expect((seen[i] as string).length).toBeGreaterThan((seen[i - 1] as string).length);
    }
    expect(seen.at(-1)).toBe(TYPED);
  });

  it("splits a single update that is by itself too large into pieces sent in order, one per slot", async () => {
    const h = limited({ minIntervalMs: 1000 });
    h.paste(500); // an update of 500-odd bytes: over the limit on its own
    await vi.advanceTimersByTimeAsync(30_000);
    const frames = h.messages.filter((m) => m.kind === "frame");
    expect(frames.length).toBeGreaterThan(5);
    expect(h.messages.every((m) => m.kind === "frame")).toBe(true);
    const gaps = h.messages.slice(1).map((m, i) => m.at - (h.messages[i] as { at: number }).at);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(1000);
    }
    // Put back together, the slices are the update.
    const whole = new Uint8Array(frames.reduce((n, f) => n + f.bytes.length, 0));
    let offset = 0;
    for (const frame of frames) {
      whole.set(frame.bytes, offset);
      offset += frame.bytes.length;
    }
    expect(receive([whole])).toBe("P".repeat(500));
  });

  it("puts an edit typed after a big paste behind all of its pieces, so nothing arrives before what it builds on", async () => {
    const h = limited({ minIntervalMs: 500 });
    h.paste(500);
    h.type("z"); // queued behind the paste
    await vi.advanceTimersByTimeAsync(30_000);
    const kinds = h.messages.map((m) => m.kind);
    const lastFrame = kinds.lastIndexOf("frame");
    const firstUpdate = kinds.indexOf("update");
    expect(firstUpdate).toBeGreaterThan(lastFrame);
  });

  it("sends what was queued before a big paste first, then the paste's parts, then what came after", async () => {
    const h = limited({ minIntervalMs: 500 });
    h.type("a");
    h.paste(500);
    h.type("z");
    await vi.advanceTimersByTimeAsync(30_000);
    const kinds = h.messages.map((m) => m.kind);
    expect(kinds[0]).toBe("update");
    expect(kinds.at(-1)).toBe("update");
    expect(kinds.slice(1, -1).every((k) => k === "frame")).toBe(true);
  });

  it("reports how many parts of a cut change are still to come", async () => {
    const h = limited({ minIntervalMs: 1000 });
    h.paste(500);
    await vi.advanceTimersByTimeAsync(0);
    const total = 500 / 50; // slices of 50 bytes; the first went at once
    expect(h.scheduler.status.partsQueued).toBeGreaterThan(0);
    expect(h.scheduler.status.partsQueued).toBeLessThanOrEqual(total);
    const before = h.scheduler.status.partsQueued;
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.scheduler.status.partsQueued).toBe(before - 1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.scheduler.status.partsQueued).toBe(0);
    expect(h.scheduler.hasPending).toBe(false);
  });

  it("retries a piece that failed, in its place, without reordering or repeating the others", async () => {
    const h = limited({ minIntervalMs: 500 });
    h.paste(300);
    await vi.advanceTimersByTimeAsync(0); // the first piece goes
    h.failWith(new Error("down")); // the second fails once
    await vi.advanceTimersByTimeAsync(60_000);
    const parts = h.messages.filter((m) => m.kind === "frame");
    const whole = new Uint8Array(parts.reduce((n, f) => n + f.bytes.length, 0));
    let offset = 0;
    for (const part of parts) {
      whole.set(part.bytes, offset);
      offset += part.bytes.length;
    }
    expect(receive([whole])).toBe("P".repeat(300));
    expect(h.dropped).toEqual([]);
  });

  it("drops a change it cannot cut, reports it once, and carries on with what is queued behind", async () => {
    const h = limited({ minIntervalMs: 500 });
    h.breakCutting();
    h.paste(500);
    h.type("z");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.dropped).toHaveLength(1);
    expect(h.messages.filter((m) => m.kind === "update")).toHaveLength(1); // the edit behind it went
    expect(h.scheduler.hasPending).toBe(false);
  });

  it("drops the rest of a cut change when one of its parts fails for good, instead of sending parts nobody can use", async () => {
    const h = limited({ minIntervalMs: 500 });
    // Every send classified as permanent from here.
    const messages: Uint8Array[] = [];
    const dropped: unknown[] = [];
    const writer = typist();
    let failFrom = 2;
    const scheduler = new SendScheduler({
      quietMs: 0,
      policy: resolveSyncPolicy({ minIntervalMs: 500 }),
      send: async () => {},
      classify: () => ({ retryable: false }),
      onDropped: (error) => dropped.push(error),
      splitting: {
        maxBytes: LIMIT,
        frameSize: (update) => update.length + HEADER,
        pieces: (update: Uint8Array) => {
          const slices: string[] = [];
          for (let at = 0; at < update.length; at += 50) {
            slices.push(toFrame(update.slice(at, at + 50)));
          }
          return slices;
        },
        sendFrame: async (frame) => {
          failFrom -= 1;
          if (failFrom < 0) {
            throw new Error("rejected for good");
          }
          messages.push(fromFrame(frame));
        },
      },
    });
    scheduler.enqueue(writer.paste(500), 500);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(messages).toHaveLength(2); // two went, the third was refused, and nothing was sent after it
    expect(dropped).toHaveLength(1);
    expect(scheduler.hasPending).toBe(false);
    void h;
  });

  it("does not make the parts of a change wait for the typing to pause: they go at the permitted rate while the person keeps typing", async () => {
    const h = limited({ quietMs: 500, minIntervalMs: 100 });
    h.paste(500);
    await vi.advanceTimersByTimeAsync(500); // the paste itself waits out the quiet time like any change: now it is cut
    // Then a keystroke every 200 ms for five seconds: the 500 ms quiet time never elapses again.
    for (let i = 0; i < 25; i += 1) {
      await vi.advanceTimersByTimeAsync(200);
      h.type("k");
    }
    const partsSentWhileTyping = h.messages.filter((m) => m.kind === "frame").length;
    expect(partsSentWhileTyping).toBeGreaterThanOrEqual(10);
  });

  it("flush() sends every part, each a floor after the one before: an explicit request does not lift the floor (SND-2)", async () => {
    const h = limited({ minIntervalMs: 60_000 });
    h.paste(500);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.scheduler.hasPending).toBe(true);
    const flushing = h.scheduler.flush();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    await flushing;
    expect(h.scheduler.hasPending).toBe(false);
    expect(h.messages.length).toBeGreaterThan(5);
    expect(new Set(gaps(h.messages.map((m) => m.at)))).toEqual(new Set([60_000]));
  });

  it("queues frames handed to it and sends them in order at the permitted rate, ahead of an edit", async () => {
    const h = limited({ minIntervalMs: 1000 });
    h.type("a");
    await vi.advanceTimersByTimeAsync(0);
    h.scheduler.enqueueFrames(["1", "2", "3"]);
    h.type("b");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.messages.map((m) => m.kind)).toEqual(["update", "frame", "frame", "frame", "update"]);
    expect(h.messages.slice(1, 4).map((m) => m.bytes[0])).toEqual([1, 2, 3]);
  });

  it("counts a group refused for good as a dropped change only when it is one of its own, and tells only whoever enqueued it (SND-8)", async () => {
    const dropped: unknown[] = [];
    let refuse = 0;
    const scheduler = new SendScheduler({
      quietMs: 0,
      policy: resolveSyncPolicy({}),
      send: async () => {},
      classify: () => ({ retryable: false }),
      onDropped: (error) => dropped.push(error),
      splitting: {
        maxBytes: 1_000,
        frameSize: (update) => update.length,
        pieces: () => [],
        sendFrame: async () => {
          if (refuse > 0) {
            refuse -= 1;
            throw new Error("refused for good");
          }
        },
      },
    });
    refuse = 1;
    // An answer's pieces: its outcome goes to whoever enqueued them, who reports it.
    const answer = scheduler
      .enqueueFrames(["1", "2"], { own: false })
      .catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(0);
    expect(await answer).toBe("refused for good");
    expect(dropped).toEqual([]);
    expect(scheduler.droppedCount).toBe(0);
    refuse = 1;
    // resync()'s pieces: a change of this client's own, counted as dropped, and reported by
    // whoever waits for them — not here as well, or one refusal would be reported twice.
    const repair = scheduler.enqueueFrames(["1", "2"]).catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(0);
    expect(await repair).toBe("refused for good");
    expect(dropped).toEqual([]);
    expect(scheduler.droppedCount).toBe(1);
  });

  /** A scheduler that splits as `limited` does and reports, with what each report carried and when. */
  function splitReporting(pieces: (update: Uint8Array) => string[]) {
    const reports: { at: number; partsBefore: number; carry: ReportCarry | null }[] = [];
    const writer = typist();
    const sentFrames: number[] = [];
    const sent: Uint8Array[] = [];
    const scheduler = new SendScheduler({
      quietMs: 0,
      policy: resolveSyncPolicy({ minIntervalMs: 1000 }),
      send: async (update) => {
        sent.push(update);
      },
      classify: () => ({ retryable: false }),
      onDropped: () => {},
      report: (carry) => [
        async () => {
          reports.push({ at: Date.now(), partsBefore: sentFrames.length, carry });
        },
      ],
      splitting: {
        maxBytes: LIMIT,
        frameSize: (update) => update.length + HEADER,
        pieces,
        sendFrame: async () => {
          sentFrames.push(Date.now());
        },
      },
    });
    return { scheduler, writer, reports, sentFrames, sent };
  }

  const slices = (update: Uint8Array): string[] => {
    const parts: string[] = [];
    for (let at = 0; at < update.length; at += 50) {
      parts.push(toFrame(update.slice(at, at + 50)));
    }
    return parts;
  };

  it("holds the report back until every part has gone out, 10 s after the last, and it carries nothing of a change in pieces (SND-11, SND-27)", async () => {
    const h = splitReporting(slices);
    h.scheduler.enqueue(h.writer.paste(500), 500);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sentFrames.length).toBeGreaterThan(5);
    const last = h.sentFrames.at(-1) as number;
    expect(h.reports).toEqual([
      { at: last + REPORT_AFTER_MS, partsBefore: h.sentFrames.length, carry: null },
    ]);
  });

  it("begins no phase with the pieces of an answer (SND-11)", async () => {
    const h = splitReporting(slices);
    const sent = h.scheduler.enqueueFrames(["1", "2", "3"], { own: false });
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    await sent;
    expect(h.sentFrames).toHaveLength(3);
    expect(h.reports).toEqual([]);
  });

  it("is still owed by the edit before a change that could not be cut and was dropped, and carries that edit (SND-19, SND-27)", async () => {
    const h = splitReporting(() => {
      throw new Error("cannot be cut");
    });
    h.scheduler.enqueue(h.writer.type("a"), 1); // at T0
    await vi.advanceTimersByTimeAsync(5_000);
    h.scheduler.enqueue(h.writer.paste(5_000), 5_000); // too large, and cannot be cut: dropped
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.reports).toEqual([
      { at: T0 + REPORT_AFTER_MS, partsBefore: 0, carry: { kind: "edit", update: h.sent[0] } },
    ]);
  });
});

describe("SendScheduler: a wall clock that jumps back (SPECIFICATION.md SND-2, CTL-45)", () => {
  it("holds the next message for the floor as measured, not for as long as the wall clock went back", async () => {
    const h = harness({ quietMs: 0, policy: { minIntervalMs: 2_000 } });
    h.type("a"); // at T0
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.attemptTimes).toEqual([T0]);
    // The device's clock is set back an hour, as a time service may do.
    vi.setSystemTime(Date.now() - 3_600_000);
    const sentAt: number[] = [];
    void h.scheduler.submit(async () => {
      sentAt.push(Date.now());
    });
    await vi.advanceTimersByTimeAsync(0);
    // 5 s passed since the last message, more than the floor: it goes at once.
    expect(sentAt).toHaveLength(1);
    h.type("b");
    await vi.advanceTimersByTimeAsync(1_999);
    expect(h.attemptTimes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.attemptTimes).toHaveLength(2);
    expect(receive(h.sent)).toBe("ab");
  });

  it("reports when it last sent and when it tries next by the wall clock as it reads now", async () => {
    const h = harness({ quietMs: 0, policy: { minIntervalMs: 2_000 } });
    h.type("a"); // at T0
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() - 3_600_000);
    // As if it had sent just now: never in the future of the clock it is compared with.
    expect(h.scheduler.lastSendAt).toBe(T0 - 3_600_000);
    h.type("b");
    expect(h.scheduler.status.nextAttemptAt).toBe(T0 - 3_600_000 + 2_000);
  });
});

describe("SendScheduler: every other message goes through it too (SPECIFICATION.md SND-2, SND-20)", () => {
  it("holds a submitted message for the floor after the last one, then sends it", async () => {
    const h = harness({ quietMs: 0, policy: { minIntervalMs: 10_000 } });
    h.type("a"); // goes at once
    const sentAt: number[] = [];
    const done = h.scheduler.submit(async () => {
      sentAt.push(Date.now());
      return "id-1";
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(sentAt).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sentAt).toEqual([T0 + 10_000]);
    await expect(done).resolves.toBe("id-1");
  });

  it("goes ahead of an edit that is waiting, and the edit then waits a floor after it", async () => {
    const h = harness({ quietMs: 0, policy: { minIntervalMs: 10_000 } });
    h.type("a"); // at T0
    h.type("b"); // waits for T0 + 10 s
    const order: string[] = [];
    void h.scheduler.submit(async () => {
      order.push(`submitted@${Date.now() - T0}`);
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(order).toEqual(["submitted@10000"]);
    expect(h.attemptTimes).toEqual([T0]); // "b" not yet
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.attemptTimes).toEqual([T0, T0 + 20_000]);
  });

  it("counts a submitted message against the floor for the edit that follows it", async () => {
    const h = harness({ quietMs: 0, policy: { minIntervalMs: 10_000 } });
    await h.scheduler.submit(async () => {}); // at T0: nothing sent before
    h.type("a");
    await vi.advanceTimersByTimeAsync(9_999);
    expect(h.attemptTimes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.attemptTimes).toEqual([T0 + 10_000]);
  });

  it("tells the submitter of a failure and does not retry it", async () => {
    const h = harness({ quietMs: 0 });
    let runs = 0;
    const done = h.scheduler.submit(async () => {
      runs += 1;
      throw new Error("refused");
    });
    await expect(done).rejects.toThrow("refused");
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(runs).toBe(1);
    expect(h.dropped).toEqual([]); // the submitter's to report, not the scheduler's
  });

  it("after a rate-limit refusal of one it does not retry, holds back the next send of any kind as the provider asked (SND-7, SND-9)", async () => {
    const h = harness({
      quietMs: 0,
      classify: () => ({ retryable: true, rateLimited: true, retryAfterMs: 30_000 }),
    });
    const refused = h.scheduler.submit(async () => {
      throw new Error("slow down");
    });
    await expect(refused).rejects.toThrow("slow down");
    expect(h.scheduler.effectiveMinIntervalMs).toBe(RETRY_BASE_MS * ADAPT_GROWTH); // spaced wider
    expect(h.scheduler.status.state).toBe("idle"); // no change of its own is being retried

    // The same message again — a responder answering the request a second time (RSY-9) — and an edit.
    const sentAt: number[] = [];
    const again = h.scheduler.submit(async () => {
      sentAt.push(Date.now());
    });
    h.type("a");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(sentAt).toEqual([]);
    expect(h.attemptTimes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await again;
    expect(sentAt).toEqual([T0 + 30_000]);
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS * ADAPT_GROWTH);
    expect(receive(h.sent)).toBe("a");
  });

  it("backs off exponentially after refusals of messages it does not retry, and a success resets it (SND-7)", async () => {
    const h = harness({ quietMs: 0 }); // every failure is worth retrying
    const runs: number[] = [];
    // Settles to the failure's message, so that a refusal while time is advanced is never unhandled.
    const fail = () =>
      h.scheduler
        .submit(async () => {
          runs.push(Date.now());
          throw new Error("unreachable");
        })
        .catch((error: Error) => error.message);
    expect(await fail()).toBe("unreachable"); // at T0
    const second = fail();
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS - 1);
    expect(runs).toEqual([T0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await second).toBe("unreachable");
    expect(runs).toEqual([T0, T0 + RETRY_BASE_MS]);
    h.type("a");
    await vi.advanceTimersByTimeAsync(2 * RETRY_BASE_MS - 1); // doubled
    expect(h.attemptTimes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.attemptTimes).toEqual([T0 + 3 * RETRY_BASE_MS]);
    expect(receive(h.sent)).toBe("a");

    const third = fail(); // after the success: one second again, not four
    await vi.advanceTimersByTimeAsync(0);
    expect(await third).toBe("unreachable");
    h.type("b");
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
    expect(h.attemptTimes.at(-1)).toBe(T0 + 4 * RETRY_BASE_MS);
  });

  it("rejects what is still waiting when it stops", async () => {
    const h = harness({ quietMs: 0, policy: { minIntervalMs: 10_000 } });
    h.type("a");
    const done = h.scheduler.submit(async () => {});
    h.scheduler.stop();
    await expect(done).rejects.toThrow(/stopped/);
  });
});

describe("SendScheduler: a submitted message kept for a retry (SPECIFICATION.md SND-7, CTL-26)", () => {
  const RETRYABLE: SendFailureClass = { retryable: true };
  const PERMANENT: SendFailureClass = { retryable: false };

  /** A submitted message whose first runs fail with `errors`, in order, then succeed. */
  function failing(...errors: unknown[]) {
    const runs: number[] = [];
    return {
      runs,
      run: async () => {
        runs.push(Date.now());
        const error = errors.shift();
        if (error !== undefined) {
          throw error;
        }
        return "id-1";
      },
    };
  }

  it("keeps it after a retryable failure and sends it again after the back-off, resolving only then", async () => {
    const h = harness({ quietMs: 0, classify: () => RETRYABLE });
    const message = failing(new Error("offline"), new Error("offline"));
    let settled = false;
    const done = h.scheduler.submit(message.run, { retry: true }).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(message.runs).toEqual([T0]);
    expect(settled).toBe(false);
    expect(h.scheduler.status).toMatchObject({
      state: "retrying",
      failures: 1,
      lastError: "offline",
    });

    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
    expect(message.runs).toEqual([T0, T0 + RETRY_BASE_MS]);
    await vi.advanceTimersByTimeAsync(2 * RETRY_BASE_MS); // doubled after the second failure
    await expect(done).resolves.toBe("id-1");
    expect(message.runs).toHaveLength(3);
    expect(h.scheduler.status).toMatchObject({ state: "idle", failures: 0, lastError: null });
  });

  it("waits at least as long as the provider asked before trying again", async () => {
    const h = harness({
      quietMs: 0,
      classify: () => ({ retryable: true, rateLimited: true, retryAfterMs: 30_000 }),
    });
    const message = failing(new Error("slow down"));
    const done = h.scheduler.submit(message.run, { retry: true });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(message.runs).toEqual([T0]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toBe("id-1");
  });

  it("rejects at once on a failure that is not worth retrying", async () => {
    const h = harness({ quietMs: 0, classify: () => PERMANENT });
    const message = failing(new Error("too large"));
    const done = h.scheduler.submit(message.run, { retry: true });
    await expect(done).rejects.toThrow("too large");
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(message.runs).toHaveLength(1);
    expect(h.scheduler.status.state).toBe("idle");
  });

  it("goes before an edit queued behind it, which waits until it has gone out", async () => {
    const h = harness({ quietMs: 0, classify: () => RETRYABLE });
    const message = failing(new Error("offline"));
    const done = h.scheduler.submit(message.run, { retry: true });
    await vi.advanceTimersByTimeAsync(0);
    h.type("a");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.attemptTimes).toEqual([]); // the edit is not sent past the message being retried
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
    await expect(done).resolves.toBe("id-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(receive(h.sent)).toBe("a");
  });

  it("a flush waits out the back-off, tries it, and throws a retryable failure, keeping it for the next attempt (SND-7)", async () => {
    const h = harness({ quietMs: 0, classify: () => RETRYABLE });
    const message = failing(
      new Error("offline"),
      new Error("still offline"),
      new Error("offline again"),
    );
    const done = h.scheduler.submit(message.run, { retry: true });
    await vi.advanceTimersByTimeAsync(0);
    const flushing = h.scheduler.flush().catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS - 1);
    expect(message.runs).toEqual([T0]); // not before the back-off
    await vi.advanceTimersByTimeAsync(1);
    expect(await flushing).toBe("still offline");
    expect(message.runs).toEqual([T0, T0 + RETRY_BASE_MS]);
    // Kept: the scheduler's own retry follows after the next, doubled back-off.
    await vi.advanceTimersByTimeAsync(2 * RETRY_BASE_MS);
    expect(message.runs).toEqual([T0, T0 + RETRY_BASE_MS, T0 + 3 * RETRY_BASE_MS]);
    await vi.advanceTimersByTimeAsync(4 * RETRY_BASE_MS);
    await expect(done).resolves.toBe("id-1");
  });

  it("a final flush makes one last attempt, once the back-off permits, and then rejects it, as stopping does", async () => {
    const h = harness({ quietMs: 0, classify: () => RETRYABLE });
    const message = failing(new Error("offline"), new Error("still offline"));
    const done = h.scheduler
      .submit(message.run, { retry: true })
      .catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(0);
    const flushing = h.scheduler.flush({ final: true });
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
    await flushing;
    expect(await done).toBe("still offline");
    expect(message.runs).toEqual([T0, T0 + RETRY_BASE_MS]);

    const stopped = harness({ quietMs: 0, classify: () => RETRYABLE });
    const other = failing(new Error("offline"));
    const pending = stopped.scheduler.submit(other.run, { retry: true });
    await vi.advanceTimersByTimeAsync(0);
    stopped.scheduler.stop();
    await expect(pending).rejects.toThrow(/stopped/);
  });
});

describe("SendScheduler report (SND-11, SND-12)", () => {
  /** A report the scheduler sent: when, and what it carried again (SND-27). */
  interface Sent {
    readonly at: number;
    readonly carry: ReportCarry | null;
  }

  function reporting(
    policy: Partial<SyncPolicy> = {},
    options: { quietMs?: number; classify?: (error: unknown) => SendFailureClass } = {},
  ) {
    const reports: Sent[] = [];
    const attempts: number[] = [];
    const log: string[] = [];
    const sent: Uint8Array[] = [];
    const failures: unknown[] = [];
    const reportFailures: unknown[] = [];
    const writer = typist();
    const state = { changes: 0 };
    const scheduler = new SendScheduler({
      quietMs: options.quietMs ?? 0,
      policy: resolveSyncPolicy(policy),
      send: async (update) => {
        const failure = failures.shift();
        if (failure !== undefined) {
          throw failure;
        }
        sent.push(update);
        log.push(`edit at ${Date.now() - T0}`);
      },
      classify: options.classify ?? (() => ({ retryable: true })),
      onDropped: () => {},
      report: (carry) => [
        ...(carry?.kind === "control"
          ? [
              async () => {
                log.push(`control again at ${Date.now() - T0}`);
              },
            ]
          : []),
        async () => {
          attempts.push(Date.now());
          const failure = reportFailures.shift();
          if (failure !== undefined) {
            throw failure;
          }
          reports.push({ at: Date.now(), carry });
          log.push(`report at ${Date.now() - T0}`);
        },
      ],
      onReportChange: () => {
        state.changes += 1;
      },
    });
    return {
      scheduler,
      sent,
      reports,
      attempts,
      log,
      get changes() {
        return state.changes;
      },
      failWith: (...errors: unknown[]) => failures.push(...errors),
      failReportWith: (...errors: unknown[]) => reportFailures.push(...errors),
      type: (char = "x") => scheduler.enqueue(writer.type(char), 1),
      times: () => reports.map((report) => report.at),
    };
  }

  it("is owed after an own edit and goes 10 s after it once nothing of its own waits, carrying that edit as it went out (SND-27)", async () => {
    const h = reporting();
    h.type(); // goes out at T0
    await vi.advanceTimersByTimeAsync(0);
    expect(h.scheduler.status.reportOwed).toBe(true);
    await vi.advanceTimersByTimeAsync(REPORT_AFTER_MS - 1);
    expect(h.reports).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.times()).toEqual([T0 + REPORT_AFTER_MS]);
    expect(h.reports[0]?.carry).toEqual({ kind: "edit", update: h.sent[0] });
    expect(h.scheduler.status.reportOwed).toBe(false);
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(h.reports).toHaveLength(1);
  });

  it("counts afresh from each own edit or control frame, never from a request, an answer or a report", async () => {
    const h = reporting();
    h.type(); // at T0
    await vi.advanceTimersByTimeAsync(5_000);
    await h.scheduler.submit(async () => {}); // a request, or a whole answer, at T0 + 5 s
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.times()).toEqual([T0 + 10_000]); // not 10 s after the request
    await vi.advanceTimersByTimeAsync(5_000);
    // A control frame of its own at T0 + 15 s: a phase of its own, and the report sends it again.
    await h.scheduler.submit(async () => {}, { phase: { kind: "control", text: "C" } });
    await vi.advanceTimersByTimeAsync(REPORT_AFTER_MS - 1);
    expect(h.reports).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.times()).toEqual([T0 + 10_000, T0 + 25_000]);
    expect(h.reports[1]?.carry).toEqual({ kind: "control", text: "C" });
    // The reports themselves begin nothing.
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(h.reports).toHaveLength(2);
  });

  it("is not owed after messages that are no phase's: a request or an answer, and reading costs none", async () => {
    const h = reporting();
    await h.scheduler.submit(async () => {});
    await h.scheduler.submit(async () => {}, { retry: true });
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(h.reports).toEqual([]);
    expect(h.scheduler.status.reportOwed).toBe(false);
  });

  it("waits while a change of its own waits or is retried, and counts from when it went out", async () => {
    const h = reporting({}, { quietMs: 500 });
    h.type();
    await vi.advanceTimersByTimeAsync(500); // out at T0 + 500 ms: a report owed at T0 + 10.5 s
    await vi.advanceTimersByTimeAsync(9_000);
    h.failWith(new Error("offline"), new Error("offline"));
    h.type(); // at T0 + 9.5 s; tried at T0 + 10 s and T0 + 11 s, out at T0 + 13 s
    await vi.advanceTimersByTimeAsync(T0 + 13_000 + REPORT_AFTER_MS - 1 - Date.now());
    expect(h.sent).toHaveLength(2);
    expect(h.reports).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.times()).toEqual([T0 + 13_000 + REPORT_AFTER_MS]);
    expect(h.reports[0]?.carry).toEqual({ kind: "edit", update: h.sent[1] });
  });

  it("goes not while a change of its own waits for its time, however long the typing goes on", async () => {
    const h = reporting({}, { quietMs: 500 });
    h.type();
    await vi.advanceTimersByTimeAsync(500); // out at T0 + 500 ms
    for (let keystroke = 0; keystroke < 300; keystroke += 1) {
      h.type(); // 30 s of typing that never pauses for the quiet time
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(h.sent).toHaveLength(1);
    expect(h.reports).toEqual([]);
    await vi.advanceTimersByTimeAsync(500); // the pause: the change goes
    expect(h.sent).toHaveLength(2);
    const wentAt = Date.now() - 100;
    await vi.advanceTimersByTimeAsync(REPORT_AFTER_MS);
    expect(h.times()).toEqual([wentAt + REPORT_AFTER_MS]);
    expect(h.log.at(-2)).toBe(`edit at ${wentAt - T0}`);
  });

  it("goes at most once per phase: none until a message of its own went out again", async () => {
    const h = reporting();
    h.type();
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(h.reports).toHaveLength(1);
    h.type();
    await vi.advanceTimersByTimeAsync(REPORT_AFTER_MS);
    expect(h.reports).toHaveLength(2);
  });

  it.each([
    ["no maxIntervalMs", {}, REPORT_AFTER_MS],
    ["a maxIntervalMs of a minute", { maxIntervalMs: 60_000 }, REPORT_AFTER_MS],
    ["a floor of 35 s, as e-mail's", { minIntervalMs: 35_000 }, 35_000],
  ] as const)("goes whatever the pacing: with %s, after %#", async (_name, policy, after) => {
    const h = reporting(policy);
    h.type(); // the first message, at T0
    await vi.advanceTimersByTimeAsync(after - 1);
    expect(h.reports).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.times()).toEqual([T0 + after]); // never inside the floor (SND-2)
  });

  it("is told to the floor again when the policy changes it", async () => {
    const h = reporting();
    h.type(); // at T0
    h.scheduler.setPolicy(resolveSyncPolicy({ minIntervalMs: 30_000 }));
    await vi.advanceTimersByTimeAsync(30_000 - 1);
    expect(h.reports).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.times()).toEqual([T0 + 30_000]);
  });

  it("stays owed until the transport accepted it: one refused for a reason worth retrying goes again after the back-off (SND-12, SND-28)", async () => {
    const h = reporting();
    h.type();
    h.failReportWith(new Error("offline"));
    await vi.advanceTimersByTimeAsync(REPORT_AFTER_MS);
    expect(h.attempts).toEqual([T0 + REPORT_AFTER_MS]);
    expect(h.scheduler.status.reportOwed).toBe(true);
    // Retried after a back-off of its own, which no change of its own waits for; nothing is reported
    // (SND-10, SND-12).
    expect(h.scheduler.status).toMatchObject({ state: "idle", failures: 0 });
    expect(h.scheduler.owedReport).toEqual({ carry: { kind: "edit", update: h.sent[0] } });
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
    expect(h.times()).toEqual([T0 + REPORT_AFTER_MS + RETRY_BASE_MS]);
    expect(h.scheduler.status.reportOwed).toBe(false);
    expect(h.scheduler.owedReport).toBeUndefined();
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(h.attempts).toHaveLength(2);
  });

  it("one refused for good is given up, and marks nothing as undistributed (SND-8, SND-12)", async () => {
    const h = reporting({}, { classify: () => ({ retryable: false }) });
    h.type();
    h.failReportWith(new Error("refused for good"));
    await vi.advanceTimersByTimeAsync(REPORT_AFTER_MS);
    expect(h.attempts).toEqual([T0 + REPORT_AFTER_MS]);
    expect(h.scheduler.status.reportOwed).toBe(false);
    expect(h.scheduler.droppedCount).toBe(0);
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(h.attempts).toHaveLength(1);
    expect(h.reports).toEqual([]);
  });

  it("counts against the floor: an edit right after it waits for the floor from the report (SND-2)", async () => {
    const h = reporting({ minIntervalMs: 10_000 });
    h.type();
    await vi.advanceTimersByTimeAsync(REPORT_AFTER_MS);
    expect(h.reports).toHaveLength(1);
    h.type(); // typed at the moment of the report
    await vi.advanceTimersByTimeAsync(9_999);
    expect(h.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sent).toHaveLength(2);
  });

  it("carries only the last edit that went out: not one refused for good, nor one queued later (SND-27)", async () => {
    const h = reporting({}, { quietMs: 500, classify: () => ({ retryable: false }) });
    h.type("a");
    await vi.advanceTimersByTimeAsync(500); // "a" goes out at T0 + 500 ms
    h.failWith(new Error("refused for good"));
    h.type("b");
    await vi.advanceTimersByTimeAsync(500); // "b" is refused for good, and dropped
    await vi.advanceTimersByTimeAsync(REPORT_AFTER_MS);
    expect(h.sent).toHaveLength(1);
    expect(h.times()).toEqual([T0 + 500 + REPORT_AFTER_MS]); // still owed for what "a" began
    expect(h.reports[0]?.carry).toEqual({ kind: "edit", update: h.sent[0] });
  });

  it("a control frame of its own goes again, unchanged, before the report, a floor apart (SND-27)", async () => {
    const h = reporting({ minIntervalMs: 1_000 });
    await h.scheduler.submit(async () => {}, { phase: { kind: "control", text: "decided" } }); // T0
    await vi.advanceTimersByTimeAsync(REPORT_AFTER_MS + 1_000);
    expect(h.log).toEqual([
      `control again at ${REPORT_AFTER_MS}`,
      `report at ${REPORT_AFTER_MS + 1_000}`,
    ]);
    expect(h.reports[0]?.carry).toEqual({ kind: "control", text: "decided" });
  });

  it("owed at once, goes as soon as the floor permits, whatever the pacing, carrying what last went out (SND-24)", async () => {
    for (const policy of [
      { minIntervalMs: 5_000, maxIntervalMs: 60_000 },
      { minIntervalMs: 5_000 },
    ]) {
      vi.setSystemTime(T0);
      const h = reporting(policy);
      await h.scheduler.submit(async () => {}); // a message at T0, no phase's
      h.scheduler.oweReport({ now: true }); // a request showed that its last report misleads
      expect(h.scheduler.status.reportOwed).toBe(true);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(h.reports).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.reports).toEqual([{ at: T0 + 5_000, carry: null }]); // nothing of its own went out
      await vi.advanceTimersByTimeAsync(24 * 3_600_000);
      expect(h.reports).toHaveLength(1);
    }
  });

  it("owed at once, it still waits for a change of its own that waits, and goes with that change's phase, at its end (SND-12)", async () => {
    const h = reporting({ minIntervalMs: 5_000 }, { quietMs: 500 });
    await h.scheduler.submit(async () => {}); // a message at T0
    await vi.advanceTimersByTimeAsync(1_000);
    h.type(); // waits for the floor, until T0 + 5 s
    h.scheduler.oweReport({ now: true });
    await vi.advanceTimersByTimeAsync(4_000 + REPORT_AFTER_MS);
    expect(h.log).toEqual(["edit at 5000", `report at ${5_000 + REPORT_AFTER_MS}`]);
    expect(h.reports[0]?.carry).toEqual({ kind: "edit", update: h.sent[0] });
  });

  it("only the report that ends a phase carries its repeat; one owed at once in the phase or after it states only (SND-27)", async () => {
    const h = reporting();
    h.type(); // out at T0
    await vi.advanceTimersByTimeAsync(2_000);
    h.scheduler.oweReport({ now: true }); // a merge, within the phase
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reports).toEqual([{ at: T0 + 2_000, carry: null }]);
    await vi.advanceTimersByTimeAsync(REPORT_AFTER_MS - 2_000);
    // The phase's, at its end, with its repeat.
    expect(h.reports[1]).toEqual({
      at: T0 + REPORT_AFTER_MS,
      carry: { kind: "edit", update: h.sent[0] },
    });
    h.scheduler.oweReport({ now: true }); // and one after it
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reports[2]).toEqual({ at: T0 + REPORT_AFTER_MS, carry: null });
    expect(h.reports).toHaveLength(3);
  });

  it("sends a control frame of its own again once, with the report that ends its phase, not with a later one (SND-27)", async () => {
    const h = reporting();
    await h.scheduler.submit(async () => {}, { phase: { kind: "control", text: "C" } }); // T0
    await vi.advanceTimersByTimeAsync(REPORT_AFTER_MS);
    h.scheduler.oweReport({ now: true });
    await vi.advanceTimersByTimeAsync(0);
    const at = `at ${REPORT_AFTER_MS}`;
    expect(h.log).toEqual([`control again ${at}`, `report ${at}`, `report ${at}`]);
  });

  it("observable and given back as one that states only, when it is owed for what it states (SND-27, SND-28)", async () => {
    const h = reporting({ minIntervalMs: 5_000 });
    await h.scheduler.submit(async () => {}); // a message at T0
    h.scheduler.oweReport({ now: true });
    expect(h.scheduler.owedReport).toEqual({ carry: null });
    const restored = reporting();
    restored.scheduler.restoreOwedReport(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(restored.reports).toEqual([{ at: T0, carry: null }]);
  });

  it("a report that could not go never holds a change of its own back: the change goes first, and the report goes at the end of its phase with its repeat (SND-12)", async () => {
    const h = reporting();
    h.type("a"); // out at T0
    h.failReportWith(new Error("offline"));
    await vi.advanceTimersByTimeAsync(REPORT_AFTER_MS); // refused at T0 + 10 s: a back-off of its own
    expect(h.attempts).toEqual([T0 + REPORT_AFTER_MS]);
    h.type("b");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sent).toHaveLength(2); // at once
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
    expect(h.attempts).toHaveLength(1); // the report is the new phase's now
    await vi.advanceTimersByTimeAsync(REPORT_AFTER_MS);
    expect(h.reports).toEqual([
      { at: T0 + 2 * REPORT_AFTER_MS, carry: { kind: "edit", update: h.sent[1] } },
    ]);
  });

  it("a message of a report that waits is taken back for a change of its own, which goes first (SND-12)", async () => {
    const h = reporting({ minIntervalMs: 5_000 });
    await h.scheduler.submit(async () => {}, { phase: { kind: "control", text: "C" } }); // T0
    await vi.advanceTimersByTimeAsync(REPORT_AFTER_MS); // the frame again; the report waits for the floor
    expect(h.log).toEqual([`control again at ${REPORT_AFTER_MS}`]);
    await vi.advanceTimersByTimeAsync(2_000);
    h.type("x"); // within that floor
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.log).toEqual([
      `control again at ${REPORT_AFTER_MS}`,
      `edit at ${REPORT_AFTER_MS + 5_000}`,
    ]);
    await vi.advanceTimersByTimeAsync(REPORT_AFTER_MS);
    expect(h.log.at(-1)).toBe(`report at ${2 * REPORT_AFTER_MS + 5_000}`);
    expect(h.reports).toEqual([
      { at: T0 + 2 * REPORT_AFTER_MS + 5_000, carry: { kind: "edit", update: h.sent[0] } },
    ]);
  });

  it("a wait the provider asked for, after a refusal of the report, holds back every send (SND-7, SND-9)", async () => {
    const h = reporting(
      {},
      {
        classify: (error) =>
          error instanceof Error && error.message === "slow down"
            ? { retryable: true, rateLimited: true, retryAfterMs: 30_000 }
            : { retryable: true },
      },
    );
    h.type("a"); // out at T0
    h.failReportWith(new Error("slow down"));
    await vi.advanceTimersByTimeAsync(REPORT_AFTER_MS);
    h.type("b");
    await vi.advanceTimersByTimeAsync(30_000 - 1);
    expect(h.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sent).toHaveLength(2);
  });

  it("liftReportBackOff: a return ends the report's back-off, and the report owed goes at once (SND-12, RSY-21)", async () => {
    const h = reporting();
    h.type(); // out at T0
    // Away for half an hour: the report fails on, and its back-off grows to ten minutes.
    h.failReportWith(...Array.from({ length: 12 }, () => new Error("offline")));
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(h.attempts).toHaveLength(12);
    expect(h.scheduler.status.reportOwed).toBe(true);
    h.scheduler.liftReportBackOff();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.times()).toEqual([Date.now()]);
    expect(h.scheduler.status.reportOwed).toBe(false);
  });

  it("reportNow sends an owed report as soon as the floor permits and resolves once it was accepted; with none owed, at once (LIF-12)", async () => {
    const h = reporting({ minIntervalMs: 2_000 });
    h.type(); // out at T0
    await vi.advanceTimersByTimeAsync(0);
    let settled = false;
    const reported = h.scheduler.reportNow().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(h.reports).toEqual([]);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await reported;
    expect(h.times()).toEqual([T0 + 2_000]); // not 10 s after the edit
    expect(settled).toBe(true);
    await h.scheduler.reportNow(); // none owed: at once, and nothing is sent
    expect(Date.now()).toBe(T0 + 2_000);
    expect(h.reports).toHaveLength(1);
  });

  it("a final flush is the close: what waits goes first, then the report it owes, last (SND-11)", async () => {
    const h = reporting({}, { quietMs: 60_000 });
    h.type("a"); // waits for the quiet time
    expect(h.scheduler.status.reportOwed).toBe(false); // nothing of its own went out yet
    await h.scheduler.flush({ final: true });
    expect(h.log).toEqual(["edit at 0", "report at 0"]);
    expect(h.reports[0]?.carry).toEqual({ kind: "edit", update: h.sent[0] });
    expect(h.scheduler.status.reportOwed).toBe(false);
  });

  it("a report a final flush cannot send stays owed, for the application to persist (SND-28)", async () => {
    const h = reporting();
    h.type(); // under way at T0 as the flush begins: the report waits for it
    h.failReportWith(new Error("offline"));
    await h.scheduler.flush({ final: true });
    expect(h.attempts).toEqual([T0]);
    expect(h.scheduler.status.reportOwed).toBe(true);
    expect(h.scheduler.owedReport).toEqual({ carry: { kind: "edit", update: h.sent[0] } });
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(h.attempts).toHaveLength(1); // there is no next attempt in this engine
  });

  it("a flush that is not final sends no report of itself", async () => {
    const h = reporting({}, { quietMs: 60_000 });
    h.type();
    await h.scheduler.flush();
    expect(h.sent).toHaveLength(1);
    expect(h.reports).toEqual([]);
    await vi.advanceTimersByTimeAsync(REPORT_AFTER_MS);
    expect(h.reports).toHaveLength(1);
  });

  it("stop() sends no report, and keeps it owed (SND-28)", async () => {
    const h = reporting();
    h.type();
    h.scheduler.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.reports).toEqual([]);
    expect(h.scheduler.status.reportOwed).toBe(true);
    await h.scheduler.reportNow(); // nothing more can go: at once
  });

  it("a report owed at the last start goes as soon as the floor permits, carrying what it carried (SND-28)", async () => {
    const h = reporting({ minIntervalMs: 5_000 });
    const update = typist().type("r");
    h.scheduler.restoreOwedReport({ kind: "edit", update });
    expect(h.scheduler.owedReport).toEqual({ carry: { kind: "edit", update } });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reports).toEqual([{ at: T0, carry: { kind: "edit", update } }]);
    expect(h.scheduler.owedReport).toBeUndefined();
  });

  it("tells when the report owed arises, carries something else, and falls", async () => {
    const h = reporting();
    expect(h.scheduler.owedReport).toBeUndefined();
    h.type("a");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.changes).toBe(1);
    expect(h.scheduler.owedReport).toEqual({ carry: { kind: "edit", update: h.sent[0] } });
    h.type("b");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.changes).toBe(2);
    expect(h.scheduler.owedReport).toEqual({ carry: { kind: "edit", update: h.sent[1] } });
    await vi.advanceTimersByTimeAsync(REPORT_AFTER_MS);
    expect(h.changes).toBe(3);
    expect(h.scheduler.owedReport).toBeUndefined();
  });
});

describe("SendScheduler flush and stop", () => {
  it("flush() sends at once, ignoring the quiet time and minChars", async () => {
    const h = harness({
      quietMs: 60_000,
      policy: { minIntervalMs: 60_000, minChars: 500, maxIntervalMs: 600_000 },
    });
    h.type("a");
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.sent).toHaveLength(0);
    await h.scheduler.flush();
    expect(receive(h.sent)).toBe("a");
  });

  it("flush() waits for the floor after the last message: an explicit request does not lift it (SND-2)", async () => {
    const h = harness({
      quietMs: 60_000,
      policy: { minIntervalMs: 60_000, minChars: 500, maxIntervalMs: 600_000 },
    });
    await h.scheduler.submit(async () => {}); // a message at T0
    h.type("a");
    const flushing = h.scheduler.flush();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await flushing;
    expect(h.attemptTimes).toEqual([T0 + 60_000]);
    expect(receive(h.sent)).toBe("a");
  });

  it("a final flush waits for the floor too, and sends nothing before it (SND-2)", async () => {
    const h = harness({ quietMs: 60_000, policy: { minIntervalMs: 30_000 } });
    await h.scheduler.submit(async () => {}); // a message at T0
    h.type("a");
    const flushing = h.scheduler.flush({ final: true });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.attemptTimes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await flushing;
    expect(h.attemptTimes).toEqual([T0 + 30_000]);
  });

  it("flush() waits for what the provider asked after a rate-limit refusal (SND-7)", async () => {
    const h = harness({
      quietMs: 60_000,
      classify: () => ({ retryable: true, rateLimited: true, retryAfterMs: 45_000 }),
    });
    h.failWith(new Error("slow down"));
    h.type("a");
    await expect(h.scheduler.flush()).rejects.toThrow("slow down"); // at T0, refused
    const flushing = h.scheduler.flush();
    await vi.advanceTimersByTimeAsync(44_999);
    expect(h.attemptTimes).toEqual([T0]);
    await vi.advanceTimersByTimeAsync(1);
    await flushing;
    expect(h.attemptTimes).toEqual([T0, T0 + 45_000]);
    expect(receive(h.sent)).toBe("a");
  });

  it("flush() with nothing pending sends nothing", async () => {
    const h = harness({});
    await h.scheduler.flush();
    expect(h.attemptTimes).toHaveLength(0);
  });

  it("flush() rejects with the send's error, and a retryable one stays queued for the scheduler's own retry", async () => {
    const h = harness({ quietMs: 60_000 });
    const failure = new Error("down");
    h.failWith(failure);
    h.type("a");
    await expect(h.scheduler.flush()).rejects.toBe(failure);
    expect(h.scheduler.hasPending).toBe(true);
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
    expect(receive(h.sent)).toBe("a");
  });

  it("flush() with a permanent failure rejects and drops the change", async () => {
    const h = harness({ quietMs: 60_000, classify: () => ({ retryable: false }) });
    const failure = new Error("rejected");
    h.failWith(failure);
    h.type("a");
    await expect(h.scheduler.flush()).rejects.toBe(failure);
    expect(h.scheduler.hasPending).toBe(false);
  });

  it("a final flush sends once and, on failure, schedules no retry: there is no next attempt", async () => {
    const h = harness({ quietMs: 60_000 });
    const failure = new Error("down");
    h.failWith(failure);
    h.type("a");
    await expect(h.scheduler.flush({ final: true })).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 2);
    expect(h.attemptTimes).toHaveLength(1);
    expect(h.scheduler.hasPending).toBe(false);
  });

  it("stop() cancels every timer and abandons what is pending", async () => {
    const h = harness({ quietMs: 500 });
    h.type("a");
    h.scheduler.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.attemptTimes).toHaveLength(0);
    h.type("b"); // ignored once stopped
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.attemptTimes).toHaveLength(0);
  });
});

describe("SendScheduler status", () => {
  it("reports idle, waiting and retrying, and when the next attempt is due", async () => {
    const h = harness({ quietMs: 500 });
    expect(h.scheduler.status).toEqual({
      state: "idle",
      failures: 0,
      nextAttemptAt: null,
      lastError: null,
      partsQueued: 0,
      reportOwed: false,
    });
    h.type("a");
    expect(h.scheduler.status.state).toBe("waiting");
    expect(h.scheduler.status.nextAttemptAt).toBe(T0 + 500);

    h.failWith(new Error("down"));
    await vi.advanceTimersByTimeAsync(500);
    expect(h.scheduler.status.state).toBe("retrying");
    expect(h.scheduler.status.nextAttemptAt).toBe(T0 + 500 + RETRY_BASE_MS);
  });

  it("tells the observer each time it changes", async () => {
    const h = harness({ quietMs: 500 });
    const before = h.statusChanges;
    h.type("a");
    expect(h.statusChanges).toBeGreaterThan(before);
    const afterEdit = h.statusChanges;
    await vi.advanceTimersByTimeAsync(500);
    expect(h.statusChanges).toBeGreaterThan(afterEdit);
  });
});

describe("what the receiver ends up with", () => {
  it("after transient failures, a floor and merging, the receiver's state equals the writer's", async () => {
    const writer = typist();
    const sent: Uint8Array[] = [];
    let attempts = 0;
    const scheduler = new SendScheduler({
      quietMs: 200,
      policy: resolveSyncPolicy({ minIntervalMs: 3000, maxIntervalMs: 30_000 }),
      send: async (update) => {
        attempts += 1;
        if (attempts <= 3) {
          throw new Error("transient");
        }
        sent.push(update);
      },
      classify: () => ({ retryable: true }),
      onDropped: () => {},
    });
    for (const char of "the quick brown fox") {
      scheduler.enqueue(writer.type(char), 1);
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS);
    const received = seededDocument();
    for (const update of sent) {
      applyUpdate(received, update);
    }
    expect(getPlainText(getFragment(received))).toBe("the quick brown fox");
    expect(encodeStateVector(received)).toEqual(encodeStateVector(writer.doc));
  });
});
