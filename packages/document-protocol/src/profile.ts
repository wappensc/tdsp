import {
  applyUpdate,
  createDocument,
  encodeDeletions,
  encodeDeletionsWithin,
  encodeStateVector,
  encodeUpdate,
  encodeUpdateSince,
  ensureParagraph,
  getFragment,
  getPlainText,
  hasUpdatesSince,
  isEmptyStateVector,
  isStateVector,
  isUpdate,
  lacksUpdatesOf,
  observePlainTextChanges,
  type PlainTextChange,
  pendingGapClients,
  type ReconciledDocument,
  splitUpdate,
  stateVectorHolds,
  transact,
  updateClientIds,
} from "@tdsp/reconciliation";
import { type Frame, FrameDecodeError, isProfileId } from "./framing";

/**
 * A document's plain-text projection (SPECIFICATION.md PRF-1, item 6): what attribution counts
 * offsets in (§5.4). Offsets are UTF-16 code units of `text()`.
 */
export interface ProfileProjection {
  /** The projection of the document as it is now. Deterministic: equal states, equal text. */
  text(document: ReconciledDocument): string;
  /**
   * Reports every later change to the projection, in order, as inserts and deletes at offsets
   * into the projection as it stood just before that change — whoever made it, locally or by an
   * applied update. A change that leaves the projection as it was reports nothing. Returns the
   * function that stops reporting.
   */
  observe(document: ReconciledDocument, listener: (change: PlainTextChange) => void): () => void;
}

/**
 * The projection of a profile whose content is paragraphs of text in the `Y.XmlFragment`
 * named `content`, as in `yjs-paragraphs/1` (Appendix A): the paragraphs' text joined by
 * `"\n"`. What the engine uses for a profile that names no projection of its own.
 */
export const PARAGRAPH_PROJECTION: ProfileProjection = {
  text: (document) => getPlainText(getFragment(document)),
  observe: (document, listener) => observePlainTextChanges(getFragment(document), listener),
};

/**
 * A document profile (SPECIFICATION.md §5): what a document's content bytes mean.
 * The engine moves updates and state vectors without looking inside them, and asks its
 * document's profile the few questions PRF-1 lists — nothing else about the CRDT reaches the
 * engine.
 *
 * **Built in:** `yjs-paragraphs/1` (Appendix A). **Supplied by an application** (the engine's
 * `profiles` option): any other, which SPECIFICATION.md PRF-7 requires to be publicly defined,
 * with test vectors. Whoever supplies a profile answers for it: convergence, loss evidence and
 * attribution are only as right as its answers, and this repository neither ships nor tests
 * profiles it does not define. It ships with the application — never loaded because a document
 * names it (PRF-8).
 *
 * **A Yjs contract.** `ReconciledDocument` is a Yjs document: a profile defines a document
 * structure on Yjs, its update encoding version 1 and Yjs state vectors, as `yjs-paragraphs/1`
 * does. A profile on another CRDT would need a different engine.
 *
 * **Stable within a major version** (docs/versioning.md): an application implements this
 * interface, so a later 1.x adds only optional members, as `projection` is.
 */
