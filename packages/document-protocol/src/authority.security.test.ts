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
  encodeDeletions,
  encodeStateVector,
  encodeUpdate,
  getFragment,
  getPlainText,
  insertPlainText,
  splitUpdate,
  transact,
} from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { digestOf } from "./digest";
import {
  decodeFrame,
  encodeEditFrame,
  encodeResyncRequestFrame,
  encodeResyncResponseFrame,
  FrameDecodeError,
} from "./framing";
import {
  DocumentEngine,
  type DocumentEngineOptions,
  type PersistedControlState,
  REPORT_AFTER_MS,
  SendRefusedError,
} from "./index";

/**
 * Authority over a document beyond its control frames (see control.security.test.ts):
 * members who may not write cannot; a request that does not ask all is answered by the creator
 * alone, an answer nobody asked for is taken from the creator alone, and a member's answer to one's
 * own request bootstraps it and brings the overlay that stands (RSY-15); an answer to someone else
 * bootstraps nobody, and a device that is not complete hands on no control state; a creator's answer
 * is checked whole before any of it applies, and a piece of a
 * change, an edit's or an answer's, is a frame of its own, refused when it is for another document.
 * Security tests: only the CI role may change this file (.github/CODEOWNERS, CONTRIBUTING.md).
 */

const DOCUMENT_ID = "doc-1";
/** The longest answer window (RSY-20): 5 min, as the specification states it. */
const ANSWER_WINDOW_MS = 300_000;
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
      await vi.advanceTimersByTimeAsync(REPORT_AFTER_MS); // alice's report after her decision (SND-11)
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

