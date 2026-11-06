import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import type { MemberId } from "@tdsp/messenger-port";
import {
  createDocument,
  deletePlainText,
  encodeDeletions,
  encodeStateVector,
  insertPlainText,
  type ReconciledDocument,
} from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clock } from "./clock";
import { digestOf } from "./digest";
import {
  type ControlFrame,
  decodeFrame,
  encodeHeartbeatFrame,
  encodeResyncRequestFrame,
  type ResyncResponseFrame,
} from "./framing";
import { DocumentEngine } from "./index";

/**
 * Requests read late (SPECIFICATION.md RSY-9, RSY-17, RSY-20, LOS-13): frames carry no time of
 * sending, and clocks may be off, so no clock tells a member that a request it reads has waited long.
 * What does: of each requesting stream only its latest request counts, and whether that stream has
 * anything to get is judged by the furthest it stated of its state — in any request, report or answer
 * of it, whichever arrived first. A member that comes back answers a request only where the stream
 * still lacks something it holds.
 */

const DOC = "doc-1";
/** 2026-10-26 10:00:00 UTC. */
const T = 1_793_008_800_000;
const MINUTE = 60_000;
const OPTS = {
  batchWindowMs: 0,
  resyncResponseThrottleMs: 0,
  creatorMemberId: "alice",
  syncPolicy: { expectedLatencyMs: 2_000 },
};
/** Dave's stream and Gina's, and a second device of Alice's: their frames are written here. */
const DAVE = "0d4a5e6f7a8b9c0d";
const GINA = "6a1b2c3d4e5f6071";
const SECOND_DEVICE = "a2b3c4d5e6f70819";
const id = (n: number) => `c0ffee${String(n).padStart(10, "0")}`;

interface State {
  readonly stateVector: Uint8Array;
  readonly stateDigest: string;
}

const stateOf = (document: ReconciledDocument): State => ({
  stateVector: encodeStateVector(document),
  stateDigest: digestOf(encodeDeletions(document)),
});

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
      await engine.sync();
      await vi.advanceTimersByTimeAsync(0);
    }
  }
}

/**
 * Alice creates "Plan", lets Bob and Dave write, writes on and deletes a letter; Bob joins and holds
 * it all. Then Alice is gone: nobody else answers, and nobody silences Bob. What each stage stated,
 * and Alice's control clock and digest after her first decision and after her last.
 */
async function bobHoldsAll() {
  const port = new InMemoryMessengerPort();
  const alice = await DocumentEngine.create(DOC, "alice", port, undefined, OPTS);
  await alice.setMembership("bob", "write");
  await alice.setMembership("dave", "write");
  alice.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
  await run(2_000, [alice]);
  const early = stateOf(alice.document);
  alice.edit((fragment) => insertPlainText(fragment, 4, " more"));
  alice.edit((fragment) => deletePlainText(fragment, 0, 1));
  await run(2_000, [alice]);
  const bob = await DocumentEngine.join(DOC, "bob", port, undefined, OPTS);
  await run(MINUTE, [alice, bob]);
  expect(bob.hasCompletedBootstrap).toBe(true);
  alice.dispose();
  const controls = (await port.receive(DOC, "observer"))
    .map((delivery) => decodeFrame(delivery.payload))
    .filter((frame): frame is ControlFrame => frame.kind === "control");
  const control = (frame: ControlFrame | undefined) => ({
    controlClock: frame?.controlClock as Clock,
    controlDigest: frame?.controlDigest as string,
  });
  return {
    port,
    bob,
    early,
    first: control(controls[0]),
    last: control(controls.at(-1)),
  };
}

/** The answers `member` sent to the requests `ids`. */
async function answersBy(
  port: InMemoryMessengerPort,
  member: MemberId,
  ids: readonly string[],
): Promise<string[]> {
  return (await port.receive(DOC, "observer"))
    .filter((delivery) => delivery.sender === member)
    .map((delivery) => decodeFrame(delivery.payload))
    .filter(
      (frame): frame is ResyncResponseFrame =>
        frame.kind === "resync-response" && ids.includes(frame.respondsTo),
    )
    .map((frame) => frame.respondsTo);
}

