# TDSP reference implementation: conformance status

A statement about one implementation — the one in this repository — at one point in
time, in the manner of RFC 7942. It is not part of the protocol: the protocol is
[SPECIFICATION.md](SPECIFICATION.md). What this file says is verified is verified by the
tests in this repository; what it says is not verified is a known gap, not an oversight
waiting to be found.

**Status as of TDSP 1.4 (18 October 2026).**

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
| TRN-12 (a reason none of the four) | `TransportSendError.retryable` is false only for `too-large` and `rejected`, so the engine keeps a change whose send failed for a reason it does not know, and retries it as `unavailable`. Tested at L0 against the in-memory transport |
| BND, MTX (Matrix) | L2 against a local Synapse: binding, send and receive, attachments in ordinary and encrypted rooms, the Megolm history caveat, crypto-store persistence across a restart, edits and redactions refused. **Not run against a public homeserver from this repository**. An unencrypted frame in an encrypted room — one bound as encrypted, or one where the bridge saw an `m.room.encryption` or `m.room.encrypted` event while it ran — is never delivered (§13.3); tested at L0 against a faked homeserver (`sync-state.encryption.security.test.ts`). A room bound as plain whose encryption was turned on while the bridge was stopped counts as encrypted only once such an event reaches it again |
| BND, SIG (Signal) | L0 with a fake `signal-cli`; L2 for the daemon's own mechanics. L4 against production Signal: the transport conformance suite and the attachment tests (up to and beyond 4 MiB) pass against two bridges of this repository, each on a machine of its own with its own linked account, reached through tunnels — three runs in a row, on Node.js 22 ([docs/testing.md](docs/testing.md)). Two accounts and one group only. A group message that Signal rate-limited, or could not deliver, for some members fails as a 429 or a 502 instead of counting as sent (TRN-6); tested at L0 with `signal-cli`'s result per recipient as its 0.14.9 source writes it, **not provoked against real Signal**. A member that is not registered, or whose identity the account does not trust, does not make a frame fail, so it is not accepted for every channel member in that case |
| BND, EML (email) | L2 against a local Greenmail, plain and PGP, with real `gpg`: invitations, signatures, encryption, forged senders and keys refused. L4 against one real provider (GMX): plain and PGP documents, TLS on both connections, the PGP invitation found by the Message-ID its creator chose — passing with two bridges on two machines and with two bridges on the machine running the tests, one run each. **The transport conformance suite at L4 (opt-in, about forty more mails) has not been run from this repository, and no second provider has been tried** |
| BND-2 for email: the 4 MiB bound (Appendix B) | Tested against Greenmail only; **no mail near 8 MiB has been sent through a real provider**. The bound rests on a measured mail overhead and a provider limit of about 10 MiB that is commonly cited, not verified |
| BRG-13 for email | An incoming mail is read by a partial IMAP fetch of at most 10 MiB plus one byte; a larger one is rejected unparsed and never handed to `gpg`. Tested against Greenmail at the exact boundary; not tried against a real provider |
| BRG-14 for Signal | A `signal-cli` answer longer than 16 Mi characters is dropped unread; tested with a stand-in daemon over a Unix socket, not with a real `signal-cli` |
| BRG-11, BRG-12 for Signal | Another message under a delivered id (author and sent timestamp) is recorded as `message-replaced` and never delivered; the same message again is dropped. Tested at L0 with synthetic `receive` notifications. Kept in memory while the bridge runs: after a restart a message offered again is delivered again, which the engine takes as a duplicate (TRN-8) |
| EML-10 scope | The vectors pass. **No provider has been tested for how it treats the letter case of an address**; "case-insensitive" is the binding's stated scope, not a measured property |
| EML-11 | A message a mail server accepted for some participants only is reported as failed. Tested with the real SMTP sender over an injected transport that refuses one recipient; no real provider has been made to refuse one |
| EML-8 trust states | The implementation records no fingerprint comparison, so it **never reaches "verified"**: a creator is at most "consistent" with the user's own keyring. By design |
| LBI-6 | The status mappings of all three bridges are tested with faked errors; none has been provoked against a real provider's rate limit. For Signal the faked error follows `signal-cli`'s source (JSON-RPC code -5, with the stated wait in its send results), not a captured response |
| TRN-11 for Matrix (the wait) | A refused send or upload passes on the wait of the homeserver's `Retry-After` header, and the body's `retry_after_ms` only without one; tested at L0 against a faked homeserver, not against a rate-limited real one |
| TRN-7 for Matrix (a deep to-device event) | A to-device event nested deeper than 32 levels is left out of what the crypto machine gets, and the frames of the same `/sync` round are delivered; tested at L0 against a faked homeserver. That writing such an event out throws was measured on Node.js 24 at 8 000 levels and on Node.js 22.23.3 (CI) at 10 000, not on Node.js 26 |
| BRG-10 (the bound channel) | The Signal and the Matrix bridge deliver a frame for a document only from the group or room it is bound to, and record an edit, a delete or a redaction only from there; a frame, an edit and a deletion from another group or room of the account reach nobody and leave no record. Tested at L0 (`sync-state.channel.security.test.ts` in both bridges). The email bridge checks every message against the thread's participant set (EML-2), tested at L2 |
| LOS-1 … LOS-8 | Tested against the in-memory transport; not against a real messenger that actually loses a message. A bridge restart that falls entirely between two polls is not noticed (§10) |
| §10, LOS-8: "ok" without evidence | By definition not a claim of completeness. A creator whose request expired unanswered may lack an offline member's change; the engine keeps the *unanswered* outcome observable |
| PRF-6, PRF-8 | A creator resumed under another profile than its persisted control state names is refused before anything is sent; tested at L0. The engine package may open no network connection at all (netcheck, and the `network-isolation` CI job at kernel level), and knows only its built-in profile and those its application passes in `profiles`, so it cannot fetch one a document names |
| §5.5, profiles an application supplies | Creating, bootstrapping, converging, restoring and attributing a document of a supplied profile, with its own projection or the default one, and the refusals of a supplied profile with a built-in, repeated or invalid id: tested at L0 with a profile defined in the test. **No external profile is part of this repository or tested by it**; that one conforms is the claim of whoever supplies it (PRF-7) |
| §5.6 layers (LAY-1, LAY-3) | A layer beside `content` reaches a participant whose application ignores it, passes on from that participant to a restarted creator and in a whole-state resend, survives a restore, and changes neither the projection nor attribution; tested at L0 with a layer defined in the test. `layers` lists a document's layers for an application to show (LAY-2). **No layer is defined or shipped here**; what a layer means is its definition's (LAY-4) |
| TRN-17 (`channelMembers`) | The mock, and the Matrix, Signal and email bridges and adapters answer it: Matrix with the room's joined members, Signal with the group's members by ACI from `signal-cli listGroups`, email with the thread's fixed participant set; a channel this account is not in is refused (404) without naming anyone. The conformance suite checks it against the mock (L0), Synapse and Greenmail (L2); against Signal only at L4, not yet run. The Signal member list follows signal-cli's source (0.14.9), not a captured response |
| MTX-4 (an account's devices) | L2 against a local Synapse: two devices of one account, each a bridge, in an encrypted room; what one sends, the other receives as the account's own message. Fails when the room key is withheld from the account's own devices |
| EML-12 (an address's devices) | A frame mail's copy is appended to the account's sent folder, which is created when missing, and searched on receipt; with PGP the mail is encrypted to the sender's key too. L2 against Greenmail with two bridges on one mailbox: the second receives what the first sent, and the other participant receives the mail addressed to the others only, as before. **`EMAIL_SENT_COPY=provider` is not tried against a provider that files sent mail itself; whether GMX does is not verified.** A creator's second email device cannot use the invitation: it is neither in the creator's mailbox nor encrypted to the creator |
| SIG-3 (an account's devices) | L4 against production Signal: two bridges linked to one account, in one group; what one sends, the other delivers under the id the sender got and as the account, an attachment frame included (`l4-own-devices.test.ts`, signal-cli 0.14.9, one run). Fails when the bridge does not read sync transcripts. That an edit and a remote delete sent from another device arrive inside the transcript was seen with `signal-cli receive` directly; that the bridge records them as integrity violations, and ignores a transcript from another sender, is tested at L0 with that shape, not live. **Two devices of one account sending in the same millisecond share a delivery id; not tested** |
| RSY-6, RSY-8, RSY-12, CTL-11, CTL-13 (a member's devices) | A device brings another device of its own member up to date while the creator is offline, with its control state when it holds it without a gap, so the other device may write — or learns it is read-only; without that control state the other device waits for the creator; a new device of the creator continues after the number of the device that answered it. A control snapshot from any other member is ignored, even as an answer to one's own request. Tested at L0 |
| CTL-17 (a conflict kept visible) | Every participant that rejects a different frame under a number it holds reports it once through `onError` and keeps it in `controlConflicts`, with the action it kept and the one it rejected; two devices of the creator acting at once leave each participant naming the conflict, and a new action of the creator on the members concerned brings them all to agree. Tested at L0. Held in memory only: a restarted engine names none |
| CTL-18 (creator devices) | A device of the creator continues after numbers another device used, only after an unbroken run; refuses to issue while it lacks a frame before a number it has seen; gives up and reports a pending frame whose number another device took, also mid-retry. A creator restarted without state continues when it reads every frame it sent. Tested at L0. **Two devices acting at the same moment still collide (CTL-17)**: a limit of TDSP 1.x |
| CTL-19 (a creator's device without control state) | A device of the creator that joined without persisted control state issues no control frame (`control-state-unknown`), answers with `control: null`, hands nothing to `onControlStateChange` and is not bootstrapped by another member's answer — also while it applies a frame it holds without those before it; a joiner it answers is not bootstrapped either. It learns the control state from another device's snapshot, or by reading the creator's frames from 1 on, which completes a bootstrap whose answer came first; told to proceed, it issues and persists. Tested at L0, with a transport that shows no history and one that delays control frames |
| SND-8, restored content | `join()` can start from persisted content (`restore`): shown at once, not sent as a local edit, counted as undistributed until the engine has sent the whole state once it may edit — at once for the creator, after the bootstrap for anyone else, never while read-only; a change that never left before the restart arrives that way. Tested against the in-memory transport |
| INV-8 (application) | `invitationFromUrl` reads an invitation from a whole link as INV-8 says — the fragment when it carries `tdsp`, the query otherwise, never the two combined; tested at L0. Whether an application reads links through it is the application's part |
| CTL-13, RSY-8, RSY-10 (application: changes the engine refuses) | Typed into the engine's document while the engine refuses it, a change leaves the device in the engine's answer to a creator that restarts: a reader's, one made after a close, and one of a member the creator made read-only, before that member's bootstrap. Held outside the engine's document — in a second replica that follows the engine — none of them reaches anyone, and a writer's held change, applied once its engine may edit, reaches the creator merged with the creator's concurrent edit and attributed to the writer. Tested at L0 against the in-memory transport, holding as an application would; whether an application holds or prevents typing is its part, and this repository contains no application |
| CTL-12, SND-8 (application) | The engine sends no control frame the application could not persist, keeps a control frame whose send failed for now pending and retries it — after a restart too, and without waiting for the creator's next action — and marks changes it could not distribute until a resync; all tested against the in-memory transport. Keeping either across a restart is the application's part, and this repository contains no application |

## Known gaps

What this version does not yet specify precisely or has not built. None of it is hidden
behind a claim elsewhere in the specification.

- **Resource budgets.** Hard, interoperable limits for decoding input size and work are
  given as recommended values (Appendix B), not normative bounds; nesting depth is
  bounded normatively (§1.6).
- **Channel membership changes.** `channelMembers` (TRN-17) is a snapshot of who is in a
  channel when it is asked; no transport reports who joined or left, or when. An
  application learns of a change only by asking again and comparing, and misses someone
  who joined and left between two calls.
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
  is lost issues nothing until another device of the creator tells it the control state, or
  the person lets it proceed at the risk of a conflict (CTL-19). An application that restores persisted content through
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
