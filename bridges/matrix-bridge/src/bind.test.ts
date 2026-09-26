import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
// infra/matrix-testserver isn't a pnpm workspace package (it is test
// infrastructure, not shipped code), hence the relative import rather than
// a package specifier. Reuses its health/account helpers rather than
// reimplementing a second "is Synapse up" check.
import {
  BASE_URL,
  TEST_ACCOUNT_PASSWORD,
  TEST_ACCOUNTS_PATH,
} from "../../../infra/matrix-testserver/config.ts";
import { hasTestMatrixHomeserver } from "../../../infra/matrix-testserver/health.ts";
import { loginFresh } from "../../../infra/matrix-testserver/login.ts";
import type { BindStoreData } from "./bind-store.ts";
import { createLiveServerDependencies, createMatrixRoomReader, createServer } from "./server.ts";

/**
 * The real, `hasTestMatrixHomeserver()`-gated counterpart to
 * `server.test.ts`'s fake-backed suite — exercises `createMatrixRoomReader`
 * (real `fetch()` calls, `bridges/matrix-bridge/src/matrix-api.ts`) and the
 * full bridge server together against a real local Synapse, using
 * alice's real provisioned account and the real "plain"/"encrypted" test
 * rooms `provision-test-accounts.ts` already sets up. Skips cleanly
 * (not red) wherever the test server isn't running, the same pattern
 * `infra/matrix-testserver/matrix-testserver.test.ts` itself uses.
 */
const available = await hasTestMatrixHomeserver();

describe.skipIf(!available)("bridges/matrix-bridge bind flow, live against a local Synapse", () => {
  let accounts: {
    alice: { userId: string; accessToken: string };
    bob: { userId: string; accessToken: string };
    rooms: { plain: string; encrypted: string };
  };

  beforeAll(() => {
    accounts = JSON.parse(readFileSync(TEST_ACCOUNTS_PATH, "utf8"));
  });

  it("createMatrixRoomReader lists the real joined rooms with correct name/encryption status", async () => {
    const reader = createMatrixRoomReader({
      homeserverUrl: BASE_URL,
      accessToken: accounts.alice.accessToken,
    });
    const summaries = await reader.listJoinedRoomSummaries();
    const roomIds = summaries.map((s) => s.id);
    expect(roomIds).toContain(accounts.rooms.plain);
    expect(roomIds).toContain(accounts.rooms.encrypted);

    const plain = summaries.find((s) => s.id === accounts.rooms.plain);
    const encrypted = summaries.find((s) => s.id === accounts.rooms.encrypted);
    expect(plain?.encrypted).toBe(false);
    expect(encrypted?.encrypted).toBe(true);
  });

  it("createMatrixRoomReader.isJoinedMember is true for a real joined room and false for a made-up one", async () => {
    const reader = createMatrixRoomReader({
      homeserverUrl: BASE_URL,
      accessToken: accounts.alice.accessToken,
    });
    expect(await reader.isJoinedMember(accounts.rooms.plain)).toBe(true);
    expect(await reader.isJoinedMember("!not-a-real-room:tdsp.test")).toBe(false);
  });

  it("the full bridge server binds a document to a real room end to end", async () => {
    const bindStoreDir = mkdtempSync(join(tmpdir(), "matrix-bridge-live-bind-"));
    const bindStorePath = join(bindStoreDir, "tdsp-channels.json");
    try {
      // A fresh login, not accounts.alice.accessToken: createLiveServerDependencies
      // builds a CryptoMachine backed by a brand-new (temp-dir) local
      // store every test run, which only matches a device Synapse has
      // no prior one-time-key history for — see login.ts's own doc
      // comment for the live-confirmed collision this avoids.
      const alice = await loginFresh(accounts.alice.userId, TEST_ACCOUNT_PASSWORD);
      const deps = await createLiveServerDependencies(
        { homeserverUrl: BASE_URL, accessToken: alice.accessToken },
        bindStorePath,
      );
      const server = createServer({
        homeserverUrl: BASE_URL,
        accessToken: alice.accessToken,
        bindStorePath,
        ...deps,
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const bridgeUrl = `http://127.0.0.1:${port}`;

      try {
        const roomsResponse = await fetch(`${bridgeUrl}/channels`);
        expect(roomsResponse.status).toBe(200);
        const roomList = (await roomsResponse.json()) as { id: string }[];
        expect(roomList.some((r) => r.id === accounts.rooms.plain)).toBe(true);

        const bindResponse = await fetch(`${bridgeUrl}/channels/doc-live-1/bind`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            channelId: accounts.rooms.plain,
            creator: accounts.alice.userId,
            profile: "yjs-paragraphs/1",
          }),
        });
        expect(bindResponse.status).toBe(200);

        const stored = JSON.parse(readFileSync(bindStorePath, "utf8")) as BindStoreData;
        expect(stored["doc-live-1"]).toMatchObject({
          roomId: accounts.rooms.plain,
          creatorMemberId: accounts.alice.userId,
          profile: "yjs-paragraphs/1",
        });

        const rejectResponse = await fetch(`${bridgeUrl}/channels/doc-live-2/bind`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            channelId: "!not-a-real-room:tdsp.test",
            creator: accounts.alice.userId,
            profile: "yjs-paragraphs/1",
          }),
        });
        expect(rejectResponse.status).toBe(404);
      } finally {
        deps.crypto.close();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    } finally {
      rmSync(bindStoreDir, { recursive: true, force: true });
    }
  });
});
