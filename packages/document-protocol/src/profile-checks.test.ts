import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import { deletePlainText, getFragment, getPlainText, insertPlainText } from "@tdsp/reconciliation";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  bytesToBase64,
  CURRENT_FRAME_VERSION,
  encodeResyncResponseFrame,
  FrameDecodeError,
} from "./framing";
import { DocumentEngine, type DocumentProfile, YJS_PARAGRAPHS_1 } from "./index";
import { profileFor } from "./profile";

/**
 * CRDT bytes the document's profile cannot read (FRM-6, FRM-7, PRF-1): a frame whose `update` or
 * `stateVector` does not decode under the profile is rejected as `invalid-field` before anything of
 * it is applied or kept, and a bad request never keeps a responder from answering the others.
 */

const DOCUMENT_ID = "doc-1";
const OPTIONS = { batchWindowMs: 0, resyncResponseThrottleMs: 0 };
const NOT_A_STATE_VECTOR = "/////w==";

interface Reported {
  readonly reason: string | undefined;
  readonly sender: string | undefined;
  readonly context: string;
  readonly message: string;
}

function reporter(): {
  readonly reported: Reported[];
  readonly onError: (error: unknown, context: string) => void;
} {
  const reported: Reported[] = [];
  return {
    reported,
    onError: (error, context) =>
      reported.push({
        reason: error instanceof FrameDecodeError ? error.reason : undefined,
        sender: error instanceof FrameDecodeError ? error.sender : undefined,
        context,
        message: String((error as Error)?.message),
      }),
  };
}

/**
 * A frame written by hand. A report — a heartbeat, a request, an answer — names a stream of its own
 * (LOS-13), and an answer is one piece, its last when it states the responder's state (RSY-18).
 */
const frame = (fields: Record<string, unknown>): string => {
  const kind = fields.kind;
  const stream =
    kind === "heartbeat" || kind === "resync-request" || kind === "resync-response"
      ? { stream: "5eed5eed5eed5eed", sequence: 1 }
      : {};
  const piece =
    kind === "resync-response" ? { piece: 1, pieces: fields.stateVector === null ? null : 1 } : {};
  return JSON.stringify({
    tdsp: CURRENT_FRAME_VERSION,
    documentId: DOCUMENT_ID,
    ...fields,
    ...stream,
    ...piece,
  });
};

/** The creator alone, with some text, and a member who joined and caught up. */
async function creatorAndMember(port = new InMemoryMessengerPort()) {
  const alice = reporter();
  const bob = reporter();
  const creator = await DocumentEngine.create(DOCUMENT_ID, "alice", port, alice.onError, OPTIONS);
  await creator.setMembership("bob", "write");
  const member = await DocumentEngine.join(DOCUMENT_ID, "bob", port, bob.onError, {
    ...OPTIONS,
    creatorMemberId: "alice",
  });
  await creator.sync();
  await member.sync();
  creator.edit((fragment) => insertPlainText(fragment, 0, "Base"));
  await member.sync();
  await creator.sync();
  return { port, creator, member, alice, bob };
}

/** The requestId of the first request `requester` sent. */
async function requestOf(port: InMemoryMessengerPort, requester: string): Promise<string> {
  const deliveries = await port.receive(DOCUMENT_ID, "nobody");
  const request = deliveries
    .filter((delivery) => delivery.sender === requester)
    .map((delivery) => JSON.parse(delivery.payload) as { kind: string; requestId?: string })
    .find((parsed) => parsed.kind === "resync-request");
  return request?.requestId as string;
}

/**
 * The full state of `document` with text nobody sent and a deletion, cut one byte short: its
 * structs read, its delete set does not — where Yjs has already inserted the text when it fails.
 */
function truncatedState(document: Y.Doc): Uint8Array {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(document));
  copy.transact(() => {
    insertPlainText(getFragment(copy), 0, "Injected ");
    deletePlainText(getFragment(copy), 9, 6);
  });
  const whole = Y.encodeStateAsUpdate(copy);
  return whole.slice(0, whole.length - 1);
}

