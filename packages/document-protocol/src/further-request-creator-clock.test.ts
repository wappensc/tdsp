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
 * The further request on a frame that states a control clock (SPECIFICATION.md RSY-5, RSY-14): once a
 * bootstrap's attempts ran out, a `control` frame, a report or a request of a device of the creator
 * other than the asking device that states a control clock brings one further request, whoever
 * answered the latest — such a frame comes from a bootstrapped device of the creator, the one kind of
 * device whose answer bootstraps. Each kind does so alone, the others lost on the way; and it applies on
 * every device, a device of the creator's own among them, where an answer of another device of the
 * creator that holds no control state is no answer it could be bootstrapped by. Each device here has a
 * view of the channel of its own, which can lose what is sent on the way to it.
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

/** One device's view of the channel: offline, without the history before it, or losing what matches a rule on its way here. */
class View implements MessengerPort {
  offline = false;
  readonly #hidden = new Set<DeliveryId>();
  readonly #rules: ((s: Sent) => boolean)[] = [];

  constructor(
    readonly net: Net,
    readonly member: MemberId,
    readonly device: string,
  ) {}

  /** Every delivery matching `rule` from now on never reaches this device, until the returned function is called. */
  loseAll(rule: (s: Sent) => boolean): () => void {
    this.#rules.push(rule);
    return () => {
      const at = this.#rules.indexOf(rule);
      if (at >= 0) this.#rules.splice(at, 1);
    };
  }

