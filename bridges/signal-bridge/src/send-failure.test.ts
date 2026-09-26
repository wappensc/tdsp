import { describe, expect, it } from "vitest";
import { classifySendFailure } from "./send-failure";
import { SignalRpcError } from "./signal-daemon";

describe("classifySendFailure", () => {
  it("reads signal-cli's error code 5 as Signal's rate limit", () => {
    expect(
      classifySendFailure(new SignalRpcError("signal-cli JSON-RPC error: rate limit (code 5)", 5)),
    ).toEqual({ status: 429 });
  });

  it("does not single out any other signal-cli code: it stays a retryable failure", () => {
    expect(classifySendFailure(new SignalRpcError("x", 1)).status).toBe(502);
    expect(classifySendFailure(new SignalRpcError("x", -32603)).status).toBe(502);
  });

  it("answers 502 for anything that is not a signal-cli reply, such as the daemon socket closing", () => {
    expect(classifySendFailure(new Error("signal-cli daemon socket closed")).status).toBe(502);
    expect(classifySendFailure("boom").status).toBe(502);
  });
});
