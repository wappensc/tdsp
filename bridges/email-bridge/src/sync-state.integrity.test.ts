import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BindRecord, setBindRecord } from "./bind-store.ts";
import type { IncomingMail, MailReceiver } from "./mail-transport.ts";
import { createSyncState } from "./sync-state.ts";

/**
 * SPECIFICATION.md BRG-12: a bridge must never apply, and must record as an
 * integrity violation, a messenger-native edit or withdrawal of an
 * already-delivered message. For email that is a second, distinct message
 * reusing an already-seen `Message-ID` — verified against a real Greenmail
 * server (a real `nodemailer`/`imapflow` round trip): nothing
 * at the SMTP/IMAP level enforces `Message-ID` uniqueness, so this is a
 * real, deliverable scenario, not a hypothetical one.
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
      { messageId: "<reused@example.org>", sender: "bob@example.org", reason: "message-id-reused" },
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
});