export interface DocumentProfile {
  /** `<name>/<major>`, as the invitation and the creator's snapshot name it. */
  readonly id: string;
  /** A creator's new document, holding the profile's initial state (PRF-1, item 5). */
  createInitial(): ReconciledDocument;
  /** A joiner's empty replica, which bootstrap fills. */
  createEmpty(): ReconciledDocument;
  /** Applies an update in any order, holding one whose predecessors are missing (item 1). */
  applyUpdate(document: ReconciledDocument, update: Uint8Array, origin: unknown): void;
  /**
   * Whether `update` reads completely as exactly one update of this profile, no byte after it,
   * without applying it (PRF-1, item 9): what the engine checks before it applies anything of a
   * frame (FRM-6), so that bytes that fail halfway leave nothing behind. Optional: without it the
   * engine uses `isUpdate`, which reads any Yjs update of version 1.
   */
  isUpdate?(update: Uint8Array): boolean;
  /**
   * Whether `stateVector` reads completely as exactly one state vector of this profile, no byte
   * after it (PRF-1, items 3 and 9): checked before a frame that carries one is handled or kept
   * (FRM-6). Optional: without it the engine uses `isStateVector`, which reads a Yjs state vector to
   * its last byte.
   */
  isStateVector?(stateVector: Uint8Array): boolean;
  /** The whole state as one update. */
  encodeState(document: ReconciledDocument): Uint8Array;
  /** The updates `stateVector` lacks; with the empty state vector, the whole state (item 4). */
  encodeStateSince(document: ReconciledDocument, stateVector: Uint8Array): Uint8Array;
  /** The replica's state vector (item 3). */
  encodeStateVector(document: ReconciledDocument): Uint8Array;
  isEmptyStateVector(stateVector: Uint8Array): boolean;
  /** Whether the replica holds updates `stateVector` lacks. */
  hasUpdatesSince(document: ReconciledDocument, stateVector: Uint8Array): boolean;
  /** Whether `stateVector` holds updates the replica lacks. */
  lacksUpdatesOf(document: ReconciledDocument, stateVector: Uint8Array): boolean;
  /** Whose updates are held for missing predecessors (item 2), as the CRDT names them. */
  pendingGapClients(document: ReconciledDocument): number[];
  /** Whose updates one update carries, as the CRDT names them. */
  updateClientIds(update: Uint8Array): number[];
  /**
   * Whether `stateVector` holds `update`, as the state vector summarises it (PRF-1, item 3): what a heartbeat holds of an edit,
   * which ends the silence the edit left open (LOS-16). Optional: without it the engine uses
   * `stateVectorHolds`, which reads any Yjs update of version 1.
   */
  holdsUpdate?(stateVector: Uint8Array, update: Uint8Array): boolean;
  /**
   * What the replica deleted, as one canonical encoding (PRF-1, item 8): equal for equal states,
   * whatever the order updates came in. Its digest is what a state vector does not show (LOS-12).
   * Optional: without it the engine uses `encodeDeletions`, the encoding Appendix A defines.
   */
  encodeDeletions?(document: ReconciledDocument): Uint8Array;
  /**
   * What the replica deleted of the items `stateVector` counts, in the same encoding (PRF-1, item
   * 8): within the replica's own state vector exactly `encodeDeletions`. What a receiver that holds
   * more compares with a sender's state digest (LOS-12). Optional: without it the engine uses
   * `encodeDeletionsWithin`, Appendix A's — unless the profile brings its own `encodeDeletions`, and
   * then it compares digests only where the state vectors are equal.
   */
  encodeDeletionsWithin?(document: ReconciledDocument, stateVector: Uint8Array): Uint8Array;
  /**
   * The pieces of an update, each at most `maxBytes` long: each a valid update, applicable in any
   * order and with duplicates, one without its predecessors held (PRF-1). Throws
   * `UnsplittableUpdateError` for an indivisible unit larger than a piece (SND-19). Optional:
   * without it the engine uses `splitUpdate`, which splits any Yjs update of version 1.
   */
  splitUpdate?(update: Uint8Array, maxBytes: number): Uint8Array[];
  /**
   * The plain-text projection (PRF-1, item 6). Optional: without one the engine uses
   * `PARAGRAPH_PROJECTION`, which fits a profile keeping paragraphs of text in `content`, as
   * one that adds headings, lists or marks to `yjs-paragraphs/1` does. A profile whose text
   * lives elsewhere, or counts more than paragraphs, brings its own.
   */
  readonly projection?: ProfileProjection;
}

/** How a profile tells whether a state vector holds an update (PRF-1, item 3): its own way, or the Yjs one. */
export function holderOf(
  profile: DocumentProfile,
): (stateVector: Uint8Array, update: Uint8Array) => boolean {
  return profile.holdsUpdate ?? stateVectorHolds;
}

/** How a profile encodes what a replica deleted (PRF-1, item 8): its own way, or Appendix A's. */
export function deletionsOf(
  profile: DocumentProfile,
): (document: ReconciledDocument) => Uint8Array {
  return profile.encodeDeletions ?? encodeDeletions;
}

/**
 * How a profile encodes what a replica deleted of the items a state vector counts (PRF-1, item 8):
 * its own way, Appendix A's, or — for a profile that encodes deletions its own way but not these —
 * none, so that digests are compared at equal state vectors only.
 */
export function deletionsWithinOf(
  profile: DocumentProfile,
): ((document: ReconciledDocument, stateVector: Uint8Array) => Uint8Array) | undefined {
  if (profile.encodeDeletionsWithin !== undefined) {
    return profile.encodeDeletionsWithin;
  }
  return profile.encodeDeletions === undefined ? encodeDeletionsWithin : undefined;
}

/** How a profile reads an update and a state vector without applying them (FRM-6): its own way, or the Yjs one. */
export function readerOf(profile: DocumentProfile): {
  readonly isUpdate: (update: Uint8Array) => boolean;
  readonly isStateVector: (stateVector: Uint8Array) => boolean;
} {
  return {
    isUpdate: profile.isUpdate ?? isUpdate,
    isStateVector: profile.isStateVector ?? isStateVector,
  };
}

/**
 * Rejects a frame whose update or state vector the document's profile cannot read, as
 * `invalid-field` (§4.4, FRM-6, FRM-7, PRF-1 item 9), before anything of it is applied or kept: a
 * CRDT may apply part of an update before it fails on the rest, and a request kept to answer later
 * (RSY-9) whose state vector fails only when compared would fail every answer after it. Bytes after
 * a complete update or state vector are not one the profile reads (§4.4).
 */
