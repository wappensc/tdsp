import * as Y from "yjs";
import { paragraphTexts } from "./attribution";
import { stateVectorWithinBounds, updateWithinBounds } from "./update-bounds";

/**
 * The document model of the profile `yjs-paragraphs/1` (SPECIFICATION.md Appendix A): a thin
 * wrapper around Yjs. Code goes through this module rather than importing `yjs` directly, so
 * that the CRDT stays an implementation detail of the profile.
 *
 * A document is a `Y.XmlFragment` named `content` holding one or more `<paragraph>` elements,
 * each with one `Y.XmlText` — a tree, not a flat `Y.Text`, because editor bindings such as
 * TipTap's (`@tiptap/y-tiptap`) require one. `getPlainText`/`insertPlainText`/
 * `deletePlainText` project it onto a flat string for callers, mostly tests, that do not need
 * real multi-paragraph structure.
 */

export type ReconciledDocument = Y.Doc;
export type ReconciledFragment = Y.XmlFragment;

const FRAGMENT_KEY = "content";
const PARAGRAPH_TAG = "paragraph";

export function createDocument(): ReconciledDocument {
  return new Y.Doc();
}

export function getFragment(doc: ReconciledDocument): ReconciledFragment {
  return doc.getXmlFragment(FRAGMENT_KEY);
}

/**
 * Renders every paragraph's text content as one string, paragraphs joined
 * by "\n". A projection for the minimal paragraph+text schema, not a
 * general XML serialization — fine as long as the schema stays plain
 * paragraphs of text. The per-paragraph walk itself lives in `./attribution.ts`
 * (`paragraphTexts`) — `observePlainTextChanges` needs the *un-joined*
 * array to tell which paragraph a change landed in, so this just joins
 * that same array rather than duplicating the walk.
 */
export function getPlainText(fragment: ReconciledFragment): string {
  return paragraphTexts(fragment).join("\n");
}

/**
 * Inserts `content` at plain-text offset `index` into the fragment's first
 * paragraph, creating that paragraph (and its text node) if the fragment is
 * still empty. A programmatic-mutation convenience: most tests exercise a
 * single paragraph and need no editor to drive multi-paragraph structure.
 * Real editing goes through an editor's own Yjs binding, not through this
 * function.
 */
export function insertPlainText(
  fragment: ReconciledFragment,
  index: number,
  content: string,
): void {
  firstParagraphText(fragment).insert(index, content);
}

/** The delete counterpart to `insertPlainText` — see its doc comment. */
export function deletePlainText(fragment: ReconciledFragment, index: number, length: number): void {
  firstParagraphText(fragment).delete(index, length);
}

/**
 * Ensures the fragment has at least one paragraph (creating an empty one if
 * needed) without inserting text. Used to seed a new document's structure
 * exactly once, before any client can independently create a competing
 * paragraph (see `DocumentEngine.create()`'s doc comment for why that
 * matters).
 */
export function ensureParagraph(fragment: ReconciledFragment): void {
  firstParagraphText(fragment);
}

function firstParagraphText(fragment: ReconciledFragment): Y.XmlText {
  let element = fragment.get(0) as Y.XmlElement | undefined;
  if (!element) {
    element = new Y.XmlElement(PARAGRAPH_TAG);
    fragment.insert(0, [element]);
  }
  let text = element.firstChild as Y.XmlText | null;
  if (!text) {
    text = new Y.XmlText();
    element.insert(0, [text]);
  }
  return text;
}

/**
 * Subscribes to every local and remote change anywhere in the fragment's
 * subtree (paragraph structure and nested text alike — `observe()` alone
 * only fires for direct-child changes, missing nested text mutations).
 * Returns an unsubscribe function.
 */
export function observeFragment(fragment: ReconciledFragment, listener: () => void): () => void {
  const wrapped = () => listener();
  fragment.observeDeep(wrapped);
  return () => fragment.unobserveDeep(wrapped);
}

/** Subscribes to every local and remote change; returns an unsubscribe function. */
export function observeUpdates(
  doc: ReconciledDocument,
  listener: (update: Uint8Array, origin: unknown, transaction: Y.Transaction) => void,
): () => void {
  const handler = (update: Uint8Array, origin: unknown, _doc: Y.Doc, transaction: Y.Transaction) =>
    listener(update, origin, transaction);
  doc.on("update", handler);
  return () => doc.off("update", handler);
}

/**
 * The names of the top-level shared types a transaction changed: every changed type leads, through
 * its items' parents, to one of them (verified for inserts, deletions and formatting, nested types
 * and mixed transactions, in this package's tests).
 */
