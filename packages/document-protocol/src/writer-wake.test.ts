import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import {
  type Delivery,
  type DeliveryId,
  type DocumentId,
  type MemberId,
  type MessengerPort,
  TransportSendError,
} from "@tdsp/messenger-port";
import { insertPlainText } from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFrame, type Frame } from "./framing";
import { DocumentEngine, type DocumentEngineOptions } from "./index";

/**
 * Who wakes a resting gap of a CRDT client (SPECIFICATION.md LOS-2, LOS-26, LOS-17): a frame of the
 * member the engine names as that client's writer, an `edit` among them, also from another of that
 * member's devices, whose frames move nothing of the old client's stream — at most once in ten minutes,
 * one request to all. The writer is named from the edits of the client, or from the update a report of
 * the writer carries again where every edit of the client was lost (SND-27). The device's own frame,
 * offered again under a new delivery id, is no frame of anyone else and wakes nothing. Each device here
 * has a view of the channel of its own, which can lose what is sent on the way to it.
 */

const DOC = "doc-1";
/** 2026-10-26 10:00:00 UTC. */
const T = 1_793_008_800_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** A message takes 2 s: a gap's first request goes within a minute of it, its tries are over within the hour. */
const BASE: DocumentEngineOptions = {
  batchWindowMs: 0,
  resyncResponseThrottleMs: 0,
  creatorMemberId: "alice",
  syncPolicy: { expectedLatencyMs: 2_000 },
};

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

  /** When `device` sent a request, from `since` on. */
  requests(device: string, since = 0): number[] {
    return this.log
      .filter((s) => s.at >= since && s.device === device && s.frame.kind === "resync-request")
      .map((s) => s.at);
  }
}

/** One device's view of the channel: offline, or losing what matches a rule on its way here. */
class View implements MessengerPort {
  offline = false;
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

  /** Every delivery matching `rule` from now on never reaches this device. */
  loseAll(rule: (s: Sent) => boolean): void {
    this.#rules.push(rule);
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

async function joinAs(net: Net, member: MemberId, device: string): Promise<Device> {
  const view = net.view(member, device);
  return { engine: await DocumentEngine.join(DOC, member, view, undefined, BASE), view };
}

/** Polls every online device every `step` ms for `ms`; what one sends goes out before the next polls. */
async function run(ms: number, devices: readonly Device[], step = 1_000): Promise<void> {
  for (let passed = 0; passed < ms; passed += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - passed));
    for (const d of devices) {
      if (d.view.offline) continue;
      await d.engine.sync().catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
    }
  }
}

/** The device is gone for good: it stops, and nothing more of it is read or sent. */
function gone(d: Device): void {
  d.engine.dispose();
  d.view.offline = true;
}

/** a1 creates "Plan" and lets every one of `members` write; each joins from a device named after it; they settle. */
async function group(members: readonly MemberId[]) {
  const net = new Net();
  await net.inner.createDocument(DOC, "alice");
  const view = net.view("alice", "a1");
  const a1: Device = {
    engine: await DocumentEngine.create(DOC, "alice", view, undefined, BASE),
    view,
  };
  for (const member of members) await a1.engine.setMembership(member, "write");
  a1.engine.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
  await run(5_000, [a1]);
  const devices: Device[] = [];
  for (const member of members) devices.push(await joinAs(net, member, member));
  await run(2 * MINUTE, [a1, ...devices]);
  for (const d of devices) expect(d.engine.hasCompletedBootstrap).toBe(true);
  return { net, a1, devices };
}

const isEditOf = (device: string) => (s: Sent) => s.device === device && s.frame.kind === "edit";

/**
 * Bob holds a gap of the client of Carol's first device that nobody reachable can heal; its tries ran
 * out and it rests (LOS-6). Then carol2, another device of Carol's, edits, and of what it sends only
 * the edit reaches Bob. What Bob asks from then on.
 */
