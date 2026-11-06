import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmailMessengerPort } from "@tdsp/messenger-email";
// infra/email-testserver isn't a pnpm workspace package — see
// mail-transport.test.ts's own comment on this same relative import.
import { ALICE, BOB, HOST, IMAP_PORT, SMTP_PORT } from "../../../infra/email-testserver/config.ts";
import { createImapReceiver, createNodemailerSender } from "./mail-transport.ts";
import { createServer } from "./server.ts";
import { createSyncState } from "./sync-state.ts";

/** One document's thread between Alice and Bob, each through a bridge of their own. */
export interface LivePair {
  documentId: string;
  creatorPort: EmailMessengerPort;
  creatorId: string;
  memberPort: EmailMessengerPort;
  memberId: string;
  channelId: string;
}

/**
 * Two real instances of this package's own server against the local Greenmail (L2,
 * docs/testing.md), each with its own SMTP sender, IMAP receiver and bind store, and an
 * adapter of its own pointed at it: what an application of each person would run. Shared
 * by the tests that need two such bridges, so their setup cannot drift apart. Call
 * `close()` once, after the last pair.
 *
 * Unlike Matrix's `bind()` (both sides bind to the same pre-existing room), email has no
 * equivalent for the receiving side to validate against — `startThread()` creates a new
 * thread. Alice's `startThread()` creates it and sends the one real invite email; Bob's
 * `joinThread()` registers his own bridge's bind-store entry for that same thread, exactly
 * as a participant who opens the invitation link does.
 */
export function livePairs(prefix: string) {
  const servers: Server[] = [];
  const dirs: string[] = [];
  let counter = 0;

  async function start(): Promise<LivePair> {
    const documentId = `${prefix}-doc-${counter++}-${Date.now()}`;

    const aliceDir = mkdtempSync(join(tmpdir(), `email-bridge-${prefix}-alice-`));
    const bobDir = mkdtempSync(join(tmpdir(), `email-bridge-${prefix}-bob-`));
    dirs.push(aliceDir, bobDir);
    const aliceBindStorePath = join(aliceDir, "threads.json");
    const bobBindStorePath = join(bobDir, "threads.json");

    const aliceSender = createNodemailerSender({
      host: HOST,
      port: SMTP_PORT,
      secure: false,
      address: ALICE.address,
      authUser: ALICE.authUser,
      pass: ALICE.password,
    });
    const aliceReceiver = createImapReceiver({
      host: HOST,
      port: IMAP_PORT,
      secure: false,
      authUser: ALICE.authUser,
      pass: ALICE.password,
    });
    const bobSender = createNodemailerSender({
      host: HOST,
      port: SMTP_PORT,
      secure: false,
      address: BOB.address,
      authUser: BOB.authUser,
      pass: BOB.password,
    });
    const bobReceiver = createImapReceiver({
      host: HOST,
      port: IMAP_PORT,
      secure: false,
      authUser: BOB.authUser,
      pass: BOB.password,
    });

    const aliceServer = createServer({
      address: ALICE.address,
      sender: aliceSender,
      sync: createSyncState(aliceReceiver, aliceBindStorePath, undefined),
      gpg: undefined,
      bindStorePath: aliceBindStorePath,
    });
    const bobServer = createServer({
      address: BOB.address,
      sender: bobSender,
      sync: createSyncState(bobReceiver, bobBindStorePath, undefined),
      gpg: undefined,
      bindStorePath: bobBindStorePath,
    });
    servers.push(aliceServer, bobServer);
    await Promise.all([
      new Promise<void>((resolve) => aliceServer.listen(0, "127.0.0.1", resolve)),
      new Promise<void>((resolve) => bobServer.listen(0, "127.0.0.1", resolve)),
    ]);
    const aliceUrl = `http://127.0.0.1:${(aliceServer.address() as AddressInfo).port}`;
    const bobUrl = `http://127.0.0.1:${(bobServer.address() as AddressInfo).port}`;

    const creatorPort = new EmailMessengerPort(aliceUrl);
    const memberPort = new EmailMessengerPort(bobUrl);

    const { threadRootMessageId } = await creatorPort.startThread(
      documentId,
      [ALICE.address, BOB.address],
      ALICE.address,
      "yjs-paragraphs/1",
    );
    await memberPort.joinThread(
      documentId,
      threadRootMessageId,
      [ALICE.address, BOB.address],
      ALICE.address,
      "yjs-paragraphs/1",
    );
    return {
      documentId,
      creatorPort,
      creatorId: ALICE.address,
      memberPort,
      memberId: BOB.address,
      channelId: threadRootMessageId,
    };
  }

  async function close(): Promise<void> {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
    );
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  return { start, close };
}
