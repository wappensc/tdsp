// Adapted from matrix-rust-sdk, commit 90db5fe383a9a325667c817e144ea6a711c90468, the version
// that @matrix-org/matrix-sdk-crypto-nodejs 0.6.6 is built from:
//   crates/matrix-sdk-crypto/src/identities/device.rs   (DeviceData::is_cross_signed_by_owner)
//   crates/matrix-sdk-crypto/src/identities/user.rs     (OwnUserIdentityData::new, is_device_signed)
//   crates/matrix-sdk-crypto/src/identities/manager.rs  (the own identity from a /keys/query)
//   crates/matrix-sdk-crypto/src/types/cross_signing/   (verify_subkey, verify_device_keys,
//                                                         get_first_key_and_id, key usage)
//   crates/matrix-sdk-crypto/src/types/device_keys.rs   (check_self_signature)
//   crates/matrix-sdk-crypto/src/olm/utility.rs         (signable JSON, verify_signature)
// Copyright 2020 The Matrix.org Foundation C.I.C.
// Licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0).
// Changed by TDSP: translated from Rust to TypeScript; reads one /keys/query response instead of
// the library's crypto store; checks only the bridge's own device; compares that device's
// Ed25519 key with the running bridge's own. THIRD-PARTY-NOTICES.md lists this file.

import { hasValidSignature } from "./device-confirmation.ts";

/**
 * Whether the homeserver's `/keys/query` answer shows this bridge's own device signed by its
 * account's identity — what `Device.isCrossSignedByOwner()` of
 * `@matrix-org/matrix-sdk-crypto-nodejs` (the Matrix.org Foundation's package) answers for it,
 * and what a bridge must hold before it sends into an encrypted room (bindings/matrix.md MTX-4).
 *
 * **Why a translation and not the library's own call.** `OlmMachine.getDevice()` returns a
 * `Device` that keeps the library's SQLite crypto store alive, and the package offers no way to
 * release it. Collected only after `OlmMachine.close()`, that `Device` drops the store when the
 * process ends, outside the library's Tokio runtime, and the process aborts ("there is no
 * reactor running", deadpool-runtime 0.3.1). Tried in Node.js 22 on Linux: `getDevice()` then
 * `close()` aborted in 6 runs of 6; the same with the `Device` collected before `close()`, and
 * `close()` alone, in none. So every bridge that sent into an encrypted room aborted on exit, and
 * so did the Vitest workers of the Matrix tests in CI.
 *
 * **What is checked**, as the library checks it for an own device, in this order:
 * 1. the master, self-signing and user-signing keys are the account's (`user_id`), each with
 *    exactly its own usage, and every Ed25519 key in them is a valid key;
 * 2. the master key signed the self-signing and the user-signing key (`verify_subkey`): the
 *    library builds the own identity only from all three;
 * 3. the device is this one (`user_id`, `device_id`), it signed its keys with the Ed25519 key
 *    they publish (`check_self_signature`), and that key is the running bridge's;
 * 4. the self-signing key signed the device's keys (`verify_device_keys`).
 * A key signs with the first Ed25519 key of its `keys`, in key-id order, as
 * `get_first_key_and_id` takes it. A signature covers the object's canonical JSON without its
 * `signatures` and `unsigned`, every other member included, as the library keeps unknown
 * members. Anything missing or malformed is "not signed".
 *
 * **Risks taken with it:**
 * - This is our own signature code where a mistake matters. It decides only whether this bridge
 *   sends; what it accepts from others is still the library's check (`shieldState`). A mistake
 *   would let an unsigned device of this bridge send, whose frames receivers that follow
 *   MTX-4 still refuse.
 * - It can drift from the library: a later version may check more.
 *   `own-device-signature.security.test.ts` compares both on the same answers, so an upgrade
 *   that changes the library's verdict fails.
 * - Ed25519 is node:crypto's (OpenSSL), not vodozemac's; Base64 is decoded leniently. Both
 *   accept only signatures that verify; they may differ only on inputs no honest signer makes.
 * - It answers from the homeserver's current answer, not from the library's stored identity, as
 *   the library does after its next query. A homeserver that replaces the account's identity is
 *   believed by both (§15.1).
 * Remove it once the library releases a `Device` before `close()`, or `close()` no longer
 * aborts with one still alive: the comparison test then shows the call to use again.
 */
