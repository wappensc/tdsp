/**
 * network-policy: loopback — Zone A (docs/network-policy.md). Test infrastructure: gives a test
 * account on the local Synapse container a cross-signing identity, and signs a test device with it.
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
} from "node:crypto";
import { BASE_URL, TEST_ACCOUNT_PASSWORD } from "./config.ts";

/**
 * A test account's cross-signing identity (bindings/matrix.md MTX-4): its master key and the
 * self-signing key the master key signed, as PKCS #8 DER in Base64. Private, but of a throwaway
 * account on a server on this machine, kept in the ignored `credentials/` with the account's
 * access token. A Matrix app keeps these keys in Secret Storage behind a recovery key, which is
 * what `pnpm run matrix:confirm-device` reads (docs/matrix-device-confirmation.md); the tests that
 * need many signed devices sign each with the self-signing key directly, so that this module needs
 * nothing but `node:crypto`.
 */
export interface TestIdentity {
  readonly masterKey: string;
  readonly selfSigningKey: string;
}

async function call(
  token: string,
  path: string,
  body: unknown,
): Promise<{ status: number; text: string }> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

const unpadded = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64").replace(/=+$/, "");

/** Matrix's canonical JSON: keys in code point order, no whitespace (the client-server API, appendix). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const publicOf = (key: KeyObject): string =>
  unpadded(createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32));

const privateOf = (der: string): KeyObject =>
  createPrivateKey({ key: Buffer.from(der, "base64"), format: "der", type: "pkcs8" });

/** `value` signed by `key` as `userId`, its `signatures` and `unsigned` left out of what is signed. */
function signed<T extends Record<string, unknown>>(value: T, userId: string, key: KeyObject): T {
  const { signatures, unsigned: _unsigned, ...content } = value;
  const signature = unpadded(sign(null, Buffer.from(canonicalJson(content), "utf8"), key));
  const existing = (signatures ?? {}) as Record<string, Record<string, string>>;
  return {
    ...value,
    signatures: {
      ...existing,
      [userId]: { ...(existing[userId] ?? {}), [`ed25519:${publicOf(key)}`]: signature },
    },
  };
}

const crossSigningKey = (userId: string, usage: string, key: KeyObject) => ({
  user_id: userId,
  usage: [usage],
  keys: { [`ed25519:${publicOf(key)}`]: publicOf(key) },
});

/**
 * Gives `username`'s account a new cross-signing identity — a master key, and a self-signing and a
 * user-signing key it signs — and returns its private keys. Replaces an identity the account had.
 */
export async function createTestIdentity(
  login: { readonly userId: string; readonly accessToken: string },
  username: string,
): Promise<TestIdentity> {
  const master = generateKeyPairSync("ed25519").privateKey;
  const selfSigning = generateKeyPairSync("ed25519").privateKey;
  const userSigning = generateKeyPairSync("ed25519").privateKey;
  const body = {
    master_key: crossSigningKey(login.userId, "master", master),
    self_signing_key: signed(
      crossSigningKey(login.userId, "self_signing", selfSigning),
      login.userId,
      master,
    ),
    user_signing_key: signed(
      crossSigningKey(login.userId, "user_signing", userSigning),
      login.userId,
      master,
    ),
  };
  const path = "/_matrix/client/v3/keys/device_signing/upload";
  let upload = await call(login.accessToken, path, body);
  if (upload.status === 401) {
    // User-interactive authentication, which Synapse asks for once an identity exists.
    const { session } = JSON.parse(upload.text) as { session?: string };
    upload = await call(login.accessToken, path, {
      ...body,
      auth: {
        type: "m.login.password",
        identifier: { type: "m.id.user", user: username },
        password: TEST_ACCOUNT_PASSWORD,
        session,
      },
    });
  }
  if (upload.status !== 200) {
    throw new Error(
      `uploading ${login.userId}'s cross-signing keys failed: ${upload.status} ${upload.text}`,
    );
  }
  const der = (key: KeyObject) =>
    Buffer.from(key.export({ format: "der", type: "pkcs8" })).toString("base64");
  return { masterKey: der(master), selfSigningKey: der(selfSigning) };
}

/**
 * Signs `deviceId` of the account with its identity's self-signing key, as the homeserver lists
 * the device's keys: what a person does when they confirm a new device of theirs (MTX-4). The
 * device must have uploaded its keys.
 */
export async function signTestDevice(
  login: { readonly userId: string; readonly accessToken: string },
  identity: TestIdentity,
  deviceId: string,
): Promise<void> {
  const query = JSON.parse(
    (
      await call(login.accessToken, "/_matrix/client/v3/keys/query", {
        device_keys: { [login.userId]: [deviceId] },
      })
    ).text,
  ) as { device_keys?: Record<string, Record<string, Record<string, unknown>>> };
  const device = query.device_keys?.[login.userId]?.[deviceId];
  if (device === undefined) {
    throw new Error(`${login.userId}'s device ${deviceId} has uploaded no keys to sign`);
  }
  const { unsigned: _unsigned, ...keys } = device;
  const selfSigned = signed(keys, login.userId, privateOf(identity.selfSigningKey));
  const upload = await call(login.accessToken, "/_matrix/client/v3/keys/signatures/upload", {
    [login.userId]: { [deviceId]: selfSigned },
  });
  const failures =
    (JSON.parse(upload.text) as { failures?: Record<string, unknown> }).failures ?? {};
  if (upload.status !== 200 || Object.keys(failures).length > 0) {
    throw new Error(
      `signing ${login.userId}'s device ${deviceId} failed: ${upload.status} ${upload.text}`,
    );
  }
}
