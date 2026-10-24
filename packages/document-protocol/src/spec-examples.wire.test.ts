import { readFileSync } from "node:fs";
import {
  createDocument,
  encodeDeletions,
  ensureParagraph,
  getFragment,
  insertPlainText,
  transact,
} from "@tdsp/reconciliation";
import { describe, expect, it } from "vitest";
import { ControlState } from "./control-state";
import { controlDigestOf, digestOf } from "./digest";
import {
  base64ToBytes,
  CURRENT_FRAME_VERSION,
  encodeControlFrame,
  encodeDeclineFrame,
  encodeEditFrame,
  encodeHeartbeatFrame,
  encodeResyncRequestFrame,
} from "./framing";

/**
 * Every example frame of SPECIFICATION.md §4.5 and Appendix D is what the encoder writes, byte for
 * byte, with `"tdsp":2` where this draft writes its marker (VER-3), and Appendix D's envelope is
 * that frame as a JSON string in the bindings' envelope (bindings/bridges.md, §13.1).
 */
const specification = readFileSync(new URL("../../../SPECIFICATION.md", import.meta.url), "utf8");
const released = (frame: string): string =>
  frame.replace(`"tdsp":${JSON.stringify(CURRENT_FRAME_VERSION)}`, '"tdsp":2');

const DOCUMENT_ID = "doc-a1b2c3";
const DEVICE = "Ms3dRk0ZyS7cH1qkM8fWNA";
const bytes = (base64: string): Uint8Array => base64ToBytes(base64) as Uint8Array;
const edit = released(
  encodeEditFrame(
    DOCUMENT_ID,
    bytes("AQOJmvSYDwAHAQdjb250ZW50AwlwYXJhZ3JhcGgHAIma9JgPAAYEAIma9JgPAQJIaQA="),
    30000,
  ),
);
const control = (
  counter: number,
  target: "member:bob" | "pace" | "close",
  value: "write" | number | true,
) =>
  released(
    encodeControlFrame({
      documentId: DOCUMENT_ID,
      device: DEVICE,
      counter,
      target,
      value,
      seen: {},
      due: 30000,
    }),
  );

/** The §4.5 document and the three operations above, whose digests the heartbeat carries (LOS-12). */
const document = createDocument();
document.clientID = 4078767369;
transact(document, () => ensureParagraph(getFragment(document)));
insertPlainText(getFragment(document), 0, "Hi");
const operations = new ControlState();
operations.add({ device: DEVICE, counter: 1, target: "member:bob", value: "write", seen: {} });
operations.add({ device: DEVICE, counter: 2, target: "pace", value: 30000, seen: {} });
operations.add({ device: DEVICE, counter: 3, target: "close", value: true, seen: {} });
const stateDigest = digestOf(encodeDeletions(document));

const EXAMPLES: Record<string, string> = {
  "§4.5 edit": edit,
  "grant bob write": control(1, "member:bob", "write"),
  "the pace": control(2, "pace", 30000),
  "the close": control(3, "close", true),
  heartbeat: released(
    encodeHeartbeatFrame({
      documentId: DOCUMENT_ID,
      control: { [DEVICE]: 3 },
      controlDigest: controlDigestOf(operations.snapshot()),
      stateVector: bytes("AYma9JgPBA=="),
      stateDigest,
      // The first report of the device's engine (LOS-13).
      stream: "0c4f9a2be81d7365",
      sequence: 1,
    }),
  ),
  "a joiner's request": released(
    encodeResyncRequestFrame({
      documentId: DOCUMENT_ID,
      requestId: "5f3a9c0e12b47d68",
      control: null,
      controlDigest: null,
      force: false,
      stateVector: bytes("AA=="),
      stateDigest: digestOf(encodeDeletions(createDocument())),
      stream: "7e0d5b31a9c4f286",
      sequence: 1,
    }),
  ),
  decline: released(
    encodeDeclineFrame({
      documentId: DOCUMENT_ID,
      reason: "unsupported-profile",
      profiles: ["com.example.markdown/1"],
      text: "My app cannot open this document.",
    }),
  ),
  envelope: JSON.stringify({ tdsp: 1, kind: "frame", documentId: DOCUMENT_ID, frame: edit }),
};

describe("the specification's example frames", () => {
  it.each(Object.entries(EXAMPLES))(
    "%s is in the specification as the encoder writes it",
    (_name, frame) => {
      expect(specification.includes(`\n${frame}\n`), frame).toBe(true);
    },
  );
});