export function checkProfileReads(frame: Frame, profile: DocumentProfile): void {
  const reader = readerOf(profile);
  const update =
    frame.kind === "edit" || frame.kind === "resync-response" ? frame.update : undefined;
  if (update !== undefined && !reader.isUpdate(update)) {
    throw new FrameDecodeError(
      "invalid-field",
      `the ${frame.kind}'s update is not one of the profile ${profile.id}`,
    );
  }
  const stateVector =
    frame.kind === "edit" || frame.kind === "decline" || frame.kind === "control"
      ? null
      : frame.stateVector;
  if (stateVector !== null && !reader.isStateVector(stateVector)) {
    throw new FrameDecodeError(
      "invalid-field",
      `the ${frame.kind}'s state vector is not one of the profile ${profile.id}`,
    );
  }
}

/** How a profile splits an update into pieces (PRF-1): its own way, or the Yjs one. */
export function splitterOf(
  profile: DocumentProfile,
): (update: Uint8Array, maxBytes: number) => Uint8Array[] {
  return profile.splitUpdate ?? splitUpdate;
}

/** The one profile this specification defines (Appendix A). */
export const YJS_PARAGRAPHS_1 = "yjs-paragraphs/1";

const yjsParagraphs1: DocumentProfile = {
  id: YJS_PARAGRAPHS_1,
  createInitial() {
    const document = createDocument();
    transact(document, () => ensureParagraph(getFragment(document)));
    return document;
  },
  createEmpty: () => createDocument(),
  applyUpdate: (document, update, origin) => applyUpdate(document, update, origin),
  isUpdate: (update) => isUpdate(update),
  isStateVector: (stateVector) => isStateVector(stateVector),
  encodeState: (document) => encodeUpdate(document),
  encodeStateSince: (document, stateVector) => encodeUpdateSince(document, stateVector),
  encodeStateVector: (document) => encodeStateVector(document),
  isEmptyStateVector: (stateVector) => isEmptyStateVector(stateVector),
  hasUpdatesSince: (document, stateVector) => hasUpdatesSince(document, stateVector),
  lacksUpdatesOf: (document, stateVector) => lacksUpdatesOf(document, stateVector),
  pendingGapClients: (document) => pendingGapClients(document),
  updateClientIds: (update) => updateClientIds(update),
  holdsUpdate: (stateVector, update) => stateVectorHolds(stateVector, update),
  encodeDeletions: (document) => encodeDeletions(document),
  encodeDeletionsWithin: (document, stateVector) => encodeDeletionsWithin(document, stateVector),
  splitUpdate: (update, maxBytes) => splitUpdate(update, maxBytes),
  projection: PARAGRAPH_PROJECTION,
};

const PROFILES: ReadonlyMap<string, DocumentProfile> = new Map([
  [yjsParagraphs1.id, yjsParagraphs1],
]);

/**
 * The ids of the profiles this engine has built in — what a decline lists (§6.5), together
 * with the ids of the profiles the application supplies, if any.
 */
export const SUPPORTED_PROFILES: readonly string[] = [...PROFILES.keys()];

/**
 * The engine does not implement the document's profile (PRF-3): it refuses to create or join
 * the document, and the application can decline the invitation instead.
 */
export class UnsupportedProfileError extends Error {
  readonly profile: string;
  constructor(profile: string, implemented: readonly string[] = SUPPORTED_PROFILES) {
    super(
      isProfileId(profile)
        ? `this engine does not implement the document profile ${profile} (it implements ${implemented.join(", ")})`
        : `not a document profile id: ${JSON.stringify(profile)}`,
    );
    this.name = "UnsupportedProfileError";
    this.profile = profile;
  }
}

/**
 * The implementation of `id` among the built-in profiles and those the application `supplied`,
 * or `UnsupportedProfileError` (PRF-3). A supplied profile that is not a valid profile id,
 * takes a built-in profile's id, or is supplied twice is a mistake of the application and is
 * refused whatever `id` asks for: one id has one meaning in an engine.
 */
export function profileFor(id: string, supplied: readonly DocumentProfile[] = []): DocumentProfile {
  const available = new Map(PROFILES);
  for (const profile of supplied) {
    if (!isProfileId(profile.id)) {
      throw new Error(
        `a supplied document profile has no valid profile id: ${JSON.stringify(profile.id)}`,
      );
    }
    if (PROFILES.has(profile.id)) {
      throw new Error(`a supplied document profile may not replace the built-in ${profile.id}`);
    }
    if (available.has(profile.id)) {
      throw new Error(`the document profile ${profile.id} is supplied twice`);
    }
    available.set(profile.id, profile);
  }
  const profile = available.get(id);
  if (profile === undefined) {
    throw new UnsupportedProfileError(id, [...available.keys()]);
  }
  return profile;
}

/** The projection the engine uses for `profile`: its own, or the paragraph projection. */
export function projectionOf(profile: DocumentProfile): ProfileProjection {
  return profile.projection ?? PARAGRAPH_PROJECTION;
}
