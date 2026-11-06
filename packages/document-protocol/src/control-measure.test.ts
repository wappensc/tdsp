import { describe, expect, it } from "vitest";
import { ControlState, REGISTER_WIDTH } from "./control-state";
import { canonicalJson } from "./digest";

/**
 * The bytes of control state CTL-30 bounds, as CTL-34 measures them: every target on a member or a
 * right on a layer at a fixed width — its name as RFC 8785 writes a key, the colon, and 86 bytes for
 * its register, whatever that holds —, with the braces of `{"targets":{}}` and a comma between two;
 * the pace and the close not at all. One measure for every receiver, at the bound too, that depends
 * only on which targets are held.
 */

const A = "Q0FGRS1jcmVhdG9yLTAwMQ";
const CLOCK: [number, number] = [1_793_008_800_000, 0];
const utf8 = (text: string) => new TextEncoder().encode(text).length;

describe("the bytes of control state (CTL-34)", () => {
  it("give each target its name and the width of the longest register, a pace's", () => {
    // The longest register: a pace of 2^32 − 1 ms at the greatest clock, as RFC 8785 writes it.
    expect(
      utf8(canonicalJson({ clock: [2 ** 48 - 1, 65_535], device: A, value: 4_294_967_295 })),
    ).toBe(REGISTER_WIDTH);
    const state = new ControlState();
    expect(state.bytes).toBe(utf8('{"targets":{}}'));
    state.take({
      closed: false,
      targets: { "member:x": { value: "read", clock: CLOCK, device: A } },
    });
    expect(state.bytes).toBe(utf8('{"targets":{}}') + utf8('"member:x"') + 1 + REGISTER_WIDTH);
    state.take({
      closed: false,
      targets: { "member:y": { value: "write", clock: CLOCK, device: A } },
    });
    expect(state.bytes).toBe(14 + 2 * (10 + 1 + REGISTER_WIDTH) + 1);
  });

  it("count the name's escapes and characters beyond ASCII as RFC 8785 writes them", () => {
    const state = new ControlState();
    const odd = 'bob "q" \\ \n\t\u0001 ä 😀  ';
    state.take({
      closed: false,
      targets: { [`member:${odd}`]: { value: "write", clock: CLOCK, device: A } },
    });
    // The member's name as RFC 8785 writes it: quote and backslash escaped, \n and \t short,
    // U+0001 as \u0001, and everything else — ä, the emoji, U+2028 — as its UTF-8 bytes.
    const written = '"member:bob \\"q\\" \\\\ \\n\\t\\u0001 ä 😀  "';
    expect(canonicalJson({ targets: state.state().targets })).toContain(written);
    expect(state.bytes).toBe(14 + utf8(written) + 1 + REGISTER_WIDTH);
  });

  it("depend only on which targets are held: a register in place of another, shorter or longer, changes nothing, in any order", () => {
    const short = { value: null, clock: [1, 0] as [number, number], device: A };
    const long = {
      value: "write" as const,
      clock: [2 ** 48 - 1, 65_535] as [number, number],
      device: A,
    };
    const first = new ControlState();
    first.take({ closed: false, targets: { "member:x": short } });
    const measured = first.bytes;
    first.take({ closed: false, targets: { "member:x": long } });
    expect(first.bytes).toBe(measured);
    const second = new ControlState();
    second.take({ closed: false, targets: { "member:x": long } });
    second.take({ closed: false, targets: { "member:x": short } });
    expect(second.bytes).toBe(measured);
  });

  it("leave out the pace and the close", () => {
    const state = new ControlState();
    state.take({
      closed: false,
      targets: { "member:x": { value: "read", clock: CLOCK, device: A } },
    });
    const before = state.bytes;
    state.take({
      closed: false,
      targets: { pace: { value: 4_294_967_295, clock: [CLOCK[0], 1], device: A } },
    });
    expect(state.bytes).toBe(before);
    state.close();
    expect(state.closed).toBe(true);
    expect(state.bytes).toBe(before);
  });
});
