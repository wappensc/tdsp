import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import {
  type Delivery,
  type DeliveryId,
  type DocumentId,
  type MemberId,
  type MessengerPort,
  TransportSendError,
} from "@tdsp/messenger-port";
import { encodeUpdate, getPlainText, insertPlainText } from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerDelayMs, answerWindowMs } from "./answer-turn";
import { decodeFrame, type Frame, type ResyncRequestFrame } from "./framing";
import {
  DocumentEngine,
  type DocumentEngineOptions,
  MAX_GAP_TRIES,
  type PersistedControlState,
} from "./index";

/**
 * Gaps (SPECIFICATION.md LOS-6, LOS-25, LOS-26, RSY-1, RSY-21, RSY-22): each piece of evidence is a gap
 * of one stream — one writer's updates, the control state a device of the creator reports, a truncated
 * history — with tries of its own: at most three requests, each to all, the waits doubling; then it
 * rests, is shown, and asks again only when a frame carries its stream further or comes from the
 * writer of its CRDT client, at most once in ten minutes, or when its application tells it of an
 * absence longer than RSY-1's or of a return, or its person asks. A device lets its request go for
 * another's to all that reaches no further, and takes that one's answers. Each device here has a view
 * of the channel of its own, which can lose what is sent on the way to it.
 */

const DOC = "doc-1";
/** 2026-10-26 10:00:00 UTC. */
const T = 1_793_008_800_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/**
 * A message takes 2 s: a gap is believed after 2 s and first asked for after 4 s and its slot in a window
 * of 30 s; a request to all waits 40 s.
 */
const PACE = { syncPolicy: { expectedLatencyMs: 2_000 } };

interface Sent {
  readonly at: number;
  readonly id: DeliveryId;
  readonly sender: MemberId;
  readonly device: string;
  readonly frame: Frame;
}

/** One channel, every send logged with the device that made it. */
class Net {
  readonly inner = new InMemoryMessengerPort();
  readonly log: Sent[] = [];
  readonly views: View[] = [];

  view(member: MemberId, device: string): View {
    const view = new View(this, member, device);
    this.views.push(view);
    return view;
  }

  /** What `device` sent of `kind`, from `since` on. */
  sent(device: string, kind: Frame["kind"], since = 0): Sent[] {
    return this.log.filter((s) => s.at >= since && s.device === device && s.frame.kind === kind);
  }
}

/** One device's view of the channel: offline, or losing what matches a rule on its way here. */
class View implements MessengerPort {
  offline = false;
  failNextReceive = false;
  readonly hidden = new Set<DeliveryId>();
  readonly rules: ((s: Sent) => boolean)[] = [];
  #frozen: Set<DeliveryId> | undefined;

  constructor(
    readonly net: Net,
    readonly member: MemberId,
    readonly device: string,
  ) {}

  /** The next delivery matching `rule` never reaches this device. */
  loseNext(rule: (s: Sent) => boolean): void {
    const once = (s: Sent): boolean => {
      if (!rule(s)) return false;
      this.rules.splice(this.rules.indexOf(once), 1);
      return true;
    };
    this.rules.push(once);
  }

  /** Every delivery matching `rule` from now on never reaches this device, until the returned function is called. */
  loseAll(rule: (s: Sent) => boolean): () => void {
    this.rules.push(rule);
    return () => {
      const at = this.rules.indexOf(rule);
      if (at >= 0) this.rules.splice(at, 1);
    };
  }

  /** Nothing sent so far reaches this device: a new device that sees no history. */
  hideHistory(): void {
    for (const s of this.net.log) this.hidden.add(s.id);
  }

  goOffline(): void {
    this.offline = true;
    this.#frozen = new Set(this.net.log.map((s) => s.id).filter((id) => !this.hidden.has(id)));
  }

  goOnline(): void {
    this.offline = false;
    this.#frozen = undefined;
  }

  createDocument(documentId: DocumentId, creator: MemberId): Promise<void> {
    return this.net.inner.createDocument(documentId, creator);
  }

  async send(documentId: DocumentId, sender: MemberId, payload: string): Promise<DeliveryId> {
    if (this.offline) throw new TransportSendError("unavailable", `${this.device} is offline`);
    const id = await this.net.inner.send(documentId, sender, payload);
    const sent: Sent = {
      at: Date.now(),
      id,
      sender,
      device: this.device,
      frame: decodeFrame(payload),
    };
    this.net.log.push(sent);
    for (const view of this.net.views) {
      if (view !== this && view.rules.some((rule) => rule(sent))) view.hidden.add(id);
    }
    return id;
  }

  async receive(documentId: DocumentId, member: MemberId): Promise<readonly Delivery[]> {
    if (this.offline) throw new TransportSendError("unavailable", `${this.device} is offline`);
    if (this.failNextReceive) {
      this.failNextReceive = false;
      throw new TransportSendError("unavailable", "the bridge does not answer");
    }
    const frozen = this.#frozen;
    return (await this.net.inner.receive(documentId, member)).filter(
      (d) => !this.hidden.has(d.id) && (frozen === undefined || frozen.has(d.id)),
    );
  }

  listChannels(member: MemberId) {
    return this.net.inner.listChannels(member);
  }
}

interface Device {
  readonly engine: DocumentEngine;
  readonly view: View;
}

const BASE: DocumentEngineOptions = {
  batchWindowMs: 0,
  resyncResponseThrottleMs: 0,
  creatorMemberId: "alice",
  ...PACE,
};

async function createAs(
  net: Net,
  device: string,
  extra: DocumentEngineOptions = {},
): Promise<Device> {
  const view = net.view("alice", device);
  const engine = await DocumentEngine.create(DOC, "alice", view, undefined, { ...BASE, ...extra });
  return { engine, view };
}

