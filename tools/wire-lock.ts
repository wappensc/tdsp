import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * The wire lock: a record of everything that decides what TDSP puts on a messenger, so that a
 * change to it cannot pass unnoticed (docs/testing.md, "Wire compatibility"; SPECIFICATION.md
 * §14, VER-1). `wire/wire-lock.json` holds a hash of every entry of every frozen wire file and
 * published test vector, of the constants and versions stored beside them, and of each
 * normative wire section of the specification, together with the specification's version.
 *
 * `compareWireLock` says what changed and what kind of change it is:
 *
 * - **incompatible** — an entry changed or disappeared, or a constant or version changed: the
 *   bytes on the wire are no longer what they were. Needs a new major version.
 * - **addition** — only new entries: older implementations are unaffected (a compatible
 *   addition, §14). Needs a new minor version of the specification.
 * - **specification** — a wire section's text changed while every byte stayed the same:
 *   either editorial (a patch version, or none) or a change of meaning that the frozen
 *   entries have not caught up with.
 *
 * Only the CI role may accept a change (`pnpm run wire:lock -- --accept <kind>`), and the
 * lock checks that the specification's version moved accordingly. Both this file and the lock
 * are owned by the CI role (.github/CODEOWNERS).
 */

/** Files whose entries are the wire, frozen: the reference implementation's and the published vectors. */
export const WIRE_FILES = [
  "wire/frames-v1.json",
  "wire/invitations-v1.json",
  "wire/signal-v1.json",
  "wire/matrix-v1.json",
  "wire/email-v1.json",
  "packages/document-protocol/test-vectors/frames-v1.json",
  "packages/document-protocol/test-vectors/invitations-v1.json",
  "bridges/email-bridge/test-vectors/member-ids-v1.json",
] as const;

/** The specification's normative wire sections, by heading: frame, profiles, control state, invitations, bindings, values. */
export const WIRE_SECTIONS = [
  "## 4. The payload frame",
  "## 5. Document profiles",
  "## 7. Control state",
  "## 11. Invitations",
  "## 13. Messenger bindings",
  "## Appendix A. Profile `yjs-paragraphs/1`",
  "## Appendix B. Recommended values",
] as const;

export const LOCK_FILE = "wire/wire-lock.json";

export type ChangeKind = "incompatible" | "addition" | "specification";

export interface FileSnapshot {
  /** Everything in the file but its entries — version and constants — as one hash. */
  readonly frame: string;
  /** Every entry's hash, by the collection it is in and its name. */
  readonly entries: Readonly<Record<string, string>>;
}

export interface WireSnapshot {
  readonly specificationVersion: string;
  readonly files: Readonly<Record<string, FileSnapshot>>;
  readonly sections: Readonly<Record<string, string>>;
}

