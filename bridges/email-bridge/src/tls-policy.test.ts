import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo, Socket } from "node:net";
import { createServer as createNetServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer } from "node:tls";
import { isLoopbackHost } from "@tdsp/loopback";
import { afterEach, describe, expect, it } from "vitest";
import {
  createImapReceiver,
  createNodemailerSender,
  imapClientOptions,
  smtpTransportOptions,
} from "./mail-transport.ts";
import { TLS_OPTIONS, tlsModeFor } from "./tls-policy.ts";

describe("tlsModeFor", () => {
  it("is implicit TLS whenever secure is set, wherever the host is", () => {
    expect(tlsModeFor("mail.gmx.net", true)).toBe("implicit");
    expect(tlsModeFor("127.0.0.1", true)).toBe("implicit");
  });

  it("requires STARTTLS towards any remote host, and allows plaintext only towards this machine", () => {
    expect(tlsModeFor("mail.gmx.net", false)).toBe("starttls-required");
    expect(tlsModeFor("10.0.0.5", false)).toBe("starttls-required");
    expect(tlsModeFor("127.0.0.1", false)).toBe("plaintext-loopback");
    expect(tlsModeFor("localhost", false)).toBe("plaintext-loopback");
  });

  it("can only be tightened: requireTls forces STARTTLS even on this machine, and nothing loosens a remote host", () => {
    expect(tlsModeFor("127.0.0.1", false, true)).toBe("starttls-required");
    expect(tlsModeFor("mail.gmx.net", false, false)).toBe("starttls-required");
  });
});

describe("the options handed to the libraries", () => {
  const hosts = [
    "mail.gmx.net",
    "imap.gmx.net",
    "10.1.2.3",
    "localhost.evil.example",
    "127.0.0.1",
    "localhost",
  ];
  const grid = hosts.flatMap((host) =>
    [true, false].flatMap((secure) =>
      [undefined, true, false].map((requireTls) => ({ host, secure, requireTls })),
    ),
  );
  const config = (c: { host: string; secure: boolean; requireTls: boolean | undefined }) => ({
    host: c.host,
    port: 465,
    secure: c.secure,
    ...(c.requireTls === undefined ? {} : { requireTls: c.requireTls }),
    address: "a@example.org",
    authUser: "a@example.org",
    pass: "secret",
  });

  it.each(grid)("never relaxes certificate verification or the protocol floor: %o", (c) => {
    for (const options of [smtpTransportOptions(config(c)), imapClientOptions(config(c))]) {
      expect(options.tls).toEqual({ rejectUnauthorized: true, minVersion: "TLSv1.2" });
    }
    expect(TLS_OPTIONS.rejectUnauthorized).toBe(true);
  });

  it.each(grid.filter((c) => !isLoopbackHost(c.host)))(
    "never allows a plaintext session towards a remote host, whatever the setting: %o",
    (c) => {
      const smtp = smtpTransportOptions(config(c));
      expect(smtp.secure || smtp.requireTLS).toBe(true);
      const imap = imapClientOptions(config(c));
      expect(imap.secure || imap.doSTARTTLS === true).toBe(true);
    },
  );

  it("asks nodemailer for implicit TLS or required STARTTLS, and never for opportunistic", () => {
    expect(
      smtpTransportOptions(config({ host: "mail.gmx.net", secure: true, requireTls: undefined })),
    ).toMatchObject({
      secure: true,
      requireTLS: false,
    });
    expect(
      smtpTransportOptions(config({ host: "mail.gmx.net", secure: false, requireTls: undefined })),
    ).toMatchObject({
      secure: false,
      requireTLS: true,
    });
  });

  it("asks imapflow for required STARTTLS explicitly, not its opportunistic default", () => {
    expect(
      imapClientOptions(config({ host: "imap.gmx.net", secure: false, requireTls: undefined }))
        .doSTARTTLS,
    ).toBe(true);
    expect(
      imapClientOptions(config({ host: "127.0.0.1", secure: false, requireTls: undefined }))
        .doSTARTTLS,
    ).toBe(false);
  });

  it("does not put the password anywhere but auth", () => {
    const options = smtpTransportOptions(
      config({ host: "mail.gmx.net", secure: true, requireTls: undefined }),
    );
    expect(JSON.stringify({ ...options, auth: undefined })).not.toContain("secret");
  });
});

/**
 * A server that speaks just enough of a protocol to say what it was offered, and
 * records every line a client sent it — so "the credential was never sent" is an
 * observation, not an inference.
 */
function fakeServer(
  respond: (line: string, write: (text: string) => void) => void,
  greeting: string,
): Promise<{ server: Server; port: number; received: string[] }> {
  const received: string[] = [];
  const sockets = new Set<Socket>();
  const server = createNetServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.write(greeting);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\r\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        received.push(line);
        respond(line, (text) => socket.write(text));
        index = buffer.indexOf("\r\n");
      }
    });
    socket.on("error", () => undefined);
  });
  const close = server.close.bind(server);
  // A client that keeps its connection open must not make a test hang on teardown.
  server.close = ((callback?: (error?: Error) => void) => {
    for (const socket of sockets) {
      socket.destroy();
    }
    return close(callback);
  }) as typeof server.close;
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: (server.address() as AddressInfo).port, received }),
    );
  });
}

