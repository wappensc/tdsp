import { type Logger, loggerFromEnv } from "@tdsp/bridge-log";
import {
  DEFAULT_DELIVERY_RETENTION,
  type Delivery,
  type DeliveryRetention,
  type DocumentId,
  jsonValueTooDeep,
  retainNewest,
} from "@tdsp/messenger-port";
import {
  ATTACHMENT_FRAME_LIMIT,
  type AttachmentRef,
  AttachmentRejectedError,
  frameTextOf,
  openAttachment,
  parseAttachmentRef,
  sha256Hex,
} from "./attachment.ts";
import { type BindStoreData, loadBindStore, saveBindStore } from "./bind-store.ts";
import type { CryptoMachine } from "./crypto-machine.ts";
import {
  downloadMedia,
  type MatrixApiConfig,
  MatrixApiError,
  type RawTimelineEvent,
  syncOnce,
} from "./matrix-api.ts";

// The one event type this bridge sends and recognizes: every frame kind,
// resync requests and responses included, rides it (bindings/matrix.md §13.3).
export const FRAME_EVENT_TYPE = "de.wappensc.together.tdsp.frame";
const ENCRYPTED_EVENT_TYPE = "m.room.encrypted";
const ENCRYPTION_STATE_EVENT_TYPE = "m.room.encryption";
const REDACTION_EVENT_TYPE = "m.room.redaction";

/**
 * Written down twice, like `bridges/email-bridge/src/sync-state.ts`'s own
 * `RejectionReason` — the browser-side mirror is
 * `packages/messenger-matrix/src/integrity.ts`'s `IntegrityReason`, kept
 * identical by `integrity-vocabulary.security.test.ts`'s compile-time check (the
 * bridge may not import that package in production source, only in tests:
 * a bridge and an adapter stay independent).
 */
export type IntegrityReason = "message-edited" | "message-redacted" | "message-replaced";

export interface IntegrityEntry {
  readonly eventId: string;
  readonly sender: string;
  readonly reason: IntegrityReason;
}

/** A `documentId` read straight from an event's content, independent of whether the rest of the envelope parses — the same field `readFrameEnvelope` reads, but tolerant of the extra fields an edit/redaction carries. `undefined` when genuinely not present (a redacted event's content is `{}`; some redactions target an event this bridge never recorded at all), in which case the violation is still logged (`logger.warn`) but cannot be attributed to a specific document's own integrity log. */
function readDocumentIdHint(content: unknown): string | undefined {
  if (typeof content !== "object" || content === null) {
    return undefined;
  }
  const candidate = content as Record<string, unknown>;
  if (typeof candidate.documentId === "string") {
    return candidate.documentId;
  }
  const newContent = candidate["m.new_content"];
  if (typeof newContent === "object" && newContent !== null) {
    const inner = (newContent as Record<string, unknown>).documentId;
    if (typeof inner === "string") {
      return inner;
    }
  }
  return undefined;
}

/** The `redacts` field of an `m.room.redaction` event's content — Matrix carries it both as a top-level event field and inside `content.redacts`; only the latter survives this bridge's opaque `content: unknown` handling. */
function extractRedactsTarget(content: unknown): string | undefined {
  if (typeof content !== "object" || content === null) {
    return undefined;
  }
  const redacts = (content as Record<string, unknown>).redacts;
  return typeof redacts === "string" ? redacts : undefined;
}

/** `true` when `content` carries `m.relates_to: {rel_type: "m.replace", ...}` — legitimate tdsp traffic never uses this relation (a real edit is a new CRDT update sent as its own ordinary frame), so its mere presence on a `.tdsp.frame` event is the signal. */
function isReplaceRelation(content: unknown): boolean {
  if (typeof content !== "object" || content === null) {
    return false;
  }
  const relatesTo = (content as Record<string, unknown>)["m.relates_to"];
  if (typeof relatesTo !== "object" || relatesTo === null) {
    return false;
  }
  return (relatesTo as Record<string, unknown>).rel_type === "m.replace";
}

/**
 * What a protocol event carries: the frame inline (`frame`, its JSON text as a string), or — for a frame too large
 * for an event body — a reference to a media file holding it (`attachment`, bindings/matrix.md §13.3).
 * Exactly one of the two (bindings/bridges.md BND-4); anything else is not a protocol event.
 */
type FrameEnvelope =
  | { readonly documentId: string; readonly frame: string; readonly attachment?: undefined }
  | { readonly documentId: string; readonly frame?: undefined; readonly attachment: AttachmentRef };

