import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@tdsp/bridge-log";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RpcCaller, SignalAuth } from "./auth.ts";

/**
 * L0 — a fake `RpcCaller` plus a real temp `<dataDir>/data/accounts.json`
 * file stand in for `signal-cli` entirely. Covers three traps of real
 * Signal accounts: (1) `initialize()` must recover `linked: true` from an
 * already-linked `signal-cli` data-dir on process startup, not only after
 * this process's own `link()` completes; (2) the account's `MemberId` must
 * be its ACI (UUID), not its phone number — a real incoming envelope's
 * `sender` field reports the ACI; (3) `getUserStatus` is not a way to learn
 * it: it answers the *wrong* UUID (the PNI, a separate namespace) or `null`,
 * depending on the account's phone-number-discovery privacy setting —
 * `account-store.ts`'s file read is what matches a real delivered message's
 * `sender`.
 */
class FakeDaemon implements RpcCaller {
  syncRequestsFor: string[] = [];
  /** `"never"`: signal-cli 0.14.9's daemon, which completes the link but never answers. */
  finishLinkResult: Record<string, unknown> | Error | "never" = {};
  /** What `listAccounts` answers: the accounts the daemon has loaded. */
  accounts: readonly { number: string; aci: string }[] = [];
  listAccountsCalls = 0;

  async callRpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (method === "finishLink") {
      if (this.finishLinkResult === "never") {
        return new Promise<T>(() => {});
      }
      if (this.finishLinkResult instanceof Error) {
        throw this.finishLinkResult;
      }
      return this.finishLinkResult as T;
    }
    if (method === "listAccounts") {
      this.listAccountsCalls += 1;
      return this.accounts as T;
    }
    if (method === "sendSyncRequest") {
      this.syncRequestsFor.push((params as { account: string }).account);
      return {} as T;
    }
    if (method === "startLink") {
      return { deviceLinkUri: "sgnl://linkdevice?uuid=x&pub_key=y" } as T;
    }
    throw new Error(`FakeDaemon: unexpected method ${method}`);
  }
}

let dataDir: string;

function writeAccountsJson(number: string, uuid: string): void {
  mkdirSync(join(dataDir, "data"), { recursive: true });
  writeFileSync(
    join(dataDir, "data", "accounts.json"),
    JSON.stringify({ accounts: [{ path: "1", environment: "LIVE", number, uuid }], version: 2 }),
  );
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "signal-bridge-auth-test-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("SignalAuth.initialize", () => {
  it("stays unlinked when signal-cli has no accounts.json yet", async () => {
    const auth = new SignalAuth(new FakeDaemon(), dataDir);
    await auth.initialize();
    expect(auth.status).toEqual({ linked: false });
    expect(auth.phoneNumber).toBeUndefined();
  });

  it("recovers linked status from an already-linked signal-cli data-dir, using the ACI as accountId", async () => {
    writeAccountsJson("+15551234567", "7574f6b0-f04f-4782-b7bb-07474f9701c7");
    const auth = new SignalAuth(new FakeDaemon(), dataDir);
    await auth.initialize();
    expect(auth.status).toEqual({
      linked: true,
      accountId: "7574f6b0-f04f-4782-b7bb-07474f9701c7",
    });
    // signal-cli's own local account selector stays the phone number,
    // never the UUID (its account param rejects a UUID).
    expect(auth.phoneNumber).toBe("+15551234567");
  });
});

