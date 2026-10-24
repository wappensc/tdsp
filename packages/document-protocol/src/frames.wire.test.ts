import { readFileSync } from "node:fs";
import {
  encodeStateVector,
  encodeUpdate,
  ensureParagraph,
  getFragment,
  getPlainText,
  insertPlainText,
  transact,
} from "@tdsp/reconciliation";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  CURRENT_FRAME_VERSION,
  decodeFrame,
  encodeControlFrame,
  encodeDeclineFrame,
  encodeEditFrame,
  encodeHeartbeatFrame,
  encodeResyncRequestFrame,
  encodeResyncResponseFrame,
  type Frame,
} from "./framing";
import { YJS_PARAGRAPHS_1 } from "./index";
import {
  encodeInvitation,
  INVITATION_VERSION,
  type Invitation,
  parseInvitation,
} from "./invitation";
import { profileFor } from "./profile";

/**
 * The draft wire (VER-3): these tests hold the
 * encoder and the decoder to the frames in `wire/frames-draft-5.json`, the invitation writer to
 * `wire/invitations-draft-5.json`, and the profile `yjs-paragraphs/1` to the bytes of 1.x §4.5,
 * which 2.0 keeps. Both files are frozen like 1.x's `frames-v1.json`: within the draft marker an
 * entry may be added, never changed or removed (VER-3).
 */

const read = (relative: string): string =>
  readFileSync(new URL(`../../../${relative}`, import.meta.url), "utf8");

interface FrameEntry {
  readonly name: string;
  readonly kind: Frame["kind"];
  readonly input: Record<string, unknown>;
  readonly frame: string;
}

const FRAMES_FILE = "wire/frames-draft-5.json";
const FRAMES = JSON.parse(read(FRAMES_FILE)) as {
  $comment: string;
  version: string;
  entries: FrameEntry[];
};

const bytes = (base64: unknown): Uint8Array =>
  Uint8Array.from(Buffer.from(String(base64), "base64"));
const base64 = (value: Uint8Array): string => Buffer.from(value).toString("base64");

/** Encodes one entry's input with the encoder for its kind. */
function encode(entry: FrameEntry): string {
  const input = entry.input;
  const documentId = String(input.documentId);
  switch (entry.kind) {
    case "edit":
      return encodeEditFrame(documentId, bytes(input.update), Number(input.due ?? 0));
    case "control":
      return encodeControlFrame(input as Parameters<typeof encodeControlFrame>[0]);
    case "heartbeat":
      return encodeHeartbeatFrame({
        documentId,
        control: (input.control ?? null) as Record<string, number> | null,
        controlDigest: (input.controlDigest ?? null) as string | null,
        stateVector: bytes(input.stateVector),
        stateDigest: String(input.stateDigest),
        stream: String(input.stream),
        sequence: Number(input.sequence),
      });
    case "resync-request":
      return encodeResyncRequestFrame({
        documentId,
        requestId: String(input.requestId),
        control: (input.control ?? null) as Record<string, number> | null,
        controlDigest: (input.controlDigest ?? null) as string | null,
        force: input.force === true,
        stateVector: bytes(input.stateVector),
        stateDigest: String(input.stateDigest),
        stream: String(input.stream),
        sequence: Number(input.sequence),
      });
    case "resync-response":
      return encodeResyncResponseFrame({
        documentId,
        respondsTo: String(input.respondsTo),
        update: bytes(input.update),
        control: input.control as object | null,
        attribution: input.attribution as object | null,
        state:
          input.stateVector === null || input.stateVector === undefined
            ? null
            : { stateVector: bytes(input.stateVector), stateDigest: String(input.stateDigest) },
        // Where it stands in its responder's stream, and which piece it is (LOS-13, RSY-18); the
        // count of pieces follows from the state, which only the last piece carries.
        stream: String(input.stream),
        sequence: Number(input.sequence),
        piece: Number(input.piece),
      });
    case "decline":
      return encodeDeclineFrame(input as Parameters<typeof encodeDeclineFrame>[0]);
  }
}

