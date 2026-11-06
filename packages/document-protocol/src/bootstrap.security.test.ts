import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import type {
  Delivery,
  DeliveryId,
  DocumentId,
  MemberId,
  MessengerPort,
} from "@tdsp/messenger-port";
import { encodeUpdate, getPlainText, insertPlainText } from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerWindowMs } from "./answer-turn";
import { type Clock, compareClocks } from "./clock";
import { CLOSE_REASON, type Register } from "./control-state";
import { decodeFrame, encodeControlFrame, encodeResyncResponseFrame, type Frame } from "./framing";
import { DocumentEngine, type DocumentEngineOptions, type PersistedControlState } from "./index";
import { DEFAULT_LOSS_GRACE_MS } from "./loss-detector";
import { registerStateDigest } from "./registers";

/**
 * What a device's bootstrap must never be (SPECIFICATION.md RSY-14, RSY-8, CTL-4, CTL-10, CTL-21,
 * CTL-26, CTL-27, CTL-45): a device of the creator is bootstrapped only by the creator's own state —
 * another device of the creator's answer to its own request, a restored or a carried state —, never by
 * a member's answer, which it merges all the same; until then it decides nothing but the close and its
 * reason, and hands on no control state — no snapshot, no control clock in its reports, requests or
 * `control` frames —, so it bootstraps nobody; a snapshot that names the creator or another profile is
 * rejected whole; and a device that merged registers far ahead keeps its own clock within the span
 * while its decisions hold over them everywhere, also after a restart. Completeness, not distrust: the
 * participants cooperate (§1.1, §15.2), but an empty or partial state offered as whole would leave its
 * receivers without what the creator decided. Security tests: only the CI role may change this file
 * (.github/CODEOWNERS).
 */

const DOC = "doc-1";
const AS_ALICE = { batchWindowMs: 0, resyncResponseThrottleMs: 0, creatorMemberId: "alice" };
/** 2026-10-26 10:00:00 UTC: the new device's wall clock throughout. */
const T = 1_793_008_800_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The tag of the creator's device that was lost. */
const LOST = "L".repeat(22);

/** The in-memory transport, with a member's view that can lack everything sent so far, or one message. */
class Port implements MessengerPort {
  readonly inner = new InMemoryMessengerPort();
  readonly #hidden = new Map<MemberId, Set<DeliveryId>>();
  #loseNextFor: MemberId | undefined;

  /** The next message anyone sends never reaches `member`: the network lost it on the way. */
  loseNextSendFor(member: MemberId): void {
    this.#loseNextFor = member;
  }

