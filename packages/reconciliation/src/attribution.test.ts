import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { AttributionTracker, observePlainTextChanges } from "./attribution";
import {
  createDocument,
  ensureParagraph,
  getFragment,
  getPlainText,
  insertPlainText,
  transact,
} from "./index";

/**
 * Appends an empty paragraph to `fragment` and returns its `Y.XmlText`, for
 * tests that need a *second* paragraph — `insertPlainText`/`ensureParagraph`
 * only ever touch the first one (see their doc comments in `./index.ts`),
 * since real multi-paragraph editing goes through an editor. Mirrors what
 * `@tiptap/core`'s built-in `Enter` keymap (`commands.splitBlock()`)
 * produces at the Yjs level (verified, not assumed).
 */
function appendParagraph(fragment: Y.XmlFragment, text = ""): Y.XmlText {
  const element = new Y.XmlElement("paragraph");
  const xmlText = new Y.XmlText(text);
  element.insert(0, [xmlText]);
  fragment.insert(fragment.length, [element]);
  return xmlText;
}

describe("AttributionTracker", () => {
  it("attributes a single insert into an empty document", () => {
    const tracker = new AttributionTracker();
    tracker.recordInsert(0, 5, "alice");

    expect(tracker.ranges).toEqual([{ start: 0, end: 5, authorId: "alice" }]);
    expect(tracker.lastEditBySender.get("alice")).toBe(5);
  });

  it("merges adjacent inserts from the same author into one range", () => {
    const tracker = new AttributionTracker();
    tracker.recordInsert(0, 5, "alice"); // "hello"
    tracker.recordInsert(5, 6, "alice"); // "hello world"

    expect(tracker.ranges).toEqual([{ start: 0, end: 11, authorId: "alice" }]);
  });

  it("does not merge adjacent inserts from different authors", () => {
    const tracker = new AttributionTracker();
    tracker.recordInsert(0, 5, "alice"); // "hello"
    tracker.recordInsert(5, 6, "bob"); // "hello world"

    expect(tracker.ranges).toEqual([
      { start: 0, end: 5, authorId: "alice" },
      { start: 5, end: 11, authorId: "bob" },
    ]);
  });

  it("shifts a later range right when an earlier insert happens", () => {
    const tracker = new AttributionTracker();
    tracker.recordInsert(0, 5, "alice"); // "hello"
    tracker.recordInsert(0, 6, "bob"); // "world hello" — inserted before alice's range

    expect(tracker.ranges).toEqual([
      { start: 0, end: 6, authorId: "bob" },
      { start: 6, end: 11, authorId: "alice" },
    ]);
    // bob's insert must not have retroactively swallowed alice's range.
    // alice's last-edit marker must shift with her own text, exactly like
    // her range did above: a marker that never shifts silently goes stale
    // and gets re-resolved against whatever character now happens to sit at
    // the old index (the "wandering marker").
    expect(tracker.lastEditBySender.get("alice")).toBe(11);
    expect(tracker.lastEditBySender.get("bob")).toBe(6);
  });

  it("splits an existing range when another author inserts inside it", () => {
    const tracker = new AttributionTracker();
    tracker.recordInsert(0, 10, "alice"); // "helloworld"
    tracker.recordInsert(5, 3, "bob"); // "helloXXXworld"

    expect(tracker.ranges).toEqual([
      { start: 0, end: 5, authorId: "alice" },
      { start: 5, end: 8, authorId: "bob" },
      { start: 8, end: 13, authorId: "alice" },
    ]);
  });

  it("shrinks a range when a delete overlaps part of it", () => {
    const tracker = new AttributionTracker();
    tracker.recordInsert(0, 10, "alice"); // indices [0,10)
    tracker.recordDelete(7, 3, "alice"); // removes the last 3 chars

    expect(tracker.ranges).toEqual([{ start: 0, end: 7, authorId: "alice" }]);
    expect(tracker.lastEditBySender.get("alice")).toBe(7);
  });

  it("removes a range entirely once fully deleted", () => {
    const tracker = new AttributionTracker();
    tracker.recordInsert(0, 5, "alice");
    tracker.recordInsert(5, 5, "bob");
    tracker.recordDelete(0, 5, "carol"); // deletes exactly alice's range

    expect(tracker.ranges).toEqual([{ start: 0, end: 5, authorId: "bob" }]);
    expect(tracker.lastEditBySender.get("carol")).toBe(0);
  });

  it("shrinks and shifts multiple ranges spanned by one delete", () => {
    const tracker = new AttributionTracker();
    tracker.recordInsert(0, 5, "alice"); // alice [0,5)
    tracker.recordInsert(5, 5, "bob"); // bob [5,10)
    tracker.recordDelete(3, 4, "carol"); // removes [3,7): last 2 of alice's, first 2 of bob's

    expect(tracker.ranges).toEqual([
      { start: 0, end: 3, authorId: "alice" },
      { start: 3, end: 6, authorId: "bob" },
    ]);
  });

  it("shifts a later range left when an earlier delete happens", () => {
    const tracker = new AttributionTracker();
    tracker.recordInsert(0, 5, "alice"); // [0,5)
    tracker.recordInsert(5, 5, "bob"); // [5,10)
    tracker.recordDelete(0, 2, "alice"); // removes the first 2 chars of alice's own range

    expect(tracker.ranges).toEqual([
      { start: 0, end: 3, authorId: "alice" },
      { start: 3, end: 8, authorId: "bob" },
    ]);
  });

  it("leaves a range untouched by a delete entirely after it", () => {
    const tracker = new AttributionTracker();
    tracker.recordInsert(0, 5, "alice");
    tracker.recordInsert(5, 5, "bob");
    tracker.recordDelete(5, 5, "alice"); // deletes only bob's range

    expect(tracker.ranges).toEqual([{ start: 0, end: 5, authorId: "alice" }]);
  });

  it("tracks last-edit position per author independently", () => {
    const tracker = new AttributionTracker();
    tracker.recordInsert(0, 5, "alice"); // alice's marker = 5
    tracker.recordInsert(5, 3, "bob"); // inserted at alice's marker: shifts it to 8; bob's marker = 8
    tracker.recordDelete(0, 1, "alice"); // deletes index 0: bob's marker (8) shifts left to 7

    expect(tracker.lastEditBySender.get("alice")).toBe(0);
    // Used to read `.toBe(8)` — also encoded the "wandering marker" bug:
    // bob's marker must remap through alice's later delete just like his
    // range does, not stay frozen at the pre-delete value.
    expect(tracker.lastEditBySender.get("bob")).toBe(7);
  });

  it("shifts another author's last-edit position when an insert happens at or before it", () => {
    const tracker = new AttributionTracker();
    tracker.recordInsert(0, 5, "bob"); // "world", bob's marker = 5
    tracker.recordInsert(0, 6, "alice"); // "hello " inserted before bob's text

    expect(tracker.lastEditBySender.get("alice")).toBe(6);
    // bob's marker must move with his own text ("d", the last character of
    // "world"), not stay stale at 5 — which would now point into alice's
    // own text instead: an editor that maps the index with a plain
    // arithmetic walk, with no staleness check, would silently re-resolve
    // it to whatever character now happens to sit there.
    expect(tracker.lastEditBySender.get("bob")).toBe(11);
  });

  it("shifts another author's last-edit position when an insert happens exactly at it (boundary)", () => {
    const tracker = new AttributionTracker();
    tracker.recordInsert(0, 5, "bob"); // bob's marker = 5
    tracker.recordInsert(5, 3, "alice"); // insert exactly at bob's marker index

    // Matches #ranges' own `range.start >= index` convention: a marker
    // sitting exactly at the insertion point is treated as "after" the
    // inserted text.
    expect(tracker.lastEditBySender.get("bob")).toBe(8);
  });

  it("remaps another author's last-edit position when a delete happens before it", () => {
    const tracker = new AttributionTracker();
    tracker.recordInsert(0, 5, "alice");
    tracker.recordInsert(5, 5, "bob"); // bob's marker = 10
    tracker.recordDelete(0, 2, "alice");

    expect(tracker.lastEditBySender.get("bob")).toBe(8); // shifted left with the text
  });

  it("collapses another author's last-edit position to the deletion point when it falls inside the deleted span", () => {
    const tracker = new AttributionTracker();
    tracker.recordInsert(0, 5, "alice"); // alice's marker = 5
    tracker.recordDelete(2, 3, "bob"); // deletes [2,5), swallowing alice's marker

    expect(tracker.lastEditBySender.get("alice")).toBe(2);
  });

  it("an author's own repeated inserts are not double-shifted by their own prior last-edit position", () => {
    const tracker = new AttributionTracker();
    tracker.recordInsert(0, 5, "alice"); // marker = 5
    tracker.recordInsert(0, 3, "alice"); // inserts again, before her own prior position

    // Guards the fix's "skip the current author in the shift loop" design:
    // the fresh value is index + length = 0 + 3 = 3. Without the skip,
    // alice's own stale entry (5) would first shift to 5+3=8 via the loop
    // (since 5 >= 0), then get overwritten by the correct value of 3 anyway
    // — currently harmless because the `.set()` runs after the loop, but
    // the skip makes that ordering not load-bearing.
    expect(tracker.lastEditBySender.get("alice")).toBe(3);
  });

  describe("toJSON()/restore() (the resync-response attribution overlay)", () => {
    it("round-trips ranges and lastEditBySender through a JSON.stringify/parse cycle", () => {
      const original = new AttributionTracker();
      original.recordInsert(0, 5, "alice");
      original.recordInsert(5, 3, "bob");
      original.recordDelete(2, 1, "alice");

      const roundTripped = JSON.parse(JSON.stringify(original.toJSON()));
      const restored = new AttributionTracker();
      restored.restore(roundTripped);

      expect(restored.ranges).toEqual(original.ranges);
      expect(Object.fromEntries(restored.lastEditBySender)).toEqual(
        Object.fromEntries(original.lastEditBySender),
      );
    });

    it("restore() replaces state in place rather than needing a new instance", () => {
      const tracker = new AttributionTracker();
      tracker.recordInsert(0, 3, "alice");
      expect(tracker.ranges).toHaveLength(1);

      const other = new AttributionTracker();
      other.recordInsert(0, 10, "bob");
      tracker.restore(other.toJSON());

      // same object identity — a caller holding a reference to `tracker`
      // (e.g. an editor's rendering) sees the update without needing a new one.
      expect(tracker.ranges).toEqual(other.ranges);
      expect(tracker.ranges[0]?.authorId).toBe("bob");
    });

    it("restore() does not share array/object references with the snapshot it was given", () => {
      const source = new AttributionTracker();
      source.recordInsert(0, 5, "alice");
      const snapshot = source.toJSON();

      const restored = new AttributionTracker();
      restored.restore(snapshot);
      restored.recordInsert(5, 2, "bob");

      // mutating the restored tracker must not reach back into the
      // snapshot object it was constructed from.
      expect(snapshot.ranges).toHaveLength(1);
    });
  });
});

