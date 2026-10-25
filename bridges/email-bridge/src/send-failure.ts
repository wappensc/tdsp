import { RecipientsRefusedError } from "./mail-transport.ts";

/**
 * How a failed send through the user's mail server is reported to the adapter:
 * the HTTP status carries the class, and `packages/messenger-port`'s
 * `transportSendErrorFromHttp` turns it back into a `TransportSendError`, so the
 * scheduler above knows whether a change is worth keeping for a retry.
 *
 * What SMTP says, and what it is taken to mean:
 * - a refusal **only a person can lift** is `needs-person` — 409 (BRG-8, TRN-11): waiting
 *   does not pass it, so a retry would only meet it again, and acting does, so dropping
 *   the change would lose what could go out a minute later. Three replies say so:
 *   - a **login the server refused for good**: nodemailer's `EAUTH` with no reply, or
 *     with any but a 4xx (RFC 4954 §6: 535 credentials invalid, 534 mechanism too weak,
 *     538 encryption required) — the person fixes the password or the account's
 *     settings at the provider;
 *   - a **530**, the server wanting a login (RFC 4954 §6) or STARTTLS first (RFC 3207)
 *     before it takes mail — the bridge's configuration, which a person sets;
 *   - a **full mailbox** for good, enhanced status code 5.2.2 (RFC 3463: "the recipient
 *     can delete messages to make more space available"), for every recipient the
 *     server refused — the storage that holds the messages is full (§3.4).
 * - a **4xx reply** ("try again later") is a rate limit — 429. One measured
 *   provider (GMX) refuses with `450 Requested mail action not taken: mailbox
 *   unavailable` once roughly 35 mails have gone out in 20 minutes, and a
 *   temporary refusal is what a sending limit looks like whichever code the
 *   provider chooses. A temporary login failure (454 4.7.0) and a mailbox full for
 *   now (4.2.2) are 4xx too.
 * - **552** is "exceeded storage allocation": but for a 5.2.2, which says whose
 *   storage, the message is too big — 413 (RFC 3463: 5.3.4 too big for the system,
 *   5.2.3 longer than the mailbox's limit).
 * - a failure to reach the server at all (refused, reset, timed out, unresolvable)
 *   is 503, and any other failure 502; the adapter treats both as retryable.
 *   Other permanent SMTP replies are **not** singled out: a refused change is
 *   dropped, so being wrong in that direction costs a person their edit, while
 *   being wrong the other way costs a retry every few minutes.
 * - a message **accepted for some participants and refused for others**
 *   (`RecipientsRefusedError`) is the exception: a retry mails everyone again, so it is
 *   retried (429) only when every refusal was temporary, and is otherwise final (422),
 *   a full mailbox among them (EML-11).
 *
 * `error` is whatever `nodemailer` threw; only its `responseCode`, `response`, `code` and
 * `rejectedErrors` (each refused recipient's reply, when every one was refused) are read.
 */
export interface SendFailure {
  readonly status: number;
  /** For a 429, when the provider said how long to wait. SMTP does not, so none today. */
  readonly retryAfterSeconds?: number;
}

const CONNECTION_ERROR_CODES = new Set([
  "ECONNECTION",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ESOCKET",
  "EDNS",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

interface SmtpFailure {
  readonly responseCode?: unknown;
  readonly response?: unknown;
  readonly code?: unknown;
  readonly rejectedErrors?: unknown;
}

const isTemporary = (responseCode: unknown): boolean =>
  typeof responseCode === "number" && responseCode >= 400 && responseCode < 500;

/** A permanent reply carrying RFC 3463's 5.2.2 as its enhanced status code. */
const isMailboxFull = (reply: unknown): boolean =>
  typeof reply === "object" &&
  reply !== null &&
  typeof (reply as SmtpFailure).response === "string" &&
  /^5\d\d[ -]5\.2\.2(?!\d)/.test((reply as { response: string }).response);

function needsPerson(failure: SmtpFailure): boolean {
  if (failure.code === "EAUTH" && !isTemporary(failure.responseCode)) {
    return true;
  }
  if (failure.responseCode === 530) {
    return true;
  }
  // Every recipient refused: nodemailer's own reply is only the last one's, so each is read.
  const replies =
    Array.isArray(failure.rejectedErrors) && failure.rejectedErrors.length > 0
      ? failure.rejectedErrors
      : [failure];
  return replies.every(isMailboxFull);
}

export function classifySendFailure(error: unknown): SendFailure {
  // Some recipients have the message already, so an endless retry would mail them again and
  // again: only a refusal that was temporary for everyone is retried; any other is final, and
  // the engine marks the change undistributed until a resync (SND-8).
  if (error instanceof RecipientsRefusedError) {
    return { status: error.temporary ? 429 : 422 };
  }
  if (typeof error === "object" && error !== null) {
    const failure = error as SmtpFailure;
    if (needsPerson(failure)) {
      return { status: 409 };
    }
    const { responseCode, code } = failure;
    if (typeof responseCode === "number") {
      if (responseCode === 552) {
        return { status: 413 };
      }
      if (isTemporary(responseCode)) {
        return { status: 429 };
      }
    }
    if (typeof code === "string" && CONNECTION_ERROR_CODES.has(code)) {
      return { status: 503 };
    }
  }
  return { status: 502 };
}
