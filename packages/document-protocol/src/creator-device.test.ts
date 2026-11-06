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
import { answerWindowMs } from "./answer-turn";
import { CLOCK_SPAN_MS } from "./clock";
import { CLOSE_REASON, MAX_RIGHT_TARGETS } from "./control-state";
import {
  decodeFrame,
  encodeControlFrame,
  encodeResyncResponseFrame,
  type Frame,
  type ResyncRequestFrame,
} from "./framing";
import { DocumentEngine, type DocumentEngineOptions, type PersistedControlState } from "./index";
import { DEFAULT_LOSS_GRACE_MS } from "./loss-detector";
import { registerStateDigest } from "./registers";

/**
 * A new device of the creator after its other devices were lost (SPECIFICATION.md CTL-13, CTL-25,
 * CTL-26, CTL-27, CTL-45, RSY-5, RSY-14, RSY-21): it asks, its repeat asks all, and the members' answers
 * bring the content and the rights, which it merges as any device merges a snapshot, but which
 * bootstrap it not: only the creator's own state does — another device of the creator's answer, or a
 * restored or carried state. Until then it decides nothing but the close and its reason, and edits. A device restored
 * from an earlier state is bootstrapped and merges what members answer its return: a register two
 * days ahead, and a decision on its target holds everywhere; a close a member passes on holds; merging
 * raises its own clock within the span; it promises nothing before it is bootstrapped; a member that
 * holds a register the devices lack asks once for each later decision, by the report after it, and its
 * answer brings the register to a device, whose report at once passes it on. Not a security test:
 * bootstrap.security.test.ts holds what must never happen.
 */

const DOC = "doc-1";
const OPTS = { batchWindowMs: 0, resyncResponseThrottleMs: 0, creatorMemberId: "alice" };
/** 2026-10-26 10:00:00 UTC. */
const T = 1_793_008_800_000;
const DAY = 86_400_000;

/** The in-memory transport, with a member's view that can lack what was sent so far, or one message. */
class Port implements MessengerPort {
  readonly inner = new InMemoryMessengerPort();
  readonly #hidden = new Map<MemberId, Set<DeliveryId>>();
  #loseNextFor: MemberId | undefined;
  #loseNextKind:
    | { member: MemberId; kind: Frame["kind"]; sender: MemberId | undefined }
    | undefined;

  /** The next message anyone sends never reaches `member`: the network lost it on the way. */
  loseNextSendFor(member: MemberId): void {
    this.#loseNextFor = member;
  }

  /** The next frame of `kind` that `sender` (or anyone) sends never reaches `member`. */
  loseNextOfKindFor(member: MemberId, kind: Frame["kind"], sender?: MemberId): void {
    this.#loseNextKind = { member, kind, sender };
  }

  readonly #losesEvery: { members: readonly MemberId[]; kind: Frame["kind"]; sender: MemberId }[] =
    [];
  /**
   * Every frame of `kind` that `sender` sends from now on never reaches any of `members`, until the
   * function returned is called.
   */
  loseEveryOfKindFor(
    members: readonly MemberId[],
    kind: Frame["kind"],
    sender: MemberId,
  ): () => void {
    const rule = { members, kind, sender };
    this.#losesEvery.push(rule);
    return () => {
      this.#losesEvery.splice(this.#losesEvery.indexOf(rule), 1);
    };
  }

