import {
  createDocument,
  getFragment,
  insertPlainText,
  observeUpdates,
  transact,
} from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type SendFailureClass, SendScheduler, type SendStatus } from "./send-scheduler";
import { resolveSyncPolicy } from "./sync-policy";

/**
 * The failure streak: what the application is told while a change waits after a refusal (SPECIFICATION.md
 * SND-7, SND-10, TRN-20), and how each outcome of a send sets or ends each part of it. Sends overlap
 * where one takes longer than the floor, so a send can have started before the hold now in force — before
 * the latest refusal worth retrying of any message — or after it.
 *
 * A message is *kept* where the scheduler retries it: an edit or a piece of one, a piece of an answer, a
 * message submitted with `retry` (a control frame, CTL-26). A request, an answer sent whole, a close sent
 * again and a report's messages are not. The parts:
 *
 * - **streak**: the failures counted, the last failure's words and whether only the person can lift it —
 *   `status.failures`, `lastError`, `state` `retrying` or `needs-person`. While it lasts, no report goes
 *   (SND-11).
 * - **mark**: how many sends had started when the latest hold began; a send is *before* the hold when it
 *   started by then, *after* it otherwise.
 * - **hold**: the back-off, the wait the provider asked for, the wait for the person, and the back-off's
 *   doubling (SND-7, TRN-20).
 * - **report hold**: the report's own back-off and its doubling (SND-12).
 * - **next attempt**: `status.nextAttemptAt`, when the timer sends what waits; `null` when nothing waits.
 *
 * | outcome      | message  | started | streak                                                    | mark | hold                        | report hold |
 * |--------------|----------|---------|-----------------------------------------------------------|------|-----------------------------|-------------|
 * | success      | kept     | after   | ends                                                      | –    | ends                        | ends        |
 * | success      | kept     | before  | ends where no kept message waits or is under way, else stays | – | stays                      | stays       |
 * | unavailable  | kept     | either  | +1; its words, unless a hold for the person lasts and the streak waits for the person | set | back-off, doubling | – |
 * | rate-limited | kept     | either  | as `unavailable`                                          | set  | back-off or the wait asked, if longer; spacing widened (SND-9) | – |
 * | needs-person | kept     | either  | +1; its words; waits for the person; dropped later with its group, as `needs-person` not kept | set | for the person: the longest back-off | – |
 * | rejected     | kept     | after   | ends (the message is dropped, SND-8)                      | –    | –                           | –           |
 * | rejected     | kept     | before  | as a success before                                       | –    | –                           | –           |
 * | cannot be cut | kept    | no send | ends where no kept message waits or is under way, else stays (SND-19) | – | –             | –           |
 * | success      | not kept | after   | –                                                         | –    | ends                        | ends        |
 * | success      | not kept | before  | –                                                         | –    | –                           | –           |
 * | unavailable  | not kept | either  | –                                                         | set  | back-off, doubling          | –           |
 * | unavailable  | a report | either  | – (no streak lasts while a report goes)                   | set  | –                           | its back-off, doubling |
 * | rate-limited | not kept | either  | –                                                         | set  | back-off or the wait asked; spacing widened | – |
 * | needs-person | not kept | either  | –; while the hold lasts, the status shows `needs-person` with its words | set | for the person | – |
 * | rejected     | not kept | either  | – (a report is given up)                                  | –    | –                           | –           |
 *
 * After every outcome the next attempt is set again: the hold's end where a kept message waits, `null`
 * where none does. No report goes while a send of this client's own is under way, a first try as a
 * retry: it may go on with the phase, whose one report then follows it (SND-11). A failure worth retrying at a final flush, or once the scheduler stopped, counts as
 * `rejected`. Hence: while the streak lasts, a kept message waits or is under way — a streak with none
 * left would show `retrying` without end, and the report owed would never go (SND-11).
 *
 * Each row below sets one cell up on a fake clock — the floor 1 s, the longest back-off 60 s, a wait asked
 * of 30 s, the send `X` under way for 10 s — and checks the status as `X` ends, what goes next, and that
 * everything settles: idle, nothing owed.
 */

const T0 = 1_000_000;
const SEND_MS = 10_000;
const ASKED_MS = 30_000;
const LONGEST_MS = 60_000;

type Outcome = "success" | "unavailable" | "rate-limited" | "needs-person" | "rejected";

/** How long a send takes, and how it fails as it ends, if it does. */
interface Plan {
  /** What the log calls this attempt, if not the message's label. */
  readonly label?: string;
  readonly takes?: number;
  readonly fails?: Exclude<Outcome, "success">;
}

/** A failure's words say its kind: `"<label>: <kind>"`. */
function classify(error: unknown): SendFailureClass {
  const kind = String(error instanceof Error ? error.message : error).split(": ")[1];
  switch (kind) {
    case "unavailable":
      return { retryable: true };
    case "rate-limited":
      return { retryable: true, rateLimited: true, retryAfterMs: ASKED_MS };
    case "needs-person":
      return { retryable: true, needsPerson: true };
    default:
      return { retryable: false };
  }
}

