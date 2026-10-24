import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import {
  type Delivery,
  type DeliveryId,
  type DocumentId,
  type MemberId,
  type MessengerPort,
  type RawChannel,
  type TransportProfile,
  TransportSendError,
  type TransportSendFailure,
} from "@tdsp/messenger-port";
import {
  deletePlainText,
  encodeStateVector,
  encodeUpdate,
  getPlainText,
  insertPlainText,
  transact,
} from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  decodeFrame,
  encodeControlFrame,
  encodeEditFrame,
  encodeHeartbeatFrame,
  encodeResyncRequestFrame,
  encodeResyncResponseFrame,
  FrameDecodeError,
} from "./framing";
import {
  DocumentEngine,
  type DocumentEngineOptions,
  type PersistedControlState,
  SendRefusedError,
  TransportProfileError,
  UnsplittableUpdateError,
  YJS_PARAGRAPHS_1,
} from "./index";

// The foundation: concurrent convergence, every remote update accounted for in
// the mock's delivery trace, and no bypass of the messenger interface. These
// tests exercise the real InMemoryMessengerPort
// (allowed here only because this is a *.test.ts file — see
// .dependency-cruiser.cjs), not a hand-rolled fake, so they prove the
// DocumentEngine + mock combination actually works end to end.
//
// `DocumentEngine.create()` seeds one empty paragraph as part of creating the
// document (the profile's content is a fragment of paragraphs), which is why
// several assertions below count one delivery for it.

/** What a device of the creator persists, as `onControlStateChange` hands it (CTL-26). */
function persistedOf(engine: DocumentEngine): PersistedControlState {
  const device = engine.deviceTag;
  return {
    profile: engine.profile,
    control: engine.controlState,
    ...(device === undefined ? {} : { device, counter: engine.controlVector[device] ?? 0 }),
  };
}
const DOCUMENT_ID = "doc-1";

// DocumentEngine.create()/.join() default to batchWindowMs: 500 — a real
// messenger cannot perform well sending one message per keystroke. Every test below except the dedicated "outgoing-
// message batching" describe block is about convergence, fault injection,
// or attribution semantics that assume synchronous, immediate-send
// delivery visibility — not about batching itself — so they explicitly opt
// out via IMMEDIATE, the same way any caller wanting unbatched sends must.
const IMMEDIATE = { batchWindowMs: 0 };
/** A joiner always knows the creator from the invitation (SPECIFICATION.md LIF-4). */
const JOIN_ALICE = { ...IMMEDIATE, creatorMemberId: "alice" };

/**
 * Every message waits for the floor in the scheduler (SPECIFICATION.md SND-2), a control
 * message and a resync answer included: lets `ms` of fake time pass, then awaits `promise`.
 */
async function afterFloor<T>(promise: Promise<T>, ms: number): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms);
  return promise;
}

describe("DocumentEngine convergence", () => {
  let messenger: InMemoryMessengerPort;

  beforeEach(() => {
    messenger = new InMemoryMessengerPort();
  });

  it("converges two clients that edit concurrently and sync out of order", async () => {
    const alice = await DocumentEngine.create(
      DOCUMENT_ID,
      "alice",
      messenger,
      undefined,
      IMMEDIATE,
    );
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, JOIN_ALICE);
    // Bob is bootstrapped by the creator before he may send an edit (SPECIFICATION.md CTL-13).
    await alice.sync();
    await bob.sync();

    alice.edit((fragment) => insertPlainText(fragment, 0, "hello "));
    bob.edit((fragment) => insertPlainText(fragment, 0, "world"));

    // Sync twice each, in different order, to prove convergence tolerates
    // duplicate and out-of-order polling (SPECIFICATION.md §3.3).
    await bob.sync();
    await alice.sync();
    await alice.sync();
    await bob.sync();

    expect(getPlainText(alice.fragment)).toBe(getPlainText(bob.fragment));
  });

  it("accounts for every applied remote update in the mock delivery trace", async () => {
    const alice = await DocumentEngine.create(
      DOCUMENT_ID,
      "alice",
      messenger,
      undefined,
      IMMEDIATE,
    );
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, JOIN_ALICE);

    alice.edit((fragment) => insertPlainText(fragment, 0, "hello"));
    bob.edit((fragment) => insertPlainText(fragment, 0, "world"));

    const applied = await bob.sync();
    const recorded = await messenger.receive(DOCUMENT_ID, "bob");

    // every update bob applied must be traceable to a delivery the mock
    // actually recorded — not, e.g., a document-protocol-internal shortcut
    // that bypassed the messenger.
    for (const delivery of applied) {
      expect(recorded.some((r) => r.id === delivery.id)).toBe(true);
    }
    expect(applied.length).toBeGreaterThan(0);
  });

  it("does not converge two clients on isolated messenger instances (no bypass)", async () => {
    const isolatedMessenger = new InMemoryMessengerPort();

    const alice = await DocumentEngine.create(
      DOCUMENT_ID,
      "alice",
      messenger,
      undefined,
      IMMEDIATE,
    );
    const bob = await DocumentEngine.create(
      DOCUMENT_ID,
      "bob",
      isolatedMessenger,
      undefined,
      IMMEDIATE,
    );

    alice.edit((fragment) => insertPlainText(fragment, 0, "hello"));
    bob.edit((fragment) => insertPlainText(fragment, 0, "world"));

    await alice.sync();
    await bob.sync();

    // disabling/isolating the mock must stop all propagation between
    // clients — proof that no other channel exists; each client must
    // see only its own edit.
    expect(getPlainText(alice.fragment)).toBe("hello");
    expect(getPlainText(bob.fragment)).toBe("world");
  });

  it("does not re-broadcast an update it just received (no echo loop)", async () => {
    const alice = await DocumentEngine.create(
      DOCUMENT_ID,
      "alice",
      messenger,
      undefined,
      IMMEDIATE,
    );
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, JOIN_ALICE);

    alice.edit((fragment) => insertPlainText(fragment, 0, "hello"));
    await bob.sync();

    const deliveries = await messenger.receive(DOCUMENT_ID, "bob");

    // bob applying alice's update must not itself produce a new delivery.
    // 3, not 2: create()'s seed paragraph is delivery #1, bob's own
    // join()-time resync request is #2 (an ordinary frame in this same
    // stream), alice's "hello" edit is #3.
    expect(deliveries).toHaveLength(3);

    const afterBobSyncedAgain = await bob.sync();
    expect(afterBobSyncedAgain).toHaveLength(0);
  });

  describe("fault injection and lifecycle", () => {
    it("refuses to resume a creator under another profile than its persisted control state names (PRF-6)", async () => {
      const alice = await DocumentEngine.create(
        DOCUMENT_ID,
        "alice",
        messenger,
        undefined,
        IMMEDIATE,
      );
      const persisted = { ...persistedOf(alice), profile: "com.example.other/1" };
      alice.dispose();
      const before = await messenger.receive(DOCUMENT_ID, "bob");

      await expect(
        DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, {
          ...JOIN_ALICE,
          controlState: persisted,
        }),
      ).rejects.toThrow(/PRF-6/);
      expect(await messenger.receive(DOCUMENT_ID, "bob")).toEqual(before);
    });

    it("refuses to create a document anew from persisted control state, before anything is sent (LIF-5)", async () => {
      const alice = await DocumentEngine.create(
        DOCUMENT_ID,
        "alice",
        messenger,
        undefined,
        IMMEDIATE,
      );
      const controlState = persistedOf(alice);
      alice.dispose();
      const before = await messenger.receive(DOCUMENT_ID, "bob");

      await expect(
        DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
          ...IMMEDIATE,
          controlState,
        }),
      ).rejects.toThrow(/LIF-5.*join\(/);
      expect(await messenger.receive(DOCUMENT_ID, "bob")).toEqual(before);
    });

    it("converges after an offline client reconnects (R5)", async () => {
      const alice = await DocumentEngine.create(
        DOCUMENT_ID,
        "alice",
        messenger,
        undefined,
        IMMEDIATE,
      );
      const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, JOIN_ALICE);

      messenger.disconnect("bob");
      alice.edit((fragment) => insertPlainText(fragment, 0, "while bob was offline "));
      await bob.sync(); // no-op: bob's view is frozen
      expect(getPlainText(bob.fragment)).toBe("");

      messenger.reconnect("bob");
      await bob.sync();

      expect(getPlainText(bob.fragment)).toBe(getPlainText(alice.fragment));
    });

    it("still converges when deliveries are held and released out of order", async () => {
      const alice = await DocumentEngine.create(
        DOCUMENT_ID,
        "alice",
        messenger,
        undefined,
        IMMEDIATE,
      );
      const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, JOIN_ALICE);

      messenger.holdNextSend("alice");
      alice.edit((fragment) => insertPlainText(fragment, 0, "A"));
      messenger.holdNextSend("alice");
      alice.edit((fragment) => insertPlainText(fragment, getPlainText(fragment).length, "B"));

      // release in reverse order — reordering must not break convergence
      // (SPECIFICATION.md §3.3).
      messenger.releaseHeld(DOCUMENT_ID, [1, 0]);
      await bob.sync();

      expect(getPlainText(bob.fragment)).toBe(getPlainText(alice.fragment));
    });

    it("still converges when a delivery is replayed (duplicate)", async () => {
      const alice = await DocumentEngine.create(
        DOCUMENT_ID,
        "alice",
        messenger,
        undefined,
        IMMEDIATE,
      );
      const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, JOIN_ALICE);

      alice.edit((fragment) => insertPlainText(fragment, 0, "hello"));
      const deliveries = await messenger.receive(DOCUMENT_ID, "alice");
      const lastDelivery = deliveries.at(-1);
      if (lastDelivery) {
        messenger.replay(DOCUMENT_ID, lastDelivery.id);
      }

      await bob.sync();

      expect(getPlainText(bob.fragment)).toBe("hello");
    });

    it("stops accepting local edits from propagating once closed (R2)", async () => {
      const broadcastErrors: unknown[] = [];
      const alice = await DocumentEngine.create(
        DOCUMENT_ID,
        "alice",
        messenger,
        (error) => broadcastErrors.push(error),
        IMMEDIATE,
      );
      const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, {
        ...IMMEDIATE,
        creatorMemberId: "alice",
      });

      alice.edit((fragment) => insertPlainText(fragment, 0, "before archive"));
      await bob.sync();
      await alice.closeDocument();

      // edit() itself always succeeds locally — the client refuses the
      // resulting broadcast (CTL-13: a closed document is refused at the
      // sending client, not by the messenger), reported via the error
      // handler rather than an unhandled rejection.
      alice.edit((fragment) => insertPlainText(fragment, 0, "after archive"));
      // let the unawaited broadcast's rejection settle: a macrotask flush
      // (not just one microtask tick) guarantees the async send() ->
      // #broadcast -> .catch() chain has fully run.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(broadcastErrors).toHaveLength(1);
      expect(broadcastErrors[0]).toBeInstanceOf(SendRefusedError);
      expect((broadcastErrors[0] as SendRefusedError).reason).toBe("closed");

      await bob.sync();
      expect(getPlainText(bob.fragment)).toBe("before archive");
      expect(bob.closed).toBe(true);
    });

    it("a closed document stays readable: sync() keeps working, and nothing can be deleted (R3 is deferred)", async () => {
      const alice = await DocumentEngine.create(
        DOCUMENT_ID,
        "alice",
        messenger,
        undefined,
        IMMEDIATE,
      );
      alice.edit((fragment) => insertPlainText(fragment, 0, "still here"));
      await alice.closeDocument();

      await expect(alice.sync()).resolves.toBeDefined();
      expect(getPlainText(alice.fragment)).toBe("still here");
      expect("deleteDocument" in alice).toBe(false);
    });

    it("skips a corrupted delivery, reports it, without crashing sync()", async () => {
      const applyErrors: unknown[] = [];
      const alice = await DocumentEngine.create(
        DOCUMENT_ID,
        "alice",
        messenger,
        undefined,
        IMMEDIATE,
      );
      const bob = await DocumentEngine.join(
        DOCUMENT_ID,
        "bob",
        messenger,
        (error, context) => {
          if (context === "apply") applyErrors.push(error);
        },
        JOIN_ALICE,
      );

      alice.edit((fragment) => insertPlainText(fragment, 0, "before"));
      messenger.modifyNextSend("alice", () => "\u0001\u0002 not a frame");
      alice.edit((fragment) => insertPlainText(fragment, 0, "corrupted-trigger "));
      alice.edit((fragment) => insertPlainText(fragment, getPlainText(fragment).length, " after"));

      // must not throw / must not abort the batch — a modified message is
      // rejected and reported, and the client carries on (FRM-6).
      await expect(bob.sync()).resolves.toBeDefined();
      expect(applyErrors).toHaveLength(1);
      // The other half of that behaviour: it does NOT converge to
      // "before after". Yjs updates from one client are causally ordered
      // by that client's internal clock — a property of the Y.Doc update
      // system as a whole, not specific to which shared type it mutates —
      // so the third update depends on the second (corrupted, permanently
      // missing) one and stays unintegrated. Yjs buffers it internally
      // rather than discarding it, but incremental updates alone will never
      // supply the missing piece. A single corrupted or dropped delivery
      // therefore blocks *later* updates from the same sender to whichever
      // peer missed it until a resync supplies it (tested below).
      expect(getPlainText(bob.fragment)).toBe("before");
    });

    // Permission changes alone must not cause a dropped or corrupted
    // *inbound* delivery: a pure permission toggle sequence, with no fault
    // injection and no in-flight edit at the moment of the toggle, must not
    // gap anything.
    it("toggling a member's permission write -> read -> write with no in-flight edit causes no receive gap", async () => {
      const alice = await DocumentEngine.create(
        DOCUMENT_ID,
        "alice",
        messenger,
        undefined,
        IMMEDIATE,
      );
      const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, JOIN_ALICE);

      alice.edit((fragment) => insertPlainText(fragment, 0, "one "));
      await bob.sync();
      expect(getPlainText(bob.fragment)).toContain("one");

      alice.edit((fragment) => insertPlainText(fragment, getPlainText(fragment).length, "two"));
      await bob.sync();
      expect(getPlainText(bob.fragment)).toContain("two");
    });

    // Bob is typing at the moment his permission flips to read-only: his
    // *own* queued edit is refused by his own engine and dropped (CTL-13,
    // SND-8), but his ability to *receive* alice's later updates is entirely
    // unaffected — receiving never looks at the send queue or permissions.
    it("a member's own queued batch is dropped when they are demoted mid-batch, but they still receive later updates normally", async () => {
      vi.useFakeTimers();
      try {
        const broadcastErrors: unknown[] = [];
        const alice = await DocumentEngine.create(
          DOCUMENT_ID,
          "alice",
          messenger,
          undefined,
          IMMEDIATE,
        );
        // default batchWindowMs (500) — bob's edit must genuinely queue
        // instead of sending immediately, to reach #flushBatch's drop path.
        const bob = await DocumentEngine.join(
          DOCUMENT_ID,
          "bob",
          messenger,
          (error) => broadcastErrors.push(error),
          { creatorMemberId: "alice" },
        );

        bob.edit((fragment) => insertPlainText(fragment, 0, "typing"));
        expect(bob.hasPendingChanges).toBe(true);
        expect(getPlainText(bob.fragment)).toBe("typing"); // applied locally regardless of send outcome

        // Demoted mid-batch: the creator's control frame reaches bob's client
        // before his batch timer fires, so the flush is refused at bob's own
        // client — the same drop path a rejected transport send took.
        await alice.setMembership("bob", "read");
        await bob.sync();
        await vi.advanceTimersByTimeAsync(500); // the batch timer fires; #flushBatch's send() now rejects

        expect(broadcastErrors).toHaveLength(1);
        expect(bob.hasPendingChanges).toBe(false); // #pendingBatch was cleared before the failed send

        alice.edit((fragment) => insertPlainText(fragment, 0, "ALICE-AFTER "));
        await bob.sync();
        expect(getPlainText(bob.fragment)).toContain("ALICE-AFTER");
      } finally {
        vi.useRealTimers();
      }
    });

    it("a dropped delivery has the same permanent-gap effect as a corrupted one", async () => {
      const alice = await DocumentEngine.create(
        DOCUMENT_ID,
        "alice",
        messenger,
        undefined,
        IMMEDIATE,
      );
      const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, JOIN_ALICE);

      alice.edit((fragment) => insertPlainText(fragment, 0, "before"));
      messenger.dropNextSend("alice");
      alice.edit((fragment) => insertPlainText(fragment, 0, "dropped-trigger "));
      alice.edit((fragment) => insertPlainText(fragment, getPlainText(fragment).length, " after"));

      await bob.sync();

      // same finding as the corrupted-delivery test above: drop is not
      // merely "one edit missing", it silently stalls every later update
      // from that sender to this peer.
      //
      // Pinning note: this assertion holds only because
      // alice.sync() is never called again after her edits above — with
      // no further tick, #respondToResyncRequests() never runs on her
      // side, so no resync-response can heal bob regardless of the
      // join()-time requestResync() call bob's own join() already made.
      // Adding a later `await alice.sync()` here would silently change
      // this test's meaning (bob's join()-time request would then likely
      // get answered) — it is deliberately absent, not an oversight.
      expect(getPlainText(bob.fragment)).toBe("before");
    });
  });

  describe("snapshot resync (heals a permanent gap)", () => {
    it("heals a peer permanently gapped by a dropped delivery once someone with full state resyncs", async () => {
      const alice = await DocumentEngine.create(
        DOCUMENT_ID,
        "alice",
        messenger,
        undefined,
        IMMEDIATE,
      );
      const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, JOIN_ALICE);

      alice.edit((fragment) => insertPlainText(fragment, 0, "before"));
      messenger.dropNextSend("alice");
      alice.edit((fragment) => insertPlainText(fragment, 0, "dropped-trigger "));
      alice.edit((fragment) => insertPlainText(fragment, getPlainText(fragment).length, " after"));

      await bob.sync();
      // reproduces the permanent gap from the test above first, to prove
      // the fix actually closes it rather than the scenario never having
      // been gapped in the first place.
      expect(getPlainText(bob.fragment)).toBe("before");

      // alice still has the complete state locally (her own edits always
      // apply locally regardless of send success) — resync rebroadcasts
      // it as one full-state delivery.
      await alice.resync();
      await bob.sync();

      expect(getPlainText(bob.fragment)).toBe(getPlainText(alice.fragment));
      expect(getPlainText(bob.fragment)).toBe("dropped-trigger before after");
    });

    it("resync is a no-op for a peer that already has everything", async () => {
      const alice = await DocumentEngine.create(
        DOCUMENT_ID,
        "alice",
        messenger,
        undefined,
        IMMEDIATE,
      );
      const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, JOIN_ALICE);

      alice.edit((fragment) => insertPlainText(fragment, 0, "hello"));
      await bob.sync();
      expect(getPlainText(bob.fragment)).toBe("hello");

      await alice.resync();
      await bob.sync();

      // Yjs update application is idempotent: applying content bob
      // already has must not duplicate or otherwise change it.
      expect(getPlainText(bob.fragment)).toBe("hello");
    });
  });

  describe("resync requests (a member asks for help)", () => {
    it("an online peer who holds newer content answers an unanswered request automatically on their next sync()", async () => {
      // alice is the document's creator, the one who answers (RSY-6).
      const admin = { creatorMemberId: "alice" };
      const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
        ...IMMEDIATE,
        ...admin,
      });
      const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, {
        ...IMMEDIATE,
        ...admin,
      });

      alice.edit((fragment) => insertPlainText(fragment, 0, "before"));
      messenger.dropNextSend("alice");
      alice.edit((fragment) => insertPlainText(fragment, 0, "dropped-trigger "));
      alice.edit((fragment) => insertPlainText(fragment, getPlainText(fragment).length, " after"));

      await bob.sync();
      // reproduces the permanent gap this reaches for, same as the
      // existing snapshot-resync tests above.
      expect(getPlainText(bob.fragment)).toBe("before");

      // bob asks for help directly, instead of a human noticing and
      // clicking alice's own Resync button.
      await bob.requestResync();
      // alice's own next sync() tick observes the request and answers
      // automatically — no call to alice.resync() here.
      await alice.sync();
      await bob.sync();

      expect(getPlainText(bob.fragment)).toBe(getPlainText(alice.fragment));
      expect(getPlainText(bob.fragment)).toBe("dropped-trigger before after");
    });

    it("a request from an already-fully-synced peer is a harmless no-op", async () => {
      const alice = await DocumentEngine.create(
        DOCUMENT_ID,
        "alice",
        messenger,
        undefined,
        IMMEDIATE,
      );
      const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, JOIN_ALICE);

      alice.edit((fragment) => insertPlainText(fragment, 0, "hello"));
      await bob.sync();
      expect(getPlainText(bob.fragment)).toBe("hello");

      await bob.requestResync();
      await alice.sync(); // answers with a full resync — idempotent, bob already has it
      await bob.sync();

      expect(getPlainText(bob.fragment)).toBe("hello");
    });
  });

  describe("attribution data layer", () => {
    it("converges two clients editing concurrently to matching, correctly-attributed ranges", async () => {
      const alice = await DocumentEngine.create(
        DOCUMENT_ID,
        "alice",
        messenger,
        undefined,
        IMMEDIATE,
      );
      const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, JOIN_ALICE);
      await alice.sync(); // bootstraps bob, who may only then edit (CTL-13)
      await bob.sync();

      alice.edit((fragment) => insertPlainText(fragment, 0, "hello "));
      bob.edit((fragment) => insertPlainText(fragment, 0, "world"));

      // sync twice each, in different order — attribution must converge
      // exactly like the document text does regardless of delivery order
      // (mirrors the convergence test above).
      await bob.sync();
      await alice.sync();
      await alice.sync();
      await bob.sync();

      expect(getPlainText(alice.fragment)).toBe(getPlainText(bob.fragment));
      expect(alice.attribution.ranges).toEqual(bob.attribution.ranges);

      // every range attributes to a member who actually wrote text, and
      // together the ranges cover the whole converged document with no gap.
      for (const range of alice.attribution.ranges) {
        expect(["alice", "bob"]).toContain(range.authorId);
      }
      const covered = alice.attribution.ranges.reduce((sum, r) => sum + (r.end - r.start), 0);
      expect(covered).toBe(getPlainText(alice.fragment).length);

      expect(alice.attribution.lastEditBySender.get("alice")).toBeDefined();
      expect(alice.attribution.lastEditBySender.get("bob")).toBeDefined();
    });

    it("attributes a synced remote edit to its sender, not the syncing client", async () => {
      const alice = await DocumentEngine.create(
        DOCUMENT_ID,
        "alice",
        messenger,
        undefined,
        IMMEDIATE,
      );
      const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, JOIN_ALICE);

      alice.edit((fragment) => insertPlainText(fragment, 0, "hello"));
      await bob.sync();

      expect(bob.attribution.ranges).toEqual([{ start: 0, end: 5, authorId: "alice" }]);
      expect(bob.attribution.lastEditBySender.get("alice")).toBe(5);
      expect(bob.attribution.lastEditBySender.has("bob")).toBe(false);
    });

    it("attributes a local delete to the deleting client", async () => {
      const alice = await DocumentEngine.create(
        DOCUMENT_ID,
        "alice",
        messenger,
        undefined,
        IMMEDIATE,
      );

      alice.edit((fragment) => insertPlainText(fragment, 0, "hello world"));
      alice.edit((fragment) => deletePlainText(fragment, 5, 6)); // removes " world"

      expect(alice.attribution.ranges).toEqual([{ start: 0, end: 5, authorId: "alice" }]);
      expect(alice.attribution.lastEditBySender.get("alice")).toBe(5);
    });

    it("attributes a local mutation that bypasses edit() to the client's own memberId", async () => {
      const alice = await DocumentEngine.create(
        DOCUMENT_ID,
        "alice",
        messenger,
        undefined,
        IMMEDIATE,
      );

      // Simulates what an editor binding such as TipTap's Collaboration
      // extension does: mutate the Y.Doc directly via its own transact() call
      // instead of going through DocumentEngine.edit(). #attributionAuthor
      // defaults to memberId precisely so this still attributes correctly.
      transact(alice.document, () => insertPlainText(alice.fragment, 0, "typed via tiptap"));

      expect(alice.attribution.ranges).toEqual([{ start: 0, end: 16, authorId: "alice" }]);
    });
  });

  // `yjs` is imported directly only in this block, to construct a real
  // Y.UndoManager the way @tiptap/y-tiptap does (there is no DOM here to
  // drive a real editor — same reasoning as
  // `transact(alice.document, ...)` above, simulating what TipTap's
  // binding does without needing a browser). document-protocol's
  // production code (index.ts) still never imports yjs directly.
  describe("outgoing-message batching (batchWindowMs)", () => {
    it("batches by default (500ms) — a real messenger cannot perform well sending one message per keystroke", async () => {
      vi.useFakeTimers();
      try {
        const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger);
        const seedCount = (await messenger.receive(DOCUMENT_ID, "alice")).length;

        alice.edit((fragment) => insertPlainText(fragment, 0, "a"));
        alice.edit((fragment) => insertPlainText(fragment, 1, "b"));

        // nothing sent yet — batched by default now, not immediate.
        expect(await messenger.receive(DOCUMENT_ID, "alice")).toHaveLength(seedCount);

        await vi.advanceTimersByTimeAsync(499);
        expect(await messenger.receive(DOCUMENT_ID, "alice")).toHaveLength(seedCount); // still not yet

        await vi.advanceTimersByTimeAsync(1);
        // exactly one merged message once the 500ms default window elapses.
        expect(await messenger.receive(DOCUMENT_ID, "alice")).toHaveLength(seedCount + 1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("hasPendingChanges reflects whether a batch is queued, not yet sent", async () => {
      vi.useFakeTimers();
      try {
        const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger);
        expect(alice.hasPendingChanges).toBe(false); // nothing queued right after create()

        alice.edit((fragment) => insertPlainText(fragment, 0, "a"));
        expect(alice.hasPendingChanges).toBe(true);

        await vi.advanceTimersByTimeAsync(500);
        expect(alice.hasPendingChanges).toBe(false); // flushed once the window elapsed
      } finally {
        vi.useRealTimers();
      }
    });

    it("hasPendingChanges is false immediately after flush()", async () => {
      const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger);
      alice.edit((fragment) => insertPlainText(fragment, 0, "a"));
      expect(alice.hasPendingChanges).toBe(true);

      await alice.flush();
      expect(alice.hasPendingChanges).toBe(false);
    });

    it("batchWindowMs: 0 opts back out into immediate, unbatched sends", async () => {
      const alice = await DocumentEngine.create(
        DOCUMENT_ID,
        "alice",
        messenger,
        undefined,
        IMMEDIATE,
      );
      const seedCount = (await messenger.receive(DOCUMENT_ID, "alice")).length;

      alice.edit((fragment) => insertPlainText(fragment, 0, "a"));
      alice.edit((fragment) => insertPlainText(fragment, 1, "b"));

      expect(await messenger.receive(DOCUMENT_ID, "alice")).toHaveLength(seedCount + 2);
    });

    it("merges edits queued within the batch window into one message", async () => {
      vi.useFakeTimers();
      try {
        const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
          batchWindowMs: 1000,
        });
        const seedCount = (await messenger.receive(DOCUMENT_ID, "alice")).length;

        alice.edit((fragment) => insertPlainText(fragment, 0, "a"));
        alice.edit((fragment) => insertPlainText(fragment, 1, "b"));
        alice.edit((fragment) => insertPlainText(fragment, 2, "c"));

        // nothing sent yet — still queued.
        expect(await messenger.receive(DOCUMENT_ID, "alice")).toHaveLength(seedCount);

        await vi.advanceTimersByTimeAsync(1000);

        // exactly one message for all three edits, and it converges
        // correctly for a peer applying it — merging updates is not just
        // fewer messages, it must still be the same content.
        expect(await messenger.receive(DOCUMENT_ID, "alice")).toHaveLength(seedCount + 1);
        const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, JOIN_ALICE);
        expect(getPlainText(bob.fragment)).toBe("abc");
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps sliding the window as long as local edits keep arriving", async () => {
      vi.useFakeTimers();
      try {
        const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
          batchWindowMs: 1000,
        });
        const seedCount = (await messenger.receive(DOCUMENT_ID, "alice")).length;

        alice.edit((fragment) => insertPlainText(fragment, 0, "a"));
        await vi.advanceTimersByTimeAsync(900); // just under the window
        alice.edit((fragment) => insertPlainText(fragment, 1, "b")); // resets it
        await vi.advanceTimersByTimeAsync(900); // would have fired if NOT reset

        expect(await messenger.receive(DOCUMENT_ID, "alice")).toHaveLength(seedCount);

        await vi.advanceTimersByTimeAsync(1000); // let it fully elapse this time
        expect(await messenger.receive(DOCUMENT_ID, "alice")).toHaveLength(seedCount + 1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("flush() sends a pending batch immediately, without waiting for the window", async () => {
      vi.useFakeTimers();
      try {
        const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
          batchWindowMs: 60_000,
        });
        const seedCount = (await messenger.receive(DOCUMENT_ID, "alice")).length;
        alice.edit((fragment) => insertPlainText(fragment, 0, "hello"));
        expect(await messenger.receive(DOCUMENT_ID, "alice")).toHaveLength(seedCount);

        await alice.flush();
        expect(await messenger.receive(DOCUMENT_ID, "alice")).toHaveLength(seedCount + 1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("flush() is a no-op when nothing is queued", async () => {
      const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
        batchWindowMs: 1000,
      });
      const before = (await messenger.receive(DOCUMENT_ID, "alice")).length;
      await alice.flush();
      expect(await messenger.receive(DOCUMENT_ID, "alice")).toHaveLength(before);
    });

    it("dispose() flushes a pending batch instead of silently dropping it", async () => {
      const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
        batchWindowMs: 60_000,
      });
      const seedCount = (await messenger.receive(DOCUMENT_ID, "alice")).length;
      alice.edit((fragment) => insertPlainText(fragment, 0, "hello"));
      alice.dispose();
      // dispose()'s flush is fire-and-forget, matching the existing
      // broadcast observer's style; a macrotask flush (not just one
      // microtask tick) guarantees the async send() -> #broadcast chain
      // has fully run (same idiom as the archived-channel test above).
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(await messenger.receive(DOCUMENT_ID, "alice")).toHaveLength(seedCount + 1);
    });

    it("undo only reverts what its own group captured, independent of a pending network batch", async () => {
      // Directly answers the question that motivated this feature: if
      // batching queues e.g. 10 characters for one outgoing message, does
      // a single undo() then revert all 10, or only whatever Y.UndoManager
      // itself grouped? This constructs a real Y.UndoManager against
      // alice's fragment (the same mechanism @tiptap/y-tiptap's bundled
      // yUndoPlugin uses) and a deliberately large
      // batchWindowMs, so the batch is still fully pending when undo() runs.
      //
      // The undo-group boundary between "AAAAA" and "BBBBB" is forced via
      // the public stopCapturing() API, not by advancing time past
      // captureTimeout: yjs measures elapsed time via `lib0/time`'s
      // `getUnixTime`, which captures a plain reference to `Date.now` at
      // module-load time — it does not move under Vitest's
      // `vi.useFakeTimers()`, unlike calling `Date.now()` directly — so it
      // cannot be driven
      // deterministically by fake timers. stopCapturing() is yjs's own
      // documented mechanism for the exact same effect, so this still
      // exercises real captureTimeout=500 grouping, not a hollowed-out
      // captureTimeout: 0 that would trivially group nothing.
      const LOCAL_ORIGIN = Symbol("local-edit"); // stands in for TipTap's ySyncPluginKey origin
      const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
        batchWindowMs: 60_000,
      });
      const seedCount = (await messenger.receive(DOCUMENT_ID, "alice")).length;
      const undoManager = new Y.UndoManager(alice.fragment, {
        trackedOrigins: new Set([LOCAL_ORIGIN]),
        captureTimeout: 500, // yUndoPlugin's own default
      });

      const typeChar = (ch: string) =>
        transact(
          alice.document,
          () => insertPlainText(alice.fragment, getPlainText(alice.fragment).length, ch),
          LOCAL_ORIGIN,
        );

      for (const ch of "AAAAA") typeChar(ch); // undo group 1
      undoManager.stopCapturing(); // simulates a real pause longer than captureTimeout
      for (const ch of "BBBBB") typeChar(ch); // undo group 2

      expect(getPlainText(alice.fragment)).toBe("AAAAABBBBB");
      expect(undoManager.undoStack).toHaveLength(2);
      // all 10 characters are still sitting in the pending network batch —
      // batchWindowMs is 60s and nothing has flushed it yet.
      expect(await messenger.receive(DOCUMENT_ID, "alice")).toHaveLength(seedCount);

      undoManager.undo();

      // one Ctrl/Cmd-Z only reverted its own group ("BBBBB") — not the
      // whole 10-char span queued for the next network message.
      expect(getPlainText(alice.fragment)).toBe("AAAAA");

      // the undo is itself just another local transaction, so it is
      // queued and merged like any other edit — flushing now sends the
      // POST-undo state, not "AAAAABBBBB".
      await alice.flush();
      expect(await messenger.receive(DOCUMENT_ID, "alice")).toHaveLength(seedCount + 1);

      const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, JOIN_ALICE);
      expect(getPlainText(bob.fragment)).toBe("AAAAA");
    });
  });
});