  /** Nothing sent so far ever reaches `member` — a new device that sees no history, as Signal's. */
  async hideHistoryFrom(member: MemberId): Promise<void> {
    const hidden = this.#hidden.get(member) ?? new Set();
    for (const delivery of await this.inner.receive(DOC, member)) hidden.add(delivery.id);
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
    for (const every of this.#losesEvery) {
      if (every.sender !== sender || decodeFrame(payload).kind !== every.kind) continue;
      for (const member of every.members) {
        const hidden = this.#hidden.get(member) ?? new Set();
        hidden.add(id);
        this.#hidden.set(member, hidden);
      }
    }
    const kind = this.#loseNextKind;
    if (
      kind !== undefined &&
      (kind.sender ?? sender) === sender &&
      decodeFrame(payload).kind === kind.kind
    ) {
      const hidden = this.#hidden.get(kind.member) ?? new Set();
      hidden.add(id);
      this.#hidden.set(kind.member, hidden);
      this.#loseNextKind = undefined;
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

/** The members who answered `requestId`. */
async function answerersOf(port: Port, requestId: string): Promise<MemberId[]> {
  return (await channel(port))
    .filter(({ frame }) => frame.kind === "resync-response" && frame.respondsTo === requestId)
    .map(({ sender }) => sender);
}

/** Each engine's poll, in order; then whatever they sent goes out. */
async function poll(...engines: DocumentEngine[]): Promise<void> {
  for (const engine of engines) {
    await engine.sync();
    await vi.advanceTimersByTimeAsync(0);
  }
}

/** Polls every engine every `step` ms for `ms`. */
async function run(ms: number, engines: DocumentEngine[], step = 1_000): Promise<void> {
  for (let passed = 0; passed < ms; passed += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - passed));
    await poll(...engines);
  }
}

/**
 * Alice's only device created "Plan", made Bob and Dave writers and Carol a reader, and is lost; the
 * members online hold its decisions. A new device of Alice's comes on a transport that shows it
 * nothing sent before.
 */
async function lost(
  online: readonly MemberId[],
  decide: (old: DocumentEngine, port: Port) => Promise<void> = async () => {},
) {
  const port = new Port();
  const persisted: PersistedControlState[] = [];
  const old = await DocumentEngine.create(DOC, "alice", port, undefined, {
    ...OPTS,
    onControlStateChange: (state) => persisted.push(state),
  });
  await old.setMembership("bob", "write");
  await old.setMembership("carol", "read");
  await old.setMembership("dave", "write");
  old.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
  const members = new Map<MemberId, DocumentEngine>();
  for (const member of online) {
    members.set(member, await DocumentEngine.join(DOC, member, port, undefined, OPTS));
  }
  for (let round = 0; round < 4; round++) await poll(old, ...members.values());
  // What the lost device saved before `decide`: what a device restored from it starts from (CTL-26).
  const backup = {
    control: persisted.at(-1) as PersistedControlState,
    content: encodeUpdate(old.document),
  };
  await decide(old, port);
  for (let round = 0; round < 4; round++) await poll(old, ...members.values());
  // Lost, not closed: what its close would send never goes, neither its last decision again nor its
  // report (SND-11, SND-27).
  port.inner.disconnect("alice");
  old.dispose();
  await vi.advanceTimersByTimeAsync(0);
  port.inner.reconnect("alice");
  await port.hideHistoryFrom("alice");
  const at = (member: MemberId): DocumentEngine => members.get(member) as DocumentEngine;
  return { port, at, members: [...members.values()], backup };
}

/** The new device of Alice's, with what it persisted collected. */
async function startNewDevice(port: Port, options: DocumentEngineOptions = {}) {
  const persisted: PersistedControlState[] = [];
  const engine = await DocumentEngine.join(DOC, "alice", port, undefined, {
    ...OPTS,
    onControlStateChange: (state) => persisted.push(state),
    ...options,
  });
  return { engine, saved: () => persisted.at(-1) as PersistedControlState };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a new device of the creator after the loss of its other devices (CTL-25, CTL-27, RSY-14, RSY-21)", () => {
  it("its repeat asks all, the first member's answer brings the content and the rights, which it merges, but which bootstrap it not; members holding the same ask nothing", {
    timeout: 60_000,
  }, async () => {
    // An hour simulated under fake timers: CPU-bound, slow only on a loaded machine.
    const { port, at, members } = await lost(["bob", "carol"]);
    const newDevice = await startNewDevice(port, { syncPolicy: { maxIntervalMs: 30_000 } });
    expect(newDevice.engine.controlStanding).toStrictEqual({ kind: "none" });
    await run(10_000 + answerWindowMs(0) + 5_000, [newDevice.engine, ...members]);
    const requests = await requestsOf(port, "alice");
    expect(requests.slice(0, 2).map((request) => request.all)).toStrictEqual([false, true]);
    const repeat = requests[1];
    assert(repeat);
    const answerers = await answerersOf(port, repeat.requestId);
    expect(answerers.length).toBeGreaterThanOrEqual(1);
    expect(getPlainText(newDevice.engine.fragment)).toBe("Plan");
    expect(newDevice.engine.controlState.targets).toStrictEqual(at("bob").controlState.targets);
    expect(newDevice.engine.controlStanding).toStrictEqual({ kind: "none" });
    expect(newDevice.engine.hasCompletedBootstrap).toBe(false);
    // It asks on, its waits doubling, a bounded number of times (RSY-5): a second hour adds no request.
    // Nobody sees anything to ask for.
    await run(60 * 60_000, [newDevice.engine, ...members], 10_000);
    const firstHour = (await requestsOf(port, "alice")).length;
    await run(60 * 60_000, [newDevice.engine, ...members], 10_000);
    expect(await requestsOf(port, "alice")).toHaveLength(firstHour);
    expect(newDevice.engine.controlStanding).toStrictEqual({ kind: "none" });
    for (const member of members) expect(member.syncHealth.suspicions).toStrictEqual([]);
  });

  it("decides nothing, before an answer or after the members': the refusal names it; it edits, and its close holds for everyone (CTL-13, CTL-27, LIF-7)", async () => {
    const { port, at, members } = await lost(["bob"]);
    const bob = at("bob");
    const newDevice = await startNewDevice(port);
    await expect(newDevice.engine.setMembership("erin", "read")).rejects.toMatchObject({
      reason: "not-bootstrapped",
    });
    await run(10_000 + answerWindowMs(0) + 5_000, [newDevice.engine, ...members]);
    expect(newDevice.engine.permissionOf("dave")).toBe("write");
    await expect(newDevice.engine.setMembership("erin", "read")).rejects.toMatchObject({
      reason: "not-bootstrapped",
    });
    await expect(newDevice.engine.setMembership("dave", null)).rejects.toMatchObject({
      reason: "not-bootstrapped",
    });
    expect(newDevice.engine.permissionOf("erin")).toBeUndefined();
    newDevice.engine.edit((fragment) => insertPlainText(fragment, 4, "!"));
    await run(5_000, [newDevice.engine, ...members]);
    expect(getPlainText(bob.fragment)).toBe("Plan!");
    expect(bob.permissionOf("erin")).toBeUndefined();
    await newDevice.engine.closeDocument();
    await run(5_000, [newDevice.engine, ...members]);
    expect(newDevice.engine.closed).toBe(true);
    expect(bob.closed).toBe(true);
  });

  it("closes with the reason creator-state-lost: the members take the close and its reason, and a joiner gets both in a member's snapshot (CTL-23, CTL-27, LIF-7)", {
    timeout: 60_000,
  }, async () => {
    const { port, members } = await lost(["bob", "dave"]);
    const newDevice = await startNewDevice(port);
    await run(10_000 + answerWindowMs(0) + 5_000, [newDevice.engine, ...members]);
    expect(newDevice.engine.controlStanding).toStrictEqual({ kind: "none" });
    const before = (await channel(port)).length;
    await newDevice.engine.closeDocument("creator-state-lost");
    await run(5_000, [newDevice.engine, ...members]);
    // One frame, the close and its reason together, without a control clock (RSY-14).
    const sent = (await channel(port))
      .slice(before)
      .filter(({ sender, frame }) => sender === "alice" && frame.kind === "control");
    expect(
      sent.map(
        ({ frame }) =>
          frame.kind === "control" && [
            frame.closed,
            frame.targets[CLOSE_REASON]?.value,
            frame.controlClock,
          ],
      ),
    ).toStrictEqual([[true, "creator-state-lost", null]]);
    for (const engine of [newDevice.engine, ...members]) {
      expect(engine.closed).toBe(true);
      expect(engine.closeReason).toBe("creator-state-lost");
    }
    // Carol, a reader, comes on a transport that shows her nothing sent before: only an answer brings her the close.
    await port.hideHistoryFrom("carol");
    const carol = await DocumentEngine.join(DOC, "carol", port, undefined, OPTS);
    await run(10_000 + answerWindowMs(0) + 5_000, [carol, newDevice.engine, ...members]);
    expect(carol.hasCompletedBootstrap).toBe(true);
    expect(carol.closed).toBe(true);
    expect(carol.closeReason).toBe("creator-state-lost");
  });

  it("with another device of the creator at hand, that device's answer bootstraps it, after members' answers did not, and it decides (RSY-14)", async () => {
    const port = new Port();
    const laptop = await DocumentEngine.create(DOC, "alice", port, undefined, {
      ...OPTS,
      autoResync: false,
    });
    await laptop.setMembership("bob", "write");
    laptop.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
    const bob = await DocumentEngine.join(DOC, "bob", port, undefined, OPTS);
    for (let round = 0; round < 4; round++) await poll(laptop, bob);
    await port.hideHistoryFrom("alice");
    // The laptop sleeps: Bob answers the tablet's repeat to all.
    const tablet = await startNewDevice(port);
    await run(10_000 + answerWindowMs(0) + 5_000, [tablet.engine, bob]);
    expect(getPlainText(tablet.engine.fragment)).toBe("Plan");
    expect(tablet.engine.permissionOf("bob")).toBe("write");
    expect(tablet.engine.controlStanding).toStrictEqual({ kind: "none" });
    await expect(tablet.engine.setMembership("erin", "read")).rejects.toMatchObject({
      reason: "not-bootstrapped",
    });
    // The laptop wakes, and answers the tablet's next request at once.
    await run(5 * 60_000, [laptop, tablet.engine, bob]);
    expect(tablet.engine.controlStanding).toStrictEqual({ kind: "bootstrapped" });
    await tablet.engine.setMembership("erin", "read");
    await run(5_000, [laptop, tablet.engine, bob]);
    for (const engine of [laptop, bob]) expect(engine.permissionOf("erin")).toBe("read");
  });

  it("two members answer at once with different states: both are merged, the later register holds on each target, and neither bootstraps it (CTL-22, CTL-25, CTL-27)", async () => {
    // The lost device's last decision, on Carol, reached Dave but not Bob.
    const { port, at } = await lost(["bob", "dave"], async (old, port) => {
      port.loseNextSendFor("bob");
      await old.setMembership("carol", "write");
    });
    const [bob, dave] = [at("bob"), at("dave")];
    expect(bob.permissionOf("carol")).toBe("read");
    expect(dave.permissionOf("carol")).toBe("write");
    const newDevice = await startNewDevice(port, { autoResync: false });
    await run(11_000, [newDevice.engine]);
    await newDevice.engine.requestResync();
    const [toAll] = (await requestsOf(port, "alice")).slice(-1);
    expect(toAll?.all).toBe(true);
    assert(toAll);
    // Both turns pass before either polls again: both answer, Bob's first.
    await poll(bob, dave);
    await vi.advanceTimersByTimeAsync(answerWindowMs(0));
    await poll(bob, dave);
    expect(await answerersOf(port, toAll.requestId)).toStrictEqual(["bob", "dave"]);
    await poll(newDevice.engine);
    expect(newDevice.engine.controlStanding).toStrictEqual({ kind: "none" });
    expect(newDevice.engine.controlState.targets["member:carol"]).toStrictEqual(
      dave.controlState.targets["member:carol"],
    );
  });

  it("restored from a state saved before, it is bootstrapped, and its return merges a member's answer: a register two days ahead; a decision on its target holds everywhere, also after a restart, and the clocks stay near the wall clock (CTL-26, CTL-45, RSY-21)", async () => {
    // The lost device's wall clock ran two days ahead when it gave Mallory write.
    const { port, at, members, backup } = await lost(["bob"], async (old) => {
      vi.setSystemTime(T + 2 * DAY);
      await old.setMembership("mallory", "write");
      vi.setSystemTime(T);
    });
    const ahead = at("bob").controlState.targets["member:mallory"];
    expect(ahead?.clock[0]).toBeGreaterThanOrEqual(T + 2 * DAY);
    const restored = await startNewDevice(port, {
      controlState: backup.control,
      restore: { state: backup.content, rebound: true },
    });
    expect(restored.engine.controlStanding).toStrictEqual({ kind: "bootstrapped" });
    expect(restored.engine.permissionOf("mallory")).toBeUndefined();
    await run(10_000 + answerWindowMs(0) + 5_000, [restored.engine, ...members]);
    expect(restored.engine.permissionOf("mallory")).toBe("write");
    expect(restored.engine.permissionOf("carol")).toBe("read");
    // Its own clock stopped at the end of the span: a decision on another target keeps near the wall clock.
    expect((restored.saved().clock?.[0] ?? Infinity) <= Date.now() + CLOCK_SPAN_MS).toBe(true);
    await restored.engine.setMembership("erin", "read");
    expect(restored.engine.controlState.targets["member:erin"]?.clock[0]).toBeLessThanOrEqual(
      Date.now() + CLOCK_SPAN_MS,
    );
    // After a restart, the person revokes Mallory: it holds everywhere, above the register far ahead.
    const saved = restored.saved();
    restored.engine.dispose();
    const restarted = await startNewDevice(port, { controlState: saved });
    expect(restarted.engine.controlStanding).toStrictEqual({ kind: "bootstrapped" });
    await restarted.engine.setMembership("mallory", null);
    await run(5_000, [restarted.engine, ...members]);
    for (const engine of [restarted.engine, at("bob")])
      expect(engine.rightOf("mallory")).toBe("revoked");
    expect((restarted.saved().clock?.[0] ?? Infinity) <= Date.now() + CLOCK_SPAN_MS + 1).toBe(true);
  });

  it("restored, a member's answer that changes its control state makes it send a heartbeat at once, stating the merged clock and digest (SND-11, LOS-12)", async () => {
    // Under the default pacing nothing else is due: without that heartbeat, a member that lacks the
    // register would never see the creator's state differ from its own.
    const { port, members, backup } = await lost(["bob"], async (old) => {
      await old.setMembership("mallory", "write");
    });
    const restored = await startNewDevice(port, {
      controlState: backup.control,
      restore: { state: backup.content, rebound: true },
    });
    expect(restored.engine.controlStanding).toStrictEqual({ kind: "bootstrapped" });
    expect(restored.engine.permissionOf("mallory")).toBeUndefined();
    const before = (await channel(port)).length;
    await run(10_000 + answerWindowMs(0) + 5_000, [restored.engine, ...members]);
    expect(restored.engine.permissionOf("mallory")).toBe("write");
    const { closed, targets } = restored.engine.controlState;
    const stated = (await channel(port))
      .slice(before)
      .filter(({ sender, frame }) => sender === "alice" && frame.kind === "heartbeat")
      .map(({ frame }) => frame.kind === "heartbeat" && [frame.controlClock, frame.controlDigest]);
    expect(stated).toContainEqual([
      restored.engine.controlClock,
      registerStateDigest({ closed, targets }),
    ]);
  });

  it("a close a member passes on holds: the document is closed on the new device too (CTL-23, LIF-7)", async () => {
    const { port, at, members } = await lost(["bob"], async (old) => {
      await old.closeDocument();
    });
    expect(at("bob").closed).toBe(true);
    const newDevice = await startNewDevice(port);
    await run(10_000 + answerWindowMs(0) + 5_000, [newDevice.engine, ...members]);
    expect(newDevice.engine.controlStanding).toStrictEqual({ kind: "none" });
    expect(newDevice.engine.closed).toBe(true);
    expect(newDevice.engine.mayEdit).toBe(false);
  });
});

