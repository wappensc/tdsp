import { describe, expect, it } from "vitest";
import {
  ACCEPTED_CONTROL_BYTES,
  type ControlOperation,
  ControlState,
  type ControlStateSnapshot,
  type ControlTarget,
  DEVICE_TAG,
  isControlTarget,
  issuingVector,
  layerTargetOf,
  MAX_ISSUE_BYTES,
  type MemberRight,
  memberOf,
  narrowestRight,
  newDeviceTag,
} from "./control-state";
import { canonicalJson } from "./digest";

/** A seeded generator, so a failure replays from its seed. */
function generator(seed: number) {
  let state = seed;
  const random = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  return {
    random,
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)] as T,
    shuffle: <T>(xs: readonly T[]): T[] => {
      const out = [...xs];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [out[i], out[j]] = [out[j] as T, out[i] as T];
      }
      return out;
    },
  };
}

const RIGHTS: readonly MemberRight[] = [null, "read", "write"];
const TARGETS: readonly ControlTarget[] = ["member:bob", "member:carol"];

/** One creator device: its own state, what it has seen (any order), and its counter. */
interface Device {
  readonly tag: string;
  readonly state: ControlState;
  readonly seenIds: Set<number>;
  counter: number;
}

interface Issued {
  readonly id: number;
  readonly op: ControlOperation;
  /** The ids of every operation its device held when issuing, holes or not (what `truth` reads). */
  readonly knew: ReadonlySet<number>;
  /** For variant (c): the operations on its target nothing superseded in its device's view. */
  readonly pred: readonly number[];
}

function issue(
  device: Device,
  issued: Issued[],
  target: ControlTarget,
  value: MemberRight,
): Issued {
  device.counter += 1;
  const op: ControlOperation = {
    device: device.tag,
    counter: device.counter,
    target,
    value,
    seen: issuingVector(device.tag, device.state.vector, {}),
  };
  const known = [...device.seenIds]
    .map((id) => issued[id] as Issued)
    .filter((x) => x.op.target === target);
  const replaced = new Set(known.flatMap((x) => x.pred));
  const entry: Issued = {
    id: issued.length,
    op,
    knew: new Set(device.seenIds),
    pred: known.filter((x) => !replaced.has(x.id)).map((x) => x.id),
  };
  issued.push(entry);
  device.state.add(op);
  device.seenIds.add(entry.id);
  return entry;
}

function deliver(device: Device, entry: Issued): void {
  device.state.add(entry.op);
  device.seenIds.add(entry.id);
}

/** The oracle: superseded is what a device had seen — in any order — before deciding the same target. */
function truth(ops: readonly Issued[], target: ControlTarget): MemberRight | undefined {
  const on = ops.filter((x) => x.op.target === target);
  return narrowestRight(
    on.filter((x) => !on.some((p) => p.knew.has(x.id))).map((x) => x.op.value as MemberRight),
  );
}

/** The draft's rule on the whole set: superseded is what the vector of a later decision covers. */
function byVector(ops: readonly Issued[], target: ControlTarget): MemberRight | undefined {
  const on = ops.filter((x) => x.op.target === target);
  const covers = (p: ControlOperation, o: ControlOperation) =>
    (p.device === o.device && p.counter > o.counter) || (p.seen[o.device] ?? 0) >= o.counter;
  return narrowestRight(
    on.filter((x) => !on.some((p) => covers(p.op, x.op))).map((x) => x.op.value as MemberRight),
  );
}

/** Variant (c) on the whole set: superseded is what a later decision names as replaced. */
function byPredecessors(ops: readonly Issued[], target: ControlTarget): MemberRight | undefined {
  const on = ops.filter((x) => x.op.target === target);
  return narrowestRight(
    on.filter((x) => !on.some((p) => p.pred.includes(x.id))).map((x) => x.op.value as MemberRight),
  );
}

function rightOf(state: ControlState, target: ControlTarget): MemberRight | undefined {
  const member = target.slice("member:".length);
  return state.members.get(member) ?? (state.isEmpty ? undefined : null);
}

const order = (right: MemberRight | undefined) =>
  right === undefined ? -1 : RIGHTS.indexOf(right);

describe("rights on layers as targets (§7.1, LAY-5)", () => {
  const LAYER = "com.example.comments/1";

  it("reads a layer right's target by its first :member:, and only with a layer id", () => {
    expect(layerTargetOf(`layer:${LAYER}:member:bob`)).toEqual({ layer: LAYER, member: "bob" });
    expect(layerTargetOf(`layer:${LAYER}:member:@bob:example.org`)).toEqual({
      layer: LAYER,
      member: "@bob:example.org",
    });
    expect(memberOf(`layer:${LAYER}:member:bob`)).toBe("bob");
    for (const target of [
      "layer:Comments/1:member:bob",
      "layer::member:bob",
      `layer:${LAYER}:bob`,
      `layer:${LAYER}`,
    ]) {
      expect(isControlTarget(target), target).toBe(false);
    }
    expect(isControlTarget(`layer:${LAYER}:member:bob`)).toBe(true);
  });

  it("holds the narrowest of concurrent rights on a layer, apart from the permission, and drops a revoked one", () => {
    const state = new ControlState();
    const laptop = "QUFBQUFBQUFBQUFBQUFBQQ";
    const tablet = "QkJCQkJCQkJCQkJCQkJCQg";
    state.add({ device: laptop, counter: 1, target: "member:bob", value: "read", seen: {} });
    state.add({
      device: laptop,
      counter: 2,
      target: `layer:${LAYER}:member:bob`,
      value: "write",
      seen: {},
    });
    state.add({
      device: tablet,
      counter: 1,
      target: `layer:${LAYER}:member:bob`,
      value: "read",
      seen: {},
    });
    expect(state.members.get("bob")).toBe("read");
    expect(state.layerRights.get(LAYER)?.get("bob")).toBe("read");
    state.add({
      device: laptop,
      counter: 3,
      target: `layer:${LAYER}:member:bob`,
      value: null,
      seen: { [tablet]: 1 },
    });
    expect(state.layerRights.get(LAYER)).toBeUndefined();
    expect(state.members.get("bob")).toBe("read");
  });
});

