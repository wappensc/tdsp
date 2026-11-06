import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applyUpdate,
  createDocument,
  encodeDeletions,
  encodeDeletionsWithin,
  encodeStateVector,
  encodeUpdate,
  encodeUpdateSince,
  getFragment,
  insertPlainText,
  isStateVector,
  isUpdate,
  type ReconciledDocument,
} from "./index";

/** Hex, with spaces for reading, to bytes. */
const hex = (text: string): Uint8Array =>
  new Uint8Array(
    (text.replace(/ /g, "").match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16)),
  );

const varUint = (value: number): number[] => {
  const out: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  out.push(rest);
  return out;
};

const string = (text: string): number[] => {
  const bytes = [...new TextEncoder().encode(text)];
  return [...varUint(bytes.length), ...bytes];
};

/** An update of one item of client 1 at clock 0 in the top-level type `a`, of content `kind` written as `content`. */
const oneItem = (kind: number, content: readonly number[]): Uint8Array =>
  new Uint8Array([1, 1, 1, 0, kind, 1, ...string("a"), ...content, 0]);

/** An array of arrays, `levels` deep, as text. */
const nestedText = (levels: number): string => "[".repeat(levels) + "]".repeat(levels);

/** The same as an `Any` value: `levels` arrays, each holding the next, the innermost empty. */
const nestedAny = (levels: number): number[] => [
  ...Array.from({ length: levels - 1 }, () => [117, 1]).flat(),
  117,
  0,
];

describe("a variable-length integer above 2^53 − 1 is no update and no state vector (Appendix A)", () => {
  it("refuses a client id of 2^53 and of about 2^56, which lib0 reads, and takes 2^53 − 1", () => {
    expect(isUpdate(hex("01 00 ff ff ff ff ff ff ff 0f 00 00"))).toBe(true);
    expect(isUpdate(hex("01 00 80 80 80 80 80 80 80 10 00 00"))).toBe(false);
    expect(isUpdate(hex("01 00 ff ff ff ff ff ff ff 7f 00 00"))).toBe(false);
  });

  it("refuses one longer than 8 bytes, whatever its value, and takes 8 bytes of value 1", () => {
    expect(isUpdate(hex("01 00 81 80 80 80 80 80 80 00 00 00"))).toBe(true);
    expect(isUpdate(hex("01 00 81 80 80 80 80 80 80 80 00 00 00"))).toBe(false);
    expect(isUpdate(hex("01 00 80 80 80 80 80 80 80 80 00 00 00"))).toBe(false);
    // A clock padded to 151 bytes, which lib0 reads as NaN.
    const padded = [
      1,
      1,
      1,
      ...Array.from({ length: 150 }, () => 0x80),
      0,
      4,
      1,
      1,
      0x61,
      1,
      0x78,
      0,
    ];
    expect(isUpdate(new Uint8Array(padded))).toBe(false);
    // Signed: the first byte holds six bits, so 2^53 − 1 takes 8 bytes too.
    expect(isUpdate(oneItem(8, [1, 125, ...hex("81 80 80 80 80 80 80 00")]))).toBe(true);
    expect(isUpdate(oneItem(8, [1, 125, ...hex("81 80 80 80 80 80 80 80 00")]))).toBe(false);
    expect(isStateVector(hex("01 01 81 80 80 80 80 80 80 80 00"))).toBe(false);
    expect(isStateVector(hex("01 01 81 80 80 80 80 80 80 00"))).toBe(true);
  });

  it("refuses one anywhere: a clock, a delete range, a string's length and a signed integer in an Any value", () => {
    expect(isUpdate(hex("01 00 01 80 80 80 80 80 80 80 10 00"))).toBe(false);
    expect(isUpdate(hex("00 01 01 01 80 80 80 80 80 80 80 10 01"))).toBe(false);
    expect(isUpdate(hex("00 01 01 01 fe ff ff ff ff ff ff 0f 01"))).toBe(true);
    expect(isUpdate(oneItem(4, [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x10]))).toBe(false);
    // 125: an integer; the first byte holds six bits, the sign and the continuation.
    expect(isUpdate(oneItem(8, [1, 125, ...hex("bf ff ff ff ff ff ff 1f")]))).toBe(true);
    expect(isUpdate(oneItem(8, [1, 125, ...hex("80 80 80 80 80 80 80 20")]))).toBe(false);
    expect(isUpdate(oneItem(8, [1, 125, ...hex("c0 80 80 80 80 80 80 20")]))).toBe(false);
  });

  it("refuses a state vector with a client id or a clock of 2^53, and takes 2^53 − 1", () => {
    expect(isStateVector(hex("01 ff ff ff ff ff ff ff 0f 00"))).toBe(true);
    expect(isStateVector(hex("01 80 80 80 80 80 80 80 10 00"))).toBe(false);
    expect(isStateVector(hex("01 01 80 80 80 80 80 80 80 10"))).toBe(false);
    expect(isStateVector(hex("80 80 80 80 80 80 80 10"))).toBe(false);
  });
});

