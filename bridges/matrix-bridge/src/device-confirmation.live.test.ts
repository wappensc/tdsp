import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeviceId,
  KeysQueryRequest,
  KeysUploadRequest,
  OlmMachine,
  SecretStorageKey,
  UserId,
} from "@matrix-org/matrix-sdk-crypto-nodejs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE_URL, TEST_ACCOUNT_PASSWORD } from "../../../infra/matrix-testserver/config.ts";
import { hasTestMatrixHomeserver } from "../../../infra/matrix-testserver/health.ts";
import { loginFresh } from "../../../infra/matrix-testserver/login.ts";
import { registerAccount } from "../../../infra/matrix-testserver/register.ts";
import { createCryptoMachine } from "./crypto-machine.ts";
import { confirmOwnDevice, DeviceConfirmationError } from "./device-confirmation.ts";

/**
 * L2: `pnpm run matrix:confirm-device`'s work against a local Synapse
 * (docs/matrix-device-confirmation.md). Another device of a fresh account sets up a
 * cross-signing identity and Secret Storage the way Element does; the bridge's own device is
 * then confirmed with the recovery key. Skips cleanly without the test server.
 */
const available = await hasTestMatrixHomeserver();

async function call(token: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

/** What another Matrix app does when a person sets up cross-signing: returns the recovery key. */
async function setUpIdentityElsewhere(user: string): Promise<string> {
  const other = await loginFresh(user, TEST_ACCOUNT_PASSWORD);
  const store = mkdtempSync(join(tmpdir(), "confirm-device-other-"));
  const machine = await OlmMachine.initialize(
    new UserId(other.userId),
    new DeviceId(other.deviceId),
    store,
    "other",
    0,
  );
  try {
    for (const request of await machine.outgoingRequests()) {
      if (request instanceof KeysUploadRequest || request instanceof KeysQueryRequest) {
        const path = request instanceof KeysUploadRequest ? "keys/upload" : "keys/query";
        const response = await call(
          other.accessToken,
          "POST",
          `/_matrix/client/v3/${path}`,
          request.body,
        );
        await machine.markRequestAsSent(request.id, request.type, response.text);
      }
    }
    const bootstrap = await machine.bootstrapCrossSigning(true);
    const signing = JSON.parse(bootstrap.uploadSigningKeysReq);
    let upload = await call(
      other.accessToken,
      "POST",
      "/_matrix/client/v3/keys/device_signing/upload",
      signing,
    );
    if (upload.status === 401) {
      const { session } = JSON.parse(upload.text) as { session: string };
      upload = await call(
        other.accessToken,
        "POST",
        "/_matrix/client/v3/keys/device_signing/upload",
        {
          ...signing,
          auth: {
            type: "m.login.password",
            identifier: { type: "m.id.user", user },
            password: TEST_ACCOUNT_PASSWORD,
            session,
          },
        },
      );
    }
    expect(upload.status).toBe(200);
    const key = SecretStorageKey.createRandomKey();
    const items = await machine.exportSecretsForSecretStorage(key);
    const put = (type: string, content: string) =>
      call(
        other.accessToken,
        "PUT",
        `/_matrix/client/v3/user/${encodeURIComponent(other.userId)}/account_data/${type}`,
        content,
      );
    await put("m.cross_signing.master", items.masterKey);
    await put("m.cross_signing.self_signing", items.selfSigningKey);
    await put("m.cross_signing.user_signing", items.userSigningKey);
    await put(key.eventType(), key.accountDataContent());
    await put("m.secret_storage.default_key", JSON.stringify({ key: key.keyId() }));
    return key.toBase58();
  } finally {
    machine.close();
    rmSync(store, { recursive: true, force: true });
  }
}

/** Whether the account's published self-signing key has signed `deviceId`, as `/keys/query` shows it. */
async function selfSignedDevices(token: string, userId: string): Promise<Record<string, boolean>> {
  const keys = JSON.parse(
    (await call(token, "POST", "/_matrix/client/v3/keys/query", { device_keys: { [userId]: [] } }))
      .text,
  ) as {
    self_signing_keys: Record<string, { keys: Record<string, string> }>;
    device_keys: Record<
      string,
      Record<string, { signatures: Record<string, Record<string, string>> }>
    >;
  };
  const selfSigningKeyId = Object.keys(keys.self_signing_keys[userId]?.keys ?? {})[0] ?? "";
  return Object.fromEntries(
    Object.entries(keys.device_keys[userId] ?? {}).map(([deviceId, device]) => [
      deviceId,
      selfSigningKeyId in (device.signatures[userId] ?? {}),
    ]),
  );
}

describe.skipIf(!available)("confirming the bridge's device, live against a local Synapse", () => {
  const user = `confirm${Date.now()}`;
  let recoveryKey: string;
  let bridge: { userId: string; accessToken: string; deviceId: string };
  let store: string;

  beforeAll(async () => {
    await registerAccount(user);
    recoveryKey = await setUpIdentityElsewhere(user);
    bridge = await loginFresh(user, TEST_ACCOUNT_PASSWORD);
    store = mkdtempSync(join(tmpdir(), "confirm-device-bridge-"));
  });

  afterAll(() => {
    rmSync(store, { recursive: true, force: true });
  });

  it("signs the bridge's device with the self-signing key, keeps no private key, and does it once", async () => {
    const config = { homeserverUrl: BASE_URL, accessToken: bridge.accessToken };
    const crypto = await createCryptoMachine(config, store);
    const ownDevice = { deviceId: crypto.deviceId, ed25519: crypto.ed25519 };
    try {
      expect((await selfSignedDevices(bridge.accessToken, bridge.userId))[bridge.deviceId]).toBe(
        false,
      );

      const wrong = await confirmOwnDevice(
        config,
        ownDevice,
        SecretStorageKey.createRandomKey().toBase58(),
      ).catch((error: unknown) => error);
      expect(wrong).toBeInstanceOf(DeviceConfirmationError);
      expect((wrong as DeviceConfirmationError).problem).toBe("wrong-recovery-key");
      expect((await selfSignedDevices(bridge.accessToken, bridge.userId))[bridge.deviceId]).toBe(
        false,
      );

      await expect(confirmOwnDevice(config, ownDevice, recoveryKey)).resolves.toBe("signed");
      expect((await selfSignedDevices(bridge.accessToken, bridge.userId))[bridge.deviceId]).toBe(
        true,
      );
      await expect(confirmOwnDevice(config, ownDevice, recoveryKey)).resolves.toBe(
        "already-signed",
      );
    } finally {
      crypto.close();
    }

    // The bridge's crypto store holds none of the account's private cross-signing keys.
    const reopened = await OlmMachine.initialize(
      new UserId(bridge.userId),
      new DeviceId(bridge.deviceId),
      store,
      "tdsp-matrix-bridge",
      0,
    );
    try {
      const status = await reopened.crossSigningStatus();
      expect([status.hasMaster, status.hasSelfSigning, status.hasUserSigning]).toEqual([
        false,
        false,
        false,
      ]);
    } finally {
      reopened.close();
    }
  });

  it("refuses an account without a cross-signing identity", async () => {
    const plainUser = `plain${Date.now()}`;
    await registerAccount(plainUser);
    const plain = await loginFresh(plainUser, TEST_ACCOUNT_PASSWORD);
    const plainStore = mkdtempSync(join(tmpdir(), "confirm-device-plain-"));
    const config = { homeserverUrl: BASE_URL, accessToken: plain.accessToken };
    const crypto = await createCryptoMachine(config, plainStore);
    try {
      const refusal = await confirmOwnDevice(
        config,
        { deviceId: crypto.deviceId, ed25519: crypto.ed25519 },
        recoveryKey,
      ).catch((error: unknown) => error);
      expect((refusal as DeviceConfirmationError).problem).toBe("no-identity");
    } finally {
      crypto.close();
      rmSync(plainStore, { recursive: true, force: true });
    }
  });
});
