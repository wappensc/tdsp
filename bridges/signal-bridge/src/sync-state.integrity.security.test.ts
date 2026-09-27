import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setBindRecord } from "./bind-store.ts";
import type { SignalRpc } from "./signal-api.ts";
import { createSyncState } from "./sync-state.ts";

/**
 * SPECIFICATION.md BRG-12: a bridge must never apply, and must record as an
 * integrity violation, a messenger-native edit or withdrawal of an
 * already-delivered message. The fixtures below mirror what a real
 * `signal-cli receive --output=json` produced for two real linked accounts
 * in a shared group; this suite checks the bridge's reaction to them.
 */

class FakeRpc implements SignalRpc {
  #handlers: ((method: string, params: unknown) => void)[] = [];

  async callRpc<T>(): Promise<T> {
    throw new Error("not used by these tests");
  }

  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.#handlers.push(handler);
    return () => {
      this.#handlers = this.#handlers.filter((h) => h !== handler);
    };
  }

  emit(method: string, params: unknown): void {
    for (const handler of this.#handlers) {
      handler(method, params);
    }
  }
}

const GROUP = "g1";
const ALICE = "alice";

function groupEnvelope(sender: string, timestamp: number, message: string) {
  return {
    envelope: {
      sourceUuid: sender,
      dataMessage: { timestamp, message, groupInfo: { groupId: GROUP, type: "DELIVER" } },
    },
  };
}

/** Mirrors the real editMessage envelope the live probe captured against production Signal. */
function editEnvelope(
  sender: string,
  targetTimestamp: number,
  editTimestamp: number,
  message: string,
) {
  return {
    envelope: {
      sourceUuid: sender,
      editMessage: {
        targetSentTimestamp: targetTimestamp,
        dataMessage: {
          timestamp: editTimestamp,
          message,
          groupInfo: { groupId: GROUP, type: "DELIVER" },
        },
      },
    },
  };
}

/** Mirrors the real remoteDelete envelope the live probe captured. */
function remoteDeleteEnvelope(sender: string, targetTimestamp: number, deleteTimestamp: number) {
  return {
    envelope: {
      sourceUuid: sender,
      dataMessage: {
        timestamp: deleteTimestamp,
        message: null,
        remoteDelete: { timestamp: targetTimestamp },
        groupInfo: { groupId: GROUP, type: "DELIVER" },
      },
    },
  };
}

describe("a receiver's handling of a messenger-native edit or withdrawal", () => {
  let tempDir: string;
  let bindStorePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "signal-bridge-integrity-test-"));
    bindStorePath = join(tempDir, "tdsp-channels.json");
    setBindRecord(bindStorePath, "doc-1", {
      groupId: GROUP,
      creatorMemberId: ALICE,
      profile: "yjs-paragraphs/1",
      createdAt: new Date(0).toISOString(),
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("never applies an edit as an ordinary new delivery, and records it against the original's document", () => {
    const rpc = new FakeRpc();
    const sync = createSyncState(rpc, bindStorePath);
    rpc.emit(
      "receive",
      groupEnvelope(
        ALICE,
        1000,
        JSON.stringify({ tdsp: 1, kind: "frame", documentId: "doc-1", frame: "AQID" }),
      ),
    );
    rpc.emit(
      "receive",
      editEnvelope(
        ALICE,
        1000,
        2000,
        JSON.stringify({ tdsp: 1, kind: "frame", documentId: "doc-1", frame: "BBBB" }),
      ),
    );
    expect(sync.getDeliveries("doc-1")).toHaveLength(1); // only the original — the edit was never applied
    expect(sync.getIntegrityLog("doc-1")).toEqual([
      { id: "alice:1000", sender: ALICE, reason: "message-edited" },
    ]);
  });

  it("never applies a remote-delete, and records it against the original's document", () => {
    const rpc = new FakeRpc();
    const sync = createSyncState(rpc, bindStorePath);
    rpc.emit(
      "receive",
      groupEnvelope(
        ALICE,
        1000,
        JSON.stringify({ tdsp: 1, kind: "frame", documentId: "doc-1", frame: "AQID" }),
      ),
    );
    rpc.emit("receive", remoteDeleteEnvelope(ALICE, 1000, 3000));
    expect(sync.getDeliveries("doc-1")).toHaveLength(1); // the earlier, already-applied delivery stands
    expect(sync.getIntegrityLog("doc-1")).toEqual([
      { id: "alice:1000", sender: ALICE, reason: "message-remote-deleted" },
    ]);
  });

  it("attributes an edit of a message it never itself recorded by parsing the edit's own claimed documentId", () => {
    const rpc = new FakeRpc();
    const sync = createSyncState(rpc, bindStorePath);
    // No original ever recorded — e.g. sent before this bridge process started.
    rpc.emit(
      "receive",
      editEnvelope(
        ALICE,
        999,
        2000,
        JSON.stringify({ tdsp: 1, kind: "frame", documentId: "doc-1", frame: "BBBB" }),
      ),
    );
    expect(sync.getDeliveries("doc-1")).toEqual([]);
    expect(sync.getIntegrityLog("doc-1")).toEqual([
      { id: "alice:999", sender: ALICE, reason: "message-edited" },
    ]);
  });

  it("does not crash on a remote-delete it cannot attribute to any document", () => {
    const rpc = new FakeRpc();
    const sync = createSyncState(rpc, bindStorePath);
    rpc.emit("receive", remoteDeleteEnvelope(ALICE, 999, 3000));
    expect(sync.getDeliveries("doc-1")).toEqual([]);
    expect(sync.getIntegrityLog("doc-1")).toEqual([]);
  });
});
