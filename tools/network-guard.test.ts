import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { destinationOf, isLoopbackHost, isNetworkGuardInstalled } from "./network-guard.ts";

/**
 * The runtime layer of the network-egress policy. The guard is installed for every test file in
 * this repository by `tools/vitest-setup.ts`, so these tests run *inside*
 * it — which is the point: they assert the real, installed behaviour
 * rather than a re-instantiated copy.
 *
 * The connection attempts below deliberately target documentation and
 * test-net addresses (RFC 5737 / RFC 2606). None of them can succeed, and
 * the guard is expected to refuse them long before that matters.
 */
describe("the guard is actually installed in this worker", () => {
  it("is installed", () => {
    expect(isNetworkGuardInstalled()).toBe(true);
  });
});

describe("it refuses a non-loopback destination, whichever API is used", () => {
  it("blocks global fetch, which is undici, not our code", async () => {
    await expect(fetch("http://192.0.2.1:81/")).rejects.toThrow(/opens no external/);
  });

  it("blocks node:http, the path a third-party library is most likely to take", async () => {
    const { request } = await import("node:http");
    expect(() => request("http://198.51.100.7:80/").end()).toThrow(/Blocked a connection/);
  });

  it("blocks node:tls, which builds on the same socket underneath", async () => {
    const { connect } = await import("node:tls");
    expect(() => connect({ host: "203.0.113.9", port: 443 })).toThrow(/Blocked a connection/);
  });

  it("blocks a raw node:net socket", async () => {
    const { Socket } = await import("node:net");
    expect(() => new Socket().connect({ host: "192.0.2.55", port: 1234 })).toThrow(
      /Blocked a connection/,
    );
  });

  it("blocks the node:net module factory", async () => {
    const net = (await import("node:net")).default;
    expect(() => net.connect({ host: "192.0.2.55", port: 1234 })).toThrow(/Blocked a connection/);
  });

  /**
   * A known, deliberately-visible limit rather than a hidden one. An ESM
   * *named* import of a CJS builtin (`import { connect } from "node:net"`)
   * binds a snapshot at module instantiation, so patching
   * `module.exports.connect` afterwards cannot reach an import that was
   * already bound — and `setupFiles` cannot run before every module in the
   * process is instantiated.
   *
   * It matters less than it looks: `net.connect` builds on `Socket`, which
   * *is* guarded, and the only first-party user of this shape
   * (`bridges/signal-bridge/src/signal-daemon.ts`) connects to a Unix socket,
   * which is never a network destination. The real backstop for what no
   * JavaScript guard can see is the OS-level egress-blocked CI job
   * (`network-isolation` in ci.yml).
   *
   * This test asserts the gap so that it stays measured: if a future Node
   * or Vitest closes it, this goes red and the comment above gets deleted.
   */
  it("does NOT cover a pre-bound ESM named import — a known, tracked gap", async () => {
    const { connect } = await import("node:net");
    const socket = connect({ host: "192.0.2.55", port: 1234 });
    socket.destroy();
    expect(socket).toBeDefined();
  });

  it("blocks a hostname, before any DNS lookup happens", async () => {
    await expect(fetch("http://example.invalid/")).rejects.toThrow(/Blocked a connection/);
  });

  it("names the destination it refused, so the failure is diagnosable", async () => {
    await expect(fetch("http://192.0.2.1:81/")).rejects.toThrow(/192\.0\.2\.1:81/);
  });
});

describe("it lets real loopback work, or the whole suite would fail", () => {
  it("allows a genuine loopback round trip", async () => {
    const server = createServer((_request, response) => response.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      await expect(response.text()).resolves.toBe("ok");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("allows localhost, which resolves to ::1 first on some hosts", async () => {
    const server = createServer((_request, response) => response.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await expect(fetch(`http://localhost:${port}/`).then((r) => r.text())).resolves.toBe("ok");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("destinationOf covers every signature Node accepts", () => {
  it("reads an options object", () => {
    expect(destinationOf([{ host: "10.0.0.1", port: 80 }])).toEqual({
      kind: "tcp",
      target: "10.0.0.1",
      port: 80,
    });
  });

  it("defaults a missing host to localhost, as Node does", () => {
    expect(destinationOf([{ port: 80 }])).toEqual({ kind: "tcp", target: "localhost", port: 80 });
  });

  it("reads the (port, host) form", () => {
    expect(destinationOf([8788, "127.0.0.1"])).toEqual({
      kind: "tcp",
      target: "127.0.0.1",
      port: 8788,
    });
  });

  /**
   * bridges/signal-bridge talks to signal-cli over a Unix domain socket. A
   * filesystem path is not a network destination and must never be
   * refused.
   */
  it("recognises a Unix socket path, in both spellings", () => {
    expect(destinationOf(["/tmp/bridge.sock"])).toEqual({
      kind: "unix",
      target: "/tmp/bridge.sock",
    });
    expect(destinationOf([{ path: "/tmp/bridge.sock" }])).toEqual({
      kind: "unix",
      target: "/tmp/bridge.sock",
    });
  });
});

describe("isLoopbackHost", () => {
  it.each(["127.0.0.1", "127.1.2.3", "localhost", "LOCALHOST", "::1", "[::1]"])(
    "accepts %s",
    (host) => expect(isLoopbackHost(host)).toBe(true),
  );

  it.each(["192.168.1.1", "10.0.0.1", "0.0.0.0", "evil.tld", "localhost.evil.tld", "128.0.0.1"])(
    "refuses %s",
    (host) => expect(isLoopbackHost(host)).toBe(false),
  );
});
