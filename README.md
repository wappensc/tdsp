# TDSP — Together Document Sync Protocol

[![CI](https://github.com/wappensc/tdsp/actions/workflows/ci.yml/badge.svg)](https://github.com/wappensc/tdsp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Spec: TDSP 1.0](https://img.shields.io/badge/spec-TDSP%201.0-informational)](SPECIFICATION.md)
[![Node.js ≥ 22.6](https://img.shields.io/badge/node-%E2%89%A5%2022.6-brightgreen)](package.json)
[![TypeScript: strict](https://img.shields.io/badge/TypeScript-strict-3178c6)](tsconfig.base.json)
[![Messengers: Signal · Matrix · Email](https://img.shields.io/badge/messengers-Signal%20%C2%B7%20Matrix%20%C2%B7%20Email-8a2be2)](SPECIFICATION.md#13-messenger-bindings)

TDSP synchronises a collaboratively edited document between a small group of people by
carrying CRDT updates inside ordinary messages of a messenger they already use — a Signal
group, a Matrix room, an email thread. There is no TDSP server, no WebSocket and no
peer-to-peer connection: every byte of document data travels as a message of that
messenger, and every participant merges what arrives locally.

A TDSP document is therefore exactly as confidential as the channel it rides on, and a
message's sender exactly as authentic as the messenger makes it. TDSP adds no encryption
of its own; it inherits the messenger's.

This repository contains

- **[SPECIFICATION.md](SPECIFICATION.md)** — the protocol, TDSP 1.0: the transport
  contract, the payload frame, document profiles, control state, bootstrap and resync,
  send scheduling, loss detection, invitations, bridges, and the Signal, Matrix and email
  bindings, as numbered requirements with their rationale;
- **a reference implementation** in TypeScript of every conformance class the
  specification defines;
- **[CONFORMANCE.md](CONFORMANCE.md)** — what of the specification that implementation
  has verified, and against what, and what it has not.

> [!IMPORTANT]
> **TDSP adds no security layer of its own.** It does not encrypt, sign or
> authenticate document data itself: a TDSP document is exactly as confidential as
> the messenger channel it travels in, and a change is exactly as authentic as that
> messenger's sender authentication makes it. End-to-end encryption comes from
> Signal, from an encrypted Matrix room, or — for email — from OpenPGP through your
> own `gpg`. Choose the messenger and the channel by the protection your document
> needs: an unencrypted Matrix room, or email without PGP, protects nothing.
>
> What TDSP does enforce itself — who may write, and that only a document's creator
> changes its membership — is stated in
> [SPECIFICATION.md §15](SPECIFICATION.md#15-security-considerations). The
> specification and the reference implementation have been reviewed externally;
> what is verified against real messengers, and the known limits, are listed in
> [CONFORMANCE.md](CONFORMANCE.md). Please report security issues as described in
> [SECURITY.md](SECURITY.md).

## How it fits together

```text
application (editor, UI)
        │
   DocumentEngine ── document profile (yjs-paragraphs/1)        packages/document-protocol
        │                                                        packages/reconciliation
   MessengerPort — the transport contract                        packages/messenger-port
        │
   adapter (in the application)                                  packages/messenger-{signal,matrix,email}
        │  HTTP on 127.0.0.1 only
   bridge (a local process of its own)                           bridges/{signal,matrix,email}-bridge
        │
   the messenger: signal-cli · a Matrix homeserver · SMTP/IMAP
```

An application edits a CRDT document through the **engine**. The engine turns each
change into a frame and hands it to a **transport** — anything that implements
`MessengerPort`. For a real messenger, the transport is an **adapter** that talks to a
**bridge** on the same machine; the bridge owns the messenger account and its credentials
and is the only part that reaches the network. An in-memory transport with deterministic
fault injection (`packages/messenger-mock`) stands in for a messenger in tests.

| Directory | What it is |
| --- | --- |
| `packages/messenger-port` | The transport contract, transport profiles, the send-failure classification, and the conformance suite every transport must pass |
| `packages/document-protocol` | The engine (`DocumentEngine`) and the invitation link's reader and writer; the published frame and invitation test vectors |
| `packages/reconciliation` | The document profile `yjs-paragraphs/1`, built on [Yjs](https://github.com/yjs/yjs), and the attribution tracker |
| `packages/messenger-mock` | The in-memory transport for tests |
| `packages/messenger-signal`, `-matrix`, `-email` | One adapter per binding |
| `bridges/signal-bridge`, `matrix-bridge`, `email-bridge` | One bridge per binding |
| `packages/bridge-log` | Bridge logging that never writes a credential or document content ([docs/bridge-logging.md](docs/bridge-logging.md)) |
| `packages/loopback` | The one check of whether an address is this machine |
| `infra/` | Local test servers (Synapse, Greenmail) and the configuration of the real-account tests |
| `tools/` | The network-egress and license checks |

## Getting started

Requirements: Node.js 22.6 or later and pnpm 11 (`corepack enable` picks the pinned
version). Docker, for the local test servers; optionally `gpg` and `signal-cli`.

```sh
pnpm install
pnpm run ci            # lint, dependency rules, network policy, licenses, typecheck, tests
```

That runs every test that needs nothing outside the process; the rest skip themselves.
To run the tests against a real local Synapse and Greenmail as well:

```sh
pnpm run matrix:up && pnpm run email:up
pnpm run test:l2
pnpm run matrix:down && pnpm run email:down
```

[docs/testing.md](docs/testing.md) describes the three test levels, including the opt-in
tests against real Signal accounts and real mailboxes.

Two people editing one document, over the in-memory transport:

```ts
import { DocumentEngine } from "@tdsp/document-protocol";
import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import { getPlainText, insertPlainText } from "@tdsp/reconciliation";

const port = new InMemoryMessengerPort();
const alice = await DocumentEngine.create("doc-1", "alice", port);
await alice.setMembership("bob", "write");

// Bob learns the creator from the invitation; the creator's answer is his bootstrap.
const bob = await DocumentEngine.join("doc-1", "bob", port, undefined, {
  creatorMemberId: "alice",
});
await alice.sync();
await bob.sync();

alice.edit((fragment) => insertPlainText(fragment, 0, "Hello"));
await alice.flush();
await bob.sync();

bob.edit((fragment) => insertPlainText(fragment, 5, ", world"));
await bob.flush();
await alice.sync();

getPlainText(alice.fragment); // "Hello, world"
```

With a real messenger the code is the same; only the transport changes — an adapter
pointed at a running bridge. Each bridge is started with
`pnpm --filter @tdsp/<name>-bridge run start` and configured through its environment
(see the top of its `src/index.ts`); [docs/testing.md](docs/testing.md) walks through
setting up two Signal bridges and two email bridges, and lists what you have to provide
yourself for that: real accounts, and a `TDSP_ROOT` variable pointing at your checkout.

## Design constraints

- **All document data crosses the transport contract.** The engine and the profile open
  no connection of their own; the dependency rules in
  [.dependency-cruiser.cjs](.dependency-cruiser.cjs) enforce it.
- **No network connection except the declared ones.** Packages reach loopback only; a
  bridge reaches its one configured messenger endpoint. Every network primitive needs an
  annotation at the code site *and* an entry in [network-policy.json](network-policy.json),
  checked in CI, down to a kernel-level egress block
  ([docs/network-policy.md](docs/network-policy.md)).
- **Reconciliation is local.** Participants that have received the same set of valid
  updates converge, whatever the order and however often each arrived.
- **Permissions (`read`, `write`, `creator`) are enforced by the engine**, not only in a
  user interface, and a document's creator is fixed at creation.

## Background

This project was motivated by the paper
[*End-to-End Encrypted Collaborative Documents*](https://www.usenix.org/conference/usenixsecurity26/presentation/knabenhans)
by Christian Knabenhans, Zayd Maradni and Carmela Troncoso (USENIX Security 2026). The paper shows that an
end-to-end encrypted collaborative document can be composed from two parts: a client-side
reconciliation mechanism with strong convergence, and an end-to-end encrypted
asynchronous broadcast channel that handles membership, permissions and offline delivery.
TDSP and its reference implementation were worked out to put that construction onto
messengers people already use, so that the broadcast channel — and its encryption — is
one they already have.

The paper's authors published their own implementation, SignalCD — built on Automerge and
Signal — at
[spring-epfl/signal-collaborative-documents](https://github.com/spring-epfl/signal-collaborative-documents).
TDSP contains no code from it: it implements the same construction independently, on Yjs,
and for more than one messenger. This repository is an independent work; it is not
affiliated with or endorsed by the paper's authors.

## How this was made

This repository was developed with the help of AI, in a clear division of roles: **a
human thinks and steers — the AI is the diligent, hard-working worker.** The direction,
the design decisions, what to build and what to leave out, and every review were a
person's. The code, the tests and most of the text were written by an AI coding agent
(Anthropic's Claude, in Claude Code) working under that direction. That is also why this repository leans so heavily on
tests, published test vectors and an explicit conformance statement: a claim here is
meant to be checkable, not to be taken on trust — whoever wrote it.

## Contributing, security, licenses

- [CONTRIBUTING.md](CONTRIBUTING.md) — how to work on this repository: the roles, and how a
  change reaches `main`.
- [SECURITY.md](SECURITY.md) — how to report a vulnerability.
- [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) — the dependencies and the external
  programs the bridges run, with their licenses.

TDSP — the specification and the reference implementation — is released under the
[MIT License](LICENSE).
