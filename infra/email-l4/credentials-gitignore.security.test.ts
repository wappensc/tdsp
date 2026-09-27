import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * The bridges' own credentials-gitignore pattern, for the email L4 credentials: real passwords for real mailboxes must be unable to reach git
 * through a stray `git add`. Runs against paths that need not exist on disk.
 */
describe("infra/email-l4 credential storage stays out of git", () => {
  it("ignores credentials/.env.l4.email — the real credentials", () => {
    expect(() =>
      execFileSync("git", ["check-ignore", "-q", "infra/email-l4/credentials/.env.l4.email"]),
    ).not.toThrow();
  });

  it("ignores a stray .env.l4.email next to the template, too", () => {
    expect(() =>
      execFileSync("git", ["check-ignore", "-q", "infra/email-l4/.env.l4.email"]),
    ).not.toThrow();
  });

  it("does NOT ignore .env.l4.email.example — the committed placeholder", () => {
    expect(() =>
      execFileSync("git", ["check-ignore", "-q", "infra/email-l4/.env.l4.email.example"]),
    ).toThrow();
  });

  it("commits no real value in the template", () => {
    const template = execFileSync("cat", ["infra/email-l4/.env.l4.email.example"], {
      encoding: "utf8",
    });
    for (const line of template.split("\n")) {
      if (/^L4_MAIL_[AB]_(ADDRESS|AUTH_USER|PASS)=/.test(line)) {
        expect(line.split("=")[1]).toBe("");
      }
    }
  });
});