describe("an answer that would bring the device over its bounds (CTL-30, CTL-32, RSY-14)", () => {
  it("another device of the creator's answer bootstraps it into a capacity conflict: what it held as before, no new target, and its answers carry no control state", async () => {
    const { port, at } = await lost(["bob"]);
    const newDevice = await startNewDevice(port);
    // Its first request expires unanswered — Bob is offline —, and its repeat asks all (RSY-21).
    for (
      let waited = 0;
      !(await requestsOf(port, "alice")).some((sent) => sent.all) && waited < 60_000;
      waited += 1_000
    ) {
      await run(1_000, [newDevice.engine]);
    }
    const request = (await requestsOf(port, "alice")).filter((sent) => sent.all).at(-1);
    assert(request);
    const targets: Record<string, { value: "read"; clock: [number, number]; device: string }> = {};
    for (let i = 0; i <= MAX_RIGHT_TARGETS; i++) {
      targets[`member:m${String(i).padStart(4, "0")}`] = {
        value: "read",
        clock: [T - DAY, 0],
        device: "L".repeat(22),
      };
    }
    // Another device of Alice's, holding more registers than a device can (CTL-30), answers it.
    await port.send(
      DOC,
      "alice",
      encodeResyncResponseFrame({
        documentId: DOC,
        respondsTo: request.requestId,
        update: encodeUpdate(at("bob").document),
        control: { profile: "yjs-paragraphs/1", closed: false, targets },
      }),
    );
    await poll(newDevice.engine);
    expect(newDevice.engine.controlStanding).toStrictEqual({ kind: "bootstrapped" });
    expect(newDevice.engine.capacityConflict).toBe(true);
    expect([...newDevice.engine.memberPermissions]).toStrictEqual([]);
    await expect(newDevice.engine.setMembership("zoe", "read")).rejects.toMatchObject({
      reason: "capacity-conflict",
    });
    // A joiner it answers takes content from it, but no control state: not bootstrapped by it.
    const history = (await channel(port)).length;
    const zed = await DocumentEngine.join(DOC, "zed", port, undefined, {
      ...OPTS,
      autoResync: false,
    });
    await run(5_000, [newDevice.engine, zed]);
    const answers = (await channel(port))
      .slice(history)
      .filter(({ sender, frame }) => sender === "alice" && frame.kind === "resync-response");
    expect(answers.length).toBeGreaterThan(0);
    for (const { frame } of answers)
      if (frame.kind === "resync-response") expect(frame.control).toBeNull();
    expect(zed.hasCompletedBootstrap).toBe(false);
  });
});

