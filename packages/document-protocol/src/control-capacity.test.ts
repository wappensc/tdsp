import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import type {
  Delivery,
  DeliveryId,
  DocumentId,
  MemberId,
  MessengerPort,
  RawChannel,
} from "@tdsp/messenger-port";
import { insertPlainText } from "@tdsp/reconciliation";
import { describe, expect, it } from "vitest";
import type { Clock } from "./clock";
import {
  MAX_CONTROL_BYTES,
  MAX_ISSUE_BYTES,
  MAX_RIGHT_TARGETS,
  type Register,
} from "./control-state";
import { canonicalJson } from "./digest";
import { encodeControlFrame } from "./framing";
import {
  ControlFrameRejectedError,
  DocumentEngine,
  MIN_MESSAGE_BYTES,
  type PersistedControlState,
  SendRefusedError,
} from "./index";

/**
 * A capacity conflict (SPECIFICATION.md CTL-30, CTL-32) as the engine shows it: a client that
 * cannot hold a `control` frame or a snapshot of the creator within its bounds says so, takes no new
 * member or layer right, refuses its own edits as `read` does, keeps the conflict across a restart,
 * and is not bootstrapped by a snapshot it could not hold (CTL-13). And what a device of the creator
 * decides within them (CTL-37), the close always (CTL-36).
 */

const DOCUMENT_ID = "doc-1";
const AS_ALICE = { batchWindowMs: 0, resyncResponseThrottleMs: 0, creatorMemberId: "alice" };
const T = 1_793_008_800_000;

/** An in-memory transport that hides the deliveries it is told to from one member. */
class HidingPort implements MessengerPort {
  readonly inner = new InMemoryMessengerPort();
  readonly #hidden = new Map<MemberId, Set<DeliveryId>>();

  createDocument(documentId: DocumentId, creator: MemberId): Promise<void> {
    return this.inner.createDocument(documentId, creator);
  }

  send(documentId: DocumentId, sender: MemberId, payload: string): Promise<DeliveryId> {
    return this.inner.send(documentId, sender, payload);
  }

  /** Sends as `sender`, and `from` never sees it. */
  async sendHiddenFrom(from: MemberId, sender: MemberId, payload: string): Promise<void> {
    const id = await this.inner.send(DOCUMENT_ID, sender, payload);
    const hidden = this.#hidden.get(from) ?? new Set<DeliveryId>();
    hidden.add(id);
    this.#hidden.set(from, hidden);
  }

  listChannels(member: MemberId): Promise<readonly RawChannel[]> {
    return this.inner.listChannels(member);
  }

  async receive(documentId: DocumentId, member: MemberId): Promise<readonly Delivery[]> {
    const hidden = this.#hidden.get(member);
    return (await this.inner.receive(documentId, member)).filter(
      (delivery) => !hidden?.has(delivery.id),
    );
  }
}

/**
 * A MemberId of 255 bytes, mostly U+0001, which RFC 8785 writes as six characters each: about 1 575
 * bytes of control state per target, so that the bytes bind before the bound on targets (CTL-30,
 * CTL-34).
 */
const wideId = (prefix: string, n: number) => {
  const head = `@${prefix}${n}-`;
  return head + "\u0001".repeat(255 - head.length);
};

/**
 * `count` registers of a device of Alice's from `first` on, in one `control` frame as her account
 * could send it: `read` for the members `id(n)`, each at the clock `[T + n, 0]`.
 */
function grants(device: string, first: number, count: number, id: (n: number) => string): string {
  const targets: Record<string, Register> = {};
  for (let n = first; n < first + count; n++) {
    targets[`member:${id(n)}`] = { value: "read", clock: [T + n, 0] as Clock, device };
  }
  return encodeControlFrame({
    documentId: DOCUMENT_ID,
    device,
    targets,
    closed: false,
    controlClock: null,
    controlDigest: null,
  });
}

/** Frames of `perFrame` wide registers of `device` until together they hold about `bytes`. */
function wideGrants(device: string, prefix: string, bytes: number, perFrame = 100): string[] {
  const frames: string[] = [];
  const count = Math.ceil(bytes / 1_575);
  for (let first = 0; first < count; first += perFrame) {
    frames.push(grants(device, first, Math.min(perFrame, count - first), (n) => wideId(prefix, n)));
  }
  return frames;
}

