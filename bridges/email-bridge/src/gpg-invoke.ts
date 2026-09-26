import { execFile, execFileSync, spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SPAWN_TIMEOUT_MS = 120_000;

/**
 * Every `gpg` call runs with `LC_ALL=C`: its human-readable messages are
 * localized, and this bridge has to recognise "no such key" from a message
 * (a German user's `gpg` would otherwise say something else entirely). The
 * machine-readable `[GNUPG:]` status lines and `--with-colons` output are
 * locale-independent already; this only pins the free-text part.
 */
function gpgEnv(): NodeJS.ProcessEnv {
  return { ...process.env, LC_ALL: "C" };
}

/**
 * `signAndEncrypt()`/`decryptAndVerify()` need to pipe text to `gpg` over
 * stdin (the payload being sent, or the message being opened) —
 * `util.promisify(execFile)`'s `{ input }` option is silently ignored
 * (`input` only exists on the *synchronous* `execFileSync`; confirmed
 * live: passing it to the async form just leaves `gpg`'s stdin open and
 * unwritten, hanging forever waiting for input that never arrives,
 * with no error). `spawn` is the correct async primitive for this —
 * this helper never rejects on a non-zero exit code (unlike
 * `execFileAsync`), since `decryptAndVerify()` reads a non-zero exit
 * together with gpg's status lines as a verdict, not necessarily a
 * failure; callers that need signAndEncrypt()-style "non-zero ⇒ throw"
 * behavior check `code` themselves.
 */
function spawnWithStdin(
  file: string,
  args: readonly string[],
  input: string,
  timeoutMs = SPAWN_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"], env: gpgEnv() });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${file} did not finish within ${timeoutMs}ms and was killed`));
    }, timeoutMs);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        code,
      });
    });
    // A gpg that exits without reading its stdin (an invalid option, a
    // crash) makes this write fail with EPIPE, delivered as an `error`
    // event on the pipe. Found on Linux CI; unhandled it is an uncaught
    // exception that would take the whole bridge process down. The exit
    // code and stderr, reported through `close`, are the real story.
    child.stdin.on("error", () => undefined);
    child.stdin.end(input, "utf8");
  });
}

/**
 * The single chokepoint every `gpg` subprocess call goes through
 * — every invocation carries the same network-hardening flags, verified
 * against a real GnuPG 2.5.22 binary to be accepted with no warnings, not
 * just assumed from documentation. This is the email
 * equivalent of `signal-daemon.ts`'s socket-not-TCP choice: one
 * reviewable place guaranteeing `gpg` never makes its own network call,
 * since `netcheck`'s static scanner has the same blind spot into a
 * spawned native binary (docs/network-policy.md).
 *
 * **Two flags that look right are deliberately absent.**
 * `--no-auto-key-upload`: GnuPG 2.4.4 — the
 * Ubuntu 24.04 the GitHub runners use — does not know it at all
 * (`invalid option`, exit 2, verified in a real container), and exit 2
 * is exactly what a "no such key" looks like, so every call would silently
 * become "the keyring has no keys". It was also a no-op for this bridge,
 * which never generates or edits a key — the only operations that upload
 * one. The flags that remain are verified identical in behaviour on
 * GnuPG 2.2.40 (Debian 12), 2.4.4 and 2.5.22, statuses included. The other
 * dropped flag: `--keyserver-options no-honor-pka-record` is an
 * unrecognized option on this GnuPG version — verified
 * (`gpg: keyserver option 'no-honor-pka-record' is unknown`), a warning
 * rather than a hard failure, but not a flag worth carrying when it
 * does nothing. PKA (a DNS-based key-discovery mechanism) appears to
 * have been removed from GnuPG itself; `--no-auto-key-locate` already
 * covers every *currently* network-capable auto-discovery mechanism
 * (WKD, DANE, LDAP, keyserver-by-mail-address) — confirmed against this
 * version's own `--help`/`--dump-options` output. One more auto-behavior
 * not in the original design is added after that same research:
 * `--no-auto-key-import` (a key embedded in a signature packet is never
 * imported automatically).
 *
 * **The existing OS-level `network-isolation` CI job's `iptables` block
 * already backstops this for free** — it blocks all non-loopback egress
 * for the restricted CI user regardless of which process makes the
 * call, so a misbehaving `gpg` invocation would fail the same canary
 * check any other stray connection would. These flags are defense-in-
 * depth for local/production use, where no such OS-level block exists.
 */
