import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  base64ToBytes,
  bytesToBase64,
  CURRENT_FRAME_VERSION,
  decodeFrame,
  encodeControlFrame,
  encodeDeclineFrame,
  encodeEditFrame,
  encodeFragmentFrame,
  encodeHeartbeatFrame,
  encodeResyncRequestFrame,
  encodeResyncResponseFrame,
  FrameDecodeError,
  frameByteLength,
  isProfileId,
  MAX_FRAGMENTS,
} from "./framing";

const DOC = "doc-1";

function reasonOf(text: string): string {
  try {
    decodeFrame(text);
  } catch (error) {
    if (error instanceof FrameDecodeError) {
      return error.reason;
    }
    throw error;
  }
  return "decoded";
}

/** A frame's JSON object with fields changed (or removed, for `undefined`), serialised again. */
function tampered(frame: string, changes: Record<string, unknown>): string {
  const object = JSON.parse(frame) as Record<string, unknown>;
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) {
      delete object[key];
    } else {
      object[key] = value;
    }
  }
  return JSON.stringify(object);
}

const helloUpdate = (() => {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText();
  paragraph.insert(0, [text]);
  doc.getXmlFragment("content").insert(0, [paragraph]);
  text.insert(0, "Hi");
  return Y.encodeStateAsUpdate(doc);
})();

