import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  finishLinkResult: readonly Record<string, unknown>[] | Error = [];

  async callRpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (method === "finishLink") {
      if (this.finishLinkResult instanceof Error) {
        throw this.finishLinkResult;
      }
      return this.finishLinkResult as T;
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

describe("SignalAuth.link", () => {
  it("returns the linking URI immediately, before accounts.json exists", async () => {
    const auth = new SignalAuth(new FakeDaemon(), dataDir);
    const result = await auth.link();
    expect(result).toEqual({ linkingUri: "sgnl://linkdevice?uuid=x&pub_key=y" });
    expect(auth.status).toEqual({ linked: false });
  });

  it("resolves status from accounts.json once finishLink settles, and calls sendSyncRequest", async () => {
    const daemon = new FakeDaemon();
    const auth = new SignalAuth(daemon, dataDir);
    // Simulates signal-cli writing accounts.json as part of completing
    // the link, before finishLink's own JSON-RPC response returns.
    writeAccountsJson("+15551234567", "uuid-1");
    await auth.link();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(auth.status).toEqual({ linked: true, accountId: "uuid-1" });
    expect(daemon.syncRequestsFor).toEqual(["+15551234567"]);
  });

  it("logs rather than throws if finishLink itself fails", async () => {
    const daemon = new FakeDaemon();
    daemon.finishLinkResult = new Error("provisioning session expired");
    const auth = new SignalAuth(daemon, dataDir);
    await auth.link();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(auth.status).toEqual({ linked: false });
  });
});
