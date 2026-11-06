import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import { getPlainText, insertPlainText } from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerDelayMs, answerWindowMs } from "./answer-turn";
import { decodeFrame, type Frame } from "./framing";
import { DocumentEngine, type DocumentEngineOptions } from "./index";

/**
 * Durations and deadlines are measured on a clock that does not run back (SND-25, SPECIFICATION.md §1.6):
 * a wall clock set back an hour — as a time service may set it — changes no wait of the engine.
 * Each test sets the wall clock back an hour in the middle of a wait and expects the wait to end
 * when it would have without the jump. Only CTL-45's control clock reads the wall clock; its
 * rules for a jump back are tested in clock.test.ts and control.security.test.ts.
 */

const DOC = "doc-1";
const HOUR = 3_600_000;
/**
 * A 20 s longest wait and 5 s to arrive: a request expires after 10 s, a request to all after 40 s
 * (the window of 30 s besides); a gap counts as evidence after 5 s and is asked about after 10 s and
 * its slot in that window.
 */
const OPTS: DocumentEngineOptions = {
  batchWindowMs: 0,
  creatorMemberId: "alice",
  resyncResponseThrottleMs: 0,
  syncPolicy: { maxIntervalMs: 20_000, expectedLatencyMs: 5_000 },
};

/** Every frame on the channel, with its sender, in the order sent. */
async function channel(port: InMemoryMessengerPort): Promise<{ sender: string; frame: Frame }[]> {
  return (await port.receive(DOC, "observer")).map((delivery) => ({
    sender: delivery.sender,
    frame: decodeFrame(delivery.payload),
  }));
}

async function requestsOf(port: InMemoryMessengerPort, sender: string): Promise<number> {
  return (await channel(port)).filter(
    (d) => d.sender === sender && d.frame.kind === "resync-request",
  ).length;
}

async function answersFrom(port: InMemoryMessengerPort, sender: string): Promise<number> {
  return (await channel(port)).filter(
    (d) => d.sender === sender && d.frame.kind === "resync-response",
  ).length;
}

/** Polls `engines` every second for `ms`, as their application does. */
async function run(ms: number, ...engines: DocumentEngine[]): Promise<void> {
  for (let passed = 0; passed < ms; passed += 1_000) {
    await vi.advanceTimersByTimeAsync(1_000);
    for (const engine of engines) await engine.sync();
    await vi.advanceTimersByTimeAsync(0);
  }
}

/** The wall clock is set back an hour, as a time service may do. */
function wallClockBack(): void {
  vi.setSystemTime(Date.now() - HOUR);
}