/**
 * Simulates a transport with NO message history for a newly-observing
 * member — exactly what a freshly linked Signal device sees (signal-cli has no
 * history or backfill command). The mock itself does not reproduce this — its
 * `receive()` always replays the entire history — so this fake is how the
 * join-time bootstrap path is verified without a real Signal account.
 *
 * Wraps a real `InMemoryMessengerPort` for everything except `receive()`:
 * the *first* call for a given member establishes a baseline (however
 * many deliveries already existed at that moment) and returns nothing;
 * every later call returns only what arrived since. `inner` is exposed so
 * tests can inspect the real, unfiltered delivery count without
 * perturbing any member's own baseline by calling through the fake.
 */
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

  /** Simulates the member's application restarting: a history-less transport shows the new instance nothing from before. */
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

/**
 * Every `resync-request` frame in `member`'s `receive()` stream, oldest first — a
 * resync request is an ordinary frame.
 */
async function resyncRequestsFrom(
  messenger: Pick<MessengerPort, "receive">,
  documentId: DocumentId,
  member: MemberId,
): Promise<
  { readonly id: string; readonly requester: MemberId; readonly stateVector: Uint8Array }[]
> {
  const deliveries = await messenger.receive(documentId, member);
  const out: { id: string; requester: MemberId; stateVector: Uint8Array }[] = [];
  for (const delivery of deliveries) {
    const frame = decodeFrame(delivery.payload);
    if (frame.kind === "resync-request") {
      out.push({
        id: frame.requestId, // what an answer names in respondsTo (SPECIFICATION.md §8.2)
        requester: delivery.sender,
        stateVector: frame.stateVector,
      });
    }
  }
  return out;
}

describe("join-time bootstrap against a history-less transport", () => {
  const ADMIN_ALICE = { ...IMMEDIATE, creatorMemberId: "alice" };

  it("a joiner converges via requestResync() even though the transport never replays history", async () => {
    const messenger = new NoHistoryMessengerPort();
    const alice = await DocumentEngine.create(
      DOCUMENT_ID,
      "alice",
      messenger,
      undefined,
      ADMIN_ALICE,
    );
    // Establishes alice's own receive() baseline at creation time — in every
    // real deployment the creator's own bridge connection necessarily
    // predates any joiner's request (nobody can join before the document
    // exists), so this mirrors a real bridge rather than exercising
    // NoHistoryMessengerPort's own per-member first-call artifact (a resync
    // request shares receive()'s "no history" simulation with every other frame).
    await alice.sync();
    alice.edit((fragment) => insertPlainText(fragment, 0, "hello from alice"));

    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, ADMIN_ALICE);
    // bob's own join()-time sync() got nothing via replay — the fake
    // transport's entire point — so only requestResync() could have helped,
    // and it hasn't been answered yet.
    expect(bob.hasCompletedBootstrap).toBe(false);
    expect(getPlainText(bob.fragment)).toBe("");

    await alice.sync(); // admin — answers on the very next tick
    await bob.sync();

    expect(bob.hasCompletedBootstrap).toBe(true);
    expect(getPlainText(bob.fragment)).toBe("hello from alice");
  });

  it("a joiner whose only content-holding peer never comes online ends up empty, honestly reported via hasCompletedBootstrap", async () => {
    const messenger = new NoHistoryMessengerPort();
    const alice = await DocumentEngine.create(
      DOCUMENT_ID,
      "alice",
      messenger,
      undefined,
      IMMEDIATE,
    );
    alice.edit((fragment) => insertPlainText(fragment, 0, "alice was here"));
    // alice never calls sync() again — nobody is online to answer bob.

    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, JOIN_ALICE);

    expect(bob.hasCompletedBootstrap).toBe(false);
    expect(getPlainText(bob.fragment)).toBe("");
  });

  it("a peer with nothing new to offer sends no resync-response at all", async () => {
    const messenger = new NoHistoryMessengerPort();
    const alice = await DocumentEngine.create(
      DOCUMENT_ID,
      "alice",
      messenger,
      undefined,
      ADMIN_ALICE,
    );
    await alice.sync(); // establishes alice's own receive() baseline before bob ever joins
    alice.edit((fragment) => insertPlainText(fragment, 0, "content"));

    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, ADMIN_ALICE);
    await alice.sync();
    await bob.sync();
    expect(getPlainText(bob.fragment)).toBe("content"); // bob is now fully caught up

    await bob.requestResync(); // bob asks again despite already having everything
    // Measured after bob's own resync-request frame, so only what alice's own
    // sync() adds is being checked.
    const deliveriesBefore = (await messenger.inner.receive(DOCUMENT_ID, "alice")).length;
    await alice.sync(); // alice has nothing bob doesn't already have
    const deliveriesAfter = (await messenger.inner.receive(DOCUMENT_ID, "alice")).length;

    expect(deliveriesAfter).toBe(deliveriesBefore);
  });

  it("resyncResponseThrottleMs bounds how often one client answers different requests", async () => {
    const messenger = new NoHistoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
      ...ADMIN_ALICE,
      resyncResponseThrottleMs: 10_000, // deliberately long — proves the throttle, not a timing coincidence
    });
    await alice.sync(); // establishes alice's own receive() baseline before anyone joins
    alice.edit((fragment) => insertPlainText(fragment, 0, "content"));

    await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, ADMIN_ALICE);
    const deliveriesBefore = (await messenger.inner.receive(DOCUMENT_ID, "alice")).length;

    await alice.sync(); // answers bob's join-time request — one response sent, throttle timestamp set
    const afterFirst = (await messenger.inner.receive(DOCUMENT_ID, "alice")).length;
    expect(afterFirst - deliveriesBefore).toBe(1);

    // a second, different joiner's request arrives within the throttle
    // window — alice must not answer it yet. Measured after carol's own
    // join-time request (an ordinary frame in this same stream), so only what
    // alice's own throttled sync()
    // adds is being checked.
    await DocumentEngine.join(DOCUMENT_ID, "carol", messenger, undefined, ADMIN_ALICE);
    const afterCarolJoined = (await messenger.inner.receive(DOCUMENT_ID, "alice")).length;
    await alice.sync();
    const afterSecondAttempt = (await messenger.inner.receive(DOCUMENT_ID, "alice")).length;
    expect(afterSecondAttempt).toBe(afterCarolJoined); // still throttled, not answered yet
  });

  describe("attribution overlay", () => {
    it("a true-bootstrap joiner adopts the responder's attribution ranges — not misattributed wholesale to the responder", async () => {
      const messenger = new NoHistoryMessengerPort();
      // resyncResponseThrottleMs: 0 — alice answers two different joiners'
      // bootstrap requests moments apart in test time; the default 1000ms
      // throttle would otherwise block the second one, unrelated to what
      // this test is actually about.
      const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
        ...ADMIN_ALICE,
        resyncResponseThrottleMs: 0,
      });
      await alice.sync(); // establishes alice's own receive() baseline before bob ever joins

      alice.edit((fragment) => insertPlainText(fragment, 0, "alice-text "));
      const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, ADMIN_ALICE);
      await alice.sync();
      await bob.sync();
      expect(getPlainText(bob.fragment)).toBe("alice-text ");

      bob.edit((fragment) => insertPlainText(fragment, getPlainText(fragment).length, "bob-text"));
      await alice.sync(); // alice now genuinely has content from both authors

      const carol = await DocumentEngine.join(
        DOCUMENT_ID,
        "carol",
        messenger,
        undefined,
        ADMIN_ALICE,
      );
      await alice.sync(); // alice (the responder) answers carol's bootstrap request
      await carol.sync();

      expect(getPlainText(carol.fragment)).toBe("alice-text bob-text");
      const authorIds = carol.attribution.ranges.map((range) => range.authorId);
      expect(authorIds).toContain("alice");
      expect(authorIds).toContain("bob");
      // the crucial assertion: NOT everything attributed to alice, the
      // one client whose sync() actually sent this delivery.
      expect(authorIds.every((id) => id === "alice")).toBe(false);
    });

    it("a partial gap-heal leaves newly-applied content unattributed (null), not the responder's", async () => {
      const messenger = new NoHistoryMessengerPort();
      // resyncResponseThrottleMs: 0 — alice answers bob's bootstrap AND
      // his later partial request moments apart in test time.
      const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
        ...ADMIN_ALICE,
        resyncResponseThrottleMs: 0,
      });
      await alice.sync(); // establishes alice's own receive() baseline before bob ever joins
      const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, ADMIN_ALICE);
      await alice.sync();
      await bob.sync();
      expect(getPlainText(bob.fragment)).toBe(""); // bootstrapped, but nothing written yet

      // Force a genuine, resync-only-healable gap: alice's next send is
      // dropped for everyone (mock fault injection via the exposed inner
      // port), so bob's own ordinary sync() could never pick this content
      // up through the normal delivery stream — without this, bob's next
      // sync() would just receive alice's edit normally, attributed to
      // her correctly, and this test would not actually exercise the
      // resync/sentinel path it's about at all.
      messenger.inner.dropNextSend("alice");
      alice.edit((fragment) => insertPlainText(fragment, 0, "alice wrote this"));
      await bob.sync();
      expect(getPlainText(bob.fragment)).toBe(""); // confirms the gap is real

      // bob's state vector is no longer empty (he already has the seeded,
      // still-empty paragraph structure) — this is a partial gap-heal
      // request, not a true bootstrap.
      await bob.requestResync();
      await alice.sync();
      await bob.sync();

      expect(getPlainText(bob.fragment)).toBe("alice wrote this");
      const authorIds = bob.attribution.ranges.map((range) => range.authorId);
      expect(authorIds.length).toBeGreaterThan(0); // recorded, not silently dropped...
      expect(authorIds).not.toContain("alice"); // ...but never attributed to the responder
      expect(authorIds).toEqual([null]); // unattributed: no MemberId stands for it (ATR-2)
      expect([...bob.attribution.lastEditBySender.keys()]).not.toContain(null);
    });

    it("content from the creator's answer to someone else's request is unattributed, not the creator's (RSY-13)", async () => {
      const messenger = new NoHistoryMessengerPort();
      const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
        ...ADMIN_ALICE,
        resyncResponseThrottleMs: 0,
      });
      await alice.sync();
      const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, ADMIN_ALICE);
      const carol = await DocumentEngine.join(
        DOCUMENT_ID,
        "carol",
        messenger,
        undefined,
        ADMIN_ALICE,
      );
      await alice.sync();
      await bob.sync();
      await carol.sync();

      // bob writes, and the message is lost for everyone: only a resync can carry it now.
      messenger.inner.dropNextSend("bob");
      bob.edit((fragment) => insertPlainText(fragment, 0, "bob wrote this"));
      await bob.flush();

      // The creator's answer to a request that is not carol's carries bob's text.
      await messenger.inner.send(
        DOCUMENT_ID,
        "alice",
        encodeResyncResponseFrame({
          documentId: DOCUMENT_ID,
          respondsTo: "5e5e5e5e5e5e5e5e",
          update: encodeUpdate(bob.document),
          attribution: null,
        }),
      );
      await carol.sync();

      expect(getPlainText(carol.fragment)).toBe("bob wrote this"); // applied: content is harmless
      const authorIds = carol.attribution.ranges.map((range) => range.authorId);
      expect(authorIds.length).toBeGreaterThan(0);
      expect(authorIds).not.toContain("alice"); // the creator sent it, but did not write it
      expect(authorIds).toEqual([null]);
    });

    // A joiner accepts a resync response only from the creator (RSY-12), so there
    // is one possible responder and therefore one overlay.

    it("a client's own local edit is never wiped by an overlay adopted afterwards", async () => {
      // Bob types into his editor immediately after join() — well before his own
      // bootstrap resync-response could possibly arrive. Skipping *all* overlay adoption once
      // a client had made any local edit protected that case but permanently
      // sentinel-attributed later bootstrap content unrelated to the edit, so
      // #considerBootstrapOverlay restores wholesale only when the overlay accounts
      // for the whole document and otherwise re-attributes only the sentinel's own
      // ranges. This exercises that "content the overlay knows nothing about is
      // never touched" guarantee.
      const messenger = new NoHistoryMessengerPort();
      const alice = await DocumentEngine.create(
        DOCUMENT_ID,
        "alice",
        messenger,
        undefined,
        ADMIN_ALICE,
      );
      alice.edit((fragment) => insertPlainText(fragment, 0, "alice-text"));
      const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, ADMIN_ALICE);
      const [bobRequest] = await resyncRequestsFrom(messenger.inner, DOCUMENT_ID, "alice");
      if (!bobRequest) {
        throw new Error("expected bob's join-time resync request to be recorded");
      }

      // bob types before the creator's answer arrives.
      bob.edit((fragment) => insertPlainText(fragment, getPlainText(fragment).length, "bob-text"));
      expect(bob.attribution.ranges.map((range) => range.authorId)).toContain("bob");

      await messenger.inner.send(
        DOCUMENT_ID,
        "alice",
        encodeResyncResponseFrame({
          documentId: DOCUMENT_ID,
          respondsTo: bobRequest.id,
          update: encodeUpdate(alice.document),
          attribution: {
            ranges: [{ start: 0, end: 10, authorId: "alice" }],
            lastEditBySender: { alice: 10 },
          },
        }),
      );
      await bob.sync();

      expect(getPlainText(bob.fragment)).toContain("alice-text");
      expect(getPlainText(bob.fragment)).toContain("bob-text");
      expect(bob.attribution.ranges.map((range) => range.authorId)).toContain("bob");
    });

    it("a creator that restarted is restored by a peer, adopts the first overlay it receives, and a second one changes nothing", async () => {
      const messenger = new NoHistoryMessengerPort();
      const alice = await DocumentEngine.create(
        DOCUMENT_ID,
        "alice",
        messenger,
        undefined,
        ADMIN_ALICE,
      );
      await alice.sync(); // establishes alice's own receive() baseline before carol ever joins
      alice.edit((fragment) => insertPlainText(fragment, 0, "alice-text"));
      const carol = await DocumentEngine.join(
        DOCUMENT_ID,
        "carol",
        messenger,
        undefined,
        ADMIN_ALICE,
      );
      await alice.sync();
      await carol.sync();
      expect(getPlainText(carol.fragment)).toBe("alice-text");

      // alice's page reloads: her content is gone, her control state was persisted,
      // and a history-less transport shows the new instance nothing from before.
      messenger.forgetHistory(DOCUMENT_ID, "alice");
      const restarted = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, {
        ...ADMIN_ALICE,
        controlState: persistedOf(alice),
      });
      expect(getPlainText(restarted.fragment)).toBe("");
      const requests = await resyncRequestsFrom(messenger.inner, DOCUMENT_ID, "alice");
      const request = requests[requests.length - 1];
      if (!request) {
        throw new Error("expected the restarted creator's resync request");
      }

      await carol.sync(); // a peer answers the creator's request — the one exception
      // What a peer sends the creator is content only: never a control snapshot, which only the creator can issue.
      const fromCarol = (await messenger.inner.receive(DOCUMENT_ID, "carol"))
        .filter((delivery) => delivery.sender === "carol")
        .map((delivery) => decodeFrame(delivery.payload))
        .filter((frame) => frame.kind === "resync-response");
      expect(fromCarol.length).toBeGreaterThan(0);
      for (const frame of fromCarol) {
        expect(frame.kind === "resync-response" && frame.control).toBeNull();
      }
      await restarted.sync();

      expect(getPlainText(restarted.fragment)).toBe("alice-text");
      expect(restarted.hasCompletedBootstrap).toBe(true);
      const adopted = restarted.attribution.ranges[0]?.authorId;

      // A second peer's answer to the same request changes nothing: the first stands.
      await messenger.inner.send(
        DOCUMENT_ID,
        "dave",
        encodeResyncResponseFrame({
          documentId: DOCUMENT_ID,
          respondsTo: request.id,
          update: encodeUpdate(carol.document),
          attribution: {
            ranges: [{ start: 0, end: 10, authorId: "dave" }],
            lastEditBySender: { dave: 10 },
          },
        }),
      );
      await restarted.sync();
      expect(restarted.attribution.ranges[0]?.authorId).toBe(adopted);
    });
  });
});

