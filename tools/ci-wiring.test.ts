import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const read = (relative: string): string => readFileSync(`${repoRoot}/${relative}`, "utf8");

/**
 * The workflow keeps the properties that make its checks impossible to sidestep from a file
 * the CI role does not own (.github/CODEOWNERS, CONTRIBUTING.md): every check in the blocking
 * job is invoked directly rather than through a package.json script, the jobs that need a
 * local server prove afterwards that their tests ran rather than skipped, and nothing is
 * advisory.
 */
describe("the CI workflow cannot be sidestepped from outside the CI role's files", () => {
  it("calls no package.json script in the blocking job", () => {
    const runLines = job("ci")
      .split("\n")
      .filter((line) => /^\s+(- )?run:/.test(line));
    expect(runLines.length).toBeGreaterThan(5);
    for (const line of runLines) {
      if (line.includes("pnpm install --frozen-lockfile")) {
        continue;
      }
      expect(line, "a check must not go through a package.json script").not.toMatch(
        /pnpm run|npm run|pnpm (?!exec|install)\w/,
      );
    }
  });

  it("proves that the Matrix and email tests ran instead of skipping", () => {
    for (const name of ["matrix", "email"]) {
      expect(job(name), `${name} job`).toContain("tools/test-run-check-cli.ts vitest-report.json");
      expect(job(name), `${name} job`).toContain("--outputFile.json=vitest-report.json");
    }
  });

  it("makes no job advisory", () => {
    expect(read(".github/workflows/ci.yml")).not.toContain("continue-on-error");
  });
});

/** One job's block, from its key up to the next top-level job key. */
function job(name: string): string {
  const workflow = read(".github/workflows/ci.yml");
  const start = workflow.indexOf(`\n  ${name}:`);
  expect(start, `job ${name}`).toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const nextJob = rest.slice(1).search(/\n {2}[a-z0-9_-]+:\n/);
  return nextJob === -1 ? rest : rest.slice(0, nextJob + 1);
}
