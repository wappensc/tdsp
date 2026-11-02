import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { TransportSendError } from "@tdsp/messenger-port";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EmailMessengerPort,
  emailMessengerProvider,
  generateThreadRootMessageId,
  InviteRejectedError,
  readIntegrityLog,
} from "./index.ts";

/**
 * A minimal, local stand-in for `bridges/email-bridge`'s own HTTP API — just
 * enough of its routes to verify `EmailMessengerPort` shapes requests and
 * responses correctly, without a real bridge, a real mailbox, or a real `gpg`
 * keyring (that real-server verification lives in `bridges/email-bridge`'s
 * own tests).
 */
function startFakeBridge(): Promise<{ server: Server; url: string; requests: unknown[] }> {
  const requests: unknown[] = [];
  const deliveries: { id: string; sender: string; payload: string }[] = [
    { id: "d1", sender: "alice@example.org", payload: "hi" },
  ];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body =
        chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      const [path] = (req.url ?? "").split("?", 2);
      requests.push({ method: req.method, url: req.url, body });

      if (req.method === "POST" && path === "/threads/doc-1") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ threadRootMessageId: "<root-1@example.org>" }));
        return;
      }
      if (req.method === "POST" && path === "/threads/doc-fail") {
        res.writeHead(422, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "recipients must be non-empty" }));
        return;
      }
      if (req.method === "POST" && path === "/threads/doc-1/join") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ documentId: "doc-1", ...(body as object) }));
        return;
      }
      if (req.method === "POST" && path === "/threads/doc-join-policy/join") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ documentId: "doc-join-policy", policy: "30000,120000,0,inf,60000@0" }),
        );
        return;
      }
      if (req.method === "POST" && path === "/threads/doc-join-fail/join") {
        res.writeHead(422, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "threadRootMessageId must be a non-empty string" }));
        return;
      }
      if (req.method === "POST" && path === "/threads/doc-rejected/join") {
        res.writeHead(422, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: "invitation rejected (invite-undecipherable): not encrypted to a key you hold",
            reason: "invite-undecipherable",
            sender: "alice@example.org",
          }),
        );
        return;
      }
      if (req.method === "POST" && path === "/threads/doc-strange-reason/join") {
        res.writeHead(422, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "nope", reason: "something-new" }));
        return;
      }
      if (req.method === "GET" && path === "/pgp/keys") {
        if (
          new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("documentId") === "doc-fail"
        ) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "doc-fail has no thread started yet" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            enabled: true,
            gpgAvailable: true,
            ownFingerprint: "B".repeat(40),
            creator: "alice@example.org",
            entries: [
              {
                address: "alice@example.org",
                fingerprint: "A".repeat(40),
                isYou: false,
                isCreator: true,
                comparison: "match",
                localFingerprints: ["A".repeat(40)],
              },
            ],
          }),
        );
        return;
      }
      if (req.method === "GET" && path === "/mail/status") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            configured: true,
            address: "me@example.org",
            smtp: { ok: true, tls: "implicit" },
            imap: { ok: false, error: "LOGIN failed", tls: "starttls-required" },
          }),
        );
        return;
      }
      if (req.method === "GET" && path === "/members") {
        const channelId = new URLSearchParams((req.url ?? "").split("?", 2)[1] ?? "").get(
          "channelId",
        );
        if (channelId === "not-a-list") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ members: ["x"] }));
          return;
        }
        if (channelId !== MEMBERS_CHANNEL) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "this account is not in that channel" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(MEMBERS));
        return;
      }
      if (req.method === "GET" && path === "/whoami") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "me@example.org" }));
        return;
      }
      if (req.method === "GET" && path === "/pgp/status") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            enabled: true,
            gpgAvailable: true,
            missingKeysFor: ["bob@example.org"],
            sendBlockedReason: "missing PGP key for bob@example.org — refusing to send",
          }),
        );
        return;
      }
      if (req.method === "GET" && path === "/channels/doc-1/integrity-log") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            {
              kind: "violation",
              id: "m1",
              sender: "mallory@example.org",
              reason: "pgp-identity-changed",
            },
          ]),
        );
        return;
      }
      if (req.method === "GET" && path === "/channels/doc-fail/integrity-log") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "email-bridge is not configured yet" }));
        return;
      }
      if (req.method === "POST" && path === "/channels/doc-1/send") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ deliveryId: "sent-1" }));
        return;
      }
      if (req.method === "GET" && path === "/transport-profile") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            bounds: { minIntervalMs: 15_000, maxBytes: null },
            pacing: {
              minIntervalMs: 30_000,
              maxIntervalMs: 120_000,
              minChars: 0,
              maxChars: null,
              expectedLatencyMs: 60_000,
            },
          }),
        );
        return;
      }
      const failingSend = /^\/channels\/doc-status-(\d+)\/send$/.exec(path ?? "");
      if (req.method === "POST" && failingSend) {
        // Answers with whatever status the test names, and a Retry-After as a
        // rate-limiting server would.
        res.writeHead(Number(failingSend[1]), {
          "content-type": "application/json",
          "retry-after": "3",
        });
        res.end(JSON.stringify({ error: `bridge answered ${failingSend[1]}` }));
        return;
      }
      if (req.method === "POST" && path === "/channels/doc-missing-key/send") {
        res.writeHead(422, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing PGP key for bob@example.org" }));
        return;
      }
      if (req.method === "GET" && path === "/channels/doc-1/deliveries") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(deliveries));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no such route" }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, requests });
    });
  });
}

