import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ATTACHMENT_FRAME_LIMIT,
  BODY_FRAME_LIMIT,
  openAttachment,
  parseAttachmentRef,
  sha256Hex,
} from "./attachment.ts";
import type { CryptoMachine } from "./crypto-machine.ts";
import { MatrixApiError } from "./matrix-api.ts";
import { createMatrixRoomWriter } from "./server.ts";

/**
 * How the sending side chooses between an event body and a media file, against a
 * homeserver this file controls: where the line is, what leaves the machine in an encrypted room
 * (the homeserver must see ciphertext and no key), and what happens when the upload or the event
 * is refused. The real Synapse round trip is `attachments.test.ts`.
 */

const HOME = "http://homeserver.test";
const ROOM = "!room:homeserver.test";
const DOC = "doc-1";

const bytesOf = (length: number, seed = 1): Uint8Array =>
  // Printable ASCII: the UTF-8 bytes of a frame's text (SPECIFICATION.md §13.1).
  Uint8Array.from({ length }, (_, i) => 32 + (((i * 2654435761 + seed * 40503) >>> 24) % 95));
const textOf = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

interface Sent {
  eventType: string;
  content: Record<string, unknown>;
}

class FakeHomeserver {
  sent: Sent[] = [];
  uploads: { bytes: Uint8Array; contentType: string | null }[] = [];
  /** Everything that reached the homeserver, as text, for asserting what it never saw. */
  wire: string[] = [];
  uploadStatus = 200;
  sendStatus = 200;

  handle = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (url.includes("/_matrix/media/v3/upload")) {
      const body = new Uint8Array(init?.body as Uint8Array);
      this.wire.push(Buffer.from(body).toString("latin1"));
      if (this.uploadStatus !== 200) {
        return new Response("upload refused", { status: this.uploadStatus });
      }
      this.uploads.push({ bytes: body, contentType: headers.get("content-type") });
      return Response.json({ content_uri: `mxc://homeserver.test/up${this.uploads.length}` });
    }
    const send = /\/rooms\/[^/]+\/send\/([^/]+)\//.exec(url);
    if (send) {
      const text = String(init?.body);
      this.wire.push(text);
      if (this.sendStatus !== 200) {
        return new Response("send refused", { status: this.sendStatus });
      }
      this.sent.push({
        eventType: decodeURIComponent(send[1] as string),
        content: JSON.parse(text),
      });
      return Response.json({ event_id: `$event${this.sent.length}` });
    }
    if (url.includes("/joined_members")) {
      return Response.json({
        joined: { "@alice:homeserver.test": {}, "@bob:homeserver.test": {} },
      });
    }
    return new Response("unexpected", { status: 500 });
  };
}

