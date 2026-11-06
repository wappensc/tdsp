import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import type {
  Delivery,
  DocumentId,
  MemberId,
  MessengerPort,
  RawChannel,
} from "@tdsp/messenger-port";
import { TransportSendError } from "@tdsp/messenger-port";
import {
  encodeDeletions,
  encodeStateVector,
  encodeUpdate,
  getPlainText,
  insertPlainText,
} from "@tdsp/reconciliation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Clock, compareClocks } from "./clock";
import { ControlState, type Register } from "./control-state";
import { canonicalJson, digestOf } from "./digest";
import {
  CURRENT_FRAME_VERSION,
  encodeControlFrame,
  encodeResyncRequestFrame,
  encodeResyncResponseFrame,
} from "./framing";
import {
  ControlFrameRejectedError,
  DocumentEngine,
  type PersistedControlState,
  REPORT_AFTER_MS,
  SendRefusedError,
} from "./index";

/**
 * Who may change a document, and what everyone else refuses (SPECIFICATION.md §7,
 * §1): control state as registers of the creator's devices, the later decision holding (CTL-22);
 * permissions and their enforcement on send; a joiner's bootstrap; replayed and stale control state,
 * and `control` frames from anyone but the creator's identity (CTL-5); closing; two devices of the creator at once; persistence and a restored
 * or new device.
 * Security tests: only the CI role may change this file (.github/CODEOWNERS).
 */

const DOCUMENT_ID = "doc-1";
const IMMEDIATE = { batchWindowMs: 0 };
const AS_ALICE = { ...IMMEDIATE, creatorMemberId: "alice" };

/** A transport with no history for a newly observing member, as a linked Signal device sees it. */
class NoHistoryMessengerPort implements MessengerPort {
  readonly inner = new InMemoryMessengerPort();
  #baselineByMember = new Map<string, number>();

  createDocument(documentId: DocumentId, creator: MemberId): Promise<void> {
    return this.inner.createDocument(documentId, creator);
  }

  send(documentId: DocumentId, sender: MemberId, payload: string): Promise<string> {
    return this.inner.send(documentId, sender, payload);
  }

  listChannels(member: MemberId): Promise<readonly RawChannel[]> {
    return this.inner.listChannels(member);
  }

  /** A restarted instance of `member` sees nothing from before. */
  forgetHistory(documentId: DocumentId, member: MemberId): void {
    this.#baselineByMember.delete(`${documentId}:${member}`);
  }

  async receive(documentId: DocumentId, member: MemberId): Promise<readonly Delivery[]> {
    const all = await this.inner.receive(documentId, member);
    const key = `${documentId}:${member}`;
    const baseline = this.#baselineByMember.get(key);
    if (baseline === undefined) {
      this.#baselineByMember.set(key, all.length);
      return [];
    }
    return all.slice(baseline);
  }
}

async function pair(messenger: MessengerPort) {
  const applyErrors: unknown[] = [];
  const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
  const bob = await DocumentEngine.join(
    DOCUMENT_ID,
    "bob",
    messenger,
    (error, context) => {
      if (context === "apply") applyErrors.push(error);
    },
    AS_ALICE,
  );
  return { alice, bob, applyErrors };
}

