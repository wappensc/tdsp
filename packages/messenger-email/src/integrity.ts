import type { IntegritySeverity, MemberId } from "@tdsp/messenger-port";

/**
 * What `GET /mail/status` reports: per connection, whether the login worked
 * and how it is secured. `"plaintext-loopback"` is possible only towards a server on the
 * bridge's own machine; a real provider is always `"implicit"` or `"starttls-required"`.
 */
export interface MailConnectionStatus {
  readonly ok: boolean;
  readonly error?: string;
  readonly tls: "implicit" | "starttls-required" | "plaintext-loopback";
}

export type MailStatus =
  | { readonly configured: false }
  | {
      readonly configured: true;
      readonly address: MemberId;
      readonly smtp: MailConnectionStatus;
      readonly imap: MailConnectionStatus;
    };

/** Where a document stands on PGP right now — see `EmailMessengerPort.pgpStatus`. */
export interface PgpStatus {
  readonly enabled: boolean;
  readonly gpgAvailable: boolean;
  readonly missingKeysFor: readonly MemberId[];
  readonly sendBlockedReason: string | null;
}

/**
 * The receive-side integrity log's vocabulary — every reason `bridges/email-bridge` can
 * have for rejecting an inbound message, and the human-readable wording an application
 * shows for each. Lives in this browser-side package (which `bridges/email-bridge` may not
 * import), so the union is written down twice, once here and once next to the code that
 * produces it (`bridges/email-bridge/src/sync-state.ts`'s `RejectionReason`); a
 * compile-time check in the bridge's own tests fails if the two ever drift.
 *
 * Membership and the document's close are control frames inside the payload, so the
 * *bridge* never sees a control message and cannot reject one: a control frame from
 * anyone but the creator is rejected one layer up, by `document-protocol`, which reports
 * it through its own error handler (`ControlFrameRejectedError`) rather than this log.
 */
export type IntegrityReason =
  | "recipient-list-mismatch"
  | "pgp-unsigned"
  | "pgp-unencrypted"
  | "pgp-undecipherable"
  | "pgp-signature-invalid"
  | "pgp-identity-changed"
  | "pgp-unavailable"
  | "pgp-disabled-locally"
  | "message-id-reused"
  | "message-too-large";

export interface IntegrityEntry {
  readonly messageId: string;
  /** The `From:` address as received — for a document without PGP, exactly as trustworthy as an unauthenticated header. */
  readonly sender: string;
  readonly reason: IntegrityReason;
}

// IntegritySeverity lives in @tdsp/messenger-port so that every adapter shares it, and is
// re-exported here. "alert" is for reasons that look like an attack or a deliberate attempt
// to break the document's rules; "warning" for ones far more likely a communication or
// configuration problem (damage in transit, a setting the participants disagree on). A
// message that decrypts but is not signed by the key the document holds for its sender is
// an alert: the document's keys are the invitation's, so there is no benign "the reader has
// not imported the key yet".
export type { IntegritySeverity };

