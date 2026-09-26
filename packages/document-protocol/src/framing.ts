import type { DocumentId, ResyncRequestId } from "@tdsp/messenger-port";
import { strictJsonProblem } from "./strict-json";
import type { SyncPolicy } from "./sync-policy";

/**
 * The frame of every `MessengerPort.send()` payload (SPECIFICATION.md §4): a JSON
 * object serialised as text, with binary data — CRDT updates, state vectors, fragment slices —
 * as Base64. Read and written exclusively by `document-protocol`; a `MessengerPort` adapter and
 * a bridge never parse it ("the bridge envelope routes, the payload frame verifies and
 * interprets").
 *
 * ```
 * {"tdsp":1,"kind":"edit","documentId":"doc-a1b2c3","update":"<Base64>"}
 * ```
 *
 * Every frame has `tdsp` (the format version, 1), `kind` and `documentId`; each kind adds its
 * own fields (§4.3). Decoding is strict (§4.4): a field that is missing, of the wrong type, out
 * of range, or not defined for the kind rejects the whole frame with a named reason. There is
 * no unframed path: every payload this code produces or accepts is a frame.
 *
 * A frame carries no document profile: the profile is a property of the document, fixed at
 * creation and named in the invitation (§5.2), so the update and state-vector bytes here are
 * opaque and interpreted by the document's profile alone.
 */

export const CURRENT_FRAME_VERSION = 1;

/** The most fragments one frame may be cut into. */
export const MAX_FRAGMENTS = 0xffff;

const UINT32_MAX = 0xffffffff;
const MAX_ID_BYTES = 255;
const MAX_DECLINE_TEXT = 500;
const MAX_DECLINE_PROFILES = 16;
/** The most members a control snapshot may list (§7.4). */
export const MAX_SNAPSHOT_MEMBERS = 10_000;
const PROFILE_ID = /^[a-z0-9][a-z0-9.-]{0,99}\/[1-9][0-9]{0,5}$/;
const MESSAGE_ID = /^[0-9a-f]{16}$/;

const textEncoder = new TextEncoder();
// Fatal: text that is not valid UTF-8 is a rejected frame, never a lossy guess (FRM-6).
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface EditFrame {
  readonly kind: "edit";
  readonly documentId: DocumentId;
  readonly update: Uint8Array;
}

export interface ResyncResponseFrame {
  readonly kind: "resync-response";
  readonly documentId: DocumentId;
  /** The `requestId` of the resync request this answers. */
  readonly respondsTo: ResyncRequestId;
  readonly update: Uint8Array;
  /**
   * The creator's control snapshot, or `null` from anyone else — checked here in full, like
   * every other field (§7.4, FRM-6). Whether it names the creator is the engine's check, which
   * alone knows who the creator is.
   */
  readonly control: DecodedSnapshot | null;
  /** The responder's attribution overlay, or `null` — checked here in full (§5.4). */
  readonly attribution: AttributionOverlay | null;
}

/** A control snapshot as it arrives (§7.4): the policy already read, "no limit" as `Infinity`. */
export interface DecodedSnapshot {
  readonly profile: string;
  readonly sequence: number;
  readonly closed: boolean;
  readonly members: Readonly<Record<string, "read" | "write">>;
  /** Present together with `policySequence`, or neither is. */
  readonly policy?: SyncPolicy;
  readonly policySequence?: number;
}

/** One author's stretch of the plain-text projection, `[start, end)` (§5.4). */
export interface AttributionRange {
  readonly start: number;
  readonly end: number;
  readonly authorId: string;
}

/** An attribution overlay as it arrives (§5.4): ranges covering the projection from 0, in order, without gaps. */
export interface AttributionOverlay {
  readonly ranges: readonly AttributionRange[];
  readonly lastEditBySender: Readonly<Record<string, number>>;
}

/** The permission a control frame grants; `null` revokes. The creator's own permission is never carried. */
export type ControlPermission = "read" | "write" | null;

