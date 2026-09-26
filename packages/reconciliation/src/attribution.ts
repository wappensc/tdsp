import * as Y from "yjs";

// Y.XmlFragment directly, not the `ReconciledFragment` alias from
// `./index` — importing from the sibling that re-exports this file would
// make the two modules circularly dependent (dependency-cruiser's
// no-circular rule). This file is itself part of the reconciliation
// module, same standing as index.ts to use `yjs` directly.
type Fragment = Y.XmlFragment;

/**
 * Attribution: derives per-author text ranges and a "last edit location" per author from Yjs
 * change events, not from any transport capability (SPECIFICATION.md §5.4, ATR-1 to ATR-3).
 * `document-protocol` correlates each observed change with the `Delivery.sender` that caused
 * it; this module only does the range bookkeeping and stays `MessengerPort`-unaware (author
 * identifiers are a generic `string`, not `MemberId`).
 */

export type PlainTextChange =
  | { readonly kind: "insert"; readonly index: number; readonly length: number }
  | { readonly kind: "delete"; readonly index: number; readonly length: number };

/**
 * Each node's own text content, in fragment order: a `Y.XmlText` node
 * contributes its own string; a `Y.XmlElement` (a paragraph — or, should
 * the schema ever grow a `<heading>` or other block tag, any of those too,
 * generically — nothing here looks at the tag name) contributes the
 * concatenated text of its own `Y.XmlText` children. `getPlainText`
 * (`./index.ts`) joins this with `"\n"` for callers that just want one
 * string; `observePlainTextChanges` below keeps the array un-joined so it
 * can tell which paragraph a change actually landed in.
 *
 * **Reads each `Y.XmlText` via `.toDelta().map(op => op.insert).join("")`, not the shorter
 * `.toString()`**: the two stop agreeing the moment a formatting mark exists on any
 * character. `Y.XmlText.toString()` serializes marks as pseudo-XML tags
 * (`text.format(0, 5, { bold: true })` on `"hello world"` gives
 * `"<bold>hello</bold> world"`), which would read as newly inserted characters to `diffText`
 * below and corrupt attribution. `.toDelta()`'s ops carry marks in an `attributes` field this
 * function ignores, so concatenating `.insert` stays plain text whatever marks exist. The
 * profile's schema has no marks today; this keeps attribution correct if one is added.
 */
export function paragraphTexts(fragment: Fragment): string[] {
  const paragraphs: string[] = [];
  for (const node of fragment.toArray()) {
    if (node instanceof Y.XmlText) {
      paragraphs.push(plainText(node));
    } else if (node instanceof Y.XmlElement) {
      let text = "";
      for (const child of node.toArray()) {
        if (child instanceof Y.XmlText) {
          text += plainText(child);
        }
      }
      paragraphs.push(text);
    }
  }
  return paragraphs;
}

function plainText(xmlText: Y.XmlText): string {
  let text = "";
  for (const op of xmlText.toDelta()) {
    if (typeof op.insert === "string") {
      text += op.insert;
    }
  }
  return text;
}

/**
 * The smallest region of `oldText`/`newText` that actually differs — the
 * longest common prefix and (non-overlapping) longest common suffix bound
 * a "changed middle" — reported as an optional delete followed by an
 * optional insert, both anchored `offset` characters into the caller's own
 * index space. A plain character comparison, not a general edit-distance
 * algorithm: correct for *any* single contiguous replacement (a keystroke,
 * a paste, a selection delete, and a paragraph split/merge alike, once
 * `diffParagraphs` below has bounded which paragraphs are actually
 * involved), and — importantly — reports *no* change when the two strings
 * are identical. That last property matters beyond just "no-op transaction
 * = no events": it means a formatting-only change (bold/italic, text-align
 * — a Yjs attribute/format op on existing characters, not an insert or
 * delete) automatically produces zero attribution events too, with no
 * special-casing needed here, because it never touches this function's
 * *inputs* — **provided those inputs really are plain text**, which is
 * `paragraphTexts`' contract to uphold, not this function's; see its doc
 * comment for the one piece of groundwork that took (reading via
 * `.toDelta()`, not `Y.XmlText.toString()`, which serializes marks as
 * pseudo-XML tags once any exist). A delta-op-walking implementation would
 * need a new branch for every new Yjs op shape a schema addition might
 * introduce; this one only ever needs to know what
 * the plain text looked like before and after.
 */