describe("control state as a set of operations (CTL-22 to CTL-25)", () => {
  it("decides 0031's cases: concurrent → narrower, informed → the later decision, even wider", () => {
    const laptop: Device = {
      tag: "L".repeat(22),
      state: new ControlState(),
      seenIds: new Set(),
      counter: 0,
    };
    const tablet: Device = {
      tag: "T".repeat(22),
      state: new ControlState(),
      seenIds: new Set(),
      counter: 0,
    };
    const issued: Issued[] = [];
    const first = issue(laptop, issued, "member:carol", "write");
    deliver(tablet, first);
    // The laptop decides another member, then Carol; the tablet, without either, decides Carol.
    issue(laptop, issued, "member:bob", "read");
    const wide = issue(laptop, issued, "member:carol", "write");
    const narrow = issue(tablet, issued, "member:carol", "read");
    const bob = new ControlState();
    for (const entry of issued) {
      bob.add(entry.op);
    }
    expect(bob.members.get("carol")).toBe("read");
    // Once the tablet has seen the laptop's decision, its wider choice stands everywhere.
    deliver(tablet, wide);
    const informed = issue(tablet, issued, "member:carol", "write");
    bob.add(informed.op);
    expect(bob.members.get("carol")).toBe("write");
    expect(narrow.op.seen).toEqual({ [laptop.tag]: 1 });
  });

  it("keeps the close for good and the pace as the longest interval among concurrent ones", () => {
    const state = new ControlState();
    state.add({ device: "A".repeat(22), counter: 1, target: "pace", value: 2000, seen: {} });
    state.add({ device: "B".repeat(22), counter: 1, target: "pace", value: 5000, seen: {} });
    expect(state.pace).toBe(5000);
    state.add({
      device: "A".repeat(22),
      counter: 2,
      target: "pace",
      value: 1000,
      seen: { ["B".repeat(22)]: 1 },
    });
    expect(state.pace).toBe(1000);
    state.add({ device: "B".repeat(22), counter: 2, target: "close", value: true, seen: {} });
    expect(state.closed).toBe(true);
    expect(ControlState.from(state.snapshot()).closed).toBe(true);
  });

  it("random histories: order, duplicates, partial snapshots and late operations give the same state; never wider than the oracle", () => {
    const tally = {
      histories: 0,
      concurrent: 0,
      narrowerThanTruth: 0,
      predecessorsMiss: 0,
      maxHeads: 0,
      maxPredecessorIds: 0,
    };
    for (const count of [2, 3]) {
      for (let seed = 1; seed <= 1500; seed++) {
        const g = generator(seed * 7 + count);
        const devices: Device[] = Array.from({ length: count }, (_, i) => ({
          tag: String.fromCharCode(65 + i).repeat(22),
          state: new ControlState(),
          seenIds: new Set<number>(),
          counter: 0,
        }));
        const issued: Issued[] = [];
        const snapshots: ReturnType<ControlState["snapshot"]>[] = [];
        for (let step = 0; step < 4 + Math.floor(g.random() * 16); step++) {
          const device = g.pick(devices);
          const roll = g.random();
          if (roll < 0.45) {
            issue(device, issued, g.pick(TARGETS), g.pick(RIGHTS));
          } else if (roll < 0.9) {
            const missing = issued.filter((x) => !device.seenIds.has(x.id));
            if (missing.length > 0) {
              deliver(device, g.pick(missing));
            }
          } else {
            snapshots.push(device.state.snapshot());
          }
        }
        if (issued.length === 0) {
          continue;
        }
        tally.histories++;
        // A member hears some operations and snapshots in any order, with duplicates, then the rest.
        const member = new ControlState();
        const first = g
          .shuffle([...issued, ...issued.slice(0, 2)])
          .slice(0, Math.floor(g.random() * issued.length));
        const items: (Issued | ReturnType<ControlState["snapshot"]>)[] = g.shuffle([
          ...first,
          ...snapshots,
        ]);
        for (const item of items) {
          if ("op" in item) {
            member.add(item.op);
          } else {
            member.merge(item);
          }
        }
        for (const entry of g.shuffle(issued)) {
          member.add(entry.op);
        }
        // Another member gets everything through one device's final snapshot plus the rest.
        const relayed = ControlState.from(g.pick(devices).state.snapshot());
        for (const entry of g.shuffle(issued)) {
          relayed.add(entry.op);
        }
        for (const target of TARGETS) {
          const expected = byVector(issued, target);
          if (!issued.some((x) => x.op.target === target)) {
            continue;
          }
          expect(rightOf(member, target), `seed ${seed}, ${count} devices, ${target}`).toBe(
            expected ?? null,
          );
          expect(rightOf(relayed, target), `seed ${seed}, relayed, ${target}`).toBe(
            expected ?? null,
          );
          const real = truth(issued, target);
          expect(order(expected)).toBeLessThanOrEqual(order(real));
          const on = issued.filter((x) => x.op.target === target);
          if (on.filter((x) => !on.some((p) => p.knew.has(x.id))).length > 1) {
            tally.concurrent++;
            if (order(expected) < order(real)) {
              tally.narrowerThanTruth++;
            }
          }
          if (byPredecessors(issued, target) !== real) {
            tally.predecessorsMiss++;
          }
          // What (c) must keep to judge a late operation: every id some decision named as replaced.
          tally.maxPredecessorIds = Math.max(
            tally.maxPredecessorIds,
            new Set(on.flatMap((x) => x.pred)).size,
          );
        }
        for (const target of Object.values(member.snapshot().targets)) {
          tally.maxHeads = Math.max(tally.maxHeads, target.heads.length);
          expect(target.heads.length).toBeLessThanOrEqual(count);
        }
      }
    }
    console.log("control-state property test", tally);
    expect(tally.predecessorsMiss).toBe(0);
  });

  it("reports two different operations under one (device, counter) and merges them into one, the narrowest (CTL-24)", () => {
    const state = new ControlState();
    const tag = "R".repeat(22);
    const other = "S".repeat(22);
    state.add({ device: tag, counter: 1, target: "member:bob", value: "write", seen: {} });
    state.add({ device: tag, counter: 1, target: "member:bob", value: "write", seen: {} });
    expect(state.anomalies).toEqual([]);
    state.add({
      device: tag,
      counter: 1,
      target: "member:bob",
      value: "read",
      seen: { [other]: 2 },
    });
    expect(state.anomalies).toEqual([{ device: tag, counter: 1 }]);
    expect(state.members.get("bob")).toBe("read");
    expect(state.snapshot().targets["member:bob"]?.heads).toEqual([
      { device: tag, counter: 1, value: "read", seen: { [other]: 2 } },
    ]);
  });

  it("keeps one head per device and counter however many variants arrive, in any order (CTL-24, §7.5)", () => {
    const tag = "P".repeat(22);
    const variants = Array.from({ length: 70 }, (_, n) => ({
      device: tag,
      counter: 1,
      target: "pace" as ControlTarget,
      value: n,
      seen: {},
    }));
    const forward = new ControlState();
    for (const variant of variants) forward.add(variant);
    const backward = new ControlState();
    for (const variant of [...variants].reverse()) backward.add(variant);
    expect(forward.snapshot().targets.pace?.heads).toHaveLength(1);
    expect(forward.pace).toBe(69); // the longest interval, as keeping all would give
    expect(backward.snapshot()).toEqual(forward.snapshot());
    // A snapshot that still carries both merges into one as well.
    const fromSnapshot = new ControlState();
    fromSnapshot.merge({
      vector: { [tag]: 1 },
      targets: {
        "member:bob": {
          seen: {},
          heads: [
            { device: tag, counter: 1, value: "write", seen: {} },
            { device: tag, counter: 1, value: null, seen: {} },
          ],
        },
      },
    });
    expect(fromSnapshot.snapshot().targets["member:bob"]?.heads).toEqual([
      { device: tag, counter: 1, value: null, seen: {} },
    ]);
  });

  it("takes the operation that fills a hole even with 1 024 counters above it, and still bounds the rest (CTL-30)", () => {
    const tag = "A".repeat(22);
    const op = (counter: number) => ({
      device: tag,
      counter,
      target: "member:bob" as ControlTarget,
      value: "write" as const,
      seen: {},
    });
    const state = new ControlState();
    for (let counter = 2; counter <= 1025; counter++) expect(state.add(op(counter))).toBe("added");
    expect(state.add(op(1027))).toBe("refused"); // the bound still holds above the hole
    expect(state.add(op(1))).toBe("added"); // the one that fills it
    expect(state.vector).toEqual({ [tag]: 1025 });
    expect(state.hasHoles).toBe(false);
  });

  it("at the bound on devices keeps the first 64 tags in code point order, whatever the order of arrival (CTL-30, CTL-35)", () => {
    const tags = Array.from({ length: 70 }, (_, i) => `T${String(i).padStart(21, "0")}`);
    const op = (device: string) => ({
      device,
      counter: 1,
      target: `member:${device}` as ControlTarget,
      value: "read" as const,
      seen: {},
    });
    const g = generator(7);
    const orders = [tags, [...tags].reverse(), g.shuffle(tags), g.shuffle(tags)];
    const states = orders.map((order) => {
      const state = new ControlState();
      for (const tag of order) state.add(op(tag));
      return state;
    });
    for (const state of states) {
      expect(Object.keys(state.vector).sort()).toEqual(tags.slice(0, 64));
      expect(state.snapshot()).toEqual(states[0]?.snapshot());
    }
    // Snapshots merged in either order agree too.
    const a = new ControlState();
    for (const tag of tags.slice(0, 40)) a.add(op(tag));
    const b = new ControlState();
    for (const tag of tags.slice(30)) b.add(op(tag));
    const ab = ControlState.from(a.snapshot());
    expect(ab.merge(b.snapshot())).toBeGreaterThan(0);
    const ba = ControlState.from(b.snapshot());
    ba.merge(a.snapshot());
    expect(ab.snapshot()).toEqual(ba.snapshot());
    expect(Object.keys(ab.vector).sort()).toEqual(tags.slice(0, 64));
  });

  it("at the bound on targets keeps the close, the pace and the first members in code point order (CTL-30, CTL-35)", () => {
    const tag = "M".repeat(22);
    const names = Array.from(
      { length: 5_004 },
      (_, i) => `member:m${String(i).padStart(5, "0")}` as ControlTarget,
    );
    const run = (order: readonly ControlTarget[]) => {
      const state = new ControlState();
      let counter = 0;
      for (const target of order)
        state.add({ device: tag, counter: ++counter, target, value: "read", seen: {} });
      state.add({ device: tag, counter: ++counter, target: "pace", value: 1000, seen: {} });
      state.add({ device: tag, counter: ++counter, target: "close", value: true, seen: {} });
      return state;
    };
    const forward = run(names);
    const backward = run([...names].reverse());
    expect(forward.closed).toBe(true);
    expect(forward.pace).toBe(1000);
    expect(Object.keys(forward.snapshot().targets)).toHaveLength(5_002);
    expect([...forward.members.keys()].sort()).toEqual([...backward.members.keys()].sort());
    expect(forward.members.has("m05003")).toBe(false);
  });

  it("holds at most the bytes it is given as a snapshot carries them, and refuses a snapshot that would go over as a whole (CTL-30)", () => {
    const tag = "B".repeat(22);
    const op = (n: number) => ({
      device: tag,
      counter: n,
      target: `member:@${String(n).padStart(250, "x")}` as ControlTarget,
      value: "read" as const,
      seen: {},
    });
    // 1 MiB here, which the bound on targets does not reach first with ids of 255 bytes.
    const state = new ControlState({ maxBytes: MAX_ISSUE_BYTES });
    let counter = 0;
    while (state.add(op(counter + 1)) === "added") counter += 1;
    expect(counter).toBeGreaterThan(2_000); // hundreds of members even with ids of 255 bytes
    expect(state.bytes).toBeLessThanOrEqual(MAX_ISSUE_BYTES);
    expect(new TextEncoder().encode(JSON.stringify(state.snapshot())).length).toBe(state.bytes);
    // A snapshot that would bring another state over the bound changes nothing in it.
    const third = new ControlState({ maxBytes: MAX_ISSUE_BYTES });
    for (let n = 1; n <= 40; n++)
      third.add({
        device: "D".repeat(22),
        counter: n,
        target: `member:@${String(n).padStart(250, "y")}` as ControlTarget,
        value: "read",
        seen: {},
      });
    expect(third.merge(state.snapshot())).toBeGreaterThan(0);
    expect(third.bytes).toBeLessThanOrEqual(MAX_ISSUE_BYTES);
    expect(Object.keys(third.snapshot().targets)).toHaveLength(40);
  });

  it("names holes and what another vector holds beyond this one (LOS-10, RSY-16)", () => {
    const state = new ControlState();
    const tag = "H".repeat(22);
    state.add({ device: tag, counter: 2, target: "member:bob", value: "read", seen: {} });
    expect(state.hasHoles).toBe(true);
    expect(state.vector).toEqual({});
    state.add({ device: tag, counter: 1, target: "member:carol", value: "read", seen: {} });
    expect(state.hasHoles).toBe(false);
    expect(state.vector).toEqual({ [tag]: 2 });
    expect(state.lacksAnyOf({ [tag]: 3 })).toBe(true);
    expect(state.hasAnyBeyond({ [tag]: 1 })).toBe(true);
    expect(state.hasAnyBeyond(null)).toBe(true);
    expect(state.hasAnyBeyond({ [tag]: 2 })).toBe(false);
  });

  it("makes device tags of 22 base64url characters", () => {
    const tags = new Set(Array.from({ length: 50 }, () => newDeviceTag()));
    expect(tags.size).toBe(50);
    for (const tag of tags) {
      expect(tag).toMatch(DEVICE_TAG);
    }
  });
});

