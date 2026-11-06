/**
 * Control state as registers (SPECIFICATION.md §7): per target — a member's permission, a member's
 * right on a layer, the pace, the reason for the close — the register with the latest decision on it
 * (CTL-20), and beside them the close as a flag.
 *
 * - **Merging** (CTL-22, registers.ts): of two registers on one target the one with the greater
 *   clock holds, then the later device tag, then the narrower value. Merging a frame's registers or a
 *   snapshot is commutative, associative and idempotent within the bounds: what a receiver holds
 *   depends only on the registers it received.
 * - **Bounds** (CTL-30, CTL-34): at most 5 000 targets on members and rights on layers, beside which
 *   the pace always has room, and at most 3 MiB, measured over the snapshot's `targets`. A frame or a
 *   snapshot that would bring the state over either is refused as a whole, its close taken all the
 *   same (CTL-36), and the state is in a capacity conflict (CTL-32).
 * - **The close** holds once taken and nothing undoes it (LIF-7); it lies outside every bound, and so
 *   does the register that says why (CTL-23, CTL-36).
 *
 * Pure: no messenger, no wall clock, no profile. Authority — whose registers count as the creator's
 * word — is the engine's check (CTL-5, CTL-25); the clock of a decision is clock.ts's (CTL-45).
 */

import { type Clock, compareClocks, ZERO_CLOCK } from "./clock";
import {
  CLOSE_REASON,
  type ControlTarget,
  compareCodePoints,
  isRegister,
  type MemberRight,
  mergeRegister,
  type Register,
  type RegisterState,
  type RegisterValue,
  registerStateDigest,
} from "./registers";

export {
  CLOSE_REASON,
  CLOSE_REASON_CODES,
  type ControlTarget,
  compareCodePoints,
  DEVICE_TAG,
  isCloseReason,
  isNamedCloseReason,
  MAX_CLOSE_REASON_BYTES,
  type MemberRight,
  narrowestLayerRight,
  narrowestRight,
  type Register,
  type RegisterState,
  type RegisterValue,
  valueFitsTarget,
} from "./registers";

/** The value a decision sets: a member's right, or milliseconds for the pace (CTL-20). */
export type ControlValue = RegisterValue;

/** The form of a profile id, and of a layer id (§5.2, §5.6): `<name>/<major>`, without a colon. */
export const PROFILE_ID_FORM = /^[a-z0-9][a-z0-9.-]{0,99}\/[1-9][0-9]{0,5}$/;

/**
 * The most targets on members and on rights on layers together (CTL-30). Beyond it a receiver
 * refuses, and is in a capacity conflict (CTL-32), as beyond the bytes.
 */
export const MAX_RIGHT_TARGETS = 5_000;

/**
 * The most targets a snapshot or a `control` frame carries: those, the pace and the reason for the
 * close (CTL-30, §7.5).
 */
export const MAX_TARGETS = MAX_RIGHT_TARGETS + 2;

/**
 * The most bytes of control state CTL-30 lets a receiver hold, measured as CTL-34 says: each target
 * on a member or a right on a layer at a fixed width, whatever its register. 3 MiB, so that the union
 * of three devices of the creator that each grew to MAX_ISSUE_BYTES at once still fits, and a snapshot
 * of it fits in a message of the bindings (4 MiB). Beyond them a receiver refuses, and is in a capacity
 * conflict (CTL-32).
 */
export const ACCEPTED_CONTROL_BYTES = 3_145_728;

/** The most bytes of control state this engine holds (CTL-30), and a `ControlState` by default. */
export const MAX_CONTROL_BYTES = ACCEPTED_CONTROL_BYTES;

/**
 * The most bytes a device of the creator brings control state to with a decision that adds a target
 * (CTL-37). A decision on a target it holds changes no measure; the close is not measured and always
 * holds.
 */
export const MAX_ISSUE_BYTES = 1_048_576;

/** The bytes of `{"targets":{}}`, what CTL-34 measures of a state without targets. */
const EMPTY_MEASURE = 14;

