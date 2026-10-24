import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import { describe, expect, it } from "vitest";
import {
  type ControlOperation,
  ControlState,
  type ControlStateSnapshot,
  MAX_CREATOR_DEVICES,
} from "./control-state";
import { canonicalJson } from "./digest";
import { decodeFrame, encodeControlFrame, encodeResyncResponseFrame } from "./framing";
import { DocumentEngine } from "./index";
import { YJS_PARAGRAPHS_1 } from "./profile";

/**
 * What a control state holds fits its snapshot (SPECIFICATION.md CTL-30, CTL-36, §7.5): the close
 * keeps the latest close of at most 64 devices, those whose tags come first in code point order,
 * and no `seen`; any other target's `seen` names at most 64 devices, and an operation or a snapshot
 * that would bring it over is refused like one over the bytes (CTL-32). Whatever arrives, in
 * whatever order, the state is the same, bounded, and its snapshot is read back by the decoder. The
 * acceptance cases of a review of the draft.
 */

const tag = (n: number, prefix = "D") => `${prefix}${String(n).padStart(21, "0")}`;
const close = (
  device: string,
  counter = 1,
  seen: Record<string, number> = {},
): ControlOperation => ({
  device,
  counter,
  target: "close",
  value: true,
  seen,
});

/** A deterministic shuffle, so that a failing order can be named. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

function holding(ops: readonly ControlOperation[]): ControlState {
  const state = new ControlState();
  for (const op of ops) state.add(op);
  return state;
}

/** The snapshot through the wire and back, restored: what a joiner holds from it. */
function roundTrip(snapshot: ControlStateSnapshot): ControlState {
  const frame = encodeResyncResponseFrame({
    documentId: "doc-1",
    respondsTo: "000000000000000a",
    update: new Uint8Array([0, 0]),
    control: { profile: YJS_PARAGRAPHS_1, ...snapshot },
  });
  const decoded = decodeFrame(frame);
  if (decoded.kind !== "resync-response" || decoded.control === null)
    throw new Error("no control state in the answer");
  const { profile: _profile, ...control } = decoded.control;
  return ControlState.from(control);
}

describe("the close, a bounded record (CTL-36, LIF-7)", () => {
  it.each([64, 65, 1000])(
    "%i devices that close, in three orders: the same 64 heads of the smallest tags, closed, and read back",
    (count) => {
      const ops = Array.from({ length: count }, (_, n) => close(tag(n)));
      const orders = [ops, [...ops].reverse(), shuffled(ops, count)];
      const snapshots = orders.map((order) => holding(order).snapshot());
      for (const snapshot of snapshots) {
        expect(snapshot).toEqual(snapshots[0]);
        expect(snapshot.targets.close?.heads.map((head) => head.device)).toEqual(
          Array.from({ length: Math.min(count, MAX_CREATOR_DEVICES) }, (_, n) => tag(n)),
        );
        expect(snapshot.targets.close?.seen).toEqual({});
        const restored = roundTrip(snapshot);
        expect(restored.closed).toBe(true);
        expect(restored.snapshot()).toEqual(snapshot);
      }
    },
  );

  it("a device's later close replaces its earlier one; a copy changes nothing", () => {
    const state = holding([close(tag(1), 1), close(tag(1), 3), close(tag(1), 2), close(tag(1), 3)]);
    expect(state.snapshot().targets.close?.heads).toEqual([
      { device: tag(1), counter: 3, value: true, seen: {} },
    ]);
  });

  it("closes of devices the bound on devices gives up, or refuses, are held all the same", () => {
    // 64 devices hold grants; a close from a device after all of them is refused at the device bound,
    // one from a device before them pushes the last one out.
    const grants = Array.from(
      { length: MAX_CREATOR_DEVICES },
      (_, n): ControlOperation => ({
        device: tag(n + 10, "G"),
        counter: 1,
        target: `member:m${n}` as "member:x",
        value: "read",
        seen: {},
      }),
    );
    const lastHeld = tag(MAX_CREATOR_DEVICES + 9, "G");
    const ops = [...grants, close(lastHeld, 2), close(tag(1, "Z")), close(tag(1, "A"))];
    const snapshots = [ops, [...ops].reverse(), shuffled(ops, 7)].map((order) =>
      holding(order).snapshot(),
    );
    for (const snapshot of snapshots) {
      expect(snapshot).toEqual(snapshots[0]);
      expect(Object.keys(snapshot.vector)).toHaveLength(MAX_CREATOR_DEVICES);
      expect(snapshot.vector[tag(1, "A")]).toBe(1); // held, the last grant's device given up
      expect(snapshot.vector[lastHeld]).toBeUndefined();
      expect(snapshot.targets.close?.heads.map((head) => head.device)).toEqual([
        tag(1, "A"),
        lastHeld,
        tag(1, "Z"),
      ]);
      expect(roundTrip(snapshot).closed).toBe(true);
    }
  });

  it("closes with different `seen`: the close keeps none, and what it holds stays bounded", () => {
    // Every close has seen 64 devices no other close names.
    const ops = Array.from({ length: 200 }, (_, n) =>
      close(
        tag(n),
        1,
        Object.fromEntries(
          Array.from({ length: MAX_CREATOR_DEVICES }, (_, k) => [tag(n * 100 + k, "S"), 5]),
        ),
      ),
    );
    const state = holding(shuffled(ops, 3));
    const snapshot = state.snapshot();
    expect(snapshot.targets.close?.heads).toHaveLength(MAX_CREATOR_DEVICES);
    expect(snapshot.targets.close?.seen).toEqual({});
    // 64 heads of at most 64 entries each, whatever else arrived.
    expect(Buffer.byteLength(canonicalJson(snapshot.targets.close))).toBeLessThan(200_000);
    expect(state.capacityConflict).toBe(false);
    expect(roundTrip(snapshot).snapshot()).toEqual(snapshot);
  });

  it("taken as operations or in snapshots, in parts and in any order, the state is the same", () => {
    const ops = Array.from({ length: 150 }, (_, n) => close(tag(n)));
    const byOperation = holding(ops);
    const [a, b, c] = [ops.slice(0, 50), ops.slice(50, 100), ops.slice(100)].map((part) =>
      holding(part).snapshot(),
    ) as [ControlStateSnapshot, ControlStateSnapshot, ControlStateSnapshot];
    for (const parts of [
      [a, b, c],
      [c, b, a],
      [b, a, c],
    ]) {
      const merged = new ControlState();
      for (const part of parts) expect(merged.mergeOrRefuse(part).refused).toBe(false);
      expect(merged.snapshot()).toEqual(byOperation.snapshot());
    }
    expect(roundTrip(byOperation.snapshot()).snapshot()).toEqual(byOperation.snapshot());
  });
});

