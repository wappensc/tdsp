import {
  type DocumentId,
  jsonTextTooDeep,
  MAX_JSON_NESTING,
  type ResyncRequestId,
} from "@tdsp/messenger-port";
import {
  type ControlStateSnapshot,
  type ControlTarget,
  type ControlValue,
  type ControlVector,
  DEVICE_TAG,
  isControlTarget,
  MAX_COUNTERS_AHEAD,
  MAX_CREATOR_DEVICES,
  MAX_TARGETS,
  type MemberRight,
  memberOf,
  PROFILE_ID_FORM,
  type TargetState,
  valueFitsTarget,
} from "./control-state";
import { type JsonPath, numbersNotInIntegerForm, strictJsonProblem } from "./strict-json";

/**
 * The frame of every `MessengerPort.send()` payload (SPECIFICATION.md §4): a JSON
 * object serialised as text, with binary data — CRDT updates, state vectors —
 * as Base64. Read and written exclusively by `document-protocol`; a `MessengerPort` adapter and
 * a bridge never parse it ("the bridge envelope routes, the payload frame verifies and
 * interprets").
 *
 * ```
 * {"tdsp":2,"kind":"edit","documentId":"doc-a1b2c3","update":"<Base64>","due":30000}
 * ```
 *
 * Every frame has `tdsp` (the format version: 2, the draft marker until TDSP releases 2.0,
 * VER-3), `kind` and `documentId`; each kind adds its own fields (§4.3). Decoding is strict for
 * the defined fields (§4.4): one that is missing, of the wrong type or out of range, or a field
 * without `.` the kind does not define, rejects the whole frame with a named reason; an
 * extension field is ignored unless `crit` names it (FRM-9, FRM-10). There is no unframed path:
 * every payload this code produces or accepts is a frame.
 *
 * A frame carries no document profile: the profile is a property of the document, fixed at
 * creation and named in the invitation (§5.2), so the update and state-vector bytes here are
 * opaque and interpreted by the document's profile alone.
 */

/**
 * The draft marker every frame of this engine carries in place of `2` (VER-3):
 * no draft frame passes for TDSP 2.0, and every 1.x engine refuses it as `unsupported-version`.
 * The revision rises with every incompatible change of the draft wire.
 */
export const CURRENT_FRAME_VERSION = "de.wappensc.together.tdsp.probe.draft-5";

/**
 * How a receiver checks the value of an extension it implements (FRM-16): `true` for one the
 * extension's definition allows. The keys of a map of these are the extensions a receiver
 * implements; a field whose name contains `.` and is not among them is ignored (FRM-9), and one
 * that `crit` names rejects the frame.
 */
export type ExtensionCheck = (value: unknown, kind: Frame["kind"]) => boolean;

/** What a sender adds to a frame (FRM-9, FRM-10): extension fields at its top level, and those of them a receiver must implement. */
export interface OutgoingExtensions {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly crit: readonly string[];
}

const NO_EXTENSIONS: ReadonlyMap<string, ExtensionCheck> = new Map();

/** The most names a frame's `crit` may list. */
export const MAX_CRIT = 16;

/** Whether `name` is an extension field's name (FRM-9). */
export function isExtensionName(name: string): boolean {
  return name.includes(".");
}

const UINT32_MAX = 0xffffffff;
const MAX_ID_BYTES = 255;
const MAX_DECLINE_TEXT = 500;
const MAX_DECLINE_PROFILES = 16;
/** The most targets a control snapshot may list: members, layer rights, the close and the pace (CTL-30). */
export const MAX_SNAPSHOT_TARGETS = MAX_TARGETS;
const PROFILE_ID = PROFILE_ID_FORM;
const MESSAGE_ID = /^[0-9a-f]{16}$/;
/** A digest (LOS-12): the first 8 bytes of SHA-256, as 16 lowercase hex digits. */
const DIGEST = /^[0-9a-f]{16}$/;

const textEncoder = new TextEncoder();

export interface EditFrame {
  readonly kind: "edit";
  readonly documentId: DocumentId;
  readonly update: Uint8Array;
  /** Milliseconds within which the sender will send again at the latest; 0 for no promise (SND-14). */
  readonly due: number;
}

export interface ResyncResponseFrame {
  readonly kind: "resync-response";
  readonly documentId: DocumentId;
  /** The `requestId` of the resync request this answers. */
  readonly respondsTo: ResyncRequestId;
  readonly update: Uint8Array;
  /**
   * The creator's control snapshot, or `null` from anyone else — checked here in full, like
   * every other field (§7.5, FRM-6). Whether it names the creator is the engine's check, which
   * alone knows who the creator is.
   */
  readonly control: DecodedSnapshot | null;
  /** The responder's attribution overlay, or `null` — checked here in full (§5.4). */
  readonly attribution: AttributionOverlay | null;
  /**
   * In an answer's last piece, the responder's state vector and state digest as it answered
   * (RSY-18, LOS-12): what the requester holds once it has every piece. `null` in the others.
   */
  readonly stateVector: Uint8Array | null;
  readonly stateDigest: string | null;
  /** The responder's stream and this answer's number in it, the same in every piece (LOS-13). */
  readonly stream: string;
  readonly sequence: number;
  /** This piece's number in the answer, from 1 (RSY-18). */
  readonly piece: number;
  /** In the answer's last piece, how many pieces it has — that piece's own number; `null` in the others. */
  readonly pieces: number | null;
}

/**
 * A control snapshot as it arrives (CTL-25): the document's profile, the control
 * vector and, per target, what its operations had seen and the operations nothing supersedes.
 */
export interface DecodedSnapshot extends ControlStateSnapshot {
  readonly profile: string;
}

/** One author's stretch of the plain-text projection, `[start, end)` (§5.4); `null` for unattributed text (ATR-2). */
export interface AttributionRange {
  readonly start: number;
  readonly end: number;
  readonly authorId: string | null;
}

/** An attribution overlay as it arrives (§5.4): ranges covering the projection from 0, in order, without gaps. */
export interface AttributionOverlay {
  readonly ranges: readonly AttributionRange[];
  readonly lastEditBySender: Readonly<Record<string, number>>;
}

