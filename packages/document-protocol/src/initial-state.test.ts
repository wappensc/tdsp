import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import {
  type DeliveryId,
  type DocumentId,
  type MemberId,
  type MessengerPort,
  TransportSendError,
} from "@tdsp/messenger-port";
import { getPlainText } from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFrame } from "./framing";
import { DocumentEngine } from "./index";

/**
 * The initial state and the invitation (SND-20, LIF-9, LIF-5): where the creator's application sent
 * the invitation first, into a channel it made for the document, a failed send of the initial state
 * no longer fails the creation — those invited hold an invitation to this document — and the engine
 * sends the content again whole, as it sends restored content. Elsewhere it fails the creation.
 */

const DOCUMENT_ID = "doc-1";
const OPTIONS = { batchWindowMs: 0, resyncResponseThrottleMs: 0 };

/** The in-memory transport whose sends fail, as a messenger out of reach does, while `down`. */
class Flaky implements MessengerPort {
  readonly inner = new InMemoryMessengerPort();
  down = true;
  createDocument(documentId: DocumentId, creator: MemberId): Promise<void> {
    return this.inner.createDocument(documentId, creator);
  }
  async send(documentId: DocumentId, sender: MemberId, payload: string): Promise<DeliveryId> {
    if (this.down) throw new TransportSendError("unavailable", "out of reach");
    return this.inner.send(documentId, sender, payload);
  }
  receive(documentId: DocumentId, member: MemberId) {
    return this.inner.receive(documentId, member);
  }
  listChannels(member: MemberId) {
    return this.inner.listChannels(member);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-03T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the initial state when it cannot be sent (SND-20)", () => {
  it("without the invitation first, the creation fails", async () => {
    const port = new Flaky();
    await expect(
      DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, OPTIONS),
    ).rejects.toThrow(TransportSendError);
  });

  it("with the invitation first, the document is created, its content undistributed, and it goes out whole once it can, so a joiner gets it", async () => {
    const port = new Flaky();
    const errors: unknown[] = [];
    const alice = await DocumentEngine.create(
      DOCUMENT_ID,
      "alice",
      port,
      (error) => errors.push(error),
      {
        ...OPTIONS,
        invitedFirst: true,
      },
    );
    expect(alice.hasUndistributedChanges).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await port.inner.receive(DOCUMENT_ID, "observer")).toStrictEqual([]);

    port.down = false;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await alice.sync();
    await vi.advanceTimersByTimeAsync(60_000);
    const sent = (await port.inner.receive(DOCUMENT_ID, "observer")).map(
      (delivery) => decodeFrame(delivery.payload).kind,
    );
    expect(sent).toContain("edit");
    expect(alice.hasUndistributedChanges).toBe(false);
    expect(errors).toStrictEqual([]);
    await alice.setMembership("bob", "write");

    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, {
      ...OPTIONS,
      creatorMemberId: "alice",
    });
    for (let round = 0; round < 4; round++) {
      await alice.sync();
      await bob.sync();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(bob.hasCompletedBootstrap).toBe(true);
    expect(getPlainText(bob.fragment)).toBe(getPlainText(alice.fragment));
  });
});
