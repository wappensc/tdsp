import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@tdsp/bridge-log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptAttachment, sha256Hex } from "./attachment.ts";
import { saveBindStore } from "./bind-store.ts";
import type { CryptoMachine } from "./crypto-machine.ts";
import { createSyncState, type SyncState } from "./sync-state.ts";

/**
 * How the receiving side treats an attachment, against a `fetch` this file
 * controls: which failures are tried again and which are final, how long the wait grows, what is
 * held meanwhile and how much. The real Synapse round trip is `attachments.test.ts`; what only a
 * fake can do is make a download fail on purpose, and count what was fetched.
 */

const HOME = "http://homeserver.test";
const ROOM = "!room:homeserver.test";
const DOC = "doc-1";
const EDIT = "de.wappensc.together.tdsp.frame";
const OTHER_TYPE = "m.room.message"; // any non-edit type — ordinary human chat, from this bridge's own point of view
const MXC = (id: string) => `mxc://homeserver.test/${id}`;

const bytesOf = (length: number, seed: number): Uint8Array =>
  // Printable ASCII: the UTF-8 bytes of a frame's text (SPECIFICATION.md §13.1).
  Uint8Array.from({ length }, (_, i) => 32 + (((i * 2654435761 + seed * 40503) >>> 24) % 95));
const textOf = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

interface TimelineEvent {
  type: string;
  event_id: string;
  sender: string;
  content: unknown;
}

/** A homeserver reduced to what the receiver asks of it: `/sync` rounds handed out in order, and media by id. */
class FakeHomeserver {
  syncRounds: TimelineEvent[][] = [];
  media = new Map<string, () => Response>();
  mediaRequests: string[] = [];
  mediaPaths: string[] = [];
  /** A homeserver from before authenticated media: it does not know the newer download endpoint. */
  legacyOnly = false;
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
    const match = /(\/_matrix\/(?:client\/v1\/media|media\/v3)\/download)\/[^/]+\/([^/?]+)/.exec(
      url,
    );
    if (match) {
      const id = decodeURIComponent(match[2] as string);
      this.mediaRequests.push(id);
      this.mediaPaths.push(match[1] as string);
      if (this.legacyOnly && match[1] === "/_matrix/client/v1/media/download") {
        return new Response("unrecognized", { status: 404 });
      }
      const serve = this.media.get(id);
      return serve ? serve() : new Response("not found", { status: 404 });
    }
    return new Response("unexpected", { status: 500 });
  };

  serve(id: string, bytes: Uint8Array): void {
    this.media.set(id, () => new Response(new Uint8Array(bytes)));
  }

  failWith(id: string, status: number): void {
    this.media.set(id, () => new Response("no", { status }));
  }
}

const plainEvent = (eventId: string, mediaId: string, frame: Uint8Array): TimelineEvent => ({
  type: EDIT,
  event_id: eventId,
  sender: "@alice:homeserver.test",
  content: {
    tdsp: 1,
    documentId: DOC,
    attachment: { url: MXC(mediaId), size: frame.length, sha256: sha256Hex(frame) },
  },
});

