import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_FRAME_LIMIT,
  BODY_FRAME_LIMIT,
  FrameTooLargeError,
  parseAttachmentRef,
  refFor,
} from "./attachment.ts";
import { type AuthStatusSource, createGroupWriter } from "./server.ts";
import type { SignalRpc } from "./signal-api.ts";

/**
 * How the sending side chooses between a message body and an attachment, against a
 * `signal-cli` this file controls: where the line is, what exactly goes into the `send` call, and
 * what a frame over the bridge's bound does. The real round trip is `l4-attachments.test.ts`.
 */

const auth: AuthStatusSource = {
  status: { linked: true, accountId: "alice-aci" } as AuthStatusSource["status"],
  phoneNumber: "+15550000001",
  async link() {
    return { linkingUri: "sgnl://x" };
  },
};

class FakeRpc implements SignalRpc {
  calls: { method: string; params: Record<string, unknown> }[] = [];
  failWith: Error | undefined;

  async callRpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    if (this.failWith) {
      throw this.failWith;
    }
    return { timestamp: 1700000000000 + this.calls.length } as T;
  }

  onNotification(): () => void {
    return () => {};
  }
}

/** A frame's text of `length` bytes: printable ASCII, distinguishable by `seed`. */
const bytesOf = (length: number, seed = 1): string =>
  Array.from({ length }, (_, i) =>
    String.fromCharCode(32 + (((i * 2654435761 + seed * 40503) >>> 24) % 95)),
  ).join("");

const envelopeOf = (call: { params: Record<string, unknown> } | undefined) =>
  JSON.parse(String(call?.params.message)) as Record<string, unknown>;

describe("the sending side's choice between a body and an attachment", () => {
  it("puts a frame up to the body limit in the message, with no attachment", async () => {
    const rpc = new FakeRpc();
    const frame = bytesOf(BODY_FRAME_LIMIT);
    const id = await createGroupWriter(rpc, auth).sendEdit("g1", "doc-1", frame);
    expect(id).toBe("alice-aci:1700000000001");
    expect(rpc.calls).toHaveLength(1);
    expect(rpc.calls[0]?.params).not.toHaveProperty("attachments");
    expect(envelopeOf(rpc.calls[0])).toEqual({
      tdsp: 1,
      kind: "frame",
      documentId: "doc-1",
      frame, // the frame's text itself, not Base64
    });
  });

  it("sends a frame one byte over the limit as an attachment, and names it in the envelope", async () => {
    const rpc = new FakeRpc();
    const frame = bytesOf(BODY_FRAME_LIMIT + 1);
    const id = await createGroupWriter(rpc, auth).sendEdit("g1", "doc-1", frame);
    expect(id).toBe("alice-aci:1700000000001");
    expect(rpc.calls).toHaveLength(1);
    const call = rpc.calls[0];
    expect(call?.params.account).toBe("+15550000001");
    expect(call?.params.groupId).toBe("g1");

    const envelope = envelopeOf(call);
    expect(envelope).toEqual({
      tdsp: 1,
      kind: "frame",
      documentId: "doc-1",
      attachment: refFor(Buffer.from(frame)),
    });
    expect(envelope).not.toHaveProperty("frame");
    // The receiver's own parser accepts what was sent.
    expect(parseAttachmentRef(envelope.attachment)).toEqual(refFor(Buffer.from(frame)));

    // One data URI, and it holds exactly the frame.
    const uris = call?.params.attachments as string[];
    expect(uris).toHaveLength(1);
    const [head, encoded] = (uris[0] as string).split("base64,");
    expect(head).toBe("data:application/octet-stream;filename=tdsp.bin;");
    expect(Buffer.from(encoded as string, "base64").equals(Buffer.from(frame))).toBe(true);
  });

  it("carries a frame of exactly the bound as an attachment", async () => {
    const rpc = new FakeRpc();
    await createGroupWriter(rpc, auth).sendEdit("g1", "doc-1", bytesOf(ATTACHMENT_FRAME_LIMIT));
    expect(rpc.calls).toHaveLength(1);
    expect(envelopeOf(rpc.calls[0]).attachment).toMatchObject({ size: ATTACHMENT_FRAME_LIMIT });
  });

  it("refuses a frame one byte over the bound, without asking signal-cli to send anything", async () => {
    const rpc = new FakeRpc();
    const refusal = await createGroupWriter(rpc, auth)
      .sendEdit("g1", "doc-1", bytesOf(ATTACHMENT_FRAME_LIMIT + 1))
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(FrameTooLargeError);
    expect((refusal as FrameTooLargeError).bytes).toBe(ATTACHMENT_FRAME_LIMIT + 1);
    expect(rpc.calls).toEqual([]);
  });

  it("lets a failure of the send through as it is, so it can be classified and retried", async () => {
    const rpc = new FakeRpc();
    rpc.failWith = new Error("signal-cli daemon socket closed");
    await expect(
      createGroupWriter(rpc, auth).sendEdit("g1", "doc-1", bytesOf(BODY_FRAME_LIMIT + 1)),
    ).rejects.toThrow("socket closed");
  });

  it("sends an invitation as plain text, never wrapped in the tdsp envelope", async () => {
    // A resync request sends through sendEdit like any other frame — covered
    // by the sendEdit tests above.
    const rpc = new FakeRpc();
    const writer = createGroupWriter(rpc, auth);
    await writer.sendInviteMessage("g1", "hello");
    expect(rpc.calls.every((call) => !("attachments" in call.params))).toBe(true);
    expect(rpc.calls[0]?.params.message).toBe("hello");
  });
});