/** 2^53 − 1, the largest clock a state vector may carry (Appendix A). */
const MAX = Number.MAX_SAFE_INTEGER;

/** One client block of client 1 from clock 0: a collected struct of `length`, then `then`, then an empty delete set. */
const afterGc = (length: number, then: readonly number[] = [], structs = 1): Uint8Array =>
  new Uint8Array([1, 1 + structs, 1, 0, 0, ...varUint(length), ...then, 0]);

/** An item of client 1 in the top-level type `a`, of content `kind` written as `content`. */
const item = (kind: number, content: readonly number[]): number[] => [
  kind,
  1,
  ...string("a"),
  ...content,
];

describe("a client's structs and a delete range end at most at 2^53 − 1 (Appendix A)", () => {
  it("refuses two collected structs that end at 2^53, each length within bounds, and takes the end 2^53 − 1", () => {
    expect(isUpdate(hex("01 02 01 00 00 ff ff ff ff ff ff ff 0f 00 01 00"))).toBe(false);
    expect(isUpdate(hex("01 02 01 00 00 fe ff ff ff ff ff ff 0f 00 01 00"))).toBe(true);
    expect(isUpdate(hex("01 01 01 00 00 ff ff ff ff ff ff ff 0f 00"))).toBe(true);
  });

  it("adds the clock of the first struct: an item of length 1 at 2^53 − 1 ends beyond, at 2^53 − 2 it does not", () => {
    expect(isUpdate(new Uint8Array([1, 1, 1, ...varUint(MAX), ...item(4, string("x")), 0]))).toBe(
      false,
    );
    expect(
      isUpdate(new Uint8Array([1, 1, 1, ...varUint(MAX - 1), ...item(4, string("x")), 0])),
    ).toBe(true);
    // No struct: the block ends where it starts.
    expect(isUpdate(new Uint8Array([1, 0, 1, ...varUint(MAX), 0]))).toBe(true);
  });

  it("counts each content's length as the encoding does: a string in UTF-16 code units", () => {
    expect(isUpdate(afterGc(MAX - 3, item(4, string("abc"))))).toBe(true);
    expect(isUpdate(afterGc(MAX - 3, item(4, string("abcd"))))).toBe(false);
    // U+1F600 is four bytes of UTF-8, one code point and two UTF-16 code units.
    expect(isUpdate(afterGc(MAX - 2, item(4, string("😀"))))).toBe(true);
    expect(isUpdate(afterGc(MAX - 1, item(4, string("😀"))))).toBe(false);
    expect(isUpdate(afterGc(MAX - 3, item(4, string("é€"))))).toBe(true);
    expect(isUpdate(afterGc(MAX - 1, item(4, string("é€"))))).toBe(false);
  });

  it("counts deleted content by its length, JSON and Any content by their entries, every other kind as one", () => {
    expect(isUpdate(afterGc(MAX - 5, item(1, [5])))).toBe(true);
    expect(isUpdate(afterGc(MAX - 5, item(1, [6])))).toBe(false);
    expect(isUpdate(afterGc(MAX - 2, item(2, [2, ...string("1"), ...string("2")])))).toBe(true);
    expect(isUpdate(afterGc(MAX - 1, item(2, [2, ...string("1"), ...string("2")])))).toBe(false);
    expect(isUpdate(afterGc(MAX - 2, item(8, [2, 120, 121])))).toBe(true);
    expect(isUpdate(afterGc(MAX - 1, item(8, [2, 120, 121])))).toBe(false);
    expect(isUpdate(afterGc(MAX - 1, item(3, [1, 0x2a])))).toBe(true);
    expect(isUpdate(afterGc(MAX, item(3, [1, 0x2a])))).toBe(false);
    expect(isUpdate(afterGc(MAX, item(7, [1])))).toBe(false);
  });

  it("counts a skip, which Yjs advances the clock by too", () => {
    expect(isUpdate(afterGc(MAX - 1, [10, 1]))).toBe(true);
    expect(isUpdate(afterGc(MAX, [10, 1]))).toBe(false);
  });

  it("checks each client's block on its own", () => {
    const block = (client: number, length: number): number[] => [
      1,
      client,
      0,
      0,
      ...varUint(length),
    ];
    expect(isUpdate(new Uint8Array([2, ...block(2, MAX), ...block(1, MAX), 0]))).toBe(true);
    expect(
      isUpdate(new Uint8Array([2, ...block(2, MAX), 2, 1, 0, 0, ...varUint(MAX), 0, 1, 0])),
    ).toBe(false);
  });

  it("refuses a delete range whose clock plus length is beyond 2^53 − 1, each number within bounds", () => {
    expect(isUpdate(new Uint8Array([0, 1, 1, 1, ...varUint(MAX - 1), 1]))).toBe(true);
    expect(isUpdate(new Uint8Array([0, 1, 1, 1, ...varUint(MAX), 1]))).toBe(false);
    expect(isUpdate(new Uint8Array([0, 1, 1, 1, 0, ...varUint(MAX)]))).toBe(true);
    expect(isUpdate(new Uint8Array([0, 1, 1, 1, 1, ...varUint(MAX)]))).toBe(false);
    // The second range of a client, after one that is within bounds.
    expect(isUpdate(new Uint8Array([0, 1, 1, 2, 0, 1, ...varUint(MAX - 1), 2]))).toBe(false);
  });
});

