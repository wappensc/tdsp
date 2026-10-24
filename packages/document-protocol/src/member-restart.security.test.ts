import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import type { DeliveryId, MessengerPort } from "@tdsp/messenger-port";
import {
  applyUpdate,
  createDocument,
  encodeUpdate,
  getFragment,
  getPlainText,
  insertPlainText,
} from "@tdsp/reconciliation";
import { describe, expect, it } from "vitest";
import { decodeFrame } from "./framing";
import { DocumentEngine, type PersistedControlState, SendRefusedError } from "./index";

/**
 * A member that restarts keeps its rights (SPECIFICATION.md CTL-13, CTL-39, CTL-41): its
 * application persisted its control state as the engine handed it over, and its content with the
 * cursor its engine had reached (LIF-8). It may edit again once its first read went on from that
 * cursor without a gap — so a revocation that arrived meanwhile takes effect first — and only then.
 * With a gap, under another instance of its bridge, without a cursor, or with state taken before a
 * bootstrap, it waits for the creator's answer, and nothing it types leaves as an edit. Its
 * restored state is never authority.
 * Security tests: only the CI role may change this file (.github/CODEOWNERS, CONTRIBUTING.md).
 */

const DOCUMENT_ID = "doc-1";
/** Sends and answers at once, so each test sees its effects without waiting. */
const AS_ALICE = { batchWindowMs: 0, resyncResponseThrottleMs: 0, creatorMemberId: "alice" };

async function settle(...engines: DocumentEngine[]): Promise<void> {
  for (let round = 0; round < 8; round++) {
    for (const engine of engines) {
      await engine.sync();
    }
  }
}

interface Saved {
  readonly control: PersistedControlState;
  readonly content: {
    readonly state: Uint8Array;
    readonly cursor?: DeliveryId;
    readonly instance?: string;
  };
}

/**
 * Alice creates "Plan" and lets Bob write; Bob is bootstrapped. His application persists his
 * control state on every change and his content with his cursor when he stops.
 */
async function bobStops(port = new InMemoryMessengerPort()) {
  let control: PersistedControlState | undefined;
  const alice = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
  await alice.setMembership("bob", "write");
  const before = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, {
    ...AS_ALICE,
    onControlStateChange: (state) => {
      control = state;
    },
  });
  alice.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
  await settle(alice, before);
  expect(before.mayEdit).toBe(true);
  const saved: Saved = {
    control: control as PersistedControlState,
    content: { state: encodeUpdate(before.document), cursor: before.cursor },
  };
  before.dispose();
  return { port, alice, saved };
}

/** Bob starts again with what his application kept, through `port`; his refusals are collected. */
async function bobRestarts(port: MessengerPort, saved: Saved, refusals: string[]) {
  return DocumentEngine.join(
    DOCUMENT_ID,
    "bob",
    port,
    (error) => {
      if (error instanceof SendRefusedError) refusals.push(error.reason);
    },
    { ...AS_ALICE, controlState: saved.control, restore: saved.content },
  );
}

/** The edit frames Bob sent from delivery `from` on. */
async function editsOfBob(port: InMemoryMessengerPort, from: number) {
  return (await port.receive(DOCUMENT_ID, "observer"))
    .slice(from)
    .filter(
      (delivery) => delivery.sender === "bob" && decodeFrame(delivery.payload).kind === "edit",
    );
}

/** The same messenger without `receiveSince`: what a restarted engine reads proves nothing (LOS-8). */
function withoutCursor(port: InMemoryMessengerPort): MessengerPort {
  return {
    transportProfile: () => port.transportProfile(),
    createDocument: (documentId, creator) => port.createDocument(documentId, creator),
    send: (documentId, sender, payload) => port.send(documentId, sender, payload),
    receive: (documentId, member) => port.receive(documentId, member),
    listChannels: (member) => port.listChannels(member),
  };
}