async function joinAs(
  net: Net,
  member: MemberId,
  device: string = member,
  extra: DocumentEngineOptions = {},
  prepare?: (view: View) => void,
): Promise<Device> {
  const view = net.view(member, device);
  prepare?.(view);
  const engine = await DocumentEngine.join(DOC, member, view, undefined, { ...BASE, ...extra });
  return { engine, view };
}

/** Each online device polls once, then what it sent goes out. */
async function poll(devices: readonly Device[]): Promise<void> {
  for (const d of devices) {
    if (d.view.offline) continue;
    await d.engine.sync().catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
  }
}

/** Polls every device every `step` ms for `ms`. */
async function run(ms: number, devices: readonly Device[], step = 1_000): Promise<void> {
  for (let passed = 0; passed < ms; passed += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - passed));
    await poll(devices);
  }
}

/** A decision of a device of the creator, not waited for: offline it holds it. */
async function decide(d: Device, action: (engine: DocumentEngine) => Promise<void>): Promise<void> {
  action(d.engine).catch(() => {});
  await vi.advanceTimersByTimeAsync(0);
}

/** a1 creates "Plan", lets every one of `members` write; they join and settle. */
async function group(members: readonly MemberId[], extra: DocumentEngineOptions = {}) {
  const net = new Net();
  await net.inner.createDocument(DOC, "alice");
  const a1 = await createAs(net, "a1", extra);
  for (const member of members) await decide(a1, (engine) => engine.setMembership(member, "write"));
  a1.engine.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
  await run(5_000, [a1]);
  const devices: Device[] = [];
  for (const member of members) devices.push(await joinAs(net, member, member, extra));
  await run(2 * MINUTE, [a1, ...devices]);
  for (const d of devices) expect(d.engine.hasCompletedBootstrap).toBe(true);
  return { net, a1, devices };
}

const isEditOf = (device: string) => (s: Sent) => s.device === device && s.frame.kind === "edit";

/**
 * Carol's "u1" reaches nobody; "u2", which builds on it, reaches `sees` alone; then she is gone for
 * good. Who got u2 holds a gap of Carol's stream nobody can heal (LOS-2).
 */
async function carolLostU1(
  carol: Device,
  everyone: readonly Device[],
  sees: readonly Device[],
): Promise<void> {
  for (const d of everyone) if (d !== carol) d.view.loseNext(isEditOf("carol"));
  carol.engine.edit((fragment) => insertPlainText(fragment, 0, "u1"));
  // Each sent once the floor allows, if there is one (SND-2), and so apart.
  await run(1_000, [carol]);
  while (carol.engine.hasPendingChanges) await run(1_000, [carol]);
  for (const d of everyone)
    if (d !== carol && !sees.includes(d)) d.view.loseAll((s) => s.device === "carol");
  carol.engine.edit((fragment) => insertPlainText(fragment, 0, "u2"));
  while (carol.engine.hasPendingChanges) await run(1_000, [carol]);
  carol.engine.dispose();
  carol.view.goOffline();
}

/**
 * When a device whose stream is `stream` first asks for the gap `key` that arose at `since`, as its
 * polls each second see it: once the gap lasted twice the evidence wait and then its slot, derived from
 * the gap and the stream over the answer window as a member's turn is (LOS-6, RSY-20).
 */
function firstTryAt(key: string, stream: string, since: number, latencyMs = 2_000): number {
  const due = since + 2 * latencyMs + answerDelayMs(key, stream, answerWindowMs(latencyMs));
  return T + Math.ceil((due - T) / 1_000) * 1_000;
}

/** The gap of the updates of `writer`'s CRDT client (LOS-25). */
const gapOf = (writer: Device): string => `content:${writer.engine.document.clientID}`;

