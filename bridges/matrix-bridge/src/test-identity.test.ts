import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeviceId,
  KeysQueryRequest,
  KeysUploadRequest,
  OlmMachine,
  UserId,
} from "@matrix-org/matrix-sdk-crypto-nodejs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BASE_URL,
  TEST_ACCOUNT_PASSWORD,
  TEST_ACCOUNTS_PATH,
} from "../../../infra/matrix-testserver/config.ts";
import {
  signTestDevice,
  type TestIdentity,
} from "../../../infra/matrix-testserver/cross-signing.ts";
import { hasTestMatrixHomeserver } from "../../../infra/matrix-testserver/health.ts";
import { loginFresh } from "../../../infra/matrix-testserver/login.ts";

/**
 * L2: the test accounts' cross-signing identities, which the encrypted-room tests rely on once the
 * bridge shares room keys only with devices their owners signed (MTX-4). A device signed with
 * `signTestDevice` is one matrix-sdk-crypto counts as cross-signed by its owner; one left unsigned
 * is not. Skips cleanly without the test server.
 */
const available = await hasTestMatrixHomeserver();

describe.skipIf(!available)(
  "the test accounts' cross-signing identities, live against a local Synapse",
  () => {
    const dirs: string[] = [];
    let accounts: Record<"alice" | "bob", { userId: string; identity: TestIdentity }>;

    beforeAll(() => {
      accounts = JSON.parse(readFileSync(TEST_ACCOUNTS_PATH, "utf8"));
    });

    afterAll(() => {
      for (const dir of dirs) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    /** A crypto machine of a fresh device of `user`, its keys uploaded and `users`' keys queried. */
    async function deviceOf(user: string, users: string[]) {
      const login = await loginFresh(user, TEST_ACCOUNT_PASSWORD);
      const dir = mkdtempSync(join(tmpdir(), "test-identity-"));
      dirs.push(dir);
      const machine = await OlmMachine.initialize(
        new UserId(login.userId),
        new DeviceId(login.deviceId),
        dir,
        "test",
        0,
      );
      const pump = async () => {
        for (const request of await machine.outgoingRequests()) {
          if (request instanceof KeysUploadRequest || request instanceof KeysQueryRequest) {
            const path = request instanceof KeysUploadRequest ? "keys/upload" : "keys/query";
            const response = await fetch(`${BASE_URL}/_matrix/client/v3/${path}`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${login.accessToken}`,
                "content-type": "application/json",
              },
              body: request.body,
            });
            await machine.markRequestAsSent(request.id, request.type, await response.text());
          }
        }
      };
      await pump();
      await machine.updateTrackedUsers(users.map((id) => new UserId(id)));
      return { login, machine, pump };
    }

    it("makes a device signed with signTestDevice one its owner cross-signed, and leaves another unsigned", async () => {
      const alice = await deviceOf("alice", []);
      const unsigned = await deviceOf("alice", []);
      await signTestDevice(alice.login, accounts.alice.identity, alice.login.deviceId);

      const bob = await deviceOf("bob", [accounts.alice.userId]);
      // A fresh query, so that the signature uploaded above is what bob's machine reads.
      await bob.pump();
      const signedDevice = await bob.machine.getDevice(
        new UserId(accounts.alice.userId),
        new DeviceId(alice.login.deviceId),
      );
      const unsignedDevice = await bob.machine.getDevice(
        new UserId(accounts.alice.userId),
        new DeviceId(unsigned.login.deviceId),
      );
      expect(signedDevice?.isCrossSignedByOwner()).toBe(true);
      expect(unsignedDevice?.isCrossSignedByOwner()).toBe(false);
      for (const each of [alice, unsigned, bob]) {
        each.machine.close();
      }
    });
  },
);
