/**
 * Shared constants for the local Greenmail test SMTP/IMAP server. Kept in one place so `health.ts`,
 * `wait-for-health.ts`, and every test file that gates on
 * `hasTestEmailServer()` cannot drift apart on ports or account
 * credentials.
 *
 * Unlike Synapse (`infra/matrix-testserver`), Greenmail needs no
 * generated config, signing key, or database file — its test accounts
 * are fixed values baked directly into `docker-compose.yml`'s own
 * `GREENMAIL_OPTS`, verified to create real, independently authenticated
 * mailboxes at container startup. Real passwords for a throwaway,
 * local/CI-only server — not a secret worth generating randomly, the
 * same reasoning `infra/matrix-testserver/config.ts` already gives for
 * its own fixed test-account password.
 */

export const HOST = "127.0.0.1";

/** Greenmail's own "test" port offsets (3025/3143), not the standard SMTP/IMAP ports — verified from the image's own default `GREENMAIL_OPTS`. */
export const SMTP_PORT = 13025;
export const IMAP_PORT = 13143;

/** Greenmail's built-in REST/Swagger admin server — used here only as a liveness signal, not for account management (this project's own two fixed test accounts are provisioned via `GREENMAIL_OPTS` instead). */
export const API_PORT = 18080;
export const HEALTH_URL = `http://${HOST}:${API_PORT}/`;

interface TestAccount {
  /** The mailbox's own address — the `From:`/`MessengerPort` identity. */
  readonly address: string;
  /**
   * The SMTP AUTH/IMAP LOGIN — verified to be the short name
   * before the `@`, not the full address, under Greenmail's own
   * `login:password@domain` `-Dgreenmail.users` syntax. See
   * `bridges/email-bridge/src/mail-transport.ts`'s own doc comment for the
   * real bug this distinction fixed.
   */
  readonly authUser: string;
  readonly password: string;
}

export const ALICE: TestAccount = {
  address: "alice@example.org",
  authUser: "alice",
  password: "tdsp-test-account-password",
};

export const BOB: TestAccount = {
  address: "bob@example.org",
  authUser: "bob",
  password: "tdsp-test-account-password",
};
