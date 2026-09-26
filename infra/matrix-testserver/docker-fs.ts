import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREDENTIALS_DIR, SYNAPSE_IMAGE } from "./config.ts";

/**
 * Every host-side write into `credentials/` after Synapse's own
 * `generate` has run goes through here — never a direct `fs.writeFileSync`/
 * `appendFileSync` against a path under `CREDENTIALS_DIR`. Found the hard
 * way, across two failed attempts, only visible on a real Linux CI
 * runner (never locally on macOS/OrbStack, whose bind-mount layer papers
 * over host/container uid mismatches):
 *
 * `generate`'s own entrypoint runs as root, then (its own logged step)
 * recursively chowns everything under `/data` — the directory itself
 * included, not just the files in it — to a fixed in-container uid/gid
 * (991:991). On real Linux Docker a bind mount shares host inode
 * ownership directly, so from that point on: appending to an existing
 * file there (`homeserver.yaml`) fails with `EACCES` (no group/other
 * write bit), *and separately* creating a brand-new file directly in the
 * directory (`test-accounts.json`) also fails with `EACCES` (no group/
 * other write bit on the directory entry itself — a different host-side
 * uid can't add entries to a directory it doesn't own or have write
 * access to, regardless of what it's writing).
 *
 * A first fix attempt chowned `/data` back to the host user, which
 * "solved" the write problem by breaking the *next* thing instead: the
 * long-running server process (still uid 991 internally — only `generate`
 * itself runs as root) could then no longer read its own signing key.
 * Any fix that changes ownership to satisfy a host-side write
 * necessarily fights with what the long-running server needs, so this
 * module never touches ownership at all. Both helpers below stage
 * content through a host-side temp file (never owned by 991, so writing
 * *that* is unaffected) and use a throwaway container that — like
 * `generate` — still runs as root, and can write into a 991-owned
 * directory/file without changing who owns anything.
 */

function stageAndRun(content: string, dockerArgs: (stagedPath: string) => string[]): void {
  const stagingFile = join(tmpdir(), `tdsp-matrix-stage-${randomUUID()}`);
  writeFileSync(stagingFile, content);
  try {
    execFileSync("docker", dockerArgs(stagingFile), { stdio: "inherit" });
  } finally {
    rmSync(stagingFile, { force: true });
  }
}

/** Creates `credentials/<relativePath>` (must not already exist under normal use) with `content`. */
export function writeIntoCredentialsDir(relativePath: string, content: string): void {
  stageAndRun(content, (stagingFile) => [
    "run",
    "--rm",
    "-v",
    `${CREDENTIALS_DIR}:/data`,
    "-v",
    `${stagingFile}:/staged:ro`,
    "--entrypoint",
    "cp",
    SYNAPSE_IMAGE,
    "/staged",
    `/data/${relativePath}`,
  ]);
}

/** Appends `content` onto the end of the already-existing `credentials/<relativePath>`. */
export function appendIntoCredentialsDir(relativePath: string, content: string): void {
  stageAndRun(content, (stagingFile) => [
    "run",
    "--rm",
    "-v",
    `${CREDENTIALS_DIR}:/data`,
    "-v",
    `${stagingFile}:/staged:ro`,
    "--entrypoint",
    "sh",
    SYNAPSE_IMAGE,
    "-c",
    `cat /staged >> /data/${relativePath}`,
  ]);
}