describe("a snapshot merges as a union of operations, whatever its vector names (CTL-23, CTL-25)", () => {
  const A = "A".repeat(22);
  const B = "B".repeat(22);
  const X = "X".repeat(22);

  it("keeps what a target had seen of a device the vector does not name: a late operation stays superseded", () => {
    // B granted carol `write` having seen X:1, which revoked her; B never held X:1 itself (a report, CTL-27).
    const x1: ControlOperation = {
      device: X,
      counter: 1,
      target: "member:carol",
      value: null,
      seen: {},
    };
    const b1: ControlOperation = {
      device: B,
      counter: 1,
      target: "member:carol",
      value: "write",
      seen: { [X]: 1 },
    };
    const frames = new ControlState();
    frames.add(b1);
    frames.add(x1);
    const responder = new ControlState();
    responder.add(b1);
    const joiner = ControlState.from(responder.snapshot());
    joiner.add(x1);
    expect(frames.members.get("carol")).toBe("write");
    expect(joiner.members.get("carol")).toBe("write");
    expect(joiner.snapshot()).toEqual(frames.snapshot());
  });

  it("keeps a head of a device held only above a hole, counts it as held there, and reports nothing as refused", () => {
    const a1: ControlOperation = {
      device: A,
      counter: 1,
      target: "member:carol",
      value: "write",
      seen: {},
    };
    const x2: ControlOperation = {
      device: X,
      counter: 2,
      target: "member:carol",
      value: null,
      seen: {},
    };
    const responder = new ControlState();
    responder.add(a1);
    responder.add(x2); // X:1 never arrived: X has a hole, and the vector names X not at all
    expect(responder.vector).toEqual({ [A]: 1 });
    const receiver = new ControlState();
    receiver.add(a1);
    expect(receiver.merge(responder.snapshot())).toBe(0);
    expect(receiver.members.has("carol")).toBe(false); // the narrower of two concurrent decisions
    expect(receiver.hasHoles).toBe(true);
    expect(receiver.vector).toEqual(responder.vector);
    expect(receiver.snapshot()).toEqual(responder.snapshot());
  });

  it("a restored state still has the holes it had (CTL-41, LOS-10)", () => {
    const state = new ControlState();
    state.add({ device: A, counter: 1, target: "member:bob", value: "write", seen: {} });
    state.add({ device: A, counter: 3, target: "member:carol", value: "write", seen: {} }); // A:2 lost
    expect(state.hasHoles).toBe(true);
    const restored = ControlState.from(state.snapshot());
    expect(restored.hasHoles).toBe(true);
    expect(restored.vector).toEqual(state.vector);
    restored.add({ device: A, counter: 2, target: "member:dave", value: "read", seen: {} });
    expect(restored.hasHoles).toBe(false);
    expect(restored.vector).toEqual({ [A]: 3 });
  });

  it("restores a device held only by a late operation above its hole: the target, its right and the hole", () => {
    // Only counter 2 of a device arrived, Bob=read; its predecessor is late.
    const state = new ControlState();
    state.add({ device: X, counter: 2, target: "member:bob", value: "read", seen: {} });
    const snapshot = state.snapshot();
    expect(snapshot.vector).toEqual({});
    expect(snapshot.targets["member:bob"]?.heads).toHaveLength(1);
    const restored = ControlState.from(snapshot);
    expect(restored.members.get("bob")).toBe("read");
    expect(restored.hasHoles).toBe(true);
    expect(restored.snapshot()).toEqual(snapshot);
    const other = new ControlState();
    other.add({ device: A, counter: 1, target: "member:carol", value: "write", seen: {} });
    const merged = ControlState.from(other.snapshot());
    expect(merged.merge(snapshot)).toBe(0);
    const applied = ControlState.from(other.snapshot());
    applied.add({ device: X, counter: 2, target: "member:bob", value: "read", seen: {} });
    expect(merged.snapshot()).toEqual(applied.snapshot());
    expect(merged.hasHoles).toBe(true);
    // The late predecessor fills the hole the same way everywhere.
    for (const s of [state, restored, merged]) {
      s.add({ device: X, counter: 1, target: "member:dave", value: "read", seen: {} });
      expect(s.hasHoles).toBe(false);
      expect(s.vector[X]).toBe(2);
    }
  });

  it("random histories: applying, restoring the snapshot and merging it into another state give one state", () => {
    const tally = { states: 0, merges: 0, supersededAboveHole: 0 };
    for (const count of [2, 3]) {
      for (let seed = 1; seed <= 1500; seed++) {
        const g = generator(seed * 17 + count);
        const devices: Device[] = Array.from({ length: count }, (_, i) => ({
          tag: String.fromCharCode(65 + i).repeat(22),
          state: new ControlState(),
          seenIds: new Set<number>(),
          counter: 0,
        }));
        const issued: Issued[] = [];
        for (let step = 0; step < 4 + Math.floor(g.random() * 16); step++) {
          const device = g.pick(devices);
          if (g.random() < 0.5) {
            issue(device, issued, g.pick(TARGETS), g.pick(RIGHTS));
          } else {
            const missing = issued.filter((x) => !device.seenIds.has(x.id));
            if (missing.length > 0) deliver(device, g.pick(missing));
          }
        }
        // A receiver that heard some of the operations, in any order: holes are likely.
        const applied = new ControlState();
        const heard = g.shuffle(issued).slice(0, Math.floor(g.random() * (issued.length + 1)));
        for (const entry of heard) applied.add(entry.op);
        const snapshot = applied.snapshot();
        // The case no head carries: an operation held above a hole that something superseded. The
        // snapshot's counters above holes carry it (§7.5).
        const heads = new Set(
          Object.values(snapshot.targets).flatMap((t) =>
            t.heads.map((h) => `${h.device}:${h.counter}`),
          ),
        );
        const onlyAboveHoles = heard.some(
          (x) =>
            x.op.counter > (snapshot.vector[x.op.device] ?? 0) &&
            !heads.has(`${x.op.device}:${x.op.counter}`),
        );
        tally.states += 1;
        if (onlyAboveHoles) tally.supersededAboveHole += 1;
        const restored = ControlState.from(snapshot);
        expect(restored.snapshot(), `seed ${seed}`).toEqual(snapshot);
        expect(restored.hasHoles, `seed ${seed}`).toBe(applied.hasHoles);
        expect(restored.vector, `seed ${seed}`).toEqual(applied.vector);
        // Merged into another device's state, and the same operations applied to it.
        const other = g.pick(devices).state;
        const merged = ControlState.from(other.snapshot());
        expect(merged.merge(snapshot), `seed ${seed}`).toBe(0);
        const both = ControlState.from(other.snapshot());
        for (const entry of heard) both.add(entry.op);
        tally.merges += 1;
        expect(merged.snapshot(), `seed ${seed}`).toEqual(both.snapshot());
        for (const target of TARGETS) {
          expect(rightOf(merged, target), `seed ${seed}, ${target}`).toBe(rightOf(both, target));
        }
        expect(merged.vector, `seed ${seed}`).toEqual(both.vector);
        expect(merged.hasHoles, `seed ${seed}`).toBe(both.hasHoles);
        // The late predecessors fill the holes the same way, restored or not.
        const late = heard.length === issued.length ? [] : issued.filter((x) => !heard.includes(x));
        for (const entry of late) {
          applied.add(entry.op);
          restored.add(entry.op);
        }
        expect(restored.snapshot(), `seed ${seed}`).toEqual(applied.snapshot());
      }
    }
    // The generated histories include the case only the counters above holes carry.
    expect(tally.supersededAboveHole).toBeGreaterThan(0);
  });

  it("counts its counters above holes in its bytes, in RFC 8785 form beside vector and targets (CTL-34)", () => {
    const state = new ControlState();
    state.add({ device: X, counter: 3, target: "member:bob", value: "write", seen: {} });
    const expected = `{"aboveHoles":{"${X}":[3]},"targets":{"member:bob":{"heads":[{"counter":3,"device":"${X}","seen":{},"value":"write"}],"seen":{"${X}":2}}},"vector":{}}`;
    expect(canonicalJson(state.snapshot())).toBe(expected);
    expect(state.bytes).toBe(new TextEncoder().encode(expected).length);
    // A device known only above a hole is absent from the vector, never named with 0 (FRM-14), and
    // a snapshot naming it with 0 merges as one that does not.
    const zero = ControlState.from({ ...state.snapshot(), vector: { [X]: 0 } });
    expect(zero.snapshot()).toEqual(state.snapshot());
  });

  it("restores a counter held above a hole that something superseded, and with it the hole (§7.5)", () => {
    // X:1 never arrived; X:3 was superseded by Y:1, which had seen it; the snapshot's heads carry
    // Y:1 only, so only its counters above holes say X:3 is held.
    const Y = "Y".repeat(22);
    const state = new ControlState();
    state.add({ device: X, counter: 2, target: "member:dave", value: "read", seen: {} });
    state.add({ device: X, counter: 3, target: "member:bob", value: "write", seen: {} });
    state.add({ device: Y, counter: 1, target: "member:bob", value: "read", seen: { [X]: 3 } });
    const snapshot = state.snapshot();
    expect(snapshot.targets["member:bob"]?.heads.map((head) => head.device)).toEqual([Y]);
    expect(snapshot.aboveHoles).toEqual({ [X]: [2, 3] });
    const restored = ControlState.from(snapshot);
    expect(restored.hasHoles).toBe(true);
    for (const s of [state, restored]) {
      s.add({ device: X, counter: 1, target: "member:carol", value: "read", seen: {} });
      expect(s.hasHoles).toBe(false);
      expect(s.vector[X]).toBe(3);
    }
    expect(restored.snapshot()).toEqual(state.snapshot());
    expect(state.snapshot().aboveHoles).toBeUndefined();
  });

  it("random histories: a device's snapshot plus only what that device lacked gives what every operation as a frame gives", () => {
    for (const count of [2, 3]) {
      for (let seed = 1; seed <= 1500; seed++) {
        const g = generator(seed * 13 + count);
        const devices: Device[] = Array.from({ length: count }, (_, i) => ({
          tag: String.fromCharCode(65 + i).repeat(22),
          state: new ControlState(),
          seenIds: new Set<number>(),
          counter: 0,
        }));
        const issued: Issued[] = [];
        for (let step = 0; step < 4 + Math.floor(g.random() * 16); step++) {
          const device = g.pick(devices);
          if (g.random() < 0.5) {
            issue(device, issued, g.pick(TARGETS), g.pick(RIGHTS));
          } else {
            const missing = issued.filter((x) => !device.seenIds.has(x.id));
            if (missing.length > 0) deliver(device, g.pick(missing));
          }
        }
        if (issued.length === 0) continue;
        const frames = new ControlState();
        for (const entry of g.shuffle(issued)) frames.add(entry.op);
        // A history-less joiner: the snapshot of one device, then only the operations it lacked.
        const responder = g.pick(devices);
        const joiner = ControlState.from(responder.state.snapshot());
        for (const entry of g.shuffle(issued.filter((x) => !responder.seenIds.has(x.id))))
          joiner.add(entry.op);
        for (const target of TARGETS) {
          expect(rightOf(joiner, target), `seed ${seed}, ${count} devices, ${target}`).toBe(
            rightOf(frames, target),
          );
        }
        // A snapshot leaves out superseded operations, so the joiner may count fewer without a gap —
        // never more than it holds.
        for (const [device, counter] of Object.entries(joiner.vector)) {
          expect(counter, `seed ${seed}, ${device}`).toBeLessThanOrEqual(
            frames.vector[device] ?? 0,
          );
        }
      }
    }
  });
});

