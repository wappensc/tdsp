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
import { createRoom } from "../../../infra/matrix-testserver/create-room.ts";
import { hasTestMatrixHomeserver } from "../../../infra/matrix-testserver/health.ts";
import { loginFresh } from "../../../infra/matrix-testserver/login.ts";
import { registerAccount } from "../../../infra/matrix-testserver/register.ts";
import type { CryptoMachine } from "./crypto-machine.ts";
import { createCryptoMachine } from "./crypto-machine.ts";
import { type MatrixApiConfig, type RawTimelineEvent, sendEvent, syncOnce } from "./matrix-api.ts";
import { createLiveServerDependencies, createServer } from "./server.ts";

/**
 * Live tests of the two properties of end-to-end encryption in a Matrix room
 * that matter to this bridge (SPECIFICATION.md §13.3):
 *
 * 1. The history caveat ("a newly joined member cannot decrypt Megolm-
 *    encrypted messages sent before they joined") — a real third
 *    account ("carol") joins a fresh test room only *after* a real
 *    encrypted message already sits in it, proving via an actual failed
 *    `decryptRoomEvent` call (not argued in prose) that she cannot
 *    recover it, and via a second, real encrypted message sent *after*
 *    she joined that she *can* decrypt once included in the next
 *    room-key share.
 * 2. Crypto-store persistence surviving a real restart: a
 *    `CryptoMachine` closed and re-created against the same `storePath`
 *    can still decrypt a message whose key it received before that
 *    restart, using only the persisted local store.
 *
 * Both talk to `crypto-machine.ts` directly (not through a full bridge
 * server, for carol/bob/the post-restart alice) so these tests observe
 * the exact claim — a decrypt outcome — without `sync-state.ts`'s own
 * first-poll baseline discard (a *different*, already-covered behavior —
 * see that module's own doc comment) folding it together with something
 * else. The history-caveat test's alice side still goes through the
 * real bridge server, exactly like `send-receive.test.ts`, since that's
 * what actually produces the real `m.room.encrypted` events on the wire.
 */
const available = await hasTestMatrixHomeserver();

/** Polls once, feeds the round into `crypto` unconditionally (matching `sync-state.ts`'s own "every poll, including empty ones" discipline), and returns it alongside the advanced `since` token. */
async function pollAndFeed(
  config: MatrixApiConfig,
  since: string | undefined,
  crypto: CryptoMachine,
): Promise<{ since: string; roomEvents: ReadonlyMap<string, readonly RawTimelineEvent[]> }> {
  const round = await syncOnce(config, since);
  await crypto.receiveSync(
    round.toDeviceEvents,
    round.deviceListsChanged,
    round.deviceListsLeft,
    round.oneTimeKeyCounts,
  );
  return { since: round.nextBatch, roomEvents: round.roomEvents };
}

