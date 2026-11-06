import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import {
  type Delivery,
  type DeliveryId,
  type DocumentId,
  type MemberId,
  type MessengerPort,
  TransportSendError,
} from "@tdsp/messenger-port";
import {
  deletePlainText,
  encodeDeletions,
  encodeStateVector,
  getPlainText,
  insertPlainText,
  type ReconciledDocument,
} from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clock } from "./clock";
import { digestOf } from "./digest";
import {
  decodeFrame,
  encodeResyncRequestFrame,
  encodeResyncResponseFrame,
  type Frame,
  type HeartbeatFrame,
  type ResyncRequestFrame,
} from "./framing";
import { DocumentEngine, type DocumentEngineOptions } from "./index";

/**
 * Which request of another's a device lets its own go for (SPECIFICATION.md RSY-22, LOS-6, LOS-14): one
 * to all, heard within the time its own would wait, that reaches no further on each of its gaps'
 * streams. One stating a control clock above the device's is no stand-in for a gap of control state,
 * nor one stating another state digest for a gap of deletions; a truncated history is let go for
 * none. The answer to a request let go for is counted as an answer to its own, piece by piece; and a
 * request to all that the read a device caught up with after a return brought is let go for none of
 * its own. Each device here has a view of the channel of its own, which can lose what is sent on the
 * way to it.
 */

const DOC = "doc-1";
/** 2026-10-26 10:00:00 UTC. */
const T = 1_793_008_800_000;
const MINUTE = 60_000;
/** A message takes 2 s: a gap is believed after 2 s and first asked for after 4 s; a request to all waits 40 s. */
const PACE = { syncPolicy: { expectedLatencyMs: 2_000 } };
/** The stream of Dave's device, whose frames are written here, and Erin's. */
const DAVE = "0d4a5e6f7a8b9c0d";
const ERIN = "e1e1e1e1e1e1e1e1";

