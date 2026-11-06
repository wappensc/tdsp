/**
 * network-policy: loopback-listener — Zone B (docs/network-policy.md). Inbound only,
 * bound to 127.0.0.1, CORS reflected only for loopback origins.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { type Logger, loggerFromEnv } from "@tdsp/bridge-log";
import { isLoopbackOrigin } from "@tdsp/loopback";
import type { Delivery } from "@tdsp/messenger-port";
import {
  type BindRecord,
  getBindRecord,
  heldParticipants,
  isRemoved,
  loadBindStore,
  recordRemoval,
  setBindRecord,
} from "./bind-store.ts";
import {
  canonicalMemberId,
  composeInviteBody,
  encodeEnvelope,
  encodeRemovalNotice,
  isPolicyText,
  isProfileText,
  isValidMessageId,
  normalizeAddress,
  subjectForDocument,
} from "./envelope.ts";
import type { GpgInvoker } from "./gpg-invoke.ts";
import { acceptInvite, createInvite } from "./invite.ts";
import { buildKeyReport } from "./key-report.ts";
import { commitKeyring, discardKeyring, keyringPathFor } from "./keyring-store.ts";
import {
  composeMail,
  type MailReceiver,
  type MailSender,
  type OutgoingMail,
  type SentCopyMode,
} from "./mail-transport.ts";
import { classifySendFailure } from "./send-failure.ts";
import type { SyncState } from "./sync-state.ts";
import { transportProfileFor } from "./transport-profile.ts";

/**
 * The email bridge's local HTTP interface (bindings/local-bridge-interface.md §12.6) — a standalone Node
 * process, never bundled, that owns the configured mailbox's SMTP/IMAP credentials so
 * the browser (through `packages/messenger-email`) never has to. Plain `node:http`
 * request/response, no framework dependency and no SSE/WebSocket, like the Matrix and
 * Signal bridges' servers.
 *
 * For a PGP-enabled document every outbound *protocol* message is signed with this
 * bridge's own key and encrypted to every other member's key — both taken from the
 * document's own keyring, which the creator's signed invitation defined — behind a
 * readiness guard that refuses outright, never degrading to unsigned or unencrypted,
 * when that keyring no longer holds what was pinned (`/pgp/status` reports that
 * readiness). The invitation is the one message that also carries readable text (the
 * invitation link) next to its signed block.
 *
 * Takes its dependencies as a parameter, like `bridges/matrix-bridge`'s
 * `ServerDependencies`: this module's own tests stay fast and CI-safe with fakes, while
 * separate, `hasTestEmailServer()`-gated suites exercise the real
 * `createNodemailerSender`/`createImapReceiver` against a real local Greenmail server.
 */