  /** Nothing sent so far ever reaches `member`: a new device that sees no history. */
  async hideHistoryFrom(member: MemberId): Promise<void> {
    const hidden = this.#hidden.get(member) ?? new Set();
    for (const delivery of await this.inner.receive(DOC, member)) hidden.add(delivery.id);
    this.#hidden.set(member, hidden);
  }
  createDocument(documentId: DocumentId, creator: MemberId): Promise<void> {
    return this.inner.createDocument(documentId, creator);
  }
  async send(documentId: DocumentId, sender: MemberId, payload: string): Promise<DeliveryId> {
    const id = await this.inner.send(documentId, sender, payload);
    if (this.#loseNextFor !== undefined) {
      const hidden = this.#hidden.get(this.#loseNextFor) ?? new Set();
      hidden.add(id);
      this.#hidden.set(this.#loseNextFor, hidden);
      this.#loseNextFor = undefined;
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

const register = (value: Register["value"], clock: Clock, device = LOST): Register => ({
  value,
  clock,
  device,
});

/** Every frame on the channel, with its sender, in the order sent. */
async function channel(port: Port): Promise<{ sender: MemberId; frame: Frame }[]> {
  return (await port.inner.receive(DOC, "observer")).map((delivery) => ({
    sender: delivery.sender,
    frame: decodeFrame(delivery.payload),
  }));
}

/** The `requestId` of the latest request `member` made. */
async function latestRequestOf(port: Port, member: MemberId): Promise<string> {
  const last = (await channel(port))
    .filter(({ sender, frame }) => sender === member && frame.kind === "resync-request")
    .at(-1)?.frame;
  if (last?.kind !== "resync-request") throw new Error(`no request of ${member}`);
  return last.requestId;
}

/** An answer to `respondsTo` with a snapshot of `targets`, as `sender` writes it. */
async function answerAs(
  port: Port,
  sender: MemberId,
  respondsTo: string,
  targets: Readonly<Record<string, Register>>,
  options: { closed?: boolean; profile?: string; update?: Uint8Array } = {},
): Promise<void> {
  await port.send(
    DOC,
    sender,
    encodeResyncResponseFrame({
      documentId: DOC,
      respondsTo,
      update: options.update ?? new Uint8Array([0, 0]),
      control: {
        profile: options.profile ?? "yjs-paragraphs/1",
        closed: options.closed ?? false,
        targets,
      },
    }),
  );
}

/** A `control` frame of the creator's identity, as a device of hers whose clock runs ahead writes it. */
async function creatorFrame(
  port: Port,
  targets: Readonly<Record<string, Register>>,
): Promise<void> {
  const state = { closed: false, targets };
  let clock: Clock = [0, 0];
  for (const held of Object.values(targets))
    if (compareClocks(held.clock, clock) > 0) clock = held.clock;
  await port.send(
    DOC,
    "alice",
    encodeControlFrame({
      documentId: DOC,
      device: LOST,
      targets,
      closed: false,
      controlClock: clock,
      controlDigest: registerStateDigest(state),
    }),
  );
}

/**
 * Whether a device's own clock lies within the span of its wall clock `T` (CTL-45): at most a day
 * ahead, but for the step each decision takes beyond it — the first such step moves `ms` one on.
 */
function withinTheSpan(clock: Clock | undefined): boolean {
  return clock !== undefined && clock[0] <= T + DAY + 1;
}

async function settle(...engines: DocumentEngine[]): Promise<void> {
  for (let round = 0; round < 6; round++) {
    for (const engine of engines) {
      await engine.sync();
      await engine.flush().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

/** A device of `member` joining, with what its application is told collected. */
async function deviceOf(port: Port, member: MemberId, options: DocumentEngineOptions = {}) {
  const persisted: PersistedControlState[] = [];
  const errors: unknown[] = [];
  const engine = await DocumentEngine.join(DOC, member, port, (error) => errors.push(error), {
    ...AS_ALICE,
    autoResync: false,
    onControlStateChange: (state) => persisted.push(state),
    ...options,
  });
  const saved = () => persisted.at(-1) as PersistedControlState;
  return { engine, errors, saved };
}

/**
 * Alice's only device made Bob a writer and Carol a reader, and was lost; Bob and Dave hold that. A
 * new device of Alice's joins at `T` on a transport that shows it nothing sent before, so only an
 * answer brings it anything; `request` is its first request.
 */
async function lostDevice(options: DocumentEngineOptions = {}) {
  const port = new Port();
  const old = await DocumentEngine.create(DOC, "alice", port, undefined, AS_ALICE);
  await old.setMembership("bob", "write");
  await old.setMembership("carol", "read");
  old.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
  const bob = await DocumentEngine.join(DOC, "bob", port, undefined, AS_ALICE);
  const dave = await DocumentEngine.join(DOC, "dave", port, undefined, AS_ALICE);
  await settle(old, bob, dave);
  const content = encodeUpdate(old.document);
  old.dispose();
  await port.hideHistoryFrom("alice");
  const history = (await channel(port)).length;
  const newDevice = await deviceOf(port, "alice", options);
  const request = await latestRequestOf(port, "alice");
  return { port, bob, dave, newDevice, request, content, history };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a device that is not bootstrapped hands on no control state (RSY-14, RSY-8)", () => {
  it("states no control clock in its reports either: it edits, a report follows, and that names no clock and no digest (SND-11)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T - HOUR);
    const port = new Port();
    const old = await DocumentEngine.create(DOC, "alice", port, undefined, AS_ALICE);
    await old.setMembership("bob", "write");
    old.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
    const bob = await DocumentEngine.join(DOC, "bob", port, undefined, AS_ALICE);
    for (let round = 0; round < 4; round++) {
      await old.sync();
      await bob.sync();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    const content = encodeUpdate(old.document);
    old.dispose();
    await port.hideHistoryFrom("alice");
    const history = (await channel(port)).length;
    // A report follows 10 s after its edit, whatever its pacing (SND-11).
    const newDevice = await DocumentEngine.join(DOC, "alice", port, undefined, {
      ...AS_ALICE,
      autoResync: false,
      syncPolicy: { minIntervalMs: 0, maxIntervalMs: 5_000, expectedLatencyMs: 1_000 },
    });
    const request = await latestRequestOf(port, "alice");
    // The content comes from another device of the creator that is not bootstrapped: no control state.
    await port.send(
      DOC,
      "alice",
      encodeResyncResponseFrame({
        documentId: DOC,
        respondsTo: request,
        update: content,
        control: null,
      }),
    );
    await newDevice.sync();
    expect(getPlainText(newDevice.fragment)).toBe("Plan");
    newDevice.edit((fragment) => insertPlainText(fragment, 4, "!"));
    for (let second = 0; second < 30; second++) {
      await vi.advanceTimersByTimeAsync(1_000);
      await newDevice.sync();
    }
    expect(newDevice.controlStanding).toStrictEqual({ kind: "none" });
    const heartbeats = (await channel(port))
      .slice(history)
      .filter(({ sender, frame }) => sender === "alice" && frame.kind === "heartbeat")
      .map(({ frame }) => frame);
    expect(heartbeats.length).toBeGreaterThan(0);
    for (const frame of heartbeats) {
      if (frame.kind !== "heartbeat") continue;
      expect(frame.controlClock).toBeNull();
      expect(frame.controlDigest).toBeNull();
    }
    newDevice.dispose();
    bob.dispose();
  });

  it("decides nothing but the close — the refusal names it —, states no clock and sends no snapshot: a joiner is not bootstrapped by it", async () => {
    const { port, newDevice, request, content, history } = await lostDevice();
    await expect(newDevice.engine.setMembership("erin", "read")).rejects.toMatchObject({
      reason: "not-bootstrapped",
    });
    // The content comes by an answer of another device of the creator that is not bootstrapped
    // either: without control state (RSY-8).
    await port.send(
      DOC,
      "alice",
      encodeResyncResponseFrame({
        documentId: DOC,
        respondsTo: request,
        update: content,
        control: null,
      }),
    );
    await newDevice.engine.sync();
    expect(getPlainText(newDevice.engine.fragment)).toBe("Plan");
    const erin = await DocumentEngine.join(DOC, "erin", port, undefined, AS_ALICE);
    await settle(newDevice.engine, erin);
    expect(newDevice.engine.controlStanding).toStrictEqual({ kind: "none" });
    expect(getPlainText(erin.fragment)).toBe("Plan"); // answered, with content alone
    // Before its close it sends its request and its answers to Erin, and nothing else: they state no
    // control clock and carry no snapshot (RSY-8, RSY-16). Its reports state none either (above), nor
    // does its one control frame, the close (below).
    const fromNewDevice = (await channel(port))
      .slice(history)
      .filter(({ sender }) => sender === "alice");
    expect(new Set(fromNewDevice.map(({ frame }) => frame.kind))).toStrictEqual(
      new Set(["resync-request", "resync-response"]),
    );
    for (const { frame } of fromNewDevice) {
      if (frame.kind === "resync-request") expect(frame.controlClock).toBeNull();
      if (frame.kind === "resync-response") expect(frame.control).toBeNull();
    }
    expect(erin.hasCompletedBootstrap).toBe(false);
    expect(erin.mayEdit).toBe(false);
    // Its one decision, the close: one control frame, which states no clock.
    const beforeClose = (await channel(port)).length;
    await newDevice.engine.closeDocument();
    await settle(newDevice.engine, erin);
    const closes = (await channel(port))
      .slice(beforeClose)
      .filter(({ sender, frame }) => sender === "alice" && frame.kind === "control")
      .map(({ frame }) => frame.kind === "control" && [frame.closed, frame.controlClock]);
    expect(closes).toStrictEqual([[true, null]]);
    expect(erin.closed).toBe(true);
  });
});

describe("a member's answer never bootstraps a device of the creator (CTL-25, CTL-27, RSY-14)", () => {
  it("merged, it brings the content and the rights, but the device decides nothing, states no clock and bootstraps no joiner; another device of the creator's answer then bootstraps it", async () => {
    const { port, bob, newDevice, request, content, history } = await lostDevice();
    await answerAs(port, "bob", request, bob.controlState.targets, { update: content });
    await answerAs(
      port,
      "dave",
      request,
      { ...bob.controlState.targets, "member:erin": register("read", [T, 0]) },
      { update: content },
    );
    await newDevice.engine.sync();
    expect(getPlainText(newDevice.engine.fragment)).toBe("Plan");
    expect(newDevice.engine.permissionOf("bob")).toBe("write");
    expect(newDevice.engine.permissionOf("erin")).toBe("read");
    expect(newDevice.engine.controlStanding).toStrictEqual({ kind: "none" });
    expect(newDevice.engine.hasCompletedBootstrap).toBe(false);
    expect(newDevice.saved().bootstrapped).toBeUndefined();
    await expect(newDevice.engine.setMembership("carol", null)).rejects.toMatchObject({
      reason: "not-bootstrapped",
    });
    const zed = await DocumentEngine.join(DOC, "zed", port, undefined, {
      ...AS_ALICE,
      autoResync: false,
    });
    await settle(newDevice.engine, zed);
    expect(zed.hasCompletedBootstrap).toBe(false);
    // It sends its request and its answer to Zed, and nothing else — no `control` frame: neither
    // states control state (RSY-8, RSY-16).
    const fromNewDevice = (await channel(port))
      .slice(history)
      .filter(({ sender }) => sender === "alice");
    expect(new Set(fromNewDevice.map(({ frame }) => frame.kind))).toStrictEqual(
      new Set(["resync-request", "resync-response"]),
    );
    for (const { frame } of fromNewDevice) {
      if (frame.kind === "resync-request") expect(frame.controlClock).toBeNull();
      if (frame.kind === "resync-response") expect(frame.control).toBeNull();
    }
    // Another device of the creator answers its next request: that bootstraps it, and it decides.
    await newDevice.engine.requestResync();
    await answerAs(port, "alice", await latestRequestOf(port, "alice"), bob.controlState.targets);
    await newDevice.engine.sync();
    expect(newDevice.engine.controlStanding).toStrictEqual({ kind: "bootstrapped" });
    expect(newDevice.engine.permissionOf("erin")).toBe("read");
    await newDevice.engine.setMembership("carol", null);
    expect(newDevice.engine.rightOf("carol")).toBe("revoked");
  });
});

describe("a snapshot the receiver cannot hold for its document is rejected whole (CTL-4, CTL-10, FRM-6)", () => {
  it("one that names the creator, on the document or on a layer, or another profile: no content, nothing merged, no bootstrap; the next answer, another device of the creator's, bootstraps", async () => {
    const { port, bob, newDevice, request, content } = await lostDevice();
    const targets = bob.controlState.targets;
    await answerAs(
      port,
      "bob",
      request,
      { ...targets, "member:alice": register("read", [T, 0]) },
      { update: content },
    );
    await answerAs(
      port,
      "dave",
      request,
      { ...targets, "layer:com.example.comments/1:member:alice": register("read", [T, 0]) },
      { update: content },
    );
    await answerAs(port, "carol", request, targets, {
      profile: "com.example.other/1",
      update: content,
    });
    await newDevice.engine.sync();
    expect(getPlainText(newDevice.engine.fragment)).toBe("");
    expect(newDevice.engine.controlStanding).toStrictEqual({ kind: "none" });
    expect(newDevice.engine.permissionOf("bob")).toBeUndefined();
    expect(newDevice.engine.rightOf("alice")).toBe("creator");
    expect(newDevice.errors.length).toBe(3);
    // The first answer it does not reject, another device of the creator's, bootstraps it.
    await answerAs(port, "alice", request, targets, { update: content });
    await newDevice.engine.sync();
    expect(newDevice.engine.controlStanding).toStrictEqual({ kind: "bootstrapped" });
    expect(newDevice.engine.permissionOf("bob")).toBe("write");
    expect(newDevice.engine.rightOf("alice")).toBe("creator");
    expect(newDevice.engine.mayEdit).toBe(true);
  });
});

describe("registers merged far ahead (CTL-21, CTL-45, CTL-26)", () => {
  it("the device's own clock rises to what it merged, within the span: its next decision holds also over what the lost device decided and the answer lacked", async () => {
    const { port, bob, dave, newDevice, request } = await lostDevice();
    // The lost device's clock ran twelve hours ahead; its last decisions reached Bob, and one on
    // Erin reached only Dave, who is offline when the new device asks.
    await creatorFrame(port, { "member:carol": register("write", [T + 12 * HOUR, 0]) });
    await creatorFrame(port, { "member:erin": register("write", [T + 12 * HOUR - 1_000, 0]) });
    await bob.sync();
    await dave.sync();
    await port.hideHistoryFrom("alice"); // sent before the new device came
    // Another device of the creator, holding what Bob holds, answers.
    await answerAs(port, "alice", request, {
      "member:bob": bob.controlState.targets["member:bob"] as Register,
      "member:carol": bob.controlState.targets["member:carol"] as Register,
    });
    await newDevice.engine.sync();
    expect(newDevice.engine.permissionOf("carol")).toBe("write");
    expect(
      compareClocks(newDevice.saved().clock as Clock, [T + 12 * HOUR, 0]),
    ).toBeGreaterThanOrEqual(0);
    // The person makes Erin a reader, not knowing of the lost device's grant.
    await newDevice.engine.setMembership("erin", "read");
    await settle(newDevice.engine, dave, bob);
    for (const engine of [newDevice.engine, dave, bob])
      expect(engine.permissionOf("erin")).toBe("read");
  });

  it("a decision over a register two and three days ahead holds everywhere, also after a restart, and no clock of the device runs more than a day ahead", async () => {
    const { port, bob, dave, newDevice, request } = await lostDevice();
    // A device of the creator whose clock ran two days ahead gave Mallory write; Bob and Dave hold it.
    await creatorFrame(port, { "member:mallory": register("write", [T + 2 * DAY, 0]) });
    await settle(bob, dave);
    await port.hideHistoryFrom("alice"); // sent before the new device came
    expect(dave.permissionOf("mallory")).toBe("write");
    // Another device of the creator, holding what Bob holds, answers.
    await answerAs(port, "alice", request, bob.controlState.targets);
    await newDevice.engine.sync();
    expect(newDevice.engine.permissionOf("mallory")).toBe("write");
    expect(withinTheSpan(newDevice.saved().clock)).toBe(true);
    // Before a restart: the person makes Mallory a reader.
    await newDevice.engine.setMembership("mallory", "read");
    await settle(newDevice.engine, dave);
    expect(dave.permissionOf("mallory")).toBe("read");
    expect(withinTheSpan(newDevice.saved().clock)).toBe(true);

    // Another register far ahead, which only members saw; the device merges it, restarts, and decides.
    await creatorFrame(port, { "member:zed": register("write", [T + 3 * DAY, 0]) });
    await settle(bob, dave);
    await port.hideHistoryFrom("alice");
    await newDevice.engine.requestResync();
    await answerAs(port, "bob", await latestRequestOf(port, "alice"), bob.controlState.targets);
    await newDevice.engine.sync();
    expect(newDevice.engine.permissionOf("zed")).toBe("write"); // a member's answer, merged by a bootstrapped device
    const saved = newDevice.saved();
    newDevice.engine.dispose();
    const restarted = await deviceOf(port, "alice", { controlState: saved });
    await restarted.engine.setMembership("zed", null);
    await settle(restarted.engine, dave, bob);
    for (const engine of [restarted.engine, dave, bob])
      expect(engine.rightOf("zed")).toBe("revoked");
    expect(withinTheSpan(restarted.saved().clock)).toBe(true);
  });
});

/** Advances fake timers by `ms`, every engine polling each second. */
async function runTimers(ms: number, engines: readonly DocumentEngine[]): Promise<void> {
  for (let passed = 0; passed < ms; passed += 1_000) {
    await vi.advanceTimersByTimeAsync(1_000);
    for (const engine of engines) await engine.sync();
  }
}

describe("a bootstrap merges, and takes nothing away (CTL-25, CTL-27, CTL-32, RSY-14)", () => {
  it("a merge never undoes what the device held before its bootstrap: a register only Dave's answer brought stays after another device of the creator's answer, which lacks it, bootstraps it", async () => {
    const { port, bob, newDevice, request, content } = await lostDevice();
    await answerAs(
      port,
      "dave",
      request,
      { ...bob.controlState.targets, "member:erin": register("read", [T, 0]) },
      { update: content },
    );
    await newDevice.engine.sync();
    expect(newDevice.engine.controlStanding).toStrictEqual({ kind: "none" });
    // Another device of the creator answers without it.
    await answerAs(port, "alice", request, bob.controlState.targets);
    await newDevice.engine.sync();
    expect(newDevice.engine.controlStanding).toStrictEqual({ kind: "bootstrapped" });
    expect(newDevice.engine.permissionOf("erin")).toBe("read");
    expect(newDevice.engine.permissionOf("carol")).toBe("read");
    expect(newDevice.saved().control.targets["member:erin"]?.value).toBe("read");
  });

  it("a bootstrap whose merge leads into a capacity conflict is a bootstrap: the device shows the conflict and persists both", async () => {
    const { port, newDevice, request, content } = await lostDevice();
    // 5 001 targets: one more than any device holds (CTL-30).
    const targets: Record<string, Register> = {};
    for (let i = 0; i < 5_001; i++)
      targets[`member:m${String(i).padStart(4, "0")}`] = register("read", [T - DAY, 0]);
    await answerAs(port, "alice", request, targets, { update: content });
    await newDevice.engine.sync();
    expect(newDevice.engine.controlStanding).toStrictEqual({ kind: "bootstrapped" });
    expect(newDevice.engine.capacityConflict).toBe(true);
    expect(newDevice.saved().bootstrapped).toBe(true);
    expect(newDevice.saved().capacityConflict).toBe(true);
  });
});

describe("the report a bootstrapped device of the creator owes for what it merged goes at once, whatever its pacing (SND-11, LOS-10)", () => {
  it("its bootstrap: a register a member's answer brought before, which Bob lacks, reaches Bob — with no longest wait set, and content that came earlier by itself", async () => {
    const { port, bob, newDevice, request, content } = await lostDevice();
    vi.useFakeTimers();
    vi.setSystemTime(T);
    // The device sends no edit or control frame of its own, and an answer owes no report: only the
    // report its bootstrap owes for what it merged can bring Bob the register (SND-11).
    // Dave holds a decision of the lost device that Bob lost; his answer brings it, and bootstraps nothing.
    await answerAs(port, "dave", request, {
      ...bob.controlState.targets,
      "member:erin": register("read", [T, 0]),
    });
    // The content first, by another device of the creator that is not bootstrapped: no control state.
    await port.send(
      DOC,
      "alice",
      encodeResyncResponseFrame({
        documentId: DOC,
        respondsTo: request,
        update: content,
        control: null,
      }),
    );
    await newDevice.engine.sync();
    expect(newDevice.engine.controlStanding).toStrictEqual({ kind: "none" });
    expect(newDevice.engine.permissionOf("erin")).toBe("read");
    expect(bob.permissionOf("erin")).toBeUndefined();
    // Then another device of the creator's answer, which brings nothing new: it bootstraps the device.
    await answerAs(port, "alice", request, bob.controlState.targets);
    await runTimers(60_000, [newDevice.engine, bob]);
    expect(newDevice.engine.controlStanding).toStrictEqual({ kind: "bootstrapped" });
    expect(bob.permissionOf("erin")).toBe("read");
  });

  it("a later merge that changed what it holds: a register only Dave held reaches Bob and Carol — with no longest wait set", async () => {
    const { port, bob, dave, newDevice, request, content } = await lostDevice();
    const carol = await DocumentEngine.join(DOC, "carol", port, undefined, AS_ALICE);
    vi.useFakeTimers();
    vi.setSystemTime(T);
    await answerAs(port, "alice", request, bob.controlState.targets, { update: content });
    await runTimers(30_000, [newDevice.engine, bob, carol, dave]);
    expect(newDevice.engine.controlStanding).toStrictEqual({ kind: "bootstrapped" });
    expect(carol.hasCompletedBootstrap).toBe(true);
    // Dave answers the device's next request with a decision of the lost device only he holds: a
    // bootstrapped device of the creator merges anyone's answer (CTL-25).
    await newDevice.engine.requestResync();
    const held = { ...dave.controlState.targets, "member:gina": register("write", [T - HOUR, 0]) };
    await answerAs(port, "dave", await latestRequestOf(port, "alice"), held);
    // The merge changed the device's digest: its report goes at once (SND-11), and at Bob's and Carol's
    // clock it states another digest (LOS-12), so each asks and the device's answer brings the register.
    // Each may first let a try go for the device's own request to all, heard before the merge, which at
    // their clock reaches no further (RSY-22): then their own waits until that one had its time, 40 s
    // from when they heard it, and then their place, within the answer window (LOS-6). The gap's wait,
    // those 40 s, the place, and the device's answer at once: under 85 s.
    const requestToAllMs = 10_000 + answerWindowMs(0); // RSY-4: the floor of the expiry, and the window
    await runTimers(2 * DEFAULT_LOSS_GRACE_MS + requestToAllMs + answerWindowMs(0) + 5_000, [
      newDevice.engine,
      bob,
      carol,
    ]);
    expect(newDevice.engine.permissionOf("gina")).toBe("write");
    for (const member of [bob, carol]) expect(member.permissionOf("gina")).toBe("write");
  });
});

describe("a state persisted under a draft's marker, or none, is read as nothing (VER-3, CTL-26, CTL-39)", () => {
  it("neither a member's bootstrapped state nor the creator's is used under draft-10's marker, or the string \"2\"; under version 2 both are", async () => {
    // The plain in-memory transport: it keeps a cursor, so a restart reads on from it, not the history.
    const port = new InMemoryMessengerPort();
    const persisted: PersistedControlState[] = [];
    const bobs: PersistedControlState[] = [];
    const alice = await DocumentEngine.create(DOC, "alice", port, undefined, {
      ...AS_ALICE,
      onControlStateChange: (state) => persisted.push(state),
    });
    await alice.setMembership("bob", "write");
    alice.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
    const bob = await DocumentEngine.join(DOC, "bob", port, undefined, {
      ...AS_ALICE,
      onControlStateChange: (state) => bobs.push(state),
    });
    await settle(alice, bob);
    expect(bob.controlStanding).toStrictEqual({ kind: "bootstrapped" });
    const saved = bobs.at(-1) as PersistedControlState;
    expect(saved.bootstrapped).toBe(true);
    const restore = { state: encodeUpdate(bob.document), cursor: bob.cursor };
    expect(restore.cursor).toBeDefined();
    bob.dispose();
    // The last draft's marker (VER-3): what a device that ran draft-10 persisted.
    const another = "de.wappensc.together.tdsp.probe.draft-10";
    const { tdsp: _marker, ...unmarked } = saved;
    for (const [state, held] of [
      [unmarked, undefined],
      [{ ...saved, tdsp: another }, undefined],
      [{ ...saved, tdsp: "2" }, undefined],
      [saved, "write"],
    ] as const) {
      const again = await DocumentEngine.join(DOC, "bob", port, undefined, {
        ...AS_ALICE,
        autoResync: false,
        controlState: state as PersistedControlState,
        restore,
      });
      expect(again.permissionOf("bob")).toBe(held);
      again.dispose();
    }
    // A device of the creator's: its registers and its bootstrap come only from the persisted state,
    // the channel holding nothing any more.
    const creators = persisted.at(-1) as PersistedControlState;
    alice.dispose();
    port.forgetOldest(DOC, (await port.receive(DOC, "observer")).length);
    const wrong = await DocumentEngine.join(DOC, "alice", port, undefined, {
      ...AS_ALICE,
      autoResync: false,
      controlState: { ...creators, tdsp: another },
    });
    expect(wrong.controlStanding).toStrictEqual({ kind: "none" });
    expect(wrong.permissionOf("bob")).toBeUndefined();
    expect(wrong.deviceTag).not.toBe(alice.deviceTag);
    wrong.dispose();
    const right = await DocumentEngine.join(DOC, "alice", port, undefined, {
      ...AS_ALICE,
      autoResync: false,
      controlState: creators,
    });
    expect(right.controlStanding).toStrictEqual({ kind: "bootstrapped" });
    expect(right.permissionOf("bob")).toBe("write");
    expect(right.deviceTag).toBe(alice.deviceTag);
  });
});

describe("a device of the creator that is not bootstrapped decides only the close and its reason (CTL-27, CTL-23)", () => {
  it("refuses the pace and a right on a layer as not-bootstrapped, as it refuses a member's permission, and sends nothing for them", async () => {
    const { port, bob, newDevice, history } = await lostDevice();
    await expect(newDevice.engine.setPace(60_000)).rejects.toMatchObject({
      reason: "not-bootstrapped",
    });
    for (const right of ["read", "write", null] as const) {
      await expect(
        newDevice.engine.setLayerRight("com.example.comments/1", "bob", right),
        String(right),
      ).rejects.toMatchObject({ reason: "not-bootstrapped" });
    }
    await settle(newDevice.engine, bob);
    expect(newDevice.engine.controlState.targets).toStrictEqual({});
    const decisions = (await channel(port))
      .slice(history)
      .filter(({ sender, frame }) => sender === "alice" && frame.kind === "control");
    expect(decisions).toStrictEqual([]);
    expect(bob.controlState.targets["layer:com.example.comments/1:member:bob"]).toBeUndefined();
  });

  it("closes, then sets the reason creator-state-lost: both go, neither states a control clock, and the members hold both (CTL-46)", async () => {
    const { port, bob, dave, newDevice } = await lostDevice();
    const before = (await channel(port)).length;
    await newDevice.engine.closeDocument();
    await newDevice.engine.setCloseReason("creator-state-lost");
    await settle(newDevice.engine, bob, dave);
    expect(newDevice.engine.controlStanding).toStrictEqual({ kind: "none" });
    expect(newDevice.engine.closeReason).toBe("creator-state-lost");
    // Each frame once, whether or not a report sends the last one again (SND-27).
    const decisions = new Set(
      (await channel(port))
        .slice(before)
        .filter(({ sender, frame }) => sender === "alice" && frame.kind === "control")
        .map(({ frame }) =>
          frame.kind === "control"
            ? JSON.stringify([
                frame.closed,
                frame.targets[CLOSE_REASON]?.value ?? null,
                frame.controlClock,
                frame.controlDigest,
              ])
            : "",
        ),
    );
    expect([...decisions]).toStrictEqual([
      JSON.stringify([true, null, null, null]),
      JSON.stringify([true, "creator-state-lost", null, null]),
    ]);
    for (const member of [bob, dave]) {
      expect(member.closed).toBe(true);
      expect(member.closeReason).toBe("creator-state-lost");
    }
  });
});
