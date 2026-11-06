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
import { decodeFrame, type Frame } from "./framing";
import { DocumentEngine, type DocumentEngineOptions, type PersistedControlState } from "./index";

/**
 * Who sends the close again, and what it persists (SPECIFICATION.md LIF-11, CTL-26): only a device of
 * the creator sends it again to a writer that edits the closed document; a member that holds the close
 * sends it to no one. The close sent again is no decision: it is not persisted among the frames not
 * yet known to be sent, which a restart sends again. Each device here has a view of the channel of its
 * own, which can lose what is sent on the way to it.
 */

const DOC = "doc-1";
/** 2026-10-26 10:00:00 UTC. */
const T = 1_793_008_800_000;
const MINUTE = 60_000;
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

  /** What `device` sent of `kind`, from `since` on. */
  sent(device: string, kind: Frame["kind"], since = 0): Sent[] {
    return this.log.filter((s) => s.at >= since && s.device === device && s.frame.kind === kind);
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

/** Everything of `device`'s that would bring the close: the close and its repeat, its report, its answers. */
const carriesCloseOf = (device: string) => (s: Sent) =>
  s.device === device &&
  (s.frame.kind === "control" ||
    s.frame.kind === "heartbeat" ||
    s.frame.kind === "resync-response");

/**
 * a1 creates "Plan" and lets Bob and Carol write; they join and settle. Then a1 closes the document,
 * and nothing of a1's that would bring the close reaches Carol. What a1's application persisted last.
 */
async function carolMissesTheClose() {
  const net = new Net();
  await net.inner.createDocument(DOC, "alice");
  let saved: PersistedControlState | undefined;
  const view = net.view("alice", "a1");
  const a1: Device = {
    engine: await DocumentEngine.create(DOC, "alice", view, undefined, {
      ...BASE,
      onControlStateChange: (state) => {
        saved = state;
      },
    }),
    view,
  };
  await a1.engine.setMembership("bob", "write");
  await a1.engine.setMembership("carol", "write");
  a1.engine.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
  await run(5_000, [a1]);
  const [bob, carol] = await Promise.all(
    ["bob", "carol"].map(async (member): Promise<Device> => {
      const own = net.view(member, member);
      return { engine: await DocumentEngine.join(DOC, member, own, undefined, BASE), view: own };
    }),
  );
  await run(2 * MINUTE, [a1, bob as Device, carol as Device]);
  (carol as Device).view.loseAll(carriesCloseOf("a1"));
  await a1.engine.closeDocument("finished");
  await run(MINUTE, [a1, bob as Device, carol as Device]);
  expect((bob as Device).engine.closed).toBe(true);
  expect((carol as Device).engine.closed).toBe(false);
  return { net, a1, bob: bob as Device, carol: carol as Device, saved: () => saved };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the close sent again to a writer that edits the closed document (LIF-11)", () => {
  it("a member that holds the close sends it to no one: Carol's edit reaches Bob, and Bob sends nothing of the close", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, bob, carol } = await carolMissesTheClose();
    a1.engine.dispose();
    a1.view.offline = true;
    const since = Date.now();
    carol.engine.edit((fragment) => insertPlainText(fragment, 0, "c"));
    await run(MINUTE, [bob, carol]);
    expect(getPlainText(bob.engine.fragment)).toBe("cPlan");
    expect(net.sent("bob", "control", since)).toStrictEqual([]);
  });

  it("a device of the creator sends it again, and persists it not among the frames not yet known to be sent (CTL-26)", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, bob, carol, saved } = await carolMissesTheClose();
    expect(saved()?.unsent ?? []).toStrictEqual([]);
    const since = Date.now();
    carol.engine.edit((fragment) => insertPlainText(fragment, 0, "c"));
    await run(MINUTE, [a1, bob, carol]);
    expect(net.sent("a1", "control", since)).toHaveLength(1);
    expect(saved()?.unsent ?? []).toStrictEqual([]);
  });

  it("at most once in 10 minutes, counted from the one before: Carol writes every minute, and the close goes again only once ten minutes have passed", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, bob, carol } = await carolMissesTheClose();
    const since = Date.now();
    for (let minute = 0; minute < 12; minute++) {
      carol.engine.edit((fragment) => insertPlainText(fragment, 0, "c"));
      await run(MINUTE, [a1, bob, carol], 5_000);
      // Nine minutes after the first, and every edit read: still one.
      if (minute === 8) expect(net.sent("a1", "control", since)).toHaveLength(1);
    }
    expect(carol.engine.closed).toBe(false);
    const [first, second, ...more] = net.sent("a1", "control", since).map((s) => s.at);
    expect(more).toStrictEqual([]);
    expect((second as number) - (first as number)).toBeGreaterThanOrEqual(10 * MINUTE);
    expect((second as number) - (first as number)).toBeLessThan(11 * MINUTE);
  });
});