export function isOwnDeviceCrossSigned(
  response: unknown,
  own: { readonly userId: string; readonly deviceId: string; readonly ed25519: string },
): boolean {
  if (!isObject(response)) {
    return false;
  }
  const master = response.master_keys;
  const selfSigning = response.self_signing_keys;
  const userSigning = response.user_signing_keys;
  const devices = response.device_keys;
  const masterKey = isObject(master)
    ? crossSigningKey(master[own.userId], own.userId, "master")
    : undefined;
  const selfSigningKey = isObject(selfSigning)
    ? crossSigningKey(selfSigning[own.userId], own.userId, "self_signing")
    : undefined;
  const userSigningKey = isObject(userSigning)
    ? crossSigningKey(userSigning[own.userId], own.userId, "user_signing")
    : undefined;
  if (masterKey === undefined || selfSigningKey === undefined || userSigningKey === undefined) {
    return false;
  }
  // OwnUserIdentityData::new: the master key signed both subkeys.
  if (
    !signedBy(selfSigningKey.object, own.userId, masterKey) ||
    !signedBy(userSigningKey.object, own.userId, masterKey)
  ) {
    return false;
  }
  const ownDevices = isObject(devices) ? devices[own.userId] : undefined;
  const device = isObject(ownDevices) ? ownDevices[own.deviceId] : undefined;
  if (!isObject(device) || device.user_id !== own.userId || device.device_id !== own.deviceId) {
    return false;
  }
  // DeviceKeys::check_self_signature: the device signed its keys with the key they publish.
  const deviceKeyId = `ed25519:${own.deviceId}`;
  const deviceKeys = device.keys;
  const published = isObject(deviceKeys) ? deviceKeys[deviceKeyId] : undefined;
  if (
    !isEd25519Key(published) ||
    !hasValidSignature(device, own.userId, deviceKeyId, published as string)
  ) {
    return false;
  }
  // The library stores no other keys for its own device: they must be the running bridge's.
  if (published !== own.ed25519) {
    return false;
  }
  // SelfSigningPubkey::verify_device_keys.
  return signedBy(device, own.userId, selfSigningKey);
}

interface CrossSigningKey {
  readonly object: Readonly<Record<string, unknown>>;
  /** The first Ed25519 key of `keys` in key-id order, as `get_first_key_and_id` takes it. */
  readonly keyId: string;
  readonly key: string;
}

/** A cross-signing key of `userId` with exactly `usage`, as `TryFrom<CrossSigningKey>` takes it. */
function crossSigningKey(
  value: unknown,
  userId: string,
  usage: "master" | "self_signing" | "user_signing",
): CrossSigningKey | undefined {
  if (!isObject(value) || value.user_id !== userId) {
    return undefined;
  }
  const usages = value.usage;
  if (!Array.isArray(usages) || usages.length !== 1 || usages[0] !== usage) {
    return undefined;
  }
  const keys = value.keys;
  if (!isObject(keys)) {
    return undefined;
  }
  const ed25519 = Object.keys(keys)
    .filter((id) => id.startsWith("ed25519:"))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // SigningKey::from_parts: an Ed25519 key that is no key makes the whole key unreadable.
  if (ed25519.some((id) => !isEd25519Key(keys[id]))) {
    return undefined;
  }
  const first = ed25519[0];
  return first === undefined
    ? undefined
    : { object: value, keyId: first, key: keys[first] as string };
}

/** `verify_signature`: `signer`'s signature over `value`, under its owner and key id. */
function signedBy(
  value: Readonly<Record<string, unknown>>,
  userId: string,
  signer: CrossSigningKey,
): boolean {
  return hasValidSignature(value, userId, signer.keyId, signer.key);
}

function isEd25519Key(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9+/]{43}$/.test(value) &&
    Buffer.from(value, "base64").length === 32
  );
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
