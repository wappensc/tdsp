import { readdirSync, readFileSync } from "node:fs";
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

  it("calls no package.json script in any job, not even to start or stop a test server", () => {
    // Every line that is not a comment, so that multi-line `run: |` blocks are read too.
    const lines = read(".github/workflows/ci.yml")
      .split("\n")
      .filter((line) => !/^\s*#/.test(line));
    for (const name of ["matrix", "email", "network-isolation"]) {
      expect(job(name), `${name} job`).toContain(
        `docker compose -f infra/${name === "email" ? "email" : "matrix"}-testserver/docker-compose.yml up -d`,
      );
    }
    for (const line of lines) {
      expect(line, "a step must not go through a package.json script").not.toMatch(
        /pnpm run|npm run|pnpm (?!exec|install|rebuild (--recursive )?@)\w/,
      );
    }
  });

  it("runs no lifecycle script of a package.json before the network-isolation block", () => {
    const steps = job("network-isolation");
    const block = steps.indexOf("Block all non-loopback egress");
    expect(block).toBeGreaterThan(-1);
    const before = steps
      .slice(0, block)
      .split("\n")
      .filter((line) => !/^\s*#/.test(line));
    const installs = before.filter((line) => /\bpnpm install\b/.test(line));
    expect(installs).toHaveLength(1);
    expect(installs[0]).toContain("--ignore-scripts");
    // Only a named dependency may be built; a bare `pnpm rebuild` would build them all.
    for (const line of before.filter((l) => /\bpnpm rebuild\b/.test(l))) {
      expect(line).toMatch(/pnpm rebuild (--recursive )?@[\w.-]+\/[\w.-]+$/);
    }
  });

  it("proves that the Matrix and email tests ran instead of skipping", () => {
    for (const name of ["matrix", "email"]) {
      expect(job(name), `${name} job`).toContain("tools/test-run-check-cli.ts vitest-report.json");
      expect(job(name), `${name} job`).toContain("--outputFile.json=vitest-report.json");
    }
  });

  it("proves in the blocking job that every security and wire test ran", () => {
    expect(job("ci")).toContain(
      "tools/test-run-check-cli.ts vitest-report.json --require '\\.security\\.test\\.ts$' --require '\\.wire\\.test\\.ts$'",
    );
  });

  it("checks the repository's settings on every push to main, every day, and on demand", () => {
    const workflow = read(".github/workflows/repository-settings.yml");
    expect(workflow).toMatch(/push:\n\s+branches: \[main\]/);
    expect(workflow).toMatch(/schedule:\n\s+- cron:/);
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("bash .github/scripts/repo-settings-collect.sh");
    expect(workflow).toContain("tools/repo-settings-cli.ts repository-settings.collected.json");
    expect(workflow).not.toContain("continue-on-error");
  });

  it("pins every action to a commit, not to a tag that can be moved", () => {
    const workflows = readdirSync(`${repoRoot}/.github/workflows`).filter((f) =>
      /\.ya?ml$/.test(f),
    );
    expect(workflows.length).toBeGreaterThan(1);
    for (const file of workflows) {
      const uses = read(`.github/workflows/${file}`)
        .split("\n")
        .filter((line) => /^\s+(- )?uses:/.test(line));
      expect(uses.length, file).toBeGreaterThan(0);
      for (const line of uses) {
        expect(line, file).toMatch(/uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
      }
    }
  });

  it("has Dependabot propose new versions of the pinned actions", () => {
    const config = read(".github/dependabot.yml");
    expect(config).toContain("package-ecosystem: github-actions");
    expect(config).toMatch(/directory: \/\n/);
    expect(config, "the developer takes over its pull requests").toMatch(
      /assignees:\n\s+- wappensc-developer\n/,
    );
    expect(config, "one pull request for all of them").toMatch(
      /groups:\n\s+[\w-]+:\n\s+patterns:\n\s+- "\*"\n/,
    );
  });

  it("makes no job advisory", () => {
    expect(read(".github/workflows/ci.yml")).not.toContain("continue-on-error");
  });

  it("gives every workflow a read-only token, whatever the repository's default", () => {
    const workflows = readdirSync(`${repoRoot}/.github/workflows`).filter((f) =>
      /\.ya?ml$/.test(f),
    );
    expect(workflows.length).toBeGreaterThan(1);
    for (const file of workflows) {
      const workflow = read(`.github/workflows/${file}`);
      expect(workflow, file).toMatch(/^permissions:\n {2}contents: read\n/m);
      expect(workflow, `${file} must not widen the token`).not.toMatch(/: write\b/);
    }
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
