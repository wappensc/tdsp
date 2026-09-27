import {
  type Delivery,
  type DeliveryId,
  type DocumentId,
  type MemberId,
  type MessengerPort,
  type Permission,
  type ResyncRequestId,
  type TransportProfile,
  TransportSendError,
} from "@tdsp/messenger-port";
import {
  type AttributionSnapshot,
  AttributionTracker,
  getFragment,
  observePlainTextChanges,
  observeUpdates,
  type ReconciledDocument,
  type ReconciledFragment,
  transact,
} from "@tdsp/reconciliation";
import { fragmentFrame, type IncompleteMessage, Reassembler } from "./fragments";
import {
  type AttributionOverlay,
  type ControlFrame,
  type ControlPermission,
  type DeclineFrame,
  type DeclineReason,
  type DecodedSnapshot,
  decodeFrame,
  encodeControlFrame,
  encodeDeclineFrame,
  encodeEditFrame,
  encodeHeartbeatFrame,
  encodeResyncRequestFrame,
  encodeResyncResponseFrame,
  type Frame,
  FrameDecodeError,
  frameByteLength,
  newRandomId,
  utf8ToText,
} from "./framing";
import { LossDetector, lossGraceMs, type SyncSuspicion } from "./loss-detector";
import { type DocumentProfile, profileFor, YJS_PARAGRAPHS_1 } from "./profile";
import { ResyncGate, type ResyncOutcome, type ResyncStatus } from "./resync-gate";
import { type SendFailureClass, SendScheduler, type SendStatus } from "./send-scheduler";
import {
  definedOnly,
  effectiveSyncPolicy,
  resolveSyncPolicy,
  type SyncPolicy,
  type SyncPolicyJson,
  syncPolicyFromJson,
  syncPolicyToJson,
} from "./sync-policy";

export type { IncompleteMessage } from "./fragments";
export {
  DEFAULT_LOSS_GRACE_MS,
  type SyncSuspicion,
  type SyncSuspicionKind,
} from "./loss-detector";
export type { ResyncOutcome, ResyncRefusal, ResyncStatus } from "./resync-gate";
export type { SendStatus } from "./send-scheduler";
export {
  clampSyncPolicy,
  DEFAULT_SYNC_POLICY,
  decodeSyncPolicyParam,
  effectiveSyncPolicy,
  encodeSyncPolicyParam,
  resolveSyncPolicy,
  type SyncPolicy,
  type SyncPolicyJson,
  syncPolicyFromJson,
  syncPolicyToJson,
} from "./sync-policy";

export type { DocumentId };

/**
 * A synthetic author id marking content whose true author could not be
 * determined during a partial resync gap-heal (SPECIFICATION.md RSY-13) — the
 * overlay of a partial diff's responder describes *their own* view, not
 * necessarily this client's post-merge state, so it is not trustworthy to adopt.
 * A plain, distinctive string rather than a control character, which editors and
 * review tools tend to hide. Collision with a
 * real, user-chosen `MemberId` is made unlikely, not impossible — an
 * accepted trade-off, since this only ever affects *display*, never
 * document content or correctness.
 */
const UNATTRIBUTED_AUTHOR_ID: MemberId = "__tdsp:unattributed__";

/** How long an own send's echo may lag behind before its id is forgotten anyway. */
const OWN_ECHO_WAIT_MS = 3_600_000;

/** How many resync request ids of others an engine remembers, so a copy is not answered twice. */
const MAX_REMEMBERED_REQUESTS = 1024;

/** How many requests still to be answered a responder keeps: one per requester, the oldest dropped first (RSY-9). */
const MAX_PENDING_REQUESTS = 64;

/** How long a request still to be answered is kept; its requester asks again long before (RSY-4, RSY-5). */
const PENDING_REQUEST_TTL_MS = 5 * 60_000;

/**
 * Document protocol: maps one document to one messenger channel, owns
 * update identity and deduplication, and is the only place that broadcasts
 * a local reconciliation update or applies a remote one.
 *
 * A DocumentEngine depends only on `MessengerPort` (never on a concrete
 * adapter — see .dependency-cruiser.cjs) and on `@tdsp/reconciliation`;
 * it never imports `yjs` directly, so the CRDT stays swappable behind that
 * wrapper.
 */

// Distinguishes updates this client just applied from a remote delivery so
// they are not re-broadcast — the echo-loop guard. An editor binding faces the
// same problem one layer up, for rendering.
const REMOTE_ORIGIN = Symbol("remote");

/**
 * Thrown when this client refuses to send because it already knows it must not
 * (SPECIFICATION.md CTL-13): the document is closed, this member's permission is
 * explicitly `read`, or — for anyone but the creator — the creator has not yet
 * bootstrapped it. **Permanent** — a retry cannot succeed, unlike a rate limit or a
 * disconnection. After the bootstrap an *unknown* permission does not refuse.
 */
export class SendRefusedError extends Error {
  /**
   * `awaiting-bootstrap`: a participant other than the creator has not yet received the
   * creator's answer to its join — it has neither the document's content nor its control state,
   * so an edit of its own would compete with content it cannot see (SPECIFICATION.md CTL-13).
   */
  readonly reason: "closed" | "read-only" | "awaiting-bootstrap";

  constructor(reason: SendRefusedError["reason"], message: string) {
    super(message);
    this.name = "SendRefusedError";
    this.reason = reason;
  }
}

/**
 * Reported when the transport refuses a message as too large although it is within the
 * `maxBytes` the transport's own profile declared (SPECIFICATION.md SND-8): the change is
 * dropped as for any `too-large`, and the profile, or the binding behind it, is wrong — no
 * setting of this client can avoid the refusal. `cause` is the transport's own error.
 */
export class TransportProfileError extends Error {
  constructor(message: string, options: { cause: unknown }) {
    super(message, options);
    this.name = "TransportProfileError";
  }
}

/**
 * How the scheduler treats a failed send. Refusals this client makes
 * itself (closed, read-only) and a `TransportSendError` that is not retryable are
 * permanent — retrying cannot help, and retrying a demoted member's edits forever
 * would be wrong. A rate-limit refusal is retryable and also tells the scheduler the
 * pace is too fast. **Anything else is retryable**: dropping a change on a failure
 * nobody classified is exactly the fault this exists to remove.
 */
function classifySendFailure(error: unknown): SendFailureClass {
  if (error instanceof SendRefusedError) {
    return { retryable: false };
  }
  if (error instanceof TransportSendError) {
    return {
      retryable: error.retryable,
      rateLimited: error.reason === "rate-limited",
      retryAfterMs: error.retryAfterMs,
    };
  }
  return { retryable: true };
}

/**
 * Thrown (and routed to `onError(..., "apply")`) for a control frame this client
 * must not act on. `stale` frames — a replay, or one already superseded — are
 * *not* an error and are dropped silently: idempotence is the point.
 */
export class ControlFrameRejectedError extends Error {
  /**
   * `sequence-conflict`: a control frame from the creator carries a sequence number the
   * receiver already holds a *different* frame for (SPECIFICATION.md CTL-17) — the
   * creator's application reused a number, which must not be decided silently.
   */
  readonly reason:
    | "not-from-creator"
    | "creator-unknown"
    | "names-the-creator"
    | "sequence-conflict";

  constructor(reason: ControlFrameRejectedError["reason"], message: string) {
    super(message);
    this.name = "ControlFrameRejectedError";
    this.reason = reason;
  }
}

/**
 * The creator's authoritative control state as of `sequence`, carried in its
 * resync response so a joiner, or a client that found a gap, needs nothing else
 * (SPECIFICATION.md §7.4).
 */
export interface ControlSnapshot {
  /**
   * The document's profile (SPECIFICATION.md §5, CTL-10): where the creator confirms
   * what an invitation claimed. Always present in a snapshot a creator sends; may be absent
   * from a control state an application persisted before profiles existed.
   */
  readonly profile?: string;
  readonly sequence: number;
  readonly closed: boolean;
  readonly members: Readonly<Record<MemberId, "read" | "write">>;
  /**
   * The send policy in force and the control sequence at which the
   * creator set it (`0`: the policy the document was created with). Absent while a
   * client has none — a joiner that has neither an invitation's policy nor a
   * snapshot yet. A snapshot carrying a policy that is not newer than the reader's
   * own does not replace it.
   */
  readonly policy?: SyncPolicyJson;
  readonly policySequence?: number;
}

/**
 * What a creator's application persists and restores (SPECIFICATION.md CTL-12): the
 * control state, and the one control frame issued but not yet known to be sent — the
 * outbox. A restarted creator sends that same frame again before it issues anything new,
 * so a number the messenger may already have delivered is never given to another action.
 * Never sent to anyone: the snapshot in a resync answer is the plain `ControlSnapshot`.
 */
export interface PersistedControlState extends ControlSnapshot {
  /** The complete text of a control frame whose send was begun and not known to have ended. */
  readonly pendingControl?: string;
}

/**
 * Whether this client has reason to think something is missing. Never a
 * claim that something *is*: every suspicion is evidence that has lasted long enough to be
 * worth a person's attention, and each can have an innocent cause (a late message, a sender
 * who closed the application). What to do about one is a Resync. Nor is `"ok"` a claim that
 * nothing is (SPECIFICATION.md §10): it means no current evidence, never "synchronised" —
 * a creator whose request went `unanswered` may still lack an offline member's change (LOS-8).
 */
export interface SyncHealth {
  readonly state: "ok" | "suspected";
  readonly suspicions: readonly SyncSuspicion[];
  /** This client's own resync request, if any: outstanding, answered, or expired unanswered. */
  readonly resync: ResyncStatus;
  /**
   * Large changes being received in parts, not yet complete: who from and how far along.
   * Progress, not suspicion — a change spread over a rate-limited provider legitimately
   * takes a long time; one that stops arriving is caught by the silence rule like any other.
   */
  readonly incoming: readonly IncompleteMessage[];
}

/**
 * A resync request holds the single slot for at least this long, however fast the transport
 * claims to be: it has to reach the creator, the creator has to have something newer, and the
 * answer has to come back.
 */
const RESYNC_EXPIRY_FLOOR_MS = 10_000;
/** The longest wait between automatic attempts, whatever the doubling would give. */
const RESYNC_BACKOFF_CAP_MS = 600_000;
/** How many automatic requests one episode of suspicion may cost before only a person can ask again. */
const MAX_AUTOMATIC_LOSS_ATTEMPTS = 3;
/** How many times a joiner that got no answer asks again by itself. */
const MAX_AUTOMATIC_BOOTSTRAP_ATTEMPTS = 5;

/**
 * "broadcast": a broadcast triggered by `edit()` failed — e.g. the channel
 * was removed, or a real messenger refused the send for good.
 * `edit()` itself cannot report this: applying a local mutation always
 * succeeds, and the resulting broadcast happens asynchronously afterward.
 *
 * "apply": a delivery returned by `sync()` could not be applied as a
 * reconciliation update — e.g. it was corrupted in transit. This is the documented
 * behaviour for a modified message (SPECIFICATION.md FRM-6): the delivery is still marked
 * seen (never retried) and `sync()` continues with the rest of the batch;
 * one corrupted delivery must not block or crash the whole client.
 *
 * The default handler is a no-op, which would otherwise surface a
 * "broadcast" failure as an unhandled promise rejection (an "apply"
 * failure would otherwise abort the rest of the sync() batch).
 */
export type DocumentEngineErrorContext = "broadcast" | "apply";
export type DocumentEngineErrorHandler = (
  error: unknown,
  context: DocumentEngineErrorContext,
) => void;

