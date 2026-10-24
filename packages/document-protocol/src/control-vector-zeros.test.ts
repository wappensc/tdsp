import { describe, expect, it } from "vitest";
import { ControlState } from "./control-state";
import { controlDigestOf } from "./digest";
import { encodeControlFrame, encodeHeartbeatFrame } from "./framing";

/**
 * An entry of 0 in a control vector (FRM-14): never written, and read as absent, so that equal
 * control states have one vector and one control digest (LOS-12) whoever wrote them.
 */

const A = "Q0FGRS1jcmVhdG9yLTAwMQ";
const B = "VGFibGV0LWNyZWF0b3ItMD";

describe("an entry of 0 in a control vector (FRM-14)", () => {
  it("is read as absent in a snapshot's vector, a target's seen and an operation's seen: one state, one digest", () => {
    const plain = new ControlState();
    plain.merge({
      vector: { [A]: 1 },
      targets: {
        "member:bob": { seen: {}, heads: [{ device: A, counter: 1, value: "write", seen: {} }] },
      },
    });
    const zeros = new ControlState();
    zeros.merge({
      vector: { [A]: 1, [B]: 0 },
      targets: {
        "member:bob": {
          seen: { [B]: 0 },
          heads: [{ device: A, counter: 1, value: "write", seen: { [B]: 0 } }],
        },
      },
    });
    expect(zeros.vector).toEqual({ [A]: 1 });
    expect(zeros.snapshot()).toEqual(plain.snapshot());
    expect(controlDigestOf(zeros.snapshot())).toBe(controlDigestOf(plain.snapshot()));
  });

  it("is read as absent in an operation that arrives alone, which is then a duplicate of the same one without it", () => {
    const state = new ControlState();
    expect(
      state.add({ device: A, counter: 1, target: "member:bob", value: "read", seen: { [B]: 0 } }),
    ).toBe("added");
    expect(
      state.add({ device: A, counter: 1, target: "member:bob", value: "read", seen: {} }),
    ).toBe("duplicate");
    expect(state.anomalies).toEqual([]);
    expect(state.snapshot().targets["member:bob"]?.heads).toEqual([
      { device: A, counter: 1, value: "read", seen: {} },
    ]);
  });

  it("is never written: the encoder refuses one in a vector", () => {
    expect(() =>
      encodeControlFrame({
        documentId: "d",
        device: A,
        counter: 2,
        target: "member:bob",
        value: "read",
        seen: { [B]: 0 },
      }),
    ).toThrow(/counter/);
    expect(() =>
      encodeHeartbeatFrame({
        documentId: "d",
        control: { [A]: 1, [B]: 0 },
        controlDigest: "0123456789abcdef",
        stateVector: new Uint8Array([0]),
        stateDigest: "0123456789abcdef",
      }),
    ).toThrow(/counter/);
  });
});
