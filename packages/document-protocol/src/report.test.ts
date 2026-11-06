import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import {
  type Delivery,
  type DeliveryId,
  type DocumentId,
  type MemberId,
  type MessengerPort,
  type TransportProfile,
  TransportSendError,
} from "@tdsp/messenger-port";
import {
  applyUpdate,
  createDocument,
  deletePlainText,
  encodeStateVector,
  encodeUpdate,
  getFragment,
  getPlainText,
  insertPlainText,
} from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeFrame,
  encodeHeartbeatFrame,
  encodeResyncResponseFrame,
  type Frame,
  FrameDecodeError,
  frameByteLength,
  type HeartbeatFrame,
} from "./framing";
import {
  DocumentEngine,
  type DocumentEngineOptions,
  MIN_MESSAGE_BYTES,
  type OwedReport,
  REPORT_AFTER_MS,
} from "./index";

/**
 * The report (SPECIFICATION.md §9.3, SND-11, SND-12, SND-13, SND-27, SND-28, CTL-7, LIF-6): a
 * `heartbeat` 10 s after the last edit or control frame of a sender's own, carrying its last edit
 * again, byte for byte as it went out. A lost final change heals by it without a request, also when
 * its sender goes offline at once; it carries only what went out; a receiver applies what it carries
 * as an edit's, whatever the sender's permission there and after a close, and judges the report after
 * it; a device of the creator sends its last control frame again first; an owed report is observable,
 * persisted and sent at once from a restored one; and reading costs none.
 */

const DOC = "doc-1";
const OPTS = { batchWindowMs: 0, resyncResponseThrottleMs: 0, creatorMemberId: "alice" };
/** 2026-10-26 10:00:00 UTC. */
const T = 1_793_008_800_000;

/** The in-memory transport, where a chosen message can be lost on its way to one member. */
class Port implements MessengerPort {
  readonly inner = new InMemoryMessengerPort();
  readonly #hidden = new Map<MemberId, Set<DeliveryId>>();
  readonly #losses: {
    member: MemberId;
    kind: Frame["kind"] | undefined;
    sender: MemberId | undefined;
  }[] = [];
  #failures: unknown[] = [];
  #profile: TransportProfile | undefined;

  /** The next message `sender` (or anyone) sends of `kind` (or any) never reaches `member`. */
  loseNext(member: MemberId, kind?: Frame["kind"], sender?: MemberId): void {
    this.#losses.push({ member, kind, sender });
  }
  /** The next sends fail with these errors, in order, whoever sends. */
  failNext(...errors: unknown[]): void {
    this.#failures.push(...errors);
  }
  /** A transport that carries at most `maxBytes` a message (SND-17). */
  limitTo(maxBytes: number): void {
    this.#profile = {
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
    return this.#profile;
  }
  createDocument(documentId: DocumentId, creator: MemberId): Promise<void> {
    return this.inner.createDocument(documentId, creator);
  }
  async send(documentId: DocumentId, sender: MemberId, payload: string): Promise<DeliveryId> {
    const failure = this.#failures.shift();
    if (failure !== undefined) {
      throw failure;
    }
    const limit = this.#profile?.bounds.maxBytes;
    if (limit !== undefined && limit !== null && payload.length > limit) {
      throw new TransportSendError("too-large", `${payload.length} bytes, over ${limit}`);
    }
    const id = await this.inner.send(documentId, sender, payload);
    const kind = decodeFrame(payload).kind;
    const at = this.#losses.findIndex(
      (loss) =>
        (loss.kind ?? kind) === kind &&
        (loss.sender ?? sender) === sender &&
        loss.member !== sender,
    );
    if (at !== -1) {
      const [loss] = this.#losses.splice(at, 1);
      const hidden = this.#hidden.get(loss?.member as MemberId) ?? new Set();
      hidden.add(id);
      this.#hidden.set(loss?.member as MemberId, hidden);
    }
    return id;
  }
  async receive(documentId: DocumentId, member: MemberId): Promise<readonly Delivery[]> {
    const hidden = this.#hidden.get(member);
    const all = await this.inner.receive(documentId, member);
    return hidden === undefined ? all : all.filter((delivery) => !hidden.has(delivery.id));
  }
  listChannels(member: MemberId) {
    return this.inner.listChannels(member);
  }
}

