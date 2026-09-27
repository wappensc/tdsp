import { existsSync, globSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  type LicensePolicy,
  licenseVerdict,
  loadPolicy,
  NO_LICENSE,
  staleApprovals,
} from "./license-policy.ts";

/**
 * Automates what a person would otherwise have to remember
 * (`THIRD-PARTY-NOTICES.md`): walk the real, resolved production
 * dependency tree of every distributed workspace member, and compare it
 * against `third-party-licenses.json`'s checked-in record. A mismatch — a
 * new dependency, a changed license, a stale entry — fails loudly instead
 * of silently drifting from what `THIRD-PARTY-NOTICES.md` documents. Every
 * license, of distributed, development-only and external dependencies
 * alike, must also pass the CI role's policy (`license-policy.ts`).
 *
 * **Why plain Node module resolution instead of `pnpm licenses list` or
 * hand-parsing `pnpm-lock.yaml`.** Both were considered and rejected.
 * `pnpm licenses list --json`'s output shape is a pnpm-CLI-version-specific
 * format this tool would then depend on, unverifiable against a real
 * `pnpm` binary in every environment. Hand-parsing `pnpm-lock.yaml` would
 * mean writing a bespoke YAML-subset parser — this repository already
 * avoids adding a YAML dependency purely to read `.github/workflows/ci.yml`
 * (`tools/netcheck-wiring.test.ts`'s own comment), so parsing the far more
 * complex lockfile format would cut against that precedent harder still.
 * `createRequire(...).resolve()` uses Node's own, stable module-resolution
 * algorithm — the exact mechanism that actually loads each module at
 * runtime — and reading each resolved package's own `package.json` is
 * exactly what a person checking by hand would do.
 *
 * **Why `peerDependencies` are walked too, not just `dependencies`.**
 * A package can reach an application only as another package's peer
 * dependency, satisfied by pnpm's own resolution (a Yjs editor binding
 * pulling in `y-protocols`, for example) — a `dependencies`-only walk
 * misses it entirely. A peer
 * dependency that fails to resolve (a genuinely unmet, optional one) is
 * skipped silently; one that resolves is real, installed code and must be
 * counted the same as a regular dependency.
 */

export interface PackageInfo {
  readonly name: string;
  readonly version: string;
  readonly license: string | null;
  /** Repository/homepage URL, normalized; null when the package declares neither. */
  readonly source: string | null;
}

export interface RecordedPackage {
  readonly name: string;
  readonly version: string;
  /** Exactly as the package declares it; `(none)` for a package that declares nothing. */
  readonly license: string;
}

export interface ExternalComponent {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly source: string;
  readonly distribution: string;
}

/**
 * `third-party-licenses.json`: the inventory of what is used and under which license, kept
 * current by whoever changes a dependency. Which licenses are acceptable is not in it — that
 * is `license-policy.json`, the CI role's file (`license-policy.ts`).
 */
export interface LicenseManifest {
  readonly packages: readonly RecordedPackage[];
  readonly external: readonly ExternalComponent[];
}

/**
 * Workspace members whose declared dependencies actually ship to end
 * users — the packages, compiled into an application's browser bundle,
 * and the bridges, each run as a process of its own. Their
 * `devDependencies` never ship: `collectDevelopmentDependencies` walks those,
 * for the license policy only.
 */
export const DISTRIBUTED_PACKAGE_JSON_GLOBS = [
  "packages/*/package.json",
  "bridges/signal-bridge/package.json",
  "bridges/matrix-bridge/package.json",
  "bridges/email-bridge/package.json",
];

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function normalizeLicense(license: unknown): string | null {
  if (typeof license === "string") {
    return license;
  }
  if (license && typeof license === "object" && !Array.isArray(license)) {
    const type = (license as { type?: unknown }).type;
    return typeof type === "string" ? type : null;
  }
  if (Array.isArray(license) && license.length > 0) {
    const parts = license.map(normalizeLicense).filter((l): l is string => l !== null);
    return parts.length > 0 ? parts.join(" OR ") : null;
  }
  return null;
}

