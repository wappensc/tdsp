import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// infra/email-testserver isn't a pnpm workspace package — see
// contract.test.ts's own comment on these relative imports.
import {
  hasGpgBinary,
  type ProvisionedGpgHomes,
  provisionGpgHomesInChildProcess,
} from "../../../infra/email-testserver/gpg-homes.ts";
import { createGpgInvoker, type GpgInvoker } from "./gpg-invoke.ts";

const ALICE = "alice@example.org";
const BOB = "bob@example.org";
const CAROL = "carol@example.org";
const PAYLOAD = JSON.stringify({ tdsp: 1, kind: "invite", documentId: "doc-1" });

/**
 * Real `gpg`: the per-document keyring (SPECIFICATION.md EML-4) (`GpgInvoker.withKeyring`).
 * What the whole key-distribution design rests on — that a bridge-owned public
 * keyring can be used to sign, encrypt, decrypt and verify with a secret key
 * that lives in the user's home, without ever reading a public key from, or
 * writing anything to, the user's own keyring — behaves identically on
 * GnuPG 2.2.40, 2.4.4 and 2.5.22; these are the regression tests for it on
 * whatever `gpg` this machine has. One provisioning in a child process (`gpg-invoke.test.ts`
 * explains the Vitest gpg-agent quirk that forces it).
 *
 * Scenario: Alice is the creator and holds everyone's public key. Bob is a
 * joiner who knows nobody — his own keyring is stripped of Alice's and
 * Carol's keys, so anything he can do with them he does through a keyring of
 * the document's own.
 */