/** A few rounds of polling and sending, until nothing more moves. */
async function settle(...engines: DocumentEngine[]): Promise<void> {
  for (let round = 0; round < 4; round++) {
    for (const engine of engines) {
      await engine.sync();
      await engine.flush().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

const TAG = "M".repeat(22);
/** The most bytes of control state a receiver holds (CTL-30): 3 MiB, as the specification states it. */
const CONTROL_BYTES = 3_145_728;
/** The width CTL-34 gives every register, as the specification states it. */
const REGISTER_WIDTH = 86;
/** The most bytes a decision that adds a target brings control state to (CTL-37). */
const ISSUE_BYTES = 1_048_576;
/** 2026-10-26 10:00:00 UTC: the clocks of the decisions written by hand below. */
const T = 1_793_008_800_000;

/** Decisions under one tag as anyone could write them; whether they count is the receiver's check. */
function frameOf(
  targets: Record<string, Register>,
  options: { closed?: boolean; device?: string } = {},
): string {
  const state = new ControlState();
  state.take({ closed: options.closed ?? false, targets });
  return encodeControlFrame({
    documentId: DOCUMENT_ID,
    device: options.device ?? TAG,
    targets,
    closed: state.closed,
    controlClock: state.clock,
    controlDigest: state.digest,
  });
}

/** One decision under `TAG`: `value` on `target`, at `[T + ms, counter]`. */
function op(target: string, value: unknown, ms = 0, counter = 0, device = TAG): string {
  return frameOf(
    { [target]: { value: value as "read", clock: [T + ms, counter], device } },
    { device },
  );
}

/** One decision of a device of the creator as it would write it itself. */
function frameOfDevice(device: string, target: string, value: unknown, clock: Clock): string {
  return frameOf({ [target]: { value: value as "read", clock, device } }, { device });
}

/** The close, as a frame without registers. */
function closeFrame(): string {
  return frameOf({}, { closed: true });
}

function snapshotOf(state: ControlState) {
  return { profile: "yjs-paragraphs/1", ...state.state() };
}

/** A state holding the given registers, as a snapshot would carry it. */
function stateOf(targets: Record<string, Register>, closed = false): ControlState {
  const state = new ControlState();
  state.take({ closed, targets });
  return state;
}

/** Runs the decisions of a test at wall clocks it sets; timers stay real. */
function atWallClocks(): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T);
}
afterEach(() => {
  vi.useRealTimers();
});

function forgedResponse(control: object): string {
  return encodeResyncResponseFrame({
    documentId: DOCUMENT_ID,
    respondsTo: "00000000000000ff",
    update: new Uint8Array([0, 0]),
    control,
  });
}

describe("permissions and their enforcement", () => {
  it("the creator's grant reaches another client, which then knows the permission", async () => {
    const messenger = new InMemoryMessengerPort();
    const { alice, bob } = await pair(messenger);
    await alice.setMembership("bob", "write");
    await bob.sync();
    expect(bob.permissionOf("bob")).toBe("write");
    expect(bob.permissionOf("alice")).toBe("creator");
    expect(alice.permissionOf("bob")).toBe("write");
  });

  it("a member set to read refuses to send, permanently, and the refusal is a named error", async () => {
    const messenger = new InMemoryMessengerPort();
    const { alice, bob } = await pair(messenger);
    await alice.sync();
    await bob.sync();
    await alice.setMembership("bob", "read");
    await bob.sync();
    expect(bob.mayEdit).toBe(false);
    await expect(bob.resync()).rejects.toBeInstanceOf(SendRefusedError);
    await expect(bob.resync()).rejects.toMatchObject({ reason: "read-only" });
  });

  it("a joiner may not edit before the creator has bootstrapped it, nor after while its permission is unknown, and may once the creator names it", async () => {
    const messenger = new InMemoryMessengerPort();
    const { alice, bob } = await pair(messenger);
    expect(bob.mayEdit).toBe(false);
    await expect(bob.resync()).rejects.toMatchObject({ reason: "awaiting-bootstrap" });
    await alice.sync();
    await bob.sync();
    expect(bob.hasCompletedBootstrap).toBe(true);
    expect(bob.permissionOf("bob")).toBeUndefined();
    expect(bob.mayEdit).toBe(false);
    await expect(bob.resync()).rejects.toMatchObject({ reason: "unknown-permission" });
    await alice.setMembership("bob", "write");
    await bob.sync();
    expect(bob.mayEdit).toBe(true);
  });

  it("the creator may always edit its own open document", async () => {
    const messenger = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    expect(alice.mayEdit).toBe(true);
  });

  it("refuses to join without the creator's member id, which the invitation always carries (LIF-4)", async () => {
    await expect(
      DocumentEngine.join(DOCUMENT_ID, "bob", new InMemoryMessengerPort(), undefined, IMMEDIATE),
    ).rejects.toThrow(/creator/);
  });
});

describe("authority: only the creator's registers count (CTL-5)", () => {
  it("a control frame from anyone but the creator is ignored, and reported as such", async () => {
    const messenger = new InMemoryMessengerPort();
    const { bob, applyErrors } = await pair(messenger);
    await messenger.send(DOCUMENT_ID, "mallory", op("member:mallory", "write"));
    await bob.sync();
    expect(bob.permissionOf("mallory")).toBeUndefined();
    expect(applyErrors).toStrictEqual([expect.objectContaining({ reason: "not-from-creator" })]);
  });

  it("a pace from anyone but the creator is ignored, and reported; the creator's holds (SND-15)", async () => {
    const messenger = new InMemoryMessengerPort();
    const { bob, applyErrors } = await pair(messenger);
    await messenger.send(DOCUMENT_ID, "mallory", op("pace", 3_600_000));
    await bob.sync();
    expect(bob.pace).toBeUndefined();
    expect(applyErrors).toStrictEqual([expect.objectContaining({ reason: "not-from-creator" })]);
    await messenger.send(DOCUMENT_ID, "alice", op("pace", 60_000));
    await bob.sync();
    expect(bob.pace).toBe(60_000);
  });

  it("a close and its reason from anyone but the creator are ignored, and reported; the creator's hold (CTL-23)", async () => {
    const messenger = new InMemoryMessengerPort();
    const { alice, bob, applyErrors } = await pair(messenger);
    await messenger.send(
      DOCUMENT_ID,
      "mallory",
      frameOf(
        { "close-reason": { value: "creator-state-lost", clock: [T, 0], device: TAG } },
        { closed: true },
      ),
    );
    await bob.sync();
    expect(bob.closed).toBe(false);
    expect(bob.closeReason).toBeUndefined();
    expect(bob.controlState.targets["close-reason"]).toBeUndefined();
    expect(applyErrors).toStrictEqual([expect.objectContaining({ reason: "not-from-creator" })]);
    await expect(bob.setCloseReason("finished")).rejects.toThrow(/not the creator/);
    await alice.closeDocument("finished");
    await bob.sync();
    expect(bob.closeReason).toBe("finished");
  });

  it("a register that names the creator is ignored, and reported — with every other register of its frame", async () => {
    const messenger = new InMemoryMessengerPort();
    const { bob, applyErrors } = await pair(messenger);
    await messenger.send(
      DOCUMENT_ID,
      "alice",
      frameOf({
        "member:alice": { value: "read", clock: [T, 0], device: TAG },
        "member:bob": { value: "write", clock: [T, 1], device: TAG },
      }),
    );
    await messenger.send(
      DOCUMENT_ID,
      "alice",
      op("layer:com.example.comments/1:member:alice", "read", 1),
    );
    await bob.sync();
    expect(bob.permissionOf("alice")).toBe("creator");
    expect(bob.permissionOf("bob")).toBeUndefined();
    expect(applyErrors).toStrictEqual([
      expect.objectContaining({ reason: "names-the-creator" }),
      expect.objectContaining({ reason: "names-the-creator" }),
    ]);
  });

  it("only the creator can change membership or close, and the creator's own record is fixed", async () => {
    const messenger = new InMemoryMessengerPort();
    const { alice, bob } = await pair(messenger);
    await expect(bob.setMembership("carol", "write")).rejects.toThrow(/not the creator/);
    await expect(bob.closeDocument()).rejects.toThrow(/not the creator/);
    await expect(alice.setMembership("alice", "read")).rejects.toThrow(/permanent/);
    await expect(alice.setMembership("bob", "creator" as "read")).rejects.toThrow(
      /cannot be granted/,
    );
  });

  it("a replayed control frame under a new delivery id changes nothing (CTL-6)", async () => {
    const messenger = new InMemoryMessengerPort();
    const { alice, bob } = await pair(messenger);
    await alice.setMembership("bob", "write");
    await alice.setMembership("bob", "read");
    await bob.sync();
    const deliveries = await messenger.receive(DOCUMENT_ID, "bob");
    const first = deliveries.find((d) => d.payload.includes('"value":"write"')) as Delivery;
    await messenger.send(DOCUMENT_ID, "alice", first.payload);
    await bob.sync();
    expect(bob.permissionOf("bob")).toBe("read");
  });
});

describe("merging registers (CTL-22, CTL-25, LOS-10)", () => {
  it("a late operation applies whenever it arrives: order does not matter", async () => {
    const messenger = new InMemoryMessengerPort();
    const { alice, bob } = await pair(messenger);
    await alice.setMembership("carol", "write");
    await alice.setMembership("bob", "read");
    await alice.setMembership("carol", "read");
    const reversed = new InMemoryMessengerPort();
    const sent = (await messenger.receive(DOCUMENT_ID, "alice")).filter((d) =>
      d.payload.includes('"kind":"control"'),
    );
    await reversed.createDocument(DOCUMENT_ID, "alice");
    const dave = await DocumentEngine.join(DOCUMENT_ID, "dave", reversed, undefined, AS_ALICE);
    for (const delivery of [...sent].reverse()) {
      await reversed.send(DOCUMENT_ID, "alice", delivery.payload);
    }
    await dave.sync();
    await bob.sync();
    for (const client of [bob, dave]) {
      expect(client.permissionOf("carol")).toBe("read");
      expect(client.permissionOf("bob")).toBe("read");
    }
  });

  it("a lost decision shows by a later control clock, and the creator heals it though there is no content to send", async () => {
    const messenger = new InMemoryMessengerPort();
    const { alice, bob } = await pair(messenger);
    await bob.sync();
    messenger.dropNextSend("alice");
    await alice.setMembership("carol", "write"); // lost
    await alice.setMembership("bob", "read");
    await bob.sync();
    expect(bob.permissionOf("carol")).toBeUndefined();
    expect(bob.permissionOf("bob")).toBe("read");

    await bob.requestResync();
    await alice.sync();
    await bob.sync();
    expect(bob.permissionOf("carol")).toBe("write");
    expect(bob.controlState.targets).toStrictEqual(alice.controlState.targets);
    expect(bob.controlClock).toStrictEqual(alice.controlClock);
  });

  it("a client that is fully up to date on content and control gets no answer at all", async () => {
    const messenger = new InMemoryMessengerPort();
    const { alice, bob } = await pair(messenger);
    await alice.setMembership("bob", "write");
    await alice.sync();
    await bob.sync();
    await bob.requestResync();
    const before = (await messenger.receive(DOCUMENT_ID, "alice")).length;
    await alice.sync();
    expect((await messenger.receive(DOCUMENT_ID, "alice")).length).toBe(before);
  });

  it("a snapshot from anyone but the creator that answers no request of one's own is ignored (RSY-12)", async () => {
    const messenger = new InMemoryMessengerPort();
    const { bob } = await pair(messenger);
    const forged = stateOf(
      { "member:mallory": { value: "write", clock: [T, 0], device: TAG } },
      true,
    );
    await messenger.send(DOCUMENT_ID, "mallory", forgedResponse(snapshotOf(forged)));
    await bob.sync();
    expect(bob.closed).toBe(false);
    expect(bob.permissionOf("mallory")).toBeUndefined();
  });

  it("a snapshot that answers another's request to all, for which this engine let a request of its own go, is merged as an answer to its own; one answering another's request it did not take up stays ignored (RSY-12, RSY-22)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
    const messenger = new InMemoryMessengerPort();
    const { alice, bob } = await pair(messenger);
    await alice.setMembership("bob", "write");
    await alice.sync();
    await bob.sync();
    expect(bob.hasCompletedBootstrap).toBe(true);
    // Alice's first edit reaches nobody, her second builds on it: Bob holds a gap of her stream.
    messenger.dropNextSend("alice");
    alice.edit((fragment) => insertPlainText(fragment, 0, "1"));
    await vi.advanceTimersByTimeAsync(0);
    alice.edit((fragment) => insertPlainText(fragment, 0, "2"));
    await vi.advanceTimersByTimeAsync(0);
    alice.dispose();
    await bob.sync();
    // Carol asks all, holding no more than Bob: Bob lets his request go for hers (RSY-22).
    const taken = "c0c0c0c0c0c0c0c0";
    await messenger.send(
      DOCUMENT_ID,
      "carol",
      encodeResyncRequestFrame({
        documentId: DOCUMENT_ID,
        requestId: taken,
        controlClock: null,
        controlDigest: null,
        all: true,
        force: false,
        stateVector: encodeStateVector(bob.document),
        stateDigest: digestOf(encodeDeletions(bob.document)),
        stream: "c1c1c1c1c1c1c1c1",
        sequence: 1,
      }),
    );
    const before = (await messenger.receive(DOCUMENT_ID, "alice")).length;
    await vi.advanceTimersByTimeAsync(11_000);
    await bob.sync();
    await vi.advanceTimersByTimeAsync(0);
    const sent = (await messenger.receive(DOCUMENT_ID, "alice")).slice(before);
    expect(sent.filter((delivery) => delivery.sender === "bob")).toStrictEqual([]);
    const answer = (respondsTo: string, member: string) =>
      encodeResyncResponseFrame({
        documentId: DOCUMENT_ID,
        respondsTo,
        update: new Uint8Array([0, 0]),
        control: snapshotOf(
          stateOf({ [`member:${member}`]: { value: "read", clock: [T, 0], device: TAG } }),
        ),
      });
    await messenger.send(DOCUMENT_ID, "dave", answer("c2c2c2c2c2c2c2c2", "mallory"));
    await messenger.send(DOCUMENT_ID, "dave", answer(taken, "erin"));
    await bob.sync();
    expect(bob.permissionOf("mallory")).toBeUndefined();
    expect(bob.permissionOf("erin")).toBe("read");
  });

  it("an older snapshot of the creator undoes nothing, and none reopens a closed document", async () => {
    const messenger = new InMemoryMessengerPort();
    const { alice, bob } = await pair(messenger);
    await alice.sync();
    await bob.sync();
    const old = alice.controlState;
    await alice.setMembership("bob", "read");
    await alice.closeDocument();
    await bob.sync();
    // Replayed by anyone who kept it: the creator's earlier snapshot, as an answer to nobody.
    await messenger.send(DOCUMENT_ID, "alice", forgedResponse(old));
    await bob.sync();
    expect(bob.permissionOf("bob")).toBe("read");
    expect(bob.closed).toBe(true);
  });

  it("a closed document still bootstraps a joiner, who learns it is closed and who may read", async () => {
    const messenger = new NoHistoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    await alice.setMembership("carol", "read");
    await alice.closeDocument();
    await alice.sync(); // a history-less transport shows alice only what comes after her first look
    const carol = await DocumentEngine.join(DOCUMENT_ID, "carol", messenger, undefined, AS_ALICE);
    await settle(alice, carol);
    expect(carol.hasCompletedBootstrap).toBe(true);
    expect(carol.closed).toBe(true);
    expect(carol.permissionOf("carol")).toBe("read");
  });
});

