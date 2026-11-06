import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import type {
  Delivery,
  DeliveryId,
  DocumentId,
  MemberId,
  MessengerPort,
  TransportProfile,
} from "@tdsp/messenger-port";
import {
  deletePlainText,
  encodeDeletions,
  encodeStateVector,
  encodeUpdate,
  getPlainText,
  insertPlainText,
  splitUpdate,
} from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerDelayMs, answerWindowMs } from "./answer-turn";
import { digestOf } from "./digest";
import {
  CURRENT_FRAME_VERSION,
  decodeFrame,
  encodeHeartbeatFrame,
  encodeResyncResponseFrame,
  type Frame,
  type ResyncRequestFrame,
  type ResyncResponseFrame,
} from "./framing";
import {
  DocumentEngine,
  type DocumentEngineOptions,
  MIN_MESSAGE_BYTES,
  type PersistedControlState,
} from "./index";

/**
 * Who answers a resync request, and when (SPECIFICATION.md RSY-6, RSY-20, RSY-21; Appendix B): the
 * creator's devices and the requester's own devices at once; everyone else only a request that
 * asks all — every request but the first of a bootstrap — at a turn derived from the request and its
 * own stream, and not at all once it heard an answer before its turn. Not a security test: how many
 * answers a request costs is a question of the budget (§1.7), not of who may do what.
 */

// The engine's random ids — its stream (LOS-13), then its requests' ids (RSY-16) — taken from this
// queue while it holds any, so a test can give an engine the stream and the request ids of the
// example in Appendix B.
const ids = vi.hoisted(() => ({ queue: [] as string[] }));
vi.mock("./framing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./framing")>();
  return { ...actual, newRandomId: () => ids.queue.shift() ?? actual.newRandomId() };
});

const DOC = "doc-1";
/** Sends and answers at once: each test sees the effect of a poll without waiting for a batch. */
const OPTS = { batchWindowMs: 0, resyncResponseThrottleMs: 0, creatorMemberId: "alice" };
// A bootstrap's own requests: the first and its five repeats (RSY-5).
const MAX_BOOTSTRAP_ATTEMPTS = 6;
/** Signal's suggested latency: a window of 60 s (Appendix B). */
const SIGNAL_LATENCY = { syncPolicy: { expectedLatencyMs: 10_000 } };

/** The example of Appendix B: a request to all, and two members' streams with their waits at 60 s. */
const EXAMPLE = {
  requestId: "c41d07e9a2b85f36",
  earlier: "5f3a9c0e12b47d68",
  requesterStream: "7e0d5b31a9c4f286",
  late: { stream: "0c4f9a2be81d7365", wait: 26_075 },
  early: { stream: "a91b3e70d24c6f58", wait: 6_436 },
} as const;

/**
 * The in-memory transport, with a member's view that can lack deliveries — one the network lost on
 * the way to that member alone — and an optional largest message.
 */
class Port implements MessengerPort {
  readonly inner = new InMemoryMessengerPort();
  readonly #lostFor = new Map<MemberId, Set<DeliveryId>>();
  #loseNextFor: MemberId | undefined;
  /** Every request anyone sends is held up on its way to these members, until `deliverLate`. */
  readonly requestsLostFor = new Set<MemberId>();
  #profile: TransportProfile | undefined;

  #failNextOf: MemberId | undefined;
  /** The next message `member` sends fails: nothing goes out. */
  failNextSendOf(member: MemberId): void {
    this.#failNextOf = member;
  }

  /** The next message anyone sends never reaches `member`. */
  loseNextSendFor(member: MemberId): void {
    this.#loseNextFor = member;
  }

  readonly #answersLost = new Map<MemberId, { to: MemberId; left: number }>();
  readonly #reportsLost: { from: MemberId; to: MemberId | undefined }[] = [];
  readonly #editsLost: { from: MemberId; to: MemberId }[] = [];

  /** Every edit `sender` sends from now on, from any of its devices, never reaches `member`. */
  loseEditsOf(sender: MemberId, member: MemberId): void {
    this.#editsLost.push({ from: sender, to: member });
  }

  /**
   * Every report `sender` sends from now on never reaches `member`, or anyone else: the change a
   * scenario lets go missing is not carried again by the report after it (SND-27).
   */
  loseReportsOf(sender: MemberId, member?: MemberId): void {
    this.#reportsLost.push({ from: sender, to: member });
  }

  /** The next `count` answers `sender` sends, of every piece, never reach `member`. */
  loseAnswersOf(sender: MemberId, member: MemberId, count = 1): void {
    this.#answersLost.set(sender, { to: member, left: count });
  }

  /** What was lost on its way to `member` so far reaches it after all, late: a message the network held up. */
  deliverLate(member: MemberId): void {
    this.#lostFor.delete(member);
  }

  /** Nothing sent so far ever reaches `member` — a device that sees no history, as Signal's. */
  async hideHistoryFrom(member: MemberId): Promise<void> {
    const lost = this.#lostFor.get(member) ?? new Set();
    for (const delivery of await this.inner.receive(DOC, member)) lost.add(delivery.id);
    this.#lostFor.set(member, lost);
  }

  /** A transport that carries at most `maxBytes` a message (SND-17). */
  limitTo(maxBytes: number): void {
    this.#profile = {
      bounds: { minIntervalMs: null, maxBytes },
      pacing: {
        minIntervalMs: 0,
        maxIntervalMs: null,
        minChars: 0,
        maxChars: null,
        expectedLatencyMs: 0,
      },
    };
  }

  async transportProfile(): Promise<TransportProfile | undefined> {
    return this.#profile;
  }
  createDocument(documentId: DocumentId, creator: MemberId): Promise<void> {
    return this.inner.createDocument(documentId, creator);
  }
  async send(documentId: DocumentId, sender: MemberId, payload: string): Promise<DeliveryId> {
    if (this.#failNextOf === sender) {
      this.#failNextOf = undefined;
      throw new Error("the network is unreachable");
    }
    const limit = this.#profile?.bounds.maxBytes;
    if (limit !== undefined && limit !== null && payload.length > limit) {
      throw new Error(`a message of ${payload.length} bytes, over ${limit}`);
    }
    const id = await this.inner.send(documentId, sender, payload);
    if (decodeFrame(payload).kind === "resync-request") {
      for (const member of this.requestsLostFor) {
        const hidden = this.#lostFor.get(member) ?? new Set();
        hidden.add(id);
        this.#lostFor.set(member, hidden);
      }
    }
    for (const lost of this.#reportsLost) {
      if (lost.from !== sender || decodeFrame(payload).kind !== "heartbeat") continue;
      const members =
        lost.to === undefined
          ? ["alice", "bob", "carol", "dave", "erin", "gina"].filter((m) => m !== sender)
          : [lost.to];
      for (const member of members) {
        const hidden = this.#lostFor.get(member) ?? new Set();
        hidden.add(id);
        this.#lostFor.set(member, hidden);
      }
    }
    for (const lost of this.#editsLost) {
      if (lost.from !== sender || decodeFrame(payload).kind !== "edit") continue;
      const hidden = this.#lostFor.get(lost.to) ?? new Set();
      hidden.add(id);
      this.#lostFor.set(lost.to, hidden);
    }
    const answers = this.#answersLost.get(sender);
    if (answers !== undefined && answers.left > 0) {
      const frame = decodeFrame(payload);
      if (frame.kind === "resync-response") {
        const lost = this.#lostFor.get(answers.to) ?? new Set();
        lost.add(id);
        this.#lostFor.set(answers.to, lost);
        // An answer in pieces counts once, at its last piece.
        if (frame.pieces === null || frame.pieces === frame.piece) answers.left -= 1;
      }
    }
    if (this.#loseNextFor !== undefined) {
      const lost = this.#lostFor.get(this.#loseNextFor) ?? new Set();
      lost.add(id);
      this.#lostFor.set(this.#loseNextFor, lost);
      this.#loseNextFor = undefined;
    }
    return id;
  }
  async receive(documentId: DocumentId, member: MemberId): Promise<readonly Delivery[]> {
    const lost = this.#lostFor.get(member);
    const all = await this.inner.receive(documentId, member);
    return lost === undefined ? all : all.filter((delivery) => !lost.has(delivery.id));
  }
  listChannels(member: MemberId) {
    return this.inner.listChannels(member);
  }
}

/** Every frame on the channel, with its sender, in the order sent. */
async function channel(port: Port): Promise<{ sender: MemberId; frame: Frame; payload: string }[]> {
  return (await port.inner.receive(DOC, "observer")).map((delivery) => ({
    sender: delivery.sender,
    frame: decodeFrame(delivery.payload),
    payload: delivery.payload,
  }));
}

/** The requests `sender` made, in order. */
async function requestsOf(port: Port, sender: MemberId): Promise<ResyncRequestFrame[]> {
  return (await channel(port))
    .filter(({ sender: from, frame }) => from === sender && frame.kind === "resync-request")
    .map(({ frame }) => frame as ResyncRequestFrame);
}

/** The answers to `requestId`, one per responder and answer, whatever pieces they came in. */
async function answersTo(
  port: Port,
  requestId: string,
): Promise<{ sender: MemberId; last: ResyncResponseFrame }[]> {
  const answers = new Map<string, { sender: MemberId; last: ResyncResponseFrame }>();
  for (const { sender, frame } of await channel(port)) {
    if (frame.kind === "resync-response" && frame.respondsTo === requestId) {
      const key = `${sender}:${frame.stream}:${frame.sequence}`;
      if (frame.pieces !== null || !answers.has(key)) answers.set(key, { sender, last: frame });
    }
  }
  return [...answers.values()];
}

/** Each engine's poll, in order, as its application makes it; then whatever they sent goes out. */
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

/** `member` joins, its engine taking `randomIds` first: its stream, then its first request's id. */
async function joinAs(
  port: Port,
  member: MemberId,
  options: DocumentEngineOptions = {},
  ...randomIds: string[]
): Promise<DocumentEngine> {
  ids.queue.push(...randomIds);
  const engine = await DocumentEngine.join(DOC, member, port, undefined, { ...OPTS, ...options });
  expect(ids.queue, "every id given was taken").toStrictEqual([]);
  return engine;
}

/**
 * Alice creates the document with "Plan" in it, `tail` after it, and lets every one of `online` and
 * `granted` write; each of `online` joins, is answered and is bootstrapped.
 */
async function group(
  online: readonly MemberId[],
  {
    granted = [],
    streams = {},
    port = new Port(),
    tail = "",
    clients = {},
  }: {
    granted?: readonly MemberId[];
    /** A member's stream (LOS-13), where a test fixes it. */
    streams?: Partial<Record<MemberId, string>>;
    port?: Port;
    tail?: string;
    /**
     * A member's CRDT client, where a test fixes it before the member writes: what a test shows may
     * depend on how the clients compare.
     */
    clients?: Partial<Record<MemberId, number>>;
  } = {},
) {
  const alice = await DocumentEngine.create(DOC, "alice", port, undefined, OPTS);
  if (clients.alice !== undefined) alice.document.clientID = clients.alice;
  for (const member of new Set([...online, ...granted])) {
    await alice.setMembership(member, "write");
  }
  alice.edit((fragment) => insertPlainText(fragment, 0, `Plan${tail}`));
  const members = new Map<MemberId, DocumentEngine>();
  for (const member of online) {
    const stream = streams[member];
    if (stream !== undefined) ids.queue.push(stream);
    const engine = await DocumentEngine.join(DOC, member, port, undefined, OPTS);
    const client = clients[member];
    if (client !== undefined) engine.document.clientID = client;
    members.set(member, engine);
  }
  for (let round = 0; round < 4; round++) await poll(alice, ...members.values());
  for (const [member, engine] of members) {
    expect(engine.hasCompletedBootstrap, member).toBe(true);
    expect(getPlainText(engine.fragment), member).toBe(`Plan${tail}`);
  }
  const at = (member: MemberId): DocumentEngine => {
    const engine = members.get(member);
    if (engine === undefined) throw new Error(`${member} is not online`);
    return engine;
  };
  return { port, alice, at };
}

/** The creator goes away: nothing of hers runs any more, and nothing reaches her. */
function creatorAway(port: Port, alice: DocumentEngine): void {
  alice.dispose();
  port.inner.disconnect("alice");
}

/**
 * A device of the creator starts without content — a new one, or one whose content was not
 * persisted — on a transport that shows it nothing sent before (Signal's): only an answer brings
 * the content.
 */
