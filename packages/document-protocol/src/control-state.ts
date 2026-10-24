/**
 * Control state as a set of operations (SPECIFICATION.md §7).
 *
 * Every operation is issued by one device of the creator and aimed at one target: a member's
 * permission, the close, or the pace. It names its device's random tag, that device's own counter
 * (1, 2, 3, … without gaps), and what the device had seen of the other creator devices when it
 * issued it: for each, the highest counter it held without a gap. Two devices never compete for a
 * number (CTL-20).
 *
 * An operation O supersedes P on the same target if O's device had seen P when it issued O, or P is
 * an earlier operation of O's own device (CTL-22). The value of a target is the narrowest value
 * among the operations on it that nothing supersedes (CTL-23): of two concurrent decisions the
 * narrower holds, and a decision made in knowledge of another stands, even when it is wider.
 *
 * Per target this keeps the element-wise maximum of what its operations had seen (`seen`) and the
 * operations nothing supersedes (`heads`): an operation is superseded exactly when `seen` covers
 * its counter, so superseded ones can be dropped and a late one is judged correctly — at most one
 * head per creator device and target remains. Merging is a union: the result depends on the set of
 * operations and snapshots received, not on their order or on duplicates (CTL-23, CTL-25).
 *
 * Pure: no messenger, no clock, no profile. Authority — that only operations the creator sent
 * count — is the engine's check (CTL-5).
 */

import { canonicalJson } from "./digest";

/** A member's permission as a control operation sets it; `null` revokes. */
export type MemberRight = "read" | "write" | null;

/**
 * What an operation is aimed at (§7.1): a member's permission, a member's right on one layer
 * (LAY-5), the close, or the pace.
 */
export type ControlTarget =
  | `member:${string}`
  | `layer:${string}:member:${string}`
  | "close"
  | "pace";

/** The form of a profile id, and of a layer id (§5.2, §5.6): `<name>/<major>`, without a colon. */
export const PROFILE_ID_FORM = /^[a-z0-9][a-z0-9.-]{0,99}\/[1-9][0-9]{0,5}$/;

/** The value an operation sets: a member's right, `true` for the close, milliseconds for the pace. */
export type ControlValue = MemberRight | true | number;

/** What a device had seen of the other creator devices: the highest counter of each without a gap. */
export type ControlVector = Readonly<Record<string, number>>;

export interface ControlOperation {
  readonly device: string;
  readonly counter: number;
  readonly target: ControlTarget;
  readonly value: ControlValue;
  /** The other creator devices' counters this device had seen without a gap; its own is implied. */
  readonly seen: ControlVector;
}

/** One target's state as a snapshot carries it (CTL-25). */
export interface TargetState {
  readonly seen: ControlVector;
  readonly heads: readonly Omit<ControlOperation, "target">[];
}

/** A control snapshot's operations part (CTL-25); the frame adds the profile. */
export interface ControlStateSnapshot {
  /** For every creator device that issued an operation, its highest counter without a gap. */
  readonly vector: ControlVector;
  readonly targets: Readonly<Record<string, TargetState>>;
  /**
   * For every creator device with counters held above a hole, those counters, ascending (§7.4,
   * §7.5): also those of operations something superseded, which no head carries, so that whoever
   * merges the snapshot holds the same holes. Absent when no device has a hole.
   */
  readonly aboveHoles?: Readonly<Record<string, readonly number[]>>;
}

/** Two different operations under one `(device, counter)` (CTL-24): both kept, reported. */
export interface ControlAnomaly {
  readonly device: string;
  readonly counter: number;
}

/** A device tag: 16 random bytes, base64url without padding (CTL-20). */
export const DEVICE_TAG = /^[A-Za-z0-9_-]{22}$/;

/** The most creator devices one document's control state tracks (CTL-30). */
export const MAX_CREATOR_DEVICES = 64;

/** The most counters held above a hole, per creator device, before more are refused (CTL-30). */
export const MAX_COUNTERS_AHEAD = 1024;

/**
 * The most targets: 5 000 members, the close and the pace (CTL-30). More would never fit in the
 * bytes a device of the creator issues up to (MAX_ISSUE_BYTES): a target takes about 110 bytes at
 * the least.
 */
export const MAX_TARGETS = 5_002;

/**
 * The most bytes of control state CTL-30 lets a receiver hold, measured in the control digest's
 * form: the UTF-8 of the RFC 8785 form of its snapshot's `vector`, `targets` and `aboveHoles`
 * (CTL-34, LOS-12). 3 MiB, so that the union of three devices of the creator that each grew to
 * MAX_ISSUE_BYTES at once still fits, and a snapshot of it fits in a message of the bindings
 * (4 MiB). Beyond them a receiver refuses, and is in a capacity conflict (CTL-32).
 */
export const ACCEPTED_CONTROL_BYTES = 3_145_728;

/** The most bytes of control state this engine holds (CTL-30), and a `ControlState` by default. */
export const MAX_CONTROL_BYTES = ACCEPTED_CONTROL_BYTES;

/**
 * The most bytes a device of the creator brings control state to with an operation that adds a
 * target (CTL-37). A revocation or any change of a right it holds may go up to MAX_CONTROL_BYTES,
 * while there is room; the close is not measured and always holds.
 */
export const MAX_ISSUE_BYTES = 1_048_576;

/** The most bytes one operation can add to a snapshot: its target, its head and what it had seen. */
function bytesAddedAtMost(op: ControlOperation): number {
  return utf8Length(JSON.stringify(op)) * 2 + 64;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** A member's permission, narrowest first (CTL-23): revoked before `read` before `write`. */
const RIGHT_ORDER: Readonly<Record<string, number>> = { null: 0, read: 1, write: 2 };

/**
 * A right on a layer, narrowest first (CTL-23, LAY-5): `read` before inherit (`null`) before
 * `write`. What a member inherits is its permission on the document, which never lies outside
 * `read` and `write` where it lets anything be written at all, so the narrowest value is the
 * narrowest effective right whatever the document right is.
 */
const LAYER_ORDER: Readonly<Record<string, number>> = { read: 0, null: 1, write: 2 };

/** A new device tag: 16 random bytes, base64url without padding (CTL-20). */
export function newDeviceTag(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let bits = 0;
  let value = 0;
  let tag = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      tag += alphabet[(value >> bits) & 63];
    }
  }
  return bits > 0 ? tag + alphabet[(value << (6 - bits)) & 63] : tag;
}

