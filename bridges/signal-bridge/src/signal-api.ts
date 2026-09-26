/**
 * network-policy: loopback — Zone B (docs/network-policy.md). Every call here goes
 * through the already-running `signal-cli daemon`'s Unix domain socket
 * (`signal-daemon.ts`), never a direct network connection of its own.
 */
/**
 * A thin wrapper around `signal-cli`'s JSON-RPC methods — the counterpart of
 * `bridges/matrix-bridge/src/matrix-api.ts` (one function per underlying call, no
 * `MessengerPort` framing here), except every call goes through an injected `SignalRpc`:
 * backed by `signal-daemon.ts`'s real `SignalDaemon` in production, and by a small
 * in-memory fake in this module's L0 tests and `server.test.ts`. Signal has no local
 * server to run these against, so the level above the fakes is L4, against two real
 * linked accounts (`l4-contract.test.ts`, `l4-attachments.test.ts`; docs/testing.md).
 * Field names follow SPECIFICATION.md §13.2 (`listGroups` → base64 `id` + display
 * `name`; a received envelope's `dataMessage.groupInfo.groupId`) and were confirmed
 * against real `signal-cli` responses, as were the attachment calls (`send`'s
 * `attachments` data URIs, a received message's `attachments` list, `getAttachment`).
 */

export interface SignalRpc {
  callRpc<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  onNotification(handler: (method: string, params: unknown) => void): () => void;
}

export interface GroupSummary {
  readonly groupId: string;
  readonly name: string;
}

/** `signal-cli listGroups` — every group this account is currently a member of. */
export async function listGroups(
  rpc: SignalRpc,
  account: string,
): Promise<readonly GroupSummary[]> {
  const groups = await rpc.callRpc<readonly Record<string, unknown>[]>("listGroups", { account });
  return groups
    .map((group) => ({
      groupId: typeof group.id === "string" ? group.id : "",
      name: typeof group.name === "string" ? group.name : "",
    }))
    .filter((group) => group.groupId.length > 0);
}

/**
 * `signal-cli send -g <groupId> -m <message>` — sends `message` (the
 * bridge's own `{tdsp:1,...}` JSON envelope, D2a) as an ordinary group
 * text message. Returns the send timestamp, which `server.ts` uses as
 * the `DeliveryId`/`ResyncRequestId` (mirrors Matrix's own use of
 * `eventId` for the same purpose) — signal-cli's own `send` result
 * shape carries a `timestamp` field (this account's own send timestamp
 * doubles as Signal's own message identifier within a conversation).
 */
export async function sendGroupMessage(
  rpc: SignalRpc,
  account: string,
  groupId: string,
  message: string,
  attachments?: readonly string[],
): Promise<{ timestamp: number }> {
  const result = await rpc.callRpc<{ timestamp?: number; results?: readonly unknown[] }>("send", {
    account,
    groupId,
    message,
    ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
  });
  if (typeof result.timestamp !== "number") {
    throw new Error(`signal-cli send did not return a timestamp: ${JSON.stringify(result)}`);
  }
  return { timestamp: result.timestamp };
}

/**
 * One incoming group text message, already narrowed out of a raw
 * `receive` notification's `envelope` — `undefined` for anything that
 * isn't a group `dataMessage` with a text body (a receipt, a typing
 * indicator, a direct/non-group message, an attachment-only message):
 * none of those can carry this project's own envelope, so `sync-state.ts`
 * silently ignores them — the "unrecognized ⇒ dropped" rule of SPECIFICATION.md
 * BND-2 for foreign traffic. (A message that carries an attachment *and* a text body
 * is one: the body is the envelope and the attachment is the frame it names, §13.2.)
 */
export interface IncomingGroupMessage {
  readonly groupId: string;
  readonly sender: string;
  readonly timestamp: number;
  readonly message: string;
  /** The attachments `signal-cli` reports for the message: the id it stored them under, and the size it says. */
  readonly attachments: readonly IncomingAttachment[];
}

export interface IncomingAttachment {
  readonly id: string;
  readonly size: number;
}

export function parseIncomingGroupMessage(
  notificationParams: unknown,
): IncomingGroupMessage | null {
  if (typeof notificationParams !== "object" || notificationParams === null) {
    return null;
  }
  const envelope = (notificationParams as { envelope?: unknown }).envelope;
  if (typeof envelope !== "object" || envelope === null) {
    return null;
  }
  const { sourceUuid, dataMessage } = envelope as {
    sourceUuid?: unknown;
    dataMessage?: unknown;
  };
  // The ACI only, never the phone number (`source`): the ACI is what `/whoami` answers and
  // the creator is compared against, so a delivery attributed to anything else could never
  // match — or match a different spelling of the same person (SPECIFICATION.md SIG-2).
  const sender = sourceUuid;
  if (typeof sender !== "string" || typeof dataMessage !== "object" || dataMessage === null) {
    return null;
  }
  const { message, timestamp, groupInfo, attachments } = dataMessage as {
    message?: unknown;
    timestamp?: unknown;
    groupInfo?: unknown;
    attachments?: unknown;
  };
  if (typeof message !== "string" || typeof timestamp !== "number") {
    return null;
  }
  const groupId = (groupInfo as { groupId?: unknown } | undefined)?.groupId;
  if (typeof groupId !== "string") {
    return null; // not a group message — out of scope, D2a's mapping only ever binds to a group
  }
  return { groupId, sender, timestamp, message, attachments: parseAttachmentList(attachments) };
}

