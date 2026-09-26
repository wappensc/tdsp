/**
 * network-policy: loopback — Zone A (docs/network-policy.md). Test infrastructure: polls the local Synapse container's /health on localhost:18008.
 */
import { HEALTH_URL } from "./config.ts";

/**
 * One-shot liveness probe against Synapse's own `/health` endpoint —
 * verified (docker/README.md's documented
 * `curl -fSs http://localhost:8008/health` health-check example): plain
 * HTTP, no auth, returns quickly whether or not the homeserver has
 * finished its own startup migrations. Never throws — a connection
 * refused/reset (container not up yet) is exactly the "not ready" case
 * callers need to handle the same way as an HTTP error status.
 */
export async function checkHealthOnce(timeoutMs = 2000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(HEALTH_URL, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The CI-safety gate for test files, like `bridges/signal-bridge`'s
 * analogous `hasSignalCli()` pattern — except this
 * checks a live endpoint instead of a PATH binary, since there is no
 * local install to detect. A single probe, no retries: by the time a test
 * file's top-level `await` runs, `matrix:up` (or the CI job's equivalent
 * steps) has already had its own `wait-for-health.ts` retry loop succeed
 * or the whole `matrix:up`/CI step would have failed first.
 */
export async function hasTestMatrixHomeserver(): Promise<boolean> {
  return checkHealthOnce();
}
