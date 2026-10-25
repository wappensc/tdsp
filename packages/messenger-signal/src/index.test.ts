import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { SignalMessengerPort } from "./index.ts";

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