describe("an update that is read leaves a replica whose reports are read again (Appendix A)", () => {
  /** Every report the replica writes reads again: its state vector, its updates and its deletions. */
  const reportsRead = (doc: ReconciledDocument): boolean => {
    const vector = encodeStateVector(doc);
    return (
      isStateVector(vector) &&
      isUpdate(encodeUpdate(doc)) &&
      isUpdate(encodeUpdateSince(doc, new Uint8Array([0]))) &&
      isUpdate(encodeUpdateSince(doc, vector)) &&
      isUpdate(encodeDeletions(doc)) &&
      isUpdate(encodeDeletionsWithin(doc, vector))
    );
  };

  // Each ends a client, or a delete range, at 2^53 − 1 exactly.
  const atTheBound = [
    hex("01 02 01 00 00 fe ff ff ff ff ff ff 0f 00 01 00"),
    afterGc(MAX - 3, item(4, string("abc"))),
    afterGc(MAX - 2, item(4, string("😀"))),
    afterGc(MAX - 5, item(1, [5])),
    afterGc(MAX - 2, item(8, [2, 120, 121])),
    // "abc" up to the bound, its "c" deleted.
    new Uint8Array([
      1,
      2,
      1,
      0,
      0,
      ...varUint(MAX - 3),
      ...item(4, string("abc")),
      1,
      1,
      1,
      ...varUint(MAX - 1),
      1,
    ]),
    new Uint8Array([0, 1, 1, 1, ...varUint(MAX - 1), 1]),
  ];

  it("at 2^53 − 1, alone, all together and after an edit of its own", () => {
    const all = createDocument();
    for (const update of atTheBound) {
      expect(isUpdate(update)).toBe(true);
      const doc = createDocument();
      applyUpdate(doc, update);
      expect(reportsRead(doc)).toBe(true);
      insertPlainText(getFragment(doc), 0, "x");
      expect(reportsRead(doc)).toBe(true);
      applyUpdate(all, update);
    }
    expect(reportsRead(all)).toBe(true);
    // The full state of the replica, applied to another, leaves it at the bound as well.
    const copy = createDocument();
    const full = encodeUpdate(all);
    expect(isUpdate(full)).toBe(true);
    applyUpdate(copy, full);
    expect(encodeStateVector(copy)).toEqual(encodeStateVector(all));
    expect(reportsRead(copy)).toBe(true);
  });

  // One past the bound each, every number within bounds.
  const pastTheBound = [
    hex("01 02 01 00 00 ff ff ff ff ff ff ff 0f 00 01 00"),
    afterGc(MAX - 3, item(4, string("abcd"))),
    afterGc(MAX - 1, item(4, string("😀"))),
    afterGc(MAX - 5, item(1, [6])),
    afterGc(MAX - 1, item(8, [2, 120, 121])),
    afterGc(MAX, [10, 1]),
    new Uint8Array([1, 1, 1, ...varUint(MAX), ...item(4, string("x")), 0]),
    new Uint8Array([0, 1, 1, 1, ...varUint(MAX), 1]),
  ];

  it("whatever is read, at the bound or past it, leaves reports that read", () => {
    for (const update of [...atTheBound, ...pastTheBound]) {
      if (isUpdate(update)) {
        const doc = createDocument();
        applyUpdate(doc, update);
        expect(reportsRead(doc)).toBe(true);
      }
    }
    expect(pastTheBound.filter((update) => isUpdate(update))).toEqual([]);
  });

  it("across updates: one that continues a client starts at most at the clock the replica holds, so it is checked from there", () => {
    const doc = createDocument();
    applyUpdate(doc, afterGc(MAX - 1, [], 0));
    // From the clock held on: 2^53 − 1 is taken, one more is not an update.
    const next = new Uint8Array([1, 1, 1, ...varUint(MAX - 1), 0, 1, 0]);
    expect(isUpdate(next)).toBe(true);
    expect(isUpdate(new Uint8Array([1, 1, 1, ...varUint(MAX - 1), 0, 2, 0]))).toBe(false);
    applyUpdate(doc, next);
    expect(reportsRead(doc)).toBe(true);
    // Overlapping what the replica holds, from an earlier clock: the end is what counts.
    expect(isUpdate(afterGc(MAX, [], 0))).toBe(true);
    expect(isUpdate(afterGc(MAX - 1, [0, 2], 1))).toBe(false);
    applyUpdate(doc, afterGc(MAX, [], 0));
    expect(reportsRead(doc)).toBe(true);
  });

  it("is what the bound keeps: applied without it, an update whose struct ends past 2^53 − 1 leaves a state vector nobody reads", () => {
    const update = hex("01 02 01 00 00 ff ff ff ff ff ff ff 0f 00 01 00");
    expect(isUpdate(update)).toBe(false);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, update);
    expect(Buffer.from(Y.encodeStateVector(doc)).toString("hex")).toBe("01018080808080808010");
    expect(isStateVector(Y.encodeStateVector(doc))).toBe(false);
  });
});