describe("merging an answer raises the device's own clock: to its control clock, within the span (CTL-45)", () => {
  it("a register of the creator merged beyond the span lifts the own clock once the wall clock moved on, though the answer merged later lies far below it", async () => {
    const { port, members } = await lost(["bob"]);
    const newDevice = await startNewDevice(port);
    // A broken application of the creator decided on Erin 30 h ahead; the new device merges it as
    // the creator's (CTL-5), its own clock stopping at the end of the span, T + 24 h.
    const erin = {
      value: "write" as const,
      clock: [T + 30 * 3_600_000, 0] as const,
      device: "L".repeat(22),
    };
    await port.send(
      DOC,
      "alice",
      encodeControlFrame({
        documentId: DOC,
        device: erin.device,
        targets: { "member:erin": erin },
        closed: false,
        controlClock: erin.clock,
        controlDigest: registerStateDigest({ closed: false, targets: { "member:erin": erin } }),
      }),
    );
    await poll(newDevice.engine);
    expect(newDevice.saved().clock).toStrictEqual([T + DAY, 65_535]);
    expect(newDevice.engine.controlStanding).toStrictEqual({ kind: "none" });
    // Ten hours later the first member's answer is merged; its registers lie near T. It bootstraps
    // nothing (CTL-27), but it is merged as any answer is.
    vi.setSystemTime(T + 10 * 3_600_000);
    await run(10_000 + answerWindowMs(0) + 5_000, [newDevice.engine, ...members]);
    expect(newDevice.engine.controlStanding).toStrictEqual({ kind: "none" });
    expect(newDevice.engine.controlClock).toStrictEqual([T + 30 * 3_600_000, 0]);
    // raise(control clock): its own clock is the control clock now, within the span of T + 10 h.
    expect(newDevice.saved().clock).toStrictEqual([T + 30 * 3_600_000, 0]);
  });
});

