import { DocumentEngine } from "@tdsp/document-protocol";
import { getPlainText, insertPlainText } from "@tdsp/reconciliation";
import { afterAll, describe, expect, it } from "vitest";
import { hasTestMatrixHomeserver } from "../../../infra/matrix-testserver/health.ts";
import { type LivePair, livePairs } from "./live-pair.ts";

/**
 * The 2.0 engine over this repository's own Matrix bridge (L2, docs/testing.md): Alice and
 * Bob, each with a `DocumentEngine` on a `MatrixMessengerPort` of their own, each port on a
 * bridge of their own, both bridges on the local Synapse — every frame goes through the
 * bridges and the homeserver, nothing between the engines but the messenger (ARC-3).
 * The engine's own tests run against the in-memory transport (L0); this shows the same
 * engine bootstraps, converges and carries a decision over a real one.
 */
const available = await hasTestMatrixHomeserver();

/** Polls both engines, as an application does, until `done` holds or `timeoutMs` passed. */
async function syncUntil(
  engines: readonly DocumentEngine[],
  done: () => boolean,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("the engines did not get there in time");
    for (const engine of engines) await engine.sync();
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe.skipIf(!available)("the 2.0 engine over two Matrix bridges and a local Synapse", () => {
  const pairs = livePairs("engine");
  const engines: DocumentEngine[] = [];
  afterAll(async () => {
    for (const engine of engines) engine.dispose();
    await pairs.close();
  });

  async function start(pair: LivePair) {
    const alice = await DocumentEngine.create(pair.documentId, pair.creatorId, pair.creatorPort);
    engines.push(alice);
    await alice.setMembership(pair.memberId, "write"); // named before he joins (LIF-9)
    const bob = await DocumentEngine.join(
      pair.documentId,
      pair.memberId,
      pair.memberPort,
      undefined,
      {
        creatorMemberId: pair.creatorId,
      },
    );
    engines.push(bob);
    return { alice, bob };
  }

  it("bootstraps a joiner, converges concurrent edits, and carries a decision of the creator", async () => {
    const pair = await pairs.start();
    const { alice, bob } = await start(pair);

    // The joiner is bootstrapped by the creator's answer to its request (RSY-4, CTL-13).
    await syncUntil([alice, bob], () => bob.hasCompletedBootstrap);
    expect(bob.permissionOf(pair.memberId)).toBe("write");

    // Concurrent edits, each sent before the other arrived, converge (§3.3).
    alice.edit((fragment) => insertPlainText(fragment, 0, "hello "));
    bob.edit((fragment) => insertPlainText(fragment, 0, "world "));
    await Promise.all([alice.flush(), bob.flush()]);
    await syncUntil(
      [alice, bob],
      () =>
        getPlainText(alice.fragment) === getPlainText(bob.fragment) &&
        getPlainText(alice.fragment).includes("hello") &&
        getPlainText(alice.fragment).includes("world"),
    );

    // A decision of the creator reaches the member (§7).
    await alice.setMembership(pair.memberId, "read");
    await syncUntil([alice, bob], () => bob.permissionOf(pair.memberId) === "read");
    expect(alice.permissionOf(pair.memberId)).toBe("read");
  }, 120_000);
});
