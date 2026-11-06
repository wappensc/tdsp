import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clock } from "./clock";
import {
  CLOSE_REASON,
  ControlState,
  isCloseReason,
  isNamedCloseReason,
  type Register,
} from "./control-state";
import { decodeFrame, encodeControlFrame } from "./framing";
import {
  DocumentEngine,
  MIN_MESSAGE_BYTES,
  type PersistedControlState,
  SendRefusedError,
} from "./index";
import { registerStateDigest } from "./registers";

/**
 * Why the creator closed a document (SPECIFICATION.md CTL-23): a register on `close-reason`, merged as
 * every register is (CTL-22), written with the close or after it, outside every bound as the close is
 * (CTL-36), and shown only once the close holds.
 */

const DOC = "doc-reason";
const AS_ALICE = { batchWindowMs: 0, creatorMemberId: "alice" };
/** 2026-10-26 10:00:00 UTC: the clocks of the registers written by hand below. */
const T = 1_793_008_800_000;
const TAG = "M".repeat(22);

async function settle(...engines: DocumentEngine[]): Promise<void> {
  for (let round = 0; round < 4; round++) {
    for (const engine of engines) {
      await engine.sync();
      await engine.flush().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

/** Polls until `done`, waiting for send floors in real time, for at most `limitMs`. */
async function until(
  done: () => boolean,
  engines: DocumentEngine[],
  limitMs = 10_000,
): Promise<void> {
  const end = Date.now() + limitMs;
  while (!done() && Date.now() < end) {
    await settle(...engines);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A `control` frame as any device of the creator could write it: `targets`, and the close or not. */
function frameOf(targets: Record<string, Register>, closed: boolean, device = TAG): string {
  const state = new ControlState();
  state.take({ closed, targets });
  return encodeControlFrame({
    documentId: DOC,
    device,
    targets,
    closed: state.closed,
    controlClock: state.clock,
    controlDigest: state.digest,
  });
}

function reasonAt(value: string, clock: Clock, device = TAG): Record<string, Register> {
  return { [CLOSE_REASON]: { value, clock, device } };
}

async function creatorAndMember() {
  const port = new InMemoryMessengerPort();
  const alice = await DocumentEngine.create(DOC, "alice", port, undefined, AS_ALICE);
  await alice.setMembership("bob", "write");
  const errors: unknown[] = [];
  const bob = await DocumentEngine.join(DOC, "bob", port, (error) => errors.push(error), AS_ALICE);
  await settle(alice, bob);
  return { port, alice, bob, errors };
}

describe("the reason for the close (CTL-23)", () => {
  it("goes in the same control frame as the close, and every receiver shows it", async () => {
    const { port, alice, bob } = await creatorAndMember();
    const controls = async () =>
      (await port.receive(DOC, "observer"))
        .map((delivery) => decodeFrame(delivery.payload))
        .filter((frame) => frame.kind === "control");
    const before = (await controls()).length;
    await alice.closeDocument("creator-state-lost");
    await settle(alice, bob);
    const added = (await controls()).slice(before);
    // One frame: the close and its reason together, so no receiver sees the one without the other.
    expect(added).toHaveLength(1);
    const frame = added[0];
    expect(frame?.kind === "control" && frame.closed).toBe(true);
    expect(frame?.kind === "control" ? frame.targets[CLOSE_REASON]?.value : undefined).toBe(
      "creator-state-lost",
    );
    expect(alice.closeReason).toBe("creator-state-lost");
    expect(bob.closed).toBe(true);
    expect(bob.closeReason).toBe("creator-state-lost");
  });

  it("travels in a snapshot to a joiner, as every register does", { timeout: 20_000 }, async () => {
    const { port, alice, bob } = await creatorAndMember();
    await alice.setMembership("carol", "read");
    await alice.closeDocument("com.example.moved-elsewhere/1");
    await settle(alice, bob);
    const carol = await DocumentEngine.join(DOC, "carol", port, undefined, AS_ALICE);
    await until(() => carol.hasCompletedBootstrap, [alice, bob, carol]);
    expect(carol.hasCompletedBootstrap).toBe(true);
    expect(carol.closed).toBe(true);
    expect(carol.closeReason).toBe("com.example.moved-elsewhere/1");
  });

  it("a register written before the close is held, and shown only once the close holds", async () => {
    const { port, alice, bob } = await creatorAndMember();
    await port.send(DOC, "alice", frameOf(reasonAt("finished", [T, 0]), false));
    await bob.sync();
    expect(bob.closed).toBe(false);
    expect(bob.closeReason).toBeUndefined();
    expect(bob.controlState.targets[CLOSE_REASON]?.value).toBe("finished");
    await alice.closeDocument();
    await settle(alice, bob);
    expect(bob.closed).toBe(true);
    // Alice's own engine had not seen the register when it closed; it holds it once it reads it.
    expect(bob.closeReason).toBe("finished");
    expect(alice.closeReason).toBe("finished");
  });

  it("of two devices of the creator closing with different reasons, the later clock holds, whatever the order", async () => {
    for (const order of ["early-first", "late-first"] as const) {
      const { port, bob } = await creatorAndMember();
      const early = frameOf(reasonAt("continued", [T, 0], "A".repeat(22)), true, "A".repeat(22));
      const late = frameOf(
        reasonAt("capacity-conflict", [T + 1_000, 0], "B".repeat(22)),
        true,
        "B".repeat(22),
      );
      for (const frame of order === "early-first" ? [early, late] : [late, early]) {
        await port.send(DOC, "alice", frame);
      }
      await bob.sync();
      expect(bob.closeReason, order).toBe("capacity-conflict");
    }
  });

  it("at equal clock and device the greater string in code point order holds, whatever the order", async () => {
    for (const order of ["finished-first", "continued-first"] as const) {
      const { port, bob } = await creatorAndMember();
      const finished = frameOf(reasonAt("finished", [T, 0]), true);
      const continued = frameOf(reasonAt("continued", [T, 0]), true);
      for (const frame of order === "finished-first"
        ? [finished, continued]
        : [continued, finished]) {
        await port.send(DOC, "alice", frame);
      }
      await bob.sync();
      expect(bob.closeReason, order).toBe("finished");
    }
  });

  it("a value that is no string of 1 to 128 UTF-8 bytes is refused on receipt with its frame", async () => {
    for (const value of ["", 128, "x".repeat(129), "é".repeat(65)]) {
      const { port, bob, errors } = await creatorAndMember();
      const valid = frameOf(reasonAt("finished", [T, 0]), true);
      // Written by hand: the encoder refuses such a value (CTL-23).
      await port.send(
        DOC,
        "alice",
        valid.replace('"value":"finished"', `"value":${JSON.stringify(value)}`),
      );
      await bob.sync();
      expect(bob.closed, String(value)).toBe(false);
      expect(errors, String(value)).toStrictEqual([
        expect.objectContaining({ reason: "invalid-field" }),
      ]);
    }
    // 64 two-byte characters are 128 bytes; 65 are 130, though 65 UTF-16 code units.
    expect(isCloseReason("é".repeat(64))).toBe(true);
    expect(isCloseReason(`com.example.${"x".repeat(114)}/1`)).toBe(true);
  });

  it("a reason this version does not define a receiver takes and shows as it is; its own engine sets none (VER-5)", async () => {
    for (const value of ["expired", "com.example.moved", "Fertig!"]) {
      const { port, alice, bob, errors } = await creatorAndMember();
      // A later version's code, a name not formed as FRM-15 says, and one no name at all.
      await port.send(DOC, "alice", frameOf(reasonAt(value, [T, 0]), true));
      await bob.sync();
      expect(errors, value).toStrictEqual([]);
      expect(bob.closed, value).toBe(true);
      expect(bob.closeReason, value).toBe(value);
      expect(isCloseReason(value)).toBe(true);
      expect(isNamedCloseReason(value)).toBe(false);
      await expect(alice.closeDocument(value)).rejects.toThrow(/not a reason/);
    }
  });

  it("an application's reason it does not know a receiver holds and shows as it is, for its application to read", async () => {
    const { alice, bob } = await creatorAndMember();
    await alice.closeDocument("org.example.fault-mitigated/2");
    await settle(alice, bob);
    expect(bob.closeReason).toBe("org.example.fault-mitigated/2");
  });

  it("is set only with the close or after it: before, the engine refuses it as not-closed", async () => {
    const { port, alice, bob } = await creatorAndMember();
    const refused = await alice.setCloseReason("finished").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SendRefusedError);
    expect((refused as SendRefusedError).reason).toBe("not-closed");
    expect(alice.controlState.targets[CLOSE_REASON]).toBeUndefined();
    await alice.closeDocument();
    await alice.setCloseReason("continued");
    // A second reason on the closed document: a later register, which holds everywhere.
    await alice.closeDocument("finished");
    await settle(alice, bob);
    expect(bob.closeReason).toBe("finished");
    await expect(alice.closeDocument("not a reason")).rejects.toThrow(/not a reason/);
    await expect(bob.setCloseReason("finished")).rejects.toThrow(/not the creator/);
    const sent = (await port.receive(DOC, "observer")).filter(
      (delivery) => delivery.sender === "bob",
    );
    expect(sent.some((delivery) => decodeFrame(delivery.payload).kind === "control")).toBe(false);
  });

  it("is persisted with the control state and shown again after a restart (CTL-26, CTL-39)", async () => {
    const port = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOC, "alice", port, undefined, AS_ALICE);
    await alice.setMembership("bob", "read");
    let saved: PersistedControlState | undefined;
    const bob = await DocumentEngine.join(DOC, "bob", port, undefined, {
      ...AS_ALICE,
      onControlStateChange: (state) => {
        saved = state;
      },
    });
    await settle(alice, bob);
    await alice.closeDocument("continued");
    await settle(alice, bob);
    bob.dispose();
    const restarted = await DocumentEngine.join(DOC, "bob", port, undefined, {
      ...AS_ALICE,
      controlState: saved as PersistedControlState,
    });
    expect(restarted.closed).toBe(true);
    expect(restarted.closeReason).toBe("continued");
    restarted.dispose();
  });

  it("is covered by the control digest, so a receiver that lacks it sees the difference (LOS-24)", () => {
    const without = new ControlState();
    without.take({ closed: true, targets: {} });
    const withReason = new ControlState();
    withReason.take({ closed: true, targets: reasonAt("finished", [T, 0]) });
    expect(registerStateDigest(withReason.state())).not.toBe(registerStateDigest(without.state()));
    expect(withReason.digest).not.toBe(without.digest);
  });

  it("is refused whole where an answer could no longer carry it, and the close still goes without it (CTL-36, CTL-37)", async () => {
    const port = new InMemoryMessengerPort();
    const bounded = {
      transportProfile: async () => {
        const profile = await port.transportProfile();
        return { ...profile, bounds: { ...profile.bounds, maxBytes: MIN_MESSAGE_BYTES } };
      },
      createDocument: port.createDocument.bind(port),
      listChannels: port.listChannels.bind(port),
      receive: port.receive.bind(port),
      send: port.send.bind(port),
    };
    // An extension every answer carries takes all of a frame of the smallest transport (TRN-23) but
    // 6 000 bytes (FRM-11): what takes the room beside the control state — at 4 MiB above all the
    // responder's state vector (§7.4) — counts the same (SND-18).
    const alice = await DocumentEngine.create(DOC, "alice", bounded, undefined, {
      ...AS_ALICE,
      resyncResponseThrottleMs: 0,
      extensions: [
        {
          name: "com.example.filler/1",
          values: { "resync-response": "f".repeat(MIN_MESSAGE_BYTES - 6_000) },
        },
      ],
    });
    // Members until a further one would make the answer too large for the transport (SND-18).
    let full = false;
    for (let n = 0; n < 200 && !full; n += 1) {
      await alice.setMembership(`member-${String(n).padStart(40, "0")}`, "read").catch(() => {
        full = true;
      });
    }
    expect(full).toBe(true);
    // A reason of 128 bytes takes more than a member: no answer would carry it beside the rest.
    const longest = `com.example.${"x".repeat(114)}/1`;
    const refused = await alice.closeDocument(longest).catch((error: unknown) => error);
    expect((refused as SendRefusedError).reason).toBe("too-large");
    expect(alice.closed).toBe(false);
    await alice.closeDocument();
    expect(alice.closed).toBe(true);
    await expect(alice.setCloseReason(longest)).rejects.toMatchObject({ reason: "too-large" });
    expect(alice.closeReason).toBeUndefined();
  });

  it("lies outside every bound: a receiver at its bounds takes it with the close, and so does one in a capacity conflict", () => {
    const register: Register = { value: "write", clock: [T, 0], device: TAG };
    const small = new ControlState({ maxBytes: 300 });
    const many = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`member:m${i}`, register]),
    );
    const result = small.take({
      closed: true,
      targets: { ...many, ...reasonAt("capacity-conflict", [T, 0]) },
    });
    expect(result.refused).toBe(true);
    expect(small.capacityConflict).toBe(true);
    expect(small.closed).toBe(true);
    expect(small.closeReason).toBe("capacity-conflict");
    expect(result.leftOut).toBe(5);
    // In a capacity conflict, a later reason on a target it holds is taken; a new member is not.
    const later = small.take({
      closed: false,
      targets: { "member:new": register, ...reasonAt("finished", [T + 1, 0]) },
    });
    expect(later.leftOut).toBe(1);
    expect(small.closeReason).toBe("finished");
    // And one that holds no reason yet takes it in a conflict, as it takes the pace.
    const conflicted = new ControlState();
    conflicted.markCapacityConflict();
    conflicted.take({ closed: true, targets: reasonAt("continued", [T, 0]) });
    expect(conflicted.closeReason).toBe("continued");
    // The reason adds nothing to the measure (CTL-34).
    const measured = new ControlState();
    const before = measured.bytes;
    measured.take({ closed: true, targets: reasonAt("continued", [T, 0]) });
    expect(measured.bytes).toBe(before);
  });
});

