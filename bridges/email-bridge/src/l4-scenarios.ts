import { isLoopbackHost } from "@tdsp/loopback";
import {
  describeInviteRejection,
  EmailMessengerPort,
  InviteRejectedError,
} from "@tdsp/messenger-email";
import { messengerPortContractCases } from "@tdsp/messenger-port/contract";
import { expect, it, onTestFailed } from "vitest";

/**
 * The email adapter's L4 scenarios (docs/testing.md), written once and run wherever
 * two real bridges each hold one real mailbox — as two local processes on this
 * machine (`l4-provider.test.ts`), or as two bridges on separate machines reached
 * through SSH tunnels. A scenario only ever talks to a bridge over HTTP, so it cannot
 * tell which — which is the point: what differs is where the bridges run, not what is
 * asserted.
 *
 * What only a real provider can settle, and so what these check: that both
 * connections are TLS, that a sender-chosen `Message-ID` survives submission (a PGP
 * invitation is found by exactly it), that an armored block and `To`/`Cc` survive
 * delivery (the bridge would reject the message otherwise), and how long delivery
 * takes. Observations are handed to `target.record`, because Vitest does not show
 * the console output of passing tests and these numbers are the point.
 */
export interface EmailL4Bridge {
  /** `http://127.0.0.1:<port>` of the bridge holding this mailbox. */
  readonly url: string;
  readonly address: string;
  /** The bridge's own log, when this process started it (printed if a test fails). */
  readonly log?: () => string;
  /** The host the bridge connects to, to tell a real provider from the local test server. */
  readonly mailHost: string;
}

export interface EmailL4Target {
  readonly alice: () => EmailL4Bridge;
  readonly bob: () => EmailL4Bridge;
  readonly record: (key: string, value: unknown) => void;
}

const PAYLOAD_BYTES = 6000;
const SLOW = 240_000;

/** A provider refusing to send is a fact about the provider, not a bug here: say so instead of showing a bare 450. */
function explainProviderRefusal(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /\b4\d\d\b/.test(message) &&
    /try again later|mailbox unavailable|too many|rate|limit|throttl/i.test(message)
  ) {
    return new Error(
      `The provider is refusing to send from this account right now — a temporary (4xx) refusal, almost ` +
        `certainly a sending limit reached by earlier runs. Wait (GMX allowed roughly 35 mails in 20 minutes ` +
        `before this happened, then recovered), and re-run. Provider said: ${message}`,
    );
  }
  return error instanceof Error ? error : new Error(message);
}

/** Runs one call that sends mail, turning a provider's temporary refusal into its real explanation. */
async function explaining<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw explainProviderRefusal(error);
  }
}

