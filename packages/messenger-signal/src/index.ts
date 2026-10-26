/**
 * network-policy: loopback — Zone A (docs/network-policy.md). Every fetch() below
 * targets bridges/signal-bridge on this same machine; resolveBridgeUrl()
 * refuses any non-loopback override before a request is ever made.
 */

import { isLoopbackUrl } from "@tdsp/loopback";
import {
  type Delivery,
  type DeliveryId,
  type DocumentId,
  type MemberId,
  type MessengerPort,
  type MessengerProvider,
  parseTransportProfile,
  type RawChannel,
  type TransportProfile,
  transportSendErrorFromHttp,
} from "@tdsp/messenger-port";
import { type IntegrityEntry, readIntegrityLog } from "./integrity.ts";

/**
 * The browser-side half of the Signal adapter — a thin `fetch()` wrapper
 * against `bridges/signal-bridge`'s local bridge interface (bindings/local-bridge-interface.md §12.6),
 * never `signal-cli` or any Signal library itself (that all lives in the
 * bridge process, behind a Unix socket this package never touches). Zero
 * `node:*` imports, Vite-bundleable like every other `packages/*`,
 * mirroring `@tdsp/messenger-matrix`'s own `MatrixMessengerPort`
 * as closely as the two adapters' real differences allow — a reader
 * already familiar with one should recognize the other immediately.
 *
 * Verified against two real `bridges/signal-bridge` instances and two real
 * Signal accounts: every route this class calls has a response shape
 * confirmed on the wire, not assumed.
 *
 * `sendInvitation` (SPECIFICATION.md §11) sends a plain group text message,
 * not a `{tdsp:1,...}` envelope, so the receiving bridge needs no special
 * case (its "not our envelope ⇒ silently ignored" rule already covers it).
 */
export class SignalMessengerPort implements MessengerPort {
  readonly #bridgeUrl: string;
  /** Mirrors `MatrixMessengerPort`'s own field — see that class's doc comment for why `createDocument` needs no further bridge call once {@link bind} has already recorded it server-side. */
  readonly #boundDocuments = new Map<DocumentId, { groupId: string; creator: MemberId }>();

  constructor(bridgeUrl: string) {
    this.#bridgeUrl = bridgeUrl;
  }

  /**
   * Adapter-specific — deliberately **not** part of `MessengerPort`, like
   * `MatrixMessengerPort.bind`. Must be called, successfully, before
   * `DocumentEngine.create()`/`.join()` for a given `documentId`.
   */
  async bind(
    documentId: DocumentId,
    groupId: string,
    creator: MemberId,
    profile: string,
  ): Promise<void> {
    const response = await fetch(
      `${this.#bridgeUrl}/channels/${encodeURIComponent(documentId)}/bind`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The wire field is channelId, as in every bridge's bind body (§12.6).
        body: JSON.stringify({ channelId: groupId, creator, profile }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `bind(${documentId} -> ${groupId}) failed: ${response.status} ${await response.text()}`,
      );
    }
    this.#boundDocuments.set(documentId, { groupId, creator });
  }

