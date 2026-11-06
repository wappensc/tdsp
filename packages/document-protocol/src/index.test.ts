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
  encodeDeletions,
  encodeStateVector,
  encodeUpdate,
  getPlainText,
  insertPlainText,
  transact,
} from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import * as Y from "yjs";
import { digestOf } from "./digest";
import {
  CURRENT_FRAME_VERSION,
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
  type DocumentProfile,
  type FrameExtension,
  MAX_GAP_TRIES,
  MIN_MESSAGE_BYTES,
  type PersistedControlState,
  REPORT_AFTER_MS,
  SendRefusedError,
  TransportProfileError,
  UnsplittableUpdateError,
  YJS_PARAGRAPHS_1,
} from "./index";
import { profileFor } from "./profile";
import { registerStateDigest } from "./registers";

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

/**
 * What a device of the creator persists, as `onControlStateChange` hands it (CTL-26): its registers
 * and close, its tag, its clock — here the control clock, which its own clock is never below while
 * its wall clock is right — and whether it is bootstrapped (RSY-14), by this draft (VER-3).
 */
function persistedOf(engine: DocumentEngine): PersistedControlState {
  const device = engine.deviceTag;
  const { closed, targets } = engine.controlState;
  return {
    tdsp: CURRENT_FRAME_VERSION,
    profile: engine.profile,
    control: { closed, targets },
    ...(device === undefined ? {} : { device, clock: engine.controlClock }),
    ...(engine.controlStanding.kind === "bootstrapped" ? { bootstrapped: true } : {}),
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
    await alice.setMembership("bob", "write"); // named before he joins (LIF-9)
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
      await alice.setMembership("bob", "write"); // named before he joins (LIF-9)
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
      // The batch, then the report it owes as it closes (SND-11), carrying that batch (SND-27).
      const sent = (await messenger.receive(DOCUMENT_ID, "alice")).map((d) =>
        decodeFrame(d.payload),
      );
      expect(sent).toHaveLength(seedCount + 2);
      const [edit, report] = sent.slice(-2);
      expect(report?.kind === "heartbeat" && report.update).toEqual(
        edit?.kind === "edit" && edit.update,
      );
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
      await alice.setMembership("bob", "write"); // named before he joins (LIF-9)
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

    it("a creator that restarted is restored by a peer asked by all, adopts the first overlay it receives, and a second one changes nothing", async () => {
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
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

      const restoredControl = restarted.controlState;
      const fromCarol = async () =>
        (await messenger.inner.receive(DOCUMENT_ID, "carol"))
          .filter((delivery) => delivery.sender === "carol")
          .map((delivery) => decodeFrame(delivery.payload))
          .filter((frame) => frame.kind === "resync-response");
      await carol.sync(); // its first request does not ask all: a peer does not answer it (RSY-21)
      expect(await fromCarol()).toStrictEqual([]);
      // It expires unanswered; the creator's repeat asks all, and Carol answers at her turn (RSY-20).
      for (let second = 0; second < 60 && (await fromCarol()).length === 0; second++) {
        await vi.advanceTimersByTimeAsync(1_000);
        await restarted.sync();
        await carol.sync();
      }
      // What a member sends a device of the creator beside the content is its control state (RSY-8),
      // which the device merges (CTL-25): here the same as its own.
      const answers = await fromCarol();
      expect(answers.length).toBeGreaterThan(0);
      for (const frame of answers) {
        expect(frame.kind === "resync-response" && frame.control).toMatchObject({
          targets: restoredControl.targets,
        });
      }
      const requests = await resyncRequestsFrom(messenger.inner, DOCUMENT_ID, "alice");
      const request = requests[requests.length - 1];
      if (!request) {
        throw new Error("expected the restarted creator's resync request");
      }
      expect(answers[0]?.kind === "resync-response" && answers[0].respondsTo).toBe(request.id);
      await restarted.sync();

      expect(getPlainText(restarted.fragment)).toBe("alice-text");
      expect(restarted.hasCompletedBootstrap).toBe(true);
      expect(restarted.controlState).toEqual(restoredControl);
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
    await alice.setMembership("carol", "write"); // named before she joins (LIF-9)
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

  /**
   * Alice, with her errors collected, writes `text` and answers bob's join over `port`; `refuse`
   * decides which of her answer's sends fail.
   */
  async function answerRefusedForGood(
    port: FlakySendPort,
    refuse: (answerSend: number) => unknown,
    text = "x".repeat(3000),
  ) {
    const errors: unknown[] = [];
    const alice = await DocumentEngine.create(
      DOCUMENT_ID,
      "alice",
      port,
      (error) => errors.push(error),
      AS_ALICE,
    );
    alice.edit((fragment) => insertPlainText(fragment, 0, text));
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

  it("reports an answer in pieces refused for good once, and does not count it as a change of its own (SND-8)", {
    timeout: 60_000,
  }, async () => {
    const port = new FlakySendPort();
    port.limitTo(MIN_MESSAGE_BYTES);
    const refusal = new TransportSendError("rejected", "not this piece");
    const { alice, errors, answerSends } = await answerRefusedForGood(
      port,
      (n) => (n === 1 ? refusal : undefined),
      "x".repeat(PASTE), // the answer goes in three pieces
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
          controlClock: null,
          controlDigest: null,
          all: false,
          force: false,
          stateVector: new Uint8Array([0]),
          // What a joiner with nothing states: it deleted nothing (Appendix D). Another digest beside
          // an empty vector would be evidence of a lost deletion at every receiver (LOS-12).
          stateDigest: "96a296d224f285c6",
        }),
      );
    }
    await alice.sync();
    const answers = async () =>
      (await messenger.receive(DOCUMENT_ID, "alice")).filter(
        (d) => decodeFrame(d.payload).kind === "resync-response",
      ).length;
    const sent = await answers();
    await vi.advanceTimersByTimeAsync(10_000);
    await alice.sync();
    // At most one answer per throttle interval, however many requests are held.
    expect((await answers()) - sent).toBeLessThanOrEqual(1);

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

    // The creator had not read Carol's edit either: it notices the same, and asks; its first
    // request does not ask all, so Carol answers only its repeat, at her turn (RSY-20, RSY-21).
    // Bob's repeats ask all too, and the creator answers him at once: his alarm ends with an answer
    // that carries control state (LOS-19), whoever brought him Carol's edit first.
    const truncated = (engine: DocumentEngine) =>
      engine.syncHealth.suspicions.some((suspicion) => suspicion.kind === "history-truncated");
    let ticks = 0;
    for (
      ;
      ticks < 150 &&
      (getPlainText(bob.fragment) === "" || getPlainText(alice.fragment) === "" || truncated(bob));
      ticks += 1
    ) {
      await vi.advanceTimersByTimeAsync(1_100);
      await alice.sync();
      await carol.sync();
      await bob.sync();
    }
    expect(getPlainText(alice.fragment)).toBe("carol's words");
    expect(getPlainText(bob.fragment)).toBe("carol's words");
    // The creator's first request expires (10 s), its repeat is spaced (20 s), Carol's turn comes
    // within the window (30 s), and Bob's spaced repeat follows: 30 to 83 ticks of 1.1 s in 200
    // runs.
    expect(ticks).toBeLessThan(120);
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
    await alice.setMembership("carol", "write"); // named before she joins (LIF-9)
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
    // Carol's report carried her lost edit again (SND-27); what else the bridge lost, nothing shows.
    expect(getPlainText(bob.fragment)).toBe("carol's words");
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
    // Bob is away: nobody answers. The request for the gap asks all at once (RSY-21), so it reached
    // every member, and once it expires unanswered the alarm ends (LOS-20).
    await vi.advanceTimersByTimeAsync(1_100);
    await alice.sync();
    expect(alice.syncHealth.resync.state).toBe("requested");
    expect(alice.syncHealth.suspicions.map((s) => s.kind)).toContain("history-truncated");
    for (
      let tick = 0;
      tick < 60 && alice.syncHealth.resync.lastOutcome !== "unanswered";
      tick += 1
    ) {
      await vi.advanceTimersByTimeAsync(1_100);
      await alice.sync();
    }
    const requests = (await port.inner.receive(DOCUMENT_ID, "alice"))
      .filter((d) => d.sender === "alice")
      .map((d) => decodeFrame(d.payload))
      .filter((frame) => frame.kind === "resync-request");
    expect(requests.map((frame) => frame.kind === "resync-request" && frame.all)).toStrictEqual([
      true,
    ]);
    expect(alice.syncHealth.resync.lastOutcome).toBe("unanswered");
    expect(alice.syncHealth.suspicions.map((s) => s.kind)).not.toContain("history-truncated");
    expect(bob.hasCompletedBootstrap).toBe(true);
  });

  it("ends the creator's alarm by a member's answer too: one that would carry control state answers a request that asks regardless (RSY-17, LOS-19)", async () => {
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
    // Bob lacks nothing the creator has, but holds his report to carry, and the request has force:
    // he answers its repeat, which asks all, at his turn (RSY-20, RSY-21).
    for (let tick = 0; tick < 60 && alice.syncHealth.resync.lastOutcome !== "answered"; tick += 1) {
      await vi.advanceTimersByTimeAsync(1_100);
      await alice.sync();
      await bob.sync();
    }
    expect(alice.syncHealth.resync.lastOutcome).toBe("answered");
    expect(alice.syncHealth.suspicions.map((s) => s.kind)).not.toContain("history-truncated");
  });

  it("does not end the creator's alarm by an answer without control state: content alone, from another device of the creator that is not bootstrapped, brings back no decision the window dropped (LOS-19)", async () => {
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
    const request = (await port.inner.receive(DOCUMENT_ID, "observer"))
      .filter((d) => d.sender === "alice")
      .map((d) => decodeFrame(d.payload))
      .filter((frame) => frame.kind === "resync-request")
      .at(-1);
    if (request?.kind !== "resync-request") throw new Error("no request of the creator");
    // Another device of Alice's that is not bootstrapped answers at once, with its content and
    // `control: null` (RSY-8).
    await port.send(
      DOCUMENT_ID,
      "alice",
      encodeResyncResponseFrame({
        documentId: DOCUMENT_ID,
        respondsTo: request.requestId,
        update: encodeUpdate(alice.document),
        control: null,
        state: {
          stateVector: encodeStateVector(alice.document),
          stateDigest: digestOf(encodeDeletions(alice.document)),
        },
      }),
    );
    await alice.sync();
    expect(alice.syncHealth.resync.lastOutcome).toBe("answered");
    expect(alice.syncHealth.suspicions.map((s) => s.kind)).toContain("history-truncated");
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

describe("an answer to a request sent before a truncated history was noticed (LOS-19)", () => {
  const OPTS = { ...IMMEDIATE, creatorMemberId: "alice" };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** What `member` sent of resync requests, from the `skip`th on: whether each forced its answer. */
  const forcedRequests = async (port: RestartingBridgePort, member: MemberId, skip: number) =>
    (await port.inner.receive(DOCUMENT_ID, "observer"))
      .filter((d) => d.sender === member)
      .map((d) => decodeFrame(d.payload))
      .flatMap((frame) => (frame.kind === "resync-request" ? [frame.force] : []))
      .slice(skip);

  it("is applied and ends nothing: the evidence stays, a request with `force` goes, and the answer to that one ends it", {
    timeout: 30_000,
  }, async () => {
    const port = new RestartingBridgePort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, OPTS);
    await alice.setMembership("bob", "write");
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, OPTS);
    for (let tick = 0; tick < 5; tick += 1) {
      await vi.advanceTimersByTimeAsync(1_100);
      await alice.sync();
      await bob.sync();
    }
    expect(bob.hasCompletedBootstrap).toBe(true);
    // Bob lacks Alice's edit and asks; her answer, with her control state, is late on its way to him.
    alice.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
    await vi.advanceTimersByTimeAsync(10);
    const lost = new Set((await port.inner.receive(DOCUMENT_ID, "bob")).map((d) => d.id));
    port.lostFor.set("bob", lost);
    const before = (await forcedRequests(port, "bob", 0)).length;
    await bob.requestResync();
    await alice.sync();
    await vi.advanceTimersByTimeAsync(10);
    const answer = (await port.inner.receive(DOCUMENT_ID, "observer")).at(-1) as Delivery;
    expect(decodeFrame(answer.payload)).toMatchObject({
      kind: "resync-response",
      control: expect.objectContaining({ closed: false }),
    });
    lost.add(answer.id);
    expect(await forcedRequests(port, "bob", before)).toStrictEqual([false]);
    // Then the bridge restarts: the first read after it is a truncated history (LOS-8).
    port.down = true;
    await expect(bob.sync()).rejects.toThrow("not answering");
    port.down = false;
    await bob.sync();
    expect(bob.syncHealth.suspicions.map((s) => s.kind)).toContain("history-truncated");
    // The answer to the request made before arrives: applied, it ends nothing.
    lost.clear();
    await bob.sync();
    expect(getPlainText(bob.fragment)).toBe("Plan");
    expect(bob.syncHealth.suspicions.map((s) => s.kind)).toContain("history-truncated");
    // Its slot free, Bob asks with `force` (LOS-19), and the answer to that request ends the evidence.
    for (
      let tick = 0;
      tick < 10 && (await forcedRequests(port, "bob", before)).length < 2;
      tick += 1
    ) {
      await vi.advanceTimersByTimeAsync(1_100);
      await bob.sync();
    }
    expect(await forcedRequests(port, "bob", before)).toStrictEqual([false, true]);
    for (let tick = 0; tick < 5; tick += 1) {
      await vi.advanceTimersByTimeAsync(1_100);
      await alice.sync();
      await bob.sync();
    }
    expect(bob.syncHealth.suspicions.map((s) => s.kind)).not.toContain("history-truncated");
    expect(await forcedRequests(port, "bob", before)).toStrictEqual([false, true]);
  });

  it("also where it bootstraps: the answer to a joiner's first request bootstraps him, and the evidence stays until the answer to his request with `force` (RSY-14)", {
    timeout: 30_000,
  }, async () => {
    const port = new RestartingBridgePort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, OPTS);
    await alice.setMembership("bob", "write");
    alice.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
    await vi.advanceTimersByTimeAsync(1_100);
    await alice.sync();
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, OPTS);
    const lost = new Set<DeliveryId>();
    port.lostFor.set("bob", lost);
    // Alice answers his first request; the answer is late on its way to him.
    await vi.advanceTimersByTimeAsync(10);
    await alice.sync();
    await vi.advanceTimersByTimeAsync(10);
    const answer = (await port.inner.receive(DOCUMENT_ID, "observer")).at(-1) as Delivery;
    expect(decodeFrame(answer.payload)).toMatchObject({ kind: "resync-response" });
    lost.add(answer.id);
    expect(await forcedRequests(port, "bob", 0)).toStrictEqual([false]);
    port.down = true;
    await expect(bob.sync()).rejects.toThrow("not answering");
    port.down = false;
    await bob.sync();
    expect(bob.syncHealth.suspicions.map((s) => s.kind)).toContain("history-truncated");
    expect(bob.hasCompletedBootstrap).toBe(false);
    lost.clear();
    await bob.sync();
    expect(bob.hasCompletedBootstrap).toBe(true);
    expect(bob.syncHealth.suspicions.map((s) => s.kind)).toContain("history-truncated");
    for (let tick = 0; tick < 10; tick += 1) {
      await vi.advanceTimersByTimeAsync(1_100);
      await alice.sync();
      await bob.sync();
    }
    expect(await forcedRequests(port, "bob", 0)).toStrictEqual([false, true]);
    expect(bob.syncHealth.suspicions.map((s) => s.kind)).not.toContain("history-truncated");
  });

  it("also where it was sent with `force` for an earlier truncated history: a copy of that answer, arriving after a second one was noticed, ends nothing of it", {
    timeout: 30_000,
  }, async () => {
    const port = new RestartingBridgePort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, OPTS);
    await alice.setMembership("bob", "write");
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, OPTS);
    for (let tick = 0; tick < 5; tick += 1) {
      await vi.advanceTimersByTimeAsync(1_100);
      await alice.sync();
      await bob.sync();
    }
    expect(bob.hasCompletedBootstrap).toBe(true);
    const truncated = () => bob.syncHealth.suspicions.some((s) => s.kind === "history-truncated");
    /** The bridge restarts: the first read after it is a truncated history (LOS-8). */
    const restart = async () => {
      port.down = true;
      await expect(bob.sync()).rejects.toThrow("not answering");
      port.down = false;
      await bob.sync();
      expect(truncated()).toBe(true);
    };
    /** Alice's answers to Bob's latest request, which went with `force`. */
    const answersToForced = async () => {
      const frames = (await port.inner.receive(DOCUMENT_ID, "observer")).map((d) => ({
        d,
        frame: decodeFrame(d.payload),
      }));
      const forced = frames
        .filter(({ d, frame }) => d.sender === "bob" && frame.kind === "resync-request")
        .at(-1)?.frame;
      if (forced?.kind !== "resync-request" || !forced.force)
        throw new Error("no request of Bob's with force");
      return frames
        .filter(
          ({ d, frame }) =>
            d.sender === "alice" &&
            frame.kind === "resync-response" &&
            frame.respondsTo === forced.requestId,
        )
        .map(({ d }) => d);
    };

    // The first truncated history: Bob's request with `force` is answered, and the answer ends it.
    await restart();
    for (let tick = 0; tick < 5 && truncated(); tick += 1) {
      await vi.advanceTimersByTimeAsync(1_100);
      await alice.sync();
      await bob.sync();
    }
    expect(truncated()).toBe(false);
    const first = await answersToForced();
    expect(first.length).toBeGreaterThan(0);
    const before = (await forcedRequests(port, "bob", 0)).length;

    // The second: Bob's request with `force` goes, and Alice's answer to it is late on its way to him.
    await restart();
    for (
      let tick = 0;
      tick < 5 && (await forcedRequests(port, "bob", before)).length === 0;
      tick += 1
    ) {
      await vi.advanceTimersByTimeAsync(1_100);
      await bob.sync();
    }
    expect(await forcedRequests(port, "bob", before)).toStrictEqual([true]);
    // Alice answers at her turn; Bob does not read meanwhile.
    for (let tick = 0; tick < 5 && (await answersToForced()).length === 0; tick += 1) {
      await vi.advanceTimersByTimeAsync(1_100);
      await alice.sync();
    }
    const second = await answersToForced();
    expect(second.length).toBeGreaterThan(0);
    const lost = new Set(second.map((d) => d.id));
    port.lostFor.set("bob", lost);
    // A copy of the answer to the first request with `force` arrives, as a bridge may offer it again:
    // that request was sent before the second truncated history was noticed, and its answer ends nothing.
    for (const delivery of first) await port.inner.send(DOCUMENT_ID, "alice", delivery.payload);
    await bob.sync();
    expect(truncated()).toBe(true);
    // The answer to the request sent with `force` after it ends it, and no further request goes.
    lost.clear();
    await bob.sync();
    expect(truncated()).toBe(false);
    for (let tick = 0; tick < 5; tick += 1) {
      await vi.advanceTimersByTimeAsync(1_100);
      await alice.sync();
      await bob.sync();
    }
    expect(truncated()).toBe(false);
    expect(await forcedRequests(port, "bob", before)).toStrictEqual([true]);
  });

  it("counts a request by when it is sent: one made before, waiting for the floor, goes with `force` once the truncated history was noticed, and its answer ends it", {
    timeout: 30_000,
  }, async () => {
    const port = new RestartingBridgePort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, OPTS);
    await alice.setMembership("bob", "write");
    alice.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, {
      ...OPTS,
      syncPolicy: { minIntervalMs: 20_000 },
    });
    for (let tick = 0; tick < 60 && !bob.hasCompletedBootstrap; tick += 1) {
      await vi.advanceTimersByTimeAsync(1_100);
      await alice.sync();
      await bob.sync();
    }
    expect(bob.hasCompletedBootstrap).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    await alice.sync();
    await bob.sync();
    const truncated = () => bob.syncHealth.suspicions.some((s) => s.kind === "history-truncated");
    expect(truncated()).toBe(false);
    // Bob's edit takes the floor (SND-15). Told of an absence, he owes a start request (RSY-1): his
    // next poll makes it, and it waits in the scheduler for the floor, made but not yet written.
    const before = (await forcedRequests(port, "bob", 0)).length;
    bob.edit((fragment) => insertPlainText(fragment, 0, "b"));
    await vi.advanceTimersByTimeAsync(1_000);
    bob.noteAbsence(11 * 60_000); // longer than the 10 min of Appendix B
    await bob.sync();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(bob.syncHealth.resync.state).toBe("requested");
    expect(await forcedRequests(port, "bob", before)).toStrictEqual([]);
    // Then the bridge restarts: the first read after it is a truncated history (LOS-8).
    port.down = true;
    await expect(bob.sync()).rejects.toThrow("not answering");
    port.down = false;
    await bob.sync();
    expect(truncated()).toBe(true);
    // Written as it goes out, the request asks with `force`, and its answer ends the evidence: no
    // second request (LOS-19).
    for (let tick = 0; tick < 30 && truncated(); tick += 1) {
      await vi.advanceTimersByTimeAsync(1_100);
      await alice.sync();
      await bob.sync();
    }
    expect(truncated()).toBe(false);
    expect(await forcedRequests(port, "bob", before)).toStrictEqual([true]);
  });
});

