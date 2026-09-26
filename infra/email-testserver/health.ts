/**
 * network-policy: loopback — Zone A (docs/network-policy.md). Test infrastructure: polls
 * the local Greenmail container's own REST/Swagger admin server on
 * localhost:18080.
 */
import { HEALTH_URL } from "./config.ts";

/**
 * One-shot liveness probe against Greenmail's own admin server root —
 * verified to answer `200` with its Swagger UI page
 * once the container has finished starting. Never throws — a connection
 * refused/reset (container not up yet) is exactly the "not ready" case
 * callers need to handle the same way as an HTTP error status, mirroring
 * `infra/matrix-testserver/health.ts`'s own `checkHealthOnce`.
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
 * The CI-safety gate for test files — mirrors
 * `infra/matrix-testserver/health.ts`'s own `hasTestMatrixHomeserver()`.
 * A single probe, no retries: by the time a test file's top-level
 * `await` runs, `email:up` (or the CI job's equivalent steps) has
 * already had its own `wait-for-health.ts` retry loop succeed, or the
 * whole `email:up`/CI step would have failed first.
 */
export async function hasTestEmailServer(): Promise<boolean> {
  return checkHealthOnce();
}