/**
 * The width CTL-34 gives every register: the bytes of the longest one, a pace of 2^32 − 1 ms at the
 * greatest clock, as RFC 8785 writes it — `{"clock":[281474976710655,65535],"device":"<22>","value":4294967295}`.
 */
export const REGISTER_WIDTH = 86;

/**
 * Whether `target` lies outside CTL-34's measure and the bound on targets: the pace, and the reason for
 * the close, which goes wherever the close goes (CTL-30, CTL-36).
 */
function unmeasured(target: string): boolean {
  return target === "pace" || target === CLOSE_REASON;
}

const textEncoder = new TextEncoder();

function utf8Length(text: string): number {
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) > 0x7f) return textEncoder.encode(text).length;
  }
  return text.length;
}

/**
 * What one target on a member or a right on a layer adds to CTL-34's measure: its name as RFC 8785
 * writes a key, the colon, and REGISTER_WIDTH for its register, whatever that holds; without the comma
 * between entries. The pace is not measured (CTL-30, CTL-34).
 */
function entryBytes(target: string): number {
  return utf8Length(JSON.stringify(target)) + 1 + REGISTER_WIDTH;
}

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

/**
 * Whether `target` is a target this version defines: `member:…`, a valid `layer:…:member:…`, `pace`, or
 * `close-reason`.
 */
export function isControlTarget(target: string): target is ControlTarget {
  return (
    target === "pace" ||
    target === CLOSE_REASON ||
    target.startsWith("member:") ||
    layerTargetOf(target) !== undefined
  );
}

/** The member a `member:` target, or a layer right's target, names. */
export function memberOf(target: string): string | undefined {
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

/**
 * A state as persisted or carried (CTL-26, CTL-39, ARC-5), read back: `{closed, targets}` with a
 * valid register on every target; `undefined` for anything else — the form of an earlier draft, say,
 * which holds no registers.
 */
export function registerStateFrom(value: unknown): RegisterState | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const { closed, targets } = value as { closed?: unknown; targets?: unknown };
  if (typeof closed !== "boolean" || targets === null || typeof targets !== "object") {
    return undefined;
  }
  if (Array.isArray(targets)) {
    return undefined;
  }
  const entries = Object.entries(targets as Record<string, unknown>);
  for (const [target, register] of entries) {
    if (!isControlTarget(target) || !isRegister(target, register)) {
      return undefined;
    }
  }
  return { closed, targets: Object.fromEntries(entries) as Record<string, Register> };
}

/** How much a control state holds (CTL-30). */
export interface ControlStateOptions {
  /** The most bytes it holds, measured as CTL-34 says; MAX_CONTROL_BYTES by default. */
  readonly maxBytes?: number;
}

/** What taking a frame's registers or a snapshot did (CTL-25, CTL-30, CTL-32). */
export interface TakeResult {
  /** Refused as a whole for the bounds: a capacity conflict; its close was taken all the same. */
  readonly refused: boolean;
  /** How many of its registers were not taken: all when refused, else those a conflict keeps out. */
  readonly leftOut: number;
}

export class ControlState {
  /** The most bytes this state holds (CTL-30). */
  readonly maxBytes: number;
  #targets = new Map<string, Register>();
  /** CTL-34's measure of `#targets`, kept as it changes. */
  #bytes = EMPTY_MEASURE;
  /** How many of the targets are members or rights on layers: all but the pace (CTL-30). */
  #rightTargets = 0;
  #closed = false;
  /** Whether a frame or a snapshot was refused for the bounds (CTL-32). */
  #capacityConflict = false;
  // Raised by every change, so that what is derived from the registers can be kept.
  #revision = 0;
  #derived: { readonly revision: number; readonly clock: Clock; digest?: string } | undefined;

  constructor(options: ControlStateOptions = {}) {
    this.maxBytes = options.maxBytes ?? MAX_CONTROL_BYTES;
  }

