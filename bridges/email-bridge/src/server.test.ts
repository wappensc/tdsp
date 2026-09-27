import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Delivery, parseTransportProfile } from "@tdsp/messenger-port";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBindRecord, setBindRecord } from "./bind-store.ts";
import {
  createNodemailerSender,
  type IncomingMail,
  type MailReceiver,
  type MailSender,
  type OutgoingMail,
} from "./mail-transport.ts";
import { createServer, type ServerDependencies } from "./server.ts";
import type { Rejection, SyncState } from "./sync-state.ts";
import { EMAIL_LOCAL_PROFILE, EMAIL_PROVIDER_PROFILE } from "./transport-profile.ts";

class FakeMailSender implements MailSender {
  readonly tls = "plaintext-loopback" as const;
  /** Set to make `verify()` reject, as a real server refusing the login would. */
  verifyFailure: Error | undefined;

  async verify(): Promise<void> {
    if (this.verifyFailure) {
      throw this.verifyFailure;
    }
  }

  readonly address = "me@example.org";
  readonly sent: OutgoingMail[] = [];
  #nextId = 1;

  async send(mail: OutgoingMail): Promise<{ messageId: string }> {
    this.sent.push(mail);
    // Like the real sender: a caller-chosen Message-ID is used as given.
    return { messageId: mail.messageId ?? `<sent-${this.#nextId++}@example.org>` };
  }
}

/**
 * The real SMTP sender over a transport whose server accepts some recipients and refuses the
 * others with `responseCode` — what `nodemailer` reports as a successful send (EML-11).
 */
function senderRefusing(
  address: string,
  refused: readonly string[],
  responseCode: number,
): { send: MailSender["send"]; attempts: object[] } {
  const attempts: object[] = [];
  const partial = createNodemailerSender(
    { host: "127.0.0.1", port: 1, secure: false, address, authUser: address, pass: "" },
    {
      async sendMail(options: object) {
        attempts.push(options);
        const to = String((options as { to: string }).to).split(", ");
        return {
          messageId: `<partial-${attempts.length}@example.org>`,
          accepted: to.filter((r) => !refused.includes(r)),
          rejected: to.filter((r) => refused.includes(r)),
          rejectedErrors: refused.map(() => ({ responseCode })),
        };
      },
      async verify() {},
    },
  );
  return { send: (mail) => partial.send(mail), attempts };
}

class FakeSyncState implements SyncState {
  readonly polled: string[] = [];
  #deliveries = new Map<string, Delivery[]>();

  seedDeliveries(documentId: string, deliveries: Delivery[]): void {
    this.#deliveries.set(documentId, deliveries);
  }

  async pollOnce(documentId: string): Promise<void> {
    this.polled.push(documentId);
  }

  getDeliveries(documentId: string): readonly Delivery[] {
    return this.#deliveries.get(documentId) ?? [];
  }

  #rejections = new Map<string, Rejection[]>();

  seedRejections(documentId: string, rejections: Rejection[]): void {
    this.#rejections.set(documentId, rejections);
  }

  getRejections(documentId: string): readonly Rejection[] {
    return this.#rejections.get(documentId) ?? [];
  }
}

async function readJson(response: Response): Promise<unknown> {
  return response.json();
}

class FakeMailReceiver implements MailReceiver {
  readonly tls = "plaintext-loopback" as const;
  verifyFailure: Error | undefined;

  async verify(): Promise<void> {
    if (this.verifyFailure) {
      throw this.verifyFailure;
    }
  }

  #messages = new Map<string, IncomingMail[]>();
  seed(documentId: string, messages: IncomingMail[]): void {
    this.#messages.set(documentId, messages);
  }
  async fetchThreadMessages(documentId: string): Promise<readonly IncomingMail[]> {
    return this.#messages.get(documentId) ?? [];
  }
}