export interface Finding {
  readonly kind: ChangeKind | "version";
  readonly message: string;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** JSON with sorted keys, so a hash depends on content and not on how a file was written out. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .filter((key) => key !== "$comment")
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function snapshotFile(json: Record<string, unknown>): FileSnapshot {
  const entries: Record<string, string> = {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(json)) {
    if (Array.isArray(value) && value.every((item) => item !== null && typeof item === "object")) {
      for (const item of value as Record<string, unknown>[]) {
        const name = typeof item.name === "string" ? item.name : canonical(item);
        entries[`${key}: ${name}`] = sha256(canonical(item));
      }
    } else {
      rest[key] = value;
    }
  }
  return { frame: sha256(canonical(rest)), entries };
}

/** One heading's section, up to the next heading of its level or above, whitespace collapsed. */
export function sectionText(specification: string, heading: string): string {
  const start = specification.indexOf(`\n${heading}\n`);
  if (start === -1) {
    throw new Error(`SPECIFICATION.md has no section "${heading}"`);
  }
  const level = (heading.split(" ")[0] as string).length;
  const rest = specification.slice(start + heading.length + 2);
  const next = rest.search(new RegExp(`\\n#{2,${level}} `));
  return (next === -1 ? rest : rest.slice(0, next)).replace(/\s+/g, " ").trim();
}

export function specificationVersion(specification: string): string {
  const match = /\*\*Specification · TDSP (\d+\.\d+(?:\.\d+)?)\b/.exec(specification);
  if (!match) {
    throw new Error("SPECIFICATION.md names no version in its header line");
  }
  return match[1] as string;
}

export function snapshot(repoRoot: string): WireSnapshot {
  const read = (relative: string) => readFileSync(`${repoRoot}/${relative}`, "utf8");
  const specification = read("SPECIFICATION.md");
  return {
    specificationVersion: specificationVersion(specification),
    files: Object.fromEntries(
      WIRE_FILES.map((file) => [file, snapshotFile(JSON.parse(read(file)))]),
    ),
    sections: Object.fromEntries(
      WIRE_SECTIONS.map((heading) => [heading, sha256(sectionText(specification, heading))]),
    ),
  };
}

export function compareWireLock(lock: WireSnapshot, current: WireSnapshot): Finding[] {
  const findings: Finding[] = [];
  for (const [file, locked] of Object.entries(lock.files)) {
    const now = current.files[file];
    if (now === undefined) {
      findings.push({ kind: "incompatible", message: `${file} is gone` });
      continue;
    }
    if (now.frame !== locked.frame) {
      findings.push({
        kind: "incompatible",
        message: `${file}: its version or constants changed`,
      });
    }
    for (const [name, hash] of Object.entries(locked.entries)) {
      if (now.entries[name] === undefined) {
        findings.push({ kind: "incompatible", message: `${file}: "${name}" was removed` });
      } else if (now.entries[name] !== hash) {
        findings.push({ kind: "incompatible", message: `${file}: "${name}" changed` });
      }
    }
    for (const name of Object.keys(now.entries)) {
      if (locked.entries[name] === undefined) {
        findings.push({ kind: "addition", message: `${file}: "${name}" was added` });
      }
    }
  }
  for (const file of Object.keys(current.files)) {
    if (lock.files[file] === undefined) {
      findings.push({ kind: "addition", message: `${file} is new` });
    }
  }
  for (const [heading, hash] of Object.entries(lock.sections)) {
    if (current.sections[heading] !== hash) {
      findings.push({ kind: "specification", message: `SPECIFICATION.md "${heading}" changed` });
    }
  }
  if (current.specificationVersion !== lock.specificationVersion) {
    findings.push({
      kind: "version",
      message: `SPECIFICATION.md is version ${current.specificationVersion}, the lock records ${lock.specificationVersion}`,
    });
  }
  return findings;
}

/** The most serious kind among the findings, ignoring the version finding itself. */
export function severity(findings: readonly Finding[]): ChangeKind | undefined {
  const kinds = new Set(findings.map((finding) => finding.kind));
  if (kinds.has("incompatible")) return "incompatible";
  if (kinds.has("addition")) return "addition";
  if (kinds.has("specification")) return "specification";
  return undefined;
}

const parseVersion = (version: string): [number, number, number] => {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  return [major, minor, patch];
};

/**
 * Whether moving the specification from `from` to `to` fits a change of `kind`: an
 * incompatible change a new major version, an addition a new minor one, a specification-only
 * change the same major and minor version (a patch, or none). `undefined` when it fits.
 */
export function versionProblem(kind: ChangeKind, from: string, to: string): string | undefined {
  const [fromMajor, fromMinor, fromPatch] = parseVersion(from);
  const [toMajor, toMinor, toPatch] = parseVersion(to);
  const fits =
    kind === "incompatible"
      ? toMajor === fromMajor + 1 && toMinor === 0 && toPatch === 0
      : kind === "addition"
        ? toMajor === fromMajor && toMinor === fromMinor + 1 && toPatch === 0
        : toMajor === fromMajor && toMinor === fromMinor && toPatch >= fromPatch;
  if (fits) {
    return undefined;
  }
  const expected =
    kind === "incompatible"
      ? `${fromMajor + 1}.0`
      : kind === "addition"
        ? `${fromMajor}.${fromMinor + 1}`
        : `${fromMajor}.${fromMinor}.${fromPatch + 1} (or unchanged)`;
  return `an ${kind} change needs SPECIFICATION.md at version ${expected}, not ${to} (from ${from})`;
}

export function readLock(repoRoot: string): WireSnapshot {
  return JSON.parse(readFileSync(`${repoRoot}/${LOCK_FILE}`, "utf8")) as WireSnapshot;
}

export function writeLock(repoRoot: string, current: WireSnapshot): void {
  writeFileSync(
    `${repoRoot}/${LOCK_FILE}`,
    `${JSON.stringify(
      {
        $comment:
          "The wire lock (tools/wire-lock.ts): hashes of every frozen wire entry, published test vector, constant and normative wire section of the specification, with the specification's version. tools/wire-lock.wire.test.ts fails on any difference and names its kind; only the CI role may accept one, with `pnpm run wire:lock -- --accept <incompatible|addition|specification>`, which checks that the specification's version moved accordingly. Never edit by hand.",
        ...current,
      },
      null,
      2,
    )}\n`,
  );
}

/** `pnpm run wire:lock` — check; `-- --accept <kind>` — accept the current state as `kind` and write the lock. */
export function main(repoRoot: string, args: readonly string[]): number {
  const lock = readLock(repoRoot);
  const current = snapshot(repoRoot);
  const findings = compareWireLock(lock, current);
  const kind = severity(findings);
  const acceptIndex = args.indexOf("--accept");
  if (acceptIndex === -1) {
    if (findings.length === 0) {
      console.log("wire-lock: the wire is as locked.");
      return 0;
    }
    console.error(
      `wire-lock: ${findings.length} difference(s), the most serious ${kind ?? "a version"}:`,
    );
    for (const finding of findings) {
      console.error(`  - [${finding.kind}] ${finding.message}`);
    }
    return 1;
  }
  const accepted = args[acceptIndex + 1] as ChangeKind | undefined;
  if (accepted !== "incompatible" && accepted !== "addition" && accepted !== "specification") {
    console.error("wire-lock: --accept needs incompatible, addition or specification");
    return 2;
  }
  if (kind !== undefined && kind !== accepted) {
    console.error(`wire-lock: the change is ${kind}; it cannot be accepted as ${accepted}`);
    return 1;
  }
  const problem = versionProblem(accepted, lock.specificationVersion, current.specificationVersion);
  if (problem !== undefined) {
    console.error(`wire-lock: ${problem}`);
    return 1;
  }
  writeLock(repoRoot, current);
  console.log(`wire-lock: accepted as ${accepted}; ${LOCK_FILE} written.`);
  return 0;
}