/**
 * A transport whose bridge keeps only the newest `window` deliveries of the document
 * (bindings/bridges.md BRG-17) — what every real bridge now does, at a size far larger.
 */
class WindowedPort implements MessengerPort {
  readonly inner = new InMemoryMessengerPort();
  constructor(readonly window: number) {}
  createDocument(documentId: DocumentId, creator: MemberId) {
    return this.inner.createDocument(documentId, creator);
  }
  send(documentId: DocumentId, sender: MemberId, payload: string) {
    return this.inner.send(documentId, sender, payload);
  }
  async receive(documentId: DocumentId, member: MemberId) {
    return (await this.inner.receive(documentId, member)).slice(-this.window);
  }
  listChannels(member: MemberId) {
    return this.inner.listChannels(member);
  }
}

describe("requests a responder could not answer at once (RSY-9, RSY-19)", () => {
  const AS_ALICE = { batchWindowMs: 0, creatorMemberId: "alice", resyncResponseThrottleMs: 1000 };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers a request the throttle held back once the throttle has passed — two joiners at once both get bootstrapped", async () => {
    const messenger = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    alice.edit((fragment) => insertPlainText(fragment, 0, "content"));
    await vi.advanceTimersByTimeAsync(10);
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, AS_ALICE);
    const carol = await DocumentEngine.join(DOCUMENT_ID, "carol", messenger, undefined, AS_ALICE);
    await vi.advanceTimersByTimeAsync(10);

    await alice.sync(); // both requests in one tick: one answered, the other held by the throttle
    await vi.advanceTimersByTimeAsync(1_100);
    await alice.sync(); // the held one, now
    await vi.advanceTimersByTimeAsync(10);
    await bob.sync();
    await carol.sync();

    expect(bob.hasCompletedBootstrap).toBe(true);
    expect(carol.hasCompletedBootstrap).toBe(true);
    expect(carol.mayEdit).toBe(true);
  });

  it("answers two devices of one member that ask at once, each its own request (RSY-19, wappensc/tdsp#31)", async () => {
    const messenger = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    alice.edit((fragment) => insertPlainText(fragment, 0, "content"));
    await vi.advanceTimersByTimeAsync(10);
    const laptop = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, AS_ALICE);
    const phone = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, AS_ALICE);
    await vi.advanceTimersByTimeAsync(10);

    await alice.sync(); // both requests in one tick: one answered, the other kept
    await vi.advanceTimersByTimeAsync(1_100);
    await alice.sync(); // the kept one, now — not replaced by the other device's
    await vi.advanceTimersByTimeAsync(10);
    await laptop.sync();
    await phone.sync();

    expect(laptop.hasCompletedBootstrap).toBe(true);
    expect(phone.hasCompletedBootstrap).toBe(true);
  });

  it("serves requesters in turn, so one that asks again and again does not push another back (RSY-19)", async () => {
    const messenger = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    alice.edit((fragment) => insertPlainText(fragment, 0, "content"));
    await vi.advanceTimersByTimeAsync(10);
    // Bob from three devices, then Carol: four requests in one tick.
    const bobs = [];
    for (let i = 0; i < 3; i++)
      bobs.push(await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, AS_ALICE));
    const carol = await DocumentEngine.join(DOCUMENT_ID, "carol", messenger, undefined, AS_ALICE);
    await vi.advanceTimersByTimeAsync(10);

    await alice.sync(); // answers Bob's first
    await vi.advanceTimersByTimeAsync(1_100);
    await alice.sync(); // then Carol's, not Bob's second
    await vi.advanceTimersByTimeAsync(10);
    await carol.sync();
    expect(carol.hasCompletedBootstrap).toBe(true);
  });

  /** Bob joins alice's document over `port`; alice's first answer meets `failure`. */
  async function answerFails(failure: TransportSendError) {
    const port = new FlakySendPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
    alice.edit((fragment) => insertPlainText(fragment, 0, "content"));
    await vi.advanceTimersByTimeAsync(10);
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, AS_ALICE);
    await vi.advanceTimersByTimeAsync(10);
    port.failNextSends(failure);
    await alice.sync(); // the answer is refused
    await vi.advanceTimersByTimeAsync(10);
    await bob.sync();
    expect(bob.hasCompletedBootstrap).toBe(false);
    const sent = async (kind: string, sender: MemberId) =>
      (await port.inner.receive(DOCUMENT_ID, "alice")).filter(
        (delivery) => delivery.sender === sender && JSON.parse(delivery.payload).kind === kind,
      ).length;
    return { alice, bob, sent };
  }

  it("puts a request back when its answer could not go out, and answers it without a new request", async () => {
    const { alice, bob, sent } = await answerFails(
      new TransportSendError("rate-limited", "slow down"),
    );
    await vi.advanceTimersByTimeAsync(1_100);
    await alice.sync(); // nothing new arrived: the kept request is answered again...
    await vi.advanceTimersByTimeAsync(400); // ...once the spacing the rate limit widened to 1.5 s allows (SND-9)
    await bob.sync();

    expect(bob.hasCompletedBootstrap).toBe(true);
    expect(await sent("resync-request", "bob")).toBe(1); // well before bob's own retry
  });

  it("lets a request go when its answer was refused for good, rather than retry it without end", async () => {
    const { alice, sent } = await answerFails(new TransportSendError("rejected", "never"));
    for (let tick = 0; tick < 5; tick += 1) {
      await vi.advanceTimersByTimeAsync(1_100);
      await alice.sync();
    }
    expect(await sent("resync-response", "alice")).toBe(0);
  });

  /** Alice, with her errors collected, answers bob's join over `port`; `refuse` decides which of her answer's sends fail. */
  async function answerRefusedForGood(
    port: FlakySendPort,
    refuse: (answerSend: number) => unknown,
  ) {
    const errors: unknown[] = [];
    const alice = await DocumentEngine.create(
      DOCUMENT_ID,
      "alice",
      port,
      (error) => errors.push(error),
      AS_ALICE,
    );
    alice.edit((fragment) => insertPlainText(fragment, 0, "x".repeat(3000)));
    await vi.advanceTimersByTimeAsync(10);
    let answerSends = 0;
    const send = port.send.bind(port);
    port.send = async (documentId, sender, payload) => {
      if (sender === "alice" && decodeFrame(payload).kind === "resync-response") {
        const failure = refuse(answerSends++);
        if (failure !== undefined) {
          throw failure;
        }
      }
      return send(documentId, sender, payload);
    };
    await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, AS_ALICE);
    await vi.advanceTimersByTimeAsync(10);
    for (let tick = 0; tick < 10; tick += 1) {
      await alice.sync();
      await vi.advanceTimersByTimeAsync(1_100);
    }
    return { alice, errors, answerSends: () => answerSends };
  }

  it("reports an answer refused for good once, and does not count it as a change of its own (SND-8)", async () => {
    const refusal = new TransportSendError("rejected", "never");
    const { alice, errors, answerSends } = await answerRefusedForGood(new FlakySendPort(), (n) =>
      n === 0 ? refusal : undefined,
    );
    expect(answerSends()).toBe(1); // let go, not answered again (RSY-9)
    expect(errors).toEqual([refusal]);
    expect(alice.hasUndistributedChanges).toBe(false); // nothing of alice's own is missing anywhere
  });

  it("reports an answer in pieces refused for good once, and does not count it as a change of its own (SND-8)", async () => {
    const port = new FlakySendPort();
    port.limitTo(1_000); // the answer goes in pieces
    const refusal = new TransportSendError("rejected", "not this piece");
    const { alice, errors, answerSends } = await answerRefusedForGood(port, (n) =>
      n === 1 ? refusal : undefined,
    );
    expect(answerSends()).toBe(2); // the first piece, then the refused one: the rest is not sent
    expect(errors).toEqual([refusal]);
    expect(alice.hasUndistributedChanges).toBe(false);
  });

  it("keeps a bounded number under a flood, and still answers a single valid request afterwards", async () => {
    const messenger = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    alice.edit((fragment) => insertPlainText(fragment, 0, "content"));
    await vi.advanceTimersByTimeAsync(10);
    for (let i = 0; i < 500; i += 1) {
      await messenger.send(
        DOCUMENT_ID,
        `flooder-${i}`,
        encodeResyncRequestFrame({
          documentId: DOCUMENT_ID,
          requestId: i.toString(16).padStart(16, "0"),
          control: null,
          controlDigest: null,
          force: false,
          stateVector: new Uint8Array([0]),
          // What a joiner with nothing states: it deleted nothing (Appendix D). Another digest beside
          // an empty vector would be evidence of a lost deletion at every receiver (LOS-12).
          stateDigest: "96a296d224f285c6",
        }),
      );
    }
    await alice.sync();
    const sent = (await messenger.receive(DOCUMENT_ID, "alice")).length;
    await vi.advanceTimersByTimeAsync(10_000);
    await alice.sync();
    // At most one answer per throttle interval, however many requests are held.
    expect((await messenger.receive(DOCUMENT_ID, "alice")).length - sent).toBeLessThanOrEqual(1);

    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, AS_ALICE);
    for (let tick = 0; tick < 70 && !bob.hasCompletedBootstrap; tick += 1) {
      await vi.advanceTimersByTimeAsync(1_100);
      await alice.sync();
      await bob.sync();
    }
    expect(bob.hasCompletedBootstrap).toBe(true);
  });
});

describe("a window that moved past everything an engine had read (LOS-8)", () => {
  const OPTS = { ...IMMEDIATE, creatorMemberId: "alice" };

  /** Carol's edit, then filler that is no evidence of anything, pushes it out of a window of 3 before Bob reads. */
  async function carolsEditSlidesOut(port: WindowedPort) {
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, OPTS);
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, OPTS);
    const carol = await DocumentEngine.join(DOCUMENT_ID, "carol", port, undefined, OPTS);
    await alice.sync();
    await vi.advanceTimersByTimeAsync(1_100);
    await alice.sync(); // the throttle: carol's join is answered a second after bob's
    await bob.sync();
    await carol.sync();
    carol.edit((fragment) => insertPlainText(fragment, 0, "carol's words"));
    await vi.advanceTimersByTimeAsync(10);
    for (let i = 0; i < 4; i += 1) {
      await DocumentEngine.decline(DOCUMENT_ID, `passer-by-${i}`, port, { reason: "declined" });
    }
    return { alice, bob, carol };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("notices it, asks for a resync at once, and gets what slid out", async () => {
    const port = new WindowedPort(3);
    const { alice, bob, carol } = await carolsEditSlidesOut(port);
    await bob.sync();
    expect(bob.syncHealth.suspicions.map((s) => s.kind)).toContain("history-truncated");
    expect(bob.syncHealth.resync.state).toBe("requested");
    expect(bob.syncHealth.resync.automatic).toBe(true);

    // The creator had not read Carol's edit either: it notices the same, Carol answers it (a
    // peer answers the creator), and then the creator answers Bob — once Bob's earlier request,
    // which slid out unread too, has expired and freed his one slot (RSY-3, RSY-4).
    let ticks = 0;
    for (; ticks < 40 && getPlainText(bob.fragment) === ""; ticks += 1) {
      await vi.advanceTimersByTimeAsync(1_100);
      await alice.sync();
      await carol.sync();
      await bob.sync();
    }
    expect(getPlainText(alice.fragment)).toBe("carol's words");
    expect(getPlainText(bob.fragment)).toBe("carol's words");
    // About two request expiries: the old request has to expire, then the automatic one is spaced.
    expect(ticks).toBeLessThan(25);
    expect(bob.syncHealth.suspicions.map((s) => s.kind)).not.toContain("history-truncated");
  });

  it("with the creator away, keeps saying it may be missing something", async () => {
    const port = new WindowedPort(3);
    const { bob } = await carolsEditSlidesOut(port);
    await bob.sync();
    await vi.advanceTimersByTimeAsync(10 * 60_000); // nobody answers
    await bob.sync();
    expect(getPlainText(bob.fragment)).toBe("");
    expect(bob.syncHealth.state).toBe("suspected");
    expect(bob.syncHealth.suspicions.map((s) => s.kind)).toContain("history-truncated");
  });

  it("does not suspect anything while the window still holds something it read", async () => {
    const port = new WindowedPort(4);
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, OPTS);
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, OPTS);
    await alice.sync();
    await bob.sync();
    for (let i = 0; i < 3; i += 1) {
      await DocumentEngine.decline(DOCUMENT_ID, `passer-by-${i}`, port, { reason: "declined" });
      await bob.sync();
    }
    expect(bob.syncHealth.suspicions.map((s) => s.kind)).not.toContain("history-truncated");
  });
});

/**
 * A bridge that restarts (BRG-17): `receive` fails while it is down, and afterwards one member's
 * view may lack deliveries it never read — dropped before the restart, not in the history the
 * new run reads — while older ones it did read are there again.
 */
class RestartingBridgePort implements MessengerPort {
  readonly inner = new InMemoryMessengerPort();
  down = false;
  readonly lostFor = new Map<MemberId, Set<DeliveryId>>();
  createDocument(documentId: DocumentId, creator: MemberId) {
    return this.inner.createDocument(documentId, creator);
  }
  send(documentId: DocumentId, sender: MemberId, payload: string) {
    return this.inner.send(documentId, sender, payload);
  }
  async receive(documentId: DocumentId, member: MemberId) {
    if (this.down) {
      throw new Error("the bridge is not answering");
    }
    const lost = this.lostFor.get(member) ?? new Set();
    return (await this.inner.receive(documentId, member)).filter((d) => !lost.has(d.id));
  }
  listChannels(member: MemberId) {
    return this.inner.listChannels(member);
  }
}

describe("a bridge restart that hides a loss behind deliveries offered again (LOS-8)", () => {
  const OPTS = { ...IMMEDIATE, creatorMemberId: "alice" };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Bob has read everything; then the bridge goes down, Carol's edit is lost to Bob in the
   * restart, and afterwards Bob's view overlaps what he read before — the review's
   * `[A,B] → C unread → restart → [B,E]`. `lose: false` restarts without losing anything.
   */
  async function restartBehindBob(lose: boolean) {
    const port = new RestartingBridgePort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, OPTS);
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, OPTS);
    const carol = await DocumentEngine.join(DOCUMENT_ID, "carol", port, undefined, OPTS);
    for (let tick = 0; tick < 5; tick += 1) {
      await vi.advanceTimersByTimeAsync(1_100);
      await alice.sync();
      await bob.sync();
      await carol.sync();
    }
    expect(bob.hasCompletedBootstrap && carol.hasCompletedBootstrap).toBe(true);
    await alice.sync();
    await bob.sync();

    port.down = true;
    await expect(bob.sync()).rejects.toThrow("not answering");
    carol.edit((fragment) => insertPlainText(fragment, 0, "carol's words"));
    await vi.advanceTimersByTimeAsync(10);
    if (lose) {
      const all = await port.inner.receive(DOCUMENT_ID, "bob");
      port.lostFor.set("bob", new Set([(all.at(-1) as Delivery).id]));
    }
    await DocumentEngine.decline(DOCUMENT_ID, "passer-by", port, { reason: "declined" }); // E
    port.down = false;
    await bob.sync(); // overlaps what Bob read before, and lacks Carol's edit
    return { port, alice, bob, carol };
  }

  it("treats the first answer after a failed receive as a truncated history, and heals", async () => {
    const { alice, bob, carol } = await restartBehindBob(true);
    expect(bob.syncHealth.suspicions.map((s) => s.kind)).toContain("history-truncated");
    expect(bob.syncHealth.resync.state).toBe("requested");

    for (let tick = 0; tick < 20 && getPlainText(bob.fragment) === ""; tick += 1) {
      await vi.advanceTimersByTimeAsync(1_100);
      await alice.sync();
      await carol.sync();
      await bob.sync();
    }
    expect(getPlainText(bob.fragment)).toBe("carol's words");
    expect(bob.syncHealth.suspicions.map((s) => s.kind)).not.toContain("history-truncated");
  });

  it("with the creator away, keeps saying it may be missing something", async () => {
    const { bob } = await restartBehindBob(true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await bob.sync();
    expect(getPlainText(bob.fragment)).toBe("");
    expect(bob.syncHealth.state).toBe("suspected");
    expect(bob.syncHealth.suspicions.map((s) => s.kind)).toContain("history-truncated");
  });

  it("leaves the creator no lasting alarm either, once its own request got no answer", async () => {
    const port = new RestartingBridgePort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, OPTS);
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, OPTS);
    for (let tick = 0; tick < 3; tick += 1) {
      await vi.advanceTimersByTimeAsync(1_100);
      await alice.sync();
      await bob.sync();
    }
    port.down = true;
    await expect(alice.sync()).rejects.toThrow("not answering");
    port.down = false;
    await alice.sync();
    expect(alice.syncHealth.suspicions.map((s) => s.kind)).toContain("history-truncated");
    // Bob lacks nothing the creator has, so he does not answer (RSY-17); the request expires.
    for (let tick = 0; tick < 15; tick += 1) {
      await vi.advanceTimersByTimeAsync(1_100);
      await alice.sync();
      await bob.sync();
    }
    expect(alice.syncHealth.resync.lastOutcome).toBe("unanswered");
    expect(alice.syncHealth.suspicions.map((s) => s.kind)).not.toContain("history-truncated");
  });

  it("costs one answered request when nothing was lost, and leaves no lasting alarm", async () => {
    const { port, alice, bob } = await restartBehindBob(false);
    for (let tick = 0; tick < 5; tick += 1) {
      await vi.advanceTimersByTimeAsync(1_100);
      await alice.sync();
      await bob.sync();
    }
    expect(bob.syncHealth.state).not.toBe("suspected");
    const requests = (await port.inner.receive(DOCUMENT_ID, "alice")).filter(
      (d) => d.sender === "bob" && JSON.parse(d.payload).kind === "resync-request",
    );
    expect(requests).toHaveLength(2); // the join, and the one after the restart
  });
});

describe("old deliveries offered again, as a restarted bridge may (TRN-8, BRG-17)", () => {
  it("change nothing a second time: content, permissions, declines", async () => {
    const port = new WindowedPort(3);
    const errors: unknown[] = [];
    const declines: string[] = [];
    const OPTS = { ...IMMEDIATE, creatorMemberId: "alice" };
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, OPTS);
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, (error) => errors.push(error), {
      ...OPTS,
      onDecline: (decline) => declines.push(decline.sender),
    });
    await alice.sync();
    await bob.sync();
    alice.edit((fragment) => insertPlainText(fragment, 0, "once"));
    await alice.setMembership("bob", "read");
    await DocumentEngine.decline(DOCUMENT_ID, "dave", port, { reason: "declined" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await bob.sync();
    // A copy: the mock's own list grows as replay() appends to it.
    const everything = [...(await port.inner.receive(DOCUMENT_ID, "bob"))];
    // Enough new traffic that the window, and with it Bob's memory, moves past all of it...
    for (let i = 0; i < 4; i += 1) {
      await DocumentEngine.decline(DOCUMENT_ID, `passer-by-${i}`, port, { reason: "declined" });
      await bob.sync();
    }
    // ...then the bridge restarts and offers every one of those old deliveries again.
    for (const delivery of everything) {
      port.inner.replay(DOCUMENT_ID, delivery.id);
      await bob.sync();
    }

    expect(getPlainText(bob.fragment)).toBe("once");
    expect(bob.permissionOf("bob")).toBe("read");
    expect(Object.values(bob.controlVector)).toEqual([1]);
    expect(declines.filter((sender) => sender === "dave")).toHaveLength(1);
    expect(errors).toEqual([]);
  });
});

describe("a bridge that keeps only a window of deliveries (BRG-17)", () => {
  it("converges while old deliveries slide out, and nothing is applied twice", async () => {
    const port = new WindowedPort(4);
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, {
      ...IMMEDIATE,
      creatorMemberId: "alice",
    });
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, {
      ...IMMEDIATE,
      creatorMemberId: "alice",
    });
    await alice.sync();
    await bob.sync();
    let expected = "";
    for (let i = 0; i < 30; i += 1) {
      const author = i % 2 === 0 ? alice : bob;
      author.edit((fragment) => insertPlainText(fragment, expected.length, String(i % 10)));
      expected += String(i % 10);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await alice.sync();
      await bob.sync();
    }
    expect(getPlainText(alice.fragment)).toBe(expected);
    expect(getPlainText(bob.fragment)).toBe(expected);
  });
});

/**
 * A real `InMemoryMessengerPort` whose `send` can be made to fail — with whatever
 * error the test hands it — so a refused send is exercised against a real receiver
 * rather than a fake one.
 */
class FlakySendPort implements MessengerPort {
  readonly inner = new InMemoryMessengerPort();
  sendAttempts = 0;
  #failures: unknown[] = [];
  /** What `transportProfile()` answers; none by default, like the mock. */
  profile: TransportProfile | undefined;
  /** Makes `transportProfile()` reject, as a bridge that cannot be reached would. */
  profileFailure: Error | undefined;
  /**
   * A transport with a largest message: declares it in its profile and refuses,
   * as a real one does, anything larger with a `too-large` error that is not worth retrying.
   */
  maxBytes: number | undefined;
  /** The size of every payload this transport was actually asked to carry, refused ones excluded. */
  sentSizes: number[] = [];
  /** A transport that shows a member only what arrived after it started listening (Signal's). */
  noHistory = false;
  #baselines = new Map<string, number>();

  /** Declares a largest message, and enforces it. */
  limitTo(maxBytes: number): void {
    this.maxBytes = maxBytes;
    this.profile = {
      bounds: { minIntervalMs: null, maxBytes },
      pacing: {
        minIntervalMs: 0,
        maxIntervalMs: null,
        minChars: 0,
        maxChars: null,
        expectedLatencyMs: 0,
      },
    };
  }

  async transportProfile(): Promise<TransportProfile | undefined> {
    if (this.profileFailure) {
      throw this.profileFailure;
    }
    return this.profile;
  }

  failNextSends(...errors: unknown[]): void {
    this.#failures.push(...errors);
  }

  createDocument(documentId: DocumentId, creator: MemberId): Promise<void> {
    return this.inner.createDocument(documentId, creator);
  }

  async send(documentId: DocumentId, sender: MemberId, payload: string): Promise<string> {
    this.sendAttempts += 1;
    if (this.maxBytes !== undefined && payload.length > this.maxBytes) {
      throw new TransportSendError(
        "too-large",
        `${payload.length} bytes exceeds the ${this.maxBytes} this transport carries`,
      );
    }
    const failure = this.#failures.shift();
    if (failure !== undefined) {
      throw failure;
    }
    this.sentSizes.push(payload.length);
    return this.inner.send(documentId, sender, payload);
  }

  async receive(documentId: DocumentId, member: MemberId): Promise<readonly Delivery[]> {
    const all = await this.inner.receive(documentId, member);
    if (!this.noHistory) {
      return all;
    }
    const key = `${documentId}:${member}`;
    const baseline = this.#baselines.get(key);
    if (baseline === undefined) {
      this.#baselines.set(key, all.length);
      return [];
    }
    return all.slice(baseline);
  }

  listChannels(member: MemberId): Promise<readonly RawChannel[]> {
    return this.inner.listChannels(member);
  }
}