const smtpWithoutStartTls = () =>
  fakeServer((line, write) => {
    if (line.startsWith("EHLO") || line.startsWith("HELO")) {
      write("250-fake\r\n250 AUTH PLAIN LOGIN\r\n"); // no STARTTLS offered
    } else if (line.startsWith("AUTH")) {
      write("535 no\r\n");
    } else if (line.startsWith("QUIT")) {
      write("221 bye\r\n");
    } else {
      write("500 no\r\n");
    }
  }, "220 fake ESMTP\r\n");

const imapWithoutStartTls = () =>
  fakeServer((line, write) => {
    const [tag, command] = line.split(" ");
    if (command === "CAPABILITY") {
      write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n${tag} OK done\r\n`); // no STARTTLS offered
    } else if (command === "ID") {
      write(`* ID NIL\r\n${tag} OK done\r\n`);
    } else if (command === "LOGIN" || command === "AUTHENTICATE") {
      write(`${tag} NO nope\r\n`);
    } else {
      write(`${tag} OK done\r\n`);
    }
  }, "* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] fake\r\n");

const credentialWasOffered = (lines: string[]) =>
  lines.some((line) => /^(AUTH|\S+ (LOGIN|AUTHENTICATE))\b/.test(line));

describe("the real libraries, against a server that does not offer TLS", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  const smtpConfig = (port: number, requireTls: boolean) => ({
    host: "127.0.0.1",
    port,
    secure: false,
    requireTls,
    address: "a@example.org",
    authUser: "a@example.org",
    pass: "hunter2",
  });

  it("nodemailer refuses to authenticate or send when STARTTLS is required and not offered", async () => {
    const fake = await smtpWithoutStartTls();
    servers.push(fake.server);
    const sender = createNodemailerSender(smtpConfig(fake.port, true));
    await expect(sender.verify()).rejects.toThrow();
    await expect(
      sender.send({ to: ["b@example.org"], subject: "s", text: "t", documentId: "d" }),
    ).rejects.toThrow();
    expect(credentialWasOffered(fake.received)).toBe(false);
    expect(fake.received.some((line) => line.startsWith("MAIL FROM"))).toBe(false);
    expect(fake.received.join("\n")).not.toContain("hunter2");
  });

  it("…while the same server, asked without the requirement, is sent the credential — so the assertion above means something", async () => {
    const fake = await smtpWithoutStartTls();
    servers.push(fake.server);
    await createNodemailerSender(smtpConfig(fake.port, false))
      .verify()
      .catch(() => undefined);
    expect(credentialWasOffered(fake.received)).toBe(true);
  });

  it("imapflow refuses to authenticate when STARTTLS is required and not offered", async () => {
    const fake = await imapWithoutStartTls();
    servers.push(fake.server);
    const receiver = createImapReceiver({
      host: "127.0.0.1",
      port: fake.port,
      secure: false,
      requireTls: true,
      authUser: "a@example.org",
      pass: "hunter2",
    });
    await expect(receiver.verify()).rejects.toThrow();
    expect(credentialWasOffered(fake.received)).toBe(false);
    expect(fake.received.join("\n")).not.toContain("hunter2");
  });

  it("…while the same IMAP server, asked without the requirement, is offered the credential", async () => {
    const fake = await imapWithoutStartTls();
    servers.push(fake.server);
    await createImapReceiver({
      host: "127.0.0.1",
      port: fake.port,
      secure: false,
      authUser: "a@example.org",
      pass: "hunter2",
    })
      .verify()
      .catch(() => undefined);
    expect(credentialWasOffered(fake.received)).toBe(true);
  });
});

/**
 * Implicit TLS is only worth anything if the certificate is checked. A server
 * presenting a self-signed certificate must be refused — before any credential —
 * and the reason must be the certificate, not something else.
 */
function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasOpenssl())("the real libraries, against an untrusted certificate", () => {
  let dir = "";
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function selfSignedServer(greeting: string, received: string[]) {
    dir = mkdtempSync(join(tmpdir(), "eb-tls-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    const server = createTlsServer(
      { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) },
      (socket) => {
        socket.write(greeting);
        socket.on("data", (chunk) => received.push(chunk.toString("utf8")));
        socket.on("error", () => undefined);
      },
    );
    servers.push(server);
    return new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    });
  }

  it("nodemailer refuses a self-signed certificate over implicit TLS, naming the certificate, before any credential", async () => {
    const received: string[] = [];
    const port = await selfSignedServer("220 fake ESMTP\r\n", received);
    const sender = createNodemailerSender({
      host: "127.0.0.1",
      port,
      secure: true,
      address: "a@example.org",
      authUser: "a@example.org",
      pass: "hunter2",
    });
    await expect(sender.verify()).rejects.toThrow(/self.signed|certificate/i);
    expect(received.join("")).not.toContain("hunter2");
  });

  it("imapflow refuses a self-signed certificate over implicit TLS, naming the certificate, before any credential", async () => {
    const received: string[] = [];
    const port = await selfSignedServer("* OK fake\r\n", received);
    const receiver = createImapReceiver({
      host: "127.0.0.1",
      port,
      secure: true,
      authUser: "a@example.org",
      pass: "hunter2",
    });
    await expect(receiver.verify()).rejects.toThrow(/self.signed|certificate/i);
    expect(received.join("")).not.toContain("hunter2");
  });
});
