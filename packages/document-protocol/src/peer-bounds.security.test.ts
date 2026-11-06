import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import {
  applyUpdate,
  createDocument,
  encodeStateVector,
  encodeUpdate,
  getFragment,
  getPlainText,
  insertPlainText,
  pendingBytes,
  splitUpdate,
  transact,
} from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlState, type Register } from "./control-state";
import {
  decodeFrame,
  encodeControlFrame,
  encodeEditFrame,
  encodeHeartbeatFrame,
  FrameDecodeError,
} from "./framing";
import { DocumentEngine } from "./index";

/**
 * What a peer can make a receiver hold, and how long it can make it wait, beyond the control
 * state's own bounds (control.security.test.ts): updates whose predecessors never come (LOS-23),
 * the creator's pace (SND-15), `control` frames beyond what one frame may carry (§4.3, §4.4), and
 * an update nested beyond what the profile reads, which an engine never sends of its own and a
 * receiver refuses whole (SND-26, YJS-1), and a report whose update the profile does not read,
 * which a receiver refuses whole as it refuses such an edit (SND-27, FRM-6).
 * Security tests: only the CI role may change this file (.github/CODEOWNERS).
 */

const DOCUMENT_ID = "doc-1";
const AS_ALICE = { batchWindowMs: 0, creatorMemberId: "alice" };
const MIB = 1024 * 1024;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

/** A creator and a member it has bootstrapped. */
async function pair(port: InMemoryMessengerPort, onBobError: (error: unknown) => void) {
  const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
  const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, onBobError, AS_ALICE);
  await alice.sync();
  await bob.sync();
  return { alice, bob };
}

describe("what a receiver holds for missing predecessors is bounded (LOS-23)", () => {
  it("beyond 32 MiB it is given up as after a truncated history, and the creator's forced answer ends that", {
    timeout: 120_000,
  }, async () => {
    const port = new InMemoryMessengerPort();
    const errors: unknown[] = [];
    const { alice, bob } = await pair(port, (error) => errors.push(error));
    // Pieces of one change, all but its first: each waits for the one before, which never comes.
    const doc = createDocument();
    transact(doc, () => insertPlainText(getFragment(doc), 0, "x".repeat(36 * MIB)));
    const pieces = splitUpdate(encodeUpdate(doc), 4 * MIB);
    expect(pieces.length).toBeGreaterThan(9);
    for (const piece of pieces.slice(1)) {
      await port.send(DOCUMENT_ID, "mallory", encodeEditFrame(DOCUMENT_ID, piece));
    }
    await bob.sync();
    expect(pendingBytes(bob.document)).toBeLessThanOrEqual(32 * MIB);
    expect(errors.some((error) => error instanceof Error && /LOS-23/.test(error.message))).toBe(
      true,
    );
    expect(getPlainText(bob.fragment)).not.toContain("x");
    // As if it had missed those deliveries: evidence at once (LOS-19), nothing waits for it.
    expect(bob.syncHealth.suspicions.map((suspicion) => suspicion.kind)).toContain(
      "history-truncated",
    );

    await vi.advanceTimersByTimeAsync(1_000); // its forced request goes out (RSY-16)
    await alice.sync(); // and the creator answers it, though bob lacks nothing of hers (RSY-17)
    await vi.advanceTimersByTimeAsync(1_000);
    await bob.sync();
    expect(bob.syncHealth.suspicions).toEqual([]);
  });

  it("below the bound, what is held waits, and the missing predecessor completes it", async () => {
    const port = new InMemoryMessengerPort();
    const errors: unknown[] = [];
    const { bob } = await pair(port, (error) => errors.push(error));
    const doc = createDocument();
    transact(doc, () => insertPlainText(getFragment(doc), 0, "y".repeat(3 * MIB)));
    const pieces = splitUpdate(encodeUpdate(doc), MIB);
    for (const piece of pieces.slice(1)) {
      await port.send(DOCUMENT_ID, "carol", encodeEditFrame(DOCUMENT_ID, piece));
    }
    await bob.sync();
    expect(pendingBytes(bob.document)).toBeGreaterThan(0);
    await port.send(DOCUMENT_ID, "carol", encodeEditFrame(DOCUMENT_ID, pieces[0] as Uint8Array));
    await bob.sync();
    expect(getPlainText(bob.fragment)).toContain("y".repeat(3 * MIB));
    expect(
      errors.filter((error) => error instanceof Error && /LOS-23/.test(error.message)),
    ).toEqual([]);
  });
});

