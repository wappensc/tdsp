import type { IntegritySeverity } from "@tdsp/messenger-port";

export type { IntegritySeverity };

/**
 * Everything `bridges/signal-bridge` can reject an incoming group message for
 * after routing (SPECIFICATION.md BRG-12, BRG-15). Both shapes were
 * confirmed against real linked accounts: a Signal edit arrives as a sibling
 * `envelope.editMessage` field, not a `dataMessage` at all — otherwise
 * indistinguishable from an ordinary receipt or typing indicator; a
 * remote-delete passes the `dataMessage`-is-an-object check but fails the
 * next one (`message` must be a string; a remote-delete's is `null`).
 *
 * `"message-edited"`: `signal-cli`'s own `send --edit-timestamp`.
 * `"message-remote-deleted"`: `signal-cli`'s own `remoteDelete`.
 */
export type IntegrityReason = "message-edited" | "message-remote-deleted";

export interface IntegrityEntry {
  readonly id: string;
  readonly sender: string;
  readonly reason: IntegrityReason;
}

export function describeSignalIntegrityEntry(entry: IntegrityEntry): {
  readonly severity: IntegritySeverity;
  readonly text: string;
} {
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
  }
}

/** The one-line banner over the integrity log; `null` when nothing was rejected. Mirrors `packages/messenger-email/src/integrity.ts`'s own `summarizeIntegrity` — kept adapter-local since each adapter's reason union differs, not because the shape does. */
export function summarizeSignalIntegrity(
  entries: readonly IntegrityEntry[],
): { readonly severity: IntegritySeverity; readonly text: string } | null {
  if (entries.length === 0) {
    return null;
  }
  const rejected = `${entries.length} incoming message${entries.length === 1 ? " was" : "s were"} rejected instead of applied`;
  return {
    severity: "alert",
    text: `${rejected} — every reason this bridge currently detects looks like an attempt to break this document's rules.`,
  };
}
