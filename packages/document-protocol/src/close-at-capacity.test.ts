import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import { describe, expect, it } from "vitest";
import {
  type ControlOperation,
  ControlState,
  type ControlStateSnapshot,
  MAX_CONTROL_BYTES,
  MAX_COUNTERS_AHEAD,
  MAX_ISSUE_BYTES,
} from "./control-state";
import { canonicalJson } from "./digest";
import { DocumentEngine, SendRefusedError } from "./index";

/**
 * A full document can always be closed (SPECIFICATION.md CTL-34, CTL-36, CTL-37, LIF-6, LIF-7): the
 * close is not measured against the bytes of control state, so neither issuing nor receiving it
 * fails at the bound — directly below it and at it, from a device of the creator that has only just
 * joined, in a capacity conflict, after operations on the targets held used the room up, and in a
 * snapshot, restored or handed to a later joiner, whose own bytes the receiver refuses. The
 * acceptance cases of a review of the draft.
 */

const DEVICE = "X".repeat(22);
const FRESH = "F".repeat(22);
const OTHER = "Y".repeat(22);
/** What the operations had seen of 40 other devices: it makes each target about 2 300 bytes. */
const SEEN = Object.fromEntries(
  Array.from({ length: 40 }, (_, k) => [`P${String(k).padStart(21, "0")}`, 7]),
);

const measure = (snapshot: object) => Buffer.byteLength(canonicalJson(snapshot));

/** The devices whose grants a fixture holds: the first adds the targets, the others change them. */
const DEVICES = [DEVICE, OTHER, ..."ZWVUT".split("").map((letter) => letter.repeat(22))];

/**
 * A snapshot of grants without holes, of exactly `bytes` as CTL-34 measures it — the fixture of the
 * review, from member names padded to the byte. Each target holds a grant of the first `heads`
 * devices, made concurrently: with more than one, operations on the targets held fill the bytes.
 * Measured as it grows, an entry at a time, and once whole at the end.
 */
function snapshotOf(bytes: number, heads = 1): ControlStateSnapshot {
  const devices = DEVICES.slice(0, heads);
  const entries: [string, ControlStateSnapshot["targets"][string]][] = [];
  const vectorOf = (count: number) => Object.fromEntries(devices.map((device) => [device, count]));
  let entryBytes = 0;
  let size = 0;
  while (size < bytes - 3000) {
    const count = entries.length + 1;
    const value: ControlStateSnapshot["targets"][string] = {
      seen: {
        ...SEEN,
        ...Object.fromEntries(
          devices.map((device) => [device, count - 1]).filter(([, n]) => (n as number) > 0),
        ),
      },
      heads: devices.map((device) => ({
        device,
        counter: count,
        value: "read" as const,
        seen: SEEN,
      })),
    };
    const key = `member:b${String(count).padStart(4, "0")}`;
    entries.push([key, value]);
    entryBytes += measure({ [key]: value }) - 2;
    // {"targets":{e1,e2,…},"vector":{…}}: the entries, a comma between two, and the rest.
    size = measure({ targets: {}, vector: vectorOf(count) }) + entryBytes + (entries.length - 1);
  }
  let remaining = bytes - size;
  if (remaining < 0) throw new Error("the fixture overshot");
  for (const entry of entries) {
    if (remaining === 0) break;
    const extra = Math.min(remaining, 240);
    entry[0] += "x".repeat(extra);
    remaining -= extra;
  }
  if (remaining !== 0) throw new Error("the fixture could not be padded to the byte");
  const snapshot = { vector: vectorOf(entries.length), targets: Object.fromEntries(entries) };
  expect(measure(snapshot)).toBe(bytes);
  return snapshot;
}

function heldAt(bytes: number, heads = 1): ControlState {
  const state = new ControlState();
  expect(state.mergeOrRefuse(snapshotOf(bytes, heads))).toEqual({ leftOut: 0, refused: false });
  expect(state.bytes).toBe(bytes);
  expect(state.capacityConflict).toBe(false);
  return state;
}