describe("the frame (SPECIFICATION.md §4)", () => {
  it("is JSON text with tdsp 1, the kind and the documentId first", () => {
    const frame = encodeEditFrame(DOC, new Uint8Array([1, 2, 3]));
    expect(frame).toBe('{"tdsp":1,"kind":"edit","documentId":"doc-1","update":"AQID"}');
    expect(CURRENT_FRAME_VERSION).toBe(1);
  });

  it("round-trips an edit, with a real Yjs update that still applies", () => {
    const frame = decodeFrame(encodeEditFrame(DOC, helloUpdate));
    expect(frame).toEqual({ kind: "edit", documentId: DOC, update: helloUpdate });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, frame.kind === "edit" ? frame.update : new Uint8Array());
    expect(doc.getXmlFragment("content").toString()).toContain("Hi");
  });

  it("round-trips a resync request, including the empty state vector of a joiner with nothing", () => {
    const empty = Y.encodeStateVector(new Y.Doc());
    const frame = encodeResyncRequestFrame({
      documentId: DOC,
      requestId: "0123456789abcdef",
      bootstrap: true,
      controlSequence: 0,
      stateVector: empty,
    });
    expect(frame).toBe(
      '{"tdsp":1,"kind":"resync-request","documentId":"doc-1","requestId":"0123456789abcdef","bootstrap":true,"controlSequence":0,"stateVector":"AA=="}',
    );
    expect(decodeFrame(frame)).toEqual({
      kind: "resync-request",
      documentId: DOC,
      requestId: "0123456789abcdef",
      bootstrap: true,
      controlSequence: 0,
      stateVector: empty,
    });
  });

  it("round-trips a resync response with its control snapshot and attribution overlay as objects", () => {
    const control = {
      profile: "yjs-paragraphs/1",
      sequence: 2,
      closed: false,
      members: { bob: "write" },
    };
    const attribution = {
      ranges: [{ start: 0, end: 2, authorId: "alice" }],
      lastEditBySender: {},
    };
    const frame = encodeResyncResponseFrame({
      documentId: DOC,
      respondsTo: "0123456789abcde7",
      update: helloUpdate,
      control,
      attribution,
    });
    expect(decodeFrame(frame)).toEqual({
      kind: "resync-response",
      documentId: DOC,
      respondsTo: "0123456789abcde7",
      update: helloUpdate,
      control,
      attribution,
    });
  });

  it("writes null for a response without a snapshot or an overlay", () => {
    const frame = encodeResyncResponseFrame({
      documentId: DOC,
      respondsTo: "000000000000000a",
      update: new Uint8Array([0, 0]),
    });
    expect(JSON.parse(frame)).toMatchObject({ control: null, attribution: null });
    expect(decodeFrame(frame)).toMatchObject({ control: null, attribution: null });
  });

  it("round-trips every control action", () => {
    const membership = encodeControlFrame({
      documentId: DOC,
      sequence: 1,
      action: "membership",
      member: "bob",
      permission: "write",
    });
    expect(membership).toBe(
      '{"tdsp":1,"kind":"control","documentId":"doc-1","sequence":1,"action":"membership","member":"bob","permission":"write"}',
    );
    const revoke = encodeControlFrame({
      documentId: DOC,
      sequence: 2,
      action: "membership",
      member: "bob",
      permission: null,
    });
    expect(decodeFrame(revoke)).toMatchObject({
      action: "membership",
      member: "bob",
      permission: null,
    });
    const close = encodeControlFrame({ documentId: DOC, sequence: 3, action: "close" });
    expect(close).toBe(
      '{"tdsp":1,"kind":"control","documentId":"doc-1","sequence":3,"action":"close"}',
    );
    const policy = {
      minIntervalMs: 30_000,
      maxIntervalMs: Number.POSITIVE_INFINITY,
      minChars: 0,
      maxChars: Number.POSITIVE_INFINITY,
      expectedLatencyMs: 60_000,
    };
    const policyFrame = encodeControlFrame({
      documentId: DOC,
      sequence: 4,
      action: "policy",
      policy,
    });
    expect(JSON.parse(policyFrame).policy).toEqual({
      minIntervalMs: 30_000,
      maxIntervalMs: null,
      minChars: 0,
      maxChars: null,
      expectedLatencyMs: 60_000,
    });
    expect(decodeFrame(policyFrame)).toMatchObject({ action: "policy", policy });
  });

  it("round-trips a heartbeat", () => {
    const stateVector = Y.encodeStateVector(new Y.Doc());
    const frame = encodeHeartbeatFrame({ documentId: DOC, controlSequence: 3, stateVector });
    expect(decodeFrame(frame)).toEqual({
      kind: "heartbeat",
      documentId: DOC,
      controlSequence: 3,
      stateVector,
    });
  });

  it("round-trips a fragment", () => {
    const frame = encodeFragmentFrame({
      documentId: DOC,
      messageId: "0123456789abcdef",
      index: 1,
      total: 3,
      chunk: new Uint8Array([7, 8, 9]),
    });
    expect(decodeFrame(frame)).toEqual({
      kind: "fragment",
      documentId: DOC,
      messageId: "0123456789abcdef",
      index: 1,
      total: 3,
      chunk: new Uint8Array([7, 8, 9]),
    });
  });

  it("round-trips a decline, with and without its optional fields", () => {
    const full = encodeDeclineFrame({
      documentId: DOC,
      reason: "unsupported-profile",
      profiles: ["com.example.markdown/1"],
      text: "My app cannot open this document.",
    });
    expect(full).toBe(
      '{"tdsp":1,"kind":"decline","documentId":"doc-1","reason":"unsupported-profile","profiles":["com.example.markdown/1"],"text":"My app cannot open this document."}',
    );
    expect(decodeFrame(full)).toEqual({
      kind: "decline",
      documentId: DOC,
      reason: "unsupported-profile",
      profiles: ["com.example.markdown/1"],
      text: "My app cannot open this document.",
    });
    const bare = encodeDeclineFrame({ documentId: DOC, reason: "declined" });
    expect(decodeFrame(bare)).toEqual({ kind: "decline", documentId: DOC, reason: "declined" });
  });

  it("keeps a documentId with quotes, a backslash and non-ASCII exactly", () => {
    const id = 'doc "ä" \\ 😀';
    expect(decodeFrame(encodeEditFrame(id, new Uint8Array([1]))).documentId).toBe(id);
  });

  it("measures a frame in the bytes of its UTF-8 text", () => {
    expect(frameByteLength("ä")).toBe(2);
    const frame = encodeEditFrame("ä", new Uint8Array([1]));
    expect(frameByteLength(frame)).toBe(frame.length + 1);
  });
});

