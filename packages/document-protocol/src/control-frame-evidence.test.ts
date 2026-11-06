import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import type {
  Delivery,
  DeliveryId,
  DocumentId,
  MemberId,
  MessengerPort,
} from "@tdsp/messenger-port";
import { insertPlainText } from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFrame, type Frame } from "./framing";
import { DocumentEngine } from "./index";

/**
 * A decision of the creator lost on the way to a member shows by what a device of the creator reports of
 * its control state after it (SPECIFICATION.md LOS-10, LOS-12, SND-11): the report states the control
 * clock and digest its device held, numbered in its stream, so a late one never stands for a newer one
 * (LOS-13, LOS-17). A `control` frame states them too, but carries no number, and its clock need not
 * grow — a close without a reason, or a frame sent again, keeps it —, so a frame is no evidence: one
 * arriving late, or before what it repeats, shows nothing. The creator's report sends her last decision
 * again (SND-27), so a decision followed by none arrives with it, and lost again, the report's control
 * clock shows it (LOS-10).
 */

const DOC = "doc-1";
/** The default pacing: no longest wait; the report goes 10 s after the last frame all the same (SND-11). */
const OPTS = { batchWindowMs: 0, resyncResponseThrottleMs: 0, creatorMemberId: "alice" };
/** 2026-10-26 10:00:00 UTC. */
const T = 1_793_008_800_000;
const MINUTE = 60_000;

type Rule = (sender: MemberId, frame: Frame) => boolean;

/** Frames held back from one member: their ids in the order sent, until `stop` ends the holding. */
interface Hold {
  readonly ids: DeliveryId[];
  stop(): void;
}

/**
 * The in-memory transport, where the next message anyone sends can be lost on its way to one member, and
 * frames can be held back from one member and reach it later, in an order of the test's.
 */
class Port implements MessengerPort {
  readonly inner = new InMemoryMessengerPort();
  readonly #hidden = new Map<MemberId, Set<DeliveryId>>();
  #loseNextFor: MemberId | undefined;
  readonly #holds: { member: MemberId; rule: Rule; left: number; ids: DeliveryId[] }[] = [];
  readonly #released = new Map<MemberId, DeliveryId[]>();

  /** The next message anyone sends never reaches `member`. */
  loseNextSendFor(member: MemberId): void {
    this.#loseNextFor = member;
  }

  /** The next `count` frames matching `rule` — every one without a count — are held back from `member`. */
  hold(member: MemberId, rule: Rule, count = Number.POSITIVE_INFINITY): Hold {
    const hold = { member, rule, left: count, ids: [] as DeliveryId[] };
    this.#holds.push(hold);
    return {
      ids: hold.ids,
      stop: () => {
        hold.left = 0;
      },
    };
  }

  /** Frames held back from `member` reach it now, after everything else it was offered, in the order given. */
  release(member: MemberId, ids: readonly DeliveryId[]): void {
    this.#released.set(member, [...(this.#released.get(member) ?? []), ...ids]);
  }

  createDocument(documentId: DocumentId, creator: MemberId): Promise<void> {
    return this.inner.createDocument(documentId, creator);
  }
  async send(documentId: DocumentId, sender: MemberId, payload: string): Promise<DeliveryId> {
    const id = await this.inner.send(documentId, sender, payload);
    if (this.#loseNextFor !== undefined) {
      const hidden = this.#hidden.get(this.#loseNextFor) ?? new Set();
      hidden.add(id);
      this.#hidden.set(this.#loseNextFor, hidden);
      this.#loseNextFor = undefined;
    }
    const frame = decodeFrame(payload);
    for (const hold of this.#holds) {
      if (hold.left > 0 && hold.rule(sender, frame)) {
        hold.ids.push(id);
        hold.left -= 1;
      }
    }
    return id;
  }
  async receive(documentId: DocumentId, member: MemberId): Promise<readonly Delivery[]> {
    const hidden = this.#hidden.get(member) ?? new Set();
    const held = new Set(
      this.#holds.filter((hold) => hold.member === member).flatMap((hold) => hold.ids),
    );
    const released = this.#released.get(member) ?? [];
    const all = await this.inner.receive(documentId, member);
    const byId = new Map(all.map((delivery) => [delivery.id, delivery]));
    return [
      ...all.filter((delivery) => !hidden.has(delivery.id) && !held.has(delivery.id)),
      ...released.flatMap((id) => byId.get(id) ?? []),
    ];
  }
  listChannels(member: MemberId) {
    return this.inner.listChannels(member);
  }
}

/** Every frame on the channel, with its sender, in the order sent. */
async function channel(port: Port): Promise<{ sender: MemberId; frame: Frame }[]> {
  return (await port.inner.receive(DOC, "observer")).map((delivery) => ({
    sender: delivery.sender,
    frame: decodeFrame(delivery.payload),
  }));
}

