import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGpgInvoker, parseColonKeyListing } from "./gpg-invoke.ts";

function hasGpg(): boolean {
  try {
    execFileSync("gpg", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Two real environment quirks this test file has to handle, neither a bug
 * in `gpg-invoke.ts` itself — worth knowing for the real sign/decrypt
 * calls too, where a real user's passphrase-protected key makes both
 * genuine questions, not just test-harness ones:
 *
 * - `--pinentry-mode loopback` is required — without it, key generation
 *   under Node's non-interactive `execFileSync` (no controlling
 *   terminal) is unreliable; `gpg` still attempts to invoke a separate
 *   pinentry program for the passphrase prompt even for an empty
 *   passphrase unless told not to.
 * - **A second `--quick-generate-key` call anywhere in this file, even
 *   in a completely different `GNUPGHOME`, reliably failed** with
 *   `can't connect to the gpg-agent: IPC connect call failed` / `No
 *   agent running` — verified, and confirmed to *not* reproduce
 *   running the identical calls as a plain Node script outside Vitest,
 *   so this is specific to whatever Vitest's own process/thread model
 *   does to a *second* `gpg-agent` auto-start handshake within one
 *   worker. An explicit `gpgconf --launch gpg-agent` first (the
 *   documented, deterministic alternative to relying on `gpg`'s own
 *   auto-start) did **not** fix it either — confirmed, not assumed — so
 *   the real fix applied below is structural: at most one real
 *   `--quick-generate-key` call in this whole file, not per test.
 */
function generateTestKey(gnupgHome: string, name: string, address: string): void {
  execFileSync("gpgconf", ["--homedir", gnupgHome, "--launch", "gpg-agent"], { stdio: "pipe" });
  execFileSync(
    "gpg",
    [
      "--homedir",
      gnupgHome,
      "--batch",
      "--pinentry-mode",
      "loopback",
      "--passphrase",
      "",
      "--quick-generate-key",
      `${name} <${address}>`,
      "default",
      "default",
      "never",
    ],
    { stdio: "pipe" },
  );
}

/**
 * A real `--with-colons --list-keys` transcript, captured while
 * generating a throwaway Ed25519 test key with a real `gpg` 2.5.22
 * binary — pins the parser against
 * actual wire output, not an assumed shape.
 */
const REAL_LISTING_ONE_KEY = `tru::1:1789850874:1:3:1:5
pub:u:255:22:5F4290DBBBF50B93:1789850873:::u:::scESC:::::ed25519:::0:
fpr:::::::::C696CBA2904222D1ADE361BB5F4290DBBBF50B93:
uid:u::::1789850873::ED61FA1DA5B9A03AEAD7FE886B75B3F739AB64B0::Alice Test <alice@example.org>::::::::::0:
sub:u:255:18:CAC9C245F7ED07BE:1789850873::::::e:::::cv25519::
fpr:::::::::F1E834FE4951615BCDE14AB5CAC9C245F7ED07BE:
`;

describe("parseColonKeyListing", () => {
  it("parses a real single-key listing, taking the primary key's fingerprint, not the subkey's", () => {
    expect(parseColonKeyListing(REAL_LISTING_ONE_KEY)).toEqual([
      {
        fingerprint: "C696CBA2904222D1ADE361BB5F4290DBBBF50B93",
        userIds: ["Alice Test <alice@example.org>"],
      },
    ]);
  });

  // `--list-secret-keys` (`hasSecretKey()`) — a real transcript: the primary record is `sec` instead of `pub`, and
  // there is an extra `grp` (keygrip) line the parser must ignore.
  it("parses a real --list-secret-keys listing, whose primary record is sec rather than pub", () => {
    const secret = `sec:u:255:22:D4F817BA62FA58FD:1789852339:::u:::scSC:::+::ed25519:::0:
fpr:::::::::D07A65D689F852F5CA49BCB5D4F817BA62FA58FD:
grp:::::::::301B0E8B4589E36E0D31BACE3DF8D323E43E7003:
uid:u::::1789852339::B76D908FBECF421995C508A56537941116A3B829::alice@example.org::::::::::0:
`;
    expect(parseColonKeyListing(secret)).toEqual([
      {
        fingerprint: "D07A65D689F852F5CA49BCB5D4F817BA62FA58FD",
        userIds: ["alice@example.org"],
      },
    ]);
  });

  // A real transcript, captured live: a key created with a 1-second
  // lifetime, listed after it had expired. gpg still lists it (validity
  // `e` in field 2), but it must not count as a usable key.
  it("skips a real expired key, which gpg still lists", () => {
    const expired = `tru:o:1:1789853174:1789853174:3:1:5
pub:e:255:22:48AB173C9D76960C:1789853173:1789853174::u:::sc:::::ed25519:::0:
fpr:::::::::4133560B9B40C3D3A06BE34648AB173C9D76960C:
uid:e::::1789853173::6F87DD228F475194EC02426FA0322D1CEFCDE038::Expired <old@example.org>::::::::::0:
`;
    expect(parseColonKeyListing(expired)).toEqual([]);
  });

  it("keeps a usable key listed next to an expired one", () => {
    const mixed = `pub:e:255:22:48AB173C9D76960C:1789853173:1789853174::u:::sc:::::ed25519:::0:
fpr:::::::::4133560B9B40C3D3A06BE34648AB173C9D76960C:
uid:e::::1789853173::6F87DD228F475194EC02426FA0322D1CEFCDE038::Expired <old@example.org>::::::::::0:
${REAL_LISTING_ONE_KEY}`;
    expect(parseColonKeyListing(mixed).map((k) => k.fingerprint)).toEqual([
      "C696CBA2904222D1ADE361BB5F4290DBBBF50B93",
    ]);
  });

  it("returns an empty array for an empty keyring's own tru-only output", () => {
    expect(parseColonKeyListing("tru::1:1789850863:0:3:1:5\n")).toEqual([]);
  });

  it("parses multiple keys, each keeping only its own primary fingerprint and uids", () => {
    const two = `${REAL_LISTING_ONE_KEY}pub:u:255:22:AAAAAAAAAAAAAAAA:1789850900:::u:::scESC:::::ed25519:::0:
fpr:::::::::1111111111111111111111111111111111111111:
uid:u::::1789850900::XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX::Bob Test <bob@example.org>::::::::::0:
`;
    expect(parseColonKeyListing(two)).toEqual([
      {
        fingerprint: "C696CBA2904222D1ADE361BB5F4290DBBBF50B93",
        userIds: ["Alice Test <alice@example.org>"],
      },
      {
        fingerprint: "1111111111111111111111111111111111111111",
        userIds: ["Bob Test <bob@example.org>"],
      },
    ]);
  });
});

/**
 * L0/L2-ish — gated on a real `gpg` actually being on `PATH`, mirroring
 * `bridges/signal-bridge/src/signal-daemon.test.ts`'s own `hasSignalCli()`
 * pattern. Each test gets its own throwaway `GNUPGHOME`, never the
 * developer's real keyring.
 */
describe.skipIf(!hasGpg())("createGpgInvoker (real gpg)", () => {
  let gnupgHome: string;

  beforeEach(() => {
    gnupgHome = mkdtempSync(join(tmpdir(), "email-bridge-gpg-test-"));
  });

  afterEach(() => {
    // Kill this homedir's own agent before deleting its directory — a
    // lingering gpg-agent pointed at an already-removed homedir is the
    // kind of leaked background process good test hygiene avoids.
    try {
      execFileSync("gpgconf", ["--homedir", gnupgHome, "--kill", "gpg-agent"], { stdio: "pipe" });
    } catch {
      // No agent was ever started for this homedir (e.g. the "empty
      // keyring" test never calls generateTestKey) — nothing to kill.
    }
    rmSync(gnupgHome, { recursive: true, force: true });
  });

  it("finds no keys in a freshly created, empty keyring", async () => {
    const invoker = createGpgInvoker({ gnupgHome });
    await expect(invoker.listKeys("nobody@example.org")).resolves.toEqual([]);
  });

  /**
   * Deliberately one `generateTestKey()` call for both halves of this
   * check (found in its own home; not found in a different, unused
   * one), not two separate tests each generating their own key — found
   * live, real and repeatable: a *second* `--quick-generate-key` call
   * anywhere in this file, even in an entirely different `GNUPGHOME`,
   * reliably failed with `can't connect to the gpg-agent: IPC connect
   * call failed` / `No agent running`, including with an explicit
   * `gpgconf --launch gpg-agent` first. Confirmed to *not* reproduce
   * running the identical calls as a plain Node script outside Vitest —
   * something about Vitest's own process/thread model breaks a second
   * `gpg-agent` handshake within one worker. A real, environment-
   * specific limitation of *this test harness*, not of `gpg-invoke.ts`
   * itself (which never generates keys) — worth remembering for every
   * real-key test: at most one real `--quick-generate-key`
   * call per test *file* (a fresh Vitest worker each), not per test.
   */
  it("finds a real key by its own GNUPGHOME, and not through a different, unused one", async () => {
    generateTestKey(gnupgHome, "Alice Test", "alice@example.org");

    const ownInvoker = createGpgInvoker({ gnupgHome });
    const keys = await ownInvoker.listKeys("alice@example.org");
    expect(keys).toHaveLength(1);
    expect(keys[0]?.fingerprint).toMatch(/^[0-9A-F]{40}$/);
    expect(keys[0]?.userIds).toEqual(["Alice Test <alice@example.org>"]);

    const otherHome = mkdtempSync(join(tmpdir(), "email-bridge-gpg-test-other-"));
    try {
      const otherInvoker = createGpgInvoker({ gnupgHome: otherHome });
      await expect(otherInvoker.listKeys("alice@example.org")).resolves.toEqual([]);
    } finally {
      rmSync(otherHome, { recursive: true, force: true });
    }
  });

  it("throws a real error when the gpg binary itself cannot be found, rather than reporting no keys", async () => {
    const invoker = createGpgInvoker({ gnupgHome, gpgPath: "gpg-does-not-exist" });
    await expect(invoker.listKeys("alice@example.org")).rejects.toThrow();
  });
});

/**
 * **Every** `gpg` invocation this
 * bridge makes carries the network-hardening flags, whichever method
 * makes it. A real `gpg` can't show that (it would just work, or not);
 * what can is a recording stand-in for the binary that writes down
 * exactly the argv it was launched with. Runs everywhere a POSIX shell
 * does — no real `gpg`, no keys — so it guards the flags on every CI run,
 * not only where a `gpg` happens to be installed.
 */
describe.skipIf(process.platform === "win32")("createGpgInvoker's argv", () => {
  let dir: string;
  let recordFile: string;
  let recordingGpg: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "email-bridge-gpg-argv-"));
    recordFile = join(dir, "argv.txt");
    recordingGpg = join(dir, "recording-gpg");
    // One argument per line; exit 2 is gpg's own "nothing matched /
    // couldn't verify" code, which every method treats as a normal result
    // except sign() (which throws — caught below).
    writeFileSync(recordingGpg, `#!/bin/sh\nprintf '%s\\n' "$@" > '${recordFile}'\nexit 2\n`);
    chmodSync(recordingGpg, 0o755);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const HARDENING_FLAGS = [
    "--batch",
    "--no-auto-key-retrieve",
    "--no-auto-key-locate",
    "--no-auto-key-import",
  ];
  // Anything that names, fetches or searches a keyserver — none may ever be passed.
  const FORBIDDEN_FLAGS = [
    "--keyserver",
    "--recv-keys",
    "--receive-keys",
    "--search-keys",
    "--send-keys",
    "--refresh-keys",
    "--auto-key-retrieve",
    "--auto-key-locate",
    "--locate-keys",
    "--locate-external-keys",
  ];

  function recordedArgv(): string[] {
    return readFileSync(recordFile, "utf8").split("\n").filter(Boolean);
  }

  // The recording stand-in exits 2 with no message, which every method now
  // (correctly) treats as a failure rather than a verdict — the argv is
  // what these tests read, so the outcome is swallowed.
  const methods: [string, (invoker: ReturnType<typeof createGpgInvoker>) => Promise<unknown>][] = [
    ["listKeys", (g) => g.listKeys("a@example.org").catch(() => undefined)],
    ["hasSecretKey", (g) => g.hasSecretKey("a@example.org").catch(() => undefined)],
    [
      "signAndEncrypt",
      (g) =>
        g
          .signAndEncrypt("payload", "a@example.org", ["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"])
          .catch(() => undefined),
    ],
    ["decryptAndVerify", (g) => g.decryptAndVerify("anything").catch(() => undefined)],
  ];

  it.each(methods)(
    "%s always passes every hardening flag and never a keyserver flag",
    async (_name, call) => {
      await call(createGpgInvoker({ gpgPath: recordingGpg, gnupgHome: join(dir, "home") }));
      const argv = recordedArgv();
      for (const flag of HARDENING_FLAGS) {
        expect(argv, `missing ${flag}`).toContain(flag);
      }
      const optionsAt = argv.indexOf("--keyserver-options");
      expect(optionsAt).toBeGreaterThanOrEqual(0);
      expect(argv[optionsAt + 1]).toBe("no-honor-keyserver-url");
      for (const flag of FORBIDDEN_FLAGS) {
        expect(argv, `unexpected ${flag}`).not.toContain(flag);
      }
      expect(argv).toContain("--homedir");
    },
  );

  /**
   * `--trust-model always` is what lets gpg encrypt to an imported key its own
   * web of trust doesn't rate valid (batch mode otherwise refuses with "Unusable
   * public key", verified) — safe *only* because recipients are exact,
   * pre-resolved fingerprints. It must therefore appear on the one call that
   * encrypts and nowhere else, and each recipient must arrive as its own
   * `--recipient <fingerprint>`, never an address.
   */
  it("encrypts to exactly the given fingerprints, with the trust bypass on that call alone", async () => {
    const B = "B".repeat(40);
    const C = "C".repeat(40);
    const invoker = createGpgInvoker({ gpgPath: recordingGpg });
    await invoker.signAndEncrypt("payload", "a@example.org", [B, C]).catch(() => undefined);
    const argv = recordedArgv();
    expect(argv).toEqual(expect.arrayContaining(["--sign", "--encrypt", "--armor"]));
    expect(argv.slice(argv.indexOf("--trust-model"), argv.indexOf("--trust-model") + 2)).toEqual([
      "--trust-model",
      "always",
    ]);
    const recipients = argv.flatMap((arg, i) => (arg === "--recipient" ? [argv[i + 1]] : []));
    expect(recipients).toEqual([B, C]);
    expect(argv).toContain("<a@example.org>"); // the signer, as an exact address

    for (const call of [
      () => invoker.decryptAndVerify("x"),
      () => invoker.listKeys("a@example.org"),
      () => invoker.hasSecretKey("a@example.org"),
    ]) {
      await call().catch(() => undefined);
      expect(recordedArgv()).not.toContain("--trust-model");
    }
  });

  it("looks an address up as an exact <address>, never a substring query", async () => {
    await createGpgInvoker({ gpgPath: recordingGpg })
      .listKeys("alice@example.org")
      .catch(() => undefined);
    expect(recordedArgv()).toContain("<alice@example.org>");
    expect(recordedArgv()).not.toContain("alice@example.org");
  });

  /**
   * Found on a real Ubuntu 24.04 container (GnuPG 2.4.4), which does not
   * know `--no-auto-key-upload`: it answers `invalid option` with exit 2 —
   * the very code "no such key" uses. Reading that as "no keys" would turn a
   * broken setup into a baffling "missing PGP key" (and, for `verify`,
   * into rejecting every message ever received).
   */
  describe("a gpg that fails is reported as a failure, never mistaken for a verdict", () => {
    function stub(stderrText: string, exitCode: number): string {
      const path = join(dir, "stub-gpg");
      writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${stderrText}' >&2\nexit ${exitCode}\n`);
      chmodSync(path, 0o755);
      return path;
    }
    const INVALID = 'gpg: invalid option "--no-auto-key-import"';

    it("listKeys rejects on an invalid option instead of reporting no keys", async () => {
      const invoker = createGpgInvoker({ gpgPath: stub(INVALID, 2) });
      await expect(invoker.listKeys("a@example.org")).rejects.toThrow(/invalid option/);
    });

    it("hasSecretKey rejects on an invalid option instead of reporting false", async () => {
      const invoker = createGpgInvoker({ gpgPath: stub(INVALID, 2) });
      await expect(invoker.hasSecretKey("a@example.org")).rejects.toThrow(/invalid option/);
    });

    it("decryptAndVerify rejects when gpg never got as far as decrypting, rather than calling the message undecipherable", async () => {
      const invoker = createGpgInvoker({ gpgPath: stub(INVALID, 2) });
      await expect(invoker.decryptAndVerify("anything")).rejects.toThrow(/before decrypting/);
    });

    it("still reads gpg's real 'No public key' / 'No secret key' answers as an empty result", async () => {
      await expect(
        createGpgInvoker({
          gpgPath: stub("gpg: error reading key: No public key", 2),
        }).listKeys("a@example.org"),
      ).resolves.toEqual([]);
      await expect(
        createGpgInvoker({
          gpgPath: stub("gpg: error reading key: No secret key", 2),
        }).hasSecretKey("a@example.org"),
      ).resolves.toBe(false);
    });

    /**
     * Found on the CI runners (Linux): a `gpg` that exits before reading its
     * stdin — an invalid option, say — makes writing the payload fail with
     * EPIPE, emitted as an `error` event on the stdin pipe. Unhandled, that
     * is an uncaught exception that takes the whole bridge process down
     * instead of surfacing as an ordinary failure. Large input, so the write
     * is still pending when the child has already gone.
     */
    it("survives a gpg that exits without reading its stdin (EPIPE), reporting the failure instead of crashing", async () => {
      const invoker = createGpgInvoker({ gpgPath: stub(INVALID, 2) });
      const large = "x".repeat(4 * 1024 * 1024);
      await expect(invoker.decryptAndVerify(large)).rejects.toThrow(/before decrypting/);
      await expect(
        invoker.signAndEncrypt(large, "a@example.org", [
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        ]),
      ).rejects.toThrow(/invalid option/);
    });

    it("runs every call with LC_ALL=C, so 'No public key' is recognised whatever the user's locale", async () => {
      const path = join(dir, "env-gpg");
      writeFileSync(path, `#!/bin/sh\nprintf '%s' "$LC_ALL" > '${recordFile}'\nexit 2\n`);
      chmodSync(path, 0o755);
      await createGpgInvoker({ gpgPath: path })
        .listKeys("a@example.org")
        .catch(() => undefined);
      expect(readFileSync(recordFile, "utf8")).toBe("C");
    });
  });
});
