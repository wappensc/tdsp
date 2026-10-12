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

Nothing yet.

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
