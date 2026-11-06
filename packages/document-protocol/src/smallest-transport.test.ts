import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import type { MessengerPort, TransportProfile } from "@tdsp/messenger-port";
import { getPlainText, insertPlainText } from "@tdsp/reconciliation";
import { describe, expect, it } from "vitest";
import { DocumentEngine, MIN_MESSAGE_BYTES, TransportTooSmallError } from "./index";

/**
 * The smallest transport (SPECIFICATION.md TRN-23, Appendix B): every transport carries frames of at
 * least 4 MiB, and an engine fails the creation or the join of a document on one whose profile
 * states less, with an error of its own that names the bound, before it sends anything. Without a
 * bound nothing is refused. There is no option that lets an engine run on a smaller one.
 */

const DOC = "doc-1";

/**
 * The shared mock as one device's transport, whose profile states `maxBytes` — or cannot be fetched,
 * `"fails"`; what it sends, and the documents it registers, are kept.
 */
function transport(shared: InMemoryMessengerPort, maxBytes: number | null | "fails") {
  const sent: string[] = [];
  const registered: string[] = [];
  const port: MessengerPort = {
    transportProfile: async (): Promise<TransportProfile> => {
      if (maxBytes === "fails") throw new Error("the bridge is unreachable");
      const profile = await shared.transportProfile();
      return { ...profile, bounds: { ...profile.bounds, maxBytes } };
    },
    createDocument: (documentId, creator) => {
      registered.push(documentId);
      return shared.createDocument(documentId, creator);
    },
    listChannels: (member) => shared.listChannels(member),
    receive: (documentId, member) => shared.receive(documentId, member),
    send: (documentId, sender, payload) => {
      sent.push(payload);
      return shared.send(documentId, sender, payload);
    },
  };
  return { port, sent, registered };
}

/** Alice's document, created on a transport of `maxBytes`, with Bob named a writer (LIF-9). */
async function created(
  shared: InMemoryMessengerPort,
  maxBytes: number | null = MIN_MESSAGE_BYTES,
): Promise<DocumentEngine> {
  const alice = await DocumentEngine.create(DOC, "alice", transport(shared, maxBytes).port);
  await alice.setMembership("bob", "write");
  return alice;
}

/** The refusal of a transport that states `maxBytes`: its own error, naming both bounds. */
function refusalOf(maxBytes: number) {
  return expect.objectContaining({
    name: "TransportTooSmallError",
    maxBytes,
    message: expect.stringMatching(
      new RegExp(`at most ${maxBytes} bytes.*at least ${MIN_MESSAGE_BYTES}`),
    ),
  });
}