  /** A state holding `state`'s registers and close, within the bounds (CTL-30). */
  static from(state: RegisterState, options: ControlStateOptions = {}): ControlState {
    const control = new ControlState(options);
    control.take(state);
    return control;
  }

  /** A copy, for a device that decides on top of what it holds (CTL-37). */
  copy(): ControlState {
    const copy = new ControlState({ maxBytes: this.maxBytes });
    copy.#targets = new Map(this.#targets);
    copy.#bytes = this.#bytes;
    copy.#rightTargets = this.#rightTargets;
    copy.#closed = this.#closed;
    copy.#capacityConflict = this.#capacityConflict;
    return copy;
  }

  /** CTL-34's measure of this state: each target on a member or a right on a layer at a fixed width. */
  get bytes(): number {
    return this.#bytes;
  }

  /** A number that changes whenever what a snapshot holds may have changed. */
  get revision(): number {
    return this.#revision;
  }

  /** Whether the close was taken; never undone (LIF-7). */
  get closed(): boolean {
    return this.#closed;
  }

  /** Whether no register is held and the document is not closed. */
  get isEmpty(): boolean {
    return this.#targets.size === 0 && !this.#closed;
  }

  /**
   * Whether this state could not hold a frame or a snapshot for its bounds (CTL-32): a capacity
   * conflict, which nothing ends. Meanwhile it takes no register on a member or a layer right it does
   * not hold, and its engine refuses its own edits.
   */
  get capacityConflict(): boolean {
    return this.#capacityConflict;
  }

  /** Enters a capacity conflict this state's owner persisted before a restart (CTL-32). */
  markCapacityConflict(): void {
    this.#capacityConflict = true;
  }

  /** The control clock: the greatest clock among the registers, `[0, 0]` without any (CTL-45). */
  get clock(): Clock {
    return this.#derive().clock;
  }

  /** The control digest (LOS-24): of `{closed, targets}`. */
  get digest(): string {
    const derived = this.#derive();
    derived.digest ??= registerStateDigest(this.state());
    return derived.digest;
  }