/** The permission a control operation sets on a member; `null` revokes. The creator's own is never carried. */
export type ControlPermission = MemberRight;

/**
 * One control operation of a device of the creator (CTL-20): its device's tag
 * and own counter, the target and value, and what the device had seen of the other creator
 * devices (CTL-22).
 */
export interface ControlFrame {
  readonly kind: "control";
  readonly documentId: DocumentId;
  readonly device: string;
  readonly counter: number;
  readonly target: ControlTarget;
  readonly value: ControlValue;
  readonly seen: ControlVector;
  /** As an edit's: when its sender will send again at the latest; 0 for no promise (SND-14). */
  readonly due: number;
}

/**
 * "I have sent everything I am going to for now, and this is what I have" — sent once,
 * `maxIntervalMs` after an engine's last message that owes one (§9.3). It carries no document
 * content; a receiver compares the sender's state vector with its own to see a lost final
 * message.
 */
export interface HeartbeatFrame {
  readonly kind: "heartbeat";
  readonly documentId: DocumentId;
  /** A device of the creator's control vector (SND-11); `null` from anyone else. */
  readonly control: ControlVector | null;
  /** The digest of the control state behind `control` (LOS-12); `null` exactly when `control` is. */
  readonly controlDigest: string | null;
  readonly stateVector: Uint8Array;
  /** The digest of the sender's content (LOS-12): what its state vector does not show, deletions. */
  readonly stateDigest: string;
  /** The sender's stream — its engine as it runs now — and this report's number in it (LOS-13). */
  readonly stream: string;
  readonly sequence: number;
}

/** "I need to be caught up" (§8.2): how far the requester is along, in control state and content. */
export interface ResyncRequestFrame {
  readonly kind: "resync-request";
  readonly documentId: DocumentId;
  /**
   * 16 lowercase hex digits, random, chosen by the requester (§8.2): what an answer names in
   * `respondsTo`. Not the messenger's delivery id, which a requester does not always know the
   * way receivers see it.
   */
  readonly requestId: string;
  /**
   * The requester's control vector, or `null` while it holds no snapshot from the creator: the
   * creator then answers it regardless (RSY-17).
   */
  readonly control: ControlVector | null;
  /** The digest of the requester's control state (LOS-12); `null` exactly when `control` is. */
  readonly controlDigest: string | null;
  /** Answer even with nothing to add: the requester cannot tell what it lacks (RSY-16, LOS-19). */
  readonly force: boolean;
  readonly stateVector: Uint8Array;
  /** The digest of the requester's content (LOS-12). */
  readonly stateDigest: string;
  /** The requester's stream and this report's number in it (LOS-13). */
  readonly stream: string;
  readonly sequence: number;
}

export type DeclineReason = "unsupported-profile" | "unsupported-version" | "declined" | "other";

/** A joiner declining an invitation (§6.5). Changes no state; reported to the application. */
export interface DeclineFrame {
  readonly kind: "decline";
  readonly documentId: DocumentId;
  readonly reason: DeclineReason;
  /** The document profiles the sender's engine implements. */
  readonly profiles?: readonly string[];
  /** A human-readable explanation, at most 500 characters. */
  readonly text?: string;
}

export type Frame = (
  | EditFrame
  | ResyncResponseFrame
  | ControlFrame
  | HeartbeatFrame
  | ResyncRequestFrame
  | DeclineFrame
) & {
  /**
   * The values of the extensions the receiver implements that the frame carries at its top level
   * and that their definitions allow (FRM-16); absent when there is none. The sender's, untrusted.
   */
  readonly extensions?: Readonly<Record<string, unknown>>;
};

/**
 * Thrown for a frame that is rejected (§4.4). `reason` is a short, stable, machine-readable
 * discriminator; `message` is the human-readable detail. `document-mismatch` is raised by the
 * engine after decoding, `profile-mismatch` for a creator's snapshot naming another profile.
 * `sender` is the delivery's sender, which the engine adds when it reports the rejection (FRM-7),
 * so that an application can say whom it concerns — whose frames are of another version (VER-4).
 */
export class FrameDecodeError extends Error {
  readonly reason:
    | "not-json"
    | "unsupported-version"
    | "unknown-kind"
    | "missing-field"
    | "invalid-field"
    | "document-mismatch"
    | "profile-mismatch"
    | "unsupported-extension";
  readonly sender: string | undefined;

  constructor(reason: FrameDecodeError["reason"], message: string, sender?: string) {
    super(message);
    this.name = "FrameDecodeError";
    this.reason = reason;
    this.sender = sender;
  }

  /** The same rejection, as the engine reports it for a delivery of `sender` (FRM-7). */
  from(sender: string): FrameDecodeError {
    const reported = new FrameDecodeError(this.reason, this.message, sender);
    if (this.stack !== undefined) {
      reported.stack = this.stack;
    }
    return reported;
  }
}

/** The size a frame takes on the wire: the bytes of its UTF-8 text (what `maxBytes` counts). */
export function frameByteLength(frame: string): number {
  return textEncoder.encode(frame).length;
}

/** Whether `id` is a document profile id, `<name>/<major>` (§5). */
export function isProfileId(id: unknown): id is string {
  return typeof id === "string" && PROFILE_ID.test(id);
}

/**
 * Whether `name` is a layer id (SPECIFICATION.md §5.6): of the same form as a profile id,
 * `<name>/<major>`. A top-level shared type named otherwise is not a layer.
 */
export function isLayerId(name: unknown): name is string {
  return isProfileId(name);
}

// ---- encoding -------------------------------------------------------------------------------

function checkId(name: string, value: string): void {
  const bytes = textEncoder.encode(value).length;
  if (bytes < 1 || bytes > MAX_ID_BYTES) {
    throw new Error(`${name} must be 1..${MAX_ID_BYTES} UTF-8 bytes, got ${bytes}`);
  }
}

function checkRandomId(name: string, value: string): void {
  if (!MESSAGE_ID.test(value)) {
    throw new Error(`${name} must be 16 lowercase hex digits`);
  }
}

/**
 * A random id for a request, or a stream tag (LOS-13): 64 bits, as 16 lowercase hex digits (§4.3).
 */
