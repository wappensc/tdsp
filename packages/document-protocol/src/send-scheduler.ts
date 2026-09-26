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
 * into fragment frames, which go out in order before anything queued behind it.
 *
 * **Every other message goes through here too** (`submit`, SPECIFICATION.md SND-2): the
 * seed, a control message, a resync request, a resync answer. The provider counts messages,
 * not kinds, so each waits for the floor like an edit, and goes out ahead of anything queued.
 */

/** How a failed send is to be treated. `retryAfterMs` is what the provider itself asked us to wait. */
export interface SendFailureClass {
  readonly retryable: boolean;
  /** Whether the refusal says the current pace is too fast, so later sends should be spaced wider. */
  readonly rateLimited?: boolean;
  readonly retryAfterMs?: number | undefined;
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
   * `retrying`: the last send failed and the change is being retried.
   */
  readonly state: "idle" | "waiting" | "retrying";
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
  /** The fragment frames, in order, for an update whose frame exceeds `maxBytes`. Throws if that is impossible. */
  readonly fragment: (update: Uint8Array) => string[];
  /** Sends a frame that is already complete — a fragment. Resolves on success, throws on any failure. */
  readonly sendFrame: (frame: string) => Promise<void>;
}

export interface SendSchedulerOptions {
  /** The quiet time (`batchWindowMs`): send once no local edit has arrived for this long. `0` = send at once. */
  readonly quietMs: number;
  readonly policy: SyncPolicy;
  /** Sends one merged update. Resolves on success, throws on any failure. */
  readonly send: (update: Uint8Array) => Promise<void>;
  readonly classify: (error: unknown) => SendFailureClass;
  /** A timer-driven send failed for good and its change was dropped. */
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
  /** When the oldest edit this stands for was made; what `maxIntervalMs` counts from. */
  readonly at: number;
}

/** A frame already built, and which message it is a part of: the parts of one are dropped together. */
interface OutboxEntry {
  readonly frame: string;
  readonly group: number;
}

/**
 * A message that is not a local edit, submitted whole: it waits for the floor and a back-off
 * like any message, goes ahead of everything else queued, and is not retried here — whoever
 * submitted it is told the outcome and decides.
 */
interface PriorityEntry {
  readonly run: () => Promise<unknown>;
  /** Whether receivers expect a follow-up to it, so the heartbeat is owed after it (SND-11). */
  readonly armsHeartbeat: boolean;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

/** What one attempt sends: a merged prefix of the queue, or a fragment frame already built. */
type Outgoing =
  | { readonly kind: "update"; readonly item: QueuedUpdate }
  | { readonly kind: "frame"; readonly entry: OutboxEntry };

export class SendScheduler {
  readonly #quietMs: number;
  #policy: SyncPolicy;
  readonly #send: (update: Uint8Array) => Promise<void>;
  readonly #classify: (error: unknown) => SendFailureClass;
  readonly #onDropped: (error: unknown) => void;
  readonly #onStatusChange: (() => void) | undefined;
  readonly #sendHeartbeat: (() => Promise<void>) | undefined;
  readonly #splitting: SplittingOptions | undefined;

  #updates: QueuedUpdate[] = [];
  // Frames already built and waiting to go out, in order, ahead of everything in #updates:
  // the fragments of a change too large for one message, or of a large answer to a joiner.
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
  // Whether this client has sent an edit or a control message since its last heartbeat:
  // receivers then expect a follow-up, so a heartbeat is owed (SND-11, LOS-3).
  #heartbeatOwed = false;
  #lastEditAt = 0;
  // The start of the most recent attempt, successful or not: the floor is about
  // how often we *submit*, and a refused submission may be counted by the provider.
  #lastSendAt: number | null = null;
  #failures = 0;
  #lastError: string | null = null;
  #blockedUntil = 0;
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
      state: this.#failures > 0 ? "retrying" : this.hasPending ? "waiting" : "idle",
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
   * deleted), which only matters to `minChars`/`maxChars`.
   */
  enqueue(update: Uint8Array, chars: number): void {
    if (this.#stopped) {
      return;
    }
    const now = Date.now();
    this.#updates.push({ update, chars, at: now });
    this.#lastEditAt = now;
    // An edit is coming, and its own success counts the heartbeat's interval afresh.
    this.#clearHeartbeat();
    this.#reschedule();
    this.#onStatusChange?.();
  }

