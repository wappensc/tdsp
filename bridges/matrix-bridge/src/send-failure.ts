import { OwnDeviceUnsignedError } from "./crypto-machine.ts";
import { MatrixApiError } from "./matrix-api.ts";

/**
 * How a failed send into a Matrix room is reported to the adapter:
 * the HTTP status carries the class, and `packages/messenger-port`'s
 * `transportSendErrorFromHttp` turns it back into a `TransportSendError`, so the
 * scheduler above knows whether a change is worth keeping for a retry (LBI-6).
 *
 * What the homeserver says, and what it is taken to mean (the Matrix Client-Server API's
 * error codes, as its v1.19 text describes them; **not** yet exercised against a homeserver
 * that rate-limits, signs out, locks or asks for consent — the local Synapse test server's
 * invite limiter is the only one met so far):
 * - **429** (`M_LIMIT_EXCEEDED`) is a rate limit. How long the homeserver asked us to wait
 *   is its `Retry-After` header, where Matrix 1.10 put it, and otherwise the body's
 *   `retry_after_ms`, where earlier versions had it — passed on as `Retry-After` (MTX-6).
 * - **409** is a refusal only a person can lift, `needs-person` (BRG-8, TRN-11), told by
 *   its `errcode` (`NEEDS_PERSON` below) and checked before the status, because Matrix
 *   sends some of these as 401 and some as 403.
 * - **413** (`M_TOO_LARGE`) is a message over the event size limit.
 * - **403** (`M_FORBIDDEN`, and every other 403) is not being allowed to send into that
 *   room, which waiting does not change.
 * - everything else — a 5xx, a 401 without a known `errcode`, a request that never reached
 *   the homeserver — is 502, which the adapter treats as retryable: a change is never
 *   dropped on a failure nobody classified.
 */
export interface SendFailure {
  readonly status: number;
  readonly retryAfterSeconds?: number;
}

/**
 * The `errcode`s that only a person lifts, and why each is one (quotes from the
 * Client-Server API unless said otherwise):
 * - `M_UNKNOWN_TOKEN` (401): the access token "was never valid", "has been logged out",
 *   "has been soft logged out" or "needs to be refreshed"; a client then refreshes, logs in
 *   again, or considers "the user as having been logged out". This bridge holds an access
 *   token and nothing to refresh or log in with, so a person has to sign in again.
 * - `M_MISSING_TOKEN` (401): no access token reached the homeserver — the same, before any
 *   sign-in.
 * - `M_USER_LOCKED` (401, `soft_logout: true`): an administrator locked the account, a lock
 *   "can be reversed", and until then a client "cannot obtain a new access token".
 * - `M_USER_SUSPENDED` (403): an administrator suspended the account, which forbids
 *   "Sending messages to rooms"; suspensions "are reversible, like locks and unlike
 *   deactivations".
 * - `M_CONSENT_NOT_GIVEN` (403): Synapse's, not the specification's (its
 *   `ConsentNotGivenError`, `HTTPStatus.FORBIDDEN`): the homeserver blocks sending messages
 *   until the user accepts its privacy policy at the consent URI it names.
 * - `M_RESOURCE_LIMIT_EXCEEDED`: the homeserver "has reached a resource limit imposed on
 *   it", "too much memory or disk space" for example (BRG-8's storage full), and the error
 *   "MUST have an admin_contact field to provide the user receiving the error a place to
 *   reach out to".
 *
 * `M_USER_DEACTIVATED` is not one: a deactivation is not reversed, so it keeps the class of
 * its HTTP status.
 */
const NEEDS_PERSON: ReadonlySet<string> = new Set([
  "M_UNKNOWN_TOKEN",
  "M_MISSING_TOKEN",
  "M_USER_LOCKED",
  "M_USER_SUSPENDED",
  "M_CONSENT_NOT_GIVEN",
  "M_RESOURCE_LIMIT_EXCEEDED",
]);

/** Whether `error` is a homeserver's refusal that only a person can lift (BRG-8, TRN-11). */
export function needsPerson(error: unknown): boolean {
  if (error instanceof OwnDeviceUnsignedError) {
    return true;
  }
  if (!(error instanceof MatrixApiError)) {
    return false;
  }
  // `matrix-api.ts` ends its message with the homeserver's response body.
  const errcode = /"errcode"\s*:\s*"([^"]+)"/.exec(error.message)?.[1];
  return errcode !== undefined && NEEDS_PERSON.has(errcode);
}

export function classifySendFailure(error: unknown): SendFailure {
  if (needsPerson(error)) {
    return { status: 409 };
  }
  if (!(error instanceof MatrixApiError)) {
    return { status: 502 };
  }
  if (error.status === 429) {
    const inBody = /"retry_after_ms"\s*:\s*(\d+)/.exec(error.message)?.[1];
    const retryAfterMs = error.retryAfterMs ?? (inBody === undefined ? undefined : Number(inBody));
    return retryAfterMs === undefined
      ? { status: 429 }
      : { status: 429, retryAfterSeconds: Math.ceil(retryAfterMs / 1000) };
  }
  if (error.status === 413 || error.status === 403) {
    return { status: error.status };
  }
  return { status: 502 };
}
