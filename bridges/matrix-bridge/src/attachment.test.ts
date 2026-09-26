import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_FRAME_LIMIT,
  AttachmentRejectedError,
  BODY_FRAME_LIMIT,
  base64Unpadded,
  base64Url,
  encryptAttachment,
  openAttachment,
  parseAttachmentRef,
  parseMxc,
  sha256Base64,
  sha256Hex,
} from "./attachment.ts";

const bytesOf = (length: number, seed = 1): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => ((i * 2654435761 + seed * 40503) >>> 24) & 0xff);

const MXC = "mxc://tdsp.test/AbC123_-xyz";

/** A reference for `frame` as an ordinary room would carry it. */
const plainRef = (frame: Uint8Array) => ({
  size: frame.length,
  url: MXC,
  sha256: sha256Hex(frame),
});

/** What an encrypted room would carry: the ciphertext (to be "downloaded") and the reference. */
function encryptedRef(frame: Uint8Array) {
  const { ciphertext, file } = encryptAttachment(frame);
  return { ciphertext, ref: { size: frame.length, file: { ...file, url: MXC } } };
}

const rejection = (run: () => unknown): AttachmentRejectedError["reason"] | "no error" => {
  try {
    run();
  } catch (error) {
    if (error instanceof AttachmentRejectedError) {
      return error.reason;
    }
    throw error;
  }
  return "no error";
};

describe("the limits", () => {
  it("has a body limit under the attachment limit, both fixed numbers other documents state", () => {
    expect(BODY_FRAME_LIMIT).toBe(32_000);
    expect(ATTACHMENT_FRAME_LIMIT).toBe(4 * 1024 * 1024);
  });
});

describe("base64 as Matrix writes it", () => {
  it("has no padding, and the URL-safe form uses - and _", () => {
    expect(base64Unpadded(new Uint8Array([1]))).toBe("AQ");
    expect(base64Unpadded(new Uint8Array([251, 255]))).toBe("+/8");
    expect(base64Url(new Uint8Array([251, 255]))).toBe("-_8");
  });

  it("gives an SHA-256 of 43 characters", () => {
    expect(sha256Base64(new Uint8Array(0))).toBe("47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU");
  });
});

describe("a plain attachment", () => {
  it("opens to the frame it was made from", () => {
    const frame = bytesOf(50_000);
    expect(openAttachment(plainRef(frame), frame)).toEqual(frame);
  });

  it("names its hash in lowercase hex, as every TDSP binding does, and refuses any other spelling", () => {
    const frame = bytesOf(1000);
    const ref = plainRef(frame);
    expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parseAttachmentRef(ref)).toEqual(ref);
    expect(parseAttachmentRef({ ...ref, sha256: ref.sha256.toUpperCase() })).toBeUndefined();
    expect(parseAttachmentRef({ ...ref, sha256: sha256Base64(frame) })).toBeUndefined();
  });

  it("is refused when one byte was changed", () => {
    const frame = bytesOf(50_000);
    const altered = Uint8Array.from(frame);
    altered[25_000] = (altered[25_000] as number) ^ 1;
    expect(rejection(() => openAttachment(plainRef(frame), altered))).toBe("hash-mismatch");
  });

  it("is refused when it is not the size the event said, before its hash is even looked at", () => {
    const frame = bytesOf(50_000);
    expect(rejection(() => openAttachment({ ...plainRef(frame), size: 49_999 }, frame))).toBe(
      "size-mismatch",
    );
    expect(rejection(() => openAttachment(plainRef(frame), frame.subarray(1)))).toBe(
      "size-mismatch",
    );
  });

  it("is refused when a download is over the bound, however the event described it", () => {
    const huge = new Uint8Array(ATTACHMENT_FRAME_LIMIT + 17);
    expect(
      rejection(() => openAttachment({ size: huge.length, url: MXC, sha256: "x" }, huge)),
    ).toBe("too-large");
  });

  it("is refused when the reference carries no hash at all", () => {
    const frame = bytesOf(100);
    expect(rejection(() => openAttachment({ size: 100, url: MXC }, frame))).toBe("hash-mismatch");
  });
});

