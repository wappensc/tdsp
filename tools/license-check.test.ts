import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkAgainstManifest,
  checkDevelopmentLicenses,
  collectDevelopmentDependencies,
  collectProductionDependencies,
  type LicenseManifest,
  loadManifest,
  type PackageInfo,
} from "./license-check.ts";
import { type LicensePolicy, loadPolicy } from "./license-policy.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

const POLICY: LicensePolicy = { allowedLicenses: ["MIT", "Apache-2.0"], approvals: [] };

const CLEAN_MANIFEST: LicenseManifest = {
  packages: [{ name: "left-pad", version: "1.0.0", license: "MIT" }],
  external: [],
};

const CLEAN_ACTUAL: PackageInfo[] = [
  { name: "left-pad", version: "1.0.0", license: "MIT", source: null },
];

/**
 * `checkAgainstManifest`'s own test discipline mirrors
 * `netcheck.test.ts`'s: most of what follows are violation fixtures, not
 * happy paths, because an invariant check is worth nothing unless it can
 * demonstrably fail.
 */
describe("checkAgainstManifest", () => {
  it("passes when the resolved tree exactly matches the manifest", () => {
    expect(checkAgainstManifest(CLEAN_ACTUAL, CLEAN_MANIFEST, POLICY)).toEqual([]);
  });

  it("flags a resolved dependency the manifest has never seen", () => {
    const actual: PackageInfo[] = [
      ...CLEAN_ACTUAL,
      { name: "new-dep", version: "2.0.0", license: "MIT", source: null },
    ];
    const violations = checkAgainstManifest(actual, CLEAN_MANIFEST, POLICY);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("new-dep@2.0.0");
    expect(violations[0]).toContain("not recorded");
  });

  /**
   * The property THIRD-PARTY-NOTICES.md documents as non-bypassable:
   * recording a brand-new copyleft dependency (silencing "not recorded")
   * must not be a one-step fix — only the CI role's approval is. Both violations have to appear in the
   * very same run, not just on a second run after it's been recorded —
   * otherwise "add an entry and re-run" would look like it worked right
   * up until the allowlist check, which is exactly the false sense of
   * completion this test rules out.
   */
  it("flags a brand-new dependency on both counts at once when its license isn't allowed", () => {
    const actual: PackageInfo[] = [
      ...CLEAN_ACTUAL,
      { name: "gpl-dep", version: "1.0.0", license: "GPL-3.0-only", source: null },
    ];
    const violations = checkAgainstManifest(actual, CLEAN_MANIFEST, POLICY);
    expect(violations.some((v) => v.includes("gpl-dep@1.0.0") && v.includes("not recorded"))).toBe(
      true,
    );
    expect(
      violations.some(
        (v) =>
          v.includes("gpl-dep") &&
          v.includes('license "GPL-3.0-only" is neither allowed nor approved for distributed use'),
      ),
    ).toBe(true);
  });

  it("flags a manifest entry that no longer resolves at all (stale)", () => {
    const violations = checkAgainstManifest([], CLEAN_MANIFEST, POLICY);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("left-pad");
    expect(violations[0]).toContain("no longer a resolved production dependency");
  });

  it("flags a license that changed since it was recorded", () => {
    const actual: PackageInfo[] = [
      { name: "left-pad", version: "1.0.0", license: "GPL-3.0", source: null },
    ];
    const violations = checkAgainstManifest(actual, CLEAN_MANIFEST, POLICY);
    expect(
      violations.some((v) => v.includes('recorded license "MIT"') && v.includes('"GPL-3.0"')),
    ).toBe(true);
  });

  it("flags a version bump even when the license stayed the same", () => {
    const actual: PackageInfo[] = [
      { name: "left-pad", version: "1.1.0", license: "MIT", source: null },
    ];
    const violations = checkAgainstManifest(actual, CLEAN_MANIFEST, POLICY);
    expect(
      violations.some((v) => v.includes('recorded version "1.0.0"') && v.includes('"1.1.0"')),
    ).toBe(true);
  });

  it("flags a recorded license that has since fallen off the allowlist", () => {
    const policy: LicensePolicy = { ...POLICY, allowedLicenses: ["Apache-2.0"] }; // MIT removed
    const violations = checkAgainstManifest(CLEAN_ACTUAL, CLEAN_MANIFEST, policy);
    expect(
      violations.some((v) => v.includes('license "MIT" is neither allowed nor approved')),
    ).toBe(true);
  });

  it("accepts a dual-licensed dependency when one of its options is allowed, with nothing elected by hand", () => {
    const manifest: LicenseManifest = {
      ...CLEAN_MANIFEST,
      packages: [
        ...CLEAN_MANIFEST.packages,
        { name: "dual-dep", version: "1.0.0", license: "(MIT OR EUPL-1.1+)" },
      ],
    };
    const actual: PackageInfo[] = [
      ...CLEAN_ACTUAL,
      { name: "dual-dep", version: "1.0.0", license: "(MIT OR EUPL-1.1+)", source: null },
    ];
    expect(checkAgainstManifest(actual, manifest, POLICY)).toEqual([]);
  });

  it("flags a dual license that narrows to its copyleft option, on both counts", () => {
    const manifest: LicenseManifest = {
      ...CLEAN_MANIFEST,
      packages: [
        ...CLEAN_MANIFEST.packages,
        { name: "dual-dep", version: "1.0.0", license: "(MIT OR EUPL-1.1+)" },
      ],
    };
    const actual: PackageInfo[] = [
      ...CLEAN_ACTUAL,
      { name: "dual-dep", version: "1.0.0", license: "EUPL-1.1+", source: null },
    ];
    const violations = checkAgainstManifest(actual, manifest, POLICY);
    expect(
      violations.some(
        (v) => v.includes('recorded license "(MIT OR EUPL-1.1+)"') && v.includes('"EUPL-1.1+"'),
      ),
    ).toBe(true);
    expect(violations.some((v) => v.includes('license "EUPL-1.1+" is neither allowed'))).toBe(true);
  });

  it("accepts a copyleft dependency the CI role approved, and only under that license", () => {
    const manifest: LicenseManifest = {
      ...CLEAN_MANIFEST,
      packages: [
        ...CLEAN_MANIFEST.packages,
        { name: "gpl-dep", version: "1.0.0", license: "GPL-3.0-only" },
      ],
    };
    const policy: LicensePolicy = {
      ...POLICY,
      approvals: [
        { package: "gpl-dep", license: "GPL-3.0-only", scope: "distributed", reason: "reviewed" },
      ],
    };
    const approved = [
      ...CLEAN_ACTUAL,
      { name: "gpl-dep", version: "1.0.0", license: "GPL-3.0-only", source: null },
    ];
    expect(checkAgainstManifest(approved, manifest, policy)).toEqual([]);
    const relicensed = [
      ...CLEAN_ACTUAL,
      { name: "gpl-dep", version: "1.0.0", license: "AGPL-3.0-only", source: null },
    ];
    expect(
      checkAgainstManifest(relicensed, manifest, policy).some((v) =>
        v.includes('license "AGPL-3.0-only" is neither allowed nor approved'),
      ),
    ).toBe(true);
  });

  it("flags a resolved package with no license at all, as needing approval", () => {
    const actual: PackageInfo[] = [
      { name: "left-pad", version: "1.0.0", license: null, source: null },
    ];
    const violations = checkAgainstManifest(actual, CLEAN_MANIFEST, POLICY);
    expect(violations.some((v) => v.includes('license "(none)" is neither allowed'))).toBe(true);
  });

  it("requires the CI role's approval for an external program's copyleft license", () => {
    const manifest: LicenseManifest = {
      ...CLEAN_MANIFEST,
      external: [
        {
          name: "some-tool",
          version: "1.0",
          license: "GPL-3.0-only",
          source: "https://example.org",
          distribution: "run as a separate process",
        },
      ],
    };
    expect(
      checkAgainstManifest(CLEAN_ACTUAL, manifest, POLICY).some((v) =>
        v.includes(
          'some-tool@1.0: license "GPL-3.0-only" is neither allowed nor approved for external use',
        ),
      ),
    ).toBe(true);
    const policy: LicensePolicy = {
      ...POLICY,
      approvals: [
        { package: "some-tool", license: "GPL-3.0-only", scope: "external", reason: "reviewed" },
      ],
    };
    expect(checkAgainstManifest(CLEAN_ACTUAL, manifest, policy)).toEqual([]);
  });

  it("flags an external component missing a required field", () => {
    const manifest: LicenseManifest = {
      ...CLEAN_MANIFEST,
      external: [
        {
          name: "some-tool",
          version: "1.0",
          license: "GPL-3.0-only",
          source: "",
          distribution: "bundled",
        },
      ],
    };
    const violations = checkAgainstManifest(CLEAN_ACTUAL, manifest, POLICY);
    expect(
      violations.some((v) => v.includes("some-tool") && v.includes("missing a required field")),
    ).toBe(true);
  });
});