describe("observePlainTextChanges", () => {
  it("reports insert/delete events from a real Y.XmlFragment in the same index space insertPlainText/deletePlainText use", () => {
    const doc = createDocument();
    const fragment = getFragment(doc);
    ensureParagraph(fragment);

    const changes: Array<{ kind: string; index: number; length: number }> = [];
    const unsubscribe = observePlainTextChanges(fragment, (change) => changes.push(change));

    insertPlainText(fragment, 0, "hello");
    insertPlainText(fragment, 5, " world");

    expect(changes).toEqual([
      { kind: "insert", index: 0, length: 5 },
      { kind: "insert", index: 5, length: 6 },
    ]);

    unsubscribe();
  });

  it("feeds AttributionTracker end to end and matches the fragment's actual plain text", () => {
    const doc = createDocument();
    const fragment = getFragment(doc);
    ensureParagraph(fragment);

    const tracker = new AttributionTracker();
    const unsubscribe = observePlainTextChanges(fragment, (change) => {
      if (change.kind === "insert") {
        tracker.recordInsert(change.index, change.length, "alice");
      } else {
        tracker.recordDelete(change.index, change.length, "alice");
      }
    });

    insertPlainText(fragment, 0, "hello world");
    insertPlainText(fragment, 5, ",");

    expect(tracker.ranges).toEqual([{ start: 0, end: 12, authorId: "alice" }]);

    unsubscribe();
  });

  it("stops reporting after unsubscribe", () => {
    const doc = createDocument();
    const fragment = getFragment(doc);
    ensureParagraph(fragment);

    const changes: unknown[] = [];
    const unsubscribe = observePlainTextChanges(fragment, (change) => changes.push(change));
    unsubscribe();

    insertPlainText(fragment, 0, "hello");

    expect(changes).toEqual([]);
  });
});

