import { createHash } from "node:crypto";
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Logger, loggerFromEnv } from "@tdsp/bridge-log";
import {
  DEFAULT_DELIVERY_RETENTION,
  type Delivery,
  type DeliveryRetention,
  type DocumentId,
  jsonTextTooDeep,
  retainNewest,
} from "@tdsp/messenger-port";
import {
  ATTACHMENT_FRAME_LIMIT,
  type AttachmentRef,
  AttachmentRejectedError,
  checkAttachment,
  frameTextOf,
  isPlainAttachmentId,
  parseAttachmentRef,
} from "./attachment.ts";
import { type BindStoreData, loadBindStore } from "./bind-store.ts";
import {
  getAttachmentBytes,
  type IncomingGroupMessage,
  parseIncomingEditOrDelete,
  parseIncomingGroupMessage,
  type SignalRpc,
} from "./signal-api.ts";

const RECEIVE_NOTIFICATION_METHOD = "receive";

/**
 * Written down twice, like `bridges/matrix-bridge/src/sync-state.ts`'s own
 * `IntegrityReason` — the browser-side mirror is
 * `packages/messenger-signal/src/integrity.ts`'s `IntegrityReason`, kept
 * identical by `integrity-vocabulary.security.test.ts`'s compile-time check.
 * `"message-replaced"`: another message under the id of one already delivered —
 * the same author and sent timestamp, other content (BRG-12).
 */
export type IntegrityReason = "message-edited" | "message-remote-deleted" | "message-replaced";

export interface IntegrityEntry {
  readonly id: string;
  readonly sender: string;
  readonly reason: IntegrityReason;
}

/**
 * What a protocol message carries: the frame inline (`frame`, its JSON text as a string), or — for a frame too large
 * for a message body — the size and SHA-256 of one sent as an attachment (`attachment`,
 * SPECIFICATION.md §13.2). Exactly one of the two; anything else is not a protocol message.
 *
 * `kind` is always `"frame"`: the envelope carries every frame kind `document-protocol`
 * produces, and this bridge must not tell them apart (SPECIFICATION.md §13.1).
 */
interface Envelope {
  readonly tdsp: number;
  readonly kind: "frame";
  readonly documentId: string;
  readonly frame?: string;
  readonly attachment?: AttachmentRef;
}

/**
 * A recognisable TDSP envelope of another version — `tdsp` a number other than 1, `documentId`
 * a string — or `undefined` (SPECIFICATION.md BND-2). Such an envelope for a bound
 * document is reported and not delivered; anything else that is not an envelope stays silent.
 */
function foreignEnvelopeVersion(
  value: unknown,
): { documentId: string; version: number } | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.tdsp === "number" &&
    candidate.tdsp !== 1 &&
    typeof candidate.documentId === "string"
    ? { documentId: candidate.documentId, version: candidate.tdsp }
    : undefined;
}

/**
 * `raw` parsed as JSON, or `undefined` for text that is not JSON — an ordinary chat message —
 * or nests deeper than any TDSP message may (SPECIFICATION.md §1.6).
 */
