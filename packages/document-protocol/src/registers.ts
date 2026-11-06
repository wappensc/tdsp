/**
 * Control state as registers (SPECIFICATION.md CTL-20, CTL-22, CTL-23, and the clock of CTL-45): per
 * target — a member, a member's right on a layer, the pace, the reason for the close — one register
 * with the latest decision on it, and beside them a flag for the close.
 *
 * - **Register** (CTL-20): `value`, the `clock` of the decision (clock.ts) and the `device` of the
 *   creator that made it.
 * - **Merging** (CTL-22): of two registers on one target the one with the greater clock holds; at
 *   equal clocks the one whose device comes later in Unicode code point order; at equal clock and
 *   device the narrower value, for the reason for the close the greater string (CTL-23). The order is total, so merging is commutative,
 *   associative and idempotent: the result depends only on the set of registers merged, not on
 *   their order or on duplicates.
 * - **Deciding** (CTL-21): a new register whose clock lies above the device's own and above the
 *   register on its target the device holds (clock.ts, CTL-45).
 * - **Close**: no register but a flag that merging ORs, so nothing reopens a document (LIF-7).
 * - **Control clock**: the greatest clock among a state's registers, `[0, 0]` without any.
 * - **Control digest** (LOS-24): the first 8 bytes of SHA-256 over the RFC 8785 form of exactly
 *   `{"closed", "targets"}`.
 *
 * Pure: no messenger, and merging reads no wall clock, so it cannot set a register aside for a
 * clock ahead of the receiver's time. Authority — whose registers count as the creator's decisions —
 * is the engine's (CTL-5).
 */

import {
  CLOCK_SPAN_MS,
  type Clock,
  clockForDecision,
  compareClocks,
  isClock,
  ZERO_CLOCK,
} from "./clock";
import { canonicalJson, digestOf } from "./digest";

/** A member's permission as a decision sets it; `null` revokes. */
export type MemberRight = "read" | "write" | null;

/**
 * What a register holds a decision on (§7.1): a member's permission, a member's right on one layer
 * (LAY-5), the pace, or the reason for the close (CTL-23). The close itself is no target but a flag.
 */
export type ControlTarget =
  | `member:${string}`
  | `layer:${string}:member:${string}`
  | "pace"
  | typeof CLOSE_REASON;

/** The target that holds why the creator closed the document (CTL-23). */
export const CLOSE_REASON = "close-reason";

/** The reasons for the close this version defines (CTL-23); an application may name its own. */
export const CLOSE_REASON_CODES: ReadonlySet<string> = new Set([
  "finished",
  "continued",
  "creator-state-lost",
  "capacity-conflict",
]);

/** The most bytes a reason for the close takes (CTL-23, Appendix B). */
export const MAX_CLOSE_REASON_BYTES = 128;

/**
 * An application's reason for the close (CTL-23): named as an extension is (FRM-15) — a reverse domain
 * name of labels of lowercase letters, digits and `-`, at least two, then `/` and a major version.
 */
const APPLICATION_CLOSE_REASON = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\/[1-9][0-9]{0,5}$/;

const reasonEncoder = new TextEncoder();

/**
 * Whether `value` is a reason for the close a register may hold (CTL-23): a string of 1 to 128 UTF-8
 * bytes, whatever it names. A receiver takes one it does not know — a later version's, or an
 * application's — and its application shows the close without a known reason (VER-5).
 */
export function isCloseReason(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CLOSE_REASON_BYTES) {
    return false;
  }
  return reasonEncoder.encode(value).length <= MAX_CLOSE_REASON_BYTES;
}

/**
 * Whether a device of the creator may set `value` as the reason for the close (CTL-23): one this
 * version defines, or an application's, named as FRM-15 names an extension, of at most 128 bytes.
 */
export function isNamedCloseReason(value: unknown): value is string {
  return (
    isCloseReason(value) && (CLOSE_REASON_CODES.has(value) || APPLICATION_CLOSE_REASON.test(value))
  );
}

