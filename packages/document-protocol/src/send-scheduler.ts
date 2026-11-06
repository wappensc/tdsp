import { mergeUpdates } from "@tdsp/reconciliation";
import { SteadyClock } from "./steady-clock";
import type { SyncPolicy } from "./sync-policy";

/**
 * The send scheduler (SPECIFICATION.md §9): it owns every outgoing local edit, decides
 * *when* the next message goes out, and keeps a change until a send has actually
 * succeeded. Two simpler designs fail on a real messenger: a trailing debounce sends one
 * message per typing pause, which exhausts a rate-limited provider within a minute; and a
 * queue emptied *before* sending turns a refused send into a lost change — and one lost
 * change blinds every receiver to everything that sender sends afterwards (PRF-5).
 *
 * It knows nothing about frames, permissions or messengers: `send` is handed one
 * merged Yjs update and either resolves or throws, and `classify` says whether a
 * throw is worth retrying. That keeps the timing rules testable against a fake clock.
 *
 * **A change larger than one message** (`splitting`) is always sent, over as many messages as
 * it takes, one per permitted slot. Several updates are *spread*: each message carries the
 * longest prefix of the queue whose merged frame still fits, and every piece is a valid update
 * the receiver applies as it arrives. A single update that is by itself too large is *cut*
 * into pieces, one frame each, which go out in order before anything queued behind it.
 *
 * **Every other message goes through here too** (`submit`, SPECIFICATION.md SND-2, SND-20): the
 * seed, a control message, a resync request, a resync answer. The provider counts messages,
 * not kinds, so each waits for the floor like an edit, and goes out ahead of anything queued.
 *
 * **The report** (SPECIFICATION.md §9.3, SND-11, SND-12) goes from here as well: one at the end of
 * each phase of this client's own sending, `REPORT_AFTER_MS` after the last edit or control frame of
 * its own the transport accepted, once nothing of its own waits; at once when the application asks
 * (`reportNow`, a final `flush`). Only that report carries a repeat, once: what the phase's last
 * message carried (`ReportCarry`, SND-27). One the engine asks for (`oweReport`) states only. A
 * report never holds back a change of its own (SND-12), and it is owed — observable, for the
 * application to persist — until the transport accepted it (SND-28).
 */

/** How a failed send is to be treated. `retryAfterMs` is what the provider itself asked us to wait. */
export interface SendFailureClass {
  readonly retryable: boolean;
  /** Whether the refusal says the current pace is too fast, so later sends should be spaced wider. */
  readonly rateLimited?: boolean;
  readonly retryAfterMs?: number | undefined;
  /**
   * Whether only a person can lift the refusal (`needs-person`, TRN-20): the change is kept, as
   * `retryable` says, but nothing goes out before the longest back-off, unless `flush()` asks.
   */
  readonly needsPerson?: boolean;
}

/**
 * What a message still waiting rejects with once the scheduler stopped: nothing failed, so a report
 * among them stays owed (SND-28).
 */
export class SchedulerStoppedError extends Error {
  constructor() {
    super("the send scheduler has stopped");
    this.name = "SchedulerStoppedError";
  }
}

/** A first retry after this long, doubling per consecutive failure (never less than the floor). */
export const RETRY_BASE_MS = 1000;
/** ...up to this long, or the policy's `maxIntervalMs` if that is finite and larger. */
export const RETRY_MAX_MS = 600_000;
/** A provider's own `retryAfterMs` is honoured, but never for longer than this. */
export const RETRY_AFTER_MAX_MS = 3_600_000;
/**
 * The report goes this long after the last edit or control frame of this client's own the transport
 * accepted, once nothing of its own waits (SND-11, Appendix B).
 */
export const REPORT_AFTER_MS = 10_000;
/** After a rate-limit refusal the spacing between sends grows by this factor... */
export const ADAPT_GROWTH = 1.5;
/** ...and shrinks by it again after this many sends in a row succeed. */
export const ADAPT_DECAY_STREAK = 8;

export interface SendStatus {
  /**
   * `idle`: nothing pending. `waiting`: a change is waiting for its send window.
   * `retrying`: the last send failed and the change is being retried. `needs-person`: a send was
   * refused until the person acts (TRN-20) — trust an identity, confirm a device, sign in —: a change
   * so refused is kept, and tried again after the longest back-off or on `flush()`; after such a
   * refusal of a message that is not kept — a request, an answer, a report — nothing is kept, and the
   * state lasts as long as the hold on every send, the longest back-off, or until `flush()`.
   */
  readonly state: "idle" | "waiting" | "retrying" | "needs-person";
  /**
   * Consecutive failed attempts of the pending change; `0` unless it is `retrying` or waits for the
   * person, and `0` where only a message that is not kept was refused as needing the person.
   */
  readonly failures: number;
  /** When the next attempt is due (epoch ms), if one is scheduled. */
  readonly nextAttemptAt: number | null;
  /**
   * The message of the most recent failure, while it is still unresolved; while the state is
   * `needs-person`, the words of the refusal it shows.
   */
  readonly lastError: string | null;
  /**
   * Messages of a change too large for one still waiting to go out, after the one being
   * sent: the "parts left" of a big paste. `0` when nothing has been cut into pieces.
   */
  readonly partsQueued: number;
  /**
   * Whether a report is owed (SND-11, SND-28): from the first edit or control frame of a phase the
   * transport accepted until the transport accepted the report. An application that waits for what
   * is unsent before it quits waits for this too.
   */
  readonly reportOwed: boolean;
}

/**
 * What a report carries again of this client's last message of its own that went out (SND-27): the
 * update of an edit, byte for byte as it went out, or the text of a control frame, which goes again,
 * unchanged, before the report. `null` where that message was a piece of a change sent in pieces, or
 * where nothing of its own went out yet.
 */
export type ReportCarry =
  | { readonly kind: "edit"; readonly update: Uint8Array }
  | { readonly kind: "control"; readonly text: string };

/** What a transport that limits the size of a message needs of the scheduler, and what the scheduler needs of the client. */
export interface SplittingOptions {
  /** The largest encoded message (frame) the transport carries. */
  readonly maxBytes: number;
  /** How many bytes the frame `send(update)` produces for `update` would be. */
  readonly frameSize: (update: Uint8Array) => number;
  /**
   * The frames, in order, of one piece each, for an update whose frame exceeds `maxBytes` (TDSP
   * 2.0 draft, SND-17). Throws if that is impossible.
   */
  readonly pieces: (update: Uint8Array, roots: ReadonlySet<string>) => string[];
  /** Sends a frame that is already complete — one piece. Resolves on success, throws on any failure. */
  readonly sendFrame: (frame: string) => Promise<void>;
}

