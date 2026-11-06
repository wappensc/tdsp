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
      '{"tdsp":"de.wappensc.together.tdsp.probe.draft-10","kind":"edit","documentId":"doc-1","update":"AQID"}',
    );
    expect(CURRENT_FRAME_VERSION).toBe("de.wappensc.together.tdsp.probe.draft-10");
  });

  it("round-trips an edit, with a real Yjs update that still applies", () => {
    const frame = decodeFrame(encodeEditFrame(DOC, helloUpdate));
    expect(frame).toEqual({ kind: "edit", documentId: DOC, update: helloUpdate });
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
      '{"tdsp":"de.wappensc.together.tdsp.probe.draft-10","kind":"decline","documentId":"doc-1","reason":"unsupported-profile","profiles":["com.example.markdown/1"],"text":"My app cannot open this document."}',
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

  it("does not expose one inside a snapshot, its registers or an overlay", () => {
    const register = { value: "read", clock: [1, 0], device: "A".repeat(22), [MOOD]: "calm" };
    const response = encodeResyncResponseFrame({
      documentId: DOC,
      respondsTo: "0123456789abcdef",
      update: new Uint8Array([0, 0]),
      control: {
        profile: "yjs-paragraphs/1",
        closed: false,
        targets: { "member:bob": register },
        [MOOD]: "calm",
      },
      attribution: { ranges: [], lastEditBySender: {}, [MOOD]: "busy" },
    });
    const frame = decodeFrame(response, implemented);
    expect(frame.kind).toBe("resync-response");
    expect(frame.extensions).toBeUndefined();
    // Nor is it kept in the register (FRM-17): only `value`, `clock` and `device` are read.
    expect(
      frame.kind === "resync-response" ? frame.control?.targets["member:bob"] : undefined,
    ).toEqual({
      value: "read",
      clock: [1, 0],
      device: "A".repeat(22),
    });
  });

  it("writes them after the defined fields, and crit only for extensions the frame carries", () => {
    const text = encodeEditFrame(DOC, update, { fields: { [MOOD]: "calm" }, crit: [MOOD] });
    expect(Object.keys(JSON.parse(text))).toEqual([
      "tdsp",
      "kind",
      "documentId",
      "update",
      MOOD,
      "crit",
    ]);
    expect(decodeFrame(text, implemented).extensions).toEqual({ [MOOD]: "calm" });
    expect(
      Object.keys(
        JSON.parse(encodeEditFrame(DOC, update, { fields: { [MOOD]: "calm" }, crit: [] })),
      ),
    ).not.toContain("crit");
    expect(() => encodeEditFrame(DOC, update, { fields: { mood: "calm" }, crit: [] })).toThrow(
      /dot/,
    );
    expect(() => encodeEditFrame(DOC, update, { fields: {}, crit: [MOOD] })).toThrow(/crit/);
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

describe("registers, snapshots, heartbeats and requests (§4.3, §7)", () => {
  const TAG = "A".repeat(22);
  const OTHER = "B".repeat(22);
  const empty = Y.encodeStateVector(new Y.Doc());
  const T = 1_793_008_800_000;
  const bob = { value: "write" as const, clock: [T, 0] as const, device: TAG };
  const STATE = "00112233aabbccdd";
  const CONTROL = "ffeeddcc44332211";
  const STREAM = "5eed5eed5eed5eed";
  const grant = encodeControlFrame({
    documentId: DOC,
    device: TAG,
    targets: { "member:bob": bob },
    closed: false,
    controlClock: [T, 0],
    controlDigest: CONTROL,
  });
  const heartbeat = encodeHeartbeatFrame({
    documentId: DOC,
    controlClock: [T, 0],
    controlDigest: CONTROL,
    stateVector: empty,
    stateDigest: STATE,
    stream: STREAM,
    sequence: 7,
  });
  const request = encodeResyncRequestFrame({
    documentId: DOC,
    requestId: "0123456789abcdef",
    controlClock: null,
    controlDigest: null,
    all: false,
    force: false,
    stateDigest: STATE,
    stateVector: empty,
    stream: STREAM,
    sequence: 8,
  });
  const snapshot = {
    profile: "yjs-paragraphs/1",
    closed: false,
    targets: {
      "member:bob": { value: "write", clock: [T, 0], device: TAG },
      pace: { value: 5000, clock: [T, 1], device: OTHER },
    },
  };
  const response = encodeResyncResponseFrame({
    documentId: DOC,
    respondsTo: "0123456789abcde7",
    update: helloUpdate,
    control: snapshot,
    attribution: { ranges: [{ start: 0, end: 2, authorId: "alice" }], lastEditBySender: {} },
  });
  const withSnapshot = (control: unknown) => tampered(response, { control });
  /** `grant` with its one register changed. */
  const withRegister = (register: unknown) =>
    tampered(grant, { targets: { "member:bob": register } });

  it("round-trips a register on every kind of target (CTL-20)", () => {
    expect(grant).toBe(
      `{"tdsp":"${CURRENT_FRAME_VERSION}","kind":"control","documentId":"doc-1","device":"${TAG}","targets":{"member:bob":{"value":"write","clock":[${T},0],"device":"${TAG}"}},"closed":false,"controlClock":[${T},0],"controlDigest":"${CONTROL}"}`,
    );
    for (const [target, value] of [
      ["member:bob", "read"],
      ["member:bob", null],
      ["layer:com.example.comments/1:member:bob", "write"],
      ["layer:com.example.comments/1:member:bob", null],
      ["pace", 30000],
      ["pace", 0],
    ] as const) {
      const register = { value, clock: [T, 3] as const, device: OTHER };
      const frame = encodeControlFrame({
        documentId: DOC,
        device: TAG,
        targets: { [target]: register },
        closed: false,
        controlClock: [T, 3],
        controlDigest: CONTROL,
      });
      expect(decodeFrame(frame)).toEqual({
        kind: "control",
        documentId: DOC,
        device: TAG,
        targets: { [target]: register },
        closed: false,
        controlClock: [T, 3],
        controlDigest: CONTROL,
      });
    }
  });

  it("writes a frame's registers in one spelling: targets in code unit order, each value, clock, device", () => {
    const frame = encodeControlFrame({
      documentId: DOC,
      device: TAG,
      targets: {
        pace: { device: TAG, clock: [T, 2], value: 1000 } as never,
        "member:carol": { clock: [T, 1], value: "read", device: TAG } as never,
        "layer:com.example.comments/1:member:bob": { value: "write", clock: [T, 0], device: TAG },
      },
      closed: false,
      controlClock: [T, 2],
      controlDigest: CONTROL,
    });
    expect(frame).toContain(
      `"targets":{"layer:com.example.comments/1:member:bob":{"value":"write","clock":[${T},0],"device":"${TAG}"},"member:carol":{"value":"read","clock":[${T},1],"device":"${TAG}"},"pace":{"value":1000,"clock":[${T},2],"device":"${TAG}"}}`,
    );
  });

  it("carries the close as a flag: a frame without registers carries it, one with registers may (CTL-20, CTL-23)", () => {
    const close = encodeControlFrame({
      documentId: DOC,
      device: TAG,
      targets: {},
      closed: true,
      controlClock: [T, 0],
      controlDigest: CONTROL,
    });
    expect(decodeFrame(close)).toEqual({
      kind: "control",
      documentId: DOC,
      device: TAG,
      targets: {},
      closed: true,
      controlClock: [T, 0],
      controlDigest: CONTROL,
    });
    expect(decodeFrame(tampered(grant, { closed: true }))).toMatchObject({ closed: true });
    // A frame with nothing decided is no frame.
    expect(reasonOf(tampered(close, { closed: false }))).toBe("invalid-field");
    expect(() =>
      encodeControlFrame({
        documentId: DOC,
        device: TAG,
        targets: {},
        closed: false,
        controlClock: null,
        controlDigest: null,
      }),
    ).toThrow(/register, or the close/);
  });

  it("carries a control clock and its digest together, or neither — neither from a device not bootstrapped (RSY-14, LOS-24)", () => {
    const notBootstrapped = encodeControlFrame({
      documentId: DOC,
      device: TAG,
      targets: { "member:bob": bob },
      closed: false,
      controlClock: null,
      controlDigest: null,
    });
    expect(decodeFrame(notBootstrapped)).toMatchObject({ controlClock: null, controlDigest: null });
    expect(reasonOf(tampered(notBootstrapped, { controlDigest: CONTROL }))).toBe("invalid-field");
    expect(reasonOf(tampered(grant, { controlDigest: null }))).toBe("invalid-field");
    expect(reasonOf(tampered(grant, { controlClock: null }))).toBe("invalid-field");
    expect(() =>
      encodeControlFrame({
        documentId: DOC,
        device: TAG,
        targets: { "member:bob": bob },
        closed: false,
        controlClock: [T, 0],
        controlDigest: null,
      }),
    ).toThrow(/control digest/);
  });

  it("round-trips a heartbeat with a control clock, and one without (SND-11)", () => {
    expect(heartbeat).toBe(
      `{"tdsp":"${CURRENT_FRAME_VERSION}","kind":"heartbeat","documentId":"doc-1","controlClock":[${T},0],"controlDigest":"${CONTROL}","stateVector":"AA==","stateDigest":"${STATE}","stream":"${STREAM}","sequence":7}`,
    );
    expect(decodeFrame(heartbeat)).toEqual({
      kind: "heartbeat",
      documentId: DOC,
      controlClock: [T, 0],
      controlDigest: CONTROL,
      stateVector: empty,
      stateDigest: STATE,
      stream: STREAM,
      sequence: 7,
    });
    const plain = encodeHeartbeatFrame({
      documentId: DOC,
      controlClock: null,
      controlDigest: null,
      stateVector: empty,
      stateDigest: STATE,
    });
    expect(decodeFrame(plain)).toMatchObject({ controlClock: null, controlDigest: null });
    // A control digest goes with a control clock, and a digest is 16 lowercase hex digits (LOS-24).
    expect(reasonOf(tampered(plain, { controlDigest: CONTROL }))).toBe("invalid-field");
    expect(reasonOf(tampered(heartbeat, { controlDigest: null }))).toBe("invalid-field");
    expect(reasonOf(tampered(heartbeat, { controlDigest: "FFEEDDCC44332211" }))).toBe(
      "invalid-field",
    );
    expect(reasonOf(tampered(heartbeat, { stateDigest: "00112233AABBCCDD" }))).toBe(
      "invalid-field",
    );
    expect(reasonOf(tampered(heartbeat, { stateDigest: undefined }))).toBe("missing-field");
  });

  it("round-trips a heartbeat that carries its sender's last update after its sequence, and one without; the update is never null or empty (§4.3)", () => {
    const carrying = encodeHeartbeatFrame({
      documentId: DOC,
      controlClock: null,
      controlDigest: null,
      stateVector: empty,
      stateDigest: STATE,
      stream: STREAM,
      sequence: 3,
      update: helloUpdate,
    });
    expect(Object.keys(JSON.parse(carrying)).slice(-3)).toEqual(["stream", "sequence", "update"]);
    expect(decodeFrame(carrying)).toEqual({
      kind: "heartbeat",
      documentId: DOC,
      controlClock: null,
      controlDigest: null,
      stateVector: empty,
      stateDigest: STATE,
      stream: STREAM,
      sequence: 3,
      update: helloUpdate,
    });
    // Without one the field is absent, and the frame reads without it.
    expect(Object.keys(JSON.parse(heartbeat))).not.toContain("update");
    expect(Object.hasOwn(decodeFrame(heartbeat), "update")).toBe(false);
    for (const update of [null, "", "AQ", 7]) {
      expect(reasonOf(tampered(carrying, { update })), String(update)).toBe("invalid-field");
    }
    expect(() =>
      encodeHeartbeatFrame({
        documentId: DOC,
        controlClock: null,
        controlDigest: null,
        stateVector: empty,
        stateDigest: STATE,
        update: new Uint8Array(),
      }),
    ).toThrow(/never empty/);
  });

  it("round-trips a request that states nothing, and one that states its clock, asks all and asks regardless (RSY-16)", () => {
    expect(request).toBe(
      `{"tdsp":"${CURRENT_FRAME_VERSION}","kind":"resync-request","documentId":"doc-1","requestId":"0123456789abcdef","controlClock":null,"controlDigest":null,"all":false,"force":false,"stateVector":"AA==","stateDigest":"00112233aabbccdd","stream":"${STREAM}","sequence":8}`,
    );
    const forced = encodeResyncRequestFrame({
      documentId: DOC,
      requestId: "0123456789abcdef",
      controlClock: [T, 4],
      controlDigest: CONTROL,
      all: true,
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
      controlClock: [T, 4],
      controlDigest: CONTROL,
      all: true,
      force: true,
      stateVector: empty,
      stateDigest: STATE,
      stream: STREAM,
      sequence: 1,
    });
    expect(reasonOf(tampered(request, { controlDigest: CONTROL }))).toBe("invalid-field");
    expect(reasonOf(tampered(forced, { controlClock: null }))).toBe("invalid-field");
  });

  it("round-trips a snapshot of registers with its attribution overlay (§7.5, CTL-25)", () => {
    expect(decodeFrame(response)).toMatchObject({
      kind: "resync-response",
      control: snapshot,
      stateVector: null,
      stateDigest: null,
    });
    expect(response).toContain(
      `"control":{"profile":"yjs-paragraphs/1","closed":false,"targets":{`,
    );
    const closedEmpty = { ...snapshot, closed: true, targets: {} };
    expect(decodeFrame(withSnapshot(closedEmpty))).toMatchObject({ control: closedEmpty });
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
    const unstated = { controlClock: null, controlDigest: null };
    expect(() =>
      encodeHeartbeatFrame({
        documentId: DOC,
        ...unstated,
        stateVector: empty,
        stateDigest: STATE,
        stream: "x",
      }),
    ).toThrow(/stream/);
    expect(() =>
      encodeHeartbeatFrame({
        documentId: DOC,
        ...unstated,
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
          ...unstated,
          stateVector: empty,
          stateDigest: STATE,
        }),
      ),
    ).toMatchObject({
      stream: expect.stringMatching(/^[0-9a-f]{16}$/),
      sequence: 1,
    });
  });

  it("refuses to write a register that is not one, or a target that is none (CTL-20, CTL-45)", () => {
    const base = {
      documentId: DOC,
      device: TAG,
      closed: false,
      controlClock: [T, 0] as const,
      controlDigest: CONTROL,
    };
    const one = (target: string, register: unknown) =>
      encodeControlFrame({ ...base, targets: { [target]: register } as never });
    expect(() =>
      encodeControlFrame({ ...base, device: "short", targets: { "member:bob": bob } }),
    ).toThrow(/device tag/);
    // The close is a flag, no target (§7.1).
    expect(() => one("close", { value: true, clock: [T, 0], device: TAG })).toThrow(
      /control target/,
    );
    expect(() => one("policy", bob)).toThrow(/control target/);
    expect(() => one("member:bob", { ...bob, value: true })).toThrow(/register/);
    expect(() => one("pace", { ...bob, value: -1 })).toThrow(/register/);
    expect(() => one("pace", { ...bob, value: "write" })).toThrow(/register/);
    // The reason for the close: any string of 1 to 128 UTF-8 bytes, what it names is its application's
    // (CTL-23, VER-5).
    for (const value of [
      "finished",
      "com.example.moved/1",
      "expired",
      "Fertig!",
      "é".repeat(64),
      "x".repeat(128),
    ]) {
      expect(() => one("close-reason", { ...bob, value }), value).not.toThrow();
    }
    for (const value of ["", 3, null, "x".repeat(129), "é".repeat(65)]) {
      expect(() => one("close-reason", { ...bob, value }), String(value)).toThrow(/register/);
    }
    expect(() => one("member:bob", { ...bob, device: "short" })).toThrow(/register/);
    for (const clock of [[T], [T, 0, 0], [-1, 0], [2 ** 48, 0], [0, 65_536], [1.5, 0]]) {
      expect(() => one("member:bob", { ...bob, clock }), JSON.stringify(clock)).toThrow(/register/);
    }
    expect(() =>
      encodeControlFrame({ ...base, targets: { "member:bob": bob }, controlClock: [T, 65_536] }),
    ).toThrow(/control clock/);
    expect(() => one(`member:${"x".repeat(256)}`, bob)).toThrow(/member id/);
    expect(() => one("layer:Comments:member:bob", bob)).toThrow(/control target/);
    // At most 5 002 targets: 5 000 members and rights on layers, the pace and the reason for the close
    // (CTL-30).
    const many = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`member:m${i}`, bob]));
    expect(() => encodeControlFrame({ ...base, targets: many(5_002) })).not.toThrow();
    expect(() => encodeControlFrame({ ...base, targets: many(5_003) })).toThrow(/5002 targets/);
    expect(() => encodeEditFrame(DOC, new Uint8Array())).toThrow(/update/);
    expect(() => encodeEditFrame("", new Uint8Array([1]))).toThrow(/documentId/);
  });

  it("reads a right on a layer like a member's, and a malformed one as no target (LAY-5)", () => {
    const target = "layer:com.example.comments/1:member:bob";
    const layer = encodeControlFrame({
      documentId: DOC,
      device: TAG,
      targets: { [target]: { ...bob, value: "read" } },
      closed: false,
      controlClock: [T, 0],
      controlDigest: CONTROL,
    });
    expect(decodeFrame(layer)).toMatchObject({ targets: { [target]: { value: "read" } } });
    const renamed = (name: string) => tampered(layer, { targets: { [name]: bob } });
    expect(reasonOf(renamed("layer:Comments:member:bob"))).toBe("invalid-field");
    expect(reasonOf(renamed("layer:com.example.comments/1:member:"))).toBe("invalid-field");
    expect(reasonOf(renamed(`member:${"x".repeat(256)}`))).toBe("invalid-field");
    expect(reasonOf(renamed("member:"))).toBe("invalid-field");
  });

  it("missing-field, for each required field of the kinds this draft defines anew", () => {
    for (const field of ["device", "targets", "closed", "controlClock", "controlDigest"]) {
      expect(reasonOf(tampered(grant, { [field]: undefined })), field).toBe("missing-field");
    }
    for (const field of ["controlClock", "controlDigest", "stateVector"]) {
      expect(reasonOf(tampered(heartbeat, { [field]: undefined })), field).toBe("missing-field");
    }
    for (const field of [
      "requestId",
      "controlClock",
      "controlDigest",
      "all",
      "force",
      "stateVector",
    ]) {
      expect(reasonOf(tampered(request, { [field]: undefined })), field).toBe("missing-field");
    }
    for (const field of ["profile", "closed", "targets"]) {
      expect(reasonOf(withSnapshot({ ...snapshot, [field]: undefined })), field).toBe(
        "missing-field",
      );
    }
    for (const field of ["value", "clock", "device"]) {
      expect(reasonOf(withRegister({ ...bob, [field]: undefined })), field).toBe("missing-field");
    }
  });

  it("invalid-field: a field of an earlier draft or of 1.x, a wrong type, a value that does not fit its target", () => {
    for (const [field, value] of [
      ["counter", 1],
      ["target", "member:bob"],
      ["value", "write"],
      ["seen", {}],
      ["sequence", 1],
    ] as const) {
      expect(reasonOf(tampered(grant, { [field]: value })), field).toBe("invalid-field");
    }
    expect(reasonOf(tampered(heartbeat, { control: { [TAG]: 2 } }))).toBe("invalid-field");
    expect(reasonOf(tampered(heartbeat, { controlSequence: 0 }))).toBe("invalid-field");
    expect(reasonOf(tampered(request, { control: null }))).toBe("invalid-field");
    expect(reasonOf(tampered(request, { bootstrap: true }))).toBe("invalid-field");
    expect(reasonOf(tampered(grant, { device: "not a tag" }))).toBe("invalid-field");
    expect(reasonOf(tampered(grant, { targets: [bob] }))).toBe("invalid-field");
    expect(reasonOf(tampered(grant, { targets: { policy: bob } }))).toBe("invalid-field");
    // The close is a flag, no target (§7.1).
    expect(reasonOf(tampered(grant, { targets: { close: { ...bob, value: true } } }))).toBe(
      "invalid-field",
    );
    expect(reasonOf(withRegister({ ...bob, value: true }))).toBe("invalid-field");
    expect(reasonOf(tampered(grant, { targets: { pace: bob } }))).toBe("invalid-field");
    expect(reasonOf(tampered(grant, { targets: { pace: { ...bob, value: 2 ** 32 } } }))).toBe(
      "invalid-field",
    );
    expect(reasonOf(tampered(grant, { closed: "no" }))).toBe("invalid-field");
    expect(reasonOf(tampered(request, { all: "yes" }))).toBe("invalid-field");
    expect(reasonOf(tampered(request, { all: 1 }))).toBe("invalid-field");
    expect(reasonOf(tampered(request, { force: "yes" }))).toBe("invalid-field");
  });

  it("invalid-field: a clock that is not an array of exactly two integers in their ranges (CTL-45)", () => {
    const bad: unknown[] = [
      [1],
      [1, 2, 3],
      [-1, 0],
      [2 ** 48, 0],
      [0, 65_536],
      [0, -1],
      [1.5, 0],
      "1,0",
      1,
      {},
      ["1", 0],
      [],
    ];
    for (const clock of bad) {
      const label = JSON.stringify(clock);
      expect(reasonOf(withRegister({ ...bob, clock })), label).toBe("invalid-field");
      expect(reasonOf(tampered(grant, { controlClock: clock })), label).toBe("invalid-field");
      expect(reasonOf(tampered(heartbeat, { controlClock: clock })), label).toBe("invalid-field");
      expect(
        reasonOf(tampered(request, { controlClock: clock, controlDigest: CONTROL })),
        label,
      ).toBe("invalid-field");
    }
    // A register's clock is never null: only the frame's own control clock may be.
    expect(reasonOf(withRegister({ ...bob, clock: null }))).toBe("invalid-field");
    // The ends of the ranges are clocks.
    const last = [2 ** 48 - 1, 65_535];
    expect(reasonOf(withRegister({ ...bob, clock: last }))).toBe("decoded");
    expect(reasonOf(withRegister({ ...bob, clock: [0, 0] }))).toBe("decoded");
    expect(reasonOf(tampered(heartbeat, { controlClock: last }))).toBe("decoded");
  });

  it("invalid-field: a register that is not exactly value, clock and device; an extension in it is ignored (CTL-20, FRM-9)", () => {
    expect(reasonOf(withRegister({ ...bob, note: 1 }))).toBe("invalid-field");
    expect(reasonOf(withRegister({ ...bob, counter: 1 }))).toBe("invalid-field");
    expect(reasonOf(withRegister({ ...bob, device: "x" }))).toBe("invalid-field");
    expect(reasonOf(withRegister({ ...bob, device: 7 }))).toBe("invalid-field");
    expect(reasonOf(withRegister("write"))).toBe("invalid-field");
    expect(reasonOf(withRegister(null))).toBe("invalid-field");
    expect(reasonOf(withRegister([bob]))).toBe("invalid-field");
    const extended = decodeFrame(withRegister({ ...bob, "com.example.x/1": { any: 1 } }));
    expect(extended.kind === "control" ? extended.targets : undefined).toEqual({
      "member:bob": { value: "write", clock: [T, 0], device: TAG },
    });
  });

  it("invalid-field: a snapshot that breaks its layout anywhere rejects the whole response", () => {
    // A field this layout does not define, `vector`, `aboveHoles` and `sequence` among them (§7.5).
    expect(reasonOf(withSnapshot({ ...snapshot, vector: {} }))).toBe("invalid-field");
    expect(reasonOf(withSnapshot({ ...snapshot, aboveHoles: {} }))).toBe("invalid-field");
    expect(reasonOf(withSnapshot({ ...snapshot, sequence: 1 }))).toBe("invalid-field");
    expect(reasonOf(withSnapshot({ ...snapshot, profile: "Yjs" }))).toBe("invalid-field");
    expect(reasonOf(withSnapshot({ ...snapshot, closed: 0 }))).toBe("invalid-field");
    // A snapshot holds `profile`, `closed` and `targets`, nothing else: any other field is invalid (§7.5, FRM-6).
    expect(reasonOf(withSnapshot({ ...snapshot, confirmed: true }))).toBe("invalid-field");
    expect(reasonOf(withSnapshot({ ...snapshot, targets: [] }))).toBe("invalid-field");
    expect(reasonOf(withSnapshot({ ...snapshot, targets: { policy: bob } }))).toBe("invalid-field");
    expect(
      reasonOf(withSnapshot({ ...snapshot, targets: { close: { ...bob, value: true } } })),
    ).toBe("invalid-field");
    expect(
      reasonOf(
        withSnapshot({ ...snapshot, targets: { "member:bob": { ...bob, clock: [T, 65_536] } } }),
      ),
    ).toBe("invalid-field");
    // A target of operations and heads, not a register, lacks a register's fields (CTL-20, §7.5).
    expect(
      reasonOf(withSnapshot({ ...snapshot, targets: { "member:bob": { seen: {}, heads: [] } } })),
    ).toBe("missing-field");
  });

  it("holds at most 5 002 targets in a frame or a snapshot (CTL-30, §7.5)", () => {
    const many = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`member:m${i}`, bob]));
    expect(reasonOf(tampered(grant, { targets: many(5_002) }))).toBe("decoded");
    expect(reasonOf(tampered(grant, { targets: many(5_003) }))).toBe("invalid-field");
    expect(reasonOf(withSnapshot({ ...snapshot, targets: many(5_002) }))).toBe("decoded");
    expect(reasonOf(withSnapshot({ ...snapshot, targets: many(5_003) }))).toBe("invalid-field");
  });

  it("not-json: a target named twice, so that a frame or a snapshot holds one register per target (§1.6)", () => {
    const register = JSON.stringify(bob);
    expect(
      reasonOf(
        grant.replace(
          `"targets":{"member:bob":${register}}`,
          `"targets":{"member:bob":${register},"member:bob":${JSON.stringify({ ...bob, value: "read" })}}`,
        ),
      ),
    ).toBe("not-json");
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

  /** `frame` with `from` written as `to`, which must be there to replace. */
  const written = (frame: string, from: string, to: string): string => {
    expect(frame.includes(from), from).toBe(true);
    return frame.replace(from, to);
  };

  it("invalid-field: an integer field written with a fraction or an exponent, or as -0 (§1.6, §4.3)", () => {
    for (const sequence of ["7.0", "7e0", "7E0", "0.7e1", "7e+0"]) {
      expect(reasonOf(written(heartbeat, '"sequence":7', `"sequence":${sequence}`)), sequence).toBe(
        "invalid-field",
      );
    }
    // Inside a clock, a register's and a frame's own (CTL-45).
    const clock = `"clock":[${T},0]`;
    for (const spelling of [
      `[${T}.0,0]`,
      "[1.7930088e12,0]",
      `[${T},0.0]`,
      `[${T},-0]`,
      `[${T},0e0]`,
    ]) {
      expect(reasonOf(written(grant, clock, `"clock":${spelling}`)), spelling).toBe(
        "invalid-field",
      );
    }
    expect(reasonOf(written(grant, `"controlClock":[${T},0]`, `"controlClock":[${T},0E0]`))).toBe(
      "invalid-field",
    );
    expect(
      reasonOf(written(heartbeat, `"controlClock":[${T},0]`, `"controlClock":[1.7930088E12,0]`)),
    ).toBe("invalid-field");
    const pace = encodeControlFrame({
      documentId: DOC,
      device: TAG,
      targets: { pace: { value: 30000, clock: [T, 1], device: TAG } },
      closed: false,
      controlClock: [T, 1],
      controlDigest: CONTROL,
    });
    expect(reasonOf(written(pace, '"value":30000', '"value":3e4'))).toBe("invalid-field");
    expect(reasonOf(written(response, '"value":5000', '"value":5e3'))).toBe("invalid-field");
    expect(reasonOf(written(response, `"clock":[${T},1]`, `"clock":[${T},1.0]`))).toBe(
      "invalid-field",
    );
    expect(reasonOf(written(response, '"end":2', '"end":2.0'))).toBe("invalid-field");
    // Keys that are data — targets, MemberIds — hold integer fields, dots and all (FRM-9).
    const dotted = tampered(response, {
      control: {
        ...snapshot,
        targets: { "member:@bob:example.org": { value: "read", clock: [T, 7], device: TAG } },
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
    expect(reasonOf(written(dotted, `"clock":[${T},7]`, `"clock":[${T},7.0]`))).toBe(
      "invalid-field",
    );
    for (const frame of [grant, heartbeat, pace, response]) {
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
    expect(reasonOf(withRegister({ ...bob, "com.example.x/1": 0.5 }))).toBe("decoded");
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

describe("no frame says when its sender speaks again (§4.3)", () => {
  it("an edit or control frame carrying due is refused: a field without a dot it does not define (FRM-5)", () => {
    const edit = encodeEditFrame(DOC, new Uint8Array([1]));
    expect(Object.keys(JSON.parse(edit))).not.toContain("due");
    expect(reasonOf(tampered(edit, { due: 0 }))).toBe("invalid-field");
    const control = encodeControlFrame({
      documentId: DOC,
      device: "A".repeat(22),
      targets: {},
      closed: true,
      controlClock: null,
      controlDigest: null,
    });
    expect(Object.keys(JSON.parse(control))).not.toContain("due");
    expect(reasonOf(tampered(control, { due: 60_000 }))).toBe("invalid-field");
  });
});