/** A channel the fake bridge's account is in, and its members. */
const MEMBERS_CHANNEL = "<root@example.org>";
const MEMBERS = ["alice@example.org", "bob@example.org"];

describe("emailMessengerProvider", () => {
  it('registers as "email", matching VITE_MESSENGER_PROVIDER=email', () => {
    expect(emailMessengerProvider.id).toBe("email");
  });

  it("createPort() returns a real EmailMessengerPort", async () => {
    const port = await emailMessengerProvider.createPort();
    expect(port).toBeInstanceOf(EmailMessengerPort);
  });
});

describe("readIntegrityLog (BRG-15)", () => {
  it("reads a violation as the bridge serves it", () => {
    const entry = { kind: "violation", id: "<m@x>", sender: "bob@x", reason: "pgp-unsigned" };
    expect(readIntegrityLog([entry])).toEqual([entry]);
  });

  it("reads an entry without kind, from a bridge of TDSP 1.x, as a violation under its Message-ID", () => {
    expect(
      readIntegrityLog([{ messageId: "<m@x>", sender: "bob@x", reason: "message-replaced" }]),
    ).toEqual([{ kind: "violation", id: "<m@x>", sender: "bob@x", reason: "message-replaced" }]);
  });

  it("drops what is no entry, and refuses an answer that is no list", () => {
    expect(readIntegrityLog([null, 5, "x"])).toEqual([]);
    expect(() => readIntegrityLog({})).toThrow(/not a list/);
  });
});

