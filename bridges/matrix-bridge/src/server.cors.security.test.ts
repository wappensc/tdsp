import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Delivery } from "@tdsp/messenger-port";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createServer,
  type MatrixRoomReader,
  type MatrixRoomWriter,
  type RoomSummary,
  type ServerDependencies,
} from "./server.ts";
import type { IntegrityEntry, SyncState } from "./sync-state.ts";

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

/**
 * Which web pages may read the bridge's answers (SPECIFICATION.md LBI-3): only a page served
 * from this machine. Security tests: only the CI role may change this file
 * (.github/CODEOWNERS, CONTRIBUTING.md).
 */
describe("matrix-bridge HTTP API: cross-origin reads", () => {
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

  it("reflects a loopback Origin, and OPTIONS gets a 204 preflight reply", async () => {
    const getResponse = await fetch(`${baseUrl}/health`, {
      headers: { origin: "http://localhost:5173" },
    });
    expect(getResponse.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(getResponse.headers.get("vary")).toBe("Origin");

    const preflight = await fetch(`${baseUrl}/channels/doc-1/send`, {
      method: "OPTIONS",
      headers: { origin: "http://127.0.0.1:4002" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:4002");
    expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
  });

  /**
   * The bridge has no authentication (LBI-2), which is exactly what makes
   * the Origin load-bearing — with `*`, any site a person visits while a
   * bridge runs could read their room list out of their own browser. Loopback binding does not help;
   * the request comes from inside the machine.
   */
  it("sends no CORS header at all to a non-loopback Origin", async () => {
    for (const origin of [
      "https://evil.tld",
      "http://localhost.evil.tld",
      "http://192.168.1.10:5173",
      "null",
    ]) {
      const response = await fetch(`${baseUrl}/channels`, { headers: { origin } });
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("still answers a request with no Origin at all (curl, a Node client)", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
