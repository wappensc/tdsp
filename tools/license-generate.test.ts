import { describe, expect, it } from "vitest";
import type { LicenseManifest, PackageInfo } from "./license-check.ts";
import { renderExternalTable, renderPackagesTable, replaceBetween } from "./license-generate.ts";

describe("renderExternalTable", () => {
  it("renders one row per external component from the manifest", () => {
    const manifest: LicenseManifest = {
      allowedLicenses: [],
      packages: [],
      external: [
        {
          name: "signal-cli",
          version: "0.14.7",
          license: "GPL-3.0-only",
          source: "https://github.com/AsamK/signal-cli",
          distribution: "Bundled with the installer.",
        },
      ],
    };
    const table = renderExternalTable(manifest);
    expect(table).toContain(
      "| Component | Version (as tested) | License | Source | Distribution |",
    );
    expect(table).toContain("[signal-cli](https://github.com/AsamK/signal-cli)");
    expect(table).toContain("0.14.7");
    expect(table).toContain("GPL-3.0-only");
    expect(table).toContain("Bundled with the installer.");
  });
});

describe("renderPackagesTable", () => {
  it("renders one row per resolved package, falling back for missing fields", () => {
    const packages: PackageInfo[] = [
      { name: "yjs", version: "13.6.32", license: "MIT", source: "https://github.com/yjs/yjs" },
      { name: "mystery-pkg", version: "1.0.0", license: null, source: null },
    ];
    const table = renderPackagesTable(packages);
    expect(table).toContain("| yjs | 13.6.32 | MIT | https://github.com/yjs/yjs |");
    expect(table).toContain("| mystery-pkg | 1.0.0 | UNKNOWN | (none declared) |");
  });
});

describe("replaceBetween", () => {
  it("replaces only the content strictly between the two markers", () => {
    const content = "before\n<!-- START -->\nold content\n<!-- END -->\nafter";
    const result = replaceBetween(content, "<!-- START -->", "<!-- END -->", "new content");
    expect(result).toBe("before\n<!-- START -->\n\nnew content\n\n<!-- END -->\nafter");
  });

  it("throws a clear error when a marker is missing, rather than silently no-op-ing", () => {
    expect(() => replaceBetween("no markers here", "<!-- START -->", "<!-- END -->", "x")).toThrow(
      /markers.*not found/,
    );
  });

  it("throws when the markers are present but out of order", () => {
    const content = "<!-- END --> ... <!-- START -->";
    expect(() => replaceBetween(content, "<!-- START -->", "<!-- END -->", "x")).toThrow(
      /not found.*or out of order/,
    );
  });
});