/** The times, from `since` on, at which `device` sent a request, and whether each asked all. */
function requests(
  net: Net,
  device: string,
  since = 0,
): { at: number; all: boolean; stream: string }[] {
  return net.sent(device, "resync-request", since).map((s) => {
    const frame = s.frame as ResyncRequestFrame;
    return { at: s.at, all: frame.all, stream: frame.stream };
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("each gap has tries of its own (LOS-6, LOS-25)", () => {
  it("an old gap nobody can heal rests after three requests to all, and a later loss of another writer is asked for with tries of its own (LOS-6, LOS-25)", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, devices } = await group(["bob", "carol", "dave"]);
    const [bob, carol, dave] = devices as [Device, Device, Device];
    await carolLostU1(carol, [a1, ...devices], [bob]);
    const live = [a1, bob, dave];
    await run(HOUR, live, 10_000);
    expect(bob.engine.syncHealth.suspicions).toMatchObject([
      { kind: "pending-gap", sender: "carol", tries: MAX_GAP_TRIES, resting: true },
    ]);
    const t1 = Date.now();
    // Dave's D1 is lost on its way to Bob; his D2 builds on it. What answers Bob's first request for it
    // is lost too: only a further try of that gap heals it.
    bob.view.loseNext(isEditOf("dave"));
    dave.engine.edit((fragment) => insertPlainText(fragment, 0, "D1 "));
    await run(2_000, live);
    dave.engine.edit((fragment) => insertPlainText(fragment, 0, "D2 "));
    const answers = bob.view.loseAll((s) => s.frame.kind === "resync-response");
    for (let waited = 0; requests(net, "bob", t1).length === 0; waited += 1_000) {
      expect(waited).toBeLessThan(MINUTE);
      await run(1_000, live);
    }
    await run(45_000, live);
    answers();
    await run(3 * MINUTE, live);
    expect(getPlainText(bob.engine.fragment)).toContain("D2 D1 ");
    expect(requests(net, "bob", t1).length).toBeGreaterThanOrEqual(2);
    expect(requests(net, "bob", t1).every((request) => request.all)).toBe(true);
    // Carol's still rests, and asks nothing of its own.
    expect(bob.engine.syncHealth.suspicions).toMatchObject([
      { kind: "pending-gap", sender: "carol", tries: MAX_GAP_TRIES, resting: true },
    ]);
  });

  it("its first try waits twice the evidence wait and then its slot; each further one twice the expiry of a request that does not ask all, doubling, never while the one before is outstanding nor more than 10 min apart; every one asks all", {
    timeout: 60_000,
  }, async () => {
    // 100 s of latency: a gap is first asked for after 200 s and its slot in a window of 300 s; a
    // request waits 200 s, one to all 500 s.
    const slow = { syncPolicy: { expectedLatencyMs: 100_000 } };
    const { net, a1, devices } = await group(["bob", "carol"], slow);
    const [bob, carol] = devices as [Device, Device];
    await carolLostU1(carol, [a1, ...devices], [bob]);
    await poll([bob]); // u2 arrives: the gap arises
    const since = Date.now();
    expect(bob.engine.syncHealth.suspicions).toStrictEqual([]); // not yet believed (LOS-1)
    await run(45 * MINUTE, [a1, bob]);
    const asked = requests(net, "bob", since);
    expect(asked.map((request) => request.all)).toStrictEqual([true, true, true]);
    const [first, second, third] = asked.map((request) => request.at) as [number, number, number];
    expect(first).toBe(firstTryAt(gapOf(carol), asked[0]?.stream as string, since, 100_000));
    // The second waits out the first's expiry (500 s) rather than twice the expiry (400 s); the third
    // twice that, 800 s, held to the bound of 10 min.
    expect(second - first).toBe(500_000);
    expect(third - second).toBe(600_000);
  });

  it("a resting gap is shown as resting and asks nothing while no frame carries its stream further", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, devices } = await group(["bob", "carol"]);
    const [bob, carol] = devices as [Device, Device];
    await carolLostU1(carol, [a1, ...devices], [bob]);
    await run(10 * MINUTE, [a1, bob]);
    const rested = requests(net, "bob").length;
    for (let minute = 0; minute < 60; minute += 5) {
      a1.engine.edit((fragment) => insertPlainText(fragment, 0, "a"));
      await run(5 * MINUTE, [a1, bob], 5_000);
    }
    expect(requests(net, "bob")).toHaveLength(rested);
    expect(bob.engine.syncHealth).toMatchObject({
      state: "suspected",
      suspicions: [{ kind: "pending-gap", sender: "carol", tries: MAX_GAP_TRIES, resting: true }],
    });
  });
});

describe("what wakes a resting gap (LOS-26)", () => {
  /** Bob holds a resting gap of Carol's stream; Carol is back and writes, but what she answers never reaches Bob. */
  async function carolBackUnheard() {
    const { net, a1, devices } = await group(["bob", "carol", "dave"]);
    const [bob, carol, dave] = devices as [Device, Device, Device];
    for (const d of [a1, bob, dave]) d.view.loseNext(isEditOf("carol"));
    carol.engine.edit((fragment) => insertPlainText(fragment, 0, "u1"));
    await run(3_000, [carol]);
    carol.view.goOffline();
    carol.engine.edit((fragment) => insertPlainText(fragment, 0, "u2"));
    // u2 goes once she is back; meanwhile Bob and Dave get it from nowhere: they lack it all.
    await run(2_000, [a1, bob, dave]);
    for (const d of [a1, bob, dave])
      d.view.loseAll((s) => s.device === "carol" && s.frame.kind === "resync-response");
    carol.view.goOnline();
    await run(5_000, [a1, bob, carol, dave]);
    carol.view.goOffline();
    await run(10 * MINUTE, [a1, bob, dave]);
    expect(bob.engine.syncHealth.suspicions).toMatchObject([
      { kind: "pending-gap", sender: "carol", resting: true },
    ]);
    return { net, a1, bob, carol, dave };
  }

  it("a frame that carries the gap's stream further wakes it: one request to all, in a slot after the wake, at most one in 10 min", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, bob, carol, dave } = await carolBackUnheard();
    // a1, Bob and Dave hold the same gap: whichever asks first, the others let theirs go (RSY-22).
    const asked = (since: number) =>
      ["a1", "bob", "dave"]
        .flatMap((device) => requests(net, device, since))
        .sort((x, y) => x.at - y.at);
    const back = Date.now();
    carol.view.goOnline();
    carol.engine.edit((fragment) => insertPlainText(fragment, 0, "u3"));
    while (net.sent("carol", "edit", back).length === 0) await run(1_000, [a1, bob, carol, dave]);
    // Not at once: after the wait and a slot of its own over the answer window of 30 s (LOS-6, LOS-26).
    await run(3_000, [a1, bob, carol, dave]);
    expect(asked(back)).toStrictEqual([]);
    await run(32_000, [a1, bob, carol, dave]);
    expect(asked(back)).toMatchObject([{ all: true }]);
    // She writes every minute for half an hour: each edit carries her stream further.
    for (let minute = 0; minute < 30; minute++) {
      carol.engine.edit((fragment) => insertPlainText(fragment, 0, "c"));
      await run(MINUTE, [a1, bob, carol, dave], 5_000);
    }
    const woken = asked(back);
    expect(woken.length).toBeGreaterThanOrEqual(3);
    expect(woken.length).toBeLessThanOrEqual(4);
    for (const [index, request] of woken.slice(1).entries()) {
      expect(request.at - (woken[index] as { at: number }).at).toBeGreaterThanOrEqual(10 * MINUTE);
    }
    expect(bob.engine.syncHealth.suspicions).toMatchObject([
      { kind: "pending-gap", sender: "carol", resting: true },
    ]);
  });

  it("the same position named again by someone else wakes nothing", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, bob, dave } = await carolBackUnheard();
    await run(11 * MINUTE, [a1, bob, dave]);
    const before = requests(net, "bob").length + requests(net, "a1").length;
    // Dave holds the same of Carol's as Bob and a1; his request names it again.
    expect(await dave.engine.requestResync()).toStrictEqual({ sent: true });
    await run(5 * MINUTE, [a1, bob, dave]);
    expect(requests(net, "bob").length + requests(net, "a1").length).toBe(before);
  });

  it("the person's request wakes every resting gap: refused by the floor, its gaps ask by themselves once it allows, once", {
    timeout: 60_000,
  }, async () => {
    const floored = { syncPolicy: { expectedLatencyMs: 2_000, minIntervalMs: 30_000 } };
    const { net, a1, devices } = await group(["bob", "carol"], floored);
    const [bob, carol] = devices as [Device, Device];
    await carolLostU1(carol, [a1, ...devices], [bob]);
    await run(30 * MINUTE, [a1, bob], 5_000);
    const rested = requests(net, "bob").length;
    expect(bob.engine.syncHealth.suspicions).toMatchObject([{ resting: true }]);
    bob.engine.edit((fragment) => insertPlainText(fragment, 0, "b"));
    await run(1_000, [a1, bob]);
    expect(await bob.engine.requestResync()).toStrictEqual({ sent: false, reason: "rate-floor" });
    await run(2 * MINUTE, [a1, bob]);
    expect(requests(net, "bob").slice(rested)).toMatchObject([{ all: true }]);
    await run(30 * MINUTE, [a1, bob], 5_000);
    expect(requests(net, "bob")).toHaveLength(rested + 1);
    expect(bob.engine.syncHealth.suspicions).toMatchObject([{ resting: true }]);
  });

  it("the person's request that goes is the one request of every resting gap, which rests again after it", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, devices } = await group(["bob", "carol"]);
    const [bob, carol] = devices as [Device, Device];
    await carolLostU1(carol, [a1, ...devices], [bob]);
    await run(30 * MINUTE, [a1, bob], 5_000);
    const rested = requests(net, "bob").length;
    expect(await bob.engine.requestResync()).toStrictEqual({ sent: true });
    await run(30 * MINUTE, [a1, bob], 5_000);
    expect(requests(net, "bob")).toHaveLength(rested + 1);
    expect(bob.engine.syncHealth.suspicions).toMatchObject([
      { tries: MAX_GAP_TRIES, resting: true },
    ]);
  });
});

