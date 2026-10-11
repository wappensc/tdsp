import { createPrivateKey, createPublicKey, type KeyObject, sign, verify } from "node:crypto";
import { SecretStorageKey } from "@matrix-org/matrix-sdk-crypto-nodejs";
import {
  getAccountData,
  type MatrixApiConfig,
  queryKeys,
  uploadSignatures,
  whoami,
} from "./matrix-api.ts";

/**
 * Confirms this bridge's own Matrix device with the account's cross-signing identity
 * (docs/matrix-device-confirmation.md): signs the device's keys with the account's
 * **self-signing key**, read from the account's Secret Storage with the recovery key the
 * person enters. Clients that follow MSC4153 (Element's default from October 2026) show
 * nothing a device sends unless its own account signed it.
 *
 * Only the self-signing key is ever decrypted, held for the one signature, and then dropped;
 * nothing is stored. `OlmMachine.importSecretsFromSecretStorage` would do the signing too, but
 * keeps all three private cross-signing keys, the master key included, in the bridge's crypto
 * store for good, and offers no way to remove them (tried against Synapse). The decryption of
 * Secret Storage itself stays the library's (`SecretStorageKey`); this module adds only
 * canonical JSON and one Ed25519 signature.
 *
 * Nothing the homeserver says is signed on its word: the self-signing key must be the one the
 * account publishes, and the device keys must be this bridge's own — same device, same Ed25519
 * key as the running bridge reports, and carrying the device's own valid signature — so a
 * homeserver cannot get another device, or other keys, signed.
 */

export type DeviceConfirmationProblem =
  /** The account has no cross-signing identity, or no Secret Storage holding its self-signing key. */
  | "no-identity"
  /** The recovery key does not open the account's Secret Storage. */
  | "wrong-recovery-key"
  /** The key Secret Storage holds is not the self-signing key the account publishes. */
  | "self-signing-key-mismatch"
  /** The device keys the homeserver lists are not this bridge's own. */
  | "device-keys-mismatch";

export class DeviceConfirmationError extends Error {
  readonly problem: DeviceConfirmationProblem;

  constructor(problem: DeviceConfirmationProblem, message: string) {
    super(message);
    this.name = "DeviceConfirmationError";
    this.problem = problem;
  }
}

/** What the running bridge says about its own device: the device id and its Ed25519 identity key. */
export interface OwnDevice {
  readonly deviceId: string;
  readonly ed25519: string;
}

const SELF_SIGNING_SECRET = "m.cross_signing.self_signing";
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Matrix's canonical JSON (Client-Server API, appendix "Canonical JSON"): object keys sorted by
 * code point, no insignificant whitespace, integers only. Refuses anything else rather than
 * produce bytes another implementation would encode differently.
 */
export function canonicalJson(value: unknown): string {
  if (typeof value === "string" || typeof value === "boolean" || value === null) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new Error(`canonical JSON holds integers only, not ${value}`);
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new Error(`canonical JSON cannot hold a ${typeof value}`);
}

const unpaddedBase64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64").replace(/=+$/, "");

