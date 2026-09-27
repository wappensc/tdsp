import { readFileSync } from "node:fs";

/**
 * Whether the repository on GitHub is configured the way the development process needs it
 * (docs/repository-settings.md): without these settings the CI role's ownership of the
 * checks could be sidestepped quietly — a developer with admin rights could switch the
 * ruleset off, an extra bypass could merge without checks, a team losing write access would
 * silently void CODEOWNERS.
 *
 * `.github/scripts/repo-settings-collect.sh` asks GitHub and records, per API path, what it
 * returned or that the token in use may not read it. This compares that with
 * `.github/repository-settings.json`, without any network access of its own. A check whose
 * data could not be read is reported as not checked: a warning in the ordinary CI run, whose
 * token cannot read everything, and an error with `--require-admin`, which is how the admin or
 * CI role runs the full check by hand.
 */

export interface ExpectedSettings {
  readonly repository: string;
  readonly organization: string;
  readonly defaultBranch: string;
  readonly repositorySettings: Readonly<Record<string, boolean>>;
  readonly organizationOwners: readonly string[];
  readonly collaborators: Readonly<Record<string, string>>;
  readonly teams: Readonly<
    Record<
      string,
      { readonly id: number; readonly permission: string; readonly members: readonly string[] }
    >
  >;
  readonly mainRuleset: {
    readonly name: string;
    readonly enforcement: string;
    readonly include: readonly string[];
    readonly bypass: readonly { readonly team: string; readonly mode: string }[];
  };
  readonly branchRules: {
    readonly deletion: boolean;
    readonly non_fast_forward: boolean;
    readonly pull_request: Readonly<Record<string, number | boolean>>;
    readonly required_status_checks: readonly {
      readonly context: string;
      readonly integration_id: number;
    }[];
    readonly strict_required_status_checks_policy: boolean;
  };
  readonly actions: {
    readonly enabled: boolean;
    readonly default_workflow_permissions: string;
    readonly can_approve_pull_request_reviews: boolean;
    readonly fork_pr_approval_policy: string;
  };
}

export interface Collected {
  readonly collectedAt?: string;
  readonly endpoints: Readonly<Record<string, { readonly ok: boolean; readonly data?: unknown }>>;
}

export type Outcome = "pass" | "fail" | "not-checked";

export interface CheckResult {
  readonly name: string;
  readonly outcome: Outcome;
  /** For a failure, what differs; for a check not made, what could not be read. */
  readonly detail?: string;
}

/** Thrown inside a check when the data it needs could not be read with the token in use. */
class Unreadable extends Error {}

type Record_ = Record<string, unknown>;

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().every((value, i) => value === [...b].sort()[i]);

const describe = (value: unknown): string => JSON.stringify(value);

