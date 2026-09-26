/**
 * The MessengerPort interface is the single, exclusive boundary for all document data
 * exchanged between participants — the transport contract of SPECIFICATION.md §3. It
 * expresses capabilities, not a vendor API: register a document (never create or configure
 * the messenger channel it rides on), send and receive opaque payloads, list the raw
 * channels an account can see (for a picker that binds a document to one, not "my
 * documents"), and expose stable delivery identifiers for de-duplication.
 *
 * **What it deliberately does not offer**: membership, permissions and the document's
 * lifecycle. Those are sequence-numbered control frames owned by `document-protocol`
 * (`DocumentEngine.setMembership`/`closeDocument`), not messenger-side access control. What
 * is left is what a messenger can actually do, which keeps this interface stable:
 * application policy can change without touching it.
 *
 * Terminology: `createDocument` is named for *what it does for the application*, not for
 * the messenger channel, because this implementation never creates, configures or deletes
 * that channel; it only sends and receives ordinary messages in one a person already set up
 * in their own messenger client. `listChannels` is the one method about the messenger's own
 * channels (a read-only listing, for picking one to bind to), which is why it alone says
 * "Channel". `Permission`'s `"creator"` is fixed once at document creation, never a
 * messenger-native role.
 *
 * The engine (`document-protocol`) and the document profile (`reconciliation`) depend only
 * on this interface, never on a concrete adapter such as `@tdsp/messenger-mock` — enforced
 * by the "no-core-to-messenger-adapter" rule in .dependency-cruiser.cjs, which covers every
 * `packages/messenger-<name>` adapter.
 */

export type DocumentId = string;
export type MemberId = string;
export type DeliveryId = string;
export type ResyncRequestId = string;

/**
 * A member's permission on a document (SPECIFICATION.md §7). Owned by
 * `document-protocol`, which tracks it from the creator's control frames; kept
 * here only because it is the vocabulary every layer above the transport shares.
 */
export type Permission = "read" | "write" | "creator";

/**
 * Severity for a receive-side integrity-log entry (SPECIFICATION.md BRG-12: a
 * messenger-native edit or withdrawal of an already-delivered message is recorded, never
 * applied). Shared vocabulary each adapter's own reason union plugs into — `"alert"` for
 * what looks like a deliberate attempt to break the document's rules, `"warning"` for a
 * more likely benign cause.
 */
export type IntegritySeverity = "warning" | "alert";

export interface Delivery {
  readonly id: DeliveryId;
  readonly documentId: DocumentId;
  readonly sender: MemberId;
  /** Exactly one frame, as JSON text (SPECIFICATION.md §4); opaque to the transport. */
  readonly payload: string;
}

/**
 * How much a bridge keeps of a document's deliveries for `receive` (SPECIFICATION.md
 * BRG-17): the newest ones, at most this many and at most this much payload text. An engine
 * polls far more often than these fill up; a delivery dropped before an engine read it is a
 * lost message, which loss detection and a resync recover (§10) — TDSP tolerates loss by
 * design, so retention needs no acknowledgement from the reader.
 */
export interface DeliveryRetention {
  readonly maxCount: number;
  /** Counted in characters of payload text, which for a frame is close to its bytes. */
  readonly maxPayloadChars: number;
}

export const DEFAULT_DELIVERY_RETENTION: DeliveryRetention = {
  maxCount: 1000,
  maxPayloadChars: 64 * 1024 * 1024,
};

/**
 * Drops the oldest of `list` — in place, oldest first — until it fits `retention`. The newest
 * delivery is always kept, however large. A delivery once dropped should not be offered again
 * while the bridge runs (BRG-17); remembering that is the caller's affair, not this list's.
 * After a restart it may come back, which an engine tolerates (TRN-8).
 */