describe("requests read late (RSY-9, RSY-20)", () => {
  it("a member back after minutes reads three old requests of Dave's, then his report that shows he lacks nothing: it answers none of them", {
    timeout: 60_000,
  }, async () => {
    const { port, bob, early, last } = await bobHoldsAll();
    // While Bob does not read, Dave asks three times, stating what he held early, and then reports
    // that he holds what Bob holds.
    for (const n of [1, 2, 3]) {
      await port.send(
        DOC,
        "dave",
        encodeResyncRequestFrame({
          documentId: DOC,
          requestId: id(n),
          ...last,
          all: true,
          force: false,
          ...early,
          stream: DAVE,
          sequence: n,
        }),
      );
    }
    await port.send(
      DOC,
      "dave",
      encodeHeartbeatFrame({
        documentId: DOC,
        controlClock: null,
        controlDigest: null,
        ...stateOf(bob.document),
        stream: DAVE,
        sequence: 4,
      }),
    );
    await run(5 * MINUTE, [bob]);
    expect(await answersBy(port, "bob", [id(1), id(2), id(3)])).toStrictEqual([]);
  });

  it("a joiner not bootstrapped that asked twice in vain has its latest request answered, once", {
    timeout: 60_000,
  }, async () => {
    const { port, bob } = await bobHoldsAll();
    const empty = stateOf(createDocument());
    // Gina asks Alice's devices first, then all, twice; none of it reached anyone that answered.
    for (const n of [1, 2, 3]) {
      await port.send(
        DOC,
        "gina",
        encodeResyncRequestFrame({
          documentId: DOC,
          requestId: id(10 + n),
          controlClock: null,
          controlDigest: null,
          all: n > 1,
          force: false,
          ...empty,
          stream: GINA,
          sequence: n,
        }),
      );
    }
    await run(5 * MINUTE, [bob]);
    expect(await answersBy(port, "bob", [id(11), id(12), id(13)])).toStrictEqual([id(13)]);
  });

  it("an earlier request of a stream that arrives after its latest is not answered", {
    timeout: 60_000,
  }, async () => {
    const { port, bob } = await bobHoldsAll();
    const empty = stateOf(createDocument());
    for (const n of [3, 2]) {
      await port.send(
        DOC,
        "gina",
        encodeResyncRequestFrame({
          documentId: DOC,
          requestId: id(10 + n),
          controlClock: null,
          controlDigest: null,
          all: true,
          force: false,
          ...empty,
          stream: GINA,
          sequence: n,
        }),
      );
    }
    await run(5 * MINUTE, [bob]);
    expect(await answersBy(port, "bob", [id(12), id(13)])).toStrictEqual([id(13)]);
  });

  it("Dave's report arrives before his request: Bob judges by the further of the two, and answers nothing", {
    timeout: 60_000,
  }, async () => {
    const { port, bob, early, last } = await bobHoldsAll();
    await port.send(
      DOC,
      "dave",
      encodeHeartbeatFrame({
        documentId: DOC,
        controlClock: null,
        controlDigest: null,
        ...stateOf(bob.document),
        stream: DAVE,
        sequence: 4,
      }),
    );
    await port.send(
      DOC,
      "dave",
      encodeResyncRequestFrame({
        documentId: DOC,
        requestId: id(3),
        ...last,
        all: true,
        force: false,
        ...early,
        stream: DAVE,
        sequence: 3,
      }),
    );
    await run(5 * MINUTE, [bob]);
    expect(await answersBy(port, "bob", [id(3)])).toStrictEqual([]);
  });

  it("a report that states Bob's deletions, and a later one at the same state vector with more of Dave's own: nothing to give either (LOS-12)", {
    timeout: 60_000,
  }, async () => {
    const { port, bob, early, last } = await bobHoldsAll();
    const held = stateOf(bob.document);
    await port.send(
      DOC,
      "dave",
      encodeResyncRequestFrame({
        documentId: DOC,
        requestId: id(3),
        ...last,
        all: true,
        force: false,
        ...early,
        stream: DAVE,
        sequence: 3,
      }),
    );
    await port.send(
      DOC,
      "dave",
      encodeHeartbeatFrame({
        documentId: DOC,
        controlClock: null,
        controlDigest: null,
        ...held,
        stream: DAVE,
        sequence: 4,
      }),
    );
    // Dave deleted more of what he holds: his state vector stays, his digest moves on.
    await port.send(
      DOC,
      "dave",
      encodeHeartbeatFrame({
        documentId: DOC,
        controlClock: null,
        controlDigest: null,
        stateVector: held.stateVector,
        stateDigest: "00000000000000ff",
        stream: DAVE,
        sequence: 5,
      }),
    );
    await run(5 * MINUTE, [bob]);
    expect(await answersBy(port, "bob", [id(3)])).toStrictEqual([]);
  });

  it("a device of the creator's request to all with an earlier control clock arrives after its report of Bob's: no control state to give", {
    timeout: 60_000,
  }, async () => {
    const { port, bob, first, last } = await bobHoldsAll();
    const held = stateOf(bob.document);
    await port.send(
      DOC,
      "alice",
      encodeHeartbeatFrame({
        documentId: DOC,
        ...last,
        ...held,
        stream: SECOND_DEVICE,
        sequence: 2,
      }),
    );
    await port.send(
      DOC,
      "alice",
      encodeResyncRequestFrame({
        documentId: DOC,
        requestId: id(20),
        ...first,
        all: true,
        force: false,
        ...held,
        stream: SECOND_DEVICE,
        sequence: 1,
      }),
    );
    await run(5 * MINUTE, [bob]);
    expect(await answersBy(port, "bob", [id(20)])).toStrictEqual([]);
  });
});

