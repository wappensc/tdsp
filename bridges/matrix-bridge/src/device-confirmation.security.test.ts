import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from "node:crypto";
import { SecretStorageKey } from "@matrix-org/matrix-sdk-crypto-nodejs";
import { describe, expect, it } from "vitest";
import {
  DeviceConfirmationError,
  type DeviceConfirmationProblem,
  type SignOwnDeviceInput,
  signOwnDevice,
} from "./device-confirmation.ts";

/**
 * Confirming the bridge's Matrix device with the account's self-signing key
 * (docs/matrix-device-confirmation.md): only this bridge's own, genuine device keys are ever
 * signed, only with the self-signing key the account publishes, and a recovery key that does
 * not open Secret Storage signs nothing. Security tests: only the CI role may change this file
 * (.github/CODEOWNERS, CONTRIBUTING.md); every helper is in this file.
 */

const USER = "@alice:example.org";
const DEVICE = "BRIDGEDEV";

const unpadded = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64").replace(/=+$/, "");
const privateKey = (seed: Uint8Array) =>
  createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8",
  });
const publicOf = (seed: Uint8Array) =>
  unpadded(createPublicKey(privateKey(seed)).export({ format: "der", type: "spki" }).subarray(-32));
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map(
            (key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
          )
          .join(",")}}`
      : JSON.stringify(value);
const signatureOver = (seed: Uint8Array, value: Record<string, unknown>) => {
  const { signatures: _s, unsigned: _u, ...signed } = value;
  return unpadded(sign(null, Buffer.from(canonical(signed)), privateKey(seed)));
};
const verifies = (publicKey: string, value: Record<string, unknown>, signature: string) => {
  const { signatures: _s, unsigned: _u, ...signed } = value;
  return verify(
    null,
    Buffer.from(canonical(signed)),
    createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(publicKey, "base64"),
      ]),
      format: "der",
      type: "spki",
    }),
    Buffer.from(signature, "base64"),
  );
};

/** An account with a cross-signing identity in Secret Storage, and the bridge's own device. */
function account() {
  const deviceSeed = randomBytes(32);
  const selfSigningSeed = randomBytes(32);
  const masterSeed = randomBytes(32);
  const deviceEd25519 = publicOf(deviceSeed);
  const unsignedKeys = {
    algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"],
    device_id: DEVICE,
    keys: {
      [`curve25519:${DEVICE}`]: unpadded(randomBytes(32)),
      [`ed25519:${DEVICE}`]: deviceEd25519,
    },
    user_id: USER,
  };
  const deviceKeys = {
    ...unsignedKeys,
    signatures: { [USER]: { [`ed25519:${DEVICE}`]: signatureOver(deviceSeed, unsignedKeys) } },
    unsigned: { device_display_name: "TDSP bridge" },
  };
  const storageKey = SecretStorageKey.createRandomKey();
  const selfSigningPublic = publicOf(selfSigningSeed);
  const input: SignOwnDeviceInput = {
    userId: USER,
    ownDevice: { deviceId: DEVICE, ed25519: deviceEd25519 },
    recoveryKey: storageKey.toBase58(),
    keyEventType: storageKey.eventType(),
    keyDescription: storageKey.accountDataContent(),
    encryptedSelfSigningKey: storageKey.encrypt(
      unpadded(selfSigningSeed),
      "m.cross_signing.self_signing",
    ),
    publishedSelfSigningKey: {
      user_id: USER,
      usage: ["self_signing"],
      keys: { [`ed25519:${selfSigningPublic}`]: selfSigningPublic },
    },
    serverDeviceKeys: deviceKeys,
  };
  return { input, deviceSeed, unsignedKeys, deviceKeys, storageKey, selfSigningPublic, masterSeed };
}

function problemOf(input: SignOwnDeviceInput): DeviceConfirmationProblem | "signed" {
  try {
    signOwnDevice(input);
    return "signed";
  } catch (error) {
    if (error instanceof DeviceConfirmationError) {
      return error.problem;
    }
    throw error;
  }
}

describe("confirming the bridge's own Matrix device", () => {
  it("signs exactly the bridge's device keys with the published self-signing key", () => {
    const { input, unsignedKeys, selfSigningPublic } = account();
    const { keyId, signedDeviceKeys } = signOwnDevice(input);
    expect(keyId).toBe(`ed25519:${selfSigningPublic}`);
    const signatures = (signedDeviceKeys.signatures as Record<string, Record<string, string>>)[
      USER
    ];
    expect(Object.keys(signatures ?? {})).toEqual([keyId]);
    expect(verifies(selfSigningPublic, unsignedKeys, signatures?.[keyId] as string)).toBe(true);
    // Only what the device itself signed, unchanged.
    const { signatures: _s, ...rest } = signedDeviceKeys;
    expect(rest).toEqual(unsignedKeys);
  });

  it("signs nothing with a recovery key that does not open the account's Secret Storage", () => {
    const { input } = account();
    expect(
      problemOf({ ...input, recoveryKey: SecretStorageKey.createRandomKey().toBase58() }),
    ).toBe("wrong-recovery-key");
    expect(problemOf({ ...input, recoveryKey: "not a recovery key" })).toBe("wrong-recovery-key");
  });

  it("signs with no key but the self-signing one: the master key in its place is refused", () => {
    const { input, storageKey, masterSeed } = account();
    // A homeserver that hands the master key's ciphertext out as the self-signing key's.
    const master = storageKey.encrypt(unpadded(masterSeed), "m.cross_signing.master");
    expect(problemOf({ ...input, encryptedSelfSigningKey: master })).toBe("wrong-recovery-key");
  });

  it("signs nothing when Secret Storage holds a key the account does not publish", () => {
    const { input } = account();
    const other = publicOf(randomBytes(32));
    expect(
      problemOf({
        ...input,
        publishedSelfSigningKey: {
          user_id: USER,
          usage: ["self_signing"],
          keys: { [`ed25519:${other}`]: other },
        },
      }),
    ).toBe("self-signing-key-mismatch");
    expect(problemOf({ ...input, publishedSelfSigningKey: undefined })).toBe(
      "self-signing-key-mismatch",
    );
  });

  it("signs no device keys but the bridge's own, as its own device signed them", () => {
    const { input, deviceKeys, deviceSeed } = account();
    const withKeys = (keys: Record<string, unknown>) => ({ ...input, serverDeviceKeys: keys });

    // Another device id, another user, another identity key than the running bridge reports.
    expect(problemOf(withKeys({ ...deviceKeys, device_id: "OTHER" }))).toBe("device-keys-mismatch");
    expect(problemOf(withKeys({ ...deviceKeys, user_id: "@mallory:example.org" }))).toBe(
      "device-keys-mismatch",
    );
    expect(
      problemOf({ ...input, ownDevice: { deviceId: DEVICE, ed25519: publicOf(randomBytes(32)) } }),
    ).toBe("device-keys-mismatch");

    // A curve25519 key swapped by the homeserver: the device's own signature no longer holds.
    const swapped = {
      ...deviceKeys,
      keys: { ...deviceKeys.keys, [`curve25519:${DEVICE}`]: unpadded(randomBytes(32)) },
    };
    expect(problemOf(withKeys(swapped))).toBe("device-keys-mismatch");

    // No signature of the device's own, or one by another key.
    const { signatures: _s, ...unsignedCopy } = deviceKeys;
    expect(problemOf(withKeys(unsignedCopy))).toBe("device-keys-mismatch");
    const forged = {
      ...deviceKeys,
      signatures: { [USER]: { [`ed25519:${DEVICE}`]: signatureOver(randomBytes(32), deviceKeys) } },
    };
    expect(problemOf(withKeys(forged))).toBe("device-keys-mismatch");
    expect(problemOf(withKeys(undefined as unknown as Record<string, unknown>))).toBe(
      "device-keys-mismatch",
    );

    // The genuine keys still sign, so the refusals above are about what they test.
    expect(signatureOver(deviceSeed, deviceKeys)).toBe(
      (deviceKeys.signatures[USER] as Record<string, string>)[`ed25519:${DEVICE}`],
    );
    expect(problemOf(input)).toBe("signed");
  });
});
