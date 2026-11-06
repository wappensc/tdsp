---
title: "Commands"
summary: "Every package script of the repository — install, the checks `pnpm run ci` runs, the test levels, the local test servers, real-account tests, the wire lock and the repository settings — and how to run a single test file."
read_when:
  - "Running a check, a test level or a local test server"
  - "Looking for the script that does a task in this repository"
---
# Commands

Run from the repo root:

- `pnpm install` — install and link the workspace.
- `pnpm run ci` — lint, dependency rules, network policy, requirement IDs, licenses, type
  check and tests.
  GitHub's CI runs the same checks as separate steps, calling each tool directly.
- `pnpm run lint` / `pnpm run lint:fix` — Biome check / check and fix.
- `pnpm run depcruise` — the dependency rules in `.dependency-cruiser.cjs`: the engine,
  the profile and the transport contract never depend on a concrete adapter, and no
  package imports a transport library (except in its own `*.test.ts`/`*.bench.ts`).
- `pnpm run netcheck` — every network primitive needs an annotation at the code site and a
  `network-policy.json` entry. `pnpm run verify:network` — netcheck, depcruise and the
  network guard's tests in one go.
- `pnpm run licenses:check` — every distributed dependency recorded in
  `third-party-licenses.json`, and every license (development tools and external programs
  too) allowed or approved in `license-policy.json`. `pnpm run licenses:generate` —
  regenerate THIRD-PARTY-NOTICES.md's tables after a dependency changes.
- `pnpm run typecheck` — `tsc --noEmit` across the workspace.
- `pnpm run test` / `pnpm run test:watch` — Vitest; `test:l0`, `test:l2`, `test:l4` run
  one level ([docs/testing.md](testing.md)).
- `pnpm run matrix:up` / `email:up` (and `:down`, `matrix:reset`) — the local Synapse and
  Greenmail for the L2 tests; `pnpm run test:l2` resets and restarts Synapse first.
- `pnpm run test:l4-signal`, `test:l4-signal-own-devices`, `test:l4-email`,
  `test:l4-email-bridges` — against real accounts, only with their configuration; `pnpm run signal:link <bridge url>` links a
  Signal bridge by QR code.
- `pnpm run matrix:confirm-device [bridge url]` — signs a running Matrix bridge's device
  with the account's recovery key ([docs/matrix-device-confirmation.md](matrix-device-confirmation.md)).
- `pnpm run wire:lock` — compare the wire with `wire/wire-lock.json`; accepting a change is
  the CI role's (CONTRIBUTING.md).
- `pnpm run repo:settings` — the full check of the GitHub settings, as the admin or CI
  role ([docs/repository-settings.md](repository-settings.md)).
- `pnpm run bench` — Vitest's bench mode; logs numbers, not gated in CI.

To run a single test file, use Vitest's own filtering rather than a separate script,
e.g. `pnpm exec vitest run packages/reconciliation/src/index.test.ts`.
