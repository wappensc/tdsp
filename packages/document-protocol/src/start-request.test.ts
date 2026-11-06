import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import type { MemberId } from "@tdsp/messenger-port";
import { encodeUpdate, getPlainText, insertPlainText } from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFrame, type ResyncRequestFrame } from "./framing";
import { DocumentEngine, type DocumentEngineOptions, type PersistedControlState } from "./index";
import { profileFor, YJS_PARAGRAPHS_1 } from "./profile";

/**
 * The request a start makes (SPECIFICATION.md RSY-1, RSY-21, LIF-8, LIF-12, LOS-27): an engine that
 * starts again from what its application persisted reads first; not bootstrapped, it asks as a joiner;
 * bootstrapped, it makes one start request, to all, only after more than 10 minutes away — or not
 * knowing how long, or holding a gap — and none otherwise, and never repeats it. A running engine told
 * of an absence does the same, and of one longer than its transport keeps, returns. Each start writes
 * under a CRDT client id of its own.
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

/** Each engine's poll, in order; then whatever they sent goes out. */
async function poll(...engines: DocumentEngine[]): Promise<void> {
  for (const engine of engines) {
    await engine.sync().catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
  }
}

async function run(ms: number, engines: DocumentEngine[], step = 1_000): Promise<void> {
  for (let passed = 0; passed < ms; passed += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - passed));
    await poll(...engines);
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
 * Alice creates "Plan" and lets Bob write; Bob joins. What each persisted as it stops: control state,
 * content, the cursor of its last read and when that read began (CTL-26, LIF-8).
 */
async function pair() {
  const port = new InMemoryMessengerPort();
  let aliceState: PersistedControlState | undefined;
  let bobState: PersistedControlState | undefined;
  const alice = await DocumentEngine.create(DOC, "alice", port, undefined, {
    ...OPTS,
    onControlStateChange: (state) => {
      aliceState = state;
    },
  });
  await alice.setMembership("bob", "write");
  alice.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
  const bob = await DocumentEngine.join(DOC, "bob", port, undefined, {
    ...OPTS,
    onControlStateChange: (state) => {
      bobState = state;
    },
  });
  await run(5_000, [alice, bob]);
  expect(bob.hasCompletedBootstrap).toBe(true);
  const stop = (engine: DocumentEngine, state: () => PersistedControlState | undefined) => {
    const readAt = Date.now();
    const kept = {
      controlState: state() as PersistedControlState,
      restore: { state: encodeUpdate(engine.document), cursor: engine.cursor, readAt },
    };
    engine.dispose();
    return kept;
  };
  return {
    port,
    alice,
    bob,
    stopAlice: () => stop(alice, () => aliceState),
    stopBob: () => stop(bob, () => bobState),
  };
}

