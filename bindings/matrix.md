# TDSP bindings — Matrix

**Specification · TDSP bindings 2.0 (draft) · 3 November 2026**

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
| Security (BND-1) | In an encrypted room, inherited from Megolm and cross-signing: the sender is the account whose identity signed the sending device, and the homeserver can neither read a frame nor write one in a member's name with a device it adds (MTX-4, MTX-5) — but for a redaction, which Matrix does not encrypt and the homeserver can forge (MTX-5). Which identity is the account's is the homeserver's word on first contact; after that a bridge that remembers it holds to that identity, and a changed one gets no room key and has none of its frames delivered until a person agrees (MTX-4). A bridge that does not remember takes a changed identity as a first contact. A homeserver that resets the identity of a member nobody has met yet, or one a person agrees to, reads and writes as that member. In a plain room, everything rests on the homeserver: it names the sender, and it can read, change and write any frame |
| Channel | An existing Matrix room; channel id = the room id |
| Carrier | One room event of type `de.wappensc.together.tdsp.frame`; in an encrypted room, Megolm-encrypted as `m.room.encrypted` |
| Envelope | `{"tdsp": 1, "documentId": …, "frame": …}` — no `kind`: the event type carries it |
| MemberId, sender | The Matrix user id; the event's `sender` (in an encrypted room, the account whose identity signed the device that sent it, as far as that identity is the account's, MTX-4) |
| Delivery id | The event id |
| Accepted (TRN-6) | The homeserver answered the send with the event's id; it delivers the event to the room's members itself |
| Inline limit | A frame rides in the event as `frame` when the envelope written around it, escapes included, is at most 32 000 bytes (MTX-7) |
| Attachment, plain room | A larger frame, up to 4 MiB, is uploaded as a media file; `"attachment": {"url": "mxc://…", "size": …, "sha256": "<64 hex digits>"}` (*Attachments* below) |
| Attachment, encrypted room | The file is first encrypted as a Matrix `EncryptedFile` v2 (Matrix Client-Server API v1.19; AES-256-CTR, JWK key, SHA-256 of the ciphertext in Matrix's unpadded Base64); `"attachment": {"size": …, "file": {url, key, iv, hashes, v: "v2"}}` travels inside the Megolm-encrypted event (*Attachments* below) |
| Immutability | A TDSP event carrying `m.relates_to` with `rel_type` `m.replace`, and a redaction of a TDSP event, are integrity violations; an event presented again under a delivered event id is compared, before anything is fetched, by its frame's bytes, or by its attachment's `sha256` — for an `EncryptedFile`, its `hashes.sha256` and also its `key` and `iv` (BRG-12) |
| Rate limit | `M_LIMIT_EXCEEDED` (HTTP 429), the wait in the `Retry-After` header (MTX-6) |
| Retention (LIF-8) | Unknown: as long as the homeserver keeps the room's events, which a retention policy of the homeserver or the room may limit; an application that knows it tells its engine |
| Transport profile | Bounds: floor 250 ms, 4 MiB; suggested pacing 1 s / 15 s / 5 s; all estimates ([Appendix B](../SPECIFICATION.md#appendix-b-recommended-values)). The floor is below a homeserver's sustained rate, which comes after a burst and which a floor cannot express ([§3.5](../SPECIFICATION.md#35-transport-profile)); refusals beyond it carry the homeserver's wait (MTX-6) |
| Frames carried | TDSP 2.0's, and 1.x's, unchanged ([§2.2](../SPECIFICATION.md#22-two-wrappers-two-readers)) |

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
  encrypted room. It MUST deliver a frame only from a device so signed — one whose
  signature by its owner's identity the bridge could check for the Megolm session
  that carries the frame —, and MUST deliver a frame its own account sent from
  another signed device like any other. It SHOULD remember the identity it first
  sees for each member (the public master key); a bridge that does MUST hold to the
  remembered identity both ways until a person agrees to a changed one on that
  device: it shares no room key with a device of the changed identity and delivers
  no frame from one. Per state of a sender's identity, as the bridge knows it:

  | Identity | Room keys | Frames delivered |
  |---|---|---|
  | Met for the first time | To its signed devices; the bridge takes the identity the homeserver presents, and remembers it where it remembers | From its signed devices |
  | Remembered, or agreed to, and unchanged | To its signed devices | From its signed devices |
  | Changed since, not yet agreed to (a bridge that remembers) | None, to none of its devices | None: passed over for good. Once a person agrees, every document bound to a room the member is in starts a new epoch of its window (TRN-19), and its engine asks for what it lacks (LOS-9) |
  | Any — from a device its owner's identity did not sign, or through a Megolm session whose sending device the bridge could not check | None | None |

  A bridge that does not remember identities takes a changed one as met for the
  first time.
  *Rationale:* a homeserver can add a device to any account. A key shared with
  every device would hand it the room's content, and a frame accepted from any
  device would let it write as any member — what an encrypted room exists to
  prevent ([§15.1](../SPECIFICATION.md#151-what-a-messenger-must-provide), BND-1).
  A signature by the owner's identity is the one statement about a device the
  homeserver cannot make itself — for an identity the bridge already knows: the
  homeserver manages an account's login and can reset its identity, so the identity
  of a member met for the first time is the homeserver's word, and so is a reset
  one. Checked only against an account's current identity, a device of a reset one
  passes; remembered, a reset shows, and a person decides. A withheld key limits
  reading only: a device of the new identity can start a Megolm session of its own
  and write under the member's id — as the creator, change rights or close the
  document (CTL-5) —, so remembering holds for frames as for keys. What came before
  the agreement is passed over rather than delivered later, so a bridge keeps no
  store of held events; the new epoch makes the engine ask. A member that lost every
  device and reset its identity rightly takes part again once a person agrees. A
  Megolm session received before the bridge could tell who sent it proves no signed
  device and counts as unsigned; a bridge that keeps its trust information from its
  first session on meets none of its members' sessions so. Matrix clients exclude
  devices their owners did not sign (MSC4153), so a bridge whose own device is
  unsigned gets no room keys from them, and one that shares with unsigned devices
  hands keys to what they refuse. A member may run several devices, each a
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

**Attachments.** An encrypted room's attachment is the `EncryptedFile` of the Matrix
Client-Server API v1.19, section *Sending encrypted attachments*
([spec.matrix.org/v1.19/client-server-api/#sending-encrypted-attachments](https://spec.matrix.org/v1.19/client-server-api/#sending-encrypted-attachments),
the structure at `#definition-encryptedfile`), whose text this binding does not repeat.
The fields TDSP uses: `url`, an `mxc://` URI (MTX-2); `key`, a JWK whose `kty` is `oct`,
`alg` `A256CTR` and `k` the 32-byte AES key in URL-safe unpadded Base64; `iv`, 16 bytes in
unpadded Base64, 8 random ones and then a block counter that starts at zero;
`hashes.sha256`, the SHA-256 of the ciphertext in unpadded Base64; and `v`, `"v2"`. A sender
writes every field Matrix requires, `key_ops` and `ext` included; a receiver reads an
encrypted file only where `v`, `kty` and `alg` are those values, `k` decodes to 32 bytes,
`iv` to 16 and `hashes.sha256` to 32, and an envelope with any other is none (BND-2). A
plain room's reference is `url`, `size` and `sha256`, the SHA-256 of the file in 64
lowercase hexadecimal digits (BND-3). In both, the file is the frame's UTF-8 text (BND-4),
encrypted with AES-256-CTR in an encrypted room, which keeps its length, and `size` is
that length in bytes, an integer from 0 to 4 MiB. A receiving bridge fetches the file
from its own homeserver only (MTX-2), reads no further than its bound, and checks before
it takes anything of the file (BRG-14) that its SHA-256 is the reference's — for an
encrypted file the ciphertext's, before decrypting — and that its length is `size`, before
or after decrypting, which keeps the length. It takes the result only as UTF-8. A file that
fails a check is dropped, and its frame is not delivered.

**Example events.** *Informative.* The `edit` frame of
[§4.5](../SPECIFICATION.md#45-example), with `2` where this draft writes its marker
(VER-3). In the event, as Megolm encrypts it in an encrypted room — the event type, its
content and the room id; a plain room's event carries the same type and content:

```json
{"type":"de.wappensc.together.tdsp.frame","content":{"tdsp":1,"documentId":"doc-a1b2c3","frame":"{\"tdsp\":2,\"kind\":\"edit\",\"documentId\":\"doc-a1b2c3\",\"update\":\"AQOJmvSYDwAHAQdjb250ZW50AwlwYXJhZ3JhcGgHAIma9JgPAAYEAIma9JgPAQJIaQA=\"}"},"room_id":"!room:example.org"}
```

The same frame of 130 bytes as an attachment, the form a receiver accepts whatever the
size (MTX-7), though a sender carries a frame this small in the event. In a plain room,
the file being the frame's text:

```json
{"type":"de.wappensc.together.tdsp.frame","content":{"tdsp":1,"documentId":"doc-a1b2c3","attachment":{"url":"mxc://example.org/tdspFrameFile1","size":130,"sha256":"da1de92a70d66dc33ccb06096a81d360736439b67d36a6b1692c8ceafb4df2b1"}}}
```

In an encrypted room, with the key `00 01 … 1f` and an IV of `f0 f1 … f7` and eight zero
bytes, where a sender draws both at random:

```json
{"type":"de.wappensc.together.tdsp.frame","content":{"tdsp":1,"documentId":"doc-a1b2c3","attachment":{"size":130,"file":{"url":"mxc://example.org/tdspFrameFile2","key":{"kty":"oct","key_ops":["encrypt","decrypt"],"alg":"A256CTR","k":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8","ext":true},"iv":"8PHy8/T19vcAAAAAAAAAAA","hashes":{"sha256":"Eq9F6MnJx+rQ2KeGe/wpD67xGFu1nrI6/rKQetCAzfg"},"v":"v2"}}},"room_id":"!room:example.org"}
```

The file uploaded is the ciphertext, in Base64:
`oC7O1iOh4MVc8TuwgYVKx0t686vW9P2gMkZUjcImHdc4bdkdKYZprWKz5IskkT8zY/8iDMuwVvgV/lMCjXDC+4rhVbdEYy12RrLB4SlOfJjwh1OOqkocDQl2g9qeUIEHmF29TIWiMznpWGQQL5bVzzq0u/pAZmooJNjUiuNMpMzJVw==`;
its SHA-256 is `hashes.sha256`, and AES-256-CTR under that key and IV gives the frame.