async function settle(...engines: DocumentEngine[]): Promise<void> {
  for (let round = 0; round < 4; round++) {
    for (const engine of engines) {
      await engine.sync();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

describe("a capacity conflict (CTL-30, CTL-32)", () => {
  it("a member that cannot hold the creator's registers for their bytes says so, refuses its edits and takes no new right", {
    timeout: 60_000,
  }, async () => {
    const port = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
    await alice.setMembership("bob", "write");
    let saved: PersistedControlState | undefined;
    const errors: unknown[] = [];
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, (error) => errors.push(error), {
      ...AS_ALICE,
      onControlStateChange: (state) => {
        saved = state;
      },
    });
    await settle(alice, bob);
    expect(bob.mayEdit).toBe(true);
    expect(bob.capacityConflict).toBe(false);

    // Alice's account sends more than this client holds, from a device of its own.
    for (const frame of wideGrants("X".repeat(22), "a", MAX_CONTROL_BYTES + 200_000)) {
      await port.send(DOCUMENT_ID, "alice", frame);
    }
    await bob.sync();
    expect(bob.capacityConflict).toBe(true);
    expect(
      errors.some(
        (error) => error instanceof ControlFrameRejectedError && error.reason === "refused",
      ),
    ).toBe(true);
    expect(bob.mayEdit).toBe(false);
    await expect(bob.resync()).rejects.toMatchObject({ reason: "capacity-conflict" });
    bob.edit((fragment) => insertPlainText(fragment, 0, "x"));
    await bob.flush().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      errors.some((error) => (error as { reason?: string }).reason === "capacity-conflict"),
    ).toBe(true);

    // Changes of what it holds still apply; a new member does not, even one that would fit.
    await alice.setMembership("bob", "read");
    await alice.setMembership("carol", "write");
    await bob.sync();
    expect(bob.permissionOf("bob")).toBe("read");
    expect(bob.permissionOf("carol")).toBeUndefined();

    // Persisted with the control state, and restored with it.
    expect(saved?.capacityConflict).toBe(true);
    bob.dispose();
    const restarted = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, {
      ...AS_ALICE,
      controlState: saved as PersistedControlState,
    });
    expect(restarted.capacityConflict).toBe(true);
    expect(restarted.mayEdit).toBe(false);
  });

  it("a member that the creator's registers would bring over 5 000 targets refuses them whole, a conflict", async () => {
    const port = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
    await alice.setMembership("bob", "write");
    const errors: unknown[] = [];
    const bob = await DocumentEngine.join(
      DOCUMENT_ID,
      "bob",
      port,
      (error) => errors.push(error),
      AS_ALICE,
    );
    await settle(alice, bob);
    // Short ids, far below the bytes: one frame of as many right targets as a snapshot carries.
    await port.send(
      DOCUMENT_ID,
      "alice",
      grants("X".repeat(22), 0, MAX_RIGHT_TARGETS, (n) => `m${n}`),
    );
    await bob.sync();
    expect(bob.capacityConflict).toBe(true);
    // Refused as a whole: none of the frame's registers is held (CTL-30).
    expect(bob.permissionOf("m0")).toBeUndefined();
    expect(bob.permissionOf("bob")).toBe("write");
    expect(errors.some((error) => error instanceof ControlFrameRejectedError)).toBe(true);
  });

  it("an answer whose snapshot the joiner could not hold bootstraps it into a capacity conflict, in which it may not edit (RSY-14, CTL-32)", {
    timeout: 60_000,
  }, async () => {
    const port = new HidingPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
    // Two devices of Alice's that each decided about 60 % of what a client holds, apart: Alice's
    // engine holds one set, and the joiner the other, read as frames from the channel's history.
    for (const frame of wideGrants("B".repeat(22), "b", MAX_CONTROL_BYTES * 0.6)) {
      await port.sendHiddenFrom("dave", "alice", frame);
    }
    for (const frame of wideGrants("A".repeat(22), "a", MAX_CONTROL_BYTES * 0.6)) {
      await port.sendHiddenFrom("alice", "alice", frame);
    }
    await alice.sync();
    const errors: unknown[] = [];
    const dave = await DocumentEngine.join(
      DOCUMENT_ID,
      "dave",
      port,
      (error) => errors.push(error),
      AS_ALICE,
    );
    expect(dave.capacityConflict).toBe(false);
    await settle(alice, dave);
    // Alice answered with her snapshot; the union is over the bytes, so the joiner refused it whole:
    // a capacity conflict, and a bootstrap all the same — it is complete, but cannot hold it all.
    expect(
      errors.some(
        (error) => error instanceof ControlFrameRejectedError && error.reason === "refused",
      ),
    ).toBe(true);
    expect(dave.capacityConflict).toBe(true);
    expect(dave.hasCompletedBootstrap).toBe(true);
    expect(dave.mayEdit).toBe(false);
    expect(alice.capacityConflict).toBe(false);
  });

  it("two devices' decisions of over half a MiB each, each valid alone, converge in every order, over 1 MiB", async () => {
    const port = new HidingPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
    /** Registers near the bound: 1 600 of one device, ids of 245 characters, `read`. */
    const nearBound = (device: string, prefix: string) =>
      [0, 400, 800, 1_200].map((first) =>
        grants(
          device,
          first,
          400,
          (n) => `${prefix}${String(n).padStart(4, "0")}${"x".repeat(240)}`,
        ),
      );
    for (const frame of nearBound("B".repeat(22), "b")) {
      await port.sendHiddenFrom("dave", "alice", frame);
    }
    for (const frame of nearBound("A".repeat(22), "a")) {
      await port.sendHiddenFrom("alice", "alice", frame);
    }
    await alice.sync();
    const bytesOf = (engine: DocumentEngine) =>
      new TextEncoder().encode(canonicalJson({ targets: engine.controlState.targets })).length;
    expect(bytesOf(alice)).toBeGreaterThan(MAX_ISSUE_BYTES / 2);
    expect(bytesOf(alice)).toBeLessThan(MAX_ISSUE_BYTES);
    // The joiner holds the other device's registers, read as frames, and merges Alice's snapshot.
    const dave = await DocumentEngine.join(DOCUMENT_ID, "dave", port, undefined, AS_ALICE);
    await settle(alice, dave);
    expect(dave.capacityConflict).toBe(false);
    expect(dave.hasCompletedBootstrap).toBe(true);
    // Alice gets the other device's as frames later: the other order, the same state.
    for (const frame of nearBound("A".repeat(22), "a")) {
      await port.sendHiddenFrom("dave", "alice", frame);
    }
    await settle(alice, dave);
    expect(alice.capacityConflict).toBe(false);
    expect(Object.keys(alice.controlState.targets)).toHaveLength(3_200);
    expect(dave.controlState.targets).toEqual(alice.controlState.targets);
    expect(dave.controlClock).toEqual(alice.controlClock);
    expect(bytesOf(dave)).toBeGreaterThan(MAX_ISSUE_BYTES);
  });

  it("a device of the creator in a conflict decides no new member, and still revokes and closes", {
    timeout: 60_000,
  }, async () => {
    const port = new InMemoryMessengerPort();
    const persisted: PersistedControlState[] = [];
    const laptop = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, {
      ...AS_ALICE,
      onControlStateChange: (state) => {
        persisted.push(state);
      },
    });
    await laptop.setMembership("bob", "write");
    for (const frame of wideGrants("X".repeat(22), "a", MAX_CONTROL_BYTES + 200_000)) {
      await port.send(DOCUMENT_ID, "alice", frame);
    }
    await laptop.sync();
    expect(laptop.capacityConflict).toBe(true);
    expect(laptop.mayEdit).toBe(false);
    await expect(laptop.setMembership("carol", "read")).rejects.toMatchObject({
      reason: "capacity-conflict",
    });
    const before = persisted.length;
    await laptop.setMembership("bob", null);
    expect(laptop.rightOf("bob")).toBe("revoked");
    await laptop.closeDocument();
    expect(laptop.closed).toBe(true);
    // Every state it persisted meanwhile, the one before each send included, keeps the conflict.
    expect(persisted.length).toBeGreaterThan(before);
    expect(persisted.slice(before).every((state) => state.capacityConflict === true)).toBe(true);
  });
});

