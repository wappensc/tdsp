import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@tdsp/bridge-log";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BindRecord, setBindRecord } from "./bind-store.ts";
import type { IncomingMail, MailReceiver } from "./mail-transport.ts";
import { createSyncState } from "./sync-state.ts";

/** L0 — a fake `MailReceiver` letting these tests seed exactly the messages a real IMAP search would have returned, without a real mailbox. */
class FakeMailReceiver implements MailReceiver {
  readonly tls = "plaintext-loopback" as const;
  verifyFailure: Error | undefined;

  async verify(): Promise<void> {
    if (this.verifyFailure) {
      throw this.verifyFailure;
    }
  }

  #byDocument = new Map<string, IncomingMail[]>();

  seed(documentId: string, messages: readonly IncomingMail[]): void {
    this.#byDocument.set(documentId, [...(this.#byDocument.get(documentId) ?? []), ...messages]);
  }

  async fetchThreadMessages(documentId: string): Promise<readonly IncomingMail[]> {
    return this.#byDocument.get(documentId) ?? [];
  }
}

function mail(overrides: Partial<IncomingMail> = {}): IncomingMail {
  return {
    messageId: "m1",
    from: "bob@example.org",
    to: ["alice@example.org"],
    cc: [],
    text: "",
    ...overrides,
  };
}