/** Whether `target` is a target this draft defines. */
export function isControlTarget(target: string): target is ControlTarget {
  return (
    target === "close" ||
    target === "pace" ||
    target.startsWith("member:") ||
    layerTargetOf(target) !== undefined
  );
}

/** The member a `member:` target, or a layer right's target, names. */
export function memberOf(target: ControlTarget): string | undefined {
  if (target.startsWith("member:")) {
    return target.slice("member:".length);
  }
  return layerTargetOf(target)?.member;
}

/**
 * The layer and the member a layer right's target names: `layer:<layer id>:member:<MemberId>`. A
 * layer id holds no colon, so the first `:member:` ends it.
 */
export function layerTargetOf(
  target: string,
): { readonly layer: string; readonly member: string } | undefined {
  if (!target.startsWith("layer:")) {
    return undefined;
  }
  const rest = target.slice("layer:".length);
  const at = rest.indexOf(":member:");
  if (at === -1) {
    return undefined;
  }
  const layer = rest.slice(0, at);
  return PROFILE_ID_FORM.test(layer)
    ? { layer, member: rest.slice(at + ":member:".length) }
    : undefined;
}

/** Whether `value` fits `target` (CTL-20). */
export function valueFitsTarget(target: ControlTarget, value: unknown): value is ControlValue {
  if (target === "close") {
    return value === true;
  }
  if (target === "pace") {
    return (
      typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff
    );
  }
  return value === null || value === "read" || value === "write";
}

/** What an operation had seen, its own device included: every earlier operation of its own. */
function effectiveSeen(op: Omit<ControlOperation, "target">): ControlVector {
  return { ...op.seen, [op.device]: Math.max(op.seen[op.device] ?? 0, op.counter - 1) };
}

/** Canonical text of an operation, for "the same operation" and for digests. */
export function operationKey(op: Omit<ControlOperation, "target">, target: string): string {
  const seen = Object.keys(op.seen)
    .sort()
    .map((device) => [device, op.seen[device]]);
  return JSON.stringify([op.device, op.counter, target, op.value, seen]);
}

/**
 * `vector` without entries of 0: a receiver reads an entry of 0 as absent and holds nothing for it
 * (FRM-14), so that equal states have one spelling and one control digest (LOS-12).
 */
function withoutZeros(vector: ControlVector): ControlVector {
  return Object.values(vector).includes(0)
    ? Object.fromEntries(Object.entries(vector).filter(([, counter]) => counter !== 0))
    : vector;
}

function maxInto(into: Map<string, number>, vector: ControlVector): void {
  for (const [device, counter] of Object.entries(vector)) {
    if (counter > (into.get(device) ?? 0)) {
      into.set(device, counter);
    }
  }
}

class Target {
  readonly seen = new Map<string, number>();

  constructor(readonly name: string) {}

  heads: Omit<ControlOperation, "target">[] = [];

  copy(): Target {
    const copy = new Target(this.name);
    for (const [device, counter] of this.seen) copy.seen.set(device, counter);
    copy.heads = [...this.heads];
    return copy;
  }

  /**
   * Adds an operation's knowledge and keeps only what nothing supersedes. The close keeps no `seen`
   * (CTL-36): a close supersedes nothing but its own device's earlier close, and what it had seen
   * would grow with every device that closes.
   */
  add(op: Omit<ControlOperation, "target">): void {
    if (this.name !== "close") maxInto(this.seen, effectiveSeen(op));
    this.#keep([...this.heads, op]);
  }

  merge(state: TargetState): void {
    if (this.name !== "close") maxInto(this.seen, state.seen);
    this.#keep([...this.heads, ...state.heads]);
  }

  /**
   * The candidates nothing supersedes, one per device and counter: the same operation from two
   * sources is one, and different ones under one counter are merged into one (CTL-24).
   */
  #keep(candidates: readonly Omit<ControlOperation, "target">[]): void {
    const byDot = new Map<string, Omit<ControlOperation, "target">>();
    for (const head of candidates) {
      if ((this.seen.get(head.device) ?? 0) >= head.counter) {
        continue;
      }
      const dot = `${head.device}:${head.counter}`;
      const held = byDot.get(dot);
      byDot.set(dot, held === undefined ? head : collide(this.name, held, head));
    }
    if (this.name === "close") {
      // Of the close, each device's latest, and of those the devices whose tags come first in code
      // point order (CTL-36), as at the bound on devices (CTL-35): a bounded record whatever the
      // order of arrival. Giving one up never reopens the document (LIF-7).
      const latest = new Map<string, Omit<ControlOperation, "target">>();
      for (const head of byDot.values()) {
        const held = latest.get(head.device);
        if (held === undefined || head.counter > held.counter) latest.set(head.device, head);
      }
      this.heads = [...latest.values()]
        .sort((a, b) => compareCodePoints(a.device, b.device))
        .slice(0, MAX_CREATOR_DEVICES);
      return;
    }
    this.heads = [...byDot.values()];
  }
}

/**
 * The value of one target as a report holds it (CTL-23): the narrowest of its heads, by the target's
 * order; `undefined` for none. For display only (CTL-29).
 */
export function valueOfHeads(
  target: string,
  heads: readonly Omit<ControlOperation, "target">[],
): ControlValue | undefined {
  if (heads.length === 0) {
    return undefined;
  }
  return heads.map((head) => head.value).reduce((a, b) => narrowestValue(target, a, b));
}

/**
 * Two different operations under one (device, counter) on one target as one (CTL-24): the
 * narrowest of their values (CTL-23) and everything either had seen. Commutative and associative,
 * so the result does not depend on which arrived first.
 */
