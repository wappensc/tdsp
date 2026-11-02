import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { TransportSendError } from "@tdsp/messenger-port";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MatrixMessengerPort, matrixMessengerProvider } from "./index.ts";
import {
  describeMatrixIntegrityEntry,
  type IntegrityReason,
  readIntegrityLog,
} from "./integrity.ts";

/**
 * A minimal, local stand-in for `bridges/matrix-bridge`'s own HTTP API —
 * enough of its routes to verify `MatrixMessengerPort` shapes
 * requests/responses correctly, without needing the real bridge or a
 * real Synapse (that real-server verification lives in the bridge's own
 * `bind.test.ts`/`send-receive.test.ts`, matching how
 * `bridges/signal-bridge/src/server.test.ts` uses a `FakeAuth` instead of a
 * real `signal-cli`).
 */
function startFakeBridge(): Promise<{ server: Server; url: string; requests: unknown[] }> {
  const requests: unknown[] = [];
  const deliveries: { id: string; sender: string; payload: string }[] = [
    { id: "$d1", sender: "alice", payload: "hi" },
  ];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body =
        chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      const [path] = (req.url ?? "").split("?", 2);
      requests.push({ method: req.method, url: req.url, body });

      if (req.method === "POST" && path === "/channels/doc-1/bind") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ documentId: "doc-1", ...body }));
        return;
      }
      if (req.method === "POST" && path === "/channels/doc-fail/bind") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "room does not exist" }));
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
        res.end(JSON.stringify({ id: "@fake-bridge-account:tdsp.test" }));
        return;
      }
      if (req.method === "GET" && path === "/channels") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            { id: "!plain:example.org", name: "Plain room", encrypted: false },
            { id: "!enc:example.org", name: "Encrypted room", encrypted: true },
          ]),
        );
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
      if (req.method === "POST" && path === "/channels/doc-1/send") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ deliveryId: "$sent-1" }));
        return;
      }
      if (req.method === "GET" && path === "/channels/doc-1/deliveries") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(deliveries));
        return;
      }
      if (req.method === "POST" && path === "/channels/doc-1/invite") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ deliveryId: "$invite-1" }));
        return;
      }
      if (req.method === "POST" && path === "/channels/doc-forbidden/invite") {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not the creator" }));
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
const MEMBERS_CHANNEL = "!members:example.org";
const MEMBERS = ["@alice:example.org", "@bob:example.org"];

describe("matrixMessengerProvider", () => {
  it('registers as "matrix", matching VITE_MESSENGER_PROVIDER=matrix', () => {
    expect(matrixMessengerProvider.id).toBe("matrix");
  });

  it("createPort() returns a real MatrixMessengerPort", async () => {
    const port = await matrixMessengerProvider.createPort();
    expect(port).toBeInstanceOf(MatrixMessengerPort);
  });
});

describe("describeMatrixIntegrityEntry", () => {
  // Every reason the bridge can record (BRG-12), each named once: a reason with no wording would
  // reach the application as an entry it cannot show (BRG-15).
  const reasons = {
    "message-edited": true,
    "message-redacted": true,
    "message-replaced": true,
  } satisfies Record<IntegrityReason, true>;

  it.each(Object.keys(reasons) as IntegrityReason[])(
    "words %s as an alert naming its sender",
    (reason) => {
      const described = describeMatrixIntegrityEntry({
        kind: "violation",
        id: "$e",
        sender: "@alice:hs",
        reason,
      });
      expect(described.severity).toBe("alert");
      expect(described.text).toContain("@alice:hs");
    },
  );
});

describe("readIntegrityLog (BRG-15)", () => {
  it("reads a violation as the bridge serves it", () => {
    const entry = { kind: "violation", id: "$e", sender: "@alice:hs", reason: "message-edited" };
    expect(readIntegrityLog([entry])).toEqual([entry]);
  });

  it("reads an entry without kind, from a bridge of TDSP 1.x, as a violation under its event id", () => {
    expect(
      readIntegrityLog([{ eventId: "$e", sender: "@alice:hs", reason: "message-redacted" }]),
    ).toEqual([{ kind: "violation", id: "$e", sender: "@alice:hs", reason: "message-redacted" }]);
  });

  it("drops what is no entry, and refuses an answer that is no list", () => {
    expect(readIntegrityLog([null, 5, "x"])).toEqual([]);
    expect(() => readIntegrityLog({})).toThrow(/not a list/);
  });
});

describe("MatrixMessengerPort", () => {
  let bridge: { server: Server; url: string; requests: unknown[] };
  let port: MatrixMessengerPort;

  beforeEach(async () => {
    bridge = await startFakeBridge();
    port = new MatrixMessengerPort(bridge.url);
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      bridge.server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("bind() posts to the bridge's bind route", async () => {
    await port.bind("doc-1", "!plain:example.org", "alice", "yjs-paragraphs/1");
    expect(bridge.requests).toContainEqual({
      method: "POST",
      url: "/channels/doc-1/bind",
      body: { channelId: "!plain:example.org", creator: "alice", profile: "yjs-paragraphs/1" },
    });
  });

  it("bind() throws a clear error when the bridge rejects the room", async () => {
    await expect(
      port.bind("doc-fail", "!unknown:example.org", "alice", "yjs-paragraphs/1"),
    ).rejects.toThrow(/doc-fail.*!unknown:example.org.*404/);
  });

  it("createDocument() succeeds after a matching bind(), without any further bridge call", async () => {
    await port.bind("doc-1", "!plain:example.org", "alice", "yjs-paragraphs/1");
    const requestCountBeforeCreate = bridge.requests.length;
    await expect(port.createDocument("doc-1", "alice")).resolves.toBeUndefined();
    expect(bridge.requests).toHaveLength(requestCountBeforeCreate);
  });

  it("createDocument() rejects when called before bind()", async () => {
    await expect(port.createDocument("doc-never-bound", "alice")).rejects.toThrow(
      /no room bound yet/,
    );
  });

  it("createDocument() rejects a creator that doesn't match the one bind() recorded", async () => {
    await port.bind("doc-1", "!plain:example.org", "alice", "yjs-paragraphs/1");
    await expect(port.createDocument("doc-1", "bob")).rejects.toThrow(/creator mismatch/);
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

  it("whoami() returns the bridge account's own MemberId", async () => {
    await expect(port.whoami()).resolves.toEqual({
      id: "@fake-bridge-account:tdsp.test",
    });
  });

  it("sendInvitation() posts actor and text to the bridge", async () => {
    await expect(
      port.sendInvitation("doc-1", "alice", "join my document: https://example.org/join"),
    ).resolves.toBe("$invite-1");
    expect(bridge.requests).toContainEqual({
      method: "POST",
      url: "/channels/doc-1/invite",
      body: { actor: "alice", text: "join my document: https://example.org/join" },
    });
  });

  it("sendInvitation() surfaces a non-creator rejection", async () => {
    await expect(port.sendInvitation("doc-forbidden", "bob", "hi")).rejects.toThrow(
      /not the creator/,
    );
  });

  it("listChannels() returns the bridge's raw room list, mapped to RawChannel", async () => {
    const channels = await port.listChannels("alice");
    expect(channels).toEqual([
      { id: "!plain:example.org", name: "Plain room", encrypted: false },
      { id: "!enc:example.org", name: "Encrypted room", encrypted: true },
    ]);
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
      const brokenAdapter = new MatrixMessengerPort(`http://127.0.0.1:${brokenPort}`);
      await expect(brokenAdapter.transportProfile()).rejects.toThrow(/not a transport profile/);
    } finally {
      await new Promise<void>((resolve) => broken.close(() => resolve()));
    }
  });

  it("transportProfile() fails when the bridge cannot answer", async () => {
    await expect(
      new MatrixMessengerPort("http://127.0.0.1:1").transportProfile(),
    ).rejects.toThrow();
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

  it("send() posts the frame's text as the payload and returns the bridge's deliveryId", async () => {
    const deliveryId = await port.send("doc-1", "alice", "hello");
    expect(deliveryId).toBe("$sent-1");
    expect(bridge.requests).toContainEqual({
      method: "POST",
      url: "/channels/doc-1/send",
      body: { sender: "alice", payload: "hello" },
    });
  });

  it("receive() returns the bridge's text payloads as Delivery[]", async () => {
    const deliveries = await port.receive("doc-1", "bob");
    expect(deliveries).toEqual([
      { id: "$d1", documentId: "doc-1", sender: "alice", payload: "hi" },
    ]);
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
      await expect(new MatrixMessengerPort(bridge.url).instance()).resolves.toBe("epoch-1");
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
        await expect(new MatrixMessengerPort(bridge.url).instance()).rejects.toThrow(
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
      await expect(new MatrixMessengerPort(bridge.url).instance()).rejects.toThrow(/503/);
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
        new MatrixMessengerPort(bridge.url).receiveSince("doc-1", "bob", "d1"),
      ).resolves.toEqual({
        deliveries: [{ id: "d2", documentId: "doc-1", sender: "bob", payload: "Ag==" }],
        truncated: true,
      });
      await new MatrixMessengerPort(bridge.url).receiveSince("doc-1", "bob", undefined);
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
          new MatrixMessengerPort(bridge.url).receiveSince("doc-1", "bob", "d1"),
        ).rejects.toThrow(/not deliveries and truncated/);
      } finally {
        await bridge.close();
      }
    }
    const old = await bridgeAnswering({}, 404);
    try {
      await expect(
        new MatrixMessengerPort(old.url).receiveSince("doc-1", "bob", "d1"),
      ).rejects.toThrow(/404/);
    } finally {
      await old.close();
    }
  });
});