/**
 * `collectProductionDependencies` is deliberately exercised against this
 * repository's own real, installed dependency tree rather than a
 * synthetic fixture — the same "the repository itself" discipline
 * `netcheck.test.ts` uses. One of these assertions pins a trap of pnpm's
 * non-flat `node_modules` layout: a dependency's own further dependencies
 * are found only from its *real* (symlink-resolved) path (`yjs` → `lib0`).
 */
describe("collectProductionDependencies — the repository itself", () => {
  const actual = collectProductionDependencies(repoRoot);
  const byName = new Map(actual.map((p) => [p.name, p]));

  it("finds a reasonable number of distributed production dependencies", () => {
    expect(actual.length).toBeGreaterThan(25);
  });

  it("finds yjs with the license its own LICENSE file declares", () => {
    expect(byName.get("yjs")).toMatchObject({ license: "MIT" });
  });

  it("finds the Matrix crypto binding used only by bridges/matrix-bridge", () => {
    expect(byName.get("@matrix-org/matrix-sdk-crypto-nodejs")).toMatchObject({
      license: "Apache-2.0",
    });
  });

  it("resolves yjs's own further dependency lib0, not just yjs itself", () => {
    expect(byName.has("lib0")).toBe(true);
    expect(byName.has("isomorphic.js")).toBe(true);
  });

  it("never includes a development-only dependency (e.g. vitest)", () => {
    expect(byName.has("vitest")).toBe(false);
  });

  it("never includes this repo's own workspace packages", () => {
    for (const name of byName.keys()) {
      expect(name.startsWith("@tdsp/")).toBe(false);
    }
  });
});

