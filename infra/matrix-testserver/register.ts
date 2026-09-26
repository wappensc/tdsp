/**
 * network-policy: loopback — Zone A (docs/network-policy.md). Test infrastructure: registers a throwaway account on the local Synapse container.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { BASE_URL, HOMESERVER_YAML_PATH, TEST_ACCOUNT_PASSWORD } from "./config.ts";

/**
 * Synapse's admin shared-secret registration API — shared with
 * `provision-test-accounts.ts`, so that
 * `crypto.test.ts` can register a throwaway third account ("carol", for
 * the history-caveat test) without duplicating the HMAC construction.
 * See `provision-test-accounts.ts`'s own doc comment for why this API
 * over `register_new_matrix_user`'s CLI or the client-facing
 * `/register` endpoint.
 */
async function readRegistrationSharedSecret(): Promise<string> {
  const yaml = readFileSync(HOMESERVER_YAML_PATH, "utf8");
  const secret = yaml.match(/^registration_shared_secret: "(.*)"$/m)?.[1];
  if (!secret) {
    throw new Error(`registration_shared_secret not found in ${HOMESERVER_YAML_PATH}`);
  }
  return secret;
}

/**
 * Idempotent: `M_USER_IN_USE` (a previous run already created this
 * account) is treated as success, not an error — the same tolerance
 * `provision-test-accounts.ts` always had, needed here too since
 * `crypto.test.ts` calls this on every run rather than gating on a
 * `test-accounts.json`-style existence check.
 */
export async function registerAccount(username: string): Promise<void> {
  const secret = await readRegistrationSharedSecret();
  const { nonce } = (await fetch(`${BASE_URL}/_synapse/admin/v1/register`).then((r) =>
    r.json(),
  )) as { nonce: string };
  const mac = createHmac("sha1", secret)
    .update([nonce, username, TEST_ACCOUNT_PASSWORD, "notadmin"].join("\0"), "utf8")
    .digest("hex");
  const response = await fetch(`${BASE_URL}/_synapse/admin/v1/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce, username, password: TEST_ACCOUNT_PASSWORD, admin: false, mac }),
  });
  const body = (await response.json()) as { errcode?: string; error?: string };
  if (!response.ok && body.errcode !== "M_USER_IN_USE") {
    throw new Error(`register ${username} failed: ${response.status} ${JSON.stringify(body)}`);
  }
}