  #derive(): { readonly revision: number; readonly clock: Clock; digest?: string } {
    if (this.#derived?.revision !== this.#revision) {
      let clock = ZERO_CLOCK;
      for (const register of this.#targets.values()) {
        if (compareClocks(register.clock, clock) > 0) clock = register.clock;
      }
      this.#derived = { revision: this.#revision, clock };
    }
    return this.#derived;
  }

  /** This state as a snapshot carries it (§7.5): the close and one register per target, in order. */
  state(): RegisterState {
    return {
      closed: this.#closed,
      targets: Object.fromEntries(
        [...this.#targets].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
    };
  }

  /** The register held on `target`, if any. */
  registerOf(target: string): Register | undefined {
    return this.#targets.get(target);
  }

  /** The value of `target`'s register (CTL-20); `undefined` while none is held. */
  valueOf(target: string): ControlValue | undefined {
    return this.#targets.get(target)?.value;
  }

  /** Whether a register on `target` is held. */
  holds(target: string): boolean {
    return this.#targets.has(target);
  }

  /** How many targets on members and on rights on layers are held (CTL-30). */
  get rightTargets(): number {
    return this.#rightTargets;
  }

  /** The members with a permission, as their registers say. */
  get members(): ReadonlyMap<string, "read" | "write"> {
    const result = new Map<string, "read" | "write">();
    for (const [target, register] of this.#targets) {
      if (target.startsWith("member:") && register.value !== null) {
        result.set(target.slice("member:".length), register.value as "read" | "write");
      }
    }
    return result;
  }

  /**
   * The members whose permission the creator revoked: their register holds `null`. CTL-13 refuses
   * their edits as it refuses a reader's, on the document and on every layer. Revoked is not
   * unknown, though both refuse: the register tells a member the creator removed from one it has not
   * named yet (LIF-10).
   */
  get revoked(): ReadonlySet<string> {
    const result = new Set<string>();
    for (const [target, register] of this.#targets) {
      if (target.startsWith("member:") && register.value === null) {
        result.add(target.slice("member:".length));
      }
    }
    return result;
  }

  /**
   * The members' rights on layers, by layer and then member (LAY-5); one that inherits (`null`) is
   * absent, so the member's permission on the document applies there.
   */
  get layerRights(): ReadonlyMap<string, ReadonlyMap<string, "read" | "write">> {
    const result = new Map<string, Map<string, "read" | "write">>();
    for (const [target, register] of this.#targets) {
      const named = layerTargetOf(target);
      if (named === undefined || register.value === null) {
        continue;
      }
      const rights = result.get(named.layer) ?? new Map<string, "read" | "write">();
      rights.set(named.member, register.value as "read" | "write");
      result.set(named.layer, rights);
    }
    return result;
  }

  /** The pace the creator set; `undefined` if none. */
  get pace(): number | undefined {
    return this.#targets.get("pace")?.value as number | undefined;
  }

  /**
   * The reason for the close a register holds (CTL-23), whether or not the close was taken yet: a
   * receiver holds such a register as any other, and shows it only once the document is closed.
   */
  get closeReason(): string | undefined {
    return this.#targets.get(CLOSE_REASON)?.value as string | undefined;
  }

  /**
   * Takes the registers and the close of a `control` frame or a snapshot (CTL-22, CTL-25): per target
   * the register that holds. In a capacity conflict it takes no register on a member or a right on a
   * layer it holds none for (CTL-32). One that would bring the state over the bound on targets or the
   * bytes it refuses as a whole and enters a capacity conflict — taking its close, and the reason for
   * it, all the same, since nothing may leave a receiver without one it was sent (CTL-30, CTL-36).
   */
  take(incoming: RegisterState): TakeResult {
    this.#revision += 1;
    let leftOut = 0;
    let bytes = this.#bytes;
    let rightTargets = this.#rightTargets;
    const changes: [string, Register][] = [];
    for (const [target, register] of Object.entries(incoming.targets)) {
      const held = this.#targets.get(target);
      if (held === undefined && this.#capacityConflict && !unmeasured(target)) {
        leftOut += 1;
        continue;
      }
      const next = mergeRegister(target, held, register);
      if (next === held) {
        continue;
      }
      // Only what CTL-20 defines: whatever else an object brings is not held.
      const kept: Register = {
        value: next.value,
        clock: [next.clock[0], next.clock[1]],
        device: next.device,
      };
      // CTL-34: a target adds its fixed width once, when it is first held; a register on a target
      // held, the pace, or the reason for the close changes nothing measured.
      if (held === undefined && !unmeasured(target)) {
        bytes += entryBytes(target) + (rightTargets > 0 ? 1 : 0);
        rightTargets += 1;
      }
      changes.push([target, kept]);
    }
    if (rightTargets > MAX_RIGHT_TARGETS || bytes > this.maxBytes) {
      this.#capacityConflict = true;
      if (incoming.closed) this.#closed = true;
      // The reason for the close goes where the close goes (CTL-36).
      const reason = incoming.targets[CLOSE_REASON];
      let taken = 0;
      if (reason !== undefined) {
        const held = this.#targets.get(CLOSE_REASON);
        const next = mergeRegister(CLOSE_REASON, held, reason);
        if (next !== held) {
          this.#targets.set(CLOSE_REASON, {
            value: next.value,
            clock: [next.clock[0], next.clock[1]],
            device: next.device,
          });
        }
        taken = 1;
      }
      return { refused: true, leftOut: Object.keys(incoming.targets).length - taken };
    }
    for (const [target, register] of changes) this.#targets.set(target, register);
    this.#bytes = bytes;
    this.#rightTargets = rightTargets;
    if (incoming.closed) this.#closed = true;
    return { refused: false, leftOut };
  }

  /**
   * What a device of the creator gets when it decides `register` on `target` on top of this state
   * (CTL-37, CTL-32): the state it would then hold, or why it must refuse. A decision that adds a
   * target — a member or a layer right not held yet — goes only up to MAX_ISSUE_BYTES, and none in a
   * capacity conflict; one on a held target, the pace and the reason for the close, which are not
   * measured (CTL-34, CTL-36), change no measure and always have room.
   */
  issue(
    target: ControlTarget,
    register: Register,
  ): { readonly next: ControlState } | { readonly refused: "too-large" | "capacity-conflict" } {
    const addsTarget = !this.#targets.has(target);
    if (addsTarget && !unmeasured(target) && this.#capacityConflict) {
      return { refused: "capacity-conflict" };
    }
    const next = this.copy();
    if (next.take({ closed: false, targets: { [target]: register } }).refused) {
      return { refused: "too-large" };
    }
    if (addsTarget && !unmeasured(target) && next.bytes > MAX_ISSUE_BYTES) {
      return { refused: "too-large" };
    }
    return { next };
  }

  /** Takes the close (LIF-7): outside every bound (CTL-36). */
  close(): void {
    this.#revision += 1;
    this.#closed = true;
  }
}

