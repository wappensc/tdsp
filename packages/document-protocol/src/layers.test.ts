import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import { encodeUpdate, getPlainText, insertPlainText } from "@tdsp/reconciliation";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DocumentEngine, isLayerId } from "./index";

/**
 * Layers beside a document's content (SPECIFICATION.md §5.6): every engine keeps and passes
 * them on (LAY-1), and they count in neither the projection nor attribution (LAY-3).
 * `com.example.comments/1` stands in for a layer an application defines.
 */

const DOCUMENT_ID = "doc-1";
const OPTIONS = { batchWindowMs: 0, resyncResponseThrottleMs: 0 };
const LAYER = "com.example.comments/1";

const comments = (engine: DocumentEngine) => engine.document.getMap<string>(LAYER);

async function aliceAndBob(port = new InMemoryMessengerPort()) {
  const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, OPTIONS);
  await alice.setMembership("bob", "write");
  const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, {
    ...OPTIONS,
    creatorMemberId: "alice",
  });
  await alice.sync();
  await bob.sync();
  alice.edit((fragment) => insertPlainText(fragment, 0, "The dog barks."));
  await bob.sync();
  return { port, alice, bob };
}

describe("layers (SPECIFICATION.md §5.6)", () => {
  it("names a layer by an id of a profile id's form", () => {
    expect(isLayerId(LAYER)).toBe(true);
    expect(isLayerId("content")).toBe(false);
    expect(isLayerId("Com.Example/1")).toBe(false);
  });

  it("lists the layers a document holds, and nothing else among its top-level types", async () => {
    const { alice, bob } = await aliceAndBob();
    expect(bob.layers).toEqual([]);
    alice.document.transact(() => comments(alice).set("c1", "Too loud?"));
    alice.document.transact(() => alice.document.getMap("not-a-layer").set("x", "y"));
    await bob.sync();
    expect(bob.layers).toEqual([LAYER]);
  });

  it("a layer counts in neither the projection nor attribution (LAY-3)", async () => {
    const { alice, bob } = await aliceAndBob();
    const ranges = JSON.stringify(bob.attribution.ranges);
    alice.document.transact(() => comments(alice).set("c1", "Too loud?"));
    await bob.sync();
    expect(getPlainText(bob.fragment)).toBe("The dog barks.");
    expect(JSON.stringify(bob.attribution.ranges)).toBe(ranges);
    expect(bob.document.getMap<string>(LAYER).get("c1")).toBe("Too loud?");
  });

  it("an engine whose application ignores a layer passes it on: to a restarted creator, and in a whole-state resend (LAY-1)", async () => {
    const { port, alice, bob } = await aliceAndBob();
    alice.document.transact(() => comments(alice).set("c1", "Too loud?"));
    await bob.sync();
    const controlState = {
      control: alice.controlState,
      device: alice.deviceTag as string,
      counter: alice.controlVector[alice.deviceTag as string] ?? 0,
    };
    alice.dispose();

    // The creator comes back without its content; only a peer can give it back (RSY-6).
    const hidden = new Set((await port.receive(DOCUMENT_ID, "x")).map((delivery) => delivery.id));
    const forgetful = {
      ...port,
      transportProfile: () => port.transportProfile(),
      createDocument: (d: string, c: string) => port.createDocument(d, c),
      listChannels: (m: string) => port.listChannels(m),
      send: (d: string, s: string, p: string) => port.send(d, s, p),
      receive: async (d: string, m: string) =>
        (await port.receive(d, m)).filter((delivery) => m !== "alice" || !hidden.has(delivery.id)),
    };
    const restarted = await DocumentEngine.join(DOCUMENT_ID, "alice", forgetful, undefined, {
      ...OPTIONS,
      creatorMemberId: "alice",
      controlState,
    });
    await bob.sync(); // bob, who never looked at the layer, answers the creator
    await restarted.sync();
    expect(restarted.document.getMap<string>(LAYER).get("c1")).toBe("Too loud?");
    expect(getPlainText(restarted.fragment)).toBe("The dog barks.");

    // A whole-state resend carries it too.
    const carol = new Y.Doc();
    Y.applyUpdate(carol, encodeUpdate(bob.document));
    expect(carol.getMap<string>(LAYER).get("c1")).toBe("Too loud?");
  });

  it("restored content keeps its layers (LAY-1)", async () => {
    const { port, alice, bob } = await aliceAndBob();
    alice.document.transact(() => comments(alice).set("c1", "Too loud?"));
    await bob.sync();
    const saved = encodeUpdate(bob.document);
    const restored = await DocumentEngine.join(DOCUMENT_ID, "bob", port, () => {}, {
      ...OPTIONS,
      creatorMemberId: "alice",
      restore: { state: saved },
    });
    expect(restored.layers).toEqual([LAYER]);
    expect(restored.document.getMap<string>(LAYER).get("c1")).toBe("Too loud?");
  });
});
