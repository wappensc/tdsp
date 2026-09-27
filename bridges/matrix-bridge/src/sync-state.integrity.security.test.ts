import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@tdsp/bridge-log";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveBindStore } from "./bind-store.ts";
import type { CryptoMachine } from "./crypto-machine.ts";
import { createSyncState, type SyncState } from "./sync-state.ts";

/**
 * SPECIFICATION.md BRG-12: a bridge must never apply, and must record as an
 * integrity violation, a messenger-native edit or withdrawal of an
 * already-delivered message. These are adversarial tests against a fake
 * `/sync` transport, built from what a real local Synapse delivers for
 * both cases; this suite checks the bridge's reaction to them.
 */

const HOME = "http://homeserver.test";
const ROOM = "!room:homeserver.test";
const DOC = "doc-1";
const ALICE = "@alice:homeserver.test";
const EDIT = "de.wappensc.together.tdsp.frame";

interface TimelineEvent {
  type: string;
  event_id: string;
  sender: string;
  content: unknown;
  unsigned?: { redacted_because?: unknown };
}

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

const originalEditEvent = (eventId: string): TimelineEvent => ({
  type: EDIT,
  event_id: eventId,
  sender: ALICE,
  content: { tdsp: 1, documentId: DOC, frame: "b3JpZ2luYWw=" },
});

/** Mirrors the real m.replace envelope the live probe captured against Synapse. */
const editOfEvent = (eventId: string, targetEventId: string): TimelineEvent => ({
  type: EDIT,
  event_id: eventId,
  sender: ALICE,
  content: {
    tdsp: 1,
    documentId: DOC,
    frame: "dGFtcGVyZWQ=",
    "m.new_content": { tdsp: 1, documentId: DOC, frame: "dGFtcGVyZWQ=" },
    "m.relates_to": { rel_type: "m.replace", event_id: targetEventId },
  },
});

/** Mirrors the real redaction envelope the live probe captured. */
const redactionOf = (eventId: string, targetEventId: string): TimelineEvent => ({
  type: "m.room.redaction",
  event_id: eventId,
  sender: ALICE,
  content: { reason: "probe", redacts: targetEventId },
});

/** An event whose content was already stripped by a redaction the bridge never independently saw — mirrors the live-confirmed /sync behavior: content empties in place, not only on direct fetch. */
const alreadyRedactedEvent = (eventId: string): TimelineEvent => ({
  type: EDIT,
  event_id: eventId,
  sender: ALICE,
  content: {},
  unsigned: { redacted_because: { event_id: "$whatever", type: "m.room.redaction" } },
});

describe("a receiver's handling of a messenger-native edit or withdrawal", () => {
  let homeserver: FakeHomeserver;
  let state: SyncState;
  /** The events logged, which the envelope-version test reads; nothing is printed. */
  const logged: string[] = [];
  const silent = createLogger({
    component: "test",
    sink: (_line, record) => logged.push(record.event),
  });

  const crypto = (): CryptoMachine => ({
    userId: "@bob:homeserver.test",
    deviceId: "DEVICE",
    ensureRoomKeyShared: async () => {},
    encryptRoomEvent: async () => {
      throw new Error("not used");
    },
    decryptRoomEvent: async () => ({ ok: false, reason: "no key" }),
    receiveSync: async () => {},
    close: () => {},
  });

  beforeEach(() => {
    logged.length = 0;
    homeserver = new FakeHomeserver();
    vi.stubGlobal("fetch", homeserver.handle);
    const bindStorePath = join(tmpdir(), "does-not-exist-matrix-integrity-test.json");
    saveBindStore(bindStorePath, {
      [DOC]: {
        roomId: ROOM,
        creatorMemberId: ALICE,
        profile: "yjs-paragraphs/1",
        createdAt: "2026-01-01T00:00:00Z",
        encrypted: false,
      },
    });
    state = createSyncState(
      { homeserverUrl: HOME, accessToken: "t" },
      bindStorePath,
      crypto(),
      silent,
    );
  });

  /** Runs the baseline poll (which discards what it finds) and then one poll per round. */
  async function poll(...rounds: TimelineEvent[][]): Promise<void> {
    homeserver.syncRounds = [[], ...rounds];
    await state.pollOnce();
    for (let i = 0; i < rounds.length; i += 1) {
      await state.pollOnce();
    }
  }

  it("never applies an m.replace edit as an ordinary new delivery, and records it", async () => {
    await poll([originalEditEvent("$orig")], [editOfEvent("$edit", "$orig")]);
    expect(state.getDeliveries(DOC)).toEqual([
      {
        id: "$orig",
        documentId: DOC,
        sender: ALICE,
        payload: "b3JpZ2luYWw=", // the frame's text, exactly as the event carried it
      },
    ]);
    expect(state.getIntegrityLog(DOC)).toEqual([
      { eventId: "$edit", sender: ALICE, reason: "message-edited" },
    ]);
  });

  it("records a redaction of an already-delivered message against that document, without retracting the applied update", async () => {
    await poll([originalEditEvent("$orig")], [redactionOf("$redaction", "$orig")]);
    expect(state.getDeliveries(DOC)).toHaveLength(1); // the earlier, already-applied delivery stands
    expect(state.getIntegrityLog(DOC)).toEqual([
      { eventId: "$orig", sender: ALICE, reason: "message-redacted" },
    ]);
  });

  it("does not crash or misapply an event whose content already arrived redacted, though it cannot attribute it to a document", async () => {
    await poll([alreadyRedactedEvent("$stripped")]);
    expect(state.getDeliveries(DOC)).toEqual([]);
    expect(state.getIntegrityLog(DOC)).toEqual([]); // honestly unattributable, not silently mis-attributed
  });

  it("reports, and does not deliver, a TDSP envelope of another version for a bound document (BND-2)", async () => {
    const v2 = (eventId: string, documentId: string): TimelineEvent => ({
      type: EDIT,
      event_id: eventId,
      sender: ALICE,
      content: { tdsp: 2, documentId, frame: "AQID" },
    });
    await poll([v2("$v2", DOC), v2("$other", "unbound-doc")]);
    expect(state.getDeliveries(DOC)).toEqual([]);
    expect(logged.filter((event) => event === "unsupported-envelope-version")).toHaveLength(1);
  });

  it("ignores a redaction that targets an event this bridge never recorded, without crashing", async () => {
    await poll([redactionOf("$redaction", "$never-seen")]);
    expect(state.getDeliveries(DOC)).toEqual([]);
    expect(state.getIntegrityLog(DOC)).toEqual([]);
  });
});
