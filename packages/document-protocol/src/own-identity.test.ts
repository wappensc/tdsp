import assert from "node:assert/strict";
import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import type {
  Delivery,
  DeliveryId,
  DocumentId,
  MemberId,
  MessengerPort,
} from "@tdsp/messenger-port";
import { encodeUpdate, getPlainText, insertPlainText } from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFrame, type Frame, type ResyncRequestFrame } from "./framing";
import { DocumentEngine, type DocumentEngineOptions } from "./index";

/**
 * What a new device takes from an answer to someone else (SPECIFICATION.md RSY-12, RSY-13, RSY-14,
 * CTL-25, CTL-27): a device of the creator merges what the creator's answer to someone else brings, but is
 * bootstrapped, as anyone is, only by an answer to its own request — a device of the creator only by
 * another device of the creator's —, never by its own member's other device answering someone else,
 * nor by the creator's answer to someone else. A transport that
 * gives a new engine every message it holds brings such answers before anyone answers. Not a
 * security test: authority.security.test.ts holds what a member's snapshot must never do.
 */

const DOC = "doc-1";
const OPTS = { batchWindowMs: 0, resyncResponseThrottleMs: 0, creatorMemberId: "alice" };
/** 2026-10-27 10:00:00 UTC. */
const T = 1_793_095_200_000;

/** The in-memory transport, which gives every engine everything it holds, and can hide some of it from one member. */
class Port implements MessengerPort {
  readonly inner = new InMemoryMessengerPort();
  readonly #hidden = new Map<MemberId, Set<DeliveryId>>();
  #loseNextFor: MemberId | undefined;

  /** The next message anyone sends never reaches `member`. */
  loseNextSendFor(member: MemberId): void {
    this.#loseNextFor = member;
  }
  /** What was sent so far reaches `member` only where `keep` says so. */
  async hideFrom(member: MemberId, keep: (frame: Frame) => boolean = () => false): Promise<void> {
    const hidden = this.#hidden.get(member) ?? new Set();
    for (const delivery of await this.inner.receive(DOC, member)) {
      if (!keep(decodeFrame(delivery.payload))) hidden.add(delivery.id);
    }
    this.#hidden.set(member, hidden);
  }
  createDocument(documentId: DocumentId, creator: MemberId): Promise<void> {
    return this.inner.createDocument(documentId, creator);
  }
  async send(documentId: DocumentId, sender: MemberId, payload: string): Promise<DeliveryId> {
    const id = await this.inner.send(documentId, sender, payload);
    if (this.#loseNextFor !== undefined) {
      const hidden = this.#hidden.get(this.#loseNextFor) ?? new Set();
      hidden.add(id);
      this.#hidden.set(this.#loseNextFor, hidden);
      this.#loseNextFor = undefined;
    }
    return id;
  }
  async receive(documentId: DocumentId, member: MemberId): Promise<readonly Delivery[]> {
    const hidden = this.#hidden.get(member);
    const all = await this.inner.receive(documentId, member);
    return hidden === undefined ? all : all.filter((delivery) => !hidden.has(delivery.id));
  }
  listChannels(member: MemberId) {
    return this.inner.listChannels(member);
  }
}

/** Every frame on the channel, with its sender, in the order sent. */
async function channel(port: Port): Promise<{ sender: MemberId; frame: Frame }[]> {
  return (await port.inner.receive(DOC, "observer")).map((delivery) => ({
    sender: delivery.sender,
    frame: decodeFrame(delivery.payload),
  }));
}

/** The requests `sender` made, in order. */
async function requestsOf(port: Port, sender: MemberId): Promise<ResyncRequestFrame[]> {
  return (await channel(port))
    .filter(({ sender: from, frame }) => from === sender && frame.kind === "resync-request")
    .map(({ frame }) => frame as ResyncRequestFrame);
}

/** Polls every engine every `step` ms for `ms`. */
async function run(ms: number, engines: DocumentEngine[], step = 1_000): Promise<void> {
  for (let passed = 0; passed < ms; passed += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - passed));
    for (const engine of engines) {
      await engine.sync();
      await vi.advanceTimersByTimeAsync(0);
    }
  }
}

/** Alice's first device creates "Plan" and lets Bob and Carol write; Bob's first device joins and is answered. */
async function group(port = new Port()) {
  const first = await DocumentEngine.create(DOC, "alice", port, undefined, OPTS);
  await first.setMembership("bob", "write");
  await first.setMembership("carol", "write");
  first.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
  const bob = await DocumentEngine.join(DOC, "bob", port, undefined, OPTS);
  await run(5_000, [first, bob]);
  expect(bob.hasCompletedBootstrap).toBe(true);
  return { port, first, bob };
}

