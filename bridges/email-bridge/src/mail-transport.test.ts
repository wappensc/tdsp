import { ImapFlow } from "imapflow";
import { describe, expect, it } from "vitest";
import { ALICE, BOB, HOST, IMAP_PORT, SMTP_PORT } from "../../../infra/email-testserver/config.ts";
import { hasTestEmailServer } from "../../../infra/email-testserver/health.ts";
import {
  createImapReceiver,
  createNodemailerSender,
  RecipientsRefusedError,
  requireEveryRecipient,
} from "./mail-transport.ts";

/**
 * L2 — the real round trip `mail-transport.ts`'s own doc comment
 * describes: a real send via `nodemailer`, a real header search and
 * fetch via `imapflow`, and real parsing via `mailparser`, against a
 * real local Greenmail server (`infra/email-testserver`). Gated by
 * `hasTestEmailServer()`, like `bridges/matrix-bridge`'s own L2 tests.
 * Covers the `authUser`-vs-`address` split `mail-transport.ts`'s own doc
 * comment explains.
 */
const available = await hasTestEmailServer();

describe.skipIf(!available)("createNodemailerSender/createImapReceiver", () => {
  it("sends a real email and reads it back by its custom document header", async () => {
    const sender = createNodemailerSender({
      host: HOST,
      port: SMTP_PORT,
      secure: false,
      address: ALICE.address,
      authUser: ALICE.authUser,
      pass: ALICE.password,
    });
    const receiver = createImapReceiver({
      host: HOST,
      port: IMAP_PORT,
      secure: false,
      authUser: BOB.authUser,
      pass: BOB.password,
    });

    const documentId = `doc-mail-transport-test-${Date.now()}`;
    const { messageId } = await sender.send({
      to: [BOB.address],
      subject: `tdsp document ${documentId}`,
      text: JSON.stringify({ tdsp: 1, kind: "frame", documentId, frame: "AQID" }),
      documentId,
    });
    expect(messageId.length).toBeGreaterThan(0);
    expect(sender.address).toBe(ALICE.address);

    const messages = await pollUntilFound(receiver, documentId);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      messageId,
      from: ALICE.address,
      to: [BOB.address],
      cc: [],
      text: JSON.stringify({ tdsp: 1, kind: "frame", documentId, frame: "AQID" }),
    });
  });

  it("reads a message only up to its limit: exactly at it the mail is parsed, one byte less and it is refused unread (BRG-13)", async () => {
    const sender = createNodemailerSender({
      host: HOST,
      port: SMTP_PORT,
      secure: false,
      address: ALICE.address,
      authUser: ALICE.authUser,
      pass: ALICE.password,
    });
    const receiverWith = (maxMessageBytes?: number) =>
      createImapReceiver({
        host: HOST,
        port: IMAP_PORT,
        secure: false,
        authUser: BOB.authUser,
        pass: BOB.password,
        ...(maxMessageBytes === undefined ? {} : { maxMessageBytes }),
      });
    const documentId = `doc-mail-limit-test-${Date.now()}`;
    const text = JSON.stringify({
      tdsp: 1,
      kind: "frame",
      documentId,
      frame: "x".repeat(20_000),
    });
    const { messageId } = await sender.send({
      to: [BOB.address],
      subject: `tdsp document ${documentId}`,
      text,
      documentId,
    });
    await pollUntilFound(receiverWith(), documentId);

    // The message's size as the server keeps it, asked directly.
    const client = new ImapFlow({
      host: HOST,
      port: IMAP_PORT,
      secure: false,
      auth: { user: BOB.authUser, pass: BOB.password },
      logger: false,
    });
    await client.connect();
    let size = 0;
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const uids = await client.search(
          { header: { "x-tdsp-document": documentId } },
          { uid: true },
        );
        const uid = uids === false ? undefined : uids[0];
        const found = await client.fetchOne(String(uid), { size: true }, { uid: true });
        size = found ? (found.size ?? 0) : 0;
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
    expect(size).toBeGreaterThan(20_000);

    const [atLimit] = await receiverWith(size).fetchThreadMessages(documentId);
    expect(atLimit).toMatchObject({ messageId, text });
    expect(atLimit?.tooLarge).toBeUndefined();

    const [overLimit] = await receiverWith(size - 1).fetchThreadMessages(documentId);
    expect(overLimit).toEqual({
      messageId,
      from: ALICE.address,
      to: [],
      cc: [],
      text: "",
      tooLarge: true,
    });
  });

  it("carries In-Reply-To/References so the thread stays linked", async () => {
    const sender = createNodemailerSender({
      host: HOST,
      port: SMTP_PORT,
      secure: false,
      address: ALICE.address,
      authUser: ALICE.authUser,
      pass: ALICE.password,
    });
    const receiver = createImapReceiver({
      host: HOST,
      port: IMAP_PORT,
      secure: false,
      authUser: BOB.authUser,
      pass: BOB.password,
    });

    const documentId = `doc-mail-transport-thread-test-${Date.now()}`;
    const root = await sender.send({
      to: [BOB.address],
      subject: `tdsp document ${documentId}`,
      text: "root",
      documentId,
    });
    const reply = await sender.send({
      to: [BOB.address],
      subject: `tdsp document ${documentId}`,
      text: "reply",
      documentId,
      inReplyTo: root.messageId,
      references: [root.messageId],
    });
    expect(reply.messageId).not.toBe(root.messageId);

    const messages = await pollUntilFound(receiver, documentId, 2);
    expect(messages).toHaveLength(2);
  });

  /**
   * The invitation link rests on this (SPECIFICATION.md §11.3): an
   * invitation's own Message-ID is chosen *before* it is sent, so the
   * invitation text can hold a complete link. Verified against a real SMTP/IMAP server, not
   * assumed: the id the caller picked is the id the recipient's mailbox holds.
   */
  it("delivers a message under the Message-ID the caller chose, unchanged", async () => {
    const sender = createNodemailerSender({
      host: HOST,
      port: SMTP_PORT,
      secure: false,
      address: ALICE.address,
      authUser: ALICE.authUser,
      pass: ALICE.password,
    });
    const receiver = createImapReceiver({
      host: HOST,
      port: IMAP_PORT,
      secure: false,
      authUser: BOB.authUser,
      pass: BOB.password,
    });
    const documentId = `doc-mail-transport-msgid-test-${Date.now()}`;
    const chosen = `<${crypto.randomUUID()}@example.org>`;

    const sent = await sender.send({
      to: [BOB.address],
      subject: `tdsp document ${documentId}`,
      text: "invite",
      documentId,
      messageId: chosen,
    });
    expect(sent.messageId).toBe(chosen);

    const messages = await pollUntilFound(receiver, documentId);
    expect(messages[0]?.messageId).toBe(chosen);
  });

  it("refuses a malformed Message-ID before anything reaches the wire", async () => {
    const sender = createNodemailerSender({
      host: HOST,
      port: SMTP_PORT,
      secure: false,
      address: ALICE.address,
      authUser: ALICE.authUser,
      pass: ALICE.password,
    });
    const receiver = createImapReceiver({
      host: HOST,
      port: IMAP_PORT,
      secure: false,
      authUser: BOB.authUser,
      pass: BOB.password,
    });
    const documentId = `doc-mail-transport-badmsgid-test-${Date.now()}`;
    await expect(
      sender.send({
        to: [BOB.address],
        subject: `tdsp document ${documentId}`,
        text: "x",
        documentId,
        messageId: "<a@b.org>\r\nBcc: evil@example.org",
      }),
    ).rejects.toThrow(/malformed Message-ID/);
    // Nothing was sent: the mailbox holds no message for this document.
    expect(await receiver.fetchThreadMessages(documentId)).toEqual([]);
  });

  /**
   * A real provider (GMX) files a signed and encrypted edit in the
   * recipient's own spam folder, not `INBOX`; a bridge that searched only
   * `INBOX` would never see it — not late, just unsearched. This
   * reproduces the shape: moves an already-delivered message into a `Junk` folder
   * (via IMAP directly, standing in for whatever moved it there on a real
   * provider — a spam filter, in production) and confirms it is still
   * found. `Junk` is recognized without any server-side SPECIAL-USE
   * support: `mail-transport.ts`'s own `junkMailboxPath` relies on
   * `imapflow`'s built-in fallback that matches well-known folder names,
   * which is what actually runs here against Greenmail; `\Junk` reported
   * by a real SPECIAL-USE-capable server (verified against GMX) takes the
   * same code path.
   */
  it("finds a message moved to the account's own Junk folder, not just INBOX", async () => {
    const sender = createNodemailerSender({
      host: HOST,
      port: SMTP_PORT,
      secure: false,
      address: ALICE.address,
      authUser: ALICE.authUser,
      pass: ALICE.password,
    });
    const receiver = createImapReceiver({
      host: HOST,
      port: IMAP_PORT,
      secure: false,
      authUser: BOB.authUser,
      pass: BOB.password,
    });
    const documentId = `doc-mail-transport-junk-test-${Date.now()}`;
    await sender.send({
      to: [BOB.address],
      subject: `tdsp document ${documentId}`,
      text: "moved to junk after delivery",
      documentId,
    });
    await pollUntilFound(receiver, documentId);

    const bob = new ImapFlow({
      host: HOST,
      port: IMAP_PORT,
      secure: false,
      auth: { user: BOB.authUser, pass: BOB.password },
      logger: false,
    });
    await bob.connect();
    try {
      await bob.mailboxCreate("Junk").catch(() => undefined); // idempotent: fine if it already exists
      const lock = await bob.getMailboxLock("INBOX");
      try {
        const uids = await bob.search({ header: { "x-tdsp-document": documentId } }, { uid: true });
        expect(uids).toBeTruthy();
        await bob.messageMove(uids as number[], "Junk", { uid: true });
      } finally {
        lock.release();
      }
    } finally {
      await bob.logout();
    }

    // Gone from INBOX, but fetchThreadMessages still finds it via Junk.
    const messages = await pollUntilFound(receiver, documentId);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe("moved to junk after delivery");
  });
});

