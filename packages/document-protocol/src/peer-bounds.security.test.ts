import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import {
  createDocument,
  encodeUpdate,
  getFragment,
  getPlainText,
  insertPlainText,
  pendingBytes,
  splitUpdate,
  transact,
} from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeControlFrame, encodeEditFrame } from "./framing";
import { DocumentEngine } from "./index";

/**
 * What a peer can make a receiver hold, and how long it can make it wait, beyond the control
 * state's own bounds (control.security.test.ts): updates whose predecessors never come (LOS-23) and
 * the creator's pace (SND-15). Security tests: only the CI role may change this file
 * (.github/CODEOWNERS).
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

describe("a pace runs at most as the bound (SND-15)", () => {
  /** The creator's operation that sets the pace, under a device tag of its own. */
  function paceOf(pace: number): string {
    return encodeControlFrame({
      documentId: DOCUMENT_ID,
      device: "P".repeat(22),
      counter: 1,
      target: "pace",
      value: pace,
      seen: {},
    });
  }

  it("a pace of days delays the suspicion of a silent sender by 10 minutes, not by days (LOS-11)", async () => {
    const port = new InMemoryMessengerPort();
    const { bob } = await pair(port, () => {});
    await port.send(DOCUMENT_ID, "alice", paceOf(7 * 24 * 3_600_000));
    await bob.sync();
    // Carol promises a follow-up within a minute, shorter than the pace, and then falls silent.
    const doc = createDocument();
    transact(doc, () => insertPlainText(getFragment(doc), 0, "carol's last words"));
    await port.send(DOCUMENT_ID, "carol", encodeEditFrame(DOCUMENT_ID, encodeUpdate(doc), 60_000));
    await bob.sync();
    const overdue = () =>
      bob.syncHealth.suspicions.filter(
        (suspicion) => suspicion.kind === "sender-overdue" && suspicion.sender === "carol",
      );
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    await bob.sync();
    expect(overdue()).toStrictEqual([]); // within the pace as it runs: still owed time
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await bob.sync();
    expect(overdue()).toHaveLength(1); // past 10 minutes and the wait, not past a week
  });

  it("a pace of days holds a member's next message for 10 minutes, not for days", async () => {
    const port = new InMemoryMessengerPort();
    const { alice, bob } = await pair(port, () => {});
    await port.send(DOCUMENT_ID, "alice", paceOf(7 * 24 * 3_600_000));
    await bob.sync();
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