  /**
   * Adapter-specific, like {@link bind} — this bridge's own `MemberId` is
   * its linked account's ACI, never something a caller picks. Mirrors
   * `MatrixMessengerPort.whoami`, and every bridge's `/whoami` answers the
   * same shape, `{id}` (bindings/local-bridge-interface.md §12.6).
   */
  async whoami(): Promise<{ id: MemberId }> {
    const response = await fetch(`${this.#bridgeUrl}/whoami`);
    if (!response.ok) {
      throw new Error(`whoami failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as { id: MemberId };
  }

  /**
   * Adapter-specific, like {@link bind}/{@link whoami} — deliberately
   * not part of `MessengerPort` (same reasoning as
   * `MatrixMessengerPort.sendInvitation`'s own doc comment: a plain
   * human-readable message needs no `documentId`-based routing on
   * receipt). `actor` must be `documentId`'s creator — the bridge
   * enforces this server-side, a non-creator attempt 403s.
   */
  async sendInvitation(
    documentId: DocumentId,
    sender: MemberId,
    text: string,
  ): Promise<DeliveryId> {
    const response = await fetch(
      `${this.#bridgeUrl}/channels/${encodeURIComponent(documentId)}/invite`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor: sender, text }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `sendInvitation(${documentId}) failed: ${response.status} ${await response.text()}`,
      );
    }
    const body = (await response.json()) as { deliveryId?: unknown; eventId?: unknown };
    const id = body.deliveryId ?? body.eventId;
    if (typeof id !== "string") {
      throw new Error(`sendInvitation(${documentId}): the bridge named no delivery id`);
    }
    return id;
  }

  /** Confirms the binding {@link bind} already established, rather than sending anything new — see `MatrixMessengerPort.createDocument`'s doc comment for why. */
  async createDocument(documentId: DocumentId, creator: MemberId): Promise<void> {
    const bound = this.#boundDocuments.get(documentId);
    if (!bound) {
      throw new Error(
        `createDocument(${documentId}): no group bound yet — call bind(documentId, groupId, creator, profile) first`,
      );
    }
    if (bound.creator !== creator) {
      throw new Error(
        `createDocument(${documentId}): creator mismatch — bound with creator "${bound.creator}", called with "${creator}"`,
      );
    }
  }

  /**
   * `GET /health` — the epoch of the bridge's window (SPECIFICATION.md TRN-19), which changes when
   * the bridge may have lost a delivery. A bridge that names none is refused, not answered with a
   * fixed value that would hide its restarts (TRN-9).
   */
  async instance(): Promise<string> {
    const response = await fetch(`${this.#bridgeUrl}/health`);
    if (!response.ok) {
      throw new Error(`instance failed: ${response.status} ${await response.text()}`);
    }
    const health: unknown = await response.json();
    const instance =
      typeof health === "object" && health !== null
        ? (health as { instance?: unknown }).instance
        : undefined;
    if (typeof instance !== "string" || instance === "") {
      throw new Error("instance: the bridge names no instance of its window (TRN-19)");
    }
    return instance;
  }

  /**
   * `GET /members?channelId=` — the members of channel `channelId` as the bridge's messenger
   * reports them now (SPECIFICATION.md TRN-17): a snapshot, the bridge's own account included.
   * A channel that account is not in is refused, as is an answer that is not a list of ids.
   */
  async channelMembers(channelId: string): Promise<readonly MemberId[]> {
    const response = await fetch(
      `${this.#bridgeUrl}/members?channelId=${encodeURIComponent(channelId)}`,
    );
    if (!response.ok) {
      throw new Error(`channelMembers failed: ${response.status} ${await response.text()}`);
    }
    const members: unknown = await response.json();
    if (!Array.isArray(members) || !members.every((member) => typeof member === "string")) {
      throw new Error(
        "channelMembers: the bridge answered something that is not a list of member ids",
      );
    }
    return members;
  }

  /**
   * `GET /channels` — the account's raw, currently-known Signal groups
   * (D2a: "listGroups is used only to validate a binding at bind time,
   * not to enumerate documents"), for a picker only. No
   * `encrypted` field: a Signal group message is always end-to-end
   * encrypted by the Signal Protocol itself, with no per-group toggle to
   * report — `RawChannel.encrypted`'s own doc comment already names
   * Signal as exactly this case.
   */
  async listChannels(_member: MemberId): Promise<readonly RawChannel[]> {
    const response = await fetch(`${this.#bridgeUrl}/channels`);
    if (!response.ok) {
      throw new Error(`listChannels failed: ${response.status} ${await response.text()}`);
    }
    // The bridge answers RawChannel's own shape ({id, name}); no remapping needed.
    return (await response.json()) as RawChannel[];
  }

  /**
   * `GET /transport-profile` — the send policies and hard bounds this bridge says a
   * client should use with what is behind it. It is asked for before
   * anything is sent, and a bridge that cannot answer, or answers something that is not
   * a profile, fails the call: falling back to no limits would be sending faster than
   * the provider allows.
   */
  async transportProfile(): Promise<TransportProfile | undefined> {
    const response = await fetch(`${this.#bridgeUrl}/transport-profile`);
    if (!response.ok) {
      throw new Error(`transportProfile failed: ${response.status} ${await response.text()}`);
    }
    const profile = parseTransportProfile(await response.json());
    if (profile === undefined) {
      throw new Error(
        "transportProfile failed: the bridge answered something that is not a transport profile",
      );
    }
    return profile;
  }

  /**
   * `GET /channels/:documentId/integrity-log` — every edit/remote-delete
   * the bridge caught and refused to apply for `documentId` (SPECIFICATION.md
   * BRG-12, BRG-15), mirroring `EmailMessengerPort.integrityLog()`/
   * `MatrixMessengerPort.integrityLog()` exactly. Diagnostic, not part of
   * `MessengerPort` — in-memory on the bridge, so it resets when the
   * bridge restarts.
   */
  async integrityLog(documentId: DocumentId): Promise<readonly IntegrityEntry[]> {
    const response = await fetch(
      `${this.#bridgeUrl}/channels/${encodeURIComponent(documentId)}/integrity-log`,
    );
    if (!response.ok) {
      throw new Error(
        `integrityLog(${documentId}) failed: ${response.status} ${await response.text()}`,
      );
    }
    return readIntegrityLog(await response.json());
  }

  /** `POST /channels/:documentId/send` — `payload` — the frame's JSON text — rides opaque, same rule as Matrix's own `send()`. */
  async send(documentId: DocumentId, sender: MemberId, payload: string): Promise<DeliveryId> {
    const response = await fetch(
      `${this.#bridgeUrl}/channels/${encodeURIComponent(documentId)}/send`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sender, payload }),
      },
    );
    if (!response.ok) {
      throw transportSendErrorFromHttp(
        `send(${documentId})`,
        response.status,
        await response.text(),
        response.headers.get("retry-after"),
      );
    }
    const body = (await response.json()) as { deliveryId: string };
    return body.deliveryId;
  }

  /** `GET /channels/:documentId/deliveries` — the bridge's own cumulative buffer, matching `InMemoryMessengerPort.receive()`'s existing "full history, caller dedups" contract. */
  async receive(documentId: DocumentId, _member: MemberId): Promise<readonly Delivery[]> {
    const response = await fetch(
      `${this.#bridgeUrl}/channels/${encodeURIComponent(documentId)}/deliveries`,
    );
    if (!response.ok) {
      throw new Error(`receive(${documentId}) failed: ${response.status} ${await response.text()}`);
    }
    const deliveries = (await response.json()) as { id: string; sender: string; payload: string }[];
    return deliveries.map((delivery) => ({
      id: delivery.id,
      documentId,
      sender: delivery.sender,
      payload: delivery.payload,
    }));
  }

  /**
   * `GET /channels/:documentId/deliveries-since?after=` — the deliveries after the cursor `after`,
   * oldest first, and whether some after it may have come and gone unseen (SPECIFICATION.md
   * TRN-18, TRN-21). An answer of another shape is refused, as is a bridge that does not offer the
   * route (TRN-9).
   */
  async receiveSince(
    documentId: DocumentId,
    _member: MemberId,
    after: DeliveryId | undefined,
  ): Promise<{ readonly deliveries: readonly Delivery[]; readonly truncated: boolean }> {
    const query = after === undefined ? "" : `?after=${encodeURIComponent(after)}`;
    const response = await fetch(
      `${this.#bridgeUrl}/channels/${encodeURIComponent(documentId)}/deliveries-since${query}`,
    );
    if (!response.ok) {
      throw new Error(
        `receiveSince(${documentId}) failed: ${response.status} ${await response.text()}`,
      );
    }
    const body = (await response.json()) as {
      deliveries?: { id: string; sender: string; payload: string }[];
      truncated?: unknown;
    };
    if (!Array.isArray(body.deliveries) || typeof body.truncated !== "boolean") {
      throw new Error(
        "receiveSince: the bridge answered something that is not deliveries and truncated",
      );
    }
    return {
      deliveries: body.deliveries.map((delivery) => ({
        id: delivery.id,
        documentId,
        sender: delivery.sender,
        payload: delivery.payload,
      })),
      truncated: body.truncated,
    };
  }
}

