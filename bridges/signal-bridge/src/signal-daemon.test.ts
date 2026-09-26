import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type SignalDaemon, startSignalDaemon } from "./signal-daemon.ts";

function hasSignalCli(): boolean {
  try {
    execFileSync("signal-cli", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function hasLsof(): boolean {
  try {
    execFileSync("lsof", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * L2 integration test against the real `signal-cli` binary on PATH — skips
 * cleanly wherever it is absent (a CI runner included), so `pnpm run ci`
 * stays green there, while on a machine with `signal-cli` installed it
 * spawns the real process and verifies the real Unix-socket daemon
 * behaviour rather than assuming it from documentation.
 *
 * Never calls `finishLink` to completion — that needs a real phone to scan
 * the returned URI; linked accounts are the L4 tests' business
 * (docs/testing.md).
 */
describe.skipIf(!hasSignalCli())("real signal-cli daemon", () => {
  let daemon: SignalDaemon | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    await daemon?.stop();
    if (dataDir) {
      rmSync(dataDir, { recursive: true, force: true });
    }
    daemon = undefined;
    dataDir = undefined;
  });

  it("becomes ready and reports no linked accounts on a fresh data dir", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "signal-bridge-test-"));
    daemon = await startSignalDaemon({ signalCliPath: "signal-cli", dataDir });
    const accounts = await daemon.callRpc("listAccounts");
    expect(accounts).toEqual([]);
  }, 20_000);

  it("startLink returns a real, well-formed device-linking URI", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "signal-bridge-test-"));
    daemon = await startSignalDaemon({ signalCliPath: "signal-cli", dataDir });
    const { deviceLinkUri } = await daemon.callRpc<{ deviceLinkUri: string }>("startLink");
    expect(deviceLinkUri).toMatch(/^sgnl:\/\/linkdevice\?/);
  }, 20_000);

  it("the socket is chmod'd owner-only, not signal-cli's own default", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "signal-bridge-test-"));
    daemon = await startSignalDaemon({ signalCliPath: "signal-cli", dataDir });
    const mode = statSync(daemon.socketPath).mode & 0o777;
    expect(mode).toBe(0o600);
  }, 20_000);

  it("stop() actually terminates the child process", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "signal-bridge-test-"));
    daemon = await startSignalDaemon({ signalCliPath: "signal-cli", dataDir });
    const socketPath = daemon.socketPath;
    await daemon.stop();
    // a stopped daemon no longer accepts connections — confirms stop()
    // didn't just resolve without actually killing the process.
    await expect(
      new Promise<void>((resolve, reject) => {
        const socket = createConnection(socketPath);
        socket.once("connect", () => {
          socket.destroy();
          reject(new Error("connected to a socket that should be gone"));
        });
        socket.once("error", () => resolve());
      }),
    ).resolves.toBeUndefined();
  }, 20_000);

  it("stop() does not hang forever with a device-link session in flight", async () => {
    // signal-cli logs
    // "shutting down" on SIGTERM but does not actually exit while a
    // finishLink call is pending (its own open connection to Signal's
    // provisioning server apparently outlives the signal handler).
    // stop() must escalate to SIGKILL rather than hang forever; this
    // test's own 20s timeout is what proves it (SIGTERM-wait 5s +
    // SIGKILL-wait up to 5s, comfortably under 20s — if the escalation
    // regressed, this test would time out and fail, not hang silently).
    dataDir = mkdtempSync(join(tmpdir(), "signal-bridge-test-"));
    daemon = await startSignalDaemon({ signalCliPath: "signal-cli", dataDir });
    const { deviceLinkUri } = await daemon.callRpc<{ deviceLinkUri: string }>("startLink");
    // Fire-and-forget, exactly like SignalAuth.link() does — never
    // resolves in this test (no phone will ever scan it).
    void daemon.callRpc("finishLink", { deviceLinkUri, deviceName: "test" }).catch(() => {});
    await expect(daemon.stop()).resolves.toBeUndefined();
  }, 20_000);

  /**
   * Answers directly: can another local process reach the Signal daemon?
   * Split into two separate, narrow tests per the two different exposure
   * paths (network vs. filesystem/same-user), rather than one combined
   * test — each documents a distinct, independently-relevant fact about
   * what the Unix socket closes and what it deliberately does not.
   */
  describe("who else on this machine can reach it", () => {
    it.skipIf(!hasLsof())(
      "no TCP port is opened at all — nothing for a network/port scan to find",
      async () => {
        dataDir = mkdtempSync(join(tmpdir(), "signal-bridge-test-"));
        daemon = await startSignalDaemon({ signalCliPath: "signal-cli", dataDir });
        if (daemon.pid === undefined) {
          throw new Error("expected startSignalDaemon() to report a pid");
        }
        let output = "";
        try {
          output = execFileSync(
            "lsof",
            ["-a", "-p", String(daemon.pid), "-i", "TCP", "-sTCP:LISTEN"],
            { encoding: "utf8" },
          );
        } catch (error) {
          // lsof exits with status 1 and empty stdout when it finds nothing
          // matching the filter — exactly the outcome this test wants.
          const status = (error as { status?: number }).status;
          if (status !== 1) {
            throw error;
          }
        }
        expect(output.trim()).toBe("");
      },
      20_000,
    );

    it("an unrelated process running as this same OS user CAN still connect and issue RPC calls — the residual risk chmod 0600 does not close", async () => {
      dataDir = mkdtempSync(join(tmpdir(), "signal-bridge-test-"));
      daemon = await startSignalDaemon({ signalCliPath: "signal-cli", dataDir });

      // A genuinely separate OS process — not the SignalDaemon client
      // object under test, not even the same module — to demonstrate
      // this is a property of the socket itself, not an artifact of
      // how this codebase happens to talk to it.
      const probeScriptPath = join(dataDir, "probe.mjs");
      writeFileSync(
        probeScriptPath,
        `
          import { createConnection } from "node:net";
          const socket = createConnection(process.argv[2]);
          let buffer = "";
          socket.setEncoding("utf8");
          socket.on("connect", () => {
            socket.write(JSON.stringify({ jsonrpc: "2.0", method: "listAccounts", id: "probe" }) + "\\n");
          });
          socket.on("data", (chunk) => {
            buffer += chunk;
            if (buffer.includes("\\n")) {
              process.stdout.write(buffer);
              socket.destroy();
              process.exit(0);
            }
          });
          socket.on("error", (error) => {
            console.error("CONNECT_FAILED: " + error.message);
            process.exit(1);
          });
          `,
      );

      const output = execFileSync(process.execPath, [probeScriptPath, daemon.socketPath], {
        encoding: "utf8",
        timeout: 5_000,
      });
      expect(JSON.parse(output.trim())).toEqual({ jsonrpc: "2.0", result: [], id: "probe" });
    }, 20_000);
  });
});