export interface SendSchedulerOptions {
  /** The quiet time (`batchWindowMs`): send once no local edit has arrived for this long. `0` = send at once. */
  readonly quietMs: number;
  readonly policy: SyncPolicy;
  /** Sends one merged update, with the top-level types it changes. Resolves on success, throws on any failure. */
  readonly send: (update: Uint8Array, roots: ReadonlySet<string>) => Promise<void>;
  readonly classify: (error: unknown) => SendFailureClass;
  /**
   * A timer-driven send of a change of this client's own failed for good and the change was
   * dropped — unless whoever enqueued it waits for its outcome (`enqueueFrames`), which is told
   * instead, so that one refusal is reported once.
   */
  readonly onDropped: (error: unknown) => void;
  /** `status` changed. */
  readonly onStatusChange?: () => void;
  /**
   * The messages of one report (SPECIFICATION.md §9.3), if this client sends reports: each sends
   * one message, written when its turn comes, in order — where it ends a phase whose last message of
   * its own was a control frame of a device of the creator, that frame again, then the `heartbeat`
   * (SND-27). The scheduler sends them like any message, on the floor (SND-2), counts the report sent
   * once the last went out, and sends it again after a failure worth retrying (SND-12). A report says
   * "this is what I have, and here is my last change again", which lets a receiver heal a *final*
   * message that was lost, which nothing later would ever reveal.
   */
  readonly report?: (carry: ReportCarry | null) => ReadonlyArray<() => Promise<unknown>>;
  /** The report owed arose, carries something else, or fell (`owedReport`, SND-28). */
  readonly onReportChange?: () => void;
  /** Present when the transport limits the size of a message: what does not fit is spread or cut. */
  readonly splitting?: SplittingOptions;
  /** The clock it measures on; its engine's, so that its times compare with the engine's (§1.6). A clock of its own if not given. */
  readonly clock?: SteadyClock;
}

interface QueuedUpdate {
  readonly update: Uint8Array;
  readonly chars: number;
  /**
   * The top-level types it changes (LAY-7): updates are merged only with others that change the
   * same ones, so a change the client may send never goes out, or is refused, with one it may not.
   */
  readonly roots: ReadonlySet<string>;
  /** When the oldest edit this stands for was made; what `maxIntervalMs` counts from. */
  readonly at: number;
}

/** A frame already built, and which message it is a part of: the parts of one are dropped together. */
interface OutboxEntry {
  readonly frame: string;
  readonly group: number;
  /**
   * Whether it carries a change of this client's own — an edit's pieces, `resync()`'s — whose
   * drop leaves content nobody else may have (SND-8). A resync answer's pieces do not: a dropped
   * answer is its requester's loss, reported by whoever enqueued it, and counts toward nothing.
   */
  readonly own: boolean;
  /**
   * Whether it is a piece of a change made here, cut to fit (SND-17): it goes on with the phase of this
   * client's own sending. `resync()`'s pieces do not: the whole state is no change of its own (SND-11).
   */
  readonly phase: boolean;
}

/**
 * A message that is not a local edit, submitted whole: it waits for the floor and a back-off
 * like any message and goes ahead of everything else queued. Unless submitted with `retry`, it
 * is not retried here — whoever submitted it is told the outcome and decides.
 */
interface PriorityEntry {
  readonly run: () => Promise<unknown>;
  /**
   * Set for an edit or a control frame of this client's own: once the transport accepted it, a
   * phase of its own sending goes on from it, and the report carries this again (SND-11, SND-27).
   * Unset for a send of the whole state, a close sent again, a resync request or answer and the
   * report's own messages, which neither begin nor prolong a phase.
   */
  readonly phase: ReportCarry | undefined;
  /** Kept at the front after a retryable failure and sent again after the back-off (SND-7). */
  readonly retry: boolean;
  /** One of the report's messages: taken back when a change of this client's own comes (SND-12). */
  readonly report: boolean;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

/** The report a phase of this client's own sending owes at its end (SND-11, SND-27). */
interface PhaseReport {
  /** When the last edit or control frame of its own in the phase went out, or it was given back. */
  readonly since: number;
  /** Whether it goes as soon as the floor permits: on the close, before sleep, given back (SND-28). */
  readonly atOnce: boolean;
  /** The last the phase sent of a change or decision of its own, carried again once (SND-27). */
  readonly carry: ReportCarry | null;
}

/** A report owed for what it states alone, after a merge, SND-24 or a bootstrap (SND-11, SND-27). */
interface StateReport {
  readonly since: number;
  readonly atOnce: boolean;
}

/** A report handed over to go out, with what of what is owed it settles once it went. */
interface ReportSending {
  readonly phase: PhaseReport | null;
  readonly state: StateReport | null;
}

/** What a message of a report waiting to go is rejected with when a change of its own comes (SND-12). */
class ReportWithdrawn extends Error {}

/** What one attempt sends: a merged prefix of the queue, or a piece's frame already built. */
type Outgoing =
  | { readonly kind: "update"; readonly item: QueuedUpdate }
  | { readonly kind: "frame"; readonly entry: OutboxEntry };

export class SendScheduler {
  readonly #quietMs: number;
  #policy: SyncPolicy;
  readonly #send: (update: Uint8Array, roots: ReadonlySet<string>) => Promise<void>;
  readonly #classify: (error: unknown) => SendFailureClass;
  readonly #onDropped: (error: unknown) => void;
  readonly #onStatusChange: (() => void) | undefined;
  readonly #reportMessages:
    | ((carry: ReportCarry | null) => ReadonlyArray<() => Promise<unknown>>)
    | undefined;
  readonly #onReportChange: (() => void) | undefined;
  readonly #splitting: SplittingOptions | undefined;

  #updates: QueuedUpdate[] = [];
  // Frames already built and waiting to go out, in order, ahead of everything in #updates:
  // the pieces of a change too large for one message, or of a large answer to a joiner.
  #outbox: OutboxEntry[] = [];
  // Whole messages that are not local edits (`submit`), ahead of everything else.
  #priority: PriorityEntry[] = [];
  #nextGroup = 0;
  // Whoever enqueued a group of frames (`enqueueFrames`) and waits to hear that all of them went
  // out, or that the group was dropped: by group, with how many frames are still to go.
  readonly #groupWaiters = new Map<
    number,
    { remaining: number; resolve: () => void; reject: (error: unknown) => void }
  >();
  // The report the phase of this client's own sending that is open owes (SND-11), `null` when none is:
  // from the first edit or control frame of its own the transport accepted until the transport
  // accepted the report that ends it (SND-28). Only it carries a repeat (SND-27).
  #phaseReport: PhaseReport | null = null;
  // A report owed for what it states alone (SND-11, SND-24), `null` when none is.
  #stateReport: StateReport | null = null;
  // The report handed over to go out, until it went, was given up or taken back: never two at once.
  #reportSending: ReportSending | null = null;
  // The back-off of the report alone, after failures worth retrying that hold back no other send
  // (SND-12): it doubles with them as SND-7's does, and a success or a return ends it.
  #reportHeldUntil = 0;
  #reportFailures = 0;
  // How many sends started so far, and how many had when the latest hold or back-off began: only a
  // success of a send started after it ends it (SND-7, SND-12). One started before — sends may take
  // longer than the floor, and so overlap — says nothing of the provider after its refusal.
  #sendsStarted = 0;
  #heldAfterSends = 0;
  // How many sends of messages kept for a retry are under way — an edit or a piece of one, a piece of an
  // answer, a message submitted with `retry` (SND-6, SND-7): with those queued, what a failure streak can
  // be about. Its own outcome settles a streak about one of them.
  #keptUnderWay = 0;
  // How many sends of messages of this client's own phase are under way — an edit or a piece of one, a
  // message submitted with a phase: until each went, was refused for good or failed, its phase may go
  // on, so the report waits for it (SND-11).
  #ownUnderWay = 0;
  // Whoever waits for an owed report to go (`reportNow`).
  #reportWaiters: (() => void)[] = [];
  // A message of this client's own under way now, if any: a final flush waits for it, which may go on
  // with the phase, before it sends the report (SND-11).
  #ownInFlight: Promise<unknown> | null = null;
  #reportTimer: ReturnType<typeof setTimeout> | null = null;
  #lastEditAt = 0;
  // The start of the most recent attempt, successful or not: the floor is about
  // how often we *submit*, and a refused submission may be counted by the provider.
  #lastSendAt: number | null = null;
  #failures = 0;
  #lastError: string | null = null;
  // Whether the failure the kept change is waiting out is one only the person can lift (TRN-20).
  #failureNeedsPerson = false;
  // Nothing goes out before this: the back-off after a failure worth retrying, or the wait the
  // provider asked for. It holds for the next send of any kind, since a provider throttles the
  // account, not one message (SND-7).
  #blockedUntil = 0;
  // Nothing goes out before this after a refusal only the person can lift (TRN-20): the longest
  // back-off, unless the application says sooner that the person acted (`flush()`). Kept apart
  // from `#blockedUntil`, which a send at once does not lift (SND-2, SND-7).
  #personHoldUntil = 0;
  // The words of the latest refusal only the person can lift, of any message, shown while the hold for
  // the person lasts and no failure of a kept change waits for the person: one not kept — a request, an
  // answer, a report —, or one kept and dropped since with its group (SND-10, SND-17, TRN-20); the timer
  // that tells the application as that hold ends.
  #personHoldWords: string | null = null;
  #personHoldTimer: ReturnType<typeof setTimeout> | null = null;
  // Failures worth retrying in a row, of any message, since the last success: what the back-off
  // doubles with (SND-7).
  #holdStreak = 0;
  // Extra spacing learned from rate-limit refusals; `0` when none.
  #adaptiveMs = 0;
  #successStreak = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #timerDueAt: number | null = null;
  #stopped = false;
  #droppedCount = 0;
  // Every time above is on a clock that never runs back (`SteadyClock`, §1.6): a floor, a quiet time
  // or a back-off is a span of time (SND-2, SND-7); on a wall clock set back an hour, each would hold
  // a message for that hour.
  readonly #clock: SteadyClock;