/** Alice creates the document with "Plan", lets `members` write, and each joins and is bootstrapped. */
async function group(port: InMemoryMessengerPort, ...members: string[]) {
  const alice = await DocumentEngine.create(DOC, "alice", port, undefined, OPTS);
  for (const member of members) await alice.setMembership(member, "write");
  alice.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
  const joined: DocumentEngine[] = [];
  for (const member of members)
    joined.push(await DocumentEngine.join(DOC, member, port, undefined, OPTS));
  for (let round = 0; round < 3; round++) {
    for (const engine of [alice, ...joined]) await engine.sync();
    await vi.advanceTimersByTimeAsync(0);
  }
  for (const engine of joined) expect(engine.hasCompletedBootstrap).toBe(true);
  return { alice, joined };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-28T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a wall clock that jumps back changes no wait of the engine (SND-25)", () => {
  it("a joiner nobody answers asks again once its request expired, not an hour later (RSY-4, RSY-5)", async () => {
    const port = new InMemoryMessengerPort();
    await DocumentEngine.create(DOC, "alice", port, undefined, OPTS); // and never answers
    const bob = await DocumentEngine.join(DOC, "bob", port, undefined, OPTS);
    expect(await requestsOf(port, "bob")).toBe(1);
    await run(5_000, bob);
    wallClockBack();
    await run(4_000, bob);
    expect(await requestsOf(port, "bob")).toBe(1);
    await run(2_000, bob); // 10 s after the first: it expired, and the next goes out
    expect(await requestsOf(port, "bob")).toBe(2);
  });

  /**
   * Carol and Gina may write; the creator is gone; Gina's new device asks all, which only Carol can
   * answer, at her turn: the delay her stream and the request give in a window of 30 s (RSY-20).
   * The wall clock goes back an hour before or after Carol hears the request.
   */
  async function carolAnswersGina(jump: "before" | "after") {
    const port = new InMemoryMessengerPort();
    const { alice, joined } = await group(port, "carol", "gina");
    const [carol] = joined as [DocumentEngine, DocumentEngine];
    alice.dispose();
    port.disconnect("alice");
    port.modifyNextSend("gina", (payload) => payload.replace('"all":false', '"all":true'));
    const gina = await DocumentEngine.join(DOC, "gina", port, undefined, {
      ...OPTS,
      autoResync: false,
    });
    const frames = await channel(port);
    const stream = frames.find(
      (d) => d.sender === "carol" && d.frame.kind === "resync-request",
    )?.frame;
    const request = frames
      .filter((d) => d.sender === "gina" && d.frame.kind === "resync-request")
      .at(-1)?.frame;
    if (stream?.kind !== "resync-request" || request?.kind !== "resync-request")
      throw new Error("no requests");
    expect(request.all).toBe(true);
    const turn = answerDelayMs(request.requestId, stream.stream, answerWindowMs(5_000));
    const before = await answersFrom(port, "carol");
    if (jump === "before") wallClockBack();
    await carol.sync(); // Carol hears it
    if (jump === "after") wallClockBack();
    let waited = 0;
    while ((await answersFrom(port, "carol")) === before && waited < 2 * HOUR) {
      await run(1_000, carol);
      waited += 1_000;
    }
    // Polled every second: answered on the first poll at or after her turn.
    expect(waited).toBe(Math.ceil(turn / 1_000) * 1_000);
    await run(1_000, gina);
    expect(getPlainText(gina.fragment)).toBe("Plan");
  }

  it("a member answers a request to all at its turn, not an hour later, when the wall clock went back after it heard the request (RSY-20)", async () => {
    await carolAnswersGina("after");
  });

  it("and not before its turn either, when the wall clock went back before it heard the request (RSY-20)", async () => {
    await carolAnswersGina("before");
  });

  it("evidence of a lost message is acted on after its wait, not an hour later (LOS-1, LOS-6)", async () => {
    const port = new InMemoryMessengerPort();
    const { alice, joined } = await group(port, "bob");
    const [bob] = joined as [DocumentEngine];
    port.dropNextSend("alice");
    alice.edit((fragment) => insertPlainText(fragment, 4, " one"));
    await vi.advanceTimersByTimeAsync(1_000);
    alice.edit((fragment) => insertPlainText(fragment, 8, " two"));
    await vi.advanceTimersByTimeAsync(1_000);
    await bob.sync(); // the gap is first seen here
    const before = await requestsOf(port, "bob");
    wallClockBack();
    await vi.advanceTimersByTimeAsync(5_000);
    await bob.sync();
    expect(bob.syncHealth.suspicions.map((s) => s.kind)).toContain("pending-gap"); // after one latency
    // Two latencies and the gap's slot, within the answer window of 30 s: it asks (LOS-6).
    await vi.advanceTimersByTimeAsync(5_000 + 30_000);
    await bob.sync();
    expect(await requestsOf(port, "bob")).toBe(before + 1);
    await alice.sync();
    await vi.advanceTimersByTimeAsync(0);
    await bob.sync();
    expect(getPlainText(bob.fragment)).toBe("Plan one two");
  });

  it("reports when a request was made, when it expires and since when evidence lasts by the wall clock as it reads now", async () => {
    const port = new InMemoryMessengerPort();
    const { alice, joined } = await group(port, "bob");
    const [bob] = joined as [DocumentEngine];
    port.dropNextSend("alice");
    alice.edit((fragment) => insertPlainText(fragment, 4, " one"));
    await vi.advanceTimersByTimeAsync(1_000);
    alice.edit((fragment) => insertPlainText(fragment, 8, " two"));
    await vi.advanceTimersByTimeAsync(1_000);
    await bob.sync();
    const seenAt = Date.now();
    await run(10_000 + 30_000, bob); // it asks, after the gap's wait and its slot (LOS-6)
    const askedAt = bob.syncHealth.resync.requestedAt as number;
    expect(askedAt).toBeGreaterThan(seenAt);
    wallClockBack();
    const health = bob.syncHealth;
    // As far from now as before the jump: never in the future of the clock the application reads.
    expect(health.resync.requestedAt).toBe(askedAt - HOUR);
    // A request for a gap asks all (RSY-21): 10 s and the members' window of 30 s (RSY-4, RSY-20).
    expect(health.resync.expiresAt).toBe(askedAt - HOUR + 40_000);
    expect(health.suspicions.find((s) => s.kind === "pending-gap")?.since).toBe(seenAt - HOUR);
  });
});