export function newRandomId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function checkUint32(name: string, value: number, min = 0): void {
  if (!Number.isInteger(value) || value < min || value > UINT32_MAX) {
    throw new Error(`${name} out of range: ${value} (need ${min}..${UINT32_MAX})`);
  }
}

function frameText(
  documentId: DocumentId,
  kind: Frame["kind"],
  fields: object,
  extensions?: OutgoingExtensions,
): string {
  checkId("documentId", documentId);
  return JSON.stringify({
    tdsp: CURRENT_FRAME_VERSION,
    kind,
    documentId,
    ...fields,
    ...extensionFields(extensions),
  });
}

/** The extension fields and `crit` a sender adds after the defined fields, or an error for ones FRM-9 and FRM-10 forbid. */
function extensionFields(extensions: OutgoingExtensions | undefined): Record<string, unknown> {
  if (extensions === undefined) {
    return {};
  }
  const names = Object.keys(extensions.fields);
  if (!names.every(isExtensionName)) {
    throw new Error("an extension name must contain a dot (FRM-9)");
  }
  if (extensions.crit.length > MAX_CRIT || !extensions.crit.every((name) => names.includes(name))) {
    throw new Error(`crit names at most ${MAX_CRIT} of the frame's own extensions (FRM-10)`);
  }
  return extensions.crit.length === 0
    ? { ...extensions.fields }
    : { ...extensions.fields, crit: [...extensions.crit] };
}

export function encodeEditFrame(
  documentId: DocumentId,
  update: Uint8Array,
  due = 0,
  extensions?: OutgoingExtensions,
): string {
  if (update.length === 0) {
    throw new Error("an edit frame needs an update");
  }
  checkUint32("due", due);
  return frameText(documentId, "edit", { update: bytesToBase64(update), due }, extensions);
}

/**
 * Where a report stands in its sender's stream (LOS-13): the stream's tag and the report's number.
 * Left out, a frame is the first report of a stream of its own — what a test that writes a frame by
 * hand needs; an engine always says.
 */
export interface StreamPosition {
  readonly stream?: string;
  readonly sequence?: number;
}

function streamFields(position: StreamPosition): { stream: string; sequence: number } {
  const stream = position.stream ?? newRandomId();
  checkRandomId("stream", stream);
  const sequence = position.sequence ?? 1;
  checkUint32("sequence", sequence, 1);
  return { stream, sequence };
}

export function encodeResyncRequestFrame(
  options: {
    documentId: DocumentId;
    requestId: string;
    control: ControlVector | null;
    controlDigest: string | null;
    force: boolean;
    stateVector: Uint8Array;
    stateDigest: string;
    extensions?: OutgoingExtensions;
  } & StreamPosition,
): string {
  checkRandomId("requestId", options.requestId);
  return frameText(
    options.documentId,
    "resync-request",
    {
      requestId: options.requestId,
      control: options.control === null ? null : checkedVector("control", options.control),
      controlDigest: checkedDigestBeside(options.control, options.controlDigest),
      force: options.force,
      stateVector: bytesToBase64(options.stateVector),
      stateDigest: checkedDigest("stateDigest", options.stateDigest),
      ...streamFields(options),
    },
    options.extensions,
  );
}

export function encodeResyncResponseFrame(
  options: {
    documentId: DocumentId;
    respondsTo: ResyncRequestId;
    update: Uint8Array;
    control?: object | null;
    attribution?: object | null;
    /** The responder's state vector and digest, in an answer's last piece (RSY-18); both or neither. */
    state?: { readonly stateVector: Uint8Array; readonly stateDigest: string } | null;
    /** This piece's number, from 1; left out, 1 (RSY-18). */
    piece?: number;
    extensions?: OutgoingExtensions;
  } & StreamPosition,
): string {
  checkRandomId("respondsTo", options.respondsTo);
  // Never empty, as an edit's (§4.3): where nothing is lacking, the profile's update that holds
  // nothing goes instead (PRF-1, item 4; SND-18).
  if (options.update.length === 0) {
    throw new Error(
      "a resync-response needs an update; one that holds nothing where nothing is lacking",
    );
  }
  const state = options.state ?? null;
  const piece = options.piece ?? 1;
  checkUint32("piece", piece, 1);
  return frameText(
    options.documentId,
    "resync-response",
    {
      respondsTo: options.respondsTo,
      update: bytesToBase64(options.update),
      control: options.control ?? null,
      attribution: options.attribution ?? null,
      stateVector: state === null ? null : bytesToBase64(state.stateVector),
      stateDigest: state === null ? null : checkedDigest("stateDigest", state.stateDigest),
      ...streamFields(options),
      piece,
      // The last piece — the one that states the responder's state — says how many there are: its
      // own number, since pieces are numbered from 1 (RSY-18).
      pieces: state === null ? null : piece,
    },
    options.extensions,
  );
}

export function encodeControlFrame(options: {
  documentId: DocumentId;
  device: string;
  counter: number;
  target: ControlTarget;
  value: ControlValue;
  seen: ControlVector;
  due?: number;
}): string {
  checkUint32("due", options.due ?? 0);
  if (!DEVICE_TAG.test(options.device)) {
    throw new Error("a device tag is 22 base64url characters");
  }
  checkUint32("control counter", options.counter, 1);
  if (Object.hasOwn(options.seen, options.device)) {
    throw new Error("an operation's seen names the other creator devices, not its own (CTL-20)");
  }
  if (!isControlTarget(options.target) || !valueFitsTarget(options.target, options.value)) {
    throw new Error(`a control operation on ${options.target} cannot set ${String(options.value)}`);
  }
  const member = memberOf(options.target);
  if (member !== undefined) {
    checkId("member id", member);
  }
  return frameText(options.documentId, "control", {
    device: options.device,
    counter: options.counter,
    target: options.target,
    value: options.value,
    seen: checkedVector("seen", options.seen),
    due: options.due ?? 0,
  });
}

