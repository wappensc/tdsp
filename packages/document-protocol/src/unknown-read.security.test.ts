import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import type {
  Delivery,
  DeliveryId,
  DocumentId,
  MemberId,
  MessengerPort,
} from "@tdsp/messenger-port";
import { getPlainText, insertPlainText } from "@tdsp/reconciliation";
import { describe, expect, it } from "vitest";
import { decodeFrame, encodeResyncResponseFrame } from "./framing";
import { DocumentEngine, type DocumentEngineOptions, SendRefusedError } from "./index";

/**
 * An unknown permission only reads (SPECIFICATION.md CTL-13, with LAY-5, §7.1): once bootstrapped, a
 * member that no register names refuses every edit of its own — of the content, of a layer it holds
 * no right on, the whole state in a resync — and sends none, whoever's answer bootstrapped it. The
 * creator's decision lifts it. Revoked stays apart from unknown, by its register, though both refuse.
 * The channel decides who takes part, and the creator names everyone it admits (LIF-9), so whom it has
 * not named waits as a reader. Security tests: only the CI role may change this file
 * (.github/CODEOWNERS).
 */

const DOC = "doc-1";
const LAYER = "com.example.comments/1";
const AS_ALICE = { batchWindowMs: 0, resyncResponseThrottleMs: 0, creatorMemberId: "alice" };

/** The in-memory transport, with a member's view that can lack everything sent so far. */
class Port implements MessengerPort {
  readonly inner = new InMemoryMessengerPort();
  readonly #hidden = new Map<MemberId, Set<DeliveryId>>();

  /** Nothing sent so far ever reaches `member`: a new device that sees no history. */
  async hideHistoryFrom(member: MemberId): Promise<void> {
    const hidden = this.#hidden.get(member) ?? new Set();
    for (const delivery of await this.inner.receive(DOC, member)) hidden.add(delivery.id);
    this.#hidden.set(member, hidden);
  }
  createDocument(documentId: DocumentId, creator: MemberId): Promise<void> {
    return this.inner.createDocument(documentId, creator);
  }
  send(documentId: DocumentId, sender: MemberId, payload: string): Promise<DeliveryId> {
    return this.inner.send(documentId, sender, payload);
  }
  async receive(documentId: DocumentId, member: MemberId): Promise<readonly Delivery[]> {
    const hidden = this.#hidden.get(member);
    const all = await this.inner.receive(documentId, member);
    return hidden === undefined ? all : all.filter((delivery) => !hidden.has(delivery.id));
  }
  listChannels(member: MemberId) {
    return this.inner.listChannels(member);
  }
}

