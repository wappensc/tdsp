import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import type {
  Delivery,
  DeliveryId,
  DocumentId,
  MemberId,
  MessengerPort,
  RawChannel,
} from "@tdsp/messenger-port";
import { encodeUpdate, getPlainText, insertPlainText } from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURRENT_FRAME_VERSION, decodeFrame, encodeResyncResponseFrame } from "./framing";
import { DocumentEngine, type PersistedControlState } from "./index";

/**
 * What silences a member waiting for its turn to answer a request to all (RSY-20): only the last
 * piece of an answer that holds what the member would give. A member with content no answer holds
 * is not silenced — not by a first piece of another answer, which states nothing while its other
 * pieces are under way (RSY-18) —, so what only it holds reaches the requester.
 * Security tests: only the CI role may change this file (.github/CODEOWNERS, CONTRIBUTING.md).
 */

// The engine's random ids — its stream (LOS-13), then its requests' ids (RSY-16) — taken from this
// queue while it holds any: Carol's turn on the request to all then lies 13 s after she heard it.
const ids = vi.hoisted(() => ({ queue: [] as string[] }));
vi.mock("./framing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./framing")>();
  return { ...actual, newRandomId: () => ids.queue.shift() ?? actual.newRandomId() };
});

const DOC = "doc-1";
const OPTS = { batchWindowMs: 0, resyncResponseThrottleMs: 0, creatorMemberId: "alice" };
/** The request to all, and Carol's stream: in a window of 30 s her turn comes 13 037 ms after she heard it (Appendix B). */
const REQUEST_TO_ALL = "c41d07e9a2b85f36";
const CAROL_STREAM = "0c4f9a2be81d7365";

/** The in-memory transport, with a member that sees nothing sent before a point, as a new Signal device. */
class Port implements MessengerPort {
  readonly inner = new InMemoryMessengerPort();
  readonly #hidden = new Map<MemberId, Set<DeliveryId>>();

  async hideHistoryFrom(member: MemberId): Promise<void> {
    const hidden = this.#hidden.get(member) ?? new Set();
    for (const delivery of await this.inner.receive(DOC, member)) hidden.add(delivery.id);
    this.#hidden.set(member, hidden);
  }
  createDocument(documentId: DocumentId, creator: MemberId): Promise<void> {
    return this.inner.createDocument(documentId, creator);
  }
  send(documentId: DocumentId, sender: MemberId, payload: string): Promise<DeliveryId> {
    return this.inner.send(documentId, sender, payload);
  }
  async receive(documentId: DocumentId, member: MemberId): Promise<readonly Delivery[]> {
    const hidden = this.#hidden.get(member);
    const all = await this.inner.receive(documentId, member);
    return hidden === undefined ? all : all.filter((delivery) => !hidden.has(delivery.id));
  }
  listChannels(member: MemberId): Promise<readonly RawChannel[]> {
    return this.inner.listChannels(member);
  }
}

async function run(ms: number, engines: readonly DocumentEngine[]): Promise<void> {
  for (let passed = 0; passed < ms; passed += 1_000) {
    await vi.advanceTimersByTimeAsync(1_000);
    for (const engine of engines) {
      await engine.sync();
      await vi.advanceTimersByTimeAsync(0);
    }
  }
}

/** Who answered `requestId`, one entry per answer, whatever pieces it came in. */
async function answerersOf(port: Port, requestId: string): Promise<MemberId[]> {
  const answers = new Map<string, MemberId>();
  for (const delivery of await port.inner.receive(DOC, "observer")) {
    const frame = decodeFrame(delivery.payload);
    if (frame.kind === "resync-response" && frame.respondsTo === requestId) {
      answers.set(`${delivery.sender}:${frame.stream}:${frame.sequence}`, delivery.sender);
    }
  }
  return [...answers.values()];
}

/**
 * The creator's only device holds "Plan"; while it is away Carol writes " (Carol)", which reaches no
 * one else. The device returns with what it persisted — its document unbound meanwhile —, and its
 * first request asks all (RSY-21). `before` then sends what reaches the channel before Carol's turn;
 * two minutes pass.
 */
async function aliceReturns(
  before: (port: Port, carol: DocumentEngine) => Promise<void>,
): Promise<{ port: Port; back: DocumentEngine; answerers: MemberId[] }> {
  const port = new Port();
  const alice = await DocumentEngine.create(DOC, "alice", port, undefined, OPTS);
  await alice.setMembership("carol", "write");
  alice.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
  ids.queue.push(CAROL_STREAM);
  const carol = await DocumentEngine.join(DOC, "carol", port, undefined, OPTS);
  await run(3_000, [alice, carol]);
  expect(carol.hasCompletedBootstrap).toBe(true);
  const control: PersistedControlState = {
    tdsp: CURRENT_FRAME_VERSION,
    profile: alice.profile,
    control: { closed: alice.controlState.closed, targets: alice.controlState.targets },
    device: alice.deviceTag,
    clock: alice.controlClock,
    bootstrapped: true,
  };
  const state = encodeUpdate(alice.document);
  alice.dispose();
  port.inner.disconnect("alice");
  carol.edit((fragment) => insertPlainText(fragment, 4, " (Carol)"));
  await run(2_000, [carol]);
  port.inner.reconnect("alice");
  await port.hideHistoryFrom("alice");
  // Its stream, then its first request's id.
  ids.queue.push("7e0d5b31a9c4f286", REQUEST_TO_ALL);
  const back = await DocumentEngine.join(DOC, "alice", port, undefined, {
    ...OPTS,
    autoResync: false,
    controlState: control,
    restore: { state, rebound: true },
  });
  expect(ids.queue).toStrictEqual([]);
  await before(port, carol);
  await run(2 * 60_000, [carol, back]);
  return { port, back, answerers: await answerersOf(port, REQUEST_TO_ALL) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-28T10:00:00Z"));
  ids.queue.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("what silences a member waiting for its turn (RSY-20)", () => {
  it("Carol answers at her turn and what only she holds reaches the returning device", async () => {
    const { back, answerers } = await aliceReturns(async () => {});
    expect(answerers).toStrictEqual(["carol"]);
    expect(getPlainText(back.fragment)).toBe("Plan (Carol)");
  });

  it("a first piece of Dave's answer, whose other pieces are still under way, states nothing and silences her not", async () => {
    const { back, answerers } = await aliceReturns(async (port) => {
      await port.send(
        DOC,
        "dave",
        encodeResyncResponseFrame({
          documentId: DOC,
          respondsTo: REQUEST_TO_ALL,
          update: new Uint8Array([0, 0]),
          piece: 1,
        }),
      );
    });
    expect(answerers).toStrictEqual(["dave", "carol"]);
    expect(getPlainText(back.fragment)).toBe("Plan (Carol)");
  });
});
