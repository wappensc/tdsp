import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * docs/testing.md starts the two Signal L4 bridges with their data under
 * `infra/signal-l4/credentials/<a|b>/`: a linked account's keys and its bind store. Those
 * must be unable to reach git through a stray `git add`. Runs against paths that need not
 * exist on disk.
 */
describe("infra/signal-l4 credential storage stays out of git", () => {
  for (const path of [
    "infra/signal-l4/credentials/a/data/accounts.json",
    "infra/signal-l4/credentials/a/tdsp-channels.json",
    "infra/signal-l4/credentials/b/bridge.sock",
  ]) {
    it(`ignores ${path}`, () => {
      expect(() => execFileSync("git", ["check-ignore", "-q", path])).not.toThrow();
    });
  }

  it("does NOT ignore the configuration it sits next to", () => {
    expect(() =>
      execFileSync("git", ["check-ignore", "-q", "infra/signal-l4/config.ts"]),
    ).toThrow();
  });
});