describe("closing (LIF-6, LIF-7)", () => {
  it("is idempotent and terminal: a second close issues nothing, and nothing more can be granted", async () => {
    const messenger = new InMemoryMessengerPort();
    const { alice, bob } = await pair(messenger);
    await alice.closeDocument();
    await alice.closeDocument();
    expect(alice.closed).toBe(true);
    const controls = (await messenger.receive(DOCUMENT_ID, "carol")).filter(
      (delivery) => JSON.parse(delivery.payload).kind === "control",
    );
    expect(controls).toHaveLength(1);
    await expect(alice.setMembership("bob", "write")).rejects.toBeInstanceOf(SendRefusedError);
    await bob.sync();
    expect(bob.closed).toBe(true);
  });

  /**
   * A close stops new edits at their sender, not in delivery (LIF-6). Bob's edit and Alice's close
   * are unordered on the transport; whichever a receiver sees first, it ends with the same content.
   */
  async function closeRace(order: "edit-first" | "close-first") {
    const messenger = new InMemoryMessengerPort();
    const { alice, bob } = await pair(messenger);
    await alice.setMembership("bob", "write");
    const carol = await DocumentEngine.join(DOCUMENT_ID, "carol", messenger, undefined, AS_ALICE);
    alice.edit((fragment) => insertPlainText(fragment, 0, "before "));
    await settle(alice, bob, carol);
    messenger.holdNextSend("bob");
    bob.edit((fragment) => insertPlainText(fragment, 7, "bob's late words"));
    await bob.flush();
    messenger.holdNextSend("alice");
    await alice.closeDocument();
    messenger.releaseHeld(DOCUMENT_ID, order === "edit-first" ? [0, 1] : [1, 0]);
    await carol.sync();
    await alice.sync();
    return { alice, carol };
  }

  it("an edit sent before a close is applied whichever arrives first, so every receiver converges", async () => {
    for (const order of ["edit-first", "close-first"] as const) {
      const { alice, carol } = await closeRace(order);
      expect(carol.closed, order).toBe(true);
      expect(getPlainText(carol.fragment), order).toBe("before bob's late words");
      expect(getPlainText(alice.fragment), order).toBe("before bob's late words");
    }
  });

  it("after a close, no client sends an edit of its own, the creator included", async () => {
    const messenger = new InMemoryMessengerPort();
    const { alice, bob } = await pair(messenger);
    await alice.closeDocument();
    await bob.sync();
    const before = (await messenger.receive(DOCUMENT_ID, "carol")).length;
    bob.edit((fragment) => insertPlainText(fragment, 0, "bob after the close"));
    alice.edit((fragment) => insertPlainText(fragment, 0, "alice after her own close"));
    await bob.flush().catch(() => {});
    await alice.flush().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    const after = await messenger.receive(DOCUMENT_ID, "carol");
    expect(after.slice(before).map((d) => JSON.parse(d.payload).kind)).not.toContain("edit");
    expect(bob.mayEdit).toBe(false);
    expect(alice.mayEdit).toBe(false);
    await expect(bob.resync()).rejects.toMatchObject({ reason: "closed" });
  });
});

describe("two devices of the creator at once (CTL-21, CTL-22, CTL-45)", () => {
  it("concurrent decisions on one member: the later by the devices' clocks holds everywhere, even wider; an informed one stands, though its wall clock lags", async () => {
    atWallClocks();
    const messenger = new InMemoryMessengerPort();
    const laptop = await DocumentEngine.create(
      DOCUMENT_ID,
      "alice",
      messenger,
      undefined,
      AS_ALICE,
    );
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, AS_ALICE);
    const tablet = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    await settle(laptop, tablet, bob);
    // The laptop answered Bob first; the tablet's repeat, once its first request expired, it answers
    // past the throttle of that answer (RSY-4, RSY-9).
    vi.setSystemTime(T + 11_000);
    await settle(laptop, tablet, bob);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await settle(laptop, tablet, bob);
    // The laptop's answer bootstrapped the tablet (RSY-14): it decides on the creator's state.
    expect(tablet.controlStanding).toStrictEqual({ kind: "bootstrapped" });
    // Neither has seen the other's decision when it makes its own: the tablet's is a minute later
    // and wider, and holds everywhere — the later, not the narrower (CTL-22).
    vi.setSystemTime(T + 60_000);
    const first = laptop.setMembership("bob", "read");
    vi.setSystemTime(T + 120_000);
    const second = tablet.setMembership("bob", "write");
    await Promise.all([first, second]);
    await settle(laptop, tablet, bob);
    for (const client of [laptop, tablet, bob]) {
      expect(client.permissionOf("bob")).toBe("write");
    }
    expect(laptop.controlState.targets).toStrictEqual(tablet.controlState.targets);
    // A third device of the creator, its clock two days ahead, grants write again. The laptop,
    // whose wall clock lags it by those days — beyond the span its own clock follows — decides read
    // having seen it: its decision's clock lies above the register on that target (CTL-21,
    // CTL-45), so its narrower choice now holds everywhere.
    const ahead: Clock = [T + 120_000 + 2 * 86_400_000, 0];
    await messenger.send(
      DOCUMENT_ID,
      "alice",
      frameOfDevice("F".repeat(22), "member:bob", "write", ahead),
    );
    await settle(laptop, tablet, bob);
    expect(bob.permissionOf("bob")).toBe("write");
    await laptop.setMembership("bob", "read");
    await settle(laptop, tablet, bob);
    for (const client of [laptop, tablet, bob]) {
      expect(client.permissionOf("bob")).toBe("read");
    }
    const decided = bob.controlState.targets["member:bob"]?.clock as Clock;
    expect(compareClocks(decided, ahead)).toBeGreaterThan(0);
    // Its own clock did not follow that register beyond the span: its next decision on another
    // target lies at most a day ahead (CTL-45).
    await laptop.setMembership("carol", "read");
    const next = laptop.controlState.targets["member:carol"]?.clock as Clock;
    expect(next[0]).toBeLessThanOrEqual(Date.now() + 86_400_000 + 1);
  });

  it("each device decides under its own tag, and both decisions hold everywhere", async () => {
    const messenger = new InMemoryMessengerPort();
    const laptop = await DocumentEngine.create(
      DOCUMENT_ID,
      "alice",
      messenger,
      undefined,
      AS_ALICE,
    );
    const tablet = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    await settle(laptop, tablet);
    expect(tablet.controlStanding).toStrictEqual({ kind: "bootstrapped" });
    await laptop.setMembership("bob", "write");
    await tablet.setMembership("carol", "read");
    await settle(laptop, tablet);
    expect(laptop.deviceTag).not.toBe(tablet.deviceTag);
    expect(laptop.controlState.targets["member:bob"]?.device).toBe(laptop.deviceTag);
    expect(laptop.controlState.targets["member:carol"]?.device).toBe(tablet.deviceTag);
    expect(laptop.controlState.targets).toStrictEqual(tablet.controlState.targets);
  });
});

