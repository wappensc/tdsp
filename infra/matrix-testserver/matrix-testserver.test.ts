import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { BASE_URL, TEST_ACCOUNTS_PATH } from "./config.ts";
import { hasTestMatrixHomeserver } from "./health.ts";

interface Accounts {
  alice: { userId: string; accessToken: string };
  bob: { userId: string; accessToken: string };
  rooms: { plain: string; encrypted: string };
}

/**
 * The regression test of the local test homeserver itself — runs against a real, already-provisioned local Synapse (`matrix:up`
 * locally, or the CI job's equivalent steps), never against a mock or
 * assumption. Gated by `hasTestMatrixHomeserver()`, the same
 * `describe.skipIf` pattern `bridges/signal-bridge` uses for `hasSignalCli()`
 * — verified that Vitest's Vite-based pipeline
 * supports a top-level `await` immediately before `describe` (no
 * `beforeAll`+`ctx.skip()` fallback needed for *that* part).
 *
 * `TEST_ACCOUNTS_PATH` is read inside `beforeAll`, not at the top of the
 * `describe` body: `describe.skipIf` skips a suite's *tests and hooks*, but Vitest still
 * *executes* the `describe` callback itself during collection to find
 * out what to skip. A plain `readFileSync` sitting directly in that
 * callback body would run unconditionally even when `available` is `false`,
 * crashing on a clean checkout with no `credentials/test-accounts.json`
 * yet — this is exactly the "credentials dir doesn't exist" case the
 * gate exists to handle gracefully. `beforeAll` genuinely does not run
 * for a skipped suite, so the read only happens when there's something
 * to read.
 */
const available = await hasTestMatrixHomeserver();

describe.skipIf(!available)("local Matrix test homeserver", () => {
  let accounts: Accounts;

  beforeAll(() => {
    accounts = JSON.parse(readFileSync(TEST_ACCOUNTS_PATH, "utf8")) as Accounts;
  });

  it("answers /_matrix/client/versions", async () => {
    const response = await fetch(`${BASE_URL}/_matrix/client/versions`);
    expect(response.ok).toBe(true);
    const body = (await response.json()) as { versions: string[] };
    expect(body.versions.length).toBeGreaterThan(0);
  });

  it("logs alice and bob in with their provisioned password", async () => {
    for (const account of [accounts.alice, accounts.bob]) {
      const response = await fetch(`${BASE_URL}/_matrix/client/v3/account/whoami`, {
        headers: { authorization: `Bearer ${account.accessToken}` },
      });
      expect(response.ok).toBe(true);
      const body = (await response.json()) as { user_id: string };
      expect(body.user_id).toBe(account.userId);
    }
  });

  it("has bob joined to both the plain and the encrypted test room", async () => {
    const response = await fetch(`${BASE_URL}/_matrix/client/v3/joined_rooms`, {
      headers: { authorization: `Bearer ${accounts.bob.accessToken}` },
    });
    expect(response.ok).toBe(true);
    const body = (await response.json()) as { joined_rooms: string[] };
    expect(body.joined_rooms).toContain(accounts.rooms.plain);
    expect(body.joined_rooms).toContain(accounts.rooms.encrypted);
  });

  it("reports encryption state honestly for each room (the read-only check binding relies on)", async () => {
    const plainState = await fetch(
      `${BASE_URL}/_matrix/client/v3/rooms/${encodeURIComponent(accounts.rooms.plain)}/state/m.room.encryption/`,
      { headers: { authorization: `Bearer ${accounts.alice.accessToken}` } },
    );
    expect(plainState.status).toBe(404);

    const encryptedState = await fetch(
      `${BASE_URL}/_matrix/client/v3/rooms/${encodeURIComponent(accounts.rooms.encrypted)}/state/m.room.encryption/`,
      { headers: { authorization: `Bearer ${accounts.alice.accessToken}` } },
    );
    expect(encryptedState.ok).toBe(true);
    const body = (await encryptedState.json()) as { algorithm: string };
    expect(body.algorithm).toBe("m.megolm.v1.aes-sha2");
  });
});
