import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Delivery, parseTransportProfile } from "@tdsp/messenger-port";
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
}

// `encrypted` is accepted (MatrixRoomWriter's real interface) but
// unused here — this file's own tests only care about plaintext
// request/response shaping; the real encrypt/decrypt path is covered
// live by crypto.security.test.ts, gated on hasTestMatrixHomeserver(), same
// fast-fake/real-integration split every other route already has.
class FakeMatrixRoomWriter implements MatrixRoomWriter {
  sentEdits: { roomId: string; documentId: string; payload: string }[] = [];
  #nextId = 0;

  async sendEdit(roomId: string, documentId: string, payload: string): Promise<string> {
    this.sentEdits.push({ roomId, documentId, payload });
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
    });
  });

  it("GET /whoami returns the bridge account's own id", async () => {
    const response = await fetch(`${baseUrl}/whoami`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: rooms.userId });
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
    expect(profile?.defaultProfile).toBe("local");
    // The engine's own defaults: no throttling locally.
    expect(profile?.profiles.find((p) => p.id === "local")?.values).toEqual({
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
      expect(profile?.defaultProfile).toBe("standard");
      expect(profile?.profiles.find((p) => p.id === "standard")?.values.minIntervalMs).toBe(1000);
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