describe("JSON content and Any values in an update nest at most 32 levels (Appendix A, §1.6)", () => {
  it("takes an Any value 32 arrays or objects deep and refuses 33, as Yjs writes it", () => {
    let value: unknown = [];
    for (let level = 1; level < 32; level += 1) value = level % 2 === 0 ? [value] : { k: value };
    const doc = new Y.Doc();
    doc.getArray("a").insert(0, [value]);
    expect(isUpdate(Y.encodeStateAsUpdate(doc))).toBe(true);
    const deeper = new Y.Doc();
    deeper.getArray("a").insert(0, [[value]]);
    expect(isUpdate(Y.encodeStateAsUpdate(deeper))).toBe(false);
  });

  it("counts an empty array or object as a level, and scalars as none", () => {
    expect(isUpdate(oneItem(8, [1, ...nestedAny(32)]))).toBe(true);
    expect(isUpdate(oneItem(8, [1, ...nestedAny(33)]))).toBe(false);
    expect(isUpdate(oneItem(8, [2, 119, ...string("[[[["), 125, 3]))).toBe(true);
  });

  it("refuses 100 000 levels without exhausting the stack", () => {
    expect(isUpdate(oneItem(8, [1, ...nestedAny(100_000)]))).toBe(false);
    expect(isUpdate(oneItem(2, [1, ...string(nestedText(100_000))]))).toBe(false);
  });

  it("refuses the subdocument's options nested 33 deep", () => {
    expect(
      isUpdate(oneItem(9, [...string("guid"), 118, 1, ...string("o"), ...nestedAny(31)])),
    ).toBe(true);
    expect(
      isUpdate(oneItem(9, [...string("guid"), 118, 1, ...string("o"), ...nestedAny(32)])),
    ).toBe(false);
  });

  it("counts JSON content as JSN-1 counts a frame: brackets outside strings, in content, an embed and a format", () => {
    expect(isUpdate(oneItem(2, [1, ...string(nestedText(32))]))).toBe(true);
    expect(isUpdate(oneItem(2, [1, ...string(nestedText(33))]))).toBe(false);
    expect(isUpdate(oneItem(2, [1, ...string(`["${"[".repeat(40)}"]`)]))).toBe(true);
    expect(isUpdate(oneItem(2, [1, ...string(`["\\"${"[".repeat(40)}"]`)]))).toBe(true);
    expect(isUpdate(oneItem(2, [2, ...string("undefined"), ...string(nestedText(33))]))).toBe(
      false,
    );
    let value: unknown = {};
    for (let level = 1; level < 32; level += 1) value = { k: value };
    const doc = new Y.Doc();
    doc.getText("t").insert(0, "x");
    doc.getText("t").insertEmbed(1, value as object);
    doc.getText("t").format(0, 1, { mark: value });
    expect(isUpdate(Y.encodeStateAsUpdate(doc))).toBe(true);
    const embed = new Y.Doc();
    embed.getText("t").insertEmbed(0, { k: value });
    expect(isUpdate(Y.encodeStateAsUpdate(embed))).toBe(false);
    const format = new Y.Doc();
    format.getText("t").insert(0, "x");
    format.getText("t").format(0, 1, { mark: { k: value } });
    expect(isUpdate(Y.encodeStateAsUpdate(format))).toBe(false);
  });
});