describe("a new device of the creator states no control clock before it is bootstrapped (SND-11, CTL-27)", () => {
  it("its one decision, the close, carries no control clock, and goes again before its report: no member suspects anything, and the close holds (SND-27)", async () => {
    const PACE = { syncPolicy: { maxIntervalMs: 30_000, expectedLatencyMs: 5_000 } };
    const { port, members } = await lost(["bob", "dave"]);
    const newDevice = await startNewDevice(port, { ...PACE, autoResync: false });
    const before = (await channel(port)).length;
    await newDevice.engine.closeDocument();
    for (let minute = 0; minute < 15; minute++) {
      await run(60_000, [newDevice.engine, ...members]);
      for (const member of members) {
        expect(
          member.syncHealth.suspicions.map((suspicion) => suspicion.kind),
          `minute ${minute}`,
        ).toStrictEqual([]);
      }
    }
    const meanwhile = (await channel(port)).slice(before);
    const frames = meanwhile.filter(
      ({ sender, frame }) => sender === "alice" && frame.kind === "control",
    );
    // The close, and the same frame again before the report that follows it (SND-27).
    expect(
      frames.map(({ frame }) => frame.kind === "control" && [frame.controlClock]),
    ).toStrictEqual([[null], [null]]);
    expect(frames[1]?.frame).toStrictEqual(frames[0]?.frame);
    expect(
      meanwhile.filter(
        ({ sender, frame }) => sender !== "alice" && frame.kind === "resync-request",
      ),
    ).toStrictEqual([]);
    for (const member of members) expect(member.closed).toBe(true);
  });

  it("bootstrapped by another device of the creator, it owes a report at once where it holds more than that answer stated: a register it merged from a member's answer before, which Bob lacks, reaches Bob (SND-11, LOS-10)", async () => {
    const PACE = { syncPolicy: { maxIntervalMs: 30_000, expectedLatencyMs: 5_000 } };
    const { port, at } = await lost(["bob", "dave"], async (old, port) => {
      port.loseNextSendFor("bob");
      await old.setMembership("carol", "write");
      // Bob loses its report too, and the decision it sends again before it (SND-27).
      port.loseNextSendFor("bob");
      port.loseNextOfKindFor("bob", "heartbeat", "alice");
      const reported = old.reportNow();
      await vi.advanceTimersByTimeAsync(0);
      await reported;
    });
    const [bob, dave] = [at("bob"), at("dave")];
    expect(bob.permissionOf("carol")).toBe("read");
    const newDevice = await startNewDevice(port, { ...PACE, autoResync: false });
    await newDevice.engine.requestResync();
    await run(30_000, [newDevice.engine]);
    // Its repeat asks all: Dave's answer brings Carol's register, which bootstraps nothing.
    await newDevice.engine.requestResync();
    await run(60_000, [newDevice.engine, bob, dave]);
    expect(newDevice.engine.permissionOf("carol")).toBe("write");
    expect(newDevice.engine.controlStanding).toStrictEqual({ kind: "none" });
    expect(bob.permissionOf("carol")).toBe("read");
    // Another device of Alice's, bootstrapped and without that decision, answers its next request.
    await newDevice.engine.requestResync();
    const request = (await requestsOf(port, "alice")).at(-1);
    assert(request);
    await port.send(
      DOC,
      "alice",
      encodeResyncResponseFrame({
        documentId: DOC,
        respondsTo: request.requestId,
        update: new Uint8Array([0, 0]),
        control: { profile: "yjs-paragraphs/1", closed: false, targets: bob.controlState.targets },
      }),
    );
    await run(2 * 60_000, [newDevice.engine, bob]);
    expect(newDevice.engine.controlStanding).toStrictEqual({ kind: "bootstrapped" });
    expect(bob.permissionOf("carol")).toBe("write");
  });
});