  /**
   * Queues frames that are already built and go out in order, ahead of any edit — the
   * fragments of an answer to a joiner too large for one message, sent at the same
   * permitted rate as everything else and retried the same way. Resolves once the last of them
   * has gone out; rejects with the error that dropped them, since one part lost makes the rest
   * useless and they go together.
   */
  enqueueFrames(frames: readonly string[]): Promise<void> {
    if (this.#stopped) {
      return Promise.reject(new Error("the send scheduler has stopped"));
    }
    if (frames.length === 0) {
      return Promise.resolve();
    }
    const group = this.#nextGroup++;
    this.#outbox.push(...frames.map((frame) => ({ frame, group })));
    const sent = new Promise<void>((resolve, reject) => {
      this.#groupWaiters.set(group, { remaining: frames.length, resolve, reject });
    });
    this.#clearHeartbeat();
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
   * SND-2): as soon as the floor and a back-off permit, ahead of anything else queued. Resolves
   * with what `run` resolved to once it has gone out; rejects with its error, without a retry.
   * `armsHeartbeat` says whether receivers expect a follow-up to it: yes for an edit or a
   * control message, no for a resync request or answer.
   */
  submit<T>(run: () => Promise<T>, options: { armsHeartbeat: boolean }): Promise<T> {
    if (this.#stopped) {
      return Promise.reject(new Error("the send scheduler has stopped"));
    }
    return new Promise<T>((resolve, reject) => {
      this.#priority.push({
        run,
        armsHeartbeat: options.armsHeartbeat,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.#clearHeartbeat();
      this.#reschedule();
    });
  }

  /** When this client last submitted a message the scheduler knows of, else `null`. */
  get lastSendAt(): number | null {
    return this.#lastSendAt;
  }