describe("the sending side's choice between a body and a file", () => {
  let homeserver: FakeHomeserver;
  let encryptedInner: { eventType: string; content: Record<string, unknown> }[];
  let crypto: CryptoMachine;
  let writer: ReturnType<typeof createMatrixRoomWriter>;

  beforeEach(() => {
    homeserver = new FakeHomeserver();
    encryptedInner = [];
    crypto = {
      userId: "@alice:homeserver.test",
      deviceId: "D",
      ensureRoomKeyShared: async () => {},
      encryptRoomEvent: async (_room, eventType, content) => {
        encryptedInner.push({ eventType, content: content as Record<string, unknown> });
        // What the homeserver gets: opaque, and carrying nothing of the inner content.
        return { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "opaque", session_id: "s" };
      },
      decryptRoomEvent: async () => ({ ok: false, reason: "not used" }),
      receiveSync: async () => {},
      close: () => {},
    };
    vi.stubGlobal("fetch", homeserver.handle);
    writer = createMatrixRoomWriter({ homeserverUrl: HOME, accessToken: "t" }, crypto);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("in an ordinary room", () => {
    it("puts a frame up to the body limit in the event, with no upload", async () => {
      const frame = bytesOf(BODY_FRAME_LIMIT);
      await writer.sendEdit(ROOM, DOC, textOf(frame), false);
      expect(homeserver.uploads).toEqual([]);
      expect(homeserver.sent).toHaveLength(1);
      expect(homeserver.sent[0]?.eventType).toBe("de.wappensc.together.tdsp.frame");
      expect(homeserver.sent[0]?.content).toEqual({
        tdsp: 1,
        documentId: DOC,
        frame: textOf(frame),
      });
    });

    it("uploads a frame one byte over the limit and sends a reference to it, exactly what was uploaded", async () => {
      const frame = bytesOf(BODY_FRAME_LIMIT + 1);
      await writer.sendEdit(ROOM, DOC, textOf(frame), false);
      expect(homeserver.uploads).toHaveLength(1);
      expect(homeserver.uploads[0]?.bytes).toEqual(frame);
      expect(homeserver.uploads[0]?.contentType).toBe("application/octet-stream");
      const [event] = homeserver.sent;
      expect(event?.eventType).toBe("de.wappensc.together.tdsp.frame");
      expect(event?.content).toEqual({
        tdsp: 1,
        documentId: DOC,
        attachment: {
          url: "mxc://homeserver.test/up1",
          size: frame.length,
          sha256: sha256Hex(frame), // lowercase hex, as every TDSP binding writes it
        },
      });
      expect(event?.content.frame).toBeUndefined();
    });

    it("sends a reference the receiver's own parser accepts", async () => {
      await writer.sendEdit(ROOM, DOC, textOf(bytesOf(100_000)), false);
      const [event] = homeserver.sent;
      expect(parseAttachmentRef(event?.content.attachment)).toBeDefined();
    });

    it("carries a frame of exactly the bound, and refuses one byte over it without uploading anything", async () => {
      await writer.sendEdit(ROOM, DOC, textOf(bytesOf(ATTACHMENT_FRAME_LIMIT)), false);
      expect(homeserver.uploads).toHaveLength(1);
      homeserver.uploads = [];
      homeserver.sent = [];
      const refusal = await writer
        .sendEdit(ROOM, DOC, textOf(bytesOf(ATTACHMENT_FRAME_LIMIT + 1)), false)
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(MatrixApiError);
      expect((refusal as MatrixApiError).status).toBe(413);
      expect(homeserver.uploads).toEqual([]);
      expect(homeserver.sent).toEqual([]);
    });

    it("sends an invite message as a plain m.room.message, never wrapped in the tdsp event type", async () => {
      // A resync request's own state now sends through sendEdit like any
      // other frame — already covered by this
      // file's own sendEdit tests above; nothing resync-specific is left
      // at this layer.
      await writer.sendInviteMessage(ROOM, "hello", false);
      expect(homeserver.uploads).toEqual([]);
      expect(homeserver.sent.map((sent) => sent.eventType)).toEqual(["m.room.message"]);
    });
  });

  describe("in an encrypted room", () => {
    it("encrypts a frame within the body limit as an event and uploads nothing", async () => {
      const frame = bytesOf(BODY_FRAME_LIMIT, 2);
      await writer.sendEdit(ROOM, DOC, textOf(frame), true);
      expect(homeserver.uploads).toEqual([]);
      expect(homeserver.sent.map((sent) => sent.eventType)).toEqual(["m.room.encrypted"]);
      expect(encryptedInner[0]?.content.frame).toBe(textOf(frame));
    });

    it("uploads the ciphertext, and puts the key only inside the event that is encrypted", async () => {
      const frame = bytesOf(100_000, 3);
      await writer.sendEdit(ROOM, DOC, textOf(frame), true);

      // What was uploaded is not the frame, and is the same length (a stream cipher).
      expect(homeserver.uploads).toHaveLength(1);
      const uploaded = homeserver.uploads[0]?.bytes as Uint8Array;
      expect(uploaded).toHaveLength(frame.length);
      expect(Buffer.from(uploaded).equals(Buffer.from(frame))).toBe(false);

      // What went into the encryption is a reference with the key, and it opens the upload.
      expect(encryptedInner).toHaveLength(1);
      expect(encryptedInner[0]?.eventType).toBe("de.wappensc.together.tdsp.frame");
      const inner = encryptedInner[0]?.content as { attachment: unknown; frame?: unknown };
      expect(inner.frame).toBeUndefined();
      const ref = parseAttachmentRef(inner.attachment);
      expect(ref?.file?.url).toBe("mxc://homeserver.test/up1");
      expect(ref?.url).toBeUndefined();
      expect(ref?.size).toBe(frame.length);
      expect(openAttachment(ref as NonNullable<typeof ref>, uploaded)).toEqual(frame);

      // What the homeserver was sent is the ciphertext and an opaque event: never the key, never the frame.
      const key = ref?.file?.key.k as string;
      expect(homeserver.sent.map((sent) => sent.eventType)).toEqual(["m.room.encrypted"]);
      for (const seen of homeserver.wire) {
        expect(seen).not.toContain(key);
        expect(seen).not.toContain(textOf(frame).slice(0, 200)); // the frame's text, in no request
      }
    });

    it("uses a different key for every attachment", async () => {
      await writer.sendEdit(ROOM, DOC, textOf(bytesOf(50_000, 4)), true);
      await writer.sendEdit(ROOM, DOC, textOf(bytesOf(50_000, 4)), true);
      const keys = encryptedInner.map(
        (entry) =>
          (entry.content as { attachment: { file: { key: { k: string } } } }).attachment.file.key.k,
      );
      expect(new Set(keys).size).toBe(2);
      expect(
        Buffer.from(homeserver.uploads[0]?.bytes as Uint8Array).equals(
          Buffer.from(homeserver.uploads[1]?.bytes as Uint8Array),
        ),
      ).toBe(false);
    });

    it("refuses one byte over the bound before encrypting or uploading anything", async () => {
      const refusal = await writer
        .sendEdit(ROOM, DOC, textOf(bytesOf(ATTACHMENT_FRAME_LIMIT + 1)), true)
        .catch((error: unknown) => error);
      expect((refusal as MatrixApiError).status).toBe(413);
      expect(homeserver.uploads).toEqual([]);
      expect(encryptedInner).toEqual([]);
    });
  });

  describe("when the homeserver refuses", () => {
    it.each([
      [413, "the file is over the homeserver's own upload limit"],
      [429, "it rate-limits"],
      [500, "it failed"],
    ])(
      "the upload with %i (%s): the failure keeps its status, and no event is sent that points at nothing",
      async (status) => {
        homeserver.uploadStatus = status;
        const failure = await writer
          .sendEdit(ROOM, DOC, textOf(bytesOf(100_000)), false)
          .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(MatrixApiError);
        expect((failure as MatrixApiError).status).toBe(status);
        expect(homeserver.sent).toEqual([]);
      },
    );

    it("the upload in an encrypted room: nothing is sent either", async () => {
      homeserver.uploadStatus = 500;
      const failure = await writer
        .sendEdit(ROOM, DOC, textOf(bytesOf(100_000)), true)
        .catch((error: unknown) => error);
      expect((failure as MatrixApiError).status).toBe(500);
      expect(homeserver.sent).toEqual([]);
    });

    it("the event, after a successful upload: the failure keeps its status so the client can try again", async () => {
      homeserver.sendStatus = 429;
      const failure = await writer
        .sendEdit(ROOM, DOC, textOf(bytesOf(100_000)), false)
        .catch((error: unknown) => error);
      expect((failure as MatrixApiError).status).toBe(429);
    });

    it("an upload answered without a content URI is a failure, not a reference to nothing", async () => {
      vi.stubGlobal("fetch", async (input: string | URL | Request) =>
        String(input).includes("/upload") ? Response.json({}) : homeserver.handle(input),
      );
      const failure = await writer
        .sendEdit(ROOM, DOC, textOf(bytesOf(100_000)), false)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(MatrixApiError);
      expect(homeserver.sent).toEqual([]);
    });
  });
});
