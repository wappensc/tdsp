import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, type LogRecord } from "@tdsp/bridge-log";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BindRecord, getBindRecord, setBindRecord } from "./bind-store.ts";
import {
  FakeGpgInvoker,
  fakeClearsign,
  fakeEncrypt,
  fakeKey,
  tamperWithFakeMessage,
} from "./fake-gpg.ts";
import type { GpgInvoker } from "./gpg-invoke.ts";
import { keyringPathFor } from "./keyring-store.ts";
import type { IncomingMail, MailReceiver } from "./mail-transport.ts";
import { createSyncState } from "./sync-state.ts";

/** L0 — a fake `MailReceiver` letting these tests seed exactly the messages a real IMAP search would have returned, without a real mailbox. */
class FakeMailReceiver implements MailReceiver {
  readonly tls = "plaintext-loopback" as const;
  verifyFailure: Error | undefined;

  async verify(): Promise<void> {
    if (this.verifyFailure) {
      throw this.verifyFailure;
    }
  }

  #byDocument = new Map<string, IncomingMail[]>();

  seed(documentId: string, messages: readonly IncomingMail[]): void {
    this.#byDocument.set(documentId, [...(this.#byDocument.get(documentId) ?? []), ...messages]);
  }

  async fetchThreadMessages(documentId: string): Promise<readonly IncomingMail[]> {
    return this.#byDocument.get(documentId) ?? [];
  }
}

function mail(overrides: Partial<IncomingMail> = {}): IncomingMail {
  return {
    messageId: "m1",
    from: "bob@example.org",
    to: ["alice@example.org"],
    cc: [],
    text: "",
    ...overrides,
  };
}

/**
 * Security tests: only the CI role may change this file (.github/CODEOWNERS,
 * CONTRIBUTING.md).
 *
 * L0 — PGP-enabled documents, with `FakeGpgInvoker` standing in for
 * `gpg`. Four keyrings: Alice's (her secret key plus Bob's public key, used
 * to *produce* messages), Mallory's and a rotated Alice key's likewise, and the
 * receiving bridge's — Bob's own keyring, holding his secret key and, from
 * some unrelated, legitimate exchange, Mallory's and a rotated Alice's public
 * keys, **none of which the document may ever consult**: what it verifies
 * against is its own keyring, holding exactly the keys the creator's
 * invitation pinned (here Alice's and Bob's).
 */
