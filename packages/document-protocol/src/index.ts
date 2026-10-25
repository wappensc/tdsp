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
import {
  type ControlAnomaly,
  type ControlOperation,
  ControlState,
  type ControlStateSnapshot,
  type ControlTarget,
  type ControlValue,
  type ControlVector,
  issuingVector,
  MAX_ISSUE_BYTES,
  MAX_TARGETS,
  memberOf,
  newDeviceTag,
  rightIn,
  valueFitsTarget,
  valueOfHeads,
} from "./control-state";
import { controlDigestOf, digestOf } from "./digest";
import {
  type AttributionOverlay,
  bytesToBase64,
  type ControlFrame,
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
} from "./framing";
import {
  type IncompleteAnswer,
  LossDetector,
  lossGraceMs,
  type StateReport,
  type SyncSuspicion,
} from "./loss-detector";
import {
  checkProfileReads,
  type DocumentProfile,
  deletionsOf,
  deletionsWithinOf,
  holderOf,
  profileFor,
  projectionOf,
  splitterOf,
  YJS_PARAGRAPHS_1,
} from "./profile";
import { ResyncGate, type ResyncOutcome, type ResyncStatus } from "./resync-gate";
import { type SendFailureClass, SendScheduler, type SendStatus } from "./send-scheduler";
import { strictJsonProblem } from "./strict-json";
import { effectiveSyncPolicy, resolveSyncPolicy, type SyncPolicy } from "./sync-policy";

export type { ControlTarget, ControlValue } from "./control-state";
export {
  DEFAULT_LOSS_GRACE_MS,
  type IncompleteAnswer,
  type SyncSuspicion,
  type SyncSuspicionKind,
} from "./loss-detector";
export type { ResyncOutcome, ResyncRefusal, ResyncStatus } from "./resync-gate";
export type { SendStatus } from "./send-scheduler";
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

/** How many resync request ids of others an engine remembers, so a copy is not answered twice. */
const MAX_REMEMBERED_REQUESTS = 1024;

/** How many requests still to be answered a responder keeps in all, the oldest dropped first (RSY-19). */
const MAX_PENDING_REQUESTS = 64;

/** How many of them one requester may have: several devices of one member may ask at once (RSY-19). */
const MAX_REQUESTS_PER_REQUESTER = 4;

/** How long a request still to be answered is kept; its requester asks again long before (RSY-4, RSY-5). */
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
 * (SPECIFICATION.md CTL-13): the document is closed, this member's permission is
 * explicitly `read` or revoked, or — for anyone but the creator — the creator has not yet
 * bootstrapped it. **Permanent** — a retry cannot succeed, unlike a rate limit or a
 * disconnection. After the bootstrap an *unknown* permission does not refuse.
 */
export class SendRefusedError extends Error {
  /**
   * `awaiting-bootstrap`: a participant other than the creator has not yet received the
   * creator's answer to its join — it has neither the document's content nor its control state,
   * so an edit of its own would compete with content it cannot see (SPECIFICATION.md CTL-13).
   * `revoked`: the creator revoked this member's permission; refused as `read` is, on the
   * document and on every layer (CTL-13, LAY-5). `capacity-conflict`: this client could not hold
   * an operation of the creator for the bytes of control state and may lack a decision about
   * itself (CTL-32); refused as `read` is, for everyone, the creator's devices included.
   */
  readonly reason:
    | "closed"
    | "read-only"
    | "revoked"
    | "capacity-conflict"
    | "awaiting-bootstrap"
    | "too-large";

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
 * Whether a right refuses this client's own edits (CTL-13): `read`, and a revoked permission —
 * an explicitly revoked member is not one the creator has not named yet. Unknown refuses nothing.
 */
function refuses(right: Permission | "revoked" | undefined): boolean {
  return right === "read" || right === "revoked";
}

/** The smallest piece worth sending: below it a transport's limit leaves no room for content. */
const MIN_PIECE_BYTES = 16;

/**
 * The transport's limit leaves no useful room for a piece beside a frame's other fields, or for an
 * answer's control state: the change is dropped and reported (SND-8), permanently.
 */
export class PieceTooSmallError extends Error {
  constructor(maxBytes: number, overhead: number) {
    super(
      `a message of at most ${maxBytes} bytes leaves no room for a piece: ${overhead} bytes are taken by the frame's other fields`,
    );
    this.name = "PieceTooSmallError";
  }
}

export { UnsplittableUpdateError };

/**
 * What a client running `policy` promises with each edit and control frame (SND-14): it sends
 * again within its longest wait at the latest — the heartbeat, if nothing else — or promises
 * nothing.
 */
function dueOf(policy: SyncPolicy): number {
  const wait = policy.maxIntervalMs;
  return Number.isFinite(wait) ? Math.min(Math.round(wait), 0xffffffff) : 0;
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
  // A control frame whose number another device of the creator took is never worth sending.
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
 * Thrown (and routed to `onError(..., "apply")`) for a control frame this client
 * must not act on. `stale` frames — a replay, or one already superseded — are
 * *not* an error and are dropped silently: idempotence is the point.
 */
export class ControlFrameRejectedError extends Error {
  /**
   * `refused`: an operation from the creator this client does not hold, or parts of a snapshot,
   * because they would exceed a bound on creator devices, holes or targets (CTL-30). `anomaly`: two
   * different operations under one device and counter (CTL-24) — merged into one, and this is the
   * report.
   */
  readonly reason:
    | "not-from-creator"
    | "creator-unknown"
    | "names-the-creator"
    | "refused"
    | "anomaly";

  constructor(reason: ControlFrameRejectedError["reason"], message: string) {
    super(message);
    this.name = "ControlFrameRejectedError";
    this.reason = reason;
  }
}

/**
 * The creator's control state as a snapshot carries it (CTL-25): the document's
 * profile (CTL-10), the control vector and, per target, what its operations had seen and the
 * operations nothing supersedes. A joiner, or a client that found a hole, needs nothing else.
 */
export interface ControlSnapshot extends ControlStateSnapshot {
  readonly profile: string;
}

/**
 * A target on which a member's latest report holds an operation that this device of the creator
 * neither holds unsuperseded nor supersedes (CTL-33): what only members hold — a decision of a
 * device of the creator that vanished, say, or another operation under one device and counter. For
 * display only (CTL-29): nothing of it holds here until the person confirms (`confirmRights`).
 */
export interface ControlDivergence {
  /** The member whose latest report shows it. */
  readonly reporter: MemberId;
  readonly target: ControlTarget;
  /** The value the report gives the target (CTL-23), as the member holds it; `true` for a close. */
  readonly reported: ControlValue | undefined;
  /** The value this device gives the target; `undefined` where it holds no operation on it. */
  readonly held: ControlValue | undefined;
}

/** What a member's report holds beyond this device, per target (CTL-33): its value and the operations. */
interface ReportedDivergence {
  readonly reported: ControlValue | undefined;
  readonly heads: readonly Omit<ControlOperation, "target">[];
}

/**
 * What a device of the creator persists and restores (CTL-26): its control state, its device tag
 * and counter, and its own operations not yet known to be sent, which a restarted engine sends
 * again. Never sent to anyone: the snapshot in an answer is the plain `ControlSnapshot`.
 */
export interface PersistedControlState {
  readonly profile?: string;
  readonly control: ControlStateSnapshot;
  /** This device's tag (CTL-20). */
  readonly device?: string;
  /** The last counter this device issued under its tag. */
  readonly counter?: number;
  /** The complete texts of this device's control frames not yet known to be sent. */
  readonly unsent?: readonly string[];
  /**
   * For a device of the creator, always written: whether it had a basis for its control state
   * (CTL-28) when the state was taken. Restored, the state is a basis only if it had one, so a new
   * device that restarts is still a new device. A state persisted without the field counts as one
   * with a basis.
   */
  readonly basis?: boolean;
  /**
   * For anyone but the creator: that this client had been bootstrapped (CTL-13, CTL-39) when the
   * state was taken. Restored without it, a non-creator's state is not used at all.
   */
  readonly bootstrapped?: boolean;
  /**
   * That this client was in a capacity conflict when the state was taken (CTL-32): it could not
   * hold an operation or a snapshot for the bytes of control state. Restored, the conflict holds on,
   * since what it could not hold is not read again. Written only when true.
   */
  readonly capacityConflict?: boolean;
}

/**
 * Whether this client has reason to think something is missing. Never a
 * claim that something *is*: every suspicion is evidence that has lasted long enough to be
 * worth a person's attention, and each can have an innocent cause (a late message, a sender
 * who closed the application). What to do about one is a Resync. Nor is `"ok"` a claim that
 * nothing is (SPECIFICATION.md LOS-15): it means no current evidence, never "synchronised" —
 * a creator whose request went `unanswered` may still lack an offline member's change (LOS-20).
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
   * answer's last piece (RSY-14), which may come first: the trust is there, not yet all the content.
   */
  readonly incompleteAnswers: readonly IncompleteAnswer[];
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
 * The kinds of frame this engine writes an extension into. Not a control frame: its operation
 * lives on in snapshots, which carry no extension (FRM-17), so what one added would reach only
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
   * creator's own (a restarted creator may lack content — none persisted, or what
   * arrived while it was away — and only a peer can give it back). A client that does not know the creator answers no
   * one and accepts a resync response from no one.
   */
  creatorMemberId?: MemberId;

