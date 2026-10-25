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
`de.wappensc.together.tdsp.probe.draft-5` instead (VER-3) — and every 1.x engine refuses
them, as VER-1 intends. The envelope and the profile `yjs-paragraphs/1` keep version 1, and
the wire of 1.x stays frozen beside the draft's. Appendix G of the specification lists every
requirement withdrawn, changed or added, each with the reason, and what 2.0 leaves out of
#50 and #71.

### Specification: TDSP 2.0 (draft)

How the text is written:

- **Readable, requirement by requirement**: long requirements are split, each keeping its ID for
  its first part, and the new parts have IDs of their own — CTL-34 to CTL-43, LOS-15 to LOS-22,
  RSY-18, RSY-19, SND-20 to SND-24, TRN-21, TRN-22, FRM-15 to FRM-17, LAY-7, VER-6, EML-13.
  Sentences that used RFC keywords without an ID, informative under §1.3 although meant to apply,
  are requirements now: LOS-15, LIF-8, INV-10, SEC-1, SEC-2, JSN-1, BND-4. Appendix G lists them.

The frame and the wire:

- **The draft's wire** (VER-3): `wire/frames-draft-5.json` and `wire/invitations-draft-5.json`
  are frozen like 1.x's files, and `packages/document-protocol/test-vectors/frames-draft-5.json`,
  `invitations-draft-5.json` and `control-draft-5.json` are the published vectors, read by a
  receiver of `yjs-paragraphs/1` (their `profile` field). An incompatible change of the draft
  names a new marker.
- **Extension fields** (§4.4, FRM-9 to FRM-12): a field whose name contains `.` is ignored when
  unknown, in frames, snapshots and overlays; the keys of objects whose keys are data — a
  snapshot's `targets`, control vectors, `lastEditBySender` — are not field names, so a target
  such as `member:@bob:example.org` is a target. An extension's name ends with its major version
  (`com.example.mood/1`); a sender names in `crit`, once each, every extension the frame carries
  that changes what a receiver does with the defined fields; a receiver checks the value of one
  it implements, ignores an invalid one, and rejects the frame when `crit` names one it does not
  implement (`unsupported-extension`), names one the frame does not carry or names one twice
  (`invalid-field`). A definition states kinds, values, the meaning of absence, criticality and
  handling (FRM-12); an engine passes no extension on.
- **Which reason comes first** (FRM-13, §4.4): `not-json`, then `unsupported-version`, then
  `unknown-kind`; among the others a receiver reports any that applies. `profile-mismatch`
  (CTL-10) is in the table of reasons. Every rejected test vector has one fault.
- **No entry of 0 in a control vector** (FRM-14, §4.3, §7.4, LOS-12): a sender never writes one —
  a device known only above a hole is absent — and a receiver reads one as absent, holding,
  passing on and digesting nothing for it and not counting it against CTL-30's bound.
- **Reading without applying** (PRF-1 item 9, §4.4, FRM-6, Appendix A): a profile says how to
  tell, changing no replica, whether bytes are exactly one update or one state vector; an
  `update` or `stateVector` the document's profile does not read so is `invalid-field`, also
  with bytes after a complete one.
- **An answer's update is never empty** (§4.3, PRF-1 item 4, SND-18, CTL-30): where a requester
  lacks nothing, or a last piece carries only the snapshot and the overlay, a `resync-response`
  carries the profile's update that holds nothing — for `yjs-paragraphs/1` the two bytes
  `00 00`, Base64 `AAA=`. An empty `update` is `invalid-field` in every kind.
- **Requests and heartbeats** carry a control vector instead of a control sequence, and state
  digests (below); a request's `bootstrap` flag becomes `force`, set after a truncated history.
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

- **A set of operations**: every device of the creator counts its own operations; each names
  what its device had seen (`seen`, a version vector, naming other devices only — CTL-20), so a
  decision made in knowledge of another stands and of two concurrent ones the narrower holds.
  The gap-free sequence, the outbox, conflicts under one number (CTL-17), devices continuing
  after an unbroken run (CTL-18) and the waiting device without control state (CTL-19) are
  withdrawn. Different operations under one device and counter on one target merge into one
  with the narrowest value (CTL-24).
- **Revoked is not unknown** (§7.1, CTL-13, CTL-23, LAY-5, LAY-6): a member on whose target a
  revoking operation holds is revoked, and its engine refuses its edits as a reader's, on the
  document and on every layer; only a member the creator never named is unknown and refused
  nothing after the bootstrap. Of concurrent values on a layer target, `read` is narrower than
  inherit (`null`), and inherit than `write`; a reset made in knowledge of a restriction still
  supersedes it.
