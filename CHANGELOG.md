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

### Specification: TDSP 1.1

No byte on the wire changes; the new requirements are why this is a minor version.

- PRF-7: a profile defined outside this specification needs a public definition, covering
  every item of PRF-1, with test vectors, and never changes incompatibly (§5.5; #32).
- PRF-8: neither an engine nor an application loads or installs a profile's implementation
  because a document, an invitation or a frame names it (§5.5; #32).
- PRF-6: a creator's engine refuses restored control state that names another profile than
  the document's (§5.2; #32).

### Added

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
