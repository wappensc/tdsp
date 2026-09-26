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
import { ATTACHMENT_FRAME_LIMIT, BODY_FRAME_LIMIT, sha256Hex } from "./attachment.ts";
import type { CryptoMachine } from "./crypto-machine.ts";
import { type MatrixApiConfig, sendEvent, uploadMedia } from "./matrix-api.ts";
import { createLiveServerDependencies, createServer } from "./server.ts";

/**
 * Attachments (SPECIFICATION.md §13.3), live against a local Synapse: a frame too large for an event body goes
 * up as a media file and the event carries a reference, and the other bridge downloads it, checks it
 * and hands it on as an ordinary delivery — in an ordinary room and in an encrypted one, where the
 * file is encrypted before it leaves and its key travels only inside the Megolm-encrypted event.
 *
 * Two real bridge servers, one per account, bound to the provisioned fixture rooms (one ordinary,
 * one encrypted; both accounts are already members). No room is created and nobody is invited:
 * Synapse's own invite limiter allows a handful and then one in several minutes, and a test that
 * spends them makes every other suite's next run fail with 429 (docs/testing.md). Every
 * case binds a `documentId` of its own, and a bridge only ever hands a document its own events, so
 * the cases do not see each other's messages, nor those of the suites sharing the same rooms.
 */
const available = await hasTestMatrixHomeserver();

const bytesOf = (length: number, seed: number): Uint8Array =>
  // Printable ASCII — the UTF-8 bytes of a frame's text — hard to compress, and different per
  // seed, so a swap between two frames would show.
  Uint8Array.from({ length }, (_, i) => 32 + (((i * 2654435761 + seed * 40503) >>> 24) % 95));
const textOf = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