- **A snapshot is a union** (§7.4, §7.5, CTL-15, CTL-23, CTL-25): a receiver keeps every head and
  everything a target's operations had seen; a new optional field `aboveHoles` lists, per device,
  the counters held above its entry in `vector`, so merging a snapshot is what applying its
  operations gives, holes and vector included.
- **Collisions are noticed against what a receiver holds** (CTL-24, CTL-31): an operation under
  a device and counter at which another one is held unsuperseded is an anomaly, live, from a
  snapshot and after a restore; a device of the creator takes a new tag on any collision under
  its own tag.
- **A new device of the creator decides at once** (CTL-27 to CTL-29); members may tell it which
  counters to supersede, never what holds, and a device counts reported counters only until it
  has a basis. **What only members hold** (CTL-27, CTL-31, CTL-33, §15.5): a device of the
  creator shows every target on which a member's report holds an operation it neither holds nor
  supersedes, for display only, and an explicit confirmation issues each such target again with
  the value it holds, counting the reported counters as seen.
- **Persisting and restoring** (CTL-13, CTL-26, CTL-28, §6.3, LIF-5, RSY-16): the creating device
  reports its control state before the start frame and creates nothing if that fails; a device
  of the creator persists whether it had a basis, and a restored state is a basis only if it was
  one; any participant may persist its control state, and a member's restored state bootstraps it
  once it has read on from the cursor persisted with its content. An engine reports every change
  of its control state before its cursor reads past the delivery that brought it.
- **Bounds** (CTL-30, CTL-32, §15.3, §15.4): 64 devices, 1 024 counters above a hole (the
  operation that fills a hole is always taken), 5 002 targets, and bytes: a receiver holds up to
  3 MiB of control state, measured as the UTF-8 of the RFC 8785 serialisation of the snapshot's
  `vector` and `targets` without the close; a device of the creator adds a target only up to
  1 MiB and refuses, as `too-large`, an operation after which no answer of its transport could
  carry the snapshot (SND-18). The close is a bounded record — each device's latest, of the 64
  devices first in code point order, without `seen` — and is never refused for the bytes, so a
  full document can always be closed; a target's `seen` names at most 64 devices. At a bound a
  receiver keeps those first in code point order, so what it holds does not depend on the order
  of arrival. Beyond the bytes a receiver is in a **capacity conflict** for good: it reports it,
  takes no new member or layer right, refuses its own edits, and is bootstrapped by no snapshot it
  refused; an application persists and shows it.
- **What a later right must keep** (VER-5): a revision that defines a new value for a member's
  permission or a layer right defines the capabilities it grants and a merge that grants no more
  than every merged value, commutative, associative and idempotent, with decisions made in
  knowledge of others superseding and revocation first, and keeps older engines from reading it
  as `write` or inherit.

Rights on layers (§5.6, LAY-5, LAY-6; §7.1, CTL-4, CTL-13, CTL-20, CTL-30):

- The creator may give a member a right on a layer, `read` or `write`, through the target
  `layer:<layer id>:member:<MemberId>`; without one, the member's permission on the document
  applies. The sending engine tells from each change which parts it touches and refuses one that
  touches a layer it may not write, whole; receivers still reject nothing for a right (CTL-7).

Sending and pacing (§9):

- **No shared sync policy** (§9.1, SND-14 to SND-16): the creator sets one number for everyone,
  the pace; everything else about pacing is each participant's own, and every `edit` and
  `control` frame says within how long its sender will speak again (`due`). The `policy`
  action, the policy text of §11.2 and the `policy` invitation parameter are withdrawn. The
  pacing an engine runs is the engine's defaults, under the transport profile's `pacing`, under
  what the application chose.
- **Pieces instead of fragments** (§9.4, PRF-1 item 7, SND-17 to SND-19): a profile splits a
  large update into pieces that are updates themselves; the `fragment` kind and its reassembly
  are withdrawn. A refused piece drops the rest of its update. An application writes indivisible
  units no larger than the profile allows.
- **The heartbeat** (SND-11, SND-14) counts from the earlier of the last `edit` and the last
  `control` frame, so an answer to a joiner does not push it past an edit's `due`; an engine that
  hears a request stating exactly what it holds, while what it deleted within its latest report
  has changed, sends one as soon as the floor permits.
