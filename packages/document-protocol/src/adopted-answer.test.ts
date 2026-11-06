import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import {
  type Delivery,
  type DeliveryId,
  type DocumentId,
  type MemberId,
  type MessengerPort,
  TransportSendError,
} from "@tdsp/messenger-port";
import { encodeStateVector, insertPlainText } from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFrame, encodeResyncRequestFrame, type Frame } from "./framing";
import { DocumentEngine, type DocumentEngineOptions } from "./index";

/**
 * What a whole answer of a device of the creator to a request let go for ends (SPECIFICATION.md LOS-18,
 * RSY-22, RSY-12, LOS-10): a `control` frame is no evidence; a report of a bootstrapped device of the
 * creator that states the receiver's control clock with another control digest is. A device that let
 * its own request go for another's to all takes that one's answers as its own: once it applied a whole
 * one of the reporting stream, neither that report nor a later one stating the same is evidence any
 * more, though the device holds more than the answer did. Each device here has a view of the channel
 * of its own, which can lose what is sent on the way to it.
 */

const DOC = "doc-1";
/** 2026-10-26 10:00:00 UTC. */
const T = 1_793_008_800_000;
const MINUTE = 60_000;
/** A message takes 2 s: a gap is asked for after 4 s and its slot in a window of 30 s (LOS-6). */
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

  /** Every delivery matching `rule` from now on never reaches this device, until the returned function is called. */
  loseAll(rule: (s: Sent) => boolean): () => void {
    this.#rules.push(rule);
    return () => {
      const at = this.#rules.indexOf(rule);
      if (at >= 0) this.#rules.splice(at, 1);
    };
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

/** A decision of a device of the creator, not waited for. */
async function decide(d: Device, action: (engine: DocumentEngine) => Promise<void>): Promise<void> {
  action(d.engine).catch(() => {});
  await vi.advanceTimersByTimeAsync(0);
}

/** The state digest `device` last stated, in any frame: what it deleted then (LOS-12). */
function digestOf(net: Net, device: string): string {
  for (const s of [...net.log].reverse()) {
    if (
      s.device === device &&
      "stateDigest" in s.frame &&
      typeof s.frame.stateDigest === "string"
    ) {
      return s.frame.stateDigest;
    }
  }
  throw new Error(`no state digest of ${device}`);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a whole answer of a device of the creator to a request let go for another's (LOS-18, RSY-22)", () => {
  it("ends what her report showed, though the member holds more: a register the reporting device lacks leaves no request behind", {
    timeout: 60_000,
  }, async () => {
    const net = new Net();
    await net.inner.createDocument(DOC, "alice");
    const view = net.view("alice", "a1");
    const a1: Device = {
      engine: await DocumentEngine.create(DOC, "alice", view, undefined, BASE),
      view,
    };
    await a1.engine.setMembership("bob", "write");
    a1.engine.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
    await run(5_000, [a1]);
    const bob = await joinAs(net, "bob", "bob");
    await run(2 * MINUTE, [a1, bob]);
    const a2 = await joinAs(net, "alice", "a2");
    await run(MINUTE, [a1, a2, bob]);
    expect(a2.engine.controlStanding).toStrictEqual({ kind: "bootstrapped" });
    // a2 decides on Zed, which reaches Bob and never a1; then a2 is gone.
    a1.view.loseAll((s) => s.device === "a2");
    await decide(a2, (engine) => engine.setMembership("zed", "read"));
    await run(1_000, [bob]);
    a2.engine.dispose();
    a2.view.offline = true;
    await run(MINUTE, [a1, bob]);
    expect(bob.engine.permissionOf("zed")).toBe("read");
    expect(a1.engine.permissionOf("zed")).toBeUndefined();
    // a1 decides on Carol, above Zed's clock: Bob takes it, and stands at a1's control clock. a1's
    // report states that clock with another control digest — a1 lacks Zed —: evidence on Bob (LOS-10).
    const decided = Date.now();
    await decide(a1, (engine) => engine.setMembership("carol", "write"));
    for (let waited = 0; net.sent("a1", "heartbeat", decided).length === 0; waited += 1_000) {
      expect(waited).toBeLessThan(MINUTE);
      await run(1_000, [a1]);
    }
    await run(1_000, [bob]);
    expect(bob.engine.permissionOf("carol")).toBe("write");
    expect(bob.engine.controlClock).toStrictEqual(a1.engine.controlClock);
    // Dave asks all, from a device this test runs none of, stating Bob's state and no control clock: Bob
    // lets his own first try go for it (RSY-22), and a1 answers it whole, with its control state.
    const since = Date.now();
    await net.inner.send(
      DOC,
      "dave",
      encodeResyncRequestFrame({
        documentId: DOC,
        requestId: "dbdbdbdbdbdbdbdb",
        controlClock: null,
        controlDigest: null,
        all: true,
        force: false,
        stateVector: encodeStateVector(bob.engine.document),
        stateDigest: digestOf(net, "bob"),
        stream: "d1d1d1d1d1d1d1d1",
        sequence: 1,
      }),
    );
    await run(8_000, [bob]);
    // The difference a1's report showed is evidence, and the request let go counts as its first try (LOS-6).
    expect(bob.engine.syncHealth.suspicions).toMatchObject([
      { kind: "control-diverged", sender: "alice", tries: 1 },
    ]);
    expect(net.sent("bob", "resync-request", since)).toStrictEqual([]);
    await run(5 * MINUTE, [a1, bob]);
    const answers = net.sent("a1", "resync-response", since);
    expect(answers.map((s) => s.frame.kind === "resync-response" && s.frame.respondsTo)).toContain(
      "dbdbdbdbdbdbdbdb",
    );
    // Bob still holds Zed, which the answer lacks: his control digest stays another than a1's. The
    // whole answer ended the evidence all the same (LOS-18), and he asks nothing.
    expect(bob.engine.permissionOf("zed")).toBe("read");
    expect(net.sent("bob", "resync-request", since)).toStrictEqual([]);
    expect(bob.engine.syncHealth.suspicions).toStrictEqual([]);
  });
});

