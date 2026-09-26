import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGpgInvoker, extractDecryptResult, type GpgInvoker } from "./gpg-invoke.ts";

function hasGpg(): boolean {
  try {
    execFileSync("gpg", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const PAYLOAD = JSON.stringify({ tdsp: 1, kind: "frame", documentId: "doc-1", frame: "AQID" });
const ALICE_FINGERPRINT = "B243E08F944374BDBAAF302FAD5C3319C528CDE8";

/**
 * Real `--status-fd 2 --decrypt -` stderr transcripts, captured with a
 * real GnuPG 2.5.22 binary for every outcome `decryptAndVerify()` has to
 * tell apart — four throwaway keypairs, everyone's public key
 * imported everywhere except where the case says otherwise. The same
 * commands were also run on GnuPG 2.4.4 and 2.2.40 (status lines
 * identical); these are the 2.5.22 captures.
 */
const REAL_STDERR_GOOD =
  '[GNUPG:] ENC_TO 39775DEF9907F701 18 0\n[GNUPG:] KEY_CONSIDERED 12247BD79F59756048545C2EC4D7D00FDBA1CB50 0\ngpg: encrypted with cv25519 key, ID 39775DEF9907F701, created 2026-09-19\n      "Test bob@example.org <bob@example.org>"\n[GNUPG:] KEY_CONSIDERED 12247BD79F59756048545C2EC4D7D00FDBA1CB50 0\n[GNUPG:] KEY_CONSIDERED 12247BD79F59756048545C2EC4D7D00FDBA1CB50 0\n[GNUPG:] DECRYPTION_KEY A2FB28EDF633563656BAB7DF39775DEF9907F701 12247BD79F59756048545C2EC4D7D00FDBA1CB50 u\n[GNUPG:] BEGIN_DECRYPTION\n[GNUPG:] DECRYPTION_INFO 0 9 2 0\n[GNUPG:] PLAINTEXT 62 1789855312 \n[GNUPG:] PLAINTEXT_LENGTH 58\n[GNUPG:] NEWSIG alice@example.org\ngpg: Signature made Sun Sep 20 00:01:52 2026 CEST\ngpg:                using EDDSA key B243E08F944374BDBAAF302FAD5C3319C528CDE8\ngpg:                issuer "alice@example.org"\n[GNUPG:] KEY_CONSIDERED B243E08F944374BDBAAF302FAD5C3319C528CDE8 0\n[GNUPG:] SIG_ID HEn/4amhb/v+kE4zJ1auuZ409Yg 2026-09-19 1789855312\n[GNUPG:] GOODSIG AD5C3319C528CDE8 Test alice@example.org <alice@example.org>\ngpg: Good signature from "Test alice@example.org <alice@example.org>" [unknown]\n[GNUPG:] VALIDSIG B243E08F944374BDBAAF302FAD5C3319C528CDE8 2026-09-19 1789855312 0 4 0 22 10 00 B243E08F944374BDBAAF302FAD5C3319C528CDE8\n[GNUPG:] TRUST_UNDEFINED 0 pgp alice@example.org\ngpg: WARNING: The key\'s User ID is not certified with a trusted signature!\ngpg:          There is no indication that the signature belongs to the owner.\n      B243E08F944374BDBAAF302FAD5C3319C528CDE8\n[GNUPG:] DECRYPTION_OKAY\n[GNUPG:] GOODMDC\n[GNUPG:] END_DECRYPTION\n';
const REAL_STDERR_NOT_A_RECIPIENT =
  '[GNUPG:] ENC_TO 39775DEF9907F701 18 0\n[GNUPG:] KEY_CONSIDERED 12247BD79F59756048545C2EC4D7D00FDBA1CB50 0\ngpg: encrypted with cv25519 key, ID 39775DEF9907F701, created 2026-09-19\n      "Test bob@example.org <bob@example.org>"\n[GNUPG:] KEY_CONSIDERED A7DFCEBA957D3F390E600737D4F11F517175DC54 0\n[GNUPG:] NO_SECKEY 39775DEF9907F701\ngpg: public key decryption failed: No secret key\n[GNUPG:] ERROR pkdecrypt_failed 33554449\n[GNUPG:] BEGIN_DECRYPTION\n[GNUPG:] DECRYPTION_FAILED\ngpg: decryption failed: No secret key\n[GNUPG:] END_DECRYPTION\n[GNUPG:] FAILURE gpg-exit 33554433\n';
const REAL_STDERR_CORRUPT =
  "gpg: CRC error; B4E924 - AD61C5\ngpg: aead encrypted packet with unknown version 0\n[GNUPG:] NODATA 3\n[GNUPG:] FAILURE gpg-exit 33554433\n";
const REAL_STDERR_UNSIGNED =
  '[GNUPG:] ENC_TO 39775DEF9907F701 18 0\n[GNUPG:] KEY_CONSIDERED 12247BD79F59756048545C2EC4D7D00FDBA1CB50 0\ngpg: encrypted with cv25519 key, ID 39775DEF9907F701, created 2026-09-19\n      "Test bob@example.org <bob@example.org>"\n[GNUPG:] KEY_CONSIDERED 12247BD79F59756048545C2EC4D7D00FDBA1CB50 0\n[GNUPG:] KEY_CONSIDERED 12247BD79F59756048545C2EC4D7D00FDBA1CB50 0\n[GNUPG:] DECRYPTION_KEY A2FB28EDF633563656BAB7DF39775DEF9907F701 12247BD79F59756048545C2EC4D7D00FDBA1CB50 u\n[GNUPG:] BEGIN_DECRYPTION\n[GNUPG:] DECRYPTION_INFO 0 9 2 0\n[GNUPG:] PLAINTEXT 62 1789855312 \n[GNUPG:] PLAINTEXT_LENGTH 58\n[GNUPG:] DECRYPTION_OKAY\n[GNUPG:] GOODMDC\n[GNUPG:] END_DECRYPTION\n';
const REAL_STDERR_UNKNOWN_SIGNER =
  '[GNUPG:] ENC_TO B3EFABA02678ED72 18 0\n[GNUPG:] KEY_CONSIDERED 808E4C5241BBB0BDAA09B9577349749AD3B2490A 0\ngpg: encrypted with cv25519 key, ID B3EFABA02678ED72, created 2026-09-19\n      "Test dave@example.org <dave@example.org>"\n[GNUPG:] KEY_CONSIDERED 808E4C5241BBB0BDAA09B9577349749AD3B2490A 0\n[GNUPG:] KEY_CONSIDERED 808E4C5241BBB0BDAA09B9577349749AD3B2490A 0\n[GNUPG:] DECRYPTION_KEY E23D282F72B91C674E3D534AB3EFABA02678ED72 808E4C5241BBB0BDAA09B9577349749AD3B2490A u\n[GNUPG:] BEGIN_DECRYPTION\n[GNUPG:] DECRYPTION_INFO 0 9 2 0\n[GNUPG:] PLAINTEXT 62 1789855312 \n[GNUPG:] PLAINTEXT_LENGTH 58\n[GNUPG:] NEWSIG alice@example.org\ngpg: Signature made Sun Sep 20 00:01:52 2026 CEST\ngpg:                using EDDSA key B243E08F944374BDBAAF302FAD5C3319C528CDE8\ngpg:                issuer "alice@example.org"\n[GNUPG:] ERRSIG AD5C3319C528CDE8 22 10 00 1789855312 9 B243E08F944374BDBAAF302FAD5C3319C528CDE8\n[GNUPG:] NO_PUBKEY AD5C3319C528CDE8\ngpg: Can\'t check signature: No public key\n[GNUPG:] DECRYPTION_OKAY\n[GNUPG:] GOODMDC\n[GNUPG:] END_DECRYPTION\n[GNUPG:] FAILURE gpg-exit 33554433\n';
const REAL_STDERR_NOT_PGP =
  "gpg: no valid OpenPGP data found.\n[GNUPG:] NODATA 1\n[GNUPG:] NODATA 2\n[GNUPG:] FAILURE decrypt 4294967295\ngpg: decrypt_message failed: Unknown system error\n";

describe("extractDecryptResult", () => {
  it("accepts a real good transcript, returning the signer's primary fingerprint and the plaintext", () => {
    expect(extractDecryptResult(`${PAYLOAD}\n`, REAL_STDERR_GOOD)).toEqual({
      decrypted: true,
      signature: "valid",
      signerFingerprint: ALICE_FINGERPRINT,
      payload: `${PAYLOAD}\n`,
    });
  });

  // gpg echoes whatever plaintext it has to stdout for *every* outcome
  // (verified — the unknown-signer capture printed it too) — the
  // caller must never be handed it unless decryption and the signature
  // both held.
  it.each([
    ["addressed only to some other key (NO_SECKEY)", REAL_STDERR_NOT_A_RECIPIENT],
    ["corrupted armor", REAL_STDERR_CORRUPT],
    ["input that isn't OpenPGP data at all (NODATA)", REAL_STDERR_NOT_PGP],
  ])("reports %s as not decrypted and withholds any plaintext", (_name, stderr) => {
    const result = extractDecryptResult(`${PAYLOAD}\n`, stderr);
    expect(result).toEqual({ decrypted: false, signature: "missing" });
    expect(result.payload).toBeUndefined();
  });

  it("reports an encrypted message that was never signed as decrypted with a missing signature, and withholds the plaintext", () => {
    const result = extractDecryptResult(`${PAYLOAD}\n`, REAL_STDERR_UNSIGNED);
    expect(result).toEqual({ decrypted: true, signature: "missing" });
    expect(result.payload).toBeUndefined();
  });

  it("reports a signature by a key this keyring never imported as invalid, and withholds the plaintext gpg echoed anyway", () => {
    const result = extractDecryptResult(`${PAYLOAD}\n`, REAL_STDERR_UNKNOWN_SIGNER);
    expect(result).toEqual({ decrypted: true, signature: "invalid" });
    expect(result.payload).toBeUndefined();
  });

  it("reports nothing decrypted for an empty status stream", () => {
    expect(extractDecryptResult(PAYLOAD, "")).toEqual({ decrypted: false, signature: "missing" });
  });

  // Synthetic on purpose (built by editing the real good transcript, not
  // captured): these pin the fail-closed rules documented on
  // extractDecryptResult, none of which a real run produces on its own.
  describe("fails closed", () => {
    const lines = REAL_STDERR_GOOD.split("\n");
    const without = (word: string) =>
      lines.filter((line) => !line.startsWith(`[GNUPG:] ${word}`)).join("\n");

    it("rejects a good signature that arrives without DECRYPTION_OKAY", () => {
      expect(extractDecryptResult(PAYLOAD, without("DECRYPTION_OKAY"))).toEqual({
        decrypted: false,
        signature: "missing",
      });
    });

    it("rejects DECRYPTION_OKAY appearing alongside DECRYPTION_FAILED", () => {
      const both = `${REAL_STDERR_GOOD}[GNUPG:] DECRYPTION_FAILED\n`;
      expect(extractDecryptResult(PAYLOAD, both).decrypted).toBe(false);
    });

    it("rejects DECRYPTION_OKAY appearing twice", () => {
      const twice = `${REAL_STDERR_GOOD}[GNUPG:] DECRYPTION_OKAY\n`;
      expect(extractDecryptResult(PAYLOAD, twice).decrypted).toBe(false);
    });

    it("rejects a VALIDSIG that is not accompanied by GOODSIG (gpg reports an expired/revoked key's signature under other status words)", () => {
      expect(extractDecryptResult(PAYLOAD, without("GOODSIG"))).toEqual({
        decrypted: true,
        signature: "invalid",
      });
    });

    it("rejects a message carrying more than one signature rather than trusting whichever VALIDSIG came first", () => {
      const doubled = REAL_STDERR_GOOD.replace(
        "[GNUPG:] DECRYPTION_OKAY",
        `${lines.filter((l) => /^\[GNUPG:\] (GOODSIG|VALIDSIG)/.test(l)).join("\n")}\n[GNUPG:] DECRYPTION_OKAY`,
      );
      expect(extractDecryptResult(PAYLOAD, doubled)).toEqual({
        decrypted: true,
        signature: "invalid",
      });
    });

    // Synthetic: GnuPG 2.2.40, 2.4.4 and 2.5.22 all emit the trailing
    // primary-key field. This pins the documented fallback only.
    it("falls back to the signing key's own fingerprint when VALIDSIG omits the primary-key field", () => {
      const shortened = REAL_STDERR_GOOD.replace(
        /(\[GNUPG:\] VALIDSIG \S+ (?:\S+ ){8}\S+) \S+/,
        "$1",
      );
      const result = extractDecryptResult(PAYLOAD, shortened);
      expect(result.signature).toBe("valid");
      expect(result.signerFingerprint).toBe(ALICE_FINGERPRINT);
    });
  });
});

/**
 * Real gpg — gated on a real binary being on `PATH`. **Exactly one real
 * `--quick-generate-key` call in this whole file**, in `beforeAll`: a second
 * one, in this or any other test of one Vitest file, reliably fails with
 * "can't connect to the gpg-agent" (see `gpg-invoke.test.ts`'s own comment —
 * a Vitest-worker quirk, not a `gpg-invoke.ts` concern; `pgp-live.test.ts`
 * gets several keys by provisioning in a child process). Every scenario here
 * is built from that one key: Alice's home signs and decrypts, Bob's home has
 * only her *public* key imported (so it can verify but neither read what is
 * encrypted to her nor sign as her), and Carol's home is empty. Messages are
 * encrypted to Alice herself, the one recipient this single key can be.
 */
describe.skipIf(!hasGpg())("createGpgInvoker sign+encrypt / decrypt+verify (real gpg)", () => {
  const homes: string[] = [];
  let aliceHome = "";
  let alice: GpgInvoker;
  let bob: GpgInvoker;
  let carol: GpgInvoker;
  let aliceFingerprint = "";

  beforeAll(async () => {
    aliceHome = mkdtempSync(join(tmpdir(), "eb-gpg-alice-"));
    const bobHome = mkdtempSync(join(tmpdir(), "eb-gpg-bob-"));
    const carolHome = mkdtempSync(join(tmpdir(), "eb-gpg-carol-"));
    homes.push(aliceHome, bobHome, carolHome);

    execFileSync("gpgconf", ["--homedir", aliceHome, "--launch", "gpg-agent"], { stdio: "pipe" });
    execFileSync(
      "gpg",
      [
        "--homedir",
        aliceHome,
        "--batch",
        "--pinentry-mode",
        "loopback",
        "--passphrase",
        "",
        "--quick-generate-key",
        "Alice Test <alice@example.org>",
        "default",
        "default",
        "never",
      ],
      { stdio: "pipe" },
    );
    const alicePublicKey = execFileSync(
      "gpg",
      ["--homedir", aliceHome, "--batch", "--armor", "--export", "alice@example.org"],
      { encoding: "utf8" },
    );
    const publicKeyFile = join(bobHome, "alice-public.asc");
    writeFileSync(publicKeyFile, alicePublicKey);
    execFileSync("gpg", ["--homedir", bobHome, "--batch", "--import", publicKeyFile], {
      stdio: "pipe",
    });

    alice = createGpgInvoker({ gnupgHome: aliceHome });
    bob = createGpgInvoker({ gnupgHome: bobHome });
    carol = createGpgInvoker({ gnupgHome: carolHome });
    const keys = await alice.listKeys("alice@example.org");
    aliceFingerprint = keys[0]?.fingerprint ?? "";
  });

  afterAll(() => {
    for (const home of homes) {
      try {
        execFileSync("gpgconf", ["--homedir", home, "--kill", "all"], { stdio: "pipe" });
      } catch {
        // No agent was ever started for this home (e.g. Carol's).
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  const sealed = () => alice.signAndEncrypt(PAYLOAD, "alice@example.org", [aliceFingerprint]);

  it("hasSecretKey is true only where the secret key actually lives", async () => {
    await expect(alice.hasSecretKey("alice@example.org")).resolves.toBe(true);
    // Bob imported Alice's *public* key — that must never look like the ability to sign as her.
    await expect(bob.hasSecretKey("alice@example.org")).resolves.toBe(false);
    await expect(alice.hasSecretKey("nobody@example.org")).resolves.toBe(false);
  });

  // A bare address is a *substring*
  // query to gpg (`alice@example.org` matched a key for `malice@example.org`).
  it("matches an address exactly, never as a substring of a different one", async () => {
    await expect(alice.listKeys("alice@example.org")).resolves.toHaveLength(1);
    await expect(alice.listKeys("lice@example.org")).resolves.toEqual([]);
    await expect(alice.listKeys("alice@example")).resolves.toEqual([]);
    await expect(alice.hasSecretKey("lice@example.org")).resolves.toBe(false);
    await expect(
      alice.signAndEncrypt(PAYLOAD, "lice@example.org", [aliceFingerprint]),
    ).rejects.toThrow(/No secret key/);
  });

  it("round-trips: what Alice signs and encrypts, she decrypts and verifies, with her primary fingerprint and the exact payload", async () => {
    expect(aliceFingerprint).toMatch(/^[0-9A-F]{40}$/);
    const armored = await sealed();
    expect(armored.startsWith("-----BEGIN PGP MESSAGE-----")).toBe(true);
    // Confidentiality, not just signing: nothing of the payload is readable in the armor.
    expect(armored).not.toContain("AQID");
    expect(armored).not.toContain("documentId");

    const result = await alice.decryptAndVerify(armored);
    expect(result.decrypted).toBe(true);
    expect(result.signature).toBe("valid");
    expect(result.signerFingerprint).toBe(aliceFingerprint);
    expect(result.payload?.trim()).toBe(PAYLOAD);
  });

  it("does not let a keyring that holds only Alice's *public* key read what is encrypted to her", async () => {
    const result = await bob.decryptAndVerify(await sealed());
    expect(result).toEqual({ decrypted: false, signature: "missing" });
    expect(result.payload).toBeUndefined();
  });

  it("does not let an empty keyring read it either", async () => {
    await expect(carol.decryptAndVerify(await sealed())).resolves.toEqual({
      decrypted: false,
      signature: "missing",
    });
  });

  it("reports ciphertext corrupted in transit as not decrypted, without throwing", async () => {
    const lines = (await sealed()).split("\n");
    const at = lines.findIndex(
      (l, n) => n > 3 && l && !l.startsWith("=") && !l.startsWith("-----"),
    );
    const line = lines[at] as string;
    lines[at] = `${line.slice(0, 5)}${line[5] === "A" ? "B" : "A"}${line.slice(6)}`;
    const result = await alice.decryptAndVerify(lines.join("\n"));
    expect(result.decrypted).toBe(false);
    expect(result.payload).toBeUndefined();
  });

  it("reports a message encrypted to her but never signed as decrypted with a missing signature, and withholds the plaintext", async () => {
    const unsigned = execFileSync(
      "gpg",
      [
        "--homedir",
        aliceHome,
        "--batch",
        "--trust-model",
        "always",
        "--encrypt",
        "--armor",
        "--recipient",
        aliceFingerprint,
      ],
      { input: PAYLOAD, encoding: "utf8" },
    );
    const result = await alice.decryptAndVerify(unsigned);
    expect(result).toEqual({ decrypted: true, signature: "missing" });
    expect(result.payload).toBeUndefined();
  });

  it("reports plain, non-OpenPGP text as not decrypted, without throwing", async () => {
    await expect(alice.decryptAndVerify(PAYLOAD)).resolves.toEqual({
      decrypted: false,
      signature: "missing",
    });
  });

  // SMTP relays and mail clients are free to rewrite line endings — the
  // armor has to survive that or every real message would fail.
  it("still decrypts and verifies after the line endings are rewritten to CRLF in transit", async () => {
    const result = await alice.decryptAndVerify((await sealed()).replace(/\n/g, "\r\n"));
    expect(result.decrypted).toBe(true);
    expect(result.signature).toBe("valid");
    expect(result.signerFingerprint).toBe(aliceFingerprint);
  });

  describe("signAndEncrypt refuses what it must", () => {
    it("an empty recipient list", async () => {
      await expect(alice.signAndEncrypt(PAYLOAD, "alice@example.org", [])).rejects.toThrow(
        /at least one recipient/,
      );
    });

    it.each([
      ["an address", "alice@example.org"],
      ["a short key id", "AD5C3319C528CDE8"],
      ["something that looks like an option", "--armor"],
      ["a fingerprint with a stray character", `${"A".repeat(39)}Z`],
    ])("%s in place of a fingerprint", async (_name, recipient) => {
      await expect(alice.signAndEncrypt(PAYLOAD, "alice@example.org", [recipient])).rejects.toThrow(
        /40-hex-digit/,
      );
    });

    it("signing as an identity whose secret key isn't in this keyring", async () => {
      await expect(
        bob.signAndEncrypt(PAYLOAD, "alice@example.org", [aliceFingerprint]),
      ).rejects.toThrow(/No secret key/);
    });

    it("a well-formed fingerprint that isn't in the keyring, rather than encrypting to nobody", async () => {
      await expect(
        alice.signAndEncrypt(PAYLOAD, "alice@example.org", ["1".repeat(40)]),
      ).rejects.toThrow();
    });
  });

  it("throws a real error, not a verdict, when the gpg binary is missing", async () => {
    const missing = createGpgInvoker({ gpgPath: "gpg-does-not-exist" });
    await expect(missing.decryptAndVerify("anything")).rejects.toThrow();
    await expect(
      missing.signAndEncrypt("anything", "alice@example.org", ["A".repeat(40)]),
    ).rejects.toThrow();
  });
});
