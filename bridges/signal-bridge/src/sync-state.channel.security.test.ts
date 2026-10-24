import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setBindRecord } from "./bind-store.ts";
import type { SignalRpc } from "./signal-api.ts";
import { createSyncState, type SyncState } from "./sync-state.ts";

/**
 * A message counts for a document only from the group the document is bound to (BRG-10). The
 * account is usually in other groups too, with other people. Receivers do not reject an edit for
 * its sender's permission (CTL-7): the group's membership is what decides who can write. A frame
 * for a known documentId from another group — sent by someone removed from the document's group,
 * say — must therefore reach nobody, and an edit or a delete from there must leave no record.
 * These tests depend only on the code they test and on the fake in this file.
 */

const BOUND = "group-of-the-document";
const OTHER = "another-group-of-the-account";
const DOC = "doc-1";

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

  emit(params: unknown): void {
    for (const handler of this.#handlers) {
      handler("receive", params);
    }
  }
}

const frame = (payload: string) =>
  JSON.stringify({ tdsp: 1, kind: "frame", documentId: DOC, frame: payload });

const message = (sender: string, timestamp: number, groupId: string, text: string) => ({
  envelope: {
    sourceUuid: sender,
    dataMessage: { timestamp, message: text, groupInfo: { groupId, type: "DELIVER" } },
  },
});

const edit = (sender: string, target: number, at: number, groupId: string, text: string) => ({
  envelope: {
    sourceUuid: sender,
    editMessage: {
      targetSentTimestamp: target,
      dataMessage: { timestamp: at, message: text, groupInfo: { groupId, type: "DELIVER" } },
    },
  },
});

const remoteDelete = (sender: string, target: number, at: number, groupId: string) => ({
  envelope: {
    sourceUuid: sender,
    dataMessage: {
      timestamp: at,
      message: null,
      remoteDelete: { timestamp: target },
      groupInfo: { groupId, type: "DELIVER" },
    },
  },
});

describe("a message for a document from a group it is not bound to (BRG-10)", () => {
  let tempDir: string;
  let rpc: FakeRpc;
  let sync: SyncState;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "signal-bridge-channel-test-"));
    const bindStorePath = join(tempDir, "tdsp-channels.json");
    setBindRecord(bindStorePath, DOC, {
      groupId: BOUND,
      creatorMemberId: "alice",
      profile: "yjs-paragraphs/1",
      createdAt: new Date(0).toISOString(),
    });
    rpc = new FakeRpc();
    sync = createSyncState(rpc, bindStorePath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("is never delivered; the same frame from the bound group is", () => {
    rpc.emit(message("mallory", 1000, OTHER, frame("Zm9yZWlnbg==")));
    rpc.emit(message("alice", 2000, BOUND, frame("Ym91bmQ=")));
    expect(sync.getDeliveries(DOC).map((delivery) => delivery.payload)).toEqual(["Ym91bmQ="]);
    expect(sync.getIntegrityLog(DOC)).toEqual([]);
  });

  it("leaves no record when it edits or deletes a message of the document", () => {
    rpc.emit(message("alice", 1000, BOUND, frame("AQID")));
    rpc.emit(edit("alice", 1000, 3000, OTHER, frame("BBBB")));
    rpc.emit(remoteDelete("alice", 1000, 4000, OTHER));
    expect(sync.getDeliveries(DOC).map((delivery) => delivery.payload)).toEqual(["AQID"]);
    expect(sync.getIntegrityLog(DOC)).toEqual([]);
  });

  it("still records an edit and a delete from the bound group", () => {
    rpc.emit(message("alice", 1000, BOUND, frame("AQID")));
    rpc.emit(edit("alice", 1000, 3000, BOUND, frame("BBBB")));
    rpc.emit(remoteDelete("alice", 1000, 4000, BOUND));
    expect(sync.getIntegrityLog(DOC).map((entry) => entry.reason)).toEqual([
      "message-edited",
      "message-remote-deleted",
    ]);
  });
});
