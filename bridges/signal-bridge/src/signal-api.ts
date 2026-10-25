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
 * Field names follow bindings/signal.md §13.2 (`listGroups` → base64 `id` + display
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
  /**
   * The group's members by ACI (their `MemberId`, bindings/signal.md SIG-2), as `signal-cli`
   * lists them now: `members[].uuid` — the members, not the invited or requesting ones.
   * Verified against signal-cli's source (0.14.9, `ListGroupsCommand`), not a captured response.
   */
  readonly members: readonly string[];
  /** `false` for a group this account has left, which signal-cli still lists. */
  readonly isMember: boolean;
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
      members: Array.isArray(group.members)
        ? group.members
            .map((member) => (member as { uuid?: unknown } | null)?.uuid)
            .filter((uuid): uuid is string => typeof uuid === "string" && uuid.length > 0)
        : [],
      isMember: group.isMember !== false,
    }))
    .filter((group) => group.groupId.length > 0);
}

/**
 * The recipients a group message missed for now, as `signal-cli` reports them. Signal has no
 * server that fans a group message out: `signal-cli` sends it to every member itself, answers
 * `send` with one result per recipient, and raises no error as long as one of them got it.
 */
export interface MissedRecipients {
  /** Recipients Signal rate-limited (`RATE_LIMIT_FAILURE`). */
  readonly rateLimited: number;
  /** The longest wait Signal stated for any recipient, in seconds, if it stated one. */
  readonly retryAfterSeconds: number | undefined;
  /** Recipients Signal could not reach (`NETWORK_FAILURE`). */
  readonly unreachable: number;
}

/**
 * Reads `signal-cli`'s result per recipient (`results` of its `send` answer, each with a `type`
 * and, for a rate limit, `retryAfterSeconds`; `JsonSendMessageResult` in its 0.14.9 source).
 * Counted are only the recipients a retry of the same message can still reach: a rate limit and a
 * network failure. A recipient that is not registered, or whose identity this account does not
 * trust, would be missed by every retry too.
 */
export function missedRecipients(results: unknown): MissedRecipients {
  let rateLimited = 0;
  let unreachable = 0;
  if (Array.isArray(results)) {
    for (const result of results) {
      const type = (result as { type?: unknown } | null)?.type;
      if (type === "RATE_LIMIT_FAILURE") {
        rateLimited += 1;
      } else if (type === "NETWORK_FAILURE") {
        unreachable += 1;
      }
    }
  }
  return { rateLimited, retryAfterSeconds: longestRetryAfterSeconds(results), unreachable };
}

/**
 * Who a group message reached and who it skipped as an identity this account does not trust, by
 * `signal-cli`'s result per recipient (`JsonSendMessageResult` in its 0.14.9 source): each names
 * its recipient as `recipientAddress`, by ACI (`uuid`) where it has one, else by number. A result
 * `IDENTITY_FAILURE` with a `token` is a proof Signal requires, which that type stands for too, not
 * an untrusted identity.
 */
export function recipientsByResult(results: unknown): {
  readonly untrusted: readonly string[];
  readonly reached: readonly string[];
} {
  const untrusted: string[] = [];
  const reached: string[] = [];
  if (Array.isArray(results)) {
    for (const result of results) {
      if (typeof result !== "object" || result === null) {
        continue;
      }
      const { type, token, recipientAddress } = result as {
        type?: unknown;
        token?: unknown;
        recipientAddress?: { uuid?: unknown; number?: unknown } | null;
      };
      const recipient =
        typeof recipientAddress?.uuid === "string"
          ? recipientAddress.uuid
          : typeof recipientAddress?.number === "string"
            ? recipientAddress.number
            : undefined;
      if (recipient === undefined) {
        continue;
      }
      if (type === "SUCCESS") {
        reached.push(recipient);
      } else if (type === "IDENTITY_FAILURE" && (token === undefined || token === null)) {
        untrusted.push(recipient);
      }
    }
  }
  return { untrusted, reached };
}

/**
 * The longest `retryAfterSeconds` among `signal-cli`'s results per recipient, if any states a
 * usable one: the wait after which a retry can reach every recipient Signal rate-limited.
 */