describe("collisions among operations a snapshot or a restore brought (CTL-24, CTL-31)", () => {
  const D = "D".repeat(22);
  const write: ControlOperation = {
    device: D,
    counter: 1,
    target: "member:bob",
    value: "write",
    seen: {},
  };
  const revoke: ControlOperation = {
    device: D,
    counter: 1,
    target: "member:bob",
    value: null,
    seen: {},
  };
  const holding = (...ops: ControlOperation[]) => {
    const state = new ControlState();
    for (const op of ops) state.add(op);
    return state;
  };

  it("notes one between an operation taken from a snapshot and one that arrives as a frame", () => {
    const state = ControlState.from(holding(write).snapshot());
    expect(state.add(revoke)).toBe("added");
    expect(state.anomalies).toEqual([{ device: D, counter: 1 }]);
    expect(state.members.has("bob")).toBe(false); // the narrowest of the two
  });

  it("notes one that a snapshot brings against an operation already held", () => {
    const state = holding(write);
    state.merge(holding(revoke).snapshot());
    expect(state.anomalies).toEqual([{ device: D, counter: 1 }]);
    expect(state.members.has("bob")).toBe(false);
  });

  it("finds one in a member's report against a restored state", () => {
    const restored = ControlState.from(holding(write).snapshot());
    expect(restored.noteCollisionsIn(holding(revoke).snapshot())).toEqual([
      { device: D, counter: 1 },
    ]);
  });

  it("takes an operation already held through a snapshot again as a duplicate (TRN-8)", () => {
    const state = ControlState.from(holding(write).snapshot());
    expect(state.add(write)).toBe("duplicate");
    expect(state.anomalies).toEqual([]);
  });
});