function diffText(oldText: string, newText: string, offset: number): PlainTextChange[] {
  const maxPrefix = Math.min(oldText.length, newText.length);
  let prefixLen = 0;
  while (prefixLen < maxPrefix && oldText[prefixLen] === newText[prefixLen]) {
    prefixLen++;
  }
  const maxSuffix = Math.min(oldText.length, newText.length) - prefixLen;
  let suffixLen = 0;
  while (
    suffixLen < maxSuffix &&
    oldText[oldText.length - 1 - suffixLen] === newText[newText.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const changes: PlainTextChange[] = [];
  const deleteLength = oldText.length - prefixLen - suffixLen;
  if (deleteLength > 0) {
    changes.push({ kind: "delete", index: offset + prefixLen, length: deleteLength });
  }
  const insertText = newText.slice(prefixLen, newText.length - suffixLen);
  if (insertText.length > 0) {
    changes.push({ kind: "insert", index: offset + prefixLen, length: insertText.length });
  }
  return changes;
}

/** One maximally-merged run of either "this paragraph is identical on both sides" or "these paragraphs differ", from `computeHunks` below. */
interface ParagraphHunk {
  readonly equal: boolean;
  readonly oldParagraphs: readonly string[];
  readonly newParagraphs: readonly string[];
}

/**
 * Aligns `oldParagraphs` and `newParagraphs` via longest-common-subsequence
 * (paragraphs compared as atomic strings, not characters), producing an
 * alternating sequence of "equal" (one identical paragraph on both sides)
 * and "changed" (a maximal run of paragraphs that differ) hunks.
 *
 * **A longest-common-prefix/suffix trim is not enough.** One batched change can edit two
 * *non-adjacent* paragraphs (paragraph 0 and paragraph 2 of three, paragraph 1 untouched) —
 * a routine case, since the send scheduler merges consecutive edits into one message.
 * Trimming only from the two outside ends stops at 0 on both sides, sweeps the untouched
 * paragraph 1 into the "changed middle", and `diffText` then reattributes its content to
 * whoever made the other edits. A full LCS recognizes a paragraph as unchanged however many
 * changed paragraphs surround it.
 */
function computeHunks(
  oldParagraphs: readonly string[],
  newParagraphs: readonly string[],
): ParagraphHunk[] {
  const n = oldParagraphs.length;
  const m = newParagraphs.length;
  // dp[i][j] = length of the LCS of oldParagraphs[i:] and newParagraphs[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const dpRowI = dp[i];
      const dpRowI1 = dp[i + 1];
      if (!dpRowI || !dpRowI1) {
        continue; // unreachable: i, i+1 <= n, both rows always exist
      }
      dpRowI[j] =
        oldParagraphs[i] === newParagraphs[j]
          ? (dpRowI1[j + 1] ?? 0) + 1
          : Math.max(dpRowI1[j] ?? 0, dpRowI[j + 1] ?? 0);
    }
  }

  const hunks: ParagraphHunk[] = [];
  let pendingOld: string[] = [];
  let pendingNew: string[] = [];
  const flushPending = () => {
    if (pendingOld.length > 0 || pendingNew.length > 0) {
      hunks.push({ equal: false, oldParagraphs: pendingOld, newParagraphs: pendingNew });
      pendingOld = [];
      pendingNew = [];
    }
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const oldParagraph = oldParagraphs[i];
    const newParagraph = newParagraphs[j];
    if (oldParagraph === newParagraph) {
      flushPending();
      hunks.push({
        equal: true,
        oldParagraphs: [oldParagraph ?? ""],
        newParagraphs: [newParagraph ?? ""],
      });
      i++;
      j++;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      pendingOld.push(oldParagraph ?? "");
      i++;
    } else {
      pendingNew.push(newParagraph ?? "");
      j++;
    }
  }
  while (i < n) {
    pendingOld.push(oldParagraphs[i] ?? "");
    i++;
  }
  while (j < m) {
    pendingNew.push(newParagraphs[j] ?? "");
    j++;
  }
  flushPending();
  return hunks;
}

