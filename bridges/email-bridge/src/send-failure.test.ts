import type { AddressInfo, Socket } from "node:net";
import { createServer as createNetServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createNodemailerSender, RecipientsRefusedError } from "./mail-transport.ts";
import { classifySendFailure } from "./send-failure";

const smtp = (responseCode: number, response = "") =>
  Object.assign(new Error(`Mail command failed: ${response}`), { responseCode, response });

/** What nodemailer throws for a refused login: `code` EAUTH, the reply and its code. */
const login = (response: string) =>
  Object.assign(new Error(`Invalid login: ${response}`), {
    code: "EAUTH",
    response,
    responseCode: Number(response.slice(0, 3)),
    command: "AUTH PLAIN",
  });

/** What nodemailer throws when every recipient was refused: each refusal in `rejectedErrors`. */
const everyRecipientRefused = (...responses: string[]) =>
  Object.assign(smtp(Number(responses.at(-1)?.slice(0, 3)), responses.at(-1)), {
    code: "EENVELOPE",
    rejectedErrors: responses.map((response) => smtp(Number(response.slice(0, 3)), response)),
  });

describe("classifySendFailure", () => {
  it("reads GMX's own refusal, a 450, as a rate limit", () => {
    expect(
      classifySendFailure(smtp(450, "450 Requested mail action not taken: mailbox unavailable")),
    ).toEqual({ status: 429 });
  });

  it.each([421, 451, 452])("reads a %i, any 4xx reply, as a rate limit", (code) => {
    expect(classifySendFailure(smtp(code)).status).toBe(429);
  });

  it("reads 552 as too large", () => {
    expect(classifySendFailure(smtp(552)).status).toBe(413);
  });

  it("reads 552 5.3.4 and 552 5.2.3, a message too big (RFC 3463), as too large", () => {
    expect(classifySendFailure(smtp(552, "552 5.3.4 Message too big for system")).status).toBe(413);
    expect(classifySendFailure(smtp(552, "552 5.2.3 Message length exceeds limit")).status).toBe(
      413,
    );
  });

  it.each(["ECONNECTION", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ESOCKET", "EDNS"])(
    "reads %s, a failure to reach the server, as unavailable",
    (code) => {
      expect(classifySendFailure(Object.assign(new Error("x"), { code })).status).toBe(503);
    },
  );

  it.each([550, 553, 554])(
    "does not single out a permanent %i reply: it stays a retryable failure, so no edit is dropped on a guess",
    (code) => {
      expect(classifySendFailure(smtp(code)).status).toBe(502);
    },
  );

  it("answers 502 for anything it does not recognise, including things that are not errors", () => {
    expect(classifySendFailure(new Error("boom")).status).toBe(502);
    expect(classifySendFailure("boom").status).toBe(502);
    expect(classifySendFailure(undefined).status).toBe(502);
    expect(classifySendFailure(null).status).toBe(502);
  });

  describe("a refusal only a person can lift is needs-person, 409 (BRG-8, TRN-11)", () => {
    it.each([
      "535 5.7.8 Authentication credentials invalid",
      "534 5.7.9 Authentication mechanism is too weak",
      "538 5.7.11 Encryption required for requested authentication mechanism",
    ])("a login the server refused for good: %s", (response) => {
      expect(classifySendFailure(login(response)).status).toBe(409);
    });

    it("a login nodemailer refuses before asking the server, for want of credentials", () => {
      const error = Object.assign(new Error('Missing credentials for "PLAIN"'), {
        code: "EAUTH",
        command: "API",
      });
      expect(classifySendFailure(error).status).toBe(409);
    });

    it("a 530, the server wanting a login (RFC 4954) or STARTTLS first (RFC 3207)", () => {
      expect(classifySendFailure(smtp(530, "530 5.7.0 Authentication required")).status).toBe(409);
    });

    it("a mailbox full for good, 5.2.2 (RFC 3463), at RCPT for every recipient or after DATA", () => {
      expect(
        classifySendFailure(
          everyRecipientRefused("552 5.2.2 Mailbox full", "550 5.2.2 Mailbox full"),
        ).status,
      ).toBe(409);
      expect(classifySendFailure(smtp(552, "552 5.2.2 Mailbox full")).status).toBe(409);
    });
  });

  describe("and nothing else is", () => {
    it("a temporary login failure, 454 4.7.0, stays a rate limit: waiting lifts it", () => {
      expect(classifySendFailure(login("454 4.7.0 Temporary authentication failure")).status).toBe(
        429,
      );
    });

    it("a temporarily full mailbox, 452 4.2.2, stays a rate limit", () => {
      expect(classifySendFailure(smtp(452, "452 4.2.2 Mailbox full")).status).toBe(429);
    });

    it("every recipient refused, but not every one for a full mailbox, is not needs-person", () => {
      expect(
        classifySendFailure(
          everyRecipientRefused("552 5.2.2 Mailbox full", "550 5.1.1 No such user"),
        ).status,
      ).not.toBe(409);
    });

    it("a refusal for some recipients only stays EML-11's: final when one was permanent, a full mailbox included", () => {
      expect(classifySendFailure(new RecipientsRefusedError(["b@example.org"], false)).status).toBe(
        422,
      );
      expect(classifySendFailure(new RecipientsRefusedError(["b@example.org"], true)).status).toBe(
        429,
      );
    });
  });
});

/**
 * A mail server that answers each SMTP command as the test says, so that what nodemailer
 * (a vendor library) makes of a reply is observed, not assumed.
 */
function scriptedSmtpServer(script: {
  auth?: string;
  rcpt?: (line: string) => string;
  afterData?: string;
}): Promise<{ server: Server; port: number }> {
  const sockets = new Set<Socket>();
  const server = createNetServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.write("220 fake ESMTP\r\n");
    let buffer = "";
    let inData = false;
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\r\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf("\r\n");
        if (inData) {
          if (line === ".") {
            inData = false;
            socket.write(script.afterData ?? "250 queued\r\n");
          }
        } else if (/^(EHLO|HELO)/.test(line)) {
          socket.write("250-fake\r\n250 AUTH PLAIN LOGIN\r\n");
        } else if (line.startsWith("AUTH")) {
          socket.write(script.auth ?? "235 ok\r\n");
        } else if (line.startsWith("RCPT")) {
          socket.write(script.rcpt?.(line) ?? "250 ok\r\n");
        } else if (line.startsWith("DATA")) {
          inData = true;
          socket.write("354 go on\r\n");
        } else if (line.startsWith("QUIT")) {
          socket.end("221 bye\r\n");
        } else {
          socket.write("250 ok\r\n");
        }
      }
    });
  });
  const close = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => {
    for (const socket of sockets) {
      socket.destroy();
    }
    return close(callback);
  }) as typeof server.close;
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: (server.address() as AddressInfo).port }),
    );
  });
}

