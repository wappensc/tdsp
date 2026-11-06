import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import {
  type Delivery,
  type DeliveryId,
  type DocumentId,
  type MemberId,
  type MessengerPort,
  TransportSendError,
} from "@tdsp/messenger-port";
import { deletePlainText, encodeUpdate, getPlainText, insertPlainText } from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_RIGHT_TARGETS } from "./control-state";
import { decodeFrame, encodeControlFrame, type Frame } from "./framing";
import { DocumentEngine, type DocumentEngineOptions, type PersistedControlState } from "./index";

/**
 * What reports show of control state, and when (SPECIFICATION.md SND-11, LOS-10, LOS-12, LOS-13): a
 * bootstrapped device of the creator reports at once after every merge that changes its control
 * digest, so a register that keeps the greatest clock where it was shows too; and a start that owes no
 * report sends none — restored content carries no rights —, so a decision lost with its repeat and its
 * report stays unseen until that device's next report. What a report shows of a difference in digests
 * — at a state vector the receiver holds, or at its control clock — lapses once the report's stream was
 * not heard for longer than the absence threshold, 10 min (LOS-12, RSY-1): a stream heard by a frame
 * that carries its tag and a number above all heard of it, never by a copy, an `edit` or a `control`
 * frame; and it comes back only with a newer report of that stream that still shows it. Each device here
 * has a view of the channel of its own, read on from its cursor, which can lose what is sent on the way
 * to it; a frame arriving late is a copy of it the transport delivers again.
 */

const DOC = "doc-1";
/** 2026-10-26 10:00:00 UTC. */
const T = 1_793_008_800_000;
const MINUTE = 60_000;

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
  readonly hidden = new Set<DeliveryId>();
  readonly rules: ((s: Sent) => boolean)[] = [];
  #frozen: Set<DeliveryId> | undefined;

  constructor(
    readonly net: Net,
    readonly member: MemberId,
    readonly device: string,
  ) {}

  /** Every delivery matching `rule` from now on never reaches this device, until the returned function is called. */
  loseAll(rule: (s: Sent) => boolean): () => void {
    this.rules.push(rule);
    return () => {
      const at = this.rules.indexOf(rule);
      if (at >= 0) this.rules.splice(at, 1);
    };
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
    const frozen = this.#frozen;
    return (await this.net.inner.receive(documentId, member)).filter(
      (d) => !this.hidden.has(d.id) && (frozen === undefined || frozen.has(d.id)),
    );
  }

  /** What came after `after` in this view (TRN-18), so that a restarted device reads on from its cursor. */
  async receiveSince(
    documentId: DocumentId,
    member: MemberId,
    after: DeliveryId | undefined,
  ): Promise<{ readonly deliveries: readonly Delivery[]; readonly truncated: boolean }> {
    const visible = await this.receive(documentId, member);
    if (after === undefined) return { deliveries: visible, truncated: false };
    const at = visible.findIndex((delivery) => delivery.id === after);
    return at === -1
      ? { deliveries: visible, truncated: true }
      : { deliveries: visible.slice(at + 1), truncated: false };
  }

  instance(): Promise<string> {
    return this.net.inner.instance();
  }

  listChannels(member: MemberId) {
    return this.net.inner.listChannels(member);
  }
}

interface Device {
  readonly engine: DocumentEngine;
  readonly view: View;
  /** What it persisted last of its control state (CTL-26). */
  readonly saved: () => PersistedControlState;
}

const BASE: DocumentEngineOptions = {
  batchWindowMs: 0,
  resyncResponseThrottleMs: 0,
  creatorMemberId: "alice",
};

