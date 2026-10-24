import { mergeUpdates } from "@tdsp/reconciliation";
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

/** A first retry after this long, doubling per consecutive failure (never less than the floor). */
export const RETRY_BASE_MS = 1000;
/** ...up to this long, or the policy's `maxIntervalMs` if that is finite and larger. */
export const RETRY_MAX_MS = 600_000;
/** A provider's own `retryAfterMs` is honoured, but never for longer than this. */
export const RETRY_AFTER_MAX_MS = 3_600_000;
/** After a rate-limit refusal the spacing between sends grows by this factor... */
export const ADAPT_GROWTH = 1.5;
/** ...and shrinks by it again after this many sends in a row succeed. */
export const ADAPT_DECAY_STREAK = 8;

export interface SendStatus {
  /**
   * `idle`: nothing pending. `waiting`: a change is waiting for its send window.
   * `retrying`: the last send failed and the change is being retried. `needs-person`: the last
   * send was refused until the person acts (TRN-20) — trust an identity, confirm a device, sign
   * in —, the change is kept, and it is tried again after the longest back-off or on `flush()`.
   */
  readonly state: "idle" | "waiting" | "retrying" | "needs-person";
  /** Consecutive failed attempts of the pending change; `0` unless `retrying`. */
  readonly failures: number;
  /** When the next attempt is due (epoch ms), if one is scheduled. */
  readonly nextAttemptAt: number | null;
  /** The message of the most recent failure, while it is still unresolved. */
  readonly lastError: string | null;
  /**
   * Messages of a change too large for one still waiting to go out, after the one being
   * sent: the "parts left" of a big paste. `0` when nothing has been cut into pieces.
   */
  readonly partsQueued: number;
}

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
   * Sends the one heartbeat (SPECIFICATION.md §9.3), if given: `maxIntervalMs` after this
   * client's last message, once nothing is pending, and then not again until it sends
   * something else. It says "I have sent all I will for now, and this is what I have" —
   * which is what lets a receiver see that a *final* message was lost, when nothing later
   * would ever reveal it. Needs a finite `maxIntervalMs`; with none there is nothing to
   * count from and no heartbeat is sent.
   */
  readonly sendHeartbeat?: () => Promise<void>;
  /** Present when the transport limits the size of a message: what does not fit is spread or cut. */
  readonly splitting?: SplittingOptions;
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
}

/**
 * A message that is not a local edit, submitted whole: it waits for the floor and a back-off
 * like any message and goes ahead of everything else queued. Unless submitted with `retry`, it
 * is not retried here — whoever submitted it is told the outcome and decides.
 */
interface PriorityEntry {
  readonly run: () => Promise<unknown>;
  /** Whether receivers expect a follow-up to it, so the heartbeat is owed after it (SND-11). */
  readonly armsHeartbeat: boolean;
  /** Which promise it makes when it does: an edit's, or a control frame's (LOS-16 judges each apart). */
  readonly promise: Promise_;
  /** Kept at the front after a retryable failure and sent again after the back-off (SND-7). */
  readonly retry: boolean;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * What a message that owes a heartbeat promised receivers (SND-11, SND-14): an edit — a piece of one
 * included — or a control frame, which receivers expect a follow-up to, each of its own source
 * (LOS-11, LOS-16); or anything else that owes one, which promised nothing — an answer in pieces,
 * an answer that changed what this client holds.
 */
type Promise_ = "edit" | "control" | "other";

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
  readonly #sendHeartbeat: (() => Promise<void>) | undefined;
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
  // What owes a heartbeat since the last one (SND-11), `null` when nothing does: when this client
  // last sent an edit and a control frame — receivers judge each by its own source (LOS-16), so a
  // later one of one kind does not keep the other's promise —, and when it last did anything that
  // owes one. The heartbeat counts from the earliest of the edit's and the control frame's, or, when
  // neither was sent, from the latest of the rest, which promised nothing.
  // `now`: a request showed that this client's last report misleads one that holds what it holds
  // now, so the heartbeat goes as soon as the floor permits (SND-24).
  #owed: { edit: number | null; control: number | null; latest: number; now: boolean } | null =
    null;
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
  // Failures worth retrying in a row, of any message, since the last success: what the back-off
  // doubles with (SND-7).
  #holdStreak = 0;
  // Extra spacing learned from rate-limit refusals; `0` when none.
  #adaptiveMs = 0;
  #successStreak = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #timerDueAt: number | null = null;
  #heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  #stopped = false;
  #droppedCount = 0;

