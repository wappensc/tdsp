import { describe, expect, it } from "vitest";
import {
  compareWireLock,
  sectionText,
  severity,
  snapshotFile,
  specificationVersion,
  versionProblem,
  type WireSnapshot,
} from "./wire-lock.ts";

const file = (entries: { name: string; frame: string }[], constants = { limit: 800 }) =>
  snapshotFile({ $comment: "ignored", version: 1, constants, entries });

const base = (): WireSnapshot => ({
  specificationVersion: "1.0",
  files: {
    "wire/x.json": file([
      { name: "a", frame: "A" },
      { name: "b", frame: "B" },
    ]),
  },
  sections: { "## 4. Frames": "h1" },
});

describe("comparing the wire with its lock", () => {
  it("finds nothing when nothing changed, whatever the comment says", () => {
    const lock = base();
    const now: WireSnapshot = {
      ...base(),
      files: {
        "wire/x.json": snapshotFile({
          $comment: "reworded",
          version: 1,
          constants: { limit: 800 },
          entries: [
            { frame: "A", name: "a" },
            { name: "b", frame: "B" },
          ],
        }),
      },
    };
    expect(compareWireLock(lock, now)).toEqual([]);
  });

  it("calls a changed or removed entry, or a changed constant, incompatible", () => {
    const now: WireSnapshot = {
      ...base(),
      files: { "wire/x.json": file([{ name: "a", frame: "A2" }], { limit: 900 }) },
    };
    const findings = compareWireLock(base(), now);
    expect(findings.map((f) => f.message)).toEqual([
      "wire/x.json: its version or constants changed",
      'wire/x.json: "entries: a" changed',
      'wire/x.json: "entries: b" was removed',
    ]);
    expect(severity(findings)).toBe("incompatible");
  });

  it("calls only new entries, or a new file, an addition", () => {
    const now: WireSnapshot = {
      ...base(),
      files: {
        "wire/x.json": file([
          { name: "a", frame: "A" },
          { name: "b", frame: "B" },
          { name: "c", frame: "C" },
        ]),
        "wire/y.json": file([]),
      },
    };
    const findings = compareWireLock(base(), now);
    expect(findings.map((f) => f.kind)).toEqual(["addition", "addition"]);
    expect(severity(findings)).toBe("addition");
  });

  it("calls a changed wire section with every byte the same a specification change, and names a new version", () => {
    const now: WireSnapshot = {
      ...base(),
      specificationVersion: "1.0.1",
      sections: { "## 4. Frames": "h2" },
    };
    const findings = compareWireLock(base(), now);
    expect(findings.map((f) => f.kind)).toEqual(["specification", "version"]);
    expect(severity(findings)).toBe("specification");
  });
});

describe("the specification's version, against the kind of change", () => {
  it.each([
    ["incompatible", "1.0", "2.0", true],
    ["incompatible", "1.0", "1.1", false],
    ["addition", "1.0", "1.1", true],
    ["addition", "1.1", "1.1.1", false],
    ["addition", "1.0", "2.0", false],
    ["specification", "1.0", "1.0", true],
    ["specification", "1.0", "1.0.1", true],
    ["specification", "1.0", "1.1", false],
  ] as const)("%s from %s to %s fits: %s", (kind, from, to, fits) => {
    expect(versionProblem(kind, from, to) === undefined).toBe(fits);
  });
});

describe("reading the specification", () => {
  const spec = [
    "# Title",
    "",
    "**Specification · TDSP 1.2 · 1 January 2027**",
    "",
    "## 4. Frames",
    "",
    "Text   wrapped",
    "over lines.",
    "",
    "### 4.1 Sub",
    "",
    "More.",
    "",
    "## 5. Next",
    "",
    "Other.",
  ].join("\n");

  it("takes a section up to the next heading of its level, sub-sections included, whitespace collapsed", () => {
    expect(sectionText(spec, "## 4. Frames")).toBe("Text wrapped over lines. ### 4.1 Sub More.");
  });

  it("finds the version in the header line", () => {
    expect(specificationVersion(spec)).toBe("1.2");
  });

  it("refuses a heading that is not there", () => {
    expect(() => sectionText(spec, "## 9. Missing")).toThrow(/no section/);
  });
});
