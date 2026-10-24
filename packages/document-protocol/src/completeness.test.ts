import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import type {
  Delivery,
  DeliveryId,
  MemberId,
  MessengerPort,
  TransportProfile,
} from "@tdsp/messenger-port";
import { deletePlainText, getPlainText, insertPlainText } from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { decodeFrame, type Frame } from "./framing";
import { DocumentEngine, type DocumentEngineOptions } from "./index";

/**
 * Streams and numbered pieces (SPECIFICATION.md LOS-13, LOS-14, LOS-17, LOS-18, LOS-21, RSY-17,
 * RSY-18): the acceptance cases of a review of the draft. A report of a device that lags behind
 * must not end the evidence another device of its member showed, in either order and before or
 * after the waiting time; healed evidence must end and leave no traffic; and a receiver that holds
 * more than an answer must still tell whether a piece of it is missing — the last piece first, a
 * missing delete piece, two responders, an answer made while editing goes on —, healing or saying
 * so without a restart.
 */

const DOCUMENT_ID = "doc-1";
const POLICY = { maxIntervalMs: 20_000, expectedLatencyMs: 5_000 };
const OPTIONS: DocumentEngineOptions = {
  batchWindowMs: 0,
  resyncResponseThrottleMs: 0,
  syncPolicy: POLICY,
};
const JOIN: DocumentEngineOptions = { ...OPTIONS, creatorMemberId: "alice" };

/**
 * One device's view of the shared mock: what it sends of a kind can be held back (captured, to be
 * released later in any order) or lost, and what others sent can be hidden from it.
 */
class Device {
  readonly captured: string[] = [];
  readonly #shared: InMemoryMessengerPort;
  readonly #member: MemberId;
  readonly #capturing = new Set<Frame["kind"]>();
  readonly #losing = new Map<Frame["kind"], number>();
  readonly #hidden = new Set<DeliveryId>();
  #hiding: ((delivery: Delivery, frame: Frame) => boolean) | undefined;
  #fake = 0;
  readonly port: MessengerPort;

  constructor(shared: InMemoryMessengerPort, member: MemberId, maxBytes: number | null = null) {
    this.#shared = shared;
    this.#member = member;
    const visible = (deliveries: readonly Delivery[]) =>
      deliveries.filter((delivery) => {
        if (this.#hidden.has(delivery.id)) return false;
        if (this.#hiding?.(delivery, decodeFrame(delivery.payload))) {
          this.#hidden.add(delivery.id);
          return false;
        }
        return true;
      });
    this.port = {
      transportProfile: async (): Promise<TransportProfile> => {
        const profile = await shared.transportProfile();
        return maxBytes === null
          ? profile
          : { ...profile, bounds: { ...profile.bounds, maxBytes } };
      },
      createDocument: (documentId, creator) => shared.createDocument(documentId, creator),
      listChannels: (who) => shared.listChannels(who),
      receive: async (documentId, who) => visible(await shared.receive(documentId, who)),
      send: async (documentId, sender, payload) => {
        const kind = decodeFrame(payload).kind;
        const losing = this.#losing.get(kind) ?? 0;
        if (losing > 0) {
          this.#losing.set(kind, losing - 1);
          return `lost-${member}-${this.#fake++}`; // accepted, and never delivered
        }
        if (this.#capturing.has(kind)) {
          this.captured.push(payload);
          return `held-${member}-${this.#fake++}`;
        }
        return shared.send(documentId, sender, payload);
      },
    };
  }

  capture(kind: Frame["kind"], on = true): void {
    if (on) this.#capturing.add(kind);
    else this.#capturing.delete(kind);
  }

  loseNext(kind: Frame["kind"]): void {
    this.#losing.set(kind, (this.#losing.get(kind) ?? 0) + 1);
  }

  /** From now on, hides what `hides` says from this device, until `hide(undefined)`; what it hid stays hidden. */
  hide(hides: ((delivery: Delivery, frame: Frame) => boolean) | undefined): void {
    this.#hiding = hides;
  }

  /** Shows again everything it hid. */
  unhide(): void {
    this.#hidden.clear();
    this.#hiding = undefined;
  }

  /** Delivers held frames now, in this order. */
  async release(payloads: readonly string[]): Promise<void> {
    for (const payload of payloads) {
      await this.#shared.send(DOCUMENT_ID, this.#member, payload);
    }
  }
}

/** Time passes in steps, and every engine reads after each. */
async function run(engines: readonly DocumentEngine[], ms: number, step = 1_000): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    await vi.advanceTimersByTimeAsync(step);
    for (const engine of engines) {
      await engine.sync();
    }
  }
}

