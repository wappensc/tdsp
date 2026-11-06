import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, HOST, IMAP_PORT, SMTP_PORT } from "../../../infra/email-testserver/config.ts";
import { hasTestEmailServer } from "../../../infra/email-testserver/health.ts";
import { createImapReceiver, createNodemailerSender, type MailReceiver } from "./mail-transport.ts";
import { createServer } from "./server.ts";
import { createSyncState } from "./sync-state.ts";

/**
 * L2: three bridges, one per participant, against a local Greenmail (bindings/email.md EML-14).
 * Alice starts a thread with Bob and Carol and removes Carol: every bridge then holds the set
 * {Alice, Bob}, Carol's refuses to send and is no member, and what Bob sends afterwards does
 * not reach Carol's mailbox. Skips cleanly without the test server.
 */
const available = await hasTestEmailServer();

/**
 * A third account. Greenmail knows only the two of its configuration; it creates a mailbox for
 * an address the first time a mail is delivered to it, with the address as both login and
 * password (checked against this server before relying on it). Alice's invitation is that
 * first mail, and Carol's bridge reads nothing before it.
 */
const CAROL = {
  address: "carol@example.org",
  authUser: "carol@example.org",
  password: "carol@example.org",
} as const;

type Account = { readonly address: string; readonly authUser: string; readonly password: string };

const DOCUMENT_ID = `removal-${Date.now()}`;

function receiverFor(account: Account): MailReceiver {
  return createImapReceiver({
    host: HOST,
    port: IMAP_PORT,
    secure: false,
    authUser: account.authUser,
    pass: account.password,
  });
}

async function bridgeFor(account: Account) {
  const dir = mkdtempSync(join(tmpdir(), "email-removal-"));
  const bindStorePath = join(dir, "threads.json");
  const receiver = receiverFor(account);
  const server: Server = createServer({
    address: account.address,
    sender: createNodemailerSender({
      host: HOST,
      port: SMTP_PORT,
      secure: false,
      address: account.address,
      authUser: account.authUser,
      pass: account.password,
    }),
    receiver,
    sync: createSyncState(
      receiver,
      bindStorePath,
      undefined,
      undefined,
      undefined,
      account.address,
    ),
    gpg: undefined,
    bindStorePath,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
  return { url, server, dir };
}

const post = (url: string, body: object) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe.skipIf(!available)(
  "the creator removes a participant, live against Greenmail (EML-14)",
  () => {
    let alice: Awaited<ReturnType<typeof bridgeFor>>;
    let bob: Awaited<ReturnType<typeof bridgeFor>>;
    let carol: Awaited<ReturnType<typeof bridgeFor>>;
    let root = "";

    beforeAll(async () => {
      alice = await bridgeFor(ALICE);
      bob = await bridgeFor(BOB);
      carol = await bridgeFor(CAROL);
      const participants = [ALICE.address, BOB.address, CAROL.address];
      const started = await post(`${alice.url}/threads/${DOCUMENT_ID}`, {
        recipients: participants,
        creator: ALICE.address,
        profile: "yjs-paragraphs/1",
      });
      expect(started.status).toBe(200);
      root = ((await started.json()) as { threadRootMessageId: string }).threadRootMessageId;
      for (const joiner of [bob, carol]) {
        const joined = await post(`${joiner.url}/threads/${DOCUMENT_ID}/join`, {
          recipients: participants,
          creator: ALICE.address,
          profile: "yjs-paragraphs/1",
          threadRootMessageId: root,
        });
        expect(joined.status).toBe(200);
      }
    });

    afterAll(async () => {
      for (const bridge of [alice, bob, carol]) {
        if (bridge === undefined) {
          continue;
        }
        await new Promise<void>((resolve) => bridge.server.close(() => resolve()));
        rmSync(bridge.dir, { recursive: true, force: true });
      }
    });

    const deliveries = async (url: string) =>
      (await (await fetch(`${url}/channels/${DOCUMENT_ID}/deliveries`)).json()) as {
        id: string;
        sender: string;
        payload: string;
      }[];
    const members = (url: string) => fetch(`${url}/members?channelId=${encodeURIComponent(root)}`);

    it("ends with every bridge holding the smaller set, Carol's refusing to send, and nothing more reaching her", async () => {
      const removed = await post(`${alice.url}/threads/${DOCUMENT_ID}/remove`, {
        actor: ALICE.address,
        participant: CAROL.address,
      });
      expect(removed.status).toBe(200);
      const { messageId: noticeId } = (await removed.json()) as { messageId: string };

      // Reading the thread takes the notice; the notice itself is no delivery.
      expect((await deliveries(bob.url)).map((d) => d.id)).not.toContain(noticeId);
      expect((await deliveries(carol.url)).map((d) => d.id)).not.toContain(noticeId);
      for (const bridge of [alice, bob]) {
        expect(await (await members(bridge.url)).json()).toEqual([ALICE.address, BOB.address]);
      }
      expect((await members(carol.url)).status).toBe(404);

      const refused = await post(`${carol.url}/channels/${DOCUMENT_ID}/send`, {
        sender: CAROL.address,
        payload: "from-carol-after-removal",
      });
      expect(refused.status).toBe(403);

      const sent = await post(`${bob.url}/channels/${DOCUMENT_ID}/send`, {
        sender: BOB.address,
        payload: "from-bob-after-removal",
      });
      expect(sent.status).toBe(200);
      const { deliveryId } = (await sent.json()) as { deliveryId: string };

      expect(await deliveries(alice.url)).toContainEqual(
        expect.objectContaining({
          id: deliveryId,
          sender: BOB.address,
          payload: "from-bob-after-removal",
        }),
      );
      const inCarolsMailbox = await receiverFor(CAROL).fetchThreadMessages(DOCUMENT_ID);
      expect(inCarolsMailbox.map((m) => m.messageId)).toContain(noticeId);
      expect(inCarolsMailbox.map((m) => m.messageId)).not.toContain(deliveryId);
      expect((await deliveries(carol.url)).map((d) => d.id)).not.toContain(deliveryId);

      const inAlicesMailbox = await receiverFor(ALICE).fetchThreadMessages(DOCUMENT_ID);
      expect(inAlicesMailbox.find((m) => m.messageId === deliveryId)?.to).toEqual([ALICE.address]);
    });
  },
);
