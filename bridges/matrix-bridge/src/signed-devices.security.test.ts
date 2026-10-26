import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeviceId,
  EncryptionSettings,
  KeysClaimRequest,
  KeysQueryRequest,
  KeysUploadRequest,
  OlmMachine,
  RoomId,
  ToDeviceRequest,
  UserId,
} from "@matrix-org/matrix-sdk-crypto-nodejs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BASE_URL,
  TEST_ACCOUNT_PASSWORD,
  TEST_ACCOUNTS_PATH,
} from "../../../infra/matrix-testserver/config.ts";
import { createRoom } from "../../../infra/matrix-testserver/create-room.ts";
import {
  signTestDevice,
  type TestIdentity,
} from "../../../infra/matrix-testserver/cross-signing.ts";
import { hasTestMatrixHomeserver } from "../../../infra/matrix-testserver/health.ts";
import { loginFresh } from "../../../infra/matrix-testserver/login.ts";
import type { LiveCryptoMachine } from "./crypto-machine.ts";
import { createLiveServerDependencies, createServer } from "./server.ts";

/**
 * L2, live against a local Synapse: an encrypted room's frames come only from devices their
 * owners signed (bindings/matrix.md MTX-4). A homeserver can add a device to any account; frames
 * from it would let it write as any member. A bridge whose own device is unsigned does not send
 * into such a room; a frame from an unsigned device is not delivered, also by a bridge that has
 * never sent to the room and so never asked about the sender's devices. Sharing room keys only
 * with signed devices is not built (CONFORMANCE.md), so it is not tested here. Depends only on the
 * code it tests, the crypto library it is built on, the test server's helpers, and this file.
 * Skips cleanly without the test server.
 */
const available = await hasTestMatrixHomeserver();

type Login = { userId: string; accessToken: string; deviceId: string };

