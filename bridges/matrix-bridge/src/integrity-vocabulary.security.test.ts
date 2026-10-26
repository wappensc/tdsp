import type {
  IntegrityEntry as BrowserIntegrityEntry,
  IntegrityReason as BrowserIntegrityReason,
} from "@tdsp/messenger-matrix";
import { describe, expect, it } from "vitest";
import type { IntegrityEntry, IntegrityReason } from "./sync-state.ts";

/**
 * `IntegrityReason` (here) and its `packages/messenger-matrix` counterpart
 * are the same list, written down twice — the bridge may not import that
 * package in production source (a bridge and an adapter stay independent),
 * only here in a `.test.ts` file. Mirrors `bridges/email-bridge/src/
 * integrity-vocabulary.security.test.ts` exactly. A reason added to one and
 * forgotten in the other would reach the browser as a string the UI has no
 * wording for — this is a compile-time check; `pnpm run typecheck` fails
 * the moment the two unions differ in either direction.
 */
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameVocabulary: Equal<IntegrityReason, BrowserIntegrityReason> = true;
/** An entry has the shape the local bridge interface gives it (BRG-15), on both sides. */
const sameEntry: Equal<IntegrityEntry, BrowserIntegrityEntry> = true;

/**
 * The reasons bindings/bridges.md BRG-12's table gives for what a Matrix homeserver can present:
 * an `m.replace` edit, a redaction, and another event with other content under a delivered event's
 * id. The binding names no reasons of its own, so the list is exactly these; a reason missing here
 * would leave that case recorded under another reason's name, or not at all.
 */
type Brg12MatrixReason = "message-edited" | "message-redacted" | "message-replaced";
const brg12Vocabulary: Equal<IntegrityReason, Brg12MatrixReason> = true;

describe("matrix-bridge integrity-log vocabulary", () => {
  it("is the same list in the bridge and in the browser-side package", () => {
    expect(sameVocabulary).toBe(true);
  });

  it("is an entry of the same shape in the bridge and in the browser-side package (BRG-15)", () => {
    expect(sameEntry).toBe(true);
  });

  it("is BRG-12's reasons for what Matrix can present, message-replaced among them", () => {
    expect(brg12Vocabulary).toBe(true);
  });
});