  /**
   * This client's control state, as the application last persisted it (CTL-26), given back when
   * it re-attaches to the document with `join()` — `create()` refuses it (LIF-5). For a device of
   * the creator, its device tag and counter continue, what it had not yet sent goes out, and —
   * when the state had a basis (`basis`, CTL-28) — its snapshot to joiners still lists everyone;
   * without it, it is a new device with a new tag (CTL-27). For anyone else it is used only when it was taken once bootstrapped
   * (`bootstrapped`): its rights show at once, and it bootstraps this client after its first
   * read on from `restore.cursor` shows no gap (CTL-39, CTL-41); otherwise the creator's answer
   * does.
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
   * permitted, and the engine still asks for a resync when it joins (RSY-1).
   *
   * `cursor` is `DocumentEngine.cursor` as it stood when `state` was taken, with a transport that
   * offers `receiveSince` (LIF-8): the engine reads on from there, and learns whether its transport
   * still holds everything since — what a restored member's control state needs to bootstrap it.
   * `instance` is `DocumentEngine.instance` as it stood with that cursor, with a transport that names
   * its window's epoch (TRN-19): the first read compares the transport's with it, so a bridge that
   * may have lost something while this client was gone shows it, and one that kept everything does
   * not (LOS-9).
   */
  restore?: {
    readonly state: Uint8Array;
    readonly attribution?: AttributionSnapshot;
    readonly cursor?: DeliveryId;
    readonly instance?: string;
  };

  /**
   * Called after every change to this client's control state — an operation applied, one about
   * to be sent, a snapshot merged — so the application can persist it (see `controlState`). Only
   * a device of the creator's is worth persisting, and it must be persisted before this returns:
   * the call that announces a new operation comes *before* it is sent (CTL-26). A throw there
   * leaves everything as it was, and nothing is sent.
   */
  onControlStateChange?: (state: PersistedControlState) => void;
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
  /** The requester's control vector; `null` while it holds no snapshot from the creator (RSY-16). */
  readonly control: ControlVector | null;
  /** The digest of the requester's control state; `null` with `control` (LOS-12). */
  readonly controlDigest: string | null;
  /** The digest of the requester's content (LOS-12). */
  readonly stateDigest: string;
  /** The requester cannot tell what it lacks and asks for an answer regardless (LOS-9). */
  readonly force: boolean;
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
  /** When a truncated window was noticed; cleared once an answer to this engine's own request applies (LOS-19). */
  #historyTruncatedSince: number | undefined;
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
  #controlDigestCache:
    | { readonly control: ControlState; readonly revision: number; readonly digest: string }
    | undefined;
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
  // Resync request ids *this* client itself originated via
  // requestResync() — a subset of #seenResyncRequestIds, tracked
  // separately so sync() can recognize "a resync-response just answered
  // MY OWN request" without conflating it with requests seen from others
  // (hasCompletedBootstrap).
  #ownResyncRequestIds = new Set<ResyncRequestId>();
  #lastResyncResponseAt: number | null = null;
  // The *true bootstrap* requests this client itself made — never a partial gap-heal request,
  // whose response's overlay is never adopted at all. Read by #considerBootstrapOverlay(); never
  // pruned, same as the other per-request sets above.
  #bootstrapRequestIds = new Set<ResyncRequestId>();
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
  #creatorMemberId: MemberId | undefined;
  readonly #profile: DocumentProfile;
  #onControlStateChange: ((state: PersistedControlState) => void) | undefined;
  #onDecline: ((decline: ReceivedDecline) => void) | undefined;
  readonly #declinesReported = new Set<MemberId>();
  // --- control state (§7) ---
  // The operations of the creator's devices, merged by union (CTL-23, CTL-25). The creator is
  // implicit and never a target; a member without a permission is *unknown*, not denied.
  #control = new ControlState();
  // A device of the creator's tag and the last counter it issued (CTL-20); none for anyone else.
  #device: string | undefined;
  #counter = 0;
  // This device's operations not yet known to be sent, by "device:counter" (CTL-26).
  readonly #unsent = new Map<string, string>();