describe.skipIf(!available)(
  "bridges/matrix-bridge crypto-machine, history caveat live against a local Synapse",
  () => {
    let accounts: {
      alice: { userId: string; accessToken: string };
      bob: { userId: string; accessToken: string };
      rooms: { plain: string; encrypted: string };
    };
    let aliceDir: string;
    let carolStoreDir: string;
    let aliceServer: Server;
    let aliceUrl: string;
    let aliceCryptoClose: () => void;
    let carolConfig: MatrixApiConfig;
    let carolUserId: string;
    const documentId = `doc-live-history-${Date.now()}`;
    let encryptedRoomId: string;

    beforeAll(async () => {
      accounts = JSON.parse(readFileSync(TEST_ACCOUNTS_PATH, "utf8"));

      // "carol" is a fixed test username (registerAccount tolerates
      // already-registered, same idempotency as alice/bob's own
      // provisioning) but always gets a *fresh* login/device here — the
      // same fresh-device pattern every other crypto-machine-using test
      // file uses, and required here for an extra reason: carol must be
      // a genuinely new device with no prior key-share history for the
      // "cannot decrypt what predates joining" half of this test to mean
      // anything.
      await registerAccount("carol");
      const carolLogin = await loginFresh("carol", TEST_ACCOUNT_PASSWORD);
      carolUserId = carolLogin.userId;
      carolConfig = { homeserverUrl: BASE_URL, accessToken: carolLogin.accessToken };

      const aliceLogin = await loginFresh(accounts.alice.userId, TEST_ACCOUNT_PASSWORD);

      // A fresh, disposable room every run — not test-accounts.json's own
      // `rooms.encrypted` fixture. That fixture's membership persists on
      // the test server's volume across runs (bob, and any "carol" from
      // a previous run of *this* test), which this test cannot tolerate:
      // re-inviting an already-joined carol is refused with 403, and "carol already a member" would silently defeat the
      // whole "joins after message 1 exists" premise even when the
      // invite happens to succeed.
      encryptedRoomId = await createRoom(
        aliceLogin.accessToken,
        true,
        `tdsp history-caveat test room ${Date.now()}`,
      );

      aliceDir = mkdtempSync(join(tmpdir(), "matrix-bridge-alice-history-"));
      const aliceBindStorePath = join(aliceDir, "tdsp-channels.json");
      const aliceDeps = await createLiveServerDependencies(
        { homeserverUrl: BASE_URL, accessToken: aliceLogin.accessToken },
        aliceBindStorePath,
      );
      aliceCryptoClose = () => aliceDeps.crypto.close();
      aliceServer = createServer({
        homeserverUrl: BASE_URL,
        accessToken: aliceLogin.accessToken,
        bindStorePath: aliceBindStorePath,
        ...aliceDeps,
      });
      await new Promise<void>((resolve) => aliceServer.listen(0, resolve));
      aliceUrl = `http://127.0.0.1:${(aliceServer.address() as AddressInfo).port}`;

      const bindResponse = await fetch(`${aliceUrl}/channels/${documentId}/bind`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channelId: encryptedRoomId,
          creator: accounts.alice.userId,
          profile: "yjs-paragraphs/1",
        }),
      });
      expect(bindResponse.status).toBe(200);

      // Prime alice's own sync baseline before anything this suite cares
      // about, matching send-receive.test.ts's own established pattern.
      await fetch(`${aliceUrl}/channels/${documentId}/deliveries`);

      carolStoreDir = mkdtempSync(join(tmpdir(), "matrix-bridge-carol-crypto-"));
    });

    afterAll(async () => {
      aliceCryptoClose();
      await new Promise<void>((resolve, reject) =>
        aliceServer.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(aliceDir, { recursive: true, force: true });
      rmSync(carolStoreDir, { recursive: true, force: true });
    });

    /**
     * A frame up to 32 000 bytes rides in the event body (SPECIFICATION.md §13.3). In an *encrypted* room the
     * frame is Base64-encoded into the event, the event is Megolm-encrypted, and the ciphertext is
     * Base64-encoded again — Synapse refuses an event over 65 536 bytes, so 32 000 is the number
     * that has to hold. This sends a frame of exactly that, to see the margin for real rather than
     * argue it. A larger one goes up as an encrypted media file instead (`attachments.test.ts`
     * carries it end to end); here only that the sender accepts it, and refuses one over the bridge's
     * own stated bound with a too-large status.
     */
    it("carries a frame of 32 000 bytes in the body of an encrypted room, a larger one as an attachment, and refuses one over the bound", async () => {
      const send = async (bytes: number) =>
        fetch(`${aliceUrl}/channels/${documentId}/send`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sender: "@alice:tdsp.test",
            // Not compressible, so the size on the wire is the size claimed.
            payload: Buffer.from(
              Uint8Array.from({ length: bytes }, (_, i) => (i * 2654435761) >>> 24),
            ).toString("base64"),
          }),
        });
      const atTheBodyLimit = await send(32_000);
      expect(atTheBodyLimit.status, await atTheBodyLimit.clone().text()).toBe(200);
      const overTheBodyLimit = await send(60_000);
      expect(overTheBodyLimit.status, await overTheBodyLimit.clone().text()).toBe(200);
      const overTheBound = await send(4 * 1024 * 1024 + 1);
      expect(overTheBound.status).toBe(413);
    }, 30000);

    it("carol cannot decrypt a message sent before she joined, but can decrypt one sent after", async () => {
      // --- Message 1: sent while carol is not yet a room member. ---
      const plaintext1 = `before carol joins, ${Date.now()}`;
      const send1 = await fetch(`${aliceUrl}/channels/${documentId}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sender: accounts.alice.userId, payload: btoa(plaintext1) }),
      });
      expect(send1.status).toBe(200);
      const { deliveryId: eventId1 } = (await send1.json()) as { deliveryId: string };

      // --- Carol joins the room only now, after message 1 already exists. ---
      const inviteResponse = await fetch(
        `${BASE_URL}/_matrix/client/v3/rooms/${encodeURIComponent(encryptedRoomId)}/invite`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${accounts.alice.accessToken}`,
          },
          body: JSON.stringify({ user_id: carolUserId }),
        },
      );
      expect(inviteResponse.status).toBe(200);
      const joinResponse = await fetch(
        `${BASE_URL}/_matrix/client/v3/join/${encodeURIComponent(encryptedRoomId)}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${carolConfig.accessToken}`,
          },
          body: "{}",
        },
      );
      expect(joinResponse.status).toBe(200);

      const carolCrypto = await createCryptoMachine(carolConfig, carolStoreDir);
      try {
        // Carol's own /sync: Synapse's default "shared" history
        // visibility means she can see message 1's ciphertext event
        // even though it predates her join — but seeing the ciphertext
        // is not the same as having the Megolm key for it. Retried,
        // not assumed instant: a real network round trip.
        let since: string | undefined;
        let rawEvent1: RawTimelineEvent | undefined;
        for (let attempt = 0; attempt < 15 && !rawEvent1; attempt++) {
          const round = await pollAndFeed(carolConfig, since, carolCrypto);
          since = round.since;
          rawEvent1 = round.roomEvents.get(encryptedRoomId)?.find((e) => e.event_id === eventId1);
          if (!rawEvent1) {
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        }
        if (!rawEvent1) {
          throw new Error("carol's /sync never surfaced message 1's ciphertext event");
        }

        const decrypted1 = await carolCrypto.decryptRoomEvent(rawEvent1, encryptedRoomId);
        expect(decrypted1.ok, "carol decrypted a message sent before she joined").toBe(false);

        // --- Message 2: sent after carol has joined. Alice's bridge
        // re-fetches joined members on every send (server.ts's own doc
        // comment), so this share includes carol for the first time. ---
        const plaintext2 = `after carol joins, ${Date.now()}`;
        const send2 = await fetch(`${aliceUrl}/channels/${documentId}/send`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sender: accounts.alice.userId, payload: btoa(plaintext2) }),
        });
        expect(send2.status).toBe(200);
        const { deliveryId: eventId2 } = (await send2.json()) as { deliveryId: string };

        // Carol polls again for both the ciphertext event and the
        // to-device room-key share carrying its Megolm key.
        let rawEvent2: RawTimelineEvent | undefined;
        for (let attempt = 0; attempt < 15 && !rawEvent2; attempt++) {
          const round = await pollAndFeed(carolConfig, since, carolCrypto);
          since = round.since;
          rawEvent2 = round.roomEvents.get(encryptedRoomId)?.find((e) => e.event_id === eventId2);
          if (!rawEvent2) {
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        }
        if (!rawEvent2) {
          throw new Error("carol's /sync never surfaced message 2's ciphertext event");
        }

        const decrypted2 = await carolCrypto.decryptRoomEvent(rawEvent2, encryptedRoomId);
        expect(decrypted2.ok, "carol failed to decrypt a message sent after she joined").toBe(true);
        if (decrypted2.ok) {
          const content = decrypted2.content as { frame: string };
          expect(atob(content.frame)).toBe(plaintext2);
        }
      } finally {
        carolCrypto.close();
      }
    }, 30000);

    /**
     * The crypto store survives a restart, distinct from the history-caveat
     * test above: a `CryptoMachine` closed and re-created
     * against the same `storePath` (simulating a real bridge process
     * restart) can still decrypt a message whose room key it received
     * *before* the restart, using only the persisted local store, no new
     * key exchange. A successful decrypt here is only possible if the
     * restart genuinely reloaded the same Megolm session state rather
     * than starting fresh — this is the load-bearing assertion, not a
     * separate identity-key comparison.
     *
     * The invite/join responses are asserted explicitly (unlike this
     * file's other test): many repeated runs of this file in a short time
     * trip Synapse's own default invite rate limiter (`M_LIMIT_EXCEEDED`, several
     * minutes' `retry_after_ms`), which a bare unchecked `fetch()`
     * turned into a much more confusing later failure (a `send()` 403
     * "not in room"). A single real `pnpm run ci` pass sends only two
     * invites total across this whole file, far below that limit —
     * `pnpm run matrix:reset` clears an already-tripped limit instantly
     * if heavy local iteration ever hits it again.
     */
    it("a crypto machine restart (same storePath) still decrypts a message received before it", async () => {
      const restartAliceLogin = await loginFresh(accounts.alice.userId, TEST_ACCOUNT_PASSWORD);
      const restartBobLogin = await loginFresh(accounts.bob.userId, TEST_ACCOUNT_PASSWORD);
      const restartAliceConfig: MatrixApiConfig = {
        homeserverUrl: BASE_URL,
        accessToken: restartAliceLogin.accessToken,
      };
      const restartBobConfig: MatrixApiConfig = {
        homeserverUrl: BASE_URL,
        accessToken: restartBobLogin.accessToken,
      };

      const restartRoomId = await createRoom(
        restartAliceLogin.accessToken,
        true,
        `tdsp restart test room ${Date.now()}`,
      );
      const restartInviteResponse = await fetch(
        `${BASE_URL}/_matrix/client/v3/rooms/${encodeURIComponent(restartRoomId)}/invite`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${restartAliceLogin.accessToken}`,
          },
          body: JSON.stringify({ user_id: restartBobLogin.userId }),
        },
      );
      expect(restartInviteResponse.status, await restartInviteResponse.clone().text()).toBe(200);
      const restartJoinResponse = await fetch(
        `${BASE_URL}/_matrix/client/v3/join/${encodeURIComponent(restartRoomId)}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${restartBobLogin.accessToken}`,
          },
          body: "{}",
        },
      );
      expect(restartJoinResponse.status, await restartJoinResponse.clone().text()).toBe(200);

      const aliceStoreDir = mkdtempSync(join(tmpdir(), "matrix-bridge-alice-restart-"));
      const bobStoreDir = mkdtempSync(join(tmpdir(), "matrix-bridge-bob-restart-"));
      try {
        // Same restartAliceConfig (same access token, same device) used
        // both before and after the "restart" — an actual new device
        // would defeat the point of this test, same as the history-
        // caveat test's own carol needing the opposite (a genuinely
        // fresh device).
        const aliceCrypto1 = await createCryptoMachine(restartAliceConfig, aliceStoreDir);
        const bobCrypto = await createCryptoMachine(restartBobConfig, bobStoreDir);
        try {
          const plaintext = `restart survives, ${Date.now()}`;
          await bobCrypto.ensureRoomKeyShared(restartRoomId, [
            restartAliceLogin.userId,
            restartBobLogin.userId,
          ]);
          const encrypted = await bobCrypto.encryptRoomEvent(
            restartRoomId,
            "de.wappensc.together.tdsp.frame",
            {
              tdsp: 1,
              documentId: "doc-restart-test",
              frame: btoa(plaintext),
            },
          );
          const { eventId } = await sendEvent(
            restartBobConfig,
            restartRoomId,
            "m.room.encrypted",
            encrypted,
          );

          let since: string | undefined;
          let rawEvent: RawTimelineEvent | undefined;
          for (let attempt = 0; attempt < 15 && !rawEvent; attempt++) {
            const round = await pollAndFeed(restartAliceConfig, since, aliceCrypto1);
            since = round.since;
            rawEvent = round.roomEvents.get(restartRoomId)?.find((e) => e.event_id === eventId);
            if (!rawEvent) {
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
          }
          if (!rawEvent) {
            throw new Error("alice's /sync never surfaced the restart-test ciphertext event");
          }

          // Sanity check pre-restart: decryption works at all before we
          // claim the restart preserved anything.
          const preRestart = await aliceCrypto1.decryptRoomEvent(rawEvent, restartRoomId);
          expect(preRestart.ok, "alice failed to decrypt before any restart").toBe(true);

          // --- The restart: close, then re-create against the same storePath. ---
          aliceCrypto1.close();
          const aliceCrypto2 = await createCryptoMachine(restartAliceConfig, aliceStoreDir);
          try {
            const postRestart = await aliceCrypto2.decryptRoomEvent(rawEvent, restartRoomId);
            expect(
              postRestart.ok,
              "alice could not decrypt the same message after a simulated restart",
            ).toBe(true);
            if (postRestart.ok) {
              const content = postRestart.content as { frame: string };
              expect(atob(content.frame)).toBe(plaintext);
            }
          } finally {
            aliceCrypto2.close();
          }
        } finally {
          bobCrypto.close();
        }
      } finally {
        rmSync(aliceStoreDir, { recursive: true, force: true });
        rmSync(bobStoreDir, { recursive: true, force: true });
      }
    }, 30000);
  },
);
