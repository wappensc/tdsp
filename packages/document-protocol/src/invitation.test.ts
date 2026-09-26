import { describe, expect, it } from "vitest";
import { encodeInvitation, type Invitation, parseInvitation } from "./invitation";
import { decodeSyncPolicyParam } from "./sync-policy";

const MATRIX: Invitation = {
  messenger: "matrix",
  documentId: "doc-1",
  creatorMemberId: "@alice:example.org",
  channelId: "!room:example.org",
  profile: "yjs-paragraphs/1",
  policy: "2000,10000,0,inf,3000@0",
};

const EMAIL: Invitation = {
  messenger: "email",
  documentId: "doc-2",
  creatorMemberId: "alice@example.org",
  threadRoot: "<root-1@example.org>",
  recipients: ["alice@example.org", "bob@example.org"],
  pgp: true,
  profile: "yjs-paragraphs/1",
};

describe("invitations as a link (SPECIFICATION.md §11.3)", () => {
  it.each([
    ["Matrix", MATRIX],
    ["email with PGP", EMAIL],
  ])("reads back a %s invitation as itself", (_name, invitation) => {
    const text = encodeInvitation(invitation);
    expect(text.startsWith("tdsp=1&provider=")).toBe(true);
    expect(parseInvitation(text)).toEqual({ ok: true, invitation });
    expect(parseInvitation(`?${text}`)).toEqual({ ok: true, invitation });
  });

  it("ignores parameters it does not define — an application's own, like a bridge override", () => {
    const text = `${encodeInvitation(MATRIX)}&bridge=http%3A%2F%2Flocalhost%3A8788&later=1`;
    expect(parseInvitation(text)).toEqual({ ok: true, invitation: MATRIX });
  });

  it("drops a policy that does not parse, and still opens (INV-4)", () => {
    const text = encodeInvitation({ ...MATRIX, policy: undefined }).concat("&policy=fast");
    expect(parseInvitation(text)).toEqual({
      ok: true,
      invitation: { ...MATRIX, policy: undefined },
    });
  });

  it("an ordinary page load is not an invitation", () => {
    expect(parseInvitation("?provider=matrix&bridge=x")).toMatchObject({
      ok: false,
      problem: "not-an-invitation",
    });
  });

  const base = encodeInvitation(MATRIX);
  const swap = (name: string, value: string) => {
    const params = new URLSearchParams(base);
    params.set(name, value);
    return params.toString();
  };
  const without = (name: string) => {
    const params = new URLSearchParams(base);
    params.delete(name);
    return params.toString();
  };

  it.each([
    ["no version, but a document", without("tdsp"), "unsupported-version"],
    ["another version", swap("tdsp", "2"), "unsupported-version"],
    ["a documentId twice", `${base}&documentId=doc-9`, "repeated-field"],
    ["a creator twice, the second empty", `${base}&creatorMemberId=`, "repeated-field"],
    ["no profile", without("profile"), "missing-field"],
    ["no channel for a channel binding", without("channelId"), "missing-field"],
    ["an empty documentId", swap("documentId", ""), "missing-field"],
    ["a documentId over 255 bytes", swap("documentId", "d".repeat(256)), "invalid-field"],
    ["a profile that is not a profile id", swap("profile", "Yjs Paragraphs"), "invalid-field"],
    ["a provider that is not a binding name", swap("provider", "Matrix!"), "invalid-field"],
  ])("refuses %s", (_name, text, problem) => {
    expect(parseInvitation(text)).toMatchObject({ ok: false, problem });
  });

  const email = encodeInvitation(EMAIL);
  const emailWith = (name: string, value: string | undefined) => {
    const params = new URLSearchParams(email);
    if (value === undefined) {
      params.delete(name);
    } else {
      params.set(name, value);
    }
    return params.toString();
  };

  it.each([
    ["no thread root", emailWith("threadRoot", undefined), "missing-field"],
    ["a thread root that is not a Message-ID", emailWith("threadRoot", "root@x"), "invalid-field"],
    ["one participant twice", emailWith("recipients", "a@x.org,A@x.org"), "invalid-field"],
    ["an empty participant", emailWith("recipients", "a@x.org,"), "invalid-field"],
    [
      "more participants than the binding allows",
      emailWith("recipients", Array.from({ length: 65 }, (_, i) => `p${i}@x.org`).join(",")),
      "invalid-field",
    ],
    ["pgp spelled otherwise", emailWith("pgp", "true"), "invalid-field"],
  ])("refuses an email invitation with %s", (_name, text, problem) => {
    expect(parseInvitation(text)).toMatchObject({ ok: false, problem });
  });
});

describe("policy text has one spelling per value (SPECIFICATION.md §11.2)", () => {
  it("reads the canonical form", () => {
    expect(decodeSyncPolicyParam("30000,120000,0,inf,60000@7")?.sequence).toBe(7);
  });

  it.each([
    ["a leading zero", "030000,120000,0,inf,60000@0"],
    ["a leading zero in the sequence", "30000,120000,0,inf,60000@07"],
    ["surrounding space", " 30000,120000,0,inf,60000@0"],
    ["a sequence above a uint32", "30000,120000,0,inf,60000@4294967296"],
    ["a value above a uint32", "4294967296,120000,0,inf,60000@0"],
    ["inf for a value that has no 'no limit'", "inf,120000,0,inf,60000@0"],
    ["four values", "30000,120000,0,inf@0"],
  ])("treats %s as no policy", (_name, text) => {
    expect(decodeSyncPolicyParam(text)).toBeUndefined();
  });
});