  constructor(options: SendSchedulerOptions) {
    this.#quietMs = options.quietMs;
    this.#policy = options.policy;
    this.#send = options.send;
    this.#classify = options.classify;
    this.#onDropped = options.onDropped;
    this.#onStatusChange = options.onStatusChange;
    this.#sendHeartbeat = options.sendHeartbeat;
    this.#splitting = options.splitting;
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

  get status(): SendStatus {
    return {
      state:
        this.#failures > 0
          ? this.#failureNeedsPerson
            ? "needs-person"
            : "retrying"
          : this.hasPending
            ? "waiting"
            : "idle",
      failures: this.#failures,
      nextAttemptAt: this.#timerDueAt,
      lastError: this.#lastError,
      partsQueued: this.#outbox.length,
    };
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
    const now = Date.now();
    this.#updates.push({ update, chars, roots, at: now });
    this.#lastEditAt = now;
    // An edit is coming, and its own success counts the heartbeat's interval afresh.
    this.#clearHeartbeat();
    this.#reschedule();
    this.#onStatusChange?.();
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
      return Promise.reject(new Error("the send scheduler has stopped"));
    }
    if (frames.length === 0) {
      return Promise.resolve();
    }
    const group = this.#nextGroup++;
    const own = options.own ?? true;
    this.#outbox.push(...frames.map((frame) => ({ frame, group, own })));
    const sent = new Promise<void>((resolve, reject) => {
      this.#groupWaiters.set(group, { remaining: frames.length, resolve, reject });
    });
    // Pieces of this client's own change hold the heartbeat back; an answer's do not (SND-23).
    this.#armHeartbeat();
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
    this.#armHeartbeat();
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
   * `armsHeartbeat` says whether receivers expect a follow-up to it: yes for an edit or a
   * control message, no for a resync request or answer; `promise` which of the two it is, an edit
   * unless it says otherwise.
   */
  submit<T>(
    run: () => Promise<T>,
    options: { armsHeartbeat: boolean; retry?: boolean; promise?: "edit" | "control" },
  ): Promise<T> {
    if (this.#stopped) {
      return Promise.reject(new Error("the send scheduler has stopped"));
    }
    return new Promise<T>((resolve, reject) => {
      this.#priority.push({
        run,
        armsHeartbeat: options.armsHeartbeat,
        promise: options.promise ?? "edit",
        retry: options.retry === true,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      // A message that owes the heartbeat holds it back and counts it afresh once out; one that
      // owes none — a resync request or answer — leaves it where it was (SND-23).
      this.#armHeartbeat();
      this.#reschedule();
    });
  }

  /** When this client last submitted a message the scheduler knows of, else `null`. */
  get lastSendAt(): number | null {
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
   */
  async flush(options: { final?: boolean } = {}): Promise<void> {
    const final = options.final === true;
    if (final) {
      this.#stopped = true;
    }
    this.#clearTimer();
    // A send at once is how the application says the person acted: the wait for them ends
    // (TRN-22). The floor and the provider's back-off do not (SND-2, SND-7).
    this.#personHoldUntil = 0;
    for (;;) {
      if (this.#priority.length === 0 && !this.hasPending) {
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
    const delay = Math.max(floorAt, this.#blockedUntil) - Date.now();
    if (delay <= 0) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    return true;
  }

  /** Stops every timer; a change still pending is abandoned (call `flush({final: true})` first to send it). */
  stop(): void {
    this.#stopped = true;
    this.#clearTimer();
    this.#clearHeartbeat();
    for (const entry of this.#priority.splice(0)) {
      entry.reject(new Error("the send scheduler has stopped"));
    }
    for (const waiter of this.#groupWaiters.values()) {
      waiter.reject(new Error("the send scheduler has stopped"));
    }
    this.#groupWaiters.clear();
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
   *   `maxIntervalMs` after the oldest pending edit.
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

  #reschedule(): void {
    this.#clearTimer();
    if (this.#stopped || (!this.hasPending && this.#priority.length === 0)) {
      return;
    }
    const dueAt = this.#dueAt();
    if (!Number.isFinite(dueAt)) {
      return;
    }
    const delay = dueAt - Date.now();
    if (delay <= 0) {
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
    // A heartbeat that falls due within one floor goes ahead of a message that owes none — a resync
    // request, an answer or a piece of one —, which would otherwise push it past the promise it
    // keeps (SND-14, SND-23).
    const next = this.#priority[0];
    const owesNone =
      next !== undefined
        ? !next.armsHeartbeat
        : this.#updates.length === 0 && this.#outbox[0]?.own === false;
    const heartbeatAt = owesNone ? this.#heartbeatDueAt() : null;
    if (heartbeatAt !== null && heartbeatAt < Date.now() + this.effectiveMinIntervalMs) {
      this.#fireHeartbeat();
      return;
    }
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
    this.#lastSendAt = Date.now();
    let outcome: { error: unknown; kept: boolean } | undefined;
    try {
      const value = await entry.run();
      this.#endHold();
      if (entry.retry) {
        this.#endFailureStreak();
      }
      entry.resolve(value);
      if (entry.armsHeartbeat) {
        this.#owe(entry.promise);
      }
    } catch (error) {
      const failure = this.#classify(error);
      if (entry.retry && failure.retryable && !final && !this.#stopped) {
        this.#priority.unshift(entry);
        this.#backOff(error, failure);
        outcome = { error, kept: true };
      } else {
        if (entry.retry) {
          this.#endFailureStreak();
        }
        if (failure.retryable) {
          // Not retried here, but the refusal still says the provider needs a pause: the next
          // send of any kind — a second answer to the same request (RSY-9) among them — waits for
          // the back-off or for what the provider asked (SND-7, SND-9).
          this.#holdBack(failure);
        }
        entry.reject(error);
        outcome = { error, kept: false };
      }
    }
    this.#reschedule();
    this.#armHeartbeat();
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
      const entries = frames.map((frame) => ({ frame, group, own: true }));
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
      // the rest of the queue is left alone.
      this.#updates = this.#updates.slice(1);
      this.#droppedCount += 1;
      this.#endFailureStreak();
      this.#reschedule();
      // A heartbeat an earlier message owes is still owed: the dropped change cancelled its timer
      // when it was queued (SND-23, LIF-6).
      this.#armHeartbeat();
      this.#onStatusChange?.();
      return { error, dropped: true };
    }
    this.#lastSendAt = Date.now();
    try {
      if (outgoing.kind === "frame") {
        await (this.#splitting as SplittingOptions).sendFrame(outgoing.entry.frame);
      } else {
        await this.#send(outgoing.item.update, outgoing.item.roots);
      }
    } catch (error) {
      return this.#handleFailure(error, outgoing, final);
    }
    if (outgoing.kind === "frame") {
      const waiter = this.#groupWaiters.get(outgoing.entry.group);
      if (waiter !== undefined && --waiter.remaining === 0) {
        this.#groupWaiters.delete(outgoing.entry.group);
        waiter.resolve();
      }
    }
    // An edit's piece promises what an edit does; an answer's promises nothing (SND-11).
    this.#handleSuccess(outgoing.kind === "update" || outgoing.entry.own ? "edit" : "other");
    return undefined;
  }

  #handleSuccess(promise: Promise_): void {
    this.#failures = 0;
    this.#lastError = null;
    this.#failureNeedsPerson = false;
    this.#endHold();
    this.#successStreak += 1;
    this.#owe(promise);
    if (this.#adaptiveMs > 0 && this.#successStreak >= ADAPT_DECAY_STREAK) {
      this.#successStreak = 0;
      const decayed = this.#adaptiveMs / ADAPT_GROWTH;
      this.#adaptiveMs =
        decayed <= Math.max(this.#policy.minIntervalMs, RETRY_BASE_MS) ? 0 : decayed;
    }
    this.#reschedule();
    this.#armHeartbeat();
    this.#onStatusChange?.();
  }

  /**
   * Makes the one heartbeat owed although nothing was sent that owes it: what this client holds
   * changed by an answer it received (SPECIFICATION.md SND-11) — or, with `now`, a request showed
   * that its last report misleads one that holds what it holds, and the heartbeat goes as soon as
   * the floor permits, whatever the pacing's `maxIntervalMs` (SND-24).
   */
  oweHeartbeat(options: { now?: boolean } = {}): void {
    this.#owe("other", options.now === true);
    this.#armHeartbeat();
  }

  /** Something that owes the heartbeat went out, or happened, now (SND-11). */
  #owe(promise: Promise_, atOnce = false): void {
    const now = Date.now();
    const owed = this.#owed ?? { edit: null, control: null, latest: now, now: false };
    this.#owed = {
      edit: promise === "edit" ? now : owed.edit,
      control: promise === "control" ? now : owed.control,
      latest: now,
      now: owed.now || atOnce,
    };
  }

  /**
   * When the heartbeat is due, or `null` when none may be sent now (SND-23): `maxIntervalMs` after
   * the earliest promise still open — the last edit's and the last control frame's, each of its own
   * source at receivers (LOS-16), or else the latest message or answer that owes it —, never inside
   * the floor or a hold. None while a change of this client's own, or a message that owes the
   * heartbeat itself, waits or is retried: that one counts it afresh. A resync request or answer
   * waiting to go out does not hold it back.
   */
  #heartbeatDueAt(): number | null {
    const owed = this.#owed;
    if (
      this.#stopped ||
      this.#sendHeartbeat === undefined ||
      owed === null ||
      this.#updates.length > 0 ||
      this.#outbox.some((entry) => entry.own) ||
      this.#priority.some((entry) => entry.armsHeartbeat) ||
      this.#failures > 0 ||
      (!owed.now && !Number.isFinite(this.#policy.maxIntervalMs))
    ) {
      return null;
    }
    const promisedAt = Math.min(
      owed.edit ?? Number.POSITIVE_INFINITY,
      owed.control ?? Number.POSITIVE_INFINITY,
      owed.latest,
    );
    return Math.max(
      owed.now ? Number.NEGATIVE_INFINITY : promisedAt + this.#policy.maxIntervalMs,
      this.#lastSendAt === null
        ? Number.NEGATIVE_INFINITY
        : this.#lastSendAt + this.effectiveMinIntervalMs,
      this.#heldUntil(),
    );
  }

  /** Sets the heartbeat's timer for when it is due, if it may be sent at all (SND-23). */
  #armHeartbeat(): void {
    this.#clearHeartbeat();
    const dueAt = this.#heartbeatDueAt();
    if (dueAt === null) {
      return;
    }
    const delay = Math.max(0, dueAt - Date.now());
    this.#heartbeatTimer = setTimeout(() => {
      this.#heartbeatTimer = null;
      this.#fireHeartbeat();
    }, delay);
  }

  #fireHeartbeat(): void {
    // A change waiting or being retried will re-arm it when it goes out, and there would be
    // little point in saying "I have nothing further" now. Another message may have gone out since
    // the timer was set: then it waits for the floor after that one (SND-2).
    const dueAt = this.#heartbeatDueAt();
    if (dueAt === null) {
      return;
    }
    const floorAt = Math.max(
      this.#lastSendAt === null
        ? Number.NEGATIVE_INFINITY
        : this.#lastSendAt + this.effectiveMinIntervalMs,
      this.#heldUntil(),
    );
    if (floorAt > Date.now()) {
      this.#armHeartbeat();
      return;
    }
    this.#clearHeartbeat();
    this.#owed = null;
    // The one heartbeat: counted against the floor like any message, never repeated, and not
    // retried if it fails — a receiver that never hears it treats the silence the same way it
    // treats a lost edit, so a second one would add nothing.
    this.#lastSendAt = Date.now();
    // What waits behind it — a resync request or answer — now waits for the floor after it.
    this.#reschedule();
    this.#sendHeartbeat?.().then(
      () => this.#endHold(),
      (error: unknown) => {
        // Not retried (SND-12), but a refusal worth retrying holds back what comes next (SND-7).
        const failure = this.#classify(error);
        if (failure.retryable) {
          this.#holdBack(failure);
          this.#reschedule();
          this.#onStatusChange?.();
        }
      },
    );
  }

