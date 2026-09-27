import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import type {
  Delivery,
  DocumentId,
  MemberId,
  MessengerPort,
  RawChannel,
} from "@tdsp/messenger-port";
import {
  createDocument,
  encodeUpdate,
  getFragment,
  getPlainText,
  insertPlainText,
  transact,
} from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeFrame,
  encodeControlFrame,
  encodeEditFrame,
  encodeFragmentFrame,
  encodeResyncResponseFrame,
  FrameDecodeError,
} from "./framing";
import {
  ControlFrameRejectedError,
  DocumentEngine,
  type DocumentEngineOptions,
  resolveSyncPolicy,
  SendRefusedError,
} from "./index";

/**
 * Authority over a document beyond its control frames (see control.security.test.ts):
 * members who may not write cannot, only the creator answers a resync and only its answer
 * is adopted, a creator's answer is checked whole before any of it applies, the sync policy
 * is the creator's alone, and a fragment cannot smuggle a frame for another document.
 * Security tests: only the CI role may change this file (.github/CODEOWNERS, CONTRIBUTING.md).
 */

const DOCUMENT_ID = "doc-1";
/** Sends at once, so each test sees its effects without waiting for a batch. */
const IMMEDIATE = { batchWindowMs: 0 };
const ADMIN_ALICE = { ...IMMEDIATE, creatorMemberId: "alice" };

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

/** A real `InMemoryMessengerPort` that counts how often it was asked to send. */
class CountingPort implements MessengerPort {
  readonly inner = new InMemoryMessengerPort();
  sendAttempts = 0;

  createDocument(documentId: DocumentId, creator: MemberId): Promise<void> {
    return this.inner.createDocument(documentId, creator);
  }

  send(documentId: DocumentId, sender: MemberId, payload: string): Promise<string> {
    this.sendAttempts += 1;
    return this.inner.send(documentId, sender, payload);
  }

  receive(documentId: DocumentId, member: MemberId): Promise<readonly Delivery[]> {
    return this.inner.receive(documentId, member);
  }

  listChannels(member: MemberId): Promise<readonly RawChannel[]> {
    return this.inner.listChannels(member);
  }
}

