import { describe, expect, it } from "vitest";
import { classifySendFailure, NotProvisionedError } from "./send-failure";
import { SignalRpcError } from "./signal-daemon";

/** The `data` signal-cli attaches to a failed send: the send's own result, one entry per recipient. */
function sendResults(...results: Record<string, unknown>[]) {
  return { response: { timestamp: 1, results } };
}

describe("classifySendFailure", () => {
  it("reads signal-cli's JSON-RPC error code -5 as Signal's rate limit", () => {
    expect(
      classifySendFailure(
        new SignalRpcError("signal-cli JSON-RPC error: rate limit (code -5)", -5),
      ),
    ).toEqual({ status: 429 });
  });

  it("does not take +5, signal-cli's exit code for a rate limit on the command line, for one", () => {
    expect(classifySendFailure(new SignalRpcError("x", 5)).status).toBe(502);
  });

  it("passes on the longest wait Signal stated for any recipient", () => {
    const error = new SignalRpcError(
      "rate limit (code -5)",
      -5,
      sendResults(
        { type: "RATE_LIMIT_FAILURE", retryAfterSeconds: 30 },
        { type: "RATE_LIMIT_FAILURE", retryAfterSeconds: 120 },
        { type: "RATE_LIMIT_FAILURE" },
      ),
    );
    expect(classifySendFailure(error)).toEqual({ status: 429, retryAfterSeconds: 120 });
  });

  it("states no wait when Signal stated none, or what it stated is not a usable number", () => {
    for (const data of [
      undefined,
      sendResults({ type: "RATE_LIMIT_FAILURE" }),
      sendResults({ type: "RATE_LIMIT_FAILURE", retryAfterSeconds: -1 }),
      sendResults({ type: "RATE_LIMIT_FAILURE", retryAfterSeconds: "60" }),
      { response: { results: "none" } },
      "not an object",
    ]) {
      expect(classifySendFailure(new SignalRpcError("x", -5, data))).toEqual({ status: 429 });
    }
  });

  it("does not single out any other signal-cli code: it stays a retryable failure", () => {
    expect(classifySendFailure(new SignalRpcError("x", -1)).status).toBe(502);
    expect(classifySendFailure(new SignalRpcError("x", -32603)).status).toBe(502);
  });

  describe("a refusal only a person can lift is needs-person, a 409 (BRG-8, TRN-11)", () => {
    it("no account linked yet", () => {
      expect(classifySendFailure(new NotProvisionedError())).toEqual({ status: 409 });
    });

    it("signal-cli's code -4: nobody got it, and every recipient is an identity this account does not trust", () => {
      expect(
        classifySendFailure(
          new SignalRpcError(
            "signal-cli JSON-RPC error: Failed to send message due to untrusted identities (code -4)",
            -4,
            sendResults({ type: "IDENTITY_FAILURE" }, { type: "IDENTITY_FAILURE" }),
          ),
        ),
      ).toEqual({ status: 409 });
    });

    it("signal-cli's code -1 when nobody got it, and the others it missed are not registered (SIG-4)", () => {
      const error = new SignalRpcError(
        "signal-cli JSON-RPC error: Failed to send message (code -1)",
        -1,
        sendResults({ type: "IDENTITY_FAILURE" }, { type: "UNREGISTERED_FAILURE" }),
      );
      expect(classifySendFailure(error)).toEqual({ status: 409 });
    });
  });

  it("does not wait for the person when another recipient missed it for a reason that passes", () => {
    for (const other of ["NETWORK_FAILURE", "INVALID_PRE_KEY_FAILURE"]) {
      const error = new SignalRpcError(
        "Failed to send message (code -1)",
        -1,
        sendResults({ type: "IDENTITY_FAILURE" }, { type: other }),
      );
      expect(classifySendFailure(error).status, other).toBe(502);
    }
    // A code -1 that is not a send's result, such as a group this account is not in.
    expect(classifySendFailure(new SignalRpcError("x", -1)).status).toBe(502);
  });

  describe("nobody got it (SIG-4), as signal-cli 0.14.9 raises it: code -1 with the results", () => {
    const failed = (...results: Record<string, unknown>[]) =>
      classifySendFailure(
        new SignalRpcError(
          "signal-cli JSON-RPC error: Failed to send message (code -1)",
          -1,
          sendResults(...results),
        ),
      );

    it("is rejected, a 422, when every recipient is not registered: no retry and no person reaches them", () => {
      expect(failed({ type: "UNREGISTERED_FAILURE" }, { type: "UNREGISTERED_FAILURE" })).toEqual({
        status: 422,
      });
    });

    it("is rate-limited, with the longest wait, when Signal rate-limited one recipient beside the others", () => {
      expect(
        failed(
          { type: "IDENTITY_FAILURE" },
          { type: "RATE_LIMIT_FAILURE", retryAfterSeconds: 40 },
          { type: "UNREGISTERED_FAILURE" },
        ),
      ).toEqual({ status: 429, retryAfterSeconds: 40 });
      expect(failed({ type: "UNREGISTERED_FAILURE" }, { type: "RATE_LIMIT_FAILURE" })).toEqual({
        status: 429,
      });
    });

    it("is unavailable when one recipient Signal could not reach is among those not registered", () => {
      expect(failed({ type: "UNREGISTERED_FAILURE" }, { type: "NETWORK_FAILURE" })).toEqual({
        status: 502,
      });
    });

    it("is never classified as nobody getting it when one recipient got it", () => {
      // signal-cli raises no error then; were it to, the error's own code decides.
      expect(failed({ type: "SUCCESS" }, { type: "UNREGISTERED_FAILURE" })).toEqual({
        status: 502,
      });
    });
  });

  it("takes a proof Signal asks for (a captcha) as a rate limit with its wait: waiting lifts it", () => {
    // `JsonSendMessageResult` for a `ProofRequiredException`: `RATE_LIMIT_FAILURE`, the challenge's
    // `token`, and the server's `Retry-After`; code -5 when every recipient got that.
    const proofRequired = {
      recipientAddress: { uuid: "aci-bob", number: null },
      type: "RATE_LIMIT_FAILURE",
      token: "challenge-token",
      retryAfterSeconds: 86400,
    };
    expect(
      classifySendFailure(
        new SignalRpcError(
          "signal-cli JSON-RPC error: Failed to send message due to rate limiting (code -5)",
          -5,
          sendResults(proofRequired),
        ),
      ),
    ).toEqual({ status: 429, retryAfterSeconds: 86400 });
  });

  it("does not take signal-cli's 'Specified account does not exist' for an unlinked device: it also means an account it could not load for now", () => {
    expect(
      classifySendFailure(
        new SignalRpcError(
          "signal-cli JSON-RPC error: Specified account does not exist (code -32602)",
          -32602,
        ),
      ).status,
    ).toBe(502);
  });

  it("answers 502 for anything that is not a signal-cli reply, such as the daemon socket closing", () => {
    expect(classifySendFailure(new Error("signal-cli daemon socket closed")).status).toBe(502);
    expect(classifySendFailure("boom").status).toBe(502);
  });
});
