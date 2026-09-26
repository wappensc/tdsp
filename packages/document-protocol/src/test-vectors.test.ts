import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeFrame, FrameDecodeError } from "./framing";
import { parseInvitation } from "./invitation";

/**
 * The published test vectors (packages/document-protocol/test-vectors/), checked against the
 * reference implementation: what another implementation of TDSP runs to show it reads the wire
 * the same way (SPECIFICATION.md §3.6, Appendix F).
 */
const load = <T>(file: string): T =>
  JSON.parse(readFileSync(new URL(`../test-vectors/${file}`, import.meta.url), "utf8")) as T;

type FrameVector =
  | { name: string; frame: string; valid: true; kind: string }
  | { name: string; frame: string; valid: false; reason: string };

type InvitationVector =
  | { name: string; query: string; valid: true; invitation: unknown }
  | { name: string; query: string; valid: false; problem: string };

describe("frame test vectors, version 1", () => {
  const { vectors } = load<{ vectors: FrameVector[] }>("frames-v1.json");

  it.each(vectors.map((v) => [v.name, v] as const))("%s", (_name, vector) => {
    if (vector.valid) {
      expect(decodeFrame(vector.frame).kind).toBe(vector.kind);
      return;
    }
    let caught: unknown;
    try {
      decodeFrame(vector.frame);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FrameDecodeError);
    expect((caught as FrameDecodeError).reason).toBe(vector.reason);
  });
});

describe("invitation test vectors, version 1", () => {
  const { vectors } = load<{ vectors: InvitationVector[] }>("invitations-v1.json");

  it.each(vectors.map((v) => [v.name, v] as const))("%s", (_name, vector) => {
    const read = parseInvitation(vector.query);
    if (vector.valid) {
      expect(read).toEqual({ ok: true, invitation: vector.invitation });
    } else {
      expect(read).toMatchObject({ ok: false, problem: vector.problem });
    }
  });
});
