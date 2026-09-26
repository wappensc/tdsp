import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeKeyWarnings,
  EmailMessengerPort,
  InviteRejectedError,
} from "@tdsp/messenger-email";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// infra/email-testserver isn't a pnpm workspace package — see
// contract.test.ts's own comment on these relative imports.
import { ALICE, BOB, HOST, IMAP_PORT, SMTP_PORT } from "../../../infra/email-testserver/config.ts";
import {
  hasGpgBinary,
  type ProvisionedGpgHomes,
  provisionGpgHomesInChildProcess,
} from "../../../infra/email-testserver/gpg-homes.ts";
import { hasTestEmailServer } from "../../../infra/email-testserver/health.ts";
import { getBindRecord } from "./bind-store.ts";
import { composeInviteBody, extractArmoredMessage, pgpFormatOf } from "./envelope.ts";
import { createGpgInvoker } from "./gpg-invoke.ts";
import { createInvite } from "./invite.ts";
import { createImapReceiver, createNodemailerSender } from "./mail-transport.ts";
import { createServer } from "./server.ts";
import { createSyncState } from "./sync-state.ts";

/**
 * L2 (docs/testing.md): real `gpg`, real Greenmail, real
 * SMTP/IMAP, two real bridge instances — the live half of "a PGP-enabled
 * document's messages survive the mail transport signed and encrypted,
 * nobody but a recipient can read them, and forgeries don't get in".
 * Gated on *both* a reachable test server and a `gpg` binary.
 *
 * Exists because the fake-`gpg` unit tests can't see the two things only
 * a real run can: whether a real armored message (line endings, one very
 * long base64 line) survives SMTP → Greenmail → IMAP → `mailparser`
 * byte-for-byte enough to still decrypt and verify, whether a keyring that
 * is not a recipient really cannot read it, and whether the real `gpg`'s
 * `DECRYPTION_OKAY`/`GOODSIG`/`VALIDSIG` output feeds the pinned-fingerprint
 * comparison correctly.
 *
 * Keys are provisioned in a child process (`provisionGpgHomesInChildProcess`):
 * three key generations in one Vitest worker trip a gpg-agent quirk this
 * repo already documents (`gpg-invoke.test.ts`).
 */
const MALLORY = "mallory@example.org";
const available = (await hasTestEmailServer()) && hasGpgBinary();