function normalizeSource(repository: unknown, homepage: unknown): string | null {
  let raw: string | null = null;
  if (typeof repository === "string") {
    raw = repository;
  } else if (repository && typeof repository === "object") {
    const url = (repository as { url?: unknown }).url;
    if (typeof url === "string") {
      raw = url;
    }
  }
  if (!raw && typeof homepage === "string") {
    raw = homepage;
  }
  if (!raw) {
    return null;
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) {
    raw = `https://github.com/${raw}`; // npm's "owner/repo" shorthand
  }
  return raw
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/\.git$/, "");
}

/**
 * Locates `name`'s package directory by walking `fromDir`'s ancestor
 * `node_modules` folders — Node's classic directory-resolution algorithm,
 * deliberately **not** `require.resolve(name)` or
 * `require.resolve(\`${name}/package.json\`)`. Both break on real
 * packages: one that declares no root `"."` export at all (every export
 * is a subpath like `./model`) makes `require.resolve(name)` throw
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` even though the package is right there
 * on disk; one that exposes a root export but not `./package.json` makes
 * resolving that subpath throw the same way. A package's `exports`
 * map governs which module specifiers may be *imported* from it — it has
 * no bearing on whether the package's directory, and the plain
 * `package.json` file inside it, exist on disk. Checking for that file
 * directly sidesteps the exports map entirely and works for every
 * package regardless of how narrow (or entirely absent) its root export
 * is.
 */
