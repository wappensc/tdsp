/**
 * network-policy: loopback. Test infrastructure: asks each of the two configured Signal bridges,
 * on a loopback address, whether it has a linked account.
 *
 * The Signal tests at L4 (docs/testing.md) run against two real, already running
 * `bridges/signal-bridge` processes, each linked to its own real Signal account, and a single
 * Signal group the two accounts share. Signal has no test server and a device link is a slow,
 * one-time, human step (scanning a QR code), so the tests never start or link a bridge
 * themselves; they are told where two ready ones are:
 *
 * - `L4_SIGNAL_BRIDGE_A` — the creator's bridge, e.g. `http://127.0.0.1:8787`
 * - `L4_SIGNAL_BRIDGE_B` — the other member's bridge, e.g. `http://127.0.0.1:8797`
 *
 * Both must be loopback addresses: a bridge on another machine is reached through a tunnel
 * (for example `ssh -L 8797:127.0.0.1:8787 other-machine`), never directly.
 */
import { isLoopbackUrl } from "../../packages/loopback/src/index.ts";

export interface SignalL4Bridges {
  readonly creator: string;
  readonly member: string;
}

/** The two configured bridge URLs, or `undefined` when either is missing or not a loopback URL. */
export function signalL4Bridges(env: NodeJS.ProcessEnv = process.env): SignalL4Bridges | undefined {
  const creator = env.L4_SIGNAL_BRIDGE_A;
  const member = env.L4_SIGNAL_BRIDGE_B;
  if (!creator || !member || !isLoopbackUrl(creator) || !isLoopbackUrl(member)) {
    return undefined;
  }
  return { creator, member };
}

/** Whether the bridge at `url` answers and reports a linked account. Every failure is `false`. */
export async function isSignalBridgeLinked(url: string, timeoutMs = 2000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${url}/auth/status`, { signal: controller.signal });
    if (!response.ok) {
      return false;
    }
    return ((await response.json()) as { linked?: unknown }).linked === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** The gate of every Signal L4 test: both bridges configured, reachable and linked. */
export async function signalL4Ready(): Promise<SignalL4Bridges | undefined> {
  const bridges = signalL4Bridges();
  if (bridges === undefined) {
    return undefined;
  }
  const linked = await Promise.all([
    isSignalBridgeLinked(bridges.creator),
    isSignalBridgeLinked(bridges.member),
  ]);
  return linked.every(Boolean) ? bridges : undefined;
}