async function creatorDeviceWithoutHistory(port: Port): Promise<void> {
  port.inner.reconnect("alice");
  await port.hideHistoryFrom("alice");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-26T10:00:00Z"));
  ids.queue.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("who answers a request, and when (RSY-6, RSY-20)", () => {
  it("a member's new device, asking without all: the creator and the member's own device answer at once, no other member ever", async () => {
    const { port, alice, at } = await group(["bob", "carol", "dave"]);
    const bob2 = await joinAs(port, "bob");
    const [request] = (await requestsOf(port, "bob")).slice(-1);
    expect(request?.all).toBe(false);
    assert(request);

    await poll(alice, at("bob"), at("carol"), at("dave"));
    const answeredAtOnce = (await answersTo(port, request.requestId)).map((a) => a.sender);
    expect(answeredAtOnce.sort()).toStrictEqual(["alice", "bob"]);
    await poll(bob2);
    expect(bob2.hasCompletedBootstrap).toBe(true);

    await run(10 * 60_000, [alice, at("bob"), at("carol"), at("dave"), bob2], 10_000);
    expect((await answersTo(port, request.requestId)).map((a) => a.sender).sort()).toStrictEqual([
      "alice",
      "bob",
    ]);
    expect((await requestsOf(port, "bob")).filter((r) => r.all)).toStrictEqual([]);
  });

  it("a new device of the creator, asking without all: the creator's other device answers at once, no member ever", async () => {
    const { port, alice, at } = await group(["carol", "dave"]);
    const alice2 = await joinAs(port, "alice");
    const [request] = (await requestsOf(port, "alice")).slice(-1);
    expect(request?.all).toBe(false);
    assert(request);

    await run(10 * 60_000, [alice, at("carol"), at("dave"), alice2], 10_000);
    expect((await answersTo(port, request.requestId)).map((a) => a.sender)).toStrictEqual([
      "alice",
    ]);
    expect(alice2.controlStanding).toStrictEqual({ kind: "bootstrapped" }); // the answer of another device of the creator (RSY-14)
    expect(getPlainText(alice2.fragment)).toBe("Plan");
  });

  it("a request to all: each member answers at its turn — the example of Appendix B — and one that hears an answer first stays silent", async () => {
    const { port, alice } = await group([], { granted: ["carol", "dave", "gina"] });
    // Carol and Dave with the streams of the example, and Signal's latency.
    const carol = await joinAs(port, "carol", SIGNAL_LATENCY, EXAMPLE.late.stream);
    const dave = await joinAs(port, "dave", SIGNAL_LATENCY, EXAMPLE.early.stream);
    await poll(alice, carol, dave, alice, carol, dave);
    expect(carol.hasCompletedBootstrap && dave.hasCompletedBootstrap).toBe(true);
    expect(answerWindowMs(10_000)).toBe(60_000);
    creatorAway(port, alice);

    const gina = await joinAs(
      port,
      "gina",
      { autoResync: false },
      EXAMPLE.requesterStream,
      EXAMPLE.earlier,
    );
    // Not theirs to answer: nobody does, and the request expires (RSY-4).
    await run(10_000, [carol, dave, gina]);
    expect(await answersTo(port, EXAMPLE.earlier)).toStrictEqual([]);
    expect(gina.syncHealth.resync.lastOutcome).toBe("unanswered");

    ids.queue.push(EXAMPLE.requestId);
    await gina.requestResync();
    const [toAll] = (await requestsOf(port, "gina")).slice(-1);
    expect(toAll).toMatchObject({
      requestId: EXAMPLE.requestId,
      all: true,
      stream: EXAMPLE.requesterStream,
    });

    await poll(carol, dave); // both hear it now
    await vi.advanceTimersByTimeAsync(EXAMPLE.early.wait - 1);
    await poll(dave, carol);
    expect(await answersTo(port, EXAMPLE.requestId)).toStrictEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await poll(dave);
    const answers = await answersTo(port, EXAMPLE.requestId);
    expect(answers.map((a) => a.sender)).toStrictEqual(["dave"]);
    // A bootstrapped member's answer carries its snapshot (RSY-8).
    expect(answers[0]?.last.control).not.toBeNull();

    // Carol heard Dave's answer before her turn, 26 075 ms after the request: she stays silent.
    await poll(carol);
    await run(2 * 60_000, [carol, dave, gina]);
    expect((await answersTo(port, EXAMPLE.requestId)).map((a) => a.sender)).toStrictEqual(["dave"]);
    expect(getPlainText(gina.fragment)).toBe("Plan");
  });

  it("the creator, and the requester's own device, answer a request to all at once; the members then stay silent", async () => {
    const { port, alice, at } = await group(["bob", "carol", "dave"]);
    // A device of Bob that asks all at once, as RSY-21 does not let it.
    port.inner.modifyNextSend("bob", (payload) => payload.replace('"all":false', '"all":true'));
    await joinAs(port, "bob");
    const [request] = (await requestsOf(port, "bob")).slice(-1);
    expect(request?.all).toBe(true);
    assert(request);

    await poll(at("carol"), at("dave"), alice, at("bob"));
    expect((await answersTo(port, request.requestId)).map((a) => a.sender).sort()).toStrictEqual([
      "alice",
      "bob",
    ]);
    // The members hear those answers before any time passes, so before every turn.
    await poll(at("carol"), at("dave"));
    await run(5 * 60_000, [alice, at("bob"), at("carol"), at("dave")]);
    expect((await answersTo(port, request.requestId)).map((a) => a.sender).sort()).toStrictEqual([
      "alice",
      "bob",
    ]);
  });

  it("a new device of the creator: nobody answers its first request; Carol answers its repeat to all at her turn, with the content and her control state, which it merges but which bootstraps it not (RSY-21, CTL-25, CTL-27)", async () => {
    const { port, alice, at } = await group(["carol"], { granted: ["gina"] });
    creatorAway(port, alice);
    await creatorDeviceWithoutHistory(port);
    const alice2 = await joinAs(port, "alice");
    await run(70_000, [at("carol"), alice2]);
    expect((await requestsOf(port, "alice")).slice(0, 2).map((r) => r.all)).toStrictEqual([
      false,
      true,
    ]);
    expect(getPlainText(alice2.fragment)).toBe("Plan");
    expect(alice2.hasCompletedBootstrap).toBe(false);
    expect(alice2.controlStanding).toStrictEqual({ kind: "none" });
    expect(alice2.permissionOf("gina")).toBe("write");

    // Not bootstrapped, it answers a joiner at once with the content alone (RSY-8, RSY-14): Carol's
    // answer at her turn bootstraps the joiner.
    const gina = await joinAs(port, "gina");
    const [request] = (await requestsOf(port, "gina")).slice(-1);
    assert(request);
    await poll(alice2);
    const answers = await answersTo(port, request.requestId);
    expect(answers.map((a) => a.sender)).toStrictEqual(["alice"]);
    expect(answers[0]?.last.control).toBeNull();
    await poll(gina);
    expect(gina.controlStanding).toStrictEqual({ kind: "none" });
    await run(2 * 60_000, [at("carol"), alice2, gina]);
    expect(gina.controlStanding).toStrictEqual({ kind: "bootstrapped" });
    expect(gina.permissionOf("gina")).toBe("write");
  });

  it("a device of the creator that is not bootstrapped answers at once, with content and without control state (RSY-8)", async () => {
    const { port, alice } = await group([], { granted: ["gina"] });
    const content = encodeUpdate(alice.document);
    creatorAway(port, alice);
    // A new device of the creator, given the content but none of the control state.
    await creatorDeviceWithoutHistory(port);
    const alice2 = await joinAs(port, "alice", { restore: { state: content } });
    expect(alice2.controlStanding).toStrictEqual({ kind: "none" });

    const gina = await joinAs(port, "gina");
    const [request] = (await requestsOf(port, "gina")).slice(-1);
    expect(request?.all).toBe(false);
    assert(request);
    await poll(alice2);
    const answers = await answersTo(port, request.requestId);
    expect(answers.map((a) => a.sender)).toStrictEqual(["alice"]);
    expect(answers[0]?.last.control).toBeNull();
    await poll(gina);
    expect(getPlainText(gina.fragment)).toBe("Plan");
    expect(gina.hasCompletedBootstrap).toBe(false); // content alone bootstraps no one (CTL-13)
  });
});

describe("when a request asks all (RSY-21, RSY-4)", () => {
  it("never the first request of a bootstrap; every repeat after one went unanswered, which waits out the window too", async () => {
    const { port, alice } = await group([], { granted: ["gina"] });
    creatorAway(port, alice);
    const gina = await joinAs(port, "gina");
    const first = gina.syncHealth.resync;
    expect((first.expiresAt ?? 0) - (first.requestedAt ?? 0)).toBe(10_000); // the expiry (RSY-4)
    await run(10_000, [gina]);
    // The repeat holds the slot for the expiry and, since it asks all, the window (RSY-4, RSY-20).
    const repeat = gina.syncHealth.resync;
    expect(repeat).toMatchObject({ state: "requested", automatic: true });
    expect((repeat.expiresAt ?? 0) - (repeat.requestedAt ?? 0)).toBe(10_000 + 30_000);

    await run(60 * 60_000, [gina], 5_000);
    const asked = (await requestsOf(port, "gina")).map((r) => r.all);
    expect(asked).toStrictEqual([false, true, true, true, true, true]); // bounded (RSY-5)
  });

  it("a joiner whose attempts ran out asks all once more when it reads someone again after its last request expired, and is brought up (RSY-5)", async () => {
    const { port, alice } = await group([], { granted: ["gina"] });
    // Everyone else is out of reach as Gina joins, for two hours.
    port.inner.disconnect("alice");
    const gina = await joinAs(port, "gina");
    await run(2 * 60 * 60_000, [alice, gina], 60_000);
    const before = await requestsOf(port, "gina");
    expect(before.map((r) => r.all)).toStrictEqual([false, true, true, true, true, true]);
    expect(gina.hasCompletedBootstrap).toBe(false);
    // Its attempts ran out: its application shows it and offers to ask again (RSY-5).
    expect(gina.syncHealth.attemptsRanOut).toBe(true);
    // The creator is back and writes. What she answers to the requests she reads only now, Gina no
    // longer keeps as her own (RSY-12); her frames show Gina that someone is there.
    port.inner.reconnect("alice");
    alice.edit((fragment) => insertPlainText(fragment, 4, "!"));
    await run(5 * 60_000, [alice, gina], 5_000);
    const after = (await requestsOf(port, "gina")).slice(before.length);
    expect(after.map((r) => r.all)).toStrictEqual([true]);
    expect(gina.hasCompletedBootstrap).toBe(true);
    expect(getPlainText(gina.fragment)).toBe("Plan!");
    expect(gina.syncHealth.attemptsRanOut).toBeUndefined();
  });

  it("answers with content alone are answers too: a joiner whose attempts ran out asks no more while the one who answers it writes on (RSY-5)", {
    timeout: 60_000,
  }, async () => {
    // Hours simulated under fake timers, polled every few seconds: CPU-bound, slow only on a loaded machine.
    const { port, alice } = await group([], { granted: ["gina"] });
    creatorAway(port, alice);
    await port.hideHistoryFrom("gina");
    const gina = await joinAs(port, "gina");
    const answered = new Set<string>();
    for (let passed = 0; passed < 60 * 60_000; passed += 5_000) {
      for (const request of await requestsOf(port, "gina")) {
        if (answered.has(request.requestId)) continue;
        answered.add(request.requestId);
        // Mallory answers every request at once with content alone, which bootstraps nobody (CTL-13).
        await port.send(
          DOC,
          "mallory",
          encodeResyncResponseFrame({
            documentId: DOC,
            respondsTo: request.requestId,
            update: new Uint8Array([0, 0]),
            control: null,
            state: {
              stateVector: new Uint8Array([0]),
              stateDigest: digestOf(new Uint8Array([0, 0])),
            },
          }),
        );
      }
      if (passed % 60_000 === 0) {
        // ...and writes once a minute, so Gina keeps reading someone.
        await port.send(
          DOC,
          "mallory",
          encodeHeartbeatFrame({
            documentId: DOC,
            controlClock: null,
            controlDigest: null,
            stream: "0123456789abcdef",
            sequence: passed / 60_000 + 1,
            stateVector: new Uint8Array([0]),
            stateDigest: digestOf(new Uint8Array([0, 0])),
          }),
        );
      }
      await vi.advanceTimersByTimeAsync(5_000);
      await poll(gina);
    }
    expect(gina.hasCompletedBootstrap).toBe(false);
    expect((await requestsOf(port, "gina")).length).toBeLessThanOrEqual(MAX_BOOTSTRAP_ATTEMPTS);
  });

  it("a member that writes on and never answers costs a joiner whose attempts ran out a few further requests, their waits doubling on up to the cap — not one per expiry (RSY-5, LOS-6)", {
    timeout: 60_000,
  }, async () => {
    // Hours simulated under fake timers, polled every few seconds: CPU-bound, slow only on a loaded machine.
    const { port, alice } = await group([], { granted: ["gina"] });
    creatorAway(port, alice);
    await port.hideHistoryFrom("gina");
    const gina = await joinAs(port, "gina");
    expect(gina.syncHealth.attemptsRanOut).toBeUndefined();
    const askedAt: number[] = [Date.now()];
    for (let passed = 0; passed < 2 * 60 * 60_000; passed += 5_000) {
      if (passed % 60_000 === 0) {
        // Mallory answers nothing, and writes once a minute, so Gina keeps reading someone.
        await port.send(
          DOC,
          "mallory",
          encodeHeartbeatFrame({
            documentId: DOC,
            controlClock: null,
            controlDigest: null,
            stream: "0123456789abcdef",
            sequence: passed / 60_000 + 1,
            stateVector: new Uint8Array([0]),
            stateDigest: digestOf(new Uint8Array([0, 0])),
          }),
        );
      }
      await vi.advanceTimersByTimeAsync(5_000);
      await poll(gina);
      const asked = (await requestsOf(port, "gina")).length;
      while (askedAt.length < asked) askedAt.push(Date.now());
    }
    expect(gina.hasCompletedBootstrap).toBe(false);
    expect(gina.syncHealth.attemptsRanOut).toBe(true);
    // Its attempts, then further requests on Mallory's frames: the first after 2^5 expiries of
    // 10 s, each later one after twice the wait before, never more than 10 min (Appendix B) —
    // seventeen in two hours, where one per expiry would be 119.
    expect(askedAt.map((at) => (at - (askedAt[0] as number)) / 1_000)).toStrictEqual([
      0, 10, 50, 90, 170, 330, 650, 1_250, 1_850, 2_450, 3_050, 3_650, 4_250, 4_850, 5_450, 6_050,
      6_650,
    ]);
    expect(askedAt).toHaveLength(17);
    const further = askedAt.slice(MAX_BOOTSTRAP_ATTEMPTS - 1);
    expect(further.length).toBeGreaterThan(2);
    const waits = further.slice(1).map((at, i) => at - (further[i] as number));
    for (const [i, wait] of waits.entries()) {
      expect(wait, `further request ${i + 1}`).toBeGreaterThanOrEqual(
        Math.min(600_000, 10_000 * 2 ** (i + 5)),
      );
    }
    // About one every 10 min once the waits reached the cap: not one per minute that Mallory writes.
    expect(askedAt.length).toBeLessThanOrEqual(MAX_BOOTSTRAP_ATTEMPTS + 12);
  });

  it("a further request whose send failed asked nobody: the next poll asks again, the further requests go on from it at their doubling waits, and once the creator is back and writes the joiner is brought up (RSY-5, RSY-4)", {
    timeout: 60_000,
  }, async () => {
    // Hours simulated under fake timers, polled every few seconds: CPU-bound, slow only on a loaded machine.
    const { port, alice } = await group([], { granted: ["gina"] });
    port.inner.disconnect("alice");
    await port.hideHistoryFrom("gina");
    const gina = await joinAs(port, "gina");
    let failed = false;
    const askedAt: number[] = [Date.now()];
    for (let passed = 0; passed < 2 * 60 * 60_000; passed += 5_000) {
      if (passed % 60_000 === 0) {
        // Mallory answers nothing, and writes once a minute, so Gina keeps reading someone.
        await port.send(
          DOC,
          "mallory",
          encodeHeartbeatFrame({
            documentId: DOC,
            controlClock: null,
            controlDigest: null,
            stream: "0123456789abcdef",
            sequence: passed / 60_000 + 1,
            stateVector: new Uint8Array([0]),
            stateDigest: digestOf(new Uint8Array([0, 0])),
          }),
        );
      }
      await vi.advanceTimersByTimeAsync(5_000);
      await poll(gina);
      const sent = (await requestsOf(port, "gina")).length;
      while (askedAt.length < sent) askedAt.push(Date.now());
      // Once its attempts ran out, the first further request cannot be sent (at 650 s).
      if (!failed && (await requestsOf(port, "gina")).length === MAX_BOOTSTRAP_ATTEMPTS) {
        port.failNextSendOf("gina");
        failed = true;
      }
    }
    // The failed one counted for nothing: the next poll asked again, 5 s later, and the further
    // requests went on from there, one every 10 min — counted as an attempt, the next would have waited
    // a whole 10 min.
    expect(askedAt.map((at) => (at - (askedAt[0] as number)) / 1_000)).toStrictEqual([
      0, 10, 50, 90, 170, 330, 655, 1_255, 1_855, 2_455, 3_055, 3_655, 4_255, 4_855, 5_455, 6_055,
      6_655,
    ]);
    expect(gina.hasCompletedBootstrap).toBe(false);
    // The creator is back and writes for half an hour: her frames bring a further request, which she
    // answers, and Gina is brought up.
    port.inner.reconnect("alice");
    for (let minute = 0; minute < 30 && !gina.hasCompletedBootstrap; minute++) {
      alice.edit((fragment) => insertPlainText(fragment, 4, "!"));
      await run(60_000, [alice, gina], 5_000);
    }
    expect(gina.hasCompletedBootstrap).toBe(true);
    expect(gina.syncHealth.attemptsRanOut).toBeUndefined();
  });

  it("a request of the person whose send failed changes nothing: a joiner answered with content alone still asks no more while someone writes (RSY-5, RSY-4)", {
    timeout: 60_000,
  }, async () => {
    // Hours simulated under fake timers, polled every few seconds: CPU-bound, slow only on a loaded machine.
    const { port, alice } = await group([], { granted: ["gina"] });
    creatorAway(port, alice);
    await port.hideHistoryFrom("gina");
    const gina = await joinAs(port, "gina");
    const answered = new Set<string>();
    const answerAll = async (): Promise<void> => {
      for (const request of await requestsOf(port, "gina")) {
        if (answered.has(request.requestId)) continue;
        answered.add(request.requestId);
        // Mallory answers every request at once with content alone, which bootstraps nobody (CTL-13).
        await port.send(
          DOC,
          "mallory",
          encodeResyncResponseFrame({
            documentId: DOC,
            respondsTo: request.requestId,
            update: new Uint8Array([0, 0]),
            control: null,
            state: {
              stateVector: new Uint8Array([0]),
              stateDigest: digestOf(new Uint8Array([0, 0])),
            },
          }),
        );
      }
    };
    const minutes = async (from: number, count: number): Promise<void> => {
      for (let passed = from; passed < from + count * 60_000; passed += 5_000) {
        await answerAll();
        if (passed % 60_000 === 0) {
          // ...and writes once a minute, so Gina keeps reading someone.
          await port.send(
            DOC,
            "mallory",
            encodeHeartbeatFrame({
              documentId: DOC,
              controlClock: null,
              controlDigest: null,
              stream: "0123456789abcdef",
              sequence: passed / 60_000 + 1,
              stateVector: new Uint8Array([0]),
              stateDigest: digestOf(new Uint8Array([0, 0])),
            }),
          );
        }
        await vi.advanceTimersByTimeAsync(5_000);
        await poll(gina);
      }
    };
    await minutes(0, 20);
    expect((await requestsOf(port, "gina")).length).toBe(MAX_BOOTSTRAP_ATTEMPTS);
    // Its person asks; the send fails, and nothing went out.
    port.failNextSendOf("gina");
    await expect(gina.requestResync()).rejects.toThrow("the network is unreachable");
    // Its latest request that went out was answered: it asks no more for the next 40 min either.
    await minutes(20 * 60_000, 40);
    expect(gina.hasCompletedBootstrap).toBe(false);
    expect((await requestsOf(port, "gina")).length).toBe(MAX_BOOTSTRAP_ATTEMPTS);
  });

  it("`attemptsRanOut` only while no request of its own holds the slot: not before the last attempt had its time, not during a further request, and a person's request then goes out (RSY-5, RSY-3)", {
    timeout: 60_000,
  }, async () => {
    // Hours simulated under fake timers, polled every few seconds: CPU-bound, slow only on a loaded machine.
    const { port, alice } = await group([], { granted: ["gina"] });
    creatorAway(port, alice);
    await port.hideHistoryFrom("gina");
    const gina = await joinAs(port, "gina");
    const start = Date.now();
    const seen: { at: number; ranOut: boolean; requested: boolean }[] = [];
    for (let passed = 0; passed < 15 * 60_000; passed += 5_000) {
      if (passed % 60_000 === 0) {
        // Mallory answers nothing, and writes once a minute: a further request follows at 650 s.
        await port.send(
          DOC,
          "mallory",
          encodeHeartbeatFrame({
            documentId: DOC,
            controlClock: null,
            controlDigest: null,
            stream: "0123456789abcdef",
            sequence: passed / 60_000 + 1,
            stateVector: new Uint8Array([0]),
            stateDigest: digestOf(new Uint8Array([0, 0])),
          }),
        );
      }
      await vi.advanceTimersByTimeAsync(5_000);
      await poll(gina);
      seen.push({
        at: (Date.now() - start) / 1_000,
        ranOut: gina.syncHealth.attemptsRanOut === true,
        requested: gina.syncHealth.resync.state === "requested",
      });
    }
    // The last attempt went out at 330 s and asked all: its time is 40 s. Before 370 s, never.
    expect(seen.filter(({ at }) => at < 370).some(({ ranOut }) => ranOut)).toBe(false);
    // From then on, exactly while no request holds the slot — the further one at 650 s did.
    const after = seen.filter(({ at }) => at >= 370);
    for (const { at, ranOut, requested } of after) expect(ranOut, `at ${at} s`).toBe(!requested);
    expect(after.some(({ requested }) => requested)).toBe(true);
    expect(gina.syncHealth.attemptsRanOut).toBe(true);
    // Its application offers to ask again: the person's request goes out, not coalesced.
    expect(await gina.requestResync()).toStrictEqual({ sent: true });
    expect(gina.syncHealth.attemptsRanOut).toBeUndefined();
    await run(60_000, [gina], 5_000);
    expect(gina.syncHealth.attemptsRanOut).toBe(true);
  });

  it("`attemptsRanOut` for a new device of the creator that nobody bootstraps: set once its last attempt had its time, while it is not bootstrapped (RSY-5, CTL-43)", {
    timeout: 60_000,
  }, async () => {
    // Hours simulated under fake timers, polled every few seconds: CPU-bound, slow only on a loaded machine.
    const { port, alice } = await group([]);
    creatorAway(port, alice);
    await creatorDeviceWithoutHistory(port);
    const newDevice = await joinAs(port, "alice");
    const start = Date.now();
    const ranOutAt: number[] = [];
    for (let passed = 0; passed < 10 * 60_000; passed += 5_000) {
      await vi.advanceTimersByTimeAsync(5_000);
      await poll(newDevice);
      if (newDevice.syncHealth.attemptsRanOut === true) ranOutAt.push((Date.now() - start) / 1_000);
    }
    expect((await requestsOf(port, "alice")).length).toBe(MAX_BOOTSTRAP_ATTEMPTS);
    expect(newDevice.controlStanding.kind).toBe("none");
    expect(ranOutAt[0]).toBe(370);
    expect(ranOutAt).toHaveLength((600 - 370) / 5 + 1);
    expect(await newDevice.requestResync()).toStrictEqual({ sent: true });
    expect(newDevice.syncHealth.attemptsRanOut).toBeUndefined();
  });

  it("a creator that restarts with its bootstrapped control state but without its content is bootstrapped at once and returns: its first request asks all, and a member brings the content", async () => {
    const { port, alice, at } = await group(["carol", "dave"]);
    const control: PersistedControlState = {
      tdsp: CURRENT_FRAME_VERSION,
      profile: alice.profile,
      control: { closed: alice.controlState.closed, targets: alice.controlState.targets },
      device: alice.deviceTag,
      clock: alice.controlClock,
      bootstrapped: true,
    };
    creatorAway(port, alice);
    await creatorDeviceWithoutHistory(port);
    const restarted = await joinAs(port, "alice", { controlState: control });
    // Its control state was bootstrapped when persisted: so is the device, at once (RSY-14, CTL-26).
    expect(restarted.hasCompletedBootstrap).toBe(true);
    const [first] = (await requestsOf(port, "alice")).slice(-1);
    // It may lack everything, and nothing shows it: a return (RSY-21).
    expect(first?.all).toBe(true);
    assert(first);

    await run(60_000, [at("carol"), at("dave"), restarted]);
    const toAll = (await requestsOf(port, "alice")).filter((r) => r.all);
    expect(toAll.length).toBe(1);
    const [onlyToAll] = toAll;
    assert(onlyToAll);
    const answers = await answersTo(port, onlyToAll.requestId);
    expect(answers.length).toBeGreaterThanOrEqual(1);
    expect(answers.length).toBeLessThanOrEqual(2);
    expect(getPlainText(restarted.fragment)).toBe("Plan");
    expect(restarted.hasCompletedBootstrap).toBe(true);
  });

  it("after the bootstrap, every request of the person asks all; only the first of a bootstrap does not", async () => {
    const { port, alice, at } = await group(["carol"], { granted: ["gina"] });
    const gina = await joinAs(port, "gina");
    await poll(alice, gina);
    expect(gina.hasCompletedBootstrap).toBe(true);
    creatorAway(port, alice);
    for (let i = 0; i < 3; i++) {
      await run(45_000, [at("carol"), gina]); // a request to all holds the slot for 40 s here (RSY-4)
      expect(await gina.requestResync()).toEqual({ sent: true });
    }
    await run(45_000, [at("carol"), gina]);
    expect(gina.syncHealth.suspicions).toStrictEqual([]);
    expect((await requestsOf(port, "gina")).map((r) => r.all)).toStrictEqual([
      false,
      true,
      true,
      true,
    ]);
  });

  it("every request for a gap asks all, from its first; a later gap asks with tries of its own (RSY-21, LOS-6)", async () => {
    const { port, alice, at } = await group(["carol", "dave"]);
    const [carol, dave] = [at("carol"), at("dave")];
    creatorAway(port, alice);

    // Dave's first edit never reaches Carol, his second does: a gap (LOS-2).
    port.loseNextSendFor("carol");
    dave.edit((fragment) => insertPlainText(fragment, 4, " A"));
    await vi.advanceTimersByTimeAsync(0);
    dave.edit((fragment) => insertPlainText(fragment, 6, "B"));
    await run(90_000, [carol, dave]);
    const forFirstGap = (await requestsOf(port, "carol")).slice(1); // after her join
    expect(forFirstGap.map((r) => r.all)).toStrictEqual([true]);
    expect(getPlainText(carol.fragment)).toBe("Plan AB"); // Dave answered the request to all
    expect(carol.syncHealth.suspicions).toStrictEqual([]);

    port.loseNextSendFor("carol");
    dave.edit((fragment) => insertPlainText(fragment, 7, " C"));
    await vi.advanceTimersByTimeAsync(0);
    dave.edit((fragment) => insertPlainText(fragment, 9, "D"));
    await run(90_000, [carol, dave]);
    const forSecondGap = (await requestsOf(port, "carol")).slice(1 + forFirstGap.length);
    expect(forSecondGap.map((r) => r.all)).toStrictEqual([true]);
    expect(getPlainText(carol.fragment)).toBe("Plan AB CD");
  });
});

describe("what silences a member waiting for its turn (RSY-20)", () => {
  it("an answer without control state does not, where the request states no control clock: Mallory answers every request of Gina's new device at once with content alone, and Carol still brings it up", async () => {
    const { port, alice, at } = await group(["carol"], { granted: ["gina"] });
    creatorAway(port, alice);
    await port.hideHistoryFrom("gina");
    const gina = await joinAs(port, "gina");
    const answered = new Set<string>();
    for (let passed = 0; passed < 10 * 60_000; passed += 1_000) {
      for (const request of await requestsOf(port, "gina")) {
        if (answered.has(request.requestId)) continue;
        answered.add(request.requestId);
        await port.send(
          DOC,
          "mallory",
          encodeResyncResponseFrame({
            documentId: DOC,
            respondsTo: request.requestId,
            update: new Uint8Array([0, 0]),
            control: null,
            // Whole, from a device that holds nothing: no evidence of its own (RSY-18, LOS-14).
            state: {
              stateVector: new Uint8Array([0]),
              stateDigest: digestOf(new Uint8Array([0, 0])),
            },
          }),
        );
      }
      await vi.advanceTimersByTimeAsync(1_000);
      await poll(at("carol"), gina);
    }
    expect((await requestsOf(port, "gina")).map((request) => request.all)).toStrictEqual([
      false,
      true,
    ]);
    expect(gina.hasCompletedBootstrap).toBe(true);
    expect(gina.controlStanding.kind).toBe("bootstrapped");
    expect(getPlainText(gina.fragment)).toBe("Plan");
  });

  it("a request to all in the bootstrap keeps its slot when an answer ends nothing: the joiner asks no more before the members' turns came", async () => {
    const { port, alice, at } = await group(["carol"], { granted: ["gina"] });
    creatorAway(port, alice);
    await port.hideHistoryFrom("gina");
    const gina = await joinAs(port, "gina");
    await run(11_000, [at("carol"), gina]);
    const toAll = (await requestsOf(port, "gina")).at(-1);
    assert(toAll);
    expect(toAll.all).toBe(true);
    await port.send(
      DOC,
      "mallory",
      encodeResyncResponseFrame({
        documentId: DOC,
        respondsTo: toAll.requestId,
        update: new Uint8Array([0, 0]),
        control: null,
        state: { stateVector: new Uint8Array([0]), stateDigest: digestOf(new Uint8Array([0, 0])) },
      }),
    );
    await poll(gina);
    expect(gina.hasCompletedBootstrap).toBe(false);
    expect(gina.syncHealth.resync.state).toBe("requested");
  });
});

describe("an answer silences a member only when it holds what that member holds (RSY-20)", () => {
  /**
   * Bob, with the early stream of the example, and Carol, with the late one, hold what `prepare`
   * leaves them; the creator's only device returns with "Plan" — its document was unbound
   * meanwhile — on a transport that shows it nothing from before. Its first request asks all
   * (RSY-21), under the example's request id: Bob's turn comes first, Carol hears his answer before
   * hers. `beforeAway` runs before the creator's content is taken, `bobAnswered` once Bob's answer went
   * out.
   */
  async function aliceReturnsToBobAndCarol(
    prepare: (port: Port, bob: DocumentEngine, carol: DocumentEngine) => Promise<void>,
    {
      beforeAway,
      bobAnswered,
      clients,
    }: {
      beforeAway?: (
        port: Port,
        alice: DocumentEngine,
        bob: DocumentEngine,
        carol: DocumentEngine,
      ) => Promise<void>;
      bobAnswered?: (port: Port, bob: DocumentEngine, carol: DocumentEngine) => void;
      clients?: Partial<Record<MemberId, number>>;
    } = {},
  ) {
    const { port, alice, at } = await group(["bob", "carol"], {
      streams: { bob: EXAMPLE.early.stream, carol: EXAMPLE.late.stream },
      ...(clients === undefined ? {} : { clients }),
    });
    const [bob, carol] = [at("bob"), at("carol")];
    await beforeAway?.(port, alice, bob, carol);
    const control: PersistedControlState = {
      tdsp: CURRENT_FRAME_VERSION,
      profile: alice.profile,
      control: { closed: alice.controlState.closed, targets: alice.controlState.targets },
      device: alice.deviceTag,
      clock: alice.controlClock,
      bootstrapped: true,
    };
    const content = restoredOf(alice);
    creatorAway(port, alice);
    await prepare(port, bob, carol);
    await creatorDeviceWithoutHistory(port);
    const back = await joinAs(
      port,
      "alice",
      { autoResync: false, controlState: control, restore: { ...content, rebound: true } },
      EXAMPLE.requesterStream,
      EXAMPLE.requestId,
    );
    expect((await requestsOf(port, "alice")).at(-1)).toMatchObject({
      requestId: EXAMPLE.requestId,
      all: true,
    });
    let told = bobAnswered === undefined;
    for (let passed = 0; passed < 2 * 60_000; passed += 1_000) {
      await run(1_000, [bob, carol, back]);
      if (
        !told &&
        (await answersTo(port, EXAMPLE.requestId)).some((answer) => answer.sender === "bob")
      ) {
        told = true;
        bobAnswered?.(port, bob, carol);
      }
    }
    expect(told).toBe(true);
    const answers = (await answersTo(port, EXAMPLE.requestId)).map((answer) => answer.sender);
    return { port, back, bob, carol, answers };
  }

  it("Bob holds less than Carol: Carol hears his answer and still answers at her turn, so what only she holds reaches the returning device", async () => {
    const { back, answers } = await aliceReturnsToBobAndCarol(async (port, bob, carol) => {
      bob.edit((fragment) => insertPlainText(fragment, 4, " b"));
      await run(2_000, [bob, carol]);
      // Carol's change never reaches Bob, and nothing shows it: neither writes again.
      port.loseNextSendFor("bob");
      carol.edit((fragment) => insertPlainText(fragment, 6, " c"));
      await run(2_000, [bob, carol]);
      expect(getPlainText(bob.fragment)).toBe("Plan b");
      expect(getPlainText(carol.fragment)).toBe("Plan b c");
    });
    expect(answers).toStrictEqual(["bob", "carol"]);
    expect(getPlainText(back.fragment)).toBe("Plan b c");
  });

  it("Bob holds what Carol holds but a deletion of hers: his answer silences her not, and the deletion reaches the returning device", async () => {
    const { back, answers } = await aliceReturnsToBobAndCarol(async (port, bob, carol) => {
      bob.edit((fragment) => insertPlainText(fragment, 4, " b"));
      await run(2_000, [bob, carol]);
      port.loseNextSendFor("bob");
      carol.edit((fragment) => deletePlainText(fragment, 0, 1));
      await run(2_000, [bob, carol]);
      expect(getPlainText(bob.fragment)).toBe("Plan b");
      expect(getPlainText(carol.fragment)).toBe("lan b");
    });
    expect(answers).toStrictEqual(["bob", "carol"]);
    expect(getPlainText(back.fragment)).toBe("lan b");
  });

  it("Carol heard Bob's answer while she still lacked his change, which reaches her late, before her turn: at her turn his answer holds what she would give, and she stays silent", async () => {
    let lacked = "";
    const { back, carol, answers } = await aliceReturnsToBobAndCarol(
      async (port, bob, carol) => {
        // Bob's change is held up on its way to Carol.
        port.loseNextSendFor("carol");
        bob.edit((fragment) => insertPlainText(fragment, 4, " b"));
        await run(2_000, [bob, carol]);
        expect(getPlainText(carol.fragment)).toBe("Plan");
      },
      {
        bobAnswered: (port, _bob, carol) => {
          lacked = getPlainText(carol.fragment);
          port.deliverLate("carol");
        },
      },
    );
    expect(lacked).toBe("Plan");
    expect(getPlainText(carol.fragment)).toBe("Plan b");
    expect(answers).toStrictEqual(["bob"]);
    expect(getPlainText(back.fragment)).toBe("Plan b");
  });

  it("Bob's answer lacks the returning device's own change, which Carol holds: with what the request states it holds what she would give, and she stays silent", async () => {
    let answeredWith = "";
    const { back, carol, answers } = await aliceReturnsToBobAndCarol(
      async (_port, bob, carol) => {
        bob.edit((fragment) => insertPlainText(fragment, 0, "b "));
        await run(2_000, [bob, carol]);
      },
      {
        // The creator's last change never reaches Bob, nor does anything that carries or shows it: her
        // reports, and the content her returning device sends again.
        beforeAway: async (port, alice, bob, carol) => {
          port.loseEditsOf("alice", "bob");
          port.loseReportsOf("alice", "bob");
          alice.edit((fragment) => insertPlainText(fragment, 4, " a"));
          await run(2_000, [alice, bob, carol]);
        },
        bobAnswered: (_port, bob) => {
          answeredWith = getPlainText(bob.fragment);
        },
        // Fixed, so that what Carol holds as she hears Bob's answer is the same in every run.
        clients: { alice: 1_111_111_111, bob: 2_222_222_222, carol: 3_333_333_333 },
      },
    );
    expect(answeredWith).toBe("b Plan");
    expect(getPlainText(carol.fragment)).toBe("b Plan a");
    expect(answers).toStrictEqual(["bob"]);
    expect(getPlainText(back.fragment)).toBe("b Plan a");
  });

  it("Bob's answer lacks the returning device's own change, of which Carol deleted a part: she answers at her turn, and the deletion reaches the returning device", async () => {
    let answeredWith = "";
    const { back, carol, answers } = await aliceReturnsToBobAndCarol(
      async (port, bob, carol) => {
        bob.edit((fragment) => insertPlainText(fragment, 0, "b "));
        await run(2_000, [bob, carol]);
        // Bob, who lacks the change, does not get the deletion either: his answer cannot carry it. Nor
        // do Carol's reports carry it again to anyone (SND-27): only her answer brings it.
        port.loseNextSendFor("bob");
        port.loseReportsOf("carol");
        carol.edit((fragment) => deletePlainText(fragment, 6, 2));
        await run(2_000, [bob, carol]);
      },
      {
        beforeAway: async (port, alice, bob, carol) => {
          port.loseEditsOf("alice", "bob");
          port.loseReportsOf("alice", "bob");
          alice.edit((fragment) => insertPlainText(fragment, 4, " a"));
          await run(2_000, [alice, bob, carol]);
        },
        bobAnswered: (_port, bob) => {
          answeredWith = getPlainText(bob.fragment);
        },
      },
    );
    expect(answeredWith).toBe("b Plan");
    expect(getPlainText(carol.fragment)).toBe("b Plan");
    expect(answers).toStrictEqual(["bob", "carol"]);
    expect(getPlainText(back.fragment)).toBe("b Plan");
  });

  it("Carol heard Bob's answer while she held what he held; his deletion and his edit after it reach her before her turn: she stays silent, and the returning device gets both as anyone does", async () => {
    const { back, carol, answers } = await aliceReturnsToBobAndCarol(
      async (_port, bob, carol) => {
        bob.edit((fragment) => insertPlainText(fragment, 4, " b"));
        await run(2_000, [bob, carol]);
      },
      {
        bobAnswered: (_port, bob) => {
          bob.edit((fragment) => deletePlainText(fragment, 0, 1));
          bob.edit((fragment) => insertPlainText(fragment, 0, "!"));
        },
      },
    );
    expect(getPlainText(carol.fragment)).toBe("!lan b");
    expect(answers).toStrictEqual(["bob"]);
    expect(getPlainText(back.fragment)).toBe("!lan b");
  });

  it("Bob and Carol hold the same: his answer silences her, one answer", async () => {
    const { back, answers } = await aliceReturnsToBobAndCarol(async (_port, bob, carol) => {
      bob.edit((fragment) => insertPlainText(fragment, 4, " b"));
      await run(2_000, [bob, carol]);
    });
    expect(answers).toStrictEqual(["bob"]);
    expect(getPlainText(back.fragment)).toBe("Plan b");
  });

  /** Carol's deletion never reaches Bob, nor does a report of hers; Bob's change is held up on its way to Carol, and so are his reports. */
  async function deletionAndHeldUpChange(
    port: Port,
    bob: DocumentEngine,
    carol: DocumentEngine,
  ): Promise<void> {
    port.loseReportsOf("carol");
    port.loseNextSendFor("bob");
    carol.edit((fragment) => deletePlainText(fragment, 0, 1));
    await run(2_000, [bob, carol]);
    port.loseReportsOf("bob", "carol");
    port.loseNextSendFor("carol");
    bob.edit((fragment) => insertPlainText(fragment, 4, " b"));
    await run(2_000, [bob, carol]);
    expect(getPlainText(carol.fragment)).toBe("lan");
    expect(getPlainText(bob.fragment)).toBe("Plan b");
  }

  it("Carol heard Bob's answer while she lacked his change, which reaches her before her turn, and holds a deletion he lacks: his answer, not judged until then, holds nothing at her turn — she answers, and the deletion reaches the returning device", async () => {
    let lacked = "";
    const { back, carol, answers } = await aliceReturnsToBobAndCarol(deletionAndHeldUpChange, {
      bobAnswered: (port, _bob, carol) => {
        lacked = getPlainText(carol.fragment);
        port.deliverLate("carol");
      },
    });
    expect(lacked).toBe("lan");
    expect(getPlainText(carol.fragment)).toBe("lan b");
    expect(answers).toStrictEqual(["bob", "carol"]);
    expect(getPlainText(back.fragment)).toBe("lan b");
  });

  it("Carol heard Bob's answer, lacking his change, longer than a request's wait before the request itself, and holds a deletion he lacks: an answer not judged by then holds nothing — she answers, and the deletion reaches the returning device", async () => {
    const { back, carol, answers } = await aliceReturnsToBobAndCarol(
      async (port, bob, carol) => {
        await deletionAndHeldUpChange(port, bob, carol);
        // The request is held up on its way to Carol, and so are the returning device's answers: the
        // one to her own request for what Bob's answer showed she lacked would bring her his change.
        port.requestsLostFor.add("carol");
        port.loseAnswersOf("alice", "carol", 10);
      },
      {
        bobAnswered: (port) => {
          port.requestsLostFor.delete("carol");
          setTimeout(() => port.deliverLate("carol"), 60_000);
        },
      },
    );
    expect(getPlainText(carol.fragment)).toBe("lan b");
    expect(answers).toStrictEqual(["bob", "carol"]);
    expect(getPlainText(back.fragment)).toBe("lan b");
  });

  it("Carol heard Bob's answer, holding what he held, long before the request itself; his deletion after it reaches her before her turn: judged once, as she heard it, it holds what she would give — she stays silent, one answer", async () => {
    const { back, carol, answers } = await aliceReturnsToBobAndCarol(
      async (port, bob, carol) => {
        bob.edit((fragment) => insertPlainText(fragment, 4, " b"));
        await run(2_000, [bob, carol]);
        port.requestsLostFor.add("carol");
      },
      {
        bobAnswered: (port, bob) => {
          port.requestsLostFor.delete("carol");
          setTimeout(() => bob.edit((fragment) => deletePlainText(fragment, 0, 1)), 5_000);
          setTimeout(() => port.deliverLate("carol"), 60_000);
        },
      },
    );
    expect(getPlainText(carol.fragment)).toBe("lan b");
    expect(answers).toStrictEqual(["bob"]);
    expect(getPlainText(back.fragment)).toBe("lan b");
  });

  it("a new device of the creator merges Bob's answer; Carol, who holds a later decision of the lost device, still answers, and her register holds there too; neither bootstraps it (CTL-25, CTL-22, CTL-27, RSY-20)", async () => {
    const { port, alice, at } = await group(["bob", "carol"], {
      granted: ["gina"],
      streams: { bob: EXAMPLE.early.stream, carol: EXAMPLE.late.stream },
    });
    const [bob, carol] = [at("bob"), at("carol")];
    // The lost device's last decision reaches Carol only.
    port.loseNextSendFor("bob");
    await alice.setMembership("gina", "read");
    await run(2_000, [alice, bob, carol]);
    expect(bob.permissionOf("gina")).toBe("write");
    expect(carol.permissionOf("gina")).toBe("read");
    // So do the decision again, which its report sends first as it closes (SND-27), and the report:
    // its control clock would show Bob the gap, and Carol's answer to his request would fill it before
    // the new device asks, at a turn its random request id sets (LOS-10, LOS-12, RSY-20).
    const bobAsked = (await requestsOf(port, "bob")).length;
    port.loseNextSendFor("bob");
    port.loseReportsOf("alice", "bob");
    creatorAway(port, alice);
    await creatorDeviceWithoutHistory(port);
    const alice2 = await joinAs(port, "alice", { autoResync: false });
    await run(11_000, [bob, carol, alice2]);
    // Nothing shows Bob what he lacks, whatever the turns: he asks nothing before he answers.
    expect((await requestsOf(port, "bob")).length).toBe(bobAsked);
    ids.queue.push(EXAMPLE.requestId);
    await alice2.requestResync();
    await run(2 * 60_000, [bob, carol, alice2]);
    expect((await answersTo(port, EXAMPLE.requestId)).map((answer) => answer.sender)).toStrictEqual(
      ["bob", "carol"],
    );
    expect(alice2.controlStanding).toStrictEqual({ kind: "none" });
    expect(alice2.permissionOf("gina")).toBe("read");
  });
});

describe("the answers a member judges (RSY-20, Appendix B)", () => {
  /** A stream for which a member's turn on `requestId` falls in [from, to) ms of the 30 s window. */
  function streamWithTurn(name: string, requestId: string, from: number, to: number): string {
    const window = answerWindowMs(0);
    for (let seed = 1; seed < 100_000; seed++) {
      const stream = createHash("sha256").update(`${name}:${seed}`).digest("hex").slice(0, 16);
      const turn = answerDelayMs(requestId, stream, window);
      if (turn >= from && turn < to) return stream;
    }
    throw new Error("no stream found");
  }

  /**
   * Members `lacking`, their turns a few seconds apart in that order, then Dave's, then Carol's, last.
   * Each lacking member's change reaches Dave and Carol and none of the other lacking ones; Carol's
   * reaches none of them. The creator's only device returns with what it held before and asks all, under
   * the example's request id; who answered, and what Carol holds.
   */
  async function returnWithAnswerers(lacking: readonly MemberId[]) {
    const id = EXAMPLE.requestId;
    const streams: Record<string, string> = {};
    for (const [i, member] of lacking.entries())
      streams[member] = streamWithTurn(member, id, 2_000 + 3_000 * i, 3_000 + 3_000 * i);
    streams.dave = streamWithTurn(
      "dave",
      id,
      2_000 + 3_000 * lacking.length,
      3_000 + 3_000 * lacking.length,
    );
    streams.carol = streamWithTurn("carol", id, 27_000, 29_000);
    const members = [...lacking, "dave", "carol"];
    const { port, alice, at } = await group(members, { streams });
    const control: PersistedControlState = {
      tdsp: CURRENT_FRAME_VERSION,
      profile: alice.profile,
      control: { closed: alice.controlState.closed, targets: alice.controlState.targets },
      device: alice.deviceTag,
      clock: alice.controlClock,
      bootstrapped: true,
    };
    const content = restoredOf(alice);
    creatorAway(port, alice);
    const engines = members.map(at);
    for (const [i, member] of lacking.entries()) {
      for (const other of lacking) {
        if (other === member) continue;
        port.loseEditsOf(member, other);
        port.loseReportsOf(member, other);
      }
      at(member).edit((fragment) => insertPlainText(fragment, 4, ` ${i}`));
      await run(2_000, engines);
    }
    for (const member of lacking) {
      port.loseEditsOf("carol", member);
      port.loseReportsOf("carol", member);
    }
    at("carol").edit((fragment) => insertPlainText(fragment, 0, "c "));
    await run(15_000, engines);
    for (const member of lacking)
      expect(getPlainText(at(member).fragment), member).not.toContain("c ");
    expect(getPlainText(at("dave").fragment)).toBe(getPlainText(at("carol").fragment));
    await creatorDeviceWithoutHistory(port);
    const back = await joinAs(
      port,
      "alice",
      { autoResync: false, controlState: control, restore: { ...content, rebound: true } },
      EXAMPLE.requesterStream,
      id,
    );
    await run(2 * 60_000, [...engines, back]);
    const answers = (await answersTo(port, id)).map((answer) => answer.sender);
    return { back, answers, full: getPlainText(at("carol").fragment) };
  }

  it("not only the first: Bob's answer lacks Carol's change, Dave's after it holds it; Carol stays silent", async () => {
    const { back, answers, full } = await returnWithAnswerers(["bob"]);
    expect(answers).toStrictEqual(["bob", "dave"]);
    expect(getPlainText(back.fragment)).toBe(full);
  });

  it("the first four: four answers lack Carol's change, Dave's fifth holds it; Carol, who judges only the first four, answers", async () => {
    const { back, answers, full } = await returnWithAnswerers(["bob", "erin", "frank", "gina"]);
    expect(answers).toStrictEqual(["bob", "erin", "frank", "gina", "dave", "carol"]);
    expect(getPlainText(back.fragment)).toBe(full);
  });
});

describe("answers to a request to all (RSY-12, RSY-13, RSY-15, LOS-21)", () => {
  /**
   * Carol and Dave each hold an edit the other lacks; the creator restarts without content and asks
   * all, and both turns have passed before either polls again: both answer. The document holds
   * `tail` after "Plan".
   */
  async function twoAnswers(port = new Port(), tail = "") {
    const { alice, at } = await group(["carol", "dave"], { port, tail });
    const [carol, dave] = [at("carol"), at("dave")];
    // Their reports carry nothing to the others: what each lacks comes by the answers.
    port.loseReportsOf("carol");
    port.loseReportsOf("dave");
    port.loseNextSendFor("dave");
    carol.edit((fragment) => insertPlainText(fragment, 4, " C"));
    await vi.advanceTimersByTimeAsync(0);
    port.loseNextSendFor("carol");
    dave.edit((fragment) => insertPlainText(fragment, 0, "D "));
    await vi.advanceTimersByTimeAsync(0);
    await poll(alice, carol, dave);
    expect(getPlainText(carol.fragment)).toBe(`Plan C${tail}`);
    expect(getPlainText(dave.fragment)).toBe(`D Plan${tail}`);
    const control: PersistedControlState = {
      tdsp: CURRENT_FRAME_VERSION,
      profile: alice.profile,
      control: { closed: alice.controlState.closed, targets: alice.controlState.targets },
      device: alice.deviceTag,
      clock: alice.controlClock,
      bootstrapped: true,
    };
    creatorAway(port, alice);
    await creatorDeviceWithoutHistory(port);
    const restarted = await joinAs(port, "alice", { autoResync: false, controlState: control });
    await run(11_000, [restarted]);
    await restarted.requestResync();
    const [toAll] = (await requestsOf(port, "alice")).slice(-1);
    expect(toAll?.all).toBe(true);
    assert(toAll);
    await poll(carol, dave);
    await vi.advanceTimersByTimeAsync(answerWindowMs(0));
    await poll(carol, dave);
    const answers = await answersTo(port, toAll.requestId);
    expect(answers.map((a) => a.sender)).toStrictEqual(["carol", "dave"]);
    await poll(restarted);
    return { restarted, carol, dave, control };
  }

  it("applies the content of each, keeps the first overlay it adopts, and merges their control state, the same as its own", async () => {
    const { restarted, control } = await twoAnswers();
    expect(getPlainText(restarted.fragment)).toBe("D Plan C");
    expect(restarted.hasCompletedBootstrap).toBe(true);
    // What the members sent, merged, changed nothing of the creator's own (CTL-25, CTL-22).
    const { closed, targets } = restarted.controlState;
    expect({ closed, targets }).toStrictEqual(control.control);
    // Carol's overlay came first and stands; what Dave's answer added is unattributed (RSY-15, ATR-2).
    const authors = restarted.attribution.ranges.map((range) => range.authorId);
    expect(authors).toContain("carol");
    expect(authors).not.toContain("dave");
    expect(authors).toContain(null);
  });

  it("counts each answer's pieces by its own stream: both complete, neither is missing a piece", {
    timeout: 60_000,
  }, async () => {
    const port = new Port();
    port.limitTo(MIN_MESSAGE_BYTES);
    // As Base64, more than a frame of the smallest transport carries (TRN-23): each answer takes two.
    const tail = "n".repeat((MIN_MESSAGE_BYTES / 4) * 3);
    const { restarted } = await twoAnswers(port, tail);
    // Read as JSON only: decoding each frame of megabytes again would add seconds.
    const pieces = (await port.inner.receive(DOC, "observer")).filter(({ payload }) => {
      const frame = JSON.parse(payload) as { kind: string; piece?: number };
      return frame.kind === "resync-response" && (frame.piece ?? 0) > 1;
    });
    expect(pieces.length).toBeGreaterThan(0); // the answers came in pieces
    expect(getPlainText(restarted.fragment)).toBe(`D Plan C${tail}`);
    expect(restarted.syncHealth.incompleteAnswers).toStrictEqual([]);
    await run(60_000, [restarted]);
    expect(restarted.syncHealth.suspicions).toStrictEqual([]);
  });

  it("takes a member's answer only to a request of its own: one nobody asked for applies nothing", async () => {
    const { port, at } = await group(["carol", "dave"]);
    const [carol, dave] = [at("carol"), at("dave")];
    port.loseNextSendFor("carol");
    dave.edit((fragment) => insertPlainText(fragment, 4, " (Dave)"));
    await port.inner.send(
      DOC,
      "dave",
      encodeResyncResponseFrame({
        documentId: DOC,
        respondsTo: "0000000000000bad",
        update: encodeUpdate(dave.document),
        attribution: null,
      }),
    );
    await poll(carol);
    expect(getPlainText(carol.fragment)).toBe("Plan");
  });
});

describe("the turn, while the engine runs (RSY-16, RSY-20)", () => {
  /**
   * Carol, with the late stream of the example and Signal's latency, and Gina's request to all,
   * which Carol heard at `heardAt`.
   */
  async function carolHearsGina() {
    const persisted = new Map<MemberId, PersistedControlState>();
    const { port, alice } = await group([], { granted: ["carol", "gina"] });
    const carol = await joinAs(
      port,
      "carol",
      { ...SIGNAL_LATENCY, onControlStateChange: (state) => persisted.set("carol", state) },
      EXAMPLE.late.stream,
    );
    await poll(alice, carol);
    expect(carol.hasCompletedBootstrap).toBe(true);
    creatorAway(port, alice);
    port.inner.modifyNextSend("gina", (payload) => payload.replace('"all":false', '"all":true'));
    const gina = await joinAs(
      port,
      "gina",
      { autoResync: false },
      EXAMPLE.requesterStream,
      EXAMPLE.requestId,
    );
    const delivery = (await port.inner.receive(DOC, "observer")).find(
      (d) => d.sender === "gina" && decodeFrame(d.payload).kind === "resync-request",
    );
    assert(delivery);
    await poll(carol);
    return { port, carol, gina, delivery, heardAt: Date.now(), persisted };
  }

  it("a copy of a request keeps the turn it has, and is answered once; deliveries offered twice change nothing", async () => {
    const { port, carol, gina, delivery, heardAt } = await carolHearsGina();
    await vi.advanceTimersByTimeAsync(5_000);
    await port.inner.send(DOC, "gina", delivery.payload); // the same request again, as a new delivery
    port.inner.replay(DOC, delivery.id);
    await poll(carol);
    await vi.advanceTimersByTimeAsync(heardAt + EXAMPLE.late.wait - 1 - Date.now());
    await poll(carol);
    expect(await answersTo(port, EXAMPLE.requestId)).toStrictEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await poll(carol);
    expect((await answersTo(port, EXAMPLE.requestId)).map((a) => a.sender)).toStrictEqual([
      "carol",
    ]);

    const answer = (await port.inner.receive(DOC, "observer")).find(
      (d) => d.sender === "carol" && decodeFrame(d.payload).kind === "resync-response",
    );
    assert(answer);
    port.inner.replay(DOC, answer.id);
    await port.inner.send(DOC, "gina", delivery.payload);
    await run(5 * 60_000, [carol, gina], 10_000);
    expect((await answersTo(port, EXAMPLE.requestId)).map((a) => a.sender)).toStrictEqual([
      "carol",
    ]);
    expect(getPlainText(gina.fragment)).toBe("Plan");
  });

  it("is not kept across a restart: the engine that starts again derives its turn from its new stream", async () => {
    const { port, carol, heardAt, persisted } = await carolHearsGina();
    await vi.advanceTimersByTimeAsync(10_000);
    carol.dispose();
    const again = await joinAs(
      port,
      "carol",
      { ...SIGNAL_LATENCY, controlState: persisted.get("carol"), restore: restoredOf(carol) },
      EXAMPLE.early.stream,
    );
    // Its join read the request again, now: its turn is the early stream's wait from here, not the
    // turn the engine before it had.
    const heardAgainAt = heardAt + 10_000;
    expect(Date.now()).toBe(heardAgainAt);
    await vi.advanceTimersByTimeAsync(EXAMPLE.early.wait - 1);
    await poll(again);
    expect(await answersTo(port, EXAMPLE.requestId)).toStrictEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await poll(again);
    const answers = await answersTo(port, EXAMPLE.requestId);
    expect(answers.map((a) => a.sender)).toStrictEqual(["carol"]);
    // Not bootstrapped again yet (CTL-41): its answer carries content, and no control state (RSY-8).
    expect(again.hasCompletedBootstrap).toBe(false);
    expect(answers[0]?.last.control).toBeNull();
    await run(5 * 60_000, [again], 10_000);
    expect(await answersTo(port, EXAMPLE.requestId)).toHaveLength(1);
  });

  it("keeps a request to all until its turn, even one that comes almost 5 min after it heard it (RSY-9, RSY-19)", async () => {
    // A stream whose wait in a window of 5 min lies just under it.
    const window = answerWindowMs(60_000);
    expect(window).toBe(300_000);
    let stream = "";
    for (let i = 0; stream === "" && i < 10_000; i++) {
      const candidate = createHash("sha256").update(`stream-${i}`).digest("hex").slice(0, 16);
      const wait = answerDelayMs(EXAMPLE.requestId, candidate, window);
      if (wait > 294_000) stream = candidate;
    }
    expect(stream).not.toBe("");
    const latency = { syncPolicy: { expectedLatencyMs: 60_000 } };
    const { port, alice } = await group([], { granted: ["carol", "gina"] });
    const carol = await joinAs(port, "carol", latency, stream);
    await poll(alice, carol);
    creatorAway(port, alice);
    port.inner.modifyNextSend("gina", (payload) => payload.replace('"all":false', '"all":true'));
    await joinAs(port, "gina", { autoResync: false }, EXAMPLE.requesterStream, EXAMPLE.requestId);
    await poll(carol);
    // Polled every 7 s, Carol first gets to the request past 5 min after she heard it.
    await run(301_000, [carol], 7_000);
    expect((await answersTo(port, EXAMPLE.requestId)).map((a) => a.sender)).toStrictEqual([
      "carol",
    ]);
  });
});

describe("what a request to all costs (RSY-6, RSY-20)", () => {
  // 100 fixed-seed trials, CPU-bound under fake timers; the outcome is deterministic, only the wall
  // time varies (about 0.8 s alone, beyond 5 s on a loaded machine).
  it("a new device of a member, the creator offline, four members online: two requests and about one answer", {
    timeout: 60_000,
  }, async () => {
    // Streams and request ids random but fixed, so the outcome is the same on every run.
    const id = (seed: string) => createHash("sha256").update(seed).digest("hex").slice(0, 16);
    const trials = 100;
    const members = ["carol", "dave", "erin", "frank"];
    const answers: number[] = [];
    const waited: number[] = [];
    for (let trial = 0; trial < trials; trial++) {
      const streams = Object.fromEntries(
        members.map((member) => [member, id(`${trial}:${member}`)]),
      );
      const { port, alice, at } = await group(members, { granted: ["gina"], streams });
      creatorAway(port, alice);
      const engines = members.map(at);
      await port.hideHistoryFrom("gina");
      const start = Date.now();
      const gina = await joinAs(
        port,
        "gina",
        { autoResync: false },
        id(`${trial}:gina`),
        id(`${trial}:first`),
      );
      await run(10_000, [...engines, gina]);
      ids.queue.push(id(`${trial}:to-all`));
      await gina.requestResync();
      const [toAll] = (await requestsOf(port, "gina")).slice(-1);
      expect(toAll?.all).toBe(true);
      assert(toAll);
      // Every member polls once a second, in turn, as its application does; Gina too.
      let content: number | undefined;
      for (let second = 0; second < answerWindowMs(0) / 1_000 + 5; second++) {
        await run(1_000, [...engines, gina]);
        if (content === undefined && getPlainText(gina.fragment) === "Plan")
          content = Date.now() - start;
      }
      answers.push((await answersTo(port, toAll.requestId)).length);
      waited.push(content ?? Number.POSITIVE_INFINITY);
      expect((await requestsOf(port, "gina")).length).toBe(2);
      for (const engine of [...engines, gina]) engine.dispose();
    }
    const mean = (values: number[]) =>
      values.reduce((sum, value) => sum + value, 0) / values.length;
    const stats = { mean: mean(answers), max: Math.max(...answers), waited: mean(waited) };
    // Every request to all is answered, within its window after the first request expired.
    expect(Math.min(...answers), JSON.stringify(stats)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...waited), JSON.stringify(stats)).toBeLessThanOrEqual(
      10_000 + answerWindowMs(0) + 2_000,
    );
    // The first of k = 4 turns comes after about window / (k + 1) = 6 s on average, and is heard
    // within the second all poll.
    expect(stats.waited, JSON.stringify(stats)).toBeLessThan(10_000 + 6_000 + 3_000);
    // Doubles come from turns closer than an answer takes to be heard — here one second of polling:
    // about (k − 1) · 1.5 s / 30 s ≈ 0.15 per request.
    expect(stats.mean, JSON.stringify(stats)).toBeLessThan(1.3);
  });
});

