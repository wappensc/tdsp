import { describe, expect, it } from "vitest";
import {
  encodeInvitation,
  INVITATION_VERSION,
  type Invitation,
  invitationFromUrl,
  parseInvitation,
} from "./invitation";

const MATRIX: Invitation = {
  messenger: "matrix",
  documentId: "doc-1",
  creatorMemberId: "@alice:example.org",
  channelId: "!room:example.org",
  profile: "yjs-paragraphs/1",
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
    expect(text.startsWith(`tdsp=${encodeURIComponent(INVITATION_VERSION)}&provider=`)).toBe(true);
    expect(parseInvitation(text)).toEqual({ ok: true, invitation });
    expect(parseInvitation(`?${text}`)).toEqual({ ok: true, invitation });
  });

  it("ignores parameters it does not define — an application's own, like a bridge override", () => {
    const text = `${encodeInvitation(MATRIX)}&bridge=http%3A%2F%2Flocalhost%3A8788&later=1`;
    expect(parseInvitation(text)).toEqual({ ok: true, invitation: MATRIX });
  });

  it("ignores 1.x's policy parameter: the draft shares no policy (SND-16)", () => {
    const text = `${encodeInvitation(MATRIX)}&policy=2000%2C10000%2C0%2Cinf%2C3000%400`;
    expect(parseInvitation(text)).toEqual({ ok: true, invitation: MATRIX });
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
    // §11.3: a binding's name begins with a letter or a digit.
    ["a provider beginning with a dot", swap("provider", ".matrix"), "invalid-field"],
    ["a provider beginning with a hyphen", swap("provider", "-matrix"), "invalid-field"],
    ["a provider of 65 characters", swap("provider", "m".repeat(65)), "invalid-field"],
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
    // The email binding's form: at most 200 characters in all (§11.3, bindings/email.md).
    [
      "a thread root of 201 characters",
      emailWith("threadRoot", `<${"l".repeat(150)}@${"d".repeat(48)}>`),
      "invalid-field",
    ],
    [
      "a thread root with an empty local part",
      emailWith("threadRoot", "<@x.org>"),
      "invalid-field",
    ],
  ])("refuses an email invitation with %s", (_name, text, problem) => {
    expect(parseInvitation(text)).toMatchObject({ ok: false, problem });
  });

  it("reads a thread root as long as the email binding allows, however its parts share the 200 characters", () => {
    for (const threadRoot of [`<${"l".repeat(150)}@${"d".repeat(47)}>`, `<l@${"d".repeat(196)}>`]) {
      expect(threadRoot).toHaveLength(200);
      expect(parseInvitation(emailWith("threadRoot", threadRoot))).toEqual({
        ok: true,
        invitation: { ...EMAIL, threadRoot },
      });
    }
  });

  it("reads a provider that is another binding's name, with a dot and a hyphen inside", () => {
    expect(parseInvitation(swap("provider", "com.example-chat"))).toEqual({
      ok: true,
      invitation: { ...MATRIX, messenger: "com.example-chat" },
    });
  });
});

describe("an invitation in a whole link: fragment or query (SPECIFICATION.md INV-8)", () => {
  const form = encodeInvitation(MATRIX);
  const other = encodeInvitation({ ...MATRIX, documentId: "doc-other" });
  const documentOf = (link: string | URL) => {
    const parsed = invitationFromUrl(link);
    return parsed.ok ? parsed.invitation.documentId : parsed.problem;
  };

  it("reads the form from the query, and from the fragment", () => {
    expect(documentOf(`https://example.org/join?${form}`)).toBe("doc-1");
    expect(documentOf(`https://example.org/join#${form}`)).toBe("doc-1");
    expect(documentOf(new URL(`https://example.org/join#${form}`))).toBe("doc-1");
  });

  it("takes the fragment when both carry tdsp, and combines nothing from the two", () => {
    expect(documentOf(`https://example.org/join?${other}#${form}`)).toBe("doc-1");
    // A parameter added to the visible query changes nothing in the fragment's invitation...
    expect(documentOf(`https://example.org/join?documentId=doc-evil#${form}`)).toBe("doc-1");
    // ...and the fragment's own form stays whole: no field is filled in from the query.
    const withoutChannel = form.replace(/&channelId=[^&]*/, "");
    const parsed = invitationFromUrl(
      `https://example.org/join?channelId=%21evil%3Aexample.org#${withoutChannel}`,
    );
    expect(parsed).toMatchObject({ ok: false, problem: "missing-field" });
  });

  it("reads the query when the fragment carries no tdsp, such as an application's own anchor", () => {
    expect(documentOf(`https://example.org/join?${form}#top`)).toBe("doc-1");
  });

  it("finds no invitation in a link that carries none, or in text that is no link", () => {
    expect(documentOf("https://example.org/join")).toBe("not-an-invitation");
    expect(documentOf("https://example.org/join#top")).toBe("not-an-invitation");
    expect(documentOf("not a link")).toBe("not-an-invitation");
  });
});
