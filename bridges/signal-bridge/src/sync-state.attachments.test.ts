import { existsSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@tdsp/bridge-log";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ATTACHMENT_FRAME_LIMIT, refFor, sha256Hex } from "./attachment.ts";
import { setBindRecord } from "./bind-store.ts";
import type { SignalRpc } from "./signal-api.ts";
import { createSyncState, type SyncState } from "./sync-state.ts";

/**
 * How the receiving side treats an attachment, against a `signal-cli` this file
 * controls: what is fetched and what is not, which failures are tried again and which are final,
 * what is deleted from disk and what is left alone, how much is read. The real round trip through
 * two real accounts is `l4-attachments.test.ts`; what only a fake can do is make a read fail on
 * purpose and count what was asked.
 */

const DOC = "doc-1";
const GROUP = "g1";
const ACCOUNT = "+15550000001";

/** The UTF-8 bytes of a frame's text: printable ASCII, distinguishable by `seed`. */
const bytesOf = (length: number, seed: number): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => 32 + (((i * 2654435761 + seed * 40503) >>> 24) % 95));
const textOf = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

class FakeRpc implements SignalRpc {
  calls: { method: string; params?: Record<string, unknown> }[] = [];
  /** What `getAttachment` does for a call, by attempt number (0-based) and attachment id. */
  onGetAttachment: (id: string, attempt: number) => Promise<unknown> = async () => {
    throw new Error("no attachment configured");
  };
  #attempts = new Map<string, number>();
  #handlers: ((method: string, params: unknown) => void)[] = [];

  async callRpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    if (method !== "getAttachment") {
      throw new Error(`unexpected ${method}`);
    }
    const id = String(params?.id);
    const attempt = this.#attempts.get(id) ?? 0;
    this.#attempts.set(id, attempt + 1);
    return (await this.onGetAttachment(id, attempt)) as T;
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

  get fetched(): string[] {
    return this.calls.map((call) => String(call.params?.id));
  }
}

interface Notification {
  sender?: string;
  timestamp?: number;
  body: unknown;
  attachments?: unknown;
  groupId?: string;
}

const notification = ({
  sender = "bob",
  timestamp = 1700000000000,
  body,
  attachments,
  groupId = GROUP,
}: Notification) => ({
  envelope: {
    sourceUuid: sender,
    dataMessage: {
      timestamp,
      message: typeof body === "string" ? body : JSON.stringify(body),
      groupInfo: { groupId, type: "DELIVER" },
      ...(attachments === undefined ? {} : { attachments }),
    },
  },
});

/** An update whose frame is the attachment `id` holds. */
const attachmentUpdate = (frame: Uint8Array, id = "att1", overrides: Partial<Notification> = {}) =>
  notification({
    body: { tdsp: 1, kind: "frame", documentId: DOC, attachment: refFor(frame) },
    attachments: [{ id, size: frame.length, contentType: "application/octet-stream" }],
    ...overrides,
  });

