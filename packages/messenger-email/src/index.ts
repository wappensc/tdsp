/**
 * network-policy: loopback — Zone A (docs/network-policy.md). Every fetch() below
 * targets bridges/email-bridge on this same machine; resolveBridgeUrl()
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
import {
  type IntegrityEntry,
  InviteRejectedError,
  isInviteRejectionReason,
  type MailStatus,
  type PgpKeys,
  type PgpStatus,
} from "./integrity.ts";

export {
  describeIntegrityEntry,
  describeInviteRejection,
  describeKeyComparison,
  describeKeyWarnings,
  describePgpStatus,
  formatFingerprint,
  type IntegrityEntry,
  type IntegrityReason,
  type IntegritySeverity,
  InviteRejectedError,
  type InviteRejectionReason,
  isInviteRejectionReason,
  type KeyComparison,
  type KeyReportEntry,
  type KeyWarning,
  type MailStatus,
  type PgpKeys,
  type PgpStatus,
  summarizeIntegrity,
} from "./integrity.ts";

/**
 * The browser-side half of the email adapter — a thin `fetch()` wrapper against
 * `bridges/email-bridge`'s local bridge interface (SPECIFICATION.md §12.6), never an
 * SMTP/IMAP client or `gpg` itself (both live in the bridge process). No `node:*`
 * imports, bundleable like every other package here, and shaped like the Matrix and
 * Signal adapters as far as email's real differences allow.
 *
 * Two structural differences from those adapters, both following from email itself
 * (SPECIFICATION.md §13.4):
 *
 * - {@link startThread} *creates* a fresh thread for a set of individually chosen
 *   participants; it never binds to an existing channel the way the Matrix and Signal
 *   `bind()` do, since email has no reliable, listable "existing channel" (mail
 *   threading is not fully reliable). The thread's invitation email — readable text
 *   with the invitation link, and for a PGP document the creator's signed and
 *   encrypted block of participants and keys — is sent as part of this call, so there
 *   is no separate `sendInvitation`: nothing is bound first that a later invitation
 *   could be sent into.
 * - {@link listChannels} is a genuine capability gap, not merely unimplemented — see
 *   its own doc comment below.
 *
 * Unit-tested against a fake bridge HTTP layer in `index.test.ts`; the real bridge is
 * exercised by `bridges/email-bridge`'s own contract and `pgp-live` tests.
 */
export class EmailMessengerPort implements MessengerPort {
  readonly #bridgeUrl: string;
  /**
   * Mirrors `MatrixMessengerPort`'s own `#boundDocuments` field —
   * {@link startThread} already records this server-side, so
   * `createDocument` needs no further bridge call. Also doubles as this
   * port instance's own record of `documentId`'s permanently closed
   * recipient list (the closed participant set, SPECIFICATION.md §13.4), though
   * the bridge, not this class, is what actually enforces it.
   */
  readonly #createdThreads = new Map<
    DocumentId,
    { recipients: readonly MemberId[]; creator: MemberId }
  >();

  constructor(bridgeUrl: string) {
    this.#bridgeUrl = bridgeUrl;
  }

