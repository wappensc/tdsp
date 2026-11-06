import { describe, expect, it } from "vitest";
import { type Clock, compareClocks, MAX_CLOCK_COUNTER, MAX_CLOCK_MS, ZERO_CLOCK } from "./clock";
import {
  ACCEPTED_CONTROL_BYTES,
  ControlState,
  type ControlTarget,
  DEVICE_TAG,
  isControlTarget,
  layerTargetOf,
  MAX_ISSUE_BYTES,
  MAX_RIGHT_TARGETS,
  memberOf,
  newDeviceTag,
  REGISTER_WIDTH,
  type Register,
  type RegisterState,
  registerStateFrom,
  rightIn,
} from "./control-state";
import { canonicalJson } from "./digest";
import { compareRegisters, registerStateDigest } from "./registers";

/**
 * Control state as registers (SPECIFICATION.md §7): one register per target, the latest decision
 * on it (CTL-20), merged as CTL-22 says — the greater clock, then the later device tag in Unicode
 * code point order, then the narrower value (CTL-23) — and the close as a flag (LIF-7); within the
 * bounds of CTL-30, measured as CTL-34 says, and beyond them a capacity conflict (CTL-32) that still
 * takes the close (CTL-36); and what a device of the creator may decide on top of it (CTL-37).
 */

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

const T = 1_793_008_800_000;
const at = (ms: number, counter = 0): Clock => [T + ms, counter];
const LAPTOP = "QUFBQUFBQUFBQUFBQUFBQQ";
const TABLET = "QkJCQkJCQkJCQkJCQkJCQg";
const PHONE = "Ms3dRk0ZyS7cH1qkM8fWNA";
const LAYER = "com.example.comments/1";
const utf8 = (text: string) => new TextEncoder().encode(text).length;

const reg = (value: Register["value"], clock: Clock, device = LAPTOP): Register => ({
  value,
  clock,
  device,
});
const one = (target: string, register: Register, closed = false): RegisterState => ({
  closed,
  targets: { [target]: register },
});

describe("targets (§7.1, LAY-5)", () => {
  it("are members, rights on layers with a layer id, and the pace; the close is no target", () => {
    expect(isControlTarget("member:bob")).toBe(true);
    expect(isControlTarget("pace")).toBe(true);
    expect(isControlTarget(`layer:${LAYER}:member:bob`)).toBe(true);
    for (const target of [
      "close",
      "layer:Comments/1:member:bob",
      "layer::member:bob",
      `layer:${LAYER}:bob`,
      `layer:${LAYER}`,
      "bob",
    ]) {
      expect(isControlTarget(target), target).toBe(false);
    }
  });

  it("reads a layer right's target by its first :member:", () => {
    expect(layerTargetOf(`layer:${LAYER}:member:bob`)).toEqual({ layer: LAYER, member: "bob" });
    expect(layerTargetOf(`layer:${LAYER}:member:@bob:example.org`)).toEqual({
      layer: LAYER,
      member: "@bob:example.org",
    });
    expect(memberOf(`layer:${LAYER}:member:bob`)).toBe("bob");
    expect(memberOf("member:@carol:example.org")).toBe("@carol:example.org");
    expect(memberOf("pace")).toBeUndefined();
  });

  it("makes device tags of 22 base64url characters", () => {
    const tags = new Set(Array.from({ length: 200 }, () => newDeviceTag()));
    expect(tags.size).toBe(200);
    for (const tag of tags) expect(tag).toMatch(DEVICE_TAG);
  });
});