/**
 * A scheduler on the fake clock whose edits' sends follow `edits`, one plan per attempt in order, and
 * succeed at once after them; reports follow `reports` likewise, and each frame — a piece — those `frames`
 * name for it. Every send is logged with its label, when it started and ended (ms after T0), and how it
 * failed.
 */
function rig(options: {
  edits: { label: string; plan: Plan }[];
  reports?: Plan[];
  cutLimit?: number;
  /** The frames a change larger than `cutLimit` is cut into; without them it cannot be cut. */
  pieces?: string[];
  frames?: Record<string, Plan[]>;
}) {
  const log: { label: string; at: number; endedAt?: number; failed?: string }[] = [];
  const edits = [...options.edits];
  const reports = [...(options.reports ?? [])];
  const frames: Record<string, Plan[]> = Object.fromEntries(
    Object.entries(options.frames ?? {}).map(([frame, plans]) => [frame, [...plans]]),
  );
  const dropped: unknown[] = [];
  /** The status each time the application is told it changed. */
  const told: string[] = [];
  async function perform(name: string, plan: Plan): Promise<void> {
    const label = plan.label ?? name;
    const entry: (typeof log)[number] = { label, at: Date.now() - T0 };
    log.push(entry);
    if ((plan.takes ?? 0) > 0) {
      await new Promise((resolve) => setTimeout(resolve, plan.takes));
    }
    entry.endedAt = Date.now() - T0;
    if (plan.fails !== undefined) {
      entry.failed = plan.fails;
      throw new Error(`${label}: ${plan.fails}`);
    }
  }
  const scheduler = new SendScheduler({
    quietMs: 0,
    policy: resolveSyncPolicy({ minIntervalMs: 1_000, maxIntervalMs: LONGEST_MS }),
    send: () => {
      const next = edits.shift() ?? { label: "edit", plan: {} };
      return perform(next.label, next.plan);
    },
    classify,
    onDropped: (error) => dropped.push(error),
    onStatusChange: () => told.push(short(scheduler.status)),
    report: () => [() => perform("report", reports.shift() ?? {})],
    // A transport whose messages carry at most `cutLimit` bytes, and a change larger cut into `pieces` —
    // or, without them, one that cannot be cut (SND-19): it is dropped before any send.
    ...(options.cutLimit === undefined && options.frames === undefined
      ? {}
      : {
          splitting: {
            maxBytes: options.cutLimit ?? Number.MAX_SAFE_INTEGER,
            frameSize: (update: Uint8Array) => update.length,
            pieces: () => {
              if (options.pieces === undefined) {
                throw new Error("paste: rejected");
              }
              return options.pieces;
            },
            sendFrame: (frame: string) => perform(frame, frames[frame]?.shift() ?? {}),
          },
        }),
  });
  const doc = createDocument();
  const updates: Uint8Array[] = [];
  observeUpdates(doc, (update) => updates.push(update));
  let length = 0;
  return {
    scheduler,
    log,
    dropped,
    told,
    /** A local edit of one character, or of `chars` at once (a paste). */
    type(chars = 1): void {
      transact(doc, () => insertPlainText(getFragment(doc), length, "x".repeat(chars)));
      length += chars;
      scheduler.enqueue(updates.at(-1) as Uint8Array, chars);
    },
    /** A message submitted, kept for a retry where `retry` is set, following `plans` attempt by attempt. */
    submit(
      label: string,
      plans: Plan[],
      options: { retry?: boolean; control?: boolean } = {},
    ): void {
      const queue = [...plans];
      scheduler
        .submit(() => perform(label, queue.shift() ?? {}), {
          retry: options.retry === true,
          ...(options.control === true ? { phase: { kind: "control" as const, text: label } } : {}),
        })
        .catch(() => {});
    },
    /**
     * Frames queued to go together: an answer's pieces, or — `own` — those of `resync()`'s whole state.
     * Whoever queued them hears of their drop (SND-8).
     */
    enqueueFrames(labels: string[], own: boolean): void {
      scheduler.enqueueFrames(labels, { own }).catch(() => {});
    },
    /** The status in short: `state/failures/lastError/nextAttemptAt` (ms after T0, or `-`). */
    status(): string {
      return short(scheduler.status);
    },
    started(label: string): number[] {
      return log.filter((entry) => entry.label === label).map((entry) => entry.at);
    },
  };
}

type Rig = ReturnType<typeof rig>;

/** A status in short: `state/failures/lastError/nextAttemptAt` (ms after T0, or `-`). */
function short(s: SendStatus): string {
  return `${s.state}/${s.failures}/${s.lastError ?? "-"}/${s.nextAttemptAt === null ? "-" : s.nextAttemptAt - T0}`;
}

/** Runs the fake clock to `ms` after T0, and what the sends ending then set off. */
async function until(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(T0 + ms - Date.now());
  await vi.advanceTimersByTimeAsync(0);
}