describe("persistence and decisions offline (CTL-26)", () => {
  it("persists a decision, as unsent and with its clock, before the messenger sees it; nothing changes when that fails", async () => {
    const messenger = new InMemoryMessengerPort();
    const persisted: PersistedControlState[] = [];
    let failing = false;
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
      ...AS_ALICE,
      onControlStateChange: (state) => {
        if (failing) throw new Error("disk full");
        persisted.push(state);
      },
    });
    const sentBefore = (await messenger.receive(DOCUMENT_ID, "alice")).length;
    await alice.setMembership("bob", "write");
    // The first state that holds the decision: the one reported when the document was created,
    // with nothing decided yet, comes before it (CTL-26, RSY-14).
    const first = persisted.find(
      (state) => (state.unsent?.length ?? 0) > 0,
    ) as PersistedControlState;
    expect(first.unsent).toHaveLength(1);
    expect(first.unsent?.[0]).toContain('"member:bob":{');
    // The own clock persisted with it lies at the decision's clock (CTL-26, CTL-45).
    const decided = first.control.targets["member:bob"]?.clock as Clock;
    expect(compareClocks(first.clock as Clock, decided)).toBeGreaterThanOrEqual(0);
    expect(persisted.at(-1)?.unsent).toBeUndefined();

    failing = true;
    await expect(alice.setMembership("carol", "read")).rejects.toThrow(/disk full/);
    expect(alice.permissionOf("carol")).toBeUndefined();
    expect((await messenger.receive(DOCUMENT_ID, "alice")).length).toBe(sentBefore + 1);
  });

  it("a decision made offline holds at once, is retried, and reaches the others when the messenger is back", async () => {
    const messenger = new InMemoryMessengerPort();
    const { alice, bob } = await pair(messenger);
    await alice.sync();
    await bob.sync();
    let offline = true;
    const send = messenger.send.bind(messenger);
    messenger.send = async (documentId, sender, payload) => {
      if (offline && sender === "alice") {
        throw new TransportSendError("unavailable", "offline");
      }
      return send(documentId, sender, payload);
    };
    const decided = alice.setMembership("bob", "read");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(alice.permissionOf("bob")).toBe("read");
    expect(alice.sendStatus.state).toBe("retrying");
    offline = false;
    await alice.flush();
    await decided;
    await bob.sync();
    expect(bob.permissionOf("bob")).toBe("read");
  });

  it("a restarted device sends what it had not sent, decides above what it restored, and its snapshot lists everyone", async () => {
    const messenger = new NoHistoryMessengerPort();
    let saved: PersistedControlState | undefined;
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
      ...AS_ALICE,
      onControlStateChange: (state) => {
        saved = state;
      },
    });
    await alice.setMembership("bob", "write");
    // A decision persisted as unsent when the application stopped, a minute ahead of the wall
    // clock: crafted as a device whose clock ran ahead would have made it.
    const tag = alice.deviceTag as string;
    const pending = frameOfDevice(tag, "member:carol", "read", [Date.now() + 60_000, 0]);
    const state = { ...(saved as PersistedControlState), unsent: [pending] };
    alice.dispose();
    messenger.forgetHistory(DOCUMENT_ID, "alice");
    const restarted = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, {
      ...AS_ALICE,
      controlState: state,
    });
    await restarted.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(restarted.deviceTag).toBe(tag);
    const dave = await DocumentEngine.join(DOCUMENT_ID, "dave", messenger, undefined, AS_ALICE);
    await settle(restarted, dave);
    expect(dave.permissionOf("bob")).toBe("write");
    expect(dave.permissionOf("carol")).toBe("read");
    await restarted.setMembership("erin", "read");
    const targets = restarted.controlState.targets;
    expect(
      compareClocks(
        targets["member:erin"]?.clock as Clock,
        targets["member:carol"]?.clock as Clock,
      ),
    ).toBeGreaterThan(0);
  });

  it("a member's persisted control state that was never bootstrapped is not used, under this draft's marker too (CTL-39, RSY-14)", async () => {
    const messenger = new InMemoryMessengerPort();
    const held = stateOf({ "member:bob": { value: "write", clock: [T, 0], device: TAG } });
    await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, {
      ...AS_ALICE,
      controlState: { tdsp: CURRENT_FRAME_VERSION, control: held.state() },
    });
    expect(bob.permissionOf("bob")).toBeUndefined();
    expect(bob.controlStanding).toStrictEqual({ kind: "none" });
  });
});

describe("a decision is never lost on its way out (CTL-26)", () => {
  /** A transport that notes, at each control frame's send, what the device had persisted then. */
  class WatchingPort extends InMemoryMessengerPort {
    persisted: PersistedControlState | undefined;
    persistedAtSend: (PersistedControlState | undefined)[] = [];

    override async send(
      documentId: DocumentId,
      sender: MemberId,
      payload: string,
    ): Promise<string> {
      if ((JSON.parse(payload) as { kind?: string }).kind === "control") {
        this.persistedAtSend.push(this.persisted);
      }
      return super.send(documentId, sender, payload);
    }
  }

  const unsentFor = (state: PersistedControlState | undefined, target: string): boolean =>
    state?.unsent?.some((frame) => frame.includes(`"${target}":{`)) ?? false;

  it("is persisted as unsent when the messenger is handed it, as the transport sees at the send", async () => {
    const messenger = new WatchingPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
      ...AS_ALICE,
      onControlStateChange: (state) => {
        messenger.persisted = structuredClone(state);
      },
    });
    await alice.setMembership("bob", "write");
    expect(messenger.persistedAtSend).toHaveLength(1);
    expect(unsentFor(messenger.persistedAtSend[0], "member:bob")).toBe(true);
    // With the clock it was decided at, so a restart decides above it (CTL-26, CTL-45).
    const decided = alice.controlState.targets["member:bob"]?.clock as Clock;
    expect(messenger.persistedAtSend[0]?.clock).toStrictEqual(decided);
    // Taken by the messenger, it is no longer owed.
    expect(messenger.persisted?.unsent).toBeUndefined();
    expect(messenger.persisted?.clock).toStrictEqual(decided);
  });

  it("made offline, stays unsent in every state persisted while it is retried and after dispose(); a restart sends it", async () => {
    vi.useFakeTimers();
    try {
      await madeOffline();
    } finally {
      vi.useRealTimers();
    }
  });

  async function madeOffline(): Promise<void> {
    const messenger = new InMemoryMessengerPort();
    const persisted: PersistedControlState[] = [];
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
      ...AS_ALICE,
      onControlStateChange: (state) => {
        persisted.push(structuredClone(state));
      },
    });
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, AS_ALICE);
    await alice.sync();
    await bob.sync();
    messenger.disconnect("alice");
    const decided = alice.setMembership("bob", "read").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(alice.permissionOf("bob")).toBe("read"); // it holds at once (CTL-21)
    await vi.advanceTimersByTimeAsync(10_000); // retried, the messenger still away
    expect(alice.sendStatus.state).toBe("retrying");
    const first = persisted.findIndex((state) => unsentFor(state, "member:bob"));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(persisted.slice(first).every((state) => unsentFor(state, "member:bob"))).toBe(true);

    alice.dispose();
    await vi.advanceTimersByTimeAsync(10_000); // its last attempt fails too
    expect(await decided).toBeInstanceOf(Error); // this engine gave up...
    const last = persisted.at(-1) as PersistedControlState;
    expect(unsentFor(last, "member:bob")).toBe(true); // ...the decision did not

    messenger.reconnect("alice");
    const restarted = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, {
      ...AS_ALICE,
      controlState: last,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await bob.sync();
    expect(bob.permissionOf("bob")).toBe("read");
    restarted.dispose();
  }

  it("restored as unsent, stays owed when persisting fails, and goes out before the next decision", async () => {
    const messenger = new InMemoryMessengerPort();
    let saved: PersistedControlState | undefined;
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
      ...AS_ALICE,
      onControlStateChange: (state) => {
        saved = structuredClone(state);
      },
    });
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, AS_ALICE);
    await alice.setMembership("bob", "write");
    await settle(alice, bob);
    const tag = alice.deviceTag as string;
    // Persisted as unsent when the application stopped, before the messenger took it.
    const pending = frameOfDevice(tag, "member:carol", "read", [Date.now(), 1]);
    alice.dispose();
    messenger.disconnect("alice");
    let storageFull = true;
    const restarted = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, {
      ...AS_ALICE,
      controlState: { ...(saved as PersistedControlState), unsent: [pending] },
      onControlStateChange: () => {
        if (storageFull) throw new Error("storage is full");
      },
    });
    await expect(restarted.setMembership("dave", "write")).rejects.toThrow("storage is full");
    expect(restarted.permissionOf("dave")).toBeUndefined(); // not issued (CTL-26)
    expect(restarted.permissionOf("carol")).toBe("read"); // the restored one still holds

    storageFull = false;
    messenger.reconnect("alice");
    await restarted.setMembership("dave", "write");
    await settle(restarted, bob);
    expect(bob.permissionOf("carol")).toBe("read");
    expect(bob.permissionOf("dave")).toBe("write");
    const controlFrames = (await messenger.receive(DOCUMENT_ID, "bob"))
      .filter((d) => d.sender === "alice" && JSON.parse(d.payload).kind === "control")
      .map((d) => JSON.parse(d.payload) as { targets: Record<string, Register> });
    const carol = controlFrames.findIndex((frame) => frame.targets["member:carol"] !== undefined);
    const dave = controlFrames.findIndex((frame) => frame.targets["member:dave"] !== undefined);
    expect(carol).toBeGreaterThanOrEqual(0);
    expect(carol).toBeLessThan(dave);
    // The decision made after the restart lies above the restored one (CTL-45).
    const targets = bob.controlState.targets;
    expect(
      compareClocks(
        targets["member:dave"]?.clock as Clock,
        targets["member:carol"]?.clock as Clock,
      ),
    ).toBeGreaterThan(0);
  });
});

