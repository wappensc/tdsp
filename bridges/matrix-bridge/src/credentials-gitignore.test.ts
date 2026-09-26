import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * `bridges/signal-bridge/src/credentials-gitignore.test.ts`'s pattern:
 * confirms that the access token, the crypto store and the bind-store stay
 * out of git (SPECIFICATION.md §12.1). Runs against paths that
 * need not exist on disk — `git check-ignore` only consults
 * `.gitignore`'s patterns.
 */
describe("bridges/matrix-bridge credential/config storage stays out of git", () => {
  it("ignores .env", () => {
    expect(() =>
      execFileSync("git", ["check-ignore", "-q", "bridges/matrix-bridge/.env"]),
    ).not.toThrow();
  });

  it("ignores everything under credentials/", () => {
    expect(() =>
      execFileSync("git", [
        "check-ignore",
        "-q",
        "bridges/matrix-bridge/credentials/some-account/access-token",
      ]),
    ).not.toThrow();
  });

  it("does NOT ignore .env.example — the committed placeholder", () => {
    expect(() =>
      execFileSync("git", ["check-ignore", "-q", "bridges/matrix-bridge/.env.example"]),
    ).toThrow();
  });
});