async function start(
  net: Net,
  member: MemberId,
  device: string,
  how: "create" | "join",
  extra: DocumentEngineOptions = {},
): Promise<Device> {
  const view = net.view(member, device);
  const persisted: PersistedControlState[] = [];
  const options = {
    ...BASE,
    onControlStateChange: (state: PersistedControlState) => persisted.push(state),
    ...extra,
  };
  const engine =
    how === "create"
      ? await DocumentEngine.create(DOC, member, view, undefined, options)
      : await DocumentEngine.join(DOC, member, view, undefined, options);
  return { engine, view, saved: () => persisted.at(-1) as PersistedControlState };
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

/** a1 creates "Plan" and lets Bob write; Bob joins; everyone settles. */
async function aliceAndBob(net: Net) {
  await net.inner.createDocument(DOC, "alice");
  const a1 = await start(net, "alice", "a1", "create");
  await decide(a1, (engine) => engine.setMembership("bob", "write"));
  a1.engine.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
  await run(5_000, [a1]);
  const bob = await start(net, "bob", "bob", "join");
  await run(MINUTE, [a1, bob]);
  expect(bob.engine.hasCompletedBootstrap).toBe(true);
  return { a1, bob };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a device of the creator reports at once after a merge that changes its control digest (SND-11, LOS-12)", () => {
  it("a2 decided on Gina offline, below a1's later decision on Hank; Bob holds Hank and never hears a2: a1 merges Gina's frame, keeps its control clock, reports at once, and Bob, at that clock with another digest, asks and holds Gina", async () => {
    const net = new Net();
    const { a1, bob } = await aliceAndBob(net);
    const a2 = await start(net, "alice", "a2", "join");
    await run(MINUTE, [a1, a2, bob]);
    expect(a2.engine.controlStanding.kind).toBe("bootstrapped");
    // a2 decides first, offline: its register's clock lies below the one a1 gives Hank a second later.
    a2.view.goOffline();
    await decide(a2, (engine) => engine.setMembership("gina", "write"));
    await vi.advanceTimersByTimeAsync(1_000);
    await decide(a1, (engine) => engine.setMembership("hank", "read"));
    await run(30_000, [a1, bob]);
    expect(bob.engine.permissionOf("hank")).toBe("read");
    expect(bob.engine.controlClock).toStrictEqual(a1.engine.controlClock);
    // a1's report after Hank went; what a2 sends from now on never reaches Bob.
    expect(net.sent("a1", "heartbeat").length).toBeGreaterThan(0);
    bob.view.loseAll((s) => s.device === "a2");
    const t0 = Date.now();
    a2.view.goOnline();
    // a2 sends its decision once its retry is due (SND-7).
    for (
      let waited = 0;
      a1.engine.permissionOf("gina") === undefined && waited < 2 * MINUTE;
      waited += 1_000
    ) {
      await run(1_000, [a1, a2, bob]);
    }
    expect(a1.engine.permissionOf("gina")).toBe("write");
    const merged = Date.now();
    expect(a1.engine.controlClock).toStrictEqual(bob.engine.controlClock);
    // Its digest changed, its clock did not, and nothing of its own waits: its report went at once.
    expect(net.sent("a1", "heartbeat", t0).map((s) => s.at)).toStrictEqual([merged]);
    expect(net.sent("a1", "edit", t0)).toStrictEqual([]);
    expect(net.sent("a1", "control", t0)).toStrictEqual([]);
    await run(2 * MINUTE, [a1, a2, bob]);
    expect(bob.engine.permissionOf("gina")).toBe("write");
    expect(bob.engine.controlState).toStrictEqual(a1.engine.controlState);
    expect(bob.engine.syncHealth.suspicions).toStrictEqual([]);
  });

  it("merging a frame that changes nothing — its own coming back, or a decision it holds — owes no report", async () => {
    const net = new Net();
    const { a1, bob } = await aliceAndBob(net);
    const a2 = await start(net, "alice", "a2", "join");
    await run(MINUTE, [a1, a2, bob]);
    const t0 = Date.now();
    await decide(a2, (engine) => engine.setMembership("gina", "write"));
    await run(MINUTE, [a1, a2, bob]);
    expect(a1.engine.permissionOf("gina")).toBe("write");
    // a2 reports once, after its phase; a1 merged a decision new to it and reports once, at once.
    expect(net.sent("a2", "heartbeat", t0)).toHaveLength(1);
    expect(net.sent("a1", "heartbeat", t0)).toHaveLength(1);
    // The repeat before a2's report, merged again, changed nothing at a1: no second report.
    expect(net.sent("a2", "control", t0)).toHaveLength(2);
  });

  it("also a frame of another device of the creator refused for its bounds: the close it took all the same changed the digest, and the report goes at once (CTL-32, CTL-36)", async () => {
    const net = new Net();
    const { a1, bob } = await aliceAndBob(net);
    await run(MINUTE, [a1, bob]);
    // A frame of another device of the creator that closes and makes more members readers than any
    // device holds (CTL-30): refused, the close taken (CTL-36).
    const device = "Q".repeat(22);
    const clock: [number, number] = [Date.now(), 0];
    const targets: Record<string, { value: "read"; clock: [number, number]; device: string }> = {};
    for (let n = 1; n <= MAX_RIGHT_TARGETS + 1; n++)
      targets[`member:m${n}`] = { value: "read", clock, device };
    const t0 = Date.now();
    await net.inner.send(
      DOC,
      "alice",
      encodeControlFrame({
        documentId: DOC,
        device,
        targets,
        closed: true,
        controlClock: null,
        controlDigest: null,
      }),
    );
    await run(5_000, [a1]);
    expect(a1.engine.closed).toBe(true);
    expect(a1.engine.permissionOf("m1")).toBeUndefined();
    expect(net.sent("a1", "heartbeat", t0)).toHaveLength(1);
    expect(net.sent("a1", "control", t0)).toStrictEqual([]);
  });
});