/** Registers as the creator's account would send them in one `control` frame. */
function controlFrameOf(targets: Record<string, Register>): string {
  const state = new ControlState();
  state.take({ closed: false, targets });
  return encodeControlFrame({
    documentId: DOCUMENT_ID,
    device: "P".repeat(22),
    targets,
    closed: false,
    controlClock: state.clock,
    controlDigest: state.digest,
  });
}

describe("a control frame carries at most what a snapshot does, in clocks that are clocks (§4.3, §4.4, CTL-30, CTL-45)", () => {
  it("one with 5 003 registers is rejected whole as invalid, before any of it applies", async () => {
    const port = new InMemoryMessengerPort();
    const errors: unknown[] = [];
    const { bob } = await pair(port, (error) => errors.push(error));
    const register: Register = { value: "write", clock: [1_000_000, 0], device: "P".repeat(22) };
    const registers = Array.from(
      { length: 5_003 },
      (_, i) => [`member:m${String(i).padStart(4, "0")}`, register] as const,
    );
    // Written by hand: the encoder refuses such a frame (§4.3).
    const text = JSON.stringify({
      ...JSON.parse(controlFrameOf({ "member:m": register })),
      targets: Object.fromEntries(registers),
    });
    await port.send(DOCUMENT_ID, "alice", text);
    await bob.sync();
    expect(bob.memberPermissions.size).toBe(0);
    expect(bob.capacityConflict).toBe(false);
    expect(errors).toStrictEqual([expect.objectContaining({ reason: "invalid-field" })]);
    expect(errors[0]).toBeInstanceOf(FrameDecodeError);
  });

  it.each([
    ["an ms beyond 2^48 − 1", [2 ** 48, 0]],
    ["a counter beyond 65 535", [1_000_000, 65_536]],
    ["a negative ms", [-1, 0]],
    ["one integer", [1_000_000]],
    ["a fraction", [1_000_000.5, 0]],
  ])(
    "one with a register whose clock has %s is rejected whole, before any of it applies",
    async (_name, clock) => {
      const port = new InMemoryMessengerPort();
      const errors: unknown[] = [];
      const { bob } = await pair(port, (error) => errors.push(error));
      const valid = controlFrameOf({
        "member:carol": { value: "write", clock: [1_000_000, 1], device: "P".repeat(22) },
        "member:dave": { value: "write", clock: [1_000_000, 0], device: "P".repeat(22) },
      });
      const frame = JSON.parse(valid) as { targets: Record<string, { clock: unknown }> };
      (frame.targets["member:dave"] as { clock: unknown }).clock = clock;
      await port.send(DOCUMENT_ID, "alice", JSON.stringify(frame));
      await bob.sync();
      expect(bob.memberPermissions.size).toBe(0);
      expect(errors).toStrictEqual([expect.objectContaining({ reason: "invalid-field" })]);
    },
  );
});

describe("a pace runs at most as the bound (SND-15)", () => {
  /** The creator's decision that sets the pace, under a device tag of its own. */
  function paceOf(pace: number): string {
    return controlFrameOf({ pace: { value: pace, clock: [1_000_000, 0], device: "P".repeat(22) } });
  }

  it("a pace of days holds a member's next message for 10 minutes, not for days", async () => {
    const port = new InMemoryMessengerPort();
    const { alice, bob } = await pair(port, () => {});
    await alice.setMembership("bob", "write"); // bob may write once named (CTL-13)
    await port.send(DOCUMENT_ID, "alice", paceOf(7 * 24 * 3_600_000));
    await bob.sync();
    expect(bob.mayEdit).toBe(true);
    expect(bob.pace).toBe(7 * 24 * 3_600_000); // what the creator set
    // Bob's last message was its join request: the floor counts from there (SND-2).
    bob.edit((fragment) => insertPlainText(fragment, 0, "held"));
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    await alice.sync();
    expect(getPlainText(alice.fragment)).not.toContain("held"); // the pace holds it
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await alice.sync();
    expect(getPlainText(alice.fragment)).toContain("held"); // after 10 minutes, not days
  });
});

const LAYER = "com.example.comments/1";

/** A value of `levels` nested objects, the outermost the first level (Appendix A). */
function nested(levels: number): unknown {
  let value: unknown = 1;
  for (let level = 0; level < levels; level++) value = { a: value };
  return value;
}