describe("whose gap it is (LOS-2, LOS-4, LOS-25)", () => {
  it("a report of a member naming a position this engine lacks is a gap of the writer, not of the member that reported it", {
    timeout: 60_000,
  }, async () => {
    const { a1, devices } = await group(["bob", "carol", "dave"]);
    const [bob, carol, dave] = devices as [Device, Device, Device];
    // Dave's first edit reaches everyone: whose CRDT client it is, everyone learns (LOS-2).
    dave.engine.edit((fragment) => insertPlainText(fragment, 0, "D0 "));
    await run(2_000, [a1, bob, carol, dave]);
    // His next reaches Carol and nobody else, and he is gone before anything else of his goes.
    for (const d of [a1, bob]) d.view.loseNext(isEditOf("dave"));
    dave.engine.edit((fragment) => insertPlainText(fragment, 0, "D "));
    await vi.advanceTimersByTimeAsync(0);
    dave.view.goOffline();
    dave.engine.dispose();
    await run(2_000, [a1, bob, carol]);
    // Carol's request states what she holds: Dave's edit among it (LOS-13).
    a1.view.goOffline();
    expect(await carol.engine.requestResync()).toStrictEqual({ sent: true });
    await run(5_000, [bob, carol]);
    const gaps = bob.engine.syncHealth.suspicions;
    expect(gaps).toMatchObject([{ kind: "behind-heartbeat", sender: "dave" }]);
    expect(gaps[0]?.key).toMatch(/^content:\d+$/);
  });

  it("a truncated history asks at once, forcing an answer, rests after three tries, and the engine is not safely synchronised (LOS-19)", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, devices } = await group(["bob", "carol"]);
    const [bob, carol] = devices as [Device, Device];
    a1.view.goOffline();
    carol.view.goOffline();
    bob.view.failNextReceive = true;
    await poll([bob]);
    const since = Date.now();
    await poll([bob]); // the first answer after a failure may have lost what slid out (LOS-8)
    expect(requests(net, "bob", since)).toHaveLength(1);
    expect(
      (net.sent("bob", "resync-request", since)[0]?.frame as ResyncRequestFrame | undefined)?.force,
    ).toBe(true);
    await run(20 * MINUTE, [bob], 5_000);
    expect(requests(net, "bob", since).map((request) => request.all)).toStrictEqual([
      true,
      true,
      true,
    ]);
    expect(bob.engine.syncHealth).toMatchObject({
      state: "suspected",
      suspicions: [
        { kind: "history-truncated", key: "truncated", tries: MAX_GAP_TRIES, resting: true },
      ],
    });
  });
});