/** Everything settles: nothing waits, no streak, no report owed, no send under way. */
async function settles(r: Rig): Promise<void> {
  await vi.advanceTimersByTimeAsync(15 * LONGEST_MS);
  expect(r.status()).toBe("idle/0/-/-");
  expect(r.scheduler.status.reportOwed).toBe(false);
  expect(r.log.filter((entry) => entry.endedAt === undefined)).toStrictEqual([]);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * Kept, alone: `A`, an edit or a decision submitted with `retry`, is refused as unavailable at once; `X`,
 * its retry, starts at 1 s and ends at 11 s. *Before*: a request `H`, not kept, is refused as unavailable at
 * 2 s, while `X` is under way: the hold now in force began after `X` started. No other kept message.
 */
function keptAlone(
  started: "before" | "after",
  outcome: Outcome,
  kept: "edit" | "decision" = "edit",
): Rig {
  const x: Plan = {
    label: "X",
    takes: SEND_MS,
    ...(outcome === "success" ? {} : { fails: outcome }),
  };
  const r = rig({
    edits:
      kept === "edit"
        ? [
            { label: "A", plan: { fails: "unavailable" } },
            { label: "X", plan: x },
          ]
        : [],
  });
  if (kept === "edit") {
    r.type();
  } else {
    r.submit("A", [{ fails: "unavailable" }, x], { retry: true, control: true });
  }
  if (started === "before") {
    setTimeout(() => r.submit("H", [{ fails: "unavailable" }]), 1_500);
  }
  return r;
}

describe("the failure streak, a kept message alone (SND-7, SND-10, SND-11)", () => {
  const rows: { started: "before" | "after"; outcome: Outcome; atEnd: string; next?: string }[] = [
    // The streak ends with the last kept message: as it goes, or is dropped, whenever it started.
    { started: "after", outcome: "success", atEnd: "idle/0/-/-", next: "report at 21000" },
    { started: "before", outcome: "success", atEnd: "idle/0/-/-", next: "report at 21000" },
    { started: "after", outcome: "rejected", atEnd: "idle/0/-/-" },
    { started: "before", outcome: "rejected", atEnd: "idle/0/-/-" },
    // Worth retrying: it is kept, the streak counts it, and the hold doubles (2 s after one hold, 4 s after two).
    { started: "after", outcome: "unavailable", atEnd: "retrying/2/X: unavailable/13000" },
    { started: "before", outcome: "unavailable", atEnd: "retrying/2/X: unavailable/15000" },
    { started: "after", outcome: "rate-limited", atEnd: "retrying/2/X: rate-limited/41000" },
    { started: "before", outcome: "rate-limited", atEnd: "retrying/2/X: rate-limited/41000" },
    { started: "after", outcome: "needs-person", atEnd: "needs-person/2/X: needs-person/71000" },
    { started: "before", outcome: "needs-person", atEnd: "needs-person/2/X: needs-person/71000" },
  ];
  for (const kept of ["edit", "decision"] as const) {
    for (const { started, outcome, atEnd, next } of rows) {
      it(`X, a kept ${kept}, started ${started} the hold, ends ${outcome}: ${atEnd}${next === undefined ? "" : `, then the ${next}`}`, async () => {
        const r = keptAlone(started, outcome, kept);
        await until(SEND_MS + 1_000);
        expect(r.started("X")).toStrictEqual([1_000]);
        expect(r.started("H")).toStrictEqual(started === "before" ? [2_000] : []);
        expect(r.status()).toBe(atEnd);
        if (next !== undefined) {
          await until(SEND_MS + 1_000 + 10_000);
          expect(r.started("report")).toStrictEqual([21_000]);
        }
        // An edit refused for good is reported through `onDropped`; a decision, to whoever submitted it.
        expect(r.dropped).toHaveLength(outcome === "rejected" && kept === "edit" ? 1 : 0);
        await settles(r);
      });
    }
  }

  it("the retry of the last kept change under way as a request is refused, ending after it: not `retrying` for 30 minutes, and the report owed goes (SND-10, SND-11)", async () => {
    for (const outcome of ["success", "rejected"] as const) {
      vi.setSystemTime(T0);
      const r = keptAlone("before", outcome);
      await until(SEND_MS + 1_000);
      const x = r.log.find((entry) => entry.label === "X") as { at: number; endedAt: number };
      const h = r.log.find((entry) => entry.label === "H") as { at: number; failed: string };
      // The retry started before the request's refusal and ended after it.
      expect(x.at).toBeLessThan(h.at);
      expect(x.endedAt).toBeGreaterThan(h.at);
      expect(h.failed).toBe("unavailable");
      expect(r.scheduler.hasPending).toBe(false);
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(r.status()).toBe("idle/0/-/-");
      // The success went on with the phase, whose report is owed and goes 10 s later; a change dropped
      // began none.
      expect(r.started("report")).toStrictEqual(outcome === "success" ? [21_000] : []);
      expect(r.scheduler.status.reportOwed).toBe(false);
      r.scheduler.stop();
    }
  });
});

/**
 * Kept, beside a kept message that waits: edit `A` is refused as unavailable at once; `X`, its retry, starts
 * at 1 s; `K`, a decision submitted with `retry`, is refused at 2 s as `refusal` says and waits for its
 * retry, while `X` is under way; `X` ends at 11 s.
 */
function keptBesideWaiting(refusal: "rate-limited" | "needs-person", outcome: Outcome): Rig {
  const r = rig({
    edits: [
      { label: "A", plan: { fails: "unavailable" } },
      {
        label: "X",
        plan: { takes: SEND_MS, ...(outcome === "success" ? {} : { fails: outcome }) },
      },
    ],
  });
  r.type();
  setTimeout(() => r.submit("K", [{ fails: refusal }], { retry: true, control: true }), 1_500);
  return r;
}

describe("the failure streak, a kept message beside another that waits (SND-7, TRN-20)", () => {
  const rows: { refusal: "rate-limited" | "needs-person"; outcome: Outcome; atEnd: string }[] = [
    // The streak is about K, which still waits: X's end, whichever, leaves it as K's refusal set it.
    { refusal: "rate-limited", outcome: "success", atEnd: "retrying/2/K: rate-limited/32000" },
    { refusal: "rate-limited", outcome: "rejected", atEnd: "retrying/2/K: rate-limited/32000" },
    { refusal: "needs-person", outcome: "success", atEnd: "needs-person/2/K: needs-person/62000" },
    { refusal: "needs-person", outcome: "rejected", atEnd: "needs-person/2/K: needs-person/62000" },
    // X refused worth retrying: counted; its words, unless the streak waits for the person and that hold lasts.
    { refusal: "rate-limited", outcome: "unavailable", atEnd: "retrying/3/X: unavailable/32000" },
    {
      refusal: "needs-person",
      outcome: "unavailable",
      atEnd: "needs-person/3/K: needs-person/62000",
    },
    { refusal: "rate-limited", outcome: "rate-limited", atEnd: "retrying/3/X: rate-limited/41000" },
    {
      refusal: "needs-person",
      outcome: "rate-limited",
      atEnd: "needs-person/3/K: needs-person/62000",
    },
    {
      refusal: "rate-limited",
      outcome: "needs-person",
      atEnd: "needs-person/3/X: needs-person/71000",
    },
    {
      refusal: "needs-person",
      outcome: "needs-person",
      atEnd: "needs-person/3/X: needs-person/71000",
    },
  ];
  for (const { refusal, outcome, atEnd } of rows) {
    it(`X, kept, started before K's ${refusal} refusal, ends ${outcome}: ${atEnd}`, async () => {
      const r = keptBesideWaiting(refusal, outcome);
      await until(SEND_MS + 1_000);
      expect(r.started("X")).toStrictEqual([1_000]);
      expect(r.started("K")).toStrictEqual([2_000]);
      expect(r.status()).toBe(atEnd);
      await settles(r);
    });
  }
});

/**
 * Kept, beside a kept piece that waits in the outbox: the pieces `P1` and `P2` of an answer, or of
 * `resync()`'s whole state, are queued at 0 s; `P1` goes at once and takes 10 s; a request `R`, submitted at
 * 0.5 s, goes through at 1 s, and the scheduler looks again: `P2` goes at 2 s and is refused as rate-limited,
 * kept in the outbox until the 30 s asked passed. `P1`, begun before that hold, then goes through.
 */
describe("the failure streak, a kept piece that waits in the outbox (SND-7, SND-17)", () => {
  for (const own of [false, true]) {
    it(`P1, a piece of ${own ? "`resync()`'s" : "an answer"}, started before P2's refusal, goes through while P2 waits: the streak about P2 stays`, async () => {
      const r = rig({
        edits: [],
        frames: { P1: [{ takes: SEND_MS }], P2: [{ fails: "rate-limited" }, {}] },
      });
      r.enqueueFrames(["P1", "P2"], own);
      setTimeout(() => r.submit("R", [{}]), 500);
      await until(2_001);
      expect(r.status()).toBe("retrying/1/P2: rate-limited/32000");
      await until(SEND_MS + 1);
      expect(r.started("P1")).toStrictEqual([0]);
      expect(r.status()).toBe("retrying/1/P2: rate-limited/32000");
      await settles(r);
      expect(r.log.map((entry) => `${entry.label}@${entry.at}`)).toStrictEqual([
        "P1@0",
        "R@1000",
        "P2@2000",
        "P2@32000",
      ]);
    });
  }
});

/**
 * Kept, beside a kept message under way: `A` is refused as unavailable at once; `X`, its retry, starts at
 * 1 s and ends at 11 s; `K`, another kept message, starts at 2 s. Either `A` is an edit and `K` a decision
 * submitted with `retry`, or `A` that decision and `K` an edit. *Before*: `K` is refused as unavailable at
 * once, while `X` is under way, and its retry goes from 4 s to 24 s. *After*: `K` goes from 2 s to 22 s.
 */
function keptBesideUnderWay(
  started: "before" | "after",
  outcome: "success" | "rejected",
  kept: "edit" | "decision",
): Rig {
  const x: Plan = {
    label: "X",
    takes: SEND_MS,
    ...(outcome === "success" ? {} : { fails: outcome }),
  };
  const k: Plan[] =
    started === "before"
      ? [
          { label: "K", fails: "unavailable" },
          { label: "K", takes: 2 * SEND_MS },
        ]
      : [{ label: "K", takes: 2 * SEND_MS }];
  if (kept === "edit") {
    const r = rig({
      edits: [
        { label: "A", plan: { fails: "unavailable" } },
        { label: "X", plan: x },
      ],
    });
    r.type();
    setTimeout(() => r.submit("K", k, { retry: true, control: true }), 1_200);
    return r;
  }
  const r = rig({ edits: k.map((plan) => ({ label: "K", plan })) });
  r.submit("A", [{ fails: "unavailable" }, x], { retry: true, control: true });
  setTimeout(() => r.type(), 1_200);
  return r;
}

describe("the failure streak, a kept message beside another under way (SND-7, SND-11)", () => {
  for (const kept of ["edit", "decision"] as const) {
    for (const outcome of ["success", "rejected"] as const) {
      it(`X, a kept ${kept}, started before K's refusal, ends ${outcome} while K's retry is under way: the streak stays until K went, and one report goes, 10 s after K`, async () => {
        const r = keptBesideUnderWay("before", outcome, kept);
        await until(SEND_MS + 1_000);
        expect(r.started("K")).toStrictEqual([2_000, 4_000]);
        expect(r.status()).toBe("retrying/2/K: unavailable/-");
        await until(2 * SEND_MS + 4_000);
        expect(r.status()).toBe("idle/0/-/-");
        await settles(r);
        // None while K is retried (SND-11): only K's phase's own.
        expect(r.started("report")).toStrictEqual([34_000]);
      });

      it(`X, a kept ${kept}, started after the hold, ends ${outcome} while K is under way: the streak ends with X`, async () => {
        const r = keptBesideUnderWay("after", outcome, kept);
        await until(SEND_MS + 1_000);
        expect(r.started("K")).toStrictEqual([2_000]);
        expect(r.status()).toBe("idle/0/-/-");
        await settles(r);
      });
    }
  }
});

/**
 * Not kept. *Before*: `X`, a request, starts at 0 s; edit `A` is refused as rate-limited at 1 s, while it
 * is under way, and waits until 31 s; `X` ends at 10 s. *After*: edit `A` is refused as unavailable at
 * once; `X` starts at 1 s, after that hold began, and ends at 11 s; `A`'s retry, with an edit typed at
 * 1.5 s, starts at 2 s and is refused
 * as unavailable at 22 s, which shows whether `X` ended the back-off's doubling.
 */
function notKept(started: "before" | "after", outcome: Outcome): Rig {
  const x = { takes: SEND_MS, ...(outcome === "success" ? {} : { fails: outcome }) };
  if (started === "before") {
    const r = rig({ edits: [{ label: "A", plan: { fails: "rate-limited" } }] });
    r.submit("X", [x]);
    setTimeout(() => r.type(), 500);
    return r;
  }
  const r = rig({
    edits: [
      { label: "A", plan: { fails: "unavailable" } },
      { label: "A", plan: { takes: 2 * SEND_MS, fails: "unavailable" } },
    ],
  });
  r.type();
  setTimeout(() => r.submit("X", [x]), 500);
  // An edit typed meanwhile sets the timer again, which sends A's retry, with it, while X is under way.
  setTimeout(() => r.type(), 1_500);
  return r;
}

describe("the failure streak and a message not kept (SND-7, SND-10)", () => {
  const rows: { started: "before" | "after"; outcome: Outcome; atEnd: string; third?: number }[] = [
    // Before: the streak is A's; X's end leaves it, and only a refusal worth retrying holds longer.
    { started: "before", outcome: "success", atEnd: "retrying/1/A: rate-limited/31000" },
    { started: "before", outcome: "rejected", atEnd: "retrying/1/A: rate-limited/31000" },
    { started: "before", outcome: "unavailable", atEnd: "retrying/1/A: rate-limited/31000" },
    { started: "before", outcome: "rate-limited", atEnd: "retrying/1/A: rate-limited/40000" },
    // Refused as needing the person: that hold is shown, with its words, while it lasts (TRN-20).
    { started: "before", outcome: "needs-person", atEnd: "needs-person/1/X: needs-person/70000" },
    // After: A's retry is under way, so nothing waits for the timer. A success ends the back-off's
    // doubling, so A's next refusal holds 1 s; else it doubles on, or the wait asked or for the person holds.
    { started: "after", outcome: "success", atEnd: "retrying/1/A: unavailable/-", third: 23_000 },
    { started: "after", outcome: "rejected", atEnd: "retrying/1/A: unavailable/-", third: 24_000 },
    {
      started: "after",
      outcome: "unavailable",
      atEnd: "retrying/1/A: unavailable/-",
      third: 26_000,
    },
    {
      started: "after",
      outcome: "rate-limited",
      atEnd: "retrying/1/A: unavailable/-",
      third: 41_000,
    },
    {
      started: "after",
      outcome: "needs-person",
      atEnd: "needs-person/1/X: needs-person/-",
      third: 71_000,
    },
  ];
  for (const { started, outcome, atEnd, third } of rows) {
    it(`X, not kept, started ${started} the hold, ends ${outcome}: ${atEnd}${third === undefined ? "" : `, A's third try at ${third}`}`, async () => {
      const r = notKept(started, outcome);
      const end = started === "before" ? SEND_MS : SEND_MS + 1_000;
      await until(end);
      expect(r.started("X")).toStrictEqual([started === "before" ? 0 : 1_000]);
      expect(r.started("A")).toStrictEqual(started === "before" ? [1_000] : [0, 2_000]);
      expect(r.status()).toBe(atEnd);
      if (third !== undefined) {
        await until(third + 1);
        // A's third try, its plans used up.
        expect(r.started("edit")).toStrictEqual([third]);
      }
      await settles(r);
    });
  }
});