describe("the reason for the close: persisted, merged in a refused frame, decided far ahead, and named (CTL-23)", () => {
  const DAY = 86_400_000;

  it("is persisted with the control state: restarted where the transport shows nothing sent before, a member shows it from what it persisted alone (CTL-26, CTL-39)", async () => {
    const port = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOC, "alice", port, undefined, AS_ALICE);
    await alice.setMembership("bob", "read");
    let saved: PersistedControlState | undefined;
    const bob = await DocumentEngine.join(DOC, "bob", port, undefined, {
      ...AS_ALICE,
      onControlStateChange: (state) => {
        saved = state;
      },
    });
    await settle(alice, bob);
    await alice.closeDocument("continued");
    await settle(alice, bob);
    expect(bob.closeReason).toBe("continued");
    // Whatever Alice's engine still owes goes now, and nothing of hers after it: the close and its
    // reason are nowhere on the channel when Bob starts again (SND-11, SND-27).
    await alice.reportNow();
    alice.dispose();
    bob.dispose();
    port.disconnect("alice");
    await new Promise((resolve) => setTimeout(resolve, 0));
    port.forgetOldest(DOC, (await port.receive(DOC, "observer")).length);
    expect(await port.receive(DOC, "observer")).toStrictEqual([]);
    const restarted = await DocumentEngine.join(DOC, "bob", port, undefined, {
      ...AS_ALICE,
      autoResync: false,
      controlState: saved as PersistedControlState,
    });
    await restarted.sync();
    expect(restarted.closed).toBe(true);
    expect(restarted.closeReason).toBe("continued");
    restarted.dispose();
  });

  it("a frame refused for the bounds merges the reason it carries: an older one leaves a later one held, in either order (CTL-22, CTL-36)", () => {
    const register: Register = { value: "write", clock: [T, 0], device: TAG };
    const many = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`member:m${i}`, register]),
    );
    const refused = { closed: true, targets: { ...many, ...reasonAt("finished", [T, 0]) } };
    const later = { closed: true, targets: reasonAt("continued", [T + 1, 0]) };
    for (const order of ["later-first", "refused-first"] as const) {
      const state = new ControlState({ maxBytes: 300 });
      for (const frame of order === "later-first" ? [later, refused] : [refused, later])
        state.take(frame);
      expect(state.capacityConflict, order).toBe(true);
      expect(state.closeReason, order).toBe("continued");
    }
  });

  describe("decided over a reason held more than a day ahead (CTL-21, CTL-45)", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(T);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("holds over it, on the device that decided it and on the member", async () => {
      const { port, alice, bob } = await creatorAndMember();
      // Another device of the creator whose clock ran three days ahead closed with a reason.
      await port.send(DOC, "alice", frameOf(reasonAt("finished", [T + 3 * DAY, 0]), true));
      await settle(alice, bob);
      expect([alice.closeReason, bob.closeReason]).toStrictEqual(["finished", "finished"]);
      await alice.setCloseReason("continued");
      await settle(alice, bob);
      expect([alice.closeReason, bob.closeReason]).toStrictEqual(["continued", "continued"]);
    });
  });

  it('an application\'s own is named label 1*("." label) "/" major, at most 128 bytes: its engine sets no other (FRM-15)', async () => {
    const named = [
      "com.example.moved/1",
      "a.b/999999",
      "x-1.0.y-/12",
      `com.example.${"x".repeat(114)}/1`, // 128 bytes
    ];
    const unnamed = [
      "Com.example.moved/1", // a label of lowercase letters, digits and `-` only
      "com.example.Moved/1",
      "example/1", // at least two labels
      "com..example/1",
      "com.example./1",
      "com.example.moved/0", // the major of a profile id: 1 to 999999, without a leading zero
      "com.example.moved/01",
      "com.example.moved/1000000",
      "com.example.moved/", // a major at all
      "com.ex ample.moved/1",
      "com.example_x.moved/1",
      "com.ex\u00e4mple.moved/1",
      `com.example.${"x".repeat(115)}/1`, // 129 bytes
    ];
    for (const reason of named) expect(isNamedCloseReason(reason), reason).toBe(true);
    const port = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOC, "alice", port, undefined, AS_ALICE);
    for (const reason of unnamed) {
      expect(isNamedCloseReason(reason), reason).toBe(false);
      await expect(alice.closeDocument(reason), reason).rejects.toThrow(/not a reason/);
    }
    expect(alice.closed).toBe(false);
    await alice.closeDocument();
    for (const reason of unnamed)
      await expect(alice.setCloseReason(reason), reason).rejects.toThrow(/not a reason/);
    expect(alice.closeReason).toBeUndefined();
    alice.dispose();
  });
});
