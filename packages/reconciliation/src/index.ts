import * as Y from "yjs";
import { paragraphTexts } from "./attribution";

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
  listener: (update: Uint8Array, origin: unknown) => void,
): () => void {
  doc.on("update", listener);
  return () => doc.off("update", listener);
}

/** Runs `mutator` as one reconciliation transaction, tagged with `origin` if given. */
export function transact(doc: ReconciledDocument, mutator: () => void, origin?: unknown): void {
  doc.transact(mutator, origin);
}

export function encodeUpdate(doc: ReconciledDocument): Uint8Array {
  return Y.encodeStateAsUpdate(doc);
}

export function encodeUpdateSince(doc: ReconciledDocument, stateVector: Uint8Array): Uint8Array {
  return Y.encodeStateAsUpdate(doc, stateVector);
}

export function encodeStateVector(doc: ReconciledDocument): Uint8Array {
  return Y.encodeStateVector(doc);
}

/**
 * Whether `doc` holds any update `remoteStateVector` does not already
 * account for — the gate `document-protocol`'s resync-response logic
 * uses to avoid answering a request with nothing new to offer
 * (SPECIFICATION.md RSY-7). Compares state
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
 * The client ids `doc` is waiting on: it holds later updates from each and is missing
 * an earlier one (Yjs's `pendingStructs.missing`, verified to name the
 * client and the clock). Empty when nothing is pending. Only ever an *indication*: a
 * gap that is a late predecessor rather than a loss looks identical until the
 * predecessor arrives, which is why a caller has to wait before it believes one.
 */
export function pendingGapClients(doc: ReconciledDocument): number[] {
  const pending = doc.store.pendingStructs;
  return pending === null ? [] : [...pending.missing.keys()];
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
