import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import type { MemberId } from "@tdsp/messenger-port";
import { encodeUpdate, insertPlainText } from "@tdsp/reconciliation";
import { describe, expect, it } from "vitest";
import type { Register } from "./control-state";
import {
  CURRENT_FRAME_VERSION,
  decodeFrame,
  encodeResyncResponseFrame,
  type Frame,
} from "./framing";
import {
  type ControlStanding,
  DocumentEngine,
  type DocumentEngineOptions,
  type PersistedControlState,
} from "./index";
import { registerStateDigest } from "./registers";

/**
 * How a device is bootstrapped (SPECIFICATION.md RSY-14, RSY-16, CTL-39, LOS-19, VER-3), beside what
 * bootstrap.security.test.ts checks: by the first answer to its own request that carries control
 * state, whoever sent it; what it tells its application; what its requests state then; what it
 * persists and restores; and that such an answer ends a truncated history. That a state a draft
 * of 2.0 persisted counts as none bootstrap.security.test.ts holds.
 */

const DOC = "doc-1";
const AS_ALICE = { batchWindowMs: 0, resyncResponseThrottleMs: 0, creatorMemberId: "alice" };

async function settle(...engines: DocumentEngine[]): Promise<void> {
  for (let round = 0; round < 6; round++) {
    for (const engine of engines) {
      await engine.sync();
      await engine.flush().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

async function frames(port: InMemoryMessengerPort): Promise<{ sender: MemberId; frame: Frame }[]> {
  return (await port.receive(DOC, "observer")).map((delivery) => ({
    sender: delivery.sender,
    frame: decodeFrame(delivery.payload),
  }));
}

async function latestRequestOf(port: InMemoryMessengerPort, member: MemberId) {
  const last = (await frames(port))
    .filter(({ sender, frame }) => sender === member && frame.kind === "resync-request")
    .at(-1)?.frame;
  if (last?.kind !== "resync-request") throw new Error(`no request of ${member}`);
  return last;
}

/** Carol's answer to `respondsTo`, with the creator's state as Carol holds it, and `more`. */
async function carolAnswers(
  port: InMemoryMessengerPort,
  respondsTo: string,
  alice: DocumentEngine,
  more: Readonly<Record<string, Register>> = {},
) {
  const { targets, ...rest } = alice.controlState;
  await port.send(
    DOC,
    "carol",
    encodeResyncResponseFrame({
      documentId: DOC,
      respondsTo,
      update: new Uint8Array([0, 0]),
      control: { ...rest, targets: { ...targets, ...more } },
    }),
  );
}

/** Alice lets Bob write, writes "Plan" and goes offline; Bob joins, with what he is told collected. */
async function bobJoinsWhileAliceIsAway(options: DocumentEngineOptions = {}) {
  const port = new InMemoryMessengerPort();
  const alice = await DocumentEngine.create(DOC, "alice", port, undefined, AS_ALICE);
  await alice.setMembership("bob", "write");
  alice.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
  await settle(alice);
  port.disconnect("alice");
  const persisted: PersistedControlState[] = [];
  const standings: ControlStanding[] = [];
  const bob = await DocumentEngine.join(DOC, "bob", port, undefined, {
    ...AS_ALICE,
    autoResync: false,
    onControlStateChange: (state) => persisted.push(state),
    onControlStandingChange: (standing) => standings.push(standing),
    ...options,
  });
  return { port, alice, bob, persisted, standings };
}

describe("what a device tells its application of its bootstrap (RSY-14)", () => {
  it("reports its standing as it changes: none, then bootstrapped by a member's answer, once", async () => {
    const { port, alice, bob, standings } = await bobJoinsWhileAliceIsAway();
    expect(bob.controlStanding).toStrictEqual({ kind: "none" });
    expect(standings).toStrictEqual([]);
    await carolAnswers(port, (await latestRequestOf(port, "bob")).requestId, alice);
    await settle(bob);
    expect(standings).toStrictEqual([{ kind: "bootstrapped" }]);
    expect(bob.mayEdit).toBe(true);
    port.reconnect("alice");
    await bob.requestResync();
    await settle(alice, bob);
    expect(standings).toStrictEqual([{ kind: "bootstrapped" }]);
  });

  it("the creator's devices: bootstrapped from the start", async () => {
    const standings: ControlStanding[] = [];
    const alice = await DocumentEngine.create(
      DOC,
      "alice",
      new InMemoryMessengerPort(),
      undefined,
      {
        ...AS_ALICE,
        onControlStandingChange: (standing) => standings.push(standing),
      },
    );
    expect(alice.controlStanding).toStrictEqual({ kind: "bootstrapped" });
    expect(standings).toStrictEqual([]);
  });
});

describe("what a device bootstrapped by a member's answer states and persists (RSY-16, CTL-39)", () => {
  it("it holds what the answer brought, merged with what it held, and its requests state that control clock and digest", async () => {
    const { port, alice, bob } = await bobJoinsWhileAliceIsAway({ autoResync: false });
    // Bob's device holds the creator's frames it read in the history; Carol holds a later decision.
    const later: Register = {
      value: "write",
      clock: [alice.controlClock[0] + 1_000, 0],
      device: "C".repeat(22),
    };
    await carolAnswers(port, (await latestRequestOf(port, "bob")).requestId, alice, {
      "member:carol": later,
    });
    await settle(bob);
    expect(bob.controlStanding.kind).toBe("bootstrapped");
    expect(bob.controlClock).toStrictEqual(later.clock);
    expect(bob.permissionOf("carol")).toBe("write");
    await bob.requestResync();
    const request = await latestRequestOf(port, "bob");
    expect(request.controlClock).toStrictEqual(later.clock);
    expect(request.controlDigest).toBe(
      registerStateDigest({ closed: bob.controlState.closed, targets: bob.controlState.targets }),
    );
  });

  it("a persisted bootstrapped state restores: bootstrapped by its read on", async () => {
    const { port, alice, bob, persisted } = await bobJoinsWhileAliceIsAway();
    port.reconnect("alice");
    await settle(alice, bob);
    expect(bob.controlStanding).toStrictEqual({ kind: "bootstrapped" });
    const saved = persisted.at(-1) as PersistedControlState;
    expect(saved).toMatchObject({ tdsp: CURRENT_FRAME_VERSION, bootstrapped: true });
    const restore = { state: encodeUpdate(bob.document), cursor: bob.cursor };
    bob.dispose();
    port.disconnect("alice");
    const again = await DocumentEngine.join(DOC, "bob", port, undefined, {
      ...AS_ALICE,
      controlState: saved,
      restore,
    });
    await settle(again);
    expect(again.controlStanding).toStrictEqual({ kind: "bootstrapped" });
    expect(again.mayEdit).toBe(true);
  });
});

describe("an answer with control state ends a truncated history (LOS-19)", () => {
  it("a member's answer bootstraps a restarted device and ends the evidence, as the creator's would", async () => {
    const port = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOC, "alice", port, undefined, AS_ALICE);
    await alice.setMembership("bob", "write");
    let control: PersistedControlState | undefined;
    const before = await DocumentEngine.join(DOC, "bob", port, undefined, {
      ...AS_ALICE,
      onControlStateChange: (state) => {
        control = state;
      },
    });
    await settle(alice, before);
    const restore = {
      state: encodeUpdate(before.document),
      cursor: before.cursor,
      instance: before.instance,
    };
    before.dispose();
    port.disconnect("alice");
    // Another instance of the bridge: what it kept since the cursor is not known (LOS-9).
    port.restartBridge();
    const bob = await DocumentEngine.join(DOC, "bob", port, undefined, {
      ...AS_ALICE,
      autoResync: false,
      controlState: control,
      restore,
    });
    await settle(bob);
    const truncated = () =>
      bob.syncHealth.suspicions.some((suspicion) => suspicion.kind === "history-truncated");
    expect(bob.hasCompletedBootstrap).toBe(false);
    expect(truncated()).toBe(true);

    await carolAnswers(port, (await latestRequestOf(port, "bob")).requestId, alice);
    await settle(bob);
    expect(bob.hasCompletedBootstrap).toBe(true);
    expect(truncated()).toBe(false);
  });
});
