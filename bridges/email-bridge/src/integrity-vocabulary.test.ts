import type {
  InviteRejectionReason as BrowserInviteRejectionReason,
  KeyComparison as BrowserKeyComparison,
  KeyReportEntry as BrowserKeyReportEntry,
  IntegrityReason,
} from "@tdsp/messenger-email";
import { describe, expect, it } from "vitest";
import type { InviteRejectionReason } from "./invite.ts";
import type { KeyComparison, KeyReportEntry } from "./key-report.ts";
import type { RejectionReason } from "./sync-state.ts";

/**
 * `RejectionReason` (here) and `IntegrityReason` (in `packages/messenger-
 * email`, which the bridge may not be imported by) are the same list,
 * written down twice. A reason added to one and forgotten in the other would
 * reach the browser as a string the UI has no wording for. The assignment
 * below is a *compile-time* check — `pnpm run typecheck` fails the moment
 * the two unions differ in either direction — and the test only exists so
 * the file is picked up and the check has somewhere to live.
 */
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameVocabulary: Equal<RejectionReason, IntegrityReason> = true;

const sameInviteVocabulary: Equal<InviteRejectionReason, BrowserInviteRejectionReason> = true;
const sameComparisons: Equal<KeyComparison, BrowserKeyComparison> = true;
const sameKeyReportEntry: Equal<KeyReportEntry, BrowserKeyReportEntry> = true;

describe("integrity-log vocabulary", () => {
  it("is the same list in the bridge and in the browser-side package", () => {
    expect(sameVocabulary).toBe(true);
  });

  it("agrees on why an invitation can be refused, so every reason reaches the UI with wording", () => {
    expect(sameInviteVocabulary).toBe(true);
  });

  it("agrees on how a key is compared with the user's own keyring, and on the shape of one entry", () => {
    expect(sameComparisons).toBe(true);
    expect(sameKeyReportEntry).toBe(true);
  });
});