/** A creator and a joiner who has bootstrapped, on the fake clock the scheduler waits on. */
async function pair(
  port: MessengerPort,
  aliceOptions: DocumentEngineOptions = {},
  bobOptions: DocumentEngineOptions = {},
  onBobError: (error: unknown, context: string) => void = () => {},
) {
  const AS_ALICE = { creatorMemberId: "alice" };
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

/** The scheduler's clock, as the send-scheduling tests set it. */
function onTheSchedulersClock(): void {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}

describe("members who may not write", () => {
  it("a read-only member can request a resync but still cannot create an accepted edit", async () => {
    const messenger = new InMemoryMessengerPort();
    const broadcastErrors: unknown[] = [];
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
      (error) => broadcastErrors.push(error),
      { ...IMMEDIATE, creatorMemberId: "alice" },
    );
    await alice.setMembership("bob", "read");
    await alice.sync(); // the creator answers bob's join-time request...
    await bob.sync(); // ...which bob applies, so his one resync slot is free again

    // requesting a resync is not gated by permission at all.
    await expect(bob.requestResync()).resolves.toEqual({ sent: true });

    // but bob still cannot broadcast an edit — the actual guarantee
    // requestResync() must not weaken. edit() itself always succeeds
    // locally; bob's own client refuses the resulting broadcast, as it does
    // after a close (control.security.test.ts).
    bob.edit((fragment) => insertPlainText(fragment, 0, "should not reach alice"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(broadcastErrors).toHaveLength(1);
    expect(broadcastErrors[0]).toBeInstanceOf(SendRefusedError);

    await alice.sync();
    expect(getPlainText(alice.fragment)).not.toContain("should not reach alice");
  });

  describe("under the send scheduler", () => {
    onTheSchedulersClock();

    it("does not retry an edit its own client refuses: a demoted member's edits are dropped, not sent forever", async () => {
      const port = new CountingPort();
      const errors: unknown[] = [];
      const { alice, bob } = await pair(port, {}, {}, (error) => errors.push(error));
      await alice.setMembership("bob", "read");
      await bob.sync();
      const attemptsBefore = port.sendAttempts;

      bob.edit((fragment) => insertPlainText(fragment, 0, "not allowed"));
      await vi.advanceTimersByTimeAsync(600_000);

      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(SendRefusedError);
      expect(port.sendAttempts).toBe(attemptsBefore); // never reached the transport
      expect(bob.hasPendingChanges).toBe(false);
    });
  });
});

describe("resync answers come from the creator alone", () => {
  it("only the creator answers: a peer that also holds the content stays silent, and the creator's single answer heals the joiner", async () => {
    const messenger = new InMemoryMessengerPort();
    const AS_ALICE = { ...IMMEDIATE, creatorMemberId: "alice", resyncResponseThrottleMs: 0 };
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, AS_ALICE);
    const carol = await DocumentEngine.join(DOCUMENT_ID, "carol", messenger, undefined, AS_ALICE);

    // Both joins are answered and applied first: a client holds one resync slot at a
    // time, so bob's next request is only sent once his join is done.
    await alice.sync();
    await bob.sync();
    await carol.sync();
    alice.edit((fragment) => insertPlainText(fragment, 0, "shared"));
    await bob.sync();
    await carol.sync();

    // bob falls behind while disconnected; carol stays caught up — so both
    // alice and carol hold "shared more", which bob lacks.
    messenger.disconnect("bob");
    alice.edit((fragment) => insertPlainText(fragment, getPlainText(fragment).length, " more"));
    await carol.sync();
    expect(getPlainText(carol.fragment)).toBe("shared more");
    messenger.reconnect("bob");

    await bob.requestResync();
    const deliveriesBefore = (await messenger.receive(DOCUMENT_ID, "alice")).length;

    await carol.sync(); // holds what bob lacks, but is not the creator
    expect((await messenger.receive(DOCUMENT_ID, "alice")).length).toBe(deliveriesBefore);

    await alice.sync(); // the creator answers, once
    await bob.sync();

    expect(getPlainText(bob.fragment)).toBe("shared more");
    expect((await messenger.receive(DOCUMENT_ID, "alice")).length - deliveriesBefore).toBe(1);
  });

  it("a non-creator never answers a joiner, so there is nothing to attempt and nothing to surface on its pane", async () => {
    const messenger = new NoHistoryMessengerPort();
    const alice = await DocumentEngine.create(
      DOCUMENT_ID,
      "alice",
      messenger,
      undefined,
      ADMIN_ALICE,
    );
    await alice.sync(); // establishes alice's own receive() baseline before carol ever joins
    alice.edit((fragment) => insertPlainText(fragment, 0, "content"));
    const carolOnError = vi.fn();
    const carol = await DocumentEngine.join(
      DOCUMENT_ID,
      "carol",
      messenger,
      carolOnError,
      ADMIN_ALICE,
    );
    await alice.sync();
    await carol.sync();
    expect(getPlainText(carol.fragment)).toBe("content"); // carol is caught up
    carolOnError.mockClear();

    // bob joins later, needing what only alice or carol could offer — alice
    // never syncs again, and carol, not being the creator, does not answer.
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, ADMIN_ALICE);
    const before = (await messenger.inner.receive(DOCUMENT_ID, "carol")).length;
    await carol.sync();

    expect(carolOnError).not.toHaveBeenCalled();
    expect((await messenger.inner.receive(DOCUMENT_ID, "carol")).length).toBe(before);
    expect(getPlainText(bob.fragment)).toBe(""); // and, honestly, bob stays empty until the creator is online
  });

  it("a joiner ignores a resync response from a non-creator, so only the creator's overlay can be adopted", async () => {
    const messenger = new NoHistoryMessengerPort();
    const alice = await DocumentEngine.create(
      DOCUMENT_ID,
      "alice",
      messenger,
      undefined,
      ADMIN_ALICE,
    );
    alice.edit((fragment) => insertPlainText(fragment, 0, "content"));
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, ADMIN_ALICE);
    const [bobRequest] = await resyncRequestsFrom(messenger.inner, DOCUMENT_ID, "alice");
    if (!bobRequest) {
      throw new Error("expected bob's join-time resync request to be recorded");
    }
    const update = encodeUpdate(alice.document);
    const frameFrom = (author: string) =>
      encodeResyncResponseFrame({
        documentId: DOCUMENT_ID,
        respondsTo: bobRequest.id,
        update,
        attribution: {
          ranges: [{ start: 0, end: 7, authorId: author }],
          lastEditBySender: { [author]: 7 },
        },
      });

    await messenger.inner.send(DOCUMENT_ID, "carol", frameFrom("carol"));
    await bob.sync();
    expect(getPlainText(bob.fragment)).toBe(""); // carol is not the creator: nothing applied
    expect(bob.hasCompletedBootstrap).toBe(false);

    await messenger.inner.send(DOCUMENT_ID, "alice", frameFrom("alice"));
    await bob.sync();
    expect(getPlainText(bob.fragment)).toBe("content");
    expect(bob.hasCompletedBootstrap).toBe(true);
    expect(bob.attribution.ranges[0]?.authorId).toBe("alice");
  });

  it("a creator accepts a peer's response only if it answers one of its own requests", async () => {
    const messenger = new NoHistoryMessengerPort();
    const alice = await DocumentEngine.create(
      DOCUMENT_ID,
      "alice",
      messenger,
      undefined,
      ADMIN_ALICE,
    );
    await alice.sync();
    const carolDoc = createDocument();
    transact(carolDoc, () => insertPlainText(getFragment(carolDoc), 0, "pushed at alice"));

    await messenger.inner.send(
      DOCUMENT_ID,
      "carol",
      encodeResyncResponseFrame({
        documentId: DOCUMENT_ID,
        respondsTo: "0000000000000bad",
        update: encodeUpdate(carolDoc),
        attribution: null,
      }),
    );
    await alice.sync();

    expect(getPlainText(alice.fragment)).not.toContain("pushed at alice");
  });
});

