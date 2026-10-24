import { describe, expect, it } from "vitest";
import { ControlState } from "./control-state";
import { canonicalJson } from "./digest";

/**
 * The bytes of control state CTL-30 bounds, as CTL-34 measures them: the UTF-8 of the RFC 8785 form
 * of its snapshot's `vector` and `targets`, as the control digest reads them (LOS-12) — one measure
 * for every receiver, at the bound too.
 */

const A = "Q0FGRS1jcmVhdG9yLTAwMQ";
const utf8 = (text: string) => new TextEncoder().encode(text).length;

describe("the bytes of control state (CTL-34)", () => {
  it("are the UTF-8 of the RFC 8785 form of the snapshot's vector and targets", () => {
    const state = new ControlState();
    state.add({ device: A, counter: 1, target: "member:x", value: "read", seen: {} });
    const expected = `{"targets":{"member:x":{"heads":[{"counter":1,"device":"${A}","seen":{},"value":"read"}],"seen":{}}},"vector":{"${A}":1}}`;
    expect(canonicalJson(state.snapshot())).toBe(expected);
    expect(state.bytes).toBe(utf8(expected));
  });

  it("count escapes and characters beyond ASCII as RFC 8785 writes them", () => {
    const state = new ControlState();
    const odd = 'bob "q" \\ \n\t\u0001 ä 😀  ';
    state.add({ device: A, counter: 1, target: `member:${odd}`, value: "write", seen: {} });
    state.add({ device: A, counter: 2, target: "pace", value: 30_000, seen: {} });
    // The member's name as RFC 8785 writes it: quote and backslash escaped, \n and \t short,
    // U+0001 as \u0001, and everything else — ä, the emoji, U+2028 — as its UTF-8 bytes.
    const written = '"member:bob \\"q\\" \\\\ \\n\\t\\u0001 ä 😀  "';
    expect(canonicalJson(state.snapshot())).toContain(written);
    expect(state.bytes).toBe(utf8(canonicalJson(state.snapshot())));
  });
});