const defaultOnError: DocumentEngineErrorHandler = () => {};

/**
 * Options controlling `DocumentEngine`'s outgoing-message scheduling (not
 * document-loading or lifecycle options — those are `create()`/`join()`'s
 * own positional parameters).
 */
/** A decline another participant sent (SPECIFICATION.md §6.5), as reported to the application. */
export interface ReceivedDecline {
  readonly sender: MemberId;
  readonly reason: DeclineReason;
  /** The document profiles the sender's engine implements, if it said. */
  readonly profiles?: readonly string[];
  /** The sender's own words; untrusted, to be shown as theirs (DCL-4). */
  readonly text?: string;
}

export type { DeclineReason };

export interface DocumentEngineOptions {
  /**
   * The document's profile (SPECIFICATION.md §5): chosen by the creator's application,
   * carried to a joiner in the invitation, fixed for the document's life. `create()` and
   * `join()` refuse one this engine does not implement (`UnsupportedProfileError`).
   * Defaults to `yjs-paragraphs/1`, the one this engine implements.
   */
  profile?: string;
  /**
   * The quiet time of the send scheduler: after each local
   * update, waits up to `batchWindowMs` with no *further* local update before
   * merging everything queued into one message and sending it — instead of one
   * `MessengerPort.send()` per edit. The window resets on every new local
   * update while it is running (same sliding-window shape as
   * `Y.UndoManager`'s own `captureTimeout`, which TipTap's Collaboration
   * extension already uses to group the undo stack — see `SendScheduler`'s
   * doc comment for why that similarity does not couple the two). It is one of
   * the conditions for a send, no longer the only one: `syncPolicy` adds a floor
   * between messages, a deadline, and size bounds.
   *
   * Measured: typing a 44-character sentence one keystroke at a time produces 44
   * messages totalling 793 bytes (about 18 bytes of Yjs bookkeeping per byte of text);
   * the same content as one batched update is 1 message of 62 bytes.
   *
   * @default 500 — batching is the default, not opt-in: a real messenger cannot be
   * expected to cope with one message per keystroke. 500 ms matches `Y.UndoManager`'s
   * own `captureTimeout` default. Pass `0` explicitly for immediate, unbatched sends —
   * tests and benchmarks that need synchronous-looking delivery do so throughout this
   * package's test suite.
   *
   * Not derived from observed network conditions: the caller picks a static number.
   */
  batchWindowMs?: number;

  /**
   * How often and how much this client sends, as *chosen*: the
   * creator's values, or an invitation's. A floor between two messages
   * (`minIntervalMs`), the longest a change may wait (`maxIntervalMs`), size bounds
   * in changed characters (`minChars`, `maxChars`) and how long a message normally
   * takes to arrive (`expectedLatencyMs`). What is left out comes from the
   * transport's default profile (`MessengerPort.transportProfile`), and where the
   * transport has none from the library's defaults: a message after a typing
   * pause, with no floor and no cap. The result is made consistent (`resolveSyncPolicy`), so no
   * combination can starve a pending change, and clamped to the transport's hard
   * bounds — a value below its floor is raised to it, whoever chose it
   * (`effectiveSyncPolicy`). Read the outcome from `DocumentEngine.syncPolicy`.
   */
  syncPolicy?: Partial<SyncPolicy>;

  /**
   * The control sequence at which `syncPolicy` was set, when it comes from an
   * invitation rather than being the creator's own initial choice (`0`, the
   * default): a later policy change from the creator applies only if it is newer.
   * Ignored for a creator re-attaching with `controlState`, which carries its own.
   */
  syncPolicySequence?: number;

  /**
   * Whether this client asks for a resync by itself: a joiner that got no
   * answer asks again, with a doubling wait, and evidence that something is missing that has
   * lasted long enough is followed by one request. Always through the same single slot a
   * person's click uses, never in parallel with it, and bounded per episode. Turn it off and
   * `syncHealth` still reports what it notices; only a person then asks.
   *
   * @default true
   */
  autoResync?: boolean;

  /**
   * Called whenever the state of this client's outgoing changes moves —
   * something queued, a send failed and is being retried, it went out. The state
   * itself is `DocumentEngine.sendStatus`; read that for the current value.
   */
  onSendStatusChange?: (status: SendStatus) => void;

  /**
   * Bounds how often *this* client answers a resync request with a full
   * or partial snapshot — at most once per `resyncResponseThrottleMs`,
   * regardless of how many different requests arrive (SPECIFICATION.md RSY-9). A request this client can't
   * yet answer because of the throttle is not lost — it stays unresolved and
   * is reconsidered on a later `sync()` tick, same as one it has nothing new
   * to offer for yet.
   *
   * @default 1000
   */
  resyncResponseThrottleMs?: number;

  /**
   * This document's fixed creator — known to a joiner from its invitation
   * (SPECIFICATION.md §11) or, for the creator itself, its own `memberId`
   * (`create()` sets it, whatever is passed here). It is the one identity a control
   * frame or a control snapshot is accepted from, so a client that does not know it
   * cannot act on either and rejects them. It also decides who answers a resync
   * request (RSY-6): the creator answers everyone else's, and a peer answers only the
   * creator's own (a creator that restarted has lost its content and nobody
   * else can restore it). A client that does not know the creator answers no
   * one and accepts a resync response from no one.
   */
  creatorMemberId?: MemberId;

  /**
   * The creator's own control state, as the application last persisted it
   * (SPECIFICATION.md CTL-12): given back when the creator re-attaches to
   * its own document, so its sequence counter continues instead of restarting at
   * 1 — a restarted counter would have every control frame rejected as stale —
   * and so its control snapshot, sent to joiners, still lists everyone it had
   * granted. **Honoured only when `creatorMemberId` equals this client's own
   * `memberId`**: a non-creator's persisted sequence could sit above a gap it had
   * not noticed and mark a lost frame stale forever, so a non-creator always
   * re-bootstraps its control state from the creator instead.
   */
  controlState?: PersistedControlState;

  /**
   * Called after every change to this client's control state — a control frame
   * applied, one about to be sent, a snapshot adopted — so the application can persist
   * it (see `controlState`). Only a creator's is worth persisting, and it must be
   * persisted before this returns: the call that announces a pending control frame
   * comes *before* the frame is sent (CTL-12).
   */
  onControlStateChange?: (state: PersistedControlState) => void;
  /**
   * Called for a participant's decline of this document's invitation (SPECIFICATION.md
   * §6.5), at most once per sender. Information only: nothing in the document changes.
   */
  onDecline?: (decline: ReceivedDecline) => void;
}

/** Per-request state for `#considerBootstrapOverlay` — see `#bootstrapOverlaySelection`'s own comment. */
interface BootstrapOverlaySelection {
  hasAdopted: boolean;
}

/**
 * One `resync-request` frame collected during `sync()`'s own receive loop and
 * handed to `#respondToResyncRequests` afterward.
 * `id` is the frame's own `requestId`, chosen by the requester (SPECIFICATION.md
 * §8.2): the same for every copy of the request, whatever delivery ids the messenger
 * gave them, and what an answer names in `respondsTo`.
 */
interface IncomingResyncRequest {
  readonly id: string;
  readonly requester: MemberId;
  /** The requester has no answer from the creator yet: the creator answers it even with nothing new (RSY-7). */
  readonly bootstrap: boolean;
  /** The requester's contiguous control sequence (CTL-9). */
  readonly controlSequence: number;
  readonly stateVector: Uint8Array;
}

/** A resync request a responder keeps until it has answered it (RSY-9), with when it was first heard. */
type PendingResyncRequest = IncomingResyncRequest & { readonly heardAt: number };

export class DocumentEngine {
  readonly documentId: DocumentId;
  readonly memberId: MemberId;
  readonly document: ReconciledDocument;
  /**
   * Per-author text ranges and last-edit positions, derived from the
   * delivery stream rather than a presence capability
   * (SPECIFICATION.md §5.4). Read-only from the
   * outside; `edit()`/`sync()` are the only writers.
   */
  readonly attribution: AttributionTracker;

  #messenger: MessengerPort;
  #seenDeliveryIds = new Set<DeliveryId>();
  /**
   * This engine's own sends not yet seen in a `receive` answer, and when they were sent: kept
   * in `#seenDeliveryIds` until their echo arrives or an hour has passed, whatever `receive`
   * says in between (see `#forgetWhatReceiveNoLongerOffers`).
   */
  readonly #ownUnechoed = new Map<DeliveryId, number>();
  /** The ids the previous non-empty `receive` answer held, to notice the window moving past them all (LOS-8). */
  #previouslyOffered = new Set<DeliveryId>();
  /** When a truncated window was noticed; cleared once an answer to this engine's own request applies (LOS-8). */
  #historyTruncatedSince: number | undefined;
  // Whether the last `receive` failed (LOS-8).
  #receiveFailed = false;
  // "Fully resolved" — answered, suppressed, or this client's own request.
  // Never reconsidered again once added (same "never retried" contract
  // #seenDeliveryIds already has).
  #seenResyncRequestIds = new Set<ResyncRequestId>();
  /**
   * Requests this engine may have to answer and has not yet — throttled, or nothing to offer
   * yet (SPECIFICATION.md RSY-9): kept and reconsidered on every later `sync()`, one per
   * requester (a newer request replaces an older one), bounded, and dropped after a while.
   * Without this a request skipped once was never looked at again: its delivery had been seen.
   */
  readonly #pendingResyncRequests = new Map<MemberId, PendingResyncRequest>();
  // Resync request ids *this* client itself originated via
  // requestResync() — a subset of #seenResyncRequestIds, tracked
  // separately so sync() can recognize "a resync-response just answered
  // MY OWN request" without conflating it with requests seen from others
  // (hasCompletedBootstrap).
  #ownResyncRequestIds = new Set<ResyncRequestId>();
  #lastResyncResponseAt: number | null = null;
  // One entry per *true bootstrap* request this client itself made — never populated for a partial gap-heal
  // request, which has no overlay-selection question to track (its
  // response's overlay is never adopted at all). Read/written by
  // #considerBootstrapOverlay(); never pruned, same as the other
  // per-request maps above.
  #bootstrapOverlaySelection = new Map<ResyncRequestId, BootstrapOverlaySelection>();
  #unobserve: () => void;
  #unobserveAttribution: () => void;
  #onError: DocumentEngineErrorHandler;
  #syncPolicy: SyncPolicy;
  #transport: TransportProfile | undefined;
  // The policy the creator set, or the invitation's until a newer one arrives:
  // what `#syncPolicy` is derived from. `undefined` for a joiner that has been
  // told none yet. `sequence` is the control sequence it was set at.
  #policy: { values: Partial<SyncPolicy>; sequence: number } | undefined;
  #resyncResponseThrottleMs: number;
  #creatorMemberId: MemberId | undefined;
  readonly #profile: DocumentProfile;
  #onControlStateChange: ((state: PersistedControlState) => void) | undefined;
  /** The creator's outbox: a control frame being sent, persisted before the send (CTL-12). */
  #pendingControl: string | undefined;
  /** Every control frame received, by sequence: a different one under a known number is a conflict (CTL-17). */
  readonly #controlFrameTexts = new Map<number, string>();
  #onDecline: ((decline: ReceivedDecline) => void) | undefined;
  readonly #declinesReported = new Set<MemberId>();
  // --- control state ---
  // Explicit `read`/`write` grants only; the creator is implicit and never
  // stored here, and an absent member is *unknown*, not denied.
  #members = new Map<MemberId, "read" | "write">();
  #closed = false;
  // The highest sequence applied per target (`member:<id>` or `close`), so a
  // replay or a superseded message is inert while a late message for a member
  // nobody has mentioned since still applies.
  #controlAppliedSeq = new Map<string, number>();
  // A snapshot's sequence: every control frame at or below it is already
  // reflected, so it is stale.
  #controlFloor = 0;
  // Every sequence seen above the floor, applied or stale, and the highest —
  // the inputs of `controlGaps`.
  #controlReceivedSeqs = new Set<number>();
  #highestControlSeq = 0;
  // The last sequence this client *issued* (creator only).
  #issuedControlSeq = 0;
  // Serialises the creator's control sends, so a failed send never consumes a
  // number (a skipped number would look like a lost message forever).
  #controlChain: Promise<unknown> = Promise.resolve();
  #scheduler: SendScheduler;
  #detector: LossDetector;
  // The slices of large frames that have not all arrived (bounded: it holds other people's input).
  #reassembler = new Reassembler();
  // The transport's largest message, if it says: a frame over it is spread or cut.
  #maxBytes: number | undefined;
  // `SendScheduler.droppedCount` as of the last `resync()` the transport accepted.
  #distributedThroughDrop = 0;
  // The one slot a resync request of this client's own may hold, however many things ask.
  #resyncGate = new ResyncGate();
  #autoResync: boolean;
  // Automatic requests made in the current episode of suspicion (reset when it clears), and
  // when the last automatic attempt was made, whether or not the send went through.
  #automaticLossAttempts = 0;
  #automaticBootstrapAttempts = 0;
  #lastAutomaticAttemptAt: number | null = null;
  // Characters changed by the local transaction in progress: counted by the
  // plain-text observer, which Yjs fires before the `update` event that queues the
  // update, and taken by that event. Never counted while a remote update is applied.
  #localChars = 0;
  #applyingRemote = false;
  // See hasCompletedBootstrap's own doc comment. create() sets this true
  // immediately after construction; join() leaves it false until sync()
  // applies a resync-response answering one of #ownResyncRequestIds.
  #hasCompletedBootstrap = false;
  // Defaults to this.memberId: any document mutation that is not
  // specifically a sync() apply is, by construction, a local edit —
  // whether it went through edit() or an editor binding (such as TipTap's
  // Collaboration extension) calling doc.transact() directly against the
  // fragment it was handed — an editor is handed the Y.Doc and mutates it
  // itself, so edit() is not the only local-mutation path. sync()
  // temporarily overrides this to delivery.sender for the duration of one
  // applyUpdate call, then restores the default. Read inside the
  // #attribution observer callback that call synchronously triggers — safe
  // because Yjs fires observers synchronously before
  // transact()/applyUpdate() returns, one call at a time (verified
  // empirically — see observePlainTextChanges's doc comment in
  // @tdsp/reconciliation).
  #attributionAuthor: MemberId;