describe("resync answers: the creator's to anyone, a member's only to one's own request (RSY-6, RSY-12)", () => {
  // Two tests here switch to fake timers in their body; a failing one must not leave them on for the next.
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the person's request asks all: the creator answers at once, a peer that also holds the content hears that answer before its turn and stays silent through the longest answer window, and the creator's single answer heals the requester (RSY-20, RSY-21)", async () => {
    // On the scheduler's clock: a member that may answer at all answers at its turn, up to
    // ANSWER_WINDOW_MS after the request (RSY-20), so silence is shown only past that.
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
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
    // Answers only: alice's report after her edit goes meanwhile, and asks nothing (SND-11).
    const answers = async () =>
      (await messenger.receive(DOCUMENT_ID, "alice")).filter(
        (delivery) => decodeFrame(delivery.payload).kind === "resync-response",
      ).length;
    const answersBefore = await answers();

    await alice.sync(); // the creator answers at once (RSY-6)
    await vi.advanceTimersByTimeAsync(0);
    // Carol holds what bob lacks and may answer a request to all at her turn; the creator's answer,
    // heard before it, holds what she would give (RSY-20).
    for (let waited = 0; waited <= ANSWER_WINDOW_MS + 10_000; waited += 10_000) {
      await carol.sync();
      await vi.advanceTimersByTimeAsync(10_000);
    }
    await bob.sync();

    expect(getPlainText(bob.fragment)).toBe("shared more");
    expect((await answers()) - answersBefore).toBe(1);
    vi.useRealTimers();
  });

  it("a non-creator does not answer a joiner's first request, which does not ask all (RSY-21), through the longest answer window, so there is nothing to attempt and nothing to surface on its pane", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
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
    // never syncs again, and carol, not being the creator, does not answer a request that does
    // not ask all.
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, ADMIN_ALICE);
    // Carol's own: alice's report after her edit goes meanwhile (SND-11).
    const carols = async () =>
      (await messenger.inner.receive(DOCUMENT_ID, "carol")).filter(
        (delivery) => delivery.sender === "carol",
      ).length;
    const before = await carols();
    for (let waited = 0; waited <= ANSWER_WINDOW_MS + 10_000; waited += 10_000) {
      await carol.sync();
      await vi.advanceTimersByTimeAsync(10_000);
    }

    expect(carolOnError).not.toHaveBeenCalled();
    expect(await carols()).toBe(before);
    expect(getPlainText(bob.fragment)).toBe(""); // and, honestly, bob stays empty for now
    vi.useRealTimers();
  });

  it("a member's answer to another's request to all, for which this engine let a request of its own go, is applied: what it lacked arrives; one to another's request it did not take up is not (RSY-12, RSY-22)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const messenger = new InMemoryMessengerPort();
    const AS_ALICE = { ...IMMEDIATE, creatorMemberId: "alice", resyncResponseThrottleMs: 0 };
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, AS_ALICE);
    await alice.setMembership("bob", "write");
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, AS_ALICE);
    await alice.sync();
    await bob.sync();
    // Alice's first edit reaches nobody, her second builds on it: Bob holds a gap of her stream.
    messenger.dropNextSend("alice");
    alice.edit((fragment) => insertPlainText(fragment, 0, "1"));
    await vi.advanceTimersByTimeAsync(0);
    alice.edit((fragment) => insertPlainText(fragment, 0, "2"));
    await vi.advanceTimersByTimeAsync(0);
    const whole = encodeUpdate(alice.document);
    alice.dispose();
    await bob.sync();
    expect(getPlainText(bob.fragment)).toBe("");
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
    await vi.advanceTimersByTimeAsync(11_000);
    await bob.sync();
    await vi.advanceTimersByTimeAsync(0);
    const answer = (respondsTo: string) =>
      encodeResyncResponseFrame({
        documentId: DOCUMENT_ID,
        respondsTo,
        update: whole,
        control: null,
      });
    // Dave's answer to a request Bob did not take up pushes nothing at him.
    await messenger.send(DOCUMENT_ID, "dave", answer("c2c2c2c2c2c2c2c2"));
    await bob.sync();
    expect(getPlainText(bob.fragment)).toBe("");
    await messenger.send(DOCUMENT_ID, "dave", answer(taken));
    await bob.sync();
    expect(getPlainText(bob.fragment)).toBe("21");
    expect(bob.hasCompletedBootstrap).toBe(true);
    vi.useRealTimers();
  });

  it("a joiner merges a non-creator's answer to its own request as any snapshot: it bootstraps it, and its overlay is the first that stands; the creator's answer changes no overlay (RSY-12, RSY-13, RSY-15, CTL-25)", async () => {
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
        // The creator's snapshot, which an answer that bootstraps carries (CTL-13), as carol holds it.
        control: alice.controlState,
        attribution: {
          ranges: [{ start: 0, end: 7, authorId: author }],
          lastEditBySender: { [author]: 7 },
        },
      });

    await messenger.inner.send(DOCUMENT_ID, "carol", frameFrom("carol"));
    await bob.sync();
    // Carol answered bob's own request: its content applies, as anyone's edit could (CTL-7), its
    // snapshot is merged (CTL-25), and it bootstraps bob (RSY-14). Its overlay is the first bob
    // adopts (RSY-15).
    expect(getPlainText(bob.fragment)).toBe("content");
    expect(bob.hasCompletedBootstrap).toBe(true);
    expect(bob.controlStanding).toStrictEqual({ kind: "bootstrapped" });
    expect(bob.controlState.targets).toStrictEqual(alice.controlState.targets);
    expect(bob.attribution.ranges[0]?.authorId).toBe("carol");

    await messenger.inner.send(DOCUMENT_ID, "alice", frameFrom("alice"));
    await bob.sync();
    expect(getPlainText(bob.fragment)).toBe("content");
    expect(bob.controlStanding).toStrictEqual({ kind: "bootstrapped" });
    // The first overlay adopted stands (RSY-15).
    expect(bob.attribution.ranges[0]?.authorId).toBe("carol");
  });

  it("a member's answer nobody asked for applies nothing, at a member as at the creator", async () => {
    const messenger = new NoHistoryMessengerPort();
    const alice = await DocumentEngine.create(
      DOCUMENT_ID,
      "alice",
      messenger,
      undefined,
      ADMIN_ALICE,
    );
    await alice.sync();
    alice.edit((fragment) => insertPlainText(fragment, 0, "content"));
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, ADMIN_ALICE);
    await alice.sync();
    await bob.sync();
    expect(bob.hasCompletedBootstrap).toBe(true);
    const carolDoc = createDocument();
    transact(carolDoc, () => insertPlainText(getFragment(carolDoc), 0, "pushed at bob"));

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
    await bob.sync();

    expect(getPlainText(bob.fragment)).toBe("content");
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
        control: { profile: "com.example.markdown/1", closed: false, targets: {} },
      }),
    );
    await carol.sync();
    expect(getPlainText(carol.fragment)).toBe("");
    expect(carol.hasCompletedBootstrap).toBe(false);
    expect(errors.map((e) => (e instanceof FrameDecodeError ? e.reason : String(e)))).toStrictEqual(
      ["profile-mismatch"],
    );
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

  const TAG = "Q0FGRS1jcmVhdG9yLTAwMQ";
  const T = 1_793_008_800_000;
  const carolsRegister = { value: "write", clock: [T, 0], device: TAG };
  const VALID_SNAPSHOT = {
    profile: "yjs-paragraphs/1",
    closed: false,
    targets: {
      "member:carol": carolsRegister,
      pace: { value: 30_000, clock: [T, 1], device: TAG },
    },
  };

  it("a valid snapshot is applied with its content — the control case for the rejections below", async () => {
    const { carol, errors } = await answerCarolWith(VALID_SNAPSHOT);
    expect(errors).toStrictEqual([]);
    expect(getPlainText(carol.fragment)).toBe("the creator's text");
    expect(carol.permissionOf("carol")).toBe("write");
  });

  it.each<[string, Record<string, unknown>, unknown]>([
    ["a 1.x field", { ...VALID_SNAPSHOT, sequence: 4 }, null],
    [
      "a field this draft does not define, `confirmed`",
      { ...VALID_SNAPSHOT, confirmed: true },
      null,
    ],
    ["no closed", { ...VALID_SNAPSHOT, closed: undefined }, null],
    [
      "a register whose device is not a device tag",
      { ...VALID_SNAPSHOT, targets: { "member:carol": { ...carolsRegister, device: "carol" } } },
      null,
    ],
    [
      "a register whose clock is not two integers in their ranges",
      { ...VALID_SNAPSHOT, targets: { "member:carol": { ...carolsRegister, clock: [T, 65_536] } } },
      null,
    ],
    [
      "a register with a field it does not define",
      { ...VALID_SNAPSHOT, targets: { "member:carol": { ...carolsRegister, counter: 1 } } },
      null,
    ],
    ["an unknown target", { ...VALID_SNAPSHOT, targets: { policy: carolsRegister } }, null],
    ["the close as a target", { ...VALID_SNAPSHOT, targets: { close: carolsRegister } }, null],
    [
      "an unknown permission",
      { ...VALID_SNAPSHOT, targets: { "member:carol": { ...carolsRegister, value: "admin" } } },
      null,
    ],
    [
      "a pace that is not a number",
      { ...VALID_SNAPSHOT, targets: { pace: { ...carolsRegister, value: "fast" } } },
      null,
    ],
    [
      "the creator as a target",
      { ...VALID_SNAPSHOT, targets: { "member:alice": carolsRegister } },
      null,
    ],
    [
      "the creator as a target on a layer",
      {
        ...VALID_SNAPSHOT,
        targets: { "layer:com.example.comments/1:member:alice": carolsRegister },
      },
      null,
    ],
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
    },
  );
});

