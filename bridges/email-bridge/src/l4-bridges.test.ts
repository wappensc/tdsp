import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { EmailMessengerPort } from "@tdsp/messenger-email";
import { afterAll, beforeAll, describe } from "vitest";
// infra/ isn't a pnpm workspace package — see contract.test.ts's comment on these relative imports.
import { emailL4BridgesReady } from "../../../infra/email-l4/bridges.ts";
import { EMAIL_L4_ENV_FILE } from "../../../infra/email-l4/config.ts";
import { defineEmailL4Scenarios } from "./l4-scenarios.ts";

/**
 * L4 for the email adapter against two **already running** bridges (docs/testing.md): the
 * same scenarios as `l4-provider.test.ts`, but the bridges are not started here. They are
 * wherever `L4_EMAIL_BRIDGE_A`/`_B` say (`infra/email-l4/bridges.ts`) — typically each on a
 * machine of its own with its own mailbox and its own persistent PGP key, reached through a
 * tunnel: two separate hosts, two separate keyrings, coordinating only through a real
 * provider. This file knows no credentials; each bridge reports its own address.
 *
 * **Never part of CI and never started by accident.** It sends real mail from real accounts,
 * which a provider limits, so it runs only with `L4_EMAIL=1` (the
 * `pnpm run test:l4-email-bridges` script), and then only when both bridges answer and have a
 * mailbox configured. The bridges are only asked once the opt-in is given.
 */
const ready = process.env.L4_EMAIL === "1" ? await emailL4BridgesReady() : undefined;

describe.skipIf(ready === undefined)(
  "email adapter, L4 (running bridges): two real bridges, two real mailboxes",
  () => {
    const aliceUrl = ready?.creator ?? "";
    const bobUrl = ready?.member ?? "";
    let aliceAddress = "";
    let bobAddress = "";
    const observed: Record<string, unknown> = {
      startedAt: new Date().toISOString(),
      level: "l4-bridges",
    };
    const lastRunFile = EMAIL_L4_ENV_FILE.replace(/\.env\.l4\.email$/, "l4-bridges-last-run.json");

    beforeAll(async () => {
      aliceAddress = (await new EmailMessengerPort(aliceUrl).whoami()).id;
      bobAddress = (await new EmailMessengerPort(bobUrl).whoami()).id;
    }, 60_000);

    afterAll(() => {
      mkdirSync(dirname(lastRunFile), { recursive: true });
      writeFileSync(lastRunFile, `${JSON.stringify(observed, null, 2)}\n`);
    });

    defineEmailL4Scenarios({
      // The mail servers are configured where each bridge runs; a name that is not loopback
      // makes the TLS assertion strict, which is right for a real provider.
      alice: () => ({ url: aliceUrl, address: aliceAddress, mailHost: "configured-at-the-bridge" }),
      bob: () => ({ url: bobUrl, address: bobAddress, mailHost: "configured-at-the-bridge" }),
      record: (key, value) => {
        observed[key] = value;
      },
    });
  },
);