export function changedRoots(doc: ReconciledDocument, transaction: Y.Transaction): Set<string> {
  const names = new Map<unknown, string>();
  for (const [name, type] of doc.share) {
    names.set(type, name);
  }
  const roots = new Set<string>();
  for (const changed of transaction.changed.keys()) {
    let type = changed;
    while (type._item !== null) {
      type = type._item.parent as typeof changed;
    }
    const name = names.get(type);
    if (name !== undefined) {
      roots.add(name);
    }
  }
  return roots;
}

/** Runs `mutator` as one reconciliation transaction, tagged with `origin` if given. */
export function transact(doc: ReconciledDocument, mutator: () => void, origin?: unknown): void {
  doc.transact(mutator, origin);
}

/** A delete set by client: each client's ranges, ascending and merged. */
type Deletions = Iterable<
  readonly [number, readonly { readonly clock: number; readonly len: number }[]]
>;

/**
 * What `doc` has applied of deletions, from its items (Appendix A, LOS-24): nothing it holds for
 * missing predecessors (LOS-23). Yjs's `encodeStateAsUpdate` adds those held structs and ranges,
 * so a digest over it would differ from that of every replica holding the same.
 */
function appliedDeletions(doc: ReconciledDocument): Deletions {
  return Y.createDeleteSetFromStructStore(doc.store).clients;
}

/**
 * An update of no structs and `deletions`, as Yjs writes a delete set in update encoding version
 * 1: `00`, the number of clients, then each client in descending order of its id with its ranges,
 * every number a varuint (Appendix A). A client without ranges is left out.
 */
function encodeDeletionSet(deletions: Deletions): Uint8Array {
  const clients = [...deletions]
    .filter(([, items]) => items.length > 0)
    .sort((a, b) => b[0] - a[0]);
  const bytes: number[] = [0];
  writeVarUint(bytes, clients.length);
  for (const [client, items] of clients) {
    writeVarUint(bytes, client);
    writeVarUint(bytes, items.length);
    for (const item of items) {
      writeVarUint(bytes, item.clock);
      writeVarUint(bytes, item.len);
    }
  }
  return Uint8Array.from(bytes);
}

/**
 * What `doc` deleted, canonically (Appendix A): an update of no structs and the delete set of
 * its applied items, the same bytes for the same state whatever the order the updates came in,
 * merged or not, garbage-collected or not (verified for each of these), and whatever it holds
 * for missing predecessors (LOS-23).
 */
export function encodeDeletions(doc: ReconciledDocument): Uint8Array {
  return encodeDeletionSet(appliedDeletions(doc));
}

/**
 * What `doc` deleted of the items `stateVector` counts (Appendix A): `encodeDeletions`' encoding, with
 * each client's ranges cut at that client's clock in `stateVector` and a client left with none dropped.
 * With `doc`'s own state vector it is `encodeDeletions` byte for byte, since a replica deletes only
 * items it holds. What a receiver that holds more compares with a sender's state digest (LOS-12).
 * Throws if `stateVector` is not a state vector.
 */
export function encodeDeletionsWithin(
  doc: ReconciledDocument,
  stateVector: Uint8Array,
): Uint8Array {
  const counted = Y.decodeStateVector(stateVector);
  const clients: [number, { clock: number; len: number }[]][] = [];
  for (const [client, items] of appliedDeletions(doc)) {
    const limit = counted.get(client) ?? 0;
    clients.push([
      client,
      items
        .filter((item) => item.clock < limit)
        .map((item) => ({ clock: item.clock, len: Math.min(item.len, limit - item.clock) })),
    ]);
  }
  return encodeDeletionSet(clients);
}

