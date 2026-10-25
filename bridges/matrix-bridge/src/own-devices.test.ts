import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// infra/matrix-testserver isn't a pnpm workspace package — see bind.test.ts's own comment on
// this same relative import.
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
 * L2: two devices of one Matrix account, each a bridge of its own, in an encrypted room
 * (bindings/matrix.md §13.3, #31). What one device sends, the other receives as the account's
 * own message: the bridge shares each room key with every device of every member, its own
 * account's other devices included, and filters no sender. Skips cleanly without the test
 * server.
 */
const available = await hasTestMatrixHomeserver();

describe.skipIf(!available)(
  "two devices of one Matrix account, live against a local Synapse",
  () => {
    const documentId = `doc-own-devices-${Date.now()}`;
    let devices: { url: string; server: Server; crypto: CryptoMachine; dir: string }[] = [];
    let alice: string;

    beforeAll(async () => {
      const accounts = JSON.parse(readFileSync(TEST_ACCOUNTS_PATH, "utf8")) as {
        alice: { userId: string };
        rooms: { encrypted: string };
      };
      alice = accounts.alice.userId;
      // Two fresh logins: two devices of alice, each with a crypto store of its own.
      const logins = [
        await loginFresh(alice, TEST_ACCOUNT_PASSWORD),
        await loginFresh(alice, TEST_ACCOUNT_PASSWORD),
      ];
      expect(logins[0]?.deviceId).not.toBe(logins[1]?.deviceId);
      // One after the other, the sending device first: it queries its account's devices before the
      // receiving one has uploaded its keys, and its first /sync reports no change (MTX-4).
      devices = [];
      for (const login of logins) {
        const dir = mkdtempSync(join(tmpdir(), "matrix-own-device-"));
        const bindStorePath = join(dir, "tdsp-channels.json");
        const deps = await createLiveServerDependencies(
          { homeserverUrl: BASE_URL, accessToken: login.accessToken },
          bindStorePath,
        );
        const server = createServer({
          homeserverUrl: BASE_URL,
          accessToken: login.accessToken,
          bindStorePath,
          ...deps,
        });
        await new Promise<void>((resolve) => server.listen(0, resolve));
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        devices.push({ url, server, crypto: deps.crypto, dir });
      }
      for (const device of devices) {
        const bound = await fetch(`${device.url}/channels/${documentId}/bind`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            channelId: accounts.rooms.encrypted,
            creator: alice,
            profile: "yjs-paragraphs/1",
          }),
        });
        expect(bound.status).toBe(200);
        // The first sync sets a baseline only (sync-state.ts), as a bridge's startup does.
        await fetch(`${device.url}/channels/${documentId}/deliveries`);
      }
    });

    afterAll(async () => {
      for (const device of devices) {
        device.crypto.close();
        await new Promise<void>((resolve) => device.server.close(() => resolve()));
        rmSync(device.dir, { recursive: true, force: true });
      }
    });

    it("what one device sends in an encrypted room, the other device of the account receives", async () => {
      const [laptop, phone] = devices as [(typeof devices)[0], (typeof devices)[0]];
      const plaintext = `from alice's laptop, ${Date.now()}`;
      const sent = await fetch(`${laptop.url}/channels/${documentId}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sender: alice, payload: btoa(plaintext) }),
      });
      expect(sent.status).toBe(200);
      const { deliveryId } = (await sent.json()) as { deliveryId: string };

      let received: { id: string; sender: string; payload: string }[] = [];
      for (let attempt = 0; attempt < 20 && received.length === 0; attempt++) {
        received = (await (
          await fetch(`${phone.url}/channels/${documentId}/deliveries`)
        ).json()) as typeof received;
        if (received.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      expect(received).toHaveLength(1);
      expect(received[0]?.id).toBe(deliveryId);
      expect(received[0]?.sender).toBe(alice);
      expect(atob(received[0]?.payload ?? "")).toBe(plaintext);
    });
  },
);
