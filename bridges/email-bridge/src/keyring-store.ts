import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Where each PGP-enabled document's own public keyring lives (SPECIFICATION.md
 * EML-4): a `keyrings/` directory next to the bind-store, one keybox file per
 * document, all owned by this bridge and never by the user's own `gpg` home.
 * The file name is a hash of the `documentId` — the id is caller-chosen text
 * and must never become a path — and the path is always absolute, because
 * `gpg` resolves a relative keyring name against its home directory.
 *
 * A keyring is built at a *pending* path and renamed into place only once the
 * invitation it came from has been verified (or, at the creator, once the
 * invitation has been sent): a rejected invitation leaves nothing behind, and
 * an earlier keyring for the same document is never half-overwritten.
 */
function keyringDir(bindStorePath: string): string {
  return join(resolve(dirname(bindStorePath)), "keyrings");
}

export function keyringPathFor(bindStorePath: string, documentId: string): string {
  const name = createHash("sha256").update(documentId).digest("hex");
  return join(keyringDir(bindStorePath), `${name}.kbx`);
}

/** A fresh, unused path in the same directory (so the final rename stays on one filesystem). Creates the directory, readable by this user only. */
export function newPendingKeyringPath(bindStorePath: string): string {
  const dir = keyringDir(bindStorePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return join(dir, `pending-${randomUUID()}.kbx`);
}

/** `gpg` leaves a `~` backup next to a keybox it modified twice. */
function removeKeybox(path: string): void {
  rmSync(path, { force: true });
  rmSync(`${path}~`, { force: true });
}

export function commitKeyring(pendingPath: string, finalPath: string): void {
  removeKeybox(finalPath);
  renameSync(pendingPath, finalPath);
  rmSync(`${pendingPath}~`, { force: true });
}

export function discardKeyring(path: string): void {
  removeKeybox(path);
}
