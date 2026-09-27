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
  encodeFragmentFrame,
  encodeHeartbeatFrame,
  encodeResyncRequestFrame,
  encodeResyncResponseFrame,
  type Frame,
} from "./framing";
import { resolveSyncPolicy, YJS_PARAGRAPHS_1 } from "./index";
import {
  encodeInvitation,
  INVITATION_VERSION,
  type Invitation,
  parseInvitation,
} from "./invitation";
import { profileFor } from "./profile";

/**
 * The wire, frozen (docs/testing.md, "Wire compatibility"). What an engine puts into a
 * message must not change within a version (SPECIFICATION.md VER-1): these tests hold the
 * encoder and the decoder to the frames in `wire/frames-v1.json`, the specification's own
 * examples (§4.5, Appendix D) to the encoder, the invitation vectors to the invitation
 * writer, and the profile `yjs-paragraphs/1` to the bytes of §4.5. A difference is a wire
 * change: only the CI role may accept it, as a new version or a compatible addition
 * (tools/wire-lock.ts). Only the CI role may change this file (.github/CODEOWNERS).
 */

const read = (relative: string): string =>
  readFileSync(new URL(`../../../${relative}`, import.meta.url), "utf8");

interface FrameEntry {
  readonly name: string;
  readonly kind: Frame["kind"];
  readonly input: Record<string, unknown>;
  readonly frame: string;
}

const FRAMES = JSON.parse(read("wire/frames-v1.json")) as {
  version: number;
  entries: FrameEntry[];
};

const bytes = (base64: unknown): Uint8Array =>
  Uint8Array.from(Buffer.from(String(base64), "base64"));
const base64 = (value: Uint8Array): string => Buffer.from(value).toString("base64");

/** A sync policy as the wire writes it (no limit as null) into the engine's form, and back. */
type PolicyJson = Record<
  "minIntervalMs" | "maxIntervalMs" | "minChars" | "maxChars" | "expectedLatencyMs",
  number | null
>;
const policyFromJson = (json: PolicyJson) =>
  resolveSyncPolicy(
    Object.fromEntries(
      Object.entries(json).map(([key, value]) => [key, value ?? Number.POSITIVE_INFINITY]),
    ),
  );
const policyToJson = (policy: object): PolicyJson =>
  Object.fromEntries(
    Object.entries(policy).map(([key, value]) => [
      key,
      value === Number.POSITIVE_INFINITY ? null : value,
    ]),
  ) as PolicyJson;

/** Encodes one entry's input with the encoder for its kind. */
function encode(entry: FrameEntry): string {
  const input = entry.input;
  const documentId = String(input.documentId);
  switch (entry.kind) {
    case "edit":
      return encodeEditFrame(documentId, bytes(input.update));
    case "control": {
      const { policy, ...rest } = input as Parameters<typeof encodeControlFrame>[0] & {
        policy?: PolicyJson;
      };
      return encodeControlFrame(
        policy === undefined ? rest : { ...rest, policy: policyFromJson(policy) },
      );
    }
    case "heartbeat":
      return encodeHeartbeatFrame({
        documentId,
        controlSequence: Number(input.controlSequence),
        stateVector: bytes(input.stateVector),
      });
    case "resync-request":
      return encodeResyncRequestFrame({
        documentId,
        requestId: String(input.requestId),
        bootstrap: input.bootstrap === true,
        controlSequence: Number(input.controlSequence),
        stateVector: bytes(input.stateVector),
      });
    case "resync-response":
      return encodeResyncResponseFrame({
        documentId,
        respondsTo: String(input.respondsTo),
        update: bytes(input.update),
        control: input.control as object | null,
        attribution: input.attribution as object | null,
      });
    case "fragment":
      return encodeFragmentFrame({
        documentId,
        messageId: String(input.messageId),
        index: Number(input.index),
        total: Number(input.total),
        chunk: bytes(input.slice),
      });
    case "decline":
      return encodeDeclineFrame(input as Parameters<typeof encodeDeclineFrame>[0]);
  }
}