const join = (port: Port, member: MemberId, options: DocumentEngineOptions = {}) =>
  DocumentEngine.join(DOC, member, port, undefined, { ...OPTS, ...options });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a new device of the creator and another device's answer to someone else (RSY-12, RSY-14)", () => {
  it("merges it as it reads the transport, content and control state, but is not bootstrapped by it: its repeats ask all, and a member's answer bootstraps it not either (CTL-27)", async () => {
    const { port, first, bob } = await group();
    first.dispose(); // the first device is away: nobody of the creator answers
    const newDevice = await join(port, "alice");
    expect(newDevice.controlStanding).toStrictEqual({ kind: "none" });
    expect(newDevice.hasCompletedBootstrap).toBe(false);
    expect(getPlainText(newDevice.fragment)).toBe("Plan");
    expect(newDevice.permissionOf("bob")).toBe("write");
    const stream = (await requestsOf(port, "alice")).at(-1)?.stream;
    await run(10 * 60_000, [bob, newDevice], 5_000);
    const asked = (await requestsOf(port, "alice")).filter((request) => request.stream === stream);
    expect(asked.length).toBeGreaterThanOrEqual(2);
    expect(asked.map((request) => request.all)).toStrictEqual([
      false,
      ...asked.slice(1).map(() => true),
    ]);
    expect(newDevice.controlStanding).toStrictEqual({ kind: "none" });
  });

  it("an answer to someone else whose content it does not hold all of bootstraps it not; what it lacks shows as evidence, and a member's answer brings it, but bootstraps it not either (CTL-27)", async () => {
    const { port, first, bob } = await group();
    // Bob misses " A", asks, and the first device answers him with what his state lacks.
    port.loseNextSendFor("bob");
    first.edit((fragment) => insertPlainText(fragment, 4, " A"));
    await run(1_000, [first, bob]);
    await bob.requestResync();
    const request = (await requestsOf(port, "bob")).at(-1);
    assert(request);
    await run(5_000, [first, bob]);
    expect(getPlainText(bob.fragment)).toBe("Plan A");
    first.dispose();
    // The new device reads that answer alone: control state, but not "Plan".
    await port.hideFrom(
      "alice",
      (frame) => frame.kind === "resync-response" && frame.respondsTo === request.requestId,
    );
    const newDevice = await join(port, "alice");
    expect(newDevice.controlStanding).toStrictEqual({ kind: "none" });
    expect(newDevice.hasCompletedBootstrap).toBe(false);
    // " A" waits for "Plan", which it lacks (LOS-2): evidence, whose repeat asks all, and Bob answers.
    await run(5_000, [bob, newDevice], 5_000);
    expect(newDevice.syncHealth.suspicions.map((suspicion) => suspicion.kind)).toContain(
      "pending-gap",
    );
    await run(10 * 60_000, [bob, newDevice], 5_000);
    expect(getPlainText(newDevice.fragment)).toBe("Plan A");
    expect(newDevice.hasCompletedBootstrap).toBe(false);
    expect(newDevice.syncHealth.suspicions).toStrictEqual([]);
  });
});

describe("a new device of a member and answers to someone else: only an answer to its own request bootstraps it (RSY-12, RSY-14, CTL-13)", () => {
  it("its other device's answer to someone else bootstraps nothing: it takes none of it, and a member's answer to its own request to all bootstraps it", async () => {
    const { port, first, bob } = await group();
    first.dispose(); // the creator is away
    const carol = await join(port, "carol");
    await run(3 * 60_000, [bob, carol], 5_000); // Bob answers Carol's request to all, at his turn
    expect(carol.hasCompletedBootstrap).toBe(true);
    bob.dispose(); // Bob's first device is away too
    const laptop = await join(port, "bob");
    expect(laptop.hasCompletedBootstrap).toBe(false);
    expect(laptop.controlStanding).toStrictEqual({ kind: "none" });
    expect(laptop.mayEdit).toBe(false);
    await run(3 * 60_000, [carol, laptop], 5_000); // Carol answers its repeat, to all, at her turn
    expect(laptop.hasCompletedBootstrap).toBe(true);
    expect(laptop.controlStanding).toStrictEqual({ kind: "bootstrapped" });
    expect(getPlainText(laptop.fragment)).toBe("Plan");
  });

  it("takes nothing of its other device's answer to someone else: neither its content nor its control state (RSY-12)", async () => {
    const { port, first, bob } = await group();
    first.dispose();
    const carol = await join(port, "carol");
    await run(3 * 60_000, [bob, carol], 5_000); // Bob answers Carol's request to all, at his turn
    const toCarol = (await requestsOf(port, "carol")).at(-1);
    assert(toCarol);
    bob.dispose();
    // The laptop reads Bob's answer to Carol alone.
    await port.hideFrom(
      "bob",
      (frame) => frame.kind === "resync-response" && frame.respondsTo === toCarol.requestId,
    );
    const laptop = await join(port, "bob", { autoResync: false });
    expect(getPlainText(laptop.fragment)).toBe("");
    expect(laptop.controlState.targets).toStrictEqual({});
    expect(laptop.hasCompletedBootstrap).toBe(false);
  });

  it("the creator's answer to someone else bootstraps nothing either: a new device of a member waits for an answer to its own request", async () => {
    const { port, first, bob } = await group();
    first.dispose(); // only the creator's answer to Bob is on the channel
    const carol = await join(port, "carol");
    expect(carol.hasCompletedBootstrap).toBe(false);
    expect(carol.mayEdit).toBe(false);
    await run(3 * 60_000, [bob, carol], 5_000);
    expect(carol.controlStanding).toStrictEqual({ kind: "bootstrapped" });
  });

  it("a restarted device that reads its other device's old answer again is not bootstrapped by it: without a cursor nothing shows what came between (CTL-41, LOS-8)", async () => {
    const { port, first, bob } = await group();
    const phone = await join(port, "bob");
    await run(5_000, [first, bob, phone]); // the first device answers the phone at once (RSY-6)
    expect(phone.hasCompletedBootstrap).toBe(true);
    const content = encodeUpdate(phone.document);
    first.dispose();
    bob.dispose();
    phone.dispose();
    // Restarted with its content, on a transport without a cursor that gives it everything again.
    const restarted = await join(port, "bob", { autoResync: false, restore: { state: content } });
    expect(restarted.hasCompletedBootstrap).toBe(false);
    expect(restarted.mayEdit).toBe(false);
  });
});
