import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BindRecord, setBindRecord } from "./bind-store.ts";
import type { IncomingMail, MailReceiver } from "./mail-transport.ts";
import { createSyncState } from "./sync-state.ts";

/**
 * bindings/bridges.md BRG-12: a bridge must never apply, and must record as an
 * integrity violation, a messenger-native edit or withdrawal of an
 * already-delivered message. For email that is a second, distinct message
 * under the `Message-ID` of one it delivered — verified against a real Greenmail
 * server (a real `nodemailer`/`imapflow` round trip): nothing
 * at the SMTP/IMAP level enforces `Message-ID` uniqueness, so this is a
 * real, deliverable scenario, not a hypothetical one.
 *
 * Only a delivered id can be replaced, and it is compared by the frame's bytes
 * (BRG-12): a mail the bridge did not take — the thread's invitation, whose
 * Message-ID every invitation link names, or a rejected one — leaves nothing a
 * later mail under its id could be measured against, and the same frame read
 * again is the same message (BRG-11).
 */

class FakeMailReceiver implements MailReceiver {
  readonly tls = "plaintext-loopback" as const;
  #byDocument = new Map<string, IncomingMail[]>();

  async verify(): Promise<void> {}

  seed(documentId: string, message: IncomingMail): void {
    const list = this.#byDocument.get(documentId) ?? [];
    list.push(message);
    this.#byDocument.set(documentId, list);
  }

  async fetchThreadMessages(documentId: string): Promise<readonly IncomingMail[]> {
    return this.#byDocument.get(documentId) ?? [];
  }
}

function mail(overrides: Partial<IncomingMail> = {}): IncomingMail {
  return {
    messageId: "<reused@example.org>",
    from: "bob@example.org",
    to: ["alice@example.org"],
    cc: [],
    text: "",
    ...overrides,
  };
}