/** The kinds of what `member` sent after `after` deliveries. */
async function sentBy(
  shared: InMemoryMessengerPort,
  member: MemberId,
  after: number,
  kind: Frame["kind"],
): Promise<number> {
  return (await shared.receive(DOCUMENT_ID, "x"))
    .slice(after)
    .filter((delivery) => delivery.sender === member && decodeFrame(delivery.payload).kind === kind)
    .length;
}

async function deliveries(shared: InMemoryMessengerPort): Promise<number> {
  return (await shared.receive(DOCUMENT_ID, "x")).length;
}

const kindsOf = (engine: DocumentEngine) =>
  engine.syncHealth.suspicions.map((suspicion) => suspicion.kind);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a device that lags behind does not end another device's evidence (LOS-17)", () => {
  /**
   * Alice creates, Bob writes from a laptop and a phone, Carol reads along. All hold "abc"; the
   * phone types "x", and the laptop then deletes "b" in an edit nobody receives. Both of Bob's
   * devices owe a heartbeat, at equal state vectors: the laptop's states the deletion, the
   * phone's — a device that never saw it — does not. Both are held back, to be delivered in a
   * chosen order.
   */
  async function lostDeletionOnOneDevice() {
    const shared = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", shared, undefined, OPTIONS);
    await alice.setMembership("bob", "write");
    await alice.setMembership("carol", "write");
    alice.edit((fragment) => insertPlainText(fragment, 0, "abc"));
    const laptopWire = new Device(shared, "bob");
    const phoneWire = new Device(shared, "bob");
    const laptop = await DocumentEngine.join(DOCUMENT_ID, "bob", laptopWire.port, undefined, JOIN);
    const phone = await DocumentEngine.join(DOCUMENT_ID, "bob", phoneWire.port, undefined, JOIN);
    const carol = await DocumentEngine.join(DOCUMENT_ID, "carol", shared, undefined, JOIN);
    const engines = [alice, laptop, phone, carol];
    // Long enough for every request kept to expire (RSY-19): what heals below is the evidence.
    await run(engines, 6 * 60_000, 10_000);
    expect(engines.map((engine) => getPlainText(engine.fragment))).toEqual([
      "abc",
      "abc",
      "abc",
      "abc",
    ]);

    laptopWire.capture("heartbeat");
    phoneWire.capture("heartbeat");
    phone.edit((fragment) => insertPlainText(fragment, 3, "x"));
    await run(engines, 2_000);
    laptopWire.loseNext("edit");
    laptop.edit((fragment) => deletePlainText(fragment, 1, 1)); // lost
    await run(engines, 20_000); // both heartbeats are held now
    expect(laptopWire.captured).toHaveLength(1);
    expect(phoneWire.captured).toHaveLength(1);
    laptopWire.capture("heartbeat", false);
    phoneWire.capture("heartbeat", false);
    expect(getPlainText(laptop.fragment)).toBe("acx");
    expect([alice, phone, carol].map((engine) => getPlainText(engine.fragment))).toEqual([
      "abcx",
      "abcx",
      "abcx",
    ]);
    return { shared, alice, laptop, phone, carol, engines, laptopWire, phoneWire };
  }

  it.each([
    [
      "the deleting device's heartbeat first, the lagging one's before the waiting time",
      "laptop",
      2_000,
    ],
    [
      "the deleting device's heartbeat first, the lagging one's after the waiting time",
      "laptop",
      7_000,
    ],
    [
      "the lagging device's heartbeat first, the deleting one's before the waiting time",
      "phone",
      2_000,
    ],
    [
      "the lagging device's heartbeat first, the deleting one's after the waiting time",
      "phone",
      7_000,
    ],
  ] as const)(
    "%s: the evidence stays, heals for real, and leaves no traffic",
    async (_name, first, delay) => {
      const { shared, alice, laptop, phone, carol, engines, laptopWire, phoneWire } =
        await lostDeletionOnOneDevice();
      const [early, late] = first === "laptop" ? [laptopWire, phoneWire] : [phoneWire, laptopWire];
      const oldHeartbeats = [...laptopWire.captured, ...phoneWire.captured];

      await early.release(early.captured);
      await run(engines, delay);
      await late.release(late.captured);
      // Until the automatic request a while later, the laptop's evidence stands at everyone who lacks
      // the deletion, whatever the phone said, and whenever.
      const laptopReleasedAfter = first === "laptop" ? 0 : delay;
      await run(engines, laptopReleasedAfter + 9_000 - delay);
      for (const receiver of [alice, carol]) {
        expect(receiver.syncHealth.suspicions).toContainEqual(
          expect.objectContaining({ kind: "diverged", sender: "bob" }),
        );
      }

      // Healed for real: everyone ends with the deletion, and nothing suggests a loss any more.
      await run(engines, 3 * 60_000);
      expect(engines.map((engine) => getPlainText(engine.fragment))).toEqual([
        "acx",
        "acx",
        "acx",
        "acx",
      ]);
      for (const engine of engines) {
        expect(engine.syncHealth.suspicions).toEqual([]);
      }

      // The old heartbeats, offered again — as a restarted bridge may — change nothing, and in a
      // quiet document nothing is sent at all.
      await run(engines, 60_000);
      const before = await deliveries(shared);
      await laptopWire.release([oldHeartbeats[0] as string]);
      await phoneWire.release([oldHeartbeats[1] as string]);
      await run(engines, 10 * 60_000, 5_000);
      for (const engine of engines) {
        expect(engine.syncHealth.suspicions).toEqual([]);
      }
      expect(await deliveries(shared)).toBe(before + 2); // the two copies, and nothing else
      expect([alice, laptop, phone, carol].map((engine) => getPlainText(engine.fragment))).toEqual([
        "acx",
        "acx",
        "acx",
        "acx",
      ]);
    },
  );
});

