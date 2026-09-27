import { describe, expect, it } from "vitest";
import { checkTestRun, parseArguments } from "./test-run-check.ts";

const root = "/repo";
const file = (name: string, ...statuses: string[]) => ({
  name: `${root}/${name}`,
  assertionResults: statuses.map((status, i) => ({ status, fullName: `case ${i}` })),
});

describe("checking that a test group really ran", () => {
  const group = [{ require: /\.security\.test\.ts$/ }];

  it("accepts a group whose every test passed", () => {
    const report = { testResults: [file("a.security.test.ts", "passed", "passed")] };
    expect(checkTestRun(report, root, group)).toEqual([]);
  });

  it("refuses a skipped, pending or todo test in the group", () => {
    const report = {
      testResults: [file("a.security.test.ts", "passed", "skipped", "pending", "todo")],
    };
    expect(checkTestRun(report, root, group)).toEqual([
      'a.security.test.ts: "case 1" is skipped, not passed',
      'a.security.test.ts: "case 2" is pending, not passed',
      'a.security.test.ts: "case 3" is todo, not passed',
    ]);
  });

  it("refuses a group that did not run at all, and a file that collected nothing", () => {
    expect(checkTestRun({ testResults: [file("other.test.ts", "passed")] }, root, group)).toEqual([
      "no test file matching /\\.security\\.test\\.ts$/ ran at all",
    ]);
    expect(checkTestRun({ testResults: [file("a.security.test.ts")] }, root, group)).toEqual([
      "a.security.test.ts: collected no tests",
    ]);
  });

  it("ignores skips outside the group, and files the group excludes", () => {
    const report = {
      testResults: [
        file("bridges/x/src/a.test.ts", "passed"),
        file("bridges/x/src/l4-real.test.ts", "skipped"),
        file("unrelated.test.ts", "skipped"),
      ],
    };
    const rules = [{ require: /^bridges\/x\//, except: /\/l4-/ }];
    expect(checkTestRun(report, root, rules)).toEqual([]);
  });
});

describe("its command line", () => {
  it("reads a report path and rules, --except narrowing the --require before it", () => {
    const { reportPath, rules } = parseArguments([
      "r.json",
      "--require",
      "^a/",
      "--except",
      "l4-",
      "--require",
      "b",
    ]);
    expect(reportPath).toBe("r.json");
    expect(rules.map((r) => [String(r.require), String(r.except)])).toEqual([
      ["/^a\\//", "/l4-/"],
      ["/b/", "undefined"],
    ]);
  });

  it("refuses a missing report, an --except with nothing to narrow, and no rule", () => {
    expect(() => parseArguments(["--require", "x"])).toThrow(/usage/);
    expect(() => parseArguments(["r.json", "--except", "x"])).toThrow(/must follow/);
    expect(() => parseArguments(["r.json"])).toThrow(/at least one/);
  });
});