describe("an update nested beyond what the profile reads (SND-26, YJS-1, Appendix A, FRM-6)", () => {
  const editsOf = async (port: InMemoryMessengerPort, sender: string) =>
    (await port.receive(DOCUMENT_ID, "observer")).filter(
      (delivery) => delivery.sender === sender && decodeFrame(delivery.payload).kind === "edit",
    ).length;

  it("is never sent by an engine of its own: 33 levels are refused as unreadable and reported, 32 go out", async () => {
    const port = new InMemoryMessengerPort();
    const errors: unknown[] = [];
    const alice = await DocumentEngine.create(
      DOCUMENT_ID,
      "alice",
      port,
      (error) => errors.push(error),
      AS_ALICE,
    );
    const before = await editsOf(port, "alice");
    alice.document.transact(() => alice.document.getMap(LAYER).set("deep", nested(32)));
    await alice.flush();
    expect(await editsOf(port, "alice")).toBe(before + 1);
    alice.document.transact(() => alice.document.getMap(LAYER).set("deeper", nested(33)));
    await alice.flush();
    expect(await editsOf(port, "alice")).toBe(before + 1);
    expect(errors).toStrictEqual([expect.objectContaining({ reason: "unreadable" })]);
  });

  it("is refused whole by a receiver: a peer's edit nested 33 levels changes nothing there", async () => {
    const port = new InMemoryMessengerPort();
    const errors: unknown[] = [];
    const { bob } = await pair(port, (error) => errors.push(error));
    // Written by hand, as an engine that does not check its own changes would send it.
    const forged = createDocument();
    transact(forged, () => forged.getMap(LAYER).set("deeper", nested(33)));
    await port.send(DOCUMENT_ID, "alice", encodeEditFrame(DOCUMENT_ID, encodeUpdate(forged)));
    await bob.sync();
    expect(bob.document.getMap(LAYER).get("deeper")).toBeUndefined();
    expect(errors).toStrictEqual([expect.objectContaining({ reason: "invalid-field" })]);
    expect(errors[0]).toBeInstanceOf(FrameDecodeError);
  });
});

describe("a report's update is checked as an edit's: one the profile does not read rejects the report whole (SND-27, FRM-6, Appendix A)", () => {
  /** Bytes as `hex` writes them, two digits a byte. */
  const hex = (text: string): Uint8Array =>
    new Uint8Array(text.split(" ").map((byte) => Number.parseInt(byte, 16)));

  /** An update with a value nested 33 levels, as an engine that does not check its own changes would send it. */
  const nestedUpdate = (): Uint8Array => {
    const forged = createDocument();
    transact(forged, () => forged.getMap(LAYER).set("deeper", nested(33)));
    return encodeUpdate(forged);
  };

  it.each([
    ["nested 33 levels", nestedUpdate],
    ["bytes that are no update", () => hex("ff ff ff")],
    // No structs; a delete set of client 1 with one range at the clock 2^53.
    [
      "a variable-length integer beyond 2^53 − 1",
      () => hex("00 01 01 01 80 80 80 80 80 80 80 10 01"),
    ],
    // The same range of length 1 at the clock 2^53 − 1: it ends at 2^53.
    ["an end clock beyond 2^53 − 1", () => hex("00 01 01 01 ff ff ff ff ff ff ff 0f 01")],
  ])(
    "%s: rejected whole as invalid-field, nothing of it applied, and its digests no evidence",
    async (_name, update) => {
      const port = new InMemoryMessengerPort();
      const errors: unknown[] = [];
      const { bob } = await pair(port, (error) => errors.push(error));
      const before = encodeUpdate(bob.document);
      // A state ahead of what Bob holds: judged, the report would show him a gap (LOS-4).
      const ahead = createDocument();
      applyUpdate(ahead, before);
      insertPlainText(getFragment(ahead), 0, "z");
      await port.send(
        DOCUMENT_ID,
        "carol",
        encodeHeartbeatFrame({
          documentId: DOCUMENT_ID,
          controlClock: null,
          controlDigest: null,
          stateVector: encodeStateVector(ahead),
          stateDigest: "96a296d224f285c6",
          stream: "5eed5eed5eed5eed",
          sequence: 1,
          update: update(),
        }),
      );
      await bob.sync();
      // Long past the wait a gap needs before it is believed (LOS-6).
      await vi.advanceTimersByTimeAsync(60_000);
      await bob.sync();
      expect(errors).toStrictEqual([expect.objectContaining({ reason: "invalid-field" })]);
      expect(errors[0]).toBeInstanceOf(FrameDecodeError);
      expect(encodeUpdate(bob.document)).toStrictEqual(before);
      expect(bob.syncHealth.suspicions).toStrictEqual([]);
    },
  );
});
