import { installNetworkGuard } from "./network-guard.ts";

/**
 * Vitest's per-test-file setup: installs the network guard (docs/network-policy.md). `setupFiles` rather
 * than `globalSetup` on purpose: `globalSetup` runs in a *different*
 * process from the tests, so a guard installed there would patch a
 * `node:net` no test ever uses. `setupFiles` runs inside each worker,
 * before that worker's test file is imported.
 */
installNetworkGuard();