describe.skipIf(!available)("PGP-enabled documents, live (Greenmail + real gpg)", () => {
  let keys: ProvisionedGpgHomes;
  /** A *different* key for Bob's own address, in a home of its own: what "the creator has another key for me than the one I hold" looks like. */
  let bobElsewhere: ProvisionedGpgHomes;
  /** A key for *Alice's* address held by somebody else entirely — an impostor's. */
  let impostor: ProvisionedGpgHomes;
  const servers: Server[] = [];
  const dirs: string[] = [];
  let counter = 0;

  beforeAll(() => {
    keys = provisionGpgHomesInChildProcess([ALICE.address, BOB.address, MALLORY]);
    bobElsewhere = provisionGpgHomesInChildProcess([BOB.address]);
    impostor = provisionGpgHomesInChildProcess([ALICE.address]);
  }, 120_000);

  afterAll(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
    );
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    keys?.cleanup();
    bobElsewhere?.cleanup();
    impostor?.cleanup();
  });

  async function bridgeFor(account: typeof ALICE, gnupgHome = keys.homes.get(account.address)) {
    const dir = mkdtempSync(join(tmpdir(), "email-bridge-pgp-live-"));
    dirs.push(dir);
    const bindStorePath = join(dir, "threads.json");
    const gpg = createGpgInvoker({ gnupgHome });
    const sender = createNodemailerSender({
      host: HOST,
      port: SMTP_PORT,
      secure: false,
      address: account.address,
      authUser: account.authUser,
      pass: account.password,
    });
    const receiver = createImapReceiver({
      host: HOST,
      port: IMAP_PORT,
      secure: false,
      authUser: account.authUser,
      pass: account.password,
    });
    const sync = createSyncState(receiver, bindStorePath, gpg);
    const server = createServer({
      address: account.address,
      sender,
      receiver,
      sync,
      gpg,
      bindStorePath,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = new EmailMessengerPort(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    );
    return { port, sync, bindStorePath, receiver, gpg };
  }

  /** A PGP-enabled document Alice created and Bob joined, both primed. */
  async function createFixture() {
    const documentId = `pgp-live-${counter++}-${Date.now()}`;
    const alice = await bridgeFor(ALICE);
    const bob = await bridgeFor(BOB);
    const recipients = [ALICE.address, BOB.address];
    const { threadRootMessageId } = await alice.port.startThread(
      documentId,
      recipients,
      ALICE.address,
      "yjs-paragraphs/1",
      undefined,
      true,
    );
    await bob.port.joinThread(
      documentId,
      threadRootMessageId,
      recipients,
      ALICE.address,
      "yjs-paragraphs/1",
      true,
    );
    await Promise.all([
      alice.port.receive(documentId, ALICE.address),
      bob.port.receive(documentId, BOB.address),
    ]);
    return { documentId, threadRootMessageId, alice, bob };
  }

  /**
   * Sends `text` into the document's real thread as if it came from
   * `From:` Alice, authenticating with Bob's real SMTP account — a
   * participant (or anyone holding one participant's mailbox) forging a
   * `From:`, which plain SMTP does nothing to prevent.
   */
  async function forgeAsAlice(
    fixture: { documentId: string; threadRootMessageId: string },
    text: string,
  ) {
    const forger = createNodemailerSender({
      host: HOST,
      port: SMTP_PORT,
      secure: false,
      address: ALICE.address,
      authUser: BOB.authUser,
      pass: BOB.password,
    });
    await forger.send({
      to: [BOB.address],
      subject: `tdsp document ${fixture.documentId}`,
      text,
      documentId: fixture.documentId,
      inReplyTo: fixture.threadRootMessageId,
      references: [fixture.threadRootMessageId],
    });
  }

  async function pollUntil(port: EmailMessengerPort, documentId: string, done: () => boolean) {
    for (let i = 0; i < 20 && !done(); i++) {
      await port.receive(documentId, BOB.address);
    }
  }

  const CASE_TIMEOUT_MS = 30_000;
  const bobFingerprint = () => keys.fingerprints.get(BOB.address) as string;

  it(
    "pins both members' real key fingerprints — from the creator's invitation — at start and at join, each in a keyring of the document's own",
    async () => {
      const { documentId, alice, bob } = await createFixture();
      const expected = {
        [ALICE.address]: keys.fingerprints.get(ALICE.address),
        [BOB.address]: keys.fingerprints.get(BOB.address),
      };
      for (const side of [alice, bob]) {
        const record = getBindRecord(side.bindStorePath, documentId);
        expect(record?.pinnedFingerprints).toEqual(expected);
        expect(record?.ownFingerprint).toMatch(/^[0-9A-F]{40}$/);
        const ring = side.gpg.withKeyring(record?.keyringPath ?? "");
        expect((await ring.listAllKeys()).map((key) => key.fingerprint).sort()).toEqual(
          Object.values(expected).sort(),
        );
      }
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "sends an invitation that is readable text with the link, then one signed and encrypted block — and nothing in it names a key in the clear",
    async () => {
      const { documentId, threadRootMessageId, bob } = await createFixture();
      const invite = (await bob.receiver.fetchThreadMessages(documentId)).find(
        (message) => message.messageId === threadRootMessageId,
      );
      expect(invite).toBeDefined();
      const text = invite?.text ?? "";
      expect(text.startsWith("You've been invited")).toBe(true); // the readable part comes first
      expect(extractArmoredMessage(text)).not.toBe("none");
      expect(extractArmoredMessage(text)).not.toBe("several");
      expect(pgpFormatOf(text)).toBe("plain"); // so the sync loop never mistakes it for a protocol message
      expect(text).not.toContain("PUBLIC KEY BLOCK"); // the keys travel inside the encrypted block
      expect(text).not.toContain(keys.fingerprints.get(ALICE.address) as string);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "delivers a real signed and encrypted edit — a 6000-byte, single-line base64 frame — byte-identical, attributed to its sender",
    async () => {
      const { documentId, alice, bob } = await createFixture();
      // A 6 000-character frame text with quotes, a backslash and non-ASCII: what PGP must carry exactly.
      const payload = 'ä"\\{x}'.repeat(1000);
      await alice.port.send(documentId, ALICE.address, payload);
      let deliveries = await bob.port.receive(documentId, BOB.address);
      for (let i = 0; i < 20 && deliveries.length === 0; i++) {
        deliveries = await bob.port.receive(documentId, BOB.address);
      }
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]?.sender).toBe(ALICE.address);
      expect(deliveries[0]?.payload).toBe(payload);
      expect(bob.sync.getRejections(documentId)).toEqual([]);

      // What Bob's mailbox really holds is a genuine OpenPGP *encrypted* message —
      // and nothing of the envelope is readable in it.
      const bodies = (await bob.receiver.fetchThreadMessages(documentId)).map((m) => m.text);
      const ciphertexts = bodies.filter((t) => pgpFormatOf(t) === "encrypted");
      expect(ciphertexts).toHaveLength(1);
      for (const body of ciphertexts) {
        expect(body).not.toContain("documentId");
        expect(body).not.toContain('"kind"');
      }
    },
    CASE_TIMEOUT_MS,
  );

  /**
   * Confidentiality, with real keys and the real mail transport: Mallory
   * holds a perfectly good key and has Bob's and Alice's public keys, but the
   * message in Bob's mailbox is encrypted to Bob alone — so a keyring that is
   * not a recipient cannot open it, even though it is handed the exact bytes
   * that crossed the wire.
   */
  it(
    "keeps a real message unreadable to a keyring that holds a key but is not a recipient",
    async () => {
      const { documentId, alice, bob } = await createFixture();
      await alice.port.send(documentId, ALICE.address, "SECRET-CONTENT");
      await pollUntil(bob.port, documentId, () => bob.sync.getDeliveries(documentId).length > 0);
      expect(bob.sync.getDeliveries(documentId)).toHaveLength(1);

      const ciphertext = (await bob.receiver.fetchThreadMessages(documentId))
        .map((m) => m.text)
        .find((t) => pgpFormatOf(t) === "encrypted");
      expect(ciphertext).toBeDefined();
      const eavesdropper = createGpgInvoker({ gnupgHome: keys.homes.get(MALLORY) });
      const result = await eavesdropper.decryptAndVerify(ciphertext ?? "");
      expect(result.decrypted).toBe(false);
      expect(result.payload).toBeUndefined();
      // ...while Bob, the recipient, opens the very same bytes.
      const bobs = await createGpgInvoker({
        gnupgHome: keys.homes.get(BOB.address),
      }).decryptAndVerify(ciphertext ?? "");
      expect(bobs.decrypted).toBe(true);
      expect(bobs.signature).toBe("valid");
    },
    CASE_TIMEOUT_MS,
  );

  /**
   * The downgrade a PGP-enabled document must refuse, with a real signature:
   * this really is Alice's message, made with her real key — signed, but not
   * encrypted. Its signature being good is exactly why it must not matter.
   */
  it(
    "rejects a message genuinely signed by Alice's own key that was sent without encryption",
    async () => {
      const fixture = await createFixture();
      const clearsigned = execFileSync(
        "gpg",
        [
          "--homedir",
          keys.homes.get(ALICE.address) as string,
          "--batch",
          "--local-user",
          `<${ALICE.address}>`,
          "--clearsign",
          "--armor",
        ],
        {
          input: JSON.stringify({
            tdsp: 1,
            kind: "frame",
            documentId: fixture.documentId,
            frame: "AQID",
          }),
          encoding: "utf8",
        },
      );
      await forgeAsAlice(fixture, clearsigned);
      await fixture.bob.port.receive(fixture.documentId, BOB.address);
      expect(fixture.bob.sync.getDeliveries(fixture.documentId)).toHaveLength(0);
      expect(fixture.bob.sync.getRejections(fixture.documentId).map((r) => r.reason)).toEqual([
        "pgp-unencrypted",
      ]);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "rejects an unsigned envelope forged as Alice",
    async () => {
      const fixture = await createFixture();
      await forgeAsAlice(
        fixture,
        JSON.stringify({ tdsp: 1, kind: "frame", documentId: fixture.documentId, frame: "AQID" }),
      );
      await fixture.bob.port.receive(fixture.documentId, BOB.address);
      expect(fixture.bob.sync.getDeliveries(fixture.documentId)).toHaveLength(0);
      expect(fixture.bob.sync.getRejections(fixture.documentId).map((r) => r.reason)).toEqual([
        "pgp-unsigned",
      ]);
    },
    CASE_TIMEOUT_MS,
  );

  /**
   * The scenario the identity check was written for, with real keys: Mallory's
   * key *is* in Bob's own keyring, her signature is genuinely valid, and the
   * headers (alice → bob) satisfy the closed-set check. The document
   * verifies against a keyring of its own, holding only the keys the
   * creator's invitation named — so what stops her is that the document has
   * never heard of her key, however well Bob's own keyring knows it.
   */
  it(
    "rejects Mallory's genuinely valid, properly encrypted message forging Alice's From: — her key is in Bob's own keyring, but the document does not hold it",
    async () => {
      const fixture = await createFixture();
      const mallory = createGpgInvoker({ gnupgHome: keys.homes.get(MALLORY) });
      await forgeAsAlice(
        fixture,
        await mallory.signAndEncrypt(
          JSON.stringify({ tdsp: 1, kind: "frame", documentId: fixture.documentId, frame: "AQID" }),
          MALLORY,
          [bobFingerprint()],
        ),
      );
      await fixture.bob.port.receive(fixture.documentId, BOB.address);
      expect(fixture.bob.sync.getDeliveries(fixture.documentId)).toHaveLength(0);
      expect(fixture.bob.sync.getRejections(fixture.documentId).map((r) => r.reason)).toEqual([
        "pgp-signature-invalid",
      ]);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "lets Mallory inject nothing, whatever the envelope claims, while Alice's own signed message still gets through",
    async () => {
      const fixture = await createFixture();
      const mallory = createGpgInvoker({ gnupgHome: keys.homes.get(MALLORY) });
      // Two forged messages, each signed by Mallory and encrypted to Bob but
      // sent under Alice's `From:`. A control frame (a membership change, a
      // close) is just an opaque payload inside a `frame` envelope, so this is exactly what forging one looks like.
      for (const frame of ["AQID", "BAUG"]) {
        await forgeAsAlice(
          fixture,
          await mallory.signAndEncrypt(
            JSON.stringify({ tdsp: 1, kind: "frame", documentId: fixture.documentId, frame }),
            MALLORY,
            [bobFingerprint()],
          ),
        );
      }
      await fixture.bob.port.receive(fixture.documentId, BOB.address);
      expect(fixture.bob.sync.getDeliveries(fixture.documentId)).toHaveLength(0);
      expect(fixture.bob.sync.getRejections(fixture.documentId).map((r) => r.reason)).toEqual([
        "pgp-signature-invalid",
        "pgp-signature-invalid",
      ]);

      await fixture.alice.port.send(fixture.documentId, ALICE.address, "AQID");
      await pollUntil(
        fixture.bob.port,
        fixture.documentId,
        () => fixture.bob.sync.getDeliveries(fixture.documentId).length === 1,
      );
      expect(fixture.bob.sync.getDeliveries(fixture.documentId)).toHaveLength(1);
    },
    CASE_TIMEOUT_MS,
  );

  /**
   * The central claim of EML-4, end to end with real keys and a real mailbox: a
   * participant who has never held anyone's key joins from the creator's
   * invitation alone, and the document then works in both directions — without
   * a single key having been written into their own keyring.
   */
  describe("a joiner who knows nobody", () => {
    const gpgIn = (home: string, args: string[], input?: string) =>
      execFileSync("gpg", ["--homedir", home, "--batch", ...args], {
        input,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });

    it(
      "joins from the invitation alone, edits flow both ways, and Bob's own keyring is never written to",
      async () => {
        const bobHome = keys.homes.get(BOB.address) as string;
        const publicKeyOf = (address: string) =>
          gpgIn(keys.homes.get(address) as string, [
            "--armor",
            "--export",
            keys.fingerprints.get(address) as string,
          ]);
        const strangers = [ALICE.address, MALLORY];
        const publicKeys = strangers.map(publicKeyOf);
        // Bob's keyring, as a stranger's: nobody's public key but his own.
        for (const other of strangers) {
          gpgIn(bobHome, ["--yes", "--delete-keys", keys.fingerprints.get(other) as string]);
        }
        try {
          const fixture = await createFixture();
          // Bob really joined, with everything he needed taken from the invitation …
          expect(getBindRecord(fixture.bob.bindStorePath, fixture.documentId)).toMatchObject({
            pgpEnabled: true,
            pinnedFingerprints: {
              [ALICE.address]: keys.fingerprints.get(ALICE.address),
              [BOB.address]: keys.fingerprints.get(BOB.address),
            },
          });
          // … Alice's edit reaches him, verified against the document's keyring …
          await fixture.alice.port.send(fixture.documentId, ALICE.address, "from alice");
          await pollUntil(
            fixture.bob.port,
            fixture.documentId,
            () => fixture.bob.sync.getDeliveries(fixture.documentId).length > 0,
          );
          expect(fixture.bob.sync.getDeliveries(fixture.documentId)).toHaveLength(1);
          expect(fixture.bob.sync.getRejections(fixture.documentId)).toEqual([]);
          // … and so does his to Alice, encrypted to the key he was given for her.
          await fixture.bob.port.send(fixture.documentId, BOB.address, "from bob");
          let toAlice = await fixture.alice.port.receive(fixture.documentId, ALICE.address);
          for (let i = 0; i < 20 && toAlice.length === 0; i++) {
            toAlice = await fixture.alice.port.receive(fixture.documentId, ALICE.address);
          }
          expect(toAlice).toHaveLength(1);
          expect(toAlice[0]?.sender).toBe(BOB.address);
          expect(fixture.alice.sync.getRejections(fixture.documentId)).toEqual([]);

          // The user's own keyring learnt nothing: Alice's key is still not in it.
          await expect(fixture.bob.gpg.listKeys(ALICE.address)).resolves.toEqual([]);
          // What Bob sees: Alice's key was not his, and he is told so (as a warning, not a wall).
          const view = await fixture.bob.port.pgpKeys(fixture.documentId);
          expect(view.enabled && view.gpgAvailable && view.entries).toMatchObject([
            { address: ALICE.address, isCreator: true, comparison: "missing-locally" },
            { address: BOB.address, isYou: true, comparison: "match" },
          ]);
          expect(describeKeyWarnings(view).map((w) => w.severity)).toEqual(["warning"]);
        } finally {
          for (const publicKey of publicKeys) {
            gpgIn(bobHome, ["--import"], publicKey);
          }
        }
      },
      CASE_TIMEOUT_MS * 2,
    );
  });

  /**
   * A loud error rather than a half-working join: the creator holds a different key for a
   * participant than that participant's own, so the invitation — encrypted to
   * the creator's copy — cannot be opened, and joining must fail loudly instead
   * of half-working.
   */
  it(
    "refuses to let Bob join when the creator holds a different key for him than his own — the invitation cannot be opened",
    async () => {
      const documentId = `pgp-live-alt-${counter++}-${Date.now()}`;
      const alice = await bridgeFor(ALICE);
      const recipients = [ALICE.address, BOB.address];
      const { threadRootMessageId } = await alice.port.startThread(
        documentId,
        recipients,
        ALICE.address,
        "yjs-paragraphs/1",
        undefined,
        true,
      );
      // Bob's bridge runs against a keyring whose key for his address is not the one Alice has.
      const bobAlt = await bridgeFor(BOB, bobElsewhere.homes.get(BOB.address));
      const error = await bobAlt.port
        .joinThread(
          documentId,
          threadRootMessageId,
          recipients,
          ALICE.address,
          "yjs-paragraphs/1",
          true,
        )
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(InviteRejectedError);
      expect((error as InviteRejectedError).reason).toBe("invite-undecipherable");
      expect(getBindRecord(bobAlt.bindStorePath, documentId)).toBeUndefined();
    },
    CASE_TIMEOUT_MS,
  );

  /**
   * A difference between the creator's key for someone and the joiner's own keyring is a
   * warning, not a wall — except for the creator's own key, the one independent check a
   * joiner has on the invitation (SPECIFICATION.md EML-8): then the join is refused. Here Bob's keyring holds only an
   * impostor's key for Alice's address, and the invitation carries the real one — which Bob
   * cannot tell from the reverse, a forged invitation against his correct key.
   */
  it(
    "refuses the join when Bob's own keyring holds a different key for Alice, the creator",
    async () => {
      const bobHome = keys.homes.get(BOB.address) as string;
      const realAlice = keys.fingerprints.get(ALICE.address) as string;
      const impostorKey = impostor.fingerprints.get(ALICE.address) as string;
      const impostorPublic = execFileSync(
        "gpg",
        [
          "--homedir",
          impostor.homes.get(ALICE.address) as string,
          "--batch",
          "--armor",
          "--export",
          impostorKey,
        ],
        { encoding: "utf8" },
      );
      const alicePublic = execFileSync(
        "gpg",
        ["--homedir", bobHome, "--batch", "--armor", "--export", realAlice],
        { encoding: "utf8" },
      );
      execFileSync("gpg", ["--homedir", bobHome, "--batch", "--yes", "--delete-keys", realAlice], {
        stdio: "pipe",
      });
      execFileSync("gpg", ["--homedir", bobHome, "--batch", "--import"], {
        input: impostorPublic,
        stdio: ["pipe", "pipe", "pipe"],
      });
      try {
        const error = await createFixture().catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(InviteRejectedError);
        expect((error as InviteRejectedError).reason).toBe("invite-creator-key-differs");
        expect((error as InviteRejectedError).message).toContain(impostorKey);
        expect((error as InviteRejectedError).message).toContain(realAlice);
      } finally {
        execFileSync(
          "gpg",
          ["--homedir", bobHome, "--batch", "--yes", "--delete-keys", impostorKey],
          { stdio: "pipe" },
        );
        execFileSync("gpg", ["--homedir", bobHome, "--batch", "--import"], {
          input: alicePublic,
          stdio: ["pipe", "pipe", "pipe"],
        });
      }
    },
    CASE_TIMEOUT_MS * 2,
  );

  /**
   * What a forged invitation can and cannot do — recorded, not hidden. A plain
   * one is refused outright. A *self-consistent* one from an impostor who holds
   * a key for Alice's address and signs as her is accepted (nothing the bridge
   * can check tells it apart), and is caught only because Bob's own keyring
   * knows the real Alice: the comparison flags it, loudly. A joiner who had
   * never held Alice's key would see only the softer "not in your keyring"
   * notice — which is why the fingerprints are shown, to be compared aloud.
   */
  describe("a forged invitation", () => {
    async function forgedInviteTo(bob: { port: EmailMessengerPort }, armoredOrText: string) {
      const documentId = `pgp-live-forged-${counter++}-${Date.now()}`;
      const rootId = `<forged-${counter}-${Date.now()}@example.org>`;
      const forger = createNodemailerSender({
        host: HOST,
        port: SMTP_PORT,
        secure: false,
        address: ALICE.address, // forged: sent through Bob's own account, From: Alice
        authUser: BOB.authUser,
        pass: BOB.password,
      });
      await forger.send({
        to: [BOB.address],
        subject: `tdsp document ${documentId}`,
        text: armoredOrText,
        documentId,
        messageId: rootId,
      });
      return {
        documentId,
        rootId,
        join: () =>
          bob.port.joinThread(
            documentId,
            rootId,
            [ALICE.address, BOB.address],
            ALICE.address,
            "yjs-paragraphs/1",
            true,
          ),
      };
    }

    it(
      "is refused when it is not signed and encrypted at all, however complete its link looks",
      async () => {
        const bob = await bridgeFor(BOB);
        const forged = await forgedInviteTo(bob, "Join us: http://localhost/?pgp=1");
        const error = await forged.join().catch((caught: unknown) => caught);
        expect((error as InviteRejectedError).reason).toBe("invite-not-encrypted");
      },
      CASE_TIMEOUT_MS,
    );

    it(
      "is refused when it is self-consistent but Bob's own keyring, which knows the real Alice, holds another key for her",
      async () => {
        const bob = await bridgeFor(BOB);
        // The impostor holds a key for alice@ and Bob's public key; she builds a valid invitation in Alice's name.
        const impostorHome = impostor.homes.get(ALICE.address) as string;
        const bobPublic = execFileSync(
          "gpg",
          [
            "--homedir",
            keys.homes.get(BOB.address) as string,
            "--batch",
            "--armor",
            "--export",
            bobFingerprint(),
          ],
          { encoding: "utf8" },
        );
        execFileSync("gpg", ["--homedir", impostorHome, "--batch", "--import"], {
          input: bobPublic,
          stdio: ["pipe", "pipe", "pipe"],
        });
        const impostorGpg = createGpgInvoker({ gnupgHome: impostorHome });
        const dir = mkdtempSync(join(tmpdir(), "email-bridge-pgp-live-impostor-"));
        dirs.push(dir);
        // Built exactly as a creator would: her own key chosen for her own entry, everyone else's from her keyring.
        const documentId = `pgp-live-forged-${counter++}-${Date.now()}`;
        const rebuilt = await createInvite({
          documentId,
          ownAddress: ALICE.address,
          recipients: [ALICE.address, BOB.address],
          profile: "yjs-paragraphs/1",
          gpg: impostorGpg,
          bindStorePath: join(dir, "threads.json"),
        });
        if (!rebuilt.ok) {
          throw new Error(rebuilt.error);
        }
        const rootId = `<forged-${counter}-${Date.now()}@example.org>`;
        const forger = createNodemailerSender({
          host: HOST,
          port: SMTP_PORT,
          secure: false,
          address: ALICE.address,
          authUser: BOB.authUser,
          pass: BOB.password,
        });
        await forger.send({
          to: [BOB.address],
          subject: `tdsp document ${documentId}`,
          text: composeInviteBody("Join us: http://localhost/?pgp=1", rebuilt.armored),
          documentId,
          messageId: rootId,
        });

        // Every PGP check inside the invitation passes — it is signed by the key it names for
        // Alice — so only Bob's own record of Alice's key can catch it (EML-8).
        const error = await bob.port
          .joinThread(
            documentId,
            rootId,
            [ALICE.address, BOB.address],
            ALICE.address,
            "yjs-paragraphs/1",
            true,
          )
          .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(InviteRejectedError);
        expect((error as InviteRejectedError).reason).toBe("invite-creator-key-differs");
        expect(getBindRecord(bob.bindStorePath, documentId)).toBeUndefined();
      },
      CASE_TIMEOUT_MS * 2,
    );
  });
});