  /**
   * Sends everything pending right now, ignoring the quiet time, `minChars`, the
   * floor and any back-off — an explicit request — one message after another until
   * nothing is left or one fails. A failure is thrown to the caller either way; what
   * happens to the change differs: a retryable failure keeps it for the scheduler's own
   * retry (unless `final`, where there will be no next attempt), a permanent one drops it.
   * Nothing pending resolves at once.
   */
  async flush(options: { final?: boolean } = {}): Promise<void> {
    const final = options.final === true;
    if (final) {
      this.#stopped = true;
    }
    this.#clearTimer();
    while (this.#priority.length > 0) {
      await this.#sendPriority();
    }
    while (this.hasPending) {
      const failure = await this.#attempt(final);
      if (failure !== undefined) {
        throw failure.error;
      }
    }
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
    return Math.max(readyAt, floorAt, this.#blockedUntil);
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

  /** Sends the first submitted message. Its outcome goes to whoever submitted it, never to `onDropped`. */
  async #sendPriority(): Promise<void> {
    const entry = this.#priority.shift();
    if (entry === undefined) {
      return;
    }
    this.#lastSendAt = Date.now();
    try {
      entry.resolve(await entry.run());
      if (entry.armsHeartbeat) {
        this.#heartbeatOwed = true;
      }
    } catch (error) {
      entry.reject(error);
    }
    this.#reschedule();
    this.#armHeartbeat();
    this.#onStatusChange?.();
  }

  /**
   * What the next attempt sends. A queued frame first. Otherwise the longest prefix of the
   * queue whose merged frame still fits (all of it, when nothing limits the size); if even the
   * first update alone does not fit, it is cut into fragment frames, which are queued, and the
   * first of them is what goes now. Throws if it cannot be cut — a permanent failure.
   */
  #next(): Outgoing {
    const entry = this.#outbox.shift();
    if (entry !== undefined) {
      return { kind: "frame", entry };
    }
    const queue = this.#updates;
    const first = queue[0] as QueuedUpdate;
    const splitting = this.#splitting;
    if (splitting === undefined) {
      this.#updates = [];
      return { kind: "update", item: mergeQueued(queue) };
    }
    if (splitting.frameSize(first.update) > splitting.maxBytes) {
      // One update larger than a message: nothing to spread, so it is cut. It leaves the queue
      // only once the cut has succeeded, so a failure to cut keeps it for the report.
      const fragments = splitting.fragment(first.update);
      const group = this.#nextGroup++;
      const entries = fragments.map((frame) => ({ frame, group }));
      this.#updates = queue.slice(1);
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
    this.#updates = queue.slice(taken);
    return {
      kind: "update",
      item: {
        update: merged,
        chars: prefix.reduce((sum, item) => sum + item.chars, 0),
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
      this.#failures = 0;
      this.#blockedUntil = 0;
      this.#lastError = null;
      this.#reschedule();
      this.#onStatusChange?.();
      return { error, dropped: true };
    }
    this.#lastSendAt = Date.now();
    try {
      if (outgoing.kind === "frame") {
        await (this.#splitting as SplittingOptions).sendFrame(outgoing.entry.frame);
      } else {
        await this.#send(outgoing.item.update);
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
    this.#handleSuccess();
    return undefined;
  }

  #handleSuccess(): void {
    this.#failures = 0;
    this.#lastError = null;
    this.#blockedUntil = 0;
    this.#successStreak += 1;
    this.#heartbeatOwed = true;
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
   * Counts `maxIntervalMs` from this client's last message. Only when nothing is waiting
   * to go out (that edit will count it afresh) and there is something to count from.
   */
  #armHeartbeat(): void {
    this.#clearHeartbeat();
    if (
      this.#stopped ||
      this.#sendHeartbeat === undefined ||
      !this.#heartbeatOwed ||
      this.#lastSendAt === null ||
      this.hasPending ||
      this.#priority.length > 0 ||
      !Number.isFinite(this.#policy.maxIntervalMs)
    ) {
      return;
    }
    // `maxIntervalMs` after the last message of any kind, and never inside the floor.
    const dueAt = Math.max(
      this.#lastSendAt + this.#policy.maxIntervalMs,
      this.#lastSendAt + this.effectiveMinIntervalMs,
      this.#blockedUntil,
    );
    const delay = Math.max(0, dueAt - Date.now());
    this.#heartbeatTimer = setTimeout(() => {
      this.#heartbeatTimer = null;
      this.#fireHeartbeat();
    }, delay);
  }

  #fireHeartbeat(): void {
    // A change waiting or being retried will re-arm it when it goes out, and there would be
    // little point in saying "I have nothing further" now.
    if (this.#stopped || this.hasPending || this.#priority.length > 0 || this.#failures > 0) {
      return;
    }
    this.#heartbeatOwed = false;
    // The one heartbeat: counted against the floor like any message, never repeated, and not
    // retried if it fails — a receiver that never hears it treats the silence the same way it
    // treats a lost edit, so a second one would add nothing.
    this.#lastSendAt = Date.now();
    this.#sendHeartbeat?.().catch(() => {});
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
      // failure streak that was about it. The rest of a message cut into parts goes too: no
      // receiver can use a part without the one that failed, and sending it would only fill a
      // reassembly buffer that will never complete.
      if (outgoing.kind === "frame") {
        this.#outbox = this.#outbox.filter((entry) => entry.group !== outgoing.entry.group);
        this.#groupWaiters.get(outgoing.entry.group)?.reject(error);
        this.#groupWaiters.delete(outgoing.entry.group);
      }
      this.#droppedCount += 1;
      this.#failures = 0;
      this.#blockedUntil = 0;
      this.#lastError = null;
      this.#reschedule();
      this.#onStatusChange?.();
      return { error, dropped: true };
    }
    // Kept, at the front of its queue: a frame back at the head of the outbox, an update
    // back at the head of the updates, merged with whatever arrived meanwhile.
    if (outgoing.kind === "frame") {
      this.#outbox.unshift(outgoing.entry);
    } else {
      this.#updates.unshift(outgoing.item);
    }
    this.#failures += 1;
    this.#successStreak = 0;
    this.#lastError = error instanceof Error ? error.message : String(error);

    const now = Date.now();
    if (failure.rateLimited === true) {
      const cap = this.#retryCap();
      this.#adaptiveMs = Math.min(
        cap,
        Math.max(this.effectiveMinIntervalMs, RETRY_BASE_MS) * ADAPT_GROWTH,
      );
    }
    const backoff = Math.min(
      this.#retryCap(),
      Math.max(RETRY_BASE_MS, this.#policy.minIntervalMs) * 2 ** (this.#failures - 1),
    );
    const providerAsked =
      failure.retryAfterMs === undefined
        ? 0
        : Math.min(Math.max(failure.retryAfterMs, 0), RETRY_AFTER_MAX_MS);
    this.#blockedUntil = now + Math.max(backoff, providerAsked);
    this.#reschedule();
    this.#onStatusChange?.();
    return { error, dropped: false };
  }

  #retryCap(): number {
    return Number.isFinite(this.#policy.maxIntervalMs)
      ? Math.max(this.#policy.maxIntervalMs, RETRY_BASE_MS)
      : RETRY_MAX_MS;
  }
}

/** Every queued update as one: merged, carrying the total of their characters and the age of the oldest. */
function mergeQueued(queue: readonly QueuedUpdate[]): QueuedUpdate {
  const first = queue[0] as QueuedUpdate;
  return {
    update: queue.length === 1 ? first.update : mergeUpdates(queue.map((queued) => queued.update)),
    chars: queue.reduce((sum, queued) => sum + queued.chars, 0),
    at: first.at,
  };
}
