import { MatrixApiError } from "./matrix-api.ts";

/**
 * How a failed send into a Matrix room is reported to the adapter:
 * the HTTP status carries the class, and `packages/messenger-port`'s
 * `transportSendErrorFromHttp` turns it back into a `TransportSendError`, so the
 * scheduler above knows whether a change is worth keeping for a retry.
 *
 * What the homeserver says, and what it is taken to mean (Matrix client-server API,
 * error codes as the spec lists them; **not** yet exercised against a rate-limited
 * homeserver here; the local Synapse test server's invite limiter is the only
 * one met so far):
 * - **429** (`M_LIMIT_EXCEEDED`) is a rate limit, and the body's `retry_after_ms` is
 *   how long the homeserver asked us to wait — passed on as `Retry-After`.
 * - **413** (`M_TOO_LARGE`) is a message over the event size limit.
 * - **403** (`M_FORBIDDEN`) is not being allowed to send into that room, which
 *   waiting does not change.
 * - everything else — a 5xx, an expired token (401), a request that never reached
 *   the homeserver — is 502, which the adapter treats as retryable: a change is
 *   never dropped on a failure nobody classified.
 */
export interface SendFailure {
  readonly status: number;
  readonly retryAfterSeconds?: number;
}

export function classifySendFailure(error: unknown): SendFailure {
  if (!(error instanceof MatrixApiError)) {
    return { status: 502 };
  }
  if (error.status === 429) {
    const retryAfterMs = /"retry_after_ms"\s*:\s*(\d+)/.exec(error.message)?.[1];
    return retryAfterMs === undefined
      ? { status: 429 }
      : { status: 429, retryAfterSeconds: Math.ceil(Number(retryAfterMs) / 1000) };
  }
  if (error.status === 413 || error.status === 403) {
    return { status: error.status };
  }
  return { status: 502 };
}
