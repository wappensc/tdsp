import { readFileSync } from "node:fs";

/**
 * The license policy: which licenses this repository accepts without asking, and which
 * packages the CI role has approved despite a license outside that list. It lives in
 * `license-policy.json`, a file only the CI role may change (.github/CODEOWNERS), apart from
 * `third-party-licenses.json`, the inventory every developer keeps current. So a developer
 * can record a new dependency, but cannot widen what is accepted: a copyleft, commercial or
 * unknown license fails the check until the CI role approves that one package.
 */

/**
 * Where a package is used. An approval for `distributed` use covers `development` use too;
 * `external` is for programs a bridge runs as a separate process, outside the npm graph.
 */
export type LicenseScope = "distributed" | "development" | "external";

export interface Approval {
  /** An exact package name, or a prefix ending in `*` (`lightningcss*`) for platform builds. */
  readonly package: string;
  /** The license exactly as the package declares it; a change of license voids the approval. */
  readonly license: string;
  readonly scope: LicenseScope;
  /** Why it is acceptable — what a reviewer checked. */
  readonly reason: string;
}

export interface LicensePolicy {
  readonly allowedLicenses: readonly string[];
  readonly approvals: readonly Approval[];
}

/** How a package without any license declaration is named in an approval. */
export const NO_LICENSE = "(none)";

/**
 * Whether an SPDX expression is acceptable under `allowed` alone. Only the forms that can be
 * judged without a full SPDX parser are: a single identifier, `A OR B …` (acceptable when any
 * alternative is — the licensee may choose it), and `A AND B …` (when every part is), each
 * optionally in one pair of parentheses. Anything else — `WITH` exceptions, nested or mixed
 * operators — is not judged here and needs an approval.
 */
export function isAllowedExpression(expression: string, allowed: readonly string[]): boolean {
  let text = expression.trim();
  if (text.startsWith("(") && text.endsWith(")")) {
    text = text.slice(1, -1).trim();
  }
  if (/[()]/.test(text) || /\sWITH\s/i.test(text)) {
    return false;
  }
  const hasOr = /\sOR\s/.test(text);
  const hasAnd = /\sAND\s/.test(text);
  if (hasOr && hasAnd) {
    return false;
  }
  if (hasOr) {
    return text.split(/\s+OR\s+/).some((part) => allowed.includes(part));
  }
  if (hasAnd) {
    return text.split(/\s+AND\s+/).every((part) => allowed.includes(part));
  }
  return allowed.includes(text);
}

function nameMatches(pattern: string, name: string): boolean {
  return pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : pattern === name;
}

function scopeCovers(approved: LicenseScope, used: LicenseScope): boolean {
  return approved === used || (approved === "distributed" && used === "development");
}

export function findApproval(
  name: string,
  license: string,
  scope: LicenseScope,
  policy: LicensePolicy,
): Approval | undefined {
  return policy.approvals.find(
    (approval) =>
      approval.license === license &&
      nameMatches(approval.package, name) &&
      scopeCovers(approval.scope, scope),
  );
}

export interface LicensedThing {
  readonly name: string;
  readonly version: string;
  readonly license: string | null;
}

/** `undefined` when the policy accepts `thing` for `scope`; otherwise the violation to report. */
export function licenseVerdict(
  thing: LicensedThing,
  scope: LicenseScope,
  policy: LicensePolicy,
): string | undefined {
  const license = thing.license ?? NO_LICENSE;
  if (license !== NO_LICENSE && isAllowedExpression(license, policy.allowedLicenses)) {
    return undefined;
  }
  if (findApproval(thing.name, license, scope, policy) !== undefined) {
    return undefined;
  }
  return (
    `${thing.name}@${thing.version}: license "${license}" is neither allowed nor approved for ` +
    `${scope} use — a copyleft, commercial or unknown license needs the CI role's approval in ` +
    "license-policy.json"
  );
}

/** Approvals that no longer match anything in use: kept, they would silently admit a return. */
export function staleApprovals(
  policy: LicensePolicy,
  used: readonly { readonly thing: LicensedThing; readonly scope: LicenseScope }[],
): string[] {
  return policy.approvals
    .filter(
      (approval) =>
        !used.some(
          ({ thing, scope }) =>
            approval.license === (thing.license ?? NO_LICENSE) &&
            nameMatches(approval.package, thing.name) &&
            scopeCovers(approval.scope, scope),
        ),
    )
    .map(
      (approval) =>
        `license-policy.json approves ${approval.package} under "${approval.license}" ` +
        `(${approval.scope}), but nothing in use matches it any more — remove the stale approval`,
    );
}

export function loadPolicy(repoRoot: string): LicensePolicy {
  return JSON.parse(readFileSync(`${repoRoot}/license-policy.json`, "utf8")) as LicensePolicy;
}