// Real multi-paragraph editing (Enter/Backspace, via TipTap's built-in
// splitBlock keymap): the reason observePlainTextChanges diffs plain-text
// snapshots instead of walking each Y.XmlText's own delta (see its doc
// comment). Each case runs directly against a real Y.XmlFragment; see
// diffParagraphs' and computeHunks' doc comments in attribution.ts for the
// cases a simpler diff gets wrong.
describe("observePlainTextChanges: multi-paragraph structural changes", () => {
  it("attributes text typed into a newly created second paragraph at its correct global position", () => {
    const doc = createDocument();
    const fragment = getFragment(doc);
    ensureParagraph(fragment);

    const tracker = new AttributionTracker();
    const unsubscribe = observePlainTextChanges(fragment, (change) => {
      if (change.kind === "insert") {
        tracker.recordInsert(change.index, change.length, "alice");
      } else {
        tracker.recordDelete(change.index, change.length, "alice");
      }
    });

    // "hello" + Enter (an empty second paragraph, nothing moved into it) +
    // typing "world" one character at a time, matching how TipTap actually
    // drives Yjs — this exact sequence originally left "world" only
    // partially highlighted ("wo"), all attributed to alice, once the
    // second paragraph collided with the first one's own local indices.
    insertPlainText(fragment, 0, "hello");
    const second = appendParagraph(fragment);
    for (const ch of "world") {
      transact(doc, () => second.insert(second.length, ch));
    }

    expect(getPlainText(fragment)).toBe("hello\nworld");
    // One continuous range, "hello" through "world" — the second paragraph
    // was created *after* subscribing (matching a real Enter keypress), so
    // that structural change was itself observed and attributed to alice,
    // same as the characters either side of it. "world" is the important
    // part: all 5 characters, not just "wo" (the original bug).
    expect(tracker.ranges).toEqual([{ start: 0, end: 11, authorId: "alice" }]);

    unsubscribe();
  });

  it("preserves both authors' attribution when a paragraph is split between their text", () => {
    const doc = createDocument();
    const fragment = getFragment(doc);
    const text = firstText(fragment);

    let author = "alice";
    const tracker = new AttributionTracker();
    const unsubscribe = observePlainTextChanges(fragment, (change) => {
      if (change.kind === "insert") {
        tracker.recordInsert(change.index, change.length, author);
      } else {
        tracker.recordDelete(change.index, change.length, author);
      }
    });

    transact(doc, () => text.insert(0, "hello "));
    author = "bob";
    transact(doc, () => text.insert(text.length, "world"));
    expect(tracker.ranges).toEqual([
      { start: 0, end: 6, authorId: "alice" },
      { start: 6, end: 11, authorId: "bob" },
    ]);

    // alice presses Enter right at the boundary between her text and bob's.
    author = "alice";
    transact(doc, () => {
      text.delete(6, 5); // removes "world"
      const element = new Y.XmlElement("paragraph");
      element.insert(0, [new Y.XmlText("world")]);
      fragment.insert(1, [element]);
    });

    expect(getPlainText(fragment)).toBe("hello \nworld");
    // bob's "world" stays his, unshifted-content-wise, even though the
    // split was alice's action.
    expect(tracker.ranges).toEqual([
      { start: 0, end: 7, authorId: "alice" },
      { start: 7, end: 12, authorId: "bob" },
    ]);

    unsubscribe();
  });

  it("preserves both authors' attribution when two paragraphs are merged", () => {
    const doc = createDocument();
    const fragment = getFragment(doc);
    const text0 = firstText(fragment);
    const text1 = appendParagraph(fragment);

    let author = "alice";
    const tracker = new AttributionTracker();
    const unsubscribe = observePlainTextChanges(fragment, (change) => {
      if (change.kind === "insert") {
        tracker.recordInsert(change.index, change.length, author);
      } else {
        tracker.recordDelete(change.index, change.length, author);
      }
    });

    transact(doc, () => text0.insert(0, "hello "));
    author = "bob";
    transact(doc, () => text1.insert(0, "world"));

    // bob presses Backspace at the start of his paragraph, merging it into alice's.
    transact(doc, () => {
      text0.insert(text0.length, text1.toString());
      fragment.delete(1, 1);
    });

    expect(getPlainText(fragment)).toBe("hello world");
    expect(tracker.ranges).toEqual([
      { start: 0, end: 6, authorId: "alice" },
      { start: 6, end: 11, authorId: "bob" },
    ]);

    unsubscribe();
  });

  it("a batched transaction touching two non-adjacent paragraphs does not misattribute the untouched paragraph between them", () => {
    const doc = createDocument();
    const fragment = getFragment(doc);
    const text0 = firstText(fragment);
    const text1 = appendParagraph(fragment);
    const text2 = appendParagraph(fragment);

    let author = "alice";
    const tracker = new AttributionTracker();
    const unsubscribe = observePlainTextChanges(fragment, (change) => {
      if (change.kind === "insert") {
        tracker.recordInsert(change.index, change.length, author);
      } else {
        tracker.recordDelete(change.index, change.length, author);
      }
    });

    transact(doc, () => text0.insert(0, "first"));
    transact(doc, () => text1.insert(0, "middle"));
    transact(doc, () => text2.insert(0, "third"));

    // One transaction — the shape a merged/batched delivery produces
    // (SPECIFICATION.md §9) — touching paragraph 0
    // and paragraph 2, leaving paragraph 1 ("middle") untouched.
    author = "bob";
    transact(doc, () => {
      text0.insert(text0.length, "-X");
      text2.insert(text2.length, "-Y");
    });

    expect(getPlainText(fragment)).toBe("first-X\nmiddle\nthird-Y");
    // All three paragraphs were created *before* subscribing (only their
    // typed content is observed), so the "\n"s between them were never
    // themselves attributed and stay permanent gaps — unlike the previous
    // test. What matters here: "middle" ([8,14)) is untouched by bob's
    // edit and stays entirely alice's, not swept into his "-X"/"-Y" ranges
    // just for sitting between them.
    expect(tracker.ranges).toEqual([
      { start: 0, end: 5, authorId: "alice" }, // "first"
      { start: 5, end: 7, authorId: "bob" }, // "-X"
      { start: 8, end: 14, authorId: "alice" }, // "middle" — untouched, still alice's
      { start: 15, end: 20, authorId: "alice" }, // "third"
      { start: 20, end: 22, authorId: "bob" }, // "-Y"
    ]);

    unsubscribe();
  });

  it("removes only the deleted paragraph's own attribution when a whole paragraph is deleted from the middle", () => {
    const doc = createDocument();
    const fragment = getFragment(doc);
    const text0 = firstText(fragment);
    const text1 = appendParagraph(fragment);
    const text2 = appendParagraph(fragment);

    const tracker = new AttributionTracker();
    const unsubscribe = observePlainTextChanges(fragment, (change) => {
      if (change.kind === "insert") {
        tracker.recordInsert(change.index, change.length, "alice");
      } else {
        tracker.recordDelete(change.index, change.length, "alice");
      }
    });

    transact(doc, () => text0.insert(0, "first"));
    transact(doc, () => text1.insert(0, "middle"));
    transact(doc, () => text2.insert(0, "third"));

    transact(doc, () => fragment.delete(1, 1)); // remove the "middle" paragraph entirely

    expect(getPlainText(fragment)).toBe("first\nthird");
    // Gap at [5,6) — the "\n" that was already there before subscribing
    // (see the previous test's comment) — persists across the delete;
    // "third" lands exactly where "first"'s own paragraph boundary
    // already put it.
    expect(tracker.ranges).toEqual([
      { start: 0, end: 5, authorId: "alice" },
      { start: 6, end: 11, authorId: "alice" },
    ]);

    unsubscribe();
  });
});