/**
 * A member's right as CTL-13 applies it (LAY-5): on the document its permission, or `revoked` once
 * the creator revoked it, or `undefined` while no register names it (unknown, which CTL-13 counts
 * as `read`); on a layer its right there, and where it inherits, its permission on the document. A
 * revoked member is revoked on every layer, whatever right it holds there: a layer right is an
 * exception to a permission, and a revoked member has none to make an exception to. The creator is
 * not a member here; its permission is `creator` everywhere (LIF-2).
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
 * Where a channel's members and the control state differ (LIF-10): what an application compares
 * once its engine is bootstrapped, from the members its transport lists (`channelMembers`, TRN-17),
 * and shows the person without changing either. The engine never asks the transport (TRN-17).
 */
export interface ChannelInconsistencies {
  /**
   * Channel members no register names, the creator aside: their permission is unknown, which
   * refuses their edits as `read` does (CTL-13). A revoked member is named, by its `null`.
   */
  readonly unnamed: readonly string[];
  /**
   * Members whose register gives `read` or `write` and who are not in the channel: a right without
   * effect, since whoever is not in the channel receives nothing (§15.2).
   */
  readonly notInChannel: readonly string[];
  /**
   * Members whose permission is revoked (`null`) and who are in the channel, but those the
   * application is removing from it right now: they still receive every frame (§15.2), and a
   * modified engine of theirs can still write (CTL-7) — removing them failed, or someone took them
   * back in the messenger.
   */
  readonly revokedInChannel: readonly string[];
  /**
   * Revoked members in the channel that the application said it is removing right now: a removal
   * under way, shown as that, not yet an inconsistency.
   */
  readonly beingRemoved: readonly string[];
}

/**
 * Compares `channel` — the channel's members as the messenger lists them — with the registers on
 * members in `state` (LIF-10), every list sorted by code point; `removing` is whom the application
 * is removing from the channel right now. Pure: knows no messenger. A member named only by a right
 * on a layer is unnamed here, since its permission on the document is unknown (LAY-5).
 */
export function channelInconsistencies(
  state: ControlState,
  creator: string,
  channel: Iterable<string>,
  removing: Iterable<string> = [],
): ChannelInconsistencies {
  const inChannel = new Set(channel);
  const leaving = new Set(removing);
  const permissions = state.members;
  const revoked = state.revoked;
  const unnamed = [...inChannel]
    .filter((member) => member !== creator && !permissions.has(member) && !revoked.has(member))
    .sort(compareCodePoints);
  const notInChannel = [...permissions.keys()]
    .filter((member) => !inChannel.has(member))
    .sort(compareCodePoints);
  const revokedThere = [...revoked]
    .filter((member) => inChannel.has(member))
    .sort(compareCodePoints);
  return {
    unnamed,
    notInChannel,
    revokedInChannel: revokedThere.filter((member) => !leaving.has(member)),
    beingRemoved: revokedThere.filter((member) => leaving.has(member)),
  };
}
