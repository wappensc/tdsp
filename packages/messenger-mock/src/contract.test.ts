import { messengerPortContractCases } from "@tdsp/messenger-port/contract";
import { describe, it } from "vitest";
import { InMemoryMessengerPort } from "./index.ts";

/**
 * Runs the shared `MessengerPort` contract (SPECIFICATION.md §3.6) against the mock. Each
 * bridge's own contract test runs the exact same cases against its real messenger — the
 * point of a shared suite is that both files import the same cases
 * rather than each writing (and silently drifting from) their own.
 *
 * One `InMemoryMessengerPort` instance serves as both `creatorPort` and
 * `memberPort` — unlike Matrix, where each identity is genuinely a
 * separate bridge process, the mock has no such split to preserve; a
 * single shared instance is simply two different `MemberId`s calling the
 * same object, which is exactly what the rest of this package's own
 * tests already assume.
 */
describe("MessengerPort contract (mock)", () => {
  let counter = 0;
  for (const { name, run } of messengerPortContractCases) {
    it(name, async () => {
      const port = new InMemoryMessengerPort();
      await run({
        documentId: `contract-doc-${counter++}`,
        creatorPort: port,
        creatorId: "contract-creator",
        memberPort: port,
        memberId: "contract-member",
      });
    });
  }
});