- **What the text left open about sending** (SND-1, SND-2, SND-7 to SND-10, RSY-3, RSY-4, LOS-2,
  LOS-8, §10): `flush()` and `dispose()` keep the floor and the waits the provider asked for; a
  request the floor holds back waits and its expiry counts from when it went out; a failure worth
  retrying of a message of any kind holds back the next send of every kind; a dropped answer,
  request or heartbeat leaves nothing undistributed, and an application shows undistributed
  changes and offers to send the whole state again; a request that could not be sent is no
  error, its outcome `failed`; a non-finite floor, `minChars` or latency falls back to its
  default; a deletion the CRDT holds back is a pending gap.
- Appendix B suggests 35 s between email messages, above the one per 34 s one provider was
  measured to allow.

Loss evidence (§10):

- **State digests** (LOS-12, CTL-31, PRF-1 item 8; RSY-8, RSY-16, RSY-17, SND-11): heartbeats and
  requests carry, beside their vectors, a state digest — of what the sender deleted — and a
  control digest, the first 8 bytes of SHA-256, and an answer's last piece the responder's state
  vector and state digest. A receiver that holds every insertion a report's state vector counts
  compares what it deleted within that vector, so a lost deletion shows although it has edited
  since and heals; a responder answers a request whose state vector holds all of its own and whose
  digest differs.
- **Streams** (LOS-13): a heartbeat, a request and every piece of an answer name their sender's
  stream — 16 hex digits, random for every engine as it runs — and a `sequence` in it; a receiver
  keeps the latest report of each of a member's streams, and a report replaces only an older one
  of its own stream, so the report of a device that lags behind does not end the evidence of
  another device of its member.
- **Numbered pieces** (LOS-14, RSY-8): every piece of an answer carries its number `piece`, its
  last piece the count `pieces`; an answer to an engine's own request is counted by its sender,
  stream and number, bound to the request, apart from the stream's reports, and one of which a
  piece is missing is the evidence `answer-incomplete`, and the engine asks again.
- **Silence per frame, judged by the pace** (LOS-11, LOS-4): a heartbeat ends the expectation only
  of the frames it holds, a further frame only that of the earlier frames of its own source; a
  receiver waits for the larger of a sender's `due` and the pace; frames of an engine's own member
  count, its own coming back do not; a member's latest reports are judged, so one device's does
  not hide another's.
- **Requests of several devices** (RSY-9): a responder keeps the requests it could not answer yet
  by request id, up to four per requester, and serves requesters in turn; one for which the
  profile fails to compute an answer is let go and reported, and the others are answered.
- **What no evidence shows** (§10, honest limits): a lost update that only deleted, and two
  different control operations under one device and counter, leave every vector equal; where
  they heal is said.

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
  and sends at once on `flush()`. A failure that carries none of the five reasons counts as
  `unavailable`.
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
  unseen with updates whose predecessors never come.
- **A pace is bounded** (SND-15, Appendix B): one longer than an engine's bound, 10 minutes
  recommended, runs as that bound, for sending and for judging silence alike, so a document can be
  made quiet, not mute.

One person's devices (ARC-5, ARC-2):

- **An application may carry a document between one person's devices** through another service,
  and tells the person. A device of the creator that takes over carried control state continues
  under a new tag, its engine merges the state as a snapshot carried from another device of the
  creator (CTL-25), which is a basis only if it was one there (CTL-28), and the device counts as
  bootstrapped (RSY-14). ARC-2's ban on connections other than to the bridge names that service
  as its one exception.

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
  bridge's own device signed, frames only from signed devices or sessions from before trust
  information was collected; an unencrypted TDSP event in a room once seen encrypted, an edit
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
- **The pace bound is each engine's own** (SND-15, LOS-11): 10 minutes recommended, not a number
  every engine must use, since a receiver waits for the longer of a sender's `due` and the pace it
  runs itself.
- **Profile and layer ids** (PRF-7, LAY-4) should begin with a reverse domain name their definer
  controls, as an extension's does.
- **The digest is a requirement** (LOS-24): the first 8 bytes of SHA-256 — the state digest over the
  profile's encoding of what the sender deleted, the control digest over its control snapshot's
  vector and targets, without `aboveHoles` —, as §10.3 defined it informatively.
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

### Added