/**
 * What a delivered event is compared by when another event arrives under its id (BRG-12): the
 * frame's bytes, for an attachment the hash its envelope names, so nothing is fetched to compare.
 * A plain attachment names the SHA-256 of the frame itself, the same digest an inline frame gets
 * here. An encrypted file names the SHA-256 of its ciphertext, which decrypts to another frame
 * under another key or IV, so those are compared with it.
 */
function contentDigest(envelope: FrameEnvelope): string {
  const { attachment } = envelope;
  if (attachment === undefined) {
    return sha256Hex(new TextEncoder().encode(envelope.frame));
  }
  if (attachment.file !== undefined) {
    const { hashes, key, iv } = attachment.file;
    return `file:${hashes.sha256.replace(/=+$/, "")}:${key.k}:${iv.replace(/=+$/, "")}`;
  }
  return attachment.sha256 ?? "";
}

/**
 * A recognisable TDSP envelope of another version — `tdsp` a number other than 1, `documentId`
 * a string — or `undefined` (bindings/bridges.md BND-2). Such an envelope for a bound
 * document is reported and not delivered; anything else that is not an envelope stays silent.
 */
function foreignEnvelopeVersion(
  value: unknown,
): { documentId: string; version: number } | undefined {
  if (typeof value !== "object" || value === null || jsonValueTooDeep(value)) {
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
 * The envelope an event's content is (§13.3), or `undefined` when it is none — including content
 * nested deeper than any envelope may (SPECIFICATION.md §1.6, BND-2).
 */
export function readFrameEnvelope(content: unknown): FrameEnvelope | undefined {
  if (typeof content !== "object" || content === null || jsonValueTooDeep(content)) {
    return undefined;
  }
  const candidate = content as Record<string, unknown>;
  if (candidate.tdsp !== 1 || typeof candidate.documentId !== "string") {
    return undefined;
  }
  if (typeof candidate.frame === "string" && candidate.attachment === undefined) {
    return { documentId: candidate.documentId, frame: candidate.frame };
  }
  if (candidate.frame === undefined && candidate.attachment !== undefined) {
    const attachment = parseAttachmentRef(candidate.attachment);
    return attachment === undefined ? undefined : { documentId: candidate.documentId, attachment };
  }
  return undefined;
}

/** An attachment whose download failed in a way that may pass: kept, and tried again on a later poll. */
interface PendingAttachment {
  readonly event: LogicalEvent;
  readonly roomId: string;
  readonly documentId: string;
  readonly attachment: AttachmentRef;
  readonly digest: string;
  attempts: number;
  nextAt: number;
}

const MAX_ATTACHMENT_ATTEMPTS = 8;
const ATTACHMENT_RETRY_BASE_MS = 1000;
const ATTACHMENT_RETRY_CAP_MS = 60_000;
/** More than this many downloads waiting to be retried and the oldest is dropped: what a peer can make this bridge hold is bounded. */
const MAX_PENDING_ATTACHMENTS = 64;

interface LogicalEvent {
  readonly type: string;
  readonly eventId: string;
  readonly sender: string;
  readonly content: unknown;
  readonly redactedBefore: boolean;
}

/**
 * Accumulates `receive()`'s cumulative, per-`documentId` delivery buffer by
 * polling Matrix's own `/sync` — matches `InMemoryMessengerPort.receive()`'s
 * existing contract (the full history ever seen, not just "new since last
 * call"; `document-protocol`'s own `#seenDeliveryIds` already dedups,
 * exactly as it does for the mock and for Signal's own equivalent buffer).
 *
 * **Routes and carries bytes, nothing more** (bindings/bridges.md §12.5): an
 * event for a bound document becomes a `Delivery` — one stream, since a
 * resync request is an ordinary frame inside `Delivery.payload` — and this
 * module never writes the bind-store. It checks no creator, permission or
 * lifecycle state: membership and the document's close are control frames
 * inside the opaque payload, read and enforced by `document-protocol`.
 *
 * **Encryption**: an `m.room.encrypted` timeline event is decrypted via
 * `crypto` first — the resulting *logical* event (its real
 * `de.wappensc.together.tdsp.*` type and envelope content) is then processed
 * exactly like a plaintext one, so every rule below (routing by
 * envelope `documentId`) applies identically regardless of whether the
 * room happens to be encrypted. A decryption failure —
 * expected, not exceptional, for a message sent before this device had
 * the room key (the Megolm history caveat) — is silently
 * dropped, the same "unrecognized envelope" treatment BND-2 gives
 * non-protocol traffic; there is no "failed delivery" concept in `MessengerPort` to
 * surface it as. `crypto.receiveSync()` itself is called on *every*
 * poll, including the very first (unlike room timeline events, to-device
 * messages are not "history" in the same sense — a pending room-key
 * share from before this bridge's first sync is exactly the kind of
 * thing it still needs to process, not discard).
 *
 * **The first `/sync` result's *room timeline* is deliberately
 * discarded, not buffered**: omitting `since` returns Matrix's
 * initial-sync snapshot, which for a real, previously-used room can
 * include substantial history predating this bridge process — messages
 * the resync mechanism is the intended way to catch up on (RSY-1), not
 * something `receive()` should surface as if newly
 * delivered. A fresh bridge process therefore only ever sees timeline
 * events sent *after* its own first sync round — the same "no history,
 * only what arrives from here on" property Signal has unconditionally
 * (Matrix's richer history does not change what the protocol relies on).
 * Real deployments keep the bridge running continuously, so this is an
 * intentional startup property, not a functional gap; a caller that
 * needs an initial call is `receive()`'s own first invocation. A resync
 * request sent before a responder's own first `/sync` round is exactly as
 * invisible to it as an edit sent at the same moment; the joiner's
 * bootstrap retry (RSY-5) recovers it, as it covers every other missed
 * delivery.
 */
export interface SyncState {
  pollOnce(): Promise<void>;
  getDeliveries(documentId: DocumentId): readonly Delivery[];
  /** bindings/bridges.md BRG-12, BRG-15 — every edit, redaction and replacement this bridge caught and refused to apply for `documentId`, oldest first. */
  getIntegrityLog(documentId: DocumentId): readonly IntegrityEntry[];
  /** Whether this bridge has seen `roomId` encrypted while it runs (MTX-5), before a binding to it too. */
  hasSeenEncrypted(roomId: string): boolean;
}

export function createSyncState(
  config: MatrixApiConfig,
  bindStorePath: string,
  crypto: CryptoMachine,
  logger: Logger = loggerFromEnv("matrix-bridge"),
  /** How much of each document's deliveries `getDeliveries` keeps (BRG-17). */
  retention: DeliveryRetention = DEFAULT_DELIVERY_RETENTION,
): SyncState {
  const pendingAttachments: PendingAttachment[] = [];
  let nextBatch: string | undefined;
  let hasPolledOnce = false;
  let inFlight: Promise<void> | undefined;
  const deliveries = new Map<DocumentId, Delivery[]>();
  /**
   * Every event this bridge delivered while it runs, by event id: the document it went to, which a
   * later redaction is attributed to, and what another event under the same id is compared by
   * (BRG-11, BRG-12). Only `recordEvent` adds to it, so an event the bridge does not take (BRG-10,
   * MTX-5) never stands here. It is kept as long as the bridge runs, never shorter than the
   * deliveries `retention` keeps: a replaced event under an id dropped from here would be taken
   * as new. Nothing of it outlives a restart, so a bridge started afresh compares afresh (BRG-17).
   */
  const delivered = new Map<string, { readonly documentId: DocumentId; readonly digest: string }>();
  const violations = new Map<DocumentId, IntegrityEntry[]>();
  /**
   * The rooms this bridge has seen encrypted while it runs: an `m.room.encryption` state event or
   * an `m.room.encrypted` event in their timeline, the first `/sync` included. Matrix never turns
   * a room's encryption off, so a room stays here. With the rooms bound as encrypted, these are
   * the rooms where an unencrypted frame is never delivered (see `isEncryptedRoom`).
   */
  const seenEncrypted = new Set<string>();

  /**
   * In an encrypted room the carrier of a frame is an `m.room.encrypted` event (SPECIFICATION.md
   * §13.3), and Megolm's sender is what makes the creator check mean anything there (BND-1,
   * §15.1). A homeserver can place an unencrypted event in any room under any member's name, so
   * one that carries a frame in such a room is ignored, never delivered.
   */
  function isEncryptedRoom(roomId: string, bindStore: BindStoreData): boolean {
    if (seenEncrypted.has(roomId)) {
      return true;
    }
    return Object.values(bindStore).some((record) => record.roomId === roomId && record.encrypted);
  }

  /**
   * Notes `roomId` as encrypted when `event` shows it is, and persists that with every binding to
   * the room (MTX-5): a bridge that forgot it after a restart would take the room's state as the
   * homeserver reports it again, and would send into the room unencrypted.
   */
  function noteEncryption(roomId: string, event: RawTimelineEvent): void {
    if (event.type !== ENCRYPTION_STATE_EVENT_TYPE && event.type !== ENCRYPTED_EVENT_TYPE) {
      return;
    }
    seenEncrypted.add(roomId);
    const store = loadBindStore(bindStorePath);
    const plain = Object.entries(store).filter(
      ([, record]) => record.roomId === roomId && !record.encrypted,
    );
    if (plain.length === 0) {
      return;
    }
    for (const [documentId, record] of plain) {
      store[documentId] = { ...record, encrypted: true };
    }
    saveBindStore(bindStorePath, store);
    logger.info("room-seen-encrypted", { roomId, documents: plain.length });
  }

  function reject(
    documentId: string,
    eventId: string,
    sender: string,
    reason: IntegrityReason,
  ): void {
    const list = violations.get(documentId) ?? [];
    list.push({ eventId, sender, reason });
    violations.set(documentId, list);
    logger.warn("integrity-violation", { documentId, eventId, reason });
  }

  async function resolveLogicalEvent(
    event: RawTimelineEvent,
    roomId: string,
  ): Promise<LogicalEvent | null> {
    const redactedBefore = event.unsigned?.redacted_because !== undefined;
    if (event.type !== ENCRYPTED_EVENT_TYPE) {
      return {
        type: event.type,
        eventId: event.event_id,
        sender: event.sender,
        content: event.content,
        redactedBefore,
      };
    }
    if (redactedBefore) {
      // A redacted encrypted event's ciphertext is stripped too, so decryption
      // would only fail the way a missing room key already does — nothing to
      // route it to a document with, but still worth a structured log line.
      logger.warn("encrypted-event-redacted-before-delivery", { eventId: event.event_id });
      return null;
    }
    const decrypted = await crypto.decryptRoomEvent(event, roomId);
    if (!decrypted.ok) {
      return null;
    }
    return {
      type: decrypted.type,
      eventId: event.event_id,
      sender: decrypted.sender,
      content: decrypted.content,
      redactedBefore: false,
    };
  }

  /**
   * The frame an attachment stands for, downloaded and checked; `"retry"` for a failure that may
   * pass (the homeserver unreachable, rate-limited, erroring), `null` for one that will not (the file
   * is gone, forbidden, over the bound, altered, or not what the event said).
   */
  async function fetchAttachment(attachment: AttachmentRef): Promise<string | "retry" | null> {
    const uri = attachment.file?.url ?? attachment.url;
    if (uri === undefined) {
      return null;
    }
    let downloaded: Uint8Array;
    try {
      downloaded = await downloadMedia(config, uri, ATTACHMENT_FRAME_LIMIT + 16);
    } catch (error) {
      if (
        error instanceof MatrixApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408 &&
        error.status !== 429
      ) {
        logger.warn("attachment-unavailable", { status: error.status });
        return null;
      }
      return "retry";
    }
    try {
      return frameTextOf(openAttachment(attachment, downloaded));
    } catch (error) {
      if (error instanceof AttachmentRejectedError) {
        logger.warn("attachment-rejected", { reason: error.reason });
        return null;
      }
      throw error;
    }
  }

  function recordEvent(
    event: LogicalEvent,
    documentId: string,
    payload: string,
    digest: string,
  ): void {
    const list = deliveries.get(documentId) ?? [];
    list.push({ id: event.eventId, documentId, sender: event.sender, payload });
    retainNewest(list, retention); // bounded, oldest first (BRG-17)
    deliveries.set(documentId, list);
    delivered.set(event.eventId, { documentId, digest });
  }

  /**
   * Whether an event under `event`'s id was delivered already; called before an attachment is
   * fetched. The same content again is the homeserver presenting it again, dropped without a
   * record (BRG-11). Other content is a replacement of a delivered message: never handed up,
   * never a new message, and recorded where it can be attributed (BRG-12). An event id names one
   * event in one room, so a replacement in a room the delivered event's document is not bound to
   * is not attributed to it (BRG-10).
   */
  function alreadyDelivered(
    event: LogicalEvent,
    digest: string,
    roomId: string,
    bindStore: BindStoreData,
  ): boolean {
    const earlier = delivered.get(event.eventId);
    if (earlier === undefined) {
      return false;
    }
    if (earlier.digest !== digest) {
      if (boundHere(earlier.documentId, roomId, bindStore)) {
        reject(earlier.documentId, event.eventId, event.sender, "message-replaced");
      } else {
        logger.warn("replacement-unattributed", { eventId: event.eventId, sender: event.sender });
      }
    }
    return true;
  }

  /**
   * Whether `documentId` is bound to `roomId`: an event counts for a document only in the room it
   * is bound to (BRG-10). The account is usually in other rooms too, with other people; a frame from
   * one of them would let someone outside the document's room write into it, and an edit or a
   * redaction from there would fill its integrity log with records nobody in the room caused.
   */
  function boundHere(documentId: string, roomId: string, bindStore: BindStoreData): boolean {
    return bindStore[documentId]?.roomId === roomId;
  }

  async function processLogicalEvent(
    event: LogicalEvent,
    roomId: string,
    bindStore: BindStoreData,
  ): Promise<void> {
    if (event.type === REDACTION_EVENT_TYPE) {
      const target = extractRedactsTarget(event.content);
      if (target === undefined) {
        return; // malformed redaction — nothing to attribute
      }
      const documentId = delivered.get(target)?.documentId;
      if (documentId === undefined) {
        // We never recorded the redacted event ourselves (it predates this
        // process, or its own content already arrived stripped) — cannot
        // attribute to a specific document's own integrity log, but still
        // worth a structured line.
        logger.warn("redaction-unattributed", { redacts: target, sender: event.sender });
        return;
      }
      if (!boundHere(documentId, roomId, bindStore)) {
        return;
      }
      reject(documentId, target, event.sender, "message-redacted");
      return;
    }
    if (event.type !== FRAME_EVENT_TYPE) {
      return; // non-protocol traffic in the room — silently ignored, same rule
    }
    if (isReplaceRelation(event.content)) {
      const documentId = readDocumentIdHint(event.content);
      if (documentId !== undefined && boundHere(documentId, roomId, bindStore)) {
        reject(documentId, event.eventId, event.sender, "message-edited");
      } else {
        logger.warn("edit-unattributed", { eventId: event.eventId, sender: event.sender });
      }
      return;
    }
    if (event.redactedBefore) {
      // This is necessarily the first (and only) time /sync ever hands us
      // this event id, and a redacted event's content is stripped to {} —
      // there is no documentId left to route on, so this can never be
      // attributed to a specific document's own integrity log, only logged.
      logger.warn("redaction-unattributed", { redacts: event.eventId, sender: event.sender });
      return;
    }
    const foreign = foreignEnvelopeVersion(event.content);
    if (foreign !== undefined) {
      if (bindStore[foreign.documentId]) {
        logger.warn("unsupported-envelope-version", { ...foreign, eventId: event.eventId });
      }
      return;
    }
    const envelope = readFrameEnvelope(event.content);
    if (envelope === undefined) {
      return;
    }
    if (!boundHere(envelope.documentId, roomId, bindStore)) {
      return;
    }
    const digest = contentDigest(envelope);
    if (alreadyDelivered(event, digest, roomId, bindStore)) {
      return;
    }
    if (envelope.attachment !== undefined) {
      const frame = await fetchAttachment(envelope.attachment);
      if (frame === "retry") {
        if (pendingAttachments.length >= MAX_PENDING_ATTACHMENTS) {
          pendingAttachments.shift();
        }
        pendingAttachments.push({
          event,
          roomId,
          documentId: envelope.documentId,
          attachment: envelope.attachment,
          digest,
          attempts: 1,
          nextAt: Date.now() + ATTACHMENT_RETRY_BASE_MS,
        });
        return;
      }
      if (frame !== null) {
        recordEvent(event, envelope.documentId, frame, digest);
      }
      return;
    }
    recordEvent(event, envelope.documentId, envelope.frame, digest);
  }

  /** Tries again every attachment whose wait is over; one that keeps failing is given up on after a few tries. */
  async function retryPendingAttachments(bindStore: BindStoreData): Promise<void> {
    const now = Date.now();
    for (const pending of [...pendingAttachments]) {
      if (pending.nextAt > now) {
        continue;
      }
      // Another event under this id may have been delivered while this one waited (BRG-12).
      if (alreadyDelivered(pending.event, pending.digest, pending.roomId, bindStore)) {
        pendingAttachments.splice(pendingAttachments.indexOf(pending), 1);
        continue;
      }
      let frame: string | "retry" | null;
      try {
        frame = await fetchAttachment(pending.attachment);
      } catch (error) {
        // One attachment that cannot be read must not stop every later poll before its events
        // (BRG-18): it is given up on.
        logger.warn("attachment-unreadable", {
          error: error instanceof Error ? error.message : String(error),
        });
        frame = null;
      }
      if (frame === "retry") {
        pending.attempts += 1;
        if (pending.attempts >= MAX_ATTACHMENT_ATTEMPTS) {
          pendingAttachments.splice(pendingAttachments.indexOf(pending), 1);
          logger.warn("attachment-given-up", { attempts: pending.attempts });
          continue;
        }
        pending.nextAt =
          now +
          Math.min(ATTACHMENT_RETRY_CAP_MS, ATTACHMENT_RETRY_BASE_MS * 2 ** (pending.attempts - 1));
        continue;
      }
      pendingAttachments.splice(pendingAttachments.indexOf(pending), 1);
      if (frame !== null) {
        recordEvent(pending.event, pending.documentId, frame, pending.digest);
      }
    }
  }

  async function doPoll(): Promise<void> {
    const result = await syncOnce(config, nextBatch);
    const wasFirstPoll = !hasPolledOnce;
    nextBatch = result.nextBatch;
    hasPolledOnce = true;

    // Every poll, including the first — to-device messages (room-key
    // shares among them) are not room "history" in the sense the
    // timeline discard below cares about; see this module's own doc
    // comment.
    //
    // Any Matrix user can send this device a to-device event, nested as deep as they like. The
    // crypto machine takes them as one JSON text, which some Node.js versions cannot write for a
    // deep enough value; this round's position has moved on already, so its frames would be lost
    // for good (TRN-7). No to-device event the bridge needs nests more than a few levels, so one
    // deeper than any message this specification defines (§1.6) is left out.
    const toDeviceEvents = result.toDeviceEvents.filter((event) => {
      if (!jsonValueTooDeep(event)) {
        return true;
      }
      logger.warn("to-device-event-too-deep", { type: event.type });
      return false;
    });
    await crypto.receiveSync(
      toDeviceEvents,
      result.deviceListsChanged,
      result.deviceListsLeft,
      result.oneTimeKeyCounts,
    );

    // A room's state comes before its timeline; on a first `/sync` it is where the room's
    // `m.room.encryption` is (MTX-5).
    for (const [roomId, events] of result.roomStateEvents) {
      for (const event of events) {
        noteEncryption(roomId, event);
      }
    }
    if (wasFirstPoll) {
      // Establish the timeline baseline only — see this module's own doc comment — but keep
      // what it shows about which rooms are encrypted.
      for (const [roomId, events] of result.roomEvents) {
        for (const event of events) {
          noteEncryption(roomId, event);
        }
      }
      return;
    }
    const bindStore = loadBindStore(bindStorePath);
    await retryPendingAttachments(bindStore);
    for (const [roomId, events] of result.roomEvents) {
      for (const event of events) {
        // In timeline order: a frame sent before the room's encryption was turned on was valid then.
        noteEncryption(roomId, event);
        if (event.type === FRAME_EVENT_TYPE && isEncryptedRoom(roomId, bindStore)) {
          logger.warn("unencrypted-frame-in-encrypted-room", {
            roomId,
            eventId: event.event_id,
            sender: event.sender,
          });
          continue;
        }
        // One event the bridge cannot read must not keep it from the others: this round's
        // position has moved on already, so the events after it would be lost (BRG-18).
        try {
          const logical = await resolveLogicalEvent(event, roomId);
          if (logical) {
            await processLogicalEvent(logical, roomId, bindStore);
          }
        } catch (error) {
          logger.warn("event-unreadable", {
            roomId,
            eventId: event.event_id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  return {
    pollOnce(): Promise<void> {
      if (!inFlight) {
        inFlight = doPoll().finally(() => {
          inFlight = undefined;
        });
      }
      return inFlight;
    },
    getDeliveries(documentId: DocumentId): readonly Delivery[] {
      return deliveries.get(documentId) ?? [];
    },
    getIntegrityLog(documentId: DocumentId): readonly IntegrityEntry[] {
      return violations.get(documentId) ?? [];
    },
    hasSeenEncrypted(roomId: string): boolean {
      return seenEncrypted.has(roomId);
    },
  };
}
