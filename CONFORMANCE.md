# TDSP reference implementation: conformance status

A statement about one implementation — the one in this repository — at one point in
time, in the manner of RFC 7942. It is not part of the protocol: the protocol is
[SPECIFICATION.md](SPECIFICATION.md) with the documents in [bindings/](bindings/). What
this file says is verified is verified by the tests in this repository; what it says is
not verified is a known gap, not an oversight waiting to be found.

**Status as of the TDSP 2.0 draft (24 October 2026).** The reference engine is the four
packages of [Appendix F](SPECIFICATION.md#appendix-f-reference-implementation) and
implements the draft. The bridges and adapters are those of v1.5.0, which implements TDSP 1.4,
changed to serve the transport profile of §3.5 (TRN-13); what they do not yet implement of the bindings' 2.0
requirements is listed below. Where a row rests on evidence gathered with TDSP 1.4 that has
not been repeated with the 2.0 engine, it says so.

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

Every test of the engine is L0: the engine against the in-memory transport, which offers
the cursor and the instance (TRN-18, TRN-19) and injects delay, duplication, reordering,
loss, a moved-on window and a restarted bridge. Two kinds of test carry most of the weight:

- **Property tests** with a seeded generator, so that a failure replays from its seed: the
  merge of control operations over random histories of two and three creator devices with
  holes, late operations, duplicates and snapshots (`control-state.test.ts`), checked against
  an oracle of what each device had seen; and the splitting of updates into pieces over
  permutations and duplicates (`split.test.ts`).
- **The list of [§1.7](SPECIFICATION.md#17-what-must-stay)**, item by item, as scenarios
  (`invariants.test.ts`), with the email binding's timing reproduced in the in-memory
  transport — its floor, its suggested pacing, and the rate one provider was measured to
  allow — since email is the strictest binding.

The draft's test vectors — `packages/document-protocol/test-vectors/frames-draft-5.json` and
`invitations-draft-5.json` — pass against the reference decoder and invitation reader,
`control-draft-5.json` against the reference merge of control operations, and
`bridges/email-bridge/test-vectors/member-ids-v1.json` against the email bridge;
`wire/frames-draft-5.json` and `wire/invitations-draft-5.json` freeze what the encoder writes.
Every example frame in §4.5 and Appendix D is what the encoder writes, byte for byte
(`spec-examples.wire.test.ts`), and Appendix D's Signal envelope what the Signal bridge
sends. The wire lock (`wire/wire-lock.json`, `tools/wire-lock.ts`) holds those files, TDSP
1.x's frozen ones, the core's normative sections and the binding documents to their
recorded hashes, and asks a change of the draft's wire for a new marker (VER-3). TDSP 1.x's
vectors, `frames-v1.json` and `invitations-v1.json`, stay frozen beside the draft's; the 2.0
engine no longer reads them.

**The test vectors are published and self-checked only.** No independently written
implementation has run them yet, so they show that this implementation reads the wire as
the specification says, not that two implementations interoperate.

## By requirement

| Requirement | Status |
|---|---|
| All, in general | Exercised by the tests at L0 and, for the bridges, L2. That is evidence for the paths those tests take, **not a verification of every requirement on every path**: the rows below name what is known to be untested |
| FRM, PRF, CTL, RSY, SND, LOS, DCL, INV (engine) | Tested at L0 against the in-memory transport, including faults: delay, duplication, reordering, loss, a moved-on delivery window, a restarted bridge re-offering old deliveries, refused and rate-limited sends |
| LOS-12, CTL-31, PRF-1 item 8 (state digests) | SHA-256 against FIPS 180-4's examples and Node's for every length to 200 bytes and a megabyte; RFC 8785 with the RFC's ordering example; the deletion encoding equal in any order, and within a state vector the same bytes as Yjs's within the replica's own; a lost deletion noticed from the heartbeat and healed by the answer it brings, for a member and for the creator, and noticed by a receiver that has edited since; a collision under one dot noticed at equal vectors and found by the creator device in a member's report, nothing taken from it; an answer's last piece states the responder's state. Tested at L0 |
| LOS-13, LOS-14, LOS-17, LOS-18, LOS-21, LOS-22 (streams, numbered pieces) | A lagging device's report does not end the evidence of another device of its member, in either order and before or after the waiting time; an old report offered again changes nothing; healed evidence ends and leaves no traffic; a false alarm from a receiver's own deletions ends with the responder's whole answer; an answer's last piece first, a missing delete piece, two responders under one MemberId, an answer made while editing goes on: an incomplete answer is evidence and asked again, a whole one ends it, without a restart; a later answer of the same stream to someone else, of which a piece that is not the last came, leaves an incomplete answer evidence; overlapping answers to one's own requests, in either order, lost last pieces, late pieces of an older answer, a responder that restarts with a new stream, copies of a piece, pieces that disagree, and the bound on answers counted. Tested at L0 |
| LAY-5, LAY-6, LAY-7 (rights on layers) | A right on a layer wider and narrower than the permission on the document, inherited where none is set, reset to inherit; every document right — `read`, `write`, revoked, unknown — against every set of concurrent layer values, concurrent document rights, and a reset concurrent with a restriction and one made in knowledge of it, as test vectors; a revoked member refused on every layer; a change of a layer the engine may not write, and a change that touches it and the content, refused whole and never sent, nor merged with a change it may send; the creator writes everywhere, a close stops every layer; layer rights in snapshots and among the bounds. Tested at L0 |
| FRM-9 to FRM-12, FRM-15 to FRM-17 (extensions) | A frame, a snapshot and an overlay with an unknown dotted field apply; an unknown name in `crit` is refused as `unsupported-extension`, and a `crit` that names an extension the frame does not carry, or one twice, as `invalid-field`; an unknown field without a dot is still refused. A test extension, `com.example.mood/1`, takes the path of one an engine implements: in an edit, a heartbeat, a request and an answer, from an engine with it to one without and back, critical and not, with a value its definition forbids, as `com.example.mood/2`, nested in a snapshot, and after a restart; it is never passed on. Tested at L0. No extension is defined for use |
| PRF-1 item 9, §4.4 (reading CRDT bytes) | An update or state vector the profile cannot read — noise, one cut short, one with a byte after it — rejects its frame before anything of it is applied or kept, and a request with one no longer keeps a responder from answering others; every kind of content Yjs writes, deletions, collected garbage, skips and pieces read to their end. Tested at L0 and by the test vectors |
| FRM-13, FRM-14 (one reason, no 0 in a vector) | Every rejected test vector has one fault, and one shows the version judged before kind and fields; an entry of 0 in a control vector is read as absent in a snapshot's vector, a target's and an operation's `seen`, gives the same state and control digest as none, and is never written. Tested at L0 and by the test vectors |
| ATR-1, ATR-2 (attribution) | Unattributed text travels as `authorId: null`, is no member's last edit, and reaches a joiner so; a member restarted with content keeps its own attribution when the creator's overlay is as long. Tested at L0 |
| YJS-4 | An element of another name with an attribute, a text directly in `content`, a nested element, formatting, an embed and a type beside `content` are applied and projected as YJS-4 says. Tested at L0 |
| VER-4 (application) | The engine reports a frame of another version with its sender (FRM-7), tested at L0. That an application shows it is the application's part |
| VER-5 (rights a revision may add) | Today's values against the properties every right must have: for every permission on the document and every multiset of up to three concurrent layer values, the merge grants exactly what all of them grant; order, copies and grouping of snapshots change nothing; a decision made in knowledge of another stands; revocation leaves nothing on any layer; an inheriting layer follows a later change of the permission on the document; an unknown value refused in an operation and in a snapshot. Tested at L0 |
| §1.6, JSN-1 nesting limit | The engine refuses a frame nested more than 32 deep before parsing it; tested at L0 at the limit and above it. Each bridge refuses an envelope (and the email bridge an invitation's plaintext) nested so deep, tested at L0 with TDSP 1.4 and run again with this version's bridges |
| §7.1, CTL-13 (revoked and unknown) | A revoked member refused as a reader, also after concurrent `read` and revoke and under a collision; a member never named refused nothing after the bootstrap. Tested at L0, with security tests and test vectors |
| CTL-20 to CTL-25 (operations, merging, snapshot) | The merge as a pure function by property test against an oracle: never wider than intended, narrower only after a hole of the issuing device (about 1 in 1 750 concurrent cases); the result independent of order and duplicates; a snapshot merged by union undoes nothing, and applying operations, restoring their snapshot and merging it give one state, vector and holes included, also where an operation superseded above a hole is in no head. In the engine: two devices of the creator deciding at once agree everywhere; a device restored from an old backup is reported and changes its tag; different operations under one device and counter merge into one, the narrowest, in any order. Tested at L0 |
| CTL-26, CTL-39, CTL-41 (persistence) | Persisted before the send, pending until accepted, resent after a restart, nothing issued when persisting fails; a member's restored state shows its rights, bootstraps it after a first read on from its cursor without a gap, and not after one with a gap, without a cursor or when it was taken before a bootstrap. Tested at L0 against the in-memory transport; keeping it across a real restart is the application's part |
| CTL-27 to CTL-29, CTL-33 (a new device of the creator, divergences) | A new device decides at once and supersedes older narrower rights everywhere, by counters members reported; a report of values changes nothing; reports too low narrow, never widen; without a basis it bootstraps no earlier member it did not decide about, and says it is unconfirmed. A decision of a vanished device only a member holds: deciding wider again does not converge; the divergence shows on the creator's device with the reported and held values, nothing of it applied; the explicit confirmation converges, and a member only the report named ends revoked; a close only members hold is not issued again. Tested at L0, with security tests. That an application decides nothing by itself meanwhile, and shows divergences (CTL-43), is the application's part |
| CTL-30, CTL-32, CTL-34, CTL-35, CTL-36, CTL-37 (bounds, capacity) | 64 devices, 1 024 counters above a hole, 5 002 targets, the bytes as a snapshot carries them: refused and reported beyond, a snapshot over the bytes as a whole; a device of the creator refuses an operation beyond them or one no answer could carry, and a new target beyond 1 MiB while it still closes and revokes; the operation that fills a hole is taken at the limit; at a bound the first in code point order are kept, the same in every order of arrival and for snapshots merged in either order. Two snapshots of 609 011 bytes, each valid alone, converge in every order within 3 MiB; three snapshots whose union passes the bytes are a capacity conflict in every order; in a conflict no new target is taken, edits are refused, the conflict survives a restart, and a refused snapshot bootstraps no one; the close at and below the bytes, from a device just joined, in a conflict, restored and to a joiner; 64, 65 and 1 000 closing devices in three orders keep the same 64 heads without `seen`, closes of refused and given-up devices, operations and snapshot parts in any order give the same state, every snapshot is read back, and a target's `seen` over 64 devices is a capacity conflict in either order. Tested at L0, with security tests; collisions are kept only for unsuperseded operations, so what an instance remembers of them stays bounded |
| SND-14 to SND-16, LOS-4, LOS-11, LOS-16 (pace, pacing, `due`, devices) | Silence judged by the sender's own `due`, or the pace when longer; one heartbeat owed within it, counted from the edit or control frame that promised it, an answer to a joiner after an edit not pushing it out; another device of one's own member counts, one's own frames coming back (also under another delivery id) do not; a heartbeat ends only the silence of frames it holds, a further frame only that of its own source; the latest report of each of a member's streams judged; the pace raises every participant's floor and never lowers one below its own bounds; a new pace governs a device once the operation announcing it is out. Tested at L0, also with the email timing |
| SND-17 to SND-19 (pieces) | Edits and resync answers above `maxBytes` go as pieces that apply in any order; the snapshot and overlay ride in the last piece or one of their own; an indivisible unit too large is refused as `too-large` and the change marked undistributed. Tested at L0. Yjs now and then keeps an update back although all it waits for has arrived (Appendix A); a resync releases it |
| TRN-18, TRN-19, LOS-9 (cursor, instance) | The engine reads through the cursor, takes `truncated` and a changed instance as *history truncated* evidence and asks with `force` — a changed instance also from a transport without a cursor, and after a restart one other than the instance restored with the cursor (`restore.instance`, LIF-8), read after the deliveries so that what a bridge gives up while answering shows at that read; without either it keeps LOS-8. Tested at L0 against the in-memory transport only. **No bridge of this repository offers either yet** |
| TRN-11, TRN-12, TRN-20, TRN-22 (send failures) | Each of the five reasons classified as §3.4 says, an unknown one as `unavailable`; a `needs-person` refusal keeps the change, shows it, holds every message for the longest back-off, and goes out on `flush()`; `409` maps to it (LBI-6). Tested at L0 against the in-memory transport and a scheduler on a fake clock |
| TRN-13 (transport profile) | Each bridge serves `{ bounds, pacing }`: the Signal bridge one profile, the Matrix and email bridges one for a server on the same machine — no floor, the engine's defaults as pacing (TRN-15) — and one for any other. Every profile a bridge can serve passes the strict reader of `@tdsp/messenger-port`, and the email and Matrix adapters read one from a fake bridge. Tested at L0 |
| TRN (transport contract) | The shared conformance suite (`packages/messenger-port/src/contract.ts`) passes against the in-memory transport (L0); against two real Matrix bridges and a local Synapse, and against two real email bridges and a local Greenmail, it runs at L2. Against Signal it runs at L4 only: it passed there against two bridges of this repository and production Signal with TDSP 1.4 — evidence from 1.4, not repeated with the 2.0 engine |
| BND, MTX (Matrix) | L2 against a local Synapse: binding, send and receive, attachments in ordinary and encrypted rooms, the Megolm history caveat, crypto-store persistence across a restart, edits and redactions refused. **Not run against a public homeserver from this repository**. An unencrypted frame in an encrypted room — one bound as encrypted, or one where the bridge saw an `m.room.encryption` or `m.room.encrypted` event while it ran — is never delivered (§13.3); tested at L0 against a faked homeserver (`sync-state.encryption.security.test.ts`). A room bound as plain whose encryption was turned on while the bridge was stopped counts as encrypted only once such an event reaches it again |
| BND, SIG (Signal) | L0 with a fake `signal-cli`; L2 for the daemon's own mechanics. L4 against production Signal with TDSP 1.4: the transport conformance suite and the attachment tests (up to and beyond 4 MiB) passed against two bridges of this repository, each on a machine of its own with its own linked account, reached through tunnels — three runs in a row, on Node.js 22 ([docs/testing.md](docs/testing.md)). Two accounts and one group only. Evidence from 1.4, not repeated with the 2.0 engine. A group message that Signal rate-limited, or could not deliver, for some members fails as a 429 or a 502 instead of counting as sent (TRN-6); tested at L0 with `signal-cli`'s result per recipient as its 0.14.9 source writes it, **not provoked against real Signal**. A member that is not registered, or whose identity the account does not trust, does not make a frame fail while another member got it, so it is not accepted for every channel member in that case; when nobody got it, the send fails as SIG-4 says, from `signal-cli` 0.14.9's error codes and per-recipient results. A captcha Signal requires reaches the bridge as a rate limit with its wait, and is treated as one; whether Signal lifts it after that wait was not tried against real Signal |
| BND, EML (email) | L2 against a local Greenmail, plain and PGP, with real `gpg`: invitations, signatures, encryption, forged senders and keys refused. L4 against one real provider (GMX) with TDSP 1.4: plain and PGP documents, TLS on both connections, the PGP invitation found by the Message-ID its creator chose — passing with two bridges on two machines and with two bridges on the machine running the tests, one run each; evidence from 1.4, not repeated with the 2.0 engine. **The transport conformance suite at L4 (opt-in, about forty more mails) has not been run from this repository, and no second provider has been tried** |
| BND-2 for email: the 4 MiB bound (Appendix B) | Tested against Greenmail only; **no mail near 8 MiB has been sent through a real provider**. The bound rests on a measured mail overhead and a provider limit of about 10 MiB that is commonly cited, not verified |
| BRG-13 for email | An incoming mail is read by a partial IMAP fetch of at most 10 MiB plus one byte; a larger one is rejected unparsed and never handed to `gpg`. Tested against Greenmail at the exact boundary; not tried against a real provider |
| BRG-14 for Signal | A `signal-cli` answer longer than 16 Mi characters is dropped unread; tested with a stand-in daemon over a Unix socket, not with a real `signal-cli` |
| BRG-11, BRG-12 for Signal | Another message under a delivered id (author and sent timestamp) is recorded as `message-replaced` and never delivered; the same message again is dropped; an id enters the comparison only once its message is delivered, and an edit or remote deletion is recorded only for a delivered message. Tested at L0 with synthetic `receive` notifications. Kept in memory while the bridge runs: after a restart a message offered again is delivered again, which the engine takes as a duplicate (TRN-8) |
| EML-10 scope | The vectors pass. **No provider has been tested for how it treats the letter case of an address**; "case-insensitive" is the binding's stated scope, not a measured property |
| EML-11 | A message a mail server accepted for some participants only is reported as failed. Tested with the real SMTP sender over an injected transport that refuses one recipient; no real provider has been made to refuse one |
| EML-8, EML-13 trust states | The implementation records no fingerprint comparison, so it **never reaches "verified"**: a creator is at most "consistent" with the user's own keyring. By design |
| LBI-6 | The status mappings of all three bridges are tested with faked errors; none has been provoked against a real provider's rate limit. For Signal the faked error follows `signal-cli`'s source (JSON-RPC code -5, with the stated wait in its send results), not a captured response |
| BRG-1, BRG-8 (`needs-person`, `409`) | Every bridge answers `409` to every document operation while it is not provisioned, and `/transport-profile` `503`. A send refused for what only a person can lift is `409`: Signal's untrusted identities (`signal-cli` codes -4, and -1 with only identity and unregistered results, as its 0.14.9 source raises them); Matrix's signed-out, locked, suspended and consent errors and a full homeserver (`M_UNKNOWN_TOKEN`, `M_MISSING_TOKEN`, `M_USER_LOCKED`, `M_USER_SUSPENDED`, `M_CONSENT_NOT_GIVEN`, `M_RESOURCE_LIMIT_EXCEEDED`, from the Matrix specification and Synapse's source); email's refused SMTP login, a full mailbox (5.2.2) and, for PGP, a missing gpg or own secret key (nodemailer's errors probed against a scripted SMTP server). Tested at L0 with faked errors, **none provoked against a real provider**. A Signal device unlinked from the phone still answers `502`: `signal-cli` reports it as it reports an account it could not load for a while |
| TRN-11 for Matrix (the wait) | A refused send or upload passes on the wait of the homeserver's `Retry-After` header, and the body's `retry_after_ms` only without one; tested at L0 against a faked homeserver, not against a rate-limited real one |
| TRN-7 for Matrix (a deep to-device event) | A to-device event nested deeper than 32 levels is left out of what the crypto machine gets, and the frames of the same `/sync` round are delivered; tested at L0 against a faked homeserver. That writing such an event out throws was measured on Node.js 24 at 8 000 levels and on Node.js 22.23.3 (CI) at 10 000, not on Node.js 26 |
| BRG-10 (the bound channel) | The Signal and the Matrix bridge deliver a frame for a document only from the group or room it is bound to, and record an edit, a delete or a redaction only from there; a frame, an edit and a deletion from another group or room of the account reach nobody and leave no record. Tested at L0 (`sync-state.channel.security.test.ts` in both bridges). The email bridge checks every message against the thread's participant set (EML-2), tested at L2 |
| TRN-17 (`channelMembers`) | The mock, and the Matrix, Signal and email bridges and adapters answer it: Matrix with the room's joined members, Signal with the group's members by ACI from `signal-cli listGroups`, email with the thread's fixed participant set; a channel this account is not in is refused (404) without naming anyone. The conformance suite checks it against the mock (L0), Synapse and Greenmail (L2); against Signal only at L4, not yet run. The Signal member list follows signal-cli's source (0.14.9), not a captured response |
| MTX-4 (an account's devices) | L2 against a local Synapse: two devices of one account, each a bridge, in an encrypted room; what one sends, the other receives as the account's own message. Fails when the room key is withheld from the account's own devices. **That keys go only to devices their owners signed, and frames are taken only from them, is not built** (below) |
| EML-12 (an address's devices) | A frame mail's copy is appended to the account's sent folder, which is created when missing, and searched on receipt; with PGP the mail is encrypted to the sender's key too. L2 against Greenmail with two bridges on one mailbox: the second receives what the first sent, and the other participant receives the mail addressed to the others only, as before. **`EMAIL_SENT_COPY=provider` is not tried against a provider that files sent mail itself; whether GMX does is not verified.** A creator's second email device cannot use the invitation: it is neither in the creator's mailbox nor encrypted to the creator |
| SIG-3 (an account's devices) | L4 against production Signal with TDSP 1.4: two bridges linked to one account, in one group; what one sends, the other delivers under the id the sender got and as the account, an attachment frame included (`l4-own-devices.test.ts`, signal-cli 0.14.9, one run). Fails when the bridge does not read sync transcripts. That an edit and a remote delete sent from another device arrive inside the transcript was seen with `signal-cli receive` directly; that the bridge records them as integrity violations, and ignores a transcript from another sender, is tested at L0 with that shape, not live. Evidence from 1.4, not repeated with the 2.0 engine. **Two devices of one account sending in the same millisecond share a delivery id; not tested** |
| BRG, LBI, BND, SIG, MTX: what 2.0 changed or added | **Not implemented by the bridges of this repository yet** (Appendix G): the same message again dropped and another one under a delivered id recorded as `message-replaced` (BRG-11, BRG-12; the email bridge still calls it `message-id-reused`); BRG-17, BRG-18; ASCII hexadecimal digits (BND-3); Signal's result per recipient, reading a connection before `signal-cli` pushes into it, and the subscription (SIG-4 to SIG-6); Matrix's signed devices, unencrypted events in encrypted rooms, `Retry-After` and the inline limit measured on the envelope (MTX-4 to MTX-7). The adapters map `409` to `needs-person` |
| RSY-6, RSY-8, RSY-12, RSY-13 (a member's devices) | A device brings another device of its own member up to date while the creator is offline, with its control state, so the other device may write — or learns it is read-only. Tested at L0, with security tests |
| CTL-13, CTL-42, RSY-8, RSY-10 (application: changes the engine refuses) | TDSP 1.4's tests of held changes (#69) pass against the 2.0 engine at L0, changed only in how they capture the creator's persisted control state |
| SND-8, restored content | As in TDSP 1.4, tested against the in-memory transport |
| INV-8 (application) | As in TDSP 1.4: `invitationFromUrl` reads a whole link as INV-8 says; tested at L0 |

## Known gaps

What this version does not yet specify precisely or has not built. None of it is hidden
behind a claim elsewhere in the specification.

- **Digests compare where the receiver holds the sender's vector.** A lost deletion shows once the
  receiver holds every insertion the report counts, so after a lost insertion it shows only when
  that has arrived; and a collision, or a decision only members hold, ends only when a person
  decides the target again or confirms (CTL-31, CTL-33). A report that crossed a deletion the receiver holds
  is a false alarm until its stream reports again, which it does at once on a request that states
  what it holds (SND-24), or answers the receiver whole; while that stream does not run, it stays
  (§10.6).
- **Silence names members, not devices.** With several devices of one member, a heartbeat of
  one that holds another's frame ends the silence expected of that frame (§10.6); one that does
  not hold it, or a further frame of another device, no longer does (LOS-16).
  Reports are kept by stream (LOS-17); edits and control frames name none.
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
- **The local bridge interface** (§12.6, [bindings/local-bridge-interface.md](bindings/local-bridge-interface.md)) is optional and not yet stable: body limits,
  paging, content types, caching headers and error codes are not normative.
- **Operations**: logging retention and redaction, and behaviour after a backup, restore
  or upgrade, have no minimum rule yet.
- **A verified PGP mode** — a fingerprint the person confirms before joining — is not
  built.
- **Persistence across restarts** of a creator's control state and of undistributed
  changes is required of an application (CTL-26, SND-21); a creator whose persisted state
  is lost is a new device, which decides at once (CTL-27). An application that restores
  persisted content through `join()` need not keep the undistributed mark: the engine
  treats restored content as undistributed, at the cost of one message per restart.
- **A restarted member goes on writing only through a cursor.** It edits again on its restored
  control state only where its transport offers `receiveSince` and its application persisted the
  cursor with the content (CTL-41, LIF-8); a transport that keeps its window only in memory answers a
  cursor from before its own restart as `truncated`, and the member then waits for an answer.
- **The bridges and 2.0's bindings.** The bridges carry 2.0's frames unchanged and serve its
  transport profile, but implement of what the bindings changed or added only what v1.5.0
  brought (the rows above), and offer neither the cursor nor the instance (TRN-18, TRN-19).
- **Carried control state** (ARC-5, CTL-25): the engine offers no way yet to merge a snapshot
  an application carried from another device of the creator; an application that carries a
  document between one person's devices carries its content, and the device decides as a new
  device of the creator (CTL-27).
- **Matrix device verification.** Element is moving its clients to exclude devices their
  account has not signed (MSC4153), announced for October 2026, and MTX-4 now requires the same
  of every bridge. The Matrix bridge shares keys with every device and delivers from any; its
  own device can be signed with the account's recovery key (`pnpm run matrix:confirm-device`,
  [docs/matrix-device-confirmation.md](docs/matrix-device-confirmation.md)); tested against
  a local Synapse, **not tried against Element itself**. Interactive (emoji) verification is
  not built: the crypto library the bridge uses offers none.
- **The email bridge's memory of seen messages** grows with the thread (a few hundred
  bytes per mail); bounding it needs an IMAP UID position — the same position that would
  give the bridge a cursor (TRN-18).
- **A second implementation**: whether this core is simpler to implement than 1.x's is not
  shown; this version's engine is a rework of the reference engine, not an independent one.