describe("createSyncState", () => {
  let tempDir: string;
  let bindStorePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "email-bridge-sync-state-test-"));
    bindStorePath = join(tempDir, "tdsp-threads.json");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function bind(documentId: string, overrides: Partial<BindRecord> = {}) {
    setBindRecord(bindStorePath, documentId, {
      recipients: ["alice@example.org", "bob@example.org"],
      creatorMemberId: "alice@example.org",
      profile: "yjs-paragraphs/1",
      threadRootMessageId: "<root@example.org>",
      createdAt: new Date(0).toISOString(),
      pgpEnabled: false,
      pinnedFingerprints: {},
      ...overrides,
    });
  }

  it("surfaces an edit envelope as a Delivery when the recipient headers match the closed set", async () => {
    bind("doc-1");
    const receiver = new FakeMailReceiver();
    receiver.seed("doc-1", [
      mail({
        messageId: "m1",
        from: "bob@example.org",
        to: ["alice@example.org"],
        text: JSON.stringify({ tdsp: 1, kind: "frame", documentId: "doc-1", frame: "AQID" }),
      }),
    ]);
    const sync = createSyncState(receiver, bindStorePath, undefined);
    await sync.pollOnce("doc-1");
    const deliveries = sync.getDeliveries("doc-1");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      id: "m1",
      documentId: "doc-1",
      sender: "bob@example.org",
    });
    expect(deliveries[0]?.payload).toBe("AQID");
  });

  it("delivers a resync-request frame the same way as any other — the bridge does not distinguish it", async () => {
    bind("doc-1");
    const receiver = new FakeMailReceiver();
    // A resync request rides an ordinary kind:"edit" envelope now — its own
    // frame kind (packages/document-protocol/src/framing.ts) is opaque to
    // this bridge, which only ever routes by documentId.
    receiver.seed("doc-1", [
      mail({
        messageId: "m1",
        text: JSON.stringify({ tdsp: 1, kind: "frame", documentId: "doc-1", frame: "AQID" }),
      }),
    ]);
    const sync = createSyncState(receiver, bindStorePath, undefined);
    await sync.pollOnce("doc-1");
    expect(sync.getDeliveries("doc-1")).toEqual([
      {
        id: "m1",
        documentId: "doc-1",
        sender: "bob@example.org",
        payload: "AQID",
      },
    ]);
  });

  it("ignores an envelope with any other kind — resync-request stopped being a distinct envelope kind", async () => {
    bind("doc-1");
    const receiver = new FakeMailReceiver();
    receiver.seed("doc-1", [
      mail({
        messageId: "m1",
        text: JSON.stringify({
          tdsp: 1,
          kind: "resync-request",
          documentId: "doc-1",
          frame: "AQID",
        }),
      }),
    ]);
    const sync = createSyncState(receiver, bindStorePath, undefined);
    await sync.pollOnce("doc-1");
    expect(sync.getDeliveries("doc-1")).toHaveLength(0);
  });

  /**
   * The transport-level check (SPECIFICATION.md EML-2): a signature only
   * ever covers the body, never these outer
   * headers — a message whose actual `To`/`Cc` doesn't reconstitute the
   * exact closed set (here: mallory received a copy nobody invited her
   * to) is rejected independent of anything the envelope itself claims.
   */
  it("rejects a message whose recipient headers don't match the closed participant set, even with an otherwise-valid envelope", async () => {
    bind("doc-1");
    const receiver = new FakeMailReceiver();
    receiver.seed("doc-1", [
      mail({
        messageId: "m1",
        from: "bob@example.org",
        to: ["alice@example.org", "mallory@example.org"],
        text: JSON.stringify({ tdsp: 1, kind: "frame", documentId: "doc-1", frame: "AQID" }),
      }),
    ]);
    const sync = createSyncState(receiver, bindStorePath, undefined);
    await sync.pollOnce("doc-1");
    expect(sync.getDeliveries("doc-1")).toHaveLength(0);
    expect(sync.getRejections("doc-1")).toEqual([
      { messageId: "m1", sender: "bob@example.org", reason: "recipient-list-mismatch" },
    ]);
  });

  it("rejects a message missing an original participant from its recipient headers", async () => {
    bind("doc-1", { recipients: ["alice@example.org", "bob@example.org", "carol@example.org"] });
    const receiver = new FakeMailReceiver();
    receiver.seed("doc-1", [
      // carol was silently left off — bob only sent to alice.
      mail({
        messageId: "m1",
        from: "bob@example.org",
        to: ["alice@example.org"],
        text: JSON.stringify({ tdsp: 1, kind: "frame", documentId: "doc-1", frame: "AQID" }),
      }),
    ]);
    const sync = createSyncState(receiver, bindStorePath, undefined);
    await sync.pollOnce("doc-1");
    expect(sync.getDeliveries("doc-1")).toHaveLength(0);
  });

  it("reports, and does not deliver, a TDSP envelope of another version in the document's thread (BND-2)", async () => {
    bind("doc-1");
    const receiver = new FakeMailReceiver();
    receiver.seed("doc-1", [
      mail({
        messageId: "m-v2",
        from: "bob@example.org",
        to: ["alice@example.org"],
        text: JSON.stringify({ tdsp: 2, kind: "frame", documentId: "doc-1", frame: "AQID" }),
      }),
      mail({
        messageId: "m-chat",
        from: "bob@example.org",
        to: ["alice@example.org"],
        text: "see you tomorrow",
      }),
    ]);
    const events: string[] = [];
    const logger = createLogger({
      component: "email-bridge",
      sink: (_line, record) => events.push(record.event),
    });
    const sync = createSyncState(receiver, bindStorePath, undefined, logger);
    await sync.pollOnce("doc-1");
    expect(sync.getDeliveries("doc-1")).toHaveLength(0);
    expect(events).toEqual(["unsupported-envelope-version"]);
  });

  it("keeps only the newest deliveries, and while it runs never offers again one it dropped (BRG-17)", async () => {
    bind("doc-1");
    const receiver = new FakeMailReceiver();
    const frameMail = (messageId: string) =>
      mail({
        messageId,
        from: "bob@example.org",
        to: ["alice@example.org"],
        text: JSON.stringify({ tdsp: 1, kind: "frame", documentId: "doc-1", frame: messageId }),
      });
    receiver.seed("doc-1", [frameMail("m1"), frameMail("m2")]);
    const sync = createSyncState(receiver, bindStorePath, undefined, undefined, {
      maxCount: 1,
      maxPayloadChars: 1000,
    });
    await sync.pollOnce("doc-1");
    expect(sync.getDeliveries("doc-1").map((d) => d.id)).toEqual(["m2"]);

    await sync.pollOnce("doc-1"); // IMAP reads the whole thread again, m1 included
    expect(sync.getDeliveries("doc-1").map((d) => d.id)).toEqual(["m2"]);
  });

  it("after a restart may offer again one it had dropped (BRG-17; an engine tolerates it, TRN-8)", async () => {
    bind("doc-1");
    const frameMail = (messageId: string) =>
      mail({
        messageId,
        from: "bob@example.org",
        to: ["alice@example.org"],
        text: JSON.stringify({ tdsp: 1, kind: "frame", documentId: "doc-1", frame: messageId }),
      });
    const retention = { maxCount: 2, maxPayloadChars: 1000 };
    const before = new FakeMailReceiver();
    before.seed("doc-1", [frameMail("m1"), frameMail("m2"), frameMail("m3")]);
    const first = createSyncState(before, bindStorePath, undefined, undefined, retention);
    await first.pollOnce("doc-1");
    expect(first.getDeliveries("doc-1").map((d) => d.id)).toEqual(["m2", "m3"]);

    // The bridge restarts with nothing but its bind store, and the thread now reads
    // differently (m3 moved to another folder): m1, dropped before, is offered again.
    const after = new FakeMailReceiver();
    after.seed("doc-1", [frameMail("m1"), frameMail("m2")]);
    const restarted = createSyncState(after, bindStorePath, undefined, undefined, retention);
    await restarted.pollOnce("doc-1");
    expect(restarted.getDeliveries("doc-1").map((d) => d.id)).toEqual(["m1", "m2"]);
  });

  it("silently ignores an envelope for a document this bridge never started", async () => {
    const receiver = new FakeMailReceiver();
    receiver.seed("unbound-doc", [
      mail({
        messageId: "m1",
        text: JSON.stringify({ tdsp: 1, kind: "frame", documentId: "unbound-doc", frame: "AQID" }),
      }),
    ]);
    const sync = createSyncState(receiver, bindStorePath, undefined);
    await sync.pollOnce("unbound-doc");
    expect(sync.getDeliveries("unbound-doc")).toHaveLength(0);
  });

  it("silently ignores an ordinary message that isn't this project's own envelope (e.g. the plain invite email)", async () => {
    bind("doc-1");
    const receiver = new FakeMailReceiver();
    receiver.seed("doc-1", [
      mail({ messageId: "m1", text: "You've been invited to collaborate." }),
    ]);
    const sync = createSyncState(receiver, bindStorePath, undefined);
    await sync.pollOnce("doc-1");
    expect(sync.getDeliveries("doc-1")).toHaveLength(0);
  });

  it("does not double-count the same message across two pollOnce calls", async () => {
    bind("doc-1");
    const receiver = new FakeMailReceiver();
    receiver.seed("doc-1", [
      mail({
        messageId: "m1",
        text: JSON.stringify({ tdsp: 1, kind: "frame", documentId: "doc-1", frame: "AQID" }),
      }),
    ]);
    const sync = createSyncState(receiver, bindStorePath, undefined);
    await sync.pollOnce("doc-1");
    await sync.pollOnce("doc-1"); // the fake keeps returning the same seeded message
    expect(sync.getDeliveries("doc-1")).toHaveLength(1);
  });
});