export function encodeHeartbeatFrame(
  options: {
    documentId: DocumentId;
    control: ControlVector | null;
    controlDigest: string | null;
    stateVector: Uint8Array;
    stateDigest: string;
    extensions?: OutgoingExtensions;
  } & StreamPosition,
): string {
  return frameText(
    options.documentId,
    "heartbeat",
    {
      control: options.control === null ? null : checkedVector("control", options.control),
      controlDigest: checkedDigestBeside(options.control, options.controlDigest),
      stateVector: bytesToBase64(options.stateVector),
      stateDigest: checkedDigest("stateDigest", options.stateDigest),
      ...streamFields(options),
    },
    options.extensions,
  );
}

function checkedDigest(name: string, digest: string): string {
  if (!DIGEST.test(digest)) {
    throw new Error(`${name} must be 16 lowercase hex digits`);
  }
  return digest;
}

function checkedDigestBeside(control: ControlVector | null, digest: string | null): string | null {
  if ((control === null) !== (digest === null)) {
    throw new Error("a control digest goes with a control vector, and only with one");
  }
  return digest === null ? null : checkedDigest("controlDigest", digest);
}

/**
 * A control vector, sorted for one spelling, or an error for one that is not; a device of which
 * nothing is held without a gap is absent, never written with 0 (FRM-14).
 */
function checkedVector(name: string, vector: ControlVector): Record<string, number> {
  const entries = Object.entries(vector).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length > MAX_CREATOR_DEVICES) {
    throw new Error(`${name} names more than ${MAX_CREATOR_DEVICES} devices`);
  }
  for (const [device, counter] of entries) {
    if (!DEVICE_TAG.test(device)) {
      throw new Error(`${name} names something that is not a device tag`);
    }
    checkUint32(`${name} counter`, counter, 1);
  }
  return Object.fromEntries(entries);
}

export function encodeDeclineFrame(options: {
  documentId: DocumentId;
  reason: DeclineReason;
  profiles?: readonly string[];
  text?: string;
}): string {
  if (!DECLINE_REASONS.has(options.reason)) {
    throw new Error(`unknown decline reason: ${options.reason}`);
  }
  if (options.profiles !== undefined) {
    if (options.profiles.length > MAX_DECLINE_PROFILES || !options.profiles.every(isProfileId)) {
      throw new Error(`profiles must be at most ${MAX_DECLINE_PROFILES} profile ids`);
    }
  }
  if (options.text !== undefined && [...options.text].length > MAX_DECLINE_TEXT) {
    throw new Error(`a decline's text is at most ${MAX_DECLINE_TEXT} characters`);
  }
  return frameText(options.documentId, "decline", {
    reason: options.reason,
    ...(options.profiles === undefined ? {} : { profiles: [...options.profiles] }),
    ...(options.text === undefined ? {} : { text: options.text }),
  });
}

// ---- decoding -------------------------------------------------------------------------------

const DECLINE_REASONS: ReadonlySet<string> = new Set([
  "unsupported-profile",
  "unsupported-version",
  "declined",
  "other",
]);

const FIELDS: Readonly<Record<Frame["kind"], readonly string[]>> = {
  edit: ["update", "due"],
  "resync-request": [
    "requestId",
    "control",
    "controlDigest",
    "force",
    "stateVector",
    "stateDigest",
    "stream",
    "sequence",
  ],
  "resync-response": [
    "respondsTo",
    "update",
    "control",
    "attribution",
    "stateVector",
    "stateDigest",
    "stream",
    "sequence",
    "piece",
    "pieces",
  ],
  control: ["device", "counter", "target", "value", "seen", "due"],
  heartbeat: ["control", "controlDigest", "stateVector", "stateDigest", "stream", "sequence"],
  decline: ["reason", "profiles", "text"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): FrameDecodeError {
  return new FrameDecodeError("invalid-field", message);
}

/** Reads a frame's fields strictly, one kind's rules at a time. */
class Fields {
  readonly #raw: Record<string, unknown>;
  constructor(raw: Record<string, unknown>) {
    this.#raw = raw;
  }

  has(name: string): boolean {
    return Object.hasOwn(this.#raw, name);
  }

  #required(name: string): unknown {
    if (!this.has(name)) {
      throw new FrameDecodeError("missing-field", `the frame has no ${name}`);
    }
    return this.#raw[name];
  }

  string(name: string): string {
    const value = this.#required(name);
    if (typeof value !== "string") {
      throw invalid(`${name} must be a string`);
    }
    return value;
  }

  id(name: string): string {
    const value = this.string(name);
    const bytes = textEncoder.encode(value).length;
    if (bytes < 1 || bytes > MAX_ID_BYTES) {
      throw invalid(`${name} must be 1..${MAX_ID_BYTES} UTF-8 bytes`);
    }
    return value;
  }

  boolean(name: string): boolean {
    const value = this.#required(name);
    if (typeof value !== "boolean") {
      throw invalid(`${name} must be true or false`);
    }
    return value;
  }

  /** A random id: 16 lowercase hex digits (a request's `requestId`, an answer's `respondsTo`). */
  randomId(name: string): string {
    const value = this.string(name);
    if (!MESSAGE_ID.test(value)) {
      throw invalid(`${name} must be 16 lowercase hex digits`);
    }
    return value;
  }

  /** A digest (LOS-12): 16 lowercase hex digits. */
  digest(name: string): string {
    const value = this.string(name);
    if (!DIGEST.test(value)) {
      throw invalid(`${name} must be 16 lowercase hex digits`);
    }
    return value;
  }

  digestOrNull(name: string): string | null {
    return this.#required(name) === null ? null : this.digest(name);
  }

  integerOrNull(name: string, min: number, max: number): number | null {
    return this.#required(name) === null ? null : this.integer(name, min, max);
  }

  base64OrNull(name: string): Uint8Array | null {
    return this.#required(name) === null ? null : this.base64(name);
  }

  integer(name: string, min: number, max: number): number {
    const value = this.#required(name);
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      throw invalid(`${name} must be an integer from ${min} to ${max}`);
    }
    return value;
  }

  base64(name: string, options: { nonEmpty?: boolean } = {}): Uint8Array {
    const bytes = base64ToBytes(this.string(name));
    if (bytes === undefined) {
      throw invalid(`${name} is not Base64`);
    }
    if (options.nonEmpty === true && bytes.length === 0) {
      throw invalid(`${name} must not be empty`);
    }
    return bytes;
  }

  objectOrNull(name: string): Record<string, unknown> | null {
    const value = this.#required(name);
    if (value !== null && !isRecord(value)) {
      throw invalid(`${name} must be an object or null`);
    }
    return value;
  }

  optional(name: string): unknown {
    return this.#raw[name];
  }
}

