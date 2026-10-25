import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Delivery,
  parseTransportProfile,
  transportSendErrorFromHttp,
} from "@tdsp/messenger-port";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BindStoreData } from "./bind-store.ts";
import { MatrixApiError } from "./matrix-api.ts";
import {
  createServer,
  type MatrixRoomReader,
  type MatrixRoomWriter,
  type RoomSummary,
  type ServerDependencies,
} from "./server.ts";
import type { IntegrityEntry, SyncState } from "./sync-state.ts";
import { MATRIX_HOMESERVER_PROFILE, MATRIX_LOCAL_PROFILE } from "./transport-profile.ts";

/**
 * Never talks to a real homeserver — `server.ts` takes `MatrixRoomReader`/
 * `MatrixRoomWriter`/`SyncState` as parameters specifically so this file
 * can stay fast and CI-safe (see `server.ts`'s own doc comment,
 * mirroring `bridges/signal-bridge/src/server.test.ts`'s `FakeAuth`). The
 * real implementations (`fetch()` against a live Synapse) are covered
 * separately by `bind.test.ts`/`send-receive.test.ts`, gated on
 * `hasTestMatrixHomeserver()`.
 */
class FakeMatrixRoomReader implements MatrixRoomReader {
  rooms: RoomSummary[] = [];
  joinedRoomIds = new Set<string>();
  encryptedRoomIds = new Set<string>();
  userId = "@fake-bridge-account:tdsp.test";

  async listJoinedRoomSummaries(): Promise<readonly RoomSummary[]> {
    return this.rooms;
  }

  async isJoinedMember(roomId: string): Promise<boolean> {
    return this.joinedRoomIds.has(roomId);
  }

  async isEncrypted(roomId: string): Promise<boolean> {
    return this.encryptedRoomIds.has(roomId);
  }

  async whoami(): Promise<{ id: string }> {
    return { id: this.userId };
  }

  members = new Map<string, readonly string[]>();
  async joinedMembers(roomId: string): Promise<readonly string[] | undefined> {
    return this.joinedRoomIds.has(roomId) ? (this.members.get(roomId) ?? []) : undefined;
  }
}

// `encrypted` is only recorded here, in `encryptedSends`: the real encrypt/decrypt path is
// covered live by crypto.security.test.ts, gated on hasTestMatrixHomeserver(), same
// fast-fake/real-integration split every other route already has.
class FakeMatrixRoomWriter implements MatrixRoomWriter {
  sentEdits: { roomId: string; documentId: string; payload: string }[] = [];
  /** For each edit sent, whether the route asked for it to be encrypted. */
  encryptedSends: boolean[] = [];
  #nextId = 0;

  async sendEdit(
    roomId: string,
    documentId: string,
    payload: string,
    encrypted: boolean,
  ): Promise<string> {
    this.sentEdits.push({ roomId, documentId, payload });
    this.encryptedSends.push(encrypted);
    this.#nextId += 1;
    return `$fake-edit-${this.#nextId}`;
  }

  sentInviteMessages: { roomId: string; text: string }[] = [];

  async sendInviteMessage(roomId: string, text: string): Promise<string> {
    this.sentInviteMessages.push({ roomId, text });
    this.#nextId += 1;
    return `$fake-invite-${this.#nextId}`;
  }
}

/** The reason an adapter reads from a refused send's status (LBI-6). */
const reasonOf = (status: number, body: string) =>
  transportSendErrorFromHttp("send", status, body).reason;

class FakeSyncState implements SyncState {
  deliveries = new Map<string, Delivery[]>();
  integrityLog = new Map<string, IntegrityEntry[]>();
  pollCount = 0;

  async pollOnce(): Promise<void> {
    this.pollCount += 1;
  }

  getDeliveries(documentId: string): readonly Delivery[] {
    return this.deliveries.get(documentId) ?? [];
  }

  getIntegrityLog(documentId: string): readonly IntegrityEntry[] {
    return this.integrityLog.get(documentId) ?? [];
  }

  seenEncrypted = new Set<string>();

  hasSeenEncrypted(roomId: string): boolean {
    return this.seenEncrypted.has(roomId);
  }
}

