import { readFileSync } from "node:fs";
import {
  applyUpdate,
  createDocument,
  encodeDeletions,
  encodeDeletionsWithin,
  encodeStateVector,
  getFragment,
  getPlainText,
} from "@tdsp/reconciliation";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  CLOCK_SPAN_MS,
  type Clock,
  clockCap,
  clockForDecision,
  compareClocks,
  MAX_CLOCK_COUNTER,
  MAX_CLOCK_MS,
  nextClock,
  raiseClock,
} from "./clock";
import { ControlState, type RegisterState, rightIn } from "./control-state";
import { canonicalJson, digestOf } from "./digest";
import { base64ToBytes, decodeFrame, type Frame, FrameDecodeError } from "./framing";
import { parseInvitation } from "./invitation";
import { checkProfileReads, profileFor } from "./profile";
import { registerStateDigest } from "./registers";

/**
 * The published test vectors (packages/document-protocol/test-vectors/), checked against the
 * reference implementation: what another implementation of TDSP runs to show it reads the wire
 * the same way (SPECIFICATION.md §3.6, Appendix F).
 */
const load = <T>(file: string): T =>
  JSON.parse(readFileSync(new URL(`../test-vectors/${file}`, import.meta.url), "utf8")) as T;

type FrameVector =
  | {
      name: string;
      frame: string;
      valid: true;
      kind: string;
      targets?: string[];
    }
  | { name: string; frame: string; valid: false; reason: string };

type ControlTestVector = {
  name: string;
  frames: RegisterState[];
  state: RegisterState;
  digest: string;
  rights: Record<string, Record<string, "read" | "write" | "revoked" | "unknown">>;
};

type InvitationVector =
  | { name: string; query: string; valid: true; invitation: unknown }
  | { name: string; query: string; valid: false; problem: string };

describe("frame test vectors, at the draft marker", () => {
  const { profile, vectors } = load<{ profile: string; vectors: FrameVector[] }>(
    "frames-draft-10.json",
  );

  /** What a receiver whose document has the vectors' profile reads: the frame, then its CRDT bytes (§4.4). */
  const read = (text: string): Frame => {
    const frame = decodeFrame(text);
    checkProfileReads(frame, profileFor(profile));
    return frame;
  };

  it.each(vectors.map((v) => [v.name, v] as const))("%s", (_name, vector) => {
    if (vector.valid) {
      const frame = read(vector.frame);
      expect(frame.kind).toBe(vector.kind);
      // The targets a snapshot holds once read: none dropped, also one whose MemberId has `.` (FRM-9).
      if (vector.targets !== undefined) {
        expect(
          frame.kind === "resync-response" ? Object.keys(frame.control?.targets ?? {}) : [],
        ).toEqual(vector.targets);
      }
      return;
    }
    let caught: unknown;
    try {
      read(vector.frame);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FrameDecodeError);
    expect((caught as FrameDecodeError).reason).toBe(vector.reason);
  });
});

describe("invitation test vectors, at the draft marker", () => {
  const { vectors } = load<{ vectors: InvitationVector[] }>("invitations-draft-10.json");

  it.each(vectors.map((v) => [v.name, v] as const))("%s", (_name, vector) => {
    const read = parseInvitation(vector.query);
    if (vector.valid) {
      expect(read).toEqual({ ok: true, invitation: vector.invitation });
    } else {
      expect(read).toMatchObject({ ok: false, problem: vector.problem });
    }
  });
});

describe("control-state test vectors, at the draft marker", () => {
  const { layer, vectors } = load<{ layer: string; vectors: ControlTestVector[] }>(
    "control-draft-10.json",
  );

  /** Each member's right as CTL-13 applies it, on the document and on the vectors' layer. */
  const rightsIn = (state: ControlState, members: readonly string[]) =>
    Object.fromEntries(
      members.map((member) => [
        member,
        {
          document: rightIn(state, member) ?? "unknown",
          [layer]: rightIn(state, member, layer) ?? "unknown",
        },
      ]),
    );

  /** A state that took `frames` one after another (CTL-22, CTL-25). */
  const merged = (frames: readonly RegisterState[]): ControlState => {
    const state = new ControlState();
    for (const frame of frames) state.take(frame);
    return state;
  };

  it.each(vectors.map((v) => [v.name, v] as const))("%s", (_name, vector) => {
    const members = Object.keys(vector.rights);
    const inOrder = merged(vector.frames);
    // Whatever way the registers arrive — in either order, each twice, or as one snapshot — the
    // result is the same state (CTL-22, CTL-25).
    for (const state of [
      inOrder,
      merged([...vector.frames].reverse()),
      merged(vector.frames.flatMap((frame) => [frame, frame])),
      ControlState.from(inOrder.state()),
    ]) {
      expect(state.state()).toEqual(vector.state);
      expect(state.digest).toBe(vector.digest);
      expect(rightsIn(state, members)).toEqual(vector.rights);
    }
  });
});

type ClockVector = { name: string; op: string } & Record<string, unknown>;

