import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, type Logger, type LogRecord } from "@tdsp/bridge-log";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BindRecord, getBindRecord, setBindRecord } from "./bind-store.ts";
import { FakeGpgInvoker, fakeKey, inspectFakeMessage } from "./fake-gpg.ts";
import { keyringPathFor } from "./keyring-store.ts";
import type { IncomingMail, MailReceiver, MailSender, OutgoingMail } from "./mail-transport.ts";
import { createServer, type ServerDependencies } from "./server.ts";
import { createSyncState } from "./sync-state.ts";

/**
 * Security tests: only the CI role may change this file (.github/CODEOWNERS, CONTRIBUTING.md).
 *
 * L0 — the creator's removal of a participant from an email thread (bindings/email.md EML-1,
 * EML-2, EML-14; bindings/local-bridge-interface.md, `POST /threads/:documentId/remove`): who
 * may remove whom, which mail a bridge takes once the set it holds has shrunk, that the set
 * never grows back and outlasts a restart, and that a removed bridge neither sends nor
 * delivers. Fakes stand in for the mailbox and for `gpg` (fake-gpg.ts); every helper is in
 * this file.
 */

const ALICE = "alice@example.org";
const BOB = "bob@example.org";
const CAROL = "carol@example.org";
const MALLORY = "mallory@example.org";
const ROOT = "<root@example.org>";
const FP_ALICE = "A".repeat(40);
const FP_MALLORY = "B".repeat(40);
const FP_BOB = "D".repeat(40);
const FP_CAROL = "E".repeat(40);
const PINS = { [ALICE]: FP_ALICE, [BOB]: FP_BOB, [CAROL]: FP_CAROL };

class FakeMailReceiver implements MailReceiver {
  readonly tls = "plaintext-loopback" as const;
  readonly sentCopies: Buffer[] = [];
  #byDocument = new Map<string, IncomingMail[]>();

  async verify(): Promise<void> {}

  seed(documentId: string, messages: readonly IncomingMail[]): void {
    this.#byDocument.set(documentId, [...(this.#byDocument.get(documentId) ?? []), ...messages]);
  }

  async fetchThreadMessages(documentId: string): Promise<readonly IncomingMail[]> {
    return this.#byDocument.get(documentId) ?? [];
  }

  async storeSentCopy(raw: Buffer): Promise<void> {
    this.sentCopies.push(raw);
  }
}

class FakeMailSender implements MailSender {
  readonly tls = "plaintext-loopback" as const;
  readonly sent: OutgoingMail[] = [];
  /** Thrown by the next `send`, as `nodemailer` throws a failed send. */
  failure: object | undefined;
  #nextId = 1;

  constructor(readonly address: string) {}

  async verify(): Promise<void> {}

  async send(mail: OutgoingMail): Promise<{ messageId: string }> {
    if (this.failure !== undefined) {
      throw this.failure;
    }
    this.sent.push(mail);
    return { messageId: `<sent-${this.#nextId++}@example.org>` };
  }
}

function capturingLogger(): { records: LogRecord[]; logger: Logger } {
  const records: LogRecord[] = [];
  const logger = createLogger({
    component: "email-bridge",
    sink: (_line, record) => records.push(record),
    rateLimit: false,
  });
  return { records, logger };
}

function frame(payload: string): string {
  return JSON.stringify({ tdsp: 1, kind: "frame", documentId: "doc-1", frame: payload });
}

function notice(participant: string, documentId = "doc-1"): string {
  return JSON.stringify({ tdsp: 1, kind: "remove", documentId, participant });
}

function mail(
  messageId: string,
  from: string,
  to: readonly string[],
  text: string,
  cc: readonly string[] = [],
): IncomingMail {
  return { messageId, from, to, cc, text };
}

