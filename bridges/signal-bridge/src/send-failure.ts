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
 * A refusal only a person can lift is a 409, `needs-person` (BRG-1, BRG-8, TRN-11): no account to
 * send as, because the bridge is not linked yet (`NotProvisionedError`), or a message nobody got
 * because of identities this account does not trust (below).
 *
 * When nobody got the message, SIG-4 decides by what every recipient's result says
 * (`nobodyGotIt`): rate-limited when Signal rate-limited one of them; `rejected` (a 422) when every
 * one is not registered; needs-person when the others are identities to trust; unavailable
 * otherwise. `signal-cli` 0.14.9 reports that as an error, not as an answer
 * (`SendMessageResultUtils.outputResult`, when no `SUCCESS` is among a non-empty list of results):
 * code -4 (`UNTRUSTED_KEY_ERROR`) when every recipient is an untrusted identity, -5 when every one
 * is rate-limited, -1 otherwise, each carrying the results as `data.response.results`. Results that
 * come back as an answer with no `SUCCESS` among them are read by the same rule
 * (`NobodyGotItError`), not taken as sent. A proof Signal asks for (libsignal-service-java's
 * `ProofRequiredException`, HTTP 428: a captcha, with the server's `Retry-After`) has no result
 * type of its own: `signal-cli` reports it as a `RATE_LIMIT_FAILURE` that carries the challenge's
 * `token` and the server's wait, and offers solving the captcha or waiting that long. Waiting lifts
 * it, so it is rate-limited, not needs-person (TRN-11). All of this is read from the source of
 * `signal-cli` 0.14.9 and of its libsignal-service-java 2.15.3_unofficial_154, not provoked
 * against real Signal.
 *
 * A device unlinked from the phone is told apart in `server.ts`, not here (SIG-7): `signal-cli`
 * then answers every call naming the account with `"Specified account does not exist"` (code
 * -32602), as it does when it could not load an account that is still linked, and only its list
 * of accounts says which. Here, as storage that is full, it stays a 502.
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

/**
 * A message `signal-cli` answered for with a result per recipient, none of which got it (SIG-4).
 * `signal-cli` 0.14.9 raises an error for that itself; this is the same outcome arriving as an
 * answer, which counts as sent no more than the error does (TRN-6).
 */
export class NobodyGotItError extends Error {
  readonly failure: SendFailure;

  constructor(failure: SendFailure) {
    super("Signal delivered the message to no member of the group");
    this.name = "NobodyGotItError";
    this.failure = failure;
  }
}

/** The codes `signal-cli` raises when nobody got a message (`SendMessageResultUtils.outputResult`). */
const SIGNAL_USER_ERROR_CODE = -1;
const SIGNAL_UNTRUSTED_KEY_CODE = -4;
const SIGNAL_RATE_LIMIT_CODE = -5;

export function classifySendFailure(error: unknown): SendFailure {
  // Over what this bridge carries in one message: no retry can make it fit (413, permanent).
  if (error instanceof FrameTooLargeError) {
    return { status: 413 };
  }
  if (error instanceof NotProvisionedError) {
    return { status: 409 };
  }
  if (error instanceof NobodyGotItError) {
    return error.failure;
  }
  if (error instanceof PartialSendError) {
    return error.missed.rateLimited === 0
      ? { status: 502 }
      : rateLimited(error.missed.retryAfterSeconds);
  }
  if (!(error instanceof SignalRpcError)) {
    return { status: 502 };
  }
  if (
    error.code === SIGNAL_USER_ERROR_CODE ||
    error.code === SIGNAL_UNTRUSTED_KEY_CODE ||
    error.code === SIGNAL_RATE_LIMIT_CODE
  ) {
    const failure = nobodyGotIt(
      (error.data as { response?: { results?: unknown } } | null | undefined)?.response?.results,
    );
    if (failure !== undefined) {
      return failure;
    }
  }
  // Without the results these codes come with, what the code alone says.
  if (error.code === SIGNAL_UNTRUSTED_KEY_CODE) {
    return { status: 409 };
  }
  if (error.code === SIGNAL_RATE_LIMIT_CODE) {
    return { status: 429 };
  }
  return { status: 502 };
}

/**
 * How a send fails when nobody got it (SIG-4), read from `signal-cli`'s result per recipient
 * (`results`, each with a `type` as `JsonSendMessageResult` names it); `undefined` when a recipient
 * got it (`SUCCESS`), or there are no results to read. A recipient Signal rate-limited decides
 * first, with the longest wait any result states: a retry before that wait reaches nobody it
 * missed. A recipient that is not registered is missed by every retry, so when every one is, the
 * send is refused for good (a 422, `rejected`); with identities to trust beside them it waits for
 * the person (TRN-11). Any other mix — one Signal could not reach, an invalid pre-key, a result
 * this does not read — may pass on a retry: unavailable.
 */
export function nobodyGotIt(results: unknown): SendFailure | undefined {
  if (!Array.isArray(results) || results.length === 0) {
    return undefined;
  }
  const types = results.map((result) => (result as { type?: unknown } | null)?.type);
  if (types.includes("SUCCESS")) {
    return undefined;
  }
  if (types.includes("RATE_LIMIT_FAILURE")) {
    return rateLimited(longestRetryAfterSeconds(results));
  }
  if (types.every((type) => type === "UNREGISTERED_FAILURE")) {
    return { status: 422 };
  }
  if (types.every((type) => type === "IDENTITY_FAILURE" || type === "UNREGISTERED_FAILURE")) {
    return { status: 409 };
  }
  return { status: 502 };
}

function rateLimited(retryAfterSeconds: number | undefined): SendFailure {
  return retryAfterSeconds === undefined ? { status: 429 } : { status: 429, retryAfterSeconds };
}
