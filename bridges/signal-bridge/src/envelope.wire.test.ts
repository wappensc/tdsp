import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ATTACHMENT_FRAME_LIMIT, BODY_FRAME_LIMIT, sha256Hex } from "./attachment.ts";
import { type AuthStatusSource, createGroupWriter } from "./server.ts";
import type { SignalRpc } from "./signal-api.ts";
import { parseEnvelope } from "./sync-state.ts";

/**
 * The Signal binding's wire, frozen (docs/testing.md, "Wire compatibility";
 * SPECIFICATION.md §13.2): the group message the bridge sends for a frame — in the body up to
 * the body limit, as the message's one attachment above it — and how it reads one back. A
 * difference is a wire change only the CI role may accept (tools/wire-lock.ts). Only the CI
 * role may change this file (.github/CODEOWNERS).
 */

const read = (relative: string): string =>
  readFileSync(new URL(`../../../${relative}`, import.meta.url), "utf8");

const WIRE = JSON.parse(read("wire/signal-v1.json")) as {
  version: number;
  constants: { BODY_FRAME_LIMIT: number; ATTACHMENT_FRAME_LIMIT: number };
  entries: {
    name: string;
    documentId: string;
    frame: string;
    message: string;
    attachments: number;
  }[];
};

const auth: AuthStatusSource = {
  status: { linked: true, accountId: "alice-aci" } as AuthStatusSource["status"],
  phoneNumber: "+15550000001",
  async link() {
    return { linkingUri: "sgnl://x" };
  },
};

class RecordingRpc implements SignalRpc {
  calls: { method: string; params: Record<string, unknown> }[] = [];

  async callRpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    return { timestamp: 1700000000000 + this.calls.length } as T;
  }

  onNotification(): () => void {
    return () => {};
  }
}

describe("Signal group messages at envelope version 1", () => {
  it("keep the limits a sender and a receiver agree on", () => {
    expect({ BODY_FRAME_LIMIT, ATTACHMENT_FRAME_LIMIT }).toEqual(WIRE.constants);
  });

  it.each(WIRE.entries.map((entry) => [entry.name, entry] as const))(
    "%s: sent byte for byte, and read back",
    async (_name, entry) => {
      const rpc = new RecordingRpc();
      await createGroupWriter(rpc, auth).sendEdit("g1", entry.documentId, entry.frame);
      expect(rpc.calls).toHaveLength(1);
      const params = rpc.calls[0]?.params ?? {};
      expect(params.message).toBe(entry.message);
      const attachments = (params.attachments as string[] | undefined) ?? [];
      expect(attachments).toHaveLength(entry.attachments);

      const read = parseEnvelope(entry.message);
      expect(read?.documentId).toBe(entry.documentId);
      if (entry.attachments === 0) {
        expect(read?.frame).toBe(entry.frame);
        return;
      }
      // The attachment carries the frame itself, and the envelope names its size and hash.
      const bytes = new TextEncoder().encode(entry.frame);
      expect(Buffer.from(String(attachments[0]).split(",")[1] ?? "", "base64")).toEqual(
        Buffer.from(bytes),
      );
      expect(read?.attachment).toEqual({ size: bytes.length, sha256: sha256Hex(bytes) });
    },
  );

  it("are what the specification shows in Appendix D", () => {
    const spec = read("SPECIFICATION.md");
    const appendix = spec.slice(spec.indexOf("## Appendix D. Example frames"));
    const envelopes = [...appendix.matchAll(/```json\n([\s\S]*?)\n```/g)]
      .map((match) => match[1] as string)
      .filter((text) => (JSON.parse(text) as { kind: string }).kind === "frame");
    expect(envelopes).toEqual([WIRE.entries[0]?.message]);
  });
});