describe("EmailMessengerPort", () => {
  let bridge: { server: Server; url: string; requests: unknown[] };
  let port: EmailMessengerPort;

  beforeEach(async () => {
    bridge = await startFakeBridge();
    port = new EmailMessengerPort(bridge.url);
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      bridge.server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("startThread() posts the recipient list to the bridge and returns the thread root", async () => {
    const result = await port.startThread(
      "doc-1",
      ["alice@example.org", "bob@example.org"],
      "alice@example.org",
      "yjs-paragraphs/1",
    );
    expect(result).toEqual({ threadRootMessageId: "<root-1@example.org>" });
    const posted = bridge.requests.find(
      (r) => (r as { url?: string }).url === "/threads/doc-1",
    ) as { method: string; body: Record<string, unknown> };
    expect(posted.method).toBe("POST");
    expect(posted.body).toMatchObject({
      recipients: ["alice@example.org", "bob@example.org"],
      creator: "alice@example.org",
      profile: "yjs-paragraphs/1",
    });
    // The thread root is chosen here and sent to the bridge, not left for the
    // mail server to invent, so the invitation link can name it.
    expect(posted.body.threadRootMessageId).toMatch(/^<[0-9a-f-]{36}@example\.org>$/);
  });

  /**
   * The point of choosing the id first: an invite's own `Message-ID` cannot be
   * read back into the text of the very email it names, so a complete invitation
   * link needs the id *before* the text exists.
   */
  it("startThread() builds the invite text from the very id it sends the email with", async () => {
    let seenByCallback = "";
    await port.startThread(
      "doc-1",
      ["alice@example.org", "bob@example.org"],
      "alice@example.org",
      "yjs-paragraphs/1",
      (threadRoot) => {
        seenByCallback = threadRoot;
        return `open http://localhost:5173/?threadRoot=${encodeURIComponent(threadRoot)}`;
      },
    );
    const posted = bridge.requests.find(
      (r) => (r as { url?: string }).url === "/threads/doc-1",
    ) as { body: { inviteText: string; threadRootMessageId: string } };
    expect(seenByCallback).toBe(posted.body.threadRootMessageId);
    expect(posted.body.inviteText).toBe(
      `open http://localhost:5173/?threadRoot=${encodeURIComponent(seenByCallback)}`,
    );
  });

  it("startThread() still accepts a plain string invite text", async () => {
    await port.startThread(
      "doc-1",
      ["a@example.org"],
      "a@example.org",
      "yjs-paragraphs/1",
      "hello there",
    );
    const posted = bridge.requests.find(
      (r) => (r as { url?: string }).url === "/threads/doc-1",
    ) as { body: { inviteText: string } };
    expect(posted.body.inviteText).toBe("hello there");
  });

  it("startThread() picks a different thread root every time", async () => {
    const roots = new Set<string>();
    for (let i = 0; i < 5; i++) {
      await port.startThread("doc-1", ["a@example.org"], "a@example.org", "yjs-paragraphs/1");
    }
    for (const r of bridge.requests) {
      const body = (r as { body?: { threadRootMessageId?: string } }).body;
      if (body?.threadRootMessageId) {
        roots.add(body.threadRootMessageId);
      }
    }
    expect(roots.size).toBe(5);
  });

  it("startThread() throws a clear error when the bridge rejects it", async () => {
    await expect(
      port.startThread("doc-fail", [], "alice@example.org", "yjs-paragraphs/1"),
    ).rejects.toThrow(/doc-fail.*422/);
  });

  it("joinThread() posts the thread's known details to the bridge's join route", async () => {
    await expect(
      port.joinThread(
        "doc-1",
        "<root-1@example.org>",
        ["alice@example.org", "bob@example.org"],
        "alice@example.org",
        "yjs-paragraphs/1",
      ),
    ).resolves.toEqual({}); // this bridge reported no policy
    expect(bridge.requests).toContainEqual({
      method: "POST",
      url: "/threads/doc-1/join",
      body: {
        threadRootMessageId: "<root-1@example.org>",
        recipients: ["alice@example.org", "bob@example.org"],
        creator: "alice@example.org",
        profile: "yjs-paragraphs/1",
      },
    });
  });

  it("joinThread() hands back the creator's signed send policy when the bridge reports one", async () => {
    await expect(
      port.joinThread(
        "doc-join-policy",
        "<root@example.org>",
        ["a@example.org"],
        "a@example.org",
        "yjs-paragraphs/1",
        true,
      ),
    ).resolves.toEqual({ policy: "30000,120000,0,inf,60000@0" });
  });

  it("startThread() sends the creator's send policy along, for the bridge to sign into the invitation", async () => {
    await port.startThread(
      "doc-1",
      ["a@example.org"],
      "a@example.org",
      "yjs-paragraphs/1",
      undefined,
      true,
      "0,inf,0,inf,0@0",
    );
    const request = bridge.requests
      .filter((r) => (r as { url?: string }).url === "/threads/doc-1")
      .at(-1) as { body: { policy?: string } };
    expect(request.body.policy).toBe("0,inf,0,inf,0@0");
  });

  it("joinThread() throws a clear error when the bridge rejects it", async () => {
    await expect(
      port.joinThread("doc-join-fail", "", [], "alice@example.org", "yjs-paragraphs/1"),
    ).rejects.toThrow(/doc-join-fail.*422/);
  });

  it("joinThread() throws an InviteRejectedError carrying the reason and the sender when the bridge refuses the invitation", async () => {
    const error = await port
      .joinThread(
        "doc-rejected",
        "<root@example.org>",
        [],
        "alice@example.org",
        "yjs-paragraphs/1",
        true,
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InviteRejectedError);
    expect(error).toMatchObject({
      reason: "invite-undecipherable",
      sender: "alice@example.org",
      message: expect.stringContaining("422"),
    });
  });

  it("joinThread() does not invent a reason: an unknown one stays an ordinary error", async () => {
    const error = await port
      .joinThread(
        "doc-strange-reason",
        "<root@example.org>",
        [],
        "alice@example.org",
        "yjs-paragraphs/1",
        true,
      )
      .catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(InviteRejectedError);
    expect((error as Error).message).toMatch(/doc-strange-reason.*422/);
  });

  it("createDocument() succeeds after a matching joinThread(), without any further bridge call", async () => {
    await port.joinThread(
      "doc-1",
      "<root-1@example.org>",
      ["alice@example.org", "bob@example.org"],
      "alice@example.org",
      "yjs-paragraphs/1",
    );
    const requestCountBeforeCreate = bridge.requests.length;
    await expect(port.createDocument("doc-1", "alice@example.org")).resolves.toBeUndefined();
    expect(bridge.requests).toHaveLength(requestCountBeforeCreate);
  });

  it("createDocument() succeeds after a matching startThread(), without any further bridge call", async () => {
    await port.startThread("doc-1", ["alice@example.org"], "alice@example.org", "yjs-paragraphs/1");
    const requestCountBeforeCreate = bridge.requests.length;
    await expect(port.createDocument("doc-1", "alice@example.org")).resolves.toBeUndefined();
    expect(bridge.requests).toHaveLength(requestCountBeforeCreate);
  });

  it("createDocument() rejects when called before startThread()", async () => {
    await expect(port.createDocument("doc-never-started", "alice@example.org")).rejects.toThrow(
      /no thread started yet/,
    );
  });

  it("createDocument() rejects a creator that doesn't match the one startThread() recorded", async () => {
    await port.startThread("doc-1", ["alice@example.org"], "alice@example.org", "yjs-paragraphs/1");
    await expect(port.createDocument("doc-1", "bob@example.org")).rejects.toThrow(
      /creator mismatch/,
    );
  });

  it("channelMembers() asks the bridge for a channel's members and refuses what is not a list of ids (TRN-17)", async () => {
    await expect(port.channelMembers(MEMBERS_CHANNEL)).resolves.toEqual(MEMBERS);
    expect(bridge.requests).toContainEqual(
      expect.objectContaining({
        method: "GET",
        url: `/members?channelId=${encodeURIComponent(MEMBERS_CHANNEL)}`,
      }),
    );
    await expect(port.channelMembers("elsewhere")).rejects.toThrow(/404/);
    await expect(port.channelMembers("not-a-list")).rejects.toThrow(/not a list/);
  });

  it("whoami() returns the bridge mailbox's own address as MemberId", async () => {
    await expect(port.whoami()).resolves.toEqual({ id: "me@example.org" });
  });

  it("mailStatus() reports each connection's login and how it is secured, and a failure with the server's reason", async () => {
    await expect(port.mailStatus()).resolves.toEqual({
      configured: true,
      address: "me@example.org",
      smtp: { ok: true, tls: "implicit" },
      imap: { ok: false, error: "LOGIN failed", tls: "starttls-required" },
    });
  });

  it("pgpStatus() returns the document's PGP state, who lacks a key, and why sending is blocked", async () => {
    await expect(port.pgpStatus("doc-1")).resolves.toEqual({
      enabled: true,
      gpgAvailable: true,
      missingKeysFor: ["bob@example.org"],
      sendBlockedReason: "missing PGP key for bob@example.org — refusing to send",
    });
  });

  it("pgpKeys() returns each participant's key as the creator sent it, and how it compares with the user's own keyring", async () => {
    await expect(port.pgpKeys("doc-1")).resolves.toMatchObject({
      enabled: true,
      gpgAvailable: true,
      ownFingerprint: "B".repeat(40),
      creator: "alice@example.org",
      entries: [{ address: "alice@example.org", isCreator: true, comparison: "match" }],
    });
    expect(bridge.requests).toContainEqual({
      method: "GET",
      url: "/pgp/keys?documentId=doc-1",
      body: undefined,
    });
  });

  it("pgpKeys() surfaces a bridge failure instead of pretending there are no keys", async () => {
    await expect(port.pgpKeys("doc-fail")).rejects.toThrow(/pgpKeys\(doc-fail\) failed: 404/);
  });

  it("integrityLog() returns what the bridge rejected, with reasons", async () => {
    await expect(port.integrityLog("doc-1")).resolves.toEqual([
      {
        kind: "violation",
        id: "m1",
        sender: "mallory@example.org",
        reason: "pgp-identity-changed",
      },
    ]);
  });

  it("integrityLog() surfaces a bridge failure instead of pretending nothing was rejected", async () => {
    await expect(port.integrityLog("doc-fail")).rejects.toThrow(
      /integrityLog\(doc-fail\) failed: 503/,
    );
  });

  it("listChannels() is always empty and makes no bridge call at all (a capability gap)", async () => {
    const channelsBefore = bridge.requests.length;
    await expect(port.listChannels("alice@example.org")).resolves.toEqual([]);
    expect(bridge.requests).toHaveLength(channelsBefore);
  });

  it("send() posts the frame's text as the payload and returns the bridge's deliveryId", async () => {
    const deliveryId = await port.send("doc-1", "alice@example.org", "hello");
    expect(deliveryId).toBe("sent-1");
    expect(bridge.requests).toContainEqual({
      method: "POST",
      url: "/channels/doc-1/send",
      body: { sender: "alice@example.org", payload: "hello" },
    });
  });

  it("transportProfile() reads the bridge's own statement of its limits", async () => {
    const profile = await port.transportProfile();
    expect(profile?.bounds.minIntervalMs).toBe(15_000);
    expect(profile?.pacing.minIntervalMs).toBe(30_000);
    expect(bridge.requests).toContainEqual({
      method: "GET",
      url: "/transport-profile",
      body: undefined,
    });
  });

  it("transportProfile() fails when the bridge answers something that is not a profile, instead of falling back to no limits", async () => {
    const broken = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ bounds: {}, profiles: [], defaultProfile: "gone" }));
    });
    await new Promise<void>((resolve) => broken.listen(0, resolve));
    try {
      const { port: brokenPort } = broken.address() as AddressInfo;
      const brokenAdapter = new EmailMessengerPort(`http://127.0.0.1:${brokenPort}`);
      await expect(brokenAdapter.transportProfile()).rejects.toThrow(/not a transport profile/);
    } finally {
      await new Promise<void>((resolve) => broken.close(() => resolve()));
    }
  });

  it("transportProfile() fails when the bridge cannot answer", async () => {
    await expect(new EmailMessengerPort("http://127.0.0.1:1").transportProfile()).rejects.toThrow();
  });

  it.each([
    [429, "rate-limited", true],
    [413, "too-large", false],
    [422, "rejected", false],
    [404, "rejected", false],
    [502, "unavailable", true],
    [503, "unavailable", true],
  ] as const)(
    "send() throws a TransportSendError for a bridge answering %i: %s",
    async (status, reason, retryable) => {
      const error = await port.send(`doc-status-${status}`, "alice@example.org", "hello").then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(TransportSendError);
      expect((error as TransportSendError).reason).toBe(reason);
      expect((error as TransportSendError).retryable).toBe(retryable);
      expect((error as TransportSendError).message).toMatch(new RegExp(`failed: ${status} `));
    },
  );

  it("send() passes a 429's Retry-After on, so the scheduler waits as long as the provider asked", async () => {
    const error = (await port
      .send("doc-status-429", "alice@example.org", "hello")
      .catch((caught: unknown) => caught)) as TransportSendError;
    expect(error.retryAfterMs).toBe(3000);
  });

  it("send() surfaces the bridge's pre-send key-completeness rejection", async () => {
    await expect(port.send("doc-missing-key", "alice@example.org", "hello")).rejects.toThrow(
      /missing PGP key for bob@example\.org/,
    );
  });

  it("receive() returns the bridge's text payloads as Delivery[]", async () => {
    const deliveries = await port.receive("doc-1", "bob@example.org");
    expect(deliveries).toEqual([
      {
        id: "d1",
        documentId: "doc-1",
        sender: "alice@example.org",
        payload: "hi",
      },
    ]);
  });
});

