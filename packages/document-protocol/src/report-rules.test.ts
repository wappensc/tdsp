import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import {
  type Delivery,
  type DeliveryId,
  type DocumentId,
  type MemberId,
  type MessengerPort,
  type TransportProfile,
  TransportSendError,
} from "@tdsp/messenger-port";
import {
  deletePlainText,
  encodeDeletions,
  encodeStateVector,
  getPlainText,
  insertPlainText,
} from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { digestOf } from "./digest";
import { decodeFrame, encodeResyncRequestFrame, type Frame, type HeartbeatFrame } from "./framing";
import { DocumentEngine, type DocumentEngineOptions } from "./index";

/**
 * When a report is owed, and when not (SPECIFICATION.md SND-11, SND-12, SND-24): a request that states
 * exactly what a device holds, while the device's latest report states other deletions within its
 * vector, owes a report at once, which ends the asker's evidence; a request that states another
 * digest owes none. A member, a device of the creator that is not bootstrapped, and a joiner whose
 * bootstrap leaves it holding more than the answer stated owe none for what they merged; nor does the
 * whole state `resync()` sends in pieces. A return the application tells a running engine of ends the
 * back-off of a report it owes. Each device here has a view of the channel of its own, which can lose
 * what is sent on the way to it.
 */

const DOC = "doc-1";
/** 2026-10-26 10:00:00 UTC. */
const T = 1_793_008_800_000;
const MINUTE = 60_000;
/** A message takes 2 s: a gap is believed after 2 s and first asked for after 4 s; a request to all waits 40 s. */
const PACE = { syncPolicy: { expectedLatencyMs: 2_000 } };
/** What a message may carry on the bindings' transports. */
const FOUR_MIB = 4 * 1024 * 1024;

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

/**
 * One device's view of the channel: offline, refusing its next sends, or losing what matches a rule on
 * its way here; with a transport profile where one is set.
 */
class View implements MessengerPort {
  offline = false;
  profile: TransportProfile | undefined;
  /** The errors this device's next sends fail with, in order. */
  readonly failures: unknown[] = [];
  readonly #hidden = new Set<DeliveryId>();
  readonly #rules: ((s: Sent) => boolean)[] = [];

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

  /** Nothing sent so far reaches this device: a new device that sees no history. */
  hideHistory(): void {
    for (const s of this.net.log) this.#hidden.add(s.id);
  }

  async transportProfile(): Promise<TransportProfile | undefined> {
    return this.profile;
  }

  createDocument(documentId: DocumentId, creator: MemberId): Promise<void> {
    return this.net.inner.createDocument(documentId, creator);
  }

