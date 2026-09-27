import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Collected, checkSettings, type ExpectedSettings, main } from "./repo-settings.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const EXPECTED = JSON.parse(
  readFileSync(`${repoRoot}/.github/repository-settings.json`, "utf8"),
) as ExpectedSettings;
const R = EXPECTED.repository;
const O = EXPECTED.organization;

/** What GitHub reports to an administrator when everything is as `EXPECTED` says. */
function adminView(): Record<string, { ok: boolean; data?: unknown }> {
  const ok = (data: unknown) => ({ ok: true, data });
  const logins = (names: readonly string[]) => names.map((login) => ({ login }));
  return {
    [`repos/${R}`]: ok({ ...EXPECTED.repositorySettings }),
    [`repos/${R}/rules/branches/main`]: ok([
      { type: "deletion" },
      { type: "non_fast_forward" },
      { type: "pull_request", parameters: { ...EXPECTED.branchRules.pull_request } },
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: EXPECTED.branchRules.required_status_checks.map((c) => ({
            ...c,
          })),
          strict_required_status_checks_policy: false,
        },
      },
    ]),
    [`repos/${R}/collaborators?per_page=100`]: ok(
      Object.entries(EXPECTED.collaborators).map(([login, role_name]) => ({ login, role_name })),
    ),
    [`repos/${R}/codeowners/errors`]: ok({ errors: [] }),
    [`repos/${R}/rulesets`]: ok([{ id: 7, name: "main" }]),
    [`repos/${R}/rulesets/7`]: ok({
      name: "main",
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      bypass_actors: EXPECTED.mainRuleset.bypass.map((b) => ({
        actor_id: EXPECTED.teams[b.team]?.id,
        actor_type: "Team",
        bypass_mode: b.mode,
      })),
    }),
    [`repos/${R}/teams?per_page=100`]: ok(
      Object.entries(EXPECTED.teams).map(([slug, team]) => ({ slug, permission: team.permission })),
    ),
    [`repos/${R}/actions/permissions`]: ok({ enabled: true, allowed_actions: "all" }),
    [`repos/${R}/actions/permissions/workflow`]: ok({
      default_workflow_permissions: "read",
      can_approve_pull_request_reviews: false,
    }),
    [`repos/${R}/actions/permissions/fork-pr-contributor-approval`]: ok({
      approval_policy: "all_external_contributors",
    }),
    [`orgs/${O}/members?role=admin&per_page=100`]: ok(logins(EXPECTED.organizationOwners)),
    ...Object.fromEntries(
      Object.entries(EXPECTED.teams).map(([slug, team]) => [
        `orgs/${O}/teams/${slug}/members?per_page=100`,
        ok(logins(team.members)),
      ]),
    ),
  };
}

const failures = (endpoints: Collected["endpoints"]) =>
  checkSettings(EXPECTED, { endpoints })
    .filter((result) => result.outcome === "fail")
    .map((result) => `${result.name} — ${result.detail}`);

/** `adminView()` with the data at `path` changed by `change`. */
function withChange(path: string, change: (data: never) => unknown): Collected["endpoints"] {
  const view = adminView();
  const entry = view[path];
  if (entry === undefined) {
    throw new Error(`no ${path} in the admin view`);
  }
  view[path] = { ok: true, data: change(structuredClone(entry.data) as never) };
  return view;
}