describe("merging registers (CTL-22, CTL-23)", () => {
  it("keeps the register with the greater clock, wider or narrower, in either order", () => {
    for (const [earlier, later] of [
      ["write", "read"],
      ["read", "write"],
      [null, "write"],
      ["write", null],
    ] as const) {
      const first = reg(earlier, at(0), TABLET);
      const second = reg(later, at(1), LAPTOP);
      for (const order of [
        [first, second],
        [second, first],
      ]) {
        const state = new ControlState();
        for (const register of order) state.take(one("member:bob", register));
        expect(state.valueOf("member:bob"), `${String(earlier)} → ${String(later)}`).toBe(later);
      }
    }
  });

  it("orders clocks by milliseconds and then by counter, the counter carrying no weight of its own", () => {
    const state = new ControlState();
    state.take(one("member:bob", reg("write", at(0, 65_535))));
    state.take(one("member:bob", reg("read", at(1, 0), TABLET)));
    expect(state.valueOf("member:bob")).toBe("read");
    state.take(one("member:bob", reg("write", at(1, 1), TABLET)));
    expect(state.valueOf("member:bob")).toBe("write");
  });

  it("at equal clocks keeps the device that comes later in code point order", () => {
    // In base64url: '-' < digits < 'A'–'Z' < '_' < 'a'–'z'.
    const devices = [
      "-".repeat(22),
      "0".repeat(22),
      "Z".repeat(22),
      "_".repeat(22),
      "a".repeat(22),
    ];
    const g = generator(7);
    for (let round = 0; round < 20; round++) {
      const state = new ControlState();
      for (const device of g.shuffle(devices)) {
        state.take(
          one("member:bob", reg(device === "a".repeat(22) ? "read" : "write", at(0), device)),
        );
      }
      expect(state.registerOf("member:bob")?.device).toBe("a".repeat(22));
      expect(state.valueOf("member:bob")).toBe("read");
    }
  });

  it("at equal clock and device keeps the narrower value, by the order of the target's kind", () => {
    const tie = (target: string, values: readonly Register["value"][]) => {
      const results = new Set<Register["value"] | undefined>();
      for (const order of [values, [...values].reverse()]) {
        const state = new ControlState();
        for (const value of order) state.take(one(target, reg(value, at(0))));
        results.add(state.valueOf(target));
      }
      expect(results.size, `${target} ${JSON.stringify(values)}`).toBe(1);
      return [...results][0];
    };
    // A member: revoked before read before write.
    expect(tie("member:bob", ["write", "read"])).toBe("read");
    expect(tie("member:bob", ["read", null])).toBeNull();
    expect(tie("member:bob", ["write", null, "read"])).toBeNull();
    // A right on a layer: read before inherit before write (LAY-5).
    expect(tie(`layer:${LAYER}:member:bob`, ["write", null])).toBeNull();
    expect(tie(`layer:${LAYER}:member:bob`, [null, "read"])).toBe("read");
    // The pace: the longer interval.
    expect(tie("pace", [10_000, 30_000, 20_000])).toBe(30_000);
  });

  it("keeps a register far ahead of any wall clock: no receiver sets one aside by its own time (CTL-45)", () => {
    const state = new ControlState();
    state.take(one("member:bob", reg("write", at(0))));
    const ahead: Clock = [MAX_CLOCK_MS, MAX_CLOCK_COUNTER];
    state.take(one("member:bob", reg("read", ahead, TABLET)));
    expect(state.valueOf("member:bob")).toBe("read");
    expect(state.clock).toEqual(ahead);
  });

  it("changes nothing for a register it holds, or one that does not hold over it (CTL-6)", () => {
    const state = new ControlState();
    state.take(one("member:bob", reg("write", at(5))));
    const digest = state.digest;
    const revision = state.revision;
    for (const register of [reg("write", at(5)), reg("read", at(4), TABLET)]) {
      expect(state.take(one("member:bob", register))).toEqual({ refused: false, leftOut: 0 });
    }
    expect(state.digest).toBe(digest);
    expect(state.valueOf("member:bob")).toBe("write");
    expect(state.revision).toBeGreaterThan(revision);
  });

  it("random histories: any order, duplicates and grouping into frames and snapshots give one state, the oracle's", () => {
    const targets: readonly ControlTarget[] = [
      "member:bob",
      "member:carol",
      "member:@dave:example.org",
      `layer:${LAYER}:member:bob`,
      `layer:${LAYER}:member:carol`,
      "pace",
    ];
    const devices = [LAPTOP, TABLET, PHONE];
    for (let seed = 1; seed <= 200; seed++) {
      const g = generator(seed);
      const registers: [string, Register][] = [];
      for (let n = 0; n < 30; n++) {
        const target = g.pick(targets);
        const value =
          target === "pace"
            ? g.pick([0, 10_000, 30_000])
            : g.pick(["read", "write", null] as const);
        // Few clocks, so that ties of clock, and of clock and device, occur.
        const clock = at(Math.floor(g.random() * 4), Math.floor(g.random() * 2));
        registers.push([target, reg(value, clock, g.pick(devices))]);
      }
      const closedAt = g.random() < 0.3 ? Math.floor(g.random() * registers.length) : -1;
      // The oracle: per target the register that holds over every other (CTL-22).
      const oracle = new Map<string, Register>();
      for (const [target, register] of registers) {
        const held = oracle.get(target);
        if (held === undefined || compareRegisters(target, register, held) > 0)
          oracle.set(target, register);
      }
      const states: ControlState[] = [];
      for (let receiver = 0; receiver < 4; receiver++) {
        const state = new ControlState();
        const order = g.shuffle(registers.map((_, i) => i));
        // Some arrive twice; some arrive grouped in one frame or in a snapshot of another receiver.
        for (let i = 0; i < order.length; ) {
          const size = 1 + Math.floor(g.random() * 4);
          const group = order.slice(i, i + size);
          const frame: RegisterState = {
            closed: group.includes(closedAt),
            targets: {},
          };
          const groupTargets: Record<string, Register> = {};
          for (const index of group) {
            const [target, register] = registers[index] as [string, Register];
            // Within one frame a target appears once: the one that holds of the group.
            const held = groupTargets[target];
            if (held === undefined || compareRegisters(target, register, held) > 0) {
              groupTargets[target] = register;
            }
          }
          state.take({ ...frame, targets: groupTargets });
          if (g.random() < 0.3) state.take({ ...frame, targets: groupTargets });
          if (g.random() < 0.2 && states.length > 0) state.take(g.pick(states).state());
          i += size;
        }
        states.push(state);
      }
      const expectedTargets = Object.fromEntries(
        [...oracle].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
      for (const state of states) {
        expect(state.state().targets, `seed ${seed}`).toEqual(expectedTargets);
        expect(state.closed, `seed ${seed}`).toBe(closedAt >= 0);
        expect(state.digest).toBe((states[0] as ControlState).digest);
      }
    }
  });

  it("is associative: snapshots taken in any grouping give one state", () => {
    const g = generator(99);
    const piece = (n: number) => {
      const state = new ControlState();
      for (let k = 0; k < 6; k++) {
        const target = g.random() < 0.25 ? "pace" : `member:m${k % 3}`;
        const value =
          target === "pace" ? g.pick([0, 5_000]) : g.pick(["read", "write", null] as const);
        state.take(
          one(target, reg(value, at(Math.floor(g.random() * 3)), g.pick([LAPTOP, TABLET]))),
        );
      }
      if (n === 2) state.close();
      return state;
    };
    const [a, b, c] = [piece(0), piece(1), piece(2)];
    const left = ControlState.from(a.state());
    left.take(b.state());
    left.take(c.state());
    const bc = ControlState.from(b.state());
    bc.take(c.state());
    const right = ControlState.from(a.state());
    right.take(bc.state());
    expect(right.state()).toEqual(left.state());
    expect(right.digest).toBe(left.digest);
  });
});

describe("the close (CTL-23, LIF-7)", () => {
  it("holds once a frame or a snapshot carries it, and nothing reopens the document", () => {
    const state = new ControlState();
    expect(state.isEmpty).toBe(true);
    state.take({ closed: false, targets: {} });
    expect(state.closed).toBe(false);
    state.take({ closed: true, targets: {} });
    expect(state.closed).toBe(true);
    expect(state.isEmpty).toBe(false);
    state.take({ closed: false, targets: { "member:bob": reg("write", at(9)) } });
    expect(state.closed).toBe(true);
    state.take(ControlState.from({ closed: false, targets: {} }).state());
    expect(state.closed).toBe(true);
  });

  it("is a flag, no register: it changes no clock, but the digest", () => {
    const state = ControlState.from(one("member:bob", reg("write", at(0))));
    const { clock, digest } = state;
    const closed = state.copy();
    closed.close();
    closed.close();
    expect(closed.clock).toEqual(clock);
    expect(closed.digest).not.toBe(digest);
    expect(state.closed).toBe(false); // the copy closed, not the original
  });
});

describe("reading control state", () => {
  it("names members, the revoked, rights on layers and the pace, as their registers say", () => {
    const state = ControlState.from({
      closed: false,
      targets: {
        "member:bob": reg("read", at(0)),
        "member:carol": reg("write", at(0)),
        "member:dave": reg(null, at(0)),
        [`layer:${LAYER}:member:bob`]: reg("write", at(1)),
        [`layer:${LAYER}:member:carol`]: reg(null, at(1)),
        [`layer:${LAYER}:member:dave`]: reg("write", at(1)),
        pace: reg(30_000, at(2)),
      },
    });
    expect(state.members).toEqual(
      new Map([
        ["bob", "read"],
        ["carol", "write"],
      ]),
    );
    expect(state.revoked).toEqual(new Set(["dave"]));
    // Inherit (`null`) is no right of its own: carol's layer right is her permission.
    expect(state.layerRights).toEqual(
      new Map([
        [
          LAYER,
          new Map([
            ["bob", "write"],
            ["dave", "write"],
          ]),
        ],
      ]),
    );
    expect(state.pace).toBe(30_000);
    expect(state.valueOf("member:dave")).toBeNull();
    expect(state.valueOf("member:erin")).toBeUndefined();
    expect(state.holds("member:dave")).toBe(true);
    expect(state.holds("member:erin")).toBe(false);
    expect(state.rightTargets).toBe(6);
    // CTL-13 as rightIn applies it: a layer right is an exception to a permission; a revoked
    // member has none, on any layer; unknown stays unknown.
    expect(rightIn(state, "bob", LAYER)).toBe("write");
    expect(rightIn(state, "carol", LAYER)).toBe("write");
    expect(rightIn(state, "dave", LAYER)).toBe("revoked");
    expect(rightIn(state, "dave")).toBe("revoked");
    expect(rightIn(state, "erin")).toBeUndefined();
  });

  it("gives its state sorted by target, each register exactly value, clock and device, as a copy", () => {
    const state = new ControlState();
    state.take({
      closed: false,
      targets: {
        pace: reg(5_000, at(0)),
        "member:zoe": reg("read", at(0)),
        "member:Zoe": { ...reg("write", at(0)), "com.example.note": "x" } as Register,
      },
    });
    const snapshot = state.state();
    expect(Object.keys(snapshot.targets)).toEqual(["member:Zoe", "member:zoe", "pace"]);
    expect(snapshot.targets["member:Zoe"]).toEqual(reg("write", at(0)));
    (snapshot.targets as Record<string, Register>)["member:new"] = reg("write", at(1));
    expect(state.holds("member:new")).toBe(false);
  });

  it("has the greatest clock among its registers as its control clock, [0, 0] without any", () => {
    const state = new ControlState();
    expect(state.clock).toEqual(ZERO_CLOCK);
    state.take(one("member:bob", reg("write", at(5, 2))));
    state.take(one("pace", reg(1_000, at(5, 7))));
    state.take(one("member:carol", reg("read", at(3))));
    expect(state.clock).toEqual(at(5, 7));
  });
});

describe("the control digest (LOS-24)", () => {
  it("is registers.ts's digest of the state, of exactly closed and targets", () => {
    const state = ControlState.from({
      closed: true,
      targets: { "member:bob": reg("write", at(0)) },
    });
    expect(state.digest).toBe(registerStateDigest(state.state()));
  });

  it("gives the specification's example digests", () => {
    const bob = reg("write", [1_793_008_800_000, 0], PHONE);
    const pace = reg(30_000, [1_793_008_800_000, 1], PHONE);
    const carol = reg("read", [1_793_008_860_000, 0], PHONE);
    const state = new ControlState();
    expect(state.digest).toBe("dc2300e4cc3f671f");
    state.take(one("member:bob", bob));
    expect(state.digest).toBe("106166478695c222");
    state.take(one("pace", pace));
    expect(state.digest).toBe("f1bd21d9458955ff");
    state.take(one("member:carol", carol));
    expect(state.digest).toBe("8d243bc3f8bf3126");
    expect(state.clock).toEqual([1_793_008_860_000, 0]);
    state.close();
    expect(state.digest).toBe("c3d2af7d419e5c5a");
  });
});

describe("the bytes of control state (CTL-34)", () => {
  it("random states, members beyond ASCII among them: always each target's name as RFC 8785 writes it, at the fixed width, the pace left out", () => {
    const names = ["bob", "Zoë", "😀 smile", 'q"uote', "back\\slash", "\u0001ctl", "日本語", " "];
    for (let seed = 1; seed <= 50; seed++) {
      const g = generator(seed);
      const state = new ControlState();
      for (let n = 0; n < 40; n++) {
        const name = `${g.pick(names)}${Math.floor(g.random() * 5)}`;
        const target = g.pick([`member:${name}`, `layer:${LAYER}:member:${name}`, "pace"]);
        const value =
          target === "pace"
            ? Math.floor(g.random() * 100_000)
            : g.pick(["read", "write", null] as const);
        const clock = at(Math.floor(g.random() * 1_000_000), Math.floor(g.random() * 3));
        state.take(one(target, reg(value, clock, g.pick([LAPTOP, TABLET]))));
        if (g.random() < 0.1) state.close();
        const held = Object.keys(state.state().targets).filter((target) => target !== "pace");
        const measured =
          utf8('{"targets":{}}') +
          held.reduce((sum, target) => sum + utf8(canonicalJson(target)) + 1 + REGISTER_WIDTH, 0) +
          Math.max(0, held.length - 1);
        expect(state.bytes, `seed ${seed}`).toBe(measured);
      }
    }
  });
});

/** `count` members with ids of 255 characters: about 340 bytes of control state each. */
function wide(count: number, from = 0, device = LAPTOP): RegisterState {
  const targets: Record<string, Register> = {};
  for (let n = from; n < from + count; n++) {
    targets[`member:${String(n).padStart(8, "0")}${"x".repeat(247)}`] = reg("read", at(n), device);
  }
  return { closed: false, targets };
}

describe("the bounds of control state (CTL-30, CTL-32, CTL-36)", () => {
  it("holds 5 000 targets on members and rights on layers, and the pace beside them", () => {
    const state = new ControlState();
    const targets: Record<string, Register> = {};
    for (let n = 0; n < MAX_RIGHT_TARGETS; n++) {
      targets[n % 2 === 0 ? `member:m${n}` : `layer:${LAYER}:member:m${n}`] = reg("read", at(n));
    }
    expect(state.take({ closed: false, targets })).toEqual({ refused: false, leftOut: 0 });
    expect(state.rightTargets).toBe(MAX_RIGHT_TARGETS);
    expect(state.take(one("pace", reg(1_000, at(0))))).toEqual({ refused: false, leftOut: 0 });
    expect(state.capacityConflict).toBe(false);
  });

  it("refuses a frame that brings it over 5 000 targets as a whole, enters the conflict, and takes its close", () => {
    const state = new ControlState();
    state.take(wide(MAX_RIGHT_TARGETS - 1));
    const digest = state.digest;
    const result = state.take({
      closed: true,
      targets: {
        "member:x": reg("read", at(0)),
        "member:y": reg("read", at(0)),
        pace: reg(1, at(0)),
      },
    });
    expect(result).toEqual({ refused: true, leftOut: 3 });
    expect(state.capacityConflict).toBe(true);
    expect(state.closed).toBe(true);
    expect(state.holds("pace")).toBe(false); // nothing of a refused frame is held but its close
    expect(state.rightTargets).toBe(MAX_RIGHT_TARGETS - 1);
    state.close();
    expect(registerStateDigest({ closed: false, targets: state.state().targets })).toBe(digest);
  });

  it("refuses what would bring it over its bytes as a whole, and takes the close", () => {
    const state = new ControlState({ maxBytes: 2_000 });
    expect(state.take(wide(4)).refused).toBe(false);
    const bytes = state.bytes;
    const result = state.take({ ...wide(3, 4), closed: true });
    expect(result).toEqual({ refused: true, leftOut: 3 });
    expect(state.bytes).toBe(bytes);
    expect(state.closed).toBe(true);
    expect(state.capacityConflict).toBe(true);
  });

  it("in a conflict takes no new member or layer right, and still the pace and changes of what it holds", () => {
    const state = new ControlState({ maxBytes: 2_000 });
    state.take(wide(4));
    state.take(wide(10, 4));
    expect(state.capacityConflict).toBe(true);
    const held = Object.keys(wide(1).targets)[0] as string;
    const result = state.take({
      closed: false,
      targets: {
        "member:new": reg("write", at(50)),
        [`layer:${LAYER}:member:new`]: reg("write", at(50)),
        [held]: reg("write", at(50)),
        pace: reg(5_000, at(50)),
      },
    });
    expect(result).toEqual({ refused: false, leftOut: 2 });
    expect(state.holds("member:new")).toBe(false);
    expect(state.valueOf(held)).toBe("write");
    expect(state.pace).toBe(5_000);
  });

  it("reaches the conflict over the union in whatever order the two halves arrive", () => {
    const a = wide(1_300, 0, LAPTOP);
    const b = wide(1_300, 1_300, TABLET);
    for (const order of [
      [a, b],
      [b, a],
    ]) {
      const state = new ControlState({ maxBytes: 800_000 });
      const results = order.map((half) => state.take(half));
      expect(results.map((result) => result.refused)).toEqual([false, true]);
      expect(state.capacityConflict).toBe(true);
    }
  });

  it("keeps a conflict a restart marks again (CTL-32)", () => {
    const state = ControlState.from(wide(2));
    expect(state.capacityConflict).toBe(false);
    state.markCapacityConflict();
    expect(state.capacityConflict).toBe(true);
    expect(state.copy().capacityConflict).toBe(true);
  });

  it("holds 3 MiB by default (CTL-30)", () => {
    expect(new ControlState().maxBytes).toBe(ACCEPTED_CONTROL_BYTES);
    expect(ACCEPTED_CONTROL_BYTES).toBe(3_145_728);
  });
});

describe("what a device of the creator may decide (CTL-37, CTL-32)", () => {
  /** A state just over 1 MiB: about 3 100 wide members. */
  const overIssue = () => {
    const state = new ControlState();
    let n = 0;
    while (state.bytes <= MAX_ISSUE_BYTES) {
      const before = state.bytes;
      state.take(wide(100, n));
      n += 100;
      // A state that takes no more — its own bound reached first — ends here, and the test fails on
      // what it then holds rather than looping.
      if (state.bytes === before) break;
    }
    return state;
  };

  it("adds no target that brings the state over 1 MiB — a member, a layer right —, but the pace, which is not measured, always has room", () => {
    const state = overIssue();
    for (const target of ["member:new", `layer:${LAYER}:member:new`] as const) {
      expect(state.issue(target, reg("read", at(99_999))), target).toEqual({
        refused: "too-large",
      });
    }
    expect(state.holds("member:new")).toBe(false);
    const paced = state.issue("pace", reg(1_000, at(99_999)));
    expect("next" in paced && paced.next.pace).toBe(1_000);
  });

  it("changes a target it holds above 1 MiB, up to the bytes it holds, and leaves the state it decides on as it was", () => {
    const state = overIssue();
    const held = Object.keys(wide(1).targets)[0] as ControlTarget;
    const before = state.digest;
    const issued = state.issue(held, reg("write", at(99_999)));
    if (!("next" in issued)) throw new Error("refused");
    expect(issued.next.valueOf(held)).toBe("write");
    expect(state.digest).toBe(before);
    expect(state.valueOf(held)).toBe("read");
  });

  it("decides nothing a receiver would refuse: beyond 5 000 targets, or beyond the bytes", () => {
    const full = new ControlState();
    const targets: Record<string, Register> = {};
    for (let n = 0; n < MAX_RIGHT_TARGETS; n++) targets[`member:m${n}`] = reg("read", at(n));
    full.take({ closed: false, targets });
    expect(full.issue("member:one-more", reg("read", at(1)))).toEqual({ refused: "too-large" });
    expect(full.capacityConflict).toBe(false); // refusing is no conflict of its own
    const small = new ControlState({ maxBytes: 1_000 });
    small.take(wide(2));
    const held = Object.keys(wide(1).targets)[0] as ControlTarget;
    expect("next" in small.issue(held, reg("write", at(5)))).toBe(true);
  });

  it("in a conflict adds no member or layer right, and still the pace and changes of what it holds", () => {
    const state = new ControlState({ maxBytes: 2_000 });
    state.take(wide(4));
    state.take(wide(10, 4));
    expect(state.capacityConflict).toBe(true);
    expect(state.issue("member:new", reg("read", at(9)))).toEqual({ refused: "capacity-conflict" });
    expect(state.issue(`layer:${LAYER}:member:new`, reg("read", at(9)))).toEqual({
      refused: "capacity-conflict",
    });
    expect("next" in state.issue("pace", reg(1_000, at(9)))).toBe(true);
    const held = Object.keys(wide(1).targets)[0] as ControlTarget;
    expect("next" in state.issue(held, reg(null, at(9)))).toBe(true);
  });
});

describe("persisted control state read back (CTL-26, CTL-39)", () => {
  const valid: RegisterState = {
    closed: true,
    targets: {
      "member:bob": reg("write", at(0)),
      [`layer:${LAYER}:member:bob`]: reg(null, at(1)),
      pace: reg(30_000, at(2)),
    },
  };

  it("takes this draft's form", () => {
    expect(registerStateFrom(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
    expect(registerStateFrom({ closed: false, targets: {} })).toEqual({
      closed: false,
      targets: {},
    });
  });

  it("reads an earlier draft's form, operations with a control vector, as none", () => {
    expect(
      registerStateFrom({
        vector: { [LAPTOP]: 1 },
        targets: {
          "member:bob": {
            seen: {},
            heads: [{ device: LAPTOP, counter: 1, value: "write", seen: {} }],
          },
        },
      }),
    ).toBeUndefined();
  });

  it("reads anything else that is no state of registers as none", () => {
    const broken: unknown[] = [
      undefined,
      null,
      [],
      "state",
      { targets: valid.targets },
      { closed: "yes", targets: valid.targets },
      { closed: false, targets: [] },
      { closed: false, targets: null },
      { closed: false, targets: { close: reg("write", at(0)) } },
      { closed: false, targets: { "layer:Bad/1:member:bob": reg("write", at(0)) } },
      { closed: false, targets: { "member:bob": { ...reg("write", at(0)), extra: 1 } } },
      { closed: false, targets: { "member:bob": { value: "write", clock: at(0) } } },
      { closed: false, targets: { "member:bob": reg("admin" as never, at(0)) } },
      { closed: false, targets: { pace: reg("write", at(0)) } },
      { closed: false, targets: { pace: reg(-1, at(0)) } },
      { closed: false, targets: { "member:bob": reg("write", [T, 0, 0] as unknown as Clock) } },
      { closed: false, targets: { "member:bob": reg("write", [MAX_CLOCK_MS + 1, 0]) } },
      { closed: false, targets: { "member:bob": reg("write", [T, MAX_CLOCK_COUNTER + 1]) } },
      { closed: false, targets: { "member:bob": reg("write", [T + 0.5, 0]) } },
      { closed: false, targets: { "member:bob": reg("write", [-1, 0]) } },
      { closed: false, targets: { "member:bob": reg("write", at(0), "short") } },
    ];
    for (const value of broken) {
      expect(registerStateFrom(value), JSON.stringify(value)).toBeUndefined();
    }
  });

  it("restores what it reads into a state with the same registers, clock and digest", () => {
    const original = ControlState.from(valid);
    const read = registerStateFrom(JSON.parse(JSON.stringify(original.state())));
    const restored = ControlState.from(read as RegisterState);
    expect(restored.state()).toEqual(original.state());
    expect(restored.digest).toBe(original.digest);
    expect(compareClocks(restored.clock, original.clock)).toBe(0);
    expect(restored.bytes).toBe(original.bytes);
  });
});