describe("a piece is a frame of its own, refused for another document (FRM-7, FRM-8)", () => {
  /** The first of several pieces of a change that inserts `text` (§9.4). */
  function aPieceOf(text: string): Uint8Array {
    const doc = createDocument();
    transact(doc, () => insertPlainText(getFragment(doc), 0, text));
    const pieces = splitUpdate(encodeUpdate(doc), 64);
    expect(pieces.length).toBeGreaterThan(1);
    return pieces[0] as Uint8Array;
  }

  const mismatches = (errors: readonly unknown[]) =>
    errors.filter(
      (error) => error instanceof FrameDecodeError && error.reason === "document-mismatch",
    ) as FrameDecodeError[];

  it("an edit's piece that names another document applies nothing, and is reported with its sender", async () => {
    const errors: unknown[] = [];
    const port = new CountingPort();
    const { bob } = await pair(port, {}, {}, (error) => errors.push(error));
    const text = "smuggled into the wrong document, ".repeat(4);
    await port.inner.send(
      DOCUMENT_ID,
      "alice",
      encodeEditFrame("some-other-document", aPieceOf(text)),
    );
    await bob.sync();
    expect(getPlainText(bob.fragment)).toBe("");
    expect(mismatches(errors).map((error) => error.sender)).toStrictEqual(["alice"]);
  });

  it("an answer's piece that names another document applies nothing, and is reported with its sender", async () => {
    const errors: unknown[] = [];
    const port = new CountingPort();
    const { bob } = await pair(port, {}, {}, (error) => errors.push(error));
    const text = "smuggled into the wrong document, ".repeat(4);
    await port.inner.send(
      DOCUMENT_ID,
      "alice",
      encodeResyncResponseFrame({
        documentId: "some-other-document",
        respondsTo: "00000000000000ff",
        update: aPieceOf(text),
        piece: 1, // not the last: no state, and more to come
      }),
    );
    await bob.sync();
    expect(getPlainText(bob.fragment)).toBe("");
    expect(mismatches(errors).map((error) => error.sender)).toStrictEqual(["alice"]);
  });
});

