import { describe, expect, it } from "vitest";
import { MatrixApiError } from "./matrix-api";
import { classifySendFailure } from "./send-failure";

const homeserver = (status: number, body: string) =>
  new MatrixApiError(
    status,
    `send de.wappensc.together.tdsp.frame into !r:x failed: ${status} ${body}`,
  );

describe("classifySendFailure", () => {
  it("reads M_LIMIT_EXCEEDED as a rate limit and passes on how long the homeserver asked us to wait", () => {
    const failure = classifySendFailure(
      homeserver(
        429,
        '{"errcode":"M_LIMIT_EXCEEDED","error":"Too Many Requests","retry_after_ms":2300}',
      ),
    );
    expect(failure).toEqual({ status: 429, retryAfterSeconds: 3 }); // rounded up, never shorter than asked
  });

  it("still reads a 429 with no retry_after_ms as a rate limit", () => {
    expect(classifySendFailure(homeserver(429, "slow down"))).toEqual({ status: 429 });
  });

  it("reads M_TOO_LARGE as too large", () => {
    expect(classifySendFailure(homeserver(413, '{"errcode":"M_TOO_LARGE"}'))).toEqual({
      status: 413,
    });
  });

  it("reads M_FORBIDDEN as rejected: waiting does not let us into the room", () => {
    expect(classifySendFailure(homeserver(403, '{"errcode":"M_FORBIDDEN"}'))).toEqual({
      status: 403,
    });
  });

  it.each([500, 502, 503, 401, 404, 400])(
    "does not single out a %i: it stays a retryable failure, so no edit is dropped on a guess",
    (status) => {
      expect(classifySendFailure(homeserver(status, "{}")).status).toBe(502);
    },
  );

  it("answers 502 for anything that is not a homeserver reply, such as a connection that never came up", () => {
    expect(classifySendFailure(new TypeError("fetch failed")).status).toBe(502);
    expect(classifySendFailure("boom").status).toBe(502);
  });
});
