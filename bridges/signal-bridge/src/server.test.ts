import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTransportProfile } from "@tdsp/messenger-port";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FrameTooLargeError } from "./attachment.ts";
import type { AuthStatus } from "./auth.ts";
import {
  type AuthStatusSource,
  createServer,
  type GroupReader,
  type GroupSummary,
  type GroupWriter,
} from "./server.ts";
import { SignalRpcError } from "./signal-daemon.ts";
import type { IntegrityEntry, SyncState } from "./sync-state.ts";
import { SIGNAL_PROFILE } from "./transport-profile.ts";

/**
 * Never spawns a real signal-cli — server.ts takes every dependency as a
 * parameter specifically so this file can stay fast and CI-safe (see
 * server.ts's own doc comment). This is L0 (docs/testing.md): unlike
 * `bridges/matrix-bridge`'s equivalent routes (real Synapse, L2), there is no
 * local Signal server to run these against — a fake stands in for
 * `signal-cli` entirely; Signal's only L2 is `signal-daemon.test.ts`'s
 * real-binary, no-account daemon mechanics.
 */
class FakeAuth implements AuthStatusSource {
  status: AuthStatus = { linked: false };
  phoneNumber: string | undefined;
  linkCalls = 0;

  async link(): Promise<{ linkingUri: string }> {
    this.linkCalls++;
    return { linkingUri: "sgnl://linkdevice?uuid=fake&pub_key=fake" };
  }
}

class FakeGroups implements GroupReader {
  groups: GroupSummary[] = [];

  async listGroups(): Promise<readonly GroupSummary[]> {
    return this.groups;
  }

  async isMember(groupId: string): Promise<boolean> {
    return this.groups.some((group) => group.id === groupId);
  }
}

interface SentMessage {
  readonly groupId: string;
  readonly documentId: string;
  readonly envelope: unknown;
}

class FakeWriter implements GroupWriter {
  sent: SentMessage[] = [];
  #nextTimestamp = 1;

  async sendEdit(groupId: string, documentId: string, payload: string): Promise<string> {
    return this.#record(groupId, documentId, { kind: "edit", payload });
  }

  async sendInviteMessage(groupId: string, text: string): Promise<string> {
    return this.#record(groupId, "(invite)", { kind: "invite", text });
  }

  #record(groupId: string, documentId: string, envelope: unknown): string {
    this.sent.push({ groupId, documentId, envelope });
    return `fake-account:${this.#nextTimestamp++}`;
  }
}

class FakeSync implements SyncState {
  deliveries = new Map<
    string,
    { id: string; documentId: string; sender: string; payload: string }[]
  >();
  integrityLog = new Map<string, IntegrityEntry[]>();
  pollCalls = 0;

  async pollOnce(): Promise<void> {
    this.pollCalls++;
  }

  getDeliveries(documentId: string) {
    return this.deliveries.get(documentId) ?? [];
  }

  getIntegrityLog(documentId: string) {
    return this.integrityLog.get(documentId) ?? [];
  }
}

