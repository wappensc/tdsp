# together-TDSP agent guide

## Mission

TDSP synchronises a collaboratively edited document between a small group of people by
carrying CRDT updates inside ordinary messages of a messenger they already use — a Signal
group, a Matrix room, an email thread. There is no TDSP server, no WebSocket and no
peer-to-peer connection: every byte of document data travels as a message of that
messenger, and every participant merges what arrives locally.

This repository holds the specification ([SPECIFICATION.md](SPECIFICATION.md), normative)
and a reference implementation of every conformance class; [CONFORMANCE.md](CONFORMANCE.md)
says what it has verified, and against what. TDSP assumes cooperating participants and adds
no security layer of its own: a document is as confidential as its messenger channel. Never
state a security property that the specification, a test and CONFORMANCE.md do not back.

## Start every task here

1. `git switch main && git pull`, then `git status --short --branch`.
2. Inspect document metadata with `rg -n "^(title|summary|read_when):" docs` and read only
   the documents whose `read_when` conditions match the task. For protocol work, read the
   relevant sections of SPECIFICATION.md; its requirements are numbered (e.g. `CTL-20`).
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
- A Dependabot pull request assigned to you is yours to assess before `@wappensc/ci`
  reviews it: CONTRIBUTING.md, "A Dependabot pull request". Never change the pin format,
  the cooldown or `.github/dependabot.yml` to make an update go through.
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
- A change an application or another implementation can notice adds a line under
  "Unreleased" in CHANGELOG.md (CONTRIBUTING.md says which).

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

## Code map and commands

Where each part of the specification lives in the code is [docs/code-map.md](docs/code-map.md);
every package script, and how to run a single test file, is [docs/commands.md](docs/commands.md).

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