async function settle(...engines: DocumentEngine[]): Promise<void> {
  for (let round = 0; round < 6; round++) {
    for (const engine of engines) {
      await engine.sync();
      await engine.flush().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

/** The kinds of the frames `member` sent, in order. */
async function sentBy(port: Port, member: MemberId): Promise<string[]> {
  return (await port.inner.receive(DOC, "observer"))
    .filter((delivery) => delivery.sender === member)
    .map((delivery) => decodeFrame(delivery.payload).kind);
}

const comments = (engine: DocumentEngine) => engine.document.getMap<string>(LAYER);
const comment = (engine: DocumentEngine, key: string, text: string) =>
  engine.document.transact(() => comments(engine).set(key, text));

/** A device of `member` joining, with the reasons of the refusals its application is told of. */
async function deviceOf(
  port: MessengerPort,
  member: MemberId,
  options: DocumentEngineOptions = {},
) {
  const refusals: string[] = [];
  const engine = await DocumentEngine.join(
    DOC,
    member,
    port,
    (error) => {
      if (error instanceof SendRefusedError) refusals.push(error.reason);
    },
    { ...AS_ALICE, ...options },
  );
  return { engine, refusals };
}

/** Alice wrote "Plan", decided what `decide` decides, and Bob joined and was bootstrapped by her. */
async function bobJoins(decide: (alice: DocumentEngine) => Promise<void> = async () => {}) {
  const port = new Port();
  const alice = await DocumentEngine.create(DOC, "alice", port, undefined, AS_ALICE);
  alice.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
  await decide(alice);
  const bob = await deviceOf(port, "bob");
  return { port, alice, bob };
}

describe("a member the creator has not named only reads, once bootstrapped (CTL-13)", () => {
  it("refuses every edit of its own — the content, a layer, the whole state — and sends none", async () => {
    const { port, alice, bob } = await bobJoins();
    // Before its bootstrap the reason is the bootstrap, as for everyone but the creator.
    await expect(bob.engine.resync()).rejects.toMatchObject({ reason: "awaiting-bootstrap" });
    await settle(alice, bob.engine);
    expect(bob.engine.hasCompletedBootstrap).toBe(true);
    expect(bob.engine.controlStanding).toStrictEqual({ kind: "bootstrapped" });
    expect(getPlainText(bob.engine.fragment)).toBe("Plan");

    expect(bob.engine.rightOf("bob")).toBe("unknown");
    expect(bob.engine.rightOf("bob", LAYER)).toBe("unknown");
    expect(bob.engine.permissionOf("bob")).toBeUndefined();
    expect(bob.engine.mayEdit).toBe(false);
    expect(bob.engine.mayEditLayer(LAYER)).toBe(false);
    await expect(bob.engine.resync()).rejects.toBeInstanceOf(SendRefusedError);
    await expect(bob.engine.resync()).rejects.toMatchObject({ reason: "unknown-permission" });

    // A change of a layer, then one of the content: each refused, permanently, and nothing sent.
    comment(bob.engine, "c1", "Too short?");
    bob.engine.edit((fragment) => insertPlainText(fragment, 4, " B"));
    await settle(bob.engine, alice);
    expect(bob.refusals).toStrictEqual(["unknown-permission", "unknown-permission"]);
    expect(await sentBy(port, "bob")).not.toContain("edit");
    expect(getPlainText(alice.fragment)).toBe("Plan");
    expect(comments(alice).get("c1")).toBeUndefined();
  });

  it("refuses on a device a member's answer bootstrapped, where what it brought does not name it", async () => {
    // Alice let Carol write, not Bob; she goes offline, and a new device of Bob's, which sees nothing
    // sent before, is bootstrapped by Carol's answer alone (RSY-14).
    const port = new Port();
    const alice = await DocumentEngine.create(DOC, "alice", port, undefined, AS_ALICE);
    await alice.setMembership("carol", "write");
    alice.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
    const carol = await DocumentEngine.join(DOC, "carol", port, undefined, AS_ALICE);
    await settle(alice, carol);
    port.inner.disconnect("alice");
    await port.hideHistoryFrom("bob");
    const bob = await deviceOf(port, "bob", { autoResync: false });
    const requests = (await port.inner.receive(DOC, "observer"))
      .map((delivery) => ({ sender: delivery.sender, frame: decodeFrame(delivery.payload) }))
      .filter(({ sender, frame }) => sender === "bob" && frame.kind === "resync-request");
    const request = requests.at(-1)?.frame;
    if (request?.kind !== "resync-request") throw new Error("bob asked nothing");
    await port.send(
      DOC,
      "carol",
      encodeResyncResponseFrame({
        documentId: DOC,
        respondsTo: request.requestId,
        update: new Uint8Array([0, 0]),
        control: carol.controlState,
      }),
    );
    await settle(bob.engine);
    expect(bob.engine.hasCompletedBootstrap).toBe(true);
    expect(bob.engine.controlStanding).toStrictEqual({ kind: "bootstrapped" });
    expect(bob.engine.permissionOf("carol")).toBe("write");

    expect(bob.engine.rightOf("bob")).toBe("unknown");
    expect(bob.engine.mayEdit).toBe(false);
    expect(bob.engine.mayEditLayer(LAYER)).toBe(false);
    await expect(bob.engine.resync()).rejects.toMatchObject({ reason: "unknown-permission" });
    bob.engine.edit((fragment) => insertPlainText(fragment, 0, "B "));
    await settle(bob.engine);
    expect(bob.refusals).toStrictEqual(["unknown-permission"]);
    expect(await sentBy(port, "bob")).not.toContain("edit");
  });

  it("writes once the creator names it: a later register `write` lifts the refusal, and its edits go out", async () => {
    const { alice, bob } = await bobJoins();
    await settle(alice, bob.engine);
    await expect(bob.engine.resync()).rejects.toMatchObject({ reason: "unknown-permission" });

    await alice.setMembership("bob", "write");
    await settle(alice, bob.engine);
    expect(bob.engine.rightOf("bob")).toBe("write");
    expect(bob.engine.mayEdit).toBe(true);
    expect(bob.engine.mayEditLayer(LAYER)).toBe(true);
    bob.engine.edit((fragment) => insertPlainText(fragment, 4, " B"));
    comment(bob.engine, "c1", "Too short?");
    await settle(bob.engine, alice);
    expect(getPlainText(alice.fragment)).toBe("Plan B");
    expect(comments(alice).get("c1")).toBe("Too short?");
    expect(bob.refusals).toStrictEqual([]);
  });

  it("keeps revoked apart from unknown: both refuse, each shown and refused under its own name", async () => {
    const { port, alice, bob } = await bobJoins((creator) => creator.setMembership("carol", null));
    const carol = await deviceOf(port, "carol");
    await settle(alice, bob.engine, carol.engine);
    for (const device of [bob.engine, carol.engine, alice]) {
      expect(device.rightOf("bob")).toBe("unknown");
      expect(device.rightOf("carol")).toBe("revoked");
      expect(device.memberPermissions.has("bob")).toBe(false);
      expect(device.memberPermissions.has("carol")).toBe(false);
      expect([...device.revokedMembers]).toStrictEqual(["carol"]);
    }
    expect(bob.engine.mayEdit).toBe(false);
    expect(carol.engine.mayEdit).toBe(false);
    await expect(bob.engine.resync()).rejects.toMatchObject({ reason: "unknown-permission" });
    await expect(carol.engine.resync()).rejects.toMatchObject({ reason: "revoked" });
    // A right on a layer gives a revoked member nothing (LAY-5); an unknown one it names there.
    await alice.setLayerRight(LAYER, "carol", "write");
    await alice.setLayerRight(LAYER, "bob", "write");
    await settle(alice, bob.engine, carol.engine);
    expect(carol.engine.mayEditLayer(LAYER)).toBe(false);
    expect(bob.engine.mayEditLayer(LAYER)).toBe(true);
  });

  it("a right on a layer names it there only: it writes that layer, and the content stays refused (LAY-5)", async () => {
    const { port, alice, bob } = await bobJoins((creator) =>
      creator.setLayerRight(LAYER, "bob", "write"),
    );
    await settle(alice, bob.engine);
    expect(bob.engine.rightOf("bob")).toBe("unknown");
    expect(bob.engine.rightOf("bob", LAYER)).toBe("write");
    expect(bob.engine.mayEditLayer(LAYER)).toBe(true);
    expect(bob.engine.mayEdit).toBe(false);

    comment(bob.engine, "c1", "Too short?");
    await settle(bob.engine, alice);
    expect(comments(alice).get("c1")).toBe("Too short?");
    // Typed after the layer change, so that nothing that is to arrive waits for it (CTL-42).
    bob.engine.edit((fragment) => insertPlainText(fragment, 4, " B"));
    await settle(bob.engine, alice);
    expect(getPlainText(alice.fragment)).toBe("Plan");
    expect(bob.refusals).toStrictEqual(["unknown-permission"]);
    expect((await sentBy(port, "bob")).filter((kind) => kind === "edit")).toHaveLength(1);
  });
});