export interface ControlFrame {
  readonly kind: "control";
  readonly documentId: DocumentId;
  /** Issued by the creator, strictly increasing per document, from 1. */
  readonly sequence: number;
  readonly action: "membership" | "close" | "policy";
  /** Present exactly when `action` is `"membership"`. */
  readonly member?: string;
  /** Present exactly when `action` is `"membership"`. */
  readonly permission?: ControlPermission;
  /** Present exactly when `action` is `"policy"`: the send policy the creator now sets. */
  readonly policy?: SyncPolicy;
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
  /** The sender's highest issued control sequence if it is the creator, else `0`. */
  readonly controlSequence: number;
  readonly stateVector: Uint8Array;
}

/**
 * One slice of another frame's UTF-8 text (§9.4). The receiver puts the slices back together
 * into the original frame and handles it exactly as if it had arrived whole from the same
 * sender.
 */
export interface FragmentFrame {
  readonly kind: "fragment";
  readonly documentId: DocumentId;
  /** 16 lowercase hex digits, random, the same for every slice of one frame. */
  readonly messageId: string;
  readonly index: number;
  readonly total: number;
  readonly chunk: Uint8Array;
}

/** "I need to be caught up" (§8.2): how far the requester is along, in control state and content. */
export interface ResyncRequestFrame {
  readonly kind: "resync-request";
  readonly documentId: DocumentId;
  /**
   * 16 lowercase hex digits, random, chosen by the requester (§8.2): what an answer names in
   * `respondsTo`. Not the messenger's delivery id, which a requester does not always know the
   * way receivers see it, and which a request cut into fragments does not have.
   */
  readonly requestId: string;
  /** Whether the requester has no answer from the creator yet (RSY-7): the creator answers it regardless. */
  readonly bootstrap: boolean;
  /** The requester's contiguous control sequence (CTL-9). */
  readonly controlSequence: number;
  readonly stateVector: Uint8Array;
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

export type Frame =
  | EditFrame
  | ResyncResponseFrame
  | ControlFrame
  | HeartbeatFrame
  | FragmentFrame
  | ResyncRequestFrame
  | DeclineFrame;

/**
 * Thrown for a frame that is rejected (§4.4). `reason` is a short, stable, machine-readable
 * discriminator; `message` is the human-readable detail. `document-mismatch` is raised by the
 * engine after decoding, `profile-mismatch` for a creator's snapshot naming another profile.
 */
export class FrameDecodeError extends Error {
  readonly reason:
    | "not-json"
    | "unsupported-version"
    | "unknown-kind"
    | "missing-field"
    | "invalid-field"
    | "document-mismatch"
    | "profile-mismatch";

