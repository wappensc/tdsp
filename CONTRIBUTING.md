# Contributing

Thank you for looking. Issues and pull requests are welcome — a question about the
specification, a report that the reference implementation deviates from it, or a second
implementation checking the published test vectors are all useful.

Security issues go through [SECURITY.md](SECURITY.md), not a public issue.

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
- **Dependencies.** A new or updated production dependency must be on an allowed license;
  update `third-party-licenses.json` and run `pnpm run licenses:generate`
  ([THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)).
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
