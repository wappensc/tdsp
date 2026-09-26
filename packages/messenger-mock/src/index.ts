import {
  type Delivery,
  type DeliveryId,
  type DocumentId,
  type MemberId,
  type MessengerPort,
  type MessengerProvider,
  type RawChannel,
  type TransportProfile,
  TransportSendError,
} from "@tdsp/messenger-port";

/**
 * In-memory MessengerPort implementation for local development and tests.
 *
 * **A pure, open transport**: it registers documents and carries opaque payloads to whoever
 * asks — nothing else. It models neither channel membership nor document permissions:
 * membership of the underlying channel is the messenger's business and a person's to
 * configure, and permissions are application-level state that `document-protocol` tracks
 * from the creator's control frames. Resync requests are ordinary frames like any other.
 *
 * This is a functional test double, not a security boundary: it stores and can read
 * plaintext. It offers deterministic fault injection (delay, disconnect, duplicate/replay,
 * reorder, drop, modify) through the extra methods below the MessengerPort implementation —
 * mock-only capabilities, not part of MessengerPort, since a real messenger has no "drop this
 * message" API. Faults are deterministic and explicitly triggered, never probabilistic, so
 * tests stay reproducible.
 */
const MOCK_TRANSPORT_PROFILE: TransportProfile = {
  bounds: { minIntervalMs: null, maxBytes: null },
  profiles: [
    {
      id: "instant",
      label: "Instant",
      description: "No limit: a message after every typing pause.",
      values: {
        minIntervalMs: 0,
        maxIntervalMs: null,
        minChars: 0,
        maxChars: null,
        expectedLatencyMs: 0,
      },
    },
    {
      id: "slow",
      label: "Slow (test)",
      description: "At most one message every 2 seconds, as a rate-limited provider would force.",
      values: {
        minIntervalMs: 2_000,
        maxIntervalMs: 10_000,
        minChars: 0,
        maxChars: null,
        expectedLatencyMs: 3_000,
      },
    },
  ],
  defaultProfile: "instant",
};

export class InMemoryMessengerPort implements MessengerPort {
  #documents = new Set<DocumentId>();
  #deliveries = new Map<DocumentId, Delivery[]>();
  #nextDeliveryId = 0;
  // Raw, pre-existing messenger channels — deliberately a *separate* concept from
  // #documents: a real adapter's `listChannels` reflects channels a person already created
  // in their own messenger client, entirely independent of any document bound to one. The mock has no real external messenger to ask, so it
  // simulates this with its own small registry, seeded via `seedChannel()`
  // (mock-only, not part of MessengerPort) rather than auto-populated from
  // `createDocument` — auto-populating would make every mock document
  // trivially "pre-existing," defeating the point of testing the bind flow
  // against something that doesn't already know about the document.
  #rawChannels = new Map<string, { name: string; members: Set<MemberId> }>();

  // --- fault-injection state (mock-only) ---
  #disconnected = new Set<MemberId>();
  #frozenReceiveCount = new Map<string, number>(); // `${documentId}:${member}` -> deliveries.length at disconnect
  #heldNextSend = new Set<MemberId>();
  #held = new Map<DocumentId, Delivery[]>();
  #dropNextSend = new Set<MemberId>();
  #modifyNextSend = new Map<MemberId, (payload: string) => string>();

  // --- MessengerPort ---

  /**
   * Two send policies, so the policy path can be exercised without a real provider
   * (SPECIFICATION.md §3.5): `instant`, the default, is no limit at all; `slow` paces sends
   * the way a rate-limited provider would force, which lets an application's policy choice
   * and the creator's policy change be seen and tested locally. The mock imposes no bound of its own. A test double's
   * profile, not a claim about any messenger.
   */
  async transportProfile(): Promise<TransportProfile> {
    return MOCK_TRANSPORT_PROFILE;
  }

  async createDocument(documentId: DocumentId, _creator: MemberId): Promise<void> {
    if (!this.#documents.has(documentId)) {
      this.#documents.add(documentId);
      this.#deliveries.set(documentId, []);
    }
  }