describe("a creator's answer is checked whole before any of it applies (FRM-6, CTL-10)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies none of a creator's answer whose snapshot names another profile, and says why (CTL-10)", async () => {
    const messenger = new NoHistoryMessengerPort();
    const errors: unknown[] = [];
    await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, ADMIN_ALICE);
    const carol = await DocumentEngine.join(
      DOCUMENT_ID,
      "carol",
      messenger,
      (error) => errors.push(error),
      ADMIN_ALICE,
    );
    const [request] = await resyncRequestsFrom(messenger.inner, DOCUMENT_ID, "alice");
    const content = createDocument();
    insertPlainText(getFragment(content), 0, "from another profile");
    await messenger.send(
      DOCUMENT_ID,
      "alice",
      encodeResyncResponseFrame({
        documentId: DOCUMENT_ID,
        respondsTo: request?.id ?? "0000000000000000",
        update: encodeUpdate(content),
        control: { profile: "com.example.markdown/1", sequence: 0, closed: false, members: {} },
      }),
    );
    await carol.sync();
    expect(getPlainText(carol.fragment)).toBe("");
    expect(carol.hasCompletedBootstrap).toBe(false);
    expect(errors.map((e) => (e instanceof FrameDecodeError ? e.reason : String(e)))).toEqual([
      "profile-mismatch",
    ]);
  });

  /** SPECIFICATION.md FRM-6: an invalid part of a snapshot rejects the whole response. */
  async function answerCarolWith(control: Record<string, unknown>, attribution: unknown = null) {
    const messenger = new NoHistoryMessengerPort();
    await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, ADMIN_ALICE);
    const errors: unknown[] = [];
    const carol = await DocumentEngine.join(
      DOCUMENT_ID,
      "carol",
      messenger,
      (error) => errors.push(error),
      ADMIN_ALICE,
    );
    const [request] = await resyncRequestsFrom(messenger.inner, DOCUMENT_ID, "alice");
    const content = createDocument();
    transact(content, () => insertPlainText(getFragment(content), 0, "the creator's text"));
    await messenger.send(
      DOCUMENT_ID,
      "alice",
      encodeResyncResponseFrame({
        documentId: DOCUMENT_ID,
        respondsTo: request?.id ?? "0000000000000000",
        update: encodeUpdate(content),
        attribution: attribution as object | null,
        control,
      }),
    );
    await carol.sync();
    return { carol, errors };
  }

  const VALID_SNAPSHOT = {
    profile: "yjs-paragraphs/1",
    sequence: 4,
    closed: false,
    members: { carol: "write" },
    policy: {
      minIntervalMs: 30_000,
      maxIntervalMs: 120_000,
      minChars: 0,
      maxChars: null,
      expectedLatencyMs: 60_000,
    },
    policySequence: 4,
  };

  it("a valid snapshot is applied with its content — the control case for the rejections below", async () => {
    const { carol, errors } = await answerCarolWith(VALID_SNAPSHOT);
    expect(errors).toEqual([]);
    expect(getPlainText(carol.fragment)).toBe("the creator's text");
    expect(carol.permissionOf("carol")).toBe("write");
    expect(carol.syncPolicy.minIntervalMs).toBe(30_000);
  });

  it.each<[string, Record<string, unknown>, unknown]>([
    [
      "a policy value that is not a number",
      { ...VALID_SNAPSHOT, policy: { ...VALID_SNAPSHOT.policy, minIntervalMs: "fast" } },
      null,
    ],
    [
      "null where no limit is not allowed",
      { ...VALID_SNAPSHOT, policy: { ...VALID_SNAPSHOT.policy, minChars: null } },
      null,
    ],
    ["a policy without its policySequence", { ...VALID_SNAPSHOT, policySequence: undefined }, null],
    [
      "a policySequence above the snapshot's sequence",
      { ...VALID_SNAPSHOT, policySequence: 5 },
      null,
    ],
    ["an undefined field", { ...VALID_SNAPSHOT, extra: 1 }, null],
    ["an unknown permission", { ...VALID_SNAPSHOT, members: { carol: "admin" } }, null],
    ["the creator listed as a member", { ...VALID_SNAPSHOT, members: { alice: "write" } }, null],
    [
      "an overlay whose ranges leave a gap",
      VALID_SNAPSHOT,
      {
        ranges: [
          { start: 0, end: 3, authorId: "alice" },
          { start: 4, end: 9, authorId: "bob" },
        ],
        lastEditBySender: {},
      },
    ],
    ["an overlay without lastEditBySender", VALID_SNAPSHOT, { ranges: [] }],
  ])(
    "a response with %s is rejected whole: neither its content nor its control state applies",
    async (_name, control, attribution) => {
      const { carol, errors } = await answerCarolWith(
        JSON.parse(JSON.stringify(control)) as Record<string, unknown>,
        attribution,
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(FrameDecodeError);
      expect(getPlainText(carol.fragment)).toBe("");
      expect(carol.permissionOf("carol")).toBeUndefined();
      expect(carol.syncPolicy.minIntervalMs).toBe(0);
    },
  );
});