export function retainNewest(
  list: Delivery[],
  retention: DeliveryRetention = DEFAULT_DELIVERY_RETENTION,
): void {
  let chars = list.reduce((sum, delivery) => sum + delivery.payload.length, 0);
  while (
    list.length > 1 &&
    (list.length > retention.maxCount || chars > retention.maxPayloadChars)
  ) {
    chars -= (list.shift() as Delivery).payload.length;
  }
}

/**
 * One messenger channel/group/room as it exists independently of any document — an id
 * (opaque, adapter-defined, passed back verbatim to whatever adapter-specific binding
 * mechanism accepts it) and a human-displayable name. Returned only by `listChannels`
 * for a picker to show a person; never interpreted by
 * `document-protocol` or any other core code. Display `name`, bind `id` —
 * a channel's `name` is typically mutable and not guaranteed unique at the
 * messenger level (true for both Signal groups and Matrix rooms), so it
 * must never be used as a lookup key.
 */
export interface RawChannel {
  readonly id: string;
  readonly name: string;
  /**
   * Whether this channel is already end-to-end encrypted at the messenger level, if the
   * adapter can report it — Matrix's own `m.room.encryption` state, which this
   * implementation only ever reads, never sets. `undefined` where an adapter has no
   * comparable per-channel setting to read (e.g. Signal, where group messages are always
   * encrypted) or has not checked.
   */
  readonly encrypted?: boolean;
}

export interface MessengerPort {
  /**
   * Registers `documentId` as a new document, with `creator` as its one,
   * permanent creator identity (SPECIFICATION.md §6.2). Does **not** create,
   * configure, or otherwise touch any underlying messenger channel/group/
   * room — this implementation only ever sends and receives ordinary messages
   * into a channel a person has already created in their own messenger
   * client. Binding *which* existing channel this
   * document's traffic rides on is an adapter-specific concern, handled
   * entirely outside `MessengerPort` (e.g. a bridge's own bind route) —
   * by the time this method is called, an adapter implementation already
   * knows the answer from that prior, adapter-specific step.
   */
  createDocument(documentId: DocumentId, creator: MemberId): Promise<void>;

  /**
   * Broadcasts one payload frame to every member of the channel this document
   * rides on, and returns the delivery's stable id. The payload is the frame's JSON
   * text, opaque here — the transport never parses it, and delivers it character
   * for character (SPECIFICATION.md §2.2, TRN-3).
   *
   * Whether `sender` may write is **not** this method's concern (SPECIFICATION.md CTL-7):
   * permissions are application-level state that `document-protocol` tracks from
   * the creator's control frames and enforces at the sending client. A transport
   * rejects a send only for transport reasons — an unknown document, a
   * disconnection, a size or rate limit — and should say whether the failure is
   * worth retrying by throwing a `TransportSendError` (§3.4); any other
   * error is treated as retryable.
   */
  send(documentId: DocumentId, sender: MemberId, payload: string): Promise<DeliveryId>;

  /**
   * Every delivery recorded for `documentId`, unfiltered and cumulative. The
   * guarantees a caller may rely on, and the only ones: **at least once** (the
   * same delivery may appear twice — de-duplicate on `Delivery.id`), **no
   * ordering**, and **no history replay** (a client that joins later may see only
   * what arrived after it started listening). `Delivery.sender` is authenticated by
   * the messenger, not by us; what that is worth differs per messenger.
   */
  receive(documentId: DocumentId, member: MemberId): Promise<readonly Delivery[]>;

  /**
   * Lists the raw messenger channels/groups/rooms `member`'s underlying
   * messenger account can see — used exclusively to populate a bind/
   * picker (which existing channel should this new document's
   * traffic ride on?), never to answer "which documents do I already
   * have". That question has no `MessengerPort` answer at
   * all: once a document is bound, the caller's own application state
   * remembers it locally — the same way it already must remember which
   * `documentId`s exist to `receive()`/`sync()` against, it also now
   * remembers which ones it has already bound, without asking the
   * messenger again.
   */
  listChannels(member: MemberId): Promise<readonly RawChannel[]>;