describe("a receiver at the bound of control state's bytes (CTL-30, CTL-32, CTL-34)", () => {
  it.each([
    ["the revocation first", ["revocation", "pace"] as const],
    ["the pace first", ["pace", "revocation"] as const],
  ])(
    "takes a revocation on a target it holds and the pace in either order (%s), without a capacity conflict: the measure counts targets only",
    async (_name, order) => {
      const messenger = new InMemoryMessengerPort();
      const { bob, applyErrors } = await pair(messenger);
      await settle(bob);
      // Registers of the creator up to exactly 3 MiB as CTL-34 measures them: names of control
      // characters take six bytes each as RFC 8785 writes them, and each target its name, the colon
      // and the width of the longest register, whatever it holds.
      const held = new ControlState();
      held.take({ closed: false, targets: bob.controlState.targets });
      const entry = (name: string) => JSON.stringify(name).length + 1 + REGISTER_WIDTH + 1;
      const targets: Record<string, Register> = {};
      const add = (name: string) => {
        targets[name] = { value: "read", clock: [T, 0], device: TAG };
        held.take({
          closed: false,
          targets: { [name]: { value: "read", clock: [T, 0], device: TAG } },
        });
      };
      // Member ids are at most 255 bytes (FRM): 251 such characters each, then up to two more names
      // that fill what is left exactly.
      const full = (i: number) => `member:${String(i).padStart(4, "0")}${"\u0001".repeat(251)}`;
      for (let i = 0; held.bytes + 2 * entry(full(i)) <= CONTROL_BYTES; i++) add(full(i));
      let last = "";
      for (let j = 0; held.bytes < CONTROL_BYTES; j++) {
        const fill = CONTROL_BYTES - held.bytes - entry(`member:f${j}`);
        const controls = Math.min(251, Math.floor(fill / 6));
        last = `member:f${j}${"\u0001".repeat(controls)}${"x".repeat(controls === 251 ? 0 : fill - 6 * controls)}`;
        add(last);
      }
      expect(held.bytes).toBe(CONTROL_BYTES);
      const names = Object.keys(targets);
      for (let from = 0; from < names.length; from += 400) {
        const part = Object.fromEntries(
          names.slice(from, from + 400).map((name) => [name, targets[name] as Register]),
        );
        await messenger.send(DOCUMENT_ID, "alice", frameOf(part));
      }
      await bob.sync();
      expect(bob.capacityConflict).toBe(false);
      expect(bob.permissionOf(last.slice("member:".length))).toBe("read");
      // A revocation of a target it holds, at the greatest counter, and the first pace: neither adds
      // a target, so neither changes the measure, in whichever order they arrive.
      const frames = {
        revocation: frameOfDevice(TAG, last, null, [T + 1_000, 65_535]),
        pace: frameOfDevice(TAG, "pace", 4_294_967_295, [T + 1_000, 65_535]),
      };
      for (const kind of order) {
        await messenger.send(DOCUMENT_ID, "alice", frames[kind]);
        await bob.sync();
      }
      expect(bob.capacityConflict).toBe(false);
      expect(bob.controlState.targets[last]?.value).toBeNull();
      expect(bob.pace).toBe(4_294_967_295);
      expect(applyErrors).toStrictEqual([]);
    },
  );
});

describe("two registers at one clock under one device tag, at a receiver (CTL-22, CTL-23)", () => {
  it.each([
    ["write first", "write", "read"],
    ["read first", "read", "write"],
  ])(
    "merge into the narrower, whichever arrives first (%s), so every receiver holds the same, and nothing is reported",
    async (_name, firstValue, secondValue) => {
      const messenger = new InMemoryMessengerPort();
      const { bob, applyErrors } = await pair(messenger);
      await settle(bob);
      await messenger.send(DOCUMENT_ID, "alice", op("member:carol", firstValue));
      await bob.sync();
      await messenger.send(DOCUMENT_ID, "alice", op("member:carol", secondValue));
      await bob.sync();
      expect(bob.permissionOf("carol")).toBe("read");
      expect(bob.controlState.targets["member:carol"]).toStrictEqual({
        value: "read",
        clock: [T, 0],
        device: TAG,
      });
      expect(applyErrors).toStrictEqual([]);
    },
  );
});

describe("a device restored from an older backup (CTL-21, CTL-45)", () => {
  it("keeps its tag, merges what it decided after the backup as anyone does, and decides above it; everyone converges", async () => {
    const messenger = new InMemoryMessengerPort();
    let backup: PersistedControlState | undefined;
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
      ...AS_ALICE,
      onControlStateChange: (state) => {
        backup ??=
          state.unsent === undefined && state.control.targets["member:bob"] !== undefined
            ? state
            : undefined;
      },
    });
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, AS_ALICE);
    await alice.setMembership("bob", "write"); // backed up
    await alice.setMembership("carol", "write"); // after the backup
    await settle(alice, bob);
    alice.dispose();
    const errors: unknown[] = [];
    const restored = await DocumentEngine.join(
      DOCUMENT_ID,
      "alice",
      messenger,
      (error) => errors.push(error),
      { ...AS_ALICE, controlState: backup as PersistedControlState },
    );
    await settle(restored, bob);
    // It read its own later decision from the history: held, and its clock above it.
    expect(restored.deviceTag).toBe(alice.deviceTag);
    expect(restored.permissionOf("carol")).toBe("write");
    await restored.setMembership("carol", "read");
    await restored.setMembership("dave", "read");
    await settle(restored, bob);
    expect(bob.permissionOf("carol")).toBe("read");
    expect(bob.permissionOf("dave")).toBe("read");
    expect(bob.controlState.targets).toStrictEqual(restored.controlState.targets);
    expect(errors).toStrictEqual([]);
  });
});

describe("a new device of the creator and members' answers (CTL-27, RSY-14)", () => {
  /** Alice's only device decided, then was lost; the transport keeps no history for a new one. */
  async function lostDevice() {
    atWallClocks();
    const messenger = new NoHistoryMessengerPort();
    const old = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, AS_ALICE);
    await old.setMembership("carol", "read");
    await old.setMembership("bob", "write");
    await settle(old, bob);
    old.dispose();
    // Its last messages, the report it owed as it closed among them (SND-11), went before; the new
    // device sees none of them.
    await new Promise((resolve) => setTimeout(resolve, 0));
    messenger.forgetHistory(DOCUMENT_ID, "alice");
    // The new device comes a minute later.
    vi.setSystemTime(T + 60_000);
    const fresh = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    return { messenger, bob, fresh };
  }

  it("decides nothing but the close before the creator's own state comes — the refusal names it —: nothing it decides unaware holds over the lost device's; its close holds", async () => {
    const { bob, fresh } = await lostDevice();
    await settle(fresh, bob);
    await expect(fresh.setMembership("carol", "write")).rejects.toMatchObject({
      reason: "not-bootstrapped",
    });
    await settle(fresh, bob);
    expect(bob.permissionOf("carol")).toBe("read");
    expect(bob.permissionOf("bob")).toBe("write");
    await fresh.closeDocument();
    await settle(fresh, bob);
    expect(bob.closed).toBe(true);
  });

  it("holds none of the lost device's rights before an answer brings them, and is not bootstrapped (CTL-25, CTL-27, RSY-14)", async () => {
    const { bob, fresh } = await lostDevice();
    await settle(fresh, bob);
    expect(getPlainText(fresh.fragment)).toBe(getPlainText(bob.fragment)); // the content came
    expect(fresh.permissionOf("carol")).toBeUndefined();
    expect(fresh.memberPermissions.size).toBe(0);
    expect(fresh.controlStanding).toStrictEqual({ kind: "none" });
  });

  it("while not bootstrapped it answers a joiner without a snapshot, so nobody is bootstrapped with empty rights", async () => {
    const messenger = new NoHistoryMessengerPort();
    const old = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    await old.setMembership("dave", "read");
    old.dispose();
    const fresh = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    const dave = await DocumentEngine.join(DOCUMENT_ID, "dave", messenger, undefined, AS_ALICE);
    await settle(fresh, dave);
    expect(dave.hasCompletedBootstrap).toBe(false);
    expect(dave.mayEdit).toBe(false);
  });
});