describe("classifySendFailure, on what the real nodemailer throws", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  async function statusOfSendThrough(
    script: Parameters<typeof scriptedSmtpServer>[0],
  ): Promise<number> {
    const { server, port } = await scriptedSmtpServer(script);
    servers.push(server);
    const address = "a@example.org";
    const sender = createNodemailerSender({
      host: "127.0.0.1",
      port,
      secure: false,
      address,
      authUser: address,
      pass: "secret",
    });
    const failure = await sender
      .send({ to: ["b@example.org", "c@example.org"], subject: "s", text: "t", documentId: "d" })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeDefined();
    return classifySendFailure(failure).status;
  }

  it("a refused login, 535: needs-person", async () => {
    expect(
      await statusOfSendThrough({ auth: "535 5.7.8 Authentication credentials invalid\r\n" }),
    ).toBe(409);
  });

  it("a temporary login failure, 454: a rate limit", async () => {
    expect(
      await statusOfSendThrough({ auth: "454 4.7.0 Temporary authentication failure\r\n" }),
    ).toBe(429);
  });

  it("every recipient's mailbox full, 552 5.2.2 at RCPT: needs-person", async () => {
    expect(await statusOfSendThrough({ rcpt: () => "552 5.2.2 Mailbox full\r\n" })).toBe(409);
  });

  it("a message too big, 552 5.3.4 after DATA: too large", async () => {
    expect(
      await statusOfSendThrough({ afterData: "552 5.3.4 Message too big for system\r\n" }),
    ).toBe(413);
  });

  it("one recipient's mailbox full, the other accepted: EML-11's final refusal, 422", async () => {
    expect(
      await statusOfSendThrough({
        rcpt: (line) =>
          line.includes("b@example.org") ? "552 5.2.2 Mailbox full\r\n" : "250 ok\r\n",
      }),
    ).toBe(422);
  });
});
