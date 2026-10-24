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
  encodeHeartbeatFrame,
  encodeResyncRequestFrame,
  encodeResyncResponseFrame,
  FrameDecodeError,
  frameByteLength,
  isProfileId,
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
  it("is JSON text with the draft marker, the kind and the documentId first", () => {
    const frame = encodeEditFrame(DOC, new Uint8Array([1, 2, 3]));
    expect(frame).toBe(
      '{"tdsp":"de.wappensc.together.tdsp.probe.draft-5","kind":"edit","documentId":"doc-1","update":"AQID","due":0}',
    );
    expect(CURRENT_FRAME_VERSION).toBe("de.wappensc.together.tdsp.probe.draft-5");
  });

  it("round-trips an edit, with a real Yjs update that still applies", () => {
    const frame = decodeFrame(encodeEditFrame(DOC, helloUpdate));
    expect(frame).toEqual({ kind: "edit", documentId: DOC, update: helloUpdate, due: 0 });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, frame.kind === "edit" ? frame.update : new Uint8Array());
    expect(doc.getXmlFragment("content").toString()).toContain("Hi");
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

  it("round-trips a decline, with and without its optional fields", () => {
    const full = encodeDeclineFrame({
      documentId: DOC,
      reason: "unsupported-profile",
      profiles: ["com.example.markdown/1"],
      text: "My app cannot open this document.",
    });
    expect(full).toBe(
      '{"tdsp":"de.wappensc.together.tdsp.probe.draft-5","kind":"decline","documentId":"doc-1","reason":"unsupported-profile","profiles":["com.example.markdown/1"],"text":"My app cannot open this document."}',
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
    expect(reasonOf(tampered(edit, { tdsp: 1 }))).toBe("unsupported-version");
    expect(reasonOf(tampered(edit, { tdsp: "1" }))).toBe("unsupported-version");
  });

  it("unknown-kind", () => {
    expect(reasonOf(tampered(edit, { kind: "presence" }))).toBe("unknown-kind");
    expect(reasonOf(tampered(edit, { kind: undefined }))).toBe("unknown-kind");
    expect(reasonOf(tampered(edit, { kind: "constructor" }))).toBe("unknown-kind");
  });

  it("invalid-field: Base64 that is not strict, padded and canonical, or an empty update", () => {
    expect(reasonOf(tampered(edit, { update: "AQID!" }))).toBe("invalid-field");
    expect(reasonOf(tampered(edit, { update: "AQI" }))).toBe("invalid-field"); // no padding
    expect(reasonOf(tampered(edit, { update: "AQJ=" }))).toBe("invalid-field"); // stray bits
    expect(reasonOf(tampered(edit, { update: "" }))).toBe("invalid-field");
  });

  it("invalid-field: an answer's empty update, where one that holds nothing belongs (§4.3, SND-18)", () => {
    const answer = encodeResyncResponseFrame({
      documentId: DOC,
      respondsTo: "000000000000000a",
      update: new Uint8Array([0, 0]),
    });
    expect(reasonOf(answer)).toBe("decoded");
    expect(reasonOf(tampered(answer, { update: "" }))).toBe("invalid-field");
    expect(() =>
      encodeResyncResponseFrame({
        documentId: DOC,
        respondsTo: "000000000000000a",
        update: new Uint8Array(0),
      }),
    ).toThrow(/update/);
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
    const back = base64ToBytes(bytesToBase64(bytes));
    // Compared as one buffer: an element-by-element toEqual over a million entries takes
    // seconds on a busy CI runner, and timed out there.
    expect(back && Buffer.from(back).equals(Buffer.from(bytes))).toBe(true);
  });
});