const close = (
  device: string,
  counter: number,
  seen: Record<string, number> = {},
): ControlOperation => ({
  device,
  counter,
  target: "close",
  value: true,
  seen,
});

describe("the close at the bytes of control state (CTL-34, CTL-36, CTL-37, LIF-7)", () => {
  it.each([
    ["directly below", MAX_CONTROL_BYTES - 1],
    ["at", MAX_CONTROL_BYTES],
  ])(
    "%s the bound: issued, and received, without a conflict and without adding to what is measured",
    (_, bytes) => {
      const issuer = heldAt(bytes);
      const op = close(DEVICE, (issuer.vector[DEVICE] as number) + 1);
      const issued = issuer.issue(op);
      expect("next" in issued && issued.next.closed).toBe(true);
      const receiver = heldAt(bytes);
      expect(receiver.add(op)).toBe("added");
      expect(receiver.closed).toBe(true);
      expect(receiver.capacityConflict).toBe(false);
      expect(receiver.bytes).toBe(bytes);
    },
  );

  it("from a device of the creator that has only just joined: its first counter, a new entry in the vector, is not measured", () => {
    const fresh = heldAt(MAX_CONTROL_BYTES);
    const op = close(FRESH, 1, fresh.vector);
    expect("next" in fresh.issue(op)).toBe(true);
    const receiver = heldAt(MAX_CONTROL_BYTES);
    expect(receiver.add(op)).toBe("added");
    expect(receiver.closed && !receiver.capacityConflict).toBe(true);
    expect(receiver.vector[FRESH]).toBe(1);
    expect(receiver.bytes).toBe(MAX_CONTROL_BYTES);
  });

  it("in a capacity conflict that came before it", () => {
    const receiver = heldAt(MAX_CONTROL_BYTES - 10);
    const next = (receiver.vector[DEVICE] as number) + 1;
    expect(
      receiver.add({
        device: DEVICE,
        counter: next,
        target: "member:late",
        value: "write",
        seen: SEEN,
      }),
    ).toBe("refused");
    expect(receiver.capacityConflict).toBe(true);
    expect(receiver.add(close(DEVICE, next + 1))).toBe("added");
    expect(receiver.closed).toBe(true);
    expect(receiver.capacityConflict).toBe(true);
  });

  it("restored from its snapshot, and handed to a later joiner: the same bytes, closed, no conflict", () => {
    const holder = heldAt(MAX_CONTROL_BYTES);
    expect(holder.add(close(FRESH, 1, holder.vector))).toBe("added");
    const snapshot = holder.snapshot();
    expect(measure(snapshot)).toBeGreaterThan(MAX_CONTROL_BYTES); // the close is in it, unmeasured
    const restored = ControlState.from(snapshot);
    const joiner = new ControlState();
    expect(joiner.mergeOrRefuse(snapshot).refused).toBe(false);
    for (const state of [restored, joiner]) {
      expect(state.closed).toBe(true);
      expect(state.capacityConflict).toBe(false);
      expect(state.bytes).toBe(holder.bytes);
      expect(state.snapshot()).toEqual(snapshot);
    }
  });

  it("in a snapshot refused for its own bytes: the close still holds, as one arriving alone would", () => {
    const over = snapshotOf(MAX_CONTROL_BYTES + 100);
    const closed: ControlStateSnapshot = {
      ...over,
      vector: { ...over.vector, [FRESH]: 1 },
      targets: {
        ...over.targets,
        close: { seen: {}, heads: [{ device: FRESH, counter: 1, value: true, seen: over.vector }] },
      },
    };
    const joiner = new ControlState();
    expect(joiner.mergeOrRefuse(closed).refused).toBe(true);
    expect(joiner.capacityConflict).toBe(true);
    expect(joiner.closed).toBe(true);
    expect(Object.keys(joiner.snapshot().targets)).toEqual(["close"]);
  });

  it("after operations on the targets held used up the room the issue bound left", () => {
    // What one device added is within what a device that adds targets goes to; five more devices
    // changed every target concurrently, up to the bound.
    const state = heldAt(MAX_CONTROL_BYTES, 6);
    const added = ControlState.from({
      vector: { [DEVICE]: state.vector[DEVICE] as number },
      targets: Object.fromEntries(
        Object.entries(state.snapshot().targets).map(([name, target]) => [
          name,
          { seen: target.seen, heads: target.heads.filter((head) => head.device === DEVICE) },
        ]),
      ),
    });
    expect(added.bytes).toBeLessThan(MAX_ISSUE_BYTES);
    const change: ControlOperation = {
      device: OTHER,
      counter: (state.vector[OTHER] as number) + 1,
      target: "member:b0001",
      value: "write",
      seen: SEEN,
    };
    expect("refused" in state.issue(change)).toBe(true); // no room left to change a right
    for (const device of [DEVICE, OTHER, FRESH]) {
      const op = close(device, (state.vector[device] ?? 0) + 1, state.vector);
      expect("next" in state.issue(op), device).toBe(true);
    }
    expect(state.add(close(FRESH, 1, state.vector))).toBe("added");
    expect(state.closed && !state.capacityConflict).toBe(true);
  });

  it("above more counters than the bound on a hole holds: the close, without its counter", () => {
    const state = new ControlState();
    expect(
      state.add({ device: DEVICE, counter: 1, target: "member:bob", value: "read", seen: {} }),
    ).toBe("added");
    for (let counter = 3; counter < 3 + MAX_COUNTERS_AHEAD; counter += 1) {
      expect(state.add({ device: DEVICE, counter, target: "pace", value: counter, seen: {} })).toBe(
        "added",
      );
    }
    expect(
      state.add({ device: DEVICE, counter: 5000, target: "member:carol", value: "read", seen: {} }),
    ).toBe("refused");
    expect(state.add(close(DEVICE, 5000))).toBe("added");
    expect(state.closed).toBe(true);
    expect(state.snapshot().aboveHoles?.[DEVICE]).toHaveLength(MAX_COUNTERS_AHEAD);
  });

  it("measures alike whether the close came as an operation or in a snapshot", () => {
    const byOperation = heldAt(MAX_CONTROL_BYTES - 1);
    byOperation.add(close(FRESH, 1, byOperation.vector));
    const bySnapshot = heldAt(MAX_CONTROL_BYTES - 1);
    expect(bySnapshot.mergeOrRefuse(byOperation.snapshot()).refused).toBe(false);
    expect(bySnapshot.bytes).toBe(byOperation.bytes);
    expect(bySnapshot.snapshot()).toEqual(byOperation.snapshot());
  });
});