/**
 * A report: never while a streak lasts (SND-11), so its outcome sets none (SND-10); a refusal only the
 * person can lift is shown while its hold lasts (TRN-20). Edit `E` goes at 0 s;
 * the report goes at 10 s and ends as the row says; an edit typed at 10.5 s, while the report's refusal
 * holds what it holds, shows which hold.
 */
describe("the failure streak and a report (SND-10, SND-12)", () => {
  const rows: { outcome: Outcome; after: string; edit: number; reports: number[] }[] = [
    { outcome: "success", after: "idle/0/-/-", edit: 11_000, reports: [10_000, 21_000] },
    // Only the report waits, and it is not shown (SND-10): the edit goes at the floor, the report at the
    // end of its phase.
    { outcome: "unavailable", after: "idle/0/-/-", edit: 11_000, reports: [10_000, 21_000] },
    { outcome: "rate-limited", after: "idle/0/-/-", edit: 40_000, reports: [10_000, 50_000] },
    // Every send waits for the person, and the status says so (TRN-20).
    {
      outcome: "needs-person",
      after: "needs-person/0/report: needs-person/-",
      edit: 70_000,
      reports: [10_000, 80_000],
    },
    // Given up: owed no more; the edit's phase owes its own.
    { outcome: "rejected", after: "idle/0/-/-", edit: 11_000, reports: [10_000, 21_000] },
  ];
  for (const { outcome, after, edit, reports } of rows) {
    it(`a report ends ${outcome}: ${after}, the next edit at ${edit}, reports at ${reports.join(", ")}`, async () => {
      const r = rig({
        edits: [{ label: "E", plan: {} }],
        reports: [outcome === "success" ? {} : { fails: outcome }],
      });
      r.type();
      await until(10_000);
      expect(r.started("report")).toStrictEqual([10_000]);
      expect(r.status()).toBe(after);
      await until(10_500);
      r.type();
      await until(edit + 1);
      expect(r.started("edit")).toStrictEqual([edit]);
      await settles(r);
      expect(r.started("report")).toStrictEqual(reports);
    });
  }
});

