import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import {
  type Delivery,
  type DeliveryId,
  type DocumentId,
  type MemberId,
  type MessengerPort,
  TransportSendError,
} from "@tdsp/messenger-port";
import { getPlainText, insertPlainText } from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFrame, type Frame, type ResyncRequestFrame } from "./framing";
import { DocumentEngine } from "./index";

/**
 * What a gap asks once its tries ran out (SPECIFICATION.md LOS-2, LOS-6, LOS-25, LOS-26): it rests, is
 * shown, and asks nothing while no frame carries its stream further; a frame that does wakes it — one
 * request to all, at most once in ten minutes —, and the request of a return wakes it too. What
 * another stream does wakes nothing.
 */

const DOC = "doc-1";
const OPTS = { batchWindowMs: 0, resyncResponseThrottleMs: 0, creatorMemberId: "alice" };
/** Finite pacing, so that reports follow the phases of writing (SND-11). */
const PACE = { syncPolicy: { maxIntervalMs: 30_000, expectedLatencyMs: 5_000 } };
const T = 1_793_008_800_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The in-memory transport, where a message can be lost on its way to some members, and a member's requests can fail to go out. */
class Port implements MessengerPort {
  readonly inner = new InMemoryMessengerPort();
  readonly #hidden = new Map<MemberId, Set<DeliveryId>>();
  #loseNextFor: readonly MemberId[] = [];
  #failRequestsOf: MemberId | undefined;
  #loseAnswers: { from: MemberId; to: readonly MemberId[] } | undefined;

  /** The next message anyone sends never reaches `members`. */
  loseNextSendFor(...members: MemberId[]): void {
    this.#loseNextFor = members;
  }

  /** The requests `member` sends fail to go out, for now; `undefined` lets them go again. */
  failRequestsOf(member: MemberId | undefined): void {
    this.#failRequestsOf = member;
  }

  /**
   * `member` comes back after longer than the transport keeps messages for a device that is away: what
   * was sent meanwhile never reaches it (RSY-21).
   */
  async backAfterTheTransportForgot(member: MemberId): Promise<void> {
    const hidden = this.#hidden.get(member) ?? new Set();
    for (const delivery of await this.inner.receive(DOC, "observer")) hidden.add(delivery.id);
    this.#hidden.set(member, hidden);
    this.inner.reconnect(member);
  }

  /** Every answer `from` sends from now on never reaches `to`. */
  loseAnswersOf(from: MemberId, ...to: MemberId[]): void {
    this.#loseAnswers = { from, to };
  }

  #loseReports: { from: MemberId; to: readonly MemberId[] } | undefined;
  /** Every report `from` sends from now on never reaches `to`: it carries nothing again to them (SND-27). */
  loseReportsOf(from: MemberId, ...to: MemberId[]): void {
    this.#loseReports = { from, to };
  }

