import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The local `documentId ↔ roomId` bind-store (SPECIFICATION.md §12.2), the
 * same mechanism the Signal bridge uses for its `groupId`. The **only** place
 * document metadata is ever persisted for this adapter — never in the Matrix
 * room itself, never as a state event: this implementation never configures
 * the room.
 *
 * No permission, archived or deleted state: membership and the
 * document's lifecycle are control frames owned by `document-protocol`, and a
 * bridge only routes. Unknown fields in a record are ignored.
 */
export interface BindRecord {
  readonly roomId: string;
  readonly creatorMemberId: string;
  readonly profile: string;
  readonly createdAt: string;
  /**
   * Whether the bound room already had `m.room.encryption` set at bind
   * time — read-only, checked once, never set by this bridge: end-to-end
   * encryption is inherited from the room the person picked, never forced
   * (SPECIFICATION.md §13.3). `m.room.encryption` is itself
   * irreversible at the Matrix protocol level, so this never needs
   * re-checking after bind time.
   */
  readonly encrypted: boolean;
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
