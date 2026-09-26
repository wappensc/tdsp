import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * A frame too large to ride in an event body is uploaded as a media file and the event carries a
 * reference to it (SPECIFICATION.md §13.3, BRG-14). This is the bridge's own business:
 * `document-protocol` sees only a larger `maxBytes` and hands the bridge one opaque frame. Pure functions, no network: the upload and the download are in
 * `matrix-api.ts`.
 *
 * **Two shapes of reference**, by whether the room is encrypted, as Matrix specifies for files:
 * - an ordinary room carries the plain file: `{url, size, sha256}` — everything in such a room is
 *   readable by the homeserver anyway, so encrypting the file would protect nothing. `sha256` is
 *   lowercase hex, as in every TDSP binding (SPECIFICATION.md §13); only the encrypted
 *   file's own `hashes.sha256` below is Matrix's unpadded Base64, because Matrix defines it;
 * - an encrypted room carries an *encrypted file*: the bytes are encrypted here, with AES-256-CTR
 *   under a fresh key, before they leave, and the reference — which holds the key — goes inside the
 *   Megolm-encrypted event, so the homeserver stores ciphertext and never sees the key. Matrix's
 *   `EncryptedFile` v2: a JWK `A256CTR` key, a 16-byte IV whose lower 8 bytes are the counter and
 *   start at zero, and the SHA-256 of the *ciphertext*.
 *
 * Whatever comes back is checked before it is believed: its size against what the event said and
 * against the bound, its SHA-256 against the reference, and — for an encrypted file — decrypted only
 * after the hash checks out, so a tampered file is refused rather than decrypted into garbage.
 */

/** Frames up to this size ride in the event body, as they always did. Matches the bound the bridge stated before attachments. */
export const BODY_FRAME_LIMIT = 32_000;

/**
 * The largest frame the bridge carries in one message, as an attachment. Bounded on purpose: what a
 * peer may make this bridge download must be capped, and it is what the bridge states as its
 * `maxBytes` in `GET /transport-profile`. A frame over it is cut by `document-protocol`.
 */
export const ATTACHMENT_FRAME_LIMIT = 4 * 1024 * 1024;

export interface EncryptedFileInfo {
  readonly url: string;
  readonly key: {
    readonly kty: "oct";
    readonly key_ops: readonly ["encrypt", "decrypt"];
    readonly alg: "A256CTR";
    readonly k: string;
    readonly ext: true;
  };
  readonly iv: string;
  readonly hashes: { readonly sha256: string };
  readonly v: "v2";
}

/** What an event says about a file it points at. Exactly one of `url` (plain) and `file` (encrypted) is present. */
export interface AttachmentRef {
  /** The size of the frame this stands for, in bytes. */
  readonly size: number;
  readonly url?: string;
  /** For a plain attachment: base64 (unpadded) SHA-256 of the frame. */
  readonly sha256?: string;
  readonly file?: EncryptedFileInfo;
}

/** Matrix's base64: standard alphabet, no padding. */
export function base64Unpadded(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/=+$/, "");
}

/** Matrix's URL-safe base64, as a JWK's `k` uses it: `-` and `_`, no padding. */
export function base64Url(bytes: Uint8Array): string {
  return base64Unpadded(bytes).replaceAll("+", "-").replaceAll("/", "_");
}

function fromBase64Loose(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text.replaceAll("-", "+").replaceAll("_", "/"), "base64"));
}

/** The SHA-256 as TDSP writes it in its own fields: 64 lowercase hex digits. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The SHA-256 as Matrix's `EncryptedFile` carries it: unpadded Base64. */
export function sha256Base64(bytes: Uint8Array): string {
  return base64Unpadded(createHash("sha256").update(bytes).digest());
}

/** Encrypts `bytes` for upload as an encrypted file; the reference (minus its `url`, which the upload supplies) comes with it. */
export function encryptAttachment(bytes: Uint8Array): {
  readonly ciphertext: Uint8Array;
  readonly file: Omit<EncryptedFileInfo, "url">;
} {
  const key = randomBytes(32);
  // Matrix's IV: 8 random bytes, then 8 zero bytes that count blocks.
  const iv = Buffer.concat([randomBytes(8), Buffer.alloc(8)]);
  const cipher = createCipheriv("aes-256-ctr", key, iv);
  const ciphertext = new Uint8Array(Buffer.concat([cipher.update(bytes), cipher.final()]));
  return {
    ciphertext,
    file: {
      key: {
        kty: "oct",
        key_ops: ["encrypt", "decrypt"],
        alg: "A256CTR",
        k: base64Url(key),
        ext: true,
      },
      iv: base64Unpadded(iv),
      hashes: { sha256: sha256Base64(ciphertext) },
      v: "v2",
    },
  };
}

/** Why a downloaded attachment was refused. */
export class AttachmentRejectedError extends Error {
  readonly reason: "too-large" | "size-mismatch" | "hash-mismatch" | "malformed" | "not-text";

