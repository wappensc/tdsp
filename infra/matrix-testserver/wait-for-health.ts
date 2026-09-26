import { HEALTH_URL } from "./config.ts";
import { checkHealthOnce } from "./health.ts";

/**
 * Polls `/health` until Synapse answers or `OVERALL_TIMEOUT_MS` runs out —
 * the "Gesundheitscheck" step of `matrix:up`/the CI job, between
 * `docker compose up -d` (which returns as soon as the container is
 * *created*, not once Synapse has finished its own startup/schema
 * migrations) and `provision-test-accounts.ts` (which needs a fully
 * running server).
 */
const OVERALL_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 500;

const deadline = Date.now() + OVERALL_TIMEOUT_MS;
let healthy = false;
while (Date.now() < deadline) {
  if (await checkHealthOnce()) {
    healthy = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
}

if (!healthy) {
  console.error(`Timed out after ${OVERALL_TIMEOUT_MS}ms waiting for ${HEALTH_URL} to respond.`);
  process.exit(1);
}

console.log(`${HEALTH_URL} is healthy.`);