/**
 * Turns `computeHunks`' alignment into `PlainTextChange`s in flat index
 * space, one `diffText` call per "changed" hunk, walking a running `offset`
 * that an "equal" hunk advances by its own length plus one (the `"\n"` join
 * to whatever follows).
 *
 * **Each changed hunk borrows one paragraph of context from its neighbours.** Without it, a
 * hunk with zero old paragraphs and one new one (a paragraph inserted, say by pressing Enter
 * at the end of a paragraph) reports the new paragraph's text but not the extra `"\n"` the
 * document gained, so the paragraph after it lands one position early. The borrowed
 * paragraph is identical on both sides by construction, so `diffText`'s prefix/suffix
 * matching trims it back out — but only after walking across the `"\n"` in between, which a
 * hunk with an empty side has no other way to see. The neighbour is only *read* for context,
 * never removed from the hunk list, so its own turn through the loop still only advances
 * `offset`.
 *
 * One consequence: a new paragraph's inserted range includes the `"\n"` boundary after it,
 * attributed to whoever created the paragraph — who did cause that boundary. It causes no
 * visible over-highlighting in an editor: that flat index maps to the *start* of the next
 * paragraph's content, and an editor that clips decorations to each block's text (as
 * ProseMirror does) draws a zero-width overlap.
 */
function diffParagraphs(
  oldParagraphs: readonly string[],
  newParagraphs: readonly string[],
): PlainTextChange[] {
  const hunks = computeHunks(oldParagraphs, newParagraphs);
  const changes: PlainTextChange[] = [];
  let offset = 0;
  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i];
    if (!hunk) {
      continue; // unreachable: i < hunks.length
    }
    if (hunk.equal) {
      offset += (hunk.newParagraphs[0]?.length ?? 0) + 1;
      continue;
    }

    const prev = hunks[i - 1];
    const next = hunks[i + 1];
    let regionOffset = offset;
    let oldParas = hunk.oldParagraphs;
    let newParas = hunk.newParagraphs;
    if (prev) {
      regionOffset -= (prev.newParagraphs[0]?.length ?? 0) + 1;
      oldParas = [prev.oldParagraphs[0] ?? "", ...oldParas];
      newParas = [prev.newParagraphs[0] ?? "", ...newParas];
    }
    if (next) {
      oldParas = [...oldParas, next.oldParagraphs[0] ?? ""];
      newParas = [...newParas, next.newParagraphs[0] ?? ""];
    }

    changes.push(...diffText(oldParas.join("\n"), newParas.join("\n"), regionOffset));
    offset += hunk.newParagraphs.join("\n").length + (hunk.newParagraphs.length > 0 ? 1 : 0);
  }
  return changes;
}

/**
 * Subscribes to structured plain-text insert/delete events in the same flat
 * index space `getPlainText`/`insertPlainText`/`deletePlainText` use.
 * Feeds `AttributionTracker`. Returns an unsubscribe function.
 *
 * **How**: keep the previous call's `paragraphTexts(fragment)` snapshot; on every
 * `observeDeep` firing, take a new snapshot and diff the two (`diffParagraphs` → `diffText`,
 * both above) purely as plain text, never through Yjs's own delta shape. Yjs change events
 * carry a delta per `Y.XmlText`, whose indices are local to that paragraph; walking them
 * directly reports a character typed into a second paragraph at *its* local index, which
 * collides with the first paragraph's ranges in the one flat index space. Diffing snapshots
 * bounds itself to whichever paragraphs changed, anchored in the *current* structure, however
 * many paragraphs exist and however they came about (typing, a split, a merge, or a remote
 * update replaying any of those). It also needs no change for schema growth: see `diffText`
 * on why a formatting-only mark produces no attribution events, and `paragraphTexts` on why a
 * new block tag needs no new branch.
 *
 * Two properties callers rely on: a duplicate or no-op `Y.applyUpdate` (already-applied
 * content) does not fire the observer at all, so a caller correlating a "current sender" with
 * the next observer firing (`DocumentEngine.sync()`) need not guard against a stray empty
 * firing; and this stays a thin, `MessengerPort`-unaware layer over Yjs.
 */