// Minutes simulated under fake timers for several devices: CPU-bound, slow only on a loaded machine.
describe("an answer that does not bootstrap a new device costs it at most one request: its bootstrap goes on, and the next request asks all (RSY-21, RSY-14)", {
  timeout: 60_000,
}, () => {
  onTheSchedulersClock();
  const AS_ALICE = { ...IMMEDIATE, resyncResponseThrottleMs: 0, creatorMemberId: "alice" };

  /** Alice lets Carol and Gina write and goes away; Carol, bootstrapped, stays online. */
  async function creatorOffline() {
    const port = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
    await alice.setMembership("carol", "write");
    await alice.setMembership("gina", "write");
    alice.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
    const carol = await DocumentEngine.join(DOCUMENT_ID, "carol", port, undefined, AS_ALICE);
    for (let round = 0; round < 4; round++) {
      for (const engine of [alice, carol]) {
        await engine.sync();
        await vi.advanceTimersByTimeAsync(0);
      }
    }
    expect(carol.hasCompletedBootstrap).toBe(true);
    alice.dispose();
    port.disconnect("alice");
    return { port, carol };
  }

  /** Gina's requests, in order. */
  async function ginasRequests(port: InMemoryMessengerPort) {
    return (await port.receive(DOCUMENT_ID, "observer"))
      .filter((delivery) => delivery.sender === "gina")
      .map((delivery) => decodeFrame(delivery.payload))
      .filter((frame) => frame.kind === "resync-request");
  }

  /** Dave answers Gina's first request at once, with `control` as his device writes it. */
  async function ginaAnsweredFirstBy(control: Record<string, unknown> | null) {
    const { port, carol } = await creatorOffline();
    const gina = await DocumentEngine.join(DOCUMENT_ID, "gina", port, undefined, AS_ALICE);
    await vi.advanceTimersByTimeAsync(0);
    const [first] = await ginasRequests(port);
    if (first?.kind !== "resync-request") throw new Error("no request of gina");
    expect(first.all).toBe(false);
    const answer = encodeResyncResponseFrame({
      documentId: DOCUMENT_ID,
      respondsTo: first.requestId,
      update: new Uint8Array([0, 0]),
      control: null,
    });
    await port.send(
      DOCUMENT_ID,
      "dave",
      control === null
        ? answer
        : JSON.stringify({ ...(JSON.parse(answer) as Record<string, unknown>), control }),
    );
    for (let passed = 0; passed < 5 * 60_000; passed += 1_000) {
      await vi.advanceTimersByTimeAsync(1_000);
      for (const engine of [carol, gina]) {
        await engine.sync();
        await vi.advanceTimersByTimeAsync(0);
      }
    }
    return {
      gina,
      requests: (await ginasRequests(port)).map(
        (frame) => frame.kind === "resync-request" && frame.all,
      ),
    };
  }

  it("an answer it accepts without control state — content alone — does not bootstrap it, so its next request asks all, and a member's answer to that bootstraps it", async () => {
    const { gina, requests } = await ginaAnsweredFirstBy(null);
    expect(requests.slice(0, 2)).toStrictEqual([false, true]);
    expect(gina.hasCompletedBootstrap).toBe(true);
    expect(gina.controlStanding.kind).toBe("bootstrapped");
    expect(getPlainText(gina.fragment)).toBe("Plan");
  });

  it("an answer it rejects leaves its request unanswered: the next one asks all, and a member's answer to that bootstraps it", async () => {
    const { gina, requests } = await ginaAnsweredFirstBy({
      profile: "com.example.other/1",
      closed: false,
      targets: {},
    });
    expect(requests.slice(0, 2)).toStrictEqual([false, true]);
    expect(gina.hasCompletedBootstrap).toBe(true);
    expect(getPlainText(gina.fragment)).toBe("Plan");
  });
});

