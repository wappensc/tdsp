import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { check, definedIds, undefinedCitations } from "./requirement-ids.ts";

describe("requirement IDs this repository cites", () => {
  const defined = definedIds([
    "- **CTL-1** · *engine* — …\n- **CTL-20** · *engine* — …\n- **NEW-3** · *engine* — …",
  ]);

  it("finds an ID the specification does not define, with its place", () => {
    const files = new Map([["a.ts", "// fine (CTL-1)\n// gone (CTL-17), and CTL-20"]]);
    expect(undefinedCitations(files, defined)).toEqual([{ file: "a.ts", line: 2, id: "CTL-17" }]);
  });

  it("checks a group the specification defines that the known list lacks", () => {
    const files = new Map([["a.md", "NEW-3 holds, NEW-4 does not"]]);
    expect(undefinedCitations(files, defined)).toEqual([{ file: "a.md", line: 1, id: "NEW-4" }]);
  });

  it("lets a requirement of an earlier version be named on purpose", () => {
    expect(undefinedCitations(new Map([["a.ts", "// as 1.x CTL-17 did"]]), defined)).toEqual([]);
  });

  it("ignores what is not a requirement group", () => {
    expect(
      undefinedCitations(new Map([["a.ts", "// SHA-256, UTF-8, RFC-8785, ABC-12"]]), defined),
    ).toEqual([]);
  });

  it("holds for the repository as it is", () => {
    expect(check(fileURLToPath(new URL("..", import.meta.url)))).toEqual([]);
  });
});
