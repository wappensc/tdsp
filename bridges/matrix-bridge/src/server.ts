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
import { isLoopbackOrigin, isLoopbackUrl } from "@tdsp/loopback";
import type { Delivery } from "@tdsp/messenger-port";
import {
  ATTACHMENT_FRAME_LIMIT,
  BODY_FRAME_LIMIT,
  encryptAttachment,
  sha256Hex,
} from "./attachment.ts";
import { type BindRecord, getBindRecord, setBindRecord } from "./bind-store.ts";
import { type CryptoMachine, createCryptoMachine } from "./crypto-machine.ts";
import {
  getJoinedMembers,
  getJoinedRooms,
  getRoomSummary,
  type MatrixApiConfig,
  MatrixApiError,
  sendEvent,
  uploadMedia,
  whoami,
} from "./matrix-api.ts";
import { classifySendFailure } from "./send-failure.ts";
import { createSyncState, type SyncState } from "./sync-state.ts";
import { transportProfileFor } from "./transport-profile.ts";

/**
 * The Matrix bridge's local HTTP interface (SPECIFICATION.md §12.6) — a standalone Node
 * process, never bundled, that owns the account's access token and the Olm/Megolm crypto
 * store so the browser (through `packages/messenger-matrix`) never has to. Plain
 * `node:http` request/response, no framework dependency and no SSE/WebSocket, like
 * `bridges/signal-bridge/src/server.ts`.
 *
 * Routes: `/health`; `GET /channels` and `POST /channels/:documentId/bind` for binding a
 * document to a room; `send`/`receive`; `GET /whoami`, this bridge's own account; and
 * `POST /channels/:documentId/invite` — a plain, human-readable `m.room.message`, not a
 * `de.wappensc.together.tdsp.*` event. Membership, the document's lifecycle and resync
 * requests are frames carried as opaque payloads, not bridge routes (§12.5).
 *
 * Takes its dependencies as a parameter, like `bridges/signal-bridge/src/server.ts`:
 * `MatrixRoomReader`/`MatrixRoomWriter`/`SyncState` let this module's own tests stay fast
 * and CI-safe with fakes, while separate, `hasTestMatrixHomeserver()`-gated integration
 * suites exercise the real implementations against a local Synapse.
 */
/**
 * `id` here is the wire field for the `GET /channels` listing (SPECIFICATION.md §12.6).
 * `matrix-api.ts`'s own `getRoomSummary` calls it `roomId`, the Matrix Client-Server API's
 * vocabulary, not this bridge's wire contract; only the boundary remaps the field.
 */
export interface RoomSummary {
  readonly id: string;
  readonly name: string;
  readonly encrypted: boolean;
}

export interface MatrixRoomReader {
  listJoinedRoomSummaries(): Promise<readonly RoomSummary[]>;
  isJoinedMember(roomId: string): Promise<boolean>;
  /** read-only, checked once at bind time — the room summary already carries this, exposed here separately so `/bind` doesn't have to fetch the room's display name it has no use for. */
  isEncrypted(roomId: string): Promise<boolean>;
  /**
   * This bridge's own account id — an application needs it to know its own `MemberId`
   * before calling `DocumentEngine.create()`/`.join()`: a real adapter's identity is fixed
   * by which bridge and account a page talks to, not typed in. `{ id }`, as every
   * bridge's `/whoami` answers.
   */
  whoami(): Promise<{ id: string }>;
}

/** The real implementation, backed by `matrix-api.ts`'s live `fetch()` calls. */
export function createMatrixRoomReader(config: MatrixApiConfig): MatrixRoomReader {
  return {
    async listJoinedRoomSummaries() {
      const roomIds = await getJoinedRooms(config);
      const summaries = await Promise.all(roomIds.map((roomId) => getRoomSummary(config, roomId)));
      return summaries.map((summary) => ({
        id: summary.roomId,
        name: summary.name,
        encrypted: summary.encrypted,
      }));
    },
    async isJoinedMember(roomId: string) {
      const roomIds = await getJoinedRooms(config);
      return roomIds.includes(roomId);
    },
    async isEncrypted(roomId: string) {
      return (await getRoomSummary(config, roomId)).encrypted;
    },
    async whoami() {
      const { userId } = await whoami(config);
      return { id: userId };
    },
  };
}

export interface MatrixRoomWriter {
  /** Sends `{ tdsp: 1, documentId, frame }` — `frame` the frame's JSON text as a string — as a `de.wappensc.together.tdsp.frame` event; returns the new event id. `encrypted`: whether the bound room already had `m.room.encryption` set — the payload rides transparently inside that encryption if so, never forced. */
  sendEdit(
    roomId: string,
    documentId: string,
    payload: string,
    encrypted: boolean,
  ): Promise<string>;
  /**
   * Sends `text` as a real, human-readable `m.room.message`
   * (`msgtype: m.text`) — deliberately **not** wrapped in the
   * `{ tdsp: 1, ... }` envelope every other `sendXxx` method uses
   * (an invitation is a normal chat message any Matrix client renders,
   * not a `de.wappensc.together.tdsp.*` event only this bridge understands;
   * SPECIFICATION.md §11). `sync-state.ts` needs no change to
   * handle it: its existing "unrecognized event type ⇒ silently
   * ignored" rule already covers it.
   */
  sendInviteMessage(roomId: string, text: string, encrypted: boolean): Promise<string>;
}

