import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@tdsp/bridge-log";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SignalRpc } from "./signal-api.ts";
import { createSyncState, type SyncState } from "./sync-state.ts";

/**
 * A recipient a send skipped as an identity the account does not trust is the application's to
 * see (SIG-4): a notice in the document's integrity log (BRG-15), once for as long as the identity
 * stays untrusted.
 */
describe("notices of recipients a send skipped (SIG-4, BRG-15)", () => {
  let dir: string;
  let sync: SyncState;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "signal-notices-"));
    const rpc: SignalRpc = {
      callRpc: async () => {
        throw new Error("not used");
      },
      onNotification: () => () => {},
    };
    sync = createSyncState(rpc, join(dir, "channels.json"), {
      logger: createLogger({ component: "test", sink: () => {} }),
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("records a notice naming the message and the recipient, not as a violation", () => {
    sync.noteSendResult("doc-1", "me:1", ["bob-aci"], ["carol-aci"]);
    expect(sync.getIntegrityLog("doc-1")).toEqual([
      { kind: "notice", id: "me:1", recipient: "bob-aci", reason: "recipient-untrusted" },
    ]);
    expect(sync.getIntegrityLog("doc-2")).toEqual([]);
  });

  it("records a recipient once while it stays untrusted, and again once a send reached it in between", () => {
    sync.noteSendResult("doc-1", "me:1", ["bob-aci"], []);
    sync.noteSendResult("doc-1", "me:2", ["bob-aci"], []);
    sync.noteSendResult("doc-1", "me:3", [], ["bob-aci"]);
    sync.noteSendResult("doc-1", "me:4", ["bob-aci"], []);
    expect(sync.getIntegrityLog("doc-1").map((entry) => entry.id)).toEqual(["me:1", "me:4"]);
  });
});
