# together-TDSP agent guide

## Mission

TDSP synchronises a collaboratively edited document between a small group of people by
carrying CRDT updates inside ordinary messages of a messenger they already use — a Signal
group, a Matrix room, an email thread. There is no TDSP server, no WebSocket and no
peer-to-peer connection: every byte of document data travels as a message of that
messenger, and every participant merges what arrives locally.

This repository holds the specification ([SPECIFICATION.md](SPECIFICATION.md), normative)
and a reference implementation of every conformance class; [CONFORMANCE.md](CONFORMANCE.md)
says what that implementation has verified, and against what. TDSP adds no security layer
of its own: a document is as confidential as the messenger channel it travels in. Never
state a security property that the specification, a test and CONFORMANCE.md do not back.

## Start every task here

1. `git switch main && git pull`, then `git status --short --branch`.
2. Inspect document metadata with `rg -n "^(title|summary|read_when):" docs` and read only
   the documents whose `read_when` conditions match the task. For protocol work, read the
   relevant sections of SPECIFICATION.md; its requirements are numbered (e.g. `CTL-12`).
3. Before changing anything the CI role owns ([.github/CODEOWNERS](.github/CODEOWNERS)),
   read [CONTRIBUTING.md](CONTRIBUTING.md), "Roles".
4. Before starting or exploring local or real-messenger test infrastructure (Docker, the
   local Synapse and Greenmail servers, real Signal or email accounts, bridges on other
   machines), read [docs/testing.md](docs/testing.md).
5. For implementation work, run the smallest relevant tests before and after.

All Markdown files in `docs/` must begin with YAML frontmatter containing:

- `title`: human-readable document name
- `summary`: one sentence describing the document
- `read_when`: concrete situations in which the document is relevant

Keep metadata accurate when the document changes.

## How a change reaches `main`

- `main` takes no direct push. Work on a branch, then `gh pr create --fill` and
  `gh pr merge --auto --squash`: the pull request merges itself once the four CI jobs pass.
- A pull request that touches a file the CI role owns waits for `@wappensc/ci`; tell the
  user when you open one. Never work around the rules: no `--admin` merge, no change to the
  ruleset, no moving a check to where the CI role does not own it.
- A failing `*.wire.test.ts` is a decision, not a test to fix: explain which kind of change
  it is (incompatible, addition, specification) and which version of the specification it
  needs. Only the CI role accepts it, with `pnpm run wire:lock -- --accept <kind>`.
- A license outside `license-policy.json` needs the CI role's approval of that one package.
  Never change the policy to make the check pass.
- A security test (`*.security.test.ts`) depends only on the code it tests and on helpers
  inside its own file.
- After a merge, check the CI runs on `main`, the Repository settings workflow included.

## Working method

- Default to interactive iteration. Build a small, observable slice, show the result, and
  refine it with the user.
- Write a formal plan only when ambiguity, security impact, a wire change, or
  cross-component behavior makes an informal iteration unsafe.
- Verify, do not assume: confirm a claim about a library or a messenger's API, and that a
  fix works, with a throwaway probe before relying on it or writing it down; delete the
  probe afterwards. Make every new check fail once on purpose before trusting it.
- Reproduce a finding the user reports before judging it; check the direct signal of a
  piece of infrastructure before stating a cause.
- Decisions with consequences are the user's: explain the options, what each leads to and
  a recommendation, then ask. When a requirement would need a complex or fragile design,
  offer giving it up as an option.
- Say when a name comes from a vendor's SDK or API rather than from this repository.
- Check each command's exit code on its own; a pipe can hide a failure.
- Keep this file below 200 lines. Put durable detail in indexed `docs/` files.
- Prefer direct CLI tools (`git`, `gh`, package scripts, Docker) over MCP integrations.
- Make atomic commits: one coherent, independently reversible change each, with a message
  that says why. Do not mix cleanup, refactoring, and feature behavior in one commit.
- Never commit secrets, credentials, private keys, messenger account data, or private
  email addresses, and never read a real credentials file; `credentials/` is ignored.
- Leave no local-only commits or branches at the end of a session.

## Specification and implementation

- SPECIFICATION.md is normative; the code follows it. A change to the wire, a requirement
  or a binding changes the specification first, in the same pull request, following §14.
- Code comments cite requirement IDs and give reasons; they never tell the project's
  history. A cited ID must exist.
- A change that verifies something new, or finds that a claim no longer holds, updates
  CONFORMANCE.md.

## Architecture constraints

- Reconciliation happens on clients; participants that receive the same set of valid
  updates must converge whatever the delivery order, and however often each arrives.
- Keep the engine (`packages/document-protocol`), the document profile
  (`packages/reconciliation`), the transport contract (`packages/messenger-port`), the
  adapters and the bridges behind explicit boundaries; `.dependency-cruiser.cjs` enforces
  them. The in-memory transport (`packages/messenger-mock`) is for tests only.