export function checkSettings(expected: ExpectedSettings, collected: Collected): CheckResult[] {
  const repo = expected.repository;
  const org = expected.organization;

  /** The data GitHub returned for `path`, or `Unreadable` when the token may not read it. */
  const data = (path: string): unknown => {
    const entry = Object.entries(collected.endpoints).find(
      ([key]) => key === path || key.startsWith(`${path}?`),
    )?.[1];
    if (entry === undefined || !entry.ok) {
      throw new Unreadable(`GET ${path}`);
    }
    return entry.data;
  };
  /** A field that GitHub returns only to an administrator, and otherwise leaves out or null. */
  const adminField = (record: Record_, field: string, path: string): unknown => {
    const value = record[field];
    if (value === undefined || value === null) {
      throw new Unreadable(`${field} of GET ${path}`);
    }
    return value;
  };
  const branchRules = () =>
    data(`repos/${repo}/rules/branches/${expected.defaultBranch}`) as {
      type: string;
      parameters?: Record_;
    }[];
  const mainRuleset = (): Record_ => {
    const list = data(`repos/${repo}/rulesets`) as { id: number; name: string }[];
    const listed = list.find((ruleset) => ruleset.name === expected.mainRuleset.name);
    if (listed === undefined) {
      throw new Error(`no ruleset named "${expected.mainRuleset.name}"`);
    }
    return data(`repos/${repo}/rulesets/${listed.id}`) as Record_;
  };

  const checks: [string, () => string | undefined][] = [
    [
      "pull requests on, and merging by squash with auto-merge only",
      () => {
        const path = `repos/${repo}`;
        const record = data(path) as Record_;
        const wrong = Object.entries(expected.repositorySettings)
          .map(([field, want]) => [field, adminField(record, field, path), want] as const)
          .filter(([, actual, want]) => actual !== want);
        return wrong.length === 0
          ? undefined
          : wrong.map(([field, actual, want]) => `${field} is ${actual}, not ${want}`).join("; ");
      },
    ],
    [
      "no one but the expected accounts can write to the repository",
      () => {
        const list = data(`repos/${repo}/collaborators`) as { login: string; role_name: string }[];
        const actual = Object.fromEntries(
          list
            .filter(
              (collaborator) =>
                collaborator.role_name !== "read" && collaborator.role_name !== "triage",
            )
            .map((collaborator) => [collaborator.login, collaborator.role_name]),
        );
        return sameEntries(actual, expected.collaborators)
          ? undefined
          : `write access or more: ${describe(actual)}, expected ${describe(expected.collaborators)}`;
      },
    ],
    [
      "the organization's owners are exactly the admin accounts",
      () => {
        const owners = (data(`orgs/${org}/members`) as { login: string }[]).map((m) => m.login);
        return sameSet(owners, expected.organizationOwners)
          ? undefined
          : `owners are ${describe(owners)}, expected ${describe(expected.organizationOwners)}`;
      },
    ],
    [
      "each team has exactly its members",
      () => {
        const wrong = Object.entries(expected.teams)
          .map(([slug, team]) => {
            const members = (data(`orgs/${org}/teams/${slug}/members`) as { login: string }[]).map(
              (m) => m.login,
            );
            return sameSet(members, team.members)
              ? undefined
              : `${slug} has ${describe(members)}, expected ${describe(team.members)}`;
          })
          .filter((line): line is string => line !== undefined);
        return wrong.length === 0 ? undefined : wrong.join("; ");
      },
    ],
    [
      "each team has exactly its permission on the repository, and no other team has any",
      () => {
        const list = data(`repos/${repo}/teams`) as { slug: string; permission: string }[];
        const actual = Object.fromEntries(list.map((team) => [team.slug, team.permission]));
        const want = Object.fromEntries(
          Object.entries(expected.teams).map(([slug, team]) => [slug, team.permission]),
        );
        return sameEntries(actual, want)
          ? undefined
          : `teams are ${describe(actual)}, expected ${describe(want)}`;
      },
    ],
    [
      "CODEOWNERS is valid: every owner it names is recognized",
      () => {
        const { errors } = data(`repos/${repo}/codeowners/errors`) as { errors: unknown[] };
        return errors.length === 0 ? undefined : `${errors.length} error(s): ${describe(errors)}`;
      },
    ],
    [
      "main takes no deletion and no force-push",
      () => {
        const types = branchRules().map((rule) => rule.type);
        const missing = ["deletion", "non_fast_forward"].filter(
          (type) => expected.branchRules[type as "deletion"] && !types.includes(type),
        );
        return missing.length === 0 ? undefined : `missing rule(s): ${missing.join(", ")}`;
      },
    ],
    [
      "main takes pull requests only, with the code owners' approval, and a new push voids it",
      () => {
        const rule = branchRules().find((r) => r.type === "pull_request");
        if (rule === undefined) {
          return "no pull_request rule on main";
        }
        const wrong = Object.entries(expected.branchRules.pull_request).filter(
          ([field, want]) => rule.parameters?.[field] !== want,
        );
        return wrong.length === 0
          ? undefined
          : wrong
              .map(([field, want]) => `${field} is ${rule.parameters?.[field]}, not ${want}`)
              .join("; ");
      },
    ],
    [
      "main takes only what the four CI jobs passed, as reported by GitHub Actions",
      () => {
        const rule = branchRules().find((r) => r.type === "required_status_checks");
        if (rule === undefined) {
          return "no required_status_checks rule on main";
        }
        const actual = (rule.parameters?.required_status_checks ?? []) as {
          context: string;
          integration_id?: number;
        }[];
        const key = (c: { context: string; integration_id?: number }) =>
          `${c.context}@${c.integration_id}`;
        const strict = rule.parameters?.strict_required_status_checks_policy;
        const problems = [
          ...(sameSet(actual.map(key), expected.branchRules.required_status_checks.map(key))
            ? []
            : [
                `checks are ${describe(actual.map(key))}, expected ${describe(expected.branchRules.required_status_checks.map(key))}`,
              ]),
          ...(strict === expected.branchRules.strict_required_status_checks_policy
            ? []
            : [`strict_required_status_checks_policy is ${strict}`]),
        ];
        return problems.length === 0 ? undefined : problems.join("; ");
      },
    ],
    [
      "the main ruleset is active and applies to the default branch",
      () => {
        const ruleset = mainRuleset();
        const problems: string[] = [];
        if (ruleset.enforcement !== expected.mainRuleset.enforcement) {
          problems.push(`enforcement is ${ruleset.enforcement}`);
        }
        const include = (
          (ruleset.conditions as Record_ | undefined)?.ref_name as Record_ | undefined
        )?.include as string[] | undefined;
        if (!sameSet(include ?? [], expected.mainRuleset.include)) {
          problems.push(`applies to ${describe(include)}`);
        }
        return problems.length === 0 ? undefined : problems.join("; ");
      },
    ],
    [
      "only the admins and ci teams may bypass the main ruleset",
      () => {
        const bypass = adminField(
          mainRuleset(),
          "bypass_actors",
          `repos/${repo}/rulesets/{id}`,
        ) as {
          actor_id: number;
          actor_type: string;
          bypass_mode: string;
        }[];
        const actual = bypass.map((b) => `${b.actor_type}:${b.actor_id}:${b.bypass_mode}`);
        const want = expected.mainRuleset.bypass.map(
          (b) => `Team:${expected.teams[b.team]?.id}:${b.mode}`,
        );
        return sameSet(actual, want)
          ? undefined
          : `bypass is ${describe(actual)}, expected ${describe(want)}`;
      },
    ],
    [
      "GitHub Actions is on, its token only reads, and it cannot approve pull requests",
      () => {
        const actions = data(`repos/${repo}/actions/permissions`) as Record_;
        const workflow = data(`repos/${repo}/actions/permissions/workflow`) as Record_;
        const problems = [
          ...(actions.enabled === expected.actions.enabled
            ? []
            : [`enabled is ${actions.enabled}`]),
          ...(workflow.default_workflow_permissions ===
          expected.actions.default_workflow_permissions
            ? []
            : [`default_workflow_permissions is ${workflow.default_workflow_permissions}`]),
          ...(workflow.can_approve_pull_request_reviews ===
          expected.actions.can_approve_pull_request_reviews
            ? []
            : [`can_approve_pull_request_reviews is ${workflow.can_approve_pull_request_reviews}`]),
        ];
        return problems.length === 0 ? undefined : problems.join("; ");
      },
    ],
    [
      "a pull request from outside the teams runs no workflow before someone approves it",
      () => {
        const { approval_policy } = data(
          `repos/${repo}/actions/permissions/fork-pr-contributor-approval`,
        ) as Record_;
        return approval_policy === expected.actions.fork_pr_approval_policy
          ? undefined
          : `approval_policy is ${approval_policy}, not ${expected.actions.fork_pr_approval_policy}`;
      },
    ],
  ];

  return checks.map(([name, run]) => {
    try {
      const detail = run();
      return detail === undefined ? { name, outcome: "pass" } : { name, outcome: "fail", detail };
    } catch (error) {
      if (error instanceof Unreadable) {
        return { name, outcome: "not-checked", detail: `could not read ${error.message}` };
      }
      return {
        name,
        outcome: "fail",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

function sortKeys(record: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function sameEntries(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  return describe(sortKeys(a)) === describe(sortKeys(b));
}

/**
 * `<collected.json> [--require-admin]`. Exits 1 on any failed check, and — with
 * `--require-admin` — on any check that could not be made; otherwise a check not made is a
 * warning (a GitHub Actions annotation when run there).
 */
export function main(repoRoot: string, args: readonly string[]): number {
  const collectedPath = args.find((arg) => !arg.startsWith("--"));
  if (collectedPath === undefined) {
    console.error("usage: repo-settings <collected.json> [--require-admin]");
    return 2;
  }
  const requireAdmin = args.includes("--require-admin");
  const expected = JSON.parse(
    readFileSync(`${repoRoot}/.github/repository-settings.json`, "utf8"),
  ) as ExpectedSettings;
  const collected = JSON.parse(readFileSync(collectedPath, "utf8")) as Collected;
  const results = checkSettings(expected, collected);
  const inActions = process.env.GITHUB_ACTIONS === "true";

  for (const result of results) {
    const mark = result.outcome === "pass" ? "✓" : result.outcome === "fail" ? "✗" : "⚠";
    console.log(`${mark} ${result.name}${result.detail ? ` — ${result.detail}` : ""}`);
  }
  const failed = results.filter((r) => r.outcome === "fail");
  const notChecked = results.filter((r) => r.outcome === "not-checked");
  if (notChecked.length > 0) {
    const message =
      `${notChecked.length} of ${results.length} checks could not be made with this token; ` +
      "run the full check by hand as the admin or CI role (docs/repository-settings.md).";
    console.log(inActions && !requireAdmin ? `::warning::${message}` : `\n${message}`);
  }
  if (failed.length > 0) {
    console.error(
      `\nrepo-settings: ${failed.length} check(s) failed — the repository is not configured as .github/repository-settings.json says.`,
    );
    return 1;
  }
  if (requireAdmin && notChecked.length > 0) {
    console.error("\nrepo-settings: --require-admin, but not every check could be made.");
    return 1;
  }
  console.log(
    notChecked.length === 0
      ? "\nrepo-settings: every check passed."
      : `\nrepo-settings: ${results.length - notChecked.length} check(s) passed, ${notChecked.length} not made.`,
  );
  return 0;
}
