import { FrameTooLargeError } from "./attachment.ts";
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
 */
export interface SendFailure {
  readonly status: number;
  readonly retryAfterSeconds?: number;
}

const SIGNAL_RATE_LIMIT_CODE = -5;

export function classifySendFailure(error: unknown): SendFailure {
  // Over what this bridge carries in one message: no retry can make it fit (413, permanent).
  if (error instanceof FrameTooLargeError) {
    return { status: 413 };
  }
  if (error instanceof SignalRpcError && error.code === SIGNAL_RATE_LIMIT_CODE) {
    const retryAfterSeconds = statedWaitSeconds(error.data);
    return retryAfterSeconds === undefined ? { status: 429 } : { status: 429, retryAfterSeconds };
  }
  return { status: 502 };
}

/**
 * The longest `retryAfterSeconds` among the send results in a rate-limit error's `data`, if any
 * recipient's carries one. `signal-cli` raises the error only when every recipient failed with a
 * rate limit, so the longest wait is the one after which a retry can reach all of them.
 */
function statedWaitSeconds(data: unknown): number | undefined {
  const results = (data as { response?: { results?: unknown } } | null | undefined)?.response
    ?.results;
  if (!Array.isArray(results)) {
    return undefined;
  }
  let longest: number | undefined;
  for (const result of results) {
    const seconds = (result as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds;
    if (typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds >= 0) {
      longest = Math.max(longest ?? 0, seconds);
    }
  }
  return longest;
}