describe("the smallest transport (TRN-23)", () => {
  it("carries 4 MiB, 4 194 304 bytes", () => {
    expect(MIN_MESSAGE_BYTES).toBe(4_194_304);
  });

  it("a creation on a transport of 4 194 303 bytes fails with an error of its own, sends nothing and registers no channel (TRN-14)", async () => {
    const shared = new InMemoryMessengerPort();
    const { port, sent, registered } = transport(shared, 4_194_303);
    const refusal = await DocumentEngine.create(DOC, "alice", port).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(TransportTooSmallError);
    expect(refusal).toEqual(refusalOf(4_194_303));
    expect(sent).toStrictEqual([]);
    expect(registered).toStrictEqual([]);
    expect(await shared.listChannels("alice")).toStrictEqual([]);
  });

  it("a creation whose transport profile cannot be fetched fails with that error, sends nothing and registers no channel (TRN-14)", async () => {
    const shared = new InMemoryMessengerPort();
    const { port, sent, registered } = transport(shared, "fails");
    const refusal = await DocumentEngine.create(DOC, "alice", port).catch(
      (error: unknown) => error,
    );
    expect(refusal).toEqual(expect.objectContaining({ message: "the bridge is unreachable" }));
    expect(sent).toStrictEqual([]);
    expect(registered).toStrictEqual([]);
    expect(await shared.listChannels("alice")).toStrictEqual([]);
  });

  it("a join on a transport of 4 194 303 bytes fails with an error of its own, and sends nothing", async () => {
    const shared = new InMemoryMessengerPort();
    const alice = await created(shared);
    const { port, sent } = transport(shared, 4_194_303);
    const refusal = await DocumentEngine.join(DOC, "bob", port, undefined, {
      creatorMemberId: "alice",
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(TransportTooSmallError);
    expect(refusal).toEqual(refusalOf(4_194_303));
    expect(sent).toStrictEqual([]);
    alice.dispose();
  });

  it("a creation and a join on a transport of 4 194 304 bytes succeed", async () => {
    const shared = new InMemoryMessengerPort();
    const alice = await created(shared, 4_194_304);
    const { port, sent } = transport(shared, 4_194_304);
    const bob = await DocumentEngine.join(DOC, "bob", port, undefined, {
      creatorMemberId: "alice",
    });
    expect(alice.transportProfile?.bounds.maxBytes).toBe(4_194_304);
    expect(bob.transportProfile?.bounds.maxBytes).toBe(4_194_304);
    await alice.sync(); // answers Bob's start request (RSY-1)
    await bob.sync();
    expect(sent.length).toBeGreaterThan(0);
    expect(bob.hasCompletedBootstrap).toBe(true);
    alice.dispose();
    bob.dispose();
  });

  it("a creation and a join on a transport without a bound succeed", async () => {
    const shared = new InMemoryMessengerPort();
    const alice = await created(shared, null);
    const bob = await DocumentEngine.join(DOC, "bob", transport(shared, null).port, undefined, {
      creatorMemberId: "alice",
    });
    await alice.sync();
    await bob.sync();
    expect(alice.transportProfile?.bounds.maxBytes).toBeNull();
    expect(bob.hasCompletedBootstrap).toBe(true);
    alice.dispose();
    bob.dispose();
  });

  it("two devices of the creator on a transport of 6 000 bytes, whose merge could hold a control state no answer of it carries (CTL-30, CTL-37), get no further than the creation: it fails, and so does the other device's join", async () => {
    const shared = new InMemoryMessengerPort();
    const laptop = await DocumentEngine.create(DOC, "alice", transport(shared, 6_000).port).catch(
      (error: unknown) => error,
    );
    expect(laptop).toEqual(refusalOf(6_000));
    // The phone, a second device of the creator, joining the document as its creator (CTL-20).
    const phone = transport(shared, 6_000);
    const joined = await DocumentEngine.join(DOC, "alice", phone.port, undefined, {
      creatorMemberId: "alice",
    }).catch((error: unknown) => error);
    expect(joined).toEqual(refusalOf(6_000));
    expect(phone.sent).toStrictEqual([]);
  });
});

describe("an edit near the bound, with an extension on every edit frame (SND-17, FRM-11, TRN-23)", () => {
  it("a 200 KB value counts in every edit frame's size: 3 000 000 characters at once go in pieces, each within 4 MiB, and arrive whole", {
    timeout: 60_000,
  }, async () => {
    const shared = new InMemoryMessengerPort();
    const { port, sent } = transport(shared, MIN_MESSAGE_BYTES);
    const extensions = [{ name: "com.example.pad/1", values: { edit: "y".repeat(200_000) } }];
    const alice = await DocumentEngine.create(DOC, "alice", port, undefined, {
      batchWindowMs: 0,
      extensions,
    });
    await alice.setMembership("bob", "write");
    const bob = await DocumentEngine.join(
      DOC,
      "bob",
      transport(shared, MIN_MESSAGE_BYTES).port,
      undefined,
      {
        creatorMemberId: "alice",
      },
    );
    await alice.sync();
    await bob.sync();
    expect(bob.hasCompletedBootstrap).toBe(true);
    const before = sent.length;
    alice.edit((fragment) => insertPlainText(fragment, 0, "a".repeat(3_000_000)));
    await alice.flush();
    const sizes = sent.slice(before).map((payload) => new TextEncoder().encode(payload).length);
    const edits = sent.slice(before).filter((payload) => JSON.parse(payload).kind === "edit");
    expect(edits.length).toBeGreaterThan(1);
    for (const size of sizes) expect(size).toBeLessThanOrEqual(MIN_MESSAGE_BYTES);
    await bob.sync();
    expect(getPlainText(bob.fragment)).toHaveLength(3_000_000);
    alice.dispose();
    bob.dispose();
  });
});