describe("a start that owes no report sends none (SND-11, SND-28, RSY-1)", () => {
  it("Bob lost Alice's decision on Gina, its repeat and the report, all accepted; Alice restarts within ten minutes and sends only her restored content: Bob does not learn of Gina, and holds no evidence; her next report brings it", async () => {
    const net = new Net();
    const { a1, bob } = await aliceAndBob(net);
    const lose = bob.view.loseAll(
      (s) => s.device === "a1" && (s.frame.kind === "control" || s.frame.kind === "heartbeat"),
    );
    await decide(a1, (engine) => engine.setMembership("gina", "read"));
    await run(15_000, [a1, bob]);
    expect(a1.engine.owedReport).toBeUndefined();
    expect(net.sent("a1", "heartbeat").length).toBeGreaterThan(0);
    expect(bob.engine.permissionOf("gina")).toBeUndefined();
    const restore = {
      state: encodeUpdate(a1.engine.document),
      cursor: a1.engine.cursor,
      instance: a1.engine.instance,
      readAt: Date.now(),
    };
    const controlState = a1.saved();
    a1.engine.dispose();
    lose();
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    const t0 = Date.now();
    const restarted = await start(net, "alice", "a1-again", "join", { controlState, restore });
    await run(5 * MINUTE, [restarted, bob]);
    expect(restarted.engine.permissionOf("gina")).toBe("read");
    // Its restored content went; no report, no request: nothing it sent states rights.
    expect(
      net.log.filter((s) => s.at >= t0 && s.sender === "alice").map((s) => s.frame.kind),
    ).toStrictEqual(["edit"]);
    expect(bob.engine.permissionOf("gina")).toBeUndefined();
    expect(bob.engine.syncHealth.suspicions).toStrictEqual([]);
    // Her next report states her control clock, above Bob's (LOS-10): he asks, and holds Gina.
    restarted.engine.edit((fragment) => insertPlainText(fragment, 0, "A "));
    await run(2 * MINUTE, [restarted, bob]);
    expect(net.sent("a1-again", "heartbeat", t0)).toHaveLength(1);
    expect(bob.engine.permissionOf("gina")).toBe("read");
    expect(bob.engine.syncHealth.suspicions).toStrictEqual([]);
  });
});

/** The transport delivers `sent` again, to everyone: a copy arriving late, under a new delivery id (TRN-8). */
async function deliverAgain(net: Net, sent: Sent): Promise<void> {
  await net.inner.send(
    DOC,
    sent.sender,
    (await net.inner.receive(DOC, "observer")).find((d) => d.id === sent.id)?.payload as string,
  );
}

/** Polls every device each second until `until` holds, for at most `ms`. */
async function runUntil(
  ms: number,
  devices: readonly Device[],
  until: () => boolean,
): Promise<void> {
  for (let waited = 0; waited < ms && !until(); waited += 1_000) await run(1_000, devices);
}

const isStreamFrame = (kind: Frame["kind"]) =>
  kind === "heartbeat" || kind === "resync-request" || kind === "resync-response";

