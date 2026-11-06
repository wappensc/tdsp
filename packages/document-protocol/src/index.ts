import {
  type Delivery,
  type DeliveryId,
  type DocumentId,
  jsonTextTooDeep,
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
  changedRoots,
  getFragment,
  observeUpdates,
  type ReconciledDocument,
  type ReconciledFragment,
  transact,
  UnsplittableUpdateError,
} from "@tdsp/reconciliation";
import { type AnswerTurn, answerAction, answerTurn, answerWindowMs } from "./answer-turn";
import { type Clock, compareClocks, isClock, raiseClock, ZERO_CLOCK } from "./clock";
import {
  type ChannelInconsistencies,
  CLOSE_REASON,
  ControlState,
  type ControlTarget,
  type ControlValue,
  channelInconsistencies,
  DEVICE_TAG,
  isNamedCloseReason,
  MAX_ISSUE_BYTES,
  memberOf,
  newDeviceTag,
  type Register,
  type RegisterState,
  registerStateFrom,
  rightIn,
} from "./control-state";
import { digestOf } from "./digest";
import {
  type AttributionOverlay,
  bytesToBase64,
  type ControlFrame,
  CURRENT_FRAME_VERSION,
  type DeclineFrame,
  type DeclineReason,
  type DecodedSnapshot,
  decodeFrame,
  type ExtensionCheck,
  encodeControlFrame,
  encodeDeclineFrame,
  encodeEditFrame,
  encodeHeartbeatFrame,
  encodeResyncRequestFrame,
  encodeResyncResponseFrame,
  type Frame,
  FrameDecodeError,
  frameByteLength,
  isExtensionName,
  isLayerId,
  MAX_CRIT,
  newRandomId,
  type OutgoingExtensions,
  type ResyncRequestFrame,
  type ResyncResponseFrame,
} from "./framing";
import {
  furtherStated,
  type GapKey,
  type IncompleteAnswer,
  LossDetector,
  type StatedFurthest,
  type StateReport,
  type SyncSuspicion,
} from "./loss-detector";
import { OwnRequests } from "./own-requests";
import {
  checkProfileReads,
  clientsAheadOf,
  type DocumentProfile,
  deletionsOf,
  deletionsWithinOf,
  profileFor,
  projectionOf,
  readerOf,
  splitterOf,
  updateClocksOf,
  YJS_PARAGRAPHS_1,
} from "./profile";
import { compareRegisters, controlClockOf, decideRegister, registerStateDigest } from "./registers";
import { ResyncGate, type ResyncOutcome, type ResyncStatus } from "./resync-gate";
import {
  type ReportCarry,
  type SendFailureClass,
  SendScheduler,
  type SendStatus,
} from "./send-scheduler";
import { SteadyClock } from "./steady-clock";
import { strictJsonProblem } from "./strict-json";
import { effectiveSyncPolicy, resolveSyncPolicy, type SyncPolicy } from "./sync-policy";

export type { Clock } from "./clock";
export type {
  ChannelInconsistencies,
  ControlTarget,
  ControlValue,
  Register,
  RegisterState,
} from "./control-state";
export {
  CLOSE_REASON_CODES,
  isCloseReason,
  isNamedCloseReason,
  MAX_CLOSE_REASON_BYTES,
} from "./control-state";
export {
  DEFAULT_LOSS_GRACE_MS,
  type GapKey,
  type IncompleteAnswer,
  MAX_GAP_TRIES,
  type SyncSuspicion,
  type SyncSuspicionKind,
  WAKE_SPACING_MS,
} from "./loss-detector";
export type { ResyncOutcome, ResyncRefusal, ResyncStatus } from "./resync-gate";
export { REPORT_AFTER_MS, type SendStatus } from "./send-scheduler";
export {
  clampSyncPolicy,
  DEFAULT_SYNC_POLICY,
  effectiveSyncPolicy,
  resolveSyncPolicy,
  type SyncPolicy,
  type SyncPolicyJson,
  syncPolicyFromJson,
  syncPolicyToJson,
} from "./sync-policy";

export type { DocumentId };

/** How long an own send's echo may lag behind before its id is forgotten anyway. */
const OWN_ECHO_WAIT_MS = 3_600_000;

/** How many delivery ids an engine reading with a cursor remembers (TRN-18). */
const MAX_REMEMBERED_DELIVERIES = 10_000;

/**
 * How many resync request ids of others an engine remembers, so a copy is not answered twice; and
 * as many it heard an answer to, so a member waiting for its turn falls silent (RSY-20).
 */
const MAX_REMEMBERED_REQUESTS = 1024;

/**
 * How many answers to one request a member keeps the stated state of, the first heard, to judge at its
 * turn whether one holds what it would give (RSY-20): a request to all usually costs one answer, two
 * when turns lie close together.
 */
const MAX_ANSWERS_KEPT_PER_REQUEST = 4;

/** How many requests still to be answered a responder keeps in all, the oldest dropped first (RSY-19). */
const MAX_PENDING_REQUESTS = 64;

/** How many of them one requester may have: several devices of one member may ask at once (RSY-19). */
const MAX_REQUESTS_PER_REQUESTER = 4;

/**
 * How long a request still to be answered is kept, from when it was heard or, for one this engine
 * answers only at its turn, from its turn (RSY-20); its requester asks again long before (RSY-4,
 * RSY-5).
 */
const PENDING_REQUEST_TTL_MS = 5 * 60_000;

/** The most bytes held for missing predecessors before they are given up and asked for again (LOS-23). */
const MAX_PENDING_BYTES = 32 * 1024 * 1024;

/** The longest pace this engine runs; a longer one runs as this (SND-15). */
const MAX_PACE_MS = 600_000;

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
 * (SPECIFICATION.md CTL-13): the document is closed, this member's permission is `read`, revoked or
 * unknown — no register names it —, or —
 * for anyone but the creator — no answer has bootstrapped it yet. **Permanent** — a retry cannot
 * succeed, unlike a rate limit or a disconnection; an unknown permission ends only by a decision of
 * the creator that reaches this client.
 */
export class SendRefusedError extends Error {
  /**
   * `awaiting-bootstrap`: a participant other than the creator has not yet received an answer to
   * its join that carries control state — it has neither the document's content nor its control
   * state, so an edit of its own would compete with content it cannot see (SPECIFICATION.md CTL-13).
   * `revoked`: the creator revoked this member's permission; refused as `read` is, on the
   * document and on every layer (CTL-13, LAY-5). `unknown-permission`: bootstrapped, but no register
   * this client holds names this member, so it counts as `read` on the document and on every layer
   * it holds no right on (CTL-13, LAY-5); unlike `revoked`, a decision the creator has not made yet.
   * `capacity-conflict`: this client could not hold registers of the creator within its bounds of
   * control state and may lack a decision about
   * itself (CTL-32); refused as `read` is, for everyone, the creator's devices included.
   * `clock-exhausted`: a decision on a target whose register's clock is at the end of its range, above
   * which no clock can order it (CTL-45); the person continues in a new document (§6.2).
   * `not-closed`: a reason for the close set while the document is not closed; it is written with the
   * close, or on a document already closed, never before (CTL-23).
   * `unreadable`: a change of its own that the document's profile does not read as one update —
   * for `yjs-paragraphs/1`, JSON content or an `Any` value nested more than 32 levels — which every
   * receiver would refuse (SND-26). It stays in this replica, whose answers carry it: the
   * application undoes it. `not-bootstrapped`: a decision of a device of the creator that is not
   * bootstrapped: until another device of the creator's answer, a restored or a carried state brings
   * it the creator's state, it decides nothing but the close and its reason (CTL-27); it may edit
   * content (CTL-13).
   */
  readonly reason:
    | "closed"
    | "read-only"
    | "revoked"
    | "unknown-permission"
    | "capacity-conflict"
    | "awaiting-bootstrap"
    | "too-large"
    | "clock-exhausted"
    | "unreadable"
    | "not-bootstrapped"
    | "not-closed";

  constructor(reason: SendRefusedError["reason"], message: string) {
    super(message);
    this.name = "SendRefusedError";
    this.reason = reason;
  }
}

/**
 * Reported when the transport refuses a message as too large although it is within the
 * `maxBytes` the transport's own profile declared (SPECIFICATION.md SND-22): the change is
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
 * The frame every transport carries at the least: 4 MiB (SPECIFICATION.md TRN-23). An answer
 * carries its responder's control state whole (SND-18), and at this size the most a receiver holds
 * (CTL-30, 3 MiB) fits one answer with room for the rest of it (§7.4).
 */
export const MIN_MESSAGE_BYTES = 4_194_304;

/**
 * The creation or join of a document refused because the transport's profile states a
 * `bounds.maxBytes` below `MIN_MESSAGE_BYTES` (SPECIFICATION.md TRN-23): on such a transport two
 * devices of the creator may merge a control state no answer carries, and then nobody new could be
 * bootstrapped. Refused at once, before anything is sent, rather than once the control state has
 * grown. `maxBytes` is the bound the profile states.
 */
export class TransportTooSmallError extends Error {
  readonly maxBytes: number;

  constructor(documentId: DocumentId, maxBytes: number) {
    super(
      `cannot use ${documentId} on a transport that carries at most ${maxBytes} bytes a frame: ` +
        `every transport carries at least ${MIN_MESSAGE_BYTES} (SPECIFICATION.md TRN-23)`,
    );
    this.name = "TransportTooSmallError";
    this.maxBytes = maxBytes;
  }
}

/** Refuses a transport whose profile states less than every transport carries (TRN-23); without a bound, none. */
function assertLargeEnough(documentId: DocumentId, transport: TransportProfile | undefined): void {
  const maxBytes = transport?.bounds.maxBytes;
  if (maxBytes !== undefined && maxBytes !== null && maxBytes < MIN_MESSAGE_BYTES) {
    throw new TransportTooSmallError(documentId, maxBytes);
  }
}

/**
 * Whether a right refuses this client's own edits once it is bootstrapped (CTL-13): `read`, a
 * revoked permission, and an unknown one, which counts as `read` — a member the creator has not
 * named yet waits for that word as a reader (LIF-9).
 */
function refuses(right: Permission | "revoked" | "unknown"): boolean {
  return right === "read" || right === "revoked" || right === "unknown";
}

/** The refusal of an edit by a member no register names (CTL-13): on the document, or on `layer`. */
function unknownPermission(member: MemberId, documentId: string, layer?: string): SendRefusedError {
  return new SendRefusedError(
    "unknown-permission",
    layer === undefined
      ? `${member} has no permission on ${documentId} yet: until the creator names it, it may only read`
      : `${member} has no permission on the layer ${layer} of ${documentId} yet: until the creator names it, it may only read`,
  );
}

/** The smallest piece worth sending: below it a transport's limit leaves no room for content. */
const MIN_PIECE_BYTES = 16;

/**
 * The transport's `bounds.maxBytes` leaves no useful room for a piece beside a frame's other fields
 * (SND-19), or for an answer's control snapshot even alone (SND-18): the change, or the answer, is
 * dropped and reported (SND-8), permanently.
 */
export class PieceTooSmallError extends Error {
  /**
   * `bytes`: for a `"piece"`, what the frame's fields other than its update take; for the
   * `"snapshot"`, the whole `resync-response` frame that carries it with an update that holds nothing.
   */
  constructor(maxBytes: number, bytes: number, room: "piece" | "snapshot" = "piece") {
    super(
      room === "snapshot"
        ? `the control snapshot does not fit even alone (SND-18): the resync-response frame that carries it with an update that holds nothing takes ${bytes} bytes, over the transport's bounds.maxBytes of ${maxBytes}`
        : `not even one piece of the update fits beside the frame's other fields (SND-19): they take ${bytes} of the transport's bounds.maxBytes of ${maxBytes} bytes, which leaves room for less than ${MIN_PIECE_BYTES} bytes of update`,
    );
    this.name = "PieceTooSmallError";
  }
}

export { UnsplittableUpdateError };

/**
 * Reported (`onError(..., "broadcast")`) for a resync request whose answer the document's profile
 * failed to compute (SPECIFICATION.md RSY-9): the request, which the engine lets go, its requester,
 * and the profile's own error as `cause`. Reported once per request; the engine answers the others.
 */
export class ResyncAnswerError extends Error {
  readonly requestId: string;
  readonly requester: MemberId;

  constructor(requestId: string, requester: MemberId, cause: unknown) {
    super(
      `could not compute an answer to the resync request ${requestId} of ${requester}, which is let go (RSY-9): ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = "ResyncAnswerError";
    this.requestId = requestId;
    this.requester = requester;
  }
}

/**
 * How the scheduler treats a failed send. Refusals this client makes
 * itself (closed, read-only) and a `TransportSendError` that is not retryable are
 * permanent — retrying cannot help, and retrying a demoted member's edits forever
 * would be wrong. A rate-limit refusal is retryable and also tells the scheduler the
 * pace is too fast. A refusal only the person can lift (`needs-person`) is kept, but waits
 * for the person or the longest back-off (TRN-20). **Anything else is retryable**: dropping a
 * change on a failure nobody classified is exactly the fault this exists to remove.
 */
function classifySendFailure(error: unknown): SendFailureClass {
  if (error instanceof SendRefusedError || error instanceof ControlFrameRejectedError) {
    return { retryable: false };
  }
  // Too large to send in pieces at this transport's limit: no retry can change that (SND-19).
  if (error instanceof UnsplittableUpdateError || error instanceof PieceTooSmallError) {
    return { retryable: false };
  }
  if (error instanceof TransportSendError) {
    return {
      retryable: error.retryable,
      rateLimited: error.reason === "rate-limited",
      retryAfterMs: error.retryAfterMs,
      needsPerson: error.reason === "needs-person",
    };
  }
  return { retryable: true };
}

/**
 * Thrown (and routed to `onError(..., "apply")`) for a control frame this client must not act on. A
 * register it already holds, or one that does not hold over what it holds, is *not* an error: merging
 * it again changes nothing (CTL-6).
 */
export class ControlFrameRejectedError extends Error {
  /**
   * `refused`: registers of the creator this client does not hold, a frame's or a snapshot's, because
   * they would exceed its bounds of control state, or name a new member or layer right in a capacity
   * conflict (CTL-30, CTL-32).
   */
  readonly reason: "not-from-creator" | "creator-unknown" | "names-the-creator" | "refused";

  constructor(reason: ControlFrameRejectedError["reason"], message: string) {
    super(message);
    this.name = "ControlFrameRejectedError";
    this.reason = reason;
  }
}

/**
 * A control state as a snapshot carries it (§7.5, CTL-25): the document's profile (CTL-10), the
 * close, and one register per target. A joiner, or a client that lacks a decision, needs nothing
 * else.
 */
export interface ControlSnapshot extends RegisterState {
  readonly profile: string;
}

/**
 * Whether this client is bootstrapped (RSY-14): `none` before — its rights are not known, it refuses
 * its own edits (CTL-13), sends no control state and states no control clock; a device of the
 * creator edits, and decides nothing but the close and its reason (CTL-27) —; `bootstrapped` once it created the document, restored a state that was
 * bootstrapped, or merged an answer to its own request that carried control state — on a device of
 * the creator, one of another device of the creator's. Changes are reported through
 * `onControlStandingChange`.
 */
export type ControlStanding = { readonly kind: "none" } | { readonly kind: "bootstrapped" };

/**
 * What a client persists and restores (CTL-26, CTL-39): its control state, the draft it was written
 * by (VER-3), whether it was bootstrapped, whether it was in a capacity conflict, and on a device of
 * the creator its device tag, its own clock and its frames not yet known to be sent, which a
 * restarted engine sends again. Never sent to anyone: the snapshot in an answer is the plain
 * `ControlSnapshot`. A state another draft persisted — another `tdsp`, or none — is read as none.
 */
export interface PersistedControlState {
  /** The draft marker of the engine that persisted it (VER-3). */
  readonly tdsp?: string;
  readonly profile?: string;
  readonly control: RegisterState;
  /** This device's tag (CTL-20). */
  readonly device?: string;
  /** This device's own clock (CTL-45). */
  readonly clock?: Clock;
  /** The complete texts of this device's control frames not yet known to be sent. */
  readonly unsent?: readonly string[];
  /**
   * That this client had been bootstrapped (RSY-14) when the state was taken. Restored without it,
   * anyone but the creator does not use the state at all (CTL-39), and a device of the creator holds
   * it but is not bootstrapped: a new device that restarts is still a new device.
   */
  readonly bootstrapped?: boolean;
  /**
   * That this client was in a capacity conflict when the state was taken (CTL-32): it could not
   * hold a `control` frame or a snapshot within its bounds of control state. Restored, the conflict holds on,
   * since what it could not hold is not read again. Written only when true.
   */
  readonly capacityConflict?: boolean;
}

/**
 * A report this client owes (SND-11, SND-28), as its application persists it with the document's
 * content, on this device only, and gives back on the next start (`restore.owedReport`): the report
 * then goes as soon as the floor permits. It is not control state: every device owes its own.
 */
export interface OwedReport {
  /** The update of the last edit of this client's own that went out, to carry again (SND-27). */
  readonly update?: Uint8Array;
  /** On a device of the creator: the text of its last control frame, to send again first (SND-27). */
  readonly control?: string;
}

/**
 * Whether this client has reason to think something is missing. Never a
 * claim that something *is*: every suspicion is a gap (LOS-25) that has lasted long enough to be
 * worth a person's attention, and each can have an innocent cause (a late message). What to do
 * about one is a Resync; a gap whose tries ran out rests, shown as `resting`, until a frame wakes it
 * or the person synchronises now (LOS-26, LIF-12). Nor is `"ok"` a claim that nothing is
 * (SPECIFICATION.md LOS-15): it means no current evidence, never "synchronised" —
 * a creator whose request went `unanswered` may still lack an offline member's change (LOS-20).
 * Its times (`since`, `requestedAt`, `expiresAt`) are on the wall clock as it reads when this is
 * taken, each as far from then as the engine measured on its clock that never runs back (SND-25).
 */
export interface SyncHealth {
  readonly state: "ok" | "suspected";
  readonly suspicions: readonly SyncSuspicion[];
  /** This client's own resync request, if any: outstanding, answered, or expired unanswered. */
  readonly resync: ResyncStatus;
  /**
   * Answers to this client's own requests of which a piece is still missing, at once (LOS-14): a
   * transfer under way. Once one has lacked a piece for longer than one more would take, it is also
   * the suspicion `answer-incomplete`, and the engine asks again. A bootstrap completes with the
   * answer's last piece (RSY-14), which may come first: bootstrapped then, it may lack content still.
   */
  readonly incompleteAnswers: readonly IncompleteAnswer[];
  /**
   * `true` while this client is not bootstrapped, its automatic bootstrap requests ran out, and no request of its own holds the slot (RSY-5): its
   * application shows this and offers its person to ask again (`requestResync`), which is then not
   * refused as in flight. Absent while a request of its own is outstanding — the last attempt until
   * its time passed, a further one, the person's —, and otherwise. What it may still ask by itself
   * is no promise: once more, with growing waits, only on a frame read after its latest request that
   * went out had its time — of a participant that did not answer it, on a device of the creator only
   * of another of its devices, or, whoever answered, a `control` frame, a report or a request of
   * another device of the creator that states a control clock —; a device of the creator also for its
   * gaps and on a return (RSY-5). With `autoResync` off it makes no attempts, so this stays absent;
   * of these it then makes only a device of the creator's return requests (RSY-21), and otherwise its
   * person asks.
   */
  readonly attemptsRanOut?: true;
}

/**
 * A resync request holds the single slot for at least this long, however fast the transport
 * claims to be: it has to reach the creator, the creator has to have something newer, and the
 * answer has to come back.
 */
const RESYNC_EXPIRY_FLOOR_MS = 10_000;
/** The longest wait between automatic attempts, whatever the doubling would give. */
const RESYNC_BACKOFF_CAP_MS = 600_000;
/**
 * How long a device must have been away — since its last read that reached the messenger began — for
 * a start or a running engine told of its absence to make a start request (RSY-1, LIF-8, Appendix B);
 * and the absence threshold a stream must stay unheard for before a difference in digests its report
 * showed lapses (LOS-12).
 */
const START_REQUEST_AFTER_MS = 600_000;
/** How often a device of the creator sends its close again to one writer at most (LIF-11, Appendix B). */
const CLOSE_RESEND_SPACING_MS = 600_000;
/** How many requests to all heard of others are kept to let a request of this client's own go for (RSY-22). */
const MAX_HEARD_REQUESTS_TO_ALL = 16;
/** How many times a joiner that got no answer asks again by itself. */
const MAX_AUTOMATIC_BOOTSTRAP_ATTEMPTS = 5;
/** How many of a return's requests to all may expire unanswered before it ends (RSY-21). */
const RETURN_REQUESTS_TO_EXPIRE = 2;

/**
 * "broadcast": something this client sends failed for good — a broadcast triggered by `edit()`
 * (e.g. the channel was removed, or a real messenger refused the send for good), a resync answer,
 * or an answer the document's profile could not compute for a request, which is let go (RSY-9).
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

/**
 * The kinds of frame this engine writes an extension into. Not a control frame: its registers
 * live on in snapshots, which carry no extension (FRM-17), so what one added would reach only
 * those who received the frame itself.
 */
export type ExtensionKind = "edit" | "heartbeat" | "resync-request" | "resync-response";

/**
 * An extension this client implements (SPECIFICATION.md FRM-9 to FRM-12, FRM-15 to FRM-17), as its
 * public definition says: what this client writes of it, how a received value is checked, and who
 * is told of one. The engine keeps nothing an extension carries and passes nothing on (FRM-17).
 */
export interface FrameExtension {
  /**
   * Its name: contains `.`, begins with a reverse domain name its definer controls and ends with
   * `/` and its major version, such as `com.example.mood/1` (FRM-9, FRM-15). `com.example.mood/2`
   * is another extension.
   */
  readonly name: string;
  /** Whether a frame this client writes it into names it in `crit` (FRM-10), so a receiver that does not implement it rejects the frame. */
  readonly critical?: boolean;
  /**
   * What this client writes under `name`, by kind; a kind left out carries none. Fixed for the
   * engine's life, so that every size the engine works out before it sends holds (FRM-11): JSON
   * values, at most 31 levels deep.
   */
  readonly values?: { readonly [K in ExtensionKind]?: unknown };
  /**
   * Whether a received value is one its definition allows. One it does not is ignored, or, when
   * the frame names the extension in `crit`, rejects the frame (FRM-16). Without it, every value is.
   */
  readonly accepts?: (value: unknown, kind: Frame["kind"]) => boolean;
  /**
   * Called with the value a frame carried, once the engine has accepted and handled that frame —
   * never for one it rejects (FRM-6), nor for this client's own. The value is the sender's,
   * untrusted.
   */
  readonly receive?: (
    value: unknown,
    frame: { readonly kind: Frame["kind"]; readonly sender: MemberId },
  ) => void;
}

const EXTENSION_KINDS: readonly ExtensionKind[] = [
  "edit",
  "heartbeat",
  "resync-request",
  "resync-response",
];

/**
 * The checks of the extensions an application implements and what this client writes of them, by
 * kind — or an error for a set no frame could carry (FRM-9 to FRM-11).
 */
function extensionsOf(extensions: readonly FrameExtension[]): {
  checks: ReadonlyMap<string, ExtensionCheck>;
  outgoing: ReadonlyMap<ExtensionKind, OutgoingExtensions>;
} {
  const checks = new Map<string, ExtensionCheck>();
  for (const extension of extensions) {
    if (!isExtensionName(extension.name)) {
      throw new Error(`an extension name must contain a dot (FRM-9): ${extension.name}`);
    }
    if (checks.has(extension.name)) {
      throw new Error(`the extension ${extension.name} is supplied twice`);
    }
    checks.set(extension.name, extension.accepts ?? (() => true));
  }
  if (extensions.filter((extension) => extension.critical === true).length > MAX_CRIT) {
    throw new Error(`a frame's crit names at most ${MAX_CRIT} extensions (FRM-10)`);
  }
  const outgoing = new Map<ExtensionKind, OutgoingExtensions>();
  for (const kind of EXTENSION_KINDS) {
    const fields: Record<string, unknown> = {};
    const crit: string[] = [];
    for (const extension of extensions) {
      const value = extension.values?.[kind];
      if (value === undefined) {
        continue;
      }
      const text = JSON.stringify(value) as string | undefined;
      // Where the frame nests it: one level below the frame's own object (§1.6).
      if (
        text === undefined ||
        jsonTextTooDeep(`{"v":${text}}`) ||
        strictJsonProblem(text) !== undefined
      ) {
        throw new Error(
          `the extension ${extension.name} writes a value that is not I-JSON within the nesting limit (FRM-11)`,
        );
      }
      fields[extension.name] = JSON.parse(text);
      if (extension.critical === true) {
        crit.push(extension.name);
      }
    }
    if (crit.length > 0 || Object.keys(fields).length > 0) {
      outgoing.set(kind, { fields, crit });
    }
  }
  return { checks, outgoing };
}

export interface DocumentEngineOptions {
  /**
   * The document's profile (SPECIFICATION.md §5): chosen by the creator's application,
   * carried to a joiner in the invitation, fixed for the document's life. `create()` and
   * `join()` refuse one this engine does not implement (`UnsupportedProfileError`).
   * Defaults to `yjs-paragraphs/1`, the one this engine has built in.
   */
  profile?: string;
  /**
   * Document profiles the application brings besides the built-in `yjs-paragraphs/1`
   * (SPECIFICATION.md §5.5): `profile` may then name one of them. Each needs a public
   * definition with test vectors (PRF-7) and ships with the application; nothing a document
   * says ever adds one (PRF-8). One that takes a built-in id, or is given twice, is refused.
   * What a decline lists (DCL-1) is `SUPPORTED_PROFILES` and these ids.
   */
  profiles?: readonly DocumentProfile[];
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
   * How often and how much this client sends, as *it* chooses (SND-16): nothing of
   * it is sent, and nobody else can change it. A floor between two messages
   * (`minIntervalMs`), the longest a change may wait (`maxIntervalMs`), size bounds
   * in changed characters (`minChars`, `maxChars`) and how long a message normally
   * takes to arrive (`expectedLatencyMs`). What is left out comes from the
   * transport's default profile (`MessengerPort.transportProfile`), and where the
   * transport has none from the library's defaults: a message after a typing
   * pause, with no floor and no cap. The result is made consistent (`resolveSyncPolicy`), so no
   * combination can starve a pending change, and clamped to the transport's hard
   * bounds — a value below its floor is raised to it — and to the pace the creator set, which is a
   * floor for everyone (SND-15). Read the outcome from `DocumentEngine.syncPolicy`.
   */
  syncPolicy?: Partial<SyncPolicy>;