/**
 * The real implementation, backed by `matrix-api.ts`'s live `fetch()`
 * calls for plaintext sends, and `crypto-machine.ts`'s `CryptoMachine`
 * for encrypted ones. `ensureRoomKeyShared` is called before
 * *every* encrypted send, not cached across calls: fetching the room's
 * current membership on every send is cheap and always correct, where
 * caching it risks missing a member who joined since the last send
 * (exactly the scenario the history-caveat test in `crypto.security.test.ts`
 * depends on: a newly joined member *does* get included in the next
 * share).
 */
export function createMatrixRoomWriter(
  config: MatrixApiConfig,
  crypto: CryptoMachine,
): MatrixRoomWriter {
  async function send(
    roomId: string,
    eventType: string,
    content: unknown,
    encrypted: boolean,
  ): Promise<string> {
    if (!encrypted) {
      const { eventId } = await sendEvent(config, roomId, eventType, content);
      return eventId;
    }
    const members = await getJoinedMembers(config, roomId);
    await crypto.ensureRoomKeyShared(roomId, members);
    const encryptedContent = await crypto.encryptRoomEvent(roomId, eventType, content);
    const { eventId } = await sendEvent(config, roomId, "m.room.encrypted", encryptedContent);
    return eventId;
  }

  /**
   * A frame too large for an event body goes up as a media file and the event carries a reference
   * to it. In an encrypted room the file is encrypted first, under a fresh key that
   * travels only inside the Megolm-encrypted event, so the homeserver stores ciphertext; in an
   * ordinary room it goes up as it is. `document-protocol` never sees the difference.
   */
  async function attachmentContent(
    documentId: string,
    payload: Uint8Array,
    encrypted: boolean,
  ): Promise<unknown> {
    if (!encrypted) {
      const { contentUri } = await uploadMedia(config, payload);
      return {
        tdsp: 1,
        documentId,
        attachment: { url: contentUri, size: payload.length, sha256: sha256Hex(payload) },
      };
    }
    const sealed = encryptAttachment(payload);
    const { contentUri } = await uploadMedia(config, sealed.ciphertext);
    return {
      tdsp: 1,
      documentId,
      attachment: { size: payload.length, file: { url: contentUri, ...sealed.file } },
    };
  }

  return {
    async sendEdit(roomId, documentId, payload, encrypted) {
      // The limits count the bytes of the frame's UTF-8 text (SPECIFICATION.md §3.5).
      const bytes = new TextEncoder().encode(payload);
      if (bytes.length <= BODY_FRAME_LIMIT) {
        return send(
          roomId,
          "de.wappensc.together.tdsp.frame",
          { tdsp: 1, documentId, frame: payload },
          encrypted,
        );
      }
      if (bytes.length > ATTACHMENT_FRAME_LIMIT) {
        // What this bridge states as its largest message; a client that respects the profile
        // never gets here, and one that does not is told plainly.
        throw new MatrixApiError(
          413,
          `a frame of ${bytes.length} bytes is over the ${ATTACHMENT_FRAME_LIMIT} this bridge carries`,
        );
      }
      return send(
        roomId,
        "de.wappensc.together.tdsp.frame",
        await attachmentContent(documentId, bytes, encrypted),
        encrypted,
      );
    },
    sendInviteMessage(roomId, text, encrypted) {
      return send(roomId, "m.room.message", { msgtype: "m.text", body: text }, encrypted);
    },
  };
}

export interface ServerDependencies {
  readonly homeserverUrl: string;
  readonly accessToken: string | undefined;
  readonly rooms: MatrixRoomReader;
  readonly writer: MatrixRoomWriter;
  readonly sync: SyncState;
  readonly bindStorePath: string;
}

/**
 * Wires `createMatrixRoomReader`/`createCryptoMachine`/
 * `createMatrixRoomWriter`/`createSyncState` together from one
 * `MatrixApiConfig` + bind-store path — what `index.ts` actually calls.
 * The crypto store lives at `<bindStorePath's directory>/crypto/` —
 * alongside, not inside, the bind-store JSON file itself (the SQLite
 * store is a directory of its own files, `OlmMachine`'s to manage, not
 * this module's).
 */