/**
 * Parses one frame (§4.4). Throws `FrameDecodeError` with a distinct reason for each way a frame
 * can be wrong; never a partial parse. The frame's documentId is returned as read — whether it
 * is the document the delivery was routed to is the engine's check (`document-mismatch`).
 * `extensions` are those the receiver implements, each with its check (FRM-16); without them it
 * implements none.
 */
export function decodeFrame(
  text: string,
  extensions: ReadonlyMap<string, ExtensionCheck> = NO_EXTENSIONS,
): Frame {
  // Before the parser, so no frame's nesting is ever the parser's problem (§1.6, JSN-1).
  if (jsonTextTooDeep(text)) {
    throw new FrameDecodeError(
      "not-json",
      `the payload nests arrays and objects more than ${MAX_JSON_NESTING} deep`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new FrameDecodeError("not-json", "the payload is not JSON");
  }
  if (!isRecord(parsed)) {
    throw new FrameDecodeError("not-json", "the payload is not a JSON object");
  }
  const ambiguity = strictJsonProblem(text);
  if (ambiguity !== undefined) {
    throw new FrameDecodeError("not-json", `the payload is not I-JSON: ${ambiguity}`);
  }
  if (parsed.tdsp !== CURRENT_FRAME_VERSION) {
    throw new FrameDecodeError(
      "unsupported-version",
      parsed.tdsp === undefined
        ? "not a TDSP frame (no tdsp field)"
        : `unsupported frame version ${JSON.stringify(parsed.tdsp)}, expected ${CURRENT_FRAME_VERSION}`,
    );
  }
  const kind = parsed.kind;
  if (typeof kind !== "string" || !Object.hasOwn(FIELDS, kind)) {
    throw new FrameDecodeError("unknown-kind", `unknown frame kind ${String(kind)}`);
  }
  const allowed = new Set(["tdsp", "kind", "documentId", "crit", ...FIELDS[kind as Frame["kind"]]]);
  for (const key of Object.keys(parsed)) {
    if (!allowed.has(key) && !isExtensionName(key)) {
      throw invalid(`a ${kind} frame has no field ${key}`);
    }
  }
  checkCrit(parsed, extensions);
  const f = new Fields(parsed);
  const frame = decodeDefined(kind as Frame["kind"], f, f.id("documentId"));
  checkIntegerForms(text, frame.kind);
  return withExtensions(frame, parsed, extensions);
}

/**
 * Where a value stands in the layout of a frame (§4.3), a snapshot (§7.5) or an overlay (§5.4):
 * what the names below it are. In `fields` places a name is a field's, and one with `.` an
 * extension's (FRM-9); in `map` and `targets` places the names are data — device tags, MemberIds,
 * targets — and a dot in them means nothing.
 */
type Place =
  | "frame"
  | "snapshot"
  | "targets"
  | "target"
  | "heads"
  | "operation"
  | "overlay"
  | "ranges"
  | "range"
  | "map"
  | "value";

const FIELD_PLACES: ReadonlySet<Place> = new Set([
  "frame",
  "snapshot",
  "target",
  "operation",
  "overlay",
  "range",
]);

/** The place below `name` in `place`, or `extension` for an extension field (FRM-9). */
function placeBelow(place: Place, name: string | number, kind: Frame["kind"]): Place | "extension" {
  if (typeof name === "string" && FIELD_PLACES.has(place) && isExtensionName(name)) {
    return "extension";
  }
  switch (place) {
    case "frame":
      return name === "control"
        ? kind === "resync-response"
          ? "snapshot"
          : "map"
        : name === "seen"
          ? "map"
          : name === "attribution"
            ? "overlay"
            : "value";
    case "snapshot":
      return name === "vector" || name === "aboveHoles"
        ? "map"
        : name === "targets"
          ? "targets"
          : "value";
    case "targets":
      return "target";
    case "target":
      return name === "seen" ? "map" : name === "heads" ? "heads" : "value";
    case "heads":
      return "operation";
    case "operation":
      return name === "seen" ? "map" : "value";
    case "overlay":
      return name === "ranges" ? "ranges" : name === "lastEditBySender" ? "map" : "value";
    case "ranges":
      return "range";
    default:
      return "value";
  }
}

function inExtension(path: JsonPath, kind: Frame["kind"]): boolean {
  let place: Place = "frame";
  for (const name of path) {
    const below = placeBelow(place, name, kind);
    if (below === "extension") {
      return true;
    }
    place = below;
  }
  return false;
}

/**
 * Every number the layout defines is an integer, written without a fraction or an exponent (§1.6,
 * §4.3): `1.0`, `1e3` and `-0` read as integers, but a decoder that reads integers as integers
 * rejects them, and the two would apply different frames (FRM-6). An extension's values are its
 * definition's to judge (FRM-9, FRM-16).
 */
function checkIntegerForms(text: string, kind: Frame["kind"]): void {
  const loose = numbersNotInIntegerForm(text).find((path) => !inExtension(path, kind));
  if (loose !== undefined) {
    throw invalid(`${loose.join(".")} is an integer written with a fraction, an exponent or as -0`);
  }
}

/** The fields the layout of `kind` defines (§4.3). */
function decodeDefined(kind: Frame["kind"], f: Fields, documentId: DocumentId): Frame {
  switch (kind) {
    case "edit":
      return {
        kind: "edit",
        documentId,
        update: f.base64("update", { nonEmpty: true }),
        due: f.integer("due", 0, UINT32_MAX),
      };
    case "resync-request": {
      const control = decodeVectorOrNull(f.objectOrNull("control"), "the request's control");
      return {
        kind: "resync-request",
        documentId,
        requestId: f.randomId("requestId"),
        control,
        controlDigest: digestBeside(control, f, "the request"),
        force: f.boolean("force"),
        stateVector: f.base64("stateVector"),
        stateDigest: f.digest("stateDigest"),
        ...decodeStream(f),
      };
    }
    case "resync-response": {
      const stateVector = f.base64OrNull("stateVector");
      const stateDigest = f.digestOrNull("stateDigest");
      if ((stateVector === null) !== (stateDigest === null)) {
        throw invalid(
          "an answer carries its state vector and its state digest together, or neither",
        );
      }
      const piece = f.integer("piece", 1, UINT32_MAX);
      const pieces = f.integerOrNull("pieces", 1, UINT32_MAX);
      // The last piece says how many there are, which is its own number, and states the responder's
      // state; no other piece does either (RSY-18).
      if (pieces !== null && pieces !== piece) {
        throw invalid("an answer's last piece is numbered as many as the answer has pieces");
      }
      if ((pieces === null) !== (stateVector === null)) {
        throw invalid(
          "an answer's last piece, and only that, carries the count of pieces and the responder's state",
        );
      }
      return {
        kind: "resync-response",
        documentId,
        respondsTo: f.randomId("respondsTo"),
        update: f.base64("update", { nonEmpty: true }),
        control: decodeSnapshot(f.objectOrNull("control")),
        attribution: decodeAttribution(f.objectOrNull("attribution")),
        stateVector,
        stateDigest,
        ...decodeStream(f),
        piece,
        pieces,
      };
    }
    case "heartbeat": {
      const control = decodeVectorOrNull(f.objectOrNull("control"), "the heartbeat's control");
      return {
        kind: "heartbeat",
        documentId,
        control,
        controlDigest: digestBeside(control, f, "the heartbeat"),
        stateVector: f.base64("stateVector"),
        stateDigest: f.digest("stateDigest"),
        ...decodeStream(f),
      };
    }
    case "control":
      return decodeControl(f, documentId);
    case "decline":
      return decodeDecline(f, documentId);
  }
}

/** A report's place in its sender's stream (LOS-13): the stream's tag, 16 lowercase hex digits, and a number from 1. */
function decodeStream(f: Fields): { stream: string; sequence: number } {
  return { stream: f.randomId("stream"), sequence: f.integer("sequence", 1, UINT32_MAX) };
}

/** `controlDigest` beside a control vector: a digest exactly when there is a vector (LOS-12). */
function digestBeside(control: ControlVector | null, f: Fields, what: string): string | null {
  const digest = f.digestOrNull("controlDigest");
  if ((control === null) !== (digest === null)) {
    throw invalid(`${what} carries a control digest exactly when it carries a control vector`);
  }
  return digest;
}

/**
 * The values of the extensions a receiver implements, checked as their definitions say (FRM-16):
 * one that fails is ignored, unless `crit` names it, and then the frame is rejected, before
 * anything of it is applied (FRM-6). Below the top level, this version defines no place for an
 * extension an engine implements; there, every one is ignored (FRM-9, FRM-17).
 */
function withExtensions(
  frame: Frame,
  parsed: Record<string, unknown>,
  extensions: ReadonlyMap<string, ExtensionCheck>,
): Frame {
  const crit = (parsed.crit ?? []) as readonly string[];
  const values: Record<string, unknown> = {};
  for (const [name, allows] of extensions) {
    if (!Object.hasOwn(parsed, name)) {
      continue;
    }
    if (allows(parsed[name], frame.kind)) {
      values[name] = parsed[name];
    } else if (crit.includes(name)) {
      throw invalid(
        `the frame requires the extension ${name}, and its value is not one the extension defines`,
      );
    }
  }
  return Object.keys(values).length === 0 ? frame : { ...frame, extensions: values };
}

/**
 * `crit` (FRM-10): absent, or a list of extension names, each of which this receiver must
 * implement; a name it does not rejects the frame as `unsupported-extension`. Each name is one the
 * frame carries at its top level, and none twice: a name without its field, or a second time, gives
 * a sender's `crit` two readings — whether the receiver must implement an extension that is not
 * there — so it is `invalid-field`, whatever the receiver implements.
 */
function checkCrit(
  parsed: Record<string, unknown>,
  extensions: ReadonlyMap<string, ExtensionCheck>,
): void {
  const crit = parsed.crit;
  if (crit === undefined) {
    return;
  }
  if (
    !Array.isArray(crit) ||
    crit.length === 0 ||
    crit.length > MAX_CRIT ||
    !crit.every((name) => typeof name === "string" && isExtensionName(name))
  ) {
    throw invalid(`crit must be a list of 1 to ${MAX_CRIT} extension names`);
  }
  if (new Set(crit).size !== crit.length) {
    throw invalid("crit names an extension twice");
  }
  const absent = crit.find((name) => !Object.hasOwn(parsed, name));
  if (absent !== undefined) {
    throw invalid(`crit names the extension ${String(absent)}, which the frame does not carry`);
  }
  const unknown = crit.find((name) => !extensions.has(name));
  if (unknown !== undefined) {
    throw new FrameDecodeError(
      "unsupported-extension",
      `the frame requires the extension ${String(unknown)}, which this receiver does not implement`,
    );
  }
}

/**
 * Throws `invalid-field` unless `raw` has exactly the keys `required` plus any of `optional`;
 * extension fields — a name with `.` — are ignored (FRM-9).
 */
function exactKeys(
  what: string,
  raw: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  for (const key of required) {
    if (!Object.hasOwn(raw, key)) {
      throw new FrameDecodeError("missing-field", `${what} has no ${key}`);
    }
  }
  for (const key of Object.keys(raw)) {
    if (!required.includes(key) && !optional.includes(key) && !isExtensionName(key)) {
      throw invalid(`${what} has an undefined field ${key}`);
    }
  }
}

function isUint32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= UINT32_MAX;
}

