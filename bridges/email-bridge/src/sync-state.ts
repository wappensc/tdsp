import { createHash } from "node:crypto";
import { type Logger, loggerFromEnv } from "@tdsp/bridge-log";
import {
  DEFAULT_DELIVERY_RETENTION,
  type Delivery,
  type DeliveryRetention,
  retainNewest,
} from "@tdsp/messenger-port";
import { type BindRecord, getBindRecord } from "./bind-store.ts";
import {
  decodeEnvelope,
  foreignEnvelopeVersion,
  normalizeAddress,
  pgpFormatOf,
  recipientHeadersMatchClosedSet,
} from "./envelope.ts";
import type { GpgInvoker } from "./gpg-invoke.ts";
import type { IncomingMail, MailReceiver } from "./mail-transport.ts";

/**
 * Why an inbound message was rejected instead of applied. Recorded, never just
 * dropped (SPECIFICATION.md BRG-15): kept in memory, served at
 * `GET /channels/:documentId/integrity-log` for an application to show, and
 * logged.
 */
export type RejectionReason =
  /** Transport-level check: the message's actual `To`/`Cc` headers don't reconstitute the document's closed participant set. */
  | "recipient-list-mismatch"
  /** A PGP-enabled document received a protocol message with no signature at all — plain JSON, or encrypted but never signed. */
  | "pgp-unsigned"
  /** A PGP-enabled document received a message that is signed but *not encrypted* — a downgrade of what such a document requires, refused even though the signature might be good. */
  | "pgp-unencrypted"
  /** A properly armored message this bridge cannot open: addressed only to other keys, or corrupted in transit. Not applied; a resync is the recovery. */
  | "pgp-undecipherable"
  /** Bad signature, or a signature from a key the document's own keyring does not hold — someone outside the participants, or a participant whose key is not the one the creator named. */
  | "pgp-signature-invalid"
  /** A valid signature, but by a different key than the one pinned for the address in `From:` — key rotation and impersonation look identical, so it is never silently accepted. */
  | "pgp-identity-changed"
  /** A PGP-enabled document, but this bridge has nothing to open it with — no `gpg`, or no keyring of the document's own — so nothing can be verified and nothing is trusted. */
  | "pgp-unavailable"
  /** A PGP-protected message arrived for a document this bridge has PGP switched off for — a setting mismatch between participants, not something to guess around. */
  | "pgp-disabled-locally"
  /** A second, distinct message arrived reusing an already-seen `Message-ID` with different text — an attempted messenger-native edit or withdrawal (SPECIFICATION.md BRG-12). Never applied; an identical repeat (an ordinary IMAP re-read) is not this reason. */
  | "message-id-reused"
  /** Larger than the bridge reads (BRG-13, `MAX_INCOMING_MAIL_BYTES`): never parsed, decrypted or applied. */
  | "message-too-large";

export interface Rejection {
  readonly messageId: string;
  /** The `From:` address as received — for a PGP-off document that is exactly as trustworthy as an unauthenticated header, i.e. not at all. */
  readonly sender: string;
  readonly reason: RejectionReason;
}

/**
 * Accumulates `receive()`'s cumulative per-`documentId` buffers, mirroring
 * `bridges/matrix-bridge`'s/`bridges/signal-bridge`'s own `SyncState` role —
 * but per-document, not global: email has no single "one `/sync` stream
 * for everything" the way Matrix does, since a thread's messages are
 * found by searching IMAP for `documentId`'s own custom header, one
 * document at a time.
 *
 * Every inbound message runs two independent integrity checks before
 * anything is surfaced as a `Delivery` (SPECIFICATION.md EML-2, EML-3). Beyond
 * those checks this module only routes: membership, the document's lifecycle and
 * resync requests are frames inside the opaque payload, read and enforced by
 * `document-protocol`, so nothing here writes the bind-store or checks a creator:
 *
 * 1. **Transport level** (`recipientHeadersMatchClosedSet`, PGP-independent):
 *    the sender plus everyone addressed must be exactly the closed
 *    participant set. PGP signs the body, never these headers.
 * 2. **Identity level** (PGP-enabled documents only): the
 *    body must be an inline OpenPGP message that decrypts and verifies
 *    against **the document's own keyring** and carries a signature made by
 *    the key pinned for the `From:` address. This is what turns a signature
 *    into *sender authentication* — a valid signature only proves some key
 *    the keyring holds signed it, and a `From:` header is forgeable by
 *    anyone. Every participant is pinned from the creator's invitation
 *    before the first message can arrive, and the keyring holds only those
 *    keys, so a key from any earlier, unrelated correspondence — or one that
 *    simply arrives first — can never become anyone's identity.
 *
 * Any failure rejects the message outright, whatever frame it carries —
 * an unsigned or wrongly-signed message is discarded regardless, and
 * convergence is left to the existing resync mechanism,
 * never to applying unverified content.
 */
