import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import type { MemberId } from "@tdsp/messenger-port";
import { encodeUpdate, insertPlainText } from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFrame, type ResyncRequestFrame } from "./framing";
import { DocumentEngine, type DocumentEngineOptions, type PersistedControlState } from "./index";

/**
 * The requests a start and a return require (SPECIFICATION.md RSY-1, RSY-5, RSY-21, LOS-6): an engine
 * that starts again bootstrapped, within 10 minutes of its last read, makes its start request when its
 * first read shows a gap; that, a return's requests until the return ends, and a joiner's first go also
 * with the automatic requests switched off, while the repeats of a bootstrap do not. A device still
 * in its bootstrap asks as its bootstrap does, whether it is a member's or the creator's: it owes no
 * start request for an absence, and returning, it asks once — to all, when it starts — and repeats
 * nothing. A device of the creator still asks for its gaps whatever its bootstrap (RSY-5, LOS-6), as the
 * tests of its gaps show.
 */

const DOC = "doc-1";
/** 2026-10-26 10:00:00 UTC. */
const T = 1_793_008_800_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const OPTS: DocumentEngineOptions = {
  batchWindowMs: 0,
  resyncResponseThrottleMs: 0,
  creatorMemberId: "alice",
};
/** How long the transport keeps a message for a device that is away, here. */
const KEPT = 7 * 24 * HOUR;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T);
});
afterEach(() => {
  vi.useRealTimers();
});

async function run(ms: number, engines: DocumentEngine[], step = 1_000): Promise<void> {
  for (let passed = 0; passed < ms; passed += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - passed));
    for (const engine of engines) {
      await engine.sync().catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
    }
  }
}

/** The requests `sender` made, from the `after`th delivery of the channel on. */
async function requestsOf(
  port: InMemoryMessengerPort,
  sender: MemberId,
  after = 0,
): Promise<ResyncRequestFrame[]> {
  return (await port.receive(DOC, "observer"))
    .slice(after)
    .filter((delivery) => delivery.sender === sender)
    .map((delivery) => decodeFrame(delivery.payload))
    .filter((frame): frame is ResyncRequestFrame => frame.kind === "resync-request");
}

async function deliveries(port: InMemoryMessengerPort): Promise<number> {
  return (await port.receive(DOC, "observer")).length;
}

/**
 * Alice creates "Plan" and lets Bob write; Bob joins with `bobOptions`. `stopBob` ends his engine and
 * gives back what his application persisted: control state, content, the cursor of his last read and
 * when it began (CTL-26, LIF-8).
 */
async function pair(bobOptions: DocumentEngineOptions = {}) {
  const port = new InMemoryMessengerPort();
  let bobState: PersistedControlState | undefined;
  const alice = await DocumentEngine.create(DOC, "alice", port, undefined, OPTS);
  await alice.setMembership("bob", "write");
  alice.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
  const bob = await DocumentEngine.join(DOC, "bob", port, undefined, {
    ...OPTS,
    ...bobOptions,
    onControlStateChange: (state) => {
      bobState = state;
    },
  });
  await run(5_000, [alice, bob]);
  expect(bob.hasCompletedBootstrap).toBe(true);
  const stopBob = () => {
    const kept = {
      controlState: bobState as PersistedControlState,
      restore: { state: encodeUpdate(bob.document), cursor: bob.cursor, readAt: Date.now() },
    };
    bob.dispose();
    return kept;
  };
  return { port, alice, bob, stopBob };
}

describe("a start within 10 minutes whose first read shows a gap (RSY-1, LOS-25)", () => {
  for (const autoResync of [true, false]) {
    it(`makes its start request, to all, after that read${autoResync ? "" : ", also with the automatic requests switched off (LOS-6)"}`, async () => {
      const { port, alice, stopBob } = await pair();
      const kept = stopBob();
      // Alice's u1 reaches nobody; u2, which builds on it, does: the first read shows a gap.
      port.dropNextSend("alice");
      alice.edit((fragment) => insertPlainText(fragment, 0, "u1"));
      await vi.advanceTimersByTimeAsync(0);
      alice.edit((fragment) => insertPlainText(fragment, 0, "u2"));
      await vi.advanceTimersByTimeAsync(MINUTE);
      const before = await deliveries(port);
      const bob = await DocumentEngine.join(DOC, "bob", port, undefined, {
        ...OPTS,
        autoResync,
        ...kept,
      });
      expect(bob.hasCompletedBootstrap).toBe(true);
      // Before any gap of its asks by itself: that waits twice the evidence wait (LOS-6).
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await requestsOf(port, "bob", before)).map((request) => request.all)).toStrictEqual([
        true,
      ]);
    });
  }
});