describe.skipIf(!hasGpgBinary())("per-document keyring (real gpg)", () => {
  let provisioned: ProvisionedGpgHomes;
  let scratch = "";
  let alice: GpgInvoker;
  let bob: GpgInvoker;
  let bobHome = "";
  const fp = (address: string) => provisioned.fingerprints.get(address) as string;
  const keyringPath = (name: string) => join(scratch, `${name}.kbx`);

  beforeAll(() => {
    provisioned = provisionGpgHomesInChildProcess([ALICE, BOB, CAROL]);
    scratch = mkdtempSync(join(tmpdir(), "eb-kr-"));
    bobHome = provisioned.homes.get(BOB) as string;
    for (const stranger of [ALICE, CAROL]) {
      execFileSync(
        "gpg",
        ["--homedir", bobHome, "--batch", "--yes", "--delete-keys", fp(stranger)],
        { stdio: "pipe" },
      );
    }
    alice = createGpgInvoker({ gnupgHome: provisioned.homes.get(ALICE) });
    bob = createGpgInvoker({ gnupgHome: bobHome });
  }, 60_000);

  afterAll(() => {
    provisioned?.cleanup();
    rmSync(scratch, { recursive: true, force: true });
  });

  const digest = (path: string) => {
    try {
      return createHash("sha256").update(readFileSync(path)).digest("hex");
    } catch {
      return "absent";
    }
  };
  const creatorSet = () => alice.exportKeys([fp(ALICE), fp(BOB), fp(CAROL)]);
  const invite = () => alice.signAndEncrypt(PAYLOAD, fp(ALICE), [fp(BOB)]);

  it("refuses a relative keyring path, which gpg would resolve inside the user's own home", () => {
    expect(() => bob.withKeyring("relative.kbx").listAllKeys()).rejects.toThrow(/absolute/);
  });

  it("starts empty, and holds exactly what was imported — every key, listable by its exact address", async () => {
    const doc = bob.withKeyring(keyringPath("set"));
    await expect(doc.listAllKeys()).resolves.toEqual([]);

    await doc.importKeys(await creatorSet());

    const all = await doc.listAllKeys();
    expect(all.map((key) => key.fingerprint).sort()).toEqual(
      [fp(ALICE), fp(BOB), fp(CAROL)].sort(),
    );
    for (const address of [ALICE, BOB, CAROL]) {
      const keys = await doc.listKeys(address);
      expect(keys.map((key) => key.fingerprint)).toEqual([fp(address)]);
    }
    await expect(doc.listKeys("lice@example.org")).resolves.toEqual([]);
  });

  it("never reads a public key from, or writes anything to, the user's own keyring", async () => {
    const files = ["pubring.kbx", "trustdb.gpg"].map((name) => join(bobHome, name));
    const before = files.map(digest);

    const doc = bob.withKeyring(keyringPath("isolation"));
    await doc.importKeys(await creatorSet());
    await doc.listAllKeys();
    await doc.listKeys(ALICE);
    await doc.signAndEncrypt("edit", fp(BOB), [fp(ALICE), fp(CAROL)]);
    await doc.decryptUnverified(await invite());
    await doc.decryptAndVerify(await invite());

    // Neither file of the user's own keyring was touched — the trust database included.
    // (Measured *before* asking the user's own keyring anything: even a plain
    // listing through it may recompute its trust database.)
    expect(files.map(digest)).toEqual(before);
    // And it still knows nobody but Bob.
    await expect(bob.listKeys(ALICE)).resolves.toEqual([]);
    await expect(bob.listKeys(CAROL)).resolves.toEqual([]);
  });

  it("reads only its own keyring: a key held by the user is invisible to it", async () => {
    const doc = bob.withKeyring(keyringPath("only-own"));
    await expect(doc.listKeys(BOB)).resolves.toEqual([]);
  });

  it("cannot open a message with an empty keyring, even though the secret key is in the home: gpg needs the public half beside it", async () => {
    const doc = bob.withKeyring(keyringPath("empty"));
    const armored = await invite();
    await expect(doc.decryptUnverified(armored)).resolves.toEqual({ decrypted: false });
    await expect(doc.decryptAndVerify(armored)).resolves.toEqual({
      decrypted: false,
      signature: "missing",
    });
  });

  it("opens an invitation in two steps: first without trusting it, then verified once the keys it carries are in the keyring", async () => {
    const armored = await invite();

    // Step 1 — a keyring holding only Bob's own public key (taken from his ring).
    const ownOnly = bob.withKeyring(keyringPath("own-only"));
    await ownOnly.importKeys(await bob.exportKeys([fp(BOB)]));
    const unverified = await ownOnly.decryptUnverified(armored);
    expect(unverified.decrypted).toBe(true);
    expect(unverified.plaintext?.trim()).toBe(PAYLOAD);
    // The signer is unknown here, so nothing may be *trusted* from this read.
    const notVerified = await ownOnly.decryptAndVerify(armored);
    expect(notVerified.decrypted).toBe(true);
    expect(notVerified.signature).toBe("invalid");
    expect(notVerified.payload).toBeUndefined();

    // Step 2 — the keyring built from the set the invitation itself carries.
    const full = bob.withKeyring(keyringPath("full"));
    await full.importKeys(await creatorSet());
    const verified = await full.decryptAndVerify(armored);
    expect(verified.signature).toBe("valid");
    expect(verified.signerFingerprint).toBe(fp(ALICE));
    expect(verified.payload?.trim()).toBe(PAYLOAD);
  });

  it("does not open what is encrypted to a different key than the one it holds, however it is asked", async () => {
    const toCarolOnly = await alice.signAndEncrypt(PAYLOAD, fp(ALICE), [fp(CAROL)]);
    const doc = bob.withKeyring(keyringPath("wrong-recipient"));
    await doc.importKeys(await creatorSet());
    await expect(doc.decryptUnverified(toCarolOnly)).resolves.toEqual({ decrypted: false });
    await expect(doc.decryptAndVerify(toCarolOnly)).resolves.toEqual({
      decrypted: false,
      signature: "missing",
    });
  });

  it("signs with exactly the key named by fingerprint, and a peer verifies it against that fingerprint", async () => {
    const doc = bob.withKeyring(keyringPath("signing"));
    await doc.importKeys(await creatorSet());
    const armored = await doc.signAndEncrypt("hello", fp(BOB), [fp(ALICE)]);
    const result = await alice.decryptAndVerify(armored);
    expect(result.signature).toBe("valid");
    expect(result.signerFingerprint).toBe(fp(BOB));
  });

  it("refuses to encrypt to a fingerprint its keyring does not hold, rather than to nobody", async () => {
    const doc = bob.withKeyring(keyringPath("missing-recipient"));
    await doc.importKeys(await bob.exportKeys([fp(BOB)]));
    await expect(doc.signAndEncrypt("x", fp(BOB), [fp(CAROL)])).rejects.toThrow(/No public key/);
  });

  it("finds secret keys by exact address or by fingerprint, and never mistakes a public-only key for one", async () => {
    await expect(bob.listSecretKeys(BOB)).resolves.toHaveLength(1);
    await expect(bob.listSecretKeys(fp(BOB))).resolves.toHaveLength(1);
    await expect(bob.hasSecretKey(fp(BOB))).resolves.toBe(true);
    await expect(alice.hasSecretKey(fp(BOB))).resolves.toBe(false);
    await expect(alice.listSecretKeys(BOB)).resolves.toEqual([]);
    await expect(bob.listSecretKeys("ob@example.org")).resolves.toEqual([]);
  });

  it("exports the key material and self-signatures only — never other people's certifications of it", async () => {
    // Alice certifies Bob's key in her own ring: a real third-party signature.
    execFileSync(
      "gpg",
      [
        "--homedir",
        provisioned.homes.get(ALICE) as string,
        "--batch",
        "--yes",
        "--quick-sign-key",
        fp(BOB),
      ],
      { stdio: "pipe" },
    );
    const plain = execFileSync(
      "gpg",
      [
        "--homedir",
        provisioned.homes.get(ALICE) as string,
        "--batch",
        "--armor",
        "--export",
        fp(BOB),
      ],
      { encoding: "utf8" },
    );
    const minimal = await alice.exportKeys([fp(BOB)]);
    expect(minimal.length).toBeLessThan(plain.length);
    // …and it is still a complete, importable key.
    const doc = createGpgInvoker({ gnupgHome: bobHome }).withKeyring(keyringPath("minimal"));
    await doc.importKeys(minimal);
    expect((await doc.listKeys(BOB)).map((key) => key.fingerprint)).toEqual([fp(BOB)]);
  });

  it("refuses to export anything but 40-hex-digit fingerprints, or nothing at all", async () => {
    await expect(alice.exportKeys([])).rejects.toThrow(/at least one/);
    await expect(alice.exportKeys([ALICE])).rejects.toThrow(/40-hex/);
    await expect(alice.exportKeys(["--help"])).rejects.toThrow(/40-hex/);
  });

  it("rejects an import of something that is not a key, rather than pretending it worked", async () => {
    const doc = bob.withKeyring(keyringPath("garbage"));
    await expect(doc.importKeys("this is not a key")).rejects.toThrow(/import failed/);
  });
});