describe("a device of the creator's reports of control state (LOS-12, LOS-18)", () => {
  it("a lost decision of a2's, which a2's next report shows, is not ended by a1's whole answer, which states another state: Bob asks again", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, devices } = await group(["bob", "carol", "dave"]);
    const [bob, carol, dave] = devices as [Device, Device, Device];
    const a2 = await joinAs(net, "alice", "a2");
    await run(MINUTE, [a1, a2, bob, carol, dave]);
    expect(a2.engine.controlStanding.kind).toBe("bootstrapped");
    carol.view.goOffline();
    // a1 hears nothing of a2's (another network, say); Bob loses a2's decision Y and its answers, and
    // gets its next decision X and the report after it, which states a2's control clock and digest.
    a1.view.loseAll((s) => s.device === "a2");
    const y = (s: Sent) =>
      s.device === "a2" &&
      s.frame.kind === "control" &&
      Object.hasOwn(s.frame.targets, "member:gina");
    bob.view.loseAll((s) => y(s) || (s.device === "a2" && s.frame.kind === "resync-response"));
    await decide(a2, (engine) => engine.setMembership("gina", "write"));
    await run(5_000, [a1, a2, bob, dave]);
    await decide(a2, (engine) => engine.setMembership("hank", "read"));
    await run(3_000, [a1, a2, bob, dave]);
    expect(bob.engine.permissionOf("hank")).toBe("read");
    expect(bob.engine.permissionOf("gina")).toBeUndefined();
    // a1 holds content Bob lacks — Dave's, gone before his report —, so it answers Bob's request with
    // it and with its control state, which lacks X and Y.
    bob.view.loseNext(isEditOf("dave"));
    dave.engine.edit((fragment) => insertPlainText(fragment, 0, "d"));
    await vi.advanceTimersByTimeAsync(0);
    dave.view.goOffline();
    const t0 = Date.now();
    await run(10 * MINUTE, [a1, a2, bob]);
    const asked = net
      .sent("bob", "resync-request", t0)
      .map((s) => (s.frame as ResyncRequestFrame).requestId);
    expect(
      net.log.filter(
        (s) =>
          s.device === "a1" &&
          s.frame.kind === "resync-response" &&
          s.frame.respondsTo === asked[0],
      ),
    ).toHaveLength(1);
    expect(getPlainText(bob.engine.fragment)).toContain("d");
    // a1's whole answer ended the gap of Dave's, not that of a2's report: Bob asked for it again.
    expect(asked.length).toBeGreaterThanOrEqual(2);
    expect(bob.engine.syncHealth.suspicions).toMatchObject([
      { kind: "control-diverged", sender: "alice", key: expect.stringMatching(/^control-report:/) },
    ]);
  });

  it("a device of the creator asks for its own gap whatever its bootstrap, its own attempts having run out (RSY-5)", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, devices } = await group(["bob", "carol"]);
    const [bob, carol] = devices as [Device, Device];
    a1.view.goOffline();
    const a2 = await joinAs(net, "alice", "a2", {}, (view) => view.hideHistory());
    await run(HOUR, [a2, bob, carol], 10_000);
    expect(a2.engine.controlStanding.kind).toBe("none");
    expect(a2.engine.syncHealth.attemptsRanOut).toBe(true);
    const t0 = Date.now();
    // Carol's first edit never reaches a2, her second does: a gap of Carol's stream at a2 (LOS-2).
    a2.view.loseNext(isEditOf("carol"));
    carol.engine.edit((fragment) => insertPlainText(fragment, 0, "c1 "));
    await run(1_000, [a2, bob, carol]);
    carol.engine.edit((fragment) => insertPlainText(fragment, 0, "c2 "));
    await run(2 * MINUTE, [a2, bob, carol]);
    expect(requests(net, "a2", t0).length).toBeGreaterThanOrEqual(1);
    expect(getPlainText(a2.engine.fragment)).toContain("c2 c1 ");
  });
});

