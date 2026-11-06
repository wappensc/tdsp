import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { profileFor, readerOf } from "./profile";

/**
 * The published update vectors (test-vectors/updates-draft-10.json, SPECIFICATION.md §3.6): which
 * bytes the profile `yjs-paragraphs/1` reads as exactly one update or state vector (Appendix A,
 * "Reading without applying"), checked against the reference implementation's reader.
 */
type ReadVector = { name: string; valid: boolean; update?: string; stateVector?: string };

const file = JSON.parse(
  readFileSync(new URL("../test-vectors/updates-draft-10.json", import.meta.url), "utf8"),
) as { version: string; profile: string; updates: ReadVector[]; stateVectors: ReadVector[] };

const bytes = (hex: string): Uint8Array =>
  new Uint8Array((hex.match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16)));

describe("the update vectors (Appendix A, §3.6)", () => {
  const reader = readerOf(profileFor(file.profile));

  it("are of the draft and of the profile this specification defines", () => {
    expect(file.version).toBe("de.wappensc.together.tdsp.probe.draft-10");
    expect(file.profile).toBe("yjs-paragraphs/1");
    expect(file.updates.some((v) => v.valid) && file.updates.some((v) => !v.valid)).toBe(true);
  });

  for (const v of file.updates) {
    it(`update: ${v.name}`, () => {
      expect(reader.isUpdate(bytes(v.update as string))).toBe(v.valid);
    });
  }

  for (const v of file.stateVectors) {
    it(`state vector: ${v.name}`, () => {
      expect(reader.isStateVector(bytes(v.stateVector as string))).toBe(v.valid);
    });
  }
});
