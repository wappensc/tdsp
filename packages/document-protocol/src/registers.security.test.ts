import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import type { MessengerPort } from "@tdsp/messenger-port";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Clock, MAX_CLOCK_COUNTER, MAX_CLOCK_MS } from "./clock";
import { ControlState, type Register } from "./control-state";
import { decodeFrame, encodeControlFrame, encodeResyncResponseFrame } from "./framing";
import { ControlFrameRejectedError, DocumentEngine, SendRefusedError } from "./index";

/**
 * Control state as registers (SPECIFICATION.md §7): whose registers count as the creator's decisions
 * (CTL-5, CTL-6, CTL-25), that no receiver sets a register aside for its own time, so receivers of
 * the same registers hold the same whatever their clocks (CTL-22, CTL-45), and that the close only
 * closes, and only by the creator (CTL-23, CTL-36, LIF-7). Security tests: only the CI role may change
 * this file (.github/CODEOWNERS).
 */

const DOCUMENT_ID = "doc-1";
const AS_ALICE = { batchWindowMs: 0, resyncResponseThrottleMs: 0, creatorMemberId: "alice" };
/** 2026-10-26 10:00:00 UTC. */
const T = 1_793_008_800_000;
const DAY = 86_400_000;
const TAG = "C".repeat(22);

afterEach(() => {
  vi.useRealTimers();
});

/** Registers and the close as a `control` frame writes them, under `device`. */
function controlFrame(
  targets: Record<string, Register>,
  options: { closed?: boolean; device?: string } = {},
): string {
  const state = new ControlState();
  state.take({ closed: options.closed ?? false, targets });
  return encodeControlFrame({
    documentId: DOCUMENT_ID,
    device: options.device ?? TAG,
    targets,
    closed: state.closed,
    controlClock: state.clock,
    controlDigest: state.digest,
  });
}

/** An answer to `respondsTo` carrying a snapshot of the given registers. */
function answer(
  respondsTo: string,
  targets: Record<string, Register>,
  options: { closed?: boolean } = {},
): string {
  return encodeResyncResponseFrame({
    documentId: DOCUMENT_ID,
    respondsTo,
    update: new Uint8Array([0, 0]),
    control: {
      profile: "yjs-paragraphs/1",
      closed: options.closed ?? false,
      targets,
    },
  });
}

const register = (value: Register["value"], clock: Clock, device = TAG): Register => ({
  value,
  clock,
  device,
});

/** The `requestId` of `member`'s latest request in the channel. */
async function latestRequestOf(port: MessengerPort, member: string): Promise<string> {
  const requests = (await port.receive(DOCUMENT_ID, "observer"))
    .filter((delivery) => delivery.sender === member)
    .map((delivery) => decodeFrame(delivery.payload))
    .filter((frame) => frame.kind === "resync-request");
  const last = requests.at(-1);
  if (last?.kind !== "resync-request") throw new Error(`no request of ${member}`);
  return last.requestId;
}