describe("an encrypted attachment", () => {
  it("opens to the frame it was made from, and the ciphertext is not the frame", () => {
    const frame = bytesOf(100_000);
    const { ciphertext, ref } = encryptedRef(frame);
    expect(ciphertext).toHaveLength(frame.length); // CTR: a stream cipher, no padding
    expect(Buffer.from(ciphertext).equals(Buffer.from(frame))).toBe(false);
    expect(openAttachment(ref, ciphertext)).toEqual(frame);
  });

  it("uses a fresh key and IV every time, so two encryptions of one frame differ", () => {
    const frame = bytesOf(1000);
    const a = encryptAttachment(frame);
    const b = encryptAttachment(frame);
    expect(a.file.key.k).not.toBe(b.file.key.k);
    expect(a.file.iv).not.toBe(b.file.iv);
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false);
  });

  it("states the key and IV the way Matrix's EncryptedFile v2 does", () => {
    const { file } = encryptAttachment(bytesOf(10));
    expect(file.v).toBe("v2");
    expect(file.key.kty).toBe("oct");
    expect(file.key.alg).toBe("A256CTR");
    expect(file.key.ext).toBe(true);
    expect(file.key.key_ops).toEqual(["encrypt", "decrypt"]);
    expect(file.key.k).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, URL-safe, unpadded
    // 16 bytes, the lower 8 of which are the block counter and start at zero.
    const iv = Buffer.from(file.iv, "base64");
    expect(iv).toHaveLength(16);
    expect([...iv.subarray(8)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("hashes the ciphertext, not the frame", () => {
    const { ciphertext, file } = encryptAttachment(bytesOf(2000));
    expect(file.hashes.sha256).toBe(sha256Base64(ciphertext));
  });

  it("interoperates with a plain AES-256-CTR implementation, which is what other Matrix clients use", () => {
    const frame = bytesOf(5000);
    const { ciphertext, file } = encryptAttachment(frame);
    const key = Buffer.from(file.key.k.replaceAll("-", "+").replaceAll("_", "/"), "base64");
    const iv = Buffer.from(file.iv, "base64");
    const cipher = createCipheriv("aes-256-ctr", key, iv);
    const expected = Buffer.concat([cipher.update(frame), cipher.final()]);
    expect(Buffer.from(ciphertext).equals(expected)).toBe(true);
  });

  it("is refused when the ciphertext was altered, before anything is decrypted", () => {
    const frame = bytesOf(10_000);
    const { ciphertext, ref } = encryptedRef(frame);
    const altered = Uint8Array.from(ciphertext);
    altered[5000] = (altered[5000] as number) ^ 0x80;
    expect(rejection(() => openAttachment(ref, altered))).toBe("hash-mismatch");
  });

  it("with the wrong key comes out as something else, not as the frame", () => {
    const frame = bytesOf(10_000);
    const { ciphertext, ref } = encryptedRef(frame);
    const other = encryptAttachment(frame).file;
    const swapped = { ...ref, file: { ...ref.file, key: other.key } };
    // The hash still matches the ciphertext, so the key is the only thing wrong and CTR has no way
    // to notice: the bytes come out the right size and wrong. What makes that harmless is that a
    // frame is checked again by document-protocol; this layer only promises it is not the original.
    expect(openAttachment(swapped, ciphertext)).not.toEqual(frame);
  });

  it("is refused when it decrypts to a different size than the event said", () => {
    const frame = bytesOf(3000);
    const { ciphertext, ref } = encryptedRef(frame);
    expect(rejection(() => openAttachment({ ...ref, size: 2999 }, ciphertext))).toBe(
      "size-mismatch",
    );
  });

  it("is refused when its key or IV cannot be used, rather than throwing something else", () => {
    const frame = bytesOf(100);
    const { ciphertext, ref } = encryptedRef(frame);
    const badKey = { ...ref, file: { ...ref.file, key: { ...ref.file.key, k: "AAAA" } } };
    expect(rejection(() => openAttachment(badKey, ciphertext))).toBe("malformed");
    const badIv = { ...ref, file: { ...ref.file, iv: "AAAA" } };
    expect(rejection(() => openAttachment(badIv, ciphertext))).toBe("malformed");
  });

  it("copes with an empty frame", () => {
    const { ciphertext, ref } = encryptedRef(new Uint8Array(0));
    expect(openAttachment(ref, ciphertext)).toEqual(new Uint8Array(0));
  });
});

describe("parseMxc", () => {
  it("splits a well-formed URI", () => {
    expect(parseMxc("mxc://tdsp.test/AbC123_-xyz")).toEqual({
      server: "tdsp.test",
      mediaId: "AbC123_-xyz",
    });
    expect(parseMxc("mxc://localhost:8448/abc")).toEqual({
      server: "localhost:8448",
      mediaId: "abc",
    });
    expect(parseMxc("mxc://[::1]:8448/abc")).toEqual({ server: "[::1]:8448", mediaId: "abc" });
    expect(parseMxc("mxc://127.0.0.1/abc")).toEqual({ server: "127.0.0.1", mediaId: "abc" });
    expect(parseMxc("mxc://a-b.c-d.example.org/abc")).toEqual({
      server: "a-b.c-d.example.org",
      mediaId: "abc",
    });
  });

  it("cannot make a request for any other path than the media download of that server and file", () => {
    // What ends up in the URL is only ever what parseMxc let through: check the path that results.
    for (const good of ["mxc://tdsp.test/abc", "mxc://[::1]:8448/abc", "mxc://a/b"]) {
      const parsed = parseMxc(good);
      expect(parsed).toBeDefined();
      const target = `${encodeURIComponent(parsed?.server as string)}/${encodeURIComponent(parsed?.mediaId as string)}`;
      const url = new URL(`http://hs.test/_matrix/client/v1/media/download/${target}`);
      expect(url.pathname.startsWith("/_matrix/client/v1/media/download/")).toBe(true);
      // "", _matrix, client, v1, media, download, server, id
      expect(url.pathname.split("/")).toHaveLength(8);
    }
  });

  it("refuses anything that is not exactly an mxc URI, so it cannot be turned into another URL", () => {
    for (const bad of [
      "",
      "http://tdsp.test/abc",
      "https://evil.example/abc",
      "mxc://",
      "mxc:///abc",
      "mxc://server",
      "mxc://server/",
      "mxc://server/a/b",
      "mxc://server/../etc",
      "mxc://server/a?b=c",
      "mxc://server/a#b",
      "mxc://user@server/abc",
      "mxc://server/a b",
      "mxc://server/%2e%2e",
      "mxc://server/..",
      "mxc://server/.",
      "mxc://../abc",
      "mxc://./abc",
      "mxc://a..b/abc",
      "mxc://.a/abc",
      "mxc://a./abc",
      "mxc://-/abc/",
      "mxc://server:/abc",
      "mxc://server:port/abc",
      "mxc://server:123456/abc",
      "mxc://[/abc",
      "mxc://[]/abc",
      "mxc://[::1/abc",
      "mxc://[::1]x/abc",
      `mxc://${"a".repeat(64)}/abc`,
      `mxc://${Array.from({ length: 5 }, () => "a".repeat(63)).join(".")}/abc`,
      " mxc://server/abc",
      "mxc://server/abc\n",
      `mxc://server/${"a".repeat(256)}`,
    ]) {
      expect(parseMxc(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe("parseAttachmentRef", () => {
  const frame = bytesOf(1000);
  const plain = plainRef(frame);
  const { file } = encryptedRef(frame).ref;

  it("reads a plain reference and an encrypted one", () => {
    expect(parseAttachmentRef(plain)).toEqual(plain);
    expect(parseAttachmentRef({ size: 1000, file })).toEqual({ size: 1000, file });
  });

  it("copies only what it knows, dropping anything else the event carried", () => {
    const parsed = parseAttachmentRef({ ...plain, extra: "x", evil: { a: 1 } });
    expect(parsed).toEqual(plain);
    expect(parsed).not.toHaveProperty("extra");
  });

  it("refuses what is not an object", () => {
    for (const bad of [undefined, null, "x", 3, [], [plain], true]) {
      expect(parseAttachmentRef(bad)).toBeUndefined();
    }
  });

  it("refuses a size that is missing, not a whole number, negative, or over the bound", () => {
    expect(parseAttachmentRef({ url: plain.url, sha256: plain.sha256 })).toBeUndefined();
    for (const size of ["1000", 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, null]) {
      expect(parseAttachmentRef({ ...plain, size }), String(size)).toBeUndefined();
    }
    expect(parseAttachmentRef({ ...plain, size: ATTACHMENT_FRAME_LIMIT })).toBeDefined();
    expect(parseAttachmentRef({ ...plain, size: ATTACHMENT_FRAME_LIMIT + 1 })).toBeUndefined();
    expect(parseAttachmentRef({ ...plain, size: 0 })).toBeDefined();
  });

  it("refuses a plain reference whose url is not an mxc URI or whose hash is not 43 base64 characters", () => {
    expect(parseAttachmentRef({ ...plain, url: "https://example.org/x" })).toBeUndefined();
    expect(parseAttachmentRef({ ...plain, url: 5 })).toBeUndefined();
    expect(parseAttachmentRef({ ...plain, sha256: "short" })).toBeUndefined();
    expect(parseAttachmentRef({ ...plain, sha256: `${plain.sha256}A` })).toBeUndefined();
    expect(parseAttachmentRef({ ...plain, sha256: 7 })).toBeUndefined();
    expect(parseAttachmentRef({ size: 10, url: plain.url })).toBeUndefined();
  });

  it("refuses an encrypted reference that is not exactly v2, A256CTR, with a key and IV of the right length", () => {
    const refuse = (patch: Record<string, unknown>) =>
      expect(parseAttachmentRef({ size: 1000, file: { ...file, ...patch } })).toBeUndefined();
    refuse({ v: "v1" });
    refuse({ v: undefined });
    refuse({ url: "http://example.org/x" });
    refuse({ url: undefined });
    refuse({ iv: "AAAA" });
    refuse({ iv: 5 });
    refuse({ hashes: {} });
    refuse({ hashes: { sha256: "short" } });
    refuse({ hashes: undefined });
    refuse({ key: undefined });
    refuse({ key: { ...file.key, kty: "RSA" } });
    refuse({ key: { ...file.key, alg: "A128CTR" } });
    refuse({ key: { ...file.key, k: "AAAA" } });
    refuse({ key: { ...file.key, k: 5 } });
  });

  it("does not let a plain reference's fields stand in for an encrypted one's, or the reverse", () => {
    // An encrypted reference is read as one, so a `url` beside it is not a way to have the bridge
    // fetch that URL instead.
    const parsed = parseAttachmentRef({ size: 1000, file, url: "mxc://other.example/x" });
    expect(parsed?.url).toBeUndefined();
    expect(parsed?.file?.url).toBe(file.url);
    // A file that is malformed is refused, not quietly read as a plain reference.
    expect(parseAttachmentRef({ ...plain, file: { ...file, v: "v1" } })).toBeUndefined();
  });

  it("takes a key made by real randomness, not just the ones this file produced", () => {
    for (let i = 0; i < 20; i += 1) {
      const generated = encryptAttachment(randomBytes(64)).file;
      expect(parseAttachmentRef({ size: 64, file: { ...generated, url: MXC } })).toBeDefined();
    }
  });
});