describe("extension fields (FRM-9 to FRM-11)", () => {
  const edit = encodeEditFrame(DOC, new Uint8Array([1, 2, 3]));

  it("ignores a field whose name contains a dot, and still rejects an unknown one without", () => {
    expect(reasonOf(tampered(edit, { "com.example.note": { any: ["thing"] } }))).toBe("decoded");
    expect(decodeFrame(tampered(edit, { "com.example.note": 1 }))).toEqual(decodeFrame(edit));
    expect(reasonOf(tampered(edit, { note: 1 }))).toBe("invalid-field");
  });

  it("still rejects a defined field set wrongly beside an extension", () => {
    expect(reasonOf(tampered(edit, { "com.example.note": 1, update: 7 }))).toBe("invalid-field");
  });

  it("rejects a frame whose crit names an extension it does not understand", () => {
    expect(reasonOf(tampered(edit, { "com.example.note": 1, crit: ["com.example.note"] }))).toBe(
      "unsupported-extension",
    );
  });

  it("rejects a crit that is not a list of 1 to 16 extension names", () => {
    for (const crit of [[], ["note"], "com.example.note", [1], Array(17).fill("a.b")]) {
      expect(reasonOf(tampered(edit, { crit }))).toBe("invalid-field");
    }
  });

  it("rejects a crit that names an extension the frame does not carry, or one twice (FRM-10)", () => {
    // Also where the receiver does not implement it: the list itself has no single reading.
    expect(reasonOf(tampered(edit, { crit: ["com.example.note/1"] }))).toBe("invalid-field");
    expect(
      reasonOf(
        tampered(edit, {
          "com.example.note/1": "x",
          crit: ["com.example.note/1", "com.example.note/1"],
        }),
      ),
    ).toBe("invalid-field");
    expect(
      reasonOf(tampered(edit, { "com.example.note/1": "x", crit: ["com.example.note/1"] })),
    ).toBe("unsupported-extension");
  });

  it("ignores extension fields inside a snapshot and an attribution overlay", () => {
    const response = encodeResyncResponseFrame({
      documentId: DOC,
      respondsTo: "0123456789abcdef",
      update: new Uint8Array([0, 0]),
      attribution: { ranges: [], lastEditBySender: {}, "com.example.x": true },
    });
    expect(reasonOf(response)).toBe("decoded");
  });

  it("counts extensions toward the frame's size and nesting like any field", () => {
    const deep = tampered(edit, {
      "com.example.deep": JSON.parse(`${"[".repeat(40)}${"]".repeat(40)}`),
    });
    expect(reasonOf(deep)).toBe("not-json");
    expect(frameByteLength(tampered(edit, { "com.example.pad": "x".repeat(100) }))).toBeGreaterThan(
      frameByteLength(edit) + 100,
    );
  });

  it("writes the draft marker, which no 1.x engine reads as its own", () => {
    expect(JSON.parse(edit).tdsp).toBe(CURRENT_FRAME_VERSION);
    expect(CURRENT_FRAME_VERSION).not.toBe(1);
  });
});

