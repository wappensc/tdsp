import { describe, expect, it } from "vitest";
import type { Clock } from "./clock";
import { ControlState, type Register, rightIn } from "./control-state";
import {
  decodeFrame,
  encodeControlFrame,
  encodeResyncResponseFrame,
  FrameDecodeError,
} from "./framing";
import { YJS_PARAGRAPHS_1 } from "./profile";

/**
 * The properties every right must have, today's and any a later revision defines (VER-5), checked
 * as a property over today's whole truth table: of two decisions the later holds (CTL-22), wider or
 * not, so values need no merge — only an order for a tie, two registers under one clock and one
 * device, which grants no capability either of them withholds, whatever the permission on the
 * document (CTL-23, LAY-5), and which does not depend on order or copies; a revoked permission on the
 * document leaves nothing on any layer; and a value this engine does not know is refused, never read
 * as `write` or as inherit (VER-2).
 */

const LAYER = "com.example.comments/1";
const MEMBER = "bob";
const DEVICES = ["A", "B", "C"].map((letter) => letter.repeat(22));
const LAYER_TARGET = `layer:${LAYER}:member:${MEMBER}` as const;
const MEMBER_TARGET = `member:${MEMBER}` as const;
const at = (ms: number, counter = 0): Clock => [1_793_008_800_000 + ms, counter];

type Capability = "read" | "write";
type DocumentRight = "read" | "write" | null; // null: revoked
type LayerRight = "read" | "write" | null; // null: inherit

const DOCUMENT_RIGHTS: readonly DocumentRight[] = ["read", "write", null];
const LAYER_RIGHTS: readonly LayerRight[] = ["read", null, "write"];

/** What a right lets a member do: `revoked` or none nothing, `read` read, `write` read and write. */
function capabilities(right: "read" | "write" | "revoked" | undefined): ReadonlySet<Capability> {
  return new Set<Capability>(
    right === "write" ? ["read", "write"] : right === "read" ? ["read"] : [],
  );
}

function intersection<T>(sets: readonly ReadonlySet<T>[]): Set<T> {
  const [first, ...rest] = sets;
  return new Set([...(first ?? [])].filter((item) => rest.every((set) => set.has(item))));
}

const register = (
  value: Register["value"],
  clock: Clock,
  device = DEVICES[1] as string,
): Register => ({
  value,
  clock,
  device,
});

/**
 * A state holding the permission on the document, then each layer value as a register of its own, in
 * `order`: all under one clock and one device — a tie, which CTL-23 orders.
 */
function stateWith(
  document: DocumentRight,
  layerValues: readonly LayerRight[],
  order: readonly number[] = layerValues.map((_, i) => i),
): ControlState {
  const state = new ControlState();
  state.take({
    closed: false,
    targets: { [MEMBER_TARGET]: register(document, at(0), DEVICES[0]) },
  });
  for (const index of order) {
    const result = state.take({
      closed: false,
      targets: { [LAYER_TARGET]: register(layerValues[index] as LayerRight, at(10)) },
    });
    expect(result.refused).toBe(false);
  }
  return state;
}

const effective = (state: ControlState) => capabilities(rightIn(state, MEMBER, LAYER));

/** Every non-empty multiset of up to three values at a tie. */
function tiedValues(): LayerRight[][] {
  const found: LayerRight[][] = [];
  for (const a of LAYER_RIGHTS) {
    found.push([a]);
    for (const b of LAYER_RIGHTS) {
      found.push([a, b]);
      for (const c of LAYER_RIGHTS) found.push([a, b, c]);
    }
  }
  return found;
}

function permutations(n: number): number[][] {
  if (n === 0) return [[]];
  return permutations(n - 1).flatMap((rest) =>
    Array.from({ length: n }, (_, at) => [...rest.slice(0, at), n - 1, ...rest.slice(at)]),
  );
}