/** The first (and, at the point these tests use it, only) paragraph's `Y.XmlText` — `ensureParagraph` plus one field access, so multi-paragraph tests can get a stable reference to keep mutating. */
function firstText(fragment: Y.XmlFragment): Y.XmlText {
  ensureParagraph(fragment);
  const element = fragment.get(0) as Y.XmlElement;
  return element.firstChild as Y.XmlText;
}

// The profile's schema has no formatting marks yet (no bold, no italic).
// Once one exists, Y.XmlText.toString() serializes marks as pseudo-XML tags
// (`text.format(0, 5, { bold: true })` on "hello world" makes `.toString()`
// return "<bold>hello</bold> world"), which would make a bold toggle look
// like 11 newly inserted characters to diffText and misattribute real text.
// paragraphTexts reads each Y.XmlText through `.toDelta()`, which separates
// `insert` from `attributes`; these tests keep it that way.
describe("observePlainTextChanges: formatting marks (forward-looking — no mark exists in the schema yet)", () => {
  it("a formatting-only change reports no plain-text change and does not corrupt attribution", () => {
    const doc = createDocument();
    const fragment = getFragment(doc);
    const text = firstText(fragment);

    const tracker = new AttributionTracker();
    const changes: unknown[] = [];
    const unsubscribe = observePlainTextChanges(fragment, (change) => {
      changes.push(change);
      if (change.kind === "insert") {
        tracker.recordInsert(change.index, change.length, "alice");
      } else {
        tracker.recordDelete(change.index, change.length, "alice");
      }
    });

    transact(doc, () => text.insert(0, "hello world"));
    expect(tracker.ranges).toEqual([{ start: 0, end: 11, authorId: "alice" }]);
    changes.length = 0;

    // Simulates what @tiptap/extension-bold's toggleBold() would do at the
    // Yjs level: format an existing range, inserting or deleting nothing.
    transact(doc, () => text.format(0, 5, { bold: true }));

    expect(getPlainText(fragment)).toBe("hello world"); // not "<bold>hello</bold> world"
    expect(changes).toEqual([]); // no spurious insert/delete
    expect(tracker.ranges).toEqual([{ start: 0, end: 11, authorId: "alice" }]); // unchanged

    unsubscribe();
  });
});
