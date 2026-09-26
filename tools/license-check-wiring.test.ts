import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const read = (relative: string): string => readFileSync(`${repoRoot}/${relative}`, "utf8");

/**
 * The guard on the guard — mirrors `netcheck-wiring.test.ts` exactly, for
 * exactly the same reason: `license-check.test.ts` proves the checker
 * works, but that says nothing about whether it actually runs anywhere.
 * This workflow lists its steps individually rather than calling
 * `pnpm run ci`, so a check added to only one of the two places looks
 * green locally and never runs on CI, or vice versa; `continue-on-error`
 * would make it advisory with no other visible symptom.
 */
describe("the third-party license checks are actually wired in", () => {
  it("runs licenses:check from the root ci script, so `pnpm run ci` covers it locally", () => {
    const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
    expect(scripts["licenses:check"]).toBeDefined();
    expect(scripts["licenses:generate"]).toBeDefined();
    expect(scripts.ci).toContain("licenses:check");
  });

  it("runs licenses:check in the blocking CI job, which does not call the ci script", () => {
    expect(ciJob()).toContain("pnpm run licenses:check");
  });

  it("keeps the blocking CI job blocking", () => {
    expect(ciJob()).not.toContain("continue-on-error");
  });
});

/** The `ci:` job's own block, up to the next top-level job key. */
function ciJob(): string {
  const workflow = read(".github/workflows/ci.yml");
  const start = workflow.indexOf("\n  ci:");
  expect(start).toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const nextJob = rest.search(/\n {2}[a-z0-9_-]+:\n/);
  return nextJob === -1 ? rest : rest.slice(0, nextJob);
}