/** Every frame on the channel, with its sender, in the order sent. */
async function channel(port: Port): Promise<{ sender: MemberId; frame: Frame; payload: string }[]> {
  return (await port.inner.receive(DOC, "observer")).map((delivery) => ({
    sender: delivery.sender,
    frame: decodeFrame(delivery.payload),
    payload: delivery.payload,
  }));
}

/** The reports `sender` sent, in order. */
async function reportsOf(port: Port, sender: MemberId): Promise<HeartbeatFrame[]> {
  return (await channel(port))
    .filter(({ sender: from, frame }) => from === sender && frame.kind === "heartbeat")
    .map(({ frame }) => frame as HeartbeatFrame);
}

/** The update of the last edit `sender` sent. */
async function lastEditOf(port: Port, sender: MemberId): Promise<Uint8Array | undefined> {
  const edits = (await channel(port)).filter(
    ({ sender: from, frame }) => from === sender && frame.kind === "edit",
  );
  const last = edits.at(-1)?.frame;
  return last?.kind === "edit" ? last.update : undefined;
}

async function requestsOf(port: Port, sender: MemberId): Promise<number> {
  return (await channel(port)).filter(
    ({ sender: from, frame }) => from === sender && frame.kind === "resync-request",
  ).length;
}

async function poll(...engines: DocumentEngine[]): Promise<void> {
  for (const engine of engines) {
    await engine.sync();
    await vi.advanceTimersByTimeAsync(0);
  }
}

async function run(ms: number, engines: DocumentEngine[], step = 1_000): Promise<void> {
  for (let passed = 0; passed < ms; passed += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - passed));
    await poll(...engines);
  }
}

