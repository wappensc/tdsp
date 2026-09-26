/**
 * network-policy: configured-messenger-endpoint — Zone B (docs/network-policy.md).
 * The one place this bridge legitimately reaches a remote host: the
 * user-configured SMTP/IMAP mailbox (`SMTP_HOST`/`IMAP_HOST` in `.env`).
 * Mirrors `bridges/matrix-bridge/src/matrix-api.ts`'s identical grant for
 * the Matrix homeserver — email has no local-daemon equivalent to
 * `signal-cli` either, so this connection cannot be made loopback the
 * way `bridges/signal-bridge`'s is.
 */
import { ImapFlow } from "imapflow";
import { type AddressObject, simpleParser } from "mailparser";
import { createTransport } from "nodemailer";
import { DOCUMENT_HEADER, isValidMessageId } from "./envelope.ts";
import { TLS_OPTIONS, type TlsMode, tlsModeFor } from "./tls-policy.ts";

/**
 * The real SMTP/IMAP integration, behind small interfaces so `server.test.ts` can use
 * fakes — the same dependency-injection shape as `bridges/matrix-bridge`'s
 * `MatrixRoomReader`/`MatrixRoomWriter` and `bridges/signal-bridge`'s
 * `AuthStatusSource`. Verified against a real local Greenmail server, not just written
 * from the libraries' published types: a real send-then-search-then-fetch round trip
 * confirms the envelope, the custom header search and `mailparser`'s parsing.
 *
 * **The login is not the address.** One `user` field for both the SMTP AUTH/IMAP LOGIN
 * identity and the `From:` address is wrong for at least one real server: Greenmail's
 * `-Dgreenmail.users=alice:alicepass@example.org` creates a mailbox
 * `alice@example.org` whose login is the short name `alice` — `AUTH PLAIN` with the
 * full address fails with `535 Authentication credentials invalid`, and a `From:` set
 * to the bare login `alice` produces an invalid empty `MAIL FROM:<>`. So `authUser`
 * (defaulting to `address`, the common case) is separate from `address` (the `From:`
 * header and this bridge's own `MessengerPort` identity).
 */

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  /** `true`: implicit TLS. `false`: STARTTLS, **required** for any host but this machine — see `tls-policy.ts`. There is no setting that allows plaintext towards a remote host. */
  readonly secure: boolean;
  /** Only ever tightens: forces STARTTLS even towards this machine. Used by tests to prove the libraries refuse a server without it. */
  readonly requireTls?: boolean;
  /** The `From:` address and this bridge's own `MessengerPort` `MemberId` — not necessarily the same as `authUser`. */
  readonly address: string;
  /** The SMTP AUTH login — defaults to `address` at the call site when a provider's login genuinely is the email address itself. */
  readonly authUser: string;
  readonly pass: string;
}

export interface ImapConfig {
  readonly host: string;
  readonly port: number;
  /** As {@link SmtpConfig.secure}. */
  readonly secure: boolean;
  /** As {@link SmtpConfig.requireTls}. */
  readonly requireTls?: boolean;
  /** The IMAP LOGIN — see `SmtpConfig.authUser`'s doc comment; the two protocols' logins are configured independently since a real provider can in principle use different ones for each. */
  readonly authUser: string;
  readonly pass: string;
  /** The most of one message read from the server (BRG-13); `MAX_INCOMING_MAIL_BYTES` by default. */
  readonly maxMessageBytes?: number;
}

/**
 * The most of one incoming mail this bridge reads (SPECIFICATION.md BRG-13): above the
 * largest mail a frame within this binding's 4 MiB bound becomes (about 7.6 MiB, Appendix B),
 * below what a provider commonly accepts. Read with a partial IMAP fetch, so the server sends no
 * more than this; the MIME parser and `gpg` see only what fits, since decoding a body never
 * makes it larger.
 */
export const MAX_INCOMING_MAIL_BYTES = 10 * 1024 * 1024;

export interface OutgoingMail {
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly documentId: string;
  /** Sent as this message's own `Message-ID` instead of one generated at send time — how `startThread` lets the invite carry its own thread root. Must satisfy `isValidMessageId`. */
  readonly messageId?: string;
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
}

export interface MailSender {
  readonly address: string;
  /** How this connection is secured — reported by `GET /mail/status`. */
  readonly tls: TlsMode;
  send(mail: OutgoingMail): Promise<{ messageId: string }>;
  /** Connects and authenticates without sending anything; rejects with the server's own reason. */
  verify(): Promise<void>;
}