describe("a receiver's handling of attachments", () => {
  let dir: string;
  let bindStorePath: string;
  let now: number;
  let homeserver: FakeHomeserver;
  let state: SyncState;
  let decrypt: CryptoMachine["decryptRoomEvent"];
  const silent = createLogger({ component: "test", sink: () => {} });

  const crypto = (): CryptoMachine => ({
    userId: "@bob:homeserver.test",
    deviceId: "DEVICE",
    ensureRoomKeyShared: async () => {},
    encryptRoomEvent: async () => {
      throw new Error("not used");
    },
    decryptRoomEvent: (raw, roomId) => decrypt(raw, roomId),
    receiveSync: async () => {},
    close: () => {},
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "matrix-bridge-attachments-"));
    bindStorePath = join(dir, "channels.json");
    saveBindStore(bindStorePath, {
      [DOC]: {
        roomId: ROOM,
        creatorMemberId: "@alice:homeserver.test",
        profile: "yjs-paragraphs/1",
        createdAt: "2026-01-01T00:00:00Z",
        encrypted: false,
      },
    });
    homeserver = new FakeHomeserver();
    decrypt = async () => ({ ok: false, reason: "no key" });
    vi.stubGlobal("fetch", homeserver.handle);
    vi.useFakeTimers({ toFake: ["Date"] });
    now = 1_000_000_000_000;
    vi.setSystemTime(now);
    state = createSyncState(
      { homeserverUrl: HOME, accessToken: "t" },
      bindStorePath,
      crypto(),
      silent,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Runs the baseline poll (which discards what it finds) and then one poll per round. */
  async function poll(...rounds: TimelineEvent[][]): Promise<void> {
    homeserver.syncRounds = [[], ...rounds];
    await state.pollOnce();
    for (let i = 0; i < rounds.length; i += 1) {
      await state.pollOnce();
    }
  }

  const advance = (ms: number) => {
    now += ms;
    vi.setSystemTime(now);
  };

  const payloads = () => state.getDeliveries(DOC).map((delivery) => delivery.payload);

  it("downloads a plain attachment and delivers the frame it holds, with the event's sender and id", async () => {
    const frame = bytesOf(50_000, 1);
    homeserver.serve("a", frame);
    await poll([plainEvent("$e1", "a", frame)]);
    expect(state.getDeliveries(DOC)).toEqual([
      { id: "$e1", documentId: DOC, sender: "@alice:homeserver.test", payload: textOf(frame) },
    ]);
  });

  it("downloads an encrypted attachment named inside a decrypted event, and decrypts it", async () => {
    const frame = bytesOf(50_000, 2);
    const { ciphertext, file } = encryptAttachment(frame);
    homeserver.serve("enc", ciphertext);
    decrypt = async () => ({
      ok: true,
      type: EDIT,
      sender: "@alice:homeserver.test",
      content: {
        tdsp: 1,
        documentId: DOC,
        attachment: { size: frame.length, file: { ...file, url: MXC("enc") } },
      },
    });
    await poll([
      { type: "m.room.encrypted", event_id: "$enc", sender: "@alice:homeserver.test", content: {} },
    ]);
    expect(payloads()).toEqual([textOf(frame)]);
    expect(state.getDeliveries(DOC)[0]?.id).toBe("$enc");
  });

  it("does not deliver an encrypted attachment whose file was swapped for another, and does not try again", async () => {
    const frame = bytesOf(2000, 3);
    const { file } = encryptAttachment(frame);
    homeserver.serve("swapped", encryptAttachment(bytesOf(2000, 4)).ciphertext);
    decrypt = async () => ({
      ok: true,
      type: EDIT,
      sender: "@alice:homeserver.test",
      content: {
        tdsp: 1,
        documentId: DOC,
        attachment: { size: 2000, file: { ...file, url: MXC("swapped") } },
      },
    });
    await poll([{ type: "m.room.encrypted", event_id: "$x", sender: "@a:h", content: {} }], []);
    advance(3_600_000);
    await poll([]);
    expect(state.getDeliveries(DOC)).toEqual([]);
    expect(homeserver.mediaRequests).toEqual(["swapped"]);
  });

  describe("a download that fails", () => {
    it.each([
      [404, "the file is gone"],
      [403, "the file is forbidden"],
      [400, "the request is refused"],
    ])(
      "for good with %i (%s) is dropped at once and never fetched again, and what follows still arrives",
      async (status) => {
        const frame = bytesOf(1000, 5);
        const next = bytesOf(1000, 6);
        homeserver.failWith("gone", status);
        homeserver.serve("next", next);
        await poll([plainEvent("$1", "gone", frame)], [plainEvent("$2", "next", next)]);
        // A 404 also tries the older download endpoint, so one attempt can be two requests.
        const asked = homeserver.mediaRequests.filter((id) => id === "gone").length;
        expect(asked).toBe(status === 404 ? 2 : 1);
        advance(3_600_000);
        await state.pollOnce();
        expect(payloads()).toEqual([textOf(next)]);
        expect(homeserver.mediaRequests.filter((id) => id === "gone")).toHaveLength(asked);
      },
    );

    it("uses the authenticated download endpoint, and the older one only when the homeserver does not know it", async () => {
      const frame = bytesOf(1000, 14);
      homeserver.serve("modern", frame);
      await poll([plainEvent("$1", "modern", frame)]);
      expect(homeserver.mediaPaths).toEqual(["/_matrix/client/v1/media/download"]);
      expect(payloads()).toEqual([textOf(frame)]);
    });

    it("falls back to the older endpoint for a homeserver that does not know the newer one", async () => {
      const frame = bytesOf(1000, 15);
      homeserver.legacyOnly = true;
      homeserver.serve("legacy", frame);
      await poll([plainEvent("$1", "legacy", frame)]);
      expect(homeserver.mediaPaths).toEqual([
        "/_matrix/client/v1/media/download",
        "/_matrix/media/v3/download",
      ]);
      expect(payloads()).toEqual([textOf(frame)]);
    });

    it("does not fall back on a real refusal: a 403 from the newer endpoint ends it", async () => {
      homeserver.failWith("nope", 403);
      await poll([plainEvent("$1", "nope", bytesOf(100, 16))]);
      expect(homeserver.mediaPaths).toEqual(["/_matrix/client/v1/media/download"]);
    });

    it.each([
      [500, "the homeserver failed"],
      [502, "a proxy failed"],
      [429, "it rate-limits"],
      [408, "it timed out"],
    ])(
      "with %i (%s) is kept and tried again, and delivered when it comes through",
      async (status) => {
        const frame = bytesOf(1000, 7);
        homeserver.failWith("flaky", status);
        await poll([plainEvent("$1", "flaky", frame)]);
        expect(state.getDeliveries(DOC)).toEqual([]);
        homeserver.serve("flaky", frame);
        advance(1_000); // the first wait
        await state.pollOnce();
        expect(payloads()).toEqual([textOf(frame)]);
      },
    );

    it("a network error is tried again as well", async () => {
      const frame = bytesOf(1000, 8);
      homeserver.media.set("net", () => {
        throw new TypeError("fetch failed");
      });
      await poll([plainEvent("$1", "net", frame)]);
      expect(state.getDeliveries(DOC)).toEqual([]);
      homeserver.serve("net", frame);
      advance(1_000);
      await state.pollOnce();
      expect(payloads()).toEqual([textOf(frame)]);
    });

    it("waits before each retry, and longer each time, not on every poll", async () => {
      const frame = bytesOf(1000, 9);
      homeserver.failWith("slow", 503);
      await poll([plainEvent("$1", "slow", frame)]);
      const fetched = () => homeserver.mediaRequests.filter((id) => id === "slow").length;
      expect(fetched()).toBe(1);
      await state.pollOnce(); // no time has passed
      expect(fetched()).toBe(1);
      advance(999);
      await state.pollOnce();
      expect(fetched()).toBe(1);
      advance(1); // 1 s: the first wait is over
      await state.pollOnce();
      expect(fetched()).toBe(2);
      advance(1_999); // the second wait is 2 s
      await state.pollOnce();
      expect(fetched()).toBe(2);
      advance(1);
      await state.pollOnce();
      expect(fetched()).toBe(3);
      advance(3_999); // the third is 4 s
      await state.pollOnce();
      expect(fetched()).toBe(3);
      advance(1);
      await state.pollOnce();
      expect(fetched()).toBe(4);
    });

    it("never waits longer than a minute between tries", async () => {
      const frame = bytesOf(1000, 10);
      homeserver.failWith("long", 503);
      await poll([plainEvent("$1", "long", frame)]);
      const fetched = () => homeserver.mediaRequests.filter((id) => id === "long").length;
      for (const wait of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000]) {
        advance(wait);
        await state.pollOnce();
      }
      const before = fetched();
      advance(59_999);
      await state.pollOnce();
      expect(fetched()).toBe(before);
      advance(1);
      await state.pollOnce();
      expect(fetched()).toBe(before + 1);
    });

    it("is given up on after eight tries, and then never fetched again", async () => {
      const frame = bytesOf(1000, 11);
      homeserver.failWith("dead", 503);
      await poll([plainEvent("$1", "dead", frame)]);
      for (let i = 0; i < 30; i += 1) {
        advance(60_000);
        await state.pollOnce();
      }
      expect(homeserver.mediaRequests.filter((id) => id === "dead")).toHaveLength(8);
      expect(state.getDeliveries(DOC)).toEqual([]);
    });

    it("does not hold up an attachment that came after it", async () => {
      const first = bytesOf(1000, 12);
      const second = bytesOf(1000, 13);
      homeserver.failWith("first", 503);
      homeserver.serve("second", second);
      await poll([plainEvent("$1", "first", first), plainEvent("$2", "second", second)]);
      expect(payloads()).toEqual([textOf(second)]);
      homeserver.serve("first", first);
      advance(1_000);
      await state.pollOnce();
      // Late, and after the one that was sent later: a receiver applies updates in any order.
      expect(payloads()).toEqual([textOf(second), textOf(first)]);
    });

    it("holds only so many waiting downloads, dropping the oldest, so a peer cannot make it hold unbounded state", async () => {
      const events: TimelineEvent[] = [];
      for (let i = 0; i < 70; i += 1) {
        homeserver.failWith(`m${i}`, 503);
        events.push(plainEvent(`$${i}`, `m${i}`, bytesOf(100, 100 + i)));
      }
      await poll(events);
      for (let i = 0; i < 70; i += 1) {
        homeserver.serve(`m${i}`, bytesOf(100, 100 + i));
      }
      advance(1_000);
      await state.pollOnce();
      const delivered = state.getDeliveries(DOC).map((d) => d.id);
      expect(delivered).toHaveLength(64);
      expect(delivered).not.toContain("$0");
      expect(delivered).not.toContain("$5");
      expect(delivered).toContain("$6");
      expect(delivered).toContain("$69");
    });
  });

  describe("an attachment that is not what it says", () => {
    it("is dropped when the hash is not the file's, and not fetched again", async () => {
      const claimed = bytesOf(1000, 20);
      homeserver.serve("altered", bytesOf(1000, 21));
      await poll([plainEvent("$1", "altered", claimed)]);
      advance(3_600_000);
      await state.pollOnce();
      expect(state.getDeliveries(DOC)).toEqual([]);
      expect(homeserver.mediaRequests).toEqual(["altered"]);
    });

    it("is dropped when the size is not the file's", async () => {
      const frame = bytesOf(1000, 22);
      homeserver.serve("short", frame.subarray(0, 999));
      await poll([plainEvent("$1", "short", frame)]);
      expect(state.getDeliveries(DOC)).toEqual([]);
    });

    it("is dropped, without reading it all, when the file is over the bound", async () => {
      const frame = bytesOf(1000, 23);
      homeserver.media.set(
        "huge",
        () =>
          new Response(new Uint8Array(5 * 1024 * 1024), {
            headers: { "content-length": String(5 * 1024 * 1024) },
          }),
      );
      await poll([plainEvent("$1", "huge", frame)]);
      advance(3_600_000);
      await state.pollOnce();
      expect(state.getDeliveries(DOC)).toEqual([]);
      expect(homeserver.mediaRequests).toEqual(["huge"]); // refused as too large, not retried
    });

    it("is not even read when the server declares it over the bound", async () => {
      let pulls = 0;
      homeserver.media.set("declared", () => {
        // highWaterMark 0: nothing is pulled until somebody reads.
        const stream = new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              pulls += 1;
              controller.enqueue(new Uint8Array(1024));
            },
          },
          { highWaterMark: 0 },
        );
        return new Response(stream, {
          headers: { "content-length": String(5 * 1024 * 1024) },
        });
      });
      await poll([plainEvent("$1", "declared", bytesOf(1000, 25))]);
      expect(pulls).toBe(0);
      expect(state.getDeliveries(DOC)).toEqual([]);
    });

    it("stops reading a file that turns out larger than the bound, whatever the server declared", async () => {
      const frame = bytesOf(1000, 24);
      let pulls = 0;
      homeserver.media.set("liar", () => {
        // A server that says 1000 bytes and then keeps sending 1 MiB at a time (40 of them at most,
        // so that a reader which never stops ends here instead of taking the machine down).
        const stream = new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              pulls += 1;
              controller.enqueue(new Uint8Array(1024 * 1024));
              if (pulls >= 40) {
                controller.close();
              }
            },
          },
          { highWaterMark: 0 },
        );
        return new Response(stream, { headers: { "content-length": "1000" } });
      });
      await poll([plainEvent("$1", "liar", frame)]);
      expect(state.getDeliveries(DOC)).toEqual([]);
      // 4 MiB is the bound, so the sixth megabyte is never asked for.
      expect(pulls).toBeLessThanOrEqual(6);
    });
  });

  describe("an event that is not taken as an attachment", () => {
    it("names a document that is not bound here: nothing is fetched", async () => {
      const frame = bytesOf(100, 30);
      homeserver.serve("other", frame);
      const event = plainEvent("$1", "other", frame);
      (event.content as { documentId: string }).documentId = "somebody-elses";
      await poll([event]);
      expect(homeserver.mediaRequests).toEqual([]);
      expect(state.getDeliveries("somebody-elses")).toEqual([]);
    });

    it("is an event of any other type: silently ignored, nothing is fetched", async () => {
      const frame = bytesOf(100, 31);
      homeserver.serve("req", frame);
      const event = { ...plainEvent("$1", "req", frame), type: OTHER_TYPE };
      await poll([event]);
      expect(homeserver.mediaRequests).toEqual([]);
      expect(state.getDeliveries(DOC)).toEqual([]);
    });

    it("carries both a frame and an attachment: it is ambiguous, so it is ignored", async () => {
      const frame = bytesOf(100, 32);
      homeserver.serve("both", frame);
      const event = plainEvent("$1", "both", frame);
      (event.content as { frame?: string }).frame = textOf(frame);
      await poll([event]);
      expect(homeserver.mediaRequests).toEqual([]);
      expect(state.getDeliveries(DOC)).toEqual([]);
    });

    it("has a reference that does not parse: nothing is fetched", async () => {
      const frame = bytesOf(100, 33);
      homeserver.serve("bad", frame);
      const event = plainEvent("$1", "bad", frame);
      (event.content as { attachment: { url: string } }).attachment.url = "https://evil.example/x";
      await poll([event]);
      expect(homeserver.mediaRequests).toEqual([]);
      expect(state.getDeliveries(DOC)).toEqual([]);
    });

    it("was sent before this bridge's first poll: the baseline is discarded as always, and nothing is fetched", async () => {
      const frame = bytesOf(100, 34);
      homeserver.serve("old", frame);
      homeserver.syncRounds = [[plainEvent("$old", "old", frame)]];
      await state.pollOnce();
      expect(homeserver.mediaRequests).toEqual([]);
      expect(state.getDeliveries(DOC)).toEqual([]);
    });
  });

  it("an ordinary frame in an event body is delivered exactly as before", async () => {
    const frame = bytesOf(500, 40);
    await poll([
      {
        type: EDIT,
        event_id: "$body",
        sender: "@alice:homeserver.test",
        content: { tdsp: 1, documentId: DOC, frame: textOf(frame) },
      },
    ]);
    expect(payloads()).toEqual([textOf(frame)]);
    expect(homeserver.mediaRequests).toEqual([]);
  });
});
