import type { BindRecord } from "./bind-store.ts";
import { normalizeAddress } from "./envelope.ts";
import type { GpgInvoker } from "./gpg-invoke.ts";

/**
 * How one participant's key, as the creator's invitation gave it, compares
 * with what *this user's own keyring* holds for that address (SPECIFICATION.md
 * EML-8). The document itself always uses the creator's key; this only tells
 * the user where their own knowledge disagrees, so that they can settle it
 * with the people involved — outside the application, deliberately (an
 * in-protocol acknowledgement could be suppressed by the same attacker).
 *
 * - `"match"` — the user's keyring holds the very same key for that address.
 * - `"missing-locally"` — it holds none. Normal for someone new; it means
 *   nothing independent backs this identity.
 * - `"different-locally"` — it holds a key for that address, but *not* the
 *   one the creator sent. Either the creator or the user has the wrong key,
 *   or an invitation was forged; nothing here can tell which. For the user's
 *   *own* address it would mean the document is unusable for them, but that
 *   case never gets this far: an invitation encrypted to a key they don't
 *   hold is refused when they try to join.
 *
 * Recomputed on every request, not stored: a user who imports the right key
 * afterwards sees the warning clear.
 */
export type KeyComparison = "match" | "missing-locally" | "different-locally";

export interface KeyReportEntry {
  readonly address: string;
  /** The key the creator's invitation gave this address — what the document uses. */
  readonly fingerprint: string;
  readonly isYou: boolean;
  readonly isCreator: boolean;
  readonly comparison: KeyComparison;
  /** Every usable key the user's own keyring holds for this address. */
  readonly localFingerprints: readonly string[];
}

export interface KeyReport {
  readonly ownFingerprint: string;
  readonly creator: string;
  readonly entries: readonly KeyReportEntry[];
}

export async function buildKeyReport(
  gpg: GpgInvoker,
  record: BindRecord,
  ownAddress: string,
): Promise<KeyReport> {
  const entries: KeyReportEntry[] = [];
  for (const address of record.recipients) {
    const fingerprint = record.pinnedFingerprints[normalizeAddress(address)] ?? "";
    const local = (await gpg.listKeys(address)).map((key) => key.fingerprint.toUpperCase());
    entries.push({
      address,
      fingerprint,
      isYou: normalizeAddress(address) === normalizeAddress(ownAddress),
      isCreator: normalizeAddress(address) === normalizeAddress(record.creatorMemberId),
      comparison:
        local.length === 0
          ? "missing-locally"
          : local.includes(fingerprint)
            ? "match"
            : "different-locally",
      localFingerprints: local,
    });
  }
  return {
    ownFingerprint: record.ownFingerprint ?? "",
    creator: record.creatorMemberId,
    entries,
  };
}
