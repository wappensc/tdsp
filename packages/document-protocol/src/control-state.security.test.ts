import { describe, expect, it } from "vitest";
import { type ControlOperation, ControlState, issuingVector } from "./control-state";

/**
 * CTL-27 (SPECIFICATION.md §7.6): a creator device without control state may decide at
 * once. From participants it takes only *what* to supersede — counters, only raising — never what
 * holds. These tests pin what a report can and cannot do to the result every member computes.
 */

const LOST = "L".repeat(22);
const NEW = "N".repeat(22);

/** The lost device's decisions, as every member holds them: Carol reads, Bob writes. */
function membersState(): { state: ControlState; ops: ControlOperation[] } {
  const ops: ControlOperation[] = [
    { device: LOST, counter: 1, target: "member:bob", value: "write", seen: {} },
    { device: LOST, counter: 2, target: "member:carol", value: "read", seen: {} },
  ];
  const state = new ControlState();
  for (const op of ops) {
    state.add(op);
  }
  return { state, ops };
}

/** The new device's first decision, counting as seen what `reported` says. */
function newDecision(
  reported: Record<string, number>,
  value: "read" | "write" | null,
): ControlOperation {
  return {
    device: NEW,
    counter: 1,
    target: "member:carol",
    value,
    seen: issuingVector(NEW, {}, reported),
  };
}

describe("a new creator device and participants' reports (CTL-27)", () => {
  it("with an honest report, its decision supersedes the lost device's everywhere, even when wider", () => {
    const { state } = membersState();
    state.add(newDecision(state.vector, "write"));
    expect(state.members.get("carol")).toBe("write");
    expect(state.members.get("bob")).toBe("write");
  });

  it("without any report, its decision is concurrent with the old ones: a wider one does not hold", () => {
    const { state } = membersState();
    state.add(newDecision({}, "write"));
    expect(state.members.get("carol")).toBe("read");
  });

  it("a report too low never makes a result wider than either decision", () => {
    const { state } = membersState();
    state.add(newDecision({ [LOST]: 1 }, "write"));
    expect(state.members.get("carol")).toBe("read");
    const narrower = membersState().state;
    narrower.add(newDecision({ [LOST]: 1 }, null));
    expect(narrower.members.has("carol")).toBe(false);
  });

  it("a report too high only matters if the lost device comes back and decides concurrently", () => {
    const { state } = membersState();
    state.add(newDecision({ [LOST]: 1000 }, "write"));
    expect(state.members.get("carol")).toBe("write");
    // The lost device returns, has seen nothing of the new one, and narrows Carol concurrently.
    state.add({ device: LOST, counter: 3, target: "member:carol", value: null, seen: {} });
    // Known limit, stated in CTL-27: the inflated report made the new decision cover it.
    expect(state.members.get("carol")).toBe("write");
  });

  it("only counters of other devices enter what it counts as seen, never its own", () => {
    expect(issuingVector(NEW, { [NEW]: 5, [LOST]: 2 }, { [NEW]: 9, [LOST]: 4 })).toEqual({
      [LOST]: 4,
    });
  });
});