/** How many requests `member` sent so far. */
async function requestsOf(port: Port, member: MemberId): Promise<number> {
  return (await channel(port)).filter(
    ({ sender, frame }) => sender === member && frame.kind === "resync-request",
  ).length;
}

async function poll(...engines: DocumentEngine[]): Promise<void> {
  for (const engine of engines) {
    await engine.sync();
    await vi.advanceTimersByTimeAsync(0);
  }
}

async function run(ms: number, engines: DocumentEngine[], step = 1_000): Promise<void> {
  for (let passed = 0; passed < ms; passed += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - passed));
    await poll(...engines);
  }
}

/** Alice created the document and made Bob a writer; both hold it. */
async function aliceAndBob(port: Port): Promise<{ alice: DocumentEngine; bob: DocumentEngine }> {
  const alice = await DocumentEngine.create(DOC, "alice", port, undefined, OPTS);
  await alice.setMembership("bob", "write");
  const bob = await DocumentEngine.join(DOC, "bob", port, undefined, OPTS);
  await run(30_000, [alice, bob]);
  expect(bob.permissionOf("bob")).toBe("write");
  return { alice, bob };
}

const controlOf =
  (member: MemberId): Rule =>
  (sender, frame) =>
    sender === member && frame.kind === "control";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a decision lost on the way shows by the creator's next report (LOS-12, SND-11)", () => {
  it("under the default pacing, Bob loses the decision on Gina, the next on Hank reaches him: Hank's frame shows nothing, her report after it states another digest at his clock, he asks, and holds Gina", async () => {
    const port = new Port();
    const { alice, bob } = await aliceAndBob(port);
    port.loseNextSendFor("bob");
    await alice.setMembership("gina", "write");
    await alice.setMembership("hank", "write");
    const sentBefore = (await channel(port)).length;
    await run(5_000, [alice, bob]);
    expect(bob.permissionOf("hank")).toBe("write");
    expect(bob.controlClock).toStrictEqual(alice.controlClock);
    // Under one control clock his digest differs from hers; a frame does not show it (LOS-12).
    await run(4_000, [alice, bob]);
    expect(bob.syncHealth.suspicions).toStrictEqual([]);
    await run(2 * MINUTE, [alice, bob]);
    expect(bob.permissionOf("gina")).toBe("write");
    expect(bob.syncHealth.suspicions).toStrictEqual([]);
    // He asked once her report was there, not before.
    const after = (await channel(port)).slice(sentBefore);
    const report = after.findIndex(
      ({ sender, frame }) => sender === "alice" && frame.kind === "heartbeat",
    );
    const asked = after.findIndex(
      ({ sender, frame }) => sender === "bob" && frame.kind === "resync-request",
    );
    expect(report).toBeGreaterThanOrEqual(0);
    expect(asked).toBeGreaterThan(report);
    // Her report sent Hank's frame again, her last, not Gina's (SND-27): Bob asked for Gina.
    const decisions = (await channel(port))
      .filter(({ sender, frame }) => sender === "alice" && frame.kind === "control")
      .map(({ frame }) => (frame.kind === "control" ? Object.keys(frame.targets) : []));
    expect(decisions.filter((targets) => targets.includes("member:gina"))).toHaveLength(1);
    expect(decisions.filter((targets) => targets.includes("member:hank"))).toHaveLength(2);
  });

  it("a lost decision that is not followed by another goes again, unchanged, before the creator's report 10 s later (SND-27)", async () => {
    const port = new Port();
    const alice = await DocumentEngine.create(DOC, "alice", port, undefined, OPTS);
    await alice.setMembership("bob", "write");
    const bob = await DocumentEngine.join(DOC, "bob", port, undefined, OPTS);
    await run(20_000, [alice, bob]);
    port.loseNextSendFor("bob");
    await alice.setMembership("gina", "write");
    await run(9_000, [alice, bob]);
    expect(bob.permissionOf("gina")).toBeUndefined();
    await run(2_000, [alice, bob]);
    expect(bob.permissionOf("gina")).toBe("write");
    expect(bob.syncHealth.suspicions).toStrictEqual([]);
  });

  it("lost again on the way, the report's control clock shows it: he asks, and holds Gina (LOS-10)", async () => {
    const port = new Port();
    const alice = await DocumentEngine.create(DOC, "alice", port, undefined, OPTS);
    await alice.setMembership("bob", "write");
    const bob = await DocumentEngine.join(DOC, "bob", port, undefined, OPTS);
    await run(20_000, [alice, bob]);
    port.loseNextSendFor("bob");
    await alice.setMembership("gina", "write");
    port.loseNextSendFor("bob"); // the frame her report sends again first
    await run(11_000, [alice, bob]);
    expect(bob.permissionOf("gina")).toBeUndefined();
    await run(2 * MINUTE, [alice, bob]);
    expect(bob.permissionOf("gina")).toBe("write");
    expect(bob.syncHealth.suspicions).toStrictEqual([]);
  });
});

