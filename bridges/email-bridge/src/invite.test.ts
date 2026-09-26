import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  composeInviteBody,
  encodeInvite,
  extractArmoredMessage,
  type InvitePayload,
} from "./envelope.ts";
import { FakeGpgInvoker, fakeEncrypt, fakeKey, fakeKeyBlock } from "./fake-gpg.ts";
import {
  type AcceptInviteResult,
  acceptInvite,
  createInvite,
  type InviteRejectionReason,
  verifyKeySet,
} from "./invite.ts";
import type { IncomingMail, MailReceiver } from "./mail-transport.ts";

/**
 * L0 — the creator's invitation and a participant's acceptance of it
 * (SPECIFICATION.md EML-4), with `FakeGpgInvoker` standing in for `gpg`. The
 * real thing — real keys, real armor, a real mailbox — is exercised by
 * `keyring-gpg.test.ts` (the keyring mechanics) and `pgp-live.test.ts` (the
 * whole flow through Greenmail); what only this level can do is hand a
 * participant every *malformed or hostile* invitation a forger could produce
 * and check that each is refused for the right reason and leaves nothing
 * behind.
 *
 * Three people. Alice is the creator; Bob is the participant whose bridge
 * accepts; Carol is a second participant, and a possible forger.
 */
const ALICE = "alice@example.org";
const BOB = "bob@example.org";
const CAROL = "carol@example.org";
const KEY_A = "A".repeat(40);
const KEY_B = "B".repeat(40);
const KEY_C = "C".repeat(40);
const ROOT = "<root@example.org>";

class FakeMailReceiver implements MailReceiver {
  readonly tls = "plaintext-loopback" as const;
  verifyFailure: Error | undefined;

  async verify(): Promise<void> {
    if (this.verifyFailure) {
      throw this.verifyFailure;
    }
  }

  messages: IncomingMail[] = [];
  async fetchThreadMessages(): Promise<readonly IncomingMail[]> {
    return this.messages;
  }
}

