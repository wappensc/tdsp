# Network-egress policy

TDSP's reference implementation opens **no network connection except the ones it
declares**. The document engine and the adapters that run in a browser reach loopback
only — the local bridge, nothing else. A bridge process reaches exactly **one configured
messenger endpoint** (a homeserver, a mail server) and nothing else, plus its own
loopback listener. This file says what that promise covers, how it is enforced, and how
to change it on purpose.

It is a property of this implementation, not a requirement of the protocol: another
implementation of [SPECIFICATION.md](../SPECIFICATION.md) may be built differently. It is
stated here because the confidentiality a TDSP document has comes from the messenger it
rides on (SPECIFICATION.md §15), and a library that quietly opened a second connection
would undermine exactly that.

## Two zones

**Zone A — packages and local tooling.** Nothing here may reach anything but loopback.

| Scope | Rule |
| --- | --- |
| `packages/reconciliation`, `packages/document-protocol`, `packages/messenger-port`, `packages/messenger-mock` | **No network primitive at all.** These have no reason to touch the network in any form; a grant for one of them is refused. |
| `packages/messenger-signal`, `packages/messenger-matrix`, `packages/messenger-email` | **Loopback destinations only** — the local bridge. Each adapter refuses a bridge URL that is not a loopback address. |
| `tools/`, `infra/` | **Loopback only.** Test tooling talks to the local test servers and to local bridges; never to a real messenger. |

**Zone B — bridge processes** (`bridges/*`). A bridge may reach **exactly one configured
messenger endpoint**, and accept connections on its own loopback listener.

Zone B is a declared exemption, not a hidden one: Matrix and email have no local daemon a
bridge could talk to instead, so `bridges/matrix-bridge` talks to the homeserver and
`bridges/email-bridge` to the SMTP and IMAP servers directly. `bridges/signal-bridge`
opens no TCP connection at all — it speaks to `signal-cli`'s daemon over an owner-only
Unix domain socket, and `signal-cli` reaches Signal's servers as a separate program.
What the policy buys in Zone B is that the one permitted destination is declared and
everything else fails: a third-party library inside a bridge cannot quietly reach a
second host.

**Outside the policy: the workflows.** The CI workflows and the scripts beside them in
`.github/` run on GitHub's machines and talk to GitHub, as every workflow does:
`.github/scripts/repo-settings-collect.sh`, for one, asks the GitHub API how the
repository is configured ([repository-settings.md](repository-settings.md)). They are not
part of the code this policy covers, and nothing in `packages/`, `bridges/`, `tools/` or
`infra/` calls them.

## The policy file and the double opt-out

[`network-policy.json`](../network-policy.json) is the one reviewable record of every file
permitted to perform network I/O. Each entry names the file, its zone, a destination
class and a written reason. The destination classes are:

- `loopback` — may dial a loopback address (or, for the Signal bridge, a Unix socket);
- `loopback-listener` — may accept connections on loopback;
- `configured-messenger-endpoint` — may dial the one configured messenger endpoint.
  Zone B only: a file under `packages/` can never be granted it, whatever its entry says.

Allowing a file to use the network takes **two hand-written places that must agree**:

1. an annotation at the code site, in a comment near the top of the file:
   `network-policy: loopback` (or one of the other two classes);
2. a matching entry in `network-policy.json`, with its reason.

Either one alone fails the build. An annotation without an entry fails; an entry without
an annotation fails; a file with a network primitive and neither fails; an entry and an
annotation that name different classes fail. The point is that weakening the promise is
never a one-line change someone makes in passing.

## Enforcement

No single check is enough; each covers what the others cannot see.

| Layer | Catches | Blind to |
| --- | --- | --- |
| `pnpm run netcheck` ([tools/netcheck.ts](../tools/netcheck.ts)) — a static scanner | Network primitives in first-party source, including ambient globals such as `fetch` and `WebSocket` that no import reveals | Third-party code; anything computed at runtime |
| `pnpm run depcruise` ([.dependency-cruiser.cjs](../.dependency-cruiser.cjs)) | The engine, the profile or the port interface depending on a concrete adapter; any package importing a transport module (`net`, `http`, `tls`, `ws`, `y-websocket`, …) | Ambient globals; third-party internals |
| The Vitest runtime guard ([tools/network-guard.ts](../tools/network-guard.ts)) | Any JavaScript connection attempt during a test, **third-party libraries included**: it patches `net.Socket.prototype.connect`, which a global `fetch()` passes through too, and refuses any non-loopback TCP destination | Native modules; code no test exercises |
| A `connect-src` Content Security Policy | Any connection a browser page attempts, at real runtime | Only covers the browser; this repository ships no page, so setting it is the application's part (for example `connect-src 'self' http://127.0.0.1:*`) |
| The CI job `network-isolation` | **Everything, native modules included**: the whole test suite runs as a user whose non-loopback egress the kernel refuses (`iptables -m owner`), after a canary proves the block is in effect | Only what the suite exercises, and only in CI |

The native case is real: `@matrix-org/matrix-sdk-crypto-nodejs` is a Rust binding that
does not go through Node's network stack, so only the kernel-level block would see it
open a socket.

`pnpm run verify:network` runs netcheck, depcruise and the guard's own tests in one go;
run it whenever you touch anything network-related.

### These checks never skip

The tests that need a local Synapse or Greenmail skip cleanly when the server is down —
right for a test that needs infrastructure, wrong for an invariant, because a skipped
invariant check looks exactly like a passing one. So netcheck, depcruise and the guard
run unconditionally in the blocking `ci` job. The CI workflow lists its steps one by one
rather than calling `pnpm run ci`, so a check has to be registered in both places; a
meta-test ([tools/netcheck-wiring.test.ts](../tools/netcheck-wiring.test.ts)) asserts that
the guard is wired into `vitest.config.ts`, that the blocking job runs netcheck, and that
no `continue-on-error` has crept onto it.

## Adding a network connection

1. Ask whether it is needed. A package in Zone A that wants the network is almost always
   a design problem, not a policy one.
2. Put the `network-policy:` annotation at the top of the file, with a sentence on why.
3. Add the entry to `network-policy.json` with the same class and a reason a reviewer can
   check against the code.
4. Run `pnpm run verify:network`.

A pull request that touches `network-policy.json` should get a reviewer's explicit
attention; the file is the whole promise in one place.