describe("a control frame that arrives late or out of order shows nothing (LOS-12, LIF-11, SND-27)", () => {
  it("Gina's frame is late; a whole answer brought her register, then came a close without a reason, its repeat and the report after it: Gina's frame, at the close's clock with the digest of the open state, shows nothing, and Bob asks nothing", async () => {
    const port = new Port();
    const { alice, bob } = await aliceAndBob(port);
    const gina = port.hold("bob", controlOf("alice"), 1);
    await alice.setMembership("gina", "write");
    expect(gina.ids).toHaveLength(1);
    await bob.requestResync();
    await run(1_000, [alice, bob]);
    expect(bob.permissionOf("gina")).toBe("write");
    await alice.closeDocument();
    await run(20_000, [alice, bob]);
    expect(bob.closed).toBe(true);
    expect(bob.controlState).toStrictEqual(alice.controlState);
    expect(bob.controlClock).toStrictEqual(alice.controlClock);
    expect(bob.syncHealth.suspicions).toStrictEqual([]);
    const asked = await requestsOf(port, "bob");
    port.release("bob", gina.ids);
    await run(5 * MINUTE, [alice, bob]);
    expect(bob.controlState).toStrictEqual(alice.controlState);
    expect(bob.syncHealth.suspicions).toStrictEqual([]);
    expect(await requestsOf(port, "bob")).toBe(asked);
  });

  it("a close, the close sent again to a writer who edited and its repeat before the report reach Bob in reverse, the first one last: he holds the close, and nothing is shown or asked", async () => {
    const port = new Port();
    const { alice, bob } = await aliceAndBob(port);
    const asked = await requestsOf(port, "bob");
    const held = port.hold(
      "bob",
      (sender, frame) =>
        sender === "alice" && (frame.kind === "control" || frame.kind === "heartbeat"),
    );
    const before = (await channel(port)).length;
    await alice.closeDocument();
    // Bob, who has not seen the close, writes: Alice sends it again to him (LIF-11).
    bob.edit((fragment) => insertPlainText(fragment, 0, "b"));
    await run(20_000, [alice, bob]);
    held.stop();
    const sent = (await channel(port)).slice(before).filter(({ sender }) => sender === "alice");
    expect(sent.map(({ frame }) => frame.kind)).toStrictEqual([
      "control",
      "control",
      "control",
      "heartbeat",
    ]);
    expect(held.ids).toHaveLength(4);
    expect(bob.closed).toBe(false);
    const [first, ...later] = held.ids;
    port.release("bob", later.reverse());
    await run(MINUTE, [alice, bob]);
    expect(bob.closed).toBe(true);
    port.release("bob", [first as DeliveryId]);
    await run(5 * MINUTE, [alice, bob]);
    expect(bob.controlState).toStrictEqual(alice.controlState);
    expect(bob.syncHealth.suspicions).toStrictEqual([]);
    expect(await requestsOf(port, "bob")).toBe(asked);
  });
});

describe("a control frame's control clock above the member's shows nothing by itself (LOS-10)", () => {
  it("Bob lost Gina's decision, its repeat and the report after it; Alice's close without a reason states her clock, above his, and shows nothing; her report after the close does: he asks, and holds Gina", async () => {
    const port = new Port();
    const { alice, bob } = await aliceAndBob(port);
    const lost = port.hold("bob", (sender) => sender === "alice");
    await alice.setMembership("gina", "write");
    await run(15_000, [alice, bob]);
    lost.stop();
    expect(lost.ids).toHaveLength(3); // the decision, its repeat, the report (SND-27)
    expect(bob.permissionOf("gina")).toBeUndefined();
    const sentBefore = (await channel(port)).length;
    await alice.closeDocument();
    await run(5_000, [alice, bob]);
    expect(bob.closed).toBe(true);
    expect(bob.permissionOf("gina")).toBeUndefined();
    expect(bob.controlClock).not.toStrictEqual(alice.controlClock);
    // The frame states the clock its device held, above Bob's: no evidence (LOS-10). Her report goes
    // 10 s after the close.
    await run(4_000, [alice, bob]);
    expect(bob.syncHealth.suspicions).toStrictEqual([]);
    const sent = (await channel(port)).slice(sentBefore);
    expect(
      sent.filter(({ sender, frame }) => sender === "alice" && frame.kind === "heartbeat"),
    ).toHaveLength(0);
    await run(2 * MINUTE, [alice, bob]);
    expect(bob.permissionOf("gina")).toBe("write");
    expect(bob.syncHealth.suspicions).toStrictEqual([]);
  });
});
