import { parseTransportProfile } from "@tdsp/messenger-port";
import { describe, expect, it } from "vitest";
import { InMemoryMessengerPort, mockMessengerProvider } from "./index";

// The payload is text (SPECIFICATION.md §3.1); these two keep the tests' own shape.
const enc = (s: string) => s;
const dec = (payload: string) => payload;

describe("InMemoryMessengerPort", () => {
  describe("a pure, open transport", () => {
    it("carries a send from any member id and shows it to any member id — it models neither channel membership nor permissions", async () => {
      const port = new InMemoryMessengerPort();
      await port.createDocument("doc-1", "alice");

      await port.send("doc-1", "nobody-granted-anything", enc("x"));

      const seen = await port.receive("doc-1", "someone-else-entirely");
      expect(seen.map((d) => d.sender)).toEqual(["nobody-granted-anything"]);
    });

    it("has no policy methods: membership, permissions and lifecycle belong to document-protocol", () => {
      const port = new InMemoryMessengerPort() as unknown as Record<string, unknown>;
      for (const removed of ["setMembership", "archiveDocument", "deleteDocument"]) {
        expect(removed in port).toBe(false);
      }
    });

    it("still rejects an unknown document, which is a transport fact", async () => {
      const port = new InMemoryMessengerPort();
      await expect(port.send("never-created", "alice", enc("x"))).rejects.toThrow(
        /unknown document/,
      );
      await expect(port.receive("never-created", "alice")).rejects.toThrow(/unknown document/);
    });
  });

  describe("transportProfile", () => {
    it("is unlimited by default", async () => {
      const profile = await new InMemoryMessengerPort().transportProfile();
      expect(profile.defaultProfile).toBe("instant");
      expect(profile.profiles.find((p) => p.id === "instant")?.values).toEqual({
        minIntervalMs: 0,
        maxIntervalMs: null,
        minChars: 0,
        maxChars: null,
        expectedLatencyMs: 0,
      });
      expect(profile.bounds).toEqual({ minIntervalMs: null, maxBytes: null });
    });

    it("also offers a slow profile, so the policy path can be seen and tested locally", async () => {
      const profile = await new InMemoryMessengerPort().transportProfile();
      expect(profile.profiles.find((p) => p.id === "slow")?.values.minIntervalMs).toBe(2_000);
    });

    it("is a valid profile", async () => {
      const profile = await new InMemoryMessengerPort().transportProfile();
      expect(parseTransportProfile(JSON.parse(JSON.stringify(profile)))).toEqual(profile);
    });
  });

  it("delivers a sent message to a member who then receives it", async () => {
    const port = new InMemoryMessengerPort();
    const documentId = "doc-1";

    await port.createDocument(documentId, "alice");

    await port.send(documentId, "alice", enc("hello"));

    const bobDeliveries = await port.receive(documentId, "bob");
    expect(bobDeliveries).toHaveLength(1);
    expect(bobDeliveries[0]?.sender).toBe("alice");
    expect(dec(bobDeliveries[0]?.payload ?? "")).toBe("hello");
  });

  describe("listChannels: raw channels for a picker, not documents", () => {
    it("returns only channels a member was seeded into", async () => {
      const port = new InMemoryMessengerPort();
      port.seedChannel("chan-1", "Alice & Bob", ["alice", "bob"]);
      port.seedChannel("chan-2", "Alice & Carol", ["alice", "carol"]);

      expect(await port.listChannels("alice")).toEqual(
        expect.arrayContaining([
          { id: "chan-1", name: "Alice & Bob" },
          { id: "chan-2", name: "Alice & Carol" },
        ]),
      );
      expect(await port.listChannels("bob")).toEqual([{ id: "chan-1", name: "Alice & Bob" }]);
      // dave belongs to neither — proves this is a real membership filter,
      // not just "every seeded channel".
      expect(await port.listChannels("dave")).toEqual([]);
    });

    it("is empty until a test seeds a channel — nothing pre-exists in a fresh mock", async () => {
      const port = new InMemoryMessengerPort();
      expect(await port.listChannels("alice")).toEqual([]);
    });

    it("is entirely independent of createDocument — binding a document never seeds or removes a raw channel", async () => {
      const port = new InMemoryMessengerPort();
      const documentId = "doc-1";

      // alice has no seeded channels at all, yet createDocument still
      // succeeds: binding-target selection happens
      // entirely outside MessengerPort, so createDocument itself must
      // never depend on, populate, or consult #rawChannels.
      await port.createDocument(documentId, "alice");
      expect(await port.listChannels("alice")).toEqual([]);

      port.seedChannel("chan-1", "Alice & Bob", ["alice"]);
      // seeding afterward doesn't retroactively associate with the
      // already-created document either — the two registries never touch.
      expect(await port.listChannels("alice")).toEqual([{ id: "chan-1", name: "Alice & Bob" }]);
    });
  });

  describe("fault injection", () => {
    it("freezes a disconnected member's view and catches them up on reconnect", async () => {
      const port = new InMemoryMessengerPort();
      const documentId = "doc-1";

      await port.createDocument(documentId, "alice");
      await port.send(documentId, "alice", enc("first"));

      port.disconnect("bob");
      // "first" was already sent before the disconnect, so it's part of
      // the frozen snapshot.
      expect(await port.receive(documentId, "bob")).toHaveLength(1);

      await port.send(documentId, "alice", enc("second"));
      // still frozen at the pre-disconnect state — "second" does not show
      // up while bob remains disconnected.
      expect(await port.receive(documentId, "bob")).toHaveLength(1);

      port.reconnect("bob");
      const caughtUp = await port.receive(documentId, "bob");
      expect(caughtUp).toHaveLength(2);
    });

    it("rejects sends from a disconnected member", async () => {
      const port = new InMemoryMessengerPort();
      const documentId = "doc-1";

      await port.createDocument(documentId, "alice");
      port.disconnect("alice");

      await expect(port.send(documentId, "alice", enc("x"))).rejects.toThrow();
    });

    it("withholds a held send until releaseHeld, simulating delay", async () => {
      const port = new InMemoryMessengerPort();
      const documentId = "doc-1";

      await port.createDocument(documentId, "alice");
      port.holdNextSend("alice");
      await port.send(documentId, "alice", enc("delayed"));

      expect(await port.receive(documentId, "alice")).toHaveLength(0);

      port.releaseHeld(documentId);
      const deliveries = await port.receive(documentId, "alice");
      expect(deliveries).toHaveLength(1);
      expect(dec(deliveries[0]?.payload ?? "")).toBe("delayed");
    });

    it("releases held deliveries out of send order when reordered", async () => {
      const port = new InMemoryMessengerPort();
      const documentId = "doc-1";

      await port.createDocument(documentId, "alice");
      port.holdNextSend("alice");
      await port.send(documentId, "alice", enc("first"));
      port.holdNextSend("alice");
      await port.send(documentId, "alice", enc("second"));

      port.releaseHeld(documentId, [1, 0]);

      const deliveries = await port.receive(documentId, "alice");
      expect(deliveries.map((d) => dec(d.payload))).toEqual(["second", "first"]);
    });

    it("never delivers a dropped send", async () => {
      const port = new InMemoryMessengerPort();
      const documentId = "doc-1";

      await port.createDocument(documentId, "alice");
      port.dropNextSend("alice");
      const id = await port.send(documentId, "alice", enc("lost"));

      expect(id).toBeTruthy(); // the sender is not told it was dropped
      expect(await port.receive(documentId, "alice")).toHaveLength(0);
    });

    it("delivers a modified payload instead of the original", async () => {
      const port = new InMemoryMessengerPort();
      const documentId = "doc-1";

      await port.createDocument(documentId, "alice");
      port.modifyNextSend("alice", () => enc("corrupted"));
      await port.send(documentId, "alice", enc("original"));

      const deliveries = await port.receive(documentId, "alice");
      expect(dec(deliveries[0]?.payload ?? "")).toBe("corrupted");
    });

    it("replays an already-recorded delivery under the same id", async () => {
      const port = new InMemoryMessengerPort();
      const documentId = "doc-1";

      await port.createDocument(documentId, "alice");
      const id = await port.send(documentId, "alice", enc("once"));
      port.replay(documentId, id);

      const deliveries = await port.receive(documentId, "alice");
      expect(deliveries).toHaveLength(2);
      expect(deliveries[0]?.id).toBe(deliveries[1]?.id);
    });
  });
});