describe("a target's `seen`, at most 64 devices (CTL-30, CTL-32)", () => {
  const seenOf = (prefix: string, count: number) =>
    Object.fromEntries(Array.from({ length: count }, (_, k) => [tag(k, prefix), 3]));
  const first: ControlOperation = {
    device: "A".repeat(22),
    counter: 1,
    target: "member:bob",
    value: "read",
    seen: seenOf("S", 40),
  };
  const second: ControlOperation = {
    device: "B".repeat(22),
    counter: 1,
    target: "member:bob",
    value: "write",
    seen: seenOf("T", 40),
  };

  it("an operation that would name more is refused, a capacity conflict, in either order", () => {
    for (const [one, other] of [
      [first, second],
      [second, first],
    ] as const) {
      const state = new ControlState();
      expect(state.add(one)).toBe("added");
      expect(state.add(other)).toBe("refused");
      expect(state.capacityConflict).toBe(true);
      expect(
        Object.keys(state.snapshot().targets["member:bob"]?.seen ?? {}).length,
      ).toBeLessThanOrEqual(MAX_CREATOR_DEVICES);
      expect(roundTrip(state.snapshot()).snapshot()).toEqual(state.snapshot());
    }
  });

  it("a snapshot that would bring it over is refused whole, and its close still holds", () => {
    const state = holding([first]);
    const over = holding([second, close(tag(1))]).snapshot();
    expect(state.mergeOrRefuse(over).refused).toBe(true);
    expect(state.capacityConflict).toBe(true);
    expect(state.closed).toBe(true);
    expect(state.snapshot().targets["member:bob"]?.heads).toHaveLength(1);
    expect(roundTrip(state.snapshot()).closed).toBe(true);
  });

  it("within the bound, nothing changes: 64 devices together are taken", () => {
    const state = new ControlState();
    expect(state.add({ ...first, seen: seenOf("S", 31) })).toBe("added");
    expect(state.add({ ...second, seen: seenOf("T", 31) })).toBe("added"); // 62 + the two devices themselves
    expect(state.capacityConflict).toBe(false);
  });
});

describe("through the engine (CTL-36, §7.5)", () => {
  it("65 closes under the creator's account: a snapshot the decoder reads, and a later joiner learns the close", async () => {
    const port = new InMemoryMessengerPort();
    const options = { batchWindowMs: 0, resyncResponseThrottleMs: 0, creatorMemberId: "alice" };
    const alice = await DocumentEngine.create("doc-1", "alice", port, undefined, options);
    await alice.setMembership("bob", "read");
    await alice.setMembership("carol", "read");
    const bob = await DocumentEngine.join("doc-1", "bob", port, undefined, options);
    const settle = async (...engines: DocumentEngine[]) => {
      for (let round = 0; round < 6; round += 1) {
        for (const engine of engines) await engine.sync();
      }
    };
    await settle(alice, bob);
    for (let n = 0; n < 65; n += 1) {
      await port.send(
        "doc-1",
        "alice",
        encodeControlFrame({
          documentId: "doc-1",
          device: tag(n),
          counter: 1,
          target: "close",
          value: true,
          seen: {},
        }),
      );
    }
    await settle(alice, bob);
    for (const engine of [alice, bob]) {
      expect(engine.closed).toBe(true);
      const { profile: _profile, ...control } = engine.controlState;
      expect(control.targets.close?.heads.length).toBeLessThanOrEqual(MAX_CREATOR_DEVICES);
      expect(roundTrip(control).closed).toBe(true);
    }
    const carol = await DocumentEngine.join("doc-1", "carol", port, undefined, options);
    await settle(alice, bob, carol);
    expect(carol.hasCompletedBootstrap).toBe(true);
    expect(carol.closed).toBe(true);
  });
});
