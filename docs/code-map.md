---
title: "Code map"
summary: "Where each part of the specification lives in the code: the two wrappers of a message, the engine's modules, the bridges' shared layout, the conformance suite, test levels and the wire lock."
read_when:
  - "Looking for the module, bridge file or test that implements a part of the specification"
  - "Adding a test that needs Synapse, Greenmail or a real account"
  - "A change of wording in the specification or a binding fails the wire lock"
---
# Code map

- One message carries two wrappers (SPECIFICATION.md §2.2): the envelope, which only a
  bridge reads to route by `documentId`, and inside it the frame, which only the engine
  reads. Adapters and bridges pass a frame on unparsed (ARC-3).
- `DocumentEngine` (`packages/document-protocol/src/index.ts`) holds control state (§7) and
  bootstrap and resync (§8), and composes one module per other part: `control-state.ts`,
  `registers.ts` and `clock.ts` (§7), `framing.ts` and `strict-json.ts` (§4), `profile.ts`
  (§5; the profile itself, `split.ts` and `update-bounds.ts` included, is
  `packages/reconciliation`), `resync-gate.ts`, `answer-turn.ts` and `own-requests.ts`
  (§8), `send-scheduler.ts` and `sync-policy.ts` (§9), `steady-clock.ts` (SND-25),
  `digest.ts` (LOS-12), `loss-detector.ts` (§10), `invitation.ts` (§11.3).
- The three bridges share one layout: `index.ts` (environment, bind to 127.0.0.1),
  `server.ts` (the local bridge interface, §12.6), `bind-store.ts` (`documentId` ↔
  channel, §12.2; both in `bindings/`), `sync-state.ts` (receiving), `send-failure.ts` (§3.4) and
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
- `wire/wire-lock.json` hashes the specification's wire sections (§4, §5, §7, §11,
  Appendices A and B), the binding documents in `bindings/` but the local bridge interface,
  and the wire files, with the draft marker while there is one (VER-3), so a change of wording
  in any of them, even an editorial one, fails `tools/wire-lock.wire.test.ts`.