describe("one request for a gap several devices hold (RSY-22)", () => {
  /** Carol's u1 reaches none of `lacking`; u2, which builds on it, reaches all. Carol stays and answers at her turn. */
  async function sameGap(
    lacking: readonly Device[],
    everyone: readonly Device[],
    carol: Device,
  ): Promise<void> {
    for (const d of lacking) d.view.loseNext(isEditOf("carol"));
    carol.engine.edit((fragment) => insertPlainText(fragment, 0, "u1 "));
    await run(1_000, [carol]);
    carol.engine.edit((fragment) => insertPlainText(fragment, 0, "u2 "));
    await vi.advanceTimersByTimeAsync(0);
    await poll(everyone);
  }

  it("four devices with the same gap: one request, Carol's answer to it, and every one of them takes it", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, devices } = await group(["bob", "carol", "dave", "erin", "fay"]);
    const [bob, carol, dave, erin, fay] = devices as [Device, Device, Device, Device, Device];
    const lacking = [a1, bob, dave, erin, fay];
    a1.view.goOffline();
    const t0 = Date.now();
    await sameGap([bob, dave, erin, fay], [bob, carol, dave, erin, fay], carol);
    await run(2 * MINUTE, [bob, carol, dave, erin, fay]);
    const asked = ["bob", "dave", "erin", "fay"].flatMap((device) =>
      net.sent(device, "resync-request", t0),
    );
    expect(asked).toHaveLength(1);
    // Carol, who holds u1, answers at her turn. Another, holding it only by that answer, answers too
    // only where its turn passed before the poll that brought it Carol's answer (RSY-20): the poll in
    // which she answered, or — where it polled before her in that one — its next, a second later.
    const answers = net.log.filter((s) => s.at >= t0 && s.frame.kind === "resync-response");
    expect(answers[0]?.device).toBe("carol");
    for (const answer of answers)
      expect(answer.at - (answers[0] as Sent).at).toBeLessThanOrEqual(1_000);
    for (const d of lacking.slice(1)) {
      expect(getPlainText(d.engine.fragment)).toContain("u2 u1 ");
      expect(d.engine.syncHealth.suspicions).toStrictEqual([]);
    }
  });

  it("a request to all that reaches further on the gap's stream does not stop this device's own", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, devices } = await group(["bob", "carol", "dave", "erin"]);
    const [bob, carol, dave, erin] = devices as [Device, Device, Device, Device];
    a1.view.goOffline();
    // Erin holds Carol's u1 and lacks Dave's d1; Bob lacks u1. Carol writes at the end, Dave at the
    // start: her changes build on hers alone, so Erin holds no gap of Carol's.
    erin.view.loseNext(isEditOf("dave"));
    dave.engine.edit((fragment) => insertPlainText(fragment, 0, "d1 "));
    await run(1_000, [dave]);
    dave.engine.edit((fragment) => insertPlainText(fragment, 0, "d2 "));
    await vi.advanceTimersByTimeAsync(0);
    bob.view.loseNext(isEditOf("carol"));
    carol.engine.edit((fragment) =>
      insertPlainText(fragment, getPlainText(fragment).length, " u1"),
    );
    await run(1_000, [carol]);
    carol.engine.edit((fragment) =>
      insertPlainText(fragment, getPlainText(fragment).length, " u2"),
    );
    await vi.advanceTimersByTimeAsync(0);
    const t0 = Date.now();
    await poll([erin, bob, carol, dave]);
    await run(2 * MINUTE, [erin, bob, carol, dave]);
    const [erins] = requests(net, "erin", t0);
    const [bobs] = requests(net, "bob", t0);
    // Each asks in its gap's slot: neither lets its request go for the other's, which reaches further,
    // nor waits for that one to expire (RSY-22).
    expect(erins?.at).toBe(firstTryAt(gapOf(dave), erins?.stream as string, t0));
    expect(bobs?.at).toBe(firstTryAt(gapOf(carol), bobs?.stream as string, t0));
    for (const text of ["u1", "u2"]) expect(getPlainText(bob.engine.fragment)).toContain(text);
    for (const text of ["d1", "d2"]) expect(getPlainText(erin.engine.fragment)).toContain(text);
  });

  it("an answer to a request a device of the creator let its own go for brings content, and bootstraps it not (RSY-14)", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, devices } = await group(["bob", "carol"]);
    const [bob, carol] = devices as [Device, Device];
    a1.view.goOffline();
    // a1 never hears a2: it answers none of a2's own requests.
    a1.view.loseAll((s) => s.device === "a2");
    const a2 = await joinAs(net, "alice", "a2", {}, (view) => view.hideHistory());
    await run(HOUR, [a2, bob, carol], 10_000);
    expect(a2.engine.controlStanding.kind).toBe("none");
    // Carol's u1 reaches neither Bob nor a2, u2 reaches both; Carol answers nobody. Bob asks first, a2
    // reading nothing meanwhile; a2 reads u2 with his request, and lets its own go for his once its gap
    // lasted its wait, before its slot (LOS-6).
    for (const d of [bob, a2])
      d.view.loseAll((s) => s.device === "carol" && s.frame.kind === "resync-response");
    const t0 = Date.now();
    await sameGap([bob, a2], [bob, carol], carol);
    for (let waited = 0; net.sent("bob", "resync-request", t0).length === 0; waited += 1_000) {
      expect(waited).toBeLessThan(MINUTE);
      await run(1_000, [bob, carol]);
    }
    await run(5_000, [bob, a2, carol]);
    expect(a2.engine.syncHealth.suspicions).toMatchObject([{ kind: "pending-gap", tries: 1 }]);
    expect(net.sent("a2", "resync-request", t0)).toHaveLength(0);
    // a1 is back with everything, and answers Bob's request at once, with its control state.
    a1.view.goOnline();
    await poll([a1]);
    expect(
      net.log.filter((s) => s.at >= t0 && s.device === "a1" && s.frame.kind === "resync-response"),
    ).toHaveLength(1);
    await poll([a2]);
    // a2 took that answer: the content, but not the bootstrap, which only an answer to its own request
    // brings (RSY-14).
    for (const text of ["u1", "u2"]) expect(getPlainText(a2.engine.fragment)).toContain(text);
    expect(a2.engine.controlStanding.kind).toBe("none");
    await run(MINUTE, [a1, bob, a2, carol]);
    expect(a2.engine.controlStanding.kind).toBe("none");
  });
});

describe("a request to all read as a device catches up (RSY-22)", () => {
  /** Dave asks all; then he is gone, and 40 minutes pass for `others`. */
  async function daveAskedLongAgo(dave: Device, others: readonly Device[]): Promise<void> {
    await dave.engine.requestResync();
    await run(5_000, [dave, ...others]);
    dave.engine.dispose();
    dave.view.goOffline();
    await run(40 * MINUTE, others, 60_000);
  }

  /**
   * Carol's u1 never reaches `lacking`, and u2, which builds on it, does: a gap of Carol's stream on
   * which Dave's request reaches no further than `lacking`'s would, but whose answers came and went
   * long ago. When `lacking` read u2.
   */
  async function carolsGap(lacking: Device, carol: Device): Promise<number> {
    lacking.view.loseNext(isEditOf("carol"));
    carol.engine.edit((fragment) => insertPlainText(fragment, 0, "u1 "));
    await run(1_000, [carol]);
    carol.engine.edit((fragment) => insertPlainText(fragment, 0, "u2 "));
    await vi.advanceTimersByTimeAsync(0);
    const at = Date.now();
    await poll([lacking]);
    return at;
  }

  it("a device that starts again lets no try of its own go for a request to all its first read brings", {
    timeout: 60_000,
  }, async () => {
    const net = new Net();
    await net.inner.createDocument(DOC, "alice");
    let saved: PersistedControlState | undefined;
    const a1 = await createAs(net, "a1", { onControlStateChange: (state) => (saved = state) });
    for (const member of ["carol", "dave"])
      await decide(a1, (engine) => engine.setMembership(member, "write"));
    a1.engine.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
    await run(5_000, [a1]);
    const carol = await joinAs(net, "carol");
    const dave = await joinAs(net, "dave");
    await run(2 * MINUTE, [a1, carol, dave]);
    await daveAskedLongAgo(dave, [a1, carol]);
    // a1 stops, and starts again five minutes later: within 10 minutes and without a gap, no start
    // request (RSY-1). Its first read brings Dave's request again, as it brings everything.
    const kept = {
      controlState: saved as PersistedControlState,
      restore: { state: encodeUpdate(a1.engine.document), readAt: Date.now() },
    };
    a1.engine.dispose();
    a1.view.goOffline();
    await run(5 * MINUTE, [carol], 10_000);
    const t0 = Date.now();
    const view = net.view("alice", "a1b");
    const restarted: Device = {
      engine: await DocumentEngine.join(DOC, "alice", view, undefined, { ...BASE, ...kept }),
      view,
    };
    await run(2_000, [restarted, carol]);
    const t1 = await carolsGap(restarted, carol);
    // Carol, who holds u1, answers at her turn, within the answer window (RSY-20).
    await run(2 * MINUTE, [restarted, carol]);
    const asked = requests(net, "a1b", t0);
    // Its gap asks by itself, to all, once it lasted twice the evidence wait and its slot.
    expect(asked[0]).toMatchObject({
      at: firstTryAt(gapOf(carol), asked[0]?.stream as string, t1),
      all: true,
    });
    expect(getPlainText(restarted.engine.fragment)).toContain("u2 u1 ");
  });

  it("a running device told of an absence lets no try of its own go for a request to all the read it caught up with brought", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, devices } = await group(["bob", "carol", "dave"]);
    const [bob, carol, dave] = devices as [Device, Device, Device];
    bob.view.goOffline();
    await daveAskedLongAgo(dave, [a1, carol]);
    // A decision of a1's never reaches Bob: a1 answers his start request at once with it.
    bob.view.loseNext((s) => s.device === "a1" && s.frame.kind === "control");
    await decide(a1, (engine) => engine.setMembership("erin", "read"));
    await run(2_000, [a1, carol]);
    bob.view.goOnline();
    const t0 = Date.now();
    await poll([bob]);
    bob.engine.noteAbsence(45 * MINUTE);
    await run(2_000, [bob, a1, carol]);
    expect(bob.engine.permissionOf("erin")).toBe("read");
    const t1 = await carolsGap(bob, carol);
    await run(MINUTE, [bob, a1, carol]);
    const asked = requests(net, "bob", t0);
    // The start request, and then the gap's own, once it lasted twice the evidence wait and its slot.
    expect(asked.map((request) => request.all)).toStrictEqual([true, true]);
    expect(asked[1]?.at).toBe(firstTryAt(gapOf(carol), asked[1]?.stream as string, t1));
    expect(getPlainText(bob.engine.fragment)).toContain("u2 u1 ");
  });
});