const HARDENING_ARGS = [
  "--batch",
  "--no-auto-key-retrieve",
  "--no-auto-key-locate",
  "--no-auto-key-import",
  "--keyserver-options",
  "no-honor-keyserver-url",
];

export interface GpgConfig {
  /** Defaults to `"gpg"` (resolved via `PATH`). */
  readonly gpgPath?: string;
  /** Defaults to `gpg`'s own default (`~/.gnupg`, or `$GNUPGHOME` if set) when omitted. */
  readonly gnupgHome?: string;
  /**
   * An absolute path to a keyring file. When set, this invoker's public
   * keys come from that file and **only** that file (`--no-default-keyring`);
   * the user's own keyring is not read for a public key nor written to. Secret
   * keys still live in the home directory (GnuPG keeps them apart from every
   * public keyring, in the agent's store), so the same secret key signs and
   * opens with either. Use {@link GpgInvoker.withKeyring}, not this directly.
   */
  readonly keyring?: string;
}

export interface GpgKey {
  readonly fingerprint: string;
  readonly userIds: readonly string[];
}

/**
 * The result of decrypting *and* verifying one message. `payload` is
 * present **only** when the message decrypted **and** carried exactly one
 * good signature: `gpg` echoes whatever plaintext it has to stdout for
 * every outcome (verified — a tampered signature, an unknown signer
 * and an unsigned message all still print it), so a caller must never
 * read `payload` without first checking both.
 *
 * `signature` distinguishes what a user needs told apart: `"missing"` (a
 * message that is encrypted but was never signed — or could not be
 * decrypted at all, so there is nothing to say), `"invalid"` (a bad
 * signature, one from a key this keyring never imported, more than one
 * signature, or one by an expired/revoked key), and `"valid"`.
 */
export interface GpgDecryptResult {
  /** `gpg` reported `DECRYPTION_OKAY` — the message was addressed to a secret key in this keyring and its integrity check passed. */
  readonly decrypted: boolean;
  readonly signature: "valid" | "missing" | "invalid";
  /** The signer's *primary*-key fingerprint (not a signing subkey's) — matches `parseColonKeyListing`'s own primary-key-only convention. Only with `signature: "valid"`. */
  readonly signerFingerprint?: string;
  readonly payload?: string;
}

/**
 * A user-id query for exactly one email address. **A bare address is not
 * an exact match** — verified: `gpg --list-keys alice@example.org`
 * is a *substring* search, and returned a real key whose user id was
 * `malice@example.org`. Wrapped in angle brackets, gpg matches the mail
 * address exactly (`<ice@example.org>` correctly found nothing). Every
 * lookup and every `--local-user` goes through this, so a lookalike
 * address can neither satisfy the "the keyring has this member's key"
 * guard nor be mistaken for them when pinning a fingerprint.
 */
function exactAddressQuery(address: string): string {
  return `<${address}>`;
}