  async send(documentId: DocumentId, sender: MemberId, payload: string): Promise<DeliveryId> {
    if (this.offline) throw new TransportSendError("unavailable", `${this.device} is offline`);
    const failure = this.failures.shift();
    if (failure !== undefined) throw failure;
    const limit = this.profile?.bounds.maxBytes;
    if (limit !== undefined && limit !== null && payload.length > limit) {
      throw new TransportSendError("too-large", `${payload.length} bytes, over ${limit}`);
    }
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
    return (await this.net.inner.receive(documentId, member)).filter(
      (d) => !this.#hidden.has(d.id),
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

async function createAs(net: Net, device: string, prepare?: (view: View) => void): Promise<Device> {
  const view = net.view("alice", device);
  prepare?.(view);
  const engine = await DocumentEngine.create(DOC, "alice", view, undefined, BASE);
  return { engine, view };
}

async function joinAs(
  net: Net,
  member: MemberId,
  device: string = member,
  prepare?: (view: View) => void,
): Promise<Device> {
  const view = net.view(member, device);
  prepare?.(view);
  const engine = await DocumentEngine.join(DOC, member, view, undefined, BASE);
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
async function group(members: readonly MemberId[]) {
  const net = new Net();
  await net.inner.createDocument(DOC, "alice");
  const a1 = await createAs(net, "a1");
  for (const member of members) await decide(a1, (engine) => engine.setMembership(member, "write"));
  a1.engine.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
  await run(5_000, [a1]);
  const devices: Device[] = [];
  for (const member of members) devices.push(await joinAs(net, member));
  await run(2 * MINUTE, [a1, ...devices]);
  for (const d of devices) expect(d.engine.hasCompletedBootstrap).toBe(true);
  return { net, a1, devices };
}

/** The times, from `since` on, at which `device` sent a request. */
function requests(net: Net, device: string, since = 0): number[] {
  return net.sent(device, "resync-request", since).map((s) => s.at);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a request stating exactly what a device holds, while its latest report states other deletions within its vector (SND-24)", () => {
  /**
   * Bob's report crosses Carol's deletion: it goes before Bob read the deletion, stating what he held
   * then; a1 reads the deletion, then the report, whose state vector is a1's with another digest
   * (LOS-12). With `a1Reads` false a1 reads neither. Bob has read nothing of it yet.
   */
  async function crossing(a1Reads: boolean) {
    const { net, a1, devices } = await group(["bob", "carol"]);
    const [bob, carol] = devices as [Device, Device];
    await run(MINUTE, [a1, bob, carol]);
    bob.engine.edit((fragment) => insertPlainText(fragment, 4, "!"));
    await run(2_000, [a1, bob, carol]);
    expect(getPlainText(a1.engine.fragment)).toBe("Plan!");
    const live = a1Reads ? [a1] : [];
    carol.engine.edit((fragment) => deletePlainText(fragment, 0, 1));
    const deleted = Date.now();
    for (let waited = 0; net.sent("bob", "heartbeat", deleted).length === 0; waited += 1_000) {
      expect(waited).toBeLessThan(MINUTE);
      await run(1_000, live);
    }
    await poll(live);
    const [report] = net.sent("bob", "heartbeat", deleted);
    return { net, a1, bob, carol, report: report?.frame as HeartbeatFrame };
  }

  it("Bob reads the deletion, a1's request states what he now holds: he reports at once, which ends a1's evidence, and a1 asks once (LOS-12, LOS-17)", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, bob } = await crossing(true);
    const since = Date.now();
    await poll([bob]);
    for (let waited = 0; requests(net, "a1", since).length === 0; waited += 1_000) {
      expect(waited).toBeLessThan(2 * MINUTE);
      await run(1_000, [a1, bob]);
    }
    const [asked] = requests(net, "a1", since) as [number];
    await run(2_000, [a1, bob]);
    const again = net.sent("bob", "heartbeat", asked);
    expect(again).toHaveLength(1);
    expect((again[0] as Sent).at - asked).toBeLessThanOrEqual(2_000);
    await run(2 * MINUTE, [a1, bob]);
    expect(a1.engine.syncHealth.suspicions).toStrictEqual([]);
    expect(requests(net, "a1", since)).toHaveLength(1);
  });

  it("a request with Bob's state vector but another state digest owes no report: the one his latest report stated", {
    timeout: 60_000,
  }, async () => {
    const { net, bob, report } = await crossing(false);
    await poll([bob]);
    const own = digestOf(encodeDeletions(bob.engine.document));
    expect(report.stateDigest).not.toBe(own);
    const reports = net.sent("bob", "heartbeat").length;
    await net.inner.send(
      DOC,
      "dave",
      encodeResyncRequestFrame({
        documentId: DOC,
        requestId: "d0d0d0d0d0d0d0d0",
        controlClock: null,
        controlDigest: null,
        all: true,
        force: false,
        stateVector: encodeStateVector(bob.engine.document),
        stateDigest: report.stateDigest,
        stream: "d1d1d1d1d1d1d1d1",
        sequence: 1,
      }),
    );
    await run(5_000, [bob]);
    expect(net.sent("bob", "heartbeat")).toHaveLength(reports);
  });
});

describe("what owes no report, though it changes what the device holds (SND-11)", () => {
  it("a device of the creator that is not bootstrapped merges a member's answer: its control state changes, and it reports nothing (CTL-25, RSY-14)", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, devices } = await group(["bob"]);
    const [bob] = devices as [Device];
    a1.engine.dispose();
    a1.view.offline = true;
    await run(MINUTE, [bob]);
    const since = Date.now();
    const a2 = await joinAs(net, "alice", "a2", (view) => view.hideHistory());
    await run(3 * MINUTE, [a2, bob]);
    expect(a2.engine.controlStanding).toStrictEqual({ kind: "none" });
    expect(a2.engine.permissionOf("bob")).toBe("write"); // merged from Bob's answer
    expect(net.sent("a2", "heartbeat", since)).toStrictEqual([]);
  });

