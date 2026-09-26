import {
  applyUpdate,
  createDocument,
  encodeStateVector,
  encodeUpdate,
  encodeUpdateSince,
  ensureParagraph,
  getFragment,
  hasUpdatesSince,
  isEmptyStateVector,
  lacksUpdatesOf,
  pendingGapClients,
  type ReconciledDocument,
  transact,
  updateClientIds,
} from "@tdsp/reconciliation";
import { isProfileId } from "./framing";

/**
 * A document profile (SPECIFICATION.md §5): what a document's content bytes mean.
 * The engine moves updates and state vectors without looking inside them, and asks its
 * document's profile the few questions PRF-1 lists — nothing else about the CRDT reaches the
 * engine.
 *
 * This reference engine implements one profile, `yjs-paragraphs/1` (Appendix A), and its
 * `document` is therefore always a Yjs document, which the editor binds to directly. A second
 * profile would bring its own document type with it.
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
  encodeState: (document) => encodeUpdate(document),
  encodeStateSince: (document, stateVector) => encodeUpdateSince(document, stateVector),
  encodeStateVector: (document) => encodeStateVector(document),
  isEmptyStateVector: (stateVector) => isEmptyStateVector(stateVector),
  hasUpdatesSince: (document, stateVector) => hasUpdatesSince(document, stateVector),
  lacksUpdatesOf: (document, stateVector) => lacksUpdatesOf(document, stateVector),
  pendingGapClients: (document) => pendingGapClients(document),
  updateClientIds: (update) => updateClientIds(update),
};

const PROFILES: ReadonlyMap<string, DocumentProfile> = new Map([
  [yjsParagraphs1.id, yjsParagraphs1],
]);

/** The ids of the profiles this engine implements — what a decline lists (§6.5). */
export const SUPPORTED_PROFILES: readonly string[] = [...PROFILES.keys()];

/**
 * The engine does not implement the document's profile (PRF-3): it refuses to create or join
 * the document, and the application can decline the invitation instead.
 */
export class UnsupportedProfileError extends Error {
  readonly profile: string;
  constructor(profile: string) {
    super(
      isProfileId(profile)
        ? `this engine does not implement the document profile ${profile} (it implements ${SUPPORTED_PROFILES.join(", ")})`
        : `not a document profile id: ${JSON.stringify(profile)}`,
    );
    this.name = "UnsupportedProfileError";
    this.profile = profile;
  }
}

/** The implementation of `id`, or `UnsupportedProfileError`. */
export function profileFor(id: string): DocumentProfile {
  const profile = PROFILES.get(id);
  if (profile === undefined) {
    throw new UnsupportedProfileError(id);
  }
  return profile;
}
