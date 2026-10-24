/**
 * State digests (SPECIFICATION.md LOS-12): the first 8 bytes of SHA-256 over a canonical encoding,
 * as 16 lowercase hex digits. Two participants whose vectors are equal and whose digests differ
 * hold different states — what a vector alone cannot show (LOS-12).
 *
 * SHA-256 is computed here, synchronously, because the engine digests while it writes a frame,
 * and the Web Crypto API it would otherwise use only answers asynchronously.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** SHA-256 (FIPS 180-4) of `data`. */
export function sha256(data: Uint8Array): Uint8Array {
  const bitLength = data.length * 8;
  const padded = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 2 ** 32));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let block = 0; block < padded.length; block += 64) {
    for (let t = 0; t < 16; t++) {
      w[t] = view.getUint32(block + t * 4);
    }
    for (let t = 16; t < 64; t++) {
      const a = w[t - 15] as number;
      const b = w[t - 2] as number;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[t] = ((w[t - 16] as number) + s0 + (w[t - 7] as number) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[];
    for (let t = 0; t < 64; t++) {
      const s1 = rotr(e as number, 6) ^ rotr(e as number, 11) ^ rotr(e as number, 25);
      const ch = ((e as number) & (f as number)) ^ (~(e as number) & (g as number));
      const t1 = ((hh as number) + s1 + ch + (K[t] as number) + (w[t] as number)) >>> 0;
      const s0 = rotr(a as number, 2) ^ rotr(a as number, 13) ^ rotr(a as number, 22);
      const maj =
        ((a as number) & (b as number)) ^
        ((a as number) & (c as number)) ^
        ((b as number) & (c as number));
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = ((d as number) + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = ((h[0] as number) + (a as number)) >>> 0;
    h[1] = ((h[1] as number) + (b as number)) >>> 0;
    h[2] = ((h[2] as number) + (c as number)) >>> 0;
    h[3] = ((h[3] as number) + (d as number)) >>> 0;
    h[4] = ((h[4] as number) + (e as number)) >>> 0;
    h[5] = ((h[5] as number) + (f as number)) >>> 0;
    h[6] = ((h[6] as number) + (g as number)) >>> 0;
    h[7] = ((h[7] as number) + (hh as number)) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  h.forEach((word, i) => {
    outView.setUint32(i * 4, word);
  });
  return out;
}

/** A digest (LOS-12): the first 8 bytes of SHA-256 over `encoding`, as 16 lowercase hex digits. */
export function digestOf(encoding: Uint8Array): string {
  return [...sha256(encoding).subarray(0, 8)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * RFC 8785 (JSON Canonicalization Scheme) for the values a control snapshot holds — objects,
 * arrays, strings, integers, booleans and null: object members in the order of their names'
 * UTF-16 code units, strings and numbers as ECMAScript's JSON.stringify writes them.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const members = Object.keys(value)
      .sort()
      .map(
        (name) =>
          `${JSON.stringify(name)}:${canonicalJson((value as Record<string, unknown>)[name])}`,
      );
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value);
}

const textEncoder = new TextEncoder();

/**
 * What the control digest reads of a control state's snapshot (`ControlStateSnapshot`, §7.5),
 * named here: control-state.ts depends on this module, so this one does not depend on it.
 */
interface DigestedSnapshot {
  readonly vector: Readonly<Record<string, number>>;
  readonly targets: Readonly<
    Record<
      string,
      {
        readonly seen: Readonly<Record<string, number>>;
        readonly heads: readonly { readonly device: string; readonly counter: number }[];
      }
    >
  >;
}

/**
 * The control digest of a control state (LOS-12): of its snapshot's `vector` and `targets`
 * (§7.5), every target's `heads` in order of `device` and then `counter`, canonicalized by
 * RFC 8785 and encoded as UTF-8.
 */
export function controlDigestOf(snapshot: DigestedSnapshot): string {
  const targets: Record<string, unknown> = {};
  for (const [name, state] of Object.entries(snapshot.targets)) {
    targets[name] = {
      seen: state.seen,
      heads: [...state.heads].sort((a, b) =>
        a.device === b.device ? a.counter - b.counter : a.device < b.device ? -1 : 1,
      ),
    };
  }
  return digestOf(textEncoder.encode(canonicalJson({ vector: snapshot.vector, targets })));
}
