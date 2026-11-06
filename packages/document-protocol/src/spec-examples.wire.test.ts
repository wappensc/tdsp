import { readFileSync } from "node:fs";
import {
  applyUpdate,
  createDocument,
  encodeDeletions,
  encodeStateVector,
  encodeUpdateSince,
  ensureParagraph,
  getFragment,
  insertPlainText,
  transact,
} from "@tdsp/reconciliation";
import { describe, expect, it } from "vitest";
import type { Clock } from "./clock";
import { ControlState, type ControlTarget, type Register } from "./control-state";
import { digestOf } from "./digest";
import {
  base64ToBytes,
  encodeControlFrame,
  encodeDeclineFrame,
  encodeEditFrame,
  encodeHeartbeatFrame,
  encodeResyncRequestFrame,
} from "./framing";
import { decideRegister } from "./registers";

/**
 * Every example frame of SPECIFICATION.md §4.5 and Appendix D is what the encoder writes, byte for
 * byte, and Appendix D's envelope is
 * that frame as a JSON string in the bindings' envelope (bindings/bridges.md, §13.1). The registers
 * of Appendix D are the decisions a device of the creator makes at the times named (CTL-21, CTL-45),
 * and their control clocks and digests those of the state after each (LOS-24).
 */
const specification = readFileSync(new URL("../../../SPECIFICATION.md", import.meta.url), "utf8");

const DOCUMENT_ID = "doc-a1b2c3";
const DEVICE = "Ms3dRk0ZyS7cH1qkM8fWNA";
/** 2026-10-26 10:00:00 UTC. */
const T = Date.UTC(2026, 9, 26, 10, 0, 0);
const bytes = (base64: string): Uint8Array => base64ToBytes(base64) as Uint8Array;
const edit = encodeEditFrame(
  DOCUMENT_ID,
  bytes("AQOJmvSYDwAHAQdjb250ZW50AwlwYXJhZ3JhcGgHAIma9JgPAAYEAIma9JgPAQJIaQA="),
);

/** The device's decisions, one after another, each on top of what it holds, as the engine makes them. */
const state = new ControlState();
let own: Clock = [0, 0];
const control = (
  decision: { target: ControlTarget; value: Register["value"]; now: number } | "close",
): string => {
  let targets: Record<string, Register> = {};
  if (decision === "close") {
    state.close();
  } else {
    const held = state.registerOf(decision.target);
    const decided = decideRegister({
      held: { closed: false, targets: held === undefined ? {} : { [decision.target]: held } },
      target: decision.target,
      value: decision.value,
      device: DEVICE,
      own,
      now: decision.now,
    });
    if (decided === undefined) throw new Error("no clock");
    own = decided.own;
    targets = { [decision.target]: decided.register };
    state.take({ closed: false, targets });
  }
  return encodeControlFrame({
    documentId: DOCUMENT_ID,
    device: DEVICE,
    targets,
    closed: state.closed,
    controlClock: state.clock,
    controlDigest: state.digest,
  });
};

/** The §4.5 document, whose state digest the heartbeat carries (LOS-12). */
const document = createDocument();
document.clientID = 4078767369;
transact(document, () => ensureParagraph(getFragment(document)));
insertPlainText(getFragment(document), 0, "Hi");
const stateDigest = digestOf(encodeDeletions(document));
const joinerDigest = digestOf(encodeDeletions(createDocument()));

const grant = control({ target: "member:bob", value: "write", now: T });
const pace = control({ target: "pace", value: 30000, now: T });
const carol = control({ target: "member:carol", value: "read", now: T + 60_000 });
const heartbeat = encodeHeartbeatFrame({
  documentId: DOCUMENT_ID,
  controlClock: state.clock,
  controlDigest: state.digest,
  stateVector: bytes("AYma9JgPBA=="),
  stateDigest,
  // The first report of the device's engine (LOS-13).
  stream: "0c4f9a2be81d7365",
  sequence: 1,
});
/** Bob's replica: the §4.5 document, then his one edit, "!" after "Hi", under his own Yjs client. */
const bobs = createDocument();
applyUpdate(bobs, bytes("AQOJmvSYDwAHAQdjb250ZW50AwlwYXJhZ3JhcGgHAIma9JgPAAYEAIma9JgPAQJIaQA="));
bobs.clientID = 2357911131;
const beforeBobsEdit = encodeStateVector(bobs);
insertPlainText(getFragment(bobs), 2, "!");
/** His report carries that edit's update again (§4.3); a member states no control clock (SND-11). */
const bobsReport = encodeHeartbeatFrame({
  documentId: DOCUMENT_ID,
  controlClock: null,
  controlDigest: null,
  stateVector: encodeStateVector(bobs),
  stateDigest: digestOf(encodeDeletions(bobs)),
  // His engine's second report, after his request as a joiner (LOS-13).
  stream: "3b8e1f0a7c5d2946",
  sequence: 2,
  update: encodeUpdateSince(bobs, beforeBobsEdit),
});
const close = control("close");
const request = (requestId: string, all: boolean, sequence: number): string =>
  encodeResyncRequestFrame({
    documentId: DOCUMENT_ID,
    requestId,
    controlClock: null,
    controlDigest: null,
    all,
    force: false,
    stateVector: bytes("AA=="),
    stateDigest: joinerDigest,
    stream: "7e0d5b31a9c4f286",
    sequence,
  });

const EXAMPLES: Record<string, string> = {
  "§4.5 edit": edit,
  "grant bob write": grant,
  "the pace": pace,
  "carol may read": carol,
  heartbeat,
  "a member's report with its last edit": bobsReport,
  "the close": close,
  "a joiner's request": request("5f3a9c0e12b47d68", false, 1),
  "its repeat to all": request("c41d07e9a2b85f36", true, 2),
  decline: encodeDeclineFrame({
    documentId: DOCUMENT_ID,
    reason: "unsupported-profile",
    profiles: ["com.example.markdown/1"],
    text: "My app cannot open this document.",
  }),
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