async function call(token: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

/** Sends `frame` into `roomId` as a TDSP event, encrypted by a device the bridge never touched. */
async function sendFromRawDevice(
  login: Login,
  roomId: string,
  members: readonly string[],
  documentId: string,
  frame: string,
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "signed-devices-raw-"));
  const machine = await OlmMachine.initialize(
    new UserId(login.userId),
    new DeviceId(login.deviceId),
    dir,
    "test",
    0,
  );
  try {
    const pump = async () => {
      for (let round = 0; round < 10; round++) {
        const requests = await machine.outgoingRequests();
        if (requests.length === 0) {
          return;
        }
        for (const request of requests) {
          const response =
            request instanceof KeysUploadRequest
              ? await call(
                  login.accessToken,
                  "POST",
                  "/_matrix/client/v3/keys/upload",
                  request.body,
                )
              : request instanceof KeysQueryRequest
                ? await call(
                    login.accessToken,
                    "POST",
                    "/_matrix/client/v3/keys/query",
                    request.body,
                  )
                : request instanceof KeysClaimRequest
                  ? await call(
                      login.accessToken,
                      "POST",
                      "/_matrix/client/v3/keys/claim",
                      request.body,
                    )
                  : request instanceof ToDeviceRequest
                    ? await call(
                        login.accessToken,
                        "PUT",
                        `/_matrix/client/v3/sendToDevice/${request.eventType}/${request.txnId}`,
                        request.body,
                      )
                    : undefined;
          if (response !== undefined) {
            await machine.markRequestAsSent(request.id, request.type, response.text);
          }
        }
      }
    };
    const ids = members.map((id) => new UserId(id));
    await pump();
    await machine.updateTrackedUsers(ids);
    await pump();
    const missing = await machine.getMissingSessions(ids);
    if (missing) {
      const claimed = await call(
        login.accessToken,
        "POST",
        "/_matrix/client/v3/keys/claim",
        missing.body,
      );
      await machine.markRequestAsSent(missing.id, missing.type, claimed.text);
    }
    for (const share of await machine.shareRoomKey(
      new RoomId(roomId),
      ids,
      new EncryptionSettings(),
    )) {
      const sent = await call(
        login.accessToken,
        "PUT",
        `/_matrix/client/v3/sendToDevice/${share.eventType}/${share.txnId}`,
        share.body,
      );
      await machine.markRequestAsSent(share.id, share.type, sent.text);
    }
    const content = await machine.encryptRoomEvent(
      new RoomId(roomId),
      "de.wappensc.together.tdsp.frame",
      JSON.stringify({ tdsp: 1, documentId, frame }),
    );
    const response = await call(
      login.accessToken,
      "PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.encrypted/raw-${Date.now()}`,
      content,
    );
    return (JSON.parse(response.text) as { event_id: string }).event_id;
  } finally {
    machine.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!available)(
  "frames only from devices their owners signed (MTX-4), live against a local Synapse",
  () => {
    let accounts: Record<"alice" | "bob", { userId: string; identity: TestIdentity }>;
    let roomId: string;
    const bridges: {
      url: string;
      server: Server;
      crypto: LiveCryptoMachine;
      dir: string;
      login: Login;
    }[] = [];
    const documentId = `doc-signed-devices-${Date.now()}`;

    /** A bridge of a fresh device of `user`, bound to the room; signed by its owner if `signed`. */
    async function bridgeOf(user: "alice" | "bob", signed: boolean) {
      const login = await loginFresh(accounts[user].userId, TEST_ACCOUNT_PASSWORD);
      const dir = mkdtempSync(join(tmpdir(), "signed-devices-"));
      const bindStorePath = join(dir, "tdsp-channels.json");
      const deps = await createLiveServerDependencies(
        { homeserverUrl: BASE_URL, accessToken: login.accessToken },
        bindStorePath,
      );
      if (signed) {
        await signTestDevice(login, accounts[user].identity, login.deviceId);
      }
      const server = createServer({
        homeserverUrl: BASE_URL,
        accessToken: login.accessToken,
        bindStorePath,
        ...deps,
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const bound = await fetch(`${url}/channels/${documentId}/bind`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channelId: roomId,
          creator: accounts.alice.userId,
          profile: "yjs-paragraphs/1",
        }),
      });
      expect(bound.status).toBe(200);
      await fetch(`${url}/channels/${documentId}/deliveries`); // the first /sync sets a baseline only
      const bridge = { url, server, crypto: deps.crypto, dir, login };
      bridges.push(bridge);
      return bridge;
    }

    const send = (url: string, sender: string, frame: string) =>
      fetch(`${url}/channels/${documentId}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sender, payload: frame }),
      });

    /** What `url` delivered once `frame` is there or its tries are over. */
    async function deliveredBy(url: string, frame: string): Promise<string[]> {
      let payloads: string[] = [];
      for (let attempt = 0; attempt < 20 && !payloads.includes(frame); attempt++) {
        const deliveries = (await (
          await fetch(`${url}/channels/${documentId}/deliveries`)
        ).json()) as {
          payload: string;
        }[];
        payloads = deliveries.map((delivery) => delivery.payload);
        if (!payloads.includes(frame)) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      return payloads;
    }

    beforeAll(async () => {
      accounts = JSON.parse(readFileSync(TEST_ACCOUNTS_PATH, "utf8"));
      const alice = await loginFresh(accounts.alice.userId, TEST_ACCOUNT_PASSWORD);
      const bob = await loginFresh(accounts.bob.userId, TEST_ACCOUNT_PASSWORD);
      roomId = await createRoom(
        alice.accessToken,
        true,
        `tdsp signed-devices test room ${Date.now()}`,
      );
      expect(
        (
          await call(
            alice.accessToken,
            "POST",
            `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
            { user_id: bob.userId },
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await call(
            bob.accessToken,
            "POST",
            `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`,
            {},
          )
        ).status,
      ).toBe(200);
    });

    afterAll(async () => {
      for (const bridge of bridges) {
        bridge.crypto.close();
        await new Promise<void>((resolve) => bridge.server.close(() => resolve()));
        rmSync(bridge.dir, { recursive: true, force: true });
      }
    });

    it("does not send from a device its owner has not signed (needs-person), and sends once it is signed", async () => {
      const unsigned = await bridgeOf("alice", false);
      const refused = await send(unsigned.url, accounts.alice.userId, "bm90IHlldA==");
      expect(refused.status).toBe(409);
      expect(await refused.text()).toContain("matrix:confirm-device");

      await signTestDevice(unsigned.login, accounts.alice.identity, unsigned.login.deviceId);
      expect((await send(unsigned.url, accounts.alice.userId, "c2lnbmVk")).status).toBe(200);
    });

    it("delivers no frame from a device its owner has not signed, and one from a signed device, though it never sent to the room", async () => {
      const receiver = await bridgeOf("bob", true);
      const unsignedLogin = await loginFresh(accounts.alice.userId, TEST_ACCOUNT_PASSWORD);
      const members = [accounts.alice.userId, accounts.bob.userId];
      await sendFromRawDevice(unsignedLogin, roomId, members, documentId, "ZnJvbS11bnNpZ25lZA==");

      const sender = await bridgeOf("alice", true);
      expect((await send(sender.url, accounts.alice.userId, "ZnJvbS1zaWduZWQ=")).status).toBe(200);

      const delivered = await deliveredBy(receiver.url, "ZnJvbS1zaWduZWQ=");
      expect(delivered).toContain("ZnJvbS1zaWduZWQ=");
      expect(delivered).not.toContain("ZnJvbS11bnNpZ25lZA==");
    });
  },
);
