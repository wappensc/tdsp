import { describe, expect, it } from "vitest";
import {
  decodeEnvelope,
  encodeEnvelope,
  isValidMessageId,
  recipientHeadersMatchClosedSet,
  subjectForDocument,
} from "./envelope.ts";

describe("encodeEnvelope/decodeEnvelope", () => {
  it("round-trips an edit envelope", () => {
    const envelope = decodeEnvelope(
      encodeEnvelope({ tdsp: 1, kind: "frame", documentId: "doc-1", frame: "AQID" }),
    );
    expect(envelope).toEqual({ tdsp: 1, kind: "frame", documentId: "doc-1", frame: "AQID" });
  });

  it("no longer knows the control kinds of earlier builds: they decode to undefined and are ignored", () => {
    for (const kind of ["membership-change", "archived", "deleted"]) {
      expect(
        decodeEnvelope(
          JSON.stringify({ tdsp: 1, kind, documentId: "doc-1", member: "bob", permission: "read" }),
        ),
      ).toBeUndefined();
    }
  });

  it("returns undefined for a plain, human-readable message (the invite email)", () => {
    expect(decodeEnvelope("You've been invited to collaborate on a document.")).toBeUndefined();
  });

  it("returns undefined for JSON that isn't this project's envelope shape", () => {
    expect(decodeEnvelope(JSON.stringify({ hello: "world" }))).toBeUndefined();
  });

  it("returns undefined for a wrong envelope version", () => {
    expect(
      decodeEnvelope(
        JSON.stringify({ tdsp: 2, kind: "frame", documentId: "doc-1", frame: "AQID" }),
      ),
    ).toBeUndefined();
  });

  it("returns undefined for an unrecognized kind", () => {
    expect(
      decodeEnvelope(JSON.stringify({ tdsp: 1, kind: "something-else", documentId: "doc-1" })),
    ).toBeUndefined();
  });

  it("returns undefined for a membership-change with an invalid permission value", () => {
    expect(
      decodeEnvelope(
        JSON.stringify({
          tdsp: 1,
          kind: "membership-change",
          documentId: "doc-1",
          member: "bob@example.org",
          permission: "admin",
        }),
      ),
    ).toBeUndefined();
  });
});

describe("subjectForDocument", () => {
  it("is built from the opaque documentId only, never a title", () => {
    expect(subjectForDocument("doc-1")).toBe("tdsp document doc-1");
  });
});

describe("recipientHeadersMatchClosedSet", () => {
  const closedSet = ["alice@example.org", "bob@example.org", "carol@example.org"];

  it("matches when sender plus To/Cc exactly reconstitute the closed set", () => {
    expect(
      recipientHeadersMatchClosedSet(
        "alice@example.org",
        ["bob@example.org"],
        ["carol@example.org"],
        closedSet,
      ),
    ).toBe(true);
  });

  it("rejects when a participant is missing from To/Cc (silently excluded)", () => {
    expect(
      recipientHeadersMatchClosedSet("alice@example.org", ["bob@example.org"], [], closedSet),
    ).toBe(false);
  });

  it("rejects when an address outside the closed set is included (Mallory's scenario)", () => {
    expect(
      recipientHeadersMatchClosedSet(
        "alice@example.org",
        ["bob@example.org", "carol@example.org", "mallory@example.org"],
        [],
        closedSet,
      ),
    ).toBe(false);
  });

  it("compares addresses case-insensitively", () => {
    expect(
      recipientHeadersMatchClosedSet(
        "Alice@Example.org",
        ["BOB@example.ORG"],
        ["carol@example.org"],
        closedSet,
      ),
    ).toBe(true);
  });
});

describe("isValidMessageId", () => {
  it.each([
    "<3f1c2a40-9b1e-4c7a-8d55-0a1b2c3d4e5f@example.org>",
    "<root@example.org>",
    "<a.b_c+d~e-f@mail.example.co.uk>",
  ])("accepts %s", (id) => {
    expect(isValidMessageId(id)).toBe(true);
  });

  it.each([
    ["no brackets", "root@example.org"],
    ["no domain", "<root>"],
    ["a space", "<a b@example.org>"],
    ["a CR/LF header injection", "<a@b.org>\r\nBcc: evil@example.org"],
    ["a newline alone", "<a@b.org\n>"],
    ["an angle bracket inside", "<a<b@example.org>"],
    ["two @", "<a@b@example.org>"],
    ["an empty local part", "<@example.org>"],
    ["a comma-separated pair", "<a@b.org>,<c@d.org>"],
    ["an over-long id", `<${"a".repeat(150)}@example.org>`],
    ["the empty string", ""],
  ])("rejects %s", (_name, id) => {
    expect(isValidMessageId(id)).toBe(false);
  });

  it.each([undefined, null, 42, {}, ["<a@b.org>"]])("rejects the non-string %p", (value) => {
    expect(isValidMessageId(value)).toBe(false);
  });
});