describe("the bounds of control state when the creator decides (CTL-37, SND-18)", () => {
  it("refuses a decision after which no answer could carry the control state, and nothing changes", async () => {
    const port = new FlakySendPort();
    port.limitTo(4_000);
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, {
      batchWindowMs: 0,
      creatorMemberId: "alice",
    });
    let refused: unknown;
    let n = 0;
    for (; n < 200 && refused === undefined; n++) {
      await alice
        .setMembership(`@member-${String(n).padStart(40, "0")}:example.org`, "read")
        .catch((error: unknown) => {
          refused = error;
        });
    }
    expect(refused).toBeInstanceOf(SendRefusedError);
    expect((refused as SendRefusedError).reason).toBe("too-large");
    const last = `@member-${String(n - 1).padStart(40, "0")}:example.org`;
    expect(alice.permissionOf(last)).toBeUndefined(); // not held, not persisted, not sent
    expect(Math.max(...port.sentSizes)).toBeLessThanOrEqual(4_000);
    // The ones before still fit in one answer.
    expect(alice.permissionOf(`@member-${String(n - 2).padStart(40, "0")}:example.org`)).toBe(
      "read",
    );
  });
});

describe("send scheduling and retry", () => {
  const AS_ALICE = { creatorMemberId: "alice" };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A creator and a joiner who has bootstrapped, both on real timers' fake clock. */
  async function pair(
    port: MessengerPort,
    aliceOptions: DocumentEngineOptions = {},
    bobOptions: DocumentEngineOptions = {},
    onBobError: (error: unknown, context: string) => void = () => {},
  ) {
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, {
      ...AS_ALICE,
      ...aliceOptions,
    });
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, onBobError, {
      ...AS_ALICE,
      ...bobOptions,
    });
    await alice.sync(); // answers bob's join request
    await bob.sync();
    return { alice, bob };
  }

  it("keeps an edit whose send failed and delivers it once the transport recovers", async () => {
    const port = new FlakySendPort();
    const errors: unknown[] = [];
    const { alice, bob } = await pair(port, {}, {}, (error) => errors.push(error));
    port.failNextSends(new TransportSendError("unavailable", "bridge unreachable"));

    bob.edit((fragment) => insertPlainText(fragment, 0, "written offline"));
    await vi.advanceTimersByTimeAsync(500); // the quiet time; the send is refused

    expect(bob.hasPendingChanges).toBe(true); // kept, not dropped
    expect(bob.sendStatus.state).toBe("retrying");
    expect(bob.sendStatus.lastError).toBe("bridge unreachable");
    expect(errors).toEqual([]); // not lost, so not an error
    await alice.sync();
    expect(getPlainText(alice.fragment)).not.toContain("written offline");

    await vi.advanceTimersByTimeAsync(1000); // the back-off
    expect(bob.hasPendingChanges).toBe(false);
    expect(bob.sendStatus.state).toBe("idle");
    await alice.sync();
    expect(getPlainText(alice.fragment)).toBe("written offline");
  });

  it("keeps an edit whose send failed for a reason nobody classified, and retries it (TRN-12)", async () => {
    const port = new FlakySendPort();
    const errors: unknown[] = [];
    const { alice, bob } = await pair(port, {}, {}, (error) => errors.push(error));
    port.failNextSends(new TransportSendError("timeout" as never, "the bridge timed out"));

    bob.edit((fragment) => insertPlainText(fragment, 0, "kept"));
    await vi.advanceTimersByTimeAsync(500);
    expect(bob.sendStatus.state).toBe("retrying");
    expect(bob.hasUndistributedChanges).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    await alice.sync();
    expect(getPlainText(alice.fragment)).toBe("kept");
    expect(errors).toEqual([]);
  });

  it("keeps an edit refused until the person acts, waits for the person, and sends it on flush() (TRN-20, TRN-22)", async () => {
    const port = new FlakySendPort();
    const errors: unknown[] = [];
    const { alice, bob } = await pair(port, {}, {}, (error) => errors.push(error));
    port.failNextSends(
      new TransportSendError("needs-person", "an identity to trust"),
      new TransportSendError("needs-person", "an identity to trust"),
    );

    bob.edit((fragment) => insertPlainText(fragment, 0, "kept for the person"));
    await vi.advanceTimersByTimeAsync(500);
    expect(bob.sendStatus.state).toBe("needs-person");
    expect(bob.sendStatus.lastError).toBe("an identity to trust");
    expect(bob.hasPendingChanges).toBe(true); // kept, not dropped
    expect(bob.hasUndistributedChanges).toBe(false);
    expect(errors).toEqual([]); // not lost, so not an error

    // No back-off that spins: nothing goes out before the longest back-off.
    const attempts = port.sendAttempts;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(port.sendAttempts).toBe(attempts);

    // The person trusted the identity; the application asks to send now.
    await expect(bob.flush()).rejects.toThrow("an identity to trust");
    await bob.flush();
    expect(bob.sendStatus.state).toBe("idle");
    await alice.sync();
    expect(getPlainText(alice.fragment)).toBe("kept for the person");
    expect(errors).toEqual([]);
  });

  it("answers a request again only once the wait the provider asked for is over (SND-7, RSY-9)", async () => {
    const port = new FlakySendPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
    // The provider throttles alice's account for 30 s from her first answer on.
    let throttledUntil = 0;
    const answers: number[] = [];
    const send = port.send.bind(port);
    port.send = async (documentId, sender, payload) => {
      if (sender === "alice" && decodeFrame(payload).kind === "resync-response") {
        answers.push(Date.now());
        if (throttledUntil === 0) {
          throttledUntil = Date.now() + 30_000;
        }
        if (Date.now() < throttledUntil) {
          throw new TransportSendError("rate-limited", "slow down", throttledUntil - Date.now());
        }
      }
      return send(documentId, sender, payload);
    };
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, AS_ALICE);
    for (let second = 0; second < 40; second += 1) {
      await vi.advanceTimersByTimeAsync(1000);
      await alice.sync();
      await bob.sync();
    }
    expect(answers.filter((at) => at < throttledUntil)).toHaveLength(1); // the refused one, nothing more
    expect(bob.hasCompletedBootstrap).toBe(true); // answered once the wait was over
  });

  it("delivers through a real disconnect and reconnect of the mock, with no Resync", async () => {
    const port = new InMemoryMessengerPort();
    const { alice, bob } = await pair(port);
    port.disconnect("bob");

    bob.edit((fragment) => insertPlainText(fragment, 0, "typed while cut off"));
    await vi.advanceTimersByTimeAsync(500);
    expect(bob.sendStatus.state).toBe("retrying");
    await vi.advanceTimersByTimeAsync(3000); // still cut off: the retry fails again
    expect(bob.sendStatus.failures).toBeGreaterThan(1);

    port.reconnect("bob");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(bob.hasPendingChanges).toBe(false);
    await alice.sync();
    expect(getPlainText(alice.fragment)).toBe("typed while cut off");
  });

  it("treats an error nobody classified as worth retrying", async () => {
    const port = new FlakySendPort();
    const { alice, bob } = await pair(port);
    port.failNextSends(new Error("socket hang up"));

    bob.edit((fragment) => insertPlainText(fragment, 0, "still arrives"));
    await vi.advanceTimersByTimeAsync(500 + 1000);
    await alice.sync();
    expect(getPlainText(alice.fragment)).toBe("still arrives");
  });

  it("retries a send failure whose reason is outside the five, as unavailable (TRN-12)", async () => {
    const port = new FlakySendPort();
    const errors: unknown[] = [];
    const { alice, bob } = await pair(port, {}, {}, (error) => errors.push(error));
    // An adapter of a later version may name a reason this engine does not know.
    const unknown = "timeout" as unknown as TransportSendFailure;
    port.failNextSends(new TransportSendError(unknown, "a reason nobody classified"));

    bob.edit((fragment) => insertPlainText(fragment, 0, "kept, not dropped"));
    await vi.advanceTimersByTimeAsync(500); // the quiet time; the send is refused
    expect(bob.hasPendingChanges).toBe(true);
    expect(bob.sendStatus.state).toBe("retrying");
    expect(errors).toEqual([]);

    await vi.advanceTimersByTimeAsync(1000); // the back-off
    await alice.sync();
    expect(getPlainText(alice.fragment)).toBe("kept, not dropped");
    expect(bob.hasUndistributedChanges).toBe(false);
  });

  it("drops an edit the transport refuses for good, and reports it once", async () => {
    const port = new FlakySendPort();
    const errors: unknown[] = [];
    const { bob } = await pair(port, {}, {}, (error) => errors.push(error));
    const refusal = new TransportSendError("too-large", "message exceeds 65536 bytes");
    const afterPair = port.sendAttempts;
    port.failNextSends(refusal);

    bob.edit((fragment) => insertPlainText(fragment, 0, "far too much"));
    await vi.advanceTimersByTimeAsync(600_000);

    expect(errors).toEqual([refusal]);
    expect(bob.hasPendingChanges).toBe(false);
    expect(port.sendAttempts - afterPair).toBe(1); // tried once, never again
    expect(getPlainText(bob.fragment)).toBe("far too much"); // still applied locally
  });

  it("marks a dropped change as not distributed until a resync() is accepted (SND-8)", async () => {
    const port = new FlakySendPort();
    const { alice, bob } = await pair(port, {}, {}, () => {});
    expect(bob.hasUndistributedChanges).toBe(false);
    port.failNextSends(new TransportSendError("rejected", "the provider refused it"));

    bob.edit((fragment) => insertPlainText(fragment, 0, "lost "));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(bob.hasUndistributedChanges).toBe(true);
    bob.edit((fragment) => insertPlainText(fragment, 5, "and built on"));
    await vi.advanceTimersByTimeAsync(600_000);
    await alice.sync();
    expect(getPlainText(alice.fragment)).toBe(""); // the later change needs the dropped one
    expect(bob.hasUndistributedChanges).toBe(true); // a later successful send does not repair

    const repaired = bob.resync();
    await vi.advanceTimersByTimeAsync(1000);
    await repaired;
    expect(bob.hasUndistributedChanges).toBe(false);
    await alice.sync();
    expect(getPlainText(alice.fragment)).toBe("lost and built on");
  });

  it("stays not distributed when the repair itself is refused", async () => {
    const port = new FlakySendPort();
    const { bob } = await pair(port, {}, {}, () => {});
    port.failNextSends(
      new TransportSendError("rejected", "no"),
      new TransportSendError("rejected", "still no"),
    );
    bob.edit((fragment) => insertPlainText(fragment, 0, "x"));
    await vi.advanceTimersByTimeAsync(600_000);

    const repair = bob.resync().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await repair).toBeInstanceOf(TransportSendError);
    expect(bob.hasUndistributedChanges).toBe(true);
  });

  it("keeps the mark until every part of a repair too large for one message has gone out (SND-8)", async () => {
    const port = new FlakySendPort();
    port.limitTo(600);
    const slow = { syncPolicy: { minIntervalMs: 1000 } };
    const { alice, bob } = await pair(port, slow, slow, () => {});
    // At one message a second, bob's join request and alice's answer each wait for the floor.
    for (let tick = 0; tick < 10 && !bob.mayEdit; tick += 1) {
      await vi.advanceTimersByTimeAsync(1000);
      await alice.sync();
      await bob.sync();
    }
    expect(bob.mayEdit).toBe(true);
    port.failNextSends(new TransportSendError("rejected", "the provider refused it"));
    bob.edit((fragment) => insertPlainText(fragment, 0, "x".repeat(3000)));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(bob.hasUndistributedChanges).toBe(true);

    let repaired = false;
    const repair = bob.resync().then(() => {
      repaired = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(bob.sendStatus.partsQueued).toBeGreaterThan(1);
    // One part a second: while any is still queued, the others do not have the change.
    while (!repaired) {
      expect(bob.hasUndistributedChanges).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
    }
    await repair;
    expect(bob.sendStatus.partsQueued).toBe(0);
    expect(bob.hasUndistributedChanges).toBe(false);
    await alice.sync();
    expect(getPlainText(alice.fragment)).toBe("x".repeat(3000));
  });

  it("keeps the mark when a middle part of the repair is refused for good (SND-8)", async () => {
    const port = new FlakySendPort();
    port.limitTo(600);
    const { bob } = await pair(port, {}, {}, () => {});
    port.failNextSends(new TransportSendError("rejected", "no"));
    bob.edit((fragment) => insertPlainText(fragment, 0, "x".repeat(3000)));
    await vi.advanceTimersByTimeAsync(600_000);

    const refusal = new TransportSendError("rejected", "not this part");
    port.failNextSends(undefined, refusal); // the first part goes out, the second is refused
    const repair = bob.resync().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(await repair).toBe(refusal);
    expect(bob.hasUndistributedChanges).toBe(true);
    expect(bob.sendStatus.partsQueued).toBe(0); // the rest of a refused message is not sent
  });

  it("blames the transport profile for a too-large refusal within its own declared maxBytes", async () => {
    const port = new FlakySendPort();
    port.limitTo(4096);
    const errors: unknown[] = [];
    const { bob } = await pair(port, {}, {}, (error) => errors.push(error));
    const refusal = new TransportSendError("too-large", "message exceeds 1000 bytes");
    port.failNextSends(refusal);

    bob.edit((fragment) => insertPlainText(fragment, 0, "small"));
    await vi.advanceTimersByTimeAsync(600_000);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(TransportProfileError);
    expect((errors[0] as Error).cause).toBe(refusal);
    expect(bob.hasUndistributedChanges).toBe(true);
  });

  it("reports every change of the send status to onSendStatusChange", async () => {
    const port = new FlakySendPort();
    const seen: string[] = [];
    const { bob } = await pair(
      port,
      {},
      { onSendStatusChange: (status) => seen.push(status.state) },
    );
    port.failNextSends(new Error("down"));

    bob.edit((fragment) => insertPlainText(fragment, 0, "x"));
    expect(seen.at(-1)).toBe("waiting");
    await vi.advanceTimersByTimeAsync(500);
    expect(seen.at(-1)).toBe("retrying");
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen.at(-1)).toBe("idle");
  });

  it("flush() rejects when the send fails, and a retryable failure stays queued", async () => {
    const port = new FlakySendPort();
    const { alice, bob } = await pair(port);
    port.failNextSends(new Error("down"));

    bob.edit((fragment) => insertPlainText(fragment, 0, "flushed"));
    await expect(bob.flush()).rejects.toThrow("down");
    expect(bob.hasPendingChanges).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    await alice.sync();
    expect(getPlainText(alice.fragment)).toBe("flushed");
  });

  it("dispose() sends one last time and reports a failure, because there is no retry after it", async () => {
    const port = new FlakySendPort();
    const errors: unknown[] = [];
    const { bob } = await pair(port, {}, {}, (error) => errors.push(error));
    port.failNextSends(new Error("down"));

    bob.edit((fragment) => insertPlainText(fragment, 0, "last words"));
    bob.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toHaveLength(1);
    const attempts = port.sendAttempts;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(port.sendAttempts).toBe(attempts);
  });

  describe("syncPolicy", () => {
    it("holds a message back until the floor between messages has passed", async () => {
      const port = new FlakySendPort();
      const { alice, bob } = await pair(port, {}, { syncPolicy: { minIntervalMs: 30_000 } });
      await vi.advanceTimersByTimeAsync(30_000); // the join's resync request used the floor too (SND-2)

      bob.edit((fragment) => insertPlainText(fragment, 0, "one"));
      await vi.advanceTimersByTimeAsync(500);
      await alice.sync();
      expect(getPlainText(alice.fragment)).toBe("one");

      bob.edit((fragment) => insertPlainText(fragment, 3, " two"));
      await vi.advanceTimersByTimeAsync(20_000);
      await alice.sync();
      expect(getPlainText(alice.fragment)).toBe("one"); // the floor still holds it
      expect(bob.sendStatus.state).toBe("waiting");

      await vi.advanceTimersByTimeAsync(10_000); // 30 s after the first message went out
      await alice.sync();
      expect(getPlainText(alice.fragment)).toBe("one two");
    });

    it("counts changed characters: fewer than minChars wait for maxIntervalMs, then go out", async () => {
      const port = new FlakySendPort();
      const { alice, bob } = await pair(
        port,
        {},
        { syncPolicy: { minChars: 5, maxIntervalMs: 60_000 } },
      );

      bob.edit((fragment) => insertPlainText(fragment, 0, "ab"));
      await vi.advanceTimersByTimeAsync(10_000);
      await alice.sync();
      expect(getPlainText(alice.fragment)).toBe(""); // 2 characters < 5, and 10 s < 60 s

      bob.edit((fragment) => insertPlainText(fragment, 2, "cde")); // 5 characters now
      await vi.advanceTimersByTimeAsync(500);
      await alice.sync();
      expect(getPlainText(alice.fragment)).toBe("abcde");
    });

    it("counts a deletion as changed characters too", async () => {
      const port = new FlakySendPort();
      const { alice, bob } = await pair(
        port,
        {},
        { batchWindowMs: 0, syncPolicy: { minChars: 3, maxIntervalMs: 60_000 } },
      );
      bob.edit((fragment) => insertPlainText(fragment, 0, "abc"));
      await alice.sync();
      expect(getPlainText(alice.fragment)).toBe("abc");

      bob.edit((fragment) => deletePlainText(fragment, 0, 2)); // 2 < 3
      await alice.sync();
      expect(getPlainText(alice.fragment)).toBe("abc");
      bob.edit((fragment) => deletePlainText(fragment, 0, 1)); // 3 in all
      await alice.sync();
      expect(getPlainText(alice.fragment)).toBe("");
    });

    it("never counts what it received from someone else as its own changed characters", async () => {
      const port = new FlakySendPort();
      const { alice, bob } = await pair(
        port,
        { batchWindowMs: 0 },
        { syncPolicy: { minChars: 5, maxIntervalMs: 60_000 } },
      );
      alice.edit((fragment) =>
        insertPlainText(fragment, 0, "a hundred characters from alice".repeat(4)),
      );
      await bob.sync(); // 124 remote characters land in bob's document

      bob.edit((fragment) => insertPlainText(fragment, 0, "x")); // ONE local character
      await vi.advanceTimersByTimeAsync(500);
      await alice.sync();
      // If the remote characters had been counted as bob's own, this would already be out.
      expect(getPlainText(alice.fragment)).not.toContain("x");
      expect(bob.sendStatus.state).toBe("waiting");
    });

    describe("the transport's profile", () => {
      /** A transport shaped like the email provider: 30 s suggested, never faster than 15 s. */
      const SLOW_TRANSPORT: TransportProfile = {
        bounds: { minIntervalMs: 15_000, maxBytes: null },
        pacing: {
          minIntervalMs: 30_000,
          maxIntervalMs: 120_000,
          minChars: 0,
          maxChars: null,
          expectedLatencyMs: 60_000,
        },
      };

      it("supplies the policy when nobody chose one, so an email client sends one message per 30 s without being told", async () => {
        const port = new FlakySendPort();
        port.profile = SLOW_TRANSPORT;
        const { alice, bob } = await pair(port);
        expect(bob.syncPolicy.minIntervalMs).toBe(30_000);
        expect(bob.transportProfile).toBe(SLOW_TRANSPORT);
        await vi.advanceTimersByTimeAsync(30_000); // the join's resync request used the floor too (SND-2)
        await alice.sync(); // the creator answers the join — on its own floor
        await vi.advanceTimersByTimeAsync(30_000);
        await bob.sync(); // bootstrapped: bob may edit now (CTL-13)

        bob.edit((fragment) => insertPlainText(fragment, 0, "one"));
        await vi.advanceTimersByTimeAsync(500);
        bob.edit((fragment) => insertPlainText(fragment, 3, " two"));
        await vi.advanceTimersByTimeAsync(29_000);
        await alice.sync();
        expect(getPlainText(alice.fragment)).toBe("one"); // the second waits for its slot
        await vi.advanceTimersByTimeAsync(1000);
        await alice.sync();
        expect(getPlainText(alice.fragment)).toBe("one two");
      });

      it("raises a chosen floor that is below the transport's bound, so no policy can make a client too fast", async () => {
        const port = new FlakySendPort();
        port.profile = SLOW_TRANSPORT;
        const { bob } = await pair(port, {}, { syncPolicy: { minIntervalMs: 0 } });
        expect(bob.syncPolicy.minIntervalMs).toBe(15_000);
      });

      it("takes a policy with no opinion on the floor from the transport, and keeps a chosen value above it", async () => {
        const port = new FlakySendPort();
        port.profile = SLOW_TRANSPORT;
        const { bob } = await pair(port, {}, { syncPolicy: { minIntervalMs: 90_000 } });
        expect(bob.syncPolicy.minIntervalMs).toBe(90_000);
        expect(bob.syncPolicy.maxIntervalMs).toBe(120_000);
      });

      it("applies to the creator as well as to a joiner", async () => {
        const port = new FlakySendPort();
        port.profile = SLOW_TRANSPORT;
        const { alice } = await pair(port);
        expect(alice.syncPolicy.minIntervalMs).toBe(30_000);
      });

      it("leaves the library's defaults for a transport that has nothing to say", async () => {
        const port = new FlakySendPort(); // profile: undefined
        const { bob } = await pair(port);
        expect(bob.syncPolicy.minIntervalMs).toBe(0);
        expect(bob.transportProfile).toBeUndefined();
      });

      it("fails create() and join() when the profile cannot be fetched, instead of quietly sending too fast", async () => {
        const port = new FlakySendPort();
        port.profileFailure = new Error("bridge unreachable");
        await expect(
          DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_ALICE),
        ).rejects.toThrow("bridge unreachable");
        await expect(
          DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, AS_ALICE),
        ).rejects.toThrow("bridge unreachable");
      });
    });

    describe("a change larger than one message", () => {
      const LIMIT = 400;

      /** How many messages each port carried before a test's own actions — the join and its bootstrap. */
      const baselines = new WeakMap<FlakySendPort, number>();

      /** The kinds of the frames sent since `limitedPair` returned. */
      const frameKinds = async (port: FlakySendPort): Promise<string[]> =>
        (await port.inner.receive(DOCUMENT_ID, "alice"))
          .slice(baselines.get(port) ?? 0)
          .map((d) => decodeFrame(d.payload).kind);

      /** Creator and joiner on a transport that carries at most `LIMIT` bytes a message. */
      async function limitedPair(
        aliceOptions: DocumentEngineOptions = {},
        bobOptions: DocumentEngineOptions = {},
        configure: (port: FlakySendPort) => void = () => {},
        onBobError?: (error: unknown, context: string) => void,
      ) {
        const port = new FlakySendPort();
        port.limitTo(LIMIT);
        configure(port);
        const both = await pair(port, aliceOptions, bobOptions, onBobError);
        port.sentSizes.length = 0; // count from here
        baselines.set(port, (await port.inner.receive(DOCUMENT_ID, "alice")).length);
        return { port, ...both };
      }

      it("sends one big paste as parts, none over the limit, and the receiver ends up with all of it", async () => {
        const { port, alice, bob } = await limitedPair();
        const text = "the quick brown fox jumps over the lazy dog ".repeat(120); // ~5 KB in one update
        alice.edit((fragment) => insertPlainText(fragment, 0, text));
        await vi.advanceTimersByTimeAsync(500);
        expect(port.sentSizes.length).toBeGreaterThan(10);
        expect(Math.max(...port.sentSizes)).toBeLessThanOrEqual(LIMIT);
        // Pieces are ordinary edits, each a valid update (SND-17).
        expect((await frameKinds(port)).filter((kind) => kind === "edit").length).toBeGreaterThan(
          10,
        );

        await bob.sync();
        expect(getPlainText(bob.fragment)).toBe(text);
        expect(bob.syncHealth.state).toBe("ok"); // nothing held back
      });

      it("spreads a long typed burst over several ordinary edits, each a usable prefix", async () => {
        const { port, alice, bob } = await limitedPair();
        let typed = "";
        for (let i = 0; i < 300; i += 1) {
          const char = String.fromCharCode(97 + (i % 26));
          alice.edit((fragment) => insertPlainText(fragment, typed.length, char));
          typed += char;
        }
        await vi.advanceTimersByTimeAsync(500);
        expect(port.sentSizes.length).toBeGreaterThan(3);
        expect(Math.max(...port.sentSizes)).toBeLessThanOrEqual(LIMIT);
        expect(new Set(await frameKinds(port))).toEqual(new Set(["edit"]));

        await bob.sync();
        expect(getPlainText(bob.fragment)).toBe(typed);
      });

      it("a change that fits is still one message: nothing is split that need not be", async () => {
        const { port, alice, bob } = await limitedPair();
        alice.edit((fragment) => insertPlainText(fragment, 0, "short"));
        await vi.advanceTimersByTimeAsync(500);
        expect(port.sentSizes).toHaveLength(1);
        await bob.sync();
        expect(getPlainText(bob.fragment)).toBe("short");
      });

      it("keeps what was typed after a big paste behind all of the paste's parts, and everything converges", async () => {
        const { port, alice, bob } = await limitedPair();
        alice.edit((fragment) => insertPlainText(fragment, 0, "x".repeat(3000)));
        alice.edit((fragment) => insertPlainText(fragment, 3000, " and then this"));
        await vi.advanceTimersByTimeAsync(500);
        // Applied in the order sent: every piece of the paste lands before the later edit.
        const sent = await port.inner.receive(DOCUMENT_ID, "alice");
        const replay = new Y.Doc();
        for (const delivery of sent.slice(0, -1)) {
          const frame = decodeFrame(delivery.payload);
          if (frame.kind === "edit") {
            Y.applyUpdate(replay, frame.update);
          }
        }
        expect(replay.getXmlFragment("content").toString()).toContain("x".repeat(3000));
        expect(replay.getXmlFragment("content").toString()).not.toContain("and then this");
        await bob.sync();
        expect(getPlainText(bob.fragment)).toBe(`${"x".repeat(3000)} and then this`);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(bob.syncHealth.state).toBe("ok");
      });

      it("shows the sender how many pieces are left, and the receiver applies each as it arrives, when the floor spaces them", async () => {
        const { alice, bob } = await limitedPair({ syncPolicy: { minIntervalMs: 2_000 } }, {});
        // The answer to bob's join goes out first, itself perhaps in pieces, one per floor.
        for (
          let tick = 0;
          tick < 20 && (alice.hasPendingChanges || alice.sendStatus.partsQueued > 0);
          tick++
        ) {
          await vi.advanceTimersByTimeAsync(2_000);
        }
        await vi.advanceTimersByTimeAsync(2_000);
        await bob.sync();
        alice.edit((fragment) => insertPlainText(fragment, 0, "y".repeat(2000)));
        await vi.advanceTimersByTimeAsync(2_000); // the first piece goes, one floor later
        expect(alice.sendStatus.partsQueued).toBeGreaterThan(3);
        expect(alice.hasPendingChanges).toBe(true);
        const before = alice.sendStatus.partsQueued;
        await bob.sync();
        // A piece is a valid update: what has arrived shows at once (PRF-1).
        const shown = getPlainText(bob.fragment).length;
        expect(shown).toBeGreaterThan(0);
        expect(shown).toBeLessThan(2000);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(alice.sendStatus.partsQueued).toBe(before - 1);
        await vi.advanceTimersByTimeAsync(60_000);
        await bob.sync();
        expect(getPlainText(bob.fragment)).toBe("y".repeat(2000));
        expect(alice.hasPendingChanges).toBe(false);
      });

      it("cuts a full-state answer to a joiner too, so a big document can still be joined", async () => {
        const { port, alice } = await limitedPair({}, {}, (p) => {
          p.noHistory = true;
        });
        alice.edit((fragment) => insertPlainText(fragment, 0, "abcdefghij".repeat(400)));
        await vi.advanceTimersByTimeAsync(2_000); // past the responder's one-answer-a-second throttle
        await alice.sync(); // baseline
        port.sentSizes.length = 0;

        const carol = await DocumentEngine.join(DOCUMENT_ID, "carol", port, undefined, AS_ALICE);
        await alice.sync(); // the creator answers carol's join with the whole document
        await vi.advanceTimersByTimeAsync(0); // its parts go out one after another
        expect(port.sentSizes.length).toBeGreaterThan(5); // in parts
        expect(Math.max(...port.sentSizes)).toBeLessThanOrEqual(LIMIT);
        await carol.sync();
        expect(carol.hasCompletedBootstrap).toBe(true);
        expect(getPlainText(carol.fragment)).toBe("abcdefghij".repeat(400));
      });

      it("a manual resync of a big document goes out in parts as well", async () => {
        const { port, alice, bob } = await limitedPair();
        alice.edit((fragment) => insertPlainText(fragment, 0, "z".repeat(3000)));
        await vi.advanceTimersByTimeAsync(500);
        port.sentSizes.length = 0;
        await alice.resync();
        await vi.advanceTimersByTimeAsync(0);
        expect(port.sentSizes.length).toBeGreaterThan(5);
        expect(Math.max(...port.sentSizes)).toBeLessThanOrEqual(LIMIT);
        await bob.sync();
        expect(getPlainText(bob.fragment)).toBe("z".repeat(3000));
      });

      it("a piece that is lost is a gap like any lost message, noticed and healed by the state a peer sends back", async () => {
        const WATCHED = { syncPolicy: { maxIntervalMs: 20_000, expectedLatencyMs: 5_000 } };
        const { port, alice, bob } = await limitedPair(WATCHED, WATCHED);
        // Bob types a big paste; one of its pieces is lost on the way.
        bob.edit((fragment) => insertPlainText(fragment, 0, "w".repeat(2000)));
        let bobsEdits = 0;
        const original = port.send.bind(port);
        port.send = async (documentId, sender, payload) => {
          if (sender === "bob" && decodeFrame(payload).kind === "edit" && ++bobsEdits === 2) {
            return "lost"; // accepted, and never delivered
          }
          return original(documentId, sender, payload);
        };
        await vi.advanceTimersByTimeAsync(500);
        await alice.sync();
        // The first piece applies; the ones after the lost one wait for it (PRF-1, item 1).
        const shown = getPlainText(alice.fragment).length;
        expect(shown).toBeGreaterThan(0);
        expect(shown).toBeLessThan(2000);

        await vi.advanceTimersByTimeAsync(5_000); // a latency: the gap is believed
        await alice.sync();
        expect(alice.syncHealth.suspicions).toEqual(
          expect.arrayContaining([expect.objectContaining({ kind: "pending-gap", sender: "bob" })]),
        );
        await vi.advanceTimersByTimeAsync(20_000);
        await alice.sync(); // she asks by herself: a peer answers the creator
        await bob.sync(); // bob answers with what she lacks, itself in pieces
        await vi.advanceTimersByTimeAsync(0);
        await alice.sync();
        expect(getPlainText(alice.fragment)).toBe("w".repeat(2000));
        await vi.advanceTimersByTimeAsync(30_000);
        await alice.sync();
        await bob.sync();
        await alice.sync();
        expect(alice.syncHealth.state).toBe("ok");
      });

      it("cannot cut anything when the limit leaves no room for a part: the change is dropped and reported once, and the client carries on", async () => {
        const errors: unknown[] = [];
        const tiny = new FlakySendPort();
        // The transport says 20 bytes but does not enforce it until the client exists, so the
        // document can be created; a fragment's own header is 25 bytes, so nothing can be cut.
        tiny.profile = {
          bounds: { minIntervalMs: null, maxBytes: 20 },
          pacing: {
            minIntervalMs: 0,
            maxIntervalMs: null,
            minChars: 0,
            maxChars: null,
            expectedLatencyMs: 0,
          },
        };
        const solo = await DocumentEngine.create(
          DOCUMENT_ID,
          "solo",
          tiny,
          (error) => errors.push(error),
          { creatorMemberId: "solo" },
        );
        solo.edit((fragment) => insertPlainText(fragment, 0, "no room"));
        await vi.advanceTimersByTimeAsync(500);
        expect(
          errors.filter((e) => e instanceof Error && e.name === "PieceTooSmallError"),
        ).toHaveLength(1);
        expect(solo.hasPendingChanges).toBe(false);
        expect(getPlainText(solo.fragment)).toBe("no room"); // still applied locally
      });

      it("drops and reports an indivisible unit larger than a message, and marks the change undistributed (SND-19)", async () => {
        const errors: unknown[] = [];
        const port = new FlakySendPort();
        port.limitTo(LIMIT);
        const creator = await DocumentEngine.create(
          DOCUMENT_ID,
          "alice",
          port,
          (error) => errors.push(error),
          AS_ALICE,
        );
        creator.document.getArray("com.example.files/1").insert(0, [new Uint8Array(LIMIT * 2)]);
        await vi.advanceTimersByTimeAsync(500);
        expect(errors.filter((e) => e instanceof UnsplittableUpdateError)).toHaveLength(1);
        expect(creator.hasUndistributedChanges).toBe(true);
        expect(creator.hasPendingChanges).toBe(false);
      });

      it("a client on a transport that states no limit never splits anything", async () => {
        const port = new FlakySendPort();
        const { alice, bob } = await pair(port);
        const before = (await port.inner.receive(DOCUMENT_ID, "alice")).length;
        alice.edit((fragment) => insertPlainText(fragment, 0, "q".repeat(20_000)));
        await vi.advanceTimersByTimeAsync(500);
        expect((await port.inner.receive(DOCUMENT_ID, "alice")).length - before).toBe(1);
        await bob.sync();
        expect(getPlainText(bob.fragment)).toBe("q".repeat(20_000));
      });

      it("reports a frame for another document and one of another version with their named reasons (FRM-7)", async () => {
        const errors: unknown[] = [];
        const port = new FlakySendPort();
        const { bob } = await pair(port, {}, {}, (error) => errors.push(error));
        await port.inner.send(
          DOCUMENT_ID,
          "mallory",
          encodeEditFrame("some-other-document", new Uint8Array([0])),
        );
        await port.inner.send(
          DOCUMENT_ID,
          "mallory",
          `{"tdsp":2,"kind":"edit","documentId":"${DOCUMENT_ID}","update":"AA=="}`,
        );
        await bob.sync();
        const reasons = errors.map((e) => (e instanceof FrameDecodeError ? e.reason : String(e)));
        expect(reasons).toEqual(["document-mismatch", "unsupported-version"]);
      });
    });

    describe("the heartbeat and noticing a loss", () => {
      // 20 s longest wait, 5 s to arrive: a heartbeat 20 s after the last message, a gap
      // believed after 5 s, a silent sender after 25 s.
      const WATCHED = { syncPolicy: { maxIntervalMs: 20_000, expectedLatencyMs: 5_000 } };

      const heartbeatsFrom = async (port: FlakySendPort, sender: string) =>
        (await port.inner.receive(DOCUMENT_ID, "alice"))
          .filter((d) => d.sender === sender && decodeFrame(d.payload).kind === "heartbeat")
          .map((d) => decodeFrame(d.payload));

      it("is sent once, maxIntervalMs after the last message, carrying the sender's state vector", async () => {
        const port = new FlakySendPort();
        const { bob } = await pair(port, WATCHED, WATCHED);
        bob.edit((fragment) => insertPlainText(fragment, 0, "hello"));
        await vi.advanceTimersByTimeAsync(500); // the edit goes out
        expect(await heartbeatsFrom(port, "bob")).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(19_999);
        expect(await heartbeatsFrom(port, "bob")).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1); // 20 s after the edit went out
        const [heartbeat] = await heartbeatsFrom(port, "bob");
        expect(heartbeat).toMatchObject({ kind: "heartbeat", control: null });
        // ...and it is the state vector of what bob holds.
        expect(heartbeat && "stateVector" in heartbeat ? heartbeat.stateVector : null).toEqual(
          encodeStateVector(bob.document),
        );
      });

      it("is not repeated: after the one, nothing until the sender sends something else", async () => {
        const port = new FlakySendPort();
        const { bob } = await pair(port, WATCHED, WATCHED);
        bob.edit((fragment) => insertPlainText(fragment, 0, "hello"));
        await vi.advanceTimersByTimeAsync(500 + 20_000);
        expect(await heartbeatsFrom(port, "bob")).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(24 * 3_600_000);
        expect(await heartbeatsFrom(port, "bob")).toHaveLength(1);

        bob.edit((fragment) => insertPlainText(fragment, 5, " again"));
        await vi.advanceTimersByTimeAsync(500 + 20_000);
        expect(await heartbeatsFrom(port, "bob")).toHaveLength(2); // a new burst, a new heartbeat
      });

      it("waits for a new edit: typing again before it is due moves it back", async () => {
        const port = new FlakySendPort();
        const { bob } = await pair(port, WATCHED, WATCHED);
        bob.edit((fragment) => insertPlainText(fragment, 0, "a"));
        await vi.advanceTimersByTimeAsync(500 + 15_000);
        bob.edit((fragment) => insertPlainText(fragment, 1, "b")); // 5 s before the first would fire
        await vi.advanceTimersByTimeAsync(500 + 15_000); // 30 s after the first message, 15 s after the second
        expect(await heartbeatsFrom(port, "bob")).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(await heartbeatsFrom(port, "bob")).toHaveLength(1);
      });

      it("is not sent at all when the policy has no longest wait: there is nothing to count from", async () => {
        const port = new FlakySendPort();
        const { bob } = await pair(port);
        bob.edit((fragment) => insertPlainText(fragment, 0, "hello"));
        await vi.advanceTimersByTimeAsync(24 * 3_600_000);
        expect(await heartbeatsFrom(port, "bob")).toHaveLength(0);
      });

      it("is not sent while a change is still waiting to go out or being retried", async () => {
        const port = new FlakySendPort();
        const { bob } = await pair(port, WATCHED, WATCHED);
        bob.edit((fragment) => insertPlainText(fragment, 0, "first"));
        await vi.advanceTimersByTimeAsync(500);
        port.failNextSends(...Array.from({ length: 10 }, () => new Error("down")));
        bob.edit((fragment) => insertPlainText(fragment, 5, " second"));
        await vi.advanceTimersByTimeAsync(60_000); // failing all along
        expect(await heartbeatsFrom(port, "bob")).toHaveLength(0);
      });

      it("is still sent after a close, so the close's own loss can be noticed", async () => {
        const port = new FlakySendPort();
        const { alice } = await pair(port, WATCHED, WATCHED);
        alice.edit((fragment) => insertPlainText(fragment, 0, "x"));
        await vi.advanceTimersByTimeAsync(500);
        await alice.closeDocument();
        await vi.advanceTimersByTimeAsync(60_000);
        const heartbeats = await heartbeatsFrom(port, "alice");
        expect(heartbeats.length).toBeGreaterThan(0);
        const last = heartbeats.at(-1);
        expect(last?.kind === "heartbeat" && last.control).toEqual(alice.controlVector);
      });

      it("is still sent after a close refused an edit that was waiting to go out (LIF-6, SND-23)", async () => {
        const port = new FlakySendPort();
        const { alice, bob } = await pair(port, WATCHED, WATCHED);
        await vi.advanceTimersByTimeAsync(60_000); // every heartbeat the join owed has gone out
        bob.edit((fragment) => insertPlainText(fragment, 0, "sent"));
        await vi.advanceTimersByTimeAsync(500); // goes out: a heartbeat is owed
        const before = (await heartbeatsFrom(port, "bob")).length;
        await alice.closeDocument();
        bob.edit((fragment) => insertPlainText(fragment, 4, " held")); // waits for the quiet time
        await bob.sync(); // the close arrives first
        await vi.advanceTimersByTimeAsync(500); // the waiting edit is refused (CTL-13) and dropped
        await vi.advanceTimersByTimeAsync(60_000);
        expect((await heartbeatsFrom(port, "bob")).length).toBe(before + 1);
      });

      it("a lost FINAL message is noticed from the heartbeat — the case no gap ever shows", async () => {
        const port = new FlakySendPort();
        const { alice, bob } = await pair(port, WATCHED, WATCHED);
        bob.edit((fragment) => insertPlainText(fragment, 0, "all of this arrives"));
        await vi.advanceTimersByTimeAsync(500);
        await alice.sync();
        bob.edit((fragment) => insertPlainText(fragment, 19, " but this last part is lost"));
        port.inner.dropNextSend("bob");
        await vi.advanceTimersByTimeAsync(500); // sent, and lost
        await vi.advanceTimersByTimeAsync(20_000); // the heartbeat, which does arrive
        await alice.sync();

        expect(getPlainText(alice.fragment)).toBe("all of this arrives");
        expect(alice.syncHealth.state).toBe("ok"); // just heard it: a late message would look the same
        await vi.advanceTimersByTimeAsync(4_999);
        expect(alice.syncHealth.state).toBe("ok");
        await vi.advanceTimersByTimeAsync(1);
        expect(alice.syncHealth.suspicions).toEqual([
          expect.objectContaining({ kind: "behind-heartbeat", sender: "bob" }),
        ]);
      });

      it("a lost final message between two devices of one member is noticed from the heartbeat (LOS-4)", async () => {
        const port = new FlakySendPort();
        const { alice, bob } = await pair(port, WATCHED, WATCHED);
        const bobsPhone = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, {
          ...AS_ALICE,
          ...WATCHED,
        });
        await alice.sync(); // answers the phone's join
        await bobsPhone.sync();
        bob.edit((fragment) => insertPlainText(fragment, 0, "all of this arrives"));
        await vi.advanceTimersByTimeAsync(500);
        await bobsPhone.sync();
        bob.edit((fragment) => insertPlainText(fragment, 19, " but this last part is lost"));
        port.inner.dropNextSend("bob");
        await vi.advanceTimersByTimeAsync(500); // sent, and lost
        await vi.advanceTimersByTimeAsync(20_000); // the laptop's heartbeat, which does arrive
        await bobsPhone.sync();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(getPlainText(bobsPhone.fragment)).toBe("all of this arrives");
        expect(bobsPhone.syncHealth.suspicions).toEqual([
          expect.objectContaining({ kind: "behind-heartbeat", sender: "bob" }),
        ]);
      });

      it("a heartbeat of one device that crossed another's edit does not hide that device's silence (LOS-11, LOS-16)", async () => {
        const port = new FlakySendPort();
        const { alice, bob } = await pair(port, WATCHED, WATCHED);
        const bobsPhone = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, {
          ...AS_ALICE,
          ...WATCHED,
        });
        // A third device of bob's watches as well: its own member's devices count like anyone's.
        const bobsTablet = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, {
          ...AS_ALICE,
          ...WATCHED,
        });
        // Alice answers the joins, one a second (RSY-9).
        for (let tick = 0; tick < 10 && !(bobsPhone.mayEdit && bobsTablet.mayEdit); tick += 1) {
          await vi.advanceTimersByTimeAsync(1_000);
          for (const engine of [alice, bob, bobsPhone, bobsTablet]) {
            await engine.sync();
          }
        }
        expect(bobsPhone.mayEdit && bobsTablet.mayEdit).toBe(true);
        await vi.advanceTimersByTimeAsync(60_000); // every heartbeat the joins owed has gone out
        for (const engine of [alice, bob, bobsPhone, bobsTablet]) {
          await engine.sync();
        }
        expect(alice.syncHealth.suspicions).toEqual([]);
        const heartbeatsBefore = (await heartbeatsFrom(port, "bob")).length;

        bobsPhone.edit((fragment) => insertPlainText(fragment, 0, "phone "));
        await vi.advanceTimersByTimeAsync(1_000);
        // The laptop writes; the phone does not sync, so its heartbeat will not hold this edit.
        bob.edit((fragment) => insertPlainText(fragment, 0, "laptop "));
        await vi.advanceTimersByTimeAsync(19_500); // the phone's heartbeat, owed 20 s after its edit
        expect((await heartbeatsFrom(port, "bob")).length).toBe(heartbeatsBefore + 1);
        port.inner.dropNextSend("bob"); // the laptop's heartbeat, lost
        await vi.advanceTimersByTimeAsync(1_000);
        expect((await heartbeatsFrom(port, "bob")).length).toBe(heartbeatsBefore + 1);
        await alice.sync();
        await bobsTablet.sync();
        expect(getPlainText(alice.fragment)).toContain("laptop");

        // Due 20 s after the watchers heard the laptop's edit, plus 5 s of latency: then its
        // silence is evidence.
        await vi.advanceTimersByTimeAsync(24_999);
        expect(alice.syncHealth.suspicions).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        for (const watcher of [alice, bobsTablet]) {
          expect(watcher.syncHealth.suspicions).toEqual([
            expect.objectContaining({ kind: "sender-overdue", sender: "bob" }),
          ]);
        }
      });

      it("its own edit coming back promises it nothing, also where the echo has another delivery id (LOS-11)", async () => {
        const port = new FlakySendPort();
        // A transport that does not tell the sender the id its message is delivered under: the
        // engine sees its own messages again, and only their content tells them apart.
        const original = port.send.bind(port);
        port.send = async (documentId, sender, payload) =>
          `sent-${await original(documentId, sender, payload)}`;
        const { alice } = await pair(port, WATCHED, WATCHED);
        alice.edit((fragment) => insertPlainText(fragment, 0, "hello"));
        await vi.advanceTimersByTimeAsync(500);
        port.inner.dropNextSend("alice"); // her heartbeat, which would end any expectation
        await vi.advanceTimersByTimeAsync(20_000);
        await alice.sync(); // her own edit comes back
        await vi.advanceTimersByTimeAsync(60_000);
        await alice.sync();
        expect(alice.syncHealth.suspicions.filter((s) => s.sender === "alice")).toEqual([]);
      });

      it("a lost MIDDLE message is noticed as a gap, and names whose", async () => {
        const port = new FlakySendPort();
        const { alice, bob } = await pair(port, WATCHED, WATCHED);
        bob.edit((fragment) => insertPlainText(fragment, 0, "one"));
        await vi.advanceTimersByTimeAsync(500);
        await alice.sync(); // alice learns which client is bob's
        // Sends run at once from here (the quiet time, not the floor, is what holds them).
        bob.edit((fragment) => insertPlainText(fragment, 3, " two"));
        port.inner.dropNextSend("bob");
        await vi.advanceTimersByTimeAsync(500);
        bob.edit((fragment) => insertPlainText(fragment, 7, " three"));
        await vi.advanceTimersByTimeAsync(500);
        await alice.sync();

        expect(getPlainText(alice.fragment)).toBe("one"); // "three" waits for "two"
        expect(alice.syncHealth.state).toBe("ok"); // not yet: it may be late
        await vi.advanceTimersByTimeAsync(5_000);
        await alice.sync();
        expect(alice.syncHealth.suspicions).toEqual([
          expect.objectContaining({ kind: "pending-gap", sender: "bob" }),
        ]);
      });

      it("a message that is merely late never raises a suspicion", async () => {
        const port = new FlakySendPort();
        const { alice, bob } = await pair(port, WATCHED, WATCHED);
        bob.edit((fragment) => insertPlainText(fragment, 0, "one"));
        await vi.advanceTimersByTimeAsync(500);
        await alice.sync();
        bob.edit((fragment) => insertPlainText(fragment, 3, " two"));
        port.inner.holdNextSend("bob"); // delayed, not dropped
        await vi.advanceTimersByTimeAsync(500);
        bob.edit((fragment) => insertPlainText(fragment, 7, " three"));
        await vi.advanceTimersByTimeAsync(500);
        await alice.sync();
        await vi.advanceTimersByTimeAsync(4_000); // under the 5 s a message is expected to take
        await alice.sync();
        expect(alice.syncHealth.state).toBe("ok");
        port.inner.releaseHeld(DOCUMENT_ID);
        await alice.sync();
        expect(getPlainText(alice.fragment)).toBe("one two three");
        await vi.advanceTimersByTimeAsync(60_000); // bob's heartbeat came and went...
        await alice.sync(); // ...and alice, polling as a page does, heard it
        expect(alice.syncHealth.state).toBe("ok");
      });

      it("a sender that goes silent when a follow-up is due is reported, softly", async () => {
        const port = new FlakySendPort();
        const { alice, bob } = await pair(port, WATCHED, WATCHED);
        bob.edit((fragment) => insertPlainText(fragment, 0, "hello"));
        await vi.advanceTimersByTimeAsync(500);
        port.inner.dropNextSend("bob"); // bob's one heartbeat is lost
        await alice.sync();
        expect(alice.syncHealth.state).toBe("ok");
        await vi.advanceTimersByTimeAsync(20_000 + 5_000 - 1);
        expect(alice.syncHealth.state).toBe("ok");
        await vi.advanceTimersByTimeAsync(1);
        expect(alice.syncHealth.suspicions).toEqual([
          expect.objectContaining({ kind: "sender-overdue", sender: "bob" }),
        ]);
      });

      it("a sender whose heartbeat arrived is never reported for its silence afterwards", async () => {
        const port = new FlakySendPort();
        const { alice, bob } = await pair(port, WATCHED, WATCHED);
        bob.edit((fragment) => insertPlainText(fragment, 0, "hello"));
        await vi.advanceTimersByTimeAsync(500 + 20_000);
        await alice.sync();
        await vi.advanceTimersByTimeAsync(24 * 3_600_000);
        expect(alice.syncHealth.state).toBe("ok");
      });

      it("the creator's heartbeat makes even its last control message checkable", async () => {
        const port = new FlakySendPort();
        const { alice, bob } = await pair(port, WATCHED, WATCHED);
        port.inner.dropNextSend("alice"); // the membership change is lost
        await alice.setMembership("carol", "read");
        await vi.advanceTimersByTimeAsync(20_000); // alice's heartbeat carries her control vector
        await bob.sync();
        expect(bob.permissionOf("carol")).toBeUndefined(); // bob never saw it
        expect(bob.syncHealth.state).toBe("ok");
        await vi.advanceTimersByTimeAsync(5_000);
        expect(bob.syncHealth.suspicions).toEqual([
          expect.objectContaining({ kind: "control-behind" }),
        ]);
      });

      it("a sender's silence is forgiven once a resync has handed the state over, so it is not reported for ever", async () => {
        const port = new FlakySendPort();
        const { alice, bob } = await pair(port, WATCHED, WATCHED);
        bob.edit((fragment) => insertPlainText(fragment, 0, "hello"));
        await vi.advanceTimersByTimeAsync(500);
        await alice.sync();
        bob.edit((fragment) => insertPlainText(fragment, 5, " world"));
        port.inner.dropNextSend("bob"); // the second edit is lost...
        await vi.advanceTimersByTimeAsync(500);
        port.inner.dropNextSend("bob"); // ...and so is the one heartbeat that would have revealed it
        await vi.advanceTimersByTimeAsync(25_000);
        expect(alice.syncHealth.suspicions).toEqual([
          expect.objectContaining({ kind: "sender-overdue", sender: "bob" }),
        ]);

        await alice.requestResync(); // the creator asks; a peer may answer the creator
        await bob.sync(); // bob holds what alice lacks, so he answers
        await alice.sync();
        expect(getPlainText(alice.fragment)).toBe("hello world");
        expect(alice.syncHealth.state).toBe("ok");
        await vi.advanceTimersByTimeAsync(60_000); // the state has been handed over: bob's silence is not news
        expect(alice.syncHealth.state).toBe("ok");
      });

      describe("asking for help: one request at a time", () => {
        const requestsSeen = async (port: FlakySendPort) =>
          (await port.inner.receive(DOCUMENT_ID, "alice")).filter(
            (d) => decodeFrame(d.payload).kind === "resync-request",
          ).length;

        it("coalesces repeated requests into the one that is outstanding: clicking again costs nothing", async () => {
          const port = new FlakySendPort();
          const { alice, bob } = await pair(port, WATCHED, WATCHED);
          await alice.sync();
          await bob.sync(); // the join is answered, so bob's slot is free
          const before = await requestsSeen(port);

          expect(await bob.requestResync()).toEqual({ sent: true });
          for (let click = 0; click < 4; click += 1) {
            expect(await bob.requestResync()).toEqual({ sent: false, reason: "in-flight" });
          }
          expect(await requestsSeen(port)).toBe(before + 1);
          expect(bob.syncHealth.resync).toMatchObject({ state: "requested", automatic: false });
        });

        it("frees the slot on an answer, and reports that nobody answered when the request expires", async () => {
          const port = new FlakySendPort();
          const { alice, bob } = await pair(port, WATCHED, WATCHED);
          await bob.requestResync(); // nothing new for the creator to give, so nobody will answer
          await alice.sync();
          await bob.sync();
          expect(bob.syncHealth.resync.state).toBe("requested");
          await vi.advanceTimersByTimeAsync(10_000); // the expiry: a floor of 10 s, or 2 latencies
          expect(bob.syncHealth.resync).toMatchObject({ state: "idle", lastOutcome: "unanswered" });
          expect(await bob.requestResync()).toEqual({ sent: true }); // and may ask again
        });

        it("holds a rate floor between requests, the floor between messages", async () => {
          const port = new FlakySendPort();
          const { alice, bob } = await pair(
            port,
            {},
            { syncPolicy: { minIntervalMs: 30_000, maxIntervalMs: 60_000 } },
          );
          await alice.sync();
          await bob.sync(); // answered: the slot is free, the floor is not
          expect(await bob.requestResync()).toEqual({ sent: false, reason: "rate-floor" });
          await vi.advanceTimersByTimeAsync(30_000);
          expect(await bob.requestResync()).toEqual({ sent: true });
        });

        it("keeps the floor after an edit too: a request right after a message waits for it (SND-2, RSY-3)", async () => {
          const port = new FlakySendPort();
          const POLICY = { syncPolicy: { minIntervalMs: 30_000, maxIntervalMs: 60_000 } };
          const { alice, bob } = await pair(port, {}, POLICY);
          await alice.sync();
          await bob.sync();
          await vi.advanceTimersByTimeAsync(30_000); // the join request's floor has passed
          bob.edit((fragment) => insertPlainText(fragment, 0, "x"));
          await vi.advanceTimersByTimeAsync(500); // the edit goes out
          expect(await bob.requestResync()).toEqual({ sent: false, reason: "rate-floor" });
          await vi.advanceTimersByTimeAsync(30_000);
          expect(await bob.requestResync()).toEqual({ sent: true });
        });

        it("counts a request against the floor: an edit right after it waits (SND-2)", async () => {
          const port = new FlakySendPort();
          const POLICY = { syncPolicy: { minIntervalMs: 30_000, maxIntervalMs: 60_000 } };
          const { alice, bob } = await pair(port, {}, POLICY);
          await alice.sync();
          await bob.sync();
          await vi.advanceTimersByTimeAsync(30_000);
          expect(await bob.requestResync()).toEqual({ sent: true });
          const edits = async () =>
            (await port.inner.receive(DOCUMENT_ID, "alice")).filter(
              (d) => d.sender === "bob" && decodeFrame(d.payload).kind === "edit",
            ).length;
          bob.edit((fragment) => insertPlainText(fragment, 0, "x"));
          await vi.advanceTimersByTimeAsync(29_000);
          expect(await edits()).toBe(0); // inside the request's floor
          await vi.advanceTimersByTimeAsync(1_000);
          expect(await edits()).toBe(1);
        });

        it("the creator's answer to a join waits for the floor after its last message (RSY-11)", async () => {
          const port = new FlakySendPort();
          const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, {
            ...AS_ALICE,
            syncPolicy: { minIntervalMs: 30_000 },
          }); // the seed goes out at once
          const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, AS_ALICE);
          await alice.sync(); // the answer is queued behind the seed's floor
          await bob.sync();
          expect(bob.hasCompletedBootstrap).toBe(false);
          await vi.advanceTimersByTimeAsync(30_000);
          await bob.sync();
          expect(bob.hasCompletedBootstrap).toBe(true);
        });

        it("a control message waits for the floor after the creator's last message (SND-2)", async () => {
          const port = new FlakySendPort();
          const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, {
            ...AS_ALICE,
            syncPolicy: { minIntervalMs: 30_000 },
          });
          const controls = async () =>
            (await port.inner.receive(DOCUMENT_ID, "alice")).filter(
              (d) => decodeFrame(d.payload).kind === "control",
            ).length;
          const grant = alice.setMembership("bob", "write");
          await vi.advanceTimersByTimeAsync(29_999);
          expect(await controls()).toBe(0);
          await vi.advanceTimersByTimeAsync(1);
          await grant;
          expect(await controls()).toBe(1);
          expect(alice.permissionOf("bob")).toBe("write");
        });

        it("the seed counts against the floor: the creator's first edit waits for it (SND-2)", async () => {
          const port = new FlakySendPort();
          const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, {
            ...AS_ALICE,
            syncPolicy: { minIntervalMs: 30_000 },
          });
          const edits = async () =>
            (await port.inner.receive(DOCUMENT_ID, "alice")).filter(
              (d) => decodeFrame(d.payload).kind === "edit",
            ).length;
          alice.edit((fragment) => insertPlainText(fragment, 0, "x"));
          await vi.advanceTimersByTimeAsync(29_999);
          expect(await edits()).toBe(1); // the seed only
          await vi.advanceTimersByTimeAsync(1);
          expect(await edits()).toBe(2);
        });

        it("a resync request arms no heartbeat: asking is not a message anyone waits for a follow-up to", async () => {
          const port = new FlakySendPort();
          const { alice, bob } = await pair(port, WATCHED, WATCHED);
          await alice.sync();
          await bob.sync();
          await vi.advanceTimersByTimeAsync(10_000);
          expect(await bob.requestResync()).toEqual({ sent: true });
          await vi.advanceTimersByTimeAsync(24 * 3_600_000);
          const heartbeats = (await port.inner.receive(DOCUMENT_ID, "alice")).filter(
            (d) => d.sender === "bob" && decodeFrame(d.payload).kind === "heartbeat",
          );
          expect(heartbeats).toHaveLength(0);
        });

        it("a joiner's request alone makes no bystander suspect it went quiet, and starts no cascade of requests (LOS-11)", async () => {
          const port = new FlakySendPort();
          const { alice, bob } = await pair(port, WATCHED, WATCHED);
          await vi.advanceTimersByTimeAsync(120_000);
          await alice.sync();
          await bob.sync();
          const before = await requestsSeen(port);
          const carol = await DocumentEngine.join(DOCUMENT_ID, "carol", port, undefined, {
            ...AS_ALICE,
            ...WATCHED,
          });
          await alice.sync(); // answers carol
          await carol.sync();
          for (let tick = 0; tick < 24; tick += 1) {
            await vi.advanceTimersByTimeAsync(5_000);
            await alice.sync();
            await bob.sync();
            await carol.sync();
          }
          expect(bob.syncHealth.suspicions).toEqual([]);
          expect(alice.syncHealth.suspicions).toEqual([]);
          expect(await requestsSeen(port)).toBe(before + 1); // carol's, and nobody else's
        });

        it("gives the slot back when the request could not be sent", async () => {
          const port = new FlakySendPort();
          const { alice, bob } = await pair(port, WATCHED, WATCHED);
          await alice.sync();
          await bob.sync();
          port.inner.disconnect("bob");
          await expect(bob.requestResync()).rejects.toThrow("disconnected");
          port.inner.reconnect("bob");
          const again = bob.requestResync(); // the slot is free; the send waits out the back-off (SND-7)
          await vi.advanceTimersByTimeAsync(1_000);
          expect(await again).toEqual({ sent: true });
        });

        it("a joiner nobody has answered asks again by itself, waiting longer each time, and stops when answered", async () => {
          const port = new FlakySendPort();
          const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, {
            ...AS_ALICE,
            ...WATCHED,
          });
          const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, {
            ...AS_ALICE,
            ...WATCHED,
          });
          const asks: number[] = [];
          const poll = async (ms: number) => {
            await vi.advanceTimersByTimeAsync(ms);
            await bob.sync();
            asks.push(await requestsSeen(port));
          };
          expect(await requestsSeen(port)).toBe(1); // the join's own
          await poll(9_999);
          expect(asks.at(-1)).toBe(1);
          await poll(1); // one expiry (10 s) after the join
          expect(asks.at(-1)).toBe(2);
          await poll(19_999);
          expect(asks.at(-1)).toBe(2);
          await poll(1); // two expiries after that one
          expect(asks.at(-1)).toBe(3);
          expect(bob.syncHealth.resync.automatic).toBe(true);

          await alice.sync(); // the creator finally comes online and answers
          await bob.sync();
          expect(bob.hasCompletedBootstrap).toBe(true);
          const askedInTotal = await requestsSeen(port);
          await vi.advanceTimersByTimeAsync(24 * 3_600_000);
          await bob.sync();
          expect(await requestsSeen(port)).toBe(askedInTotal); // answered: it stops asking
        });

        it("gives up asking by itself after a few tries, leaving it to a person", async () => {
          const port = new FlakySendPort();
          await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, {
            ...AS_ALICE,
            ...WATCHED,
          });
          const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, {
            ...AS_ALICE,
            ...WATCHED,
          });
          for (let hour = 0; hour < 48; hour += 1) {
            await vi.advanceTimersByTimeAsync(3_600_000);
            await bob.sync();
          }
          expect(await requestsSeen(port)).toBe(1 + 5); // the join's own, and five retries
          expect(await bob.requestResync()).toEqual({ sent: true }); // a person still can
        });

        it("asks a bounded number of times when every request is refused for good, and reports none as a lost change (RSY-5, SND-10)", async () => {
          const port = new FlakySendPort();
          await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, {
            ...AS_ALICE,
            ...WATCHED,
          });
          let attempts = 0;
          const send = port.send.bind(port);
          port.send = async (documentId, sender, payload) => {
            if (sender === "bob" && decodeFrame(payload).kind === "resync-request") {
              attempts += 1;
              throw new TransportSendError("rejected", "bob may not post here");
            }
            return send(documentId, sender, payload);
          };
          const errors: unknown[] = [];
          const bob = await DocumentEngine.join(
            DOCUMENT_ID,
            "bob",
            port,
            (error) => errors.push(error),
            {
              ...AS_ALICE,
              ...WATCHED,
            },
          );
          for (let minute = 0; minute < 48 * 60; minute += 1) {
            await vi.advanceTimersByTimeAsync(60_000);
            await bob.sync();
          }
          expect(attempts).toBe(1 + 5); // the join's own, and five automatic ones
          expect(errors).toEqual([]);
          // No error, but not invisible either: the request's outcome says it (SND-10, RSY-4).
          expect(bob.syncHealth.resync).toMatchObject({ state: "idle", lastOutcome: "failed" });
        });

        it("asks again after a request that could not go out for now, without spending an attempt (LOS-6, SND-7)", async () => {
          const port = new FlakySendPort();
          const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, {
            ...AS_ALICE,
            ...WATCHED,
          });
          const errors: unknown[] = [];
          port.inner.disconnect("bob"); // bob's messenger is not reachable when he joins
          const bob = await DocumentEngine.join(
            DOCUMENT_ID,
            "bob",
            port,
            (error) => errors.push(error),
            {
              ...AS_ALICE,
              ...WATCHED,
            },
          );
          await vi.advanceTimersByTimeAsync(30_000);
          await bob.sync(); // fails: still disconnected
          port.inner.reconnect("bob");
          for (let second = 0; second < 30 && !bob.hasCompletedBootstrap; second += 1) {
            await vi.advanceTimersByTimeAsync(1_000);
            await bob.sync();
            await alice.sync();
          }
          expect(bob.hasCompletedBootstrap).toBe(true);
          expect(errors).toEqual([]); // a request that could not go out is no lost change (SND-10)
        });

        it("asks by itself for a lost middle message, after a conservative wait, and is healed", async () => {
          const port = new FlakySendPort();
          const { alice, bob } = await pair(port, WATCHED, WATCHED);
          await alice.sync();
          await bob.sync();
          alice.edit((fragment) => insertPlainText(fragment, 0, "one"));
          await vi.advanceTimersByTimeAsync(500);
          await bob.sync();
          alice.edit((fragment) => insertPlainText(fragment, 3, " two"));
          port.inner.dropNextSend("alice");
          await vi.advanceTimersByTimeAsync(500);
          alice.edit((fragment) => insertPlainText(fragment, 7, " three"));
          await vi.advanceTimersByTimeAsync(500);
          await bob.sync(); // the gap is first seen here
          const before = await requestsSeen(port);

          await vi.advanceTimersByTimeAsync(5_000);
          await bob.sync();
          expect(bob.syncHealth.state).toBe("suspected"); // reported after one latency...
          expect(await requestsSeen(port)).toBe(before); // ...but not yet acted on
          await vi.advanceTimersByTimeAsync(5_000);
          await bob.sync(); // two latencies: the client asks
          expect(await requestsSeen(port)).toBe(before + 1);
          expect(bob.syncHealth.resync).toMatchObject({ state: "requested", automatic: true });

          await alice.sync(); // the creator answers
          await bob.sync();
          expect(getPlainText(bob.fragment)).toBe("one two three");
          expect(bob.syncHealth.state).toBe("ok");
        });

        it("asks a bounded number of times per episode, with a doubling wait, when nobody can help", async () => {
          const port = new FlakySendPort();
          const { alice, bob } = await pair(port, WATCHED, WATCHED);
          await alice.sync();
          await bob.sync();
          alice.edit((fragment) => insertPlainText(fragment, 0, "one"));
          await vi.advanceTimersByTimeAsync(500);
          await bob.sync();
          alice.edit((fragment) => insertPlainText(fragment, 3, " two"));
          port.inner.dropNextSend("alice");
          await vi.advanceTimersByTimeAsync(500);
          alice.edit((fragment) => insertPlainText(fragment, 7, " three"));
          await vi.advanceTimersByTimeAsync(500);
          await bob.sync();
          const before = await requestsSeen(port);
          // alice never syncs again, so nobody answers
          for (let minute = 0; minute < 120; minute += 1) {
            await vi.advanceTimersByTimeAsync(60_000);
            await bob.sync();
          }
          expect(await requestsSeen(port)).toBe(before + 3); // three, then only a person can ask
        });

        it("asks by itself while it keeps writing: a request the floor holds back waits, and is not spent (LOS-6, RSY-3)", async () => {
          const port = new FlakySendPort();
          // A floor of 10 s, and bob types all along: whenever the client looks, it has sent a
          // message less than a floor ago.
          const paced = {
            syncPolicy: { minIntervalMs: 10_000, maxIntervalMs: 30_000, expectedLatencyMs: 2_000 },
          };
          const { alice, bob } = await pair(port, paced, paced);
          const tick = async (seconds: number, bobTypes: boolean) => {
            for (let second = 0; second < seconds; second += 1) {
              if (bobTypes) bob.edit((fragment) => insertPlainText(fragment, 0, "b"));
              await vi.advanceTimersByTimeAsync(1_000);
              await alice.sync();
              await bob.sync();
            }
          };
          await tick(60, false);
          port.inner.dropNextSend("alice");
          alice.edit((fragment) => insertPlainText(fragment, 0, "lost "));
          await tick(15, false);
          alice.edit((fragment) => insertPlainText(fragment, 0, "late "));
          const before = await requestsSeen(port);
          await tick(120, true);
          expect(await requestsSeen(port)).toBeGreaterThan(before);
          expect(getPlainText(bob.fragment)).toContain("lost ");
          expect(bob.syncHealth.suspicions).toEqual([]);
        });

        /** A gap nobody can heal: alice sends three edits, the middle one is lost, and she never syncs again. */
        async function unhealableGap(
          port: FlakySendPort,
          alice: DocumentEngine,
          bob: DocumentEngine,
        ) {
          await alice.sync();
          await bob.sync();
          alice.edit((fragment) => insertPlainText(fragment, 0, "one"));
          await vi.advanceTimersByTimeAsync(500);
          await bob.sync();
          alice.edit((fragment) => insertPlainText(fragment, 3, " two"));
          port.inner.dropNextSend("alice");
          await vi.advanceTimersByTimeAsync(500);
          alice.edit((fragment) => insertPlainText(fragment, 7, " three"));
          await vi.advanceTimersByTimeAsync(500);
          await bob.sync();
        }

        it("spaces its attempts by a doubling wait, not just by the request's own expiry", async () => {
          const port = new FlakySendPort();
          const { alice, bob } = await pair(port, WATCHED, WATCHED);
          await unhealableGap(port, alice, bob);
          const first = await requestsSeen(port);
          const times: number[] = [];
          let seen = first;
          const start = Date.now();
          for (let second = 0; second < 300; second += 1) {
            await vi.advanceTimersByTimeAsync(1_000);
            await bob.sync();
            const now = await requestsSeen(port);
            if (now > seen) {
              times.push(Date.now() - start);
              seen = now;
            }
          }
          expect(times).toHaveLength(3);
          // The first is due at two latencies; each later one waits twice as long as the one before it.
          expect((times[1] as number) - (times[0] as number)).toBeGreaterThanOrEqual(20_000);
          expect((times[2] as number) - (times[1] as number)).toBeGreaterThanOrEqual(40_000);
        });

        it("starts a fresh episode with a fresh allowance once the evidence has gone", async () => {
          const port = new FlakySendPort();
          const { alice, bob } = await pair(port, WATCHED, WATCHED);
          await unhealableGap(port, alice, bob);
          for (let minute = 0; minute < 30; minute += 1) {
            await vi.advanceTimersByTimeAsync(60_000);
            await bob.sync();
          }
          const spent = await requestsSeen(port);
          await vi.advanceTimersByTimeAsync(60_000);
          await bob.sync();
          expect(await requestsSeen(port)).toBe(spent); // three used, no more by itself

          await bob.requestResync(); // a person asks; the creator is finally there
          await alice.sync();
          await bob.sync();
          expect(bob.syncHealth.state).toBe("ok");
          await bob.sync(); // the poll after the evidence has gone resets the allowance

          // A second, separate loss.
          alice.edit((fragment) => insertPlainText(fragment, 13, " four"));
          await vi.advanceTimersByTimeAsync(500);
          await bob.sync();
          alice.edit((fragment) => insertPlainText(fragment, 18, " five"));
          port.inner.dropNextSend("alice");
          await vi.advanceTimersByTimeAsync(500);
          alice.edit((fragment) => insertPlainText(fragment, 23, " six"));
          await vi.advanceTimersByTimeAsync(500);
          await bob.sync();
          const beforeSecond = await requestsSeen(port);
          await vi.advanceTimersByTimeAsync(10_000);
          await bob.sync();
          expect(await requestsSeen(port)).toBe(beforeSecond + 1); // it asks again by itself
        });

        it("does not spend its allowance while a person's request holds the slot", async () => {
          const port = new FlakySendPort();
          const { alice, bob } = await pair(port, WATCHED, WATCHED);
          await unhealableGap(port, alice, bob);
          await vi.advanceTimersByTimeAsync(5_000);
          await bob.sync();
          await bob.requestResync(); // the person clicks first, and holds the slot for 10 s
          for (let tick = 0; tick < 9; tick += 1) {
            await vi.advanceTimersByTimeAsync(1_000);
            await bob.sync(); // the automatic request is "due" every tick, and must not be counted
          }
          const during = await requestsSeen(port);
          await vi.advanceTimersByTimeAsync(2_000); // the person's request expires unanswered
          await bob.sync();
          // The slot is free and the evidence is old enough, so the client asks at once: the
          // attempts it was "due" for while the person held the slot were not spent.
          expect(await requestsSeen(port)).toBe(during + 1);
        });

        it("does nothing by itself when told not to, though it still reports what it notices", async () => {
          const port = new FlakySendPort();
          const { alice, bob } = await pair(port, WATCHED, { ...WATCHED, autoResync: false });
          await alice.sync();
          await bob.sync();
          alice.edit((fragment) => insertPlainText(fragment, 0, "one"));
          await vi.advanceTimersByTimeAsync(500);
          await bob.sync();
          alice.edit((fragment) => insertPlainText(fragment, 3, " two"));
          port.inner.dropNextSend("alice");
          await vi.advanceTimersByTimeAsync(500);
          alice.edit((fragment) => insertPlainText(fragment, 7, " three"));
          await vi.advanceTimersByTimeAsync(500);
          await bob.sync();
          const before = await requestsSeen(port);
          await vi.advanceTimersByTimeAsync(60_000);
          await bob.sync();
          expect(bob.syncHealth.state).toBe("suspected");
          expect(await requestsSeen(port)).toBe(before);
        });

        it("never runs an automatic request alongside a person's: a manual one holds the slot", async () => {
          const port = new FlakySendPort();
          const { alice, bob } = await pair(port, WATCHED, WATCHED);
          await alice.sync();
          await bob.sync();
          alice.edit((fragment) => insertPlainText(fragment, 0, "one"));
          await vi.advanceTimersByTimeAsync(500);
          await bob.sync();
          alice.edit((fragment) => insertPlainText(fragment, 3, " two"));
          port.inner.dropNextSend("alice");
          await vi.advanceTimersByTimeAsync(500);
          alice.edit((fragment) => insertPlainText(fragment, 7, " three"));
          await vi.advanceTimersByTimeAsync(500);
          await bob.sync();
          const before = await requestsSeen(port);
          await vi.advanceTimersByTimeAsync(5_000);
          await bob.sync();
          expect(await bob.requestResync()).toEqual({ sent: true }); // the person clicks first
          await vi.advanceTimersByTimeAsync(5_000); // the automatic one would be due now
          await bob.sync();
          expect(await requestsSeen(port)).toBe(before + 1); // only theirs
          expect(bob.syncHealth.resync.automatic).toBe(false);
        });

        it("asks for nothing when there is nothing to suspect", async () => {
          const port = new FlakySendPort();
          const { alice, bob } = await pair(port, WATCHED, WATCHED);
          await alice.sync();
          await bob.sync();
          const before = await requestsSeen(port);
          alice.edit((fragment) => insertPlainText(fragment, 0, "fine"));
          await vi.advanceTimersByTimeAsync(24 * 3_600_000);
          await bob.sync();
          expect(await requestsSeen(port)).toBe(before);
        });
      });

      it("is healed by a resync, after which nothing is suspected", async () => {
        const port = new FlakySendPort();
        const { alice, bob } = await pair(port, WATCHED, WATCHED);
        alice.edit((fragment) => insertPlainText(fragment, 0, "one"));
        await vi.advanceTimersByTimeAsync(500);
        await bob.sync();
        alice.edit((fragment) => insertPlainText(fragment, 3, " lost"));
        port.inner.dropNextSend("alice");
        await vi.advanceTimersByTimeAsync(500);
        await vi.advanceTimersByTimeAsync(20_000); // her heartbeat goes out and arrives
        await bob.sync(); // bob hears it, and sees it names a state he has not reached
        expect(bob.syncHealth.state).toBe("ok"); // the missing edit may still be on its way
        await vi.advanceTimersByTimeAsync(5_000); // one expected latency later it has not come
        expect(bob.syncHealth.state).toBe("suspected");

        await bob.requestResync();
        await alice.sync(); // the creator answers
        await bob.sync();
        expect(getPlainText(bob.fragment)).toBe("one lost");
        expect(bob.syncHealth.state).toBe("ok");
      });
    });

    it("exposes the effective policy, with defaults filled in and made consistent", async () => {
      const port = new FlakySendPort();
      const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, {
        syncPolicy: { minIntervalMs: 30_000, maxIntervalMs: 10_000 },
      });
      expect(alice.syncPolicy.minIntervalMs).toBe(30_000);
      expect(alice.syncPolicy.maxIntervalMs).toBe(30_000); // never below the floor
      expect(alice.syncPolicy.maxChars).toBe(Number.POSITIVE_INFINITY);
    });
  });
});

