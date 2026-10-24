# TDSP bindings — Matrix

**Specification · TDSP bindings 1.4.1 · 24 October 2026**

Part of TDSP 1.4.1, whose core is [SPECIFICATION.md](../SPECIFICATION.md). This
document holds what TDSP 1.4 had in §13.3 of its specification, unchanged: its
requirements keep their IDs, and its sections their numbers, so a reference to either
stays unambiguous. The requirement language and the conformance classes are the core's
([§1.3](../SPECIFICATION.md#13-requirement-language),
[§1.4](../SPECIFICATION.md#14-conformance-classes)).

### 13.3 Matrix

| Aspect | Binding |
|---|---|
| Account | A login yielding an access token and a device, and a persistent crypto store for that device's Megolm and Olm keys |
| Security (BND-1) | Sender authentication inherited as far as the homeserver — or Megolm, in an encrypted room — is trusted; integrity and confidentiality only in an encrypted room |
| Channel | An existing Matrix room; channel id = the room id |
| Carrier | One room event of type `de.wappensc.together.tdsp.frame`; in an encrypted room, Megolm-encrypted as `m.room.encrypted` |
| Envelope | `{"tdsp": 1, "documentId": …, "frame": …}` — no `kind`: the event type carries it |
| MemberId, sender | The Matrix user id; the event's `sender` (the decrypted sender in an encrypted room) |
| Delivery id | The event id |
| Inline limit | A frame of at most 32 000 bytes rides in the event as `frame` |
| Attachment, plain room | A larger frame, up to 4 MiB, is uploaded as a media file; `"attachment": {"url": "mxc://…", "size": …, "sha256": "<64 hex digits>"}` |
| Attachment, encrypted room | The file is first encrypted as a Matrix `EncryptedFile` v2 (AES-256-CTR, JWK key, SHA-256 of the ciphertext in Matrix's unpadded Base64); `"attachment": {"size": …, "file": {url, key, iv, hashes, v: "v2"}}` travels inside the Megolm-encrypted event |
| Immutability | A TDSP event carrying `m.relates_to` with `rel_type` `m.replace`, and a redaction of a TDSP event, are integrity violations |

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
  with every device of every member, its own account's other devices included,
  and MUST deliver an event its own account sent from another device like any
  other.
  *Rationale:* a member may run several devices, each a bridge of its own, under
  one account; a key withheld from them, or an event filtered by its sender, would
  leave one device of a person blind to what another wrote.