describe("a member's answer bootstraps another member's new device (RSY-14)", () => {
  it("the creator offline: the first member's answer to all bootstraps it, and it asks no more — two requests, not six", async () => {
    const { port, alice, at } = await group(["carol", "dave"], { granted: ["gina"] });
    creatorAway(port, alice);
    const members = [at("carol"), at("dave")];
    await port.hideHistoryFrom("gina");
    const gina = await joinAs(port, "gina");
    // Asking by itself (RSY-5), for half an hour: its first request goes unanswered, the repeat asks
    // all, and a member's answer to it bootstraps it.
    await run(30 * 60_000, [...members, gina], 5_000);
    const requests = await requestsOf(port, "gina");
    expect(requests.map((request) => request.all)).toStrictEqual([false, true]);
    expect(gina.hasCompletedBootstrap).toBe(true);
    expect(gina.controlStanding.kind).toBe("bootstrapped");
    expect(getPlainText(gina.fragment)).toBe("Plan");
    expect(gina.mayEdit).toBe(true);
  });
});

describe("a return: a restart with content after longer than the transport keeps, or after the document was unbound (RSY-21, RSY-5)", () => {
  /** How long the transport in these tests keeps a message for a device that is away: 30 days. */
  const KEPT = 30 * 24 * 60 * 60_000;

  /** The same transport with a cursor (TRN-18), as a member's restored state needs to bootstrap it (CTL-41). */
  class CursorPort extends Port {
    async receiveSince(
      documentId: DocumentId,
      member: MemberId,
      after: DeliveryId | undefined,
    ): Promise<{ readonly deliveries: readonly Delivery[]; readonly truncated: boolean }> {
      const visible = await this.receive(documentId, member);
      const at = after === undefined ? -1 : visible.findIndex((delivery) => delivery.id === after);
      if (after === undefined) return { deliveries: visible, truncated: false };
      return at === -1
        ? { deliveries: visible, truncated: true }
        : { deliveries: visible.slice(at + 1), truncated: false };
    }
  }

  /**
   * Alice's only device holds "Plan", Carol and Dave write. Alice stops, her application persisting
   * her control state and her content; while she is away Dave writes " (Dave)", which her transport
   * never brings her — it kept it no longer than `KEPT`, or the document was unbound. She starts
   * again with what was persisted and `restore`, on a transport that shows her nothing from before.
   * `answerFirst`: what answers her first request at once, if anything. Returns whether each of her
   * requests asked all, and who answered the first.
   */
  async function aliceReturns(
    restore: { readAt?: number; rebound?: boolean },
    answerFirst?: (port: Port, requestId: string, carol: DocumentEngine) => Promise<void>,
  ) {
    const { port, alice, at } = await group(["carol", "dave"]);
    const control: PersistedControlState = {
      tdsp: CURRENT_FRAME_VERSION,
      profile: alice.profile,
      control: { closed: alice.controlState.closed, targets: alice.controlState.targets },
      device: alice.deviceTag,
      clock: alice.controlClock,
      bootstrapped: true,
    };
    const content = restoredOf(alice);
    creatorAway(port, alice);
    at("dave").edit((fragment) => insertPlainText(fragment, 4, " (Dave)"));
    await run(5_000, [at("carol"), at("dave")]);
    await creatorDeviceWithoutHistory(port);
    const back = await joinAs(port, "alice", {
      controlState: control,
      restore: { ...content, ...restore },
      transportRetentionMs: KEPT,
    });
    const [first] = (await requestsOf(port, "alice")).slice(-1);
    assert(first);
    await answerFirst?.(port, first.requestId, at("carol"));
    await run(10 * 60_000, [at("carol"), at("dave"), back], 5_000);
    const asked = (await requestsOf(port, "alice")).filter(
      (request) => request.stream === first.stream,
    );
    const answered = (await answersTo(port, first.requestId)).map((answer) => answer.sender);
    return { back, asked: asked.map((request) => request.all), answered };
  }

  it("a device of the creator away longer than its transport keeps: its first request asks all, and a member brings what Dave wrote", async () => {
    const { back, asked } = await aliceReturns({ readAt: Date.now() - KEPT - 60_000 });
    expect(back.hasCompletedBootstrap).toBe(true); // restored content and bootstrapped control state (RSY-14)
    expect(asked).toStrictEqual([true]);
    expect(getPlainText(back.fragment)).toBe("Plan (Dave)");
  });

  it("a document unbound meanwhile and bound again counts so however short the time", async () => {
    const { back, asked } = await aliceReturns({ readAt: Date.now() - 60_000, rebound: true });
    expect(asked).toStrictEqual([true]);
    expect(getPlainText(back.fragment)).toBe("Plan (Dave)");
  });

  it("away no longer than the transport keeps, or with nothing that says how long, its one start request asks all, and is not asked again as a return's would be (RSY-1, RSY-21)", async () => {
    const recent = await aliceReturns({ readAt: Date.now() - KEPT + 60_000 });
    expect(recent.asked).toStrictEqual([true]);
    // This transport lost what came meanwhile all the same; asked by all, a member brings it.
    expect(getPlainText(recent.back.fragment)).toBe("Plan (Dave)");
    const unknown = await aliceReturns({});
    expect(unknown.asked).toStrictEqual([true]);
  });

  it("an answer of another device of the creator that holds what the members hold ends its request to all, and the return with it: the members stay silent, and nobody is asked again", async () => {
    const { back, asked, answered } = await aliceReturns(
      { rebound: true },
      async (port, requestId, carol) => {
        await port.send(
          DOC,
          "alice",
          encodeResyncResponseFrame({
            documentId: DOC,
            respondsTo: requestId,
            update: encodeUpdate(carol.document),
            control: { profile: carol.profile, closed: false, targets: carol.controlState.targets },
            // Whole, in one piece (RSY-18): no evidence of its own (LOS-14).
            state: {
              stateVector: encodeStateVector(carol.document),
              stateDigest: digestOf(encodeDeletions(carol.document)),
            },
          }),
        );
      },
    );
    expect(asked).toStrictEqual([true]);
    expect(getPlainText(back.fragment)).toBe("Plan (Dave)");
    expect(answered).toStrictEqual(["alice"]);
  });

  it("an answer without control state ends its request as any answer does, and the members still answer it at their turns: what Dave wrote arrives, and nobody is asked again", async () => {
    const { back, asked } = await aliceReturns({ rebound: true }, async (port, requestId) => {
      await port.send(
        DOC,
        "alice",
        encodeResyncResponseFrame({
          documentId: DOC,
          respondsTo: requestId,
          update: new Uint8Array([0, 0]),
          state: {
            stateVector: new Uint8Array([0]),
            stateDigest: digestOf(new Uint8Array([0, 0])),
          },
        }),
      );
    });
    expect(asked).toStrictEqual([true]);
    expect(getPlainText(back.fragment)).toBe("Plan (Dave)");
  });

  it("asks all twice: when nothing is missing, its request to all goes unanswered, so does a second, and it asks no more", async () => {
    const { port, alice, at } = await group(["carol", "dave"]);
    const control: PersistedControlState = {
      tdsp: CURRENT_FRAME_VERSION,
      profile: alice.profile,
      control: { closed: alice.controlState.closed, targets: alice.controlState.targets },
      clock: alice.controlClock,
      bootstrapped: true,
    };
    const content = restoredOf(alice);
    creatorAway(port, alice);
    await creatorDeviceWithoutHistory(port);
    const before = (await requestsOf(port, "alice")).length;
    const back = await joinAs(port, "alice", {
      controlState: control,
      restore: { ...content, rebound: true },
    });
    await run(60 * 60_000, [at("carol"), at("dave"), back], 5_000);
    const asked = (await requestsOf(port, "alice")).slice(before);
    // An answer may be lost like any message: one request to all that expired unanswered ends the
    // return only with a second (RSY-21).
    expect(asked.map((request) => request.all)).toStrictEqual([true, true]);
    for (const request of asked) expect(await answersTo(port, request.requestId)).toStrictEqual([]);
  });

  it("a member's answer to its request to all that the network lost ends nothing: it asks all once more, and what only that member holds arrives (RSY-21)", async () => {
    const { port, alice, at } = await group(["carol"]);
    const carol = at("carol");
    const control: PersistedControlState = {
      tdsp: CURRENT_FRAME_VERSION,
      profile: alice.profile,
      control: { closed: alice.controlState.closed, targets: alice.controlState.targets },
      clock: alice.controlClock,
      bootstrapped: true,
    };
    const content = restoredOf(alice);
    creatorAway(port, alice);
    // Only Carol holds what she writes while Alice is away, and her report never carries it to her.
    port.loseReportsOf("carol", "alice");
    carol.edit((fragment) => insertPlainText(fragment, 4, " (Carol)"));
    await run(5_000, [carol]);
    await creatorDeviceWithoutHistory(port);
    // Carol's answer to Alice's first request to all never reaches Alice.
    port.loseAnswersOf("carol", "alice");
    const before = (await requestsOf(port, "alice")).length;
    const back = await joinAs(port, "alice", {
      controlState: control,
      restore: { ...content, rebound: true },
    });
    await run(60 * 60_000, [carol, back], 5_000);
    const asked = (await requestsOf(port, "alice")).slice(before);
    expect(asked.map((request) => request.all)).toStrictEqual([true, true]);
    const [first, second] = asked;
    assert(first && second);
    expect((await answersTo(port, first.requestId)).map((answer) => answer.sender)).toStrictEqual([
      "carol",
    ]);
    expect((await answersTo(port, second.requestId)).map((answer) => answer.sender)).toStrictEqual([
      "carol",
    ]);
    expect(getPlainText(back.fragment)).toBe("Plan (Carol)");
    expect(back.syncHealth.suspicions).toStrictEqual([]);
  });

  it("a request that could not be sent ends nothing: offline as it returns, it asks all once back in reach, and a member brings what Dave wrote", async () => {
    const { port, alice, at } = await group(["carol", "dave"]);
    const control: PersistedControlState = {
      tdsp: CURRENT_FRAME_VERSION,
      profile: alice.profile,
      control: { closed: alice.controlState.closed, targets: alice.controlState.targets },
      clock: alice.controlClock,
      bootstrapped: true,
    };
    const content = restoredOf(alice);
    creatorAway(port, alice);
    at("dave").edit((fragment) => insertPlainText(fragment, 4, " (Dave)"));
    await run(5_000, [at("carol"), at("dave")]);
    await creatorDeviceWithoutHistory(port);
    port.inner.disconnect("alice");
    const before = (await requestsOf(port, "alice")).length;
    const back = await joinAs(port, "alice", {
      controlState: control,
      restore: { ...content, rebound: true },
    });
    // The start does not wait for its request to go out (RSY-1): it fails just after.
    await vi.advanceTimersByTimeAsync(0);
    expect(back.syncHealth.resync.lastOutcome).toBe("failed");
    await run(60_000, [at("carol"), at("dave"), back], 5_000);
    port.inner.reconnect("alice");
    await run(10 * 60_000, [at("carol"), at("dave"), back], 5_000);
    const asked = (await requestsOf(port, "alice")).slice(before);
    // The failed send asked nobody: back in reach it asks all. A member answers at its turn, which
    // with these polls may reach the device just after that request expired; then it asks once more
    // (RSY-21), so one request to all or two, never one that does not ask all.
    expect([[true], [true, true]]).toContainEqual(asked.map((request) => request.all));
    expect(getPlainText(back.fragment)).toBe("Plan (Dave)");
  });

  it("an own device that answers at once with control state but lacks what a member holds does not end it: Carol still answers, and the returning device gets her change", async () => {
    const { port, alice, at } = await group(["carol"]);
    const carol = at("carol");
    const persisted = (engine: DocumentEngine): PersistedControlState => ({
      tdsp: CURRENT_FRAME_VERSION,
      profile: engine.profile,
      control: { closed: engine.controlState.closed, targets: engine.controlState.targets },
      device: engine.deviceTag,
      clock: engine.controlClock,
      bootstrapped: true,
    });
    // Alice's second device, bootstrapped by her first, which then stops.
    const second = await joinAs(port, "alice");
    await run(5_000, [alice, carol, second]);
    expect(second.controlStanding).toStrictEqual({ kind: "bootstrapped" });
    const first = { control: persisted(alice), content: restoredOf(alice) };
    alice.dispose();
    // The second device writes " b", which Carol gets, and stops too.
    second.edit((fragment) => insertPlainText(fragment, 4, " b"));
    await run(5_000, [carol, second]);
    const kept = { control: persisted(second), content: restoredOf(second) };
    second.dispose();
    // Carol writes " c"; neither of Alice's devices ever sees it, nor her report, and she writes no more.
    port.loseReportsOf("carol", "alice");
    carol.edit((fragment) => insertPlainText(fragment, 6, " c"));
    await run(5_000, [carol]);
    await port.hideHistoryFrom("alice");
    expect(getPlainText(carol.fragment)).toBe("Plan b c");
    // The second device comes back with what it kept, read just before: a device that is behind Carol
    // and asks nothing (RSY-1).
    const b = await joinAs(port, "alice", {
      controlState: kept.control,
      restore: { ...kept.content, readAt: Date.now() },
    });
    await run(60_000, [carol, b], 5_000);
    expect(getPlainText(b.fragment)).toBe("Plan b");
    // The first returns, its document unbound meanwhile, seeing nothing sent before — what the second
    // sent whole as it restarted among it —: the second answers at once with "b" and control state;
    // Carol, asked by all, holds more than that answer and answers at her turn.
    await port.hideHistoryFrom("alice");
    const back = await joinAs(port, "alice", {
      controlState: first.control,
      restore: { ...first.content, rebound: true },
    });
    const [request] = (await requestsOf(port, "alice")).slice(-1);
    expect(request?.all).toBe(true);
    assert(request);
    await run(10 * 60_000, [carol, b, back], 5_000);
    expect((await answersTo(port, request.requestId)).map((answer) => answer.sender)).toStrictEqual(
      ["alice", "carol"],
    );
    expect(getPlainText(back.fragment)).toBe("Plan b c");
  });

  it("a member's device away longer than its transport keeps, bootstrapped by its own restored state, asks all as well", async () => {
    const port = new CursorPort();
    const { alice, at } = await group(["carol", "dave"], { granted: ["bob"], port });
    let control: PersistedControlState | undefined;
    const before = await joinAs(port, "bob", {
      onControlStateChange: (state) => {
        control = state;
      },
    });
    await run(5_000, [alice, before, at("carol"), at("dave")]);
    const saved = { ...restoredOf(before), cursor: before.cursor };
    expect(control?.bootstrapped).toBe(true);
    before.dispose();
    creatorAway(port, alice);
    port.loseNextSendFor("bob");
    at("dave").edit((fragment) => insertPlainText(fragment, 4, " (Dave)"));
    await run(5_000, [at("carol"), at("dave")]);

    const bob = await joinAs(port, "bob", {
      controlState: control,
      restore: { ...saved, readAt: Date.now() - KEPT - 60_000 },
      transportRetentionMs: KEPT,
    });
    expect(bob.hasCompletedBootstrap).toBe(true); // read on from its cursor without a gap (CTL-41)
    const stream = (await requestsOf(port, "bob")).at(-1)?.stream;
    await run(10 * 60_000, [at("carol"), at("dave"), bob], 5_000);
    const asked = (await requestsOf(port, "bob")).filter((request) => request.stream === stream);
    expect(asked.map((request) => request.all)).toStrictEqual([true]);
    expect(getPlainText(bob.fragment)).toBe("Plan (Dave)");
  });

  /**
   * Alice's only device keeps running while her messenger is out of reach — a computer asleep, or without
   * a network — and Dave writes `line` at the end. In reach again, her transport no longer holds it
   * for her. `back`: what her application does then. Returns her requests since she is back, whether
   * each asked all.
   */
  async function outOfReach(
    port: Port,
    alice: DocumentEngine,
    dave: DocumentEngine,
    others: DocumentEngine[],
    line: string,
    back: (alice: DocumentEngine) => void,
  ): Promise<boolean[]> {
    port.inner.disconnect("alice");
    // Nor does Dave's report after it carry it to her (SND-27).
    port.loseReportsOf("dave", "alice");
    dave.edit((fragment) => insertPlainText(fragment, getPlainText(fragment).length, line));
    await run(5_000, [alice, dave, ...others]);
    port.inner.reconnect("alice");
    await port.hideHistoryFrom("alice");
    const before = (await requestsOf(port, "alice")).length;
    back(alice);
    await run(10 * 60_000, [alice, dave, ...others], 5_000);
    return (await requestsOf(port, "alice")).slice(before).map((request) => request.all);
  }

  it("a running engine its application tells it was out of reach longer than its transport keeps returns as a restarted one does: its first request asks all, and a member brings what Dave wrote", async () => {
    const { port, alice, at } = await group(["carol", "dave"]);
    const asked = await outOfReach(port, alice, at("dave"), [at("carol")], " (Dave)", (engine) =>
      engine.noteReturn(),
    );
    expect(asked).toStrictEqual([true]);
    expect(getPlainText(alice.fragment)).toBe("Plan (Dave)");
  });

  it("told nothing, a running engine back in reach sees the window moved past what it read once anything arrives — its own report, retried, here —: it asks all, forcing an answer, and a member brings what Dave wrote (LOS-8, LOS-19)", async () => {
    const { port, alice, at } = await group(["carol", "dave"]);
    const asked = await outOfReach(port, alice, at("dave"), [at("carol")], " (Dave)", () => {});
    expect(asked).toStrictEqual([true]);
    const [request] = (await requestsOf(port, "alice")).slice(-1);
    expect(request?.force).toBe(true);
    expect(getPlainText(alice.fragment)).toBe("Plan (Dave)");
  });

  it("a return told to a running engine wakes a gap that rests: its requests are the gap's one, and the gap rests again after them (RSY-21, LOS-26)", async () => {
    const { port, alice, at } = await group(["dave"]);
    const dave = at("dave");
    // Dave's " (Dave)" never reaches her, his "!" builds on it (LOS-2), and he is gone: her gap lasts,
    // and its three tries, each to all, run out unanswered; then it rests (LOS-6). Before them the
    // history her failed read left truncated asks once, and ends unanswered (LOS-8, LOS-20).
    port.inner.disconnect("alice");
    dave.edit((fragment) => insertPlainText(fragment, 4, " (Dave)"));
    await run(5_000, [alice, dave]);
    port.inner.reconnect("alice");
    await port.hideHistoryFrom("alice");
    dave.edit((fragment) => insertPlainText(fragment, 11, "!"));
    await run(5_000, [dave]);
    dave.dispose();
    await run(30 * 60_000, [alice], 5_000);
    const evidence = await requestsOf(port, "alice");
    expect(evidence.map((request) => request.all)).toStrictEqual([true, true, true, true]);
    expect(alice.syncHealth.suspicions).toMatchObject([
      { kind: "pending-gap", tries: 3, resting: true },
    ]);

    alice.noteReturn();
    await run(10 * 60_000, [alice], 5_000);
    const asked = (await requestsOf(port, "alice"))
      .slice(evidence.length)
      .map((request) => request.all);
    // Her return asks all, and once more as the first expired unanswered (RSY-21); the first is the
    // resting gap's one request (LOS-26), which rests again after it and asks nothing of its own.
    expect(asked).toStrictEqual([true, true]);
    expect(alice.syncHealth.suspicions).toMatchObject([
      { kind: "pending-gap", tries: 3, resting: true },
    ]);
    await run(30 * 60_000, [alice], 5_000);
    expect((await requestsOf(port, "alice")).length).toBe(evidence.length + 2);
  });
});