describe("starting from persisted content (join's restore, SPECIFICATION.md §6.3, SND-8)", () => {
  const OPTIONS = { batchWindowMs: 0, resyncResponseThrottleMs: 0 };

  /** The mock, with a restarted member shown nothing from before its restart — as on a messenger without history. */
  function transport() {
    const port = new InMemoryMessengerPort();
    const hiddenUpTo = new Map<MemberId, number>();
    const messenger: MessengerPort = {
      transportProfile: () => port.transportProfile(),
      createDocument: (documentId, creator) => port.createDocument(documentId, creator),
      listChannels: (member) => port.listChannels(member),
      receive: async (documentId, member) =>
        (await port.receive(documentId, member)).filter(
          (delivery) => Number(delivery.id) > (hiddenUpTo.get(member) ?? -1),
        ),
      send: (documentId, sender, payload) => port.send(documentId, sender, payload),
    };
    const restart = async (member: MemberId) => {
      hiddenUpTo.set(member, Number((await port.receive(DOCUMENT_ID, "x")).at(-1)?.id ?? -1));
    };
    const kindsFrom = async (sender: MemberId, after: number) =>
      (await port.receive(DOCUMENT_ID, "x"))
        .filter((delivery) => delivery.sender === sender && Number(delivery.id) > after)
        .map((delivery) => decodeFrame(delivery.payload).kind);
    const lastId = async () => Number((await port.receive(DOCUMENT_ID, "x")).at(-1)?.id ?? -1);
    return { port, messenger, restart, kindsFrom, lastId };
  }

  async function twoAuthors(messenger: MessengerPort) {
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, OPTIONS);
    await alice.setMembership("bob", "write");
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, {
      ...OPTIONS,
      creatorMemberId: "alice",
    });
    await alice.sync();
    await bob.sync();
    alice.edit((fragment) => insertPlainText(fragment, 0, "Hallo "));
    await bob.sync();
    bob.edit((fragment) => insertPlainText(fragment, 6, "Welt"));
    await alice.sync();
    return { alice, bob };
  }

  it("shows the content at once, attributed as persisted, and sends it once as a whole (creator)", async () => {
    const t = transport();
    const { alice, bob } = await twoAuthors(t.messenger);
    const saved = encodeUpdate(alice.document);
    const attribution = alice.attribution.toJSON();
    const controlState = persistedOf(alice);
    alice.dispose();
    await t.restart("alice");
    const before = await t.lastId();

    const restarted = await DocumentEngine.join(DOCUMENT_ID, "alice", t.messenger, undefined, {
      ...OPTIONS,
      creatorMemberId: "alice",
      controlState,
      restore: { state: saved, attribution },
    });
    expect(getPlainText(restarted.fragment)).toBe("Hallo Welt");
    expect(restarted.attribution.toJSON()).toEqual(attribution);
    // It may hold what nobody else has, so it sends the whole state once, as resync() does.
    await vi.waitFor(async () => expect(restarted.hasUndistributedChanges).toBe(false));
    expect(await t.kindsFrom("alice", before)).toEqual(["resync-request", "edit"]);
    await bob.sync();
    expect(getPlainText(bob.fragment)).toBe("Hallo Welt");
  });

  it("sends restored text without attribution as unattributed: authorId null, no last edit, for the joiner too (ATR-2, §5.4)", async () => {
    const t = transport();
    const { alice } = await twoAuthors(t.messenger);
    const saved = encodeUpdate(alice.document);
    const controlState = persistedOf(alice);
    alice.dispose();
    await t.restart("alice");
    const restarted = await DocumentEngine.join(DOCUMENT_ID, "alice", t.messenger, undefined, {
      ...OPTIONS,
      creatorMemberId: "alice",
      controlState,
      restore: { state: saved },
    });
    expect(restarted.attribution.toJSON()).toEqual({
      ranges: [{ start: 0, end: 10, authorId: null }],
      lastEditBySender: {},
    });

    await restarted.setMembership("carol", "read");
    const before = await t.lastId();
    const carol = await DocumentEngine.join(DOCUMENT_ID, "carol", t.messenger, undefined, {
      ...OPTIONS,
      creatorMemberId: "alice",
    });
    await restarted.sync();
    await carol.sync();
    const answer = (await t.port.receive(DOCUMENT_ID, "x"))
      .filter((delivery) => delivery.sender === "alice" && Number(delivery.id) > before)
      .map((delivery) => decodeFrame(delivery.payload))
      .find((frame) => frame.kind === "resync-response");
    expect(answer?.kind === "resync-response" ? answer.attribution : undefined).toEqual({
      ranges: [{ start: 0, end: 10, authorId: null }],
      lastEditBySender: {},
    });
    expect(getPlainText(carol.fragment)).toBe("Hallo Welt");
    expect(carol.attribution.toJSON()).toEqual({
      ranges: [{ start: 0, end: 10, authorId: null }],
      lastEditBySender: {},
    });
  });

  it("keeps a restarted member's own attribution when the creator's overlay is as long: only a first join adopts one wholesale (ATR-1, ATR-2)", async () => {
    const t = transport();
    const { alice, bob } = await twoAuthors(t.messenger);
    await bob.sync();
    const saved = encodeUpdate(bob.document);
    bob.dispose();
    await t.restart("bob");
    const restarted = await DocumentEngine.join(DOCUMENT_ID, "bob", t.messenger, undefined, {
      ...OPTIONS,
      creatorMemberId: "alice",
      restore: { state: saved },
    });
    await alice.sync(); // answers the restarted bob's request, with an overlay of the same length
    await restarted.sync();
    expect(restarted.hasCompletedBootstrap).toBe(true);
    expect(alice.attribution.ranges.map((range) => range.authorId)).toEqual(["alice", "bob"]);
    expect(restarted.attribution.ranges).toEqual([{ start: 0, end: 10, authorId: null }]);
  });

  it("retries the whole state when its first send after the restart is refused for now (SND-6, SND-7, SND-10)", async () => {
    vi.useFakeTimers();
    try {
      const t = transport();
      const { alice, bob } = await twoAuthors(t.messenger);
      const saved = encodeUpdate(alice.document);
      const controlState = persistedOf(alice);
      alice.dispose();
      await t.restart("alice");
      // Right after the restart the messenger cannot be reached yet: the first edit is refused.
      let refuseNextEdit = true;
      const send = t.messenger.send.bind(t.messenger);
      t.messenger.send = async (documentId, sender, payload) => {
        if (sender === "alice" && refuseNextEdit && decodeFrame(payload).kind === "edit") {
          refuseNextEdit = false;
          throw new TransportSendError("unavailable", "not reachable yet");
        }
        return send(documentId, sender, payload);
      };
      const errors: unknown[] = [];
      const restarted = await DocumentEngine.join(
        DOCUMENT_ID,
        "alice",
        t.messenger,
        (error) => errors.push(error),
        {
          ...OPTIONS,
          creatorMemberId: "alice",
          controlState,
          restore: { state: saved },
        },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(refuseNextEdit).toBe(false); // the first attempt was made, and refused
      expect(restarted.sendStatus).toMatchObject({ state: "retrying", failures: 1 });
      expect(restarted.hasUndistributedChanges).toBe(true);

      await vi.advanceTimersByTimeAsync(1_000); // the back-off
      expect(restarted.sendStatus.state).toBe("idle");
      expect(restarted.hasUndistributedChanges).toBe(false);
      expect(errors).toEqual([]); // retried, never dropped: no error (SND-10)
      await bob.sync();
      expect(getPlainText(bob.fragment)).toBe("Hallo Welt");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a piece of the whole state refused for good once, and keeps the mark (SND-8)", async () => {
    vi.useFakeTimers();
    try {
      const t = transport();
      const { alice } = await twoAuthors(t.messenger);
      alice.edit((fragment) =>
        insertPlainText(fragment, 10, " and a lot more text too".repeat(20)),
      );
      const saved = encodeUpdate(alice.document);
      const controlState = persistedOf(alice);
      alice.dispose();
      await t.restart("alice");
      // A transport that carries small messages only, and refuses the second edit frame for good.
      let edits = 0;
      const send = t.messenger.send.bind(t.messenger);
      const small: MessengerPort = {
        ...t.messenger,
        transportProfile: async () => ({
          ...(await t.port.transportProfile()),
          bounds: { minIntervalMs: null, maxBytes: 300 },
        }),
        send: async (documentId, sender, payload) => {
          if (decodeFrame(payload).kind === "edit" && ++edits === 2) {
            throw new TransportSendError("rejected", "not permitted");
          }
          return send(documentId, sender, payload);
        },
      };
      const errors: unknown[] = [];
      const restarted = await DocumentEngine.join(
        DOCUMENT_ID,
        "alice",
        small,
        (error) => errors.push(error),
        {
          ...OPTIONS,
          creatorMemberId: "alice",
          controlState,
          restore: { state: saved },
        },
      );
      await vi.advanceTimersByTimeAsync(60_000);
      expect(edits).toBeGreaterThanOrEqual(2); // in pieces, the second refused
      expect(errors.filter((error) => error instanceof TransportSendError)).toHaveLength(1);
      expect(restarted.hasUndistributedChanges).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers a change that never went out before the restart, once the creator has bootstrapped it (non-creator)", async () => {
    const t = transport();
    const { alice } = await twoAuthors(t.messenger);
    // Bob's application persisted his document, whose last change never went out.
    const errors: unknown[] = [];
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", t.messenger, undefined, {
      ...OPTIONS,
      creatorMemberId: "alice",
    });
    await alice.sync();
    await bob.sync();
    t.port.disconnect("bob");
    bob.edit((fragment) => insertPlainText(fragment, 10, "!"));
    const saved = encodeUpdate(bob.document);
    bob.dispose(); // the last attempt fails: the change is lost from the send queue
    t.port.reconnect("bob");
    await alice.sync();
    expect(getPlainText(alice.fragment)).toBe("Hallo Welt"); // nobody else has it
    await t.restart("bob");

    const restarted = await DocumentEngine.join(
      DOCUMENT_ID,
      "bob",
      t.messenger,
      (error) => errors.push(error),
      { ...OPTIONS, creatorMemberId: "alice", restore: { state: saved } },
    );
    expect(getPlainText(restarted.fragment)).toBe("Hallo Welt!");
    expect(restarted.hasUndistributedChanges).toBe(true); // not before its bootstrap (CTL-13)
    expect(restarted.attribution.ranges.some((range) => range.authorId === "bob")).toBe(false);

    await alice.sync(); // answers the restarted bob's request
    await restarted.sync(); // bootstrapped: the whole state goes out
    await vi.waitFor(async () => expect(restarted.hasUndistributedChanges).toBe(false));
    await alice.sync();
    expect(getPlainText(alice.fragment)).toBe("Hallo Welt!");
    // Restoring is not an edit: nothing was refused for awaiting the bootstrap.
    expect(errors.filter((error) => error instanceof SendRefusedError)).toEqual([]);
  });

  it("keeps the mark, and sends nothing, while the restored member may not edit", async () => {
    const t = transport();
    const { alice, bob } = await twoAuthors(t.messenger);
    await alice.setMembership("bob", "read");
    await bob.sync();
    const saved = encodeUpdate(bob.document);
    bob.dispose();
    await t.restart("bob");
    const before = await t.lastId();

    const restarted = await DocumentEngine.join(DOCUMENT_ID, "bob", t.messenger, () => {}, {
      ...OPTIONS,
      creatorMemberId: "alice",
      restore: { state: saved },
    });
    await alice.sync();
    await restarted.sync();
    expect(restarted.permissionOf("bob")).toBe("read");
    expect(restarted.hasUndistributedChanges).toBe(true);
    expect(await t.kindsFrom("bob", before)).toEqual(["resync-request"]);
  });

  it("refuses a state that does not decode, before anything is sent", async () => {
    const t = transport();
    await twoAuthors(t.messenger);
    const before = await t.lastId();
    await expect(
      DocumentEngine.join(DOCUMENT_ID, "bob", t.messenger, undefined, {
        ...OPTIONS,
        creatorMemberId: "alice",
        restore: { state: new Uint8Array([0xff, 0xff, 0xff]) },
      }),
    ).rejects.toThrow(/restored state/);
    expect(await t.lastId()).toBe(before);
  });

  it("create() refuses it: a new document has no persisted content", async () => {
    const t = transport();
    await expect(
      DocumentEngine.create(DOCUMENT_ID, "alice", t.messenger, undefined, {
        ...OPTIONS,
        restore: { state: new Uint8Array([0]) },
      }),
    ).rejects.toThrow(/join\(/);
  });
});