describe("bridges/email-bridge server", () => {
  let tempDir: string;
  let bindStorePath: string;
  let server: Server;
  let baseUrl: string;
  let sender: FakeMailSender;
  let sync: FakeSyncState;

  function start(deps: Partial<ServerDependencies> = {}): void {
    server = createServer({
      address: sender.address,
      sender,
      sync,
      gpg: undefined,
      bindStorePath,
      ...deps,
    });
  }

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "email-bridge-server-test-"));
    bindStorePath = join(tempDir, "tdsp-threads.json");
    sender = new FakeMailSender();
    sync = new FakeSyncState();
    start();
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    baseUrl = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("GET /whoami answers the address in its canonical form, whatever case it was configured in (EML-10)", async () => {
    server.close();
    start({ address: "Me@Example.ORG" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const url = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
    expect(await readJson(await fetch(`${url}/whoami`))).toEqual({ id: "me@example.org" });
  });

  it("GET /health reports configured true when a sender/address is present", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ status: "ok", configured: true });
  });

  it("GET /health reports configured false when unconfigured", async () => {
    server.close();
    start({ address: undefined, sender: undefined, sync: undefined });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const url = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
    const response = await fetch(`${url}/health`);
    expect(await readJson(response)).toEqual({ status: "ok", configured: false });
  });

  it("GET /whoami returns the configured mailbox address", async () => {
    const response = await fetch(`${baseUrl}/whoami`);
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ id: "me@example.org" });
  });

  describe("GET /transport-profile", () => {
    async function profileFrom(url: string) {
      const response = await fetch(`${url}/transport-profile`);
      return { response, profile: parseTransportProfile(await response.clone().json()) };
    }

    it("serves the local profile, with no limit, for a mail server on this machine", async () => {
      const { response, profile } = await profileFrom(baseUrl); // the fake sender is plaintext-loopback
      expect(response.status).toBe(200);
      expect(profile?.defaultProfile).toBe("local");
      expect(profile?.profiles.find((p) => p.id === "local")?.values).toEqual({
        minIntervalMs: 0,
        maxIntervalMs: null,
        minChars: 0,
        maxChars: null,
        expectedLatencyMs: 0,
      });
      expect(profile?.bounds).toEqual({ minIntervalMs: null, maxBytes: null });
    });

    it("serves the provider profile — one message per 30 s, never faster than 15 s — for a real provider", async () => {
      for (const tls of ["implicit", "starttls-required"] as const) {
        server.close();
        start({ sender: Object.assign(sender, { tls }) });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        const url =
          typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
        const { profile } = await profileFrom(url);
        expect(profile?.defaultProfile).toBe("standard");
        expect(profile?.profiles.find((p) => p.id === "standard")?.values.minIntervalMs).toBe(
          30_000,
        );
        expect(profile?.bounds.minIntervalMs).toBe(15_000);
        // A frame the client may send in one mail: a larger change is split, not refused
        // by the provider and dropped (SPECIFICATION.md §15.1, FRG-1).
        expect(profile?.bounds.maxBytes).toBe(4 * 1024 * 1024);
      }
    });

    it("cannot say anything while the mailbox is unconfigured: 503", async () => {
      server.close();
      start({ address: undefined, sender: undefined, sync: undefined });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      const url = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
      const response = await fetch(`${url}/transport-profile`);
      expect(response.status).toBe(503);
    });

    it("every profile this bridge can serve is a valid TransportProfile, so a typo cannot ship", () => {
      for (const profile of [EMAIL_PROVIDER_PROFILE, EMAIL_LOCAL_PROFILE]) {
        expect(parseTransportProfile(JSON.parse(JSON.stringify(profile)))).toEqual(profile);
      }
    });
  });

  it("GET /whoami returns 409 when unconfigured", async () => {
    server.close();
    start({ address: undefined });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const url = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
    const response = await fetch(`${url}/whoami`);
    expect(response.status).toBe(409);
  });

  describe("POST /threads/:documentId", () => {
    it("creates the bind record, sends the invite to everyone but the creator, and returns the thread root", async () => {
      const response = await fetch(`${baseUrl}/threads/doc-1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          recipients: ["alice@example.org", "bob@example.org"],
          creator: "alice@example.org",
          profile: "yjs-paragraphs/1",
        }),
      });
      expect(response.status).toBe(200);
      const body = (await readJson(response)) as { threadRootMessageId: string };
      expect(body.threadRootMessageId).toBe("<sent-1@example.org>");
      expect(sender.sent).toHaveLength(1);
      expect(sender.sent[0]?.to).toEqual(["bob@example.org"]);
      const bound = getBindRecord(bindStorePath, "doc-1");
      expect(bound).toMatchObject({
        recipients: ["alice@example.org", "bob@example.org"],
        creatorMemberId: "alice@example.org",
        threadRootMessageId: "<sent-1@example.org>",
      });
    });

    it("fails an invitation the server accepted for some participants only, naming them, and binds nothing (EML-11)", async () => {
      sender.send = senderRefusing(sender.address, ["carol@example.org"], 550).send;
      const response = await fetch(`${baseUrl}/threads/doc-1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          recipients: ["alice@example.org", "bob@example.org", "carol@example.org"],
          creator: "alice@example.org",
          profile: "yjs-paragraphs/1",
        }),
      });
      expect(response.status).not.toBe(200);
      expect(((await readJson(response)) as { error: string }).error).toContain(
        "refused carol@example.org",
      );
      expect(getBindRecord(bindStorePath, "doc-1")).toBeUndefined();
    });

    /**
     * The invitation carries a complete invitation link only if its own
     * Message-ID is known before it is sent (SPECIFICATION.md §11.3), so the
     * caller chooses it and the bridge sends exactly that.
     */
    it("sends the invite with the caller's Message-ID, stores it as the thread root, and echoes it", async () => {
      const chosen = "<3f1c2a40-9b1e-4c7a-8d55-0a1b2c3d4e5f@example.org>";
      const response = await fetch(`${baseUrl}/threads/doc-1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          recipients: ["alice@example.org", "bob@example.org"],
          creator: "alice@example.org",
          profile: "yjs-paragraphs/1",
          threadRootMessageId: chosen,
        }),
      });
      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({ threadRootMessageId: chosen });
      expect(sender.sent[0]?.messageId).toBe(chosen);
      expect(getBindRecord(bindStorePath, "doc-1")?.threadRootMessageId).toBe(chosen);
    });

    it("still lets the mail server assign the Message-ID when none is given", async () => {
      await fetch(`${baseUrl}/threads/doc-1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          recipients: ["alice@example.org", "bob@example.org"],
          creator: "alice@example.org",
          profile: "yjs-paragraphs/1",
        }),
      });
      expect(sender.sent[0]?.messageId).toBeUndefined();
    });

    it.each([
      ["no brackets", "root@example.org"],
      ["a CR/LF header injection", "<a@b.org>\r\nBcc: evil@example.org"],
      ["a space", "<a b@example.org>"],
      ["not a string", 42],
    ])("refuses %s as a Message-ID before anything is sent or stored", async (_name, bad) => {
      const response = await fetch(`${baseUrl}/threads/doc-1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          recipients: ["alice@example.org", "bob@example.org"],
          creator: "alice@example.org",
          profile: "yjs-paragraphs/1",
          threadRootMessageId: bad,
        }),
      });
      expect(response.status).toBe(400);
      expect(sender.sent).toHaveLength(0);
      expect(getBindRecord(bindStorePath, "doc-1")).toBeUndefined();
    });

    it("uses a caller-supplied inviteText verbatim when given", async () => {
      await fetch(`${baseUrl}/threads/doc-1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          recipients: ["alice@example.org", "bob@example.org"],
          creator: "alice@example.org",
          profile: "yjs-paragraphs/1",
          inviteText: "join my document: https://example.org/join?documentId=doc-1",
        }),
      });
      expect(sender.sent[0]?.text).toBe(
        "join my document: https://example.org/join?documentId=doc-1",
      );
    });

    it("rejects an empty recipients array", async () => {
      const response = await fetch(`${baseUrl}/threads/doc-1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          recipients: [],
          creator: "alice@example.org",
          profile: "yjs-paragraphs/1",
        }),
      });
      expect(response.status).toBe(400);
    });

    it("rejects a creator who isn't one of the recipients", async () => {
      const response = await fetch(`${baseUrl}/threads/doc-1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          recipients: ["bob@example.org"],
          creator: "alice@example.org",
          profile: "yjs-paragraphs/1",
        }),
      });
      expect(response.status).toBe(400);
    });
  });

  describe("POST /threads/:documentId/join", () => {
    it("registers the bind-store entry without sending anything", async () => {
      const response = await fetch(`${baseUrl}/threads/doc-1/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadRootMessageId: "<root@example.org>",
          recipients: ["alice@example.org", "bob@example.org"],
          creator: "alice@example.org",
          profile: "yjs-paragraphs/1",
        }),
      });
      expect(response.status).toBe(200);
      expect(sender.sent).toHaveLength(0);
      expect(getBindRecord(bindStorePath, "doc-1")).toMatchObject({
        recipients: ["alice@example.org", "bob@example.org"],
        creatorMemberId: "alice@example.org",
        threadRootMessageId: "<root@example.org>",
      });
    });

    /**
     * The value comes from a invitation link, which anyone can craft, and is then
     * sent as In-Reply-To/References on every message this bridge sends for the
     * document — so it is checked, not merely stored.
     */
    it.each([
      ["a CR/LF header injection", "<a@b.org>\r\nBcc: evil@example.org"],
      ["no brackets", "root@example.org"],
      ["a space", "<a b@example.org>"],
    ])("rejects %s as the thread root, storing nothing", async (_name, bad) => {
      const response = await fetch(`${baseUrl}/threads/doc-1/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadRootMessageId: bad,
          recipients: ["alice@example.org", "bob@example.org"],
          creator: "alice@example.org",
          profile: "yjs-paragraphs/1",
        }),
      });
      expect(response.status).toBe(400);
      expect(getBindRecord(bindStorePath, "doc-1")).toBeUndefined();
    });

    it("rejects a creator given with a display name, storing nothing (EML-10)", async () => {
      const response = await fetch(`${baseUrl}/threads/doc-1/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadRootMessageId: "<root@example.org>",
          recipients: ["Alice <alice@example.org>", "bob@example.org"],
          creator: "Alice <alice@example.org>",
          profile: "yjs-paragraphs/1",
        }),
      });
      expect(response.status).toBe(400);
      expect(getBindRecord(bindStorePath, "doc-1")).toBeUndefined();
    });

    it("rejects a missing threadRootMessageId", async () => {
      const response = await fetch(`${baseUrl}/threads/doc-1/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          recipients: ["alice@example.org", "bob@example.org"],
          creator: "alice@example.org",
          profile: "yjs-paragraphs/1",
        }),
      });
      expect(response.status).toBe(400);
    });
  });

  describe("POST /channels/:documentId/send", () => {
    /** The mailbox this bridge sends as — the only sender it accepts (BRG-16). */
    let _ownAddress = "";
    beforeEach(() => {
      _ownAddress = sender.address;
      setBindRecord(bindStorePath, "doc-1", {
        recipients: ["alice@example.org", "bob@example.org"],
        creatorMemberId: "alice@example.org",
        profile: "yjs-paragraphs/1",
        threadRootMessageId: "<root@example.org>",
        createdAt: new Date(0).toISOString(),
        pgpEnabled: false,
        pinnedFingerprints: {},
      });
    });

    it("sends the edit envelope from its own mailbox to every participant but itself, threaded under the root message", async () => {
      const response = await fetch(`${baseUrl}/channels/doc-1/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sender: sender.address, payload: "AQID" }),
      });
      expect(response.status).toBe(200);
      expect(sender.sent[0]).toMatchObject({
        to: ["alice@example.org", "bob@example.org"],
        inReplyTo: "<root@example.org>",
        references: ["<root@example.org>"],
      });
      expect(sender.sent[0]?.text).toBe(
        JSON.stringify({ tdsp: 1, kind: "frame", documentId: "doc-1", frame: "AQID" }),
      );
    });

    describe("says why a send failed, by status", () => {
      async function sendFailingWith(failure: unknown): Promise<Response> {
        sender.send = async () => {
          throw failure;
        };
        return fetch(`${baseUrl}/channels/doc-1/send`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sender: sender.address, payload: "AQID" }),
        });
      }
      const smtp = (responseCode: number) =>
        Object.assign(new Error(`SMTP ${responseCode}`), { responseCode });

      it("answers 429 for GMX's own 450 refusal, so the adapter retries and slows down", async () => {
        const response = await sendFailingWith(smtp(450));
        expect(response.status).toBe(429);
        expect(((await readJson(response)) as { error: string }).error).toBe("SMTP 450");
      });

      it("answers 413 when the server says the message is too big", async () => {
        expect((await sendFailingWith(smtp(552))).status).toBe(413);
      });

      it("answers 503 when the mail server cannot be reached", async () => {
        const response = await sendFailingWith(
          Object.assign(new Error("x"), { code: "ETIMEDOUT" }),
        );
        expect(response.status).toBe(503);
      });

      it("answers 502 for a failure it cannot classify, which the adapter still retries", async () => {
        expect((await sendFailingWith(new Error("smtp is down"))).status).toBe(502);
      });
    });

    describe("a message the server accepted for some participants only (EML-11)", () => {
      async function sendRefusedFor(responseCode: number): Promise<Response> {
        sender.send = senderRefusing(sender.address, ["bob@example.org"], responseCode).send;
        return fetch(`${baseUrl}/channels/doc-1/send`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sender: sender.address, payload: "AQID" }),
        });
      }

      it("is not a success: a permanent refusal is final (422), so the engine marks the change undistributed", async () => {
        const response = await sendRefusedFor(550);
        expect(response.status).toBe(422);
        expect(((await readJson(response)) as { error: string }).error).toContain(
          "refused bob@example.org",
        );
      });

      it("is retried when every refusal was temporary (429) — resent whole, which the one who has it ignores (TRN-8)", async () => {
        expect((await sendRefusedFor(450)).status).toBe(429);
      });
    });

    it("returns 404 for a document with no thread started yet", async () => {
      const response = await fetch(`${baseUrl}/channels/doc-never-started/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sender: sender.address, payload: "AQID" }),
      });
      expect(response.status).toBe(404);
    });
  });

  describe("GET /mail/status", () => {
    let receiver: FakeMailReceiver;

    async function restartWithReceiver(options: { withReceiver?: boolean } = {}): Promise<void> {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      receiver = new FakeMailReceiver();
      start(options.withReceiver === false ? {} : { receiver });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      baseUrl = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
    }

    const status = async () => readJson(await fetch(`${baseUrl}/mail/status`));

    it("reports both connections as working, with how each is secured", async () => {
      await restartWithReceiver();
      expect(await status()).toEqual({
        configured: true,
        address: "me@example.org",
        smtp: { ok: true, tls: "plaintext-loopback" },
        imap: { ok: true, tls: "plaintext-loopback" },
      });
    });

    it("reports each side's own failure, with the server's reason, and does not let one hide the other", async () => {
      await restartWithReceiver();
      sender.verifyFailure = new Error("Invalid login: 535 Authentication credentials invalid");
      const body = (await status()) as {
        smtp: { ok: boolean; error?: string };
        imap: { ok: boolean };
      };
      expect(body.smtp).toMatchObject({ ok: false, error: expect.stringContaining("535") });
      expect(body.imap.ok).toBe(true);
      sender.verifyFailure = undefined;
      receiver.verifyFailure = new Error("LOGIN failed");
      const other = (await status()) as { smtp: { ok: boolean }; imap: { ok: boolean } };
      expect(other.smtp.ok).toBe(true);
      expect(other.imap.ok).toBe(false);
    });

    it("never sends anything to check", async () => {
      await restartWithReceiver();
      await status();
      expect(sender.sent).toHaveLength(0);
    });

    it("says so, rather than reporting a failure, when no mailbox is configured", async () => {
      await restartWithReceiver({ withReceiver: false });
      expect(await status()).toEqual({ configured: false });
    });
  });

  it("GET /channels/:documentId/deliveries polls once and returns the accumulated deliveries", async () => {
    sync.seedDeliveries("doc-1", [
      {
        id: "d1",
        documentId: "doc-1",
        sender: "bob@example.org",
        payload: "AQID",
      },
    ]);
    const response = await fetch(`${baseUrl}/channels/doc-1/deliveries`);
    expect(response.status).toBe(200);
    expect(sync.polled).toEqual(["doc-1"]);
    expect(await readJson(response)).toEqual([
      { id: "d1", documentId: "doc-1", sender: "bob@example.org", payload: "AQID" },
    ]);
  });

  it("carries an edit whatever the document's permissions say and has no membership, archive, delete, or resync-request routes: membership/archive/delete are control frames in the payload, and a resync request rides the same send/deliveries routes as everything else", async () => {
    setBindRecord(bindStorePath, "doc-1", {
      recipients: ["alice@example.org", "bob@example.org"],
      creatorMemberId: "alice@example.org",
      profile: "yjs-paragraphs/1",
      threadRootMessageId: "<root@example.org>",
      createdAt: new Date(0).toISOString(),
      pgpEnabled: false,
      pinnedFingerprints: {},
    });
    const send = await fetch(`${baseUrl}/channels/doc-1/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sender: sender.address, payload: "AQID" }),
    });
    expect(send.status).toBe(200);

    for (const route of ["membership", "archive", "delete", "resync-request"]) {
      const response = await fetch(`${baseUrl}/channels/doc-1/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor: "alice@example.org", member: "bob@example.org" }),
      });
      expect(response.status, route).toBe(404);
    }
    expect((await fetch(`${baseUrl}/channels/doc-1/resync-requests`)).status).toBe(404);
  });

  it("returns 404 for an unknown route", async () => {
    const response = await fetch(`${baseUrl}/nope`);
    expect(response.status).toBe(404);
  });
});
