import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import { insertPlainText, isUpdate } from "@tdsp/reconciliation";
import { describe, expect, it } from "vitest";
import { decodeFrame } from "./framing";
import { DocumentEngine, SendRefusedError } from "./index";

/**
 * A change of one's own that the document's profile does not read is refused, never sent (SND-26):
 * for `yjs-paragraphs/1`, JSON content or an `Any` value nested more than 32 levels (YJS-1,
 * Appendix A). Every receiver would refuse such a frame (FRM-6); refused alone, it never takes a
 * change that may go along with it (LAY-7).
 */

const DOCUMENT_ID = "doc-1";
const OPTIONS = { batchWindowMs: 0, resyncResponseThrottleMs: 0 };
const LAYER = "com.example.comments/1";

/** A value of `levels` nested objects, the outermost the first level (Appendix A). */
function nested(levels: number): unknown {
  let value: unknown = 1;
  for (let level = 0; level < levels; level++) value = { a: value };
  return value;
}

async function aliceAndBob() {
  const port = new InMemoryMessengerPort();
  const errors: unknown[] = [];
  const alice = await DocumentEngine.create(
    DOCUMENT_ID,
    "alice",
    port,
    (error) => errors.push(error),
    OPTIONS,
  );
  await alice.setMembership("bob", "write");
  const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, {
    ...OPTIONS,
    creatorMemberId: "alice",
  });
  await alice.sync();
  await bob.sync();
  return { port, alice, bob, errors };
}

/** Alice's edit frames on the channel, in order. */
async function editsOfAlice(port: InMemoryMessengerPort): Promise<number> {
  return (await port.receive(DOCUMENT_ID, "observer")).filter(
    (delivery) => delivery.sender === "alice" && decodeFrame(delivery.payload).kind === "edit",
  ).length;
}

describe("a change of one's own the profile does not read (SND-26)", () => {
  it("32 levels go out and reach a member; 33 are refused as unreadable, reported once, and nothing is sent", async () => {
    const { port, alice, bob, errors } = await aliceAndBob();

    const before = await editsOfAlice(port);
    alice.document.transact(() => alice.document.getMap(LAYER).set("deep", nested(32)));
    await alice.flush();
    await bob.sync();
    expect(await editsOfAlice(port)).toBe(before + 1);
    expect(bob.document.getMap(LAYER).get("deep")).toStrictEqual(nested(32));
    expect(errors).toStrictEqual([]);
    expect(alice.hasUndistributedChanges).toBe(false);

    alice.document.transact(() => alice.document.getMap(LAYER).set("deeper", nested(33)));
    await alice.flush();
    expect(await editsOfAlice(port)).toBe(before + 1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(SendRefusedError);
    expect((errors[0] as SendRefusedError).reason).toBe("unreadable");
    // It stays in her replica, which others lack (SND-8, SND-21).
    expect(alice.hasUndistributedChanges).toBe(true);
  });

  it("refused alone: a readable change made in the same batch still goes out, readable — and waits at receivers for the refused change it builds on, which only the application can undo (LAY-7, LOS-23)", async () => {
    const port = new InMemoryMessengerPort();
    const errors: unknown[] = [];
    // Changes wait for a quiet time and are merged where they may be (SND-1).
    const alice = await DocumentEngine.create(
      DOCUMENT_ID,
      "alice",
      port,
      (error) => errors.push(error),
      {
        ...OPTIONS,
        batchWindowMs: 500,
      },
    );
    await alice.setMembership("bob", "write");
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, {
      ...OPTIONS,
      creatorMemberId: "alice",
    });
    await alice.sync();
    await bob.sync();

    const before = await editsOfAlice(port);
    alice.document.transact(() => alice.document.getMap(LAYER).set("deeper", nested(40)));
    alice.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
    await alice.flush();
    await bob.sync();
    expect(errors.map((error) => (error as SendRefusedError).reason)).toStrictEqual(["unreadable"]);
    // The readable change went out alone, in a frame every receiver reads (FRM-6)...
    const edits = (await port.receive(DOCUMENT_ID, "observer"))
      .filter((delivery) => delivery.sender === "alice")
      .map((delivery) => decodeFrame(delivery.payload))
      .filter((frame) => frame.kind === "edit");
    expect(edits).toHaveLength(before + 1);
    const last = edits.at(-1);
    expect(last?.kind === "edit" && isUpdate(last.update)).toBe(true);
    // ...but it builds on the refused one, from the same replica: Bob holds it back as a gap (LOS-2,
    // LOS-23), and nothing he asks for can bring the refused change. The application must not make
    // it (YJS-1) and undoes one the engine refuses.
    expect(bob.document.getXmlFragment("content").toString()).not.toContain("Plan");
  });
});
