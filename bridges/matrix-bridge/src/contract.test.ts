import { messengerPortContractCases } from "@tdsp/messenger-port/contract";
import { afterAll, describe, it } from "vitest";
import { hasTestMatrixHomeserver } from "../../../infra/matrix-testserver/health.ts";
import { livePairs } from "./live-pair.ts";

/**
 * Runs the exact same `messengerPortContractCases` (SPECIFICATION.md §3.6)
 * `packages/messenger-mock/src/contract.test.ts` runs against the mock,
 * here against two real instances of this package's own server and a real
 * local Synapse (L2, docs/testing.md). `@tdsp/messenger-matrix` (a
 * devDependency for the live tests) is the browser-side client an
 * application ships; this is a real client talking to a real instance of
 * this real server, not raw `fetch()` calls the way `send-receive.test.ts`
 * exercises the routes -- reuses the two-identity setup of
 * `live-pair.ts` (real login, real bind, real `listen`) rather than a
 * drifting copy of it. Only the assertions differ: the shared contract
 * cases instead of this file's own hand-written ones.
 *
 * Unlike the mock's single shared instance
 * (`packages/messenger-mock/src/contract.test.ts`), Matrix genuinely
 * needs two separate `MatrixMessengerPort`s, each pointed at its own
 * bridge server, each backed by its own real account and its own
 * temp-dir crypto store -- this *is* the difference a contract worth
 * sharing has to survive.
 */
const available = await hasTestMatrixHomeserver();

describe.skipIf(!available)("MessengerPort contract (Matrix, live against a local Synapse)", () => {
  const pairs = livePairs("contract");
  afterAll(() => pairs.close());

  /**
   * One fresh pair of bridge servers per contract case, exactly like
   * `messengerPortContractCases`'s own doc comment asks for: one case's
   * state must never leak into the next.
   */
  async function createFixture() {
    const pair = await pairs.start();
    // Prime both sides' sync state before the case sends anything it
    // cares about -- send-receive.test.ts's own "first sync establishes
    // a baseline only" note.
    await Promise.all([
      pair.creatorPort.receive(pair.documentId, pair.creatorId),
      pair.memberPort.receive(pair.documentId, pair.memberId),
    ]);
    return pair;
  }

  // Real Synapse round trips, several per case (login x2, bind x2, plus
  // whatever the case itself does) -- comfortably past the 5s default,
  // matching this repo's other live-Matrix specs' own generous timeouts.
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
