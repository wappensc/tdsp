import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@tdsp/bridge-log";
import { afterEach, describe, expect, it } from "vitest";
import { SocketRpcClient } from "./signal-daemon.ts";

/**
 * SPECIFICATION.md BRG-14: what the bridge buffers of one answer from `signal-cli` is
 * bounded, whatever `signal-cli` sends — checked over a real Unix socket with a stand-in daemon.
 */
describe("SocketRpcClient's bound on one line from signal-cli (BRG-14)", () => {
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

  /** A stand-in daemon answering each request with what `answer` returns for its id. */
  async function daemon(answer: (id: string) => string[]) {
    dir = mkdtempSync(join(tmpdir(), "signal-rpc-line-"));
    const path = join(dir, "socket");
    server = createServer((socket: Socket) => {
      open.add(socket);
      let buffered = "";
      let writing = Promise.resolve();
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffered += chunk;
        let at = buffered.indexOf("\n");
        while (at !== -1) {
          const { id } = JSON.parse(buffered.slice(0, at)) as { id: string };
          buffered = buffered.slice(at + 1);
          // Piece by piece, a moment apart, as a large answer arrives over a socket — and one
          // answer after another, as signal-cli writes whole lines.
          const pieces = answer(id);
          writing = writing.then(async () => {
            for (const piece of pieces) {
              socket.write(piece);
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
          });
          at = buffered.indexOf("\n");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    const socket = createConnection(path);
    open.add(socket);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    const events: string[] = [];
    const logger = createLogger({
      component: "signal-bridge",
      sink: (_line, record) => events.push(record.event),
    });
    return { client: new SocketRpcClient(socket, logger, 1000), events };
  }

  const result = (id: string, value: string) =>
    `${JSON.stringify({ jsonrpc: "2.0", id, result: value })}\n`;

  it("fails the call a line past the bound would answer, reads none of it, and stays usable", async () => {
    let calls = 0;
    const { client, events } = await daemon((id) => {
      calls += 1;
      if (calls === 1) {
        // Past the bound, in pieces, as a large answer arrives.
        const line = result(id, "A".repeat(5000));
        return [line.slice(0, 1500), line.slice(1500, 3000), line.slice(3000)];
      }
      return [result(id, "small")];
    });
    await expect(client.call("getAttachment")).rejects.toThrow(/longer than 1000 characters/);
    expect(events).toContain("signal-cli-line-too-long");
    await expect(client.call("version")).resolves.toBe("small");
    client.close();
  });

  it("reads a line just under the bound", async () => {
    const { client } = await daemon((id) => {
      const padding = 1000 - result(id, "").length;
      return [result(id, "B".repeat(padding))];
    });
    const value = await client.call<string>("getAttachment");
    expect(value.length).toBeGreaterThan(900);
    client.close();
  });
});