  private constructor(
    documentId: DocumentId,
    memberId: MemberId,
    messenger: MessengerPort,
    onError: DocumentEngineErrorHandler,
    document: ReconciledDocument,
    options: DocumentEngineOptions,
    transport: TransportProfile | undefined,
  ) {
    this.documentId = documentId;
    this.memberId = memberId;
    this.#messenger = messenger;
    this.#onError = onError;
    this.document = document;
    this.attribution = new AttributionTracker();
    this.#attributionAuthor = memberId;
    this.#transport = transport;
    this.#maxBytes = transport?.bounds.maxBytes ?? undefined;
    const onSendStatusChange = options.onSendStatusChange;
    this.#resyncResponseThrottleMs = options.resyncResponseThrottleMs ?? 1000;
    this.#creatorMemberId = options.creatorMemberId;
    this.#profile = profileFor(options.profile ?? YJS_PARAGRAPHS_1);
    this.#autoResync = options.autoResync ?? true;
    this.#onControlStateChange = options.onControlStateChange;
    this.#onDecline = options.onDecline;
    if (options.controlState !== undefined && options.creatorMemberId === memberId) {
      const state = options.controlState;
      this.#members = new Map(
        Object.entries(state.members).filter(([member]) => member !== memberId),
      );
      this.#closed = state.closed;
      this.#issuedControlSeq = state.sequence;
      this.#highestControlSeq = state.sequence;
      this.#controlFloor = state.sequence;
      const restored = syncPolicyFromJson(state.policy);
      if (restored !== undefined) {
        this.#policy = { values: restored, sequence: state.policySequence ?? 0 };
      }
      this.#pendingControl = state.pendingControl;
    }
    if (this.#policy === undefined && options.syncPolicy !== undefined) {
      this.#policy = {
        values: options.syncPolicy,
        sequence: options.syncPolicySequence ?? 0,
      };
    }
    this.#syncPolicy = effectiveSyncPolicy(transport, this.#policy?.values);
    if (this.#policy === undefined && options.creatorMemberId === memberId) {
      // A creator always has a policy of its own: the one its snapshot and its
      // invitations carry, set at creation (sequence 0) until it changes it.
      this.#policy = { values: this.#syncPolicy, sequence: 0 };
    }

    const editFrameOverhead = frameByteLength(encodeEditFrame(documentId, new Uint8Array(3))) - 4;
    this.#scheduler = new SendScheduler({
      quietMs: options.batchWindowMs ?? 500,
      policy: this.#syncPolicy,
      send: (update) => this.#broadcast(update),
      classify: classifySendFailure,
      onDropped: (error) => this.#onError(this.#blameProfileFor(error), "broadcast"),
      onStatusChange: onSendStatusChange && (() => onSendStatusChange(this.sendStatus)),
      sendHeartbeat: () => this.#broadcastHeartbeat(),
      splitting:
        this.#maxBytes === undefined
          ? undefined
          : {
              maxBytes: this.#maxBytes,
              // The edit frame's other fields, then the update as Base64: four characters for
              // every three bytes (SPECIFICATION.md §4).
              frameSize: (update) => editFrameOverhead + 4 * Math.ceil(update.length / 3),
              fragment: (update) => {
                // Cutting an edit is where it is refused if this client may not send one:
                // the same permanent refusal a whole edit gets (`SendRefusedError`).
                this.#assertMayEdit();
                return this.#fragmentsOf(encodeEditFrame(documentId, update));
              },
              sendFrame: (frame) => this.#sendFrame(frame),
            },
    });
    this.#detector = new LossDetector({
      memberId,
      creatorMemberId: () => this.#creatorMemberId,
      policy: () => this.#syncPolicy,
      pendingGapClients: () => this.#profile.pendingGapClients(this.document),
      lacksUpdatesOf: (stateVector) => this.#profile.lacksUpdatesOf(this.document, stateVector),
      highestControlSequence: () => this.#highestControlSeq,
      controlGaps: () => this.controlGaps,
    });

    this.#unobserve = observeUpdates(this.document, (update, origin) => {
      if (origin === REMOTE_ORIGIN) {
        return;
      }
      const chars = this.#localChars;
      this.#localChars = 0;
      this.#scheduler.enqueue(update, chars);
    });

    this.#unobserveAttribution = observePlainTextChanges(getFragment(this.document), (change) => {
      if (!this.#applyingRemote) {
        this.#localChars += change.length;
      }
      if (change.kind === "insert") {
        this.attribution.recordInsert(change.index, change.length, this.#attributionAuthor);
      } else {
        this.attribution.recordDelete(change.index, change.length, this.#attributionAuthor);
      }
    });
  }

  /**
   * Creates a new document, becomes its first creator, and seeds one
   * empty paragraph before any other client can see this document.
   *
   * The seed happens here, explicitly, on a document with no observer
   * attached yet — not lazily on first edit. Y.XmlElement creation is a
   * discrete CRDT operation: if two clients independently created their
   * own "first paragraph" concurrently (e.g. the creator and a joiner
   * editing before either has synced the other), the two paragraphs would
   * not merge into one the way Y.Text characters inserted at the same
   * position do — the document would end up with two competing empty
   * paragraphs. Seeding once, before the channel is shared with anyone,
   * guarantees every later joiner's first sync() finds this same paragraph
   * and edits within it instead.
   */
  static async create(
    documentId: DocumentId,
    memberId: MemberId,
    messenger: MessengerPort,
    onError: DocumentEngineErrorHandler = defaultOnError,
    options: DocumentEngineOptions = {},
  ): Promise<DocumentEngine> {
    // Refused before anything is registered or sent (PRF-3).
    const profile = profileFor(options.profile ?? YJS_PARAGRAPHS_1);
    await messenger.createDocument(documentId, memberId);
    // Asked before anything is sent, and allowed to fail the call: falling back to
    // the library's defaults would be sending faster than the transport allows.
    const transport = await messenger.transportProfile?.();

    const document = profile.createInitial();

    const client = new DocumentEngine(
      documentId,
      memberId,
      messenger,
      onError,
      document,
      { ...options, creatorMemberId: memberId },
      transport,
    );
    // A creator always already has its own document — no bootstrap needed.
    client.#hasCompletedBootstrap = true;
    // Sent explicitly (not via the observer, which only attaches after
    // this point, and never batched, regardless of batchWindowMs) so the
    // seed is one clean send, not a duplicate.
    const seedFrame = encodeEditFrame(documentId, profile.encodeState(document));
    // Through the scheduler like every message (SPECIFICATION.md SND-2); an edit, so
    // receivers expect a follow-up and the heartbeat is owed after it.
    const seedId = await client.#scheduler.submit(
      () => messenger.send(documentId, memberId, seedFrame),
      { armsHeartbeat: true },
    );
    client.#seenDeliveryIds.add(seedId);
    return client;
  }

  /**
   * Declines an invitation (SPECIFICATION.md §6.5, DCL-2): sends exactly one `decline`
   * frame into the document's channel and keeps no document state — no join is needed, and
   * none is possible when this engine does not implement the document's profile, which is the
   * typical reason. The transport must already have the document bound, as for a join. Goes
   * through a send scheduler like every message (SND-2), paced by the transport's floor.
   *
   * `profiles` should name what this engine implements when the reason is
   * `unsupported-profile` or `unsupported-version` (DCL-1), so the creator can invite again with
   * one of them. Resolves with the message's delivery id; rejects if it could not be sent.
   */
  static async decline(
    documentId: DocumentId,
    memberId: MemberId,
    messenger: MessengerPort,
    options: { reason: DeclineReason; profiles?: readonly string[]; text?: string },
  ): Promise<DeliveryId> {
    const frame = encodeDeclineFrame({ documentId, ...options });
    const transport = await messenger.transportProfile?.();
    const scheduler = new SendScheduler({
      quietMs: 0,
      policy: effectiveSyncPolicy(transport, undefined),
      send: async () => {},
      classify: classifySendFailure,
      onDropped: () => {},
    });
    try {
      return await scheduler.submit(() => messenger.send(documentId, memberId, frame), {
        armsHeartbeat: false,
      });
    } finally {
      scheduler.stop();
    }
  }

  /**
   * Joins a document a creator has already granted `memberId` a permission
   * on. Requests a resync *before* syncing (SPECIFICATION.md RSY-1) rather than
   * relying on the transport replaying history — a `MessengerPort` adapter is never
   * required to do that (a Signal device link, for one, sees no history), so
   * `join()` must not depend on it either. Calling `requestResync()`
   * first, not after, means this client's own request id is recorded
   * (`#ownResyncRequestIds`/`#seenResyncRequestIds`) before its own first
   * `#respondToResyncRequests()` call runs — a joiner never answers its
   * own request.
   *
   * Best-effort: `requestResync()` failing (e.g. a disconnected mock
   * member) is caught and routed to `onError(..., "broadcast")` rather
   * than rejecting `join()` itself, so that an empty `join()` with
   * nothing to catch up on succeeds. See `hasCompletedBootstrap` for the honest, observable
   * "did this actually work" signal — a channel with no reachable member
   * holding content cannot bootstrap by this or any other mechanism.
   */
  static async join(
    documentId: DocumentId,
    memberId: MemberId,
    messenger: MessengerPort,
    onError: DocumentEngineErrorHandler = defaultOnError,
    options: DocumentEngineOptions = {},
  ): Promise<DocumentEngine> {
    // Without the creator no control frame and no resync response can ever be accepted, so
    // the client would silently never converge (SPECIFICATION.md LIF-4).
    if (options.creatorMemberId === undefined || options.creatorMemberId === "") {
      throw new Error(
        `cannot join ${documentId} without the creator's member id: it comes with the invitation`,
      );
    }
    // Refused before anything is sent (PRF-3): the application can decline instead.
    const profile = profileFor(options.profile ?? YJS_PARAGRAPHS_1);
    const transport = await messenger.transportProfile?.();
    const client = new DocumentEngine(
      documentId,
      memberId,
      messenger,
      onError,
      profile.createEmpty(),
      options,
      transport,
    );
    try {
      await client.requestResync();
    } catch (error) {
      onError(error, "broadcast");
    }
    await client.sync();
    return client;
  }

  get fragment(): ReconciledFragment {
    return getFragment(this.document);
  }

  /**
   * Whether at least one local edit is currently waiting to be sent — for its
   * send window to open (the quiet time, the floor between messages), for a retry
   * after a failed send, or for `flush()`/`dispose()`. A real "have I sent
   * everything I've typed" signal for an application's connection status — not a
   * synthetic per-poll-tick flag, and not the same thing as "is a send in flight":
   * `#broadcast`'s own `await this.#messenger.send(...)` isn't tracked here, since
   * with the mock transport it resolves effectively immediately and surfacing it
   * would only ever flicker on and off within one poll interval. A change whose
   * send failed is pending again (it is kept for a retry, SND-6).
   */
  get hasPendingChanges(): boolean {
    return this.#scheduler.hasPending;
  }

  /**
   * The state of this client's outgoing changes: `idle`, `waiting`
   * for a send window, or `retrying` after a failed send — with how many times it
   * has failed, when the next attempt is due, and the failure's message. What a
   * connection indicator should show for "my edits have not gone out".
   */
  get sendStatus(): SendStatus {
    return this.#scheduler.status;
  }

  /**
   * Whether this client may hold content no other participant has (SPECIFICATION.md
   * SND-8, SND-10): a message of its own carrying content was dropped for good since the engine
   * started, and no `resync()` has sent the whole state since — every part of it, when it is
   * too large for one message. Dropping ends the send
   * job only — the change stays in this document, and every later change builds on it, so an
   * application must not show the document as synchronised while this is true. `resync()` is
   * the repair: it sends the whole state, once whatever caused the refusal is fixed. Held in
   * memory only; conservative — any dropped message that carried content counts.
   */
  get hasUndistributedChanges(): boolean {
    return this.#scheduler.droppedCount > this.#distributedThroughDrop;
  }

  /**
   * Whether this client has reason to think something is missing: a gap the CRDT holds
   * later updates across, a sender that went silent when a follow-up was due, a
   * heartbeat whose state we have not reached, or a creator's control message we never
   * saw. Each has to have lasted an expected latency first, so a merely late message is
   * not reported. Evidence, never proof (`SyncHealth`).
   */
  get syncHealth(): SyncHealth {
    const suspicions: SyncSuspicion[] = [
      ...this.#detector.suspicions(),
      ...(this.#historyTruncatedSince === undefined
        ? []
        : [{ kind: "history-truncated" as const, since: this.#historyTruncatedSince }]),
    ];
    return {
      state: suspicions.length === 0 ? "ok" : "suspected",
      suspicions,
      resync: this.#resyncGate.status(),
      incoming: this.#reassembler.incomplete(),
    };
  }

  /** The effective sync policy: defaults, the transport's suggestion and what was chosen, made consistent and clamped to the transport's bounds. */
  get syncPolicy(): SyncPolicy {
    return this.#syncPolicy;
  }

  /** What the transport said about its own limits, if it said anything (`MessengerPort.transportProfile`). */
  get transportProfile(): TransportProfile | undefined {
    return this.#transport;
  }

  /**
   * Whether this client has a baseline of document content — `true`
   * immediately for `create()` (a creator always already has its own
   * document); initially `false` for `join()`, becoming `true` once a
   * `resync-response` answering one of *this* client's own
   * `requestResync()` calls has actually been applied (SPECIFICATION.md RSY-14).
   * A joiner whose creator never comes online stays `false` forever — an honest
   * limitation of a broadcast-only, history-less transport, not a bug to be papered
   * over. An application should show it as "waiting for the creator", distinct from
   * "syncing" (which means "I have content and am sending my own edit").
   */
  get hasCompletedBootstrap(): boolean {
    return this.#hasCompletedBootstrap;
  }

  /** This document's fixed creator, if this client knows it (a joiner learns it from the invitation). */
  get creatorMemberId(): MemberId | undefined {
    return this.#creatorMemberId;
  }

  /**
   * Whether the creator has closed this document: every
   * cooperating client stops sending edits of its own, while edits sent before the
   * close still arrive and apply (SPECIFICATION.md LIF-6). Terminal — a closed
   * document never reopens.
   */
  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Every explicit `read`/`write` grant this client currently knows of. The
   * creator is implicit and not listed; a member absent from the map is
   * *unknown* — never granted, revoked, or not yet heard about — not denied.
   */
  get memberPermissions(): ReadonlyMap<MemberId, "read" | "write"> {
    return this.#members;
  }

  /** `"creator"` for the creator, the explicit grant if there is one, else `undefined` (unknown). */
  permissionOf(member: MemberId): Permission | undefined {
    if (this.#creatorMemberId !== undefined && member === this.#creatorMemberId) {
      return "creator";
    }
    return this.#members.get(member);
  }

  /**
   * For the creator, the last control sequence number it issued; for anyone
   * else, the highest it has applied. Exposed so an application can persist the
   * creator's counter — a creator that restarted from 1 would have every
   * message rejected as stale (SPECIFICATION.md CTL-12).
   */
  /**
   * This client's control state, in the form `controlState` accepts back. For the
   * creator, current as of the last number it issued; for anyone else, as of the
   * highest sequence it has seen.
   */
  /** The document's profile id (SPECIFICATION.md §5), fixed for its life. */
  get profile(): string {
    return this.#profile.id;
  }

  get controlState(): ControlSnapshot {
    return {
      profile: this.#profile.id,
      sequence: this.controlSequence,
      closed: this.#closed,
      members: Object.fromEntries(this.#members),
      ...(this.#policy === undefined
        ? {}
        : {
            policy: syncPolicyToJson(resolveSyncPolicy(this.#policy.values)),
            policySequence: this.#policy.sequence,
          }),
    };
  }

  /**
   * The policy an invitation should carry: the one in force, and the
   * control sequence it was set at, so a joiner knows which later change is newer.
   * `undefined` while this client has been told none.
   */
  get invitationPolicy(): { readonly policy: SyncPolicy; readonly sequence: number } | undefined {
    return this.#policy === undefined
      ? undefined
      : { policy: resolveSyncPolicy(this.#policy.values), sequence: this.#policy.sequence };
  }

  get controlSequence(): number {
    return this.#creatorMemberId === this.memberId
      ? this.#issuedControlSeq
      : this.#highestControlSeq;
  }

  /**
   * Control sequence numbers at or below the highest seen that never arrived
   * and are not covered by a snapshot: each is a control message this client
   * has reason to believe was lost. Empty when nothing is known to be missing.
   * *Detection* only — acting on it (asking the creator for a snapshot) is loss
   * detection's job (SPECIFICATION.md LOS-5, LOS-6).
   */
  get controlGaps(): readonly number[] {
    const gaps: number[] = [];
    for (let n = this.#controlFloor + 1; n <= this.#highestControlSeq; n++) {
      if (!this.#controlReceivedSeqs.has(n)) {
        gaps.push(n);
      }
    }
    return gaps;
  }

  /**
   * Applies a local mutation inside one reconciliation transaction, then
   * broadcasts it. `#attributionAuthor` already defaults to `this.memberId`
   * (see its doc comment) — nothing to set here.
   */
  edit(mutator: (fragment: ReconciledFragment) => void): void {
    transact(this.document, () => mutator(this.fragment));
  }

  /**
   * Polls the messenger for deliveries on this channel and applies every
   * one this client has not already seen — including its own past sends,
   * which are skipped via `#seenDeliveryIds` rather than by sender identity,
   * so a client cannot be fooled by a spoofed sender field. Returns the
   * deliveries actually applied, for callers that want delivery accounting.
   *
   * Also checks for and answers any unanswered resync request — an application
   * already polls `sync()` on every active document, so this needs no separate
   * mechanism.
   */
  async sync(): Promise<readonly Delivery[]> {
    let deliveries: readonly Delivery[];
    try {
      deliveries = await this.#messenger.receive(this.documentId, this.memberId);
    } catch (error) {
      this.#receiveFailed = true;
      throw error;
    }
    if (this.#receiveFailed) {
      // A bridge that could not answer may have restarted, and a restarted one may offer old
      // deliveries again (BRG-17): an overlap with the previous answer then proves nothing, so
      // the first answer after a failure is treated as a truncated history (LOS-8).
      this.#receiveFailed = false;
      this.#historyTruncatedSince ??= Date.now();
    }
    const applied: Delivery[] = [];
    // A resync request arrives through this same receive() stream as an ordinary
    // frame kind — collected here, answered by #respondToResyncRequests after
    // the loop.
    const incomingResyncRequests: IncomingResyncRequest[] = [];
    for (const delivery of deliveries) {
      if (this.#seenDeliveryIds.has(delivery.id)) {
        continue;
      }
      this.#seenDeliveryIds.add(delivery.id);
      try {
        // Decoding failures and the checks below (wrong document, another
        // profile) are deliberately caught by the same handler as a corrupted
        // update: once the bridge's own routing has claimed this delivery
        // belongs to this documentId, any of these is a loud "apply" failure,
        // never a silent skip (SPECIFICATION.md FRM-8).
        let frameText = delivery.payload;
        let frame: Frame = decodeFrame(frameText);
        this.#checkFrameBelongsHere(frame);
        if (frame.kind === "fragment") {
          // One slice of a larger frame: held until every slice has arrived, then handled
          // exactly as if the whole frame had come from this sender in one message. A sender
          // mid-way through a large change has not gone quiet, so it counts as heard.
          this.#detector.heardEdit(delivery.sender);
          const whole = this.#reassembler.add(delivery.sender, frame);
          if (whole === undefined) {
            continue;
          }
          frameText = utf8ToText(whole);
          const inner = decodeFrame(frameText);
          if (inner.kind === "fragment") {
            throw new Error("a fragment carried another fragment");
          }
          this.#checkFrameBelongsHere(inner);
          frame = inner;
        }
        if (frame.kind === "heartbeat") {
          // Nothing to apply: it only says what the sender has and that it has nothing more
          // to say, so the loss detector can compare it with what this client holds.
          this.#detector.heardHeartbeat(delivery.sender, frame.stateVector, frame.controlSequence);
          continue;
        }
        if (frame.kind === "resync-request") {
          // Nothing to apply — carries no document content (SPECIFICATION.md
          // §8.2's own description, unchanged by folding this into a frame kind). Not heard
          // as an edit either: nothing is due after a request, so counting it as one made
          // every bystander suspect a joiner of going quiet and ask for a resync itself —
          // a cascade on every join (SPECIFICATION.md LOS-3).
          incomingResyncRequests.push({
            id: frame.requestId,
            requester: delivery.sender,
            bootstrap: frame.bootstrap,
            controlSequence: frame.controlSequence,
            stateVector: frame.stateVector,
          });
          continue;
        }
        if (frame.kind === "decline") {
          // Information, never state (SPECIFICATION.md DCL-3).
          this.#reportDecline(delivery.sender, frame);
          continue;
        }
        if (frame.kind === "control") {
          this.#detector.heardEdit(delivery.sender);
          this.#applyControlFrame(frame, delivery.sender, frameText);
          this.#notifyControlStateChange();
          continue;
        }
        if (frame.kind === "edit") {
          this.#detector.heardEdit(delivery.sender);
          // An edit frame is one member's batch, so its updates come from one Yjs client:
          // that is how a gap the CRDT names by client id gets a member to blame.
          const clients = this.#profile.updateClientIds(frame.update);
          if (clients.length === 1) {
            this.#detector.learnClient(clients[0] as number, delivery.sender);
          }
        }
        // A close stops new edits at their sender, not in delivery (SPECIFICATION.md
        // LIF-6): an edit sent before the close may arrive after it and is applied like
        // any other, so every receiver ends with the same content whichever came first.
        // Only the creator answers a resync request, with one
        // exception: a creator that restarted has lost its content, and only a
        // peer can restore it. So a response counts if it comes from the creator,
        // or — for the creator alone — answers one of its own requests.
        if (
          frame.kind === "resync-response" &&
          !this.#mayAcceptResyncResponse(delivery.sender, frame.respondsTo)
        ) {
          continue;
        }
        // The creator confirms the document's profile in its snapshot, and content of another
        // profile must never be applied — none of this response is (SPECIFICATION.md CTL-10).
        if (
          frame.kind === "resync-response" &&
          frame.control !== null &&
          delivery.sender === this.#creatorMemberId
        ) {
          if (frame.control.profile !== this.#profile.id) {
            throw new FrameDecodeError(
              "profile-mismatch",
              `the creator's snapshot names the profile ${JSON.stringify(frame.control.profile)}, this document is ${this.#profile.id}`,
            );
          }
          // The one snapshot rule the decoder cannot check, since only the engine knows who
          // the creator is — checked here, before anything of the frame is applied (FRM-6).
          if (Object.hasOwn(frame.control.members, delivery.sender)) {
            throw new FrameDecodeError(
              "invalid-field",
              "the creator's snapshot lists the creator as a member; its role is fixed (CTL-4)",
            );
          }
        }
        // A resync-response answering one of THIS client's own requests
        // defaults to the unattributed sentinel, not delivery.sender
        // (SPECIFICATION.md RSY-13).
        // For a true bootstrap, #considerBootstrapOverlay below replaces
        // this wholesale via attribution.restore() when it adopts an
        // overlay; if it never does (malformed overlay, one already adopted),
        // the honest fallback is "unattributed", never a
        // confident misattribution to whoever happened to answer. For a
        // partial gap-heal, the sentinel IS the final answer — no overlay
        // is ever adopted for that case at all.
        // The same holds for an answer to someone else's request: its sender sent it but did
        // not necessarily write it (SPECIFICATION.md RSY-13), so whatever it adds here is
        // unattributed too — only an answer to our own request can bring an overlay.
        const isOwnResyncResponse =
          frame.kind === "resync-response" && this.#ownResyncRequestIds.has(frame.respondsTo);
        this.#attributionAuthor =
          frame.kind === "resync-response" ? UNATTRIBUTED_AUTHOR_ID : delivery.sender;
        this.#applyingRemote = true;
        try {
          this.#profile.applyUpdate(this.document, frame.update, REMOTE_ORIGIN);
          applied.push(delivery);
          if (frame.kind === "resync-response") {
            if (frame.control !== null && delivery.sender === this.#creatorMemberId) {
              this.#applyControlSnapshot(frame.control);
            }
            if (isOwnResyncResponse) {
              this.#historyTruncatedSince = undefined;
              this.#resyncGate.answered();
              this.#detector.answered();
              this.#hasCompletedBootstrap = true;
              const selection = this.#bootstrapOverlaySelection.get(frame.respondsTo);
              if (selection) {
                this.#considerBootstrapOverlay(selection, frame.attribution);
              }
            }
          }
        } finally {
          this.#applyingRemote = false;
          this.#attributionAuthor = this.memberId;
        }
      } catch (error) {
        // a corrupted/modified/misrouted/version-mismatched delivery must
        // not abort the rest of this batch — see DocumentEngineErrorHandler's
        // doc comment above for what happens instead.
        this.#onError(error, "apply");
      }
    }
    this.#noticeTruncatedWindow(deliveries);
    this.#forgetWhatReceiveNoLongerOffers(deliveries);
    this.#detector.observe();
    this.#endTruncationNobodyAnswersTheCreator();
    await this.#considerAutomaticResync().catch((error: unknown) =>
      this.#onError(error, "broadcast"),
    );
    await this.#respondToResyncRequests(this.#queueResyncRequests(incomingResyncRequests));
    return applied;
  }

  /**
   * Adds the requests heard in this `sync()` to those still to be answered and returns all of
   * them, oldest first (RSY-9): one per requester — a newer request replaces an older one in its
   * place, since a requester has one outstanding at a time (RSY-3) — at most
   * `MAX_PENDING_REQUESTS`, none heard longer ago than `PENDING_REQUEST_TTL_MS`.
   */
  #queueResyncRequests(heard: readonly IncomingResyncRequest[]): PendingResyncRequest[] {
    const now = Date.now();
    for (const request of heard) {
      // Replacing keeps the requester's place: a requester that asks again because its
      // request expired (RSY-5) must not go back to the end of the line behind a flood.
      this.#pendingResyncRequests.set(request.requester, { ...request, heardAt: now });
    }
    for (const [requester, request] of this.#pendingResyncRequests) {
      if (
        now - request.heardAt > PENDING_REQUEST_TTL_MS ||
        this.#pendingResyncRequests.size > MAX_PENDING_REQUESTS
      ) {
        this.#pendingResyncRequests.delete(requester);
      }
    }
    return [...this.#pendingResyncRequests.values()];
  }

  /**
   * Whether the bridge's window has moved past every delivery its previous answer held
   * (SPECIFICATION.md LOS-8). A bridge drops the oldest first and keeps order
   * (BRG-17), so while one previously offered delivery is still there, nothing this engine
   * has not read was dropped; once none is, something unread may have been.
   */
  #noticeTruncatedWindow(deliveries: readonly Delivery[]): boolean {
    const previous = this.#previouslyOffered;
    if (deliveries.length > 0) {
      this.#previouslyOffered = new Set(deliveries.map((delivery) => delivery.id));
    }
    const truncated =
      previous.size > 0 &&
      deliveries.length > 0 &&
      !deliveries.some((delivery) => previous.has(delivery.id));
    if (truncated && this.#historyTruncatedSince === undefined) {
      this.#historyTruncatedSince = Date.now();
    }
    return truncated;
  }

  /**
   * The creator's *history truncated* evidence ends when a request it made after the evidence
   * expired unanswered (SPECIFICATION.md LOS-8). A peer answers the creator only when it
   * holds content the creator lacks (RSY-6, RSY-7), so silence means either nothing to recover or
   * nobody online to recover it from — and without this the creator would warn for ever after
   * every bridge hiccup. Everyone else waits for the creator's answer, which it must give.
   */
  #endTruncationNobodyAnswersTheCreator(): void {
    if (this.#historyTruncatedSince === undefined || this.memberId !== this.#creatorMemberId) {
      return;
    }
    const status = this.#resyncGate.status();
    if (
      status.state === "idle" &&
      status.lastOutcome === "unanswered" &&
      (this.#resyncGate.lastRequestAt ?? Number.NEGATIVE_INFINITY) >= this.#historyTruncatedSince
    ) {
      this.#historyTruncatedSince = undefined;
    }
  }

  /** Records a delivery id this engine's own send got, so its echo is not processed. */
  #markOwnSend(id: DeliveryId): void {
    this.#seenDeliveryIds.add(id);
    this.#ownUnechoed.set(id, Date.now());
  }

  /**
   * Keeps the memory of processed deliveries to what `receive` can still return
   * (SPECIFICATION.md TRN-8, BRG-17): a bridge keeps only a bounded window of a
   * document's deliveries. One it dropped may still come back — after a bridge restart —
   * and is then processed again, which every frame kind tolerates: content is a CRDT, stale
   * control is inert, declines and overlays count once. This engine's own sends are kept
   * until their echo has been seen or an hour has passed, since an echo can lag. A bounded
   * number of resync request ids is kept, newest last.
   */
  #forgetWhatReceiveNoLongerOffers(deliveries: readonly Delivery[]): void {
    const offered = new Set(deliveries.map((delivery) => delivery.id));
    const now = Date.now();
    for (const [id, sentAt] of this.#ownUnechoed) {
      if (offered.has(id) || now - sentAt > OWN_ECHO_WAIT_MS) {
        this.#ownUnechoed.delete(id);
      }
    }
    for (const id of this.#seenDeliveryIds) {
      if (!offered.has(id) && !this.#ownUnechoed.has(id)) {
        this.#seenDeliveryIds.delete(id);
      }
    }
    // Insertion order is age order: the oldest request ids go first.
    for (const id of this.#seenResyncRequestIds) {
      if (this.#seenResyncRequestIds.size <= MAX_REMEMBERED_REQUESTS) {
        break;
      }
      if (!this.#ownResyncRequestIds.has(id)) {
        this.#seenResyncRequestIds.delete(id);
      }
    }
  }

  /**
   * Grants, changes or revokes (`null`) `member`'s `read` or `write` permission.
   * **Creator only**: it broadcasts a sequence-numbered control
   * frame that every cooperating client honours, and applies it locally once the
   * send has succeeded. Enforcement is application-level and depends on the other
   * clients being cooperative — nothing in the messenger enforces it
   * (SPECIFICATION.md §15.2, §15.3).
   *
   * `"creator"` cannot be granted, and the creator's own record cannot be
   * changed: a creator is fixed at creation.
   */
  async setMembership(member: MemberId, permission: "read" | "write" | null): Promise<void> {
    if ((permission as Permission | null) === "creator") {
      throw new Error(
        "creator status cannot be granted — it is fixed at document creation and permanent",
      );
    }
    await this.#issueControl({ action: "membership", member, permission }, () => {
      if (member === this.memberId) {
        throw new Error(
          `${member}'s own creator status is permanent and cannot be changed via setMembership`,
        );
      }
    });
  }

  /**
   * Marks the document finished (SPECIFICATION.md §6.4; the counterpart of `create()`): every cooperating client stops sending edits
   * of its own, while edits already sent still arrive and apply, and local content stays
   * readable. **Creator only**,
   * terminal, and idempotent — closing an already-closed document does nothing.
   */
  async closeDocument(): Promise<void> {
    if (this.#closed && this.#creatorMemberId === this.memberId) {
      return;
    }
    await this.#issueControl({ action: "close" });
  }

  /**
   * Changes the send policy for everyone. **Creator only**, and a
   * control action like a membership change: sequence-numbered, so a replay is inert
   * and a lost one detectable, and applied by every cooperating client from the
   * creator alone. `changes` is merged over the policy in force and the result made
   * consistent and clamped to *this* transport's bounds, so the creator never
   * broadcasts a policy it could not run itself; each receiver clamps to its own.
   * Applied locally once the send has succeeded, like every control action.
   */
  async setSyncPolicy(changes: Partial<SyncPolicy>): Promise<void> {
    await this.#issueControl(() => ({
      action: "policy",
      policy: effectiveSyncPolicy(this.#transport, {
        ...definedOnly(this.#policy?.values),
        ...definedOnly(changes),
      }),
    }));
  }

  /**
   * Rebroadcasts this client's complete current state as one delivery,
   * healing a peer whose sync() is permanently stalled on a dropped or
   * corrupted delivery from another sender — one lost update leaves every
   * later update of its sender pending. Unlike an incremental update, a
   * full-state update does not depend on any specific prior delivery
   * having arrived, so applying it heals the gap regardless of what was
   * missed — at the cost of resending the whole document every time.
   *
   * A caller can only heal a peer if it itself has the content that peer
   * is missing; a channel with no currently-online member holding that
   * content cannot self-heal by this or any other mechanism.
   *
   * Considered and rejected: `y-protocols/sync`'s state-vector step 1/2
   * functions, the standard Yjs mechanism for this — but they assume a
   * point-to-point exchange (request one specific peer's state vector,
   * get a targeted diff back), which does not fit `MessengerPort`'s
   * broadcast-only model (no addressing a specific member). A full
   * rebroadcast is simpler and correct here.
   */
  async resync(): Promise<void> {
    // The whole state as an edit of this client's own: refused where an edit would be (CTL-13).
    this.#assertMayEdit();
    // Every change dropped so far is in the state sent here, and counts as distributed once all
    // of it has gone out — every part, when it is cut into fragments (SND-8). One dropped
    // meanwhile, a part of this very message included, keeps the mark.
    const droppedSoFar = this.#scheduler.droppedCount;
    await this.#sendLarge(
      encodeEditFrame(this.documentId, this.#profile.encodeState(this.document)),
      {
        armsHeartbeat: true,
      },
    );
    this.#distributedThroughDrop = Math.max(this.#distributedThroughDrop, droppedSoFar);
  }

  /**
   * Broadcasts that this client needs to be caught up on this document
   * — complements `resync()`: `resync()` unconditionally
   * rebroadcasts THIS client's own state; `requestResync()` asks whoever
   * else is online and able to rebroadcast theirs, without this client
   * needing to know who that is. Closes the practical gap in
   * `resync()`'s own doc comment: today, healing a gapped peer requires a
   * human to notice and click "Resync" on some *other* member's pane —
   * this lets the gapped member ask directly, including a read-only
   * member (`MessengerPort.requestResync` accepts any current member
   * regardless of permission level).
   *
   * Carries this client's own current state vector as `requesterState`
   * — opaque to `MessengerPort` itself, read only by
   * `#respondToResyncRequests()` (SPECIFICATION.md
   * §8.3) to decide whether a responder actually has anything new to offer
   * and, if so, how much of a diff to send. When that state vector is
   * empty (`isEmptyStateVector` — this client has nothing at all, e.g.
   * `join()`'s own call), this is a *true bootstrap* request: it is marked
   * in `#bootstrapOverlaySelection` below so `sync()` knows to consider
   * adopting the answer's attribution overlay when it arrives
   * (SPECIFICATION.md §5.4) — never marked for a
   * request made with existing content, which has no such question to
   * answer (a partial gap-heal response never adopts an overlay). No
   * window or timer guards this: since only the creator answers a resync,
   * there is exactly one possible response, and `#considerBootstrapOverlay`
   * adopts it the moment it arrives.
   */
  async requestResync(): Promise<ResyncOutcome> {
    return this.#requestResync(false);
  }

  /**
   * The one place a resync request is made, whoever is asking. It takes
   * the single slot first, before anything is sent, so two callers in the same tick cannot
   * both send; a request made while one of ours is outstanding is coalesced into it, and one
   * made inside the rate floor is refused, and neither sends anything.
   */
  async #requestResync(automatic: boolean): Promise<ResyncOutcome> {
    const previousRequestAt = this.#resyncGate.lastRequestAt;
    const outcome = this.#resyncGate.begin({
      expiryMs: this.#resyncExpiryMs(),
      floorMs: this.#scheduler.effectiveMinIntervalMs,
      automatic,
      lastMessageAt: this.#scheduler.lastSendAt,
    });
    if (!outcome.sent) {
      return outcome;
    }
    let requestIdToForget: string | undefined;
    try {
      const stateVector = this.#profile.encodeStateVector(this.document);

      // An ordinary send(): a resync request is just another frame kind.
      // The request's own id, chosen here and recorded before it is sent, so an answer that
      // arrives on the next poll is recognised as ours (SPECIFICATION.md RSY-1).
      const requestId = newRandomId();
      requestIdToForget = requestId;
      this.#seenResyncRequestIds.add(requestId);
      this.#ownResyncRequestIds.add(requestId);
      if (this.#profile.isEmptyStateVector(stateVector)) {
        this.#bootstrapOverlaySelection.set(requestId, { hasAdopted: false });
      }
      const frame = encodeResyncRequestFrame({
        documentId: this.documentId,
        requestId,
        // Until the creator has answered, the answer itself is what this engine lacks — the
        // creator's confirmation of the profile and its control state — even when the content
        // has already arrived by ordinary edits (RSY-7, CTL-10). Likewise after a truncated
        // history (LOS-8): only an answer can say nothing was lost, and an engine that lacks
        // nothing would otherwise get none and keep suspecting a loss for ever.
        bootstrap: !this.#hasCompletedBootstrap || this.#historyTruncatedSince !== undefined,
        controlSequence: this.#contiguousControlSeq(),
        stateVector,
      });
      // Through the scheduler, on the floor like any message; nobody expects a follow-up to a
      // request, so it owes no heartbeat (SPECIFICATION.md SND-2, SND-11, LOS-3).
      const id = await this.#scheduler.submit(
        () => this.#messenger.send(this.documentId, this.memberId, frame),
        { armsHeartbeat: false },
      );
      this.#markOwnSend(id);
    } catch (error) {
      if (requestIdToForget !== undefined) {
        this.#ownResyncRequestIds.delete(requestIdToForget);
        this.#bootstrapOverlaySelection.delete(requestIdToForget);
      }
      this.#resyncGate.abort(previousRequestAt);
      throw error;
    }
    return outcome;
  }

  /**
   * How long an unanswered request holds the slot: it has to reach the creator, the creator
   * may have to wait for its own send slot, and the answer has to come back — one floor
   * between messages and two expected latencies, never less than a floor of ten seconds.
   */
  #resyncExpiryMs(): number {
    return Math.max(
      RESYNC_EXPIRY_FLOOR_MS,
      this.#scheduler.effectiveMinIntervalMs + 2 * this.#syncPolicy.expectedLatencyMs,
    );
  }

  /**
   * The client asking for help by itself, checked on every poll tick —
   * through the same single slot a person's click uses, so the two never run in parallel.
   *
   * - **Bootstrap retry.** A joiner that has heard nothing asks again, waiting one expiry, then
   *   two, then four, and gives up on its own after a few (a person can always ask).
   * - **Evidence that something is missing**, once it has lasted a conservative multiple of the
   *   wait it was first reported after: twice the expected latency for a gap or a heartbeat that
   *   shows we are behind, and, for a sender that merely went quiet — the softest evidence — its
   *   whole overdue time plus three latencies. At most a few requests per episode, spaced by a
   *   doubling wait, and none once the evidence has gone.
   */
  async #considerAutomaticResync(): Promise<void> {
    if (!this.#autoResync) {
      return;
    }
    const now = Date.now();
    const expiry = this.#resyncExpiryMs();
    // A truncated window is evidence like any other, and the most urgent: nothing else may
    // ever show what slid out unread (LOS-8).
    const suspicions = this.syncHealth.suspicions;
    if (suspicions.length === 0) {
      this.#automaticLossAttempts = 0;
    }
    if (!this.#resyncGate.isFree) {
      return;
    }

    if (!this.#hasCompletedBootstrap) {
      if (this.#automaticBootstrapAttempts >= MAX_AUTOMATIC_BOOTSTRAP_ATTEMPTS) {
        return;
      }
      const reference = Math.max(
        this.#resyncGate.lastRequestAt ?? 0,
        this.#lastAutomaticAttemptAt ?? 0,
      );
      const wait = Math.min(RESYNC_BACKOFF_CAP_MS, expiry * 2 ** this.#automaticBootstrapAttempts);
      if (reference === 0 || now - reference >= wait) {
        this.#automaticBootstrapAttempts += 1;
        this.#lastAutomaticAttemptAt = now;
        await this.#requestResync(true);
      }
      return;
    }

    if (suspicions.length === 0 || this.#automaticLossAttempts >= MAX_AUTOMATIC_LOSS_ATTEMPTS) {
      return;
    }
    const policy = this.#syncPolicy;
    const grace = lossGraceMs(policy);
    const due = suspicions.some((suspicion) => {
      const after =
        suspicion.kind === "history-truncated"
          ? 0
          : suspicion.kind === "sender-overdue"
            ? policy.maxIntervalMs + 3 * grace
            : 2 * grace;
      return now - suspicion.since >= after;
    });
    const spacing = Math.min(RESYNC_BACKOFF_CAP_MS, expiry * 2 ** this.#automaticLossAttempts);
    const spaced =
      this.#lastAutomaticAttemptAt === null || now - this.#lastAutomaticAttemptAt >= spacing;
    if (due && spaced) {
      this.#automaticLossAttempts += 1;
      this.#lastAutomaticAttemptAt = now;
      await this.#requestResync(true);
    }
  }

  /**
   * Immediately sends any local edits currently waiting to go out, without
   * waiting for the quiet time, the floor between messages, or a retry's
   * back-off. A no-op if nothing is queued — including whenever `batchWindowMs` is
   * 0 (the default), since nothing is ever queued in that case. Rejects with the
   * send's error if it fails; a failure worth retrying leaves the change queued for
   * the scheduler's own retry, a permanent one drops it. Called
   * automatically by `dispose()`, so a pending batch is never silently dropped when
   * a client is torn down.
   */
  async flush(): Promise<void> {
    await this.#scheduler.flush();
  }

  /**
   * Stops broadcasting local edits. Does not affect other clients on the channel.
   * Sends what is pending one last time; there is no retry after this, so a failure
   * is reported through `onError` and the change is lost.
   */
  dispose(): void {
    this.#unobserve();
    this.#unobserveAttribution();
    this.#scheduler
      .flush({ final: true })
      .catch((error: unknown) => this.#onError(error, "broadcast"));
  }

  /** Reports a received decline to the application, once per sender (SPECIFICATION.md DCL-3). */
  #reportDecline(sender: MemberId, frame: DeclineFrame): void {
    if (this.#declinesReported.has(sender)) {
      return;
    }
    this.#declinesReported.add(sender);
    this.#onDecline?.({
      sender,
      reason: frame.reason,
      ...(frame.profiles === undefined ? {} : { profiles: frame.profiles }),
      ...(frame.text === undefined ? {} : { text: frame.text }),
    });
  }

  /** Rejects a frame for another document, loudly (SPECIFICATION.md FRM-8). */
  #checkFrameBelongsHere(frame: Frame): void {
    if (frame.documentId !== this.documentId) {
      throw new FrameDecodeError(
        "document-mismatch",
        `delivery routed to the wrong document: expected "${this.documentId}", frame says "${frame.documentId}"`,
      );
    }
  }

  /**
   * Whether this client may send an edit of its own now (SPECIFICATION.md CTL-13): the
   * document is open, and it is the creator, or it has been bootstrapped by the creator and its
   * permission is not `read`. What an application shows as an editable document.
   */
  get mayEdit(): boolean {
    if (this.#closed) {
      return false;
    }
    if (this.#creatorMemberId === this.memberId) {
      return true;
    }
    return this.#hasCompletedBootstrap && this.#members.get(this.memberId) !== "read";
  }

  /**
   * Refuses an edit of this client's own when it must not send one (CTL-13): the document is
   * closed, its permission is `read`, or — for anyone but the creator — the creator has not
   * yet bootstrapped it. An *unknown* permission after bootstrap never refuses.
   */
  #assertMayEdit(): void {
    this.#assertMaySend();
    if (this.#creatorMemberId !== this.memberId && !this.#hasCompletedBootstrap) {
      throw new SendRefusedError(
        "awaiting-bootstrap",
        `${this.memberId} has not received ${this.documentId} from its creator yet`,
      );
    }
  }

  /** Refuses, permanently, when this client already knows it must not send. Never refuses on an *unknown* permission. */
  #assertMaySend(): void {
    if (this.#closed) {
      throw new SendRefusedError("closed", `document is closed, no new writes: ${this.documentId}`);
    }
    if (this.#creatorMemberId !== this.memberId && this.#members.get(this.memberId) === "read") {
      throw new SendRefusedError(
        "read-only",
        `${this.memberId} has read-only access to ${this.documentId}`,
      );
    }
  }

  /**
   * Sends a frame that is already complete — a fragment, or a whole frame no larger than a
   * message. Deliberately not checked against permission or a closed document: whether an
   * *edit* may be sent is decided where it is cut (`fragment`), and a resync answer must go
   * out from a closed document, which still bootstraps a joiner.
   */
  async #sendFrame(frame: string): Promise<void> {
    const id = await this.#messenger.send(this.documentId, this.memberId, frame);
    this.#markOwnSend(id);
  }

  /** `frame` cut into fragment frames a message can carry. Only ever called when the transport states a limit. */
  #fragmentsOf(frame: string): string[] {
    return fragmentFrame(frame, {
      documentId: this.documentId,
      maxBytes: this.#maxBytes as number,
    });
  }

  /**
   * Sends a frame that may be larger than one message — a resync answer, or `resync()`'s own
   * full state. Whole, it is submitted to the scheduler and goes out once the floor permits,
   * ahead of any edit (SPECIFICATION.md SND-2, RSY-11); too large, it is cut and its
   * fragments go out at the permitted rate, in order, and are retried like any send.
   * `armsHeartbeat`: an edit frame owes a heartbeat after it, an answer does not (SND-11).
   * Resolves once sent or queued.
   */
  /** A `too-large` refusal of a message the transport's own `maxBytes` allowed is the profile's fault (SND-8). */
  #blameProfileFor(error: unknown): unknown {
    if (
      !(error instanceof TransportSendError) ||
      error.reason !== "too-large" ||
      this.#maxBytes === undefined
    ) {
      return error;
    }
    return new TransportProfileError(
      `the transport refused a message as too large within the ${this.#maxBytes} bytes its profile declared: the transport profile or its binding is wrong`,
      { cause: error },
    );
  }

  async #sendLarge(frame: string, options: { armsHeartbeat: boolean }): Promise<void> {
    if (this.#maxBytes === undefined || frameByteLength(frame) <= this.#maxBytes) {
      await this.#scheduler.submit(() => this.#sendFrame(frame), options);
      return;
    }
    // Waits for every part, so a caller learns, as for one message, whether it all went out.
    await this.#scheduler.enqueueFrames(this.#fragmentsOf(frame));
  }

  async #broadcast(update: Uint8Array): Promise<void> {
    this.#assertMayEdit();
    const frame = encodeEditFrame(this.documentId, update);
    const id = await this.#messenger.send(this.documentId, this.memberId, frame);
    this.#markOwnSend(id);
  }

  /**
   * The one heartbeat: this client's state vector and, if it is the
   * creator, its latest control sequence, which is what makes even the creator's most recent
   * control message checkable. Still sent after a close: the close's own loss, and the loss
   * of an edit sent just before it, only a heartbeat can reveal.
   */
  async #broadcastHeartbeat(): Promise<void> {
    const frame = encodeHeartbeatFrame({
      documentId: this.documentId,
      controlSequence: this.#creatorMemberId === this.memberId ? this.#issuedControlSeq : 0,
      stateVector: this.#profile.encodeStateVector(this.document),
    });
    const id = await this.#messenger.send(this.documentId, this.memberId, frame);
    this.#markOwnSend(id);
  }

  async #broadcastResyncResponse(
    respondsTo: ResyncRequestId,
    update: Uint8Array,
    attribution: object,
  ): Promise<void> {
    const frame = encodeResyncResponseFrame({
      documentId: this.documentId,
      respondsTo,
      update,
      attribution,
      // Only the creator can issue control state; nobody else's snapshot would be accepted.
      control: this.#creatorMemberId === this.memberId ? this.controlState : null,
    });
    // A full-state answer scales with the document, not the send window, so it is the
    // frame most likely to exceed a transport's message size (analysis section 6.4).
    await this.#sendLarge(frame, { armsHeartbeat: false });
  }

  /**
   * Whether a resync response from `sender` counts. Only the
   * creator answers a resync request, so a response counts if it comes from the
   * creator. The one exception is the creator itself: a creator that restarted has
   * lost its content, only a peer can restore it, and so it accepts a response
   * from anyone — but only one that answers a request *it* made, so an unsolicited
   * "response" cannot be used to push content at it.
   */
  #mayAcceptResyncResponse(sender: MemberId, respondsTo: ResyncRequestId): boolean {
    if (this.#creatorMemberId === undefined) {
      return false;
    }
    if (sender === this.#creatorMemberId) {
      return true;
    }
    return this.#creatorMemberId === this.memberId && this.#ownResyncRequestIds.has(respondsTo);
  }

  /**
   * Checked on every `sync()` poll tick. **Only the creator answers a resync
   * request** (SPECIFICATION.md RSY-6): letting every online peer answer costs one full
   * snapshot per online member at tens of seconds of latency, and suppressing the
   * others until the creator's answer arrives only works on a fast network. The single
   * exception: a peer answers a request
   * made by the creator, because a creator that restarted has lost its content and
   * nobody else can restore it. What a peer sends the creator is content only — it
   * never carries a control snapshot, which only the creator can issue.
   *
   * Per request, per tick: skip this client's own request; skip one already
   * resolved; skip (and resolve) one this client is not entitled to answer; leave
   * one this client has nothing to offer for pending, in case that changes later
   * (content the requester lacks, or — for the creator — control state it is behind
   * on); respect this client's own `resyncResponseThrottleMs` across whichever
   * different requests it does answer.
   *
   * The response itself is a targeted diff, not always a full snapshot —
   * `encodeUpdateSince` against an empty state vector (a brand-new joiner) happens
   * to *be* a full snapshot (verified: byte-identical), so no special-casing is
   * needed for that case.
   *
   * A send failure here (disconnected, a size or rate limit — anything) is
   * deliberately **not** routed to `onError`, unlike the manual `resync()` button:
   * this automatic, background response is best-effort, and surfacing its failure
   * would paint a confusing, self-inflicted-looking warning on a pane whose member
   * did nothing to cause it. It is not forgotten either: a failure worth retrying puts the
   * request back to be answered later (RSY-9).
   */
  async #respondToResyncRequests(requests: readonly PendingResyncRequest[]): Promise<void> {
    const now = Date.now();
    const isCreator =
      this.#creatorMemberId !== undefined && this.memberId === this.#creatorMemberId;

    for (const request of requests) {
      if (request.requester === this.memberId) {
        this.#seenResyncRequestIds.add(request.id);
        this.#pendingResyncRequests.delete(request.requester);
        continue;
      }
      if (this.#seenResyncRequestIds.has(request.id)) {
        this.#pendingResyncRequests.delete(request.requester);
        continue;
      }
      const requesterIsCreator =
        this.#creatorMemberId !== undefined && request.requester === this.#creatorMemberId;
      if (!isCreator && !requesterIsCreator) {
        this.#seenResyncRequestIds.add(request.id); // not ours to answer: only the creator answers
        this.#pendingResyncRequests.delete(request.requester);
        continue;
      }
      const requested = {
        controlSequence: request.controlSequence,
        stateVector: request.stateVector,
      };
      // Something to offer is either content the requester lacks, or — for the
      // creator only — control state it is behind on: a lost
      // membership change leaves the content diff empty and still needs healing.
      const hasContent = this.#profile.hasUpdatesSince(this.document, requested.stateVector);
      const hasControl = isCreator && this.#issuedControlSeq > requested.controlSequence;
      if (!hasContent && !hasControl && !(isCreator && request.bootstrap)) {
        continue; // nothing to offer yet — may change by a later tick
      }
      if (
        this.#lastResyncResponseAt !== null &&
        now - this.#lastResyncResponseAt < this.#resyncResponseThrottleMs
      ) {
        continue; // still reconsidered on a later tick
      }

      this.#seenResyncRequestIds.add(request.id);
      this.#pendingResyncRequests.delete(request.requester);
      this.#lastResyncResponseAt = now;
      try {
        const update = this.#profile.encodeStateSince(this.document, requested.stateVector);
        // Always this responder's own current attribution state, sent
        // unconditionally — whether to adopt it wholesale (true bootstrap)
        // or ignore it entirely (partial gap-heal) is the *requester's*
        // decision to make on receipt, not this responder's to pre-judge
        // (SPECIFICATION.md §5.4).
        const attributionOverlay = this.attribution.toJSON();
        // Not awaited: the answer waits for the floor in the scheduler (RSY-11), and a poll
        // must not wait with it. Best-effort, like the rest of this method.
        this.#broadcastResyncResponse(request.id, update, attributionOverlay).catch(
          (error: unknown) => this.#keepRequestAfterFailedAnswer(request, error),
        );
      } catch {
        // best-effort — see this method's own doc comment.
      }
    }
  }

  /**
   * An answer that did not go out leaves its request unanswered (SPECIFICATION.md RSY-9):
   * after a failure worth retrying — a rate limit, the messenger unreachable — the request goes
   * back to be reconsidered, under the time it was first heard, so the queue's age and size
   * bounds still end it; after a permanent one it is let go, since answering again cannot
   * succeed. A newer request from the same requester, heard meanwhile, supersedes it.
   */
  #keepRequestAfterFailedAnswer(request: PendingResyncRequest, error: unknown): void {
    if (
      !classifySendFailure(error).retryable ||
      this.#pendingResyncRequests.has(request.requester)
    ) {
      return;
    }
    this.#seenResyncRequestIds.delete(request.id);
    this.#pendingResyncRequests.set(request.requester, request);
  }

  /**
   * Considers adopting `attributionOverlay` for a true-bootstrap resync
   * request this client itself made (SPECIFICATION.md
   * §5.4, RSY-15). **The first overlay adopted stands**: a joiner
   * only accepts the creator's response, and a creator that restarted has one
   * requester and nothing to choose between. The response's document content is applied
   * normally by the caller regardless; only attribution adoption is skipped once
   * an overlay has been adopted.
   *
   * "Adopting" is not always a wholesale `attribution.restore()`: it only
   * takes that shortcut when `snapshot` accounts for this client's
   * *entire* current document (checked by comparing total lengths) — the
   * common case, since a true-bootstrap joiner usually has nothing else
   * yet. When this client already has content `snapshot` knows nothing
   * about (its own local edit made before this response arrived, or an
   * earlier-adopted overlay whose length has since diverged),
   * `AttributionTracker.reattributeMatching` is used instead, scoped to
   * `authorId === UNATTRIBUTED_AUTHOR_ID` — the sentinel `sync()` sets on
   * every resync-response's content by default, before this method ever
   * runs, and nowhere else — so it can only ever touch content this exact
   * mechanism introduced, never a range this client typed itself or
   * received via a normal delivery. Skipping *all* adoption once this
   * client has made any local edit would protect that edit, but would also
   * leave every bootstrap content that arrives afterward unattributed for
   * good — including content unrelated to the local edit, as happens when
   * two authors type within moments of each other, one of them
   * mid-bootstrap.
   */
  #considerBootstrapOverlay(
    selection: BootstrapOverlaySelection,
    attributionOverlay: AttributionOverlay | null,
  ): void {
    if (selection.hasAdopted) {
      return;
    }
    // No overlay offered: the content stays attributed to the unattributed sentinel `sync()`
    // set before calling this. A malformed overlay never gets here — the decoder rejected the
    // whole response (FRM-6).
    if (attributionOverlay === null) {
      return;
    }
    const snapshot: AttributionSnapshot = attributionOverlay;
    const overlayLength = snapshot.ranges.reduce(
      (sum, range) => sum + (range.end - range.start),
      0,
    );
    const currentLength = this.attribution.ranges.reduce(
      (sum, range) => sum + (range.end - range.start),
      0,
    );
    if (overlayLength === currentLength) {
      this.attribution.restore(snapshot);
    } else {
      this.attribution.reattributeMatching(
        (authorId) => authorId === UNATTRIBUTED_AUTHOR_ID,
        snapshot,
      );
    }
    selection.hasAdopted = true;
  }

  /**
   * The creator's issue path. Serialised, so two concurrent calls cannot take the
   * same number; the number is taken only after the send succeeded, so a failed
   * send never leaves a gap.
   */
  #issueControl(
    fields: ControlFields | (() => ControlFields),
    validate?: () => void,
  ): Promise<void> {
    const run = async (): Promise<void> => {
      if (this.#creatorMemberId !== this.memberId) {
        throw new Error(`${this.memberId} is not the creator of ${this.documentId}`);
      }
      // A frame left pending by a restart goes first, and alone: its number may already
      // have been delivered, so no other action may take it (CTL-12). If it still cannot
      // be sent, nothing new is issued either.
      if (this.#pendingControl !== undefined) {
        await this.#sendControl(this.#pendingControl);
      }
      validate?.();
      if (this.#closed) {
        throw new SendRefusedError("closed", `document is closed: ${this.documentId}`);
      }
      const frameText = encodeControlFrame({
        documentId: this.documentId,
        sequence: this.#issuedControlSeq + 1,
        ...(typeof fields === "function" ? fields() : fields),
      });
      await this.#sendControl(frameText);
    };
    const next = this.#controlChain.then(run, run);
    this.#controlChain = next.catch(() => {});
    return next;
  }

  /**
   * Sends one control frame of the creator's through the outbox (CTL-12): persisted as
   * pending before the send, applied and cleared once the messenger accepted it, cleared
   * without being applied if the messenger refused it for good — then its number was not
   * used. A crash in between leaves it pending, and the restarted engine sends the very
   * same text again.
   */
  async #sendControl(frameText: string): Promise<void> {
    const frame = decodeFrame(frameText);
    if (frame.kind !== "control" || frame.sequence !== this.#issuedControlSeq + 1) {
      throw new Error(
        `internal error: the pending control frame is not the next one (${this.#issuedControlSeq + 1})`,
      );
    }
    // A number this engine has already seen a different frame under — its own, sent before a
    // restart that lost the persisted state — is not reused (CTL-17): refused before sending.
    const known = this.#controlFrameTexts.get(frame.sequence);
    if (known !== undefined && known !== frameText) {
      throw new ControlFrameRejectedError(
        "sequence-conflict",
        `control sequence ${frame.sequence} was already sent with another frame; this creator's persisted control state is older than what it sent`,
      );
    }
    // Persisted before the messenger sees it (CTL-12). If the application cannot persist it,
    // nothing is sent and the number stays free — a frame restored as pending stays pending.
    const pendingBefore = this.#pendingControl;
    this.#pendingControl = frameText;
    try {
      this.#notifyControlStateChange();
    } catch (error) {
      this.#pendingControl = pendingBefore;
      throw error;
    }
    let id: DeliveryId;
    try {
      // Through the scheduler, on the floor like any message (SPECIFICATION.md SND-2);
      // receivers expect a follow-up to a control message, so the heartbeat is owed after it.
      id = await this.#scheduler.submit(
        () => this.#messenger.send(this.documentId, this.memberId, frameText),
        { armsHeartbeat: true },
      );
    } catch (error) {
      // Refused for good (a retryable failure is retried inside the scheduler): the
      // messenger took nothing, so the number is still free.
      this.#pendingControl = undefined;
      this.#notifyControlStateChange();
      throw error;
    }
    this.#markOwnSend(id);
    this.#issuedControlSeq = frame.sequence;
    this.#pendingControl = undefined;
    this.#applyControlFrame(frame, this.memberId, frameText);
    this.#notifyControlStateChange();
  }

  /**
   * Applies one control frame if, and only if, its sender is the creator and its
   * sequence is newer than the last applied for the same target. A stale frame
   * (a replay, or one already superseded) is inert and silent. Throws
   * `ControlFrameRejectedError` for a frame that must not count at all.
   */
  #applyControlFrame(frame: ControlFrame, sender: MemberId, text: string): void {
    if (this.#creatorMemberId === undefined) {
      throw new ControlFrameRejectedError(
        "creator-unknown",
        "control frame ignored: this client does not know the document's creator",
      );
    }
    if (sender !== this.#creatorMemberId) {
      throw new ControlFrameRejectedError(
        "not-from-creator",
        `control frame from ${sender} ignored: only the creator (${this.#creatorMemberId}) may send them`,
      );
    }
    if (frame.action === "membership" && frame.member === this.#creatorMemberId) {
      throw new ControlFrameRejectedError(
        "names-the-creator",
        "control frame ignored: the creator's own permission is fixed and cannot be changed",
      );
    }
    // A resent frame is byte for byte the frame first sent (CTL-12); a different frame under
    // a number already seen means the creator's application reused it (CTL-17).
    const known = this.#controlFrameTexts.get(frame.sequence);
    if (known !== undefined && known !== text) {
      throw new ControlFrameRejectedError(
        "sequence-conflict",
        `control frame ignored: sequence ${frame.sequence} already carried a different frame`,
      );
    }
    this.#controlFrameTexts.set(frame.sequence, text);

    // Recorded even when stale — a stale frame still proves the number arrived.
    if (frame.sequence > this.#controlFloor) {
      this.#controlReceivedSeqs.add(frame.sequence);
    }
    this.#highestControlSeq = Math.max(this.#highestControlSeq, frame.sequence);

    if (frame.action === "policy") {
      // Newest wins, ordered by the creator's sequence like everything else here —
      // against the floor a snapshot set and against whatever policy this client
      // already runs, an invitation's included. Not tracked in `#controlAppliedSeq`:
      // that map is for membership and close, and an invitation's sequence must not
      // make a snapshot look stale.
      if (
        frame.policy !== undefined &&
        frame.sequence > Math.max(this.#controlFloor, this.#policy?.sequence ?? -1)
      ) {
        this.#adoptPolicy(frame.policy, frame.sequence);
      }
      return;
    }

    const target = frame.action === "close" ? "close" : `member:${frame.member}`;
    const last = Math.max(this.#controlFloor, this.#controlAppliedSeq.get(target) ?? 0);
    if (frame.sequence <= last) {
      return;
    }
    this.#controlAppliedSeq.set(target, frame.sequence);
    if (frame.action === "close") {
      this.#closed = true;
      return;
    }
    if (frame.member === undefined || frame.permission === undefined) {
      return;
    }
    if (frame.permission === null) {
      this.#members.delete(frame.member);
    } else {
      this.#members.set(frame.member, frame.permission);
    }
  }

  /** Runs the policy the creator set from now on, in the scheduler and in `syncPolicy`. */
  #adoptPolicy(values: Partial<SyncPolicy>, sequence: number): void {
    this.#policy = { values, sequence };
    this.#syncPolicy = effectiveSyncPolicy(this.#transport, values);
    this.#scheduler.setPolicy(this.#syncPolicy);
  }

  /**
   * The highest control sequence applied with nothing missing below it: the
   * floor (a snapshot's sequence) plus every consecutive number received after
   * it. What a resync request reports as this client's progress, so that a gap
   * makes the creator answer and a client with none does not.
   */
  #contiguousControlSeq(): number {
    let n = this.#controlFloor;
    while (this.#controlReceivedSeqs.has(n + 1)) {
      n++;
    }
    return n;
  }

  #notifyControlStateChange(): void {
    this.#onControlStateChange?.(
      this.#pendingControl === undefined
        ? this.controlState
        : { ...this.controlState, pendingControl: this.#pendingControl },
    );
  }

  /**
   * Adopts the creator's control snapshot, already checked in full by the decoder: replaces the
   * membership map, never reopens a closed document, and raises the floor below which any
   * control frame is stale. Ignored if it is older than what this client has already applied.
   */
  #applyControlSnapshot(snapshot: DecodedSnapshot): void {
    const highestApplied = Math.max(this.#controlFloor, ...this.#controlAppliedSeq.values());
    if (snapshot.sequence < highestApplied) {
      return;
    }
    this.#members = new Map(Object.entries(snapshot.members));
    this.#closed = this.#closed || snapshot.closed;
    this.#controlFloor = snapshot.sequence;
    this.#controlAppliedSeq.clear();
    for (const seq of [...this.#controlReceivedSeqs]) {
      if (seq <= snapshot.sequence) {
        this.#controlReceivedSeqs.delete(seq);
      }
    }
    this.#highestControlSeq = Math.max(this.#highestControlSeq, snapshot.sequence);
    // The policy rides in the snapshot as its own fact with its own sequence, adopted only if
    // newer than the one already run: a stale link's policy yields to it, and a snapshot older
    // than what this client knows changes nothing.
    if (
      snapshot.policy !== undefined &&
      snapshot.policySequence !== undefined &&
      snapshot.policySequence > (this.#policy?.sequence ?? -1)
    ) {
      this.#adoptPolicy(snapshot.policy, snapshot.policySequence);
    }
    this.#notifyControlStateChange();
  }
}

type ControlFields =
  | { action: "close" }
  | { action: "membership"; member: MemberId; permission: ControlPermission }
  | { action: "policy"; policy: SyncPolicy };

export { isProfileId } from "./framing";
export {
  encodeInvitation,
  INVITATION_VERSION,
  type Invitation,
  type InvitationProblem,
  MAX_INVITATION_RECIPIENTS,
  type ParsedInvitation,
  parseInvitation,
} from "./invitation";
export {
  type DocumentProfile,
  SUPPORTED_PROFILES,
  UnsupportedProfileError,
  YJS_PARAGRAPHS_1,
} from "./profile";
