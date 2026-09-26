# Security policy

TDSP relies on the security of the messenger it runs on and adds none of its own (see
[README.md](README.md)). If you find a security issue, please report it privately rather
than in a public issue.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository: the **Security** tab →
**Report a vulnerability**. The report stays private until a fix is available.

Please include:

- what you found and why it matters — which requirement or claim it breaks, if any
  (a requirement ID from [SPECIFICATION.md](SPECIFICATION.md), a row of
  [CONFORMANCE.md](CONFORMANCE.md), or the network policy in
  [docs/network-policy.md](docs/network-policy.md));
- whether it concerns the **specification** (the protocol itself is unsound) or the
  **reference implementation** (the code does not do what the specification says);
- the steps to reproduce it, ideally as a failing test.

## Before you report

[SPECIFICATION.md §15](SPECIFICATION.md#15-security-considerations) says what TDSP
inherits from the messenger, what it assumes, what it enforces itself and what it
deliberately does not guarantee. Something listed there as not guaranteed — for example
that the in-memory test transport sends plaintext, or that a document is no more
confidential than the channel it rides on — is documented behaviour, not a vulnerability.
[CONFORMANCE.md](CONFORMANCE.md)'s "Known gaps" lists what is not yet specified or built.
A finding that shows one of those gaps is worse than stated is welcome.

## What to expect

This is a small project without a bug-bounty programme or a formal disclosure timeline;
responses are best-effort. Reports are handled against the latest release and the `main`
branch.
