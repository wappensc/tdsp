import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The L4 specs send real mail from real accounts, which a provider limits, so they must
 * never run by accident: a plain `pnpm run test` skips them even when the credentials
 * file exists — otherwise a full test run would start sending real mail. This starts
 * a real Vitest run of each L4 file with a *complete* configuration in the environment —
 * pointing at `mail.invalid`, which cannot resolve, so that a regression fails loudly
 * instead of sending anything — and without `L4_EMAIL=1`, and requires every test to be
 * skipped.
 */
// `vitest/vitest.mjs` is not an exported subpath; its package directory is.
const vitest = join(
  dirname(createRequire(import.meta.url).resolve("vitest/package.json")),
  "vitest.mjs",
);

function creds(role: "A" | "B"): Record<string, string> {
  const address = `${role.toLowerCase()}-optin-check@mail.invalid`;
  return {
    [`L4_MAIL_${role}_ADDRESS`]: address,
    [`L4_MAIL_${role}_PASS`]: "not-a-real-password",
    [`L4_MAIL_${role}_SMTP_HOST`]: "mail.invalid",
    [`L4_MAIL_${role}_SMTP_PORT`]: "465",
    [`L4_MAIL_${role}_SMTP_SECURE`]: "true",
    [`L4_MAIL_${role}_IMAP_HOST`]: "mail.invalid",
    [`L4_MAIL_${role}_IMAP_PORT`]: "993",
    [`L4_MAIL_${role}_IMAP_SECURE`]: "true",
  };
}

describe("the email L4 specs are opt-in", () => {
  it.each(["l4-provider.test.ts", "l4-bridges.test.ts"])(
    "%s skips every test without L4_EMAIL=1, even with a complete configuration in the environment",
    (file) => {
      // Bridges on a loopback port nothing listens on: a regression finds no bridge, not a mailbox.
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...creds("A"),
        ...creds("B"),
        L4_EMAIL_BRIDGE_A: "http://127.0.0.1:1",
        L4_EMAIL_BRIDGE_B: "http://127.0.0.1:1",
      };
      env.L4_EMAIL = undefined;
      env.L4_EMAIL_CONTRACT = undefined;
      const output = execFileSync(
        process.execPath,
        [vitest, "run", `bridges/email-bridge/src/${file}`, "--reporter=json"],
        { encoding: "utf8", env: env as NodeJS.ProcessEnv },
      );
      const report = JSON.parse(output.slice(output.indexOf("{"))) as {
        numTotalTests: number;
        numPassedTests: number;
        numFailedTests: number;
        numPendingTests: number;
      };
      expect(report.numTotalTests).toBeGreaterThan(0);
      expect(report.numPassedTests).toBe(0);
      expect(report.numFailedTests).toBe(0);
      expect(report.numPendingTests).toBe(report.numTotalTests);
    },
    60_000,
  );
});