function isId(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const bytes = textEncoder.encode(value).length;
  return bytes >= 1 && bytes <= MAX_ID_BYTES;
}

/**
 * A control vector (§4.3, §7.4): device tags to uint32 counters, at most one entry per creator device
 * bound. An entry of 0 is read as it is written here; the control state drops it (FRM-14).
 */
function decodeVector(raw: unknown, what: string): ControlVector {
  if (!isRecord(raw)) {
    throw invalid(`${what} must be an object`);
  }
  const entries = Object.entries(raw);
  if (entries.length > MAX_CREATOR_DEVICES) {
    throw invalid(`${what} names more than ${MAX_CREATOR_DEVICES} devices`);
  }
  const vector: Record<string, number> = {};
  for (const [device, counter] of entries) {
    if (!DEVICE_TAG.test(device) || !isUint32(counter)) {
      throw invalid(`${what} must map device tags to uint32 counters`);
    }
    vector[device] = counter;
  }
  return vector;
}

/**
 * What an operation had seen of the other creator devices (CTL-20): a control vector that does not
 * name the operation's own device, whose earlier counters are implied (CTL-22). One that did could
 * make the operation supersede itself, so that it held nowhere and counted nowhere. An entry of 0
 * names nothing, its own device's too (FRM-14).
 */