describe("closing through the engine (CTL-37, SND-18)", () => {
  it("a device of the creator closes even where its snapshot would no longer fit one answer", async () => {
    const port = new InMemoryMessengerPort();
    const bounded = {
      transportProfile: async () => {
        const profile = await port.transportProfile();
        return { ...profile, bounds: { ...profile.bounds, maxBytes: 6_000 } };
      },
      createDocument: port.createDocument.bind(port),
      listChannels: port.listChannels.bind(port),
      receive: port.receive.bind(port),
      send: port.send.bind(port),
    };
    const alice = await DocumentEngine.create("doc-1", "alice", bounded, undefined, {
      batchWindowMs: 0,
      resyncResponseThrottleMs: 0,
      creatorMemberId: "alice",
    });
    // Members until a further one would make the answer too large for the transport (SND-18).
    let refused: unknown;
    for (let n = 0; n < 200 && refused === undefined; n += 1) {
      await alice
        .setMembership(`member-${String(n).padStart(40, "0")}`, "read")
        .catch((error: unknown) => {
          refused = error;
        });
    }
    expect(refused).toBeInstanceOf(SendRefusedError);
    expect((refused as SendRefusedError).reason).toBe("too-large");
    await alice.closeDocument();
    expect(alice.closed).toBe(true);
  });
});
