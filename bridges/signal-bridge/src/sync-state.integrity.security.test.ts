import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setBindRecord } from "./bind-store.ts";
import type { SignalRpc } from "./signal-api.ts";
import { createSyncState } from "./sync-state.ts";

/**
 * bindings/bridges.md BRG-12: a bridge must never apply, and must record as an
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

/**
 * What another device of the same account receives for a message, an edit or a remote-delete
 * that device sent: the sync transcript `syncMessage.sentMessage`. Mirrors what a real
 * `signal-cli receive --output=json` (0.14.9) produced on a second linked device of one account
 * in a group: a message is the transcript itself, an edit sits in its `editMessage`, a
 * remote-delete in its `remoteDelete`.
 */
function transcriptEnvelope(sender: string, sentMessage: Record<string, unknown>) {
  return {
    envelope: {
      sourceUuid: sender,
      sourceDevice: 3,
      timestamp: (sentMessage.timestamp as number | undefined) ?? 0,
      syncMessage: { sentMessage: { destination: null, destinationUuid: null, ...sentMessage } },
    },
  };
}

function transcriptMessage(sender: string, timestamp: number, message: string) {
  return transcriptEnvelope(sender, {
    timestamp,
    message,
    groupInfo: { groupId: GROUP, type: "DELIVER" },
  });
}

function transcriptEdit(sender: string, targetTimestamp: number, message: string) {
  return transcriptEnvelope(sender, {
    editMessage: {
      targetSentTimestamp: targetTimestamp,
      dataMessage: { timestamp: targetTimestamp + 1, message, groupInfo: { groupId: GROUP } },
    },
  });
}

function transcriptRemoteDelete(sender: string, targetTimestamp: number) {
  return transcriptEnvelope(sender, {
    timestamp: targetTimestamp + 2,
    message: null,
    remoteDelete: { targetTimestamp, timestamp: targetTimestamp },
    groupInfo: { groupId: GROUP, type: "DELIVER" },
  });
}

const frameText = (frame: string) =>
  JSON.stringify({ tdsp: 1, kind: "frame", documentId: "doc-1", frame });

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

  it("never applies another message under an id already delivered, and records it against the first's document (BRG-12)", () => {
    const rpc = new FakeRpc();
    const sync = createSyncState(rpc, bindStorePath);
    const first = JSON.stringify({ tdsp: 1, kind: "frame", documentId: "doc-1", frame: "AQID" });
    rpc.emit("receive", groupEnvelope(ALICE, 1000, first));
    rpc.emit(
      "receive",
      groupEnvelope(
        ALICE,
        1000,
        JSON.stringify({ tdsp: 1, kind: "frame", documentId: "doc-1", frame: "BBBB" }),
      ),
    );
    expect(sync.getDeliveries("doc-1").map((delivery) => delivery.payload)).toEqual(["AQID"]);
    expect(sync.getIntegrityLog("doc-1")).toEqual([
      { id: "alice:1000", sender: ALICE, reason: "message-replaced" },
    ]);
  });

  it("takes a message under the id of an envelope it did not deliver as new, and records nothing (BRG-12)", () => {
    const rpc = new FakeRpc();
    const sync = createSyncState(rpc, bindStorePath);
    // Neither a frame nor an attachment: no protocol message, so nothing delivered under its id.
    rpc.emit(
      "receive",
      groupEnvelope(ALICE, 1000, JSON.stringify({ tdsp: 1, kind: "frame", documentId: "doc-1" })),
    );
    rpc.emit("receive", groupEnvelope(ALICE, 1000, frameText("AQID")));
    expect(sync.getDeliveries("doc-1").map((delivery) => delivery.payload)).toEqual(["AQID"]);
    expect(sync.getIntegrityLog("doc-1")).toEqual([]);
  });

  it("records nothing for an envelope that is no protocol message under a delivered id (BRG-10)", () => {
    const rpc = new FakeRpc();
    const sync = createSyncState(rpc, bindStorePath);
    rpc.emit("receive", groupEnvelope(ALICE, 1000, frameText("AQID")));
    rpc.emit(
      "receive",
      groupEnvelope(ALICE, 1000, JSON.stringify({ tdsp: 1, kind: "frame", documentId: "doc-1" })),
    );
    expect(sync.getDeliveries("doc-1").map((delivery) => delivery.payload)).toEqual(["AQID"]);
    expect(sync.getIntegrityLog("doc-1")).toEqual([]);
  });

  it("takes the same message again as nothing new, and records nothing (BRG-11)", () => {
    const rpc = new FakeRpc();
    const sync = createSyncState(rpc, bindStorePath);
    const message = JSON.stringify({ tdsp: 1, kind: "frame", documentId: "doc-1", frame: "AQID" });
    rpc.emit("receive", groupEnvelope(ALICE, 1000, message));
    rpc.emit("receive", groupEnvelope(ALICE, 1000, message));
    expect(sync.getDeliveries("doc-1")).toHaveLength(1);
    expect(sync.getIntegrityLog("doc-1")).toEqual([]);
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

  it("never applies an edit of a message it never delivered, and records nothing for it, whatever document its text names (BRG-12)", () => {
    const rpc = new FakeRpc();
    const sync = createSyncState(rpc, bindStorePath);
    // No original ever delivered — e.g. sent before this bridge process started, or never at all.
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
    expect(sync.getIntegrityLog("doc-1")).toEqual([]);
  });

  it("records nothing for an edit of an envelope it did not deliver under that id", () => {
    const rpc = new FakeRpc();
    const sync = createSyncState(rpc, bindStorePath);
    // Neither a frame nor an attachment: no protocol message, so nothing delivered under its id.
    rpc.emit(
      "receive",
      groupEnvelope(ALICE, 1000, JSON.stringify({ tdsp: 1, kind: "frame", documentId: "doc-1" })),
    );
    rpc.emit("receive", editEnvelope(ALICE, 1000, 2000, frameText("BBBB")));
    expect(sync.getDeliveries("doc-1")).toEqual([]);
    expect(sync.getIntegrityLog("doc-1")).toEqual([]);
  });

  it("does not crash on a remote-delete it cannot attribute to any document", () => {
    const rpc = new FakeRpc();
    const sync = createSyncState(rpc, bindStorePath);
    rpc.emit("receive", remoteDeleteEnvelope(ALICE, 999, 3000));
    expect(sync.getDeliveries("doc-1")).toEqual([]);
    expect(sync.getIntegrityLog("doc-1")).toEqual([]);
  });
});