  constructor(options: SendSchedulerOptions) {
    this.#quietMs = options.quietMs;
    this.#policy = options.policy;
    this.#send = options.send;
    this.#classify = options.classify;
    this.#onDropped = options.onDropped;
    this.#onStatusChange = options.onStatusChange;
    this.#reportMessages = options.report;
    this.#onReportChange = options.onReportChange;
    this.#splitting = options.splitting;
    this.#clock = options.clock ?? new SteadyClock();
  }

  /**
   * How many changes have been dropped for good since this scheduler started (SND-8): the
   * send job only — what was dropped stays in the sender's own document.
   */
  get droppedCount(): number {
    return this.#droppedCount;
  }

  /** Whether a change is waiting to be sent — not whether a send is in flight (see `DocumentEngine.hasPendingChanges`). */
  get hasPending(): boolean {
    return this.#updates.length > 0 || this.#outbox.length > 0;
  }

  /** Now, on the scheduler's clock. */
  #now(): number {
    return this.#clock.now();
  }

  get status(): SendStatus {
    const streakNeedsPerson = this.#failures > 0 && this.#failureNeedsPerson;
    // A refusal only the person can lift of a message no longer kept, or never, holds every send as long
    // (TRN-20): the status shows it while that hold lasts (SND-10).
    const personHold =
      !streakNeedsPerson && this.#personHoldUntil > this.#now() ? this.#personHoldWords : null;
    return {
      state:
        streakNeedsPerson || personHold !== null
          ? "needs-person"
          : this.#failures > 0
            ? "retrying"
            : this.hasPending
              ? "waiting"
              : "idle",
      failures: this.#failures,
      nextAttemptAt: this.#clock.toWall(this.#timerDueAt),
      lastError: personHold ?? this.#lastError,
      partsQueued: this.#outbox.length,
      reportOwed: this.#phaseReport !== null || this.#stateReport !== null,
    };
  }