describe("the encoder refuses what it must never write", () => {
  it("an empty or overlong documentId, member or respondsTo", () => {
    expect(() => encodeEditFrame("", new Uint8Array([1]))).toThrow(/documentId/);
    expect(() => encodeEditFrame("x".repeat(256), new Uint8Array([1]))).toThrow(/documentId/);
    expect(() =>
      encodeControlFrame({
        documentId: DOC,
        sequence: 1,
        action: "membership",
        member: "",
        permission: "read",
      }),
    ).toThrow(/member/);
    expect(() =>
      encodeResyncResponseFrame({ documentId: DOC, respondsTo: "", update: new Uint8Array() }),
    ).toThrow(/respondsTo/);
  });

  it("an empty edit, a sequence out of range, a bad fragment", () => {
    expect(() => encodeEditFrame(DOC, new Uint8Array())).toThrow(/update/);
    expect(() => encodeControlFrame({ documentId: DOC, sequence: 0, action: "close" })).toThrow(
      /sequence/,
    );
    expect(() =>
      encodeControlFrame({ documentId: DOC, sequence: 2 ** 32, action: "close" }),
    ).toThrow(/sequence/);
    const fragment = {
      documentId: DOC,
      messageId: "0123456789abcdef",
      index: 0,
      total: 1,
      chunk: new Uint8Array([1]),
    };
    expect(() => encodeFragmentFrame({ ...fragment, messageId: "XYZ" })).toThrow(/messageId/);
    expect(() => encodeFragmentFrame({ ...fragment, index: 1 })).toThrow(/index/);
    expect(() => encodeFragmentFrame({ ...fragment, total: MAX_FRAGMENTS + 1 })).toThrow(/total/);
    expect(() => encodeFragmentFrame({ ...fragment, chunk: new Uint8Array() })).toThrow(/slice/);
  });

  it("a policy value that is negative, or unlimited where it cannot be", () => {
    const policy = {
      minIntervalMs: 0,
      maxIntervalMs: 1,
      minChars: 0,
      maxChars: 1,
      expectedLatencyMs: 0,
    };
    expect(() =>
      encodeControlFrame({
        documentId: DOC,
        sequence: 1,
        action: "policy",
        policy: { ...policy, minIntervalMs: -1 },
      }),
    ).toThrow(/minIntervalMs/);
    expect(() =>
      encodeControlFrame({
        documentId: DOC,
        sequence: 1,
        action: "policy",
        policy: { ...policy, minChars: Number.POSITIVE_INFINITY },
      }),
    ).toThrow(/minChars/);
  });

  it("a decline that is too long, lists too many profiles, or names something that is no profile", () => {
    expect(() =>
      encodeDeclineFrame({ documentId: DOC, reason: "other", text: "x".repeat(501) }),
    ).toThrow(/text/);
    expect(() =>
      encodeDeclineFrame({ documentId: DOC, reason: "other", text: "😀".repeat(500) }),
    ).not.toThrow();
    expect(() =>
      encodeDeclineFrame({ documentId: DOC, reason: "other", profiles: Array(17).fill("a/1") }),
    ).toThrow(/profiles/);
    expect(() =>
      encodeDeclineFrame({ documentId: DOC, reason: "other", profiles: ["Yjs"] }),
    ).toThrow(/profiles/);
  });
});