describe("an older answer to a request let go for another's leaves what a newer report of its stream shows (LOS-17, LOS-18, RSY-22)", () => {
  it("Alice answers Dave's request to all, open, then closes; Bob misses the close and its repeat, shows her newer report, lets his try go for Dave's request, and takes her older answer: the evidence stays, and his next try brings the close", {
    timeout: 60_000,
  }, async () => {
    const net = new Net();
    await net.inner.createDocument(DOC, "alice");
    const view = net.view("alice", "a1");
    const a1: Device = {
      engine: await DocumentEngine.create(DOC, "alice", view, undefined, BASE),
      view,
    };
    await a1.engine.setMembership("bob", "write");
    a1.engine.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
    await run(5_000, [a1]);
    const bob = await joinAs(net, "bob", "bob");
    await run(2 * MINUTE, [a1, bob]);
    // Dave asks all, from a device this test runs none of, stating Bob's state and no control clock; his
    // request and a1's answer to it, open, do not reach Bob yet.
    const dave = net.view("dave", "dave");
    const keepAnswers = bob.view.loseAll(
      (s) => s.device === "a1" && s.frame.kind === "resync-response",
    );
    const keepDave = bob.view.loseAll((s) => s.device === "dave");
    const request = encodeResyncRequestFrame({
      documentId: DOC,
      requestId: "dbdbdbdbdbdbdbdb",
      controlClock: null,
      controlDigest: null,
      all: true,
      force: false,
      stateVector: encodeStateVector(bob.engine.document),
      stateDigest: digestOf(net, "bob"),
      stream: "d1d1d1d1d1d1d1d1",
      sequence: 1,
    });
    const since = Date.now();
    await dave.send(DOC, "dave", request);
    await run(5_000, [a1]);
    const [answer] = net.sent("a1", "resync-response", since) as [Sent];
    expect(answer.frame.kind === "resync-response" && answer.frame.respondsTo).toBe(
      "dbdbdbdbdbdbdbdb",
    );
    keepAnswers();
    // a1 closes without a reason; Bob loses the close and its repeat. Her report after it, numbered above
    // the answer, states the close at the clock Bob holds.
    bob.view.loseAll((s) => s.device === "a1" && s.frame.kind === "control" && s.frame.closed);
    const closing = Date.now();
    await a1.engine.closeDocument();
    for (let waited = 0; bob.engine.syncHealth.suspicions.length === 0; waited += 1_000) {
      expect(waited).toBeLessThan(MINUTE);
      await run(1_000, [a1, bob]);
    }
    const [report] = net.sent("a1", "heartbeat", closing) as [Sent];
    expect(
      answer.frame.kind === "resync-response" &&
        report.frame.kind === "heartbeat" &&
        report.frame.sequence > answer.frame.sequence,
    ).toBe(true);
    expect(bob.engine.syncHealth.suspicions).toMatchObject([
      { kind: "control-diverged", sender: "alice", tries: 0 },
    ]);
    // Dave's request reaches Bob now, as he is about to ask: he lets his try go for it (RSY-22).
    keepDave();
    a1.view.loseAll((s) => s.device === "dave");
    await dave.send(DOC, "dave", request);
    for (let waited = 0; bob.engine.syncHealth.suspicions[0]?.tries === 0; waited += 1_000) {
      expect(waited).toBeLessThan(MINUTE);
      await run(1_000, [bob]);
    }
    expect(bob.engine.syncHealth.suspicions).toMatchObject([
      { kind: "control-diverged", tries: 1 },
    ]);
    expect(net.sent("bob", "resync-request", closing)).toStrictEqual([]);
    // a1's older answer to Dave reaches him: taken as an answer to his own, it states no close, and
    // covers nothing numbered above it.
    const shown = bob.engine.syncHealth.suspicions;
    await net.inner.send(
      DOC,
      "alice",
      (await net.inner.receive(DOC, "observer")).find((d) => d.id === answer.id)?.payload as string,
    );
    await run(1_000, [bob]);
    expect(bob.engine.closed).toBe(false);
    expect(bob.engine.syncHealth.suspicions).toStrictEqual(shown);
    // His next try, once the request he let go had its time, brings the close (LOS-6).
    await run(2 * MINUTE, [a1, bob]);
    expect(net.sent("bob", "resync-request", closing)).toHaveLength(1);
    expect(bob.engine.closed).toBe(true);
    expect(bob.engine.syncHealth.suspicions).toStrictEqual([]);
  });
});