export async function createLiveServerDependencies(
  config: MatrixApiConfig,
  bindStorePath: string,
): Promise<Pick<ServerDependencies, "rooms" | "writer" | "sync"> & { crypto: CryptoMachine }> {
  const cryptoStorePath = `${bindStorePath.replace(/\/[^/]*$/, "")}/crypto`;
  const crypto = await createCryptoMachine(config, cryptoStorePath);
  return {
    rooms: createMatrixRoomReader(config),
    writer: createMatrixRoomWriter(config, crypto),
    sync: createSyncState(config, bindStorePath, crypto),
    crypto,
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
  // The account this bridge sends as, asked of the homeserver once (BRG-16): a send or an
  // invite that names anyone else is refused. Forgotten on failure, so a later request retries.
  let ownId: Promise<string> | undefined;
  const ownIdentity = (): Promise<string> => {
    ownId ??= deps.rooms.whoami().then(
      (identity) => identity.id,
      (error: unknown) => {
        ownId = undefined;
        throw error;
      },
    );
    return ownId;
  };
  return createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    // A browser application is served from a different origin (its own port)
    // than this bridge, so every response needs CORS headers or the browser
    // silently discards them — `fetch()` fails with "Failed to fetch" and no
    // server-side symptom at all (SPECIFICATION.md LBI-3).
    //
    // Not `*`: the bridge has no authentication of its own, which is exactly
    // what makes the origin load-bearing. With `*`, any website the person
    // visits while a bridge runs could `fetch("http://localhost:8788/channels")`
    // from their own browser *and read the response* — enumerating their rooms
    // and reading document deliveries. Binding to loopback does not help: the
    // request originates inside the person's own machine, in their own browser.
    // The origin is the only signal that separates the participant's own
    // application page from an arbitrary site.
    //
    // Reflected rather than hardcoded because an application page is
    // legitimately served from any local port, so a fixed allowlist would break
    // one person running two instances. Non-loopback origins get no CORS header
    // at all, which is what makes the browser withhold the response from them.
    const origin = req.headers.origin;
    if (typeof origin === "string" && isLoopbackOrigin(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type");

    const { method, url = "" } = req;
    if (method === "OPTIONS") {
      // Preflight only — every real POST route here sends
      // `content-type: application/json`, which triggers one.
      res.writeHead(204);
      res.end();
      return;
    }
    const [path, query = ""] = url.split("?", 2);

    if (method === "GET" && path === "/health") {
      sendJson(res, 200, {
        status: "ok",
        homeserverUrl: deps.homeserverUrl,
        configured: deps.accessToken !== undefined,
      });
      return;
    }

    if (method === "GET" && path === "/whoami") {
      deps.rooms
        .whoami()
        .then((identity) => sendJson(res, 200, identity))
        .catch((error: unknown) => {
          sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
        });
      return;
    }

    if (method === "GET" && path === "/transport-profile") {
      // SPECIFICATION.md §3.5: the send policies and hard bounds a client should use with
      // this bridge — a local test homeserver does not throttle, a real one does.
      sendJson(res, 200, transportProfileFor(isLoopbackUrl(deps.homeserverUrl)));
      return;
    }

    if (method === "GET" && path === "/channels") {
      deps.rooms
        .listJoinedRoomSummaries()
        .then((rooms) => sendJson(res, 200, rooms))
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
          const roomId = body.channelId;

          // Read-only validation — never creates a room, never writes into
          // one at bind time.
          const isMember = await deps.rooms.isJoinedMember(roomId);
          if (!isMember) {
            sendJson(res, 404, {
              error: `room ${roomId} does not exist, or this account is not a member of it`,
            });
            return;
          }

          const existing = getBindRecord(deps.bindStorePath, documentId);
          // checked once, read-only, never set by this call.
          const encrypted = existing?.encrypted ?? (await deps.rooms.isEncrypted(roomId));
          const record: BindRecord = {
            roomId,
            creatorMemberId: body.creator,
            profile: body.profile,
            createdAt: existing?.createdAt ?? new Date().toISOString(),
            encrypted,
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
          const self = await ownIdentity();
          if (body.sender !== self) {
            sendJson(res, 403, { error: `this bridge sends as ${self}, not as ${body.sender}` });
            return;
          }
          const bound = getBindRecord(deps.bindStorePath, documentId);
          if (!bound) {
            sendJson(res, 404, { error: `${documentId} is not bound to a room yet` });
            return;
          }
          const deliveryId = await deps.writer.sendEdit(
            bound.roomId,
            documentId,
            body.payload,
            bound.encrypted,
          );
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

    // SPECIFICATION.md BRG-15, like bridges/email-bridge's own /integrity-log
    // route: polls first (a violation only exists once the event that
    // caused it has been fetched and judged), diagnostic, not part of
    // MessengerPort.
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

    // No resync-request route: a resync request is an ordinary send()/receive()
    // frame, like a resync response.

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
            sendJson(res, 404, { error: `${documentId} is not bound to a room yet` });
            return;
          }
          // Only the creator sends the invitation (INV-2), and only through its
          // own bridge (BRG-16) — enforced here, not only assumed from the
          // application.
          if (body.actor !== bound.creatorMemberId || body.actor !== (await ownIdentity())) {
            sendJson(res, 403, {
              error: `${body.actor} is not ${documentId}'s creator (${bound.creatorMemberId}) — cannot send an invite`,
            });
            return;
          }
          const eventId = await deps.writer.sendInviteMessage(
            bound.roomId,
            body.text,
            bound.encrypted,
          );
          sendJson(res, 200, { deliveryId: eventId });
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
