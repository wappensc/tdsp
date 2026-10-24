import { describe, expect, it } from "vitest";
import { classifySendFailure, PartialSendError } from "./send-failure.ts";
import { type AuthStatusSource, createGroupWriter } from "./server.ts";
import type { SignalRpc } from "./signal-api.ts";

/**
 * What a group message counts as when it did not reach every member. Signal has no server that
 * fans a group message out: `signal-cli` sends it to every member itself, answers with a result per
 * recipient, and raises no error as long as one of them got it. TRN-6 accepts a send only for
 * every channel member (§3.3), so a frame some members missed for now must fail and be retried.
 * The results are written as `signal-cli` 0.14.9's source writes them (`JsonSendMessageResult`);
 * no run has provoked a partial send against real Signal.
 */

const auth: AuthStatusSource = {
  status: { linked: true, accountId: "alice-aci" } as AuthStatusSource["status"],
  phoneNumber: "+15550000001",
  async link() {
    return { linkingUri: "sgnl://x" };
  },
};

/** A `signal-cli` whose `send` answers with one result per recipient, of the given types. */
class FakeRpc implements SignalRpc {
  results: Record<string, unknown>[] = [];

  async callRpc<T>(): Promise<T> {
    return { timestamp: 1700000000001, results: this.results } as T;
  }

  onNotification(): () => void {
    return () => {};
  }
}

const result = (type: string, retryAfterSeconds?: number): Record<string, unknown> => ({
  recipientAddress: { uuid: `aci-${type.toLowerCase()}`, number: null },
  type,
  ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
});

async function sendFrameWith(...results: Record<string, unknown>[]): Promise<unknown> {
  const rpc = new FakeRpc();
  rpc.results = results;
  return createGroupWriter(rpc, auth)
    .sendEdit("g1", "doc-1", '{"tdsp":1}')
    .catch((error: unknown) => error);
}

describe("a frame that did not reach every member of the group", () => {
  it("is sent when every recipient got it", async () => {
    expect(await sendFrameWith(result("SUCCESS"), result("SUCCESS"))).toBe(
      "alice-aci:1700000000001",
    );
  });

  it("fails as rate-limited, with the longest wait Signal stated, when Signal rate-limited a member", async () => {
    const refusal = await sendFrameWith(
      result("SUCCESS"),
      result("RATE_LIMIT_FAILURE", 30),
      result("RATE_LIMIT_FAILURE", 120),
    );
    expect(refusal).toBeInstanceOf(PartialSendError);
    expect(classifySendFailure(refusal)).toEqual({ status: 429, retryAfterSeconds: 120 });
  });

  it("fails as unavailable when Signal could not reach a member", async () => {
    const refusal = await sendFrameWith(result("SUCCESS"), result("NETWORK_FAILURE"));
    expect(refusal).toBeInstanceOf(PartialSendError);
    expect(classifySendFailure(refusal)).toEqual({ status: 502 });
  });

  it("fails as rate-limited when one member was rate-limited and another unreachable", async () => {
    const refusal = await sendFrameWith(
      result("SUCCESS"),
      result("NETWORK_FAILURE"),
      result("RATE_LIMIT_FAILURE"),
    );
    expect(classifySendFailure(refusal)).toEqual({ status: 429 });
  });

  it("is sent when the members it missed are ones no retry of the message reaches", async () => {
    // An account that is gone, or one whose new identity this account does not trust yet: retrying
    // would fail for them every time and stop the document for everyone else.
    expect(
      await sendFrameWith(
        result("SUCCESS"),
        result("UNREGISTERED_FAILURE"),
        result("IDENTITY_FAILURE"),
      ),
    ).toBe("alice-aci:1700000000001");
  });

  it("does not hold back an invitation that some members missed: people read it, and a retry would show it twice", async () => {
    const rpc = new FakeRpc();
    rpc.results = [result("SUCCESS"), result("RATE_LIMIT_FAILURE", 30)];
    await expect(createGroupWriter(rpc, auth).sendInviteMessage("g1", "hello")).resolves.toBe(
      "alice-aci:1700000000001",
    );
  });
});
