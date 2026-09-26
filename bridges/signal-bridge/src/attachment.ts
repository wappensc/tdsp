import { createHash } from "node:crypto";

/**
 * A frame too large to ride in a message body is sent as a Signal attachment, and the message body
 * carries an envelope that says how big it is and what its SHA-256 is (SPECIFICATION.md §13.2,
 * BRG-14). This is the bridge's own business:
 * `document-protocol` sees only a larger `maxBytes` and hands the bridge one opaque frame. Pure
 * functions, no network: the RPC calls are in `signal-api.ts`.
 *
 * There is nothing to encrypt here that Signal does not already encrypt: an attachment is
 * end-to-end encrypted with its own key like the message it belongs to, and `signal-cli` does that.
 * What this module adds is the check on what comes back — the size and SHA-256 the *sender* put in the
 * envelope against the bytes actually read — because the envelope is read from a message anyone in the
 * group may send, and a bridge must not believe a reference it has not checked.
 */

/**
 * A frame up to this size rides in the message body. About 1 350 bytes of body remain for it once
 * the envelope is paid for (Signal's body limit is about 2 000 characters, measured); 800 leaves
 * margin, and anything larger goes as an attachment anyway.
 */
export const BODY_FRAME_LIMIT = 800;

/**
 * The largest frame the bridge carries in one message, as an attachment. Bounded on purpose: what a
 * peer may make this bridge read into memory must be capped, and it is what the bridge states as its
 * `maxBytes` in `GET /transport-profile`. A frame over it is cut by `document-protocol`.
 */
export const ATTACHMENT_FRAME_LIMIT = 4 * 1024 * 1024;

/** The bridge would not send a frame this large in one message. */
export class FrameTooLargeError extends Error {
  readonly bytes: number;

  constructor(bytes: number) {
    super(`a frame of ${bytes} bytes is over the ${ATTACHMENT_FRAME_LIMIT} this bridge carries`);
    this.name = "FrameTooLargeError";
    this.bytes = bytes;
  }
}

/** What an envelope says about the attachment that carries its frame. */
export interface AttachmentRef {
  readonly size: number;
  /** Lower-case hex SHA-256 of the frame. */
  readonly sha256: string;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function refFor(frame: Uint8Array): AttachmentRef {
  return { size: frame.length, sha256: sha256Hex(frame) };
}

/** `signal-cli send --attachment` accepts an RFC 2397 data URI with a file name; no file is written on the sending side. */
export function dataUriFor(bytes: Uint8Array): string {
  return `data:application/octet-stream;filename=tdsp.bin;base64,${Buffer.from(bytes).toString("base64")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads what an envelope says about its attachment, strictly: it is read from a message anyone in
 * the group may send, so anything but a whole-number size within the bound and a 64-digit hex hash is
 * `undefined`.
 */
export function parseAttachmentRef(raw: unknown): AttachmentRef | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const { size, sha256 } = raw;
  if (
    typeof size !== "number" ||
    !Number.isInteger(size) ||
    size < 0 ||
    size > ATTACHMENT_FRAME_LIMIT ||
    typeof sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(sha256)
  ) {
    return undefined;
  }
  return { size, sha256 };
}

/** Why a downloaded attachment was refused. */
export class AttachmentRejectedError extends Error {
  readonly reason:
    | "too-large"
    | "size-mismatch"
    | "hash-mismatch"
    | "not-one-attachment"
    | "not-text";

  constructor(reason: AttachmentRejectedError["reason"], message: string) {
    super(message);
    this.name = "AttachmentRejectedError";
    this.reason = reason;
  }
}

/** The bytes read for `ref`, or a refusal: the size the envelope said, the bound, and the hash. */
export function checkAttachment(ref: AttachmentRef, bytes: Uint8Array): Uint8Array {
  if (bytes.length > ATTACHMENT_FRAME_LIMIT) {
    throw new AttachmentRejectedError("too-large", `the attachment is ${bytes.length} bytes`);
  }
  if (bytes.length !== ref.size) {
    throw new AttachmentRejectedError(
      "size-mismatch",
      `the attachment is ${bytes.length} bytes, the envelope said ${ref.size}`,
    );
  }
  if (sha256Hex(bytes) !== ref.sha256) {
    throw new AttachmentRejectedError("hash-mismatch", "the attachment was altered");
  }
  return bytes;
}

/**
 * `signal-cli` names a received attachment by an id that is also its file name in its own
 * `attachments` directory. The bridge deletes that file after reading it, so an id is only ever used
 * as a path segment if it is a plain name.
 */
export function isPlainAttachmentId(id: string): boolean {
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(id) && !id.includes("..");
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * The frame an attachment carries is the UTF-8 text of a frame (SPECIFICATION.md §13.1);
 * bytes that are not valid UTF-8 are no frame at all, and are refused rather than decoded lossily.
 */
export function frameTextOf(bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes);
  } catch {
    throw new AttachmentRejectedError("not-text", "the attachment is not UTF-8 text");
  }
}