export function observePlainTextChanges(
  fragment: Fragment,
  listener: (change: PlainTextChange) => void,
): () => void {
  let previous = paragraphTexts(fragment);
  const wrapped = () => {
    const current = paragraphTexts(fragment);
    for (const change of diffParagraphs(previous, current)) {
      listener(change);
    }
    previous = current;
  };
  fragment.observeDeep(wrapped);
  return () => fragment.unobserveDeep(wrapped);
}

/** A contiguous, half-open `[start, end)` span of the plain-text projection attributed to one author. */
export interface AttributionRange {
  readonly start: number;
  readonly end: number;
  readonly authorId: string;
}

/**
 * Tracks per-author text ranges and each author's last edit position over
 * a document's plain-text projection, fed by `recordInsert`/`recordDelete`
 * calls in the same order and index space the underlying edits happened in
 * (see `observePlainTextChanges`). Yjs/CRDT-adjacent (works in terms of
 * plain-text offsets produced by Yjs delta events) but deliberately
 * `MessengerPort`-unaware: `authorId` is a generic `string`, not
 * `@tdsp/messenger-port`'s `MemberId`, preserving this package's
 * dependency boundary.
 */
/**
 * Serialized form of an `AttributionTracker`'s state — the wire shape
 * carried in a `resync-response` frame's attribution overlay
 * (SPECIFICATION.md §5.4).
 * `lastEditBySender` is a plain object, not a `Map`, since `Map` does not
 * survive `JSON.stringify`/`JSON.parse` round-trips.
 */
export interface AttributionSnapshot {
  readonly ranges: readonly AttributionRange[];
  readonly lastEditBySender: Readonly<Record<string, number>>;
}

export class AttributionTracker {
  #ranges: AttributionRange[] = [];
  #lastEditBySender = new Map<string, number>();

  /** Current attribution ranges, ordered by `start`. */
  get ranges(): readonly AttributionRange[] {
    return this.#ranges;
  }

  /** Each author's most recent edit position — an approximate "where to look for their last change" indicator. */
  get lastEditBySender(): ReadonlyMap<string, number> {
    return this.#lastEditBySender;
  }

