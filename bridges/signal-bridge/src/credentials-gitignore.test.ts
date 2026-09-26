import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * Confirms, rather than assumes, that credential and configuration storage
 * stays out of git (SPECIFICATION.md §12.1). Runs against paths that need not
 * exist on disk — `git check-ignore` only consults .gitignore's patterns, so
 * this passes on a fresh clone with no bridges/signal-bridge/.env or
 * credentials/ present.
 */
describe("bridges/signal-bridge credential/config storage stays out of git", () => {
  it("ignores .env", () => {
    expect(() =>
      execFileSync("git", ["check-ignore", "-q", "bridges/signal-bridge/.env"]),
    ).not.toThrow();
  });

  it("ignores everything under credentials/", () => {
    expect(() =>
      execFileSync("git", [
        "check-ignore",
        "-q",
        "bridges/signal-bridge/credentials/some-account/config",
      ]),
    ).not.toThrow();
  });

  it("does NOT ignore .env.example — the committed placeholder", () => {
    expect(() =>
      execFileSync("git", ["check-ignore", "-q", "bridges/signal-bridge/.env.example"]),
    ).toThrow();
  });
});
