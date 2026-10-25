import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import type {
  Delivery,
  DocumentId,
  MemberId,
  MessengerPort,
  RawChannel,
} from "@tdsp/messenger-port";
import { TransportSendError } from "@tdsp/messenger-port";
import { getPlainText, insertPlainText } from "@tdsp/reconciliation";
import { describe, expect, it, vi } from "vitest";
import { ControlState } from "./control-state";
import { encodeControlFrame, encodeResyncResponseFrame } from "./framing";
import {
  ControlFrameRejectedError,
  DocumentEngine,
  type PersistedControlState,
  SendRefusedError,
} from "./index";

/**
 * Who may change a document, and what everyone else refuses (SPECIFICATION.md §7,
 * §1): control state as operations of the creator's devices, merged by union; permissions and
 * their enforcement on send; a joiner's bootstrap; replayed, stale, forged and reported control
 * state; closing; two devices of the creator at once; persistence and a restored or new device.
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

/** A control operation as anyone could write it; whether it counts is the receiver's check. */
function op(
  counter: number,
  target: string,
  value: unknown,
  seen: Record<string, number> = {},
): string {
  return encodeControlFrame({
    documentId: DOCUMENT_ID,
    device: TAG,
    counter,
    target: target as "member:bob",
    value: value as "read",
    seen,
  });
}