/** A target a register holds a decision on: every control target. */
export type RegisterTarget = ControlTarget;

/**
 * A register's value (CTL-20): for a member `"read"`, `"write"` or `null` (revoked); for a right on
 * a layer `"read"`, `"write"` or `null` (inherit, LAY-5); for the pace a uint32 of milliseconds; for
 * the reason for the close a reason (CTL-23).
 */
export type RegisterValue = MemberRight | number | string;

/** A device tag: 16 random bytes, base64url without padding (CTL-20). */
export const DEVICE_TAG = /^[A-Za-z0-9_-]{22}$/;

/**
 * Whether `value` is one `target` can take (CTL-20): a uint32 for the pace, a reason for the reason
 * for the close (CTL-23), a right otherwise.
 */
export function valueFitsTarget(target: string, value: unknown): value is RegisterValue {
  if (target === CLOSE_REASON) {
    return isCloseReason(value);
  }
  if (target === "pace") {
    return (
      typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff
    );
  }
  return value === null || value === "read" || value === "write";
}

/** Unicode code point order: how CTL-22 orders two device tags at one clock. */
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

/** A member's permission, narrowest first (CTL-23): revoked before `read` before `write`. */
const RIGHT_ORDER: Readonly<Record<string, number>> = { null: 0, read: 1, write: 2 };

/**
 * A right on a layer, narrowest first (CTL-23, LAY-5): `read` before inherit (`null`) before
 * `write`. What a member inherits is its permission on the document, which never lies outside
 * `read` and `write` where it lets anything be written at all, so the narrowest value is the
 * narrowest effective right whatever the document right is.
 */
const LAYER_ORDER: Readonly<Record<string, number>> = { read: 0, null: 1, write: 2 };

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

/** The latest decision on one target (CTL-20). */
export interface Register {
  readonly value: RegisterValue;
  readonly clock: Clock;
  /** The tag of the device of the creator that made the decision (CTL-20). */
  readonly device: string;
}

/** A control state of registers: one per target, and the close. */
export interface RegisterState {
  readonly closed: boolean;
  readonly targets: Readonly<Record<string, Register>>;
}

/** The state without registers and not closed. */
export const EMPTY_REGISTER_STATE: RegisterState = Object.freeze({
  closed: false,
  targets: Object.freeze({}),
});

/**
 * Whether `value` is a register on `target` (CTL-20): an object of exactly `value`, `clock` and
 * `device`, with a value the target takes, a clock within its ranges and a device tag.
 */
export function isRegister(target: RegisterTarget, value: unknown): value is Register {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  const record = value as Record<string, unknown>;
  return (
    keys.length === 3 &&
    keys.includes("value") &&
    keys.includes("clock") &&
    keys.includes("device") &&
    valueFitsTarget(target, record.value) &&
    isClock(record.clock) &&
    typeof record.device === "string" &&
    DEVICE_TAG.test(record.device)
  );
}

/**
 * The value that holds of two on one target at equal clock and device (CTL-23): for a member the
 * narrower, revoked before `read` before `write`; for a right on a layer `read` before inherit before
 * `write` (LAY-5); for the pace the longer interval; for the reason for the close the greater string
 * in Unicode code point order, as device tags are ordered (CTL-22).
 */
function narrowerValue(target: string, a: RegisterValue, b: RegisterValue): RegisterValue {
  if (target === CLOSE_REASON) {
    return compareCodePoints(a as string, b as string) >= 0 ? a : b;
  }
  if (target === "pace") {
    return Math.max(a as number, b as number);
  }
  const rights = [a as MemberRight, b as MemberRight];
  return (
    target.startsWith("layer:") ? narrowestLayerRight(rights) : narrowestRight(rights)
  ) as MemberRight;
}

/**
 * Positive when `a` holds over `b` on `target` (CTL-22), negative when `b` holds over `a`, 0 when
 * they are the same register: the greater clock; at equal clocks the later device in Unicode code
 * point order; at equal clock and device the value CTL-23 lets hold.
 */
