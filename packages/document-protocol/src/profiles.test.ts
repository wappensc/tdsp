import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import {
  applyUpdate,
  createDocument,
  encodeStateVector,
  encodeUpdate,
  encodeUpdateSince,
  getPlainText,
  hasUpdatesSince,
  insertPlainText,
  isEmptyStateVector,
  lacksUpdatesOf,
  type PlainTextChange,
  pendingGapClients,
  type ReconciledDocument,
  updateClientIds,
} from "@tdsp/reconciliation";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DocumentEngine, type DocumentProfile, UnsupportedProfileError } from "./index";

/**
 * Document profiles an application supplies (SPECIFICATION.md §5.5, the `profiles` option).
 * `com.example.notes/1` stands in for one: its text lives in a top-level `Y.Text` named `notes`,
 * not in `content`, so it brings its own projection.
 */

const DOCUMENT_ID = "doc-1";
const OPTIONS = { batchWindowMs: 0, resyncResponseThrottleMs: 0 };

/** Everything but the projection, as any Yjs profile answers it. */
const yjsBasics = {
  createEmpty: () => createDocument(),
  applyUpdate: (document: ReconciledDocument, update: Uint8Array, origin: unknown) =>
    applyUpdate(document, update, origin),
  encodeState: (document: ReconciledDocument) => encodeUpdate(document),
  encodeStateSince: (document: ReconciledDocument, stateVector: Uint8Array) =>
    encodeUpdateSince(document, stateVector),
  encodeStateVector: (document: ReconciledDocument) => encodeStateVector(document),
  isEmptyStateVector: (stateVector: Uint8Array) => isEmptyStateVector(stateVector),
  hasUpdatesSince: (document: ReconciledDocument, stateVector: Uint8Array) =>
    hasUpdatesSince(document, stateVector),
  lacksUpdatesOf: (document: ReconciledDocument, stateVector: Uint8Array) =>
    lacksUpdatesOf(document, stateVector),
  pendingGapClients: (document: ReconciledDocument) => pendingGapClients(document),
  updateClientIds: (update: Uint8Array) => updateClientIds(update),
};

const notes = (document: ReconciledDocument) => document.getText("notes");

const NOTES: DocumentProfile = {
  id: "com.example.notes/1",
  createInitial: () => createDocument(),
  ...yjsBasics,
  projection: {
    text: (document) => notes(document).toString(),
    observe(document, listener) {
      const handler = (event: Y.YTextEvent) => {
        let index = 0;
        for (const op of event.delta) {
          if (op.retain !== undefined) {
            index += op.retain;
          } else if (typeof op.insert === "string") {
            listener({ kind: "insert", index, length: op.insert.length });
            index += op.insert.length;
          } else if (op.delete !== undefined) {
            listener({ kind: "delete", index, length: op.delete } satisfies PlainTextChange);
          }
        }
      };
      notes(document).observe(handler);
      return () => notes(document).unobserve(handler);
    },
  },
};

/** A paragraph profile under its own id, naming no projection: the engine's default applies. */
const PARAGRAPHS: DocumentProfile = {
  id: "com.example.paragraphs/1",
  createInitial() {
    const document = createDocument();
    document.transact(() => {
      const paragraph = new Y.XmlElement("paragraph");
      paragraph.insert(0, [new Y.XmlText()]);
      document.getXmlFragment("content").insert(0, [paragraph]);
    });
    return document;
  },
  ...yjsBasics,
};

async function pair(profile: DocumentProfile, port = new InMemoryMessengerPort()) {
  const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, {
    ...OPTIONS,
    profile: profile.id,
    profiles: [profile],
  });
  await alice.setMembership("bob", "write");
  const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, {
    ...OPTIONS,
    creatorMemberId: "alice",
    profile: profile.id,
    profiles: [profile],
  });
  await alice.sync();
  await bob.sync();
  return { port, alice, bob };
}

describe("document profiles an application supplies (SPECIFICATION.md §5.5)", () => {
  it("creates, bootstraps and converges a document of a supplied profile", async () => {
    const { alice, bob } = await pair(NOTES);
    expect(alice.profile).toBe("com.example.notes/1");
    expect(alice.controlState.profile).toBe("com.example.notes/1");
    expect(bob.hasCompletedBootstrap).toBe(true);

    alice.document.transact(() => notes(alice.document).insert(0, "Hallo"));
    await bob.sync();
    bob.document.transact(() => notes(bob.document).insert(5, " Welt"));
    await alice.sync();
    expect(notes(alice.document).toString()).toBe("Hallo Welt");
    expect(notes(bob.document).toString()).toBe("Hallo Welt");
  });

  it("attributes by the profile's own projection", async () => {
    const { alice, bob } = await pair(NOTES);
    alice.document.transact(() => notes(alice.document).insert(0, "Hallo"));
    await bob.sync();
    bob.document.transact(() => notes(bob.document).insert(5, " Welt"));
    await alice.sync();
    expect(alice.attribution.ranges).toEqual([
      { start: 0, end: 5, authorId: "alice" },
      { start: 5, end: 10, authorId: "bob" },
    ]);
  });

  it("uses the paragraph projection for a profile that names none", async () => {
    const { alice, bob } = await pair(PARAGRAPHS);
    alice.edit((fragment) => insertPlainText(fragment, 0, "Hallo"));
    await bob.sync();
    expect(getPlainText(bob.fragment)).toBe("Hallo");
    expect(bob.attribution.ranges.at(-1)).toMatchObject({ end: 5, authorId: "alice" });
  });

  it("restores content of a supplied profile, measured by its projection", async () => {
    const { port, alice } = await pair(NOTES);
    alice.document.transact(() => notes(alice.document).insert(0, "gespeichert"));
    const saved = encodeUpdate(alice.document);
    const restarted = await DocumentEngine.join(DOCUMENT_ID, "carol", port, () => {}, {
      ...OPTIONS,
      creatorMemberId: "alice",
      profile: NOTES.id,
      profiles: [NOTES],
      restore: { state: saved },
    });
    expect(notes(restarted.document).toString()).toBe("gespeichert");
    expect(restarted.attribution.ranges).toEqual([
      { start: 0, end: 11, authorId: expect.not.stringMatching(/^carol$/) },
    ]);
  });

  it("refuses a document of a profile it was not given, naming those it has (PRF-3)", async () => {
    const { port } = await pair(NOTES);
    const refusal = await DocumentEngine.join(DOCUMENT_ID, "dave", port, undefined, {
      ...OPTIONS,
      creatorMemberId: "alice",
      profile: NOTES.id,
      profiles: [PARAGRAPHS],
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(UnsupportedProfileError);
    expect((refusal as Error).message).toContain("yjs-paragraphs/1, com.example.paragraphs/1");
  });

  it("refuses a supplied profile with a built-in id, given twice, or with no valid id, before anything is sent", async () => {
    const port = new InMemoryMessengerPort();
    const create = (profiles: DocumentProfile[]) =>
      DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, { ...OPTIONS, profiles });
    await expect(create([{ ...PARAGRAPHS, id: "yjs-paragraphs/1" }])).rejects.toThrow(
      /may not replace the built-in/,
    );
    await expect(create([NOTES, NOTES])).rejects.toThrow(/supplied twice/);
    await expect(create([{ ...NOTES, id: "Not A Profile" }])).rejects.toThrow(
      /no valid profile id/,
    );
    await expect(port.receive(DOCUMENT_ID, "x")).rejects.toThrow(); // never even registered
  });
});