function decodeSeen(raw: unknown, device: string, what: string): ControlVector {
  const seen = decodeVector(raw, what);
  if ((seen[device] ?? 0) > 0) {
    throw invalid(`${what} names the operation's own device`);
  }
  return seen;
}

function decodeVectorOrNull(
  raw: Record<string, unknown> | null,
  what: string,
): ControlVector | null {
  return raw === null ? null : decodeVector(raw, what);
}

/**
 * The control state a snapshot carries (CTL-25), checked completely before anything of the frame
 * is applied (FRM-6): an invalid snapshot rejects the whole response.
 */
function decodeSnapshot(raw: Record<string, unknown> | null): DecodedSnapshot | null {
  if (raw === null) {
    return null;
  }
  exactKeys("the snapshot", raw, ["profile", "vector", "targets"], ["aboveHoles"]);
  if (!isProfileId(raw.profile)) {
    throw invalid("the snapshot's profile is not a profile id");
  }
  const vector = decodeVector(raw.vector, "the snapshot's vector");
  const aboveHoles =
    raw.aboveHoles === undefined ? undefined : decodeAboveHoles(raw.aboveHoles, vector);
  if (!isRecord(raw.targets)) {
    throw invalid("the snapshot's targets must be an object");
  }
  // Every key of `targets` is a target, not a field name: a MemberId may contain `.` (FRM-9).
  const entries = Object.entries(raw.targets);
  if (entries.length > MAX_SNAPSHOT_TARGETS) {
    throw invalid(`the snapshot lists more than ${MAX_SNAPSHOT_TARGETS} targets`);
  }
  const targets: Record<string, TargetState> = {};
  for (const [name, state] of entries) {
    if (!isControlTarget(name) || (memberOf(name) !== undefined && !isId(memberOf(name)))) {
      throw invalid(`the snapshot names an unknown target ${name}`);
    }
    if (!isRecord(state)) {
      throw invalid(`the snapshot's target ${name} must be an object`);
    }
    exactKeys(`the snapshot's target ${name}`, state, ["seen", "heads"]);
    if (!Array.isArray(state.heads) || state.heads.length > MAX_CREATOR_DEVICES) {
      throw invalid(
        `the snapshot's target ${name} must list at most ${MAX_CREATOR_DEVICES} operations`,
      );
    }
    // At most one head per device (§7.5): a device's later operation supersedes its earlier ones
    // (CTL-22), and two under one counter merge into one (CTL-24), so a second is no state a
    // creator can hold.
    const devices = new Set<string>();
    const heads = (state.heads as unknown[]).map((head) => {
      if (!isRecord(head)) {
        throw invalid("an operation in the snapshot must be an object");
      }
      exactKeys("an operation in the snapshot", head, ["device", "counter", "value", "seen"]);
      if (typeof head.device !== "string" || !DEVICE_TAG.test(head.device)) {
        throw invalid("an operation in the snapshot needs a device tag");
      }
      if (devices.has(head.device)) {
        throw invalid(`the snapshot's target ${name} has two heads of the device ${head.device}`);
      }
      devices.add(head.device);
      if (!isUint32(head.counter) || head.counter < 1) {
        throw invalid("an operation in the snapshot needs a counter from 1");
      }
      if (!valueFitsTarget(name, head.value)) {
        throw invalid(`an operation on ${name} cannot set ${String(head.value)}`);
      }
      return {
        device: head.device,
        counter: head.counter,
        value: head.value,
        seen: decodeSeen(head.seen, head.device, "an operation in the snapshot's seen"),
      };
    });
    targets[name] = {
      seen: decodeVector(state.seen, `the snapshot's target ${name}'s seen`),
      heads,
    };
  }
  return {
    profile: raw.profile,
    vector,
    targets,
    ...(aboveHoles === undefined ? {} : { aboveHoles }),
  };
}

/**
 * A snapshot's counters held above a hole (§7.5): per device tag, 1 to 1 024 counters, ascending
 * without repeats, each above that device's entry in `vector` (CTL-30) — at most one entry per
 * creator device bound.
 */
function decodeAboveHoles(raw: unknown, vector: ControlVector): Record<string, number[]> {
  if (!isRecord(raw)) {
    throw invalid("the snapshot's aboveHoles must be an object");
  }
  const entries = Object.entries(raw);
  if (entries.length > MAX_CREATOR_DEVICES) {
    throw invalid(`the snapshot's aboveHoles names more than ${MAX_CREATOR_DEVICES} devices`);
  }
  const result: Record<string, number[]> = {};
  for (const [device, counters] of entries) {
    if (
      !DEVICE_TAG.test(device) ||
      !Array.isArray(counters) ||
      counters.length === 0 ||
      counters.length > MAX_COUNTERS_AHEAD
    ) {
      throw invalid(
        `the snapshot's aboveHoles must map device tags to 1 to ${MAX_COUNTERS_AHEAD} counters`,
      );
    }
    let previous = vector[device] ?? 0;
    for (const counter of counters as unknown[]) {
      if (!isUint32(counter) || counter <= previous) {
        throw invalid(
          "the snapshot's aboveHoles must list counters above the vector's, ascending without repeats",
        );
      }
      previous = counter;
    }
    result[device] = counters as number[];
  }
  return result;
}