export function describeIntegrityEntry(entry: IntegrityEntry): {
  readonly severity: IntegritySeverity;
  readonly text: string;
} {
  const who = entry.sender || "an unknown sender";
  switch (entry.reason) {
    case "recipient-list-mismatch":
      return {
        severity: "alert",
        text: `A message from ${who} was rejected: its recipient list doesn't match this document's participants, so it was either misdelivered or someone outside the document tried to take part.`,
      };
    case "pgp-unsigned":
      return {
        severity: "warning",
        text: `A message from ${who} carried no PGP signature, which this document requires. It was not applied.`,
      };
    case "pgp-unencrypted":
      return {
        severity: "alert",
        text: `A message from ${who} was signed but not encrypted, which this document requires. It was not applied.`,
      };
    case "pgp-undecipherable":
      return {
        severity: "warning",
        text: `An undecipherable message from ${who} was discarded — it may have been damaged in transit, or encrypted to a different key than yours.`,
      };
    case "pgp-signature-invalid":
      return {
        severity: "alert",
        text: `A message from ${who} was rejected: it opened, but it is not signed by the key this document holds for ${who} — so someone else is writing in their name, or their key is not the one the creator named in the invitation. It was not applied. Only a new document can change a participant's key.`,
      };
    case "pgp-identity-changed":
      return {
        severity: "alert",
        text: `A message claiming to be from ${who} was signed with a key other than the one pinned for them, so it may be impersonation — or their key changed. Verify their key out of band before trusting further messages. Rejected.`,
      };
    case "pgp-unavailable":
      return {
        severity: "warning",
        text: `A message from ${who} was rejected because this document uses PGP but the local bridge has nothing to open it with — no gpg, or no keyring of the document's own (a document created before those existed).`,
      };
    case "pgp-disabled-locally":
      return {
        severity: "warning",
        text: `A PGP-protected message from ${who} arrived, but PGP is switched off for this document on your side. Ask the participants to agree on one setting. Not applied.`,
      };
    case "message-too-large":
      return {
        severity: "warning",
        text: `A message from ${who} was larger than this bridge reads, so it was neither opened nor applied. A resync recovers what it carried.`,
      };
    case "message-id-reused":
      return {
        severity: "alert",
        text: `A message claiming to be from ${who} reused the Message-ID of an earlier one but carried different content — an attempt to edit or withdraw an already-delivered message, which cannot be honoured. It was not applied.`,
      };
  }
}

/**
 * How an application words a document's PGP state. `"blocked"` is the state in
 * which an application should not let the person type: a message that could not be
 * sent should be stopped at the keyboard, with the reason, not discovered as a
 * failed send afterwards (the bridge's pre-send guard, SPECIFICATION.md EML-3).
 */
export function describePgpStatus(status: PgpStatus): {
  readonly state: "off" | "ready" | "blocked";
  readonly text: string;
} {
  if (!status.enabled) {
    return {
      state: "off",
      text: "PGP is off for this document — an experimental mode outside the TDSP specification. Messages are neither encrypted nor signed: anyone on the mail path can read them, and a sender's name can be forged.",
    };
  }
  if (!status.gpgAvailable) {
    return {
      state: "blocked",
      text: "PGP is on for this document, but the local bridge found no gpg — nothing can be sent or opened until it does.",
    };
  }
  if (status.sendBlockedReason !== null) {
    return {
      state: "blocked",
      text: `PGP is on, but sending is blocked: ${status.sendBlockedReason}`,
    };
  }
  return {
    state: "ready",
    text: "PGP is on: every message is signed and encrypted to each participant's key — the keys the creator's invitation named — and only messages signed by the key pinned for their sender are applied. Who writes to whom, when and how much is still visible to mail servers, and there is no forward secrecy.",
  };
}

/** The one-line banner over the integrity log; `null` when nothing was rejected. */
export function summarizeIntegrity(
  entries: readonly IntegrityEntry[],
): { readonly severity: IntegritySeverity; readonly text: string } | null {
  if (entries.length === 0) {
    return null;
  }
  const alerts = entries.filter(
    (entry) => describeIntegrityEntry(entry).severity === "alert",
  ).length;
  const rejected = `${entries.length} incoming message${entries.length === 1 ? " was" : "s were"} rejected instead of applied`;
  if (alerts === 0) {
    return { severity: "warning", text: `${rejected}.` };
  }
  const attempt =
    entries.length === 1
      ? "it looks like an attempt"
      : `${alerts} of them ${alerts === 1 ? "looks like an attempt" : "look like attempts"}`;
  return {
    severity: "alert",
    text: `${rejected} — ${attempt} to break this document's rules.`,
  };
}

/**
 * Why a participant's bridge refused a PGP document's invitation when they tried
 * to join (SPECIFICATION.md EML-5, EML-8) — the creator's signed and encrypted block in
 * the thread's first email. Written down twice, like {@link IntegrityReason}, and
 * kept identical to `bridges/email-bridge/src/invite.ts`'s `InviteRejectionReason`
 * by `integrity-vocabulary.security.test.ts`.
 *
 * `"invite-not-found"` is the one that is not a rejection of anything received:
 * the invitation may simply not have arrived yet, and joining can be retried.
 */
