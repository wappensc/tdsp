import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ATTACHMENT_FRAME_LIMIT, BODY_FRAME_LIMIT, sha256Hex } from "./attachment.ts";
import type { CryptoMachine } from "./crypto-machine.ts";
import { createMatrixRoomWriter } from "./server.ts";
import { FRAME_EVENT_TYPE, readFrameEnvelope } from "./sync-state.ts";

/**
 * The Matrix binding's wire, frozen (docs/testing.md, "Wire compatibility";
 * SPECIFICATION.md §13.3): the room event the bridge sends for a frame — its type, and its
 * content with the frame inline up to the body limit or as a media file above it — and how it
 * reads that content back. In an encrypted room this same content is what Megolm encrypts. A
 * difference is a wire change only the CI role may accept (tools/wire-lock.ts). Only the CI
 * role may change this file (.github/CODEOWNERS).
 */

const read = (relative: string): string =>
  readFileSync(new URL(`../../../${relative}`, import.meta.url), "utf8");

const WIRE = JSON.parse(read("wire/matrix-v1.json")) as {
  version: number;
  constants: { BODY_FRAME_LIMIT: number; ATTACHMENT_FRAME_LIMIT: number; EVENT_TYPE: string };
  entries: {
    name: string;
    documentId: string;
    frame: string;
    eventType: string;
    content: string;
    uploads: number;
    mediaUrl?: string;
  }[];
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A homeserver that records the one event it is sent, and answers an upload with `mediaUrl`. */
function homeserver(mediaUrl = "mxc://homeserver.test/media1") {
  const seen: { eventType?: string; content?: string; uploads: Uint8Array[] } = { uploads: [] };
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/_matrix/media/v3/upload")) {
      seen.uploads.push(new Uint8Array(init?.body as Uint8Array));
      return Response.json({ content_uri: mediaUrl });
    }
    const send = /\/rooms\/[^/]+\/send\/([^/]+)\//.exec(url);
    if (send) {
      seen.eventType = decodeURIComponent(send[1] as string);
      seen.content = String(init?.body);
      return Response.json({ event_id: "$e1" });
    }
    return new Response("unexpected", { status: 500 });
  });
  return seen;
}

describe("Matrix room events at envelope version 1", () => {
  it("keep the limits and the event type a sender and a receiver agree on", () => {
    expect({ BODY_FRAME_LIMIT, ATTACHMENT_FRAME_LIMIT, EVENT_TYPE: FRAME_EVENT_TYPE }).toEqual(
      WIRE.constants,
    );
  });

  it.each(WIRE.entries.map((entry) => [entry.name, entry] as const))(
    "%s: sent byte for byte, and read back",
    async (_name, entry) => {
      const seen = homeserver(entry.mediaUrl);
      // An ordinary room: nothing is encrypted, so nothing may ask the crypto machine.
      const crypto = {} as CryptoMachine;
      await createMatrixRoomWriter(
        { homeserverUrl: "http://homeserver.test", accessToken: "t" },
        crypto,
      ).sendEdit("!room:homeserver.test", entry.documentId, entry.frame, false);
      expect(seen.eventType).toBe(entry.eventType);
      expect(seen.content).toBe(entry.content);
      expect(seen.uploads).toHaveLength(entry.uploads);

      const read = readFrameEnvelope(JSON.parse(entry.content));
      expect(read?.documentId).toBe(entry.documentId);
      if (entry.uploads === 0) {
        expect(read?.frame).toBe(entry.frame);
        return;
      }
      const bytes = new TextEncoder().encode(entry.frame);
      expect(Buffer.from(seen.uploads[0] as Uint8Array)).toEqual(Buffer.from(bytes));
      expect(read?.attachment).toMatchObject({
        size: bytes.length,
        sha256: sha256Hex(bytes),
      });
    },
  );
});
