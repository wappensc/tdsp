import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, HOST, IMAP_PORT, SMTP_PORT } from "../../../infra/email-testserver/config.ts";
import { hasTestEmailServer } from "../../../infra/email-testserver/health.ts";
import { setBindRecord } from "./bind-store.ts";
import { createImapReceiver, createNodemailerSender, type MailReceiver } from "./mail-transport.ts";
import { createServer } from "./server.ts";
import { createSyncState } from "./sync-state.ts";

/**
 * L2: two bridges on one mailbox, as two devices of one address (SPECIFICATION.md EML-12,
 * #31). What one sends, the other receives from the copy in the account's sent folder; the
 * other participants receive the mail unchanged. Against a local Greenmail, which files no
 * sent mail of its own and starts without a sent folder: the bridge appends, and creates the
 * folder. Skips cleanly without the test server.
 */
const available = await hasTestEmailServer();

const DOCUMENT_ID = `own-devices-${Date.now()}`;
const ROOT = `<root-${Date.now()}@example.org>`;

function receiverFor(account: typeof ALICE): MailReceiver {
  return createImapReceiver({
    host: HOST,
    port: IMAP_PORT,
    secure: false,
    authUser: account.authUser,
    pass: account.password,
  });
}

async function bridgeFor(account: typeof ALICE) {
  const dir = mkdtempSync(join(tmpdir(), "email-sent-copy-"));
  const bindStorePath = join(dir, "threads.json");
  setBindRecord(bindStorePath, DOCUMENT_ID, {
    recipients: [ALICE.address, BOB.address],
    creatorMemberId: ALICE.address,
    profile: "yjs-paragraphs/1",
    threadRootMessageId: ROOT,
    createdAt: new Date(0).toISOString(),
    pgpEnabled: false,
    pinnedFingerprints: {},
  });
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
    sync: createSyncState(receiver, bindStorePath, undefined),
    gpg: undefined,
    bindStorePath,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
  return { url, server, dir };
}

describe.skipIf(!available)("two bridges on one mailbox, live against Greenmail (EML-12)", () => {
  let laptop: Awaited<ReturnType<typeof bridgeFor>>;
  let phone: Awaited<ReturnType<typeof bridgeFor>>;
  let bob: Awaited<ReturnType<typeof bridgeFor>>;

  beforeAll(async () => {
    laptop = await bridgeFor(ALICE);
    phone = await bridgeFor(ALICE);
    bob = await bridgeFor(BOB);
  });

  afterAll(async () => {
    for (const bridge of [laptop, phone, bob]) {
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

  it("delivers what one device sent to the other device of the same address, and to the others unchanged", async () => {
    const sent = await fetch(`${laptop.url}/channels/${DOCUMENT_ID}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sender: ALICE.address, payload: "frame-from-the-laptop" }),
    });
    expect(sent.status).toBe(200);
    const { deliveryId } = (await sent.json()) as { deliveryId: string };

    const onPhone = await deliveries(phone.url);
    expect(onPhone).toContainEqual(
      expect.objectContaining({
        id: deliveryId,
        sender: ALICE.address,
        payload: "frame-from-the-laptop",
      }),
    );
    const onBob = await deliveries(bob.url);
    expect(onBob).toContainEqual(
      expect.objectContaining({
        id: deliveryId,
        sender: ALICE.address,
        payload: "frame-from-the-laptop",
      }),
    );

    // Bob's copy is the mail every 1.x bridge expects: addressed to the others only.
    const [inBobsMailbox] = await receiverFor(BOB).fetchThreadMessages(DOCUMENT_ID);
    expect(inBobsMailbox?.to).toEqual([BOB.address]);
  });
});
