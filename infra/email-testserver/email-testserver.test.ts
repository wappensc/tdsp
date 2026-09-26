import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { HOST, IMAP_PORT, SMTP_PORT } from "./config.ts";
import { hasTestEmailServer } from "./health.ts";

/**
 * The regression test of the test infrastructure itself — dependency-free (only `node:net`, no
 * `nodemailer`/`imapflow`), mirroring `infra/matrix-testserver`'s own
 * `fetch()`-only test: `infra/email-testserver` is not a pnpm workspace
 * package, so it has no `node_modules` of its own to resolve those
 * libraries from (verified: importing either here fails with
 * `Cannot find package`). The real send/receive round trip against
 * these same ports, using the actual libraries `bridges/email-bridge`
 * ships, lives in `bridges/email-bridge/src/mail-transport.test.ts`
 * instead, which does have them as real dependencies.
 */
const available = await hasTestEmailServer();

function readGreeting(host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, host, () => {});
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      socket.end();
    });
    socket.on("close", () => resolve(data));
    socket.on("error", reject);
    setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out waiting for a greeting"));
    }, 3000);
  });
}

describe.skipIf(!available)("local Greenmail test SMTP/IMAP server", () => {
  it("SMTP port answers with a real SMTP greeting", async () => {
    const greeting = await readGreeting(HOST, SMTP_PORT);
    expect(greeting).toContain("220");
    expect(greeting.toUpperCase()).toContain("GREENMAIL");
  });

  it("IMAP port answers with a real IMAP greeting", async () => {
    const greeting = await readGreeting(HOST, IMAP_PORT);
    expect(greeting).toContain("* OK");
  });
});