/** Alice creates "Plan" and makes Bob and Carol writers; everything has settled, every report gone. */
async function group(port = new Port(), options: DocumentEngineOptions = {}) {
  const alice = await DocumentEngine.create(DOC, "alice", port, undefined, { ...OPTS, ...options });
  await alice.setMembership("bob", "write");
  await alice.setMembership("carol", "write");
  alice.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
  const bob = await DocumentEngine.join(DOC, "bob", port, undefined, { ...OPTS, ...options });
  const carol = await DocumentEngine.join(DOC, "carol", port, undefined, { ...OPTS, ...options });
  await run(60_000, [alice, bob, carol]);
  for (const engine of [alice, bob, carol]) expect(getPlainText(engine.fragment)).toBe("Plan");
  return { port, alice, bob, carol };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a lost last change heals by the report (SND-11, SND-27)", () => {
  it("about 10 s later, with no request, also when its sender goes offline at once after it", async () => {
    const { port, alice, bob, carol } = await group();
    const asked = await requestsOf(port, "alice");
    port.loseNext("alice", "edit", "bob");
    bob.edit((fragment) => insertPlainText(fragment, 4, "!"));
    await run(REPORT_AFTER_MS - 1_000, [alice, bob, carol]);
    expect(getPlainText(alice.fragment)).toBe("Plan");
    await vi.advanceTimersByTimeAsync(1_000); // Bob's report goes out
    port.inner.disconnect("bob"); // and Bob is gone at once
    await run(60_000, [alice, carol]);
    expect(getPlainText(alice.fragment)).toBe("Plan!");
    expect(alice.syncHealth.suspicions).toStrictEqual([]);
    expect(await requestsOf(port, "alice")).toBe(asked);
    const [report] = await reportsOf(port, "bob");
    expect(report?.update).toStrictEqual(await lastEditOf(port, "bob"));
  });

  it("at once, when its sender closes the document right after it (SND-11, LIF-12)", async () => {
    const { port, alice, bob, carol } = await group();
    port.loseNext("alice", "edit", "bob");
    bob.edit((fragment) => insertPlainText(fragment, 4, "!"));
    await vi.advanceTimersByTimeAsync(0);
    bob.dispose(); // the close: the report it owes goes now
    await vi.advanceTimersByTimeAsync(0);
    expect(await reportsOf(port, "bob")).toHaveLength(1);
    await poll(alice, carol);
    expect(getPlainText(alice.fragment)).toBe("Plan!");
  });

  it("at once before the device sleeps: reportNow resolves once it went, within the floor (LIF-12)", async () => {
    const { port, alice } = await group();
    // A device of Bob's on a transport with a floor of 2 s.
    const bob = await DocumentEngine.join(DOC, "bob", port, undefined, {
      ...OPTS,
      syncPolicy: { minIntervalMs: 2_000 },
    });
    await run(30_000, [alice, bob]);
    port.loseNext("alice", "edit", "bob");
    bob.edit((fragment) => insertPlainText(fragment, 4, "!"));
    await vi.advanceTimersByTimeAsync(0); // the edit goes out
    let reported = false;
    const done = bob.reportNow().then(() => {
      reported = true;
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(reported).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(reported).toBe(true);
    expect(await reportsOf(port, "bob")).toHaveLength(1); // not 10 s later
    await poll(alice);
    expect(getPlainText(alice.fragment)).toBe("Plan!");
    await bob.reportNow(); // none owed now: at once
  });

  it("a deletion too, judged after it: no evidence of a lost deletion, nor later by one of its own (SND-27, LOS-12)", async () => {
    const { port, alice, bob, carol } = await group();
    port.loseNext("alice", "edit", "bob");
    bob.edit((fragment) => deletePlainText(fragment, 0, 1));
    await run(REPORT_AFTER_MS + 30_000, [alice, bob, carol]);
    expect(getPlainText(alice.fragment)).toBe("lan");
    expect(alice.syncHealth.suspicions).toStrictEqual([]);
    // What Alice deletes herself afterwards is no lost deletion of Bob's: she held what his report
    // stated when she first compared it (LOS-18).
    alice.edit((fragment) => deletePlainText(fragment, 2, 1));
    await run(2 * 60_000, [alice]);
    expect(getPlainText(alice.fragment)).toBe("la");
    expect(alice.syncHealth.suspicions).toStrictEqual([]);
  });
});

describe("what a report carries again (SND-27)", () => {
  it("only what went out: after an edit the engine refused it carries the last edit that went out", async () => {
    const { port, alice, bob, carol } = await group();
    bob.edit((fragment) => insertPlainText(fragment, 4, " a"));
    await vi.advanceTimersByTimeAsync(0);
    const sent = await lastEditOf(port, "bob");
    // Read-only, Bob's next edit is refused at his own engine (CTL-13), and goes to no one.
    await alice.setMembership("bob", "read");
    await poll(bob);
    bob.edit((fragment) => insertPlainText(fragment, 0, "refused "));
    // And one its profile does not read, refused all the same (SND-26).
    let deep: unknown = 1;
    for (let level = 0; level < 33; level++) deep = { a: deep };
    bob.document.transact(() => bob.document.getMap("com.example.comments/1").set("deep", deep));
    await run(REPORT_AFTER_MS, [alice, bob, carol]);
    expect(await lastEditOf(port, "bob")).toStrictEqual(sent);
    const reports = await reportsOf(port, "bob");
    expect(reports).toHaveLength(1);
    expect(reports[0]?.update).toStrictEqual(sent);
    expect(getPlainText(carol.fragment)).toBe("Plan a");
  });

  it("after the close, the last edit before it", async () => {
    const { port, alice, bob, carol } = await group();
    bob.edit((fragment) => insertPlainText(fragment, 4, " a"));
    await vi.advanceTimersByTimeAsync(0);
    const sent = await lastEditOf(port, "bob");
    await alice.closeDocument();
    await poll(bob);
    bob.edit((fragment) => insertPlainText(fragment, 0, "after "));
    await run(REPORT_AFTER_MS, [alice, bob, carol]);
    const reports = await reportsOf(port, "bob");
    expect(reports).toHaveLength(1);
    expect(reports[0]?.update).toStrictEqual(sent);
  });

  it("nothing after a change sent in pieces (SND-17)", { timeout: 60_000 }, async () => {
    const port = new Port();
    port.limitTo(MIN_MESSAGE_BYTES);
    const { alice, bob, carol } = await group(port);
    // Two pieces on the smallest transport (TRN-23).
    const paste = "x".repeat(MIN_MESSAGE_BYTES);
    bob.edit((fragment) => insertPlainText(fragment, 4, paste));
    await run(REPORT_AFTER_MS + 10_000, [alice, bob, carol]);
    const edits = (await channel(port)).filter(
      ({ sender, frame }) => sender === "bob" && frame.kind === "edit",
    );
    expect(edits.length).toBeGreaterThan(1);
    const reports = await reportsOf(port, "bob");
    expect(reports).toHaveLength(1);
    expect(reports[0]?.update).toBeUndefined();
    expect(getPlainText(carol.fragment)).toBe(`Plan${paste}`);
  });

  it("nothing where the report would exceed the transport's limit with it, though the edit fitted", {
    timeout: 60_000,
  }, async () => {
    const LIMIT = MIN_MESSAGE_BYTES;
    const port = new Port();
    port.limitTo(LIMIT);
    const { alice, bob, carol } = await group(port);
    // An edit that just fits a frame, its update as Base64 at four characters for every three bytes:
    // a report, which carries more beside the same update, would not.
    bob.edit((fragment) => insertPlainText(fragment, 4, "y".repeat((LIMIT / 4) * 3 - 150)));
    await run(REPORT_AFTER_MS, [alice, bob, carol]);
    const edits = (await channel(port)).filter(
      ({ sender, frame }) => sender === "bob" && frame.kind === "edit",
    );
    expect(edits).toHaveLength(1); // one message, within the limit
    const [report] = await reportsOf(port, "bob");
    expect(report).toBeDefined();
    expect(report?.update).toBeUndefined();
    const edit = edits[0]?.frame;
    // With the edit's update it would not have fitted.
    const { kind: _kind, ...fields } = report as HeartbeatFrame;
    expect(
      frameByteLength(
        encodeHeartbeatFrame({
          ...fields,
          update: edit?.kind === "edit" ? edit.update : new Uint8Array(1),
        }),
      ),
    ).toBeGreaterThan(LIMIT);
  });
});

describe("a receiver applies what a report carries as an edit's (SND-27, CTL-7, LIF-6, FRM-6)", () => {
  it("from a sender it holds read: an edit that went out before the revocation reached it", async () => {
    const { port, alice, bob, carol } = await group();
    port.loseNext("carol", "edit", "bob");
    bob.edit((fragment) => insertPlainText(fragment, 4, "!"));
    await vi.advanceTimersByTimeAsync(0);
    await alice.setMembership("bob", "read");
    await poll(carol);
    expect(carol.permissionOf("bob")).toBe("read");
    expect(getPlainText(carol.fragment)).toBe("Plan");
    const asked = await requestsOf(port, "carol");
    await run(REPORT_AFTER_MS, [alice, carol]);
    expect(getPlainText(carol.fragment)).toBe("Plan!"); // as Alice, who took the edit, holds it
    expect(await requestsOf(port, "carol")).toBe(asked); // by the report, not by an answer
    await run(30_000, [alice, carol]);
    expect(getPlainText(alice.fragment)).toBe("Plan!");
    expect(carol.syncHealth.suspicions).toStrictEqual([]);
  });

  it("after the close, as an edit sent before it", async () => {
    const { port, alice, bob, carol } = await group();
    port.loseNext("carol", "edit", "bob");
    bob.edit((fragment) => insertPlainText(fragment, 4, "!"));
    await vi.advanceTimersByTimeAsync(0);
    await alice.closeDocument();
    await poll(carol);
    expect(carol.closed).toBe(true);
    const asked = await requestsOf(port, "carol");
    await run(REPORT_AFTER_MS, [alice, carol]);
    expect(getPlainText(carol.fragment)).toBe("Plan!");
    expect(await requestsOf(port, "carol")).toBe(asked); // by the report, not by an answer
  });

  it("credited to its sender, as an edit is (ATR-2)", async () => {
    const { port, alice, bob, carol } = await group();
    port.loseNext("carol", "edit", "bob");
    bob.edit((fragment) => insertPlainText(fragment, 4, "!"));
    await run(REPORT_AFTER_MS + 2_000, [alice, bob, carol]);
    expect(getPlainText(carol.fragment)).toBe("Plan!");
    expect(carol.attribution.ranges.map((range) => range.authorId)).toContain("bob");
  });

  it("a report whose update is not one update of the profile is rejected whole as invalid-field", async () => {
    const { port, carol } = await group();
    const errors: unknown[] = [];
    const watcher = await DocumentEngine.join(
      DOC,
      "dave",
      port,
      (error) => errors.push(error),
      OPTS,
    );
    await run(30_000, [watcher]);
    const before = getPlainText(watcher.fragment);
    // A state ahead of what Dave holds: kept as a report, it would show him a gap (LOS-4).
    const ahead = createDocument();
    applyUpdate(ahead, encodeUpdate(carol.document));
    insertPlainText(getFragment(ahead), 0, "z");
    await port.send(
      DOC,
      "carol",
      encodeHeartbeatFrame({
        documentId: DOC,
        controlClock: null,
        controlDigest: null,
        stateVector: encodeStateVector(ahead),
        stateDigest: "96a296d224f285c6",
        stream: "5eed5eed5eed5eed",
        sequence: 1,
        update: new Uint8Array([0xff, 0xff, 0xff]),
      }),
    );
    await run(60_000, [watcher]);
    expect(
      errors.filter(
        (error) => error instanceof FrameDecodeError && error.reason === "invalid-field",
      ),
    ).toHaveLength(1);
    expect(getPlainText(watcher.fragment)).toBe(before);
    expect(watcher.syncHealth.suspicions).toStrictEqual([]);
  });
});

describe("a device of the creator's last decision goes again before its report (SND-27)", () => {
  it("unchanged, then a report without an update: a member that lost it holds it", async () => {
    const { port, alice, bob } = await group();
    port.loseNext("bob", "control", "alice");
    await alice.setMembership("dave", "write");
    await poll(bob);
    expect(bob.permissionOf("dave")).toBeUndefined();
    const from = (await channel(port)).length - 1;
    await run(REPORT_AFTER_MS, [alice, bob]);
    const after = (await channel(port)).slice(from).filter(({ sender }) => sender === "alice");
    expect(after.map(({ frame }) => frame.kind)).toStrictEqual(["control", "control", "heartbeat"]);
    expect(after[1]?.payload).toBe(after[0]?.payload);
    expect((after[2]?.frame as HeartbeatFrame | undefined)?.update).toBeUndefined();
    expect(bob.permissionOf("dave")).toBe("write");
  });
});

describe("a bootstrapped device of the creator that merged an answer which changed its control state (SND-11)", () => {
  it("reports at once, within the floor, not 10 s later, stating only: its last decision went again with its phase's report alone (SND-27)", async () => {
    const { port, alice, bob } = await group();
    const decisions = async () =>
      (await channel(port)).filter(
        ({ sender, frame }) => sender === "alice" && frame.kind === "control",
      ).length;
    const decided = await decisions();
    await alice.requestResync();
    const request = (await channel(port))
      .filter(({ sender, frame }) => sender === "alice" && frame.kind === "resync-request")
      .at(-1)?.frame;
    const before = (await reportsOf(port, "alice")).length;
    // A member's answer with a register only it held: merged, as any answer is (CTL-25).
    await port.send(
      DOC,
      "bob",
      encodeResyncResponseFrame({
        documentId: DOC,
        respondsTo: request?.kind === "resync-request" ? request.requestId : "",
        update: encodeUpdate(bob.document),
        control: {
          profile: "yjs-paragraphs/1",
          closed: false,
          targets: {
            ...bob.controlState.targets,
            "member:erin": { value: "read", clock: [T + 1, 0], device: "AAAAAAAAAAAAAAAAAAAAAA" },
          },
        },
      }),
    );
    await poll(alice);
    expect(alice.permissionOf("erin")).toBe("read");
    await vi.advanceTimersByTimeAsync(1_000);
    const reports = (await reportsOf(port, "alice")).slice(before);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.controlClock).toStrictEqual(alice.controlClock);
    expect(reports[0]?.update).toBeUndefined();
    expect(await decisions()).toBe(decided);
  });
});

