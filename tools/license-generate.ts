import { readFileSync, writeFileSync } from "node:fs";
import {
  collectProductionDependencies,
  type LicenseManifest,
  loadManifest,
  type PackageInfo,
} from "./license-check.ts";

/**
 * Regenerates `THIRD-PARTY-NOTICES.md`'s two Components tables — external
 * programs, and the JS/TS production dependency tree — from
 * `third-party-licenses.json` plus the live, resolved dependency tree.
 * Deliberately touches only the text between each pair of sentinel
 * comments below: the surrounding prose (why each obligation applies,
 * what's excluded and why) and the License texts section are legal
 * explanation, not derived data, and stay hand-maintained. Run by hand
 * and commit the result — a legally relevant document should not be
 * silently rewritten as a build side effect; `pnpm run licenses:check`
 * (in CI) is what catches a forgotten regeneration.
 */

const EXTERNAL_START = "<!-- GENERATED:EXTERNAL-COMPONENTS:START -->";
const EXTERNAL_END = "<!-- GENERATED:EXTERNAL-COMPONENTS:END -->";
const PACKAGES_START = "<!-- GENERATED:PACKAGES:START -->";
const PACKAGES_END = "<!-- GENERATED:PACKAGES:END -->";

export function renderExternalTable(manifest: LicenseManifest): string {
  const header =
    "| Component | Version (as tested) | License | Source | Distribution |\n| --- | --- | --- | --- | --- |";
  const rows = manifest.external.map(
    (e) =>
      `| [${e.name}](${e.source}) | ${e.version} | ${e.license} | ${e.source} | ${e.distribution} |`,
  );
  return [header, ...rows].join("\n");
}

export function renderPackagesTable(actual: readonly PackageInfo[]): string {
  const header = "| Component | Version | License | Source |\n| --- | --- | --- | --- |";
  const rows = actual.map(
    (p) =>
      `| ${p.name} | ${p.version} | ${p.license ?? "UNKNOWN"} | ${p.source ?? "(none declared)"} |`,
  );
  return [header, ...rows].join("\n");
}

export function replaceBetween(
  content: string,
  startMarker: string,
  endMarker: string,
  replacement: string,
): string {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `markers "${startMarker}" / "${endMarker}" not found (or out of order) in THIRD-PARTY-NOTICES.md`,
    );
  }
  const before = content.slice(0, start + startMarker.length);
  const after = content.slice(end);
  return `${before}\n\n${replacement}\n\n${after}`;
}

export function generateNotices(repoRoot: string): void {
  const manifest = loadManifest(repoRoot);
  const actual = collectProductionDependencies(repoRoot);
  const noticesPath = `${repoRoot}/THIRD-PARTY-NOTICES.md`;
  let content = readFileSync(noticesPath, "utf8");
  content = replaceBetween(content, EXTERNAL_START, EXTERNAL_END, renderExternalTable(manifest));
  content = replaceBetween(content, PACKAGES_START, PACKAGES_END, renderPackagesTable(actual));
  writeFileSync(noticesPath, content);
}

export function main(repoRoot: string): number {
  generateNotices(repoRoot);
  console.log("licenses:generate: THIRD-PARTY-NOTICES.md's Components tables regenerated.");
  return 0;
}
