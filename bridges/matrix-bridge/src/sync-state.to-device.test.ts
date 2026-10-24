import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@tdsp/bridge-log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveBindStore } from "./bind-store.ts";
import type { CryptoMachine } from "./crypto-machine.ts";
import { createSyncState } from "./sync-state.ts";

/**
 * Any Matrix user can send this bridge's device a to-device event, nested as deep as they like.
 * The crypto machine takes the round's to-device events as one JSON text, and `JSON.stringify`
 * throws on a deep enough value in some Node.js versions (measured: Node 24 at 8 000 levels;
 * Node 26 does not). The round's position has moved on by then, so its frames would be lost for
 * good (TRN-7). No to-device event the bridge needs nests more than a few levels.
 */

const ROOM = "!room:homeserver.test";
const DOC = "doc-1";

/**
 * A JSON value nested `levels` deep, as text. Written by hand, not with `JSON.stringify`, which is
 * the very call that throws on such a value in some Node.js versions.
 */
const nestedJson = (levels: number): string => `${"[".repeat(levels)}"x"${"]".repeat(levels)}`;

describe("a to-device event nested deeper than any message needs", () => {
  const passed: unknown[][] = [];
  const logged: string[] = [];

  beforeEach(() => {
    passed.length = 0;
    logged.length = 0;
    let round = 0;
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      if (!String(input).includes("/_matrix/client/v3/sync")) {
        return new Response("unexpected", { status: 500 });
      }
      round += 1;
      if (round === 1) {
        return Response.json({ next_batch: "s1" });
      }
      const roomKey = JSON.stringify({
        type: "m.room_key",
        sender: "@alice:homeserver.test",
        content: { room_id: ROOM },
      });
      const deep = `{"type":"m.dummy","sender":"@mallory:homeserver.test","content":${nestedJson(10_000)}}`;
      const rooms = JSON.stringify({
        join: {
          [ROOM]: {
            timeline: {
              events: [
                {
                  type: "de.wappensc.together.tdsp.frame",
                  event_id: "$frame",
                  sender: "@alice:homeserver.test",
                  content: { tdsp: 1, documentId: DOC, frame: "AQID" },
                },
              ],
            },
          },
        },
      });
      return new Response(
        `{"next_batch":"s${round}","to_device":{"events":[${roomKey},${deep}]},"rooms":${rooms}}`,
        { headers: { "content-type": "application/json" } },
      );
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is left out of what the crypto machine gets, and the round's frames are delivered", async () => {
    const bindStorePath = join(tmpdir(), `matrix-to-device-test-${Math.random()}.json`);
    saveBindStore(bindStorePath, {
      [DOC]: {
        roomId: ROOM,
        creatorMemberId: "@alice:homeserver.test",
        profile: "yjs-paragraphs/1",
        createdAt: "2026-01-01T00:00:00Z",
        encrypted: false,
      },
    });
    const crypto: CryptoMachine = {
      userId: "@bob:homeserver.test",
      deviceId: "DEVICE",
      ensureRoomKeyShared: async () => {},
      encryptRoomEvent: async () => {
        throw new Error("not used");
      },
      decryptRoomEvent: async () => ({ ok: false, reason: "not used" }),
      receiveSync: async (toDeviceEvents) => {
        passed.push([...toDeviceEvents]);
      },
      close: () => {},
    };
    const state = createSyncState(
      { homeserverUrl: "http://homeserver.test", accessToken: "t" },
      bindStorePath,
      crypto,
      createLogger({ component: "test", sink: (_line, record) => logged.push(record.event) }),
    );
    await state.pollOnce(); // the baseline
    await state.pollOnce();

    expect(passed[1]?.map((event) => (event as { type: string }).type)).toEqual(["m.room_key"]);
    expect(state.getDeliveries(DOC).map((delivery) => delivery.payload)).toEqual(["AQID"]);
    expect(logged).toContain("to-device-event-too-deep");
  });
});