describe("an answer to someone else bootstraps nobody, and a device not complete hands on no control state (RSY-12, RSY-14, CTL-25, RSY-8)", () => {
  onTheSchedulersClock();
  const AS_ALICE = { ...IMMEDIATE, resyncResponseThrottleMs: 0, creatorMemberId: "alice" };

  /** The in-memory transport, which can hide from one member what was sent so far, but for what `keep` names. */
  class HidingPort implements MessengerPort {
    readonly inner = new InMemoryMessengerPort();
    readonly #hidden = new Map<MemberId, Set<string>>();

    async hideFrom(
      member: MemberId,
      keep: (payload: string) => boolean = () => false,
    ): Promise<void> {
      const hidden = this.#hidden.get(member) ?? new Set<string>();
      for (const delivery of await this.inner.receive(DOCUMENT_ID, member)) {
        if (!keep(delivery.payload)) hidden.add(delivery.id);
      }
      this.#hidden.set(member, hidden);
    }
    createDocument(documentId: DocumentId, creator: MemberId): Promise<void> {
      return this.inner.createDocument(documentId, creator);
    }
    send(documentId: DocumentId, sender: MemberId, payload: string): Promise<string> {
      return this.inner.send(documentId, sender, payload);
    }
    listChannels(member: MemberId): Promise<readonly RawChannel[]> {
      return this.inner.listChannels(member);
    }
    async receive(documentId: DocumentId, member: MemberId): Promise<readonly Delivery[]> {
      const hidden = this.#hidden.get(member);
      const all = await this.inner.receive(documentId, member);
      return hidden === undefined ? all : all.filter((delivery) => !hidden.has(delivery.id));
    }
    /** With a cursor (TRN-18), as a member's restored state needs to bootstrap it (CTL-41). */
    async receiveSince(documentId: DocumentId, member: MemberId, after: string | undefined) {
      const visible = await this.receive(documentId, member);
      const at = after === undefined ? -1 : visible.findIndex((delivery) => delivery.id === after);
      if (after === undefined) return { deliveries: visible, truncated: false };
      return at === -1
        ? { deliveries: visible, truncated: true }
        : { deliveries: visible.slice(at + 1), truncated: false };
    }
  }

  async function run(ms: number, engines: DocumentEngine[]): Promise<void> {
    for (let passed = 0; passed < ms; passed += 1_000) {
      await vi.advanceTimersByTimeAsync(1_000);
      for (const engine of engines) {
        await engine.sync();
        await vi.advanceTimersByTimeAsync(0);
      }
    }
  }

  /** The answers on the channel, with their senders and whom they answer. */
  async function answers(port: HidingPort) {
    return (await port.inner.receive(DOCUMENT_ID, "observer")).flatMap((delivery) => {
      const frame = decodeFrame(delivery.payload);
      return frame.kind === "resync-response"
        ? [{ sender: delivery.sender, frame, payload: delivery.payload }]
        : [];
    });
  }

  /** Alice creates "Plan" and lets Bob and Carol write; Bob is bootstrapped by her, and she goes away. */
  async function aliceAway(port: HidingPort) {
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
    await alice.setMembership("bob", "write");
    await alice.setMembership("carol", "write");
    alice.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, AS_ALICE);
    await run(5_000, [alice, bob]);
    expect(bob.hasCompletedBootstrap).toBe(true);
    alice.dispose();
    return bob;
  }

  it("a member's snapshot with content, answering another member's request, does not bootstrap a new device of the creator", async () => {
    const port = new HidingPort();
    const bob = await aliceAway(port);
    const carol = await DocumentEngine.join(DOCUMENT_ID, "carol", port, undefined, AS_ALICE);
    await run(3 * 60_000, [bob, carol]);
    const toCarol = (await answers(port)).filter(({ sender }) => sender === "bob");
    expect(toCarol.length).toBe(1);
    expect(toCarol[0]?.frame.kind === "resync-response" && toCarol[0].frame.control !== null).toBe(
      true,
    );
    // A new device of Alice's reads that answer alone, with the content of the document in it.
    await port.hideFrom("alice", (payload) => payload === toCarol[0]?.payload);
    const newDevice = await DocumentEngine.join(DOCUMENT_ID, "alice", port, undefined, {
      ...AS_ALICE,
      autoResync: false,
    });
    expect(newDevice.hasCompletedBootstrap).toBe(false);
    expect(newDevice.controlStanding).toStrictEqual({ kind: "none" });
    expect(newDevice.permissionOf("bob")).toBeUndefined();
    expect(getPlainText(newDevice.fragment)).toBe("");
  });

  it("a member's new device: another member's snapshot to someone else does not bootstrap it, nor does its own other device's", async () => {
    const port = new HidingPort();
    const bob = await aliceAway(port);
    bob.dispose();
    const plan = createDocument();
    transact(plan, () => insertPlainText(getFragment(plan), 0, "Plan, as they say"));
    const answer = (sender: MemberId) =>
      port.send(
        DOCUMENT_ID,
        sender,
        encodeResyncResponseFrame({
          documentId: DOCUMENT_ID,
          respondsTo: "00000000000c0ffe",
          update: encodeUpdate(plan),
          control: { profile: "yjs-paragraphs/1", closed: false, targets: {} },
          state: {
            stateVector: encodeStateVector(plan),
            stateDigest: digestOf(encodeDeletions(plan)),
          },
        }),
      );
    await port.hideFrom("bob");
    await answer("carol");
    await answer("bob");
    const laptop = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, {
      ...AS_ALICE,
      autoResync: false,
    });
    expect(laptop.hasCompletedBootstrap).toBe(false);
    expect(laptop.controlStanding).toStrictEqual({ kind: "none" });
    expect(laptop.mayEdit).toBe(false);
    expect(getPlainText(laptop.fragment)).toBe("");
  });

  it("a member's new device holding evidence of a truncated history is not bootstrapped by its other device's answer: what the transport dropped may be a later decision of the creator (CTL-41, LOS-19)", async () => {
    const port = new HidingPort();
    const bob = await aliceAway(port);
    const carol = await DocumentEngine.join(DOCUMENT_ID, "carol", port, undefined, AS_ALICE);
    await run(3 * 60_000, [bob, carol]);
    const toCarol = (await answers(port)).filter(({ sender }) => sender === "bob");
    expect(toCarol.length).toBe(1);
    bob.dispose();
    // Its content restored with a cursor its transport no longer holds: a truncated history (LOS-9).
    const laptop = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, {
      ...AS_ALICE,
      autoResync: false,
      restore: { state: encodeUpdate(carol.document), cursor: "gone" },
    });
    expect(laptop.syncHealth.suspicions.map((suspicion) => suspicion.kind)).toContain(
      "history-truncated",
    );
    expect(laptop.hasCompletedBootstrap).toBe(false);
    expect(laptop.mayEdit).toBe(false);
  });

  it("a member's device in a capacity conflict answers a device of the creator without control state: the device is not bootstrapped by it, and its own other device takes nothing of that answer (CTL-32, RSY-8, RSY-14)", async () => {
    const port = new HidingPort();
    let control: PersistedControlState | undefined;
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
    await alice.setMembership("bob", "write");
    alice.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
    const before = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, {
      ...AS_ALICE,
      onControlStateChange: (state) => {
        control = state;
      },
    });
    await run(5_000, [alice, before]);
    const restore = { state: encodeUpdate(before.document), cursor: before.cursor };
    before.dispose();
    alice.dispose();
    // Bob's device restarts in a capacity conflict it persisted (CTL-32), bootstrapped by its read on (CTL-41).
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, {
      ...AS_ALICE,
      controlState: { ...(control as PersistedControlState), capacityConflict: true },
      restore,
    });
    expect(bob.hasCompletedBootstrap).toBe(true);
    expect(bob.capacityConflict).toBe(true);
    await port.hideFrom("alice");
    const newDevice = await DocumentEngine.join(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
    await run(3 * 60_000, [bob, newDevice]);
    const report = (await answers(port)).filter(({ sender }) => sender === "bob").at(-1);
    // It answers with the content, but hands on no control state, to anyone (CTL-32, RSY-8): a state
    // it knows lacks something, merged and taken as complete, would bootstrap that device without it.
    expect(report?.frame.kind).toBe("resync-response");
    expect(report?.frame.kind === "resync-response" && report.frame.control).toBeNull();
    expect(newDevice.controlStanding).toStrictEqual({ kind: "none" });
    expect(newDevice.permissionOf("bob")).toBeUndefined();
    bob.dispose();
    await port.hideFrom("bob", (payload) => payload === report?.payload);
    const laptop = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, {
      ...AS_ALICE,
      autoResync: false,
    });
    expect(laptop.hasCompletedBootstrap).toBe(false);
    expect(getPlainText(laptop.fragment)).toBe("");
  });
});
