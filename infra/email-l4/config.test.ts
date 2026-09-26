import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emailL4Status, parseEnvFile } from "./config.ts";

const COMPLETE = `
# comment
L4_MAIL_A_ADDRESS=alice@example.net
L4_MAIL_A_PASS="p a s s"
L4_MAIL_A_SMTP_HOST=mail.gmx.net
L4_MAIL_A_SMTP_PORT=465
L4_MAIL_A_SMTP_SECURE=true
L4_MAIL_A_IMAP_HOST=imap.gmx.net
L4_MAIL_A_IMAP_PORT=993
L4_MAIL_A_IMAP_SECURE=true
L4_MAIL_B_ADDRESS=bob@example.net
L4_MAIL_B_AUTH_USER=bob-login
L4_MAIL_B_PASS='other'
L4_MAIL_B_SMTP_HOST=mail.gmx.net
L4_MAIL_B_SMTP_PORT=587
L4_MAIL_B_SMTP_SECURE=false
L4_MAIL_B_IMAP_HOST=imap.gmx.net
L4_MAIL_B_IMAP_PORT=993
L4_MAIL_B_IMAP_SECURE=true
`;

describe("parseEnvFile", () => {
  it("reads KEY=VALUE, skipping comments and blanks, and unquotes one matching pair", () => {
    expect(parseEnvFile("# c\n\nA=1\nB = \"two words\"\nC='x'\nD=\nnot a pair\n=novalue")).toEqual({
      A: "1",
      B: "two words",
      C: "x",
      D: "",
    });
  });

  it("keeps an '=' inside a value, as in a password", () => {
    expect(parseEnvFile("P=ab=cd==")).toEqual({ P: "ab=cd==" });
  });
});

describe("emailL4Status", () => {
  let dir = "";
  let file = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "email-l4-"));
    file = join(dir, ".env.l4.email");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (text: string, mode = 0o600) => {
    writeFileSync(file, text);
    chmodSync(file, mode);
  };

  it("is absent, not invalid, when nothing is configured — so the L4 specs skip quietly", () => {
    expect(emailL4Status({ env: {}, file })).toEqual({ state: "absent" });
  });

  it("is ready for a complete file, defaulting the login to the address", () => {
    write(COMPLETE);
    const status = emailL4Status({ env: {}, file });
    expect(status.state).toBe("ready");
    if (status.state !== "ready") {
      return;
    }
    expect(status.config.a).toMatchObject({
      address: "alice@example.net",
      authUser: "alice@example.net",
      pass: "p a s s",
      smtp: { host: "mail.gmx.net", port: 465, secure: true },
      imap: { host: "imap.gmx.net", port: 993, secure: true },
    });
    expect(status.config.b).toMatchObject({
      authUser: "bob-login",
      smtp: { port: 587, secure: false },
    });
  });

  it("lets an environment variable win over the file", () => {
    write(COMPLETE);
    const status = emailL4Status({ env: { L4_MAIL_A_PASS: "from-env" }, file });
    expect(status.state === "ready" && status.config.a.pass).toBe("from-env");
  });

  it("works from the environment alone", () => {
    const env = Object.fromEntries(
      Object.entries(parseEnvFile(COMPLETE)).map(([key, value]) => [key, value]),
    );
    expect(emailL4Status({ env, file }).state).toBe("ready");
  });

  it("names every missing value rather than reporting 'not configured' once something is set", () => {
    write("L4_MAIL_A_ADDRESS=alice@example.net\n");
    const status = emailL4Status({ env: {}, file });
    expect(status.state).toBe("invalid");
    if (status.state !== "invalid") {
      return;
    }
    expect(status.problems).toEqual(
      expect.arrayContaining([
        "L4_MAIL_A_PASS is not set",
        "L4_MAIL_A_SMTP_HOST is not set",
        "L4_MAIL_B_ADDRESS is not set",
      ]),
    );
  });

  it.each([
    [
      "a non-numeric port",
      COMPLETE.replace("SMTP_PORT=465", "SMTP_PORT=abc"),
      "must be a port number",
    ],
    [
      "SECURE that is not true/false",
      COMPLETE.replace("A_SMTP_SECURE=true", "A_SMTP_SECURE=yes"),
      'must be "true" or "false"',
    ],
    [
      "implicit-TLS port with SECURE=false",
      COMPLETE.replace("A_IMAP_SECURE=true", "A_IMAP_SECURE=false"),
      "speaks implicit TLS",
    ],
    [
      "a STARTTLS port with SECURE=true",
      COMPLETE.replace("B_SMTP_SECURE=false", "B_SMTP_SECURE=true"),
      "speaks STARTTLS",
    ],
    [
      "the same mailbox twice",
      COMPLETE.replace("bob@example.net", "alice@example.net"),
      "two different mailboxes",
    ],
    [
      "an address that is not one",
      COMPLETE.replace("alice@example.net", "not an address"),
      "not a single email address",
    ],
  ])("rejects %s, saying what is wrong", (_name, text, expected) => {
    write(text);
    const status = emailL4Status({ env: {}, file });
    expect(status.state).toBe("invalid");
    expect(status.state === "invalid" && status.problems.join("\n")).toContain(expected);
  });

  it("refuses a credentials file other users can read, and says how to fix it", () => {
    write(COMPLETE, 0o644);
    const status = emailL4Status({ env: {}, file });
    expect(status.state).toBe("invalid");
    expect(status.state === "invalid" && status.problems.join("\n")).toContain("chmod 600");
  });
});