  createDocument(documentId: DocumentId, creator: MemberId): Promise<void> {
    return this.inner.createDocument(documentId, creator);
  }
  async send(documentId: DocumentId, sender: MemberId, payload: string): Promise<DeliveryId> {
    if (sender === this.#failRequestsOf && decodeFrame(payload).kind === "resync-request") {
      throw new TransportSendError("unavailable", `${sender}'s request did not go out`);
    }
    const id = await this.inner.send(documentId, sender, payload);
    const answers = this.#loseAnswers;
    const reports = this.#loseReports;
    const kind = decodeFrame(payload).kind;
    const lost = [
      ...this.#loseNextFor,
      ...(answers !== undefined && answers.from === sender && kind === "resync-response"
        ? answers.to
        : []),
      ...(reports !== undefined && reports.from === sender && kind === "heartbeat"
        ? reports.to
        : []),
    ];
    for (const member of lost) {
      const hidden = this.#hidden.get(member) ?? new Set();
      hidden.add(id);
      this.#hidden.set(member, hidden);
    }
    this.#loseNextFor = [];
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

/** Polls `engine` alone until it sent a heartbeat after the frame `after` of the channel. */
async function untilHeartbeat(
  port: Port,
  engine: DocumentEngine,
  member: MemberId,
  after: number,
): Promise<void> {
  for (let waited = 0; waited < 5 * MINUTE; waited += 1_000) {
    const sent = (await channel(port)).slice(after);
    if (sent.some(({ sender, frame }) => sender === member && frame.kind === "heartbeat")) return;
    await run(1_000, [engine]);
  }
  throw new Error(`${member} sent no heartbeat`);
}

/**
 * Alice created "Plan" and made the members writers; everyone holds it. Alice asks only when her person
 * does, so what the others ask is theirs alone.
 */
async function group(
  members: readonly MemberId[],
  alice: { autoResync?: boolean } = { autoResync: false },
  member: { autoResync?: boolean } = {},
) {
  const port = new Port();
  const creator = await DocumentEngine.create(DOC, "alice", port, undefined, {
    ...OPTS,
    ...PACE,
    ...alice,
  });
  for (const name of members) await creator.setMembership(name, "write");
  creator.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
  const engines = new Map<MemberId, DocumentEngine>();
  for (const name of members) {
    engines.set(
      name,
      await DocumentEngine.join(DOC, name, port, undefined, { ...OPTS, ...PACE, ...member }),
    );
  }
  await run(MINUTE, [creator, ...engines.values()]);
  const at = (member: MemberId): DocumentEngine => engines.get(member) as DocumentEngine;
  return { port, alice: creator, at };
}

/**
 * Carol writes " (C)", which reaches none of `others`, then " (D)", which reaches everyone and waits for
 * the lost one (LOS-2); her report follows, and she goes away.
 */
async function carolWritesAndGoes(port: Port, carol: DocumentEngine, others: readonly MemberId[]) {
  const before = (await channel(port)).length;
  port.loseNextSendFor(...others);
  carol.edit((fragment) => insertPlainText(fragment, getPlainText(fragment).length, " (C)"));
  await poll(carol);
  carol.edit((fragment) => insertPlainText(fragment, getPlainText(fragment).length, " (D)"));
  await poll(carol);
  await untilHeartbeat(port, carol, "carol", before);
  port.inner.disconnect("carol");
}

/** Carol is back, after longer than the transport keeps: nothing sent meanwhile reaches her (RSY-21). */
async function carolBack(port: Port, carol: DocumentEngine): Promise<void> {
  await port.backAfterTheTransportForgot("carol");
  carol.noteAbsence(2 * HOUR);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a gap that rests (LOS-6, LOS-25, LOS-26)", () => {
  it("Bob waits for Carol's edit, she stays away, and after three requests to all the gap rests: two hours of Alice writing wake nothing, and it stays shown", {
    timeout: 60_000,
  }, async () => {
    const { port, alice, at } = await group(["bob", "carol"]);
    const [bob, carol] = [at("bob"), at("carol")];
    const joined = (await requestsOf(port, "bob")).length;
    await carolWritesAndGoes(port, carol, ["alice", "bob"]);
    await run(10 * MINUTE, [alice, bob]);
    const ranOut = await requestsOf(port, "bob");
    expect(ranOut.slice(joined).map((request) => request.all)).toStrictEqual([true, true, true]);
    for (let minute = 0; minute < 120; minute += 5) {
      alice.edit((fragment) => insertPlainText(fragment, 0, "a"));
      await run(5 * MINUTE, [alice, bob], 5_000);
    }
    expect(await requestsOf(port, "bob")).toHaveLength(ranOut.length);
    expect(bob.syncHealth.suspicions).toMatchObject([
      { kind: "pending-gap", sender: "carol", tries: 3, resting: true },
    ]);
    expect(bob.syncHealth.state).toBe("suspected");
  });

  it("back, Carol's return request states the gap's position again, but is a frame of the gap's writer and wakes it: its one request to all brings what she holds, and her next edit asks nothing", {
    timeout: 60_000,
  }, async () => {
    const { port, alice, at } = await group(["bob", "carol"]);
    const [bob, carol] = [at("bob"), at("carol")];
    await carolWritesAndGoes(port, carol, ["alice", "bob"]);
    await run(10 * MINUTE, [alice, bob]);
    await run(2 * HOUR, [alice, bob], 10_000);
    const ranOut = await requestsOf(port, "bob");
    await carolBack(port, carol);
    await run(5 * MINUTE, [alice, bob, carol]);
    const woken = (await requestsOf(port, "bob")).slice(ranOut.length);
    expect(woken.map((request) => request.all)).toStrictEqual([true]);
    expect(getPlainText(bob.fragment)).toBe("Plan (C) (D)");
    expect(bob.syncHealth.suspicions).toStrictEqual([]);
    carol.edit((fragment) => insertPlainText(fragment, getPlainText(fragment).length, " (E)"));
    await run(5 * MINUTE, [alice, bob, carol]);
    expect(await requestsOf(port, "bob")).toHaveLength(ranOut.length + 1);
    expect(getPlainText(bob.fragment)).toBe("Plan (C) (D) (E)");
    expect(bob.syncHealth.suspicions).toStrictEqual([]);
  });

  it("also where Dave answered Bob's latest request with what he wrote: Dave's stream wakes nothing of Carol's, and her next edit brings what the gap waits for", {
    timeout: 60_000,
  }, async () => {
    const { port, alice, at } = await group(["bob", "carol", "dave"]);
    const [bob, carol, dave] = [at("bob"), at("carol"), at("dave")];
    const joined = (await requestsOf(port, "bob")).length;
    await carolWritesAndGoes(port, carol, ["alice", "bob", "dave"]);
    // Bob asks for Carol's change first; Dave, who lacks it too and reads only then, lets his own
    // requests for it go for Bob's (RSY-22).
    for (let waited = 0; (await requestsOf(port, "bob")).length === joined; waited += 1_000) {
      expect(waited).toBeLessThan(MINUTE);
      await run(1_000, [alice, bob]);
    }
    // Dave writes on for five minutes, each edit lost on its way to Bob and Alice, and his reports
    // too: he answers Bob's requests to all with it.
    port.loseReportsOf("dave", "bob", "alice");
    for (let tick = 0; tick < 30; tick++) {
      port.loseNextSendFor("bob", "alice");
      dave.edit((fragment) => insertPlainText(fragment, 0, "d"));
      await run(10_000, [alice, bob, dave]);
    }
    // What Bob lacks of Dave's he gets by his gap of Dave's stream; Carol's rests.
    await run(5 * MINUTE, [alice, bob, dave]);
    const ranOut = await requestsOf(port, "bob");
    expect(ranOut.slice(joined).filter((request) => request.all).length).toBeGreaterThanOrEqual(3);
    const latest = ranOut.at(-1) as ResyncRequestFrame;
    expect(await answerersOf(port, latest.requestId)).toContain("dave");
    expect(bob.syncHealth.suspicions).toMatchObject([
      { kind: "pending-gap", sender: "carol", resting: true },
    ]);
    await run(2 * HOUR, [alice, bob, dave], 10_000);
    expect(await requestsOf(port, "bob")).toHaveLength(ranOut.length);
    await carolBack(port, carol);
    carol.edit((fragment) => insertPlainText(fragment, getPlainText(fragment).length, " (E)"));
    await run(5 * MINUTE, [alice, bob, carol, dave]);
    expect(getPlainText(bob.fragment)).toContain("Plan (C) (D) (E)");
    expect(bob.syncHealth.suspicions.map((suspicion) => suspicion.kind)).not.toContain(
      "pending-gap",
    );
  });

  it("whose member is back but cannot bring it — her answers are lost on their way —: her edits wake it at most once in ten minutes, each wake one request to all", {
    timeout: 60_000,
  }, async () => {
    const { port, alice, at } = await group(["bob", "carol"]);
    const [bob, carol] = [at("bob"), at("carol")];
    const joined = (await requestsOf(port, "bob")).length;
    await carolWritesAndGoes(port, carol, ["alice", "bob"]);
    await run(10 * MINUTE, [alice, bob]);
    expect((await requestsOf(port, "bob")).length - joined).toBe(3);
    port.loseAnswersOf("carol", "alice", "bob");
    await carolBack(port, carol);
    // She writes every minute for an hour: each edit of hers carries her stream further.
    const writes = async (minutes: number) => {
      for (let minute = 0; minute < minutes; minute++) {
        carol.edit((fragment) => insertPlainText(fragment, 0, "c"));
        await run(MINUTE, [alice, bob, carol], 5_000);
      }
    };
    const back = (await requestsOf(port, "bob")).length;
    await writes(60);
    const woken = (await requestsOf(port, "bob")).slice(back);
    expect(woken.length).toBeGreaterThanOrEqual(5);
    expect(woken.length).toBeLessThanOrEqual(6);
    expect(woken.every((request) => request.all)).toBe(true);
    expect(bob.syncHealth.suspicions).toMatchObject([
      { kind: "pending-gap", sender: "carol", resting: true },
    ]);
  });
});
