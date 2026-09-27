import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { type RawTimelineEvent, syncOnce } from "./matrix-api.ts";
import { createLiveServerDependencies, createServer } from "./server.ts";

/**
 * A `hasTestMatrixHomeserver()`-gated live test: confirms `POST /channels/:documentId/invite` sends a genuinely
 * normal, human-readable Matrix message — not one of the
 * `de.wappensc.together.tdsp.*` event types every other bridge route sends.
 * Verified by reading the raw event straight off `/sync` (`matrix-api.ts`'s
 * own `syncOnce`, the same low-level helper `crypto.security.test.ts` uses),
 * exactly the way an ordinary Matrix client (e.g. Element) would see it —
 * `event.type === "m.room.message"` and a plain `body` string, not
 * `de.wappensc.together.tdsp.frame`'s opaque `frame`.
 */
const available = await hasTestMatrixHomeserver();

describe.skipIf(!available)(
  "bridges/matrix-bridge invite message, live against a local Synapse",
  () => {
    let accounts: {
      alice: { userId: string; accessToken: string };
      rooms: { plain: string; encrypted: string };
    };
    let bindStoreDir: string;
    let server: import("node:http").Server;
    let bridgeUrl: string;
    let cryptoClose: () => void;
    const documentId = `doc-live-invite-${Date.now()}`;

    beforeAll(async () => {
      accounts = JSON.parse(readFileSync(TEST_ACCOUNTS_PATH, "utf8"));

      // A fresh login, not accounts.alice.accessToken — see bind.test.ts's
      // own comment on this same fix (createLiveServerDependencies always
      // builds a CryptoMachine, even for a route that only ever sends
      // plaintext, and a fresh local store only matches a device Synapse
      // has no prior one-time-key history for).
      const alice = await loginFresh(accounts.alice.userId, TEST_ACCOUNT_PASSWORD);
      bindStoreDir = mkdtempSync(join(tmpdir(), "matrix-bridge-live-invite-"));
      const bindStorePath = join(bindStoreDir, "tdsp-channels.json");
      const deps = await createLiveServerDependencies(
        { homeserverUrl: BASE_URL, accessToken: alice.accessToken },
        bindStorePath,
      );
      cryptoClose = () => deps.crypto.close();
      server = createServer({
        homeserverUrl: BASE_URL,
        accessToken: alice.accessToken,
        bindStorePath,
        ...deps,
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      bridgeUrl = `http://127.0.0.1:${port}`;

      const bindResponse = await fetch(`${bridgeUrl}/channels/${documentId}/bind`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channelId: accounts.rooms.plain,
          creator: accounts.alice.userId,
          profile: "yjs-paragraphs/1",
        }),
      });
      expect(bindResponse.status).toBe(200);
    });

    afterAll(async () => {
      cryptoClose();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(bindStoreDir, { recursive: true, force: true });
    });

    it("rejects a non-creator actor", async () => {
      const response = await fetch(`${bridgeUrl}/channels/${documentId}/invite`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor: "not-the-creator", text: "join my document!" }),
      });
      expect(response.status).toBe(403);
    });

    it("sends a real, human-readable m.room.message into the bound room", async () => {
      const text = `alice invited you to collaborate on ${documentId}, ${Date.now()}`;
      const response = await fetch(`${bridgeUrl}/channels/${documentId}/invite`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor: accounts.alice.userId, text }),
      });
      expect(response.status).toBe(200);
      // The route answers {deliveryId}, as every bridge's does; on Matrix that is the event id.
      const { deliveryId: eventId } = (await response.json()) as { deliveryId: string };
      expect(eventId).toMatch(/^\$/); // a real Matrix event id

      // Read it back off the raw /sync stream, not through the bridge's
      // own receive() — a plain m.room.message is not one of the
      // de.wappensc.together.tdsp.* types receive() surfaces at all (matches
      // sync-state.ts's own "unrecognized event type ⇒ silently
      // ignored" rule), so this is the only way to observe it, and it
      // is exactly what a real Matrix client would see.
      let since: string | undefined;
      let rawEvent: RawTimelineEvent | undefined;
      for (let attempt = 0; attempt < 15 && !rawEvent; attempt++) {
        const round = await syncOnce(
          { homeserverUrl: BASE_URL, accessToken: accounts.alice.accessToken },
          since,
        );
        since = round.nextBatch;
        rawEvent = round.roomEvents.get(accounts.rooms.plain)?.find((e) => e.event_id === eventId);
        if (!rawEvent) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      if (!rawEvent) {
        throw new Error("the invite message never appeared on /sync");
      }

      expect(rawEvent.type).toBe("m.room.message");
      expect(rawEvent.content).toEqual({ msgtype: "m.text", body: text });
    });
  },
);