describe("the repository settings, as an administrator sees them", () => {
  it("pass every check when GitHub reports what .github/repository-settings.json says", () => {
    const results = checkSettings(EXPECTED, { endpoints: adminView() });
    expect(results.filter((r) => r.outcome !== "pass")).toEqual([]);
    expect(results.length).toBeGreaterThanOrEqual(13);
  });

  describe("fail on each way the checks could be sidestepped quietly", () => {
    it.each<[string, Collected["endpoints"], RegExp]>([
      [
        "a developer made administrator",
        withChange(
          `repos/${R}/collaborators?per_page=100`,
          (list: { login: string; role_name: string }[]) =>
            list.map((c) => (c.login === "wappensc-developer" ? { ...c, role_name: "admin" } : c)),
        ),
        /can write to the repository/,
      ],
      [
        "another account given write access directly",
        withChange(`repos/${R}/collaborators?per_page=100`, (list: object[]) => [
          ...list,
          { login: "someone", role_name: "write" },
        ]),
        /can write to the repository/,
      ],
      [
        "a second organization owner",
        withChange(`orgs/${O}/members?role=admin&per_page=100`, (list: object[]) => [
          ...list,
          { login: "wappensc-developer" },
        ]),
        /owners are/,
      ],
      [
        "a developer added to the ci team",
        withChange(`orgs/${O}/teams/ci/members?per_page=100`, (list: object[]) => [
          ...list,
          { login: "wappensc-developer" },
        ]),
        /ci has/,
      ],
      [
        "the developers team raised to maintain",
        withChange(
          `repos/${R}/teams?per_page=100`,
          (list: { slug: string; permission: string }[]) =>
            list.map((t) => (t.slug === "developers" ? { ...t, permission: "maintain" } : t)),
        ),
        /teams are/,
      ],
      [
        "the ci team without write access, so CODEOWNERS no longer binds",
        withChange(`repos/${R}/codeowners/errors`, () => ({
          errors: [{ line: 7, kind: "Unknown owner" }],
        })),
        /CODEOWNERS is valid/,
      ],
      [
        "force-pushes allowed on main",
        withChange(`repos/${R}/rules/branches/main`, (rules: { type: string }[]) =>
          rules.filter((r) => r.type !== "non_fast_forward"),
        ),
        /missing rule\(s\): non_fast_forward/,
      ],
      [
        "code owner review switched off",
        withChange(
          `repos/${R}/rules/branches/main`,
          (rules: { type: string; parameters?: Record<string, unknown> }[]) =>
            rules.map((r) =>
              r.type === "pull_request"
                ? { ...r, parameters: { ...r.parameters, require_code_owner_review: false } }
                : r,
            ),
        ),
        /require_code_owner_review is false/,
      ],
      [
        "a required CI job dropped",
        withChange(
          `repos/${R}/rules/branches/main`,
          (
            rules: {
              type: string;
              parameters?: { required_status_checks: { context: string }[] };
            }[],
          ) =>
            rules.map((r) =>
              r.type === "required_status_checks"
                ? {
                    ...r,
                    parameters: {
                      ...r.parameters,
                      required_status_checks: r.parameters?.required_status_checks.filter(
                        (c) => c.context !== "network-isolation",
                      ),
                    },
                  }
                : r,
            ),
        ),
        /checks are/,
      ],
      [
        "a required job accepted from any source, not only GitHub Actions",
        withChange(
          `repos/${R}/rules/branches/main`,
          (rules: { type: string; parameters?: { required_status_checks: object[] } }[]) =>
            rules.map((r) =>
              r.type === "required_status_checks"
                ? {
                    ...r,
                    parameters: {
                      ...r.parameters,
                      required_status_checks: r.parameters?.required_status_checks.map((c) => ({
                        ...c,
                        integration_id: undefined,
                      })),
                    },
                  }
                : r,
            ),
        ),
        /checks are/,
      ],
      [
        "the main ruleset only evaluated, not enforced",
        withChange(`repos/${R}/rulesets/7`, (ruleset: object) => ({
          ...ruleset,
          enforcement: "evaluate",
        })),
        /enforcement is evaluate/,
      ],
      [
        "the developers team allowed to bypass",
        withChange(`repos/${R}/rulesets/7`, (ruleset: { bypass_actors: object[] }) => ({
          ...ruleset,
          bypass_actors: [
            ...ruleset.bypass_actors,
            { actor_id: 19739392, actor_type: "Team", bypass_mode: "always" },
          ],
        })),
        /bypass is/,
      ],
      [
        "the workflow token allowed to write",
        withChange(`repos/${R}/actions/permissions/workflow`, (w: object) => ({
          ...w,
          default_workflow_permissions: "write",
        })),
        /default_workflow_permissions is write/,
      ],
      [
        "workflows allowed to approve pull requests",
        withChange(`repos/${R}/actions/permissions/workflow`, (w: object) => ({
          ...w,
          can_approve_pull_request_reviews: true,
        })),
        /can_approve_pull_request_reviews is true/,
      ],
      [
        "GitHub Actions switched off",
        withChange(`repos/${R}/actions/permissions`, (a: object) => ({ ...a, enabled: false })),
        /enabled is false/,
      ],
      [
        "fork pull requests running workflows unapproved after a first contribution",
        withChange(`repos/${R}/actions/permissions/fork-pr-contributor-approval`, () => ({
          approval_policy: "first_time_contributors",
        })),
        /approval_policy is first_time_contributors/,
      ],
      [
        "merge commits allowed besides squash",
        withChange(`repos/${R}`, (r: object) => ({ ...r, allow_merge_commit: true })),
        /allow_merge_commit is true/,
      ],
    ])("%s", (_name, endpoints, message) => {
      const found = failures(endpoints);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatch(message);
    });
  });
});

