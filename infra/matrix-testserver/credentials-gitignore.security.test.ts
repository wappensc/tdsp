import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * `bridges/signal-bridge/src/credentials-gitignore.security.test.ts`'s pattern,
 * applied to this server's own generated secrets (registration shared
 * secret, signing key, sqlite db, test account access tokens) — confirms,
 * not assumes, that they stay out of git. Runs against paths that need
 * not exist on disk, same as the Signal version: `git check-ignore` only
 * consults .gitignore's patterns.
 */
describe("infra/matrix-testserver credential/config storage stays out of git", () => {
  it("ignores everything under credentials/", () => {
    expect(() =>
      execFileSync("git", [
        "check-ignore",
        "-q",
        "infra/matrix-testserver/credentials/homeserver.yaml",
      ]),
    ).not.toThrow();
  });

  it("ignores the generated test-accounts.json specifically", () => {
    expect(() =>
      execFileSync("git", [
        "check-ignore",
        "-q",
        "infra/matrix-testserver/credentials/test-accounts.json",
      ]),
    ).not.toThrow();
  });

  it("does NOT ignore homeserver.yaml.example — the committed placeholder", () => {
    expect(() =>
      execFileSync("git", [
        "check-ignore",
        "-q",
        "infra/matrix-testserver/homeserver.yaml.example",
      ]),
    ).toThrow();
  });
});