  /** Serializes current state for transport — see `AttributionSnapshot`. */
  toJSON(): AttributionSnapshot {
    return {
      ranges: this.#ranges.map((range) => ({ ...range })),
      lastEditBySender: Object.fromEntries(this.#lastEditBySender),
    };
  }

  /**
   * Replaces this tracker's entire state with `snapshot`, in place —
   * an instance method rather than a static constructor because
   * `DocumentEngine.attribution` is a `readonly` field callers already
   * hold a reference to (e.g. an editor's rendering); replacing
   * the object itself would silently detach any such reference. Used
   * only for a true bootstrap's wholesale overlay adoption
   * (SPECIFICATION.md §5.4, RSY-15) — never for a partial
   * gap-heal, which does not carry a trustworthy overlay for this
   * client's own pre-existing content.
   */
  restore(snapshot: AttributionSnapshot): void {
    this.#ranges = snapshot.ranges.map((range) => ({ ...range }));
    this.#lastEditBySender = new Map(Object.entries(snapshot.lastEditBySender));
  }

  /**
   * Records that `authorId` inserted `length` characters at `index`:
   * shifts ranges entirely after the insertion point, splits any range the
   * insertion point falls inside of (the original author keeps both
   * halves; the new text becomes its own range rather than joining
   * theirs), and adds a new `authorId` range for the inserted text —
   * merging it into an adjacent same-author range if the two now touch, so
   * one author typing continuously stays one range instead of fragmenting
   * per keystroke.
   */
  recordInsert(index: number, length: number, authorId: string): void {
    if (length <= 0) {
      return;
    }
    const shifted: AttributionRange[] = [];
    for (const range of this.#ranges) {
      if (range.end <= index) {
        shifted.push(range);
      } else if (range.start >= index) {
        shifted.push({
          start: range.start + length,
          end: range.end + length,
          authorId: range.authorId,
        });
      } else {
        // `index` falls strictly inside this range: split it, preserving
        // its original author on both sides of the new insertion.
        shifted.push({ start: range.start, end: index, authorId: range.authorId });
        shifted.push({ start: index + length, end: range.end + length, authorId: range.authorId });
      }
    }
    this.#ranges = mergeAdjacentSameAuthor(
      insertSorted(shifted, { start: index, end: index + length, authorId }),
    );
    // Every OTHER author's last-edit marker at or after `index` must shift
    // with the text the same way their `#ranges` entries just did above —
    // otherwise it silently goes stale the moment someone else edits before
    // it, and keeps being re-resolved against an ever-changing document on
    // every render by an editor that has no staleness check of its own, which makes
    // the marker visibly "wander". Skips
    // `authorId`'s own entry: it is overwritten by the `.set()` below
    // regardless, and skipping keeps the two statements order-independent
    // instead of relying on the loop running strictly before the `.set()`.
    for (const [otherAuthorId, pos] of this.#lastEditBySender) {
      if (otherAuthorId === authorId) {
        continue;
      }
      if (pos >= index) {
        this.#lastEditBySender.set(otherAuthorId, pos + length);
      }
    }
    this.#lastEditBySender.set(authorId, index + length);
  }

  /**
   * Records that `authorId` deleted `length` characters starting at
   * `index`: shrinks, splits away, or entirely removes overlapping ranges,
   * and shifts ranges entirely after the deletion left. `authorId` does
   * not affect the range math (a delete never introduces new authorship)
   * but is still recorded as that author's last edit position — a delete
   * is an edit at a location just as much as an insert is.
   */
  /**
   * Reattributes exactly the ranges whose *current* `authorId` satisfies
   * `predicate`, walking them in document order and assigning authors from
   * `snapshot` — one entry per character, flattened from `snapshot.ranges`
   * in order — without ever touching a range `predicate` rejects,
   * regardless of where in the document it sits. Unlike `restore()`, this
   * never replaces the tracker's entire state, so it is safe to call even
   * when this client already has content `snapshot` knows nothing about
   * (SPECIFICATION.md §5.4): pass a
   * `predicate` that only matches content this specific mechanism could
   * plausibly have produced (`document-protocol` uses `authorId ===
   * UNATTRIBUTED_AUTHOR_ID`, its own resync-response sentinel — never any
   * range this client typed itself or received via a normal delivery), and
   * whatever it selects is exactly, and only, what gets reattributed.
   *
   * A length mismatch (`snapshot` describes fewer characters than
   * currently match `predicate`) leaves the remainder at its current
   * `authorId` rather than guessing — the same "tolerate, don't surface"
   * posture `restore()`'s malformed-JSON caller already takes.
   *
   * Also updates `lastEditBySender` best-effort: `snapshot.lastEditBySender`
   * values are indices into `snapshot`'s own flattened space (the same
   * space `newAuthorsFlat` walks), so each is mapped back to this
   * client's *current* absolute position via the same walk, and only
   * applied if it is more recent than any marker already recorded for
   * that author — never regresses a marker this client already has from
   * elsewhere.
   */
  reattributeMatching(
    predicate: (authorId: string) => boolean,
    snapshot: AttributionSnapshot,
  ): void {
    const newAuthorsFlat: string[] = [];
    for (const range of snapshot.ranges) {
      for (let i = range.start; i < range.end; i++) {
        newAuthorsFlat.push(range.authorId);
      }
    }

    let cursor = 0;
    const cursorToAbsolute: number[] = [];
    const result: AttributionRange[] = [];
    for (const range of this.#ranges) {
      if (!predicate(range.authorId)) {
        result.push(range);
        continue;
      }
      let runStart = range.start;
      let runAuthor: string | undefined;
      for (let pos = range.start; pos < range.end; pos++) {
        cursorToAbsolute[cursor] = pos;
        const author = cursor < newAuthorsFlat.length ? newAuthorsFlat[cursor] : range.authorId;
        cursor++;
        if (runAuthor === undefined) {
          runAuthor = author;
        } else if (author !== runAuthor) {
          result.push({ start: runStart, end: pos, authorId: runAuthor });
          runStart = pos;
          runAuthor = author;
        }
      }
      cursorToAbsolute[cursor] = range.end;
      if (runAuthor !== undefined) {
        result.push({ start: runStart, end: range.end, authorId: runAuthor });
      }
    }
    this.#ranges = mergeAdjacentSameAuthor(result);

    for (const [author, snapshotPos] of Object.entries(snapshot.lastEditBySender)) {
      const absolutePos = cursorToAbsolute[snapshotPos];
      if (absolutePos === undefined) {
        continue; // out of range for what this snapshot actually described
      }
      const existing = this.#lastEditBySender.get(author);
      if (existing === undefined || absolutePos > existing) {
        this.#lastEditBySender.set(author, absolutePos);
      }
    }
  }

