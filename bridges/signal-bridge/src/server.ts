/**
 * network-policy: loopback-listener — Zone B (docs/network-policy.md). Inbound only,
 * bound to 127.0.0.1, CORS reflected only for loopback origins.
 */
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { isLoopbackOrigin } from "@tdsp/loopback";
import type { Delivery } from "@tdsp/messenger-port";
import {
  ATTACHMENT_FRAME_LIMIT,
  BODY_FRAME_LIMIT,
  dataUriFor,
  FrameTooLargeError,
  refFor,
} from "./attachment.ts";
import type { AuthStatus } from "./auth.ts";
import { type BindRecord, getBindRecord, setBindRecord } from "./bind-store.ts";
import { classifySendFailure } from "./send-failure.ts";
import { listGroups as listGroupsApi, type SignalRpc, sendGroupMessage } from "./signal-api.ts";
import { createSyncState, type SyncState } from "./sync-state.ts";
import { SIGNAL_PROFILE } from "./transport-profile.ts";

/**
 * The bridge's local HTTP interface (SPECIFICATION.md §12.6) — a standalone Node process,
 * never bundled, that owns `signal-cli` and its credentials so the browser (through
 * `packages/messenger-signal`) never has to. Plain `node:http` request/response, no
 * framework dependency and no SSE/WebSocket: `DocumentEngine.sync()` drives everything
 * from a fixed-interval poll, so a simple request/response interface is enough.
 *
 * Routes: `/health`, `/auth/link` and `/auth/status` for linking the account, and the
 * transport mapping proper — `GET /channels`, `POST /channels/:documentId/bind`,
 * `send`/`receive`. Membership, the document's lifecycle and resync requests are **not**
 * bridge concerns: they are frames, carried here as opaque payloads like any other
 * (SPECIFICATION.md §12.5). Shaped like `bridges/matrix-bridge/src/server.ts` as far as
 * the two messengers' real differences allow (no crypto layer, no room-encryption flag,
 * a push- rather than poll-driven `SyncState`).
 *
 * Takes its dependencies as parameters — `GroupReader`/`GroupWriter`/`SyncState`
 * alongside `AuthStatusSource` — so this module's own tests need no real `signal-cli`
 * process, let alone a linked account: every route is tested at L0 (docs/testing.md)
 * with a fake standing in for `signal-cli`. There is no L2 for Signal (no local server
 * exists); the next level up is L4, against production Signal through two real linked
 * accounts (`l4-contract.test.ts`, `l4-attachments.test.ts`).
 */
export interface AuthStatusSource {
  readonly status: AuthStatus;
  /** `signal-cli`'s own local multi-account selector (E.164 phone number) — never the `MemberId`/`status.accountId` (UUID); see `auth.ts`'s own doc comment for why the two must stay separate. */
  readonly phoneNumber: string | undefined;
  link(): Promise<{ linkingUri: string }>;
}

/**
 * `id` here is the wire field for the `GET /channels` listing (SPECIFICATION.md §12.6).
 * `signal-api.ts`'s own `GroupSummary` calls it `groupId` internally — the bridge's
 * `signal-cli`-facing vocabulary, not the wire contract; only the boundary remaps it.
 */
export interface GroupSummary {
  readonly id: string;
  readonly name: string;
}

export interface GroupReader {
  listGroups(): Promise<readonly GroupSummary[]>;
  isMember(groupId: string): Promise<boolean>;
}

/** `signal-cli`'s own local account selector — never the `MemberId` (see `auth.ts`). */
function requirePhoneNumber(auth: AuthStatusSource): string {
  const { phoneNumber } = auth;
  if (!phoneNumber) {
    throw new Error("not linked yet — no Signal phone number available");
  }
  return phoneNumber;
}

/** This bridge's own `MemberId` (the account's UUID) — never passed to `signal-cli` itself (its `account` param rejects a UUID). */
function requireAccountId(auth: AuthStatusSource): string {
  const { accountId } = auth.status;
  if (!accountId) {
    throw new Error("not linked yet — no Signal account id available");
  }
  return accountId;
}

