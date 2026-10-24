import { describe, expect, it } from "vitest";
import { type ControlOperation, ControlState, rightIn } from "./control-state";
import {
  decodeFrame,
  encodeControlFrame,
  encodeResyncResponseFrame,
  FrameDecodeError,
} from "./framing";
import { YJS_PARAGRAPHS_1 } from "./profile";

/**
 * The properties every right must have, today's and any a later revision defines (VER-5), checked
 * as a property over today's whole truth table: the merge of concurrent values grants no capability
 * one of them withholds, whatever the permission on the document (CTL-23, LAY-5); it does not depend
 * on order or copies; a decision made in knowledge of another stands, wider or not (CTL-22); a
 * revoked permission on the document leaves nothing on any layer; and a value this engine does not
 * know is refused, never read as `write` or as inherit (VER-2).
 */

const LAYER = "com.example.comments/1";
const MEMBER = "bob";
const DEVICES = ["A", "B", "C"].map((letter) => letter.repeat(22));

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

/** One operation of `device` on `target`, made knowing what `seen` says of the others (CTL-22). */
function op(
  device: string,
  counter: number,
  target: ControlOperation["target"],
  value: ControlOperation["value"],
  seen = {},
): ControlOperation {
  return { device, counter, target, value, seen };
}

/** A state holding the permission on the document, then each layer value from a device of its own, concurrently. */
function stateWith(
  document: DocumentRight,
  layerValues: readonly LayerRight[],
  order: readonly number[] = layerValues.map((_, i) => i),
): ControlState {
  const state = new ControlState();
  expect(state.add(op(DEVICES[0] as string, 1, `member:${MEMBER}`, document))).toBe("added");
  for (const index of order) {
    const device = `${index}`.repeat(22);
    expect(
      state.add(
        op(device, 1, `layer:${LAYER}:member:${MEMBER}`, layerValues[index] as LayerRight, {
          [DEVICES[0] as string]: 1,
        }),
      ),
    ).toBe("added");
  }
  return state;
}

const effective = (state: ControlState) => capabilities(rightIn(state, MEMBER, LAYER));

/** Every non-empty multiset of up to three concurrent layer values. */
function concurrentValues(): LayerRight[][] {
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

describe("the properties of a right (VER-5, CTL-23, LAY-5), over today's truth table", () => {
  it("the merge of concurrent values grants exactly what every one of them grants, whatever the permission on the document", () => {
    for (const document of DOCUMENT_RIGHTS) {
      for (const values of concurrentValues()) {
        const each = values.map((value) => effective(stateWith(document, [value])));
        // Today every intersection is a value of its own, so the merge is it exactly, not only within it.
        expect(
          effective(stateWith(document, values)),
          `${String(document)} ${JSON.stringify(values)}`,
        ).toEqual(intersection(each));
      }
    }
  });

  it("does not depend on the order of arrival or on copies", () => {
    for (const document of DOCUMENT_RIGHTS) {
      for (const values of concurrentValues()) {
        const results = permutations(values.length).map((order) =>
          rightIn(stateWith(document, values, order), MEMBER, LAYER),
        );
        expect(new Set(results).size, JSON.stringify(values)).toBe(1);
        // A copy of every operation, and a snapshot merged into a state that holds it, change nothing.
        const state = stateWith(document, values);
        const copy = stateWith(document, values);
        expect(copy.merge(state.snapshot())).toBe(0);
        values.forEach((value, index) => {
          expect(
            copy.add(
              op(`${index}`.repeat(22), 1, `layer:${LAYER}:member:${MEMBER}`, value, {
                [DEVICES[0] as string]: 1,
              }),
            ),
          ).toBe("duplicate");
        });
        expect(rightIn(copy, MEMBER, LAYER)).toBe(rightIn(state, MEMBER, LAYER));
      }
    }
  });

  it("is associative: merging snapshots in any grouping gives the same right", () => {
    for (const document of DOCUMENT_RIGHTS) {
      for (const values of concurrentValues().filter((each) => each.length === 3)) {
        const single = values.map((value, index) => {
          const state = new ControlState();
          state.add(op(DEVICES[0] as string, 1, `member:${MEMBER}`, document));
          state.add(
            op(`${index}`.repeat(22), 1, `layer:${LAYER}:member:${MEMBER}`, value, {
              [DEVICES[0] as string]: 1,
            }),
          );
          return state;
        });
        const [a, b, c] = single as [ControlState, ControlState, ControlState];
        const left = ControlState.from(a.snapshot());
        left.merge(b.snapshot());
        left.merge(c.snapshot());
        const bc = ControlState.from(b.snapshot());
        bc.merge(c.snapshot());
        const right = ControlState.from(a.snapshot());
        right.merge(bc.snapshot());
        expect(rightIn(left, MEMBER, LAYER)).toBe(rightIn(right, MEMBER, LAYER));
      }
    }
  });

  it("a decision made in knowledge of another stands, also where it is wider: that is no merge (CTL-22)", () => {
    for (const document of DOCUMENT_RIGHTS) {
      for (const earlier of LAYER_RIGHTS) {
        for (const later of LAYER_RIGHTS) {
          const state = stateWith(document, [earlier]);
          // Another device, having seen the earlier one, decides again.
          state.add(
            op(DEVICES[1] as string, 1, `layer:${LAYER}:member:${MEMBER}`, later, {
              [DEVICES[0] as string]: 1,
              ["0".repeat(22)]: 1,
            }),
          );
          expect(
            effective(state),
            `${String(document)} ${String(earlier)} → ${String(later)}`,
          ).toEqual(effective(stateWith(document, [later])));
        }
      }
    }
  });

  it("a revoked permission on the document leaves no right on any layer, a right `write` there included", () => {
    for (const values of concurrentValues()) {
      expect(effective(stateWith(null, values))).toEqual(new Set());
    }
  });

  it("a layer that inherits follows a change of the permission on the document, both ways", () => {
    for (const from of DOCUMENT_RIGHTS) {
      for (const to of DOCUMENT_RIGHTS) {
        const state = stateWith(from, [null]);
        // The creator changes the permission on the document later, knowing the earlier decision.
        state.add(op(DEVICES[0] as string, 2, `member:${MEMBER}`, to, { ["0".repeat(22)]: 1 }));
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

  it("in an operation, on a layer or the document, is refused, never taken as `write` or as inherit", () => {
    for (const target of [`layer:${LAYER}:member:${MEMBER}`, `member:${MEMBER}`] as const) {
      const frame = encodeControlFrame({
        documentId: DOC,
        device: DEVICES[0] as string,
        counter: 1,
        target,
        value: "read",
        seen: {},
      });
      expect(decodeFrame(frame)).toMatchObject({ kind: "control", value: "read" });
      refused(tamper(frame, '"value":"read"', '"value":"comment"'));
    }
  });

  it("in a snapshot, refuses the snapshot whole", () => {
    const state = new ControlState();
    state.add(op(DEVICES[0] as string, 1, `member:${MEMBER}`, "read"));
    state.add(op(DEVICES[0] as string, 2, `layer:${LAYER}:member:${MEMBER}`, "read"));
    const frame = encodeResyncResponseFrame({
      documentId: DOC,
      respondsTo: "000000000000000a",
      update: new Uint8Array([0, 0]),
      control: { profile: YJS_PARAGRAPHS_1, ...state.snapshot() },
    });
    expect(decodeFrame(frame)).toMatchObject({ kind: "resync-response" });
    refused(tamper(frame, '"value":"read"', '"value":"comment"'));
  });
});
