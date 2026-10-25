import { describe, expect, it } from "vitest";
import { readFrameEnvelope } from "./sync-state.ts";

describe("readFrameEnvelope and the nesting limit (SPECIFICATION.md §1.6, BND-2)", () => {
  // An event's content with one field the binding ignores, holding `levels` nested arrays.
  const content = (levels: number): unknown =>
    JSON.parse(
      `{"tdsp":1,"documentId":"doc-1","frame":"{}","x":${"[".repeat(levels)}${"]".repeat(levels)}}`,
    );

  it("reads content nested 32 deep, and takes content nested 33 deep for no envelope", () => {
    expect(readFrameEnvelope(content(31))?.documentId).toBe("doc-1");
    expect(readFrameEnvelope(content(32))).toBeUndefined();
    expect(readFrameEnvelope(content(1_000_000))).toBeUndefined();
  });
});

describe("readFrameEnvelope and one of `frame` and `attachment` (BND-2, BND-4)", () => {
  const attachment = { url: "mxc://homeserver.test/abc", size: 2, sha256: "a".repeat(64) };

  it("reads a frame alone, and an attachment alone", () => {
    expect(readFrameEnvelope({ tdsp: 1, documentId: "doc-1", frame: "{}" })).toEqual({
      documentId: "doc-1",
      frame: "{}",
    });
    expect(readFrameEnvelope({ tdsp: 1, documentId: "doc-1", attachment })?.documentId).toBe(
      "doc-1",
    );
  });

  it("takes both, or neither, for no envelope", () => {
    expect(readFrameEnvelope({ tdsp: 1, documentId: "doc-1", frame: "{}", attachment })).toBe(
      undefined,
    );
    expect(readFrameEnvelope({ tdsp: 1, documentId: "doc-1" })).toBeUndefined();
  });
});
