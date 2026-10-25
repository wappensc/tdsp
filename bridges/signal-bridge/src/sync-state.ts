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

/** What a notice records (BRG-15): a recipient a send skipped as an identity to trust (SIG-4). */
export type NoticeReason = "recipient-untrusted";

/**
 * An entry of a document's integrity log (BRG-15): a violation, naming the message's id and its
 * sender, or a notice, naming the id of a message this bridge sent and the recipient it concerns.
 */
export type IntegrityEntry =
  | {
      readonly kind: "violation";
      readonly id: string;
      readonly sender: string;
      readonly reason: IntegrityReason;
    }
  | {
      readonly kind: "notice";
      readonly id: string;
      readonly recipient: string;
      readonly reason: NoticeReason;
    };

/**
 * What a protocol message carries: the frame inline (`frame`, its JSON text as a string), or — for a frame too large
 * for a message body — the size and SHA-256 of one sent as an attachment (`attachment`,
 * bindings/signal.md §13.2). Exactly one of the two; anything else is not a protocol message.
 *
 * `kind` is always `"frame"`: the envelope carries every frame kind `document-protocol`
 * produces, and this bridge must not tell them apart (bindings/bridges.md §13.1).
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
 * a string — or `undefined` (bindings/bridges.md BND-2). Such an envelope for a bound
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
  // Deeper than any envelope may nest: not one, and never handed to the parser
  // (§1.6, JSN-1, BND-2).
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
 * **Routes and carries bytes, nothing more** (bindings/bridges.md §12.5). An
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
 * is a lost message, which loss detection treats like any other. The files an attachment
 * envelope's message brought are deleted whatever becomes of it (SIG-1).
 */
export interface SyncState {
  pollOnce(): Promise<void>;
  getDeliveries(documentId: DocumentId): readonly Delivery[];
  /** bindings/bridges.md BRG-12, BRG-15 — every edit/remote-delete this bridge caught and refused to apply for `documentId`, and every notice of a send, oldest first. */
  getIntegrityLog(documentId: DocumentId): readonly IntegrityEntry[];
  /**
   * Records, for a message this bridge sent for `documentId` (`id`), the recipients it skipped as
   * identities this account does not trust, and forgets those it reached (SIG-4): a recipient is
   * recorded once for as long as its identity stays untrusted, not once per message.
   */
  noteSendResult(
    documentId: DocumentId,
    id: string,
    untrusted: readonly string[],
    reached: readonly string[],
  ): void;
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
  /** `"sender:timestamp"` (the same shape as a `Delivery.id`) -> `documentId`, set as a message is delivered: an edit or remote-delete is recorded only against a message in here, in its document's integrity log (BRG-12). */
  const recordedIdDocument = new Map<string, DocumentId>();
  const violations = new Map<DocumentId, IntegrityEntry[]>();
  /**
   * Every message delivered, by delivery id: the SHA-256 of its text, and its document. Only a
   * delivered one: BRG-12 records another message under the id of one delivered, and a message
   * the bridge did not deliver has no content another could replace.
   */
  const firstSeen = new Map<string, { readonly digest: string; readonly documentId: DocumentId }>();
  /**
   * An attachment message by delivery id while it is read back, not delivered yet: its digest and
   * document, and how many messages with other content came under its id meanwhile. Those are
   * recorded as replacing it once it is delivered (BRG-12), and none is taken in the meantime.
   */
  const pending = new Map<
    string,
    {
      readonly digest: string;
      readonly documentId: DocumentId;
      readonly sender: string;
      others: number;
    }
  >();

  /** Ends the wait of the attachment message under `id`: delivered, or not. */
  function settlePending(id: string, delivered: boolean): void {
    const entry = pending.get(id);
    pending.delete(id);
    if (!delivered || entry === undefined) {
      return;
    }
    firstSeen.set(id, { digest: entry.digest, documentId: entry.documentId });
    if (isBound(entry.documentId)) {
      for (let other = 0; other < entry.others; other += 1) {
        reject(entry.documentId, id, entry.sender, "message-replaced");
      }
    }
  }

  /** The recipients recorded as untrusted per document, until a send reaches them again (SIG-4). */
  const perDocumentUntrusted = new Map<DocumentId, Set<string>>();

