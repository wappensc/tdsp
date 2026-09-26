import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@tdsp/bridge-log";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setBindRecord } from "./bind-store.ts";
import type { SignalRpc } from "./signal-api.ts";
import { createSyncState } from "./sync-state.ts";

/**
 * L0 — a fake `SignalRpc` whose `onNotification` just records the
 * handler, letting these tests push a synthetic `receive` notification
 * directly (`emit`) instead of needing a real `signal-cli` daemon at all.
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

function groupEnvelope(sender: string, timestamp: number, message: string, groupId = "g1") {
  return {
    envelope: {
      sourceUuid: sender,
      dataMessage: { timestamp, message, groupInfo: { groupId, type: "DELIVER" } },
    },
  };
}

describe("createSyncState (push-driven)", () => {
  let tempDir: string;
  let bindStorePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "signal-bridge-sync-state-test-"));
    bindStorePath = join(tempDir, "tdsp-channels.json");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function bind(documentId: string, overrides: Partial<Parameters<typeof setBindRecord>[2]> = {}) {
    setBindRecord(bindStorePath, documentId, {
      groupId: "g1",
      creatorMemberId: "alice",
      profile: "yjs-paragraphs/1",
      createdAt: new Date(0).toISOString(),
      ...overrides,
    });
  }

  it("surfaces an update envelope as a Delivery", () => {
    bind("doc-1");
    const rpc = new FakeRpc();
    const sync = createSyncState(rpc, bindStorePath);
    rpc.emit(
      "receive",
      groupEnvelope(
        "bob",
        1700000000000,
        JSON.stringify({ tdsp: 1, kind: "frame", documentId: "doc-1", frame: "AQID" }),
      ),
    );
    const deliveries = sync.getDeliveries("doc-1");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      id: "bob:1700000000000",
      documentId: "doc-1",
      sender: "bob",
    });
    expect(deliveries[0]?.payload).toBe("AQID");
  });

  it("delivers a resync-request frame the same way as any other — the bridge does not distinguish it", () => {
    bind("doc-1");
    const rpc = new FakeRpc();
    const sync = createSyncState(rpc, bindStorePath);
    // A resync request rides an ordinary kind:"edit" envelope now — its
    // own frame kind (byte 5, packages/document-protocol/src/framing.ts)
    // is opaque to this bridge, which only ever routes by documentId.
    rpc.emit(
      "receive",
      groupEnvelope(
        "bob",
        1,
        JSON.stringify({ tdsp: 1, kind: "frame", documentId: "doc-1", frame: "AQID" }),
      ),
    );
    expect(sync.getDeliveries("doc-1")).toEqual([
      { id: "bob:1", documentId: "doc-1", sender: "bob", payload: "AQID" },
    ]);
  });

  it("ignores an envelope with any other kind than frame", () => {
    bind("doc-1");
    const rpc = new FakeRpc();
    const sync = createSyncState(rpc, bindStorePath);
    rpc.emit(
      "receive",
      groupEnvelope(
        "bob",
        1,
        JSON.stringify({ tdsp: 1, kind: "resync-request", documentId: "doc-1", frame: "AQID" }),
      ),
    );
    expect(sync.getDeliveries("doc-1")).toHaveLength(0);
  });

  it("carries an edit from any sender — a bridge does not check who sends what", () => {
    bind("doc-1");
    const rpc = new FakeRpc();
    const sync = createSyncState(rpc, bindStorePath);
    rpc.emit(
      "receive",
      groupEnvelope(
        "someone-the-creator-never-mentioned",
        1,
        JSON.stringify({ tdsp: 1, kind: "frame", documentId: "doc-1", frame: "AQID" }),
      ),
    );
    expect(sync.getDeliveries("doc-1")).toHaveLength(1);
  });

  it("no longer acts on the control envelope kinds of earlier builds: they are ignored like any unknown kind", () => {
    bind("doc-1");
    const rpc = new FakeRpc();
    const sync = createSyncState(rpc, bindStorePath);
    for (const [index, kind] of ["archived", "deleted", "membership-change"].entries()) {
      rpc.emit(
        "receive",
        groupEnvelope(
          "alice",
          index + 1,
          JSON.stringify({ tdsp: 1, kind, documentId: "doc-1", member: "bob", permission: "read" }),
        ),
      );
    }
    // Nothing surfaced, and an edit afterwards is still carried: no state was changed.
    expect(sync.getDeliveries("doc-1")).toHaveLength(0);
    rpc.emit(
      "receive",
      groupEnvelope(
        "bob",
        9,
        JSON.stringify({ tdsp: 1, kind: "frame", documentId: "doc-1", frame: "AQID" }),
      ),
    );
    expect(sync.getDeliveries("doc-1")).toHaveLength(1);
  });

  it("silently ignores an envelope for a document this bridge never bound", () => {
    const rpc = new FakeRpc();
    const sync = createSyncState(rpc, bindStorePath);
    rpc.emit(
      "receive",
      groupEnvelope(
        "bob",
        1,
        JSON.stringify({ tdsp: 1, kind: "frame", documentId: "unbound-doc", frame: "AQID" }),
      ),
    );
    expect(sync.getDeliveries("unbound-doc")).toHaveLength(0);
  });

  it("silently ignores an ordinary chat message that isn't this project's own envelope", () => {
    bind("doc-1");
    const rpc = new FakeRpc();
    const sync = createSyncState(rpc, bindStorePath);
    rpc.emit("receive", groupEnvelope("bob", 1, "hey, are we still on for lunch?"));
    expect(sync.getDeliveries("doc-1")).toHaveLength(0);
  });

  it("reports, and does not deliver, a TDSP envelope of another version for a bound document (BND-2)", () => {
    bind("doc-1");
    const rpc = new FakeRpc();
    const events: string[] = [];
    const logger = createLogger({
      component: "signal-bridge",
      sink: (_line, record) => events.push(record.event),
    });
    const sync = createSyncState(rpc, bindStorePath, { logger });
    const v2 = (documentId: string) =>
      JSON.stringify({ tdsp: 2, kind: "frame", documentId, frame: "AQID" });
    rpc.emit("receive", groupEnvelope("bob", 1, v2("doc-1")));
    rpc.emit("receive", groupEnvelope("bob", 2, v2("unbound-doc")));
    rpc.emit("receive", groupEnvelope("bob", 3, "hey, are we still on for lunch?"));

    expect(sync.getDeliveries("doc-1")).toHaveLength(0);
    expect(events).toEqual(["unsupported-envelope-version"]); // the bound one only
  });

  it("ignores notifications for methods other than receive", () => {
    bind("doc-1");
    const rpc = new FakeRpc();
    const sync = createSyncState(rpc, bindStorePath);
    rpc.emit(
      "someOtherMethod",
      groupEnvelope(
        "bob",
        1,
        JSON.stringify({ tdsp: 1, kind: "frame", documentId: "doc-1", frame: "AQID" }),
      ),
    );
    expect(sync.getDeliveries("doc-1")).toHaveLength(0);
  });

  it("pollOnce is a no-op that resolves immediately (push-driven, no /sync equivalent)", async () => {
    const rpc = new FakeRpc();
    const sync = createSyncState(rpc, bindStorePath);
    await expect(sync.pollOnce()).resolves.toBeUndefined();
  });
});
