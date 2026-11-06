import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { normalizeAddress } from "./envelope.ts";

/**
 * The local `documentId ↔ thread` bind-store (SPECIFICATION.md §12.2, §13.4),
 * shaped like the Matrix and Signal bridges' own `bind-store.ts`. The **only** place document metadata is ever persisted for
 * this adapter. Unlike Matrix/Signal, there is nothing to "bind" to —
 * `startThread` (`server.ts`) both creates this record and sends the
 * thread's own first, human-readable invite email in one call, since
 * email has no pre-existing channel to attach to.
 *
 * `recipients` is the participant set as the thread started (bindings/email.md EML-1) — fixed
 * at `startThread` and never mutated afterward. `removed` is who the creator has removed from it
 * since (EML-14); the set this bridge holds is the one less the other ({@link heldParticipants}),
 * so it only ever shrinks.
 *
 * No permission, archived or deleted state: membership and the
 * document's lifecycle are control frames owned by `document-protocol`, and a
 * bridge only routes. Unknown fields in a record are ignored.
 */
export interface BindRecord {
  readonly recipients: readonly string[];
  /**
   * The participants the creator removed (bindings/email.md EML-14), as canonical MemberIds,
   * each one of `recipients`. Only ever added to, by {@link recordRemoval}; absent in a record
   * from which nobody was removed.
   */
  readonly removed?: readonly string[];
  readonly creatorMemberId: string;
  readonly profile: string;
  readonly threadRootMessageId: string;
  readonly createdAt: string;
  /**
   * Whether PGP is enabled for this document — chosen once, when the thread
   * is started.
   */
  pgpEnabled: boolean;
  /**
   * Per-member *primary-key* fingerprint, keyed by normalized address — the
   * identity every message of a PGP-enabled document is checked against
   * (bindings/email.md EML-3). A valid signature only proves
   * "some key I have imported signed this"; it says nothing about whether
   * that key belongs to the address in the `From:` header, which anyone can
   * forge. Comparing the verified signer's fingerprint with the one recorded
   * here is what turns a valid signature into sender authentication.
   *
   * Written **once, for every participant, from the creator's signed
   * invitation** (EML-4) (or, at the creator, from the keys the creator chose) — never
   * from a participant's own keyring, and never lazily on a first message
   * (no trust on first use per participant). Empty, and never consulted,
   * for a PGP-off document.
   */
  pinnedFingerprints: Record<string, string>;
  /**
   * Absolute path of this document's own public keyring, holding
   * exactly the keys in `pinnedFingerprints`. Everything this bridge signs,
   * encrypts, decrypts or verifies for the document goes through it, so a key
   * that arrived in an invitation never lands in the user's own keyring.
   * `undefined` for a PGP-off document; a PGP-enabled record without one is
   * refused rather than guessed around.
   */
  keyringPath?: string;
  /** The primary-key fingerprint this bridge signs with, and decrypts as, for this document — the one the creator's invitation lists for this bridge's own address. */
  ownFingerprint?: string;
  /**
   * The creator's initial send policy as its signed invitation carried it
   * (SPECIFICATION.md §11.2) — an opaque short text (`30000,120000,0,inf,60000@0`), read only by
   * `document-protocol`, which this bridge never depends on. Kept so that a
   * participant who resumes the document, or a creator who reopens it, is handed the
   * same policy again without the invitation in hand. PGP-enabled documents only:
   * that is where the policy is inside the signature.
   */
  policy?: string;
}

export type BindStoreData = Record<string, BindRecord>;

/**
 * Loads the bind-store file, or an empty store if it doesn't exist yet —
 * a fresh bridge with nothing started yet is a normal, expected state,
 * not an error.
 */
export function loadBindStore(path: string): BindStoreData {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as BindStoreData;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

/**
 * Writes the whole store back, temp-then-rename — a crash mid-write
 * cannot corrupt routing for every other document sharing this one
 * file. `renameSync` is atomic on the same filesystem, which a sibling
 * temp file in the same directory always is.
 */
export function saveBindStore(path: string, data: BindStoreData): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, JSON.stringify(data, null, 2));
  renameSync(tempPath, path);
}

export function getBindRecord(path: string, documentId: string): BindRecord | undefined {
  return loadBindStore(path)[documentId];
}

export function setBindRecord(path: string, documentId: string, record: BindRecord): void {
  const data = loadBindStore(path);
  data[documentId] = record;
  saveBindStore(path, data);
}

/**
 * The participant set this bridge holds for a document (bindings/email.md EML-14): the set the
 * thread started with, less everyone the creator removed, in the order the thread started with
 * and as written there.
 */
export function heldParticipants(record: BindRecord): readonly string[] {
  const removed = new Set((record.removed ?? []).map(normalizeAddress));
  return record.recipients.filter((address) => !removed.has(normalizeAddress(address)));
}

/** Whether the creator removed `address` from the document's thread (EML-14). */
export function isRemoved(record: BindRecord, address: string): boolean {
  const wanted = normalizeAddress(address);
  return (record.removed ?? []).some((removed) => normalizeAddress(removed) === wanted);
}

/**
 * Removes `participant` from the set held for `documentId` and writes it to disk, so the removal
 * outlasts a restart (EML-14): read, changed and written in one synchronous step, so two
 * removals in this process cannot lose each other. Only ever adds to `removed`, never takes from
 * it, so removals end the same whatever order they arrive in. Returns the record as written, or
 * `undefined` when there is no record or `participant` is not one of its participants other than
 * the creator.
 */
export function recordRemoval(
  path: string,
  documentId: string,
  participant: string,
): BindRecord | undefined {
  const data = loadBindStore(path);
  const record = data[documentId];
  const wanted = normalizeAddress(participant);
  if (
    record === undefined ||
    normalizeAddress(record.creatorMemberId) === wanted ||
    !record.recipients.some((address) => normalizeAddress(address) === wanted)
  ) {
    return undefined;
  }
  if (isRemoved(record, wanted)) {
    return record;
  }
  const updated: BindRecord = { ...record, removed: [...(record.removed ?? []), wanted] };
  data[documentId] = updated;
  saveBindStore(path, data);
  return updated;
}
