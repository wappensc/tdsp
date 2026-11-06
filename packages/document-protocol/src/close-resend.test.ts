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
import { CLOSE_REASON } from "./control-state";
import { type ControlFrame, decodeFrame, type Frame } from "./framing";
import { DocumentEngine, type DocumentEngineOptions, type PersistedControlState } from "./index";

/**
 * A close a member missed (SPECIFICATION.md LIF-6, LIF-11, CTL-20, RSY-14): a device of the creator
 * that holds the document closed and reads an edit of anyone else sends its close again — a `control`
 * frame under its own tag with the close and the reason it holds, its control clock and digest once it
 * is bootstrapped, no decision of its own — at most once per writer in 10 minutes and once per read,
 * and not for the edits the first read after a start brings. The member that gets it is closed then,
 * and its own engine refuses its next edit. Each device here has a view of the channel of its own,
 * which can lose what is sent on the way to it.
 */

const DOC = "doc-1";
/** 2026-10-26 10:00:00 UTC. */
const T = 1_793_008_800_000;
const MINUTE = 60_000;
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

/** The `control` frames `device` sent from `since` on. */
function controlsOf(net: Net, device: string, since: number): ControlFrame[] {
  return net.sent(device, "control", since).map((s) => s.frame as ControlFrame);
}

/**
 * What carries `device`'s close to a member: its `control` frames, its reports, which show its control
 * state (LOS-10, LOS-12), and its answers. A member that loses all of them missed the close.
 */
