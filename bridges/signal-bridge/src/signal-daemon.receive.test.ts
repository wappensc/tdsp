import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@tdsp/bridge-log";
import { afterEach, describe, expect, it } from "vitest";
import { SocketRpcClient, startSignalDaemon } from "./signal-daemon.ts";

/**
 * What `signal-cli` pushes before the bridge reads it (SIG-5), and a daemon lost while the bridge
 * runs: checked over a real Unix socket with a stand-in daemon, and with a stand-in `signal-cli`
 * executable for how the daemon is started.
 */

const notification = (n: number) =>
  `${JSON.stringify({ jsonrpc: "2.0", method: "receive", params: { n } })}\n`;

describe("notifications signal-cli pushes before the bridge reads them (SIG-5)", () => {
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

  /** A stand-in daemon that writes `onConnect` the moment a connection opens. */
  async function daemon(onConnect: string, bounds?: { count: number; chars: number }) {
    dir = mkdtempSync(join(tmpdir(), "signal-early-"));
    const path = join(dir, "socket");
    const served: Socket[] = [];
    server = createServer((socket: Socket) => {
      open.add(socket);
      served.push(socket);
      socket.write(onConnect);
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
      bounds,
    );
    const failures: string[] = [];
    client.onFailure((reason) => failures.push(reason));
    return { client, events, failures, served };
  }

  const until = async (condition: () => boolean) => {
    for (let i = 0; i < 100 && !condition(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  it("keeps what arrives before any handler and hands it over in order, before what comes later", async () => {
    const { client, served } = await daemon(notification(1) + notification(2));
    await new Promise((resolve) => setTimeout(resolve, 50)); // both read before any handler exists
    const seen: unknown[] = [];
    client.onNotification((_method, params) => seen.push(params));
    served[0]?.write(notification(3));
    await until(() => seen.length === 3);
    expect(seen).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    client.close();
  });

  it("reports a failure, rather than dropping silently, once more arrives than it keeps", async () => {
    const { client, events, failures } = await daemon(
      notification(1) + notification(2) + notification(3),
      { count: 2, chars: 10_000 },
    );
    await until(() => failures.length > 0);
    expect(failures).toHaveLength(1);
    expect(events).toContain("signal-cli-early-notifications-dropped");
    client.close();
  });

  it("reports a failure when the other side closes the socket, and none when the bridge closes it", async () => {
    const lost = await daemon("");
    lost.served[0]?.destroy();
    await until(() => lost.failures.length > 0);
    expect(lost.failures).toEqual(["signal-cli's socket closed"]);
    lost.client.close();
    for (const socket of open) {
      socket.destroy();
    }
    open.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });

    const closed = await daemon("");
    closed.client.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed.failures).toEqual([]);
  });
});

describe("the signal-cli daemon the bridge starts", () => {
  let dir: string;
  const dirs: string[] = [];

  afterEach(() => {
    for (const each of dirs.splice(0)) {
      rmSync(each, { recursive: true, force: true });
    }
  });

  /** A stand-in `signal-cli`: records its arguments, serves the socket, and exits after `exitAfterMs`. */
  function standIn(exitAfterMs: number): string {
    dir = mkdtempSync(join(tmpdir(), "signal-cli-standin-"));
    dirs.push(dir);
    const script = join(dir, "signal-cli");
    writeFileSync(
      script,
      `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const { createServer } = require("node:net");
writeFileSync(${JSON.stringify(join(dir, "argv.json"))}, JSON.stringify(process.argv.slice(2)));
const socket = process.argv.find((arg) => arg.startsWith("--socket=")).slice("--socket=".length);
const server = createServer(() => {});
server.listen(socket);
setTimeout(() => process.exit(3), ${exitAfterMs});
`,
    );
    chmodSync(script, 0o755);
    return script;
  }

  it("asks signal-cli to receive only once the bridge's connection is there (SIG-5)", async () => {
    const signalCliPath = standIn(60_000);
    const daemon = await startSignalDaemon({
      signalCliPath,
      dataDir: join(dir, "data"),
      logger: createLogger({ component: "test", sink: () => {} }),
    });
    const argv = JSON.parse(readFileSync(join(dir, "argv.json"), "utf8")) as string[];
    expect(argv).toContain("--receive-mode=on-connection");
    expect(argv).toContain("daemon");
    await daemon.stop();
  });

  it("reports a failure once signal-cli exits while the bridge runs, and none after stop()", async () => {
    const signalCliPath = standIn(300);
    const daemon = await startSignalDaemon({
      signalCliPath,
      dataDir: join(dir, "data"),
      logger: createLogger({ component: "test", sink: () => {} }),
    });
    const failures: string[] = [];
    daemon.onFailure((reason) => failures.push(reason));
    for (let i = 0; i < 100 && failures.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(failures).toHaveLength(1);
    await daemon.stop();

    const again = await startSignalDaemon({
      signalCliPath: standIn(60_000),
      dataDir: join(dir, "data"),
      logger: createLogger({ component: "test", sink: () => {} }),
    });
    const none: string[] = [];
    again.onFailure((reason) => none.push(reason));
    await again.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(none).toEqual([]);
  });
});