/**
 * Everything about a real Signal edit or remote-delete this bridge needs to
 * reject it and, where possible, attribute the rejection to a document
 * (SPECIFICATION.md BRG-12). Both shapes were confirmed against real linked
 * accounts: an edit arrives as a sibling `envelope.editMessage` field, not a
 * `dataMessage` at all, so {@link parseIncomingGroupMessage}'s `dataMessage` guard
 * rejects it like an ordinary receipt; a remote-delete passes that guard but fails
 * its `message`-is-a-string check one line later. Without this module, both would
 * look to the bridge like "not ours".
 */
export interface IncomingEditOrDelete {
  readonly kind: "edit" | "remote-delete";
  readonly sender: string;
  readonly groupId: string;
  /** The original message's own `timestamp` — Signal's own target for an edit or a remote-delete, and the second half of this bridge's own `Delivery.id` (`${sender}:${timestamp}`) for whatever it originally sent. */
  readonly targetTimestamp: number;
  /** An edit's own replacement text — still worth trying to parse as a tdsp envelope purely to recover `documentId` for attribution (never applied as data). `undefined` for a remote-delete, which carries no text at all. */
  readonly editedMessage: string | undefined;
}

export function parseIncomingEditOrDelete(
  notificationParams: unknown,
): IncomingEditOrDelete | null {
  if (typeof notificationParams !== "object" || notificationParams === null) {
    return null;
  }
  const envelope = (notificationParams as { envelope?: unknown }).envelope;
  if (typeof envelope !== "object" || envelope === null) {
    return null;
  }
  const { source, sourceUuid, dataMessage, editMessage } = envelope as {
    source?: unknown;
    sourceUuid?: unknown;
    dataMessage?: unknown;
    editMessage?: unknown;
  };
  // Unlike a delivery, a rejected edit or delete only becomes an integrity record, so a
  // message without an ACI is still recorded — under the phone number — rather than lost.
  const sender = typeof sourceUuid === "string" ? sourceUuid : source;
  if (typeof sender !== "string") {
    return null;
  }

  if (typeof editMessage === "object" && editMessage !== null) {
    const { targetSentTimestamp, dataMessage: inner } = editMessage as {
      targetSentTimestamp?: unknown;
      dataMessage?: unknown;
    };
    if (typeof targetSentTimestamp !== "number" || typeof inner !== "object" || inner === null) {
      return null;
    }
    const { message, groupInfo } = inner as { message?: unknown; groupInfo?: unknown };
    const groupId = (groupInfo as { groupId?: unknown } | undefined)?.groupId;
    if (typeof groupId !== "string") {
      return null; // not a group message — out of scope, same as parseIncomingGroupMessage
    }
    return {
      kind: "edit",
      sender,
      groupId,
      targetTimestamp: targetSentTimestamp,
      editedMessage: typeof message === "string" ? message : undefined,
    };
  }

  if (typeof dataMessage === "object" && dataMessage !== null) {
    const { remoteDelete, groupInfo } = dataMessage as {
      remoteDelete?: unknown;
      groupInfo?: unknown;
    };
    if (typeof remoteDelete !== "object" || remoteDelete === null) {
      return null;
    }
    const targetTimestamp = (remoteDelete as { timestamp?: unknown }).timestamp;
    const groupId = (groupInfo as { groupId?: unknown } | undefined)?.groupId;
    if (typeof targetTimestamp !== "number" || typeof groupId !== "string") {
      return null;
    }
    return { kind: "remote-delete", sender, groupId, targetTimestamp, editedMessage: undefined };
  }

  return null;
}

function parseAttachmentList(raw: unknown): readonly IncomingAttachment[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: IncomingAttachment[] = [];
  for (const entry of raw) {
    const { id, size } = (entry ?? {}) as { id?: unknown; size?: unknown };
    // An attachment without a usable id or size is not one this bridge could ever read back.
    if (typeof id === "string" && typeof size === "number") {
      out.push({ id, size });
    }
  }
  return out;
}

/**
 * `signal-cli getAttachment` — the bytes of a received attachment, by the id the receive
 * notification named, in the group it arrived in. `signal-cli` answers with the file Base64-encoded;
 * whether that is the bare string or an object carrying it is read both ways, and anything else is
 * an error rather than an empty frame.
 */
export async function getAttachmentBytes(
  rpc: SignalRpc,
  account: string,
  groupId: string,
  id: string,
): Promise<Uint8Array> {
  const result = await rpc.callRpc<unknown>("getAttachment", { account, groupId, id });
  const encoded = typeof result === "string" ? result : (result as { data?: unknown } | null)?.data;
  if (typeof encoded !== "string") {
    throw new Error(
      `signal-cli getAttachment did not return data: ${JSON.stringify(result)?.slice(0, 200)}`,
    );
  }
  return new Uint8Array(Buffer.from(encoded, "base64"));
}