export interface ServerDependencies {
  readonly address: string | undefined;
  readonly sender: MailSender | undefined;
  readonly sync: SyncState | undefined;
  /** `undefined` when no `gpg` binary was found at bridge startup (`hasGpgAvailable()`) — `/pgp/status` then reports `gpgAvailable: false`; a PGP-enabled document can then neither send (409, needs-person) nor verify what it receives (rejected as `pgp-unavailable`), while PGP-off documents are unaffected. */
  readonly gpg: GpgInvoker | undefined;
  readonly bindStorePath: string;
  /** Reads the invitation a participant joins from. `undefined` while the mailbox is unconfigured. */
  readonly receiver?: MailReceiver | undefined;
  /** Who files a copy of each frame mail in the sent folder (EML-12); `append` by default. */
  readonly sentCopy?: SentCopyMode;
  /** Defaults to the environment-configured logger. */
  readonly logger?: Logger;
  /**
   * The epoch of this bridge's window, which `GET /health` names (TRN-19). Left out, a new one on
   * every start: the bridge keeps its window, and what its messenger handed it, only in memory, so
   * a restart may lose a delivery.
   */
  readonly instance?: string;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

/** Answers a failed send with the status that says what kind of failure it was. */
function sendSendFailure(res: ServerResponse, error: unknown): void {
  const failure = classifySendFailure(error);
  sendJson(
    res,
    failure.status,
    { error: error instanceof Error ? error.message : String(error) },
    failure.retryAfterSeconds === undefined
      ? {}
      : { "Retry-After": String(failure.retryAfterSeconds) },
  );
}

/**
 * The account this bridge serves, once it is provisioned with one (BRG-1): an address and a
 * mailbox to send through and read from. index.ts creates the sender only when the address
 * and every SMTP and IMAP setting are there, so the sender stands for the whole mailbox; a
 * test may leave out the reading half for a route that does not read. A document's PGP
 * setup is not part of it — a PGP-off document needs none — and is checked for each send by
 * `preparePgpSend`.
 */
function provisionedAccount(
  deps: ServerDependencies,
): { readonly address: string; readonly sender: MailSender } | undefined {
  return deps.address === undefined || deps.sender === undefined
    ? undefined
    : { address: deps.address, sender: deps.sender };
}

/**
 * Refuses a document operation of a bridge that is not provisioned, before anything else is
 * looked at, distinguishably (BRG-1): 409, which an adapter maps to `needs-person` (LBI-6).
 * Only the person ends this state, by configuring the mailbox: a 503 would have the engine
 * send again and again into it, a 403 would have it drop a change that goes out once they did.
 */
function refuseUnprovisioned(res: ServerResponse): void {
  sendJson(res, 409, {
    error:
      "email-bridge is not provisioned yet — set ADDRESS and the SMTP_* and IMAP_* variables, then restart it",
  });
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function deliveryToJson(delivery: Delivery): unknown {
  return delivery; // the payload is the frame's text, carried as a JSON string
}

interface PgpSendReady {
  readonly blocked?: undefined;
  /** Absent for a PGP-off document: its messages go out as plain JSON. */
  readonly pgp?: {
    readonly keyring: GpgInvoker;
    readonly signer: string;
    readonly recipientFingerprints: readonly string[];
  };
}

type PgpSendPlan =
  | PgpSendReady
  | {
      readonly blocked: {
        readonly status: number;
        readonly error: string;
        /** Members whose key is absent from the document's keyring — only set for that reason. */
        readonly missingKeysFor?: readonly string[];
      };
      readonly pgp?: undefined;
    };

/**
 * The body of an outbound protocol message — a frame's envelope, or a removal notice
 * (EML-14): its JSON as-is for a PGP-off document; for a PGP-enabled one, that same JSON
 * signed with this bridge's own key and encrypted to every member the plan names, through the
 * document's own keyring (bindings/email.md EML-3, EML-4). The single place signing and
 * encryption happen, so no send route can forget to.
 */
async function buildMessageText(json: string, plan: PgpSendReady): Promise<string> {
  if (plan.pgp === undefined) {
    return json;
  }
  return plan.pgp.keyring.signAndEncrypt(json, plan.pgp.signer, plan.pgp.recipientFingerprints);
}

/**
 * The pre-send guard (bindings/email.md EML-3), shared by every route that sends a
 * protocol message, and the place each recipient's *exact key* is decided:
 * that key is the fingerprint pinned for the member from the creator's
 * invitation, and it must be in the **document's own keyring** — never
 * resolved from the user's own keyring, never guessed from an address. A
 * PGP-enabled document is blocked from sending at all — not sent unsigned,
 * not sent unencrypted — unless this bridge holds the secret key it signs
 * with and the document keyring still holds every other member's pinned key
 * (it can only lack one if the file was damaged or removed). A PGP-off
 * document is never checked, whatever `gpg` happens to be installed.
 *
 * `participants` is who the message is encrypted to, this address included: the set the
 * bridge holds (EML-14). A removal notice is planned before the removal is recorded, so it is
 * encrypted to the set before it, the removed participant included.
 */
async function preparePgpSend(
  deps: ServerDependencies,
  documentId: string,
  bound: BindRecord,
  participants: readonly string[],
): Promise<PgpSendPlan> {
  if (!bound.pgpEnabled) {
    return {};
  }
  // For PGP the account includes gpg and the person's own secret key (bindings/email.md,
  // "Account"). Each refusal below that only the person lifts is needs-person, 409 (TRN-11):
  // gpg is found once, when the bridge starts, so only the person installing it (or setting
  // GPG_PATH) and restarting the bridge ends its absence — never waiting, as a 503 implied.
  if (deps.gpg === undefined || deps.address === undefined) {
    return {
      blocked: {
        status: 409,
        error: `${documentId} has PGP enabled, but this bridge has no gpg binary configured — install gpg or set GPG_PATH, then restart the bridge`,
      },
    };
  }
  // A document's own keyring that is missing, or lacks a pinned key, stays rejected, 422: its
  // keys came from the creator's signed invitation (EML-4), which nothing the person imports
  // into their own keyring replaces.
  if (bound.keyringPath === undefined || bound.ownFingerprint === undefined) {
    return {
      blocked: {
        status: 422,
        error: `${documentId} has no PGP keyring of its own, so its keys cannot be verified — start a new document`,
      },
    };
  }
  // The key the document pins for this address, missing from the person's keyring: importing
  // it lifts the refusal, so it is not rejected — that would drop the change for good.
  if (!(await deps.gpg.hasSecretKey(bound.ownFingerprint))) {
    return {
      blocked: {
        status: 409,
        error: `no PGP secret key ${bound.ownFingerprint} for ${deps.address} in this bridge's keyring — cannot sign for ${documentId}, refusing to send`,
      },
    };
  }
  const keyring = deps.gpg.withKeyring(bound.keyringPath);
  const missing: string[] = [];
  const recipientFingerprints: string[] = [];
  // Encrypted to this address's own key too: another device of it opens the copy in the sent
  // folder (bindings/email.md EML-12).
  for (const address of participants) {
    const pinned = bound.pinnedFingerprints[normalizeAddress(address)];
    // Sequential, not Promise.all: keeps this loop from spawning
    // `participants.length` gpg processes at once per send.
    const held = pinned === undefined ? [] : await keyring.listKeys(address);
    if (
      pinned === undefined ||
      !held.some((key) => key.fingerprint.toUpperCase() === pinned.toUpperCase())
    ) {
      missing.push(address);
      continue;
    }
    recipientFingerprints.push(pinned.toUpperCase());
  }
  if (missing.length > 0) {
    return {
      blocked: {
        status: 422,
        error: `the document's keyring no longer holds the key pinned for ${missing.join(", ")} — refusing to send`,
        missingKeysFor: missing,
      },
    };
  }
  return { pgp: { keyring, signer: bound.ownFingerprint, recipientFingerprints } };
}

/**
 * The removals this bridge already holds for the very thread a join names, to keep in the record
 * the join writes: joining the thread again, as an application does to resume a document, must
 * not add back anyone the creator removed (EML-1, EML-14).
 */
function removalsKept(
  existing: BindRecord | undefined,
  threadRootMessageId: string,
): Pick<BindRecord, "removed"> {
  return existing?.threadRootMessageId === threadRootMessageId &&
    existing.removed !== undefined &&
    existing.removed.length > 0
    ? { removed: existing.removed }
    : {};
}

function sameAddressSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a.map(normalizeAddress));
  const right = new Set(b.map(normalizeAddress));
  return left.size === right.size && [...left].every((address) => right.has(address));
}