describe("mockMessengerProvider", () => {
  it("has the id an application selects it by", () => {
    expect(mockMessengerProvider.id).toBe("mock");
  });

  it("createPort() returns the same shared port across calls, so every caller converges on one document", async () => {
    const portA = await mockMessengerProvider.createPort();
    const portB = await mockMessengerProvider.createPort();
    expect(portB).toBe(portA);

    const documentId = "doc-provider-shared";
    await portA.createDocument(documentId, "alice");
    // visible via portB too, proving it's the same underlying instance —
    // not just two ports that happen to behave the same.
    await portB.send(documentId, "bob", enc("via B"));
    expect((await portA.receive(documentId, "alice")).map((d) => dec(d.payload))).toEqual([
      "via B",
    ]);
  });

  it("faultInjection acts on the same port createPort() returns", async () => {
    const port = await mockMessengerProvider.createPort();
    const documentId = "doc-provider-fault-injection";
    await port.createDocument(documentId, "alice");

    mockMessengerProvider.faultInjection?.disconnect("bob");
    await expect(port.send(documentId, "bob", enc("hello"))).rejects.toThrow();

    mockMessengerProvider.faultInjection?.reconnect("bob");
    await expect(port.send(documentId, "bob", enc("hello"))).resolves.toBeDefined();
  });
});
