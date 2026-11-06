import { describe, expect, it } from "vitest";
import {
  CLOCK_SPAN_MS,
  type Clock,
  clockCap,
  compareClocks,
  MAX_CLOCK_COUNTER,
  MAX_CLOCK_MS,
  raiseClock,
  ZERO_CLOCK,
} from "./clock";
import { canonicalJson } from "./digest";
import {
  CLOSE_REASON,
  compareCodePoints,
  compareRegisters,
  controlClockOf,
  decideRegister,
  EMPTY_REGISTER_STATE,
  isRegister,
  mergeRegister,
  mergeRegisterStates,
  type Register,
  type RegisterState,
  type RegisterTarget,
  type RegisterValue,
  registerStateDigest,
  registerStateJson,
} from "./registers";

/**
 * Control state as registers (CTL-20, CTL-22, CTL-23, CTL-45, LOS-24), as properties of registers.ts and clock.ts over random histories with
 * a fixed seed: several devices of the creator with wall clocks that disagree, members that pass
 * whole states on, lost and duplicated messages, a backup put back under its old tag, a register a
 * year ahead. Every replica merges with `mergeRegisterStates`, every device of the creator decides
 * with `decideRegister` and raises its own clock with `raiseClock`; nothing else of the engine takes
 * part. Authority — that the close counts only from the creator — is modelled here, as the engine
 * applies it (CTL-5).
 *
 * The properties:
 * - **Convergence** (CTL-22): after a final round of whole states every replica holds the same, and
 *   that is a function of the set of decisions — per target the register that holds over all.
 * - **In knowledge holds** (CTL-21, CTL-22): a decision holds over every register on its target its
 *   device held, or was reported, however wrong the wall clocks; where no clock is a day off, also
 *   over everything its device knew on any target.
 * - **The later holds**: of two concurrent decisions, with exact wall clocks the later.
 * - **Never by the receiver's time**: a register far ahead is merged like any other.
 * - **The close** never falls back and ends the same everywhere (LIF-7).
 * - **The own clock** never runs more than the span ahead of its device's wall clock.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const YEAR = 365 * DAY;
const START = Date.UTC(2026, 9, 26, 9, 0, 0);
const LAYER = "comments.example/1";

/** A random number generator with a seed (mulberry32), so that every run is the same. */
class Rng {
  #s: number;
  constructor(seed: number) {
    this.#s = seed >>> 0;
  }
  next(): number {
    this.#s = (this.#s + 0x6d2b79f5) >>> 0;
    let t = this.#s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  between(a: number, b: number): number {
    return Math.round(a + this.next() * (b - a));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)] as T;
  }
  shuffle<T>(xs: T[]): T[] {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [xs[i], xs[j]] = [xs[j] as T, xs[i] as T];
    }
    return xs;
  }
  /** A device tag (CTL-20): 22 characters of base64url. */
  tag(): string {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let tag = "";
    for (let i = 0; i < 22; i++) tag += alphabet[this.int(64)];
    return tag;
  }
}

const keyOf = (state: RegisterState): string => canonicalJson(registerStateJson(state));
const valuesOf = (target: string): readonly RegisterValue[] =>
  target === "pace" ? [2_000, 5_000, 20_000] : [null, "read", "write"];
const one = (target: string, register: Register, closed = false): RegisterState => ({
  closed,
  targets: Object.fromEntries([[target, register]]),
});
const lead = (own: Clock, wall: number): number => own[0] - wall;

/**
 * Whether `a` holds over a different `b` on `target`, as CTL-22 and CTL-23 read: the greater clock,
 * then the later device (tags are ASCII, where code unit and code point order agree), then the
 * narrower value.
 */
function referenceHolds(target: string, a: Register, b: Register): boolean {
  if (a.clock[0] !== b.clock[0]) return a.clock[0] > b.clock[0];
  if (a.clock[1] !== b.clock[1]) return a.clock[1] > b.clock[1];
  if (a.device !== b.device) return a.device > b.device;
  const rank = (v: RegisterValue): number =>
    target === "pace"
      ? -(v as number)
      : target.startsWith("layer:")
        ? { read: 0, null: 1, write: 2 }[String(v) as "read"]
        : { null: 0, read: 1, write: 2 }[String(v) as "read"];
  return rank(a.value) < rank(b.value);
}

// ---------------------------------------------------------------- the order of registers