export function compareRegisters(target: string, a: Register, b: Register): number {
  const byClock = compareClocks(a.clock, b.clock);
  if (byClock !== 0) {
    return byClock;
  }
  const byDevice = compareCodePoints(a.device, b.device);
  if (byDevice !== 0) {
    return byDevice;
  }
  if (a.value === b.value) {
    return 0;
  }
  return narrowerValue(target, a.value, b.value) === a.value ? 1 : -1;
}

/** The register that holds of `held` and `incoming` on `target` (CTL-22). */
export function mergeRegister(
  target: string,
  held: Register | undefined,
  incoming: Register,
): Register {
  return held === undefined || compareRegisters(target, incoming, held) > 0 ? incoming : held;
}

/**
 * Two control states merged (CTL-22, CTL-25): per target the register that holds, and closed if
 * either is (LIF-7). `b` may be a whole state or what one `control` frame carries.
 */
export function mergeRegisterStates(a: RegisterState, b: RegisterState): RegisterState {
  const targets = new Map(Object.entries(a.targets));
  for (const [target, register] of Object.entries(b.targets)) {
    targets.set(target, mergeRegister(target, targets.get(target), register));
  }
  // Object.fromEntries defines every target as an own property, whatever its name.
  return { closed: a.closed || b.closed, targets: Object.fromEntries(targets) };
}

/** What a device of the creator decides with, for `decideRegister`. */
export interface DecisionInput {
  /** The control state the device holds. */
  readonly held: RegisterState;
  readonly target: RegisterTarget;
  readonly value: RegisterValue;
  /** The deciding device's tag (CTL-20). */
  readonly device: string;
  /** The deciding device's own clock. */
  readonly own: Clock;
  /** Its wall clock, in milliseconds since 1970-01-01 UTC. */
  readonly now: number;
  readonly span?: number;
}

/**
 * A decision on one target as a register, and the deciding device's own clock after it (CTL-21):
 * its clock lies above the device's own and above the register on that target the device holds, so
 * that it holds over it wherever both meet (CTL-22). `undefined` when no such clock can be formed
 * (clock.ts): the device refuses the decision and tells its application.
 */
export function decideRegister(input: DecisionInput):
  | {
      readonly register: Register;
      readonly own: Clock;
    }
  | undefined {
  const span = input.span ?? CLOCK_SPAN_MS;
  const held = input.held.targets[input.target]?.clock;
  const onTarget = held === undefined ? [] : [held];
  const decided = clockForDecision(input.own, input.now, onTarget, span);
  if (decided === undefined) {
    return undefined;
  }
  return {
    register: { value: input.value, clock: decided.clock, device: input.device },
    own: decided.own,
  };
}

/** The control clock of a state: the greatest clock among its registers, `[0, 0]` without any. */
export function controlClockOf(state: RegisterState): Clock {
  let greatest = ZERO_CLOCK;
  for (const register of Object.values(state.targets)) {
    if (compareClocks(register.clock, greatest) > 0) {
      greatest = register.clock;
    }
  }
  return greatest;
}

/**
 * A state as its control digest reads it (LOS-24): exactly `closed` and `targets`, each register
 * exactly `value`, `clock` and `device` — whatever else the objects carry is left out.
 */
export function registerStateJson(state: RegisterState): {
  readonly closed: boolean;
  readonly targets: Readonly<Record<string, Register>>;
} {
  return {
    closed: state.closed,
    targets: Object.fromEntries(
      Object.entries(state.targets).map(([target, register]) => [
        target,
        {
          value: register.value,
          clock: [register.clock[0], register.clock[1]],
          device: register.device,
        },
      ]),
    ),
  };
}

const textEncoder = new TextEncoder();

/**
 * The control digest of a state (LOS-24): the first 8 bytes of SHA-256 over the UTF-8 of the RFC
 * 8785 form of `{"closed", "targets"}`, as 16 lowercase hex digits.
 */
export function registerStateDigest(state: RegisterState): string {
  return digestOf(textEncoder.encode(canonicalJson(registerStateJson(state))));
}
