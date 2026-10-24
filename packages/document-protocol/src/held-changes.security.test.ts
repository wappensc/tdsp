import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import {
  applyUpdate,
  createDocument,
  encodeStateVector,
  encodeUpdate,
  encodeUpdateSince,
  getFragment,
  getPlainText,
  insertPlainText,
  observeUpdates,
  transact,
} from "@tdsp/reconciliation";
import { describe, expect, it } from "vitest";
import { DocumentEngine, type PersistedControlState, SendRefusedError } from "./index";

/**
 * What a person types while the engine would refuse the edit (SPECIFICATION.md CTL-13, CTL-42).
 * Typed into the engine's document, it can leave the device although the engine never sends
 * it as an edit: a non-creator answers a creator that restarts with its state since the
 * creator's (RSY-6, RSY-8), whatever its own permission and before its own bootstrap
 * (RSY-10). Held outside that document, as CTL-42 lets an application do, it leaves only once
 * the engine may edit, as a local edit the CRDT merges.
 * Security tests: only the CI role may change this file (.github/CODEOWNERS, CONTRIBUTING.md).
 */

const DOCUMENT_ID = "doc-1";
/** Sends and answers at once, so each test sees its effects without waiting. */
const AS_ALICE = { batchWindowMs: 0, resyncResponseThrottleMs: 0, creatorMemberId: "alice" };

async function settle(...engines: DocumentEngine[]): Promise<void> {
  for (let round = 0; round < 8; round++) {
    for (const engine of engines) {
      await engine.sync();
    }
  }
}

/** What an application persists of a document's content to show it after a restart (§6.3). */
function persisted(engine: DocumentEngine) {
  return { state: encodeUpdate(engine.document), attribution: engine.attribution.toJSON() };
}

/**
 * CTL-42's second way, as Appendix E describes it: the person types into a replica that
 * applies every update the engine's document applies; what the person typed reaches the
 * engine's document only through `release()`, once the engine may edit.
 */
function hold(engine: DocumentEngine) {
  const replica = createDocument();
  applyUpdate(replica, encodeUpdate(engine.document));
  observeUpdates(engine.document, (update) => applyUpdate(replica, update));
  return {
    type(index: number, text: string): void {
      transact(replica, () => insertPlainText(getFragment(replica), index, text));
    },
    get text(): string {
      return getPlainText(getFragment(replica));
    },
    release(): void {
      expect(engine.mayEdit, "a held change is applied only once the engine may edit").toBe(true);
      applyUpdate(engine.document, encodeUpdateSince(replica, encodeStateVector(engine.document)));
    },
  };
}

/**
 * Alice creates the document with "Plan" in it; Bob may write, Carol may read. Bob and Carol
 * stop, their applications keeping the content, and start again while Alice is away: neither
 * can be bootstrapped (RSY-6). `meanwhile` is what Alice did before she went away. Carol joins
 * first each time, so a creator that answers one request at a time answers hers first (RSY-9,
 * RSY-19).
 */
async function membersResumeWhileTheCreatorIsAway(
  meanwhile?: (alice: DocumentEngine) => Promise<void>,
) {
  const port = new InMemoryMessengerPort();
  const refusals = { bob: [] as string[], carol: [] as string[] };
  const refused = (who: "bob" | "carol") => (error: unknown) => {
    if (error instanceof SendRefusedError) refusals[who].push(error.reason);
  };

  // What Alice's application persists of her control state (CTL-26), as the engine hands it over.
  let aliceControl: PersistedControlState | undefined;
  const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, {
    ...AS_ALICE,
    onControlStateChange: (state) => {
      aliceControl = state;
    },
  });
  await alice.setMembership("bob", "write");
  await alice.setMembership("carol", "read");
  const carolBefore = await DocumentEngine.join(DOCUMENT_ID, "carol", port, undefined, AS_ALICE);
  const bobBefore = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, AS_ALICE);
  await settle(alice, bobBefore, carolBefore);
  alice.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
  await settle(alice, bobBefore, carolBefore);
  const bobContent = persisted(bobBefore);
  const carolContent = persisted(carolBefore);
  bobBefore.dispose();
  carolBefore.dispose();

  await meanwhile?.(alice);
  await alice.sync();
  const aliceContent = persisted(alice);
  port.disconnect("alice");
  alice.dispose();

  const carol = await DocumentEngine.join(DOCUMENT_ID, "carol", port, refused("carol"), {
    ...AS_ALICE,
    restore: carolContent,
  });
  const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, refused("bob"), {
    ...AS_ALICE,
    restore: bobContent,
  });
  await settle(bob, carol);
  expect(bob.mayEdit).toBe(false);
  expect(carol.mayEdit).toBe(false);

  return {
    bob,
    carol,
    refusals,
    /** Alice starts again with her persisted control state (CTL-26), and her content if kept. */
    creatorRestarts(
      withContent: boolean,
      options: { resyncResponseThrottleMs?: number } = {},
    ): Promise<DocumentEngine> {
      port.reconnect("alice");
      return DocumentEngine.join(DOCUMENT_ID, "alice", port, undefined, {
        ...AS_ALICE,
        ...options,
        controlState: aliceControl,
        ...(withContent ? { restore: aliceContent } : {}),
      });
    },
  };
}

