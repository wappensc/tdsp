import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applyUpdate,
  changedRoots,
  createDocument,
  deletePlainText,
  encodeDeletions,
  encodeDeletionsWithin,
  encodeStateVector,
  encodeUpdate,
  ensureParagraph,
  getFragment,
  getPlainText,
  insertPlainText,
  isStateVector,
  isUpdate,
  lacksUpdatesOf,
  observeUpdates,
  pendingGapClients,
  stateVectorHolds,
  updateClientIds,
} from "./index";
import { splitUpdate } from "./split";

describe("the top-level types a transaction changes", () => {
  it("names content, a layer, both, and a deletion in a nested type of a layer", () => {
    const doc = createDocument();
    insertPlainText(getFragment(doc), 0, "Plan");
    const seen: string[][] = [];
    observeUpdates(doc, (_update, _origin, transaction) =>
      seen.push([...changedRoots(doc, transaction)].sort()),
    );
    const comments = doc.getMap<unknown>("com.example.comments/1");
    insertPlainText(getFragment(doc), 4, " B");
    doc.transact(() => comments.set("c1", "one"));
    doc.transact(() => {
      insertPlainText(getFragment(doc), 4, "!");
      comments.set("c2", "two");
    });
    doc.transact(() => comments.delete("c1"));
    deletePlainText(getFragment(doc), 0, 1);
    expect(seen).toEqual([
      ["content"],
      ["com.example.comments/1"],
      ["com.example.comments/1", "content"],
      ["com.example.comments/1"],
      ["content"],
    ]);
  });
});

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

  it("a receiver that lost an insertion and holds only its deletion names the sender's client as the gap (Appendix A: pendingDs)", () => {
    const { writer, receiver, updates, type } = stream();
    type("one", 0); // lost
    deletePlainText(getFragment(writer), 1, 1); // an update that only deletes
    applyUpdate(receiver, updates[1] as Uint8Array);
    expect(receiver.store.pendingStructs).toBeNull();
    expect(pendingGapClients(receiver)).toEqual([writer.clientID]);
    applyUpdate(receiver, updates[0] as Uint8Array); // late, not lost
    expect(pendingGapClients(receiver)).toEqual([]);
    expect(getPlainText(getFragment(receiver))).toBe("oe");
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

  it("a state vector holds an update once it reaches the update's last item, and every one holds a deletion", () => {
    const { writer, receiver, updates, type } = stream();
    type("one", 0);
    type("two", 3);
    const [first, second] = updates as [Uint8Array, Uint8Array];
    applyUpdate(receiver, first);
    // What a heartbeat of the receiver would say: it holds the first edit, not the second.
    expect(stateVectorHolds(encodeStateVector(receiver), first)).toBe(true);
    expect(stateVectorHolds(encodeStateVector(receiver), second)).toBe(false);
    expect(stateVectorHolds(encodeStateVector(writer), second)).toBe(true);
    applyUpdate(receiver, second);
    expect(stateVectorHolds(encodeStateVector(receiver), second)).toBe(true);
    // A state vector counts no deletion, so an update that only deletes is held by any.
    deletePlainText(getFragment(writer), 0, 3);
    const deletion = updates[2] as Uint8Array;
    expect(updateClientIds(deletion)).toEqual([]);
    expect(stateVectorHolds(encodeStateVector(createDocument()), deletion)).toBe(true);
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

describe("content YJS-1 forbids, as a receiver applies and projects it (YJS-4)", () => {
  it("applies it, and projects every child of content by the text it holds directly, nothing beside content", () => {
    const writer = new Y.Doc();
    const content = writer.getXmlFragment("content");
    const paragraph = new Y.XmlElement("paragraph");
    const text = new Y.XmlText();
    paragraph.insert(0, [text]);
    const heading = new Y.XmlElement("heading");
    heading.setAttribute("level", "1");
    heading.insert(0, [new Y.XmlText("Title")]);
    const nesting = new Y.XmlElement("paragraph");
    const inner = new Y.XmlElement("span");
    inner.insert(0, [new Y.XmlText("nested")]);
    nesting.insert(0, [new Y.XmlText("a"), inner, new Y.XmlText("c")]);
    content.insert(0, [paragraph, heading, new Y.XmlText("loose"), nesting]);
    text.insert(0, "Hello world");
    text.format(0, 5, { bold: true });
    text.insertEmbed(5, { image: "x" });
    writer.getMap("notes").set("n", "beside");
    const reader = createDocument();
    applyUpdate(reader, Y.encodeStateAsUpdate(writer));
    expect(getPlainText(getFragment(reader))).toBe("Hello world\nTitle\nloose\nac");
  });
});

describe("reading CRDT bytes without applying them (PRF-1 items 1, 3 and 9, FRM-6)", () => {
  it("takes an update that reads to its end, and refuses one cut short in its delete set, one with a byte after it, empty bytes and noise", () => {
    const doc = createDocument();
    insertPlainText(getFragment(doc), 0, "Hello world");
    deletePlainText(getFragment(doc), 0, 6);
    const whole = encodeUpdate(doc);
    expect(isUpdate(whole)).toBe(true);
    expect(isUpdate(new Uint8Array([0, 0]))).toBe(true);
    expect(isUpdate(whole.slice(0, -1))).toBe(false);
    expect(isUpdate(new Uint8Array([...whole, 0]))).toBe(false);
    expect(isUpdate(new Uint8Array([0, 0, 0]))).toBe(false);
    expect(isUpdate(new Uint8Array(0))).toBe(false);
    expect(isUpdate(new Uint8Array([255, 255, 255, 255]))).toBe(false);
  });

  it("takes a state vector that reads to its last byte, and nothing shorter or longer", () => {
    const doc = createDocument();
    insertPlainText(getFragment(doc), 0, "one");
    const vector = encodeStateVector(doc);
    expect(isStateVector(vector)).toBe(true);
    expect(isStateVector(new Uint8Array([0]))).toBe(true);
    expect(isStateVector(vector.slice(0, -1))).toBe(false);
    expect(isStateVector(new Uint8Array([...vector, 0]))).toBe(false);
    expect(isStateVector(new Uint8Array([255, 255, 255, 255]))).toBe(false);
    expect(isStateVector(new Uint8Array(0))).toBe(false);
  });

  it("reads every update Yjs writes to its end: each kind of content, deletions, collected garbage, a merge with a gap, pieces", () => {
    const doc = new Y.Doc();
    const text = doc.getText("t");
    text.insert(0, "Grüße 😀 from here");
    text.insertEmbed(3, { image: "x" });
    text.format(0, 4, { bold: true });
    text.delete(2, 3);
    doc.getArray("list").insert(0, [{ n: 1 }, "two", 3, null, new Uint8Array([1, 2, 3])]);
    doc.getMap("map").set("sub", new Y.Doc());
    doc
      .getXmlFragment("content")
      .insert(0, [new Y.XmlElement("paragraph"), new Y.XmlText("plain")]);
    const before = Y.encodeStateVector(doc);
    text.insert(0, "later ");
    const gc = new Y.Doc();
    Y.applyUpdate(gc, Y.encodeStateAsUpdate(doc));
    gc.getText("t").delete(0, 6);
    // Two of three steps merged: Yjs writes a skip over the missing one.
    const steps: Uint8Array[] = [];
    const stepped = new Y.Doc();
    stepped.on("update", (update: Uint8Array) => steps.push(update));
    for (const letter of "abc") stepped.getText("t").insert(stepped.getText("t").length, letter);
    const updates = [
      Y.encodeStateAsUpdate(doc),
      Y.encodeStateAsUpdate(doc, before),
      Y.encodeStateAsUpdate(gc),
      Y.mergeUpdates([steps[0] as Uint8Array, steps[2] as Uint8Array]),
      ...splitUpdate(Y.encodeStateAsUpdate(doc), 200),
    ];
    for (const update of updates) {
      expect(isUpdate(update)).toBe(true);
      expect(isUpdate(new Uint8Array([...update, 0]))).toBe(false);
    }
  });
});

describe("what a replica deleted of the items a state vector counts (Appendix A, LOS-12)", () => {
  /** A replica of one client that typed `text` and deleted the characters at `deleted`. */
  function typed(
    client: number,
    text: string,
    deleted: readonly number[],
  ): ReturnType<typeof createDocument> {
    const doc = createDocument();
    doc.clientID = client;
    insertPlainText(getFragment(doc), 0, text);
    for (const index of [...deleted].sort((a, b) => b - a))
      deletePlainText(getFragment(doc), index, 1);
    return doc;
  }

  it("is the whole encoding within the replica's own state vector, also for many clients and long ranges", () => {
    const doc = typed(7, "abcdefghij".repeat(30), [1, 2, 3, 50, 299]);
    const other = typed(300_000, "xyz".repeat(100), [0, 150]);
    applyUpdate(doc, encodeUpdate(other));
    deletePlainText(getFragment(doc), 10, 40);
    expect(encodeDeletionsWithin(doc, encodeStateVector(doc))).toEqual(encodeDeletions(doc));
  });

  it("is the two bytes 00 00 within the empty state vector, and for a replica that deleted nothing", () => {
    expect(encodeDeletionsWithin(typed(1, "abc", [1]), Uint8Array.of(0))).toEqual(
      Uint8Array.of(0, 0),
    );
    expect(
      encodeDeletionsWithin(typed(1, "abc", []), encodeStateVector(typed(1, "abc", []))),
    ).toEqual(Uint8Array.of(0, 0));
  });

  it("leaves out deletions of items the state vector does not count, cutting a range where it ends", () => {
    const sender = typed(5, "abc", [1]); // holds "ac"
    const receiver = createDocument();
    receiver.clientID = 6;
    applyUpdate(receiver, encodeUpdate(sender));
    insertPlainText(getFragment(receiver), 2, "!!"); // and more of its own
    deletePlainText(getFragment(receiver), 2, 2); // which it deleted again
    // Within the sender's vector the receiver deleted what the sender did, and nothing else.
    expect(encodeDeletionsWithin(receiver, encodeStateVector(sender))).toEqual(
      encodeDeletions(sender),
    );
    expect(encodeDeletions(receiver)).not.toEqual(encodeDeletions(sender));
  });

  it("shows a deletion the receiver lacks, and one of its own within the vector, by other bytes", () => {
    const sender = typed(5, "abc", [1]); // "ac"
    const behind = createDocument();
    applyUpdate(behind, encodeUpdate(typed(5, "abc", [])));
    insertPlainText(getFragment(behind), 0, "!"); // more, but not the deletion of "b"
    expect(encodeDeletionsWithin(behind, encodeStateVector(sender))).not.toEqual(
      encodeDeletions(sender),
    );

    const own = createDocument();
    applyUpdate(own, encodeUpdate(sender));
    deletePlainText(getFragment(own), 0, 1); // a deletion of its own, within the sender's vector
    expect(encodeDeletionsWithin(own, encodeStateVector(sender))).not.toEqual(
      encodeDeletions(sender),
    );
  });

  it("is the same whatever order the updates arrived in", () => {
    const writer = createDocument();
    writer.clientID = 9;
    const updates: Uint8Array[] = [];
    observeUpdates(writer, (update) => updates.push(update));
    insertPlainText(getFragment(writer), 0, "hello world");
    deletePlainText(getFragment(writer), 2, 3);
    insertPlainText(getFragment(writer), 0, ">> ");
    deletePlainText(getFragment(writer), 0, 1);
    const vector = encodeStateVector(writer);
    const forwards = createDocument();
    for (const update of updates) applyUpdate(forwards, update);
    const backwards = createDocument();
    for (const update of [...updates].reverse()) applyUpdate(backwards, update);
    expect(encodeDeletionsWithin(backwards, vector)).toEqual(
      encodeDeletionsWithin(forwards, vector),
    );
    expect(encodeDeletionsWithin(forwards, vector)).toEqual(encodeDeletions(writer));
  });
});