/**
 * Two shapes real packages take that `require.resolve` cannot handle, in a synthetic workspace:
 * a package that declares no root `"."` export (only subpaths), and one reachable only through
 * another package's `peerDependencies`.
 */
describe("collectProductionDependencies — packages require.resolve cannot find", () => {
  it("finds a package with no root export, and one reached only as a peer dependency", () => {
    const root = mkdtempSync(path.join(tmpdir(), "license-check-shapes-"));
    try {
      const write = (file: string, json: object) => {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        writeFileSync(path.join(root, file), JSON.stringify(json));
      };
      write("packages/app/package.json", {
        name: "app",
        dependencies: { "subpaths-only": "1.0.0" },
      });
      write("node_modules/subpaths-only/package.json", {
        name: "subpaths-only",
        version: "1.0.0",
        license: "MIT",
        exports: { "./model": "./model.js" },
        peerDependencies: { "peer-only": "*" },
      });
      write("node_modules/peer-only/package.json", {
        name: "peer-only",
        version: "2.0.0",
        license: "ISC",
      });
      const names = collectProductionDependencies(root).map((p) => `${p.name}@${p.version}`);
      expect(names).toEqual(["peer-only@2.0.0", "subpaths-only@1.0.0"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("checkDevelopmentLicenses", () => {
  it("holds development-only dependencies to the policy, without an inventory", () => {
    const dev: PackageInfo[] = [
      { name: "test-runner", version: "1.0.0", license: "MIT", source: null },
      { name: "css-tool", version: "1.0.0", license: "MPL-2.0", source: null },
    ];
    expect(checkDevelopmentLicenses(dev, POLICY)).toEqual([
      expect.stringContaining(
        'css-tool@1.0.0: license "MPL-2.0" is neither allowed nor approved for development use',
      ),
    ]);
    const policy: LicensePolicy = {
      ...POLICY,
      approvals: [
        { package: "css-tool*", license: "MPL-2.0", scope: "development", reason: "test only" },
      ],
    };
    expect(checkDevelopmentLicenses(dev, policy)).toEqual([]);
  });
});

describe("the repository itself", () => {
  it("holds today: every resolved dependency is recorded, licensed as expected, and allowed or approved", () => {
    const manifest = loadManifest(repoRoot);
    const policy = loadPolicy(repoRoot);
    const actual = collectProductionDependencies(repoRoot);
    expect(checkAgainstManifest(actual, manifest, policy)).toEqual([]);
    expect(checkDevelopmentLicenses(collectDevelopmentDependencies(repoRoot), policy)).toEqual([]);
  });

  it("walks the development tree too: vitest, but none of the workspace's own packages", () => {
    const names = new Set(collectDevelopmentDependencies(repoRoot).map((p) => p.name));
    expect(names.has("vitest")).toBe(true);
    expect([...names].some((name) => name.startsWith("@tdsp/"))).toBe(false);
  });
});
