import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmailMessengerPort } from "@tdsp/messenger-email";
import { messengerPortContractCases } from "@tdsp/messenger-port/contract";
import { afterAll, describe, it } from "vitest";
// infra/email-testserver isn't a pnpm workspace package — see
// mail-transport.test.ts's own comment on this same relative import.
import { ALICE, BOB, HOST, IMAP_PORT, SMTP_PORT } from "../../../infra/email-testserver/config.ts";
import { hasTestEmailServer } from "../../../infra/email-testserver/health.ts";
import { createImapReceiver, createNodemailerSender } from "./mail-transport.ts";
import { createServer } from "./server.ts";
import { createSyncState } from "./sync-state.ts";

/**
 * Runs the exact same `messengerPortContractCases` (SPECIFICATION.md §3.6) `packages/messenger-mock/src/
 * contract.test.ts` runs against the mock, here against two real
 * instances of this package's own server and a real local Greenmail
 * server (L2, docs/testing.md). `@tdsp/messenger-email` (a devDependency
 * for exactly this file) is the browser-side client an application ships; this is a real
 * client talking to a real instance of this real server.
 *
 * Unlike Matrix's `bind()` (both sides bind to the same pre-existing
 * room), email has no equivalent for the receiving side to validate
 * against — `startThread()` genuinely creates a new thread. Alice's
 * `startThread()` creates it and sends the one real invite email; Bob's
 * `joinThread()` registers his own bridge's bind-store entry for that
 * same thread, exactly as a participant who opens the invitation link
 * does — not a test-only shortcut, real adapter
 * capability both sides of this fixture actually exercise.
 */
const available = await hasTestEmailServer();

describe.skipIf(!available)("MessengerPort contract (email, live against a real Greenmail)", () => {
  const servers: Server[] = [];
  const dirs: string[] = [];
  let counter = 0;

  afterAll(async () => {
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
  });

  /**
   * One fresh pair of bridge servers, and a fresh real thread, per
   * contract case — exactly like `messengerPortContractCases`'s own doc
   * comment asks for: one case's state must never leak into
   * the next case. Each case also gets its own fresh IMAP receivers, so
   * one case's messages are never confused with another's (the shared
   * `x-tdsp-document` header search already scopes this per
   * `documentId`, but a fresh receiver keeps the fixture as close to a
   * real two-participant setup as possible).
   */
  async function createFixture() {
    const documentId = `contract-doc-${counter++}-${Date.now()}`;

    const aliceDir = mkdtempSync(join(tmpdir(), "email-bridge-contract-alice-"));
    const bobDir = mkdtempSync(join(tmpdir(), "email-bridge-contract-bob-"));
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
      new Promise<void>((resolve) => aliceServer.listen(0, resolve)),
      new Promise<void>((resolve) => bobServer.listen(0, resolve)),
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
    // Prime both sides' sync state before the case sends anything it
    // cares about — bridges/matrix-bridge/src/contract.test.ts's own note.
    await Promise.all([
      creatorPort.receive(documentId, ALICE.address),
      memberPort.receive(documentId, BOB.address),
    ]);

    return {
      documentId,
      creatorPort,
      creatorId: ALICE.address,
      memberPort,
      memberId: BOB.address,
    };
  }

  // Real SMTP send + IMAP poll round trips, several per case — comfortably
  // past the 5s default, matching this repo's other live-Matrix specs'
  // own generous timeouts.
  const CASE_TIMEOUT_MS = 30_000;

  for (const { name, run } of messengerPortContractCases) {
    it(
      name,
      async () => {
        const fixture = await createFixture();
        await run(fixture);
      },
      CASE_TIMEOUT_MS,
    );
  }
});