  /**
   * The report this client owes, and what it would carry again (SND-27), or `undefined` while it owes
   * none (SND-28): what an application persists with the content, on this device only, to give back
   * on its next start (`restoreOwedReport`).
   */
  get owedReport(): { readonly carry: ReportCarry | null } | undefined {
    if (this.#phaseReport !== null) {
      return { carry: this.#phaseReport.carry };
    }
    return this.#stateReport === null ? undefined : { carry: null };
  }

  /** The spacing between sends in force right now: the policy's floor, or wider if refusals taught us to. */
  get effectiveMinIntervalMs(): number {
    return Math.max(this.#policy.minIntervalMs, this.#adaptiveMs);
  }

  /**
   * Queues one local update. `chars` is how many characters it changed (inserted or
   * deleted), which only matters to `minChars`/`maxChars`; `roots` are the top-level types it
   * changes, and only updates that change the same ones are merged.
   */
  enqueue(update: Uint8Array, chars: number, roots: ReadonlySet<string> = CONTENT_ONLY): void {
    if (this.#stopped) {
      return;
    }
    const now = this.#now();
    this.#updates.push({ update, chars, roots, at: now });
    this.#lastEditAt = now;
    // A change of its own waits: the report waits for it, and counts afresh once it went (SND-11); one
    // about to go goes after it (SND-12).
    this.#withdrawReport();
    this.#armReport();
    this.#reschedule();
    this.#onStatusChange?.();
  }

  /**
   * Refuses one local update for good instead of queuing it — one this client may never send, such
   * as one its document's profile does not read (SND-26): it counts as dropped (SND-8) and is
   * reported once, through `onDropped`, and it is never merged with another change (LAY-7).
   */
  refuse(error: unknown): void {
    this.#droppedCount += 1;
    this.#onStatusChange?.();
    this.#onDropped(error);
  }

  /**
   * Queues frames that are already built and go out in order, ahead of any edit — the
   * pieces of an answer to a joiner too large for one message, sent at the same
   * permitted rate as everything else and retried the same way. Resolves once the last of them
   * has gone out; rejects with the error that dropped them, since one part lost makes the rest
   * useless and they go together. That rejection is the report: `onDropped` is not called for
   * them, though a group of this client's own still counts as dropped (SND-8).
   */
  enqueueFrames(frames: readonly string[], options: { own?: boolean } = {}): Promise<void> {
    if (this.#stopped) {
      return Promise.reject(new SchedulerStoppedError());
    }
    if (frames.length === 0) {
      return Promise.resolve();
    }
    const group = this.#nextGroup++;
    const own = options.own ?? true;
    this.#outbox.push(...frames.map((frame) => ({ frame, group, own, phase: false })));
    const sent = new Promise<void>((resolve, reject) => {
      this.#groupWaiters.set(group, { remaining: frames.length, resolve, reject });
    });
    // Pieces of this client's own change hold the report back; an answer's do not (SND-11).
    this.#armReport();
    this.#reschedule();
    this.#onStatusChange?.();
    return sent;
  }

  /**
   * Replaces the policy — the creator changed it (SPECIFICATION.md §7.5). What is pending is
   * judged by the new rules from now on, and the timer is set again; the learned
   * spacing (`effectiveMinIntervalMs`) and a back-off in progress are kept, since
   * they are facts about the provider, not about the policy.
   */
  setPolicy(policy: SyncPolicy): void {
    this.#policy = policy;
    this.#reschedule();
    this.#armReport();
    this.#onStatusChange?.();
  }

  /**
   * Sends a whole message that is not a local edit — the seed, a control message, a resync
   * request or answer — through the same floor as everything else (SPECIFICATION.md
   * SND-2, SND-20): as soon as the floor and a back-off permit, ahead of anything else queued.
   * Resolves with what `run` resolved to once it has gone out. Without `retry` it rejects with its
   * error, without a retry. With `retry` a failure worth retrying keeps it at the front, to be sent
   * again after the back-off as an edit is (SND-7), and it rejects only when it is refused for
   * good, at a final flush, or when the scheduler stops — for a message whose number may already
   * have been delivered, such as a control frame (CTL-26).
   * `phase` is set for an edit or a control frame of this client's own — a decision —, with what the
   * report carries again once it went out (SND-11, SND-27). A send of the whole state — the seed,
   * restored content, `resync()`'s —, a close sent again, a resync request or answer has none: it is no
   * local change, and neither begins nor prolongs a phase (SND-11).
   */
  submit<T>(
    run: () => Promise<T>,
    options: { retry?: boolean; phase?: ReportCarry } = {},
  ): Promise<T> {
    if (this.#stopped) {
      return Promise.reject(new SchedulerStoppedError());
    }
    return this.#enqueuePriority(run, options.retry === true, options.phase);
  }

  /** Queues a whole message ahead of everything else, whether or not the scheduler has stopped. */
  #enqueuePriority<T>(
    run: () => Promise<T>,
    retry: boolean,
    phase: ReportCarry | undefined,
  ): Promise<T> {
    if (phase !== undefined) {
      this.#withdrawReport(); // a change or decision of its own goes first (SND-12)
    }
    return new Promise<T>((resolve, reject) => {
      this.#priority.push({
        run,
        phase,
        retry,
        report: false,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      // A message of its own holds the report back and counts it afresh once out; a resync request
      // or answer leaves it where it was (SND-11).
      this.#armReport();
      this.#reschedule();
    });
  }

  /** When this client last submitted a message the scheduler knows of, else `null`. */
  get lastSendAt(): number | null {
    return this.#clock.toWall(this.#lastSendAt);
  }

  /** `lastSendAt` on the scheduler's clock (`clock`), to compare with other times taken from it. */
  get lastSendOnClock(): number | null {
    return this.#lastSendAt;
  }

  /**
   * Sends everything pending without waiting for the quiet time or `minChars` — an explicit
   * request — one message after another until nothing is left or one fails. Each still waits for
   * the floor and for a back-off or a wait the provider asked for: they are the provider's limit,
   * and an explicit request does not lift it (SND-2, SND-7). It does end a wait for the person
   * after a `needs-person` refusal: it is how the application says the person acted (TRN-22). A failure is thrown to the caller
   * either way; what happens to the change differs: a retryable failure keeps it for the
   * scheduler's own retry (unless `final`, where there will be no next attempt), a permanent one
   * drops it. A submitted message kept for a retry is treated the same way; one submitted without
   * `retry` tells only its submitter of its failure. Nothing pending resolves at once.
   * A `final` flush is the close (SND-11): once everything else went, it sends a report this client
   * owes, one last attempt as for everything else; if that fails, the report stays owed, for the
   * application to persist (SND-28). A flush that is not final sends no report of itself.
   */
  async flush(options: { final?: boolean } = {}): Promise<void> {
    const final = options.final === true;
    if (final) {
      this.#stopped = true;
      this.#clearReportTimer();
    }
    this.#clearTimer();
    // A send at once is how the application says the person acted: the wait for them ends
    // (TRN-22). The floor and the provider's back-off do not (SND-2, SND-7).
    const personHoldShown = this.#personHoldWords !== null;
    this.#endPersonHold();
    if (personHoldShown) {
      this.#onStatusChange?.();
    }
    let reported = false;
    for (;;) {
      if (this.#priority.length === 0 && !this.hasPending) {
        if (final && !reported && this.#ownInFlight !== null) {
          await this.#ownInFlight.catch(() => {});
          continue;
        }
        if (
          final &&
          !reported &&
          this.#reportSending === null &&
          (this.#phaseReport !== null || this.#stateReport !== null)
        ) {
          // Last, so that it states and carries everything that went before it (SND-11, SND-27).
          reported = true;
          this.#handOverReport(true);
          continue;
        }
        return;
      }
      if (await this.#untilPermitted()) {
        continue; // the floor moved meanwhile, or what was pending went out by the timer
      }
      if (this.#priority.length > 0) {
        const failure = await this.#sendPriority(final);
        if (failure?.kept === true) {
          throw failure.error;
        }
        continue;
      }
      const failure = await this.#attempt(final);
      if (failure !== undefined) {
        throw failure.error;
      }
    }
  }

  /**
   * Waits until the floor and any hold permit the next message (SND-2, SND-7). `true` when it
   * waited, so the caller looks again: the timer may have sent meanwhile, which moves the floor.
   */
  async #untilPermitted(): Promise<boolean> {
    const floorAt =
      this.#lastSendAt === null
        ? Number.NEGATIVE_INFINITY
        : this.#lastSendAt + this.effectiveMinIntervalMs;
    const delay = Math.max(floorAt, this.#blockedUntil) - this.#now();
    if (delay <= 0) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    return true;
  }

  /**
   * Stops every timer; a change still pending is abandoned (call `flush({final: true})` first to send
   * it). A report owed stays owed, for the application to persist (SND-28).
   */
  stop(): void {
    this.#stopped = true;
    this.#clearTimer();
    this.#clearReportTimer();
    if (this.#personHoldTimer !== null) {
      clearTimeout(this.#personHoldTimer);
      this.#personHoldTimer = null;
    }
    for (const entry of this.#priority.splice(0)) {
      entry.reject(new SchedulerStoppedError());
    }
    for (const waiter of this.#groupWaiters.values()) {
      waiter.reject(new SchedulerStoppedError());
    }
    this.#groupWaiters.clear();
    this.#releaseReportWaiters();
  }

  #pendingChars(): number {
    let chars = 0;
    for (const item of this.#updates) {
      chars += item.chars;
    }
    return chars;
  }

  /**
   * The earliest time the next message may be sent.
   * - The floor: `effectiveMinIntervalMs` after the last attempt.
   * - The back-off: nothing before `#blockedUntil` after a failure.
   * - Then the send condition itself. A queued frame, `maxChars` reached, or a retry: as
   *   soon as the floor and back-off permit. Otherwise the quiet time after the last
   *   edit — but only once `minChars` are pending — or, whatever the typing,
   *   `maxIntervalMs` after the oldest pending edit (SND-3).
   */
  #dueAt(): number {
    const floorAt =
      this.#lastSendAt === null
        ? Number.NEGATIVE_INFINITY
        : this.#lastSendAt + this.effectiveMinIntervalMs;
    const chars = this.#pendingChars();
    let readyAt: number;
    if (
      this.#priority.length > 0 ||
      this.#outbox.length > 0 ||
      this.#failures > 0 ||
      chars >= this.#policy.maxChars
    ) {
      // A retry has already been judged ready once (or was forced out by `flush()`), and a
      // frame already built is the rest of a message that has begun: only the floor and the
      // back-off hold it, not the quiet time or `minChars`.
      readyAt = Number.NEGATIVE_INFINITY;
    } else {
      const deadlineAt = (this.#updates[0]?.at ?? 0) + this.#policy.maxIntervalMs;
      readyAt =
        chars >= this.#policy.minChars
          ? Math.min(this.#lastEditAt + this.#quietMs, deadlineAt)
          : deadlineAt;
    }
    return Math.max(readyAt, floorAt, this.#heldUntil());
  }

  #reschedule(options: { deferred?: boolean } = {}): void {
    this.#clearTimer();
    if (this.#stopped || (!this.hasPending && this.#priority.length === 0)) {
      return;
    }
    const dueAt = this.#dueAt();
    if (!Number.isFinite(dueAt)) {
      return;
    }
    const delay = Math.max(0, dueAt - this.#now());
    if (delay === 0 && options.deferred !== true) {
      // Synchronously, so an unbatched client sends inside the edit that caused it.
      this.#runTimerAttempt();
      return;
    }
    this.#timerDueAt = dueAt;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#timerDueAt = null;
      this.#runTimerAttempt();
    }, delay);
  }

  #runTimerAttempt(): void {
    if (this.#priority.length > 0) {
      void this.#sendPriority();
      return;
    }
    this.#attempt(false)
      .then((failure) => {
        if (failure?.dropped) {
          this.#onDropped(failure.error);
        }
      })
      .catch((error: unknown) => this.#onDropped(error));
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#timerDueAt = null;
  }

  /**
   * Sends the first submitted message. Its outcome goes to whoever submitted it, never to
   * `onDropped`: a success or a failure it settles with, or — for one submitted with `retry`
   * that failed in a way worth retrying — nothing yet, since it is kept at the front for
   * the next attempt. Resolves to the failure, and whether the message was kept.
   */
  async #sendPriority(final = false): Promise<{ error: unknown; kept: boolean } | undefined> {
    const entry = this.#priority.shift();
    if (entry === undefined) {
      return undefined;
    }
    this.#lastSendAt = this.#now();
    const started = ++this.#sendsStarted;
    const settled = this.#sendUnderWay(entry.retry, entry.phase !== undefined);
    let outcome: { error: unknown; kept: boolean } | undefined;
    let running: Promise<unknown>;
    try {
      running = entry.run();
    } catch (error) {
      running = Promise.reject(error);
    }
    if (entry.phase !== undefined) {
      this.#ownInFlight = running;
    }
    try {
      const value = await running;
      settled();
      this.#endHold(started);
      if (entry.retry) {
        this.#endFailureStreakAfter(started);
      }
      if (entry.phase !== undefined) {
        this.#continuePhase(entry.phase);
      }
      entry.resolve(value);
    } catch (error) {
      settled();
      const failure = this.#classify(error);
      if (entry.retry && failure.retryable && !final && !this.#stopped) {
        this.#priority.unshift(entry);
        this.#backOff(error, failure);
        outcome = { error, kept: true };
      } else {
        if (entry.retry) {
          this.#endFailureStreakAfter(started);
        }
        if (failure.retryable && entry.report && holdsTheReportAlone(failure)) {
          // A report that could not go goes again after a back-off of its own, which holds back no
          // change of this client's own (SND-12).
          this.#backOffReport();
        } else if (failure.retryable) {
          // Not retried here, but the refusal still says the provider needs a pause: the next
          // send of any kind — a second answer to the same request (RSY-9) among them — waits for
          // the back-off or for what the provider asked (SND-7, SND-9).
          this.#holdBack(failure);
          if (failure.needsPerson === true) {
            this.#showPersonHold(error);
          }
        }
        entry.reject(error);
        outcome = { error, kept: false };
      }
    } finally {
      if (this.#ownInFlight === running) {
        this.#ownInFlight = null;
      }
    }
    this.#reschedule();
    this.#armReport();
    this.#onStatusChange?.();
    return outcome;
  }

  /**
   * What the next attempt sends. A queued frame first. Otherwise the longest prefix of the
   * queue whose merged frame still fits (all of it, when nothing limits the size); if even the
   * first update alone does not fit, it is split into pieces, one frame each, which are queued, and the
   * first of them is what goes now. Throws if it cannot be cut — a permanent failure.
   */
  #next(): Outgoing {
    const entry = this.#outbox.shift();
    if (entry !== undefined) {
      return { kind: "frame", entry };
    }
    const first = this.#updates[0] as QueuedUpdate;
    // Only the prefix that changes the same top-level types goes together (LAY-7).
    const alike = this.#updates.findIndex((item) => !sameRoots(item.roots, first.roots));
    const queue = alike === -1 ? this.#updates : this.#updates.slice(0, alike);
    const rest = alike === -1 ? [] : this.#updates.slice(alike);
    const splitting = this.#splitting;
    if (splitting === undefined) {
      this.#updates = rest;
      return { kind: "update", item: mergeQueued(queue) };
    }
    if (splitting.frameSize(first.update) > splitting.maxBytes) {
      // One update larger than a message: nothing to spread, so it is cut. It leaves the queue
      // only once the cut has succeeded, so a failure to cut keeps it for the report.
      const frames = splitting.pieces(first.update, first.roots);
      const group = this.#nextGroup++;
      const entries = frames.map((frame) => ({ frame, group, own: true, phase: true }));
      this.#updates = [...queue.slice(1), ...rest];
      this.#outbox = [...entries.slice(1), ...this.#outbox];
      return { kind: "frame", entry: entries[0] as OutboxEntry };
    }
    let taken = 1;
    let merged = first.update;
    while (taken < queue.length) {
      const candidate = mergeUpdates([merged, (queue[taken] as QueuedUpdate).update]);
      if (splitting.frameSize(candidate) > splitting.maxBytes) {
        break;
      }
      merged = candidate;
      taken += 1;
    }
    const prefix = queue.slice(0, taken);
    this.#updates = [...queue.slice(taken), ...rest];
    return {
      kind: "update",
      item: {
        update: merged,
        chars: prefix.reduce((sum, item) => sum + item.chars, 0),
        roots: first.roots,
        at: first.at,
      },
    };
  }