/** The real implementation, backed by `signal-api.ts`'s live JSON-RPC calls. */
export function createGroupReader(rpc: SignalRpc, auth: AuthStatusSource): GroupReader {
  return {
    async listGroups() {
      const groups = await listGroupsApi(rpc, requirePhoneNumber(auth));
      return groups.map((group) => ({ id: group.groupId, name: group.name }));
    },
    async isMember(groupId: string) {
      const groups = await listGroupsApi(rpc, requirePhoneNumber(auth));
      return groups.some((group) => group.groupId === groupId);
    },
  };
}

export interface GroupWriter {
  /**
   * Sends `{tdsp:1, kind:"frame", documentId, frame}` — `frame` the frame's JSON text as a
   * string — as a group text message:
   * the envelope's one kind, `"frame"` (SPECIFICATION.md §13.1),
   * as in `bridges/email-bridge`. Returns the new `DeliveryId`. A payload
   * over `BODY_FRAME_LIMIT` goes as an attachment instead, and the
   * envelope carries `attachment:{size, sha256}` in place of `frame`
   *.
   */
  sendEdit(groupId: string, documentId: string, payload: string): Promise<string>;
  /**
   * Sends an invitation (SPECIFICATION.md §11): `text` as an ordinary group
   * text message — deliberately **not** wrapped in the `{tdsp:1,...}`
   * envelope every other `sendXxx` method uses, mirroring
   * `MatrixMessengerPort.sendInviteMessage`'s own `m.room.message`
   * exactly. `sync-state.ts`'s `parseEnvelope` already silently ignores
   * anything that isn't valid `{tdsp:1,...}` JSON (its own "an ordinary
   * human chat message... not our own envelope" case), so this needs no
   * receive-side change at all.
   */
  sendInviteMessage(groupId: string, text: string): Promise<string>;
}

/** The real implementation, backed by `signal-api.ts`'s live `send` JSON-RPC call. */
export function createGroupWriter(rpc: SignalRpc, auth: AuthStatusSource): GroupWriter {
  async function sendEnvelope(
    groupId: string,
    envelope: Record<string, unknown>,
    attachments?: readonly string[],
  ): Promise<string> {
    const { timestamp } = await sendGroupMessage(
      rpc,
      requirePhoneNumber(auth),
      groupId,
      JSON.stringify(envelope),
      attachments,
    );
    return `${requireAccountId(auth)}:${timestamp}`;
  }

  return {
    sendEdit(groupId, documentId, payload) {
      // The limits count the bytes of the frame's UTF-8 text (SPECIFICATION.md §3.5).
      const bytes = new TextEncoder().encode(payload);
      if (bytes.length <= BODY_FRAME_LIMIT) {
        return sendEnvelope(groupId, { tdsp: 1, kind: "frame", documentId, frame: payload });
      }
      if (bytes.length > ATTACHMENT_FRAME_LIMIT) {
        // What this bridge states as its largest message; a client that respects the profile
        // never gets here, and one that does not is told plainly (a 413, see send-failure.ts).
        return Promise.reject(new FrameTooLargeError(bytes.length));
      }
      // Too large for the body: the frame goes as an attachment, and the body is the envelope
      // that names it, with the size and SHA-256 the receiver will check.
      return sendEnvelope(
        groupId,
        { tdsp: 1, kind: "frame", documentId, attachment: refFor(bytes) },
        [dataUriFor(bytes)],
      );
    },
    async sendInviteMessage(groupId, text) {
      const { timestamp } = await sendGroupMessage(rpc, requirePhoneNumber(auth), groupId, text);
      return `${requireAccountId(auth)}:${timestamp}`;
    },
  };
}

export interface ServerDependencies {
  readonly auth: AuthStatusSource;
  readonly groups: GroupReader;
  readonly writer: GroupWriter;
  readonly sync: SyncState;
  readonly bindStorePath: string;
}

/**
 * Wires `createGroupReader`/`createGroupWriter`/`createSyncState` together from one `SignalRpc` + auth +
 * bind-store path — what `index.ts` actually calls. `attachmentsDir` is `signal-cli`'s own
 * `attachments` directory, where a received attachment is written and from where this bridge deletes
 * it after reading.
 */