export type InviteRejectionReason =
  | "invite-not-found"
  | "invite-not-from-creator"
  | "recipient-list-mismatch"
  | "invite-not-encrypted"
  | "invite-undecipherable"
  | "invite-unsigned"
  | "invite-signature-invalid"
  | "invite-malformed"
  | "invite-participants-mismatch"
  | "invite-key-set-invalid"
  | "invite-signer-not-creator"
  | "invite-creator-key-differs";

const INVITE_REASONS: ReadonlySet<string> = new Set<InviteRejectionReason>([
  "invite-not-found",
  "invite-not-from-creator",
  "recipient-list-mismatch",
  "invite-not-encrypted",
  "invite-undecipherable",
  "invite-unsigned",
  "invite-signature-invalid",
  "invite-malformed",
  "invite-participants-mismatch",
  "invite-key-set-invalid",
  "invite-signer-not-creator",
  "invite-creator-key-differs",
]);

export function isInviteRejectionReason(value: unknown): value is InviteRejectionReason {
  return typeof value === "string" && INVITE_REASONS.has(value);
}

/** Thrown by `EmailMessengerPort.joinThread` when the bridge refused the invitation — carries the reason, so the UI can say something more useful than the raw error. */
export class InviteRejectedError extends Error {
  readonly reason: InviteRejectionReason;
  /** The `From:` of the invitation, when one was found. */
  readonly sender: string | undefined;

  constructor(reason: InviteRejectionReason, sender: string | undefined, message: string) {
    super(message);
    this.name = "InviteRejectedError";
    this.reason = reason;
    this.sender = sender;
  }
}

export function describeInviteRejection(
  reason: InviteRejectionReason,
  sender?: string,
): { readonly severity: IntegritySeverity; readonly text: string } {
  const who = sender || "the creator";
  switch (reason) {
    case "invite-not-found":
      return {
        severity: "warning",
        text: "The invitation is not in your mailbox yet. Check that it has arrived — it can take a moment — and try again.",
      };
    case "invite-not-from-creator":
      return {
        severity: "alert",
        text: `This invitation was sent by ${who}, not by the creator named in the link. It was not accepted.`,
      };
    case "recipient-list-mismatch":
      return {
        severity: "alert",
        text: "This invitation's recipient list doesn't match the participants named in the link, so it was misdelivered or altered. It was not accepted.",
      };
    case "invite-not-encrypted":
      return {
        severity: "alert",
        text: "The link says this document uses PGP, but its invitation is not signed and encrypted — anyone on the mail path could have written it. It was not accepted.",
      };
    case "invite-undecipherable":
      return {
        severity: "alert",
        text: `You cannot open this invitation: it is encrypted to a key you do not hold, so the creator (${who}) has a different key for you than the one in your keyring. Settle this with them outside this application — until then you cannot join this document.`,
      };
    case "invite-unsigned":
      return {
        severity: "alert",
        text: "This invitation carries no PGP signature, which a PGP document requires. It was not accepted.",
      };
    case "invite-signature-invalid":
      return {
        severity: "alert",
        text: "This invitation's signature could not be verified against the keys it carries, so it may have been altered. It was not accepted.",
      };
    case "invite-malformed":
      return {
        severity: "alert",
        text: "This is not a well-formed invitation to this document. It was not accepted.",
      };
    case "invite-participants-mismatch":
      return {
        severity: "alert",
        text: "What the creator signed — who takes part, who the creator is — does not match the link and the mail it came in. It was not accepted.",
      };
    case "invite-key-set-invalid":
      return {
        severity: "alert",
        text: "The keys in this invitation are not exactly the ones the creator signed for, so one person could be mistaken for another. It was not accepted.",
      };
    case "invite-signer-not-creator":
      return {
        severity: "alert",
        text: `This invitation is validly signed, but not by the key listed for its creator (${who}) — someone else is speaking in their name. It was not accepted.`,
      };
    case "invite-creator-key-differs":
      return {
        severity: "alert",
        text: `Your keyring holds a different key for the creator (${who}) than the one this invitation names, so either the invitation is forged or one of you has a wrong key. It was not accepted. Compare fingerprints with ${who} outside this application, in person or by phone.`,
      };
  }
}