export function longestRetryAfterSeconds(results: unknown): number | undefined {
  if (!Array.isArray(results)) {
    return undefined;
  }
  let longest: number | undefined;
  for (const result of results) {
    const seconds = (result as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds;
    if (typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds >= 0) {
      longest = Math.max(longest ?? 0, seconds);
    }
  }
  return longest;
}

/**
 * `signal-cli send -g <groupId> -m <message>` — sends `message` (the
 * bridge's own `{tdsp:1,...}` JSON envelope, D2a) as an ordinary group
 * text message. Returns the send timestamp, which `server.ts` uses as
 * the `DeliveryId`/`ResyncRequestId` (mirrors Matrix's own use of
 * `eventId` for the same purpose) — signal-cli's own `send` result
 * shape carries a `timestamp` field (this account's own send timestamp
 * doubles as Signal's own message identifier within a conversation) —
 * the recipients it missed for now (`missedRecipients`), and its result per
 * recipient as it came (`results`), which the caller decides about.
 */
export async function sendGroupMessage(
  rpc: SignalRpc,
  account: string,
  groupId: string,
  message: string,
  attachments?: readonly string[],
): Promise<{ timestamp: number; missed: MissedRecipients; results: unknown }> {
  const result = await rpc.callRpc<{ timestamp?: number; results?: readonly unknown[] }>("send", {
    account,
    groupId,
    message,
    ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
  });
  if (typeof result.timestamp !== "number") {
    throw new Error(`signal-cli send did not return a timestamp: ${JSON.stringify(result)}`);
  }
  return {
    timestamp: result.timestamp,
    missed: missedRecipients(result.results),
    results: result.results,
  };
}

/**
 * One incoming group text message, already narrowed out of a raw
 * `receive` notification's `envelope` — a member's message, or one this account sent
 * from another device (SIG-3) — `undefined` for anything that
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

/**
 * What an envelope carries, whichever way it came: a message from a member arrives as
 * `dataMessage` (an edit as `editMessage`); one this account sent from another of its devices
 * arrives as the sync transcript `syncMessage.sentMessage`, with the same fields one level
 * deeper — the transcript is the `dataMessage`, and an edit is its `editMessage` (SPECIFICATION.md
 * SIG-3). Signal sends a transcript only to the account's own devices, so one whose sender is not
 * `ownAci` is not one and carries nothing; with `ownAci` unknown (not linked yet), none counts.
 */
function messageParts(
  envelope: object,
  ownAci: string | undefined,
): { readonly dataMessage?: unknown; readonly editMessage?: unknown } {
  const { sourceUuid, dataMessage, editMessage, syncMessage } = envelope as {
    sourceUuid?: unknown;
    dataMessage?: unknown;
    editMessage?: unknown;
    syncMessage?: unknown;
  };
  const sentMessage = (syncMessage as { sentMessage?: unknown } | null | undefined)?.sentMessage;
  if (typeof sentMessage !== "object" || sentMessage === null) {
    return { dataMessage, editMessage };
  }
  if (ownAci === undefined || sourceUuid !== ownAci) {
    return {};
  }
  const transcriptEdit = (sentMessage as { editMessage?: unknown }).editMessage;
  return transcriptEdit === undefined || transcriptEdit === null
    ? { dataMessage: sentMessage }
    : { editMessage: transcriptEdit };
}

/**
 * `ownAci` is this bridge's own account; a message it sent from another device counts only
 * with it (SIG-3).
 */
export function parseIncomingGroupMessage(
  notificationParams: unknown,
  ownAci?: string,
): IncomingGroupMessage | null {
  if (typeof notificationParams !== "object" || notificationParams === null) {
    return null;
  }
  const envelope = (notificationParams as { envelope?: unknown }).envelope;
  if (typeof envelope !== "object" || envelope === null) {
    return null;
  }
  const { sourceUuid } = envelope as { sourceUuid?: unknown };
  const { dataMessage } = messageParts(envelope, ownAci);
  // The ACI only, never the phone number (`source`): the ACI is what `/whoami` answers and
  // the creator is compared against, so a delivery attributed to anything else could never
  // match — or match a different spelling of the same person (bindings/signal.md SIG-2).
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
 * (bindings/bridges.md BRG-12). Both shapes were confirmed against real linked
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
}

/**
 * An edit or remote-delete this account sent from another device arrives inside the sync
 * transcript, and is caught the same way (SIG-3).
 */
export function parseIncomingEditOrDelete(
  notificationParams: unknown,
  ownAci?: string,
): IncomingEditOrDelete | null {
  if (typeof notificationParams !== "object" || notificationParams === null) {
    return null;
  }
  const envelope = (notificationParams as { envelope?: unknown }).envelope;
  if (typeof envelope !== "object" || envelope === null) {
    return null;
  }
  const { source, sourceUuid } = envelope as { source?: unknown; sourceUuid?: unknown };
  const { dataMessage, editMessage } = messageParts(envelope, ownAci);
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
    const { groupInfo } = inner as { groupInfo?: unknown };
    const groupId = (groupInfo as { groupId?: unknown } | undefined)?.groupId;
    if (typeof groupId !== "string") {
      return null; // not a group message — out of scope, same as parseIncomingGroupMessage
    }
    return { kind: "edit", sender, groupId, targetTimestamp: targetSentTimestamp };
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
    return { kind: "remote-delete", sender, groupId, targetTimestamp };
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