describe("a start from persisted state (RSY-1, CTL-41)", () => {
  it("a restart within 10 minutes, bootstrapped by what it restored, sends no request", async () => {
    const { port, alice, stopBob } = await pair();
    const kept = stopBob();
    await run(9 * MINUTE, [alice]);
    const before = await deliveries(port);
    const bob = await DocumentEngine.join(DOC, "bob", port, undefined, { ...OPTS, ...kept });
    expect(bob.hasCompletedBootstrap).toBe(true); // its first read went on from its cursor (CTL-41)
    await run(30 * MINUTE, [alice, bob], 10_000);
    expect(await requestsOf(port, "bob", before)).toStrictEqual([]);
  });

  it("a device of the creator within 10 minutes sends none either", async () => {
    const { port, bob, stopAlice } = await pair();
    const kept = stopAlice();
    await run(MINUTE, [bob]);
    const before = await deliveries(port);
    const alice = await DocumentEngine.join(DOC, "alice", port, undefined, { ...OPTS, ...kept });
    await run(30 * MINUTE, [alice, bob], 10_000);
    expect(await requestsOf(port, "alice", before)).toStrictEqual([]);
  });

  it("after more than 10 minutes away, one start request, to all, stating what it holds; unanswered, nothing more", async () => {
    const { port, alice, stopBob } = await pair();
    const kept = stopBob();
    await run(11 * MINUTE, [alice], 10_000);
    const before = await deliveries(port);
    const bob = await DocumentEngine.join(DOC, "bob", port, undefined, { ...OPTS, ...kept });
    const [request] = await requestsOf(port, "bob", before);
    expect(request).toMatchObject({ all: true, controlClock: bob.controlClock });
    expect((request as ResyncRequestFrame).stateVector).toStrictEqual(
      profileFor(YJS_PARAGRAPHS_1).encodeStateVector(bob.document),
    );
    await run(HOUR, [alice, bob], 10_000);
    expect(await requestsOf(port, "bob", before)).toHaveLength(1);
  });

  it("not knowing when its last read began, one start request, to all", async () => {
    const { port, alice, stopBob } = await pair();
    const { controlState, restore } = stopBob();
    const before = await deliveries(port);
    const bob = await DocumentEngine.join(DOC, "bob", port, undefined, {
      ...OPTS,
      controlState,
      restore: { state: restore.state, cursor: restore.cursor },
    });
    await run(HOUR, [alice, bob], 10_000);
    expect((await requestsOf(port, "bob", before)).map((request) => request.all)).toStrictEqual([
      true,
    ]);
  });

  it("with its automatic requests switched off, after more than 10 minutes away it still makes its start request, and one for an absence it is told of: they are required, not among the automatic ones (RSY-1, LOS-6)", async () => {
    const { port, alice, stopBob } = await pair();
    const kept = stopBob();
    await run(11 * MINUTE, [alice], 10_000);
    const before = await deliveries(port);
    const bob = await DocumentEngine.join(DOC, "bob", port, undefined, {
      ...OPTS,
      ...kept,
      autoResync: false,
    });
    expect(bob.hasCompletedBootstrap).toBe(true);
    await run(MINUTE, [alice, bob], 10_000);
    expect((await requestsOf(port, "bob", before)).map((request) => request.all)).toStrictEqual([
      true,
    ]);
    const started = await deliveries(port);
    bob.noteAbsence(11 * MINUTE);
    await run(HOUR, [alice, bob], 10_000);
    // One request for the absence, and none more in the hour: no gap of its own asks while they are off.
    expect((await requestsOf(port, "bob", started)).map((request) => request.all)).toStrictEqual([
      true,
    ]);
  });

  it("not bootstrapped, it asks as a joiner with them switched off too (RSY-1)", async () => {
    const { port, stopBob } = await pair();
    const { controlState, restore } = stopBob();
    const before = await deliveries(port);
    await DocumentEngine.join(DOC, "bob", port, undefined, {
      ...OPTS,
      autoResync: false,
      controlState,
      restore: { state: restore.state, readAt: Date.now() },
    });
    expect((await requestsOf(port, "bob", before)).map((request) => request.all)).toStrictEqual([
      false,
    ]);
  });

  it("a member restarted without a cursor reads, then asks as a joiner, stating no control clock", async () => {
    const { port, alice, stopBob } = await pair();
    const { controlState, restore } = stopBob();
    const before = await deliveries(port);
    const bob = await DocumentEngine.join(DOC, "bob", port, undefined, {
      ...OPTS,
      controlState,
      restore: { state: restore.state, readAt: Date.now() },
    });
    const [request] = await requestsOf(port, "bob", before);
    expect(request).toMatchObject({ all: false, controlClock: null });
    await poll(alice, bob);
    expect(bob.hasCompletedBootstrap).toBe(true);
  });

  it("a restarted engine writes under a CRDT client id of its own, none its restored state holds (LOS-27)", async () => {
    const { port, alice, stopBob } = await pair();
    const old = new Set(profileFor(YJS_PARAGRAPHS_1).updateClientIds(encodeUpdate(alice.document)));
    const kept = stopBob();
    const restoredClients = new Set(
      profileFor(YJS_PARAGRAPHS_1).updateClientIds(kept.restore.state),
    );
    const bob = await DocumentEngine.join(DOC, "bob", port, undefined, { ...OPTS, ...kept });
    expect(restoredClients.has(bob.document.clientID)).toBe(false);
    expect(old.has(bob.document.clientID)).toBe(false);
    const before = await deliveries(port);
    bob.edit((fragment) => insertPlainText(fragment, 0, "again "));
    await poll(bob, alice);
    const [edit] = (await port.receive(DOC, "observer"))
      .slice(before)
      .map((delivery) => decodeFrame(delivery.payload));
    expect(
      edit?.kind === "edit" && profileFor(YJS_PARAGRAPHS_1).updateClientIds(edit.update),
    ).toStrictEqual([bob.document.clientID]);
    expect(getPlainText(alice.fragment)).toBe("again Plan");
  });
});

describe("a running engine told how long it was away (noteAbsence: RSY-1, RSY-21, LIF-12)", () => {
  /** Bob runs on; he is told he was away for `awayMs`. */
  async function away(awayMs: number) {
    const { port, alice, bob } = await pair();
    const before = await deliveries(port);
    bob.noteAbsence(awayMs);
    await run(HOUR, [alice, bob], 5_000);
    return (await requestsOf(port, "bob", before)).map((request) => request.all);
  }

  it("10 minutes or less: nothing", async () => {
    expect(await away(10 * MINUTE)).toStrictEqual([]);
  });

  it("more than 10 minutes: one start request, to all, not repeated", async () => {
    expect(await away(10 * MINUTE + 1)).toStrictEqual([true]);
  });

  it("longer than the transport keeps: a return, whose request to all is asked once more when it expires unanswered", async () => {
    const { port, alice, bob } = await pair();
    const running = await DocumentEngine.join(DOC, "bob", port, undefined, {
      ...OPTS,
      transportRetentionMs: KEPT,
    });
    await run(5_000, [alice, bob, running]);
    const before = await deliveries(port);
    running.noteAbsence(KEPT + 1);
    await run(HOUR, [alice, bob, running], 5_000);
    expect((await requestsOf(port, "bob", before)).map((request) => request.all)).toStrictEqual([
      true,
      true,
    ]);
  });

  it("either wakes a resting gap: the request is its one, and it rests again", async () => {
    const { port, alice, bob } = await pair();
    // Alice's first edit never reaches Bob, her second does: a gap nobody but she can heal, and she is gone.
    port.dropNextSend("alice");
    alice.edit((fragment) => insertPlainText(fragment, 0, "1"));
    await vi.advanceTimersByTimeAsync(0);
    alice.edit((fragment) => insertPlainText(fragment, 0, "2"));
    await vi.advanceTimersByTimeAsync(0);
    alice.dispose();
    await run(30 * MINUTE, [bob], 5_000);
    expect(bob.syncHealth.suspicions).toMatchObject([{ kind: "pending-gap", resting: true }]);
    const before = await deliveries(port);
    bob.noteAbsence(11 * MINUTE);
    await run(HOUR, [bob], 5_000);
    expect((await requestsOf(port, "bob", before)).map((request) => request.all)).toStrictEqual([
      true,
    ]);
    expect(bob.syncHealth.suspicions).toMatchObject([
      { kind: "pending-gap", tries: 3, resting: true },
    ]);
  });
});