  #clearHeartbeat(): void {
    if (this.#heartbeatTimer !== null) {
      clearTimeout(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }

  #handleFailure(
    error: unknown,
    outgoing: Outgoing,
    final: boolean,
  ): { error: unknown; dropped: boolean } {
    const failure = this.#classify(error);
    if (!failure.retryable || final || this.#stopped) {
      // Whatever arrived while this send was in flight is still queued and is not
      // touched: only the message that failed for good is dropped, and with it the
      // failure streak that was about it. The rest of a message cut into parts goes too (SND-17):
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
      this.#endFailureStreak();
      this.#reschedule();
      // What earlier messages owe — a heartbeat after an edit that went out — is still owed: a
      // change refused for good, by the transport or by this engine (CTL-13, a close among the
      // reasons), says nothing to receivers, who still wait for the follow-up (SND-23, LIF-6).
      this.#armHeartbeat();
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

  /** A send went through: the back-off and the hold end (SND-7). */
  #endHold(): void {
    this.#blockedUntil = 0;
    this.#personHoldUntil = 0;
    this.#holdStreak = 0;
  }

  /** Until when every send is held back: by a back-off or the provider's wait, or for the person (SND-7, TRN-20). */
  #heldUntil(): number {
    return Math.max(this.#blockedUntil, this.#personHoldUntil);
  }

  /**
   * Counts a retryable failure and holds the next attempt back: the exponential back-off,
   * or what the provider asked for if that is longer (SND-7); a rate-limit refusal also
   * widens the spacing between later sends (SND-9).
   */
  #backOff(error: unknown, failure: SendFailureClass): void {
    this.#failures += 1;
    this.#lastError = error instanceof Error ? error.message : String(error);
    this.#failureNeedsPerson = failure.needsPerson === true;
    this.#holdBack(failure);
  }

  /**
   * Holds every next send back after a failure worth retrying, whatever message failed: by the
   * exponential back-off, or by what the provider asked if that is longer (SND-7); a rate-limit
   * refusal also widens the spacing between later sends (SND-9). A refusal only the person can
   * lift holds by the longest back-off at once (TRN-20): waiting does not pass it, so a growing
   * back-off would only offer the same refused message again; `flush()` asks sooner.
   */
  #holdBack(failure: SendFailureClass): void {
    this.#holdStreak += 1;
    this.#successStreak = 0;

    const now = Date.now();
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