/** A decoded frame in the entries' input form: bytes as Base64, no limit as null. */
function asInput(frame: Frame): Record<string, unknown> {
  switch (frame.kind) {
    case "edit":
      return { documentId: frame.documentId, update: base64(frame.update) };
    case "control": {
      const { kind: _kind, policy, ...rest } = frame;
      return policy === undefined ? rest : { ...rest, policy: policyToJson(policy) };
    }
    case "heartbeat":
    case "resync-request": {
      const { kind: _kind, stateVector, ...rest } = frame;
      return { ...rest, stateVector: base64(stateVector) };
    }
    case "resync-response": {
      const { kind: _kind, update, control, ...rest } = frame;
      return {
        ...rest,
        update: base64(update),
        control:
          control === null
            ? null
            : control.policy === undefined
              ? control
              : { ...control, policy: policyToJson(control.policy) },
      };
    }
    case "fragment": {
      const { kind: _kind, chunk, ...rest } = frame;
      return { ...rest, slice: base64(chunk) };
    }
    case "decline": {
      const { kind: _kind, ...rest } = frame;
      return rest;
    }
  }
}

describe("frames at frame version 1", () => {
  it("are the version this engine writes", () => {
    expect(CURRENT_FRAME_VERSION).toBe(FRAMES.version);
  });

  it("cover every kind", () => {
    expect(new Set(FRAMES.entries.map((entry) => entry.kind))).toEqual(
      new Set([
        "edit",
        "control",
        "heartbeat",
        "resync-request",
        "resync-response",
        "fragment",
        "decline",
      ]),
    );
  });

  it.each(FRAMES.entries.map((entry) => [entry.name, entry] as const))(
    "%s: written byte for byte, and read back to what was written",
    (_name, entry) => {
      expect(encode(entry)).toBe(entry.frame);
      const decoded = decodeFrame(entry.frame);
      expect(decoded.kind).toBe(entry.kind);
      expect(asInput(decoded)).toEqual(entry.input);
    },
  );
});

describe("the specification's own examples (§4.5, Appendix D)", () => {
  /** The JSON code blocks of one section of SPECIFICATION.md, from its heading to the next of its level or above. */
  function jsonBlocks(heading: string): string[] {
    const spec = read("SPECIFICATION.md");
    const start = spec.indexOf(`\n${heading}\n`);
    expect(start, heading).toBeGreaterThan(-1);
    const level = heading.split(" ")[0] as string;
    const rest = spec.slice(start + heading.length + 2);
    const next = rest.search(new RegExp(`\\n#{2,${level.length}} `));
    const section = next === -1 ? rest : rest.slice(0, next);
    return [...section.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => match[1] as string);
  }

  const examples = [
    ...jsonBlocks("### 4.5 Example"),
    ...jsonBlocks("## Appendix D. Example frames"),
  ];
  const frames = examples.filter((text) => (JSON.parse(text) as { kind: string }).kind !== "frame");

  it("are all found: the §4.5 edit and five more frames", () => {
    expect(frames).toHaveLength(6);
  });

  it.each(frames.map((text) => [text.slice(0, 80), text] as const))(
    "%s… is exactly what the encoder writes",
    (_head, text) => {
      expect(FRAMES.entries.map((entry) => entry.frame)).toContain(text);
      expect(() => decodeFrame(text)).not.toThrow();
    },
  );
});

describe("invitation links at invitation version 1", () => {
  const LINKS = JSON.parse(read("wire/invitations-v1.json")) as {
    version: number;
    entries: { name: string; invitation: Invitation; link: string }[];
  };

  it("are the version this writer writes", () => {
    expect(INVITATION_VERSION).toBe(LINKS.version);
  });

  it.each(LINKS.entries.map((entry) => [entry.name, entry] as const))(
    "%s: written byte for byte, and read back to the same invitation",
    (_name, entry) => {
      expect(encodeInvitation(entry.invitation)).toBe(entry.link);
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
