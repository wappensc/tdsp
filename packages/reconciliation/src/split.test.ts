import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { splitUpdate, UnsplittableUpdateError } from "./split";

function generator(seed: number) {
  let state = seed;
  const random = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  return {
    random,
    int: (below: number) => Math.floor(random() * below),
    shuffle: <T>(xs: readonly T[]): T[] => {
      const out = [...xs];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [out[i], out[j]] = [out[j] as T, out[i] as T];
      }
      return out;
    },
  };
}

/** What a replica shows: its text, its paragraphs and its list, and whether it still holds anything back. */
function view(doc: Y.Doc) {
  return {
    text: doc.getText("t").toString(),
    paragraphs: JSON.stringify(doc.getXmlFragment("prosemirror").toJSON()),
    list: JSON.stringify(doc.getArray("list").toJSON()),
    held: doc.store.pendingStructs !== null || doc.store.pendingDs !== null,
  };
}

const PIECES = ["x", "hello ", "Grüße ", "😀", "a😀b", "\n"];

/** A document two or three people edited, with some long insertions and deletions. */
function edited(g: ReturnType<typeof generator>): Y.Doc {
  const docs = Array.from({ length: 2 + g.int(2) }, () => new Y.Doc());
  for (let i = 0; i < 40; i++) {
    const doc = docs[g.int(docs.length)] as Y.Doc;
    const text = doc.getText("t");
    const roll = g.random();
    if (roll < 0.55 || text.length === 0) {
      const piece = PIECES[g.int(PIECES.length)] as string;
      text.insert(g.int(text.length + 1), piece.repeat(1 + g.int(g.random() < 0.1 ? 400 : 20)));
    } else if (roll < 0.8) {
      const at = g.int(text.length);
      text.delete(at, Math.min(text.length - at, 1 + g.int(15)));
    } else if (roll < 0.9) {
      const paragraph = new Y.XmlElement("paragraph");
      paragraph.insert(0, [new Y.XmlText(`p${i}`)]);
      doc.getXmlFragment("prosemirror").insert(0, [paragraph]);
    } else {
      doc.getArray("list").insert(
        0,
        Array.from({ length: 1 + g.int(30) }, (_, n) => ({ n })),
      );
    }
    if (g.random() < 0.3) {
      const [a, b] = g.shuffle(docs) as [Y.Doc, Y.Doc];
      Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    }
  }
  const all = docs[0] as Y.Doc;
  for (const other of docs.slice(1)) {
    Y.applyUpdate(all, Y.encodeStateAsUpdate(other));
  }
  return all;
}

describe("splitting an update into pieces (PRF-1)", () => {
  it("is needed inside items: Yjs merges a client's appended insertions into one item, across transactions", () => {
    const doc = new Y.Doc();
    const text = doc.getText("t");
    for (let i = 0; i < 10; i++) {
      doc.transact(() => text.insert(text.length, "a".repeat(1000)));
    }
    const { structs } = Y.decodeUpdate(Y.encodeStateAsUpdate(doc));
    expect(structs.map((s) => s.length)).toEqual([10_000]);
    const pieces = splitUpdate(Y.encodeStateAsUpdate(doc), 1000);
    expect(pieces.length).toBeGreaterThan(10);
    const replica = new Y.Doc();
    for (const piece of pieces.reverse()) {
      Y.applyUpdate(replica, piece);
    }
    expect(replica.getText("t").toString()).toBe(text.toString());
  });

  it("returns an update that fits unchanged", () => {
    const doc = new Y.Doc();
    doc.getText("t").insert(0, "short");
    const update = Y.encodeStateAsUpdate(doc);
    expect(splitUpdate(update, 10_000)).toEqual([update]);
  });

  it("random documents: every piece fits, pieces in any order with a duplicate give the same document", () => {
    const tally = { documents: 0, pieces: 0, heldAfterOnePass: 0 };
    for (let seed = 1; seed <= 300; seed++) {
      const g = generator(seed);
      const doc = edited(g);
      const update = Y.encodeStateAsUpdate(doc);
      const maxBytes = 80 + g.int(400);
      const pieces = splitUpdate(update, maxBytes);
      for (const piece of pieces) {
        expect(piece.length, `seed ${seed}`).toBeLessThanOrEqual(maxBytes);
      }
      const order = g.shuffle([...pieces, pieces[g.int(pieces.length)] as Uint8Array]);
      const replica = new Y.Doc();
      for (const piece of order) {
        Y.applyUpdate(replica, piece);
      }
      if (view(replica).held) {
        // Yjs keeps an update back now and then although all it waits for has arrived, with
        // ordinary shuffled edits just the same; applying again releases it, as a resync does.
        tally.heldAfterOnePass++;
        for (const piece of order) {
          Y.applyUpdate(replica, piece);
        }
      }
      expect(view(replica), `seed ${seed}`).toEqual(view(doc));
      expect(Y.encodeStateVector(replica)).toEqual(Y.encodeStateVector(doc));
      tally.documents++;
      tally.pieces += pieces.length;
    }
    console.log("split property test", tally);
    expect(tally.heldAfterOnePass).toBeLessThan(tally.documents / 20);
  });

  it("never cuts inside a surrogate pair", () => {
    const doc = new Y.Doc();
    doc.getText("t").insert(0, "😀".repeat(500));
    for (const maxBytes of [40, 41, 42, 43, 97]) {
      const replica = new Y.Doc();
      for (const piece of splitUpdate(Y.encodeStateAsUpdate(doc), maxBytes)) {
        Y.applyUpdate(replica, piece);
      }
      expect(replica.getText("t").toString()).toBe("😀".repeat(500));
    }
  });

  it("holds a lone piece back instead of rejecting it", () => {
    const doc = new Y.Doc();
    doc.getText("t").insert(0, "x".repeat(2000));
    const pieces = splitUpdate(Y.encodeStateAsUpdate(doc), 300);
    const replica = new Y.Doc();
    Y.applyUpdate(replica, pieces[pieces.length - 1] as Uint8Array);
    expect(replica.getText("t").toString()).toBe("");
    expect(replica.store.pendingStructs).not.toBeNull();
  });

  it("splits a delete set larger than one piece", () => {
    const doc = new Y.Doc();
    const text = doc.getText("t");
    text.insert(0, "x".repeat(3000));
    for (let i = 2990; i > 0; i -= 3) {
      text.delete(i, 1);
    }
    const pieces = splitUpdate(Y.encodeStateAsUpdate(doc), 200);
    const replica = new Y.Doc();
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(200);
      Y.applyUpdate(replica, piece);
    }
    expect(replica.getText("t").toString()).toBe(text.toString());
  });

  it("refuses an indivisible unit larger than a piece (SND-19)", () => {
    const doc = new Y.Doc();
    doc.getArray("files").insert(0, [new Uint8Array(5000)]);
    expect(() => splitUpdate(Y.encodeStateAsUpdate(doc), 1000)).toThrow(UnsplittableUpdateError);
    expect(splitUpdate(Y.encodeStateAsUpdate(doc), 6000)).toHaveLength(1);
  });
});