describe("the close at the bound on creator devices (CTL-36, LIF-7)", () => {
  const tags = Array.from({ length: 64 }, (_, i) => `T${String(i).padStart(21, "0")}`);
  const last = "z".repeat(22); // after every tag above in code point order
  const close: ControlOperation = {
    device: last,
    counter: 3,
    target: "close",
    value: true,
    seen: {},
  };
  const pace = (device: string): ControlOperation => ({
    device,
    counter: 1,
    target: "pace",
    value: 0,
    seen: {},
  });

  it("keeps the close of a device the bound gives up, and every joiner of that state learns it is closed", () => {
    const state = new ControlState();
    state.add(close);
    for (const tag of tags) state.add(pace(tag)); // pushes the closing device out
    expect(state.vector[last]).toBeUndefined();
    expect(state.closed).toBe(true);
    expect(state.snapshot().targets.close?.heads).toEqual([
      { device: last, counter: 3, value: true, seen: {} },
    ]);
    expect(ControlState.from(state.snapshot()).closed).toBe(true);
  });

  it("holds the close of a device the bound refuses, the same in either order of arrival", () => {
    const first = new ControlState();
    first.add(close);
    for (const tag of tags) first.add(pace(tag));
    const later = new ControlState();
    for (const tag of tags) later.add(pace(tag));
    expect(later.add(close)).toBe("added");
    expect(later.closed).toBe(true);
    expect(later.snapshot()).toEqual(first.snapshot());
  });

  it("reads a close entry as closed, whatever its heads", () => {
    const state = new ControlState();
    state.merge({ vector: {}, targets: { close: { seen: {}, heads: [] } } });
    expect(state.closed).toBe(true);
    expect(ControlState.from(state.snapshot()).closed).toBe(true);
  });
});