  function reject(documentId: string, id: string, sender: string, reason: IntegrityReason): void {
    const list = violations.get(documentId) ?? [];
    list.push({ kind: "violation", id, sender, reason });
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
    return bindStore[documentId] !== undefined; // someone else's document sharing this group otherwise — silently ignored (bindings/bridges.md §12.5, BRG-13)
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

  /**
   * How many messages being taken now hold each attachment file. `signal-cli` names the file by the
   * attachment's remote id (`AttachmentStore`, 0.14.9), so a message presented again names the same
   * file as the one being read back, and deleting it then would lose a frame on its way in.
   */
  const holders = new Map<string, number>();

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

  /**
   * Deletes the files `incoming` brought that no message being taken now still holds (SIG-1). Only
   * an id that names a file inside the attachments directory is touched (`isPlainAttachmentId`).
   */
  function discardAttachments(incoming: IncomingGroupMessage): void {
    for (const { id } of incoming.attachments) {
      if (isPlainAttachmentId(id) && !holders.has(id)) {
        deleteAttachmentFile(id);
      }
    }
  }

  /**
   * Takes an attachment envelope, and deletes every file its message brought once done with it,
   * whatever became of it (SIG-1): delivered, refused, or not read back. A frame refused or never
   * read is a lost message, which loss detection treats like any other; a plaintext copy of it
   * kept on disk serves nothing.
   */
  async function takeAttachment(
    incoming: IncomingGroupMessage,
    envelope: Envelope,
    ref: AttachmentRef,
  ): Promise<void> {
    const held = incoming.attachments.map(({ id }) => id).filter(isPlainAttachmentId);
    for (const id of held) {
      holders.set(id, (holders.get(id) ?? 0) + 1);
    }
    try {
      await processAttachment(incoming, envelope, ref);
    } finally {
      // Not delivered unless `processAttachment` settled it so.
      settlePending(`${incoming.sender}:${incoming.timestamp}`, false);
      for (const id of held) {
        const left = (holders.get(id) ?? 1) - 1;
        if (left > 0) {
          holders.set(id, left);
        } else {
          holders.delete(id);
        }
      }
      discardAttachments(incoming);
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
      settlePending(`${incoming.sender}:${incoming.timestamp}`, true);
    } catch (error) {
      if (error instanceof AttachmentRejectedError) {
        logger.warn("attachment-rejected", { reason: error.reason });
      } else {
        throw error;
      }
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
        // Only an edit or a delete of a message this bridge delivered is recorded, against that
        // message's document (BRG-12). One of a message it never delivered changed nothing it
        // handed up, whatever document the edit's text names; recording it would let anyone in a
        // bound group fill that document's integrity log.
        const documentId = recordedIdDocument.get(targetId);
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
    // An envelope with neither a frame nor an attachment is no protocol message: nothing is
    // delivered or recorded from it (BRG-10).
    if (
      !envelope ||
      (envelope.frame === undefined && envelope.attachment === undefined) ||
      !isBoundTo(envelope.documentId, incoming.groupId)
    ) {
      return;
    }
    // Signal identifies a message by its author and sent timestamp, which is its delivery id. The
    // same message again is nothing new (BRG-11); another one under the id of one delivered is
    // never delivered and is recorded against the first one's document (BRG-12).
    const id = `${incoming.sender}:${incoming.timestamp}`;
    const digest = createHash("sha256").update(incoming.message, "utf8").digest("hex");
    const first = firstSeen.get(id);
    const reading = pending.get(id);
    if (first !== undefined || reading !== undefined) {
      if (first !== undefined && first.digest !== digest && isBound(first.documentId)) {
        reject(first.documentId, id, incoming.sender, "message-replaced");
      }
      if (reading !== undefined && reading.digest !== digest) {
        reading.others += 1;
      }
      // Not taken, so whatever file it brought is of no use either (SIG-1).
      if (envelope.attachment !== undefined) {
        discardAttachments(incoming);
      }
      return;
    }
    if (typeof envelope.frame === "string") {
      firstSeen.set(id, { digest, documentId: envelope.documentId });
      processEnvelope(incoming.sender, incoming.timestamp, envelope, envelope.frame);
      return;
    }
    if (envelope.attachment !== undefined) {
      pending.set(id, {
        digest,
        documentId: envelope.documentId,
        sender: incoming.sender,
        others: 0,
      });
      takeAttachment(incoming, envelope, envelope.attachment).catch((error: unknown) => {
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
    noteSendResult(documentId, id, untrusted, reached) {
      const recorded = perDocumentUntrusted.get(documentId) ?? new Set<string>();
      perDocumentUntrusted.set(documentId, recorded);
      for (const recipient of reached) {
        recorded.delete(recipient);
      }
      for (const recipient of untrusted) {
        if (recorded.has(recipient)) {
          continue;
        }
        recorded.add(recipient);
        const list = violations.get(documentId) ?? [];
        list.push({ kind: "notice", id, recipient, reason: "recipient-untrusted" });
        violations.set(documentId, list);
        logger.warn("recipient-untrusted", { documentId, id, recipient });
      }
    },
  };
}