describe("a refusal only the person can lift of a message not kept (SND-10, TRN-20, TRN-22)", () => {
  it("is shown, with its words, while its hold lasts, and the application is told as it ends; nothing else goes", async () => {
    const r = rig({ edits: [] });
    r.submit("R", [{ fails: "needs-person" }]);
    await until(0);
    expect(r.status()).toBe("needs-person/0/R: needs-person/-");
    await until(10_000);
    // An edit made meanwhile waits for the same hold.
    r.type();
    expect(r.status()).toBe(`needs-person/0/R: needs-person/${LONGEST_MS}`);
    await until(LONGEST_MS - 1);
    expect(r.log.map((entry) => entry.label)).toStrictEqual(["R"]);
    await until(LONGEST_MS);
    expect(r.started("edit")).toStrictEqual([LONGEST_MS]);
    expect(r.told.at(-1)).toBe("idle/0/-/-");
    await settles(r);
  });

  it("with nothing waiting, its end by time is told too", async () => {
    const r = rig({ edits: [] });
    r.submit("R", [{ fails: "needs-person" }]);
    await until(LONGEST_MS - 1);
    expect(r.status()).toBe("needs-person/0/R: needs-person/-");
    const before = r.told.length;
    await until(LONGEST_MS);
    expect(r.status()).toBe("idle/0/-/-");
    expect(r.told.slice(before)).toStrictEqual(["idle/0/-/-"]);
    expect(r.log.map((entry) => entry.label)).toStrictEqual(["R"]);
  });

  it("ends as the person acted: a send at once lifts it, and the application is told", async () => {
    const r = rig({ edits: [] });
    r.submit("R", [{ fails: "needs-person" }]);
    await until(5_000);
    const before = r.told.length;
    await r.scheduler.flush();
    expect(r.status()).toBe("idle/0/-/-");
    expect(r.told.slice(before)).toStrictEqual(["idle/0/-/-"]);
  });
});

