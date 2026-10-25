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
    for (const other of ["NETWORK_FAILURE", "RATE_LIMIT_FAILURE", "INVALID_PRE_KEY_FAILURE"]) {
      const error = new SignalRpcError(
        "Failed to send message (code -1)",
        -1,
        sendResults({ type: "IDENTITY_FAILURE" }, { type: other }),
      );
      expect(classifySendFailure(error).status, other).toBe(502);
    }
    // Every recipient unregistered: no person can trust anyone into receiving it.
    expect(
      classifySendFailure(
        new SignalRpcError("x", -1, sendResults({ type: "UNREGISTERED_FAILURE" })),
      ).status,
    ).toBe(502);
    // A code -1 that is not a send's result, such as a group this account is not in.
    expect(classifySendFailure(new SignalRpcError("x", -1)).status).toBe(502);
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