describe("a change the engine refuses (CTL-13, CTL-42)", () => {
  describe("typed into the engine's document, it leaves the device in an answer to a creator that restarts (RSY-8, RSY-10)", () => {
    it("a reader's change", async () => {
      const { carol, refusals, creatorRestarts } = await membersResumeWhileTheCreatorIsAway();
      carol.edit((fragment) => insertPlainText(fragment, 4, " (Carol)"));
      await settle(carol);
      expect(refusals.carol).not.toStrictEqual([]); // never sent as an edit

      const alice = await creatorRestarts(false);
      await settle(carol, alice);

      expect(carol.permissionOf("carol")).toBe("read");
      expect(getPlainText(alice.fragment)).toBe("Plan (Carol)");
    });

    it("a change made after the close", async () => {
      const { bob, refusals, creatorRestarts } = await membersResumeWhileTheCreatorIsAway((alice) =>
        alice.closeDocument(),
      );
      bob.edit((fragment) => insertPlainText(fragment, 4, " am Freitag"));
      await settle(bob);
      expect(refusals.bob).not.toStrictEqual([]);

      const alice = await creatorRestarts(true);
      await settle(bob, alice);

      expect(alice.closed).toBe(true);
      expect(getPlainText(alice.fragment)).toBe("Plan am Freitag"); // changed after the close (LIF-6)
    });

    it("a change of a member the creator made read-only meanwhile, before that member's bootstrap", async () => {
      const { bob, refusals, creatorRestarts } = await membersResumeWhileTheCreatorIsAway((alice) =>
        alice.setMembership("bob", "read"),
      );
      bob.edit((fragment) => insertPlainText(fragment, 4, " am Freitag"));
      await settle(bob);
      // `read-only` already: the in-memory transport shows Bob the demotion from its history.
      expect(refusals.bob).toStrictEqual(["read-only"]);

      // Alice answers one request a minute, Carol's first: Bob waits for his bootstrap.
      const alice = await creatorRestarts(false, { resyncResponseThrottleMs: 60_000 });
      await settle(bob, alice);

      expect(bob.hasCompletedBootstrap).toBe(false);
      expect(alice.permissionOf("bob")).toBe("read");
      expect(getPlainText(alice.fragment)).toBe("Plan am Freitag");
    });
  });

  describe("held outside the engine's document, it reaches no one before the engine may edit", () => {
    it("a reader's held change stays on the device", async () => {
      const { carol, creatorRestarts } = await membersResumeWhileTheCreatorIsAway();
      const held = hold(carol);
      held.type(4, " (Carol)");

      const alice = await creatorRestarts(false);
      await settle(carol, alice);

      expect(carol.hasCompletedBootstrap).toBe(true);
      expect(carol.mayEdit).toBe(false);
      expect(getPlainText(alice.fragment)).toBe("Plan");
      expect(getPlainText(carol.fragment)).toBe("Plan");
      expect(held.text).toBe("Plan (Carol)");
    });

    it("a change held after the close stays on the device, and the closed document unchanged", async () => {
      const { bob, creatorRestarts } = await membersResumeWhileTheCreatorIsAway((alice) =>
        alice.closeDocument(),
      );
      const held = hold(bob);
      held.type(4, " am Freitag");

      const alice = await creatorRestarts(true);
      await settle(bob, alice);

      expect(bob.closed).toBe(true);
      expect(bob.mayEdit).toBe(false);
      expect(getPlainText(alice.fragment)).toBe("Plan");
      expect(held.text).toBe("Plan am Freitag");
    });

    it("the held change of a member the creator made read-only meanwhile stays on the device", async () => {
      const { bob, creatorRestarts } = await membersResumeWhileTheCreatorIsAway((alice) =>
        alice.setMembership("bob", "read"),
      );
      const held = hold(bob);
      held.type(4, " am Freitag");

      const alice = await creatorRestarts(false);
      await settle(bob, alice);

      expect(bob.permissionOf("bob")).toBe("read");
      expect(bob.mayEdit).toBe(false);
      expect(getPlainText(alice.fragment)).toBe("Plan");
    });

    it("a writer's held change, applied once its engine may edit, merges with the creator's concurrent edit and is the writer's", async () => {
      const { bob, creatorRestarts } = await membersResumeWhileTheCreatorIsAway();
      const held = hold(bob);
      held.type(4, " am Freitag");

      const alice = await creatorRestarts(true);
      alice.edit((fragment) => insertPlainText(fragment, 0, "Neu: "));
      await settle(bob, alice);
      expect(bob.mayEdit).toBe(true);
      expect(getPlainText(alice.fragment)).toBe("Neu: Plan"); // nothing before the release

      held.release();
      await settle(bob, alice);

      expect(getPlainText(alice.fragment)).toBe("Neu: Plan am Freitag");
      expect(getPlainText(bob.fragment)).toBe("Neu: Plan am Freitag");
      expect(alice.attribution.ranges).toContainEqual({ start: 9, end: 20, authorId: "bob" });
    });
  });
});
