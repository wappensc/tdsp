/**
 * network-policy: loopback — Zone A (docs/network-policy.md). This module patches
 * `node:net` precisely so it can *refuse* connections; it opens none.
 */
import net from "node:net";

/**
 * The runtime layer of the network-egress policy (docs/network-policy.md),
 * installed into every Vitest worker via
 * `setupFiles`. Refuses any connection to a non-loopback destination,
 * loudly, at the moment it is attempted.
 *
 * **Why `node:net` and not just `fetch`.** Wrapping `fetch` alone would
 * only catch callers that use `fetch` — a third-party library reaching
 * for `node:http`, a raw socket, or its own bundled client walks straight
 * past it, and third-party code is the whole reason this layer exists.
 * `node:http`, `node:tls` and `node:http2` all construct a `net.Socket`
 * underneath, so guarding that class covers them together. Why `fetch` is
 * *also* wrapped despite that is an experimental finding, not a belt-and-
 * braces preference — see `installNetworkGuard` below.
 *
 * **What it cannot see**: a native module that opens a socket through
 * its own runtime rather than Node's — the Rust N-API crypto binding is
 * exactly that shape. No JavaScript guard can cover it; that is what the
 * OS-level egress-blocked CI job is for (`network-isolation` in ci.yml).
 */

export interface Destination {
  readonly kind: "unix" | "tcp";
  /** A filesystem path for a Unix socket, or a host for TCP. */
  readonly target: string;
  readonly port?: number;
}

/**
 * Works out where a `Socket.prototype.connect` call is headed, across all
 * three signatures Node accepts: `(options)`, `(path)`, and
 * `(port[, host])`.
 */
export function destinationOf(args: readonly unknown[]): Destination {
  const first = args[0];
  if (typeof first === "object" && first !== null) {
    const options = first as { path?: unknown; host?: unknown; port?: unknown };
    if (typeof options.path === "string") {
      return { kind: "unix", target: options.path };
    }
    return {
      kind: "tcp",
      // Node defaults a missing host to localhost.
      target:
        typeof options.host === "string" && options.host.length > 0 ? options.host : "localhost",
      port: Number(options.port),
    };
  }
  if (typeof first === "string") {
    // The `(path)` form — a Unix domain socket, never a network address.
    return { kind: "unix", target: first };
  }
  const host = typeof args[1] === "string" && args[1].length > 0 ? args[1] : "localhost";
  return { kind: "tcp", target: host, port: Number(first) };
}

/**
 * Deliberately stricter than a DNS resolution would be: a *hostname* that
 * happens to resolve to 127.0.0.1 is still refused, because the guard
 * decides before any lookup and a name is not a promise about where it
 * points. Nothing in this repository connects by such a name.
 *
 * Deliberately its own copy, not `@tdsp/loopback`'s `isLoopbackHost`
 * (which accepts and refuses the same hosts): this guard is one of Decision
 * 0014's independent enforcement layers, there to catch the shipped code — and a
 * layer that imported the shipped code's own check would weaken with it.
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  if (!ipv4) {
    return false;
  }
  const octets = ipv4.slice(1, 5).map(Number);
  return octets.every((octet) => octet <= 255) && octets[0] === 127;
}

export class NetworkEgressViolation extends Error {
  constructor(destination: Destination) {
    super(
      `Blocked a connection to ${destination.target}${
        destination.port ? `:${destination.port}` : ""
      } — this project opens no external network connection. ` +
        "If this is a genuine local endpoint, it must be a loopback address; if a dependency did " +
        "this, that dependency is the problem. See docs/network-policy.md.",
    );
    this.name = "NetworkEgressViolation";
  }
}

let installed = false;

function refuseIfExternal(destination: Destination): void {
  if (destination.kind === "tcp" && !isLoopbackHost(destination.target)) {
    throw new NetworkEgressViolation(destination);
  }
}

/**
 * Idempotent, so a stray second call from a test cannot double-wrap.
 *
 * **Several choke points, not one — established by experiment, not by
 * design taste.** Patching `net.Socket.prototype.connect` alone is enough
 * under plain `node` (a probe there showed a global `fetch()` passing
 * straight through it), but *not* under Vitest, where it catches
 * `new Socket().connect()` and misses both `net.connect()` and `fetch()`.
 * Test-realm and host-realm module instances compare equal and the
 * prototype is visibly patched in both, yet Node's own internals still
 * reach an unpatched path. Rather than reason about which realm owns
 * undici, this wraps every entry point our code and its dependencies can
 * realistically take, and `network-guard.test.ts` asserts each one
 * individually — so a future Node or Vitest change that moves the
 * boundary again shows up as a failing test naming the exact path that
 * regressed, instead of a guard that quietly stops guarding.
 */
export function installNetworkGuard(): void {
  if (installed) {
    return;
  }
  installed = true;

  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(
    this: net.Socket,
    ...args: unknown[]
  ): net.Socket {
    refuseIfExternal(destinationOf(args));
    return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;

  // The module-level factories, which do not always route through the
  // prototype above.
  for (const name of ["connect", "createConnection"] as const) {
    const original = net[name] as (...a: unknown[]) => net.Socket;
    (net as unknown as Record<string, unknown>)[name] = function guardedFactory(
      ...args: unknown[]
    ): net.Socket {
      refuseIfExternal(destinationOf(args));
      return original.apply(net, args);
    };
  }

  // `fetch` is undici, which reaches the network through internals the
  // patches above do not reliably cover. It is also the single most
  // common way anything in this repository talks to anything.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> {
    const url = input instanceof Request ? input.url : String(input);
    let host: string;
    let port: number | undefined;
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      port = parsed.port ? Number(parsed.port) : undefined;
    } catch {
      // A relative URL has no host to reach; let the platform reject it.
      return originalFetch(input, init);
    }
    if (!isLoopbackHost(host)) {
      // A *rejected promise*, not a synchronous throw: real `fetch` never
      // throws synchronously, and callers (the adapters, and applications
      // built on them) are written against that contract with
      // `.catch()` handlers that a sync throw would walk straight past.
      return Promise.reject(new NetworkEgressViolation({ kind: "tcp", target: host, port }));
    }
    return originalFetch(input, init);
  } as typeof fetch;
}

/** True once the guard is in place — used by the wiring meta-test. */
export function isNetworkGuardInstalled(): boolean {
  return installed;
}