  async send(documentId: DocumentId, sender: MemberId, payload: string): Promise<DeliveryId> {
    if (!this.#documents.has(documentId)) {
      // Not worth retrying: waiting does not make the document exist (§3.4).
      throw new TransportSendError("rejected", `unknown document: ${documentId}`);
    }
    if (this.#disconnected.has(sender)) {
      // The one send failure the mock can inject, and the retryable kind: reconnecting
      // ends it (§3.4).
      throw new TransportSendError("unavailable", `${sender} is disconnected`);
    }

    const id = String(this.#nextDeliveryId++);

    if (this.#dropNextSend.delete(sender)) {
      // the sender still gets a delivery id back (it does not know the
      // network dropped the message), but it never becomes visible.
      return id;
    }

    const modifier = this.#modifyNextSend.get(sender);
    this.#modifyNextSend.delete(sender);
    const effectivePayload = modifier ? modifier(payload) : payload;
    const delivery: Delivery = { id, documentId, sender, payload: effectivePayload };

    if (this.#heldNextSend.delete(sender)) {
      const held = this.#held.get(documentId) ?? [];
      held.push(delivery);
      this.#held.set(documentId, held);
    } else {
      this.#deliveries.get(documentId)?.push(delivery);
    }
    return id;
  }

  async receive(documentId: DocumentId, member: MemberId): Promise<readonly Delivery[]> {
    this.#requireDocument(documentId);
    const deliveries = this.#deliveries.get(documentId) ?? [];
    if (this.#disconnected.has(member)) {
      // frozen by disconnect() itself, not lazily here, so a delivery sent
      // after the disconnect can never leak into the frozen view merely
      // because receive() happened not to be called until after it arrived.
      const frozenCount = this.#frozenReceiveCount.get(`${documentId}:${member}`) ?? 0;
      return deliveries.slice(0, frozenCount);
    }
    return deliveries;
  }

  /**
   * Raw channels, not documents — see `#rawChannels`'s own comment. Returns only channels `seedChannel()` was told `member`
   * belongs to; empty until a test calls it, which is deliberate (nothing
   * "pre-exists" in a fresh mock, matching a fresh real messenger account
   * with no channels of its own).
   */
  async listChannels(member: MemberId): Promise<readonly RawChannel[]> {
    const channels: RawChannel[] = [];
    for (const [id, channel] of this.#rawChannels) {
      if (channel.members.has(member)) {
        channels.push({ id, name: channel.name });
      }
    }
    return channels;
  }

  // --- fault injection (mock-only, not part of MessengerPort) ---

  /** Simulates the member losing connectivity: their sends fail and their receive() view freezes now. */
  disconnect(member: MemberId): void {
    this.#disconnected.add(member);
    // freeze immediately, not on next receive() — otherwise a delivery
    // sent after this call but before the member's next receive() would
    // incorrectly leak into their "offline" view.
    for (const documentId of this.#documents) {
      const count = this.#deliveries.get(documentId)?.length ?? 0;
      this.#frozenReceiveCount.set(`${documentId}:${member}`, count);
    }
  }

  /** Simulates reconnection: sends succeed again and the next receive() catches up on everything missed. */
  reconnect(member: MemberId): void {
    this.#disconnected.delete(member);
    for (const key of [...this.#frozenReceiveCount.keys()]) {
      if (key.endsWith(`:${member}`)) {
        this.#frozenReceiveCount.delete(key);
      }
    }
  }

  /** The member's next send() is queued but withheld from receive() until releaseHeld(). Simulates delay. */
  holdNextSend(member: MemberId): void {
    this.#heldNextSend.add(member);
  }

  /**
   * Makes visible every delivery currently held for `documentId`, in
   * `order` (indices into the held list) if given, otherwise in the order
   * they were held. Passing a non-identity `order` simulates reordering.
   */
  releaseHeld(documentId: DocumentId, order?: readonly number[]): void {
    const held = this.#held.get(documentId) ?? [];
    this.#held.set(documentId, []);
    const released = order
      ? order.map((index) => held[index]).filter((d): d is Delivery => d !== undefined)
      : held;
    const deliveries = this.#deliveries.get(documentId);
    for (const delivery of released) {
      deliveries?.push(delivery);
    }
  }

  /** The member's next send() never becomes visible to anyone. Simulates a dropped message. */
  dropNextSend(member: MemberId): void {
    this.#dropNextSend.add(member);
  }

  /** The member's next send() is delivered with `modifier(payload)` instead of the original payload. */
  modifyNextSend(member: MemberId, modifier: (payload: string) => string): void {
    this.#modifyNextSend.set(member, modifier);
  }

  /** Re-appends an already-recorded delivery under the same id. Simulates a duplicate or a replay attack. */
  replay(documentId: DocumentId, deliveryId: DeliveryId): void {
    const deliveries = this.#deliveries.get(documentId) ?? [];
    const original = deliveries.find((delivery) => delivery.id === deliveryId);
    if (!original) {
      throw new Error(`no such delivery: ${deliveryId}`);
    }
    deliveries.push({ ...original });
  }

  /**
   * Registers a raw messenger channel as visible to
   * `members`, for `listChannels()` to return — the mock's substitute for
   * "a person already created this channel/group/room in their own
   * messenger client." Mock-only, not part of `MessengerPort`; a test
   * calls this to set up a binding scenario before exercising
   * `listChannels()`/`createDocument()` against it. Re-seeding an existing
   * `id` overwrites its name/members.
   */
  seedChannel(id: string, name: string, members: readonly MemberId[]): void {
    this.#rawChannels.set(id, { name, members: new Set(members) });
  }

  #requireDocument(documentId: DocumentId): void {
    if (!this.#documents.has(documentId)) {
      throw new Error(`unknown document: ${documentId}`);
    }
  }
}

/**
 * The mock as one `MessengerProvider` among several. `createPort()` and `faultInjection`
 * close over the *same* `port` instance, so that every participant an application shows on
 * one page, and every injected fault, act on one shared in-memory channel instead of being
 * split silently across isolated ports. In memory only: never shared across tabs or a
 * network.
 */
export const mockMessengerProvider: MessengerProvider = (() => {
  const port = new InMemoryMessengerPort();
  return {
    id: "mock",
    displayName: "In-memory mock (local/CI test double, no confidentiality)",
    async createPort(): Promise<MessengerPort> {
      return port;
    },
    faultInjection: {
      disconnect: (member: MemberId) => port.disconnect(member),
      reconnect: (member: MemberId) => port.reconnect(member),
      modifyNextSend: (member: MemberId, modifier: (payload: string) => string) =>
        port.modifyNextSend(member, modifier),
    },
  };
})();