/**
 * An attribution overlay, checked completely (§5.4): ranges in order from offset 0, each
 * non-empty and starting where the previous one ended, each naming an author or `null` for none;
 * and every `lastEditBySender` value an offset.
 */
function decodeAttribution(raw: Record<string, unknown> | null): AttributionOverlay | null {
  if (raw === null) {
    return null;
  }
  exactKeys("the attribution overlay", raw, ["ranges", "lastEditBySender"]);
  if (!Array.isArray(raw.ranges)) {
    throw invalid("the attribution overlay's ranges must be an array");
  }
  const ranges: AttributionRange[] = [];
  let next = 0;
  for (const range of raw.ranges as unknown[]) {
    if (!isRecord(range)) {
      throw invalid("an attribution range must be an object");
    }
    exactKeys("an attribution range", range, ["start", "end", "authorId"]);
    // `null` is text whose author the responder does not know (ATR-2): no MemberId stands for it.
    if (
      !isUint32(range.start) ||
      !isUint32(range.end) ||
      !(range.authorId === null || isId(range.authorId))
    ) {
      throw invalid("an attribution range needs uint32 start and end and an author id or null");
    }
    if (range.start !== next || range.end <= range.start) {
      throw invalid(
        "attribution ranges must be non-empty and follow each other without gaps or overlaps, from 0",
      );
    }
    next = range.end;
    ranges.push({ start: range.start, end: range.end, authorId: range.authorId });
  }
  if (!isRecord(raw.lastEditBySender)) {
    throw invalid("the attribution overlay's lastEditBySender must be an object");
  }
  const lastEditBySender: Record<string, number> = {};
  for (const [member, offset] of Object.entries(raw.lastEditBySender)) {
    if (!isId(member) || !isUint32(offset)) {
      throw invalid("lastEditBySender must map member ids to uint32 offsets");
    }
    lastEditBySender[member] = offset;
  }
  return { ranges, lastEditBySender };
}

function decodeControl(f: Fields, documentId: DocumentId): ControlFrame {
  const device = f.string("device");
  if (!DEVICE_TAG.test(device)) {
    throw invalid("a control operation's device must be a device tag");
  }
  const counter = f.integer("counter", 1, UINT32_MAX);
  const target = f.string("target");
  if (!isControlTarget(target) || (memberOf(target) !== undefined && !isId(memberOf(target)))) {
    throw invalid(`unknown control target ${target}`);
  }
  if (!f.has("value")) {
    throw new FrameDecodeError("missing-field", "a control operation has no value");
  }
  const value = f.optional("value");
  if (!valueFitsTarget(target, value)) {
    throw invalid(`a control operation on ${target} cannot set ${String(value)}`);
  }
  if (!f.has("seen")) {
    throw new FrameDecodeError("missing-field", "a control operation has no seen");
  }
  const seen = decodeSeen(f.optional("seen"), device, "a control operation's seen");
  return {
    kind: "control",
    documentId,
    device,
    counter,
    target,
    value,
    seen,
    due: f.integer("due", 0, UINT32_MAX),
  };
}

function decodeDecline(f: Fields, documentId: DocumentId): DeclineFrame {
  const reason = f.string("reason");
  if (!DECLINE_REASONS.has(reason)) {
    throw invalid(`unknown decline reason ${reason}`);
  }
  let profiles: string[] | undefined;
  if (f.has("profiles")) {
    const raw = f.optional("profiles");
    if (!Array.isArray(raw) || raw.length > MAX_DECLINE_PROFILES || !raw.every(isProfileId)) {
      throw invalid(`profiles must be an array of at most ${MAX_DECLINE_PROFILES} profile ids`);
    }
    profiles = raw;
  }
  let text: string | undefined;
  if (f.has("text")) {
    const raw = f.optional("text");
    if (typeof raw !== "string" || [...raw].length > MAX_DECLINE_TEXT) {
      throw invalid(`text must be a string of at most ${MAX_DECLINE_TEXT} characters`);
    }
    text = raw;
  }
  return {
    kind: "decline",
    documentId,
    reason: reason as DeclineReason,
    ...(profiles === undefined ? {} : { profiles }),
    ...(text === undefined ? {} : { text }),
  };
}

// ---- Base64 (RFC 4648 §4, with padding) -----------------------------------------------------

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DECODE = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i += 1) {
    table[ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n =
      ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    chunk +=
      (ALPHABET[(n >>> 18) & 63] as string) +
      (ALPHABET[(n >>> 12) & 63] as string) +
      (ALPHABET[(n >>> 6) & 63] as string) +
      (ALPHABET[n & 63] as string);
    if (chunk.length >= 8192) {
      parts.push(chunk);
      chunk = "";
    }
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] as number) << 16;
    chunk += `${ALPHABET[(n >>> 18) & 63]}${ALPHABET[(n >>> 12) & 63]}==`;
  } else if (rest === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
    chunk += `${ALPHABET[(n >>> 18) & 63]}${ALPHABET[(n >>> 12) & 63]}${ALPHABET[(n >>> 6) & 63]}=`;
  }
  parts.push(chunk);
  return parts.join("");
}

/** The bytes of strict, canonical, padded Base64 text, or `undefined` for anything else. */
export function base64ToBytes(text: string): Uint8Array | undefined {
  if (text.length % 4 !== 0) {
    return undefined;
  }
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - padding);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    const last = i + 4 === text.length;
    let n = 0;
    for (let j = 0; j < 4; j += 1) {
      const code = text.charCodeAt(i + j);
      if (last && code === 61 && j >= 4 - padding) {
        n <<= 6;
        continue;
      }
      const v = code < 128 ? (DECODE[code] as number) : -1;
      if (v < 0) {
        return undefined;
      }
      n = (n << 6) | v;
    }
    out[o++] = (n >>> 16) & 0xff;
    if (o < out.length) {
      out[o++] = (n >>> 8) & 0xff;
    }
    if (o < out.length) {
      out[o++] = n & 0xff;
    }
  }
  // Canonical only: the bits padding discards must be zero, so one text has one reading.
  if (padding > 0 && bytesToBase64(out) !== text) {
    return undefined;
  }
  return out;
}
