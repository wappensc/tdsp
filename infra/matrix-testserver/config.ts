import { fileURLToPath } from "node:url";

/**
 * Shared constants for the local Matrix test homeserver. Kept in one place so
 * `generate-config.ts`, `wait-for-health.ts`, `provision-test-accounts.ts`,
 * and the test files that gate on `hasTestMatrixHomeserver()` cannot drift
 * apart on the port or the account names.
 *
 * `server_name: tdsp.test` is not a resolvable domain — fine,
 * federation is disabled for this server (see `generate-config.ts`'s test
 * overrides), and Matrix only needs `server_name` to be syntactically
 * valid, not reachable, for a client-only, non-federating deployment.
 */

/** Pinned, not `:latest` — reproducible across machines and CI. */
export const SYNAPSE_IMAGE = "matrixdotorg/synapse:v1.159.0";

export const SERVER_NAME = "tdsp.test";

/** Host-side port `docker-compose.yml` publishes Synapse's client API on. */
export const HOST_PORT = 18008;

export const BASE_URL = `http://localhost:${HOST_PORT}`;

export const HEALTH_URL = `${BASE_URL}/health`;

/** Where `docker-compose.yml` mounts the container's `/data` — generated config, signing key, sqlite db, and `test-accounts.json` all live here. Gitignored via the repo's existing bare `credentials/` pattern. */
export const CREDENTIALS_DIR = fileURLToPath(new URL("credentials/", import.meta.url));

export const HOMESERVER_YAML_PATH = `${CREDENTIALS_DIR}homeserver.yaml`;

export const TEST_ACCOUNTS_PATH = `${CREDENTIALS_DIR}test-accounts.json`;

/**
 * Fixed test identities provisioned by `provision-test-accounts.ts`.
 * Real passwords for a throwaway, non-federating local/CI-only server —
 * not a secret worth generating randomly (the `credentials/` gitignore pattern
 * keeps it out of git regardless).
 */
export const TEST_ACCOUNTS = ["alice", "bob"] as const;
export const TEST_ACCOUNT_PASSWORD = "tdsp-test-account-password";