/** The exact `nodemailer` options a config produces — exported so a test can pin them. */
export function smtpTransportOptions(config: SmtpConfig) {
  const mode = tlsModeFor(config.host, config.secure, config.requireTls);
  return {
    host: config.host,
    port: config.port,
    secure: mode === "implicit",
    // With `secure: false`, nodemailer's default is *opportunistic* STARTTLS:
    // plaintext when the server does not offer it. `requireTLS` fails instead.
    requireTLS: mode === "starttls-required",
    tls: { ...TLS_OPTIONS },
    auth: { user: config.authUser, pass: config.pass },
  };
}

/**
 * The mail server accepted the message for some recipients and refused it for others
 * (SPECIFICATION.md TRN-6, EML-11). `nodemailer` counts that as sent; this bridge does not,
 * since a refused participant silently misses the change. `temporary` when every refusal was a
 * 4xx reply ("try again later"): a retry then sends the whole message again, and a participant
 * who already has it gets a second copy under a new Message-ID, which changes nothing (TRN-8).
 */
export class RecipientsRefusedError extends Error {
  readonly refused: readonly string[];
  readonly temporary: boolean;

  constructor(refused: readonly string[], temporary: boolean) {
    super(
      `the mail server refused ${refused.join(", ")}${temporary ? " for now" : ""}, and accepted the other recipients`,
    );
    this.name = "RecipientsRefusedError";
    this.refused = refused;
    this.temporary = temporary;
  }
}

/** What `sendMail` resolves with that matters here: who was refused, and each refusal's SMTP reply. */
interface SentInfo {
  readonly messageId: string;
  readonly rejected?: ReadonlyArray<string | { readonly address: string }>;
  readonly rejectedErrors?: ReadonlyArray<{ readonly responseCode?: number }>;
}

/** Throws `RecipientsRefusedError` unless the server accepted every recipient. */
export function requireEveryRecipient(info: SentInfo): void {
  const refused = (info.rejected ?? []).map((r) => (typeof r === "string" ? r : r.address));
  if (refused.length === 0) {
    return;
  }
  const codes = (info.rejectedErrors ?? []).map((error) => error.responseCode);
  const temporary =
    codes.length > 0 && codes.every((code) => code !== undefined && code >= 400 && code < 500);
  throw new RecipientsRefusedError(refused, temporary);
}

/** `nodemailer`'s own address list format accepts a comma-joined string — used instead of its `Address[]` shape since this bridge only ever deals in plain address strings. */
export function createNodemailerSender(
  config: SmtpConfig,
  /** The transport to send through; a test passes one that refuses chosen recipients. */
  transporter: {
    sendMail(options: object): Promise<SentInfo>;
    verify(): Promise<unknown>;
  } = createTransport(smtpTransportOptions(config)),
): MailSender {
  return {
    address: config.address,
    tls: tlsModeFor(config.host, config.secure, config.requireTls),
    async verify() {
      await transporter.verify();
    },
    async send(mail) {
      if (mail.messageId !== undefined && !isValidMessageId(mail.messageId)) {
        throw new Error(
          `refusing to send with a malformed Message-ID: ${JSON.stringify(mail.messageId)}`,
        );
      }
      const info = await transporter.sendMail({
        from: config.address,
        to: mail.to.join(", "),
        subject: mail.subject,
        text: mail.text,
        headers: { [DOCUMENT_HEADER]: mail.documentId },
        messageId: mail.messageId,
        inReplyTo: mail.inReplyTo,
        references: mail.references ? [...mail.references] : undefined,
      });
      requireEveryRecipient(info);
      return { messageId: info.messageId };
    },
  };
}

export interface IncomingMail {
  readonly messageId: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly text: string;
  /**
   * Larger than the bridge reads (BRG-13): only its IMAP envelope is known, `to`, `cc` and
   * `text` are empty, and it is rejected rather than parsed or decrypted.
   */
  readonly tooLarge?: true;
}

export interface MailReceiver {
  /** How this connection is secured — reported by `GET /mail/status`. */
  readonly tls: TlsMode;
  /** Connects, authenticates and opens the inbox without reading anything; rejects with the server's own reason. */
  verify(): Promise<void>;
  /**
   * Every message carrying `documentId` in the custom header, searched
   * fresh on every call — no persistent connection or IDLE subscription
   * (like `bridges/matrix-bridge`'s own `SyncState.pollOnce()`: driven by
   * each incoming `GET /deliveries` request, not a background timer).
   */
  fetchThreadMessages(documentId: string): Promise<readonly IncomingMail[]>;
}

function addressList(field: AddressObject | AddressObject[] | undefined): readonly string[] {
  if (!field) {
    return [];
  }
  const objects = Array.isArray(field) ? field : [field];
  return objects.flatMap((object) =>
    object.value
      .map((address) => address.address)
      .filter((address): address is string => typeof address === "string" && address.length > 0),
  );
}

