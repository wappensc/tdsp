import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import {
  type DeliveryId,
  type DocumentId,
  type MemberId,
  type TransportProfile,
  TransportSendError,
} from "@tdsp/messenger-port";
import { getPlainText, insertPlainText } from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeControlFrame, FrameDecodeError, frameByteLength } from "./framing";
import { DocumentEngine, type FrameExtension, type PersistedControlState } from "./index";

/**
 * `com.example.mood/1` is a test extension, defined here as FRM-12 asks; no application uses it.
 * It is carried at the top level of edits, heartbeats, requests and answers. Its value is `"calm"`
 * or `"busy"`, the sender's mood; a frame without it says nothing about the mood. Its senders do
 * not name it in `crit`, since a receiver without it reads the frame as before; a receiver shows
 * the mood beside the sender's name, until the sender's next frame says another.
 */
const MOOD = "com.example.mood/1";
const DOCUMENT_ID: DocumentId = "doc-1";
const JOIN_ALICE = { batchWindowMs: 0, creatorMemberId: "alice" };

interface Heard {
  readonly value: unknown;
  readonly kind: string;
  readonly sender: MemberId;
}

/** The test extension, telling `heard` what arrives; `options` add values or change the rest. */
function mood(heard: Heard[], options: Partial<FrameExtension> = {}): FrameExtension {
  return {
    name: MOOD,
    accepts: (value) => value === "calm" || value === "busy",
    receive: (value, frame) => heard.push({ value, ...frame }),
    ...options,
  };
}

/** `payload` with `fields` added at its top level, as a sender with other extensions writes it. */
function withFields(payload: string, fields: Record<string, unknown>): string {
  return JSON.stringify({ ...JSON.parse(payload), ...fields });
}

/** The reasons of the rejections an engine reported. */
function reasons(errors: readonly unknown[]): string[] {
  return errors.map((error) => (error instanceof FrameDecodeError ? error.reason : String(error)));
}

/** What a member reported: the errors, collected. */
function collecting(errors: unknown[]): (error: unknown) => void {
  return (error) => errors.push(error);
}

/** Lets pending sends go out, then syncs each engine in turn, `times` over. */
async function rounds(engines: readonly DocumentEngine[], times = 2): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    for (const engine of engines) {
      await vi.advanceTimersByTimeAsync(0);
      await engine.sync();
    }
  }
  await vi.advanceTimersByTimeAsync(0);
}

/** What a device of the creator persists (CTL-26). */
function persistedOf(engine: DocumentEngine): PersistedControlState {
  const device = engine.deviceTag;
  return {
    profile: engine.profile,
    control: engine.controlState,
    ...(device === undefined ? {} : { device, counter: engine.controlVector[device] ?? 0 }),
  };
}

/** An in-memory messenger with a largest message, which it declares and enforces. */
class LimitedPort extends InMemoryMessengerPort {
  readonly sizes: number[] = [];

  constructor(readonly maxBytes: number) {
    super();
  }

  override async transportProfile(): Promise<TransportProfile> {
    return {
      bounds: { minIntervalMs: null, maxBytes: this.maxBytes },
      pacing: {
        minIntervalMs: 0,
        maxIntervalMs: null,
        minChars: 0,
        maxChars: null,
        expectedLatencyMs: 0,
      },
    };
  }

  override async send(
    documentId: DocumentId,
    sender: MemberId,
    payload: string,
  ): Promise<DeliveryId> {
    const size = frameByteLength(payload);
    if (size > this.maxBytes) {
      throw new TransportSendError(
        "too-large",
        `${size} bytes exceeds the ${this.maxBytes} this transport carries`,
      );
    }
    this.sizes.push(size);
    return super.send(documentId, sender, payload);
  }
}

