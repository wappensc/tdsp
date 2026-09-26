import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// infra/matrix-testserver isn't a pnpm workspace package — see
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
 * The real, `hasTestMatrixHomeserver()`-gated counterpart to
 * `server.test.ts`'s fake-backed suite: two separate, real bridge HTTP
 * servers — one per account (alice's, bob's), each with its own real
 * `MatrixApiConfig`/bind-store/`SyncState` — bound to the same real
 * test room, doing an actual alice→bob `send`/`receive` round trip and a
 * bob→alice one over the same routes against a real Synapse. The frame
 * format (SPECIFICATION.md §4) rides completely
 * opaque through all of this (`packages/document-protocol/src/framing.ts`
 * is deliberately not imported here — this suite sends and receives raw
 * bytes, exactly matching a real `MessengerPort` adapter's own view: it
 * never parses the frame, `document-protocol` does; the existing
 * fake-transport unit test in `packages/document-protocol` already
 * covers `encodeEditFrame`/`decodeFrame` against a hand-rolled fake
 * `MessengerPort`, unaffected by this suite and not duplicated here).
 */
const available = await hasTestMatrixHomeserver();

describe.skipIf(!available)(
  "bridges/matrix-bridge send/receive/resync, live against a local Synapse",
  () => {
    let accounts: {
      alice: { userId: string; accessToken: string };
      bob: { userId: string; accessToken: string };
      rooms: { plain: string; encrypted: string };
    };
    let aliceDir: string;
    let bobDir: string;
    let aliceServer: Server;
    let bobServer: Server;
    let aliceUrl: string;
    let bobUrl: string;
    let aliceCrypto: CryptoMachine;
    let bobCrypto: CryptoMachine;
    const documentId = `doc-live-send-${Date.now()}`;

    beforeAll(async () => {
      accounts = JSON.parse(readFileSync(TEST_ACCOUNTS_PATH, "utf8"));

      aliceDir = mkdtempSync(join(tmpdir(), "matrix-bridge-alice-"));
      bobDir = mkdtempSync(join(tmpdir(), "matrix-bridge-bob-"));
      const aliceBindStorePath = join(aliceDir, "tdsp-channels.json");
      const bobBindStorePath = join(bobDir, "tdsp-channels.json");

      // Fresh logins, not accounts.alice/bob.accessToken: each
      // createLiveServerDependencies call below builds a CryptoMachine
      // backed by a brand-new (temp-dir) local store every test run,
      // which only matches a device Synapse has no prior one-time-key
      // history for — see login.ts's own doc comment for the
      // live-confirmed collision this avoids.
      const [aliceLogin, bobLogin] = await Promise.all([
        loginFresh(accounts.alice.userId, TEST_ACCOUNT_PASSWORD),
        loginFresh(accounts.bob.userId, TEST_ACCOUNT_PASSWORD),
      ]);

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
      aliceCrypto = aliceDeps.crypto;
      bobCrypto = bobDeps.crypto;

      aliceServer = createServer({
        homeserverUrl: BASE_URL,
        accessToken: aliceLogin.accessToken,
        bindStorePath: aliceBindStorePath,
        ...aliceDeps,
      });
      bobServer = createServer({
        homeserverUrl: BASE_URL,
        accessToken: bobLogin.accessToken,
        bindStorePath: bobBindStorePath,
        ...bobDeps,
      });
      await Promise.all([
        new Promise<void>((resolve) => aliceServer.listen(0, resolve)),
        new Promise<void>((resolve) => bobServer.listen(0, resolve)),
      ]);
      aliceUrl = `http://127.0.0.1:${(aliceServer.address() as AddressInfo).port}`;
      bobUrl = `http://127.0.0.1:${(bobServer.address() as AddressInfo).port}`;

      // Both bind to the same real room, same documentId — this is the
      // "many documents/members -> one room" model (SPECIFICATION.md §12.2),
      // exercised for real, not just asserted in prose.
      for (const [url, memberId] of [
        [aliceUrl, accounts.alice.userId],
        [bobUrl, accounts.bob.userId],
      ] as const) {
        const response = await fetch(`${url}/channels/${documentId}/bind`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            channelId: accounts.rooms.plain,
            creator: accounts.alice.userId,
            profile: "yjs-paragraphs/1",
          }),
        });
        expect(response.status, `bind failed for ${memberId}`).toBe(200);
      }

      // Prime both sides' sync state (sync-state.ts's own "first sync
      // establishes a baseline only" rule) before either side sends
      // anything this suite cares about — matching a real bridge's own
      // startup order, not a test-only workaround.
      await Promise.all([
        fetch(`${aliceUrl}/channels/${documentId}/deliveries`),
        fetch(`${bobUrl}/channels/${documentId}/deliveries`),
      ]);
    });

    afterAll(async () => {
      aliceCrypto.close();
      bobCrypto.close();
      await Promise.all([
        new Promise<void>((resolve, reject) =>
          aliceServer.close((error) => (error ? reject(error) : resolve())),
        ),
        new Promise<void>((resolve, reject) =>
          bobServer.close((error) => (error ? reject(error) : resolve())),
        ),
      ]);
      rmSync(aliceDir, { recursive: true, force: true });
      rmSync(bobDir, { recursive: true, force: true });
    });

    it("alice sends a real Matrix event and bob receives it as a Delivery", async () => {
      const plaintext = `hello from alice, ${Date.now()}`;
      const payload = btoa(plaintext);

      const sendResponse = await fetch(`${aliceUrl}/channels/${documentId}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sender: accounts.alice.userId, payload }),
      });
      expect(sendResponse.status).toBe(200);
      const { deliveryId } = (await sendResponse.json()) as { deliveryId: string };
      expect(deliveryId).toMatch(/^\$/); // a real Matrix event id

      // receive() polls /sync itself -- retry a few times rather than
      // assuming Synapse has already delivered it to /sync on the very
      // next call (real network round trip, not a mock).
      let deliveries: { id: string; sender: string; payload: string }[] = [];
      for (let attempt = 0; attempt < 10 && deliveries.length === 0; attempt++) {
        const response = await fetch(`${bobUrl}/channels/${documentId}/deliveries`);
        expect(response.status).toBe(200);
        deliveries = (await response.json()) as typeof deliveries;
        if (deliveries.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }

      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]?.id).toBe(deliveryId);
      expect(deliveries[0]?.sender).toBe(accounts.alice.userId);
      expect(atob(deliveries[0]?.payload ?? "")).toBe(plaintext);
    });

    it("bob's resync request rides the ordinary send/deliveries routes, indistinguishable from any other frame to this bridge", async () => {
      // A resync request is an opaque payload sent through the same route as
      // everything else. This bridge never parses the frame (see this file's
      // own doc comment), so from here it is simply a second payload.
      const payload = btoa("pretend-resync-request-frame-bytes");
      const sendResponse = await fetch(`${bobUrl}/channels/${documentId}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sender: accounts.bob.userId, payload }),
      });
      expect(sendResponse.status).toBe(200);
      const { deliveryId } = (await sendResponse.json()) as { deliveryId: string };
      expect(deliveryId).toMatch(/^\$/);

      let deliveries: { id: string; sender: string; payload: string }[] = [];
      for (let attempt = 0; attempt < 10; attempt++) {
        const response = await fetch(`${aliceUrl}/channels/${documentId}/deliveries`);
        expect(response.status).toBe(200);
        deliveries = (await response.json()) as typeof deliveries;
        if (deliveries.some((d) => d.id === deliveryId)) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      const fromBob = deliveries.find((d) => d.id === deliveryId);
      expect(fromBob?.sender).toBe(accounts.bob.userId);
      expect(fromBob?.payload).toBe(payload);
      // alice's own earlier edit is still there too — one stream, not replaced.
      expect(deliveries.some((d) => d.sender === accounts.alice.userId)).toBe(true);

      expect((await fetch(`${bobUrl}/channels/${documentId}/resync-request`)).status).toBe(404);
      expect((await fetch(`${aliceUrl}/channels/${documentId}/resync-requests`)).status).toBe(404);
    });
  },
);