/** Alice created doc-1 with Bob and Carol, without PGP. */
function plainRecord(overrides: Partial<BindRecord> = {}): BindRecord {
  return {
    recipients: [ALICE, BOB, CAROL],
    creatorMemberId: ALICE,
    profile: "yjs-paragraphs/1",
    threadRootMessageId: ROOT,
    createdAt: new Date(0).toISOString(),
    pgpEnabled: false,
    pinnedFingerprints: {},
    ...overrides,
  };
}

let tempDir: string;
let bindStorePath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "email-bridge-removal-test-"));
  bindStorePath = join(tempDir, "tdsp-threads.json");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("receiving, without PGP (EML-2, EML-14)", () => {
  /** Bob's bridge, holding doc-1 as `record` says. */
  function bobsBridge(record: BindRecord = plainRecord()) {
    setBindRecord(bindStorePath, "doc-1", record);
    const receiver = new FakeMailReceiver();
    const { records, logger } = capturingLogger();
    const sync = createSyncState(receiver, bindStorePath, undefined, logger, undefined, BOB);
    return { receiver, records, sync };
  }

  const removedFromRecord = () => getBindRecord(bindStorePath, "doc-1")?.removed ?? [];

  it("takes the creator's notice: removes the participant for good, and delivers nothing of it", async () => {
    const { receiver, sync } = bobsBridge();
    receiver.seed("doc-1", [mail("<n1@x>", ALICE, [BOB, CAROL], notice(CAROL))]);
    await sync.pollOnce("doc-1");
    expect(removedFromRecord()).toEqual([CAROL]);
    expect(sync.getDeliveries("doc-1")).toEqual([]);
    expect(sync.getRejections("doc-1")).toEqual([]);
    // The recipients the thread started with stay as they were: the held set is the difference.
    expect(getBindRecord(bindStorePath, "doc-1")?.recipients).toEqual([ALICE, BOB, CAROL]);
  });

  it("takes a mail still addressed to the set before the removal, from a participant who had not read it", async () => {
    const { receiver, sync } = bobsBridge(plainRecord({ removed: [CAROL] }));
    receiver.seed("doc-1", [mail("<m1@x>", ALICE, [BOB, CAROL], frame("stale"))]);
    await sync.pollOnce("doc-1");
    expect(sync.getDeliveries("doc-1").map((d) => d.payload)).toEqual(["stale"]);
    expect(sync.getRejections("doc-1")).toEqual([]);
  });

  it("rejects a mail addressed to the reduced set before the notice arrives, and takes the next one after it", async () => {
    const { receiver, sync } = bobsBridge();
    receiver.seed("doc-1", [mail("<m1@x>", ALICE, [BOB], frame("early"))]);
    await sync.pollOnce("doc-1");
    expect(sync.getDeliveries("doc-1")).toEqual([]);
    expect(sync.getRejections("doc-1")).toEqual([
      { kind: "violation", id: "<m1@x>", sender: ALICE, reason: "recipient-list-mismatch" },
    ]);

    receiver.seed("doc-1", [
      mail("<n1@x>", ALICE, [BOB, CAROL], notice(CAROL)),
      mail("<m2@x>", ALICE, [BOB], frame("after")),
    ]);
    await sync.pollOnce("doc-1");
    expect(sync.getDeliveries("doc-1").map((d) => d.payload)).toEqual(["after"]);
  });

  it("takes, on another device of the creator, a mail to the reduced set read in the same poll as her notice, before it", async () => {
    setBindRecord(bindStorePath, "doc-1", plainRecord());
    const receiver = new FakeMailReceiver();
    const { logger } = capturingLogger();
    const sync = createSyncState(receiver, bindStorePath, undefined, logger, undefined, ALICE);
    // The inbox is read before the sent folder, where her other device filed the notice (EML-12).
    receiver.seed("doc-1", [
      mail("<m1@x>", BOB, [ALICE], frame("after")),
      mail("<n1@x>", ALICE, [BOB, CAROL], notice(CAROL)),
    ]);
    await sync.pollOnce("doc-1");
    expect(getBindRecord(bindStorePath, "doc-1")?.removed).toEqual([CAROL]);
    expect(sync.getDeliveries("doc-1").map((d) => d.payload)).toEqual(["after"]);
    expect(sync.getRejections("doc-1")).toEqual([]);
  });

  it("rejects a mail from a removed participant once the notice is taken", async () => {
    const { receiver, sync } = bobsBridge();
    receiver.seed("doc-1", [
      mail("<n1@x>", ALICE, [BOB, CAROL], notice(CAROL)),
      mail("<m1@x>", CAROL, [ALICE, BOB], frame("from-carol")),
    ]);
    await sync.pollOnce("doc-1");
    expect(sync.getDeliveries("doc-1")).toEqual([]);
    expect(sync.getRejections("doc-1")).toEqual([
      { kind: "violation", id: "<m1@x>", sender: CAROL, reason: "recipient-list-mismatch" },
    ]);
  });

  it("still rejects a recipient who was never a participant, and a participant left out", async () => {
    const { receiver, sync } = bobsBridge(plainRecord({ removed: [CAROL] }));
    receiver.seed("doc-1", [
      mail("<m1@x>", ALICE, [BOB, MALLORY], frame("outsider")),
      mail("<m2@x>", ALICE, [CAROL], frame("left-out")),
    ]);
    await sync.pollOnce("doc-1");
    expect(sync.getDeliveries("doc-1")).toEqual([]);
    expect(sync.getRejections("doc-1").map((r) => r.reason)).toEqual([
      "recipient-list-mismatch",
      "recipient-list-mismatch",
    ]);
  });

  it("does not take a notice that fails EML-2: one that leaves out the participant it removes", async () => {
    const { receiver, sync } = bobsBridge();
    receiver.seed("doc-1", [mail("<n1@x>", ALICE, [BOB], notice(CAROL))]);
    await sync.pollOnce("doc-1");
    expect(removedFromRecord()).toEqual([]);
    expect(sync.getRejections("doc-1")).toEqual([
      { kind: "violation", id: "<n1@x>", sender: ALICE, reason: "recipient-list-mismatch" },
    ]);
  });

  it("does not take a notice from anyone but the creator, and logs it", async () => {
    const { receiver, records, sync } = bobsBridge();
    receiver.seed("doc-1", [mail("<n1@x>", CAROL, [ALICE, BOB], notice(BOB))]);
    await sync.pollOnce("doc-1");
    expect(removedFromRecord()).toEqual([]);
    expect(sync.getDeliveries("doc-1")).toEqual([]);
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "removal-ignored",
        fields: expect.objectContaining({ reason: "not-from-creator", sender: CAROL }),
      }),
    );
  });

  it("does not take a notice that removes the creator", async () => {
    const { receiver, records, sync } = bobsBridge();
    receiver.seed("doc-1", [mail("<n1@x>", ALICE, [BOB, CAROL], notice(ALICE))]);
    await sync.pollOnce("doc-1");
    expect(removedFromRecord()).toEqual([]);
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "removal-ignored",
        fields: expect.objectContaining({ reason: "names-the-creator" }),
      }),
    );
  });

  it("never grows the set: a notice naming an address that was never a participant changes nothing", async () => {
    const { receiver, records, sync } = bobsBridge();
    receiver.seed("doc-1", [mail("<n1@x>", ALICE, [BOB, CAROL], notice(MALLORY))]);
    await sync.pollOnce("doc-1");
    expect(getBindRecord(bindStorePath, "doc-1")).toEqual(plainRecord());
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "removal-ignored",
        fields: expect.objectContaining({ reason: "not-a-participant" }),
      }),
    );
  });

  it("ignores a notice that is not one: another document's, or a participant not in canonical form", async () => {
    const { receiver, sync } = bobsBridge();
    receiver.seed("doc-1", [
      mail("<n1@x>", ALICE, [BOB, CAROL], notice(CAROL, "doc-2")),
      mail("<n2@x>", ALICE, [BOB, CAROL], notice("Carol@Example.org")),
      mail("<n3@x>", ALICE, [BOB, CAROL], notice("Carol <carol@example.org>")),
    ]);
    await sync.pollOnce("doc-1");
    expect(removedFromRecord()).toEqual([]);
    expect(sync.getDeliveries("doc-1")).toEqual([]);
  });

  it("takes each notice once, and a second notice for one already removed changes nothing and says nothing", async () => {
    const { receiver, records, sync } = bobsBridge();
    const first = mail("<n1@x>", ALICE, [BOB, CAROL], notice(CAROL));
    receiver.seed("doc-1", [first]);
    await sync.pollOnce("doc-1");
    await sync.pollOnce("doc-1");
    receiver.seed("doc-1", [mail("<n2@x>", ALICE, [BOB, CAROL], notice(CAROL))]);
    await sync.pollOnce("doc-1");
    expect(removedFromRecord()).toEqual([CAROL]);
    expect(records.filter((r) => r.event === "participant-removed")).toHaveLength(1);
    expect(records.filter((r) => r.event === "removal-ignored")).toEqual([]);
    expect(sync.getDeliveries("doc-1")).toEqual([]);
  });

  it("removes in any order and never adds back: two notices end in the same set whichever comes first", async () => {
    const one = mail("<n1@x>", ALICE, [BOB, CAROL, "dave@example.org"], notice(CAROL));
    const two = mail("<n2@x>", ALICE, [BOB, CAROL, "dave@example.org"], notice("dave@example.org"));
    const results: (readonly string[])[] = [];
    for (const order of [
      [one, two],
      [two, one],
    ]) {
      const { receiver, sync } = bobsBridge(
        plainRecord({ recipients: [ALICE, BOB, CAROL, "dave@example.org"] }),
      );
      receiver.seed("doc-1", order);
      await sync.pollOnce("doc-1");
      results.push([...removedFromRecord()].sort());
    }
    expect(results[0]).toEqual([CAROL, "dave@example.org"]);
    expect(results[1]).toEqual(results[0]);
  });

  it("keeps the removal across a restart: a fresh sync state from the same bind store holds the smaller set", async () => {
    const before = bobsBridge();
    before.receiver.seed("doc-1", [mail("<n1@x>", ALICE, [BOB, CAROL], notice(CAROL))]);
    await before.sync.pollOnce("doc-1");

    const receiver = new FakeMailReceiver();
    const after = createSyncState(
      receiver,
      bindStorePath,
      undefined,
      capturingLogger().logger,
      undefined,
      BOB,
    );
    receiver.seed("doc-1", [
      mail("<m1@x>", CAROL, [ALICE, BOB], frame("from-carol")),
      mail("<m2@x>", ALICE, [BOB], frame("to-the-smaller-set")),
    ]);
    await after.pollOnce("doc-1");
    expect(after.getDeliveries("doc-1").map((d) => d.payload)).toEqual(["to-the-smaller-set"]);
    expect(after.getRejections("doc-1").map((r) => r.id)).toEqual(["<m1@x>"]);
  });

  /**
   * The limit EML-9 and EML-14 state: without PGP `From` is as forgeable as any header, so a
   * notice anyone writes with the creator's address in `From` is taken as hers.
   */
  it("takes a notice with a forged From: without PGP, as EML-14 states it does", async () => {
    const { receiver, sync } = bobsBridge();
    // Written by Mallory, who is not a participant, with Alice's address as its sender.
    receiver.seed("doc-1", [mail("<forged@mallory>", ALICE, [BOB, CAROL], notice(CAROL))]);
    await sync.pollOnce("doc-1");
    expect(removedFromRecord()).toEqual([CAROL]);
  });

  it("delivers nothing more once its own address is removed, not even a mail later in the same poll", async () => {
    setBindRecord(bindStorePath, "doc-1", plainRecord());
    const receiver = new FakeMailReceiver();
    const carol = createSyncState(
      receiver,
      bindStorePath,
      undefined,
      capturingLogger().logger,
      undefined,
      CAROL,
    );
    receiver.seed("doc-1", [
      mail("<m0@x>", ALICE, [BOB, CAROL], frame("before")),
      mail("<n1@x>", ALICE, [BOB, CAROL], notice(CAROL)),
      mail("<m1@x>", BOB, [ALICE, CAROL], frame("stale-but-after")),
    ]);
    await carol.pollOnce("doc-1");
    expect(carol.getDeliveries("doc-1").map((d) => d.payload)).toEqual(["before"]);
    receiver.seed("doc-1", [mail("<m2@x>", BOB, [ALICE, CAROL], frame("later"))]);
    await carol.pollOnce("doc-1");
    expect(carol.getDeliveries("doc-1").map((d) => d.payload)).toEqual(["before"]);
    expect(carol.getRejections("doc-1")).toEqual([]);
  });
});

