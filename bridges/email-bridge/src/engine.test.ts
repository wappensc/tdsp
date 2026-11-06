import { DocumentEngine } from "@tdsp/document-protocol";
import { getPlainText, insertPlainText } from "@tdsp/reconciliation";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB } from "../../../infra/email-testserver/config.ts";
import {
  hasGpgBinary,
  type ProvisionedGpgHomes,
  provisionGpgHomesInChildProcess,
} from "../../../infra/email-testserver/gpg-homes.ts";
import { hasTestEmailServer } from "../../../infra/email-testserver/health.ts";
import { getBindRecord } from "./bind-store.ts";
import { type LivePair, livePairs } from "./live-pair.ts";

/**
 * The 2.0 engine over this repository's own email bridge (L2, docs/testing.md): Alice and
 * Bob, each with a `DocumentEngine` on an `EmailMessengerPort` of their own, each port on a
 * bridge of their own, both bridges on the local Greenmail — every frame goes out by SMTP
 * and comes back by IMAP, nothing between the engines but the messenger (ARC-3) — without PGP,
 * and with it, every frame signed and encrypted by real `gpg` (EML-3). The
 * engine's own tests run against the in-memory transport (L0); this shows the same engine
 * bootstraps, converges and carries a decision over a real one.
 */
const available = await hasTestEmailServer();

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

/** Starts Alice's and Bob's engines on a pair, Bob named a writer before he joins (LIF-9). */
async function start(pair: LivePair, engines: DocumentEngine[]) {
  const alice = await DocumentEngine.create(pair.documentId, pair.creatorId, pair.creatorPort);
  engines.push(alice);
  await alice.setMembership(pair.memberId, "write");
  const bob = await DocumentEngine.join(
    pair.documentId,
    pair.memberId,
    pair.memberPort,
    undefined,
    { creatorMemberId: pair.creatorId },
  );
  engines.push(bob);
  return { alice, bob };
}

/** A joiner bootstrapped, concurrent edits converged, a decision of the creator carried. */
async function bootstrapConvergeDecide(pair: LivePair, engines: DocumentEngine[]) {
  const { alice, bob } = await start(pair, engines);

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
}

describe.skipIf(!available)("the 2.0 engine over two email bridges and a local Greenmail", () => {
  const pairs = livePairs("engine");
  const engines: DocumentEngine[] = [];
  afterAll(async () => {
    for (const engine of engines) engine.dispose();
    await pairs.close();
  });

  it("bootstraps a joiner, converges concurrent edits, and carries a decision of the creator", async () => {
    await bootstrapConvergeDecide(await pairs.start(), engines);
  }, 120_000);
});

describe.skipIf(!available || !hasGpgBinary())(
  "the 2.0 engine over two email bridges, a local Greenmail and real gpg (PGP, EML-3)",
  () => {
    let keys: ProvisionedGpgHomes | undefined;
    let pairs: ReturnType<typeof livePairs> | undefined;
    const engines: DocumentEngine[] = [];
    beforeAll(() => {
      // In a child process: several key generations in one worker trip a gpg-agent quirk
      // (gpg-invoke.test.ts).
      keys = provisionGpgHomesInChildProcess([ALICE.address, BOB.address]);
      pairs = livePairs("engine-pgp", { pgp: keys });
    }, 120_000);
    afterAll(async () => {
      for (const engine of engines) engine.dispose();
      await pairs?.close();
      keys?.cleanup();
    });

    it("bootstraps a joiner, converges concurrent edits, and carries a decision of the creator, every frame signed and encrypted", async () => {
      const pair = await (pairs as ReturnType<typeof livePairs>).start();
      // Both bridges hold the document as a PGP one: they send nothing unsigned or unencrypted,
      // and take nothing that is not (EML-3).
      for (const path of [pair.bindStorePaths.creator, pair.bindStorePaths.member]) {
        expect(getBindRecord(path, pair.documentId)?.pgpEnabled).toBe(true);
      }
      await bootstrapConvergeDecide(pair, engines);
    }, 180_000);
  },
);