interface Sent {
  readonly at: number;
  readonly id: DeliveryId;
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

/** One device's view of the channel: offline, failing its next read, or losing what matches a rule on its way here. */
class View implements MessengerPort {
  offline = false;
  failNextReceive = false;
  readonly #hidden = new Set<DeliveryId>();
  readonly #rules: ((s: Sent) => boolean)[] = [];
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
      this.#rules.splice(this.#rules.indexOf(once), 1);
      return true;
    };
    this.#rules.push(once);
  }

  /** Away: sends fail, and nothing sent from now on reaches it until it is back. */
  goOffline(): void {
    this.offline = true;
    this.#frozen = new Set(this.net.log.map((s) => s.id).filter((id) => !this.#hidden.has(id)));
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
    const sent: Sent = { at: Date.now(), id, device: this.device, frame: decodeFrame(payload) };
    this.net.log.push(sent);
    for (const view of this.net.views) {
      if (view !== this && view.#rules.some((rule) => rule(sent))) view.#hidden.add(id);
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
      (d) => !this.#hidden.has(d.id) && (frozen === undefined || frozen.has(d.id)),
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
async function group(members: readonly MemberId[]) {
  const net = new Net();
  await net.inner.createDocument(DOC, "alice");
  const view = net.view("alice", "a1");
  const a1: Device = {
    engine: await DocumentEngine.create(DOC, "alice", view, undefined, BASE),
    view,
  };
  for (const member of members) await decide(a1, (engine) => engine.setMembership(member, "write"));
  a1.engine.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
  await run(5_000, [a1]);
  const devices: Device[] = [];
  for (const member of members) {
    const own = net.view(member, member);
    devices.push({
      engine: await DocumentEngine.join(DOC, member, own, undefined, BASE),
      view: own,
    });
  }
  await run(2 * MINUTE, [a1, ...devices]);
  for (const d of devices) expect(d.engine.hasCompletedBootstrap).toBe(true);
  return { net, a1, devices };
}

const isEditOf = (device: string) => (s: Sent) => s.device === device && s.frame.kind === "edit";

/** The times, from `since` on, at which `device` sent a request, and whether each forced an answer. */
function requests(net: Net, device: string, since = 0): { at: number; force: boolean }[] {
  return net
    .sent(device, "resync-request", since)
    .map((s) => ({ at: s.at, force: (s.frame as ResyncRequestFrame).force }));
}

/**
 * Polls `live` until a gap of `d`'s had its first try: a request of its own, or one of another's it let
 * its own go for (LOS-6, RSY-22).
 */
async function untilFirstTry(d: Device, live: readonly Device[]): Promise<void> {
  for (
    let waited = 0;
    !d.engine.syncHealth.suspicions.some((gap) => gap.tries > 0);
    waited += 1_000
  ) {
    expect(waited).toBeLessThan(2 * MINUTE);
    await run(1_000, live);
  }
}

const stateOf = (document: ReconciledDocument) => ({
  stateVector: encodeStateVector(document),
  stateDigest: digestOf(encodeDeletions(document)),
});

/** Dave's request to all, stating `state` and the control clock and digest given, from a device the test runs none of. */
function requestOfDave(
  requestId: string,
  state: { readonly stateVector: Uint8Array; readonly stateDigest: string },
  control: { readonly controlClock: Clock | null; readonly controlDigest: string | null } = {
    controlClock: null,
    controlDigest: null,
  },
): string {
  return encodeResyncRequestFrame({
    documentId: DOC,
    requestId,
    ...control,
    all: true,
    force: false,
    ...state,
    stream: DAVE,
    sequence: 1,
  });
}

/** Carol's u1 reaches nobody, u2 builds on it and reaches everyone; Carol stays, unpolled: she answers nothing. */
async function carolLostU1(carol: Device, everyone: readonly Device[]): Promise<number> {
  for (const d of everyone) if (d !== carol) d.view.loseNext(isEditOf("carol"));
  carol.engine.edit((fragment) => insertPlainText(fragment, 0, "u1"));
  await run(1_000, [carol]);
  carol.engine.edit((fragment) => insertPlainText(fragment, 0, "u2"));
  await run(1_000, [carol]);
  return Date.now();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("what another's request to all must state to stand in for a request of one's own (RSY-22)", () => {
  it("one stating a control clock above the device's is no stand-in for a gap of control state: the device asks itself (LOS-10)", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, devices } = await group(["bob"]);
    const [bob] = devices as [Device];
    // a1's decision and its repeat never reach Bob; a1's report after them states its control clock.
    bob.view.loseNext((s) => s.device === "a1" && s.frame.kind === "control");
    bob.view.loseNext((s) => s.device === "a1" && s.frame.kind === "control");
    await decide(a1, (engine) => engine.setMembership("erin", "read"));
    await run(11_000, [a1]);
    const report = net.sent("a1", "heartbeat").at(-1)?.frame as HeartbeatFrame;
    expect(report.controlClock).toStrictEqual(a1.engine.controlClock);
    // Dave holds what Bob holds, and a1's control state.
    const since = Date.now();
    await net.inner.send(
      DOC,
      "dave",
      requestOfDave("dcdcdcdcdcdcdcdc", stateOf(bob.engine.document), {
        controlClock: report.controlClock,
        controlDigest: report.controlDigest,
      }),
    );
    await untilFirstTry(bob, [bob]);
    expect(requests(net, "bob", since).length).toBeGreaterThan(0);
    await run(MINUTE, [a1, bob]);
    expect(bob.engine.permissionOf("erin")).toBe("read");
  });

  it("one stating another state digest, at the device's state vector, is no stand-in for a gap of deletions (LOS-12)", {
    timeout: 60_000,
  }, async () => {
    const { net, devices } = await group(["bob", "carol"]);
    const [bob, carol] = devices as [Device, Device];
    // Carol's deletion never reaches Bob; her next edit does, and her report: Bob holds every insertion
    // she holds, and other deletions.
    bob.view.loseNext(isEditOf("carol"));
    carol.engine.edit((fragment) => deletePlainText(fragment, 0, 1));
    await run(1_000, [carol]);
    carol.engine.edit((fragment) => insertPlainText(fragment, 0, "e"));
    await run(11_000, [carol]);
    const report = net.sent("carol", "heartbeat").at(-1)?.frame as HeartbeatFrame;
    expect(report.kind).toBe("heartbeat");
    await poll([bob]);
    expect(encodeStateVector(bob.engine.document)).toStrictEqual(report.stateVector);
    // Dave holds what Carol holds: answers to his request bring nobody her deletion.
    const since = Date.now();
    await net.inner.send(
      DOC,
      "dave",
      requestOfDave("dededededededede", {
        stateVector: report.stateVector,
        stateDigest: report.stateDigest,
      }),
    );
    await untilFirstTry(bob, [bob]);
    expect(requests(net, "bob", since).length).toBeGreaterThan(0);
  });

  it("a truncated history is let go for no request: the device asks at once, forcing an answer (LOS-19)", {
    timeout: 60_000,
  }, async () => {
    const { net, devices } = await group(["bob"]);
    const [bob] = devices as [Device];
    await net.inner.send(
      DOC,
      "dave",
      requestOfDave("dddddddddddddddd", stateOf(bob.engine.document)),
    );
    const since = Date.now();
    bob.view.failNextReceive = true;
    await poll([bob]);
    await poll([bob]); // the first read after a failure: a truncated history (LOS-8)
    await untilFirstTry(bob, [bob]);
    expect(requests(net, "bob", since)[0]?.force).toBe(true);
  });
});

describe("the answer to a request let go for another's (RSY-22, RSY-12)", () => {
  it("is counted as an answer to one's own, piece by piece: a first piece whose others do not come shows as an incomplete answer (LOS-14)", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, devices } = await group(["bob", "carol"]);
    const [bob, carol] = devices as [Device, Device];
    const since = await carolLostU1(carol, [a1, bob, carol]);
    // Dave holds what Bob holds: Bob lets his request for Carol's stream go for Dave's.
    await net.inner.send(
      DOC,
      "dave",
      requestOfDave("dadadadadadadada", stateOf(bob.engine.document)),
    );
    await untilFirstTry(bob, [bob]);
    expect(requests(net, "bob", since)).toStrictEqual([]);
    await net.inner.send(
      DOC,
      "erin",
      encodeResyncResponseFrame({
        documentId: DOC,
        respondsTo: "dadadadadadadada",
        update: new Uint8Array([0, 0]),
        stream: ERIN,
        sequence: 1,
        piece: 1,
      }),
    );
    await poll([bob]);
    expect(bob.engine.syncHealth.incompleteAnswers).toMatchObject([{ sender: "erin" }]);
  });
});