describe("CRDT bytes the profile cannot decode (FRM-6, FRM-7, PRF-1)", () => {
  it("rejects an edit whose update does not decode as invalid-field, and applies nothing of it", async () => {
    const { port, creator, alice } = await creatorAndMember();
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(creator.document));
    const before = Y.encodeStateVector(copy);
    copy.transact(() => {
      insertPlainText(getFragment(copy), 4, "XYZ");
      deletePlainText(getFragment(copy), 0, 2);
    });
    const update = Y.encodeStateAsUpdate(copy, before);
    await port.send(
      DOCUMENT_ID,
      "bob",
      frame({ kind: "edit", update: bytesToBase64(update.slice(0, -1)), due: 0 }),
    );
    await creator.sync();
    expect(getPlainText(getFragment(creator.document))).toBe("Base");
    expect(alice.reported).toEqual([
      expect.objectContaining({ reason: "invalid-field", context: "apply" }),
    ]);
  });

  it("rejects an answer whose update does not decode, applying none of it, and bootstraps from the next one", async () => {
    const port = new InMemoryMessengerPort();
    const alice = reporter();
    const bob = reporter();
    const creator = await DocumentEngine.create(DOCUMENT_ID, "alice", port, alice.onError, OPTIONS);
    await creator.setMembership("bob", "write");
    creator.edit((fragment) => insertPlainText(fragment, 0, "Hello world"));
    const member = await DocumentEngine.join(DOCUMENT_ID, "bob", port, bob.onError, {
      ...OPTIONS,
      creatorMemberId: "alice",
    });
    const respondsTo = await requestOf(port, "bob");
    // Stands in for a creator whose answer breaks off inside its delete set.
    await port.send(
      DOCUMENT_ID,
      "alice",
      encodeResyncResponseFrame({
        documentId: DOCUMENT_ID,
        respondsTo,
        update: truncatedState(creator.document),
        control: creator.controlState,
        attribution: null,
        state: null,
      }),
    );
    await member.sync();
    expect(getPlainText(getFragment(member.document))).not.toContain("Injected");
    expect(member.hasCompletedBootstrap).toBe(false);
    expect(bob.reported).toEqual([
      expect.objectContaining({ reason: "invalid-field", context: "apply" }),
    ]);

    await creator.sync();
    await member.sync();
    expect(member.hasCompletedBootstrap).toBe(true);
    expect(getPlainText(getFragment(member.document))).toBe("Hello world");
  });

  it("rejects an answer whose state vector does not decode", async () => {
    const port = new InMemoryMessengerPort();
    const bob = reporter();
    const creator = await DocumentEngine.create(DOCUMENT_ID, "alice", port, () => {}, OPTIONS);
    await creator.setMembership("bob", "write");
    const member = await DocumentEngine.join(DOCUMENT_ID, "bob", port, bob.onError, {
      ...OPTIONS,
      creatorMemberId: "alice",
    });
    const respondsTo = await requestOf(port, "bob");
    await port.send(
      DOCUMENT_ID,
      "alice",
      frame({
        kind: "resync-response",
        respondsTo,
        update: bytesToBase64(Y.encodeStateAsUpdate(creator.document)),
        control: creator.controlState,
        attribution: null,
        stateVector: NOT_A_STATE_VECTOR,
        stateDigest: "0000000000000000",
      }),
    );
    await member.sync();
    expect(member.hasCompletedBootstrap).toBe(false);
    expect(bob.reported).toEqual([
      expect.objectContaining({ reason: "invalid-field", context: "apply" }),
    ]);
  });

  it("rejects a request whose state vector does not decode, and goes on answering everyone else", async () => {
    const port = new InMemoryMessengerPort();
    const alice = reporter();
    const creator = await DocumentEngine.create(DOCUMENT_ID, "alice", port, alice.onError, OPTIONS);
    creator.edit((fragment) => insertPlainText(fragment, 0, "Base"));
    await creator.sync();
    // Anyone in the channel may ask, with no right at all.
    await port.send(
      DOCUMENT_ID,
      "mallory",
      frame({
        kind: "resync-request",
        requestId: "00000000000000aa",
        control: null,
        controlDigest: null,
        force: true,
        stateVector: NOT_A_STATE_VECTOR,
        stateDigest: "0000000000000000",
      }),
    );
    await expect(creator.sync()).resolves.toBeDefined();
    await expect(creator.sync()).resolves.toBeDefined();
    expect(alice.reported).toEqual([
      expect.objectContaining({ reason: "invalid-field", context: "apply" }),
    ]);

    await creator.setMembership("carol", "write");
    const carol = await DocumentEngine.join(DOCUMENT_ID, "carol", port, () => {}, {
      ...OPTIONS,
      creatorMemberId: "alice",
    });
    await creator.sync();
    await carol.sync();
    expect(carol.hasCompletedBootstrap).toBe(true);
    expect(getPlainText(getFragment(carol.document))).toBe("Base");
  });

  it("reports a heartbeat whose state vector does not decode, instead of dropping it silently", async () => {
    const { port, creator, alice } = await creatorAndMember();
    await port.send(
      DOCUMENT_ID,
      "bob",
      frame({
        kind: "heartbeat",
        control: null,
        controlDigest: null,
        stateVector: NOT_A_STATE_VECTOR,
        stateDigest: "0000000000000000",
      }),
    );
    await creator.sync();
    expect(alice.reported).toEqual([
      expect.objectContaining({ reason: "invalid-field", context: "apply" }),
    ]);
  });

  it("rejects an edit whose update has a byte after it, applying none of it (PRF-1 item 9, §4.4)", async () => {
    const { port, creator, alice } = await creatorAndMember();
    const writer = new Y.Doc();
    Y.applyUpdate(writer, Y.encodeStateAsUpdate(creator.document));
    const before = Y.encodeStateVector(writer);
    insertPlainText(getFragment(writer), 0, "Smuggled ");
    const update = Y.encodeStateAsUpdate(writer, before);
    await port.send(
      DOCUMENT_ID,
      "bob",
      frame({ kind: "edit", update: bytesToBase64(new Uint8Array([...update, 0])), due: 0 }),
    );
    await creator.sync();
    expect(alice.reported).toEqual([
      expect.objectContaining({ reason: "invalid-field", context: "apply" }),
    ]);
    expect(getPlainText(getFragment(creator.document))).toBe("Base");
  });

  it("takes a state vector with bytes after its last entry as one it cannot decode", async () => {
    const { port, creator, alice } = await creatorAndMember();
    const trailing = new Uint8Array([...Y.encodeStateVector(creator.document), 0]);
    await port.send(
      DOCUMENT_ID,
      "bob",
      frame({
        kind: "heartbeat",
        control: null,
        controlDigest: null,
        stateVector: bytesToBase64(trailing),
        stateDigest: "0000000000000000",
      }),
    );
    await creator.sync();
    expect(alice.reported).toEqual([
      expect.objectContaining({ reason: "invalid-field", context: "apply" }),
    ]);
  });

  it("rejects an answer whose update is empty, applying none of it; one that holds nothing bootstraps (§4.3, SND-18)", async () => {
    const port = new InMemoryMessengerPort();
    const bob = reporter();
    const creator = await DocumentEngine.create(DOCUMENT_ID, "alice", port, () => {}, OPTIONS);
    await creator.setMembership("bob", "write");
    const member = await DocumentEngine.join(DOCUMENT_ID, "bob", port, bob.onError, {
      ...OPTIONS,
      creatorMemberId: "alice",
    });
    const respondsTo = await requestOf(port, "bob");
    const answer = (update: string) =>
      frame({
        kind: "resync-response",
        respondsTo,
        update,
        control: creator.controlState,
        attribution: null,
        stateVector: null,
        stateDigest: null,
      });
    await port.send(DOCUMENT_ID, "alice", answer(""));
    await member.sync();
    expect(bob.reported).toEqual([
      expect.objectContaining({ reason: "invalid-field", context: "apply" }),
    ]);
    expect(member.hasCompletedBootstrap).toBe(false);
    // The update that holds nothing (Appendix A: `00 00`) is what a responder sends instead.
    await port.send(DOCUMENT_ID, "alice", answer("AAA="));
    await member.sync();
    expect(bob.reported).toHaveLength(1);
    expect(member.hasCompletedBootstrap).toBe(true);
    expect(member.permissionOf("bob")).toBe("write");
  });
});