describe("an extension an engine implements (FRM-9 to FRM-12, FRM-15 to FRM-17)", () => {
  let messenger: InMemoryMessengerPort;

  beforeEach(() => {
    vi.useFakeTimers();
    messenger = new InMemoryMessengerPort();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reaches an engine that implements it, in an edit, and passes one that does not, both ways", async () => {
    const heardByAlice: Heard[] = [];
    const heardByBob: Heard[] = [];
    const carolErrors: unknown[] = [];
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
      batchWindowMs: 0,
      extensions: [mood(heardByAlice, { values: { edit: "calm" } })],
    });
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, {
      ...JOIN_ALICE,
      extensions: [mood(heardByBob, { values: { edit: "busy" } })],
    });
    const carol = await DocumentEngine.join(
      DOCUMENT_ID,
      "carol",
      messenger,
      collecting(carolErrors),
      JOIN_ALICE,
    );
    await rounds([alice, bob, carol]);

    alice.edit((fragment) => insertPlainText(fragment, 0, "hello"));
    await rounds([bob, carol, alice]);
    bob.edit((fragment) => insertPlainText(fragment, 5, " world"));
    await rounds([alice, carol, bob]);

    expect(heardByBob).toContainEqual({ value: "calm", kind: "edit", sender: "alice" });
    expect(heardByAlice).toContainEqual({ value: "busy", kind: "edit", sender: "bob" });
    // Never its own frames: what this client wrote it knows.
    expect(heardByAlice.filter((heard) => heard.sender === "alice")).toEqual([]);
    expect(heardByBob.filter((heard) => heard.sender === "bob")).toEqual([]);
    // Carol does not implement it and reads every frame as before (FRM-9).
    for (const engine of [alice, bob, carol]) {
      expect(getPlainText(engine.fragment)).toBe("hello world");
    }
    expect(carolErrors).toEqual([]);
  });

  it("reaches a joiner in the answer that bootstraps it, and is ignored inside the snapshot (FRM-12, FRM-17)", async () => {
    const heardByBob: Heard[] = [];
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
      batchWindowMs: 0,
      extensions: [mood([], { values: { "resync-response": "calm" } })],
    });
    alice.edit((fragment) => insertPlainText(fragment, 0, "hello"));
    await rounds([alice]);
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, {
      ...JOIN_ALICE,
      extensions: [mood(heardByBob)],
    });
    // In the snapshot, where this version defines no place for an extension an engine implements.
    messenger.modifyNextSend("alice", (payload) => {
      const frame = JSON.parse(payload) as {
        kind: string;
        control: Record<string, unknown> | null;
      };
      if (frame.kind === "resync-response" && frame.control !== null) {
        frame.control[MOOD] = "busy";
      }
      return JSON.stringify(frame);
    });
    await rounds([alice, bob]);

    expect(bob.hasCompletedBootstrap).toBe(true);
    expect(getPlainText(bob.fragment)).toBe("hello");
    expect(heardByBob).toEqual([{ value: "calm", kind: "resync-response", sender: "alice" }]);
  });

  it("is ignored with a value its definition forbids, and rejects the frame when crit names it (FRM-16)", async () => {
    const heardByBob: Heard[] = [];
    const bobErrors: unknown[] = [];
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
      batchWindowMs: 0,
    });
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, collecting(bobErrors), {
      ...JOIN_ALICE,
      extensions: [mood(heardByBob)],
    });
    await rounds([alice, bob]);

    messenger.modifyNextSend("alice", (payload) => withFields(payload, { [MOOD]: "sleepy" }));
    alice.edit((fragment) => insertPlainText(fragment, 0, "one"));
    await rounds([bob, alice]);
    expect(getPlainText(bob.fragment)).toBe("one");
    expect(heardByBob).toEqual([]);
    expect(bobErrors).toEqual([]);

    messenger.modifyNextSend("alice", (payload) =>
      withFields(payload, { [MOOD]: "sleepy", crit: [MOOD] }),
    );
    alice.edit((fragment) => insertPlainText(fragment, 3, " two"));
    await vi.advanceTimersByTimeAsync(0);
    await bob.sync();
    // Rejected whole: nothing of it applied, nothing of it told (FRM-6).
    expect(getPlainText(bob.fragment)).toBe("one");
    expect(heardByBob).toEqual([]);
    expect(reasons(bobErrors)).toEqual(["invalid-field"]);
  });

  it("is critical: an engine without it rejects the frame and applies nothing, one with it reads it (FRM-10)", async () => {
    const heardByBob: Heard[] = [];
    const carolErrors: unknown[] = [];
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
      batchWindowMs: 0,
    });
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, {
      ...JOIN_ALICE,
      extensions: [mood(heardByBob)],
    });
    const carol = await DocumentEngine.join(
      DOCUMENT_ID,
      "carol",
      messenger,
      collecting(carolErrors),
      JOIN_ALICE,
    );
    await rounds([alice, bob, carol]);
    expect(carolErrors).toEqual([]);

    // A sender that writes it as critical: the engine's own writing is tested below, with sizes.
    messenger.modifyNextSend("alice", (payload) =>
      withFields(payload, { [MOOD]: "busy", crit: [MOOD] }),
    );
    alice.edit((fragment) => insertPlainText(fragment, 0, "hello"));
    await vi.advanceTimersByTimeAsync(0);
    await bob.sync();
    await carol.sync();

    expect(getPlainText(bob.fragment)).toBe("hello");
    expect(heardByBob).toEqual([{ value: "busy", kind: "edit", sender: "alice" }]);
    expect(getPlainText(carol.fragment)).toBe("");
    expect(reasons(carolErrors)).toEqual(["unsupported-extension"]);
  });

  it("in another major version is another extension: ignored, or rejected when critical (FRM-15)", async () => {
    const heardByBob: Heard[] = [];
    const bobErrors: unknown[] = [];
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
      batchWindowMs: 0,
    });
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, collecting(bobErrors), {
      ...JOIN_ALICE,
      extensions: [mood(heardByBob)],
    });
    await rounds([alice, bob]);

    messenger.modifyNextSend("alice", (payload) =>
      withFields(payload, { "com.example.mood/2": "calm" }),
    );
    alice.edit((fragment) => insertPlainText(fragment, 0, "one"));
    await rounds([bob, alice]);
    expect(getPlainText(bob.fragment)).toBe("one");

    messenger.modifyNextSend("alice", (payload) =>
      withFields(payload, { "com.example.mood/2": "calm", crit: ["com.example.mood/2"] }),
    );
    alice.edit((fragment) => insertPlainText(fragment, 3, " two"));
    await vi.advanceTimersByTimeAsync(0);
    await bob.sync();
    expect(getPlainText(bob.fragment)).toBe("one");
    expect(heardByBob).toEqual([]);
    expect(reasons(bobErrors)).toEqual(["unsupported-extension"]);
  });

  it("is not told for a frame rejected for another reason (FRM-16)", async () => {
    const heardByBob: Heard[] = [];
    const bobErrors: unknown[] = [];
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
      batchWindowMs: 0,
    });
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, collecting(bobErrors), {
      ...JOIN_ALICE,
      extensions: [mood(heardByBob)],
    });
    await rounds([alice, bob]);

    // Carol is not the creator: her control operation is refused (CTL-1), its extension with it.
    const forged = encodeControlFrame({
      documentId: DOCUMENT_ID,
      device: "AAAAAAAAAAAAAAAAAAAAAA",
      counter: 1,
      target: "member:carol",
      value: "write",
      seen: {},
    });
    await messenger.send(DOCUMENT_ID, "carol", withFields(forged, { [MOOD]: "calm" }));
    await bob.sync();

    expect(bobErrors.length).toBe(1);
    expect(heardByBob).toEqual([]);
  });

  it("goes on after a restart, and nobody passes on what they were told (FRM-17)", async () => {
    const heardByBob: Heard[] = [];
    const heardByRestarted: Heard[] = [];
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", messenger, undefined, {
      batchWindowMs: 0,
      extensions: [mood([], { values: { edit: "calm", "resync-response": "calm" } })],
    });
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, {
      ...JOIN_ALICE,
      extensions: [mood(heardByBob)],
    });
    await rounds([alice, bob]);
    alice.edit((fragment) => insertPlainText(fragment, 0, "hello"));
    await rounds([bob, alice]);
    expect(heardByBob.map((heard) => heard.kind)).toEqual(
      expect.arrayContaining(["edit", "resync-response"]),
    );

    // Alice's application restarts with her control state and nothing else; her engine is new.
    const restarted = await DocumentEngine.join(DOCUMENT_ID, "alice", messenger, undefined, {
      ...JOIN_ALICE,
      controlState: persistedOf(alice),
      extensions: [mood(heardByRestarted, { values: { "resync-request": "busy" } })],
    });
    await rounds([restarted, bob, restarted], 2);

    expect(heardByBob).toContainEqual({ value: "busy", kind: "resync-request", sender: "alice" });
    expect(getPlainText(restarted.fragment)).toBe("hello");
    // Bob was told alice's moods; he writes none, and passes none on: not in an edit, not in an
    // answer, not in a snapshot.
    bob.edit((fragment) => insertPlainText(fragment, 5, "!"));
    await rounds([bob, restarted]);
    const fromBob = (await messenger.receive(DOCUMENT_ID, "bob")).filter(
      (delivery) => delivery.sender === "bob",
    );
    expect(fromBob.length).toBeGreaterThan(1);
    for (const delivery of fromBob) {
      expect(delivery.payload).not.toContain("com.example.mood");
    }
    expect(heardByRestarted.filter((heard) => heard.sender === "bob")).toEqual([]);
  });

  it("counts toward the size of every piece, and a critical one rides in each (FRM-10, FRM-11)", async () => {
    const port = new LimitedPort(600);
    const heardByBob: Heard[] = [];
    const long = "calm".repeat(50);
    const accepts = (value: unknown) => typeof value === "string";
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, {
      batchWindowMs: 0,
      extensions: [{ name: MOOD, critical: true, accepts, values: { edit: long } }],
    });
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, {
      ...JOIN_ALICE,
      extensions: [mood(heardByBob, { accepts })],
    });
    await rounds([alice, bob]);

    alice.edit((fragment) => insertPlainText(fragment, 0, "x".repeat(3000)));
    await vi.advanceTimersByTimeAsync(60_000);
    await rounds([bob, alice]);

    expect(getPlainText(bob.fragment)).toBe("x".repeat(3000));
    expect(Math.max(...port.sizes)).toBeLessThanOrEqual(600);
    const pieces = (await port.receive(DOCUMENT_ID, "bob")).filter(
      (delivery) => delivery.sender === "alice" && delivery.payload.includes('"kind":"edit"'),
    );
    expect(pieces.length).toBeGreaterThan(2);
    for (const piece of pieces) {
      expect(JSON.parse(piece.payload)).toMatchObject({ [MOOD]: long, crit: [MOOD] });
    }
    expect(heardByBob.filter((heard) => heard.kind === "edit").length).toBe(pieces.length);
  });

  it("is refused at creation when no frame could carry it", async () => {
    const cases: [FrameExtension[], RegExp][] = [
      [[{ name: "mood" }], /must contain a dot/],
      [[{ name: MOOD }, { name: MOOD }], /supplied twice/],
      [
        Array.from({ length: 17 }, (_, i) => ({ name: `com.example.x${i}/1`, critical: true })),
        /at most 16/,
      ],
      [
        [{ name: MOOD, values: { edit: JSON.parse(`${"[".repeat(40)}${"]".repeat(40)}`) } }],
        /nesting/,
      ],
      [[{ name: MOOD, values: { heartbeat: "\ud800" } }], /I-JSON/],
      [[{ name: MOOD, values: { edit: () => "calm" } }], /I-JSON/],
    ];
    for (const [extensions, refusal] of cases) {
      await expect(
        DocumentEngine.create(DOCUMENT_ID, "alice", new InMemoryMessengerPort(), undefined, {
          extensions,
        }),
      ).rejects.toThrow(refusal);
    }
  });
});
