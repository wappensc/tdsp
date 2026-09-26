import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The local `documentId ↔ groupId` bind-store (SPECIFICATION.md §12.2) — the
 * same mechanism `bridges/matrix-bridge/src/bind-store.ts` uses for `roomId`. The **only**
 * place document metadata is ever persisted for this adapter — never
 * inside the Signal group itself, which carries no concept of document
 * metadata at all.
 *
 * No permission, archived or deleted state: membership and the
 * document's lifecycle are control frames owned by `document-protocol`, and a
 * bridge only routes. Unknown fields in a record are ignored.
 *
 * No `encrypted` field (Matrix's own bind-store has one): a Signal
 * group message is always end-to-end encrypted by the Signal Protocol
 * itself, with no per-room opt-in/opt-out the way Matrix's
 * `m.room.encryption` state event is — nothing to check or record.
 */
export interface BindRecord {
  readonly groupId: string;
  readonly creatorMemberId: string;
  readonly profile: string;
  readonly createdAt: string;
}

export type BindStoreData = Record<string, BindRecord>;

/**
 * Loads the bind-store file, or an empty store if it doesn't exist yet —
 * a fresh bridge with nothing bound yet is a normal, expected state, not
 * an error.
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
 * Writes the whole store back, temp-then-rename (`SPECIFICATION.md`
 * §12.3, BRG-10) — a crash mid-write cannot corrupt routing
 * for every other document sharing this one file. `renameSync` is atomic
 * on the same filesystem, which a sibling temp file in the same directory
 * always is.
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
 * Read-modify-write for one record — `sync-state.ts`'s own
 * `membership-change`/`archived`/`deleted` envelope handling uses this to
 * apply an incoming control envelope to whatever this bridge already has
 * on file, without clobbering fields the envelope doesn't touch. A no-op
 * (not an error) for a `documentId` this bridge has never bound — the
 * same "unknown documentId ⇒ dropped silently" rule
 * `SPECIFICATION.md` §12.5 (BRG-13) already applies to `Delivery`.
 */
export function updateBindRecord(
  path: string,
  documentId: string,
  updater: (record: BindRecord) => BindRecord,
): void {
  const data = loadBindStore(path);
  const existing = data[documentId];
  if (!existing) {
    return;
  }
  data[documentId] = updater(existing);
  saveBindStore(path, data);
}