export function createLiveServerDependencies(
  rpc: SignalRpc,
  auth: AuthStatusSource,
  bindStorePath: string,
  attachmentsDir?: string,
): Pick<ServerDependencies, "groups" | "writer" | "sync"> {
  return {
    groups: createGroupReader(rpc, auth),
    writer: createGroupWriter(rpc, auth),
    sync: createSyncState(rpc, bindStorePath, {
      account: () => auth.phoneNumber,
      attachmentsDir,
    }),
  };
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

/** Answers a failed send with the status that says what kind of failure it was. */
function sendSendFailure(res: ServerResponse, error: unknown): void {
  const failure = classifySendFailure(error);
  sendJson(
    res,
    failure.status,
    { error: error instanceof Error ? error.message : String(error) },
    failure.retryAfterSeconds === undefined
      ? {}
      : { "Retry-After": String(failure.retryAfterSeconds) },
  );
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function deliveryToJson(delivery: Delivery): unknown {
  return delivery; // the payload is the frame's text, carried as a JSON string
}

interface BindRequestBody {
  // channelId, as in every bridge's bind body (SPECIFICATION.md §12.6).
  channelId?: unknown;
  creator?: unknown;
  profile?: unknown;
}

interface SendRequestBody {
  sender?: unknown;
  payload?: unknown;
}

interface InviteRequestBody {
  actor?: unknown;
  text?: unknown;
}

export function createServer(deps: ServerDependencies): Server {
  return createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    if (typeof origin === "string" && isLoopbackOrigin(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type");

    const { method, url = "" } = req;
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const [path, query = ""] = url.split("?", 2);

    if (method === "GET" && path === "/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    if (method === "GET" && path === "/auth/status") {
      sendJson(res, 200, deps.auth.status);
      return;
    }

    if (method === "POST" && path === "/auth/link") {
      deps.auth
        .link()
        .then((result) => sendJson(res, 200, result))
        .catch((error: unknown) => {
          sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
        });
      return;
    }

    if (method === "GET" && path === "/whoami") {
      const { accountId } = deps.auth.status;
      if (!accountId) {
        sendJson(res, 409, { error: "not linked yet — no Signal account id available" });
        return;
      }
      // {id}, as every bridge's /whoami answers (SPECIFICATION.md §12.6).
      sendJson(res, 200, { id: accountId });
      return;
    }

    if (method === "GET" && path === "/transport-profile") {
      // The send policies and hard bounds a client should use with this bridge
      // (SPECIFICATION.md §3.5).
      sendJson(res, 200, SIGNAL_PROFILE);
      return;
    }

    if (method === "GET" && path === "/channels") {
      deps.groups
        .listGroups()
        .then((groups) => sendJson(res, 200, groups))
        .catch((error: unknown) => {
          sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
        });
      return;
    }

    const bindMatch = method === "POST" ? /^\/channels\/([^/]+)\/bind$/.exec(path ?? "") : null;
    if (bindMatch) {
      const documentId = decodeURIComponent(bindMatch[1] as string);
      readJsonBody(req)
        .then(async (rawBody) => {
          const body = rawBody as BindRequestBody;
          if (typeof body.channelId !== "string" || body.channelId.length === 0) {
            sendJson(res, 400, { error: "channelId must be a non-empty string" });
            return;
          }
          if (typeof body.creator !== "string" || body.creator.length === 0) {
            sendJson(res, 400, { error: "creator must be a non-empty string" });
            return;
          }
          if (!isProfileText(body.profile)) {
            sendJson(res, 400, {
              error: "profile must be a document profile id such as yjs-paragraphs/1",
            });
            return;
          }
          const groupId = body.channelId;

          // Read-only validation: binding never creates a group, never
          // changes an existing one's membership, and never joins one.
          const isMember = await deps.groups.isMember(groupId);
          if (!isMember) {
            sendJson(res, 404, {
              error: `group ${groupId} does not exist, or this account is not a member of it`,
            });
            return;
          }

          const existing = getBindRecord(deps.bindStorePath, documentId);
          const record: BindRecord = {
            groupId,
            creatorMemberId: body.creator,
            profile: body.profile,
            createdAt: existing?.createdAt ?? new Date().toISOString(),
          };
          setBindRecord(deps.bindStorePath, documentId, record);
          sendJson(res, 200, { documentId, ...record });
        })
        .catch((error: unknown) => {
          sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
        });
      return;
    }

    const sendMatch = method === "POST" ? /^\/channels\/([^/]+)\/send$/.exec(path ?? "") : null;
    if (sendMatch) {
      const documentId = decodeURIComponent(sendMatch[1] as string);
      readJsonBody(req)
        .then(async (rawBody) => {
          const body = rawBody as SendRequestBody;
          if (typeof body.sender !== "string" || body.sender.length === 0) {
            sendJson(res, 400, { error: "sender must be a non-empty string" });
            return;
          }
          if (typeof body.payload !== "string") {
            sendJson(res, 400, { error: "payload must be the frame's text" });
            return;
          }
          // The message goes out as this bridge's own account, whatever the request says; a
          // sender that is not that account is refused rather than ignored (BRG-16).
          if (body.sender !== deps.auth.status.accountId) {
            sendJson(res, 403, {
              error: `this bridge sends as ${deps.auth.status.accountId ?? "no linked account"}, not as ${body.sender}`,
            });
            return;
          }
          const bound = getBindRecord(deps.bindStorePath, documentId);
          if (!bound) {
            sendJson(res, 404, { error: `${documentId} is not bound to a group yet` });
            return;
          }
          const deliveryId = await deps.writer.sendEdit(bound.groupId, documentId, body.payload);
          sendJson(res, 200, { deliveryId });
        })
        .catch((error: unknown) => sendSendFailure(res, error));
      return;
    }

    if (method === "GET" && path?.startsWith("/channels/") && path.endsWith("/deliveries")) {
      const documentId = decodeURIComponent(path.slice("/channels/".length, -"/deliveries".length));
      deps.sync
        .pollOnce()
        .then(() => sendJson(res, 200, deps.sync.getDeliveries(documentId).map(deliveryToJson)))
        .catch((error: unknown) => {
          sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
        });
      return;
    }

    // SPECIFICATION.md BRG-15, like the email and Matrix bridges' own
    // /integrity-log route. Diagnostic, not part of MessengerPort.
    if (method === "GET" && path?.startsWith("/channels/") && path.endsWith("/integrity-log")) {
      const documentId = decodeURIComponent(
        path.slice("/channels/".length, -"/integrity-log".length),
      );
      deps.sync
        .pollOnce()
        .then(() => sendJson(res, 200, deps.sync.getIntegrityLog(documentId)))
        .catch((error: unknown) => {
          sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
        });
      return;
    }

    const inviteMatch = method === "POST" ? /^\/channels\/([^/]+)\/invite$/.exec(path ?? "") : null;
    if (inviteMatch) {
      const documentId = decodeURIComponent(inviteMatch[1] as string);
      readJsonBody(req)
        .then(async (rawBody) => {
          const body = rawBody as InviteRequestBody;
          if (typeof body.actor !== "string" || body.actor.length === 0) {
            sendJson(res, 400, { error: "actor must be a non-empty string" });
            return;
          }
          if (typeof body.text !== "string" || body.text.length === 0) {
            sendJson(res, 400, { error: "text must be a non-empty string" });
            return;
          }
          const bound = getBindRecord(deps.bindStorePath, documentId);
          if (!bound) {
            sendJson(res, 404, { error: `${documentId} is not bound to a group yet` });
            return;
          }
          // Only the creator sends the invitation (INV-2) — and only
          // through its own bridge, which sends as its own account (BRG-16).
          if (body.actor !== bound.creatorMemberId || body.actor !== deps.auth.status.accountId) {
            sendJson(res, 403, {
              error: `${body.actor} is not ${documentId}'s creator (${bound.creatorMemberId}) — cannot send an invite`,
            });
            return;
          }
          const deliveryId = await deps.writer.sendInviteMessage(bound.groupId, body.text);
          sendJson(res, 200, { deliveryId });
        })
        .catch((error: unknown) => {
          sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
        });
      return;
    }

    sendJson(res, 404, { error: `no such route: ${method} ${path}${query ? `?${query}` : ""}` });
  });
}

/**
 * Whether `value` has the shape of a document profile id, `<name>/<major>`
 * (SPECIFICATION.md §5). Only the shape: which profiles exist is the engine's business,
 * and this bridge stores and repeats the id without interpreting it.
 */
export function isProfileText(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9.-]{0,99}\/[1-9][0-9]{0,5}$/.test(value);
}