function findPackageDir(name: string, fromDir: string): string | null {
  let dir = fromDir;
  for (;;) {
    // Node's own NODE_MODULES_PATHS algorithm skips appending another
    // "node_modules" once already standing in a directory named that —
    // otherwise a package's *sibling* dependencies (pnpm's actual layout:
    // `.pnpm/yjs@x/node_modules/{yjs,lib0}` side by side) are missed,
    // naively appending "node_modules" at every level never finds `lib0`
    // from inside `.../node_modules/yjs`.
    if (path.basename(dir) !== "node_modules") {
      const candidate = path.join(dir, "node_modules", name);
      if (existsSync(path.join(candidate, "package.json"))) {
        return candidate;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null; // reached the filesystem root without finding one
    }
    dir = parent;
  }
}

function tryResolvePackageJson(name: string, fromDir: string): string | null {
  const dir = findPackageDir(name, fromDir);
  if (!dir) {
    return null;
  }
  // pnpm's non-flat node_modules means every found package directory is a
  // symlink. Resolving it now, not just when reading its package.json, is
  // what matters: recursing further using the *symlink's own* location
  // (inside whichever package declared this dependency) instead of its
  // real target directory makes pnpm's strict per-package node_modules
  // hide a dependency's own further dependencies: walking up from the
  // symlinked path never finds `yjs`'s own
  // `lib0` dependency, because pnpm deliberately does not expose it
  // anywhere along that path; only `yjs`'s real store location has `lib0`
  // as a sibling.
  return path.join(realpathSync(dir), "package.json");
}

/**
 * Walks the real, installed dependency graph from the given starting points, following
 * `dependencies`, `optionalDependencies` (platform builds are real, installed code) and
 * `peerDependencies` (see module comment) via Node's own resolution algorithm. Returns one
 * entry per distinct resolved `name@version`, sorted by name.
 */
function walkDependencies(
  roots: readonly { fromDir: string; names: readonly string[] }[],
): PackageInfo[] {
  const visited = new Map<string, PackageInfo>();

  const visit = (name: string, fromDir: string): void => {
    const pkgJsonPath = tryResolvePackageJson(name, fromDir);
    if (!pkgJsonPath) {
      return;
    }
    const pkg = readJson(pkgJsonPath);
    const pkgName = typeof pkg.name === "string" ? pkg.name : name;
    const pkgVersion = typeof pkg.version === "string" ? pkg.version : "0.0.0";
    const key = `${pkgName}@${pkgVersion}`;
    if (visited.has(key)) {
      return;
    }
    visited.set(key, {
      name: pkgName,
      version: pkgVersion,
      license: normalizeLicense(pkg.license),
      source: normalizeSource(pkg.repository, pkg.homepage),
    });

    const depDir = path.dirname(pkgJsonPath);
    for (const depName of new Set([
      ...Object.keys((pkg.dependencies ?? {}) as Record<string, string>),
      ...Object.keys((pkg.optionalDependencies ?? {}) as Record<string, string>),
      ...Object.keys((pkg.peerDependencies ?? {}) as Record<string, string>),
    ])) {
      visit(depName, depDir);
    }
  };

  for (const { fromDir, names } of roots) {
    for (const name of names) {
      visit(name, fromDir);
    }
  }
  return [...visited.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The third-party entries of one `package.json` field, skipping `workspace:*` links. */
function rootsFrom(
  repoRoot: string,
  globs: readonly string[],
  field: "dependencies" | "devDependencies",
): { fromDir: string; names: string[] }[] {
  const roots: { fromDir: string; names: string[] }[] = [];
  for (const glob of globs) {
    for (const relative of globSync(glob, { cwd: repoRoot })) {
      const pkgJsonPath = path.join(repoRoot, relative);
      const declared = (readJson(pkgJsonPath)[field] ?? {}) as Record<string, string>;
      roots.push({
        fromDir: path.dirname(pkgJsonPath),
        names: Object.entries(declared)
          .filter(([, specifier]) => !specifier.startsWith("workspace:"))
          .map(([name]) => name),
      });
    }
  }
  return roots;
}

/** Everything the distributed workspace members ship: their `dependencies`, transitively. */
export function collectProductionDependencies(repoRoot: string): PackageInfo[] {
  return walkDependencies(rootsFrom(repoRoot, DISTRIBUTED_PACKAGE_JSON_GLOBS, "dependencies"));
}

/**
 * Everything used only while developing and testing: the `devDependencies` of the root and
 * of every workspace member, transitively. Not distributed, so not in the inventory — but
 * held to the license policy all the same (`checkDevelopmentLicenses`).
 */
export function collectDevelopmentDependencies(repoRoot: string): PackageInfo[] {
  return walkDependencies(
    rootsFrom(
      repoRoot,
      ["package.json", "packages/*/package.json", "bridges/*/package.json"],
      "devDependencies",
    ),
  );
}

/**
 * Compares the real, resolved dependency set against the checked-in
 * manifest. An empty result means: every distributed dependency is
 * recorded, its license matches what's recorded, its license is on the
 * allowlist, and nothing recorded has since disappeared.
 */
export function checkAgainstManifest(
  actual: readonly PackageInfo[],
  manifest: LicenseManifest,
  policy: LicensePolicy,
): string[] {
  const violations: string[] = [];
  // Grouped by name, not `name@version`: two genuinely different,
  // simultaneously-resolved versions of one package name are real
  // (verified — `imapflow`'s own transitive tree resolves both
  // `nodemailer@7` (this project's own direct dependency) and
  // `nodemailer@10` (a `libmime`/`@zone-eu/mailsplit` requirement) at
  // once), so `packages` may record more than one entry per name.
  const recordedByName = new Map<string, RecordedPackage[]>();
  for (const entry of manifest.packages) {
    const existing = recordedByName.get(entry.name);
    if (existing) {
      existing.push(entry);
    } else {
      recordedByName.set(entry.name, [entry]);
    }
  }
  const seenKeys = new Set<string>();

  for (const pkg of actual) {
    seenKeys.add(`${pkg.name}@${pkg.version}`);
    const candidates = recordedByName.get(pkg.name) ?? [];
    const entry = candidates.find((c) => c.version === pkg.version);
    const declared = pkg.license ?? NO_LICENSE;
    if (!entry) {
      if (candidates.length === 1) {
        // The common case: one recorded version, a different one
        // installed — a version bump, diagnosed as such rather than as
        // "not recorded" (a more specific, more actionable message).
        violations.push(
          `${pkg.name}: recorded version "${candidates[0]?.version}" no longer matches the installed "${pkg.version}"`,
        );
      } else {
        // Either genuinely unrecorded, or a *third* simultaneously-
        // resolved version none of several recorded entries match —
        // either way, "which one does this replace?" has no single
        // answer, so it is reported as its own new entry to add.
        violations.push(
          `${pkg.name}@${pkg.version}: new production dependency, not recorded in third-party-licenses.json (license: ${declared})`,
        );
      }
    } else if (entry.license !== declared) {
      violations.push(
        `${pkg.name}: recorded license "${entry.license}" no longer matches the installed package's "${declared}"`,
      );
    }
    // Deliberately not part of the `!entry` branch above, and never
    // skipped via `continue`: a brand-new dependency that arrives with a
    // license the policy does not accept must fail on *both* counts in the
    // same run — "not recorded" alone would let recording it look like a
    // one-step fix, when only the CI role's approval is.
    const verdict = licenseVerdict(pkg, "distributed", policy);
    if (verdict !== undefined) {
      violations.push(verdict);
    }
  }

  for (const entry of manifest.packages) {
    if (!seenKeys.has(`${entry.name}@${entry.version}`)) {
      violations.push(
        `${entry.name}@${entry.version}: recorded in third-party-licenses.json but no longer a resolved production dependency — remove the stale entry`,
      );
    }
  }

  for (const external of manifest.external) {
    if (
      !external.name ||
      !external.version ||
      !external.license ||
      !external.source ||
      !external.distribution
    ) {
      violations.push(`external component missing a required field: ${JSON.stringify(external)}`);
      continue;
    }
    const verdict = licenseVerdict(external, "external", policy);
    if (verdict !== undefined) {
      violations.push(verdict);
    }
  }

  return violations;
}

/** Development-only dependencies are not inventoried, but held to the same policy. */
export function checkDevelopmentLicenses(
  actual: readonly PackageInfo[],
  policy: LicensePolicy,
): string[] {
  return actual
    .map((pkg) => licenseVerdict(pkg, "development", policy))
    .filter((verdict): verdict is string => verdict !== undefined);
}

export function loadManifest(repoRoot: string): LicenseManifest {
  return readJson(`${repoRoot}/third-party-licenses.json`) as unknown as LicenseManifest;
}

export function main(repoRoot: string): number {
  const manifest = loadManifest(repoRoot);
  const policy = loadPolicy(repoRoot);
  const actual = collectProductionDependencies(repoRoot);
  const development = collectDevelopmentDependencies(repoRoot);
  const violations = [
    ...checkAgainstManifest(actual, manifest, policy),
    ...checkDevelopmentLicenses(development, policy),
    ...staleApprovals(policy, [
      ...actual.map((thing) => ({ thing, scope: "distributed" as const })),
      ...development.map((thing) => ({ thing, scope: "development" as const })),
      ...manifest.external.map((thing) => ({ thing, scope: "external" as const })),
    ]),
  ];

  if (violations.length > 0) {
    console.error(`licenses:check: ${violations.length} issue(s) found:\n`);
    for (const violation of violations) {
      console.error(`  - ${violation}`);
    }
    console.error(
      "\nA new or changed dependency: record it in third-party-licenses.json (then run\n" +
        "`pnpm run licenses:generate` to refresh THIRD-PARTY-NOTICES.md). A license the policy\n" +
        "does not accept: only the CI role can approve it, in license-policy.json.\n",
    );
    return 1;
  }
  console.log(
    `licenses:check: ${actual.length} distributed and ${development.length} development ` +
      "dependencies, every license allowed or approved.",
  );
  return 0;
}
