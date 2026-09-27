import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOCUMENT_HEADER, decodeEnvelope } from "./envelope.ts";
import { createNodemailerSender, MAX_INCOMING_MAIL_BYTES } from "./mail-transport.ts";
import { createServer } from "./server.ts";

/**
 * The email binding's wire, frozen (docs/testing.md, "Wire compatibility";
 * SPECIFICATION.md §13.4): for a document without PGP, exactly what the bridge hands its mail
 * library when it starts a thread and when it sends a frame — addresses, subject, the
 * document header, the thread references and the body — and how it reads a frame's body back.
 * The same bridge routes as in use, over the real sender, with only the SMTP connection
 * replaced. A difference is a wire change only the CI role may accept (tools/wire-lock.ts).
 * Only the CI role may change this file (.github/CODEOWNERS).
 */

const read = (relative: string): string =>
  readFileSync(new URL(`../../../${relative}`, import.meta.url), "utf8");

const WIRE = JSON.parse(read("wire/email-v1.json")) as {
  version: number;
  constants: { DOCUMENT_HEADER: string; MAX_INCOMING_MAIL_BYTES: number };
  entries: {
    name: string;
    request: { path: string; status: number; body: Record<string, unknown> };
    mail: Record<string, unknown>;
  }[];
};

describe("email messages at envelope version 1, without PGP", () => {
  it("keep the header and the bound a sender and a receiver agree on", () => {
    expect({ DOCUMENT_HEADER, MAX_INCOMING_MAIL_BYTES }).toEqual(WIRE.constants);
  });

  it("are handed to the mail library byte for byte, in order, and read back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "email-wire-"));
    const mails: object[] = [];
    const sender = createNodemailerSender(
      {
        host: "127.0.0.1",
        port: 1,
        secure: false,
        address: "alice@example.org",
        authUser: "alice@example.org",
        pass: "",
      },
      {
        async sendMail(options: object) {
          mails.push(options);
          const to = String((options as { to: string }).to).split(", ");
          return {
            messageId:
              (options as { messageId?: string }).messageId ?? `<sent-${mails.length}@example.org>`,
            accepted: to,
            rejected: [],
          };
        },
        async verify() {
          return true;
        },
      },
    );
    const server = createServer({
      address: "alice@example.org",
      sender,
      sync: undefined, // sending needs no mailbox to read from
      gpg: undefined,
      bindStorePath: join(dir, "tdsp-threads.json"),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      for (const [index, entry] of WIRE.entries.entries()) {
        const response = await fetch(`${base}${entry.request.path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(entry.request.body),
        });
        expect(response.status, entry.name).toBe(entry.request.status);
        // As the mail library receives it; fields left undefined are not part of the message.
        expect(JSON.parse(JSON.stringify(mails[index])), entry.name).toEqual(entry.mail);
      }
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("read a frame's body back to the frame that was sent", () => {
    const sent = WIRE.entries.find((entry) => entry.request.path.endsWith("/send"));
    expect(decodeEnvelope(String(sent?.mail.text))).toEqual({
      tdsp: 1,
      kind: "frame",
      documentId: "doc-a1b2c3",
      frame: sent?.request.body.payload,
    });
  });
});
