import type { IntegritySeverity } from "@tdsp/messenger-port";

export type { IntegritySeverity };

/**
 * Everything `bridges/signal-bridge` can reject an incoming group message for
 * after routing (bindings/bridges.md BRG-12, BRG-15). Both shapes were
 * confirmed against real linked accounts: a Signal edit arrives as a sibling
 * `envelope.editMessage` field, not a `dataMessage` at all — otherwise
 * indistinguishable from an ordinary receipt or typing indicator; a
 * remote-delete passes the `dataMessage`-is-an-object check but fails the
 * next one (`message` must be a string; a remote-delete's is `null`).
 *
 * `"message-edited"`: `signal-cli`'s own `send --edit-timestamp`.
 * `"message-remote-deleted"`: `signal-cli`'s own `remoteDelete`.
 * `"message-replaced"`: another message under the id of one already delivered — the same
 * author and sent timestamp, other content.
 */
export type IntegrityReason = "message-edited" | "message-remote-deleted" | "message-replaced";

/** What a notice records (BRG-15): a recipient a send skipped as an identity to trust (SIG-4). */
export type NoticeReason = "recipient-untrusted";

/**
 * An entry of a document's integrity log (BRG-15): a violation, naming the message's id and its
 * sender, or a notice, naming the id of a message this bridge sent and the recipient it concerns.
 */
export type IntegrityEntry =
  | {
      readonly kind: "violation";
      readonly id: string;
      readonly sender: string;
      readonly reason: IntegrityReason;
    }
  | {
      readonly kind: "notice";
      readonly id: string;
      readonly recipient: string;
      readonly reason: NoticeReason;
    };

/**
 * The entries of `GET /channels/:documentId/integrity-log` as the bridge serves them. An entry
 * without `kind`, from a bridge of TDSP 1.x, is a violation (the local bridge interface); what is
 * not an object is no entry.
 */
export function readIntegrityLog(raw: unknown): readonly IntegrityEntry[] {
  if (!Array.isArray(raw)) {
    throw new Error("integrityLog: the bridge answered something that is not a list of entries");
  }
  return raw
    .filter(
      (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null,
    )
    .map(
      (entry): IntegrityEntry =>
        entry.kind === "notice"
          ? {
              kind: "notice",
              id: String(entry.id ?? ""),
              recipient: String(entry.recipient ?? ""),
              reason: entry.reason as NoticeReason,
            }
          : {
              kind: "violation",
              id: String(entry.id ?? ""),
              sender: String(entry.sender ?? ""),
              reason: entry.reason as IntegrityReason,
            },
    );
}

export function describeSignalIntegrityEntry(entry: IntegrityEntry): {
  readonly severity: IntegritySeverity;
  readonly text: string;
} {
  if (entry.kind === "notice") {
    const whom = entry.recipient || "a member";
    return {
      severity: "warning",
      text: `A message of yours did not reach ${whom}: your account does not trust their identity in Signal (their safety number changed, say). Verify it with them in Signal; until then they get nothing you write here.`,
    };
  }
  const who = entry.sender || "an unknown sender";
  switch (entry.reason) {
    case "message-edited":
      return {
        severity: "alert",
        text: `A message from ${who} was edited after it was sent (Signal's own message edit). The edit was not applied — an already-delivered document update cannot be retracted or silently replaced.`,
      };
    case "message-remote-deleted":
      return {
        severity: "alert",
        text: `A message from ${who} was remotely deleted after it was sent. If it was already applied here, that cannot be undone; if a peer had not yet seen it, they never will through this message — check with them directly.`,
      };
    case "message-replaced":
      return {
        severity: "alert",
        text: `A second message from ${who} arrived under the same id as one already delivered, with different content. It was not applied — an already-delivered document update cannot be replaced. Two devices of one account sending in the same millisecond would look the same; that is rare.`,
      };
  }
}

/** The one-line banner over the integrity log; `null` when nothing was rejected. Mirrors `packages/messenger-email/src/integrity.ts`'s own `summarizeIntegrity` — kept adapter-local since each adapter's reason union differs, not because the shape does. */
export function summarizeSignalIntegrity(
  entries: readonly IntegrityEntry[],
): { readonly severity: IntegritySeverity; readonly text: string } | null {
  const violations = entries.filter((entry) => entry.kind === "violation").length;
  const notices = entries.length - violations;
  if (violations === 0) {
    return notices === 0
      ? null
      : {
          severity: "warning",
          text: `${notices} member${notices === 1 ? " was" : "s were"} skipped by a message of yours: an identity your account does not trust yet.`,
        };
  }
  const rejected = `${violations} incoming message${violations === 1 ? " was" : "s were"} rejected instead of applied`;
  return {
    severity: "alert",
    text: `${rejected} — every reason this bridge currently detects looks like an attempt to break this document's rules.`,
  };
}
