import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import { getPlainText, insertPlainText } from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clock } from "./clock";
import type { ControlValue } from "./control-state";
import { encodeControlFrame } from "./framing";
import { DocumentEngine, SendRefusedError } from "./index";
import { registerStateDigest } from "./registers";

/**
 * Rights on layers (SPECIFICATION.md §5.6, LAY-5, LAY-6, LAY-7): a member's right on a layer is the
 * one the creator set there, or else its permission on the document; its engine sends no change
 * of a layer it may not write, and a change that touches such a layer not at all, nor merged with
 * a change it may send. `com.example.comments/1` stands in for a layer an application defines.
 * A change the engine refuses stays in its document, and every later change of its CRDT client
 * waits for it at every receiver (CTL-13): an application keeps such a change out of the
 * document (CTL-42). So here a refused change is always typed after those that are to arrive.
 * Security tests: only the CI role may change this file (.github/CODEOWNERS, CONTRIBUTING.md).
 */

const DOCUMENT_ID = "doc-1";
const LAYER = "com.example.comments/1";
const AS_ALICE = { batchWindowMs: 0, resyncResponseThrottleMs: 0, creatorMemberId: "alice" };

async function settle(...engines: DocumentEngine[]): Promise<void> {
  for (let round = 0; round < 4; round++) {
    for (const engine of engines) {
      await vi.advanceTimersByTimeAsync(0);
      await engine.sync();
    }
  }
}

const comments = (engine: DocumentEngine) => engine.document.getMap<string>(LAYER);
const comment = (engine: DocumentEngine, key: string, text: string) =>
  engine.document.transact(() => comments(engine).set(key, text));

