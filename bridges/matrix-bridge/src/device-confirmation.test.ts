import { describe, expect, it } from "vitest";
import { canonicalJson, ed25519PublicKey, signJson } from "./device-confirmation.ts";

// The Matrix specification's own test vectors (appendices, "Cryptographic test vectors",
// "JSON signing"): seed, and the signatures of `{}` and `{"one": 1, "two": "Two"}`.
const SPEC_SEED = Buffer.from("YJDBA9Xnr2sVqXD9Vj7XVUnmFZcZrlw8Md7kMW+3XA1", "base64");

describe("signing JSON as Matrix does", () => {
  it("matches the specification's test vectors", () => {
    expect(signJson(SPEC_SEED, {})).toBe(
      "K8280/U9SSy9IVtjBuVeLr+HpOB4BQFWbg+UZaADMtTdGYI7Geitb76LTrr5QV/7Xg4ahLwYGYZzuHGZKM5ZAQ",
    );
    expect(signJson(SPEC_SEED, { one: 1, two: "Two" })).toBe(
      "KqmLSbO39/Bzb0QIYE82zqLwsA+PDzYIpIRA2sRQ4sL53+sN6/fpNSoqE7BP7vBZhG6kYdD13EIMJpvhJI+6Bw",
    );
  });

  it("leaves signatures and unsigned out of what it signs", () => {
    expect(
      signJson(SPEC_SEED, {
        one: 1,
        two: "Two",
        signatures: { a: { b: "c" } },
        unsigned: { x: 1 },
      }),
    ).toBe(signJson(SPEC_SEED, { one: 1, two: "Two" }));
  });

  it("derives the public key of a seed in unpadded Base64", () => {
    const key = ed25519PublicKey(SPEC_SEED);
    expect(key).toMatch(/^[A-Za-z0-9+/]{43}$/);
    expect(ed25519PublicKey(SPEC_SEED)).toBe(key);
  });
});

describe("canonical JSON", () => {
  it("sorts keys by code point and drops whitespace, at every depth", () => {
    expect(canonicalJson({ b: [2, { z: 1, a: null }], a: "x", A: true })).toBe(
      '{"A":true,"a":"x","b":[2,{"a":null,"z":1}]}',
    );
  });

  it("keeps non-ASCII text as UTF-8", () => {
    expect(canonicalJson({ 日本: "語", ä: "ö" })).toBe('{"ä":"ö","日本":"語"}');
  });

  it("refuses what has no canonical form: floats, -0, unsafe integers", () => {
    expect(() => canonicalJson({ a: 1.5 })).toThrow(/integers/);
    expect(() => canonicalJson({ a: -0 })).toThrow(/integers/);
    expect(() => canonicalJson({ a: 2 ** 53 })).toThrow(/integers/);
  });
});
