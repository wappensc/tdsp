import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import { describe, expect, it } from "vitest";
import { DocumentEngine } from "./index";

/**
 * What only members hold, and the creator's explicit decision on it (SPECIFICATION.md CTL-27,
 * CTL-29, CTL-33): a device of the creator that
 * vanished decided something only a member holds; another device decides the same target wider,
 * not knowing it. The member keeps the narrower (CTL-23); deciding again does not change that. The
 * engine shows the divergence the member's report holds, for display only, and `confirmRights()`
 * issues the target again, counting the reported counters as seen: then everyone agrees.
 */

const DOCUMENT_ID = "doc-1";
const AS_ALICE = {
  batchWindowMs: 0,
  resyncResponseThrottleMs: 0,
  creatorMemberId: "alice",
  autoResync: false,
};

async function settle(...engines: DocumentEngine[]): Promise<void> {
  for (let round = 0; round < 6; round++) {
    for (const engine of engines) {
      await engine.sync();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

/** Alice's device A decides Carol `read` and Dave `read`; only Bob gets it, and A is gone. */
async function vanishedDecision() {
  const port = new InMemoryMessengerPort();
  const a = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
  await a.setMembership("bob", "write");
  const b = await DocumentEngine.join(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
  const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, AS_ALICE);
  await settle(a, b, bob);
  expect(b.controlConfirmed).toBe(true); // B has a basis: it counts nothing reported as seen (CTL-27)
  await a.setMembership("carol", "read");
  await a.setMembership("dave", "read");
  await settle(bob);
  // B never gets them: the window moved past them before it read again, and A is gone.
  port.forgetOldest(DOCUMENT_ID, (await port.receive(DOCUMENT_ID, "observer")).length);
  a.dispose();
  // B decides Carol wider, not knowing A's decision.
  await b.setMembership("carol", "write");
  await settle(b, bob);
  return { port, b, bob };
}

describe("a decision only members hold (CTL-27, CTL-33)", () => {
  it("does not converge by deciding again: the member keeps the narrower, the creator's device the wider", async () => {
    const { b, bob } = await vanishedDecision();
    expect(bob.permissionOf("carol")).toBe("read");
    expect(b.permissionOf("carol")).toBe("write");
    await b.setMembership("carol", "write");
    await settle(b, bob);
    expect(bob.permissionOf("carol")).toBe("read");
    expect(b.permissionOf("carol")).toBe("write");
  });

  it("shows the creator's device what the member's report holds, for display only", async () => {
    const { b, bob } = await vanishedDecision();
    expect(b.controlDivergences).toEqual([]);
    await b.requestResync();
    await settle(bob, b);
    expect(b.controlDivergences).toEqual([
      { reporter: "bob", target: "member:carol", reported: "read", held: "write" },
      { reporter: "bob", target: "member:dave", reported: "read", held: undefined },
    ]);
    // Nothing of the report holds on the creator's device (CTL-27, CTL-29).
    expect(b.permissionOf("carol")).toBe("write");
    expect(b.permissionOf("dave")).toBeUndefined();
    expect(bob.controlDivergences).toEqual([]);
  });

  it("converges once the person confirms: the new decisions supersede the unknown ones everywhere", async () => {
    const { b, bob } = await vanishedDecision();
    await b.requestResync();
    await settle(bob, b);
    await b.confirmRights();
    await settle(b, bob);
    for (const engine of [b, bob]) {
      expect(engine.permissionOf("carol")).toBe("write");
      // A member only the report named is confirmed as this device has it: not a member here.
      expect(engine.rightOf("dave")).toBe("revoked");
    }
    // The next report shows nothing beyond the creator's device any more.
    await b.requestResync();
    await settle(bob, b);
    expect(b.controlDivergences).toEqual([]);
  });

  it("confirms nothing that only members hold of a close: nothing undoes one", async () => {
    const port = new InMemoryMessengerPort();
    const a = await DocumentEngine.create(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
    const b = await DocumentEngine.join(DOCUMENT_ID, "alice", port, undefined, AS_ALICE);
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", port, undefined, AS_ALICE);
    await settle(a, b, bob);
    await a.closeDocument();
    await settle(bob);
    port.forgetOldest(DOCUMENT_ID, (await port.receive(DOCUMENT_ID, "observer")).length);
    a.dispose();
    await b.requestResync();
    await settle(bob, b);
    expect(b.controlDivergences).toEqual([
      { reporter: "bob", target: "close", reported: true, held: undefined },
    ]);
    await b.confirmRights();
    expect(b.closed).toBe(false);
    expect(b.controlDivergences).toHaveLength(1);
  });
});

describe("the person's choice per divergence (CTL-33)", () => {
  it("takes the value chosen for a target, a chosen null as a choice too, and the default for the rest", async () => {
    const { b, bob } = await vanishedDecision();
    await b.requestResync();
    await settle(bob, b);
    await b.confirmRights(new Map([["member:carol", null]]));
    await settle(b, bob);
    for (const engine of [b, bob]) {
      expect(engine.rightOf("carol")).toBe("revoked");
      expect(engine.rightOf("dave")).toBe("revoked"); // not chosen: as this device has it, no member
    }
  });

  it("refuses, issuing nothing, a choice for a target that does not diverge or a value it cannot take", async () => {
    const { b, bob } = await vanishedDecision();
    await b.requestResync();
    await settle(bob, b);
    const vector = b.controlVector;
    await expect(b.confirmRights(new Map([["member:erin", "read"]]))).rejects.toThrow(
      /no divergence/,
    );
    await expect(b.confirmRights(new Map([["member:dave", true]]))).rejects.toThrow(/cannot take/);
    expect(b.controlVector).toEqual(vector);
    expect(b.controlDivergences).toHaveLength(2);
  });
});

describe("a target only a report names, chosen by the person (CTL-33)", () => {
  it("issues the value the person chose for it, here the reported one, and the held value elsewhere", async () => {
    const { b, bob } = await vanishedDecision();
    await b.requestResync();
    await settle(bob, b);
    // Dave as Bob's report has him; Carol, left out, as the creator's device holds her.
    await b.confirmRights(new Map([["member:dave", "read"]]));
    await settle(b, bob);
    for (const engine of [b, bob]) {
      expect(engine.permissionOf("carol")).toBe("write");
      expect(engine.permissionOf("dave")).toBe("read");
    }
    await b.requestResync();
    await settle(bob, b);
    expect(b.controlDivergences).toEqual([]);
  });
});