describe("the properties of a right (VER-5, CTL-22, CTL-23, LAY-5), over today's truth table", () => {
  it("a tie grants exactly what every one of its values grants, whatever the permission on the document", () => {
    for (const document of DOCUMENT_RIGHTS) {
      for (const values of tiedValues()) {
        const each = values.map((value) => effective(stateWith(document, [value])));
        // Today every intersection is a value of its own, so the tie gives it exactly, not only within it.
        expect(
          effective(stateWith(document, values)),
          `${String(document)} ${JSON.stringify(values)}`,
        ).toEqual(intersection(each));
      }
    }
  });

  it("a tie does not depend on the order of arrival or on copies", () => {
    for (const document of DOCUMENT_RIGHTS) {
      for (const values of tiedValues()) {
        const results = permutations(values.length).map((order) =>
          rightIn(stateWith(document, values, order), MEMBER, LAYER),
        );
        expect(new Set(results).size, JSON.stringify(values)).toBe(1);
        // A copy of every register, and a snapshot taken into a state that holds it, change nothing.
        const state = stateWith(document, values);
        const copy = stateWith(document, values);
        const before = copy.digest;
        expect(copy.take(state.state()).refused).toBe(false);
        for (const value of values) {
          copy.take({ closed: false, targets: { [LAYER_TARGET]: register(value, at(10)) } });
        }
        expect(copy.digest).toBe(before);
        expect(rightIn(copy, MEMBER, LAYER)).toBe(rightIn(state, MEMBER, LAYER));
      }
    }
  });

  it("is associative: taking snapshots in any grouping gives the same right", () => {
    for (const document of DOCUMENT_RIGHTS) {
      for (const values of tiedValues().filter((each) => each.length === 3)) {
        const single = values.map((value) => stateWith(document, [value]));
        const [a, b, c] = single as [ControlState, ControlState, ControlState];
        const left = ControlState.from(a.state());
        left.take(b.state());
        left.take(c.state());
        const bc = ControlState.from(b.state());
        bc.take(c.state());
        const right = ControlState.from(a.state());
        right.take(bc.state());
        expect(rightIn(left, MEMBER, LAYER)).toBe(rightIn(right, MEMBER, LAYER));
        expect(left.digest).toBe(right.digest);
      }
    }
  });

  it("of two decisions the later holds, also where it is wider: that is no merge (CTL-22)", () => {
    for (const document of DOCUMENT_RIGHTS) {
      for (const earlier of LAYER_RIGHTS) {
        for (const later of LAYER_RIGHTS) {
          for (const [first, second] of [
            [earlier, later],
            [later, earlier],
          ] as const) {
            const state = stateWith(document, []);
            // Another device decides with a later clock; in whichever order the two arrive.
            const registers = [
              register(earlier, at(10), DEVICES[1]),
              register(later, at(20), DEVICES[2]),
            ];
            for (const each of first === earlier ? registers : [...registers].reverse()) {
              state.take({ closed: false, targets: { [LAYER_TARGET]: each } });
            }
            expect(
              effective(state),
              `${String(document)} ${String(earlier)} → ${String(later)} (${String(second)} last)`,
            ).toEqual(effective(stateWith(document, [later])));
          }
        }
      }
    }
  });

  it("a revoked permission on the document leaves no right on any layer, a right `write` there included", () => {
    for (const values of tiedValues()) {
      expect(effective(stateWith(null, values))).toEqual(new Set());
    }
  });

  it("a layer that inherits follows a change of the permission on the document, both ways", () => {
    for (const from of DOCUMENT_RIGHTS) {
      for (const to of DOCUMENT_RIGHTS) {
        const state = stateWith(from, [null]);
        // The creator changes the permission on the document later.
        state.take({
          closed: false,
          targets: { [MEMBER_TARGET]: register(to, at(30), DEVICES[0]) },
        });
        expect(effective(state), `${String(from)} → ${String(to)}`).toEqual(
          capabilities(to === null ? "revoked" : to),
        );
      }
    }
  });
});

describe("a right this engine does not know (VER-2, VER-6)", () => {
  const DOC = "doc-1";
  const tamper = (frame: string, from: string, to: string) => {
    expect(frame).toContain(from);
    return frame.replace(from, to);
  };
  const refused = (frame: string) => {
    let error: unknown;
    try {
      decodeFrame(frame);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(FrameDecodeError);
    expect((error as FrameDecodeError).reason).toBe("invalid-field");
  };

  it("in a register of a control frame, on a layer or the document, is refused, never taken as `write` or as inherit", () => {
    for (const target of [LAYER_TARGET, MEMBER_TARGET]) {
      const frame = encodeControlFrame({
        documentId: DOC,
        device: DEVICES[0] as string,
        targets: { [target]: register("read", at(0), DEVICES[0]) },
        closed: false,
        controlClock: null,
        controlDigest: null,
      });
      expect(decodeFrame(frame)).toMatchObject({
        kind: "control",
        targets: { [target]: { value: "read" } },
      });
      refused(tamper(frame, '"value":"read"', '"value":"comment"'));
    }
  });

  it("in a snapshot, refuses the snapshot whole", () => {
    const state = ControlState.from({
      closed: false,
      targets: {
        [MEMBER_TARGET]: register("read", at(0), DEVICES[0]),
        [LAYER_TARGET]: register("read", at(1), DEVICES[0]),
      },
    });
    const frame = encodeResyncResponseFrame({
      documentId: DOC,
      respondsTo: "000000000000000a",
      update: new Uint8Array([0, 0]),
      control: { profile: YJS_PARAGRAPHS_1, ...state.state() },
    });
    expect(decodeFrame(frame)).toMatchObject({ kind: "resync-response" });
    refused(tamper(frame, '"value":"read"', '"value":"comment"'));
  });
});
