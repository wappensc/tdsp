import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Delivery, parseTransportProfile } from "@tdsp/messenger-port";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBindRecord, setBindRecord } from "./bind-store.ts";
import { decodeInvite, extractArmoredMessage, pgpFormatOf } from "./envelope.ts";
import { FakeGpgInvoker, fakeKey, inspectFakeKeyBlock, inspectFakeMessage } from "./fake-gpg.ts";
import { keyringPathFor } from "./keyring-store.ts";
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

const KEY_ALICE = "A".repeat(40);
const KEY_BOB = "B".repeat(40);
/** The key a bridge whose own address is not a participant signs with — a stand-in, since the bridge here is "me@example.org". */
const KEY_ME = "E".repeat(40);

/**
 * What an accepted invitation leaves behind for a PGP-enabled document
 * (SPECIFICATION.md EML-4): a pin for every participant, the fingerprint this
 * bridge signs with, and a keyring of the document's own holding exactly the
 * pinned keys — here a real file, written through the fake.
 */
function pgpDocumentFields(
  gpg: FakeGpgInvoker,
  keyringPath: string,
  own: { address: string; fingerprint: string },
  pins: Record<string, string> = { "alice@example.org": KEY_ALICE, "bob@example.org": KEY_BOB },
) {
  const ring = gpg.withKeyring(keyringPath);
  const participants = { ...pins };
  if (!(normalizedOwn(own.address) in participants)) {
    ring.seedKey(own.address, { fingerprint: own.fingerprint, userIds: [own.address] });
  }
  for (const [address, fingerprint] of Object.entries(participants)) {
    ring.seedKey(address, { fingerprint, userIds: [address] });
  }
  return {
    pgpEnabled: true,
    keyringPath,
    ownFingerprint: own.fingerprint,
    pinnedFingerprints: pins,
  };
}