export interface GpgInvoker {
  /**
   * Every *usable* (not expired/revoked/invalid/disabled) public key in
   * the local keyring whose user id carries exactly this email address —
   * empty when none do. Never reaches a keyserver/WKD/DANE/etc. —
   * `HARDENING_ARGS` guarantees this is a purely local keyring read.
   */
  listKeys(address: string): Promise<readonly GpgKey[]>;
  /** Whether the local keyring holds a usable *secret* key for exactly this address — needed before `signAndEncrypt()` can sign for it. */
  hasSecretKey(address: string): Promise<boolean>;
  /**
   * Signs `payload` with the local secret key for exactly `signer` — an
   * address, or a 40-hex-digit fingerprint, which is what a document
   * uses so that it signs with the very key its participants were told about
   * (`--local-user`) — and encrypts it to every key in `recipientFingerprints`
   * (SPECIFICATION.md EML-3), returning ASCII-armored OpenPGP. Recipients are
   * **fingerprints, never addresses**: the caller resolves who a member is
   * (their pinned fingerprint, else exactly one keyring match) so that
   * encryption can never quietly pick a different key that merely carries a
   * similar address. Rejects on an empty or malformed fingerprint list, and
   * when `gpg` fails (no secret key for the signer, an unknown recipient) —
   * check `hasSecretKey()`/`listKeys()` first for a clean error.
   */
  signAndEncrypt(
    payload: string,
    signer: string,
    recipientFingerprints: readonly string[],
  ): Promise<string>;
  /**
   * Decrypts and verifies a message produced by `signAndEncrypt()`. Never
   * throws for a message that is undecipherable here, unsigned, badly
   * signed, or not OpenPGP at all — those are a normal, expected result
   * (the bridge's receive-side rejections treat them as data, not
   * exceptions). Only a real invocation failure (the `gpg` binary
   * missing, or one that never got as far as decrypting — e.g. an option
   * it rejects) throws.
   */
  decryptAndVerify(armored: string): Promise<GpgDecryptResult>;
  /**
   * Every usable *secret* key whose user id carries exactly this address, or
   * — given a 40-hex-digit fingerprint — that one key. Empty when none.
   */
  listSecretKeys(selector: string): Promise<readonly GpgKey[]>;
  /** Every usable public key in the keyring this invoker reads, whatever its user id. */
  listAllKeys(): Promise<readonly GpgKey[]>;
  /**
   * The public keys with exactly these fingerprints, ASCII-armored and
   * *minimal* (`export-minimal`: no third-party certifications, which would
   * otherwise leak who has signed whose key). A fingerprint the keyring does
   * not hold is silently absent — the caller compares what came back.
   */
  exportKeys(fingerprints: readonly string[]): Promise<string>;
  /** Imports armored public keys into the keyring this invoker reads. Rejects when `gpg` refuses the input. */
  importKeys(armored: string): Promise<void>;
  /**
   * Opens a message **without trusting it**: `payload`-equivalent plaintext
   * whenever it decrypted, *whatever its signature says* — `gpg` prints the
   * plaintext even for a signer it has no key for. Exists for exactly one
   * caller: reading an invitation to learn which keys it carries, so that its
   * signature can then be checked against those very keys (a second, real
   * {@link decryptAndVerify}). The text must be treated as attacker input.
   */
  decryptUnverified(armored: string): Promise<{ decrypted: boolean; plaintext?: string }>;
  /**
   * An invoker reading public keys from `keyringPath` only (an absolute path;
   * created on first import). Everything else — secret keys, hardening flags,
   * the home directory — is this invoker's own.
   */
  withKeyring(keyringPath: string): GpgInvoker;
}

/**
 * Deliberately no `--pinentry-mode`: `gpg` uses the user's own
 * `gpg-agent`/pinentry setup, so a passphrase-protected key is unlocked
 * however they already unlock it (a cached agent session, or their own
 * pinentry dialog) rather than this bridge trying to handle passphrases
 * itself. `--pinentry-mode loopback` is not needed to sign: with a key
 * that needs no passphrase, signing works with and without the flag. A
 * signing call that hangs is Node's async `execFile` ignoring `input`
 * (see `spawnWithStdin`), not pinentry. **Not live-tested**: a passphrase-protected key
 * with nothing cached in the agent — the only cases exercised are keys
 * without a passphrase, so `spawnWithStdin`'s timeout is what keeps a
 * pinentry waiting for a human from blocking a request forever.
 */
function baseArgs(config: GpgConfig): string[] {
  const args = [...HARDENING_ARGS];
  if (config.gnupgHome) {
    args.push("--homedir", config.gnupgHome);
  }
  if (config.keyring !== undefined) {
    if (!isAbsolute(config.keyring)) {
      // gpg resolves a relative keyring name against its home directory,
      // which would quietly read or create a file in the user's own.
      throw new Error(`a document keyring must be an absolute path, got ${config.keyring}`);
    }
    // `--trust-model always`: nothing here consults gpg's trust database
    // (identity is the pinned fingerprint), and without it gpg may recompute
    // and rewrite the *user's* `trustdb.gpg` as a side effect of using a
    // keyring of its own.
    args.push("--no-default-keyring", "--keyring", config.keyring, "--trust-model", "always");
  }
  return args;
}

const FINGERPRINT_PATTERN = /^[0-9A-Fa-f]{40}$/;

/**
 * A key selector for `--list-*-keys`/`--local-user`: a 40-hex-digit
 * fingerprint as itself, anything else as an exact `<address>`. An address
 * always contains `@`, so the two cannot be confused, and neither form can
 * begin with `-`.
 */
function keySelector(selector: string): string {
  return FINGERPRINT_PATTERN.test(selector) ? selector.toUpperCase() : exactAddressQuery(selector);
}