/**
 * One member's view of a shared messenger through its own bridge (TRN-18, TRN-19): deliveries the
 * bridge accepted but lost before the member's engine read them, a new epoch on `restart()`, and,
 * on `cut()`, an answer that says `truncated` — with what came after the cursor, or empty, as a
 * window that holds nothing new. Without `cursor`, it offers `receive` alone (LOS-8).
 */
class CuttingBridgePort implements MessengerPort {
  readonly lost = new Set<DeliveryId>();
  /** Every delivery the member's engine was offered. */
  readonly read = new Set<DeliveryId>();
  readonly receiveSince?: MessengerPort["receiveSince"];
  readonly instance?: MessengerPort["instance"];
  #epoch = 1;
  #cut: "with-deliveries" | "empty" | undefined;
  constructor(
    readonly inner: InMemoryMessengerPort,
    cursor = true,
  ) {
    if (cursor) {
      this.receiveSince = async (documentId, member, after) => {
        const visible = await this.#visible(documentId, member);
        const at = after === undefined ? -1 : visible.findIndex((d) => d.id === after);
        const cut = this.#cut;
        this.#cut = undefined;
        const deliveries = cut === "empty" ? [] : at === -1 ? visible : visible.slice(at + 1);
        for (const d of deliveries) this.read.add(d.id);
        return { deliveries, truncated: cut !== undefined || (after !== undefined && at === -1) };
      };
      this.instance = async () => `epoch-${this.#epoch}`;
    }
  }
  restart() {
    this.#epoch += 1;
  }
  cut(how: "with-deliveries" | "empty" = "with-deliveries") {
    this.#cut = how;
  }
  /** Loses for good what was sent and not yet read (BRG-17). */
  async loseUnread(documentId: DocumentId, member: MemberId) {
    for (const d of await this.inner.receive(documentId, member))
      if (!this.read.has(d.id)) this.lost.add(d.id);
  }
  createDocument(documentId: DocumentId, creator: MemberId) {
    return this.inner.createDocument(documentId, creator);
  }
  send(documentId: DocumentId, sender: MemberId, payload: string) {
    return this.inner.send(documentId, sender, payload);
  }
  async receive(documentId: DocumentId, member: MemberId) {
    const visible = await this.#visible(documentId, member);
    for (const d of visible) this.read.add(d.id);
    return visible;
  }
  async #visible(documentId: DocumentId, member: MemberId) {
    return (await this.inner.receive(documentId, member)).filter((d) => !this.lost.has(d.id));
  }
  listChannels(member: MemberId) {
    return this.inner.listChannels(member);
  }
}

