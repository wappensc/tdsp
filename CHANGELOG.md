# Changelog

What changed from one release of this repository to the next. Two numbers are kept apart
([docs/versioning.md](docs/versioning.md)):

- a **release** `vX.Y.Z` names the reference implementation, a Git tag with a GitHub release;
- the **specification** has its own version, "TDSP X.Y.Z", in the header of
  [SPECIFICATION.md](SPECIFICATION.md). Each release says which one it implements.

Newest first. Listed: every change to the specification and the wire, to the exports and
options of the packages, to what the bridges offer, and to behaviour an application can
notice. Not listed: refactorings, tests and CI changes that change none of that. Numbers in
parentheses are pull requests or issues of [wappensc/tdsp](https://github.com/wappensc/tdsp).

## Unreleased

TDSP 2.0, a draft of the next major version (#71), for review before its release. Frames
carry `"tdsp": 2` and invitations `tdsp=2` — until 2.0 is released, the draft marker
`de.wappensc.together.tdsp.probe.draft-10` instead (VER-3) — and every 1.x engine refuses
them, as VER-1 intends. The envelope and the profile `yjs-paragraphs/1` keep version 1, and
the wire of 1.x stays frozen beside the draft's. Appendix G of the specification lists every
requirement withdrawn, changed or added, each with the reason, and what 2.0 leaves out of
#50 and #71.

### Specification: TDSP 2.0 (draft)

How the text is written:

- **Readable, requirement by requirement**: long requirements are split, each keeping its ID for
  its first part, and the new parts have IDs of their own — CTL-34, CTL-36 to CTL-43, LOS-15,
  LOS-17 to LOS-22, RSY-18, RSY-19, SND-20 to SND-22, SND-24, TRN-21, TRN-22, FRM-15 to FRM-17,
  LAY-7, VER-6, EML-13; LOS-16 and SND-23, split off then, are withdrawn since.
  Sentences that used RFC keywords without an ID, informative under §1.3 although meant to apply,
  are requirements now: LOS-15, LIF-8, INV-10, SEC-1, SEC-2, JSN-1, BND-4. Appendix G lists them.

The frame and the wire:

- **The draft's wire** (VER-3): `wire/frames-draft-10.json` and `wire/invitations-draft-10.json`
  are frozen like 1.x's files, and `packages/document-protocol/test-vectors/frames-draft-10.json`,
  `invitations-draft-10.json` and `control-draft-10.json` are the published vectors, read by a
  receiver of `yjs-paragraphs/1` (the `profile` field of `frames-draft-10.json`), all of them in
  the wire lock. An incompatible change of the draft names a new marker.
- **Extension fields** (§4.4, FRM-9 to FRM-12): a field whose name contains `.` is ignored when
  unknown, in frames, snapshots, registers and overlays; the keys of objects whose keys are data —
  a snapshot's and a `control` frame's `targets`, `lastEditBySender` — are not field names, so a
  target such as `member:@bob:example.org` is a target. An extension's name ends with its major version
  (`com.example.mood/1`); a sender names in `crit`, once each, every extension the frame carries
  that changes what a receiver does with the defined fields; a receiver checks the value of one
  it implements, ignores an invalid one, and rejects the frame when `crit` names one it does not
  implement (`unsupported-extension`), names one the frame does not carry or names one twice
  (`invalid-field`). A definition states kinds, values, the meaning of absence, criticality and
  handling (FRM-12); an engine passes no extension on.
- **Which reason comes first** (FRM-13, §4.4): `not-json`, then `unsupported-version`, then
  `unknown-kind`; among the others a receiver reports any that applies. `profile-mismatch`
  (CTL-10) is in the table of reasons. Every rejected test vector has one fault.
- **Reading without applying** (PRF-1 item 9, §4.4, FRM-6, Appendix A): a profile says how to
  tell, changing no replica, whether bytes are exactly one update or one state vector; an
  `update` or `stateVector` the document's profile does not read so is `invalid-field`, also
  with bytes after a complete one.
  A variable-length integer above 2^53 − 1 anywhere, which lib0 reads where its last byte carries
  it there, or longer than 8 bytes, which lib0 reads as NaN beyond about 147, and JSON content or an `Any` value nested more than 32 levels, counted as §1.6 counts
  a frame, are no update and no state vector; `isUpdate` and `isStateVector`
  (`@tdsp/reconciliation`) refuse both, where they took the first and had no bound on the second.
  So are a client's structs that end beyond 2^53 − 1 — the clock of the first plus their
  lengths, two lengths each within bounds among them — and a delete range whose clock plus length
  does: `isUpdate` took them, and applied they left the replica at a clock its own state vector
  could not carry, which every receiver refused.
  The behaviour vectors `updates-draft-10.json` show it (§3.6). Where a second reading of the text
  could differ, it now says what the reference does: `missing-field` at every level, integers
  without a sign, the device tag's spare bits unchecked, the invitation's problems in their order,
  `recipients`, another provider, how JSON content parses, the Yjs files of the reference, 5 001
  targets, and the smaller points a second reading of the text turned up (§3.6).
- **An answer's update is never empty** (§4.3, PRF-1 item 4, SND-18, CTL-30): where a requester
  lacks nothing, or a last piece carries only the snapshot and the overlay, a `resync-response`
  carries the profile's update that holds nothing — for `yjs-paragraphs/1` the two bytes
  `00 00`, Base64 `AAA=`. An empty `update` is `invalid-field` in every kind.
- **A `control` frame carries registers** (§4.3, CTL-20) instead of a numbered action: `targets`,
  the registers its device decided — each exactly `value`, `clock` and `device` —, the flag
  `closed`, and the device's control clock and control digest after it; a frame without registers
  carries the close. It may aim at a member's right on a layer.
- **Requests and heartbeats** carry a control clock and a control digest instead of a control
  sequence, and a state digest (below); a request's `bootstrap` flag becomes `force`, set after a
  truncated history, and a request says with `all` whether any member may answer it (RSY-16,
  RSY-21).
- **The grammar of profile and layer ids** (§5, §5.6): ABNF for `<name>/<major>` — a name of 1
  to 100 lowercase letters, digits, `.` and `-` that starts with a letter or digit, a major from
  1 to 999999 without a leading zero — with test vectors at its edges.
- **Unattributed text has a form on the wire** (§5.4, ATR-2, RSY-13): a range of the attribution
  overlay names its author's MemberId or `null` for text whose author the responder does not
  know, and `lastEditBySender` has no entry for it. Only the overlay of an answer to a request
  the engine made while it held nothing is adopted wholesale (ATR-1, ATR-2); a participant that
  restarted with content keeps the attribution it restored.
- **Content YJS-1 forbids, at a receiver** (YJS-4, Appendix A, LAY-6): a receiver applies an
  update that holds another element, an attribute or another top-level type, and projects it as
  YJS-4 says; a top-level type that no layer id names counts as content for LAY-7.

Control state (§7):

- **A register per target** (§7.1 to §7.3, CTL-20 to CTL-23, CTL-45): the latest decision on each
  target — a member, a member's right on a layer, the pace — is a register of its `value`, its
  `clock` and the `device` that made it, and beside the registers the document has a `closed`
  flag that only goes one way. Every device of the creator decides under a random tag of its own
  and gives each decision a clock `[ms, counter]` above its own clock and above every register it
  holds on that target; its own clock follows
  its wall clock and runs at most a day ahead of it. Of two registers on one target the greater clock holds, at equal clocks the
  later tag, at equal clock and tag the narrower value: a decision made in knowledge of another
  holds over it, and of two made without knowledge of each other the later by the deciding
  devices' clocks — not the narrower. No receiver sets a register aside for its own time. A
  decision holds at once, as a change not yet sent. The gap-free sequence, the outbox, conflicts
  under one number (CTL-17), devices continuing after an unbroken run (CTL-18) and the waiting
  device without control state (CTL-19) are withdrawn.
- **Revoked is not unknown** (§7.1, CTL-13, CTL-23, LAY-5, LAY-6): a member whose register holds
  `null` is revoked, and its engine refuses its edits as a reader's, on the document and on every
  layer; a member no register names is unknown, and after the bootstrap its engine refuses its
  edits as `read` does, until a register names it. At a tie on a layer target, `read` is narrower
  than inherit (`null`), and inherit than `write`.
- **A snapshot is a register per target** (§7.5, CTL-15, CTL-25): `{profile, closed, targets}`,
  merged register by register, so an older one undoes nothing. A receiver merges the snapshot of
  every answer it accepts, whoever sent it, and, on a device of the creator, one carried from
  another device of the creator (ARC-5).
- **Cooperating participants** (§1.1, §15.2, §15.4): TDSP assumes that every participant runs
  software that follows the specification. A member's answer passes on what reached it of the
  creator's decisions and bootstraps a new device as the creator's does — a new device of the
  creator excepted, which only her devices bring up (CTL-46) —; only the creator's identity sends
  `control` frames (CTL-5). What a participant whose software ignores the
  specification can do — write, set rights or close for everyone, give participants different
  content — is stated in §15.4, with the way out: remove it from the channel and continue in a new
  document.
- **A new device of the creator** (§7.6, CTL-27, CTL-43, CTL-46, RSY-14): the creator's devices
  hold the document's rights. A new device of hers is bootstrapped by another of her devices or by
  its own restored or carried state; it merges members' answers, registers included, but is not
  bootstrapped by them, and decides nothing but the close and its reason before. Until it is bootstrapped it states no control clock or
  digest and sends no snapshot; its application shows that the rights are not known yet and, once
  its attempts ran out, asks for another device and offers to close the document and continue in a
  new one. Where no device or backup of the creator holds the state, the document is closed and
  continued as a new one.
- **Gaps** (LOS-6, LOS-18, LOS-25, LOS-26): evidence is a gap of one stream — a CRDT client's
  updates, one stream's deletions, the control state one stream of the creator reports, one answer, a
  truncated history —, asked for at most three times, to all, the first after a place of its own,
  the waits at least doubling up to a longest wait (10 min recommended); then it rests, shown,
  until a frame that raises its position, or one of the member that wrote it, wakes it, at most
  once in 10 min, or a return or an absence longer than a start request's that its application
  tells of, or the person's request, does. One gap nobody can heal keeps no later loss of another
  stream from being asked for.
- **Persisting and restoring** (CTL-13, CTL-26, CTL-39, §6.3, LIF-5, RSY-14, RSY-16): the creating
  device reports its control state before the start frame and creates nothing if that fails; a
  device of the creator persists its tag, its clock, whether it was bootstrapped, and its frames
  not yet sent, and a restored state is bootstrapped only if it was; any participant may persist
  its control state, and a member's restored state bootstraps it
  once it has read on from the cursor persisted with its content. An engine reports every change
  of its control state before its cursor reads past the delivery that brought it.
- **Bounds** (CTL-30, CTL-32, CTL-34, CTL-36, CTL-37, §15.3, §15.4): 5 000 targets on members and
  rights on layers, beside which the pace always has room, and 3 MiB, measured as the UTF-8 of the
  RFC 8785 serialisation of a snapshot's `targets`; a device of the creator adds a target only up
  to 1 MiB, and refuses a decision a receiver would refuse or after which no answer of its
  transport could carry its snapshot (SND-18). The close lies outside every bound, so a full
  document can always be closed. Beyond the bytes or the targets a receiver is in a **capacity
  conflict** for good: it reports it, takes no new member or layer right, refuses its own edits,
  answers every request with `control: null` (RSY-8), and is bootstrapped all the same by an
  answer whose snapshot it refused; an application persists and shows it.
- **What a later right must keep** (VER-5, VER-6): a revision that defines a new value for a
  member's permission or a layer right defines the capabilities each value grants, its place in
  the order a tie uses, and that a revoked permission on the document leaves no right on any
  layer, and keeps older engines from reading it as `write` or inherit.

Who answers (§8.3):

- **Anyone may bring a new device up, one at a time** (RSY-6, RSY-20, RSY-21, RSY-4, RSY-5): every
  device of the creator, and every device of the requester's own member, answers at once; any
  other member answers only a request that carries `all`, at its turn — a wait it derives from the
  request's `requestId` and its own stream, spread over a window of 6 × its expected latency, at
  least 30 s and at most 5 minutes —, and lets the request go once it heard an answer that holds
  what it would give, or at its turn with nothing to offer. Every request asks all but the
  first of a bootstrap, which asks the creator's devices and the requester's own first; a request
  to all expires that window later, and one made in the bootstrap is not ended by an answer that
  ends nothing — content alone bootstraps no one.

Who takes part (§6.6, §3.2; bindings §12.5):

- **The channel is the boundary** (LIF-9, LIF-10, TRN-5): who takes part is the channel's. An
  application that adds a person to the channel or removes one keeps the rights in step — a
  permission before the invitation, a revocation before or as it removes the person —, compares
  the channel with the control state once it is known, and shows a channel member but the creator
  that no register names, a granted member outside the channel, and a revoked member still in the
  channel — apart while it removes that member —, changing neither without its person; where the
  binding cannot add a member or remove one, it shows that and offers continuing in a new document. Creating
  a channel or changing its members is no operation of the transport contract; a bridge may offer
  it to its application, and no frame triggers it.

Rights on layers (§5.6, LAY-5, LAY-6; §7.1, CTL-4, CTL-13, CTL-20, CTL-30):

- The creator may give a member a right on a layer, `read` or `write`, through the target
  `layer:<layer id>:member:<MemberId>`; without one, the member's permission on the document
  applies. The sending engine tells from each change which parts it touches and refuses one that
  touches a layer it may not write, whole; receivers still reject nothing for a right (CTL-7).

Sending and pacing (§9):

- **No shared sync policy** (§9.1, SND-15, SND-16): the creator sets one number for everyone,
  the pace; everything else about pacing is each participant's own. The `policy`
  action, the policy text of §11.2 and the `policy` invitation parameter are withdrawn. The
  pacing an engine runs is the engine's defaults, under the transport profile's `pacing`, under
  what the application chose.
- **Pieces instead of fragments** (§9.4, PRF-1 item 7, SND-17 to SND-19): a profile splits a
  large update into pieces that are updates themselves; the `fragment` kind and its reassembly
  are withdrawn. A refused piece drops the rest of its update. Spread pending updates go as merged
  prefixes, each a prefix whose frame fits, not necessarily the longest; how many messages a change
  takes is the sender's, each within `bounds.maxBytes`. An application writes indivisible units no
  larger than the profile allows.
- **The report** (§9.3, SND-11, SND-12, SND-24, SND-27, SND-28): the heartbeat is a report at the
  end of each phase of a sender's own writing, owed from its first `edit` or `control` frame and
  due a report delay (10 s recommended) after its last, once nothing of its own waits or is under
  way, whatever its pacing; it carries the phase's last edit again, or follows
  its last `control` frame sent again, so a lost last change heals without a request. It goes at
  once on close, before sleep, after a merge that changed a bootstrapped device of the creator's
  control state, and when a request states exactly what the engine holds while what it deleted
  within its latest report has changed. It is retried while owed, never ahead of a change of its
  own, and an application persists the report owed with the content.
- **What the text left open about sending** (SND-1, SND-2, SND-7 to SND-10, RSY-3, RSY-4, LOS-2,
  LOS-8, §10): `flush()` and `dispose()` keep the floor and the waits the provider asked for; a
  request the floor holds back waits and its expiry counts from when it went out; a failure worth
  retrying of a message of any kind holds back the next send of every kind, and only the success
  of a send that began after the hold ends it early, not one under way as the refusal came; the
  failure the engine shows ends with a send begun after the hold that went or was dropped, or
  once no message the engine retries waits or is under way; a refusal only the person can lift,
  of any message, shows as such while its hold lasts; a dropped answer, request or report leaves
  nothing undistributed, and an application shows undistributed changes and offers to send the
  whole state again; a request that could not be sent is no error, its outcome `failed`; a
  non-finite floor, `minChars` or latency falls back to its default; a deletion the CRDT holds back
  is a pending gap.
- Appendix B suggests 35 s between email messages, above the one per 34 s one provider was
  measured to allow.

Loss evidence (§10):

- **State digests** (LOS-12, LOS-24, PRF-1 item 8; RSY-8, RSY-16, RSY-17, SND-11): reports and
  requests carry, beside their state vectors and control clocks, a state digest — of what the
  sender deleted — and a control digest — of its `closed` flag and its registers —, each the first
  8 bytes of SHA-256, and an answer's last piece the responder's state vector and state digest. A
  receiver that holds every insertion a report's state vector counts compares what it deleted
  within that vector, so a lost deletion shows although it has edited since and heals; a responder
  answers a request whose state vector holds all of its own and whose digest differs. Control
  digests are compared at equal control clocks, so a lost close, or a register lost under a clock
  no greater than one received, shows.
- **A lost decision shows by its clock** (LOS-10, SND-11): a report of a device of the creator
  whose control clock is above every register a receiver holds is evidence; a `control` frame is
  none.
- **Streams** (LOS-13): a report (`heartbeat`), a request and every piece of an answer name their sender's
  stream — 16 hex digits, random for every engine as it runs — and a `sequence` in it; a receiver
  keeps the latest report of each of a member's streams, and a report replaces only an older one
  of its own stream, so the report of a device that lags behind does not end the evidence of
  another device of its member.
- **Numbered pieces** (LOS-14, RSY-8): every piece of an answer carries its number `piece`, its
  last piece the count `pieces`; an answer to an engine's own request is counted by its sender,
  stream and number, bound to the request, apart from the stream's reports, and one of which a
  piece is missing is the evidence `answer-incomplete`, and the engine asks again.
- **Every stream's report** (LOS-4): a member's latest reports are judged, one per stream, so one
  device's does not hide another's, those of an engine's own member too.
- **Requests of several devices** (RSY-9): a responder keeps the requests it could not answer yet
  by request id, up to four per requester, and serves requesters in turn, one that asks all at
  its turn (RSY-20); one for which the profile fails to compute an answer is let go and reported,
  and the others are answered.
- **What no evidence shows** (§10, honest limits): a lost update that only deleted leaves every
  vector equal; where it heals, and what no evidence can show, is said.

The transport contract (§3):

- **A cursor and an instance** (TRN-18, TRN-19, LOS-9, §6.3): an optional `receiveSince` with
  `truncated`, answered in the order of the bridge's window, oldest first, and truncated also
  behind what the bridge passed over; an optional instance id, the window's epoch, that changes
  whenever the bridge may have lost something. Where offered they replace LOS-8's guess; a new
  instance is evidence on its own. An application persists the instance with the cursor, and a
  restarted engine compares the transport's with it at its first read.
- **A fifth send failure, `needs-person`** (§3.4, TRN-11, TRN-12, TRN-20): a refusal only a person
  can lift — no account set up or signed in, an identity not trusted, a device not confirmed,
  storage full. The engine keeps the change, shows it, sends nothing before its longest back-off
  and sends at once on `flush()`; such a refusal of a request, an answer or a report it shows as
  long as that wait lasts. A failure that carries none of the five reasons counts as
  `unavailable`.
- **At least 4 MiB per frame** (TRN-23, §3.5, §7.4, §15.1, §15.4, Appendix B; bindings §13,
  BRG-9): a transport carries frames of at least 4 194 304 bytes — `bounds.maxBytes` is `null` or
  at least that —, as every binding of this version does, and an engine fails the creation or join
  of a document on a smaller one. Two devices of the creator decide apart, and their merge could
  hold, within the bounds every receiver holds, more than an answer of a smaller transport carries:
  nobody new could have been bootstrapped. What remains is named with its estimate: beside a
  control state at its bound, the room left in an answer holds the state vector of roughly 75 000
  sessions that wrote, under the assumptions §7.4 states.
- **A transport profile is `{ bounds, pacing }`** (§3.5, TRN-13): the bounds and the pacing the
  transport suggests; named presets belong to applications. A binding whose messenger allows a
  burst above a sustained rate states which interval it chose for `bounds.minIntervalMs` and why.

What an application does:

- **Credentials** (ARC-4, BRG-2) never reach the engine or any component that renders what came
  through the channel. **One person's devices** (ARC-5, INV-9): an application may carry a
  document between them through another service, telling the person first.
- **Showing the creator** (INV-3, INV-7) by an identifier the messenger keeps unique, or a name the
  person gave, never only by a name the creator chose. **Another version is shown, per
  participant** (VER-4, FRM-7), and an application that cannot read an invitation of another
  version tells its person and sends no `decline` (DCL-1).
- **What an application keeps** (LIF-5, LAY-2, DCL-3): it marks a document it creates before the
  initial state goes out; a new document made from another's content, and an export, are not
  copies of it and may leave its layers out, saying so.
- **The invitation's value ranges** (§11.3, INV-6): a binding's name begins with a letter or a
  digit; a thread root is the email binding's `Message-ID` of at most 200 characters in all.

What a peer can make a receiver hold or wait for:

- **What waits for missing predecessors is bounded** (LOS-23, PRF-1 item 2, Appendix A, Appendix
  B): beyond 32 MiB of pending structures and deletions an engine gives all of it up and treats
  that as a truncated history, asking at once with `force`; the creator's answer brings back what
  it holds and ends the evidence. Anyone in the channel could otherwise fill a receiver's memory
  unseen with updates whose predecessors never come. Every profile measures and gives them up, and
  no answer carries them (PRF-1 items 2 and 4, Appendix A).
- **A pace is bounded** (SND-15, Appendix B): one longer than an engine's bound, 10 minutes
  recommended, runs as that bound, for sending and for the wait for an answer's pieces alike, so a
  document can be made quiet, not mute.

One person's devices (ARC-5, ARC-2):

- **An application may carry a document between one person's devices** through another service,
  and tells the person (ARC-5): content and the binding for any participant, control state only
  between devices of the creator; a member's control state comes from the channel. A device of
  the creator that takes over carried control state should continue under a new tag, takes it as a
  snapshot carried from another device of the creator, and is bootstrapped by it only if it was
  bootstrapped there (CTL-25, RSY-14). ARC-2's
  ban on connections other than to the bridge names that service as its one exception. The
  reference engine has no path for carried control state yet: an application can hand it over
  only as the device's own persisted state, which keeps the state's tag (CONFORMANCE.md).

Bridges and bindings:

- **Documents of their own**: the bridges and the common envelope, the Signal, Matrix and email
  bindings and the local bridge interface are in `bindings/`, versioned apart from the core; the
  local bridge interface gains optional routes for the cursor and the instance.
- **What a bridge does with what arrives** (BRG-11, BRG-12, BRG-17, BRG-18, BND-3): the same
  message presented again is dropped silently; another message under a delivered id is recorded
  as `message-replaced` and not delivered, one vocabulary of reasons for every bridge; a bridge
  may drop a delivery once its one reader kept it; one unreadable message never stops a bridge; a
  SHA-256's 64 hexadecimal digits are ASCII.
- **Refusals only a person can lift** (BRG-1, BRG-8, LBI-6) are `needs-person`, `409` over the
  local bridge interface. **Attachments a bridge cannot bound** (BRG-14, §15.5): where the
  messenger's client fetches them itself, the binding says so.
- **What a bridge records** (BRG-12): nothing for a message it does not take; a bridge that keeps a
  delivery id across a restart keeps what it compares by with it, and one that keeps nothing
  compares afresh.
- **Signal** (SIG-4 to SIG-6): a send is accepted by `signal-cli`'s result per recipient; a bridge
  reads a connection before `signal-cli` pushes into it, and one that receives through a
  subscription reads before it subscribes.
- **Matrix** (MTX-4 to MTX-7, §15.1, BND-1): room keys only to devices their owners signed, the
  bridge's own device signed, frames only from devices so signed; an unencrypted TDSP event in a room once seen encrypted, an edit
  included, is ignored without a record, and that the room was seen encrypted is persisted with
  each binding to it;
  a rate limit's wait from `Retry-After`; a frame rides in the event when the envelope as written
  is at most 32 000 bytes. §15.1 and BND-1 say against whom an encrypted room protects.

After a review of the whole text (2026-10-25), besides wording, references and Appendix G:

- **Control state is carried only between the creator's devices** (ARC-5, CTL-39): a member's
  application carries content and binding, and its engine takes control state from the channel
  or, on the same device, what it persisted. **The storage it uses** (ARC-5, ARC-2) is one
  through which no one but the person and that storage's provider reads or writes the document,
  where before no one but the person was to read or write through it.
- **The pace bound is each engine's own** (SND-15): 10 minutes recommended, not a number
  every engine must use, since what a receiver judges by the pace is its own waiting.
- **Profile and layer ids** (PRF-7, LAY-4) should begin with a reverse domain name their definer
  controls, as an extension's does.
- **The digest is a requirement** (LOS-24): the first 8 bytes of SHA-256 — the state digest over the
  profile's encoding of what the sender deleted, the control digest over its control state as
  §7.5 lays it out —, as §10.3 defined it informatively.
- **The seed is not retried** (SND-20, LIF-3): a failed send of it fails the document's creation.
- **What a bridge compares** (BRG-11, BRG-12): a frame in the body by its bytes, one in an attachment
  by the hash its envelope names, an encrypted file also by its key and iv; across a restart a hash
  of key and iv suffices.
- **Signal** (SIG-4, SIG-7, BRG-8, BRG-15): a recipient a send skipped as an identity to trust is
  recorded in the integrity log as a notice, an entry of a `kind` of its own beside the violations
  that names the `recipient` instead of a sender, so the application can show it; a send
  `signal-cli` refuses because it cannot load the account is `unavailable` while the bridge's link
  status, which SIG-7 defines, shows the device linked, `needs-person` once unlinked.
- **Security statements** (BND-1): the Signal binding states what it inherits from Signal, also
  against Signal's servers, as Signal's word, and that a member's first identity key is trusted on
  first use; the email binding what PGP adds against the mail providers, and that the headers and
  the invitation's text and link stay readable to every one of them.

Rights as registers, for cooperating participants (draft-10), against draft-5, besides wording,
references and Appendix G:

- **Cooperating participants** (§1.1, §2.3, §15.2, §15.4, §15.5): TDSP assumes that every
  participant runs software that follows the specification; it is built for loss, duplicates,
  reordering, devices offline, crashes, restored copies and clocks that are off. A member's answer
  brings a new device the content and what reached that member of the creator's decisions, merged
  as the creator's own (CTL-25, RSY-8); only the creator's identity sends `control` frames
  (CTL-5). §15.4 states what a participant whose software ignores the specification can do —
  write, set rights or close for everyone, give participants different content under one
  identifier — and the way out: remove it from the channel and continue in a new document; §15.5
  keeps only what does not assume a lying member.

- **The marker and the wire files** (VER-3, §3.6): the marker is
  `de.wappensc.together.tdsp.probe.draft-10`. `wire/frames-draft-10.json` (24 frames) and
  `wire/invitations-draft-10.json` replace draft-5's frozen files, and `frames-draft-10.json`,
  `invitations-draft-10.json` and `control-draft-10.json` its published vectors, all of them in
  the wire lock as draft-5's were. Control state is persisted with the marker, and one persisted
  under another marker, or none, is read as none.
- **On the wire** (§4.3, §4.4, §7.5): a `control` frame carries `targets` — the registers its
  device decided, each exactly `value`, `clock` (`[ms, counter]`) and `device` —, the flag
  `closed`, and the device's `controlClock` and `controlDigest`, beside `device`, where
  it carried one operation; `counter`, `target`, `value`, `seen` and the target `close` are gone.
  A heartbeat and a request carry `controlClock` and `controlDigest` instead of the control vector
  `control`, and a request carries `all`. The snapshot is `{profile, closed, targets}`
  with one register per target; `vector`, a target's `seen` and `heads`, and `aboveHoles` are gone.
  Newly `invalid-field`: a clock that is not two integers in their ranges, a register without
  exactly its three fields, a `control` frame without registers and without `closed: true`, a
  control clock and digest of which only one is `null`. Gone with them: the bounds of 64 devices,
  1 024 counters above a hole, 64 heads of a target and 64 devices in a `seen`.
- **New**: CTL-45 (the clock), CTL-46 (the creator keeps the control state), RSY-20 (a member's
  turn), RSY-21 (when a request asks all), LIF-9 and LIF-10 (the channel and the rights in step, §6.6), SND-25 (every
  wait on a clock that does not run back, §1.6), SND-26 (an own change the profile does not read is
  refused). **Withdrawn**:
  FRM-14 (no 0 in a control vector), CTL-24 (operations under one device and counter), CTL-31
  (collisions noticed against what a receiver holds), CTL-35 (a bound on the devices of the creator):
  nothing is left they could govern; CTL-28 (a basis), CTL-29 (deciding nothing for the person
  before the bootstrap) and CTL-33 (divergences and their confirmation): a device of the creator is
  bootstrapped by another device of the creator or its own state (RSY-14), merges what it is
  answered (CTL-25), and decides nothing but the close and its reason before (CTL-27). **Changed**: ARC-5, LIF-5, LIF-6, LIF-8; CTL-1, CTL-5, CTL-10, CTL-13,
  CTL-20 to CTL-23, CTL-25 to CTL-27, CTL-30, CTL-32, CTL-34, CTL-36, CTL-37, CTL-39, CTL-41,
  CTL-42 (keeping or discarding held changes is offered where a permission is `read` or revoked, not
  where it is merely unknown), CTL-43;
  RSY-4 to RSY-6, RSY-8, RSY-9, RSY-12 to RSY-14, RSY-16, RSY-17; SND-11, SND-20; LOS-6,
  LOS-10, LOS-12, LOS-18, LOS-19, LOS-20, LOS-23, LOS-24; INV-6; LAY-6; PRF-1 (items 2 and 4); VER-3, VER-5; YJS-1. **In
  wording or references only**: TRN-5, TRN-8, FRM-9, FRM-17, CTL-4, CTL-6, RSY-10,
  RSY-18, SND-18. The reason for the close (below) changes LIF-6 and LIF-7 too, and the
  healing at the next occasion (below) the requirements its part names; its end lists every
  requirement changed, new or withdrawn against draft-5.
- **Which decision holds** (CTL-20 to CTL-23, CTL-45): the later by the deciding devices' clocks,
  where of two concurrent operations the narrower held; the narrower value only at equal clock and
  tag. Each device of the creator keeps a clock of its own, at most a day ahead of its wall clock,
  and gives a decision a clock above it and above every register it holds on that target. The
  span is 24 hours, stated in CTL-45; Appendix B repeats it. CTL-45 states the clock as a
  language-neutral algorithm: the next clock and its overflow, the end of the span
  (`[wall + 24 h, 65 535]`), raising on restore and merge, a decision's clock and the own clock
  after it; the own clock never falls when the wall clock jumps back. On a restore and a merge
  alike the own clock rises to the control clock — the greatest clock held —, so a register held
  beyond the span when it came lifts the own clock once the wall clock has caught up.
- **Who answers** (RSY-4 to RSY-6, RSY-9, RSY-20, RSY-21, LOS-20): any member answers a request
  that asks all, at its turn, where a member answered only the creator and another device of its
  own member; a requester asks all in every request but the first of its bootstrap, the creator
  too. A member waiting for its turn falls silent only where the last piece of an answer it heard
  before its turn holds what it would give — its content as it held it, with what the requesting
  stream stated, by state vector and state digest, so that a member that holds beyond the answer
  only the requester's own change stays silent, the deletions compared once it holds what the
  answer counts; its registers and close as it held them —, and answers otherwise, so a member that
  holds what the first answer lacks still gives it. An answer it could not compare so before it was
  heard longer ago than a request to all may wait holds nothing. A member that had nothing to offer
  at its turn lets the request go, and no responder reconsiders a request once the time its
  requester may wait for an answer (RSY-4) has passed, so a later change brings no answers to
  requests that found nothing. A responder that answers at once and has nothing to give keeps the
  request only while it is not bootstrapped (RSY-17), so one gap costs one answer. A bootstrap
  whose attempts ran out asks once more, to all, when, after its latest request that went out had
  its time, it reads a frame of a participant that did not answer that request — on a device of
  the creator, only of another device of hers —, or, whoever answered, a `control` frame, a report
  or a request of another device of the creator that states a control clock; at most one per
  expiry (RSY-5): a joiner waits for the group however long that takes, and an answer that
  bootstraps nothing keeps no one else's frames from bringing the request; the wait at least
  doubles on from its attempts, up to a longest wait (10 min
  recommended), so a member that writes on and never answers costs a few requests an hour, not one
  per expiry; when the person says that another device of the creator or a backup still holds the
  document, the application asks again (CTL-43); while a device is not bootstrapped and its attempts ran out, its application MUST show
  that and SHOULD offer its person to ask again (`syncHealth.attemptsRanOut`) — from when the last
  attempt released the slot, and not while a request of its own is outstanding —; a further
  request whose send failed for a reason worth retrying counts for nothing and is made again once
  the send back-off allows (SND-7), one refused for good counts. A request whose send failed releases the slot
  without counting against the slot's floor; the send floor (SND-2) counts the attempt (RSY-4).
  §10.6 says what an answer only the others heard still does, and states what
  its cases are instances of: closing a loss takes three
  steps, none promised by a time (§15.4) — it can be detected once a message shows it, an update
  that builds on what was lost or a report of someone who applied it; a resync is requested once
  the evidence lasts; the state is restored once an answer that holds it is applied —, an edit
  that does not build on it shows nothing; for control state the narrower limit holds that a
  member's edits and reports state no control clock, so a register only members hold does not
  show to the creator's devices — a member's request is evidence of control state for no one
  (RSY-17) —; the behaviour vectors show the member's edits showing nothing (the flow "§10.6, a
  register only members hold: …"). §10.6 adds
  two more cases: a member judges an answer as it hears it, so an update that reaches it later is
  in no answer it heard; and what the creator's or one's own device that answered lacks, the
  requester lacks too.
- **A return** (RSY-21, RSY-5, LIF-8, Appendix B): a device that starts from persisted content
  after it was away longer than its transport keeps a message for it, or after its application
  had unbound the document, asks all with its first request, once; the return ends once a request
  of it to all was answered, or two such requests expired: an answer lost on its way to the
  returning device alone, which the members that heard it do not repeat (RSY-20), is followed
  by a second request to all. A device of the creator's or of one's own member
  that answers at once may hold less than a member, which then still answers at its turn. The
  application persists when
  its engine began the last read that reached the messenger and whose deliveries the content
  holds — not when the content was taken, which may follow a failed read or one a bridge answered
  from its window —
  and tells the engine that time, how long its transport keeps, and that it had unbound the
  document; the engine's `restore` takes `readAt` and `rebound`, and the option
  `transportRetentionMs` how long the transport keeps. An engine that keeps running returns too
  when its application tells it (`noteAbsence()`, or `noteReturn()`) that the last read that
  reached the messenger began longer ago than the transport keeps — the device slept, or had no
  network —; a return wakes every resting gap. §10.6 says what an outage the application cannot
  see still leaves unseen.
- **The bootstrap in one table** (§8.5): what a bootstrap takes — per source of the answer, what
  is taken, the bounds, a truncated history and when the bootstrap is complete — stated together
  from CTL-13, CTL-25, CTL-41 and RSY-8, RSY-12 to RSY-14, RSY-21, adding no rule.
- **Bootstrapped alike for every device** (RSY-14, RSY-4, RSY-5, RSY-8, RSY-21, LOS-19, CTL-13,
  CTL-25, CTL-32, §8.5): by creating the document, by an answer to its own request that carries
  control state — also one that brings it into a capacity conflict; for a device of the creator
  only one of another device of the creator —, or, on a device of the creator, by a restored or carried state that was bootstrapped; never by content alone, by its own
  decisions, or by an answer to someone else's request, where a device of the creator took a basis
  from another device's snapshot to anyone and any answer to its own request bootstrapped it, with a
  basis or without. A device restarted without a cursor could otherwise be bootstrapped by
  re-reading an old answer, past a revocation a gap may have hidden. Until then a device states no
  control clock or digest and answers with `control: null`; so does a device in a capacity
  conflict, to anyone. A device of the creator that starts from its
  bootstrapped control state without content is bootstrapped at once and returns: its first
  request asks all. *History truncated* evidence ends with an answer that carries control state to
  one's own request sent with `force` after the history was last found truncated, or as LOS-20 says,
  with a request to all sent after that; each time the history is found truncated anew counts, also
  while the evidence stands, which keeps the time it was first found and its gap's tries — a gap that
  rests is not woken by it (LOS-26) —; while the evidence stands, a bridge that answers
  `truncated` again for the same cursor tells of the same loss. An answer to a request sent before,
  also one sent with `force` for an earlier truncation, standing still or ended, may have been taken
  before what the window dropped was sent, and nothing in it says when. For an
  application: `controlStanding` (`none` or `bootstrapped`) and the option
  `onControlStandingChange`; `hasCompletedBootstrap` answers the same.
- **A new device of the creator** (CTL-26, CTL-27, CTL-43, CTL-46, SND-11, LIF-5, ARC-5):
  it is bootstrapped by another device of the creator, or by its own restored or carried state,
  where it decided on a basis or after its person confirmed what members reported; it merges the
  snapshot of every answer to its request as any device does, members' included, but is not
  bootstrapped by theirs, and decides nothing but the close and its reason before. It persists whether it
  is bootstrapped; once it is, a merge that changed its control digest owes a report at once, and
  so does its bootstrap where its control digest then differs from the answer's (SND-11): members
  that hold less see it and ask. Its
  application shows that the rights are not known yet and, once the attempts ran out, asks for
  another device and offers to close and continue in a new document (CTL-43); where no device or
  backup of the creator holds the state, the document is not continued from members' rights
  (CTL-46).
- **Unknown counts as `read`** (CTL-13, §7.1): after the bootstrap a member no register names
  refuses its own edits, where it refused nothing.
- **Control state measured per target** (CTL-34, CTL-37, CTL-32): each target at a fixed width —
  its name as RFC 8785 writes a key, the colon and 86 bytes, the longest register other than one
  on the reason for the close —, the pace not at all; receivers of the same targets reach a bound in any order, and a revocation on a held
  target is never refused for bytes. The flow at 1 MiB generates 3 077 targets.
- **Own changes the profile does not read** (SND-26, YJS-1, PRF-1 item 9): an engine refuses a
  change of its own that its profile does not read as one update, as `unreadable`, reports it and
  never merges it with another; a document of `yjs-paragraphs/1` holds no JSON content or `Any`
  value nested more than 32 levels, which Yjs writes and applies but no receiver reads.
- **Loss evidence by clocks** (LOS-10, LOS-12, LOS-24, RSY-16, RSY-17): a control clock
  above every register held is evidence, control digests are compared at equal clocks, and the
  control digest is that of `{closed, targets}`; holes are gone. Only reports are compared, never
  `control` frames (below). Evidence ends as LOS-18 says. A member's request is evidence of
  control state for no one: a register only members hold stays with them (§10.6, §15.4).
- **What a later right must keep** (VER-5): its place in the order a tie uses instead of a merge.
- **The profile's encoding by reference** (Appendix A, §1.2): updates and state vectors are Yjs
  update encoding version 1, Yjs 13.6.33 its normative reference and yrs an independent
  implementation of it; where Appendix A named a Yjs function or store path as the definition, it
  says what is read, where it ends, what is rejected, what waits for missing predecessors and what
  LOS-23 measures, and names functions only as examples. No byte changes.
- **Matrix attachments** (bindings/matrix.md): `EncryptedFile` v2 by reference to the Matrix
  Client-Server API v1.19, with the fields TDSP reads, the checks around decrypting, and example
  events — a frame in the event, and as an attachment in a plain and an encrypted room.
- **What becomes stable** (§14, bindings/email.md, bindings/local-bridge-interface.md): a table of
  the parts of 2.0, their versions, and which become stable with the release; the email binding's
  layout of a mail and the local bridge interface stay drafts, outside the stable set, and an
  incompatible change of either increments its version.
- **Who takes part** (LIF-9, LIF-10, §6.6, §3.2, bindings §12.5), as above. LIF-10 names three
  inconsistencies: a channel member no register names, a permitted member not in the channel, and
  a revoked member who is still in the channel — the removal failed, or someone took the person
  back in the messenger —, apart while the application is removing it; `channelInconsistencies()`
  returns the last as `revokedInChannel`, and with the option `removing` as `beingRemoved`. LIF-9
  lets an application add a person whose MemberId its transport names only once the person
  accepts the messenger's own invitation, before a permission, which it decides as soon as it can
  — that invitation is not TDSP's —, and MUST send an invitation into the channel only once
  everyone it is meant for holds a permission; a removed person may never see the revocation.
  LIF-10 leaves out the creator, whom no register names (CTL-4), and where the binding cannot add
  a member to the channel or remove one, the application shows that and offers continuing in a
  new document. §15.4 names a revocation the channel cannot enforce: there a concurrent grant may
  undo it; who takes part moves from §15.3 to §15.2.
- **The invitation first in a channel made for the document** (LIF-9): there the creator's
  application may send the invitation before the permissions, and before the initial state once
  its control state is persisted, giving the permissions right after; a joiner reads until they
  arrive. Where frames show as messages, the invitation is then the first one people see. A failed
  initial state then no longer fails the creation: the document stays, its content counts as
  undistributed and goes out whole once it can (SND-20; the engine's option `invitedFirst`).
- **Identities, both ways** (§15.1, BND-1, MTX-4): a device's signature protects against a device
  a provider adds, not against an identity it puts in place of a member's; §15.1 says so for
  Matrix, with the first contact. BND-1 asks every binding whose messenger ties devices or keys to
  an identity to state first contact, a change of identity and what it takes without the tie, and
  its bridges to remember the first identity and, until a person agrees, to give a changed one no
  key and deliver none of its messages — a withheld key limits reading only, and a device of the
  new identity could otherwise write in the member's name, as the creator change rights or close
  the document. MTX-4 asks that of Matrix bridges (pinning) and states keys and frames per state
  of the sender's identity in a table; what came before the agreement is passed over, and the
  agreement starts a new epoch so the engine asks. Frames of a Megolm session whose sending device
  the bridge could not check are no longer delivered (draft-5's exception for older sessions is
  gone). Remembering stays a SHOULD; §15.1 claims protection against a reset identity only for a
  bridge that remembers.
- **The engine** (`@tdsp/document-protocol`): `controlVector`, `controlConfirmed`,
  `controlAnomalies`, `controlDivergences`, `confirmRights()`, `reportedControlState`,
  `ControlDivergence`, `PersistedControlState.counter` and `.basis`, and the reason `anomaly` of
  `ControlFrameRejectedError` are gone. New: `controlClock`; `controlStanding` with the option
  `onControlStandingChange`; `channelInconsistencies()`; `rightOf()` answers `"unknown"`;
  `PersistedControlState.clock` and `.tdsp`, and `.bootstrapped` now for every device; the reasons
  `unknown-permission` and
  `clock-exhausted` of `SendRefusedError`; the exports `Clock`, `Register`, `RegisterState`,
  `ChannelInconsistencies` and `ControlStanding`. A control state persisted in draft-5's
  form, or under any other marker, is read as none (VER-3): a device of the creator restarts as a new one, not bootstrapped, under a
  new tag. RSY-12's age and count of one's own requests are each implementation's own, and
  Appendix B says that every row not marked *required* is a recommendation.
  The requests of an engine's own are kept for 30 min after they went out, longer while an answer
  arrives in pieces, at most 256 (RSY-12, Appendix B), where they were kept for the engine's life;
  an answer to one it forgot is one nobody asked for.
  An answer the profile fails to compute is reported once as `ResyncAnswerError` — the request,
  its requester, the profile's error as `cause` —, where an error while taking the state since the
  request's vector was dropped unreported (RSY-9).

The reason for the close (draft-10), besides wording, references and Appendix G:

- **Why a document was closed** (CTL-23, CTL-36, LIF-6, LIF-7, VER-5, §7.1, §7.3, Appendix B): a
  register on the target `close-reason`, which a device of the creator sets in the `control` frame
  that carries its close, or after the close, and never before. Its value is one of four codes —
  `finished`, `continued`, `creator-state-lost`, `capacity-conflict`, one sentence each in a
  table of §7.3 — or an application's own reason, named as FRM-15 names an extension, of at most
  128 bytes. It merges as every register does; at a tie the greater string in code point order
  holds. A receiver takes any string of 1 to 128 UTF-8 bytes, whatever it names and whether the
  document is closed or not, and shows a reason only once the close holds, one it does not know as
  a close without a known reason; a later minor revision may define further codes (VER-5). Like
  the close it lies outside every bound — not counted, not measured, taken from a frame refused
  for the bounds and in a capacity conflict —, but a device of the creator refuses as a whole, as
  `too-large`, a close with a reason, or a reason after the close, that an answer could no longer
  carry; a close without a reason still goes. A frame or a snapshot now holds at most 5 002
  targets. The vectors show the close with its reason, a reason before the close, two reasons by
  clock, the tie, an application's reason, one this draft does not define, and three values that
  are refused.
- **The engine** (`@tdsp/document-protocol`): `closeDocument(reason?)`, `setCloseReason()` and
  `closeReason`; the exports `CLOSE_REASON_CODES`, `isCloseReason` (what a receiver takes),
  `isNamedCloseReason` (what a device of the creator sets) and `MAX_CLOSE_REASON_BYTES`; the
  reason `not-closed` of `SendRefusedError`. `ControlTarget` includes `"close-reason"`, and a
  register's value may be a string.

Healing at the next occasion (draft-10), besides wording, references and Appendix G:

- **The premise** (§1.1, Appendix G, reason I): loss and reordering are rare, and a loss heals at
  the next occasion; the typical one is a lost last change, which nothing later of its sender
  shows.
- **The report** (§9.3, SND-11, SND-12, SND-13, SND-24, SND-27, SND-28, LIF-6, Appendix B): the
  heartbeat is a report at the end of each **phase** of a sender's own writing — a report delay, 10
  s recommended, after its last `edit` or `control` frame the transport accepted, once nothing of
  its own waits, is under way or is retried, whatever its pacing, and at most one per phase. Only
  the report that ends a phase carries a repeat, once: the phase's last edit, in the heartbeat's new
  field `update`, byte for byte as it went out, where it is whole and fits; or, on a device of the
  creator whose last message was a `control` frame, that frame sent again, unchanged, before the
  report. A receiver applies a carried update as an `edit`'s, whatever the sender's permission
  (CTL-7) and after the close too (LIF-6), and judges the report after it. A send of the whole state
  — the seed, restored content, `resync()` —, a close sent again, a request, an answer and a report
  begin no phase, and reading owes nothing. A report goes at once, the floor permitting and still
  behind a change of its own that waits, when the application stops using the document or the device
  is about to sleep, on a bootstrapped device of the creator after a merge that changed its control
  state and after her bootstrap where her control digest then differs from the answer's, and as
  SND-24 says. It goes through the scheduler, is retried while owed — a report that failed with
  `unavailable` by a back-off of its own, which a return or a read that reached the messenger again
  ends —, never ahead of a change of its own, is reported to no one and marks nothing undistributed.
  A report is owed from the first frame of its phase the transport accepted — the delay only says
  when it is due — until the transport accepted it or refused it for good; owed, it is observable,
  and an application persists it with the content, on that device only, so it goes at the next
  start.
- **What opening a document again brings** (SND-28, RSY-1, §10.6, §15.4): an opportunity to heal a
  lost last change, no promise, in three cases only — the report was still owed, and goes also from
  a device that may no longer write; the device may still write and sends its stored content; a
  start request falls due, on which a receiver that lacks the change asks all and the device
  answers, read-only or after the close too —, each healing only where its message arrives and, for
  a request, someone answers. A report the transport accepted is owed no longer, however it fared,
  and a device that may no longer write sends no content; otherwise the general limit holds, with
  synchronising now as the way out (LIF-12).
- **No `due`, no silence** (SND-3, SND-14, SND-15, SND-16, SND-23, LOS-4, LOS-11, LOS-16, §4.3,
  §9.1): `edit` and `control` frames no longer say when their sender will speak again; nobody's
  silence is evidence, and no expectation has to end. SND-14, SND-23, LOS-11 and LOS-16 are
  withdrawn, and SND-3 keeps only `maxIntervalMs` and `maxChars`.
- **Gaps** (LOS-6, LOS-18, LOS-25, LOS-26, LOS-4, LOS-12, Appendix B): every piece of evidence is a
  gap of one stream — a CRDT client's updates, the deletions one stream's report shows, the control
  state one of the creator's streams reports or her control clock, an answer missing a piece, a
  truncated history —, with a position: the furthest point of its stream a frame names. Each gap
  has its own tries: at most three requests, to all, the first after 2 × the waiting time and a
  place of its own in the answer window, derived from the gap and its own stream as a turn is, so
  that receivers with the same gap ask once (RSY-22); each further one a wait after the try
  before, the first twice the expiry of a request that does not ask all, each at least double the
  one before, up to 10 min recommended, and after a request let go for another's also once that one
  expired, then in its place; then it **rests**, shown to the person, and asks no more
  until a frame raises its position, or a frame of the member that wrote it — under a new client id after a restart —
  comes, at most once in 10 min counted from its previous wake — a frame read sooner wakes it once
  they passed —, its request timed from that frame as the first try from when the gap arose, or an
  absence its application tells of that is longer than a start request's, a return or the person's
  request wakes every gap at once with the one request it brings. Gaps are not kept across
  a restart: they arise anew from the first read.
  Episodes, and evidence ended because a request to all had its time, are gone: a gap nobody can
  heal keeps no later loss of another stream from being asked for. An engine bounds the CRDT
  clients whose positions it keeps (1 024).
- **Control state judged by reports alone** (LOS-10, LOS-12, LOS-18, LOS-25, SND-11, ARC-5, §10,
  §10.6, §15.4, Appendix B): a `control` frame is no evidence, of a higher control clock or of
  another control digest. It carries nothing that orders it among its device's frames, and its
  control clock need not rise — a close, a close sent again, a merge under the greatest clock —, so
  a frame that arrived late showed a difference that was none, for good. A report orders itself by
  its stream and number. A bootstrapped device of the creator reports at once after every merge
  that changes its control digest — a `control` frame of another of her devices too, not only an
  answer —, so a register merged under the greatest clock still shows. The cost: a lost decision
  shows only with the report that ends its device's phase, once that device pauses (a report delay
  after its last edit or decision); where the decision, its repeat and that report are all lost at
  a receiver, it stays there without evidence until a later report or a request makes the control
  state known, or an answer brings the missing registers, and a restart creates that opportunity
  only where a report is owed or a start request falls due — stored content sent again carries no
  rights.
- **A difference in digests lapses** (LOS-12, LOS-18, §10.6, §15.4, Appendix B): a report whose
  state digest differs over the same insertions, or whose control digest differs at the same
  control clock, cannot say which side lacks something, and the report of a stream that no longer
  runs showed it for good. Its evidence lapses once its stream was not heard — by a `heartbeat`,
  a request or a piece of an answer with a number above every one heard of it — for longer than
  the absence of RSY-1 (10 min recommended); a frame offered again, `edit` and `control` keep
  nothing alive, and only a newer report of that stream that still differs brings it back — the gap
  with its time and its tries, woken once by that report; a request made while it lapsed is no try
  of it, and a stream that falls silent and reports again earns no new tries each time. A late
  report that states what a whole answer of its stream brought is no evidence. A whole answer
  covers its stream's state up to its number and later reports of that same state, not a newer
  state: one that arrives after a newer report stating another state leaves that report's evidence,
  and an answer in pieces covers only once it is whole, or once the receiver holds what its last
  piece states, or its stream's state at a higher number. Nothing else lapses. The cost: a real
  difference of a silent stream stays unseen until that stream reports again; one who writes on
  without a pause sends no frame that names their stream, and the report that ends their phase
  brings the difference back where it still holds.
  A member that holds a register all the creator's devices lack asks once for each later decision
  of the creator: a request and an answer per decision, where a content gap's cost is bounded to
  a request in 10 min (§10.6, §15.4).
- **A new CRDT client at every start** (LOS-27): an engine writes under a client id drawn as it
  starts, never under one a restored state holds, so a gap's position is one writer's; about 10
  bytes in every state vector for each session that wrote.
- **Who is asked** (RSY-21, RSY-22, RSY-12, RSY-20, §8): every request asks all but the first of a
  bootstrap — the repeats of the bootstrap, every request for a gap, a start request, the
  person's, and every request in a return. An engine lets an automatic request for gaps go — one
  is about to be made for a gap once its wait passed, or for a further try once the wait since the
  try before passed (after a request let go, once that one had its time), also while it waits for
  its place (LOS-6) — when it heard another's request to all within its expiry that reaches no
  further on those gaps' streams; that counts as a try, it takes the answers to the one it heard,
  which bootstrap nothing, and compares them for its own turn once it applied them; five devices
  with the same gap cost one request and one answer. It keeps 16 such requests. A request read
  late is judged without a clock: of each requesting stream only its latest request counts;
  whether the stream has anything to get is judged by the furthest it stated in any request,
  report or answer's last piece — the frame numbered highest, any digest stated with exactly its
  vector, the greatest control clock —; and a request read in the first read after a start, or in
  the read a return or an absence catches up with, is none an engine lets its own go for (RSY-9,
  RSY-17, RSY-20, RSY-22, §10.6).
- **The start request** (RSY-1, LIF-8, LIF-12, §6.3): a restarted engine reads first; not
  bootstrapped then, it asks as a joiner; bootstrapped, it asks all once, stating its state, only
  after more than 10 min away (recommended) — counted from the start of the last read that reached the messenger
  —, not knowing how long, or holding a gap, and never repeats it unanswered. A running engine told
  of such an absence asks so too. An application tells its engine when the person stops using the
  document and before the device sleeps, how long a running engine was away once a read reached
  the messenger again, and offers its person to synchronise now: a request of its own, which wakes
  every resting gap.
- **The further request of a bootstrap** (RSY-5, CTL-43, Appendix B): once the attempts ran out,
  the further request to all comes on a frame of a participant that did not answer the latest
  request — on a device of the creator, of another of her devices —, or, on every device and
  whoever answered, on a `control` frame, a report or a request of another device of the creator
  that states a control clock: answers count by member, and the creator's may have come from a
  device of hers that holds content alone. So an answer that bootstraps nothing does not stop it
  for good; the waits at least double, up to 10 min
  recommended. When the person
  says that another device of the creator or a backup still holds the document, its application
  asks again; until it is bootstrapped it may keep the person from editing, or hold the edits as
  CTL-42 holds those its engine refuses.
- **A missed close** (LIF-11, §15.4, §10.6): a device of the creator that holds the close and reads
  someone's `edit` sends the close again — a `control` frame under its own tag with `closed`, the
  reason it holds and its control clock and digest, no decision —, at most once per member in
  10 min and once per read — the one it sends counts for every writer in that read it was due
  for —, and not for the edits its first read after a start brings. A member
  that lost the close, its repeat and the report after them while no device of the creator is
  online writes on, and everyone takes its edits.
- **What the switch for automatic requests reaches** (RSY-5, LOS-6, §10.6): it stops the requests
  of LOS-6 and LOS-26 and the repeats and the further request of RSY-5; the requests RSY-1
  requires and a return's requests go all the same. A device still in its bootstrap, of a member or
  of the creator, asks again only as its bootstrap does, also when it returns: its first request is
  its one. A device of the creator asks for its gaps whatever its bootstrap (LOS-6).
- **Binding bounds as keywords** (SND-11, LOS-6, LOS-26, RSY-5): an engine MUST send each report it
  owes and MUST NOT send more than one per phase but in the cases SND-11 names; MUST NOT make more
  than three automatic requests for one gap, nor wait less between two of them than the doubling
  gives; MUST NOT wake a gap by a frame more than once in 10 minutes; and MUST NOT make a further
  request of RSY-5 after a shorter wait than the doubling gives.
- **A document marked but not persisted** (LIF-5, Appendix E): an application creates anew, under
  its documentId, a document it marked as being created for which it persisted no control state:
  nothing of it went out (CTL-26, CTL-38).
- **The reason for the close** (CTL-23, CTL-46, VER-2, VER-5): an application's reason has a
  grammar, `application-reason = label 1*("." label) "/" major`; a reason set before the close is
  refused as `not-closed`; an engine presents a register on `close-reason` to its application as the reason
  only once the document is closed, the register itself staying in the control state it persists;
  `creator-state-lost` means that her devices no longer hold the document's rights, and an
  application that closes because of that should use it; VER-2 leaves an application's reason
  apart from undefined values.
- **Smaller changes**: LIF-9 asks the revocation before a removal unless the engine refuses it
  (LIF-6, CTL-27); CTL-34 and CTL-37 name what they leave out plainly; RSY-14 no longer has a
  device that is not bootstrapped promise anything, and merges every accepted answer, bootstrapped
  or not; RSY-17 and §10.6 say that a member's request is evidence of control state for no one;
  Appendix B rows for the report, the start request, the close sent again and the bounds above.
  What bounds the load is required, and stated in the requirement — three tries per gap, each wait
  at least double the one before, a resting gap woken at most once in 10 min, the close sent again
  at most once per member in 10 min, one report per phase —; the report delay (10 s),
  the absence before a start request (10 min) and the longest wait between two tries (10 min) are
  recommended, the requirement saying "as Appendix B recommends". PRF-1 item 2 asks a profile how
  far an update carries each writer, a gap's position (LOS-25), and Appendix A says it for
  `yjs-paragraphs/1`: the clock after the update's last struct of that client. Appendix D's
  narrative follows the report delay: the device's three decisions went out together after an
  outage, and its first report ends their phase. Appendix E names what an application persists
  and shows of this draft — the time of the last read that reached the messenger, the
  undistributed mark, the report owed, attempts that ran out, a closed document still
  synchronising —, and Appendix G the reason for the close beside the close, outside every bound.
- **On the wire** (§4.3, §4.5, Appendix D, VER-3): `due` is gone from `edit` and `control`; a
  `heartbeat` may carry `update`, never `null`, not empty, a whole update the profile reads
  (FRM-6). The marker is `de.wappensc.together.tdsp.probe.draft-10`, and every file of the draft's
  wire is named for it; a control state persisted under another marker is read as none.
- **The engine** (`@tdsp/document-protocol`): `reportNow()`, `owedReport` with the option
  `onOwedReportChange` and `restore.owedReport` (`OwedReport`), and `SendStatus.reportOwed`
  (SND-11, SND-28, LIF-12); `noteAbsence(awayMs)`, which takes a return beyond the transport's
  retention and a start request beyond 10 min (RSY-1, RSY-21); `requestResync()` asks all and
  wakes every resting gap (LIF-12, LOS-26). `syncHealth` lists one suspicion per gap, with `key`,
  `tries` and `resting`; the kind `sender-overdue` and `SyncSuspicion.due` are gone, and so are
  `EditFrame.due` and `ControlFrame.due`; `HeartbeatFrame.update` is new. The constants
  `MAX_GAP_TRIES`, `WAKE_SPACING_MS` and `REPORT_AFTER_MS` are exported (LOS-6, LOS-26, SND-11).
  `dispose()` sends a report owed last, and one that cannot go stays owed (SND-11, SND-28).
  `@tdsp/reconciliation` gains `clientsAhead()` and `updateClocks()`, which `DocumentProfile` may
  supply as optional `clientsAhead` and `updateClocks` (LOS-25, PRF-1 item 2);
  `DocumentProfile.holdsUpdate` is gone with LOS-16, which it served. `MIN_MESSAGE_BYTES`, 4 MiB,
  is exported, and `DocumentEngine.create()` and `join()` fail with `TransportTooSmallError` on a
  transport whose `bounds.maxBytes` is below it (TRN-23), before `create()` registers the
  document with the transport (TRN-14). `join()` resolves without waiting until the request a
  start makes — a joiner's first, a start request — went out: one the floor or a transport's rate
  limit holds back (SND-7) does not keep the application without its engine (RSY-1). A responder
  judges a request whose state vector holds everything it holds by its whole state digest
  (RSY-17): with the same one it stays silent. An ended gap of control state waits anew before its
  next try (LOS-1).
- **Every requirement, against draft-5**, the text before its rationale compared: changed (72) —
  ARC-5, CTL-1, CTL-4 to CTL-7, CTL-10, CTL-13, CTL-20 to CTL-23, CTL-25 to CTL-27, CTL-30,
  CTL-32, CTL-34, CTL-36, CTL-37, CTL-39, CTL-41 to CTL-43, FRM-9, FRM-17, INV-6, LAY-6, LIF-5 to
  LIF-8, LOS-4, LOS-6, LOS-10, LOS-12, LOS-13, LOS-18 to LOS-20, LOS-23, LOS-24, PRF-1, RSY-1,
  RSY-4 to RSY-6, RSY-8, RSY-9, RSY-12 to RSY-14, RSY-16, RSY-17, SND-3, SND-7, SND-8, SND-10 to
  SND-13, SND-15, SND-18, SND-20, SND-24, TRN-8, TRN-14, TRN-20, VER-2, VER-3, VER-5,
  YJS-1; new (17) — CTL-45, CTL-46, LIF-9 to LIF-12, LOS-25 to LOS-27, RSY-20 to RSY-22, SND-25 to
  SND-28, TRN-23;
  withdrawn (11) — CTL-24, CTL-28, CTL-29, CTL-31, CTL-33, CTL-35, FRM-14, LOS-11, LOS-16,
  SND-14, SND-23.

### Added

- `DocumentEngine`: `controlClock`, `deviceTag` and `controlStanding` (CTL-27, CTL-45,
  RSY-14); `rightOf()`, `revokedMembers`
  and `channelInconsistencies()` (CTL-13, CTL-23, LIF-10); `setLayerRight()`, `layerRights` and
  `mayEditLayer()` (LAY-5, LAY-6); `pace` and `setPace()` (§9.1); `capacityConflict` (CTL-32);
  `cursor` and `instance` (TRN-18, TRN-19); `noteReturn()` and `noteAbsence()` (RSY-21, RSY-1,
  LIF-8, LIF-12); `reportNow()` and `owedReport` (SND-11, SND-28); `closeDocument(reason?)`,
  `setCloseReason()` and `closeReason` (CTL-23). The options `extensions` (FRM-9 to FRM-12),
  `onOwedReportChange` (SND-28), `onControlStandingChange` (RSY-14), `transportRetentionMs`
  (RSY-21, LIF-8), `restore.instance` (§6.3), `restore.readAt` and `restore.rebound` (LIF-8,
  RSY-1, RSY-21) and `restore.owedReport` (SND-28); `SendStatus.reportOwed` (SND-28);
  `PersistedControlState.clock`, `.bootstrapped`, `.capacityConflict` and `.tdsp` (CTL-26, CTL-39,
  VER-3).
- `@tdsp/document-protocol` exports `ChannelInconsistencies`, `Clock`, `ControlStanding`,
  `ControlTarget`, `ControlValue`, `ExtensionKind`, `FrameExtension`, `GapKey`, `IncompleteAnswer`,
  `OwedReport`, `PieceTooSmallError`, `Register`, `RegisterState` and `UnsplittableUpdateError`;
  the constants `MAX_GAP_TRIES` (LOS-6), `WAKE_SPACING_MS` (LOS-26), `REPORT_AFTER_MS` (SND-11) and
  `MAX_CLOSE_REASON_BYTES` (CTL-23); `CLOSE_REASON_CODES`, `isCloseReason` and `isNamedCloseReason`
  (CTL-23);
  `FrameDecodeError.sender`, `SyncHealth.incompleteAnswers`, `SyncSuspicion.key`, `.tries` and
  `.resting` (LOS-25, LOS-26), `HeartbeatFrame.update` (SND-27), and the outcome `failed` of
  `ResyncStatus.lastOutcome`.
- `@tdsp/reconciliation`: `pendingBytes()` and `giveUpPending()` (LOS-23), `splitUpdate()` and
  `UnsplittableUpdateError` (§9.4),
  `encodeDeletions()` and `encodeDeletionsWithin()` (LOS-12, Appendix A), `clientsAhead()` and
  `updateClocks()` (LOS-25), `isUpdate()` and
  `isStateVector()` (PRF-1 item 9), `changedRoots()` (LAY-6). `DocumentProfile` gains the
  optional `isUpdate`, `isStateVector`, `encodeDeletionsWithin`, `clientsAhead` and
  `updateClocks`.
- `@tdsp/messenger-port`: `MessengerPort.receiveSince()` and `instance()`, both optional
  (TRN-18, TRN-19); the send failure `needs-person` with `TransportSendError.needsPerson`
  (TRN-11, TRN-20).
- `@tdsp/document-protocol` exports `MIN_MESSAGE_BYTES`, the 4 194 304 bytes every transport
  carries at least (TRN-23); `DocumentEngine.create()` and `join()` fail on a transport whose
  `bounds.maxBytes` is below it, before anything is sent, with `TransportTooSmallError`, also
  exported, whose `readonly maxBytes` is the bound the transport states.
- The bridges name the instance of their window on `GET /health` (`instance`, TRN-19), a new one on
  every start, since each keeps its window only in memory; `SignalMessengerPort`,
  `MatrixMessengerPort` and `EmailMessengerPort` offer `instance()`, which refuses a bridge that
  names none (TRN-9). An engine on one of them now takes a restart of its bridge as a truncated
  history and asks with `force` (LOS-9); the adapters need a bridge of this version.
- The conformance suite (§3.6) checks `instance()` where a transport offers it.
- The email bridge's `POST /threads/:documentId/remove` (`{actor, participant}` → `{messageId}`)
  and `EmailMessengerPort.removeParticipant(documentId, actor, participant)`: the creator removes
  a participant from an email thread (EML-14). The participant set only shrinks: every bridge
  that reads the creator's removal notice holds the smaller set from then on, across restarts,
  addresses, encrypts and answers `GET /members` with it, takes mail still addressed to the set
  before it, and refuses mail from the removed participant; a bridge whose own address was
  removed refuses to send (403) and delivers nothing more of the thread. A notice not from the
  creator is not taken and is logged (`removal-ignored`), not recorded in the integrity log.
- Behaviour vectors beside the wire's (§3.6), not in the wire lock:
  `test-vectors/clock-draft-10.json` (CTL-45 as pure functions), `digests-draft-10.json` (the
  control digest through its RFC 8785 text, the state digest from the delete-set bytes, LOS-24),
  `updates-draft-10.json` (what a reader of updates takes and refuses, Appendix A) and
  `flows-draft-10.json` (28 flows of several devices in five case groups — answers to all, decisions of two devices of the creator, what bootstraps a device, bounds, Unicode and bytes, and healing at the next occasion —,
  with the format to run them, version 3: a text may be written as a repeat; a matcher with
  `$pieces` (`atLeast`, optional `text`) stands for one update sent in pieces: at least
  `atLeast` frames, each within `maxBytes`, whose updates applied to an empty document project as
  `text`; how many pieces and where they are cut is the implementation's (SND-17, Appendix A); and
  each device's turn and the place of its gaps' first tries are fixed as a test configuration);
  "checked against the vectors" means the published set.
- `conformance/swift-checker/`: a small checker in Swift that, by its authors' account, was
  written from the documents alone and not from the reference implementation; it passes every
  published vector but the flows — frames, invitations, the merge of registers, the digests and the
  clock — and lists in its README where the text left it to choose (Appendix F, CONFORMANCE.md).
- `wire/matrix-v1.json`: three entries at the inline limit as MTX-7 measures it, the envelope as
  written, escapes included; the entry of a 32 000-byte frame in the event is read back only.
- `wire/signal-v1.json`: the §4.5 edit as a 2.0 frame in the Signal envelope, Appendix D's
  example — an entry added within envelope version 1.
- `wire/frames-draft-10.json`: a decision on a right on a layer, two decisions in one frame, a
  repeat to all, and an edit with an extension field, 24 frames in all; the
  published vectors gain a valid frame with a right on a layer.
- `DocumentProfile` gains `pendingBytes` and `giveUpPending`, both required: an engine refuses a
  supplied profile without them, which it could not bound (LOS-23, PRF-1 item 2).
- `SendRefusedError` gains the reason `unreadable` (SND-26); `DocumentEngineOptions` gains
  `invitedFirst` (SND-20, LIF-9); `SyncHealth` gains `attemptsRanOut`, set while a device's
  attempts ran out and it is not bootstrapped, from when the last attempt released the slot and not
  while a request of its own is outstanding (RSY-5). A device of the creator that is not
  bootstrapped refuses every decision but the close and its reason (CTL-27): `SendRefusedError`
  gains the reason `not-bootstrapped`.

### Changed

- `@tdsp/document-protocol` and `@tdsp/reconciliation` need Yjs 13.6.33 or later (was
  13.6.32) (#84).
- `encodeDeletions` and `encodeDeletionsWithin` (`@tdsp/reconciliation`), and with them the state
  digest an engine states (LOS-24): only the deletions a replica applied, as Appendix A defines
  them, where Yjs's `encodeStateAsUpdate` added the structs and ranges held for missing
  predecessors (LOS-23): a replica holding any stated another digest than one that had applied
  the same.
- `encodeUpdate` and `encodeUpdateSince` (`@tdsp/reconciliation`), and with them answers, their
  pieces and `resync()`: only what a replica applied, as Appendix A defines it, where Yjs's
  `encodeStateAsUpdate` added what it holds for missing predecessors — up to 32 MiB that did
  nothing at the receiver but count against the rate limit and be held there too (LOS-23).
- The send scheduler measures its floor, quiet time and back-off on a clock that never runs back:
  a wall clock set back an hour held the next message, a decision included, for that hour (SND-2,
  SND-7). `SendStatus.nextAttemptAt` stays a wall-clock time.
- Every other wait of the engine runs on that clock too, and SND-25 says so for every duration:
  a request's expiry and floor, evidence, turns, back-offs, the throttle, how long requests are
  kept (RSY-4, RSY-20, LOS-1, LOS-6); `syncHealth` reports its times on the wall clock as it reads
  then. A jump forward counts as time that passed (§10.6).
- `TransportProfile` is `{ bounds, pacing }` (TRN-13): each bridge serves the pacing its former
  default profile had — for a server on the same machine the engine's defaults — and the adapters
  refuse the 1.x form.
- `transportSendErrorFromHttp` maps `409` to `needs-person` instead of `rejected` (LBI-6).
- The Signal bridge: a group message nobody got fails as SIG-4 says — `rejected` when every
  member is unregistered, `needs-person` when the others are identities to trust, `rate-limited`
  with the longest wait when one was rate-limited — where all-unregistered was `unavailable`; an
  invitation nobody got fails too. It deletes an attachment's plaintext file on every path, and
  records an edit or deletion, and compares another message, only under an id it delivered
  (SIG-1, SIG-4, BRG-12).
- The bridges answer `409` to every document operation while they are not provisioned, and
  `503` to `/transport-profile`, where a send was refused as `rejected` or `unavailable` before
  (BRG-1). A send refused for what only a person can lift is `409` too: Signal's untrusted
  identities; Matrix's signed-out, locked, suspended or consent errors and a full homeserver;
  email's refused SMTP login, a full mailbox, and for PGP a missing gpg or own secret key, which
  were `502`, `413`, `503` or `422` (BRG-8).
- `@tdsp/messenger-email`'s `IntegrityReason` names a replaced message `message-replaced`, as
  every bridge does, instead of `message-id-reused`; the email bridge records it only for a
  Message-ID it delivered, compared by the frame, and no longer for the thread's root or a mail
  it refused. `@tdsp/messenger-matrix`'s gains `message-replaced`: another event under a
  delivered event id is recorded, not delivered again (BRG-11, BRG-12).
- The Matrix bridge shares a room key also with a device that uploaded its keys between the
  bridge's start and its first `/sync`: after that `/sync` it queries each member's devices once
  more before sharing a key with them, where such a device got no room key until the member's
  device list changed again (MTX-4).
- One message a bridge cannot read no longer keeps it from the others (BRG-18): the Matrix bridge
  reads a `/sync` answer as far as it can, and an event whose reading fails no longer costs the
  round's others; the Signal bridge goes on past a line or notification it cannot read instead of
  ending; the email bridge reads a thread's other mails, and reads one that failed again on the
  next poll, three times at most.
- The email bridge suggests 35 s between messages to a provider, as Appendix B and the email
  binding do, where it suggested 30 s, which ran into a provider's refusals.
- The Matrix bridge persists that it saw a room encrypted with every binding to it, also one made
  later, and learns it from the state of its first `/sync` too (MTX-5): after a restart, or
  where the room's encryption was turned on after the binding, it no longer takes the room as
  plain, and no longer sends into it unencrypted.
- The Signal bridge runs `signal-cli` with `--receive-mode on-connection` and keeps what it
  pushes before the bridge reads it (SIG-5): under the default, `on-start`, what waited on
  Signal's servers while the bridge was down went to `signal-cli`'s standard output and was lost.
  When `signal-cli` exits or its socket closes, the bridge now ends with exit code 1 instead of
  running on without receiving or sending; whoever runs it starts it again.
- The email bridge ignores an envelope that names an `attachment` beside its `frame`, as BND-2
  and BND-4 require; it delivered the frame before.
- The Matrix bridge carries a frame in the event only while the envelope it writes around it,
  escapes included, is at most 32 000 bytes (MTX-7), where it measured the frame alone; a frame
  near the limit, or one with many quotes and backslashes, now goes as a media file.
- The integrity log's entries have a `kind` and an `id` (BRG-15): the bridges serve
  `{kind: "violation", id, sender, reason}`, where the Matrix bridge served `eventId` and the
  email bridge `messageId`; `IntegrityEntry` of `@tdsp/messenger-matrix` and
  `@tdsp/messenger-email` follows, and each adapter exports `readIntegrityLog()`, which reads an
  entry without `kind` as a violation. The Signal bridge records a recipient a send skipped as an
  identity to trust as a notice `{kind: "notice", id, recipient, reason: "recipient-untrusted"}`
  (SIG-4); `@tdsp/messenger-signal`'s `IntegrityEntry` is the union of both, with `NoticeReason`,
  and its wording and summary tell a notice from a violation.
- The Matrix bridge does not send into an encrypted room while its own device is not signed by
  its account's identity: the send fails as `needs-person` (`409`) until the device is confirmed
  with `pnpm run matrix:confirm-device` (MTX-4). It no longer delivers a frame from a device its
  owner has not signed. It still shares room keys with every device (CONFORMANCE.md).
- A Matrix bridge that sent into an encrypted room no longer aborts when it ends ("there is no
  reactor running"). It checks its own device's signature (MTX-4) itself, translated from
  matrix-rust-sdk, instead of through the library's `getDevice()`, whose result kept the crypto
  store alive past `close()` (#135).
- The bridges offer the cursor, `GET /channels/:documentId/deliveries-since?after=` (TRN-18,
  TRN-21), and `SignalMessengerPort`, `MatrixMessengerPort` and `EmailMessengerPort` offer
  `receiveSince()`; an engine on them now reads through the cursor, and a cursor its bridge no
  longer holds reads as truncated. The Matrix bridge also reads a cursor from before a `/sync`
  round answered `limited` as truncated. `@tdsp/messenger-port` exports `deliveriesAfter()` and
  `WindowPosition` for a bridge's window.
- The Signal bridge tells an unlinked device from a passing refusal (SIG-7): a send `signal-cli`
  refuses as having no such account is `needs-person` (`409`) once `signal-cli` no longer names
  the account, and `unavailable` (`502`) while it does; `/auth/status` shows `linked: false` then,
  also after a restart.
- `AttributionRange.authorId` is `string | null`, and `AttributionTracker.recordInsert` and
  `recordDelete` take `null` for an unattributed change; the engine no longer invents the
  MemberId `__tdsp:unattributed__` (ATR-2).
- `SendRefusedError` gains the reasons `revoked`, `unknown-permission`, `capacity-conflict`,
  `too-large`, `clock-exhausted` and `not-closed` (CTL-13, CTL-23, CTL-32, CTL-37, CTL-45);
  `ControlFrameRejectedError` has `refused` (CTL-30, CTL-32) in place of `sequence-conflict` and
  `control-state-unknown`.
- `dispose()` sends a report owed last, after everything else, and one that cannot go stays owed
  (`owedReport`) for the application to persist (SND-11, SND-28).
- The engine rejects before applying anything: CRDT bytes the profile cannot read, a number the
  layout defines written with a fraction, an exponent or as `-0`, and a snapshot with a register
  that is not exactly `value`, `clock` and `device` (FRM-6, §1.6, §4.3, §7.5); a request it fails
  to answer is reported and dropped, the others answered (RSY-9).
- Sending: a refusal worth retrying holds back the next send of any kind and a rate limit widens
  the spacing, also for messages the scheduler does not retry (SND-7, SND-9); `resync()` is kept
  and retried after such a refusal, whole or in pieces (SND-6, SND-10); a resync answer refused
  for good is reported once and marks nothing undistributed (SND-8); an automatic request the
  floor holds back waits in the scheduler, and only one that went out, or was refused for good,
  counts as a try of its gap (LOS-6, RSY-3, RSY-5); the report a phase owes is sent even after a later change is dropped
  (SND-11, LIF-6); the pacing an engine runs lays the application's values over the transport's
  as they are and makes the result consistent once (SND-16).
- Bootstrap and resync: a device of the creator is bootstrapped as any device is — at once when it
  restores a state that was, with or without content (RSY-5, RSY-14);
  the first overlay a joiner adopts stands for the engine's life (RSY-15); every applied answer to
  an engine's own request frees its slot (RSY-4); an answer
  whose send failed for now keeps its requester's turn (RSY-9).

### Removed

- The `fragment` frame kind and its reassembly (§9.4).
- The shared sync policy: `setSyncPolicy`, `invitationPolicy`, the option `syncPolicySequence`,
  `encodeSyncPolicyParam` and `decodeSyncPolicyParam` (§9.1).
- The control sequence and its conflicts: `controlSequence`, `controlGaps`, `controlConflicts`,
  `controlStateKnown` and `proceedWithUnknownControlState()` (CTL-17 to CTL-19 withdrawn), with
  `ControlConflict`, `ControlConflictAction` and `IncompleteMessage`.
- `TransportPolicyProfile` and `transportPolicyProfile()` from `@tdsp/messenger-port` (TRN-13).

## v1.5.0 — 2026-10-24 · implements TDSP 1.4

No byte on the wire changes from v1.4.0.

### Specification: TDSP 1.4

No byte on the wire changes; the new requirements are why this is a minor version.

- CTL-13: while its engine would refuse an edit — before the bootstrap, while the person may
  only read, after a close — an application may hold what the person types outside the
  engine's document instead of preventing the typing. It shows held changes as not merged
  yet, and applies them as a new local edit once the engine may edit, never before. A change
  typed into the engine's document instead can leave the device in the engine's answer to a
  resync request (RSY-8, RSY-10): a reader's reaches a creator that restarts, and so does a
  change made after a close. The rationales of CTL-13 and RSY-10, and §15.3, now say so (#68).
- §11.3: this specification, in this version and every later one, defines invitation
  parameter names without a `.` only, so an application's own parameter whose name contains
  one, under a domain its author controls (`com.example.title`), never collides with a
  parameter a later version adds. A promise of the specification, not a requirement on
  applications (#68).
- BRG-10: a bridge takes a message for a document only from the channel the document is bound
  to, and ignores one from another channel — an edit or a deletion from there too. Who is in a
  document's channel is what decides who can write into it (CTL-7, §15.2) (#78).

### Security

- The Signal and the Matrix bridge take a frame for a document only from the group or room it
  is bound to (BRG-10). They took one from any group or room their account is in, so someone
  outside the document's channel who knew its documentId — a member removed from the group,
  say — could write into it, and an edit or a deletion from there was recorded in its
  integrity log. Permissions and the close were not affected: only the creator's control
  frames count. The email bridge already checks every message against the thread's
  participants (EML-2) (#78).

### Fixed

- The Signal bridge records another message under the id of one already delivered — the same
  author and sent timestamp, other content — as an integrity violation, `message-replaced`, and
  never delivers it; the same message again is dropped as nothing new (BRG-11, BRG-12). Before,
  both were delivered. `@tdsp/messenger-signal`'s `IntegrityReason` gains `message-replaced`
  (#75).
- A send failure whose reason is none of the four — one an adapter of a later version names —
  is retried as `unavailable`, as TRN-12 requires. `TransportSendError.retryable` is now false
  only for `too-large` and `rejected`; before, the engine dropped such a change (#72).
- The Matrix bridge passes on the wait of a rate limit from the homeserver's `Retry-After`
  header, where Matrix 1.10 puts it, and from the body's `retry_after_ms` only without one
  (TRN-11). `@tdsp/messenger-port` exports `parseRetryAfter` for it (#76).
- The Matrix bridge leaves a to-device event nested deeper than 32 levels out of what it hands
  its crypto machine. Any Matrix user can send one, and on Node.js 22 and 24 (measured; not
  on 26) writing it out threw after the `/sync` position had moved on: the frames of that
  round were lost for good (TRN-7) (#77).
- The Signal bridge no longer reports a frame as sent that Signal rate-limited, or could not
  deliver, for some members of the group: `signal-cli` raises no error once one member got a
  message, so the bridge now reads its result per recipient and answers 429, with the longest
  wait Signal stated, or 502 (TRN-6). Members that are not registered, or whose identity the
  account does not trust, still do not hold a frame back, nor does any member an invitation
  (#73).
- The Matrix bridge no longer delivers an unencrypted frame from an encrypted room. In such a
  room the carrier is `m.room.encrypted` (§13.3), and a homeserver can place an unencrypted
  event there under any member's name — the creator's included. A room counts as encrypted
  when it was bound so, or once the bridge saw its encryption turned on or an encrypted event
  in it (#74).

## v1.4.0 — 2026-10-13 · implements TDSP 1.3

No byte on the wire changes from v1.3.0.

### Specification: TDSP 1.3

No byte on the wire changes; the new requirement is why this is a minor version.

- CTL-19 (with CTL-12, CTL-13, RSY-8 and the `control` field in §4): a device of the creator
  that starts without persisted control state — a new device on a messenger without history,
  or one whose state was lost — issues no control frame until another device of the creator
  tells it the control state or it reads the creator's frames from 1 on; until then it answers
  with `control: null`, is not bootstrapped and persists nothing. An application may let it
  proceed after telling the person a change may conflict. The creator's answer bootstraps a
  joiner only when it carries control state (#51).

### Added

- `DocumentEngine.controlConflicts`: the control conflicts (CTL-17) an engine has seen, each
  with its number and the action it kept and the one it rejected, so an application can tell
  the person that permissions may differ instead of only logging the error (#51).
- `DocumentEngine.controlStateKnown` and `proceedWithUnknownControlState()`, and the
  `ControlFrameRejectedError` reason `control-state-unknown` (CTL-19; #51).

### Changed

- A device of the creator joined without `controlState` refuses `setMembership`,
  `closeDocument` and `setSyncPolicy` until it knows its control state, where before it
  issued from number 1 and every other participant rejected the frame as a conflict; its
  `hasCompletedBootstrap` and `onControlStateChange` wait for that too (CTL-19; #51).
- A joiner is no longer bootstrapped by a creator's answer without control state (CTL-13;
  #51).

## v1.3.0 — 2026-10-12 · implements TDSP 1.2

No byte on the wire changes from v1.2.0.

### Specification: TDSP 1.2

No byte on the wire changes; the new requirements are why this is a minor version.

- CTL-18: the creator may run on several devices; a device continues after the control
  numbers another device used, but only after an unbroken run, issues nothing while it lacks
  a frame, and gives up a pending frame whose number another device took. Two devices acting
  at the same moment still collide (CTL-17) (#31).
- RSY-6, RSY-7, RSY-8, RSY-12 to RSY-14, CTL-11, CTL-13: a device answers requests of another
  device of its own member, passing on its control state when it holds it without a gap; the
  other device takes it only as an answer to its own request, and is then bootstrapped. A
  request is one's own by its `requestId` (#31).
- TRN-17 (§3.2, §12.6): an optional `channelMembers(channelId)` in the transport contract,
  and `GET /members?channelId=` on the local bridge interface: a channel's members as the
  messenger reports them now, this account included; a channel this account is not in is
  refused. A snapshot — joins and leaves are not reported (#28).
- MTX-4: a Matrix bridge shares each room key with its own account's other devices too, and
  delivers what they send; the reference bridge already did, now tested (#31).
- EML-12: an email bridge makes sure a copy of every frame mail it sends is in its account's
  sent folder (`\Sent`), and searches that folder too, so another device of the same address
  receives it; with PGP the mail is encrypted to the sender's key as well. The mail other
  participants receive is unchanged (#31).
- TRN-7, SIG-3: an adapter returns what its member sent from another device. A Signal bridge
  delivers the sync transcript Signal hands to an account's other devices, under the id the
  sending device got, and records an edit or a remote delete inside one as an integrity
  violation (#31).

### Added

- `channelMembers()` in `@tdsp/messenger-port`'s `MessengerPort` (optional), the mock and the
  three adapters, and `GET /members` in the three bridges (TRN-17; #28).
- The email bridge's `EMAIL_SENT_COPY` setting: `append` (default), the bridge appends the
  copy itself; `provider`, for a provider that files sent mail on its own (EML-12; #31).

### Changed

- A Signal bridge now delivers what its account sends from another linked device; before, it
  dropped those messages (SIG-3; #31).
- A Signal bridge reports a finished device link at once; before, it stayed `linked: false`
  until restarted, because `signal-cli` 0.14.9 never answers `finishLink` in daemon mode. Log
  event `device-linked`. `pnpm run signal:link` says a code is valid for two minutes, not ten
  (#48).
- A device no longer waits for the creator when another device of its own member is online:
  that device brings it up to date, control state included (#31).
- A device of the creator no longer blocks for good after another device of the creator
  acted (`sequence-conflict` on every later action); it continues after that device's numbers
  (CTL-18; #31).
- A creator restarted without its persisted control state continues when it can read every
  control frame it sent from 1 on, instead of reusing their numbers (CTL-12, CTL-18; #31).

## v1.2.0 — 2026-10-11 · implements TDSP 1.1

No byte on the wire changes from v1.1.0.

### Specification: TDSP 1.1

No byte on the wire changes; the new requirements are why this is a minor version.

- PRF-7: a profile defined outside this specification needs a public definition, covering
  every item of PRF-1, with test vectors, and never changes incompatibly (§5.5; #32).
- PRF-8: neither an engine nor an application loads or installs a profile's implementation
  because a document, an invitation or a frame names it (§5.5; #32).
- PRF-6: a creator's engine refuses restored control state that names another profile than
  the document's (§5.2; #32).
- Layers (§5.6): data beside a document's content, named by a layer id, that every engine
  keeps and passes on (LAY-1) and an application may ignore but never strip, showing that
  it is there (LAY-2); it counts in neither projection nor attribution (LAY-3), and needs a
  public definition with test vectors (LAY-4). YJS-1 admits layers beside `content` in
  `yjs-paragraphs/1`, which stays the same profile (#33).

### Added

- `DocumentEngine.layers` and `isLayerId()`: the layers a document holds, for an application
  to show (#33).
- The engine's `profiles` option: an application supplies document profiles besides the
  built-in `yjs-paragraphs/1`, and `profile` may name one of them. A supplied profile with a
  built-in id, or one given twice, is refused (#32).
- `DocumentProfile.projection` (optional), `ProfileProjection` and `PARAGRAPH_PROJECTION`: a
  profile may bring its own plain-text projection for attribution (PRF-1, item 6); without one
  the engine projects the paragraphs in `content`, as before (#32).
- `pnpm run matrix:confirm-device [bridge url]` signs the Matrix bridge's device with the
  account's self-signing key, read from Secret Storage with the recovery key typed into the
  terminal. Element hides messages from devices their account has not signed (MSC4153).
  Only the self-signing key is decrypted, and nothing is kept
  ([docs/matrix-device-confirmation.md](docs/matrix-device-confirmation.md); #36, #27).
- The Matrix bridge answers `GET /device` with its device id and public Ed25519 key. This
  endpoint is the Matrix bridge's own, not part of the local bridge interface (§12.6) (#36).

### Changed

- `join()` refuses a creator whose persisted control state names another profile than the
  one it is given, before anything is sent (PRF-6; #38).
- Repository process: a change to the text of a normative wire section that changes no byte
  may now take the next minor version of the specification, for a new requirement, as well
  as a patch, for a clarification (`tools/wire-lock.ts`, CONTRIBUTING.md; #35).

## v1.1.0 — 2026-10-11 · implements TDSP 1.0.1

No byte on the wire changes from v1.0.0.

### Specification: TDSP 1.0.1

- CTL-12 states which send failure frees a control frame's number: only a refusal for good
  (#24, #15).
- Every JSON message TDSP defines nests at most 32 levels; deeper input is not that message
  (§1.6, §4.4, BND-2; #25, #12).
- INV-8: an invitation may travel in a link's fragment; a reader should look in both
  fragment and query (#26, #16).
- RSY-6's rationale no longer assumes content is never persisted; §6.3 says an application
  may persist it (#22, #14).

### Added

- `join(…, { restore })` starts from persisted content. Restored content counts as
  undistributed until the engine has sent it whole once (#30, #13).
- `invitationFromUrl()` reads an invitation from a whole link (#26, #16).
- `MAX_JSON_NESTING`, `jsonTextTooDeep()` and `jsonValueTooDeep()` in `@tdsp/messenger-port`
  (#25, #12).

### Changed

- `setMembership`, `closeDocument` and `setSyncPolicy` wait while the transport is
  unavailable, instead of rejecting. They reject when the frame is refused for good, or when
  the engine is disposed first (#24, #15).
- A restarted creator sends a pending control frame right after `join()` (#24, #15).
- A frame nested deeper than 32 levels is rejected as `not-json` (#25, #12).

### Fixed

- A control frame whose send failed only for now stays pending and is retried. Freeing its
  number could leave permissions diverged (#24, #15).
- The Signal bridge recognises Signal's rate limit (JSON-RPC code -5) and passes on the wait
  it states (#20, #18).
- Attribution places a whole inserted or removed paragraph correctly when the neighbouring
  text repeats (#21, #19).
- `create()` refuses persisted control state; a creator resumes with `join()` (LIF-5; #23,
  #13).

### Known gaps

- The Matrix bridge's device was not cross-signed, which Element's MSC4153 default excludes
  (#29, #27). Closed in the next release.

## v1.0.0 — 2026-10-01 · implements TDSP 1.0

The first release: the specification TDSP 1.0 (wire version 1, profile `yjs-paragraphs/1`)
and a reference implementation of every conformance class: the engine, the document profile,
the transport contract with its conformance suite, the in-memory transport for tests, and the
Signal, Matrix and email adapters and bridges. The specification TDSP 1.0 is dated
26 September 2026.