describe("signal-bridge HTTP API", () => {
  let server: Server;
  let baseUrl: string;
  let auth: FakeAuth;
  let groups: FakeGroups;
  let writer: FakeWriter;
  let sync: FakeSync;
  let bindStorePath: string;
  let tempDir: string;

  beforeEach(async () => {
    auth = new FakeAuth();
    groups = new FakeGroups();
    writer = new FakeWriter();
    sync = new FakeSync();
    tempDir = mkdtempSync(join(tmpdir(), "signal-bridge-server-test-"));
    bindStorePath = join(tempDir, "tdsp-channels.json");
    server = createServer({ auth, groups, writer, sync, bindStorePath });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("GET /health reports ok", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("GET /auth/status reflects the auth dependency's current status", async () => {
    const unlinked = await fetch(`${baseUrl}/auth/status`);
    expect(unlinked.status).toBe(200);
    await expect(unlinked.json()).resolves.toEqual({ linked: false });

    auth.status = { linked: true, accountId: "+15551234567" };
    const linked = await fetch(`${baseUrl}/auth/status`);
    await expect(linked.json()).resolves.toEqual({ linked: true, accountId: "+15551234567" });
  });

  it("POST /auth/link delegates to the auth dependency and returns its linking URI", async () => {
    const response = await fetch(`${baseUrl}/auth/link`, { method: "POST" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      linkingUri: "sgnl://linkdevice?uuid=fake&pub_key=fake",
    });
    expect(auth.linkCalls).toBe(1);
  });

  it("GET /whoami reports 409 before linking, the account id after", async () => {
    const before = await fetch(`${baseUrl}/whoami`);
    expect(before.status).toBe(409);

    auth.status = { linked: true, accountId: "+15551234567" };
    const after = await fetch(`${baseUrl}/whoami`);
    expect(after.status).toBe(200);
    await expect(after.json()).resolves.toEqual({ id: "+15551234567" });
  });

  it("GET /channels lists groups from the group reader", async () => {
    groups.groups = [{ id: "g1", name: "Team chat" }];
    const response = await fetch(`${baseUrl}/channels`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([{ id: "g1", name: "Team chat" }]);
  });

  it("POST /channels/:id/bind rejects a group this account is not a member of", async () => {
    const response = await fetch(`${baseUrl}/channels/doc-1/bind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId: "g1", creator: "alice", profile: "yjs-paragraphs/1" }),
    });
    expect(response.status).toBe(404);
  });

  it("POST /channels/:id/bind succeeds for a group this account belongs to, and is idempotent", async () => {
    groups.groups = [{ id: "g1", name: "Team chat" }];
    const response = await fetch(`${baseUrl}/channels/doc-1/bind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId: "g1", creator: "alice", profile: "yjs-paragraphs/1" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { groupId: string; creatorMemberId: string };
    expect(body.groupId).toBe("g1");
    expect(body.creatorMemberId).toBe("alice");

    const second = await fetch(`${baseUrl}/channels/doc-1/bind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId: "g1", creator: "alice", profile: "yjs-paragraphs/1" }),
    });
    expect(second.status).toBe(200);
  });

  async function bindDocument(documentId: string, creator = "alice"): Promise<void> {
    auth.status = { linked: true, accountId: "alice" }; // the account this bridge sends as
    groups.groups = [{ id: "g1", name: "Team chat" }];
    await fetch(`${baseUrl}/channels/${documentId}/bind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId: "g1", creator, profile: "yjs-paragraphs/1" }),
    });
  }

  it("POST /channels/:id/send requires a bound document", async () => {
    auth.status = { linked: true, accountId: "alice" };
    const response = await fetch(`${baseUrl}/channels/doc-1/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sender: "alice", payload: "aGVsbG8=" }),
    });
    expect(response.status).toBe(404);
  });

  it("POST /channels/:id/send delivers through the writer once bound", async () => {
    await bindDocument("doc-1");
    const response = await fetch(`${baseUrl}/channels/doc-1/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sender: "alice", payload: "aGVsbG8=" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { deliveryId: string };
    expect(body.deliveryId).toBeTruthy();
    expect(writer.sent).toHaveLength(1);
    expect(writer.sent[0]?.groupId).toBe("g1");
  });

  it("GET /transport-profile serves the Signal profile", async () => {
    const response = await fetch(`${baseUrl}/transport-profile`);
    expect(response.status).toBe(200);
    const profile = parseTransportProfile(await response.json());
    expect(profile).toEqual(SIGNAL_PROFILE);
    expect(profile?.bounds.maxBytes).toBe(4 * 1024 * 1024);
    expect(profile?.profiles.find((p) => p.id === "standard")?.values.minIntervalMs).toBe(2000);
  });

  it("POST /channels/:id/send says why a send failed, by status", async () => {
    await bindDocument("doc-1");
    const sendFailingWith = async (failure: unknown) => {
      writer.sendEdit = async () => {
        throw failure;
      };
      return fetch(`${baseUrl}/channels/doc-1/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sender: "alice", payload: "aGVsbG8=" }),
      });
    };
    // signal-cli's error code 5 is Signal's rate limit.
    expect((await sendFailingWith(new SignalRpcError("rate limited (code 5)", 5))).status).toBe(
      429,
    );
    expect((await sendFailingWith(new SignalRpcError("other (code 1)", 1))).status).toBe(502);
    expect((await sendFailingWith(new Error("signal-cli daemon socket closed"))).status).toBe(502);
    // A frame over what the bridge carries in one message can never be retried into fitting.
    expect((await sendFailingWith(new FrameTooLargeError(5_000_000))).status).toBe(413);
  });

  it("POST /channels/:id/send sends only as the bridge's own account, and refuses anyone else (BRG-16)", async () => {
    await bindDocument("doc-1");
    const other = await fetch(`${baseUrl}/channels/doc-1/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sender: "bob", payload: "aGVsbG8=" }),
    });
    expect(other.status).toBe(403);
    expect(writer.sent).toHaveLength(0);
  });

  it("POST /channels/:id/send checks no permission — permissions are not a bridge concern", async () => {
    await bindDocument("doc-1", "someone-else-created-it");
    const response = await fetch(`${baseUrl}/channels/doc-1/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sender: "alice", payload: "aGVsbG8=" }),
    });
    expect(response.status).toBe(200);
  });

  it("has no membership, archive or delete routes any more: they are control frames in the payload", async () => {
    await bindDocument("doc-1");
    for (const route of ["membership", "archive", "delete"]) {
      const response = await fetch(`${baseUrl}/channels/doc-1/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor: "alice", member: "bob", permission: "read" }),
      });
      expect(response.status, route).toBe(404);
    }
  });

  it("POST /channels/:id/invite sends a plain-text message, and only the creator may call it", async () => {
    await bindDocument("doc-1");
    const forbidden = await fetch(`${baseUrl}/channels/doc-1/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: "bob", text: "join me" }),
    });
    expect(forbidden.status).toBe(403);

    const invited = await fetch(`${baseUrl}/channels/doc-1/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: "alice",
        text: "alice invited you: https://example.test/?documentId=doc-1",
      }),
    });
    expect(invited.status).toBe(200);
    expect(writer.sent).toHaveLength(1);
    expect(writer.sent[0]).toMatchObject({
      groupId: "g1",
      envelope: {
        kind: "invite",
        text: "alice invited you: https://example.test/?documentId=doc-1",
      },
    });
  });

  it("POST /channels/:id/invite rejects an empty text", async () => {
    await bindDocument("doc-1");
    const response = await fetch(`${baseUrl}/channels/doc-1/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: "alice", text: "" }),
    });
    expect(response.status).toBe(400);
  });

  it("GET /channels/:id/deliveries polls sync and returns the frames' text as payloads", async () => {
    sync.deliveries.set("doc-1", [
      { id: "a:1", documentId: "doc-1", sender: "alice", payload: "AQID" },
    ]);
    const response = await fetch(`${baseUrl}/channels/doc-1/deliveries`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      { id: "a:1", documentId: "doc-1", sender: "alice", payload: "AQID" },
    ]);
    expect(sync.pollCalls).toBe(1);
  });

  it("an unknown route gets a 404 with a clear error, not a silent fallback", async () => {
    const response = await fetch(`${baseUrl}/no-such-route`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("GET /no-such-route");
  });
});
