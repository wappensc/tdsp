import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type ControlOperation, ControlState, rightIn } from "./control-state";
import { decodeFrame, type Frame, FrameDecodeError } from "./framing";
import { parseInvitation } from "./invitation";
import { checkProfileReads, profileFor } from "./profile";

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
      aboveHoles?: Record<string, number[]>;
    }
  | { name: string; frame: string; valid: false; reason: string };

type ControlVector = {
  name: string;
  operations: ControlOperation[];
  rights: Record<string, Record<string, "read" | "write" | "revoked" | "unknown">>;
};

type InvitationVector =
  | { name: string; query: string; valid: true; invitation: unknown }
  | { name: string; query: string; valid: false; problem: string };

describe("frame test vectors, at the draft marker", () => {
  const { profile, vectors } = load<{ profile: string; vectors: FrameVector[] }>(
    "frames-draft-5.json",
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
      // The counters a snapshot holds above a hole, as read (§7.5).
      if (vector.aboveHoles !== undefined) {
        expect(frame.kind === "resync-response" ? frame.control?.aboveHoles : undefined).toEqual(
          vector.aboveHoles,
        );
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
  const { vectors } = load<{ vectors: InvitationVector[] }>("invitations-draft-5.json");

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
  const { layer, vectors } = load<{ layer: string; vectors: ControlVector[] }>(
    "control-draft-5.json",
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

  it.each(vectors.map((v) => [v.name, v] as const))("%s", (_name, vector) => {
    const members = Object.keys(vector.rights);
    const inOrder = new ControlState();
    for (const op of vector.operations) inOrder.add(op);
    const reversed = new ControlState();
    for (const op of [...vector.operations].reverse()) reversed.add(op);
    // Whatever way the operations arrive — in either order, or as a snapshot (CTL-23, CTL-25).
    for (const state of [inOrder, reversed, ControlState.from(inOrder.snapshot())]) {
      expect(rightsIn(state, members)).toEqual(vector.rights);
    }
  });
});