- All document data between participants passes through the transport contract
  (`MessengerPort`). Core code must not open WebSocket, WebRTC or other peer channels.
- Packages, tools and test infrastructure reach loopback only; a bridge reaches its one
  configured messenger endpoint and offers its own interface on loopback only. A network
  primitive needs an annotation at the code site and a `network-policy.json` entry
  ([docs/network-policy.md](docs/network-policy.md)); run `pnpm run verify:network`.
- Permissions are `read`, `write` and `creator`, enforced by the engine, not only by an
  application; a document's creator is fixed at creation.
- TDSP adds no encryption of its own; changing that is a change to the specification.
- Tests cover loss, duplicates, reordering, unauthorized writes, membership changes, and
  convergence.
- See SPECIFICATION.md (§2 architecture, §15 security considerations) for the rest.

## Where things live in the code

- One message carries two wrappers (SPECIFICATION.md §2.2): the envelope, which only a
  bridge reads to route by `documentId`, and inside it the frame, which only the engine
  reads. Adapters and bridges pass a frame on unparsed (ARC-3).
- `DocumentEngine` (`packages/document-protocol/src/index.ts`) holds control state (§7)
  and bootstrap and resync (§8), and composes one module per other part of the
  specification: `framing.ts` and `strict-json.ts` (§4), `profile.ts` (§5; the profile
  itself is `packages/reconciliation`), `resync-gate.ts` (RSY-3), `send-scheduler.ts` and
  `sync-policy.ts` (§9.1–9.3), `fragments.ts` (§9.4–9.5), `loss-detector.ts` (§10),
  `invitation.ts` (§11.3).
- The three bridges share one layout: `index.ts` (environment, bind to 127.0.0.1),
  `server.ts` (the local bridge interface, §12.6), `bind-store.ts` (`documentId` ↔
  channel, §12.2), `sync-state.ts` (receiving), `send-failure.ts` (§3.4) and
  `transport-profile.ts` (§3.5). Each adapter (`packages/messenger-*`) is an HTTP client
  of its bridge.
- Every transport runs the conformance suite from `@tdsp/messenger-port/contract` in its
  `contract.test.ts` (§3.6).
- There is no build step: package `exports` point at `src/index.ts`, and bridges run under
  `node --experimental-strip-types`, so their relative imports carry `.ts` extensions.
- A test's level is an explicit list in `vitest.config.ts`: a new test that needs Synapse,
  Greenmail or a real account must be added to the L2 or L4 list there, or it runs in L0
  and skips itself. In CI, `tools/test-run-check.ts` fails a job when the security, wire,
  or Matrix and email groups skipped instead of ran.
- `wire/wire-lock.json` hashes the specification's wire sections (§4, §5, §7, §11, §13,
  Appendices A and B) as well as the wire files, so a change of wording in those sections,
  even an editorial one, fails `tools/wire-lock.wire.test.ts`.

## Repository conventions

- TypeScript on Node.js 22.6 or later, a pnpm workspace (`packages/*`, `bridges/*`),
  Biome, dependency-cruiser, Vitest.
- Keep generated files and dependencies out of Git.
- Do not copy or adapt third-party code without a decision recorded for it. A distributed
  (not just build-time) dependency is recorded in `third-party-licenses.json`, with its
  license text tracked in `THIRD-PARTY-NOTICES.md` (`pnpm run licenses:generate`); which
  licenses are accepted is `license-policy.json`, the CI role's.
- Use the repository-local Git identity configured with the account's id-based GitHub
  noreply email.

## Verification

A change is done when `pnpm run ci` passes, documentation metadata remains accurate, and
`git diff --check` reports no whitespace errors. A change to a bridge also runs the L2
tests against the local servers. Security-relevant changes also require a test that would
fail if transport isolation, authorization, convergence, or a claimed real-messenger
guarantee regressed.

## Commands

Run from the repo root:

- `pnpm install` — install and link the workspace.
- `pnpm run ci` — lint, dependency rules, network policy, licenses, type check and tests.
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
  one level ([docs/testing.md](docs/testing.md)).
- `pnpm run matrix:up` / `email:up` (and `:down`, `matrix:reset`) — the local Synapse and
  Greenmail for the L2 tests; `pnpm run test:l2` resets and restarts Synapse first.
- `pnpm run test:l4-signal`, `test:l4-email`, `test:l4-email-bridges` — against real
  accounts, only with their configuration; `pnpm run signal:link <bridge url>` links a
  Signal bridge by QR code.
- `pnpm run wire:lock` — compare the wire with `wire/wire-lock.json`; accepting a change is
  the CI role's (CONTRIBUTING.md).
- `pnpm run repo:settings` — the full check of the GitHub settings, as the admin or CI
  role ([docs/repository-settings.md](docs/repository-settings.md)).
- `pnpm run bench` — Vitest's bench mode; logs numbers, not gated in CI.

To run a single test file, use Vitest's own filtering rather than a separate script,
e.g. `pnpm exec vitest run packages/reconciliation/src/index.test.ts`.