describe("a device of the creator that an answer without control state brought the content (RSY-5, RSY-14, CTL-27)", () => {
  it("is not bootstrapped by it, asks on, its repeats asking all; a member's answer brings the rights, and bootstraps it not either", async () => {
    const { port, at, members } = await lost(["carol"]);
    // Another device of Alice's holds the content but no control state, and does not ask by itself.
    const content = encodeUpdate(at("carol").document);
    const other = await startNewDevice(port, { autoResync: false, restore: { state: content } });
    const newDevice = await startNewDevice(port);
    const stream = (await requestsOf(port, "alice"))[1]?.stream;
    await poll(other.engine, newDevice.engine);
    expect(getPlainText(newDevice.engine.fragment)).toBe("Plan"); // the other device answered at once
    expect(newDevice.engine.hasCompletedBootstrap).toBe(false);
    expect(newDevice.engine.controlStanding).toStrictEqual({ kind: "none" });
    await run(3 * 60_000, [other.engine, newDevice.engine, ...members]);
    // Answered at once by the other device without control state, which bootstraps nothing: its
    // bootstrap goes on, and its repeats ask all (RSY-21); Carol's answers bootstrap it not either.
    const asked = (await requestsOf(port, "alice")).filter((request) => request.stream === stream);
    expect(asked.length).toBeGreaterThanOrEqual(2);
    expect(asked.map((request) => request.all)).toStrictEqual([
      false,
      ...asked.slice(1).map(() => true),
    ]);
    expect(newDevice.engine.controlStanding).toStrictEqual({ kind: "none" });
    expect(newDevice.engine.hasCompletedBootstrap).toBe(false);
    expect(newDevice.engine.permissionOf("carol")).toBe("read");
  });
});