describe("a request to all read as a device catches up after a return (RSY-22, RSY-21)", () => {
  it("a running device told of a return by noteReturn lets no try of its own go for a request to all that read brought", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, devices } = await group(["bob", "carol", "dave"]);
    const [bob, carol, dave] = devices as [Device, Device, Device];
    // Bob is away; Dave asks all, and is gone; 40 minutes pass, and its answers came and went.
    bob.view.goOffline();
    await dave.engine.requestResync();
    await run(5_000, [dave, a1, carol]);
    dave.engine.dispose();
    dave.view.goOffline();
    await run(40 * MINUTE, [a1, carol], 60_000);
    // A decision of a1's never reaches Bob: a1 answers his return's request at once with it.
    bob.view.loseNext((s) => s.device === "a1" && s.frame.kind === "control");
    await decide(a1, (engine) => engine.setMembership("erin", "read"));
    await run(2_000, [a1, carol]);
    bob.view.goOnline();
    await poll([bob]); // the read that catches up brings Dave's request again
    bob.engine.noteReturn();
    await run(2_000, [bob, a1, carol]);
    expect(bob.engine.permissionOf("erin")).toBe("read");
    // Carol's u1 never reaches Bob, u2 does: a gap on whose stream Dave's request reaches no further.
    bob.view.loseNext(isEditOf("carol"));
    carol.engine.edit((fragment) => insertPlainText(fragment, 0, "u1 "));
    await run(1_000, [carol]);
    carol.engine.edit((fragment) => insertPlainText(fragment, 0, "u2 "));
    await vi.advanceTimersByTimeAsync(0);
    const since = Date.now();
    await poll([bob]);
    await untilFirstTry(bob, [bob, a1, carol]);
    expect(requests(net, "bob", since).length).toBeGreaterThan(0);
    await run(2 * MINUTE, [bob, a1, carol]);
    expect(getPlainText(bob.engine.fragment)).toContain("u2 u1 ");
  });
});