  /**
   * What this transport can say about its own limits (SPECIFICATION.md §3.5): the send
   * policies it suggests, and the hard bounds no policy may cross. Optional — a port
   * that has nothing to say (the mock) omits it, or resolves to `undefined`, and the
   * client's own defaults apply. A bridge answers it, because only the bridge knows
   * what sits behind it: a mail server on this machine has no sending limit, one at
   * a provider does.
   */
  transportProfile?(): Promise<TransportProfile | undefined>;

  /**
   * Sends a human-readable invitation (SPECIFICATION.md §11, INV-2) into the
   * document's bound channel, as `sender` — which must be the bridge's own account and
   * the document's creator, or the bridge refuses (BRG-16). Optional: a binding whose
   * invitation *is* how its channel begins (email: the thread's root message, sent when
   * the thread starts) has no separate step and omits it.
   */
  sendInvitation?(documentId: DocumentId, sender: MemberId, text: string): Promise<DeliveryId>;
}

/**
 * The values of a send policy, as a transport states them (SPECIFICATION.md §3.5):
 * a complete policy, every field present. `null` means "no limit" and is allowed only for
 * `maxIntervalMs` and `maxChars`. The names are `document-protocol`'s `SyncPolicy` (which
 * owns their meaning, and whose JSON form this is); they are repeated here only because
 * this package cannot depend on it.
 */
export interface SyncPolicyValues {
  readonly minIntervalMs: number;
  readonly maxIntervalMs: number | null;
  readonly minChars: number;
  readonly maxChars: number | null;
  readonly expectedLatencyMs: number;
}

/** One named bundle of policy values a creator can pick instead of entering five numbers. */
export interface TransportPolicyProfile {
  /** Stable, unique within the transport profile: what `defaultProfile` names. */
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly values: SyncPolicyValues;
}

/**
 * A transport's statement about its own limits (SPECIFICATION.md §3.5), exactly as a bridge serves it: every field present, "no bound" spelled `null`.
 * **Defaults and profiles are suggestions; bounds are not**: a policy from anywhere — the
 * creator, an invitation, a message from someone who may be forging it — is clamped to
 * them, so a bad policy can make a document slower but never make a client exceed what
 * its provider tolerates.
 */
export interface TransportProfile {
  readonly bounds: {
    /** No policy may space messages closer than this; `null` for no floor. */
    readonly minIntervalMs: number | null;
    /** The largest frame one message carries, in bytes of its UTF-8 text; `null` for no limit. */
    readonly maxBytes: number | null;
  };
  /**
   * Named bundles of policy values, in the order to offer them — an array, because a JSON
   * object's member order is not something a parser has to keep.
   */
  readonly profiles: readonly TransportPolicyProfile[];
  /** The id of the bundle that applies when the creator picks none. Always one of `profiles`. */
  readonly defaultProfile: string;
}

/**
 * Reads a `TransportProfile` off the wire (the bridge's `GET /transport-profile`), or
 * `undefined` if it is not one — which the adapter turns into a failed call, never into
 * "no profile" (TRN-13). Strict on purpose, and as a whole: a missing field, a field
 * the specification does not define, a number that is negative or not finite, `null`
 * where no limit is not allowed, no profile at all, two profiles with one id, a profile
 * without a string label and description, a `defaultProfile` that names nothing — each
 * makes the whole profile unusable rather than half-applied. Requiring every field is what keeps a misspelled one from reading
 * as "no bound", which is a way to end up sending faster than the provider allows.
 */
