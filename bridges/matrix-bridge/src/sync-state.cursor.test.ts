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
 * The cursor (TRN-18, TRN-21): what came after a delivery, in the window's order, and `truncated`
 * where something after it may have come and gone unseen — a delivery the window dropped, one it
 * never held, and a `/sync` round the homeserver answered with a `limited` timeline, which left
 * out events between rounds.
 */

const ROOM = "!room:homeserver.test";
const DOC = "doc-1";
const ALICE = "@alice:homeserver.test";

const frame = (eventId: string) => ({
  type: "de.wappensc.together.tdsp.frame",
  event_id: eventId,
  sender: ALICE,
  content: { tdsp: 1, documentId: DOC, frame: "e30=" },
});

const crypto: CryptoMachine = {
  userId: "@bob:homeserver.test",
  deviceId: "DEVICE",
  ensureRoomKeyShared: async () => {},
  encryptRoomEvent: async () => ({}),
  decryptRoomEvent: async () => ({ ok: false, reason: "not used" }),
  receiveSync: async () => {},
  close: () => {},
};

describe("reading a limited timeline", () => {
  it("names the rooms whose timeline the homeserver answered limited", () => {
    const read = readSyncAnswer({
      next_batch: "s1",
      rooms: {
        join: {
          [ROOM]: { timeline: { events: [frame("$a")], limited: true } },
          "!other:homeserver.test": { timeline: { events: [frame("$b")], limited: false } },
        },
      },
    });
    expect([...read.limitedRooms]).toEqual([ROOM]);
  });
});

describe("the Matrix bridge's cursor (TRN-18, TRN-21)", () => {
  let dir: string;
  let rounds: { events: unknown[]; limited?: boolean }[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "matrix-cursor-"));
    rounds = [];
    let round = 0;
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      if (!String(input).includes("/sync")) {
        return new Response("unexpected", { status: 500 });
      }
      const answer = round === 0 ? { events: [] } : (rounds[round - 1] ?? { events: [] });
      round += 1;
      return Response.json({
        next_batch: `s${round}`,
        rooms: {
          join: {
            [ROOM]: { timeline: { events: answer.events, limited: answer.limited ?? false } },
          },
        },
      });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  async function stateAfter(count: number) {
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
    const state = createSyncState(
      { homeserverUrl: "http://homeserver.test", accessToken: "t" },
      bindStorePath,
      crypto,
      createLogger({ component: "test", sink: () => {} }),
      { maxCount: 3, maxPayloadChars: 1_000_000 },
    );
    for (let i = 0; i <= count; i += 1) {
      await state.pollOnce();
    }
    return state;
  }

  const ids = (answer: { deliveries: readonly { id: string }[] }) =>
    answer.deliveries.map((d) => d.id);

  it("answers what came after a cursor in order, and truncated for one the window dropped or never held", async () => {
    rounds = [{ events: [frame("$1"), frame("$2")] }, { events: [frame("$3"), frame("$4")] }];
    const state = await stateAfter(2);
    expect(state.getDeliveriesSince(DOC, "$2")).toEqual({
      deliveries: state.getDeliveries(DOC).slice(1),
      truncated: false,
    });
    expect(ids(state.getDeliveriesSince(DOC, "$2"))).toEqual(["$3", "$4"]);
    // The window keeps three: $1 is dropped (BRG-17).
    expect(state.getDeliveriesSince(DOC, "$1").truncated).toBe(true);
    expect(state.getDeliveriesSince(DOC, "never").truncated).toBe(true);
    expect(state.getDeliveriesSince(DOC, undefined).truncated).toBe(false);
  });

  it("reads a cursor from before a limited timeline as truncated, and one from after it as not", async () => {
    rounds = [
      { events: [frame("$1")] },
      // The homeserver left out what came between: whatever it was is gone for this bridge.
      { events: [frame("$9")], limited: true },
      { events: [frame("$10")] },
    ];
    const state = await stateAfter(3);
    expect(state.getDeliveriesSince(DOC, "$1").truncated).toBe(true);
    expect(ids(state.getDeliveriesSince(DOC, "$1"))).toEqual(["$9", "$10"]);
    expect(state.getDeliveriesSince(DOC, "$9").truncated).toBe(false);
    expect(ids(state.getDeliveriesSince(DOC, "$9"))).toEqual(["$10"]);
  });
});