describe("the sync policy is the creator's alone", () => {
  onTheSchedulersClock();

  const policyFrame = (sequence: number, minIntervalMs: number): string =>
    encodeControlFrame({
      documentId: DOCUMENT_ID,
      sequence,
      action: "policy",
      policy: resolveSyncPolicy({ minIntervalMs, maxIntervalMs: 600_000 }),
    });

  it("only the creator may change it", async () => {
    const port = new CountingPort();
    const { bob } = await pair(port);
    await expect(bob.setSyncPolicy({ minIntervalMs: 1 })).rejects.toThrow(/not the creator/);
  });

  it("a policy from anyone but the creator is ignored, and reported", async () => {
    const port = new CountingPort();
    const errors: unknown[] = [];
    const { bob } = await pair(port, {}, {}, (error) => errors.push(error));
    await port.inner.send(DOCUMENT_ID, "mallory", policyFrame(1, 3_000_000));
    await bob.sync();
    expect(bob.syncPolicy.minIntervalMs).toBe(0);
    expect(errors.some((e) => e instanceof ControlFrameRejectedError)).toBe(true);
  });

  it("a replayed or older policy is inert: the newest, by the creator's sequence, wins", async () => {
    const port = new CountingPort();
    const { alice, bob } = await pair(port);
    await port.inner.send(DOCUMENT_ID, "alice", policyFrame(5, 50_000)); // arrives first
    await port.inner.send(DOCUMENT_ID, "alice", policyFrame(5, 51_000)); // a different message under the same number
    await port.inner.send(DOCUMENT_ID, "alice", policyFrame(3, 3_000)); // an older one, late — last, so a bug shows
    await bob.sync();
    expect(bob.syncPolicy.minIntervalMs).toBe(50_000);
    void alice;
  });
});

describe("a fragment cannot smuggle a frame", () => {
  onTheSchedulersClock();

  it("checks the frame a fragment carried, not only the fragment: one for another document is refused", async () => {
    const errors: unknown[] = [];
    const port = new CountingPort();
    const { bob } = await pair(port, {}, {}, (error) => errors.push(error));
    const elsewhere = encodeEditFrame("some-other-document", new Uint8Array([0]));
    await port.inner.send(
      DOCUMENT_ID,
      "mallory",
      encodeFragmentFrame({
        documentId: DOCUMENT_ID, // the fragment itself claims to be for this document
        messageId: "0000000000000000",
        index: 0,
        total: 1,
        chunk: new TextEncoder().encode(elsewhere), // what it carries is not
      }),
    );
    await bob.sync();
    expect(
      errors.some((e) => e instanceof Error && /routed to the wrong document/.test(e.message)),
    ).toBe(true);
  });

  it("refuses a fragment inside a fragment, which nothing here sends", async () => {
    const errors: unknown[] = [];
    const port = new CountingPort();
    const { bob } = await pair(port, {}, {}, (error) => errors.push(error));
    const inner = encodeFragmentFrame({
      documentId: DOCUMENT_ID,
      messageId: "0000000000000000",
      index: 0,
      total: 1,
      chunk: new Uint8Array([1]),
    });
    const outer = encodeFragmentFrame({
      documentId: DOCUMENT_ID,
      messageId: "0909090909090909",
      index: 0,
      total: 1,
      chunk: new TextEncoder().encode(inner),
    });
    await port.inner.send(DOCUMENT_ID, "mallory", outer);
    await bob.sync();
    expect(
      errors.some((e) => e instanceof Error && /fragment carried another/.test(e.message)),
    ).toBe(true);
  });
});