async function pollUntilFound(
  receiver: ReturnType<typeof createImapReceiver>,
  documentId: string,
  expectedCount = 1,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const messages = await receiver.fetchThreadMessages(documentId);
    if (messages.length >= expectedCount) {
      return messages;
    }
    if (Date.now() > deadline) {
      return messages;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe("requireEveryRecipient (EML-11)", () => {
  it("passes a send every recipient accepted", () => {
    expect(() => requireEveryRecipient({ messageId: "<m@x>", rejected: [] })).not.toThrow();
    expect(() => requireEveryRecipient({ messageId: "<m@x>" })).not.toThrow();
  });

  it("refuses a partial one, naming whom, temporary only when every refusal was a 4xx", () => {
    const partial = (codes: number[]) => () =>
      requireEveryRecipient({
        messageId: "<m@x>",
        rejected: ["bob@example.org", { address: "carol@example.org" }],
        rejectedErrors: codes.map((responseCode) => ({ responseCode })),
      });
    expect(partial([450, 451])).toThrow(RecipientsRefusedError);
    expect(partial([450, 451])).toThrow(/refused bob@example.org, carol@example.org for now/);
    expect(partial([450, 550])).toThrow(/refused bob@example.org, carol@example.org, and/);
    try {
      partial([450, 550])();
    } catch (error) {
      expect((error as RecipientsRefusedError).temporary).toBe(false);
    }
  });
});