describe("which of two registers holds (CTL-22, CTL-23)", () => {
  const A = "AAAAAAAAAAAAAAAAAAAAAA";
  const B = "BBBBBBBBBBBBBBBBBBBBBB";
  const at = (ms: number, counter: number, device: string, value: RegisterValue): Register => ({
    value,
    clock: [ms, counter],
    device,
  });

  it("the greater clock, by ms and then by counter, whatever the device and the value", () => {
    expect(compareRegisters("member:bob", at(2, 0, A, "write"), at(1, 9, B, null))).toBeGreaterThan(
      0,
    );
    expect(compareRegisters("member:bob", at(2, 1, A, "write"), at(2, 0, B, null))).toBeGreaterThan(
      0,
    );
    expect(mergeRegister("pace", at(5, 0, B, 2_000), at(6, 0, A, 2_000)).clock).toEqual([6, 0]);
  });

  it("at equal clocks, the device later in Unicode code point order", () => {
    // `a` (U+0061) comes after `Z` (U+005A) and `_` (U+005F) after `Z` too, but before `a`.
    const lower = "aAAAAAAAAAAAAAAAAAAAAA";
    const upper = "ZAAAAAAAAAAAAAAAAAAAAA";
    const under = "_AAAAAAAAAAAAAAAAAAAAA";
    expect(
      compareRegisters("member:bob", at(1, 0, lower, "write"), at(1, 0, upper, null)),
    ).toBeGreaterThan(0);
    expect(
      compareRegisters("member:bob", at(1, 0, under, "write"), at(1, 0, upper, null)),
    ).toBeGreaterThan(0);
    expect(
      compareRegisters("member:bob", at(1, 0, under, "write"), at(1, 0, lower, null)),
    ).toBeLessThan(0);
  });

  it("at equal clock and device, the narrower value, by the order of its target", () => {
    const tie = (target: string, a: RegisterValue, b: RegisterValue) =>
      mergeRegister(target, at(1, 0, A, a), at(1, 0, A, b)).value;
    // A member: revoked before read before write.
    expect(tie("member:bob", "write", "read")).toBe("read");
    expect(tie("member:bob", "read", null)).toBe(null);
    // A right on a layer: read before inherit before write (LAY-5).
    const layer = `layer:${LAYER}:member:bob`;
    expect(tie(layer, null, "read")).toBe("read");
    expect(tie(layer, "write", null)).toBe(null);
    // The pace: the longer interval.
    expect(tie("pace", 2_000, 20_000)).toBe(20_000);
    // Either order of arrival.
    for (const [target, a, b] of [
      ["member:bob", "write", null],
      [layer, "write", "read"],
      ["pace", 5_000, 2_000],
    ] as const) {
      expect(tie(target, a, b), target).toBe(tie(target, b, a));
    }
  });

  it("the same register is the same, whichever object holds it", () => {
    expect(compareRegisters("member:bob", at(1, 0, A, "read"), at(1, 0, A, "read"))).toBe(0);
  });

  it("a register is exactly a value its target takes, a clock in its ranges and a device tag", () => {
    expect(isRegister("member:bob", at(1, 0, A, "read"))).toBe(true);
    expect(isRegister("member:bob", at(1, 0, A, null))).toBe(true);
    expect(isRegister("pace", at(1, 0, A, 30_000))).toBe(true);
    expect(isRegister(`layer:${LAYER}:member:bob`, at(1, 0, A, null))).toBe(true);
    for (const [target, bad] of [
      ["member:bob", { ...at(1, 0, A, "read"), extra: 1 }],
      ["member:bob", { value: "read", clock: [1, 0] }],
      ["member:bob", at(1, 0, A, 5)],
      ["pace", at(1, 0, A, "read")],
      ["pace", at(1, 0, A, -1)],
      ["pace", at(1, 0, A, 2 ** 32)],
      ["member:bob", at(MAX_CLOCK_MS + 1, 0, A, "read")],
      ["member:bob", at(1, MAX_CLOCK_COUNTER + 1, A, "read")],
      ["member:bob", at(1, 0, "short", "read")],
      ["member:bob", at(1, 0, `${A}=`, "read")],
      ["close", at(1, 0, A, true as unknown as RegisterValue)],
      ["member:bob", null],
      ["member:bob", [at(1, 0, A, "read")]],
    ] as const) {
      expect(isRegister(target as "member:bob", bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------- the control digest and clock

describe("the control digest (LOS-24) and the control clock", () => {
  const D = "Ms3dRk0ZyS7cH1qkM8fWNA";
  const bob: Register = { value: "write", clock: [1_793_008_800_000, 0], device: D };
  const pace: Register = { value: 30_000, clock: [1_793_008_800_000, 1], device: D };
  const carol: Register = { value: "read", clock: [1_793_008_860_000, 0], device: D };

  it("is the first 8 bytes of SHA-256 over the RFC 8785 form of exactly closed and targets", () => {
    const state: RegisterState = { closed: false, targets: { "member:bob": bob } };
    expect(canonicalJson(registerStateJson(state))).toBe(
      `{"closed":false,"targets":{"member:bob":{"clock":[1793008800000,0],"device":"${D}","value":"write"}}}`,
    );
    // The digests of Appendix D's examples, and of the empty state, computed apart with Node's SHA-256.
    expect(registerStateDigest(EMPTY_REGISTER_STATE)).toBe("dc2300e4cc3f671f");
    expect(registerStateDigest(state)).toBe("106166478695c222");
    expect(registerStateDigest({ closed: false, targets: { "member:bob": bob, pace } })).toBe(
      "f1bd21d9458955ff",
    );
    const three = { "member:bob": bob, pace, "member:carol": carol };
    expect(registerStateDigest({ closed: false, targets: three })).toBe("8d243bc3f8bf3126");
    expect(registerStateDigest({ closed: true, targets: three })).toBe("c3d2af7d419e5c5a");
  });

  it("reads nothing else: not the order of targets, nor fields a register or the state carries beside", () => {
    const ordered: RegisterState = {
      closed: false,
      targets: { pace, "member:carol": carol, "member:bob": bob },
    };
    const decorated = {
      closed: false,
      profile: "yjs-paragraphs/1",
      confirmed: true,
      targets: { "member:bob": { ...bob, from: "mallory" }, pace, "member:carol": carol },
    } as RegisterState;
    expect(registerStateDigest(ordered)).toBe("8d243bc3f8bf3126");
    expect(registerStateDigest(decorated)).toBe("8d243bc3f8bf3126");
  });

  it("the control clock is the greatest clock among the registers, [0, 0] without any", () => {
    expect(controlClockOf(EMPTY_REGISTER_STATE)).toEqual(ZERO_CLOCK);
    expect(controlClockOf({ closed: true, targets: {} })).toEqual(ZERO_CLOCK);
    expect(
      controlClockOf({
        closed: false,
        targets: { "member:bob": bob, pace, "member:carol": carol },
      }),
    ).toEqual(carol.clock);
  });
});

// ---------------------------------------------------------------- the algebra

describe("merging (CTL-22)", () => {
  it("is commutative, associative and idempotent, also at equal clock and device", () => {
    const rng = new Rng(47);
    const tags = ["AAAAAAAAAAAAAAAAAAAAAA", "BBBBBBBBBBBBBBBBBBBBBB", "CCCCCCCCCCCCCCCCCCCCCC"];
    const targets = ["pace", "member:bob", "member:carol", `layer:${LAYER}:member:bob`];
    const randomState = (): RegisterState => {
      let state: RegisterState = { closed: rng.chance(0.2), targets: {} };
      for (let i = 0; i < 6; i++) {
        const target = rng.pick(targets);
        const register: Register = {
          value: rng.pick(valuesOf(target)),
          clock: [START + rng.int(3) * SECOND, rng.int(2)],
          device: rng.pick(tags),
        };
        state = mergeRegisterStates(state, one(target, register));
      }
      return state;
    };
    let violations = 0;
    let ties = 0;
    for (let i = 0; i < 5_000; i++) {
      const [a, b, c] = [randomState(), randomState(), randomState()];
      const ab = keyOf(mergeRegisterStates(a, b));
      if (ab !== keyOf(mergeRegisterStates(b, a))) violations++;
      if (
        keyOf(mergeRegisterStates(mergeRegisterStates(a, b), c)) !==
        keyOf(mergeRegisterStates(a, mergeRegisterStates(b, c)))
      ) {
        violations++;
      }
      if (keyOf(mergeRegisterStates(a, a)) !== keyOf(a)) violations++;
      for (const [target, register] of Object.entries(a.targets)) {
        const other = b.targets[target];
        if (
          other &&
          compareClocks(other.clock, register.clock) === 0 &&
          other.device === register.device &&
          other.value !== register.value
        ) {
          ties++;
        }
      }
    }
    expect(ties, "the triples hold ties to settle").toBeGreaterThan(100);
    expect(violations).toBe(0);
  });
});

// ---------------------------------------------------------------- random histories

interface Op {
  readonly id: number;
  readonly target: string;
  readonly register: Register;
  readonly real: number;
  /** What its device knew on its target: registers it held, and what their deciders knew there. */
  readonly knewOnTarget: ReadonlySet<number>;
  /** Everything its device knew, on any target: a frame passes on all its decider knew. */
  readonly knewAll: ReadonlySet<number>;
}

interface Payload {
  readonly state: RegisterState;
  readonly fromCreator: boolean;
  readonly knowsOnTarget: ReadonlySet<number>;
  readonly knowsAll: ReadonlySet<number>;
}

interface Message extends Payload {
  readonly to: number;
  readonly from: number;
  sent: boolean;
}

interface Tally {
  runs: number;
  decisions: number;
  lost: number;
  duplicated: number;
  neededHealing: number;
  diverged: number;
  notTheSetsFunction: number;
  causalPairs: number;
  causalViolations: number;
  crossPairs: number;
  crossViolations: number;
  heldOverKnown: number;
  concurrent: number;
  laterHolds: number;
  closedRuns: number;
  closeFellBack: number;
  closeInconsistent: number;
  raiseViolations: number;
  maxLeadMs: number;
  ties: number;
}

class Replica {
  state: RegisterState = EMPTY_REGISTER_STATE;
  own: Clock = ZERO_CLOCK;
  knownOnTarget = new Set<number>();
  knownAll = new Set<number>();
  online = true;
  active = true;
  constructor(
    readonly name: string,
    readonly creator: boolean,
    public tag: string,
    public offset: number,
  ) {}
  wall(real: number): number {
    return real + this.offset;
  }
  receive(p: Payload, real: number, tally?: Tally): void {
    for (const [target, register] of Object.entries(p.state.targets)) {
      const mine = this.state.targets[target];
      if (
        mine &&
        tally &&
        compareClocks(mine.clock, register.clock) === 0 &&
        mine.device === register.device &&
        mine.value !== register.value
      ) {
        tally.ties++;
      }
    }
    // The close counts only from the creator's identity (CTL-5); a member's whole state passes on
    // the registers it holds.
    this.state = mergeRegisterStates(
      this.state,
      p.fromCreator ? p.state : { closed: false, targets: p.state.targets },
    );
    if (this.creator) {
      const now = this.wall(real);
      for (const register of Object.values(p.state.targets)) {
        this.own = raiseClock(this.own, register.clock, now);
        const cap = clockCap(now);
        const floor = compareClocks(register.clock, cap) > 0 ? cap : register.clock;
        if (tally && compareClocks(this.own, floor) < 0) tally.raiseViolations++;
      }
      if (tally) tally.maxLeadMs = Math.max(tally.maxLeadMs, lead(this.own, now));
    }
    for (const id of p.knowsOnTarget) this.knownOnTarget.add(id);
    for (const id of p.knowsAll) this.knownAll.add(id);
  }
  snapshot(): Payload {
    return {
      state: this.state,
      fromCreator: this.creator,
      knowsOnTarget: new Set(this.knownOnTarget),
      knowsAll: new Set(this.knownAll),
    };
  }
}

class World {
  readonly ops: Op[] = [];
  readonly opOf = new Map<Register, Op>();
  readonly inflight: Message[] = [];
  closes = 0;
  real = START;
  constructor(
    readonly replicas: Replica[],
    readonly tally?: Tally,
  ) {}

  /** A register that exists before the history starts, known to everyone given it. */
  inject(target: string, register: Register): Op {
    return this.#record(target, register, new Set(), new Set());
  }

  #record(target: string, register: Register, knewOnTarget: Set<number>, knewAll: Set<number>): Op {
    const op: Op = {
      id: this.ops.length,
      target,
      register,
      real: this.real,
      knewOnTarget,
      knewAll,
    };
    this.ops.push(op);
    this.opOf.set(register, op);
    return op;
  }

  decide(i: number, target: string, value: RegisterValue): Op | undefined {
    const d = this.replicas[i] as Replica;
    const now = d.wall(this.real);
    const decided = decideRegister({
      held: d.state,
      target: target as RegisterTarget,
      value,
      device: d.tag,
      own: d.own,
      now,
    });
    if (decided === undefined) return undefined;
    const knewOnTarget = new Set(
      [...d.knownOnTarget].filter((id) => this.ops[id]?.target === target),
    );
    const op = this.#record(target, decided.register, knewOnTarget, new Set(d.knownAll));
    d.own = decided.own;
    d.state = mergeRegisterStates(d.state, one(target, decided.register));
    d.knownOnTarget.add(op.id);
    d.knownAll.add(op.id);
    if (this.tally) this.tally.maxLeadMs = Math.max(this.tally.maxLeadMs, lead(d.own, now));
    return op;
  }

  /** The frame of a decision: its register, and what its device knew. */
  frameOf(op: Op): Payload {
    return {
      state: one(op.target, op.register),
      fromCreator: true,
      knowsOnTarget: new Set([...op.knewOnTarget, op.id]),
      knowsAll: new Set([...op.knewAll, op.id]),
    };
  }

  close(i: number): Payload {
    const d = this.replicas[i] as Replica;
    d.state = mergeRegisterStates(d.state, { closed: true, targets: {} });
    this.closes++;
    // A close carries no register, so no knowledge of decisions.
    return {
      state: { closed: true, targets: {} },
      fromCreator: true,
      knowsOnTarget: new Set(),
      knowsAll: new Set(),
    };
  }

  /** A frame to every other replica (a group message), on its way once its sender is online. */
  broadcast(from: number, p: Payload): void {
    this.replicas.forEach((r, to) => {
      if (to !== from && r.active) {
        this.inflight.push({ ...p, to, from, sent: (this.replicas[from] as Replica).online });
      }
    });
  }

  /** Straight to one replica (scenarios). */
  send(from: number, to: number, p?: Payload): void {
    (this.replicas[to] as Replica).receive(
      p ?? (this.replicas[from] as Replica).snapshot(),
      this.real,
      this.tally,
    );
  }

  /**
   * Per target the register that holds over all that were ever decided, and the close: CTL-22 as
   * its text reads, written out here rather than taken from registers.ts.
   */
  oracle(): string {
    const best = new Map<string, Register>();
    for (const op of this.ops) {
      const held = best.get(op.target);
      if (held === undefined || referenceHolds(op.target, op.register, held))
        best.set(op.target, op.register);
    }
    return keyOf({ closed: this.closes > 0, targets: Object.fromEntries(best) });
  }

  /** The decisions on a target that no other decision on it made in knowledge of them. */
  maximal(target: string): Op[] {
    const on = this.ops.filter((op) => op.target === target);
    return on.filter((o) => !on.some((p) => p.id !== o.id && p.knewOnTarget.has(o.id)));
  }
}

interface Config {
  readonly name: string;
  readonly offsets: (rng: Rng) => [number, number, number];
  /** C is a backup of A put back under A's tag. */
  readonly clone?: boolean;
  /** Everyone holds, from the start, a register a year ahead. */
  readonly future?: boolean;
  /** No wall clock is far enough off for the span to cap anything. */
  readonly withinSpan?: boolean;
}

const skew = (rng: Rng) => rng.between(-10 * MINUTE, 10 * MINUTE);
const CONFIGS: readonly Config[] = [
  { name: "exact", offsets: () => [0, 0, 0], withinSpan: true },
  { name: "±10 min", offsets: (r) => [skew(r), skew(r), skew(r)], withinSpan: true },
  {
    name: "±10 min, one device +1 day",
    offsets: (r) => {
      const o: [number, number, number] = [skew(r), skew(r), skew(r)];
      const i = r.int(3);
      o[i] = (o[i] as number) + DAY;
      return o;
    },
  },
  {
    name: "±10 min, one device −1 day",
    offsets: (r) => {
      const o: [number, number, number] = [skew(r), skew(r), skew(r)];
      const i = r.int(3);
      o[i] = (o[i] as number) - DAY;
      return o;
    },
  },
  // B a day ahead pulls A and the backup C to one millisecond, where their counters run alike: equal
  // clock and tag with different values.
  {
    name: "backup under its old tag, B +1 day",
    offsets: (r) => [skew(r), skew(r) + DAY, skew(r)],
    clone: true,
  },
  {
    name: "±10 min, a register a year ahead",
    offsets: (r) => [skew(r), skew(r), skew(r)],
    future: true,
  },
];
const RUNS = 1_000;

function runHistory(seed: number, config: Config, t: Tally): void {
  const rng = new Rng(seed);
  const members = ["bob", "carol", "dave", "eve"].slice(0, 2 + rng.int(3));
  const targets = [
    "pace",
    ...members.map((m) => `member:${m}`),
    ...members.map((m) => `layer:${LAYER}:member:${m}`),
  ];
  const offsets = config.offsets(rng);
  const replicas = [
    new Replica("A", true, rng.tag(), offsets[0]),
    new Replica("B", true, rng.tag(), offsets[1]),
    new Replica("C", true, rng.tag(), offsets[2]),
    ...members.map((m) => new Replica(m, false, "", 0)),
  ];
  const w = new World(replicas, t);
  if (config.future) {
    // On a target the history decides on: every decision on it must hold over the register ahead.
    const op = w.inject("member:bob", {
      value: "write",
      clock: [START + YEAR, 0],
      device: rng.tag(),
    });
    for (const r of replicas) r.receive(w.frameOf(op), START, t);
  }
  const events = 10 + rng.int(40);
  const backupAt = Math.floor(events / 6);
  const restoreAt = Math.floor(events / 3);
  let backup: Pick<Replica, "state" | "own" | "knownOnTarget" | "knownAll"> | undefined;
  if (config.clone) {
    (replicas[2] as Replica).active = false;
    (replicas[2] as Replica).online = false;
  }
  const wasClosed = replicas.map(() => false);
  const checkClose = () =>
    replicas.forEach((r, i) => {
      if (wasClosed[i] && !r.state.closed) t.closeFellBack++;
      wasClosed[i] = r.state.closed;
    });

  for (let e = 0; e < events; e++) {
    const s = rng.next();
    w.real +=
      s < 0.6
        ? rng.between(SECOND, MINUTE)
        : s < 0.9
          ? rng.between(MINUTE, 30 * MINUTE)
          : rng.between(HOUR, 12 * HOUR);
    const a = replicas[0] as Replica;
    if (config.clone && e === backupAt) {
      backup = {
        state: a.state,
        own: a.own,
        knownOnTarget: new Set(a.knownOnTarget),
        knownAll: new Set(a.knownAll),
      };
    }
    if (config.clone && e === restoreAt && backup) {
      const c = replicas[2] as Replica;
      c.state = backup.state;
      c.own = backup.own;
      c.knownOnTarget = new Set(backup.knownOnTarget);
      c.knownAll = new Set(backup.knownAll);
      c.tag = a.tag;
      c.active = true;
      c.online = true;
    }
    const creators = [0, 1, 2].filter((i) => (replicas[i] as Replica).active);
    const k = rng.next();
    if (k < 0.3) {
      const i = rng.pick(creators);
      if (rng.chance(0.03)) {
        w.broadcast(i, w.close(i));
      } else {
        const target = rng.pick(targets);
        const op = w.decide(i, target, rng.pick(valuesOf(target)));
        if (op === undefined) continue;
        w.broadcast(i, rng.chance(0.5) ? (replicas[i] as Replica).snapshot() : w.frameOf(op));
      }
    } else if (k < 0.7) {
      const ready = w.inflight.filter(
        (m) => m.sent && replicas[m.to]?.online && replicas[m.to]?.active,
      );
      if (ready.length === 0) continue;
      const m = rng.pick(ready);
      w.inflight.splice(w.inflight.indexOf(m), 1);
      if (rng.chance(0.15)) {
        t.lost++;
        continue;
      }
      (replicas[m.to] as Replica).receive(m, w.real, t);
      if (rng.chance(0.1)) {
        t.duplicated++;
        w.inflight.push({ ...m });
      }
    } else if (k < 0.85) {
      const actives = replicas.map((_, i) => i).filter((i) => replicas[i]?.active);
      const i = rng.pick(actives);
      const r = replicas[i] as Replica;
      r.online = !r.online;
      if (r.online) for (const m of w.inflight) if (m.from === i) m.sent = true;
    } else {
      // A whole state from anyone to anyone: an answer to a request (any member may answer).
      const actives = replicas.map((_, i) => i).filter((i) => replicas[i]?.active);
      const online = actives.filter((i) => replicas[i]?.online);
      if (online.length === 0) continue;
      const from = rng.pick(online);
      const to = rng.pick(actives.filter((i) => i !== from));
      w.inflight.push({ ...(replicas[from] as Replica).snapshot(), to, from, sent: true });
    }
    checkClose();
  }

  // Healing: everyone online; what is on its way arrives or is lost; then one whole state from
  // everyone to everyone, in random order, some twice.
  for (const r of replicas) {
    r.online = true;
    r.active = true;
  }
  for (const m of w.inflight) m.sent = true;
  while (w.inflight.length > 0) {
    const m = w.inflight.splice(rng.int(w.inflight.length), 1)[0] as Message;
    if (rng.chance(0.15)) {
      t.lost++;
      continue;
    }
    (replicas[m.to] as Replica).receive(m, w.real, t);
    if (rng.chance(0.1)) {
      t.duplicated++;
      w.inflight.push({ ...m });
    }
    checkClose();
  }
  w.real += MINUTE;
  const oracle = w.oracle();
  if (replicas.some((r) => keyOf(r.state) !== oracle)) t.neededHealing++;
  const snapshots = replicas.map((r) => r.snapshot());
  const round: { to: number; p: Payload }[] = [];
  replicas.forEach((_, from) => {
    replicas.forEach((__, to) => {
      if (from !== to) {
        round.push({ to, p: snapshots[from] as Payload });
        if (rng.chance(0.1)) {
          t.duplicated++;
          round.push({ to, p: snapshots[from] as Payload });
        }
      }
    });
  });
  for (const { to, p } of rng.shuffle(round)) {
    (replicas[to] as Replica).receive(p, w.real, t);
    checkClose();
  }

  t.runs++;
  t.decisions += w.ops.length;
  // Convergence: everyone the same, and that the function of the set of decisions.
  const states = replicas.map((r) => keyOf(r.state));
  if (states.some((s) => s !== states[0])) t.diverged++;
  if (states[0] !== oracle) t.notTheSetsFunction++;
  // In knowledge holds: on its target always; on any target where the span capped nothing.
  for (const p of w.ops) {
    for (const id of p.knewOnTarget) {
      t.causalPairs++;
      if (compareClocks((w.ops[id] as Op).register.clock, p.register.clock) >= 0)
        t.causalViolations++;
    }
    for (const id of p.knewAll) {
      t.crossPairs++;
      if (compareClocks((w.ops[id] as Op).register.clock, p.register.clock) >= 0)
        t.crossViolations++;
    }
  }
  const final = (replicas[0] as Replica).state.targets;
  for (const target of new Set(w.ops.map((op) => op.target))) {
    const winner = final[target];
    const op = winner && w.opOf.get(winner);
    if (op === undefined || !w.maximal(target).includes(op)) t.heldOverKnown++;
  }
  // The later of two concurrent decisions on a member, by the wall clock.
  for (const target of targets.filter((x) => x.startsWith("member:"))) {
    const maximal = w.maximal(target);
    if (maximal.length < 2) continue;
    t.concurrent++;
    const latest = maximal.reduce((x, y) => (y.real > x.real ? y : x));
    if (final[target] === latest.register) t.laterHolds++;
  }
  // The close: the same everywhere, and closed exactly when a device of the creator closed.
  if (w.closes > 0) t.closedRuns++;
  if (replicas.some((r) => r.state.closed !== w.closes > 0)) t.closeInconsistent++;
}

let cache: Map<string, Tally> | undefined;
function allRuns(): Map<string, Tally> {
  if (cache) return cache;
  cache = new Map();
  CONFIGS.forEach((config, c) => {
    const t: Tally = {
      runs: 0,
      decisions: 0,
      lost: 0,
      duplicated: 0,
      neededHealing: 0,
      diverged: 0,
      notTheSetsFunction: 0,
      causalPairs: 0,
      causalViolations: 0,
      crossPairs: 0,
      crossViolations: 0,
      heldOverKnown: 0,
      concurrent: 0,
      laterHolds: 0,
      closedRuns: 0,
      closeFellBack: 0,
      closeInconsistent: 0,
      raiseViolations: 0,
      maxLeadMs: 0,
      ties: 0,
    };
    for (let run = 0; run < RUNS; run++) runHistory((c + 1) * 1_000_000 + run, config, t);
    (cache as Map<string, Tally>).set(config.name, t);
  });
  return cache;
}

// Fixed-seed histories, CPU-bound, computed once by whichever test asks first; the outcome is
// deterministic, only the wall time varies (about 0.85 s alone, beyond 5 s on a loaded machine).
describe("registers over random histories (fixed seed)", { timeout: 60_000 }, () => {
  it("converge in any order, with losses and duplicates, to the function of the set of decisions", () => {
    for (const [name, t] of allRuns()) {
      expect(t.runs, name).toBe(RUNS);
      expect(t.lost, `${name}: messages were lost`).toBeGreaterThan(0);
      expect(t.duplicated, `${name}: messages came twice`).toBeGreaterThan(0);
      expect(t.neededHealing, `${name}: some histories needed the final round`).toBeGreaterThan(0);
      expect(t.diverged, name).toBe(0);
      expect(t.notTheSetsFunction, name).toBe(0);
    }
    expect(
      allRuns().get("backup under its old tag, B +1 day")?.ties,
      "a backup under its old tag ties",
    ).toBeGreaterThan(0);
  });

  it("hold a decision over every register its device knew on its target, however wrong the wall clocks", () => {
    for (const [name, t] of allRuns()) {
      expect(t.causalPairs, name).toBeGreaterThan(0);
      expect(t.causalViolations, name).toBe(0);
      expect(t.heldOverKnown, name).toBe(0);
    }
  });

  it("order a decision after everything its device knew on any target, where no wall clock is a day off", () => {
    for (const config of CONFIGS.filter((c) => c.withinSpan)) {
      const t = allRuns().get(config.name) as Tally;
      expect(t.crossPairs, config.name).toBeGreaterThan(0);
      expect(t.crossViolations, config.name).toBe(0);
    }
  });

  it("let the later of two concurrent decisions hold, when the wall clocks are exact", () => {
    const t = allRuns().get("exact") as Tally;
    expect(t.concurrent).toBeGreaterThan(50);
    expect(t.laterHolds).toBe(t.concurrent);
  });

  it("raise the own clock to what it merges, and never more than the span ahead of the wall clock", () => {
    for (const [name, t] of allRuns()) {
      expect(t.raiseViolations, name).toBe(0);
      expect(t.maxLeadMs, name).toBeLessThanOrEqual(CLOCK_SPAN_MS + 1);
    }
    // The register a year ahead pulls the own clocks as far as the span, and no further.
    expect(allRuns().get("±10 min, a register a year ahead")?.maxLeadMs).toBeGreaterThan(
      CLOCK_SPAN_MS - HOUR,
    );
  });

  it("keep the close: it never falls back and ends the same everywhere (LIF-7)", () => {
    for (const [name, t] of allRuns()) {
      expect(t.closedRuns, name).toBeGreaterThan(0);
      expect(t.closeFellBack, name).toBe(0);
      expect(t.closeInconsistent, name).toBe(0);
    }
  });
});

// ---------------------------------------------------------------- scenarios

describe("registers in scenarios", () => {
  it("a device whose wall clock lags a day decides in knowledge of one a day ahead: its decision holds", () => {
    const fast = new Replica("A", true, "AAAAAAAAAAAAAAAAAAAAAA", +DAY);
    const slow = new Replica("B", true, "BBBBBBBBBBBBBBBBBBBBBB", -DAY);
    const bob = new Replica("bob", false, "", 0);
    const w = new World([fast, slow, bob]);
    w.decide(0, "member:carol", "write");
    w.send(0, 1);
    w.real += MINUTE;
    w.decide(1, "member:carol", "read");
    w.send(1, 0);
    w.send(0, 2);
    w.send(1, 2);
    for (const r of [fast, slow, bob])
      expect(r.state.targets["member:carol"]?.value, r.name).toBe("read");
  });

  it("a backup put back under its old tag decides at the same clock: every receiver holds the narrower", () => {
    const tag = "AAAAAAAAAAAAAAAAAAAAAA";
    const clock: Clock = [START, 3];
    const layer = `layer:${LAYER}:member:bob`;
    for (const [target, a, b, narrower] of [
      ["member:bob", "write", "read", "read"],
      [layer, "write", null, null],
      ["pace", 2_000, 20_000, 20_000],
    ] as const) {
      const first = one(target, { value: a, clock, device: tag });
      const second = one(target, { value: b, clock, device: tag });
      const x = mergeRegisterStates(mergeRegisterStates(EMPTY_REGISTER_STATE, first), second);
      const y = mergeRegisterStates(mergeRegisterStates(EMPTY_REGISTER_STATE, second), first);
      expect(x.targets[target]?.value, target).toBe(narrower);
      expect(keyOf(y), target).toBe(keyOf(x));
    }
  });

  it("a register is merged whatever its clock: far ahead of the receiver's time, or at the end of the range", () => {
    const now = Date.now();
    const target = "member:mallory";
    const ahead: Register = {
      value: "write",
      clock: [now + YEAR, 0],
      device: "AAAAAAAAAAAAAAAAAAAAAA",
    };
    const end: Register = {
      value: "read",
      clock: [MAX_CLOCK_MS, MAX_CLOCK_COUNTER],
      device: "zzzzzzzzzzzzzzzzzzzzzz",
    };
    const present: Register = { value: null, clock: [now, 0], device: "BBBBBBBBBBBBBBBBBBBBBB" };
    const merged = [present, ahead].reduce(
      (s, r) => mergeRegisterStates(s, one(target, r)),
      EMPTY_REGISTER_STATE,
    );
    expect(merged.targets[target]).toBe(ahead);
    const orders = [
      [present, ahead, end],
      [end, present, ahead],
      [ahead, end, present],
    ];
    for (const order of orders) {
      const state = order.reduce(
        (s, r) => mergeRegisterStates(s, one(target, r)),
        EMPTY_REGISTER_STATE,
      );
      expect(state.targets[target]).toBe(end);
    }
  });

  it("above a register at the end of the range no decision can be ordered: it is refused, the register holds", () => {
    const target = "member:mallory";
    const top: Register = {
      value: "write",
      clock: [MAX_CLOCK_MS, MAX_CLOCK_COUNTER],
      device: "zzzzzzzzzzzzzzzzzzzzzz",
    };
    const held = one(target, top);
    expect(
      decideRegister({
        held,
        target,
        value: "read",
        device: "NNNNNNNNNNNNNNNNNNNNNN",
        own: [START, 0],
        now: START,
      }),
    ).toBeUndefined();
    expect(held.targets[target]?.value).toBe("write");
  });

  it("after a close, neither a stale state nor a register at the end of the range opens the document", () => {
    const a = new Replica("A", true, "AAAAAAAAAAAAAAAAAAAAAA", 0);
    const w = new World([a]);
    w.decide(0, "member:mallory", "read");
    const stale = a.snapshot();
    w.close(0);
    a.receive(stale, w.real);
    a.receive(
      {
        state: one("member:mallory", {
          value: "write",
          clock: [MAX_CLOCK_MS, MAX_CLOCK_COUNTER],
          device: "zzzzzzzzzzzzzzzzzzzzzz",
        }),
        fromCreator: true,
        knowsOnTarget: new Set(),
        knowsAll: new Set(),
      },
      w.real,
    );
    expect(a.state.closed).toBe(true);
    expect(
      mergeRegisterStates({ closed: true, targets: {} }, { closed: false, targets: {} }).closed,
    ).toBe(true);
    expect(
      mergeRegisterStates({ closed: false, targets: {} }, { closed: true, targets: {} }).closed,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------- the clock rule per target

describe("a decision lies above every register of its target, the own clock within the span", () => {
  /**
   * The creator's device A, its clock a year ahead for a moment, made Mallory a writer; Mallory, and
   * a member whose device she brought up, hold it. A new device N of the creator merges a member's
   * answer with it, its own clock rising no further than the span. N's person then decides on
   * Mallory: the decision holds everywhere, and no own clock of the creator's devices runs more
   * than the span ahead.
   */
  it("a deliberate decision overtakes a register far ahead that a new device merged", () => {
    const A = new Replica("A", true, "AAAAAAAAAAAAAAAAAAAAAA", 0);
    const B = new Replica("B", true, "BBBBBBBBBBBBBBBBBBBBBB", 3 * MINUTE);
    const N = new Replica("N", true, "NNNNNNNNNNNNNNNNNNNNNN", -2 * MINUTE);
    const bob = new Replica("bob", false, "", 0);
    const mallory = new Replica("mallory", false, "", 0);
    const dave = new Replica("dave", false, "", 0);
    const replicas = [A, B, N, bob, mallory, dave];
    const w = new World(replicas);
    const M = "member:mallory";
    const L = `layer:${LAYER}:member:mallory`;
    const BOB = "member:bob";

    w.decide(0, BOB, "write");
    w.decide(0, M, "read");
    w.decide(0, L, "read");
    w.decide(0, "pace", 5_000);
    for (const to of [1, 3, 4, 5]) w.send(0, to);

    // An hour later, A's decision on Mallory with its clock a year ahead reaches Mallory alone.
    w.real += HOUR;
    const yearAhead: Register = { value: "write", clock: [START + YEAR, 0], device: A.tag };
    A.state = mergeRegisterStates(A.state, one(M, yearAhead));
    mallory.state = mergeRegisterStates(mallory.state, one(M, yearAhead));
    w.send(4, 5); // Mallory brings Dave's device up; he holds what she holds.
    const answer = mallory.snapshot();
    // N merges the answer as any snapshot (CTL-25), its own clock raised within the span (CTL-45).
    const nNow = N.wall(w.real);
    N.state = mergeRegisterStates(N.state, answer.state);
    N.own = raiseClock(N.own, controlClockOf(answer.state), nNow);
    expect(N.state.targets[M]).toBe(yearAhead);
    expect(N.state.targets[BOB]?.value).toBe("write");
    expect(lead(N.own, nNow)).toBeLessThanOrEqual(CLOCK_SPAN_MS);
    expect(mallory.state.targets[M]?.value).toBe("write");
    expect(dave.state.targets[M]?.value).toBe("write");

    // N's person decides on Mallory: the decision lies above the register ahead, everywhere.
    w.real += MINUTE;
    const decision = w.decide(2, M, "read") as Op;
    expect(compareClocks(decision.register.clock, yearAhead.clock)).toBeGreaterThan(0);
    for (const to of [0, 1, 3, 4, 5]) w.send(2, to, w.frameOf(decision));
    for (const r of replicas) expect(r.state.targets[M]?.value, r.name).toBe("read");
    for (const r of replicas) expect(r.state.targets[M], r.name).toBe(decision.register);

    // No own clock of the creator's devices follows the register a year ahead beyond the span.
    for (const r of [A, B, N])
      expect(lead(r.own, r.wall(w.real)), r.name).toBeLessThanOrEqual(CLOCK_SPAN_MS + 1);

    // A decision on another target lies within the span, not near the register ahead, and one made
    // in knowledge of it, on any device of the creator, holds over it.
    w.real += MINUTE;
    const onBob = w.decide(2, BOB, "read") as Op;
    expect(lead(onBob.register.clock, N.wall(w.real))).toBeLessThanOrEqual(CLOCK_SPAN_MS + 1);
    expect(onBob.register.clock[0]).toBeLessThan(START + YEAR - 300 * DAY);
    for (const to of [0, 1, 3, 4, 5]) w.send(2, to, w.frameOf(onBob));
    w.real += MINUTE;
    const again = w.decide(0, BOB, "write") as Op;
    for (const to of [1, 2, 3, 4, 5]) w.send(0, to, w.frameOf(again));
    for (const r of replicas) expect(r.state.targets[BOB]?.value, r.name).toBe("write");
    // The layer right nobody decided anew stays as A decided it.
    for (const r of replicas) expect(r.state.targets[L]?.value, r.name).toBe("read");
    // Every replica holds the same.
    for (const r of replicas) expect(keyOf(r.state), r.name).toBe(keyOf(A.state));
  });
});

describe("a tie on the reason for the close, by Unicode code points (CTL-22, CTL-23)", () => {
  const A = "AAAAAAAAAAAAAAAAAAAAAA";
  const reason = (value: string): Register => ({ value, clock: [1, 0], device: A });
  const GRIN = "\u{1F600}"; // U+1F600, in UTF-16 the code units D83D DE00

  it("U+FF61 and U+FFFD come before U+1F600, though their UTF-16 code units come after: U+1F600 holds, in either order", () => {
    for (const low of ["\uFF61", "\uFFFD"]) {
      const name = `U+${low.codePointAt(0)?.toString(16).toUpperCase()}`;
      expect(mergeRegister(CLOSE_REASON, reason(low), reason(GRIN)).value, name).toBe(GRIN);
      expect(mergeRegister(CLOSE_REASON, reason(GRIN), reason(low)).value, name).toBe(GRIN);
      expect(compareRegisters(CLOSE_REASON, reason(GRIN), reason(low)), name).toBeGreaterThan(0);
      expect(compareCodePoints(low, GRIN), name).toBe(-1);
      expect(compareCodePoints(`a${GRIN}`, `a${low}`), name).toBe(1);
    }
    // A string that holds the code point and goes on comes after it; the same string is equal.
    expect(compareCodePoints(`${GRIN}a`, GRIN)).toBe(1);
    expect(compareCodePoints(GRIN, GRIN)).toBe(0);
  });
});