  constructor(reason: FrameDecodeError["reason"], message: string) {
    super(message);
    this.name = "FrameDecodeError";
    this.reason = reason;
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

/** A random id for a request or a fragmented frame: 64 bits, as 16 lowercase hex digits (§4.3). */
export function newRandomId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function checkUint32(name: string, value: number, min = 0): void {
  if (!Number.isInteger(value) || value < min || value > UINT32_MAX) {
    throw new Error(`${name} out of range: ${value} (need ${min}..${UINT32_MAX})`);
  }
}

function frameText(documentId: DocumentId, kind: Frame["kind"], fields: object): string {
  checkId("documentId", documentId);
  return JSON.stringify({ tdsp: CURRENT_FRAME_VERSION, kind, documentId, ...fields });
}

/** A sync policy as the JSON a control frame carries: every value, `null` for "no limit". */
function policyToJson(policy: SyncPolicy): object {
  const finite = (name: string, value: number, mayBeUnlimited: boolean): number | null => {
    if (value === Number.POSITIVE_INFINITY && mayBeUnlimited) {
      return null;
    }
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(
        `${name} must be a non-negative number${mayBeUnlimited ? " or unlimited" : ""}, got ${value}`,
      );
    }
    return value;
  };
  return {
    minIntervalMs: finite("minIntervalMs", policy.minIntervalMs, false),
    maxIntervalMs: finite("maxIntervalMs", policy.maxIntervalMs, true),
    minChars: finite("minChars", policy.minChars, false),
    maxChars: finite("maxChars", policy.maxChars, true),
    expectedLatencyMs: finite("expectedLatencyMs", policy.expectedLatencyMs, false),
  };
}

export function encodeEditFrame(documentId: DocumentId, update: Uint8Array): string {
  if (update.length === 0) {
    throw new Error("an edit frame needs an update");
  }
  return frameText(documentId, "edit", { update: bytesToBase64(update) });
}

export function encodeResyncRequestFrame(options: {
  documentId: DocumentId;
  requestId: string;
  bootstrap: boolean;
  controlSequence: number;
  stateVector: Uint8Array;
}): string {
  checkRandomId("requestId", options.requestId);
  checkUint32("controlSequence", options.controlSequence);
  return frameText(options.documentId, "resync-request", {
    requestId: options.requestId,
    bootstrap: options.bootstrap,
    controlSequence: options.controlSequence,
    stateVector: bytesToBase64(options.stateVector),
  });
}

export function encodeResyncResponseFrame(options: {
  documentId: DocumentId;
  respondsTo: ResyncRequestId;
  update: Uint8Array;
  control?: object | null;
  attribution?: object | null;
}): string {
  checkRandomId("respondsTo", options.respondsTo);
  return frameText(options.documentId, "resync-response", {
    respondsTo: options.respondsTo,
    update: bytesToBase64(options.update),
    control: options.control ?? null,
    attribution: options.attribution ?? null,
  });
}

export function encodeControlFrame(options: {
  documentId: DocumentId;
  sequence: number;
  action: "membership" | "close" | "policy";
  member?: string;
  permission?: ControlPermission;
  policy?: SyncPolicy;
}): string {
  checkUint32("control sequence", options.sequence, 1);
  if (options.action === "close") {
    return frameText(options.documentId, "control", {
      sequence: options.sequence,
      action: "close",
    });
  }
  if (options.action === "policy") {
    if (options.policy === undefined) {
      throw new Error("a policy control frame needs a policy");
    }
    return frameText(options.documentId, "control", {
      sequence: options.sequence,
      action: "policy",
      policy: policyToJson(options.policy),
    });
  }
  if (options.member === undefined || options.permission === undefined) {
    throw new Error("a membership control frame needs both a member and a permission");
  }
  checkId("member id", options.member);
  return frameText(options.documentId, "control", {
    sequence: options.sequence,
    action: "membership",
    member: options.member,
    permission: options.permission,
  });
}

export function encodeHeartbeatFrame(options: {
  documentId: DocumentId;
  controlSequence: number;
  stateVector: Uint8Array;
}): string {
  checkUint32("control sequence", options.controlSequence);
  return frameText(options.documentId, "heartbeat", {
    controlSequence: options.controlSequence,
    stateVector: bytesToBase64(options.stateVector),
  });
}

export function encodeFragmentFrame(options: {
  documentId: DocumentId;
  messageId: string;
  index: number;
  total: number;
  chunk: Uint8Array;
}): string {
  if (!MESSAGE_ID.test(options.messageId)) {
    throw new Error("fragment messageId must be 16 lowercase hex digits");
  }
  if (!Number.isInteger(options.total) || options.total < 1 || options.total > MAX_FRAGMENTS) {
    throw new Error(`fragment total out of range: ${options.total} (need 1..${MAX_FRAGMENTS})`);
  }
  if (!Number.isInteger(options.index) || options.index < 0 || options.index >= options.total) {
    throw new Error(`fragment index out of range: ${options.index} of ${options.total}`);
  }
  if (options.chunk.length === 0) {
    throw new Error("a fragment needs a slice");
  }
  return frameText(options.documentId, "fragment", {
    messageId: options.messageId,
    index: options.index,
    total: options.total,
    slice: bytesToBase64(options.chunk),
  });
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
  edit: ["update"],
  "resync-request": ["requestId", "bootstrap", "controlSequence", "stateVector"],
  "resync-response": ["respondsTo", "update", "control", "attribution"],
  control: ["sequence", "action", "member", "permission", "policy"],
  heartbeat: ["controlSequence", "stateVector"],
  fragment: ["messageId", "index", "total", "slice"],
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

  /** A random id: 16 lowercase hex digits (a fragment's `messageId`, a request's `requestId`). */
  randomId(name: string): string {
    const value = this.string(name);
    if (!MESSAGE_ID.test(value)) {
      throw invalid(`${name} must be 16 lowercase hex digits`);
    }
    return value;
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

function decodePolicy(raw: unknown): SyncPolicy {
  if (!isRecord(raw)) {
    throw invalid("policy must be an object");
  }
  const keys = ["minIntervalMs", "maxIntervalMs", "minChars", "maxChars", "expectedLatencyMs"];
  for (const key of Object.keys(raw)) {
    if (!keys.includes(key)) {
      throw invalid(`policy has an undefined field ${key}`);
    }
  }
  const value = (key: string, mayBeUnlimited: boolean): number => {
    if (!Object.hasOwn(raw, key)) {
      throw new FrameDecodeError("missing-field", `the policy has no ${key}`);
    }
    const v = raw[key];
    if (v === null && mayBeUnlimited) {
      return Number.POSITIVE_INFINITY;
    }
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw invalid(
        `policy ${key} must be a non-negative number${mayBeUnlimited ? " or null" : ""}`,
      );
    }
    return v;
  };
  return {
    minIntervalMs: value("minIntervalMs", false),
    maxIntervalMs: value("maxIntervalMs", true),
    minChars: value("minChars", false),
    maxChars: value("maxChars", true),
    expectedLatencyMs: value("expectedLatencyMs", false),
  };
}

/**
 * Parses one frame (§4.4). Throws `FrameDecodeError` with a distinct reason for each way a frame
 * can be wrong; never a partial parse. The frame's documentId is returned as read — whether it
 * is the document the delivery was routed to is the engine's check (`document-mismatch`).
 */
export function decodeFrame(text: string): Frame {
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
        : `unsupported frame version ${String(parsed.tdsp)}, expected ${CURRENT_FRAME_VERSION}`,
    );
  }
  const kind = parsed.kind;
  if (typeof kind !== "string" || !Object.hasOwn(FIELDS, kind)) {
    throw new FrameDecodeError("unknown-kind", `unknown frame kind ${String(kind)}`);
  }
  const allowed = new Set(["tdsp", "kind", "documentId", ...FIELDS[kind as Frame["kind"]]]);
  for (const key of Object.keys(parsed)) {
    if (!allowed.has(key)) {
      throw invalid(`a ${kind} frame has no field ${key}`);
    }
  }
  const f = new Fields(parsed);
  const documentId = f.id("documentId");