function parseJson(raw: string): unknown {
  if (jsonTextTooDeep(raw)) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function parseEnvelope(raw: string): Envelope | null {
  // Deeper than any envelope may nest: not one, and never handed to the parser (§1.6, BND-2).
  if (jsonTextTooDeep(raw)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // an ordinary human chat message in the same group — not our own envelope, silently ignored
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.tdsp !== 1 ||
    typeof candidate.documentId !== "string" ||
    candidate.kind !== "frame"
  ) {
    return null;
  }
  const { kind, documentId, frame, attachment } = candidate;
  if (typeof frame === "string" && attachment === undefined) {
    return { tdsp: 1, kind, documentId, frame };
  }
  if (frame === undefined && attachment !== undefined) {
    const ref = parseAttachmentRef(attachment);
    return ref === undefined ? null : { tdsp: 1, kind, documentId, attachment: ref };
  }
  return { tdsp: 1, kind, documentId }; // neither: kept as before, and dropped by `processEnvelope`
}

export interface SyncStateOptions {
  /** `signal-cli`'s local account selector (the phone number), needed to read an attachment back; `undefined` until linked. */
  readonly account?: () => string | undefined;
  /** The linked account's ACI: what another device of this account sends counts only from it (SIG-3); `undefined` until linked. */
  readonly ownAci?: () => string | undefined;
  /** `signal-cli`'s own `attachments` directory. A file is looked at before it is read (its size against the bound) and deleted after: it holds a plaintext frame. */
  readonly attachmentsDir?: string;
  readonly logger?: Logger;
  /** How much of each document's deliveries `getDeliveries` keeps (BRG-17). */
  readonly retention?: DeliveryRetention;
  /** Waits between the tries at reading one attachment back. The default is two retries, half a second and a second and a half. */
  readonly retryDelaysMs?: readonly number[];
  /** How long one `getAttachment` may take before it counts as a failed try. */
  readonly readTimeoutMs?: number;
}

/**
 * Accumulates `receive()`'s cumulative, per-`documentId` delivery buffers by
 * listening to `signal-cli`'s own unsolicited `receive` JSON-RPC
 * notifications (`signal-daemon.ts`'s `onNotification`) — mirrors
 * `bridges/matrix-bridge/src/sync-state.ts`'s role exactly, but push- rather
 * than poll-driven: signal-cli has no `/sync`-style "give me what's new
 * since X" call, so there is nothing to poll. `pollOnce()` still exists,
 * matching `server.ts`'s uniform route wiring across both adapters, but is
 * a no-op here — the buffer below is already kept current by the
 * notification handler as messages arrive, not filled in on demand.
 *
 * Also unlike Matrix: there is no decryption step here. `signal-cli`
 * itself is the Signal Protocol client — by the time a `receive`
 * notification reaches this process, the message is already plaintext
 * (Signal's own end-to-end encryption happened entirely inside
 * `signal-cli`, transparently, the same way it would for any real
 * Signal client). Nothing in this bridge ever sees Signal Protocol
 * ciphertext.
 *
 * **Routes and carries bytes, nothing more** (SPECIFICATION.md §12.5). An
 * envelope for a bound document becomes a `Delivery` — one stream, since a
 * resync request is an ordinary frame inside `Delivery.payload` like every
 * other kind. This bridge checks no creator, permission or lifecycle state:
 * membership and the document's close are control frames inside the opaque
 * payload, read and enforced by `document-protocol`.
 *
 * **Attachments**. A frame too large for a body arrives as an attachment
 * that `signal-cli` has already downloaded and decrypted into its own `attachments`
 * directory; the envelope in the body says its size and SHA-256. An inline frame is
 * still handled synchronously, exactly as before; an attachment is read back with
 * `getAttachment`, checked against the envelope, delivered, and its file deleted. Only an
 * `update` may be an attachment, exactly one attachment must accompany it, and what is read
 * is bounded. A failure of the RPC is tried again a couple of times (the file is already
 * on disk, so a real failure is rare); a wrong size or hash is final. Whatever is dropped
 * is a lost message, which loss detection treats like any other.
 */
export interface SyncState {
  pollOnce(): Promise<void>;
  getDeliveries(documentId: DocumentId): readonly Delivery[];
  /** SPECIFICATION.md BRG-12, BRG-15 — every edit/remote-delete this bridge caught and refused to apply for `documentId`, oldest first. */
  getIntegrityLog(documentId: DocumentId): readonly IntegrityEntry[];
}

export function createSyncState(
  rpc: SignalRpc,
  bindStorePath: string,
  options: SyncStateOptions = {},
): SyncState {
  const logger = options.logger ?? loggerFromEnv("signal-bridge");
  const retryDelaysMs = options.retryDelaysMs ?? [500, 1500];
  const readTimeoutMs = options.readTimeoutMs ?? 60_000;
  const retention = options.retention ?? DEFAULT_DELIVERY_RETENTION;
  const deliveries = new Map<DocumentId, Delivery[]>();
  /** `"sender:timestamp"` (the same shape as a `Delivery.id`) -> `documentId`, populated as an `update` envelope is recorded — lets a later edit/remote-delete of the same message attribute itself to the right document's own integrity log. */
  const recordedIdDocument = new Map<string, DocumentId>();
  const violations = new Map<DocumentId, IntegrityEntry[]>();
  /** Every bound document's message by delivery id: the SHA-256 of its text, and its document. */
  const firstSeen = new Map<string, { readonly digest: string; readonly documentId: DocumentId }>();

  function reject(documentId: string, id: string, sender: string, reason: IntegrityReason): void {
    const list = violations.get(documentId) ?? [];
    list.push({ id, sender, reason });
    violations.set(documentId, list);
    logger.warn("integrity-violation", { documentId, id, reason });
  }

  function processEnvelope(
    sender: string,
    timestamp: number,
    envelope: Envelope,
    payload: string,
  ): void {
    const id = `${sender}:${timestamp}`;
    const list = deliveries.get(envelope.documentId) ?? [];
    list.push({ id, documentId: envelope.documentId, sender, payload });
    retainNewest(list, retention); // bounded, oldest first (BRG-17)
    deliveries.set(envelope.documentId, list);
    recordedIdDocument.set(id, envelope.documentId);
  }

  function isBound(documentId: string): boolean {
    const bindStore: BindStoreData = loadBindStore(bindStorePath);
    return bindStore[documentId] !== undefined; // someone else's document sharing this group otherwise — silently ignored (SPECIFICATION.md §12.5, BRG-13)
  }

  /**
   * Whether `documentId` is bound to `groupId`: a message for a document counts only from the
   * group it is bound to (BRG-10). The account is usually in other groups too, with other people;
   * a frame from one of them would let someone outside the document's group write into it.
   */
  function isBoundTo(documentId: string, groupId: string): boolean {
    const bindStore: BindStoreData = loadBindStore(bindStorePath);
    return bindStore[documentId]?.groupId === groupId;
  }

  function withTimeout<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`getAttachment took longer than ${readTimeoutMs} ms`)),
        readTimeoutMs,
      );
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  function attachmentFile(id: string): string | undefined {
    return options.attachmentsDir === undefined ? undefined : join(options.attachmentsDir, id);
  }

  /** Best effort: the file holds a plaintext frame, and `signal-cli` never removes it itself. */
  function deleteAttachmentFile(id: string): void {
    const file = attachmentFile(id);
    if (file === undefined) {
      return;
    }
    try {
      rmSync(file, { force: true });
    } catch (error) {
      logger.warn("attachment-file-not-deleted", { error });
    }
  }

  async function readWithRetries(
    account: string,
    groupId: string,
    id: string,
  ): Promise<Uint8Array | undefined> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await withTimeout(getAttachmentBytes(rpc, account, groupId, id));
      } catch (error) {
        const wait = retryDelaysMs[attempt];
        if (wait === undefined) {
          logger.warn("attachment-unavailable", { attempts: attempt + 1, error });
          return undefined;
        }
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }

  async function processAttachment(
    incoming: IncomingGroupMessage,
    envelope: Envelope,
    ref: AttachmentRef,
  ): Promise<void> {
    const [attached, ...others] = incoming.attachments;
    if (attached === undefined || others.length > 0) {
      logger.warn("attachment-rejected", { reason: "not-one-attachment" });
      return;
    }
    if (!isPlainAttachmentId(attached.id) || attached.size !== ref.size) {
      logger.warn("attachment-rejected", {
        reason: attached.size !== ref.size ? "size-mismatch" : "malformed",
      });
      return;
    }
    const account = options.account?.();
    if (account === undefined) {
      return; // not linked yet: nothing could have been received, and nothing can be read
    }
    // What is on disk is what would be read into memory: look before reading.
    const file = attachmentFile(attached.id);
    if (file !== undefined) {
      try {
        if (statSync(file).size > ATTACHMENT_FRAME_LIMIT) {
          logger.warn("attachment-rejected", { reason: "too-large" });
          deleteAttachmentFile(attached.id);
          return;
        }
      } catch {
        // No file to look at where signal-cli should have put it: say so (a wrong directory would
        // otherwise leave every plaintext frame on disk unnoticed), and let getAttachment answer.
        logger.warn("attachment-file-missing", {});
      }
    }
    const bytes = await readWithRetries(account, incoming.groupId, attached.id);
    if (bytes === undefined) {
      return;
    }
    try {
      processEnvelope(
        incoming.sender,
        incoming.timestamp,
        envelope,
        frameTextOf(checkAttachment(ref, bytes)),
      );
    } catch (error) {
      if (error instanceof AttachmentRejectedError) {
        logger.warn("attachment-rejected", { reason: error.reason });
      } else {
        throw error;
      }
    } finally {
      deleteAttachmentFile(attached.id);
    }
  }

  rpc.onNotification((method, params) => {
    if (method !== RECEIVE_NOTIFICATION_METHOD) {
      return;
    }
    const ownAci = options.ownAci?.();
    const incoming = parseIncomingGroupMessage(params, ownAci);
    if (!incoming) {
      const editOrDelete = parseIncomingEditOrDelete(params, ownAci);
      if (editOrDelete) {
        const targetId = `${editOrDelete.sender}:${editOrDelete.targetTimestamp}`;
        // Prefer the ground truth of what this bridge itself recorded for
        // the targeted message over whatever documentId a tampered edit's
        // own text claims — the latter is only a fallback for a message
        // this bridge never saw in the first place.
        let documentId = recordedIdDocument.get(targetId);
        if (documentId === undefined && editOrDelete.editedMessage !== undefined) {
          documentId = parseEnvelope(editOrDelete.editedMessage)?.documentId;
        }
        const reason: IntegrityReason =
          editOrDelete.kind === "edit" ? "message-edited" : "message-remote-deleted";
        // An edit or a delete from another group is not this document's (BRG-10).
        if (documentId !== undefined && isBoundTo(documentId, editOrDelete.groupId)) {
          reject(documentId, targetId, editOrDelete.sender, reason);
        } else {
          logger.warn(`${editOrDelete.kind}-unattributed`, {
            targetId,
            sender: editOrDelete.sender,
          });
        }
      }
      return;
    }
    const foreign = foreignEnvelopeVersion(parseJson(incoming.message));
    if (foreign !== undefined) {
      // Only a log line: nothing is delivered or recorded from it (BRG-10).
      if (isBound(foreign.documentId)) {
        logger.warn("unsupported-envelope-version", foreign);
      }
      return;
    }
    const envelope = parseEnvelope(incoming.message);
    if (!envelope || !isBoundTo(envelope.documentId, incoming.groupId)) {
      return;
    }
    // Signal identifies a message by its author and sent timestamp, which is its delivery id. The
    // same message again is nothing new (BRG-11); another one under that id is never delivered and
    // is recorded against the first one's document (BRG-12).
    const id = `${incoming.sender}:${incoming.timestamp}`;
    const digest = createHash("sha256").update(incoming.message, "utf8").digest("hex");
    const first = firstSeen.get(id);
    if (first !== undefined) {
      if (first.digest !== digest && isBound(first.documentId)) {
        reject(first.documentId, id, incoming.sender, "message-replaced");
      }
      return;
    }
    firstSeen.set(id, { digest, documentId: envelope.documentId });
    if (typeof envelope.frame === "string") {
      processEnvelope(incoming.sender, incoming.timestamp, envelope, envelope.frame);
      return;
    }
    if (envelope.attachment !== undefined) {
      processAttachment(incoming, envelope, envelope.attachment).catch((error: unknown) => {
        logger.warn("attachment-failed", { error });
      });
    }
  });

  return {
    async pollOnce(): Promise<void> {
      // No-op — see this module's own doc comment. Kept for route-wiring
      // symmetry with bridges/matrix-bridge/src/server.ts.
    },
    getDeliveries(documentId: DocumentId): readonly Delivery[] {
      return deliveries.get(documentId) ?? [];
    },
    getIntegrityLog(documentId: DocumentId): readonly IntegrityEntry[] {
      return violations.get(documentId) ?? [];
    },
  };
}
