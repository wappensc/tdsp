import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Throwaway GnuPG home directories for the email adapter's live tests —
 * one per participant, each holding that
 * participant's own freshly generated *secret* key and every *other*
 * participant's imported *public* key, exactly the setup a real
 * PGP-enabled document assumes ("every member has imported every other
 * member's key"). Never touches the developer's real keyring: every home
 * is a `mkdtemp` directory, removed by `cleanup()`.
 *
 * Dependency-free (only `node:*`), like the rest of this directory,
 * because `infra/` is not a pnpm workspace package. Not a security
 * boundary: the keys have no passphrase and exist only for the run.
 */
export interface ProvisionedGpgHomes {
  /** address -> that participant's `GNUPGHOME`. */
  readonly homes: ReadonlyMap<string, string>;
  /** address -> the primary-key fingerprint of that participant's own key. */
  readonly fingerprints: ReadonlyMap<string, string>;
  /** Stops every agent this provisioning started and deletes every home. */
  cleanup(): void;
}

function gpg(home: string, args: readonly string[], input?: string): string {
  return execFileSync("gpg", ["--homedir", home, "--batch", ...args], {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function hasGpgBinary(): boolean {
  try {
    execFileSync("gpg", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function provisionGpgHomes(addresses: readonly string[]): ProvisionedGpgHomes {
  const homes = new Map<string, string>();
  const fingerprints = new Map<string, string>();
  const cleanup = () => cleanupHomes(homes.values());

  try {
    for (const address of addresses) {
      // Keep this prefix short: gpg-agent puts unix sockets (the longest is
      // `S.gpg-agent.browser`) inside the home directory, and macOS caps a
      // socket path at 104 characters — a longer name made key generation
      // fail with "can't connect to the gpg-agent".
      const home = mkdtempSync(join(tmpdir(), "tdsp-gpg-"));
      homes.set(address, home);
      // Launch the agent explicitly first: the documented, deterministic
      // alternative to relying on gpg's own auto-start.
      execFileSync("gpgconf", ["--homedir", home, "--launch", "gpg-agent"], { stdio: "ignore" });
      gpg(home, [
        "--pinentry-mode",
        "loopback",
        "--passphrase",
        "",
        "--quick-generate-key",
        `Test ${address} <${address}>`,
        "default",
        "default",
        "never",
      ]);
      const listing = gpg(home, ["--with-colons", "--list-keys", `<${address}>`]);
      const fingerprint = /^fpr:::::::::([0-9A-F]{40}):/m.exec(listing)?.[1];
      if (!fingerprint) {
        throw new Error(`could not read the fingerprint of the key just generated for ${address}`);
      }
      fingerprints.set(address, fingerprint);
    }

    for (const owner of addresses) {
      for (const other of addresses) {
        if (owner === other) {
          continue;
        }
        const publicKey = gpg(homes.get(other) as string, ["--armor", "--export", `<${other}>`]);
        const file = join(homes.get(owner) as string, `import-${fingerprints.get(other)}.asc`);
        writeFileSync(file, publicKey);
        gpg(homes.get(owner) as string, ["--import", file]);
      }
    }
  } catch (error) {
    cleanup();
    throw error;
  }

  return { homes, fingerprints, cleanup };
}

function cleanupHomes(homes: Iterable<string>): void {
  for (const home of homes) {
    try {
      execFileSync("gpgconf", ["--homedir", home, "--kill", "all"], { stdio: "ignore" });
    } catch {
      // No agent was ever started for this home.
    }
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * `provisionGpgHomes`, run in a separate Node process — for callers inside
 * a Vitest worker. A second `gpg --quick-generate-key` within
 * one Vitest worker reliably fails with "can't connect to the gpg-agent"
 * (see `bridges/email-bridge/src/gpg-invoke.test.ts`), yet the identical
 * calls succeed in a plain Node process. Generating in a child sidesteps the worker quirk; the
 * parent only reads the result and cleans up.
 */
export function provisionGpgHomesInChildProcess(addresses: readonly string[]): ProvisionedGpgHomes {
  const cli = fileURLToPath(new URL("./gpg-homes-cli.ts", import.meta.url));
  const output = execFileSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", cli, ...addresses],
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(output) as {
    homes: [string, string][];
    fingerprints: [string, string][];
  };
  const homes = new Map(parsed.homes);
  return {
    homes,
    fingerprints: new Map(parsed.fingerprints),
    cleanup: () => cleanupHomes(homes.values()),
  };
}
