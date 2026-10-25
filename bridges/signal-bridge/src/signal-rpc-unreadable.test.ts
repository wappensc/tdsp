import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@tdsp/bridge-log";
import { afterEach, describe, expect, it } from "vitest";
import { SocketRpcClient } from "./signal-daemon.ts";

/**
 * A line from `signal-cli` that the bridge cannot read, or a notification one of its handlers
 * cannot, does not keep it from the lines after it, nor ends the process (BRG-18): checked over a
 * real Unix socket with a stand-in daemon.
 */
describe("SocketRpcClient and a line it cannot read (BRG-18)", () => {
  let dir: string;
  let server: Server;
  const open = new Set<Socket>();

  afterEach(async () => {
    for (const socket of open) {
      socket.destroy();
    }
    open.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  const notification = (n: number) =>
    `${JSON.stringify({ jsonrpc: "2.0", method: "receive", params: { n } })}\n`;

  it("reads on past a line that is no object and a notification a handler throws on, and answers the call", async () => {
    dir = mkdtempSync(join(tmpdir(), "signal-rpc-unreadable-"));
    const path = join(dir, "socket");
    server = createServer((socket: Socket) => {
      open.add(socket);
      socket.setEncoding("utf8");
      socket.once("data", (chunk: string) => {
        const { id } = JSON.parse(chunk.slice(0, chunk.indexOf("\n"))) as { id: string };
        // One chunk, so that a throw would also cost the lines after it in the same chunk.
        socket.write(
          `null\n5\n[1]\n${notification(1)}${notification(2)}${JSON.stringify({ jsonrpc: "2.0", id, result: "ok" })}\n`,
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    const socket = createConnection(path);
    open.add(socket);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    const events: string[] = [];
    const client = new SocketRpcClient(
      socket,
      createLogger({
        component: "signal-bridge",
        sink: (_line, record) => events.push(record.event),
      }),
      1000,
    );
    const throwing: unknown[] = [];
    const reading: unknown[] = [];
    client.onNotification((_method, params) => {
      throwing.push(params);
      if ((params as { n: number }).n === 1) {
        throw new Error("this handler cannot read it");
      }
    });
    client.onNotification((_method, params) => reading.push(params));

    await expect(client.call("version")).resolves.toBe("ok");
    expect(throwing).toEqual([{ n: 1 }, { n: 2 }]);
    expect(reading).toEqual([{ n: 1 }, { n: 2 }]);
    expect(events.filter((event) => event === "signal-cli-unparseable-line")).toHaveLength(3);
    expect(events).toContain("notification-unreadable");
    client.close();
  });
});