  /** Nothing sent so far reaches this device: a new device that sees no history. */
  hideHistory(): void {
    for (const s of this.net.log) this.#hidden.add(s.id);
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

async function joinAs(
  net: Net,
  member: MemberId,
  device: string,
  prepare?: (view: View) => void,
): Promise<Device> {
  const view = net.view(member, device);
  prepare?.(view);
  return { engine: await DocumentEngine.join(DOC, member, view, undefined, BASE), view };
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

/** How many requests `device` sent. */
const requests = (net: Net, device: string): number => net.sent(device, "resync-request").length;

/**
 * a1 creates "Plan" and lets Bob write; Bob joins. Then a1 is away and, back, hears nothing sent
 * meanwhile until `a1Hears` is called. A new device of the creator, a2, holds the content Bob gave it
 * but no control state: only a bootstrapped device of the creator can bootstrap it (CTL-27, RSY-14).
 * Bob is away too.
 */
async function a1Away() {
  const net = new Net();
  await net.inner.createDocument(DOC, "alice");
  const view = net.view("alice", "a1");
  const a1: Device = {
    engine: await DocumentEngine.create(DOC, "alice", view, undefined, BASE),
    view,
  };
  await decide(a1, (engine) => engine.setMembership("bob", "write"));
  a1.engine.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
  await run(5_000, [a1]);
  const bob = await joinAs(net, "bob", "bob");
  await run(2 * MINUTE, [a1, bob]);
  expect(bob.engine.hasCompletedBootstrap).toBe(true);
  a1.view.offline = true;
  const a1Hears = a1.view.loseAll(() => true);
  const a2 = await joinAs(net, "alice", "a2", (v) => v.hideHistory());
  await run(3 * MINUTE, [a2, bob]);
  expect(a2.engine.controlStanding.kind).toBe("none");
  bob.view.offline = true;
  /** a1 is back: what it sends reaches whoever does not lose it, and it reads on. */
  const back = (): void => {
    a1Hears();
    a1.view.offline = false;
  };
  return { net, a1, a2, back };
}

/**
 * A device of `member` joins after everything so far, and its requests run out with a2 alone there: a2
 * writes every minute, nothing of it reaching the device but a2's answers, which carry content alone and
 * so bootstrap nothing (RSY-14). a2 answered its latest request.
 */
async function ranOutWithA2(
  net: Net,
  a2: Device,
  member: MemberId,
  device: string,
): Promise<Device> {
  const joiner = await joinAs(net, member, device, (v) => v.hideHistory());
  joiner.view.loseAll((s) => s.device === "a2" && s.frame.kind !== "resync-response");
  for (let minute = 0; minute < 30 && !joiner.engine.syncHealth.attemptsRanOut; minute++) {
    a2.engine.edit((fragment) => insertPlainText(fragment, 0, "p"));
    await run(MINUTE, [a2, joiner], 5_000);
  }
  // Ten minutes more, so that the latest request had its time long before a1 is back (RSY-4).
  for (let minute = 0; minute < 10; minute++) {
    a2.engine.edit((fragment) => insertPlainText(fragment, 0, "p"));
    await run(MINUTE, [a2, joiner], 5_000);
  }
  expect(joiner.engine.syncHealth.attemptsRanOut).toBe(true);
  expect(joiner.engine.hasCompletedBootstrap).toBe(false);
  const asked = net
    .sent(device, "resync-request")
    .map((s) => s.frame.kind === "resync-request" && s.frame.requestId);
  const answered = net
    .sent("a2", "resync-response")
    .map((s) => s.frame.kind === "resync-response" && s.frame.respondsTo);
  expect(answered).toContain(asked.at(-1));
  return joiner;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a bootstrap whose attempts ran out asks once more on a frame of a device of the creator that states a control clock (RSY-5)", () => {
  /** What a1 does once back, and which of its frames reach Erin: the kind under test, nothing else of a1's but its answers. */
  const kinds: readonly [Frame["kind"], readonly Frame["kind"][], (a1: Device) => Promise<void>][] =
    [
      // Its decision goes as a `control` frame, which states its control clock (RSY-14).
      [
        "control",
        ["heartbeat", "resync-request"],
        (a1) => decide(a1, (engine) => engine.setMembership("frank", "read")),
      ],
      // The report that ends the phase of that decision states it too (SND-11).
      [
        "heartbeat",
        ["control", "resync-request"],
        (a1) => decide(a1, (engine) => engine.setMembership("frank", "read")),
      ],
      // So does a request of its person's, to all (RSY-16).
      [
        "resync-request",
        ["control", "heartbeat"],
        async (a1) => {
          await a1.engine.requestResync();
        },
      ],
    ];

  it.each(kinds)(
    "a %s frame alone, the other kinds of a1's lost on the way to the joiner: one further request, which a1 answers and so bootstraps her",
    { timeout: 60_000 },
    async (kind, lost, act) => {
      const { net, a1, a2, back } = await a1Away();
      const erin = await ranOutWithA2(net, a2, "erin", "erin");
      const ranOut = requests(net, "erin");
      back();
      erin.view.loseAll((s) => s.device === "a1" && lost.includes(s.frame.kind));
      const since = Date.now();
      await act(a1);
      await run(20 * MINUTE, [a1, a2, erin], 5_000);
      expect(net.sent("a1", kind, since).length).toBeGreaterThan(0);
      expect(requests(net, "erin") - ranOut).toBe(1);
      expect(erin.engine.hasCompletedBootstrap).toBe(true);
    },
  );

  it("on a device of the creator too, though another device of the creator answered its latest request: a3, answered by a2 with content alone, asks once more on a1's control frame and is bootstrapped", {
    timeout: 60_000,
  }, async () => {
    const { net, a1, a2, back } = await a1Away();
    // a2 and a3 share one MemberId: who answered does not tell which device did (RSY-5).
    const a3 = await ranOutWithA2(net, a2, "alice", "a3");
    expect(a3.engine.controlStanding.kind).toBe("none");
    const ranOut = requests(net, "a3");
    back();
    // a1's reports and requests never reach a3: a report stating a1's clock with another control digest
    // would be evidence of control state on a3, which a device of the creator asks for whatever its
    // bootstrap (LOS-10, RSY-5). Its `control` frame is none (LOS-10) and brings only the further request.
    a3.view.loseAll(
      (s) =>
        s.device === "a1" && (s.frame.kind === "heartbeat" || s.frame.kind === "resync-request"),
    );
    await decide(a1, (engine) => engine.setMembership("frank", "read"));
    await run(20 * MINUTE, [a1, a2, a3], 5_000);
    expect(requests(net, "a3") - ranOut).toBe(1);
    expect(a3.engine.controlStanding.kind).toBe("bootstrapped");
    expect(a3.engine.permissionOf("frank")).toBe("read");
  });
});
