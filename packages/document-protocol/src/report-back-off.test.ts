import {
  applyUpdate,
  createDocument,
  encodeUpdate,
  ensureParagraph,
  getFragment,
  insertPlainText,
  observeUpdates,
  transact,
} from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REPORT_AFTER_MS,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  type SendFailureClass,
  SendScheduler,
} from "./send-scheduler";
import { resolveSyncPolicy } from "./sync-policy";

/**
 * A refusal of the report and what it holds back (SPECIFICATION.md SND-12, SND-7, SND-9, TRN-20): a
 * refusal the network gave holds back the report alone, and a change of one's own goes first; one only
 * the person can lift, or a refusal for a pace too fast without a wait the provider named, holds back
 * every send, as it would after a change of one's own: the provider refuses the sender, not the report.
 * The scheduler is exercised against a fake clock and a fake `send`, with real updates.
 */

const T0 = 1_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

/** A writer producing real, causally ordered updates, one character each, on a seeded paragraph. */
function typist() {
  const seed = createDocument();
  transact(seed, () => ensureParagraph(getFragment(seed)));
  const doc = createDocument();
  applyUpdate(doc, encodeUpdate(seed));
  const captured: Uint8Array[] = [];
  observeUpdates(doc, (update) => captured.push(update));
  let count = 0;
  return (): Uint8Array => {
    transact(doc, () => insertPlainText(getFragment(doc), count, "x"));
    count += 1;
    return captured.at(-1) as Uint8Array;
  };
}

/** A scheduler whose edits all go; its report fails with the errors given, `classify` saying how. */
function reporting(classify: (error: unknown) => SendFailureClass) {
  const sent: number[] = [];
  const reports: number[] = [];
  const reportFailures: unknown[] = [];
  const type = typist();
  const scheduler = new SendScheduler({
    quietMs: 0,
    policy: resolveSyncPolicy({}),
    send: async () => {
      sent.push(Date.now());
    },
    classify,
    onDropped: () => {},
    report: () => [
      async () => {
        const failure = reportFailures.shift();
        if (failure !== undefined) throw failure;
        reports.push(Date.now());
      },
    ],
  });
  return {
    scheduler,
    sent,
    reports,
    failReportWith: (...errors: unknown[]) => reportFailures.push(...errors),
    type: () => scheduler.enqueue(type(), 1),
  };
}

const failingAs =
  (message: string, failure: SendFailureClass) =>
  (error: unknown): SendFailureClass =>
    error instanceof Error && error.message === message ? failure : { retryable: true };

describe("a refusal of the report that is about the sender holds back every send (SND-12)", () => {
  it("one only the person can lift: a change of one's own made after it waits the longest back-off too (TRN-20)", async () => {
    const h = reporting(failingAs("confirm the device", { retryable: true, needsPerson: true }));
    h.type(); // out at T0
    h.failReportWith(new Error("confirm the device"));
    await vi.advanceTimersByTimeAsync(REPORT_AFTER_MS);
    expect(h.reports).toStrictEqual([]);
    h.type();
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS - 1);
    expect(h.sent).toStrictEqual([T0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sent).toStrictEqual([T0, T0 + REPORT_AFTER_MS + RETRY_MAX_MS]);
  });

  it("one for a pace too fast, without a wait named: a change of one's own made after it waits the back-off (SND-7, SND-9)", async () => {
    const h = reporting(failingAs("too fast", { retryable: true, rateLimited: true }));
    h.type(); // out at T0
    h.failReportWith(new Error("too fast"));
    await vi.advanceTimersByTimeAsync(REPORT_AFTER_MS);
    expect(h.reports).toStrictEqual([]);
    h.type();
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS - 1);
    expect(h.sent).toStrictEqual([T0]);
    await vi.advanceTimersByTimeAsync(5 * RETRY_BASE_MS);
    expect(h.sent).toHaveLength(2);
  });
});