const quiet: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => quiet,
};
const fast = { linkPollMs: 5, linkWatchMs: 500 };
const until = async (condition: () => boolean, timeoutMs = 1000): Promise<void> => {
  const started = Date.now();
  while (!condition() && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe("SignalAuth.link", () => {
  it("returns the linking URI immediately, before any account is there", async () => {
    const auth = new SignalAuth(new FakeDaemon(), dataDir, quiet, fast);
    const result = await auth.link();
    expect(result).toEqual({ linkingUri: "sgnl://linkdevice?uuid=x&pub_key=y" });
    expect(auth.status).toEqual({ linked: false });
  });

  it("is linked once signal-cli lists the account, although finishLink never answers", async () => {
    const daemon = new FakeDaemon();
    daemon.finishLinkResult = "never";
    const auth = new SignalAuth(daemon, dataDir, quiet, fast);
    await auth.link();
    await until(() => daemon.listAccountsCalls >= 2);
    expect(auth.status).toEqual({ linked: false });
    daemon.accounts = [{ number: "+15551234567", aci: "uuid-1" }];
    await until(() => auth.status.linked);
    expect(auth.status).toEqual({ linked: true, accountId: "uuid-1" });
    expect(auth.phoneNumber).toBe("+15551234567");
    expect(daemon.syncRequestsFor).toEqual(["+15551234567"]);
  });

  it("takes the account once when finishLink answers too, and stops asking", async () => {
    const daemon = new FakeDaemon();
    daemon.accounts = [{ number: "+15551234567", aci: "uuid-1" }];
    const auth = new SignalAuth(daemon, dataDir, quiet, fast);
    await auth.link();
    await until(() => auth.status.linked);
    const calls = daemon.listAccountsCalls;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(auth.status).toEqual({ linked: true, accountId: "uuid-1" });
    expect(daemon.syncRequestsFor).toEqual(["+15551234567"]);
    expect(daemon.listAccountsCalls).toBe(calls);
  });

  it("stays unlinked and stops asking when finishLink fails", async () => {
    const daemon = new FakeDaemon();
    daemon.finishLinkResult = new Error("provisioning session expired");
    const auth = new SignalAuth(daemon, dataDir, quiet, fast);
    await auth.link();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(auth.status).toEqual({ linked: false });
    expect(daemon.listAccountsCalls).toBeLessThanOrEqual(1);
  });

  it("gives up watching when no account appears in time", async () => {
    const daemon = new FakeDaemon();
    daemon.finishLinkResult = "never";
    const auth = new SignalAuth(daemon, dataDir, quiet, { linkPollMs: 5, linkWatchMs: 40 });
    await auth.link();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const calls = daemon.listAccountsCalls;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(auth.status).toEqual({ linked: false });
    expect(daemon.listAccountsCalls).toBe(calls);
  });
});

describe("SignalAuth.refreshLink (SIG-7)", () => {
  const ACI = "aci-1";
  const NUMBER = "+15550000001";

  async function linkedAuth(daemon: FakeDaemon, events: string[] = []) {
    writeAccountsJson(NUMBER, ACI);
    const logger = {
      warn: (event: string) => events.push(event),
      info: () => {},
      error: () => {},
      debug: () => {},
      child: () => logger,
    } as unknown as Logger;
    const auth = new SignalAuth(daemon, dataDir, logger);
    await auth.initialize();
    expect(auth.status.linked).toBe(true);
    return auth;
  }

  it("keeps the device linked while signal-cli names its account", async () => {
    const daemon = new FakeDaemon();
    daemon.accounts = [{ number: NUMBER, aci: ACI }];
    const auth = await linkedAuth(daemon);
    await auth.refreshLink();
    expect(auth.status).toEqual({ linked: true, accountId: ACI });
    expect(auth.phoneNumber).toBe(NUMBER);
  });

  it("takes the device for unlinked once signal-cli names no account of it, as after Signal's servers refused it", async () => {
    const daemon = new FakeDaemon();
    daemon.accounts = [];
    const events: string[] = [];
    // accounts.json still names the account: signal-cli keeps it there, but no longer loads it.
    const auth = await linkedAuth(daemon, events);
    await auth.refreshLink();
    expect(auth.status).toEqual({ linked: false });
    expect(auth.phoneNumber).toBeUndefined();
    expect(events).toContain("device-unlinked");
  });

  it("stays linked without word from signal-cli: an answer that is no list", async () => {
    const daemon = new FakeDaemon();
    daemon.accounts = "not a list" as never;
    const auth = await linkedAuth(daemon);
    await auth.refreshLink();
    expect(auth.status.linked).toBe(true);
  });
});
