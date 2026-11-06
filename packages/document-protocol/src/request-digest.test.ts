import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import {
  applyUpdate,
  createDocument,
  deletePlainText,
  encodeDeletions,
  encodeStateVector,
  encodeUpdate,
  getFragment,
  getPlainText,
  insertPlainText,
} from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { digestOf } from "./digest";
import { decodeFrame, encodeResyncRequestFrame, type ResyncResponseFrame } from "./framing";
import { DocumentEngine } from "./index";
import { registerStateDigest } from "./registers";

/**
 * RSY-17, its third case (SPECIFICATION.md RSY-17, LOS-12, LOS-24): a request whose state vector holds
 * every update the responder holds — the same, or more — is answered for content only where its state
 * digest differs from the responder's own, the digest of all it deleted. A responder that lacks
 * something the request's vector counts compares that whole digest too: the answer would carry its
 * whole record of deletions and nothing else, so with the same digest it has nothing to give, and with
 * another it may hold a deletion the requester lacks.
 */

const DOC = "doc-1";
const OPTS = { batchWindowMs: 0, resyncResponseThrottleMs: 0, creatorMemberId: "alice" };
const MINUTE = 60_000;
const REQUEST = "d1d1d1d1d1d1d1d1";

/** Every engine polls every second for `ms`. */
async function run(ms: number, engines: readonly DocumentEngine[]): Promise<void> {
  for (let passed = 0; passed < ms; passed += 1_000) {
    await vi.advanceTimersByTimeAsync(1_000);
    for (const engine of engines) await engine.sync();
    await vi.advanceTimersByTimeAsync(0);
  }
}

/** Alice creates "Plan" and lets Bob and Carol write; both join and hold what she holds. */
async function group() {
  const port = new InMemoryMessengerPort();
  const alice = await DocumentEngine.create(DOC, "alice", port, undefined, OPTS);
  for (const member of ["bob", "carol"]) await alice.setMembership(member, "write");
  alice.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
  const bob = await DocumentEngine.join(DOC, "bob", port, undefined, OPTS);
  const carol = await DocumentEngine.join(DOC, "carol", port, undefined, OPTS);
  await run(MINUTE, [alice, bob, carol]);
  for (const engine of [bob, carol]) expect(getPlainText(engine.fragment)).toBe("Plan");
  return { port, alice, bob, carol };
}

/**
 * Dave's device, which none of them runs: it holds `state` and a change of its own nobody else got,
 * and asks all, stating that state and its creator's control state (RSY-16).
 */
async function daveAsks(port: InMemoryMessengerPort, state: Uint8Array, alice: DocumentEngine) {
  const dave = createDocument();
  applyUpdate(dave, state);
  insertPlainText(getFragment(dave), 0, "D ");
  await port.send(
    DOC,
    "dave",
    encodeResyncRequestFrame({
      documentId: DOC,
      requestId: REQUEST,
      controlClock: alice.controlClock,
      controlDigest: registerStateDigest(alice.controlState),
      all: true,
      force: false,
      stateVector: encodeStateVector(dave),
      stateDigest: digestOf(encodeDeletions(dave)),
      stream: "da7eda7eda7eda7e",
      sequence: 1,
    }),
  );
  return dave;
}

/** The answers to Dave's request, by who sent them. */
async function answers(
  port: InMemoryMessengerPort,
): Promise<{ sender: string; frame: ResyncResponseFrame }[]> {
  return (await port.receive(DOC, "observer"))
    .map((delivery) => ({ sender: delivery.sender, frame: decodeFrame(delivery.payload) }))
    .filter(
      (d): d is { sender: string; frame: ResyncResponseFrame } =>
        d.frame.kind === "resync-response" && d.frame.respondsTo === REQUEST,
    );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-26T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a request whose state vector holds more than the responder (RSY-17, third case)", () => {
  it("with the responder's own state digest gets no answer, from the creator at once or from a member at its turn", async () => {
    const { port, alice, bob, carol } = await group();
    // What each of them deleted is what Dave's request states: nothing.
    const dave = await daveAsks(port, encodeUpdate(bob.document), alice);
    expect(digestOf(encodeDeletions(dave))).toBe(digestOf(encodeDeletions(bob.document)));
    await run(2 * MINUTE, [alice, bob, carol]);
    expect(await answers(port)).toStrictEqual([]);
  });

  it("with another state digest gets an answer that carries the responder's deletion the requester lacks", async () => {
    const { port, alice, bob, carol } = await group();
    // Dave holds what Bob held before Carol's deletion, and more; the deletion reaches everyone else.
    const before = encodeUpdate(bob.document);
    carol.edit((fragment) => deletePlainText(fragment, 0, 1));
    await run(5_000, [alice, bob, carol]);
    expect(getPlainText(bob.fragment)).toBe("lan");
    const asking = await daveAsks(port, before, alice);
    await run(2 * MINUTE, [alice, bob, carol]);
    const got = await answers(port);
    expect(got.map((answer) => answer.sender)).toContain("alice");
    for (const answer of got) applyUpdate(asking, answer.frame.update);
    expect(getPlainText(getFragment(asking))).toBe("D lan");
  });
});
