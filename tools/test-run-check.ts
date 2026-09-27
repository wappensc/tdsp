import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Proves that a group of tests really ran. A test that needs a local server skips itself
 * when the server is absent, and a skipped test looks green; so a CI job that is meant to
 * run the Matrix tests against Synapse, or the security and wire tests at all, checks
 * Vitest's JSON report afterwards: every test file of the group is present, collected at
 * least one test, and every test in it passed — none skipped, pending or todo.
 *
 * It lives in tools/, which only the CI role may change (.github/CODEOWNERS), so a change
 * elsewhere — a server that is quietly no longer started, a test file that skips itself —
 * cannot make a required group vanish while the job stays green.
 */

interface AssertionResult {
  readonly status: string;
  readonly fullName: string;
}

interface FileResult {
  readonly name: string;
  readonly assertionResults: readonly AssertionResult[];
}

export interface VitestJsonReport {
  readonly testResults: readonly FileResult[];
}

export interface GroupRule {
  /** Files (relative to the repository root, `/`-separated) that belong to the group. */
  readonly require: RegExp;
  /** Files matching `require` that are nevertheless not part of it. */
  readonly except?: RegExp;
}

export function checkTestRun(
  report: VitestJsonReport,
  repoRoot: string,
  rules: readonly GroupRule[],
): string[] {
  const files = report.testResults.map((file) => ({
    path: path.relative(repoRoot, file.name).split(path.sep).join("/"),
    results: file.assertionResults,
  }));
  const violations: string[] = [];
  for (const rule of rules) {
    const group = files.filter(
      (file) => rule.require.test(file.path) && !(rule.except?.test(file.path) ?? false),
    );
    if (group.length === 0) {
      violations.push(`no test file matching ${rule.require} ran at all`);
      continue;
    }
    for (const file of group) {
      if (file.results.length === 0) {
        violations.push(`${file.path}: collected no tests`);
        continue;
      }
      const notPassed = file.results.filter((result) => result.status !== "passed");
      for (const result of notPassed) {
        violations.push(`${file.path}: "${result.fullName}" is ${result.status}, not passed`);
      }
    }
  }
  return violations;
}

/** `<report.json> --require <regex> [--except <regex>] [--require <regex> …]` */
export function parseArguments(args: readonly string[]): {
  reportPath: string;
  rules: GroupRule[];
} {
  const [reportPath, ...rest] = args;
  if (reportPath === undefined || reportPath.startsWith("--")) {
    throw new Error("usage: test-run-check <report.json> --require <regex> [--except <regex>] …");
  }
  const rules: { require: RegExp; except?: RegExp }[] = [];
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (value === undefined) {
      throw new Error(`${flag} needs a value`);
    }
    if (flag === "--require") {
      rules.push({ require: new RegExp(value) });
    } else if (flag === "--except") {
      const last = rules.at(-1);
      if (last === undefined) {
        throw new Error("--except must follow the --require it narrows");
      }
      last.except = new RegExp(value);
    } else {
      throw new Error(`unknown option ${flag}`);
    }
  }
  if (rules.length === 0) {
    throw new Error("at least one --require is needed");
  }
  return { reportPath, rules };
}

export function main(repoRoot: string, args: readonly string[]): number {
  const { reportPath, rules } = parseArguments(args);
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as VitestJsonReport;
  const violations = checkTestRun(report, repoRoot, rules);
  if (violations.length > 0) {
    console.error(`test-run-check: ${violations.length} problem(s):`);
    for (const violation of violations) {
      console.error(`  - ${violation}`);
    }
    return 1;
  }
  console.log(`test-run-check: every required group ran, and every test in it passed.`);
  return 0;
}
