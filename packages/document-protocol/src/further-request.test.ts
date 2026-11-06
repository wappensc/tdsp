import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import type {
  Delivery,
  DeliveryId,
  DocumentId,
  MemberId,
  MessengerPort,
} from "@tdsp/messenger-port";
import { insertPlainText } from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFrame, type Frame } from "./framing";
import { DocumentEngine, type DocumentEngineOptions } from "./index";

/**
 * What is no sign that someone is back (SPECIFICATION.md RSY-5): a joiner whose attempts ran out asks
 * once more when, after its latest request had its time, it reads a frame of a participant that did
 * not answer that request. Its own frame offered again, under a delivery id of its own, is none: it
 * comes from no one else (LOS-17); nor is a frame it read while that request still waited, which
 * shows someone there before the request had its time, not after it.
 */

const DOC = "doc-1";
/** 2026-10-26 10:00:00 UTC. */
const T = 1_793_008_800_000;
const MINUTE = 60_000;
const BASE: DocumentEngineOptions = {
  batchWindowMs: 0,
  resyncResponseThrottleMs: 0,
  creatorMemberId: "alice",
  syncPolicy: { expectedLatencyMs: 2_000 },
};

interface Sent {
  readonly at: number;
  readonly id: DeliveryId;
  readonly device: string;
  readonly frame: Frame;
}

/** One channel, every send logged with the device that made it. */
class Net {
  readonly inner = new InMemoryMessengerPort();
  readonly log: Sent[] = [];

  view(member: MemberId, device: string): View {
    return new View(this, member, device);
  }

  /** When `device` sent a request, from `since` on. */
  requests(device: string, since = 0): number[] {
    return this.log
      .filter((s) => s.at >= since && s.device === device && s.frame.kind === "resync-request")
      .map((s) => s.at);
  }
}

class View implements MessengerPort {
  constructor(
    readonly net: Net,
    readonly member: MemberId,
    readonly device: string,
  ) {}

  createDocument(documentId: DocumentId, creator: MemberId): Promise<void> {
    return this.net.inner.createDocument(documentId, creator);
  }

  async send(documentId: DocumentId, sender: MemberId, payload: string): Promise<DeliveryId> {
    const id = await this.net.inner.send(documentId, sender, payload);
    this.net.log.push({ at: Date.now(), id, device: this.device, frame: decodeFrame(payload) });
    return id;
  }

  receive(documentId: DocumentId, member: MemberId): Promise<readonly Delivery[]> {
    return this.net.inner.receive(documentId, member);
  }

  listChannels(member: MemberId) {
    return this.net.inner.listChannels(member);
  }
}

async function run(ms: number, engines: readonly DocumentEngine[], step = 1_000): Promise<void> {
  for (let passed = 0; passed < ms; passed += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - passed));
    for (const engine of engines) {
      await engine.sync().catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
    }
  }
}

/**
 * Alice creates "Plan", lets Carol write, and Carol joins; Alice lets Bob write too, and her report
 * after it goes. Then Alice is gone and Carol reads nothing more: nobody answers Bob, who joins now.
 */
async function nobodyAnswersBob() {
  const net = new Net();
  await net.inner.createDocument(DOC, "alice");
  const alice = await DocumentEngine.create(DOC, "alice", net.view("alice", "a1"), undefined, BASE);
  await alice.setMembership("carol", "write");
  alice.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
  await run(5_000, [alice]);
  const carol = await DocumentEngine.join(
    DOC,
    "carol",
    net.view("carol", "carol"),
    undefined,
    BASE,
  );
  await run(2 * MINUTE, [alice, carol]);
  expect(carol.hasCompletedBootstrap).toBe(true);
  await alice.setMembership("bob", "write");
  await run(15_000, [alice, carol]);
  expect(
    net.log.filter((s) => s.device === "a1" && s.frame.kind === "heartbeat").at(-1)?.at,
  ).toBeGreaterThan(Date.now() - 15_000);
  alice.dispose();
  const joined = Date.now();
  const bob = await DocumentEngine.join(DOC, "bob", net.view("bob", "bob"), undefined, BASE);
  return { net, carol, bob, joined };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the further request of a bootstrap whose attempts ran out (RSY-5)", () => {
  it("the device's own request, offered again under a new delivery id, is no sign that someone is back (LOS-17)", {
    timeout: 60_000,
  }, async () => {
    const { net, bob } = await nobodyAnswersBob();
    await run(30 * MINUTE, [bob], 5_000);
    expect(bob.syncHealth.attemptsRanOut).toBe(true);
    const latest = net.log
      .filter((s) => s.device === "bob" && s.frame.kind === "resync-request")
      .at(-1) as Sent;
    const payload = (await net.inner.receive(DOC, "observer")).find((d) => d.id === latest.id)
      ?.payload as string;
    const since = Date.now();
    await net.inner.send(DOC, "bob", payload);
    await run(30 * MINUTE, [bob], 5_000);
    expect(net.requests("bob", since)).toStrictEqual([]);
  });

  it("a frame of a participant read while the latest request still waited is no sign that someone came back after it had its time", {
    timeout: 60_000,
  }, async () => {
    const { net, carol, bob, joined } = await nobodyAnswersBob();
    // The first request and its five repeats: the last of them still waits.
    for (let waited = 0; net.requests("bob", joined).length < 6; waited += 1_000) {
      expect(waited).toBeLessThan(30 * MINUTE);
      await run(1_000, [bob]);
    }
    carol.edit((fragment) => insertPlainText(fragment, 0, "c"));
    await run(1_000, [bob]);
    const after = Date.now();
    await run(30 * MINUTE, [bob], 5_000);
    expect(bob.syncHealth.attemptsRanOut).toBe(true);
    expect(net.requests("bob", after)).toStrictEqual([]);
  });
});
