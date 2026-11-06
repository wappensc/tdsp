import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MatrixMessengerPort } from "@tdsp/messenger-matrix";
// infra/matrix-testserver isn't a pnpm workspace package -- see
// bind.test.ts's own comment on this same relative import.
import {
  BASE_URL,
  TEST_ACCOUNT_PASSWORD,
  TEST_ACCOUNTS_PATH,
} from "../../../infra/matrix-testserver/config.ts";
import {
  signTestDevice,
  type TestIdentity,
} from "../../../infra/matrix-testserver/cross-signing.ts";
import { loginFresh } from "../../../infra/matrix-testserver/login.ts";
import type { CryptoMachine } from "./crypto-machine.ts";
import { createLiveServerDependencies, createServer } from "./server.ts";

/** One bound document between Alice and Bob, each through a bridge of their own. */
export interface LivePair {
  documentId: string;
  creatorPort: MatrixMessengerPort;
  creatorId: string;
  memberPort: MatrixMessengerPort;
  memberId: string;
  channelId: string;
}

/**
 * Two real instances of this package's own server against the local Synapse (L2,
 * docs/testing.md), each with its own fresh login, its own temp-dir crypto store and bind
 * store, and an adapter of its own pointed at it: what an application of each person
 * would run. Shared by the tests that need two such bridges, so their setup cannot drift
 * apart. Call `close()` once, after the last pair.
 *
 * In the encrypted room each bridge's device is signed by its account's identity once it has
 * uploaded its keys, as a person confirms a new device: unsigned, a bridge would neither send
 * there nor deliver the other's frames (bindings/matrix.md MTX-4).
 *
 * A fresh login per pair sidesteps the one-time-key collision `login.ts`'s own doc
 * comment documents (a persisted token's device history not matching a fresh local
 * crypto store).
 */
export function livePairs(prefix: string) {
  let accounts:
    | {
        alice: { userId: string; accessToken: string; identity: TestIdentity };
        bob: { userId: string; accessToken: string; identity: TestIdentity };
        rooms: { plain: string; encrypted: string };
      }
    | undefined;
  const servers: Server[] = [];
  const dirs: string[] = [];
  const cryptoMachines: CryptoMachine[] = [];
  let counter = 0;

  async function start(room: "plain" | "encrypted" = "plain"): Promise<LivePair> {
    accounts ??= JSON.parse(readFileSync(TEST_ACCOUNTS_PATH, "utf8")) as NonNullable<
      typeof accounts
    >;
    const documentId = `${prefix}-doc-${counter++}-${Date.now()}`;

    const aliceDir = mkdtempSync(join(tmpdir(), `matrix-bridge-${prefix}-alice-`));
    const bobDir = mkdtempSync(join(tmpdir(), `matrix-bridge-${prefix}-bob-`));
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
    if (room === "encrypted") {
      await Promise.all([
        signTestDevice(aliceLogin, accounts.alice.identity, aliceLogin.deviceId),
        signTestDevice(bobLogin, accounts.bob.identity, bobLogin.deviceId),
      ]);
    }

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
      new Promise<void>((resolve) => aliceServer.listen(0, "127.0.0.1", resolve)),
      new Promise<void>((resolve) => bobServer.listen(0, "127.0.0.1", resolve)),
    ]);
    const aliceUrl = `http://127.0.0.1:${(aliceServer.address() as AddressInfo).port}`;
    const bobUrl = `http://127.0.0.1:${(bobServer.address() as AddressInfo).port}`;

    const channelId = accounts.rooms[room];
    const creatorPort = new MatrixMessengerPort(aliceUrl);
    const memberPort = new MatrixMessengerPort(bobUrl);
    await Promise.all([
      creatorPort.bind(documentId, channelId, aliceLogin.userId, "yjs-paragraphs/1"),
      memberPort.bind(documentId, channelId, aliceLogin.userId, "yjs-paragraphs/1"),
    ]);
    return {
      documentId,
      creatorPort,
      creatorId: aliceLogin.userId,
      memberPort,
      memberId: bobLogin.userId,
      channelId,
    };
  }

  async function close(): Promise<void> {
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
  }

  return { start, close };
}