describe("a difference in digests lapses with its stream's silence (LOS-12, RSY-1)", () => {
  it("a late report of Alice's that crossed Bob's deletion: shown while her stream was heard in the last 10 min, though her edits and decisions reach him all along; lapsed after; a copy brings nothing back, her newer report that still differs does, the gap keeping its tries", {
    timeout: 60_000,
  }, async () => {
    const net = new Net();
    const { a1, bob } = await aliceAndBob(net);
    // From now on Alice hears nothing of Bob's, and Bob none of the frames of her stream but the copies
    // the test lets through; her edits and decisions reach him.
    a1.view.loseAll((s) => s.sender === "bob");
    bob.view.loseAll((s) => s.device === "a1" && isStreamFrame(s.frame.kind));
    bob.engine.edit((fragment) => deletePlainText(fragment, 0, 1));
    a1.engine.edit((fragment) => insertPlainText(fragment, 4, " A"));
    await run(15_000, [a1, bob]);
    a1.engine.edit((fragment) => insertPlainText(fragment, 6, " B"));
    await run(15_000, [a1, bob]);
    expect(getPlainText(bob.engine.fragment)).toBe("lan A B");
    expect(getPlainText(a1.engine.fragment)).toBe("Plan A B");
    // Her two reports, each without Bob's deletion: the earlier one arrives late.
    const [earlier, later] = net.sent("a1", "heartbeat").slice(-2) as [Sent, Sent];
    expect(
      earlier.frame.kind === "heartbeat" &&
        later.frame.kind === "heartbeat" &&
        later.frame.sequence > earlier.frame.sequence,
    ).toBe(true);
    const key = `deletions:alice:${earlier.frame.kind === "heartbeat" ? earlier.frame.stream : ""}`;
    const shown = () => bob.engine.syncHealth.suspicions.filter((s) => s.key === key);
    await deliverAgain(net, earlier);
    const heard = Date.now();
    await run(MINUTE, [a1, bob]);
    expect(shown()).toMatchObject([{ kind: "diverged", sender: "alice" }]);
    // Her stream is silent to Bob; she writes and decides every minute, which carries no stream tag.
    for (let minute = 1; minute < 10; minute++) {
      if (minute === 5) await deliverAgain(net, earlier); // the same report, offered again
      a1.engine.edit((fragment) => insertPlainText(fragment, 0, "x"));
      await decide(a1, (engine) => engine.setMembership(`m${minute}`, "read"));
      await run(MINUTE, [a1, bob]);
    }
    expect(bob.engine.permissionOf("m9")).toBe("read");
    await run(heard + 10 * MINUTE - 10_000 - Date.now(), [a1, bob]);
    expect(shown()).toMatchObject([{ kind: "diverged", tries: 3, resting: true }]);
    await run(20_000, [a1, bob]);
    expect(shown()).toStrictEqual([]);
    expect(bob.engine.syncHealth.state).toBe("ok");
    const asked = net.sent("bob", "resync-request").length;
    await deliverAgain(net, earlier);
    await run(MINUTE, [a1, bob]);
    expect(shown()).toStrictEqual([]);
    await deliverAgain(net, later);
    await run(MINUTE, [a1, bob]);
    expect(shown()).toMatchObject([{ kind: "diverged", tries: 3, resting: true }]);
    // The newer report carried its stream further: one request, a wake (LOS-26), and no new tries.
    expect(net.sent("bob", "resync-request").length).toBe(asked + 1);
  });

  it("a late report of Alice's earlier stream states the open state at her control clock; she closed without a reason since and restarted: Bob, closed at that clock, and her restarted device show the difference, three requests to all go between them, and it lapses for both 10 min after the report reached them", {
    timeout: 60_000,
  }, async () => {
    const net = new Net();
    const { a1, bob } = await aliceAndBob(net);
    const lose = bob.view.loseAll((s) => s.device === "a1" && s.frame.kind === "heartbeat");
    // A decision after Bob's bootstrap, whose report states a state no whole answer brought him (LOS-18).
    await decide(a1, (engine) => engine.setMembership("gina", "read"));
    await run(15_000, [a1, bob]);
    expect(bob.engine.permissionOf("gina")).toBe("read");
    const report = net.sent("a1", "heartbeat").at(-1) as Sent;
    await a1.engine.closeDocument();
    await run(15_000, [a1, bob]);
    expect(bob.engine.closed).toBe(true);
    expect(bob.engine.controlClock).toStrictEqual(a1.engine.controlClock);
    const restore = {
      state: encodeUpdate(a1.engine.document),
      cursor: a1.engine.cursor,
      instance: a1.engine.instance,
      readAt: Date.now(),
    };
    const controlState = a1.saved();
    a1.engine.dispose();
    lose();
    const restarted = await start(net, "alice", "a1-again", "join", { controlState, restore });
    await run(MINUTE, [restarted, bob]);
    expect(bob.engine.syncHealth.suspicions).toStrictEqual([]);
    const requestsToAll = () =>
      net.log.filter((s) => s.frame.kind === "resync-request" && s.frame.all).length;
    const before = requestsToAll();
    await deliverAgain(net, report);
    const heard = Date.now();
    await run(MINUTE, [restarted, bob]);
    for (const device of [bob, restarted]) {
      expect(device.engine.syncHealth.suspicions).toMatchObject([
        {
          kind: "control-diverged",
          sender: "alice",
          key: expect.stringMatching(/^control-report:/),
        },
      ]);
    }
    await runUntil(10 * MINUTE, [restarted, bob], () => Date.now() >= heard + 10 * MINUTE - 5_000);
    // Nobody holds anything to give: the gap rests on each, and a request to all of one was the other's
    // try too (RSY-22).
    for (const device of [bob, restarted]) {
      expect(device.engine.syncHealth.suspicions).toMatchObject([
        { kind: "control-diverged", tries: 3, resting: true },
      ]);
    }
    expect(requestsToAll()).toBe(before + 3);
    await run(10_000, [restarted, bob]);
    for (const device of [bob, restarted])
      expect(device.engine.syncHealth.suspicions).toStrictEqual([]);
    await run(30 * MINUTE, [restarted, bob], 10_000);
    for (const device of [bob, restarted])
      expect(device.engine.syncHealth.suspicions).toStrictEqual([]);
    expect(requestsToAll()).toBe(before + 3);
  });
});

