# TDSP bindings — Matrix

**Specification · TDSP bindings 2.0 (draft) · 18 October 2026**

Part of TDSP 2.0, whose core is [SPECIFICATION.md](../SPECIFICATION.md). This
document holds what TDSP 1.4 had in §13.3 of its specification, unchanged in
substance but for the changes [Appendix G](../SPECIFICATION.md#appendix-g-changes-from-tdsp-1x)
of the core lists: its requirements keep their IDs, and its sections their numbers, so a
reference to either stays unambiguous. The requirement language and the
conformance classes are the core's ([§1.3](../SPECIFICATION.md#13-requirement-language),
[§1.4](../SPECIFICATION.md#14-conformance-classes)).

### 13.3 Matrix

| Aspect | Binding |
|---|---|
| Account | A login yielding an access token and a device, and a persistent crypto store for that device's Megolm and Olm keys |
| Security (BND-1) | In an encrypted room, inherited from Megolm and cross-signing: the sender is the account whose identity signed the sending device, and the homeserver can neither read a frame nor write one in a member's name (MTX-4, MTX-5). In a plain room, everything rests on the homeserver: it names the sender, and it can read, change and write any frame |
| Channel | An existing Matrix room; channel id = the room id |
| Carrier | One room event of type `de.wappensc.together.tdsp.frame`; in an encrypted room, Megolm-encrypted as `m.room.encrypted` |
| Envelope | `{"tdsp": 1, "documentId": …, "frame": …}` — no `kind`: the event type carries it |
| MemberId, sender | The Matrix user id; the event's `sender` (in an encrypted room, the owner of the signed device that sent it, MTX-4) |
| Delivery id | The event id |
| Inline limit | A frame rides in the event as `frame` when the envelope written around it, escapes included, is at most 32 000 bytes (MTX-7) |
| Attachment, plain room | A larger frame, up to 4 MiB, is uploaded as a media file; `"attachment": {"url": "mxc://…", "size": …, "sha256": "<64 hex digits>"}` |
| Attachment, encrypted room | The file is first encrypted as a Matrix `EncryptedFile` v2 (AES-256-CTR, JWK key, SHA-256 of the ciphertext in Matrix's unpadded Base64); `"attachment": {"size": …, "file": {url, key, iv, hashes, v: "v2"}}` travels inside the Megolm-encrypted event |
| Immutability | A TDSP event carrying `m.relates_to` with `rel_type` `m.replace`, and a redaction of a TDSP event, are integrity violations |
| Rate limit | `M_LIMIT_EXCEEDED` (HTTP 429), the wait in the `Retry-After` header (MTX-6) |
| Transport profile | Bounds: floor 250 ms, 4 MiB; suggested pacing 1 s / 15 s / 5 s; all estimates ([Appendix B](../SPECIFICATION.md#appendix-b-recommended-values)). The floor is below a homeserver's sustained rate, which comes after a burst and which a floor cannot express ([§3.5](../SPECIFICATION.md#35-transport-profile)); refusals beyond it carry the homeserver's wait (MTX-6) |
| Frames carried | TDSP 2.0's, and 1.x's, unchanged ([§2.2](../SPECIFICATION.md#22-two-envelopes-two-readers)) |

- **MTX-1** · *bridge* — A bridge MUST use the event type
  `de.wappensc.together.tdsp.frame` for every frame.
  *Rationale:* the event type is the envelope's kind on Matrix; two
  implementations that disagree about it never see each other's messages. The
  prefix is the project's reverse-DNS namespace, not part of the protocol's name.
- **MTX-2** · *bridge* — A bridge MUST resolve an `mxc://` reference only as a server
  name and media id on its own homeserver's media endpoint, accepting only a
  syntactically valid server name, and MUST NOT follow it as a URL.
  *Rationale:* BRG-14; a reference such as `mxc://../x` must never become a
  different path on any server.
- **MTX-3** · *bridge* — In an encrypted room a bridge MUST encrypt an attachment
  before uploading it and MUST send the key only inside the encrypted event.
  *Rationale:* the homeserver stores the file; it must hold ciphertext only.
- **MTX-4** · *bridge* — In an encrypted room a bridge MUST share each room key
  with every device that its owner's identity signed (cross-signing), of every
  member, its own account's other devices included, and with no other device. Its
  own device MUST be signed by its account's identity before it sends into an
  encrypted room. It MUST deliver a frame only from a device so signed, or one that
  arrived through a Megolm session the bridge received before it collected trust
  information about senders (matrix-sdk-crypto's `TrustRequirement::CrossSignedOrLegacy`),
  and MUST deliver a frame its own account sent from another signed device like
  any other.
  *Rationale:* a homeserver can add a device to any account. A key shared with
  every device would hand it the room's content, and a frame accepted from any
  device would let it write as any member — what an encrypted room exists to
  prevent ([§15.1](../SPECIFICATION.md#151-what-a-messenger-must-provide), BND-1).
  A signature by the owner's identity is the one statement about a device the
  homeserver cannot make itself. Matrix clients exclude devices their owners did
  not sign (MSC4153), so a bridge whose own device is unsigned gets no room keys
  from them, and one that shares with unsigned devices hands keys to what they
  refuse. The exception for older sessions keeps readable what was received before
  the bridge could tell who sent it. A member may run several devices, each a
  bridge of its own, under one account; a key withheld from a signed one, or an
  event filtered by its sender, would leave one device of a person blind to what
  another wrote.
- **MTX-5** · *bridge* — In a room it has once seen encrypted, a bridge MUST ignore
  silently — without an error and without an integrity record — a TDSP event that
  arrives unencrypted, one carrying an `m.replace` relation included, and MUST go
  on treating the room as encrypted, whatever the room's state says later. It MUST
  persist that it saw a room encrypted with each binding to that room (BRG-6),
  also when it saw it so before the binding was made.
  *Rationale:* a homeserver can place an unencrypted event in any room, under any
  member's name, and can report a room's state as it likes; Matrix never turns a
  room's encryption off. Delivering such an event would let the homeserver write
  frames as any member, the one thing MTX-4 keeps it from; recording it would let
  the homeserver fill a document's integrity log. A bridge that forgot after a
  restart that it had seen a room encrypted would take the room's word again.
  Matrix does not encrypt a redaction, so this does not cover one: a homeserver
  can still forge the redaction of a delivered event, and the sender a
  `message-redacted` record names in an encrypted room is the homeserver's
  word.
- **MTX-6** · *bridge* — A bridge MUST take the wait of a refusal `M_LIMIT_EXCEEDED`
  (HTTP 429) from its `Retry-After` header, in seconds, and from `retry_after_ms` in
  the body only where the header is absent, and MUST pass it on as `retryAfterMs`
  (TRN-11).
  *Rationale:* since Matrix 1.10 a homeserver states the wait in the header, and the
  body's field is deprecated (MSC4041); a homeserver that sends the header alone
  would otherwise have its wait ignored, and the engine would try again before it
  is allowed to (SND-7).
- **MTX-7** · *bridge* — A bridge MUST carry a frame in the event only when the
  envelope it writes around it — the event content as it serialises it, escapes
  included — is at most 32 000 bytes of UTF-8, and as an attachment otherwise. A
  receiving bridge MUST accept either form whatever the frame's size.
  *Rationale:* a homeserver refuses an event over 65 536 bytes as a whole, as
  too large. The envelope carries the frame as a JSON string, in which every quote
  and backslash doubles, and in an encrypted room Megolm's Base64 adds a third: a
  frame of 32 000 bytes measured alone could then exceed the event limit, and a
  frame within `bounds.maxBytes` would be refused as `too-large` (SND-8, SND-22).
  Measured as written, 32 000 bytes stay below the limit in either kind of room.
  Which form a sender chose is its own affair, so two bridges that serialise
  differently still understand each other.
