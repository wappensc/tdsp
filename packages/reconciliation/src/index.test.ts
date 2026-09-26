import { describe, expect, it } from "vitest";
import {
  applyUpdate,
  createDocument,
  encodeStateVector,
  encodeUpdate,
  ensureParagraph,
  getFragment,
  getPlainText,
  insertPlainText,
  lacksUpdatesOf,
  observeUpdates,
  pendingGapClients,
  updateClientIds,
} from "./index";

describe("reconciliation convergence", () => {
  it("converges two documents that exchange updates out of order and twice", () => {
    const alice = createDocument();

    // Seed the paragraph on one document and sync it to the other first —
    // Y.XmlElement creation is a discrete CRDT operation, so two
    // independently created "first paragraphs" would not merge into one
    // the way Y.Text characters at the same position do (see
    // DocumentEngine.create()'s doc comment in @tdsp/document-protocol).
    ensureParagraph(getFragment(alice));
    const seed = encodeUpdate(alice);

    const bob = createDocument();
    applyUpdate(bob, seed);

    insertPlainText(getFragment(alice), 0, "hello ");
    insertPlainText(getFragment(bob), 0, "world");

    const aliceUpdate = encodeUpdate(alice);
    const bobUpdate = encodeUpdate(bob);

    // Apply out of order and with a duplicate, to prove convergence
    // tolerates reordering and duplicate delivery without extra
    // bookkeeping (SPECIFICATION.md §3.3).
    applyUpdate(bob, aliceUpdate);
    applyUpdate(alice, bobUpdate);
    applyUpdate(alice, bobUpdate);
    applyUpdate(bob, aliceUpdate);

    expect(getPlainText(getFragment(alice))).toBe(getPlainText(getFragment(bob)));
  });
});

/**
 * The three helpers loss detection (SPECIFICATION.md §10) stands on, each checked against the
 * situation it exists for — a receiver that lost one message of a stream — with real
 * documents rather than by reading the Yjs source.
 */
describe("noticing that something is missing", () => {
  /** A writer whose every update is captured, and a receiver seeded with the same paragraph. */
  function stream() {
    const writer = createDocument();
    ensureParagraph(getFragment(writer));
    const seed = encodeUpdate(writer);
    const updates: Uint8Array[] = [];
    observeUpdates(writer, (update) => updates.push(update));
    const receiver = createDocument();
    applyUpdate(receiver, seed);
    const type = (text: string, at: number) => insertPlainText(getFragment(writer), at, text);
    return { writer, receiver, updates, type };
  }

  it("a caught-up receiver lacks nothing of the sender's, and is not waiting on anything", () => {
    const { writer, receiver, updates, type } = stream();
    type("one", 0);
    type("two", 3);
    for (const update of updates) {
      applyUpdate(receiver, update);
    }
    expect(lacksUpdatesOf(receiver, encodeStateVector(writer))).toBe(false);
    expect(pendingGapClients(receiver)).toEqual([]);
  });

  it("a receiver that lost the LAST update lacks it, with no gap to notice — the case only a heartbeat catches", () => {
    const { writer, receiver, updates, type } = stream();
    type("one", 0);
    type("two", 3);
    applyUpdate(receiver, updates[0] as Uint8Array); // the second is lost
    expect(pendingGapClients(receiver)).toEqual([]); // nothing later arrived, so nothing looks wrong
    expect(lacksUpdatesOf(receiver, encodeStateVector(writer))).toBe(true);
  });

  it("a receiver that lost a MIDDLE update names the sender's client id as the gap, and lacks the sender's state", () => {
    const { writer, receiver, updates, type } = stream();
    type("one", 0);
    type("two", 3);
    type("three", 6);
    applyUpdate(receiver, updates[0] as Uint8Array);
    applyUpdate(receiver, updates[2] as Uint8Array); // the second is lost; the third waits, pending
    expect(pendingGapClients(receiver)).toEqual([writer.clientID]);
    // Held-pending is not applied: the receiver's clock for the sender is behind, so the heartbeat sees it too.
    expect(lacksUpdatesOf(receiver, encodeStateVector(writer))).toBe(true);
  });

  it("the gap closes when the late predecessor arrives, and the receiver is no longer behind", () => {
    const { writer, receiver, updates, type } = stream();
    type("one", 0);
    type("two", 3);
    type("three", 6);
    applyUpdate(receiver, updates[0] as Uint8Array);
    applyUpdate(receiver, updates[2] as Uint8Array);
    applyUpdate(receiver, updates[1] as Uint8Array); // late, not lost
    expect(pendingGapClients(receiver)).toEqual([]);
    expect(lacksUpdatesOf(receiver, encodeStateVector(writer))).toBe(false);
  });

  it("a receiver is not 'behind' a sender that knows less than it does", () => {
    const { writer, receiver, updates, type } = stream();
    type("one", 0);
    for (const update of updates) {
      applyUpdate(receiver, update);
    }
    insertPlainText(getFragment(receiver), 3, " and more"); // the receiver is ahead
    expect(lacksUpdatesOf(receiver, encodeStateVector(writer))).toBe(false);
  });

  it("rejects bytes that are not a state vector rather than guessing", () => {
    expect(() =>
      lacksUpdatesOf(createDocument(), new Uint8Array([255, 255, 255, 255, 255])),
    ).toThrow();
  });

  it("updateClientIds names the one client that authored an update, so a client id can be tied to a sender", () => {
    const { writer, updates, type } = stream();
    type("one", 0);
    expect(updateClientIds(updates[0] as Uint8Array)).toEqual([writer.clientID]);
  });

  it("updateClientIds names every author of a full-state update, which is why such a frame teaches no mapping", () => {
    const a = createDocument();
    ensureParagraph(getFragment(a));
    const b = createDocument();
    applyUpdate(b, encodeUpdate(a));
    insertPlainText(getFragment(a), 0, "from a");
    insertPlainText(getFragment(b), 0, "from b");
    applyUpdate(a, encodeUpdate(b));
    expect(updateClientIds(encodeUpdate(a)).length).toBeGreaterThan(1);
  });
});