function resolveBridgeUrl(): string {
  if (typeof window !== "undefined") {
    const fromQuery = new URLSearchParams(window.location.search).get("bridge");
    if (fromQuery && fromQuery.length > 0) {
      if (!isLoopbackUrl(fromQuery)) {
        throw new Error(
          `Refusing the ?bridge= override "${fromQuery}": this adapter only ever connects to a ` +
            "bridge on this machine (localhost, 127.0.0.0/8 or ::1) — see " +
            "docs/network-policy.md.",
        );
      }
      return fromQuery;
    }
  }
  const configured = import.meta.env?.VITE_SIGNAL_BRIDGE_URL as string | undefined;
  if (configured && configured.length > 0) {
    if (!isLoopbackUrl(configured)) {
      throw new Error(
        `Refusing VITE_SIGNAL_BRIDGE_URL "${configured}": this adapter only ever connects to a ` +
          "bridge on this machine (localhost, 127.0.0.0/8 or ::1) — see " +
          "docs/network-policy.md.",
      );
    }
    return configured;
  }
  return "http://localhost:8787";
}

export const signalMessengerProvider: MessengerProvider = {
  id: "signal",
  displayName: "Signal (via bridges/signal-bridge)",
  async createPort() {
    return new SignalMessengerPort(resolveBridgeUrl());
  },
};

export {
  describeSignalIntegrityEntry,
  type IntegrityEntry,
  type IntegrityReason,
  type IntegritySeverity,
  type NoticeReason,
  readIntegrityLog,
  summarizeSignalIntegrity,
} from "./integrity.ts";
