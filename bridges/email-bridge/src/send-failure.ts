import { RecipientsRefusedError } from "./mail-transport.ts";

/**
 * How a failed send through the user's mail server is reported to the adapter:
 * the HTTP status carries the class, and `packages/messenger-port`'s
 * `transportSendErrorFromHttp` turns it back into a `TransportSendError`, so the
 * scheduler above knows whether a change is worth keeping for a retry.
 *
 * What SMTP says, and what it is taken to mean:
 * - a **4xx reply** ("try again later") is a rate limit — 429. One measured
 *   provider (GMX) refuses with `450 Requested mail action not taken: mailbox
 *   unavailable` once roughly 35 mails have gone out in 20 minutes, and a
 *   temporary refusal is what a sending limit looks like whichever code the
 *   provider chooses.
 * - **552** is "exceeded storage allocation": the message is too big — 413.
 * - a failure to reach the server at all (refused, reset, timed out, unresolvable)
 *   is 503, and any other failure 502; the adapter treats both as retryable.
 *   Other permanent SMTP replies are **not** singled out: a refused change is
 *   dropped, so being wrong in that direction costs a person their edit, while
 *   being wrong the other way costs a retry every few minutes.
 * - a message **accepted for some participants and refused for others**
 *   (`RecipientsRefusedError`) is the exception: a retry mails everyone again, so it is
 *   retried (429) only when every refusal was temporary, and is otherwise final (422).
 *
 * `error` is whatever `nodemailer` threw; only its `responseCode` and `code` are read.
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

export function classifySendFailure(error: unknown): SendFailure {
  // Some recipients have the message already, so an endless retry would mail them again and
  // again: only a refusal that was temporary for everyone is retried; any other is final, and
  // the engine marks the change undistributed until a resync (SND-8).
  if (error instanceof RecipientsRefusedError) {
    return { status: error.temporary ? 429 : 422 };
  }
  if (typeof error === "object" && error !== null) {
    const { responseCode, code } = error as { responseCode?: unknown; code?: unknown };
    if (typeof responseCode === "number") {
      if (responseCode === 552) {
        return { status: 413 };
      }
      if (responseCode >= 400 && responseCode < 500) {
        return { status: 429 };
      }
    }
    if (typeof code === "string" && CONNECTION_ERROR_CODES.has(code)) {
      return { status: 503 };
    }
  }
  return { status: 502 };
}