describe("decoding rejects with a named reason (§4.4)", () => {
  const edit = encodeEditFrame(DOC, new Uint8Array([1, 2, 3]));
  const membership = encodeControlFrame({
    documentId: DOC,
    sequence: 1,
    action: "membership",
    member: "bob",
    permission: "read",
  });
  const policyFrame = encodeControlFrame({
    documentId: DOC,
    sequence: 1,
    action: "policy",
    policy: { minIntervalMs: 0, maxIntervalMs: 1, minChars: 0, maxChars: 1, expectedLatencyMs: 0 },
  });
  const response = encodeResyncResponseFrame({
    documentId: DOC,
    respondsTo: "000000000000000a",
    update: new Uint8Array([0, 0]),
  });
  const fragment = encodeFragmentFrame({
    documentId: DOC,
    messageId: "0123456789abcdef",
    index: 0,
    total: 2,
    chunk: new Uint8Array([1]),
  });

  it("not-json: not JSON, or not a JSON object", () => {
    expect(reasonOf("")).toBe("not-json");
    expect(reasonOf("hello")).toBe("not-json");
    expect(reasonOf("[1,2]")).toBe("not-json");
    expect(reasonOf("null")).toBe("not-json");
  });

  it("not-json: valid JSON with two readings — a name twice, an unpaired surrogate (I-JSON)", () => {
    // JSON.parse would take the last kind and read an edit; another parser the first.
    expect(reasonOf(edit.replace('"kind":"edit"', '"kind":"heartbeat","kind":"edit"'))).toBe(
      "not-json",
    );
    const decline = encodeDeclineFrame({ documentId: "doc-1", reason: "other", text: "x" });
    expect(reasonOf(decline.replace('"text":"x"', '"text":"\\ud800"'))).toBe("not-json");
  });

  it("unsupported-version: no tdsp, or another version", () => {
    expect(reasonOf(tampered(edit, { tdsp: undefined }))).toBe("unsupported-version");
    expect(reasonOf(tampered(edit, { tdsp: 2 }))).toBe("unsupported-version");
    expect(reasonOf(tampered(edit, { tdsp: "1" }))).toBe("unsupported-version");
  });

  it("unknown-kind", () => {
    expect(reasonOf(tampered(edit, { kind: "presence" }))).toBe("unknown-kind");
    expect(reasonOf(tampered(edit, { kind: undefined }))).toBe("unknown-kind");
    expect(reasonOf(tampered(edit, { kind: "constructor" }))).toBe("unknown-kind");
  });

  it("missing-field, for a required field of each kind", () => {
    expect(reasonOf(tampered(edit, { documentId: undefined }))).toBe("missing-field");
    expect(reasonOf(tampered(edit, { update: undefined }))).toBe("missing-field");
    const request = encodeResyncRequestFrame({
      documentId: DOC,
      requestId: "0123456789abcdef",
      bootstrap: false,
      controlSequence: 1,
      stateVector: new Uint8Array([0]),
    });
    expect(reasonOf(tampered(request, { stateVector: undefined }))).toBe("missing-field");
    expect(reasonOf(tampered(request, { requestId: undefined }))).toBe("missing-field");
    expect(reasonOf(tampered(request, { bootstrap: undefined }))).toBe("missing-field");
    expect(reasonOf(tampered(request, { bootstrap: "yes" }))).toBe("invalid-field");
    expect(reasonOf(tampered(request, { requestId: "not-hex-digits!!" }))).toBe("invalid-field");
    expect(reasonOf(tampered(response, { control: undefined }))).toBe("missing-field");
    expect(reasonOf(tampered(membership, { permission: undefined }))).toBe("missing-field");
    expect(reasonOf(tampered(policyFrame, { policy: { minIntervalMs: 0 } }))).toBe("missing-field");
  });

  it("invalid-field: a field that is not defined for the kind", () => {
    expect(reasonOf(tampered(edit, { extra: 1 }))).toBe("invalid-field");
    const close = encodeControlFrame({ documentId: DOC, sequence: 3, action: "close" });
    expect(reasonOf(tampered(close, { member: "bob" }))).toBe("invalid-field");
  });

  it("invalid-field: a wrong type, a value out of range, an empty id", () => {
    expect(reasonOf(tampered(edit, { documentId: 7 }))).toBe("invalid-field");
    expect(reasonOf(tampered(edit, { documentId: "" }))).toBe("invalid-field");
    expect(reasonOf(tampered(edit, { documentId: "x".repeat(256) }))).toBe("invalid-field");
    const heartbeat = encodeHeartbeatFrame({
      documentId: DOC,
      controlSequence: 0,
      stateVector: new Uint8Array([0]),
    });
    expect(reasonOf(tampered(heartbeat, { controlSequence: -1 }))).toBe("invalid-field");
    expect(reasonOf(tampered(heartbeat, { controlSequence: 1.5 }))).toBe("invalid-field");
    expect(reasonOf(tampered(heartbeat, { controlSequence: 2 ** 32 }))).toBe("invalid-field");
    const close = encodeControlFrame({ documentId: DOC, sequence: 3, action: "close" });
    expect(reasonOf(tampered(close, { sequence: 0 }))).toBe("invalid-field");
    expect(reasonOf(tampered(close, { action: "delete" }))).toBe("invalid-field");
    expect(reasonOf(tampered(membership, { permission: "creator" }))).toBe("invalid-field");
    expect(reasonOf(tampered(membership, { member: "" }))).toBe("invalid-field");
    expect(reasonOf(tampered(response, { control: [1] }))).toBe("invalid-field");
    expect(reasonOf(tampered(response, { attribution: "{}" }))).toBe("invalid-field");
  });

  it("invalid-field: Base64 that is not strict, padded and canonical, or an empty update or slice", () => {
    expect(reasonOf(tampered(edit, { update: "AQID!" }))).toBe("invalid-field");
    expect(reasonOf(tampered(edit, { update: "AQI" }))).toBe("invalid-field"); // no padding
    expect(reasonOf(tampered(edit, { update: "AQJ=" }))).toBe("invalid-field"); // stray bits
    expect(reasonOf(tampered(edit, { update: "" }))).toBe("invalid-field");
    expect(reasonOf(tampered(fragment, { slice: "" }))).toBe("invalid-field");
  });

  it("invalid-field: a fragment outside its total, or a message id that is not 16 lowercase hex digits", () => {
    expect(reasonOf(tampered(fragment, { index: 2 }))).toBe("invalid-field");
    expect(reasonOf(tampered(fragment, { total: 0 }))).toBe("invalid-field");
    expect(reasonOf(tampered(fragment, { total: MAX_FRAGMENTS + 1 }))).toBe("invalid-field");
    expect(reasonOf(tampered(fragment, { messageId: "0123456789ABCDEF" }))).toBe("invalid-field");
  });

  it("invalid-field: a policy with an undefined field, a negative value, or null where it cannot be", () => {
    const base = JSON.parse(policyFrame).policy as Record<string, unknown>;
    expect(reasonOf(tampered(policyFrame, { policy: { ...base, extra: 1 } }))).toBe(
      "invalid-field",
    );
    expect(reasonOf(tampered(policyFrame, { policy: { ...base, minChars: -1 } }))).toBe(
      "invalid-field",
    );
    expect(reasonOf(tampered(policyFrame, { policy: { ...base, minIntervalMs: null } }))).toBe(
      "invalid-field",
    );
  });

  it("invalid-field: a decline with an unknown reason, too long a text, or something that is no profile", () => {
    const decline = encodeDeclineFrame({ documentId: DOC, reason: "declined" });
    expect(reasonOf(tampered(decline, { reason: "busy" }))).toBe("invalid-field");
    expect(reasonOf(tampered(decline, { text: "x".repeat(501) }))).toBe("invalid-field");
    expect(reasonOf(tampered(decline, { profiles: "yjs-paragraphs/1" }))).toBe("invalid-field");
    expect(reasonOf(tampered(decline, { profiles: ["yjs-paragraphs"] }))).toBe("invalid-field");
    expect(reasonOf(tampered(decline, { profiles: Array(17).fill("a/1") }))).toBe("invalid-field");
  });
});

describe("profile ids and Base64", () => {
  it("accepts <name>/<major> and nothing else", () => {
    expect(isProfileId("yjs-paragraphs/1")).toBe(true);
    expect(isProfileId("com.example.markdown/12")).toBe(true);
    for (const bad of ["yjs-paragraphs", "Yjs/1", "yjs/0", "yjs/01", "/1", "yjs/1/2", 1]) {
      expect(isProfileId(bad)).toBe(false);
    }
  });

  it("encodes and decodes every length exactly as the standard alphabet with padding does", () => {
    for (let length = 0; length < 70; length += 1) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + length) % 256);
      const text = bytesToBase64(bytes);
      expect(text).toBe(Buffer.from(bytes).toString("base64"));
      expect(base64ToBytes(text)).toEqual(bytes);
    }
  });

  it("handles a large buffer", () => {
    const bytes = Uint8Array.from({ length: 1_000_003 }, (_, i) => i % 251);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});
