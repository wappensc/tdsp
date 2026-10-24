import { afterEach, describe, expect, it, vi } from "vitest";
import { MatrixApiError, sendEvent, uploadMedia } from "./matrix-api";
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

  it("takes the wait from the Retry-After header, where Matrix 1.10 puts it, over the body's", () => {
    const limited = (body: string) => new MatrixApiError(429, `send … failed: 429 ${body}`, 7000);
    expect(classifySendFailure(limited('{"errcode":"M_LIMIT_EXCEEDED"}'))).toEqual({
      status: 429,
      retryAfterSeconds: 7,
    });
    expect(
      classifySendFailure(limited('{"errcode":"M_LIMIT_EXCEEDED","retry_after_ms":2300}')),
    ).toEqual({ status: 429, retryAfterSeconds: 7 });
  });
});

describe("a refused send carries the homeserver's Retry-After header", () => {
  const config = { homeserverUrl: "http://homeserver.test", accessToken: "t" };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const refusedWith = (headers: Record<string, string>) =>
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response('{"errcode":"M_LIMIT_EXCEEDED","error":"Too Many Requests"}', {
          status: 429,
          headers,
        }),
    );

  it("from sending an event", async () => {
    refusedWith({ "retry-after": "7" });
    const error = await sendEvent(config, "!r:x", "de.wappensc.together.tdsp.frame", {}).catch(
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(MatrixApiError);
    expect(classifySendFailure(error)).toEqual({ status: 429, retryAfterSeconds: 7 });
  });

  it("from uploading an attachment", async () => {
    refusedWith({ "retry-after": "12" });
    const error = await uploadMedia(config, new Uint8Array([1, 2, 3])).catch(
      (failure: unknown) => failure,
    );
    expect(classifySendFailure(error)).toEqual({ status: 429, retryAfterSeconds: 12 });
  });

  it("and none when the homeserver states none", async () => {
    refusedWith({});
    const error = await sendEvent(config, "!r:x", "de.wappensc.together.tdsp.frame", {}).catch(
      (failure: unknown) => failure,
    );
    expect(classifySendFailure(error)).toEqual({ status: 429 });
  });
});