const carriesCloseOf = (device: string) => (s: Sent) =>
  s.device === device &&
  (s.frame.kind === "control" ||
    s.frame.kind === "heartbeat" ||
    s.frame.kind === "resync-response");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the close sent again (LIF-11)", () => {
  it("a device of the creator that holds the close sends it again with its reason when someone edits the closed document, at most once per writer in 10 minutes", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, devices } = await group(["bob", "carol"]);
    const [bob, carol] = devices as [Device, Device];
    // Neither ever gets the close, nor whatever repeats or shows it.
    for (const d of [bob, carol]) d.view.loseAll(carriesCloseOf("a1"));
    await a1.engine.closeDocument("finished");
    await run(30_000, [a1, bob, carol]);
    expect(bob.engine.closed).toBe(false);
    /** What a1 sends at once in answer to `writer`'s edit, as it reads it. */
    const answering = async (writer: Device): Promise<ControlFrame[]> => {
      writer.engine.edit((fragment) => insertPlainText(fragment, 0, "x"));
      await poll([writer]);
      const before = Date.now();
      await poll([a1]);
      return controlsOf(net, "a1", before);
    };
    const first = await answering(bob);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      closed: true,
      device: a1.engine.deviceTag,
      controlClock: a1.engine.controlClock,
      targets: { [CLOSE_REASON]: { value: "finished" } },
    });
    expect(Object.keys((first[0] as ControlFrame).targets)).toStrictEqual([CLOSE_REASON]);
    // Bob again, a minute later: nothing; Carol: hers.
    await run(MINUTE, [a1, bob, carol]);
    expect(await answering(bob)).toHaveLength(0);
    expect(await answering(carol)).toHaveLength(1);
    // Ten minutes after the first, Bob's next edit brings it again.
    await run(10 * MINUTE, [a1, bob, carol], 10_000);
    expect(await answering(bob)).toHaveLength(1);
    // Every edit sent before a writer knew of the close still applies everywhere (LIF-6).
    expect(getPlainText(a1.engine.fragment).startsWith("xxxx")).toBe(true);
  });

  it("at most once in one read: two writers whose edits one read brings get one close, which counts for both", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, devices } = await group(["bob", "carol"]);
    const [bob, carol] = devices as [Device, Device];
    for (const d of [bob, carol]) d.view.loseAll(carriesCloseOf("a1"));
    await a1.engine.closeDocument("finished");
    await run(30_000, [a1, bob, carol]);
    for (const writer of [bob, carol]) {
      writer.engine.edit((fragment) => insertPlainText(fragment, 0, "x"));
      await poll([writer]);
    }
    const before = Date.now();
    await poll([a1]);
    expect(controlsOf(net, "a1", before)).toMatchObject([
      { closed: true, targets: { [CLOSE_REASON]: { value: "finished" } } },
    ]);
    // A minute later, each of them writes again, in reads of their own: nothing, within 10 minutes.
    await run(MINUTE, [a1, bob, carol]);
    const later = Date.now();
    for (const writer of [bob, carol]) {
      writer.engine.edit((fragment) => insertPlainText(fragment, 0, "y"));
      await poll([writer]);
      await poll([a1]);
    }
    expect(controlsOf(net, "a1", later)).toStrictEqual([]);
  });

  it("none for the edits the first read after a start brings, written before the close reached their writers; one for an edit read after it", {
    timeout: 60_000,
  }, async () => {
    const net = new Net();
    await net.inner.createDocument(DOC, "alice");
    let saved: PersistedControlState | undefined;
    const a1 = await createAs(net, "a1", { onControlStateChange: (state) => (saved = state) });
    for (const member of ["bob", "carol"])
      await decide(a1, (engine) => engine.setMembership(member, "write"));
    a1.engine.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
    await run(5_000, [a1]);
    const bob = await joinAs(net, "bob");
    const carol = await joinAs(net, "carol");
    await run(MINUTE, [a1, bob, carol]);
    for (const d of [bob, carol]) d.view.loseAll(carriesCloseOf("a1"));
    await a1.engine.closeDocument("finished");
    await run(30_000, [a1, bob, carol]);
    // a1 stops; Bob and Carol, who never got the close, write on.
    const kept = {
      controlState: saved as PersistedControlState,
      restore: { state: encodeUpdate(a1.engine.document), readAt: Date.now() },
    };
    a1.engine.dispose();
    a1.view.goOffline();
    for (const writer of [bob, carol]) {
      writer.engine.edit((fragment) => insertPlainText(fragment, 0, "x"));
      await run(5_000, [writer]);
    }
    // a1 starts again within 10 minutes from what it persisted; its first read brings their edits.
    const view = net.view("alice", "a1b");
    const restarted: Device = {
      engine: await DocumentEngine.join(DOC, "alice", view, undefined, { ...BASE, ...kept }),
      view,
    };
    expect(restarted.engine.closed).toBe(true);
    expect(getPlainText(restarted.engine.fragment)).toContain("xxPlan");
    await vi.advanceTimersByTimeAsync(0);
    expect(controlsOf(net, "a1b", 0)).toStrictEqual([]);
    // Bob writes on after that: its next read sends the close again.
    bob.engine.edit((fragment) => insertPlainText(fragment, 0, "z"));
    await poll([bob]);
    await poll([restarted]);
    expect(controlsOf(net, "a1b", 0)).toMatchObject([
      { closed: true, targets: { [CLOSE_REASON]: { value: "finished" } } },
    ]);
  });

  it("a member whose close and its repeat were lost gets it from this, and its own engine refuses its next edit", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, devices } = await group(["bob"]);
    const [bob] = devices as [Device];
    const lost = bob.view.loseAll(carriesCloseOf("a1"));
    await a1.engine.closeDocument("finished");
    await run(30_000, [a1, bob]);
    expect(bob.engine.closed).toBe(false);
    lost();
    bob.engine.edit((fragment) => insertPlainText(fragment, 0, "late "));
    await run(5_000, [bob, a1, bob]);
    expect(bob.engine.closed).toBe(true);
    expect(bob.engine.closeReason).toBe("finished");
    expect(bob.engine.mayEdit).toBe(false);
    const since = Date.now();
    bob.engine.edit((fragment) => insertPlainText(fragment, 0, "refused "));
    await run(5_000, [bob, a1]);
    expect(net.sent("bob", "edit", since)).toStrictEqual([]);
    expect(getPlainText(a1.engine.fragment)).toBe("late Plan");
    expect(getPlainText(bob.engine.fragment)).toBe("refused late Plan"); // kept apart at Bob (CTL-42)
  });

  it("a device of the creator that is not bootstrapped sends it with no control clock, the reason it holds with it (RSY-14, CTL-27)", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, devices } = await group(["bob"]);
    const [bob] = devices as [Device];
    a1.view.goOffline();
    const a2 = await joinAs(net, "alice", "a2", {}, (view) => view.hideHistory());
    await run(5 * MINUTE, [a2, bob]);
    expect(a2.engine.controlStanding.kind).toBe("none");
    bob.view.loseAll(carriesCloseOf("a2"));
    await a2.engine.closeDocument("creator-state-lost");
    await run(30_000, [a2, bob]);
    bob.engine.edit((fragment) => insertPlainText(fragment, 0, "x"));
    await poll([bob]);
    const before = Date.now();
    await poll([a2]);
    expect(controlsOf(net, "a2", before)).toMatchObject([
      {
        closed: true,
        controlClock: null,
        controlDigest: null,
        targets: { [CLOSE_REASON]: { value: "creator-state-lost" } },
      },
    ]);
  });

  /**
   * a1 creates and closes the document, which Bob never gets, and stops; it starts again from what it
   * persisted, but without a tag (a state that has none), within 10 minutes, seeing nothing from
   * before. `persist` is what its application does with each control state it is handed, told how
   * many control frames the restarted device has sent by then; what it reports as failed, `errors`
   * holds.
   */
  async function restartedUntagged(
    persist: (state: PersistedControlState, controlsSent: number) => void,
  ) {
    const errors: unknown[] = [];
    const net = new Net();
    await net.inner.createDocument(DOC, "alice");
    let saved: PersistedControlState | undefined;
    const a1 = await createAs(net, "a1", { onControlStateChange: (state) => (saved = state) });
    await decide(a1, (engine) => engine.setMembership("bob", "write"));
    a1.engine.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
    await run(5_000, [a1]);
    const bob = await joinAs(net, "bob");
    await run(MINUTE, [a1, bob]);
    bob.view.loseAll(carriesCloseOf("a1"));
    await a1.engine.closeDocument("finished");
    await run(30_000, [a1, bob]);
    expect(bob.engine.closed).toBe(false);
    const { device: _device, ...untagged } = saved as PersistedControlState;
    expect(untagged.control.closed).toBe(true);
    const state = encodeUpdate(a1.engine.document);
    a1.engine.dispose();
    a1.view.goOffline();
    const view = net.view("alice", "a1b");
    view.hideHistory();
    const engine = await DocumentEngine.join(DOC, "alice", view, (error) => errors.push(error), {
      ...BASE,
      controlState: untagged,
      restore: { state, readAt: Date.now() },
      onControlStateChange: (persisted) => persist(persisted, net.sent("a1b", "control").length),
    });
    return { net, bob, restarted: { engine, view } satisfies Device, errors };
  }

  it("a device of the creator whose tag is not yet persisted persists it before its close goes again under it, and a restart goes on under that tag (CTL-20, CTL-26)", {
    timeout: 60_000,
  }, async () => {
    const reported: { readonly state: PersistedControlState; readonly controlsSent: number }[] = [];
    const { net, bob, restarted } = await restartedUntagged((state, controlsSent) =>
      reported.push({ state, controlsSent }),
    );
    const tag = restarted.engine.deviceTag as string;
    expect(reported.some(({ state }) => state.device === tag)).toBe(false);
    bob.engine.edit((fragment) => insertPlainText(fragment, 0, "x"));
    await poll([bob, restarted]);
    expect(controlsOf(net, "a1b", 0)).toMatchObject([{ closed: true, device: tag }]);
    const first = reported.find(({ state }) => state.device === tag);
    expect(first?.controlsSent).toBe(0);
    expect(first?.state.control.closed).toBe(true);
    await run(5_000, [bob, restarted]);
    expect(bob.engine.closed).toBe(true);
    restarted.engine.dispose();
    const again = await DocumentEngine.join(DOC, "alice", restarted.view, undefined, {
      ...BASE,
      controlState: reported.at(-1)?.state,
      restore: { state: encodeUpdate(restarted.engine.document), readAt: Date.now() },
    });
    expect(again.deviceTag).toBe(tag);
    again.dispose();
  });

  it("one whose application cannot persist the tag sends nothing under it", {
    timeout: 60_000,
  }, async () => {
    const { net, bob, restarted, errors } = await restartedUntagged(() => {
      throw new Error("the disk is full");
    });
    bob.engine.edit((fragment) => insertPlainText(fragment, 0, "x"));
    await run(5_000, [bob, restarted]);
    expect(net.sent("a1b", "control")).toStrictEqual([]);
    expect(errors).toMatchObject([{ message: "the disk is full" }]);
    expect(bob.engine.closed).toBe(false);
  });

  it("an open document, and an edit of the device's own, send nothing", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, devices } = await group(["bob"]);
    const [bob] = devices as [Device];
    const since = Date.now();
    bob.engine.edit((fragment) => insertPlainText(fragment, 0, "x"));
    await run(5_000, [bob, a1]);
    expect(controlsOf(net, "a1", since)).toStrictEqual([]);
  });
});
