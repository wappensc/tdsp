# A Swift checker of the published vectors

A small program in Swift that reads the wire and the behaviour vectors of
[§3.6](../../SPECIFICATION.md#36-conformance-suite) and says, per file, which pass. It is the
first counterpart to the reference implementation written independently of it: **only from the
documents** — [SPECIFICATION.md](../../SPECIFICATION.md), [bindings/](../../bindings/),
[CONFORMANCE.md](../../CONFORMANCE.md) and the vector files — and from the public standards
they name: RFC 8259 and RFC 7493 (JSON, I-JSON), RFC 4648 (Base64), RFC 8785 (canonical JSON),
FIPS 180-4 (SHA-256), the WHATWG URL standard (`application/x-www-form-urlencoded`), and for
the profile `yjs-paragraphs/1` the normative reference of Appendix A, the sources of Yjs 13.6.33
and lib0 0.2.118, which it was written from (the reference implementation resolves lib0
0.2.117). No line of the reference implementation's code was read or imported to write
it. Where the text left a vector's result open, the checker does not guess from the engine; it
says so below.

It is no engine and exchanges nothing with one: what it shows is that a second reading of the
text gives what the vectors state, not that two engines interoperate. Foundation only, no
dependencies; SHA-256 is implemented here, so the results are the same on macOS and Linux.

## What it checks

| File | What the checker does |
|---|---|
| `packages/document-protocol/test-vectors/frames-v2.json` | Decodes each frame as a receiver of `yjs-paragraphs/1` (§1.6, §4, §5.4, §7.5): a valid one to its kind and, where listed, its snapshot's targets; an invalid one to the reason of §4.4. Updates and state vectors are read without applying them (Appendix A), by a reader of Yjs update encoding version 1 written for this |
| `packages/document-protocol/test-vectors/invitations-v2.json` | Reads each query as §11.3 and INV-6 say, to the invitation or to the vector's `problem` |
| `packages/document-protocol/test-vectors/control-v2.json` | Merges each vector's registers (CTL-22, CTL-23) in every order, each frame also twice and the whole twice, and as one snapshot; compares the state, its control digest (LOS-24) and every member's right on the document and on the layer (§7.1, LAY-5) |
| `packages/document-protocol/test-vectors/digests-v2.json` | The control digest through its RFC 8785 text and its length in bytes; the encoding of what a replica deleted, within a state vector where given, and its state digest (Appendix A, LOS-24); for `fromUpdates`, a small replica that applies the updates, holds what lacks its predecessors, and projects the text (Appendix A, YJS-4) |
| `packages/document-protocol/test-vectors/updates-v2.json` | Reads each update and state vector as Appendix A's *Reading without applying* says, to whether it is one: integers up to 2^53 − 1 in at most 8 bytes, a client's structs and each delete range ending at most at 2^53 − 1, JSON content and `Any` values nested at most 32 levels |
| `packages/document-protocol/test-vectors/clock-v2.json` | CTL-45's algorithm as written: `next`, `wall`, `cap`, `raise`, a decision, and sequences of them |
| `wire/frames-v2.json` | Reads each frozen frame back: its kind, and its fields equal to the entry's `input`. It does not re-encode: the text fixes no order of a frame's members (FRM-4), so byte-equal output is the reference encoder's property, not the wire's |
| `wire/invitations-v2.json` | Reads each link to its invitation |

Not run: `flows-v2.json`, which needs an engine.

## Running it

From this repository's root (the specification's directory):

```sh
swift test --package-path conformance/swift-checker
swift run --package-path conformance/swift-checker tdsp-checker            # a line per file
swift run --package-path conformance/swift-checker tdsp-checker --verbose  # every vector, and why each rejection was rejected
```

`swift test` needs XCTest, which comes with Xcode on macOS and with the Swift toolchain on Linux;
the Command Line Tools alone do not have it. `swift run … tdsp-checker` needs only the toolchain.

`tdsp-checker` takes the specification's directory as an argument and otherwise finds it from
its own place in the tree; it exits 1 if any vector fails. Every vector passes at TDSP 2.0, whose frames and
invitations carry the version `2`.

## What the text left open

Nothing, as of TDSP 2.0. Writing the checker turned up thirteen places where a second
reading of the text could fail a vector while following the words; the text now says, for
each, what it means, and the checker follows it:

1. A required field absent at any level is `missing-field` (§4.4, §7.5).
2. An integer is digits without a sign: `-0` is `invalid-field` (§1.6).
3. A device tag is 22 base64url characters, its spare bits unchecked — the one exception to
   the canonical form (§1.6, §4.3).
4. An invitation's problems, by name, and the order they are judged in (§11.3, INV-6).
5. `recipients`: distinct in lower case, the form of an address, the creator not checked
   (§11.3).
6. Another provider requires `channelId`; a parameter of another binding is checked and read
   (§11.3).
7. No variable-length integer above 2^53 − 1 or longer than 8 bytes, anywhere, also where lib0
   reads one (Appendix A).
8. JSON content and `Any` values in an update nest at most 32 levels, counted as a frame is
   (Appendix A); the checker has no bound of its own beside it.
9. JSON content parses as ECMAScript's `JSON.parse`; `undefined` is Yjs's undefined value
   (Appendix A).
10. Appendix A's reference names the Yjs files a reader needs, the skip as info byte 10
    itself, and a parent-info number other than 1 as an id.
11. 5 002 targets on members, without the pace and the reason for the close, break no layout,
    only CTL-30's bound (§4.3, §7.5), so the checker accepts them as a layout.
12. An overlay's `ranges` may be empty; a decline's optional fields, and a heartbeat's
    `update`, are never `null` (§4.3, §5.4). A frame that is not UTF-8 is `not-json`, which no
    vector shows: the frame vectors carry frames as JSON strings.
13. The rights in `control-v2.json` are the registers' permissions, not what a closed
    document takes (§3.6, LAY-5).

One difference from the reference implementation stays, and no vector shows it: of a frame
that both lacks a required field and has one its kind does not define, this checker reports
the missing one (`missing-field`) and the reference the undefined one (`invalid-field`).
§4.4 lets a receiver report any reason that applies; every invalid vector has one fault.