describe("bounded against anything a peer sends (CTL-30)", () => {
  it("holds registers of any number of devices of the creator: the targets bound what it holds, not the devices", async () => {
    const messenger = new InMemoryMessengerPort();
    const { bob, applyErrors } = await pair(messenger);
    // Even from the creator's own account: tags are not authenticated beyond it (CTL-5).
    for (let i = 0; i < 100; i++) {
      const device = `d${String(i).padStart(21, "0")}`;
      await messenger.send(DOCUMENT_ID, "alice", op(`member:m${i}`, "read", 0, 0, device));
    }
    await bob.sync();
    expect(bob.memberPermissions.size).toBe(100);
    expect(applyErrors).toStrictEqual([]);
  });

  it("holds at most 3 MiB of control state, whatever the creator's account sends, and is then in a capacity conflict", async () => {
    const messenger = new InMemoryMessengerPort();
    const { bob, applyErrors } = await pair(messenger);
    // MemberIds of control characters, each written as six bytes in JSON: the bytes bind before
    // the bound on targets.
    for (let i = 0; i < 3_000; i++) {
      await messenger.send(
        DOCUMENT_ID,
        "alice",
        op(`member:m${String(i).padStart(4, "0")}${"\u0001".repeat(240)}`, "read", i),
      );
    }
    await bob.sync();
    expect(bob.memberPermissions.size).toBeLessThan(3_000);
    expect(
      applyErrors.filter((e) => e instanceof ControlFrameRejectedError && e.reason === "refused")
        .length,
    ).toBeGreaterThan(0);
    const held = new TextEncoder().encode(canonicalJson({ targets: bob.controlState.targets }));
    expect(held.length).toBeLessThanOrEqual(3_145_728);
    expect(bob.capacityConflict).toBe(true);
    expect(bob.mayEdit).toBe(false);
  });

  it("a union over the bound on targets is a capacity conflict, never a silent cut of someone's right (CTL-30, CTL-32)", async () => {
    const messenger = new InMemoryMessengerPort();
    const { alice, bob, applyErrors } = await pair(messenger);
    await alice.setMembership("bob", "write");
    await settle(alice, bob);
    alice.dispose();
    expect(bob.mayEdit).toBe(true);
    // Two devices of the creator that each added 2 600 members: each within what it may decide,
    // together, beside bob's own, 201 beyond the 5 000 members a receiver holds beside the pace.
    for (const [device, from] of [
      ["A".repeat(22), 0],
      ["B".repeat(22), 2_600],
    ] as const) {
      for (let i = 0; i < 2_600; i++) {
        await messenger.send(
          DOCUMENT_ID,
          "alice",
          op(`member:m${String(from + i).padStart(5, "0")}`, "write", i, 0, device),
        );
      }
    }
    await bob.sync();
    expect(bob.capacityConflict).toBe(true);
    expect(bob.mayEdit).toBe(false);
    expect(bob.memberPermissions.size).toBe(5_000);
    expect(bob.memberPermissions.get("bob")).toBe("write"); // never cut, though he cannot write
    expect(
      applyErrors.filter((e) => e instanceof ControlFrameRejectedError && e.reason === "refused"),
    ).toHaveLength(201);
    // What it holds it still changes, and a close still closes (CTL-32, CTL-36).
    await messenger.send(DOCUMENT_ID, "alice", op("member:m00000", null, 10_000));
    await messenger.send(DOCUMENT_ID, "alice", closeFrame());
    await bob.sync();
    expect(bob.rightOf("m00000")).toBe("revoked");
    expect(bob.closed).toBe(true);
  });
});

describe("a new creator device is bootstrapped by another device of the creator's answer to its own request, never by a member's answer, the creator's frames or an answer to someone else; before, it decides nothing but the close (RSY-14, CTL-27)", () => {
  async function lost() {
    const messenger = new NoHistoryMessengerPort();
    const old = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, AS_ALICE);
    await old.setMembership("carol", null); // carol was removed
    await old.setMembership("bob", "write");
    await settle(old, bob);
    old.dispose();
    const fresh = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    await settle(fresh, bob);
    return { messenger, bob, fresh };
  }

  it("decides nothing but the close — the refusal names it —, and its close bootstraps it not", async () => {
    const { fresh } = await lost();
    await expect(fresh.setMembership("dave", "read")).rejects.toMatchObject({
      reason: "not-bootstrapped",
    });
    await fresh.closeDocument();
    expect(fresh.closed).toBe(true);
    expect(fresh.controlStanding).toStrictEqual({ kind: "none" });
  });

  it("while not bootstrapped, it bootstraps no joiner: a removed member does not come back unseen", async () => {
    const { messenger, fresh } = await lost();
    const carol = await DocumentEngine.join(DOCUMENT_ID, "carol", messenger, undefined, AS_ALICE);
    await settle(fresh, carol);
    expect(carol.hasCompletedBootstrap).toBe(false);
    expect(carol.mayEdit).toBe(false);
  });

  it("while not bootstrapped, it decides about no joiner and sends it no snapshot", async () => {
    const { messenger, fresh } = await lost();
    await expect(fresh.setMembership("dave", "read")).rejects.toMatchObject({
      reason: "not-bootstrapped",
    });
    const dave = await DocumentEngine.join(DOCUMENT_ID, "dave", messenger, undefined, AS_ALICE);
    await settle(fresh, dave);
    expect(dave.hasCompletedBootstrap).toBe(false);
    expect(dave.mayEdit).toBe(false);
  });

  it("is not bootstrapped by the creator's control frames read from the channel's history: they show part of its decisions, not all", async () => {
    const messenger = new InMemoryMessengerPort(); // keeps history
    const old = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    await old.setMembership("carol", null); // carol was removed
    await old.setMembership("bob", "write");
    old.dispose();
    const fresh = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    expect(fresh.permissionOf("bob")).toBe("write"); // held, as the creator's registers are
    expect(fresh.controlStanding).toStrictEqual({ kind: "none" });
    // So a joiner it never decided about itself gets no snapshot from it (RSY-8).
    const dave = await DocumentEngine.join(DOCUMENT_ID, "dave", messenger, undefined, AS_ALICE);
    await settle(fresh, dave);
    expect(dave.hasCompletedBootstrap).toBe(false);
  });

  it("merges a snapshot another device of the creator sent to whomever, but is bootstrapped only by an answer to its own request (RSY-12, RSY-14)", async () => {
    const { messenger, fresh } = await lost();
    const state = stateOf({ "member:erin": { value: "write", clock: [T, 0], device: TAG } });
    await messenger.send(DOCUMENT_ID, "alice", forgedResponse(snapshotOf(state)));
    await settle(fresh);
    expect(fresh.permissionOf("erin")).toBe("write"); // merged: the creator's answer counts (RSY-12, CTL-25)
    expect(fresh.controlStanding).toStrictEqual({ kind: "none" });
    const own = (await messenger.inner.receive(DOCUMENT_ID, "observer"))
      .filter((delivery) => delivery.sender === "alice")
      .map((delivery) => JSON.parse(delivery.payload) as { kind: string; requestId?: string })
      .filter((frame) => frame.kind === "resync-request")
      .at(-1);
    await messenger.send(
      DOCUMENT_ID,
      "alice",
      encodeResyncResponseFrame({
        documentId: DOCUMENT_ID,
        respondsTo: own?.requestId as string,
        update: new Uint8Array([0, 0]),
        control: snapshotOf(state),
      }),
    );
    await settle(fresh);
    expect(fresh.controlStanding).toStrictEqual({ kind: "bootstrapped" });
  });

  it("two devices that are not bootstrapped never bootstrap each other: a removed member is bootstrapped by neither", async () => {
    const { messenger, bob, fresh } = await lost();
    const second = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    await settle(fresh, second, bob);
    // Neither may decide about dave; dave asks while both are online.
    await expect(fresh.setMembership("dave", "read")).rejects.toMatchObject({
      reason: "not-bootstrapped",
    });
    const dave = await DocumentEngine.join(DOCUMENT_ID, "dave", messenger, undefined, AS_ALICE);
    await new Promise((resolve) => setTimeout(resolve, 1_100)); // past the throttle of its last answer (RSY-9)
    await settle(fresh, second, dave);
    expect(dave.hasCompletedBootstrap).toBe(false);
    expect(second.controlStanding).toStrictEqual({ kind: "none" });
    expect(fresh.controlStanding).toStrictEqual({ kind: "none" });
    // Carol, whom the lost device removed, asks while only the second is online.
    fresh.dispose();
    const carol = await DocumentEngine.join(DOCUMENT_ID, "carol", messenger, undefined, AS_ALICE);
    await settle(second, carol);
    expect(carol.hasCompletedBootstrap).toBe(false);
    expect(carol.mayEdit).toBe(false);
  });

  it("is bootstrapped by another device's answer to its own request, though it lacks nothing else (RSY-16, RSY-17)", async () => {
    const messenger = new InMemoryMessengerPort(); // keeps history
    let laptopState: PersistedControlState | undefined;
    const laptop = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
      ...AS_ALICE,
      onControlStateChange: (state) => {
        laptopState = state;
      },
    });
    await laptop.setMembership("carol", null);
    laptop.dispose();
    // A new device reads every control frame from the history while the laptop is away: not
    // bootstrapped.
    let phoneState: PersistedControlState | undefined;
    const phone = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, {
      ...AS_ALICE,
      onControlStateChange: (state) => {
        phoneState = state;
      },
    });
    await settle(phone);
    expect(phone.rightOf("carol")).toBe("revoked");
    expect(phone.controlStanding).toStrictEqual({ kind: "none" });
    expect(phoneState?.bootstrapped).toBeUndefined();
    const content = encodeUpdate(phone.document);
    phone.dispose();
    // Both come back, the phone first; it restored all it held, so it lacks nothing the laptop
    // holds. Its request states no control clock, so the laptop answers it all the same.
    const restarted = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, {
      ...AS_ALICE,
      controlState: phoneState as PersistedControlState,
      restore: { state: content },
    });
    expect(restarted.controlStanding).toStrictEqual({ kind: "none" });
    const back = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, {
      ...AS_ALICE,
      controlState: laptopState as PersistedControlState,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_100)); // past the throttle (RSY-9)
    await settle(back, restarted);
    expect(restarted.controlStanding).toStrictEqual({ kind: "bootstrapped" });
    // Bootstrapped, it bootstraps a joiner it never decided about, the laptop gone again.
    back.dispose();
    const dave = await DocumentEngine.join(DOCUMENT_ID, "dave", messenger, undefined, AS_ALICE);
    await new Promise((resolve) => setTimeout(resolve, 1_100)); // past the throttle (RSY-9)
    await settle(restarted, dave);
    expect(dave.hasCompletedBootstrap).toBe(true);
  });

  it("while not bootstrapped, a member's other device gets no snapshot from it either", async () => {
    const { messenger, bob, fresh } = await lost();
    // Another device of the creator decides about bob; the first hears it.
    await messenger.send(DOCUMENT_ID, "alice", frameOfDevice(TAG, "member:bob", "write", [T, 0]));
    await settle(fresh);
    bob.dispose();
    expect(fresh.permissionOf("bob")).toBe("write");
    // Bob's laptop asks while only the first device is online: it decided nothing about bob.
    const laptop = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, AS_ALICE);
    await new Promise((resolve) => setTimeout(resolve, 1_100)); // past the throttle of its last answer (RSY-9)
    await settle(fresh, laptop);
    expect(laptop.hasCompletedBootstrap).toBe(false);
  });
});