/**
 * Parses `gpg --with-colons --list-keys`/`--list-secret-keys` output —
 * verified against a real generated test key (`ed25519`/`cv25519`,
 * GnuPG 2.5.22): a primary key is a `pub` line (`sec` for
 * `--list-secret-keys` — verified to be the *only* difference in
 * shape that matters here, field positions unchanged) immediately
 * followed by its own `fpr` line (the fingerprint is field 10, i.e.
 * index 9 after splitting on `:`); every `uid` line up to the next
 * `pub`/`sec` belongs to that same key (field 10 again, the user id
 * string). A `sub`/`ssb` (secret subkey) line and its own following
 * `fpr` are deliberately skipped — the binding pins a member's
 * identity to their *primary* key's fingerprint only.
 */
export function parseColonKeyListing(output: string): GpgKey[] {
  const keys: GpgKey[] = [];
  let current: { fingerprint: string; userIds: string[]; usable: boolean } | null = null;
  let expectingPrimaryFpr = false;

  const flush = () => {
    if (current?.usable) {
      keys.push({ fingerprint: current.fingerprint, userIds: current.userIds });
    }
  };

  for (const line of output.split("\n")) {
    const fields = line.split(":");
    const type = fields[0];
    if (type === "pub" || type === "sec") {
      flush();
      // Field 2 is the key's validity. An expired (`e`), revoked (`r`),
      // invalid (`i`) or disabled (`d`) key is still *listed* by gpg —
      // verified with a real key that had expired a second after
      // creation — but it is not a key this bridge can use, so it must
      // not satisfy "the keyring has a key for this member".
      current = {
        fingerprint: "",
        userIds: [],
        usable: !["e", "r", "i", "d"].includes(fields[1] ?? ""),
      };
      expectingPrimaryFpr = true;
      continue;
    }
    if (type === "sub" || type === "ssb") {
      expectingPrimaryFpr = false;
      continue;
    }
    if (type === "fpr" && expectingPrimaryFpr && current) {
      current.fingerprint = fields[9] ?? "";
      expectingPrimaryFpr = false;
      continue;
    }
    if (type === "uid" && current) {
      const userId = fields[9];
      if (userId) {
        current.userIds.push(userId);
      }
    }
  }
  flush();
  return keys;
}

const SIGNATURE_STATUS_WORDS = [
  "GOODSIG",
  "BADSIG",
  "EXPKEYSIG",
  "EXPSIG",
  "REVKEYSIG",
  "ERRSIG",
  "NO_PUBKEY",
  "VALIDSIG",
];

/**
 * Parses `gpg --status-fd 2 --decrypt -`'s stderr for one sign+encrypt
 * message — verified against real GnuPG 2.5.22, 2.4.4 and
 * 2.2.40 (status lines identical on all three) for every outcome that
 * matters:
 *
 * - **good**: `ENC_TO`, `GOODSIG <keyid> <uid>`, `VALIDSIG <sig-key-fpr>
 *   <date> <ts> <expire> <ver> <reserved> <pubkey-algo> <hash-algo>
 *   <sig-class> <primary-key-fpr>` (the *last* field, the primary key's
 *   fingerprint, is what this returns), then `DECRYPTION_OKAY`;
 * - **not addressed to a key here**: `ENC_TO`, `NO_SECKEY`,
 *   `DECRYPTION_FAILED`, empty stdout;
 * - **corrupted ciphertext**: only `FAILURE`, no `DECRYPTION_OKAY`, empty
 *   stdout;
 * - **encrypted but never signed**: `DECRYPTION_OKAY` and *no* signature
 *   status word at all;
 * - a **signature by a key this keyring never imported**: `ERRSIG` +
 *   `NO_PUBKEY` (no `GOODSIG`/`VALIDSIG`).
 *
 * The plaintext is trusted only after **both** halves hold, each failing
 * closed: `DECRYPTION_OKAY` exactly once and never alongside
 * `DECRYPTION_FAILED`; and exactly one `GOODSIG` with exactly one
 * `VALIDSIG` (gpg reports an expired/revoked key's signature under other
 * words, and a message carrying several signatures could otherwise have
 * its pinned-fingerprint comparison satisfied by whichever came first).
 */
