import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ControlState } from "./control-state";
import { canonicalJson, controlDigestOf, digestOf, sha256 } from "./digest";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("SHA-256 (FIPS 180-4)", () => {
  it("matches the standard's examples", () => {
    expect(hex(sha256(new Uint8Array()))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(hex(sha256(new TextEncoder().encode("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(
      hex(
        sha256(
          new TextEncoder().encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
        ),
      ),
    ).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("matches Node's for every length around the block boundaries, and for a megabyte", () => {
    for (let length = 0; length < 200; length++) {
      const data = Uint8Array.from({ length }, (_, i) => (i * 31 + length) % 256);
      expect(hex(sha256(data)), `length ${length}`).toBe(
        createHash("sha256").update(data).digest("hex"),
      );
    }
    const large = Uint8Array.from({ length: 1_048_576 + 3 }, (_, i) => i % 251);
    expect(hex(sha256(large))).toBe(createHash("sha256").update(large).digest("hex"));
  });

  it("gives a digest as its first 8 bytes in 16 lowercase hex digits", () => {
    expect(digestOf(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea");
  });
});

describe("RFC 8785 canonical JSON", () => {
  it("orders members by their names' UTF-16 code units, as the RFC's example does", () => {
    const value = {
      "\u20ac": "Euro Sign",
      "\r": "Carriage Return",
      "\ufb33": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "\ud83d\ude00": "Emoji: Grinning Face",
      "\u0080": "Control",
      "\u00f6": "Latin Small Letter O With Diaeresis",
    };
    expect(canonicalJson(value)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis",' +
        '"\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it("nests, keeps array order and writes no whitespace", () => {
    expect(canonicalJson({ b: [3, { y: null, x: true }], a: "x" })).toBe(
      '{"a":"x","b":[3,{"x":true,"y":null}]}',
    );
  });
});

describe("the control digest (LOS-12)", () => {
  const laptop = "QUFBQUFBQUFBQUFBQUFBQQ";
  const tablet = "QkJCQkJCQkJCQkJCQkJCQg";

  it("is the same for the same operations in any order, and differs for another value under one dot", () => {
    const one = new ControlState();
    one.add({ device: laptop, counter: 1, target: "member:bob", value: "write", seen: {} });
    one.add({ device: tablet, counter: 1, target: "member:carol", value: "read", seen: {} });
    const two = new ControlState();
    two.add({ device: tablet, counter: 1, target: "member:carol", value: "read", seen: {} });
    two.add({ device: laptop, counter: 1, target: "member:bob", value: "write", seen: {} });
    expect(controlDigestOf(two.snapshot())).toBe(controlDigestOf(one.snapshot()));

    const other = new ControlState();
    other.add({ device: laptop, counter: 1, target: "member:bob", value: "read", seen: {} });
    other.add({ device: tablet, counter: 1, target: "member:carol", value: "read", seen: {} });
    expect(other.vector).toEqual(one.vector);
    expect(controlDigestOf(other.snapshot())).not.toBe(controlDigestOf(one.snapshot()));
  });
});