describe("what each requesting stream stated, stream by stream (RSY-9, RSY-17, LOS-13)", () => {
  /** Gina's other device, with a stream of its own. */
  const GINA_OTHER = "7b2c3d4e5f607182";

  it("two requests of one member, each the latest of its own stream, are both answered: one numbered lower is no earlier request of the other stream (RSY-9)", {
    timeout: 60_000,
  }, async () => {
    const { port, bob } = await bobHoldsAll();
    const empty = stateOf(createDocument());
    for (const [n, stream, sequence] of [
      [30, GINA, 5],
      [31, GINA_OTHER, 2],
    ] as const) {
      await port.send(
        DOC,
        "gina",
        encodeResyncRequestFrame({
          documentId: DOC,
          requestId: id(n),
          controlClock: null,
          controlDigest: null,
          all: true,
          force: false,
          ...empty,
          stream,
          sequence,
        }),
      );
    }
    await run(5 * MINUTE, [bob]);
    expect((await answersBy(port, "bob", [id(30), id(31)])).sort()).toStrictEqual([id(30), id(31)]);
  });

  it("a stream that stated, at its greatest control clock, the control digest Bob holds, and then another: Bob has no control state to give it (RSY-17)", {
    timeout: 60_000,
  }, async () => {
    const { port, bob, last } = await bobHoldsAll();
    const held = stateOf(bob.document);
    // Both state what Bob holds of the content, and Alice's last control clock; the later another digest.
    for (const [n, controlDigest, sequence] of [
      [40, last.controlDigest, 3],
      [41, "e".repeat(16), 4],
    ] as const) {
      await port.send(
        DOC,
        "dave",
        encodeResyncRequestFrame({
          documentId: DOC,
          requestId: id(n),
          controlClock: last.controlClock,
          controlDigest,
          all: true,
          force: false,
          ...held,
          stream: DAVE,
          sequence,
        }),
      );
    }
    await run(5 * MINUTE, [bob]);
    expect(await answersBy(port, "bob", [id(40), id(41)])).toStrictEqual([]);
  });
});