const TEXT = "A paragraph long enough to split an answer into several pieces on their way. ".repeat(
  20,
);

/** The update an answer's frame carries, and whether it holds deletions only. */
function deletesOnly(payload: string): boolean {
  const frame = decodeFrame(payload);
  if (frame.kind !== "resync-response" || frame.update.length === 0) return false;
  const { structs, ds } = Y.decodeUpdate(frame.update);
  return structs.length === 0 && ds.clients.size > 0;
}

const pieceOf = (payload: string) => {
  const frame = decodeFrame(payload);
  return frame.kind === "resync-response"
    ? { piece: frame.piece, pieces: frame.pieces }
    : undefined;
};

/**
 * Lets time pass until `wire` has held back every piece of one answer, and returns that answer's
 * pieces; it holds back nothing more, and what else it held is lost.
 */
async function oneAnswer(wire: Device, engines: readonly DocumentEngine[]): Promise<string[]> {
  const first = () => {
    const payload = wire.captured[0];
    return payload === undefined ? undefined : decodeFrame(payload);
  };
  const of = () =>
    wire.captured.filter((payload) => {
      const frame = decodeFrame(payload);
      const head = first();
      return (
        frame.kind === "resync-response" &&
        head?.kind === "resync-response" &&
        frame.stream === head.stream &&
        frame.sequence === head.sequence
      );
    });
  for (
    let second = 0;
    second < 60 && !of().some((payload) => pieceOf(payload)?.pieces !== null);
    second += 1
  ) {
    await run(engines, 1_000);
  }
  wire.capture("resync-response", false);
  return of();
}

describe("a heartbeat that crossed a deletion, in an ordinary session (LOS-18, SND-24)", () => {
  /**
   * Alice creates; Bob and Carol write. Carol stops typing, and her heartbeat goes out while Bob's
   * deletion is on its way to her: it states her state without it. Then both stop typing. Carol
   * gets the deletion by Bob's edit, and holds exactly what Bob holds.
   */
  async function crossing(receiver: "bob" | "alice") {
    const shared = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", shared, undefined, OPTIONS);
    await alice.setMembership("bob", "write");
    await alice.setMembership("carol", "write");
    alice.edit((fragment) => insertPlainText(fragment, 0, "abcdef"));
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", shared, undefined, JOIN);
    const carolWire = new Device(shared, "carol");
    const carol = await DocumentEngine.join(DOCUMENT_ID, "carol", carolWire.port, undefined, JOIN);
    const engines = [alice, bob, carol];
    await run(engines, 6 * 60_000, 10_000);

    carol.edit((fragment) => insertPlainText(fragment, 6, "!"));
    await run(engines, 15_000);
    // Carol's heartbeat is due 20 s after her edit; the deletion is made just before, and reaches
    // her only after her heartbeat has gone out.
    const deleter = receiver === "bob" ? bob : alice;
    carolWire.hide(
      (delivery, frame) => delivery.sender === deleter.memberId && frame.kind === "edit",
    );
    deleter.edit((fragment) => deletePlainText(fragment, 1, 1));
    await run(engines, 6_000);
    carolWire.unhide(); // and now it arrives
    const before = await deliveries(shared);
    await run(engines, 5 * 60_000);
    expect(engines.map((engine) => getPlainText(engine.fragment))).toEqual([
      "acdef!",
      "acdef!",
      "acdef!",
    ]);
    return { shared, alice, bob, carol, before, receiving: receiver === "bob" ? bob : alice };
  }

  it.each(["bob", "alice"] as const)(
    "ends at a receiver that deleted (%s), and costs at most one request",
    async (receiver) => {
      const { shared, receiving, before } = await crossing(receiver);
      expect(receiving.syncHealth.suspicions).toEqual([]);
      expect(
        await sentBy(shared, receiving.memberId, before, "resync-request"),
      ).toBeLessThanOrEqual(1);
    },
  );
});

