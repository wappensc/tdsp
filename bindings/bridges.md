# TDSP bindings — Bridges and the common envelope

**Specification · TDSP bindings 1.4.1 · 24 October 2026**

Part of TDSP 1.4.1, whose core is [SPECIFICATION.md](../SPECIFICATION.md). This
document holds what TDSP 1.4 had in §12.1 to §12.5, §13 up to §13.1 and Appendix C of its specification, unchanged: its
requirements keep their IDs, and its sections their numbers, so a reference to either
stays unambiguous. The requirement language and the conformance classes are the core's
([§1.3](../SPECIFICATION.md#13-requirement-language),
[§1.4](../SPECIFICATION.md#14-conformance-classes)).

## 12. Bridges

A bridge is where TDSP meets one messenger account. Everything in this section
applies to every bridge, whether its adapter calls it in-process or across a
process boundary; the local HTTP interface of
[§12.6](local-bridge-interface.md#126-the-local-bridge-interface-optional) is an option on top.

### 12.1 Account and credentials

A bridge speaks for exactly one messenger account. How that account is set up —
linking a device, logging in, configuring a mailbox and a keyring — is specific
to the messenger, and each binding says how ([§13](#13-messenger-bindings)).

- **BRG-1** · *bridge* — A bridge MUST serve exactly one messenger account, MUST be
  provisioned with it before it serves any document, and MUST refuse every
  document operation, distinguishably, while it is not.
  *Rationale:* an unprovisioned bridge that accepted a send would lose the message
  without saying why; a distinguishable refusal lets the application ask the
  person to finish the setup.
- **BRG-2** · *bridge* — Provisioning MUST NOT pass a credential through the
  engine, the application or any interface a document operation uses; what the
  person needs to see (a device-linking code, a login prompt) MUST NOT itself be a
  reusable credential.
  *Rationale:* ARC-4 — credentials stay with the component that exists to protect
  them.
- **BRG-3** · *bridge* — A bridge MUST keep credentials readable only by the user
  (a directory of mode `0700` or stricter, or the platform's keychain), and a
  local socket to a helper daemon MUST be accessible only by the user (mode
  `0600`).
  *Rationale:* credentials are the one thing a bridge exists to protect.
- **BRG-4** · *bridge* — A bridge MUST NOT open a network connection to anything
  but its one configured messenger endpoint (and a local helper daemon, where the
  binding has one).
  *Rationale:* TDSP's one security property that is its own rather than inherited:
  it opens no external connection except to the messenger the user chose — no
  telemetry, no update check, no second host.

### 12.2 Binding a document

- **BRG-5** · *bridge* — Binding MUST verify, read-only, that the channel exists and
  that this account is a member of it, before the binding is stored, and MUST
  NOT create, configure or post into the channel as part of binding.
  *Rationale:* this re-check is what makes an invitation a convenience rather than a
  capability ([§11](../SPECIFICATION.md#11-invitations)); failing at bind time makes a stale id fail
  loudly instead of silently never delivering.
- **BRG-6** · *bridge* — A bridge MUST persist bindings so that a crash while
  writing cannot corrupt the bindings of other documents (for example, write to a
  temporary file and rename it).
  *Rationale:* one file typically holds every document's routing.

### 12.3 Sending

- **BRG-7** · *bridge* — A bridge MUST carry a frame in its messenger binding's
  envelope ([§13](#13-messenger-bindings)) and MUST NOT inspect or change it.
  *Rationale:* ARC-3.
- **BRG-8** · *bridge* — A bridge MUST classify every failed send as one of the
  four reasons of [§3.4](../SPECIFICATION.md#34-send-failures), mapping what its messenger said.
  *Rationale:* only the bridge knows whether its messenger's refusal will pass
  (a rate limit, an outage) or not (a size limit, a forbidden sender).
- **BRG-9** · *bridge* — A bridge that supports attachments MUST choose between the
  message body and an attachment by the frame's size alone, MUST state the largest
  frame it carries either way as `bounds.maxBytes`, and MUST refuse a larger frame
  as `too-large`.
  *Rationale:* how a payload travels is the bridge's business; the engine sees only
  one number, and a refusal it can classify.

### 12.4 Receiving

- **BRG-10** · *bridge* — A bridge MUST route by the envelope's documentId, and MUST
  take a message for a document only from the channel that document is bound to.
  It MUST ignore silently — without an error and without an integrity record — a
  message that is not a TDSP envelope, an envelope of an unknown kind, an
  unparseable body, an envelope for a documentId it has no binding for, and one
  that arrives in another channel than the one its documentId is bound to; an
  edit, replacement or deletion that arrives in another channel is not attributed
  to the document either (BRG-12).
  *Rationale:* a channel is shared with human conversation and possibly with other
  documents; none of those is an anomaly. Who is in a document's channel decides
  who can write into it: receivers do not reject an edit for its sender's
  permission (CTL-7), and the messenger is trusted for channel membership
  (§15.2). A bridge's account is usually in other channels too, with other
  people; taking a frame from one of them — for a documentId its sender learned
  while a member of the document's channel, say — would let someone outside that
  channel write into the document, and a deletion from there would fill its
  integrity log with records nobody in the channel caused. The email binding's
  channel is a fixed participant set, checked for every message (EML-2).
- **BRG-11** · *bridge* — A bridge MUST make every delivery received for a document
  available, cumulatively and unfiltered (TRN-7); it MAY additionally
  de-duplicate messages its messenger presents twice.
  *Rationale:* filtering is where messages get lost; de-duplication is the engine's
  job (TRN-8).
- **BRG-12** · *bridge* — A delivered message is immutable. When the messenger
  presents an edit, replacement, redaction or remote deletion of a message — or a
  second message under an identity that must be unique — the bridge MUST NOT hand
  the new content up, MUST NOT treat it as a new message, and MUST record it as an
  integrity violation for the document where it can attribute it.
  *Rationale:* an applied CRDT update cannot be retracted; honouring a change would
  leave participants holding different versions of the same message with nothing
  marking the difference. Every supported messenger allows such edits.
- **BRG-13** · *bridge* — A bridge MUST bound the size of everything it reads before
  it can be verified — envelope bodies, attachment references, invitation blocks,
  header values, participant lists, message bodies handed to a decryption tool —
  and MUST reject what exceeds the bound. The bound MUST limit what is *read*,
  not only what is kept: a size the messenger reports is not enough, since the
  sender may control it (email: a partial fetch of at most the bound plus one
  byte, a larger mail rejected unparsed).
  *Rationale:* those inputs are chosen by whoever can post into the channel,
  including a hostile member.
- **BRG-14** · *bridge* — An attachment MUST be fetched only from the bridge's own
  configured messenger endpoint, MUST be read no further than its declared bound,
  and MUST have its size and hash checked before anything else is done with it
  (in particular before decryption). A final failure MUST drop the frame; a
  transient one MAY be retried a bounded number of times.
  *Rationale:* an attachment reference is attacker-chosen data telling the bridge
  what to fetch; following it anywhere else would break BRG-4, and an unbounded
  read or an unchecked file is a resource and integrity attack.
- **BRG-15** · *bridge* — A bridge MUST make the integrity violations it recorded
  available to the application, per document.
  *Rationale:* a refused message that nobody can see is indistinguishable from one
  that never came; the application must be able to show it.
- **BRG-16** · *bridge* — A bridge MUST send every message — a frame and an
  invitation alike — as its own messenger account, and nothing else. A request
  that names a sender (`send`'s `sender`, an invitation's `actor`) other than that
  account MUST be refused as `rejected`, never sent and never silently corrected.
  *Rationale:* the sender a receiver sees is the messenger's authentication of the
  bridge's account, not anything the request says. A bridge that built a message's
  `From` out of the request would let a caller write in someone else's name; one
  that ignored the field would hide a caller that believes it is someone else.

- **BRG-17** · *bridge* — A bridge MUST bound what it keeps of each document's
  deliveries — by count and by size, dropping the oldest first. It needs no
  acknowledgement from the engine to drop one. It SHOULD NOT offer again, while
  it runs, a delivery it has dropped when the messenger shows it again (email: a
  later read of the thread); after a restart it MAY offer again deliveries it
  had dropped before, since it is not required to persist what it has seen.
  *Rationale:* without a bound, a long-lived document makes every `receive`
  answer, and the bridge's memory, grow without end. An engine polls far more
  often than a sensible window fills, and one that falls behind anyway loses
  messages it recovers by resync where loss detection notices them (LOS-8, with the
  limits of [§10](../SPECIFICATION.md#10-loss-detection)) — so the simpler rule is to let loss
  detection do its job rather than add an acknowledgement protocol. Forbidding
  re-offering altogether would be a promise no bridge that keeps its state in
  memory can keep across a restart, and an engine that treats every frame
  idempotently (TRN-8) does not need it. What a bridge remembers to
  avoid re-offering within a run is its own affair: the reference email bridge
  keeps one digest per message of the thread, which grows with the thread as the
  mailbox itself does.

### 12.5 What a bridge does not do

A bridge implements no membership, closing, deletion or resync of its own:
those are frames, and a bridge that acted on them would be a second place where
application policy is enforced — one that must be kept in step with the engine
forever.

## 13. Messenger bindings

A binding says how a frame travels on one messenger: the envelope, the carrier,
the delivery id, the sender, how the account is provisioned, and what the bridge
must refuse. Two implementations of the same binding interoperate; two bindings
never do.

- **BND-1** · *bridge* — A binding MUST state how it meets each requirement of
  [§15.1](../SPECIFICATION.md#151-what-a-messenger-must-provide) — sender authentication, integrity,
  confidentiality — and whether it inherits each from the messenger or adds it
  itself, and MUST say plainly where it meets one not at all.
  *Rationale:* this is where "TDSP inherits its security" becomes checkable per
  messenger; email shows why it must be explicit, since without PGP it meets none
  of them.

### 13.1 The common envelope

```json
{ "tdsp": 1, "kind": "frame", "documentId": "…", "frame": "{\"tdsp\":1,\"kind\":\"edit\",…}" }
```

`tdsp` is the envelope version, 1 in this specification. `kind` is always
`"frame"`: every frame kind rides in this one envelope kind, because the bridge
must not distinguish them (ARC-3). `frame` is the frame's JSON text as a JSON
string — escaped, never parsed, never Base64-encoded — so it arrives exactly as it
was sent (TRN-3). A binding MAY replace `frame` by an `attachment` reference to a
file holding the frame's UTF-8 text; exactly one of the two is present.

- **BND-2** · *bridge* — A bridge MUST write `tdsp` 1. A **recognisable envelope of
  another version** — `tdsp` a number other than 1 and `documentId` a string — for a
  document the bridge has bound MUST NOT be delivered and MUST be reported locally
  (VER-1), in the bridge's log at least. Everything else that is not a valid
  envelope — nested deeper than [§1.6](../SPECIFICATION.md#16-notation) allows, `tdsp` missing or not
  a number, `kind` not `"frame"` (where the binding has a `kind`), `documentId` or
  `frame` not a string, both or neither of
  `frame` and `attachment`, or another version for a document the bridge has not
  bound — it MUST ignore silently (BRG-10).
  *Rationale:* the envelope has one reading. A version mismatch in a document the
  participant takes part in is exactly what VER-1 wants seen — a participant runs
  a newer bridge — while ordinary chat and other people's documents in a shared
  channel must not flood anyone with warnings. What a later version's envelope
  looks like beyond these two fields cannot be known today, so only they decide.
- **BND-3** · *bridge* — A SHA-256 in a field TDSP defines (an attachment
  reference's `sha256`) MUST be written as 64 lowercase hexadecimal digits, and a
  receiving bridge MUST refuse any other spelling. A structure a messenger defines
  itself (Matrix's `EncryptedFile`) keeps that messenger's own encoding.
  *Rationale:* one spelling across bindings means one parser and one comparison;
  accepting several invites the case where two spellings of the same hash are
  compared as different, or two different ones as the same.

## Appendix C. The bindings compared

*Informative.* How the three bindings of this version differ in what the messenger
provides.

| | Signal | Matrix | Email + PGP |
|---|---|---|---|
| Sender authentication | Strong (Sender Keys) | As far as the homeserver, or Megolm, is trusted | Pinned PGP key; none without PGP |
| Membership enforcement | Application level | Application level | Closed set, fixed at creation |
| History | None | Yes | Mailbox |
| Size | ≈ 2 000 characters of body; 800 B inline, attachments to 4 MiB | 65 536 B per event; 32 000 B inline, media to 4 MiB | ≈ 10 MiB per mail, commonly; the bridge states 4 MiB per frame |
| Rate limit | Not exercised | Homeserver-dependent | ≈ 1 message per 34 s measured on one provider |
| End-to-end encryption | Always | Per room | Only with PGP |
| MemberId | The account's ACI | The Matrix user id | The address |
| Bridge | Node + `signal-cli` | Node, Client-Server API | Node + SMTP/IMAP + `gpg` |