  /**
   * Whether this client asks for a resync by itself where it may: a joiner that is not bootstrapped
   * repeats its request, with a doubling wait, and once its attempts ran out asks once more on a frame
   * that shows someone is there again (RSY-5); a gap — evidence that something is missing — that has
   * lasted long enough is followed by a request, at most three per gap before it rests, and a resting
   * one that is woken asks again (LOS-6, LOS-26). Always through the same single slot a person's click
   * uses, never in parallel with it. Turn it off and those stop, while `syncHealth` still reports what
   * it notices; the requests RSY-1 requires and a return's requests (RSY-21) go all the same, but for
   * a device still in its bootstrap, a member's or the creator's, which asks again only as its
   * bootstrap does, also when it returns: its first request is its one. Anything more, only a person
   * asks.
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
   * Called whenever the report this client owes arises, carries something else, or falls
   * (`DocumentEngine.owedReport`, SND-28), with what it now is: so that the application persists it
   * with the content at once, on this device only.
   */
  onOwedReportChange?: (owed: OwedReport | undefined) => void;

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
   * request (RSY-6, RSY-20): the creator's devices answer everyone else's at once, and so does
   * another device of the requester's own member; anyone else answers only a request to all, at
   * its turn. A client that does not know the creator answers no one and accepts a resync response
   * from no one (RSY-12).
   */
  creatorMemberId?: MemberId;

  /**
   * This client's control state, as the application last persisted it (CTL-26), given back when
   * it re-attaches to the document with `join()` — `create()` refuses it (LIF-5). For a device of
   * the creator, its device tag and its clock continue, what it had not yet sent goes out, and it is
   * bootstrapped only if it was when persisted (CTL-26, RSY-14); without a tag it continues under a
   * new one. For anyone else it is used only when it was taken once bootstrapped (`bootstrapped`):
   * its rights show at once, and it bootstraps this client after its first read on from
   * `restore.cursor` shows no gap (CTL-39, CTL-41); otherwise an answer does. A state another draft
   * persisted counts as none (VER-3).
   */
  controlState?: PersistedControlState;

  /**
   * The document's content as the application persisted it, to start from on `join()` —
   * after a restart, so the document shows at once, before the messenger is reachable.
   * `state` is the profile's encoded state (`encodeUpdate`), `attribution` what
   * `attribution.toJSON()` returned for that same state; without it the restored text is
   * unattributed. Applied before anything is observed, so it is neither sent as an edit of
   * this client's nor credited to it. `create()` refuses it: a new document has nothing to
   * restore.
   *
   * Persisted content may hold changes nobody else received — one still waiting to go out,
   * or in flight, when the application stopped. So restored content counts as undistributed
   * (`hasUndistributedChanges`, SPECIFICATION.md SND-8) until the engine has sent the whole
   * state once, as `resync()` does: right away for the creator, after the bootstrap for
   * anyone else (CTL-13), never while this client may not edit. One message per restart, the
   * price of never losing such a change. Restoring changes what is shown, not what is
   * permitted. The engine reads first, then asks as RSY-1 says: as a joiner while it is not
   * bootstrapped, otherwise once, to all, only after more than 10 minutes away — `readAt` — or not
   * knowing how long, or holding a gap.
   *
   * `cursor` is `DocumentEngine.cursor` as it stood when `state` was taken, with a transport that
   * offers `receiveSince` (LIF-8): the engine reads on from there, and learns whether its transport
   * still holds everything since — what a restored member's control state needs to bootstrap it.
   * `instance` is `DocumentEngine.instance` as it stood with that cursor, with a transport that names
   * its window's epoch (TRN-19): the first read compares the transport's with it, so a bridge that
   * may have lost something while this client was gone shows it, and one that kept everything does
   * not (LOS-9).
   *
   * `readAt` and `rebound` say whether this start is a **return** (RSY-21): `readAt` is when this
   * client began the last read of its transport for the document that reached the messenger and
   * whose deliveries `state` holds, or a time before that — not when `state` was taken, which may
   * follow a read that failed or one a bridge answered from its window while it could not reach its
   * messenger (LIF-8) —, by its wall clock in milliseconds, and a start more than
   * `transportRetentionMs` after it is one; `rebound` says that the application had unbound the
   * document from its channel since and binds it again now, so that nothing sent meanwhile reached
   * this device, however short the time. A device that returns may lack what members wrote while it
   * was away and its transport no longer holds, which nothing shows until they write again: its
   * request asks all, and once more if that one expires unanswered (RSY-21).
   *
   * `owedReport` is `DocumentEngine.owedReport` as it stood when `state` was taken (SND-28): a report
   * this client owed and had not yet sent, with what it carries again. It goes as soon as the floor
   * permits, under this engine's new stream: what it carries went out before (SND-27).
   */
  restore?: {
    readonly state: Uint8Array;
    readonly attribution?: AttributionSnapshot;
    readonly cursor?: DeliveryId;
    readonly instance?: string;
    readonly readAt?: number;
    readonly rebound?: boolean;
    readonly owedReport?: OwedReport;
  };

  /**
   * How long this client's transport keeps a message for a device that is away, in milliseconds, as
   * its binding or its application knows it; `undefined` where neither does. With `restore.readAt` it
   * tells a restart that is a return (RSY-21). Nothing of it is sent.
   */
  transportRetentionMs?: number;

  /**
   * For `create` only: the creator's application sends the invitation before the initial state,
   * into a channel it made for the document (LIF-9). A failed send of the initial state then fails
   * nothing: those invited hold an invitation to this document, so it is created, its content counts
   * as undistributed, and the engine sends it whole once it can, as it sends restored content
   * (SND-20, LIF-5). Without it, such a failure fails the creation.
   */
  invitedFirst?: boolean;

  /**
   * Called after every change to this client's control state — registers merged, a decision about
   * to be sent, a snapshot merged — so the application can persist it (see `controlState`). A
   * device of the creator's must be persisted before this returns: the call that announces a new
   * decision comes *before* it is sent (CTL-26). A throw there leaves everything as it was, and
   * nothing is sent.
   */
  onControlStateChange?: (state: PersistedControlState) => void;
  /**
   * Called whenever `controlStanding` changes — once this client is bootstrapped (RSY-14) — so that
   * the application can show the rights as known from then on.
   */
  onControlStandingChange?: (standing: ControlStanding) => void;
  /**
   * Called for a participant's decline of this document's invitation (SPECIFICATION.md
   * §6.5), at most once per sender. Information only: nothing in the document changes.
   */
  onDecline?: (decline: ReceivedDecline) => void;
  /**
   * Extensions this client implements (SPECIFICATION.md FRM-9 to FRM-12, FRM-15 to FRM-17). Each
   * needs a public definition and ships with the application, like a profile. A frame whose `crit`
   * names one that is not here is rejected (`unsupported-extension`); one it carries without `crit`
   * is ignored. Two with one name, a name without `.`, more than 16 critical ones, or a value that
   * is not JSON within the nesting limit are refused.
   */
  extensions?: readonly FrameExtension[];
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
  /** The requester's control clock; `null` while it may state none (RSY-16). */
  readonly controlClock: Clock | null;
  /** The digest of the requester's control state; `null` with `controlClock` (LOS-24). */
  readonly controlDigest: string | null;
  /** The digest of the requester's content (LOS-12). */
  readonly stateDigest: string;
  /** The requester cannot tell what it lacks and asks for an answer regardless (LOS-9). */
  readonly force: boolean;
  /** Whether any member may answer it (RSY-6, RSY-21). */
  readonly all: boolean;
  readonly stateVector: Uint8Array;
  /** The requester's stream and the request's number in it (LOS-13): only its latest request counts (RSY-9). */
  readonly stream: string;
  readonly sequence: number;
}

/**
 * A resync request a responder keeps until it has answered it (RSY-9), with when it was first heard
 * and whether and when this engine may answer it (RSY-6, RSY-20): fixed then, so a copy offered
 * again keeps its turn while the engine runs.
 */
type PendingResyncRequest = IncomingResyncRequest & {
  readonly heardAt: number;
  readonly turn: AnswerTurn;
};

/** What the last piece of an answer to someone's request stated, and when this engine heard it (RSY-18, RSY-20). */
interface HeardAnswerState {
  readonly heardAt: number;
  readonly stateVector: Uint8Array;
  readonly stateDigest: string;
  /** The furthest the request's stream had stated as it was heard, if the request was known then. */
  readonly stated: StatedFurthest | undefined;
  /**
   * Whether every update the engine held as it heard the answer was counted by the answer's state
   * vector or by `stated`'s; and whether it held updates beyond the answer's, whose deletions `stated`
   * must then hold.
   */
  readonly writersHeld: boolean;
  readonly beyondAnswer: boolean;
  /** Whether it holds what the engine would give; `undefined` while the deletions cannot be compared. */
  held: boolean | undefined;
}

/** Another's request to all, with when it was first heard (RSY-22). */
type HeardRequestToAll = IncomingResyncRequest & {
  readonly heardAt: number;
  /** The read that brought it (`#reads`): one a start, a return or an absence catches up with is let go. */
  readonly read: number;
};

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
  /**
   * When a truncated history was first noticed, as it is shown and waited for; cleared once an answer to
   * a request of this engine's own sent with `force` after it was last noticed applies (LOS-19).
   */
  #historyTruncatedSince: number | undefined;
  /**
   * How many times a truncated history was noticed, each time anew also while the evidence stands: the
   * number a request sent with `force` records, which an answer to it must still match (LOS-19).
   */
  #truncations = 0;
  /** When a truncated history was last noticed: a request to all the creator sent before it ends nothing (LOS-20). */
  #lastTruncationAt = Number.NEGATIVE_INFINITY;
  /**
   * The cursor the last `truncated` answer of `receiveSince` that counted was for: while the evidence
   * stands, the same cursor reported truncated again is that loss again, not a new one (TRN-18, LOS-19).
   * It keeps one truncation from being counted twice while it stands: a bridge that says so on every
   * read until something new arrives would otherwise leave each answer to the request sent after it
   * one count behind, and the evidence would never end.
   */
  #truncatedAfter: { readonly cursor: DeliveryId | undefined } | undefined;
  // Whether the last `receive` failed (LOS-8).
  #receiveFailed = false;
  // With a transport that takes a cursor (TRN-18): the last delivery id seen.
  #cursor: DeliveryId | undefined;
  // A non-creator restored with control state of an earlier bootstrap and a cursor: its first
  // read decides whether that state bootstraps it (CTL-41).
  #restoredBootstrapPending = false;
  // This client's digests (LOS-12), kept until the content or the control state changes; and the
  // digests of what it deleted within others' state vectors, by vector, kept as long.
  #stateDigestCache: string | undefined;
  #stateDigestWithinCache = new Map<string, string>();
  // This engine's stream, as it runs now, and the number of its latest report in it (LOS-13): every
  // heartbeat, request and answer says where it stands, so a receiver keeps only a stream's newest
  // (LOS-17).
  #stream = newRandomId();
  #sequence = 0;
  // What this engine's latest report stated: its heartbeat's, its request's or its answer's last
  // piece's state, as it wrote it (LOS-13).
  #lastReport: { readonly stateVector: Uint8Array; readonly stateDigest: string } | undefined;
  // With a transport that names its window's epoch, cursor or not: the one that answered the last
  // read, or restored with the cursor (TRN-19, LOS-9).
  #instance: string | undefined;
  // "Fully resolved" — answered, suppressed, or this client's own request.
  // Never reconsidered again once added (same "never retried" contract
  // #seenDeliveryIds already has).
  #seenResyncRequestIds = new Set<ResyncRequestId>();
  /**
   * Requests this engine may have to answer and has not yet — throttled, or nothing to offer
   * yet (SPECIFICATION.md RSY-9, RSY-19): kept and reconsidered on every later `sync()`, by request
   * id, at most four per requester, in the order requesters are served (the one answered last at
   * the end), bounded, and dropped after a while. Without this a request skipped once was never
   * looked at again: its delivery had been seen.
   */
  readonly #pendingResyncRequests = new Map<MemberId, PendingResyncRequest[]>();
  // The resync requests *this* client itself made, with when each went out and which were true
  // bootstrap requests — a subset of #seenResyncRequestIds, tracked separately so sync() can
  // recognize "a resync-response just answered MY OWN request" without conflating it with requests
  // seen from others (hasCompletedBootstrap), and whose answer's overlay to consider (RSY-15).
  // Bounded by age and count, one whose answer is still arriving in pieces kept (RSY-12, Appendix B);
  // a forgotten one stays among the seen request ids, so a copy of it is never answered (RSY-6).
  readonly #ownRequests = new OwnRequests();
  // Requests of others to all this engine let a request of its own go for (RSY-22): their answers are
  // accepted as answers to its own are (RSY-12), bounded as those are, but bootstrap nothing and bring
  // no overlay (RSY-14, RSY-15).
  readonly #adoptedRequests = new OwnRequests();
  // The latest requests of others to all, with when each was first heard (RSY-22): what a request of
  // this client's own for its gaps may be let go for, within its expiry. At most
  // MAX_HEARD_REQUESTS_TO_ALL, the oldest dropped first.
  readonly #heardRequestsToAll: HeardRequestToAll[] = [];
  // Until when the latest request let go for another's holds this client's gaps (RSY-22).
  #adoptedUntil = Number.NEGATIVE_INFINITY;
  // How many reads this engine made: what `#heardRequestsToAll` names the read of a request by.
  #reads = 0;
  // The highest number of a request heard of each requesting stream, by member and stream (RSY-9):
  // an older one of that stream, kept or arriving late, is let go. At most MAX_REMEMBERED_REQUESTS
  // streams, the one heard from least recently dropped first.
  readonly #latestRequestOf = new Map<string, number>();
  #lastResyncResponseAt: number | null = null;
  /**
   * Requests whose answers' last pieces were heard, from anyone and whether this engine accepted
   * them or not, with the state each stated, when it was heard and whether it holds this engine's
   * content as it held it then (`contents`, the first MAX_ANSWERS_KEPT_PER_REQUEST), and when one was
   * first heard whose snapshot holds its control state as it held it then (`controlAt`), oldest first
   * and bounded (RSY-20): a member that may answer a request only because it asks all lets it go when,
   * before its turn, answers came that hold what it would give.
   */
  readonly #answersHeard = new Map<
    ResyncRequestId,
    { readonly contents: readonly HeardAnswerState[]; readonly controlAt?: number }
  >();
  // Whether this client's latest request of its own asked all (RSY-21, LOS-20), and whether a request
  // of its bootstrap went out yet: only the first asks the creator's devices and its own alone.
  #lastRequestAll = false;
  #askedInBootstrap = false;
  // A return (RSY-21): this client started from restored content after it was away longer than its
  // transport keeps, or after its document was unbound meanwhile, and may lack what came then. Its
  // first request asks all, and it lasts until a request of it to all made since it began was
  // answered, or two expired.
  #returning = false;
  #returnBeganAt: number | null = null;
  // A return's requests to all that expired unanswered so far, and when the last one counted was
  // made, so that one request counts once however often the return is looked at (RSY-21).
  #returnExpired = 0;
  #returnCountedRequestAt: number | null = null;
  // A start request a running engine owes, told of an absence of more than START_REQUEST_AFTER_MS
  // (RSY-1, LIF-12): made once, by itself, and never repeated.
  #startRequestOwed = false;
  // Who answered this client's latest request of its own that went out before it had its time, how
  // long it could wait, which one it was, and when each participant was last read since — on a device
  // of the creator, each other device of the creator: a bootstrap whose attempts ran out asks once
  // more on a frame read after that time of a participant that did not answer it (RSY-5). A request
  // whose send failed asked nobody and counts for nothing (RSY-4): the one before it is the latest
  // again, with who answered it.
  #answeredLatestBy = new Set<MemberId>();
  #heardAfterExpiry = new Map<MemberId, number>();
  // When a device of the creator other than this one was last read stating a control clock — in a
  // `control` frame, a report or a request — since that request: it holds the state that bootstraps
  // (RSY-14), and asks for one more request whoever answered, since the creator's answer may have
  // come from a device that holds none (RSY-5).
  #heardCreatorClockAt: number | null = null;
  #lastRequestExpiryMs: number | undefined;
  #latestRequestId: string | undefined;
  // The writers a device of the creator sent its close again to, and when, and the read (`#reads`) it
  // last did in (LIF-11).
  readonly #closeResentTo = new Map<MemberId, number>();
  #closeResentInRead = 0;
  // Whether an overlay was adopted for the bootstrap: the first one stands for the engine's life,
  // however many of its bootstrap requests are answered (RSY-15).
  #overlayAdopted = false;
  #unobserve: () => void;
  #unobserveAttribution: () => void;
  #onError: DocumentEngineErrorHandler;
  #syncPolicy: SyncPolicy;
  #transport: TransportProfile | undefined;
  // What this client chose for its own pacing (SND-16): what `#syncPolicy` is derived from,
  // with the transport's suggestion and bounds and the creator's pace (SND-15).
  readonly #chosen: Partial<SyncPolicy> | undefined;
  #resyncResponseThrottleMs: number;
  // How long the transport keeps a message for a device that is away, if known (RSY-21).
  readonly #transportRetentionMs: number | undefined;
  #creatorMemberId: MemberId | undefined;
  readonly #profile: DocumentProfile;
  #onControlStateChange: ((state: PersistedControlState) => void) | undefined;
  #onDecline: ((decline: ReceivedDecline) => void) | undefined;
  readonly #declinesReported = new Set<MemberId>();
  // --- control state (§7) ---
  // The creator's decisions: one register per target and the close, merged as CTL-22 says. The creator
  // is implicit and never a target; a member without a register is *unknown*, which counts as
  // `read` (CTL-13).
  #control = new ControlState();
  // A device of the creator's tag (CTL-20) and its own clock (CTL-45); none for anyone else.
  #device: string | undefined;
  // Whether that tag was handed to the application to persist (CTL-26): one taken as the engine starts
  // is not, until its control state is first reported.
  #devicePersisted = false;
  #clock: Clock = ZERO_CLOCK;
  // This device's control frames not yet known to be sent, by their text (CTL-26).
  readonly #unsent = new Map<string, string>();
  // Whether this client is bootstrapped (RSY-14): it created the document, restored a state that was
  // bootstrapped (CTL-26, CTL-41), or merged an answer to its own request that carried control state
  // (RSY-12) — on a device of the creator, one of another device of the creator's: a member's shows
  // what that member holds, not the creator's state (CTL-27).
  #bootstrapped = false;
  #onControlStandingChange: ((standing: ControlStanding) => void) | undefined;
  // `controlStanding` as last reported, so that only a change is reported.
  #standingKey = "";
  #scheduler: SendScheduler;
  #detector: LossDetector;
  // The transport's largest message, if it says: a frame over it is sent in pieces (SND-17).
  #maxBytes: number | undefined;
  // The extensions this client implements (FRM-16): how a received value is checked, what it
  // writes by kind, and who is told of what a frame carried.
  readonly #extensions: readonly FrameExtension[];
  readonly #extensionChecks: ReadonlyMap<string, ExtensionCheck>;
  readonly #outgoing: ReadonlyMap<ExtensionKind, OutgoingExtensions>;
  // `SendScheduler.droppedCount` as of the last `resync()` the transport accepted.
  #distributedThroughDrop = 0;
  // Content restored on join that may hold changes nobody else has: sent whole once this
  // client may edit (`restore`). Until then `#distributedThroughDrop` is below every count.
  #restoredUnsent = false;
  // The clock every duration and deadline of this engine is measured on, one that never runs back
  // (SND-25): its scheduler, its resync gate and its loss detector share it, so their times compare.
  // Only CTL-45's control clock reads the wall clock, by its own rules, and so does a time across a
  // restart (`restore.readAt`, RSY-21), which no clock of this engine measured.
  readonly #steady = new SteadyClock();
  // The one slot a resync request of this client's own may hold, however many things ask.
  #resyncGate = new ResyncGate(() => this.#steady.now());
  #autoResync: boolean;
  // The automatic requests of the bootstrap, the further ones after its attempts ran out included
  // (RSY-5), and when the last automatic attempt was made, whether or not the send went through. A
  // gap counts its own (LOS-6).
  #automaticBootstrapAttempts = 0;
  #lastAutomaticAttemptAt: number | null = null;
  // A request of this client's own has taken the slot and waits in the scheduler to go out.
  #requestWaiting = false;
  // The first read of an engine that starts again from persisted state runs: it asks only after it
  // (RSY-1, CTL-41).
  #starting = false;
  // Characters changed by the local transaction in progress: counted by the
  // plain-text observer, which Yjs fires before the `update` event that queues the
  // update, and taken by that event. Never counted while a remote update is applied.
  #localChars = 0;
  #applyingRemote = false;
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
  // `null` while applying content whose author this client cannot know: unattributed (ATR-2,
  // RSY-13), never a MemberId of its own invention, which another engine would show as a person.
  #attributionAuthor: MemberId | null;

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
    this.#extensions = options.extensions ?? [];
    const extensions = extensionsOf(this.#extensions);
    this.#extensionChecks = extensions.checks;
    this.#outgoing = extensions.outgoing;
    const onSendStatusChange = options.onSendStatusChange;
    const onOwedReportChange = options.onOwedReportChange;
    this.#resyncResponseThrottleMs = options.resyncResponseThrottleMs ?? 1000;
    this.#transportRetentionMs = options.transportRetentionMs;
    this.#creatorMemberId = options.creatorMemberId;
    this.#profile = profileFor(options.profile ?? YJS_PARAGRAPHS_1, options.profiles);
    this.#autoResync = options.autoResync ?? true;
    this.#onControlStateChange = options.onControlStateChange;
    this.#onControlStandingChange = options.onControlStandingChange;
    this.#onDecline = options.onDecline;
    const persisted = readPersisted(options.controlState);
    if (
      persisted !== undefined &&
      options.creatorMemberId !== memberId &&
      persisted.state.bootstrapped === true
    ) {
      // The control state as this client last held it: it shows at once, and counts as a bootstrap
      // only after a first read on from the persisted cursor without a gap (CTL-39, CTL-41).
      this.#control = ControlState.from(persisted.control);
      this.#restoredBootstrapPending = options.restore?.cursor !== undefined;
      if (persisted.state.capacityConflict === true) this.#control.markCapacityConflict();
    }
    this.#cursor = options.restore?.cursor;
    this.#instance = options.restore?.instance;
    if (persisted !== undefined && options.creatorMemberId === memberId) {
      const state = persisted.state;
      this.#control = ControlState.from(persisted.control);
      if (state.capacityConflict === true) this.#control.markCapacityConflict();
      this.#device =
        typeof state.device === "string" && DEVICE_TAG.test(state.device)
          ? state.device
          : undefined;
      this.#devicePersisted = this.#device !== undefined;
      this.#clock = isRestoredClock(state.clock) ? state.clock : ZERO_CLOCK;
      for (const text of state.unsent ?? []) {
        let frame: Frame;
        try {
          frame = decodeFrame(text);
        } catch {
          continue; // a frame of an earlier draft, which no receiver reads any more
        }
        if (frame.kind === "control") {
          this.#unsent.set(text, text);
          // Already part of the persisted state when this device decided it; merged again, it
          // changes nothing (CTL-6).
          this.#control.take({ closed: frame.closed, targets: frame.targets });
        }
      }
      // Bootstrapped only if it was when persisted (CTL-26, RSY-14): a restart bootstraps nothing.
      this.#bootstrapped = state.bootstrapped === true;
      // Its clock lies above what it restored, its unsent decisions included, within the span
      // (CTL-45): its next decision then holds over each of them.
      this.#clock = raiseClock(this.#clock, this.#control.clock, Date.now());
    }
    if (options.creatorMemberId === memberId && this.#device === undefined) {
      // A device of the creator without a tag of its own continues under a new one (CTL-20).
      this.#device = newDeviceTag();
    }
    // What it holds as it starts is reported only once it changes.
    this.#noticeStanding(false);
    this.#chosen = options.syncPolicy;
    this.#syncPolicy = this.#effectivePolicy();

    const editFrameOverhead =
      frameByteLength(encodeEditFrame(documentId, new Uint8Array(3), this.#outgoing.get("edit"))) -
      4;
    this.#scheduler = new SendScheduler({
      clock: this.#steady,
      quietMs: options.batchWindowMs ?? 500,
      policy: this.#syncPolicy,
      send: (update, roots) => this.#broadcast(update, roots),
      classify: classifySendFailure,
      onDropped: (error) => this.#onError(this.#blameProfileFor(error), "broadcast"),
      onStatusChange: onSendStatusChange && (() => onSendStatusChange(this.sendStatus)),
      // The report at the end of each phase of this client's own sending (SND-11, SND-27), owed until
      // the transport accepted it, and observable while it is (SND-28).
      report: (carry) => this.#reportMessages(carry),
      onReportChange: onOwedReportChange && (() => onOwedReportChange(this.owedReport)),
      splitting:
        this.#maxBytes === undefined
          ? undefined
          : {
              maxBytes: this.#maxBytes,
              // The edit frame's other fields, then the update as Base64: four characters for
              // every three bytes (SPECIFICATION.md §4).
              frameSize: (update) => editFrameOverhead + 4 * Math.ceil(update.length / 3),
              pieces: (update, roots) => {
                // Splitting an edit is where it is refused if this client may not send one:
                // the same permanent refusal a whole edit gets (`SendRefusedError`).
                this.#assertMayChange(roots);
                return this.#editFramesOf(update);
              },
              sendFrame: (frame) => this.#sendFrame(frame),
            },
    });
    // A report owed when the application last persisted the content goes as soon as the floor
    // permits (SND-28).
    const owed = options.restore?.owedReport;
    if (owed !== undefined) {
      this.#scheduler.restoreOwedReport(this.#restoredCarry(owed));
    }
    this.#detector = new LossDetector({
      creatorMemberId: () => this.#creatorMemberId,
      policy: () => this.#syncPolicy,
      pendingGapClients: () => this.#profile.pendingGapClients(this.document),
      lacksUpdatesOf: (stateVector) => this.#profile.lacksUpdatesOf(this.document, stateVector),
      // Whose updates a report shows missing: a gap of each writer's stream (LOS-4, LOS-25).
      clientsAhead: (stateVector) => clientsAheadOf(this.#profile)(this.document, stateVector),
      // The registers this engine holds (LOS-10, LOS-12).
      controlClock: () => this.#control.clock,
      stateDigestWithin: (stateVector) => this.#stateDigestWithin(stateVector),
      controlDigest: () => this.#control.digest,
      // A gap of this client's own, with tries of its own (LOS-19, LOS-25).
      truncatedSince: () => this.#historyTruncatedSince,
      // Each gap's first try in a slot of its own (LOS-6).
      stream: () => this.#stream,
      now: () => this.#steady.now(),
      // A stream silent for longer than an absence that asks again (RSY-1) has a difference in digests
      // its report showed lapse (LOS-12).
      absenceMs: START_REQUEST_AFTER_MS,
    });