describe("generateThreadRootMessageId", () => {
  it("is <uuid@domain>, the domain being the creator's own", () => {
    expect(generateThreadRootMessageId("alice@example.org")).toMatch(
      /^<[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@example\.org>$/,
    );
  });

  it.each([
    ["no domain", "alice"],
    ["a domain with characters a Message-ID must not carry", "alice@exa mple.org>\r\nBcc: x"],
    ["an empty domain", "alice@"],
  ])("falls back to a reserved domain for %s", (_name, creator) => {
    expect(generateThreadRootMessageId(creator)).toMatch(/@tdsp\.invalid>$/);
  });
});

describe("instance() (TRN-19)", () => {
  /** A bridge whose `/health` answers `body` with `status`, every time. */
  async function bridgeAnswering(
    body: unknown,
    status = 200,
  ): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
    const server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it("names the instance the bridge's /health names", async () => {
    const bridge = await bridgeAnswering({ status: "ok", instance: "epoch-1" });
    try {
      await expect(new EmailMessengerPort(bridge.url).instance()).resolves.toBe("epoch-1");
    } finally {
      await bridge.close();
    }
  });

  it("refuses a bridge that names no instance, or an empty one, rather than answer a fixed value (TRN-9)", async () => {
    for (const body of [
      { status: "ok" },
      { status: "ok", instance: "" },
      { status: "ok", instance: 1 },
      null,
    ]) {
      const bridge = await bridgeAnswering(body);
      try {
        await expect(new EmailMessengerPort(bridge.url).instance()).rejects.toThrow(
          /names no instance/,
        );
      } finally {
        await bridge.close();
      }
    }
  });

  it("refuses an answer that is not ok", async () => {
    const bridge = await bridgeAnswering({ error: "down" }, 503);
    try {
      await expect(new EmailMessengerPort(bridge.url).instance()).rejects.toThrow(/503/);
    } finally {
      await bridge.close();
    }
  });
});

describe("receiveSince() (TRN-18, TRN-21)", () => {
  /** A bridge that answers `deliveries-since` with `body`, and records what it was asked. */
  async function bridgeAnswering(body: unknown, status = 200) {
    const asked: string[] = [];
    const server = createServer((req, res) => {
      asked.push(req.url ?? "");
      if (req.method === "GET" && (req.url ?? "").startsWith("/channels/doc-1/deliveries-since")) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}`,
      asked,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it("asks for what came after the cursor and answers the deliveries and truncated", async () => {
    const bridge = await bridgeAnswering({
      deliveries: [{ id: "d2", sender: "bob", payload: "Ag==" }],
      truncated: true,
    });
    try {
      await expect(
        new EmailMessengerPort(bridge.url).receiveSince("doc-1", "bob", "d1"),
      ).resolves.toEqual({
        deliveries: [{ id: "d2", documentId: "doc-1", sender: "bob", payload: "Ag==" }],
        truncated: true,
      });
      await new EmailMessengerPort(bridge.url).receiveSince("doc-1", "bob", undefined);
      expect(bridge.asked).toEqual([
        "/channels/doc-1/deliveries-since?after=d1",
        "/channels/doc-1/deliveries-since",
      ]);
    } finally {
      await bridge.close();
    }
  });

  it("refuses an answer of another shape, and a bridge that does not offer the cursor (TRN-9)", async () => {
    for (const body of [{ deliveries: [] }, { truncated: false }, []]) {
      const bridge = await bridgeAnswering(body);
      try {
        await expect(
          new EmailMessengerPort(bridge.url).receiveSince("doc-1", "bob", "d1"),
        ).rejects.toThrow(/not deliveries and truncated/);
      } finally {
        await bridge.close();
      }
    }
    const old = await bridgeAnswering({}, 404);
    try {
      await expect(
        new EmailMessengerPort(old.url).receiveSince("doc-1", "bob", "d1"),
      ).rejects.toThrow(/404/);
    } finally {
      await old.close();
    }
  });
});
