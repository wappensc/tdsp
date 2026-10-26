import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  describeSignalIntegrityEntry,
  readIntegrityLog,
  SignalMessengerPort,
  summarizeSignalIntegrity,
} from "./index.ts";

/**
 * The Signal adapter against a fake bridge, L0. Everything else it does is tested against real
 * Signal accounts (`bridges/signal-bridge`'s L4 tests).
 */

describe("instance() (TRN-19)", () => {
  /** A bridge whose `/health` answers `body` with `status`, every time. */
  async function bridgeAnswering(
    body: unknown,
    status = 200,
  ): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
    const server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it("names the instance the bridge's /health names", async () => {
    const bridge = await bridgeAnswering({ status: "ok", instance: "epoch-1" });
    try {
      await expect(new SignalMessengerPort(bridge.url).instance()).resolves.toBe("epoch-1");
    } finally {
      await bridge.close();
    }
  });

  it("refuses a bridge that names no instance, or an empty one, rather than answer a fixed value (TRN-9)", async () => {
    for (const body of [
      { status: "ok" },
      { status: "ok", instance: "" },
      { status: "ok", instance: 1 },
      null,
    ]) {
      const bridge = await bridgeAnswering(body);
      try {
        await expect(new SignalMessengerPort(bridge.url).instance()).rejects.toThrow(
          /names no instance/,
        );
      } finally {
        await bridge.close();
      }
    }
  });

  it("refuses an answer that is not ok", async () => {
    const bridge = await bridgeAnswering({ error: "down" }, 503);
    try {
      await expect(new SignalMessengerPort(bridge.url).instance()).rejects.toThrow(/503/);
    } finally {
      await bridge.close();
    }
  });
});

describe("the integrity log (BRG-15, SIG-4)", () => {
  it("reads violations and notices as the bridge serves them, and an entry without kind as a violation", () => {
    const violation = { kind: "violation", id: "bob:1", sender: "bob", reason: "message-edited" };
    const notice = {
      kind: "notice",
      id: "me:2",
      recipient: "bob-aci",
      reason: "recipient-untrusted",
    };
    expect(
      readIntegrityLog([
        violation,
        notice,
        { id: "bob:3", sender: "bob", reason: "message-replaced" },
        null,
      ]),
    ).toEqual([
      violation,
      notice,
      { kind: "violation", id: "bob:3", sender: "bob", reason: "message-replaced" },
    ]);
    expect(() => readIntegrityLog({})).toThrow(/not a list/);
  });

  it("words a notice as a warning naming the recipient, and does not count it as a rejected message", () => {
    const notice = {
      kind: "notice",
      id: "me:2",
      recipient: "bob-aci",
      reason: "recipient-untrusted",
    } as const;
    expect(describeSignalIntegrityEntry(notice)).toMatchObject({ severity: "warning" });
    expect(describeSignalIntegrityEntry(notice).text).toContain("bob-aci");
    expect(summarizeSignalIntegrity([notice])).toMatchObject({ severity: "warning" });
    expect(summarizeSignalIntegrity([notice])?.text).not.toContain("rejected");
    const violation = {
      kind: "violation",
      id: "bob:1",
      sender: "bob",
      reason: "message-edited",
    } as const;
    expect(summarizeSignalIntegrity([violation, notice])?.text).toContain(
      "1 incoming message was rejected",
    );
  });
});

describe("receiveSince() (TRN-18, TRN-21)", () => {
  /** A bridge that answers `deliveries-since` with `body`, and records what it was asked. */
  async function bridgeAnswering(body: unknown, status = 200) {
    const asked: string[] = [];
    const server = createServer((req, res) => {
      asked.push(req.url ?? "");
      if (req.method === "GET" && (req.url ?? "").startsWith("/channels/doc-1/deliveries-since")) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}`,
      asked,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it("asks for what came after the cursor and answers the deliveries and truncated", async () => {
    const bridge = await bridgeAnswering({
      deliveries: [{ id: "d2", sender: "bob", payload: "Ag==" }],
      truncated: true,
    });
    try {
      await expect(
        new SignalMessengerPort(bridge.url).receiveSince("doc-1", "bob", "d1"),
      ).resolves.toEqual({
        deliveries: [{ id: "d2", documentId: "doc-1", sender: "bob", payload: "Ag==" }],
        truncated: true,
      });
      await new SignalMessengerPort(bridge.url).receiveSince("doc-1", "bob", undefined);
      expect(bridge.asked).toEqual([
        "/channels/doc-1/deliveries-since?after=d1",
        "/channels/doc-1/deliveries-since",
      ]);
    } finally {
      await bridge.close();
    }
  });

  it("refuses an answer of another shape, and a bridge that does not offer the cursor (TRN-9)", async () => {
    for (const body of [{ deliveries: [] }, { truncated: false }, []]) {
      const bridge = await bridgeAnswering(body);
      try {
        await expect(
          new SignalMessengerPort(bridge.url).receiveSince("doc-1", "bob", "d1"),
        ).rejects.toThrow(/not deliveries and truncated/);
      } finally {
        await bridge.close();
      }
    }
    const old = await bridgeAnswering({}, 404);
    try {
      await expect(
        new SignalMessengerPort(old.url).receiveSince("doc-1", "bob", "d1"),
      ).rejects.toThrow(/404/);
    } finally {
      await old.close();
    }
  });
});