  constructor(reason: AttachmentRejectedError["reason"], message: string) {
    super(message);
    this.name = "AttachmentRejectedError";
    this.reason = reason;
  }
}

/**
 * Turns the bytes downloaded for `ref` back into the frame, or refuses them. For an encrypted file
 * the ciphertext's SHA-256 is checked first and the decryption only then; a plain file is checked
 * against its own SHA-256. The size the event claimed is checked too, and the bound.
 */
export function openAttachment(ref: AttachmentRef, downloaded: Uint8Array): Uint8Array {
  if (downloaded.length > ATTACHMENT_FRAME_LIMIT + 16) {
    throw new AttachmentRejectedError("too-large", `the attachment is ${downloaded.length} bytes`);
  }
  if (ref.file !== undefined) {
    if (sha256Base64(downloaded) !== ref.file.hashes.sha256.replace(/=+$/, "")) {
      throw new AttachmentRejectedError("hash-mismatch", "the encrypted attachment was altered");
    }
    let frame: Uint8Array;
    try {
      const decipher = createDecipheriv(
        "aes-256-ctr",
        fromBase64Loose(ref.file.key.k),
        fromBase64Loose(ref.file.iv),
      );
      frame = new Uint8Array(Buffer.concat([decipher.update(downloaded), decipher.final()]));
    } catch {
      throw new AttachmentRejectedError("malformed", "the attachment's key or IV is not usable");
    }
    if (frame.length !== ref.size) {
      throw new AttachmentRejectedError(
        "size-mismatch",
        `the attachment decrypted to ${frame.length} bytes, the event said ${ref.size}`,
      );
    }
    return frame;
  }
  if (downloaded.length !== ref.size) {
    throw new AttachmentRejectedError(
      "size-mismatch",
      `the attachment is ${downloaded.length} bytes, the event said ${ref.size}`,
    );
  }
  if (sha256Hex(downloaded) !== ref.sha256) {
    throw new AttachmentRejectedError("hash-mismatch", "the attachment was altered");
  }
  return downloaded;
}

// A Matrix server name: a DNS name (labels of letters, digits and hyphens, never empty, so never
// "." or ".."), or an IPv6 literal in brackets, with an optional port. A looser class would let
// `mxc://../x` through, and `fetch` would then resolve `/download/../x` to another path entirely.
const SERVER_NAME =
  "(?:\\[[0-9A-Fa-f:.]{2,45}\\]|[A-Za-z0-9-]{1,63}(?:\\.[A-Za-z0-9-]{1,63})*)(?::[0-9]{1,5})?";
const MXC = new RegExp(`^mxc://(${SERVER_NAME})/([A-Za-z0-9_-]{1,255})$`);

/** Splits an `mxc://server/mediaId` URI, or `undefined` for anything else — nothing here may be turned into another URL. */
export function parseMxc(
  uri: string,
): { readonly server: string; readonly mediaId: string } | undefined {
  const match = MXC.exec(uri);
  if (match === null || (match[1] as string).length > 255) {
    return undefined;
  }
  return { server: match[1] as string, mediaId: match[2] as string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads what an event says about its attachment, strictly: read from a message anyone in the room
 * may send, so anything that is not exactly one of the two shapes — an `mxc://` URI, a size within the
 * bound, a hash of the right length, an encrypted file of exactly the version and algorithm this
 * implements — is `undefined`. It is never a way to make the bridge fetch something else.
 */
export function parseAttachmentRef(raw: unknown): AttachmentRef | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const size = raw.size;
  if (
    typeof size !== "number" ||
    !Number.isInteger(size) ||
    size < 0 ||
    size > ATTACHMENT_FRAME_LIMIT
  ) {
    return undefined;
  }
  const hash = /^[A-Za-z0-9+/]{43}={0,1}$/;
  if (isRecord(raw.file)) {
    const file = raw.file;
    const key = file.key;
    if (
      typeof file.url !== "string" ||
      parseMxc(file.url) === undefined ||
      !isRecord(key) ||
      key.kty !== "oct" ||
      key.alg !== "A256CTR" ||
      typeof key.k !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(key.k) ||
      typeof file.iv !== "string" ||
      !/^[A-Za-z0-9+/]{22}(==)?$/.test(file.iv) ||
      file.v !== "v2" ||
      !isRecord(file.hashes) ||
      typeof file.hashes.sha256 !== "string" ||
      !hash.test(file.hashes.sha256)
    ) {
      return undefined;
    }
    return {
      size,
      file: {
        url: file.url,
        key: { kty: "oct", key_ops: ["encrypt", "decrypt"], alg: "A256CTR", k: key.k, ext: true },
        iv: file.iv,
        hashes: { sha256: file.hashes.sha256 },
        v: "v2",
      },
    };
  }
  if (
    typeof raw.url === "string" &&
    parseMxc(raw.url) !== undefined &&
    typeof raw.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(raw.sha256)
  ) {
    return { size, url: raw.url, sha256: raw.sha256 };
  }
  return undefined;
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