async function settle(...engines: DocumentEngine[]): Promise<void> {
  for (let round = 0; round < 4; round++) {
    for (const engine of engines) {
      await engine.sync();
      await engine.flush().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

/** A creator, a member that may read, and a member that may write, all bootstrapped. */
async function three() {
  const port = new InMemoryMessengerPort();
  const errors = { bob: [] as unknown[], carol: [] as unknown[] };
  const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
  await alice.setMembership("bob", "read");
  await alice.setMembership("carol", "write");
  const bob = await DocumentEngine.join(
    DOCUMENT_ID,
    "bob",
    port,
    (error) => errors.bob.push(error),
    AS_ALICE,
  );
  const carol = await DocumentEngine.join(
    DOCUMENT_ID,
    "carol",
    port,
    (error) => errors.carol.push(error),
    AS_ALICE,
  );
  await settle(alice, bob, carol);
  expect(bob.hasCompletedBootstrap && carol.hasCompletedBootstrap).toBe(true);
  return { port, alice, bob, carol, errors };
}

describe("only the creator's identity decides (CTL-5, CTL-6, CTL-25)", () => {
  it("a member's control frame is refused whole: it gives itself nothing, revokes no one, sets no pace", async () => {
    const { port, alice, bob, carol, errors } = await three();
    // Bob writes the frame a device of the creator would, with clocks far ahead of everything.
    await port.send(
      DOCUMENT_ID,
      "bob",
      controlFrame({
        "member:bob": register("write", [T + 365 * DAY, 0]),
        "member:carol": register(null, [T + 365 * DAY, 1]),
        pace: register(600_000, [T + 365 * DAY, 2]),
      }),
    );
    await settle(alice, bob, carol);
    for (const engine of [alice, bob, carol]) {
      expect(engine.permissionOf("bob")).toBe("read");
      expect(engine.permissionOf("carol")).toBe("write");
      expect(engine.pace).toBeUndefined();
    }
    expect(bob.mayEdit).toBe(false);
    expect(carol.mayEdit).toBe(true);
    expect(errors.carol).toContainEqual(
      expect.objectContaining({ name: "ControlFrameRejectedError", reason: "not-from-creator" }),
    );
    expect(errors.carol.every((error) => error instanceof ControlFrameRejectedError)).toBe(true);
  });

  it("device tags authenticate nothing: a member's control frame under the creator's own device tag is refused whole", async () => {
    const { port, alice, bob, carol, errors } = await three();
    const tag = alice.deviceTag as string;
    await port.send(
      DOCUMENT_ID,
      "carol",
      controlFrame(
        {
          "member:carol": register("write", [T + DAY, 0], tag),
          "member:bob": register(null, [T + DAY, 1], tag),
        },
        { device: tag },
      ),
    );
    await settle(alice, bob, carol);
    for (const engine of [alice, bob, carol]) {
      expect(engine.permissionOf("bob")).toBe("read");
      expect(engine.permissionOf("carol")).toBe("write");
    }
    expect(errors.bob).toContainEqual(
      expect.objectContaining({ name: "ControlFrameRejectedError", reason: "not-from-creator" }),
    );
  });

  it("the creator's registers count, from a frame and from a snapshot alike", async () => {
    // The device's own clock stands at T, so that the frame's registers a day later are the creator's
    // later decisions (CTL-22) whatever day the suite runs.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T);
    const { port, bob } = await three();
    await port.send(
      DOCUMENT_ID,
      "alice",
      controlFrame({ "member:bob": register("write", [T + DAY, 0]) }),
    );
    await bob.sync();
    expect(bob.permissionOf("bob")).toBe("write");
    const dave = await DocumentEngine.join(DOCUMENT_ID, "dave", port, undefined, AS_ALICE);
    await port.send(
      DOCUMENT_ID,
      "alice",
      answer(await latestRequestOf(port, "dave"), {
        "member:dave": register("write", [T + DAY, 1]),
      }),
    );
    await dave.sync();
    expect(dave.hasCompletedBootstrap).toBe(true);
    expect(dave.permissionOf("dave")).toBe("write");
  });
});

/** A small, fixed pseudo-random sequence (mulberry32), so a failing history can be replayed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("no receiver sets a register aside for its own time (CTL-22, CTL-45)", () => {
  const DEVICES = ["A".repeat(22), "B".repeat(22), "a".repeat(22)];
  const TARGETS = ["member:bob", "member:carol", "layer:com.example.comments/1:member:bob", "pace"];

  it("random histories with clocks a day around the receivers' times converge, whatever order each receiver merges in and whatever its time", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let seed = 1; seed <= 300; seed++) {
      const next = random(seed);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
      // A history: frames of the creator's devices, each one to three registers, clocks within a
      // day either side of T, some at one clock to force ties.
      const frames = Array.from({ length: 10 }, () => {
        const targets: Record<string, Register> = {};
        const count = 1 + Math.floor(next() * 3);
        for (let k = 0; k < count; k++) {
          const target = pick(TARGETS);
          const ms = next() < 0.2 ? T : T + Math.round((next() * 2 - 1) * DAY);
          const value =
            target === "pace" ? pick([0, 1_000, 30_000]) : pick(["read", "write", null] as const);
          targets[target] = register(value, [ms, Math.floor(next() * 3)], pick(DEVICES));
        }
        return { closed: next() < 0.1, targets };
      });
      // Four receivers, each at a wall clock of its own, each taking the frames in its own order.
      const states = [T - DAY, T, T + DAY, T + 2 * DAY].map((now) => {
        vi.setSystemTime(now);
        const order = [...frames].sort(() => next() - 0.5);
        const state = new ControlState();
        for (const frame of order) state.take(frame);
        return state;
      });
      for (const state of states.slice(1)) {
        expect(state.state(), `seed ${seed}`).toStrictEqual(states[0]?.state());
        expect(state.digest, `seed ${seed}`).toBe(states[0]?.digest);
      }
    }
  });

  it("an engine holds the creator's register a year ahead of its time, and a decision made in knowledge of it holds over it everywhere", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T);
    const { port, alice, bob, carol } = await three();
    await port.send(
      DOCUMENT_ID,
      "alice",
      controlFrame({ "member:bob": register("write", [T + 365 * DAY, 0], "F".repeat(22)) }),
    );
    await settle(alice, bob, carol);
    for (const engine of [alice, bob, carol]) expect(engine.permissionOf("bob")).toBe("write");
    await alice.setMembership("bob", "read");
    await settle(alice, bob, carol);
    for (const engine of [alice, bob, carol]) expect(engine.permissionOf("bob")).toBe("read");
  });
});

describe("a register at the end of the range, which a device of the creator sent (CTL-45)", () => {
  it("leaves no clock for a decision on its target: the device refuses it as clock-exhausted, the register holds everywhere, and every other target stays decidable", async () => {
    const { port, alice, bob, carol } = await three();
    await port.send(
      DOCUMENT_ID,
      "alice",
      controlFrame({
        "member:bob": register("write", [MAX_CLOCK_MS, MAX_CLOCK_COUNTER], "F".repeat(22)),
      }),
    );
    await settle(alice, bob, carol);
    const refused = alice.setMembership("bob", "read");
    await expect(refused).rejects.toBeInstanceOf(SendRefusedError);
    await expect(refused).rejects.toMatchObject({ reason: "clock-exhausted" });
    await alice.setMembership("carol", "read");
    await settle(alice, bob, carol);
    for (const engine of [alice, bob, carol]) {
      expect(engine.permissionOf("bob")).toBe("write");
      expect(engine.permissionOf("carol")).toBe("read");
    }
  });
});

describe("the close only closes, and only the creator closes (CTL-23, CTL-36, LIF-7)", () => {
  it("nothing reopens a closed document: not a frame or snapshot without the close, in any order", () => {
    const registers = { "member:bob": register("write", [T + DAY, 0]) };
    const closing = { closed: true, targets: {} };
    const open = { closed: false, targets: registers };
    for (const order of [
      [closing, open],
      [open, closing],
    ]) {
      const state = new ControlState();
      for (const frame of order) state.take(frame);
      expect(state.closed).toBe(true);
      expect(ControlState.from({ closed: false, targets: state.state().targets }).closed).toBe(
        false,
      );
      const merged = new ControlState();
      merged.take(state.state());
      merged.take({ closed: false, targets: {} });
      expect(merged.closed).toBe(true);
    }
  });

  it("an engine stays closed when the creator's later frames and snapshots carry no close", async () => {
    const { port, alice, bob, carol } = await three();
    await alice.closeDocument();
    await settle(alice, bob, carol);
    expect(bob.closed).toBe(true);
    await port.send(
      DOCUMENT_ID,
      "alice",
      controlFrame({ "member:dave": register("write", [T + 2 * DAY, 0]) }),
    );
    await port.send(DOCUMENT_ID, "alice", answer("00000000000000ff", {}, { closed: false }));
    await settle(bob, carol);
    expect(bob.closed && carol.closed).toBe(true);
    expect(carol.mayEdit).toBe(false);
  });

  it("a member's close as a `control` frame closes nothing: only the creator's identity sends them (CTL-5)", async () => {
    const { port, alice, bob, carol } = await three();
    await port.send(DOCUMENT_ID, "bob", controlFrame({}, { closed: true }));
    await settle(alice, bob, carol);
    for (const engine of [alice, bob, carol]) expect(engine.closed).toBe(false);
    expect(carol.mayEdit).toBe(true);
  });
});