/** The exact `imapflow` options a config produces — exported so a test can pin them. */
export function imapClientOptions(config: ImapConfig) {
  const mode = tlsModeFor(config.host, config.secure, config.requireTls);
  return {
    host: config.host,
    port: config.port,
    secure: mode === "implicit",
    // `undefined` (the library default) upgrades opportunistically and carries
    // on in plaintext when the server does not offer STARTTLS; `true` fails.
    // `false` — never upgrade — is only for a server on this machine.
    doSTARTTLS: mode === "implicit" ? undefined : mode === "starttls-required",
    tls: { ...TLS_OPTIONS },
    auth: { user: config.authUser, pass: config.pass },
    logger: false as const,
  };
}

/**
 * The account's own junk/spam folder, if it has one — found by the IMAP
 * SPECIAL-USE `\Junk` attribute (RFC 6154), never a hardcoded name. A
 * provider's own localized name for it (GMX: `Spamverdacht`) is exactly
 * what SPECIAL-USE exists to make irrelevant; `imapflow`'s `list()` also
 * falls back to matching well-known localized names itself when a server
 * predates the extension, so this still works even without it. A real
 * provider (GMX) files signed and encrypted document mail there instead of
 * `INBOX`; a bridge that searched only `INBOX` would never see it — not late,
 * just unsearched.
 */
async function junkMailboxPath(client: ImapFlow): Promise<string | undefined> {
  const mailboxes = await client.list();
  return mailboxes.find((mailbox) => mailbox.specialUse === "\\Junk")?.path;
}

async function fetchDocumentMessages(
  client: ImapFlow,
  mailbox: string,
  documentId: string,
  maxBytes: number,
): Promise<readonly IncomingMail[]> {
  const lock = await client.getMailboxLock(mailbox);
  try {
    // { uid: true } on both calls, deliberately -- without it, `search`
    // and `fetch` default to plain IMAP *sequence numbers*, which shift
    // on any concurrent mailbox mutation between the two calls (another
    // client, or a provider's own spam filter, moving or deleting any
    // message in this mailbox, not necessarily the one being searched
    // for). A UID never changes for a message's lifetime, so it survives
    // exactly that race: with sequence numbers, a second IMAP connection
    // moving one message into Junk makes an unrelated, concurrently
    // running fetch fail with "No such message" (verified against Greenmail).
    const uids = await client.search({ header: { [DOCUMENT_HEADER]: documentId } }, { uid: true });
    if (!uids || uids.length === 0) {
      return [];
    }
    const messages: IncomingMail[] = [];
    // One byte past the limit, so an oversized mail shows itself without being read whole.
    const query = { envelope: true, source: { maxLength: maxBytes + 1 } };
    for await (const message of client.fetch(uids, query, { uid: true })) {
      if (!message.source) {
        continue;
      }
      if (message.source.length > maxBytes) {
        messages.push({
          messageId: message.envelope?.messageId ?? "",
          from: message.envelope?.from?.[0]?.address ?? "",
          to: [],
          cc: [],
          text: "",
          tooLarge: true,
        });
        continue;
      }
      const parsed = await simpleParser(message.source);
      messages.push({
        messageId: parsed.messageId ?? "",
        from: parsed.from?.value[0]?.address ?? "",
        to: addressList(parsed.to),
        cc: addressList(parsed.cc),
        text: parsed.text ?? "",
      });
    }
    return messages;
  } finally {
    lock.release();
  }
}

export function createImapReceiver(config: ImapConfig): MailReceiver {
  return {
    tls: tlsModeFor(config.host, config.secure, config.requireTls),
    async verify() {
      const client = new ImapFlow(imapClientOptions(config));
      await client.connect();
      try {
        const lock = await client.getMailboxLock("INBOX");
        lock.release();
      } finally {
        await client.logout();
      }
    },
    async fetchThreadMessages(documentId) {
      const client = new ImapFlow(imapClientOptions(config));
      await client.connect();
      try {
        // A document's messages can arrive in more than one mailbox — a
        // provider's own spam filter routes some there regardless of
        // whether they are ever actually spam. seenMessageIds (sync-state.ts) already dedups
        // by Message-ID across every poll, so merging both mailboxes'
        // results needs no ordering care here.
        const maxBytes = config.maxMessageBytes ?? MAX_INCOMING_MAIL_BYTES;
        const inbox = await fetchDocumentMessages(client, "INBOX", documentId, maxBytes);
        const junk = await junkMailboxPath(client);
        const spam = junk ? await fetchDocumentMessages(client, junk, documentId, maxBytes) : [];
        return [...inbox, ...spam];
      } finally {
        await client.logout();
      }
    },
  };
}