describe("createSyncState", () => {
  const FP_ALICE = "A".repeat(40);
  const FP_MALLORY = "B".repeat(40);
  const FP_ALICE_NEW = "C".repeat(40);
  const FP_BOB = "D".repeat(40);
  const FP_CAROL = "E".repeat(40);

  let tempDir: string;
  let bindStorePath: string;
  let receiver: FakeMailReceiver;
  let bobKeyring: FakeGpgInvoker;
  let aliceSigns: FakeGpgInvoker;
  let malloryPretendsToBeAlice: FakeGpgInvoker;
  let aliceNewKey: FakeGpgInvoker;

  /** A sender's keyring: their own secret key, and Bob's public key (so they can encrypt to him). */
  function senderKeyring(address: string, fingerprint: string): FakeGpgInvoker {
    const keyring = new FakeGpgInvoker();
    keyring.seedSecretKey(address, fingerprint);
    keyring.seedKey("bob@example.org", fakeKey("D", "bob@example.org"));
    return keyring;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "email-bridge-sync-state-pgp-test-"));
    bindStorePath = join(tempDir, "tdsp-threads.json");
    receiver = new FakeMailReceiver();

    bobKeyring = new FakeGpgInvoker();
    bobKeyring.seedSecretKey("bob@example.org", FP_BOB);
    bobKeyring.seedKey("alice@example.org", fakeKey("A", "alice@example.org"));
    bobKeyring.seedKey("mallory@example.org", fakeKey("B", "mallory@example.org"));
    bobKeyring.seedKey("alice-new@example.org", fakeKey("C", "alice-new@example.org"));

    aliceSigns = senderKeyring("alice@example.org", FP_ALICE);
    malloryPretendsToBeAlice = senderKeyring("alice@example.org", FP_MALLORY);
    aliceNewKey = senderKeyring("alice@example.org", FP_ALICE_NEW);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Binds doc-1 the way an accepted invitation leaves it at Bob's bridge: every participant
   * pinned, and a keyring of the document's own holding exactly those keys.
   * `pins` overrides who is pinned to what; the keyring always follows the pins.
   */
  function bind(
    overrides: Partial<BindRecord> = {},
    pins: Record<string, string> = { "alice@example.org": FP_ALICE, "bob@example.org": FP_BOB },
  ) {
    const keyringPath = keyringPathFor(bindStorePath, "doc-1");
    const ring = bobKeyring.withKeyring(keyringPath);
    for (const [address, fingerprint] of Object.entries(pins)) {
      ring.seedKey(address, { fingerprint, userIds: [address] });
    }
    setBindRecord(bindStorePath, "doc-1", {
      recipients: ["alice@example.org", "bob@example.org"],
      creatorMemberId: "alice@example.org",
      profile: "yjs-paragraphs/1",
      threadRootMessageId: "<root@example.org>",
      createdAt: new Date(0).toISOString(),
      pgpEnabled: true,
      pinnedFingerprints: pins,
      keyringPath,
      ownFingerprint: FP_BOB,
      ...overrides,
    });
  }

  const EDIT = { tdsp: 1, kind: "frame", documentId: "doc-1", frame: "AQID" };

  /** A message as Bob's IMAP would return it: headers say alice→bob, body signed and encrypted (to Bob) by whoever `signer` holds the secret key for. */
  async function fromAlice(
    signer: FakeGpgInvoker,
    envelope: object,
    messageId: string,
    overrides: Partial<IncomingMail> = {},
  ): Promise<IncomingMail> {
    return mail({
      messageId,
      from: "alice@example.org",
      to: ["bob@example.org"],
      text: await signer.signAndEncrypt(JSON.stringify(envelope), "alice@example.org", [FP_BOB]),
      ...overrides,
    });
  }

  function plainFromAlice(envelope: object, messageId: string): IncomingMail {
    return mail({
      messageId,
      from: "alice@example.org",
      to: ["bob@example.org"],
      text: JSON.stringify(envelope),
    });
  }

  it("accepts an edit signed by the key pinned for its sender and encrypted to this bridge, and applies it", async () => {
    bind();
    receiver.seed("doc-1", [await fromAlice(aliceSigns, EDIT, "m1")]);
    const sync = createSyncState(receiver, bindStorePath, bobKeyring);
    await sync.pollOnce("doc-1");
    expect(sync.getDeliveries("doc-1")).toHaveLength(1);
    expect(sync.getDeliveries("doc-1")[0]?.payload).toBe("AQID");
    expect(sync.getRejections("doc-1")).toEqual([]);
  });

  it("rejects a message larger than it reads without handing it to gpg (BRG-13)", async () => {
    bind();
    receiver.seed("doc-1", [
      mail({ messageId: "m1", from: "alice@example.org", to: [], text: "", tooLarge: true }),
    ]);
    const sync = createSyncState(receiver, bindStorePath, bobKeyring);
    await sync.pollOnce("doc-1");
    expect(sync.getDeliveries("doc-1")).toHaveLength(0);
    expect(sync.getRejections("doc-1")).toEqual([
      { messageId: "m1", sender: "alice@example.org", reason: "message-too-large" },
    ]);
    expect(bobKeyring.opened).toHaveLength(0);
  });

  it("rejects an unprotected envelope outright — a PGP-enabled document never falls back to accepting plain messages", async () => {
    bind();
    receiver.seed("doc-1", [plainFromAlice(EDIT, "m1")]);
    const sync = createSyncState(receiver, bindStorePath, bobKeyring);
    await sync.pollOnce("doc-1");
    expect(sync.getDeliveries("doc-1")).toHaveLength(0);
    expect(sync.getRejections("doc-1")).toEqual([
      { messageId: "m1", sender: "alice@example.org", reason: "pgp-unsigned" },
    ]);
    expect(bobKeyring.opened).toHaveLength(0); // never even handed to gpg
  });

  /**
   * The downgrade a PGP-enabled document must refuse: a message that is
   * genuinely signed by the right key but *not encrypted*. The signature
   * being good is exactly why it must not matter — a document that
   * promises confidentiality cannot accept content that was sent in clear.
   */
  it("rejects a signed-but-not-encrypted message, however good its signature", async () => {
    bind();
    receiver.seed("doc-1", [
      mail({
        messageId: "m1",
        from: "alice@example.org",
        to: ["bob@example.org"],
        text: fakeClearsign(JSON.stringify(EDIT), FP_ALICE),
      }),
    ]);
    const sync = createSyncState(receiver, bindStorePath, bobKeyring);
    await sync.pollOnce("doc-1");
    expect(sync.getDeliveries("doc-1")).toHaveLength(0);
    expect(sync.getRejections("doc-1")[0]?.reason).toBe("pgp-unencrypted");
    expect(bobKeyring.opened).toHaveLength(0);
  });

  it("rejects an encrypted message that was never signed", async () => {
    bind();
    receiver.seed("doc-1", [
      mail({
        messageId: "m1",
        from: "alice@example.org",
        to: ["bob@example.org"],
        text: fakeEncrypt({ payload: JSON.stringify(EDIT), recipients: [FP_BOB] }),
      }),
    ]);
    const sync = createSyncState(receiver, bindStorePath, bobKeyring);
    await sync.pollOnce("doc-1");
    expect(sync.getDeliveries("doc-1")).toHaveLength(0);
    expect(sync.getRejections("doc-1")[0]?.reason).toBe("pgp-unsigned");
  });

  it("rejects an encrypted message addressed only to someone else as undecipherable, and applies nothing", async () => {
    bind();
    const toCarol = senderKeyring("alice@example.org", FP_ALICE);
    toCarol.seedKey("carol@example.org", fakeKey("E", "carol@example.org"));
    receiver.seed("doc-1", [
      mail({
        messageId: "m1",
        from: "alice@example.org",
        to: ["bob@example.org"],
        text: await toCarol.signAndEncrypt(JSON.stringify(EDIT), "alice@example.org", [FP_CAROL]),
      }),
    ]);
    const sync = createSyncState(receiver, bindStorePath, bobKeyring);
    await sync.pollOnce("doc-1");
    expect(sync.getDeliveries("doc-1")).toHaveLength(0);
    expect(sync.getRejections("doc-1")[0]?.reason).toBe("pgp-undecipherable");
  });

  it("rejects an armored message that is corrupted beyond reading as undecipherable, without throwing", async () => {
    bind();
    receiver.seed("doc-1", [
      mail({
        messageId: "m1",
        from: "alice@example.org",
        to: ["bob@example.org"],
        text: "-----BEGIN PGP MESSAGE-----\n\nthis is not a message\n-----END PGP MESSAGE-----\n",
      }),
    ]);
    const sync = createSyncState(receiver, bindStorePath, bobKeyring);
    await sync.pollOnce("doc-1");
    expect(sync.getDeliveries("doc-1")).toHaveLength(0);
    expect(sync.getRejections("doc-1")[0]?.reason).toBe("pgp-undecipherable");
  });

  it("rejects a body altered after it was signed", async () => {
    bind();
    const genuine = await fromAlice(aliceSigns, EDIT, "m1");
    receiver.seed("doc-1", [{ ...genuine, text: tamperWithFakeMessage(genuine.text) }]);
    const sync = createSyncState(receiver, bindStorePath, bobKeyring);
    await sync.pollOnce("doc-1");
    expect(sync.getDeliveries("doc-1")).toHaveLength(0);
    expect(sync.getRejections("doc-1")[0]?.reason).toBe("pgp-signature-invalid");
  });

  it("rejects a signature by a key the document's keyring does not hold", async () => {
    bind();
    receiver.seed("doc-1", [
      await fromAlice(senderKeyring("alice@example.org", "F".repeat(40)), EDIT, "m1"),
    ]);
    const sync = createSyncState(receiver, bindStorePath, bobKeyring);
    await sync.pollOnce("doc-1");
    expect(sync.getDeliveries("doc-1")).toHaveLength(0);
    expect(sync.getRejections("doc-1")[0]?.reason).toBe("pgp-signature-invalid");
  });

  /**
   * The scenario the identity check exists for: Mallory's key is legitimately
   * in *Bob's own keyring*, the headers (alice→bob) satisfy the closed-set
   * check, she can encrypt to Bob like anyone, and her signature is genuine.
   * It never gets far — the document's keyring holds only the keys the
   * creator's invitation pinned, so a key that is merely in the user's own
   * keyring is not a key the document knows. (Someone who *is* a participant
   * forging another's `From:` is the next test.)
   */
  it("rejects Mallory's genuinely signed, properly encrypted message that forges Alice's From: — her key is in Bob's own keyring, but not in the document's", async () => {
    bind();
    receiver.seed("doc-1", [await fromAlice(malloryPretendsToBeAlice, EDIT, "m1")]);
    const sync = createSyncState(receiver, bindStorePath, bobKeyring);
    await sync.pollOnce("doc-1");
    expect(bobKeyring.opened).toHaveLength(1); // it decrypted; only the signature could not be checked
    expect(sync.getDeliveries("doc-1")).toHaveLength(0);
    expect(sync.getRejections("doc-1")).toEqual([
      { messageId: "m1", sender: "alice@example.org", reason: "pgp-signature-invalid" },
    ]);
  });

  /**
   * The case only the pinned fingerprint can catch, and why it stays: a
   * *participant* — whose key the document does hold — forging another
   * participant's `From:`. The signature verifies; it is just not Alice's.
   */
  it("rejects a participant's genuinely signed message that forges Alice's From: — a valid signature by the wrong pinned key", async () => {
    bind(
      { recipients: ["alice@example.org", "bob@example.org", "mallory@example.org"] },
      {
        "alice@example.org": FP_ALICE,
        "bob@example.org": FP_BOB,
        "mallory@example.org": FP_MALLORY,
      },
    );
    receiver.seed("doc-1", [
      await fromAlice(malloryPretendsToBeAlice, EDIT, "m1", {
        to: ["bob@example.org", "mallory@example.org"],
      }),
    ]);
    const sync = createSyncState(receiver, bindStorePath, bobKeyring);
    await sync.pollOnce("doc-1");
    expect(sync.getDeliveries("doc-1")).toHaveLength(0);
    expect(sync.getRejections("doc-1")).toEqual([
      { messageId: "m1", sender: "alice@example.org", reason: "pgp-identity-changed" },
    ]);
  });

  it("rejects a message signed by a rotated key the document never pinned — even one Bob's own keyring holds", async () => {
    bind();
    receiver.seed("doc-1", [await fromAlice(aliceNewKey, EDIT, "m1")]);
    const sync = createSyncState(receiver, bindStorePath, bobKeyring);
    await sync.pollOnce("doc-1");
    expect(sync.getDeliveries("doc-1")).toHaveLength(0);
    expect(sync.getRejections("doc-1")[0]?.reason).toBe("pgp-signature-invalid");
  });

  describe("every message kind is held to the same rule, not just edits", () => {
    // A membership change, a close and a resync request are frames inside the
    // one envelope kind's opaque payload, so they are guarded exactly like an
    // edit; the table is kept (rather than collapsed into the it()s below) so
    // a further kind needs no restructuring.
    const protocolEnvelopes = [
      {
        name: "edit",
        envelope: { tdsp: 1, kind: "frame", documentId: "doc-1", frame: "AQID" },
        surfaced: (sync: ReturnType<typeof createSyncState>) => sync.getDeliveries("doc-1").length,
      },
    ];

    it.each(protocolEnvelopes)(
      "surfaces nothing from an unprotected $name",
      async ({ envelope, surfaced }) => {
        bind();
        receiver.seed("doc-1", [plainFromAlice(envelope, "m1")]);
        const sync = createSyncState(receiver, bindStorePath, bobKeyring);
        await sync.pollOnce("doc-1");
        expect(surfaced(sync)).toBe(0);
        expect(sync.getRejections("doc-1")[0]?.reason).toBe("pgp-unsigned");
      },
    );

    it.each(protocolEnvelopes)(
      "surfaces nothing from a $name Mallory signed while forging Alice's From:",
      async ({ envelope, surfaced }) => {
        bind();
        receiver.seed("doc-1", [await fromAlice(malloryPretendsToBeAlice, envelope, "m1")]);
        const sync = createSyncState(receiver, bindStorePath, bobKeyring);
        await sync.pollOnce("doc-1");
        expect(surfaced(sync)).toBe(0);
        expect(sync.getRejections("doc-1")[0]?.reason).toBe("pgp-signature-invalid");
      },
    );

    it.each(protocolEnvelopes)(
      "surfaces a properly signed and encrypted $name from the creator",
      async ({ envelope, surfaced }) => {
        bind();
        receiver.seed("doc-1", [await fromAlice(aliceSigns, envelope, "m1")]);
        const sync = createSyncState(receiver, bindStorePath, bobKeyring);
        await sync.pollOnce("doc-1");
        expect(surfaced(sync)).toBe(1);
        expect(sync.getRejections("doc-1")).toEqual([]);
      },
    );

    it("ignores the control envelope kinds of earlier builds, even properly signed by the creator: they are no longer this bridge's business", async () => {
      bind();
      receiver.seed("doc-1", [
        await fromAlice(aliceSigns, { tdsp: 1, kind: "archived", documentId: "doc-1" }, "m1"),
      ]);
      const sync = createSyncState(receiver, bindStorePath, bobKeyring);
      await sync.pollOnce("doc-1");
      expect(sync.getDeliveries("doc-1")).toHaveLength(0);
      expect(sync.getRejections("doc-1")).toEqual([]);
    });
  });

  /**
   * The in-memory rejection list is what the user sees; the log is what
   * survives a restart and what an operator greps. Every rejection is logged
   * exactly once, with the reason, and an accepted message logs nothing.
   */
  describe("logging", () => {
    function withLogger() {
      const records: LogRecord[] = [];
      const logger = createLogger({
        component: "email-bridge",
        sink: (_line, record) => records.push(record),
      });
      return { records, logger };
    }

    it("logs a rejection once, with its reason, sender and ids — never the message body", async () => {
      bind();
      receiver.seed("doc-1", [plainFromAlice(EDIT, "m1")]);
      const { records, logger } = withLogger();
      const sync = createSyncState(receiver, bindStorePath, bobKeyring, logger);
      await sync.pollOnce("doc-1");
      await sync.pollOnce("doc-1"); // the same mailbox again: the message must not be logged twice
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        level: "warn",
        component: "email-bridge",
        event: "message-rejected",
        fields: {
          reason: "pgp-unsigned",
          documentId: "doc-1",
          messageId: "m1",
          sender: "alice@example.org",
        },
      });
      expect(JSON.stringify(records[0])).not.toContain("AQID");
    });

    it("logs the impersonation attempt with the forged address as the sender", async () => {
      bind();
      receiver.seed("doc-1", [await fromAlice(malloryPretendsToBeAlice, EDIT, "m1")]);
      const { records, logger } = withLogger();
      await createSyncState(receiver, bindStorePath, bobKeyring, logger).pollOnce("doc-1");
      expect(records.map((r) => [r.event, r.fields.reason, r.fields.sender])).toEqual([
        ["message-rejected", "pgp-signature-invalid", "alice@example.org"],
      ]);
    });

    it("logs nothing for an accepted message", async () => {
      bind();
      receiver.seed("doc-1", [await fromAlice(aliceSigns, EDIT, "m1")]);
      const { records, logger } = withLogger();
      await createSyncState(receiver, bindStorePath, bobKeyring, logger).pollOnce("doc-1");
      expect(records).toEqual([]);
    });
  });

  describe("pinning", () => {
    /** nobody is pinned by whatever message arrives first — the pins come from the creator's invitation, all at once, or a sender has none. */
    it("never pins a sender from a message: someone without a pin is refused, and the record is left exactly as it was", async () => {
      bind({}, { "bob@example.org": FP_BOB }); // Alice was never pinned: a damaged record …
      bobKeyring
        .withKeyring(keyringPathFor(bindStorePath, "doc-1"))
        .seedKey("alice@example.org", { fingerprint: FP_ALICE, userIds: ["alice@example.org"] }); // … though her key is in the keyring
      receiver.seed("doc-1", [await fromAlice(aliceSigns, EDIT, "m1")]);
      const sync = createSyncState(receiver, bindStorePath, bobKeyring);
      await sync.pollOnce("doc-1");
      expect(sync.getDeliveries("doc-1")).toHaveLength(0);
      expect(sync.getRejections("doc-1")[0]?.reason).toBe("pgp-unavailable");
      expect(getBindRecord(bindStorePath, "doc-1")?.pinnedFingerprints).toEqual({
        "bob@example.org": FP_BOB,
      });
    });

    it("compares by normalized address, so a differently-cased From: still meets its pin", async () => {
      bind();
      receiver.seed("doc-1", [
        await fromAlice(aliceSigns, EDIT, "m1", { from: "Alice@Example.org" }),
      ]);
      const sync = createSyncState(receiver, bindStorePath, bobKeyring);
      await sync.pollOnce("doc-1");
      expect(sync.getDeliveries("doc-1")).toHaveLength(1);
    });

    it("does not let one member's pin excuse another's — a key pinned for Mallory, used to speak as Alice, is rejected", async () => {
      bind(
        { recipients: ["alice@example.org", "bob@example.org", "mallory@example.org"] },
        {
          "alice@example.org": FP_ALICE,
          "bob@example.org": FP_BOB,
          "mallory@example.org": FP_MALLORY,
        },
      );
      receiver.seed("doc-1", [
        await fromAlice(malloryPretendsToBeAlice, EDIT, "m1", {
          to: ["bob@example.org", "mallory@example.org"],
        }),
      ]);
      const sync = createSyncState(receiver, bindStorePath, bobKeyring);
      await sync.pollOnce("doc-1");
      expect(sync.getDeliveries("doc-1")).toHaveLength(0);
      expect(sync.getRejections("doc-1")[0]?.reason).toBe("pgp-identity-changed");
    });

    it("verifies against the document's keyring alone: a key Bob's own keyring holds for Alice is never consulted", async () => {
      // Bob's own keyring believes Alice is the *rotated* key; the document pinned the original.
      bobKeyring.seedKey("alice@example.org", {
        fingerprint: FP_ALICE_NEW,
        userIds: ["alice@example.org"],
      });
      bind();
      receiver.seed("doc-1", [
        await fromAlice(aliceSigns, EDIT, "m1"),
        await fromAlice(aliceNewKey, EDIT, "m2"),
      ]);
      const sync = createSyncState(receiver, bindStorePath, bobKeyring);
      await sync.pollOnce("doc-1");
      expect(sync.getDeliveries("doc-1").map((d) => d.id)).toEqual(["m1"]);
      expect(sync.getRejections("doc-1").map((r) => [r.messageId, r.reason])).toEqual([
        ["m2", "pgp-signature-invalid"],
      ]);
    });
  });

  describe("configuration mismatches are refused, never guessed around", () => {
    it("refuses an encrypted message when this bridge has no gpg at all — nothing can be opened, so nothing is trusted", async () => {
      bind();
      receiver.seed("doc-1", [await fromAlice(aliceSigns, EDIT, "m1")]);
      const sync = createSyncState(receiver, bindStorePath, undefined);
      await sync.pollOnce("doc-1");
      expect(sync.getDeliveries("doc-1")).toHaveLength(0);
      expect(sync.getRejections("doc-1")[0]?.reason).toBe("pgp-unavailable");
    });

    it("refuses an encrypted message for a PGP document that has no keyring of its own, rather than verifying it against anything else", async () => {
      bind({ keyringPath: undefined, ownFingerprint: undefined });
      receiver.seed("doc-1", [await fromAlice(aliceSigns, EDIT, "m1")]);
      const sync = createSyncState(receiver, bindStorePath, bobKeyring);
      await sync.pollOnce("doc-1");
      expect(sync.getDeliveries("doc-1")).toHaveLength(0);
      expect(sync.getRejections("doc-1")[0]?.reason).toBe("pgp-unavailable");
      expect(bobKeyring.opened).toHaveLength(0);
    });

    it.each([
      ["encrypted", async () => (await fromAlice(aliceSigns, EDIT, "m1")).text],
      ["signed-only", async () => fakeClearsign(JSON.stringify(EDIT), FP_ALICE)],
    ])(
      "refuses a %s message for a document this bridge has PGP switched off for",
      async (_name, text) => {
        bind({ pgpEnabled: false, pinnedFingerprints: {} });
        receiver.seed("doc-1", [
          mail({
            messageId: "m1",
            from: "alice@example.org",
            to: ["bob@example.org"],
            text: await text(),
          }),
        ]);
        const sync = createSyncState(receiver, bindStorePath, bobKeyring);
        await sync.pollOnce("doc-1");
        expect(sync.getDeliveries("doc-1")).toHaveLength(0);
        expect(sync.getRejections("doc-1")[0]?.reason).toBe("pgp-disabled-locally");
        expect(bobKeyring.opened).toHaveLength(0); // never even handed to gpg
      },
    );

    it("ignores the plain human-readable invite in a PGP-enabled thread without recording a rejection", async () => {
      bind();
      receiver.seed("doc-1", [
        mail({
          messageId: "m1",
          from: "alice@example.org",
          to: ["bob@example.org"],
          text: "You've been invited to collaborate.",
        }),
      ]);
      const sync = createSyncState(receiver, bindStorePath, bobKeyring);
      await sync.pollOnce("doc-1");
      expect(sync.getDeliveries("doc-1")).toHaveLength(0);
      expect(sync.getRejections("doc-1")).toEqual([]);
    });

    it("ignores a properly protected envelope naming a different document, so a message can't be replayed into another document's thread", async () => {
      bind();
      receiver.seed("doc-1", [
        await fromAlice(aliceSigns, { ...EDIT, documentId: "doc-other" }, "m1"),
      ]);
      const sync = createSyncState(receiver, bindStorePath, bobKeyring);
      await sync.pollOnce("doc-1");
      expect(sync.getDeliveries("doc-1")).toHaveLength(0);
    });

    it("still applies the transport-level header check first, before gpg is even asked", async () => {
      bind();
      receiver.seed("doc-1", [
        await fromAlice(aliceSigns, EDIT, "m1", {
          to: ["bob@example.org", "mallory@example.org"],
        }),
      ]);
      const sync = createSyncState(receiver, bindStorePath, bobKeyring);
      await sync.pollOnce("doc-1");
      expect(bobKeyring.opened).toHaveLength(0);
      expect(sync.getRejections("doc-1")[0]?.reason).toBe("recipient-list-mismatch");
    });
  });

  // An old, genuinely signed membership change resent under a new Message-ID
  // cannot re-apply its stale permission: membership changes are control frames,
  // numbered by the creator, and `document-protocol` rejects one that is not newer
  // for its target ("closes the replay gap" in
  // `packages/document-protocol/src/index.test.ts`). This bridge holds no
  // permission state, so there is nothing here to replay against.

  /**
   * Decryption and verification spawn a subprocess, so two overlapping
   * polls (the deliveries route and the integrity-log route each poll)
   * could otherwise both see a message, have the first still
   * mid-decryption, and let the second return a result that doesn't
   * contain it yet.
   */
  it("serializes overlapping polls, so the second never returns before the first finished opening", async () => {
    bind();
    receiver.seed("doc-1", [
      await fromAlice(
        aliceSigns,
        { tdsp: 1, kind: "frame", documentId: "doc-1", frame: "AQID" },
        "m1",
      ),
    ]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    /** `view`, but with every decryption held until `gate` opens. */
    const slowed = (view: GpgInvoker): GpgInvoker => ({
      listKeys: (address) => view.listKeys(address),
      listAllKeys: () => view.listAllKeys(),
      listSecretKeys: (selector) => view.listSecretKeys(selector),
      hasSecretKey: (selector) => view.hasSecretKey(selector),
      exportKeys: (fingerprints) => view.exportKeys(fingerprints),
      importKeys: (armored) => view.importKeys(armored),
      signAndEncrypt: (payload, signer, recipients) =>
        view.signAndEncrypt(payload, signer, recipients),
      decryptUnverified: (armored) => view.decryptUnverified(armored),
      async decryptAndVerify(text) {
        await gate;
        return view.decryptAndVerify(text);
      },
      withKeyring: (path) => slowed(view.withKeyring(path)),
    });
    const slowGpg = slowed(bobKeyring);
    const sync = createSyncState(receiver, bindStorePath, slowGpg);

    const first = sync.pollOnce("doc-1");
    const second = sync.pollOnce("doc-1").then(() => sync.getDeliveries("doc-1").length);
    release();
    await first;
    expect(await second).toBe(1);
  });
});
