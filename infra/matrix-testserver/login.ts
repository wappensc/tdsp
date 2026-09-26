/**
 * network-policy: loopback — Zone A (docs/network-policy.md). Test infrastructure: logs a test account into the local Synapse container on localhost:18008.
 */
import { BASE_URL } from "./config.ts";

/**
 * `POST /_matrix/client/v3/login` (`m.login.password`) — shared with
 * `provision-test-accounts.ts`, so that test files that need a *fresh*
 * device, not just a fresh access token, use the same verified request shape. `identifier.user` accepts
 * either a localpart or a full MXID (verified); callers here pass
 * whichever they already have on hand.
 *
 * **Why a test file would want this over `test-accounts.json`'s own
 * persisted `accessToken`**: that token names a *fixed* device, alive for
 * as long as the test Synapse container's volume persists across runs.
 * `crypto-machine.ts`'s `OlmMachine` store, in contrast, is created fresh
 * (a temp directory) every single test run — so a crypto machine built
 * from the persisted token tries to re-upload one-time keys starting
 * from index 0 against a device Synapse already has key history for,
 * and Synapse rejects the collision (`M_UNKNOWN: One time key ...
 * already exists`). Logging in fresh mints a brand-new device with no
 * prior key history, so a brand-new local store always matches it.
 * Tests that never touch a `CryptoMachine` (e.g. `createMatrixRoomReader`
 * alone) have no reason to use this — the persisted token is simpler and
 * carries no such mismatch.
 */
export async function loginFresh(
  user: string,
  password: string,
): Promise<{ userId: string; accessToken: string; deviceId: string }> {
  const response = await fetch(`${BASE_URL}/_matrix/client/v3/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "m.login.password",
      identifier: { type: "m.id.user", user },
      password,
    }),
  });
  const body = (await response.json()) as {
    user_id?: string;
    access_token?: string;
    device_id?: string;
    errcode?: string;
    error?: string;
  };
  if (!response.ok || !body.user_id || !body.access_token || !body.device_id) {
    throw new Error(`login ${user} failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return { userId: body.user_id, accessToken: body.access_token, deviceId: body.device_id };
}
