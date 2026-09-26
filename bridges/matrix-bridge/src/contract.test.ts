import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MatrixMessengerPort } from "@tdsp/messenger-matrix";
import { messengerPortContractCases } from "@tdsp/messenger-port/contract";
import { afterAll, describe, it } from "vitest";
// infra/matrix-testserver isn't a pnpm workspace package -- see
// bind.test.ts's own comment on this same relative import.
import {
  BASE_URL,
  TEST_ACCOUNT_PASSWORD,
  TEST_ACCOUNTS_PATH,
} from "../../../infra/matrix-testserver/config.ts";
import { hasTestMatrixHomeserver } from "../../../infra/matrix-testserver/health.ts";
import { loginFresh } from "../../../infra/matrix-testserver/login.ts";
import type { CryptoMachine } from "./crypto-machine.ts";
import { createLiveServerDependencies, createServer } from "./server.ts";

/**
 * Runs the exact same `messengerPortContractCases` (SPECIFICATION.md §3.6)
 * `packages/messenger-mock/src/contract.test.ts` runs against the mock,
 * here against two real instances of this package's own server and a real
 * local Synapse (L2, docs/testing.md). `@tdsp/messenger-matrix` (a
 * devDependency for exactly this file) is the browser-side client an
 * application ships; this is a real client talking to a real instance of
 * this real server, not raw `fetch()` calls the way `send-receive.test.ts`
 * exercises the routes -- reuses that file's own two-identity
 * (real login, real bind, real `listen(0)`) setup rather than a third,
 * drifting copy of it. Only the assertions differ: the shared contract
 * cases instead of this file's own hand-written ones.
 *
 * Unlike the mock's single shared instance
 * (`packages/messenger-mock/src/contract.test.ts`), Matrix genuinely
 * needs two separate `MatrixMessengerPort`s, each pointed at its own
 * bridge server, each backed by its own real account and its own
 * temp-dir crypto store -- this *is* the difference a contract worth
 * sharing has to survive.
 */
const available = await hasTestMatrixHomeserver();

describe.skipIf(!available)("MessengerPort contract (Matrix, live against a local Synapse)", () => {
  let accounts: {
    alice: { userId: string; accessToken: string };
    bob: { userId: string; accessToken: string };
    rooms: { plain: string; encrypted: string };
  };
  const servers: Server[] = [];
  const dirs: string[] = [];
  const cryptoMachines: CryptoMachine[] = [];
  let counter = 0;

  afterAll(async () => {
    for (const crypto of cryptoMachines) {
      crypto.close();
    }
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
   * One fresh pair of bridge servers per contract case, exactly like
   * `messengerPortContractCases`'s own doc comment asks for: one case's
   * state must never leak into the next. A fresh login
   * per case also sidesteps the one-time-key collision `login.ts`'s own
   * doc comment documents (a persisted token's device history not
   * matching a fresh local crypto store) -- the same reason
   * `send-receive.test.ts` never reuses `accounts.alice.accessToken`
   * directly either.
   */
  async function createFixture() {
    accounts ??= JSON.parse(readFileSync(TEST_ACCOUNTS_PATH, "utf8"));
    const documentId = `contract-doc-${counter++}-${Date.now()}`;

    const aliceDir = mkdtempSync(join(tmpdir(), "matrix-bridge-contract-alice-"));
    const bobDir = mkdtempSync(join(tmpdir(), "matrix-bridge-contract-bob-"));
    dirs.push(aliceDir, bobDir);

    const [aliceLogin, bobLogin] = await Promise.all([
      loginFresh(accounts.alice.userId, TEST_ACCOUNT_PASSWORD),
      loginFresh(accounts.bob.userId, TEST_ACCOUNT_PASSWORD),
    ]);

    const aliceBindStorePath = join(aliceDir, "tdsp-channels.json");
    const bobBindStorePath = join(bobDir, "tdsp-channels.json");
    const [aliceDeps, bobDeps] = await Promise.all([
      createLiveServerDependencies(
        { homeserverUrl: BASE_URL, accessToken: aliceLogin.accessToken },
        aliceBindStorePath,
      ),
      createLiveServerDependencies(
        { homeserverUrl: BASE_URL, accessToken: bobLogin.accessToken },
        bobBindStorePath,
      ),
    ]);
    cryptoMachines.push(aliceDeps.crypto, bobDeps.crypto);

    const aliceServer = createServer({
      homeserverUrl: BASE_URL,
      accessToken: aliceLogin.accessToken,
      bindStorePath: aliceBindStorePath,
      ...aliceDeps,
    });
    const bobServer = createServer({
      homeserverUrl: BASE_URL,
      accessToken: bobLogin.accessToken,
      bindStorePath: bobBindStorePath,
      ...bobDeps,
    });
    servers.push(aliceServer, bobServer);
    await Promise.all([
      new Promise<void>((resolve) => aliceServer.listen(0, resolve)),
      new Promise<void>((resolve) => bobServer.listen(0, resolve)),
    ]);
    const aliceUrl = `http://127.0.0.1:${(aliceServer.address() as AddressInfo).port}`;
    const bobUrl = `http://127.0.0.1:${(bobServer.address() as AddressInfo).port}`;

    const creatorPort = new MatrixMessengerPort(aliceUrl);
    const memberPort = new MatrixMessengerPort(bobUrl);
    await Promise.all([
      creatorPort.bind(documentId, accounts.rooms.plain, aliceLogin.userId, "yjs-paragraphs/1"),
      memberPort.bind(documentId, accounts.rooms.plain, aliceLogin.userId, "yjs-paragraphs/1"),
    ]);
    // Prime both sides' sync state before the case sends anything it
    // cares about -- send-receive.test.ts's own "first sync establishes
    // a baseline only" note.
    await Promise.all([
      creatorPort.receive(documentId, aliceLogin.userId),
      memberPort.receive(documentId, bobLogin.userId),
    ]);

    return {
      documentId,
      creatorPort,
      creatorId: aliceLogin.userId,
      memberPort,
      memberId: bobLogin.userId,
    };
  }

  // Real Synapse round trips, several per case (login x2, bind x2, plus
  // whatever the case itself does) -- comfortably past the 5s default,
  // matching this repo's other live-Matrix specs' own generous timeouts.
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