describe("an older answer of a stream leaves what a newer report of it shows (LOS-17, LOS-18)", () => {
  /**
   * Bob asks while he lacks Alice's decision on Gina; her answer, open, is delayed on its way to him.
   * Gina's frame reaches him late, then Alice closes without a reason: Bob loses the close and its repeat,
   * and her next report, numbered above the answer, states the close at the clock Bob holds. With
   * `late`, the answer reaches him once he shows the difference.
   */
  async function closedWhileAnAnswerWasUnderWay(late: boolean) {
    const net = new Net();
    const { a1, bob } = await aliceAndBob(net);
    const keepGina = bob.view.loseAll((s) => s.device === "a1" && s.frame.kind === "control");
    await decide(a1, (engine) => engine.setMembership("gina", "read"));
    const keepAnswer = bob.view.loseAll(
      (s) => s.device === "a1" && s.frame.kind === "resync-response",
    );
    const asked = Date.now();
    bob.engine.requestResync().catch(() => {});
    await run(2_000, [bob, a1]);
    const [answer] = net.sent("a1", "resync-response", asked) as [Sent];
    keepGina();
    keepAnswer();
    for (const s of net.sent("a1", "control", asked)) await deliverAgain(net, s);
    await run(1_000, [bob]);
    expect(bob.engine.permissionOf("gina")).toBe("read");
    bob.view.loseAll((s) => s.device === "a1" && s.frame.kind === "control" && s.frame.closed);
    const closing = Date.now();
    await a1.engine.closeDocument();
    await runUntil(MINUTE, [a1, bob], () => bob.engine.syncHealth.suspicions.length > 0);
    const [report] = net.sent("a1", "heartbeat", closing) as [Sent];
    expect(
      answer.frame.kind === "resync-response" &&
        report.frame.kind === "heartbeat" &&
        report.frame.sequence > answer.frame.sequence,
    ).toBe(true);
    expect(bob.engine.closed).toBe(false);
    const shown = bob.engine.syncHealth.suspicions;
    expect(shown).toMatchObject([{ kind: "control-diverged", sender: "alice", tries: 0 }]);
    if (late) {
      await deliverAgain(net, answer);
      await run(1_000, [bob]);
      // Applied, accepted: it states no close, and covers nothing numbered above it.
      expect(bob.engine.permissionOf("gina")).toBe("read");
      expect(bob.engine.closed).toBe(false);
      expect(bob.engine.syncHealth.suspicions).toStrictEqual(shown);
    }
    const before = Date.now();
    await run(2 * MINUTE, [a1, bob]);
    return { net, a1, bob, before, closing };
  }

  it("Bob shows Alice's report that states the close he missed, after her older answer as before it; his request for it brings the close in a newer answer, which ends it — the one request he makes either way", {
    timeout: 60_000,
  }, async () => {
    const asked = (net: Net, since: number) => net.sent("bob", "resync-request", since);
    const late = await closedWhileAnAnswerWasUnderWay(true);
    expect(late.a1.engine.closed).toBe(true);
    expect(late.bob.engine.closed).toBe(true);
    expect(late.bob.engine.syncHealth.suspicions).toStrictEqual([]);
    const without = await closedWhileAnAnswerWasUnderWay(false);
    expect(without.bob.engine.closed).toBe(true);
    // The request the evidence owes (LOS-6, LOS-12): one, whether the older answer came or not — its
    // place derives from Bob's stream, drawn at each start.
    expect(asked(late.net, late.closing)).toHaveLength(1);
    expect(asked(without.net, without.closing)).toHaveLength(1);
  });
});
