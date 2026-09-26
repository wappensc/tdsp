/**
 * network-policy: loopback — Zone A (docs/network-policy.md). Every fetch() below
 * targets bridges/matrix-bridge on this same machine; resolveBridgeUrl()
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
import type { IntegrityEntry } from "./integrity.ts";

/**
 * The browser-side half of the Matrix adapter — a thin `fetch()` wrapper against
 * `bridges/matrix-bridge`'s local bridge interface (SPECIFICATION.md §12.6), never a
 * Matrix client library itself (no `matrix-js-sdk` or crypto WASM in the browser bundle;
 * that all lives in the bridge process). No `node:*` imports, bundleable like every
 * other package here. Every `MessengerPort` method is verified against a real local
 * Synapse through `bridges/matrix-bridge`'s own test suites.
 */
export class MatrixMessengerPort implements MessengerPort {
  readonly #bridgeUrl: string;
  /**
   * Tracks which `documentId`s this port instance has already bound to a
   * room via {@link bind}, and to which creator — `createDocument`'s own
   * implementation checks this rather than calling the bridge a second
   * time, since `bind`'s own bridge call (`POST /channels/:documentId/
   * bind`) already fully records the binding server-side (binding writes
   * nothing into the room, so there is nothing further for `createDocument`
   * to send). This is exactly the "an adapter
   * implementation already knows the answer from that prior, adapter-
   * specific step" `MessengerPort.createDocument`'s own doc comment
   * describes: `bind` is that prior step, always called first by
   * whatever application or room picker drives this class, never by `document-protocol` itself.
   */
  readonly #boundDocuments = new Map<DocumentId, { roomId: string; creator: MemberId }>();

  constructor(bridgeUrl: string) {
    this.#bridgeUrl = bridgeUrl;
  }

  /**
   * Adapter-specific — deliberately **not** part of `MessengerPort`
   * (`MessengerPort.createDocument`'s own doc comment:
   * "Binding *which* existing channel this document's traffic rides on
   * is an adapter-specific concern, handled entirely outside
   * `MessengerPort`"). Must be called, successfully, before
   * `DocumentEngine.create()`/`.join()` for a given `documentId` — both
   * eventually call `MessengerPort` methods that assume the binding
   * already exists.
   */
  async bind(
    documentId: DocumentId,
    roomId: string,
    creator: MemberId,
    profile: string,
  ): Promise<void> {
    const response = await fetch(
      `${this.#bridgeUrl}/channels/${encodeURIComponent(documentId)}/bind`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The wire field is channelId, as in every bridge's bind body (§12.6).
        body: JSON.stringify({ channelId: roomId, creator, profile }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `bind(${documentId} -> ${roomId}) failed: ${response.status} ${await response.text()}`,
      );
    }
    this.#boundDocuments.set(documentId, { roomId, creator });
  }

  /**
   * Adapter-specific, like {@link bind} — deliberately not part of
   * `MessengerPort` (`MemberId` for the mock is a free-text string a
   * human types in; for Matrix it's this bridge's own fixed account, not
   * something a caller picks). An application calls this once, before any
   * `bind()`/`DocumentEngine.create()`/`.join()`, to learn its own `MemberId`.
   * Returns `{ id }`, as every bridge's `/whoami` does (SPECIFICATION.md §12.6).
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
   * not part of `MessengerPort`'s required methods: an invitation (SPECIFICATION.md §11)
   * is a plain human-readable chat message with no frame envelope and needs no
   * `documentId` routing on receipt. `actor` must be `documentId`'s creator — the bridge
   * refuses anyone else (BRG-16).
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

  /**
   * Confirms the binding {@link bind} already established, rather than
   * sending anything new — see this class's own field doc comment above
   * for why there is nothing left to send at this point. Throws a clear,
   * specific error (not a generic capability-gap one) when called
   * without a prior `bind()` — a real usage-order bug, not a genuine
   * Matrix limitation.
   */
  async createDocument(documentId: DocumentId, creator: MemberId): Promise<void> {
    const bound = this.#boundDocuments.get(documentId);
    if (!bound) {
      throw new Error(
        `createDocument(${documentId}): no room bound yet — call bind(documentId, roomId, creator, profile) first`,
      );
    }
    if (bound.creator !== creator) {
      throw new Error(
        `createDocument(${documentId}): creator mismatch — bound with creator "${bound.creator}", called with "${creator}"`,
      );
    }
  }