describe("the further request of a bootstrap whose attempts ran out (RSY-5)", () => {
  it("a joiner answered with content alone asks once more on a frame of a member that did not answer its latest request, and not on the frames of the one that did (RSY-5)", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, devices } = await group(["bob", "carol", "dave"]);
    a1.view.goOffline();
    // A new device of the creator, which only members bootstrap not (CTL-27): it holds the content.
    const a2 = await joinAs(net, "alice", "a2", {}, (view) => view.hideHistory());
    await run(3 * MINUTE, [a2, ...devices]);
    expect(a2.engine.controlStanding.kind).toBe("none");
    // The members are away; nothing sent meanwhile reaches them.
    const back = devices.map((d) => d.view.loseAll(() => true));
    for (const d of devices) d.view.goOffline();
    const erin = await joinAs(net, "erin", "erin", {}, (view) => view.hideHistory());
    const live = [a2, erin];
    await run(15 * MINUTE, live, 5_000);
    expect(erin.engine.syncHealth.attemptsRanOut).toBe(true);
    expect(erin.engine.hasCompletedBootstrap).toBe(false);
    // a2 had nothing more to give Erin's latest requests. Now a2 writes, each edit lost on its way to
    // Erin, and asks: its first frame brings Erin one request more, which a2 answers with content alone;
    // its later frames bring none (RSY-5).
    const ranOut = requests(net, "erin").length;
    erin.view.loseAll(isEditOf("a2"));
    for (let minute = 0; minute < 10; minute++) {
      a2.engine.edit((fragment) => insertPlainText(fragment, 0, "p"));
      await poll(live);
      await a2.engine.requestResync();
      await run(MINUTE, live, 5_000);
    }
    expect(requests(net, "erin").length - ranOut).toBe(1);
    expect(erin.engine.hasCompletedBootstrap).toBe(false);
    // The members are back and write: a frame of one that did not answer brings one request more.
    for (const lift of back) lift();
    for (const d of devices) d.view.goOnline();
    for (let minute = 0; minute < 10 && !erin.engine.hasCompletedBootstrap; minute++) {
      (devices[minute % devices.length] as Device).engine.edit((fragment) =>
        insertPlainText(fragment, 0, "m"),
      );
      await run(MINUTE, [...live, ...devices], 5_000);
    }
    expect(erin.engine.hasCompletedBootstrap).toBe(true);
    expect(requests(net, "erin").length - ranOut).toBe(2);
  });

  it("a joiner a device of the creator answered with content alone asks once more on a frame of another device of the creator that states a control clock, though the creator answered, and is bootstrapped (RSY-5, RSY-14)", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, devices } = await group(["bob"]);
    const [bob] = devices as [Device];
    // a1 is away, and when back it has heard nothing sent meanwhile: no request of a joiner's from
    // before reaches it.
    a1.view.goOffline();
    const a1Hears = a1.view.loseAll(() => true);
    // A new device of the creator, which only a1 bootstraps (CTL-27): it holds the content.
    const a2 = await joinAs(net, "alice", "a2", {}, (view) => view.hideHistory());
    await run(3 * MINUTE, [a2, bob]);
    expect(a2.engine.controlStanding.kind).toBe("none");
    bob.view.goOffline();
    // a2 writes every minute, nothing of it reaching Erin but its answers: it holds what she lacks, and
    // answers her requests at once with content alone. The creator answered her latest.
    const erin = await joinAs(net, "erin", "erin", {}, (view) => view.hideHistory());
    const hidden = erin.view.loseAll(
      (s) => s.device === "a2" && s.frame.kind !== "resync-response",
    );
    for (let minute = 0; minute < 20; minute++) {
      a2.engine.edit((fragment) => insertPlainText(fragment, 0, "p"));
      await run(MINUTE, [a2, erin], 5_000);
    }
    expect(erin.engine.syncHealth.attemptsRanOut).toBe(true);
    expect(erin.engine.hasCompletedBootstrap).toBe(false);
    const asked = net
      .sent("erin", "resync-request")
      .map((s) => (s.frame as ResyncRequestFrame).requestId);
    const answered = net
      .sent("a2", "resync-response")
      .map((s) => s.frame.kind === "resync-response" && s.frame.respondsTo);
    expect(answered).toContain(asked.at(-1));
    // a2 writes on, and its reports reach Erin now: they state no control clock, as a2 is not
    // bootstrapped, so they bring her nothing, the creator having answered her latest request.
    const ranOut = asked.length;
    hidden();
    erin.view.loseAll(isEditOf("a2"));
    const reported = Date.now();
    for (let minute = 0; minute < 30; minute++) {
      a2.engine.edit((fragment) => insertPlainText(fragment, 0, "q"));
      await run(MINUTE, [a2, erin], 5_000);
    }
    expect(net.sent("a2", "heartbeat", reported).length).toBeGreaterThan(0);
    expect(requests(net, "erin")).toHaveLength(ranOut);
    // a1 is back and decides: its frame states its control clock, and brings Erin one request more,
    // which a1 answers with its control state.
    a1Hears();
    a1.view.goOnline();
    await decide(a1, (engine) => engine.setMembership("frank", "read"));
    await run(20 * MINUTE, [a1, a2, erin], 5_000);
    expect(requests(net, "erin").length - ranOut).toBe(1);
    expect(erin.engine.hasCompletedBootstrap).toBe(true);
    expect(erin.engine.permissionOf("frank")).toBe("read");
  });

  it("a frame of a device of the creator stating a control clock, read while the joiner's latest request still waited, brings no further request (RSY-5)", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, devices } = await group(["bob"]);
    const [bob] = devices as [Device];
    bob.view.goOffline();
    // a1 hears nothing of Erin's: nobody answers her.
    a1.view.loseAll((s) => s.device === "erin");
    a1.view.goOffline();
    const erin = await joinAs(net, "erin", "erin", {}, (view) => view.hideHistory());
    for (let waited = 0; requests(net, "erin").length < 6; waited += 1_000) {
      expect(waited).toBeLessThan(30 * MINUTE);
      await run(1_000, [erin]);
    }
    // As her last attempt waits, a1 is there for a moment: its decision and its report reach her.
    const last = requests(net, "erin").at(-1) as { at: number };
    a1.view.goOnline();
    await decide(a1, (engine) => engine.setMembership("frank", "read"));
    await run(15_000, [a1, erin]);
    a1.view.goOffline();
    const stated = net.log.filter(
      (s) =>
        s.device === "a1" &&
        s.at > last.at &&
        (s.frame.kind === "control" || s.frame.kind === "heartbeat"),
    );
    expect(stated.map((s) => s.frame.kind).sort()).toStrictEqual(["control", "heartbeat"]);
    await run(30 * MINUTE, [erin], 5_000);
    expect(erin.engine.syncHealth.attemptsRanOut).toBe(true);
    expect(requests(net, "erin")).toHaveLength(6);
  });

  it("on a device of the creator, a frame of a member that did not answer its latest request brings no further request either: only its other devices' do (RSY-5)", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, devices } = await group(["bob", "carol", "dave"]);
    const dave = devices[2] as Device;
    a1.view.goOffline();
    // Dave is away while a2 asks: he answers none of its requests.
    dave.view.goOffline();
    const a2 = await joinAs(net, "alice", "a2", {}, (view) => view.hideHistory());
    await run(HOUR, [a2, ...devices], 10_000);
    expect(a2.engine.controlStanding.kind).toBe("none");
    expect(a2.engine.syncHealth.attemptsRanOut).toBe(true);
    const ranOut = requests(net, "a2").length;
    // Dave is back and writes for ten minutes: a member's frame, though he did not answer, asks nothing.
    dave.view.goOnline();
    for (let minute = 0; minute < 10; minute++) {
      dave.engine.edit((fragment) => insertPlainText(fragment, 0, "d"));
      await run(MINUTE, [a2, ...devices], 5_000);
    }
    expect(requests(net, "a2")).toHaveLength(ranOut);
  });

  it("a device of the creator whose attempts members answered asks once more on a frame of another of its devices, never on a member's (RSY-5)", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, devices } = await group(["bob", "carol"]);
    // a1 is away, and when back it has heard nothing a2 sent before.
    a1.view.goOffline();
    const a1Hears = a1.view.loseAll((s) => s.device === "a2");
    const a2 = await joinAs(net, "alice", "a2", {}, (view) => view.hideHistory());
    await run(HOUR, [a2, ...devices], 10_000);
    expect(a2.engine.controlStanding.kind).toBe("none");
    expect(a2.engine.syncHealth.attemptsRanOut).toBe(true);
    // Members write for ten minutes: nothing of theirs brings a2 a request.
    const ranOut = requests(net, "a2").length;
    for (let minute = 0; minute < 10; minute++) {
      (devices[minute % devices.length] as Device).engine.edit((fragment) =>
        insertPlainText(fragment, 0, "m"),
      );
      await run(MINUTE, [a2, ...devices], 5_000);
    }
    expect(requests(net, "a2")).toHaveLength(ranOut);
    // a1 is back and decides: its frame brings a2 one request more, which a1 answers.
    a1.view.goOnline();
    a1Hears();
    await decide(a1, (engine) => engine.setMembership("erin", "read"));
    await run(2 * MINUTE, [a1, a2, ...devices]);
    expect(requests(net, "a2").length - ranOut).toBe(1);
    expect(a2.engine.controlStanding.kind).toBe("bootstrapped");
    expect(a2.engine.permissionOf("erin")).toBe("read");
  });
});