describe("capacity: a union within the bytes converges, one beyond them is a named conflict (CTL-30, CTL-32)", () => {
  const A = "A".repeat(22);
  const B = "B".repeat(22);
  const C = "C".repeat(22);
  /** A snapshot near the bound: 1 600 targets of one device, each valid alone, 609 011 bytes. */
  const nearBound = (prefix: string, device: string): ControlStateSnapshot => ({
    vector: { [device]: 1600 },
    targets: Object.fromEntries(
      Array.from({ length: 1600 }, (_, i) => [
        `member:${prefix}${String(i).padStart(4, "0")}${"x".repeat(240)}`,
        {
          seen: { [device]: i },
          heads: [{ device, counter: i + 1, value: "read" as const, seen: {} }],
        },
      ]),
    ),
  });
  /**
   * A snapshot of one device of about `bytes`, with targets made large by what their operations had
   * seen of 40 other devices — so that three of them pass the bytes before the bound on targets.
   */
  const fat = (prefix: string, device: string, bytes: number): ControlStateSnapshot => {
    const padding = Object.fromEntries(
      Array.from({ length: 40 }, (_, k) => [`P${String(k).padStart(21, "0")}`, 7]),
    );
    const target = (i: number) => [
      `member:${prefix}${String(i).padStart(5, "0")}${"x".repeat(240)}`,
      {
        seen: { ...padding, [device]: i },
        heads: [{ device, counter: i + 1, value: "read" as const, seen: padding }],
      },
    ];
    const one = new ControlState({ maxBytes: ACCEPTED_CONTROL_BYTES });
    one.merge({ vector: { [device]: 1 }, targets: Object.fromEntries([target(0)]) });
    const count = Math.floor(bytes / one.bytes);
    return {
      vector: { [device]: count },
      targets: Object.fromEntries(Array.from({ length: count }, (_, i) => target(i))),
    };
  };
  const permutations = <T>(xs: readonly T[]): T[][] =>
    xs.length <= 1
      ? [[...xs]]
      : xs.flatMap((x, i) =>
          permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]),
        );

  it("two snapshots of 609 011 bytes, each valid alone, converge in every order within the 3 MiB CTL-30 holds", {
    timeout: 60_000,
  }, () => {
    const [a, b] = [nearBound("a", A), nearBound("b", B)];
    const alone = (snapshot: ControlStateSnapshot) =>
      ControlState.from(snapshot, { maxBytes: ACCEPTED_CONTROL_BYTES });
    expect(alone(a).bytes).toBe(609_011);
    expect(alone(b).bytes).toBe(609_011);
    const ab = alone(a);
    expect(ab.merge(b)).toBe(0);
    const ba = alone(b);
    expect(ba.merge(a)).toBe(0);
    expect(ab.bytes).toBeGreaterThan(MAX_ISSUE_BYTES);
    expect(ab.bytes).toBeLessThan(ACCEPTED_CONTROL_BYTES);
    expect(ab.snapshot()).toEqual(ba.snapshot());
    expect(Object.keys(ab.snapshot().targets)).toHaveLength(3_200);
    // Exchanged again, and as the operations themselves in any order: the same union.
    expect(ab.merge(a) + ab.merge(b)).toBe(0);
    const opsOf = (snapshot: ControlStateSnapshot) =>
      Object.entries(snapshot.targets).flatMap(([target, state]) =>
        state.heads.map((head) => ({ ...head, target: target as ControlTarget })),
      );
    const [fromA, fromB] = [opsOf(a), opsOf(b)];
    const frames = new ControlState({ maxBytes: ACCEPTED_CONTROL_BYTES });
    // The two devices' operations interleaved, each device's in its own order.
    for (let i = 0; i < 1600; i++) {
      frames.add(fromB[i] as ControlOperation);
      frames.add(fromA[i] as ControlOperation);
    }
    expect(frames.snapshot()).toEqual(ab.snapshot());
    for (const state of [ab, ba, frames]) expect(state.capacityConflict).toBe(false);
  });

  it.each([
    ["the 3 MiB CTL-30 sets", ACCEPTED_CONTROL_BYTES],
    ["1 MiB", MAX_ISSUE_BYTES],
  ])(
    "beyond %s, three snapshots each valid alone: any two converge, all three are a conflict in every order",
    { timeout: 60_000 },
    (_name, maxBytes) => {
      const snapshots = [
        fat("a", A, maxBytes * 0.4),
        fat("b", B, maxBytes * 0.4),
        fat("c", C, maxBytes * 0.4),
      ];
      for (const [x, y] of [
        [0, 1],
        [1, 2],
        [0, 2],
      ] as const) {
        const xy = ControlState.from(snapshots[x] as ControlStateSnapshot, { maxBytes });
        expect(xy.merge(snapshots[y] as ControlStateSnapshot)).toBe(0);
        const yx = ControlState.from(snapshots[y] as ControlStateSnapshot, { maxBytes });
        expect(yx.merge(snapshots[x] as ControlStateSnapshot)).toBe(0);
        expect(xy.snapshot()).toEqual(yx.snapshot());
        expect(xy.capacityConflict).toBe(false);
      }
      for (const order of permutations(snapshots)) {
        const state = new ControlState({ maxBytes });
        for (const snapshot of order) state.merge(snapshot);
        expect(state.capacityConflict).toBe(true);
        expect(state.bytes).toBeLessThanOrEqual(maxBytes);
      }
    },
  );

  it("enters the conflict by an operation over its bytes, and keeps it", () => {
    const state = new ControlState({ maxBytes: 4_000 });
    let counter = 0;
    while (
      state.add({
        device: A,
        counter: counter + 1,
        target: `member:m${String(counter + 1).padStart(40, "0")}` as ControlTarget,
        value: "write",
        seen: {},
      }) === "added"
    ) {
      counter += 1;
    }
    expect(counter).toBeGreaterThan(10);
    expect(state.capacityConflict).toBe(true);
    expect(state.bytes).toBeLessThanOrEqual(4_000);
    expect(ControlState.from(state.snapshot()).capacityConflict).toBe(false); // a snapshot carries rights, not a conflict
  });

  it("in a conflict takes no new member or layer right, and still the close, the pace and changes of what it holds", () => {
    const state = new ControlState();
    const op = (counter: number, target: string, value: unknown): ControlOperation => ({
      device: A,
      counter,
      target: target as ControlTarget,
      value: value as "read",
      seen: {},
    });
    const held = "member:bob";
    state.add(op(1, held, "write"));
    state.markCapacityConflict();
    expect(state.add(op(2, "member:new", "read"))).toBe("refused");
    expect(state.add(op(2, "layer:com.example.comments/1:member:new", "read"))).toBe("refused");
    expect(state.add(op(2, held, null))).toBe("added");
    expect(state.revoked.has("bob")).toBe(true);
    expect(state.add(op(3, "pace", 30_000))).toBe("added");
    expect(state.add(op(4, "close", true))).toBe("added");
    expect(state.closed).toBe(true);
    // Merging a snapshot takes what it holds, and leaves new targets out.
    const other = new ControlState();
    other.add({ device: B, counter: 1, target: held as ControlTarget, value: "read", seen: {} });
    other.add({ device: B, counter: 2, target: "member:another", value: "read", seen: {} });
    expect(state.merge(other.snapshot())).toBe(1);
    expect(state.holds("member:another")).toBe(false);
    expect(
      state
        .snapshot()
        .targets[held]?.heads.map((head) => head.device)
        .sort(),
    ).toEqual([A, B]);
  });

  it("issues a new target only up to 1 MiB, and the close and changes of held targets up to the bytes it holds (KZ-16)", {
    timeout: 60_000,
  }, () => {
    const op = (counter: number, target: string, value: unknown): ControlOperation => ({
      device: A,
      counter,
      target: target as ControlTarget,
      value: value as "read",
      seen: {},
    });
    let state = new ControlState({ maxBytes: ACCEPTED_CONTROL_BYTES });
    let counter = 0;
    // Near 1 MiB by adding, then issuing up to the bound.
    while (counter % 100 !== 0 || state.bytes < MAX_ISSUE_BYTES - 5_000) {
      counter += 1;
      state.add(op(counter, `member:@${String(counter).padStart(250, "x")}`, "read"));
    }
    for (;;) {
      const issued = state.issue(
        op(counter + 1, `member:@${String(counter + 1).padStart(250, "x")}`, "read"),
      );
      if ("refused" in issued) {
        expect(issued.refused).toBe("too-large");
        break;
      }
      state = issued.next;
      counter += 1;
    }
    expect(state.bytes).toBeLessThanOrEqual(MAX_ISSUE_BYTES);
    expect(state.bytes).toBeGreaterThan(MAX_ISSUE_BYTES - 1_000);
    // Another device's operations bring it over 1 MiB, within what it holds.
    const other = new ControlState({ maxBytes: ACCEPTED_CONTROL_BYTES });
    for (let n = 1; n <= 1_000; n++)
      other.add({
        device: B,
        counter: n,
        target: `member:@${String(n).padStart(250, "y")}` as ControlTarget,
        value: "write",
        seen: {},
      });
    expect(state.merge(other.snapshot())).toBe(0);
    expect(state.bytes).toBeGreaterThan(MAX_ISSUE_BYTES);
    // Over 1 MiB: no new member, but a revocation of a held one, and the close.
    expect("refused" in state.issue(op(counter + 1, "member:newcomer", "read"))).toBe(true);
    const revoked = state.issue(op(counter + 1, `member:@${String(1).padStart(250, "y")}`, null));
    expect("next" in revoked).toBe(true);
    const closed = state.issue(op(counter + 1, "close", true));
    expect("next" in closed && closed.next.closed).toBe(true);
  });

  it("issues no new member or layer right in a conflict, and says so", () => {
    const state = new ControlState();
    state.add({ device: A, counter: 1, target: "member:bob", value: "write", seen: {} });
    state.markCapacityConflict();
    expect(
      state.issue({ device: A, counter: 2, target: "member:carol", value: "read", seen: {} }),
    ).toEqual({ refused: "capacity-conflict" });
    expect(
      state.issue({
        device: A,
        counter: 2,
        target: "layer:com.example.comments/1:member:bob",
        value: "read",
        seen: {},
      }),
    ).toEqual({ refused: "capacity-conflict" });
    expect(
      "next" in state.issue({ device: A, counter: 2, target: "member:bob", value: null, seen: {} }),
    ).toBe(true);
  });
});