describe("a receiver's handling of attachments", () => {
  let dir: string;
  let attachmentsDir: string;
  let bindStorePath: string;
  let rpc: FakeRpc;
  let sync: SyncState;
  let logged: { event: string; fields: Record<string, unknown> }[];
  let account: string | undefined;

  const logger = () =>
    createLogger({
      component: "test",
      rateLimit: false,
      sink: (_line, record) => {
        logged.push({ event: record.event, fields: { ...record.fields } });
      },
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "signal-bridge-attachments-"));
    attachmentsDir = join(dir, "attachments");
    mkdirSync(attachmentsDir);
    bindStorePath = join(dir, "channels.json");
    setBindRecord(bindStorePath, DOC, {
      groupId: GROUP,
      creatorMemberId: "alice",
      profile: "yjs-paragraphs/1",
      createdAt: new Date(0).toISOString(),
    });
    rpc = new FakeRpc();
    logged = [];
    account = ACCOUNT;
    sync = createSyncState(rpc, bindStorePath, {
      account: () => account,
      attachmentsDir,
      logger: logger(),
      retryDelaysMs: [0, 0],
      readTimeoutMs: 200,
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Puts a file where signal-cli would have, and makes `getAttachment` answer with its bytes. */
  function received(id: string, bytes: Uint8Array): string {
    const file = join(attachmentsDir, id);
    writeFileSync(file, bytes);
    rpc.onGetAttachment = async (asked) =>
      asked === id ? toBase64(bytes) : Promise.reject(new Error("other"));
    return file;
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
  const events = () => logged.map((entry) => entry.event);
  const reasons = () => logged.map((entry) => entry.fields.reason);

  it("reads the attachment back and delivers the frame, with the sender and the id an inline frame would have", async () => {
    const frame = bytesOf(50_000, 1);
    received("att1", frame);
    rpc.emit(attachmentUpdate(frame, "att1", { sender: "bob", timestamp: 1700000000123 }));
    await settle();
    expect(sync.getDeliveries(DOC)).toEqual([
      { id: "bob:1700000000123", documentId: DOC, sender: "bob", payload: textOf(frame) },
    ]);
    expect(rpc.calls).toEqual([
      { method: "getAttachment", params: { account: ACCOUNT, groupId: GROUP, id: "att1" } },
    ]);
  });

  it("deletes the file once it has been read: it holds a plaintext frame", async () => {
    const frame = bytesOf(2000, 2);
    const file = received("att1", frame);
    rpc.emit(attachmentUpdate(frame));
    await settle();
    expect(sync.getDeliveries(DOC)).toHaveLength(1);
    expect(existsSync(file)).toBe(false);
  });

  it("delivers an ordinary frame in the body exactly as before, at once, and reads nothing", () => {
    rpc.emit(
      notification({
        body: { tdsp: 1, kind: "frame", documentId: DOC, frame: "AQID" },
      }),
    );
    // Synchronously: no await between the notification and the delivery.
    expect(sync.getDeliveries(DOC)).toHaveLength(1);
    expect(rpc.calls).toEqual([]);
  });

  describe("a read that fails", () => {
    it("is tried again, and delivered when it comes through", async () => {
      const frame = bytesOf(3000, 3);
      const file = join(attachmentsDir, "att1");
      writeFileSync(file, frame);
      rpc.onGetAttachment = async (_id, attempt) => {
        if (attempt < 2) {
          throw new Error("signal-cli busy");
        }
        return toBase64(frame);
      };
      rpc.emit(attachmentUpdate(frame));
      await settle();
      expect(sync.getDeliveries(DOC)).toHaveLength(1);
      expect(rpc.fetched).toEqual(["att1", "att1", "att1"]);
      expect(existsSync(file)).toBe(false);
    });

    it("is given up on after the tries there are (three), the frame dropped and the file left where it is", async () => {
      const frame = bytesOf(3000, 4);
      const file = join(attachmentsDir, "att1");
      writeFileSync(file, frame);
      rpc.onGetAttachment = async () => {
        throw new Error("signal-cli gone");
      };
      rpc.emit(attachmentUpdate(frame));
      await settle();
      expect(sync.getDeliveries(DOC)).toEqual([]);
      expect(rpc.fetched).toEqual(["att1", "att1", "att1"]);
      expect(events()).toContain("attachment-unavailable");
      expect(existsSync(file)).toBe(true); // not read, so not deleted: a later poll of the directory can still see it
    });

    it("counts a read that never answers as failed, after the time allowed", async () => {
      const frame = bytesOf(3000, 5);
      rpc.onGetAttachment = () => new Promise(() => {});
      rpc.emit(attachmentUpdate(frame));
      await new Promise((resolve) => setTimeout(resolve, 900)); // 3 tries × 200 ms
      expect(rpc.fetched).toHaveLength(3);
      expect(sync.getDeliveries(DOC)).toEqual([]);
      expect(events()).toContain("attachment-unavailable");
    });

    it("does not hold up an attachment that came after it", async () => {
      const first = bytesOf(3000, 6);
      const second = bytesOf(3000, 7);
      rpc.onGetAttachment = async (id) => {
        if (id === "first") {
          throw new Error("no");
        }
        return toBase64(second);
      };
      rpc.emit(attachmentUpdate(first, "first", { timestamp: 1 }));
      rpc.emit(attachmentUpdate(second, "second", { timestamp: 2 }));
      await settle();
      expect(sync.getDeliveries(DOC).map((d) => d.payload)).toEqual([textOf(second)]);
    });
  });

  describe("an attachment that is not what it says", () => {
    it("is dropped when the hash is not the file's, not read again, and its file deleted", async () => {
      const claimed = bytesOf(2000, 8);
      const actual = bytesOf(2000, 9);
      const file = received("att1", actual);
      rpc.emit(attachmentUpdate(claimed));
      await settle();
      expect(sync.getDeliveries(DOC)).toEqual([]);
      expect(rpc.fetched).toEqual(["att1"]);
      expect(reasons()).toContain("hash-mismatch");
      expect(existsSync(file)).toBe(false);
    });

    it("is dropped when the bytes read are not the size the envelope said", async () => {
      const frame = bytesOf(2000, 10);
      received("att1", frame.subarray(0, 1999));
      rpc.emit(attachmentUpdate(frame));
      await settle();
      expect(sync.getDeliveries(DOC)).toEqual([]);
      expect(reasons()).toContain("size-mismatch");
    });

    it("is not read at all when signal-cli's own size for the attachment is not the envelope's", async () => {
      const frame = bytesOf(2000, 11);
      received("att1", frame);
      rpc.emit(
        notification({
          body: { tdsp: 1, kind: "frame", documentId: DOC, attachment: refFor(frame) },
          attachments: [{ id: "att1", size: 2001 }],
        }),
      );
      await settle();
      expect(rpc.calls).toEqual([]);
      expect(sync.getDeliveries(DOC)).toEqual([]);
      expect(reasons()).toContain("size-mismatch");
    });

    it("is not read when the file on disk is over the bound, and the file is deleted", async () => {
      const frame = bytesOf(2000, 12);
      const file = join(attachmentsDir, "att1");
      writeFileSync(file, frame);
      truncateSync(file, ATTACHMENT_FRAME_LIMIT + 1);
      rpc.onGetAttachment = async () => toBase64(frame);
      rpc.emit(attachmentUpdate(frame));
      await settle();
      expect(rpc.calls).toEqual([]);
      expect(sync.getDeliveries(DOC)).toEqual([]);
      expect(reasons()).toContain("too-large");
      expect(existsSync(file)).toBe(false);
    });

    it("is read when the file on disk is exactly the bound", async () => {
      const frame = new Uint8Array(ATTACHMENT_FRAME_LIMIT).map((_, i) => 32 + ((i * 31) % 95));
      received("att1", frame);
      rpc.emit(attachmentUpdate(frame));
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(sync.getDeliveries(DOC)).toHaveLength(1);
      expect(sync.getDeliveries(DOC)[0]?.payload.length).toBe(ATTACHMENT_FRAME_LIMIT);
    });

    it("is read when its file is not where it should be, and says so", async () => {
      const frame = bytesOf(2000, 13);
      rpc.onGetAttachment = async () => toBase64(frame); // no file written to the directory
      rpc.emit(attachmentUpdate(frame));
      await settle();
      expect(sync.getDeliveries(DOC)).toHaveLength(1);
      expect(events()).toContain("attachment-file-missing");
    });
  });

  describe("an event that is not taken as an attachment: nothing is read", () => {
    const frame = bytesOf(1000, 20);

    beforeEach(() => {
      received("att1", frame);
    });

    it("names a document that is not bound here", async () => {
      rpc.emit(
        notification({
          body: {
            tdsp: 1,
            kind: "frame",
            documentId: "somebody-elses",
            attachment: refFor(frame),
          },
          attachments: [{ id: "att1", size: frame.length }],
        }),
      );
      await settle();
      expect(rpc.calls).toEqual([]);
      expect(sync.getDeliveries("somebody-elses")).toEqual([]);
    });

    it("carries both a frame and an attachment reference: it is ambiguous", async () => {
      rpc.emit(
        notification({
          body: {
            tdsp: 1,
            kind: "frame",
            documentId: DOC,
            frame: "AQID",
            attachment: refFor(frame),
          },
          attachments: [{ id: "att1", size: frame.length }],
        }),
      );
      await settle();
      expect(rpc.calls).toEqual([]);
      expect(sync.getDeliveries(DOC)).toEqual([]);
    });

    it("has a reference that does not parse", async () => {
      for (const attachment of [
        { size: -1, sha256: sha256Hex(frame) },
        { size: ATTACHMENT_FRAME_LIMIT + 1, sha256: sha256Hex(frame) },
        { size: 1, sha256: "nope" },
        "att1",
      ]) {
        rpc.emit(
          notification({
            body: { tdsp: 1, kind: "frame", documentId: DOC, attachment },
            attachments: [{ id: "att1", size: 1 }],
          }),
        );
      }
      await settle();
      expect(rpc.calls).toEqual([]);
      expect(sync.getDeliveries(DOC)).toEqual([]);
    });

    it("comes with no attachment, or with two", async () => {
      const body = { tdsp: 1, kind: "frame", documentId: DOC, attachment: refFor(frame) };
      rpc.emit(notification({ body }));
      rpc.emit(
        notification({
          body,
          attachments: [
            { id: "att1", size: frame.length },
            { id: "att2", size: frame.length },
          ],
        }),
      );
      await settle();
      expect(rpc.calls).toEqual([]);
      expect(sync.getDeliveries(DOC)).toEqual([]);
      expect(reasons().filter((reason) => reason === "not-one-attachment")).toHaveLength(2);
    });

    it("names an attachment by an id that could leave the attachments directory", async () => {
      const victim = join(dir, "victim");
      writeFileSync(victim, "keep me");
      for (const id of ["../victim", "a/../../victim", "..", "/etc/passwd"]) {
        rpc.emit(
          notification({
            body: { tdsp: 1, kind: "frame", documentId: DOC, attachment: refFor(frame) },
            attachments: [{ id, size: frame.length }],
          }),
        );
      }
      await settle();
      expect(rpc.calls).toEqual([]);
      expect(existsSync(victim)).toBe(true);
    });

    it("arrives before the account is linked", async () => {
      account = undefined;
      rpc.emit(attachmentUpdate(frame));
      await settle();
      expect(rpc.calls).toEqual([]);
      expect(sync.getDeliveries(DOC)).toEqual([]);
    });
  });

  it("a frame delivered as an attachment and one delivered inline sit side by side, whichever came first", async () => {
    const big = bytesOf(5000, 30);
    received("att1", big);
    rpc.emit(attachmentUpdate(big, "att1", { timestamp: 1 }));
    rpc.emit(
      notification({
        body: { tdsp: 1, kind: "frame", documentId: DOC, frame: "AQID" },
        timestamp: 2,
      }),
    );
    await settle();
    const delivered = sync.getDeliveries(DOC).map((d) => d.id);
    expect(delivered.sort()).toEqual(["bob:1", "bob:2"]);
  });
});