describe("how long an engine keeps its own requests (RSY-12, Appendix B)", () => {
  /**
   * Bob asks once, the creator offline; Carol holds " (late)", which never reached Bob. What Carol
   * then sends as an answer to Bob's request goes out at the times `at` names, counted from the
   * request: whole at `at[0]`, or with two times every piece but the last at the first, the last at
   * the second.
   */
  async function lateAnswer(at: readonly number[]) {
    const { port, alice, at: member } = await group(["bob", "carol"]);
    const [bob, carol] = [member("bob"), member("carol")];
    creatorAway(port, alice);
    await run(2_000, [bob, carol]);
    port.loseNextSendFor("bob");
    // Her report after it never carries it to Bob either: only her answer may.
    port.loseReportsOf("carol", "bob");
    carol.edit((fragment) => insertPlainText(fragment, 4, " (late)"));
    await run(2_000, [bob, carol]);
    expect(getPlainText(bob.fragment)).toBe("Plan");
    expect(getPlainText(carol.fragment)).toBe("Plan (late)");
    await bob.requestResync();
    const request = (await requestsOf(port, "bob")).at(-1);
    assert(request);
    const asked = Date.now();
    const update = encodeUpdate(carol.document);
    const pieces = at.length === 1 ? [update] : splitUpdate(update, Math.ceil(update.length / 2));
    expect(pieces.length).toBeGreaterThanOrEqual(at.length);
    for (const [index, piece] of pieces.entries()) {
      const last = index === pieces.length - 1;
      await vi.advanceTimersByTimeAsync(
        Math.max(0, asked + (at[last ? at.length - 1 : 0] as number) - Date.now()),
      );
      await port.send(
        DOC,
        "carol",
        encodeResyncResponseFrame({
          documentId: DOC,
          respondsTo: request.requestId,
          update: piece,
          control: last ? { ...carol.controlState } : null,
          state: last
            ? {
                stateVector: encodeStateVector(carol.document),
                stateDigest: digestOf(encodeDeletions(carol.document)),
              }
            : null,
          stream: "1a7e1a7e1a7e1a7e",
          sequence: 1,
          piece: index + 1,
        }),
      );
      await poll(bob);
    }
    return bob;
  }

  it("takes an answer that comes 29 min after its request", async () => {
    const bob = await lateAnswer([29 * 60_000]);
    expect(getPlainText(bob.fragment)).toBe("Plan (late)");
  });

  it("no longer takes one that comes 31 min after: its report shows what it lacks instead", async () => {
    const bob = await lateAnswer([31 * 60_000]);
    expect(getPlainText(bob.fragment)).toBe("Plan");
    await vi.advanceTimersByTimeAsync(10_000);
    await poll(bob);
    expect(bob.syncHealth.suspicions.map((suspicion) => suspicion.kind)).toContain(
      "behind-heartbeat",
    );
  });

  it("keeps a request while an answer to it arrives in pieces, past the 30 min", async () => {
    const bob = await lateAnswer([29 * 60_000, 40 * 60_000]);
    expect(getPlainText(bob.fragment)).toBe("Plan (late)");
    expect(bob.syncHealth.incompleteAnswers).toStrictEqual([]);
  });
});

