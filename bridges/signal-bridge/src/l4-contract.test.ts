import { messengerPortContractCases } from "@tdsp/messenger-port/contract";
import { SignalMessengerPort } from "@tdsp/messenger-signal";
import { describe, it } from "vitest";
// infra/ is test tooling, not a workspace package, so it is imported by relative path.
import { signalL4Ready } from "../../../infra/signal-l4/config.ts";

/**
 * L4 (docs/testing.md): the same `messengerPortContractCases` every adapter passes, here against
 * real production Signal — two real `bridges/signal-bridge` processes, each linked to its own real
 * account, already running where `L4_SIGNAL_BRIDGE_A`/`_B` say (infra/signal-l4/config.ts). The
 * test only talks to them over HTTP, as an application would; it never starts or links one.
 *
 * Skipped unless both are configured, reachable and linked, so it never runs by accident.
 *
 * It needs exactly one Signal group the two accounts share, found through `listChannels`: a
 * group carries no test marker, so with more than one it refuses rather than sending test
 * traffic into what might be a real conversation.
 */
const bridges = await signalL4Ready();
const available = bridges !== undefined;

describe.skipIf(!available)(
  "MessengerPort contract (Signal, live against real production Signal)",
  () => {
    let counter = 0;
    let sharedGroupId: string | undefined;

    async function resolveSharedGroupId(
      port: SignalMessengerPort,
      memberId: string,
    ): Promise<string> {
      if (sharedGroupId) {
        return sharedGroupId;
      }
      const channels = await port.listChannels(memberId);
      if (channels.length !== 1) {
        throw new Error(
          `expected exactly one shared Signal group between the two L4 test accounts, found ` +
            `${channels.length} — create a single throwaway group for the two of them`,
        );
      }
      sharedGroupId = channels[0]?.id;
      return sharedGroupId as string;
    }

    /**
     * One fresh `documentId` per case, bound onto the same shared group, reusing the two
     * long-lived bridges: a Signal device link is made once, not per test.
     */
    async function createFixture() {
      const documentId = `signal-l4-contract-${counter++}-${Date.now()}`;
      const creatorPort = new SignalMessengerPort(bridges?.creator as string);
      const memberPort = new SignalMessengerPort(bridges?.member as string);
      const [{ id: creatorId }, { id: memberId }] = await Promise.all([
        creatorPort.whoami(),
        memberPort.whoami(),
      ]);
      const groupId = await resolveSharedGroupId(creatorPort, creatorId);
      await Promise.all([
        creatorPort.bind(documentId, groupId, creatorId, "yjs-paragraphs/1"),
        memberPort.bind(documentId, groupId, creatorId, "yjs-paragraphs/1"),
      ]);
      return { documentId, creatorPort, creatorId, memberPort, memberId };
    }

    // Several real round trips per case; delivery over production Signal can take seconds
    // even once a group session exists.
    const CASE_TIMEOUT_MS = 60_000;

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
  },
);