  it("a device of the creator that is not bootstrapped merges another device's control frame: its control state changes, and it reports nothing (SND-11, CTL-25)", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, devices } = await group(["bob"]);
    const [bob] = devices as [Device];
    // a1 never hears a2's requests, so only Bob answers them: a member's answer bootstraps no device of
    // the creator (RSY-14).
    for (let lost = 0; lost < 10; lost++) {
      a1.view.loseNext((s) => s.device === "a2" && s.frame.kind === "resync-request");
    }
    const a2 = await joinAs(net, "alice", "a2", (view) => view.hideHistory());
    await run(3 * MINUTE, [a1, a2, bob]);
    expect(a2.engine.controlStanding).toStrictEqual({ kind: "none" });
    const since = Date.now();
    await decide(a1, (engine) => engine.setMembership("erin", "read"));
    await run(MINUTE, [a1, a2, bob]);
    expect(a2.engine.permissionOf("erin")).toBe("read"); // merged from a1's frame
    expect(a2.engine.controlStanding).toStrictEqual({ kind: "none" });
    expect(net.sent("a2", "heartbeat", since)).toStrictEqual([]);
  });

  it("a member whose control state an answer changed reports nothing: its control state is no one's evidence (LOS-10, LOS-12)", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, devices } = await group(["bob", "carol"]);
    const [bob, carol] = devices as [Device, Device];
    await run(MINUTE, [a1, bob, carol]);
    const since = Date.now();
    // The decision and its repeat before a1's report never reach Bob: the report shows him what he lacks.
    bob.view.loseNext((s) => s.device === "a1" && s.frame.kind === "control");
    bob.view.loseNext((s) => s.device === "a1" && s.frame.kind === "control");
    await decide(a1, (engine) => engine.setMembership("erin", "read"));
    await run(2 * MINUTE, [a1, bob, carol]);
    expect(bob.engine.permissionOf("erin")).toBe("read");
    expect(net.sent("bob", "resync-request", since).length).toBeGreaterThan(0);
    expect(net.sent("bob", "heartbeat", since)).toStrictEqual([]);
  });

  it("a joiner whose bootstrap leaves it holding more than the answer stated reports nothing: only a device of the creator does (RSY-14)", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, devices } = await group(["carol"]);
    const [carol] = devices as [Device];
    await decide(a1, (engine) => engine.setMembership("bob", "write"));
    await run(30_000, [a1, carol]);
    // a1's decision on Erin never reaches Carol, and a1 is gone: Carol's answer lacks it, the channel holds it.
    carol.view.loseNext((s) => s.device === "a1" && s.frame.kind === "control");
    await decide(a1, (engine) => engine.setMembership("erin", "read"));
    await run(1_000, [a1]);
    a1.view.offline = true;
    a1.engine.dispose();
    await run(MINUTE, [carol]);
    expect(carol.engine.permissionOf("erin")).toBeUndefined();
    const since = Date.now();
    const bob = await joinAs(net, "bob");
    await run(3 * MINUTE, [bob, carol]);
    expect(bob.engine.hasCompletedBootstrap).toBe(true);
    expect(bob.engine.permissionOf("erin")).toBe("read");
    expect(net.sent("carol", "resync-response", since).length).toBeGreaterThan(0);
    expect(net.sent("bob", "heartbeat", since)).toStrictEqual([]);
  });

  it("resync()'s whole state, sent in pieces, begins no phase: no report follows it (SND-8, SND-17)", {
    timeout: 60_000,
  }, async () => {
    const net = new Net();
    await net.inner.createDocument(DOC, "alice");
    const a1 = await createAs(net, "a1", (view) => {
      view.profile = {
        bounds: { minIntervalMs: null, maxBytes: FOUR_MIB },
        pacing: {
          minIntervalMs: 0,
          maxIntervalMs: null,
          minChars: 0,
          maxChars: null,
          expectedLatencyMs: 2_000,
        },
      };
    });
    a1.engine.edit((fragment) => insertPlainText(fragment, 0, "x".repeat(FOUR_MIB + FOUR_MIB / 8)));
    await run(MINUTE, [a1]);
    // The paste went in pieces, and the report that ended its phase went (SND-17, SND-27).
    expect(net.sent("a1", "edit").length).toBeGreaterThan(2);
    expect(net.sent("a1", "heartbeat")).toHaveLength(1);
    const since = Date.now();
    await a1.engine.resync();
    expect(net.sent("a1", "edit", since).length).toBeGreaterThan(1);
    await run(MINUTE, [a1]);
    expect(net.sent("a1", "heartbeat", since)).toStrictEqual([]);
  });
});

describe("a return the application tells a running engine of (SND-12, RSY-21)", () => {
  it("noteReturn ends the back-off of the report owed: refused for half an hour, it goes at once", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, devices } = await group(["bob"]);
    const [bob] = devices as [Device];
    bob.engine.edit((fragment) => insertPlainText(fragment, 0, "b"));
    await run(1_000, [a1, bob]);
    for (let i = 0; i < 100; i++)
      bob.view.failures.push(new TransportSendError("unavailable", "offline"));
    await run(30 * MINUTE, [a1], 10_000);
    expect(bob.engine.sendStatus.reportOwed).toBe(true);
    expect(net.sent("bob", "heartbeat")).toStrictEqual([]);
    bob.view.failures.length = 0;
    const since = Date.now();
    bob.engine.noteReturn();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(net.sent("bob", "heartbeat", since)).toHaveLength(1);
  });
});