    this.#unobserve = observeUpdates(this.document, (update, origin, transaction) => {
      this.#stateDigestCache = undefined;
      this.#stateDigestWithinCache.clear();
      if (origin === REMOTE_ORIGIN) {
        return;
      }
      const chars = this.#localChars;
      this.#localChars = 0;
      // A change the document's profile does not read is never sent: every receiver would refuse
      // it (FRM-6). Refused alone, it is not merged with a change that may go (SND-26).
      if (!readerOf(this.#profile).isUpdate(update)) {
        this.#scheduler.refuse(
          new SendRefusedError(
            "unreadable",
            `a change of ${this.documentId} is not one update its profile reads, as JSON content nested more than 32 levels is not (SND-26)`,
          ),
        );
        return;
      }
      // What the change touches decides whether it may be sent (LAY-7): only here, in the
      // transaction, can the engine tell; the bytes alone do not say it for a deletion.
      this.#scheduler.enqueue(update, chars, changedRoots(this.document, transaction));
    });

    this.#unobserveAttribution = projectionOf(this.#profile).observe(this.document, (change) => {
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
    // Persisted control state means the document exists: creating it anew would seed a
    // second first paragraph over its content (LIF-5). Refused before anything is sent.
    if (options.restore !== undefined) {
      throw new Error(
        `cannot create ${documentId} from persisted content: a creator resuming its document ` +
          "rejoins it with join(…, { creatorMemberId: <its own memberId>, controlState, restore })",
      );
    }
    if (options.controlState !== undefined) {
      throw new Error(
        `cannot create ${documentId} anew from persisted control state (SPECIFICATION.md LIF-5): ` +
          "a creator resuming its document rejoins it with join(…, { creatorMemberId: <its own memberId>, controlState })",
      );
    }
    // Refused before anything is registered or sent (PRF-3).
    const profile = profileFor(options.profile ?? YJS_PARAGRAPHS_1, options.profiles);
    // Asked before the document is registered, and allowed to fail the call: falling back to the
    // library's defaults would be sending faster than the transport allows (TRN-14). It names no
    // document. A transport too small is refused here too (TRN-23): neither leaves a channel behind.
    const transport = await messenger.transportProfile?.();
    assertLargeEnough(documentId, transport);
    await messenger.createDocument(documentId, memberId);

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
    // A creator always already has its own document and its own decisions — no bootstrap needed (RSY-14).
    client.#bootstrapped = true;
    client.#noticeStanding(false);
    // Reported before the start frame goes out, though nothing is decided yet: its device tag, its
    // clock and that it is bootstrapped are what a restart of this device restores (CTL-26, RSY-14).
    // Without it, a creator that never decided restarts as a new device. If it cannot be persisted,
    // nothing has left the device, and creating it again is no second start (LIF-5).
    try {
      client.#notifyControlStateChange();
    } catch (error) {
      client.dispose();
      throw error;
    }
    // Sent explicitly (not via the observer, which only attaches after
    // this point, and never batched, regardless of batchWindowMs) so the
    // seed is one clean send, not a duplicate.
    const seed = profile.encodeState(document);
    const seedFrame = encodeEditFrame(documentId, seed, client.#outgoing.get("edit"));
    // Through the scheduler like every message (SPECIFICATION.md SND-2). The whole initial state, as
    // restored content and `resync()` send it, is no change of its own: it begins no phase of its
    // sending, and no report carries it again (SND-11, SND-27).
    let seedId: DeliveryId;
    try {
      seedId = await client.#scheduler.submit(() =>
        messenger.send(documentId, memberId, seedFrame),
      );
    } catch (error) {
      if (options.invitedFirst !== true) {
        throw error;
      }
      // Those invited hold an invitation to this document already: it stays, and its initial state
      // goes again whole, as restored content does (SND-20, LIF-5).
      client.#distributedThroughDrop = -1;
      client.#restoredUnsent = true;
      client.#sendRestoredOnce();
      return client;
    }
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
      return await scheduler.submit(() => messenger.send(documentId, memberId, frame));
    } finally {
      scheduler.stop();
    }
  }

  /**
   * Joins a document a creator has already granted `memberId` a permission
   * on. A joiner requests a resync *before* syncing (SPECIFICATION.md RSY-1) rather than
   * relying on the transport replaying history — a `MessengerPort` adapter is never
   * required to do that (a Signal device link, for one, sees no history), so
   * `join()` must not depend on it either. Calling `requestResync()`
   * first, not after, means this client's own request id is recorded
   * (`#ownRequests`/`#seenResyncRequestIds`) before its own first
   * `#respondToResyncRequests()` call runs — a joiner never answers its
   * own request. One that starts again from persisted state (`controlState`, `restore`) reads first
   * and then decides (RSY-1, CTL-41): see `restore`.
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
    const profile = profileFor(options.profile ?? YJS_PARAGRAPHS_1, options.profiles);
    // Persisted state names the document's profile; resuming under another would read the
    // content wrongly, and for the creator announce a profile everyone rejects (PRF-6).
    const persisted = readPersisted(options.controlState);
    const persistedProfile = persisted?.state.profile;
    if (
      (options.creatorMemberId === memberId || persisted?.state.bootstrapped === true) &&
      persistedProfile !== undefined &&
      persistedProfile !== profile.id
    ) {
      throw new Error(
        `cannot resume ${documentId} as ${profile.id}: its persisted control state names ${persistedProfile} (SPECIFICATION.md PRF-6)`,
      );
    }
    // Persisted content goes in before the engine observes the document: it is neither an
    // edit to send nor text this client just wrote. Refused before anything is sent.
    const document = profile.createEmpty();
    if (options.restore !== undefined) {
      try {
        profile.applyUpdate(document, options.restore.state, REMOTE_ORIGIN);
      } catch (error) {
        throw new Error(
          `the restored state of ${documentId} does not decode under the profile ${profile.id}`,
          { cause: error },
        );
      }
    }
    const transport = await messenger.transportProfile?.();
    // Before the engine exists, so nothing is sent on a transport too small (TRN-23).
    assertLargeEnough(documentId, transport);
    const client = new DocumentEngine(
      documentId,
      memberId,
      messenger,
      onError,
      document,
      options,
      transport,
    );
    // Away for how long, since its last read that reached the messenger began (LIF-8): unknown
    // without a restore that says.
    let away: number | undefined;
    if (options.restore !== undefined) {
      client.#startFromRestored(options.restore.attribution);
      // A return (RSY-21): away longer than its transport keeps, or its document unbound meanwhile,
      // it may lack what members wrote then, which nothing shows until they write again. Its request
      // as it starts is the first of its return.
      const { readAt, rebound } = options.restore;
      const retention = options.transportRetentionMs;
      away = readAt === undefined ? undefined : Date.now() - readAt;
      if (rebound === true || (away !== undefined && retention !== undefined && away > retention)) {
        client.#beginReturn();
      }
    } else if (memberId === options.creatorMemberId && client.#bootstrapped) {
      // A device of the creator that starts from its bootstrapped control state without content is
      // bootstrapped (RSY-14) and may lack everything, which nothing shows until a member writes
      // again: it returns too (RSY-21), so its first request asks all.
      client.#beginReturn();
    }
    if (options.restore === undefined && persisted === undefined) {
      // A joiner asks as it joins, whatever the transport (RSY-1): before its first read, so that its
      // own request is known when that read brings it back.
      client.#askOnStart(false);
      await client.sync();
    } else {
      // An engine that starts again from what its application persisted reads first (CTL-41): what it
      // restored may bootstrap it only then. Not bootstrapped, it asks as a joiner; returning, it asks
      // all (RSY-21); bootstrapped, it makes a start request only after more than
      // START_REQUEST_AFTER_MS away, or not knowing how long, or holding a gap (RSY-1). These are
      // required, so switching the automatic requests off does not stop them (LOS-6).
      let failed: { readonly error: unknown } | undefined;
      client.#starting = true;
      try {
        await client.sync();
      } catch (error) {
        failed = { error };
      } finally {
        client.#starting = false;
      }
      if (
        !client.#bootstrapped ||
        client.#returning ||
        away === undefined ||
        away > START_REQUEST_AFTER_MS ||
        client.#detector.hasGaps
      ) {
        // Through the floor, as an automatic request: its first read may have answered someone.
        client.#askOnStart(true);
      }
      // What its first read held back of its restored content goes now (SND-8).
      client.#sendRestoredOnce();
      if (failed !== undefined) throw failed.error;
    }
    // Decisions of this device not known to be sent before a restart go out again now, unchanged —
    // merged again where they arrived, they change nothing (CTL-6, CTL-26). Not awaited: offline, it
    // may take as long as the outage.
    for (const [key, text] of client.#unsent) {
      client.#sendControlFrame(key, text).catch((error: unknown) => onError(error, "broadcast"));
    }
    return client;
  }

  /**
   * The one request a start makes (RSY-1): a joiner's, or a start request to all; a starting engine
   * holds no gap that rests, what its first read showed arises anew (LOS-26), and nothing repeats
   * the request but what repeats a joiner's (RSY-5). Not
   * waited for: it takes the slot and its id is known at once (RSY-3), but it may wait in the send
   * scheduler — for the floor, or for as long as a transport that refused a message as rate-limited
   * asked (SND-7) —, and the engine is its application's meanwhile. Its failure is no change of this
   * client's and is not reported as a dropped one (SND-10): a joiner asks again by itself, and
   * `syncHealth.resync` shows the slot.
   */
  #askOnStart(automatic: boolean): void {
    this.#requestResync(automatic).catch(() => {
      // see above
    });
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
   * for a send window, `retrying` after a failed send, or `needs-person` after a refusal only
   * the person can lift (TRN-20) — of a change, or, while the hold it begins lasts, of a request, an
   * answer or a report — with how many times the change has failed, when the next attempt is due,
   * and the failure's message. What a connection indicator should show for "my edits have
   * not gone out". Once the person acted, `flush()` sends at once. `reportOwed` says that a report is
   * still to go (SND-28): an application that waits for what is unsent before it quits waits for it.
   */
  get sendStatus(): SendStatus {
    return this.#scheduler.status;
  }

  /**
   * The report this client owes and has not yet sent, with what it carries again, or `undefined`
   * while it owes none (SND-11, SND-27, SND-28). An application that persists the content persists
   * this with it, on this device only, and gives it back as `restore.owedReport`; `onOwedReportChange`
   * says when it changes.
   */
  get owedReport(): OwedReport | undefined {
    const owed = this.#scheduler.owedReport;
    if (owed === undefined) {
      return undefined;
    }
    const carry = owed.carry;
    return carry === null
      ? {}
      : carry.kind === "edit"
        ? { update: carry.update }
        : { control: carry.text };
  }

  /**
   * Sends the report this client owes as soon as the floor permits, once nothing of its own waits,
   * instead of 10 seconds after its last message (SND-11, LIF-12): what an application calls before
   * its device sleeps. Resolves once the transport accepted the report, it was refused for good or
   * the engine was disposed; at once when none is owed. A report that could not go stays owed
   * (`owedReport`). `dispose()` sends it as well.
   */
  reportNow(): Promise<void> {
    return this.#scheduler.reportNow();
  }

  /**
   * Whether this client may hold content no other participant has (SPECIFICATION.md
   * SND-8, SND-10): a message of its own carrying content was dropped for good since the engine
   * started, or it started from restored content (`restore`), and no `resync()` has sent the
   * whole state since — every part of it, when it is too large for one message. Dropping ends the send
   * job only — the change stays in this document, and every later change builds on it, so an
   * application must not show the document as synchronised while this is true (SND-21). `resync()`
   * is the repair: it sends the whole state, once whatever caused the refusal is fixed. Held in
   * memory only; conservative — any dropped message that carried content counts.
   */
  get hasUndistributedChanges(): boolean {
    return this.#scheduler.droppedCount > this.#distributedThroughDrop;
  }

  /**
   * Whether this client has reason to think something is missing: its gaps (LOS-25) — updates the
   * CRDT holds across a missing one, a report whose state we have not reached, a creator's decision
   * we never saw —, each with the requests made for it and whether it rests (LOS-6, LOS-26). Each has
   * to have lasted an expected latency first, so a merely late message is not reported. Evidence,
   * never proof (`SyncHealth`).
   */
  get syncHealth(): SyncHealth {
    // Its times on the wall clock as it reads now, each as far from now as the engine measured
    // (SND-25): after the wall clock went back, none lies in the future of the clock its application reads.
    const clock = this.#steady;
    const suspicions = this.#suspicions().map((suspicion) => ({
      ...suspicion,
      since: clock.toWall(suspicion.since),
    }));
    const resync = this.#resyncGate.status();
    return {
      state: suspicions.length === 0 ? "ok" : "suspected",
      suspicions,
      resync: {
        ...resync,
        requestedAt: clock.toWall(resync.requestedAt),
        expiresAt: clock.toWall(resync.expiresAt),
      },
      incompleteAnswers: this.#detector.incompleteAnswers().map((answer) => ({
        ...answer,
        since: clock.toWall(answer.since),
      })),
      // What the application shows, and where it offers to ask again (RSY-5).
      // Only once no request of its own holds the slot: until the last attempt had its time it may
      // still bring the bootstrap, and a person's request would be coalesced into it (RSY-3).
      ...(this.#inBootstrap() &&
      this.#automaticBootstrapAttempts >= MAX_AUTOMATIC_BOOTSTRAP_ATTEMPTS &&
      !this.#requestWaiting &&
      this.#resyncGate.isFree
        ? { attemptsRanOut: true as const }
        : {}),
    };
  }

  /** The gaps `syncHealth` reports, a truncated history among them (LOS-19, LOS-25), its times on `#steady`. */
  #suspicions(): SyncSuspicion[] {
    return this.#detector.suspicions();
  }

  /**
   * Whether this client is bootstrapped (RSY-14): `none` before — it sends no control state and
   * states no control clock, and a device of the creator decides nothing but the close and its reason
   * (CTL-27), though it edits —; `bootstrapped` once it created the document, restored a state that
   * was bootstrapped, or merged an answer to its own request that carried control state — on a device
   * of the creator, only one of another of her devices. Changes are reported through
   * `onControlStandingChange`.
   */
  get controlStanding(): ControlStanding {
    return this.#bootstrapped ? { kind: "bootstrapped" } : { kind: "none" };
  }

  /** Reports a change of `controlStanding` (`onControlStandingChange`); `report: false` only notes it. */
  #noticeStanding(report = true): void {
    const standing = this.controlStanding;
    if (standing.kind === this.#standingKey) {
      return;
    }
    this.#standingKey = standing.kind;
    if (report) this.#onControlStandingChange?.(standing);
  }

  /**
   * Whether this client states its control clock and digest (RSY-16, SND-11): once it is
   * bootstrapped (RSY-14); `null` before, which asks for control state.
   */
  #statesControl(): boolean {
    return this.#bootstrapped;
  }

  /**
   * Whether this client is in a capacity conflict (CTL-32): it could not hold a `control` frame or a
   * snapshot of the creator for the targets or the bytes of control state (CTL-30), so it may lack a
   * decision — about itself, too. From then on it takes no new member or layer right, and refuses its own
   * edits as `read` does (`SendRefusedError` reason `capacity-conflict`), the creator's devices
   * included. Nothing ends it automatically: it is no convergence, but a state for a person to
   * resolve, by continuing in a new document. Persisted with the control state (`capacityConflict`).
   */
  get capacityConflict(): boolean {
    return this.#control.capacityConflict;
  }

  /** This device of the creator's tag (CTL-20); `undefined` for anyone else. */
  get deviceTag(): string | undefined {
    return this.#device;
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
   * `requestResync()` calls that carries control state has actually been applied (SPECIFICATION.md
   * RSY-14), whoever sent it — on a device of the creator, only one another device of the creator
   * sent —; content alone does not. After a restart, a non-creator's own restored
   * control state may do so instead (`controlState`, CTL-41), and a device of the creator is
   * bootstrapped at once when it restores a control state that was bootstrapped (CTL-26).
   * A joiner whom nobody holding control state ever answers stays `false` forever — an honest
   * limitation of a broadcast-only, history-less transport, not a bug to be papered
   * over. An application should show it as "waiting for the group", distinct from
   * "syncing" (which means "I have content and am sending my own edit").
   */
  get hasCompletedBootstrap(): boolean {
    return this.#bootstrapped;
  }

  /**
   * The last delivery this client has read, with a transport that offers `receiveSince`
   * (TRN-18); `undefined` without one. An application that persists the content persists this
   * with it, as `restore.cursor` (LIF-8).
   */
  get cursor(): DeliveryId | undefined {
    return this.#cursor;
  }

  /**
   * The epoch of the transport's window (TRN-19) this client compares its next read with, with a
   * transport that names one; `undefined` without. Read together with `cursor`, as they stand
   * after the same `sync()`: an application persists the two together, as `restore.instance` and
   * `restore.cursor` (LIF-8), and not while `syncHealth` holds *history truncated* evidence — the
   * epoch that showed it would read as the one the cursor was read under, and a restart would hide
   * the loss.
   */
  get instance(): string | undefined {
    return this.#instance;
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
    return this.#control.closed;
  }

  /**
   * Why the creator closed this document (CTL-23): one of `CLOSE_REASON_CODES`, an application's own
   * reason, named as an extension is (FRM-15), or any other string of 1 to 128 bytes — of a later
   * version, say; `undefined` while it is not closed or no reason was given. An application shows a
   * reason it does not know as a close without a known reason (VER-5). A register that arrives before
   * the close is held, but is shown only once the close holds.
   */
  get closeReason(): string | undefined {
    return this.#control.closed ? this.#control.closeReason : undefined;
  }

  /**
   * Every explicit `read`/`write` grant this client currently knows of. The
   * creator is implicit and not listed; a member absent from the map is revoked
   * (`revokedMembers`) or *unknown* — never named, or not yet heard about —, which
   * refuses its edits as `read` does (CTL-13).
   */
  get memberPermissions(): ReadonlyMap<MemberId, "read" | "write"> {
    return this.#control.members;
  }

  /**
   * The members whose permission the creator revoked (CTL-13, CTL-23): refused as a reader is, on
   * the document and on every layer. Not unknown, though both refuse: a revocation is the creator's
   * decision, which tells a member the creator removed from one it has not named yet (LIF-10).
   */
  get revokedMembers(): ReadonlySet<MemberId> {
    return this.#control.revoked;
  }

  /**
   * `"creator"` for the creator, the explicit grant if there is one, else `undefined` — unknown,
   * or revoked (`rightOf` tells them apart). With `layer`, the member's permission on that layer
   * (LAY-5): its right there if the creator set one, and otherwise its permission on the document;
   * a revoked member has none on any layer.
   */
  permissionOf(member: MemberId, layer?: string): Permission | undefined {
    const right = this.rightOf(member, layer);
    return right === "revoked" || right === "unknown" ? undefined : right;
  }

  /**
   * A member's right as CTL-13 applies it: `"creator"` for the creator; `"read"` or `"write"`;
   * `"revoked"` once the creator revoked the member's permission, which refuses its edits as
   * `read` does, on the document and on every layer, whatever right it holds there (LAY-5); or
   * `"unknown"` while no register names it — the creator has not named it, or this client has not
   * heard of it yet —, which refuses its edits as `read` does too once it is bootstrapped (CTL-13).
   * An application shows unknown apart from `read` and from revoked: it awaits the creator's
   * decision (LIF-10). With `layer`, the right there, or where the member inherits, its permission
   * on the document.
   */
  rightOf(member: MemberId, layer?: string): Permission | "revoked" | "unknown" {
    if (this.#creatorMemberId !== undefined && member === this.#creatorMemberId) {
      return "creator";
    }
    return rightIn(this.#control, member, layer) ?? "unknown";
  }

  /**
   * Where the channel's members and the control state this client holds differ (LIF-10):
   * `channelMembers` is the channel as the application's transport lists it now (TRN-17), which the
   * engine never asks for itself, and `removing` whom the application is removing from the channel
   * right now. `unnamed`: members in the channel that no register names, the creator aside, who may
   * only read (CTL-13); `notInChannel`: members whose register gives `read` or `write` and who are
   * not in the channel, a right without effect; `revokedInChannel`: members whose permission is
   * revoked and who are still in the channel, who still receive everything; `beingRemoved`: those of
   * them the application is removing, a removal under way. `undefined` while the control state is
   * not known — not bootstrapped (`controlStanding` `none`): everyone would look unnamed. An application shows each as an inconsistency — a removal
   * under way as that —, and changes neither the control state nor the channel without its person's
   * decision (LIF-10).
   */
  channelInconsistencies(
    channelMembers: Iterable<MemberId>,
    options: { readonly removing?: Iterable<MemberId> } = {},
  ): ChannelInconsistencies | undefined {
    const creator = this.#creatorMemberId;
    if (creator === undefined || !this.#bootstrapped) {
      return undefined;
    }
    return channelInconsistencies(this.#control, creator, channelMembers, options.removing);
  }

  /**
   * The rights the creator set on layers, by layer and then member (LAY-5): only where they
   * differ from a member's permission on the document, which applies everywhere else.
   */
  get layerRights(): ReadonlyMap<string, ReadonlyMap<MemberId, "read" | "write">> {
    return this.#control.layerRights;
  }

  /** The document's profile id (SPECIFICATION.md §5), fixed for its life. */
  get profile(): string {
    return this.#profile.id;
  }

  /**
   * The ids of the layers the document holds (SPECIFICATION.md §5.6), sorted: its top-level
   * shared types named by a layer id. The engine keeps and passes on every one of them (LAY-1);
   * an application that shows none of them should still tell the person they are there (LAY-2).
   */
  get layers(): readonly string[] {
    return [...this.document.share.keys()].filter((name) => isLayerId(name)).sort();
  }

  /**
   * This client's control state as a snapshot carries it (§7.5, RSY-8). A client that is not
   * bootstrapped, or is in a capacity conflict, sends none (RSY-8, CTL-32).
   */
  get controlState(): ControlSnapshot {
    const state = this.#control.state();
    return { profile: this.#profile.id, closed: state.closed, targets: state.targets };
  }

  /** This client's control clock: the greatest clock among the registers it holds (CTL-45). */
  get controlClock(): Clock {
    return this.#control.clock;
  }

  /**
   * The pace the creator set: the shortest interval between two messages of anyone (SND-15);
   * `undefined` for none.
   */
  get pace(): number | undefined {
    return this.#control.pace;
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
    // A transport that takes a cursor says itself whether anything slid out unseen (TRN-18); for
    // one that does not, LOS-8 still decides. One that names its bridge instance shows a restart
    // either way (TRN-19, LOS-9).
    const receiveSince = this.#messenger.receiveSince?.bind(this.#messenger);
    const after = this.#cursor;
    let deliveries: readonly Delivery[];
    let truncated = false;
    let restarted = false;
    try {
      if (receiveSince !== undefined) {
        const answer = await receiveSince(this.documentId, this.memberId, after);
        deliveries = answer.deliveries;
        truncated = answer.truncated;
      } else {
        deliveries = await this.#messenger.receive(this.documentId, this.memberId);
      }
      // After the read: a bridge that gives something up while it answers — an event it reads
      // from its messenger for this very answer, say — has a new epoch by then, and this read
      // shows it, the first one after a restart included (TRN-19, LOS-9).
      if (this.#messenger.instance !== undefined) {
        const instance = await this.#messenger.instance();
        restarted = this.#instance !== undefined && instance !== this.#instance;
        this.#instance = instance;
      }
    } catch (error) {
      this.#receiveFailed = true;
      throw error;
    }
    if (restarted) {
      this.#noticeTruncatedHistory();
    }
    if (receiveSince !== undefined) {
      this.#receiveFailed = false;
      // Each time the bridge says so from another cursor, something else slid out unseen; from the same
      // one again — after an empty truncated answer, say — it is the loss it told of before (LOS-19).
      const repeated =
        this.#historyTruncatedSince !== undefined &&
        this.#truncatedAfter !== undefined &&
        this.#truncatedAfter.cursor === after;
      if (truncated && !repeated) {
        this.#truncatedAfter = { cursor: after };
        this.#noticeTruncatedHistory();
      }
    } else if (this.#receiveFailed) {
      // A bridge that could not answer may have restarted, and a restarted one may offer old
      // deliveries again (BRG-17): an overlap with the previous answer then proves nothing, so
      // the first answer after a failure is treated as a truncated history (LOS-8).
      this.#receiveFailed = false;
      this.#noticeTruncatedHistory();
    }
    // Before anything of this read applies: an answer to a request kept no longer is one to a request
    // this engine did not make (RSY-12).
    this.#forgetOldOwnRequests();
    const applied: Delivery[] = [];
    // A resync request arrives through this same receive() stream as an ordinary
    // frame kind — collected here, answered by #respondToResyncRequests after
    // the loop.
    const incomingResyncRequests: IncomingResyncRequest[] = [];
    this.#reads += 1;
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
        const frameText = delivery.payload;
        const frame: Frame = decodeFrame(frameText, this.#extensionChecks);
        this.#checkFrameBelongsHere(frame);
        checkProfileReads(frame, this.#profile);
        if (this.#handleFrame(frame, delivery, applied, incomingResyncRequests)) {
          this.#tellExtensions(frame, delivery.sender);
        }
        // Any frame of the writer of a resting gap's CRDT client shows that the one who holds what it
        // lacks is there again, also under a new client after a start (LOS-2, LOS-26, LOS-27).
        if (!this.#isThisDevice(delivery.sender, frame)) {
          this.#detector.heardFrom(delivery.sender);
        }
        // Someone else is there now — not this device's own frame offered again (LOS-17): a bootstrap
        // whose attempts ran out asks once more on it, if that one did not answer its latest request
        // (RSY-5). On a device of the creator only another device of the creator counts.
        if (
          !this.#isThisDevice(delivery.sender, frame) &&
          (this.#creatorMemberId !== this.memberId || delivery.sender === this.memberId)
        ) {
          this.#heardAfterExpiry.set(delivery.sender, this.#steady.now());
        }
        if (
          delivery.sender === this.#creatorMemberId &&
          !this.#isThisDevice(delivery.sender, frame) &&
          (frame.kind === "control" ||
            frame.kind === "heartbeat" ||
            frame.kind === "resync-request") &&
          frame.controlClock !== null
        ) {
          this.#heardCreatorClockAt = this.#steady.now();
        }
      } catch (error) {
        // a corrupted/modified/misrouted/version-mismatched delivery must
        // not abort the rest of this batch — see DocumentEngineErrorHandler's
        // doc comment above for what happens instead. A rejection names its sender (FRM-7), so
        // the application can show whose frames it cannot read (VER-4).
        this.#onError(
          error instanceof FrameDecodeError ? error.from(delivery.sender) : error,
          "apply",
        );
      }
    }
    if (receiveSince !== undefined) {
      const last = deliveries[deliveries.length - 1];
      if (last !== undefined) {
        this.#cursor = last.id;
      }
      this.#forgetOldestSeen();
    } else {
      this.#noticeTruncatedWindow(deliveries);
      this.#forgetWhatReceiveNoLongerOffers(deliveries);
    }
    this.#considerRestoredBootstrap(receiveSince !== undefined && !truncated);
    this.#detector.observe();
    this.#endTruncationNobodyAnswersTheCreator();
    this.#endReturnAfterAskingAll();
    await this.#considerAutomaticResync().catch((error: unknown) =>
      this.#onError(error, "broadcast"),
    );
    await this.#respondToResyncRequests(this.#queueResyncRequests(incomingResyncRequests));
    // Restored content goes after the request a start decides on, once its first read is done (RSY-1).
    if (!this.#starting) this.#sendRestoredOnce();
    return applied;
  }

  /**
   * Handles one frame `receive()` delivered and decoded: applies it, or collects it to answer
   * later. `false` for an answer this client does not accept (RSY-6), which changes nothing; a
   * frame it rejects throws.
   */
  #handleFrame(
    frame: Frame,
    delivery: Delivery,
    applied: Delivery[],
    incomingResyncRequests: IncomingResyncRequest[],
  ): boolean {
    if (frame.kind === "heartbeat") {
      // A report (§9.3): what its sender holds, and its last edit again. That update is applied
      // first, as an edit's is — whatever the sender's permission here (CTL-7), also after the close
      // (LIF-6), its profile having read it whole (FRM-6) —; only then is the report judged, against
      // what this client holds with it (SND-27, LOS-4). Its own report coming back carries nothing
      // new to it.
      const ownStream = this.#isOwnStream(delivery.sender, frame.stream);
      if (frame.update !== undefined && !ownStream) {
        this.#applyCarriedUpdate(frame.update, delivery, applied);
      }
      if (!ownStream) {
        this.#detector.heardReport(delivery.sender, frame);
      }
      return true;
    }
    if (frame.kind === "resync-request") {
      // Nothing to apply — carries no document content (SPECIFICATION.md §8.2).
      incomingResyncRequests.push({
        id: frame.requestId,
        requester: delivery.sender,
        controlClock: frame.controlClock,
        controlDigest: frame.controlDigest,
        force: frame.force,
        all: frame.all,
        stateVector: frame.stateVector,
        stateDigest: frame.stateDigest,
        stream: frame.stream,
        sequence: frame.sequence,
      });
      // What it holds, a report like a heartbeat's (LOS-13) — but not this engine's own request.
      if (
        !this.#ownRequests.has(frame.requestId) &&
        !this.#isOwnStream(delivery.sender, frame.stream)
      ) {
        this.#detector.heardReport(delivery.sender, frame);
        this.#reportAgainIfMisleading(frame.stateVector, frame.stateDigest);
        // Another's request to all, which a request of this client's own may be let go for (RSY-22) —
        // not one its first read after a start brings, which may have waited there for long.
        if (frame.all && !this.#starting) this.#heardRequestToAll(delivery.sender, frame);
      }
      return true;
    }
    if (frame.kind === "decline") {
      // Information, never state (SPECIFICATION.md DCL-3).
      this.#reportDecline(delivery.sender, frame);
      return true;
    }
    if (frame.kind === "control") {
      // What the frame states of its device's control clock and digest is no evidence (LOS-10, LOS-12): a
      // frame carries no number, and a late one cannot be told from a newer one at the same clock. The
      // device's next report states them (SND-11).
      this.#applyControlFrame(frame, delivery.sender);
      this.#followPace();
      this.#notifyControlStateChange();
      return true;
    }
    if (frame.kind === "edit") {
      // An edit frame is one member's batch, so its updates come from one Yjs client:
      // that is how a gap the CRDT names by client id gets a member to blame (LOS-2). One of this
      // engine's own client is its own edit coming back; one of another device of its member counts
      // like anyone's. How far it carries its writer's stream raises the position of a gap of it
      // (LOS-25, LOS-26).
      const clients = this.#profile.updateClientIds(frame.update);
      const ownEcho =
        delivery.sender === this.memberId &&
        clients.length > 0 &&
        clients.every((client) => client === this.document.clientID);
      if (!ownEcho) {
        this.#detector.heardClocks(updateClocksOf(this.#profile)(frame.update));
        if (clients.length === 1) {
          this.#detector.learnClient(clients[0] as number, delivery.sender);
        }
        // A writer that missed the close hears it again from a device of the creator (LIF-11).
        this.#resendCloseTo(delivery.sender);
      }
    }
    // A close stops new edits at their sender, not in delivery (SPECIFICATION.md
    // LIF-6): an edit sent before the close may arrive after it and is applied like
    // any other, so every receiver ends with the same content whichever came first.
    // An answer to another's request this engine let a request of its own go for is noted once it
    // applied it (RSY-20, RSY-22).
    const adopted = frame.kind === "resync-response" && this.#adoptedRequests.has(frame.respondsTo);
    if (frame.kind === "resync-response" && !adopted) {
      // Someone answered this request: a member waiting for its turn to answer it falls silent where
      // the answer holds what it would give, whether or not this engine accepts the answer — compared
      // with what it holds before anything of it applies (RSY-20).
      this.#heardAnswerTo(frame, delivery.sender);
    }
    // A response counts if the creator sent it, or if it answers one of this engine's own requests,
    // whoever sent it (RSY-12).
    if (
      frame.kind === "resync-response" &&
      !this.#mayAcceptResyncResponse(delivery.sender, frame)
    ) {
      // Nothing of it is applied; its sender's stream is heard all the same (LOS-12), and its last piece
      // still states what its sender holds, a report like a heartbeat, which any member may send
      // (LOS-13).
      if (!this.#isOwnStream(delivery.sender, frame.stream)) {
        this.#detector.heardStream(delivery.sender, frame.stream, frame.sequence);
      }
      if (
        frame.stateVector !== null &&
        frame.stateDigest !== null &&
        !this.#isOwnStream(delivery.sender, frame.stream)
      ) {
        this.#detector.heardReport(
          delivery.sender,
          this.#answerReport(frame, frame.stateVector, frame.stateDigest),
        );
      }
      return false;
    }
    // The creator confirms the document's profile in its snapshot, and content of another
    // profile must never be applied — none of this response is (SPECIFICATION.md CTL-10).
    // A snapshot counts where the answer does (RSY-12): every one the creator sent, and anyone's in
    // an answer to this engine's own request. It is merged like any other (CTL-25), and its update
    // applies, as anyone's edit could (RSY-13).
    // One of another profile, or one that names the creator, rejects the whole answer, so nothing of
    // it is merged and it bootstraps nothing (CTL-10, CTL-4, FRM-6).
    if (frame.kind === "resync-response" && frame.control !== null) {
      if (frame.control.profile !== this.#profile.id) {
        throw new FrameDecodeError(
          "profile-mismatch",
          `the snapshot names the profile ${JSON.stringify(frame.control.profile)}, this document is ${this.#profile.id}`,
        );
      }
      // The one snapshot rule the decoder cannot check, since only the engine knows who
      // the creator is — checked here, before anything of the frame is applied (FRM-6).
      if (
        this.#creatorMemberId !== undefined &&
        Object.keys(frame.control.targets).some(
          (target) => memberOf(target) === this.#creatorMemberId,
        )
      ) {
        throw new FrameDecodeError(
          "invalid-field",
          "the snapshot names the creator in a register; its role is fixed (CTL-4)",
        );
      }
    }
    // A resync-response answering one of THIS client's own requests
    // is unattributed (`null`), not delivery.sender's
    // (SPECIFICATION.md RSY-13, ATR-2).
    // For a true bootstrap, #considerBootstrapOverlay below replaces
    // this wholesale via attribution.restore() when it adopts an
    // overlay; if it never does (malformed overlay, one already adopted),
    // the honest fallback is "unattributed", never a
    // confident misattribution to whoever happened to answer. For a
    // partial gap-heal, unattributed IS the final answer — no overlay
    // is ever adopted for that case at all.
    // The same holds for an answer to someone else's request: its sender sent it but did
    // not necessarily write it (SPECIFICATION.md RSY-13), so whatever it adds here is
    // unattributed too — only an answer to our own request can bring an overlay.
    const isOwnResyncResponse =
      frame.kind === "resync-response" && this.#ownRequests.has(frame.respondsTo);
    // An answer to another's request to all this client let a request of its own go for (RSY-22): taken
    // as an answer to its own is, its pieces counted with them (RSY-12, LOS-14), but it bootstraps
    // nothing, brings no overlay and frees no slot (RSY-14, RSY-15, RSY-4).
    const isAcceptedResyncResponse =
      isOwnResyncResponse ||
      (frame.kind === "resync-response" && this.#adoptedRequests.has(frame.respondsTo));
    if (
      frame.kind === "resync-response" &&
      frame.respondsTo === this.#latestRequestId &&
      !this.#latestRequestExpired(this.#steady.now())
    ) {
      // Answered before it expired, by this sender: a later frame of anyone else is a sign that
      // someone came back (RSY-5).
      this.#answeredLatestBy.add(delivery.sender);
    }
    this.#attributionAuthor = frame.kind === "resync-response" ? null : delivery.sender;
    this.#applyingRemote = true;
    // An answer applied owes no report, whatever it changed: reading costs none (SND-11).
    try {
      this.#profile.applyUpdate(this.document, frame.update, REMOTE_ORIGIN);
      this.#boundPending();
      applied.push(delivery);
      if (frame.kind === "resync-response") {
        // How far it carries each writer's stream raises the position of a gap of it (LOS-25).
        this.#detector.heardClocks(updateClocksOf(this.#profile)(frame.update));
        if (frame.control !== null) {
          this.#applyControlSnapshot(frame.control);
        }
        // A piece applied, counted when it answers this client's own request; the last one states
        // what the responder held as it answered, which this client holds once every piece is here
        // (LOS-4, LOS-12, LOS-14). The control state it carried, merged, covers what a device of the
        // creator's stream stated up to the answer's number once the answer is whole (LOS-12, LOS-18).
        if (!this.#isOwnStream(delivery.sender, frame.stream)) {
          const report =
            frame.stateVector === null || frame.stateDigest === null
              ? null
              : this.#answerReport(frame, frame.stateVector, frame.stateDigest);
          this.#detector.heardAnswerPiece(delivery.sender, {
            stream: frame.stream,
            sequence: frame.sequence,
            piece: frame.piece,
            pieces: frame.pieces,
            report,
            own: isAcceptedResyncResponse,
            request: frame.respondsTo,
            control:
              frame.control === null
                ? null
                : {
                    clock: controlClockOf(frame.control),
                    digest: registerStateDigest(frame.control),
                  },
          });
        }
        // Taken in place of an answer to its own, it holds what this engine would give that request
        // where this engine now holds no more than it, with what the request stated (RSY-20, RSY-22).
        if (adopted) this.#heardAnswerTo(frame, delivery.sender);
        const ownsControl = this.#creatorMemberId === this.memberId;
        // A device is bootstrapped by the first answer to its own request that carries control state
        // (RSY-12, RSY-14), also one whose merge led into a capacity conflict, which it then shows
        // (CTL-32); content alone does not, nor an answer to someone else. A device of the creator is
        // bootstrapped only by the creator's own state — another device of the creator's answer —; a
        // member's it merges as any answer (CTL-25), but it bootstraps nothing (CTL-27). A truncated
        // history ends with such an answer, never with content alone (LOS-19).
        if (frame.control !== null && isOwnResyncResponse) {
          // Whoever sent it, the truncated history it answered is gone — where it answers a request
          // sent with `force` after that history was last found truncated: one sent before, also one
          // sent with `force` for an earlier truncation, standing still or ended, holds only what its
          // responder held since that request's vector, not what the window dropped (LOS-19).
          if (
            this.#historyTruncatedSince !== undefined &&
            this.#ownRequests.forcedFor(frame.respondsTo) === this.#truncations
          ) {
            this.#historyTruncatedSince = undefined;
          }
          if (!ownsControl || delivery.sender === this.memberId) {
            this.#completeBootstrap(registerStateDigest(frame.control));
          }
        }
        // The first overlay of an answer to a request made while it held nothing stands (RSY-15,
        // ATR-1): attribution is the content's, so on a device of the creator any answer brings it.
        if (
          isOwnResyncResponse &&
          (ownsControl || frame.control !== null) &&
          this.#ownRequests.isBootstrap(frame.respondsTo)
        ) {
          this.#considerBootstrapOverlay(frame.attribution);
        }
        if (isOwnResyncResponse && !(this.#lastRequestAll && this.#inBootstrap())) {
          // Answered: the request no longer holds the slot (RSY-4). A request to all made in the
          // bootstrap keeps it while an answer leaves the bootstrap going on — content alone —, since
          // the members' turns spread over the whole window (RSY-20, RSY-21).
          this.#resyncGate.answered();
        }
      }
    } finally {
      this.#applyingRemote = false;
      this.#attributionAuthor = this.memberId;
    }
    return true;
  }

  /**
   * Applies the update a report carries again (SND-27) as an `edit` frame's is applied: credited to
   * its sender, who wrote it, with no permission checked (CTL-7) and after a close too (LIF-6). It
   * teaches whose CRDT client it is, as an edit does (LOS-2).
   */
  #applyCarriedUpdate(update: Uint8Array, delivery: Delivery, applied: Delivery[]): void {
    const clients = this.#profile.updateClientIds(update);
    if (clients.length === 1 && clients[0] !== this.document.clientID) {
      this.#detector.learnClient(clients[0] as number, delivery.sender);
    }
    // How far it carries its writer's stream raises the position of a gap of it (LOS-25, LOS-26).
    this.#detector.heardClocks(updateClocksOf(this.#profile)(update));
    this.#attributionAuthor = delivery.sender;
    this.#applyingRemote = true;
    try {
      this.#profile.applyUpdate(this.document, update, REMOTE_ORIGIN);
      this.#boundPending();
      applied.push(delivery);
    } finally {
      this.#applyingRemote = false;
      this.#attributionAuthor = this.memberId;
    }
  }

  /** This client's state digest (LOS-12): of what it deleted, which its state vector does not show. */
  #stateDigest(): string {
    this.#stateDigestCache ??= digestOf(deletionsOf(this.#profile)(this.document));
    return this.#stateDigestCache;
  }

  /**
   * The digest of what this client deleted of the items `stateVector` counts (LOS-12): of all it
   * deleted when the vector is its own, of the part within it when this client holds more, and
   * `undefined` when it lacks an insertion the vector counts — the vectors show that first — or its
   * profile cannot restrict its deletions to a vector. Throws on bytes that are not a state vector.
   */
  #stateDigestWithin(stateVector: Uint8Array): string | undefined {
    if (this.#profile.lacksUpdatesOf(this.document, stateVector)) {
      return undefined;
    }
    if (!this.#profile.hasUpdatesSince(this.document, stateVector)) {
      return this.#stateDigest();
    }
    const within = deletionsWithinOf(this.#profile);
    if (within === undefined) {
      return undefined;
    }
    const key = bytesToBase64(stateVector);
    let digest = this.#stateDigestWithinCache.get(key);
    if (digest === undefined) {
      digest = digestOf(within(this.document, stateVector));
      if (this.#stateDigestWithinCache.size >= 64) {
        this.#stateDigestWithinCache.clear();
      }
      this.#stateDigestWithinCache.set(key, digest);
    }
    return digest;
  }

  /** What an answer's last piece states of its responder: a report (LOS-13); answers state no control clock. */
  #answerReport(
    frame: { readonly stream: string; readonly sequence: number },
    stateVector: Uint8Array,
    stateDigest: string,
  ): StateReport {
    return {
      stream: frame.stream,
      sequence: frame.sequence,
      stateVector,
      stateDigest,
      controlClock: null,
      controlDigest: null,
    };
  }

  /**
   * A request stated exactly what this client holds, and this client's latest report states
   * deletions within its vector other than it holds now — ones it received since by ordinary
   * edits: to the requester, which holds the same, that report shows a difference in digests no
   * answer can end, since nobody has anything to give it. A report at once, a newer one of this
   * stream, ends it (SND-24, LOS-18).
   */
  #reportAgainIfMisleading(stateVector: Uint8Array, stateDigest: string): void {
    const last = this.#lastReport;
    if (
      last === undefined ||
      stateDigest !== this.#stateDigest() ||
      this.#profile.hasUpdatesSince(this.document, stateVector) ||
      this.#profile.lacksUpdatesOf(this.document, stateVector)
    ) {
      return;
    }
    const within = this.#stateDigestWithin(last.stateVector);
    if (within !== undefined && within !== last.stateDigest) {
      this.#scheduler.oweReport({ now: true });
    }
  }

  /** Whether a report comes from this engine's own stream: its own frame offered again (LOS-17). */
  #isOwnStream(sender: MemberId, stream: string): boolean {
    return sender === this.memberId && stream === this.#stream;
  }

  /**
   * Whether a frame is this device's own, offered again (LOS-17): of its own stream, under its own
   * device tag, or an edit of its own CRDT client alone.
   */
  #isThisDevice(sender: MemberId, frame: Frame): boolean {
    if (sender !== this.memberId) return false;
    if ("stream" in frame) return frame.stream === this.#stream;
    if (frame.kind === "control") return frame.device === this.#device;
    if (frame.kind === "edit") {
      const clients = this.#profile.updateClientIds(frame.update);
      return clients.length > 0 && clients.every((client) => client === this.document.clientID);
    }
    return false;
  }

  /**
   * A device of the creator that holds the document closed sends its close again to a participant
   * that edits it (LIF-11): one that lost the close, its repeat and the report after them (SND-27)
   * writes on, and no edit shows a close it missed. A `control` frame under this device's tag (CTL-20) with
   * the close, the register on `close-reason` it holds, and its control clock and digest once it is
   * bootstrapped (RSY-14) — no decision, its own clock not raised, nothing persisted unsent (CTL-26);
   * merged again where it arrived, it changes nothing (CTL-6). A tag not yet persisted is persisted
   * first, as for a decision, so that a restart goes on under the tag its frames carried; when the
   * application cannot persist, nothing is sent (CTL-20, CTL-26). At most once per writer in
   * CLOSE_RESEND_SPACING_MS, retried as a control frame is (SND-20), and at most once per read: the one
   * sent reaches every writer the read showed, and counts for each. None for the edits the first read
   * after a start brings: they are what was written before, much of it before the close, and a writer
   * that writes on shows in a later read. A repeat, it begins no phase of this device's sending and owes
   * no report, which would send it a third time (SND-11, SND-27).
   */
  #resendCloseTo(writer: MemberId): void {
    if (this.#creatorMemberId !== this.memberId || !this.#control.closed || this.#reads <= 1) {
      return;
    }
    const now = this.#steady.now();
    const last = this.#closeResentTo.get(writer);
    if (last !== undefined && now - last < CLOSE_RESEND_SPACING_MS) {
      return;
    }
    if (this.#closeResentInRead === this.#reads) {
      this.#noteCloseResentTo(writer, now);
      return;
    }
    this.#device ??= newDeviceTag();
    if (!this.#devicePersisted) {
      try {
        this.#notifyControlStateChange();
      } catch (error) {
        this.#onError(error, "broadcast");
        return;
      }
    }
    this.#noteCloseResentTo(writer, now);
    this.#closeResentInRead = this.#reads;
    const reason = this.#control.registerOf(CLOSE_REASON);
    const text = encodeControlFrame({
      documentId: this.documentId,
      device: this.#device,
      targets: reason === undefined ? {} : { [CLOSE_REASON]: reason },
      closed: true,
      controlClock: this.#bootstrapped ? this.#control.clock : null,
      controlDigest: this.#bootstrapped ? this.#control.digest : null,
    });
    this.#scheduler
      .submit(() => this.#messenger.send(this.documentId, this.memberId, text), { retry: true })
      .then(
        (id) => this.#markOwnSend(id),
        (error: unknown) => this.#onError(error, "broadcast"),
      );
  }

  /** `writer` was sent the close again at `now` (LIF-11), the writer least recently sent it forgotten beyond the bound. */
  #noteCloseResentTo(writer: MemberId, now: number): void {
    this.#closeResentTo.delete(writer);
    this.#closeResentTo.set(writer, now);
    for (const oldest of this.#closeResentTo.keys()) {
      if (this.#closeResentTo.size <= MAX_REMEMBERED_REQUESTS) break;
      this.#closeResentTo.delete(oldest);
    }
  }

  /**
   * The number of this engine's next report in its stream (LOS-13). One that would run past a
   * uint32 begins a new stream instead, as a restart does.
   */
  #nextSequence(): number {
    if (this.#sequence >= 0xffffffff) {
      this.#stream = newRandomId();
      this.#sequence = 0;
    }
    this.#sequence += 1;
    return this.#sequence;
  }

  /** `state`, as this engine's latest report states it (LOS-13): what a later request is held against. */
  #reporting<T extends { readonly stateVector: Uint8Array; readonly stateDigest: string }>(
    state: T,
  ): T {
    this.#lastReport = state;
    return state;
  }

  /** What this client holds, as an answer's last piece states it (RSY-18). */
  #ownState(): { readonly stateVector: Uint8Array; readonly stateDigest: string } {
    return {
      stateVector: this.#profile.encodeStateVector(this.document),
      stateDigest: this.#stateDigest(),
    };
  }

  /** Tells each extension this client implements what a frame it accepted carried of it (FRM-16). */
  #tellExtensions(frame: Frame, sender: MemberId): void {
    if (frame.extensions === undefined) {
      return;
    }
    for (const extension of this.#extensions) {
      if (Object.hasOwn(frame.extensions, extension.name)) {
        extension.receive?.(frame.extensions[extension.name], { kind: frame.kind, sender });
      }
    }
  }

  /**
   * After the first read of a non-creator restored with control state of an earlier bootstrap:
   * that state bootstraps it when the read went on from the persisted cursor through
   * `receiveSince`, was not truncated, and showed no other evidence of a truncated history (CTL-41).
   * Otherwise it waits for an answer, as on a first join. Its own request (RSY-1) stays outstanding
   * either way.
   */
  #considerRestoredBootstrap(readOnWithoutTruncation: boolean): void {
    if (!this.#restoredBootstrapPending) {
      return;
    }
    this.#restoredBootstrapPending = false;
    if (
      readOnWithoutTruncation &&
      this.#historyTruncatedSince === undefined &&
      !this.#bootstrapped
    ) {
      this.#bootstrapped = true;
      this.#notifyControlStateChange();
    }
  }

  /** Attributes restored content and marks it undistributed until it has been sent whole (`restore`). */
  #startFromRestored(attribution: AttributionSnapshot | undefined): void {
    if (attribution !== undefined) {
      this.attribution.restore(attribution);
    } else {
      const length = projectionOf(this.#profile).text(this.document).length;
      if (length > 0) {
        this.attribution.recordInsert(0, length, null);
      }
    }
    this.#distributedThroughDrop = -1;
    this.#restoredUnsent = true;
  }

  /**
   * Sends restored content whole, once, as soon as this client may edit (SND-8, CTL-13). Not
   * awaited: a large document goes out over several permitted slots, and an attempt the transport
   * refuses for now is retried (`resync()`, SND-7). One refused for good — whole, or one of its
   * pieces — is reported here, once, since `resync()` tells only its caller, and the mark stays
   * until a `resync()` succeeds.
   */
  #sendRestoredOnce(): void {
    if (!this.#restoredUnsent) {
      return;
    }
    try {
      this.#assertMayEdit();
    } catch {
      return; // not yet, or not at all: the content stays marked undistributed
    }
    this.#restoredUnsent = false;
    this.resync().catch((error: unknown) =>
      this.#onError(this.#blameProfileFor(error), "broadcast"),
    );
  }

  /**
   * Adds the requests heard in this `sync()` to those still to be answered and returns all of
   * them in the order they are served (RSY-19): requesters in turn — the one answered last at the
   * end —, each requester's oldest first. A requester keeps at most four, by request id: several
   * devices of one member may each have one outstanding (RSY-3, RSY-6); a fifth replaces its
   * oldest, keeping the requester's place, so one that repeats itself pushes nobody back. At most
   * `MAX_PENDING_REQUESTS` in all, the oldest dropped first, none heard longer ago than
   * `PENDING_REQUEST_TTL_MS` — one this engine answers only at its turn, none whose turn lies
   * longer ago (RSY-20).
   *
   * Whether and when this engine may answer a request is fixed when it is first heard (RSY-6,
   * RSY-20): at once from a device of the creator and from another device of the requester's own
   * member; from anyone else only when it asks all, at a turn derived from its `requestId` and this
   * engine's stream, so a copy offered again keeps its turn while the engine runs.
   */
  #queueResyncRequests(heard: readonly IncomingResyncRequest[]): PendingResyncRequest[] {
    const now = this.#steady.now();
    for (const request of heard) {
      let kept = this.#pendingResyncRequests.get(request.requester) ?? [];
      if (kept.some((other) => other.id === request.id)) {
        continue; // a copy of one already kept (RSY-16)
      }
      // Of each requesting stream only its latest request counts (RSY-9): one numbered below another
      // of its stream heard before is let go, and a later one lets go what this engine keeps of the
      // stream's earlier ones. Its requester has asked again since, or will, if it still lacks something.
      const stream = `${request.requester}\n${request.stream}`;
      const latest = this.#latestRequestOf.get(stream);
      if (latest !== undefined && request.sequence < latest) {
        this.#seenResyncRequestIds.add(request.id);
        continue;
      }
      this.#latestRequestOf.delete(stream);
      this.#latestRequestOf.set(stream, request.sequence);
      for (const oldest of this.#latestRequestOf.keys()) {
        if (this.#latestRequestOf.size <= MAX_REMEMBERED_REQUESTS) break;
        this.#latestRequestOf.delete(oldest);
      }
      // The requester keeps its place in the order (RSY-19).
      kept = kept.filter((other) => {
        const earlier = other.stream === request.stream && other.sequence < request.sequence;
        if (earlier) this.#seenResyncRequestIds.add(other.id);
        return !earlier;
      });
      const turn = answerTurn({
        self: this.memberId,
        creator: this.#creatorMemberId,
        requester: request.requester,
        ownRequest: this.#ownRequests.has(request.id),
        all: request.all,
        requestId: request.id,
        stream: this.#stream,
        heardAt: now,
        expectedLatencyMs: this.#syncPolicy.expectedLatencyMs,
      });
      const next = [...kept, { ...request, heardAt: now, turn }].slice(-MAX_REQUESTS_PER_REQUESTER);
      this.#pendingResyncRequests.set(request.requester, next);
    }
    for (const [requester, kept] of this.#pendingResyncRequests) {
      const fresh = kept.filter(
        (request) =>
          now - (request.turn.kind === "turn" ? request.turn.at : request.heardAt) <=
          PENDING_REQUEST_TTL_MS,
      );
      if (fresh.length === 0) {
        this.#pendingResyncRequests.delete(requester);
      } else {
        this.#pendingResyncRequests.set(requester, fresh);
      }
    }
    let total = [...this.#pendingResyncRequests.values()].reduce(
      (sum, kept) => sum + kept.length,
      0,
    );
    while (total > MAX_PENDING_REQUESTS) {
      let oldest: PendingResyncRequest | undefined;
      for (const kept of this.#pendingResyncRequests.values()) {
        const first = kept[0];
        if (first !== undefined && (oldest === undefined || first.heardAt < oldest.heardAt))
          oldest = first;
      }
      if (oldest === undefined) break;
      this.#forgetPendingRequest(oldest, false);
      total -= 1;
    }
    return [...this.#pendingResyncRequests.values()].flat();
  }

  /**
   * Lets a kept request go (RSY-9, RSY-19). `served`: it was answered, so its requester moves to
   * the end of the order, and the next answer goes to the requester heard longest ago.
   */
  #forgetPendingRequest(request: PendingResyncRequest, served: boolean): void {
    const kept = this.#pendingResyncRequests.get(request.requester);
    if (kept === undefined) {
      return;
    }
    const rest = kept.filter((other) => other.id !== request.id);
    this.#pendingResyncRequests.delete(request.requester);
    if (rest.length > 0) {
      if (served) {
        this.#pendingResyncRequests.set(request.requester, rest);
      } else {
        // Not served: the requester keeps its place.
        const order = [...this.#pendingResyncRequests];
        this.#pendingResyncRequests.clear();
        this.#pendingResyncRequests.set(request.requester, rest);
        for (const [requester, others] of order) this.#pendingResyncRequests.set(requester, others);
      }
    }
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
    if (truncated) {
      this.#noticeTruncatedHistory();
    }
    return truncated;
  }

  /**
   * *History truncated* evidence (LOS-8, LOS-9, LOS-23): each time it is noticed anew it is numbered,
   * also while the evidence stands, so that only an answer to a request sent with `force` after it was
   * last noticed ends it (LOS-19) — what slid out the second time, an answer taken before cannot hold.
   * The first time stands, as it is shown and waited for.
   */
  #noticeTruncatedHistory(): void {
    const now = this.#steady.now();
    this.#historyTruncatedSince ??= now;
    this.#lastTruncationAt = now;
    this.#truncations += 1;
  }

  /**
   * The creator's *history truncated* evidence ends when a request to all (RSY-21) it sent after the
   * history was last found truncated expired unanswered (SPECIFICATION.md LOS-20) — `lastRequestAt` is
   * when the latest went out —: only such a request reaches the members, and one sent before a later
   * truncated history asked nobody for what slid out then.
   * A member answers the creator only when it holds something the creator lacks (RSY-6, RSY-17),
   * so silence means either nothing to recover or nobody online to recover it from — and without
   * this the creator would warn for ever after every bridge hiccup. Everyone else waits for the
   * creator's answer, which it must give.
   */
  #endTruncationNobodyAnswersTheCreator(): void {
    if (this.#historyTruncatedSince === undefined || this.memberId !== this.#creatorMemberId) {
      return;
    }
    const status = this.#resyncGate.status();
    if (
      status.state === "idle" &&
      status.lastOutcome === "unanswered" &&
      this.#lastRequestAll &&
      (this.#resyncGate.lastRequestAt ?? Number.NEGATIVE_INFINITY) >= this.#lastTruncationAt
    ) {
      this.#historyTruncatedSince = undefined;
    }
  }

  /**
   * Forgets the requests of this client's own, and those of others it adopted (RSY-22), that went out
   * longer ago than RSY-12 keeps them and have no answer still arriving in pieces (LOS-14), and the
   * oldest beyond the count (Appendix B). An answer to one it forgot is one to a request it did not
   * make; a copy of one stays among the seen request ids, bounded as those are, and is not answered
   * (RSY-6).
   */
  #forgetOldOwnRequests(): void {
    const underWay = this.#detector.requestsUnderWay();
    this.#ownRequests.prune(this.#steady.now(), (id) => underWay.has(id));
    this.#adoptedRequests.prune(this.#steady.now(), (id) => underWay.has(id));
  }

  /** Keeps another's request to all, as first heard, for RSY-22: a copy offered again keeps its time. */
  #heardRequestToAll(requester: MemberId, frame: ResyncRequestFrame): void {
    if (this.#heardRequestsToAll.some((heard) => heard.id === frame.requestId)) return;
    this.#heardRequestsToAll.push({
      id: frame.requestId,
      requester,
      controlClock: frame.controlClock,
      controlDigest: frame.controlDigest,
      force: frame.force,
      all: frame.all,
      stateVector: frame.stateVector,
      stateDigest: frame.stateDigest,
      stream: frame.stream,
      sequence: frame.sequence,
      heardAt: this.#steady.now(),
      read: this.#reads,
    });
    if (this.#heardRequestsToAll.length > MAX_HEARD_REQUESTS_TO_ALL)
      this.#heardRequestsToAll.shift();
  }

  /**
   * Another's request to all, heard within its expiry, that reaches no further than a request of this
   * client's own would on the streams of `gaps` (RSY-22), so that its answers bring what this client
   * lacks there: on a CRDT client's stream this client holds at least what its state vector counts of
   * that client, on every other its whole state vector, and of deletions it holds less or the same
   * digest (LOS-12); its control clock is `null`, below this client's, or this client's with the same
   * digest (LOS-24). A truncated history is let go for none: only an answer to its own request shows
   * that nothing was lost (LOS-19).
   */
  #requestReachingNoFurther(gaps: readonly GapKey[], now: number): HeardRequestToAll | undefined {
    if (gaps.includes("truncated")) return undefined;
    const ahead = clientsAheadOf(this.#profile);
    return this.#heardRequestsToAll.find((heard) => {
      if (now - heard.heardAt > this.#resyncExpiryMs(true) || this.#adoptedRequests.has(heard.id))
        return false;
      if (heard.controlClock !== null) {
        const order = compareClocks(heard.controlClock, this.#control.clock);
        if (order > 0 || (order === 0 && heard.controlDigest !== this.#control.digest))
          return false;
      }
      try {
        const further = ahead(this.document, heard.stateVector);
        const less = this.#profile.hasUpdatesSince(this.document, heard.stateVector);
        return gaps.every((key) => {
          if (key.startsWith("content:")) return !further.has(Number(key.slice("content:".length)));
          if (key.startsWith("deletions:"))
            return further.size === 0 && (less || heard.stateDigest === this.#stateDigest());
          return further.size === 0;
        });
      } catch {
        return false; // a state vector the profile cannot read reaches nowhere this client can tell
      }
    });
  }

  /** Records a delivery id this engine's own send got, so its echo is not processed. */
  #markOwnSend(id: DeliveryId): void {
    this.#seenDeliveryIds.add(id);
    this.#ownUnechoed.set(id, this.#steady.now());
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
    const now = this.#steady.now();
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
      if (!this.#ownRequests.has(id)) {
        this.#seenResyncRequestIds.delete(id);
      }
    }
  }

  /**
   * With a cursor, `receive` offers nothing twice but after a restart (TRN-18), so the memory of
   * processed deliveries only needs a bound: the oldest go first, this engine's own unechoed sends
   * last, and the request ids as without a cursor.
   */
  #forgetOldestSeen(): void {
    for (const id of this.#seenDeliveryIds) {
      if (this.#seenDeliveryIds.size <= MAX_REMEMBERED_DELIVERIES) {
        break;
      }
      if (!this.#ownUnechoed.has(id)) {
        this.#seenDeliveryIds.delete(id);
      }
    }
    for (const id of this.#seenResyncRequestIds) {
      if (this.#seenResyncRequestIds.size <= MAX_REMEMBERED_REQUESTS) {
        break;
      }
      if (!this.#ownRequests.has(id)) {
        this.#seenResyncRequestIds.delete(id);
      }
    }
  }

  /**
   * Grants, changes or revokes (`null`) `member`'s `read` or `write` permission.
   * **Creator only**: it decides a register (CTL-20, CTL-21) and broadcasts it in a control
   * frame that every cooperating client honours. Enforcement is application-level and depends on
   * the other clients being cooperative — nothing in the messenger enforces it
   * (SPECIFICATION.md §15.2, §15.3).
   *
   * `"creator"` cannot be granted, and the creator's own record cannot be
   * changed: a creator is fixed at creation.
   *
   * Like every control action it holds here at once and resolves once the transport has accepted
   * the frame; a send that fails for now is retried (`sendStatus` shows it), so offline this
   * waits while the decision already shows. It rejects when the transport refuses for good — the
   * decision still holds and travels in every snapshot — or when the engine is disposed first:
   * then the frame stays unsent in the persisted control state, and the restarted engine sends it
   * (CTL-26).
   */
  async setMembership(member: MemberId, permission: "read" | "write" | null): Promise<void> {
    if ((permission as Permission | null) === "creator") {
      throw new Error(
        "creator status cannot be granted — it is fixed at document creation and permanent",
      );
    }
    if (member === this.memberId) {
      throw new Error(
        `${member}'s own creator status is permanent and cannot be changed via setMembership`,
      );
    }
    await this.#issueControl(`member:${member}`, permission);
  }

  /**
   * Sets `member`'s right on `layer` (LAY-5), as `setMembership` sets its permission. **Creator
   * only.** `null` revokes it: the member's permission on the document applies there again.
   */
  async setLayerRight(
    layer: string,
    member: MemberId,
    right: "read" | "write" | null,
  ): Promise<void> {
    if (!isLayerId(layer)) {
      throw new Error(`${layer} is not a layer id (SPECIFICATION.md §5.6)`);
    }
    if (member === this.memberId) {
      throw new Error(`${member}'s own creator status covers every layer and cannot be changed`);
    }
    await this.#issueControl(`layer:${layer}:member:${member}`, right);
  }

  /**
   * Marks the document finished (SPECIFICATION.md §6.4; the counterpart of `create()`): every cooperating client stops sending edits
   * of its own, while edits already sent still arrive and apply, and local content stays
   * readable. **Creator only**,
   * terminal, and idempotent — closing an already-closed document does nothing.
   *
   * `reason`, if given, says why (CTL-23): one of `CLOSE_REASON_CODES`, or an application's own,
   * named as an extension is (FRM-15), of at most 128 bytes. It goes in the same `control` frame as
   * the close; on a document already closed it is set as `setCloseReason` sets it.
   */
  async closeDocument(reason?: string): Promise<void> {
    if (reason !== undefined && !isNamedCloseReason(reason)) {
      throw new Error(`${reason} is not a reason for the close (SPECIFICATION.md CTL-23)`);
    }
    if (this.#control.closed && this.#creatorMemberId === this.memberId) {
      if (reason !== undefined && reason !== this.#control.closeReason) {
        await this.setCloseReason(reason);
      }
      return;
    }
    await this.#issueClose(reason);
  }

  /**
   * Sets why the creator closed this document (CTL-23), on a document already closed: a register
   * with a later clock than the one it holds, so it holds over it wherever both arrive. **Creator
   * only.** Refused as `not-closed` while the document is not closed: a reason goes with the close
   * (`closeDocument(reason)`) or after it, never before.
   */
  async setCloseReason(reason: string): Promise<void> {
    if (!isNamedCloseReason(reason)) {
      throw new Error(`${reason} is not a reason for the close (SPECIFICATION.md CTL-23)`);
    }
    if (this.#creatorMemberId !== this.memberId) {
      throw new Error(`${this.memberId} is not the creator of ${this.documentId}`);
    }
    if (!this.#control.closed) {
      throw new SendRefusedError(
        "not-closed",
        `${this.documentId} is not closed: a reason for the close goes with the close or after it (CTL-23)`,
      );
    }
    this.#device ??= newDeviceTag();
    const decided = this.#closeReasonRegister(reason);
    const next = this.#control.copy();
    next.take({ closed: true, targets: { [CLOSE_REASON]: decided.register } });
    await this.#decide(next, { [CLOSE_REASON]: decided.register }, decided.own);
  }

  /**
   * Sets the pace for everyone (SND-15): the shortest interval, in milliseconds,
   * between two messages any participant sends for this document; `0` for none. **Creator only**.
   * Every participant keeps to the larger of it and its own transport's floor, and may send slower;
   * everything else about pacing stays each participant's own (SND-16).
   */
  async setPace(intervalMs: number): Promise<void> {
    if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 0xffffffff) {
      throw new Error(`a pace is a whole number of milliseconds, got ${intervalMs}`);
    }
    await this.#issueControl("pace", intervalMs);
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
   * Resolves once the transport has accepted all of it: a send refused for now is kept and
   * retried after the back-off, as an edit is (SND-6, SND-7); one refused for good — whole, or one
   * of its pieces — rejects, and that rejection is its only report (SND-8): `onError` is not told.
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
    // of it has gone out — every piece, when it is too large for one message (SND-8). One dropped
    // meanwhile, a piece of this very message included, keeps the mark.
    const droppedSoFar = this.#scheduler.droppedCount;
    const state = this.#profile.encodeState(this.document);
    const whole = encodeEditFrame(this.documentId, state, this.#outgoing.get("edit"));
    await this.#sendFrames(
      this.#maxBytes === undefined || frameByteLength(whole) <= this.#maxBytes
        ? [whole]
        : this.#editFramesOf(state),
      // An edit, possibly the only copy of a change nobody else has: kept and retried after a
      // failure worth retrying, whole or in pieces alike (SND-6, SND-7), and shown as retrying. The
      // whole state is no change of its own: it begins no phase, and no report carries it (SND-11).
      { retry: true, own: true },
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
   * as one in `#ownRequests` below so `sync()` knows to consider
   * adopting the answer's attribution overlay when it arrives
   * (SPECIFICATION.md §5.4) — never marked for a
   * request made with existing content, which has no such question to
   * answer (a partial gap-heal response never adopts an overlay). No
   * window or timer guards this: `#considerBootstrapOverlay` adopts the
   * first answer's overlay the moment it arrives, and no later one, also
   * when a repeated bootstrap request is answered too (RSY-15).
   */
  async requestResync(): Promise<ResyncOutcome> {
    // Synchronising now (LIF-12): the request asks all and is the one request of every resting gap,
    // which rests again after it (LOS-26).
    this.#detector.wakeAll();
    return this.#requestResync(false);
  }

  /**
   * The application tells this engine, which kept running, that a read for the document reached the
   * messenger again now, and that its last read that did began `awayMs` before (LIF-8, LIF-12) — the
   * device slept, or had no network. Longer than its transport keeps a message for a device that is
   * away, it is a **return** (RSY-21): it may lack what members wrote meanwhile, which nothing shows
   * until they write again, so its next poll asks all, and once more if that request expires
   * unanswered (RSY-5) — but a device still in its bootstrap, a member's or the creator's, asks only as
   * its bootstrap does.
   * Longer than START_REQUEST_AFTER_MS, its next poll makes a start request, once, if it is
   * bootstrapped (RSY-1). Either wakes every resting gap, whose one request it is (LOS-26). Both are
   * required and go also with `autoResync` off (RSY-5). The back-off of a report it owes ends, and the
   * report goes as soon as the floor permits (SND-28, SND-12); nothing else is sent by this call. Told
   * again, it begins anew.
   */
  noteAbsence(awayMs: number): void {
    // Reached again: what the report waited out is over, and it goes now (SND-28, SND-12).
    this.#scheduler.liftReportBackOff();
    const retention = this.#transportRetentionMs;
    if (retention !== undefined && awayMs > retention) {
      this.#beginReturn();
      this.#forgetRequestsCaughtUp();
    } else if (awayMs > START_REQUEST_AFTER_MS) {
      // Not bootstrapped, it asks as its bootstrap does (RSY-1, RSY-5).
      this.#startRequestOwed = this.#bootstrapped;
      this.#detector.wakeAll();
      this.#forgetRequestsCaughtUp();
    }
  }

  /**
   * Others' requests to all that the read this engine was just told of brought, as it caught up with
   * an absence, are let go for none of its own (RSY-22): they may have waited there for long, and no
   * frame says when it was sent.
   */
  #forgetRequestsCaughtUp(): void {
    const kept = this.#heardRequestsToAll.filter((heard) => heard.read !== this.#reads);
    this.#heardRequestsToAll.splice(0, this.#heardRequestsToAll.length, ...kept);
  }

  /**
   * A return the application tells this running engine of, as `noteAbsence` does for an absence longer
   * than its transport keeps a message (RSY-21): the back-off of a report it owes ends, too (SND-12).
   */
  noteReturn(): void {
    this.#scheduler.liftReportBackOff();
    this.#beginReturn();
    this.#forgetRequestsCaughtUp();
  }

  /**
   * The one place a resync request is made, whoever is asking. It takes
   * the single slot first, before anything is sent, so two callers in the same tick cannot
   * both send; a request made while one of ours is outstanding — or still waiting in the
   * scheduler to go out — is coalesced into it and sends nothing. A person's request made inside
   * the rate floor is refused; an automatic one is not: it waits in the scheduler for the floor
   * (RSY-3, SND-2), so a client that keeps writing still gets to ask (LOS-6). One to all that went
   * out, or was refused for good, is a try of every gap whose wait had passed, and the wake of every
   * resting gap that was woken (LOS-6, LOS-26).
   */
  async #requestResync(automatic: boolean): Promise<ResyncOutcome> {
    if (this.#requestWaiting) {
      return { sent: false, reason: "in-flight" };
    }
    const all = this.#asksAll();
    const previousRequestAt = this.#resyncGate.lastRequestAt;
    const previousExpiryMs = this.#lastRequestExpiryMs;
    const previousLatestId = this.#latestRequestId;
    const previousAnsweredBy = this.#answeredLatestBy;
    const previousHeard = this.#heardAfterExpiry;
    const previousCreatorClockAt = this.#heardCreatorClockAt;
    const previousAll = this.#lastRequestAll;
    const outcome = this.#resyncGate.begin({
      expiryMs: this.#resyncExpiryMs(all),
      floorMs: automatic ? 0 : this.#scheduler.effectiveMinIntervalMs,
      automatic,
      lastMessageAt: this.#scheduler.lastSendOnClock,
    });
    if (!outcome.sent) {
      return outcome;
    }
    this.#lastRequestAll = all;
    this.#lastRequestExpiryMs = this.#resyncExpiryMs(all);
    this.#requestWaiting = true;
    let requestIdToForget: string | undefined;
    try {
      const stateVector = this.#profile.encodeStateVector(this.document);

      // An ordinary send(): a resync request is just another frame kind.
      // The request's own id, chosen here and recorded before it is sent, so an answer that
      // arrives on the next poll is recognised as ours (SPECIFICATION.md RSY-1).
      const requestId = newRandomId();
      requestIdToForget = requestId;
      this.#latestRequestId = requestId;
      this.#answeredLatestBy = new Set();
      this.#heardAfterExpiry = new Map();
      this.#heardCreatorClockAt = null;
      this.#seenResyncRequestIds.add(requestId);
      const bootstrap = this.#profile.isEmptyStateVector(stateVector);
      this.#ownRequests.add(requestId, this.#steady.now(), bootstrap);
      // Written when it goes out, not when it was asked for: it may wait for the floor, and what
      // it says this client holds must be what it holds then (RSY-16, LOS-12).
      const frame = () => {
        // After a truncated history only an answer can say nothing was lost (LOS-19): the one it
        // asks for is the one an answer to it ends.
        const force = this.#historyTruncatedSince !== undefined;
        this.#ownRequests.forced(requestId, force ? this.#truncations : undefined);
        return encodeResyncRequestFrame({
          documentId: this.documentId,
          requestId,
          // Until it is bootstrapped, the answer itself is what this engine lacks — the profile and
          // the control state — even when the content has already arrived by ordinary edits
          // (RSY-16, CTL-10): `null` says so, also on a device of the creator, so that a bootstrapped
          // device answers it even when it lacks nothing, and the snapshot bootstraps it (RSY-17).
          controlClock: this.#statesControl() ? this.#control.clock : null,
          controlDigest: this.#statesControl() ? this.#control.digest : null,
          // To all but the first request of a bootstrap (RSY-21).
          all,
          force,
          ...this.#reporting(this.#ownState()),
          // Numbered as it is written, so a later report of this stream states a later state (LOS-13).
          stream: this.#stream,
          sequence: this.#nextSequence(),
          extensions: this.#outgoing.get("resync-request"),
        });
      };
      // Through the scheduler, on the floor like any message; a request neither begins nor prolongs
      // a phase of this client's sending (SPECIFICATION.md SND-2, SND-11).
      const id = await this.#scheduler.submit(() =>
        this.#messenger.send(this.documentId, this.memberId, frame()),
      );
      this.#markOwnSend(id);
      // How long it is kept counts from when it went out too (RSY-12).
      this.#ownRequests.add(requestId, this.#steady.now(), bootstrap);
      // Its expiry, and the floor for the next one, count from when it went out (RSY-4).
      this.#resyncGate.sent(this.#resyncExpiryMs(all));
      if (this.#inBootstrap()) this.#askedInBootstrap = true;
      if (all) this.#detector.tried(this.#steady.now());
    } catch (error) {
      if (requestIdToForget !== undefined) {
        this.#ownRequests.delete(requestIdToForget);
      }
      // Nothing went out: the request before is the latest again, with the time it could wait and
      // who answered it in it (RSY-4, RSY-5).
      this.#resyncGate.abort(previousRequestAt);
      this.#lastRequestExpiryMs = previousExpiryMs;
      this.#latestRequestId = previousLatestId;
      this.#answeredLatestBy = previousAnsweredBy;
      this.#heardAfterExpiry = previousHeard;
      this.#heardCreatorClockAt = previousCreatorClockAt;
      this.#lastRequestAll = previousAll;
      // Refused for good, asking again soon cannot help: a try all the same (LOS-6).
      if (all && !classifySendFailure(error).retryable) this.#detector.tried(this.#steady.now());
      throw error;
    } finally {
      this.#requestWaiting = false;
    }
    return outcome;
  }

  /**
   * How long an unanswered request holds the slot (RSY-4): it has to reach the creator, the creator
   * may have to wait for its own send slot, and the answer has to come back — one floor
   * between messages and two expected latencies, never less than a floor of ten seconds. A request
   * to all also waits out the window over which members' turns are spread (RSY-20).
   */
  #resyncExpiryMs(all = false): number {
    const expiry = Math.max(
      RESYNC_EXPIRY_FLOOR_MS,
      this.#scheduler.effectiveMinIntervalMs + 2 * this.#syncPolicy.expectedLatencyMs,
    );
    return all ? expiry + answerWindowMs(this.#syncPolicy.expectedLatencyMs) : expiry;
  }

  /**
   * A return ends once a request of it to all, made since it began, was answered, or two expired
   * (RSY-21, RSY-4) — not with the first answer it hears: a device of the creator's or of this
   * member's that answers at once may hold less than a member, which still answers at its turn
   * (RSY-20), and the answer ends the request only once the turns came. A member asked by all answers
   * when it holds anything this client lacks (RSY-17); but its answer may be lost like any message,
   * and those who heard it fall silent (RSY-20), so one request that expired unanswered is followed
   * by a second.
   */
  #endReturnAfterAskingAll(): void {
    const requestAt = this.#resyncGate.lastRequestAt;
    if (
      !this.#returning ||
      !this.#lastRequestAll ||
      requestAt === null ||
      this.#returnBeganAt === null ||
      requestAt < this.#returnBeganAt ||
      this.#requestWaiting ||
      !this.#resyncGate.isFree
    ) {
      return;
    }
    // Ended, not failed: a request that could not be sent asked nobody (RSY-4).
    const outcome = this.#resyncGate.status().lastOutcome;
    if (outcome === "answered") {
      this.#returning = false;
      return;
    }
    if (outcome === "unanswered" && requestAt !== this.#returnCountedRequestAt) {
      this.#returnCountedRequestAt = requestAt;
      this.#returnExpired += 1;
      if (this.#returnExpired >= RETURN_REQUESTS_TO_EXPIRE) this.#returning = false;
    }
  }

  /** Whether the latest request of this client's own has expired by `now`, on the engine's clock. */
  #latestRequestExpired(now: number): boolean {
    const at = this.#resyncGate.lastRequestAt;
    return (
      at !== null &&
      this.#lastRequestExpiryMs !== undefined &&
      now >= at + this.#lastRequestExpiryMs
    );
  }

  /**
   * Whether this client read a frame of a participant that did not answer its latest request of its
   * own that went out, after that request had the time it could wait (RSY-5) — on a device of the
   * creator, of another device of the creator: someone is there now who was not when it asked. The
   * frames of one that answered say nothing about who came back — also of one whose answer ended
   * nothing, content alone —, and asking again on every frame would repeat that request for as long as
   * anyone writes. But for a device of the creator that states a control clock, whoever answered:
   * answers count by member, and another device of hers may have answered with content alone. One
   * whose send failed asked nobody (RSY-4): the request before it is judged, as if it had not been
   * made, and the next poll asks again once the back-off allows.
   */
  #heardSinceLastExpired(now: number): boolean {
    const at = this.#resyncGate.lastRequestAt;
    if (at === null || this.#lastRequestExpiryMs === undefined) {
      return false;
    }
    const expiredAt = at + this.#lastRequestExpiryMs;
    if (now < expiredAt) {
      return false;
    }
    for (const [sender, heardAt] of this.#heardAfterExpiry) {
      if (heardAt >= expiredAt && !this.#answeredLatestBy.has(sender)) return true;
    }
    // A device of the creator that states a control clock is bootstrapped and can bootstrap this one
    // (RSY-14): answers count by member, and the creator's may have come from another of her devices,
    // one that holds content alone.
    return this.#heardCreatorClockAt !== null && this.#heardCreatorClockAt >= expiredAt;
  }

  /**
   * A return begins (RSY-21): none of its requests to all has expired yet, and every resting gap is
   * woken, its first request theirs (LOS-26).
   */
  #beginReturn(): void {
    this.#returning = true;
    this.#returnBeganAt = this.#steady.now();
    this.#returnExpired = 0;
    this.#returnCountedRequestAt = null;
    this.#detector.wakeAll();
  }

  /**
   * Whether this client still asks as it does for its bootstrap (RSY-5, RSY-21): while it is not
   * bootstrapped — an answer to its own request that carries control state bootstraps it (RSY-14),
   * one with content alone does not.
   */
  #inBootstrap(): boolean {
    return !this.#bootstrapped;
  }

  /**
   * Whether this client's next request asks all (RSY-21): every one but the first of its bootstrap,
   * unless it returns — its repeats, every request for a gap, a start request, the person's and every
   * one while it returns. The creator's devices and this member's own devices answer at once, and one
   * of them is usually at hand for a new device; a gap heals only at whoever holds what it lacks, which
   * with rare loss is usually a member (LOS-6).
   */
  #asksAll(): boolean {
    return this.#returning || !this.#inBootstrap() || this.#askedInBootstrap;
  }

  /**
   * The client asking for help by itself, checked on every poll tick —
   * through the same single slot a person's click uses, so the two never run in parallel.
   *
   * - **Bootstrap retry.** A joiner that has heard nothing asks again, waiting one expiry, then
   *   two, then four, and gives up on its own after a few (a person can always ask); so does a
   *   device of the creator while it is not bootstrapped (RSY-5). Once given up, it asks once more,
   *   to all, whenever it reads, after its latest request had its time, a frame of a participant that
   *   did not answer that request — on a device of the creator, of another device of the creator —, or,
   *   whoever answered, a `control` frame, a report or a request of another device of the creator that
   *   states a control clock; the waits doubling on as before, up to the cap.
   * - **A start request** a running engine owes after an absence (RSY-1, LIF-12): once.
   * - **A return** (RSY-21): its request to all, once the request before had its time, until the
   *   return ends (RSY-5) — once bootstrapped; before, a device of a member's or of the creator's asks
   *   as its bootstrap does.
   * - **Gaps** (LOS-6, LOS-26): each gap's tries, its first once it has lasted a conservative multiple
   *   of the waiting time and then a slot of its own — at once for a truncated history —, then with
   *   doubling waits, three in all; a resting gap woken by a frame that raised its position or by any
   *   frame of the member that wrote it. One request serves every gap due, and none goes where
   *   another's request to all, heard within its expiry, reaches no further: its answers are taken
   *   instead, and a further try of those gaps comes once it expired and then in their slots, so that
   *   one device asks again, not all (RSY-22).
   *
   * With `autoResync` off only the start request and a return's requests are made here, and only by
   * a device that is bootstrapped (RSY-1, RSY-5, RSY-21).
   */
  async #considerAutomaticResync(): Promise<void> {
    if (this.#starting) {
      return;
    }
    // The application may switch the automatic requests off (RSY-5, LOS-6, LOS-26); the start request an
    // absence owes and a return's requests are required (RSY-1, RSY-21) and go all the same.
    if (!this.#autoResync && !this.#startRequestOwed && !this.#returning) {
      return;
    }
    if (!this.#resyncGate.isFree || this.#requestWaiting) {
      return;
    }
    const now = this.#steady.now();
    const expiry = this.#resyncExpiryMs();

    // A device asks on while it is not bootstrapped, also once an answer without control state
    // brought it the content (RSY-5, RSY-14).
    if (this.#inBootstrap()) {
      const reference = Math.max(
        this.#resyncGate.lastRequestAt ?? 0,
        this.#lastAutomaticAttemptAt ?? 0,
      );
      const wait = Math.min(RESYNC_BACKOFF_CAP_MS, expiry * 2 ** this.#automaticBootstrapAttempts);
      const waited = reference === 0 || now - reference >= wait;
      if (
        this.#autoResync &&
        this.#automaticBootstrapAttempts < MAX_AUTOMATIC_BOOTSTRAP_ATTEMPTS &&
        waited
      ) {
        this.#askAutomatically(() => {
          this.#automaticBootstrapAttempts += 1;
        });
        return;
      }
      // Its attempts ran out, but a frame read since its latest request that went out had its time, of
      // a participant that did not answer it, shows that someone is there again: one request more,
      // which asks all as a repeat does (RSY-21) — at most one per expiry, since the next needs a frame
      // read after its time passed, and with doubling waits between them, counted on from its attempts:
      // a member that writes on and never answers costs a few requests an hour, not one per expiry
      // (RSY-5).
      if (
        this.#autoResync &&
        this.#automaticBootstrapAttempts >= MAX_AUTOMATIC_BOOTSTRAP_ATTEMPTS &&
        waited &&
        this.#heardSinceLastExpired(now)
      ) {
        this.#askAutomatically(() => {
          this.#automaticBootstrapAttempts += 1;
        });
        return;
      }
      // A joiner has nothing to heal before its bootstrap. A device of the creator does: it edits
      // and answers at once, and its gaps are asked for as anyone's are (LOS-6, RSY-5), however its
      // own bootstrap requests went. A return of either asks only as its bootstrap does, which asks
      // all while it returns (RSY-5, RSY-21): with the repeats off, its first request is its one.
      if (this.#creatorMemberId !== this.memberId || !this.#autoResync) {
        return;
      }
    } else {
      // Owed once, after an absence (RSY-1): it asks all and is the request of every gap it woke.
      if (this.#startRequestOwed) {
        this.#askAutomatically(() => {
          this.#startRequestOwed = false;
        });
        return;
      }
      // A return asks all once its latest request had the whole time an answer may take (RSY-4, RSY-21).
      if (
        this.#returning &&
        now - (this.#resyncGate.lastRequestAt ?? Number.NEGATIVE_INFINITY) >= expiry
      ) {
        this.#askAutomatically(() => {});
        return;
      }
    }
    if (!this.#autoResync) {
      return;
    }
    // A request let go for another's holds the gaps as one of this client's own would, until it
    // expires (RSY-4, RSY-22).
    if (now < this.#adoptedUntil) {
      return;
    }
    const due = this.#detector.dueGaps(now, expiry);
    // Gaps that wait for the slot of their first try alone are about to be asked for as well (LOS-6).
    const gaps = due.length > 0 ? due : this.#detector.awaitingSlot(now, expiry);
    if (gaps.length === 0) {
      return;
    }
    // Several devices with the same gap: one request, one answer (RSY-22). The one let go counts as
    // made for those gaps, and the answers to the one heard are taken (RSY-12) — from when the gaps'
    // wait passed, not their slot, so that an answer that comes before the slot is not missed. Their
    // further tries come in their slots after it expired, so that one asks again, not all (LOS-6).
    const heard = this.#requestReachingNoFurther(gaps, now);
    if (heard !== undefined) {
      this.#adoptedRequests.add(heard.id, heard.heardAt, false);
      this.#adoptedUntil = heard.heardAt + this.#resyncExpiryMs(true);
      this.#detector.tried(now, gaps, this.#adoptedUntil);
      return;
    }
    if (due.length === 0) {
      return;
    }
    this.#askAutomatically(() => {});
  }

  /**
   * Makes an automatic request, without waiting for it: it may wait in the scheduler for the
   * floor (RSY-3), and a poll must not wait with it. Only a request that went out counts against
   * the bound and the spacing (LOS-6, RSY-5); one the floor holds back holds the slot meanwhile.
   * One the transport refused for good counts too, since asking again soon cannot help; one that
   * could not go out for now counts for nothing and is asked again on a later poll, once the
   * back-off allows (SND-7). Its failure is not a dropped change and is not reported (SND-10).
   */
  #askAutomatically(count: () => void): void {
    const spent = (): void => {
      count();
      this.#lastAutomaticAttemptAt = this.#steady.now();
    };
    this.#requestResync(true).then(
      (outcome) => {
        if (outcome.sent) {
          spent();
        }
      },
      (error: unknown) => {
        if (!classifySendFailure(error).retryable) {
          spent();
        }
      },
    );
  }

  /**
   * Sends any local edits currently waiting to go out without waiting for the quiet time or
   * `minChars`, as soon as the floor between messages and any back-off permit: those are the
   * provider's limit, which an explicit request does not lift (SND-2, SND-7). A no-op if nothing is
   * queued — including whenever `batchWindowMs` is 0, since nothing is ever queued in that case.
   * Rejects with the send's error if it fails; a failure worth retrying leaves the change queued
   * for the scheduler's own retry, a permanent one drops it. Called automatically by `dispose()`,
   * so a pending batch is never silently dropped when a client is torn down. It sends no report:
   * `reportNow()` does.
   */
  async flush(): Promise<void> {
    await this.#scheduler.flush();
  }

  /**
   * Stops broadcasting local edits. Does not affect other clients on the channel.
   * Sends what is pending one last time, once the floor and any back-off permit (SND-2); there is
   * no retry after this, so a failure is reported through `onError` and the change is lost. A
   * control frame still being retried is not lost: it stays unsent in the persisted control
   * state (CTL-26). This is the close of SND-11: a report this client owes goes last, after
   * everything else; one that cannot go stays owed (`owedReport`), for the application to persist
   * (SND-28).
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
   * document is open, and it is the creator, or it has been bootstrapped and its permission is
   * `write` — not `read`, revoked or unknown. What an application shows as an editable document.
   */
  get mayEdit(): boolean {
    if (this.#control.closed || this.#control.capacityConflict) {
      return false;
    }
    if (this.#creatorMemberId === this.memberId) {
      return true;
    }
    return this.#bootstrapped && !refuses(this.rightOf(this.memberId));
  }

  /**
   * Whether this client may send a change of `layer` now (LAY-5, LAY-6): as `mayEdit`, by its
   * permission on that layer — its right there, or else its permission on the document, an unknown
   * one counting as `read` (CTL-13); never once its permission is revoked.
   */
  mayEditLayer(layer: string): boolean {
    if (this.#control.closed || this.#control.capacityConflict) {
      return false;
    }
    if (this.#creatorMemberId === this.memberId) {
      return true;
    }
    return this.#bootstrapped && !refuses(this.rightOf(this.memberId, layer));
  }

  /**
   * Refuses an edit of this client's own when it must not send one (CTL-13): the document is
   * closed, its permission is `read` or revoked, or — for anyone but the creator — no answer has
   * bootstrapped it yet, or after the bootstrap no register names it (unknown counts as `read`).
   */
  #assertMayEdit(): void {
    this.#assertMaySend();
    if (this.#creatorMemberId === this.memberId) {
      return;
    }
    if (!this.#bootstrapped) {
      throw new SendRefusedError(
        "awaiting-bootstrap",
        `${this.memberId} has not received ${this.documentId} from its creator yet`,
      );
    }
    if (this.rightOf(this.memberId) === "unknown") {
      throw unknownPermission(this.memberId, this.documentId);
    }
  }

  /**
   * Refuses, permanently, a change of its own that touches a part of the document this client may
   * not write (LAY-6, LAY-7): the content by its permission, a layer by its permission there. A
   * change that touches several is refused whole when one of them is not permitted.
   */
  #assertMayChange(roots: ReadonlySet<string>): void {
    this.#assertNotClosed();
    this.#assertNoCapacityConflict();
    if (this.#creatorMemberId === this.memberId) {
      return;
    }
    // In the order `#assertMayEdit` refuses in: a known `read` or revocation before a bootstrap
    // still awaited, and that before an unknown permission, which every member has until its
    // bootstrap brings the registers that name it (CTL-13).
    let unknown: string | undefined;
    for (const root of roots.size === 0 ? ["content"] : roots) {
      const layer = isLayerId(root) ? root : undefined;
      const right = this.rightOf(this.memberId, layer);
      if (right === "unknown") {
        unknown ??= layer ?? "content";
        continue;
      }
      if (right === "revoked") {
        throw new SendRefusedError(
          "revoked",
          `${this.memberId}'s permission on ${this.documentId} is revoked`,
        );
      }
      if (right === "read") {
        throw new SendRefusedError(
          "read-only",
          layer === undefined
            ? `${this.memberId} has read-only access to ${this.documentId}`
            : `${this.memberId} has read-only access to the layer ${layer} of ${this.documentId}`,
        );
      }
    }
    if (!this.#bootstrapped) {
      throw new SendRefusedError(
        "awaiting-bootstrap",
        `${this.memberId} has not received ${this.documentId} from its creator yet`,
      );
    }
    if (unknown !== undefined) {
      throw unknownPermission(
        this.memberId,
        this.documentId,
        unknown === "content" ? undefined : unknown,
      );
    }
  }

  /**
   * Refuses, permanently, when this client already knows it must not send, whether or not it is
   * bootstrapped: closed, `read`, or revoked (CTL-13). An unknown permission refuses only after the
   * bootstrap, where `#assertMayEdit` and `#assertMayChange` check it.
   */
  #assertMaySend(): void {
    this.#assertNotClosed();
    this.#assertNoCapacityConflict();
    const right = this.rightOf(this.memberId);
    if (right === "revoked") {
      throw new SendRefusedError(
        "revoked",
        `${this.memberId}'s permission on ${this.documentId} is revoked`,
      );
    }
    if (right === "read") {
      throw new SendRefusedError(
        "read-only",
        `${this.memberId} has read-only access to ${this.documentId}`,
      );
    }
  }

  /** Refuses an edit of this client's own once the document is closed, for good (LIF-7). */
  #assertNotClosed(): void {
    if (this.#control.closed) {
      throw new SendRefusedError("closed", `document is closed, no new writes: ${this.documentId}`);
    }
  }

  /**
   * Refuses an edit of this client's own in a capacity conflict (CTL-32): it may lack a decision
   * of the creator about itself, so it refuses as `read` refuses — whoever it is.
   */
  #assertNoCapacityConflict(): void {
    if (this.#control.capacityConflict) {
      throw new SendRefusedError(
        "capacity-conflict",
        `${this.memberId} could not hold the control state of ${this.documentId} within its bounds`,
      );
    }
  }

  /**
   * Sends a frame that is already complete — one piece of a larger change, or a whole frame no
   * larger than a message. Deliberately not checked against permission or a closed document:
   * whether an *edit* may be sent is decided where it is split (`pieces`), and a resync answer
   * must go out from a closed document, which still bootstraps a joiner.
   */
  async #sendFrame(frame: string): Promise<void> {
    const id = await this.#messenger.send(this.documentId, this.memberId, frame);
    this.#markOwnSend(id);
  }

  /**
   * The largest update a frame of `overhead` bytes besides its update can carry within the
   * transport's limit: four characters of Base64 for every three bytes. Throws when the limit
   * leaves no useful room — the change is then dropped and reported (SND-8).
   */
  #pieceBudget(overhead: number): number {
    const budget = Math.floor(((this.#maxBytes as number) - overhead) / 4) * 3;
    if (budget < MIN_PIECE_BYTES) {
      throw new PieceTooSmallError(this.#maxBytes as number, overhead);
    }
    return budget;
  }

  /**
   * `update` as edit frames of one piece each (SND-17): the profile splits it into updates
   * that apply in any order (PRF-1). Throws `UnsplittableUpdateError` for an indivisible unit
   * too large for a message (SND-19). Only ever called when the transport states a limit.
   */
  #editFramesOf(update: Uint8Array): string[] {
    const extensions = this.#outgoing.get("edit");
    const overhead =
      frameByteLength(encodeEditFrame(this.documentId, new Uint8Array(3), extensions)) - 4;
    return splitterOf(this.#profile)(update, this.#pieceBudget(overhead)).map((piece) =>
      encodeEditFrame(this.documentId, piece, extensions),
    );
  }

  /** A `too-large` refusal of a message the transport's own `maxBytes` allowed is the profile's fault (SND-22). */
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

  /**
   * Sends frames that together carry one change — `resync()`'s full state, or an answer: one
   * frame through the scheduler like any message, several in order at the permitted rate, each
   * piece retried like any send (SND-2, SND-20, RSY-11). A single frame is retried as well with
   * `retry`, as `resync()`'s is: it is an edit, kept until the transport has accepted it (SND-6,
   * SND-7). Neither begins a phase of this client's sending (SND-11). Waits for every piece, so a
   * caller learns, as for one message, whether it all went out.
   */
  async #sendFrames(
    frames: readonly string[],
    options: { retry?: boolean; own: boolean },
  ): Promise<void> {
    if (frames.length === 1) {
      await this.#scheduler.submit(
        () => this.#sendFrame(frames[0] as string),
        options.retry === undefined ? {} : { retry: options.retry },
      );
      return;
    }
    await this.#scheduler.enqueueFrames(frames, { own: options.own });
  }

  async #broadcast(update: Uint8Array, roots: ReadonlySet<string>): Promise<void> {
    this.#assertMayChange(roots);
    const frame = encodeEditFrame(this.documentId, update, this.#outgoing.get("edit"));
    const id = await this.#messenger.send(this.documentId, this.memberId, frame);
    this.#markOwnSend(id);
  }

  /**
   * The messages of one report (§9.3), each written when its turn comes: on a device of the creator
   * whose last message of its own was a control frame, that frame again, unchanged, first — merged
   * again, it changes nothing (CTL-6) —; then the report, carrying the update of the last edit of its
   * own that went out (SND-27).
   */
  #reportMessages(carry: ReportCarry | null): Array<() => Promise<unknown>> {
    const messages: Array<() => Promise<unknown>> = [];
    if (carry?.kind === "control" && this.#creatorMemberId === this.memberId) {
      const text = carry.text;
      messages.push(() => this.#sendFrame(text));
    }
    const update = carry?.kind === "edit" ? carry.update : undefined;
    messages.push(() => this.#sendReport(update));
    return messages;
  }

  /**
   * The report: this client's state vector and, from a bootstrapped device of the creator, its
   * control clock and control digest, which is what makes even the creator's most recent decision
   * checkable; and `update` again — the last edit of its own that went out, byte for byte —, left out
   * where the report would exceed the transport's limit with it (SND-11, SND-27). Still sent after a
   * close, carrying an edit sent before it (LIF-6).
   */
  async #sendReport(update: Uint8Array | undefined): Promise<void> {
    const states = this.#creatorMemberId === this.memberId && this.#bootstrapped;
    const report = {
      documentId: this.documentId,
      // A bootstrapped device of the creator's control clock and digest, so a lost decision shows
      // (SND-11, LOS-10, LOS-12).
      controlClock: states ? this.#control.clock : null,
      controlDigest: states ? this.#control.digest : null,
      // What the state vector does not show, beside it (LOS-12).
      ...this.#reporting(this.#ownState()),
      stream: this.#stream,
      sequence: this.#nextSequence(),
      extensions: this.#outgoing.get("heartbeat"),
    };
    const carrying = update === undefined ? undefined : encodeHeartbeatFrame({ ...report, update });
    const frame =
      carrying !== undefined &&
      (this.#maxBytes === undefined || frameByteLength(carrying) <= this.#maxBytes)
        ? carrying
        : encodeHeartbeatFrame(report);
    const id = await this.#messenger.send(this.documentId, this.memberId, frame);
    this.#markOwnSend(id);
  }

  /**
   * What a restored owed report carries again (SND-27, SND-28): an update its profile reads; on a
   * device of the creator, a control frame of this document. Anything else is left out; the report
   * still goes.
   */
  #restoredCarry(owed: OwedReport): ReportCarry | null {
    if (owed.control !== undefined) {
      if (this.#creatorMemberId !== this.memberId) {
        return null;
      }
      try {
        const frame = decodeFrame(owed.control);
        return frame.kind === "control" && frame.documentId === this.documentId
          ? { kind: "control", text: owed.control }
          : null;
      } catch {
        return null; // a frame of another draft, which no receiver reads (VER-3)
      }
    }
    return owed.update !== undefined &&
      owed.update.length > 0 &&
      readerOf(this.#profile).isUpdate(owed.update)
      ? { kind: "edit", update: owed.update }
      : null;
  }

  async #broadcastResyncResponse(
    respondsTo: ResyncRequestId,
    update: Uint8Array,
    attribution: object,
    control: ControlSnapshot | null,
  ): Promise<void> {
    // One number in this engine's stream for the whole answer, in every piece; the state it states
    // is the one the update was taken from (RSY-18, LOS-13).
    const sequence = this.#nextSequence();
    const state = this.#reporting(this.#ownState());
    const frame = (piece: Uint8Array, number: number, last: boolean) =>
      encodeResyncResponseFrame({
        documentId: this.documentId,
        respondsTo,
        update: piece,
        attribution: last ? attribution : null,
        // The control state this device holds (RSY-8).
        control: last ? control : null,
        // What this responder holds, in the last piece, which also says how many pieces there are:
        // the requester holds it once every piece is there, and knows whether one is missing (RSY-18,
        // LOS-12, LOS-14).
        state: last ? state : null,
        stream: this.#stream,
        sequence,
        piece: number,
        extensions: this.#outgoing.get("resync-response"),
      });
    const whole = frame(update, 1, true);
    if (this.#maxBytes === undefined || frameByteLength(whole) <= this.#maxBytes) {
      await this.#sendFrames([whole], { own: false });
      return;
    }
    // A full-state answer scales with the document, so it is the frame most likely to exceed a
    // transport's message size: the content goes in pieces, each a resync-response to the same
    // request (SND-17), and the control state and the attribution overlay ride in the last one,
    // or in one of their own with an empty update when they do not fit beside it.
    const overhead = frameByteLength(frame(new Uint8Array(3), 0xffffffff, false)) - 4;
    const pieces = splitterOf(this.#profile)(update, this.#pieceBudget(overhead));
    const last = frame(pieces[pieces.length - 1] as Uint8Array, pieces.length, true);
    const frames =
      frameByteLength(last) <= (this.#maxBytes as number)
        ? [...pieces.slice(0, -1).map((piece, index) => frame(piece, index + 1, false)), last]
        : [
            ...pieces.map((piece, index) => frame(piece, index + 1, false)),
            this.#stateOnlyAnswer(
              respondsTo,
              attribution,
              control,
              sequence,
              pieces.length + 1,
              state,
            ),
          ];
    await this.#sendFrames(frames, { own: false });
  }

  /**
   * The control state and the overlay of an answer, with an empty update: its last piece, `piece`
   * (RSY-18). Attribution is display only (§5.4): when both do not fit, the overlay is left out; the
   * control state must fit.
   */
  #stateOnlyAnswer(
    respondsTo: ResyncRequestId,
    attribution: object,
    control: ControlSnapshot | null,
    sequence: number,
    piece: number,
    state: { readonly stateVector: Uint8Array; readonly stateDigest: string },
  ): string {
    const empty = this.#profile.encodeState(this.#profile.createEmpty());
    const extensions = this.#outgoing.get("resync-response");
    const position = { stream: this.#stream, sequence, piece };
    const withOverlay = encodeResyncResponseFrame({
      documentId: this.documentId,
      respondsTo,
      update: empty,
      attribution,
      control,
      state,
      ...position,
      extensions,
    });
    if (frameByteLength(withOverlay) <= (this.#maxBytes as number)) {
      return withOverlay;
    }
    const withoutOverlay = encodeResyncResponseFrame({
      documentId: this.documentId,
      respondsTo,
      update: empty,
      attribution: null,
      control,
      state,
      ...position,
      extensions,
    });
    if (frameByteLength(withoutOverlay) > (this.#maxBytes as number)) {
      throw new PieceTooSmallError(
        this.#maxBytes as number,
        frameByteLength(withoutOverlay),
        "snapshot",
      );
    }
    return withoutOverlay;
  }

  /**
   * Whether a resync response from `sender` counts (RSY-12): every one the creator sent, and every
   * one that answers a request this engine itself made, or another's to all it let a request of its
   * own go for (RSY-22), whoever sent it — anyone may answer a request to all (RSY-6). Its content is
   * an update anyone in the channel could have sent as an edit (CTL-7); what its control state counts
   * for is CTL-25's. Without the `respondsTo` check, anyone could push content at this engine by an
   * answer nobody asked for, and its pieces would be held without bound (LOS-14). This engine's own
   * answers, coming back, are none of these. An engine that does not know the creator accepts none.
   */
  #mayAcceptResyncResponse(sender: MemberId, frame: ResyncResponseFrame): boolean {
    if (this.#creatorMemberId === undefined) {
      return false;
    }
    return (
      sender === this.#creatorMemberId ||
      this.#ownRequests.has(frame.respondsTo) ||
      this.#adoptedRequests.has(frame.respondsTo)
    );
  }

  /**
   * Notes what an answer to someone's request stated (RSY-20), from its last piece — the whole
   * answer, when it is one: whether its state vector and state digest hold, with what the request's
   * stream stated, the content this engine holds now (`#judgedAsHeard`), and whether its snapshot holds
   * every register this engine holds now, or one that holds over it (CTL-22), and its close. A piece that is not the last states nothing and
   * proves nothing (RSY-18). Its own answers coming back are none of this. Oldest first, bounded like
   * the request ids this engine remembers.
   */
  #heardAnswerTo(frame: ResyncResponseFrame, sender: MemberId): void {
    if (
      frame.stateVector === null ||
      frame.stateDigest === null ||
      this.#isOwnStream(sender, frame.stream)
    ) {
      return;
    }
    const heard = this.#answersHeard.get(frame.respondsTo);
    const now = this.#steady.now();
    const contents = heard?.contents ?? [];
    const control =
      heard?.controlAt === undefined &&
      frame.control !== null &&
      snapshotHolds(frame.control, this.#control);
    const request = [...this.#pendingResyncRequests.values()]
      .flat()
      .find((pending) => pending.id === frame.respondsTo);
    this.#answersHeard.delete(frame.respondsTo);
    this.#answersHeard.set(frame.respondsTo, {
      contents:
        contents.length < MAX_ANSWERS_KEPT_PER_REQUEST
          ? [
              ...contents,
              this.#judgedAsHeard(
                now,
                frame.stateVector,
                frame.stateDigest,
                request && this.#statedFurthest(request),
              ),
            ]
          : contents,
      ...(heard?.controlAt !== undefined
        ? { controlAt: heard.controlAt }
        : control
          ? { controlAt: now }
          : {}),
    });
    for (const id of this.#answersHeard.keys()) {
      if (this.#answersHeard.size <= MAX_REMEMBERED_REQUESTS) {
        break;
      }
      this.#answersHeard.delete(id);
    }
  }

  /**
   * What an answer heard now holds of the content this engine would give its request (RSY-20),
   * together with what the request's stream stated (`stated`): the requester holds both once the
   * answer arrived. Judged against what this engine holds as it hears it, so that an update reaching
   * it later — which reaches the requester the same way — makes it answer for nothing. Every update
   * this engine holds is counted by the answer's state vector or by the stream's; its deletions within
   * the answer's vector are the answer's; and where it holds more than the answer, the stream stated
   * its digest within the stream's vector (LOS-24). Where the answer counts updates this engine lacks,
   * a digest cannot be compared yet — it compares deletions over the same insertions only — and the
   * deletions are judged once this engine holds them (`#settleHeardAnswer`).
   */
  #judgedAsHeard(
    heardAt: number,
    stateVector: Uint8Array,
    stateDigest: string,
    stated: StatedFurthest | undefined,
  ): HeardAnswerState {
    const answer = { heardAt, stateVector, stateDigest, stated };
    try {
      const profile = this.#profile;
      if (!profile.hasUpdatesSince(this.document, stateVector)) {
        return this.#settleHeardAnswer({
          ...answer,
          writersHeld: true,
          beyondAnswer: false,
          held: undefined,
        });
      }
      if (stated === undefined) {
        return { ...answer, writersHeld: false, beyondAnswer: true, held: false };
      }
      // A writer whose updates this engine holds further than both vectors count is one neither has.
      const beyondAnswer = new Set(
        profile.updateClientIds(profile.encodeStateSince(this.document, stateVector)),
      );
      const beyondStream = profile.updateClientIds(
        profile.encodeStateSince(this.document, stated.stateVector),
      );
      const writersHeld = !beyondStream.some((client) => beyondAnswer.has(client));
      return this.#settleHeardAnswer({
        ...answer,
        writersHeld,
        beyondAnswer: true,
        held: writersHeld ? undefined : false,
      });
    } catch {
      return { ...answer, writersHeld: false, beyondAnswer: false, held: false }; // bytes the profile cannot read hold nothing
    }
  }

  /**
   * Judges the deletions of an answer heard (RSY-20, LOS-24) once this engine holds every update the
   * answer counts — as it heard it, or, where it lacked some then, at the first poll it holds them:
   * its digest within the answer's vector is the answer's, and where it held more than the answer,
   * one the request's stream stated is its own within the stream's vector. Until then, `held` stays
   * `undefined`, and the answer holds nothing yet.
   */
  #settleHeardAnswer(answer: HeardAnswerState): HeardAnswerState {
    if (answer.held !== undefined) {
      return answer;
    }
    try {
      if (this.#profile.lacksUpdatesOf(this.document, answer.stateVector)) {
        return answer;
      }
      let held =
        answer.writersHeld && this.#stateDigestWithin(answer.stateVector) === answer.stateDigest;
      if (held && answer.beyondAnswer) {
        const within =
          answer.stated === undefined
            ? undefined
            : this.#stateDigestWithin(answer.stated.stateVector);
        held =
          within !== undefined && (answer.stated as StatedFurthest).stateDigests.includes(within);
      }
      answer.held = held;
    } catch {
      answer.held = false;
    }
    return answer;
  }

  /**
   * The answers heard whose deletions could not be compared yet are judged as soon as this engine
   * holds what they count (RSY-20): on every poll, before any request is answered. One heard longer
   * ago than any request waits for an answer (RSY-4) is let go unjudged.
   */
  #settleHeardAnswers(): void {
    const oldest = this.#steady.now() - this.#resyncExpiryMs(true);
    for (const heard of this.#answersHeard.values()) {
      for (const answer of heard.contents) {
        if (answer.held !== undefined) continue;
        if (answer.heardAt < oldest) answer.held = false;
        else this.#settleHeardAnswer(answer);
      }
    }
  }

  /**
   * When answers to `requestId` were first heard that hold what this engine would give it (RSY-20):
   * its content where it would offer content, judged as each was heard (`#judgedAsHeard`), and its
   * control state where it would offer that; `undefined` while no answer heard holds one of them.
   */
  #heldAnswerAt(
    requestId: ResyncRequestId,
    offersContent: boolean,
    offersControl: boolean,
  ): number | undefined {
    const heard = this.#answersHeard.get(requestId);
    if (heard === undefined) {
      return undefined;
    }
    let contentAt: number | undefined;
    if (offersContent) {
      contentAt = heard.contents.find((answer) => answer.held === true)?.heardAt;
      if (contentAt === undefined) return undefined;
    }
    const controlAt = heard.controlAt;
    if (offersControl && controlAt === undefined) {
      return undefined;
    }
    return Math.max(
      contentAt ?? Number.NEGATIVE_INFINITY,
      offersControl ? (controlAt as number) : Number.NEGATIVE_INFINITY,
    );
  }

  /**
   * The furthest a request's stream stated of its state (RSY-17, RSY-20): what the loss detector
   * keeps of the stream (LOS-17), the request itself included, which it may have dropped since.
   */
  #statedFurthest(request: PendingResyncRequest): StatedFurthest {
    return furtherStated(this.#detector.statedFurthest(request.requester, request.stream) ?? null, {
      stream: request.stream,
      sequence: request.sequence,
      stateVector: request.stateVector,
      stateDigest: request.stateDigest,
      controlClock: request.controlClock,
      controlDigest: request.controlDigest,
    });
  }

  /**
   * Checked on every `sync()` poll tick. **Who answers whom** (SPECIFICATION.md RSY-6, RSY-20):
   * every device of the creator, and every other device of the requester's own member, at once —
   * they hold the whole, and one of them is usually at hand. Anyone else only a request that asks
   * all (RSY-21) — every request but the first of a bootstrap —, and only at its turn: a
   * delay derived from the request and this engine's stream spreads the members' answers, and one
   * that hears answers to the request before its turn that hold what it would give lets it go, so
   * a request to all usually costs one answer — every answer is a message against everyone's
   * budget, and some messengers show each one in the group's chat —, and a member that holds what
   * the first answer lacks still answers.
   *
   * Per request, per tick: skip this client's own request; skip one already
   * resolved; skip (and resolve) one this client may not answer, or one that answers heard before
   * its turn hold what it would give; leave one whose turn has not come, and one this client has
   * nothing to offer for, pending, in case that changes later (content the requester lacks, or
   * control state it is behind on); respect this client's own `resyncResponseThrottleMs` across
   * whichever different requests it does answer.
   *
   * The response itself is a targeted diff, not always a full snapshot —
   * `encodeUpdateSince` against an empty state vector (a brand-new joiner) happens
   * to *be* a full snapshot (verified: byte-identical), so no special-casing is
   * needed for that case.
   *
   * A send failure here that is worth retrying (disconnected, a rate limit) is not routed to
   * `onError`: the request goes back to be answered later (RSY-9), and the next send waits out
   * the back-off. An answer refused for good is reported once, as SND-8 requires of every
   * dropped send, and the request is let go.
   */
  async #respondToResyncRequests(requests: readonly PendingResyncRequest[]): Promise<void> {
    const now = this.#steady.now();
    this.#settleHeardAnswers();

    for (const request of requests) {
      try {
        // This engine's own request is recognised by its id, not by its requester: another
        // device of this member asks under the same MemberId (RSY-6).
        if (this.#ownRequests.has(request.id) || this.#seenResyncRequestIds.has(request.id)) {
          this.#seenResyncRequestIds.add(request.id);
          this.#forgetPendingRequest(request, false);
          continue;
        }
        // Not this engine's to answer (RSY-6): let go, and a copy offered again is not reconsidered.
        if (request.turn.kind === "never") {
          this.#seenResyncRequestIds.add(request.id);
          this.#forgetPendingRequest(request, false);
          continue;
        }
        // Held longer than its requester waits for an answer (RSY-4), as this engine reckons that
        // wait: the requester has moved on and asks again if it still lacks something (RSY-5, RSY-9),
        // so a change of this engine's after that is no reason to answer it.
        if (now - request.heardAt > this.#resyncExpiryMs(request.all)) {
          this.#seenResyncRequestIds.add(request.id);
          this.#forgetPendingRequest(request, false);
          continue;
        }
        const requested = { stateVector: request.stateVector };
        // What this device sends as control state (RSY-8): what it holds, once it is bootstrapped
        // and not in a capacity conflict — complete, not trusted: an empty device would otherwise let
        // a requester take an empty state as complete, and one in a conflict knows that what it holds
        // lacks something (RSY-14, CTL-32).
        const carriesControl = this.#bootstrapped && !this.#control.capacityConflict;
        // Judged by the furthest the requesting stream stated, in this request or in any other frame
        // of it — a later report, a later request, an answer —, so that a request read late is not
        // answered with what its requester holds by then (RSY-17, RSY-20).
        const stated = this.#statedFurthest(request);
        // Something to offer is content the requester lacks, or a register it lacks: a lost
        // decision leaves the content diff empty and still needs healing (RSY-16, RSY-17).
        const hasContent = this.#profile.hasUpdatesSince(this.document, stated.stateVector);
        const held = this.#control;
        const hasControl =
          carriesControl &&
          stated.controlClock !== null &&
          compareClocks(stated.controlClock, held.clock) < 0;
        // Where the requester holds every insertion this responder holds — the same, or more —, another
        // state digest than this responder's own is something to offer too: a deletion the requester
        // lacks travels in the state since its state vector, which carries this responder's whole
        // record of deletions (LOS-12, RSY-17). Deletions only grow, so a digest any of its frames stated
        // with that vector that is this responder's shows that the requester holds them. At an equal
        // control clock, another control digest is a register or the close one of the two lacks.
        const contentDiffers = !hasContent && !stated.stateDigests.includes(this.#stateDigest());
        const controlDiffers =
          carriesControl &&
          stated.controlClock !== null &&
          compareClocks(stated.controlClock, held.clock) === 0 &&
          !stated.controlDigests.includes(held.digest);
        // A responder that would carry control state answers a requester that states none, or one
        // that asks regardless, even with nothing new (RSY-17).
        const mustAnswer = carriesControl && (stated.controlClock === null || request.force);
        const offersContent = hasContent || contentDiffers;
        const offersControl = hasControl || controlDiffers || mustAnswer;
        if (!offersContent && !offersControl) {
          // One this engine may answer only because it asks all is let go once its turn came with
          // nothing to offer (RSY-20): what changes here after that — the requester's own edit among
          // it — reaches the requester as any change does. One it answers at once is let go at once
          // once this engine is bootstrapped: it lacks what the requester lacks, and whoever brings it
          // answers that request, or this engine's own, which every device hears — kept, it would
          // answer again once the gap healed here too, a second answer to one gap (RSY-17, RSY-22).
          // Not bootstrapped, it keeps it within the requester's wait: what it holds may still grow
          // into something that one lacks (RSY-9, RSY-17).
          if (request.turn.kind === "turn" ? now >= request.turn.at : this.#bootstrapped) {
            this.#seenResyncRequestIds.add(request.id);
            this.#forgetPendingRequest(request, false);
          }
          continue;
        }
        // A request to all that answers heard before this engine's turn hold what it would give — its
        // content and its control state as it held them, with what the requester stated — is let go;
        // one whose turn has not come is kept (RSY-9, RSY-19, RSY-20). An answer that holds less —
        // content alone where it would give control state — leaves what it lacks to this engine's turn.
        const action = answerAction(
          request.turn,
          now,
          this.#heldAnswerAt(request.id, offersContent, offersControl),
        );
        if (action === "drop") {
          this.#seenResyncRequestIds.add(request.id);
          this.#forgetPendingRequest(request, false);
          continue;
        }
        if (action === "wait") {
          continue;
        }
        if (
          this.#lastResyncResponseAt !== null &&
          now - this.#lastResyncResponseAt < this.#resyncResponseThrottleMs
        ) {
          continue; // still reconsidered on a later tick
        }

        // Computed before the request counts as answered: one whose answer the profile fails to
        // compute is let go and reported below, and neither takes this engine's throttle nor
        // moves its requester to the end of the order (RSY-9, RSY-19).
        const update = this.#profile.encodeStateSince(this.document, requested.stateVector);
        // Always this responder's own current attribution state, sent
        // unconditionally — whether to adopt it wholesale (true bootstrap)
        // or ignore it entirely (partial gap-heal) is the *requester's*
        // decision to make on receipt, not this responder's to pre-judge
        // (SPECIFICATION.md §5.4).
        const attributionOverlay = this.attribution.toJSON();
        const control: ControlSnapshot | null = carriesControl ? this.controlState : null;
        this.#seenResyncRequestIds.add(request.id);
        this.#forgetPendingRequest(request, true);
        this.#lastResyncResponseAt = now;
        // Not awaited: the answer waits for the floor in the scheduler (RSY-11), and a poll must not
        // wait with it. What fails on the way — a send, or splitting it into pieces — comes back here.
        this.#broadcastResyncResponse(request.id, update, attributionOverlay, control).catch(
          (error: unknown) => this.#keepRequestAfterFailedAnswer(request, error),
        );
      } catch (error) {
        // A request the profile fails on while answering must not keep the others from their
        // answers (RSY-9; §1.7 item 11): reported once, with the request it was for, and not kept
        // to fail again on every tick.
        this.#seenResyncRequestIds.add(request.id);
        this.#forgetPendingRequest(request, false);
        this.#onError(new ResyncAnswerError(request.id, request.requester, error), "broadcast");
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
    if (!classifySendFailure(error).retryable) {
      // Dropped for good, whole or in pieces: reported once, here, and as the transport
      // profile's fault when its own limit allowed the message (SND-8, SND-22). Nothing of this
      // client's own is missing anywhere, so it does not count as undistributed.
      this.#onError(this.#blameProfileFor(error), "broadcast");
      return;
    }
    const kept = this.#pendingResyncRequests.get(request.requester) ?? [];
    if (kept.length >= MAX_REQUESTS_PER_REQUESTER) {
      return;
    }
    this.#seenResyncRequestIds.delete(request.id);
    // Kept as before (RSY-9, RSY-19): it had the turn, so its requester goes back to the front of
    // the order, where serving it took it from, and is answered next.
    const others = [...this.#pendingResyncRequests].filter(
      ([requester]) => requester !== request.requester,
    );
    this.#pendingResyncRequests.clear();
    this.#pendingResyncRequests.set(request.requester, [request, ...kept]);
    for (const [requester, waiting] of others) this.#pendingResyncRequests.set(requester, waiting);
  }

  /**
   * Considers adopting `attributionOverlay` for a true-bootstrap resync
   * request this client itself made (SPECIFICATION.md
   * §5.4, RSY-15). **The first overlay adopted stands**: the first answer that bootstraps a joiner
   * brings it, and a creator that restarted has one requester and nothing to choose between. The response's document content is applied
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
   * `authorId === null` — unattributed, what `sync()` sets on
   * every resync-response's content by default, before this method ever
   * runs, and on restored content without attribution — so it can only ever touch content this exact
   * mechanism introduced, never a range this client typed itself or
   * received via a normal delivery. Skipping *all* adoption once this
   * client has made any local edit would protect that edit, but would also
   * leave every bootstrap content that arrives afterward unattributed for
   * good — including content unrelated to the local edit, as happens when
   * two authors type within moments of each other, one of them
   * mid-bootstrap.
   */
  #considerBootstrapOverlay(attributionOverlay: AttributionOverlay | null): void {
    if (this.#overlayAdopted) {
      return;
    }
    // No overlay offered: the content stays unattributed, as `sync()` left it before calling
    // this. A malformed overlay never gets here — the decoder rejected the
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
      this.attribution.reattributeMatching((authorId) => authorId === null, snapshot);
    }
    this.#overlayAdopted = true;
  }

  /**
   * The policy this client runs: its own choice under the transport's suggestion and bounds
   * (SND-16), with the creator's pace as a floor (SND-15).
   */
  #effectivePolicy(): SyncPolicy {
    return this.#policyUnder(this.#control.pace);
  }

  /** The policy this client runs under `pace`: the one it holds now, or one it is about to issue. */
  #policyUnder(pace: number | undefined): SyncPolicy {
    const own = effectiveSyncPolicy(this.#transport, this.#chosen);
    const floor = Math.min(pace ?? 0, MAX_PACE_MS);
    return floor > own.minIntervalMs ? resolveSyncPolicy({ ...own, minIntervalMs: floor }) : own;
  }

  /**
   * Gives up what the profile holds for missing predecessors once it is more than the bound
   * (LOS-23): anyone in the channel can send updates whose predecessors never come (CTL-7). What it
   * gave up is as if it had missed those deliveries: *history truncated* evidence, which asks at
   * once and ends as LOS-19 and LOS-20 say.
   */
  #boundPending(): void {
    const bytes = this.#profile.pendingBytes(this.document);
    if (bytes <= MAX_PENDING_BYTES) {
      return;
    }
    this.#profile.giveUpPending(this.document);
    this.#noticeTruncatedHistory();
    this.#onError(
      new Error(
        `gave up ${bytes} bytes held for missing predecessors, more than the ${MAX_PENDING_BYTES} it holds (LOS-23)`,
      ),
      "apply",
    );
  }

  /** Runs a pace the creator changed from now on, in the scheduler and in `syncPolicy`. */
  #followPace(): void {
    const next = this.#effectivePolicy();
    if (
      next.minIntervalMs !== this.#syncPolicy.minIntervalMs ||
      next.maxIntervalMs !== this.#syncPolicy.maxIntervalMs
    ) {
      this.#syncPolicy = next;
      this.#scheduler.setPolicy(next);
    }
  }

  /**
   * An answer to this client's own request carried control state (RSY-14) — which already freed the
   * request slot and ended the silence it expected —, on a device of the creator one of another device
   * of the creator's. It bootstraps this client, also where merging it led into a capacity conflict
   * (CTL-32). `answered` is the digest of the
   * control state the answer carried. A device of the creator that holds other control state after
   * it — registers it merged from members' answers before (CTL-25) — owes a report at once: its
   * control clock and digest, stated from now on, show members what they lack, and the device that
   * answered holds less (SND-11, LOS-10, LOS-12). One that holds just what the answer stated owes none:
   * its next report states it — a `control` frame states it too, but is no evidence (LOS-12).
   */
  #completeBootstrap(answered: string): void {
    if (this.#bootstrapped) {
      return;
    }
    this.#bootstrapped = true;
    if (this.#creatorMemberId === this.memberId && this.#control.digest !== answered) {
      this.#scheduler.oweReport({ now: true });
    }
    // Persisted from now on as taken once bootstrapped, so a restart may use it (CTL-26, CTL-39).
    this.#notifyControlStateChange();
  }

  /**
   * A device of the creator decides `value` on `target` (CTL-20, CTL-21, CTL-45): a register with a
   * clock above its own and above the register it holds on that target, so that it holds over it
   * wherever both arrive; the decision goes out as a `control` frame (`#decide`).
   */
  async #issueControl(target: ControlTarget, value: ControlValue): Promise<void> {
    this.#assertMayDecide();
    // Only the creator's own state, which its other devices, a restore or a carried state bring, is the
    // ground a decision is made on; before it, the device closes or nothing (CTL-27, RSY-14).
    if (!this.#bootstrapped) {
      throw new SendRefusedError(
        "not-bootstrapped",
        `this device of the creator of ${this.documentId} holds none of the creator's state yet: it decides nothing but the close and its reason (CTL-27)`,
      );
    }
    this.#device ??= newDeviceTag();
    const device = this.#device;
    const held = this.#control.registerOf(target);
    const decided = decideRegister({
      held: { closed: false, targets: held === undefined ? {} : { [target]: held } },
      target,
      value,
      device,
      own: this.#clock,
      now: Date.now(),
    });
    if (decided === undefined) {
      throw new SendRefusedError(
        "clock-exhausted",
        `no clock orders a decision on ${target} above the one held: continue in a new document (CTL-45)`,
      );
    }
    // Over the bounds of control state the decision would not hold anywhere, a new target goes only
    // up to the bytes a device decides to, and in a capacity conflict there is none (CTL-37, CTL-32).
    const issued = this.#control.issue(target, decided.register);
    if ("refused" in issued) {
      throw new SendRefusedError(
        issued.refused,
        issued.refused === "capacity-conflict"
          ? `${this.documentId} is in a capacity conflict: no new member or layer right can be held`
          : `the control state of ${this.documentId} would exceed its bounds (a new member or layer right: ${MAX_ISSUE_BYTES} bytes)`,
      );
    }
    await this.#decide(issued.next, { [target]: decided.register }, decided.own);
  }

  /** A device of the creator closes the document (LIF-6, LIF-7): a frame without registers, outside every bound (CTL-36). */
  async #issueClose(reason?: string): Promise<void> {
    this.#assertMayDecide();
    this.#device ??= newDeviceTag();
    const next = this.#control.copy();
    next.close();
    if (reason === undefined) {
      await this.#decide(next, {}, this.#clock);
      return;
    }
    // The reason in the same frame as the close (CTL-23): outside every bound, as the close is (CTL-36).
    const decided = this.#closeReasonRegister(reason);
    next.take({ closed: true, targets: { [CLOSE_REASON]: decided.register } });
    await this.#decide(next, { [CLOSE_REASON]: decided.register }, decided.own);
  }

  /** The register a device of the creator decides the reason for the close with (CTL-21, CTL-23). */
  #closeReasonRegister(reason: string): { readonly register: Register; readonly own: Clock } {
    const held = this.#control.registerOf(CLOSE_REASON);
    const decided = decideRegister({
      held: { closed: false, targets: held === undefined ? {} : { [CLOSE_REASON]: held } },
      target: CLOSE_REASON,
      value: reason,
      device: this.#device as string,
      own: this.#clock,
      now: Date.now(),
    });
    if (decided === undefined) {
      throw new SendRefusedError(
        "clock-exhausted",
        `no clock orders a reason for the close above the one held: continue in a new document (CTL-45)`,
      );
    }
    return decided;
  }

  /** Refuses a decision of anyone but a device of the creator, and any after the close (LIF-6). */
  #assertMayDecide(): void {
    if (this.#creatorMemberId !== this.memberId) {
      throw new Error(`${this.memberId} is not the creator of ${this.documentId}`);
    }
    if (this.#control.closed) {
      throw new SendRefusedError("closed", `document is closed: ${this.documentId}`);
    }
  }

  /**
   * A device of the creator's decision path (CTL-21, CTL-26): the control state it holds after the
   * decision, and its own clock after it, are persisted before anything changes or is sent; a failure
   * to persist changes nothing. It then holds here at once, as a pending change, and its frame is
   * sent until the transport accepts it; the action resolves only then. Offline it waits, and holds
   * meanwhile — what the person decided shows at once, as typed text does.
   */
  async #decide(
    next: ControlState,
    targets: Readonly<Record<string, Register>>,
    clock: Clock,
  ): Promise<void> {
    // Its control clock and digest only once it is bootstrapped (RSY-14); before, its one decision is
    // the close (CTL-27).
    const text = encodeControlFrame({
      documentId: this.documentId,
      device: this.#device as string,
      targets,
      closed: next.closed,
      controlClock: this.#bootstrapped ? next.clock : null,
      controlDigest: this.#bootstrapped ? next.digest : null,
    });
    if (this.#maxBytes !== undefined && Object.keys(targets).length > 0) {
      // Nor would a joiner get it: an answer carries the snapshot whole, beside an empty update at
      // the least (SND-18). The close goes whatever: a document no joiner can bootstrap from is
      // still closed for everyone who holds it (CTL-37, LIF-7).
      const state = next.state();
      const answer = encodeResyncResponseFrame({
        documentId: this.documentId,
        respondsTo: "0".repeat(16),
        update: this.#profile.encodeState(this.#profile.createEmpty()),
        control: { profile: this.#profile.id, closed: state.closed, targets: state.targets },
        state: this.#ownState(),
        // As long as a stream's numbers can be (LOS-13, LOS-14).
        stream: this.#stream,
        sequence: 0xffffffff,
        piece: 0xffffffff,
        extensions: this.#outgoing.get("resync-response"),
      });
      if (frameByteLength(answer) > this.#maxBytes) {
        throw new SendRefusedError(
          "too-large",
          `the control state of ${this.documentId} would no longer fit in one answer of at most ${this.#maxBytes} bytes`,
        );
      }
    }
    this.#onControlStateChange?.(this.#persisted(next, clock, [...this.#unsent.values(), text]));
    this.#devicePersisted = this.#device !== undefined;
    this.#clock = clock;
    this.#control = next;
    this.#unsent.set(text, text);
    try {
      await this.#sendControlFrame(text, text);
    } finally {
      // A new pace governs this device's sending once the frame announcing it is out, so the frame
      // does not wait for the very floor it sets (SND-15).
      this.#followPace();
    }
  }

  /**
   * Sends one control frame of this device until the transport accepts it (SND-6, SND-7): then it is
   * no longer unsent. Refused for good, it is given up — its decision still holds here and travels in
   * every snapshot this device sends. A `dispose()` meanwhile leaves it unsent, and persisted, for
   * the restarted engine.
   */
  async #sendControlFrame(key: string, text: string): Promise<void> {
    let id: DeliveryId;
    try {
      // Through the scheduler, on the floor like any message (SND-2); a decision of its own goes on with
      // the phase of its sending, and the report that ends the phase sends it again first, once
      // (SND-11, SND-27).
      id = await this.#scheduler.submit(
        () => this.#messenger.send(this.documentId, this.memberId, text),
        { retry: true, phase: { kind: "control", text } },
      );
    } catch (error) {
      if (!classifySendFailure(error).retryable) {
        this.#unsent.delete(key);
        this.#notifyControlStateChange();
      }
      throw error;
    }
    this.#markOwnSend(id);
    this.#unsent.delete(key);
    this.#notifyControlStateChange();
  }

  /**
   * Merges a `control` frame's registers and its close if, and only if, its sender is the creator and
   * no register names the creator (CTL-5, CTL-6); merging one already held changes nothing. Throws
   * `ControlFrameRejectedError` for a frame that must not count at all, and for registers its bounds
   * kept out (CTL-30, CTL-32) — the close it takes all the same (CTL-36). A bootstrapped device of the
   * creator that the merge changed owes a report at once, as after merging a snapshot: a register below
   * its control clock changes its digest and not its clock, and only a report shows members the digest
   * (SND-11, LOS-12).
   */
  #applyControlFrame(frame: ControlFrame, sender: MemberId): void {
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
    if (Object.keys(frame.targets).some((target) => memberOf(target) === this.#creatorMemberId)) {
      throw new ControlFrameRejectedError(
        "names-the-creator",
        "control frame ignored: the creator's own permission is fixed and cannot be changed",
      );
    }
    // Only a bootstrapped device of the creator reports its control digest, so only there is it worth
    // computing (SND-11).
    const reports = this.#creatorMemberId === this.memberId && this.#bootstrapped;
    const before = reports ? this.#control.digest : undefined;
    const { refused, leftOut } = this.#control.take({
      closed: frame.closed,
      targets: frame.targets,
    });
    this.#followControlClock();
    if (reports && this.#control.digest !== before) {
      this.#scheduler.oweReport({ now: true });
    }
    if (refused || leftOut > 0) {
      // What it took — the close, a conflict — is persisted before the refusal is reported (CTL-32).
      this.#followPace();
      this.#notifyControlStateChange();
      throw new ControlFrameRejectedError(
        "refused",
        refused
          ? "control frame not held: it would exceed this client's bounds of control state, a capacity conflict (CTL-32)"
          : "control frame not held whole: in a capacity conflict, this client takes no new member or layer right (CTL-32)",
      );
    }
  }

  /**
   * A device of the creator raises its own clock to what it merged, within the span (CTL-45), so that
   * its next decision lies above it.
   */
  #followControlClock(): void {
    if (this.#creatorMemberId === this.memberId) {
      this.#clock = raiseClock(this.#clock, this.#control.clock, Date.now());
    }
  }

  /** This client's control state as it persists it (CTL-26, CTL-39), with the draft that wrote it (VER-3). */
  #persisted(
    control: ControlState,
    clock: Clock,
    unsent: readonly string[],
  ): PersistedControlState {
    const creator = this.#creatorMemberId === this.memberId;
    return {
      tdsp: CURRENT_FRAME_VERSION,
      profile: this.#profile.id,
      control: control.state(),
      ...(this.#device === undefined ? {} : { device: this.#device }),
      ...(creator ? { clock: [clock[0], clock[1]] as Clock } : {}),
      ...(unsent.length === 0 ? {} : { unsent: [...unsent] }),
      ...(this.#bootstrapped ? { bootstrapped: true } : {}),
      ...(control.capacityConflict ? { capacityConflict: true } : {}),
    };
  }

  #notifyControlStateChange(): void {
    this.#onControlStateChange?.(
      this.#persisted(this.#control, this.#clock, [...this.#unsent.values()]),
    );
    this.#devicePersisted = this.#device !== undefined;
    this.#noticeStanding();
  }

  /**
   * Merges a snapshot (CTL-25), already checked in full by the decoder, register by register: it never
   * undoes anything, so it need not be newer than what this client holds, and never reopens a closed
   * document. What the bounds refuse is a capacity conflict (CTL-30, CTL-32), which it reports. A
   * bootstrapped device of the creator that it changed owes a report at once: members that hold less
   * see its control clock or digest and ask (SND-11, LOS-10, LOS-12) — one for any number of such
   * merges before it goes.
   */
  #applyControlSnapshot(snapshot: DecodedSnapshot): void {
    const before = this.#control.digest;
    const { leftOut, refused } = this.#control.take({
      closed: snapshot.closed,
      targets: snapshot.targets,
    });
    if (leftOut > 0) {
      this.#onError(
        new ControlFrameRejectedError(
          "refused",
          refused
            ? "a control snapshot not held: it would exceed this client's bounds of control state, a capacity conflict (CTL-32)"
            : `${leftOut} register(s) of a control snapshot not held: in a capacity conflict, this client takes no new member or layer right (CTL-32)`,
        ),
        "apply",
      );
    }
    this.#followControlClock();
    if (
      this.#creatorMemberId === this.memberId &&
      this.#bootstrapped &&
      this.#control.digest !== before
    ) {
      this.#scheduler.oweReport({ now: true });
    }
    this.#followPace();
    this.#notifyControlStateChange();
  }
}

