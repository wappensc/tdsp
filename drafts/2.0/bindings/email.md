# TDSP bindings — Email

**Specification · TDSP bindings 2.0 (draft) · 18 October 2026**

Part of TDSP 2.0, whose core is [SPECIFICATION.md](../SPECIFICATION.md). This
document holds what TDSP 1.4 had in §13.4 of its specification, unchanged in
substance: its requirements keep their IDs, and its sections their numbers, so a
reference to either stays unambiguous. The requirement language and the
conformance classes are the core's ([§1.3](../SPECIFICATION.md#13-requirement-language),
[§1.4](../SPECIFICATION.md#14-conformance-classes)).

### 13.4 Email

Email has no channel to bind to, no server-side membership and, without PGP, no
sender authentication. The binding therefore fixes the participants when the
thread starts and checks every message against them.

| Aspect | Binding |
|---|---|
| Account | An SMTP and an IMAP account at one provider, over TLS (EML-7); for PGP, the person's own secret key in their `gpg` keyring, and a keyring of each document's own for the participants' keys (EML-4) |
| Security (BND-1) | Without PGP: none — `From` is as forgeable as any header, and a document is as confidential as plain email. With PGP: sender authentication, integrity and confidentiality added by the binding (EML-3) |
| Channel | A thread: a closed set of participants fixed when the thread starts, rooted at the invitation's `Message-ID` |
| Carrier | One email per frame. `Subject: tdsp document <documentId>`; header `x-tdsp-document: <documentId>`; `In-Reply-To` and `References` name the thread root; `To`/`Cc` name every participant but the sender |
| Body, PGP off | The envelope JSON as plain text |
| Body, PGP on | The same JSON, signed and encrypted to every participant, the sender included, as one inline ASCII-armoured OpenPGP message |
| Own devices | A copy of every frame mail in the sender's own sent folder, which every device of the address searches (EML-12) |
| MemberId, sender | The email address in its canonical form (EML-10); the `From` address, canonicalised |
| Delivery id | The `Message-ID` |
| Message-ID | `<local@domain>`, at most 200 characters, local part and domain from `[A-Za-z0-9._~+-]` and `[A-Za-z0-9.-]` |
| Invitation | The thread's first message: human-readable text with the invitation link; with PGP, followed by exactly one armoured block, signed by the creator and encrypted to each participant, whose plaintext is `{"tdsp":1, "kind":"invite", documentId, creator, profile, participants: [{address, fingerprint}], keys, policy?}` — `policy` is TDSP 1.x's, which an application of TDSP 2.0 neither writes nor reads |
| Immutability | A second message under an already-seen `Message-ID` with different content is an integrity violation; one with identical content is a harmless re-read |

- **EML-1** · *bridge* — The participant set MUST be fixed when the thread starts
  and MUST NOT change for the life of the document, in either direction.
  *Rationale:* nothing outside TDSP enforces who is on an email thread; a
  participant who could be removed could be silently cut off from seeing what
  happens next, and one who could be added is an intrusion path.
- **EML-2** · *bridge* — A receiving bridge MUST reject a message whose sender plus
  `To` and `Cc` recipients are not exactly the participant set, before and
  independently of any PGP check.
  *Rationale:* a signature covers the body, not the headers; a validly signed
  message could otherwise quietly exclude a participant from that one message.
- **EML-3** · *bridge* — For a PGP document, a receiving bridge MUST reject — never
  apply with a flag — any message that is not encrypted, that is not signed, whose
  signature does not verify, or whose signing key is not the key the creator's
  invitation pinned for the sender's address; and a sending bridge MUST refuse to
  send while it lacks its own secret key or any participant's pinned key.
  *Rationale:* a per-message "unverified" flag would make every paragraph's
  trustworthiness different and nobody could act on it; a document is either
  verified throughout or not.
- **EML-4** · *bridge* — For a PGP document, the participants' keys MUST come from the
  creator's signed invitation, be kept in a keyring of that document's own, and
  not be taken from the user's general keyring.
  *Rationale:* each participant resolving "who is Bob" from their own keyring gives
  N different answers and a trust-on-first-use window for every participant at
  every joiner; one signed statement by the creator gives one answer. It narrows
  trust on first use to a single key — the creator's — but does not remove it:
  EML-8 says how that one key is checked.
- **EML-5** · *bridge* — A bridge MUST check the invitation's plaintext against
  strict bounds (participant count, key-block length, address and fingerprint
  shape) before its signature can be verified, MUST refuse more than one armoured
  block, and MUST check that every field of the join request equals the verified
  invitation.
  *Rationale:* the keys that verify the invitation are inside it, so it is read
  before it can be trusted (BRG-13); a link that disagrees with the signed block
  is a forged or stale link.
- **EML-6** · *bridge* — A bridge MUST validate a `Message-ID` it receives from a
  request or an invitation against the pattern above before storing or sending it.
  *Rationale:* the value comes from a link anyone can craft and is later written
  into every outgoing message's headers.
- **EML-7** · *bridge* — A bridge MUST require TLS to a mail provider, and SHOULD
  look for a document's messages in the account's junk folder as well as the
  inbox.
  *Rationale:* without PGP, TLS is the only protection on the wire; providers file
  machine-generated mail as spam, which the first real-provider runs showed.
- **EML-8** · *bridge, application* — A joining bridge MUST compare the key the
  invitation names for the creator with any key the user's own keyring holds for
  the creator's address, and MUST refuse the join (`invite-creator-key-differs`)
  when they differ. It MUST then tell apart three trust states of the creator's
  key, and MUST NOT present one as another:

  | State | When | What it shows |
  |---|---|---|
  | *first contact* (trust on first use) | the user's keyring holds no key for the creator's address | messages are authenticated as coming from the key the invitation named, and nothing says that key is the creator's |
  | *consistent* | the user's keyring holds the same key | the invitation agrees with what the user held before; the key is as trustworthy as the way it reached that keyring, which the bridge does not check |
  | *verified* | the person has compared the fingerprint with the creator outside the application | the creator's identity — the only state that shows it |

  An application MUST show the fingerprint in every state, and MUST NOT call the
  creator *verified* or *authenticated as a person* in the first two. A binding
  or application that does not record a person's comparison — the reference
  implementation does not — never reaches *verified* and MUST say so rather than
  imply it.
  *Rationale:* the invitation carries the very keys that verify its own
  signature. Anyone who can send mail in the creator's name can build an
  invitation with a key of their own that passes every check inside it. Only
  something the joiner knew before — a key in their own keyring, a fingerprint
  compared in person — tells the real creator from such a forger. A difference is
  refused rather than warned: the joiner cannot tell which side is wrong, and
  joining would pin the whole document to keys the joiner's own records
  contradict. Without such a key, the first contact is trust on first use, and
  saying so is the only honest statement. A matching key is not a verification
  either: a keyring holds keys however they got there. "PGP-authenticated sender
  under a pinned key" and "this person's verified identity" are different claims,
  and must stay apart.

- **EML-9** · *bridge, application* — Email without PGP does not meet
  [§15.1](../SPECIFICATION.md#151-what-a-messenger-must-provide): it has no sender authentication.
  It is not a conformant TDSP binding. An implementation MAY offer it only as an
  experimental mode, MUST label it as experimental and unauthenticated wherever
  a document is created or opened, and MUST NOT claim conformance to this
  specification for it.
  *Rationale:* every authority check compares a message's sender with the
  creator (CTL-5), and without PGP anyone can write `From: creator`. A warning
  cannot supply what the binding lacks; saying plainly that the mode is outside
  the specification can.

- **EML-10** · *bridge* — A bridge MUST hand the engine every email MemberId — its
  own (`whoami`), a delivery's sender, and each participant it is given — in one
  canonical form: the bare address (`local@domain`, no display name, angle
  brackets or comment) without surrounding space, all in lower case. It MUST
  refuse a participant that is not a bare address rather than repair it, MUST
  refuse a participant list in which two addresses have the same canonical form,
  and MUST compare addresses only in that form. It MUST NOT resolve aliases: a
  subaddress such as `alice+docs@example.org` is a MemberId of its own.
  **Scope:** this binding is defined only for mail providers that do not tell the
  letter case of a local part apart. With a provider that does, it is not
  conformant: two participants who differ only in case are refused, and mail
  addressed in lower case may not reach a mailbox registered in capitals.
  *Rationale:* the engine compares MemberIds byte for byte (CTL-5); a provider
  that writes `From: Alice@Example.org` for a creator configured as
  `alice@example.org` would otherwise make the creator a stranger in their own
  document. RFC 5321 lets the local part of an address be case-sensitive, and a
  mail server may treat two such addresses as two mailboxes. Keeping the local
  part as written would be correct there, but would split one person in two
  wherever a provider or a mail client changes the case, which is the common
  case; the binding chooses the common case and says so, rather than claiming a
  generality it does not have. Two participants who differ only in case are
  refused rather than merged, so the rule never silently joins two people. A
  display name is refused because the sender is always compared as the bare
  address a mail parser reads from `From:`; accepting `Alice <alice@example.org>`
  as a participant made every message of that participant a mismatch in the
  reference bridge. The vectors in
  `bridges/email-bridge/test-vectors/member-ids-v1.json` fix every case above (§3.6).

- **EML-11** · *bridge* — A bridge MUST report a send as successful only when the
  mail server accepted the message for every recipient. A message accepted for
  some and refused for others MUST be reported as failed and name the refused
  addresses: as `rate-limited` when every refusal was temporary (an SMTP 4xx
  reply), otherwise as `rejected`. An invitation refused for any participant MUST
  fail without binding the document.
  *Rationale:* common mail libraries count a message as sent once one recipient
  accepted it; reporting that as success is a silent loss for the others (TRN-6).
  A retry sends the whole message again, so a participant who already has it gets
  a second copy under a new Message-ID, which changes nothing (TRN-8) — acceptable
  for a temporary refusal, but not without end for a permanent one, which is why
  that one is final and the change marked undistributed (SND-8). A participant
  who accepted a failed invitation holds one for a document that was never bound;
  joining it gets no answer from the creator, which is safe, and the creator
  sees the failure.
- **EML-12** · *bridge* — A bridge MUST make sure that a copy of every frame mail
  it sends is in its account's sent folder, the mailbox with the IMAP SPECIAL-USE
  attribute `\Sent` (RFC 6154): it relies on its provider where the provider
  files mail sent through it there itself, and appends the copy otherwise,
  creating the folder if the account has none. A receiving bridge MUST search
  that folder too. The mail itself is unchanged: `To`/`Cc` still name every
  participant but the sender.
  *Rationale:* every device of one address reads the same mailbox, but a mail
  never comes into the mailbox it was sent from. The sent folder is where mail
  programs already keep what they send; naming the sender as a recipient instead
  would change what every other participant receives. With PGP the mail is
  encrypted to every participant, the sender included, so another device of the
  sender can open the copy.

The email binding without PGP is the weakest on every axis: `From` is as
forgeable as any header, and a document is as confidential as plain email.
