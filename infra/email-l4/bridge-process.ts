/**
 * network-policy: loopback — Zone A (docs/network-policy.md). Polls the bridge process it starts on
 * 127.0.0.1 and asks the OS for a free loopback port; never reaches a mail
 * provider itself.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { L4MailAccount } from "./config.ts";

/**
 * Starts a real `bridges/email-bridge` **process** against a real mailbox, for the
 * L4 specs. A separate process, not an in-process server like the L2 contract
 * test's: this is the only thing that ever connects to the real provider, so the
 * Vitest process running the spec stays on loopback (the network guard,
 * tools/network-guard.ts, would refuse anything else) and needs no new network exemption — the
 * bridge's own grant, one configured messenger endpoint, already covers it. The
 * spec only ever talks to the bridge over `http://127.0.0.1`, as a browser does.
 *
 * The child gets the account through the `SMTP_*`/`IMAP_*` variables the bridge
 * has always read; the `L4_MAIL_*` credentials themselves are stripped from its
 * environment first, so the process holds the two values it needs and no more.
 */
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const bridgeEntryPoint = join(repoRoot, "bridges/email-bridge/src/index.ts");

export interface L4BridgeHandle {
  readonly url: string;
  readonly process: ChildProcess;
  /** Everything the bridge wrote to standard error so far — its structured log. */
  log(): string;
  stop(): void;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(
  url: string,
  isAlive: () => boolean,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive()) {
      throw new Error("the bridge process exited before it became healthy");
    }
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok && ((await response.json()) as { configured: boolean }).configured) {
        return;
      }
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`the bridge at ${url} did not become healthy within ${timeoutMs}ms`);
}

/** `gnupgHome` is the bridge's whole PGP identity: pass a throwaway home, never a real keyring. */
export async function startL4Bridge(
  account: L4MailAccount,
  gnupgHome: string,
): Promise<L4BridgeHandle> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const bindStoreDir = mkdtempSync(join(tmpdir(), "email-l4-bridge-"));
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("L4_MAIL_")) {
      env[key] = value;
    }
  }
  Object.assign(env, {
    PORT: String(port),
    ADDRESS: account.address,
    SMTP_HOST: account.smtp.host,
    SMTP_PORT: String(account.smtp.port),
    SMTP_SECURE: String(account.smtp.secure),
    SMTP_AUTH_USER: account.authUser,
    SMTP_PASS: account.pass,
    IMAP_HOST: account.imap.host,
    IMAP_PORT: String(account.imap.port),
    IMAP_SECURE: String(account.imap.secure),
    IMAP_AUTH_USER: account.authUser,
    IMAP_PASS: account.pass,
    EMAIL_BIND_STORE_PATH: join(bindStoreDir, "threads.json"),
    GNUPGHOME: gnupgHome,
    LOG_FORMAT: "json",
    LOG_LEVEL: "info",
  });
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", bridgeEntryPoint],
    {
      cwd: join(repoRoot, "bridges/email-bridge"),
      env,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  const stop = () => {
    child.kill("SIGTERM");
    rmSync(bindStoreDir, { recursive: true, force: true });
  };
  try {
    await waitForHealth(url, () => !exited);
  } catch (error) {
    stop();
    throw new Error(`${(error as Error).message}\nbridge log:\n${stderr}`);
  }
  return { url, process: child, log: () => stderr, stop };
}
