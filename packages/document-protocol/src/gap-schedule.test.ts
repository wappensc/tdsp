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
 * When a gap asks (SPECIFICATION.md LOS-6, LOS-26, RSY-20, RSY-22): its first try once it lasted twice
 * the evidence wait and then a slot derived from the gap and the device's own stream over the answer
 * window, so that devices holding the same gap — a change the messenger lost for all of them — ask one
 * after another, and those that hear the first request in time let theirs go for it, however close
 * together they read what showed the gap. A resting gap is woken by a frame that carries its stream
 * further and by any frame of the member that wrote its CRDT client, at most once in ten minutes, its
 * request then in a slot as a first try's; and by an absence its application tells of or the person,
 * at once. A frame read while it still had tries leaves no wake behind. Each device here has a view of
 * the channel of its own, which can lose what is sent on the way to it, and sees a message only once it
 * took the latency to arrive.
 */

// The engine's random ids — its stream first (LOS-13) — taken from this queue while it holds any, so
// that a test can choose the streams, and with them the slots of the devices' first tries.
const ids = vi.hoisted(() => ({ queue: [] as string[] }));
vi.mock("./framing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./framing")>();
  return { ...actual, newRandomId: () => ids.queue.shift() ?? actual.newRandomId() };
});

const DOC = "doc-1";
/** 2026-10-26 10:00:00 UTC. */
const T = 1_793_008_800_000;
const MINUTE = 60_000;
/** A message takes 2 s: a gap is believed after 2 s, first asked for after 4 s and its slot in a window of 30 s. */
const LATENCY_MS = 2_000;
const PACE = { syncPolicy: { expectedLatencyMs: LATENCY_MS } };

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
  /** How long a message takes to reach anyone. */
  latencyMs = 0;

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
  readonly hidden = new Set<DeliveryId>();
  readonly rules: ((s: Sent) => boolean)[] = [];

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

  createDocument(documentId: DocumentId, creator: MemberId): Promise<void> {
    return this.net.inner.createDocument(documentId, creator);
  }

  /** Every request of this device's is refused for good from now on; how many were. */
  refuseRequests = false;
  refused = 0;
  /** The next this many requests of this device's fail for now, as unavailable. */
  failRequests = 0;

  async send(documentId: DocumentId, sender: MemberId, payload: string): Promise<DeliveryId> {
    if (this.offline) throw new TransportSendError("unavailable", `${this.device} is offline`);
    if (decodeFrame(payload).kind === "resync-request") {
      if (this.failRequests > 0) {
        this.failRequests -= 1;
        throw new TransportSendError("unavailable", "not now");
      }
      if (this.refuseRequests) {
        this.refused += 1;
        throw new TransportSendError("rejected", "refused for good");
      }
    }
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
    const sentAt = new Map(this.net.log.map((s) => [s.id, s.at]));
    const now = Date.now();
    return (await this.net.inner.receive(documentId, member)).filter(
      (d) => !this.hidden.has(d.id) && (sentAt.get(d.id) ?? 0) + this.net.latencyMs <= now,
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

async function joinAs(
  net: Net,
  member: MemberId,
  device: string = member,
  extra: DocumentEngineOptions = {},
): Promise<Device> {
  const view = net.view(member, device);
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

/** a1 creates "Plan" and lets every one of `members` write; they join and settle. */
async function group(net: Net, members: readonly MemberId[], extra: DocumentEngineOptions = {}) {
  await net.inner.createDocument(DOC, "alice");
  const view = net.view("alice", "a1");
  const a1: Device = {
    engine: await DocumentEngine.create(DOC, "alice", view, undefined, { ...BASE, ...extra }),
    view,
  };
  for (const member of members) {
    a1.engine.setMembership(member, "write").catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
  }
  a1.engine.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
  await run(5_000, [a1]);
  const devices: Device[] = [];
  for (const member of members) devices.push(await joinAs(net, member, member, extra));
  await run(2 * MINUTE, [a1, ...devices]);
  for (const d of devices) expect(d.engine.hasCompletedBootstrap).toBe(true);
  return { a1, devices };
}

const isEditOf = (device: string) => (s: Sent) => s.device === device && s.frame.kind === "edit";

/** The times, from `since` on, at which `device` sent a request, and whether each asked all. */
function requests(net: Net, device: string, since = 0): { at: number; all: boolean }[] {
  return net
    .sent(device, "resync-request", since)
    .map((s) => ({ at: s.at, all: (s.frame as ResyncRequestFrame).all }));
}

/** Polls `live` each second until `device` made `count` requests from `since` on. */
async function untilRequests(
  net: Net,
  device: string,
  since: number,
  count: number,
  live: readonly Device[],
): Promise<void> {
  for (let waited = 0; requests(net, device, since).length < count; waited += 1_000) {
    expect(waited).toBeLessThan(30 * MINUTE);
    await run(1_000, live);
  }
}

/**
 * Carol's "u1" reaches nobody, "u2", which builds on it, reaches everyone: every other device holds a
 * gap of her CRDT client (LOS-2). Carol stays, and reads nothing more until `live` says: no request
 * reaches her. When "u2" was sent.
 */
async function carolLostU1(carol: Device, everyone: readonly Device[]): Promise<number> {
  for (const d of everyone) if (d !== carol) d.view.loseNext(isEditOf("carol"));
  carol.engine.edit((fragment) => insertPlainText(fragment, 0, "u1 "));
  // Each sent once the floor allows, if there is one (SND-2), and so apart.
  await run(1_000, [carol]);
  while (carol.engine.hasPendingChanges) await run(1_000, [carol]);
  const before = net(carol).sent("carol", "edit").length;
  carol.engine.edit((fragment) => insertPlainText(fragment, 0, "u2 "));
  await vi.advanceTimersByTimeAsync(0);
  while (carol.engine.hasPendingChanges) await run(1_000, [carol]);
  const sent = net(carol).sent("carol", "edit");
  expect(sent).toHaveLength(before + 1);
  return (sent.at(-1) as Sent).at;
}

const net = (d: Device): Net => d.view.net;

/**
 * Streams for `devices` whose slots for the gap `key` lie in the order given, each at least
 * `apart` ms after the one before: the latency, and a poll, so that each hears the request of the
 * one before it in time (LOS-6, RSY-20).
 */
function streamsInOrder(
  devices: readonly MemberId[],
  key: string,
  apart: number,
): Record<MemberId, string> {
  const window = answerWindowMs(LATENCY_MS);
  const chosen: Record<MemberId, string> = {};
  let after = -apart;
  for (const device of devices) {
    for (let candidate = 1; ; candidate++) {
      const stream = `${device.charCodeAt(0).toString(16)}${candidate.toString(16)}`.padStart(
        16,
        "0",
      );
      const slot = answerDelayMs(key, stream, window);
      if (slot >= after + apart && slot < after + apart + window / devices.length - apart) {
        chosen[device] = stream;
        after = slot;
        break;
      }
      expect(candidate).toBeLessThan(10_000);
    }
  }
  return chosen;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T);
  ids.queue.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the first try of a gap several devices hold, with latency (LOS-6, RSY-20, RSY-22)", () => {
  it("four devices that read the gap at once ask one after another in their slots: the first asks all, the others hear it before their slots and let theirs go; one request, Carol's answer, and all of them take it", {
    timeout: 60_000,
  }, async () => {
    const n = new Net();
    // Carol joins first: her CRDT client names the gap, and the others' streams are chosen for it.
    const {
      a1,
      devices: [carol],
    } = await group(n, ["carol"]);
    const key = `content:${(carol as Device).engine.document.clientID}`;
    // Erin's slot first, then Bob's, Fay's and Dave's, each at least 3 s after the one before.
    const streams = streamsInOrder(["erin", "bob", "fay", "dave"], key, LATENCY_MS + 1_000);
    const others: Device[] = [];
    for (const member of ["bob", "dave", "erin", "fay"]) {
      a1.engine.setMembership(member, "write").catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      ids.queue.push(streams[member] as string);
      others.push(await joinAs(n, member));
    }
    const everyone = [a1, carol as Device, ...others];
    await run(2 * MINUTE, everyone);
    for (const d of others) expect(d.engine.hasCompletedBootstrap).toBe(true);
    a1.view.offline = true;
    n.latencyMs = LATENCY_MS;
    const live = [carol as Device, ...others];
    const t0 = Date.now();
    const sentU2 = await carolLostU1(carol as Device, everyone);
    await run(2 * MINUTE, live);
    // Every device read u2 as it arrived, at the same poll: the gap arose there for all of them.
    const since = sentU2 + LATENCY_MS;
    const asked = others.flatMap((d) => net(d).sent(d.view.device, "resync-request", t0));
    const erinsSlot = answerDelayMs(key, streams.erin as string, answerWindowMs(LATENCY_MS));
    const due = since + 2 * LATENCY_MS + erinsSlot;
    expect(
      asked.map((s) => ({ device: s.device, at: s.at, all: (s.frame as ResyncRequestFrame).all })),
    ).toStrictEqual([{ device: "erin", at: T + Math.ceil((due - T) / 1_000) * 1_000, all: true }]);
    const answers = n.log.filter((s) => s.at >= t0 && s.frame.kind === "resync-response");
    expect(answers[0]?.device).toBe("carol");
    for (const d of others) {
      expect(getPlainText(d.engine.fragment)).toContain("u2 u1 ");
      expect(d.engine.syncHealth.suspicions).toStrictEqual([]);
    }
  });
});

describe("the further tries of a gap several devices hold, after they let theirs go for one request (LOS-6, RSY-22)", () => {
  it("ten devices; Bob's lost change, Bob gone; the first to ask goes away after its request: the others' further tries come in their slots after it expired, one asks and the rest let theirs go again — three requests in all, not one per device", {
    timeout: 60_000,
  }, async () => {
    // Bob's CRDT client is fixed, so the key of his gap — and every device's slot for it — is known
    // before the devices are made: Carol's slot first, then Dave's, Erin's and the rest.
    const BOB_CLIENT = 2_718_281_828;
    const key = `content:${BOB_CLIENT}`;
    const holders = ["carol", "dave", "erin", "fay", "gina", "hank", "ivy", "jo"];
    const streams = streamsInOrder(holders, key, LATENCY_MS + 1_000);
    const n = new Net();
    const {
      a1,
      devices: [bob],
    } = await group(n, ["bob"]);
    const writer = bob as Device;
    writer.engine.document.clientID = BOB_CLIENT;
    const others: Device[] = [];
    for (const member of holders) {
      a1.engine.setMembership(member, "write").catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      ids.queue.push(streams[member] as string);
      others.push(await joinAs(n, member));
    }
    await run(2 * MINUTE, [a1, writer, ...others]);
    for (const d of others) expect(d.engine.hasCompletedBootstrap).toBe(true);
    // Nobody that holds Bob's lost change stays: a1 is away, and Bob reads nothing from now on.
    a1.view.offline = true;
    n.latencyMs = LATENCY_MS;
    const t0 = Date.now();
    for (const d of others) d.view.loseNext(isEditOf("bob"));
    writer.engine.edit((fragment) => insertPlainText(fragment, 0, "X "));
    await run(1_000, [writer]);
    writer.engine.edit((fragment) => insertPlainText(fragment, 0, "Y "));
    while (writer.engine.hasPendingChanges) await run(1_000, [writer]);
    // Carol asks first; the others let theirs go for her request. She is away from then on.
    while (requestsFrom(n, others, t0).length === 0) {
      expect(Date.now() - t0).toBeLessThan(2 * MINUTE);
      await run(1_000, others);
    }
    const [carol] = others as [Device];
    carol.view.offline = true;
    const live = others.slice(1);
    await run(15 * MINUTE, live);
    // Dave's slot is the first after hers: he asks the further tries, and the others let theirs go for
    // his. Without the slots, all seven would ask together when her request expired, and again after.
    expect(requestsFrom(n, others, t0).map(([device, , all]) => [device, all])).toStrictEqual([
      ["carol", true],
      ["dave", true],
      ["dave", true],
    ]);
    for (const d of live) {
      expect(d.engine.syncHealth.suspicions).toMatchObject([
        { key, sender: "bob", tries: MAX_GAP_TRIES, resting: true },
      ]);
    }
  });
});

/**
 * a1 and Carol, then Bob, Dave, Erin and Fay, all bootstrapped, a message taking 2 s from then on.
 * Carol's CRDT client is fixed, so the key of a gap of hers — and every device's slot for it — is
 * known before the first device is made: Erin's slot first, then a1's, Bob's, Fay's and Dave's.
 * `request` is an id for Erin's request that gives Carol the first turn, and the other members theirs
 * once her answer reached them: turns closer than a message takes may cost a second answer (RSY-20),
 * which is not what these tests are about.
 */
async function sixInPlan() {
  const CAROL_CLIENT = 3_141_592_653;
  const key = `content:${CAROL_CLIENT}`;
  const streams = streamsInOrder(["erin", "a1", "bob", "fay", "dave"], key, LATENCY_MS + 1_000);
  const CAROL = "c0c0c0c0c0c0c0c0";
  const window = answerWindowMs(LATENCY_MS);
  const turnOf = (id: string, stream: string): number => answerDelayMs(id, stream, window);
  let request = "";
  for (let candidate = 1; ; candidate++) {
    request = candidate.toString(16).padStart(16, "e");
    const carols = turnOf(request, CAROL);
    const members = ["bob", "fay", "dave"].map((m) => turnOf(request, streams[m] as string));
    if (members.every((turn) => turn >= carols + 2 * LATENCY_MS + 2_000)) break;
    expect(candidate).toBeLessThan(10_000);
  }
  ids.queue.push(streams.a1 as string, CAROL);
  const n = new Net();
  const {
    a1,
    devices: [carol],
  } = await group(n, ["carol"]);
  (carol as Device).engine.document.clientID = CAROL_CLIENT;
  const others: Device[] = [];
  for (const member of ["bob", "dave", "erin", "fay"]) {
    a1.engine.setMembership(member, "write").catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    ids.queue.push(streams[member] as string);
    others.push(await joinAs(n, member));
  }
  await run(2 * MINUTE, [a1, carol as Device, ...others]);
  for (const d of others) expect(d.engine.hasCompletedBootstrap).toBe(true);
  // a1 took the stream chosen for it.
  expect(
    (
      n.log.find((s) => s.device === "a1" && "stream" in s.frame)?.frame as
        | { stream: string }
        | undefined
    )?.stream,
  ).toBe(streams.a1);
  n.latencyMs = LATENCY_MS;
  return { n, a1, carol: carol as Device, others, key, streams, request };
}

/** The requests the devices sent from `since` on: who, which, and whether to all. */
function requestsFrom(
  n: Net,
  devices: readonly Device[],
  since: number,
): [string, string, boolean][] {
  return devices.flatMap((d) =>
    n.sent(d.view.device, "resync-request", since).map((s): [string, string, boolean] => {
      const frame = s.frame as ResyncRequestFrame;
      return [s.device, frame.requestId, frame.all];
    }),
  );
}

describe("one gap at five devices, the creator's among them (RSY-17, RSY-22, RSY-6)", () => {
  it("one request and one answer: the creator's device, which lacks what the requester lacks, lets the request go at once, and answers nothing once the writer's answer healed it", {
    timeout: 60_000,
  }, async () => {
    const { n, a1, carol, others, request } = await sixInPlan();
    const everyone = [a1, carol, ...others];
    const t0 = Date.now();
    ids.queue.push(request);
    await carolLostU1(carol, everyone);
    await run(2 * MINUTE, everyone);
    expect(ids.queue).toStrictEqual([]);
    expect(requestsFrom(n, [a1, ...others], t0)).toStrictEqual([["erin", request, true]]);
    const answers = n.log.filter((s) => s.at >= t0 && s.frame.kind === "resync-response");
    expect(answers.map((s) => s.device)).toStrictEqual(["carol"]);
    for (const d of [a1, ...others]) {
      expect(getPlainText(d.engine.fragment)).toContain("u2 u1 ");
      expect(d.engine.syncHealth.suspicions).toStrictEqual([]);
    }
  });
});

describe("the request of a resting gap a frame woke at several devices (LOS-6, LOS-26, RSY-22)", () => {
  it("four devices whose gap rests are woken by the writer's next edit: they ask one after another in their slots, the first asks all, the others hear it and let theirs go; one request, Carol's answer, and all of them take it", {
    timeout: 60_000,
  }, async () => {
    const { n, a1, carol, others, key, streams, request } = await sixInPlan();
    a1.view.offline = true;
    // Carol's u1 reaches nobody, and the requests for it never reach her: she reads nothing until she
    // writes again, and the gap rests everywhere.
    const unheard = carol.view.loseAll((s) => s.frame.kind === "resync-request");
    await carolLostU1(carol, [a1, carol, ...others]);
    await run(20 * MINUTE, others, 5_000);
    unheard();
    for (const d of others) {
      expect(d.engine.syncHealth.suspicions).toMatchObject([
        { key, sender: "carol", resting: true },
      ]);
    }
    // Her next edit raises the gap's position at every device in the same poll, and is hers.
    const t0 = Date.now();
    ids.queue.push(request);
    carol.engine.edit((fragment) => insertPlainText(fragment, 0, "u3 "));
    await vi.advanceTimersByTimeAsync(0);
    while (carol.engine.hasPendingChanges) await run(1_000, [carol]);
    const sentU3 = (n.sent("carol", "edit", t0).at(-1) as Sent).at;
    await run(2 * MINUTE, [carol, ...others]);
    expect(ids.queue).toStrictEqual([]);
    expect(requestsFrom(n, others, t0)).toStrictEqual([["erin", request, true]]);
    const erinsSlot = answerDelayMs(key, streams.erin as string, answerWindowMs(LATENCY_MS));
    const due = sentU3 + LATENCY_MS + 2 * LATENCY_MS + erinsSlot;
    expect(requests(n, "erin", t0)).toStrictEqual([
      { at: T + Math.ceil((due - T) / 1_000) * 1_000, all: true },
    ]);
    const answers = n.log.filter((s) => s.at >= t0 && s.frame.kind === "resync-response");
    expect(answers.map((s) => s.device)).toStrictEqual(["carol"]);
    for (const d of others) {
      expect(getPlainText(d.engine.fragment)).toContain("u3 u2 u1 ");
      expect(d.engine.syncHealth.suspicions).toStrictEqual([]);
    }
  });
});

/** Bob and Carol in "Plan"; Carol's u1 reached nobody, u2 did; Bob's gap of her client asks, and she reads none of it. */
async function bobsGap(extra: DocumentEngineOptions = {}) {
  const n = new Net();
  const { a1, devices } = await group(n, ["bob", "carol"], extra);
  const [bob, carol] = devices as [Device, Device];
  const since = await carolLostU1(carol, [a1, bob, carol]);
  return { n, a1, bob, carol, since };
}

describe("what counts as a try of a gap (LOS-6)", () => {
  it("requests to all refused for good count: three, then the gap rests, and none is offered again", {
    timeout: 60_000,
  }, async () => {
    const { n, bob, since } = await bobsGap();
    bob.view.refuseRequests = true;
    await run(30 * MINUTE, [bob], 5_000);
    expect(requests(n, "bob", since)).toStrictEqual([]);
    expect(bob.view.refused).toBe(MAX_GAP_TRIES);
    expect(bob.engine.syncHealth.suspicions).toMatchObject([
      { sender: "carol", tries: MAX_GAP_TRIES, resting: true },
    ]);
  });

  it("requests that failed for a reason worth retrying count for none: once sends go through, the gap still asks three times", {
    timeout: 60_000,
  }, async () => {
    const { n, bob, since } = await bobsGap();
    bob.view.failRequests = MAX_GAP_TRIES;
    await run(30 * MINUTE, [bob], 5_000);
    expect(bob.view.failRequests).toBe(0);
    expect(requests(n, "bob", since)).toHaveLength(MAX_GAP_TRIES);
    expect(bob.engine.syncHealth.suspicions).toMatchObject([
      { sender: "carol", tries: MAX_GAP_TRIES, resting: true },
    ]);
  });
});

describe("what wakes a resting gap (LOS-26)", () => {
  it("a writer who writes on every 3 s wakes it once: its request comes in its slot after the first wake, not pushed on by each later frame", {
    timeout: 60_000,
  }, async () => {
    const { n, bob, carol, since } = await bobsGap();
    await run(15 * MINUTE, [bob], 5_000);
    expect(requests(n, "bob", since)).toHaveLength(MAX_GAP_TRIES);
    expect(bob.engine.syncHealth.suspicions).toMatchObject([{ sender: "carol", resting: true }]);
    const t0 = Date.now();
    // Carol writes on, every 3 s for 2 min: each edit raises the gap's position and is hers.
    for (let i = 0; i < 40; i++) {
      carol.engine.edit((fragment) => insertPlainText(fragment, 0, "w"));
      await vi.advanceTimersByTimeAsync(0);
      await run(3_000, [bob]);
    }
    expect(requests(n, "bob", t0)).toMatchObject([{ all: true }]);
    // In its slot after the frame that woke it: its wait and a place within the answer window.
    expect((requests(n, "bob", t0)[0] as { at: number }).at - t0).toBeLessThanOrEqual(
      2 * LATENCY_MS + answerWindowMs(LATENCY_MS) + 3_000,
    );
  });

  it("the requests a return makes are its wake: a frame of its writer within 10 min after them brings no request before those 10 min passed (RSY-21)", {
    timeout: 60_000,
  }, async () => {
    const { n, bob, carol, since } = await bobsGap({ transportRetentionMs: 60 * MINUTE });
    await run(15 * MINUTE, [bob], 5_000);
    expect(requests(n, "bob", since)).toHaveLength(MAX_GAP_TRIES);
    const returned = Date.now();
    bob.engine.noteAbsence(2 * 60 * MINUTE);
    await run(3 * MINUTE, [bob]);
    const ofReturn = requests(n, "bob", returned);
    expect(ofReturn.length).toBeGreaterThan(0);
    expect(ofReturn.every((request) => request.all)).toBe(true);
    const after = Date.now();
    carol.engine.edit((fragment) => insertPlainText(fragment, 0, "u3 ")); // raises the position, and is hers
    await vi.advanceTimersByTimeAsync(0);
    await run(5 * MINUTE, [bob]);
    expect(requests(n, "bob", after)).toStrictEqual([]);
  });

  it("a frame of the writer of the gap's client read while it still has tries leaves no wake behind once it rests", {
    timeout: 60_000,
  }, async () => {
    const { n, bob, carol, since } = await bobsGap();
    await untilRequests(n, "bob", since, 1, [bob]);
    // Her next edit raises the gap's position and is hers: the gap has tries left, and asks by them.
    carol.engine.edit((fragment) => insertPlainText(fragment, 0, "u3 "));
    await vi.advanceTimersByTimeAsync(0);
    await run(20 * MINUTE, [bob], 5_000);
    expect(bob.engine.syncHealth.suspicions).toMatchObject([
      { kind: "pending-gap", sender: "carol", resting: true },
    ]);
    expect(requests(n, "bob", since)).toHaveLength(MAX_GAP_TRIES);
  });

  it("a request of the person coalesced into a try leaves no wake behind either", {
    timeout: 60_000,
  }, async () => {
    const { n, bob, since } = await bobsGap();
    await untilRequests(n, "bob", since, 1, [bob]);
    expect(await bob.engine.requestResync()).toStrictEqual({ sent: false, reason: "in-flight" });
    await run(20 * MINUTE, [bob], 5_000);
    expect(bob.engine.syncHealth.suspicions).toMatchObject([
      { kind: "pending-gap", resting: true },
    ]);
    expect(requests(n, "bob", since)).toHaveLength(MAX_GAP_TRIES);
  });

  it("after a wake by a frame, the person's request refused by the floor still makes the gap ask once the floor allows", {
    timeout: 60_000,
  }, async () => {
    const floor = { syncPolicy: { expectedLatencyMs: LATENCY_MS, minIntervalMs: 5_000 } };
    const { n, bob, carol, since } = await bobsGap(floor);
    await run(15 * MINUTE, [bob], 5_000);
    expect(requests(n, "bob", since)).toHaveLength(MAX_GAP_TRIES);
    carol.engine.edit((fragment) => insertPlainText(fragment, 0, "u3 ")); // wakes it: one request
    await vi.advanceTimersByTimeAsync(0);
    await untilRequests(n, "bob", since, MAX_GAP_TRIES + 1, [bob]);
    await run(MINUTE, [bob]); // that request had its time
    bob.engine.edit((fragment) => insertPlainText(fragment, 0, "b")); // a message of Bob's: the floor holds
    await vi.advanceTimersByTimeAsync(0);
    expect(await bob.engine.requestResync()).toStrictEqual({ sent: false, reason: "rate-floor" });
    const after = Date.now();
    await run(30_000, [bob]);
    expect(requests(n, "bob", after)).toMatchObject([{ all: true }]);
  });

  it("the start request an absence makes is the resting gap's wake: a frame of its writer within 10 min after it brings no request before those 10 min passed, and one after them", {
    timeout: 60_000,
  }, async () => {
    const { n, bob, carol, since } = await bobsGap();
    await run(15 * MINUTE, [bob], 5_000);
    expect(requests(n, "bob", since)).toHaveLength(MAX_GAP_TRIES);
    bob.engine.noteAbsence(11 * MINUTE);
    await untilRequests(n, "bob", since, MAX_GAP_TRIES + 1, [bob]); // the start request
    const start = (requests(n, "bob", since).at(-1) as { at: number }).at;
    await run(MINUTE, [bob]);
    const after = Date.now();
    carol.engine.edit((fragment) => insertPlainText(fragment, 0, "u3 ")); // raises the position, and is hers
    await vi.advanceTimersByTimeAsync(0);
    await run(5 * MINUTE, [bob]);
    expect(requests(n, "bob", after)).toStrictEqual([]);
    // The wake stands: its request comes once 10 min passed since the start request, in its slot.
    await run(5 * MINUTE, [bob]);
    const woken = requests(n, "bob", after);
    expect(woken).toMatchObject([{ all: true }]);
    expect((woken[0] as { at: number }).at - start).toBeGreaterThanOrEqual(10 * MINUTE);
  });

  it("its writer, started again under a new CRDT client, wakes it by any frame — though nothing of the gap's client moves on — and answers the one request to all", {
    timeout: 60_000,
  }, async () => {
    const n = new Net();
    const { a1, devices } = await group(n, ["bob"]);
    const [bob] = devices as [Device];
    // Carol's application keeps the control state her engine hands it.
    let saved: PersistedControlState | undefined;
    a1.engine.setMembership("carol", "write").catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    const carol = await joinAs(n, "carol", "carol", {
      onControlStateChange: (state) => (saved = state),
    });
    await run(MINUTE, [a1, bob, carol]);
    expect(carol.engine.hasCompletedBootstrap).toBe(true);
    // a1 is gone: only Carol can heal Bob. Her u1 never reaches him, u2 does; then she stops.
    a1.view.offline = true;
    bob.view.loseNext(isEditOf("carol"));
    carol.engine.edit((fragment) => insertPlainText(fragment, 0, "u1 "));
    await run(1_000, [carol]);
    carol.engine.edit((fragment) => insertPlainText(fragment, 0, "u2 "));
    await run(1_000, [carol]);
    const content = encodeUpdate(carol.engine.document);
    const oldClient = carol.engine.document.clientID;
    const stoppedAt = Date.now();
    carol.engine.dispose();
    carol.view.offline = true;
    // Bob's gap of her client asks three times, unanswered, and rests.
    const since = Date.now();
    await run(5 * MINUTE, [bob], 5_000);
    expect(requests(n, "bob", since)).toHaveLength(MAX_GAP_TRIES);
    expect(bob.engine.syncHealth.suspicions).toMatchObject([
      { key: `content:${oldClient}`, sender: "carol", resting: true },
    ]);
    // Carol starts again from what she persisted, within 10 minutes, and writes under a client of her
    // own (LOS-27). The content she sends again on starting goes missing on its way to Bob.
    const back = n.view("carol", "carol-2");
    bob.view.loseNext(isEditOf("carol-2"));
    // Bob's requests are older than her transport keeps a message: none answered on her first read.
    for (const s of n.log)
      if (s.device === "bob" && s.frame.kind === "resync-request") back.hidden.add(s.id);
    const again: Device = {
      engine: await DocumentEngine.join(DOC, "carol", back, undefined, {
        ...BASE,
        controlState: saved,
        restore: { state: content, readAt: stoppedAt },
      }),
      view: back,
    };
    expect(again.engine.document.clientID).not.toBe(oldClient);
    const woken = Date.now();
    await run(2 * MINUTE, [bob, again]);
    // Her frames name her old client where it was, so none raises the gap's position: that she sent them
    // wakes it, once, and she answers its request.
    expect(requests(n, "bob", woken)).toMatchObject([{ all: true }]);
    expect(getPlainText(bob.engine.fragment)).toContain("u2 u1 ");
    expect(bob.engine.syncHealth.suspicions).toStrictEqual([]);
  });
});