describe("receiving, with PGP (EML-3, EML-14)", () => {
  let bobGpg: FakeGpgInvoker;

  /** A sender's own keyring: its secret key, and the public keys it encrypts to. */
  function senderKeyring(address: string, fingerprint: string): FakeGpgInvoker {
    const ring = new FakeGpgInvoker();
    ring.seedSecretKey(address, fingerprint);
    ring.seedKey(BOB, fakeKey("D", BOB));
    ring.seedKey(CAROL, fakeKey("E", CAROL));
    return ring;
  }

  /** Bob's bridge for a PGP document: Alice, Bob and Carol pinned from the invitation. */
  function bobsBridge() {
    bobGpg = new FakeGpgInvoker();
    bobGpg.seedSecretKey(BOB, FP_BOB);
    const keyringPath = keyringPathFor(bindStorePath, "doc-1");
    const ring = bobGpg.withKeyring(keyringPath);
    for (const [address, fingerprint] of Object.entries(PINS)) {
      ring.seedKey(address, { fingerprint, userIds: [address] });
    }
    setBindRecord(
      bindStorePath,
      "doc-1",
      plainRecord({
        pgpEnabled: true,
        pinnedFingerprints: PINS,
        keyringPath,
        ownFingerprint: FP_BOB,
      }),
    );
    const receiver = new FakeMailReceiver();
    const { records, logger } = capturingLogger();
    const sync = createSyncState(receiver, bindStorePath, bobGpg, logger, undefined, BOB);
    return { receiver, records, sync };
  }

  async function sealed(signer: FakeGpgInvoker, as: string, text: string): Promise<string> {
    return signer.signAndEncrypt(text, as, [FP_BOB, FP_CAROL]);
  }

  const removedFromRecord = () => getBindRecord(bindStorePath, "doc-1")?.removed ?? [];

  it("takes a notice signed by the creator's pinned key and encrypted like a frame mail", async () => {
    const { receiver, sync } = bobsBridge();
    const alice = senderKeyring(ALICE, FP_ALICE);
    receiver.seed("doc-1", [
      mail("<n1@x>", ALICE, [BOB, CAROL], await sealed(alice, ALICE, notice(CAROL))),
    ]);
    await sync.pollOnce("doc-1");
    expect(removedFromRecord()).toEqual([CAROL]);
    expect(sync.getDeliveries("doc-1")).toEqual([]);
  });

  it("does not take a notice with the creator's From: signed by another participant's key", async () => {
    const { receiver, sync } = bobsBridge();
    const carolAsAlice = senderKeyring(ALICE, FP_CAROL);
    receiver.seed("doc-1", [
      mail("<n1@x>", ALICE, [BOB, CAROL], await sealed(carolAsAlice, ALICE, notice(BOB))),
    ]);
    await sync.pollOnce("doc-1");
    expect(removedFromRecord()).toEqual([]);
    expect(sync.getRejections("doc-1").map((r) => r.reason)).toEqual(["pgp-identity-changed"]);
  });

  it("does not take a notice with the creator's From: signed by a key the document does not know", async () => {
    const { receiver, sync } = bobsBridge();
    const mallory = senderKeyring(ALICE, FP_MALLORY);
    receiver.seed("doc-1", [
      mail("<n1@x>", ALICE, [BOB, CAROL], await sealed(mallory, ALICE, notice(CAROL))),
    ]);
    await sync.pollOnce("doc-1");
    expect(removedFromRecord()).toEqual([]);
    expect(sync.getRejections("doc-1").map((r) => r.reason)).toEqual(["pgp-signature-invalid"]);
  });

  it("does not take a notice a participant other than the creator signed as herself", async () => {
    const { receiver, records, sync } = bobsBridge();
    const carol = new FakeGpgInvoker();
    carol.seedSecretKey(CAROL, FP_CAROL);
    carol.seedKey(BOB, fakeKey("D", BOB));
    carol.seedKey(ALICE, fakeKey("A", ALICE));
    receiver.seed("doc-1", [
      mail(
        "<n1@x>",
        CAROL,
        [ALICE, BOB],
        await carol.signAndEncrypt(notice(BOB), CAROL, [FP_ALICE, FP_BOB]),
      ),
    ]);
    await sync.pollOnce("doc-1");
    expect(removedFromRecord()).toEqual([]);
    expect(sync.getRejections("doc-1")).toEqual([]);
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "removal-ignored",
        fields: expect.objectContaining({ reason: "not-from-creator" }),
      }),
    );
  });

  it("rejects a plain notice in a PGP document as unsigned, and does not take it", async () => {
    const { receiver, sync } = bobsBridge();
    receiver.seed("doc-1", [mail("<n1@x>", ALICE, [BOB, CAROL], notice(CAROL))]);
    await sync.pollOnce("doc-1");
    expect(removedFromRecord()).toEqual([]);
    expect(sync.getRejections("doc-1").map((r) => r.reason)).toEqual(["pgp-unsigned"]);
  });
});

