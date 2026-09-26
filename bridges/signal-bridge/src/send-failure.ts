import { FrameTooLargeError } from "./attachment.ts";
import { SignalRpcError } from "./signal-daemon.ts";

/**
 * How a failed send into a Signal group is reported to the adapter:
 * the HTTP status carries the class, and `packages/messenger-port`'s
 * `transportSendErrorFromHttp` turns it back into a `TransportSendError`, so the
 * scheduler above knows whether a change is worth keeping for a retry.
 *
 * `signal-cli` surfaces Signal's own rate limiting as JSON-RPC error code 5: that is
 * a 429. Everything else is 502, which the adapter treats as retryable — a change is
 * never dropped on a failure nobody classified. **Not provoked against real Signal**:
 * the code comes from reading `signal-cli`'s own source, and no run
 * has hit Signal's limit on purpose (the two accounts are real ones). The one class this
 * bridge decides itself is a frame over what it carries in one message
 * (`FrameTooLargeError`, 4 MiB): a 413, which no retry can fix. A frame over the body
 * limit but within that goes as an attachment (`attachment.ts`), so nothing `signal-cli`
 * reports about a too-long body needs classifying.
 */
export interface SendFailure {
  readonly status: number;
  readonly retryAfterSeconds?: number;
}

const SIGNAL_RATE_LIMIT_CODE = 5;

export function classifySendFailure(error: unknown): SendFailure {
  // Over what this bridge carries in one message: no retry can make it fit (413, permanent).
  if (error instanceof FrameTooLargeError) {
    return { status: 413 };
  }
  if (error instanceof SignalRpcError && error.code === SIGNAL_RATE_LIMIT_CODE) {
    return { status: 429 };
  }
  return { status: 502 };
}
