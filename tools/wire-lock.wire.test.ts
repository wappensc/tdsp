import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compareWireLock, readLock, severity, snapshot } from "./wire-lock.ts";

/**
 * The wire is as locked (docs/testing.md, "Wire compatibility"): no frozen entry, published
 * vector, constant, normative wire section of the specification or binding document differs
 * from wire/wire-lock.json, and the specification's version and the draft marker (VER-3) are the
 * ones recorded. A difference is reported with its kind; only the CI role may accept it
 * (`pnpm run wire:lock -- --accept`).
 */
const repoRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

describe("the wire lock", () => {
  it("matches the wire as it is", () => {
    const findings = compareWireLock(readLock(repoRoot), snapshot(repoRoot));
    const report = findings.map((finding) => `[${finding.kind}] ${finding.message}`).join("\n");
    expect(
      findings,
      `a ${severity(findings) ?? "version"} change to the wire — only the CI role may accept it, ` +
        `with \`pnpm run wire:lock -- --accept <kind>\`:\n${report}`,
    ).toEqual([]);
  });
});
