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
  encodeResyncRequestFrame,
  encodeResyncResponseFrame,
  FrameDecodeError,
} from "./framing";
import {
  type ControlSnapshot,
  DocumentEngine,
  type DocumentEngineOptions,
  resolveSyncPolicy,
  SendRefusedError,
  TransportProfileError,
  UnsupportedProfileError,
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

  describe("the creator's send policy", () => {
    // Fake time: a policy with a floor makes the creator's control messages and answers wait.
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("a late joiner learns it from the creator's bootstrap answer, since the transport replays nothing", async () => {
      const messenger = new NoHistoryMessengerPort();
      const alice = await DocumentEngine.create(
        DOCUMENT_ID,
        "alice",
        messenger,
        undefined,
        ADMIN_ALICE,
      );
      await alice.sync(); // establishes alice's own receive() baseline before carol ever joins
      await alice.setSyncPolicy({ minIntervalMs: 12_000 });

      const carol = await DocumentEngine.join(
        DOCUMENT_ID,
        "carol",
        messenger,
        undefined,
        ADMIN_ALICE,
      );
      expect(carol.syncPolicy.minIntervalMs).toBe(0); // told nothing yet: no history, no invitation
      await alice.sync(); // the creator answers carol's join...
      await vi.advanceTimersByTimeAsync(12_000); // ...once its floor after the policy change has passed
      await carol.sync();
      expect(carol.syncPolicy.minIntervalMs).toBe(12_000);
    });

    it("a stale invitation yields to a newer policy in the creator's answer", async () => {
      const messenger = new NoHistoryMessengerPort();
      const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
        ...ADMIN_ALICE,
        syncPolicy: { minIntervalMs: 25_000 },
      });
      await alice.sync(); // establishes alice's own receive() baseline before carol ever joins
      const staleInvitation = alice.invitationPolicy;
      await afterFloor(alice.setSyncPolicy({ minIntervalMs: 40_000 }), 25_000); // sequence 1, after the seed's floor

      const carol = await DocumentEngine.join(DOCUMENT_ID, "carol", messenger, undefined, {
        ...ADMIN_ALICE,
        syncPolicy: staleInvitation?.policy,
        syncPolicySequence: staleInvitation?.sequence,
      });
      expect(carol.syncPolicy.minIntervalMs).toBe(25_000); // the link's, until the creator answers
      await alice.sync();
      await vi.advanceTimersByTimeAsync(40_000); // the answer waits for the new floor
      await carol.sync();
      expect(carol.syncPolicy.minIntervalMs).toBe(40_000);
    });

    it("a fresh invitation is not overwritten by an older snapshot", async () => {
      const messenger = new NoHistoryMessengerPort();
      const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
        ...ADMIN_ALICE,
        syncPolicy: { minIntervalMs: 25_000 },
      });
      const carol = await DocumentEngine.join(DOCUMENT_ID, "carol", messenger, undefined, {
        ...ADMIN_ALICE,
        syncPolicy: { minIntervalMs: 77_000 },
        syncPolicySequence: 9, // newer than anything alice has issued
      });
      await alice.sync();
      await carol.sync();
      expect(carol.syncPolicy.minIntervalMs).toBe(77_000);
    });

    describe("declining an invitation (SPECIFICATION.md §6.5)", () => {
      it("sends exactly one decline without joining, and the creator's application is told who and why", async () => {
        const messenger = new NoHistoryMessengerPort();
        const declines: unknown[] = [];
        const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
          ...ADMIN_ALICE,
          onDecline: (decline) => declines.push(decline),
        });
        await alice.sync();
        const before = (await messenger.inner.receive(DOCUMENT_ID, "alice")).length;

        await DocumentEngine.decline(DOCUMENT_ID, "carol", messenger, {
          reason: "unsupported-profile",
          profiles: ["com.example.markdown/1"],
          text: "My app only does Markdown.",
        });
        const sent = (await messenger.inner.receive(DOCUMENT_ID, "alice")).slice(before);
        expect(sent.map((d) => [d.sender, decodeFrame(d.payload).kind])).toEqual([
          ["carol", "decline"],
        ]);

        await alice.sync();
        expect(declines).toEqual([
          {
            sender: "carol",
            reason: "unsupported-profile",
            profiles: ["com.example.markdown/1"],
            text: "My app only does Markdown.",
          },
        ]);
      });

      it("reports each sender's decline once, whatever repeats, and changes nothing in the document (DCL-3)", async () => {
        const messenger = new NoHistoryMessengerPort();
        const declines: unknown[] = [];
        const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
          ...ADMIN_ALICE,
          onDecline: (decline) => declines.push(decline),
        });
        await alice.sync();
        alice.edit((fragment) => insertPlainText(fragment, 0, "unchanged"));
        const before = alice.controlState;
        for (let i = 0; i < 3; i += 1) {
          await DocumentEngine.decline(DOCUMENT_ID, "mallory", messenger, { reason: "declined" });
        }
        await DocumentEngine.decline(DOCUMENT_ID, "carol", messenger, { reason: "other" });
        await alice.sync();
        expect(declines.map((d) => (d as { sender: string }).sender)).toEqual(["mallory", "carol"]);
        expect(getPlainText(alice.fragment)).toBe("unchanged");
        expect(alice.controlState).toEqual(before);
        expect(alice.closed).toBe(false);
      });

      it("refuses to send a decline that is too long, before anything goes out", async () => {
        const messenger = new NoHistoryMessengerPort();
        await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, ADMIN_ALICE);
        const before = (await messenger.inner.receive(DOCUMENT_ID, "alice")).length;
        await expect(
          DocumentEngine.decline(DOCUMENT_ID, "carol", messenger, {
            reason: "other",
            text: "x".repeat(501),
          }),
        ).rejects.toThrow(/at most 500/);
        expect((await messenger.inner.receive(DOCUMENT_ID, "alice")).length).toBe(before);
      });
    });

    it("refuses to create or join a document of a profile this engine does not implement, before sending anything (PRF-3)", async () => {
      const messenger = new NoHistoryMessengerPort();
      await expect(
        DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
          ...ADMIN_ALICE,
          profile: "com.example.markdown/1",
        }),
      ).rejects.toBeInstanceOf(UnsupportedProfileError);
      await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, ADMIN_ALICE);
      const before = (await messenger.inner.receive(DOCUMENT_ID, "alice")).length;
      await expect(
        DocumentEngine.join(DOCUMENT_ID, "carol", messenger, undefined, {
          ...ADMIN_ALICE,
          profile: "yjs-paragraphs/2",
        }),
      ).rejects.toBeInstanceOf(UnsupportedProfileError);
      await expect(
        DocumentEngine.join(DOCUMENT_ID, "carol", messenger, undefined, {
          ...ADMIN_ALICE,
          profile: "not a profile",
        }),
      ).rejects.toThrow(/not a document profile id/);
      expect((await messenger.inner.receive(DOCUMENT_ID, "alice")).length).toBe(before);
    });

    it("names the document's profile in the creator's snapshot, where a joiner confirms it", async () => {
      const messenger = new NoHistoryMessengerPort();
      const alice = await DocumentEngine.create(
        DOCUMENT_ID,
        "alice",
        messenger,
        undefined,
        ADMIN_ALICE,
      );
      expect(alice.profile).toBe(YJS_PARAGRAPHS_1);
      expect(alice.controlState.profile).toBe(YJS_PARAGRAPHS_1);
      await alice.sync();
      const carol = await DocumentEngine.join(
        DOCUMENT_ID,
        "carol",
        messenger,
        undefined,
        ADMIN_ALICE,
      );
      await alice.sync();
      await carol.sync();
      expect(carol.hasCompletedBootstrap).toBe(true);
    });
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

    it("a partial gap-heal attributes newly-applied content to the unattributed sentinel, not the responder", async () => {
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
        controlState: alice.controlState,
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
 * (SPECIFICATION.md BRG-17) — what every real bridge now does, at a size far larger.
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

describe("requests a responder could not answer at once (RSY-9)", () => {
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
    await alice.sync(); // nothing new arrived: the kept request is answered again
    await vi.advanceTimersByTimeAsync(10);
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
          bootstrap: true,
          controlSequence: 0,
          stateVector: new Uint8Array([0]),
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
    // Bob lacks nothing the creator has, so he does not answer (RSY-7); the request expires.
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
    expect(bob.controlSequence).toBe(1);
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
      profiles: [
        {
          id: "standard",
          label: "Standard",
          description: "",
          values: {
            minIntervalMs: 0,
            maxIntervalMs: null,
            minChars: 0,
            maxChars: null,
            expectedLatencyMs: 0,
          },
        },
      ],
      defaultProfile: "standard",
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
        profiles: [
          {
            id: "standard",
            label: "Standard",
            description: "",
            values: {
              minIntervalMs: 30_000,
              maxIntervalMs: 120_000,
              minChars: 0,
              maxChars: null,
              expectedLatencyMs: 60_000,
            },
          },
        ],
        defaultProfile: "standard",
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

    describe("the creator's policy reaching the others", () => {
      const policyFrame = (sequence: number, minIntervalMs: number): string =>
        encodeControlFrame({
          documentId: DOCUMENT_ID,
          sequence,
          action: "policy",
          policy: resolveSyncPolicy({ minIntervalMs, maxIntervalMs: 600_000 }),
        });

      it("a policy change by the creator reaches a joiner and takes effect", async () => {
        const port = new FlakySendPort();
        const { alice, bob } = await pair(port);
        expect(bob.syncPolicy.minIntervalMs).toBe(0);

        await alice.setSyncPolicy({ minIntervalMs: 20_000, maxIntervalMs: 90_000 });
        expect(alice.syncPolicy.minIntervalMs).toBe(20_000); // applied locally once sent
        expect(alice.controlSequence).toBe(1);
        await bob.sync();

        expect(bob.syncPolicy.minIntervalMs).toBe(20_000);
        expect(bob.syncPolicy.maxIntervalMs).toBe(90_000);
        expect(bob.controlSequence).toBe(1);
        // ...and it really governs sending, not only the number read back.
        await vi.advanceTimersByTimeAsync(20_000); // the join's resync request used the floor too (SND-2)
        bob.edit((fragment) => insertPlainText(fragment, 0, "one"));
        await vi.advanceTimersByTimeAsync(500);
        bob.edit((fragment) => insertPlainText(fragment, 3, " two"));
        await vi.advanceTimersByTimeAsync(19_000);
        await alice.sync();
        expect(getPlainText(alice.fragment)).toBe("one");
        await vi.advanceTimersByTimeAsync(1_000);
        await alice.sync();
        expect(getPlainText(alice.fragment)).toBe("one two");
      });

      it("a change merges over the policy in force, so a partial change keeps the rest", async () => {
        const port = new FlakySendPort();
        const { alice, bob } = await pair(port, {
          syncPolicy: { minIntervalMs: 10_000, maxIntervalMs: 80_000 },
        });
        await afterFloor(alice.setSyncPolicy({ maxIntervalMs: 99_000 }), 20_000); // behind the join's answer
        await bob.sync();
        expect(bob.syncPolicy.minIntervalMs).toBe(10_000);
        expect(bob.syncPolicy.maxIntervalMs).toBe(99_000);
      });

      it("a change waiting for its send window is judged by the new rules at once", async () => {
        const port = new FlakySendPort();
        const { alice, bob } = await pair(port, {}, { syncPolicy: { minIntervalMs: 60_000 } });
        bob.edit((fragment) => insertPlainText(fragment, 0, "first"));
        await vi.advanceTimersByTimeAsync(500);
        bob.edit((fragment) => insertPlainText(fragment, 5, " second"));
        await vi.advanceTimersByTimeAsync(5_000); // waiting behind a 60 s floor

        await alice.setSyncPolicy({ minIntervalMs: 6_000 });
        await bob.sync();
        await vi.advanceTimersByTimeAsync(1_000); // 6 s after the first message, not 60
        await alice.sync();
        expect(getPlainText(alice.fragment)).toBe("first second");
      });

      it("a policy older than the invitation's is inert too", async () => {
        const port = new FlakySendPort();
        const { bob } = await pair(
          port,
          {},
          { syncPolicy: { minIntervalMs: 77_000 }, syncPolicySequence: 9 },
        );
        await port.inner.send(DOCUMENT_ID, "alice", policyFrame(4, 4_000)); // older than the link
        await bob.sync();
        expect(bob.syncPolicy.minIntervalMs).toBe(77_000);
        await port.inner.send(DOCUMENT_ID, "alice", policyFrame(10, 10_000)); // newer than the link
        await bob.sync();
        expect(bob.syncPolicy.minIntervalMs).toBe(10_000);
      });

      it("an invitation carries the policy for a joiner the creator cannot answer yet", async () => {
        const port = new FlakySendPort();
        const { alice } = await pair(port, { syncPolicy: { minIntervalMs: 25_000 } });
        const invitation = alice.invitationPolicy;
        expect(invitation).toEqual({
          policy: expect.objectContaining({ minIntervalMs: 25_000 }),
          sequence: 0,
        });

        const carol = await DocumentEngine.join(DOCUMENT_ID, "carol", port, undefined, {
          ...AS_ALICE,
          syncPolicy: invitation?.policy,
          syncPolicySequence: invitation?.sequence,
        });
        expect(carol.syncPolicy.minIntervalMs).toBe(25_000); // before any bootstrap
      });

      it("a fresh invitation is not overwritten by an older snapshot", async () => {
        const port = new FlakySendPort();
        const { alice } = await pair(port, { syncPolicy: { minIntervalMs: 25_000 } });
        const carol = await DocumentEngine.join(DOCUMENT_ID, "carol", port, undefined, {
          ...AS_ALICE,
          syncPolicy: { minIntervalMs: 77_000 },
          syncPolicySequence: 9, // newer than anything alice has issued
        });
        await alice.sync();
        await carol.sync();
        expect(carol.syncPolicy.minIntervalMs).toBe(77_000);
      });

      it("each receiver clamps to its own transport's bounds, whatever the creator sent", async () => {
        const port = new FlakySendPort();
        port.profile = {
          bounds: { minIntervalMs: 15_000, maxBytes: null },
          profiles: [
            {
              id: "standard",
              label: "Standard",
              description: "",
              values: {
                minIntervalMs: 0,
                maxIntervalMs: null,
                minChars: 0,
                maxChars: null,
                expectedLatencyMs: 0,
              },
            },
          ],
          defaultProfile: "standard",
        };
        const { bob } = await pair(port);
        await port.inner.send(DOCUMENT_ID, "alice", policyFrame(1, 100)); // far below the floor
        await bob.sync();
        expect(bob.syncPolicy.minIntervalMs).toBe(15_000);
      });

      it("the creator never broadcasts a policy it could not run itself", async () => {
        const port = new FlakySendPort();
        port.profile = {
          bounds: { minIntervalMs: 15_000, maxBytes: null },
          profiles: [
            {
              id: "standard",
              label: "Standard",
              description: "",
              values: {
                minIntervalMs: 0,
                maxIntervalMs: null,
                minChars: 0,
                maxChars: null,
                expectedLatencyMs: 0,
              },
            },
          ],
          defaultProfile: "standard",
        };
        const { alice, bob } = await pair(port);
        await afterFloor(alice.setSyncPolicy({ minIntervalMs: 1 }), 30_000); // behind the join's answer
        expect(alice.syncPolicy.minIntervalMs).toBe(15_000);
        // What went out on the wire is the clamped value, not just what the creator runs.
        const sent = (await port.inner.receive(DOCUMENT_ID, "alice")).map((d) =>
          decodeFrame(d.payload),
        );
        const change = sent.find((frame) => frame.kind === "control" && frame.action === "policy");
        expect(change).toMatchObject({ policy: { minIntervalMs: 15_000 } });
        await bob.sync();
        expect(bob.syncPolicy.minIntervalMs).toBe(15_000);
      });

      it("a creator that re-attaches gets its policy and its sequence back, and keeps issuing from there", async () => {
        const port = new FlakySendPort();
        const states: ControlSnapshot[] = [];
        const { alice, bob } = await pair(port, {
          onControlStateChange: (state) => states.push(state),
        });
        await alice.setSyncPolicy({ minIntervalMs: 33_000 });
        const persisted = states.at(-1);
        expect(persisted?.policy?.minIntervalMs).toBe(33_000);
        expect(persisted?.policySequence).toBe(1);

        const again = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, {
          ...AS_ALICE,
          controlState: persisted,
        });
        expect(again.syncPolicy.minIntervalMs).toBe(33_000);
        expect(again.invitationPolicy?.sequence).toBe(1);
        await afterFloor(again.setSyncPolicy({ minIntervalMs: 44_000 }), 33_000); // after its seed's floor
        expect(again.controlSequence).toBe(2); // continued, not restarted at 1
        await bob.sync();
        expect(bob.syncPolicy.minIntervalMs).toBe(44_000);
      });

      it("cannot be changed once the document is closed", async () => {
        const port = new FlakySendPort();
        const { alice } = await pair(port);
        await alice.closeDocument();
        await expect(alice.setSyncPolicy({ minIntervalMs: 1000 })).rejects.toBeInstanceOf(
          SendRefusedError,
        );
      });

      it("a joiner told nothing takes the creator's policy, and one told something keeps its own until a newer one arrives", async () => {
        const port = new FlakySendPort();
        const { alice } = await pair(port, { syncPolicy: { minIntervalMs: 9_000 } });
        const told = await DocumentEngine.join(DOCUMENT_ID, "dave", port, undefined, {
          ...AS_ALICE,
          syncPolicy: { minIntervalMs: 2_000 },
        });
        await alice.sync();
        await told.sync();
        expect(told.syncPolicy.minIntervalMs).toBe(2_000); // sequence 0 is not newer than sequence 0
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
        expect(
          (await frameKinds(port)).filter((kind) => kind === "fragment").length,
        ).toBeGreaterThan(10);

        await bob.sync();
        expect(getPlainText(bob.fragment)).toBe(text);
        expect(bob.syncHealth.incoming).toEqual([]); // nothing left half-received
      });

      it("spreads a long typed burst over several ordinary edits, each a usable prefix, not fragments", async () => {
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
        expect(new Set(await frameKinds(port))).not.toContain("fragment");

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
        const kinds = await frameKinds(port);
        expect(kinds.lastIndexOf("fragment")).toBeLessThan(kinds.lastIndexOf("edit"));
        await bob.sync();
        expect(getPlainText(bob.fragment)).toBe(`${"x".repeat(3000)} and then this`);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(bob.syncHealth.state).toBe("ok");
      });

      it("shows the sender how many parts are left and the receiver how far along they are, when the floor spaces them", async () => {
        const { alice, bob } = await limitedPair({ syncPolicy: { minIntervalMs: 2_000 } }, {});
        // The answer to bob's join goes out first: at this test's 400-byte limit it is itself cut
        // in two, one part per floor.
        await vi.advanceTimersByTimeAsync(4_000);
        await bob.sync();
        alice.edit((fragment) => insertPlainText(fragment, 0, "y".repeat(2000)));
        await vi.advanceTimersByTimeAsync(2_000); // the first part goes, one floor after the answer
        expect(alice.sendStatus.partsQueued).toBeGreaterThan(3);
        expect(alice.hasPendingChanges).toBe(true);
        const before = alice.sendStatus.partsQueued;
        await bob.sync();
        expect(bob.syncHealth.incoming).toEqual([
          expect.objectContaining({ sender: "alice", have: 1, total: before + 1 }),
        ]);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(alice.sendStatus.partsQueued).toBe(before - 1);
        await vi.advanceTimersByTimeAsync(60_000);
        await bob.sync();
        expect(getPlainText(bob.fragment)).toBe("y".repeat(2000));
        expect(alice.hasPendingChanges).toBe(false);
        expect(bob.syncHealth.incoming).toEqual([]);
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

      it("a part that is lost is noticed and healed like any lost message, by the state the creator sends back", async () => {
        const WATCHED = { syncPolicy: { maxIntervalMs: 20_000, expectedLatencyMs: 5_000 } };
        const { port, alice, bob } = await limitedPair(WATCHED, WATCHED);
        // Bob types a big paste; one of its parts is lost on the way.
        bob.edit((fragment) => insertPlainText(fragment, 0, "w".repeat(2000)));
        let sent = 0;
        const original = port.send.bind(port);
        port.send = async (documentId, sender, payload) => {
          sent += 1;
          if (sender === "bob" && sent === 4) {
            return "lost"; // accepted, and never delivered
          }
          return original(documentId, sender, payload);
        };
        await vi.advanceTimersByTimeAsync(500);
        await alice.sync();
        expect(getPlainText(alice.fragment)).toBe(""); // nothing of a cut message applies until it is whole
        expect(alice.syncHealth.incoming).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(20_000); // bob's heartbeat: the state he holds
        await alice.sync();
        await vi.advanceTimersByTimeAsync(5_000); // alice has waited a latency and still lacks it
        expect(alice.syncHealth.suspicions).toEqual([
          expect.objectContaining({ kind: "behind-heartbeat", sender: "bob" }),
        ]);
        await vi.advanceTimersByTimeAsync(5_000);
        await alice.sync(); // she asks by herself: a peer answers the creator
        await bob.sync(); // bob answers with his state, itself cut into parts
        await vi.advanceTimersByTimeAsync(0);
        await alice.sync();
        expect(getPlainText(alice.fragment)).toBe("w".repeat(2000));
        expect(alice.syncHealth.state).toBe("ok");
      });

      it("cannot cut anything when the limit leaves no room for a part: the change is dropped and reported once, and the client carries on", async () => {
        const errors: unknown[] = [];
        const tiny = new FlakySendPort();
        // The transport says 20 bytes but does not enforce it until the client exists, so the
        // document can be created; a fragment's own header is 25 bytes, so nothing can be cut.
        tiny.profile = {
          bounds: { minIntervalMs: null, maxBytes: 20 },
          profiles: [
            {
              id: "standard",
              label: "Standard",
              description: "",
              values: {
                minIntervalMs: 0,
                maxIntervalMs: null,
                minChars: 0,
                maxChars: null,
                expectedLatencyMs: 0,
              },
            },
          ],
          defaultProfile: "standard",
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
          errors.filter((e) => e instanceof Error && e.name === "FragmentationImpossibleError"),
        ).toHaveLength(1);
        expect(solo.hasPendingChanges).toBe(false);
        expect(getPlainText(solo.fragment)).toBe("no room"); // still applied locally
      });

      it("a client on a transport that states no limit never splits anything", async () => {
        const port = new FlakySendPort();
        const { alice, bob } = await pair(port);
        alice.edit((fragment) => insertPlainText(fragment, 0, "q".repeat(20_000)));
        await vi.advanceTimersByTimeAsync(500);
        expect(new Set(await frameKinds(port))).not.toContain("fragment");
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
        expect(heartbeat).toMatchObject({ kind: "heartbeat", controlSequence: 0 });
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
        expect(last?.kind === "heartbeat" && last.controlSequence).toBe(alice.controlSequence);
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
        await vi.advanceTimersByTimeAsync(20_000); // alice's heartbeat carries control sequence 1
        await bob.sync();
        expect(bob.controlSequence).toBe(0); // bob never saw it
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

        it("a joiner's request alone makes no bystander suspect it went quiet, and starts no cascade of requests (LOS-3)", async () => {
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
          expect(await bob.requestResync()).toEqual({ sent: true });
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