describe("extensions a receiver implements (FRM-10, FRM-16, FRM-17)", () => {
  const MOOD = "com.example.mood/1";
  const update = new Uint8Array([1, 2, 3]);
  const edit = encodeEditFrame(DOC, update);
  const implemented = new Map([[MOOD, (value: unknown) => value === "calm" || value === "busy"]]);

  function reasonWith(text: string): string {
    try {
      decodeFrame(text, implemented);
    } catch (error) {
      return error instanceof FrameDecodeError ? error.reason : "threw";
    }
    return "decoded";
  }

  it("exposes their values at the frame's top level, and nothing to a receiver without them", () => {
    const withMood = tampered(edit, { [MOOD]: "calm", "com.example.other/1": 1 });
    expect(decodeFrame(withMood, implemented).extensions).toEqual({ [MOOD]: "calm" });
    expect(decodeFrame(withMood)).toEqual(decodeFrame(edit));
    expect(decodeFrame(edit, implemented).extensions).toBeUndefined();
  });

  it("accepts crit naming one, and ignores a value its definition forbids unless crit names it", () => {
    expect(reasonWith(tampered(edit, { [MOOD]: "busy", crit: [MOOD] }))).toBe("decoded");
    expect(
      decodeFrame(tampered(edit, { [MOOD]: "sleepy" }), implemented).extensions,
    ).toBeUndefined();
    expect(reasonWith(tampered(edit, { [MOOD]: "sleepy", crit: [MOOD] }))).toBe("invalid-field");
    expect(
      reasonWith(
        tampered(edit, {
          [MOOD]: "busy",
          "com.example.mood/2": "busy",
          crit: [MOOD, "com.example.mood/2"],
        }),
      ),
    ).toBe("unsupported-extension");
  });

  it("does not expose one inside a snapshot, its targets or an overlay", () => {
    const response = encodeResyncResponseFrame({
      documentId: DOC,
      respondsTo: "0123456789abcdef",
      update: new Uint8Array([0, 0]),
      control: { profile: "yjs-paragraphs/1", vector: {}, targets: {}, [MOOD]: "calm" },
      attribution: { ranges: [], lastEditBySender: {}, [MOOD]: "busy" },
    });
    const frame = decodeFrame(response, implemented);
    expect(frame.kind).toBe("resync-response");
    expect(frame.extensions).toBeUndefined();
  });

  it("writes them after the defined fields, and crit only for extensions the frame carries", () => {
    const text = encodeEditFrame(DOC, update, 0, { fields: { [MOOD]: "calm" }, crit: [MOOD] });
    expect(Object.keys(JSON.parse(text))).toEqual([
      "tdsp",
      "kind",
      "documentId",
      "update",
      "due",
      MOOD,
      "crit",
    ]);
    expect(decodeFrame(text, implemented).extensions).toEqual({ [MOOD]: "calm" });
    expect(
      Object.keys(
        JSON.parse(encodeEditFrame(DOC, update, 0, { fields: { [MOOD]: "calm" }, crit: [] })),
      ),
    ).not.toContain("crit");
    expect(() => encodeEditFrame(DOC, update, 0, { fields: { mood: "calm" }, crit: [] })).toThrow(
      /dot/,
    );
    expect(() => encodeEditFrame(DOC, update, 0, { fields: {}, crit: [MOOD] })).toThrow(/crit/);
  });
});

describe("no fragments (SND-17)", () => {
  it("rejects a 1.x fragment as a kind it does not know: large changes travel as pieces (SND-17)", () => {
    const fragment = JSON.stringify({
      tdsp: CURRENT_FRAME_VERSION,
      kind: "fragment",
      documentId: DOC,
      messageId: "0123456789abcdef",
      index: 0,
      total: 2,
      slice: "AQ==",
    });
    expect(reasonOf(fragment)).toBe("unknown-kind");
  });
});