  recordDelete(index: number, length: number, authorId: string): void {
    if (length <= 0) {
      return;
    }
    const deleteEnd = index + length;
    const remaining: AttributionRange[] = [];
    for (const range of this.#ranges) {
      const start = mapThroughDeletion(range.start, index, deleteEnd, length);
      const end = mapThroughDeletion(range.end, index, deleteEnd, length);
      if (start < end) {
        remaining.push({ start, end, authorId: range.authorId });
      }
    }
    this.#ranges = remaining;
    // Same staleness fix as recordInsert above, reusing the same
    // mapThroughDeletion helper already used for range endpoints: every
    // OTHER author's last-edit marker must be remapped through this
    // deletion too, or it goes stale the moment someone else deletes text
    // at or before it. Skips `authorId`'s own entry for the same
    // order-independence reason as recordInsert.
    for (const [otherAuthorId, pos] of this.#lastEditBySender) {
      if (otherAuthorId === authorId) {
        continue;
      }
      this.#lastEditBySender.set(otherAuthorId, mapThroughDeletion(pos, index, deleteEnd, length));
    }
    this.#lastEditBySender.set(authorId, index);
  }
}

/** Maps one range endpoint through a `[deleteStart, deleteEnd)` deletion of `deleteLength` characters. */
function mapThroughDeletion(
  pos: number,
  deleteStart: number,
  deleteEnd: number,
  deleteLength: number,
): number {
  if (pos <= deleteStart) {
    return pos;
  }
  if (pos >= deleteEnd) {
    return pos - deleteLength;
  }
  return deleteStart;
}

function insertSorted(ranges: AttributionRange[], next: AttributionRange): AttributionRange[] {
  const insertAt = ranges.findIndex((range) => range.start > next.start);
  const result = ranges.slice();
  result.splice(insertAt === -1 ? result.length : insertAt, 0, next);
  return result;
}

function mergeAdjacentSameAuthor(ranges: readonly AttributionRange[]): AttributionRange[] {
  const merged: AttributionRange[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && last.authorId === range.authorId && last.end === range.start) {
      merged[merged.length - 1] = { start: last.start, end: range.end, authorId: last.authorId };
    } else {
      merged.push(range);
    }
  }
  return merged;
}