describe("the repository settings, as an ordinary token sees them", () => {
  /** What the checks cannot read without administration rights. */
  function ordinaryView(): Collected["endpoints"] {
    const view = adminView();
    for (const path of [
      `repos/${R}/teams?per_page=100`,
      `repos/${R}/actions/permissions`,
      `repos/${R}/actions/permissions/workflow`,
      `repos/${R}/actions/permissions/fork-pr-contributor-approval`,
    ]) {
      view[path] = { ok: false };
    }
    const ruleset = view[`repos/${R}/rulesets/7`]?.data as Record<string, unknown>;
    view[`repos/${R}/rulesets/7`] = { ok: true, data: { ...ruleset, bypass_actors: null } };
    return view;
  }

  it("reports what it cannot read as not checked, never as passed", () => {
    const results = checkSettings(EXPECTED, { endpoints: ordinaryView() });
    expect(results.filter((r) => r.outcome === "fail")).toEqual([]);
    expect(results.filter((r) => r.outcome === "not-checked").map((r) => r.name)).toEqual([
      "each team has exactly its permission on the repository, and no other team has any",
      "only the admins and ci teams may bypass the main ruleset",
      "GitHub Actions is on, its token only reads, and it cannot approve pull requests",
      "a pull request from outside the teams runs no workflow before someone approves it",
    ]);
  });

  describe("on the command line", () => {
    let dir: string | undefined;
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    const run = (endpoints: Collected["endpoints"], ...flags: string[]) => {
      dir = mkdtempSync(join(tmpdir(), "repo-settings-"));
      const file = join(dir, "collected.json");
      writeFileSync(file, JSON.stringify({ endpoints }));
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      return main(repoRoot, [file, ...flags]);
    };

    it("passes with a warning when checks could not be made, as in an ordinary CI run", () => {
      expect(run(ordinaryView())).toBe(0);
      expect(
        vi
          .mocked(console.log)
          .mock.calls.some(([line]) => String(line).includes("could not be made")),
      ).toBe(true);
    });

    it("fails with --require-admin when checks could not be made, as the full check by hand", () => {
      expect(run(ordinaryView(), "--require-admin")).toBe(1);
    });

    it("passes with --require-admin when an administrator could read everything", () => {
      expect(run(adminView(), "--require-admin")).toBe(0);
    });

    it("fails on a real difference even without --require-admin", () => {
      expect(
        run(withChange(`repos/${R}/codeowners/errors`, () => ({ errors: [{ line: 1 }] }))),
      ).toBe(1);
    });
  });
});

describe(".github/repository-settings.json", () => {
  it("names only teams it defines in the bypass list, and every team member is a collaborator", () => {
    for (const bypass of EXPECTED.mainRuleset.bypass) {
      expect(EXPECTED.teams[bypass.team], bypass.team).toBeDefined();
    }
    for (const team of Object.values(EXPECTED.teams)) {
      for (const member of team.members) {
        expect(EXPECTED.collaborators[member], member).toBeDefined();
      }
    }
  });
});
