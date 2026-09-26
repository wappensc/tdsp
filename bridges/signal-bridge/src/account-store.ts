import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Reads `signal-cli`'s own `<dataDir>/data/accounts.json` — the only
 * reliable source found for this account's own ACI (ai UUID). Confirmed
 * live, first real device-link test: `getUserStatus` on the account's
 * own phone number was tried first and found **wrong** — it returned a
 * UUID (`7574f6b0-...`) that matched neither VM's real ACI, almost
 * certainly the PNI (Phone Number Identity, Signal's separate,
 * privacy-motivated UUID namespace for phone-number-based lookups, not
 * account identity), and on the account whose phone-number discovery was
 * disabled it returned `uuid: null` entirely. This file's own `uuid`
 * field, by contrast, matched exactly what a real delivered message's
 * `sourceUuid` reported for that same account on both VMs — i.e. the
 * real ACI, the identifier that actually appears on the wire.
 *
 * A filesystem read rather than a JSON-RPC call on purpose: signal-cli
 * writes this file itself as part of its own account bookkeeping, so
 * reading it needs no network round trip and cannot be affected by a
 * privacy setting the way a lookup-based RPC call can.
 */
export interface LinkedAccount {
  readonly number: string;
  readonly uuid: string;
}

export function readLinkedAccount(dataDir: string): LinkedAccount | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(dataDir, "data", "accounts.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined; // no account linked yet — a normal, expected state
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as { accounts?: readonly Record<string, unknown>[] };
  const first = parsed.accounts?.[0];
  const number = first?.number;
  const uuid = first?.uuid;
  if (typeof number !== "string" || typeof uuid !== "string") {
    return undefined;
  }
  return { number, uuid };
}