/**
 * A kept piece refused as only the person can lift, then dropped with its group: the pieces `P1` to `P3` of
 * an answer, or of `resync()`'s whole state, are queued at 0 s; `P1` goes at once and is refused for good at
 * 10 s; a request `R` goes through, and the scheduler looks again: `P2` goes and is refused as only the
 * person can lift, kept, and every send waits for the person for the longest back-off. `P1`'s refusal
 * drops the rest of its group, `P2` with it (SND-17): nothing of the message refused is kept, and sending
 * still waits for the person (TRN-20). Alone, `R` is submitted at 0.5 s and goes at 1 s, `P2` at 2 s. *Beside*
 * a decision `K` submitted with `retry` at 0.2 s: `K` goes at 1 s and takes 20 s, ending as the row says;
 * `R`, at 1.5 s, goes at 2 s, `P2` at 3 s. An edit typed after the last of them ended shows the hold.
 */
describe("the failure streak and a kept piece refused as only the person can lift, then dropped with its group (SND-10, SND-17, TRN-20)", () => {
  const rows: {
    beside: "none" | "success" | "rejected" | "unavailable";
    /** The status as `P1` ends, and as `K` ends, if it is there. */
    atP1: string;
    atK?: string;
    /** Every send in order, `label@start`: the edit's phase owes its report 10 s after it. */
    sends: string[];
  }[] = [
    // Nothing kept is left as P1 ends: the streak ends, the hold for the person is shown while it lasts.
    {
      beside: "none",
      atP1: "needs-person/0/P2: needs-person/-",
      sends: ["P1@0", "R@1000", "P2@2000", "edit@62000", "report@72000"],
    },
    // K, kept and under way, keeps the streak until it settles; then as alone.
    {
      beside: "success",
      atP1: "needs-person/1/P2: needs-person/-",
      atK: "needs-person/0/P2: needs-person/-",
      sends: ["P1@0", "K@1000", "R@2000", "P2@3000", "edit@63000", "report@73000"],
    },
    {
      beside: "rejected",
      atP1: "needs-person/1/P2: needs-person/-",
      atK: "needs-person/0/P2: needs-person/-",
      sends: ["P1@0", "K@1000", "R@2000", "P2@3000", "edit@63000", "report@73000"],
    },
    // K refused worth retrying: counted; the hold for the person lasts, so the words stay P2's.
    {
      beside: "unavailable",
      atP1: "needs-person/1/P2: needs-person/-",
      atK: "needs-person/2/P2: needs-person/63000",
      sends: ["P1@0", "K@1000", "R@2000", "P2@3000", "K@63000", "edit@64000", "report@74000"],
    },
  ];
  for (const own of [false, true]) {
    for (const { beside, atP1, atK, sends } of rows) {
      it(`pieces of ${own ? "`resync()`'s whole state" : "an answer"}, ${beside === "none" ? "alone" : `beside K ending ${beside}`}: ${atK ?? atP1}, and the hold for the person shown until it ends`, async () => {
        const r = rig({
          edits: [],
          frames: { P1: [{ takes: SEND_MS, fails: "rejected" }], P2: [{ fails: "needs-person" }] },
        });
        r.enqueueFrames(["P1", "P2", "P3"], own);
        if (beside !== "none") {
          const k: Plan = {
            takes: 2 * SEND_MS,
            ...(beside === "success" ? {} : { fails: beside }),
          };
          setTimeout(() => r.submit("K", [k], { retry: true, control: true }), 200);
        }
        setTimeout(() => r.submit("R", [{}]), beside === "none" ? 500 : 1_500);
        const p2At = beside === "none" ? 2_000 : 3_000;
        const holdEnd = p2At + LONGEST_MS;
        await until(p2At + 1);
        expect(r.status()).toBe(`needs-person/1/P2: needs-person/${holdEnd}`);
        await until(SEND_MS + 1);
        expect(r.status()).toBe(atP1);
        let last = SEND_MS + 1;
        if (atK !== undefined) {
          await until(2 * SEND_MS + 1_001);
          expect(r.status()).toBe(atK);
          last = 2 * SEND_MS + 1_001;
        }
        // An edit typed now waits for the person as every send does, and the status says so till the end.
        await until(last + 500);
        r.type();
        expect(r.status()).toMatch(new RegExp(`^needs-person/[0-9]/P2: needs-person/${holdEnd}$`));
        await until(holdEnd - 1);
        expect(r.status()).toMatch(/^needs-person\/[0-9]\/P2: needs-person\//);
        await settles(r);
        expect(r.log.map((entry) => `${entry.label}@${entry.at}`)).toStrictEqual(sends);
      });
    }
  }
});

/**
 * A change that cannot be cut into pieces a message carries is dropped before any send (SND-19): `A` is
 * refused as unavailable at once; `X`, its retry, starts at 1 s and fails as unavailable at 11 s; a paste
 * larger than a message, typed at 1.5 s, is dropped at 2 s, while `X` is under way.
 */
describe("the failure streak and a change that cannot be cut (SND-7, SND-19)", () => {
  for (const kept of ["edit", "decision"] as const) {
    it(`a paste that cannot be cut, dropped while X, a kept ${kept}'s retry, is under way, leaves the streak: X's refusal counts on it`, async () => {
      const x: Plan = { label: "X", takes: SEND_MS, fails: "unavailable" };
      const r = rig({
        edits:
          kept === "edit"
            ? [
                { label: "A", plan: { fails: "unavailable" } },
                { label: "X", plan: x },
              ]
            : [],
        cutLimit: 200,
      });
      if (kept === "edit") {
        r.type();
      } else {
        r.submit("A", [{ fails: "unavailable" }, x], { retry: true, control: true });
      }
      setTimeout(() => r.type(400), 1_500);
      await until(2_000);
      expect(r.dropped.map(String)).toStrictEqual(["Error: paste: rejected"]);
      expect(r.status()).toBe("retrying/1/A: unavailable/-");
      await until(SEND_MS + 1_000);
      expect(r.status()).toBe("retrying/2/X: unavailable/13000");
      await settles(r);
    });

    it(`a paste that cannot be cut, the last kept change once X, a kept ${kept}'s retry begun before the hold, went through, ends the streak as it is dropped`, async () => {
      // X goes through at 11 s; a request H, refused as rate-limited at 2 s while X is under way, holds
      // every send until 32 s; the paste typed at 5 s waits for that hold, and then cannot be cut.
      const x: Plan = { label: "X", takes: SEND_MS };
      const r = rig({
        edits:
          kept === "edit"
            ? [
                { label: "A", plan: { fails: "unavailable" } },
                { label: "X", plan: x },
              ]
            : [],
        cutLimit: 200,
      });
      if (kept === "edit") {
        r.type();
      } else {
        r.submit("A", [{ fails: "unavailable" }, x], { retry: true, control: true });
      }
      setTimeout(() => r.submit("H", [{ fails: "rate-limited" }]), 1_500);
      setTimeout(() => r.type(400), 5_000);
      await until(SEND_MS + 1_001);
      expect(r.started("X")).toStrictEqual([1_000]);
      expect(r.started("H")).toStrictEqual([2_000]);
      // X began before the hold: the paste still waits, and the streak stays.
      expect(r.status()).toBe(`retrying/1/A: unavailable/${2_000 + ASKED_MS}`);
      await until(2_000 + ASKED_MS + 1);
      expect(r.dropped.map(String)).toStrictEqual(["Error: paste: rejected"]);
      expect(r.status()).toBe("idle/0/-/-");
      await settles(r);
    });
  }
});

/**
 * One report per phase (SND-11): edit `E` goes at 0 s and begins a phase; at 5 s a message of the
 * client's own — an edit, or a decision submitted with `retry` — starts, takes 20 s, past the end the
 * phase had without it, and ends as the row says; a request `R`, not its own, goes through at 6 s, while
 * it is under way, and the scheduler looks again whether the report is due.
 */
describe("the report waits for a send of its own under way (SND-11, SND-27)", () => {
  const rows: { outcome: "success" | "rejected" | "unavailable"; reports: number[] }[] = [
    // It went on with the phase: its one report, 10 s after it.
    { outcome: "success", reports: [35_000] },
    // Refused for good: the phase ended with E, and its report goes at once (the fake clock runs a
    // timer of no delay a millisecond later).
    { outcome: "rejected", reports: [25_001] },
    // Retried after 1 s, and went then: the report 10 s after that.
    { outcome: "unavailable", reports: [36_000] },
  ];
  for (const kind of ["edit", "decision"] as const) {
    for (const { outcome, reports } of rows) {
      it(`a slow ${kind} under way as the phase would end, ${outcome}: one report, at ${reports.join(", ")}`, async () => {
        const slow: Plan = {
          label: "S",
          takes: 2 * SEND_MS,
          ...(outcome === "success" ? {} : { fails: outcome }),
        };
        const r = rig({
          edits: [
            { label: "E", plan: {} },
            ...(kind === "edit" ? [{ label: "S", plan: slow }] : []),
          ],
        });
        r.type();
        await until(5_000);
        if (kind === "edit") {
          r.type();
        } else {
          r.submit("S", [slow], { retry: true, control: true });
        }
        await until(5_500);
        r.submit("R", [{}]);
        await until(6_001);
        expect(r.started("S")).toStrictEqual([5_000]);
        expect(r.started("R")).toStrictEqual([6_000]);
        expect(r.scheduler.status.reportOwed).toBe(true);
        await settles(r);
        expect(r.started("report")).toStrictEqual(reports);
      });
    }
  }
});

/**
 * One report per phase, the last piece of its own under way (SND-11, SND-17): edit `E` goes at 0 s; a paste at
 * 5 s is cut into `S`, which goes at once, and `S2`, which goes at 6 s, takes 20 s, past the end the phase
 * had without it, and ends as the row says; a request `R` goes through at 16 s, while it is under way, and
 * the scheduler looks again whether the report is due.
 */
describe("the report waits for the last piece of its own under way (SND-11, SND-17)", () => {
  const rows: { outcome: "success" | "rejected" | "unavailable"; reports: number[] }[] = [
    { outcome: "success", reports: [36_000] },
    { outcome: "rejected", reports: [26_001] },
    { outcome: "unavailable", reports: [37_000] },
  ];
  for (const { outcome, reports } of rows) {
    it(`S2, the last piece, under way as the phase would end, ${outcome}: one report, at ${reports.join(", ")}`, async () => {
      const slow: Plan = {
        takes: 2 * SEND_MS,
        ...(outcome === "success" ? {} : { fails: outcome }),
      };
      const r = rig({
        edits: [{ label: "E", plan: {} }],
        cutLimit: 300,
        pieces: ["S", "S2"],
        frames: { S2: [slow] },
      });
      r.type();
      await until(5_000);
      r.type(400);
      await until(16_000);
      r.submit("R", [{}]);
      await until(16_001);
      expect(r.started("S")).toStrictEqual([5_000]);
      expect(r.started("S2")).toStrictEqual([6_000]);
      expect(r.started("R")).toStrictEqual([16_000]);
      expect(r.scheduler.status.reportOwed).toBe(true);
      await settles(r);
      expect(r.started("report")).toStrictEqual(reports);
    });
  }
});
