import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@tdsp/bridge-log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveBindStore } from "./bind-store.ts";
import type { CryptoMachine } from "./crypto-machine.ts";
import { createSyncState, type SyncState } from "./sync-state.ts";

/**
 * An event counts for a document only in the room the document is bound to (BRG-10). The account
 * is usually in other rooms too, with other people. Receivers do not reject an edit for its
 * sender's permission (CTL-7): the room's membership is what decides who can write. A frame for a
 * known documentId from another room — sent by someone removed from the document's room, say —
 * must therefore reach nobody, and an edit or a redaction from there must leave no record. These
 * tests depend only on the code they test and on the fakes in this file.
 */

const BOUND = "!document-room:homeserver.test";
const OTHER = "!another-room:homeserver.test";
const DOC = "doc-1";
const ALICE = "@alice:homeserver.test";
const FRAME = "de.wappensc.together.tdsp.frame";

interface TimelineEvent {
  type: string;
  event_id: string;
  sender: string;
  content: unknown;
}

/** A homeserver whose `/sync` answers one round after another, each with events per room. */
class FakeHomeserver {
  syncRounds: Record<string, TimelineEvent[]>[] = [];
  #round = 0;

  handle = async (input: string | URL | Request): Promise<Response> => {
    if (!String(input).includes("/_matrix/client/v3/sync")) {
      return new Response("unexpected", { status: 500 });
    }
    const rooms = this.syncRounds[this.#round] ?? {};
    this.#round += 1;
    const join = Object.fromEntries(
      Object.entries(rooms).map(([roomId, events]) => [roomId, { timeline: { events } }]),
    );
    return Response.json({ next_batch: `s${this.#round}`, rooms: { join } });
  };
}

const frame = (eventId: string, sender: string, payload: string): TimelineEvent => ({
  type: FRAME,
  event_id: eventId,
  sender,
  content: { tdsp: 1, documentId: DOC, frame: payload },
});

const editOf = (eventId: string, target: string): TimelineEvent => ({
  type: FRAME,
  event_id: eventId,
  sender: ALICE,
  content: {
    tdsp: 1,
    documentId: DOC,
    frame: "dGFtcGVyZWQ=",
    "m.new_content": { tdsp: 1, documentId: DOC, frame: "dGFtcGVyZWQ=" },
    "m.relates_to": { rel_type: "m.replace", event_id: target },
  },
});

const redactionOf = (eventId: string, target: string): TimelineEvent => ({
  type: "m.room.redaction",
  event_id: eventId,
  sender: ALICE,
  content: { redacts: target },
});

const crypto = (): CryptoMachine => ({
  userId: "@bob:homeserver.test",
  deviceId: "DEVICE",
  ensureRoomKeyShared: async () => {},
  encryptRoomEvent: async () => {
    throw new Error("not used");
  },
  decryptRoomEvent: async () => ({ ok: false, reason: "not used" }),
  receiveSync: async () => {},
  close: () => {},
});

describe("an event for a document from a room it is not bound to (BRG-10)", () => {
  let homeserver: FakeHomeserver;
  let state: SyncState;

  beforeEach(() => {
    homeserver = new FakeHomeserver();
    vi.stubGlobal("fetch", homeserver.handle);
    const bindStorePath = join(tmpdir(), `matrix-channel-test-${Math.random()}.json`);
    saveBindStore(bindStorePath, {
      [DOC]: {
        roomId: BOUND,
        creatorMemberId: ALICE,
        profile: "yjs-paragraphs/1",
        createdAt: "2026-01-01T00:00:00Z",
        encrypted: false,
      },
    });
    state = createSyncState(
      { homeserverUrl: "http://homeserver.test", accessToken: "t" },
      bindStorePath,
      crypto(),
      createLogger({ component: "test", sink: () => {} }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Runs every round: the first `/sync` only sets the baseline, so it gets none of them. */
  async function pollRounds(...rounds: Record<string, TimelineEvent[]>[]): Promise<void> {
    homeserver.syncRounds = [{}, ...rounds];
    for (let i = 0; i <= rounds.length; i += 1) {
      await state.pollOnce();
    }
  }

  const frames = () => state.getDeliveries(DOC).map((delivery) => delivery.payload);

  it("is never delivered; the same frame from the bound room is", async () => {
    await pollRounds({
      [OTHER]: [frame("$foreign", "@mallory:homeserver.test", "Zm9yZWlnbg==")],
      [BOUND]: [frame("$bound", ALICE, "Ym91bmQ=")],
    });
    expect(frames()).toEqual(["Ym91bmQ="]);
    expect(state.getIntegrityLog(DOC)).toEqual([]);
  });

  it("leaves no record when it edits or redacts a message of the document", async () => {
    await pollRounds(
      { [BOUND]: [frame("$original", ALICE, "b3JpZ2luYWw=")] },
      { [OTHER]: [editOf("$edit", "$original"), redactionOf("$redaction", "$original")] },
    );
    expect(frames()).toEqual(["b3JpZ2luYWw="]);
    expect(state.getIntegrityLog(DOC)).toEqual([]);
  });

  it("leaves no record when it replaces a delivered message under its id, and is not delivered", async () => {
    await pollRounds(
      { [BOUND]: [frame("$original", ALICE, "b3JpZ2luYWw=")] },
      { [OTHER]: [frame("$original", "@mallory:homeserver.test", "dGFtcGVyZWQ=")] },
    );
    expect(frames()).toEqual(["b3JpZ2luYWw="]);
    expect(state.getIntegrityLog(DOC)).toEqual([]);
  });

  it("never enters what a later event under its id is compared by: the bound room's is delivered", async () => {
    await pollRounds(
      { [OTHER]: [frame("$id", "@mallory:homeserver.test", "Zm9yZWlnbg==")] },
      { [BOUND]: [frame("$id", ALICE, "Ym91bmQ=")] },
    );
    expect(frames()).toEqual(["Ym91bmQ="]);
    expect(state.getIntegrityLog(DOC)).toEqual([]);
  });

  it("still records an edit and a redaction from the bound room", async () => {
    await pollRounds(
      { [BOUND]: [frame("$original", ALICE, "b3JpZ2luYWw=")] },
      { [BOUND]: [editOf("$edit", "$original"), redactionOf("$redaction", "$original")] },
    );
    expect(state.getIntegrityLog(DOC).map((entry) => entry.reason)).toEqual([
      "message-edited",
      "message-redacted",
    ]);
  });
});
