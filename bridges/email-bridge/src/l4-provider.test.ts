import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// infra/ isn't a pnpm workspace package — see contract.test.ts's comment on these relative imports.
import { type L4BridgeHandle, startL4Bridge } from "../../../infra/email-l4/bridge-process.ts";
import {
  EMAIL_L4_ENV_FILE,
  type EmailL4Config,
  emailL4Status,
} from "../../../infra/email-l4/config.ts";
import {
  hasGpgBinary,
  type ProvisionedGpgHomes,
  provisionGpgHomesInChildProcess,
} from "../../../infra/email-testserver/gpg-homes.ts";
import { defineEmailL4Scenarios } from "./l4-scenarios.ts";

/**
 * L4 for the email adapter (docs/testing.md): two real `bridges/email-bridge` **processes on this machine** against **two
 * real mailboxes at a real provider**, with throwaway PGP keys generated for the
 * run (your own keyring is never touched). The scenarios themselves live in
 * `l4-scenarios.ts`.
 *
 * **Never part of CI and never started by accident.** It sends real mail from real
 * accounts, which a provider limits — so it runs only when asked: `L4_EMAIL=1` (the
 * `pnpm run test:l4-email` script), and only with the gitignored
 * `infra/email-l4/credentials/.env.l4.email` (shape: `.env.l4.email.example`) complete.
 * An ordinary `pnpm run test` skips it even with that file present, so that a full run
 * never starts sending real mail by accident. With `L4_EMAIL=1` and a
 * file that is set but wrong, one test fails and names the problem.
 *
 * The bridges are separate processes on purpose: this file only ever talks to them
 * over `http://127.0.0.1`, so the Vitest network guard is never
 * asked to allow a real host, and the bridge's own grant — one configured messenger
 * endpoint — is what reaches the provider. TLS is required by the bridge for every
 * such connection, and `GET /mail/status` proves what each one actually uses.
 *
 * Volume: the default run sends about a dozen mails. The shared `MessengerPort`
 * contract suite (about forty more) is opt-in — `L4_EMAIL_CONTRACT=1` — because
 * providers throttle senders: GMX did, after roughly 35 mails in 20 minutes.
 * `L4_EMAIL_PACE_MS` waits that long before each contract case.
 */
const optedIn = process.env.L4_EMAIL === "1";
const status = emailL4Status();
const ready = optedIn && status.state === "ready" && hasGpgBinary();
const config: EmailL4Config | undefined = status.state === "ready" ? status.config : undefined;

if (optedIn && status.state === "invalid") {
  describe("email L4 configuration", () => {
    it("is complete and valid", () => {
      expect(status.problems, "fix infra/email-l4/credentials/.env.l4.email").toEqual([]);
    });
  });
}

describe.skipIf(!ready)("email adapter, L4 (local): two real bridges, two real mailboxes", () => {
  let keys: ProvisionedGpgHomes;
  let alice: L4BridgeHandle;
  let bob: L4BridgeHandle;
  /**
   * What a run observed, written next to the credentials (gitignored) when it ends:
   * how each connection is secured, and how long real delivery took.
   */
  const observed: Record<string, unknown> = { startedAt: new Date().toISOString() };
  const lastRunFile = EMAIL_L4_ENV_FILE.replace(/\.env\.l4\.email$/, "l4-last-run.json");

  beforeAll(async () => {
    if (!config) {
      return;
    }
    keys = provisionGpgHomesInChildProcess([config.a.address, config.b.address]);
    alice = await startL4Bridge(config.a, keys.homes.get(config.a.address) as string);
    bob = await startL4Bridge(config.b, keys.homes.get(config.b.address) as string);
  }, 180_000);

  afterAll(() => {
    mkdirSync(dirname(lastRunFile), { recursive: true });
    writeFileSync(lastRunFile, `${JSON.stringify(observed, null, 2)}\n`);
    alice?.stop();
    bob?.stop();
    keys?.cleanup();
  });

  defineEmailL4Scenarios({
    alice: () => ({
      url: alice.url,
      address: config?.a.address ?? "",
      log: () => alice.log(),
      mailHost: config?.a.smtp.host ?? "",
    }),
    bob: () => ({
      url: bob.url,
      address: config?.b.address ?? "",
      log: () => bob.log(),
      mailHost: config?.b.smtp.host ?? "",
    }),
    record: (key, value) => {
      observed[key] = value;
    },
  });
});
