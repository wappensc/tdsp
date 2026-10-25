import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@tdsp/bridge-log";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setBindRecord } from "./bind-store.ts";
import type { GpgDecryptResult, GpgInvoker } from "./gpg-invoke.ts";
import type { IncomingMail, MailReceiver } from "./mail-transport.ts";
import { createSyncState } from "./sync-state.ts";

/**
 * A mail the bridge cannot read does not keep it from the thread's others (BRG-18), and one whose
 * reading failed in a way that may pass is read again on a later poll, a few times at most.
 */

const DOC = "doc-1";
const FINGERPRINT = "A".repeat(40);

/** A mail of the PGP document whose armored text `gpg` is asked to open as `frame`. */
const mail = (messageId: string, frame: string): IncomingMail => ({
  messageId,
  from: "bob@example.org",
  to: ["alice@example.org"],
  cc: [],
  text: `-----BEGIN PGP MESSAGE-----\n${frame}\n-----END PGP MESSAGE-----\n`,
});

describe("a mail the email bridge cannot read (BRG-18)", () => {
  let dir: string;
  let bindStorePath: string;
  let logged: string[];
  /** How often `gpg` still fails for each frame; reads of each frame are counted. */
  let failures: Map<string, number>;
  let reads: Map<string, number>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "email-unreadable-"));
    bindStorePath = join(dir, "tdsp-threads.json");
    setBindRecord(bindStorePath, DOC, {
      recipients: ["alice@example.org", "bob@example.org"],
      creatorMemberId: "alice@example.org",
      profile: "yjs-paragraphs/1",
      threadRootMessageId: "<root@example.org>",
      createdAt: new Date(0).toISOString(),
      pgpEnabled: true,
      keyringPath: join(dir, "keyring"),
      pinnedFingerprints: { "bob@example.org": FINGERPRINT },
    });
    logged = [];
    failures = new Map();
    reads = new Map();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A `gpg` that opens every mail to its frame, but fails as `failures` says, as a crash would. */
  const gpg = {
    withKeyring: () => ({
      decryptAndVerify: async (armored: string): Promise<GpgDecryptResult> => {
        const frame = armored.split("\n")[1] as string;
        reads.set(frame, (reads.get(frame) ?? 0) + 1);
        const left = failures.get(frame) ?? 0;
        if (left > 0) {
          failures.set(frame, left - 1);
          throw new Error("gpg exited unexpectedly");
        }
        return {
          decrypted: true,
          signature: "valid",
          signerFingerprint: FINGERPRINT,
          payload: JSON.stringify({ tdsp: 1, kind: "frame", documentId: DOC, frame }),
        };
      },
    }),
  } as unknown as GpgInvoker;

  const syncOver = (messages: readonly IncomingMail[]) => {
    const receiver: MailReceiver = {
      tls: "plaintext-loopback",
      verify: async () => {},
      fetchThreadMessages: async () => messages,
    };
    return createSyncState(
      receiver,
      bindStorePath,
      gpg,
      createLogger({ component: "test", sink: (_line, record) => logged.push(record.event) }),
    );
  };

  const ids = (sync: ReturnType<typeof syncOver>) =>
    sync.getDeliveries(DOC).map((delivery) => delivery.id);

  it("delivers the mails after it in the same poll, and logs it", async () => {
    failures.set("Ag==", 99);
    const sync = syncOver([mail("<a@x>", "AQ=="), mail("<b@x>", "Ag=="), mail("<c@x>", "Aw==")]);
    await sync.pollOnce(DOC);
    expect(ids(sync)).toEqual(["<a@x>", "<c@x>"]);
    expect(logged).toContain("message-unreadable");
  });

  it("reads one that failed once again on the next poll, and delivers it then", async () => {
    failures.set("Ag==", 1);
    const sync = syncOver([mail("<b@x>", "Ag=="), mail("<c@x>", "Aw==")]);
    await sync.pollOnce(DOC);
    expect(ids(sync)).toEqual(["<c@x>"]);
    await sync.pollOnce(DOC);
    expect(ids(sync)).toEqual(["<c@x>", "<b@x>"]);
  });

  it("gives up on one that keeps failing after three reads", async () => {
    failures.set("Ag==", 99);
    const sync = syncOver([mail("<b@x>", "Ag==")]);
    for (let poll = 0; poll < 5; poll += 1) {
      await sync.pollOnce(DOC);
    }
    expect(reads.get("Ag==")).toBe(3);
    expect(ids(sync)).toEqual([]);
  });
});