  switch (kind as Frame["kind"]) {
    case "edit":
      return { kind: "edit", documentId, update: f.base64("update", { nonEmpty: true }) };
    case "resync-request":
      return {
        kind: "resync-request",
        documentId,
        requestId: f.randomId("requestId"),
        bootstrap: f.boolean("bootstrap"),
        controlSequence: f.integer("controlSequence", 0, UINT32_MAX),
        stateVector: f.base64("stateVector"),
      };
    case "resync-response":
      return {
        kind: "resync-response",
        documentId,
        respondsTo: f.randomId("respondsTo"),
        update: f.base64("update"),
        control: decodeSnapshot(f.objectOrNull("control")),
        attribution: decodeAttribution(f.objectOrNull("attribution")),
      };
    case "heartbeat":
      return {
        kind: "heartbeat",
        documentId,
        controlSequence: f.integer("controlSequence", 0, UINT32_MAX),
        stateVector: f.base64("stateVector"),
      };
    case "fragment": {
      const messageId = f.randomId("messageId");
      const total = f.integer("total", 1, MAX_FRAGMENTS);
      const index = f.integer("index", 0, MAX_FRAGMENTS);
      if (index >= total) {
        throw invalid(`fragment ${index} of ${total} is not a fragment`);
      }
      return {
        kind: "fragment",
        documentId,
        messageId,
        index,
        total,
        chunk: f.base64("slice", { nonEmpty: true }),
      };
    }
    case "control":
      return decodeControl(f, documentId);
    case "decline":
      return decodeDecline(f, documentId);
  }
}

/** Throws `invalid-field` unless `raw` has exactly the keys `required` plus any of `optional`. */
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
    if (!required.includes(key) && !optional.includes(key)) {
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
 * The creator's control snapshot, checked completely before anything of the frame is applied
 * (§7.4, FRM-6): an invalid snapshot — a bad policy included — rejects the whole response.
 */
function decodeSnapshot(raw: Record<string, unknown> | null): DecodedSnapshot | null {
  if (raw === null) {
    return null;
  }
  exactKeys(
    "the snapshot",
    raw,
    ["profile", "sequence", "closed", "members"],
    ["policy", "policySequence"],
  );
  if (!isProfileId(raw.profile)) {
    throw invalid("the snapshot's profile is not a profile id");
  }
  if (!isUint32(raw.sequence)) {
    throw invalid("the snapshot's sequence must be a uint32");
  }
  if (typeof raw.closed !== "boolean") {
    throw invalid("the snapshot's closed must be true or false");
  }
  if (!isRecord(raw.members)) {
    throw invalid("the snapshot's members must be an object");
  }
  const entries = Object.entries(raw.members);
  if (entries.length > MAX_SNAPSHOT_MEMBERS) {
    throw invalid(`the snapshot lists more than ${MAX_SNAPSHOT_MEMBERS} members`);
  }
  const members: Record<string, "read" | "write"> = {};
  for (const [member, permission] of entries) {
    if (!isId(member)) {
      throw invalid("a member in the snapshot must be 1..255 UTF-8 bytes");
    }
    if (permission !== "read" && permission !== "write") {
      throw invalid(`the snapshot gives ${member} the unknown permission ${String(permission)}`);
    }
    members[member] = permission;
  }
  const hasPolicy = Object.hasOwn(raw, "policy");
  if (hasPolicy !== Object.hasOwn(raw, "policySequence")) {
    throw invalid("the snapshot must carry policy and policySequence together, or neither");
  }
  if (!hasPolicy) {
    return { profile: raw.profile, sequence: raw.sequence, closed: raw.closed, members };
  }
  if (!isUint32(raw.policySequence) || raw.policySequence > raw.sequence) {
    throw invalid("the snapshot's policySequence must be a uint32 no greater than its sequence");
  }
  return {
    profile: raw.profile,
    sequence: raw.sequence,
    closed: raw.closed,
    members,
    policy: decodePolicy(raw.policy),
    policySequence: raw.policySequence,
  };
}

/**
 * An attribution overlay, checked completely (§5.4): ranges in order from offset 0, each
 * non-empty and starting where the previous one ended, each naming an author; and every
 * `lastEditBySender` value an offset.
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
    if (!isUint32(range.start) || !isUint32(range.end) || !isId(range.authorId)) {
      throw invalid("an attribution range needs uint32 start and end and an author id");
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
  const sequence = f.integer("sequence", 1, UINT32_MAX);
  const action = f.string("action");
  const onlyFor = (fields: readonly string[]): void => {
    for (const name of ["member", "permission", "policy"]) {
      if (f.has(name) && !fields.includes(name)) {
        throw invalid(`a ${action} control frame has no field ${name}`);
      }
    }
  };
  if (action === "close") {
    onlyFor([]);
    return { kind: "control", documentId, sequence, action: "close" };
  }
  if (action === "policy") {
    onlyFor(["policy"]);
    if (!f.has("policy")) {
      throw new FrameDecodeError("missing-field", "a policy control frame has no policy");
    }
    return {
      kind: "control",
      documentId,
      sequence,
      action: "policy",
      policy: decodePolicy(f.optional("policy")),
    };
  }
  if (action !== "membership") {
    throw invalid(`unknown control action ${action}`);
  }
  onlyFor(["member", "permission"]);
  const member = f.id("member");
  if (!f.has("permission")) {
    throw new FrameDecodeError("missing-field", "a membership control frame has no permission");
  }
  const permission = f.optional("permission");
  if (permission !== null && permission !== "read" && permission !== "write") {
    throw invalid(`unknown permission ${String(permission)}`);
  }
  return { kind: "control", documentId, sequence, action: "membership", member, permission };
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

/** The UTF-8 text of `bytes` — the inner frame a set of fragments carried — or `invalid-field`. */
export function utf8ToText(bytes: Uint8Array): string {
  try {
    return textDecoder.decode(bytes);
  } catch {
    throw invalid("a reassembled frame is not valid UTF-8");
  }
}

export function textToUtf8(text: string): Uint8Array {
  return textEncoder.encode(text);
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