describe("the heartbeat keeps the promise of the edit that owes it (SND-11, SND-14, SND-23, LOS-11, LOS-16)", () => {
  // Matrix to a real homeserver, as Appendix B suggests: a floor of 1 s, 15 s, 5 s of latency.
  const MATRIX = {
    batchWindowMs: 0,
    resyncResponseThrottleMs: 0,
    syncPolicy: { minIntervalMs: 1_000, maxIntervalMs: 15_000, expectedLatencyMs: 5_000 },
  };

  it("an answer to a joiner just after an edit does not make the others suspect the creator, or ask", async () => {
    vi.useFakeTimers();
    try {
      const port = new InMemoryMessengerPort();
      const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, MATRIX);
      await afterFloor(alice.setMembership("bob", "write"), 1_000);
      const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, {
        ...MATRIX,
        creatorMemberId: "alice",
      });
      const engines = [alice, bob];
      const tick = async (seconds: number) => {
        for (let i = 0; i < seconds; i += 1) {
          await vi.advanceTimersByTimeAsync(1_000);
          for (const engine of engines) await engine.sync();
        }
      };
      await tick(120); // everything settled, every heartbeat sent
      const before = (await port.receive(DOCUMENT_ID, "x")).length;

      alice.edit((fragment) => insertPlainText(fragment, 0, "Hallo")); // promises a follow-up within 15 s
      await tick(9);
      // A joiner asks; the creator answers some 10 s after her edit, before the heartbeat it owes.
      const carol = await DocumentEngine.join(DOCUMENT_ID, "carol", port, undefined, {
        ...MATRIX,
        creatorMemberId: "alice",
      });
      engines.push(carol);
      const overdue: number[] = [];
      for (let second = 0; second < 60; second += 1) {
        await tick(1);
        if (bob.syncHealth.suspicions.some((s) => s.kind === "sender-overdue"))
          overdue.push(second);
      }
      expect(overdue).toEqual([]);
      const bobsRequests = (await port.receive(DOCUMENT_ID, "x"))
        .slice(before)
        .filter(
          (delivery) =>
            delivery.sender === "bob" && decodeFrame(delivery.payload).kind === "resync-request",
        );
      expect(bobsRequests).toEqual([]);
      expect(getPlainText(carol.fragment)).toBe("Hallo");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the creator's pace and each sender's due (SND-14, SND-15)", () => {
  const AS_CREATOR = { batchWindowMs: 0, creatorMemberId: "alice" };

  async function trio(bobOptions: DocumentEngineOptions = {}) {
    const port = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_CREATOR);
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, {
      ...AS_CREATOR,
      ...bobOptions,
    });
    await alice.sync();
    await bob.sync();
    return { port, alice, bob };
  }

  it("the creator's pace reaches everyone and raises only the floor between messages (SND-15)", async () => {
    const { alice, bob } = await trio({ syncPolicy: { maxIntervalMs: 20_000 } });
    await alice.setPace(30_000);
    await bob.sync();
    expect(bob.pace).toBe(30_000);
    expect(bob.syncPolicy.minIntervalMs).toBe(30_000);
    expect(alice.syncPolicy.minIntervalMs).toBe(30_000);
    // Bob's own longest wait cannot fall below the floor (resolveSyncPolicy), the rest is his.
    expect(bob.syncPolicy.maxIntervalMs).toBe(30_000);
  });

  it("a participant may send slower than the pace, never faster", async () => {
    const { alice, bob } = await trio({ syncPolicy: { minIntervalMs: 60_000 } });
    await alice.setPace(30_000);
    await bob.sync();
    expect(bob.syncPolicy.minIntervalMs).toBe(60_000);
  });

  it("a transport's floor above the pace still wins (SND-15)", async () => {
    const port = new FlakySendPort();
    port.profile = {
      bounds: { minIntervalMs: 45_000, maxBytes: null },
      pacing: {
        minIntervalMs: 0,
        maxIntervalMs: null,
        minChars: 0,
        maxChars: null,
        expectedLatencyMs: 0,
      },
    };
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_CREATOR);
    expect(alice.syncPolicy.minIntervalMs).toBe(45_000);
  });

  it("only the creator sets the pace, as a whole number of milliseconds", async () => {
    const { alice, bob } = await trio();
    await expect(bob.setPace(1_000)).rejects.toThrow(/not the creator/);
    await expect(alice.setPace(1.5)).rejects.toThrow(/whole number/);
    await expect(alice.setPace(-1)).rejects.toThrow(/whole number/);
  });

  it("every edit and control frame says when its sender will speak again: its own longest wait (SND-14)", async () => {
    const { port, alice, bob } = await trio({ syncPolicy: { maxIntervalMs: 20_000 } });
    bob.edit((fragment) => insertPlainText(fragment, 0, "hi"));
    await bob.flush();
    await alice.setMembership("bob", "write");
    const frames = (await port.receive(DOCUMENT_ID, "alice")).map((d) => ({
      sender: d.sender,
      frame: decodeFrame(d.payload),
    }));
    const bobsEdit = frames.find((f) => f.sender === "bob" && f.frame.kind === "edit");
    const alicesControl = frames.find((f) => f.sender === "alice" && f.frame.kind === "control");
    expect(bobsEdit?.frame).toMatchObject({ due: 20_000 });
    expect(alicesControl?.frame).toMatchObject({ due: 0 }); // alice promises nothing: no longest wait
  });

  it("the frame that raises the pace promises what its sender keeps under it, so nobody takes the sender for silent (SND-14, SND-15)", async () => {
    vi.useFakeTimers();
    try {
      const watched = {
        ...AS_CREATOR,
        syncPolicy: { maxIntervalMs: 20_000, expectedLatencyMs: 5_000 },
      };
      const port = new InMemoryMessengerPort();
      const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, watched);
      const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, watched);
      const tick = async (seconds: number, onTick: () => void = () => {}) => {
        for (let second = 0; second < seconds; second += 1) {
          await vi.advanceTimersByTimeAsync(1_000);
          await alice.sync();
          await bob.sync();
          onTick();
        }
      };
      await tick(60); // the join is answered, and every heartbeat it owed has gone out
      await alice.setPace(60_000); // above alice's own longest wait of 20 s
      const paceFrame = (await port.receive(DOCUMENT_ID, "bob"))
        .map((delivery) => decodeFrame(delivery.payload))
        .find((frame) => frame.kind === "control" && frame.target === "pace");
      expect(paceFrame).toMatchObject({ value: 60_000, due: 60_000 });
      expect(alice.syncPolicy.maxIntervalMs).toBe(60_000); // what she keeps from now on
      const suspected: string[] = [];
      await tick(90, () => suspected.push(...bob.syncHealth.suspicions.map((s) => s.kind)));
      expect(suspected).toEqual([]);
      // A member that has learned the pace promises the same in what it sends from then on.
      bob.edit((fragment) => insertPlainText(fragment, 0, "x"));
      await vi.advanceTimersByTimeAsync(60_000);
      const bobsEdit = (await port.receive(DOCUMENT_ID, "alice"))
        .filter((delivery) => delivery.sender === "bob")
        .map((delivery) => decodeFrame(delivery.payload))
        .find((frame) => frame.kind === "edit");
      expect(bobsEdit).toMatchObject({ due: 60_000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("two devices of the creator setting the pace at once: the longer interval holds everywhere", async () => {
    const port = new InMemoryMessengerPort();
    const laptop = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_CREATOR);
    const tablet = await DocumentEngine.join(DOCUMENT_ID, "alice", port, undefined, AS_CREATOR);
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, AS_CREATOR);
    for (const engine of [laptop, tablet, bob]) await engine.sync();
    await Promise.all([laptop.setPace(10_000), tablet.setPace(40_000)]);
    for (const engine of [laptop, tablet, bob]) await engine.sync();
    for (const engine of [laptop, tablet, bob]) {
      expect(engine.pace).toBe(40_000);
    }
  });
});