describe("what another device of the bridge's own account sent (SIG-3)", () => {
  let tempDir: string;
  let bindStorePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "signal-bridge-transcript-test-"));
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

  it("delivers the transcript under the id the sending device got, attributed to the account", () => {
    const rpc = new FakeRpc();
    const sync = createSyncState(rpc, bindStorePath, { ownAci: () => ALICE });
    rpc.emit("receive", transcriptMessage(ALICE, 1000, frameText("AQID")));
    expect(sync.getDeliveries("doc-1")).toEqual([
      { id: "alice:1000", documentId: "doc-1", sender: ALICE, payload: "AQID" },
    ]);
  });

  it("never applies an edit sent from another device, and records it against the original", () => {
    const rpc = new FakeRpc();
    const sync = createSyncState(rpc, bindStorePath, { ownAci: () => ALICE });
    rpc.emit("receive", transcriptMessage(ALICE, 1000, frameText("AQID")));
    rpc.emit("receive", transcriptEdit(ALICE, 1000, frameText("BBBB")));
    expect(sync.getDeliveries("doc-1").map((d) => d.payload)).toEqual(["AQID"]);
    expect(sync.getIntegrityLog("doc-1")).toEqual([
      { id: "alice:1000", sender: ALICE, reason: "message-edited" },
    ]);
  });

  it("never applies a remote-delete sent from another device, and records it against the original", () => {
    const rpc = new FakeRpc();
    const sync = createSyncState(rpc, bindStorePath, { ownAci: () => ALICE });
    rpc.emit("receive", transcriptMessage(ALICE, 1000, frameText("AQID")));
    rpc.emit("receive", transcriptRemoteDelete(ALICE, 1000));
    expect(sync.getDeliveries("doc-1")).toHaveLength(1);
    expect(sync.getIntegrityLog("doc-1")).toEqual([
      { id: "alice:1000", sender: ALICE, reason: "message-remote-deleted" },
    ]);
  });

  it("takes nothing from a transcript whose sender is not its own account", () => {
    const rpc = new FakeRpc();
    const sync = createSyncState(rpc, bindStorePath, { ownAci: () => ALICE });
    rpc.emit("receive", transcriptMessage("mallory", 1000, frameText("AQID")));
    rpc.emit("receive", transcriptEdit("mallory", 1000, frameText("BBBB")));
    expect(sync.getDeliveries("doc-1")).toEqual([]);
    expect(sync.getIntegrityLog("doc-1")).toEqual([]);
  });

  it("takes nothing from a transcript before it knows its own account", () => {
    const rpc = new FakeRpc();
    const sync = createSyncState(rpc, bindStorePath, { ownAci: () => undefined });
    rpc.emit("receive", transcriptMessage(ALICE, 1000, frameText("AQID")));
    expect(sync.getDeliveries("doc-1")).toEqual([]);
  });
});