describe("a member that holds a register the creator's devices lack (§10.6, LOS-12, LOS-18, CTL-25, CTL-27)", () => {
  /**
   * The lost device decided Carol's write and then Erin's; the first decision reached Dave alone. A
   * device of Alice's restored from what the lost one saved before them returns while Dave is away
   * (CTL-26, RSY-21): Bob's answer brings Erin's register, nobody's brings Carol's. Dave is back once
   * nobody keeps the return's request any more (RSY-12), and from then on he hears no report of
   * Alice's, until the function returned is called.
   */
  async function aRegisterOnlyDaveHolds() {
    const { port, at, members, backup } = await lost(["bob", "dave"], async (old, port) => {
      port.loseNextSendFor("bob");
      await old.setMembership("carol", "write");
      await old.setMembership("erin", "write");
    });
    const [bob, dave] = [at("bob"), at("dave")];
    port.inner.disconnect("dave");
    const restored = await startNewDevice(port, {
      controlState: backup.control,
      restore: { state: backup.content, rebound: true },
    });
    const device = restored.engine;
    await run(2 * 60_000, [device, bob]);
    expect(device.controlStanding).toStrictEqual({ kind: "bootstrapped" });
    expect(device.permissionOf("erin")).toBe("write");
    expect(device.permissionOf("carol")).toBe("read");
    await run(40 * 60_000, [device, bob], 10_000);
    port.inner.reconnect("dave");
    const reportsReachDave = port.loseEveryOfKindFor(["dave"], "heartbeat", "alice");
    // Back, Dave reads the device's requests of the hour before, which nobody keeps any more: once
    // their time as he heard them is over, none stands for a request of his (RSY-22).
    await run(5 * 60_000, [device, ...members]);
    return { port, device, bob, dave, members, reportsReachDave };
  }

  it("(a) the member sees it in the report after each later decision and asks once for it, to all, answered: its requests are bounded by the decisions, it asks nothing between them, and the frames alone show nothing", {
    timeout: 60_000,
  }, async () => {
    // Two simulated hours of polling: slow on a loaded machine, not a wait.
    const { port, device, dave, members, reportsReachDave } = await aRegisterOnlyDaveHolds();
    const answered = async (requests: readonly ResyncRequestFrame[]) =>
      Promise.all(
        requests.map(async (request) =>
          (await answerersOf(port, request.requestId)).includes("alice"),
        ),
      );
    // While her reports are lost on their way to Dave, her decisions' frames, merged, show him nothing:
    // a frame is no evidence of control state (LOS-12), and he asks nothing.
    const unseen = (await requestsOf(port, "dave")).length;
    for (let minute = 0; minute < 5; minute++) {
      await device.setMembership(`u${minute}`, "write");
      await run(60_000, [device, ...members]);
    }
    expect(dave.permissionOf("u4")).toBe("write");
    expect((await requestsOf(port, "dave")).length).toBe(unseen);
    expect(dave.syncHealth.suspicions).toStrictEqual([]);
    // Her reports reach him now. She decides once a minute for half an hour. Each decision's report states
    // another digest at Dave's clock (LOS-12): a gap of its own, asked for once and ended by the device's
    // answer, which states that clock and digest (LOS-18) — though what Dave holds still differs, and he
    // keeps Carol's later register (CTL-22).
    reportsReachDave();
    const before = (await requestsOf(port, "dave")).length;
    const DECISIONS = 30;
    for (let minute = 0; minute < DECISIONS; minute++) {
      await device.setMembership(`m${minute}`, "write");
      await run(60_000, [device, ...members]);
    }
    const asked = (await requestsOf(port, "dave")).slice(before);
    expect(asked).toHaveLength(DECISIONS);
    expect(asked.every((request) => request.all)).toBe(true);
    expect(await answered(asked)).toStrictEqual(asked.map(() => true));
    expect(dave.syncHealth.suspicions).toStrictEqual([]);
    expect(dave.permissionOf("carol")).toBe("write");
    expect(device.permissionOf("carol")).toBe("read");
    // Half an hour of the device's writing without a decision: each report states the clock and digest
    // its last answer stated, and Dave asks nothing (LOS-18, LOS-26).
    const reports = async () =>
      (await channel(port)).filter(
        ({ sender, frame }) => sender === "alice" && frame.kind === "heartbeat",
      ).length;
    const quiet = (await requestsOf(port, "dave")).length;
    const reported = await reports();
    for (let minute = 0; minute < 30; minute++) {
      device.edit((fragment) => insertPlainText(fragment, 0, "x"));
      await run(60_000, [device, ...members]);
    }
    expect(await reports()).toBe(reported + 30); // one per phase of its writing (SND-11)
    expect((await requestsOf(port, "dave")).length).toBe(quiet);
    expect(getPlainText(dave.fragment)).toBe(getPlainText(device.fragment));
  });

  it("(b) the member's answer to a request of the device brings the device the register (CTL-25), and the report the device owes at once for that merge brings it to a member that lacks it (SND-11, LOS-12)", {
    timeout: 60_000,
  }, async () => {
    const { port, device, bob, members } = await aRegisterOnlyDaveHolds();
    const bobAsked = (await requestsOf(port, "bob")).length;
    const reportsBefore = (await channel(port)).filter(
      ({ sender, frame }) => sender === "alice" && frame.kind === "heartbeat",
    ).length;
    await device.requestResync();
    const [request] = (await requestsOf(port, "alice")).slice(-1);
    assert(request);
    // Dave answers at his turn (RSY-20), and is gone once he did: only the device can pass it on.
    for (let second = 0; second < 120; second++) {
      if ((await answerersOf(port, request.requestId)).includes("dave")) break;
      await run(1_000, [device, ...members]);
    }
    expect(await answerersOf(port, request.requestId)).toContain("dave");
    port.inner.disconnect("dave");
    await poll(device);
    expect(device.permissionOf("carol")).toBe("write");
    expect(device.controlStanding).toStrictEqual({ kind: "bootstrapped" });
    // The merge kept its control clock and changed its digest: its report goes at once, before anything
    // of its own (SND-11). At Bob's clock it states another digest (LOS-12): he asks once, and the
    // device's answer brings him the register. He may first let a try go for the device's own request,
    // heard before the merge, which at his clock reaches no further (RSY-22): then his own waits until
    // that one had its time, 40 s from when he heard it, and then his place, within the answer window
    // (LOS-6). The gap's wait, those 40 s, the place, and the device's answer at once: under 85 s.
    const requestToAllMs = 10_000 + answerWindowMs(0); // RSY-4: the floor of the expiry, and the window
    await run(2 * DEFAULT_LOSS_GRACE_MS + requestToAllMs + answerWindowMs(0) + 5_000, [
      device,
      bob,
    ]);
    const reports = (await channel(port)).filter(
      ({ sender, frame }) => sender === "alice" && frame.kind === "heartbeat",
    );
    expect(reports.length).toBeGreaterThan(reportsBefore);
    expect((await requestsOf(port, "bob")).length).toBe(bobAsked + 1);
    expect(bob.permissionOf("carol")).toBe("write");
    expect(bob.syncHealth.suspicions).toStrictEqual([]);
  });
});