describe("clock test vectors, at the draft marker", () => {
  const { constants, vectors } = load<{
    constants: { MAX_MS: number; MAX_COUNTER: number; SPAN: number };
    vectors: ClockVector[];
  }>("clock-draft-10.json");

  it("state the constants of CTL-45", () => {
    expect(constants).toStrictEqual({
      MAX_MS: MAX_CLOCK_MS,
      MAX_COUNTER: MAX_CLOCK_COUNTER,
      SPAN: CLOCK_SPAN_MS,
    });
  });

  /** A decision as CTL-45 forms it: above the device's own clock and every register it holds there. */
  const decide = (own: Clock, now: number, held: Clock[]) => {
    const decided = clockForDecision(own, now, held);
    return decided === undefined
      ? { clock: "refused", ownAfter: own }
      : { clock: decided.clock, ownAfter: decided.own };
  };

  it.each(vectors.map((v) => [v.name, v] as const))("%s", (_name, v) => {
    const c = (key: string) => v[key] as Clock;
    switch (v.op) {
      case "next":
        expect(nextClock(c("clock")) ?? "none").toStrictEqual(v.next);
        break;
      case "wall":
        // The wall clock as a clock: what a decision takes at least (CTL-45).
        expect(clockForDecision([0, 0], v.now as number, [])?.clock).toStrictEqual(
          compareClocks(v.wall as Clock, [0, 1]) >= 0 ? v.wall : [0, 1],
        );
        expect(clockCap(v.now as number)[0] - CLOCK_SPAN_MS).toBeLessThanOrEqual(
          (v.wall as Clock)[0],
        );
        break;
      case "cap":
        expect(clockCap(v.now as number)).toStrictEqual(v.cap);
        break;
      case "raise":
        expect(raiseClock(c("own"), c("clock"), v.now as number)).toStrictEqual(v.ownAfter);
        break;
      case "decide":
        expect(decide(c("own"), v.now as number, v.held as Clock[])).toStrictEqual({
          clock: v.clock,
          ownAfter: v.ownAfter,
        });
        break;
      case "sequence": {
        let own = c("own");
        for (const step of v.steps as Record<string, unknown>[]) {
          if (step.raise !== undefined) {
            own = raiseClock(own, step.raise as Clock, step.now as number);
            expect(own).toStrictEqual(step.ownAfter);
            continue;
          }
          const { held } = step.decide as { held: Clock[] };
          const decided = decide(own, step.now as number, held);
          expect(decided).toStrictEqual({ clock: step.clock, ownAfter: step.ownAfter });
          own = decided.ownAfter as Clock;
        }
        break;
      }
      default:
        throw new Error(`unknown op ${v.op}`);
    }
  });
});

describe("digest test vectors, at the draft marker", () => {
  const { control, deletions, fromUpdates } = load<{
    control: {
      name: string;
      state: RegisterState;
      canonical: string;
      utf8Length: number;
      digest: string;
    }[];
    deletions: {
      name: string;
      deleted: Record<string, [number, number][]>;
      within?: Record<string, number>;
      encoding: string;
      digest: string;
    }[];
    fromUpdates: {
      name: string;
      updates: string[];
      text: string;
      deleted: Record<string, [number, number][]>;
      encoding: string;
      digest: string;
    }[];
  }>("digests-draft-10.json");
  const hex = (bytes: Uint8Array) =>
    [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const fromHex = (text: string) =>
    Uint8Array.from(text.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

  it.each(control.map((v) => [v.name, v] as const))("control: %s", (_name, v) => {
    expect(canonicalJson(v.state)).toBe(v.canonical);
    expect(new TextEncoder().encode(v.canonical).length).toBe(v.utf8Length);
    expect(registerStateDigest(v.state)).toBe(v.digest);
    // Merged as registers, the state digests the same (LOS-24).
    expect(ControlState.from(v.state).digest).toBe(v.digest);
  });

  /** One range as an update of no structs, as Appendix A writes a delete set. */
  const oneRange = (client: number, clock: number, length: number): Uint8Array => {
    const bytes = [0, 1];
    for (const value of [client, 1, clock, length]) {
      let rest = value;
      while (rest > 0x7f) {
        bytes.push(0x80 | (rest & 0x7f));
        rest = Math.floor(rest / 128);
      }
      bytes.push(rest);
    }
    return Uint8Array.from(bytes);
  };

  it.each(deletions.map((v) => [v.name, v] as const))("deletions: %s", (_name, v) => {
    expect(digestOf(fromHex(v.encoding))).toBe(v.digest);
    // Yjs, the format's reference, writes the same bytes for the ranges merged: each range an update
    // of its own, cut at the state vector first where the vector gives one.
    const ranges = Object.entries(v.deleted).flatMap(([client, list]) =>
      list.flatMap(([clock, length]) => {
        const limit = v.within === undefined ? Number.POSITIVE_INFINITY : (v.within[client] ?? 0);
        return clock < limit
          ? [oneRange(Number(client), clock, Math.min(length, limit - clock))]
          : [];
      }),
    );
    expect(hex(ranges.length === 0 ? Uint8Array.of(0, 0) : Y.mergeUpdates(ranges))).toBe(
      v.encoding,
    );
  });

  it.each(fromUpdates.map((v) => [v.name, v] as const))("from updates: %s", (_name, v) => {
    const doc = createDocument();
    for (const update of v.updates) applyUpdate(doc, base64ToBytes(update) as Uint8Array);
    expect(getPlainText(getFragment(doc))).toBe(v.text);
    expect(hex(encodeDeletions(doc))).toBe(v.encoding);
    expect(hex(encodeDeletionsWithin(doc, encodeStateVector(doc)))).toBe(v.encoding);
    expect(digestOf(encodeDeletions(doc))).toBe(v.digest);
    const set: Record<string, [number, number][]> = {};
    for (const [client, items] of Y.createDeleteSetFromStructStore(doc.store).clients) {
      if (items.length > 0) set[String(client)] = items.map((item) => [item.clock, item.len]);
    }
    expect(set).toStrictEqual(v.deleted);
  });
});