describe("a device in a capacity conflict hands on no control state (RSY-8, CTL-32)", () => {
  /** A frame of the creator's account with 5 001 members, one beyond the bound (CTL-30). */
  async function pushIntoConflict(messenger: MessengerPort, ...engines: DocumentEngine[]) {
    const targets: Record<string, Register> = {};
    for (let i = 0; i <= 5_000; i++) {
      targets[`member:x${i}`] = { value: "read", clock: [T, 0], device: TAG };
    }
    await messenger.send(DOCUMENT_ID, "alice", frameOf(targets));
    for (const engine of engines) {
      await engine.sync();
      expect(engine.capacityConflict).toBe(true);
    }
  }

  it("a device of the creator in a conflict answers a joiner without a snapshot", async () => {
    const messenger = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    await alice.setMembership("dave", "read");
    await pushIntoConflict(messenger, alice);
    const dave = await DocumentEngine.join(DOCUMENT_ID, "dave", messenger, undefined, AS_ALICE);
    await settle(alice, dave);
    expect(dave.hasCompletedBootstrap).toBe(false);
    expect(dave.mayEdit).toBe(false);
  });

  it("a device of the creator keeps its conflict across a restart, and still answers a joiner without a snapshot", async () => {
    const messenger = new InMemoryMessengerPort();
    const persisted: PersistedControlState[] = [];
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
      ...AS_ALICE,
      onControlStateChange: (state) => persisted.push(state),
    });
    await alice.setMembership("dave", "read");
    await pushIntoConflict(messenger, alice);
    const saved = persisted.at(-1) as PersistedControlState;
    expect(saved.capacityConflict).toBe(true);
    alice.dispose();
    // The channel holds nothing any more: only the persisted state can bring the conflict back.
    messenger.forgetOldest(DOCUMENT_ID, (await messenger.receive(DOCUMENT_ID, "observer")).length);
    const restarted = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, {
      ...AS_ALICE,
      controlState: saved,
    });
    expect(restarted.capacityConflict).toBe(true);
    const dave = await DocumentEngine.join(DOCUMENT_ID, "dave", messenger, undefined, AS_ALICE);
    await settle(restarted, dave);
    expect(dave.hasCompletedBootstrap).toBe(false);
  });

  it("a member's device in a conflict answers its other device without control state", async () => {
    const messenger = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    await alice.setMembership("bob", "write");
    const phone = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, AS_ALICE);
    await settle(alice, phone);
    expect(phone.hasCompletedBootstrap).toBe(true);
    alice.dispose(); // from here on the creator is offline
    await pushIntoConflict(messenger, phone);
    const laptop = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, AS_ALICE);
    await settle(phone, laptop);
    expect(laptop.hasCompletedBootstrap).toBe(false);
    expect(laptop.mayEdit).toBe(false);
  });
});

describe("a revoked member is not an unknown one (CTL-13, CTL-23, §7.1)", () => {
  it("refuses to send once the creator revoked its permission, as a reader does, and says why", async () => {
    const messenger = new InMemoryMessengerPort();
    const refusals: unknown[] = [];
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    await alice.setMembership("bob", "write");
    const bob = await DocumentEngine.join(
      DOCUMENT_ID,
      "bob",
      messenger,
      (error) => {
        if (error instanceof SendRefusedError) refusals.push(error);
      },
      AS_ALICE,
    );
    await settle(alice, bob);
    bob.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
    await settle(bob, alice);
    expect(getPlainText(alice.fragment)).toBe("Plan");

    await alice.setMembership("bob", null);
    await settle(alice, bob);
    expect(bob.rightOf("bob")).toBe("revoked");
    expect(bob.permissionOf("bob")).toBeUndefined();
    expect(bob.revokedMembers.has("bob")).toBe(true);
    expect(bob.mayEdit).toBe(false);
    await expect(bob.resync()).rejects.toMatchObject({ reason: "revoked" });
    bob.edit((fragment) => insertPlainText(fragment, 4, " B"));
    await settle(bob, alice);
    expect(getPlainText(alice.fragment)).toBe("Plan");
    expect(refusals).toStrictEqual([expect.objectContaining({ reason: "revoked" })]);
  });

  it.each([
    ["the revocation later", "read", null, "revoked"],
    ["the read later", null, "read", "read"],
  ] as const)(
    "concurrent read and revoke from two devices of the creator (%s): the later holds everywhere, never write",
    async (_name, earlier, later, holds) => {
      atWallClocks();
      const messenger = new InMemoryMessengerPort();
      const laptop = await DocumentEngine.create(
        DOCUMENT_ID,
        "alice",
        messenger,
        undefined,
        AS_ALICE,
      );
      await laptop.setMembership("bob", "write");
      const tablet = await DocumentEngine.join(
        DOCUMENT_ID,
        "alice",
        messenger,
        undefined,
        AS_ALICE,
      );
      const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, AS_ALICE);
      await settle(laptop, tablet, bob);
      expect(bob.mayEdit).toBe(true);
      // Neither has seen the other's decision when it makes its own; the tablet's is a minute later.
      vi.setSystemTime(T + 60_000);
      const first = laptop.setMembership("bob", earlier);
      vi.setSystemTime(T + 120_000);
      const second = tablet.setMembership("bob", later);
      await Promise.all([first, second]);
      await settle(laptop, tablet, bob);
      for (const client of [laptop, tablet, bob]) {
        expect(client.rightOf("bob")).toBe(holds);
        expect(client.memberPermissions.get("bob")).not.toBe("write");
      }
      expect(bob.mayEdit).toBe(false);
      await expect(bob.resync()).rejects.toMatchObject({
        reason: holds === "read" ? "read-only" : "revoked",
      });
    },
  );

  it("a member the creator never named stays unknown beside a revoked one: both refuse after the bootstrap, each for its own reason", async () => {
    const messenger = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    await alice.setMembership("carol", null);
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, AS_ALICE);
    await settle(alice, bob);
    expect(bob.hasCompletedBootstrap).toBe(true);
    expect(bob.rightOf("bob")).toBe("unknown");
    expect(bob.rightOf("carol")).toBe("revoked");
    expect(bob.mayEdit).toBe(false);
    await expect(bob.resync()).rejects.toMatchObject({ reason: "unknown-permission" });
  });

  it("a revoked member's restored state refuses its edits after a restart too", async () => {
    const messenger = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    await alice.setMembership("bob", "write");
    await alice.setMembership("bob", null);
    let saved: PersistedControlState | undefined;
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, {
      ...AS_ALICE,
      onControlStateChange: (state) => {
        saved = state;
      },
    });
    await settle(alice, bob);
    expect(saved?.bootstrapped).toBe(true);
    bob.dispose();
    const restarted = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, {
      ...AS_ALICE,
      controlState: saved as PersistedControlState,
    });
    expect(restarted.rightOf("bob")).toBe("revoked");
    expect(restarted.mayEdit).toBe(false);
    await expect(restarted.resync()).rejects.toMatchObject({ reason: "revoked" });
  });
});

