# TDSP bindings — Signal

**Specification · TDSP bindings 2.0 (draft) · 24 October 2026**

Part of TDSP 2.0, whose core is [SPECIFICATION.md](../SPECIFICATION.md). This
document holds what TDSP 1.4 had in §13.2 of its specification, unchanged in
substance but for the changes [Appendix G](../SPECIFICATION.md#appendix-g-changes-from-tdsp-1x)
of the core lists: its requirements keep their IDs, and its sections their numbers, so a
reference to either stays unambiguous. The requirement language and the
conformance classes are the core's ([§1.3](../SPECIFICATION.md#13-requirement-language),
[§1.4](../SPECIFICATION.md#14-conformance-classes)).

### 13.2 Signal

| Aspect | Binding |
|---|---|
| Account | A linked device of an existing Signal account (`signal-cli link`; the person scans a QR code on the phone). The bridge holds the device's keys |
| Security (BND-1) | Sender authentication, integrity and confidentiality, inherited from Signal's protocol and always on, also against Signal's servers, which can still delay or withhold a message. The binding adds none of them, and TDSP has not verified them: they are what Signal states of its protocol. A member's first identity key is trusted on first use — `signal-cli`'s default (`--trust-new-identities on-first-use`), and the bridge of this repository sets no other mode — so against Signal's servers a member is authenticated only as far as safety numbers are compared outside TDSP; a changed key is not trusted until the person trusts it (SIG-4) |
| Channel | An existing Signal group; channel id = the group id |
| Carrier | One group text message whose body is the envelope JSON |
| MemberId | The account's ACI (UUID). Never the phone number |
| Sender | The message's `sourceUuid` as `signal-cli` reports it |
| Delivery id | `<sender ACI>:<message timestamp>` |
| Own devices | What one device of an account sends reaches the account's other devices as a sync transcript, delivered like any other message (SIG-3) |
| Inline limit | A frame of at most 800 bytes rides in the body as `frame` |
| Attachment | A larger frame, up to 4 MiB, is the message's only attachment; the envelope carries `"attachment": {"size": <bytes>, "sha256": "<64 hex digits>"}` in place of `frame`. `signal-cli` downloads every attachment of a message it receives itself, up to its own limit (150 MiB in 0.14.9), before the bridge sees the message: BRG-13 and BRG-14 bound what the bridge reads from `signal-cli`, not that download |
| Accepted (TRN-6) | The client sends to every member itself and answers per recipient; a recipient skipped as an identity to trust is recorded as a notice in the integrity log (SIG-4) |
| Refusals (BRG-8) | A send `signal-cli` refuses because it cannot load the account is `unavailable` while the bridge's link status shows its device linked, and `needs-person` once it shows it unlinked (SIG-7) |
| Transport profile | Bounds: floor 500 ms, 4 MiB; suggested pacing 2 s / 20 s / 10 s; all estimates ([Appendix B](../SPECIFICATION.md#appendix-b-recommended-values)) |
| Frames carried | TDSP 2.0's, and 1.x's, unchanged ([§2.2](../SPECIFICATION.md#22-two-wrappers-two-readers)) |
| Immutability | An `editMessage` or a remote delete targeting a delivered message is an integrity violation, inside a sync transcript too |

- **SIG-1** · *bridge* — A receiving bridge MUST accept an attachment envelope only
  if the message carries exactly one attachment whose size equals the envelope's
  `size`, MUST check the file's size and SHA-256 against the envelope before
  delivering it, and MUST delete its plaintext copy of the file afterwards.
  *Rationale:* `signal-cli` writes every received attachment to disk in plaintext;
  a frame's copy must not outlive its delivery.
- **SIG-2** · *bridge* — A bridge MUST take the sender from the message's ACI and
  MUST ignore a message that has none.
  *Rationale:* the ACI is the identity `/whoami` reports and the creator is
  compared against; a message attributed to a phone number instead would never
  match, or worse, match a different spelling of the same person.
- **SIG-3** · *bridge* — A bridge MUST deliver a group message its own account
  sent from another device like a message from any other member: Signal hands it
  to the account's other devices as a sync transcript (`signal-cli`:
  `syncMessage.sentMessage`), its sender is the account's ACI, and its delivery
  id is `<ACI>:<timestamp of the sent message>`, the id the sending device got.
  An edit or a remote delete inside a transcript is an integrity violation, as
  in a message. A bridge MUST ignore a transcript whose sender is not its own
  account.
  *Rationale:* a member may run several devices under one account, each a bridge
  of its own, and Signal gives a device's message to the account's other devices
  only as this transcript. The delivery id names no device: Signal identifies a
  message by its author and sent timestamp, and an edit or delete targets it that
  way, so the transcript yields the id the sender recorded and an echo is
  recognised (TRN-8). Two devices of one account sending in the same millisecond
  would share an id: the second message, with other content, is then recorded as
  `message-replaced` and not delivered (BRG-12), and the same message presented
  again is dropped (BRG-11). That has been neither observed nor tested, and loss
  detection notices the lost one in the cases [§10](../SPECIFICATION.md#10-loss-detection) names. Signal sends transcripts only to an account's
  own devices, so one from another sender is not one.
- **SIG-4** · *bridge* — A bridge MUST read `signal-cli`'s result for each recipient
  of a group message, and MUST resolve `send` (TRN-6) only when no recipient was
  refused for a reason that may pass:
  - a recipient Signal rate-limited makes the send fail as `rate-limited`, with
    the longest wait a result names;
  - one Signal could not reach makes it fail as `unavailable`.

  A recipient refused for a reason no retry of the message changes — not
  registered, or an identity the account does not trust — does not make the send
  fail while another recipient got it. The bridge MUST make every recipient a send
  skipped as an identity the account does not trust observable to its
  application: in the document's integrity log, as a notice (BRG-15) whose `id` is
  the message's delivery id, `recipient` the recipient's ACI and `reason`
  `recipient-untrusted`. It MAY record a recipient so
  once for as long as its identity stays untrusted, rather than once per message.

  When nobody got it, and no recipient was refused for a reason that may pass, the
  send fails as `rejected` when every recipient is unregistered; as `needs-person`
  when every recipient is unregistered or an identity the account does not trust,
  and one at least is the latter; and as `unavailable` otherwise. An invitation
  (`sendInvitation`) MAY count as sent once one member got it.
  *Rationale:* Signal has no server that fans a group message out: the client
  encrypts and sends it to every member's devices itself, and `signal-cli` reports
  the message as sent once one member got it. Taking that as accepted makes every
  member it missed a silent loss (TRN-6); retrying reaches those it missed for now,
  and costs the others a duplicate that changes nothing (TRN-8). A member missed
  for good would make every retry fail too and stop the document for everyone, as
  a closed email thread is stopped (EML-11); a Signal group is not closed — an
  account that is gone stays in it until someone removes it — so the message counts
  as accepted for the others, and the member who missed it asks for what it lacks
  once it receives again ([§10](../SPECIFICATION.md#10-loss-detection)). Trusting a changed
  identity is the person's (TRN-11), and so the person has to learn of it: while
  every send succeeds, that member receives nothing, and nothing else shows it. The
  send's answer reaches the engine, which tells its application only of what
  failed (SND-10); the integrity log is what a bridge already hands the
  application per document. An invitation is read by people, and sent again it
  would show twice.
- **SIG-5** · *bridge* — A bridge to which `signal-cli` pushes received messages on
  its own (`--receive-mode on-connection`) MUST be reading a connection as soon as
  it opens — whether the bridge opens it to listen or a call opens it — and MUST
  keep what arrives before anything consumes it, bounded in size and in count
  (BRG-13).
  *Rationale:* in that mode `signal-cli` hands everything waiting on Signal's
  servers to a connection the moment it opens, and Signal gives each message to a
  device once: one pushed into a connection nobody reads is gone for this device,
  with nothing to show the gap — no cursor reads truncated and no instance changes
  (TRN-18, TRN-19).
- **SIG-6** · *bridge* — A bridge that receives through a subscription
  (`--receive-mode manual`, `subscribeReceive`) MUST be reading the connection
  before it subscribes, as SIG-5 asks, and MUST subscribe again on every new
  connection. A bridge that ends the subscription (`unsubscribeReceive`) and keeps
  its instance (TRN-19) across it MUST read what `signal-cli` writes until
  `signal-cli` answers, and MUST NOT keep its instance so unless the `signal-cli`
  it runs still hands on the message it is handling when the last subscription
  ends: `signal-cli` 0.14.9 removes the subscription's handler before it stops
  receiving, and a message it has already acknowledged to the server goes to no
  one.
  *Rationale:* `signal-cli` keeps each message in its cache from before it
  acknowledges it to the server until after it has handed it on, and answers the
  end of a subscription only once it has stopped receiving; a bridge that reads up
  to that answer has everything — except what the client itself dropped. A
  subscription belongs to its connection, and the messages waiting on Signal's
  servers come the moment it begins.
- **SIG-7** · *bridge* — A send that `signal-cli` refuses because it cannot load
  the account MUST fail as `unavailable` while the bridge's link status shows its
  device linked, and as `needs-person` once that status shows the device unlinked
  (BRG-8). The link status is *linked* from when `signal-cli` names an account of
  the bridge's device — after a link the bridge completed, or one `signal-cli` kept
  across a restart — and *unlinked* while it names none, and from when the bridge
  learns from `signal-cli` that Signal's servers no longer accept the device (an
  authorization failure, as after the device was removed on the phone) until a
  link completes again. Without such word from `signal-cli` the status stays
  linked. A bridge that offers the
  [local bridge interface](local-bridge-interface.md) exposes the status as
  `linked` of `GET /auth/status`.
  *Rationale:* `signal-cli` refuses a send so whether the account's state could
  not be read for a moment or the device was unlinked from the phone, and only the
  second waits for the person, who links the device again. Taken for
  `needs-person` at once, a passing refusal would hold every message for the
  longest back-off (TRN-20); taken for `unavailable` for good, an unlinked device
  would be tried again without end. The link status is how the bridge tells the
  two apart.