/**
 * How one participant's key, as the creator's invitation gave it, compares with
 * what the *user's own keyring* holds for that address (`GET /pgp/keys`). See
 * `bridges/email-bridge/src/key-report.ts` for what each means and why the
 * comparison is recomputed on every request.
 */
export type KeyComparison = "match" | "missing-locally" | "different-locally";

export interface KeyReportEntry {
  readonly address: MemberId;
  readonly fingerprint: string;
  readonly isYou: boolean;
  readonly isCreator: boolean;
  readonly comparison: KeyComparison;
  readonly localFingerprints: readonly string[];
}

/** The keys a PGP document uses, with the comparison against the user's own keyring — or why there is nothing to compare. */
export type PgpKeys =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly gpgAvailable: false }
  | {
      readonly enabled: true;
      readonly gpgAvailable: true;
      readonly ownFingerprint: string;
      readonly creator: MemberId;
      readonly entries: readonly KeyReportEntry[];
    };

/** `AB12CD…` → `AB12 CD…` in groups of four, the way people read a fingerprint out loud to each other. */
export function formatFingerprint(fingerprint: string): string {
  return fingerprint.replace(/(.{4})/g, "$1 ").trim();
}

export interface KeyWarning {
  readonly severity: IntegritySeverity;
  readonly address: MemberId;
  readonly text: string;
}

/**
 * What the user must be told, in plain words, where their own keyring disagrees
 * with the creator's set. The document itself keeps using the creator's keys in
 * every case: a disagreement is settled between people, outside this application,
 * and this is the explicit notice that one exists. A key the user's keyring
 * simply lacks is normal for someone new and is *not* a warning — except for the
 * creator, whose missing key means nothing independent backs the invitation.
 */
export function describeKeyWarnings(keys: PgpKeys): readonly KeyWarning[] {
  if (!keys.enabled || !keys.gpgAvailable) {
    return [];
  }
  const warnings: KeyWarning[] = [];
  for (const entry of keys.entries) {
    if (entry.comparison === "different-locally") {
      const whose = entry.isYou ? "your own" : `${entry.address}'s`;
      warnings.push({
        severity: "alert",
        address: entry.address,
        text: `Your keyring holds a different key for ${entry.address} than the one ${keys.creator} sent. This document uses the creator's key (${formatFingerprint(entry.fingerprint)}); your keyring has ${entry.localFingerprints.map(formatFingerprint).join(" and ")}. Either ${keys.creator} or you has ${whose} wrong key, or the invitation was forged${entry.isCreator ? " — it claims to come from a creator whose key you already know, and it is not that one" : ""}. This application cannot tell which: settle it with ${entry.address} outside this application, by comparing fingerprints in person or by phone.`,
      });
    } else if (entry.comparison === "missing-locally" && entry.isCreator && !entry.isYou) {
      warnings.push({
        severity: "warning",
        address: entry.address,
        text: `First contact (trust on first use): your keyring does not hold ${entry.address}'s key, so nothing independent confirms that this invitation really came from them: this document trusts the key it carried (${formatFingerprint(entry.fingerprint)}). Compare that fingerprint with ${entry.address} outside this application, in person or by phone.`,
      });
    }
  }
  return warnings;
}

/** The short badge next to one key in the list. */
export function describeKeyComparison(entry: KeyReportEntry): string {
  switch (entry.comparison) {
    case "match":
      // Consistent with what the user held before — not a verification (SPECIFICATION.md
      // EML-8): a keyring holds keys however they got there.
      return "same key as in your keyring — consistent, not verified by this";
    case "missing-locally":
      return "not in your keyring";
    case "different-locally":
      return "DIFFERS from your keyring";
  }
}