describe("control operations, snapshots, heartbeats and requests (§4.3, §7)", () => {
  const TAG = "A".repeat(22);
  const OTHER = "B".repeat(22);
  const empty = Y.encodeStateVector(new Y.Doc());
  const grant = encodeControlFrame({
    documentId: DOC,
    device: TAG,
    counter: 2,
    target: "member:bob",
    value: "write",
    seen: { [OTHER]: 1 },
  });
  const STATE = "00112233aabbccdd";
  const CONTROL = "ffeeddcc44332211";
  const STREAM = "5eed5eed5eed5eed";
  const heartbeat = encodeHeartbeatFrame({
    documentId: DOC,
    control: { [TAG]: 2 },
    controlDigest: CONTROL,
    stateVector: empty,
    stateDigest: STATE,
    stream: STREAM,
    sequence: 7,
  });
  const request = encodeResyncRequestFrame({
    documentId: DOC,
    requestId: "0123456789abcdef",
    control: null,
    controlDigest: null,
    force: false,
    stateDigest: STATE,
    stateVector: empty,
    stream: STREAM,
    sequence: 8,
  });
  const snapshot = {
    profile: "yjs-paragraphs/1",
    vector: { [TAG]: 2 },
    targets: {
      close: { seen: {}, heads: [] },
      "member:bob": {
        seen: { [TAG]: 1 },
        heads: [{ device: TAG, counter: 2, value: "write", seen: {} }],
      },
      pace: { seen: { [TAG]: 0 }, heads: [{ device: TAG, counter: 1, value: 5000, seen: {} }] },
    },
  };
  const response = encodeResyncResponseFrame({
    documentId: DOC,
    respondsTo: "0123456789abcde7",
    update: helloUpdate,
    control: snapshot,
    attribution: { ranges: [{ start: 0, end: 2, authorId: "alice" }], lastEditBySender: {} },
  });

  it("round-trips an operation on every kind of target (CTL-20)", () => {
    expect(grant).toBe(
      `{"tdsp":"${CURRENT_FRAME_VERSION}","kind":"control","documentId":"doc-1","device":"${TAG}","counter":2,"target":"member:bob","value":"write","seen":{"${OTHER}":1},"due":0}`,
    );
    for (const [target, value] of [
      ["member:bob", "read"],
      ["member:bob", null],
      ["close", true],
      ["pace", 30000],
    ] as const) {
      const frame = encodeControlFrame({
        documentId: DOC,
        device: TAG,
        counter: 1,
        target,
        value,
        seen: {},
      });
      expect(decodeFrame(frame)).toEqual({
        kind: "control",
        documentId: DOC,
        device: TAG,
        counter: 1,
        target,
        value,
        seen: {},
        due: 0,
      });
    }
  });

  it("writes a vector in one spelling: its devices sorted", () => {
    const frame = encodeControlFrame({
      documentId: DOC,
      device: TAG,
      counter: 1,
      target: "close",
      value: true,
      seen: { [OTHER]: 3, ["C".repeat(22)]: 1 },
    });
    expect(frame).toContain(`"seen":{"${OTHER}":3,"${"C".repeat(22)}":1}`);
  });

  it("round-trips a heartbeat with a control vector, and one without (SND-11)", () => {
    expect(decodeFrame(heartbeat)).toEqual({
      kind: "heartbeat",
      documentId: DOC,
      control: { [TAG]: 2 },
      controlDigest: CONTROL,
      stateVector: empty,
      stateDigest: STATE,
      stream: STREAM,
      sequence: 7,
    });
    const plain = encodeHeartbeatFrame({
      documentId: DOC,
      control: null,
      controlDigest: null,
      stateVector: empty,
      stateDigest: STATE,
    });
    expect(decodeFrame(plain)).toMatchObject({ control: null, controlDigest: null });
    // A control digest goes with a control vector, and a digest is 16 lowercase hex digits (LOS-12).
    expect(reasonOf(tampered(plain, { controlDigest: CONTROL }))).toBe("invalid-field");
    expect(reasonOf(tampered(heartbeat, { controlDigest: null }))).toBe("invalid-field");
    expect(reasonOf(tampered(heartbeat, { stateDigest: "00112233AABBCCDD" }))).toBe(
      "invalid-field",
    );
    expect(reasonOf(tampered(heartbeat, { stateDigest: undefined }))).toBe("missing-field");
  });

  it("round-trips a request without a snapshot, and one with a vector that asks regardless (RSY-16)", () => {
    expect(request).toBe(
      `{"tdsp":"${CURRENT_FRAME_VERSION}","kind":"resync-request","documentId":"doc-1","requestId":"0123456789abcdef","control":null,"controlDigest":null,"force":false,"stateVector":"AA==","stateDigest":"00112233aabbccdd","stream":"${STREAM}","sequence":8}`,
    );
    const forced = encodeResyncRequestFrame({
      documentId: DOC,
      requestId: "0123456789abcdef",
      control: { [TAG]: 4 },
      controlDigest: CONTROL,
      force: true,
      stateVector: empty,
      stateDigest: STATE,
      stream: STREAM,
      sequence: 1,
    });
    expect(decodeFrame(forced)).toEqual({
      kind: "resync-request",
      documentId: DOC,
      requestId: "0123456789abcdef",
      control: { [TAG]: 4 },
      controlDigest: CONTROL,
      force: true,
      stateVector: empty,
      stateDigest: STATE,
      stream: STREAM,
      sequence: 1,
    });
  });

  it("round-trips a snapshot of operations with its attribution overlay (CTL-25)", () => {
    expect(decodeFrame(response)).toMatchObject({
      kind: "resync-response",
      control: snapshot,
      stateVector: null,
      stateDigest: null,
    });
  });

  it("carries the responder's state vector and digest together in an answer's last piece, or neither (RSY-18)", () => {
    const last = encodeResyncResponseFrame({
      documentId: DOC,
      respondsTo: "0123456789abcdef",
      update: new Uint8Array([0, 0]),
      state: { stateVector: empty, stateDigest: STATE },
    });
    expect(decodeFrame(last)).toMatchObject({ stateVector: empty, stateDigest: STATE });
    expect(reasonOf(tampered(last, { stateDigest: null }))).toBe("invalid-field");
    expect(reasonOf(tampered(last, { stateVector: null }))).toBe("invalid-field");
  });

  it("numbers every piece of an answer, and only its last says how many there are (RSY-18, LOS-14)", () => {
    const state = { stateVector: empty, stateDigest: STATE };
    const piece = encodeResyncResponseFrame({
      documentId: DOC,
      respondsTo: "0123456789abcdef",
      update: helloUpdate,
      stream: STREAM,
      sequence: 3,
      piece: 2,
    });
    expect(decodeFrame(piece)).toMatchObject({
      stream: STREAM,
      sequence: 3,
      piece: 2,
      pieces: null,
      stateVector: null,
    });
    const last = encodeResyncResponseFrame({
      documentId: DOC,
      respondsTo: "0123456789abcdef",
      update: helloUpdate,
      state,
      stream: STREAM,
      sequence: 3,
      piece: 4,
    });
    expect(decodeFrame(last)).toMatchObject({
      stream: STREAM,
      sequence: 3,
      piece: 4,
      pieces: 4,
      stateVector: empty,
    });
    // A whole answer is its own first and last piece.
    expect(
      decodeFrame(
        encodeResyncResponseFrame({
          documentId: DOC,
          respondsTo: "0123456789abcdef",
          update: helloUpdate,
          state,
        }),
      ),
    ).toMatchObject({ piece: 1, pieces: 1 });

    expect(reasonOf(tampered(last, { pieces: 5 }))).toBe("invalid-field"); // the last is numbered as many as there are
    expect(reasonOf(tampered(last, { pieces: null }))).toBe("invalid-field"); // the state goes with the count
    expect(reasonOf(tampered(piece, { pieces: 2 }))).toBe("invalid-field"); // and the count with the state
    expect(reasonOf(tampered(piece, { piece: 0 }))).toBe("invalid-field");
    expect(reasonOf(tampered(piece, { piece: 1.5 }))).toBe("invalid-field");
    expect(reasonOf(tampered(piece, { piece: undefined }))).toBe("missing-field");
    expect(reasonOf(tampered(piece, { pieces: undefined }))).toBe("missing-field");
  });

  it("names the sender's stream and the report's number in it, in a heartbeat, a request and every piece of an answer (LOS-13)", () => {
    const piece = encodeResyncResponseFrame({
      documentId: DOC,
      respondsTo: "0123456789abcdef",
      update: helloUpdate,
      stream: STREAM,
      sequence: 3,
      piece: 2,
    });
    for (const frame of [heartbeat, request, piece]) {
      expect(reasonOf(tampered(frame, { stream: undefined }))).toBe("missing-field");
      expect(reasonOf(tampered(frame, { sequence: undefined }))).toBe("missing-field");
      expect(reasonOf(tampered(frame, { stream: "5EED5EED5EED5EED" }))).toBe("invalid-field");
      expect(reasonOf(tampered(frame, { stream: "5eed5eed" }))).toBe("invalid-field");
      expect(reasonOf(tampered(frame, { sequence: 0 }))).toBe("invalid-field");
      expect(reasonOf(tampered(frame, { sequence: 2 ** 32 }))).toBe("invalid-field");
    }
    expect(() =>
      encodeHeartbeatFrame({
        documentId: DOC,
        control: null,
        controlDigest: null,
        stateVector: empty,
        stateDigest: STATE,
        stream: "x",
      }),
    ).toThrow(/stream/);
    expect(() =>
      encodeHeartbeatFrame({
        documentId: DOC,
        control: null,
        controlDigest: null,
        stateVector: empty,
        stateDigest: STATE,
        sequence: 0,
      }),
    ).toThrow(/sequence/);
    // A frame written without one is the first report of a stream of its own.
    expect(
      decodeFrame(
        encodeHeartbeatFrame({
          documentId: DOC,
          control: null,
          controlDigest: null,
          stateVector: empty,
          stateDigest: STATE,
        }),
      ),
    ).toMatchObject({
      stream: expect.stringMatching(/^[0-9a-f]{16}$/),
      sequence: 1,
    });
  });

  it("refuses to write an operation that is not one", () => {
    const base = {
      documentId: DOC,
      device: TAG,
      counter: 1,
      target: "member:bob" as const,
      value: "read" as const,
      seen: {},
    };
    expect(() => encodeControlFrame({ ...base, device: "short" })).toThrow(/device tag/);
    expect(() => encodeControlFrame({ ...base, counter: 0 })).toThrow(/counter/);
    expect(() => encodeControlFrame({ ...base, counter: 2 ** 32 })).toThrow(/counter/);
    expect(() => encodeControlFrame({ ...base, target: "close", value: "read" })).toThrow(
      /cannot set/,
    );
    // A right on a layer (LAY-5): written and read like a member's; a malformed one is no target.
    const layer = encodeControlFrame({
      ...base,
      target: "layer:com.example.comments/1:member:bob",
      value: "write",
    });
    expect(decodeFrame(layer)).toMatchObject({
      target: "layer:com.example.comments/1:member:bob",
      value: "write",
    });
    expect(reasonOf(tampered(layer, { target: "layer:Comments:member:bob" }))).toBe(
      "invalid-field",
    );
    expect(reasonOf(tampered(layer, { target: "layer:com.example.comments/1:member:" }))).toBe(
      "invalid-field",
    );
    expect(reasonOf(tampered(layer, { value: true }))).toBe("invalid-field");
    expect(() => encodeControlFrame({ ...base, target: "pace", value: -1 })).toThrow(/cannot set/);
    expect(() => encodeControlFrame({ ...base, target: `member:${"x".repeat(256)}` })).toThrow(
      /member id/,
    );
    expect(() =>
      encodeControlFrame({
        ...base,
        seen: Object.fromEntries(
          Array.from({ length: 65 }, (_, i) => [String(i).padStart(22, "x"), 1]),
        ),
      }),
    ).toThrow(/more than 64/);
    expect(() => encodeEditFrame(DOC, new Uint8Array())).toThrow(/update/);
    expect(() => encodeEditFrame("", new Uint8Array([1]))).toThrow(/documentId/);
  });

  it("missing-field, for each required field of the kinds V1 changed", () => {
    for (const field of ["device", "counter", "target", "value", "seen"]) {
      expect(reasonOf(tampered(grant, { [field]: undefined })), field).toBe("missing-field");
    }
    for (const field of ["control", "stateVector"]) {
      expect(reasonOf(tampered(heartbeat, { [field]: undefined })), field).toBe("missing-field");
    }
    for (const field of ["requestId", "control", "force", "stateVector"]) {
      expect(reasonOf(tampered(request, { [field]: undefined })), field).toBe("missing-field");
    }
  });

  it("invalid-field: a 1.x field, a wrong type, a value that does not fit its target", () => {
    expect(reasonOf(tampered(grant, { sequence: 1 }))).toBe("invalid-field");
    expect(reasonOf(tampered(heartbeat, { controlSequence: 0 }))).toBe("invalid-field");
    expect(reasonOf(tampered(request, { bootstrap: true }))).toBe("invalid-field");
    expect(reasonOf(tampered(grant, { counter: 0 }))).toBe("invalid-field");
    expect(reasonOf(tampered(grant, { counter: 1.5 }))).toBe("invalid-field");
    expect(reasonOf(tampered(grant, { device: "not a tag" }))).toBe("invalid-field");
    expect(reasonOf(tampered(grant, { target: "policy" }))).toBe("invalid-field");
    expect(reasonOf(tampered(grant, { value: true }))).toBe("invalid-field");
    expect(reasonOf(tampered(grant, { target: "pace", value: "write" }))).toBe("invalid-field");
    expect(reasonOf(tampered(grant, { seen: [1] }))).toBe("invalid-field");
    expect(reasonOf(tampered(grant, { seen: { bob: 1 } }))).toBe("invalid-field");
    expect(reasonOf(tampered(heartbeat, { control: { [TAG]: -1 } }))).toBe("invalid-field");
    expect(reasonOf(tampered(request, { force: "yes" }))).toBe("invalid-field");
  });

  it("invalid-field: a snapshot that breaks its layout anywhere rejects the whole response", () => {
    const withSnapshot = (control: unknown) => tampered(response, { control });
    expect(reasonOf(withSnapshot({ ...snapshot, vector: undefined }))).toBe("missing-field");
    expect(reasonOf(withSnapshot({ ...snapshot, sequence: 1 }))).toBe("invalid-field");
    expect(
      reasonOf(withSnapshot({ ...snapshot, targets: { policy: { seen: {}, heads: [] } } })),
    ).toBe("invalid-field");
    expect(
      reasonOf(
        withSnapshot({
          ...snapshot,
          targets: {
            close: { seen: {}, heads: [{ device: "x", counter: 1, value: true, seen: {} }] },
          },
        }),
      ),
    ).toBe("invalid-field");
    expect(
      reasonOf(
        withSnapshot({
          ...snapshot,
          targets: {
            close: { seen: {}, heads: [{ device: TAG, counter: 1, value: "write", seen: {} }] },
          },
        }),
      ),
    ).toBe("invalid-field");
    const tooMany = Array.from({ length: 65 }, (_, i) => ({
      device: TAG,
      counter: i + 1,
      value: true,
      seen: {},
    }));
    expect(
      reasonOf(withSnapshot({ ...snapshot, targets: { close: { seen: {}, heads: tooMany } } })),
    ).toBe("invalid-field");
  });

  it("reads an overlay range without an author as null, and refuses an empty author id (§5.4, ATR-2)", () => {
    const withOverlay = (attribution: unknown) => tampered(response, { attribution });
    const unattributed = { ranges: [{ start: 0, end: 2, authorId: null }], lastEditBySender: {} };
    const decoded = decodeFrame(withOverlay(unattributed));
    expect(decoded.kind === "resync-response" ? decoded.attribution : undefined).toEqual(
      unattributed,
    );
    expect(
      reasonOf(withOverlay({ ranges: [{ start: 0, end: 2, authorId: "" }], lastEditBySender: {} })),
    ).toBe("invalid-field");
    expect(reasonOf(withOverlay({ ranges: [{ start: 0, end: 2 }], lastEditBySender: {} }))).toBe(
      "missing-field",
    );
  });

  it("invalid-field: a snapshot with two heads of one device on a target (§7.5, CTL-24)", () => {
    const withHeads = (heads: unknown[]) =>
      tampered(response, {
        control: {
          ...snapshot,
          targets: { ...snapshot.targets, "member:bob": { seen: {}, heads } },
        },
      });
    const head = (device: string, counter: number, value: string) => ({
      device,
      counter,
      value,
      seen: {},
    });
    expect(reasonOf(withHeads([head(TAG, 2, "write"), head(TAG, 3, "read")]))).toBe(
      "invalid-field",
    );
    expect(reasonOf(withHeads([head(TAG, 2, "write"), head(TAG, 2, "read")]))).toBe(
      "invalid-field",
    );
    expect(reasonOf(withHeads([head(TAG, 2, "write"), head(OTHER, 1, "read")]))).toBe("decoded");
  });

  /** `frame` with `from` written as `to`, which must be there to replace. */
  const written = (frame: string, from: string, to: string): string => {
    expect(frame.includes(from), from).toBe(true);
    return frame.replace(from, to);
  };

  it("invalid-field: an integer field written with a fraction or an exponent, or as -0 (§1.6, §4.3)", () => {
    const edit = encodeEditFrame(DOC, helloUpdate, 30000);
    for (const due of ["30000.0", "3e4", "3E4", "30000e0", "3e+4"]) {
      expect(reasonOf(written(edit, '"due":30000', `"due":${due}`)), due).toBe("invalid-field");
    }
    expect(reasonOf(written(encodeEditFrame(DOC, helloUpdate, 0), '"due":0', '"due":-0'))).toBe(
      "invalid-field",
    );
    expect(reasonOf(written(grant, '"counter":2', '"counter":2.0'))).toBe("invalid-field");
    expect(reasonOf(written(grant, `"seen":{"${OTHER}":1}`, `"seen":{"${OTHER}":1E0}`))).toBe(
      "invalid-field",
    );
    expect(reasonOf(written(heartbeat, `"control":{"${TAG}":2}`, `"control":{"${TAG}":2.0}`))).toBe(
      "invalid-field",
    );
    const pace = encodeControlFrame({
      documentId: DOC,
      device: TAG,
      counter: 3,
      target: "pace",
      value: 30000,
      seen: {},
    });
    expect(reasonOf(written(pace, '"value":30000', '"value":3e4'))).toBe("invalid-field");
    expect(reasonOf(written(response, '"counter":1,"value":5000', '"counter":1,"value":5e3'))).toBe(
      "invalid-field",
    );
    expect(reasonOf(written(response, `"vector":{"${TAG}":2}`, `"vector":{"${TAG}":2.0}`))).toBe(
      "invalid-field",
    );
    expect(reasonOf(written(response, '"end":2', '"end":2.0'))).toBe("invalid-field");
    // Keys that are data — targets, MemberIds — hold integer fields, dots and all (FRM-9).
    const dotted = tampered(response, {
      control: {
        ...snapshot,
        targets: { "member:@bob:example.org": { seen: { [TAG]: 1 }, heads: [] } },
      },
      attribution: {
        ranges: [{ start: 0, end: 2, authorId: "bob@example.org" }],
        lastEditBySender: { "bob@example.org": 2 },
      },
    });
    expect(reasonOf(dotted)).toBe("decoded");
    expect(reasonOf(written(dotted, '"bob@example.org":2', '"bob@example.org":2.0'))).toBe(
      "invalid-field",
    );
    expect(reasonOf(written(dotted, `"seen":{"${TAG}":1}`, `"seen":{"${TAG}":1.0}`))).toBe(
      "invalid-field",
    );
    for (const frame of [edit, grant, heartbeat, pace, response]) {
      expect(reasonOf(frame)).toBe("decoded");
    }
  });

  it("leaves numbers in extension values as their sender wrote them (FRM-9)", () => {
    expect(reasonOf(tampered(grant, { "com.example.x/1": 1.5 }))).toBe("decoded");
    expect(
      reasonOf(written(tampered(grant, { "com.example.x/1": { a: 1 } }), '"a":1', '"a":-0')),
    ).toBe("decoded");
    expect(
      reasonOf(tampered(response, { control: { ...snapshot, "com.example.x/1": [2.5] } })),
    ).toBe("decoded");
    const inTarget = {
      ...snapshot.targets,
      close: { seen: {}, heads: [], "com.example.x/1": 0.5 },
    };
    expect(reasonOf(tampered(response, { control: { ...snapshot, targets: inTarget } }))).toBe(
      "decoded",
    );
    const inRange = {
      ranges: [{ start: 0, end: 2, authorId: "alice", "com.example.x/1": 1e-3 }],
      lastEditBySender: {},
    };
    expect(reasonOf(tampered(response, { attribution: inRange }))).toBe("decoded");
  });

  it("not-json: nested more than 32 deep (§1.6), however the rest of the frame looks", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) {
      deep = { nested: deep };
    }
    expect(reasonOf(tampered(grant, { "com.example.x": deep }))).toBe("not-json");
  });
});

describe("due: when a sender will speak again (SND-14)", () => {
  it("rides in every edit and control frame, 0 for no promise", () => {
    const edit = encodeEditFrame(DOC, new Uint8Array([1]), 20_000);
    expect(decodeFrame(edit)).toMatchObject({ kind: "edit", due: 20_000 });
    expect(reasonOf(tampered(edit, { due: undefined }))).toBe("missing-field");
    expect(reasonOf(tampered(edit, { due: -1 }))).toBe("invalid-field");
    expect(reasonOf(tampered(edit, { due: 2 ** 32 }))).toBe("invalid-field");
    expect(() => encodeEditFrame(DOC, new Uint8Array([1]), 1.5)).toThrow(/due/);
    const control = encodeControlFrame({
      documentId: DOC,
      device: "A".repeat(22),
      counter: 1,
      target: "close",
      value: true,
      seen: {},
      due: 60_000,
    });
    expect(decodeFrame(control)).toMatchObject({ kind: "control", due: 60_000 });
    expect(reasonOf(tampered(control, { due: undefined }))).toBe("missing-field");
  });
});
