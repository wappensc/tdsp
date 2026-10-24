# TDSP bindings — Signal

**Specification · TDSP bindings 1.4.1 · 24 October 2026**

Part of TDSP 1.4.1, whose core is [SPECIFICATION.md](../SPECIFICATION.md). This
document holds what TDSP 1.4 had in §13.2 of its specification, unchanged: its
requirements keep their IDs, and its sections their numbers, so a reference to either
stays unambiguous. The requirement language and the conformance classes are the core's
([§1.3](../SPECIFICATION.md#13-requirement-language),
[§1.4](../SPECIFICATION.md#14-conformance-classes)).

### 13.2 Signal

| Aspect | Binding |
|---|---|
| Account | A linked device of an existing Signal account (`signal-cli link`; the person scans a QR code on the phone). The bridge holds the device's keys |
| Security (BND-1) | Sender authentication, integrity and confidentiality inherited from Signal, always on |
| Channel | An existing Signal group; channel id = the group id |
| Carrier | One group text message whose body is the envelope JSON |
| MemberId | The account's ACI (UUID). Never the phone number |
| Sender | The message's `sourceUuid` as `signal-cli` reports it |
| Delivery id | `<sender ACI>:<message timestamp>` |
| Own devices | What one device of an account sends reaches the account's other devices as a sync transcript, delivered like any other message (SIG-3) |
| Inline limit | A frame of at most 800 bytes rides in the body as `frame` |
| Attachment | A larger frame, up to 4 MiB, is the message's only attachment; the envelope carries `"attachment": {"size": <bytes>, "sha256": "<64 hex digits>"}` in place of `frame` |
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
  would share an id, and the second message would count as a duplicate; that has
  been neither observed nor tested, and loss detection notices it in the cases
  [§10](../SPECIFICATION.md#10-loss-detection) names. Signal sends transcripts only to an account's
  own devices, so one from another sender is not one.