describe("matrix-bridge HTTP API", () => {
  let server: Server;
  let baseUrl: string;
  let rooms: FakeMatrixRoomReader;
  let writer: FakeMatrixRoomWriter;
  let sync: FakeSyncState;
  let bindStoreDir: string;
  let bindStorePath: string;

  beforeEach(async () => {
    rooms = new FakeMatrixRoomReader();
    rooms.userId = "alice"; // the account this bridge sends as (BRG-16)
    writer = new FakeMatrixRoomWriter();
    sync = new FakeSyncState();
    bindStoreDir = mkdtempSync(join(tmpdir(), "matrix-bridge-bind-store-"));
    bindStorePath = join(bindStoreDir, "tdsp-channels.json");
    const deps: ServerDependencies = {
      homeserverUrl: "http://localhost:18008",
      accessToken: "fake-token",
      rooms,
      writer,
      sync,
      bindStorePath,
    };
    server = createServer(deps);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(bindStoreDir, { recursive: true, force: true });
  });

  it("GET /health reports ok and whether an access token is configured", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      homeserverUrl: "http://localhost:18008",
      configured: true,
      instance: expect.any(String),
    });
  });

  it("names its window's instance on /health: the same while it runs, another after a start (TRN-19)", async () => {
    const instanceAt = async (url: string): Promise<unknown> =>
      ((await (await fetch(`${url}/health`)).json()) as { instance?: unknown }).instance;
    const first = await instanceAt(baseUrl);
    expect(typeof first).toBe("string");
    expect(first).not.toBe("");
    expect(await instanceAt(baseUrl)).toBe(first);
    // A start keeps nothing of the window, which this bridge holds only in memory.
    const restarted = createServer({
      homeserverUrl: "http://localhost:18008",
      accessToken: "fake-token",
      rooms,
      writer,
      sync,
      bindStorePath,
    });
    await new Promise<void>((resolve) => restarted.listen(0, resolve));
    try {
      const { port } = restarted.address() as AddressInfo;
      expect(await instanceAt(`http://127.0.0.1:${port}`)).not.toBe(first);
    } finally {
      await new Promise<void>((resolve) => restarted.close(() => resolve()));
    }
  });

  it("GET /whoami returns the bridge account's own id", async () => {
    const response = await fetch(`${baseUrl}/whoami`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: rooms.userId });
  });

  it("GET /device reports this bridge's own device and public key, and 503 while unconfigured", async () => {
    const unconfigured = await fetch(`${baseUrl}/device`);
    expect(unconfigured.status).toBe(503);
    await unconfigured.text();

    const withDevice = createServer({
      homeserverUrl: "http://localhost:18008",
      accessToken: "fake-token",
      rooms,
      writer,
      sync,
      bindStorePath,
      ownDevice: { deviceId: "BRIDGEDEV", ed25519: "pubkey" },
    });
    await new Promise<void>((resolve) => withDevice.listen(0, resolve));
    try {
      const { port } = withDevice.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/device`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ deviceId: "BRIDGEDEV", ed25519: "pubkey" });
    } finally {
      await new Promise<void>((resolve) => withDevice.close(() => resolve()));
    }
  });

  it("GET /members answers a joined room's members, refuses one this account is not in, and needs a channelId (TRN-17)", async () => {
    rooms.joinedRoomIds.add("!joined:example.org");
    rooms.members.set("!joined:example.org", [
      "@fake-bridge-account:tdsp.test",
      "@bob:example.org",
    ]);
    rooms.members.set("!other:example.org", ["@mallory:example.org"]);
    const members = (channelId: string) =>
      fetch(`${baseUrl}/members?channelId=${encodeURIComponent(channelId)}`);

    const joined = await members("!joined:example.org");
    expect(joined.status).toBe(200);
    await expect(joined.json()).resolves.toEqual([
      "@fake-bridge-account:tdsp.test",
      "@bob:example.org",
    ]);
    const other = await members("!other:example.org");
    expect(other.status).toBe(404);
    expect(await other.text()).not.toContain("mallory");
    expect((await fetch(`${baseUrl}/members`)).status).toBe(400);
  });

  it("GET /channels returns the room reader's raw room list", async () => {
    rooms.rooms = [
      { id: "!plain:example.org", name: "Plain room", encrypted: false },
      { id: "!enc:example.org", name: "Encrypted room", encrypted: true },
    ];
    const response = await fetch(`${baseUrl}/channels`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(rooms.rooms);
  });

  it("POST /channels/:documentId/bind rejects a room the account is not a member of", async () => {
    const response = await fetch(`${baseUrl}/channels/doc-1/bind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channelId: "!unknown:example.org",
        creator: "alice",
        profile: "yjs-paragraphs/1",
      }),
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("!unknown:example.org");
    expect(() => readFileSync(bindStorePath)).toThrow();
  });

  it("POST /channels/:documentId/bind writes a bind-store record for a room the account has joined", async () => {
    rooms.joinedRoomIds.add("!plain:example.org");
    const response = await fetch(`${baseUrl}/channels/doc-1/bind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channelId: "!plain:example.org",
        creator: "alice",
        profile: "yjs-paragraphs/1",
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { documentId: string; roomId: string };
    expect(body.documentId).toBe("doc-1");
    expect(body.roomId).toBe("!plain:example.org");

    const stored = JSON.parse(readFileSync(bindStorePath, "utf8")) as BindStoreData;
    expect(stored["doc-1"]).toMatchObject({
      roomId: "!plain:example.org",
      creatorMemberId: "alice",
      profile: "yjs-paragraphs/1",
    });
    // Nothing about permissions or lifecycle is stored.
    expect(stored["doc-1"]).not.toHaveProperty("archived");
    expect(stored["doc-1"]).not.toHaveProperty("permissions");
  });

  it("POST /channels/:documentId/bind persists a room the bridge has seen encrypted as encrypted, whatever its state says now (MTX-5)", async () => {
    rooms.joinedRoomIds.add("!plain:example.org");
    sync.seenEncrypted.add("!plain:example.org");
    const response = await fetch(`${baseUrl}/channels/doc-1/bind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channelId: "!plain:example.org",
        creator: "alice",
        profile: "yjs-paragraphs/1",
      }),
    });
    expect(response.status).toBe(200);
    const stored = JSON.parse(readFileSync(bindStorePath, "utf8")) as BindStoreData;
    expect(stored["doc-1"]?.encrypted).toBe(true);
  });

  it("POST /channels/:documentId/send sends encrypted into a room seen encrypted since it was bound as plain (MTX-5)", async () => {
    rooms.joinedRoomIds.add("!plain:example.org");
    await fetch(`${baseUrl}/channels/doc-1/bind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channelId: "!plain:example.org",
        creator: "alice",
        profile: "yjs-paragraphs/1",
      }),
    });
    const send = () =>
      fetch(`${baseUrl}/channels/doc-1/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sender: "alice", payload: "hello" }),
      });
    expect((await send()).status).toBe(200);
    sync.seenEncrypted.add("!plain:example.org");
    expect((await send()).status).toBe(200);
    expect(writer.encryptedSends).toEqual([false, true]);
  });

  it("POST /channels/:documentId/bind rejects a missing channelId with a clear 400", async () => {
    const response = await fetch(`${baseUrl}/channels/doc-1/bind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ creator: "alice", profile: "yjs-paragraphs/1" }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("channelId");
  });

  it("POST /channels/:documentId/send rejects sending to an unbound document", async () => {
    const response = await fetch(`${baseUrl}/channels/doc-unbound/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sender: "alice", payload: "hello" }),
    });
    expect(response.status).toBe(404);
  });

  it("POST /channels/:documentId/send writes to the bound room and returns a deliveryId", async () => {
    rooms.joinedRoomIds.add("!plain:example.org");
    await fetch(`${baseUrl}/channels/doc-1/bind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channelId: "!plain:example.org",
        creator: "alice",
        profile: "yjs-paragraphs/1",
      }),
    });

    const response = await fetch(`${baseUrl}/channels/doc-1/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sender: "alice", payload: "hello" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { deliveryId: string };
    expect(body.deliveryId).toBe("$fake-edit-1");
    expect(writer.sentEdits).toHaveLength(1);
    expect(writer.sentEdits[0]?.roomId).toBe("!plain:example.org");
    expect(writer.sentEdits[0]?.documentId).toBe("doc-1");
  });

  it("GET /transport-profile serves the local profile for a homeserver on this machine", async () => {
    const response = await fetch(`${baseUrl}/transport-profile`);
    expect(response.status).toBe(200);
    const profile = parseTransportProfile(await response.json());
    // The engine's own defaults: no throttling locally.
    expect(profile?.pacing).toEqual({
      minIntervalMs: 0,
      maxIntervalMs: null,
      minChars: 0,
      maxChars: null,
      expectedLatencyMs: 0,
    });
    expect(profile?.bounds.minIntervalMs).toBeNull();
  });

  it("GET /transport-profile serves the throttling profile for a real homeserver", async () => {
    const remote = createServer({
      homeserverUrl: "https://matrix.example.org",
      accessToken: "fake-token",
      rooms,
      writer,
      sync,
      bindStorePath,
    });
    await new Promise<void>((resolve) => remote.listen(0, resolve));
    try {
      const { port } = remote.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/transport-profile`);
      const profile = parseTransportProfile(await response.json());
      expect(profile?.pacing.minIntervalMs).toBe(1000);
      expect(profile?.bounds.minIntervalMs).toBe(250);
      expect(profile?.bounds.maxBytes).toBe(4 * 1024 * 1024);
    } finally {
      await new Promise<void>((resolve, reject) =>
        remote.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("every profile this bridge can serve is a valid TransportProfile, so a typo cannot ship", () => {
    for (const profile of [MATRIX_HOMESERVER_PROFILE, MATRIX_LOCAL_PROFILE]) {
      expect(parseTransportProfile(JSON.parse(JSON.stringify(profile)))).toEqual(profile);
    }
  });

  it("POST /channels/:documentId/send says why a send failed, by status, and passes on how long the homeserver asked us to wait", async () => {
    rooms.joinedRoomIds.add("!plain:example.org");
    await fetch(`${baseUrl}/channels/doc-1/bind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channelId: "!plain:example.org",
        creator: "alice",
        profile: "yjs-paragraphs/1",
      }),
    });
    const sendFailingWith = async (failure: unknown) => {
      writer.sendEdit = async () => {
        throw failure;
      };
      return fetch(`${baseUrl}/channels/doc-1/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sender: "alice", payload: "hello" }),
      });
    };

    const limited = await sendFailingWith(
      new MatrixApiError(
        429,
        'send x into !r failed: 429 {"errcode":"M_LIMIT_EXCEEDED","retry_after_ms":4000}',
      ),
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("4");

    expect((await sendFailingWith(new MatrixApiError(413, "too large"))).status).toBe(413);
    expect((await sendFailingWith(new MatrixApiError(500, "oops"))).status).toBe(502);
    expect((await sendFailingWith(new Error("socket hang up"))).status).toBe(502);
  });

  it("POST /channels/:documentId/send answers 409, needs-person, for a refusal only a person can lift (BRG-8, TRN-11)", async () => {
    rooms.joinedRoomIds.add("!plain:example.org");
    await fetch(`${baseUrl}/channels/doc-1/bind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channelId: "!plain:example.org",
        creator: "alice",
        profile: "yjs-paragraphs/1",
      }),
    });
    const sendRefusedWith = async (status: number, errcode: string) => {
      writer.sendEdit = async () => {
        throw new MatrixApiError(
          status,
          `send x into !r failed: ${status} {"errcode":"${errcode}"}`,
        );
      };
      const response = await fetch(`${baseUrl}/channels/doc-1/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sender: "alice", payload: "hello" }),
      });
      const body = await response.text();
      return { status: response.status, reason: reasonOf(response.status, body) };
    };

    // A signed-out account, and a homeserver that waits for the user's consent.
    expect(await sendRefusedWith(401, "M_UNKNOWN_TOKEN")).toEqual({
      status: 409,
      reason: "needs-person",
    });
    expect(await sendRefusedWith(403, "M_CONSENT_NOT_GIVEN")).toEqual({
      status: 409,
      reason: "needs-person",
    });
    // A room that forbids this account stays a refusal for good.
    expect(await sendRefusedWith(403, "M_FORBIDDEN")).toEqual({ status: 403, reason: "rejected" });
  });

  it("a signed-out account reads as needs-person on a send even before the send, when the bridge asks who it is", async () => {
    rooms.joinedRoomIds.add("!plain:example.org");
    await fetch(`${baseUrl}/channels/doc-1/bind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channelId: "!plain:example.org",
        creator: "alice",
        profile: "yjs-paragraphs/1",
      }),
    });
    const signedOut = new MatrixApiError(
      401,
      'whoami failed: 401 {"errcode":"M_UNKNOWN_TOKEN","error":"Invalid access token passed.","soft_logout":false}',
    );
    rooms.whoami = async () => {
      throw signedOut;
    };
    rooms.listJoinedRoomSummaries = async () => {
      throw signedOut;
    };

    const send = await fetch(`${baseUrl}/channels/doc-1/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sender: "alice", payload: "hello" }),
    });
    expect(reasonOf(send.status, await send.text())).toBe("needs-person");
    expect(send.status).toBe(409);
    expect(writer.sentEdits).toHaveLength(0);
    // Every other route says so too, rather than a failure the person cannot act on.
    expect((await fetch(`${baseUrl}/whoami`)).status).toBe(409);
    expect((await fetch(`${baseUrl}/channels`)).status).toBe(409);
  });

  it("GET /channels/:documentId/deliveries polls once and returns the buffered deliveries", async () => {
    sync.deliveries.set("doc-1", [
      { id: "$1", documentId: "doc-1", sender: "alice", payload: "hi" },
    ]);
    const response = await fetch(`${baseUrl}/channels/doc-1/deliveries`);
    expect(response.status).toBe(200);
    expect(sync.pollCount).toBe(1);
    const body = (await response.json()) as { id: string; sender: string; payload: string }[];
    expect(body).toHaveLength(1);
    expect(body[0]?.sender).toBe("alice");
    expect(body[0]?.payload).toBe("hi"); // the frame's text, not Base64
  });

  it("POST /channels/:documentId/resync-request and GET .../resync-requests no longer exist", async () => {
    rooms.joinedRoomIds.add("!plain:example.org");
    await fetch(`${baseUrl}/channels/doc-1/bind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channelId: "!plain:example.org",
        creator: "alice",
        profile: "yjs-paragraphs/1",
      }),
    });

    const postResponse = await fetch(`${baseUrl}/channels/doc-1/resync-request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requester: "bob", requesterState: btoa("") }),
    });
    expect(postResponse.status).toBe(404);
    const getResponse = await fetch(`${baseUrl}/channels/doc-1/resync-requests`);
    expect(getResponse.status).toBe(404);
  });

  it("POST /channels/:documentId/invite rejects a non-creator actor", async () => {
    rooms.joinedRoomIds.add("!plain:example.org");
    await fetch(`${baseUrl}/channels/doc-1/bind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channelId: "!plain:example.org",
        creator: "alice",
        profile: "yjs-paragraphs/1",
      }),
    });

    const response = await fetch(`${baseUrl}/channels/doc-1/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: "bob", text: "join my document!" }),
    });
    expect(response.status).toBe(403);
    expect(writer.sentInviteMessages).toHaveLength(0);
  });

  it("POST /channels/:documentId/invite sends a plain, human-readable message into the bound room", async () => {
    rooms.joinedRoomIds.add("!plain:example.org");
    await fetch(`${baseUrl}/channels/doc-1/bind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channelId: "!plain:example.org",
        creator: "alice",
        profile: "yjs-paragraphs/1",
      }),
    });

    const response = await fetch(`${baseUrl}/channels/doc-1/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: "alice",
        text: "alice invited you to collaborate: https://example.org/join?documentId=doc-1",
      }),
    });
    expect(response.status).toBe(200);
    expect(writer.sentInviteMessages).toEqual([
      {
        roomId: "!plain:example.org",
        text: "alice invited you to collaborate: https://example.org/join?documentId=doc-1",
      },
    ]);
  });

  it("POST /channels/:documentId/send checks no permission, and sends only as its own account (BRG-16)", async () => {
    rooms.joinedRoomIds.add("!plain:example.org");
    await fetch(`${baseUrl}/channels/doc-1/bind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channelId: "!plain:example.org",
        creator: "alice",
        profile: "yjs-paragraphs/1",
      }),
    });
    const response = await fetch(`${baseUrl}/channels/doc-1/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sender: "alice", payload: "an edit" }),
    });
    expect(response.status).toBe(200);
    expect(writer.sentEdits).toHaveLength(1);

    // It sends only as its own account: a request naming anyone else is refused (BRG-16).
    const other = await fetch(`${baseUrl}/channels/doc-1/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sender: "bob", payload: "an edit" }),
    });
    expect(other.status).toBe(403);
    expect(writer.sentEdits).toHaveLength(1);
  });

  it("has no membership, archive or delete routes: they are control frames in the payload", async () => {
    for (const route of ["membership", "archive", "delete"]) {
      const response = await fetch(`${baseUrl}/channels/doc-1/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor: "alice", member: "bob", permission: "read" }),
      });
      expect(response.status, route).toBe(404);
    }
  });

  it("an unknown route gets a 404 with a clear error, not a silent fallback", async () => {
    const response = await fetch(`${baseUrl}/nonexistent`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("GET /nonexistent");
  });
});

describe("matrix-bridge with no account provisioned (BRG-1)", () => {
  let server: Server;
  let baseUrl: string;
  let bindStoreDir: string;
  let touched: string[];

  beforeEach(async () => {
    // Stand-ins that record being reached: an unprovisioned bridge must refuse before any.
    touched = [];
    const reached = (name: string) => (): Promise<never> => {
      touched.push(name);
      return Promise.reject(new Error("MATRIX_ACCESS_TOKEN is not configured"));
    };
    bindStoreDir = mkdtempSync(join(tmpdir(), "matrix-bridge-unprovisioned-"));
    server = createServer({
      homeserverUrl: "https://matrix.example.org",
      accessToken: undefined,
      rooms: {
        listJoinedRoomSummaries: reached("listJoinedRoomSummaries"),
        isJoinedMember: reached("isJoinedMember"),
        isEncrypted: reached("isEncrypted"),
        whoami: reached("whoami"),
        joinedMembers: reached("joinedMembers"),
      },
      writer: { sendEdit: reached("sendEdit"), sendInviteMessage: reached("sendInviteMessage") },
      sync: {
        pollOnce: reached("pollOnce"),
        getDeliveries: () => [],
        getIntegrityLog: () => [],
        hasSeenEncrypted: () => false,
      },
      bindStorePath: join(bindStoreDir, "tdsp-channels.json"),
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(bindStoreDir, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("refuses a send as needs-person, 409, whatever the request says", async () => {
    for (const body of [
      { sender: "@alice:example.org", payload: "hello" },
      { sender: "@bob:example.org", payload: "hello" },
      {},
    ]) {
      const response = await post("/channels/doc-1/send", body);
      expect(response.status).toBe(409);
      expect(reasonOf(response.status, await response.text())).toBe("needs-person");
    }
    expect(touched).toEqual([]);
  });

  it("refuses every other document operation with 409 too, so each reads as not provisioned", async () => {
    const answers = await Promise.all([
      fetch(`${baseUrl}/whoami`),
      fetch(`${baseUrl}/channels`),
      fetch(`${baseUrl}/members?channelId=${encodeURIComponent("!r:example.org")}`),
      fetch(`${baseUrl}/channels/doc-1/deliveries`),
      fetch(`${baseUrl}/channels/doc-1/integrity-log`),
      post("/channels/doc-1/bind", {
        channelId: "!r:example.org",
        creator: "@alice:example.org",
        profile: "yjs-paragraphs/1",
      }),
      post("/channels/doc-1/invite", { actor: "@alice:example.org", text: "join" }),
    ]);
    for (const response of answers) {
      expect(response.status, response.url).toBe(409);
      await response.text();
    }
    expect(touched).toEqual([]);
  });

  it("serves no transport profile (503), and still answers /health and unknown routes", async () => {
    const profile = await fetch(`${baseUrl}/transport-profile`);
    expect(profile.status).toBe(503);
    await profile.text();

    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ status: "ok", configured: false });

    const unknown = await fetch(`${baseUrl}/nonexistent`);
    expect(unknown.status).toBe(404);
    await unknown.text();
  });
});