function privateKeyFromSeed(seed: Uint8Array): KeyObject {
  if (seed.length !== 32) {
    throw new Error(`an Ed25519 seed is 32 bytes, not ${seed.length}`);
  }
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

function publicKeyFromBase64(key: string): KeyObject {
  const raw = Buffer.from(key, "base64");
  if (raw.length !== 32) {
    throw new Error("an Ed25519 public key is 32 bytes");
  }
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

/** The public key of an Ed25519 seed, in unpadded Base64 as Matrix writes keys. */
export function ed25519PublicKey(seed: Uint8Array): string {
  return unpaddedBase64(
    createPublicKey(privateKeyFromSeed(seed)).export({ format: "der", type: "spki" }).subarray(-32),
  );
}

/** The Ed25519 signature of `value`'s canonical JSON, without its `signatures` and `unsigned`, in unpadded Base64. */
export function signJson(seed: Uint8Array, value: Readonly<Record<string, unknown>>): string {
  const { signatures: _signatures, unsigned: _unsigned, ...signed } = value;
  return unpaddedBase64(
    sign(null, Buffer.from(canonicalJson(signed), "utf8"), privateKeyFromSeed(seed)),
  );
}

function hasValidSignature(
  value: Readonly<Record<string, unknown>>,
  userId: string,
  keyId: string,
  publicKey: string,
): boolean {
  const signature = (value.signatures as Record<string, Record<string, unknown>> | undefined)?.[
    userId
  ]?.[keyId];
  if (typeof signature !== "string") {
    return false;
  }
  const { signatures: _signatures, unsigned: _unsigned, ...signed } = value;
  try {
    return verify(
      null,
      Buffer.from(canonicalJson(signed), "utf8"),
      publicKeyFromBase64(publicKey),
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

/** What `signOwnDevice` needs, all of it as the homeserver and the running bridge gave it. */
export interface SignOwnDeviceInput {
  readonly userId: string;
  readonly ownDevice: OwnDevice;
  readonly recoveryKey: string;
  /** The account data event type of the default Secret Storage key, `m.secret_storage.key.<id>`. */
  readonly keyEventType: string;
  /** That event's content, as JSON text. */
  readonly keyDescription: string;
  /** The `m.cross_signing.self_signing` account data content, as JSON text. */
  readonly encryptedSelfSigningKey: string;
  /** `self_signing_keys[userId]` from `/keys/query`: the self-signing key the account publishes. */
  readonly publishedSelfSigningKey: unknown;
  /** `device_keys[userId][deviceId]` from `/keys/query`: the homeserver's copy of this device's keys. */
  readonly serverDeviceKeys: unknown;
}

/**
 * The device keys of this bridge with the account's self-signing signature added, ready to
 * upload, and the signing key's id. Pure: no network. Throws `DeviceConfirmationError` for
 * anything that does not check out.
 */
export function signOwnDevice(input: SignOwnDeviceInput): {
  readonly keyId: string;
  readonly signedDeviceKeys: Readonly<Record<string, unknown>>;
} {
  const { userId, ownDevice } = input;
  const device = input.serverDeviceKeys as Record<string, unknown> | undefined;
  const ownKeyId = `ed25519:${ownDevice.deviceId}`;
  if (
    typeof device !== "object" ||
    device === null ||
    device.user_id !== userId ||
    device.device_id !== ownDevice.deviceId ||
    (device.keys as Record<string, unknown> | undefined)?.[ownKeyId] !== ownDevice.ed25519 ||
    !hasValidSignature(device, userId, ownKeyId, ownDevice.ed25519)
  ) {
    throw new DeviceConfirmationError(
      "device-keys-mismatch",
      `the homeserver's keys for device ${ownDevice.deviceId} are not this bridge's own`,
    );
  }

  let secretStorageKey: SecretStorageKey;
  try {
    secretStorageKey = SecretStorageKey.fromAccountData(
      input.recoveryKey,
      input.keyEventType,
      input.keyDescription,
    );
  } catch {
    throw new DeviceConfirmationError(
      "wrong-recovery-key",
      "the recovery key does not open this account's Secret Storage",
    );
  }
  let seed: Buffer;
  try {
    seed = Buffer.from(
      secretStorageKey.decrypt(input.encryptedSelfSigningKey, SELF_SIGNING_SECRET),
      "base64",
    );
  } catch {
    throw new DeviceConfirmationError(
      "wrong-recovery-key",
      "the recovery key does not decrypt this account's self-signing key",
    );
  }
  try {
    const published = (input.publishedSelfSigningKey as { keys?: Record<string, unknown> } | null)
      ?.keys;
    let derived: string;
    try {
      derived = ed25519PublicKey(seed);
    } catch {
      throw new DeviceConfirmationError(
        "self-signing-key-mismatch",
        "Secret Storage holds no Ed25519 self-signing key",
      );
    }
    const keyId = `ed25519:${derived}`;
    if (published?.[keyId] !== derived) {
      throw new DeviceConfirmationError(
        "self-signing-key-mismatch",
        "the key in Secret Storage is not the self-signing key this account publishes",
      );
    }
    const signature = signJson(seed, device);
    const { unsigned: _unsigned, ...withoutUnsigned } = device;
    return {
      keyId,
      signedDeviceKeys: { ...withoutUnsigned, signatures: { [userId]: { [keyId]: signature } } },
    };
  } finally {
    // Best effort: the Base64 text the library returned cannot be cleared from memory.
    seed.fill(0);
  }
}

/**
 * Confirms the device behind `config`'s access token, which must be `ownDevice` — the running
 * bridge's. Resolves `"signed"`, or `"already-signed"` when the self-signing key had already
 * signed it (nothing is uploaded then).
 */
export async function confirmOwnDevice(
  config: MatrixApiConfig,
  ownDevice: OwnDevice,
  recoveryKey: string,
): Promise<"signed" | "already-signed"> {
  const { userId, deviceId } = await whoami(config);
  if (deviceId !== ownDevice.deviceId) {
    throw new DeviceConfirmationError(
      "device-keys-mismatch",
      `the access token belongs to device ${deviceId}, the bridge runs as ${ownDevice.deviceId}`,
    );
  }
  const defaultKey = await getAccountData(config, userId, "m.secret_storage.default_key");
  const keyId =
    defaultKey === undefined ? undefined : (JSON.parse(defaultKey) as { key?: unknown }).key;
  const keyEventType = typeof keyId === "string" ? `m.secret_storage.key.${keyId}` : undefined;
  const keyDescription =
    keyEventType === undefined ? undefined : await getAccountData(config, userId, keyEventType);
  const encryptedSelfSigningKey = await getAccountData(config, userId, SELF_SIGNING_SECRET);
  const keys = JSON.parse(
    await queryKeys(config, JSON.stringify({ device_keys: { [userId]: [deviceId] } })),
  ) as {
    self_signing_keys?: Record<string, unknown>;
    device_keys?: Record<string, Record<string, unknown>>;
  };
  const publishedSelfSigningKey = keys.self_signing_keys?.[userId];
  if (
    keyEventType === undefined ||
    keyDescription === undefined ||
    encryptedSelfSigningKey === undefined ||
    publishedSelfSigningKey === undefined
  ) {
    throw new DeviceConfirmationError(
      "no-identity",
      `${userId} has no cross-signing identity in Secret Storage; set one up in another Matrix app first`,
    );
  }
  const serverDeviceKeys = keys.device_keys?.[userId]?.[deviceId] as
    | Record<string, unknown>
    | undefined;
  const publishedKeyIds = Object.keys(
    (publishedSelfSigningKey as { keys?: Record<string, unknown> }).keys ?? {},
  );
  if (
    serverDeviceKeys !== undefined &&
    publishedKeyIds.some((id) =>
      hasValidSignature(serverDeviceKeys, userId, id, id.replace(/^ed25519:/, "")),
    )
  ) {
    return "already-signed";
  }
  const { signedDeviceKeys } = signOwnDevice({
    userId,
    ownDevice,
    recoveryKey,
    keyEventType,
    keyDescription,
    encryptedSelfSigningKey,
    publishedSelfSigningKey,
    serverDeviceKeys,
  });
  await uploadSignatures(config, { [userId]: { [deviceId]: signedDeviceKeys } });
  return "signed";
}
