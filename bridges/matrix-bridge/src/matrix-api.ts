/**
 * network-policy: configured-messenger-endpoint — Zone B (docs/network-policy.md).
 * The one place in the Matrix bridge that reaches a remote host: the Matrix
 * homeserver at MATRIX_HOMESERVER_URL. Matrix has no local daemon to proxy
 * through, unlike signal-cli.
 */
/**
 * Thin `fetch()` wrapper against Matrix's own Client-Server API — plain HTTP
 * calls, never `matrix-js-sdk`. The `@matrix-org/matrix-sdk-crypto-nodejs`
 * `OlmMachine` the crypto callers use (`crypto-machine.ts`) is a sans-IO
 * state machine: it never does networking itself, only tells the caller which
 * requests to issue (`outgoingRequests()`) and accepts the responses back
 * (`markRequestAsSent()`). This module's plain `fetch()` calls are a complete
 * transport for that, so `matrix-js-sdk` (and its bundled WASM crypto) would
 * only add a large, mostly unused dependency.
 *
 * Endpoints and response shapes are verified against a real Synapse, not
 * assumed from documentation.
 */

import { parseMxc } from "./attachment.ts";

export interface MatrixApiConfig {
  readonly homeserverUrl: string;
  readonly accessToken: string;
}

export class MatrixApiError extends Error {
  // Not a TS constructor parameter property (`public readonly status: ...`
  // in the signature): Node's `--experimental-strip-types` — what
  // `bridges/matrix-bridge`'s actual `pnpm run start` uses, unlike this
  // package's own Vitest-run tests, which go through a different
  // transform — only strips type annotations, it does not lower this
  // TS-only shorthand into the real assignment it implies, and throws
  // `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` at module load — which only running
  // `src/index.ts` itself shows, not the tests.
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "MatrixApiError";
    this.status = status;
  }
}

async function get(config: MatrixApiConfig, path: string): Promise<Response> {
  return fetch(`${config.homeserverUrl}${path}`, {
    headers: { authorization: `Bearer ${config.accessToken}` },
  });
}

let txnCounter = 0;

/**
 * `POST /_matrix/media/v3/upload` — stores `bytes` in the homeserver's media repository and
 * returns its `mxc://` URI (for attachments, SPECIFICATION.md §13.3). Still the current upload endpoint under
 * authenticated media; only the *download* moved.
 */
