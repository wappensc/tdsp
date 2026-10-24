import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Every requirement ID this repository cites exists (CONTRIBUTING.md, "The specification and the
 * implementation": "When the code cites a requirement ID, the ID must exist"). The IDs are the ones
 * SPECIFICATION.md and the documents in bindings/ define as `- **XXX-n**`. A citation written
 * "1.x XXX-n" names a requirement of an earlier version on purpose and is not checked.
 *
 * Checked: the sources and tests of the packages and bridges, the tools, the test infrastructure,
 * the documentation (docs/, README.md, AGENTS.md, CONTRIBUTING.md, CONFORMANCE.md) and the reasons
 * in network-policy.json. Not checked: the specification and the bindings themselves, the
 * changelog, which tells history, and the frozen wire files and test vectors, which keep the words
 * of the version that wrote them.
 */

/** Requirement groups, the withdrawn ones included, so a citation of a withdrawn ID is caught. */
export const KNOWN_GROUPS = [
  "ARC",
  "TRN",
  "FRM",
  "PRF",
  "ATR",
  "LAY",
  "LIF",
  "DCL",
  "CTL",
  "RSY",
  "SND",
  "FRG",
  "LOS",
  "INV",
  "VER",
  "YJS",
  "BRG",
  "LBI",
  "BND",
  "SIG",
  "MTX",
  "EML",
] as const;

const DEFINED = /^- \*\*([A-Z]+)-(\d+)\*\*/gm;

/** The IDs the given specification texts define. */
export function definedIds(texts: readonly string[]): Set<string> {
  const ids = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(DEFINED)) ids.add(`${match[1]}-${match[2]}`);
  }
  return ids;
}

export interface Citation {
  readonly file: string;
  readonly line: number;
  readonly id: string;
}

/**
 * The citations, in `files` (path → text), of an ID that `defined` does not hold. A citation counts
 * when its group is a known one or one the specification defines, so a new group is checked too.
 */
export function undefinedCitations(
  files: ReadonlyMap<string, string>,
  defined: ReadonlySet<string>,
): Citation[] {
  const groups = new Set<string>(KNOWN_GROUPS);
  for (const id of defined) groups.add(id.slice(0, id.indexOf("-")));
  const cited = new RegExp(`(1\\.x )?\\b((?:${[...groups].join("|")})-\\d+)\\b`, "g");
  const found: Citation[] = [];
  for (const [file, text] of files) {
    text.split("\n").forEach((line, index) => {
      for (const match of line.matchAll(cited)) {
        if (match[1] === undefined && !defined.has(match[2] as string)) {
          found.push({ file, line: index + 1, id: match[2] as string });
        }
      }
    });
  }
  return found;
}

function filesUnder(dir: string, extension: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name === "test-vectors" || name.startsWith(".")) return [];
    if (statSync(path).isDirectory()) return filesUnder(path, extension);
    return name.endsWith(extension) ? [path] : [];
  });
}

/** Checks the repository at `root`. */
export function check(root: string): Citation[] {
  const bindings = join(root, "bindings");
  const specifications = [join(root, "SPECIFICATION.md"), ...filesUnder(bindings, ".md")];
  const defined = definedIds(specifications.map((path) => readFileSync(path, "utf8")));
  const checked = [
    ...["packages", "bridges"].flatMap((dir) =>
      existsSync(join(root, dir))
        ? readdirSync(join(root, dir)).flatMap((name) =>
            filesUnder(join(root, dir, name, "src"), ".ts"),
          )
        : [],
    ),
    ...filesUnder(join(root, "tools"), ".ts").filter(
      (path) => !path.endsWith("requirement-ids.test.ts"),
    ),
    ...filesUnder(join(root, "infra"), ".ts"),
    ...filesUnder(join(root, "docs"), ".md"),
    ...["README.md", "AGENTS.md", "CONTRIBUTING.md", "CONFORMANCE.md", "network-policy.json"]
      .map((name) => join(root, name))
      .filter((path) => existsSync(path)),
  ];
  const files = new Map(checked.map((path) => [relative(root, path), readFileSync(path, "utf8")]));
  return undefinedCitations(files, defined);
}
