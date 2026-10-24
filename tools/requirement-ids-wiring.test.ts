import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const read = (relative: string): string => readFileSync(`${repoRoot}/${relative}`, "utf8");

/**
 * The guard on the guard, as `license-check-wiring.test.ts` and `netcheck-wiring.test.ts`:
 * `requirement-ids.test.ts` proves the checker works, not that it runs. This workflow lists its
 * steps one by one instead of calling `pnpm run ci`, so a check registered in only one of the two
 * places would be a silent hole.
 */
describe("the requirement-ID check is actually wired in", () => {
  it("runs from the root ci script, so `pnpm run ci` covers it locally", () => {
    const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
    expect(scripts["requirement-ids"]).toBeDefined();
    expect(scripts.ci).toContain("requirement-ids");
  });

  it("runs in the blocking CI job, which does not call the ci script", () => {
    expect(ciJob()).toContain("node --experimental-strip-types tools/requirement-ids-cli.ts");
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