describe("what a state keeps of collisions over its life (CTL-24, CTL-31)", () => {
  const D = "D".repeat(22);
  const E = "E".repeat(22);

  it("notes a collision only against operations it holds as heads, the same live and restored", () => {
    const live = new ControlState();
    live.add({ device: D, counter: 1, target: "member:bob", value: "write", seen: {} });
    live.add({ device: E, counter: 1, target: "member:bob", value: "read", seen: { [D]: 1 } }); // supersedes D:1
    const restored = ControlState.from(live.snapshot());
    // Another operation under D:1 now changes nothing on its target: superseded there, as D:1 is.
    const other = {
      device: D,
      counter: 1,
      target: "member:bob" as ControlTarget,
      value: null,
      seen: {},
    };
    for (const state of [live, restored]) {
      expect(state.add(other)).toBe("duplicate");
      expect(state.anomalies).toEqual([]);
    }
    expect(live.snapshot()).toEqual(restored.snapshot());
  });

  it("forgets a collision once a later decision supersedes its place, so the record stays bounded", () => {
    const state = new ControlState();
    state.add({ device: D, counter: 1, target: "member:bob", value: "write", seen: {} });
    state.add({ device: D, counter: 1, target: "member:bob", value: "read", seen: {} });
    expect(state.anomalies).toEqual([{ device: D, counter: 1 }]);
    state.add({ device: E, counter: 1, target: "member:bob", value: "write", seen: { [D]: 1 } });
    expect(state.anomalies).toEqual([]);
    expect(state.members.get("bob")).toBe("write");
    // Deciding one target again and again leaves one head, and one place recorded.
    for (let n = 2; n <= 2_000; n++)
      state.add({
        device: E,
        counter: n,
        target: "member:bob",
        value: n % 2 === 0 ? "read" : "write",
        seen: { [D]: 1 },
      });
    expect(state.snapshot().targets["member:bob"]?.heads).toHaveLength(1);
    const restored = ControlState.from(state.snapshot());
    expect(
      restored.add({ device: E, counter: 1_000, target: "member:bob", value: null, seen: {} }),
    ).toBe("duplicate");
  });
});
