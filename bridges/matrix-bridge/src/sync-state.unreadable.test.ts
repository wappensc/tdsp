import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@tdsp/bridge-log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveBindStore } from "./bind-store.ts";
import type { CryptoMachine } from "./crypto-machine.ts";
import { readSyncAnswer } from "./matrix-api.ts";
import { createSyncState } from "./sync-state.ts";

/**
 * A message the bridge cannot read does not keep it from reading the others (BRG-18): whoever can
 * reach the account chooses part of what a `/sync` answer holds, and a bridge that failed on the
 * whole answer would lose the round's other events, since its position has moved on already.
 */

const ROOM = "!room:homeserver.test";
const DOC = "doc-1";
const ALICE = "@alice:homeserver.test";
const FRAME = "de.wappensc.together.tdsp.frame";

const frame = (eventId: string) => ({
  type: FRAME,
  event_id: eventId,
  sender: ALICE,
  content: { tdsp: 1, documentId: DOC, frame: "e30=" },
});

describe("reading a /sync answer (BRG-18)", () => {
  const answer = (body: Record<string, unknown>) => readSyncAnswer({ next_batch: "s1", ...body });

  it("drops what is not an event, and reads the events beside it", () => {
    const events = [
      null,
      5,
      "x",
      [],
      { type: FRAME, sender: ALICE, content: {} }, // no event_id
      { type: 5, event_id: "$t", sender: ALICE, content: {} },
      { type: FRAME, event_id: "$s", sender: {}, content: {} },
      { type: FRAME, event_id: "$u", sender: ALICE, content: {}, unsigned: "x" },
      frame("$good"),
    ];
    const read = answer({ rooms: { join: { [ROOM]: { timeline: { events } } } } });
    expect(read.roomEvents.get(ROOM)?.map((event) => event.event_id)).toEqual(["$good"]);
  });

  it("reads a room whose timeline is not a list, and fields of the wrong kind, as empty", () => {
    const read = answer({
      rooms: {
        join: {
          "!a:homeserver.test": { timeline: { events: "xyz" } },
          "!b:homeserver.test": null,
          [ROOM]: { timeline: { events: [frame("$good")] } },
        },
      },
      to_device: {
        events: [null, { type: "m.room_key", sender: ALICE, content: {} }, { type: 1 }],
      },
      device_lists: { changed: [ALICE, 5, null], left: "x" },
      device_one_time_keys_count: { signed_curve25519: 50, other: "many" },
    });
    expect([...read.roomEvents.keys()]).toEqual([ROOM]);
    expect(read.toDeviceEvents.map((event) => event.type)).toEqual(["m.room_key"]);
    expect(read.deviceListsChanged).toEqual([ALICE]);
    expect(read.deviceListsLeft).toEqual([]);
    expect(read.oneTimeKeyCounts).toEqual({ signed_curve25519: 50 });
    expect(answer({ rooms: "x", to_device: 5, device_lists: null }).roomEvents.size).toBe(0);
  });

  it("reads each room's state block as its timeline, dropping what is not an event (MTX-5)", () => {
    const encryption = {
      type: "m.room.encryption",
      event_id: "$on",
      sender: ALICE,
      state_key: "",
      content: { algorithm: "m.megolm.v1.aes-sha2" },
    };
    const read = answer({
      rooms: { join: { [ROOM]: { state: { events: [null, encryption] }, timeline: {} } } },
    });
    expect(read.roomStateEvents.get(ROOM)?.map((event) => event.type)).toEqual([
      "m.room.encryption",
    ]);
    expect(read.roomEvents.has(ROOM)).toBe(false);
  });

  it("refuses an answer without a position, so that the bridge does not start over", () => {
    expect(() => readSyncAnswer({ rooms: {} })).toThrow(/next_batch/);
    expect(() => readSyncAnswer(null)).toThrow(/next_batch/);
  });
});

describe("one event the bridge cannot read, among others (BRG-18)", () => {
  let dir: string;
  let logged: string[];
  let decrypt: CryptoMachine["decryptRoomEvent"];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "matrix-unreadable-"));
    logged = [];
    decrypt = async () => ({ ok: false, reason: "no key" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Polls a bridge whose `/sync` answers `rounds`, events per room, after a baseline. */
  async function deliveredAfter(rounds: Record<string, unknown[]>[]): Promise<readonly string[]> {
    let round = 0;
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      if (!String(input).includes("/sync")) {
        return new Response("unexpected", { status: 500 });
      }
      const rooms = round === 0 ? {} : (rounds[round - 1] ?? {});
      round += 1;
      const join = Object.fromEntries(
        Object.entries(rooms).map(([roomId, events]) => [roomId, { timeline: { events } }]),
      );
      return Response.json({ next_batch: `s${round}`, rooms: { join } });
    });
    const bindStorePath = join(dir, "tdsp-channels.json");
    saveBindStore(bindStorePath, {
      [DOC]: {
        roomId: ROOM,
        creatorMemberId: ALICE,
        profile: "yjs-paragraphs/1",
        createdAt: "2026-01-01T00:00:00Z",
        encrypted: false,
      },
    });
    const crypto: CryptoMachine = {
      userId: "@bob:homeserver.test",
      deviceId: "DEVICE",
      ensureRoomKeyShared: async () => {},
      encryptRoomEvent: async () => ({}),
      decryptRoomEvent: (event, roomId) => decrypt(event, roomId),
      receiveSync: async () => {},
      close: () => {},
    };
    const state = createSyncState(
      { homeserverUrl: "http://homeserver.test", accessToken: "t" },
      bindStorePath,
      crypto,
      createLogger({ component: "test", sink: (_line, record) => logged.push(record.event) }),
    );
    for (let i = 0; i <= rounds.length; i += 1) {
      await state.pollOnce();
    }
    return state.getDeliveries(DOC).map((delivery) => delivery.id);
  }

  it("delivers the events after one that is not an event, in the same round and the next", async () => {
    await expect(
      deliveredAfter([
        { [ROOM]: [null, frame("$after")] },
        { [ROOM]: [{ event_id: "$no-type" }, frame("$next")] },
      ]),
    ).resolves.toEqual(["$after", "$next"]);
  });

  it("delivers the events after one whose reading throws, and logs it", async () => {
    decrypt = async () => {
      throw new Error("the crypto machine failed");
    };
    const encrypted = {
      type: "m.room.encrypted",
      event_id: "$encrypted",
      sender: ALICE,
      content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "x" },
    };
    // Another room, read first, holds the encrypted event, so that the document's room stays one
    // whose frames arrive in the clear (MTX-5).
    await expect(
      deliveredAfter([{ "!other:homeserver.test": [encrypted], [ROOM]: [frame("$after")] }]),
    ).resolves.toEqual(["$after"]);
    expect(logged).toContain("event-unreadable");
  });
});