describe("what a device of the creator decides (CTL-37)", () => {
  it("adds no target that would bring its control state over 1 MiB, and still changes one it holds", {
    timeout: 60_000,
  }, async () => {
    const port = new InMemoryMessengerPort();
    const laptop = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
    await laptop.setMembership("bob", "write");
    // Another device of Alice's brought the state to just below 1 MiB.
    for (const frame of wideGrants("Y".repeat(22), "a", MAX_ISSUE_BYTES - 2_000)) {
      await port.send(DOCUMENT_ID, "alice", frame);
    }
    await laptop.sync();
    expect(laptop.capacityConflict).toBe(false);
    await expect(laptop.setMembership(wideId("new", 1), "read")).rejects.toMatchObject({
      reason: "too-large",
    });
    expect(laptop.permissionOf(wideId("new", 1))).toBeUndefined();
    // A change of a target it holds goes up to the bytes a receiver holds (CTL-30).
    await laptop.setMembership("bob", "read");
    expect(laptop.permissionOf("bob")).toBe("read");
    await laptop.setMembership(wideId("a", 0), "write");
    expect(laptop.permissionOf(wideId("a", 0))).toBe("write");
  });
});

describe("closing through the engine (CTL-36, CTL-37, SND-18)", () => {
  it("a device of the creator closes even where its snapshot would no longer fit one answer", async () => {
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
    const alice = await DocumentEngine.create("doc-1", "alice", bounded, undefined, {
      batchWindowMs: 0,
      resyncResponseThrottleMs: 0,
      creatorMemberId: "alice",
      extensions: [
        {
          name: "com.example.filler/1",
          values: { "resync-response": "f".repeat(MIN_MESSAGE_BYTES - 6_000) },
        },
      ],
    });
    // Members until a further one would make the answer too large for the transport (SND-18).
    let refused: unknown;
    for (let n = 0; n < 200 && refused === undefined; n += 1) {
      await alice
        .setMembership(`member-${String(n).padStart(40, "0")}`, "read")
        .catch((error: unknown) => {
          refused = error;
        });
    }
    expect(refused).toBeInstanceOf(SendRefusedError);
    expect((refused as SendRefusedError).reason).toBe("too-large");
    await alice.closeDocument();
    expect(alice.closed).toBe(true);
  });
});
