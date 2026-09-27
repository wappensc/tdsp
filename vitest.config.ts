import { defineConfig } from "vitest/config";

// One config for the whole workspace. Tests are split into three levels by what they need:
//
// - L0: nothing outside the process — unit and integration tests against the in-memory
//   transport, fakes, and local tools such as gpg.
// - L2: a real messenger server running on this machine — a local Synapse
//   (`pnpm run matrix:up`), a local Greenmail (`pnpm run email:up`), or signal-cli's own daemon.
// - L4: real accounts on a production service — two linked Signal accounts, two mailboxes at a
//   real provider. Opt-in, never part of `pnpm run test`'s default expectations: every file
//   skips itself when what it needs is not configured (docs/testing.md).
//
// Level is listed explicitly rather than inferred from a file name: a fake-backed test and a
// live one often sit side by side.
const ALL_TESTS = [
  "packages/*/src/**/*.test.ts",
  "bridges/*/src/**/*.test.ts",
  "infra/*/*.test.ts",
  "tools/**/*.test.ts",
];
const L2_TESTS = [
  "bridges/matrix-bridge/src/attachments.test.ts",
  "bridges/matrix-bridge/src/bind.test.ts",
  "bridges/matrix-bridge/src/contract.test.ts",
  "bridges/matrix-bridge/src/invite.test.ts",
  "bridges/matrix-bridge/src/send-receive.test.ts",
  "bridges/matrix-bridge/src/crypto.security.test.ts",
  "infra/matrix-testserver/matrix-testserver.test.ts",
  "bridges/signal-bridge/src/signal-daemon.test.ts",
  "bridges/email-bridge/src/mail-transport.test.ts",
  "bridges/email-bridge/src/contract.test.ts",
  "bridges/email-bridge/src/pgp-live.security.test.ts",
  "infra/email-testserver/email-testserver.test.ts",
];
const L4_TESTS = [
  "bridges/signal-bridge/src/l4-contract.test.ts",
  "bridges/signal-bridge/src/l4-attachments.test.ts",
  "bridges/email-bridge/src/l4-provider.test.ts",
  "bridges/email-bridge/src/l4-bridges.test.ts",
];

export default defineConfig({
  test: {
    // No top-level `include`: with `projects` set, a root-level `include` would run as an extra,
    // unnamed project on top of the ones below and collect every file again.
    //
    // Refuses any connection to a non-loopback destination, in every worker, including ones
    // opened by third-party libraries (docs/network-policy.md). Inherited by every project
    // through `extends: true`; tools/netcheck-wiring.test.ts asserts it stays here.
    setupFiles: ["tools/vitest-setup.ts"],
    projects: [
      {
        extends: true,
        test: { name: "l0", include: ALL_TESTS, exclude: [...L2_TESTS, ...L4_TESTS] },
      },
      { extends: true, test: { name: "l2", include: L2_TESTS } },
      { extends: true, test: { name: "l4", include: L4_TESTS } },
    ],
  },
});
