import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { CREDENTIALS_DIR, HOMESERVER_YAML_PATH, SERVER_NAME, SYNAPSE_IMAGE } from "./config.ts";
import { appendIntoCredentialsDir } from "./docker-fs.ts";

/**
 * Produces `credentials/homeserver.yaml` (+ signing key + log config) by
 * running the official Synapse image's own `generate` mode — the same
 * mechanism its docker/README.md documents; its actual output shape is
 * verified, not assumed from the documentation.
 * `registration_shared_secret` comes back already filled in by `generate`
 * itself (a real, random value — verified, not something this
 * script needs to invent), which is what `provision-test-accounts.ts`
 * later reads back out.
 *
 * Idempotent, matching `matrix:up`'s "safe to run repeatedly" contract:
 * if `homeserver.yaml` already exists, generation is skipped entirely
 * (regenerating would overwrite `registration_shared_secret` and orphan
 * any already-provisioned accounts' passwords against the new one — not
 * that passwords depend on the secret, but the signing key would change
 * under a running server's feet). `matrix:reset` deletes `credentials/`
 * first when a genuinely clean start is wanted.
 */
function generateBaseConfig(): void {
  mkdirSync(CREDENTIALS_DIR, { recursive: true });
  execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${CREDENTIALS_DIR}:/data`,
      "-e",
      `SYNAPSE_SERVER_NAME=${SERVER_NAME}`,
      "-e",
      "SYNAPSE_REPORT_STATS=no",
      SYNAPSE_IMAGE,
      "generate",
    ],
    { stdio: "inherit" },
  );
}

const OVERRIDE_MARKER = "# tdsp test overrides (infra/matrix-testserver/generate-config.ts)";

const OVERRIDES_YAML = `
${OVERRIDE_MARKER}
# Isolated, non-federating local/CI test server: no other
# homeserver can ever reach this one, and test runs register/login/send
# far faster than Synapse's production-tuned rate limits allow by default
# (rc_message defaults to one message per 5s — confirmed against Synapse's
# own config_documentation.md — which a test suite would trip immediately).
federation_domain_whitelist: []
enable_metrics: false
rc_message:
  per_second: 1000
  burst_count: 1000
rc_login:
  address:
    per_second: 1000
    burst_count: 1000
  account:
    per_second: 1000
    burst_count: 1000
  failed_attempts:
    per_second: 1000
    burst_count: 1000
rc_registration:
  per_second: 1000
  burst_count: 1000
rc_joins:
  local:
    per_second: 1000
    burst_count: 1000
  remote:
    per_second: 1000
    burst_count: 1000
`;

/**
 * Appends isolated-local-test-server overrides Synapse's own `generate`
 * doesn't set. Appended, not merged/rewritten: none of these keys exist
 * in a freshly generated file (verified by inspecting
 * one), so a plain append cannot create a duplicate top-level YAML key —
 * safer than assuming PyYAML's last-key-wins duplicate handling.
 * Idempotent via `OVERRIDE_MARKER`, same "run `matrix:up` repeatedly
 * without harm" contract as `generateBaseConfig`. The append itself goes
 * through `docker-fs.ts`'s `appendIntoCredentialsDir` rather than a
 * direct `fs.appendFileSync` — see that module's own doc comment for why
 * a direct host-side write here fails on real Linux CI (confirmed by a
 * real, failing run) even though `homeserver.yaml` is readable directly.
 */
function applyTestOverrides(): void {
  const content = readFileSync(HOMESERVER_YAML_PATH, "utf8");
  if (content.includes(OVERRIDE_MARKER)) {
    return;
  }
  appendIntoCredentialsDir("homeserver.yaml", OVERRIDES_YAML);
}

if (existsSync(HOMESERVER_YAML_PATH)) {
  console.log(`${HOMESERVER_YAML_PATH} already exists — skipping generation.`);
} else {
  generateBaseConfig();
}
applyTestOverrides();
console.log("Matrix test server config ready.");
