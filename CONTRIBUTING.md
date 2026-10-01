# Contributing

Thank you for looking. Issues and pull requests are welcome — a question about the
specification, a report that the reference implementation deviates from it, or a second
implementation checking the published test vectors are all useful.

Security issues go through [SECURITY.md](SECURITY.md), not a public issue.

## Roles, and how a change reaches `main`

Three roles, each a team of the `wappensc` organization:

| Role | May |
| --- | --- |
| **developers** | change code, documentation, the specification's prose and ordinary tests; merge their own pull request once the checks are green |
| **ci** | change what decides whether and how the code is checked (below), and approve such a change made by anyone else; create a release tag ([docs/versioning.md](docs/versioning.md)) |
| **admins** | administer the repository; in an emergency, bypass the rules |

Nothing reaches `main` by a direct push, and nothing without green checks. A change goes
through a pull request, which a developer merges themselves — no reviewer needed — as soon
as the four CI jobs pass:

```sh
git switch -c my-change            # work, commit
git push -u origin my-change
gh pr create --fill
gh pr merge --auto --squash        # merges by itself once the checks are green
```

A pull request that touches a file the CI role owns additionally waits for an approval by
`@wappensc/ci` ([.github/CODEOWNERS](.github/CODEOWNERS)). That is what makes the checks
impossible to sidestep from a developer's change: the workflows run the version of
themselves that the pull request contains, so without that approval a pull request could
simply weaken its own checks.

**Owned by the CI role:**

- the workflows and CODEOWNERS itself (`.github/`);
- the checks and their configuration: `tools/`, `vitest.config.ts`, `tsconfig*.json`,
  `biome.json`, `.dependency-cruiser.cjs`, `network-policy.json`, `license-policy.json`,
  `.nvmrc`;
- the **security tests**, `*.security.test.ts`: authorization and control state, PGP and
  identity, integrity of what a bridge receives, credentials kept out of git, the loopback
  boundary, TLS, logging. A security test depends only on the code it tests and on helpers
  inside its own file, so nothing it relies on can change outside it;
- the **wire**: `wire/`, the published test vectors, and the wire tests,
  `*.wire.test.ts` ([docs/testing.md](docs/testing.md), "Wire compatibility").

What the CI jobs prove besides the tests themselves: every check is called directly, not
through a `package.json` script; the tests that need Synapse or Greenmail actually ran,
none of them skipped; every security and wire test ran and passed
(`tools/test-run-check.ts`).

All of this rests on settings that live on GitHub — who is in which team, what `main`
accepts, who may bypass it. They are listed, and checked automatically and by hand, in
[docs/repository-settings.md](docs/repository-settings.md).

The test *content* of ordinary tests stays a developer's responsibility: a developer can
weaken a functional test, and review of the change is the only guard against that. What a
developer cannot weaken is the machinery above.

### A license outside the policy

`pnpm run licenses:check` accepts `MIT`, `MIT-0`, `Apache-2.0`, `BSD-2-Clause`,
`BSD-3-Clause` and `ISC`, and a choice of licenses when one option is among them. Any other
license — copyleft, commercial, unknown, or none — fails the check until the CI role adds
an approval for that one package, under that exact license, with the reason, to
`license-policy.json` ([THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)).

### A change to the wire

When `tools/wire-lock.wire.test.ts` fails, the wire changed: the bytes a frame, an
invitation or a binding's message would have, a constant sender and receiver agree on, or
the text of a normative wire section of the specification. The report names the kind:

| Kind | What changed | The specification's version | Accept with |
| --- | --- | --- | --- |
| **incompatible** | a frozen entry changed or was removed, or a constant or version | the next major, `2.0` — and the wire version with it (§14, VER-1) | `pnpm run wire:lock -- --accept incompatible` |
| **addition** | only new entries (a new frame kind, a new profile) | the next minor, `1.1` | `pnpm run wire:lock -- --accept addition` |
| **specification** | a wire section's text, with every byte the same | unchanged, or the next patch, `1.0.1` | `pnpm run wire:lock -- --accept specification` |

Only the CI role may run the acceptance: it rewrites `wire/wire-lock.json`, and refuses when
the specification's version (its header line) does not match the kind. Within a version,
a frozen entry is never changed: an incompatible change adds a new file for the new
version (`wire/frames-v2.json`) and leaves the old one as it was.

## The specification and the implementation

[SPECIFICATION.md](SPECIFICATION.md) is normative; the code follows it. A change to the
wire, to a requirement or to a binding changes the specification first, in the same pull
request, and keeps to §14 (versioning). When the code cites a requirement ID, the ID must
exist; when a requirement changes, the tests that cite it change too.

[CONFORMANCE.md](CONFORMANCE.md) says what is verified. A change that verifies something
new — or finds that a claim there no longer holds — updates it.

## Before you open a pull request

```sh
pnpm run ci           # lint, dependency rules, network policy, licenses, typecheck, tests
git diff --check
```

- **Tests.** Behaviour changes come with a test that would fail without them. A change
  touching authorization, convergence, the transport contract or the network policy needs
  a test that fails if that property regresses. Tests needing a local server or a real
  account are described in [docs/testing.md](docs/testing.md); say in the pull request
  which levels you ran.
- **Network.** Adding a network connection anywhere needs both halves of the double
  opt-out, and a reason ([docs/network-policy.md](docs/network-policy.md)). Run
  `pnpm run verify:network`.
- **Dependencies.** Record a new or updated distributed dependency in
  `third-party-licenses.json` and run `pnpm run licenses:generate`. A license outside the
  policy needs the CI role's approval (above).
- **Commits.** One coherent, independently revertible change per commit; do not mix a
  refactoring with a behaviour change.
- **Never commit** credentials, access tokens, private keys, messenger account data or
  real email addresses. Everything under a `credentials/` directory is ignored for that
  reason, and tests check that it stays so.

## Style

Biome formats and lints (`pnpm run lint:fix`). Comments explain *why* — the requirement
behind a rule, the case a check exists for — rather than restating the code.

By contributing you agree that your contribution is licensed under the
[MIT License](LICENSE).