export function defineEmailL4Scenarios(target: EmailL4Target): void {
  let counter = 0;
  // One port per participant for the whole run: `createDocument` must be called on the very
  // instance whose `startThread` created the thread. Built on first use, because the
  // bridges' URLs are only known once the caller's `beforeAll` has started them.
  let alicePort: EmailMessengerPort | undefined;
  let bobPort: EmailMessengerPort | undefined;
  const alice = () => {
    alicePort ??= new EmailMessengerPort(target.alice().url);
    return alicePort;
  };
  const bob = () => {
    bobPort ??= new EmailMessengerPort(target.bob().url);
    return bobPort;
  };

  const logsOnFailure = () =>
    onTestFailed(() => {
      const a = target.alice().log?.();
      const b = target.bob().log?.();
      if (a !== undefined || b !== undefined) {
        console.error(
          `--- alice's bridge log ---\n${a ?? ""}\n--- bob's bridge log ---\n${b ?? ""}`,
        );
      }
    });

  /** Polls `attempt` until it returns something, or fails saying what never happened. */
  async function until<T>(
    what: string,
    attempt: () => Promise<T | undefined>,
    timeoutMs = 150_000,
    everyMs = 3_000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = await attempt();
      if (result !== undefined) {
        return result;
      }
      if (Date.now() >= deadline) {
        throw new Error(`${what} did not happen within ${Math.round(timeoutMs / 1000)}s`);
      }
      await new Promise((resolve) => setTimeout(resolve, everyMs));
    }
  }

  // A frame's text, as the transport contract carries it: a JSON string with quotes, a
  // backslash and non-ASCII, so the envelope's escaping is exercised on a real provider too.
  const frame = (seed: number) =>
    JSON.stringify({
      seed,
      fill: 'äö\\"'.repeat(Math.ceil(PAYLOAD_BYTES / 5)).slice(0, PAYLOAD_BYTES),
    });

  async function startThread(
    documentId: string,
    pgpEnabled: boolean,
  ): Promise<{ threadRootMessageId: string; recipients: string[] }> {
    const recipients = [target.alice().address, target.bob().address];
    try {
      const { threadRootMessageId } = await alice().startThread(
        documentId,
        recipients,
        target.alice().address,
        "yjs-paragraphs/1",
        undefined,
        pgpEnabled,
      );
      return { threadRootMessageId, recipients };
    } catch (error) {
      throw explainProviderRefusal(error);
    }
  }

  it(
    "reaches both mailboxes over TLS — and reports how, so it is seen and not assumed",
    async () => {
      logsOnFailure();
      for (const [who, bridge, port] of [
        ["alice", target.alice(), alice()],
        ["bob", target.bob(), bob()],
      ] as const) {
        const body = await port.mailStatus();
        target.record(`${who}MailStatus`, body);
        if (!body.configured) {
          throw new Error(`${who}'s bridge has no mailbox configured`);
        }
        expect(body.smtp, `${who}'s SMTP`).toMatchObject({ ok: true });
        expect(body.imap, `${who}'s IMAP`).toMatchObject({ ok: true });
        // Never plaintext for a real host: implicit TLS or STARTTLS that is required.
        // (Plaintext is possible only towards this machine, which lets the local scenarios be
        // dry-run against the local Greenmail server; a real provider can never show it.)
        const allowed = isLoopbackHost(bridge.mailHost)
          ? ["implicit", "starttls-required", "plaintext-loopback"]
          : ["implicit", "starttls-required"];
        expect(allowed).toContain(body.smtp.tls);
        expect(allowed).toContain(body.imap.tls);
      }
    },
    SLOW,
  );

  it(
    "carries a plain document's edit both ways through the real provider, byte-identical, and times it",
    async () => {
      logsOnFailure();
      const documentId = `l4-plain-${counter++}-${Date.now()}`;
      const { threadRootMessageId, recipients } = await startThread(documentId, false);
      const a = target.alice().address;
      const b = target.bob().address;
      await bob().joinThread(documentId, threadRootMessageId, recipients, a, "yjs-paragraphs/1");

      const toBob = frame(7);
      const sentAt = Date.now();
      await explaining(() => alice().send(documentId, a, toBob));
      const received = await until("Alice's edit arriving at Bob", async () => {
        const deliveries = await bob().receive(documentId, b);
        return deliveries.length > 0 ? deliveries : undefined;
      });
      target.record("plainAliceToBobMs", Date.now() - sentAt);
      expect(received[0]?.sender).toBe(a);
      expect(received[0]?.payload).toBe(toBob);

      const toAlice = frame(11);
      const replyAt = Date.now();
      await explaining(() => bob().send(documentId, b, toAlice));
      const back = await until("Bob's edit arriving at Alice", async () => {
        const deliveries = await alice().receive(documentId, a);
        return deliveries.length > 0 ? deliveries : undefined;
      });
      target.record("plainBobToAliceMs", Date.now() - replyAt);
      expect(back[0]?.sender).toBe(b);
      expect(back[0]?.payload).toBe(toAlice);

      // Nothing the provider did to the mail made either bridge reject it.
      expect(await alice().integrityLog(documentId)).toEqual([]);
      expect(await bob().integrityLog(documentId)).toEqual([]);
    },
    SLOW,
  );

  it(
    "carries a PGP document end to end: the invitation is found by its own Message-ID, verified, and both keys' edits converge",
    async () => {
      logsOnFailure();
      const documentId = `l4-pgp-${counter++}-${Date.now()}`;
      const { threadRootMessageId, recipients } = await startThread(documentId, true);
      const a = target.alice().address;
      const b = target.bob().address;
      target.record("pgpInvitationMessageId", threadRootMessageId);
      const invitedAt = Date.now();

      // Bob joins by *reading the invitation out of his real mailbox*. It finds it by the
      // Message-ID the creator chose, so a provider that rewrote that id on submission shows
      // up here as "invite-not-found" forever — the one thing no local run could settle.
      await until("Bob's bridge finding and verifying the invitation", async () => {
        try {
          await bob().joinThread(
            documentId,
            threadRootMessageId,
            recipients,
            a,
            "yjs-paragraphs/1",
            true,
          );
          return true;
        } catch (error) {
          if (error instanceof InviteRejectedError && error.reason === "invite-not-found") {
            return undefined; // not delivered yet — or the provider rewrote its Message-ID
          }
          if (error instanceof InviteRejectedError) {
            throw new Error(describeInviteRejection(error.reason, error.sender).text);
          }
          throw error;
        }
      });
      target.record("pgpInvitationFoundAfterMs", Date.now() - invitedAt);
      target.record("pgpInvitationMessageIdPreservedByProvider", true); // it was found by exactly that id

      const keysView = await bob().pgpKeys(documentId);
      expect(keysView.enabled && keysView.gpgAvailable && keysView.entries).toMatchObject([
        { address: a, isCreator: true },
        { address: b, isYou: true, comparison: "match" },
      ]);

      const toBob = frame(3);
      await explaining(() => alice().send(documentId, a, toBob));
      const received = await until(
        "Alice's signed and encrypted edit arriving at Bob",
        async () => {
          const deliveries = await bob().receive(documentId, b);
          return deliveries.length > 0 ? deliveries : undefined;
        },
      );
      expect(received[0]?.payload).toBe(toBob);

      const toAlice = frame(5);
      await explaining(() => bob().send(documentId, b, toAlice));
      const back = await until("Bob's edit arriving at Alice", async () => {
        const deliveries = await alice().receive(documentId, a);
        return deliveries.length > 0 ? deliveries : undefined;
      });
      expect(back[0]?.payload).toBe(toAlice);

      // The armored block survived the provider: nothing was rejected, on either side.
      expect(await alice().integrityLog(documentId)).toEqual([]);
      expect(await bob().integrityLog(documentId)).toEqual([]);
    },
    SLOW,
  );

  if (process.env.L4_EMAIL_CONTRACT === "1") {
    const paceMs = Number(process.env.L4_EMAIL_PACE_MS ?? 0);
    for (const { name, run } of messengerPortContractCases) {
      it(
        `contract: ${name}`,
        async () => {
          logsOnFailure();
          if (paceMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, paceMs));
          }
          const documentId = `l4-contract-${counter++}-${Date.now()}`;
          const { threadRootMessageId, recipients } = await startThread(documentId, false);
          const a = target.alice().address;
          await bob().joinThread(
            documentId,
            threadRootMessageId,
            recipients,
            a,
            "yjs-paragraphs/1",
          );
          await run({
            documentId,
            creatorPort: alice(),
            creatorId: a,
            memberPort: bob(),
            memberId: target.bob().address,
          });
        },
        SLOW,
      );
    }
  }
}
