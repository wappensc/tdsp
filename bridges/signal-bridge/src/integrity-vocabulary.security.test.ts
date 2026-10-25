import type {
  IntegrityEntry as BrowserIntegrityEntry,
  IntegrityReason as BrowserIntegrityReason,
  NoticeReason as BrowserNoticeReason,
} from "@tdsp/messenger-signal";
import { describe, expect, it } from "vitest";
import type { IntegrityEntry, IntegrityReason, NoticeReason } from "./sync-state.ts";

/**
 * `IntegrityReason` (here) and its `packages/messenger-signal` counterpart
 * are the same list, written down twice — the bridge may not import that
 * package in production source (a bridge and an adapter stay independent),
 * only here in a `.test.ts` file. Mirrors `bridges/email-bridge/src/
 * integrity-vocabulary.security.test.ts` and `bridges/matrix-bridge/src/
 * integrity-vocabulary.security.test.ts` exactly. A reason added to one and
 * forgotten in the other would reach the browser as a string the UI has no
 * wording for — this is a compile-time check; `pnpm run typecheck` fails
 * the moment the two unions differ in either direction.
 */
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameVocabulary: Equal<IntegrityReason, BrowserIntegrityReason> = true;
/** The notices SIG-4 names, and an entry of either kind, are the same on both sides (BRG-15). */
const sameNotices: Equal<NoticeReason, BrowserNoticeReason> = true;
const sameEntry: Equal<IntegrityEntry, BrowserIntegrityEntry> = true;

describe("signal-bridge integrity-log vocabulary", () => {
  it("is the same list in the bridge and in the browser-side package", () => {
    expect(sameVocabulary).toBe(true);
  });

  it("is the same notices, and an entry of the same shape, in the bridge and the browser-side package (BRG-15, SIG-4)", () => {
    expect(sameNotices).toBe(true);
    expect(sameEntry).toBe(true);
  });
});