export interface SyncState {
  pollOnce(documentId: string): Promise<void>;
  getDeliveries(documentId: string): readonly Delivery[];
  getRejections(documentId: string): readonly Rejection[];
}

export function createSyncState(
  receiver: MailReceiver,
  bindStorePath: string,
  gpg: GpgInvoker | undefined,
  logger: Logger = loggerFromEnv("email-bridge"),
  /** How much of each document's deliveries `getDeliveries` keeps (BRG-17). */
  retention: DeliveryRetention = DEFAULT_DELIVERY_RETENTION,
): SyncState {
  const deliveries = new Map<string, Delivery[]>();
  const rejections = new Map<string, Rejection[]>();
  /**
   * `messageId -> SHA-256 of the first delivery's raw text`, so a repeat under the same id can
   * be compared against it rather than assumed benign. The hash, not
   * the text: every message of a long-lived thread stays here — it is what keeps a message
   * dropped by retention from being offered again while this bridge runs (BRG-17) — and must
   * not keep its body. So this grows with the thread, as the mailbox does, a few hundred
   * bytes a message; bounding it would make every poll re-offer what fell out, since IMAP
   * re-reads the whole thread. It lives in memory only: after a restart the thread's older
   * messages are offered again, which an engine tolerates (TRN-8).
   */
  const seenMessageIds = new Map<string, string>();
  const digestOf = (text: string): string => createHash("sha256").update(text).digest("hex");
  // One poll at a time per document. Signature verification is
  // asynchronous (a `gpg` subprocess), so two overlapping polls — the
  // deliveries and the integrity-log routes both poll — could otherwise
  // see the same message, have the first still mid-verification, and let
  // the second return a result that doesn't contain it yet.
  const pollQueue = new Map<string, Promise<void>>();

  function reject(documentId: string, message: IncomingMail, reason: RejectionReason): void {
    const list = rejections.get(documentId) ?? [];
    list.push({ messageId: message.messageId, sender: normalizeAddress(message.from), reason });
    rejections.set(documentId, list);
    // The in-memory list above is what the user sees; the log is what
    // survives a restart and what an operator greps. Once per message —
    // `processMessage` marks every message id seen before it can reject it.
    logger.warn("message-rejected", {
      reason,
      documentId,
      messageId: message.messageId,
      sender: normalizeAddress(message.from),
    });
  }

  /**
   * The text `decodeEnvelope` should parse — the message body itself for a
   * PGP-off document, the decrypted-and-verified payload for a PGP-enabled
   * one — or `undefined` when the message is not to be applied (either
   * rejected, in which case a `Rejection` was recorded, or simply not a
   * protocol message at all, e.g. the invitation email, whose readable text
   * comes before its PGP block and which is read once, when joining).
   */
  async function unwrapEnvelopeText(
    documentId: string,
    bound: BindRecord,
    message: IncomingMail,
  ): Promise<string | undefined> {
    const format = pgpFormatOf(message.text);

    if (!bound.pgpEnabled) {
      if (format !== "plain") {
        reject(documentId, message, "pgp-disabled-locally");
        return undefined;
      }
      return message.text;
    }

    if (format === "plain") {
      // A plain, human-readable message in the thread (the invite email,
      // say) is not a protocol message and was never going to be
      // applied — only a well-formed *envelope* arriving with no PGP
      // protection on a PGP-enabled document is a rejection worth
      // recording.
      if (decodeEnvelope(message.text) !== undefined) {
        reject(documentId, message, "pgp-unsigned");
      }
      return undefined;
    }
    if (format === "clearsigned") {
      // Signed but not encrypted: never applied, whatever its signature
      // says. A PGP-enabled document is confidential by definition, and
      // accepting a signed-only message would let a downgrade through.
      reject(documentId, message, "pgp-unencrypted");
      return undefined;
    }

    if (gpg === undefined || bound.keyringPath === undefined) {
      reject(documentId, message, "pgp-unavailable");
      return undefined;
    }
    // The document's own keyring: the only public keys this document knows.
    const result = await gpg.withKeyring(bound.keyringPath).decryptAndVerify(message.text);
    if (!result.decrypted) {
      reject(documentId, message, "pgp-undecipherable");
      return undefined;
    }
    if (result.signature === "missing") {
      reject(documentId, message, "pgp-unsigned");
      return undefined;
    }
    if (
      result.signature !== "valid" ||
      result.signerFingerprint === undefined ||
      result.payload === undefined
    ) {
      reject(documentId, message, "pgp-signature-invalid");
      return undefined;
    }

    // Every participant was pinned from the creator's invitation, so the
    // sender (already known to be one of them by the header check) always has
    // a pin; a record without one is damaged, and nothing is trusted from it.
    const pinned = bound.pinnedFingerprints[normalizeAddress(message.from)];
    if (pinned === undefined) {
      reject(documentId, message, "pgp-unavailable");
      return undefined;
    }
    if (pinned.toUpperCase() !== result.signerFingerprint.toUpperCase()) {
      reject(documentId, message, "pgp-identity-changed");
      return undefined;
    }
    return result.payload;
  }

  async function processMessage(documentId: string, message: IncomingMail): Promise<void> {
    if (message.messageId.length === 0) {
      return;
    }
    const boundAtArrival = getBindRecord(bindStorePath, documentId);
    if (!boundAtArrival) {
      return; // this bridge never started this thread — silently ignored
    }

    // SPECIFICATION.md BRG-12: IMAP
    // re-reads the same mailbox on every poll, so a repeated Message-ID is
    // ordinarily benign — the same bytes, seen again. A repeat carrying
    // *different* text is the resend-under-an-existing-Message-ID case the
    // rule names explicitly: never applied (this function already returns
    // before ever reaching the delivery logic below), and recorded
    // rather than silently indistinguishable from ordinary IMAP noise.
    const firstSeenDigest = seenMessageIds.get(message.messageId);
    if (firstSeenDigest !== undefined) {
      if (firstSeenDigest !== digestOf(message.text)) {
        reject(documentId, message, "message-id-reused");
      }
      return;
    }
    seenMessageIds.set(message.messageId, digestOf(message.text));

    // Larger than the bridge reads (BRG-13): only its envelope was fetched, so there is nothing
    // to check or open — rejected before any parser or `gpg` sees it.
    if (message.tooLarge) {
      reject(documentId, message, "message-too-large");
      return;
    }

    // Check 1 (transport-level, independent of and prior to any PGP
    // check): the sender plus everyone this message was addressed to must
    // exactly equal the document's closed participant set — a mismatch
    // means someone was silently added or excluded at the raw header
    // level.
    if (
      !recipientHeadersMatchClosedSet(
        message.from,
        message.to,
        message.cc,
        boundAtArrival.recipients,
      )
    ) {
      reject(documentId, message, "recipient-list-mismatch");
      return;
    }

    // Check 2 (identity-level, PGP-enabled documents only).
    const text = await unwrapEnvelopeText(documentId, boundAtArrival, message);
    if (text === undefined) {
      return;
    }

    const foreign = foreignEnvelopeVersion(text);
    if (foreign !== undefined) {
      if (foreign.documentId === documentId) {
        logger.warn("unsupported-envelope-version", { ...foreign, messageId: message.messageId });
      }
      return;
    }
    const envelope = decodeEnvelope(text);
    if (!envelope || envelope.documentId !== documentId) {
      return; // not our envelope (e.g. the plain invite email) — silently ignored
    }

    const list = deliveries.get(documentId) ?? [];
    list.push({
      id: message.messageId,
      documentId,
      sender: normalizeAddress(message.from),
      payload: envelope.frame,
    });
    // Bounded; a dropped message stays in seenMessageIds, so a later IMAP read of the
    // thread does not offer it again while this bridge runs (BRG-17).
    retainNewest(list, retention);
    deliveries.set(documentId, list);
  }

  async function poll(documentId: string): Promise<void> {
    const bound = getBindRecord(bindStorePath, documentId);
    if (!bound) {
      return;
    }
    const messages = await receiver.fetchThreadMessages(documentId);
    for (const message of messages) {
      await processMessage(documentId, message);
    }
  }

  return {
    pollOnce(documentId) {
      const previous = pollQueue.get(documentId) ?? Promise.resolve();
      const current = previous.then(() => poll(documentId));
      // A failed poll must not wedge every later one for this document.
      pollQueue.set(
        documentId,
        current.catch(() => undefined),
      );
      return current;
    },
    getDeliveries(documentId) {
      return deliveries.get(documentId) ?? [];
    },
    getRejections(documentId) {
      return rejections.get(documentId) ?? [];
    },
  };
}