- `DocumentEngine`: `controlVector`, `deviceTag`, `controlConfirmed`, `controlAnomalies`,
  `controlDivergences` and `confirmRights()` (CTL-24, CTL-27, CTL-33); `rightOf()` and
  `revokedMembers` (CTL-13, CTL-23); `setLayerRight()`, `layerRights` and `mayEditLayer()`
  (LAY-5, LAY-6); `pace` and `setPace()` (§9.1); `capacityConflict` (CTL-32); `cursor` and
  `instance` (TRN-18, TRN-19); `reportedControlState`. The option `extensions` (FRM-9 to FRM-12),
  `restore.instance` (§6.3) and `PersistedControlState.basis` and `.capacityConflict`.
- `@tdsp/document-protocol` exports `ControlDivergence`, `ControlTarget`, `ControlValue`,
  `ExtensionKind`, `FrameExtension`, `IncompleteAnswer`, `PieceTooSmallError` and
  `UnsplittableUpdateError`; `FrameDecodeError.sender`, `SyncHealth.incompleteAnswers`, and the
  outcome `failed` of `ResyncStatus.lastOutcome`.
- `@tdsp/reconciliation`: `pendingBytes()` and `giveUpPending()` (LOS-23), `splitUpdate()` and
  `UnsplittableUpdateError` (§9.4),
  `encodeDeletions()` and `encodeDeletionsWithin()` (LOS-12, Appendix A), `stateVectorHolds()`
  (PRF-1 item 3, LOS-11), `isUpdate()` and `isStateVector()` (PRF-1 item 9), `changedRoots()`
  (LAY-6). `DocumentProfile` gains the
  optional `isUpdate`, `isStateVector` and `encodeDeletionsWithin`.
- `@tdsp/messenger-port`: `MessengerPort.receiveSince()` and `instance()`, both optional
  (TRN-18, TRN-19); the send failure `needs-person` with `TransportSendError.needsPerson`
  (TRN-11, TRN-20).
- `wire/signal-v1.json`: the §4.5 edit as a 2.0 frame in the Signal envelope, Appendix D's
  example — an entry added within envelope version 1.
- `wire/frames-draft-5.json`: a control operation on a right on a layer, and an edit with an
  extension field; the published vectors gain a valid frame with a right on a layer.
- `DocumentProfile` gains the optional `pendingBytes` and `giveUpPending` (LOS-23).

### Changed

- `@tdsp/document-protocol` and `@tdsp/reconciliation` need Yjs 13.6.33 or later (was
  13.6.32) (#84).
- `TransportProfile` is `{ bounds, pacing }` (TRN-13): each bridge serves the pacing its former
  default profile had — for a server on the same machine the engine's defaults — and the adapters
  refuse the 1.x form.
- `transportSendErrorFromHttp` maps `409` to `needs-person` instead of `rejected` (LBI-6).
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
- `AttributionRange.authorId` is `string | null`, and `AttributionTracker.recordInsert` and
  `recordDelete` take `null` for an unattributed change; the engine no longer invents the
  MemberId `__tdsp:unattributed__` (ATR-2).
- The engine rejects before applying anything: CRDT bytes the profile cannot read, a number the
  layout defines written with a fraction, an exponent or as `-0`, and a snapshot that lists two
  heads of one device on a target (FRM-6, §1.6, §4.3, §7.5); a request it fails to answer is
  reported and dropped, the others answered (RSY-9).
- Sending: a refusal worth retrying holds back the next send of any kind and a rate limit widens
  the spacing, also for messages the scheduler does not retry (SND-7, SND-9); `resync()` is kept
  and retried after such a refusal, whole or in pieces (SND-6, SND-10); a resync answer refused
  for good is reported once and marks nothing undistributed (SND-8); an automatic request the
  floor holds back waits in the scheduler, and only one that went out counts against the bound
  per episode (LOS-6, RSY-3, RSY-5); the heartbeat an earlier message owes is sent even after a
  later change is dropped (SND-11, LIF-6); a control frame's `due` is what its device keeps once
  the operation holds (SND-14, SND-15); the pacing an engine runs lays the application's values
  over the transport's as they are and makes the result consistent once (SND-16).
- Bootstrap and resync: a device of the creator is bootstrapped by any answer to its own request,
  and at once when it restores content with a control state that had a basis (RSY-5, RSY-14);
  the first overlay a joiner adopts stands for the engine's life (RSY-15); every applied answer to
  an engine's own request frees its slot and ends the silence expected (RSY-4, LOS-11); an answer
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