describe("createInvite / acceptInvite (SPECIFICATION.md EML-4)", () => {
  let tempDir: string;
  let creatorStore: string;
  let joinerStore: string;
  let alice: FakeGpgInvoker;
  let bob: FakeGpgInvoker;
  let carol: FakeGpgInvoker;
  let receiver: FakeMailReceiver;

  /** A person's bridge: their own secret key and public key, and whichever other public keys their keyring holds. */
  function person(address: string, fingerprint: string, letter: string, knows: string[] = []) {
    const keyring = new FakeGpgInvoker();
    keyring.seedSecretKey(address, fingerprint);
    keyring.seedKey(address, fakeKey(letter, address));
    for (const other of knows) {
      const [otherAddress, otherLetter] = other.split(":") as [string, string];
      keyring.seedKey(otherAddress, fakeKey(otherLetter, otherAddress));
    }
    return keyring;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "email-bridge-invite-test-"));
    creatorStore = join(tempDir, "creator", "threads.json");
    joinerStore = join(tempDir, "joiner", "threads.json");
    // The creator holds everyone's key — that is what "strict at creation" requires.
    alice = person(ALICE, KEY_A, "A", [`${BOB}:B`, `${CAROL}:C`]);
    bob = person(BOB, KEY_B, "B");
    carol = person(CAROL, KEY_C, "C", [`${BOB}:B`]);
    receiver = new FakeMailReceiver();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const PARTICIPANTS = [ALICE, BOB, CAROL];

  async function realInvite(): Promise<string> {
    const result = await createInvite({
      documentId: "doc-1",
      ownAddress: ALICE,
      recipients: PARTICIPANTS,
      profile: "yjs-paragraphs/1",
      gpg: alice,
      bindStorePath: creatorStore,
    });
    if (!result.ok) {
      throw new Error(result.error);
    }
    return result.armored;
  }

  /** A valid payload; a test overrides exactly the field it makes hostile. */
  function payload(overrides: Partial<InvitePayload> = {}): InvitePayload {
    return {
      tdsp: 1,
      kind: "invite",
      documentId: "doc-1",
      creator: ALICE,
      profile: "yjs-paragraphs/1",
      participants: [
        { address: ALICE, fingerprint: KEY_A },
        { address: BOB, fingerprint: KEY_B },
        { address: CAROL, fingerprint: KEY_C },
      ],
      keys: fakeKeyBlock([fakeKey("A", ALICE), fakeKey("B", BOB), fakeKey("C", CAROL)]),
      ...overrides,
    };
  }

  /** `who` signs and encrypts to Bob whatever text it likes — the forger's whole toolbox. */
  const sealedBy = (who: FakeGpgInvoker, address: string, text: string) =>
    who.signAndEncrypt(text, address, [KEY_B]);

  function seedInvite(
    armored: string,
    mail: Partial<IncomingMail> & { human?: string } = {},
  ): void {
    receiver.messages = [
      {
        messageId: ROOT,
        from: ALICE,
        to: [BOB, CAROL],
        cc: [],
        text: mail.text ?? composeInviteBody(mail.human ?? "Join: http://localhost/?x", armored),
        ...(mail.messageId === undefined ? {} : { messageId: mail.messageId }),
        ...(mail.from === undefined ? {} : { from: mail.from }),
        ...(mail.to === undefined ? {} : { to: mail.to }),
      },
    ];
  }

  function accept(
    options: {
      gpg?: FakeGpgInvoker;
      expected?: Partial<{ creator: string; recipients: string[] }>;
    } = {},
  ): Promise<AcceptInviteResult> {
    return acceptInvite({
      documentId: "doc-1",
      threadRootMessageId: ROOT,
      ownAddress: BOB,
      expected: {
        creator: ALICE,
        recipients: PARTICIPANTS,
        profile: "yjs-paragraphs/1",
        ...options.expected,
      },
      gpg: options.gpg ?? bob,
      receiver,
      bindStorePath: joinerStore,
    });
  }

  const keyringFiles = (): string[] => {
    const dir = join(tempDir, "joiner", "keyrings");
    return existsSync(dir) ? readdirSync(dir) : [];
  };

  async function expectRejected(
    reason: InviteRejectionReason,
    options?: Parameters<typeof accept>[0],
  ): Promise<void> {
    const result = await accept(options);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe(reason);
    // A refused invitation leaves nothing behind: no half-built keyring, pending or final.
    expect(keyringFiles()).toEqual([]);
  }

  describe("a genuine invitation", () => {
    it("is accepted, yielding a pin for every participant, the joiner's own fingerprint, and a keyring of the document's own", async () => {
      seedInvite(await realInvite());
      const result = await accept();
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.accepted).toMatchObject({
        creator: ALICE,
        recipients: PARTICIPANTS,
        profile: "yjs-paragraphs/1",
        pinnedFingerprints: { [ALICE]: KEY_A, [BOB]: KEY_B, [CAROL]: KEY_C },
        ownFingerprint: KEY_B,
      });
      const ring = bob.withKeyring(result.accepted.keyringPath);
      expect((await ring.listAllKeys()).map((key) => key.fingerprint).sort()).toEqual([
        KEY_A,
        KEY_B,
        KEY_C,
      ]);
      expect(keyringFiles()).toHaveLength(1); // the two pending keyrings were cleaned up
    });

    it("never writes to the joiner's own keyring: Alice and Carol are learnt, not imported", async () => {
      seedInvite(await realInvite());
      await accept();
      expect(await bob.listKeys(ALICE)).toEqual([]);
      expect(await bob.listKeys(CAROL)).toEqual([]);
    });

    it("takes the identities from what the creator signed, ignoring what the joiner's own keyring believes", async () => {
      seedInvite(await realInvite());
      bob.seedKey(ALICE, fakeKey("D", ALICE)); // Bob's own keyring holds a different key for Alice
      const result = await accept();
      expect(result.ok && result.accepted.pinnedFingerprints[ALICE]).toBe(KEY_A);
    });

    it("compares the participants case-insensitively, as addresses are everywhere in this bridge", async () => {
      seedInvite(await realInvite(), { from: "Alice@Example.org", to: ["BOB@example.org", CAROL] });
      const result = await accept({ expected: { creator: "ALICE@example.org" } });
      expect(result.ok).toBe(true);
    });
  });

  describe("the creator's send policy inside the signed block", () => {
    const POLICY = "30000,120000,0,inf,60000@0";

    async function inviteWithPolicy(policy: string | undefined): Promise<string> {
      const result = await createInvite({
        documentId: "doc-1",
        ownAddress: ALICE,
        recipients: PARTICIPANTS,
        profile: "yjs-paragraphs/1",
        gpg: alice,
        bindStorePath: creatorStore,
        ...(policy === undefined ? {} : { policy }),
      });
      if (!result.ok) {
        throw new Error(result.error);
      }
      return result.armored;
    }

    it("is carried to the participant, who takes it from what the creator signed", async () => {
      seedInvite(await inviteWithPolicy(POLICY));
      const result = await accept();
      expect(result.ok && result.accepted.policy).toBe(POLICY);
    });

    it("is simply absent when the creator sent none", async () => {
      seedInvite(await inviteWithPolicy(undefined));
      const result = await accept();
      expect(result.ok && result.accepted.policy).toBeUndefined();
    });

    it("cannot be replaced by someone who is not the creator: a forged invitation carrying another policy is refused", async () => {
      seedInvite(
        await sealedBy(carol, CAROL, encodeInvite(payload({ policy: "0,inf,0,inf,0@0" }))),
      );
      await expectRejected("invite-signer-not-creator");
    });

    it.each(["<script>", "30000, 120000", "x".repeat(201), ""])(
      "refuses an invitation whose policy text is %j, as it does any malformed field read before the signature can be checked",
      async (policy) => {
        seedInvite(await sealedBy(alice, ALICE, encodeInvite(payload({ policy }))));
        await expectRejected("invite-malformed");
      },
    );
  });

  describe("an invitation that cannot be found", () => {
    it("is reported as retryable, not as an integrity problem", async () => {
      const result = await accept();
      expect(result).toMatchObject({ ok: false, reason: "invite-not-found" });
    });

    it("is refused when two messages claim the same Message-ID, rather than guessing which is real", async () => {
      const armored = await realInvite();
      seedInvite(armored);
      receiver.messages = [...receiver.messages, ...receiver.messages];
      await expectRejected("invite-malformed");
    });
  });

  describe("an invitation larger than the bridge reads (BRG-13)", () => {
    it("is refused unopened: never handed to gpg", async () => {
      seedInvite("", { text: "" });
      receiver.messages = receiver.messages.map((message) => ({ ...message, tooLarge: true }));
      await expectRejected("invite-malformed");
      expect(bob.opened).toHaveLength(0);
    });
  });

  describe("the mail around the signed block", () => {
    it("refuses an invitation not sent by the creator the link names", async () => {
      seedInvite(await realInvite(), { from: CAROL, to: [ALICE, BOB] });
      await expectRejected("invite-not-from-creator");
    });

    it("refuses one whose To/Cc don't reconstitute the participants the link names — someone was added, or dropped", async () => {
      seedInvite(await realInvite(), { to: [BOB, CAROL, "mallory@example.org"] });
      await expectRejected("recipient-list-mismatch");
      seedInvite(await realInvite(), { to: [BOB] });
      await expectRejected("recipient-list-mismatch");
    });

    it("refuses a plain invitation to a PGP-enabled document — a downgrade — even though the link is complete", async () => {
      seedInvite("", { text: "Join us: http://localhost/?documentId=doc-1&pgp=1" });
      await expectRejected("invite-not-encrypted");
    });

    it("refuses one carrying several PGP blocks, since it would be ambiguous which was signed", async () => {
      const armored = await realInvite();
      seedInvite("", { text: `${armored}\n\n${armored}` });
      await expectRejected("invite-malformed");
    });

    it("does not trust the readable text: a different link there changes nothing about what is accepted", async () => {
      seedInvite(await realInvite(), { human: "Join: http://evil.example/?creator=mallory" });
      const result = await accept();
      expect(result.ok && result.accepted.creator).toBe(ALICE);
    });
  });

  describe("an invitation not encrypted to the joiner — the creator holds a different key for them", () => {
    it("is refused with a reason that says so", async () => {
      seedInvite(await realInvite());
      // Bob's real key is F, not the B that Alice encrypted to.
      const other = new FakeGpgInvoker();
      other.seedSecretKey(BOB, "F".repeat(40));
      other.seedKey(BOB, { fingerprint: "F".repeat(40), userIds: [BOB] });
      await expectRejected("invite-undecipherable", { gpg: other });
    });

    it("is refused when the joiner has no secret key for their address at all", async () => {
      seedInvite(await realInvite());
      await expectRejected("invite-undecipherable", { gpg: new FakeGpgInvoker() });
    });

    it("is refused when it lists a key for the joiner whose secret key they do not hold, though it was encrypted to one they do", async () => {
      // Encrypted to B (which Bob holds) but listing another key for Bob's address.
      seedInvite(
        await sealedBy(
          alice,
          ALICE,
          encodeInvite(
            payload({
              participants: [
                { address: ALICE, fingerprint: KEY_A },
                { address: BOB, fingerprint: "D".repeat(40) },
                { address: CAROL, fingerprint: KEY_C },
              ],
              keys: fakeKeyBlock([fakeKey("A", ALICE), fakeKey("D", BOB), fakeKey("C", CAROL)]),
            }),
          ),
        ),
      );
      await expectRejected("invite-undecipherable");
    });
  });

  describe("what the creator signed", () => {
    it.each([
      ["is not JSON", "this is not an invitation"],
      [
        "is another kind of message",
        JSON.stringify({ tdsp: 1, kind: "frame", documentId: "doc-1", frame: "AQID" }),
      ],
      ["names another document", encodeInvite(payload({ documentId: "doc-other" }))],
      ["has no participants", JSON.stringify({ ...payload(), participants: [] })],
      [
        "has a participant with a malformed fingerprint",
        JSON.stringify({ ...payload(), participants: [{ address: ALICE, fingerprint: "xyz" }] }),
      ],
      [
        "has a participant whose address is not a single address",
        JSON.stringify({
          ...payload(),
          participants: [{ address: "a@b.org, c@d.org", fingerprint: KEY_A }],
        }),
      ],
    ])("is refused as malformed when it %s", async (_name, text) => {
      seedInvite(await sealedBy(alice, ALICE, text));
      await expectRejected("invite-malformed");
    });

    it.each([
      ["names a different creator than the link", payload({ creator: CAROL })],
      ["has a different schema version than the link", payload({ profile: "yjs-paragraphs/2" })],
      [
        "adds a participant the link does not name",
        payload({
          participants: [
            ...payload().participants,
            { address: "mallory@example.org", fingerprint: "F".repeat(40) },
          ],
        }),
      ],
      [
        "drops a participant the link names",
        payload({ participants: payload().participants.slice(0, 2) }),
      ],
      [
        "swaps one participant for someone the link does not name, keeping the count",
        payload({
          participants: [
            payload().participants[0] as { address: string; fingerprint: string },
            payload().participants[1] as { address: string; fingerprint: string },
            { address: "mallory@example.org", fingerprint: "F".repeat(40) },
          ],
          keys: fakeKeyBlock([
            fakeKey("A", ALICE),
            fakeKey("B", BOB),
            fakeKey("F", "mallory@example.org"),
          ]),
        }),
      ],
      [
        "lists one participant twice",
        payload({
          participants: [
            payload().participants[0] as { address: string; fingerprint: string },
            payload().participants[1] as { address: string; fingerprint: string },
            payload().participants[1] as { address: string; fingerprint: string },
          ],
        }),
      ],
    ])("is refused when it %s", async (_name, hostile) => {
      seedInvite(await sealedBy(alice, ALICE, encodeInvite(hostile)));
      await expectRejected("invite-participants-mismatch");
    });
  });

  describe("the keys it carries", () => {
    it.each([
      ["one is missing", fakeKeyBlock([fakeKey("A", ALICE), fakeKey("B", BOB)])],
      [
        "an unlisted extra key rides along",
        fakeKeyBlock([
          fakeKey("A", ALICE),
          fakeKey("B", BOB),
          fakeKey("C", CAROL),
          fakeKey("F", "mallory@example.org"),
        ]),
      ],
      [
        "a key's user id names somebody else than the address it is listed under",
        fakeKeyBlock([fakeKey("A", ALICE), fakeKey("B", CAROL), fakeKey("C", CAROL)]),
      ],
      ["the block is not a key at all", "these are not keys"],
    ])("are refused when %s", async (_name, keys) => {
      seedInvite(await sealedBy(alice, ALICE, encodeInvite(payload({ keys }))));
      await expectRejected("invite-key-set-invalid");
    });

    it("are refused when one key is listed for two participants — one person would be mistaken for another", async () => {
      seedInvite(
        await sealedBy(
          alice,
          ALICE,
          encodeInvite(
            payload({
              participants: [
                { address: ALICE, fingerprint: KEY_A },
                { address: BOB, fingerprint: KEY_B },
                { address: CAROL, fingerprint: KEY_B },
              ],
            }),
          ),
        ),
      );
      await expectRejected("invite-key-set-invalid");
    });

    it("are refused when a user id gives a second person the same address, making a lookup ambiguous", async () => {
      seedInvite(
        await sealedBy(
          alice,
          ALICE,
          encodeInvite(
            payload({
              keys: fakeKeyBlock([
                fakeKey("A", ALICE),
                fakeKey("B", BOB),
                fakeKey("C", CAROL),
                { fingerprint: KEY_C, userIds: [BOB] },
              ]),
            }),
          ),
        ),
      );
      await expectRejected("invite-key-set-invalid");
    });
  });

  describe("the signature", () => {
    it("is required: an encrypted but unsigned invitation is refused", async () => {
      seedInvite(fakeEncrypt({ payload: encodeInvite(payload()), recipients: [KEY_B] }));
      await expectRejected("invite-unsigned");
    });

    it("must check out against the keys carried: a signer the invitation does not list is refused", async () => {
      const mallory = person("mallory@example.org", "F".repeat(40), "F");
      mallory.seedKey(BOB, fakeKey("B", BOB));
      seedInvite(await sealedBy(mallory, "mallory@example.org", encodeInvite(payload())));
      await expectRejected("invite-signature-invalid");
    });

    it("must be the creator's: a valid signature by another participant, forging the creator, is refused", async () => {
      // Carol is genuinely one of the participants, and her signature is genuine — it is just not Alice's.
      seedInvite(await sealedBy(carol, CAROL, encodeInvite(payload())));
      await expectRejected("invite-signer-not-creator");
    });

    it("cannot be forged by re-signing the same content: the creator's own key is what the listing names", async () => {
      // Mallory (outside the set) builds a *self-consistent* invitation naming herself as
      // "alice" — every check but the human comparison passes, which is exactly why the
      // fingerprints are shown to the user. It is accepted here and flagged by key-report.
      const mallory = person(ALICE, "F".repeat(40), "F", [`${BOB}:B`]);
      const forged = payload({
        participants: [
          { address: ALICE, fingerprint: "F".repeat(40) },
          { address: BOB, fingerprint: KEY_B },
          { address: CAROL, fingerprint: KEY_C },
        ],
        keys: fakeKeyBlock([fakeKey("F", ALICE), fakeKey("B", BOB), fakeKey("C", CAROL)]),
      });
      seedInvite(await sealedBy(mallory, ALICE, encodeInvite(forged)));
      const result = await accept();
      expect(result.ok && result.accepted.pinnedFingerprints[ALICE]).toBe("F".repeat(40));
    });
  });

  describe("createInvite", () => {
    it("chooses her own secret key for her own entry, even when her keyring holds several public keys for her address", async () => {
      alice.seedKey(ALICE, fakeKey("D", ALICE)); // a second key for her address, no secret key for it
      const result = await createInvite({
        documentId: "doc-1",
        ownAddress: ALICE,
        recipients: PARTICIPANTS,
        profile: "yjs-paragraphs/1",
        gpg: alice,
        bindStorePath: creatorStore,
      });
      expect(result.ok && result.ownFingerprint).toBe(KEY_A);
    });

    it("produces an invitation only its recipients can open — never the creator's own keyring's other keys", async () => {
      const armored = await realInvite();
      const block = extractArmoredMessage(armored);
      expect(block).toEqual({ block: armored.trim() });
      // Encrypted to Bob and Carol, not to Alice herself.
      expect(alice.encrypted.at(-1)?.recipients).toEqual([KEY_B, KEY_C]);
    });
  });

  describe("verifyKeySet", () => {
    const listed = [
      { address: ALICE, fingerprint: KEY_A },
      { address: BOB, fingerprint: KEY_B },
    ];

    it("accepts exactly the listed keys, each under its own address", async () => {
      const ring = new FakeGpgInvoker().withKeyring(join(tempDir, "ok.kbx"));
      await ring.importKeys(fakeKeyBlock([fakeKey("A", ALICE), fakeKey("B", BOB)]));
      await expect(verifyKeySet(ring, listed)).resolves.toBeUndefined();
    });

    it("names the problem when a listed key is missing", async () => {
      const ring = new FakeGpgInvoker().withKeyring(join(tempDir, "missing.kbx"));
      await ring.importKeys(fakeKeyBlock([fakeKey("A", ALICE)]));
      await expect(verifyKeySet(ring, listed)).resolves.toContain(KEY_B);
    });
  });
});