function collide(
  target: string,
  a: Omit<ControlOperation, "target">,
  b: Omit<ControlOperation, "target">,
): Omit<ControlOperation, "target"> {
  if (operationKey(a, "") === operationKey(b, "")) {
    return a;
  }
  const seen = new Map<string, number>();
  maxInto(seen, a.seen);
  maxInto(seen, b.seen);
  return {
    device: a.device,
    counter: a.counter,
    value: narrowestValue(target, a.value, b.value),
    seen: Object.fromEntries([...seen].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))),
  };
}

/**
 * The narrower of two values of one target (CTL-23): for a member revoked before read before
 * write, on a layer read before inherit before write (LAY-5); the longer pace.
 */
function narrowestValue(target: string, a: ControlValue, b: ControlValue): ControlValue {
  if (target === "pace") {
    return Math.max(a as number, b as number);
  }
  if (target === "close") {
    return true;
  }
  const rights = [a as MemberRight, b as MemberRight];
  return (
    target.startsWith("layer:") ? narrowestLayerRight(rights) : narrowestRight(rights)
  ) as MemberRight;
}

/** Everything a control state holds, to go back to when an operation would exceed its bytes. */
interface SavedState {
  readonly targets: Map<string, Target>;
  readonly contiguous: Map<string, number>;
  readonly ahead: Map<string, Set<number>>;
  readonly byDot: Map<string, Set<string>>;
  readonly anomalies: Map<string, ControlAnomaly>;
  readonly closed: boolean;
  readonly capacityConflict: boolean;
  readonly bytes: number | undefined;
  readonly upper: number;
}

/** The dots and canonical texts of a target's heads, to keep the index of heads up to date. */
function headKeys(target: Target | undefined): Map<string, string> {
  const keys = new Map<string, string>();
  for (const head of target?.heads ?? []) {
    keys.set(operationKey(head, target?.name ?? ""), `${head.device}:${head.counter}`);
  }
  return keys;
}

/** How much a control state holds (CTL-30). */
export interface ControlStateOptions {
  /** The most bytes it holds, as a snapshot carries it; MAX_CONTROL_BYTES by default. */
  readonly maxBytes?: number;
}

export class ControlState {
  /** The most bytes this state holds (CTL-30). */
  readonly maxBytes: number;
  #targets = new Map<string, Target>();
  /** Per creator device: the highest counter held without a gap. */
  #contiguous = new Map<string, number>();
  /** Per creator device: counters held above the contiguous one (holes below them). */
  #ahead = new Map<string, Set<number>>();
  /**
   * Per creator device and counter: the canonical operations held under it as heads (CTL-24). Only
   * heads: what a snapshot carries, so that a restored state finds the collisions a live one finds
   * (CTL-31), and bounded by the bounds on what a state holds (CTL-30) for an instance's life.
   */
  #byDot = new Map<string, Set<string>>();
  /** Collisions under a device and counter still held as a head (CTL-24, CTL-31); bounded with `#byDot`. */
  #anomalies = new Map<string, ControlAnomaly>();
  /** Whether an operation or a snapshot was refused for the bytes of control state (CTL-32). */
  #capacityConflict = false;
  // Raised by every call that may change what a snapshot holds, so a digest of it can be kept.
  #revision = 0;
  #closed = false;
  /** The size of `snapshot()` in RFC 8785, once measured; forgotten on every change (CTL-34). */
  #bytes: number | undefined;
  /** At least `bytes`, kept without measuring, so that only an operation near the bound measures. */
  #upper = 64;

  constructor(options: ControlStateOptions = {}) {
    this.maxBytes = options.maxBytes ?? MAX_CONTROL_BYTES;
  }

  /**
   * The control state's size in bytes (CTL-34, MAX_CONTROL_BYTES): its snapshot's `vector`,
   * `targets` and `aboveHoles` in RFC 8785, the control digest's form (LOS-12), so that every
   * receiver measures the same state alike — without the close (`measured`).
   */
  get bytes(): number {
    this.#bytes ??= utf8Length(canonicalJson(this.#measured()));
    return this.#bytes;
  }

  /**
   * What CTL-34 measures: the snapshot without the close. `targets` leaves out `close`;
   * `aboveHoles` leaves out the counter of an operation on it; `vector` names a device whose
   * highest counter without a gap is its close with the counter below, and not at all where that
   * is 0. So a close never makes the state larger — where it fills a hole, counters move from
   * `aboveHoles` into the vector, which is shorter —, a full document can always be closed (LIF-6,
   * LIF-7), and a receiver that took the close as an operation and one that took it in a snapshot
   * measure the same state alike. The close is bounded by the devices instead: one head each.
   */
  #measured(): ControlStateSnapshot {
    const snapshot = this.snapshot();
    const closes = new Set(
      (this.#targets.get("close")?.heads ?? []).map((head) => `${head.device}:${head.counter}`),
    );
    const targets = Object.fromEntries(
      Object.entries(snapshot.targets).filter(([name]) => name !== "close"),
    );
    const vector = Object.fromEntries(
      Object.entries(snapshot.vector).flatMap(([device, counter]) => {
        const measured = closes.has(`${device}:${counter}`) ? counter - 1 : counter;
        return measured > 0 ? [[device, measured] as const] : [];
      }),
    );
    const aboveHoles = Object.entries(snapshot.aboveHoles ?? {}).flatMap(([device, counters]) => {
      const kept = counters.filter((counter) => !closes.has(`${device}:${counter}`));
      return kept.length === 0 ? [] : [[device, kept] as const];
    });
    return {
      vector,
      targets,
      ...(aboveHoles.length === 0 ? {} : { aboveHoles: Object.fromEntries(aboveHoles) }),
    };
  }

  /** At least `bytes`, without measuring: what a caller checks before it measures. */
  get bytesAtMost(): number {
    return this.#bytes ?? this.#upper;
  }

  /** Whether any operation closed the document; never undone (LIF-7). */
  get closed(): boolean {
    return this.#closed;
  }

