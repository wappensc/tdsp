import { FrameTooLargeError } from "./attachment.ts";
import { longestRetryAfterSeconds, type MissedRecipients } from "./signal-api.ts";
import { SignalRpcError } from "./signal-daemon.ts";

/**
 * How a failed send into a Signal group is reported to the adapter:
 * the HTTP status carries the class, and `packages/messenger-port`'s
 * `transportSendErrorFromHttp` turns it back into a `TransportSendError`, so the
 * scheduler above knows whether a change is worth keeping for a retry.
 *
 * `signal-cli` surfaces Signal's own rate limiting as JSON-RPC error code -5 (its
 * `RATELIMIT_ERROR`; the 5 its manual lists is the command line's exit code, which never
 * reaches a JSON-RPC client): that is a 429, carrying the longest wait Signal stated for
 * any recipient (`retryAfterSeconds` in the send results `signal-cli` attaches as
 * `data.response`), so the engine can honour it (TRN-11) and widen its spacing (SND-9).
 * Everything else is 502, which the adapter treats as retryable — a change is
 * never dropped on a failure nobody classified. **Not provoked against real Signal**:
 * the code and the shape of `data` come from reading `signal-cli`'s own source (0.14.8 and
 * 0.14.9), and no run has hit Signal's limit on purpose (the two accounts are real ones). The one class this
 * bridge decides itself is a frame over what it carries in one message
 * (`FrameTooLargeError`, 4 MiB): a 413, which no retry can fix. A frame over the body
 * limit but within that goes as an attachment (`attachment.ts`), so nothing `signal-cli`
 * reports about a too-long body needs classifying.
 *
 * A refusal only a person can lift is a 409, `needs-person` (BRG-1, BRG-8, TRN-11):
 * - no account to send as: the bridge is not linked yet (`NotProvisionedError`);
 * - nobody got the message, and the recipients it missed are identities this account does not
 *   trust, beside any that are not registered (SIG-4): code -4 (`UNTRUSTED_KEY_ERROR`) when every
 *   one of them is such an identity, code -1 with the results per recipient otherwise. Read from
 *   `signal-cli` 0.14.9's source (`SendMessageResultUtils.outputResult`), not provoked against
 *   real Signal.
 *
 * A device unlinked from the phone is not told apart: `signal-cli` then answers every call naming
 * the account with `"Specified account does not exist"` (code -32602), but it answers the same
 * when it could not load an account that is still linked, such as while Signal is unreachable.
 * That, and storage that is full, stay a 502.
 */
export interface SendFailure {
  readonly status: number;
  readonly retryAfterSeconds?: number;
}

/**
 * A frame `signal-cli` sent, but not to every member of the group: Signal rate-limited some of
 * them, or could not reach them. `signal-cli` raises no error as long as one member got the
 * message, so the bridge reads its result per recipient (`missedRecipients`). TRN-6 accepts a send
 * only for every channel member (§3.3), so the send fails: as rate-limited (a 429, with the longest
 * wait Signal stated) when Signal rate-limited any of them, as unavailable (a 502) otherwise. The
 * retry reaches the members it missed; to the others it is a duplicate, which changes nothing
 * (TRN-8).
 */
export class PartialSendError extends Error {
  readonly missed: MissedRecipients;

  constructor(missed: MissedRecipients) {
    super(
      `Signal ${missed.rateLimited > 0 ? "rate-limited" : "could not reach"} some members of the group (${missed.rateLimited} rate-limited, ${missed.unreachable} unreachable)`,
    );
    this.name = "PartialSendError";
    this.missed = missed;
  }
}

/**
 * The bridge has no account to act as yet: no device link has completed (BRG-1). Only the
 * person can link one.
 */
export class NotProvisionedError extends Error {
  constructor() {
    super(
      "no Signal account is linked to this bridge yet: link this bridge as a device of the account from the Signal app",
    );
    this.name = "NotProvisionedError";
  }
}

const SIGNAL_USER_ERROR_CODE = -1;
const SIGNAL_UNTRUSTED_KEY_CODE = -4;
const SIGNAL_RATE_LIMIT_CODE = -5;

export function classifySendFailure(error: unknown): SendFailure {
  // Over what this bridge carries in one message: no retry can make it fit (413, permanent).
  if (error instanceof FrameTooLargeError) {
    return { status: 413 };
  }
  if (error instanceof NotProvisionedError || missedOnlyUntrustedIdentities(error)) {
    return { status: 409 };
  }
  if (error instanceof PartialSendError) {
    if (error.missed.rateLimited === 0) {
      return { status: 502 };
    }
    const retryAfterSeconds = error.missed.retryAfterSeconds;
    return retryAfterSeconds === undefined ? { status: 429 } : { status: 429, retryAfterSeconds };
  }
  if (error instanceof SignalRpcError && error.code === SIGNAL_RATE_LIMIT_CODE) {
    const retryAfterSeconds = statedWaitSeconds(error.data);
    return retryAfterSeconds === undefined ? { status: 429 } : { status: 429, retryAfterSeconds };
  }
  return { status: 502 };
}

/**
 * Whether `signal-cli` refused the whole send because the recipients it missed are identities this
 * account does not trust, beside any that are not registered (SIG-4): trusting them is the
 * person's (TRN-11), and no retry gets past them before that. `signal-cli` raises an error only
 * when no recipient got the message; with every recipient an untrusted identity it is code -4, and
 * with a mix code -1, carrying the results per recipient as `data.response.results`.
 */
function missedOnlyUntrustedIdentities(error: unknown): boolean {
  if (!(error instanceof SignalRpcError)) {
    return false;
  }
  if (error.code === SIGNAL_UNTRUSTED_KEY_CODE) {
    return true;
  }
  if (error.code !== SIGNAL_USER_ERROR_CODE) {
    return false;
  }
  const results = (error.data as { response?: { results?: unknown } } | null | undefined)?.response
    ?.results;
  if (!Array.isArray(results)) {
    return false;
  }
  const types = results.map((result) => (result as { type?: unknown } | null)?.type);
  return (
    types.includes("IDENTITY_FAILURE") &&
    types.every((type) => type === "IDENTITY_FAILURE" || type === "UNREGISTERED_FAILURE")
  );
}

/**
 * The longest `retryAfterSeconds` among the send results in a rate-limit error's `data`, if any
 * recipient's carries one. `signal-cli` raises the error only when every recipient failed with a
 * rate limit, so the longest wait is the one after which a retry can reach all of them.
 */
function statedWaitSeconds(data: unknown): number | undefined {
  return longestRetryAfterSeconds(
    (data as { response?: { results?: unknown } } | null | undefined)?.response?.results,
  );
}