export async function uploadMedia(
  config: MatrixApiConfig,
  bytes: Uint8Array,
  contentType = "application/octet-stream",
): Promise<{ contentUri: string }> {
  const response = await fetch(
    `${config.homeserverUrl}/_matrix/media/v3/upload?filename=tdsp.bin`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${config.accessToken}`, "content-type": contentType },
      // A copy typed as an ArrayBuffer-backed view, which is what `BodyInit` accepts.
      body: new Uint8Array(bytes),
    },
  );
  if (!response.ok) {
    throw new MatrixApiError(
      response.status,
      `upload of ${bytes.length} bytes failed: ${response.status} ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { content_uri?: unknown };
  if (typeof body.content_uri !== "string") {
    throw new MatrixApiError(502, "upload answered without a content_uri");
  }
  return { contentUri: body.content_uri };
}

/**
 * Downloads a media file by its `mxc://` URI from *this* bridge's own homeserver — never from
 * anywhere the URI names, which is only ever split into a server name and a media id and put into a
 * path on the configured endpoint (the homeserver fetches from another server itself if it must).
 * Tries the authenticated client endpoint first (`/_matrix/client/v1/media/download`, spec v1.11), and
 * the older unauthenticated one only if the homeserver does not know the first. At most `maxBytes` are
 * read: what a peer can make this bridge download is bounded.
 */
export async function downloadMedia(
  config: MatrixApiConfig,
  mxcUri: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const parsed = parseMxc(mxcUri);
  if (parsed === undefined) {
    throw new MatrixApiError(400, `not an mxc URI: ${mxcUri.slice(0, 80)}`);
  }
  const target = `${encodeURIComponent(parsed.server)}/${encodeURIComponent(parsed.mediaId)}`;
  const paths = [
    `/_matrix/client/v1/media/download/${target}`,
    `/_matrix/media/v3/download/${target}`,
  ];
  let failure: MatrixApiError | undefined;
  for (const path of paths) {
    const response = await get(config, path);
    if (response.ok) {
      return readAtMost(response, maxBytes);
    }
    failure = new MatrixApiError(
      response.status,
      `download of ${mxcUri} failed: ${response.status} ${await response.text()}`,
    );
    // Only "this homeserver does not have that endpoint" tries the older one; a real refusal stands.
    if (response.status !== 404) {
      break;
    }
  }
  throw failure as MatrixApiError;
}

async function readAtMost(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new MatrixApiError(413, `the file is ${declared} bytes, over the ${maxBytes} allowed`);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return new Uint8Array(await response.arrayBuffer());
  }
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new MatrixApiError(413, `the file is over the ${maxBytes} bytes allowed`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** A client-generated transaction id, unique per access token (Matrix's own idempotency-key requirement for `PUT .../send/...`). */
function nextTxnId(): string {
  txnCounter += 1;
  return `tdsp-${Date.now()}-${txnCounter}`;
}

/**
 * `PUT /_matrix/client/v3/rooms/{roomId}/send/{eventType}/{txnId}` — an
 * ordinary timeline event into an already-existing room — the one kind of
 * write this bridge makes to a room. Returns the new event's own `event_id`,
 * which `send()` uses as the `DeliveryId`.
 */
export async function sendEvent(
  config: MatrixApiConfig,
  roomId: string,
  eventType: string,
  content: unknown,
): Promise<{ eventId: string }> {
  const response = await fetch(
    `${config.homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${eventType}/${nextTxnId()}`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${config.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(content),
    },
  );
  if (!response.ok) {
    throw new MatrixApiError(
      response.status,
      `send ${eventType} into ${roomId} failed: ${response.status} ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { event_id: string };
  return { eventId: body.event_id };
}

export interface RawTimelineEvent {
  readonly type: string;
  readonly event_id: string;
  readonly sender: string;
  readonly content: unknown;
  /** Present, with `redacted_because` set, when this event's own content was already stripped by a redaction by the time this bridge first saw it — verified against a real Synapse: `/sync`'s timeline empties a redacted event's `content` in place, not only a direct `GET .../event/:id`. */
  readonly unsigned?: { readonly redacted_because?: unknown };
}

export interface RawToDeviceEvent {
  readonly type: string;
  readonly sender: string;
  readonly content: unknown;
}

export interface SyncResult {
  readonly nextBatch: string;
  /** Only rooms with at least one new Timeline event this round — matches Matrix's own `/sync` response shape (a room absent from `rooms.join` simply had nothing new). */
  readonly roomEvents: ReadonlyMap<string, readonly RawTimelineEvent[]>;
  /** to-device events (Olm-encrypted room-key shares included) this round — fed to `OlmMachine.receiveSyncChanges` by `crypto-machine.ts`, never interpreted here. */
  readonly toDeviceEvents: readonly RawToDeviceEvent[];
  /** users whose device list changed this round, per Matrix's own `device_lists.changed`/`.left` — same destination as `toDeviceEvents`. */
  readonly deviceListsChanged: readonly string[];
  readonly deviceListsLeft: readonly string[];
  /** this account's own remaining one-time-key counts per algorithm, per Matrix's own `device_one_time_keys_count` — tells the OlmMachine when to upload more. */
  readonly oneTimeKeyCounts: Readonly<Record<string, number>>;
}

/**
 * `GET /_matrix/client/v3/sync?timeout=0&since=...` — one non-blocking
 * sync round — deliberately a plain request/response call made from the
 * engine's own poll, not a second, continuously running long-poll loop
 * like `matrix-js-sdk`'s background sync. Omitting
 * `since` (the very first call from a fresh process) returns Matrix's
 * initial-sync snapshot, which can include substantial room history —
 * callers are expected to treat that first result as establishing a
 * baseline only, not real new deliveries (see `sync-state.ts`'s own doc
 * comment for why, and how this differs from Signal, which has no
 * history to worry about in the first place).
 */
export async function syncOnce(config: MatrixApiConfig, since?: string): Promise<SyncResult> {
  const params = new URLSearchParams({ timeout: "0" });
  if (since !== undefined) {
    params.set("since", since);
  }
  const response = await get(config, `/_matrix/client/v3/sync?${params.toString()}`);
  if (!response.ok) {
    throw new MatrixApiError(
      response.status,
      `sync failed: ${response.status} ${await response.text()}`,
    );
  }
  const body = (await response.json()) as {
    next_batch: string;
    rooms?: { join?: Record<string, { timeline?: { events?: RawTimelineEvent[] } }> };
    to_device?: { events?: RawToDeviceEvent[] };
    device_lists?: { changed?: string[]; left?: string[] };
    device_one_time_keys_count?: Record<string, number>;
  };
  const roomEvents = new Map<string, readonly RawTimelineEvent[]>();
  for (const [roomId, room] of Object.entries(body.rooms?.join ?? {})) {
    if (room.timeline?.events && room.timeline.events.length > 0) {
      roomEvents.set(roomId, room.timeline.events);
    }
  }
  return {
    nextBatch: body.next_batch,
    roomEvents,
    toDeviceEvents: body.to_device?.events ?? [],
    deviceListsChanged: body.device_lists?.changed ?? [],
    deviceListsLeft: body.device_lists?.left ?? [],
    oneTimeKeyCounts: body.device_one_time_keys_count ?? {},
  };
}

/**
 * `GET /_matrix/client/v3/account/whoami` — this account's own Matrix
 * user id and device id (verified: unlike a plain login
 * response, `whoami` still returns `device_id` for an already-existing
 * access token, which `OlmMachine.initialize()` needs).
 */
export async function whoami(
  config: MatrixApiConfig,
): Promise<{ userId: string; deviceId: string }> {
  const response = await get(config, "/_matrix/client/v3/account/whoami");
  if (!response.ok) {
    throw new MatrixApiError(
      response.status,
      `whoami failed: ${response.status} ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { user_id: string; device_id: string };
  return { userId: body.user_id, deviceId: body.device_id };
}

/** `GET /_matrix/client/v3/rooms/{roomId}/joined_members` — every member's user id, needed to know who a Megolm room key must be shared with. */
export async function getJoinedMembers(
  config: MatrixApiConfig,
  roomId: string,
): Promise<readonly string[]> {
  const response = await get(
    config,
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`,
  );
  if (!response.ok) {
    throw new MatrixApiError(
      response.status,
      `joined_members for ${roomId} failed: ${response.status} ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { joined: Record<string, unknown> };
  return Object.keys(body.joined);
}

async function postJson(config: MatrixApiConfig, path: string, rawBody: string): Promise<string> {
  const response = await fetch(`${config.homeserverUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.accessToken}`, "content-type": "application/json" },
    body: rawBody,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new MatrixApiError(response.status, `POST ${path} failed: ${response.status} ${text}`);
  }
  return text;
}

/**
 * The four raw HTTP calls `crypto-machine.ts`'s outgoing-request loop
 * dispatches to, by `RequestType` — every one of them takes and returns
 * an already-JSON-encoded string, matching `@matrix-org/matrix-sdk-crypto-
 * nodejs`'s own `KeysUploadRequest.body`/etc. shape exactly (verified),
 * so this module never needs to parse or construct these
 * bodies itself.
 */
export async function uploadKeys(config: MatrixApiConfig, rawBody: string): Promise<string> {
  return postJson(config, "/_matrix/client/v3/keys/upload", rawBody);
}

export async function queryKeys(config: MatrixApiConfig, rawBody: string): Promise<string> {
  return postJson(config, "/_matrix/client/v3/keys/query", rawBody);
}

export async function claimKeys(config: MatrixApiConfig, rawBody: string): Promise<string> {
  return postJson(config, "/_matrix/client/v3/keys/claim", rawBody);
}

export async function sendToDevice(
  config: MatrixApiConfig,
  eventType: string,
  txnId: string,
  rawBody: string,
): Promise<string> {
  const response = await fetch(
    `${config.homeserverUrl}/_matrix/client/v3/sendToDevice/${eventType}/${txnId}`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${config.accessToken}`,
        "content-type": "application/json",
      },
      body: rawBody,
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new MatrixApiError(
      response.status,
      `sendToDevice ${eventType} failed: ${response.status} ${text}`,
    );
  }
  return text;
}

/** `GET /_matrix/client/v3/joined_rooms` — every room id this account is currently a member of. */
export async function getJoinedRooms(config: MatrixApiConfig): Promise<readonly string[]> {
  const response = await get(config, "/_matrix/client/v3/joined_rooms");
  if (!response.ok) {
    throw new MatrixApiError(
      response.status,
      `joined_rooms failed: ${response.status} ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { joined_rooms: string[] };
  return body.joined_rooms;
}

/**
 * `GET /_matrix/client/v3/rooms/{roomId}/state/{eventType}/` — one room's
 * current state event of a given type, or `undefined` if that room has
 * none (a real, expected case — e.g. `m.room.encryption` absent means
 * "not encrypted," verified: a 404, not an error). Any other
 * non-2xx status is a real error, not treated as "absent."
 */
export async function getRoomState<T>(
  config: MatrixApiConfig,
  roomId: string,
  eventType: string,
): Promise<T | undefined> {
  const response = await get(
    config,
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${eventType}/`,
  );
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new MatrixApiError(
      response.status,
      `state ${eventType} for ${roomId} failed: ${response.status} ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

/**
 * A room's own display name and current encryption status, read-only —
 * exactly the two facts `listChannels` surfaces for a picker. `name` falls back to the room id itself when the
 * room has no `m.room.name` state event (a real, common case for a
 * plain-two-person room) — an honest placeholder, not a guess at Matrix's
 * own calculated-room-name algorithm, which needs member profile data
 * this bridge has no other reason to fetch yet.
 */
export async function getRoomSummary(
  config: MatrixApiConfig,
  roomId: string,
): Promise<{ roomId: string; name: string; encrypted: boolean }> {
  const [nameState, encryptionState] = await Promise.all([
    getRoomState<{ name: string }>(config, roomId, "m.room.name"),
    getRoomState<{ algorithm: string }>(config, roomId, "m.room.encryption"),
  ]);
  return {
    roomId,
    name: nameState?.name ?? roomId,
    encrypted: encryptionState !== undefined,
  };
}