export function extractDecryptResult(stdout: string, stderr: string): GpgDecryptResult {
  const lines = stderr.split("\n");
  const count = (word: string) =>
    lines.filter((line) => line.startsWith(`[GNUPG:] ${word}`)).length;
  const decrypted = count("DECRYPTION_OKAY") === 1 && count("DECRYPTION_FAILED") === 0;

  const validsigLines = lines.filter((line) => line.startsWith("[GNUPG:] VALIDSIG "));
  const validsigLine = validsigLines[0];
  const good = count("GOODSIG ") === 1 && validsigLines.length === 1 && validsigLine !== undefined;
  const anySignatureWord = SIGNATURE_STATUS_WORDS.some((word) => count(`${word} `) > 0);

  let fingerprint: string | undefined;
  if (good && validsigLine) {
    const fields = validsigLine.trim().split(/\s+/);
    // ["[GNUPG:]", "VALIDSIG", sigKeyFpr, date, ts, expire, ver, reserved, pubkeyAlgo, hashAlgo, sigClass, primaryKeyFpr]
    fingerprint = fields.length >= 12 ? fields[11] : fields[2];
  }

  if (!decrypted) {
    return { decrypted: false, signature: "missing" };
  }
  if (fingerprint) {
    return { decrypted: true, signature: "valid", signerFingerprint: fingerprint, payload: stdout };
  }
  return { decrypted: true, signature: anySignatureWord ? "invalid" : "missing" };
}

interface ExecFileError extends Error {
  readonly code?: number | string;
  readonly stderr?: string;
}

function isNoSuchKey(error: unknown, message: string): boolean {
  return (
    isExecFileError(error) &&
    typeof error.code === "number" &&
    typeof error.stderr === "string" &&
    error.stderr.includes(message)
  );
}