  /**
   * Adapter-specific — deliberately **not** part of `MessengerPort`, like
   * `MatrixMessengerPort.bind`/`SignalMessengerPort.bind`. Unlike those,
   * this *creates* a brand-new thread rather than binding to an existing
   * one: the bridge sends the thread's own invite email (readable text with
   * the invitation link; for a PGP-enabled document, followed by the creator's
   * signed and encrypted block of participants and keys, EML-4) as part of
   * this call, records `recipients` as `documentId`'s
   * permanently closed distribution list (`setMembership`
   * can change permission among this exact set afterward, but can never
   * add or remove anyone from it), and returns the new thread's root
   * `Message-ID`. Must be called, successfully, before
   * `DocumentEngine.create()` for a given `documentId`.
   *
   * `inviteText` is optional; `bridges/email-bridge` falls back to a generic,
   * honest default message when it's absent, so the invite is never
   * silently empty. It may be a **function** of the thread's root
   * `Message-ID`, and that is how a invitation link can be complete: the
   * invite email's own `Message-ID` is produced by sending it, so it cannot
   * be read back into the text — instead this method chooses the id first
   * (see {@link generateThreadRootMessageId}), hands it to the function to
   * build the text, and sends the email with exactly that id
   * (`POST /threads`'s `threadRootMessageId`). Verified live to survive a
   * real SMTP server unchanged; a provider that rewrites `Message-ID` on
   * submission (unverified for real providers) would only degrade mail-client
   * threading, since nothing but `In-Reply-To`/`References` uses it.
   *
   * `pgpEnabled` opts this document into PGP — defaults to
   * `false` (no `gpg` involvement at all) when omitted. Every message is then
   * signed and encrypted, and **this call chooses every participant's key, once,
   * from the creator's own keyring** (EML-4) and sends them in the invitation:
   * it is refused, before anything is sent or stored, when a participant's key
   * is missing or ambiguous or the creator has no secret key. The creator must
   * be this bridge's own address — the invitation is signed with its key.
   */
  async startThread(
    documentId: DocumentId,
    recipients: readonly MemberId[],
    creator: MemberId,
    profile: string,
    inviteText?: string | ((threadRootMessageId: string) => string),
    pgpEnabled?: boolean,
    policy?: string,
  ): Promise<{ threadRootMessageId: string }> {
    const chosenThreadRoot = generateThreadRootMessageId(creator);
    const text = typeof inviteText === "function" ? inviteText(chosenThreadRoot) : inviteText;
    const response = await fetch(`${this.#bridgeUrl}/threads/${encodeURIComponent(documentId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        recipients,
        creator,
        profile,
        inviteText: text,
        pgpEnabled,
        threadRootMessageId: chosenThreadRoot,
        policy,
      }),
    });
    if (!response.ok) {
      throw new Error(
        `startThread(${documentId}) failed: ${response.status} ${await response.text()}`,
      );
    }
    this.#createdThreads.set(documentId, { recipients, creator });
    return (await response.json()) as { threadRootMessageId: string };
  }

  /**
   * Adapter-specific, like {@link startThread} — the receiving side's
   * counterpart: registers this bridge's own bind-store entry for a thread
   * `startThread()` already created elsewhere, without sending anything (the
   * creator's own `startThread()` call already sent the one invite email).
   *
   * **For a PGP-enabled document this reads and verifies the creator's
   * invitation** (SPECIFICATION.md EML-4, EML-5, EML-8): the bridge fetches the email named by
   * `threadRootMessageId` from this user's own mailbox, opens the signed and
   * encrypted block in it, and takes the document's participants and every
   * participant's key from *that* — `recipients`, `creator` and
   * `profile` are then only what the invitation link claims, and a
   * mismatch is refused. Refusal throws {@link InviteRejectedError} with a
   * reason the UI can put into words (`describeInviteRejection`); nothing is
   * stored. For a PGP-off document there is nothing to verify (email has no
   * server-side membership list to check, unlike Matrix's/Signal's own
   * `bind()`), so the link's fields are taken as given.
   *
   * Must be called, successfully, before `DocumentEngine.join()`.
   *
   * Resolves to the creator's initial send policy as the invitation carried it, when
   * there is one — for a PGP-enabled document that is the copy inside
   * the signed block, which is why it is worth preferring to the one in the invitation link.
   * An opaque short text: `document-protocol` reads it.
   */
  async joinThread(
    documentId: DocumentId,
    threadRootMessageId: string,
    recipients: readonly MemberId[],
    creator: MemberId,
    profile: string,
    pgpEnabled?: boolean,
  ): Promise<{ policy?: string }> {
    const response = await fetch(
      `${this.#bridgeUrl}/threads/${encodeURIComponent(documentId)}/join`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadRootMessageId,
          recipients,
          creator,
          profile,
          pgpEnabled,
        }),
      },
    );
    if (!response.ok) {
      const text = await response.text();
      const message = `joinThread(${documentId}) failed: ${response.status} ${text}`;
      let parsed: { reason?: unknown; sender?: unknown } | undefined;
      try {
        parsed = JSON.parse(text) as { reason?: unknown; sender?: unknown };
      } catch {
        parsed = undefined;
      }
      if (parsed !== undefined && isInviteRejectionReason(parsed.reason)) {
        throw new InviteRejectedError(
          parsed.reason,
          typeof parsed.sender === "string" ? parsed.sender : undefined,
          message,
        );
      }
      throw new Error(message);
    }
    this.#createdThreads.set(documentId, { recipients, creator });
    const body = (await response.json().catch(() => undefined)) as { policy?: unknown } | undefined;
    return typeof body?.policy === "string" ? { policy: body.policy } : {};
  }

  /**
   * Adapter-specific, like {@link startThread} — this bridge's own
   * `MemberId` is the configured mailbox's own address, never something
   * a caller picks. Returns `{ id }`, as every bridge's `/whoami` does
   * (SPECIFICATION.md §12.6).
   */
  async whoami(): Promise<{ id: MemberId }> {
    const response = await fetch(`${this.#bridgeUrl}/whoami`);
    if (!response.ok) {
      throw new Error(`whoami failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as { id: MemberId };
  }

  /**
   * Adapter-specific — where this document stands on PGP right now, for
   * an application's status line: `enabled` is whether *this document* has PGP
   * on, `gpgAvailable` whether the bridge found a `gpg` binary,
   * `missingKeysFor` who the keyring lacks a key for, and
   * `sendBlockedReason` the exact reason the bridge's pre-send guard (EML-3)
   * would refuse a send right now (missing, ambiguous or swapped key, no
   * secret key, no gpg) — `null` when sending is clear. `bridges/email-bridge`
   * enforces the block itself on {@link send}; this exists so the UI can
   * show the reason *before* an attempt rather than only after one fails.
   */
  async pgpStatus(documentId: DocumentId): Promise<PgpStatus> {
    const response = await fetch(
      `${this.#bridgeUrl}/pgp/status?documentId=${encodeURIComponent(documentId)}`,
    );
    if (!response.ok) {
      throw new Error(
        `pgpStatus(${documentId}) failed: ${response.status} ${await response.text()}`,
      );
    }
    return (await response.json()) as PgpStatus;
  }

  /**
   * Adapter-specific — the keys a PGP document uses, and where the user's own
   * keyring disagrees with them (SPECIFICATION.md EML-4, EML-8). Every participant's
   * fingerprint is the one the *creator's invitation* gave, which is what every
   * message of the document is signed and encrypted with; each comes with how it
   * compares with the key the user's own keyring holds for that address, so a
   * difference — the creator's mistake, the user's, or a forged invitation — is
   * shown, not hidden. The fingerprints are what people compare with each other
   * out of band: it is the only step that turns "the invitation said so" into
   * "we checked". Recomputed on every call.
   */
  async pgpKeys(documentId: DocumentId): Promise<PgpKeys> {
    const response = await fetch(
      `${this.#bridgeUrl}/pgp/keys?documentId=${encodeURIComponent(documentId)}`,
    );
    if (!response.ok) {
      throw new Error(`pgpKeys(${documentId}) failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as PgpKeys;
  }

  /**
   * Adapter-specific — whether the bridge can reach its mail server, and how it secures
   * each connection (TLS only, except to a mail server on this machine). `GET /mail/status` logs in to both servers
   * and sends nothing, so this is a real network round trip on the bridge's side: call it
   * to find out why a mailbox will not work, not on a timer.
   */
  async mailStatus(): Promise<MailStatus> {
    const response = await fetch(`${this.#bridgeUrl}/mail/status`);
    if (!response.ok) {
      throw new Error(`mailStatus failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as MailStatus;
  }

  /**
   * Adapter-specific — every inbound message the bridge rejected instead of
   * applying, with the reason (SPECIFICATION.md EML-2, EML-3, BRG-15). Email
   * needs this more than Signal/Matrix: there, a lower protocol layer absorbs a
   * malformed or undecryptable message before the bridge ever sees it, so nothing is left to show; here every such
   * message arrives as a real, parseable email that this system itself had
   * to judge, and silently dropping it would hide exactly what a user needs
   * to know. In-memory on the bridge — it resets when the bridge restarts.
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

  /**
   * Confirms the thread {@link startThread} already created, rather than
   * sending anything new — see that method's doc comment for why there
   * is nothing left to send at this point.
   */
  async createDocument(documentId: DocumentId, creator: MemberId): Promise<void> {
    const created = this.#createdThreads.get(documentId);
    if (!created) {
      throw new Error(
        `createDocument(${documentId}): no thread started yet — call startThread(documentId, recipients, creator, profile) first`,
      );
    }
    if (created.creator !== creator) {
      throw new Error(
        `createDocument(${documentId}): creator mismatch — thread started with creator "${created.creator}", called with "${creator}"`,
      );
    }
  }

  /**
   * **Capability gap, not merely unimplemented** (SPECIFICATION.md §13.4): email
   * has no listable, pre-existing channel the way a Matrix room or Signal group is —
   * every document creates its own fresh thread ({@link startThread}), so there is
   * nothing for a picker to list. Always empty, and an application should skip the
   * "pick an existing channel" step for email rather than show a picker that can never
   * have anything in it. No bridge call is made: there is nothing a request could
   * answer that this comment does not already say.
   */
  async listChannels(_member: MemberId): Promise<readonly RawChannel[]> {
    return [];
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
   * `POST /channels/:documentId/send` — `payload` — the frame's JSON text — rides opaque,
   * the same rule as every other adapter's own `send()`. The bridge may
   * also reject this call for the pre-send key-completeness guard
   * (EML-3 — a PGP document with a participant's key missing from its
   * keyring), surfaced here as a non-2xx like any
   * other rejection.
   */
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

  /**
   * `GET /channels/:documentId/deliveries` — the bridge's own cumulative
   * buffer, matching `InMemoryMessengerPort.receive()`'s existing "full
   * history, caller dedups" contract. Everything the bridge's integrity checks
   * reject (a recipient-header mismatch, a signature
   * that fails to verify, a message from outside the closed participant
   * set) is filtered out bridge-side — never surfaced as a `Delivery`
   * here at all.
   */
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
 * A fresh `Message-ID` for a new thread's invite: `<uuid@domain>`, the domain
 * taken from the creator's own address (a plausible, self-owned domain — the
 * usual shape of one a mail client would have generated) and, if that is
 * missing or not a plain hostname, `tdsp.invalid` (a reserved TLD
 * that can never collide with a real one). `crypto.randomUUID()` exists in
 * every browser's secure context (`localhost` is one) and in Node.
 */
export function generateThreadRootMessageId(creator: string): string {
  const domain = creator.split("@")[1];
  const host = domain && /^[A-Za-z0-9.-]{1,100}$/.test(domain) ? domain : "tdsp.invalid";
  return `<${crypto.randomUUID()}@${host}>`;
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
  const configured = import.meta.env?.VITE_EMAIL_BRIDGE_URL as string | undefined;
  if (configured && configured.length > 0) {
    if (!isLoopbackUrl(configured)) {
      throw new Error(
        `Refusing VITE_EMAIL_BRIDGE_URL "${configured}": this adapter only ever connects to a ` +
          "bridge on this machine (localhost, 127.0.0.0/8 or ::1) — see " +
          "docs/network-policy.md.",
      );
    }
    return configured;
  }
  return "http://localhost:8789";
}

export const emailMessengerProvider: MessengerProvider = {
  id: "email",
  displayName: "Email (via bridges/email-bridge)",
  async createPort() {
    return new EmailMessengerPort(resolveBridgeUrl());
  },
};