describe("a return (SND-12, RSY-21, LIF-12)", () => {
  it("ends the back-off of the report owed: told it is back after an hour away, a device sends it at once", async () => {
    const { port, alice, bob, carol } = await group();
    port.loseNext("alice", "edit", "bob");
    bob.edit((fragment) => insertPlainText(fragment, 4, "!"));
    await vi.advanceTimersByTimeAsync(0);
    port.inner.disconnect("bob"); // away: the report fails on, and its back-off grows to ten minutes
    await run(60 * 60_000, [alice, carol], 60_000);
    expect(await reportsOf(port, "bob")).toStrictEqual([]);
    port.inner.reconnect("bob");
    bob.noteAbsence(60 * 60_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await reportsOf(port, "bob")).toHaveLength(1);
    await poll(alice);
    expect(getPlainText(alice.fragment)).toBe("Plan!");
  });
});

describe("the whole state sent again (SND-11)", () => {
  it("begins no phase, and no report carries it; the next change of one's own does", async () => {
    const { port, alice, bob, carol } = await group();
    await bob.resync();
    await run(REPORT_AFTER_MS + 30_000, [alice, bob, carol]);
    expect(await reportsOf(port, "bob")).toStrictEqual([]);
    bob.edit((fragment) => insertPlainText(fragment, 4, "!"));
    await run(REPORT_AFTER_MS, [alice, bob, carol]);
    const reports = await reportsOf(port, "bob");
    expect(reports).toHaveLength(1);
    expect(reports[0]?.update).toStrictEqual(await lastEditOf(port, "bob"));
    expect(reports[0]?.update?.length).toBeLessThan(encodeUpdate(bob.document).length);
  });

  it("the seed neither: a document just created owes no report, and the first carries the change typed after it", async () => {
    const port = new Port();
    const alice = await DocumentEngine.create(DOC, "alice", port, undefined, OPTS);
    const [seed] = (await channel(port)).filter(({ frame }) => frame.kind === "edit");
    expect(seed).toBeDefined();
    expect(alice.owedReport).toBeUndefined();
    await run(REPORT_AFTER_MS + 30_000, [alice]);
    expect(await reportsOf(port, "alice")).toStrictEqual([]);
    alice.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
    await run(REPORT_AFTER_MS, [alice]);
    const reports = await reportsOf(port, "alice");
    expect(reports).toHaveLength(1);
    const typed = await lastEditOf(port, "alice");
    expect(reports[0]?.update).toStrictEqual(typed);
    expect(typed).not.toStrictEqual(seed?.frame.kind === "edit" ? seed.frame.update : undefined);
  });
});