/**
 * Whether `snapshot` holds what `held` holds (RSY-20): on every target `held` holds a register for,
 * that register or one that holds over it (CTL-22), and the close where `held` holds it — so that a
 * requester that merges the snapshot holds every register and the close of `held`.
 */
function snapshotHolds(snapshot: DecodedSnapshot, held: ControlState): boolean {
  if (held.closed && !snapshot.closed) {
    return false;
  }
  for (const [target, register] of Object.entries(held.state().targets)) {
    const theirs = Object.hasOwn(snapshot.targets, target) ? snapshot.targets[target] : undefined;
    if (theirs === undefined || compareRegisters(target, theirs, register) < 0) {
      return false;
    }
  }
  return true;
}

/**
 * Persisted control state as the engine reads it back (CTL-26, CTL-39): with its registers, or
 * `undefined` for a state another draft wrote (VER-3), or one that holds no registers in this draft's
 * form, which counts as no control state at all.
 */
function readPersisted(
  state: PersistedControlState | undefined,
): { readonly state: PersistedControlState; readonly control: RegisterState } | undefined {
  if (
    state === undefined ||
    state === null ||
    typeof state !== "object" ||
    state.tdsp !== CURRENT_FRAME_VERSION
  ) {
    return undefined;
  }
  const control = registerStateFrom(state.control);
  return control === undefined ? undefined : { state, control };
}

/** Whether a persisted own clock is one (CTL-45). */
function isRestoredClock(value: unknown): value is Clock {
  return isClock(value);
}

export { isLayerId, isProfileId } from "./framing";
export {
  encodeInvitation,
  INVITATION_VERSION,
  type Invitation,
  type InvitationProblem,
  invitationFromUrl,
  MAX_INVITATION_RECIPIENTS,
  type ParsedInvitation,
  parseInvitation,
} from "./invitation";
export {
  type DocumentProfile,
  PARAGRAPH_PROJECTION,
  type ProfileProjection,
  SUPPORTED_PROFILES,
  UnsupportedProfileError,
  YJS_PARAGRAPHS_1,
} from "./profile";
