import { loggerFromEnv } from "@tdsp/bridge-log";
import { createGpgInvoker, type GpgInvoker, hasGpgAvailable } from "./gpg-invoke.ts";
import {
  createImapReceiver,
  createNodemailerSender,
  type MailReceiver,
  type MailSender,
} from "./mail-transport.ts";
import { createServer, type ServerDependencies } from "./server.ts";
import { createSyncState, type SyncState } from "./sync-state.ts";

// Entry point — run separately via
// `pnpm --filter @tdsp/email-bridge run start`, never bundled and never
// coupled to a browser application at build time, like the other bridges.
// Only ever talks to the browser over localhost HTTP at runtime.
const log = loggerFromEnv("email-bridge");
const port = Number(process.env.PORT ?? 8789);
const bindStorePath = process.env.EMAIL_BIND_STORE_PATH ?? "./credentials/tdsp-threads.json";

// The mailbox's own address — this bridge's MessengerPort MemberId and
// the From: on every outgoing message. AUTH_USER is separate and
// optional: it defaults to this address, the common case for most real
// providers, but some servers (Greenmail, for one) use an SMTP/IMAP login
// that differs from the mailbox address itself — see mail-transport.ts's
// own doc comment.
const address = process.env.ADDRESS;

const smtpHost = process.env.SMTP_HOST;
const smtpPort = Number(process.env.SMTP_PORT ?? 587);
const smtpSecure = process.env.SMTP_SECURE === "true";
const smtpAuthUser = process.env.SMTP_AUTH_USER || address;
const smtpPass = process.env.SMTP_PASS;

const imapHost = process.env.IMAP_HOST;
const imapPort = Number(process.env.IMAP_PORT ?? 993);
const imapSecure = process.env.IMAP_SECURE !== "false";
const imapAuthUser = process.env.IMAP_AUTH_USER || address;
const imapPass = process.env.IMAP_PASS;

// gpg's own availability is independent of SMTP/IMAP config — no
// mailbox credentials are needed to read the local keyring. A one-shot
// startup probe (mirroring bridges/signal-bridge's own hasSignalCli()),
// not a per-request check, so /pgp/status can report a plain, honest
// "not available" instead of a confusing per-request ENOENT.
const gpgPath = process.env.GPG_PATH;
const gnupgHome = process.env.GNUPGHOME;
let gpg: GpgInvoker | undefined;
if (hasGpgAvailable(gpgPath)) {
  gpg = createGpgInvoker({ gpgPath, gnupgHome });
}

// No SMTP/IMAP configured (it comes from the environment only) — /health
// still works and reports `configured: false`;
// anything touching a real mailbox fails loudly and clearly rather than
// with a confusing lower-level connection error.
let sender: MailSender | undefined;
let receiver: MailReceiver | undefined;
let sync: SyncState | undefined;

if (address && smtpHost && smtpAuthUser && smtpPass && imapHost && imapAuthUser && imapPass) {
  sender = createNodemailerSender({
    host: smtpHost,
    port: smtpPort,
    secure: smtpSecure,
    address,
    authUser: smtpAuthUser,
    pass: smtpPass,
  });
  receiver = createImapReceiver({
    host: imapHost,
    port: imapPort,
    secure: imapSecure,
    authUser: imapAuthUser,
    pass: imapPass,
  });
  sync = createSyncState(receiver, bindStorePath, gpg, log);
  // TLS is required for every host but this machine (tls-policy.ts), so this is
  // never "plaintext" for a real mailbox — logged so it can be seen, not assumed.
  log.info("mail-tls", { smtp: sender.tls, imap: receiver.tls });
}

const deps: ServerDependencies = {
  address,
  sender,
  receiver,
  sync,
  gpg,
  bindStorePath,
  logger: log,
};
const server = createServer(deps);

// 127.0.0.1 explicitly (SPECIFICATION.md LBI-1), not the default all-interfaces
// bind — same reasoning bridges/matrix-bridge's/bridges/signal-bridge's own
// index.ts already documents: this process answers unauthenticated
// requests and (once configured) holds real mailbox credentials.
server.listen(port, "127.0.0.1", () => {
  log.info("listening", { url: `http://localhost:${port}` });
});

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals): void => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  log.info("shutting-down", { signal });
  server.close(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
