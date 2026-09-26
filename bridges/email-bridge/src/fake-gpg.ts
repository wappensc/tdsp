import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { GpgDecryptResult, GpgInvoker, GpgKey } from "./gpg-invoke.ts";

/**
 * L0 — a fake `GpgInvoker` for `*.test.ts` files only (never imported by
 * production code), letting `server.test.ts` and `sync-state.test.ts`
 * exercise the sign+encrypt / decrypt+verify plumbing — including
 * adversarial cases like a forged `From:`, a key rotation or an
 * eavesdropper — without a real `gpg` binary. The real one is covered
 * separately by `gpg-invoke.test.ts` and `gpg-crypto.test.ts` (real
 * `gpg`) and by the live Greenmail runs.
 *
 * It models just enough of PGP to make those tests meaningful, not PGP
 * itself:
 *
 * - a "message" is armored text naming the fingerprints it is **encrypted
 *   to**, an optional **signature** (the signer's fingerprint plus a
 *   SHA-256 of the exact payload, so editing the payload after signing
 *   genuinely breaks it) and the payload;
 * - it opens only in a keyring that holds a *secret* key whose fingerprint
 *   is among the recipients — the property that makes an eavesdropper
 *   unable to read it;
 * - its signature only verifies if the *opening* keyring has imported
 *   (`seedKey`) a key with the signer's fingerprint — the same "valid
 *   signature, but only against a key I hold" property that makes the real
 *   thing's identity check necessary.
 */
export class FakeGpgInvoker implements GpgInvoker {
  /** Every address `listKeys` was asked about, across this invoker and every keyring view of it. */
  readonly queriedAddresses: string[];
  /** Every `signAndEncrypt` call: what was sent, as whom (as passed: an address or a fingerprint), and to which fingerprints. */
  readonly encrypted: { payload: string; signer: string; recipients: string[] }[];
  /** Every message handed to `decryptAndVerify` or `decryptUnverified`. */
  readonly opened: string[];
  readonly #shared: SharedFakeState;
  /** The user's own keyring, in memory. Unused by a keyring-scoped view, whose keys live in a real file — so that the bridge moving it into place moves its contents too. */
  #memory = new Map<string, GpgKey[]>();
  readonly #keyringPath: string | undefined;
  readonly #scoped: boolean;