/** A decoded frame in the entries' input form: bytes as Base64, no limit as null. */
function asInput(frame: Frame): Record<string, unknown> {
  switch (frame.kind) {
    case "edit":
      return { documentId: frame.documentId, update: base64(frame.update), due: frame.due };
    case "control": {
      const { kind: _kind, ...rest } = frame;
      return rest;
    }
    case "heartbeat":
    case "resync-request": {
      const { kind: _kind, stateVector, ...rest } = frame;
      return { ...rest, stateVector: base64(stateVector) };
    }
    case "resync-response": {
      const { kind: _kind, update, stateVector, ...rest } = frame;
      return {
        ...rest,
        update: base64(update),
        stateVector: stateVector === null ? null : base64(stateVector),
      };
    }
    case "decline": {
      const { kind: _kind, ...rest } = frame;
      return rest;
    }
  }
}

describe("frames at the draft marker", () => {
  it("are the version this engine writes", () => {
    expect(CURRENT_FRAME_VERSION).toBe(FRAMES.version);
  });

  it("cover every kind", () => {
    expect(new Set(FRAMES.entries.map((entry) => entry.kind))).toEqual(
      new Set(["edit", "control", "heartbeat", "resync-request", "resync-response", "decline"]),
    );
  });

  it("are what the encoder writes from each input", () => {
    for (const entry of FRAMES.entries) {
      expect(encode(entry), entry.name).toBe(entry.frame);
    }
  });

  it.each(FRAMES.entries.map((entry) => [entry.name, entry] as const))(
    "%s: read back to what was written",
    (_name, entry) => {
      const decoded = decodeFrame(entry.frame);
      expect(decoded.kind).toBe(entry.kind);
      expect(asInput(decoded)).toEqual(entry.input);
    },
  );
});

describe("invitation links at the draft marker", () => {
  const LINKS_FILE = "wire/invitations-draft-5.json";
  const LINKS = JSON.parse(read(LINKS_FILE)) as {
    $comment: string;
    version: string;
    entries: { name: string; invitation: Invitation; link: string }[];
  };

  it("are the version this writer writes", () => {
    expect(INVITATION_VERSION).toBe(LINKS.version);
  });

  it("are what the writer writes from each invitation", () => {
    for (const entry of LINKS.entries) {
      expect(encodeInvitation(entry.invitation), entry.name).toBe(entry.link);
    }
  });

  it.each(LINKS.entries.map((entry) => [entry.name, entry] as const))(
    "%s: read back to the same invitation",
    (_name, entry) => {
      expect(parseInvitation(entry.link)).toEqual({ ok: true, invitation: entry.invitation });
    },
  );
});

describe("the profile yjs-paragraphs/1 (§4.5)", () => {
  const EDIT = FRAMES.entries.find(
    (entry) => entry.name === "edit: the §4.5 example",
  ) as FrameEntry;
  const UPDATE = bytes(EDIT.input.update);

  it("builds the §4.5 document, byte for byte, from one client's first paragraph and 'Hi'", () => {
    const document = new Y.Doc();
    document.clientID = 4078767369; // the one client of the example
    transact(document, () => ensureParagraph(getFragment(document)));
    insertPlainText(getFragment(document), 0, "Hi");
    expect(base64(encodeUpdate(document))).toBe(EDIT.input.update);
    expect(base64(encodeStateVector(document))).toBe("AYma9JgPBA=="); // Appendix D's heartbeat
  });

  it("reads those bytes back into the same document, and writes them again unchanged", () => {
    const profile = profileFor(YJS_PARAGRAPHS_1);
    const document = profile.createEmpty();
    profile.applyUpdate(document, UPDATE, "remote");
    expect(getPlainText(getFragment(document))).toBe("Hi");
    expect(base64(profile.encodeState(document))).toBe(EDIT.input.update);
    expect(base64(profile.encodeStateVector(document))).toBe("AYma9JgPBA==");
  });
});