  // Counters participants reported, which a device of the creator without a basis counts as seen
  // when it issues (CTL-27): only ever raised, never a source of values, and dropped once it has a
  // basis (`#gainBasis`).
  #reported: Record<string, number> = {};
  // The latest control state a participant other than the creator reported, for display only (CTL-29).
  #reportedState: ControlSnapshot | undefined;
  // Per member, what its latest report holds that this device of the creator neither holds nor
  // supersedes (CTL-33), oldest reporter first; at most MAX_TARGETS targets in all.
  readonly #divergences = new Map<MemberId, Map<string, ReportedDivergence>>();
  // Whether this device of the creator has a basis for its control state (CTL-28) — it created the
  // document, restored its state that was one, or merged a snapshot another of its devices sent in
  // answer to its own request. Reports, its own new operations, and the creator's operations and
  // snapshots it overheard are none: the wire does not say whether the device that issued them had a
  // basis. Without one it answers a request with a snapshot only when it decided about the
  // requester itself (`#decidedHere`).
  #controlBasis = false;
  // The members this device of the creator decided about itself, under its tag, in this instance or
  // as its restored state shows (CTL-28): whom it may bootstrap without a basis.
  readonly #decidedHere = new Set<MemberId>();
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
  // The one slot a resync request of this client's own may hold, however many things ask.
  #resyncGate = new ResyncGate();
  #autoResync: boolean;
  // Automatic requests made in the current episode of suspicion (reset when it clears), and
  // when the last automatic attempt was made, whether or not the send went through.
  #automaticLossAttempts = 0;
  #automaticBootstrapAttempts = 0;
  #lastAutomaticAttemptAt: number | null = null;
  // Counts the episodes of suspicion, so that a request that goes out after its episode ended is
  // not counted against the next one.
  #lossEpisode = 0;
  // A request of this client's own has taken the slot and waits in the scheduler to go out.
  #requestWaiting = false;
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
    this.#resyncResponseThrottleMs = options.resyncResponseThrottleMs ?? 1000;
    this.#creatorMemberId = options.creatorMemberId;
    this.#profile = profileFor(options.profile ?? YJS_PARAGRAPHS_1, options.profiles);
    this.#autoResync = options.autoResync ?? true;
    this.#onControlStateChange = options.onControlStateChange;
    this.#onDecline = options.onDecline;
    if (
      options.controlState !== undefined &&
      options.creatorMemberId !== memberId &&
      options.controlState.bootstrapped === true
    ) {
      // The creator's operations as this client last held them: they show at once, and count as a
      // bootstrap only after a first read on from the persisted cursor without a gap (CTL-39, CTL-41).
      this.#control = ControlState.from(options.controlState.control);
      this.#restoredBootstrapPending = options.restore?.cursor !== undefined;
      if (options.controlState.capacityConflict === true) this.#control.markCapacityConflict();
    }
    this.#cursor = options.restore?.cursor;
    this.#instance = options.restore?.instance;
    if (options.controlState !== undefined && options.creatorMemberId === memberId) {
      const state = options.controlState;
      this.#control = ControlState.from(state.control);
      if (state.capacityConflict === true) this.#control.markCapacityConflict();
      this.#device = state.device;
      this.#counter = state.counter ?? 0;
      for (const text of state.unsent ?? []) {
        const frame = decodeFrame(text);
        if (frame.kind === "control") {
          this.#unsent.set(`${frame.device}:${frame.counter}`, text);
          // Already part of the persisted state when this device issued it; a duplicate is inert.
          this.#control.add({
            device: frame.device,
            counter: frame.counter,
            target: frame.target,
            value: frame.value,
            seen: frame.seen,
          });
          this.#counter = Math.max(
            this.#counter,
            frame.device === state.device ? frame.counter : 0,
          );
        }
      }
      // What it restores is a basis only if it was one (CTL-28): its own new operations and what
      // participants reported are none, before a restart or after it. Whom it decided about itself
      // is what its operations under its tag still show; one another device superseded since is
      // given up, which only makes it answer with less (CTL-28).
      if (state.basis !== false) {
        this.#gainBasis();
      }
      for (const [target, held] of Object.entries(this.#control.snapshot().targets)) {
        const member = memberOf(target as ControlTarget);
        if (
          target.startsWith("member:") &&
          member !== undefined &&
          held.heads.some((head) => head.device === state.device)
        ) {
          this.#decidedHere.add(member);
        }
      }
    }
    if (options.creatorMemberId === memberId && this.#device === undefined) {
      // A device of the creator without a tag of its own is a new device (CTL-20, CTL-27).
      this.#device = newDeviceTag();
    }
    this.#chosen = options.syncPolicy;
    this.#syncPolicy = this.#effectivePolicy();

    const editFrameOverhead =
      frameByteLength(
        encodeEditFrame(documentId, new Uint8Array(3), 0xffffffff, this.#outgoing.get("edit")),
      ) - 4;
    this.#scheduler = new SendScheduler({
      quietMs: options.batchWindowMs ?? 500,
      policy: this.#syncPolicy,
      send: (update, roots) => this.#broadcast(update, roots),
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
              pieces: (update, roots) => {
                // Splitting an edit is where it is refused if this client may not send one:
                // the same permanent refusal a whole edit gets (`SendRefusedError`).
                this.#assertMayChange(roots);
                return this.#editFramesOf(update);
              },
              sendFrame: (frame) => this.#sendFrame(frame),
            },
    });
    this.#detector = new LossDetector({
      creatorMemberId: () => this.#creatorMemberId,
      policy: () => this.#syncPolicy,
      pendingGapClients: () => this.#profile.pendingGapClients(this.document),
      lacksUpdatesOf: (stateVector) => this.#profile.lacksUpdatesOf(this.document, stateVector),
      controlHoles: () => this.#control.hasHoles,
      lacksControlOf: (vector) => this.#control.lacksAnyOf(vector),
      stateDigestWithin: (stateVector) => this.#stateDigestWithin(stateVector),
      sameControlVector: (vector) => this.#control.hasVector(vector),
      controlDigest: () => this.#controlDigest(),
      isCreatorDevice: () => this.#creatorMemberId === this.memberId,
      pace: () => this.#runningPace(),
    });

    this.#unobserve = observeUpdates(this.document, (update, origin, transaction) => {
      this.#stateDigestCache = undefined;
      this.#stateDigestWithinCache.clear();
      if (origin === REMOTE_ORIGIN) {
        return;
      }
      const chars = this.#localChars;
      this.#localChars = 0;
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
    client.#gainBasis();
    // Reported before the start frame goes out, though nothing is decided yet: its device tag and
    // its basis are what a restart of this device restores (CTL-26, CTL-28). Without it, a creator
    // that never issued an operation restarts as a device without a basis. If it cannot be
    // persisted, nothing has left the device, and creating it again is no second start (LIF-5).
    try {
      client.#notifyControlStateChange();
    } catch (error) {
      client.dispose();
      throw error;
    }
    // Sent explicitly (not via the observer, which only attaches after
    // this point, and never batched, regardless of batchWindowMs) so the
    // seed is one clean send, not a duplicate.
    const seedFrame = encodeEditFrame(
      documentId,
      profile.encodeState(document),
      client.#due(),
      client.#outgoing.get("edit"),
    );
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
    const profile = profileFor(options.profile ?? YJS_PARAGRAPHS_1, options.profiles);
    // Persisted state names the document's profile; resuming under another would read the
    // content wrongly, and for the creator announce a profile everyone rejects (PRF-6).
    const persistedProfile = options.controlState?.profile;
    if (
      (options.creatorMemberId === memberId || options.controlState?.bootstrapped === true) &&
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
    const client = new DocumentEngine(
      documentId,
      memberId,
      messenger,
      onError,
      document,
      options,
      transport,
    );
    if (options.restore !== undefined) {
      client.#startFromRestored(options.restore.attribution);
      // A device of the creator that restores its content and a basis for its control state holds
      // what its bootstrap would bring: no answer is owed to it, and a peer holding nothing it lacks
      // rightly stays silent (RSY-17). Its request still goes out (RSY-1).
      if (memberId === options.creatorMemberId && client.#controlBasis) {
        client.#hasCompletedBootstrap = true;
      }
    }
    try {
      await client.requestResync();
    } catch {
      // A request is no change of this client's: its failure is not reported as a dropped one
      // (SND-10). The joiner asks again by itself (RSY-5), and `syncHealth.resync` shows the slot.
    }
    await client.sync();
    // Operations of this device not known to be sent before a restart go out again now,
    // unchanged — a duplicate is inert (CTL-26). Not awaited: offline, it may take as long as
    // the outage.
    for (const [key, text] of client.#unsent) {
      client.#sendControlFrame(key, text).catch((error: unknown) => onError(error, "broadcast"));
    }
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
   * for a send window, `retrying` after a failed send, or `needs-person` after a refusal only
   * the person can lift (TRN-20) — with how many times it has failed, when the next attempt is
   * due, and the failure's message. What a connection indicator should show for "my edits have
   * not gone out". Once the person acted, `flush()` sends at once.
   */
  get sendStatus(): SendStatus {
    return this.#scheduler.status;
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
      incompleteAnswers: this.#detector.incompleteAnswers(),
    };
  }

  /**
   * Two different operations under one device and counter that this client holds (CTL-24): both
   * are merged, so nothing is stuck; what an application may show in a diagnosis. In memory only.
   */
  get controlAnomalies(): readonly ControlAnomaly[] {
    return this.#control.anomalies;
  }

  /**
   * The control state a participant other than the creator last reported to this device of the
   * creator (CTL-27, CTL-29): never applied, only something an application may show as
   * unconfirmed while this device lacks the creator's own operations. `undefined` when none came.
   */
  get reportedControlState(): ControlSnapshot | undefined {
    return this.#reportedState;
  }

  /**
   * On a device of the creator, the targets on which a member's latest report holds an operation
   * this device neither holds unsuperseded nor supersedes (CTL-33), by reporter: what only members
   * hold, with the value the report gives each target and the value it has here — for display only
   * (CTL-29). Automatic is only a collision under one device and counter and the union of snapshots
   * (CTL-24, CTL-25); this stays until the person decides, by `confirmRights()` or by deciding the
   * target again in knowledge of it. Empty for anyone but the creator. In memory: a restarted
   * device learns it again from the answers to its request (RSY-1, RSY-17).
   */
  get controlDivergences(): readonly ControlDivergence[] {
    const result: ControlDivergence[] = [];
    for (const [reporter, targets] of this.#divergences) {
      for (const [target, divergence] of targets) {
        if (!divergence.heads.some((head) => !this.#control.knows(target, head))) {
          targets.delete(target); // decided since: nothing of it is beyond this device any more
          continue;
        }
        result.push({
          reporter,
          target: target as ControlTarget,
          reported: divergence.reported,
          held: this.#control.valueOf(target),
        });
      }
      if (targets.size === 0) this.#divergences.delete(reporter);
    }
    return result;
  }

  /**
   * The person's decision on every divergence a member reported (CTL-33): issues each diverging
   * target again — but the close, which nothing undoes (LIF-7) — and counts as seen the counters of
   * the operations the reports hold there, so that the new decision supersedes them everywhere. The
   * value is the one `values` gives the target, the person's choice — the held or the reported value
   * an application shows, say, or another; without one, the value this device holds, revoked or
   * inherit (`null`) where it holds none, the pace 0. `values` may name only diverging targets but
   * the close, each with a value the target can take; otherwise nothing is issued. The one place a
   * device with a basis counts reported counters as seen (CTL-27, CTL-28), and only on this explicit
   * call: a report supplies no value that holds unless the person chose it. A device of the creator
   * only; resolves once every operation went out, as `setMembership` does.
   */
  async confirmRights(values?: ReadonlyMap<ControlTarget, ControlValue>): Promise<void> {
    if (this.#creatorMemberId !== this.memberId) {
      throw new Error(`${this.memberId} is not the creator of ${this.documentId}`);
    }
    const divergences = this.controlDivergences.filter(
      (divergence) => divergence.target !== "close",
    );
    const diverging = new Set<string>(divergences.map((divergence) => divergence.target));
    // Checked whole before anything is issued: a choice the call cannot take changes nothing.
    for (const [target, value] of values ?? []) {
      if (!diverging.has(target)) {
        throw new Error(`${target} is no divergence this device can confirm (CTL-33)`);
      }
      if (!valueFitsTarget(target, value) || target === "close") {
        throw new Error(`${target} cannot take ${String(value)} (CTL-20)`);
      }
    }
    if (divergences.length === 0) {
      return;
    }
    const covered: Record<string, number> = {};
    for (const [, targets] of this.#divergences) {
      for (const [target, divergence] of targets) {
        if (target === "close") continue;
        for (const head of divergence.heads) {
          if (head.counter > (covered[head.device] ?? 0)) covered[head.device] = head.counter;
        }
      }
    }
    // An operation under this device's own tag beyond its counter is another copy's: under a new tag
    // this device can count it as seen (CTL-22, CTL-24).
    if (this.#device !== undefined && (covered[this.#device] ?? 0) > this.#counter) {
      this.#leaveOwnTag();
    }
    const targets = [...new Set(divergences.map((divergence) => divergence.target))].sort();
    await Promise.all(
      targets.map((target) => {
        // A choice of `null` is a choice too: revoked, or inherit on a layer.
        const value =
          values?.has(target) === true
            ? (values.get(target) as ControlValue)
            : (this.#control.valueOf(target) ?? (target === "pace" ? 0 : null));
        return this.#issueControl(target, value, covered);
      }),
    );
  }

  /**
   * Whether this client's control state is confirmed (CTL-28, CTL-29): always for anyone but the
   * creator, who learns it from the creator; for a device of the creator once it has a basis — it
   * created the document, restored its state that had one, or merged a snapshot another of its
   * devices sent in answer to its own request. A device without one may still decide, but what it
   * shows of the others' rights is unconfirmed, and an application should not decide anything for
   * the person on it.
   */
  get controlConfirmed(): boolean {
    return this.#creatorMemberId !== this.memberId || this.#controlBasis;
  }

  /**
   * Whether a resync request of this client carries its control vector and digest (RSY-16): for
   * anyone but the creator once it is bootstrapped (CTL-13), for a device of the creator once it
   * has a basis (CTL-28); `null` before, which asks for the creator's word.
   */
  #asksWithVector(): boolean {
    return this.#creatorMemberId === this.memberId
      ? this.#controlBasis
      : this.#hasCompletedBootstrap;
  }

  /**
   * Whether this client is in a capacity conflict (CTL-32): it could not hold an operation or a
   * snapshot of the creator for the bytes, a target's `seen` or the targets of control state
   * (CTL-30), so it may lack a decision — about itself, too. From then on it takes no new member or layer right, and refuses its own
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
   * `requestResync()` calls has actually been applied (SPECIFICATION.md RSY-14): for anyone but the
   * creator one that carries the creator's control state, for a device of the creator any. After a
   * restart, a non-creator's own restored control state may do so instead (`controlState`, CTL-41),
   * and a device of the creator is bootstrapped at once when it restores its content and a control
   * state that had a basis (CTL-28).
   * A joiner whose creator never comes online stays `false` forever — an honest
   * limitation of a broadcast-only, history-less transport, not a bug to be papered
   * over. An application should show it as "waiting for the creator", distinct from
   * "syncing" (which means "I have content and am sending my own edit").
   */
  get hasCompletedBootstrap(): boolean {
    return this.#hasCompletedBootstrap;
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
   * Every explicit `read`/`write` grant this client currently knows of. The
   * creator is implicit and not listed; a member absent from the map is revoked
   * (`revokedMembers`) or *unknown* — never named, or not yet heard about — and an
   * unknown one is not denied.
   */
  get memberPermissions(): ReadonlyMap<MemberId, "read" | "write"> {
    return this.#control.members;
  }

  /**
   * The members whose permission the creator revoked (CTL-13, CTL-23): refused as a reader is, on
   * the document and on every layer — not unknown, which refuses nothing after the bootstrap.
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
    return right === "revoked" ? undefined : right;
  }

  /**
   * A member's right as CTL-13 applies it: `"creator"` for the creator; `"read"` or `"write"`; or
   * `"revoked"` once the creator revoked the member's permission, which refuses its edits as
   * `read` does, on the document and on every layer, whatever right it holds there (LAY-5);
   * `undefined` while the creator never named it (unknown). With `layer`, the right there, or
   * where the member inherits, its permission on the document.
   */
  rightOf(member: MemberId, layer?: string): Permission | "revoked" | undefined {
    if (this.#creatorMemberId !== undefined && member === this.#creatorMemberId) {
      return "creator";
    }
    return rightIn(this.#control, member, layer);
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

  /** This client's control state as a snapshot carries it (CTL-25). */
  get controlState(): ControlSnapshot {
    return { profile: this.#profile.id, ...this.#control.snapshot() };
  }

  /** Every creator device's highest counter this client holds without a gap (CTL-25). */
  get controlVector(): ControlVector {
    return this.#control.vector;
  }

  /** The pace the creator set: the shortest interval between two messages of anyone (SND-15); `undefined` for none. */
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
    let deliveries: readonly Delivery[];
    let truncated = false;
    let restarted = false;
    try {
      if (receiveSince !== undefined) {
        const answer = await receiveSince(this.documentId, this.memberId, this.#cursor);
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
      this.#historyTruncatedSince ??= Date.now();
    }
    if (receiveSince !== undefined) {
      this.#receiveFailed = false;
      if (truncated) {
        this.#historyTruncatedSince ??= Date.now();
      }
    } else if (this.#receiveFailed) {
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
        const frameText = delivery.payload;
        const frame: Frame = decodeFrame(frameText, this.#extensionChecks);
        this.#checkFrameBelongsHere(frame);
        checkProfileReads(frame, this.#profile);
        if (this.#handleFrame(frame, delivery, applied, incomingResyncRequests)) {
          this.#tellExtensions(frame, delivery.sender);
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
    await this.#considerAutomaticResync().catch((error: unknown) =>
      this.#onError(error, "broadcast"),
    );
    await this.#respondToResyncRequests(this.#queueResyncRequests(incomingResyncRequests));
    this.#sendRestoredOnce();
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
      // Nothing to apply: it only says what the sender has and that it has nothing more
      // to say, so the loss detector can compare it with what this client holds.
      this.#detector.heardHeartbeat(delivery.sender, frame.stateVector, frame.control);
      if (!this.#isOwnStream(delivery.sender, frame.stream)) {
        this.#detector.heardReport(delivery.sender, frame);
      }
      return true;
    }
    if (frame.kind === "resync-request") {
      // Nothing to apply — carries no document content (SPECIFICATION.md
      // §8.2's own description, unchanged by folding this into a frame kind). Not heard
      // as an edit either: nothing is due after a request, so counting it as one made
      // every bystander suspect a joiner of going quiet and ask for a resync itself —
      // a cascade on every join (SPECIFICATION.md LOS-11).
      incomingResyncRequests.push({
        id: frame.requestId,
        requester: delivery.sender,
        control: frame.control,
        controlDigest: frame.controlDigest,
        force: frame.force,
        stateVector: frame.stateVector,
        stateDigest: frame.stateDigest,
      });
      // What it holds, a report like a heartbeat's (LOS-13) — but not this engine's own request.
      if (
        !this.#ownResyncRequestIds.has(frame.requestId) &&
        !this.#isOwnStream(delivery.sender, frame.stream)
      ) {
        this.#detector.heardReport(delivery.sender, frame);
        this.#reportAgainIfMisleading(frame.stateVector, frame.stateDigest);
      }
      // What a participant holds of the creator's operations is a report for a device of the
      // creator: counters only, which it may count as seen (CTL-27).
      if (frame.control !== null) {
        this.#takeReport(frame.control);
      }
      return true;
    }
    if (frame.kind === "decline") {
      // Information, never state (SPECIFICATION.md DCL-3).
      this.#reportDecline(delivery.sender, frame);
      return true;
    }
    if (frame.kind === "control") {
      // Not this device's own operation coming back: another device of this member, or anyone
      // else, promised a follow-up (LOS-11).
      if (delivery.sender !== this.memberId || frame.device !== this.#device) {
        // Its source is its device; a heartbeat holds it once its control vector reaches it.
        const { device, counter } = frame;
        this.#detector.heardEdit(
          delivery.sender,
          frame.due,
          `control:${device}`,
          (_stateVector, control) => control !== null && (control[device] ?? 0) >= counter,
        );
      }
      this.#applyControlFrame(frame, delivery.sender);
      this.#followPace();
      this.#notifyControlStateChange();
      return true;
    }
    if (frame.kind === "edit") {
      // An edit frame is one member's batch, so its updates come from one Yjs client:
      // that is how a gap the CRDT names by client id gets a member to blame. One of this
      // engine's own client is its own edit coming back, which promises it nothing; one of
      // another device of its member counts like anyone's (LOS-11).
      const clients = this.#profile.updateClientIds(frame.update);
      const ownEcho =
        delivery.sender === this.memberId &&
        clients.length > 0 &&
        clients.every((client) => client === this.document.clientID);
      if (!ownEcho) {
        // Its source is its CRDT clients; a heartbeat holds it once its state vector holds the update.
        const update = frame.update;
        const holds = holderOf(this.#profile);
        this.#detector.heardEdit(
          delivery.sender,
          frame.due,
          `edit:${[...clients].sort((a, b) => a - b).join(",")}`,
          (stateVector) => holds(stateVector, update),
        );
        if (clients.length === 1) {
          this.#detector.learnClient(clients[0] as number, delivery.sender);
        }
      }
    }
    // A close stops new edits at their sender, not in delivery (SPECIFICATION.md
    // LIF-6): an edit sent before the close may arrive after it and is applied like
    // any other, so every receiver ends with the same content whichever came first.
    // Only the creator answers a resync request, with one
    // exception: a restarted creator may lack content, and only a peer can
    // give it back. So a response counts if it comes from the creator,
    // or — for the creator alone — answers one of its own requests.
    if (
      frame.kind === "resync-response" &&
      !this.#mayAcceptResyncResponse(delivery.sender, frame.respondsTo)
    ) {
      // Nothing of it is applied; its last piece still states what its sender holds, a report like
      // a heartbeat, which any member may send (LOS-13).
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
    // The snapshot counts from the creator, and — relayed — from another device of this
    // member answering this engine's own request (CTL-25); from anyone else, answering a
    // device of the creator, it is a report of counters and nothing more (CTL-27).
    const snapshotCounts =
      frame.kind === "resync-response" &&
      frame.control !== null &&
      (delivery.sender === this.#creatorMemberId ||
        (delivery.sender === this.memberId && this.#ownResyncRequestIds.has(frame.respondsTo)));
    if (frame.kind === "resync-response" && frame.control !== null && snapshotCounts) {
      if (frame.control.profile !== this.#profile.id) {
        throw new FrameDecodeError(
          "profile-mismatch",
          `the creator's snapshot names the profile ${JSON.stringify(frame.control.profile)}, this document is ${this.#profile.id}`,
        );
      }
      // The one snapshot rule the decoder cannot check, since only the engine knows who
      // the creator is — checked here, before anything of the frame is applied (FRM-6).
      if (
        this.#creatorMemberId !== undefined &&
        Object.keys(frame.control.targets).some(
          (target) => memberOf(target as ControlTarget) === this.#creatorMemberId,
        )
      ) {
        throw new FrameDecodeError(
          "invalid-field",
          "the creator's snapshot lists the creator as a member; its role is fixed (CTL-4)",
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
      frame.kind === "resync-response" && this.#ownResyncRequestIds.has(frame.respondsTo);
    this.#attributionAuthor = frame.kind === "resync-response" ? null : delivery.sender;
    this.#applyingRemote = true;
    // What this client held before an answer — to its own request or another's —, so that one which
    // changed it is followed by a heartbeat (SND-11): others then see the new state, a healed
    // deletion included, and the evidence they had of it ends (LOS-12, LOS-18).
    const heldBefore = frame.kind === "resync-response" ? this.#heldNow() : undefined;
    try {
      this.#profile.applyUpdate(this.document, frame.update, REMOTE_ORIGIN);
      this.#boundPending();
      if (heldBefore !== undefined && heldBefore !== this.#heldNow()) {
        this.#scheduler.oweHeartbeat();
      }
      applied.push(delivery);
      // A snapshot refused as a whole for the bytes of control state is not held, and bootstraps
      // no one (CTL-13, CTL-32): the receiver does not hold the creator's control state.
      let snapshotHeld = false;
      if (frame.kind === "resync-response") {
        if (frame.control !== null && snapshotCounts) {
          // A basis only from another device of the creator answering this device's own request:
          // that device answers a device of the creator with a snapshot only once it has one itself
          // (CTL-28); one it sent another requester says nothing of the kind.
          snapshotHeld = this.#applyControlSnapshot(
            frame.control,
            isOwnResyncResponse && delivery.sender === this.#creatorMemberId,
          );
        } else if (
          frame.control !== null &&
          isOwnResyncResponse &&
          this.#creatorMemberId === this.memberId
        ) {
          this.#takeReport(frame.control.vector);
          this.#reportedState = frame.control;
          this.#noteCollisionsIn(frame.control, delivery.sender);
          this.#keepDivergences(delivery.sender, frame.control);
        }
        // A piece applied, counted when it answers this client's own request; the last one states
        // what the responder held as it answered, which this client holds once every piece is here
        // (LOS-4, LOS-12, LOS-14).
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
            own: isOwnResyncResponse,
            request: frame.respondsTo,
          });
        }
        // A device of the creator decides its control state itself: any answer to its own
        // request brings content (RSY-6) and completes its bootstrap. Anyone else is
        // bootstrapped by an answer from the creator, or from another device of its own
        // member, that carries control state (CTL-13); content alone does not.
        const ownsControl = this.#creatorMemberId === this.memberId;
        if (isOwnResyncResponse) {
          // Answered, whether or not it bootstraps: the request no longer holds the slot (RSY-4),
          // and what this client holds now is what the responder sent since its state vector, so
          // the follow-ups it expected are not owed any longer (LOS-16).
          this.#resyncGate.answered();
          this.#detector.answered();
        }
        if (isOwnResyncResponse && (ownsControl || snapshotHeld)) {
          this.#completeBootstrap();
          if (this.#bootstrapRequestIds.has(frame.respondsTo)) {
            this.#considerBootstrapOverlay(frame.attribution);
          }
        }
      }
    } finally {
      this.#applyingRemote = false;
      this.#attributionAuthor = this.memberId;
    }
    return true;
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

  /** What an answer's last piece states of its responder: a report (LOS-13); answers carry no control vector. */
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
      control: null,
      controlDigest: null,
    };
  }

  /**
   * A request stated exactly what this client holds, and this client's latest report states
   * deletions within its vector other than it holds now — ones it received since by ordinary
   * edits: to the requester, which holds the same, that report shows a difference in digests no
   * answer can end, since nobody has anything to give it. A heartbeat at once, a newer report of
   * this stream, ends it (SND-24, LOS-18).
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
      this.#scheduler.oweHeartbeat({ now: true });
    }
  }

  /** Whether a report comes from this engine's own stream: its own frame offered again (LOS-17). */
  #isOwnStream(sender: MemberId, stream: string): boolean {
    return sender === this.memberId && stream === this.#stream;
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

  /** This client's control digest (LOS-12): of the control state it holds. */
  #controlDigest(): string {
    const cached = this.#controlDigestCache;
    if (
      cached !== undefined &&
      cached.control === this.#control &&
      cached.revision === this.#control.revision
    ) {
      return cached.digest;
    }
    const digest = controlDigestOf(this.#control.snapshot());
    this.#controlDigestCache = { control: this.#control, revision: this.#control.revision, digest };
    return digest;
  }

  /** What this client holds, in one string: its state vector and its state digest. */
  #heldNow(): string {
    return `${bytesToBase64(this.#profile.encodeStateVector(this.document))}:${this.#stateDigest()}`;
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

  /**
   * A device of the creator learns from a member's report where its operations and the member's
   * differ under one device and counter (CTL-31): it notes the place and reports it, so a person
   * can decide that target again; it takes no value from the report (CTL-27).
   */
  #noteCollisionsIn(report: ControlStateSnapshot, reporter: MemberId): void {
    for (const anomaly of this.#control.noteCollisionsIn(report)) {
      this.#onError(
        new ControlFrameRejectedError(
          "anomaly",
          `${reporter} holds another control operation under ${anomaly.device}:${anomaly.counter}; decide it again`,
        ),
        "apply",
      );
    }
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
   * `receiveSince`, was not truncated, showed no other evidence of a truncated history, and left no
   * hole in a creator device's counters (CTL-41). Otherwise it waits for an answer, as on a
   * first join. Its own request (RSY-1) stays outstanding either way.
   */
  #considerRestoredBootstrap(readOnWithoutTruncation: boolean): void {
    if (!this.#restoredBootstrapPending) {
      return;
    }
    this.#restoredBootstrapPending = false;
    if (
      readOnWithoutTruncation &&
      this.#historyTruncatedSince === undefined &&
      !this.#control.hasHoles &&
      !this.#hasCompletedBootstrap
    ) {
      this.#hasCompletedBootstrap = true;
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
   * `PENDING_REQUEST_TTL_MS`.
   */
  #queueResyncRequests(heard: readonly IncomingResyncRequest[]): PendingResyncRequest[] {
    const now = Date.now();
    for (const request of heard) {
      const kept = this.#pendingResyncRequests.get(request.requester) ?? [];
      if (kept.some((other) => other.id === request.id)) {
        continue; // a copy of one already kept (RSY-16)
      }
      const next = [...kept, { ...request, heardAt: now }].slice(-MAX_REQUESTS_PER_REQUESTER);
      this.#pendingResyncRequests.set(request.requester, next);
    }
    for (const [requester, kept] of this.#pendingResyncRequests) {
      const fresh = kept.filter((request) => now - request.heardAt <= PENDING_REQUEST_TTL_MS);
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
    if (truncated && this.#historyTruncatedSince === undefined) {
      this.#historyTruncatedSince = Date.now();
    }
    return truncated;
  }

  /**
   * The creator's *history truncated* evidence ends when a request it made after the evidence
   * expired unanswered (SPECIFICATION.md LOS-20). A peer answers the creator only when it
   * holds content the creator lacks (RSY-6, RSY-17), so silence means either nothing to recover or
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
   *
   * Like every control action it holds here at once and resolves once the transport has accepted
   * the operation; a send that fails for now is retried (`sendStatus` shows it), so offline this
   * waits while the decision already shows. It rejects when the transport refuses for good — the
   * decision still holds and travels in every snapshot — or when the engine is disposed first:
   * then the operation stays unsent in the persisted control state, and the restarted engine
   * sends it (CTL-26).
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
   */
  async closeDocument(): Promise<void> {
    if (this.#control.closed && this.#creatorMemberId === this.memberId) {
      return;
    }
    await this.#issueControl("close", true);
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
    const whole = encodeEditFrame(this.documentId, state, this.#due(), this.#outgoing.get("edit"));
    await this.#sendFrames(
      this.#maxBytes === undefined || frameByteLength(whole) <= this.#maxBytes
        ? [whole]
        : this.#editFramesOf(state),
      // An edit, possibly the only copy of a change nobody else has: kept and retried after a
      // failure worth retrying, whole or in pieces alike (SND-6, SND-7), and shown as retrying.
      { armsHeartbeat: true, retry: true, own: true },
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
   * in `#bootstrapRequestIds` below so `sync()` knows to consider
   * adopting the answer's attribution overlay when it arrives
   * (SPECIFICATION.md §5.4) — never marked for a
   * request made with existing content, which has no such question to
   * answer (a partial gap-heal response never adopts an overlay). No
   * window or timer guards this: `#considerBootstrapOverlay` adopts the
   * first answer's overlay the moment it arrives, and no later one, also
   * when a repeated bootstrap request is answered too (RSY-15).
   */
  async requestResync(): Promise<ResyncOutcome> {
    return this.#requestResync(false);
  }

  /**
   * The one place a resync request is made, whoever is asking. It takes
   * the single slot first, before anything is sent, so two callers in the same tick cannot
   * both send; a request made while one of ours is outstanding — or still waiting in the
   * scheduler to go out — is coalesced into it and sends nothing. A person's request made inside
   * the rate floor is refused; an automatic one is not: it waits in the scheduler for the floor
   * (RSY-3, SND-2), so a client that keeps writing still gets to ask (LOS-6).
   */
  async #requestResync(automatic: boolean): Promise<ResyncOutcome> {
    if (this.#requestWaiting) {
      return { sent: false, reason: "in-flight" };
    }
    const previousRequestAt = this.#resyncGate.lastRequestAt;
    const outcome = this.#resyncGate.begin({
      expiryMs: this.#resyncExpiryMs(),
      floorMs: automatic ? 0 : this.#scheduler.effectiveMinIntervalMs,
      automatic,
      lastMessageAt: this.#scheduler.lastSendAt,
    });
    if (!outcome.sent) {
      return outcome;
    }
    this.#requestWaiting = true;
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
        this.#bootstrapRequestIds.add(requestId);
      }
      // Written when it goes out, not when it was asked for: it may wait for the floor, and what
      // it says this client holds must be what it holds then (RSY-16, LOS-12).
      const frame = () =>
        encodeResyncRequestFrame({
          documentId: this.documentId,
          requestId,
          // Until the creator has answered, the answer itself is what this engine lacks — the
          // creator's confirmation of the profile and its control state — even when the content
          // has already arrived by ordinary edits (RSY-16, CTL-10): `null` says so. A device of the
          // creator without a basis says the same, so that another device that has one answers it
          // even when it lacks nothing, and the snapshot gives it its basis (CTL-28, RSY-17).
          control: this.#asksWithVector() ? this.#control.vector : null,
          controlDigest: this.#asksWithVector() ? this.#controlDigest() : null,
          // After a truncated history only an answer can say nothing was lost (LOS-19).
          force: this.#historyTruncatedSince !== undefined,
          ...this.#reporting(this.#ownState()),
          // Numbered as it is written, so a later report of this stream states a later state (LOS-13).
          stream: this.#stream,
          sequence: this.#nextSequence(),
          extensions: this.#outgoing.get("resync-request"),
        });
      // Through the scheduler, on the floor like any message; nobody expects a follow-up to a
      // request, so it owes no heartbeat (SPECIFICATION.md SND-2, SND-11, LOS-11).
      const id = await this.#scheduler.submit(
        () => this.#messenger.send(this.documentId, this.memberId, frame()),
        { armsHeartbeat: false },
      );
      this.#markOwnSend(id);
      // Its expiry, and the floor for the next one, count from when it went out (RSY-4).
      this.#resyncGate.sent(this.#resyncExpiryMs());
    } catch (error) {
      if (requestIdToForget !== undefined) {
        this.#ownResyncRequestIds.delete(requestIdToForget);
        this.#bootstrapRequestIds.delete(requestIdToForget);
      }
      this.#resyncGate.abort(previousRequestAt);
      throw error;
    } finally {
      this.#requestWaiting = false;
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
    // ever show what slid out unread (LOS-19).
    const suspicions = this.syncHealth.suspicions;
    if (suspicions.length === 0 && this.#automaticLossAttempts > 0) {
      this.#automaticLossAttempts = 0;
      this.#lossEpisode += 1;
    }
    if (!this.#resyncGate.isFree || this.#requestWaiting) {
      return;
    }

    if (!this.#hasCompletedBootstrap) {
      const reference = Math.max(
        this.#resyncGate.lastRequestAt ?? 0,
        this.#lastAutomaticAttemptAt ?? 0,
      );
      const wait = Math.min(RESYNC_BACKOFF_CAP_MS, expiry * 2 ** this.#automaticBootstrapAttempts);
      if (
        this.#automaticBootstrapAttempts < MAX_AUTOMATIC_BOOTSTRAP_ATTEMPTS &&
        (reference === 0 || now - reference >= wait)
      ) {
        this.#askAutomatically(() => {
          this.#automaticBootstrapAttempts += 1;
        });
        return;
      }
      // A joiner has nothing to heal before its bootstrap. A device of the creator does: it edits
      // and answers at once, and its evidence is answered as anyone's is (LOS-6), however its own
      // bootstrap requests went.
      if (this.#creatorMemberId !== this.memberId) {
        return;
      }
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
            ? (suspicion.due ?? 0) + 3 * grace
            : 2 * grace;
      return now - suspicion.since >= after;
    });
    const spacing = Math.min(RESYNC_BACKOFF_CAP_MS, expiry * 2 ** this.#automaticLossAttempts);
    const spaced =
      this.#lastAutomaticAttemptAt === null || now - this.#lastAutomaticAttemptAt >= spacing;
    if (due && spaced) {
      const episode = this.#lossEpisode;
      this.#askAutomatically(() => {
        if (this.#lossEpisode === episode) {
          this.#automaticLossAttempts += 1;
        }
      });
    }
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
      this.#lastAutomaticAttemptAt = Date.now();
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
   * so a pending batch is never silently dropped when a client is torn down.
   */
  async flush(): Promise<void> {
    await this.#scheduler.flush();
  }

  /**
   * Stops broadcasting local edits. Does not affect other clients on the channel.
   * Sends what is pending one last time, once the floor and any back-off permit (SND-2); there is
   * no retry after this, so a failure is reported through `onError` and the change is lost. A
   * control operation still being retried is not lost: it stays unsent in the persisted control
   * state (CTL-26).
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
   * permission is neither `read` nor revoked. What an application shows as an editable document.
   */
  get mayEdit(): boolean {
    if (this.#control.closed || this.#control.capacityConflict) {
      return false;
    }
    if (this.#creatorMemberId === this.memberId) {
      return true;
    }
    return this.#hasCompletedBootstrap && !refuses(this.rightOf(this.memberId));
  }

  /**
   * Whether this client may send a change of `layer` now (LAY-5, LAY-6): as `mayEdit`, by its
   * permission on that layer — its right there, or else its permission on the document; never
   * once its permission is revoked.
   */
  mayEditLayer(layer: string): boolean {
    if (this.#control.closed || this.#control.capacityConflict) {
      return false;
    }
    if (this.#creatorMemberId === this.memberId) {
      return true;
    }
    return this.#hasCompletedBootstrap && !refuses(this.rightOf(this.memberId, layer));
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

  /**
   * Refuses, permanently, a change of its own that touches a part of the document this client may
   * not write (LAY-6, LAY-7): the content by its permission, a layer by its permission there. A
   * change that touches several is refused whole when one of them is not permitted.
   */
  #assertMayChange(roots: ReadonlySet<string>): void {
    if (this.#control.closed) {
      throw new SendRefusedError("closed", `document is closed, no new writes: ${this.documentId}`);
    }
    this.#assertNoCapacityConflict();
    if (this.#creatorMemberId === this.memberId) {
      return;
    }
    // In the order `#assertMayEdit` refuses in: a known `read` or revocation before a bootstrap
    // still awaited.
    for (const root of roots.size === 0 ? ["content"] : roots) {
      const layer = isLayerId(root) ? root : undefined;
      const right = this.rightOf(this.memberId, layer);
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
    if (!this.#hasCompletedBootstrap) {
      throw new SendRefusedError(
        "awaiting-bootstrap",
        `${this.memberId} has not received ${this.documentId} from its creator yet`,
      );
    }
  }

  /**
   * Refuses, permanently, when this client already knows it must not send: closed, `read`, or
   * revoked (CTL-13). Never refuses on an *unknown* permission.
   */
  #assertMaySend(): void {
    if (this.#control.closed) {
      throw new SendRefusedError("closed", `document is closed, no new writes: ${this.documentId}`);
    }
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
    const due = this.#due();
    const extensions = this.#outgoing.get("edit");
    const overhead =
      frameByteLength(encodeEditFrame(this.documentId, new Uint8Array(3), due, extensions)) - 4;
    return splitterOf(this.#profile)(update, this.#pieceBudget(overhead)).map((piece) =>
      encodeEditFrame(this.documentId, piece, due, extensions),
    );
  }

  /**
   * Sends a frame that may be larger than one message — a resync answer, or `resync()`'s own
   * full state. Whole, it is submitted to the scheduler and goes out once the floor permits,
   * ahead of any edit (SPECIFICATION.md SND-2, SND-20, RSY-11); too large, it is cut and its
   * fragments go out at the permitted rate, in order, and are retried like any send.
   * `armsHeartbeat`: an edit frame owes a heartbeat after it, an answer does not (SND-11).
   * Resolves once sent or queued.
   */
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
   * SND-7). Waits for every piece, so a caller learns, as for one message, whether it all went out.
   */
  async #sendFrames(
    frames: readonly string[],
    options: { armsHeartbeat: boolean; retry?: boolean; own: boolean },
  ): Promise<void> {
    if (frames.length === 1) {
      await this.#scheduler.submit(() => this.#sendFrame(frames[0] as string), options);
      return;
    }
    await this.#scheduler.enqueueFrames(frames, { own: options.own });
  }

  async #broadcast(update: Uint8Array, roots: ReadonlySet<string>): Promise<void> {
    this.#assertMayChange(roots);
    const frame = encodeEditFrame(this.documentId, update, this.#due(), this.#outgoing.get("edit"));
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
    const ownsControl = this.#creatorMemberId === this.memberId;
    const frame = encodeHeartbeatFrame({
      documentId: this.documentId,
      // A device of the creator's control vector, so a lost operation shows (SND-11, LOS-10).
      control: ownsControl ? this.#control.vector : null,
      controlDigest: ownsControl ? this.#controlDigest() : null,
      // What the state vector does not show, beside it (LOS-12).
      ...this.#reporting(this.#ownState()),
      stream: this.#stream,
      sequence: this.#nextSequence(),
      extensions: this.#outgoing.get("heartbeat"),
    });
    const id = await this.#messenger.send(this.documentId, this.memberId, frame);
    this.#markOwnSend(id);
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
        // The creator's control state; or, to another device of this member, the one this device
        // holds; otherwise none, which nobody else would accept anyway.
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
      await this.#sendFrames([whole], { armsHeartbeat: false, own: false });
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
    await this.#sendFrames(frames, { armsHeartbeat: false, own: false });
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
      throw new PieceTooSmallError(this.#maxBytes as number, frameByteLength(withoutOverlay));
    }
    return withoutOverlay;
  }

  /**
   * Whether a resync response from `sender` counts. Only the
   * creator answers a resync request, so a response counts if it comes from the
   * creator. The one exception is the creator itself: a restarted creator may lack
   * content, only a peer can give it back, and so it accepts a response
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
    // Another device of this member, answering this engine's own request (RSY-12); or a peer
    // answering a request of the creator's, the creator's own restart exception.
    if (sender === this.memberId || this.#creatorMemberId === this.memberId) {
      return this.#ownResyncRequestIds.has(respondsTo);
    }
    return false;
  }

  /**
   * Checked on every `sync()` poll tick. **Only the creator answers a resync
   * request** (SPECIFICATION.md RSY-6): letting every online peer answer costs one full
   * snapshot per online member at tens of seconds of latency, and suppressing the
   * others until the creator's answer arrives only works on a fast network. The single
   * exception: a peer answers a request
   * made by the creator, because a restarted creator may lack content that
   * nobody else can give back. What a peer sends the creator is content only — it
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
   * A send failure here that is worth retrying (disconnected, a rate limit) is not routed to
   * `onError`: the request goes back to be answered later (RSY-9), and the next send waits out
   * the back-off. An answer refused for good is reported once, as SND-8 requires of every
   * dropped send, and the request is let go.
   */
  async #respondToResyncRequests(requests: readonly PendingResyncRequest[]): Promise<void> {
    const now = Date.now();
    const isCreator =
      this.#creatorMemberId !== undefined && this.memberId === this.#creatorMemberId;

    for (const request of requests) {
      try {
        // This engine's own request is recognised by its id, not by its requester: another
        // device of this member asks under the same MemberId (RSY-6).
        if (
          this.#ownResyncRequestIds.has(request.id) ||
          this.#seenResyncRequestIds.has(request.id)
        ) {
          this.#seenResyncRequestIds.add(request.id);
          this.#forgetPendingRequest(request, false);
          continue;
        }
        const requesterIsCreator =
          this.#creatorMemberId !== undefined && request.requester === this.#creatorMemberId;
        // Another device of this member: answered as the creator answers everyone (RSY-6), with
        // this device's control state if it holds every control frame up to its highest.
        const requesterIsOwnDevice =
          this.#creatorMemberId !== undefined && request.requester === this.memberId;
        if (!isCreator && !requesterIsCreator && !requesterIsOwnDevice) {
          this.#seenResyncRequestIds.add(request.id); // not ours to answer: only the creator answers
          this.#forgetPendingRequest(request, false);
          continue;
        }
        const requested = { stateVector: request.stateVector };
        // What this device sends as control state (RSY-8): the creator's, once it has a basis for it,
        // and before only to a member it decided about itself — so never to another device of the
        // creator, which is no member (CTL-4, CTL-28); to another device of its own member, what it
        // holds once bootstrapped (a union cannot undo anything, CTL-25); to a device of the creator,
        // what it holds as a report (CTL-27). In a capacity conflict it hands on nothing as control
        // state, since it knows what it holds lacks something (CTL-32); a report it still gives.
        const inConflict = this.#control.capacityConflict;
        const control: ControlSnapshot | null = isCreator
          ? !inConflict && (this.#controlBasis || this.#decidedHere.has(request.requester))
            ? this.controlState
            : null
          : requesterIsOwnDevice
            ? this.#hasCompletedBootstrap && !inConflict
              ? this.controlState
              : null
            : this.#control.isEmpty
              ? null
              : this.controlState;
        // Something to offer is content the requester lacks, or operations it lacks: a lost
        // membership change leaves the content diff empty and still needs healing (RSY-16).
        const hasContent = this.#profile.hasUpdatesSince(this.document, requested.stateVector);
        const hasControl = control !== null && this.#control.hasAnyBeyond(request.control);
        // Where the requester holds every insertion this responder holds, another digest is something
        // to offer too: a deletion the requester lacks travels in the state since its state vector —
        // the requester may hold more and not that (LOS-12, RSY-17). Operations it holds otherwise
        // travel in the control state, to a device of the creator as a report, where it shows a
        // collision (CTL-31).
        const contentDiffers = !hasContent && request.stateDigest !== this.#stateDigest();
        const controlDiffers =
          control !== null &&
          request.control !== null &&
          request.controlDigest !== null &&
          this.#control.hasVector(request.control) &&
          request.controlDigest !== this.#controlDigest();
        // The creator, or another device of the requester's member, answers a requester without a
        // snapshot or one that asks regardless, even with nothing new.
        const mustAnswer =
          (isCreator || (requesterIsOwnDevice && control !== null)) &&
          (request.control === null || request.force);
        if (!hasContent && !hasControl && !mustAnswer && !contentDiffers && !controlDiffers) {
          continue; // nothing to offer yet — may change by a later tick
        }
        if (
          this.#lastResyncResponseAt !== null &&
          now - this.#lastResyncResponseAt < this.#resyncResponseThrottleMs
        ) {
          continue; // still reconsidered on a later tick
        }

        this.#seenResyncRequestIds.add(request.id);
        this.#forgetPendingRequest(request, true);
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
          this.#broadcastResyncResponse(request.id, update, attributionOverlay, control).catch(
            (error: unknown) => this.#keepRequestAfterFailedAnswer(request, error),
          );
        } catch {
          // best-effort — see this method's own doc comment.
        }
      } catch (error) {
        // A request the profile fails on while answering must not keep the others from their
        // answers (RSY-9; §1.7 item 11): reported, and not kept to fail again on every tick.
        this.#seenResyncRequestIds.add(request.id);
        this.#forgetPendingRequest(request, false);
        this.#onError(error, "broadcast");
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

  /** The pace this engine runs: the creator's, but never longer than `MAX_PACE_MS` (SND-15). */
  #runningPace(): number | undefined {
    const pace = this.#control.pace;
    return pace === undefined ? undefined : Math.min(pace, MAX_PACE_MS);
  }

  /**
   * Gives up what the profile holds for missing predecessors once it is more than the bound
   * (LOS-23): anyone in the channel can send updates whose predecessors never come (CTL-7). What it
   * gave up is as if it had missed those deliveries: *history truncated* evidence, which asks at
   * once and ends as LOS-19 and LOS-20 say.
   */
  #boundPending(): void {
    const bytes = this.#profile.pendingBytes?.(this.document);
    if (
      bytes === undefined ||
      bytes <= MAX_PENDING_BYTES ||
      this.#profile.giveUpPending === undefined
    ) {
      return;
    }
    this.#profile.giveUpPending(this.document);
    this.#historyTruncatedSince ??= Date.now();
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
   * What this client promises with each edit and control frame (SND-14): it sends again within
   * its longest wait at the latest — the heartbeat, if nothing else — or promises nothing.
   */
  #due(): number {
    return dueOf(this.#syncPolicy);
  }

  /**
   * The bootstrap is complete (RSY-14), by an answer to this client's own request — which already
   * freed the request slot and ended the silence it expected: the truncated history it answered is
   * gone too (LOS-19).
   */
  #completeBootstrap(): void {
    const first = !this.#hasCompletedBootstrap;
    this.#historyTruncatedSince = undefined;
    this.#hasCompletedBootstrap = true;
    if (first && this.#creatorMemberId !== this.memberId) {
      // Persisted from now on as taken once bootstrapped, so a restart may use it (CTL-39).
      this.#notifyControlStateChange();
    }
  }

  /**
   * A device of the creator's issue path (CTL-20, CTL-26): the operation takes the next
   * counter of this device, names what it has seen of the other creator devices — raised by what
   * participants reported (CTL-27) — and is persisted before anything changes or is sent; a
   * failure to persist changes nothing. It then holds here at once, as a pending change, and is
   * sent until the transport accepts it; the action resolves only then. Offline it waits, and
   * holds meanwhile — what the person decided shows at once, as typed text does.
   */
  async #issueControl(
    target: ControlTarget,
    value: ControlValue,
    alsoSeen: ControlVector = {},
  ): Promise<void> {
    if (this.#creatorMemberId !== this.memberId) {
      throw new Error(`${this.memberId} is not the creator of ${this.documentId}`);
    }
    if (this.#control.closed) {
      throw new SendRefusedError("closed", `document is closed: ${this.documentId}`);
    }
    this.#device ??= newDeviceTag();
    const device = this.#device;
    const op: ControlOperation = {
      device,
      counter: this.#counter + 1,
      target,
      value,
      seen: issuingVector(
        device,
        issuingVector(device, this.#control.vector, this.#reported),
        alsoSeen,
      ),
    };
    const key = `${device}:${op.counter}`;
    // Persisted first, as it will be: if the application cannot persist it, nothing changed. Over
    // the bounds of control state the operation would not hold anywhere, a new target goes only up
    // to the bytes a device issues to, and in a capacity conflict there is none (CTL-37, CTL-32).
    const issued = this.#control.issue(op);
    if ("refused" in issued) {
      throw new SendRefusedError(
        issued.refused,
        issued.refused === "capacity-conflict"
          ? `${this.documentId} is in a capacity conflict: no new member or layer right can be held`
          : `the control state of ${this.documentId} would exceed its bounds (a new member or layer right: ${MAX_ISSUE_BYTES} bytes)`,
      );
    }
    const next = issued.next;
    // What this device promises is what it keeps once the operation holds: a pace above its own
    // longest wait raises that wait to the pace (SND-15), and the heartbeat comes only then. A
    // promise made under the old pace would be broken by the very frame that carries it (SND-14).
    const text = encodeControlFrame({
      documentId: this.documentId,
      ...op,
      due: dueOf(this.#policyUnder(next.pace)),
    });
    if (this.#maxBytes !== undefined && target !== "close") {
      // Nor would a joiner get it: an answer carries the snapshot whole, beside an empty update
      // at the least (SND-18). The close goes whatever: a document no joiner can bootstrap from
      // is still closed for everyone who holds it (CTL-37, LIF-7).
      const answer = encodeResyncResponseFrame({
        documentId: this.documentId,
        respondsTo: "0".repeat(16),
        update: this.#profile.encodeState(this.#profile.createEmpty()),
        control: { profile: this.#profile.id, ...next.snapshot() },
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
    this.#onControlStateChange?.(
      this.#persisted(next, op.counter, [...this.#unsent.values(), text]),
    );
    this.#counter = op.counter;
    this.#control.add(op);
    this.#unsent.set(key, text);
    const member = target.startsWith("member:") ? memberOf(target) : undefined;
    if (member !== undefined) {
      this.#decidedHere.add(member);
    }
    try {
      await this.#sendControlFrame(key, text);
    } finally {
      // A new pace governs this device's sending once the operation announcing it is out, so the
      // operation does not wait for the very floor it sets (SND-15).
      this.#followPace();
    }
  }

  /**
   * Sends one operation of this device until the transport accepts it (SND-6, SND-7): then it is no
   * longer unsent. Refused for good, it is given up — it still holds here and travels in every
   * snapshot this device sends. A `dispose()` meanwhile leaves it unsent, and persisted, for the
   * restarted engine.
   */
  async #sendControlFrame(key: string, text: string): Promise<void> {
    let id: DeliveryId;
    try {
      // Through the scheduler, on the floor like any message (SND-2); receivers expect a
      // follow-up to a control message, so the heartbeat is owed after it.
      id = await this.#scheduler.submit(
        () => this.#messenger.send(this.documentId, this.memberId, text),
        // A source of its own at receivers: an edit sent later does not keep its promise (LOS-16).
        { armsHeartbeat: true, retry: true, promise: "control" },
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
   * Keeps what a member's report holds beyond this device of the creator (CTL-33): per target, the
   * value the report gives it and the operations there this device neither holds nor supersedes. It
   * replaces the member's earlier report; what no longer diverges is never kept. Bounded: at most
   * MAX_TARGETS targets in all, the oldest reporter's given up first (CTL-30).
   */
  #keepDivergences(reporter: MemberId, report: ControlStateSnapshot): void {
    const targets = new Map<string, ReportedDivergence>();
    for (const [target, state] of Object.entries(report.targets)) {
      const beyond = state.heads.filter((head) => !this.#control.knows(target, head));
      if (beyond.length > 0) {
        targets.set(target, { reported: valueOfHeads(target, state.heads), heads: beyond });
      }
    }
    this.#divergences.delete(reporter);
    if (targets.size > 0) {
      this.#divergences.set(reporter, targets);
    }
    let total = [...this.#divergences.values()].reduce((sum, kept) => sum + kept.size, 0);
    for (const [oldest, kept] of this.#divergences) {
      if (total <= MAX_TARGETS || oldest === reporter) break;
      total -= kept.size;
      this.#divergences.delete(oldest);
    }
  }

  /**
   * Raises the counters a device of the creator without a basis counts as seen; values never come
   * from a report (CTL-27, CTL-28).
   */
  #takeReport(vector: ControlVector): void {
    if (this.#creatorMemberId !== this.memberId || this.#controlBasis) {
      return;
    }
    for (const [device, counter] of Object.entries(vector)) {
      if (device !== this.#device && counter > (this.#reported[device] ?? 0)) {
        if (!(device in this.#reported) && Object.keys(this.#reported).length >= 64) {
          continue; // bounded like the creator devices a control state tracks (CTL-30)
        }
        this.#reported[device] = counter;
      }
    }
  }

  /**
   * Applies one operation if, and only if, its sender is the creator and it does not name the
   * creator (CTL-5); a duplicate is inert. Throws `ControlFrameRejectedError` for one that must
   * not count at all. Two different operations under one device and counter are both kept and
   * reported (CTL-24); when the device is this one, it stops issuing under its tag.
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
    if (memberOf(frame.target) === this.#creatorMemberId) {
      throw new ControlFrameRejectedError(
        "names-the-creator",
        "control frame ignored: the creator's own permission is fixed and cannot be changed",
      );
    }
    const op: ControlOperation = {
      device: frame.device,
      counter: frame.counter,
      target: frame.target,
      value: frame.value,
      seen: frame.seen,
    };
    const anomaliesBefore = this.#control.anomalies.length;
    const result = this.#control.add(op);
    // An operation under this device's tag that this device did not issue: a copy of this device
    // restored from an older backup, or another one that took its tag — a counter above its own, or
    // one that collides with what this device holds under that counter, sent or not. It changes its
    // tag, so the two never collide again (CTL-24).
    const ownTagElsewhere =
      frame.device === this.#device &&
      (frame.counter > this.#counter ||
        !this.#issuedHere(frame) ||
        this.#collidesUnderOwnTag(anomaliesBefore));
    // No basis, though it came from another device of the creator or from the channel's history: that
    // device may have had none, and the frame does not say (CTL-28).
    if (ownTagElsewhere) {
      this.#leaveOwnTag();
    }
    if (result === "refused") {
      throw new ControlFrameRejectedError(
        "refused",
        this.#control.capacityConflict
          ? "control frame not held: in a capacity conflict, this client takes no new member or layer right beyond its bounds of control state (CTL-32)"
          : "control frame not held: it would exceed this client's bounds on creator devices or holes",
      );
    }
    if (this.#control.anomalies.length > anomaliesBefore || ownTagElsewhere) {
      this.#onError(
        new ControlFrameRejectedError(
          "anomaly",
          `two different control operations under ${frame.device}:${frame.counter}; merged into one, the narrowest`,
        ),
        "apply",
      );
    }
  }

  /** Whether a collision noted since there were `anomaliesBefore` lies under this device's own tag (CTL-24). */
  #collidesUnderOwnTag(anomaliesBefore: number): boolean {
    return (
      this.#device !== undefined &&
      this.#control.anomalies
        .slice(anomaliesBefore)
        .some((anomaly) => anomaly.device === this.#device)
    );
  }

  /** Stops issuing under this device's tag and continues under a new one (CTL-24). */
  #leaveOwnTag(): void {
    this.#device = newDeviceTag();
    this.#counter = 0;
  }

  /** Whether `frame` is an operation this device issued under its current tag. */
  #issuedHere(frame: ControlFrame): boolean {
    const unsent = this.#unsent.get(`${frame.device}:${frame.counter}`);
    if (unsent !== undefined) {
      return (
        unsent ===
        encodeControlFrame({
          documentId: this.documentId,
          device: frame.device,
          counter: frame.counter,
          target: frame.target,
          value: frame.value,
          seen: frame.seen,
          due: frame.due,
        })
      );
    }
    return frame.counter <= this.#counter;
  }

  /** This client's control state as a device of the creator persists it (CTL-26). */
  #persisted(
    control: ControlState,
    counter: number,
    unsent: readonly string[],
  ): PersistedControlState {
    const member = this.#creatorMemberId !== this.memberId;
    return {
      profile: this.#profile.id,
      control: control.snapshot(),
      ...(this.#device === undefined ? {} : { device: this.#device, counter }),
      ...(unsent.length === 0 ? {} : { unsent: [...unsent] }),
      ...(member ? {} : { basis: this.#controlBasis }),
      ...(member && this.#hasCompletedBootstrap ? { bootstrapped: true } : {}),
      ...(control.capacityConflict ? { capacityConflict: true } : {}),
    };
  }

  #notifyControlStateChange(): void {
    this.#onControlStateChange?.(
      this.#persisted(this.#control, this.#counter, [...this.#unsent.values()]),
    );
  }

  /**
   * Merges a control snapshot, already checked in full by the decoder, by union (CTL-25): it never
   * undoes anything, so it need not be newer than what this client holds, and never reopens a
   * closed document. For a device of the creator, `basis` says whether it is a basis (CTL-28):
   * another of its devices' answer to this device's own request.
   */
  #applyControlSnapshot(snapshot: DecodedSnapshot, basis: boolean): boolean {
    const anomaliesBefore = this.#control.anomalies.length;
    const { leftOut, refused } = this.#control.mergeOrRefuse(snapshot);
    if (leftOut > 0) {
      this.#onError(
        new ControlFrameRejectedError(
          "refused",
          refused
            ? "a control snapshot not held: it would exceed this client's bounds of control state, a capacity conflict (CTL-32)"
            : `${leftOut} part(s) of a control snapshot not held: they would exceed this client's bounds on creator devices or holes, or take a new member or layer right in a capacity conflict`,
        ),
        "apply",
      );
    }
    if (this.#control.anomalies.length > anomaliesBefore) {
      // Another copy of this device decided under its tag: it continues under a new one (CTL-24).
      if (this.#creatorMemberId === this.memberId && this.#collidesUnderOwnTag(anomaliesBefore)) {
        this.#leaveOwnTag();
      }
      // Reported as a frame's collision is (CTL-24): an operation the snapshot carries differs from
      // one held under the same device and counter.
      this.#onError(
        new ControlFrameRejectedError(
          "anomaly",
          "a control snapshot holds another operation under a device and counter this client holds; merged into one, the narrowest",
        ),
        "apply",
      );
    }
    this.#followPace();
    if (this.#creatorMemberId === this.memberId && basis && !refused) {
      this.#gainBasis();
    }
    this.#notifyControlStateChange();
    return !refused;
  }

  /**
   * This device of the creator has a basis for its control state (CTL-28). From now on it counts as
   * seen what it holds itself, nothing a participant reported: CTL-27 lets only a device without
   * control state supersede by reports, and one that has a basis but lags behind a member would
   * otherwise supersede decisions it never saw, wider than any of the creator's devices decided.
   */
  #gainBasis(): void {
    this.#controlBasis = true;
    this.#reported = {};
  }
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