  /** The control vector: every creator device's highest counter without a gap (§7.4). */
  get vector(): ControlVector {
    return Object.fromEntries(this.#contiguous);
  }

  /** Whether a creator device's counters have a hole: one held above a missing one (LOS-10). */
  get hasHoles(): boolean {
    for (const ahead of this.#ahead.values()) {
      if (ahead.size > 0) {
        return true;
      }
    }
    return false;
  }

  /** Whether no operation has been merged yet. */
  get isEmpty(): boolean {
    return this.#contiguous.size === 0 && this.#ahead.size === 0 && this.#targets.size === 0;
  }

  /**
   * Places where two different operations share a device and counter (CTL-24), as long as one of
   * them is held as a head: once a later decision supersedes the place, nothing of it is left.
   */
  get anomalies(): readonly ControlAnomaly[] {
    return [...this.#anomalies.values()];
  }

  /**
   * Whether this state could not hold an operation or a snapshot for its bytes (CTL-32): a capacity
   * conflict, which no later operation ends. Meanwhile it takes no operation on a member or a layer
   * right it does not hold, and its engine refuses its own edits.
   */
  get capacityConflict(): boolean {
    return this.#capacityConflict;
  }

  /** Enters a capacity conflict this state's owner persisted before a restart (CTL-32). */
  markCapacityConflict(): void {
    this.#capacityConflict = true;
  }

  /** The members with a permission, as the narrowest unsuperseded operation on each says (CTL-23). */
  get members(): ReadonlyMap<string, "read" | "write"> {
    const result = new Map<string, "read" | "write">();
    for (const [target, state] of this.#targets) {
      if (!target.startsWith("member:")) {
        continue;
      }
      const member = target.slice("member:".length);
      const value = narrowestRight(state.heads.map((head) => head.value as MemberRight));
      if (value !== null && value !== undefined) {
        result.set(member, value);
      }
    }
    return result;
  }

  /**
   * The members whose permission the creator revoked: the narrowest unsuperseded operation on
   * their target is a revocation (CTL-23). Revoked is not unknown: CTL-13 refuses their edits as
   * it refuses a reader's, on the document and on every layer.
   */
  get revoked(): ReadonlySet<string> {
    const result = new Set<string>();
    for (const [target, state] of this.#targets) {
      if (target.startsWith("member:") && state.heads.length > 0) {
        if (narrowestRight(state.heads.map((head) => head.value as MemberRight)) === null) {
          result.add(target.slice("member:".length));
        }
      }
    }
    return result;
  }

  /**
   * The members' rights on layers, by layer and then member, as the narrowest unsuperseded
   * operation on each says, `read` before inherit before `write` (CTL-23, LAY-5); one that
   * inherits is absent, so the member's permission on the document applies there.
   */
  get layerRights(): ReadonlyMap<string, ReadonlyMap<string, "read" | "write">> {
    const result = new Map<string, Map<string, "read" | "write">>();
    for (const [target, state] of this.#targets) {
      const named = layerTargetOf(target);
      if (named === undefined) {
        continue;
      }
      const value = narrowestLayerRight(state.heads.map((head) => head.value as MemberRight));
      if (value !== null && value !== undefined) {
        const rights = result.get(named.layer) ?? new Map<string, "read" | "write">();
        rights.set(named.member, value);
        result.set(named.layer, rights);
      }
    }
    return result;
  }

  /** The pace the creator set: the longest interval among the unsuperseded operations; `undefined` if none. */
  get pace(): number | undefined {
    const heads = this.#targets.get("pace")?.heads ?? [];
    return heads.length === 0 ? undefined : Math.max(...heads.map((head) => head.value as number));
  }

  /**
   * The value of one target (CTL-23): the narrowest of the operations on it that nothing
   * supersedes, by the target's own order; `undefined` while none is held.
   */
  valueOf(target: string): ControlValue | undefined {
    const heads = this.#targets.get(target)?.heads ?? [];
    if (heads.length === 0) {
      return undefined;
    }
    return heads.map((head) => head.value).reduce((a, b) => narrowestValue(target, a, b));
  }

  /**
   * Whether this state holds `head` on `target` as an operation nothing supersedes, or holds an
   * operation there that supersedes it (CTL-22): what a report shows beyond that, only members hold
   * (CTL-33).
   */
  knows(target: string, head: Omit<ControlOperation, "target">): boolean {
    const held = this.#targets.get(target);
    if (held === undefined) {
      return false;
    }
    if ((held.seen.get(head.device) ?? 0) >= head.counter) {
      return true;
    }
    const key = operationKey(head, target);
    return held.heads.some((own) => operationKey(own, target) === key);
  }

  /** Whether any operation on `target` was ever merged here. */
  holds(target: string): boolean {
    return this.#targets.has(target);
  }

  /** Whether an entry of `other` lies above this state's vector: it holds operations this lacks (LOS-10, RSY-16). */
  lacksAnyOf(other: ControlVector): boolean {
    return Object.entries(other).some(
      ([device, counter]) => counter > (this.#contiguous.get(device) ?? 0),
    );
  }

  /** Whether `other` names exactly the counters this state holds without a gap (LOS-12). */
  hasVector(other: ControlVector): boolean {
    const own = Object.fromEntries(this.#contiguous);
    const devices = new Set([...Object.keys(own), ...Object.keys(other)]);
    return [...devices].every((device) => (own[device] ?? 0) === (other[device] ?? 0));
  }

  /**
   * Notes where `report` — a participant's control state, no authority (CTL-27) — holds an
   * operation under a device and counter that this state holds as another operation: a collision
   * (CTL-24, CTL-31), recorded as an anomaly at that place. Nothing of the report is taken. Returns
   * the places newly noted.
   */
  noteCollisionsIn(report: ControlStateSnapshot): ControlAnomaly[] {
    const noted: ControlAnomaly[] = [];
    for (const [target, state] of Object.entries(report.targets)) {
      for (const head of state.heads) {
        const dot = `${head.device}:${head.counter}`;
        const held = this.#byDot.get(dot);
        if (
          held === undefined ||
          held.has(operationKey(head, target)) ||
          this.#anomalies.has(dot)
        ) {
          continue;
        }
        const anomaly = { device: head.device, counter: head.counter };
        this.#anomalies.set(dot, anomaly);
        noted.push(anomaly);
      }
    }
    return noted;
  }

  /** Whether this state holds operations `other` lacks. `null` (no snapshot yet) lacks everything. */
  hasAnyBeyond(other: ControlVector | null): boolean {
    if (other === null) {
      return true;
    }
    for (const [device, counter] of this.#contiguous) {
      if (counter > (other[device] ?? 0)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Merges one operation (CTL-23, CTL-24): `duplicate` for one already held, `refused` for one
   * that would exceed a bound (CTL-30) — the caller reports it.
   */
  /** A number that changes whenever what a snapshot holds may have changed. */
  get revision(): number {
    return this.#revision;
  }

  add(given: ControlOperation): "added" | "duplicate" | "refused" {
    const op =
      given.seen === withoutZeros(given.seen)
        ? given
        : { ...given, seen: withoutZeros(given.seen) };
    this.#revision += 1;
    const dot = `${op.device}:${op.counter}`;
    const key = operationKey(op, op.target);
    const atDot = this.#byDot.get(dot);
    if (atDot?.has(key)) {
      return "duplicate";
    }
    if (this.#changesNothing(op)) {
      this.#noteCollision(op, op.target);
      return "duplicate";
    }
    if (!this.#withinBounds(op)) {
      return "refused";
    }
    if (this.#seenOverBound(op.target, Object.keys(effectiveSeen(op)))) {
      // A target's `seen` names at most MAX_CREATOR_DEVICES devices, as a snapshot carries it
      // (CTL-30, §7.5); beyond, as beyond the bytes, the operation is refused and the state is in a
      // capacity conflict (CTL-32), which every receiver of the union reaches in whatever order.
      this.#capacityConflict = true;
      return "refused";
    }
    // A close is held whatever the bound on counters above a hole says, without its counter, as at
    // the bound on devices: nothing undoes it (LIF-7), and no bound may leave a receiver without it.
    const closeAboveHoles = op.target === "close" && !this.#withinHoleBound(op);
    if (
      this.#capacityConflict &&
      !this.#targets.has(op.target) &&
      op.target !== "close" &&
      op.target !== "pace"
    ) {
      // In a capacity conflict no new member or layer right is taken (CTL-32); the close and the
      // pace are, as at the bound on targets (CTL-35).
      return "refused";
    }
    const deviceVictim = this.#deviceVictim(op.device);
    const targetVictim = this.#targetVictim(op.target);
    // A close is held whatever the bound on devices keeps of its device: nothing undoes it (LIF-7),
    // and every joiner must learn it whichever devices a receiver holds (CTL-36).
    const closeOfRefused = deviceVictim === false && op.target === "close";
    if ((deviceVictim === false && !closeOfRefused) || targetVictim === false) {
      return "refused";
    }
    // Near the byte bound, the state before is kept to go back to (CTL-30); far from it, an upper
    // bound of the size will do, which needs no measuring. A close adds nothing to what is
    // measured, and is never refused for the bytes (`measured`).
    const isClose = op.target === "close";
    const added = isClose ? 0 : bytesAddedAtMost(op);
    let upper = (this.#bytes ?? this.#upper) + added;
    if (upper > this.maxBytes && !isClose) {
      upper = this.bytes + added;
    }
    const before = upper > this.maxBytes && !isClose ? this.#save() : undefined;
    this.#bytes = undefined;
    this.#upper = upper;
    if (deviceVictim !== undefined && deviceVictim !== false) this.#evictDevice(deviceVictim);
    if (targetVictim !== undefined) this.#dropTarget(targetVictim);
    this.#noteCollision(op, op.target);
    if (!closeOfRefused && !closeAboveHoles) this.#count(op.device, op.counter);
    if (op.target === "close") {
      this.#closed = true;
    }
    let target = this.#targets.get(op.target);
    if (target === undefined) {
      target = new Target(op.target);
      this.#targets.set(op.target, target);
    }
    const held = target;
    this.#reindex(held, () =>
      held.add({ device: op.device, counter: op.counter, value: op.value, seen: op.seen }),
    );
    if (before !== undefined && this.bytes > this.maxBytes) {
      this.#load(before);
      this.#capacityConflict = true;
      return "refused";
    }
    return "added";
  }

  /**
   * Whether adding `op` would change nothing: its target's operations already supersede it, its
   * counter is held, and its target had seen everything it had seen. Such an operation is inert
   * like a duplicate (CTL-6), though a superseded operation is no longer indexed (`#byDot`).
   */
  #changesNothing(op: ControlOperation): boolean {
    const target = this.#targets.get(op.target);
    if (
      target === undefined ||
      (target.seen.get(op.device) ?? 0) < op.counter ||
      !this.#holdsCounter(op.device, op.counter)
    ) {
      return false;
    }
    return Object.entries(op.seen).every(
      ([device, counter]) => (target.seen.get(device) ?? 0) >= counter,
    );
  }

  /**
   * Whether `op` could be added now, without adding it: what a device of the creator asks before
   * it issues one (CTL-37). `refused` also for an operation beyond the bytes of control state.
   */
  wouldTake(op: ControlOperation): boolean {
    const trial = new ControlState({ maxBytes: this.maxBytes });
    trial.#load(this.#save());
    return trial.add(op) !== "refused";
  }

  /**
   * What a device of the creator gets when it issues `op` on top of this state (CTL-37, CTL-32):
   * the state it would then hold, or why it must refuse. An operation that adds a target — a member
   * or a layer right not held yet, or the first pace — goes only up to MAX_ISSUE_BYTES, and none in
   * a capacity conflict but the pace; a change of a held target goes up to the bytes this state
   * holds, while there is room; the close always (`measured`).
   */
  issue(
    op: ControlOperation,
  ): { readonly next: ControlState } | { readonly refused: "too-large" | "capacity-conflict" } {
    const addsTarget = !this.#targets.has(op.target) && op.target !== "close";
    if (addsTarget && op.target !== "pace" && this.#capacityConflict) {
      return { refused: "capacity-conflict" };
    }
    const next = ControlState.from(this.snapshot(), { maxBytes: this.maxBytes });
    // What a snapshot does not carry: the state it would hold is in the same conflict (CTL-32).
    if (this.#capacityConflict) next.markCapacityConflict();
    if (next.add(op) === "refused") {
      return { refused: "too-large" };
    }
    if (addsTarget && next.bytesAtMost > MAX_ISSUE_BYTES && next.bytes > MAX_ISSUE_BYTES) {
      return { refused: "too-large" };
    }
    return { next };
  }

  #save(): SavedState {
    return {
      targets: new Map([...this.#targets].map(([name, target]) => [name, target.copy()])),
      contiguous: new Map(this.#contiguous),
      ahead: new Map([...this.#ahead].map(([device, counters]) => [device, new Set(counters)])),
      byDot: new Map([...this.#byDot].map(([dot, keys]) => [dot, new Set(keys)])),
      anomalies: new Map(this.#anomalies),
      closed: this.#closed,
      capacityConflict: this.#capacityConflict,
      bytes: this.#bytes,
      upper: this.#upper,
    };
  }

  #load(saved: SavedState): void {
    this.#targets = saved.targets;
    this.#contiguous = saved.contiguous;
    this.#ahead = saved.ahead;
    this.#byDot = saved.byDot;
    this.#anomalies = saved.anomalies;
    this.#closed = saved.closed;
    this.#capacityConflict = saved.capacityConflict;
    this.#bytes = saved.bytes;
    this.#upper = saved.upper;
  }

  /**
   * Merges a snapshot by union (CTL-25); a snapshot never needs to be newer than this state. At a
   * bound it keeps what CTL-35's order keeps, as `add` does; returns how many devices, targets and
   * operations it left out, for the caller to report.
   */
  merge(snapshot: ControlStateSnapshot): number {
    return this.mergeOrRefuse(snapshot).leftOut;
  }

  /**
   * As `merge`, and says whether the snapshot was refused as a whole for the bytes of control state
   * (CTL-30, CTL-32): then nothing of it is held, and an answer that carried it bootstraps no one
   * (CTL-13).
   */
  mergeOrRefuse(snapshot: ControlStateSnapshot): {
    readonly leftOut: number;
    readonly refused: boolean;
  } {
    this.#revision += 1;
    const before = this.#save();
    this.#bytes = undefined;
    const leftOut = this.#mergeWithin(snapshot);
    this.#bytes = undefined;
    if (this.bytes > this.maxBytes || this.#anySeenOverBound()) {
      // Over the bytes of control state, or with a target's `seen` over its bound, the snapshot is
      // refused as a whole (CTL-30), and this state is in a capacity conflict (CTL-32) — but its
      // close holds, as one arriving alone would: the close is not measured, and nothing may leave a
      // receiver without one it was sent (LIF-7).
      this.#load(before);
      this.#capacityConflict = true;
      for (const head of snapshot.targets.close?.heads ?? []) {
        this.add({ ...head, target: "close" });
      }
      return {
        leftOut: Object.keys(snapshot.targets).length + Object.keys(snapshot.vector).length,
        refused: true,
      };
    }
    this.#upper = this.bytes;
    return { leftOut, refused: false };
  }

  #mergeWithin(snapshot: ControlStateSnapshot): number {
    let leftOut = 0;
    // Every device the snapshot names by a counter, in its vector or by a head: a head above the
    // vector is an operation the responder holds above a hole (§7.4), and the union holds it too
    // (CTL-25), as `add` would. Taken in code point order, so that at the bound the first 64 are
    // kept whatever order the snapshot lists them in (CTL-35); only the bound refuses a device.
    const named = new Map<string, { vector: number | undefined; heads: number[] }>();
    const entry = (device: string) => {
      let found = named.get(device);
      if (found === undefined) {
        found = { vector: undefined, heads: [] };
        named.set(device, found);
      }
      return found;
    };
    for (const [device, counter] of Object.entries(snapshot.vector)) {
      // A 0 names nothing held (§7.4): not a device to count against the bound (CTL-30).
      if (counter > 0) entry(device).vector = counter;
    }
    for (const [targetName, state] of Object.entries(snapshot.targets)) {
      if (isControlTarget(targetName)) {
        for (const head of state.heads) entry(head.device).heads.push(head.counter);
      }
    }
    // What the responder holds above a hole that no head carries: held here too, so that the holes
    // stay what they were (CTL-25, LOS-10).
    for (const [device, counters] of Object.entries(snapshot.aboveHoles ?? {})) {
      entry(device).heads.push(...counters);
    }
    for (const device of [...named.keys()].sort(compareCodePoints)) {
      const { vector, heads } = named.get(device) as {
        vector: number | undefined;
        heads: number[];
      };
      const victim = this.#deviceVictim(device);
      if (victim === false) {
        if (vector !== undefined) leftOut += 1; // its heads are counted with their targets below
        continue;
      }
      if (victim !== undefined) this.#evictDevice(victim);
      if (vector !== undefined) {
        this.#contiguous.set(device, Math.max(this.#contiguous.get(device) ?? 0, vector));
      }
      const contiguous = this.#contiguous.get(device) ?? 0;
      const ahead = this.#ahead.get(device) ?? new Set<number>();
      for (const n of ahead) {
        if (n <= contiguous) ahead.delete(n);
      }
      for (const counter of [...new Set(heads)].sort((a, b) => a - b)) {
        // Bounded as `add` bounds it: the counter that fills the lowest hole is always taken (CTL-30).
        if (
          counter > contiguous &&
          (counter === contiguous + 1 || ahead.size < MAX_COUNTERS_AHEAD)
        ) {
          ahead.add(counter);
        }
      }
      this.#ahead.set(device, ahead);
      this.#advance(device);
    }
    for (const [targetName, state] of Object.entries(snapshot.targets)) {
      if (!isControlTarget(targetName)) {
        continue;
      }
      // Only what a bound refused is left out (CTL-30), never a close (CTL-36, LIF-7). What the
      // operations had seen is kept whole, devices not held included: it is what supersedes an
      // operation that arrives later (CTL-22).
      const isClose = targetName === "close";
      const heads = state.heads
        .filter((head) => isClose || this.#holdsCounter(head.device, head.counter))
        .map((head) =>
          head.seen === withoutZeros(head.seen) ? head : { ...head, seen: withoutZeros(head.seen) },
        );
      leftOut += state.heads.length - heads.length;
      const seen = state.seen;
      if (isClose) {
        // A close entry closes, whatever its heads say: nothing reopens a document (LIF-7).
        this.#closed = true;
      }
      let target = this.#targets.get(targetName);
      if (target === undefined) {
        if (!isClose && heads.length === 0 && Object.keys(seen).length === 0) {
          continue;
        }
        // In a capacity conflict no new member or layer right is taken (CTL-32).
        const victim =
          this.#capacityConflict && !isClose && targetName !== "pace"
            ? false
            : this.#targetVictim(targetName);
        if (victim === false) {
          leftOut += 1;
          continue;
        }
        if (victim !== undefined) this.#dropTarget(victim);
        target = new Target(targetName);
        this.#targets.set(targetName, target);
      }
      // What a snapshot brings is held like an operation that arrived alone: a duplicate of one is
      // inert, and another operation under its device and counter is a collision (CTL-24, CTL-31).
      for (const head of heads) this.#noteCollision(head, targetName);
      const held = target;
      this.#reindex(held, () => held.merge({ seen, heads }));
    }
    return leftOut;
  }

  /** This state as a snapshot carries it (CTL-25). */
  snapshot(): ControlStateSnapshot {
    const targets: Record<string, TargetState> = {};
    for (const [name, target] of [...this.#targets].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      targets[name] = {
        seen: Object.fromEntries([...target.seen].sort(([a], [b]) => (a < b ? -1 : 1))),
        heads: [...target.heads].sort((a, b) =>
          a.device === b.device ? a.counter - b.counter : a.device < b.device ? -1 : 1,
        ),
      };
    }
    const aboveHoles = [...this.#ahead]
      .filter(([, counters]) => counters.size > 0)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([device, counters]) => [device, [...counters].sort((a, b) => a - b)] as const);
    return {
      vector: Object.fromEntries([...this.#contiguous].sort(([a], [b]) => (a < b ? -1 : 1))),
      targets,
      ...(aboveHoles.length === 0 ? {} : { aboveHoles: Object.fromEntries(aboveHoles) }),
    };
  }

  /** A copy, for a device that issues on top of what it holds. */
  static from(snapshot: ControlStateSnapshot, options: ControlStateOptions = {}): ControlState {
    const state = new ControlState(options);
    state.merge(snapshot);
    return state;
  }

  /** The bounds that need no choice: counters above a hole, and the size of `seen` (CTL-30). */
  /** Whether `target`'s `seen`, with `devices` added, would name more devices than a snapshot carries (CTL-30). */
  #seenOverBound(target: string, devices: readonly string[]): boolean {
    if (target === "close") {
      return false;
    }
    const seen = this.#targets.get(target)?.seen;
    const named = new Set(seen?.keys() ?? []);
    for (const device of devices) named.add(device);
    return named.size > MAX_CREATOR_DEVICES;
  }

  /** Whether any target's `seen` names more devices than a snapshot carries (CTL-30). */
  #anySeenOverBound(): boolean {
    for (const target of this.#targets.values()) {
      if (target.seen.size > MAX_CREATOR_DEVICES) return true;
    }
    return false;
  }

  #withinBounds(op: ControlOperation): boolean {
    if (op.target !== "close" && !this.#withinHoleBound(op)) {
      return false;
    }
    return Object.keys(op.seen).length <= MAX_CREATOR_DEVICES;
  }

  /**
   * Whether `op`'s counter fits the bound on counters above a hole (CTL-30). The operation that
   * fills the lowest hole only shrinks what lies above it: the bound must not block its own healing.
   */
  #withinHoleBound(op: ControlOperation): boolean {
    const fillsHole = op.counter === (this.#contiguous.get(op.device) ?? 0) + 1;
    return fillsHole || (this.#ahead.get(op.device)?.size ?? 0) < MAX_COUNTERS_AHEAD;
  }

  /**
   * Notes a collision (CTL-24) where another operation is held as a head under `op`'s device and
   * counter: what `noteCollisionsIn` compares a report with too (CTL-31).
   */
  #noteCollision(op: Omit<ControlOperation, "target">, target: string): void {
    const dot = `${op.device}:${op.counter}`;
    const atDot = this.#byDot.get(dot);
    if (atDot !== undefined && atDot.size > 0 && !atDot.has(operationKey(op, target))) {
      this.#anomalies.set(dot, { device: op.device, counter: op.counter });
    }
  }

  /**
   * Runs a change of one target and keeps the index of heads (`#byDot`) to what the target holds
   * after it: a head it gave up leaves the index, and a collision under it is forgotten once no
   * head is left under its device and counter.
   */
  #reindex(target: Target, change: () => void): void {
    const before = headKeys(target);
    change();
    const after = headKeys(target);
    // What came first, so that a place held on by a merged head (CTL-24) keeps its collision.
    for (const [key, dot] of after) {
      if (!before.has(key)) {
        const atDot = this.#byDot.get(dot) ?? new Set<string>();
        atDot.add(key);
        this.#byDot.set(dot, atDot);
      }
    }
    for (const [key, dot] of before) {
      if (!after.has(key)) this.#unindex(dot, key);
    }
  }

  #unindex(dot: string, key: string): void {
    const atDot = this.#byDot.get(dot);
    atDot?.delete(key);
    if (atDot !== undefined && atDot.size === 0) {
      this.#byDot.delete(dot);
      this.#anomalies.delete(dot);
    }
  }

  /** Gives up a target at the bound on targets (CTL-35), and its heads with it. */
  #dropTarget(name: string): void {
    const target = this.#targets.get(name);
    for (const [key, dot] of headKeys(target)) this.#unindex(dot, key);
    this.#targets.delete(name);
  }

  #holdsDevice(device: string): boolean {
    return this.#contiguous.has(device) || this.#ahead.has(device);
  }

  /** Whether this state counts `counter` of `device` as held: without a gap, or above a hole. */
  #holdsCounter(device: string, counter: number): boolean {
    return (
      counter <= (this.#contiguous.get(device) ?? 0) ||
      (this.#ahead.get(device)?.has(counter) ?? false)
    );
  }

  /**
   * Whether a device may be held (CTL-30, CTL-35): `undefined` when it is held or there is room,
   * `false` when it is refused, or the held device it would push out. At the bound the devices
   * whose tags come first in code point order are kept, so what a receiver holds depends on the
   * operations it received, not on their order.
   */
  #deviceVictim(device: string): string | false | undefined {
    if (this.#holdsDevice(device)) {
      return undefined;
    }
    const held = [...new Set([...this.#contiguous.keys(), ...this.#ahead.keys()])];
    if (held.length < MAX_CREATOR_DEVICES) {
      return undefined;
    }
    const last = held.reduce((a, b) => (compareCodePoints(a, b) >= 0 ? a : b));
    return compareCodePoints(device, last) < 0 ? last : false;
  }

  /** As `#deviceVictim` for targets; the close and the pace are always kept. */
  #targetVictim(target: string): string | false | undefined {
    if (this.#targets.has(target) || this.#targets.size < MAX_TARGETS) {
      return undefined;
    }
    const members = [...this.#targets.keys()].filter((name) => name !== "close" && name !== "pace");
    if (members.length === 0) {
      return false;
    }
    const last = members.reduce((a, b) => (compareCodePoints(a, b) >= 0 ? a : b));
    return target === "close" || target === "pace" || compareCodePoints(target, last) < 0
      ? last
      : false;
  }

  /**
   * Forgets a device pushed out at the bound, as if it had never been heard of (CTL-35): its
   * counters, its operations, what targets recorded of it, and a target left with nothing. It does
   * not come back while the devices that pushed it out are held.
   */
  #evictDevice(device: string): void {
    this.#contiguous.delete(device);
    this.#ahead.delete(device);
    for (const [name, target] of [...this.#targets]) {
      if (name === "close") {
        continue; // the close stays, with what it had seen (LIF-7)
      }
      this.#reindex(target, () => {
        target.heads = target.heads.filter((head) => head.device !== device);
        target.seen.delete(device);
      });
      if (target.heads.length === 0 && target.seen.size === 0) {
        this.#targets.delete(name);
      }
    }
  }

  #count(device: string, counter: number): void {
    const contiguous = this.#contiguous.get(device) ?? 0;
    if (counter <= contiguous) {
      return;
    }
    let ahead = this.#ahead.get(device);
    if (ahead === undefined) {
      ahead = new Set();
      this.#ahead.set(device, ahead);
    }
    ahead.add(counter);
    this.#advance(device);
  }

  #advance(device: string): void {
    const ahead = this.#ahead.get(device);
    let contiguous = this.#contiguous.get(device) ?? 0;
    while (ahead?.has(contiguous + 1)) {
      ahead.delete(contiguous + 1);
      contiguous += 1;
    }
    if (contiguous > 0 || this.#contiguous.has(device)) {
      this.#contiguous.set(device, contiguous);
    }
    if (ahead !== undefined && ahead.size === 0) {
      this.#ahead.delete(device);
    }
  }
}

/** Unicode code point order, the order in which CTL-35 keeps devices and targets at a bound. */
export function compareCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i) as number;
    const y = b.codePointAt(j) as number;
    if (x !== y) {
      return x < y ? -1 : 1;
    }
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  return i < a.length ? 1 : j < b.length ? -1 : 0;
}

/** The narrowest of some rights: revoked before `read` before `write` (CTL-23); `undefined` for none. */
export function narrowestRight(rights: readonly MemberRight[]): MemberRight | undefined {
  return narrowestIn(RIGHT_ORDER, rights);
}

/**
 * The narrowest of some rights on a layer: `read` before inherit (`null`) before `write` (CTL-23,
 * LAY-5); `undefined` for none.
 */
export function narrowestLayerRight(rights: readonly MemberRight[]): MemberRight | undefined {
  return narrowestIn(LAYER_ORDER, rights);
}

function narrowestIn(
  order: Readonly<Record<string, number>>,
  rights: readonly MemberRight[],
): MemberRight | undefined {
  if (rights.length === 0) {
    return undefined;
  }
  return rights.reduce((a, b) =>
    (order[String(a)] as number) <= (order[String(b)] as number) ? a : b,
  );
}

/**
 * A member's right as CTL-13 applies it (LAY-5): on the document its permission, or `revoked`
 * once the creator revoked it, or `undefined` while the creator never named it (unknown); on a
 * layer its right there, and where it inherits, its permission on the document. A revoked member
 * is revoked on every layer, whatever right it holds there: a layer right is an exception to a
 * permission, and a revoked member has none to make an exception to. The creator is not a member
 * here; its permission is `creator` everywhere (LIF-2).
 */
export function rightIn(
  state: ControlState,
  member: string,
  layer?: string,
): "read" | "write" | "revoked" | undefined {
  const permission = state.valueOf(`member:${member}`) as MemberRight | undefined;
  if (permission === null) {
    return "revoked";
  }
  const own =
    layer === undefined
      ? undefined
      : (state.valueOf(`layer:${layer}:member:${member}`) as MemberRight | undefined);
  return own ?? permission;
}

/**
 * What a device issuing now counts as seen of the other creator devices (CTL-22, CTL-27): the
 * counters it holds without a gap, raised — never lowered — by counters participants reported.
 */
export function issuingVector(
  own: string,
  held: ControlVector,
  reported: ControlVector,
): ControlVector {
  const result: Record<string, number> = {};
  for (const [device, counter] of [...Object.entries(held), ...Object.entries(reported)]) {
    if (device !== own && counter > (result[device] ?? 0)) {
      result[device] = counter;
    }
  }
  return result;
}