  /**
   * `GET /channels` — the account's raw, currently visible Matrix rooms, for a
   * picker only, never "my documents." `member` is accepted for `MessengerPort`
   * conformance but not otherwise used: one bridge process and access token are
   * exactly one Matrix account, so there is no other account to list rooms for.
   */
  async listChannels(_member: MemberId): Promise<readonly RawChannel[]> {
    const response = await fetch(`${this.#bridgeUrl}/channels`);
    if (!response.ok) {
      throw new Error(`listChannels failed: ${response.status} ${await response.text()}`);
    }
    // The bridge answers RawChannel's own shape ({id, name, encrypted}).
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
   * `GET /channels/:documentId/integrity-log` — every edit/redaction the
   * bridge caught and refused to apply for `documentId` (SPECIFICATION.md
   * BRG-12, BRG-15), mirroring `EmailMessengerPort.integrityLog()` exactly.
   * Diagnostic, not part of `MessengerPort` — in-memory on the bridge, so
   * it resets when the bridge restarts.
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
    return (await response.json()) as readonly IntegrityEntry[];
  }

  /** `POST /channels/:documentId/send` — `payload` — the frame's JSON text — rides opaque, exactly as `framing.ts`'s own doc comment requires: this class never parses it, only the bridge's envelope carries `documentId` for routing (SPECIFICATION.md §13.1). */
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

  /** `GET /channels/:documentId/deliveries` — the bridge's own cumulative, bounded buffer (TRN-7, BRG-17), matching `InMemoryMessengerPort.receive()`'s existing "full history, caller dedups" contract. */
  async receive(documentId: DocumentId, member: MemberId): Promise<readonly Delivery[]> {
    const response = await fetch(
      `${this.#bridgeUrl}/channels/${encodeURIComponent(documentId)}/deliveries?member=${encodeURIComponent(member)}`,
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
}

/**
 * Where this page's bridge is: a `?bridge=http://localhost:8788` query-string override
 * first, then the build-time `VITE_MATRIX_BRIDGE_URL`, then the bridge's default port.
 * The query string exists because a build-time setting is one value for every page
 * load, while two people converging on one document each point their own page at their
 * *own* bridge.
 *
 * Whatever chose it, the URL must be a bridge on this machine (`isLoopbackUrl`, from
 * `@tdsp/loopback`; SPECIFICATION.md ARC-2). `?bridge=` is attacker-reachable in
 * practice: an application that sends invitation links into chat rooms lets any room
 * member post a link of exactly the shape people are used to clicking, with
 * `&bridge=https://evil.tld` appended — which would otherwise send every document
 * frame, member id and payload there instead of to the local bridge.
 */

function resolveBridgeUrl(): string {
  if (typeof window !== "undefined") {
    const fromQuery = new URLSearchParams(window.location.search).get("bridge");
    if (fromQuery && fromQuery.length > 0) {
      // Loud, never a silent fallback to the default: silently ignoring a
      // rejected override would leave a tampered link looking like it
      // simply worked, which is the one outcome that hides the attack.
      if (!isLoopbackUrl(fromQuery)) {
        throw new Error(
          `Refusing the ?bridge= override "${fromQuery}": this adapter only ever connects to a ` +
            "bridge on this machine (localhost, 127.0.0.0/8 or ::1). A link pointing anywhere else " +
            "would send this document's contents to that host — see docs/network-policy.md.",
        );
      }
      return fromQuery;
    }
  }
  const configured = import.meta.env?.VITE_MATRIX_BRIDGE_URL as string | undefined;
  if (configured && configured.length > 0) {
    // Build-time, so far less exposed than ?bridge= above — but Zone A's
    // rule is about the destination, not about who chose it, and a build
    // configured against a remote bridge would break the promise just as
    // completely.
    if (!isLoopbackUrl(configured)) {
      throw new Error(
        `Refusing VITE_MATRIX_BRIDGE_URL "${configured}": this adapter only ever connects to a ` +
          "bridge on this machine (localhost, 127.0.0.0/8 or ::1) — see " +
          "docs/network-policy.md.",
      );
    }
    return configured;
  }
  return "http://localhost:8788";
}

export const matrixMessengerProvider: MessengerProvider = {
  id: "matrix",
  displayName: "Matrix (via bridges/matrix-bridge)",
  async createPort() {
    return new MatrixMessengerPort(resolveBridgeUrl());
  },
};

export {
  describeMatrixIntegrityEntry,
  type IntegrityEntry,
  type IntegrityReason,
  type IntegritySeverity,
  summarizeMatrixIntegrity,
} from "./integrity.ts";