export function parseTransportProfile(raw: unknown): TransportProfile | undefined {
  if (
    !hasExactly(raw, ["bounds", "profiles", "defaultProfile"]) ||
    !hasExactly(raw.bounds, ["minIntervalMs", "maxBytes"]) ||
    !Array.isArray(raw.profiles) ||
    raw.profiles.length === 0
  ) {
    return undefined;
  }
  const minIntervalMs = numberOrNull(raw.bounds.minIntervalMs);
  const maxBytes = numberOrNull(raw.bounds.maxBytes);
  if (minIntervalMs === undefined || maxBytes === undefined) {
    return undefined;
  }
  const profiles: TransportPolicyProfile[] = [];
  for (const entry of raw.profiles as unknown[]) {
    if (
      !hasExactly(entry, ["id", "label", "description", "values"]) ||
      typeof entry.id !== "string" ||
      entry.id.length === 0 ||
      profiles.some((profile) => profile.id === entry.id) ||
      typeof entry.label !== "string" ||
      typeof entry.description !== "string"
    ) {
      return undefined;
    }
    const values = parseValues(entry.values);
    if (values === undefined) {
      return undefined;
    }
    profiles.push({ id: entry.id, label: entry.label, description: entry.description, values });
  }
  const defaultProfile = raw.defaultProfile;
  if (typeof defaultProfile !== "string" || !profiles.some((p) => p.id === defaultProfile)) {
    return undefined;
  }
  return { bounds: { minIntervalMs, maxBytes }, profiles, defaultProfile };
}