describe("what a member's request states is no evidence on a device of the creator (CTL-27, LOS-6, LOS-10)", () => {
  it("two devices of the creator, five members: Bob lost a decision, asked, was answered and went away; the devices hold no evidence of his, and Carol's edit lost later is asked for", {
    timeout: 60_000,
  }, async () => {
    // Fifteen simulated minutes of seven engines polling: slow on a loaded machine, not a wait.
    const PACE = { syncPolicy: { maxIntervalMs: 30_000, expectedLatencyMs: 5_000 } };
    const port = new Port();
    const laptop = await DocumentEngine.create(DOC, "alice", port, undefined, { ...OPTS, ...PACE });
    const names = ["bob", "carol", "dave", "erin", "frank"];
    for (const name of names) await laptop.setMembership(name, "write");
    laptop.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
    const phone = await DocumentEngine.join(DOC, "alice", port, undefined, { ...OPTS, ...PACE });
    const members = new Map<MemberId, DocumentEngine>();
    for (const name of names)
      members.set(
        name,
        await DocumentEngine.join(DOC, name, port, undefined, { ...OPTS, ...PACE }),
      );
    const everyone = () => [laptop, phone, ...members.values()];
    await run(60_000, everyone());
    // Bob loses a decision that is not the last; the next shows it to him (LOS-12), he asks, and the
    // devices answer. His request, at their clock with another digest, is no evidence on either.
    port.loseNextSendFor("bob");
    await laptop.setMembership("gina", "write");
    await laptop.setMembership("hank", "write");
    // The phone writes on, and answers what the laptop asks with its new edits.
    for (let tick = 0; tick < 18; tick++) {
      phone.edit((fragment) => insertPlainText(fragment, 0, "p"));
      await run(10_000, everyone());
    }
    const bob = members.get("bob") as DocumentEngine;
    expect(bob.permissionOf("gina")).toBe("write");
    port.inner.disconnect("bob");
    for (let tick = 0; tick < 18; tick++) {
      phone.edit((fragment) => insertPlainText(fragment, 0, "p"));
      await run(10_000, everyone());
    }
    for (const device of [laptop, phone]) {
      expect(
        device.syncHealth.suspicions.filter((suspicion) => suspicion.sender === "bob"),
      ).toStrictEqual([]);
    }
    // Carol's next edit is lost on the way to the creator's devices: her heartbeat shows it, and they ask.
    const carol = members.get("carol") as DocumentEngine;
    port.loseNextSendFor("alice");
    carol.edit((fragment) => insertPlainText(fragment, 0, "C"));
    await run(3 * 60_000, everyone());
    for (const device of [laptop, phone])
      expect(getPlainText(device.fragment)).toBe(getPlainText(carol.fragment));
  });
});

describe("the edit side of a device of the creator that is not bootstrapped (CTL-13, CTL-27, CTL-43)", () => {
  it("may edit the document and every layer, and resync() sends its whole state: a member that lost its edit gets it so", async () => {
    const { port, at } = await lost(["bob"]);
    const bob = at("bob");
    const newDevice = await startNewDevice(port, { autoResync: false });
    expect(newDevice.engine.controlStanding).toStrictEqual({ kind: "none" });
    expect(newDevice.engine.mayEdit).toBe(true);
    expect(newDevice.engine.mayEditLayer("com.example.comments/1")).toBe(true);
    // Its edit never reaches Bob; nothing of its report either, which would come only 10 s later.
    port.loseNextSendFor("bob");
    newDevice.engine.edit((fragment) => insertPlainText(fragment, 0, "New "));
    await poll(newDevice.engine, bob);
    expect(getPlainText(bob.fragment)).toBe("Plan");
    const before = (await channel(port)).length;
    await newDevice.engine.resync();
    const sent = (await channel(port)).slice(before).filter(({ sender }) => sender === "alice");
    expect(sent.map(({ frame }) => frame.kind)).toStrictEqual(["edit"]);
    await poll(bob);
    // A paragraph of its own beside Bob's "Plan", in the order of their CRDT clients: the new device
    // held nothing when it wrote.
    expect(getPlainText(bob.fragment).split("\n").sort()).toStrictEqual(["New ", "Plan"]);
    expect(newDevice.engine.controlStanding).toStrictEqual({ kind: "none" });
  });

  it("takes the attribution an answer without control state brings to its first request, as the content's (RSY-15, ATR-1)", async () => {
    const { port, at } = await lost(["bob"]);
    const content = encodeUpdate(at("bob").document);
    const newDevice = await startNewDevice(port, { autoResync: false });
    const request = (await requestsOf(port, "alice")).at(-1);
    assert(request);
    // Another device of Alice's, not bootstrapped either, answers with the content and who wrote it.
    await port.send(
      DOC,
      "alice",
      encodeResyncResponseFrame({
        documentId: DOC,
        respondsTo: request.requestId,
        update: content,
        control: null,
        attribution: {
          ranges: [{ start: 0, end: 4, authorId: "alice" }],
          lastEditBySender: { alice: 4 },
        },
      }),
    );
    await poll(newDevice.engine);
    expect(getPlainText(newDevice.engine.fragment)).toBe("Plan");
    expect(newDevice.engine.controlStanding).toStrictEqual({ kind: "none" });
    expect(newDevice.engine.attribution.ranges).toStrictEqual([
      { start: 0, end: 4, authorId: "alice" },
    ]);
  });
});
