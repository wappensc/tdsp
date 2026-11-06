import { messengerPortContractCases } from "@tdsp/messenger-port/contract";
import { afterAll, describe, it } from "vitest";
import { hasTestEmailServer } from "../../../infra/email-testserver/health.ts";
import { livePairs } from "./live-pair.ts";

/**
 * Runs the exact same `messengerPortContractCases` (SPECIFICATION.md §3.6) `packages/messenger-mock/src/
 * contract.test.ts` runs against the mock, here against two real
 * instances of this package's own server and a real local Greenmail
 * server (L2, docs/testing.md). `@tdsp/messenger-email` (a devDependency
 * for the live tests) is the browser-side client an application ships; this is a real
 * client talking to a real instance of this real server, set up by `live-pair.ts`.
 *
 * Unlike Matrix's `bind()` (both sides bind to the same pre-existing
 * room), email has no equivalent for the receiving side to validate
 * against — `startThread()` genuinely creates a new thread. Alice's
 * `startThread()` creates it and sends the one real invite email; Bob's
 * `joinThread()` registers his own bridge's bind-store entry for that
 * same thread, exactly as a participant who opens the invitation link
 * does — not a test-only shortcut, real adapter
 * capability both sides of this fixture actually exercise.
 */
const available = await hasTestEmailServer();

describe.skipIf(!available)("MessengerPort contract (email, live against a real Greenmail)", () => {
  const pairs = livePairs("contract");
  afterAll(() => pairs.close());

  /**
   * One fresh pair of bridge servers, and a fresh real thread, per
   * contract case — exactly like `messengerPortContractCases`'s own doc
   * comment asks for: one case's state must never leak into
   * the next case. Each case also gets its own fresh IMAP receivers, so
   * one case's messages are never confused with another's (the shared
   * `x-tdsp-document` header search already scopes this per
   * `documentId`, but a fresh receiver keeps the fixture as close to a
   * real two-participant setup as possible).
   */
  async function createFixture() {
    const pair = await pairs.start();
    // Prime both sides' sync state before the case sends anything it
    // cares about — bridges/matrix-bridge/src/contract.test.ts's own note.
    await Promise.all([
      pair.creatorPort.receive(pair.documentId, pair.creatorId),
      pair.memberPort.receive(pair.documentId, pair.memberId),
    ]);
    return pair;
  }

  // Real SMTP send + IMAP poll round trips, several per case — comfortably
  // past the 5s default, matching this repo's other live-Matrix specs'
  // own generous timeouts.
  const CASE_TIMEOUT_MS = 30_000;

  for (const { name, run } of messengerPortContractCases) {
    it(
      name,
      async () => {
        const fixture = await createFixture();
        await run(fixture);
      },
      CASE_TIMEOUT_MS,
    );
  }
});
