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
import { getPlainText, insertPlainText } from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentEngine } from "./index";

/**
 * What must stay (SPECIFICATION.md §1.7) that no other
 * test file holds as a whole: email's timing (§1.7, items 1 and 13) and an own device bringing a new one up to
 * date while the creator is away (§1.7, item 6). Where every other invariant is held is listed in the
 * requirements' mapping.
 */

const DOCUMENT_ID = "doc-1";

/**
 * A transport timed like TDSP's email bridge (bridges/email-bridge/src/transport-profile.ts): a
 * floor of 15 s, 30 s suggested with 60 s of expected latency, and a provider that accepts at most
 * one message per 34 s from each sender (bindings/bridges.md, Appendix C, measured on one provider). Messages arrive
 * 60 s after they were sent.
 */
class EmailTimedPort implements MessengerPort {
  readonly inner = new InMemoryMessengerPort();
  readonly latencyMs = 60_000;
  readonly providerGapMs = 34_000;
  readonly #visibleAt = new Map<DeliveryId, number>();
  readonly #lastAccepted = new Map<MemberId, number>();
  refusals = 0;

  createDocument(documentId: DocumentId, creator: MemberId): Promise<void> {
    return this.inner.createDocument(documentId, creator);
  }

  async send(documentId: DocumentId, sender: MemberId, payload: string): Promise<DeliveryId> {
    const now = Date.now();
    const last = this.#lastAccepted.get(sender);
    if (last !== undefined && now - last < this.providerGapMs) {
      this.refusals += 1;
      throw new TransportSendError(
        "rate-limited",
        "the provider refused: too fast",
        this.providerGapMs - (now - last),
      );
    }
    this.#lastAccepted.set(sender, now);
    const id = await this.inner.send(documentId, sender, payload);
    this.#visibleAt.set(id, now + this.latencyMs);
    return id;
  }

  async receive(documentId: DocumentId, member: MemberId): Promise<readonly Delivery[]> {
    const now = Date.now();
    return (await this.inner.receive(documentId, member)).filter(
      (delivery) => (this.#visibleAt.get(delivery.id) ?? 0) <= now,
    );
  }

  listChannels(member: MemberId): Promise<readonly RawChannel[]> {
    return this.inner.listChannels(member);
  }

  async transportProfile(): Promise<TransportProfile> {
    return {
      bounds: { minIntervalMs: 15_000, maxBytes: 4 * 1024 * 1024 },
      pacing: {
        minIntervalMs: 30_000,
        maxIntervalMs: 120_000,
        minChars: 0,
        maxChars: null,
        expectedLatencyMs: 60_000,
      },
    };
  }
}

describe("email's timing (§1.7, items 1 and 13)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Polls every engine every 10 s for `ms`, as an application does. */
  async function run(ms: number, ...engines: DocumentEngine[]): Promise<void> {
    for (let t = 0; t < ms; t += 10_000) {
      await vi.advanceTimersByTimeAsync(10_000);
      for (const engine of engines) {
        await engine.sync().catch(() => {});
      }
    }
  }

  it("two people writing converge, keep the provider's limit with the creator's pace, and suspect no loss that is only latency", {
    timeout: 30_000,
  }, async () => {
    const port = new EmailTimedPort();
    const options = { creatorMemberId: "alice", batchWindowMs: 500 };
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, options);
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, options);
    await run(180_000, alice, bob); // the join: a request, an answer, each a minute on the way
    expect(bob.hasCompletedBootstrap).toBe(true);
    // The bridge suggests 30 s, below the 34 s the provider was measured to allow: before the pace,
    // the provider may refuse, and the scheduler retries and slows down (SND-7).
    const paced = alice.setPace(40_000); // the creator keeps the thread quiet for everyone
    await run(240_000, alice, bob);
    await paced;
    expect(bob.syncPolicy.minIntervalMs).toBe(40_000);
    const refusalsBefore = port.refusals;

    for (let i = 0; i < 6; i++) {
      alice.edit((fragment) => insertPlainText(fragment, 0, `a${i} `));
      bob.edit((fragment) => insertPlainText(fragment, 0, `b${i} `));
      await run(20_000, alice, bob);
      // Each message takes a minute: a follow-up due within 120 s plus a latency is not overdue.
      for (const engine of [alice, bob]) {
        expect(engine.syncHealth.suspicions.filter((s) => s.kind === "sender-overdue")).toEqual([]);
      }
    }
    await run(600_000, alice, bob);
    expect(getPlainText(bob.fragment)).toBe(getPlainText(alice.fragment));
    expect(getPlainText(alice.fragment).match(/[ab]\d/g)).toHaveLength(12);
    // With the pace in force nobody sent faster than the provider allows: no further refusal.
    expect(port.refusals).toBe(refusalsBefore);
  });
});

describe("one member on several devices (§1.7, item 6)", () => {
  it("a member's own device brings a new device up to date while the creator is away, permissions included", async () => {
    const port = new InMemoryMessengerPort();
    const options = { creatorMemberId: "alice", batchWindowMs: 0 };
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, options);
    const phone = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, options);
    await alice.setMembership("bob", "read");
    alice.edit((fragment) => insertPlainText(fragment, 0, "the creator's text"));
    await alice.flush();
    await alice.sync();
    await phone.sync();
    alice.dispose(); // the creator goes away

    const laptop = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, options);
    await phone.sync(); // bob's phone answers bob's laptop, as only another device of his may
    await laptop.sync();
    expect(laptop.hasCompletedBootstrap).toBe(true);
    expect(getPlainText(laptop.fragment)).toBe("the creator's text");
    expect(laptop.permissionOf("bob")).toBe("read");
    expect(laptop.mayEdit).toBe(false);
  });
});