async function carol2Edits(net: Net, bob: Device, carol2: Device): Promise<number[]> {
  await run(HOUR, [bob], 10_000);
  expect(bob.engine.syncHealth.suspicions).toMatchObject([
    { kind: "pending-gap", sender: "carol", resting: true },
  ]);
  const since = Date.now();
  bob.view.loseAll((s) => s.device === "carol2" && s.frame.kind !== "edit");
  carol2.engine.edit((fragment) => insertPlainText(fragment, 0, "c2"));
  await run(30_000, [carol2]);
  expect(
    net.log.filter((s) => s.at >= since && s.device === "carol2" && s.frame.kind === "edit"),
  ).toHaveLength(1);
  // Nothing more of Carol's: the gap rests again after its one request.
  await run(9 * MINUTE, [bob], 5_000);
  return net.requests("bob", since);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a resting gap of a CRDT client is woken by a frame of its writer's member (LOS-26, LOS-2)", () => {
  it("an edit of another device of the writer's, though its other frames are lost and it moves nothing of the gap's stream: one request to all", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, devices } = await group(["bob", "carol"]);
    const [bob, carol] = devices as [Device, Device];
    const carol2 = await joinAs(net, "carol", "carol2");
    await run(MINUTE, [a1, bob, carol, carol2]);
    expect(carol2.engine.hasCompletedBootstrap).toBe(true);
    // Carol's u1 reaches nobody; u2, which builds on it, reaches Bob alone; then she is gone, and with
    // her the only device that holds u1 (RSY-17).
    for (const d of [a1, bob, carol2]) d.view.loseNext(isEditOf("carol"));
    carol.engine.edit((fragment) => insertPlainText(fragment, 0, "u1"));
    await run(1_000, [carol]);
    while (carol.engine.hasPendingChanges) await run(1_000, [carol]);
    for (const d of [a1, carol2]) d.view.loseAll((s) => s.device === "carol");
    carol.engine.edit((fragment) => insertPlainText(fragment, 0, "u2"));
    while (carol.engine.hasPendingChanges) await run(1_000, [carol]);
    gone(carol);
    const asked = await carol2Edits(net, bob, carol2);
    expect(asked).toHaveLength(1);
  });

  it("also where the writer is named only by the update her report carried again, every edit of hers lost: one request to all", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, devices } = await group(["bob", "carol"]);
    const [bob, carol] = devices as [Device, Device];
    const carol2 = await joinAs(net, "carol", "carol2");
    await run(MINUTE, [a1, bob, carol, carol2]);
    // No edit of Carol's first device reaches Bob or carol2, and a1 is away: nobody but Carol holds
    // u1. Her report after u2 carries u2 again, and Bob holds it pending: a gap of her client, its
    // writer known by the report alone (SND-27, LOS-2).
    for (const d of [bob, carol2]) d.view.loseAll(isEditOf("carol"));
    a1.view.offline = true;
    carol.engine.edit((fragment) => insertPlainText(fragment, 0, "u1"));
    await run(1_000, [carol]);
    carol.engine.edit((fragment) => insertPlainText(fragment, 0, "u2"));
    await run(20_000, [carol]);
    expect(
      net.log.some(
        (s) => s.device === "carol" && s.frame.kind === "heartbeat" && s.frame.update !== undefined,
      ),
    ).toBe(true);
    gone(carol);
    const asked = await carol2Edits(net, bob, carol2);
    expect(asked).toHaveLength(1);
  });

  it("not by a frame of the device's own offered again under a new delivery id: that is no one else's (LOS-17)", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, devices } = await group(["bob"]);
    const [bob] = devices as [Device];
    const bob2 = await joinAs(net, "bob", "bob2");
    await run(MINUTE, [a1, bob, bob2]);
    // u1 of bob2 reaches nobody, u2 reaches Bob's first device alone; bob2 is gone. Its writer is Bob.
    for (const d of [a1, bob]) d.view.loseNext(isEditOf("bob2"));
    bob2.engine.edit((fragment) => insertPlainText(fragment, 0, "u1"));
    await run(1_000, [bob2]);
    a1.view.loseAll((s) => s.device === "bob2");
    bob2.engine.edit((fragment) => insertPlainText(fragment, 0, "u2"));
    await run(1_000, [bob2]);
    gone(bob2);
    await run(HOUR, [bob], 10_000);
    expect(bob.engine.syncHealth.suspicions).toMatchObject([
      { kind: "pending-gap", resting: true },
    ]);
    // The transport offers Bob's own latest request again, under a new delivery id.
    const own = net.log
      .filter((s) => s.device === "bob" && s.frame.kind === "resync-request")
      .at(-1) as Sent;
    const payload = (await net.inner.receive(DOC, "observer")).find((d) => d.id === own.id)
      ?.payload as string;
    const since = Date.now();
    await net.inner.send(DOC, "bob", payload);
    await run(5 * MINUTE, [bob], 5_000);
    expect(net.requests("bob", since)).toStrictEqual([]);
  });
});