describe("a receiver that holds more than the responder (LOS-12, RSY-17)", () => {
  it("notices a deletion it lacks, though it holds an edit of its own the responder never gets, and is answered", async () => {
    const shared = new InMemoryMessengerPort();
    const aliceWire = new Device(shared, "alice");
    const alice = await DocumentEngine.create(
      DOCUMENT_ID,
      "alice",
      aliceWire.port,
      undefined,
      OPTIONS,
    );
    await alice.setMembership("bob", "write");
    alice.edit((fragment) => insertPlainText(fragment, 0, "abc"));
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", shared, undefined, JOIN);
    const engines = [alice, bob];
    await run(engines, 6 * 60_000, 10_000);

    // Alice gets nothing of Bob's but his requests: his state stays ahead of hers.
    aliceWire.hide(
      (delivery, frame) => delivery.sender === "bob" && frame.kind !== "resync-request",
    );
    bob.edit((fragment) => insertPlainText(fragment, 3, "!"));
    aliceWire.loseNext("edit");
    alice.edit((fragment) => deletePlainText(fragment, 1, 1)); // reaches nobody
    const before = await deliveries(shared);
    await run(engines, 2 * 60_000);
    expect(getPlainText(alice.fragment)).toBe("ac");
    expect(getPlainText(bob.fragment)).toBe("ac!");
    expect(bob.syncHealth.suspicions).toEqual([]);
    expect(await sentBy(shared, "bob", before, "resync-request")).toBe(1);
  });

  it("ends a false alarm of its own deletions with the responder's whole answer, without asking again", async () => {
    const shared = new InMemoryMessengerPort();
    const aliceWire = new Device(shared, "alice");
    const alice = await DocumentEngine.create(
      DOCUMENT_ID,
      "alice",
      aliceWire.port,
      undefined,
      OPTIONS,
    );
    await alice.setMembership("bob", "write");
    alice.edit((fragment) => insertPlainText(fragment, 0, "abcdef"));
    const bobWire = new Device(shared, "bob");
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", bobWire.port, undefined, JOIN);
    const engines = [alice, bob];
    await run(engines, 6 * 60_000, 10_000);

    // Bob deletes "e" and types "!", which Alice never gets; Alice deletes "b", which Bob never gets.
    aliceWire.hide(
      (delivery, frame) => delivery.sender === "bob" && frame.kind !== "resync-request",
    );
    bob.edit((fragment) => deletePlainText(fragment, 4, 1));
    bob.edit((fragment) => insertPlainText(fragment, 5, "!"));
    aliceWire.loseNext("edit");
    alice.edit((fragment) => deletePlainText(fragment, 1, 1));
    const before = await deliveries(shared);
    await run(engines, 3 * 60_000);
    // Bob's digest still differs within Alice's vector, by his own deletion; her whole answer ended it.
    expect(getPlainText(bob.fragment)).toBe("acdf!");
    expect(getPlainText(alice.fragment)).toBe("acdef");
    expect(bob.syncHealth.suspicions).toEqual([]);
    expect(await sentBy(shared, "bob", before, "resync-request")).toBe(1);
  });
});