describe("POST /threads/:documentId/remove and sending after it (EML-14, BRG-16)", () => {
  let server: Server;
  let baseUrl: string;
  let sender: FakeMailSender;
  let receiver: FakeMailReceiver;

  async function start(address: string | undefined, deps: Partial<ServerDependencies> = {}) {
    sender = new FakeMailSender(address ?? ALICE);
    receiver = new FakeMailReceiver();
    server = createServer({
      address,
      sender: address === undefined ? undefined : sender,
      receiver,
      sync: undefined,
      gpg: undefined,
      bindStorePath,
      logger: capturingLogger().logger,
      ...deps,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const bound = server.address();
    baseUrl = typeof bound === "object" && bound ? `http://127.0.0.1:${bound.port}` : "";
  }

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const remove = (body: object, documentId = "doc-1") =>
    fetch(`${baseUrl}/threads/${documentId}/remove`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const send = (from: string, payload: string) =>
    fetch(`${baseUrl}/channels/doc-1/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sender: from, payload }),
    });
  const members = () => fetch(`${baseUrl}/members?channelId=${encodeURIComponent(ROOT)}`);

  it("sends the creator's notice to the set before the removal, files its copy, then holds the smaller set", async () => {
    setBindRecord(bindStorePath, "doc-1", plainRecord());
    await start(ALICE);
    const response = await remove({ actor: ALICE, participant: CAROL });
    expect(response.status).toBe(200);
    const { messageId } = (await response.json()) as { messageId: string };
    expect(messageId).toBe("<sent-1@example.org>");

    expect(sender.sent).toHaveLength(1);
    const [sent] = sender.sent;
    expect(sent).toMatchObject({
      to: [BOB, CAROL],
      subject: "tdsp document doc-1",
      documentId: "doc-1",
      inReplyTo: ROOT,
      references: [ROOT],
    });
    expect(JSON.parse(sent?.text ?? "")).toEqual({
      tdsp: 1,
      kind: "remove",
      documentId: "doc-1",
      participant: CAROL,
    });
    expect(receiver.sentCopies).toHaveLength(1);
    expect(getBindRecord(bindStorePath, "doc-1")?.removed).toEqual([CAROL]);

    // From now on: addressed to the set it holds, and that is the set /members answers.
    expect((await send(ALICE, "next")).status).toBe(200);
    expect(sender.sent[1]?.to).toEqual([BOB]);
    expect(await (await members()).json()).toEqual([ALICE, BOB]);
  });

  it("canonicalizes the participant it is asked to remove (EML-10)", async () => {
    setBindRecord(bindStorePath, "doc-1", plainRecord());
    await start(ALICE);
    expect(
      (await remove({ actor: "Alice@Example.org", participant: " Carol@Example.org" })).status,
    ).toBe(200);
    expect(getBindRecord(bindStorePath, "doc-1")?.removed).toEqual([CAROL]);
  });

  it("refuses, sending nothing and changing nothing, every request but the creator's own for a participant", async () => {
    setBindRecord(bindStorePath, "doc-1", plainRecord({ removed: [] }));
    await start(ALICE);
    const refusals = [
      // Not this bridge's own account.
      { actor: BOB, participant: CAROL },
      // The creator herself.
      { actor: ALICE, participant: ALICE },
      // Never a participant.
      { actor: ALICE, participant: MALLORY },
      // Not a bare address.
      { actor: ALICE, participant: "Carol <carol@example.org>" },
    ];
    for (const body of refusals) {
      expect((await remove(body)).status, JSON.stringify(body)).toBe(403);
    }
    expect(sender.sent).toEqual([]);
    expect(getBindRecord(bindStorePath, "doc-1")?.removed).toEqual([]);
  });

  it("refuses a participant already removed: not in the set it holds", async () => {
    setBindRecord(bindStorePath, "doc-1", plainRecord({ removed: [CAROL] }));
    await start(ALICE);
    expect((await remove({ actor: ALICE, participant: CAROL })).status).toBe(403);
    expect(sender.sent).toEqual([]);
  });

  it("refuses a bridge that is not the creator's, even when the actor is its own account", async () => {
    setBindRecord(bindStorePath, "doc-1", plainRecord());
    await start(BOB);
    expect((await remove({ actor: BOB, participant: CAROL })).status).toBe(403);
    expect(sender.sent).toEqual([]);
    expect(getBindRecord(bindStorePath, "doc-1")?.removed).toBeUndefined();
  });

  it("answers 404 for a document it holds no thread for, 400 for a malformed request, 409 unprovisioned", async () => {
    setBindRecord(bindStorePath, "doc-1", plainRecord());
    await start(ALICE);
    expect((await remove({ actor: ALICE, participant: CAROL }, "doc-unknown")).status).toBe(404);
    expect((await remove({ actor: ALICE })).status).toBe(400);
    expect((await remove({ participant: CAROL })).status).toBe(400);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await start(undefined);
    expect((await remove({ actor: ALICE, participant: CAROL })).status).toBe(409);
  });

  it("maps a failed send as /send does, and keeps the participant when the notice did not go out", async () => {
    setBindRecord(bindStorePath, "doc-1", plainRecord());
    await start(ALICE);
    sender.failure = Object.assign(new Error("try again later"), { responseCode: 451 });
    expect((await remove({ actor: ALICE, participant: CAROL })).status).toBe(429);
    expect(getBindRecord(bindStorePath, "doc-1")?.removed).toBeUndefined();
  });

  it("a removed bridge refuses every send as rejected (403) and is no member of the thread", async () => {
    setBindRecord(bindStorePath, "doc-1", plainRecord({ removed: [CAROL] }));
    await start(CAROL);
    expect((await send(CAROL, "anything")).status).toBe(403);
    expect(sender.sent).toEqual([]);
    expect((await members()).status).toBe(404);
  });

  it("joining the thread again keeps the removals: the set never grows back", async () => {
    setBindRecord(bindStorePath, "doc-1", plainRecord({ removed: [CAROL] }));
    await start(BOB);
    const join = await fetch(`${baseUrl}/threads/doc-1/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        recipients: [ALICE, BOB, CAROL],
        creator: ALICE,
        profile: "yjs-paragraphs/1",
        threadRootMessageId: ROOT,
      }),
    });
    expect(join.status).toBe(200);
    expect(getBindRecord(bindStorePath, "doc-1")?.removed).toEqual([CAROL]);
    expect(await (await members()).json()).toEqual([ALICE, BOB]);
  });

  it("the creator's own notice, read back from the sent folder (EML-12), is taken by the bridge that sent it without harm", async () => {
    setBindRecord(bindStorePath, "doc-1", plainRecord());
    await start(ALICE);
    expect((await remove({ actor: ALICE, participant: CAROL })).status).toBe(200);
    const [sent] = sender.sent;
    const own = new FakeMailReceiver();
    const { records, logger } = capturingLogger();
    const sync = createSyncState(own, bindStorePath, undefined, logger, undefined, ALICE);
    own.seed("doc-1", [mail("<sent-1@example.org>", ALICE, sent?.to ?? [], sent?.text ?? "")]);
    await sync.pollOnce("doc-1");
    expect(getBindRecord(bindStorePath, "doc-1")?.removed).toEqual([CAROL]);
    expect(sync.getDeliveries("doc-1")).toEqual([]);
    expect(sync.getRejections("doc-1")).toEqual([]);
    expect(records.filter((r) => r.level === "warn")).toEqual([]);
  });

  describe("with PGP", () => {
    let gpg: FakeGpgInvoker;

    async function startPgpCreator() {
      gpg = new FakeGpgInvoker();
      gpg.seedSecretKey(ALICE, FP_ALICE);
      const keyringPath = keyringPathFor(bindStorePath, "doc-1");
      const ring = gpg.withKeyring(keyringPath);
      for (const [address, fingerprint] of Object.entries(PINS)) {
        ring.seedKey(address, { fingerprint, userIds: [address] });
      }
      setBindRecord(
        bindStorePath,
        "doc-1",
        plainRecord({
          pgpEnabled: true,
          pinnedFingerprints: PINS,
          keyringPath,
          ownFingerprint: FP_ALICE,
        }),
      );
      await start(ALICE, { gpg });
    }

    it("signs the notice with the creator's key and encrypts it to the set before the removal; later mail only to the smaller set", async () => {
      await startPgpCreator();
      expect((await remove({ actor: ALICE, participant: CAROL })).status).toBe(200);
      const opened = inspectFakeMessage(sender.sent[0]?.text ?? "");
      expect(opened?.signer).toBe(FP_ALICE);
      expect([...(opened?.recipients ?? [])].sort()).toEqual([FP_ALICE, FP_BOB, FP_CAROL]);
      expect(JSON.parse(opened?.payload ?? "")).toMatchObject({
        kind: "remove",
        participant: CAROL,
      });

      expect((await send(ALICE, "next")).status).toBe(200);
      const next = inspectFakeMessage(sender.sent[1]?.text ?? "");
      expect([...(next?.recipients ?? [])].sort()).toEqual([FP_ALICE, FP_BOB]);
      expect(sender.sent[1]?.to).toEqual([BOB]);
    });

    it("no longer needs a removed participant's key to send", async () => {
      await startPgpCreator();
      expect((await remove({ actor: ALICE, participant: CAROL })).status).toBe(200);
      gpg.withKeyring(keyringPathFor(bindStorePath, "doc-1")).removeKey(FP_CAROL);
      expect((await send(ALICE, "next")).status).toBe(200);
    });
  });
});