  /**
   * One send of the next message. Resolves to `undefined` on success, or to the failure and
   * whether the change was dropped (permanent, or retry is not possible) rather than kept for
   * a retry.
   */
  async #attempt(final: boolean): Promise<{ error: unknown; dropped: boolean } | undefined> {
    let outgoing: Outgoing;
    try {
      outgoing = this.#next();
    } catch (error) {
      // It could not be cut into pieces a message can carry: it is dropped and reported, and
      // the rest of the queue is left alone. No send began, so none after the hold: the failure
      // streak ends only where nothing it can be about is left — a kept change's retry may still be
      // under way (SND-7, SND-10).
      this.#updates = this.#updates.slice(1);
      this.#droppedCount += 1;
      if (!this.#keepsAny()) {
        this.#endFailureStreak();
      }
      this.#reschedule();
      // A report an earlier message owes is still owed: the dropped change held it back while it
      // waited (SND-11, LIF-6).
      this.#armReport();
      this.#onStatusChange?.();
      return { error, dropped: true };
    }
    this.#lastSendAt = this.#now();
    const started = ++this.#sendsStarted;
    // An edit, a piece of one or of an answer: each is kept for a retry (SND-6, SND-17); an edit or a
    // piece of this client's own is its own.
    const settled = this.#sendUnderWay(true, outgoing.kind === "update" || outgoing.entry.own);
    let sending: Promise<void>;
    try {
      sending =
        outgoing.kind === "frame"
          ? (this.#splitting as SplittingOptions).sendFrame(outgoing.entry.frame)
          : this.#send(outgoing.item.update, outgoing.item.roots);
    } catch (error) {
      settled();
      return this.#handleFailure(error, outgoing, final, started);
    }
    if (outgoing.kind === "update" || outgoing.entry.own) {
      this.#ownInFlight = sending;
    }
    try {
      await sending;
      settled();
    } catch (error) {
      settled();
      return this.#handleFailure(error, outgoing, final, started);
    } finally {
      if (this.#ownInFlight === sending) {
        this.#ownInFlight = null;
      }
    }
    if (outgoing.kind === "frame") {
      const waiter = this.#groupWaiters.get(outgoing.entry.group);
      if (waiter !== undefined && --waiter.remaining === 0) {
        this.#groupWaiters.delete(outgoing.entry.group);
        waiter.resolve();
      }
    }
    // An edit goes on with the phase and is what the report carries again, byte for byte as it went
    // out; a piece of one goes on with it but leaves the report nothing to carry; an answer's piece
    // and one of `resync()`'s whole state do neither (SND-11, SND-27).
    this.#handleSuccess(
      outgoing.kind === "update"
        ? { kind: "edit", update: outgoing.item.update }
        : outgoing.entry.phase
          ? null
          : undefined,
      started,
    );
    return undefined;
  }

  /**
   * A send went out, the `started`th; `phase` as `#continuePhase` takes it, `undefined` for one that
   * is no phase's.
   */
  #handleSuccess(phase: ReportCarry | null | undefined, started: number): void {
    this.#endFailureStreakAfter(started);
    this.#endHold(started);
    this.#successStreak += 1;
    if (phase !== undefined) {
      this.#continuePhase(phase);
    }
    if (this.#adaptiveMs > 0 && this.#successStreak >= ADAPT_DECAY_STREAK) {
      this.#successStreak = 0;
      const decayed = this.#adaptiveMs / ADAPT_GROWTH;
      this.#adaptiveMs =
        decayed <= Math.max(this.#policy.minIntervalMs, RETRY_BASE_MS) ? 0 : decayed;
    }
    this.#reschedule();
    this.#armReport();
    this.#onStatusChange?.();
  }

  /**
   * Makes a report owed for what it states alone, with no repeat (SND-11, SND-27). With `now` it goes as
   * soon as the floor permits: on a bootstrapped device of the creator once a merge changed its
   * control state or a bootstrap left it holding other control state than the answer stated, or once
   * a request showed that its last report misleads one that holds what it holds (SND-24). Without, it
   * is counted from now. One already owed goes at once with `now`, and is otherwise left as it is.
   * Like every report it waits for a change of this client's own that waits, and a change that goes
   * out before it takes it into its phase's report (SND-12).
   */
  oweReport(options: { now?: boolean } = {}): void {
    if (this.#reportMessages === undefined || this.#stopped) {
      return;
    }
    const now = options.now === true;
    const state = this.#stateReport;
    if (state !== null && state !== this.#reportSending?.state) {
      if (now && !state.atOnce) {
        this.#stateReport = { since: state.since, atOnce: true };
        this.#armReport();
      }
      return;
    }
    const arose = this.#phaseReport === null && this.#stateReport === null;
    this.#stateReport = { since: this.#now(), atOnce: now };
    if (arose) {
      this.#onReportChange?.();
    }
    this.#armReport();
    this.#onStatusChange?.();
  }

  /**
   * Makes the report this client owes go as soon as the floor permits, once nothing of its own waits:
   * as its device is about to sleep, or as the document closes (SND-11, LIF-12). Resolves once a
   * report went or was given up, or the scheduler stopped; at once when none is owed. A report taken
   * back for a change of its own (SND-12), or one that waits out its back-off, keeps it waiting.
   */
  reportNow(): Promise<void> {
    if (!this.#expediteReport()) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#reportWaiters.push(resolve);
    });
  }

  /**
   * A return or a reconnect (RSY-21, LIF-12): the back-off of the report ends, and a report owed goes
   * as soon as the floor permits (SND-12, SND-28). What holds back every send stays: a wait the provider
   * asked for, one only the person can lift, the back-off after a change of its own failed (SND-7,
   * TRN-20).
   */
  liftReportBackOff(): void {
    this.#reportHeldUntil = 0;
    this.#reportFailures = 0;
    this.#expediteReport();
  }

  /** Makes what is owed go at once; `false` when nothing is owed or nothing can go any more. */
  #expediteReport(): boolean {
    if (this.#stopped || this.#reportMessages === undefined) {
      return false;
    }
    const sending = this.#reportSending;
    const phase = this.#phaseReport;
    const state = this.#stateReport;
    if (phase === null && state === null) {
      return false;
    }
    if (phase !== null && phase !== sending?.phase && !phase.atOnce) {
      this.#phaseReport = { ...phase, atOnce: true };
    }
    if (state !== null && state !== sending?.state && !state.atOnce) {
      this.#stateReport = { since: state.since, atOnce: true };
    }
    this.#armReport();
    return true;
  }

  /**
   * Takes back a report that was owed when the application last persisted the document (SND-28): it
   * goes as soon as the floor permits, with the repeat it carried where it was to end a phase (SND-27).
   */
  restoreOwedReport(carry: ReportCarry | null): void {
    if (this.#reportMessages === undefined || this.#stopped) {
      return;
    }
    if (carry === null) {
      this.#stateReport = { since: this.#now(), atOnce: true };
    } else {
      this.#phaseReport = { since: this.#now(), atOnce: true, carry };
    }
    this.#onReportChange?.();
    this.#armReport();
    this.#onStatusChange?.();
  }

  /**
   * An edit or a control frame of this client's own went out: the phase goes on from now, and the
   * report that ends it carries `carry` again (SND-11, SND-27). A report asked for at once and not
   * yet handed over stays at once: it follows this message. A report owed for what it states goes
   * with this phase's, at its end (SND-12).
   */
  #continuePhase(carry: ReportCarry | null): void {
    if (this.#reportMessages === undefined) {
      return;
    }
    const sending = this.#reportSending;
    const phase = this.#phaseReport;
    const atOnce = phase !== null && phase !== sending?.phase && phase.atOnce;
    this.#phaseReport = { since: this.#now(), atOnce, carry };
    if (this.#stateReport !== null && this.#stateReport !== sending?.state) {
      this.#stateReport = null;
    }
    this.#onReportChange?.();
  }

  /** When the phase's report or one owed for what it states is due, or `+∞` for none. */
  #owedAt(owed: { readonly since: number; readonly atOnce: boolean } | null): number {
    if (owed === null) {
      return Number.POSITIVE_INFINITY;
    }
    return owed.atOnce ? Number.NEGATIVE_INFINITY : owed.since + REPORT_AFTER_MS;
  }

  /**
   * When a report goes, or `null` while none may (SND-11): `REPORT_AFTER_MS` after the last edit or
   * control frame of its own that went out, or at once when asked for so; never while a change of its
   * own waits, is under way — a first try as a retry — or is retried — a piece of one, or a message of
   * its own submitted, included (SND-12) —: one under way may go on with the phase, whose one report
   * then follows it. Never two at once, and never inside the floor, a hold, or the report's own back-off
   * (SND-2, SND-7).
   */
  #reportDueAt(): number | null {
    if (
      this.#reportSending !== null ||
      this.#stopped ||
      this.#reportMessages === undefined ||
      (this.#phaseReport === null && this.#stateReport === null) ||
      this.#ownUnderWay > 0 ||
      this.#updates.length > 0 ||
      this.#outbox.some((entry) => entry.own) ||
      this.#priority.some((entry) => entry.phase !== undefined) ||
      this.#failures > 0
    ) {
      return null;
    }
    return Math.max(
      Math.min(this.#owedAt(this.#phaseReport), this.#owedAt(this.#stateReport)),
      this.#lastSendAt === null
        ? Number.NEGATIVE_INFINITY
        : this.#lastSendAt + this.effectiveMinIntervalMs,
      this.#heldUntil(),
      this.#reportHeldUntil,
    );
  }

  /** Sets the report's timer for when it is due, if it may go at all (SND-11). */
  #armReport(): void {
    this.#clearReportTimer();
    const dueAt = this.#reportDueAt();
    if (dueAt === null) {
      return;
    }
    this.#reportTimer = setTimeout(
      () => {
        this.#reportTimer = null;
        this.#fireReport();
      },
      Math.max(0, dueAt - this.#now()),
    );
  }

  #fireReport(): void {
    // Something of its own may have come to wait since the timer was set, or another message gone
    // out, whose floor it then waits for (SND-2).
    const dueAt = this.#reportDueAt();
    if (dueAt === null) {
      return;
    }
    if (dueAt > this.#now()) {
      this.#armReport();
      return;
    }
    this.#handOverReport(false);
  }

  /**
   * Hands a report over to go out: the phase's, when it is due or `ending` — then with the phase's
   * repeat, once —, else one that states only (SND-27). Its messages go one after another, each ahead of
   * everything queued, the next once the one before went; a change of its own takes back the one
   * that waits (SND-12). The control frame sent again goes first (SND-27).
   */
  #handOverReport(ending: boolean): void {
    const messages = this.#reportMessages;
    const phase = this.#phaseReport;
    const state = this.#stateReport;
    if (messages === undefined) {
      return;
    }
    const endsPhase = phase !== null && (ending || this.#owedAt(phase) <= this.#now());
    if (!endsPhase && state === null) {
      return;
    }
    this.#clearReportTimer();
    const sending: ReportSending = { phase: endsPhase ? phase : null, state };
    this.#reportSending = sending;
    const queue = [...messages(endsPhase ? (phase as PhaseReport).carry : null)];
    const next = (first: boolean): void => {
      const run = queue.shift();
      if (run === undefined) {
        this.#reportSettled(sending, "sent");
        return;
      }
      this.#priority.push({
        run,
        phase: undefined,
        retry: false,
        report: true,
        resolve: () => next(false),
        reject: (error: unknown) =>
          this.#reportSettled(
            sending,
            error instanceof SchedulerStoppedError ||
              error instanceof ReportWithdrawn ||
              this.#classify(error).retryable
              ? "kept"
              : "given-up",
          ),
      });
      // The first goes now; each next one the send that went before it schedules.
      if (first) {
        this.#reschedule();
      }
    };
    next(true);
  }

  /**
   * Takes back the report's messages that wait to go: a change or decision of this client's own goes
   * first, and the report, still owed, goes at the end of the phase that change goes on with (SND-12).
   */
  #withdrawReport(): void {
    const waiting = this.#priority.filter((entry) => entry.report);
    if (waiting.length === 0) {
      return;
    }
    this.#priority = this.#priority.filter((entry) => !entry.report);
    for (const entry of waiting) {
      entry.reject(new ReportWithdrawn());
    }
  }

  /**
   * A report handed over went out, or was refused for good — given up, marking nothing as
   * undistributed (SND-8, SND-12) —; what it settles is owed no more. Or it is still owed: refused
   * for a reason worth retrying, to go again after the back-off; taken back for a change of its own
   * (SND-12); or left when the scheduler stopped, for the application to persist (SND-28). What became
   * owed after it was handed over stays owed.
   */
  #reportSettled(sending: ReportSending, outcome: "sent" | "kept" | "given-up"): void {
    if (this.#reportSending === sending) {
      this.#reportSending = null;
    }
    if (outcome !== "kept") {
      let settled = false;
      if (sending.phase !== null && this.#phaseReport === sending.phase) {
        this.#phaseReport = null;
        settled = true;
      }
      if (sending.state !== null && this.#stateReport === sending.state) {
        this.#stateReport = null;
        settled = true;
      }
      if (settled) {
        this.#onReportChange?.();
      }
      this.#releaseReportWaiters();
    } else if (this.#stopped) {
      this.#releaseReportWaiters();
    }
    this.#armReport();
    this.#onStatusChange?.();
  }

  /** The back-off of the report alone (SND-12), doubling with its failures in a row, as SND-7's does. */
  #backOffReport(): void {
    this.#heldAfterSends = this.#sendsStarted;
    this.#reportFailures += 1;
    this.#reportHeldUntil =
      this.#now() +
      Math.min(
        this.#retryCap(),
        Math.max(RETRY_BASE_MS, this.#policy.minIntervalMs) * 2 ** (this.#reportFailures - 1),
      );
  }

  #releaseReportWaiters(): void {
    for (const resolve of this.#reportWaiters.splice(0)) {
      resolve();
    }
  }

  #clearReportTimer(): void {
    if (this.#reportTimer !== null) {
      clearTimeout(this.#reportTimer);
      this.#reportTimer = null;
    }
  }

  #handleFailure(
    error: unknown,
    outgoing: Outgoing,
    final: boolean,
    started: number,
  ): { error: unknown; dropped: boolean } {
    const failure = this.#classify(error);
    if (!failure.retryable || final || this.#stopped) {
      // Whatever arrived while this send was in flight is still queued and is not
      // touched: only the message that failed for good is dropped, and with it the
      // failure streak that was about it — unless the hold began while it was under way: the
      // streak is then about the refusal that began it (SND-7, TRN-20). The rest of a message cut into parts goes too (SND-17):
      // the parts after it build on the one that failed, so a receiver would only hold them back
      // as a gap; the change goes again whole (SND-8), and a requester asks again (LOS-14).
      // Whoever enqueued a group of frames and waits for it is told, and reports it: told here as
      // well, the application would hear of one refusal twice (SND-8, "exactly once").
      let told = false;
      if (outgoing.kind === "frame") {
        this.#outbox = this.#outbox.filter((entry) => entry.group !== outgoing.entry.group);
        const waiter = this.#groupWaiters.get(outgoing.entry.group);
        waiter?.reject(error);
        told = waiter !== undefined;
        this.#groupWaiters.delete(outgoing.entry.group);
      }
      // Only a change of this client's own counts as dropped (SND-8); a group that is not, an
      // answer's, counts toward nothing.
      const own = outgoing.kind === "update" || outgoing.entry.own;
      if (own) {
        this.#droppedCount += 1;
      }
      this.#endFailureStreakAfter(started);
      this.#reschedule();
      // A report earlier messages owe is still owed, and carries what last went out: a change
      // refused for good, by the transport or by this engine (CTL-13, a close among the reasons),
      // went to no one (SND-11, SND-27, LIF-6).
      this.#armReport();
      this.#onStatusChange?.();
      return { error, dropped: own && !told };
    }
    // Kept, at the front of its queue: a frame back at the head of the outbox, an update
    // back at the head of the updates, merged with whatever arrived meanwhile.
    if (outgoing.kind === "frame") {
      this.#outbox.unshift(outgoing.entry);
    } else {
      this.#updates.unshift(outgoing.item);
    }
    this.#backOff(error, failure);
    this.#reschedule();
    // A change of its own is retried: the report waits for it (SND-11).
    this.#armReport();
    this.#onStatusChange?.();
    return { error, dropped: false };
  }

  /**
   * The message that failed is gone, sent or dropped: its failure streak ends with it. The hold
   * on sending does not: it is about the provider, and only a success, or its own end, lifts it.
   */
  #endFailureStreak(): void {
    this.#failures = 0;
    this.#lastError = null;
    this.#failureNeedsPerson = false;
  }

  /**
   * The `started`th send went through, or failed for good: the failure streak ends with it — the
   * back-off it counts, the error and whether the person must act — if it started after the hold
   * began (SND-7), or if nothing it can be about is left: no message kept for a retry waits or is under
   * way (SND-6, SND-10). One under way as the provider refused another tells nothing of that refusal,
   * and while a kept change still waits the application is still told that sending waits for the
   * person (TRN-20); where none does, a streak kept would show `retrying` for nothing until the next
   * change, and hold the report owed back as long (SND-11). Every case: the table in
   * `failure-streak.test.ts`.
   */
  #endFailureStreakAfter(started: number): void {
    if (started > this.#heldAfterSends || !this.#keepsAny()) {
      this.#endFailureStreak();
    }
  }

  /** Whether a message kept for a retry waits or is under way (SND-6, SND-7, SND-17, CTL-26). */
  #keepsAny(): boolean {
    return (
      this.#keptUnderWay > 0 ||
      this.#updates.length > 0 ||
      this.#outbox.length > 0 ||
      this.#priority.some((entry) => entry.retry)
    );
  }

  /**
   * Counts a send as under way — among those of messages kept for a retry, if `kept`, and among those of
   * this client's own, if `own` — until the function it returns is called, as the send settles: once,
   * however often it is called.
   */
  #sendUnderWay(kept: boolean, own: boolean): () => void {
    const keptCount = kept ? 1 : 0;
    const ownCount = own ? 1 : 0;
    this.#keptUnderWay += keptCount;
    this.#ownUnderWay += ownCount;
    let underWay = true;
    return () => {
      if (underWay) {
        underWay = false;
        this.#keptUnderWay -= keptCount;
        this.#ownUnderWay -= ownCount;
      }
    };
  }

  /**
   * The `started`th send went through: the back-off and the hold end, the report's own too (SND-7,
   * SND-12) — if it started after they began. A send under way as the provider refused another, which
   * succeeds after the refusal, shows nothing of what the provider allows since.
   */
  #endHold(started: number): void {
    if (started <= this.#heldAfterSends) {
      return;
    }
    this.#blockedUntil = 0;
    this.#endPersonHold();
    this.#holdStreak = 0;
    this.#reportHeldUntil = 0;
    this.#reportFailures = 0;
  }

  /**
   * A message was refused as only the person can lift: every send waits for the person (TRN-20), and the
   * status says so, with the refusal's words, until that hold ends — by time, a success after it, or
   * `flush()` (SND-10, TRN-22) —, also where nothing of the message is kept: one not kept for a retry, or
   * one kept that an earlier piece of its group, refused for good, drops (SND-17). The timer tells the
   * application as the hold ends by time, where nothing else would.
   */
  #showPersonHold(error: unknown): void {
    this.#personHoldWords = error instanceof Error ? error.message : String(error);
    if (this.#personHoldTimer !== null) {
      clearTimeout(this.#personHoldTimer);
    }
    this.#personHoldTimer = setTimeout(
      () => {
        this.#personHoldTimer = null;
        this.#onStatusChange?.();
      },
      Math.max(0, this.#personHoldUntil - this.#now()),
    );
  }

  /** The hold for the person ended early: by a success after it, or as the person acted (TRN-22). */
  #endPersonHold(): void {
    this.#personHoldUntil = 0;
    this.#personHoldWords = null;
    if (this.#personHoldTimer !== null) {
      clearTimeout(this.#personHoldTimer);
      this.#personHoldTimer = null;
    }
  }

  /** Until when every send is held back: by a back-off or the provider's wait, or for the person (SND-7, TRN-20). */
  #heldUntil(): number {
    return Math.max(this.#blockedUntil, this.#personHoldUntil);
  }

  /**
   * Counts a retryable failure and holds the next attempt back: the exponential back-off,
   * or what the provider asked for if that is longer (SND-7); a rate-limit refusal also
   * widens the spacing between later sends (SND-9). While a hold for the person lasts, a failure
   * of another kind — of a send under way as the provider refused another as only the person can
   * lift — leaves what the application is told of that refusal: sending still waits for the person
   * (TRN-20). Such a refusal is shown while its hold lasts also once the streak ended, the message
   * dropped with its group (SND-17), as one of a message not kept is.
   */
  #backOff(error: unknown, failure: SendFailureClass): void {
    this.#failures += 1;
    const needsPerson = failure.needsPerson === true;
    if (needsPerson || !this.#failureNeedsPerson || this.#personHoldUntil <= this.#now()) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      this.#failureNeedsPerson = needsPerson;
    }
    this.#holdBack(failure);
    if (needsPerson) {
      this.#showPersonHold(error);
    }
  }

  /**
   * Holds every next send back after a failure worth retrying, whatever message failed: by the
   * exponential back-off, or by what the provider asked if that is longer (SND-7); a rate-limit
   * refusal also widens the spacing between later sends (SND-9). A refusal only the person can
   * lift holds by the longest back-off at once (TRN-20): waiting does not pass it, so a growing
   * back-off would only offer the same refused message again; `flush()` asks sooner.
   */
  #holdBack(failure: SendFailureClass): void {
    this.#heldAfterSends = this.#sendsStarted;
    this.#holdStreak += 1;
    this.#successStreak = 0;

    const now = this.#now();
    if (failure.needsPerson === true) {
      this.#personHoldUntil = Math.max(this.#personHoldUntil, now + this.#retryCap());
      return;
    }
    if (failure.rateLimited === true) {
      const cap = this.#retryCap();
      this.#adaptiveMs = Math.min(
        cap,
        Math.max(this.effectiveMinIntervalMs, RETRY_BASE_MS) * ADAPT_GROWTH,
      );
    }
    const backoff = Math.min(
      this.#retryCap(),
      Math.max(RETRY_BASE_MS, this.#policy.minIntervalMs) * 2 ** (this.#holdStreak - 1),
    );
    const providerAsked =
      failure.retryAfterMs === undefined
        ? 0
        : Math.min(Math.max(failure.retryAfterMs, 0), RETRY_AFTER_MAX_MS);
    this.#blockedUntil = Math.max(this.#blockedUntil, now + Math.max(backoff, providerAsked));
  }

  #retryCap(): number {
    return Number.isFinite(this.#policy.maxIntervalMs)
      ? Math.max(this.#policy.maxIntervalMs, RETRY_BASE_MS)
      : RETRY_MAX_MS;
  }
}

/**
 * Whether a refusal of a report holds back the report alone (SND-12): one the network gave — not a wait
 * the provider asked for, nor a pace too fast for it (SND-7, SND-9), nor one only the person can lift
 * (TRN-20), which hold back every send.
 */
function holdsTheReportAlone(failure: SendFailureClass): boolean {
  return (
    failure.rateLimited !== true &&
    failure.retryAfterMs === undefined &&
    failure.needsPerson !== true
  );
}

/** Queued updates that change the same top-level types, as one: merged, carrying the total of their characters and the age of the oldest. */
function mergeQueued(queue: readonly QueuedUpdate[]): QueuedUpdate {
  const first = queue[0] as QueuedUpdate;
  return {
    update: queue.length === 1 ? first.update : mergeUpdates(queue.map((queued) => queued.update)),
    chars: queue.reduce((sum, queued) => sum + queued.chars, 0),
    roots: first.roots,
    at: first.at,
  };
}

/** What an update changes when its caller does not say: the content alone. */
const CONTENT_ONLY: ReadonlySet<string> = new Set(["content"]);

function sameRoots(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((root) => b.has(root));
}
