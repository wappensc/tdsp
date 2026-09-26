import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The local `documentId ↔ thread` bind-store (SPECIFICATION.md §12.2, §13.4),
 * shaped like the Matrix and Signal bridges' own `bind-store.ts`. The **only** place document metadata is ever persisted for
 * this adapter. Unlike Matrix/Signal, there is nothing to "bind" to —
 * `startThread` (`server.ts`) both creates this record and sends the
 * thread's own first, human-readable invite email in one call, since
 * email has no pre-existing channel to attach to.
 *
 * `recipients` is the document's permanently closed distribution list
 * (the closed participant set, SPECIFICATION.md §13.4) — fixed at
 * `startThread` and never mutated afterward, in either direction.
 *
 * No permission, archived or deleted state: membership and the
 * document's lifecycle are control frames owned by `document-protocol`, and a
 * bridge only routes. Unknown fields in a record are ignored.
 */
export interface BindRecord {
  readonly recipients: readonly string[];
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
   * (SPECIFICATION.md EML-3). A valid signature only proves
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