describe("the pieces of an answer (RSY-18, LOS-14)", () => {
  // A transport that carries small messages, at a floor of one second.
  const SMALL = 700;
  const PACED: DocumentEngineOptions = {
    ...OPTIONS,
    syncPolicy: { ...POLICY, minIntervalMs: 1_000 },
  };

  it("the last piece first: the bootstrap's trust is there at once, the transfer shows as incomplete until the rest arrives", async () => {
    const shared = new InMemoryMessengerPort();
    const aliceWire = new Device(shared, "alice", SMALL);
    const alice = await DocumentEngine.create(
      DOCUMENT_ID,
      "alice",
      aliceWire.port,
      undefined,
      PACED,
    );
    await run([alice], 2_000);
    await alice.setMembership("bob", "write");
    alice.edit((fragment) => insertPlainText(fragment, 0, TEXT));
    alice.edit((fragment) => deletePlainText(fragment, 10, 30));
    await run([alice], 60_000);

    aliceWire.capture("resync-response");
    const bobWire = new Device(shared, "bob", SMALL);
    // Bob learns Alice's content from her answer only, as on a messenger without history.
    bobWire.hide((delivery, frame) => delivery.sender === "alice" && frame.kind === "edit");
    const before = await deliveries(shared);
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", bobWire.port, undefined, {
      ...PACED,
      creatorMemberId: "alice",
    });
    const pieces = await oneAnswer(aliceWire, [alice, bob]);
    expect(pieces.length).toBeGreaterThanOrEqual(3);
    expect(pieceOf(pieces.at(-1) as string)).toEqual({
      piece: pieces.length,
      pieces: pieces.length,
    });

    await aliceWire.release([pieces.at(-1) as string]);
    await run([alice, bob], 1_000);
    expect(bob.hasCompletedBootstrap).toBe(true);
    expect(bob.syncHealth.incompleteAnswers).toEqual([
      expect.objectContaining({ sender: "alice", received: 1, pieces: pieces.length }),
    ]);
    expect(getPlainText(bob.fragment)).not.toBe(getPlainText(alice.fragment));

    await aliceWire.release(pieces.slice(0, -1).reverse());
    await run([alice, bob], 1_000);
    expect(getPlainText(bob.fragment)).toBe(getPlainText(alice.fragment));
    expect(bob.syncHealth.incompleteAnswers).toEqual([]);
    await run([alice, bob], 2 * 60_000);
    expect(bob.syncHealth.suspicions).toEqual([]);
    expect(await sentBy(shared, "bob", before, "resync-request")).toBe(1);
  });

  it("a missing delete piece, at a receiver that holds an edit the responder lacks, is incomplete, asked again and healed, with no edit after the transfer", async () => {
    const shared = new InMemoryMessengerPort();
    const aliceWire = new Device(shared, "alice", SMALL);
    // Alice asks nobody by herself here: what heals Bob is his own evidence.
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", aliceWire.port, undefined, {
      ...PACED,
      autoResync: false,
    });
    await run([alice], 2_000);
    await alice.setMembership("bob", "write");
    alice.edit((fragment) => insertPlainText(fragment, 0, `Opening ${TEXT}`));
    const bobWire = new Device(shared, "bob", SMALL);
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", bobWire.port, undefined, {
      ...PACED,
      creatorMemberId: "alice",
    });
    const engines = [alice, bob];
    await run(engines, 6 * 60_000, 10_000);
    expect(getPlainText(bob.fragment)).toBe(getPlainText(alice.fragment));

    // From now on Bob misses Alice's edits, and Alice gets nothing of Bob's but his requests. Bob
    // types; Alice deletes text Bob holds, and writes more.
    bobWire.hide((delivery, frame) => delivery.sender === "alice" && frame.kind === "edit");
    aliceWire.hide(
      (delivery, frame) => delivery.sender === "bob" && frame.kind !== "resync-request",
    );
    bob.edit((fragment) => insertPlainText(fragment, 0, "!"));
    alice.edit((fragment) => deletePlainText(fragment, 0, 8)); // "Opening "
    alice.edit((fragment) => insertPlainText(fragment, 0, TEXT));
    aliceWire.capture("resync-response");
    const before = await deliveries(shared);
    // Alice's heartbeat shows Bob behind; he asks, and her answer comes in pieces.
    const pieces = await oneAnswer(aliceWire, engines);
    const deletePiece = pieces.findIndex(deletesOnly);
    expect(deletePiece).toBeGreaterThanOrEqual(0);
    await aliceWire.release(pieces.filter((_, index) => index !== deletePiece));
    await run(engines, 1_000);
    // Every insertion is here, and Bob holds more than Alice: no vector, and no digest of a piece he
    // has, tells him the rest is missing — the count does.
    expect(getPlainText(bob.fragment)).toContain("Opening ");
    expect(bob.syncHealth.incompleteAnswers).toEqual([
      expect.objectContaining({ sender: "alice" }),
    ]);
    const seen: string[] = [];
    for (let second = 0; second < 90; second += 1) {
      await run(engines, 1_000);
      seen.push(...kindsOf(bob));
    }
    expect(seen).toContain("answer-incomplete");
    // Asked again by itself, and healed; nobody edits after the transfer.
    expect(getPlainText(bob.fragment).replace("!", "")).toBe(getPlainText(alice.fragment));
    expect(bob.syncHealth.incompleteAnswers).toEqual([]);
    expect(bob.syncHealth.suspicions).toEqual([]);
    expect(await sentBy(shared, "bob", before, "resync-request")).toBeLessThanOrEqual(3);
  });

  it("two responders under one MemberId: each answer's pieces are counted apart (RSY-18, LOS-21)", async () => {
    const shared = new InMemoryMessengerPort();
    const laptopWire = new Device(shared, "alice", SMALL);
    const laptop = await DocumentEngine.create(
      DOCUMENT_ID,
      "alice",
      laptopWire.port,
      undefined,
      PACED,
    );
    await run([laptop], 2_000);
    await laptop.setMembership("bob", "write");
    laptop.edit((fragment) => insertPlainText(fragment, 0, TEXT));
    const tabletWire = new Device(shared, "alice", SMALL);
    const tablet = await DocumentEngine.join(DOCUMENT_ID, "alice", tabletWire.port, undefined, {
      ...PACED,
      creatorMemberId: "alice",
    });
    await run([laptop, tablet], 6 * 60_000, 10_000);
    expect(getPlainText(tablet.fragment)).toBe(TEXT);

    // The tablet deletes something nobody else receives, then both devices answer Bob.
    tabletWire.loseNext("edit");
    tablet.edit((fragment) => deletePlainText(fragment, 0, 4));
    tabletWire.capture("resync-response");
    const bobWire = new Device(shared, "bob", SMALL);
    bobWire.hide((delivery, frame) => delivery.sender === "alice" && frame.kind === "edit");
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", bobWire.port, undefined, {
      ...PACED,
      creatorMemberId: "alice",
    });
    const engines = [laptop, tablet, bob];
    const tabletPieces = await oneAnswer(tabletWire, engines);
    const lost = tabletPieces.findIndex(deletesOnly);
    expect(lost).toBeGreaterThanOrEqual(0);
    await tabletWire.release(tabletPieces.filter((_, index) => index !== lost));
    await run(engines, 1_000);
    // The laptop's answer is whole; the tablet's lacks one piece, which the laptop's do not stand in for.
    expect(bob.syncHealth.incompleteAnswers).toEqual([
      expect.objectContaining({ sender: "alice", received: tabletPieces.length - 1 }),
    ]);
    await run(engines, 3 * 60_000);
    expect(getPlainText(bob.fragment)).toBe(getPlainText(tablet.fragment));
    expect(getPlainText(laptop.fragment)).toBe(getPlainText(tablet.fragment));
    for (const engine of engines) {
      expect(engine.syncHealth.incompleteAnswers).toEqual([]);
      expect(engine.syncHealth.suspicions).toEqual([]);
    }
  });

  it("a later answer of the same stream to someone else, of which only a piece that is not the last came, leaves this client's incomplete answer evidence", async () => {
    const shared = new InMemoryMessengerPort();
    const aliceWire = new Device(shared, "alice", SMALL);
    // Nobody asks by themselves here: every request is the test's.
    const quiet = { ...PACED, autoResync: false };
    const alice = await DocumentEngine.create(
      DOCUMENT_ID,
      "alice",
      aliceWire.port,
      undefined,
      quiet,
    );
    await run([alice], 2_000);
    await alice.setMembership("bob", "write");
    await run([alice], 2_000); // her floor between two operations
    await alice.setMembership("carol", "write");
    const bobWire = new Device(shared, "bob", SMALL);
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", bobWire.port, undefined, {
      ...quiet,
      creatorMemberId: "alice",
    });
    await run([alice, bob], 6 * 60_000, 10_000);

    // Bob misses Alice's edits from now on; her text reaches him by her answers only.
    bobWire.hide((delivery, frame) => delivery.sender === "alice" && frame.kind === "edit");
    alice.edit((fragment) => insertPlainText(fragment, 0, TEXT));
    await run([alice, bob], 30_000);
    aliceWire.capture("resync-response");
    const asked = bob.requestResync(); // waits for the floor, which only passing time brings
    const toBob = await oneAnswer(aliceWire, [alice, bob]);
    await asked;
    expect(toBob.length).toBeGreaterThanOrEqual(3);
    // Of her answer to Bob only the first piece arrives.
    await aliceWire.release(toBob.slice(0, 1));
    await run([alice, bob], 1_000);
    expect(bob.syncHealth.incompleteAnswers).toEqual([
      expect.objectContaining({ sender: "alice", received: 1, pieces: null }),
    ]);
    await run([alice, bob], 10_000);
    expect(kindsOf(bob)).toContain("answer-incomplete");

    // Carol joins; Alice answers her, later in the same stream. Bob gets that answer's first piece only.
    aliceWire.captured.splice(0); // what is held of Bob's answer is in toBob
    aliceWire.capture("resync-response");
    const carol = await DocumentEngine.join(
      DOCUMENT_ID,
      "carol",
      new Device(shared, "carol", SMALL).port,
      undefined,
      {
        ...quiet,
        creatorMemberId: "alice",
      },
    );
    const engines = [alice, bob, carol];
    const toCarol = await oneAnswer(aliceWire, engines);
    const [mine, theirs] = [decodeFrame(toBob[0] as string), decodeFrame(toCarol[0] as string)];
    expect(
      mine.kind === "resync-response" &&
        theirs.kind === "resync-response" &&
        theirs.stream === mine.stream,
    ).toBe(true);
    expect(
      theirs.kind === "resync-response" &&
        mine.kind === "resync-response" &&
        theirs.sequence > mine.sequence,
    ).toBe(true);
    expect(toCarol.length).toBeGreaterThanOrEqual(2);
    await aliceWire.release(toCarol.slice(0, 1));
    await run(engines, 1_000);
    expect(bob.syncHealth.incompleteAnswers).toEqual([
      expect.objectContaining({ sender: "alice", received: 1, pieces: null }),
    ]);
    await run(engines, 10_000);
    expect(kindsOf(bob)).toContain("answer-incomplete");

    // Healing ends it: the rest of Bob's answer arrives.
    await aliceWire.release(toBob.slice(1));
    await run(engines, 1_000);
    expect(bob.syncHealth.incompleteAnswers).toEqual([]);
    expect(kindsOf(bob)).not.toContain("answer-incomplete");
    expect(getPlainText(bob.fragment)).toBe(getPlainText(alice.fragment));
  });

  it("an answer made while editing goes on ends as a whole, and raises no false alarm when the edits that follow delete", async () => {
    const shared = new InMemoryMessengerPort();
    const aliceWire = new Device(shared, "alice", SMALL);
    const alice = await DocumentEngine.create(
      DOCUMENT_ID,
      "alice",
      aliceWire.port,
      undefined,
      PACED,
    );
    await run([alice], 2_000);
    await alice.setMembership("bob", "write");
    alice.edit((fragment) => insertPlainText(fragment, 0, TEXT));
    await run([alice], 60_000);

    const before = await deliveries(shared);
    const bob = await DocumentEngine.join(
      DOCUMENT_ID,
      "bob",
      new Device(shared, "bob", SMALL).port,
      undefined,
      {
        ...PACED,
        creatorMemberId: "alice",
      },
    );
    const seen: string[] = [];
    // Alice goes on writing while her answer goes out piece by piece: she deletes and types.
    for (let second = 0; second < 30; second += 1) {
      alice.edit((fragment) => deletePlainText(fragment, 5 + second, 1));
      alice.edit((fragment) => insertPlainText(fragment, 0, "x"));
      await run([alice, bob], 1_000);
      seen.push(...kindsOf(bob));
    }
    for (let second = 0; second < 120; second += 1) {
      await run([alice, bob], 1_000);
      seen.push(...kindsOf(bob));
    }
    expect(getPlainText(bob.fragment)).toBe(getPlainText(alice.fragment));
    expect(seen.filter((kind) => kind === "diverged" || kind === "answer-incomplete")).toEqual([]);
    expect(await sentBy(shared, "bob", before, "resync-request")).toBe(1);
  });
});