/** What an application persists of an engine's content to show it after a restart (§6.3). */
function restoredOf(engine: DocumentEngine) {
  return { state: encodeUpdate(engine.document), attribution: engine.attribution.toJSON() };
}

describe("a request held with nothing to offer (RSY-9, RSY-20, RSY-4)", () => {
  /** How long the transport in these tests keeps a message for a device that is away: 30 days. */
  const KEPT = 30 * 24 * 60 * 60_000;
  const TEN = ["bob", "carol", "dave", "erin", "frank", "gina", "hank", "ida", "jo", "kim"];

  /** The answers anyone gave to `requests`, one per responder and answer. */
  async function answersToAll(port: Port, requests: readonly ResyncRequestFrame[]) {
    return (
      await Promise.all(requests.map((request) => answersTo(port, request.requestId)))
    ).flat();
  }

  it.each([20_000, 60_000, 240_000])(
    "a return that lacks nothing asks all twice and nobody answers; an edit of the creator's %i ms after that brings no member's answer to those requests",
    { timeout: 60_000 },
    async (delay) => {
      const { port, alice, at } = await group(TEN);
      const control: PersistedControlState = {
        tdsp: CURRENT_FRAME_VERSION,
        profile: alice.profile,
        control: { closed: alice.controlState.closed, targets: alice.controlState.targets },
        device: alice.deviceTag,
        clock: alice.controlClock,
        bootstrapped: true,
      };
      const content = restoredOf(alice);
      creatorAway(port, alice);
      await creatorDeviceWithoutHistory(port);
      const engines = TEN.map(at);
      const back = await joinAs(port, "alice", {
        controlState: control,
        restore: { ...content, readAt: Date.now() - KEPT - 60_000 },
        transportRetentionMs: KEPT,
      });
      // Both requests of the return ask all, have their time and go unanswered: nobody lacks anything.
      await run(5 * 60_000, [...engines, back]);
      const asked = (await requestsOf(port, "alice")).filter((request) => request.all);
      expect(asked).toHaveLength(2);
      expect(await answersToAll(port, asked)).toStrictEqual([]);
      await run(delay, [...engines, back]);
      back.edit((fragment) => insertPlainText(fragment, 0, "x"));
      await run(5 * 60_000, [...engines, back]);
      // Each member's turn came with nothing to offer and let the request go: the creator's own edit,
      // which every member then received, reaches the creator as any edit does (RSY-20).
      expect(await answersToAll(port, asked)).toStrictEqual([]);
    },
  );

  it("a member whose turn came with nothing to offer lets the request go: the requester's own edit after it, within the request's wait, brings no answer", async () => {
    // Bob's stream and the return's first request id, chosen so that his turn comes early in the
    // window: he has nothing to offer then, and the edit comes after it, before the request expired.
    const window = answerWindowMs(0);
    let seed = 0;
    let stream = "";
    let requestId = "";
    do {
      seed += 1;
      stream = createHash("sha256").update(`bob:${seed}`).digest("hex").slice(0, 16);
      requestId = createHash("sha256").update(`request:${seed}`).digest("hex").slice(0, 16);
    } while (
      answerDelayMs(requestId, stream, window) < 3_000 ||
      answerDelayMs(requestId, stream, window) > 12_000
    );
    const turn = answerDelayMs(requestId, stream, window);
    const { port, alice, at } = await group(["bob"], { streams: { bob: stream } });
    const control: PersistedControlState = {
      tdsp: CURRENT_FRAME_VERSION,
      profile: alice.profile,
      control: { closed: alice.controlState.closed, targets: alice.controlState.targets },
      device: alice.deviceTag,
      clock: alice.controlClock,
      bootstrapped: true,
    };
    const content = restoredOf(alice);
    creatorAway(port, alice);
    await creatorDeviceWithoutHistory(port);
    const KEPT = 30 * 24 * 60 * 60_000;
    const back = await joinAs(
      port,
      "alice",
      {
        controlState: control,
        restore: { ...content, readAt: Date.now() - KEPT - 60_000 },
        transportRetentionMs: KEPT,
      },
      "a0a0a0a0a0a0a0a0",
      requestId,
    );
    const [first] = (await requestsOf(port, "alice")).slice(-1);
    expect(first?.requestId).toBe(requestId);
    expect(first?.all).toBe(true);
    await run(turn + 3_000, [at("bob"), back]);
    expect(await answersTo(port, requestId)).toStrictEqual([]);
    back.edit((fragment) => insertPlainText(fragment, 0, "x"));
    await run(window, [at("bob"), back]);
    expect(await answersTo(port, requestId)).toStrictEqual([]);
  });

  it("the cost of a member that holds less: the creator's request to all goes unanswered, and its next edit brings no member's answer", {
    timeout: 60_000,
  }, async () => {
    const { port, alice, at } = await group(TEN);
    const engines = TEN.map(at);
    // Bob loses a decision; the next one shows it to him (LOS-12), his request shows the creator
    // another digest at the same clock (LOS-12 on a device of the creator), and the creator asks.
    port.loseNextSendFor("bob");
    await alice.setMembership("lena", "write");
    await alice.setMembership("max", "write");
    await run(5 * 60_000, [alice, ...engines], 5_000);
    expect(at("bob").permissionOf("lena")).toBe("write");
    const before = (await requestsOf(port, "alice")).length;
    alice.edit((fragment) => insertPlainText(fragment, 0, "x"));
    await run(5 * 60_000, [alice, ...engines], 5_000);
    const asked = (await requestsOf(port, "alice")).filter((request) => request.all);
    expect((await requestsOf(port, "alice")).length).toBe(before);
    const answers = await answersToAll(port, asked);
    expect(answers.filter((answer) => answer.sender !== "alice")).toStrictEqual([]);
    for (const engine of [alice, ...engines])
      expect(engine.syncHealth.suspicions).toStrictEqual([]);
  });

  it("a bootstrapped device of the creator lets another's request it holds nothing for go at once: a decision of its own within the requester's wait answers none (RSY-17, RSY-22)", async () => {
    const { port, alice, at } = await group(["bob"]);
    const second = await joinAs(port, "alice");
    await run(2 * 60_000, [alice, second, at("bob")]);
    expect(second.hasCompletedBootstrap).toBe(true);
    // The second device asks; the first holds nothing it lacks.
    await second.requestResync();
    const [request] = (await requestsOf(port, "alice")).slice(-1);
    assert(request);
    await poll(alice);
    expect(await answersTo(port, request.requestId)).toStrictEqual([]);
    // Within the second device's wait, the first decides: the decision reaches the second as any
    // frame does, and is no answer to the request. Kept, the request would cost a second answer to a
    // gap whose first answer, or the requester's own next request, every device hears.
    await alice.setMembership("carol", "write");
    await poll(alice);
    expect(await answersTo(port, request.requestId)).toStrictEqual([]);
    await run(10_000, [alice, second, at("bob")]);
    expect(await answersTo(port, request.requestId)).toStrictEqual([]);
    expect(second.permissionOf("carol")).toBe("write");
  });

  it("a device that is not bootstrapped keeps a request it holds nothing for, and answers it once it holds something that one lacks, within the requester's wait — not after it (RSY-9, RSY-17)", async () => {
    const { port, alice, at } = await group(["bob"]);
    // The first device of the creator is away: neither the second nor the third is bootstrapped, and
    // both read what the channel holds.
    const second = await joinAs(port, "alice");
    await run(10_000, [second, at("bob")]);
    const THIRD = "a3a3a3a3a3a3a3a3";
    const third = await joinAs(port, "alice", {}, THIRD, "3a3a3a3a3a3a3a3a");
    const ofThird = async () =>
      (await requestsOf(port, "alice")).filter((request) => request.stream === THIRD);
    // The third's first request; the second holds nothing it lacks, and keeps it.
    const [request] = await ofThird();
    assert(request);
    await poll(second);
    expect(await answersTo(port, request.requestId)).toStrictEqual([]);
    for (const device of [second, third]) expect(device.hasCompletedBootstrap).toBe(false);
    expect(getPlainText(second.fragment)).toBe(getPlainText(third.fragment));
    // Within the third's wait, the second writes before its bootstrap: it answers the request it kept.
    second.edit((fragment) => insertPlainText(fragment, 0, "x"));
    await poll(second);
    expect((await answersTo(port, request.requestId)).map((answer) => answer.sender)).toStrictEqual(
      ["alice"],
    );
    // A later request of the third's: the second holds nothing it lacks. After the request's wait
    // (RSY-4), shorter than a request is kept at most, a change of the second's answers none.
    await poll(third);
    while ((await ofThird()).length < 2) await run(5_000, [third, at("bob")]);
    const later = (await ofThird()).at(-1);
    assert(later);
    // It asks all, a repeat of its bootstrap: Bob answers it at his turn, the second does not.
    const ofSecond = async () =>
      (await answersTo(port, later.requestId)).filter((answer) => answer.sender === "alice");
    await poll(second);
    expect(await ofSecond()).toStrictEqual([]);
    // The third asks nothing more meanwhile: a later request of it would stand in for this one (RSY-9).
    await run(2 * 60_000, [at("bob")], 10_000);
    second.edit((fragment) => insertPlainText(fragment, 0, "y"));
    await poll(second);
    expect(await ofSecond()).toStrictEqual([]);
    expect(alice.hasCompletedBootstrap).toBe(true);
  });
});
