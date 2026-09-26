import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkAgainstManifest,
  collectProductionDependencies,
  type LicenseManifest,
  loadManifest,
  type PackageInfo,
} from "./license-check.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

const CLEAN_MANIFEST: LicenseManifest = {
  allowedLicenses: ["MIT", "Apache-2.0"],
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
    expect(checkAgainstManifest(CLEAN_ACTUAL, CLEAN_MANIFEST)).toEqual([]);
  });

  it("flags a resolved dependency the manifest has never seen", () => {
    const actual: PackageInfo[] = [
      ...CLEAN_ACTUAL,
      { name: "new-dep", version: "2.0.0", license: "MIT", source: null },
    ];
    const violations = checkAgainstManifest(actual, CLEAN_MANIFEST);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("new-dep@2.0.0");
    expect(violations[0]).toContain("not recorded");
  });

  /**
   * The property THIRD-PARTY-NOTICES.md documents as non-bypassable:
   * recording a brand-new copyleft dependency (silencing "not recorded")
   * must not be a one-step fix. Both violations have to appear in the
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
    const violations = checkAgainstManifest(actual, CLEAN_MANIFEST);
    expect(violations.some((v) => v.includes("gpl-dep@1.0.0") && v.includes("not recorded"))).toBe(
      true,
    );
    expect(
      violations.some(
        (v) =>
          v.includes("gpl-dep") && v.includes('license "GPL-3.0-only" is not in allowedLicenses'),
      ),
    ).toBe(true);
  });

  it("flags a manifest entry that no longer resolves at all (stale)", () => {
    const violations = checkAgainstManifest([], CLEAN_MANIFEST);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("left-pad");
    expect(violations[0]).toContain("no longer a resolved production dependency");
  });

  it("flags a license that changed since it was recorded", () => {
    const actual: PackageInfo[] = [
      { name: "left-pad", version: "1.0.0", license: "GPL-3.0", source: null },
    ];
    const violations = checkAgainstManifest(actual, CLEAN_MANIFEST);
    expect(
      violations.some((v) => v.includes('recorded license "MIT"') && v.includes('"GPL-3.0"')),
    ).toBe(true);
  });

  it("flags a version bump even when the license stayed the same", () => {
    const actual: PackageInfo[] = [
      { name: "left-pad", version: "1.1.0", license: "MIT", source: null },
    ];
    const violations = checkAgainstManifest(actual, CLEAN_MANIFEST);
    expect(
      violations.some((v) => v.includes('recorded version "1.0.0"') && v.includes('"1.1.0"')),
    ).toBe(true);
  });

  it("flags a recorded license that has since fallen off the allowlist", () => {
    const manifest: LicenseManifest = {
      ...CLEAN_MANIFEST,
      allowedLicenses: ["Apache-2.0"], // MIT removed
    };
    const violations = checkAgainstManifest(CLEAN_ACTUAL, manifest);
    expect(violations.some((v) => v.includes('license "MIT" is not in allowedLicenses'))).toBe(
      true,
    );
  });

  /**
   * A dual-licensed dependency (e.g. `"(MIT OR EUPL-1.1+)"`) is checked
   * against the allowlist using its *elected* license, not the full
   * SPDX expression — so `allowedLicenses` never has to name the
   * copyleft half of the offer just to admit the permissive one.
   */
  it("checks a dual-licensed dependency's elected license against the allowlist, not its full SPDX expression", () => {
    const manifest: LicenseManifest = {
      ...CLEAN_MANIFEST,
      packages: [
        ...CLEAN_MANIFEST.packages,
        {
          name: "dual-dep",
          version: "1.0.0",
          license: "(MIT OR EUPL-1.1+)",
          electedLicense: "MIT",
        },
      ],
    };
    const actual: PackageInfo[] = [
      ...CLEAN_ACTUAL,
      { name: "dual-dep", version: "1.0.0", license: "(MIT OR EUPL-1.1+)", source: null },
    ];
    expect(checkAgainstManifest(actual, manifest)).toEqual([]);
  });

  it("still flags a dual-licensed dependency's raw license drifting, even with an electedLicense recorded", () => {
    const manifest: LicenseManifest = {
      ...CLEAN_MANIFEST,
      packages: [
        ...CLEAN_MANIFEST.packages,
        {
          name: "dual-dep",
          version: "1.0.0",
          license: "(MIT OR EUPL-1.1+)",
          electedLicense: "MIT",
        },
      ],
    };
    // The upstream package narrowed its own offer to EUPL alone — the
    // elected-license override must not mask that from the drift check.
    const actual: PackageInfo[] = [
      ...CLEAN_ACTUAL,
      { name: "dual-dep", version: "1.0.0", license: "EUPL-1.1+", source: null },
    ];
    const violations = checkAgainstManifest(actual, manifest);
    expect(
      violations.some(
        (v) => v.includes('recorded license "(MIT OR EUPL-1.1+)"') && v.includes('"EUPL-1.1+"'),
      ),
    ).toBe(true);
  });

  it("flags a resolved package with no license field at all, even if it happens to be recorded", () => {
    const actual: PackageInfo[] = [
      { name: "left-pad", version: "1.0.0", license: null, source: null },
    ];
    const violations = checkAgainstManifest(actual, CLEAN_MANIFEST);
    expect(violations.some((v) => v.includes("no license field at all"))).toBe(true);
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
    const violations = checkAgainstManifest(CLEAN_ACTUAL, manifest);
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

describe("the repository itself", () => {
  it("holds today: every resolved dependency is recorded, licensed as expected, and allowed", () => {
    const manifest = loadManifest(repoRoot);
    const actual = collectProductionDependencies(repoRoot);
    expect(checkAgainstManifest(actual, manifest)).toEqual([]);
  });
});