describe("a receiver's handling of a resend under an existing Message-ID", () => {
  let tempDir: string;
  let bindStorePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "email-bridge-integrity-test-"));
    bindStorePath = join(tempDir, "tdsp-threads.json");
    setBindRecord(bindStorePath, "doc-1", {
      recipients: ["alice@example.org", "bob@example.org"],
      creatorMemberId: "alice@example.org",
      profile: "yjs-paragraphs/1",
      threadRootMessageId: "<root@example.org>",
      createdAt: new Date(0).toISOString(),
      pgpEnabled: false,
      pinnedFingerprints: {},
    } satisfies BindRecord);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const original = JSON.stringify({ tdsp: 1, kind: "frame", documentId: "doc-1", frame: "AQID" });
  const tampered = JSON.stringify({ tdsp: 1, kind: "frame", documentId: "doc-1", frame: "BBBB" });

  it("applies the original once, never applies a same-id resend with different content, and records it", async () => {
    const receiver = new FakeMailReceiver();
    const sync = createSyncState(receiver, bindStorePath, undefined);
    receiver.seed("doc-1", mail({ text: original }));
    await sync.pollOnce("doc-1");
    receiver.seed("doc-1", mail({ text: tampered })); // same Message-ID, different text
    await sync.pollOnce("doc-1");

    expect(sync.getDeliveries("doc-1")).toHaveLength(1); // only the original was ever applied
    expect(sync.getDeliveries("doc-1")[0]?.payload).toBe("AQID");
    expect(sync.getRejections("doc-1")).toEqual([
      { messageId: "<reused@example.org>", sender: "bob@example.org", reason: "message-replaced" },
    ]);
  });

  it("stays silent on an ordinary IMAP re-read — the identical message returned again", async () => {
    const receiver = new FakeMailReceiver();
    const sync = createSyncState(receiver, bindStorePath, undefined);
    receiver.seed("doc-1", mail({ text: original }));
    await sync.pollOnce("doc-1");
    receiver.seed("doc-1", mail({ text: original })); // IMAP handing back the same message again
    await sync.pollOnce("doc-1");

    expect(sync.getDeliveries("doc-1")).toHaveLength(1);
    expect(sync.getRejections("doc-1")).toEqual([]);
  });

  it("records nothing and delivers nothing for another mail under the invitation's Message-ID — it was never delivered", async () => {
    const receiver = new FakeMailReceiver();
    const sync = createSyncState(receiver, bindStorePath, undefined);
    receiver.seed(
      "doc-1",
      mail({
        messageId: "<root@example.org>",
        from: "alice@example.org",
        to: ["bob@example.org"],
        text: "Alice invites you to a document: tdsp://join?root=%3Croot%40example.org%3E",
      }),
    );
    await sync.pollOnce("doc-1");
    // Anyone holding the invitation link knows the root's Message-ID; without PGP the
    // headers are anyone's to write.
    receiver.seed(
      "doc-1",
      mail({ messageId: "<root@example.org>", text: "Not the invitation, not an envelope." }),
    );
    await sync.pollOnce("doc-1");
    await sync.pollOnce("doc-1");

    expect(sync.getDeliveries("doc-1")).toEqual([]);
    expect(sync.getRejections("doc-1")).toEqual([]);
  });

  it("treats a mail from outside the participant set under the invitation's Message-ID as any such mail, never as a replacement", async () => {
    const receiver = new FakeMailReceiver();
    const sync = createSyncState(receiver, bindStorePath, undefined);
    receiver.seed(
      "doc-1",
      mail({
        messageId: "<root@example.org>",
        from: "alice@example.org",
        to: ["bob@example.org"],
        text: "Alice invites you to a document.",
      }),
    );
    receiver.seed(
      "doc-1",
      mail({
        messageId: "<root@example.org>",
        from: "mallory@example.org",
        to: ["alice@example.org", "bob@example.org"],
        text: tampered,
      }),
    );
    await sync.pollOnce("doc-1");
    await sync.pollOnce("doc-1");

    expect(sync.getDeliveries("doc-1")).toEqual([]);
    expect(sync.getRejections("doc-1")).toEqual([
      {
        messageId: "<root@example.org>",
        sender: "mallory@example.org",
        reason: "recipient-list-mismatch",
      },
    ]);
  });

  it("records a rejected mail once, however often it is read, and nothing for another mail under its id", async () => {
    const receiver = new FakeMailReceiver();
    const sync = createSyncState(receiver, bindStorePath, undefined);
    const rejected = mail({ from: "mallory@example.org", text: original });
    receiver.seed("doc-1", rejected);
    await sync.pollOnce("doc-1");
    receiver.seed("doc-1", rejected); // the same mail again, from the junk folder say
    receiver.seed("doc-1", mail({ text: "Not an envelope." })); // another one under its id
    await sync.pollOnce("doc-1");
    await sync.pollOnce("doc-1");

    expect(sync.getDeliveries("doc-1")).toEqual([]);
    expect(sync.getRejections("doc-1")).toEqual([
      {
        messageId: "<reused@example.org>",
        sender: "mallory@example.org",
        reason: "recipient-list-mismatch",
      },
    ]);
  });

  it("delivers a valid mail under the id of one it rejected: it delivered nothing under that id (BRG-11)", async () => {
    const receiver = new FakeMailReceiver();
    const sync = createSyncState(receiver, bindStorePath, undefined);
    receiver.seed("doc-1", mail({ from: "mallory@example.org", text: tampered }));
    await sync.pollOnce("doc-1");
    receiver.seed("doc-1", mail({ text: original }));
    await sync.pollOnce("doc-1");

    expect(sync.getDeliveries("doc-1").map((delivery) => delivery.payload)).toEqual(["AQID"]);
    expect(sync.getRejections("doc-1").map((rejection) => rejection.reason)).toEqual([
      "recipient-list-mismatch",
    ]);
  });

  it("delivers a mail whose body a rejected mail under its id copied: the headers are part of what was seen", async () => {
    const receiver = new FakeMailReceiver();
    const sync = createSyncState(receiver, bindStorePath, undefined);
    receiver.seed("doc-1", mail({ from: "mallory@example.org", text: original }));
    await sync.pollOnce("doc-1");
    receiver.seed("doc-1", mail({ text: original }));
    await sync.pollOnce("doc-1");

    expect(sync.getDeliveries("doc-1").map((delivery) => delivery.sender)).toEqual([
      "bob@example.org",
    ]);
  });

  it("records another mail under a delivered id from outside the participant set by its own reason, never as a replacement", async () => {
    const receiver = new FakeMailReceiver();
    const sync = createSyncState(receiver, bindStorePath, undefined);
    receiver.seed("doc-1", mail({ text: original }));
    await sync.pollOnce("doc-1");
    receiver.seed("doc-1", mail({ from: "mallory@example.org", text: tampered }));
    await sync.pollOnce("doc-1");

    expect(sync.getDeliveries("doc-1").map((delivery) => delivery.payload)).toEqual(["AQID"]);
    expect(sync.getRejections("doc-1")).toEqual([
      {
        messageId: "<reused@example.org>",
        sender: "mallory@example.org",
        reason: "recipient-list-mismatch",
      },
    ]);
  });

  it("records a replacement once, however often the thread is read again", async () => {
    const receiver = new FakeMailReceiver();
    const sync = createSyncState(receiver, bindStorePath, undefined);
    receiver.seed("doc-1", mail({ text: original }));
    receiver.seed("doc-1", mail({ text: tampered }));
    await sync.pollOnce("doc-1");
    await sync.pollOnce("doc-1");
    await sync.pollOnce("doc-1");

    expect(sync.getDeliveries("doc-1").map((delivery) => delivery.payload)).toEqual(["AQID"]);
    expect(sync.getRejections("doc-1")).toEqual([
      { messageId: "<reused@example.org>", sender: "bob@example.org", reason: "message-replaced" },
    ]);
  });

  it("drops silently a mail with other text but the same frame under a delivered id — the same message again (BRG-11)", async () => {
    const receiver = new FakeMailReceiver();
    const sync = createSyncState(receiver, bindStorePath, undefined);
    receiver.seed("doc-1", mail({ text: original }));
    await sync.pollOnce("doc-1");
    // The same envelope, laid out differently: the frame's bytes are what BRG-12 compares.
    receiver.seed("doc-1", mail({ text: `${JSON.stringify(JSON.parse(original), null, 2)}\n` }));
    await sync.pollOnce("doc-1");

    expect(sync.getDeliveries("doc-1")).toHaveLength(1);
    expect(sync.getRejections("doc-1")).toEqual([]);
  });

  it("still records a replacement of a delivery its retention has dropped (BRG-12, BRG-17)", async () => {
    const receiver = new FakeMailReceiver();
    const sync = createSyncState(receiver, bindStorePath, undefined, undefined, {
      maxCount: 1,
      maxPayloadChars: 1000,
    });
    receiver.seed("doc-1", mail({ text: original }));
    receiver.seed("doc-1", mail({ messageId: "<later@example.org>", text: original }));
    await sync.pollOnce("doc-1");
    expect(sync.getDeliveries("doc-1").map((delivery) => delivery.id)).toEqual([
      "<later@example.org>",
    ]);
    receiver.seed("doc-1", mail({ text: tampered }));
    await sync.pollOnce("doc-1");

    expect(sync.getDeliveries("doc-1").map((delivery) => delivery.id)).toEqual([
      "<later@example.org>",
    ]);
    expect(sync.getRejections("doc-1")).toEqual([
      { messageId: "<reused@example.org>", sender: "bob@example.org", reason: "message-replaced" },
    ]);
  });
});