function gpgFailure(operation: string, error: unknown): Error {
  if (isExecFileError(error) && typeof error.stderr === "string" && error.stderr.trim()) {
    return new Error(`gpg ${operation} failed: ${error.stderr.trim()}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function isExecFileError(error: unknown): error is ExecFileError {
  return error instanceof Error && "code" in error;
}

/**
 * A one-shot startup probe — `index.ts` uses this to decide whether to
 * construct a real `GpgInvoker` at all, mirroring `bridges/signal-bridge`'s
 * own `hasSignalCli()` pattern: PGP support stays a graceful "not
 * available" (`/pgp/status` reporting `enabled: false`) rather than a
 * per-request `ENOENT` surfacing as a confusing 502, when no `gpg`
 * binary is installed at all.
 */
export function hasGpgAvailable(gpgPath = "gpg"): boolean {
  try {
    execFileSync(gpgPath, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function createGpgInvoker(config: GpgConfig = {}): GpgInvoker {
  const gpgPath = config.gpgPath ?? "gpg";

  /**
   * `gpg --decrypt` over stdin, with `--status-fd 2` (not the default 1) so
   * the plaintext (stdout) and the machine-readable status (stderr) stay in
   * separate streams — verified to separate cleanly even though gpg's
   * own human-readable diagnostics land in stderr too.
   */
  async function runDecrypt(armored: string): Promise<{ stdout: string; stderr: string }> {
    const { stdout, stderr, code } = await spawnWithStdin(
      gpgPath,
      [...baseArgs(config), "--status-fd", "2", "--decrypt", "-"],
      armored,
    );
    // Every genuine outcome emits at least one `[GNUPG:]` status line. None at
    // all means gpg never got as far as decrypting (an unknown option, a
    // crash): a broken setup to report, not a verdict on this message —
    // reading it as "undecipherable" would silently reject every message a
    // document ever receives.
    if (code !== 0 && !stderr.includes("[GNUPG:] ")) {
      throw new Error(`gpg --decrypt failed before decrypting (exit ${code}): ${stderr.trim()}`);
    }
    return { stdout, stderr };
  }

  async function listKeyring(
    listOption: "--list-keys" | "--list-secret-keys",
    query: string | undefined,
    noKeyMessage: string,
  ): Promise<readonly GpgKey[]> {
    try {
      const { stdout } = await execFileAsync(
        gpgPath,
        [...baseArgs(config), "--with-colons", listOption, ...(query === undefined ? [] : [query])],
        { env: gpgEnv() },
      );
      return parseColonKeyListing(stdout);
    } catch (error) {
      // Verified: gpg exits 2 with "No public key"/"No secret key" when
      // nothing matches — an empty result, not a failure. **Exit 2 alone is
      // not enough to conclude that**: an unknown option (a `gpg` version
      // that lacks one of our flags — real, found on GnuPG 2.4.4) also exits
      // 2, and reading it as "no keys" would turn a broken setup into a
      // baffling "missing PGP key". Only the message says which.
      if (isNoSuchKey(error, noKeyMessage)) {
        return [];
      }
      throw gpgFailure(listOption, error);
    }
  }

  return {
    listKeys(address) {
      return listKeyring("--list-keys", exactAddressQuery(address), "No public key");
    },

    listAllKeys() {
      return listKeyring("--list-keys", undefined, "No public key");
    },

    listSecretKeys(selector) {
      return listKeyring("--list-secret-keys", keySelector(selector), "No secret key");
    },

    async hasSecretKey(address) {
      return (
        (await listKeyring("--list-secret-keys", keySelector(address), "No secret key")).length > 0
      );
    },

    async exportKeys(fingerprints) {
      if (fingerprints.length === 0) {
        throw new Error("exportKeys needs at least one fingerprint");
      }
      for (const fingerprint of fingerprints) {
        if (!FINGERPRINT_PATTERN.test(fingerprint)) {
          throw new Error(`not a 40-hex-digit key fingerprint: ${JSON.stringify(fingerprint)}`);
        }
      }
      try {
        const { stdout } = await execFileAsync(
          gpgPath,
          [
            ...baseArgs(config),
            "--armor",
            "--export-options",
            "export-minimal",
            "--export",
            ...fingerprints.map((fingerprint) => fingerprint.toUpperCase()),
          ],
          { env: gpgEnv(), maxBuffer: 16 * 1024 * 1024 },
        );
        return stdout;
      } catch (error) {
        throw gpgFailure("--export", error);
      }
    },

    async importKeys(armored) {
      // `import-minimal`: keep only what identifies the key, dropping every
      // third-party certification an untrusted block might carry.
      const { stderr, code } = await spawnWithStdin(
        gpgPath,
        [...baseArgs(config), "--import-options", "import-minimal", "--import"],
        armored,
      );
      if (code !== 0) {
        throw new Error(`gpg --import failed (exit ${code}): ${stderr.trim()}`);
      }
    },

    async signAndEncrypt(payload, signer, recipientFingerprints) {
      // A fingerprint is exactly 40 hex digits (a v4 primary key). Anything
      // else — an address, a short key id, something starting with `-` — is
      // refused before it reaches gpg's argv, where a short id could match
      // more than one key and an address is exactly the ambiguity this
      // whole design avoids.
      if (recipientFingerprints.length === 0) {
        throw new Error("signAndEncrypt needs at least one recipient fingerprint");
      }
      for (const fingerprint of recipientFingerprints) {
        if (!FINGERPRINT_PATTERN.test(fingerprint)) {
          throw new Error(`not a 40-hex-digit key fingerprint: ${JSON.stringify(fingerprint)}`);
        }
      }
      const { stdout, stderr, code } = await spawnWithStdin(
        gpgPath,
        [
          ...baseArgs(config),
          // Encrypting to an imported key that gpg's own web of trust does not
          // rate fully valid is *refused* in batch mode ("Unusable public
          // key", verified). This bridge's trust anchor is the
          // fingerprint pinned for each member, not gpg's trust database, so
          // this bridge tells gpg to take the fingerprints it is handed at
          // their word — which is why they must never be resolved loosely.
          // (A keyring-scoped invoker already carries the flag for every call.)
          ...(config.keyring === undefined ? ["--trust-model", "always"] : []),
          "--local-user",
          keySelector(signer),
          "--sign",
          "--encrypt",
          "--armor",
          ...recipientFingerprints.flatMap((fingerprint) => ["--recipient", fingerprint]),
        ],
        payload,
      );
      // No "empty" result exists for a failed encryption — a missing secret
      // key (verified: exit 2, "No secret key") or an unknown
      // recipient must propagate as a real error, never be swallowed.
      if (code !== 0) {
        throw new Error(
          `gpg --sign --encrypt failed for ${signer} (exit ${code}): ${stderr.trim()}`,
        );
      }
      return stdout;
    },

    async decryptAndVerify(armored) {
      const { stdout, stderr } = await runDecrypt(armored);
      return extractDecryptResult(stdout, stderr);
    },

    async decryptUnverified(armored) {
      const { stdout, stderr } = await runDecrypt(armored);
      const lines = stderr.split("\n");
      const count = (word: string) =>
        lines.filter((line) => line.startsWith(`[GNUPG:] ${word}`)).length;
      const decrypted = count("DECRYPTION_OKAY") === 1 && count("DECRYPTION_FAILED") === 0;
      return decrypted ? { decrypted, plaintext: stdout } : { decrypted };
    },

    withKeyring(keyringPath) {
      return createGpgInvoker({ ...config, keyring: keyringPath });
    },
  };
}
