import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * The Matrix and Signal bridges' identical pattern (SPECIFICATION.md §12.1). Runs against paths that need
 * not exist on disk — `git check-ignore` only consults `.gitignore`'s
 * patterns.
 */
describe("bridges/email-bridge credential/config storage stays out of git", () => {
  it("ignores .env", () => {
    expect(() =>
      execFileSync("git", ["check-ignore", "-q", "bridges/email-bridge/.env"]),
    ).not.toThrow();
  });

  it("ignores everything under credentials/", () => {
    expect(() =>
      execFileSync("git", [
        "check-ignore",
        "-q",
        "bridges/email-bridge/credentials/tdsp-threads.json",
      ]),
    ).not.toThrow();
  });

  it("does NOT ignore .env.example — the committed placeholder", () => {
    expect(() =>
      execFileSync("git", ["check-ignore", "-q", "bridges/email-bridge/.env.example"]),
    ).toThrow();
  });
});