describe("reading with a cursor (TRN-18, TRN-19, LOS-9)", () => {
  const AS_CREATOR = { batchWindowMs: 0, creatorMemberId: "alice" };

  it("asks only for what came after the last delivery it saw", async () => {
    const port = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_CREATOR);
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, AS_CREATOR);
    await alice.sync();
    const cursors: (string | undefined)[] = [];
    const original = port.receiveSince.bind(port);
    port.receiveSince = async (documentId, member, after) => {
      if (member === "bob") cursors.push(after);
      return original(documentId, member, after);
    };
    await bob.sync();
    alice.edit((fragment) => insertPlainText(fragment, 0, "x"));
    await alice.flush();
    await bob.sync();
    expect(cursors[0]).toBeDefined();
    expect(cursors[1]).not.toBe(cursors[0]);
    expect(getPlainText(bob.fragment)).toBe("x");
  });

  it("treats a cursor that left the window as evidence at once, and asks regardless (LOS-9)", async () => {
    const port = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, {
      ...AS_CREATOR,
      resyncResponseThrottleMs: 0,
    });
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, AS_CREATOR);
    await alice.sync();
    await bob.sync();
    const all = await port.receive(DOCUMENT_ID, "bob");
    port.forgetOldest(DOCUMENT_ID, all.length);
    await port.send(DOCUMENT_ID, "alice", encodeEditFrame(DOCUMENT_ID, new Uint8Array([0, 0])));
    await bob.sync();
    expect(bob.syncHealth.suspicions).toEqual([
      expect.objectContaining({ kind: "history-truncated" }),
    ]);
    const requests = (await port.receive(DOCUMENT_ID, "alice"))
      .map((d) => decodeFrame(d.payload))
      .filter((frame) => frame.kind === "resync-request");
    expect(requests.at(-1)).toMatchObject({ force: true });
    await alice.sync();
    await bob.sync();
    expect(bob.syncHealth.state).toBe("ok");
  });

  it("treats a bridge restart as evidence too, even when the cursor is still there (TRN-19)", async () => {
    const port = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_CREATOR);
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, AS_CREATOR);
    await alice.sync();
    await bob.sync();
    port.restartBridge();
    await bob.sync();
    expect(bob.syncHealth.suspicions).toEqual([
      expect.objectContaining({ kind: "history-truncated" }),
    ]);
  });

  it("treats a bridge restart as evidence without a cursor too, where LOS-8's overlap sees nothing (LOS-9)", async () => {
    const port = new InMemoryMessengerPort();
    // A transport that names its bridge instance but offers no cursor (TRN-19 without TRN-18).
    Object.defineProperty(port, "receiveSince", { value: undefined });
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_CREATOR);
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, AS_CREATOR);
    await alice.sync();
    await bob.sync();
    await bob.sync(); // the same window again: nothing to suspect
    expect(bob.syncHealth.state).toBe("ok");
    port.restartBridge(); // the window stays, so the answers still overlap
    await bob.sync();
    expect(bob.syncHealth.suspicions).toEqual([
      expect.objectContaining({ kind: "history-truncated" }),
    ]);
  });

  /**
   * Bob, bootstrapped with write, stops; his application kept his control state, his content and
   * the cursor and the instance as they stood together (LIF-8). Alice is away when he starts again.
   */
  async function bobRestartsWith(betweenStops: (port: InMemoryMessengerPort) => void) {
    const port = new InMemoryMessengerPort();
    let control: PersistedControlState | undefined;
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, {
      ...AS_CREATOR,
      resyncResponseThrottleMs: 0,
    });
    await alice.setMembership("bob", "write");
    const before = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, {
      ...AS_CREATOR,
      onControlStateChange: (state) => {
        control = state;
      },
    });
    for (let round = 0; round < 4; round++) {
      await alice.sync();
      await before.sync();
    }
    expect(before.mayEdit).toBe(true);
    const restore = {
      state: encodeUpdate(before.document),
      cursor: before.cursor,
      instance: before.instance,
    };
    before.dispose();
    port.disconnect("alice");
    betweenStops(port);
    return DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, {
      ...AS_CREATOR,
      controlState: control as PersistedControlState,
      restore,
    });
  }

  it("reads on after a restart under the instance it kept with the cursor, without evidence (LIF-8, TRN-19)", async () => {
    const bob = await bobRestartsWith(() => {});
    expect(bob.syncHealth.state).toBe("ok");
    expect(bob.hasCompletedBootstrap).toBe(true);
    expect(bob.mayEdit).toBe(true);
  });

  it("takes another instance than the one kept with the cursor as evidence, and waits for the creator (LOS-9)", async () => {
    const bob = await bobRestartsWith((port) => port.restartBridge());
    expect(bob.syncHealth.suspicions).toEqual([
      expect.objectContaining({ kind: "history-truncated" }),
    ]);
    expect(bob.hasCompletedBootstrap).toBe(false);
    expect(bob.mayEdit).toBe(false);
  });

  it("shows what the bridge gives up while it answers the first read after a restart, before it bootstraps (TRN-19)", async () => {
    // The bridge reads its messenger for this answer and gives an event up: a new epoch by the time
    // it has answered, the cursor still in the window and the answer not truncated.
    const bob = await bobRestartsWith((port) => {
      const original = port.receiveSince.bind(port);
      port.receiveSince = async (documentId, member, after) => {
        const answer = await original(documentId, member, after);
        port.restartBridge();
        port.receiveSince = original;
        return answer;
      };
    });
    expect(bob.syncHealth.suspicions).toEqual([
      expect.objectContaining({ kind: "history-truncated" }),
    ]);
    expect(bob.hasCompletedBootstrap).toBe(false);
    expect(bob.mayEdit).toBe(false);
  });
});