/** A variable-length unsigned integer as Yjs (lib0) writes one: seven bits a byte, lowest first. */
function writeVarUint(bytes: number[], value: number): void {
  let rest = value;
  while (rest > 0x7f) {
    bytes.push(0x80 | (rest & 0x7f));
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
}

/**
 * What `doc` applied since `stateVector`, or all it applied (Appendix A, "Updates a state vector
 * lacks"): nothing it holds for missing predecessors (LOS-23), which would do nothing at the
 * receiver but be held there as well. Yjs's `encodeStateAsUpdate` adds those held structs and
 * ranges, and Yjs exports no writer without them, so they are set aside while it writes and put
 * back unchanged; nothing runs in between.
 */
function encodeApplied(doc: ReconciledDocument, stateVector?: Uint8Array): Uint8Array {
  const { pendingStructs, pendingDs } = doc.store;
  doc.store.pendingStructs = null;
  doc.store.pendingDs = null;
  try {
    return Y.encodeStateAsUpdate(doc, stateVector);
  } finally {
    doc.store.pendingStructs = pendingStructs;
    doc.store.pendingDs = pendingDs;
  }
}

/** The whole state `doc` applied, as one update (Appendix A, PRF-1 item 4). */
export function encodeUpdate(doc: ReconciledDocument): Uint8Array {
  return encodeApplied(doc);
}

/** What `doc` applied that `stateVector` lacks (Appendix A, PRF-1 item 4): an answer's update (RSY-8). */
export function encodeUpdateSince(doc: ReconciledDocument, stateVector: Uint8Array): Uint8Array {
  return encodeApplied(doc, stateVector);
}

export function encodeStateVector(doc: ReconciledDocument): Uint8Array {
  return Y.encodeStateVector(doc);
}

/**
 * Whether `doc` holds any update `remoteStateVector` does not already
 * account for — the gate `document-protocol`'s resync-response logic
 * uses to avoid answering a request with nothing new to offer
 * (SPECIFICATION.md RSY-17). Compares state
 * vectors directly (per-client clock comparison) rather than checking
 * whether `encodeUpdateSince`'s output happens to be the empty-update
 * encoding, so this does not depend on that encoding's byte-level shape.
 * Verified against four cases before relying on it: a fresh joiner's
 * empty state vector reports `true`; a fully caught-up peer's own current
 * state vector reports `false`; one further local edit after that flips
 * it back to `true`; and an unrelated document's state vector (disjoint
 * client-id space) reports `true`, since every one of the local doc's
 * clients is unknown to it.
 */
export function hasUpdatesSince(doc: ReconciledDocument, remoteStateVector: Uint8Array): boolean {
  const local = Y.decodeStateVector(Y.encodeStateVector(doc));
  const remote = Y.decodeStateVector(remoteStateVector);
  for (const [client, clock] of local) {
    if ((remote.get(client) ?? 0) < clock) {
      return true;
    }
  }
  return false;
}

/**
 * The opposite question to `hasUpdatesSince`: whether `remoteStateVector` accounts for
 * changes `doc` has not applied — the sender of that vector has seen something this
 * document lacks (the heartbeat of SPECIFICATION.md §9.3: how a lost *final* message becomes
 * visible, since nothing later carries a gap to notice). A change `doc` holds only as
 * *pending* — received, but waiting for an earlier one — is not applied, so it counts
 * as lacking here; Yjs's own state vector leaves it out, which is what makes this
 * compare correctly (verified: with one of three updates lost and the third held
 * pending, the receiver's clock for that client is 3 against the sender's 11). Throws
 * if `remoteStateVector` is not a state vector.
 */
export function lacksUpdatesOf(doc: ReconciledDocument, remoteStateVector: Uint8Array): boolean {
  const local = Y.decodeStateVector(Y.encodeStateVector(doc));
  const remote = Y.decodeStateVector(remoteStateVector);
  for (const [client, clock] of remote) {
    if ((local.get(client) ?? 0) < clock) {
      return true;
    }
  }
  return false;
}

/**
 * Of the clients `remoteStateVector` counts more items of than `doc` holds, the clock it names for
 * each: whose updates a replica lacks, by its writer.
 */
export function clientsAhead(
  doc: ReconciledDocument,
  remoteStateVector: Uint8Array,
): Map<number, number> {
  const local = Y.decodeStateVector(Y.encodeStateVector(doc));
  const ahead = new Map<number, number>();
  for (const [client, clock] of Y.decodeStateVector(remoteStateVector)) {
    if ((local.get(client) ?? 0) < clock) {
      ahead.set(client, clock);
    }
  }
  return ahead;
}

/**
 * Of each client `update` inserts items of, the clock after its last one (`Y.parseUpdateMeta`'s
 * `to`): how far the update carries that writer. An update that only deletes names none.
 */
export function updateClocks(update: Uint8Array): Map<number, number> {
  return new Map(Y.parseUpdateMeta(update).to);
}

/**
 * The client ids `doc` is waiting on (PRF-1 item 2, Appendix A): it holds later updates from each
 * and is missing an earlier one (Yjs's `pendingStructs.missing`, verified to name the client and
 * the clock), or it holds a deletion of items of theirs it has not received (`pendingDs`, a delete
 * set in update encoding version 2) — an update that only deletes is held as well, and shows no
 * other gap. Empty when nothing is pending. Only ever an *indication*: a gap that is a late
 * predecessor rather than a loss looks identical until the predecessor arrives, which is why a
 * caller has to wait before it believes one.
 */
export function pendingGapClients(doc: ReconciledDocument): number[] {
  const clients = new Set<number>();
  const pending = doc.store.pendingStructs;
  if (pending !== null) {
    for (const client of pending.missing.keys()) {
      clients.add(client);
    }
  }
  const pendingDeletions = doc.store.pendingDs;
  if (pendingDeletions !== null) {
    for (const client of Y.decodeUpdateV2(pendingDeletions).ds.clients.keys()) {
      clients.add(client);
    }
  }
  return [...clients];
}

/**
 * The bytes `doc` holds for missing predecessors (PRF-1 item 2, Appendix A): Yjs's pending
 * structures and pending deletions, as Yjs keeps them encoded. What a bound on them measures
 * (LOS-23).
 */
export function pendingBytes(doc: ReconciledDocument): number {
  return (doc.store.pendingStructs?.update.length ?? 0) + (doc.store.pendingDs?.length ?? 0);
}

/**
 * Gives up everything `doc` holds for missing predecessors (PRF-1 item 2, LOS-23), and returns the
 * client ids it was waiting on. The document is as if those updates had never arrived: an update
 * that brings them again is applied as any other.
 */
export function giveUpPending(doc: ReconciledDocument): number[] {
  const clients = pendingGapClients(doc);
  doc.store.pendingStructs = null;
  doc.store.pendingDs = null;
  return clients;
}

/** The client ids that authored the insertions in `update`; how a caller learns which client belongs to which sender. */
export function updateClientIds(update: Uint8Array): number[] {
  const clients = new Set<number>();
  for (const struct of Y.decodeUpdate(update).structs) {
    clients.add((struct as { id: { client: number } }).id.client);
  }
  return [...clients];
}

/**
 * Whether `stateVector` is the encoding `encodeStateVector` produces for a
 * totally fresh `createDocument()` that has neither applied a remote
 * update nor made a local edit — a single zero-length-count byte, `[0]`
 * (verified: a fresh `Y.Doc` records no client entries at all
 * until it has actually created something). `document-protocol` uses this
 * to distinguish a true bootstrap resync request (this client had nothing
 * at all when it asked) from a partial gap-heal request (SPECIFICATION.md §5.4) without hardcoding Yjs's
 * own state-vector byte encoding outside this wrapper.
 */
export function isEmptyStateVector(stateVector: Uint8Array): boolean {
  return stateVector.length === 1 && stateVector[0] === 0;
}

/**
 * Whether `update` reads as exactly one Yjs update of encoding version 1, every struct and the whole
 * delete set and no byte after them, without applying it (PRF-1 items 1 and 9, Appendix A).
 * `Y.applyUpdate` integrates an update's structs before it reads its delete set, so bytes that fail
 * there leave part of themselves in the document; checked first, nothing of them is applied
 * (FRM-6). Yjs reads an update as far as it goes and ignores what follows; a byte after it is
 * refused, so that one byte string has one reading (§4.4). The bounds Yjs does not keep — no
 * variable-length integer above 2^53 − 1, no JSON content or `Any` value nested more than 32 levels —
 * are walked first, so Yjs's recursive reader never meets deeper nesting (Appendix A).
 */
export function isUpdate(update: Uint8Array): boolean {
  if (!updateWithinBounds(update)) {
    return false;
  }
  // Yjs's own reader, given a decoder whose position this one can see afterwards.
  let read: { readonly arr: Uint8Array; readonly pos: number } | undefined;
  class Watched extends Y.UpdateDecoderV1 {
    constructor(decoder: ConstructorParameters<typeof Y.UpdateDecoderV1>[0]) {
      super(decoder);
      read = decoder;
    }
  }
  try {
    Y.decodeUpdateV2(update, Watched);
  } catch {
    return false;
  }
  return read !== undefined && read.arr === update && read.pos === update.length;
}

/**
 * Whether `stateVector` reads as a Yjs state vector to its last byte (PRF-1 items 3 and 9, Appendix A):
 * the number of entries, then a client id and a clock for each, every one a variable-length
 * unsigned integer no larger than 2^53 − 1, which lib0 checks only between bytes. A responder keeps
 * a request to answer later (RSY-9), so a vector that fails only when it is compared would fail
 * every answer after it.
 */
export function isStateVector(stateVector: Uint8Array): boolean {
  try {
    Y.decodeStateVector(stateVector);
  } catch {
    return false;
  }
  return stateVectorWithinBounds(stateVector);
}

export function applyUpdate(doc: ReconciledDocument, update: Uint8Array, origin?: unknown): void {
  Y.applyUpdate(doc, update, origin);
}

/**
 * Combines several incremental updates (as produced by `observeUpdates`)
 * into one equivalent update — applying the result has the same effect as
 * applying each input in order, but as a single, smaller message. Used by
 * `DocumentEngine`'s broadcast batching (`DocumentEngineOptions.batchWindowMs`,
 * `packages/document-protocol`) to merge several local edits queued within
 * one batch window before sending, instead of one message per edit.
 */
export function mergeUpdates(updates: readonly Uint8Array[]): Uint8Array {
  return Y.mergeUpdates(updates as Uint8Array[]);
}

export {
  type AttributionRange,
  type AttributionSnapshot,
  AttributionTracker,
  observePlainTextChanges,
  type PlainTextChange,
} from "./attribution";
export { splitUpdate, UnsplittableUpdateError } from "./split";
