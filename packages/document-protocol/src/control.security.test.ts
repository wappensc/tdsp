import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import type {
  Delivery,
  DocumentId,
  MemberId,
  MessengerPort,
  RawChannel,
} from "@tdsp/messenger-port";
import { createDocument, encodeUpdate, getPlainText, insertPlainText } from "@tdsp/reconciliation";
import { describe, expect, it } from "vitest";
import { encodeControlFrame, encodeResyncResponseFrame } from "./framing";
import {
  ControlFrameRejectedError,
  DocumentEngine,
  type PersistedControlState,
  SendRefusedError,
} from "./index";

/**
 * Who may change a document, and what everyone else refuses (SPECIFICATION.md §7): the
 * creator's control frames, permissions and their enforcement on send, a joiner's bootstrap,
 * replayed, stale and forged control state, closing, snapshots, and a creator's persisted
 * control state and outbox (CTL-12). Security tests: only the CI role may change this file
 * (.github/CODEOWNERS, CONTRIBUTING.md).
 */

const DOCUMENT_ID = "doc-1";

/** Every test here is about control state, not batching: each sends at once. */
const IMMEDIATE = { batchWindowMs: 0 };

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

describe("control frames", () => {
  const AS_ALICE = { ...IMMEDIATE, creatorMemberId: "alice" };

  // The in-memory transport models no membership or permission at all, so the
  // protocol-level behaviour under test is all that decides each outcome.
  async function pair(messenger: InMemoryMessengerPort) {
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

  it("the creator's grant reaches another client, which then knows the permission", async () => {
    const messenger = new InMemoryMessengerPort();
    const { alice, bob } = await pair(messenger);
    await alice.setMembership("bob", "write");
    await bob.sync();

    expect(bob.permissionOf("bob")).toBe("write");
    expect(bob.permissionOf("alice")).toBe("creator");
    expect(alice.permissionOf("bob")).toBe("write");
    expect(bob.controlSequence).toBe(1);
  });

  it("a member demoted to read refuses to send, permanently, and the refusal is a named error", async () => {
    const messenger = new InMemoryMessengerPort();
    const broadcastErrors: unknown[] = [];
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    const bob = await DocumentEngine.join(
      DOCUMENT_ID,
      "bob",
      messenger,
      (error, context) => {
        if (context === "broadcast") broadcastErrors.push(error);
      },
      AS_ALICE,
    );
    await alice.sync(); // bootstraps bob (CTL-13)
    await alice.setMembership("bob", "write");
    await bob.sync();
    bob.edit((fragment) => insertPlainText(fragment, 0, "allowed"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(broadcastErrors).toHaveLength(0);

    await alice.setMembership("bob", "read");
    await bob.sync();
    bob.edit((fragment) => insertPlainText(fragment, 0, "refused"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(broadcastErrors).toHaveLength(1);
    expect(broadcastErrors[0]).toBeInstanceOf(SendRefusedError);
    expect((broadcastErrors[0] as SendRefusedError).reason).toBe("read-only");
  });

  it("a joiner may not edit before the creator has bootstrapped it", async () => {
    const messenger = new InMemoryMessengerPort();
    const errors: unknown[] = [];
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    const bob = await DocumentEngine.join(
      DOCUMENT_ID,
      "bob",
      messenger,
      (error) => errors.push(error),
      AS_ALICE,
    );
    expect(bob.mayEdit).toBe(false);
    bob.edit((fragment) => insertPlainText(fragment, 0, "too early"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toHaveLength(1);
    expect((errors[0] as SendRefusedError).reason).toBe("awaiting-bootstrap");
    await alice.sync();
    expect(getPlainText(alice.fragment)).not.toContain("too early");
  });

  it("once bootstrapped, a joiner whose permission is still unknown may edit", async () => {
    const messenger = new InMemoryMessengerPort();
    const errors: unknown[] = [];
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    const bob = await DocumentEngine.join(
      DOCUMENT_ID,
      "bob",
      messenger,
      (error) => errors.push(error),
      AS_ALICE,
    );
    await alice.sync();
    await bob.sync(); // the creator's answer
    expect(bob.permissionOf("bob")).toBeUndefined();
    expect(bob.mayEdit).toBe(true);
    bob.edit((fragment) => insertPlainText(fragment, 0, "in time "));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toHaveLength(0);
    await alice.sync();
    expect(getPlainText(alice.fragment)).toContain("in time");
  });

  it("the creator may always edit its own open document", async () => {
    const messenger = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    expect(alice.mayEdit).toBe(true);
    await alice.closeDocument();
    expect(alice.mayEdit).toBe(false);
  });

  it("a control frame from anyone but the creator is ignored, and reported as such", async () => {
    const messenger = new InMemoryMessengerPort();
    const { alice, bob, applyErrors } = await pair(messenger);
    await messenger.send(
      DOCUMENT_ID,
      "mallory",
      encodeControlFrame({
        documentId: DOCUMENT_ID,
        sequence: 1,
        action: "membership",
        member: "mallory",
        permission: "write",
      }),
    );
    await bob.sync();
    await alice.sync();

    expect(bob.permissionOf("mallory")).toBeUndefined();
    const rejected = applyErrors.filter((e) => e instanceof ControlFrameRejectedError);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as ControlFrameRejectedError).reason).toBe("not-from-creator");
  });

  it("refuses to join without the creator's member id, which the invitation always carries (LIF-4)", async () => {
    // Such a client could accept no control frame and no resync response, and would
    // silently never converge; the rules for an unknown creator remain as a defence.
    const messenger = new InMemoryMessengerPort();
    await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    await expect(
      DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, IMMEDIATE),
    ).rejects.toThrow(/without the creator's member id/);
    await expect(
      DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, { creatorMemberId: "" }),
    ).rejects.toThrow(/without the creator's member id/);
  });

  it("closes the replay gap: an old signed frame resent under a new delivery id is inert", async () => {
    const messenger = new InMemoryMessengerPort();
    const { alice, bob } = await pair(messenger);
    const oldGrant = encodeControlFrame({
      documentId: DOCUMENT_ID,
      sequence: 1,
      action: "membership",
      member: "bob",
      permission: "write",
    });
    await alice.setMembership("bob", "write"); // sequence 1
    await alice.setMembership("bob", "read"); // sequence 2: demoted
    await bob.sync();
    expect(bob.permissionOf("bob")).toBe("read");

    // Anyone who once received sequence 1 can resend those exact bytes, as
    // alice, under a fresh delivery id — the email-adapter replay.
    await messenger.send(DOCUMENT_ID, "alice", oldGrant);
    await bob.sync();

    expect(bob.permissionOf("bob")).toBe("read");
  });

  it("a late frame for a member nobody has mentioned since still applies, and the gap closes", async () => {
    const messenger = new InMemoryMessengerPort();
    const { alice, bob } = await pair(messenger);
    messenger.holdNextSend("alice");
    await alice.setMembership("carol", "write"); // sequence 1, held back
    await alice.setMembership("bob", "read"); // sequence 2, delivered
    await bob.sync();

    expect(bob.permissionOf("bob")).toBe("read");
    expect(bob.permissionOf("carol")).toBeUndefined();
    expect(bob.controlGaps).toEqual([1]);

    messenger.releaseHeld(DOCUMENT_ID);
    await bob.sync();

    expect(bob.permissionOf("carol")).toBe("write");
    expect(bob.controlGaps).toEqual([]);
  });

  it("a control message lost in transit is a detectable gap", async () => {
    const messenger = new InMemoryMessengerPort();
    const { alice, bob } = await pair(messenger);
    messenger.dropNextSend("alice");
    await alice.setMembership("carol", "write"); // sequence 1, dropped
    await alice.setMembership("bob", "write"); // sequence 2
    await bob.sync();

    expect(bob.controlGaps).toEqual([1]);
    expect(bob.controlSequence).toBe(2);
  });

  it("a failed control send does not consume a sequence number", async () => {
    const messenger = new InMemoryMessengerPort();
    const { alice, bob } = await pair(messenger);
    messenger.disconnect("alice");
    await expect(alice.setMembership("bob", "write")).rejects.toThrow();
    messenger.reconnect("alice");
    await alice.setMembership("bob", "write");
    await bob.sync();

    expect(alice.controlSequence).toBe(1);
    expect(bob.controlSequence).toBe(1);
    expect(bob.controlGaps).toEqual([]);
  });

  it("only the creator can change membership or close, and the creator's own record is fixed", async () => {
    const messenger = new InMemoryMessengerPort();
    const { alice, bob } = await pair(messenger);

    await expect(bob.setMembership("bob", "write")).rejects.toThrow(/not the creator/);
    await expect(bob.closeDocument()).rejects.toThrow(/not the creator/);
    await expect(alice.setMembership("alice", "read")).rejects.toThrow(/permanent/);
    await expect(alice.setMembership("bob", "creator" as unknown as "write")).rejects.toThrow(
      /creator status cannot be granted/,
    );
  });

  it("closing is idempotent and terminal: nothing more can be granted afterwards", async () => {
    const messenger = new InMemoryMessengerPort();
    const { alice } = await pair(messenger);
    await alice.closeDocument();
    await alice.closeDocument();

    expect(alice.closed).toBe(true);
    expect(alice.controlSequence).toBe(1);
    await expect(alice.setMembership("bob", "write")).rejects.toBeInstanceOf(SendRefusedError);
  });

  function forgedResponse(snapshot: unknown): string {
    return encodeResyncResponseFrame({
      documentId: DOCUMENT_ID,
      respondsTo: "f0f0f0f0f0f0f0f0",
      update: encodeUpdate(createDocument()),
      attribution: null,
      control: snapshot as Record<string, unknown>,
    });
  }

  /**
   * SPECIFICATION.md LIF-6: a close stops new edits at their sender, not in delivery.
   * Bob's edit and Alice's close are unordered on the transport; whichever a receiver sees
   * first, it must end with the same content — discarding an edit that arrives after the
   * close would leave two receivers of the same messages with different documents for good.
   */
  async function closeRace(order: "edit-first" | "close-first") {
    const messenger = new InMemoryMessengerPort();
    const { alice, bob } = await pair(messenger);
    const carol = await DocumentEngine.join(DOCUMENT_ID, "carol", messenger, undefined, AS_ALICE);
    alice.edit((fragment) => insertPlainText(fragment, 0, "before "));
    await alice.sync(); // bootstraps bob and carol (CTL-13)
    await bob.sync();
    await carol.sync();

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
    const editFirst = await closeRace("edit-first");
    const closeFirst = await closeRace("close-first");

    for (const { alice, carol } of [editFirst, closeFirst]) {
      expect(carol.closed).toBe(true);
      expect(getPlainText(carol.fragment)).toBe("before bob's late words");
      expect(getPlainText(alice.fragment)).toBe("before bob's late words");
    }
  });

  it("after a close, no client sends an edit of its own", async () => {
    const messenger = new InMemoryMessengerPort();
    const { alice, bob } = await pair(messenger);
    await alice.closeDocument();
    await bob.sync();
    const before = (await messenger.receive(DOCUMENT_ID, "alice")).length;

    bob.edit((fragment) => insertPlainText(fragment, 0, "after the close"));
    await bob.flush().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));

    const after = await messenger.receive(DOCUMENT_ID, "alice");
    expect(after.slice(before).map((d) => JSON.parse(d.payload).kind)).not.toContain("edit");
  });

  it("a snapshot from anyone but the creator is ignored", async () => {
    const messenger = new InMemoryMessengerPort();
    const { bob } = await pair(messenger);
    await messenger.send(
      DOCUMENT_ID,
      "mallory",
      forgedResponse({ sequence: 9, closed: true, members: { mallory: "write" } }),
    );
    await bob.sync();

    expect(bob.closed).toBe(false);
    expect(bob.permissionOf("mallory")).toBeUndefined();
    expect(bob.controlSequence).toBe(0);
  });

  it("a snapshot never reopens a closed document", async () => {
    const messenger = new InMemoryMessengerPort();
    const { alice, bob } = await pair(messenger);
    await alice.closeDocument();
    await bob.sync();
    expect(bob.closed).toBe(true);

    await messenger.send(
      DOCUMENT_ID,
      "alice",
      forgedResponse({ sequence: 10, closed: false, members: {} }),
    );
    await bob.sync();

    expect(bob.closed).toBe(true);
  });

  it("a snapshot older than what a client already applied is ignored", async () => {
    const messenger = new InMemoryMessengerPort();
    const { alice, bob } = await pair(messenger);
    await alice.setMembership("carol", "write"); // sequence 1
    await alice.setMembership("dora", "read"); // sequence 2
    await alice.setMembership("erin", "write"); // sequence 3
    await bob.sync();
    expect(bob.permissionOf("carol")).toBe("write");

    // A stale snapshot (sequence 1, and it knows nobody) must not wipe what bob knows.
    await messenger.send(
      DOCUMENT_ID,
      "alice",
      forgedResponse({ sequence: 1, closed: false, members: {} }),
    );
    await bob.sync();

    expect(bob.permissionOf("carol")).toBe("write");
    expect(bob.permissionOf("erin")).toBe("write");
    expect(bob.controlSequence).toBe(3);
  });

  it("a closed document still bootstraps a joiner, who learns it is closed from the creator", async () => {
    const messenger = new NoHistoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    await alice.sync(); // establishes alice's own receive() baseline before dave ever joins
    alice.edit((fragment) => insertPlainText(fragment, 0, "finished text"));
    await alice.closeDocument();

    const dave = await DocumentEngine.join(DOCUMENT_ID, "dave", messenger, undefined, AS_ALICE);
    await alice.sync(); // the creator answers, even though the document is closed
    await dave.sync();

    expect(dave.hasCompletedBootstrap).toBe(true);
    expect(getPlainText(dave.fragment)).toBe("finished text");
    expect(dave.closed).toBe(true);
  });

  it("a joiner on a history-less transport learns everyone's permissions from the creator's snapshot", async () => {
    const messenger = new NoHistoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    await alice.sync(); // establishes alice's own receive() baseline before dave ever joins
    await alice.setMembership("bob", "write"); // sequence 1
    await alice.setMembership("carol", "read"); // sequence 2
    await alice.setMembership("bob", null); // sequence 3: revoked again

    const dave = await DocumentEngine.join(DOCUMENT_ID, "dave", messenger, undefined, AS_ALICE);
    expect(dave.memberPermissions.size).toBe(0); // no history: it heard none of the frames
    await alice.sync();
    await dave.sync();

    expect(dave.permissionOf("carol")).toBe("read");
    expect(dave.permissionOf("bob")).toBeUndefined(); // revoked, so absent from the snapshot
    expect(dave.controlSequence).toBe(3);
    expect(dave.controlGaps).toEqual([]);
  });

  it("a control frame at or below a snapshot's sequence is stale once the snapshot is adopted", async () => {
    const messenger = new NoHistoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    await alice.sync(); // establishes alice's own receive() baseline before dave ever joins
    await alice.setMembership("carol", "read"); // sequence 1
    await alice.setMembership("carol", "write"); // sequence 2

    const dave = await DocumentEngine.join(DOCUMENT_ID, "dave", messenger, undefined, AS_ALICE);
    await alice.sync();
    await dave.sync();
    expect(dave.permissionOf("carol")).toBe("write");

    // Replaying sequence 1 (carol -> read) after the snapshot must not undo it.
    await messenger.send(
      DOCUMENT_ID,
      "alice",
      encodeControlFrame({
        documentId: DOCUMENT_ID,
        sequence: 1,
        action: "membership",
        member: "carol",
        permission: "read",
      }),
    );
    await dave.sync();

    expect(dave.permissionOf("carol")).toBe("write");
  });

  describe("healing control state through a resync", () => {
    it("the creator answers a client that only lost a control frame, though there is no content to send", async () => {
      const messenger = new InMemoryMessengerPort();
      const { alice, bob } = await pair(messenger);
      await bob.sync();
      messenger.dropNextSend("alice");
      await alice.setMembership("carol", "write"); // sequence 1, lost
      await alice.setMembership("bob", "read"); // sequence 2
      await bob.sync();
      expect(bob.controlGaps).toEqual([1]);
      expect(bob.permissionOf("carol")).toBeUndefined();

      await bob.requestResync();
      await alice.sync();
      await bob.sync();

      expect(bob.permissionOf("carol")).toBe("write");
      expect(bob.permissionOf("bob")).toBe("read");
      expect(bob.controlGaps).toEqual([]);
    });

    it("a client that is fully up to date on content and control gets no answer at all", async () => {
      const messenger = new InMemoryMessengerPort();
      const { alice, bob } = await pair(messenger);
      await alice.setMembership("bob", "write");
      await alice.sync(); // answers bob's join-time request, so it is not counted below
      await bob.sync();
      alice.edit((fragment) => insertPlainText(fragment, 0, "caught up"));
      await bob.sync();

      await bob.requestResync();
      // Measured after bob's own resync-request frame, so only what alice's
      // own sync() adds is being checked.
      const before = (await messenger.receive(DOCUMENT_ID, "alice")).length;
      await alice.sync();

      expect((await messenger.receive(DOCUMENT_ID, "alice")).length).toBe(before);
    });
  });

  describe("a creator that re-attaches to its own document (CTL-12)", () => {
    async function restart(messenger: InMemoryMessengerPort, controlState?: PersistedControlState) {
      return DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, {
        ...AS_ALICE,
        ...(controlState ? { controlState } : {}),
      });
    }

    it("without its persisted control state, a restarted creator's next frame is stale everywhere — the failure this option exists to prevent", async () => {
      const messenger = new InMemoryMessengerPort();
      const { alice, bob } = await pair(messenger);
      await alice.setMembership("bob", "write"); // sequence 1
      await alice.setMembership("carol", "read"); // sequence 2
      await bob.sync();

      const restarted = await restart(messenger); // counter back to 0
      // Issued as sequence 1 — which carried another frame. On a transport with history the
      // restarted creator has read its own earlier frames and refuses before sending (CTL-17);
      // on one without, every receiver would drop the frame as stale.
      const refusal = await restarted.setMembership("bob", "read").catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(ControlFrameRejectedError);
      expect((refusal as ControlFrameRejectedError).reason).toBe("sequence-conflict");
      await bob.sync();

      expect(bob.permissionOf("bob")).toBe("write"); // the demotion never took effect
    });

    it("with it, the counter continues and the next frame counts", async () => {
      const messenger = new InMemoryMessengerPort();
      const { alice, bob } = await pair(messenger);
      await alice.setMembership("bob", "write"); // 1
      await alice.setMembership("carol", "read"); // 2
      await bob.sync();

      const restarted = await restart(messenger, alice.controlState);
      expect(restarted.controlSequence).toBe(2);
      await restarted.setMembership("bob", "read"); // 3
      await bob.sync();

      expect(restarted.controlSequence).toBe(3);
      expect(bob.permissionOf("bob")).toBe("read");
      expect(bob.controlGaps).toEqual([]);
    });

    it("and its control snapshot, sent to a joiner, still lists everyone it had granted", async () => {
      const messenger = new NoHistoryMessengerPort();
      const alice = await DocumentEngine.create(
        DOCUMENT_ID,
        "alice",
        messenger,
        undefined,
        AS_ALICE,
      );
      await alice.setMembership("bob", "write");
      await alice.setMembership("carol", "read");

      const restarted = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, {
        ...AS_ALICE,
        controlState: alice.controlState,
      });
      const dave = await DocumentEngine.join(DOCUMENT_ID, "dave", messenger, undefined, AS_ALICE);
      await restarted.sync();
      await dave.sync();

      expect(dave.permissionOf("bob")).toBe("write");
      expect(dave.permissionOf("carol")).toBe("read");
      expect(dave.controlSequence).toBe(2);
    });

    it("is ignored for anyone but the creator: a non-creator always re-bootstraps its control state", async () => {
      const messenger = new InMemoryMessengerPort();
      await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
      const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, {
        ...AS_ALICE,
        controlState: { sequence: 9, closed: true, members: { bob: "read" } },
      });

      expect(bob.closed).toBe(false);
      expect(bob.controlSequence).toBe(0);
      expect(bob.permissionOf("bob")).toBeUndefined();
    });

    /**
     * SPECIFICATION.md CTL-12, CTL-17: the outbox. A creator that crashes between the
     * messenger accepting a control frame and persisting that it did must never give the
     * frame's number to another action.
     */
    describe("the control outbox", () => {
      const grantCarolRead = (sequence: number) =>
        encodeControlFrame({
          documentId: DOCUMENT_ID,
          sequence,
          action: "membership",
          member: "carol",
          permission: "read",
        });

      it("persists a control frame as pending before the messenger sees it", async () => {
        const messenger = new InMemoryMessengerPort();
        let persisted: PersistedControlState | undefined;
        let persistedWhenSent: PersistedControlState | undefined;
        const watching: MessengerPort = {
          createDocument: (documentId, creator) => messenger.createDocument(documentId, creator),
          receive: (documentId, member) => messenger.receive(documentId, member),
          listChannels: (member) => messenger.listChannels(member),
          transportProfile: () => messenger.transportProfile(),
          send: (documentId: DocumentId, sender: MemberId, payload: string) => {
            persistedWhenSent = persisted;
            return messenger.send(documentId, sender, payload);
          },
        };
        const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", watching, undefined, {
          ...AS_ALICE,
          onControlStateChange: (state) => {
            persisted = state;
          },
        });
        await alice.setMembership("bob", "write");
        expect(persistedWhenSent?.pendingControl).toContain('"member":"bob"');
        expect(persisted?.pendingControl).toBeUndefined(); // committed afterwards
        expect(persisted?.sequence).toBe(1);
      });

      it("after a crash once the messenger had accepted it, resends the same frame and uses the next number", async () => {
        const messenger = new InMemoryMessengerPort();
        const { alice, bob } = await pair(messenger);
        await alice.setMembership("bob", "write"); // 1
        const pending = grantCarolRead(2);
        await messenger.send(DOCUMENT_ID, "alice", pending); // accepted — then the crash
        const restarted = await restart(messenger, {
          ...alice.controlState,
          pendingControl: pending,
        });

        await restarted.setMembership("dave", "write");
        await bob.sync();

        expect(restarted.controlSequence).toBe(3); // 2 stayed carol's
        expect(bob.permissionOf("carol")).toBe("read");
        expect(bob.permissionOf("dave")).toBe("write");
        expect(bob.controlGaps).toEqual([]);
      });

      it("after a crash before the send, sends the pending frame first", async () => {
        const messenger = new InMemoryMessengerPort();
        const { alice, bob } = await pair(messenger);
        await alice.setMembership("bob", "write"); // 1
        const restarted = await restart(messenger, {
          ...alice.controlState,
          pendingControl: grantCarolRead(2),
        });

        await restarted.setMembership("dave", "write");
        await bob.sync();

        expect(restarted.controlSequence).toBe(3);
        expect(bob.permissionOf("carol")).toBe("read");
        expect(bob.permissionOf("dave")).toBe("write");
        // The very text persisted, byte for byte, and before the new frame.
        const sent = (await messenger.receive(DOCUMENT_ID, "bob"))
          .filter((d) => d.sender === "alice" && JSON.parse(d.payload).kind === "control")
          .map((d) => d.payload);
        expect(sent.slice(-2)[0]).toBe(grantCarolRead(2));
        expect(JSON.parse(sent.at(-1) as string).sequence).toBe(3);
      });

      it("sends nothing when the application cannot persist the frame, and the number stays free", async () => {
        const messenger = new InMemoryMessengerPort();
        let storageFull = true;
        const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
          ...AS_ALICE,
          onControlStateChange: () => {
            if (storageFull) {
              throw new Error("storage is full");
            }
          },
        });
        const controlFrames = async () =>
          (await messenger.receive(DOCUMENT_ID, "alice")).filter(
            (d) => JSON.parse(d.payload).kind === "control",
          );

        await expect(alice.setMembership("bob", "write")).rejects.toThrow("storage is full");
        expect(await controlFrames()).toHaveLength(0);
        expect(alice.controlState).not.toHaveProperty("pendingControl");
        expect(alice.controlSequence).toBe(0);

        storageFull = false;
        await alice.setMembership("bob", "write");
        expect(await controlFrames()).toHaveLength(1);
        expect(alice.controlSequence).toBe(1);
      });

      it("keeps a frame restored as pending pending when persisting it again fails", async () => {
        const messenger = new InMemoryMessengerPort();
        const { alice, bob } = await pair(messenger);
        await alice.setMembership("bob", "write"); // 1
        const pending = grantCarolRead(2);
        let storageFull = true;
        const restarted = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, {
          ...AS_ALICE,
          controlState: { ...alice.controlState, pendingControl: pending },
          onControlStateChange: () => {
            if (storageFull) {
              throw new Error("storage is full");
            }
          },
        });
        await expect(restarted.setMembership("dave", "write")).rejects.toThrow("storage is full");
        const sent = async () =>
          (await messenger.receive(DOCUMENT_ID, "alice"))
            .filter((d) => JSON.parse(d.payload).kind === "control")
            .map((d) => d.payload);
        expect(await sent()).not.toContain(pending);

        storageFull = false;
        await restarted.setMembership("dave", "write");
        await bob.sync();
        expect((await sent()).slice(-2)[0]).toBe(pending); // still owed, and first
        expect(restarted.controlSequence).toBe(3);
        expect(bob.permissionOf("carol")).toBe("read");
      });

      it("a receiver refuses a different frame under a number it already holds, and says so", async () => {
        const messenger = new InMemoryMessengerPort();
        const { alice, bob, applyErrors } = await pair(messenger);
        await alice.setMembership("bob", "write"); // 1
        await bob.sync();
        await messenger.send(DOCUMENT_ID, "alice", grantCarolRead(1)); // 1 again, another action
        await bob.sync();

        expect(bob.permissionOf("carol")).toBeUndefined();
        expect(
          applyErrors.some(
            (error) =>
              error instanceof ControlFrameRejectedError && error.reason === "sequence-conflict",
          ),
        ).toBe(true);
      });
    });

    it("reports every change to the control state, so the application can persist it", async () => {
      const messenger = new InMemoryMessengerPort();
      const seen: number[] = [];
      const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
        ...AS_ALICE,
        onControlStateChange: (state) =>
          seen.push(state.pendingControl === undefined ? state.sequence : -state.sequence - 1),
      });
      await alice.setMembership("bob", "write");
      await alice.closeDocument();

      // Each frame is announced as pending (negative here) before it is sent, then committed.
      expect(seen).toEqual([-1, 1, -2, 2]);
      expect(alice.controlState).toMatchObject({
        sequence: 2,
        closed: true,
        members: { bob: "write" },
      });
    });
  });
});