describe("a decision's loss is noticed once the creator pauses (SND-11, LOS-10)", () => {
  it("the report after her phase of typing states her control clock: the member knows he lacks the decision", async () => {
    vi.useFakeTimers();
    try {
      await lostWhileTyping();
    } finally {
      vi.useRealTimers();
    }
  });

  async function lostWhileTyping(): Promise<void> {
    const watched = {
      batchWindowMs: 500,
      creatorMemberId: "alice",
      syncPolicy: { minIntervalMs: 1_000, maxIntervalMs: 20_000, expectedLatencyMs: 5_000 },
    };
    const messenger = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, watched);
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, watched);
    for (let round = 0; round < 3; round++) {
      await alice.sync();
      await bob.sync();
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(bob.hasCompletedBootstrap).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000); // every report the join owed has gone out
    await bob.sync();
    expect(bob.syncHealth.state).toBe("ok");

    // The revocation is lost; her typing goes on from it, so her report carries her last edit, not
    // the revocation (SND-27): only the control clock it states can show bob that it exists (LOS-10).
    messenger.dropNextSend("alice");
    const decided = alice.setMembership("carol", null);
    await vi.advanceTimersByTimeAsync(1_000);
    await decided;
    // Alice types on and on, never pausing for her quiet time: a change is always pending.
    let at = 0;
    for (let elapsed = 0; elapsed < 30_000; elapsed += 100) {
      alice.edit((fragment) => insertPlainText(fragment, at++, "x"));
      await vi.advanceTimersByTimeAsync(100);
      if (elapsed % 1_000 === 0) await bob.sync();
    }
    // While a change of hers waits, no report goes (SND-11).
    await bob.sync();
    expect(bob.syncHealth.state).toBe("ok");
    // She pauses: the last change goes after the quiet time, the report 10 s after it.
    await vi.advanceTimersByTimeAsync(500 + REPORT_AFTER_MS);
    await bob.sync();
    expect(bob.rightOf("carol")).toBe("unknown"); // bob never saw the revocation...
    // ...but after the waiting time he knows he lacks it.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(bob.syncHealth.suspicions).toContainEqual(
      expect.objectContaining({ kind: "control-behind" }),
    );
    alice.dispose();
    bob.dispose();
  }
});

/**
 * A member on several devices (RSY-6, RSY-8, RSY-12, RSY-13): a device brings another device of
 * its own member up to date, its control state included, so it need not wait for the creator.
 */
describe("a member on several devices", () => {
  async function phoneOnline(permission: "read" | "write") {
    const port = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
    await alice.setMembership("bob", permission);
    alice.edit((fragment) => insertPlainText(fragment, 0, "from alice"));
    const phone = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, AS_ALICE);
    await alice.sync(); // answers the phone; from here on alice is offline
    await phone.sync();
    expect(phone.hasCompletedBootstrap).toBe(true);
    return { port, alice, phone };
  }

  it("a new device is brought up to date by its other device while the creator is offline, and may write", async () => {
    const { port, phone } = await phoneOnline("write");
    const laptop = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, AS_ALICE);
    expect(laptop.hasCompletedBootstrap).toBe(false);
    await phone.sync(); // answers its own member's other device
    await laptop.sync();

    expect(laptop.hasCompletedBootstrap).toBe(true);
    expect(laptop.permissionOf("bob")).toBe("write");
    expect(getPlainText(laptop.fragment)).toBe("from alice");
    laptop.edit((fragment) => insertPlainText(fragment, 0, "laptop: "));
    await phone.sync();
    expect(getPlainText(phone.fragment)).toBe("laptop: from alice");
  });

  it("a read-only member's new device learns it is read-only from its other device", async () => {
    const { port, phone } = await phoneOnline("read");
    const laptop = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, AS_ALICE);
    await phone.sync();
    await laptop.sync();

    expect(laptop.hasCompletedBootstrap).toBe(true);
    expect(laptop.permissionOf("bob")).toBe("read");
    const errors: unknown[] = [];
    const refusing = await DocumentEngine.join(DOCUMENT_ID, "bob", port, (e) => errors.push(e), {
      ...AS_ALICE,
    });
    await phone.sync();
    await refusing.sync();
    refusing.edit((fragment) => insertPlainText(fragment, 0, "not allowed"));
    await refusing.flush().catch(() => {});
    expect(errors.some((e) => e instanceof SendRefusedError && e.reason === "read-only")).toBe(
      true,
    );
  });
});

describe("a device of the creator adds a target only up to 1 MiB of control state (CTL-37)", () => {
  it("a new target that brings it to exactly 1 048 576 bytes is decided, one a byte longer is refused, and a target it holds is decided past that", () => {
    const state = new ControlState();
    const register = (clock: Clock): Register => ({ value: "read", clock, device: TAG });
    const long = (i: number): `member:${string}` =>
      `member:${String(i).padStart(4, "0")}${"x".repeat(240)}`;
    // Long names to just under the bound, leaving room for one more target.
    for (let i = 0; ; i++) {
      const probe = state.copy();
      probe.take({ closed: false, targets: { [long(i)]: register([T, 0]) } });
      if (probe.bytes > ISSUE_BYTES - 200) break;
      state.take({ closed: false, targets: { [long(i)]: register([T, 0]) } });
    }
    // One name more where the gap is wider than a single name can fill to the byte.
    for (let k = 1; k < 250 && ISSUE_BYTES - state.bytes > 352; k++) {
      const probe = state.copy();
      probe.take({ closed: false, targets: { [`member:mid${"z".repeat(k)}`]: register([T, 0]) } });
      const gap = ISSUE_BYTES - probe.bytes;
      if (gap >= 150 && gap <= 300) {
        state.take({
          closed: false,
          targets: { [`member:mid${"z".repeat(k)}`]: register([T, 0]) },
        });
        break;
      }
    }
    // The name that brings it to exactly the bound, and one a byte longer.
    let fits: `member:${string}` | undefined;
    for (let k = 1; k < 250 && fits === undefined; k++) {
      const name = `member:last${"y".repeat(k)}` as const;
      const probe = state.copy();
      probe.take({ closed: false, targets: { [name]: register([T, 1]) } });
      if (probe.bytes === ISSUE_BYTES) fits = name;
    }
    if (fits === undefined) throw new Error("no name brings the state to exactly 1 MiB");
    const accepted = state.issue(fits, register([T, 1]));
    if (!("next" in accepted)) throw new Error(`refused: ${accepted.refused}`);
    expect(accepted.next.bytes).toBe(ISSUE_BYTES);
    expect(state.issue(`${fits}y`, register([T, 1]))).toStrictEqual({ refused: "too-large" });
    expect("next" in accepted.next.issue(long(0), register([T, 2]))).toBe(true);
  });
});