/**
 * Logs where the user's own keyring disagrees with the creator's key set, once,
 * when a document is joined (the live view is `GET /pgp/keys`). A different key
 * is a warning — it is what impersonation, or one side's mistake, looks like;
 * a missing one is not, except for the creator, whose missing key means
 * nothing independent backs the invitation's authenticity. Never throws: a
 * comparison that fails must not undo a join that succeeded.
 */
async function logKeyDisagreements(
  logger: Logger,
  gpg: GpgInvoker,
  ownAddress: string,
  documentId: string,
  record: BindRecord,
): Promise<void> {
  try {
    const report = await buildKeyReport(gpg, record, ownAddress);
    for (const entry of report.entries) {
      if (entry.comparison === "different-locally") {
        logger.warn("key-deviation", {
          documentId,
          address: entry.address,
          creatorSent: entry.fingerprint,
          inYourKeyring: entry.localFingerprints.join(","),
        });
      } else if (entry.comparison === "missing-locally" && entry.isCreator && !entry.isYou) {
        logger.warn("creator-key-unverified", {
          documentId,
          creator: entry.address,
          fingerprint: entry.fingerprint,
        });
      }
    }
  } catch (error) {
    logger.warn("key-comparison-failed", {
      documentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Why the user's own keyring contradicts the invitation's key for the creator, or `undefined`
 * when it does not — it holds the same key, or none (then nothing independent backs the
 * invitation, which `logKeyDisagreements` reports as `creator-key-unverified`). The joiner's
 * own key is not asked about: it is checked by the invitation being decryptable at all.
 */
async function creatorKeyDisagrees(
  gpg: GpgInvoker,
  ownAddress: string,
  record: BindRecord,
): Promise<string | undefined> {
  const report = await buildKeyReport(gpg, record, ownAddress);
  const creator = report.entries.find((entry) => entry.isCreator && !entry.isYou);
  if (creator?.comparison !== "different-locally") {
    return undefined;
  }
  return `your keyring holds ${creator.localFingerprints.join(", ")} for ${creator.address}, the invitation names ${creator.fingerprint}`;
}

const DEFAULT_INVITE_TEXT =
  "You've been invited to collaborate on a shared document. Open your collaboration app " +
  "and use the document id and creator address from this email to join.";

interface StartThreadRequestBody {
  /** Optional — the invite's own `Message-ID`, chosen by the caller so the invite text can contain a complete invitation link (SPECIFICATION.md §11.3). */
  threadRootMessageId?: unknown;
  recipients?: unknown;
  creator?: unknown;
  profile?: unknown;
  inviteText?: unknown;
  pgpEnabled?: unknown;
  /** The creator's initial send policy, an opaque short text (SPECIFICATION.md §11.2). Carried in the signed invitation of a PGP-enabled document. */
  policy?: unknown;
}

interface JoinThreadRequestBody {
  threadRootMessageId?: unknown;
  recipients?: unknown;
  creator?: unknown;
  profile?: unknown;
  pgpEnabled?: unknown;
}

interface SendRequestBody {
  sender?: unknown;
  payload?: unknown;
}

interface RemoveRequestBody {
  actor?: unknown;
  participant?: unknown;
}

/**
 * Files the copy of a mail just sent in the sent folder, which this address's other devices read
 * (EML-12). The mail is out either way: a failed copy is logged, never reported as a failed
 * send, which would send it again.
 */
async function fileSentCopy(
  deps: ServerDependencies,
  logger: Logger,
  account: { readonly address: string },
  mail: OutgoingMail,
  messageId: string,
): Promise<void> {
  if ((deps.sentCopy ?? "append") !== "append" || !deps.receiver?.storeSentCopy) {
    return;
  }
  try {
    await deps.receiver.storeSentCopy(await composeMail(account.address, mail, messageId));
  } catch (error) {
    logger.warn("sent-copy-failed", {
      documentId: mail.documentId,
      messageId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function createServer(deps: ServerDependencies): Server {
  const instance = deps.instance ?? randomUUID();
  const logger = deps.logger ?? loggerFromEnv("email-bridge");
  return createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    if (typeof origin === "string" && isLoopbackOrigin(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type");

    const { method, url = "" } = req;
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const [path, query = ""] = url.split("?", 2);

    if (method === "GET" && path === "/health") {
      sendJson(res, 200, {
        status: "ok",
        configured: provisionedAccount(deps) !== undefined,
        instance,
      });
      return;
    }

    if (method === "GET" && path === "/whoami") {
      if (deps.address === undefined) {
        sendJson(res, 409, {
          error:
            "email-bridge is not configured yet — set ADDRESS and the SMTP_* and IMAP_* variables",
        });
        return;
      }
      // {id}, as every bridge's /whoami answers (bindings/local-bridge-interface.md §12.6);
      // deps.address stays this bridge's own configuration vocabulary.
      sendJson(res, 200, { id: normalizeAddress(deps.address) });
      return;
    }

    // A thread is this binding's channel, named by its root Message-ID; its members are the
    // participant set it started with less those the creator removed (EML-1, EML-14), as this
    // bridge holds it (TRN-17). A thread this mailbox was removed from is one it is not in.
    if (method === "GET" && path === "/members") {
      const channelId = new URLSearchParams(query).get("channelId");
      if (channelId === null || channelId === "") {
        sendJson(res, 400, { error: "channelId is required" });
        return;
      }
      const thread = Object.values(loadBindStore(deps.bindStorePath)).find(
        (record) => record.threadRootMessageId === channelId,
      );
      if (thread === undefined || (deps.address !== undefined && isRemoved(thread, deps.address))) {
        sendJson(res, 404, { error: `this mailbox holds no thread ${channelId}` });
        return;
      }
      sendJson(res, 200, heldParticipants(thread).map(normalizeAddress));
      return;
    }

    if (method === "GET" && path === "/transport-profile") {
      // SPECIFICATION.md §3.5: the send policies and hard bounds a client should use with
      // this bridge. Which profile depends on what is behind it (a local test mail
      // server has no limit, a provider does), so an unconfigured bridge cannot say.
      if (deps.sender === undefined) {
        sendJson(res, 503, { error: "email-bridge is not configured yet" });
        return;
      }
      sendJson(res, 200, transportProfileFor(deps.sender.tls));
      return;
    }

    if (method === "GET" && path === "/mail/status") {
      // Connects and authenticates to the real mail server, sending nothing —
      // the first thing to look at when a mailbox will not work, and the check
      // an L4 run makes before it does anything else. Reports how each
      // connection is secured (TLS is required for every host but this
      // machine, tls-policy.ts) so that a user can see it, not just be told.
      const { sender, receiver, address } = deps;
      if (sender === undefined || receiver === undefined || address === undefined) {
        sendJson(res, 200, { configured: false });
        return;
      }
      const check = async (verify: () => Promise<void>) => {
        try {
          await verify();
          return { ok: true } as const;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, error: message.slice(0, 300) } as const;
        }
      };
      Promise.all([check(() => sender.verify()), check(() => receiver.verify())])
        .then(([smtp, imap]) =>
          sendJson(res, 200, {
            configured: true,
            address,
            smtp: { ...smtp, tls: sender.tls },
            imap: { ...imap, tls: receiver.tls },
          }),
        )
        .catch((error: unknown) => {
          sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
        });
      return;
    }

    if (method === "GET" && path === "/pgp/status") {
      const documentId = new URLSearchParams(query).get("documentId");
      if (!documentId) {
        sendJson(res, 400, { error: "documentId query parameter is required" });
        return;
      }
      const bound = getBindRecord(deps.bindStorePath, documentId);
      if (!bound) {
        sendJson(res, 404, { error: `${documentId} has no thread started yet` });
        return;
      }
      // The document's own state, not merely whether gpg is installed:
      // `enabled` is whether *this document* has PGP on, `gpgAvailable`
      // whether this bridge found a binary, and `sendBlockedReason` — the
      // exact reason the pre-send guard would refuse right now (missing or
      // ambiguous or swapped key, no secret key, no gpg), so an application
      // can show it *before* an attempt rather than only after one fails.
      const gpgAvailable = deps.gpg !== undefined;
      if (!bound.pgpEnabled) {
        sendJson(res, 200, {
          enabled: false,
          gpgAvailable,
          missingKeysFor: [],
          sendBlockedReason: null,
        });
        return;
      }
      preparePgpSend(deps, documentId, bound, heldParticipants(bound))
        .then((plan) => {
          sendJson(res, 200, {
            enabled: true,
            gpgAvailable,
            missingKeysFor: plan.blocked?.missingKeysFor ?? [],
            sendBlockedReason: plan.blocked?.error ?? null,
          });
        })
        .catch((error: unknown) => {
          sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
        });
      return;
    }

    if (method === "GET" && path === "/pgp/keys") {
      const documentId = new URLSearchParams(query).get("documentId");
      if (!documentId) {
        sendJson(res, 400, { error: "documentId query parameter is required" });
        return;
      }
      const bound = getBindRecord(deps.bindStorePath, documentId);
      if (!bound) {
        sendJson(res, 404, { error: `${documentId} has no thread started yet` });
        return;
      }
      if (!bound.pgpEnabled) {
        sendJson(res, 200, { enabled: false });
        return;
      }
      if (deps.gpg === undefined || deps.address === undefined) {
        sendJson(res, 200, { enabled: true, gpgAvailable: false });
        return;
      }
      if (bound.ownFingerprint === undefined) {
        sendJson(res, 409, {
          error: `${documentId} has no PGP keyring of its own — start a new document`,
        });
        return;
      }
      // The comparison with the user's own keyring is recomputed on every
      // request, so a key they import afterwards clears its warning.
      buildKeyReport(deps.gpg, bound, deps.address)
        .then((report) => sendJson(res, 200, { enabled: true, gpgAvailable: true, ...report }))
        .catch((error: unknown) => {
          sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
        });
      return;
    }

    const startThreadMatch = method === "POST" ? /^\/threads\/([^/]+)$/.exec(path ?? "") : null;
    if (startThreadMatch) {
      const documentId = decodeURIComponent(startThreadMatch[1] as string);
      const account = provisionedAccount(deps);
      if (account === undefined) {
        refuseUnprovisioned(res);
        return;
      }
      readJsonBody(req)
        .then(async (rawBody) => {
          const body = rawBody as StartThreadRequestBody;
          if (
            !Array.isArray(body.recipients) ||
            body.recipients.length === 0 ||
            !body.recipients.every((r) => typeof r === "string" && r.length > 0)
          ) {
            sendJson(res, 400, { error: "recipients must be a non-empty array of addresses" });
            return;
          }
          if (typeof body.creator !== "string" || body.creator.length === 0) {
            sendJson(res, 400, { error: "creator must be a non-empty string" });
            return;
          }
          if (!isProfileText(body.profile)) {
            sendJson(res, 400, {
              error: "profile must be a document profile id such as yjs-paragraphs/1",
            });
            return;
          }
          if (body.inviteText !== undefined && typeof body.inviteText !== "string") {
            sendJson(res, 400, { error: "inviteText must be a string if present" });
            return;
          }
          if (body.pgpEnabled !== undefined && typeof body.pgpEnabled !== "boolean") {
            sendJson(res, 400, { error: "pgpEnabled must be a boolean if present" });
            return;
          }
          if (
            body.threadRootMessageId !== undefined &&
            !isValidMessageId(body.threadRootMessageId)
          ) {
            sendJson(res, 400, {
              error:
                "threadRootMessageId must be a Message-ID of the form <local@domain> if present",
            });
            return;
          }
          if (body.policy !== undefined && !isPolicyText(body.policy)) {
            sendJson(res, 400, { error: "policy must be a short policy text if present" });
            return;
          }
          // MemberIds in their one canonical form (bindings/email.md EML-10): the
          // engine compares bytes, so Alice@Example.org and alice@example.org must never
          // arrive as two people, nor two participants collapse into one unnoticed.
          // Object.assign, not assignment: it keeps what the checks above established.
          const canonicalRecipients = body.recipients.map(canonicalMemberId);
          const canonicalCreator = canonicalMemberId(body.creator);
          const notBare = [
            ...body.recipients.filter((_, i) => canonicalRecipients[i] === undefined),
            ...(canonicalCreator === undefined ? [body.creator] : []),
          ];
          if (notBare.length > 0) {
            sendJson(res, 400, {
              error: `a participant must be a bare address such as alice@example.org, without a display name or angle brackets: ${JSON.stringify(notBare[0])}`,
            });
            return;
          }
          Object.assign(body, { recipients: canonicalRecipients, creator: canonicalCreator });
          if (new Set(body.recipients).size !== body.recipients.length) {
            sendJson(res, 400, {
              error: "two participants are the same address once letter case is ignored",
            });
            return;
          }
          if (!body.recipients.includes(body.creator)) {
            sendJson(res, 400, { error: "creator must be one of recipients" });
            return;
          }
          const recipients: readonly string[] = body.recipients;
          const pgpEnabled = body.pgpEnabled ?? false;
          let inviteBody = body.inviteText ?? DEFAULT_INVITE_TEXT;
          let pgpFields: Pick<
            BindRecord,
            "pinnedFingerprints" | "keyringPath" | "ownFingerprint" | "policy"
          > = { pinnedFingerprints: {} };
          let pendingKeyringPath: string | undefined;
          if (pgpEnabled) {
            // A PGP-enabled document the creator cannot even send into is
            // refused *before* the invitation goes out; otherwise a started
            // thread and a sent invitation would be left behind an error,
            // with nothing the creator could open.
            if (deps.gpg === undefined || deps.address === undefined) {
              sendJson(res, 503, {
                error: `cannot start a PGP-enabled document: ${documentId} has PGP enabled, but this bridge has no gpg binary configured`,
              });
              return;
            }
            if (normalizeAddress(body.creator) !== normalizeAddress(deps.address)) {
              // The invitation is signed with this bridge's own key; everyone
              // checks that signature against the *creator's* key.
              sendJson(res, 400, {
                error: `cannot start a PGP-enabled document: its creator must be this bridge's own address (${deps.address}), not ${body.creator}`,
              });
              return;
            }
            // the creator chooses every participant's key, once, and
            // sends the whole set in one block she signs and encrypts.
            const invite = await createInvite({
              documentId,
              ownAddress: deps.address,
              recipients,
              profile: body.profile,
              gpg: deps.gpg,
              bindStorePath: deps.bindStorePath,
              ...(body.policy === undefined ? {} : { policy: body.policy }),
            });
            if (!invite.ok) {
              sendJson(res, invite.status, {
                error: `cannot start a PGP-enabled document: ${invite.error}`,
              });
              return;
            }
            inviteBody = composeInviteBody(inviteBody, invite.armored);
            pendingKeyringPath = invite.pendingKeyringPath;
            pgpFields = {
              pinnedFingerprints: invite.pinnedFingerprints,
              keyringPath: keyringPathFor(deps.bindStorePath, documentId),
              ownFingerprint: invite.ownFingerprint,
              ...(body.policy === undefined ? {} : { policy: body.policy }),
            };
          }
          const to = recipients.filter((r) => r !== body.creator);
          let messageId: string;
          try {
            ({ messageId } = await account.sender.send({
              to,
              subject: subjectForDocument(documentId),
              text: inviteBody,
              documentId,
              ...(body.threadRootMessageId === undefined
                ? {}
                : { messageId: body.threadRootMessageId }),
            }));
          } catch (error) {
            if (pendingKeyringPath !== undefined) {
              discardKeyring(pendingKeyringPath);
            }
            throw error;
          }
          if (pendingKeyringPath !== undefined && pgpFields.keyringPath !== undefined) {
            commitKeyring(pendingKeyringPath, pgpFields.keyringPath);
          }
          const record: BindRecord = {
            recipients,
            creatorMemberId: body.creator,
            profile: body.profile,
            threadRootMessageId: messageId,
            createdAt: new Date().toISOString(),
            pgpEnabled,
            ...pgpFields,
          };
          setBindRecord(deps.bindStorePath, documentId, record);
          sendJson(res, 200, { threadRootMessageId: messageId });
        })
        .catch((error: unknown) => {
          sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
        });
      return;
    }

    const joinThreadMatch =
      method === "POST" ? /^\/threads\/([^/]+)\/join$/.exec(path ?? "") : null;
    if (joinThreadMatch) {
      const documentId = decodeURIComponent(joinThreadMatch[1] as string);
      if (provisionedAccount(deps) === undefined) {
        refuseUnprovisioned(res);
        return;
      }
      readJsonBody(req)
        .then(async (rawBody) => {
          const body = rawBody as JoinThreadRequestBody;
          if (
            !Array.isArray(body.recipients) ||
            body.recipients.length === 0 ||
            !body.recipients.every((r) => typeof r === "string" && r.length > 0)
          ) {
            sendJson(res, 400, { error: "recipients must be a non-empty array of addresses" });
            return;
          }
          if (typeof body.creator !== "string" || body.creator.length === 0) {
            sendJson(res, 400, { error: "creator must be a non-empty string" });
            return;
          }
          if (!isProfileText(body.profile)) {
            sendJson(res, 400, {
              error: "profile must be a document profile id such as yjs-paragraphs/1",
            });
            return;
          }
          // MemberIds in their one canonical form (bindings/email.md EML-10): the
          // engine compares bytes, so Alice@Example.org and alice@example.org must never
          // arrive as two people, nor two participants collapse into one unnoticed.
          // Object.assign, not assignment: it keeps what the checks above established.
          const canonicalRecipients = body.recipients.map(canonicalMemberId);
          const canonicalCreator = canonicalMemberId(body.creator);
          const notBare = [
            ...body.recipients.filter((_, i) => canonicalRecipients[i] === undefined),
            ...(canonicalCreator === undefined ? [body.creator] : []),
          ];
          if (notBare.length > 0) {
            sendJson(res, 400, {
              error: `a participant must be a bare address such as alice@example.org, without a display name or angle brackets: ${JSON.stringify(notBare[0])}`,
            });
            return;
          }
          Object.assign(body, { recipients: canonicalRecipients, creator: canonicalCreator });
          if (new Set(body.recipients).size !== body.recipients.length) {
            sendJson(res, 400, {
              error: "two participants are the same address once letter case is ignored",
            });
            return;
          }
          if (!body.recipients.includes(body.creator)) {
            sendJson(res, 400, { error: "creator must be one of recipients" });
            return;
          }
          if (body.pgpEnabled !== undefined && typeof body.pgpEnabled !== "boolean") {
            sendJson(res, 400, { error: "pgpEnabled must be a boolean if present" });
            return;
          }
          // Stored, and later sent as In-Reply-To/References on every outgoing
          // message — and it can come from a invitation link someone else crafted.
          if (!isValidMessageId(body.threadRootMessageId)) {
            sendJson(res, 400, {
              error: "threadRootMessageId must be a Message-ID of the form <local@domain>",
            });
            return;
          }
          // No email is sent here — the creator's own startThread() call
          // already sent the one invite email; this just registers this
          // bridge's own bind-store entry for the same, already-existing
          // thread. For a PGP-off document nothing can be checked (email has
          // no server-side membership to validate this against, unlike
          // Matrix's/Signal's own bind()), so the link is taken as given.
          const pgpEnabled = body.pgpEnabled ?? false;
          // The creator's signed initial policy, for a PGP document's join to report
          // back; a plain document has none inside a signature.
          let joinedPolicy: string | undefined;
          const kept = removalsKept(
            getBindRecord(deps.bindStorePath, documentId),
            body.threadRootMessageId,
          );
          if (!pgpEnabled) {
            setBindRecord(deps.bindStorePath, documentId, {
              recipients: body.recipients,
              ...kept,
              creatorMemberId: body.creator,
              profile: body.profile,
              threadRootMessageId: body.threadRootMessageId,
              createdAt: new Date().toISOString(),
              pgpEnabled: false,
              pinnedFingerprints: {},
            });
          } else {
            // a PGP-enabled document is joined by *reading the
            // creator's signed invitation* — the link's own fields are only
            // what the participant expects to find in it.
            if (
              deps.gpg === undefined ||
              deps.address === undefined ||
              deps.receiver === undefined
            ) {
              sendJson(res, 503, {
                error: `${documentId} has PGP enabled, but this bridge has no gpg binary or mailbox configured to read its invitation with`,
              });
              return;
            }
            // Already bound to this very thread — the creator reopening her own
            // document (her invitation is in her Sent folder, never her inbox),
            // or a participant resuming one they joined — so there is nothing to
            // read or verify again, and rebuilding the keyring would only throw
            // away state. Anything that differs from what is on file (another
            // thread, another creator, other participants) is a different join
            // and goes through the full acceptance below.
            const existing = getBindRecord(deps.bindStorePath, documentId);
            if (
              existing?.pgpEnabled &&
              existing.keyringPath !== undefined &&
              existsSync(existing.keyringPath) &&
              existing.threadRootMessageId === body.threadRootMessageId &&
              normalizeAddress(existing.creatorMemberId) === normalizeAddress(body.creator) &&
              sameAddressSet(existing.recipients, body.recipients)
            ) {
              sendJson(res, 200, {
                documentId,
                threadRootMessageId: body.threadRootMessageId,
                ...(existing.policy === undefined ? {} : { policy: existing.policy }),
              });
              return;
            }
            const result = await acceptInvite({
              documentId,
              threadRootMessageId: body.threadRootMessageId,
              ownAddress: deps.address,
              expected: {
                creator: body.creator,
                recipients: body.recipients,
                profile: body.profile,
              },
              gpg: deps.gpg,
              receiver: deps.receiver,
              bindStorePath: deps.bindStorePath,
            });
            if (!result.ok) {
              logger.warn("invite-rejected", {
                reason: result.reason,
                documentId,
                messageId: body.threadRootMessageId,
                sender: result.sender ?? "",
                detail: result.error,
              });
              sendJson(res, result.reason === "invite-not-found" ? 404 : 422, {
                error: `invitation rejected (${result.reason}): ${result.error}`,
                reason: result.reason,
                ...(result.sender === undefined ? {} : { sender: result.sender }),
              });
              return;
            }
            const accepted = result.accepted;
            const record: BindRecord = {
              recipients: accepted.recipients,
              ...kept,
              creatorMemberId: accepted.creator,
              profile: accepted.profile,
              threadRootMessageId: body.threadRootMessageId,
              createdAt: new Date().toISOString(),
              pgpEnabled: true,
              pinnedFingerprints: accepted.pinnedFingerprints,
              keyringPath: accepted.keyringPath,
              ownFingerprint: accepted.ownFingerprint,
              ...(accepted.policy === undefined ? {} : { policy: accepted.policy }),
            };
            // The one independent check a joiner has on the invitation (EML-8): a key the user's
            // own keyring holds for the creator's address must be the creator's key the
            // invitation names. Refused, not warned — the keys of the whole document would come
            // from an invitation the joiner's own records contradict.
            const creatorKeyDiffers = await creatorKeyDisagrees(deps.gpg, deps.address, record);
            if (creatorKeyDiffers !== undefined) {
              discardKeyring(accepted.keyringPath);
              logger.warn("invite-rejected", {
                reason: "invite-creator-key-differs",
                documentId,
                messageId: body.threadRootMessageId,
                sender: accepted.creator,
                detail: creatorKeyDiffers,
              });
              sendJson(res, 422, {
                error: `invitation rejected (invite-creator-key-differs): ${creatorKeyDiffers}`,
                reason: "invite-creator-key-differs",
                sender: accepted.creator,
              });
              return;
            }
            setBindRecord(deps.bindStorePath, documentId, record);
            await logKeyDisagreements(logger, deps.gpg, deps.address, documentId, record);
            joinedPolicy = accepted.policy;
          }
          sendJson(res, 200, {
            documentId,
            threadRootMessageId: body.threadRootMessageId,
            ...(joinedPolicy === undefined ? {} : { policy: joinedPolicy }),
          });
        })
        .catch((error: unknown) => {
          sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
        });
      return;
    }

    // The creator removes a participant from the thread (EML-14): a notice into the thread,
    // addressed and, with PGP, encrypted to the set before the removal, so the removed
    // participant learns of it too; then the set this bridge holds shrinks, for good.
    const removeMatch = method === "POST" ? /^\/threads\/([^/]+)\/remove$/.exec(path ?? "") : null;
    if (removeMatch) {
      const documentId = decodeURIComponent(removeMatch[1] as string);
      const account = provisionedAccount(deps);
      if (account === undefined) {
        refuseUnprovisioned(res);
        return;
      }
      readJsonBody(req)
        .then(async (rawBody) => {
          const body = rawBody as RemoveRequestBody;
          if (typeof body.actor !== "string" || body.actor.length === 0) {
            sendJson(res, 400, { error: "actor must be a non-empty string" });
            return;
          }
          if (typeof body.participant !== "string" || body.participant.length === 0) {
            sendJson(res, 400, { error: "participant must be a non-empty string" });
            return;
          }
          const bound = getBindRecord(deps.bindStorePath, documentId);
          if (!bound) {
            sendJson(res, 404, { error: `${documentId} has no thread started yet` });
            return;
          }
          const self = normalizeAddress(account.address);
          const creator = normalizeAddress(bound.creatorMemberId);
          // Only the creator removes, and only through her own bridge (EML-14, BRG-16).
          if (canonicalMemberId(body.actor) !== self || self !== creator) {
            sendJson(res, 403, {
              error: `only the creator of ${documentId}, through her own bridge, removes a participant`,
            });
            return;
          }
          const participant = canonicalMemberId(body.participant);
          const held = heldParticipants(bound);
          if (
            participant === undefined ||
            participant === creator ||
            !held.some((address) => normalizeAddress(address) === participant)
          ) {
            sendJson(res, 403, {
              error: `${body.participant} is not a participant of ${documentId} other than its creator`,
            });
            return;
          }
          // The set before the removal: the notice reaches the removed participant too.
          const plan = await preparePgpSend(deps, documentId, bound, held);
          if (plan.blocked) {
            sendJson(res, plan.blocked.status, { error: plan.blocked.error });
            return;
          }
          const mail = {
            to: held.filter((r) => normalizeAddress(r) !== self),
            subject: subjectForDocument(documentId),
            text: await buildMessageText(
              encodeRemovalNotice({ tdsp: 1, kind: "remove", documentId, participant }),
              plan,
            ),
            documentId,
            inReplyTo: bound.threadRootMessageId,
            references: [bound.threadRootMessageId],
          };
          const { messageId } = await account.sender.send(mail);
          // This address's other devices learn of the removal from the copy (EML-12).
          await fileSentCopy(deps, logger, account, mail, messageId);
          recordRemoval(deps.bindStorePath, documentId, participant);
          sendJson(res, 200, { messageId });
        })
        .catch((error: unknown) => sendSendFailure(res, error));
      return;
    }

    const sendMatch = method === "POST" ? /^\/channels\/([^/]+)\/send$/.exec(path ?? "") : null;
    if (sendMatch) {
      const documentId = decodeURIComponent(sendMatch[1] as string);
      // First, before the sender is compared with an address there may not be (BRG-16): a
      // bridge with no mailbox refuses as needs-person, whatever the request says (BRG-1).
      const account = provisionedAccount(deps);
      if (account === undefined) {
        refuseUnprovisioned(res);
        return;
      }
      readJsonBody(req)
        .then(async (rawBody) => {
          const body = rawBody as SendRequestBody;
          if (typeof body.sender !== "string" || body.sender.length === 0) {
            sendJson(res, 400, { error: "sender must be a non-empty string" });
            return;
          }
          if (typeof body.payload !== "string") {
            sendJson(res, 400, { error: "payload must be the frame's text" });
            return;
          }
          // The mail goes out from this bridge's own mailbox, whatever the request says; a
          // sender that is not that mailbox is refused rather than ignored (BRG-16).
          if (normalizeAddress(body.sender) !== normalizeAddress(account.address)) {
            sendJson(res, 403, {
              error: `this bridge sends as ${account.address}, not as ${body.sender}`,
            });
            return;
          }
          const bound = getBindRecord(deps.bindStorePath, documentId);
          if (!bound) {
            sendJson(res, 404, { error: `${documentId} has no thread started yet` });
            return;
          }
          // Removed from the thread by its creator: a send waiting cannot change, so it is
          // refused as one (EML-14), 403, which an adapter maps to `rejected` (LBI-6).
          if (isRemoved(bound, account.address)) {
            sendJson(res, 403, {
              error: `${account.address} was removed from the thread of ${documentId}`,
            });
            return;
          }
          // Addressed and, with PGP, encrypted to the set this bridge holds (EML-14).
          const held = heldParticipants(bound);
          const plan = await preparePgpSend(deps, documentId, bound, held);
          if (plan.blocked) {
            sendJson(res, plan.blocked.status, { error: plan.blocked.error });
            return;
          }
          const self = normalizeAddress(account.address);
          const mail = {
            to: held.filter((r) => normalizeAddress(r) !== self),
            subject: subjectForDocument(documentId),
            text: await buildMessageText(
              encodeEnvelope({
                tdsp: 1,
                kind: "frame",
                documentId,
                frame: body.payload,
              }),
              plan,
            ),
            documentId,
            inReplyTo: bound.threadRootMessageId,
            references: [bound.threadRootMessageId],
          };
          const { messageId } = await account.sender.send(mail);
          await fileSentCopy(deps, logger, account, mail, messageId);
          sendJson(res, 200, { deliveryId: messageId });
        })
        .catch((error: unknown) => sendSendFailure(res, error));
      return;
    }

    if (method === "GET" && path?.startsWith("/channels/") && path.endsWith("/deliveries")) {
      const documentId = decodeURIComponent(path.slice("/channels/".length, -"/deliveries".length));
      if (provisionedAccount(deps) === undefined) {
        refuseUnprovisioned(res);
        return;
      }
      if (deps.sync === undefined) {
        sendJson(res, 503, { error: "email-bridge is not configured yet" });
        return;
      }
      deps.sync
        .pollOnce(documentId)
        .then(() =>
          sendJson(res, 200, deps.sync?.getDeliveries(documentId).map(deliveryToJson) ?? []),
        )
        .catch((error: unknown) => {
          sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
        });
      return;
    }

    // The cursor (TRN-18, TRN-21; bindings/local-bridge-interface.md): what came after `after`, and
    // whether something after it may have come and gone unseen.
    if (method === "GET" && path?.startsWith("/channels/") && path.endsWith("/deliveries-since")) {
      const documentId = decodeURIComponent(
        path.slice("/channels/".length, -"/deliveries-since".length),
      );
      if (provisionedAccount(deps) === undefined) {
        refuseUnprovisioned(res);
        return;
      }
      const sync = deps.sync;
      if (sync === undefined) {
        sendJson(res, 503, { error: "email-bridge is not configured yet" });
        return;
      }
      const after = new URLSearchParams(query).get("after") || undefined;
      sync
        .pollOnce(documentId)
        .then(() => {
          const answer = sync.getDeliveriesSince(documentId, after);
          sendJson(res, 200, {
            deliveries: answer.deliveries.map(deliveryToJson),
            truncated: answer.truncated,
          });
        })
        .catch((error: unknown) => {
          sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
        });
      return;
    }

    // No resync-request route: a resync request is an ordinary send()/receive()
    // frame, like a resync response.

    if (method === "GET" && path?.startsWith("/channels/") && path.endsWith("/integrity-log")) {
      const documentId = decodeURIComponent(
        path.slice("/channels/".length, -"/integrity-log".length),
      );
      if (provisionedAccount(deps) === undefined) {
        refuseUnprovisioned(res);
        return;
      }
      if (deps.sync === undefined) {
        sendJson(res, 503, { error: "email-bridge is not configured yet" });
        return;
      }
      // Polls first, like /deliveries: a rejection only exists once the
      // message that caused it has been fetched and judged.
      deps.sync
        .pollOnce(documentId)
        .then(() => sendJson(res, 200, deps.sync?.getRejections(documentId) ?? []))
        .catch((error: unknown) => {
          sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
        });
      return;
    }

    sendJson(res, 404, { error: `no such route: ${method} ${path}${query ? `?${query}` : ""}` });
  });
}