function normalizedOwn(address: string): string {
  return address.trim().toLowerCase();
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
    let ownAddress = "";
    beforeEach(() => {
      ownAddress = sender.address;
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

    it("refuses a send that names anyone but its own mailbox as the sender (BRG-16)", async () => {
      const response = await fetch(`${baseUrl}/channels/doc-1/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sender: "alice@example.org", payload: "AQID" }),
      });
      expect(response.status).toBe(403);
      expect(sender.sent).toHaveLength(0);
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

    describe("PGP-enabled documents", () => {
      let gpg: FakeGpgInvoker;
      let keyringPath: string;

      /**
       * Restarts the server with a fake gpg — this bridge's own address
       * holding a secret key unless told otherwise — and turns doc-1 into a
       * PGP-enabled document the way an accepted invitation would have left
       * it: pins, the fingerprint this bridge signs with, and a keyring of the
       * document's own holding the pinned keys.
       */
      async function restartWithGpg(
        options: {
          ownSecretKey?: boolean;
          pgpEnabled?: boolean;
          withGpg?: boolean;
          address?: string;
          withoutKeyring?: boolean;
        } = {},
      ): Promise<void> {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        gpg = new FakeGpgInvoker();
        const address = options.address ?? sender.address;
        ownAddress = address;
        const ownFingerprint = options.address === undefined ? KEY_ME : KEY_ALICE;
        if (options.ownSecretKey ?? true) {
          gpg.seedSecretKey(address, ownFingerprint);
        }
        start({
          gpg: options.withGpg === false ? undefined : gpg,
          ...(options.address ? { address: options.address } : {}),
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const listening = server.address();
        baseUrl =
          typeof listening === "object" && listening ? `http://127.0.0.1:${listening.port}` : "";
        keyringPath = keyringPathFor(bindStorePath, "doc-1");
        const bound = getBindRecord(bindStorePath, "doc-1");
        if (bound && (options.pgpEnabled ?? true)) {
          setBindRecord(bindStorePath, "doc-1", {
            ...bound,
            ...(options.withoutKeyring
              ? { pgpEnabled: true }
              : pgpDocumentFields(gpg, keyringPath, { address, fingerprint: ownFingerprint })),
          });
        }
      }

      function sendEdit(): Promise<Response> {
        return fetch(`${baseUrl}/channels/doc-1/send`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sender: ownAddress, payload: "AQID" }),
        });
      }

      it("blocks the send and names who's missing when the document's keyring is incomplete", async () => {
        await restartWithGpg();
        gpg.withKeyring(keyringPath).removeKey(KEY_BOB);
        const response = await sendEdit();
        expect(response.status).toBe(422);
        const body = (await readJson(response)) as { error: string };
        expect(body.error).toContain("bob@example.org");
        expect(sender.sent).toHaveLength(0);
      });

      it("blocks the send when this bridge has no secret key to sign with, rather than sending unsigned", async () => {
        await restartWithGpg({ ownSecretKey: false });
        const response = await sendEdit();
        expect(response.status).toBe(422);
        const body = (await readJson(response)) as { error: string };
        expect(body.error).toContain(sender.address);
        expect(sender.sent).toHaveLength(0);
        expect(gpg.encrypted).toHaveLength(0);
      });

      it("returns 503 for a PGP-enabled document when no gpg binary is configured at all", async () => {
        await restartWithGpg({ withGpg: false });
        const response = await sendEdit();
        expect(response.status).toBe(503);
        expect(sender.sent).toHaveLength(0);
      });

      it("refuses a PGP-enabled document that has no keyring of its own — telling the user to start a new one", async () => {
        await restartWithGpg({ withoutKeyring: true });
        const response = await sendEdit();
        expect(response.status).toBe(422);
        const body = (await readJson(response)) as { error: string };
        expect(body.error).toContain("start a new document");
        expect(sender.sent).toHaveLength(0);
        expect(gpg.encrypted).toHaveLength(0);
      });

      it("sends the edit signed with the fingerprint the document was given for this bridge and encrypted to every member's pinned fingerprint", async () => {
        await restartWithGpg();
        const response = await sendEdit();
        expect(response.status).toBe(200);
        expect(sender.sent).toHaveLength(1);
        const text = sender.sent[0]?.text ?? "";
        expect(pgpFormatOf(text)).toBe("encrypted");
        expect(text).not.toContain('"kind"'); // the envelope is not readable in the mail body
        expect(JSON.parse(inspectFakeMessage(text)?.payload ?? "null")).toEqual({
          tdsp: 1,
          kind: "frame",
          documentId: "doc-1",
          frame: "AQID",
        });
        expect(gpg.encrypted).toEqual([
          {
            payload: expect.any(String),
            signer: KEY_ME, // a fingerprint, never an address a second key could also match
            recipients: [KEY_ALICE, KEY_BOB],
          },
        ]);
      });

      it("encrypts to the fingerprint pinned for a member, not to whichever other key the keyring also holds for their address", async () => {
        await restartWithGpg();
        gpg.withKeyring(keyringPath).seedKey("bob@example.org", fakeKey("C", "bob@example.org")); // a second key
        const response = await sendEdit();
        expect(response.status).toBe(200);
        expect(gpg.encrypted[0]?.recipients).toEqual([KEY_ALICE, KEY_BOB]);
      });

      it("refuses to send when the keyring no longer holds the key pinned for a member, even if it holds another for their address", async () => {
        await restartWithGpg();
        const ring = gpg.withKeyring(keyringPath);
        ring.removeKey(KEY_BOB);
        ring.seedKey("bob@example.org", fakeKey("D", "bob@example.org")); // bob's key was swapped
        const response = await sendEdit();
        expect(response.status).toBe(422);
        const body = (await readJson(response)) as { error: string };
        expect(body.error).toContain("no longer holds the key pinned");
        expect(body.error).toContain("bob@example.org");
        expect(sender.sent).toHaveLength(0);
        expect(gpg.encrypted).toHaveLength(0);
      });

      it("refuses to send for a member with no pin at all — a damaged record — rather than guess a key for them", async () => {
        await restartWithGpg();
        const bound = getBindRecord(bindStorePath, "doc-1");
        if (bound) {
          setBindRecord(bindStorePath, "doc-1", {
            ...bound,
            pinnedFingerprints: { "alice@example.org": KEY_ALICE },
          });
        }
        const response = await sendEdit();
        expect(response.status).toBe(422);
        expect(sender.sent).toHaveLength(0);
      });

      it("never asks the user's own keyring for anyone's key — the document's keyring is the only source", async () => {
        await restartWithGpg();
        gpg.seedKey("bob@example.org", fakeKey("C", "bob@example.org")); // the user's own, unrelated key for bob
        const response = await sendEdit();
        expect(response.status).toBe(200);
        expect(gpg.encrypted[0]?.recipients).toEqual([KEY_ALICE, KEY_BOB]);
      });

      it("never encrypts to its own address — this bridge never reads its own outbox", async () => {
        await restartWithGpg({ address: "alice@example.org" });
        const response = await sendEdit();
        expect(response.status).toBe(200);
        expect(gpg.encrypted[0]?.recipients).toEqual([KEY_BOB]);
        expect(gpg.encrypted[0]?.signer).toBe(KEY_ALICE);
      });

      it("never checks keys, and sends plain unprotected JSON, for a PGP-off document even with gpg configured", async () => {
        await restartWithGpg({ pgpEnabled: false });
        const response = await sendEdit();
        expect(response.status).toBe(200);
        expect(gpg.queriedAddresses).toEqual([]);
        expect(gpg.encrypted).toEqual([]);
        expect(pgpFormatOf(sender.sent[0]?.text ?? "")).toBe("plain");
      });

      describe("every protocol message is signed and encrypted, and gated by the same guard", () => {
        // Only one route left to parameterize over:
        // a resync request sends through this same /send route now, opaque
        // to this bridge exactly like an edit already was — kept as a
        // single-entry table rather than collapsed into the it()s below, so
        // a future route added here needs no restructuring.
        const routes: {
          name: string;
          path: string;
          body: unknown;
          expected: unknown;
        }[] = [
          {
            name: "edit",
            path: "/channels/doc-1/send",
            body: { sender: "me@example.org", payload: "AQID" }, // this bridge's own mailbox (BRG-16)
            expected: { tdsp: 1, kind: "frame", documentId: "doc-1", frame: "AQID" },
          },
        ];

        function post(path: string, body: unknown): Promise<Response> {
          return fetch(`${baseUrl}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
        }

        it.each(routes)(
          "signs a $name message with this bridge's own key and encrypts it to both members",
          async (route) => {
            await restartWithGpg();
            const response = await post(route.path, route.body);
            expect(response.status).toBe(200);
            const text = sender.sent[0]?.text ?? "";
            expect(pgpFormatOf(text)).toBe("encrypted");
            expect(JSON.parse(inspectFakeMessage(text)?.payload ?? "null")).toEqual(route.expected);
            expect(gpg.encrypted[0]?.signer).toBe(KEY_ME);
            expect(gpg.encrypted[0]?.recipients).toEqual([KEY_ALICE, KEY_BOB]);
          },
        );

        it.each(routes)(
          "refuses a $name message, sending nothing, when the document's keyring is incomplete",
          async (route) => {
            await restartWithGpg();
            gpg.withKeyring(keyringPath).removeKey(KEY_BOB);
            const response = await post(route.path, route.body);
            expect(response.status).toBe(422);
            expect(sender.sent).toHaveLength(0);
          },
        );

        it.each(routes)(
          "sends a $name message unprotected for a PGP-off document",
          async (route) => {
            await restartWithGpg({ pgpEnabled: false });
            const response = await post(route.path, route.body);
            expect(response.status).toBe(200);
            expect(JSON.parse(sender.sent[0]?.text ?? "null")).toEqual(route.expected);
            expect(gpg.encrypted).toEqual([]);
          },
        );
      });
    });
  });

  describe("PGP-enabled thread creation", () => {
    let gpg: FakeGpgInvoker;
    const CREATOR = "alice@example.org";

    /** A creator's bridge: its own address is the creator, and it holds her secret key. */
    async function restartAsCreator(options: { ownSecretKey?: boolean } = {}): Promise<void> {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      gpg = new FakeGpgInvoker();
      if (options.ownSecretKey ?? true) {
        gpg.seedSecretKey(CREATOR, KEY_ALICE);
      }
      start({ gpg, address: CREATOR });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const listening = server.address();
      baseUrl =
        typeof listening === "object" && listening ? `http://127.0.0.1:${listening.port}` : "";
    }

    /** Alice's own keyring: her key and Bob's, one each — what a creator is expected to have. */
    function seedCompleteKeyring(): void {
      gpg.seedKey(CREATOR, fakeKey("A", CREATOR));
      gpg.seedKey("bob@example.org", fakeKey("B", "bob@example.org"));
    }

    function startThread(
      pgpEnabled: boolean,
      recipients = [CREATOR, "bob@example.org"],
      inviteText?: string,
    ) {
      return fetch(`${baseUrl}/threads/doc-1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          recipients,
          creator: recipients[0],
          profile: "yjs-paragraphs/1",
          pgpEnabled,
          ...(inviteText === undefined ? {} : { inviteText }),
        }),
      });
    }

    const keyringFiles = (): string[] => {
      const dir = join(tempDir, "keyrings");
      return existsSync(dir) ? readdirSync(dir) : [];
    };

    it("sends the invitation as readable text followed by one signed and encrypted block, to everyone but the creator", async () => {
      await restartAsCreator();
      seedCompleteKeyring();
      const response = await startThread(true, undefined, "Join us: http://localhost:5173/?x=1");
      expect(response.status).toBe(200);

      const mail = sender.sent[0];
      expect(mail?.to).toEqual(["bob@example.org"]);
      // The human-readable part — the invitation link — is first and readable …
      expect(mail?.text.startsWith("Join us: http://localhost:5173/?x=1")).toBe(true);
      // … and is not what an integrity check reads: the envelope parser must not see an invitation as a message.
      expect(pgpFormatOf(mail?.text ?? "")).toBe("plain");
      // Exactly one protected block, encrypted to Bob only (the creator never reads her own outbox), signed by Alice.
      const block = extractArmoredMessage(mail?.text ?? "");
      expect(block).not.toBe("none");
      expect(block).not.toBe("several");
      const inspected = inspectFakeMessage(typeof block === "object" ? block.block : "");
      expect(inspected?.recipients).toEqual([KEY_BOB]);
      expect(inspected?.signer).toBe(KEY_ALICE);
      // Nothing of the participants or keys is readable in the mail text itself.
      expect(mail?.text).not.toContain('bob@example.org","fingerprint');
    });

    it("signs the creator's send policy into the invitation and keeps it in the bind record", async () => {
      await restartAsCreator();
      seedCompleteKeyring();
      const response = await fetch(`${baseUrl}/threads/doc-1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          recipients: [CREATOR, "bob@example.org"],
          creator: CREATOR,
          profile: "yjs-paragraphs/1",
          pgpEnabled: true,
          policy: "30000,120000,0,inf,60000@0",
        }),
      });
      expect(response.status).toBe(200);
      const block = extractArmoredMessage(sender.sent[0]?.text ?? "");
      const invite = decodeInvite(
        inspectFakeMessage(typeof block === "object" ? block.block : "")?.payload ?? "",
      );
      expect(invite?.policy).toBe("30000,120000,0,inf,60000@0");
      expect(getBindRecord(bindStorePath, "doc-1")?.policy).toBe("30000,120000,0,inf,60000@0");
    });

    it("refuses a policy that is not a short policy text, before anything is sent", async () => {
      await restartAsCreator();
      seedCompleteKeyring();
      const response = await fetch(`${baseUrl}/threads/doc-1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          recipients: [CREATOR, "bob@example.org"],
          creator: CREATOR,
          profile: "yjs-paragraphs/1",
          pgpEnabled: true,
          policy: "<script>alert(1)</script>",
        }),
      });
      expect(response.status).toBe(400);
      expect(sender.sent).toHaveLength(0);
    });

    it("signs and encrypts an invitation that names every participant with the key chosen for them, and carries exactly those keys", async () => {
      await restartAsCreator();
      seedCompleteKeyring();
      await startThread(true);
      const block = extractArmoredMessage(sender.sent[0]?.text ?? "");
      const invite = decodeInvite(
        inspectFakeMessage(typeof block === "object" ? block.block : "")?.payload ?? "",
      );
      expect(invite).toMatchObject({
        kind: "invite",
        documentId: "doc-1",
        creator: CREATOR,
        profile: "yjs-paragraphs/1",
        participants: [
          { address: CREATOR, fingerprint: KEY_ALICE },
          { address: "bob@example.org", fingerprint: KEY_BOB },
        ],
      });
      expect(
        inspectFakeKeyBlock(invite?.keys ?? "")
          ?.map((key) => key.fingerprint)
          .sort(),
      ).toEqual([KEY_ALICE, KEY_BOB]);
    });

    it("records a pin for every participant, the fingerprint it signs with, and a keyring of the document's own holding exactly those keys", async () => {
      await restartAsCreator();
      seedCompleteKeyring();
      await startThread(true);
      const record = getBindRecord(bindStorePath, "doc-1");
      expect(record?.pinnedFingerprints).toEqual({
        [CREATOR]: KEY_ALICE,
        "bob@example.org": KEY_BOB,
      });
      expect(record?.ownFingerprint).toBe(KEY_ALICE);
      expect(record?.keyringPath).toBe(keyringPathFor(bindStorePath, "doc-1"));
      const ring = gpg.withKeyring(record?.keyringPath ?? "");
      expect((await ring.listAllKeys()).map((key) => key.fingerprint).sort()).toEqual([
        KEY_ALICE,
        KEY_BOB,
      ]);
      expect(keyringFiles()).toEqual([`${keyringFileName()}`]);
    });

    const keyringFileName = () => keyringPathFor(bindStorePath, "doc-1").split("/").pop() ?? "";

    it("refuses two participants who are the same address in another case (EML-10)", async () => {
      await restartAsCreator();
      seedCompleteKeyring();
      const response = await startThread(true, [CREATOR, "bob@example.org", "BOB@example.org"]);
      expect(response.status).toBe(400);
      expect(((await readJson(response)) as { error: string }).error).toContain("same address");
    });

    it("refuses a participant written with a display name instead of repairing it (EML-10)", async () => {
      await restartAsCreator();
      seedCompleteKeyring();
      const response = await startThread(false, [CREATOR, "Bob <bob@example.org>"]);
      expect(response.status).toBe(400);
      expect(((await readJson(response)) as { error: string }).error).toContain("bare address");
      expect(getBindRecord(bindStorePath, "doc-1")).toBeUndefined();
    });

    it("keys pins by the normalized address, so a differently-cased header can never miss its pin", async () => {
      await restartAsCreator();
      gpg.seedKey("Alice@Example.org", { fingerprint: KEY_ALICE, userIds: ["Alice@Example.org"] });
      gpg.seedKey("bob@example.org", { fingerprint: KEY_BOB, userIds: ["bob@example.org"] });
      // The bridge's address is configured in lower case; the recipient list is not.
      const response = await startThread(true, ["Alice@Example.org", "bob@example.org"]);
      expect(response.status).toBe(200);
      expect(Object.keys(getBindRecord(bindStorePath, "doc-1")?.pinnedFingerprints ?? {})).toEqual([
        "alice@example.org",
        "bob@example.org",
      ]);
    });

    it("never asks a participant's own keyring anything — only the creator's own is read, and only once, at creation", async () => {
      await restartAsCreator();
      seedCompleteKeyring();
      await startThread(true);
      expect(new Set(gpg.queriedAddresses)).toEqual(new Set([CREATOR, "bob@example.org"]));
    });

    /**
     * Starting a PGP-enabled document with an incomplete keyring must not send
     * the invitation and store the thread *and then* fail every later send —
     * that would leave a started thread and a sent invitation behind an error,
     * with nothing the creator could open. The guard runs first, and leaves no
     * half-built document keyring behind.
     */
    describe("refuses to start a PGP-enabled document its creator could not send into — before anything is sent or stored", () => {
      async function expectRefused(expectedStatus: number, mention: string): Promise<void> {
        const response = await startThread(true);
        expect(response.status).toBe(expectedStatus);
        const body = (await readJson(response)) as { error: string };
        expect(body.error).toContain("cannot start a PGP-enabled document");
        expect(body.error).toContain(mention);
        expect(sender.sent).toHaveLength(0);
        expect(getBindRecord(bindStorePath, "doc-1")).toBeUndefined();
        expect(keyringFiles()).toEqual([]);
      }

      it("when a participant's key is missing", async () => {
        await restartAsCreator();
        gpg.seedKey(CREATOR, fakeKey("A", CREATOR)); // bob's key is never seeded
        await expectRefused(422, "bob@example.org");
      });

      it("when a participant's address matches two keys", async () => {
        await restartAsCreator();
        gpg.seedKey(CREATOR, fakeKey("A", CREATOR));
        gpg.seedKey("bob@example.org", fakeKey("B", "bob@example.org"));
        gpg.seedKey("bob@example.org", fakeKey("C", "bob@example.org"));
        await expectRefused(422, "bob@example.org");
      });

      it("when this bridge has no secret key to sign with", async () => {
        await restartAsCreator({ ownSecretKey: false });
        seedCompleteKeyring();
        await expectRefused(422, CREATOR);
      });

      it("when the same key is the only match for two participants", async () => {
        await restartAsCreator();
        gpg.seedKey(CREATOR, fakeKey("A", CREATOR));
        gpg.seedKey("bob@example.org", fakeKey("A", "bob@example.org")); // Bob's "key" is Alice's
        await expectRefused(422, "two participants");
      });

      it("when the bridge has no gpg at all", async () => {
        // default beforeEach server: gpg undefined
        await expectRefused(503, "no gpg binary");
      });

      it("when the creator is not this bridge's own address — the signature is checked against the creator's key", async () => {
        await restartAsCreator();
        seedCompleteKeyring();
        const response = await startThread(true, ["bob@example.org", CREATOR]);
        expect(response.status).toBe(400);
        expect(sender.sent).toHaveLength(0);
        expect(keyringFiles()).toEqual([]);
      });

      it("when the document has no participant besides its creator", async () => {
        await restartAsCreator();
        gpg.seedKey(CREATOR, fakeKey("A", CREATOR));
        const response = await startThread(true, [CREATOR]);
        expect(response.status).toBe(422);
        expect(((await readJson(response)) as { error: string }).error).toContain(
          "at least one participant",
        );
        expect(sender.sent).toHaveLength(0);
        expect(keyringFiles()).toEqual([]);
      });
    });

    it("leaves neither a record nor a keyring behind when the invitation cannot be sent", async () => {
      await restartAsCreator();
      seedCompleteKeyring();
      sender.send = async () => {
        throw new Error("smtp is down");
      };
      const response = await startThread(true);
      expect(response.status).toBe(502);
      expect(getBindRecord(bindStorePath, "doc-1")).toBeUndefined();
      expect(keyringFiles()).toEqual([]);
    });

    it("still starts a PGP-off document with no keys and no gpg, exactly as before", async () => {
      const response = await startThread(false);
      expect(response.status).toBe(200);
      expect(sender.sent).toHaveLength(1);
      expect(pgpFormatOf(sender.sent[0]?.text ?? "")).toBe("plain");
    });

    it("pins nothing, builds no keyring, and never touches gpg, for a PGP-off document", async () => {
      await restartAsCreator();
      gpg.seedKey("alice@example.org");
      await startThread(false);
      const record = getBindRecord(bindStorePath, "doc-1");
      expect(record?.pinnedFingerprints).toEqual({});
      expect(record?.keyringPath).toBeUndefined();
      expect(gpg.queriedAddresses).toEqual([]);
      expect(keyringFiles()).toEqual([]);
    });
  });

  describe("PGP-enabled thread joining (SPECIFICATION.md EML-4)", () => {
    /**
     * The whole invitation flow across two fake keyrings: Alice's bridge (a
     * `createInvite` over her own keyring) produces the email, Bob's server
     * receives it from a fake mailbox. Adversarial variants of the invitation
     * itself are in `invite.security.test.ts`; this covers what the HTTP route adds.
     */
    let bobGpg: FakeGpgInvoker;
    let receiver: FakeMailReceiver;
    const BOB = "bob@example.org";
    const ROOT = "<root@example.org>";

    async function restartAsJoiner(options: { withGpg?: boolean; withReceiver?: boolean } = {}) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      bobGpg = new FakeGpgInvoker();
      bobGpg.seedSecretKey(BOB, KEY_BOB);
      bobGpg.seedKey(BOB, { fingerprint: KEY_BOB, userIds: [BOB] });
      receiver = new FakeMailReceiver();
      start({
        gpg: options.withGpg === false ? undefined : bobGpg,
        address: BOB,
        ...(options.withReceiver === false ? {} : { receiver }),
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const listening = server.address();
      baseUrl =
        typeof listening === "object" && listening ? `http://127.0.0.1:${listening.port}` : "";
    }

    /** Alice creates the document; her invitation lands in Bob's fake mailbox. */
    async function aliceInvites(policy?: string): Promise<void> {
      const aliceGpg = new FakeGpgInvoker();
      aliceGpg.seedSecretKey("alice@example.org", KEY_ALICE);
      aliceGpg.seedKey("alice@example.org", fakeKey("A", "alice@example.org"));
      aliceGpg.seedKey(BOB, fakeKey("B", BOB));
      const { createInvite } = await import("./invite.ts");
      const { composeInviteBody } = await import("./envelope.ts");
      const invite = await createInvite({
        documentId: "doc-1",
        ownAddress: "alice@example.org",
        recipients: ["alice@example.org", BOB],
        profile: "yjs-paragraphs/1",
        gpg: aliceGpg,
        bindStorePath: join(tempDir, "alice", "threads.json"),
        ...(policy === undefined ? {} : { policy }),
      });
      if (!invite.ok) {
        throw new Error(invite.error);
      }
      receiver.seed("doc-1", [
        {
          messageId: ROOT,
          from: "alice@example.org",
          to: [BOB],
          cc: [],
          text: composeInviteBody("Join: http://localhost/?x", invite.armored),
        },
      ]);
    }

    function joinThread(overrides: Record<string, unknown> = {}) {
      return fetch(`${baseUrl}/threads/doc-1/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadRootMessageId: ROOT,
          recipients: ["alice@example.org", BOB],
          creator: "alice@example.org",
          profile: "yjs-paragraphs/1",
          pgpEnabled: true,
          ...overrides,
        }),
      });
    }

    it("joins by reading the creator's invitation, and pins every participant from it — not from the joiner's own keyring", async () => {
      await restartAsJoiner();
      await aliceInvites();
      // Bob's own keyring holds no key for Alice: hers comes from the invitation alone.

      const response = await joinThread();
      expect(response.status).toBe(200);
      const record = getBindRecord(bindStorePath, "doc-1");
      expect(record).toMatchObject({
        pgpEnabled: true,
        creatorMemberId: "alice@example.org",
        threadRootMessageId: ROOT,
        ownFingerprint: KEY_BOB,
        pinnedFingerprints: { "alice@example.org": KEY_ALICE, [BOB]: KEY_BOB },
        keyringPath: keyringPathFor(bindStorePath, "doc-1"),
      });
      const ring = bobGpg.withKeyring(record?.keyringPath ?? "");
      expect((await ring.listAllKeys()).map((key) => key.fingerprint).sort()).toEqual([
        KEY_ALICE,
        KEY_BOB,
      ]);
      expect(sender.sent).toHaveLength(0); // joining sends nothing
    });

    it("refuses the join when the user's own keyring holds a different key for the creator (EML-8)", async () => {
      await restartAsJoiner();
      await aliceInvites();
      bobGpg.seedKey("alice@example.org", fakeKey("D", "alice@example.org"));

      const response = await joinThread();
      expect(response.status).toBe(422);
      expect(await readJson(response)).toMatchObject({
        reason: "invite-creator-key-differs",
        sender: "alice@example.org",
      });
      expect(getBindRecord(bindStorePath, "doc-1")).toBeUndefined();
      expect(existsSync(keyringPathFor(bindStorePath, "doc-1"))).toBe(false);
    });

    it("reports the creator's signed send policy in the join response, keeps it, and reports it again on resume", async () => {
      await restartAsJoiner();
      await aliceInvites("30000,120000,0,inf,60000@0");
      const first = await joinThread();
      expect(first.status).toBe(200);
      expect(await readJson(first)).toMatchObject({ policy: "30000,120000,0,inf,60000@0" });
      expect(getBindRecord(bindStorePath, "doc-1")?.policy).toBe("30000,120000,0,inf,60000@0");

      receiver.seed("doc-1", []); // the invitation is gone from the mailbox; resuming must still say
      const again = await joinThread();
      expect(again.status).toBe(200);
      expect(await readJson(again)).toMatchObject({ policy: "30000,120000,0,inf,60000@0" });
    });

    it("says nothing about a policy when the invitation carried none", async () => {
      await restartAsJoiner();
      await aliceInvites();
      const body = (await readJson(await joinThread())) as Record<string, unknown>;
      expect("policy" in body).toBe(false);
    });

    it("takes the participants from what the creator signed, and writes the user's own keyring nothing", async () => {
      await restartAsJoiner();
      await aliceInvites();
      await joinThread();
      // Alice's key exists only in the document's keyring; Bob's own still knows nobody else.
      expect((await bobGpg.listKeys("alice@example.org")).map((key) => key.fingerprint)).toEqual(
        [],
      );
    });

    it("refuses an invitation that is not in the mailbox yet, with a retryable 404 and nothing stored", async () => {
      await restartAsJoiner();
      const response = await joinThread();
      expect(response.status).toBe(404);
      expect(await readJson(response)).toMatchObject({ reason: "invite-not-found" });
      expect(getBindRecord(bindStorePath, "doc-1")).toBeUndefined();
    });

    it("does not read the invitation again for a document it is already bound to — the creator reopening hers, or a participant resuming", async () => {
      await restartAsJoiner();
      await aliceInvites();
      expect((await joinThread()).status).toBe(200);
      const before = getBindRecord(bindStorePath, "doc-1");
      // The invitation is gone from the mailbox (the creator's own inbox never held it) — resuming must still work.
      receiver.seed("doc-1", []);
      bobGpg.opened.length = 0;
      const again = await joinThread();
      expect(again.status).toBe(200);
      expect(bobGpg.opened).toHaveLength(0);
      expect(getBindRecord(bindStorePath, "doc-1")).toEqual(before);
    });

    it("treats a join that differs from what is on file as a new join, read and verified from scratch", async () => {
      await restartAsJoiner();
      await aliceInvites();
      await joinThread();
      receiver.seed("doc-1", []);
      // Same document, but the link now names another thread: not a resume.
      const response = await joinThread({ threadRootMessageId: "<other@example.org>" });
      expect(response.status).toBe(404);
    });

    it("refuses an invitation whose link names the wrong creator, storing nothing and leaving no keyring", async () => {
      await restartAsJoiner();
      await aliceInvites();
      const response = await joinThread({ creator: BOB });
      expect(response.status).toBe(422);
      expect(await readJson(response)).toMatchObject({ reason: "invite-not-from-creator" });
      expect(getBindRecord(bindStorePath, "doc-1")).toBeUndefined();
      const dir = join(tempDir, "keyrings");
      expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
    });

    it("refuses an invitation encrypted to a key the joiner does not hold — the creator has a different key for them", async () => {
      await restartAsJoiner();
      await aliceInvites();
      // Bob's real key is not the one Alice encrypted to.
      const other = new FakeGpgInvoker();
      other.seedSecretKey(BOB, "F".repeat(40));
      other.seedKey(BOB, { fingerprint: "F".repeat(40), userIds: [BOB] });
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      start({ gpg: other, address: BOB, receiver });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const listening = server.address();
      baseUrl =
        typeof listening === "object" && listening ? `http://127.0.0.1:${listening.port}` : "";
      const response = await joinThread();
      expect(response.status).toBe(422);
      expect(await readJson(response)).toMatchObject({ reason: "invite-undecipherable" });
      expect(getBindRecord(bindStorePath, "doc-1")).toBeUndefined();
    });

    it("returns 503 rather than joining unverified when the bridge has no gpg, or no mailbox to read the invitation from", async () => {
      await restartAsJoiner({ withGpg: false });
      expect((await joinThread()).status).toBe(503);
      await restartAsJoiner({ withReceiver: false });
      expect((await joinThread()).status).toBe(503);
      expect(getBindRecord(bindStorePath, "doc-1")).toBeUndefined();
    });

    it("still joins a PGP-off document from the link alone — nothing is read, nothing checked", async () => {
      await restartAsJoiner();
      const response = await joinThread({ pgpEnabled: false });
      expect(response.status).toBe(200);
      expect(getBindRecord(bindStorePath, "doc-1")).toMatchObject({
        pgpEnabled: false,
        pinnedFingerprints: {},
      });
      expect(getBindRecord(bindStorePath, "doc-1")?.keyringPath).toBeUndefined();
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

  describe("GET /pgp/status", () => {
    let gpg: FakeGpgInvoker;

    function bindDoc(overrides: Partial<Parameters<typeof setBindRecord>[2]> = {}) {
      setBindRecord(bindStorePath, "doc-1", {
        recipients: ["alice@example.org", "bob@example.org"],
        creatorMemberId: "alice@example.org",
        profile: "yjs-paragraphs/1",
        threadRootMessageId: "<root@example.org>",
        createdAt: new Date(0).toISOString(),
        pgpEnabled: false,
        pinnedFingerprints: {},
        ...overrides,
      });
    }

    async function restartWithGpg(
      options: { ownSecretKey?: boolean; withGpg?: boolean } = {},
    ): Promise<void> {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      gpg = new FakeGpgInvoker();
      if (options.ownSecretKey ?? true) {
        gpg.seedSecretKey(sender.address, KEY_ME);
      }
      start({ gpg: options.withGpg === false ? undefined : gpg });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      baseUrl = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
    }

    /** doc-1 as an accepted invitation leaves it, with a document keyring built from `gpg`. */
    function bindPgpDoc(pins?: Record<string, string>) {
      bindDoc(
        pgpDocumentFields(
          gpg,
          keyringPathFor(bindStorePath, "doc-1"),
          { address: sender.address, fingerprint: KEY_ME },
          pins,
        ),
      );
    }

    const status = async () =>
      (await readJson(await fetch(`${baseUrl}/pgp/status?documentId=doc-1`))) as Record<
        string,
        unknown
      >;

    beforeEach(() => {
      bindDoc();
    });

    it("requires a documentId query parameter", async () => {
      const response = await fetch(`${baseUrl}/pgp/status`);
      expect(response.status).toBe(400);
    });

    it("returns 404 for a document with no thread started yet", async () => {
      const response = await fetch(`${baseUrl}/pgp/status?documentId=doc-never-started`);
      expect(response.status).toBe(404);
    });

    it("reports a PGP-off document as off, whatever gpg is installed, with nothing blocking it", async () => {
      expect(await status()).toEqual({
        enabled: false,
        gpgAvailable: false,
        missingKeysFor: [],
        sendBlockedReason: null,
      });
      await restartWithGpg();
      expect(await status()).toEqual({
        enabled: false,
        gpgAvailable: true,
        missingKeysFor: [],
        sendBlockedReason: null,
      });
      expect(gpg.queriedAddresses).toEqual([]); // never even looked at a keyring
    });

    it("reports a PGP-enabled document with no gpg as blocked, saying why", async () => {
      bindDoc({ pgpEnabled: true });
      expect(await status()).toEqual({
        enabled: true,
        gpgAvailable: false,
        missingKeysFor: [],
        sendBlockedReason: expect.stringContaining("no gpg binary"),
      });
    });

    it("reports which members the document's keyring lacks, and that sending is therefore blocked", async () => {
      await restartWithGpg();
      bindPgpDoc();
      gpg.withKeyring(keyringPathFor(bindStorePath, "doc-1")).removeKey(KEY_BOB);
      expect(await status()).toEqual({
        enabled: true,
        gpgAvailable: true,
        missingKeysFor: ["bob@example.org"],
        sendBlockedReason: expect.stringContaining("bob@example.org"),
      });
    });

    it("reports a key that is no longer the pinned one as blocking, naming the member", async () => {
      await restartWithGpg();
      bindPgpDoc({ "alice@example.org": KEY_ALICE, "bob@example.org": "D".repeat(40) });
      // The document keyring holds a different key for Bob than the one pinned.
      const ring = gpg.withKeyring(keyringPathFor(bindStorePath, "doc-1"));
      ring.removeKey("D".repeat(40));
      ring.seedKey("bob@example.org", fakeKey("B", "bob@example.org"));
      const result = await status();
      expect(result.missingKeysFor).toEqual(["bob@example.org"]);
      expect(result.sendBlockedReason).toEqual(expect.stringContaining("no longer holds"));
    });

    it("reports a PGP document without a keyring of its own as blocked, telling the user to start a new one", async () => {
      await restartWithGpg();
      bindDoc({ pgpEnabled: true });
      expect((await status()).sendBlockedReason).toEqual(
        expect.stringContaining("start a new document"),
      );
    });

    it("reports a ready document as enabled with nothing blocking it", async () => {
      await restartWithGpg();
      bindPgpDoc();
      expect(await status()).toEqual({
        enabled: true,
        gpgAvailable: true,
        missingKeysFor: [],
        sendBlockedReason: null,
      });
    });
  });

  describe("GET /pgp/keys (SPECIFICATION.md EML-4)", () => {
    let gpg: FakeGpgInvoker;

    function bindPgpDoc(overrides: Partial<Parameters<typeof setBindRecord>[2]> = {}) {
      setBindRecord(bindStorePath, "doc-1", {
        recipients: ["alice@example.org", "bob@example.org", "carol@example.org"],
        creatorMemberId: "alice@example.org",
        profile: "yjs-paragraphs/1",
        threadRootMessageId: "<root@example.org>",
        createdAt: new Date(0).toISOString(),
        ...pgpDocumentFields(
          gpg,
          keyringPathFor(bindStorePath, "doc-1"),
          { address: "bob@example.org", fingerprint: KEY_BOB },
          {
            "alice@example.org": KEY_ALICE,
            "bob@example.org": KEY_BOB,
            "carol@example.org": "C".repeat(40),
          },
        ),
        ...overrides,
      });
    }

    /** This bridge is Bob's. */
    async function restartAsBob(options: { withGpg?: boolean } = {}): Promise<void> {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      gpg = new FakeGpgInvoker();
      gpg.seedSecretKey("bob@example.org", KEY_BOB);
      start({ gpg: options.withGpg === false ? undefined : gpg, address: "bob@example.org" });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      baseUrl = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
    }

    const keys = (documentId = "doc-1") => fetch(`${baseUrl}/pgp/keys?documentId=${documentId}`);

    it("requires a documentId, and 404s for a document never started", async () => {
      await restartAsBob();
      expect((await fetch(`${baseUrl}/pgp/keys`)).status).toBe(400);
      expect((await keys("doc-never-started")).status).toBe(404);
    });

    it("says a PGP-off document has no keys to show", async () => {
      await restartAsBob();
      setBindRecord(bindStorePath, "doc-1", {
        recipients: ["alice@example.org", "bob@example.org"],
        creatorMemberId: "alice@example.org",
        profile: "yjs-paragraphs/1",
        threadRootMessageId: "<root@example.org>",
        createdAt: new Date(0).toISOString(),
        pgpEnabled: false,
        pinnedFingerprints: {},
      });
      expect(await readJson(await keys())).toEqual({ enabled: false });
    });

    it("says so, rather than guessing, when the bridge has no gpg to compare with", async () => {
      await restartAsBob({ withGpg: false });
      gpg = new FakeGpgInvoker();
      bindPgpDoc();
      expect(await readJson(await keys())).toEqual({ enabled: true, gpgAvailable: false });
    });

    it("lists every participant with the key the creator sent, who is who, and how it compares with the user's own keyring", async () => {
      await restartAsBob();
      bindPgpDoc();
      // Bob's own keyring: the same key for Alice, a different one for Carol, nothing else.
      gpg.seedKey("alice@example.org", { fingerprint: KEY_ALICE, userIds: ["alice@example.org"] });
      gpg.seedKey("carol@example.org", fakeKey("D", "carol@example.org"));
      gpg.seedKey("bob@example.org", { fingerprint: KEY_BOB, userIds: ["bob@example.org"] });

      const response = await keys();
      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({
        enabled: true,
        gpgAvailable: true,
        ownFingerprint: KEY_BOB,
        creator: "alice@example.org",
        entries: [
          {
            address: "alice@example.org",
            fingerprint: KEY_ALICE,
            isYou: false,
            isCreator: true,
            comparison: "match",
            localFingerprints: [KEY_ALICE],
          },
          {
            address: "bob@example.org",
            fingerprint: KEY_BOB,
            isYou: true,
            isCreator: false,
            comparison: "match",
            localFingerprints: [KEY_BOB],
          },
          {
            address: "carol@example.org",
            fingerprint: "C".repeat(40),
            isYou: false,
            isCreator: false,
            comparison: "different-locally",
            localFingerprints: ["D".repeat(40)],
          },
        ],
      });
    });

    it("calls a key the user's keyring has none of missing-locally, and a key among several a match", async () => {
      await restartAsBob();
      bindPgpDoc();
      gpg.seedKey("carol@example.org", fakeKey("D", "carol@example.org"));
      gpg.seedKey("carol@example.org", {
        fingerprint: "C".repeat(40),
        userIds: ["carol@example.org"],
      });
      const body = (await readJson(await keys())) as {
        entries: { address: string; comparison: string }[];
      };
      const byAddress = Object.fromEntries(body.entries.map((e) => [e.address, e.comparison]));
      expect(byAddress).toEqual({
        "alice@example.org": "missing-locally",
        "bob@example.org": "missing-locally",
        "carol@example.org": "match",
      });
    });

    it("recomputes the comparison on every request, so importing the right key clears its warning", async () => {
      await restartAsBob();
      bindPgpDoc();
      gpg.seedKey("alice@example.org", fakeKey("D", "alice@example.org"));
      const before = (await readJson(await keys())) as { entries: { comparison: string }[] };
      expect(before.entries[0]?.comparison).toBe("different-locally");
      gpg.seedKey("alice@example.org", { fingerprint: KEY_ALICE, userIds: ["alice@example.org"] });
      const after = (await readJson(await keys())) as { entries: { comparison: string }[] };
      expect(after.entries[0]?.comparison).toBe("match");
    });

    it("refuses a PGP document without a keyring of its own, telling the user to start a new one", async () => {
      await restartAsBob();
      bindPgpDoc({ ownFingerprint: undefined, keyringPath: undefined });
      const response = await keys();
      expect(response.status).toBe(409);
      expect(((await readJson(response)) as { error: string }).error).toContain(
        "start a new document",
      );
    });
  });

  describe("GET /channels/:documentId/integrity-log", () => {
    it("polls, then returns what the sync state has rejected for that document", async () => {
      sync.seedRejections("doc-1", [
        { messageId: "m1", sender: "mallory@example.org", reason: "pgp-identity-changed" },
      ]);
      const response = await fetch(`${baseUrl}/channels/doc-1/integrity-log`);
      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual([
        { messageId: "m1", sender: "mallory@example.org", reason: "pgp-identity-changed" },
      ]);
      expect(sync.polled).toEqual(["doc-1"]);
    });

    it("returns an empty list for a document with nothing rejected", async () => {
      const response = await fetch(`${baseUrl}/channels/doc-1/integrity-log`);
      expect(await readJson(response)).toEqual([]);
    });

    it("returns 503 while the bridge is unconfigured", async () => {
      server.close();
      start({ address: undefined, sender: undefined, sync: undefined });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      baseUrl = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
      const response = await fetch(`${baseUrl}/channels/doc-1/integrity-log`);
      expect(response.status).toBe(503);
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