describe("an owed report (SND-28)", () => {
  it("is observable with what it carries, and falls only once the transport accepted it", async () => {
    const port = new Port();
    const seen: (OwedReport | undefined)[] = [];
    const { alice } = await group(port);
    // Another device of Bob's, whose application watches what it owes.
    const watched = await DocumentEngine.join(DOC, "bob", port, undefined, {
      ...OPTS,
      onOwedReportChange: (owed) => seen.push(owed),
    });
    await run(30_000, [alice, watched]);
    expect(watched.owedReport).toBeUndefined();
    watched.edit((fragment) => insertPlainText(fragment, 4, "!"));
    await vi.advanceTimersByTimeAsync(0);
    const sent = await lastEditOf(port, "bob");
    expect(watched.owedReport).toStrictEqual({ update: sent });
    expect(watched.sendStatus.reportOwed).toBe(true);
    expect(seen.at(-1)).toStrictEqual({ update: sent });
    port.failNext(new TransportSendError("unavailable", "offline"));
    await run(REPORT_AFTER_MS, [alice, watched]); // refused, and kept (SND-12)
    expect(watched.owedReport).toStrictEqual({ update: sent });
    await run(5_000, [alice, watched]); // the retry after the back-off goes
    expect(watched.owedReport).toBeUndefined();
    expect(watched.sendStatus.reportOwed).toBe(false);
    expect(seen.at(-1)).toBeUndefined();
    expect(await reportsOf(port, "bob")).toHaveLength(1);
  });

  it("is persisted with its update by a device closed before it went, and goes at once from what it restores", async () => {
    const { port, alice, bob, carol } = await group();
    port.loseNext("alice", "edit", "bob");
    port.loseNext("carol", "edit", "bob");
    bob.edit((fragment) => insertPlainText(fragment, 4, "!"));
    await vi.advanceTimersByTimeAsync(0);
    const sent = await lastEditOf(port, "bob");
    // Bob closes offline: the report his close owes cannot go, and stays owed.
    port.inner.disconnect("bob");
    bob.dispose();
    await vi.advanceTimersByTimeAsync(5_000);
    const owed = bob.owedReport;
    expect(owed).toStrictEqual({ update: sent });
    const state = encodeUpdate(bob.document);
    port.inner.reconnect("bob");
    expect(getPlainText(alice.fragment)).toBe("Plan");

    const restarted = await DocumentEngine.join(DOC, "bob", port, undefined, {
      ...OPTS,
      autoResync: false,
      restore: { state, owedReport: owed as OwedReport },
    });
    await vi.advanceTimersByTimeAsync(0);
    const reports = await reportsOf(port, "bob");
    expect(reports).toHaveLength(1);
    expect(reports[0]?.update).toStrictEqual(sent); // under a new stream: it went out before
    expect(restarted.owedReport).toBeUndefined();
    await poll(alice, carol);
    expect(getPlainText(alice.fragment)).toBe("Plan!");
    expect(getPlainText(carol.fragment)).toBe("Plan!");
  });
});

