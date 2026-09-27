import { describe, expect, it } from "vitest";
import {
  findApproval,
  isAllowedExpression,
  type LicensePolicy,
  licenseVerdict,
  staleApprovals,
} from "./license-policy.ts";

const ALLOWED = ["MIT", "Apache-2.0", "BSD-3-Clause"];

describe("which SPDX expressions the allowlist accepts on its own", () => {
  it.each([
    ["MIT", true],
    ["GPL-3.0-only", false],
    ["(MIT OR EUPL-1.1+)", true],
    ["MIT OR Apache-2.0", true],
    ["GPL-2.0-only OR LGPL-3.0-only", false],
    ["MIT AND BSD-3-Clause", true],
    ["MIT AND GPL-3.0-only", false],
    ["Apache-2.0 WITH LLVM-exception", false],
    ["(MIT OR GPL-3.0-only) AND BSD-3-Clause", false],
    ["MIT OR Apache-2.0 AND GPL-3.0-only", false],
    ["UNLICENSED", false],
    ["SEE LICENSE IN LICENSE.md", false],
  ])("%s → %s", (expression, accepted) => {
    expect(isAllowedExpression(expression, ALLOWED)).toBe(accepted);
  });
});

describe("approvals", () => {
  const policy: LicensePolicy = {
    allowedLicenses: ALLOWED,
    approvals: [
      { package: "gpl-lib", license: "GPL-3.0-only", scope: "distributed", reason: "r" },
      { package: "tool*", license: "MPL-2.0", scope: "development", reason: "r" },
      { package: "helper", license: "AGPL-3.0-only", scope: "external", reason: "r" },
      { package: "paid-sdk", license: "(none)", scope: "development", reason: "r" },
    ],
  };
  const thing = (name: string, license: string | null) => ({ name, version: "1.0.0", license });

  it("admit exactly the approved package under exactly the approved license", () => {
    expect(licenseVerdict(thing("gpl-lib", "GPL-3.0-only"), "distributed", policy)).toBeUndefined();
    expect(licenseVerdict(thing("gpl-lib", "GPL-3.0-or-later"), "distributed", policy)).toMatch(
      /neither allowed nor approved/,
    );
    expect(licenseVerdict(thing("other-lib", "GPL-3.0-only"), "distributed", policy)).toMatch(
      /neither allowed nor approved/,
    );
  });

  it("match a trailing * as a name prefix, and nothing else as a pattern", () => {
    expect(findApproval("tool-linux-x64", "MPL-2.0", "development", policy)).toBeDefined();
    expect(findApproval("mytool", "MPL-2.0", "development", policy)).toBeUndefined();
  });

  it("cover their own scope; a distributed approval covers development, not the reverse", () => {
    expect(licenseVerdict(thing("gpl-lib", "GPL-3.0-only"), "development", policy)).toBeUndefined();
    expect(licenseVerdict(thing("tool", "MPL-2.0"), "distributed", policy)).toMatch(
      /approved for distributed use/,
    );
    expect(licenseVerdict(thing("helper", "AGPL-3.0-only"), "distributed", policy)).toMatch(
      /approved for distributed use/,
    );
  });

  it("name a package that declares no license as (none), which only an approval admits", () => {
    expect(licenseVerdict(thing("paid-sdk", null), "development", policy)).toBeUndefined();
    expect(licenseVerdict(thing("unknown", null), "development", policy)).toMatch(
      /license "\(none\)" is neither allowed nor approved/,
    );
  });

  it("are reported as stale when nothing in use matches them any more", () => {
    const used = [
      { thing: thing("gpl-lib", "GPL-3.0-only"), scope: "distributed" as const },
      { thing: thing("tool-darwin-arm64", "MPL-2.0"), scope: "development" as const },
    ];
    expect(staleApprovals(policy, used)).toEqual([
      expect.stringContaining("approves helper under"),
      expect.stringContaining("approves paid-sdk under"),
    ]);
  });
});
