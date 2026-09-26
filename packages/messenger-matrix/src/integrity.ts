import type { IntegritySeverity } from "@tdsp/messenger-port";

export type { IntegritySeverity };

/**
 * Everything `bridges/matrix-bridge` can reject a `.tdsp.frame` timeline event
 * for after it already routed to a bound document (SPECIFICATION.md BRG-12,
 * BRG-15: a messenger-native edit or withdrawal of an already-delivered
 * message is never applied, never re-parsed as a new message, and is
 * recorded as an integrity violation). Both shapes were confirmed against a
 * real local Synapse: an `m.replace` edit arrives as a new event carrying a
 * relation, and a redaction empties the original event's content in
 * `/sync`'s own timeline, not only on a direct fetch.
 *
 * `"message-edited"`: an incoming event on the `de.wappensc.together.tdsp.frame`
 * type carries `m.relates_to: {rel_type: "m.replace", ...}` — legitimate
 * tdsp traffic never uses that relation (a real edit is a new CRDT update,
 * sent as its own ordinary frame), so its presence alone is the signal.
 * `"message-redacted"`: an `m.room.redaction` event's `redacts` field names
 * an event id this bridge has already recorded as a delivery, or the
 * redacted event's own `unsigned.redacted_because` shows it never carried
 * real content by the time this bridge first saw it.
 */
export type IntegrityReason = "message-edited" | "message-redacted";

export interface IntegrityEntry {
  readonly eventId: string;
  readonly sender: string;
  readonly reason: IntegrityReason;
}

export function describeMatrixIntegrityEntry(entry: IntegrityEntry): {
  readonly severity: IntegritySeverity;
  readonly text: string;
} {
  const who = entry.sender || "an unknown sender";
  switch (entry.reason) {
    case "message-edited":
      return {
        severity: "alert",
        text: `A message from ${who} was edited after it was sent (Matrix's own m.replace). The edit was not applied — an already-delivered document update cannot be retracted or silently replaced.`,
      };
    case "message-redacted":
      return {
        severity: "alert",
        text: `A message from ${who} was redacted (deleted) after it was sent. If it was already applied here, that cannot be undone; if a peer had not yet seen it, they never will through this event — check with them directly.`,
      };
  }
}

/** The one-line banner over the integrity log; `null` when nothing was rejected. Mirrors `packages/messenger-email/src/integrity.ts`'s own `summarizeIntegrity` — kept adapter-local since each adapter's reason union differs, not because the shape does. */
export function summarizeMatrixIntegrity(
  entries: readonly IntegrityEntry[],
): { readonly severity: IntegritySeverity; readonly text: string } | null {
  if (entries.length === 0) {
    return null;
  }
  const rejected = `${entries.length} incoming event${entries.length === 1 ? " was" : "s were"} rejected instead of applied`;
  return {
    severity: "alert",
    text: `${rejected} — every reason this bridge currently detects looks like an attempt to break this document's rules.`,
  };
}