  constructor(shared?: SharedFakeState, keyringPath?: string) {
    this.#shared = shared ?? {
      secretKeys: new Map(),
      queriedAddresses: [],
      encrypted: [],
      opened: [],
    };
    this.queriedAddresses = this.#shared.queriedAddresses;
    this.encrypted = this.#shared.encrypted;
    this.opened = this.#shared.opened;
    this.#keyringPath = keyringPath;
    this.#scoped = keyringPath !== undefined;
  }

  /** The keys this view reads: the in-memory ring, or the keyring file as it is right now. */
  #ring(): Map<string, GpgKey[]> {
    if (this.#keyringPath === undefined) {
      return this.#memory;
    }
    try {
      return new Map(
        Object.entries(
          JSON.parse(readFileSync(this.#keyringPath, "utf8")) as Record<string, GpgKey[]>,
        ),
      );
    } catch {
      return new Map();
    }
  }

  #save(ring: Map<string, GpgKey[]>): void {
    if (this.#keyringPath === undefined) {
      this.#memory = ring;
      return;
    }
    mkdirSync(dirname(this.#keyringPath), { recursive: true });
    writeFileSync(this.#keyringPath, JSON.stringify(Object.fromEntries(ring)));
  }

  /** This keyring holds `address`'s public key (by default a made-up fingerprint of forty `A`s). */
  seedKey(address: string, key: GpgKey = fakeKey("A", address)): void {
    const ring = this.#ring();
    ring.set(address, [...(ring.get(address) ?? []), key]);
    this.#save(ring);
  }

  /** Drops every key with this fingerprint from this keyring — a document keyring that lost a key it was built with. */
  removeKey(fingerprint: string): void {
    const ring = this.#ring();
    for (const [address, keys] of ring) {
      ring.set(
        address,
        keys.filter((key) => key.fingerprint.toUpperCase() !== fingerprint.toUpperCase()),
      );
    }
    this.#save(ring);
  }

  /** This keyring holds `address`'s *secret* key, and signs with / decrypts to `fingerprint`. */
  seedSecretKey(address: string, fingerprint: string = "A".repeat(40)): void {
    this.#shared.secretKeys.set(address, fingerprint.toUpperCase());
  }

  async listKeys(address: string): Promise<readonly GpgKey[]> {
    this.queriedAddresses.push(address);
    // Letter case ignored, as real gpg does for an exact `<address>` query (verified with
    // GnuPG 2.5.24: a key for Alice@Example.org is found by <alice@example.org>).
    const wanted = address.toLowerCase();
    return [...this.#ring()]
      .filter(([seeded]) => seeded.toLowerCase() === wanted)
      .flatMap(([, keys]) => keys);
  }

  async listAllKeys(): Promise<readonly GpgKey[]> {
    const byFingerprint = new Map<string, GpgKey>();
    for (const key of [...this.#ring().values()].flat()) {
      byFingerprint.set(key.fingerprint.toUpperCase(), key);
    }
    return [...byFingerprint.values()];
  }

  async hasSecretKey(selector: string): Promise<boolean> {
    return (await this.listSecretKeys(selector)).length > 0;
  }

  async listSecretKeys(selector: string): Promise<readonly GpgKey[]> {
    const wanted = selector.toUpperCase();
    return [...this.#shared.secretKeys]
      .filter(([address, fingerprint]) =>
        /^[0-9A-F]{40}$/.test(wanted) ? fingerprint === wanted : address === selector,
      )
      .map(([address, fingerprint]) => ({ fingerprint, userIds: [address] }));
  }

  async exportKeys(fingerprints: readonly string[]): Promise<string> {
    if (fingerprints.length === 0) {
      throw new Error("exportKeys needs at least one fingerprint");
    }
    const wanted = new Set(fingerprints.map((f) => f.toUpperCase()));
    const pool = new Map<string, GpgKey>();
    for (const key of [...this.#ring().values()].flat()) {
      pool.set(key.fingerprint.toUpperCase(), key);
    }
    if (!this.#scoped) {
      for (const [address, fingerprint] of this.#shared.secretKeys) {
        if (!pool.has(fingerprint)) {
          pool.set(fingerprint, { fingerprint, userIds: [address] });
        }
      }
    }
    const found = [...wanted].flatMap((fingerprint) => pool.get(fingerprint) ?? []);
    return fakeKeyBlock(found);
  }

  async importKeys(armored: string): Promise<void> {
    const keys = parseFakeKeyBlock(armored);
    if (keys === undefined) {
      throw new Error("gpg --import failed (exit 2): no valid OpenPGP data found");
    }
    const ring = this.#ring();
    for (const key of keys) {
      for (const userId of key.userIds) {
        const address = addressOfUserId(userId);
        const existing = ring.get(address) ?? [];
        if (!existing.some((k) => k.fingerprint.toUpperCase() === key.fingerprint.toUpperCase())) {
          ring.set(address, [...existing, key]);
        }
      }
    }
    this.#save(ring);
  }

  withKeyring(keyringPath: string): FakeGpgInvoker {
    return new FakeGpgInvoker(this.#shared, keyringPath);
  }

  async signAndEncrypt(
    payload: string,
    signer: string,
    recipientFingerprints: readonly string[],
  ): Promise<string> {
    const fingerprint = (await this.listSecretKeys(signer))[0]?.fingerprint;
    if (fingerprint === undefined) {
      throw new Error(`gpg --sign --encrypt failed for ${signer}: No secret key`);
    }
    if (this.#scoped && !this.#knowsPublicFingerprint(fingerprint)) {
      throw new Error(`gpg --sign --encrypt failed for ${signer}: No public key for the signer`);
    }
    if (recipientFingerprints.length === 0) {
      throw new Error("signAndEncrypt needs at least one recipient fingerprint");
    }
    for (const recipient of recipientFingerprints) {
      if (!/^[0-9A-Fa-f]{40}$/.test(recipient)) {
        throw new Error(`not a 40-hex-digit key fingerprint: ${JSON.stringify(recipient)}`);
      }
      if (!this.#knowsPublicFingerprint(recipient)) {
        throw new Error(`gpg --sign --encrypt failed: ${recipient}: No public key`);
      }
    }
    const recipients = recipientFingerprints.map((r) => r.toUpperCase());
    this.encrypted.push({ payload, signer, recipients });
    return fakeEncrypt({ payload, recipients, signerFingerprint: fingerprint });
  }

  async decryptUnverified(armored: string): Promise<{ decrypted: boolean; plaintext?: string }> {
    this.opened.push(armored);
    const message = parseFakeMessage(armored);
    if (!message || !this.#canOpen(message.recipients)) {
      return { decrypted: false };
    }
    return { decrypted: true, plaintext: `${message.payload}\n` };
  }

  async decryptAndVerify(armored: string): Promise<GpgDecryptResult> {
    this.opened.push(armored);
    const message = parseFakeMessage(armored);
    if (!message) {
      return { decrypted: false, signature: "missing" };
    }
    if (!this.#canOpen(message.recipients)) {
      return { decrypted: false, signature: "missing" }; // not addressed to a key held here
    }
    if (message.signatureFingerprint === undefined) {
      return { decrypted: true, signature: "missing" };
    }
    const tampered = sha256(message.payload) !== message.digest;
    if (tampered || !this.#knowsPublicFingerprint(message.signatureFingerprint)) {
      return { decrypted: true, signature: "invalid" };
    }
    return {
      decrypted: true,
      signature: "valid",
      signerFingerprint: message.signatureFingerprint,
      payload: `${message.payload}\n`,
    };
  }

  /**
   * Opening needs a *secret* key among the recipients — and, in a keyring-
   * scoped view, that key's *public* half in this very keyring, which is what
   * real `gpg` needs to find the secret key again (verified on GnuPG
   * 2.2.40, 2.4.4 and 2.5.22: an empty keyring gives "No secret key").
   */
  #canOpen(recipients: readonly string[]): boolean {
    const ownSecret = new Set(this.#shared.secretKeys.values());
    return recipients.some(
      (r) => ownSecret.has(r) && (!this.#scoped || this.#knowsPublicFingerprint(r)),
    );
  }

  #knowsPublicFingerprint(fingerprint: string): boolean {
    const wanted = fingerprint.toUpperCase();
    const inPublic = [...this.#ring().values()]
      .flat()
      .some((key) => key.fingerprint.toUpperCase() === wanted);
    return inPublic || (!this.#scoped && [...this.#shared.secretKeys.values()].includes(wanted));
  }
}

interface SharedFakeState {
  readonly secretKeys: Map<string, string>;
  readonly queriedAddresses: string[];
  readonly encrypted: { payload: string; signer: string; recipients: string[] }[];
  readonly opened: string[];
}

/** `Name <addr>` → `addr`; a bare address is its own. */
function addressOfUserId(userId: string): string {
  return /<([^>]+)>/.exec(userId)?.[1] ?? userId;
}

/** A fake armored public-key block carrying exactly these keys. */
export function fakeKeyBlock(keys: readonly GpgKey[]): string {
  return `-----BEGIN PGP PUBLIC KEY BLOCK-----\nVersion: FAKE\nkeys:${Buffer.from(JSON.stringify(keys), "utf8").toString("base64")}\n-----END PGP PUBLIC KEY BLOCK-----\n`;
}

/** What a fake key block really carries, for a test to inspect what was actually sent. */
export function inspectFakeKeyBlock(text: string): readonly GpgKey[] | undefined {
  return parseFakeKeyBlock(text);
}

function parseFakeKeyBlock(text: string): GpgKey[] | undefined {
  const match =
    /^-----BEGIN PGP PUBLIC KEY BLOCK-----\nVersion: FAKE\nkeys:([A-Za-z0-9+/=]*)\n-----END PGP PUBLIC KEY BLOCK-----\n?$/.exec(
      text.trim(),
    );
  if (!match) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(match[1] as string, "base64").toString("utf8"));
    return Array.isArray(parsed) ? (parsed as GpgKey[]) : undefined;
  } catch {
    return undefined;
  }
}

/** A fake public key whose fingerprint is `char` repeated forty times — distinct per participant so a test can tell recipients apart. */
export function fakeKey(char: string, address: string): GpgKey {
  return { fingerprint: char.repeat(40), userIds: [address] };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * A fake sign+encrypt message. Every field a test might want to vary is a
 * parameter: leave `signerFingerprint` out for "encrypted but never
 * signed", pass a `digest` that doesn't match the payload for "altered
 * after signing".
 */
export function fakeEncrypt(options: {
  payload: string;
  recipients: readonly string[];
  signerFingerprint?: string;
  digest?: string;
}): string {
  const signature =
    options.signerFingerprint === undefined
      ? ""
      : `signature:${options.signerFingerprint.toUpperCase()}:${options.digest ?? sha256(options.payload)}\n`;
  return `-----BEGIN PGP MESSAGE-----\nVersion: FAKE\nrecipients:${options.recipients.map((r) => r.toUpperCase()).join(",")}\n${signature}payload:${Buffer.from(options.payload, "utf8").toString("base64")}\n-----END PGP MESSAGE-----\n`;
}

/** A signed but *not* encrypted message — for testing that a PGP-enabled document refuses it. */
export function fakeClearsign(payload: string, fingerprint: string): string {
  return `-----BEGIN PGP SIGNED MESSAGE-----\nHash: FAKE\n\n${payload}\n-----BEGIN PGP SIGNATURE-----\nsignature:${fingerprint}:${sha256(payload)}\n-----END PGP SIGNATURE-----\n`;
}

interface ParsedFakeMessage {
  readonly payload: string;
  readonly recipients: readonly string[];
  readonly signatureFingerprint: string | undefined;
  readonly digest: string | undefined;
}

function parseFakeMessage(text: string): ParsedFakeMessage | undefined {
  const match =
    /^-----BEGIN PGP MESSAGE-----\nVersion: FAKE\nrecipients:([0-9A-F,]+)\n(?:signature:([0-9A-F]+):([0-9a-f]{64})\n)?payload:([A-Za-z0-9+/=]*)\n-----END PGP MESSAGE-----\n?$/.exec(
      text.trimStart(),
    );
  if (!match) {
    return undefined;
  }
  return {
    recipients: (match[1] as string).split(","),
    signatureFingerprint: match[2],
    digest: match[3],
    payload: Buffer.from(match[4] as string, "base64").toString("utf8"),
  };
}

/** What a fake message really contains, for a test to inspect what was actually sent — its plaintext, who it is encrypted to, and who signed it. */
export function inspectFakeMessage(
  text: string,
): { payload: string; recipients: readonly string[]; signer: string | undefined } | undefined {
  const parsed = parseFakeMessage(text);
  return (
    parsed && {
      payload: parsed.payload,
      recipients: parsed.recipients,
      signer: parsed.signatureFingerprint,
    }
  );
}

/** The same message with its payload altered *after* signing — the digest no longer matches. */
export function tamperWithFakeMessage(text: string): string {
  return text.replace(/payload:([A-Za-z0-9+/=]+)/, (_all, body: string) => {
    const flipped = (body[0] === "A" ? "B" : "A") + body.slice(1);
    return `payload:${flipped}`;
  });
}