/** Alice wrote "Plan"; Bob has the permission and the right on the layer the test gives him. */
async function aliceAndBob(
  permission: "read" | "write",
  layerRight?: "read" | "write",
  bobOptions: { batchWindowMs?: number } = {},
) {
  const port = new InMemoryMessengerPort();
  const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
  await alice.setMembership("bob", permission);
  if (layerRight !== undefined) {
    await alice.setLayerRight(LAYER, "bob", layerRight);
  }
  alice.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
  const refusals: string[] = [];
  const bob = await DocumentEngine.join(
    DOCUMENT_ID,
    "bob",
    port,
    (error) => {
      if (error instanceof SendRefusedError) refusals.push(error.message);
    },
    { ...AS_ALICE, ...bobOptions },
  );
  await settle(alice, bob);
  expect(bob.hasCompletedBootstrap).toBe(true);
  return { port, alice, bob, refusals };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a right on a layer (LAY-5, LAY-6, LAY-7)", () => {
  it("lets a member who may only read the content write the layer, and nothing else", async () => {
    const { alice, bob, refusals } = await aliceAndBob("read", "write");
    expect(bob.permissionOf("bob", LAYER)).toBe("write");
    expect(bob.mayEditLayer(LAYER)).toBe(true);
    expect(bob.mayEdit).toBe(false);

    comment(bob, "c1", "Too short?");
    bob.edit((fragment) => insertPlainText(fragment, 4, " B"));
    await settle(bob, alice);

    expect(comments(alice).get("c1")).toBe("Too short?");
    expect(getPlainText(alice.fragment)).toBe("Plan");
    expect(refusals.length).toBe(1);
  });

  it("keeps a member who may write the content from the layer, and refuses a change that touches both whole", async () => {
    const { alice, bob, refusals } = await aliceAndBob("write", "read");
    expect(bob.mayEditLayer(LAYER)).toBe(false);
    expect(bob.mayEdit).toBe(true);

    bob.edit((fragment) => insertPlainText(fragment, 0, "My "));
    await settle(bob, alice);
    expect(getPlainText(alice.fragment)).toBe("My Plan");

    bob.document.transact(() => {
      insertPlainText(bob.fragment, 7, " B");
      comments(bob).set("c1", "and this");
    });
    comment(bob, "c2", "Too short?");
    await settle(bob, alice);
    expect(getPlainText(alice.fragment)).toBe("My Plan");
    expect(comments(alice).get("c1")).toBeUndefined();
    expect(comments(alice).get("c2")).toBeUndefined();
    expect(refusals.length).toBe(2);
    expect(refusals.every((message) => message.includes(LAYER))).toBe(true);
  });

  it("never merges a change it may send with one it may not", async () => {
    const { alice, bob, refusals } = await aliceAndBob("write", "read", { batchWindowMs: 500 });
    // Within one quiet time: what the scheduler would otherwise merge into one message.
    bob.edit((fragment) => insertPlainText(fragment, 4, " B"));
    bob.edit((fragment) => insertPlainText(fragment, 0, "My "));
    comment(bob, "c1", "Too short?");
    await vi.advanceTimersByTimeAsync(5_000);
    await settle(bob, alice);
    expect(getPlainText(alice.fragment)).toBe("My Plan B");
    expect(comments(alice).get("c1")).toBeUndefined();
    expect(refusals.length).toBe(1);
  });

  it("follows the permission on the document where none is set, and again once it is revoked", async () => {
    const { alice, bob, refusals } = await aliceAndBob("read");
    expect(bob.permissionOf("bob", LAYER)).toBe("read");
    expect(bob.mayEditLayer(LAYER)).toBe(false);

    await alice.setLayerRight(LAYER, "bob", "write");
    await settle(alice, bob);
    comment(bob, "c2", "two");
    await settle(bob, alice);
    expect(comments(alice).get("c2")).toBe("two");

    await alice.setLayerRight(LAYER, "bob", null);
    await settle(alice, bob);
    expect(bob.permissionOf("bob", LAYER)).toBe("read");
    expect(bob.mayEditLayer(LAYER)).toBe(false);
    comment(bob, "c3", "three");
    await settle(bob, alice);
    expect(comments(alice).get("c3")).toBeUndefined();
    expect(refusals.length).toBe(1);
  });

  it("leaves the creator every layer, cannot name the creator, and stops every layer once closed", async () => {
    const { alice, bob, refusals } = await aliceAndBob("write", "write");
    expect(alice.mayEditLayer(LAYER)).toBe(true);
    await expect(alice.setLayerRight(LAYER, "alice", "read")).rejects.toThrow(/creator/);
    await expect(alice.setLayerRight("comments", "bob", "read")).rejects.toThrow(/layer id/);
    comment(alice, "a1", "from the creator");
    await settle(alice, bob);
    expect(comments(bob).get("a1")).toBe("from the creator");

    await alice.closeDocument();
    await settle(alice, bob);
    expect(bob.mayEditLayer(LAYER)).toBe(false);
    comment(bob, "c1", "after the close");
    await settle(bob, alice);
    expect(comments(alice).get("c1")).toBeUndefined();
    expect(refusals.length).toBe(1);
  });

  it("reaches a joiner in the snapshot, and a snapshot naming the creator on a layer is rejected whole", async () => {
    const { port, alice } = await aliceAndBob("read", "write");
    const carol = await DocumentEngine.join(DOCUMENT_ID, "carol", port, undefined, AS_ALICE);
    await settle(alice, carol);
    expect(carol.permissionOf("bob", LAYER)).toBe("write");
    expect(carol.layerRights.get(LAYER)?.get("bob")).toBe("write");

    const errors: unknown[] = [];
    const dave = await DocumentEngine.join(
      DOCUMENT_ID,
      "dave",
      port,
      (error) => errors.push(error),
      AS_ALICE,
    );
    port.modifyNextSend("alice", (payload) => {
      const frame = JSON.parse(payload) as {
        kind: string;
        control: { targets: Record<string, unknown> } | null;
      };
      if (frame.kind === "resync-response" && frame.control !== null) {
        const [, state] = Object.entries(frame.control.targets)[0] as [string, unknown];
        frame.control.targets[`layer:${LAYER}:member:alice`] = state;
      }
      return JSON.stringify(frame);
    });
    await alice.sync();
    await dave.sync();
    expect(dave.hasCompletedBootstrap).toBe(false);
    expect(errors.some((error) => String(error).includes("names the creator"))).toBe(true);
  });
});

describe("of two decisions on a layer at the same clock and tag the narrower holds: read, then inherit, then write (CTL-23, LAY-5)", () => {
  /**
   * Bob writes the content; two `control` frames of Alice's identity decide his right on the layer
   * with one clock and one device tag — a copy of a device, say —, in the order given. Returns the
   * value Bob holds then, and whether he may write the layer.
   */
  async function tie(first: ControlValue, second: ControlValue) {
    const port = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
    await alice.setMembership("bob", "write");
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, AS_ALICE);
    await settle(alice, bob);
    const target = `layer:${LAYER}:member:bob`;
    const clock: Clock = [Date.now() + 1_000, 0];
    const device = "T".repeat(22);
    for (const value of [first, second]) {
      const targets = { [target]: { value, clock, device } };
      await port.send(
        DOCUMENT_ID,
        "alice",
        encodeControlFrame({
          documentId: DOCUMENT_ID,
          device,
          targets,
          closed: false,
          controlClock: clock,
          controlDigest: registerStateDigest({ closed: false, targets }),
        }),
      );
      await bob.sync();
    }
    return { value: bob.controlState.targets[target]?.value, mayWrite: bob.mayEditLayer(LAYER) };
  }

  it("read and inherit: read, in either order — a reset may not let a member write who should only read", async () => {
    expect(await tie("read", null)).toStrictEqual({ value: "read", mayWrite: false });
    expect(await tie(null, "read")).toStrictEqual({ value: "read", mayWrite: false });
  });

  it("inherit and write: inherit, in either order", async () => {
    expect((await tie(null, "write")).value).toBeNull();
    expect((await tie("write", null)).value).toBeNull();
  });
});