describe("with the automatic requests switched off (RSY-5, RSY-21, LOS-6)", () => {
  it("a running engine told of an absence longer than its transport keeps returns: it asks all, and once more when that expires unanswered", async () => {
    const { port, bob } = await pair({ autoResync: false, transportRetentionMs: KEPT });
    const before = await deliveries(port);
    bob.noteAbsence(KEPT + HOUR);
    await run(HOUR, [bob], 5_000);
    expect((await requestsOf(port, "bob", before)).map((request) => request.all)).toStrictEqual([
      true,
      true,
    ]);
  });

  it("so does a running device of the creator that is bootstrapped: a return is asked for by bootstrap state, not by role", async () => {
    const port = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOC, "alice", port, undefined, {
      ...OPTS,
      autoResync: false,
      transportRetentionMs: KEPT,
    });
    await alice.setMembership("bob", "write");
    alice.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
    const bob = await DocumentEngine.join(DOC, "bob", port, undefined, OPTS);
    await run(5_000, [alice, bob]);
    expect(alice.hasCompletedBootstrap).toBe(true);
    expect(bob.hasCompletedBootstrap).toBe(true);
    const before = await deliveries(port);
    alice.noteAbsence(KEPT + HOUR);
    await run(HOUR, [alice, bob], 5_000);
    expect((await requestsOf(port, "alice", before)).map((request) => request.all)).toStrictEqual([
      true,
      true,
    ]);
  });

  it("a member's device that is not bootstrapped and returns asks once, to all, and does not repeat it: the repeats are its bootstrap's", async () => {
    const { port, stopBob } = await pair();
    const kept = stopBob();
    await vi.advanceTimersByTimeAsync(MINUTE);
    const before = await deliveries(port);
    // No cursor: what it restored does not bootstrap it (CTL-41); away longer than its transport keeps.
    const bob = await DocumentEngine.join(DOC, "bob", port, undefined, {
      ...OPTS,
      autoResync: false,
      transportRetentionMs: KEPT,
      controlState: kept.controlState,
      restore: { state: kept.restore.state, readAt: Date.now() - KEPT - HOUR },
    });
    await run(20 * MINUTE, [bob], 5_000);
    expect(bob.hasCompletedBootstrap).toBe(false);
    expect((await requestsOf(port, "bob", before)).map((request) => request.all)).toStrictEqual([
      true,
    ]);
  });

  // A return is asked for by bootstrap state, not by role (RSY-5, RSY-21). Nobody answers here: Alice's
  // other device is gone, and only another of hers could bootstrap this one (RSY-14).
  describe("a device of the creator that is not bootstrapped asks on a return only as its bootstrap does, as a member's device does", () => {
    async function aliceAlone() {
      const port = new InMemoryMessengerPort();
      const alice = await DocumentEngine.create(DOC, "alice", port, undefined, OPTS);
      await alice.setMembership("bob", "write");
      alice.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
      await run(20_000, [alice]);
      const state = encodeUpdate(alice.document);
      alice.dispose();
      return { port, state };
    }

    it("returning as it starts from content alone: its first request, to all, and no other", async () => {
      const { port, state } = await aliceAlone();
      await vi.advanceTimersByTimeAsync(MINUTE);
      const before = await deliveries(port);
      const second = await DocumentEngine.join(DOC, "alice", port, undefined, {
        ...OPTS,
        autoResync: false,
        transportRetentionMs: KEPT,
        restore: { state, readAt: Date.now() - KEPT - HOUR },
      });
      await run(HOUR, [second], 5_000);
      expect(second.controlStanding).toStrictEqual({ kind: "none" });
      expect((await requestsOf(port, "alice", before)).map((request) => request.all)).toStrictEqual(
        [true],
      );
    });

    it("told of a return while it runs, after its join request: nothing more", async () => {
      const { port } = await aliceAlone();
      const before = await deliveries(port);
      const second = await DocumentEngine.join(DOC, "alice", port, undefined, {
        ...OPTS,
        autoResync: false,
        transportRetentionMs: KEPT,
      });
      await run(MINUTE, [second]);
      second.noteAbsence(KEPT + HOUR);
      await run(HOUR, [second], 5_000);
      expect(second.controlStanding).toStrictEqual({ kind: "none" });
      expect((await requestsOf(port, "alice", before)).map((request) => request.all)).toStrictEqual(
        [false],
      );
    });
  });
});

describe("a device of the creator that is not bootstrapped (RSY-1, RSY-14)", () => {
  it("owes no start request for an absence: it asked as its bootstrap does, and asks nothing more", async () => {
    const port = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOC, "alice", port, undefined, OPTS);
    await alice.setMembership("bob", "write");
    alice.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
    await run(20_000, [alice]);
    alice.dispose();
    const before = await deliveries(port);
    const second = await DocumentEngine.join(DOC, "alice", port, undefined, {
      ...OPTS,
      autoResync: false,
    });
    await run(MINUTE, [second]);
    expect(second.controlStanding).toStrictEqual({ kind: "none" });
    expect(await requestsOf(port, "alice", before)).toHaveLength(1);
    second.noteAbsence(11 * MINUTE);
    await run(MINUTE, [second]);
    expect(await requestsOf(port, "alice", before)).toHaveLength(1);
  });

  it("told of an absence before its bootstrap, owes no start request once it is bootstrapped either", async () => {
    const port = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOC, "alice", port, undefined, OPTS);
    await alice.setMembership("bob", "write");
    alice.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
    await run(20_000, [alice]);
    const before = await deliveries(port);
    // The first device is away: the second asks, and nobody answers yet.
    const second = await DocumentEngine.join(DOC, "alice", port, undefined, OPTS);
    await run(MINUTE, [second]);
    expect(second.controlStanding).toStrictEqual({ kind: "none" });
    second.noteAbsence(11 * MINUTE);
    await run(MINUTE, [second]);
    // The first device is back and answers: the second is bootstrapped, and asks nothing more.
    await run(10 * MINUTE, [alice, second]);
    expect(second.hasCompletedBootstrap).toBe(true);
    const requests = await requestsOf(port, "alice", before);
    expect(requests.length).toBeGreaterThan(0);
    // Every request it made was one of its bootstrap, which states no control clock (RSY-14).
    expect(requests.map((request) => request.controlClock)).toStrictEqual(requests.map(() => null));
  });
});
