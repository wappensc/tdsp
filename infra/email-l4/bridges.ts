/**
 * network-policy: loopback. Test infrastructure: asks each of two already running email
 * bridges, on a loopback address, whether it has a mailbox configured.
 *
 * The second way to run the email L4 scenarios (docs/testing.md): instead of starting two
 * bridge processes on this machine (`bridge-process.ts`), the test is told where two ready
 * ones are — typically each on a machine of its own, holding its own mailbox and its own
 * PGP key, which is the genuinely cross-machine arrangement:
 *
 * - `L4_EMAIL_BRIDGE_A` — the creator's bridge, e.g. `http://127.0.0.1:9291`
 * - `L4_EMAIL_BRIDGE_B` — the other participant's bridge, e.g. `http://127.0.0.1:9292`
 *
 * Both must be loopback addresses: a bridge on another machine is reached through a tunnel
 * (for example `ssh -L 9291:127.0.0.1:8789 other-machine`), never directly. The test never
 * learns the mailboxes' credentials; each bridge reports its own address.
 *
 * Kept as plain Node with only a relative import, like the rest of `infra/`.
 */
import { isLoopbackUrl } from "../../packages/loopback/src/index.ts";

export interface EmailL4Bridges {
  readonly creator: string;
  readonly member: string;
}

/** The two configured bridge URLs, or `undefined` when either is missing or not a loopback URL. */
export function emailL4Bridges(env: NodeJS.ProcessEnv = process.env): EmailL4Bridges | undefined {
  const creator = env.L4_EMAIL_BRIDGE_A;
  const member = env.L4_EMAIL_BRIDGE_B;
  if (!creator || !member || !isLoopbackUrl(creator) || !isLoopbackUrl(member)) {
    return undefined;
  }
  return { creator, member };
}

/** Whether the bridge at `url` answers and has a mailbox configured. Every failure is `false`. */
export async function isEmailBridgeConfigured(url: string, timeoutMs = 2000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${url}/health`, { signal: controller.signal });
    if (!response.ok) {
      return false;
    }
    return ((await response.json()) as { configured?: unknown }).configured === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Both bridges configured, reachable and holding a mailbox; `undefined` otherwise. */
export async function emailL4BridgesReady(
  env: NodeJS.ProcessEnv = process.env,
): Promise<EmailL4Bridges | undefined> {
  const bridges = emailL4Bridges(env);
  if (bridges === undefined) {
    return undefined;
  }
  const configured = await Promise.all([
    isEmailBridgeConfigured(bridges.creator),
    isEmailBridgeConfigured(bridges.member),
  ]);
  return configured.every(Boolean) ? bridges : undefined;
}