describe("a member restarted with its persisted control state (CTL-13, CTL-39, CTL-41)", () => {
  it("edits again after its first read, with the creator away, and takes the state as no authority", async () => {
    const { port, alice, saved } = await bobStops();
    expect(saved.control.bootstrapped).toBe(true);
    expect(saved.content.cursor).toBeDefined();
    port.disconnect("alice");
    alice.dispose();
    const from = (await port.receive(DOCUMENT_ID, "observer")).length;

    const refusals: string[] = [];
    // `join()` reads once before it returns: that first read is what lets it edit.
    const bob = await bobRestarts(port, saved, refusals);
    expect(bob.permissionOf("bob")).toBe("write");
    expect(bob.mayEdit).toBe(true);

    bob.edit((fragment) => insertPlainText(fragment, 4, " B"));
    await settle(bob);
    expect(refusals).toEqual([]);
    // What left as edits is the content with Bob's change: his restored state, then the change.
    const received = createDocument();
    for (const delivery of await editsOfBob(port, from)) {
      const frame = decodeFrame(delivery.payload);
      if (frame.kind === "edit") applyUpdate(received, frame.update);
    }
    expect(getPlainText(getFragment(received))).toBe("Plan B");
    await expect(bob.setMembership("carol", "write")).rejects.toThrow(/not the creator/);
  });

  it("takes a revocation that arrived meanwhile before it may edit", async () => {
    const { port, alice, saved } = await bobStops();
    await alice.setMembership("bob", "read");
    await settle(alice);
    port.disconnect("alice");
    alice.dispose();
    const from = (await port.receive(DOCUMENT_ID, "observer")).length;

    const refusals: string[] = [];
    const bob = await bobRestarts(port, saved, refusals);
    await bob.sync();
    expect(bob.permissionOf("bob")).toBe("read");
    expect(bob.mayEdit).toBe(false);
    bob.edit((fragment) => insertPlainText(fragment, 4, " B"));
    await settle(bob);
    expect(refusals).not.toEqual([]);
    expect(await editsOfBob(port, from)).toEqual([]);
  });

  it("waits for the creator when its cursor has left the window, and nothing it types leaves", async () => {
    const { port, alice, saved } = await bobStops();
    alice.edit((fragment) => insertPlainText(fragment, 4, " (Alice)"));
    await settle(alice);
    const window = await port.receive(DOCUMENT_ID, "observer");
    port.forgetOldest(
      DOCUMENT_ID,
      window.findIndex((delivery) => delivery.id === saved.content.cursor) + 1,
    );
    port.disconnect("alice");
    const from = (await port.receive(DOCUMENT_ID, "observer")).length;

    const refusals: string[] = [];
    const bob = await bobRestarts(port, saved, refusals);
    await settle(bob);
    expect(bob.mayEdit).toBe(false);
    bob.edit((fragment) => insertPlainText(fragment, 0, "B: "));
    await settle(bob);
    expect(refusals).not.toEqual([]);
    expect(await editsOfBob(port, from)).toEqual([]);

    // The creator's answer bootstraps it, as on a first join.
    port.reconnect("alice");
    await settle(alice, bob);
    expect(bob.mayEdit).toBe(true);
    expect(getPlainText(bob.fragment)).toContain("(Alice)");
  });

  it("waits for the creator when its bridge may have lost something since (another instance), and nothing it types leaves", async () => {
    const { port, alice, saved } = await bobStops();
    // The instance Bob's engine held with his cursor, persisted with it (LIF-8, TRN-19).
    const content = { ...saved.content, instance: await port.instance() };
    // Alice revokes Bob's right; his bridge took the message and lost it in a restart, so his
    // cursor is still in the window and the answer to it is not truncated. Only the new instance
    // shows the loss (LOS-9).
    port.dropNextSend("alice");
    await alice.setMembership("bob", "read");
    await settle(alice);
    port.restartBridge();
    port.disconnect("alice");
    const from = (await port.receive(DOCUMENT_ID, "observer")).length;

    const refusals: string[] = [];
    const bob = await bobRestarts(port, { ...saved, content }, refusals);
    await settle(bob);
    expect(bob.hasCompletedBootstrap).toBe(false);
    expect(bob.mayEdit).toBe(false);
    bob.edit((fragment) => insertPlainText(fragment, 0, "B: "));
    await settle(bob);
    expect(refusals).not.toEqual([]);
    expect(await editsOfBob(port, from)).toEqual([]);
  });

  it("waits for the creator when a creator device's counters have a hole (LOS-10)", async () => {
    const { port, alice, saved } = await bobStops();
    port.dropNextSend("alice");
    await alice.setMembership("carol", "read"); // lost
    await alice.setMembership("dave", "read");
    await settle(alice);
    port.disconnect("alice");

    const refusals: string[] = [];
    const bob = await bobRestarts(port, saved, refusals);
    await settle(bob);
    expect(bob.permissionOf("dave")).toBe("read");
    expect(bob.mayEdit).toBe(false);
  });

  it("waits for the creator without a cursor: overlapping answers prove nothing after a restart (LOS-8)", async () => {
    const { port, alice, saved } = await bobStops();
    port.disconnect("alice");
    const from = (await port.receive(DOCUMENT_ID, "observer")).length;

    const refusals: string[] = [];
    const bob = await bobRestarts(withoutCursor(port), saved, refusals);
    await settle(bob);
    expect(bob.mayEdit).toBe(false);
    bob.edit((fragment) => insertPlainText(fragment, 0, "B: "));
    await settle(bob);
    expect(await editsOfBob(port, from)).toEqual([]);
    port.reconnect("alice");
    await settle(alice, bob);
    expect(bob.mayEdit).toBe(true);
  });

  it("uses nothing of state taken before a bootstrap", async () => {
    const { port, alice, saved } = await bobStops();
    port.disconnect("alice");
    const { bootstrapped: _, ...taken } = saved.control;

    const refusals: string[] = [];
    const bob = await bobRestarts(port, { ...saved, control: taken }, refusals);
    await settle(bob);
    expect(bob.permissionOf("bob")).toBeUndefined();
    expect(bob.mayEdit).toBe(false);
    port.reconnect("alice");
    await settle(alice, bob);
    expect(bob.mayEdit).toBe(true);
  });
});
