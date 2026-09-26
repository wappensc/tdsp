import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const read = (relative: string): string => readFileSync(`${repoRoot}/${relative}`, "utf8");

/**
 * The guard on the guard (docs/network-policy.md).
 *
 * `tools/netcheck.test.ts` proves the checker works. This proves it is
 * actually *wired in*, which is a separate and easier thing to lose: the
 * checker could keep passing its own tests forever while nothing ran it.
 *
 * Two specific ways that happens, both structural rather than
 * hypothetical:
 *
 * 1. `.github/workflows/ci.yml` lists its steps individually and does
 *    **not** call `pnpm run ci`, so the root script and the workflow can
 *    drift apart silently. A check added to one but not the other looks
 *    green locally and never runs on CI, or vice versa.
 * 2. `continue-on-error: true` at job level makes a job non-blocking. One
 *    line added to the `ci` job would turn every check in it advisory, with
 *    no other visible symptom — the job still reports success.
 *
 * Deliberately plain string assertions over the raw files rather than a
 * YAML parse: no YAML dependency exists in this repository, and the point
 * is to notice a change, which substring checks do just as well.
 */
describe("the network-egress checks are actually wired in", () => {
  it("runs netcheck from the root ci script, so `pnpm run ci` covers it locally", () => {
    const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
    expect(scripts.netcheck).toBeDefined();
    expect(scripts.ci).toContain("netcheck");
  });

  it("runs netcheck in the blocking CI job, which does not call the ci script", () => {
    expect(ciJob()).toContain("pnpm run netcheck");
  });

  it("keeps the blocking CI job blocking", () => {
    expect(ciJob()).not.toContain("continue-on-error");
  });

  /**
   * The runtime guard is only in force because vitest.config.ts
   * loads it into every worker. Deleting that one line would disable it
   * everywhere while every other test in the repository still passes.
   */
  it("loads the runtime network guard into every vitest worker", () => {
    expect(read("vitest.config.ts")).toContain("tools/vitest-setup.ts");
  });

  /** Proves the extraction above isolates the `ci` job rather than matching the whole file. */
  it("really is reading only the ci job, not the whole workflow", () => {
    const workflow = read(".github/workflows/ci.yml");
    expect(ciJob().length).toBeLessThan(workflow.length);
    expect(ciJob()).toContain("Lint (Biome)");
    expect(ciJob()).not.toContain("matrix:up");
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
