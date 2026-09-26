import { describe, expect, it } from "vitest";
import {
  getAttachmentBytes,
  listGroups,
  parseIncomingGroupMessage,
  type SignalRpc,
  sendGroupMessage,
} from "./signal-api.ts";

/**
 * L0 — a fake `SignalRpc` stands in for `signal-cli`'s daemon entirely, no
 * real binary involved (docs/testing.md). The shapes here (`listGroups`'
 * `id`/`name`, a group `dataMessage`'s `groupInfo.groupId`) follow
 * SPECIFICATION.md §13.2 and the real `signal-cli` responses; these tests pin
 * down this module's own parsing logic, while the L4 tests check it against a
 * real `signal-cli`.
 */
class FakeRpc implements SignalRpc {
  calls: { method: string; params?: Record<string, unknown> }[] = [];
  results = new Map<string, unknown>();

  async callRpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    if (!this.results.has(method)) {
      throw new Error(`FakeRpc: no result configured for ${method}`);
    }
    return this.results.get(method) as T;
  }

  onNotification(): () => void {
    return () => {};
  }
}

describe("listGroups", () => {
  it("maps signal-cli's own field names and drops entries with no id", async () => {
    const rpc = new FakeRpc();
    rpc.results.set("listGroups", [{ id: "g1", name: "Team chat" }, { name: "no id, dropped" }]);
    const groups = await listGroups(rpc, "+15551234567");
    expect(groups).toEqual([{ groupId: "g1", name: "Team chat" }]);
    expect(rpc.calls[0]).toEqual({ method: "listGroups", params: { account: "+15551234567" } });
  });
});

describe("sendGroupMessage", () => {
  it("passes account/groupId/message through and returns the send timestamp", async () => {
    const rpc = new FakeRpc();
    rpc.results.set("send", { timestamp: 1700000000000, results: [] });
    const result = await sendGroupMessage(rpc, "+15551234567", "g1", '{"tdsp": 1}');
    expect(result).toEqual({ timestamp: 1700000000000 });
    expect(rpc.calls[0]).toEqual({
      method: "send",
      params: { account: "+15551234567", groupId: "g1", message: '{"tdsp": 1}' },
    });
  });

  it("passes attachments through as signal-cli's own `attachments` parameter, and only when there are some", async () => {
    const rpc = new FakeRpc();
    rpc.results.set("send", { timestamp: 1, results: [] });
    await sendGroupMessage(rpc, "+15551234567", "g1", "{}", [
      "data:application/octet-stream;base64,AQ==",
    ]);
    await sendGroupMessage(rpc, "+15551234567", "g1", "{}", []);
    await sendGroupMessage(rpc, "+15551234567", "g1", "{}");
    expect(rpc.calls[0]?.params).toEqual({
      account: "+15551234567",
      groupId: "g1",
      message: "{}",
      attachments: ["data:application/octet-stream;base64,AQ=="],
    });
    expect(rpc.calls[1]?.params).not.toHaveProperty("attachments");
    expect(rpc.calls[2]?.params).not.toHaveProperty("attachments");
  });

  it("throws a clear error if signal-cli's response carries no timestamp", async () => {
    const rpc = new FakeRpc();
    rpc.results.set("send", { results: [] });
    await expect(sendGroupMessage(rpc, "+15551234567", "g1", "{}")).rejects.toThrow(
      /did not return a timestamp/,
    );
  });
});

describe("getAttachmentBytes", () => {
  it("asks for the attachment by id in the group it arrived in, and decodes the Base64", async () => {
    const rpc = new FakeRpc();
    rpc.results.set("getAttachment", Buffer.from([1, 2, 3, 250]).toString("base64"));
    const bytes = await getAttachmentBytes(rpc, "+15551234567", "g1", "abc123.bin");
    expect([...bytes]).toEqual([1, 2, 3, 250]);
    expect(rpc.calls[0]).toEqual({
      method: "getAttachment",
      params: { account: "+15551234567", groupId: "g1", id: "abc123.bin" },
    });
  });

  it("also reads an answer that carries the Base64 in a `data` field", async () => {
    const rpc = new FakeRpc();
    rpc.results.set("getAttachment", { data: Buffer.from([9, 8]).toString("base64") });
    expect([...(await getAttachmentBytes(rpc, "+1", "g1", "x"))]).toEqual([9, 8]);
  });

  it("refuses an answer that carries no data, rather than reading it as an empty frame", async () => {
    const rpc = new FakeRpc();
    for (const answer of [null, {}, 5, { data: 5 }, []]) {
      rpc.results.set("getAttachment", answer);
      await expect(getAttachmentBytes(rpc, "+1", "g1", "x")).rejects.toThrow(/did not return data/);
    }
  });
});

describe("parseIncomingGroupMessage", () => {
  it("extracts sender/timestamp/message/groupId from a real-shaped envelope", () => {
    const result = parseIncomingGroupMessage({
      envelope: {
        source: "+15559876543",
        sourceUuid: "abc-uuid",
        dataMessage: {
          timestamp: 1700000000123,
          message: '{"tdsp": 1,"kind":"frame"}',
          groupInfo: { groupId: "g1", type: "DELIVER" },
        },
      },
    });
    expect(result).toEqual({
      groupId: "g1",
      sender: "abc-uuid",
      timestamp: 1700000000123,
      message: '{"tdsp": 1,"kind":"frame"}',
      attachments: [],
    });
  });

  it("reads the attachments signal-cli lists, and skips an entry it could never read back", () => {
    const result = parseIncomingGroupMessage({
      envelope: {
        sourceUuid: "abc-uuid",
        dataMessage: {
          timestamp: 1,
          message: "{}",
          groupInfo: { groupId: "g1" },
          attachments: [
            { id: "abc123.bin", size: 5000, contentType: "application/octet-stream" },
            { id: 7, size: 1 },
            { id: "no-size" },
            null,
          ],
        },
      },
    });
    expect(result?.attachments).toEqual([{ id: "abc123.bin", size: 5000 }]);
  });

  it("treats attachments that are not a list as none", () => {
    const result = parseIncomingGroupMessage({
      envelope: {
        sourceUuid: "abc-uuid",
        dataMessage: {
          timestamp: 1,
          message: "{}",
          groupInfo: { groupId: "g1" },
          attachments: "nope",
        },
      },
    });
    expect(result?.attachments).toEqual([]);
  });

  it("ignores a message without an ACI rather than falling back to the phone number (SIG-2)", () => {
    const result = parseIncomingGroupMessage({
      envelope: {
        source: "+15559876543",
        dataMessage: {
          timestamp: 1,
          message: "hi",
          groupInfo: { groupId: "g1" },
        },
      },
    });
    // The phone number never equals a MemberId (`/whoami` answers the ACI), so a delivery
    // attributed to it could never match the creator — or worse, match a different spelling.
    expect(result).toBeNull();
  });

  it("returns null for a direct (non-group) message", () => {
    const result = parseIncomingGroupMessage({
      envelope: { source: "+1", dataMessage: { timestamp: 1, message: "hi" } },
    });
    expect(result).toBeNull();
  });

  it("returns null for a receipt/typing notification with no dataMessage", () => {
    const result = parseIncomingGroupMessage({
      envelope: { source: "+1", receiptMessage: { timestamps: [1] } },
    });
    expect(result).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(parseIncomingGroupMessage(null)).toBeNull();
    expect(parseIncomingGroupMessage("not an object")).toBeNull();
    expect(parseIncomingGroupMessage({})).toBeNull();
  });
});