describe("MemberIds with dots, as Matrix's and email's have (FRM-9, CTL-25)", () => {
  it("a joiner that sees none of the creator's operations learns its right from the snapshot", async () => {
    const messenger = new InMemoryMessengerPort();
    const options = { batchWindowMs: 0, resyncResponseThrottleMs: 0 };
    const alice = await DocumentEngine.create(
      "doc-dots",
      "@alice:example.org",
      messenger,
      undefined,
      options,
    );
    await alice.setMembership("@bob:example.org", "read");
    await alice.sync();
    messenger.forgetOldest(
      "doc-dots",
      (await messenger.receive("doc-dots", "@x:example.org")).length,
    );
    const bob = await DocumentEngine.join("doc-dots", "@bob:example.org", messenger, undefined, {
      ...options,
      creatorMemberId: "@alice:example.org",
    });
    for (let round = 0; round < 6; round++) {
      await alice.sync();
      await bob.sync();
    }
    expect(bob.hasCompletedBootstrap).toBe(true);
    expect(bob.permissionOf("@bob:example.org")).toBe("read");
    expect(bob.mayEdit).toBe(false);
  });
});

describe("collisions under one device and counter, whichever way they arrive (CTL-24)", () => {
  const options = { batchWindowMs: 0, resyncResponseThrottleMs: 0 };
  const anomalies = (errors: readonly unknown[]) =>
    errors.filter(
      (error) => error instanceof Error && (error as { reason?: string }).reason === "anomaly",
    ).length;

  /** Alice lets Bob write; Carol joins — with `onlySnapshot`, after the frame left the window. */
  async function carolJoins(onlySnapshot: boolean) {
    const messenger = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, options);
    await alice.setMembership("bob", "write");
    await alice.sync();
    if (onlySnapshot) {
      messenger.forgetOldest(
        DOCUMENT_ID,
        (await messenger.receive(DOCUMENT_ID, "observer")).length,
      );
    }
    const errors: unknown[] = [];
    const carol = await DocumentEngine.join(
      DOCUMENT_ID,
      "carol",
      messenger,
      (error) => errors.push(error),
      {
        ...options,
        creatorMemberId: "alice",
      },
    );
    for (let round = 0; round < 4; round++) {
      await alice.sync();
      await carol.sync();
    }
    expect(carol.hasCompletedBootstrap).toBe(true);
    expect(anomalies(errors)).toBe(0);
    return { messenger, carol, errors, tag: alice.deviceTag as string };
  }

  it("reports a frame that collides with an operation taken from the creator's snapshot", async () => {
    const { messenger, carol, errors, tag } = await carolJoins(true);
    const other = encodeControlFrame({
      documentId: DOCUMENT_ID,
      device: tag,
      counter: 1,
      target: "member:bob",
      value: null,
      seen: {},
    });
    await messenger.send(DOCUMENT_ID, "alice", other);
    await carol.sync();
    expect(anomalies(errors)).toBe(1);
    expect(carol.controlAnomalies).toEqual([{ device: tag, counter: 1 }]);
    expect(carol.permissionOf("bob")).toBeUndefined(); // the narrowest of the two
  });

  it("reports a snapshot that collides with an operation taken as a frame", async () => {
    const { messenger, carol, errors, tag } = await carolJoins(false);
    const answer = encodeResyncResponseFrame({
      documentId: DOCUMENT_ID,
      respondsTo: "0123456789abcdef",
      update: Y.encodeStateAsUpdate(new Y.Doc()),
      control: {
        profile: YJS_PARAGRAPHS_1,
        vector: { [tag]: 1 },
        targets: {
          "member:bob": { seen: {}, heads: [{ device: tag, counter: 1, value: null, seen: {} }] },
        },
      },
    });
    await messenger.send(DOCUMENT_ID, "alice", answer);
    await carol.sync();
    expect(anomalies(errors)).toBe(1);
    expect(carol.controlAnomalies).toEqual([{ device: tag, counter: 1 }]);
    expect(carol.permissionOf("bob")).toBeUndefined();
  });
});

describe("a device of the creator that meets another copy of itself (CTL-24)", () => {
  const options = { batchWindowMs: 0, resyncResponseThrottleMs: 0 };
  /** Another copy of this device's operation 1: same tag and counter, another value. */
  const otherCopy = (tag: string) =>
    encodeControlFrame({
      documentId: DOCUMENT_ID,
      device: tag,
      counter: 1,
      target: "member:bob",
      value: null,
      seen: {},
    });

  async function aliceGrantsBob(
    messenger: InMemoryMessengerPort,
    onControlStateChange?: (state: PersistedControlState) => void,
  ) {
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
      ...options,
      onControlStateChange,
    });
    await alice.setMembership("bob", "write"); // counter 1, sent
    await alice.sync();
    return alice;
  }

  it("takes a new tag when an operation it issued and sent comes back with other content", async () => {
    const messenger = new InMemoryMessengerPort();
    const alice = await aliceGrantsBob(messenger);
    const tag = alice.deviceTag as string;
    await messenger.send(DOCUMENT_ID, "alice", otherCopy(tag));
    await alice.sync();
    expect(alice.controlAnomalies).toEqual([{ device: tag, counter: 1 }]);
    expect(alice.deviceTag).not.toBe(tag);
    // Its next decision no longer competes with the copy under the old tag.
    await alice.setMembership("carol", "read");
    expect(alice.controlVector[alice.deviceTag as string]).toBe(1);
  });

  it("takes a new tag for it after a restart too, from what it restored", async () => {
    const messenger = new InMemoryMessengerPort();
    let persisted: PersistedControlState | undefined;
    const before = await aliceGrantsBob(messenger, (state) => {
      persisted = state;
    });
    const tag = before.deviceTag as string;
    before.dispose();
    messenger.forgetOldest(DOCUMENT_ID, (await messenger.receive(DOCUMENT_ID, "observer")).length);
    const alice = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, {
      ...options,
      creatorMemberId: "alice",
      controlState: persisted,
    });
    expect(alice.deviceTag).toBe(tag);
    await messenger.send(DOCUMENT_ID, "alice", otherCopy(tag));
    await alice.sync();
    expect(alice.deviceTag).not.toBe(tag);
  });

  it("takes a new tag when a snapshot brings the other copy", async () => {
    const messenger = new InMemoryMessengerPort();
    const alice = await aliceGrantsBob(messenger);
    const tag = alice.deviceTag as string;
    const answer = encodeResyncResponseFrame({
      documentId: DOCUMENT_ID,
      respondsTo: "0123456789abcdef",
      update: Y.encodeStateAsUpdate(new Y.Doc()),
      control: {
        profile: YJS_PARAGRAPHS_1,
        vector: { [tag]: 1 },
        targets: {
          "member:bob": { seen: {}, heads: [{ device: tag, counter: 1, value: null, seen: {} }] },
        },
      },
    });
    await messenger.send(DOCUMENT_ID, "alice", answer); // another device of alice, answering a member
    await alice.sync();
    expect(alice.deviceTag).not.toBe(tag);
  });

  it("keeps its tag when its own operation merely comes back again", async () => {
    const messenger = new InMemoryMessengerPort();
    const alice = await aliceGrantsBob(messenger);
    const tag = alice.deviceTag as string;
    const own = (await messenger.receive(DOCUMENT_ID, "observer")).find(
      (delivery) => decodeFrame(delivery.payload).kind === "control",
    );
    await messenger.send(DOCUMENT_ID, "alice", own?.payload as string);
    await alice.sync();
    expect(alice.controlAnomalies).toEqual([]);
    expect(alice.deviceTag).toBe(tag);
  });
});

describe("what a device of the creator takes from participants' reports (CTL-27, CTL-28)", () => {
  const options = { batchWindowMs: 0, resyncResponseThrottleMs: 0, creatorMemberId: "alice" };
  async function settle(...engines: DocumentEngine[]) {
    for (let round = 0; round < 6; round++) for (const engine of engines) await engine.sync();
  }

  it("with a basis it counts nothing reported as seen: a decision it never saw is not superseded", async () => {
    const messenger = new InMemoryMessengerPort();
    const a = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, options);
    await a.setMembership("carol", "write"); // A:1
    const b = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, options);
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, options);
    await settle(a, b, bob);
    expect(b.controlConfirmed).toBe(true);
    // A revokes carol; Bob gets it, B never does: its window moved past it.
    await a.setMembership("carol", null); // A:2
    await settle(bob);
    messenger.forgetOldest(DOCUMENT_ID, (await messenger.receive(DOCUMENT_ID, "observer")).length);
    expect(await bob.requestResync()).toEqual({ sent: true }); // its control vector holds A:2: a report for B
    await b.sync();
    const before = (await messenger.receive(DOCUMENT_ID, "observer")).length;
    await b.setMembership("carol", "read"); // the person on B decides, not knowing of the revocation
    const frames = (await messenger.receive(DOCUMENT_ID, "observer"))
      .slice(before)
      .map((delivery) => decodeFrame(delivery.payload));
    const op = frames.find((frame) => frame.kind === "control");
    expect(op?.kind === "control" && op.seen[a.deviceTag as string]).toBe(1); // what B holds of A, not A:2
    // So the two decisions are concurrent, and the narrower holds for everyone (CTL-23).
    await settle(a, bob);
    expect(bob.permissionOf("carol")).toBeUndefined();
  });
});

describe("whether a restored device of the creator has a basis (CTL-26, CTL-28)", () => {
  const options = { batchWindowMs: 0, resyncResponseThrottleMs: 0, creatorMemberId: "alice" };
  async function settle(...engines: DocumentEngine[]) {
    for (let round = 0; round < 6; round++) for (const engine of engines) await engine.sync();
  }

  /** Alice's old device made Bob a reader and is lost; a new one, seeing none of it, grants Carol. */
  async function newDeviceDecides() {
    const messenger = new InMemoryMessengerPort();
    const old = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, options);
    await old.setMembership("bob", "read");
    await old.sync();
    old.dispose();
    messenger.forgetOldest(DOCUMENT_ID, (await messenger.receive(DOCUMENT_ID, "observer")).length);
    let persisted: PersistedControlState | undefined;
    const fresh = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, {
      ...options,
      onControlStateChange: (state) => {
        persisted = state;
      },
    });
    await fresh.setMembership("carol", "write");
    expect(fresh.controlConfirmed).toBe(false);
    fresh.dispose();
    return { messenger, persisted: persisted as PersistedControlState };
  }

  it("persists that it had none, and restored stays without one: a reader it never decided about is not bootstrapped", async () => {
    const { messenger, persisted } = await newDeviceDecides();
    expect(persisted.basis).toBe(false);
    const restarted = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, {
      ...options,
      controlState: persisted,
    });
    expect(restarted.controlConfirmed).toBe(false);
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, options);
    await settle(restarted, bob);
    expect(bob.hasCompletedBootstrap).toBe(false);
    expect(bob.mayEdit).toBe(false);
  });

  it("persists that it had one, and restored keeps it", async () => {
    const messenger = new InMemoryMessengerPort();
    let persisted: PersistedControlState | undefined;
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
      ...options,
      onControlStateChange: (state) => {
        persisted = state;
      },
    });
    await alice.setMembership("bob", "read");
    alice.dispose();
    expect(persisted?.basis).toBe(true);
    const restarted = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, {
      ...options,
      controlState: persisted,
    });
    expect(restarted.controlConfirmed).toBe(true);
  });

  it("takes a state persisted without the field as one with a basis, as before", async () => {
    const { messenger, persisted } = await newDeviceDecides();
    const { basis: _left, ...older } = persisted;
    const restarted = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, {
      ...options,
      controlState: older,
    });
    expect(restarted.controlConfirmed).toBe(true);
  });
});

describe("a device of the creator that restarts (RSY-5, RSY-14, LOS-6)", () => {
  const options = { batchWindowMs: 0, resyncResponseThrottleMs: 0, creatorMemberId: "alice" };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  /** `ms` of fake time in steps of ten seconds, every engine reading at each. */
  async function pass(ms: number, ...engines: DocumentEngine[]) {
    for (let t = 0; t < ms; t += 10_000) {
      await vi.advanceTimersByTimeAsync(10_000);
      for (const engine of engines) await engine.sync();
    }
  }
  const requestsOfAlice = async (messenger: InMemoryMessengerPort) =>
    (await resyncRequestsFrom(messenger, DOCUMENT_ID, "observer")).filter(
      (request) => request.requester === "alice",
    ).length;

  /** Alice decides and writes, Bob holds the same; Alice's application kept her control state and content. */
  async function aliceStops() {
    const messenger = new InMemoryMessengerPort();
    let control: PersistedControlState | undefined;
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
      ...options,
      onControlStateChange: (state) => {
        control = state;
      },
    });
    await alice.setMembership("bob", "write");
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, options);
    alice.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
    await pass(20_000, alice, bob);
    const content = encodeUpdate(alice.document);
    alice.dispose();
    return { messenger, bob, control: control as PersistedControlState, content };
  }

  it("with a basis and its content it is bootstrapped at once, and asks once, not again and again", async () => {
    const { messenger, bob, control, content } = await aliceStops();
    const before = await requestsOfAlice(messenger);
    const alice = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, {
      ...options,
      controlState: control,
      restore: { state: content },
    });
    expect(alice.hasCompletedBootstrap).toBe(true);
    await pass(800_000, alice, bob); // Bob holds nothing Alice lacks, so he rightly stays silent (RSY-17)
    expect((await requestsOfAlice(messenger)) - before).toBe(1); // the one of RSY-1
  });

  it("still asks by itself on evidence after its own bootstrap requests ran out", async () => {
    const { messenger, control } = await aliceStops();
    messenger.forgetOldest(DOCUMENT_ID, (await messenger.receive(DOCUMENT_ID, "observer")).length);
    // Without its content, and nobody online who could give it back.
    const alice = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, {
      ...options,
      controlState: control,
    });
    await pass(800_000, alice);
    expect(alice.hasCompletedBootstrap).toBe(false);
    const asked = await requestsOfAlice(messenger);
    // Bob comes back: his heartbeat shows content Alice does not hold (LOS-4).
    const bobs = new Y.Doc();
    bobs.getXmlFragment("content").insert(0, [new Y.XmlElement("paragraph")]);
    await messenger.send(
      DOCUMENT_ID,
      "bob",
      encodeHeartbeatFrame({
        documentId: DOCUMENT_ID,
        control: null,
        controlDigest: null,
        stateVector: Y.encodeStateVector(bobs),
        stateDigest: "0".repeat(16),
      }),
    );
    await pass(60_000, alice);
    expect(alice.syncHealth.suspicions.length).toBeGreaterThan(0);
    expect(await requestsOfAlice(messenger)).toBeGreaterThan(asked);
    // Bounded per episode, as for anyone (LOS-6).
    await pass(1_800_000, alice);
    expect(await requestsOfAlice(messenger)).toBe(asked + 3);
  });
});

describe("the overlay a joiner adopts for its bootstrap (RSY-15)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stands when a second bootstrap request of its own is answered later", async () => {
    const messenger = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
      batchWindowMs: 0,
    });
    alice.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
    await vi.advanceTimersByTimeAsync(0);
    // Bob sees none of it, and asks twice before anyone answers: the first request expired.
    messenger.forgetOldest(DOCUMENT_ID, (await messenger.receive(DOCUMENT_ID, "observer")).length);
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, {
      ...JOIN_ALICE,
      autoResync: false,
    });
    await vi.advanceTimersByTimeAsync(11_000);
    expect(await bob.requestResync()).toEqual({ sent: true });
    const [first, second] = (await resyncRequestsFrom(messenger, DOCUMENT_ID, "observer")).filter(
      (r) => r.requester === "bob",
    );
    expect(second).toBeDefined();
    const overlay = alice.attribution.toJSON();
    const answer = (respondsTo: string, authorId: string) =>
      encodeResyncResponseFrame({
        documentId: DOCUMENT_ID,
        respondsTo,
        update: encodeUpdate(alice.document),
        control: alice.controlState,
        attribution: {
          ...overlay,
          ranges: overlay.ranges.map((range) => ({ ...range, authorId })),
        },
      });
    await messenger.send(DOCUMENT_ID, "alice", answer(first?.id as string, "alice"));
    await bob.sync();
    expect(bob.hasCompletedBootstrap).toBe(true);
    expect(bob.attribution.ranges.map((range) => range.authorId)).toEqual(["alice"]);
    // The answer to the second request brings another overlay; the first one adopted stands.
    await messenger.send(DOCUMENT_ID, "alice", answer(second?.id as string, "dave"));
    await bob.sync();
    expect(bob.attribution.ranges.map((range) => range.authorId)).toEqual(["alice"]);
  });
});

describe("an answer to this engine's own request that does not bootstrap it (RSY-4, LOS-16)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers the request and ends the silence it expected, though it carries no control state", async () => {
    const messenger = new InMemoryMessengerPort();
    const old = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
      batchWindowMs: 0,
    });
    await old.setMembership("bob", "write");
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, {
      ...JOIN_ALICE,
      syncPolicy: { maxIntervalMs: 30_000 },
    });
    for (let round = 0; round < 3; round++) {
      await old.sync();
      await bob.sync();
    }
    old.dispose();
    const window = (await messenger.receive(DOCUMENT_ID, "observer")).length;
    // Bob's last edit promises a follow-up within 30 s; then he is gone for good.
    bob.edit((fragment) => insertPlainText(fragment, 0, "B"));
    await vi.advanceTimersByTimeAsync(0);
    bob.dispose();
    // A new device of Alice sees none of the old one's decisions: it has no basis (CTL-28).
    messenger.forgetOldest(DOCUMENT_ID, window);
    const fresh = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, {
      ...JOIN_ALICE,
      resyncResponseThrottleMs: 0,
    });
    const carol = await DocumentEngine.join(DOCUMENT_ID, "carol", messenger, undefined, {
      ...JOIN_ALICE,
      autoResync: false,
    });
    expect(carol.syncHealth.resync.state).toBe("requested");
    await fresh.sync(); // answers Carol's request without control state: it never decided about her
    await carol.sync();
    expect(carol.hasCompletedBootstrap).toBe(false);
    expect(carol.syncHealth.resync).toMatchObject({ state: "idle", lastOutcome: "answered" });
    await vi.advanceTimersByTimeAsync(120_000);
    await carol.sync();
    expect(
      carol.syncHealth.suspicions.filter((suspicion) => suspicion.kind === "sender-overdue"),
    ).toEqual([]);
  });
});

describe("an answer that failed, and the turn of its requester (RSY-9, RSY-19)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the requester's place: the next answer goes to it again, not to the one after it", async () => {
    const messenger = new InMemoryMessengerPort();
    let failAnswers = 0;
    // Alice's side of the messenger, which refuses her next answer for now (§3.4: worth retrying).
    const alicesPort: MessengerPort = {
      transportProfile: () => messenger.transportProfile(),
      createDocument: (documentId, creator) => messenger.createDocument(documentId, creator),
      receive: (documentId, member) => messenger.receive(documentId, member),
      listChannels: (member) => messenger.listChannels(member),
      send: async (documentId, sender, payload) => {
        if (failAnswers > 0 && decodeFrame(payload).kind === "resync-response") {
          failAnswers -= 1;
          throw new TransportSendError("unavailable", "the messenger is away for a moment");
        }
        return messenger.send(documentId, sender, payload);
      },
    };
    const options = { batchWindowMs: 0, creatorMemberId: "alice", resyncResponseThrottleMs: 1000 };
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", alicesPort, undefined, options);
    alice.edit((fragment) => insertPlainText(fragment, 0, "content"));
    await vi.advanceTimersByTimeAsync(10);
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, {
      ...options,
      autoResync: false,
    });
    const carol = await DocumentEngine.join(DOCUMENT_ID, "carol", messenger, undefined, {
      ...options,
      autoResync: false,
    });
    await vi.advanceTimersByTimeAsync(10);
    const requests = (await resyncRequestsFrom(messenger, DOCUMENT_ID, "observer")).filter(
      (r) => r.requester !== "alice",
    );
    expect(requests.map((r) => r.requester)).toEqual(["bob", "carol"]);

    failAnswers = 1;
    await alice.sync(); // Bob's turn: his answer fails
    await vi.advanceTimersByTimeAsync(1_100);
    await alice.sync(); // still Bob's turn
    await vi.advanceTimersByTimeAsync(10);
    const answers = (await messenger.receive(DOCUMENT_ID, "observer"))
      .map((delivery) => decodeFrame(delivery.payload))
      .filter((frame) => frame.kind === "resync-response");
    expect(answers.map((frame) => frame.kind === "resync-response" && frame.respondsTo)).toEqual([
      requests[0]?.id,
    ]);
    await vi.advanceTimersByTimeAsync(1_100);
    await alice.sync(); // then Carol's
    await vi.advanceTimersByTimeAsync(10);
    await bob.sync();
    await carol.sync();
    expect(bob.hasCompletedBootstrap).toBe(true);
    expect(carol.hasCompletedBootstrap).toBe(true);
  });
});
