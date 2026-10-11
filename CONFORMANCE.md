# TDSP reference implementation: conformance status

A statement about one implementation — the one in this repository — at one point in
time, in the manner of RFC 7942. It is not part of the protocol: the protocol is
[SPECIFICATION.md](SPECIFICATION.md). What this file says is verified is verified by the
tests in this repository; what it says is not verified is a known gap, not an oversight
waiting to be found.

**Status as of TDSP 1.1 (11 October 2026).**

## How it is verified

The tests are grouped into three levels by what they need
([docs/testing.md](docs/testing.md)):

- **L0** — nothing outside the process: the engine against the in-memory transport, the
  adapters against fake bridges, the bridges against fake messengers, the check tooling.
  Runs everywhere, in CI included.
- **L2** — a real messenger server on the same machine: a local Synapse, a local
  Greenmail, `signal-cli`'s own daemon. Runs in CI and locally.
- **L4** — real accounts at production services: two linked Signal accounts, two
  mailboxes at a real email provider. Opt-in, never part of CI.

The published test vectors ([§3.6](SPECIFICATION.md#36-conformance-suite)) —
`packages/document-protocol/test-vectors/frames-v1.json`, `invitations-v1.json`, and
`bridges/email-bridge/test-vectors/member-ids-v1.json` — pass against the reference
decoder, invitation reader and email bridge. Every example frame in §4.5 and Appendix D
is produced byte for byte by the reference encoder, and Appendix D's Signal envelope by the
Signal bridge; the wire tests check this on every run, and freeze what the reference
implementation puts on each messenger ([docs/testing.md](docs/testing.md), "Wire
compatibility").

**The test vectors are published and self-checked only.** No independently written
implementation has run them yet, so they show that this implementation reads the wire as
the specification says, not that two implementations interoperate.

## By requirement

| Requirement | Status |
|---|---|
| All, in general | Exercised by the tests at L0 and L2. That is evidence for the paths those tests take, **not a verification of every requirement on every path**: the rows below name what is known to be untested |
| FRM, PRF, CTL, RSY, SND, LOS, FRG, DCL, INV (engine) | Tested at L0 against the in-memory transport, including faults: delay, duplication, reordering, loss, a moved-on delivery window, a restarted bridge re-offering old deliveries, refused and rate-limited sends |
| §1.6 nesting limit | The engine refuses a frame, and each bridge an envelope (and the email bridge an invitation's plaintext), nested more than 32 deep before parsing it; tested at L0 at the limit and above it, up to a million levels. The reference implementation's own parser, V8's `JSON.parse`, does not recurse, so this is what makes it draw the line where the specification does, not what keeps it from crashing |
| TRN (transport contract) | The shared conformance suite (`packages/messenger-port/src/contract.ts`) passes against the mock (L0), against two real Matrix bridges and a local Synapse (L2), and against two real email bridges and a local Greenmail (L2). Against Signal it runs at L4 only, and passes there against two bridges of this repository and production Signal |
| BND, MTX (Matrix) | L2 against a local Synapse: binding, send and receive, attachments in ordinary and encrypted rooms, the Megolm history caveat, crypto-store persistence across a restart, edits and redactions refused. **Not run against a public homeserver from this repository** |
| BND, SIG (Signal) | L0 with a fake `signal-cli`; L2 for the daemon's own mechanics. L4 against production Signal: the transport conformance suite and the attachment tests (up to and beyond 4 MiB) pass against two bridges of this repository, each on a machine of its own with its own linked account, reached through tunnels — three runs in a row, on Node.js 22 ([docs/testing.md](docs/testing.md)). Two accounts and one group only |
| BND, EML (email) | L2 against a local Greenmail, plain and PGP, with real `gpg`: invitations, signatures, encryption, forged senders and keys refused. L4 against one real provider (GMX): plain and PGP documents, TLS on both connections, the PGP invitation found by the Message-ID its creator chose — passing with two bridges on two machines and with two bridges on the machine running the tests, one run each. **The transport conformance suite at L4 (opt-in, about forty more mails) has not been run from this repository, and no second provider has been tried** |
| BND-2 for email: the 4 MiB bound (Appendix B) | Tested against Greenmail only; **no mail near 8 MiB has been sent through a real provider**. The bound rests on a measured mail overhead and a provider limit of about 10 MiB that is commonly cited, not verified |
| BRG-13 for email | An incoming mail is read by a partial IMAP fetch of at most 10 MiB plus one byte; a larger one is rejected unparsed and never handed to `gpg`. Tested against Greenmail at the exact boundary; not tried against a real provider |
| BRG-14 for Signal | A `signal-cli` answer longer than 16 Mi characters is dropped unread; tested with a stand-in daemon over a Unix socket, not with a real `signal-cli` |
| EML-10 scope | The vectors pass. **No provider has been tested for how it treats the letter case of an address**; "case-insensitive" is the binding's stated scope, not a measured property |
| EML-11 | A message a mail server accepted for some participants only is reported as failed. Tested with the real SMTP sender over an injected transport that refuses one recipient; no real provider has been made to refuse one |
| EML-8 trust states | The implementation records no fingerprint comparison, so it **never reaches "verified"**: a creator is at most "consistent" with the user's own keyring. By design |
| LBI-6 | The status mappings of all three bridges are tested with faked errors; none has been provoked against a real provider's rate limit. For Signal the faked error follows `signal-cli`'s source (JSON-RPC code -5, with the stated wait in its send results), not a captured response |
| LOS-1 … LOS-8 | Tested against the in-memory transport; not against a real messenger that actually loses a message. A bridge restart that falls entirely between two polls is not noticed (§10) |
| §10, LOS-8: "ok" without evidence | By definition not a claim of completeness. A creator whose request expired unanswered may lack an offline member's change; the engine keeps the *unanswered* outcome observable |
| PRF-6, PRF-8 | A creator resumed under another profile than its persisted control state names is refused before anything is sent; tested at L0. The engine package may open no network connection at all (netcheck, and the `network-isolation` CI job at kernel level), and knows only the profiles it is built with, so it cannot fetch one a document names |
| SND-8, restored content | `join()` can start from persisted content (`restore`): shown at once, not sent as a local edit, counted as undistributed until the engine has sent the whole state once it may edit — at once for the creator, after the bootstrap for anyone else, never while read-only; a change that never left before the restart arrives that way. Tested against the in-memory transport |
| INV-8 (application) | `invitationFromUrl` reads an invitation from a whole link as INV-8 says — the fragment when it carries `tdsp`, the query otherwise, never the two combined; tested at L0. Whether an application reads links through it is the application's part |
| CTL-12, SND-8 (application) | The engine sends no control frame the application could not persist, keeps a control frame whose send failed for now pending and retries it — after a restart too, and without waiting for the creator's next action — and marks changes it could not distribute until a resync; all tested against the in-memory transport. Keeping either across a restart is the application's part, and this repository contains no application |

## Known gaps

What this version does not yet specify precisely or has not built. None of it is hidden
behind a claim elsewhere in the specification.

- **Resource budgets.** Hard, interoperable limits for decoding input size and work are
  given as recommended values (Appendix B), not normative bounds; nesting depth is
  bounded normatively (§1.6).
- **Channel versus control membership.** Who is in the messenger channel and who holds a
  permission in the document are separate states; the specification describes both but
  does not yet define every combination (a grant to a non-member, a member without a
  grant) as a state of its own.
- **Binding wire profiles for interoperability.** The email binding's exact
  MIME/OpenPGP layout and the Matrix binding's `EncryptedFile` fields are what the
  reference bridges do; they are not yet specified to the byte for a second
  implementation, and should be before either binding claims interoperability.
- **The local bridge interface** (§12.6) is optional and not yet stable: body limits,
  paging, content types, caching headers and error codes are not normative.
- **Operations**: logging retention and redaction, and behaviour after a backup, restore
  or upgrade, have no minimum rule yet.
- **A verified PGP mode** — a fingerprint the person confirms before joining — is not
  built.
- **Persistence across restarts** of a creator's control state and of undistributed
  changes is required of an application (CTL-12, SND-8); a creator whose persisted state
  is lost restarts from sequence 0. An application that restores persisted content through
  `join()` need not keep the undistributed mark: the engine treats restored content as
  undistributed, at the cost of one message per restart.
- **Matrix device verification.** Element is moving its clients to exclude devices their
  account has not signed (MSC4153), announced for October 2026. The Matrix bridge's device
  can be signed with the account's recovery key (`pnpm run matrix:confirm-device`,
  [docs/matrix-device-confirmation.md](docs/matrix-device-confirmation.md)); tested against
  a local Synapse, **not tried against Element itself**. Interactive (emoji) verification is
  not built: the crypto library the bridge uses offers none.
- **The email bridge's memory of seen messages** grows with the thread (a few hundred
  bytes per mail); bounding it needs an IMAP UID position.