describe("a history found truncated anew while the evidence stands (LOS-19, LOS-20)", () => {
  const OPTS = { ...IMMEDIATE, creatorMemberId: "alice" };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The resync requests `member` sent: for each, whether it went with `force`, and its id. */
  const requestsOf = async (inner: InMemoryMessengerPort, member: MemberId) =>
    (await inner.receive(DOCUMENT_ID, "observer"))
      .filter((d) => d.sender === member)
      .map((d) => decodeFrame(d.payload))
      .flatMap((frame) => (frame.kind === "resync-request" ? [frame] : []));
  /** Alice's answers to `requestId`. */
  const answersTo = async (inner: InMemoryMessengerPort, requestId: string) =>
    (await inner.receive(DOCUMENT_ID, "observer")).filter((d) => {
      const frame = decodeFrame(d.payload);
      return (
        d.sender === "alice" && frame.kind === "resync-response" && frame.respondsTo === requestId
      );
    });

  /**
   * Alice and Bob, bootstrapped with `write`, Bob through his own bridge. A supplied profile lets a
   * test say that what Bob holds for missing predecessors is over the bound (LOS-23).
   */
  async function pair(cursor: boolean) {
    const inner = new InMemoryMessengerPort();
    const pending = { over: false };
    const base = profileFor(YJS_PARAGRAPHS_1);
    const profile: DocumentProfile = {
      ...base,
      id: "com.example.bounded/1",
      pendingBytes: (document) => (pending.over ? 33 * 1024 * 1024 : base.pendingBytes(document)),
      giveUpPending: (document) => {
        pending.over = false;
        return base.giveUpPending(document);
      },
    };
    const withProfile = { profile: profile.id, profiles: [profile] };
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", inner, undefined, {
      ...OPTS,
      ...withProfile,
    });
    await alice.setMembership("bob", "write");
    const port = new CuttingBridgePort(inner, cursor);
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, {
      ...OPTS,
      ...withProfile,
    });
    for (let tick = 0; tick < 5; tick += 1) {
      await vi.advanceTimersByTimeAsync(1_100);
      await alice.sync();
      await bob.sync();
    }
    expect(bob.hasCompletedBootstrap).toBe(true);
    const truncated = () => bob.syncHealth.suspicions.some((s) => s.kind === "history-truncated");
    return { inner, port, alice, bob, pending, truncated };
  }

  /**
   * After a first truncated history, Bob's request with `force` goes, and Alice's answer to it, taken
   * while he holds `write`, is late on its way to him. Then she gives him `read`, and his bridge loses
   * that and all she sends after it before his engine reads it; `secondLoss` makes the next truncated
   * history he notices, and Alice's late answer arrives after it, as a messenger delivers what it held.
   */
  async function lateAnswerAcrossASecondLoss(
    setup: Awaited<ReturnType<typeof pair>>,
    firstLoss: () => Promise<void>,
    secondLoss: () => Promise<void>,
  ) {
    const { inner, port, alice, bob, truncated } = setup;
    const before = (await requestsOf(inner, "bob")).length;
    await firstLoss();
    expect(truncated()).toBe(true);
    for (let tick = 0; tick < 5 && (await requestsOf(inner, "bob")).length === before; tick += 1) {
      await vi.advanceTimersByTimeAsync(1_100);
      await bob.sync();
    }
    const first = (await requestsOf(inner, "bob")).slice(before);
    expect(first.map((request) => request.force)).toStrictEqual([true]);
    const firstId = first[0]?.requestId as string;
    // Alice answers at her turn; Bob does not read meanwhile, and the answer is held back for him.
    for (let tick = 0; tick < 5 && (await answersTo(inner, firstId)).length === 0; tick += 1) {
      await vi.advanceTimersByTimeAsync(1_100);
      await alice.sync();
    }
    const late = await answersTo(inner, firstId);
    expect(late).toHaveLength(1);
    const answer = late[0] as Delivery;
    expect(decodeFrame(answer.payload)).toMatchObject({
      control: expect.objectContaining({ closed: false }),
    });
    port.lost.add(answer.id);
    await alice.setMembership("bob", "read");
    await vi.advanceTimersByTimeAsync(11_000); // her report goes too, after her `control` frame sent again (SND-27)
    await alice.sync();
    await port.loseUnread(DOCUMENT_ID, "bob");
    await secondLoss();
    expect(truncated()).toBe(true);
    expect(bob.permissionOf("bob")).toBe("write");
    // The late answer to the request sent before the second truncated history ends nothing of it.
    const arrived = await inner.send(DOCUMENT_ID, "alice", answer.payload);
    await bob.sync();
    expect(port.read.has(arrived)).toBe(true);
    expect(bob.syncHealth.resync.state).toBe("idle");
    expect(truncated()).toBe(true);
    expect(bob.permissionOf("bob")).toBe("write");
    // Its slot free, Bob asks with `force` again (LOS-19, LOS-6), and the answer to that one ends it.
    for (let tick = 0; tick < 120 && truncated(); tick += 1) {
      await vi.advanceTimersByTimeAsync(1_100);
      await alice.sync();
      await bob.sync();
    }
    expect(truncated()).toBe(false);
    expect(bob.permissionOf("bob")).toBe("read");
    const sent = (await requestsOf(inner, "bob")).slice(before);
    expect(sent.map((request) => request.force)).toStrictEqual([true, true]);
  }

  it("by a second epoch of the bridge: an answer to the request sent after the first ends nothing, and the next request with `force` goes and ends it (LOS-9)", {
    timeout: 30_000,
  }, async () => {
    const setup = await pair(true);
    const { port, bob } = setup;
    const restart = async () => {
      port.restart();
      port.cut();
      await bob.sync();
    };
    await lateAnswerAcrossASecondLoss(setup, restart, restart);
  });

  it("by a window that moved past everything read, as LOS-8 sees it without a cursor: the same", {
    timeout: 30_000,
  }, async () => {
    const setup = await pair(false);
    const { port, alice, bob } = setup;
    // The first: the bridge does not answer, and the first answer after it is a truncated history.
    const failure = async () => {
      const receive = port.receive.bind(port);
      port.receive = async () => {
        throw new Error("the bridge is not answering");
      };
      await expect(bob.sync()).rejects.toThrow("not answering");
      port.receive = receive;
      await bob.sync();
    };
    // The second: everything Bob read slid out of the window, and what he reads now is newer.
    const windowMoved = async () => {
      for (const id of port.read) port.lost.add(id);
      alice.edit((fragment) => insertPlainText(fragment, 0, "later"));
      await vi.advanceTimersByTimeAsync(10);
      await bob.sync();
    };
    await lateAnswerAcrossASecondLoss(setup, failure, windowMoved);
  });

  it("by what it gave up for missing predecessors: the same (LOS-23)", {
    timeout: 30_000,
  }, async () => {
    const setup = await pair(true);
    const { port, alice, bob, pending } = setup;
    const restart = async () => {
      port.restart();
      await bob.sync();
    };
    const givenUp = async () => {
      pending.over = true;
      alice.edit((fragment) => insertPlainText(fragment, 0, "later"));
      await vi.advanceTimersByTimeAsync(10);
      await bob.sync();
      expect(pending.over).toBe(false);
    };
    await lateAnswerAcrossASecondLoss(setup, restart, givenUp);
  });

  it("not by the bridge saying so again for the same cursor: that is the loss it told of, and the answer to the request sent after it ends it", {
    timeout: 30_000,
  }, async () => {
    const { inner, port, alice, bob, truncated } = await pair(true);
    const before = (await requestsOf(inner, "bob")).length;
    // An empty answer that says `truncated`: the cursor stays where it was.
    port.cut("empty");
    await bob.sync();
    expect(truncated()).toBe(true);
    for (let tick = 0; tick < 5 && (await requestsOf(inner, "bob")).length === before; tick += 1) {
      await vi.advanceTimersByTimeAsync(1_100);
      await bob.sync();
    }
    const [forced] = (await requestsOf(inner, "bob")).slice(before);
    expect(forced?.force).toBe(true);
    for (
      let tick = 0;
      tick < 5 && (await answersTo(inner, forced?.requestId as string)).length === 0;
      tick += 1
    ) {
      await vi.advanceTimersByTimeAsync(1_100);
      await alice.sync();
    }
    // The next read, from the same cursor, says `truncated` again, and brings the answer.
    port.cut();
    await bob.sync();
    expect(truncated()).toBe(false);
    for (let tick = 0; tick < 30; tick += 1) {
      await vi.advanceTimersByTimeAsync(1_100);
      await alice.sync();
      await bob.sync();
    }
    expect(truncated()).toBe(false);
    expect(
      (await requestsOf(inner, "bob")).slice(before).map((request) => request.force),
    ).toStrictEqual([true]);
  });

  it("on a gap that rests: found truncated anew, it is not woken; once an absence wakes it, its request with `force` goes, and only that request's answer ends it (LOS-26)", {
    timeout: 30_000,
  }, async () => {
    const { inner, port, alice, bob, truncated } = await pair(true);
    const before = (await requestsOf(inner, "bob")).length;
    const forced = async () =>
      (await requestsOf(inner, "bob")).slice(before).map((request) => request.force);
    const resting = () =>
      bob.syncHealth.suspicions.some((s) => s.kind === "history-truncated" && s.resting === true);
    // Alice is away: Bob's tries with `force` go unanswered until the gap rests (LOS-6).
    port.restart();
    await bob.sync();
    for (let tick = 0; tick < 240 && !resting(); tick += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
      await bob.sync();
    }
    expect(resting()).toBe(true);
    expect(await forced()).toStrictEqual(Array.from({ length: MAX_GAP_TRIES }, () => true));
    // Alice comes back and answers the last; her answer is late on its way to Bob.
    const lastId = (await requestsOf(inner, "bob")).at(-1)?.requestId as string;
    for (let tick = 0; tick < 5 && (await answersTo(inner, lastId)).length === 0; tick += 1) {
      await vi.advanceTimersByTimeAsync(1_100);
      await alice.sync();
    }
    const [late] = await answersTo(inner, lastId);
    expect(late).toBeDefined();
    await port.loseUnread(DOCUMENT_ID, "bob");
    // Found truncated anew, the gap rests on: no request goes.
    port.restart();
    await bob.sync();
    for (let tick = 0; tick < 90; tick += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
      await bob.sync();
    }
    expect(truncated()).toBe(true);
    expect(resting()).toBe(true);
    expect(await forced()).toHaveLength(MAX_GAP_TRIES);
    // The answer to the request sent before the second truncated history arrives and ends nothing.
    const arrived = await inner.send(DOCUMENT_ID, "alice", (late as Delivery).payload);
    await bob.sync();
    expect(port.read.has(arrived)).toBe(true);
    expect(truncated()).toBe(true);
    // An absence the application tells of wakes it (LOS-26): its request goes with `force`, and its
    // answer ends the evidence.
    bob.noteAbsence(11 * 60_000);
    for (let tick = 0; tick < 5 && (await forced()).length === MAX_GAP_TRIES; tick += 1) {
      await bob.sync();
      await vi.advanceTimersByTimeAsync(1_100);
    }
    expect(await forced()).toStrictEqual(Array.from({ length: MAX_GAP_TRIES + 1 }, () => true));
    expect(truncated()).toBe(true);
    for (let tick = 0; tick < 10 && truncated(); tick += 1) {
      await vi.advanceTimersByTimeAsync(1_100);
      await alice.sync();
      await bob.sync();
    }
    expect(truncated()).toBe(false);
    expect(await forced()).toHaveLength(MAX_GAP_TRIES + 1);
  });

  it("on a device of the creator: a request to all sent before the second ends nothing when it expires unanswered, one sent after it does (LOS-20)", {
    timeout: 30_000,
  }, async () => {
    const inner = new InMemoryMessengerPort();
    const port = new CuttingBridgePort(inner);
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, OPTS);
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", inner, undefined, OPTS);
    for (let tick = 0; tick < 3; tick += 1) {
      await vi.advanceTimersByTimeAsync(1_100);
      await alice.sync();
      await bob.sync();
    }
    expect(bob.hasCompletedBootstrap).toBe(true);
    const truncated = () => alice.syncHealth.suspicions.some((s) => s.kind === "history-truncated");
    const before = (await requestsOf(inner, "alice")).length;
    // Bob is away from here on: nobody answers.
    port.restart();
    await alice.sync();
    expect(truncated()).toBe(true);
    for (
      let tick = 0;
      tick < 5 && (await requestsOf(inner, "alice")).length === before;
      tick += 1
    ) {
      await vi.advanceTimersByTimeAsync(1_100);
      await alice.sync();
    }
    expect(
      (await requestsOf(inner, "alice")).slice(before).map((request) => request.all),
    ).toStrictEqual([true]);
    // Her bridge restarts again while the request waits for an answer.
    await vi.advanceTimersByTimeAsync(1_100);
    port.restart();
    await alice.sync();
    for (
      let tick = 0;
      tick < 60 && alice.syncHealth.resync.lastOutcome !== "unanswered";
      tick += 1
    ) {
      await vi.advanceTimersByTimeAsync(1_100);
      await alice.sync();
    }
    expect(alice.syncHealth.resync.lastOutcome).toBe("unanswered");
    expect(truncated()).toBe(true);
    // The next request to all goes as LOS-6 says; once it expires unanswered, the evidence ends.
    for (let tick = 0; tick < 120 && truncated(); tick += 1) {
      await vi.advanceTimersByTimeAsync(1_100);
      await alice.sync();
    }
    expect(truncated()).toBe(false);
    expect(alice.syncHealth.resync.lastOutcome).toBe("unanswered");
    expect(
      (await requestsOf(inner, "alice")).slice(before).map((request) => request.all),
    ).toStrictEqual([true, true]);
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
    // One register, as alice decided it: merged again, it changes nothing (CTL-6, CTL-22).
    expect(bob.controlState.targets).toEqual(alice.controlState.targets);
    expect(Object.keys(bob.controlState.targets)).toEqual(["member:bob"]);
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
    await alice.setMembership("bob", "write"); // named before he joins (LIF-9)
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

/**
 * A paste larger than two frames of the smallest transport carry (TRN-23): its update goes as
 * Base64, four characters for every three bytes, so it takes three pieces (SND-17).
 */
const PASTE = 2 * MIN_MESSAGE_BYTES;

/**
 * An extension every answer carries (FRM-11) that leaves only `room` bytes of a frame of the
 * smallest transport (TRN-23) for the rest of the answer. What takes that room beside the control
 * state — at 4 MiB above all the responder's state vector (§7.4) — counts the same (SND-18).
 */
function answerFiller(room: number): FrameExtension {
  return {
    name: "com.example.filler/1",
    values: { "resync-response": "f".repeat(MIN_MESSAGE_BYTES - room) },
  };
}

describe("the bounds of control state when the creator decides (CTL-37, SND-18)", () => {
  it("refuses a decision after which no answer could carry the control state, and nothing changes", async () => {
    const port = new FlakySendPort();
    port.limitTo(MIN_MESSAGE_BYTES);
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, {
      batchWindowMs: 0,
      creatorMemberId: "alice",
      extensions: [answerFiller(4_000)],
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
    expect(Math.max(...port.sentSizes)).toBeLessThanOrEqual(MIN_MESSAGE_BYTES);
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

  /**
   * A creator and a joiner who has bootstrapped, both on real timers' fake clock. With `grant`, the
   * joiner may write, granted before it joins (LIF-9, CTL-13); without, its permission stays unknown
   * — for a test of the creator's sending, or where a floor leaves no room for the grant before the
   * join.
   */
  async function pair(
    port: MessengerPort,
    aliceOptions: DocumentEngineOptions = {},
    bobOptions: DocumentEngineOptions = {},
    onBobError: (error: unknown, context: string) => void = () => {},
    grant = true,
  ) {
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, {
      ...AS_ALICE,
      ...aliceOptions,
    });
    if (grant) await alice.setMembership("bob", "write");
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
    await vi.advanceTimersByTimeAsync(REPORT_AFTER_MS); // alice's report after her decision has gone (SND-11)
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
    await vi.advanceTimersByTimeAsync(REPORT_AFTER_MS); // alice's report after her decision has gone (SND-11)
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
    await vi.advanceTimersByTimeAsync(REPORT_AFTER_MS); // alice's report after her decision has gone (SND-11)
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

  it("keeps the mark until every part of a repair too large for one message has gone out (SND-8)", {
    timeout: 60_000,
  }, async () => {
    const port = new FlakySendPort();
    port.limitTo(MIN_MESSAGE_BYTES);
    const slow = { syncPolicy: { minIntervalMs: 1000 } };
    const { alice, bob } = await pair(port, slow, slow, () => {}, false);
    // At one message a second, bob's join request, alice's grant (LIF-9) and her answer each wait
    // for the floor.
    const granted = alice.setMembership("bob", "write");
    for (let tick = 0; tick < 10 && !bob.mayEdit; tick += 1) {
      await vi.advanceTimersByTimeAsync(1000);
      await alice.sync();
      await bob.sync();
    }
    await granted;
    expect(bob.mayEdit).toBe(true);
    port.failNextSends(new TransportSendError("rejected", "the provider refused it"));
    bob.edit((fragment) => insertPlainText(fragment, 0, "x".repeat(PASTE)));
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
    expect(getPlainText(alice.fragment)).toBe("x".repeat(PASTE));
  });

  it("keeps the mark when a middle part of the repair is refused for good (SND-8)", {
    timeout: 60_000,
  }, async () => {
    const port = new FlakySendPort();
    port.limitTo(MIN_MESSAGE_BYTES);
    const { bob } = await pair(port, {}, {}, () => {});
    port.failNextSends(new TransportSendError("rejected", "no"));
    bob.edit((fragment) => insertPlainText(fragment, 0, "x".repeat(PASTE)));
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
    port.limitTo(MIN_MESSAGE_BYTES);
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
    await vi.advanceTimersByTimeAsync(REPORT_AFTER_MS); // alice's report after her decision has gone (SND-11)
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
        const { alice, bob } = await pair(port, {}, {}, undefined, false);
        expect(bob.syncPolicy.minIntervalMs).toBe(30_000);
        expect(bob.transportProfile).toBe(SLOW_TRANSPORT);
        // The creator lets bob write (LIF-9): held at once (CTL-21), the frame at her next slot.
        const granted = alice.setMembership("bob", "write");
        await vi.advanceTimersByTimeAsync(30_000); // the join's resync request used the floor too (SND-2)
        await alice.sync(); // the creator answers the join — on its own floor
        await vi.advanceTimersByTimeAsync(30_000);
        await granted;
        await bob.sync(); // bootstrapped, and named: bob may edit now (CTL-13)
        expect(bob.mayEdit).toBe(true);

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
        const { bob } = await pair(
          port,
          {},
          { syncPolicy: { minIntervalMs: 0 } },
          undefined,
          false,
        );
        expect(bob.syncPolicy.minIntervalMs).toBe(15_000);
      });

      it("takes a policy with no opinion on the floor from the transport, and keeps a chosen value above it", async () => {
        const port = new FlakySendPort();
        port.profile = SLOW_TRANSPORT;
        const { bob } = await pair(
          port,
          {},
          { syncPolicy: { minIntervalMs: 90_000 } },
          undefined,
          false,
        );
        expect(bob.syncPolicy.minIntervalMs).toBe(90_000);
        expect(bob.syncPolicy.maxIntervalMs).toBe(120_000);
      });

      it("applies to the creator as well as to a joiner", async () => {
        const port = new FlakySendPort();
        port.profile = SLOW_TRANSPORT;
        const { alice } = await pair(port, {}, {}, undefined, false);
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
      const LIMIT = MIN_MESSAGE_BYTES;

      /** How many messages each port carried before a test's own actions — the join and its bootstrap. */
      const baselines = new WeakMap<FlakySendPort, number>();

      /** The kinds of the frames sent since `limitedPair` returned. */
      const frameKinds = async (port: FlakySendPort): Promise<string[]> =>
        (await port.inner.receive(DOCUMENT_ID, "alice"))
          .slice(baselines.get(port) ?? 0)
          .map((d) => decodeFrame(d.payload).kind);

      /**
       * Creator and joiner on a transport that carries at most `LIMIT` bytes a message, the least
       * every transport carries (TRN-23). The joiner stays unknown and only reads (CTL-13) unless
       * `grant` names it.
       */
      async function limitedPair(
        aliceOptions: DocumentEngineOptions = {},
        bobOptions: DocumentEngineOptions = {},
        configure: (port: FlakySendPort) => void = () => {},
        onBobError?: (error: unknown, context: string) => void,
        grant = false,
      ) {
        const port = new FlakySendPort();
        port.limitTo(LIMIT);
        configure(port);
        const both = await pair(port, aliceOptions, bobOptions, onBobError, grant);
        port.sentSizes.length = 0; // count from here
        baselines.set(port, (await port.inner.receive(DOCUMENT_ID, "alice")).length);
        return { port, ...both };
      }

      it("sends one big paste as parts, none over the limit, and the receiver ends up with all of it", {
        timeout: 60_000,
      }, async () => {
        const { port, alice, bob } = await limitedPair();
        // 8 MiB in one update.
        const text = "the quick brown fox jumps over the lazy dog ".repeat(PASTE / 44 + 1);
        alice.edit((fragment) => insertPlainText(fragment, 0, text));
        await vi.advanceTimersByTimeAsync(500);
        expect(port.sentSizes.length).toBeGreaterThan(2);
        expect(Math.max(...port.sentSizes)).toBeLessThanOrEqual(LIMIT);
        // Pieces are ordinary edits, each a valid update (SND-17).
        expect((await frameKinds(port)).filter((kind) => kind === "edit").length).toBeGreaterThan(
          2,
        );

        await bob.sync();
        expect(getPlainText(bob.fragment)).toBe(text);
        expect(bob.syncHealth.state).toBe("ok"); // nothing held back
      });

      it("spreads a long typed burst over several ordinary edits, each a usable prefix", {
        timeout: 60_000,
      }, async () => {
        const { port, alice, bob } = await limitedPair();
        // Edits of a quarter of a message each: two of them go together, three do not.
        let typed = "";
        for (let i = 0; i < 8; i += 1) {
          const chunk = String.fromCharCode(97 + i).repeat(LIMIT / 4);
          alice.edit((fragment) => insertPlainText(fragment, typed.length, chunk));
          typed += chunk;
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

      it("keeps what was typed after a big paste behind all of the paste's parts, and everything converges", {
        timeout: 60_000,
      }, async () => {
        const { port, alice, bob } = await limitedPair();
        alice.edit((fragment) => insertPlainText(fragment, 0, "x".repeat(PASTE)));
        alice.edit((fragment) => insertPlainText(fragment, PASTE, " and then this"));
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
        const replayed = replay.getXmlFragment("content").toString();
        expect(replayed).toContain("x".repeat(PASTE));
        expect(replayed).not.toContain("and then this");
        await bob.sync();
        expect(getPlainText(bob.fragment)).toBe(`${"x".repeat(PASTE)} and then this`);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(bob.syncHealth.state).toBe("ok");
      });

      it("shows the sender how many pieces are left, and the receiver applies each as it arrives, when the floor spaces them", {
        timeout: 60_000,
      }, async () => {
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
        alice.edit((fragment) => insertPlainText(fragment, 0, "y".repeat(PASTE)));
        await vi.advanceTimersByTimeAsync(2_000); // the first piece goes, one floor later
        expect(alice.sendStatus.partsQueued).toBeGreaterThan(1);
        expect(alice.hasPendingChanges).toBe(true);
        const before = alice.sendStatus.partsQueued;
        await bob.sync();
        // A piece is a valid update: what has arrived shows at once (PRF-1).
        const shown = getPlainText(bob.fragment).length;
        expect(shown).toBeGreaterThan(0);
        expect(shown).toBeLessThan(PASTE);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(alice.sendStatus.partsQueued).toBe(before - 1);
        await vi.advanceTimersByTimeAsync(60_000);
        await bob.sync();
        expect(getPlainText(bob.fragment)).toBe("y".repeat(PASTE));
        expect(alice.hasPendingChanges).toBe(false);
      });

      it("cuts a full-state answer to a joiner too, so a big document can still be joined", {
        timeout: 60_000,
      }, async () => {
        const { port, alice } = await limitedPair({}, {}, (p) => {
          p.noHistory = true;
        });
        alice.edit((fragment) => insertPlainText(fragment, 0, "abcdefghij".repeat(PASTE / 10)));
        await vi.advanceTimersByTimeAsync(2_000); // past the responder's one-answer-a-second throttle
        await alice.sync(); // baseline
        port.sentSizes.length = 0;

        const carol = await DocumentEngine.join(DOCUMENT_ID, "carol", port, undefined, AS_ALICE);
        await alice.sync(); // the creator answers carol's join with the whole document
        await vi.advanceTimersByTimeAsync(0); // its parts go out one after another
        expect(port.sentSizes.length).toBeGreaterThan(3); // carol's request, then the answer in parts
        expect(Math.max(...port.sentSizes)).toBeLessThanOrEqual(LIMIT);
        await carol.sync();
        expect(carol.hasCompletedBootstrap).toBe(true);
        expect(getPlainText(carol.fragment)).toBe("abcdefghij".repeat(PASTE / 10));
      });

      it("a manual resync of a big document goes out in parts as well", {
        timeout: 60_000,
      }, async () => {
        const { port, alice, bob } = await limitedPair();
        alice.edit((fragment) => insertPlainText(fragment, 0, "z".repeat(PASTE)));
        await vi.advanceTimersByTimeAsync(500);
        port.sentSizes.length = 0;
        await alice.resync();
        await vi.advanceTimersByTimeAsync(0);
        expect(port.sentSizes.length).toBeGreaterThan(2);
        expect(Math.max(...port.sentSizes)).toBeLessThanOrEqual(LIMIT);
        await bob.sync();
        expect(getPlainText(bob.fragment)).toBe("z".repeat(PASTE));
      });

      it("a piece that is lost is a gap like any lost message, noticed and healed by the state a peer sends back", {
        timeout: 60_000,
      }, async () => {
        const WATCHED = { syncPolicy: { maxIntervalMs: 20_000, expectedLatencyMs: 5_000 } };
        const { port, alice, bob } = await limitedPair(WATCHED, WATCHED, () => {}, undefined, true);
        // Bob types a big paste; one of its pieces is lost on the way.
        bob.edit((fragment) => insertPlainText(fragment, 0, "w".repeat(PASTE)));
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
        expect(shown).toBeLessThan(PASTE);

        await vi.advanceTimersByTimeAsync(5_000); // a latency: the gap is believed
        await alice.sync();
        expect(alice.syncHealth.suspicions).toEqual(
          expect.arrayContaining([expect.objectContaining({ kind: "pending-gap", sender: "bob" })]),
        );
        // She asks by herself; her first request does not ask all, her repeat does, and bob answers
        // it at his turn with what she lacks, itself in pieces (RSY-20, RSY-21).
        for (
          let second = 0;
          second < 120 && getPlainText(alice.fragment).length < PASTE;
          second++
        ) {
          await vi.advanceTimersByTimeAsync(1_000);
          await alice.sync();
          await bob.sync();
          await vi.advanceTimersByTimeAsync(0);
          await alice.sync();
        }
        expect(getPlainText(alice.fragment)).toBe("w".repeat(PASTE));
        await vi.advanceTimersByTimeAsync(30_000);
        await alice.sync();
        await bob.sync();
        await alice.sync();
        expect(alice.syncHealth.state).toBe("ok");
      });

      it("cannot cut anything when the limit leaves no room for a part: the change is dropped and reported once, and the client carries on", async () => {
        const errors: unknown[] = [];
        const tiny = new FlakySendPort();
        // The transport states the smallest size (TRN-23) but does not enforce it, so the document
        // can be created; an extension every edit carries takes all of it (FRM-11), so nothing can
        // be cut.
        tiny.profile = {
          bounds: { minIntervalMs: null, maxBytes: LIMIT },
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
          {
            creatorMemberId: "solo",
            extensions: [{ name: "com.example.filler/1", values: { edit: "f".repeat(LIMIT) } }],
          },
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

    describe("the report and noticing a loss", () => {
      // 5 s to arrive: a gap believed after 5 s. A report goes 10 s after the last message of its own,
      // whatever the pacing (SND-11).
      const WATCHED = { syncPolicy: { maxIntervalMs: 20_000, expectedLatencyMs: 5_000 } };

      const heartbeatsFrom = async (port: FlakySendPort, sender: string) =>
        (await port.inner.receive(DOCUMENT_ID, "alice"))
          .filter((d) => d.sender === sender && decodeFrame(d.payload).kind === "heartbeat")
          .map((d) => decodeFrame(d.payload));

      const lastEditOf = async (port: FlakySendPort, sender: string) =>
        (await port.inner.receive(DOCUMENT_ID, "alice"))
          .filter((d) => d.sender === sender && decodeFrame(d.payload).kind === "edit")
          .map((d) => decodeFrame(d.payload))
          .at(-1);

      it("is sent once, 10 s after the last edit went out, with the sender's state vector and that edit again (SND-11, SND-27)", async () => {
        const port = new FlakySendPort();
        const { bob } = await pair(port, WATCHED, WATCHED);
        bob.edit((fragment) => insertPlainText(fragment, 0, "hello"));
        await vi.advanceTimersByTimeAsync(500); // the edit goes out
        expect(await heartbeatsFrom(port, "bob")).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(REPORT_AFTER_MS - 1);
        expect(await heartbeatsFrom(port, "bob")).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1); // 10 s after the edit went out
        const [heartbeat] = await heartbeatsFrom(port, "bob");
        // A member states no control clock: only a bootstrapped device of the creator does (SND-11).
        expect(heartbeat).toMatchObject({
          kind: "heartbeat",
          controlClock: null,
          controlDigest: null,
        });
        // ...it is the state vector of what bob holds, and the update of his edit, as it went out.
        expect(heartbeat && "stateVector" in heartbeat ? heartbeat.stateVector : null).toEqual(
          encodeStateVector(bob.document),
        );
        const edit = await lastEditOf(port, "bob");
        expect(heartbeat?.kind === "heartbeat" && heartbeat.update).toEqual(
          edit?.kind === "edit" && edit.update,
        );
      });

      it("is not repeated: after the one, nothing until the sender sends something else", async () => {
        const port = new FlakySendPort();
        const { bob } = await pair(port, WATCHED, WATCHED);
        bob.edit((fragment) => insertPlainText(fragment, 0, "hello"));
        await vi.advanceTimersByTimeAsync(500 + REPORT_AFTER_MS);
        expect(await heartbeatsFrom(port, "bob")).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(24 * 3_600_000);
        expect(await heartbeatsFrom(port, "bob")).toHaveLength(1);

        bob.edit((fragment) => insertPlainText(fragment, 5, " again"));
        await vi.advanceTimersByTimeAsync(500 + REPORT_AFTER_MS);
        expect(await heartbeatsFrom(port, "bob")).toHaveLength(2); // a new phase, a new report
      });

      it("waits for a new edit: typing again before it is due moves it back", async () => {
        const port = new FlakySendPort();
        const { bob } = await pair(port, WATCHED, WATCHED);
        bob.edit((fragment) => insertPlainText(fragment, 0, "a"));
        await vi.advanceTimersByTimeAsync(500 + 5_000);
        bob.edit((fragment) => insertPlainText(fragment, 1, "b")); // 5 s before the first would go
        await vi.advanceTimersByTimeAsync(500 + REPORT_AFTER_MS - 1); // 15.5 s after the first message
        expect(await heartbeatsFrom(port, "bob")).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(await heartbeatsFrom(port, "bob")).toHaveLength(1);
      });

      it("is sent whatever the pacing, also with no longest wait (SND-11)", async () => {
        const port = new FlakySendPort();
        const { bob } = await pair(port);
        bob.edit((fragment) => insertPlainText(fragment, 0, "hello"));
        await vi.advanceTimersByTimeAsync(500 + REPORT_AFTER_MS);
        expect(await heartbeatsFrom(port, "bob")).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(24 * 3_600_000);
        expect(await heartbeatsFrom(port, "bob")).toHaveLength(1);
      });

      it("is not sent while a change is still waiting to go out or being retried", async () => {
        const port = new FlakySendPort();
        const { bob } = await pair(port, WATCHED, WATCHED);
        await vi.advanceTimersByTimeAsync(REPORT_AFTER_MS); // alice's report after her decision
        bob.edit((fragment) => insertPlainText(fragment, 0, "first"));
        await vi.advanceTimersByTimeAsync(500);
        port.failNextSends(...Array.from({ length: 10 }, () => new Error("down")));
        bob.edit((fragment) => insertPlainText(fragment, 5, " second"));
        await vi.advanceTimersByTimeAsync(60_000); // failing all along
        expect(await heartbeatsFrom(port, "bob")).toHaveLength(0);
      });

      it("is still sent after a close, and a device of the creator sends the close again before it (LIF-6, SND-27)", async () => {
        const port = new FlakySendPort();
        const { alice } = await pair(port, WATCHED, WATCHED);
        alice.edit((fragment) => insertPlainText(fragment, 0, "x"));
        await vi.advanceTimersByTimeAsync(500);
        await alice.closeDocument();
        const closes = async () =>
          (await port.inner.receive(DOCUMENT_ID, "bob")).filter((d) => {
            const frame = decodeFrame(d.payload);
            return frame.kind === "control" && frame.closed;
          });
        expect(await closes()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(60_000);
        // The close, unchanged, again: its own loss heals with it (SND-27).
        const again = await closes();
        expect(again.map((d) => d.payload)).toEqual([again[0]?.payload, again[0]?.payload]);
        const heartbeats = await heartbeatsFrom(port, "alice");
        expect(heartbeats.length).toBeGreaterThan(0);
        const last = heartbeats.at(-1);
        // The close moves no clock, but the digest, which a receiver compares at an equal clock
        // (LOS-12): that is how its loss shows, were the close lost twice.
        expect(last?.kind === "heartbeat" && last.controlClock).toEqual(alice.controlClock);
        const { targets } = alice.controlState;
        expect(last?.kind === "heartbeat" && last.controlDigest).toBe(
          registerStateDigest({ closed: true, targets }),
        );
        expect(registerStateDigest({ closed: true, targets })).not.toBe(
          registerStateDigest({ closed: false, targets }),
        );
        expect(last?.kind === "heartbeat" && last.update).toBeUndefined(); // its last was the close
      });

      it("is still sent after a close refused an edit that was waiting to go out, and carries the one before (LIF-6, SND-27)", async () => {
        const port = new FlakySendPort();
        const { alice, bob } = await pair(port, WATCHED, WATCHED);
        await vi.advanceTimersByTimeAsync(60_000); // every report the join owed has gone out
        bob.edit((fragment) => insertPlainText(fragment, 0, "sent"));
        await vi.advanceTimersByTimeAsync(500); // goes out: a report is owed
        const before = (await heartbeatsFrom(port, "bob")).length;
        const sent = await lastEditOf(port, "bob");
        await alice.closeDocument();
        bob.edit((fragment) => insertPlainText(fragment, 4, " held")); // waits for the quiet time
        await bob.sync(); // the close arrives first
        await vi.advanceTimersByTimeAsync(500); // the waiting edit is refused (CTL-13) and dropped
        await vi.advanceTimersByTimeAsync(60_000);
        const heartbeats = await heartbeatsFrom(port, "bob");
        expect(heartbeats.length).toBe(before + 1);
        const last = heartbeats.at(-1);
        expect(last?.kind === "heartbeat" && last.update).toEqual(
          sent?.kind === "edit" && sent.update,
        );
      });

      it("a lost FINAL message heals by the report that carries it again, with no request — the case no gap ever shows (SND-27)", async () => {
        const port = new FlakySendPort();
        const { alice, bob } = await pair(port, WATCHED, WATCHED);
        bob.edit((fragment) => insertPlainText(fragment, 0, "all of this arrives"));
        await vi.advanceTimersByTimeAsync(500);
        await alice.sync();
        bob.edit((fragment) => insertPlainText(fragment, 19, " and this last part too"));
        port.inner.dropNextSend("bob");
        await vi.advanceTimersByTimeAsync(500); // sent, and lost
        await alice.sync();
        expect(getPlainText(alice.fragment)).toBe("all of this arrives");
        const requests = async () =>
          (await port.inner.receive(DOCUMENT_ID, "bob")).filter(
            (d) => d.sender === "alice" && decodeFrame(d.payload).kind === "resync-request",
          ).length;
        const before = await requests();
        await vi.advanceTimersByTimeAsync(REPORT_AFTER_MS); // the report, which does arrive
        await alice.sync();
        expect(getPlainText(alice.fragment)).toBe("all of this arrives and this last part too");
        await vi.advanceTimersByTimeAsync(60_000);
        await alice.sync();
        expect(alice.syncHealth.suspicions).toEqual([]);
        expect(await requests()).toBe(before);
      });

      it("a lost final message between two devices of one member heals by the report (LOS-4, SND-27)", async () => {
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
        bob.edit((fragment) => insertPlainText(fragment, 19, " and this last part too"));
        port.inner.dropNextSend("bob");
        await vi.advanceTimersByTimeAsync(500); // sent, and lost
        await bobsPhone.sync();
        expect(getPlainText(bobsPhone.fragment)).toBe("all of this arrives");
        await vi.advanceTimersByTimeAsync(REPORT_AFTER_MS); // the laptop's report, which does arrive
        await bobsPhone.sync();
        expect(getPlainText(bobsPhone.fragment)).toBe("all of this arrives and this last part too");
        await vi.advanceTimersByTimeAsync(5_000);
        expect(bobsPhone.syncHealth.suspicions).toEqual([]);
      });

      it("its own edit coming back shows it no gap, also where the echo has another delivery id (LOS-17, LOS-25)", async () => {
        const port = new FlakySendPort();
        // A transport that does not tell the sender the id its message is delivered under: the
        // engine sees its own messages again, and only their content tells them apart.
        const original = port.send.bind(port);
        port.send = async (documentId, sender, payload) =>
          `sent-${await original(documentId, sender, payload)}`;
        const { alice } = await pair(port, WATCHED, WATCHED);
        alice.edit((fragment) => insertPlainText(fragment, 0, "hello"));
        await vi.advanceTimersByTimeAsync(500);
        port.inner.dropNextSend("alice"); // her heartbeat
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

      it("a sender silent after its report raises no suspicion, a day later neither: no frame promises a follow-up (§10)", async () => {
        const port = new FlakySendPort();
        const { alice, bob } = await pair(port, WATCHED, WATCHED);
        bob.edit((fragment) => insertPlainText(fragment, 0, "hello"));
        await vi.advanceTimersByTimeAsync(500 + 20_000);
        await alice.sync();
        await vi.advanceTimersByTimeAsync(24 * 3_600_000);
        expect(alice.syncHealth.state).toBe("ok");
      });

      it("the creator's report sends her last control frame again: a lost decision arrives with it (SND-27)", async () => {
        const port = new FlakySendPort();
        const { alice, bob } = await pair(port, WATCHED, WATCHED);
        await vi.advanceTimersByTimeAsync(REPORT_AFTER_MS); // the report after her first decision
        port.inner.dropNextSend("alice"); // the membership change is lost
        await alice.setMembership("carol", "read");
        await bob.sync();
        expect(bob.permissionOf("carol")).toBeUndefined(); // bob never saw it
        await vi.advanceTimersByTimeAsync(REPORT_AFTER_MS); // the frame again, then the report
        await bob.sync();
        expect(bob.permissionOf("carol")).toBe("read");
        await vi.advanceTimersByTimeAsync(5_000);
        expect(bob.syncHealth.state).toBe("ok");
      });

      it("the creator's report makes even her last control message checkable when it is lost again (LOS-10)", async () => {
        const port = new FlakySendPort();
        const { alice, bob } = await pair(port, WATCHED, WATCHED);
        await vi.advanceTimersByTimeAsync(REPORT_AFTER_MS); // the report after her first decision
        port.inner.dropNextSend("alice"); // the membership change is lost
        await alice.setMembership("carol", "read");
        port.inner.dropNextSend("alice"); // and so is the frame the report sends again first
        await vi.advanceTimersByTimeAsync(REPORT_AFTER_MS); // her report carries her control clock
        await bob.sync();
        expect(bob.permissionOf("carol")).toBeUndefined(); // bob never saw it
        expect(bob.syncHealth.state).toBe("ok");
        await vi.advanceTimersByTimeAsync(5_000);
        expect(bob.syncHealth.suspicions).toEqual([
          expect.objectContaining({ kind: "control-behind" }),
        ]);
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
          // The person's request asks all (RSY-21): its expiry is a floor of 10 s, or 2 latencies, and
          // the window over which the members' turns are spread (RSY-4, RSY-20).
          await vi.advanceTimersByTimeAsync(10_000);
          expect(bob.syncHealth.resync.state).toBe("requested");
          await vi.advanceTimersByTimeAsync(30_000);
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
          await vi.advanceTimersByTimeAsync(30_000); // his report goes, a floor after the edit
          expect(await bob.requestResync()).toEqual({ sent: false, reason: "rate-floor" });
          await vi.advanceTimersByTimeAsync(30_000); // the floor after the report (SND-12)
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

        it("a resync request owes no report: asking begins no phase of sending (SND-11)", async () => {
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

        it("a joiner's request alone makes no bystander ask, and starts no cascade of requests (LOS-4, RSY-17)", async () => {
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
          // The repeat asks all, so it holds the slot for the window too (30 s; RSY-4, RSY-20,
          // RSY-21): the next waits past two expiries until it has expired.
          await poll(39_999);
          expect(asks.at(-1)).toBe(2);
          await poll(1);
          expect(asks.at(-1)).toBe(3);
          const asked = (await port.inner.receive(DOCUMENT_ID, "alice"))
            .map((d) => decodeFrame(d.payload))
            .filter((frame) => frame.kind === "resync-request")
            .map((frame) => frame.kind === "resync-request" && frame.all);
          expect(asked).toStrictEqual([false, true, true]);
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
          // Two latencies and the gap's slot, within the answer window of 30 s: the client asks (LOS-6).
          await vi.advanceTimersByTimeAsync(5_000 + 30_000);
          await bob.sync();
          expect(await requestsSeen(port)).toBe(before + 1);
          expect(bob.syncHealth.resync).toMatchObject({ state: "requested", automatic: true });

          await alice.sync(); // the creator answers
          await bob.sync();
          expect(getPlainText(bob.fragment)).toBe("one two three");
          expect(bob.syncHealth.state).toBe("ok");
        });

        it("asks a bounded number of times per gap, with a doubling wait, when nobody can help (LOS-6)", async () => {
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
          const { alice, bob } = await pair(port, paced, paced, undefined, false);
          // Bob may write once the grant is out at alice's next slot (LIF-9, CTL-13).
          const granted = alice.setMembership("bob", "write");
          const tick = async (seconds: number, bobTypes: boolean) => {
            for (let second = 0; second < seconds; second += 1) {
              if (bobTypes) bob.edit((fragment) => insertPlainText(fragment, 0, "b"));
              await vi.advanceTimersByTimeAsync(1_000);
              await alice.sync();
              await bob.sync();
            }
          };
          await tick(60, false);
          await granted;
          expect(bob.mayEdit).toBe(true);
          port.inner.dropNextSend("alice");
          alice.edit((fragment) => insertPlainText(fragment, 0, "lost "));
          // Within her phase: her report carries "late " again, not "lost " (SND-27).
          await tick(5, false);
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

        it("a later gap asks with tries of its own once the one before has gone (LOS-6, LOS-25)", async () => {
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
          await vi.advanceTimersByTimeAsync(10_000 + 30_000); // its wait and its slot (LOS-6)
          await bob.sync();
          expect(await requestsSeen(port)).toBe(beforeSecond + 1); // it asks again by itself
        });

        it("does not spend its allowance while a person's request holds the slot", async () => {
          const port = new FlakySendPort();
          const { alice, bob } = await pair(port, WATCHED, WATCHED);
          await unhealableGap(port, alice, bob);
          await vi.advanceTimersByTimeAsync(5_000);
          await bob.sync();
          // The person clicks first, before the gap's wait passed, and holds the slot for 40 s: a
          // request to all waits out the members' turns (RSY-4, RSY-21).
          await bob.requestResync();
          for (let tick = 0; tick < 9; tick += 1) {
            await vi.advanceTimersByTimeAsync(1_000);
            await bob.sync(); // the automatic request is "due" every tick, and must not be counted
          }
          const during = await requestsSeen(port);
          await vi.advanceTimersByTimeAsync(31_000); // the person's request expires unanswered
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
        // Her report carries " lost" again (SND-27); one in a burst of two makes the next state it.
        alice.edit((fragment) => insertPlainText(fragment, 8, "!"));
        port.inner.dropNextSend("alice");
        await vi.advanceTimersByTimeAsync(500);
        await vi.advanceTimersByTimeAsync(REPORT_AFTER_MS); // her report goes out and arrives
        await bob.sync(); // bob hears it, and sees it names a state he has not reached
        expect(bob.syncHealth.state).toBe("ok"); // the missing edit may still be on its way
        await vi.advanceTimersByTimeAsync(5_000); // one expected latency later it has not come
        expect(bob.syncHealth.state).toBe("suspected");

        await bob.requestResync();
        await alice.sync(); // the creator answers
        await bob.sync();
        expect(getPlainText(bob.fragment)).toBe("one lost!");
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
    // It may hold what nobody else has, so it sends the whole state once, as resync() does — after
    // its first read and the request it makes not knowing how long it was away (RSY-1, CTL-41).
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
      // Right after the restart the messenger cannot be reached yet: every send is refused, the first
      // edit among them; a moment later it can.
      let refuseNextEdit = true;
      const reachableAt = Date.now() + 1;
      const send = t.messenger.send.bind(t.messenger);
      t.messenger.send = async (documentId, sender, payload) => {
        if (sender === "alice" && Date.now() < reachableAt) {
          if (decodeFrame(payload).kind === "edit") refuseNextEdit = false;
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
      expect(restarted.sendStatus).toMatchObject({ state: "retrying" });
      expect(restarted.hasUndistributedChanges).toBe(true);

      // The back-off, doubled: the start request was refused as well (SND-7).
      await vi.advanceTimersByTimeAsync(1_999);
      expect(restarted.sendStatus.state).toBe("retrying");
      await vi.advanceTimersByTimeAsync(1);
      expect(restarted.sendStatus.state).toBe("idle");
      expect(restarted.hasUndistributedChanges).toBe(false);
      expect(errors).toEqual([]); // retried, never dropped: no error (SND-10)
      await bob.sync();
      expect(getPlainText(bob.fragment)).toBe("Hallo Welt");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a piece of the whole state refused for good once, and keeps the mark (SND-8)", {
    timeout: 60_000,
  }, async () => {
    vi.useFakeTimers();
    try {
      const t = transport();
      const { alice } = await twoAuthors(t.messenger);
      // Two pieces on the smallest transport (TRN-23).
      alice.edit((fragment) => insertPlainText(fragment, 10, "x".repeat(MIN_MESSAGE_BYTES)));
      const saved = encodeUpdate(alice.document);
      const controlState = persistedOf(alice);
      alice.dispose();
      await t.restart("alice");
      // A transport of the smallest size (TRN-23), which refuses the second edit frame for good.
      let edits = 0;
      const send = t.messenger.send.bind(t.messenger);
      const small: MessengerPort = {
        ...t.messenger,
        transportProfile: async () => ({
          ...(await t.port.transportProfile()),
          bounds: { minIntervalMs: null, maxBytes: MIN_MESSAGE_BYTES },
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

describe("the creator's pace (SND-15)", () => {
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

  describe("two devices of the creator setting the pace at once: the later decision holds (CTL-22)", () => {
    const T = 1_793_008_800_000;

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Alice's laptop, her tablet and Bob, all synchronised once. */
    async function devices() {
      const port = new InMemoryMessengerPort();
      vi.setSystemTime(T - 60_000);
      const laptop = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_CREATOR);
      const tablet = await DocumentEngine.join(DOCUMENT_ID, "alice", port, undefined, AS_CREATOR);
      const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, AS_CREATOR);
      for (const engine of [laptop, tablet, bob]) await engine.sync();
      return { port, laptop, tablet, bob };
    }

    async function syncAll(engines: readonly DocumentEngine[]) {
      for (let round = 0; round < 2; round += 1) {
        for (const engine of engines) await engine.sync();
      }
    }

    it("the decision with the greater clock holds everywhere, though it is the wider one", async () => {
      const { laptop, tablet, bob } = await devices();
      vi.setSystemTime(T);
      await laptop.setPace(40);
      // The tablet has not seen the laptop's decision: the two are concurrent; its wall clock is later.
      vi.setSystemTime(T + 1_000);
      await tablet.setPace(10);
      await syncAll([laptop, tablet, bob]);
      for (const engine of [laptop, tablet, bob]) {
        expect(engine.pace).toBe(10);
        expect(engine.controlState.targets.pace).toEqual({
          value: 10,
          clock: [T + 1_000, 0],
          device: tablet.deviceTag,
        });
      }
    });

    it("at an equal clock, the decision of the device whose tag comes later holds", async () => {
      const { laptop, tablet, bob } = await devices();
      vi.setSystemTime(T);
      await laptop.setPace(40);
      await tablet.setPace(10);
      await syncAll([laptop, tablet, bob]);
      const later = (laptop.deviceTag as string) > (tablet.deviceTag as string) ? laptop : tablet;
      const expected = later === laptop ? 40 : 10;
      for (const engine of [laptop, tablet, bob]) {
        expect(engine.pace).toBe(expected);
        expect(engine.controlState.targets.pace?.clock).toEqual([T, 0]);
      }
    });

    it("at an equal clock and tag — two copies of one device — the longer interval holds (CTL-23)", async () => {
      const { port, laptop, bob } = await devices();
      const saved = persistedOf(laptop);
      const one = await DocumentEngine.join(DOCUMENT_ID, "alice", port, undefined, {
        ...AS_CREATOR,
        controlState: saved,
      });
      const other = await DocumentEngine.join(DOCUMENT_ID, "alice", port, undefined, {
        ...AS_CREATOR,
        controlState: saved,
      });
      expect(one.deviceTag).toBe(laptop.deviceTag);
      expect(other.deviceTag).toBe(laptop.deviceTag);
      vi.setSystemTime(T);
      await one.setPace(10);
      await other.setPace(40);
      await syncAll([laptop, one, other, bob]);
      for (const engine of [laptop, one, other, bob]) {
        expect(engine.pace).toBe(40);
      }
    });
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
  it("a joiner that sees none of the creator's control frames learns its right from the snapshot", async () => {
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

describe("two registers under one clock and one tag, whichever way they arrive (CTL-22, CTL-23)", () => {
  const options = { batchWindowMs: 0, resyncResponseThrottleMs: 0 };

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
    expect(carol.rightOf("bob")).toBe("write");
    const held = carol.controlState.targets["member:bob"];
    if (held === undefined) throw new Error("carol holds no register on bob");
    return { messenger, carol, errors, held };
  }

  it("a frame after the snapshot: the narrower value holds, and nothing is reported", async () => {
    const { messenger, carol, errors, held } = await carolJoins(true);
    // Another copy of alice's device decided under the same tag at the same clock.
    const other = encodeControlFrame({
      documentId: DOCUMENT_ID,
      device: held.device,
      targets: { "member:bob": { ...held, value: null } },
      closed: false,
      controlClock: held.clock,
      controlDigest: "0000000000000000",
    });
    await messenger.send(DOCUMENT_ID, "alice", other);
    await carol.sync();
    expect(errors).toEqual([]);
    expect(carol.rightOf("bob")).toBe("revoked"); // revoked before read before write
    expect(carol.controlState.targets["member:bob"]).toEqual({ ...held, value: null });
  });

  it("a snapshot after the frame: the same result", async () => {
    const { messenger, carol, errors, held } = await carolJoins(false);
    const answer = encodeResyncResponseFrame({
      documentId: DOCUMENT_ID,
      respondsTo: "0123456789abcdef",
      update: Y.encodeStateAsUpdate(new Y.Doc()),
      control: {
        profile: YJS_PARAGRAPHS_1,
        closed: false,
        targets: { "member:bob": { ...held, value: null } },
      },
    });
    await messenger.send(DOCUMENT_ID, "alice", answer);
    await carol.sync();
    expect(errors).toEqual([]);
    expect(carol.rightOf("bob")).toBe("revoked");
    expect(carol.controlState.targets["member:bob"]).toEqual({ ...held, value: null });
  });
});

describe("a device of the creator that meets another copy of itself (CTL-22, CTL-45)", () => {
  const options = { batchWindowMs: 0, resyncResponseThrottleMs: 0 };
  /** Another copy of the register on bob: same tag and clock, another value. */
  const otherCopy = (held: {
    readonly clock: readonly [number, number];
    readonly device: string;
  }) =>
    encodeControlFrame({
      documentId: DOCUMENT_ID,
      device: held.device,
      targets: { "member:bob": { value: null, clock: held.clock, device: held.device } },
      closed: false,
      controlClock: held.clock,
      controlDigest: "0000000000000000",
    });

  async function aliceGrantsBob(
    messenger: InMemoryMessengerPort,
    onControlStateChange?: (state: PersistedControlState) => void,
  ) {
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
      ...options,
      onControlStateChange,
    });
    await alice.setMembership("bob", "write");
    await alice.sync();
    return alice;
  }

  it("merges the copy's register as every receiver does and keeps its tag; its next decision holds over both", async () => {
    const messenger = new InMemoryMessengerPort();
    const errors: unknown[] = [];
    const alice = await aliceGrantsBob(messenger);
    const carol = await DocumentEngine.join(
      DOCUMENT_ID,
      "carol",
      messenger,
      (e) => errors.push(e),
      {
        ...options,
        creatorMemberId: "alice",
      },
    );
    for (let round = 0; round < 3; round++) for (const e of [alice, carol]) await e.sync();
    const tag = alice.deviceTag as string;
    const held = alice.controlState.targets["member:bob"];
    if (held === undefined) throw new Error("alice holds no register on bob");
    await messenger.send(DOCUMENT_ID, "alice", otherCopy(held));
    for (const e of [alice, carol]) await e.sync();
    expect(errors).toEqual([]);
    for (const engine of [alice, carol]) expect(engine.rightOf("bob")).toBe("revoked");
    expect(alice.deviceTag).toBe(tag);
    // Decided again, with a clock above both (CTL-21), it holds wherever it arrives.
    await alice.setMembership("bob", "write");
    for (const e of [alice, carol]) await e.sync();
    const decided = alice.controlState.targets["member:bob"];
    expect(
      decided?.clock[0] === held.clock[0]
        ? decided.clock[1] > held.clock[1]
        : (decided?.clock[0] ?? 0) > held.clock[0],
    ).toBe(true);
    for (const engine of [alice, carol]) expect(engine.rightOf("bob")).toBe("write");
  });

  it("after a restart decides above what it restored: its own clock was persisted (CTL-26, CTL-45)", async () => {
    const messenger = new InMemoryMessengerPort();
    let persisted: PersistedControlState | undefined;
    const before = await aliceGrantsBob(messenger, (state) => {
      persisted = state;
    });
    const tag = before.deviceTag as string;
    const held = before.controlState.targets["member:bob"];
    before.dispose();
    expect(persisted?.clock).toEqual(held?.clock);
    const alice = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, {
      ...options,
      creatorMemberId: "alice",
      controlState: persisted,
    });
    expect(alice.deviceTag).toBe(tag);
    expect(alice.controlStanding).toStrictEqual({ kind: "bootstrapped" });
    await alice.setMembership("carol", "read");
    const carol = alice.controlState.targets["member:carol"];
    expect(carol?.device).toBe(tag);
    expect(
      carol !== undefined &&
        held !== undefined &&
        (carol.clock[0] > held.clock[0] ||
          (carol.clock[0] === held.clock[0] && carol.clock[1] > held.clock[1])),
    ).toBe(true);
  });

  it("changes nothing when its own frame merely comes back again (CTL-6)", async () => {
    const messenger = new InMemoryMessengerPort();
    const errors: unknown[] = [];
    const alice = await DocumentEngine.create(
      DOCUMENT_ID,
      "alice",
      messenger,
      (e) => errors.push(e),
      options,
    );
    await alice.setMembership("bob", "write");
    await alice.sync();
    const tag = alice.deviceTag as string;
    const state = alice.controlState;
    const own = (await messenger.receive(DOCUMENT_ID, "observer")).find(
      (delivery) => decodeFrame(delivery.payload).kind === "control",
    );
    await messenger.send(DOCUMENT_ID, "alice", own?.payload as string);
    await alice.sync();
    expect(errors).toEqual([]);
    expect(alice.controlState).toEqual(state);
    expect(alice.deviceTag).toBe(tag);
  });
});

describe("what a device of the creator takes from members' answers (CTL-22, CTL-25, CTL-27)", () => {
  const options = { batchWindowMs: 0, resyncResponseThrottleMs: 0, creatorMemberId: "alice" };
  const T = 1_793_008_800_000;
  async function settle(...engines: DocumentEngine[]) {
    for (let round = 0; round < 6; round++) for (const engine of engines) await engine.sync();
  }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a decision made later holds over one its device never saw, whichever is narrower", async () => {
    const messenger = new InMemoryMessengerPort();
    const a = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, options);
    await a.setMembership("carol", "write");
    const b = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, options);
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, options);
    await settle(a, b, bob);
    expect(b.controlStanding).toStrictEqual({ kind: "bootstrapped" });
    // A revokes carol; Bob gets it, B never does: its window moved past it.
    vi.setSystemTime(T + 1_000);
    await a.setMembership("carol", null);
    await settle(bob);
    messenger.forgetOldest(DOCUMENT_ID, (await messenger.receive(DOCUMENT_ID, "observer")).length);
    // The person on B decides later, not knowing of the revocation.
    vi.setSystemTime(T + 2_000);
    await b.setMembership("carol", "read");
    expect(b.controlState.targets["member:carol"]?.clock).toEqual([T + 2_000, 0]);
    await settle(a, b, bob);
    for (const engine of [a, b, bob]) expect(engine.rightOf("carol")).toBe("read");
  });

  it("a member's answer to a device of the creator that is not bootstrapped is merged with the content, but bootstraps it not: only the creator's own state does (CTL-27, RSY-14)", async () => {
    const messenger = new InMemoryMessengerPort();
    const old = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, options);
    await old.setMembership("bob", "write");
    await old.setMembership("carol", "read");
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, options);
    await settle(old, bob);
    expect(bob.rightOf("carol")).toBe("read");
    old.edit((fragment) => insertPlainText(fragment, 0, "text"));
    await old.flush();
    await settle(old, bob);
    old.dispose();
    messenger.forgetOldest(DOCUMENT_ID, (await messenger.receive(DOCUMENT_ID, "observer")).length);
    // A new device of alice, with nothing: Bob answers its request to all — its repeat, after the
    // first went unanswered — at his turn, with content and his snapshot (RSY-8, RSY-20, RSY-21).
    const fresh = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, options);
    const answers = async () =>
      (await messenger.receive(DOCUMENT_ID, "observer"))
        .filter((delivery) => delivery.sender === "bob")
        .map((delivery) => decodeFrame(delivery.payload))
        .filter((frame) => frame.kind === "resync-response");
    await settle(fresh, bob);
    expect(await answers()).toStrictEqual([]);
    vi.setSystemTime(Date.now() + 10_000); // the first request expires unanswered (RSY-4)
    await settle(fresh, bob);
    vi.setSystemTime(Date.now() + 30_000); // past Bob's turn in the window (RSY-20)
    await settle(fresh, bob);
    expect((await answers()).at(-1)).toMatchObject({
      control: { targets: bob.controlState.targets },
    });
    expect(getPlainText(fresh.fragment)).toBe("text");
    expect(fresh.hasCompletedBootstrap).toBe(false);
    // Bob's snapshot, merged (CTL-25).
    expect(fresh.controlStanding).toStrictEqual({ kind: "none" });
    expect(fresh.controlState.targets).toEqual(bob.controlState.targets);
    expect(fresh.rightOf("carol")).toBe("read");
  });
});

describe("whether a restored device of the creator is bootstrapped (CTL-26, RSY-14)", () => {
  const options = { batchWindowMs: 0, resyncResponseThrottleMs: 0, creatorMemberId: "alice" };
  async function settle(...engines: DocumentEngine[]) {
    for (let round = 0; round < 6; round++) for (const engine of engines) await engine.sync();
  }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_793_008_800_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Alice's old device wrote "Plan", made Bob a reader and Dave a writer, and is lost; a new one,
   * seeing none of it, merges Dave's answer to its repeat to all, which bootstraps it not (CTL-27).
   */
  async function newDeviceMerges() {
    const messenger = new InMemoryMessengerPort();
    const old = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, options);
    await old.setMembership("bob", "read");
    await old.setMembership("dave", "write");
    old.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
    const dave = await DocumentEngine.join(DOCUMENT_ID, "dave", messenger, undefined, options);
    await settle(old, dave);
    // What the old device still owes goes before its history is forgotten, so nothing of it
    // remains on the channel (SND-11, SND-27).
    await old.reportNow();
    old.dispose();
    messenger.forgetOldest(DOCUMENT_ID, (await messenger.receive(DOCUMENT_ID, "observer")).length);
    let persisted: PersistedControlState | undefined;
    const fresh = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, {
      ...options,
      onControlStateChange: (state) => {
        persisted = state;
      },
    });
    await settle(fresh, dave);
    vi.setSystemTime(Date.now() + 10_000); // the first request expires unanswered (RSY-4)
    await settle(fresh, dave);
    vi.setSystemTime(Date.now() + 30_000); // past Dave's turn in the window (RSY-20)
    await settle(fresh, dave);
    expect(fresh.permissionOf("bob")).toBe("read");
    expect(getPlainText(fresh.fragment)).toBe("Plan");
    expect(fresh.controlStanding).toStrictEqual({ kind: "none" });
    const content = encodeUpdate(fresh.document);
    fresh.dispose();
    dave.dispose();
    return { messenger, persisted: persisted as PersistedControlState, content };
  }

  it("persists that it was not — a member's answer merged bootstraps it not —, and restored stays so: it states no control clock, and bootstraps no reader", async () => {
    const { messenger, persisted, content } = await newDeviceMerges();
    expect(persisted.bootstrapped).toBeUndefined();
    const before = (await messenger.receive(DOCUMENT_ID, "observer")).length;
    const restarted = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, {
      ...options,
      controlState: persisted,
      restore: { state: content },
    });
    expect(restarted.controlStanding).toStrictEqual({ kind: "none" });
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, options);
    await settle(restarted, bob);
    expect(getPlainText(bob.fragment)).toBe("Plan");
    expect(bob.hasCompletedBootstrap).toBe(false);
    expect(bob.mayEdit).toBe(false);
    // What it sent after the restart — its request, and its answers, Bob's among them — states no
    // control state (RSY-14, RSY-8, RSY-16).
    const sent = (await messenger.receive(DOCUMENT_ID, "observer"))
      .slice(before)
      .map((delivery) => ({
        sender: delivery.sender,
        frame: decodeFrame(delivery.payload),
      }));
    const bobsRequest = sent.find(
      ({ sender, frame }) => sender === "bob" && frame.kind === "resync-request",
    )?.frame;
    const fromRestarted = sent.filter(({ sender }) => sender === "alice").map(({ frame }) => frame);
    const requests = fromRestarted.filter((frame) => frame.kind === "resync-request");
    const answers = fromRestarted.filter((frame) => frame.kind === "resync-response");
    expect(requests.length).toBeGreaterThan(0);
    expect(
      answers.some(
        (frame) =>
          bobsRequest?.kind === "resync-request" && frame.respondsTo === bobsRequest.requestId,
      ),
    ).toBe(true);
    for (const frame of requests)
      if (frame.kind === "resync-request") expect(frame.controlClock).toBeNull();
    for (const frame of answers)
      if (frame.kind === "resync-response") expect(frame.control).toBeNull();
  });

  it("persists that it was, and restored keeps it", async () => {
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
    expect(persisted?.bootstrapped).toBe(true);
    const restarted = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, {
      ...options,
      controlState: persisted,
    });
    expect(restarted.controlStanding).toStrictEqual({ kind: "bootstrapped" });
  });

  it("takes a state persisted without the field as not bootstrapped: bootstrapped only if it was (CTL-26)", async () => {
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
    const { bootstrapped: _left, ...older } = persisted as PersistedControlState;
    const restarted = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, {
      ...options,
      controlState: older,
    });
    expect(restarted.controlStanding).toStrictEqual({ kind: "none" });
    expect(restarted.rightOf("bob")).toBe("read"); // what it holds still shows
  });

  it("reads a state of an earlier draft's form, which holds no registers, as none, and does not crash", async () => {
    const tag = "M".repeat(22);
    const draft5 = {
      profile: YJS_PARAGRAPHS_1,
      control: {
        vector: { [tag]: 1 },
        targets: {
          "member:bob": {
            seen: {},
            heads: [{ device: tag, counter: 1, value: "write", seen: {} }],
          },
        },
      },
      device: tag,
      counter: 1,
      unsent: ['{"tdsp":"de.wappensc.together.tdsp.probe.draft-5","kind":"control"}'],
      basis: true,
      bootstrapped: true,
    } as unknown as PersistedControlState;
    const errors: unknown[] = [];
    // On a channel that holds nothing yet, so that only the persisted state could hold rights.
    const messenger = new InMemoryMessengerPort();
    await messenger.createDocument(DOCUMENT_ID, "alice");
    const creator = await DocumentEngine.join(
      DOCUMENT_ID,
      "alice",
      messenger,
      (e) => errors.push(e),
      {
        ...options,
        controlState: draft5,
      },
    );
    expect(creator.controlStanding).toStrictEqual({ kind: "none" });
    expect(creator.controlState.targets).toEqual({});
    expect(creator.deviceTag).not.toBe(tag);
    const member = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, {
      ...options,
      controlState: draft5,
    });
    expect(member.hasCompletedBootstrap).toBe(false);
    expect(member.rightOf("bob")).toBe("unknown");
    expect(errors).toEqual([]);
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

  it("bootstrapped when persisted and with its content it is bootstrapped at once, and asks once, not again and again", async () => {
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

  it("not bootstrapped, still asks by itself after its own bootstrap requests ran out: a report read after its last expired brings one request to all, and the gap it showed has its tries, then rests (RSY-5, LOS-6, LOS-26)", async () => {
    const { messenger, control } = await aliceStops();
    messenger.forgetOldest(DOCUMENT_ID, (await messenger.receive(DOCUMENT_ID, "observer")).length);
    // Without its content, its control state persisted as not bootstrapped (RSY-14), and nobody
    // online who could give it either.
    const { bootstrapped: _bootstrapped, ...notBootstrapped } = control;
    const alice = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, {
      ...options,
      controlState: notBootstrapped,
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
        controlClock: null,
        controlDigest: null,
        stateVector: Y.encodeStateVector(bobs),
        stateDigest: "0".repeat(16),
      }),
    );
    // The gap's wait of 10 s, and its slot in the answer window of 30 s (LOS-6).
    await pass(50_000, alice);
    expect(alice.syncHealth.suspicions.length).toBeGreaterThan(0);
    expect(await requestsOfAlice(messenger)).toBe(asked + 1);
    // Bounded: Bob's frame, read after its last bootstrap request expired, makes it ask once more, to
    // all (RSY-5); the gap Bob's heartbeat showed has its tries, that request among them, whatever
    // the bootstrap (RSY-5, LOS-6), and then rests, shown (LOS-26): nobody reachable holds it.
    await pass(1_800_000, alice);
    const after = await requestsOfAlice(messenger);
    expect(after).toBe(asked + MAX_GAP_TRIES);
    expect(alice.syncHealth.suspicions).toMatchObject([
      { kind: "behind-heartbeat", sender: "bob", tries: MAX_GAP_TRIES, resting: true },
    ]);
    await pass(1_800_000, alice);
    expect(await requestsOfAlice(messenger)).toBe(after);
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

describe("an answer to this engine's own request that does not bootstrap it (RSY-4)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers the request, though it carries no control state", async () => {
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
    const content = encodeUpdate(old.document);
    old.dispose();
    const window = (await messenger.receive(DOCUMENT_ID, "observer")).length;
    // Bob writes once more; then he is gone for good.
    bob.edit((fragment) => insertPlainText(fragment, 0, "B"));
    await vi.advanceTimersByTimeAsync(0);
    bob.dispose();
    // A new device of Alice, given the content but none of the old one's decisions, is not
    // bootstrapped (RSY-14).
    messenger.forgetOldest(DOCUMENT_ID, window);
    const fresh = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, {
      ...JOIN_ALICE,
      resyncResponseThrottleMs: 0,
      restore: { state: content },
    });
    expect(fresh.controlStanding).toStrictEqual({ kind: "none" });
    const carol = await DocumentEngine.join(DOCUMENT_ID, "carol", messenger, undefined, {
      ...JOIN_ALICE,
      autoResync: false,
    });
    expect(carol.syncHealth.resync.state).toBe("requested");
    // It holds content Carol lacks, so it answers (RSY-17), without control state (RSY-8, RSY-14).
    await fresh.sync();
    const answer = (await messenger.receive(DOCUMENT_ID, "observer"))
      .filter((delivery) => delivery.sender === "alice")
      .map((delivery) => decodeFrame(delivery.payload))
      .find((frame) => frame.kind === "resync-response");
    expect(answer).toMatchObject({ control: null });
    await carol.sync();
    expect(carol.hasCompletedBootstrap).toBe(false);
    expect(carol.syncHealth.resync).toMatchObject({ state: "idle", lastOutcome: "answered" });
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