// Real round trips through a shared Synapse: the 5-second default is too tight when the machine is busy.
describe.skipIf(!available)(
  "matrix-bridge attachments, live against a local Synapse",
  { timeout: 30_000 },
  () => {
    let accounts: {
      alice: { userId: string };
      bob: { userId: string };
      rooms: { plain: string; encrypted: string };
    };
    let aliceLogin: { userId: string; accessToken: string };
    let bobLogin: { userId: string; accessToken: string };
    let aliceDir: string;
    let bobDir: string;
    let aliceServer: Server;
    let bobServer: Server;
    let aliceUrl: string;
    let bobUrl: string;
    let aliceCrypto: CryptoMachine;
    let bobCrypto: CryptoMachine;
    let aliceConfig: MatrixApiConfig;
    let documents = 0;

    beforeAll(async () => {
      accounts = JSON.parse(readFileSync(TEST_ACCOUNTS_PATH, "utf8"));
      aliceDir = mkdtempSync(join(tmpdir(), "matrix-bridge-attach-alice-"));
      bobDir = mkdtempSync(join(tmpdir(), "matrix-bridge-attach-bob-"));
      [aliceLogin, bobLogin] = await Promise.all([
        loginFresh(accounts.alice.userId, TEST_ACCOUNT_PASSWORD),
        loginFresh(accounts.bob.userId, TEST_ACCOUNT_PASSWORD),
      ]);
      aliceConfig = { homeserverUrl: BASE_URL, accessToken: aliceLogin.accessToken };
      const aliceStore = join(aliceDir, "tdsp-channels.json");
      const bobStore = join(bobDir, "tdsp-channels.json");
      const [aliceDeps, bobDeps] = await Promise.all([
        createLiveServerDependencies(aliceConfig, aliceStore),
        createLiveServerDependencies(
          { homeserverUrl: BASE_URL, accessToken: bobLogin.accessToken },
          bobStore,
        ),
      ]);
      aliceCrypto = aliceDeps.crypto;
      bobCrypto = bobDeps.crypto;
      aliceServer = createServer({
        homeserverUrl: BASE_URL,
        accessToken: aliceLogin.accessToken,
        bindStorePath: aliceStore,
        ...aliceDeps,
      });
      bobServer = createServer({
        homeserverUrl: BASE_URL,
        accessToken: bobLogin.accessToken,
        bindStorePath: bobStore,
        ...bobDeps,
      });
      await Promise.all([
        new Promise<void>((resolve) => aliceServer.listen(0, resolve)),
        new Promise<void>((resolve) => bobServer.listen(0, resolve)),
      ]);
      aliceUrl = `http://127.0.0.1:${(aliceServer.address() as AddressInfo).port}`;
      bobUrl = `http://127.0.0.1:${(bobServer.address() as AddressInfo).port}`;
    }, 30_000);

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

    /** A document of its own, bound to `roomId` on both bridges, with both sync states primed. */
    async function freshDocument(roomId: string): Promise<{ roomId: string; documentId: string }> {
      documents += 1;
      const documentId = `doc-attach-${documents}-${Date.now()}`;
      for (const url of [aliceUrl, bobUrl]) {
        const bind = await fetch(`${url}/channels/${documentId}/bind`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            channelId: roomId,
            creator: aliceLogin.userId,
            profile: "yjs-paragraphs/1",
          }),
        });
        expect(bind.status, await bind.clone().text()).toBe(200);
      }
      await Promise.all([
        fetch(`${aliceUrl}/channels/${documentId}/deliveries`),
        fetch(`${bobUrl}/channels/${documentId}/deliveries`),
      ]);
      return { roomId, documentId };
    }

    const send = (documentId: string, bytes: Uint8Array) =>
      fetch(`${aliceUrl}/channels/${documentId}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sender: aliceLogin.userId, payload: textOf(bytes) }),
      });

    /** Polls bob's bridge until `count` deliveries are there, or gives up after about 15 seconds. */
    async function bobDeliveries(documentId: string, count: number) {
      let deliveries: { id: string; sender: string; payload: string }[] = [];
      for (let attempt = 0; attempt < 75 && deliveries.length < count; attempt += 1) {
        const response = await fetch(`${bobUrl}/channels/${documentId}/deliveries`);
        expect(response.status).toBe(200);
        deliveries = (await response.json()) as typeof deliveries;
        if (deliveries.length < count) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      return deliveries;
    }

    for (const encrypted of [false, true]) {
      describe(encrypted ? "in an encrypted room" : "in an ordinary room", () => {
        it("carries a frame over the body limit as a media file, byte for byte", async () => {
          const { documentId } = await freshDocument(
            encrypted ? accounts.rooms.encrypted : accounts.rooms.plain,
          );
          const frame = bytesOf(100_000, 1);
          const response = await send(documentId, frame);
          expect(response.status, await response.clone().text()).toBe(200);
          const [delivery] = await bobDeliveries(documentId, 1);
          expect(delivery?.sender).toBe(aliceLogin.userId);
          expect(delivery?.payload).toBe(textOf(frame));
        });

        it("keeps the body for a frame at the limit and uses a file one byte over it", async () => {
          const { documentId } = await freshDocument(
            encrypted ? accounts.rooms.encrypted : accounts.rooms.plain,
          );
          const atLimit = bytesOf(BODY_FRAME_LIMIT, 2);
          const overLimit = bytesOf(BODY_FRAME_LIMIT + 1, 3);
          expect((await send(documentId, atLimit)).status).toBe(200);
          expect((await send(documentId, overLimit)).status).toBe(200);
          const deliveries = await bobDeliveries(documentId, 2);
          expect(deliveries.map((d) => d.payload).sort()).toEqual(
            [textOf(atLimit), textOf(overLimit)].sort(),
          );
        });

        it("carries a frame at the bridge's own bound, and refuses one over it with a too-large status", async () => {
          const { documentId } = await freshDocument(
            encrypted ? accounts.rooms.encrypted : accounts.rooms.plain,
          );
          const atBound = bytesOf(ATTACHMENT_FRAME_LIMIT, 4);
          const response = await send(documentId, atBound);
          expect(response.status, await response.clone().text()).toBe(200);
          const [delivery] = await bobDeliveries(documentId, 1);
          expect(delivery?.payload.length).toBe(textOf(atBound).length);
          expect(delivery?.payload).toBe(textOf(atBound));

          const over = await send(documentId, bytesOf(ATTACHMENT_FRAME_LIMIT + 1, 5));
          expect(over.status).toBe(413);
        });
      });
    }

    it("refuses an attachment whose hash is not the file's, and goes on to deliver what comes after it", async () => {
      const { roomId, documentId } = await freshDocument(accounts.rooms.plain);
      const real = bytesOf(50_000, 6);
      const { contentUri } = await uploadMedia(aliceConfig, real);
      // The event vouches for a different file: a swapped or altered upload.
      await sendEvent(aliceConfig, roomId, "de.wappensc.together.tdsp.frame", {
        tdsp: 1,
        documentId,
        attachment: {
          url: contentUri,
          size: real.length,
          sha256: sha256Hex(bytesOf(50_000, 7)),
        },
      });
      const good = bytesOf(60_000, 8);
      expect((await send(documentId, good)).status).toBe(200);
      const deliveries = await bobDeliveries(documentId, 1);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]?.payload).toBe(textOf(good)); // only the honest one
    });

    it("refuses an attachment whose size is not what the event said", async () => {
      const { roomId, documentId } = await freshDocument(accounts.rooms.plain);
      const real = bytesOf(50_000, 9);
      const { contentUri } = await uploadMedia(aliceConfig, real);
      await sendEvent(aliceConfig, roomId, "de.wappensc.together.tdsp.frame", {
        tdsp: 1,
        documentId,
        attachment: { url: contentUri, size: 49_999, sha256: sha256Hex(real) },
      });
      const good = bytesOf(40_000, 10);
      expect((await send(documentId, good)).status).toBe(200);
      const deliveries = await bobDeliveries(documentId, 1);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]?.payload).toBe(textOf(good));
    });

    it("skips an attachment that is not there, without stopping the poll or losing what follows", async () => {
      const { roomId, documentId } = await freshDocument(accounts.rooms.plain);
      await sendEvent(aliceConfig, roomId, "de.wappensc.together.tdsp.frame", {
        tdsp: 1,
        documentId,
        attachment: {
          url: "mxc://tdsp.test/doesnotexistanywhere",
          size: 1000,
          sha256: sha256Hex(new Uint8Array(1000)),
        },
      });
      const good = bytesOf(45_000, 11);
      expect((await send(documentId, good)).status).toBe(200);
      const deliveries = await bobDeliveries(documentId, 1);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]?.payload).toBe(textOf(good));
    });

    it("ignores an event that is malformed: not an mxc URI, a size over the bound, both a frame and a file", async () => {
      const { roomId, documentId } = await freshDocument(accounts.rooms.plain);
      const sha = sha256Hex(new Uint8Array(10));
      for (const attachment of [
        { url: "http://example.com/x", size: 10, sha256: sha },
        { url: "mxc://tdsp.test/x/../../y", size: 10, sha256: sha },
        { url: "mxc://tdsp.test/x", size: ATTACHMENT_FRAME_LIMIT + 1, sha256: sha },
        { url: "mxc://tdsp.test/x", size: -1, sha256: sha },
        { url: "mxc://tdsp.test/x", size: 10, sha256: "short" },
      ]) {
        await sendEvent(aliceConfig, roomId, "de.wappensc.together.tdsp.frame", {
          tdsp: 1,
          documentId,
          attachment,
        });
      }
      await sendEvent(aliceConfig, roomId, "de.wappensc.together.tdsp.frame", {
        tdsp: 1,
        documentId,
        frame: "AAAA",
        attachment: { url: "mxc://tdsp.test/x", size: 10, sha256: sha },
      });
      const good = bytesOf(41_000, 12);
      expect((await send(documentId, good)).status).toBe(200);
      const deliveries = await bobDeliveries(documentId, 1);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]?.payload).toBe(textOf(good));
    });
  },
);