describe("of two decisions on a layer the later holds, and a revoked member has no layer (CTL-22, CTL-23, LAY-5, LAY-6)", () => {
  /** Two devices of Alice, both with Bob writing the content, and Bob bootstrapped. */
  async function twoDevicesAndBob() {
    const port = new InMemoryMessengerPort();
    const laptop = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
    await laptop.setMembership("bob", "write");
    laptop.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
    const tablet = await DocumentEngine.join(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
    const refusals: SendRefusedError[] = [];
    const bob = await DocumentEngine.join(
      DOCUMENT_ID,
      "bob",
      port,
      (error) => {
        if (error instanceof SendRefusedError) refusals.push(error);
      },
      AS_ALICE,
    );
    await settle(laptop, tablet, bob);
    expect(bob.hasCompletedBootstrap).toBe(true);
    return { laptop, tablet, bob, refusals };
  }

  it("a reset to inherit made after a restriction it had not seen holds over it everywhere: the later decision, not the narrower (CTL-22)", async () => {
    const { laptop, tablet, bob } = await twoDevicesAndBob();
    vi.setSystemTime(Date.now() + 60_000);
    const restriction = laptop.setLayerRight(LAYER, "bob", "read");
    vi.setSystemTime(Date.now() + 60_000);
    const reset = tablet.setLayerRight(LAYER, "bob", null);
    await Promise.all([restriction, reset]);
    await settle(laptop, tablet, bob);
    for (const client of [laptop, tablet, bob]) {
      expect(client.permissionOf("bob", LAYER)).toBe("write");
    }
    comment(bob, "c1", "now");
    await settle(bob, laptop);
    expect(comments(laptop).get("c1")).toBe("now");
  });

  it("a restriction made after a reset to inherit it had not seen holds over it everywhere: the member may only read the layer", async () => {
    const { laptop, tablet, bob, refusals } = await twoDevicesAndBob();
    vi.setSystemTime(Date.now() + 60_000);
    const reset = tablet.setLayerRight(LAYER, "bob", null);
    vi.setSystemTime(Date.now() + 60_000);
    const restriction = laptop.setLayerRight(LAYER, "bob", "read");
    await Promise.all([reset, restriction]);
    await settle(laptop, tablet, bob);
    for (const client of [laptop, tablet, bob]) {
      expect(client.permissionOf("bob", LAYER)).toBe("read");
    }
    expect(bob.mayEditLayer(LAYER)).toBe(false);
    comment(bob, "c1", "Too short?");
    await settle(bob, laptop);
    expect(comments(laptop).get("c1")).toBeUndefined();
    expect(refusals.length).toBe(1);
  });

  it("a reset to inherit that had seen the restriction supersedes it: the layer follows the document again", async () => {
    const { laptop, tablet, bob } = await twoDevicesAndBob();
    await laptop.setLayerRight(LAYER, "bob", "read");
    await settle(laptop, tablet, bob);
    await tablet.setLayerRight(LAYER, "bob", null);
    await settle(laptop, tablet, bob);
    expect(bob.permissionOf("bob", LAYER)).toBe("write");
    comment(bob, "c1", "now");
    await settle(bob, laptop);
    expect(comments(laptop).get("c1")).toBe("now");
  });

  it("a member whose permission is revoked is refused on every layer, also where it holds a right write", async () => {
    const { alice, bob, refusals } = await aliceAndBob("write", "write");
    expect(bob.mayEditLayer(LAYER)).toBe(true);
    await alice.setMembership("bob", null);
    await settle(alice, bob);
    expect(bob.rightOf("bob", LAYER)).toBe("revoked");
    expect(bob.permissionOf("bob", LAYER)).toBeUndefined();
    expect(bob.mayEditLayer(LAYER)).toBe(false);
    comment(bob, "c1", "after the revocation");
    await settle(bob, alice);
    expect(comments(alice).get("c1")).toBeUndefined();
    expect(refusals.length).toBe(1);
  });
});
