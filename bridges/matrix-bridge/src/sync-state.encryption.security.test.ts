import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@tdsp/bridge-log";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveBindStore } from "./bind-store.ts";
import type { CryptoMachine } from "./crypto-machine.ts";
import { createSyncState, type SyncState } from "./sync-state.ts";

/**
 * In an encrypted room the carrier of a frame is a Megolm-encrypted `m.room.encrypted` event
 * (bindings/matrix.md §13.3), and the sender Megolm vouches for is what makes the document's
 * creator check mean anything there (BND-1, §15.1). A homeserver can place an unencrypted event
 * in any room under any member's name; delivered, it would let the homeserver write a frame as the
 * creator. These tests pin that such an event is never delivered, in a room bound as encrypted
 * and in one this bridge has seen turn encrypted since, and that plain rooms are unaffected.
 * They depend only on the code they test and on the fakes in this file.
 */

const HOME = "http://homeserver.test";
const ROOM = "!room:homeserver.test";
const DOC = "doc-1";
const ALICE = "@alice:homeserver.test";
const FRAME = "de.wappensc.together.tdsp.frame";

interface TimelineEvent {
  type: string;
  event_id: string;
  sender: string;
  content: unknown;
}

/** A homeserver whose `/sync` answers one round after another, all in `ROOM`. */
class FakeHomeserver {
  syncRounds: TimelineEvent[][] = [];
  #round = 0;

  handle = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.includes("/_matrix/client/v3/sync")) {
      const events = this.syncRounds[this.#round] ?? [];
      this.#round += 1;
      return Response.json({
        next_batch: `s${this.#round}`,
        rooms: { join: events.length > 0 ? { [ROOM]: { timeline: { events } } } : {} },
      });
    }
    return new Response("unexpected", { status: 500 });
  };
}

/** A frame as an unencrypted TDSP event: what only a plain room may carry. */
const plainFrame = (eventId: string, frame: string): TimelineEvent => ({
  type: FRAME,
  event_id: eventId,
  sender: ALICE,
  content: { tdsp: 1, documentId: DOC, frame },
});

/** A frame as an `m.room.encrypted` event; the fake crypto below "decrypts" its `frame`. */
const encryptedFrame = (eventId: string, frame: string): TimelineEvent => ({
  type: "m.room.encrypted",
  event_id: eventId,
  sender: ALICE,
  content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: frame },
});

/** The state event that turns a room's encryption on; Matrix never turns it off again. */
const encryptionTurnedOn = (eventId: string): TimelineEvent => ({
  type: "m.room.encryption",
  event_id: eventId,
  sender: ALICE,
  content: { algorithm: "m.megolm.v1.aes-sha2" },
});

/** Decrypts an `encryptedFrame` back into the TDSP event it stands for, as Megolm would. */
const fakeCrypto = (): CryptoMachine => ({
  userId: "@bob:homeserver.test",
  deviceId: "DEVICE",
  ensureRoomKeyShared: async () => {},
  encryptRoomEvent: async () => {
    throw new Error("not used");
  },
  decryptRoomEvent: async (rawEvent) => {
    const { sender, content } = rawEvent as TimelineEvent;
    const frame = (content as { ciphertext: string }).ciphertext;
    return { ok: true, type: FRAME, sender, content: { tdsp: 1, documentId: DOC, frame } };
  },
  receiveSync: async () => {},
  close: () => {},
});

describe("an unencrypted frame where the room is encrypted (§13.3)", () => {
  let homeserver: FakeHomeserver;
  const logged: string[] = [];

  beforeEach(() => {
    logged.length = 0;
    homeserver = new FakeHomeserver();
    vi.stubGlobal("fetch", homeserver.handle);
  });

  function syncStateBoundAs(encrypted: boolean): SyncState {
    const bindStorePath = join(tmpdir(), `matrix-encryption-test-${Math.random()}.json`);
    saveBindStore(bindStorePath, {
      [DOC]: {
        roomId: ROOM,
        creatorMemberId: ALICE,
        profile: "yjs-paragraphs/1",
        createdAt: "2026-01-01T00:00:00Z",
        encrypted,
      },
    });
    const logger = createLogger({
      component: "test",
      sink: (_line, record) => logged.push(record.event),
    });
    return createSyncState(
      { homeserverUrl: HOME, accessToken: "t" },
      bindStorePath,
      fakeCrypto(),
      logger,
    );
  }

  /** Runs every round: the first `/sync` only sets the baseline, so it gets none of them. */
  async function pollRounds(state: SyncState, ...rounds: TimelineEvent[][]): Promise<void> {
    homeserver.syncRounds = [[], ...rounds];
    for (let i = 0; i <= rounds.length; i += 1) {
      await state.pollOnce();
    }
  }

  const frames = (state: SyncState) => state.getDeliveries(DOC).map((delivery) => delivery.payload);

  it("is never delivered in a room bound as encrypted; the encrypted one is", async () => {
    const state = syncStateBoundAs(true);
    await pollRounds(state, [
      plainFrame("$forged", "Zm9yZ2Vk"),
      encryptedFrame("$real", "cmVhbA=="),
    ]);
    expect(frames(state)).toEqual(["cmVhbA=="]);
    expect(logged).toContain("unencrypted-frame-in-encrypted-room");
  });

  it("is never delivered once the room's encryption was turned on, though it was bound as plain", async () => {
    const state = syncStateBoundAs(false);
    await pollRounds(
      state,
      [plainFrame("$before", "YmVmb3Jl")],
      [encryptionTurnedOn("$on")],
      [plainFrame("$after", "YWZ0ZXI=")],
    );
    expect(frames(state)).toEqual(["YmVmb3Jl"]);
  });

  it("is never delivered once an encrypted event arrived in a room bound as plain", async () => {
    const state = syncStateBoundAs(false);
    await pollRounds(state, [encryptedFrame("$e", "ZW5j"), plainFrame("$p", "cGxhaW4=")]);
    expect(frames(state)).toEqual(["ZW5j"]);
  });

  it("is delivered in a plain room, as before", async () => {
    const state = syncStateBoundAs(false);
    await pollRounds(state, [plainFrame("$one", "b25l")], [plainFrame("$two", "dHdv")]);
    expect(frames(state)).toEqual(["b25l", "dHdv"]);
  });
});
