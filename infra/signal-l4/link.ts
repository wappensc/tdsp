/**
 * network-policy: loopback. Links a running Signal bridge to a Signal account, talking only to
 * that bridge on a loopback address.
 *
 * Linking is the one step of the Signal setup no script can finish: the bridge becomes an
 * additional device of the account, and only the account's **phone** can authorize a new
 * device, by scanning a QR code (Signal app → Settings → Linked devices → Link new device).
 * Signal Desktop cannot do it, not even on the same machine: a linked device cannot link
 * another. So this asks the bridge for a link (`POST /auth/link`), shows the link as a QR
 * code in the terminal for a person to scan, and waits until the bridge reports the account
 * (`GET /auth/status`). It is needed once per bridge: the link lives in the bridge's data
 * directory (`SIGNAL_CLI_CONFIG_DIR`) from then on.
 *
 * Afterwards it lists the groups the account can see (`GET /channels`), which a freshly
 * linked device learns from the phone a few seconds after the link, not at once.
 */
import QRCode from "qrcode";
import { isLoopbackUrl } from "../../packages/loopback/src/index.ts";

export interface LinkIo {
  readonly print: (text: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

export interface LinkOptions {
  /** How often the bridge is asked whether the phone has scanned the code. */
  readonly pollMs?: number;
  /** How long to wait for the scan before giving up. */
  readonly timeoutMs?: number;
  /** How long to wait for the account's groups to arrive after the link. */
  readonly groupsTimeoutMs?: number;
}

export interface LinkOutcome {
  /** `true` when the bridge was linked before this ran, and nothing was scanned. */
  readonly alreadyLinked: boolean;
  readonly accountId: string | undefined;
  readonly groups: readonly { id: string; name: string }[];
}

interface AuthStatus {
  linked: boolean;
  accountId?: string;
}

async function authStatus(url: string): Promise<AuthStatus> {
  const response = await fetch(`${url}/auth/status`);
  if (!response.ok) {
    throw new Error(`GET ${url}/auth/status failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as AuthStatus;
}

async function listGroups(url: string): Promise<{ id: string; name: string }[]> {
  const response = await fetch(`${url}/channels`);
  if (!response.ok) {
    throw new Error(`GET ${url}/channels failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as { id: string; name: string }[];
}

/** The QR code for `uri`, drawn with characters a terminal shows as black and white blocks. */
export function qrForTerminal(uri: string): Promise<string> {
  return QRCode.toString(uri, { type: "terminal", small: true });
}

export async function linkSignalBridge(
  url: string,
  io: LinkIo,
  options: LinkOptions = {},
): Promise<LinkOutcome> {
  const { pollMs = 2000, timeoutMs = 10 * 60_000, groupsTimeoutMs = 60_000 } = options;
  if (!isLoopbackUrl(url)) {
    throw new Error(
      `${url} is not a loopback address: a bridge on another machine is reached through a tunnel`,
    );
  }

  const before = await authStatus(url);
  if (before.linked) {
    io.print(`The bridge at ${url} is already linked (account ${before.accountId ?? "unknown"}).`);
    return { alreadyLinked: true, accountId: before.accountId, groups: await listGroups(url) };
  }

  const response = await fetch(`${url}/auth/link`, { method: "POST" });
  if (!response.ok) {
    throw new Error(`POST ${url}/auth/link failed: ${response.status} ${await response.text()}`);
  }
  const { linkingUri } = (await response.json()) as { linkingUri: string };
  io.print(
    [
      "Scan this QR code with the phone of the Signal account this bridge is to use:",
      "Signal app → Settings → Linked devices → Link new device.",
      "",
      await qrForTerminal(linkingUri),
      `If the code does not fit the terminal, turn the link into a QR code another way:\n${linkingUri}`,
      "",
      "Waiting for the scan …",
    ].join("\n"),
  );

  const deadline = io.now() + timeoutMs;
  let status = await authStatus(url);
  while (!status.linked) {
    if (io.now() >= deadline) {
      throw new Error(
        `the phone did not scan the code within ${Math.round(timeoutMs / 1000)} s — run this again for a new one`,
      );
    }
    await io.sleep(pollMs);
    status = await authStatus(url);
  }
  io.print(`Linked: the bridge now acts as account ${status.accountId ?? "unknown"}.`);

  // A new device learns the account's groups from the phone shortly after the link.
  const groupsDeadline = io.now() + groupsTimeoutMs;
  let groups = await listGroups(url);
  while (groups.length === 0 && io.now() < groupsDeadline) {
    await io.sleep(pollMs);
    groups = await listGroups(url);
  }
  return { alreadyLinked: false, accountId: status.accountId, groups };
}