/** The bundle of `transport` with this id, or `undefined`. */
export function transportPolicyProfile(
  transport: TransportProfile | undefined,
  id: string,
): TransportPolicyProfile | undefined {
  return transport?.profiles.find((profile) => profile.id === id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether `value` is an object with exactly these keys — none missing, none more. */
function hasExactly(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** The number, `null` for `null`, or `undefined` if it is neither a usable number nor `null`. */
function numberOrNull(value: unknown): number | null | undefined {
  return value === null ? null : isNonNegativeNumber(value) ? value : undefined;
}

function parseValues(raw: unknown): SyncPolicyValues | undefined {
  if (
    !hasExactly(raw, [
      "minIntervalMs",
      "maxIntervalMs",
      "minChars",
      "maxChars",
      "expectedLatencyMs",
    ])
  ) {
    return undefined;
  }
  const { minIntervalMs, minChars, expectedLatencyMs } = raw;
  const maxIntervalMs = numberOrNull(raw.maxIntervalMs);
  const maxChars = numberOrNull(raw.maxChars);
  if (
    !isNonNegativeNumber(minIntervalMs) ||
    !isNonNegativeNumber(minChars) ||
    !isNonNegativeNumber(expectedLatencyMs) ||
    maxIntervalMs === undefined ||
    maxChars === undefined
  ) {
    return undefined;
  }
  return { minIntervalMs, maxIntervalMs, minChars, maxChars, expectedLatencyMs };
}

/**
 * Why a transport refused or failed a `send()` (SPECIFICATION.md §3.4). Two are worth
 * retrying and two are not; the caller (`document-protocol`'s send scheduler)
 * keeps the change and tries again for the first two and drops it, reporting
 * the error, for the others.
 *
 * - `"rate-limited"` — the provider is throttling us (an SMTP 4xx, a Matrix
 *   `M_LIMIT_EXCEEDED`, a Signal rate-limit error). Retryable; the scheduler also
 *   widens the spacing between later sends, since the refusal says the current
 *   pace is too fast.
 * - `"unavailable"` — the messenger or the bridge cannot be reached right now: a
 *   disconnection, a timeout, a 5xx. Retryable.
 * - `"too-large"` — the payload exceeds what this transport carries in one
 *   message. Not retryable: the same payload would be refused again.
 * - `"rejected"` — the transport refuses for a reason waiting cannot change (an
 *   unknown document, a sender that is not a member). Not retryable.
 */
export type TransportSendFailure = "rate-limited" | "unavailable" | "too-large" | "rejected";

/**
 * What a `MessengerPort.send()` throws when it knows which of the four it is.
 * **An error that is not a `TransportSendError` is treated as retryable**, because
 * the alternative — dropping a change on a failure nobody classified — is exactly
 * the fault this exists to remove (without it a refused send is a lost message, and
 * one lost message blinds every receiver to everything that sender sends
 * afterwards); the scheduler's back-off bounds the cost of being wrong.
 */
export class TransportSendError extends Error {
  readonly reason: TransportSendFailure;
  /** What the provider itself said to wait (an HTTP `Retry-After`, say), if it said. */
  readonly retryAfterMs: number | undefined;

  constructor(reason: TransportSendFailure, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "TransportSendError";
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }

  get retryable(): boolean {
    return this.reason === "rate-limited" || this.reason === "unavailable";
  }
}

/**
 * How the bridge HTTP API says why a `send` failed (SPECIFICATION.md, the
 * bridge API), turned into the `TransportSendError` a `MessengerPort` throws. Shared
 * by every adapter that speaks to a bridge, so the four outcomes mean the same thing
 * whichever messenger is behind it:
 *
 * - `429` — rate-limited; a `Retry-After` header (seconds, or an HTTP date) is
 *   passed on as `retryAfterMs`.
 * - `413` — too large.
 * - `400`, `403`, `404`, `409`, `422` — rejected: the bridge refuses this request
 *   and asking again will not change that (a malformed request, an unknown or
 *   unbound document, a forbidden sender, a state it will not send in).
 * - anything else, `5xx` above all — unavailable: the bridge or the messenger
 *   behind it could not be reached or failed. A status nobody classified lands
 *   here too, so a change is never dropped on a failure nobody thought about.
 *
 * `message` is `<operation> failed: <status> <body>`, the text each adapter has
 * always thrown.
 */
export function transportSendErrorFromHttp(
  operation: string,
  status: number,
  body: string,
  retryAfterHeader?: string | null,
): TransportSendError {
  const message = `${operation} failed: ${status} ${body}`;
  if (status === 413) {
    return new TransportSendError("too-large", message);
  }
  if (status === 429) {
    return new TransportSendError("rate-limited", message, parseRetryAfter(retryAfterHeader));
  }
  if (status === 400 || status === 403 || status === 404 || status === 409 || status === 422) {
    return new TransportSendError("rejected", message);
  }
  return new TransportSendError("unavailable", message);
}

/** An HTTP `Retry-After`: a number of seconds, or a date. `undefined` if absent or unreadable. */
function parseRetryAfter(header: string | null | undefined): number | undefined {
  if (header === null || header === undefined || header.trim() === "") {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return seconds >= 0 ? Math.round(seconds * 1000) : undefined;
  }
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * The deterministic fault injection an application may offer while running against the
 * in-memory transport — a disconnect toggle, a corrupted next send. An optional part of
 * `MessengerProvider` rather than a `MessengerPort` method, since a real messenger has no
 * "drop this message" API. Covers the three faults an interactive application needs; the
 * mock's other test-only faults (`holdNextSend`/`releaseHeld`/`dropNextSend`/`replay`) stay
 * reachable only on the mock itself.
 */
export interface MessengerFaultInjection {
  disconnect(member: MemberId): void;
  reconnect(member: MemberId): void;
  modifyNextSend(member: MemberId, modifier: (payload: string) => string): void;
}

/**
 * A `MessengerPort` factory plus identity, so that the mock and every real adapter are
 * interchangeable, selectable implementations rather than one being hardcoded into an
 * application. `id` is for the application's own selection (e.g. a build setting) and is not
 * otherwise interpreted here. Lives in `messenger-port` because every adapter package
 * implements it.
 */
export interface MessengerProvider {
  readonly id: string;
  readonly displayName: string;
  createPort(): Promise<MessengerPort>;
  /** Present only for adapters that can express it — the mock today. */
  readonly faultInjection?: MessengerFaultInjection;
}