describe("a rejection names its sender (FRM-7, VER-4)", () => {
  it("reports a frame of another version with the reason and who sent it", async () => {
    const { port, creator, alice } = await creatorAndMember();
    alice.reported.length = 0;
    await port.send(
      DOCUMENT_ID,
      "carol",
      JSON.stringify({
        tdsp: "de.example.tdsp.later",
        kind: "edit",
        documentId: DOCUMENT_ID,
        update: "AAA=",
        due: 0,
      }),
    );
    await creator.sync();
    expect(alice.reported).toEqual([
      expect.objectContaining({ reason: "unsupported-version", sender: "carol", context: "apply" }),
    ]);
  });
});

describe("answering requests one at a time (RSY-9, §1.7 item 11)", () => {
  it("reports a request the profile fails on while answering, and still answers the next", async () => {
    // A profile that reads every state vector but fails on one while comparing it: what is left
    // when the check before handling passes a request the answer then cannot use.
    const base = profileFor(YJS_PARAGRAPHS_1);
    const FLAKY: DocumentProfile = {
      ...base,
      id: "com.example.flaky/1",
      hasUpdatesSince: (document, stateVector) => {
        if (Y.decodeStateVector(stateVector).has(4242)) {
          throw new Error("this profile cannot compare against client 4242");
        }
        return base.hasUpdatesSince(document, stateVector);
      },
    };
    const options = { ...OPTIONS, profile: FLAKY.id, profiles: [FLAKY] };
    const port = new InMemoryMessengerPort();
    const alice = reporter();
    const creator = await DocumentEngine.create(DOCUMENT_ID, "alice", port, alice.onError, options);
    creator.edit((fragment) => insertPlainText(fragment, 0, "Base"));
    await creator.sync();
    const odd = new Y.Doc();
    odd.clientID = 4242;
    odd.getText("x").insert(0, "x");
    await port.send(
      DOCUMENT_ID,
      "mallory",
      frame({
        kind: "resync-request",
        requestId: "00000000000000bb",
        control: null,
        controlDigest: null,
        force: true,
        stateVector: bytesToBase64(Y.encodeStateVector(odd)),
        stateDigest: "0000000000000000",
      }),
    );
    await creator.setMembership("carol", "write");
    const carol = await DocumentEngine.join(DOCUMENT_ID, "carol", port, () => {}, {
      ...options,
      creatorMemberId: "alice",
    });
    await expect(creator.sync()).resolves.toBeDefined();
    await carol.sync();
    expect(carol.hasCompletedBootstrap).toBe(true);
    expect(getPlainText(getFragment(carol.document))).toBe("Base");
    expect(alice.reported).toEqual([
      expect.objectContaining({
        context: "broadcast",
        message: expect.stringContaining("client 4242"),
      }),
    ]);
    // Reported once: the request is not kept to fail again.
    await creator.sync();
    expect(alice.reported).toHaveLength(1);
  });
});