function snapshotOf(state: ControlState) {
  return { profile: "yjs-paragraphs/1", ...state.snapshot() };
}

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

  it("a joiner may not edit before the creator has bootstrapped it, and may once it has, while its permission is unknown", async () => {
    const messenger = new InMemoryMessengerPort();
    const { alice, bob } = await pair(messenger);
    expect(bob.mayEdit).toBe(false);
    await expect(bob.resync()).rejects.toMatchObject({ reason: "awaiting-bootstrap" });
    await alice.sync();
    await bob.sync();
    expect(bob.hasCompletedBootstrap).toBe(true);
    expect(bob.permissionOf("bob")).toBeUndefined();
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

describe("authority: only the creator's operations count (CTL-5)", () => {
  it("an operation from anyone but the creator is ignored, and reported as such", async () => {
    const messenger = new InMemoryMessengerPort();
    const { bob, applyErrors } = await pair(messenger);
    await messenger.send(DOCUMENT_ID, "mallory", op(1, "member:mallory", "write"));
    await bob.sync();
    expect(bob.permissionOf("mallory")).toBeUndefined();
    expect(applyErrors).toStrictEqual([expect.objectContaining({ reason: "not-from-creator" })]);
  });

  it("a pace from anyone but the creator is ignored, and reported; the creator's holds (SND-15)", async () => {
    const messenger = new InMemoryMessengerPort();
    const { bob, applyErrors } = await pair(messenger);
    await messenger.send(DOCUMENT_ID, "mallory", op(1, "pace", 3_600_000));
    await bob.sync();
    expect(bob.pace).toBeUndefined();
    expect(applyErrors).toStrictEqual([expect.objectContaining({ reason: "not-from-creator" })]);
    await messenger.send(DOCUMENT_ID, "alice", op(1, "pace", 60_000));
    await bob.sync();
    expect(bob.pace).toBe(60_000);
  });

  it("an operation that names the creator is ignored, and reported", async () => {
    const messenger = new InMemoryMessengerPort();
    const { bob, applyErrors } = await pair(messenger);
    await messenger.send(DOCUMENT_ID, "alice", op(1, "member:alice", "read"));
    await bob.sync();
    expect(bob.permissionOf("alice")).toBe("creator");
    expect(applyErrors).toStrictEqual([expect.objectContaining({ reason: "names-the-creator" })]);
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

  it("a replayed operation under a new delivery id is inert", async () => {
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

describe("merging operations (CTL-23, CTL-25, LOS-10)", () => {
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

  it("a lost operation is a hole, believed after a latency, and the creator heals it though there is no content to send", async () => {
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
    expect(bob.controlVector).toStrictEqual(alice.controlVector);
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

  it("a snapshot from anyone but the creator is ignored", async () => {
    const messenger = new InMemoryMessengerPort();
    const { bob } = await pair(messenger);
    const forged = new ControlState();
    forged.add({ device: TAG, counter: 1, target: "member:mallory", value: "write", seen: {} });
    forged.add({ device: TAG, counter: 2, target: "close", value: true, seen: {} });
    await messenger.send(DOCUMENT_ID, "mallory", forgedResponse(snapshotOf(forged)));
    await bob.sync();
    expect(bob.closed).toBe(false);
    expect(bob.permissionOf("mallory")).toBeUndefined();
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
    expect(alice.controlVector[alice.deviceTag as string]).toBe(1);
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

describe("two devices of the creator at once (CTL-22, CTL-23)", () => {
  it("concurrent decisions on one member: the narrower holds everywhere; an informed later one stands, even wider", async () => {
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
    // Neither has seen the other's decision when it makes its own.
    await Promise.all([laptop.setMembership("bob", "write"), tablet.setMembership("bob", "read")]);
    await settle(laptop, tablet, bob);
    for (const client of [laptop, tablet, bob]) {
      expect(client.permissionOf("bob")).toBe("read");
    }
    expect(laptop.controlState).toStrictEqual(tablet.controlState);
    // Having seen both, the laptop decides again: its wider choice now holds everywhere.
    await laptop.setMembership("bob", "write");
    await settle(laptop, tablet, bob);
    for (const client of [laptop, tablet, bob]) {
      expect(client.permissionOf("bob")).toBe("write");
    }
  });

  it("each device takes its own counters: no number is ever taken twice, whoever acts", async () => {
    const messenger = new InMemoryMessengerPort();
    const laptop = await DocumentEngine.create(
      DOCUMENT_ID,
      "alice",
      messenger,
      undefined,
      AS_ALICE,
    );
    const tablet = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    await laptop.setMembership("bob", "write");
    await tablet.setMembership("carol", "read");
    await settle(laptop, tablet);
    expect(laptop.deviceTag).not.toBe(tablet.deviceTag);
    expect(laptop.controlVector).toStrictEqual({
      [laptop.deviceTag as string]: 1,
      [tablet.deviceTag as string]: 1,
    });
    expect(laptop.controlAnomalies).toStrictEqual([]);
  });
});

describe("persistence and decisions offline (CTL-26)", () => {
  it("persists an operation, as unsent, before the messenger sees it; nothing changes when that fails", async () => {
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
    // The first state that holds the operation: the one reported when the document was created,
    // with nothing decided yet, comes before it (CTL-26, CTL-28).
    const first = persisted.find(
      (state) => (state.unsent?.length ?? 0) > 0,
    ) as PersistedControlState;
    expect(first.unsent).toHaveLength(1);
    expect(first.unsent?.[0]).toContain('"target":"member:bob"');
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

  it("a restarted device sends what it had not sent, continues its counter, and its snapshot lists everyone", async () => {
    const messenger = new NoHistoryMessengerPort();
    let saved: PersistedControlState | undefined;
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
      ...AS_ALICE,
      onControlStateChange: (state) => {
        saved = state;
      },
    });
    await alice.setMembership("bob", "write");
    // An operation persisted as unsent when the application stopped: crafted as the device would.
    const tag = alice.deviceTag as string;
    const pending = encodeControlFrame({
      documentId: DOCUMENT_ID,
      device: tag,
      counter: 2,
      target: "member:carol",
      value: "read",
      seen: {},
    });
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
    expect(restarted.controlVector[tag]).toBe(3);
  });

  it("persisted control state is ignored for anyone but the creator", async () => {
    const messenger = new InMemoryMessengerPort();
    const forged = new ControlState();
    forged.add({ device: TAG, counter: 1, target: "member:bob", value: "write", seen: {} });
    await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, {
      ...AS_ALICE,
      controlState: { control: forged.snapshot() },
    });
    expect(bob.permissionOf("bob")).toBeUndefined();
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
    state?.unsent?.some((frame) => frame.includes(`"target":"${target}"`)) ?? false;

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
    expect(messenger.persistedAtSend[0]?.counter).toBe(1);
    // Taken by the messenger, it is no longer owed.
    expect(messenger.persisted?.unsent).toBeUndefined();
    expect(messenger.persisted?.counter).toBe(1);
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
    await alice.setMembership("bob", "write"); // counter 1
    await settle(alice, bob);
    const tag = alice.deviceTag as string;
    // Persisted as unsent when the application stopped, before the messenger took it.
    const pending = encodeControlFrame({
      documentId: DOCUMENT_ID,
      device: tag,
      counter: 2,
      target: "member:carol",
      value: "read",
      seen: {},
    });
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
    expect(restarted.controlVector[tag]).toBe(3);
    const controlFrames = (await messenger.receive(DOCUMENT_ID, "bob"))
      .filter((d) => d.sender === "alice" && JSON.parse(d.payload).kind === "control")
      .map((d) => JSON.parse(d.payload) as { counter: number });
    const two = controlFrames.findIndex((frame) => frame.counter === 2);
    const three = controlFrames.findIndex((frame) => frame.counter === 3);
    expect(two).toBeGreaterThanOrEqual(0);
    expect(two).toBeLessThan(three);
  });
});

describe("two operations under one device and counter, at a receiver (CTL-24)", () => {
  it.each([
    ["write first", "write", "read"],
    ["read first", "read", "write"],
  ])(
    "merge into the narrower, whichever arrives first (%s), and the receiver says so",
    async (_name, firstValue, secondValue) => {
      const messenger = new InMemoryMessengerPort();
      const { bob, applyErrors } = await pair(messenger);
      await settle(bob);
      await messenger.send(DOCUMENT_ID, "alice", op(1, "member:carol", firstValue));
      await bob.sync();
      await messenger.send(DOCUMENT_ID, "alice", op(1, "member:carol", secondValue));
      await bob.sync();
      expect(bob.permissionOf("carol")).toBe("read");
      expect(bob.controlAnomalies).toStrictEqual([{ device: TAG, counter: 1 }]);
      expect(
        applyErrors.some(
          (error) => error instanceof ControlFrameRejectedError && error.reason === "anomaly",
        ),
      ).toBe(true);
    },
  );
});

describe("a device restored from an older backup (CTL-24)", () => {
  it("changes its tag when it sees its own tag under a counter it does not hold; everyone merges both and converges", async () => {
    const messenger = new InMemoryMessengerPort();
    let backup: PersistedControlState | undefined;
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
      ...AS_ALICE,
      onControlStateChange: (state) => {
        backup ??= state.unsent === undefined && state.counter === 1 ? state : undefined;
      },
    });
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, AS_ALICE);
    await alice.setMembership("bob", "write"); // counter 1, backed up
    await alice.setMembership("carol", "write"); // counter 2, after the backup
    await settle(alice, bob);
    alice.dispose();
    const errors: unknown[] = [];
    const restored = await DocumentEngine.join(
      DOCUMENT_ID,
      "alice",
      messenger,
      (error) => errors.push(error),
      {
        ...AS_ALICE,
        controlState: backup as PersistedControlState,
      },
    );
    await settle(restored, bob);
    // Reading its own counter 2 from the history, it took a new tag before issuing anything.
    expect(restored.deviceTag).not.toBe(alice.deviceTag);
    await restored.setMembership("dave", "read");
    await settle(restored, bob);
    expect(bob.permissionOf("carol")).toBe("write");
    expect(bob.permissionOf("dave")).toBe("read");
    expect(bob.controlAnomalies).toStrictEqual([]);
    expect(
      errors.some((e) => e instanceof ControlFrameRejectedError && e.reason === "anomaly"),
    ).toBe(true);
  });
});

describe("a new device of the creator and participants' reports (CTL-27, CTL-29)", () => {
  /** Alice's only device decided, then was lost; the transport keeps no history for a new one. */
  async function lostDevice() {
    const messenger = new NoHistoryMessengerPort();
    const old = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, AS_ALICE);
    await old.setMembership("carol", "read");
    await old.setMembership("bob", "write");
    await settle(old, bob);
    old.dispose();
    const fresh = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    return { messenger, bob, fresh };
  }

  it("takes from a member's answer only what to supersede: its grant then holds everywhere, even wider", async () => {
    const { bob, fresh } = await lostDevice();
    await settle(fresh, bob);
    await fresh.setMembership("carol", "write");
    await settle(fresh, bob);
    expect(bob.permissionOf("carol")).toBe("write");
    expect(bob.permissionOf("bob")).toBe("write");
  });

  it("never takes a reported value into its control state; it may show it as unconfirmed", async () => {
    const { bob, fresh } = await lostDevice();
    await settle(fresh, bob);
    expect(fresh.permissionOf("carol")).toBeUndefined();
    expect(fresh.memberPermissions.size).toBe(0);
    expect(fresh.reportedControlState?.targets["member:carol"]).toBeDefined();
  });

  it("a forged report cannot grant anything: values from a member's answer never apply anywhere", async () => {
    const { messenger, bob, fresh } = await lostDevice();
    // Mallory answers the new device's own request — by its id, so the answer is accepted as a
    // member's (RSY-12) — with a report naming herself a writer.
    const request = (await messenger.inner.receive(DOCUMENT_ID, "bob"))
      .map((delivery) => JSON.parse(delivery.payload) as { kind: string; requestId?: string })
      .filter((frame) => frame.kind === "resync-request")
      .at(-1) as { requestId: string };
    const forged = new ControlState();
    forged.add({ device: TAG, counter: 1, target: "member:mallory", value: "write", seen: {} });
    await messenger.inner.send(
      DOCUMENT_ID,
      "mallory",
      encodeResyncResponseFrame({
        documentId: DOCUMENT_ID,
        respondsTo: request.requestId,
        update: new Uint8Array([0, 0]),
        control: snapshotOf(forged),
      }),
    );
    await settle(fresh, bob);
    // Taken as a report, which it was — shown, and only as that (CTL-27, CTL-33).
    expect(fresh.controlDivergences).toContainEqual(
      expect.objectContaining({ reporter: "mallory", target: "member:mallory", reported: "write" }),
    );
    expect(fresh.permissionOf("mallory")).toBeUndefined();
    expect(bob.permissionOf("mallory")).toBeUndefined();
  });

  it("without any basis it answers a joiner without a snapshot, so nobody is bootstrapped with empty rights", async () => {
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
  it("holds operations of at most 64 creator devices and refuses, and reports, the rest", async () => {
    const messenger = new InMemoryMessengerPort();
    const { bob, applyErrors } = await pair(messenger);
    // Even from the creator's own account: tags are not authenticated beyond it (CTL-5).
    for (let i = 0; i < 100; i++) {
      const device = `d${String(i).padStart(21, "0")}`;
      await messenger.send(
        DOCUMENT_ID,
        "alice",
        encodeControlFrame({
          documentId: DOCUMENT_ID,
          device,
          counter: 1,
          target: `member:m${i}` as "member:bob",
          value: "read",
          seen: {},
        }),
      );
    }
    await bob.sync();
    expect(Object.keys(bob.controlVector)).toHaveLength(64);
    expect(bob.memberPermissions.size).toBe(64);
    expect(
      applyErrors.filter((e) => e instanceof ControlFrameRejectedError && e.reason === "refused"),
    ).toHaveLength(36);
  });

  it("holds at most 1024 counters above a hole of one device", async () => {
    const messenger = new InMemoryMessengerPort();
    const { bob, applyErrors } = await pair(messenger);
    for (let counter = 2; counter <= 1030; counter++) {
      await messenger.send(DOCUMENT_ID, "alice", op(counter, "member:bob", "read"));
    }
    await bob.sync();
    expect(
      applyErrors.filter((e) => e instanceof ControlFrameRejectedError && e.reason === "refused"),
    ).toHaveLength(5);
  });

  it("holds at most 3 MiB of control state, whatever the creator's account sends, and is then in a capacity conflict", async () => {
    const messenger = new InMemoryMessengerPort();
    const { bob, applyErrors } = await pair(messenger);
    // What each operation had seen of 40 devices makes it about 2.5 KB: the bytes bind before the
    // bound on targets.
    const padding = Object.fromEntries(
      Array.from({ length: 40 }, (_, k) => [`P${String(k).padStart(21, "0")}`, 7]),
    );
    for (let counter = 1; counter <= 3_000; counter++) {
      await messenger.send(
        DOCUMENT_ID,
        "alice",
        op(counter, `member:@${String(counter).padStart(250, "x")}`, "read", padding),
      );
    }
    await bob.sync();
    const held = new ControlState();
    expect(held.merge({ vector: bob.controlVector, targets: {} })).toBe(0);
    expect(bob.memberPermissions.size).toBeLessThan(3_000);
    expect(
      applyErrors.filter((e) => e instanceof ControlFrameRejectedError && e.reason === "refused")
        .length,
    ).toBeGreaterThan(0);
    expect(new TextEncoder().encode(JSON.stringify(bob.controlState)).length).toBeLessThan(
      3_145_728 + 1_024,
    );
    expect(bob.capacityConflict).toBe(true);
    expect(bob.mayEdit).toBe(false);
  });

  it("a union over the bound on targets is a capacity conflict, never a silent cut of someone's right (CTL-30, CTL-32)", async () => {
    const messenger = new InMemoryMessengerPort();
    const { alice, bob, applyErrors } = await pair(messenger);
    await settle(alice, bob);
    alice.dispose();
    expect(bob.mayEdit).toBe(true);
    // Two devices of the creator that each added 2 600 members: each within what it may issue,
    // together 200 beyond the 5 000 members a receiver holds beside the close and the pace.
    for (const [device, from] of [
      ["A".repeat(22), 0],
      ["B".repeat(22), 2_600],
    ] as const) {
      for (let i = 0; i < 2_600; i++) {
        await messenger.send(
          DOCUMENT_ID,
          "alice",
          encodeControlFrame({
            documentId: DOCUMENT_ID,
            device,
            counter: i + 1,
            target: `member:m${String(from + i).padStart(5, "0")}` as "member:bob",
            value: "write",
            seen: {},
          }),
        );
      }
    }
    await bob.sync();
    expect(bob.capacityConflict).toBe(true);
    expect(bob.mayEdit).toBe(false);
    expect(bob.memberPermissions.size).toBe(5_000);
    expect(
      applyErrors.filter((e) => e instanceof ControlFrameRejectedError && e.reason === "refused"),
    ).toHaveLength(200);
    // What it holds it still changes, and a close still closes (CTL-32, CTL-36).
    await messenger.send(DOCUMENT_ID, "alice", op(1, "member:m00000", null));
    await messenger.send(DOCUMENT_ID, "alice", op(2, "close", true));
    await bob.sync();
    expect(bob.rightOf("m00000")).toBe("revoked");
    expect(bob.closed).toBe(true);
  });

  it("takes the operation that fills the hole, so the bound does not block its own healing", async () => {
    const messenger = new InMemoryMessengerPort();
    const { bob } = await pair(messenger);
    for (let counter = 2; counter <= 1025; counter++) {
      await messenger.send(DOCUMENT_ID, "alice", op(counter, "member:bob", "read"));
    }
    await bob.sync();
    expect(bob.controlVector[TAG]).toBeUndefined(); // counter 1 is missing: a hole
    await messenger.send(DOCUMENT_ID, "alice", op(1, "member:bob", "read"));
    await bob.sync();
    expect(bob.controlVector[TAG]).toBe(1025);
  });
});

describe("a basis for a new creator device's control state (CTL-28)", () => {
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

  it("is not given by reports or by its own operations: its rights stay unconfirmed", async () => {
    const { fresh } = await lost();
    expect(fresh.reportedControlState).toBeDefined();
    await fresh.setMembership("dave", "read");
    expect(fresh.controlConfirmed).toBe(false);
  });

  it("without one, a joiner it never decided about is not bootstrapped by it: a removed member does not come back unseen", async () => {
    const { messenger, fresh } = await lost();
    const carol = await DocumentEngine.join(DOCUMENT_ID, "carol", messenger, undefined, AS_ALICE);
    await settle(fresh, carol);
    expect(carol.hasCompletedBootstrap).toBe(false);
    expect(carol.mayEdit).toBe(false);
  });

  it("a joiner it decided about itself is bootstrapped with its snapshot", async () => {
    const { messenger, fresh } = await lost();
    await fresh.setMembership("dave", "read");
    const dave = await DocumentEngine.join(DOCUMENT_ID, "dave", messenger, undefined, AS_ALICE);
    await settle(fresh, dave);
    expect(dave.hasCompletedBootstrap).toBe(true);
    expect(dave.permissionOf("dave")).toBe("read");
  });

  it("is not given by the creator's operations read from the channel's history: their device may have had none", async () => {
    const messenger = new InMemoryMessengerPort(); // keeps history
    const old = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    await old.setMembership("carol", null); // carol was removed
    await old.setMembership("bob", "write");
    old.dispose();
    const fresh = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    expect(fresh.permissionOf("bob")).toBe("write"); // held, as operations of the creator are
    expect(fresh.controlConfirmed).toBe(false);
    // So a joiner it never decided about itself gets no snapshot from it (RSY-8).
    const dave = await DocumentEngine.join(DOCUMENT_ID, "dave", messenger, undefined, AS_ALICE);
    await settle(fresh, dave);
    expect(dave.hasCompletedBootstrap).toBe(false);
  });

  it("is not given by a snapshot of the creator that answers another requester", async () => {
    const { messenger, fresh } = await lost();
    const state = new ControlState();
    state.add({ device: TAG, counter: 1, target: "member:erin", value: "write", seen: {} });
    await messenger.send(DOCUMENT_ID, "alice", forgedResponse(snapshotOf(state)));
    await settle(fresh);
    expect(fresh.permissionOf("erin")).toBe("write"); // merged by union, as the creator's (CTL-25)
    expect(fresh.controlConfirmed).toBe(false);
  });

  it("two devices without one never give each other one: a removed member is not bootstrapped by the second", async () => {
    const { messenger, bob, fresh } = await lost();
    const second = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    await settle(fresh, second, bob);
    // The first decides about dave and bootstraps him; the second hears the operation and the
    // snapshot in the answer to dave.
    await fresh.setMembership("dave", "read");
    const dave = await DocumentEngine.join(DOCUMENT_ID, "dave", messenger, undefined, AS_ALICE);
    await new Promise((resolve) => setTimeout(resolve, 1_100)); // past the throttle of its last answer (RSY-9)
    await settle(fresh, second, dave);
    expect(dave.hasCompletedBootstrap).toBe(true);
    expect(second.permissionOf("dave")).toBe("read");
    expect(second.controlConfirmed).toBe(false);
    expect(fresh.controlConfirmed).toBe(false);
    // Carol, whom the lost device removed, asks while only the second is online.
    fresh.dispose();
    const carol = await DocumentEngine.join(DOCUMENT_ID, "carol", messenger, undefined, AS_ALICE);
    await settle(second, carol);
    expect(carol.hasCompletedBootstrap).toBe(false);
    expect(carol.mayEdit).toBe(false);
  });

  it("without one, a member's other device it never decided about gets no snapshot from it either", async () => {
    const { messenger, bob, fresh } = await lost();
    // Another device of the creator decides about bob; the first hears it.
    const second = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    await settle(fresh, second, bob);
    await second.setMembership("bob", "write");
    await settle(fresh, second);
    second.dispose();
    bob.dispose();
    expect(fresh.permissionOf("bob")).toBe("write");
    // Bob's laptop asks while only the first device is online: it decided nothing about bob.
    const laptop = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, AS_ALICE);
    await new Promise((resolve) => setTimeout(resolve, 1_100)); // past the throttle of its last answer (RSY-9)
    await settle(fresh, laptop);
    expect(laptop.hasCompletedBootstrap).toBe(false);
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

  it("concurrent read and revoke from two devices of the creator: revoked everywhere, never write", async () => {
    const messenger = new InMemoryMessengerPort();
    const laptop = await DocumentEngine.create(
      DOCUMENT_ID,
      "alice",
      messenger,
      undefined,
      AS_ALICE,
    );
    await laptop.setMembership("bob", "write");
    const tablet = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, AS_ALICE);
    await settle(laptop, tablet, bob);
    expect(bob.mayEdit).toBe(true);
    // Neither has seen the other's decision when it makes its own.
    await Promise.all([laptop.setMembership("bob", "read"), tablet.setMembership("bob", null)]);
    await settle(laptop, tablet, bob);
    for (const client of [laptop, tablet, bob]) {
      expect(client.rightOf("bob")).toBe("revoked");
      expect(client.memberPermissions.has("bob")).toBe(false);
    }
    expect(bob.mayEdit).toBe(false);
    await expect(bob.resync()).rejects.toMatchObject({ reason: "revoked" });
  });

  it("a member the creator never named stays unknown beside a revoked one, and may edit after the bootstrap", async () => {
    const messenger = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    await alice.setMembership("carol", null);
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, AS_ALICE);
    await settle(alice, bob);
    expect(bob.rightOf("bob")).toBeUndefined();
    expect(bob.rightOf("carol")).toBe("revoked");
    expect(bob.mayEdit).toBe(true);
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

describe("a decision's loss is noticed while the creator keeps typing (SND-3, SND-23, LOS-10)", () => {
  it("the heartbeat a control frame owes goes out within its due though a change is always pending", async () => {
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
    await vi.advanceTimersByTimeAsync(60_000); // every heartbeat the join owed has gone out
    await bob.sync();
    expect(bob.syncHealth.state).toBe("ok");

    // The revocation is lost; only the heartbeat after it can show bob that it exists (LOS-10).
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
    expect(bob.rightOf("carol")).toBeUndefined(); // bob never saw the revocation...
    // ...but within the frame's due, a floor and the waiting time, he knows he lacks it.
    expect(bob.syncHealth.suspicions).toContainEqual(
      expect.objectContaining({ kind: "control-behind" }),
    );
    alice.dispose();
    bob.dispose();
  }
});

describe("what only a member's report holds, and the creator's confirmation (CTL-29, CTL-33)", () => {
  it("a forged report is shown, never applied, and a confirmation grants nothing it names", async () => {
    const messenger = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
      ...AS_ALICE,
      autoResync: false,
    });
    await alice.setMembership("bob", "write");
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, AS_ALICE);
    await settle(alice, bob);
    // Alice asks; Mallory, in the channel, answers her request with a report naming herself a writer.
    await alice.requestResync();
    const request = (await messenger.receive(DOCUMENT_ID, "mallory"))
      .map((delivery) => JSON.parse(delivery.payload) as { kind: string; requestId?: string })
      .filter((frame) => frame.kind === "resync-request")
      .at(-1) as { requestId: string };
    const forged = new ControlState();
    forged.add({ device: TAG, counter: 1, target: "member:mallory", value: "write", seen: {} });
    forged.add({ device: TAG, counter: 2, target: "member:bob", value: "write", seen: {} });
    await messenger.send(
      DOCUMENT_ID,
      "mallory",
      encodeResyncResponseFrame({
        documentId: DOCUMENT_ID,
        respondsTo: request.requestId,
        update: new Uint8Array([0, 0]),
        control: snapshotOf(forged),
      }),
    );
    await settle(alice, bob);
    expect(alice.controlDivergences).toContainEqual({
      reporter: "mallory",
      target: "member:mallory",
      reported: "write",
      held: undefined,
    });
    expect(alice.permissionOf("mallory")).toBeUndefined();
    expect(bob.permissionOf("mallory")).toBeUndefined();

    await alice.confirmRights();
    await settle(alice, bob);
    for (const client of [alice, bob]) {
      expect(client.rightOf("mallory")).toBe("revoked");
      expect(client.permissionOf("bob")).toBe("write");
    }
  });

  it("a member's report is never a device's own decision: confirming is refused to anyone but the creator", async () => {
    const messenger = new InMemoryMessengerPort();
    const { bob } = await pair(messenger);
    await expect(bob.confirmRights()).rejects.toThrow(/not the creator/);
    expect(bob.controlDivergences).toStrictEqual([]);
  });
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