describe("what owes no report (SND-11)", () => {
  it("reading costs none: an engine that only receives sends no report", async () => {
    const { port, alice, bob, carol } = await group();
    const before = await reportsOf(port, "carol");
    for (let minute = 0; minute < 30; minute++) {
      alice.edit((fragment) => insertPlainText(fragment, 0, "a"));
      bob.edit((fragment) => insertPlainText(fragment, 0, "b"));
      await run(60_000, [alice, bob, carol], 10_000);
    }
    expect(await reportsOf(port, "carol")).toStrictEqual(before);
  });

  it("a device of the creator bootstrapped by an answer that states what it holds owes none; one that holds more owes one at once (SND-11)", async () => {
    for (const merged of [false, true]) {
      vi.setSystemTime(T);
      const { port, alice, bob } = await group();
      const second = await DocumentEngine.join(DOC, "alice", port, undefined, {
        ...OPTS,
        autoResync: false,
      });
      const joined = (await channel(port))
        .filter(({ sender, frame }) => sender === "alice" && frame.kind === "resync-request")
        .at(-1)?.frame;
      const stream = joined?.kind === "resync-request" ? joined.stream : "";
      if (merged) {
        // A register only a member's answer brought it: more than the answer below states (CTL-25).
        const request = (await channel(port))
          .filter(({ sender, frame }) => sender === "alice" && frame.kind === "resync-request")
          .at(-1)?.frame;
        await port.send(
          DOC,
          "bob",
          encodeResyncResponseFrame({
            documentId: DOC,
            respondsTo: request?.kind === "resync-request" ? request.requestId : "",
            update: encodeUpdate(bob.document),
            control: {
              profile: "yjs-paragraphs/1",
              closed: false,
              targets: {
                ...bob.controlState.targets,
                "member:erin": {
                  value: "read",
                  clock: [T + 1, 0],
                  device: "AAAAAAAAAAAAAAAAAAAAAA",
                },
              },
            },
          }),
        );
        await poll(second);
        expect(second.permissionOf("erin")).toBe("read");
      }
      const before = (await reportsOf(port, "alice")).length;
      await second.requestResync();
      await poll(alice); // the first device answers
      await poll(second); // and bootstraps the second
      expect(second.controlStanding).toStrictEqual({ kind: "bootstrapped" });
      // The second device's, by its stream (LOS-13): at once, within a second. The first device, which
      // merges what it then learns of Erin, owes a report of its own (SND-11).
      const ofSecond = async () =>
        (await reportsOf(port, "alice")).slice(before).filter((report) => report.stream === stream);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await ofSecond(), merged ? "holds more" : "holds the same").toHaveLength(
        merged ? 1 : 0,
      );
      await run(60_000, [alice, second]);
      expect(await ofSecond(), merged ? "holds more" : "holds the same").toHaveLength(
        merged ? 1 : 0,
      );
      alice.dispose();
      second.dispose();
    }
  });
});
