# TDSP — Together Document Sync Protocol

> **Draft, not normative.** The working text of TDSP 2.0 ([README](README.md)). The
> specification in force is [SPECIFICATION.md](../../SPECIFICATION.md), TDSP 1.4.1.

**Specification · TDSP 2.0 (draft) · 18 October 2026**

## 1. Introduction

### 1.1 What TDSP is

TDSP synchronises a collaboratively edited document between a small group of
participants by carrying CRDT updates inside ordinary messages of a messenger
the participants already use — a Signal group, a Matrix room, an email thread.
There is no TDSP server, no WebSocket and no peer-to-peer connection: every
byte of document data travels as a message of that messenger, and every
participant's engine merges what arrives locally.

Two consequences shape everything below:

- **Confidentiality and sender authentication are inherited, not added.** A
  TDSP document is exactly as confidential as the channel it rides on, and a
  message's sender is exactly as authentic as the messenger makes it. TDSP adds
  no encryption of its own (the email binding's optional PGP is the one
  exception, [email binding](bindings/email.md)).
- **The transport is assumed to be poor.** Messages may be delayed by tens of
  seconds, duplicated, reordered, rate-limited, size-limited and lost, and a
  newly joined participant may see nothing that was sent before it joined.
  Every mechanism in this specification is built for that transport; a better
  one simply converges faster.

The name is deliberately about the *document*, not the carrier: the carrier is
replaceable ([§2.1](#21-layers)).

### 1.2 Status of this document

This is a draft of **TDSP 2.0**, the core of the protocol. It changes the wire of
TDSP 1.x incompatibly, in four places, and keeps every use case 1.x covers
([§1.7](#17-what-must-stay)):

- **Control state is a set of operations** ([§7](#7-control-state)), merged like
  the content, instead of a numbered log with one writer. Each device of the
  creator counts its own operations; the result depends on the set, not on the
  order. 1.x's gap-free sequence, its outbox, its conflicts under one number and
  the special cases of a creator device without control state go.
- **No shared sync policy** ([§9.1](#91-pacing)): the creator sets one number for
  everyone, the *pace*; everything else about pacing is each participant's own,
  and every frame that owes a follow-up says when it will come (`due`).
- **Extension fields** ([§4.4](#44-decoding-and-rejection)): a field whose name
  contains `.` is ignored when unknown, unless the frame lists it in `crit`, so a
  later addition needs no new major version.
- **Pieces instead of fragments** ([§9.4](#94-changes-larger-than-one-message)):
  the profile splits a large update into pieces that are updates themselves; the
  `fragment` kind and its reassembly go.

The transport contract gains an optional cursor and a bridge instance id
([§3.2](#32-operations)), without a wire change. The bridges and the messenger
bindings, and the optional local bridge interface, are documents of their own
([bindings/](bindings/)), versioned apart; their wire is unchanged. What changed
from 1.x, requirement by requirement, is
[Appendix G](#appendix-g-changes-from-tdsp-1x). A later version changes the wire
only as [§14](#14-versioning-and-extensibility) describes.

Until TDSP releases 2.0, frames and invitations of this draft carry a draft
marker instead of the version `2` (VER-3), so that no draft frame passes for
TDSP 2.0 and every 1.x engine refuses it.

TDSP adds no security layer of its own; its security properties are those of
the messenger it runs on, plus what [§15.3](#153-what-tdsp-enforces-itself)
enforces. No property below is stronger than the tests and the threat model
behind it.

This document is self-contained: every requirement states its reason. It
depends on no other document except the standards it cites (RFC 2119, RFC 8174,
RFC 3629, RFC 4648, RFC 5234, RFC 8259) and, for the one profile it defines, the Yjs
encodings named in [Appendix A](#appendix-a-profile-yjs-paragraphs1); a bridge
or adapter implementer also reads the binding of their messenger
([bindings/](bindings/)). A
reference implementation exists; [Appendix F](#appendix-f-reference-implementation)
names its parts. Where it deviates from this document, this document states the
intended behaviour. No second, independently written implementation has yet been
checked against the published test vectors ([§3.6](#36-conformance-suite)), so
interoperability is specified, not yet demonstrated.

### 1.3 Requirement language

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**,
**SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **NOT RECOMMENDED**, **MAY** and
**OPTIONAL** in this document are to be interpreted as described in BCP 14
(RFC 2119, RFC 8174) when, and only when, they appear in all capitals, as shown
here.

Every requirement has this form:

> **FRM-8** · *engine* — A receiver MUST … .
> *Rationale:* why the requirement exists.

- The **ID** is stable. A withdrawn requirement keeps its ID, marked
  *withdrawn*; an ID is never reused. The prefix names the section's topic. An
  ID this version carries over from TDSP 1.x keeps its meaning; what 2.0
  withdrew, replaced or added is listed in
  [Appendix G](#appendix-g-changes-from-tdsp-1x).
- The **class** names who must satisfy it ([§1.4](#14-conformance-classes)).
- The **rationale** is part of the specification. Two readings of a requirement
  that both satisfy its wording but only one satisfies its rationale are
  resolved in favour of the rationale.

Text without an ID is informative. Where a requirement governs a value that
matters only *locally* — a buffer size, a back-off constant, a waiting time —
the requirement states the behaviour ("MUST bound the buffer") and
[Appendix B](#appendix-b-recommended-values) gives the recommended value. An
implementation that chooses other values still conforms; one that omits the
behaviour does not.

### 1.4 Conformance classes

TDSP is implemented by four kinds of component, each a conformance class. From
the person using a document down to the messenger:

| Class | What it is |
|---|---|
| **application** | The program a person uses. It hosts engines, creates and joins documents, chooses a document's profile, persists what must survive a restart, and presents invitations, status and errors |
| **engine** | The protocol engine for one document at one participant: frames, control state, bootstrap and resync, send scheduling, splitting into pieces, loss detection ([§4](#4-the-payload-frame)–[§10](#10-loss-detection)) |
| **adapter** | Implements the transport contract ([§3](#3-the-transport-contract)) for one messenger, by talking to its bridge |
| **bridge** | Holds one messenger account's credentials, speaks the messenger's own protocol, and carries frames in the messenger binding's envelope ([bindings/](bindings/)) |

A product may implement several classes at once. It conforms to a class when
it satisfies every MUST and MUST NOT requirement of that class, including those
of the messenger binding it uses. The adapter and the bridge find their
messenger's requirements in its binding ([bindings/](bindings/)). The local bridge
interface ([bindings/local-bridge-interface.md](bindings/local-bridge-interface.md))
is an option: its requirements bind an adapter and a bridge that communicate
across a process boundary through it, and no one else.

### 1.5 Terminology

| Term | Meaning |
|---|---|
| **Document** | One collaboratively edited text, identified by a **documentId** and bound to exactly one channel |
| **Participant**, **member** | A person taking part in a document, identified by a **MemberId**: the messenger's own identity for them (a Signal account, a Matrix user id, an email address) |
| **Creator** | The one participant who created a document. Fixed at creation, never transferable; the document's single authority ([§2.3](#23-the-creator-is-the-single-authority)) |
| **Engine** | The component that runs the protocol for one document ([§1.4](#14-conformance-classes)) |
| **Messenger** | The system that carries messages between participants — a messaging service, or any other message system with the properties of [§15.1](#151-what-a-messenger-must-provide) |
| **Channel** | The messenger-level conversation a document rides on: a Signal group, a Matrix room, an email thread with a fixed participant set. Set up by people, not by TDSP |
| **Binding** | The association of a documentId with a channel, held by a bridge; also, a messenger binding: how frames travel on one messenger ([bindings/](bindings/)) |
| **Delivery** | One received message, as the transport contract presents it: an id, a documentId, a sender and a payload |
| **Frame** | The payload of one delivery: a JSON object ([§4](#4-the-payload-frame)) |
| **Envelope** | The messenger-level wrapper around a frame, read only by bridges ([bindings/bridges.md](bindings/bridges.md)) |
| **Profile** | What a document's content bytes mean: its CRDT, structure and text projection, named by an id such as `yjs-paragraphs/1` ([§5](#5-document-profiles)) |
| **Update** | An opaque CRDT update: the unit of document change |
| **Piece** | A part of an update its profile split off, itself an update ([§9.4](#94-changes-larger-than-one-message)) |
| **State vector** | A compact summary of which updates a CRDT replica has seen |
| **Control state** | A document's membership map, closed flag and pace, set only by the creator, as a set of control operations ([§7](#7-control-state)) |
| **Creator device** | One installation of the creator's application, named by a random **device tag**; a device that lost its state is a new device ([§7.2](#72-operations)) |
| **Control operation** | One decision of one creator device about one target, numbered by that device's own **counter** ([§7.2](#72-operations)) |
| **Control vector** | For each creator device, the highest counter held without a gap ([§7.4](#74-holes-and-the-control-vector)) |
| **Pace** | The shortest interval between two messages anyone sends for a document; set by the creator ([§9.1](#91-pacing)) |
| **Pacing** | The five numbers that govern when an engine sends; each participant's own ([§9.1](#91-pacing)) |
| **Transport profile** | A bridge's statement of its messenger's bounds and suggested pacing ([§3.5](#35-transport-profile)) |
| **Bootstrap** | A joining engine obtaining the current document and control state ([§8](#8-bootstrap-and-resync)) |
| **Resync** | A request for, and answer with, what an engine is missing ([§8](#8-bootstrap-and-resync)) |
| **Invitation** | The information a joiner needs to open a document, sent as a human-readable message ([§11](#11-invitations)) |

### 1.6 Notation

- JSON is RFC 8259, restricted to I-JSON (RFC 7493) in what matters for a single
  reading: no object names a member twice, and no string holds an unpaired
  surrogate. Every JSON text this specification defines — a frame, an envelope,
  a binding's other messages — nests arrays and objects at most **32** deep (the
  outermost object is the first level); a receiver treats a deeper one as not
  that message, and SHOULD find out in one pass over the text before handing it
  to a parser that recurses once per level, since such a parser can exhaust its
  stack on a few kilobytes. No message this specification defines needs more
  than a handful of levels. Base64 is the standard alphabet with padding (RFC 4648 §4), and only
  its canonical form: the bits the padding discards are zero, so one text encodes
  one byte string. A device tag is base64url without padding (RFC 4648 §5).
- Strings are **UTF-8** (RFC 3629). A length "in bytes" is the length of that
  UTF-8 encoding; a length "in characters" counts Unicode code points.
- An integer field is a JSON number without a fraction or an exponent.
- A grammar is ABNF (RFC 5234).
- A duration named `…Ms` is in milliseconds.

### 1.7 What must stay

*Informative.* TDSP 2.0 is checked against this list; a change that drops an item
was not made. It is what 1.x covers, and what an implementation of 2.0 can be
tested against.

1. **Three messengers**: Signal (no history, 800 inline bytes, attachments),
   Matrix (encrypted and plain rooms), email with PGP. Further bindings stay
   possible.
2. **One creator as the single authority**, no consensus, no second channel, no
   cryptography of TDSP's own. "Sender equals creator" stays the one check.
3. **Permissions** `read`, `write`, creator; grant and revoke at any time; close
   is final.
4. **Joining without history** (Signal) and with it (Matrix, email), from an
   invitation as a link or a message.
5. **Loss, duplicates, reordering**: convergence, loss evidence, healing by
   resync; no acknowledgements.
6. **One member on several devices**, the creator included; an own device brings
   a new device up to date while the creator is offline.
7. **Persistence**: the creator restarts with its control state; any member
   restarts with persisted content shown at once; undistributed changes stay
   visible.
8. **Large changes**: megabytes at once arrive, and so does a bootstrap answer for
   a large document.
9. **External profiles and layers.**
10. **Attribution** as display, never as authentication.
11. **Bounded resources** against anything a peer sends.
12. **No external connection** but to the chosen messenger.
13. **Provider rate limits**: no participant exceeds its own provider's limits,
    whatever others want.

Not on the list, because TDSP does not do it ([§15.4](#154-what-is-not-guaranteed)):
deletion, portability between messengers, protection against a malicious
participant.

## 2. Architecture

### 2.1 Layers

*Informative, with the invariants below normative.*

```text
  Application   documents, profile choice, persistence, what a person sees
  ─────────────────────────────────────────────────────────────────────
  Engine        frames, control state, bootstrap, resync, scheduling,
                loss detection; the document's profile does the CRDT work
  ═══════════ transport contract (§3): a programming interface ═══════
  Adapter       one per messenger; maps the contract onto its bridge
  ───── in-process call, or the local bridge interface (bindings/) ────
  Bridge        one messenger account: credentials, the messenger's own
                protocol, routing by documentId, message immutability
  ─────────────────────────────────────────────────────────────────────
  Messenger     Signal · Matrix · SMTP/IMAP · …          (not TDSP's)
```

The application and the engine are the same for every messenger. The adapter
and the bridge are written once per messenger. The messenger is someone else's.

**Why "messenger".** TDSP needs something that carries opaque messages to a
fixed group of people and says who sent each one; it does not need a messaging
service as such. A peer-to-peer link, a mail system or a record-sharing service
can carry TDSP as well as a messenger can — [§15.1](#151-what-a-messenger-must-provide)
lists exactly what is required. The term stays because messengers are the carrier
TDSP is designed for, and for a reason that matters: a messenger such as Signal,
or Matrix in an encrypted room, already authenticates senders and protects the
integrity and confidentiality of every message, and TDSP inherits all three.
Email shows what that saves: to meet the same requirements it needs PGP on top
([email binding](bindings/email.md)).

**Why a bridge, and when a process boundary.** The bridge holds the credentials —
a linked Signal device, a Matrix access token and crypto store, a mail password
and a PGP keyring — and speaks the messenger's own protocol. How the adapter
reaches it is an implementation choice. In a native or server-side program the
adapter and the bridge can be one library, called in-process. A web page cannot
do that: it can open no raw TCP connection (SMTP, IMAP), load no native crypto
module, start no process and read no keyring, so its only way to those
capabilities is an HTTP request to a process on the same machine. For that case,
and for reusing a bridge from another language, the
[local bridge interface](bindings/local-bridge-interface.md) defines an optional
local HTTP interface. A separate process also keeps the
credentials away from the component that renders untrusted document content
(ARC-4).

| Layer | Owns | May assume from below | Must never |
|---|---|---|---|
| Application | Rendering, local undo grouping, showing attribution and status, choosing the profile | The engine's state is converged | Reach the network; present attribution as authentication |
| Engine | Frames, bootstrap, resync, de-duplication, scheduling, control state, attribution overlay | A payload handed down is accepted by the messenger or visibly refused — accepted meaning neither delivered nor applied ([§3.3](#33-delivery-semantics)) | Parse an envelope; open a network connection |
| Adapter | Mapping the transport contract onto its bridge | Its bridge is reachable | Parse a frame |
| Bridge | Credentials, the messenger's protocol, routing by documentId, message immutability | The messenger delivers to channel members and names senders | Parse a frame; reach any host but its one messenger endpoint |
| Messenger | Delivery, sender authentication, encryption, channel membership | — | — |

A useful test for where something belongs: **a policy the participants agreed
belongs in the engine; a fact about the messenger belongs in the bridge.**
Permissions are a policy. A message size limit is a fact.

- **ARC-1** · *engine, application* — All document data exchanged between
  participants MUST cross the transport contract ([§3](#3-the-transport-contract)).
  An engine or application MUST NOT open any other channel to another
  participant — no WebSocket, WebRTC, HTTP synchronisation, shared storage or
  presence service.
  *Rationale:* confidentiality and sender authentication are inherited from the
  messenger ([§15](#15-security-considerations)); a second channel bypasses both
  and voids every security statement in this document.
- **ARC-2** · *engine, application, adapter* — An engine, application or adapter
  MUST NOT open a network connection to anything other than its bridge, and a
  bridge reached over a network interface MUST be on the loopback interface
  (LBI-1, [local bridge interface](bindings/local-bridge-interface.md)).
  *Rationale:* TDSP promises that it opens no external connection of its own; the
  only component that talks to the outside world is the bridge, and it talks only
  to its messenger (BRG-4, [bindings/bridges.md](bindings/bridges.md)).
- **ARC-3** · *adapter, bridge* — An adapter or bridge MUST NOT parse, validate or
  act on the content of a frame. It routes by the envelope's documentId and
  hands the frame on unchanged.
  *Rationale:* the frame format and every protocol rule then live in exactly one
  place, the engine; a bridge that interprets frames is a second, divergent
  implementation of the protocol, and the transport stops being replaceable.
- **ARC-4** · *application, adapter, bridge* — Messenger credentials (keys,
  tokens, passwords, linked-device state, keyrings) SHOULD be held by a component
  separated from the one that renders document content — a separate process, an
  XPC service or an equivalent operating-system boundary — and MUST NOT be passed
  to the engine or to any component that renders document content or anything
  else received through the channel. A sign-in form of the application MAY take a
  password the person types and hand it to the bridge, when the form runs outside
  such a component and keeps nothing of it.
  *Rationale:* the component that renders untrusted content should not be able to
  speak as the user on the messenger; a process boundary makes that a property
  of the system rather than of the code's discipline. It is a SHOULD because a
  single-process program without untrusted rendering has no such component to
  separate. What matters is which component holds a credential, not which program
  it belongs to: a bridge reached as a separate process has no window of its own,
  and the form the person types a password into belongs to the application; it is
  safe there as long as nothing that renders what others sent can reach it.
- **ARC-5** · *application* — ARC-1 governs what passes between participants. An
  application MAY carry a document's content, control state and binding between
  the devices of one person through another service — storage of the person's own
  account at another provider, say —, as it may keep a backup there. It MUST tell
  the person, before it first does so, that the document's content is then stored
  there, as confidential as that service makes it rather than as the channel does,
  and MUST NOT let anyone but that person read or write the document through it.
  *Rationale:* a person's own devices are one participant, so ARC-1's reason —
  that confidentiality and sender authentication between participants come from
  the messenger — does not reach them; a person who uses several devices needs
  their documents on each, and a messenger without history cannot bring a new
  device up to date by itself. What the other service changes is where a copy
  lies, and TDSP protects nothing beyond the channel ([§15.4](#154-what-is-not-guaranteed)):
  the person has to know which service that is.

### 2.2 Two envelopes, two readers

One message on the wire carries two nested wrappers with different readers.
Confusing them is the most common way to get this stack wrong.

```text
  messenger message   (a Signal group text · a Matrix event · an email)
  └── envelope   {"tdsp":1,"kind":"frame","documentId":"…","frame":"<the frame as a JSON string>"}
      │          read by the BRIDGE: routing
      └── frame  {"tdsp":2,"kind":"edit","documentId":"…","update":"<Base64>","due":30000}
          │      read by the ENGINE: verification and interpretation
          └── update   opaque CRDT bytes, read by the document's PROFILE
```

The two version fields are kept apart on purpose. The envelope's `tdsp` is the
bindings' version and stays `1`: the envelope did not change, so a bridge of 1.x
carries frames of 2.0 unchanged. The frame's `tdsp` is this specification's
version (FRM-2, VER-1).


The documentId appears in both wrappers, and that is not duplication. The
envelope's copy is a **routing key** the bridge acts on; the frame's copy is a
**verification copy** only the engine reads (FRM-8). One channel may carry
several documents and ordinary human chat, so misrouting is reachable in normal
use, not only under attack.

### 2.3 The creator is the single authority

A document has exactly one creator, fixed at creation. The creator alone decides
anything about the document; everyone else edits (if permitted), asks and
observes:

| The creator alone | Everyone else |
|---|---|
| Creates the document and binds it to a channel | Joins a document they were invited to |
| Grants, changes and revokes `read`/`write` ([§7](#7-control-state)) | Edits, if permitted |
| Closes the document ([§6.4](#64-closing-a-document)) | Observes that it is closed |
| Issues control operations, from any of its devices, each counting its own | Merges them, and notices a hole in a device's count |
| Sets the pace: the shortest interval anyone sends at ([§9.1](#91-pacing)) | Keeps to it and to their own bridge's bounds; the rest of their pacing is their own |
| Answers resync requests, including every joiner's bootstrap ([§8](#8-bootstrap-and-resync)) | Asks |

The gain is that **membership integrity reduces to one comparison**: does a
delivery's authenticated sender equal the one creator identity every
participant learned from the invitation? There is no consensus protocol, no
shared server and no key agreement about who may decide.

The cost is stated as plainly: **the creator is a single point of
availability.** While the creator is offline, nobody can join, nobody can be
granted access, and a participant with a gap cannot be healed. Each of those is
a delay, not a loss: the participants who already hold the document keep
converging among themselves. Letting peers answer resync requests again would be
a policy change at layer 4 and needs no wire change. A creator who lost every
device but not the messenger account is not lost as the creator: a new device
decides at once ([§7.6](#76-a-new-device-of-the-creator)).

## 3. The transport contract

The transport contract — `MessengerPort` in the reference implementation — is
the interface between an engine (layer 4) and an adapter (layer 3). It expresses
what a messenger can do, never a vendor API, and it carries no application
policy: permissions, lifecycle and resync are frames, not methods.

### 3.1 Types

```ts
type DocumentId = string;   // §6.1
type MemberId   = string;   // the messenger's own identity for a participant
type DeliveryId = string;   // unique per message within a document

interface Delivery {
  readonly id: DeliveryId;
  readonly documentId: DocumentId;
  readonly sender: MemberId;     // authenticated by the messenger, not by TDSP
  readonly payload: string;      // exactly one frame as JSON text, opaque to the adapter
}

interface RawChannel {
  readonly id: string;           // the stable key a binding uses
  readonly name: string;         // for display only: mutable, not unique
  readonly encrypted?: boolean;  // as the messenger reports it; absent if unknown
}

type Permission = "read" | "write" | "creator";
```

- **TRN-1** · *adapter* — `Delivery.id` MUST identify one message: every time the
  same message is returned it MUST carry the same id, and two different messages
  of a document MUST NOT share an id.
  *Rationale:* the engine de-duplicates by this id (TRN-8); an id that
  changes between polls re-applies a message, one that collides silently drops one.
- **TRN-2** · *adapter* — `Delivery.sender` MUST be the sender identity the
  messenger itself attributes the message to, never a value taken from the
  envelope, the frame or any other part of the message content.
  *Rationale:* every authority check in TDSP compares this field against the
  creator's identity (CTL-5); a sender read from content is chosen by whoever
  wrote the content.
- **TRN-3** · *adapter* — `Delivery.payload` MUST be exactly the text the sender
  passed to `send()`, character for character.
  *Rationale:* the frame's integrity is not otherwise checked by TDSP; the
  messenger's own integrity protection is what is inherited.
- **TRN-4** · *application* — An application MUST use `RawChannel.id`, never
  `RawChannel.name`, to bind, look up or compare channels.
  *Rationale:* a channel name is typically chosen by any member, mutable and not
  unique; binding by name lets a renamed or look-alike channel capture a document.

### 3.2 Operations

| Operation | Semantics |
|---|---|
| `createDocument(documentId, creator)` | Registers the document with the adapter and records `creator` as its creator. Does not create, reconfigure or post into a channel; binding a channel is a bridge operation ([bindings/bridges.md](bindings/bridges.md)) |
| `send(documentId, sender, payload)` → `DeliveryId` | Broadcasts one frame to every member of the document's channel. Resolves once the messenger has accepted it |
| `receive(documentId, member)` → `Delivery[]` | Returns the deliveries recorded for the document so far |
| `receiveSince(documentId, member, after)` → `{ deliveries, truncated }` | Optional. The deliveries after `after`, the last `DeliveryId` the caller saw (`undefined` for all still held); `truncated` is true when deliveries after `after` may have come and gone unseen (TRN-18) |
| `instance()` → `string` | Optional. An id of the bridge's window as it stands, changing whenever the bridge may have lost something it held (TRN-19) |
| `listChannels(member)` → `RawChannel[]` | The channels this account can see, to populate a picker. Answers "which channels exist", never "which documents do I have" |
| `transportProfile()` → `TransportProfile \| undefined` | Optional. The messenger's bounds and suggested pacing ([§3.5](#35-transport-profile)) |
| `channelMembers(channelId)` → `MemberId[]` | Optional. The members of a channel this account belongs to, as the messenger reports them at the moment of the call (TRN-17); `channelId` as `listChannels` names it, so it can be asked before a document is bound |
| `sendInvitation(documentId, sender, text)` → `DeliveryId` | Optional. Sends a human-readable invitation ([§11](#11-invitations)) into the document's bound channel as `sender`, who must be the bridge's own account and the document's creator (BRG-16). A binding whose invitation *is* how its channel begins — email: the thread's root message — has no separate step and omits it |

- **TRN-5** · *adapter* — `createDocument` MUST NOT change the membership,
  permissions or configuration of any existing channel.
  *Rationale:* TDSP never administers a channel that people set up; doing so
  would need powers the participants did not grant and would make TDSP
  responsible for access control it cannot enforce.
- **TRN-6** · *adapter* — `send` MUST resolve only after the messenger has
  accepted the message, and MUST otherwise reject with a classified failure
  ([§3.4](#34-send-failures)).
  *Rationale:* the engine keeps a change until a send has succeeded (SND-6); a send
  that resolves early turns a later refusal into a silent loss.
- **TRN-7** · *adapter* — `receive` MUST return every delivery of the document the
  adapter has observed and still retains (BRG-17), and MAY return deliveries it
  returned before. It MUST include the messages the receiving member sent from
  another of its devices, as its messenger's binding delivers them (SIG-3, MTX-4,
  EML-12), and MAY include those this device sent itself.
  *Rationale:* a cumulative, unfiltered answer over a bounded window is the
  simplest contract a bridge can meet: filtering is where messages get lost, and
  de-duplication is cheap at the engine. A member may run several devices, each
  with an engine of its own; filtering by sender would leave one of them blind to
  what another wrote. The window keeps a long-lived document's
  answer from growing without end; what slides out before an engine read it is a
  lost message, which loss detection notices in the cases [§10](#10-loss-detection)
  names (LOS-8) and a resync then recovers — not in every case, as
  [§10.6](#106-what-loss-detection-cannot-notice) says.
- **TRN-8** · *engine* — An engine MUST process each `Delivery.id` at most once while
  `receive` keeps returning it, and MUST tolerate receiving its own messages. It MAY
  forget an id once `receive` no longer returns it, except the ids of its own
  recent sends, whose echo may still be on its way. Because a forgotten delivery
  can be offered again (BRG-17), processing a frame a second time MUST NOT change
  the document or control state again:
  - content is a CRDT;
  - control state is a set of operations, in which an operation already held is
    inert (CTL-24);
  - a decline is reported once per sender (DCL-3);
  - an overlay is adopted once (RSY-15).

  A resync request is recognised by its `requestId` (RSY-16) while the engine
  remembers it; one old enough to be forgotten may be answered again.
  *Rationale:* the counterpart of TRN-7. Remembering every id for a document's
  whole life would grow without bound; making every kind's effect idempotent is
  what lets an engine forget, whatever a bridge re-offers after a restart. What a
  re-offered message can still cost is traffic, never state: a second answer to
  an old request, or loss evidence that triggers one unneeded resync request.
- **TRN-9** · *adapter* — An adapter that cannot provide an operation MUST reject
  it with an error that names the capability gap, and MUST NOT resolve it as a
  silent no-op.
  *Rationale:* a messenger that is quietly less capable than the contract lets
  the application believe something happened that did not.
- **TRN-18** · *adapter* — An adapter SHOULD offer `receiveSince`: the deliveries
  after the cursor `after`, with `truncated` true when deliveries after it may have
  come and gone unseen. It MUST answer `truncated: true`:
  - when `after` is not in the bridge's window — the delivery has left it, or the
    bridge never issued that id;
  - when the bridge knows that it passed over part of what its messenger held for
    the channel after `after`: a catch-up that stopped before it reached what the
    bridge had read, an answer of its messenger it skipped unread.

  Without `after`, it answers what `receive` answers and `truncated` is false. An
  adapter that cannot tell whether a cursor left its window MUST NOT offer it.
  *Rationale:* without a cursor an engine can only guess from overlapping answers
  whether its last poll and this one missed something between them (LOS-8). The
  bridge knows; saying so turns the guess into a fact where the messenger has a
  position to resume from (a Matrix `since` token, a CloudKit change token, an
  IMAP UID). It is a SHOULD because a bridge whose messenger has no such position
  can still meet TRN-7. A bridge that skipped part of what its messenger held is
  where one whose window moved on is: a delivery after the cursor will never reach
  the engine, and only the bridge knows. A catch-up that stops short — at a limit
  of the messenger's, at an error of its server — while the bridge's position
  moves past the gap would otherwise read as complete, and an engine that restored
  its control state from before the gap would read on as if it had missed nothing,
  a revocation included (CTL-41). A message the bridge refuses or ignores (BRG-10,
  BRG-12) is not passed over: it was never a delivery.
- **TRN-21** · *adapter* — An adapter that offers `receiveSince` (TRN-18) MUST
  answer the deliveries in the order its window holds them, oldest first, so that
  the last delivery of an answer is where the next one continues; an empty answer
  leaves that place where it was.
  *Rationale:* the order is the window's own, not the messenger's: an engine
  continues after the last delivery an answer held (LOS-9), so an answer in another
  order would skip what lies between, however the messages travelled.
- **TRN-19** · *adapter* — An adapter SHOULD offer `instance`: a string that names
  the bridge's window as it stands, its *epoch*. The instance MUST change whenever
  the bridge may have lost a delivery it held, or one its messenger had already
  handed it that never entered its window — a restart of a bridge that keeps
  either only in memory, say — and SHOULD stay the same otherwise, across a
  restart that kept both included.
  *Rationale:* a bridge that restarts may lose what it held, and a restart that
  falls entirely between two polls is otherwise invisible
  ([§10.6](#106-what-loss-detection-cannot-notice)). A new id is what the engine
  needs to treat it like a truncated window (LOS-9), with or without a cursor. What
  decides is the loss, not the process: a bridge that keeps its window and its
  position at the messenger together on disk loses nothing by restarting, and a
  new id would cost every engine that reads it a forced resync (LOS-6) for
  nothing; a bridge that holds messages it took from its messenger but has not
  entered yet — events waiting for their key, notifications nobody read yet —
  loses them in a restart and must say so. A new id on every start of the bridge
  is the simplest way to meet the MUST.
- **TRN-17** · *adapter* — `channelMembers` MUST answer the channel's members as
  the messenger reports them at the moment of the call, this account included,
  and MUST refuse a channel this account is not in rather than answer for it. It
  is a snapshot: who joined or left between two calls is not reported. An engine
  MUST NOT call it.
  *Rationale:* an application fills a participant list when it creates a
  document, and notices someone who joined the channel later, from what the
  messenger says now; that is as trustworthy as the bridge's own membership check
  (BRG-5) and grants nothing by itself — a permission is still the creator's
  control frame. Answering for a channel one is not in would reveal other
  people's membership.

### 3.3 Delivery semantics

These are the only guarantees an engine may rely on:

1. **Accepted, or visibly refused — nothing more.** A successful `send()`
   means only that the messenger accepted the message for delivery to every
   channel member. It confirms neither that any member received it nor that
   any member's engine applied it. An accepted message normally arrives, may
   arrive twice, and may never arrive at some members; there is no
   acknowledgement from the receiving side.
2. **No order.** Messages may arrive in any order, including across senders and
   across kinds.
3. **No history.** An engine that starts listening later may see only messages
   sent after that point.
4. **No loss notification.** A message the messenger accepted and never
   delivered is invisible at this interface.
5. **A messenger-authenticated sender**, worth exactly what the messenger's
   authentication is worth ([Appendix C](bindings/bridges.md#appendix-c-the-bindings-compared)).

- **TRN-10** · *engine* — An engine MUST NOT depend for correctness on ordering,
  exactly-once delivery, history replay or loss notification by the transport,
  and MUST treat a successful `send` as "accepted by the messenger", never as
  "delivered" or "applied": it MUST expect that an accepted message never reaches
  some members, and an application MUST NOT show a sent change as received by
  everyone.
  *Rationale:* none of the supported messengers provides all four, and Signal
  provides no history at all; a mechanism that needs one of them works on some
  messengers and fails silently on others.

### 3.4 Send failures

A refused send must say whether trying again can help, because the engine keeps
and retries what can succeed later, drops what cannot (SND-6, SND-8), and waits
for the person where only the person can help (TRN-20).

| Reason | Meaning | Retryable |
|---|---|---|
| `rate-limited` | The messenger is throttling. MAY carry `retryAfterMs`, the wait the messenger asked for | Yes |
| `unavailable` | The bridge or the messenger could not be reached or failed | Yes |
| `needs-person` | Refused until a person acts on an account: none is set up or signed in, an identity is not trusted, a device is not confirmed, the storage that holds the messages is full | Once a person acted (TRN-20, TRN-22) |
| `too-large` | The payload exceeds what one message can carry | No |
| `rejected` | Refused for a reason waiting cannot change: unknown document, forbidden sender, malformed request | No |

- **TRN-11** · *adapter* — A failed `send` MUST reject with one of the five reasons
  above, and SHOULD carry `retryAfterMs` when the messenger stated a wait, read
  from wherever the messenger states it — a header as well as the body, as its
  binding says (MTX-6). A refusal that only a person can lift MUST be
  `needs-person`, never `unavailable` or `rejected`.
  *Rationale:* the classification is a fact about the messenger that only the
  transport side knows. A refusal a person must lift fits neither of the others:
  waiting alone does not pass it, so `unavailable` makes the engine send again and
  again into the same refusal; acting does, so `rejected` drops a change that a
  minute later could have gone out.
- **TRN-12** · *engine* — An engine MUST treat a send failure that carries none of
  the five reasons as `unavailable`.
  *Rationale:* the fault this classification exists to remove is dropping a
  change on an unfamiliar failure; wrongly retrying costs a bounded back-off,
  wrongly dropping costs the document.
- **TRN-20** · *engine* — An engine MUST keep a change whose send was refused as
  `needs-person`, as for a reason worth retrying (SND-6), MUST expose, beside the
  states of SND-10, that sending waits for the person, with the transport's
  message, and MUST NOT report the change as dropped. After such a refusal it MUST
  NOT send anything — no message of any kind — sooner than its longest back-off
  ([Appendix B](#appendix-b-recommended-values)), unless its application asks it to
  send now (TRN-22).
  *Rationale:* the refusal does not pass by waiting, so the back-off of SND-7 would
  only spin, offering the messenger the same refused message again and again; it
  passes once the person trusts the identity, confirms the device, signs in or
  frees storage, so dropping the change (SND-8) would cost what nothing else
  repairs. The person may act where the application cannot see it — on another
  device, in the operating system's settings — so the engine still tries now and
  then, at the slowest rate it retries anything.
- **TRN-22** · *application* — While its engine exposes that sending waits for the
  person (TRN-20), an application MUST show the person that sending waits for them,
  and what the transport said, and SHOULD ask the engine to send now once it sees
  the person act.
  *Rationale:* only the person can lift the refusal, so they have to learn of it,
  and what the transport says they must do; once they acted, waiting out the
  back-off would only delay what may go now.

### 3.5 Transport profile

A bridge knows its messenger's limits; the engine needs them to schedule sends.
The transport profile carries them, and the pacing the bridge suggests for a
participant who chose none:

```json
{
  "bounds": { "minIntervalMs": 15000, "maxBytes": 4194304 },
  "pacing": { "minIntervalMs": 30000, "maxIntervalMs": 120000,
              "minChars": 0, "maxChars": null,
              "expectedLatencyMs": 60000 }
}
```

- `bounds.minIntervalMs` — the shortest interval between two sends the messenger
  tolerates: a hard floor over every pacing and over the creator's pace. `null`
  for none. A messenger that allows a burst above a sustained rate (a token
  bucket) has no single such interval, and a floor cannot express it: the binding
  states the interval it chose and why — the sustained rate, which is never
  refused, or a shorter one, beyond which the messenger's own refusals, with the
  wait they name, do the rest (SND-7, SND-9).
- `bounds.maxBytes` — the largest frame, in bytes of its UTF-8 text, one message
  can carry, attachments included where the binding has them. Larger changes are
  sent as pieces ([§9.4](#94-changes-larger-than-one-message)). `null` for none.
- `pacing` — a complete pacing ([§9.1](#91-pacing)): all five values, `null` only
  for `maxIntervalMs` or `maxChars` without a limit. A suggestion, unlike the
  bounds. Named presets, their labels and descriptions belong to the application,
  not to the transport.

Every field is required. "No bound" and "no limit" are spelled `null`, never by
leaving a field out.

- **TRN-13** · *adapter, engine* — A transport profile MUST be validated as a whole:
  a missing field, a field that is not defined, a number that is negative or not
  finite, or `null` where it is not allowed MUST make the whole profile invalid,
  and an invalid profile MUST cause the call to fail rather than be treated as
  "no profile".
  *Rationale:* falling back to no limits on a garbled profile means sending faster
  than the messenger allows, which is how messages get refused and lost. Requiring
  every field closes the quiet version of the same fault: a misspelled optional
  field would otherwise read as "no bound".
- **TRN-14** · *engine* — An engine MUST obtain the transport profile, if the adapter
  offers one, before it sends its first frame, and MUST fail the creation or join
  of a document if that fails.
  *Rationale:* same as TRN-13; an engine that starts sending before it knows the
  floor can exhaust a provider's budget in its first minute.
- **TRN-15** · *adapter* — An adapter that has no profile MUST return `undefined`
  (or not offer the operation); the engine then applies its own defaults
  ([Appendix B](#appendix-b-recommended-values)).
  *Rationale:* the in-memory test transport has no limits and must not be forced
  to invent some. (A bridge in front of a server on the same machine answers a
  profile with no floor and a pacing equal to the engine's defaults, which has
  the same effect.)

### 3.6 Conformance suite

`packages/messenger-port/src/contract.ts` exports the transport conformance
cases. Each runs with a fresh fixture of two ports, a creator and a member, and
polls for up to 15 seconds because real adapters deliver asynchronously:

1. A member's `send()` arrives in the other member's `receive()` unchanged,
   with the right `sender`.
2. A `send()` for a document that was never registered is refused with a
   `TransportSendError` whose reason is not retryable.
3. Where `channelMembers` is offered, it names both members of their channel.
4. Where `receiveSince` is offered, a cursor returns only what came after it, and
   a cursor the bridge never issued answers `truncated: true`. A cursor that left
   the window, and one behind a gap the bridge passed over, answer so too
   (TRN-18), but no case can make a real messenger produce either on demand; an
   adapter's own tests show them.

- **TRN-16** · *adapter* — An adapter MUST pass the conformance suite against its
  real messenger, with two real accounts, repeatedly.
  *Rationale:* asynchronous delivery makes an intermittent failure a real defect,
  not noise; one green run proves little.

Deliberately not covered: `listChannels`, the stability of `Delivery.id` across
polls, and ordering. Rules that are application policy — a read-only member does
not send, only the creator changes membership, nothing is sent after a close —
are tested once in the engine's own suite, not per adapter.

For the wire itself, the reference implementation publishes versioned **test
vectors** (informative): `packages/document-protocol/test-vectors/frames-v2.json`
— frames that must decode to a given kind, and frames that must be rejected with
a given reason from [§4.4](#44-decoding-and-rejection), each read by a receiver
whose document has the profile the file names — and `invitations-v2.json`
for the link of [§11.3](#113-invitation-as-a-link); the bindings publish their own
([bindings/](bindings/)). An implementation in another language shows it reads
the wire as this specification does by passing them; the reference
implementation checks itself against the same files. Until TDSP releases 2.0
they carry the draft marker and are named `frames-draft-5.json` and
`invitations-draft-5.json` (VER-3).

## 4. The payload frame

Every payload an engine sends, and every payload it accepts, is exactly one
frame: a JSON object (RFC 8259) serialised as text. Binary data inside it — CRDT
updates and state vectors — is Base64 (RFC 4648 §4, with padding).

The frame is text for the reason the envelope is: a message that looks like text
should behave like text, it can be read and debugged with ordinary tools, and one
encoding runs through the whole stack. It costs little. The envelope carries the
frame as a JSON *string*, not as Base64 ([bindings/bridges.md](bindings/bridges.md)),
so the CRDT bytes are Base64-encoded exactly once on their way to the messenger,
and the field names add a few dozen bytes to a message whose limits are counted
in messages rather than bytes.

### 4.1 Common fields

Every frame has these three fields:

| Field | Type | Meaning |
|---|---|---|
| `tdsp` | integer | The frame format version: 2 |
| `kind` | string | What the frame is ([§4.2](#42-kinds)) |
| `documentId` | string | The document, 1 to 255 bytes in UTF-8 |

Any frame may also carry `crit` and extension fields ([§4.4](#44-decoding-and-rejection)).

- **FRM-1** · *engine* — Every payload an engine passes to `send()` MUST be exactly
  one frame as defined in this section, serialised as UTF-8 JSON text, and an engine
  MUST NOT process a payload that does not decode as one.
  *Rationale:* a single framed format with no unframed fallback means a payload
  from an unrelated protocol, an old version or a corrupted message fails loudly
  instead of reaching the CRDT, which would otherwise apply it or crash unpredictably.
- **FRM-2** · *engine* — A sender MUST write `"tdsp": 2`.
  *Rationale:* the field identifies a TDSP frame among arbitrary text — an email
  body, a chat message — and names the format version a receiver must implement.
- **FRM-3** · *engine* — A documentId MUST be 1 to 255 bytes long in UTF-8.
  *Rationale:* an empty id cannot route; a bound keeps every frame's fixed part
  small and predictable.
- **FRM-4** · *engine* — A sender SHOULD serialise a frame without insignificant
  whitespace.
  *Rationale:* whitespace is bytes against a messenger's size limit and carries
  nothing.

### 4.2 Kinds

| Kind | Sent by | Carries |
|---|---|---|
| `edit` | any member permitted to write | A CRDT update, or one piece of one ([§9.4](#94-changes-larger-than-one-message)) |
| `resync-request` | any member | What the requester already has ([§8](#8-bootstrap-and-resync)) |
| `resync-response` | the creator; a peer only to the creator ([§8.3](#83-who-answers)) | An update, a control snapshot and an attribution overlay |
| `control` | a device of the creator only | One control operation: a member's permission, the close, or the pace ([§7](#7-control-state)) |
| `heartbeat` | any member | The sender's state vector and state digest, a creator device's control vector and control digest, and where it stands in its sender's stream ([§9.3](#93-heartbeat)) |
| `decline` | any member of the channel, joined or not | Why an invitation was declined ([§6.5](#65-declining-an-invitation)) |

The `fragment` kind of TDSP 1.x is gone: a change larger than one message travels
as pieces, each an ordinary `edit` or `resync-response`
([§9.4](#94-changes-larger-than-one-message)).

### 4.3 Kind-specific fields

"Base64" is a string of Base64 text; "uint32" is a JSON integer from 0 to
4 294 967 295, written without a fraction or an exponent; a "device tag" is 22
characters of base64url without padding, the encoding of 16 random bytes
([§7.2](#72-operations)); a "control vector" is an object that maps device tags to
uint32 counters, at most 64 of them ([§7.4](#74-holes-and-the-control-vector)), in
which an entry of 0 counts as absent (FRM-14); a "stream tag" is 16 lowercase hex
digits, chosen at random by an engine each time it starts (LOS-13).

| Kind | Field | Type | Meaning |
|---|---|---|---|
| `edit` | `update` | Base64, not empty | A CRDT update, or a piece of one ([§5](#5-document-profiles)) |
| | `due` | uint32 | The milliseconds within which the sender will send another message at the latest; 0 for no promise (SND-14) |
| `resync-request` | `requestId` | 16 lowercase hex digits | Random, chosen by the requester, new for every request; what the answer names (RSY-16) |
| | `control` | control vector or `null` | The requester's control vector; `null` while it holds no control snapshot from the creator (RSY-16) |
| | `controlDigest` | digest or `null` | The digest of the requester's control state (LOS-12); `null` exactly when `control` is |
| | `force` | boolean | `true` when the requester needs an answer even if it seems to lack nothing: its history was truncated (LOS-8, LOS-9, LOS-19) |
| | `stateVector` | Base64 | The requester's state vector |
| | `stateDigest` | digest | The digest of what the requester deleted (LOS-12) |
| | `stream` | stream tag | The requester's stream (LOS-13) |
| | `sequence` | uint32, at least 1 | This report's number in that stream (LOS-13) |
| `resync-response` | `respondsTo` | 16 lowercase hex digits | The `requestId` of the request answered |
| | `update` | Base64, not empty | What the requester lacks, or one piece of it; where it lacks nothing, or a piece carries only the snapshot and the overlay (SND-18), an update that holds nothing (PRF-1, item 4) |
| | `control` | object or `null` | A control snapshot, in the layout of [§7.5](#75-the-control-snapshot): the creator's (`null` from a device of the creator without a basis, CTL-28); from a device answering another device of its own member, its own; from a member answering a device of the creator, what it holds, which counts there as a report only (CTL-27); `null` otherwise (RSY-8) |
| | `attribution` | object or `null` | The responder's attribution overlay, in the layout of [§5.4](#54-attribution-overlay); `null` for none |
| | `stateVector` | Base64 or `null` | In an answer's last piece, the responder's state vector as it answered; `null` in the others (RSY-18) |
| | `stateDigest` | digest or `null` | Beside `stateVector`, the digest of what the responder deleted; `null` exactly when `stateVector` is |
| | `stream` | stream tag | The responder's stream, the same in every piece of the answer (LOS-13) |
| | `sequence` | uint32, at least 1 | The answer's number in that stream, the same in every piece (LOS-13) |
| | `piece` | uint32, at least 1 | This piece's number in the answer, 1, 2, 3, … in the order sent (LOS-14) |
| | `pieces` | uint32 or `null` | In an answer's last piece, how many pieces the answer has — that piece's own number; `null` in the others, and exactly when `stateVector` is (RSY-18) |
| `control` | `device` | device tag | The creator device that issued the operation |
| | `counter` | uint32, at least 1 | That device's own count of its operations, 1, 2, 3, … |
| | `target` | string | `member:<MemberId>` (the MemberId 1 to 255 bytes), `layer:<layer id>:member:<MemberId>` ([§5.6](#56-layers)), `close` or `pace` |
| | `value` | see [§7.2](#72-operations) | For a member or a layer right `"read"`, `"write"` or `null` (revoked); for `close` `true`; for `pace` a uint32 of milliseconds |
| | `seen` | control vector | What the device had seen of the creator's other devices when it issued the operation (CTL-22) |
| | `due` | uint32 | As an `edit`'s (SND-14) |
| `heartbeat` | `control` | control vector or `null` | A creator device's control vector; `null` from anyone else |
| | `controlDigest` | digest or `null` | The digest of that device's control state (LOS-12); `null` exactly when `control` is |
| | `stateVector` | Base64 | The sender's state vector |
| | `stateDigest` | digest | The digest of what the sender deleted (LOS-12) |
| | `stream` | stream tag | The sender's stream (LOS-13) |
| | `sequence` | uint32, at least 1 | This report's number in that stream (LOS-13) |
| `decline` | `reason` | `"unsupported-profile"`, `"unsupported-version"`, `"declined"` or `"other"` | Why ([§6.5](#65-declining-an-invitation)) |
| | `profiles` | array of profile ids, at most 16 | optional: the document profiles the sender implements |
| | `text` | string, at most 500 characters | optional: a human-readable explanation |

- **FRM-5** · *engine* — A sender MUST write exactly the fields its frame's kind
  defines — the common ones, every required one, and an optional one only where
  it has a value — and no other field whose name has no `.`. It MAY add extension
  fields and `crit` (FRM-9 to FRM-12, FRM-15 to FRM-17).
  *Rationale:* a layout with a single reading of its defined fields is what lets
  two independent implementations interoperate; where something new is needed, an
  extension field says so by its name instead of hiding in an undefined one.
- **FRM-14** · *engine* — A sender MUST NOT write an entry of 0 in a control
  vector: a device of which it holds no counter without a gap is absent from it. A
  receiver MUST read an entry of 0 as absent: it holds, passes on and digests
  nothing for it, and does not count the device against the bound of CTL-30.
  *Rationale:* an entry of 0 and no entry say the same. But the control digest
  (LOS-12) is computed over the vectors a participant holds, so one that kept the 0
  would hold another spelling of the same state than one that never saw it, and
  their digests would differ — evidence of a divergence that is not there.
  Rejecting the frame instead would refuse a decision for a spelling of nothing.

### 4.4 Decoding and rejection

A receiver parses a frame, then checks that it belongs to the document the
delivery was routed to. Each failure has a name, so that an implementation's
report — and a test — can tell a version mismatch from a malformed message:

| Reason | When |
|---|---|
| `not-json` | The payload is not valid UTF-8, not valid JSON, not a JSON object, or not I-JSON: an object names a member twice, or a string holds an unpaired surrogate; or it nests arrays and objects more than 32 deep ([§1.6](#16-notation)) |
| `unsupported-version` | `tdsp` is missing or is not 2 |
| `unknown-kind` | `kind` is not one of §4.2 |
| `missing-field` | A field the kind requires is absent |
| `invalid-field` | A field has the wrong type or a value the layout forbids — an integer out of range, Base64 that does not decode, an empty `update`, an `update` or `stateVector` the document's profile does not read as exactly one update or state vector (PRF-1, item 9; bytes after a complete one included), a device tag that is not 22 base64url characters, an unknown `target`, a `value` its target cannot take, a control vector with more than 64 entries, an unknown `reason`, an overlong `text`, a `crit` that is not a list of 1 to 16 distinct names of extensions the frame carries, an answer's `pieces` other than its `piece`, or one without the responder's state or that state without it, a snapshot or overlay that breaks its layout (§5.4, §7.5) — or the frame, a snapshot or an overlay has a field whose name has no `.` and that its layout does not define; or an extension the receiver implements and `crit` names has a value its definition forbids (FRM-16) |
| `unsupported-extension` | `crit` names an extension the receiver does not implement (FRM-10) |
| `document-mismatch` | The frame's documentId is not the document the delivery was routed to |
| `profile-mismatch` | A `resync-response`'s control snapshot that counts for the receiver (CTL-25) names a profile other than the document's (CTL-10) |

- **FRM-6** · *engine* — A receiver MUST reject a frame for each condition in the
  table above and MUST NOT apply any part of a rejected frame, attempt a partial
  parse or fall back to another interpretation. It MUST check the whole frame —
  a `resync-response`'s snapshot and its overlay included, and every update and
  state vector by the document's profile (PRF-1, item 9) — before it applies
  anything of it. An optional part may be absent or `null` where its layout says
  so; one that is present and invalid rejects the frame. This holds for every
  field the layout defines; an extension field is FRM-9's and FRM-16's.
  *Rationale:* every best-effort parse is a place where two implementations
  disagree about what a message meant; a document that forks silently is worse
  than one that reports an error.
- **FRM-7** · *engine* — A rejection MUST be reported to the application as an
  error that carries the reason and the delivery's sender. Nothing is sent to the
  other participants.
  *Rationale:* by the time a frame reaches the engine, the bridge has already
  routed it here on purpose (BRG-10); a frame that then fails is evidence of a
  version skew, a misrouting bug or an attack, and all three need to be seen —
  locally. Telling the sender over the channel would be one more message anyone
  could provoke. The sender is what lets an application say whom a version skew
  concerns (VER-4).
- **FRM-8** · *engine* — A receiver MUST compare the frame's documentId with the
  document the delivery was routed to and reject a mismatch
  (`document-mismatch`), even though the bridge routed by an equal value.
  *Rationale:* this verification copy is what catches a bridge that routes
  wrongly; see [§2.2](#22-two-envelopes-two-readers).
- **FRM-13** · *engine* — A frame that meets several conditions of the table is
  rejected for one of them: `not-json` before every other, then
  `unsupported-version`, then `unknown-kind`; among the others, a receiver reports
  any one that applies.
  *Rationale:* each of the first three decides whether the rest can be read at
  all: a frame of another version has no fault in this version's layout, only
  another version, and that is what an application shows a person (VER-4). Among
  the others the reason is a local diagnostic (FRM-7) that changes nothing on the
  wire, and an order would make every implementation check fields in one sequence
  for nothing. The test vectors give each rejected frame one fault.
- **FRM-9** · *engine* — A field whose name contains `.` is an **extension**. A
  receiver MUST ignore an extension it does not implement — in a frame, a control
  snapshot, a snapshot's target entries and operations, and an attribution overlay
  alike, wherever a layout names its fields — and MUST NOT let it change how it
  reads any defined field. The keys of an object whose keys are data are not field
  names: a snapshot's `targets`, a control vector and an overlay's
  `lastEditBySender` are keyed by targets, device tags and MemberIds, and a target
  such as `member:@bob:example.org` is a target, not an extension, though it
  contains `.`.
  *Rationale:* closed layouts make every addition a wire break, and a protocol that
  can grow only by major version collects wishes until the break is big enough. A
  name with `.` cannot collide with a field this specification defines, which never
  has one (also for invitations, INV-6).
- **FRM-15** · *engine* — An extension's name (FRM-9) SHOULD begin with a reverse
  domain name its definer controls and end with `/` and its major version, such as
  `com.example.mood/1`: a change that implementations of the extension would
  misread takes the next major version, which is another extension, and a sender
  MAY carry both while receivers move over.
  *Rationale:* the version in the name lets an extension break with itself without
  a version field of its own.
- **FRM-10** · *engine* — A frame MAY carry `crit`: a list of 1 to 16 names of
  extensions the frame carries at its top level, each named once, whose meaning a
  receiver must implement to read the frame.
  - A `crit` that names an extension the frame does not carry, or one twice, MUST
    be rejected as `invalid-field`, whatever extensions the receiver implements.
  - A sender MUST name in it every extension that changes what a receiver does with
    the frame's defined fields — that restricts, widens or reinterprets what it
    applies or permits — and MAY leave out one that only adds to them.
  - A receiver that does not implement a name in it MUST reject the frame as
    `unsupported-extension`.

  *Rationale:* an extension that changes what a frame means cannot be ignored
  safely; `crit` lets its sender say so, as JOSE's `crit` header does. A name
  without its field, or a second time, would be read as required by one receiver
  and as nothing by another; rejected by everyone, it gives the list one reading.
- **FRM-16** · *engine* — A receiver that implements an extension MUST check its
  value as the extension's definition says: a value the definition forbids is
  ignored as an unknown extension is (FRM-9), unless `crit` names the extension
  (FRM-10), and then the receiver MUST reject the frame as `invalid-field`. Every
  rejection applies nothing of the frame (FRM-6), and a receiver MUST NOT act on an
  extension of any frame it rejects, for whatever reason.
  *Rationale:* an invalid value of an optional extension leaves the frame as a
  receiver without the extension reads it, so both apply the same; of a critical
  one, it leaves no reading at all.
- **FRM-11** · *engine* — Extensions MUST count toward `maxBytes` and the nesting
  limit of [§1.6](#16-notation) like any other field, and a sender MUST NOT carry in
  an extension what a defined field carries.
  *Rationale:* the bounds keep what an ignored field can cost a receiver as small
  as what any field can (§1.7, item 11); a defined field's duplicate would give a
  frame two readings again.
- **FRM-12** · *all* — An extension MUST have a public definition that states:
  - its name;
  - the kinds of frame that carry it;
  - the values it may take;
  - what a frame without it means;
  - whether its senders name it in `crit`;
  - what a receiver does with a value.

  A sender whose extension a joiner should learn writes it into its answers too
  ([§8.3](#83-who-answers)); and since an answer carries content of edits it did
  not write, `crit` on an edit keeps that content from a receiver without the
  extension only while the answers that carry it name the extension in `crit` as
  well.
  *Rationale:* a definition that leaves one of these open gives two
  implementations two readings of one frame again.
- **FRM-17** · *engine* — What an extension carries belongs to the frame that
  carries it: an engine MUST NOT keep it as document or control state, and MUST NOT
  write an extension it received into a frame of its own, a snapshot or an overlay;
  it writes only what its own application gives it (FRM-12 says what that means
  for answers). Below a frame's top level — in a snapshot, its targets and
  operations, and an overlay — this version defines no place for an extension an
  engine implements; there, every extension is ignored (FRM-9).
  *Rationale:* ignoring is not passing on: an extension that rode along in state
  would reach, in a relayed snapshot (CTL-25), receivers that never saw the frame
  it came with, and a receiver that does not implement it would have dropped it on
  the way. One frame, one sender, one meaning is what a receiver can check.

### 4.5 Example

A real `edit` frame for documentId `doc-a1b2c3`, produced by the reference
encoder. Its update is the whole state of a new `yjs-paragraphs/1` document
whose first paragraph holds "Hi" — one Yjs client, clocks 0 to 3; its sender will
send again within 30 seconds at the latest:

```json
{"tdsp":2,"kind":"edit","documentId":"doc-a1b2c3","update":"AQOJmvSYDwAHAQdjb250ZW50AwlwYXJhZ3JhcGgHAIma9JgPAAYEAIma9JgPAQJIaQA=","due":30000}
```

The Yjs update is 50 bytes and its Base64 text 68; the frame is 142 bytes, the
other 74 being the field names, the kind, the documentId, the promise and JSON
punctuation. [Appendix D](#appendix-d-example-frames) has one frame of each other
kind.

## 5. Document profiles

The engine treats the document's content as opaque: it moves CRDT updates and
state vectors, and asks a small set of questions about them. What the bytes
mean — which CRDT, which document structure, how text is projected for
attribution — is fixed by the document's **profile**.

A profile is named by an id of the form `<name>/<major>`, for example
`yjs-paragraphs/1`, in this grammar:

```abnf
profile-id = name "/" major
name       = name-start *99name-char   ; 1 to 100 characters
name-start = %x61-7A / DIGIT            ; a lowercase letter or a digit
name-char  = name-start / "." / "-"
major      = %x31-39 *5DIGIT            ; 1 to 999999, without a leading zero
```

A value that does not match it is no profile id: where a frame's layout asks for
one it is `invalid-field` ([§4.4](#44-decoding-and-rejection)), and an invitation
that carries one cannot be read (INV-6). The grammar is closed so that one id has
one spelling — `foo/1` and `foo/01` are not two names for one profile — and its
length is bounded. A profile defined outside this specification uses a
reverse-DNS name under a domain its author controls (`com.example.markdown/1`).
An incompatible change to a profile is a new major version, and a new profile id.
This specification defines one profile, `yjs-paragraphs/1`, in
[Appendix A](#appendix-a-profile-yjs-paragraphs1).

### 5.1 What a profile must define

- **PRF-1** · *engine* — A profile MUST define:
  1. an **update** encoding, such that applying a set of updates in any order,
     with duplicates, yields the same state (convergence), and an update whose
     causal predecessors are missing is held rather than rejected;
  2. how to tell that updates are being held for **missing predecessors**, and,
     where the CRDT allows it, whose;
  3. a **state vector** encoding that summarises which updates a replica holds;
  4. how to encode **the updates a state vector lacks** — where the empty state
     vector yields the full state — and how to tell whether a state vector holds
     updates a replica lacks; and the **update that holds nothing**: the full state
     of a replica that holds nothing, which every replica applies without change,
     and which is not empty;
  5. the **initial state** a creator seeds a new document with;
  6. a deterministic **plain-text projection** of the document and the unit its
     offsets count in, for attribution ([§5.4](#54-attribution-overlay));
  7. how an update is **split into pieces** no larger than a given size: each piece
     an update itself, applicable in any order and with duplicates, one that
     arrives before its predecessors held rather than rejected; and which units of
     content it cannot split, with the largest size such a unit may take
     ([§9.4](#94-changes-larger-than-one-message));
  8. a canonical encoding of **what a replica deleted**: the same bytes for the same
     state, whatever the order, grouping or garbage collection of the updates it
     came from, and other bytes when a deletion is missing
     ([§10.3](#103-reports-and-streams), state digests); and the same encoding of
     what it deleted **of the items a given state vector counts**, which within the
     replica's own state vector is the encoding of all it deleted;
  9. how to **read without applying**: to tell, changing no replica, whether bytes
     are exactly one update, and whether they are exactly one state vector — every
     part of it readable, and no byte after it.

  *Rationale:* these are exactly the operations bootstrap, resync, the heartbeat,
  loss detection, attribution and sending a large change use; a CRDT that offers
  them can carry a TDSP document, whatever else it does. Splitting is the
  profile's because only the profile knows where an update can be cut so that each
  part still means something. Reading without applying is what lets a receiver
  check a frame whole before it applies anything of it (FRM-6): a CRDT library may
  apply part of an update before it fails on the rest, and each fails differently.
  A byte after a complete update or state vector would give one meaning two byte
  strings, which libraries that read only as far as they need accept and stricter
  ones refuse.

### 5.2 One profile per document

- **PRF-2** · *application* — The creator's application MUST choose a document's
  profile when it creates the document, and the profile MUST NOT change for the
  life of the document.
  *Rationale:* participants who disagree about what the update bytes mean cannot
  converge; fixing the profile per document removes the question of what happens
  when another one appears halfway through.
- **PRF-3** · *engine* — An engine MUST refuse to create or join a document whose
  profile it does not implement, and MUST tell its application why.
  *Rationale:* the application can then decline the invitation
  ([§6.5](#65-declining-an-invitation)) instead of joining a document it cannot
  read.
- **PRF-4** · *engine* — An engine MUST handle every update, state vector and
  projection of a document by that document's profile alone.
  *Rationale:* frames carry no profile of their own; the document's does not
  change, so a per-message copy would only restate it.
- **PRF-6** · *engine* — A creator's engine MUST refuse restored control state
  (CTL-26) that names a profile other than the one it is given for the document,
  and MUST NOT resume the document then.
  *Rationale:* the creator's snapshot confirms the profile to everyone else
  (CTL-10); a creator resumed under another profile would read the content wrongly
  and announce a profile every participant rejects, without noticing either.

The profile travels in the invitation ([§11](#11-invitations)) and in the
creator's control snapshot ([§7.5](#75-the-control-snapshot)), which lets a joiner
confirm it before trusting any content.

### 5.3 Updates and state vectors

- **PRF-5** · *engine* — An engine MUST apply every accepted update regardless of
  order and MUST tolerate an update whose causal predecessors it does not yet
  hold.
  *Rationale:* the transport has no order ([§3.3](#33-delivery-semantics)). A held
  update is also the first kind of loss evidence ([§10](#10-loss-detection)).

### 5.4 Attribution overlay

Author attribution — which participant wrote which text — is a display feature.
Each engine derives it from the senders of the updates it applies. A resync
response, however, is one delivery from one sender that may carry everyone's
text, so it also carries the responder's attribution as an overlay, in offsets
into the profile's plain-text projection:

```json
{
  "ranges": [
    { "start": 0,  "end": 31, "authorId": "alice" },
    { "start": 31, "end": 58, "authorId": "bob" }
  ],
  "lastEditBySender": { "alice": 31, "bob": 58 }
}
```

`ranges` covers the responder's projection with half-open intervals
`[start, end)`, each naming the MemberId of its text's author, or `null` for text
whose author the responder does not know (ATR-2); `lastEditBySender` maps a
MemberId to the offset just after that member's most recent edit, and has no entry
for unattributed text. `null` in place of the overlay means "no attribution
offered".

The layout is closed: an overlay has exactly `ranges` and `lastEditBySender`; each
range has exactly `start`, `end` (uint32) and `authorId` (a MemberId, 1–255 UTF-8
bytes, or `null`); the first range starts at 0, each further range starts where
the previous one ended, and no range is empty (`end > start`), so the ranges
neither overlap nor leave a gap. Every value of `lastEditBySender` is a uint32,
keyed by a MemberId. An overlay that breaks this rejects the whole frame (FRM-6).

- **ATR-1** · *engine* — When the answer to a request the engine made while it
  held nothing — with the profile's empty state vector — is applied to a document
  whose projection length then equals the total length the overlay's ranges
  describe, the engine SHOULD adopt the overlay's ranges wholesale.
  *Rationale:* at a first join the overlay describes exactly the document the
  joiner has just received. An engine that held content when it asked — a member
  or a creator that restarted with persisted content, say — has attribution of
  its own for it, restored or derived from the frames it applied, which the
  responder's view would overwrite.
- **ATR-2** · *engine* — When the lengths differ, or the answer is to a request
  made while the engine held content — the response healed only part of a gap, or
  it answers a member or a creator that restarted with content —, the engine:
  - MUST NOT adopt ranges wholesale;
  - MUST leave its own and normally received ranges unchanged;
  - MUST leave content it cannot place *unattributed* rather than attribute it to
    the responder.

  Unattributed text is `authorId: null` in an overlay the engine sends and is no
  member's last edit; an engine MUST NOT name a MemberId of its own invention for
  it.
  *Rationale:* the overlay's offsets are into the responder's view, not the
  receiver's; a confident misattribution is worse than none. A MemberId that stands
  for "nobody" is one that another implementation shows as a person, and one a
  real member's id can collide with.
- **ATR-3** · *engine, application* — Attribution MUST NOT be presented or used as
  authentication of authorship.
  *Rationale:* the overlay is the responder's claim about *other people's* text,
  and nothing verifies it; only a delivery's own sender is authenticated, and
  only as far as the messenger is ([§15](#15-security-considerations)).

### 5.5 Profiles defined outside this specification

A frame, an invitation and a snapshot name a profile by its id and nothing else.
That is enough only when everyone who meets the id can find out what it means,
and when what it means reaches an engine the way the engine itself does.

- **PRF-7** · *application* — An application MUST NOT use a profile defined
  outside this specification unless the profile has a public definition at a
  stable location, under terms that let anyone implement it. The definition MUST
  cover every item of PRF-1 and the document's structure, at the level of detail
  of [Appendix A](#appendix-a-profile-yjs-paragraphs1), and MUST come with test
  vectors: updates, the state they yield together, and that state's plain-text
  projection. A published definition MUST NOT change incompatibly; an
  incompatible change is a new major version, and a new profile id.
  *Rationale:* the id is all a peer is told about the content. An id whose meaning
  cannot be looked up is the covert extension point FRM-5 rules out for frames,
  and without test vectors two implementations of one id cannot tell whether
  they agree; if they do not, their documents diverge silently.
- **PRF-8** · *engine, application* — An engine MUST NOT obtain, load or run a
  profile's implementation because a document, an invitation or a frame names it:
  the profiles an engine implements are fixed by its application before it
  creates or joins a document. An application MUST NOT install a profile's
  implementation because an invitation or a document asks for it.
  *Rationale:* otherwise anyone who can send an invitation could make another
  participant run code of their choosing. A profile reaches an application the way
  the application itself does, through its own distribution; a document whose
  profile an engine does not implement is refused (PRF-3) and can be declined
  ([§6.5](#65-declining-an-invitation)).

### 5.6 Layers

A **layer** is data beside a document's content — comments, review notes,
embedded files — that every engine keeps and passes on and that an application
may ignore. A participant whose application does not know a layer still reads and
edits the content; one whose application knows it sees more.

A layer is named by a layer id of the same form as a profile id, `<name>/<major>`
in the grammar of [§5](#5-document-profiles).
A layer defined outside this specification uses a reverse-DNS name under a domain
its author controls (`com.example.comments/1`); this specification defines no
layer. A profile says whether, and where, it admits layers; `yjs-paragraphs/1`
does ([Appendix A](#appendix-a-profile-yjs-paragraphs1)). No frame, invitation or
snapshot announces the layers a document uses: the document's state is the
announcement.

- **LAY-1** · *engine* — An engine MUST keep every layer of a document as part of
  its state and MUST pass it on wherever it passes that state on: in edits, resync
  answers, bootstrap and a resend of the whole state.
  *Rationale:* a layer is part of the state the CRDT converges. An engine that
  rebuilt a document from its content alone would strip the layer for everyone who
  later receives the state from it.
- **LAY-2** · *application* — An application MAY ignore a layer it does not
  implement. It MUST NOT delete, rewrite or strip such a layer, also not when it
  copies, restores or migrates a document — the document itself, under its
  documentId, on another device or in another store —, and SHOULD show the person
  that the document holds data it does not display. A new document created from a
  document's content (§6.2), and an export out of TDSP, are not copies in this
  sense: they MAY leave layers out, and SHOULD tell the person that they do.
  *Rationale:* what one participant cannot read, others still use; removing it
  would be one person's edit of everyone's data. And a person who exports or
  forwards a document should know that it carries more than they see. A new
  document is no one's edit of the old one — its participants start from what its
  creator puts in — and a layer may point into content the new document does not
  hold as the same CRDT items (LAY-4).
- **LAY-3** · *engine* — A layer MUST NOT be part of the plain-text projection and
  MUST NOT change attribution ([§5.4](#54-attribution-overlay)).
  *Rationale:* the projection and the overlay are exchanged between engines whose
  applications implement different layers; counting a layer in either would shift
  every offset between them.
- **LAY-4** · *application* — An application MUST NOT use a layer unless the layer
  has a public definition at a stable location, under terms that let anyone
  implement it, stating its structure, what in the content it points into and how,
  and what a reader shows when that content is gone or has moved. The definition
  MUST come with test vectors and MUST NOT change incompatibly; an incompatible
  change is a new major version, and a new layer id. A layer SHOULD point into the
  content by the CRDT's own relative positions.
  *Rationale:* as for a profile (PRF-7), a peer that implements a layer must be
  able to find out what it means, and two implementations must be able to check
  that they agree. A relative position follows edits to the text it points into;
  where it cannot, the definition says what the reader does instead of guessing.

The creator may give a member a **right on a layer** that differs from the
member's permission on the document: `read` or `write`, as a control operation on
the target `layer:<layer id>:member:<MemberId>` ([§7](#7-control-state)), or
`null` to let the member **inherit** its permission on the document there again. A
member that may only read the content can so be allowed to comment, and one that
may write the content kept from a layer.

- **LAY-5** · *engine* — A member's permission on a layer MUST be:
  - its right on that layer, if the creator set one;
  - otherwise — the creator set none, or set it to inherit (`null`) — its
    permission on the document.

  A member whose permission on the document is revoked (§7.1) MUST have none on any
  layer, also where it holds a right `write` there. The creator's permission is
  `creator` on every layer, and a closed document takes nothing in any layer
  (LIF-6).
  *Rationale:* without an exception every layer follows the document, so a
  document needs no layer right at all, and a member the creator never named
  keeps its unknown permission there too (CTL-13). A right may be wider than the
  permission on the document — commenting on content one may only read — or
  narrower. A layer right is an exception to a member's permission; a member the
  creator removed has no permission left to make an exception to, and a forgotten
  exception must not let it go on writing.
- **LAY-6** · *engine* — An engine MUST refuse to send an `edit` of its own —
  reporting the refusal, not retrying it, as CTL-13 — that changes:
  - a layer on which its permission is explicitly `read`;
  - the content, while its permission on the document is explicitly `read`;
  - anything, while its permission on the document is revoked.

  *Rationale:* as with the permission on the document, receivers do not reject an
  edit for its sender's right on a layer (CTL-7): grant and change are unordered,
  and the rights are as strong as the participants' engines (§15.2). `read` hides
  nothing: whoever is in the channel reads every layer. In `yjs-paragraphs/1` an
  editor re-anchors a layer when it splits a paragraph (Appendix A); a member who
  may write the content and only read the layer cannot, and the layer's definition
  says what a reader shows then (LAY-4).
- **LAY-7** · *engine* — An engine MUST tell what a change touches (LAY-6) from the
  change itself as it makes it, by the parts of the document the profile names
  (YJS-1: `content` is the content, a top-level type named by a layer id is that
  layer, and any other top-level type counts as content, YJS-4). A change that
  touches several parts and may not be sent for one of them MUST be refused whole
  (LAY-6), and an application that holds changes (CTL-42) holds it whole. An engine
  MUST NOT merge, into one message, changes it may send with changes it may not.
  *Rationale:* where `read` takes effect, the sending engine, is the one place
  where every change can be told apart: it knows the transaction, while a
  receiver may hold an update whose predecessors it lacks. An update cannot be cut
  safely by the parts it touches, so a change is sent or held whole.

## 6. Documents and their lifecycle

### 6.1 Identity

- **LIF-1** · *application* — A documentId MUST be generated by the creator from a
  cryptographically secure random source with at least 122 bits of entropy (for
  example a version-4 UUID) and MUST NOT be derived from the document's title or
  content.
  *Rationale:* documents on the same channel are told apart only by their id, so
  a collision merges two documents' routing; and the id is visible to the
  messenger and every channel member, where a title would leak what the
  document is about.
- **LIF-2** · *engine, application* — A document's creator is fixed when the
  document is created, travels to every participant in the invitation, and MUST
  NOT change for the life of the document.
  *Rationale:* every authority check compares a sender against this one identity
  (CTL-5); a transferable creator would need a protocol for agreeing who the
  creator is, which is exactly the consensus TDSP avoids.

### 6.2 Creating a document

The creator's application chooses the document's profile (PRF-2) and a channel
(an existing one, or one the messenger creates for exactly the chosen people),
has its bridge bind the document to the channel, creates an engine with itself as
creator and with that profile, and sends the invitation ([§11](#11-invitations)).

- **LIF-3** · *engine* — On creation the creator's engine SHOULD send the initial
  document state as one `edit` frame, through its send scheduler like every message
  (SND-2).
  *Rationale:* on a messenger that does replay history, participants who were
  already listening then hold the document without a resync; on one that does
  not, the creator's bootstrap answer carries the same state anyway.

### 6.3 Joining a document

A joiner's application reads an invitation, checks that its engine implements the
invitation's profile — and declines the invitation if not
([§6.5](#65-declining-an-invitation)) — has its bridge bind the document to the
named channel (which re-checks that the joiner is really a member of it, BRG-5),
creates an engine with the invitation's creator and profile, and the engine
bootstraps ([§8](#8-bootstrap-and-resync)).

- **LIF-4** · *engine* — An engine MUST NOT be created, for joining, without the
  creator's MemberId.
  *Rationale:* without it no control frame and no resync response can be
  accepted (CTL-5, RSY-12); the engine would silently never converge.
- **LIF-5** · *application* — A creator resuming its own document after a restart
  MUST rejoin it as creator with its persisted control state (CTL-26), and MUST
  NOT create it anew. An application MUST persist that it creates a document — its
  documentId, and that it is the creator — before it creates the engine that sends
  the initial state, and MUST resume a document so marked for which it persisted
  no control state as a device of the creator without control state (CTL-27).
  *Rationale:* creating anew seeds an empty document over real content and
  starts a control state that knows none of the creator's earlier decisions.
  CTL-26 persists operations, and creating a document issues none: an application
  that stopped between the initial state going out and the first state it
  persisted would otherwise not know the document existed, and create it again —
  a second initial state under a new tag. Resumed without control state, the
  device decides at once and is shown unconfirmed until it has a basis (CTL-28).

An application may also persist a document's content and show it at once after a
restart, and any participant's control state (CTL-39); TDSP requires only the
creator's (CTL-26). With a transport that offers `receiveSince` (TRN-18), an application
that persists content SHOULD persist with it the cursor its engine had reached
when the content was taken, so that the restarted engine reads on from there and
learns whether its transport still holds everything since — never a cursor ahead
of the control state it restores with it (CTL-40). With a transport that offers
`instance` (TRN-19), it SHOULD persist with the cursor the instance its engine held
with it: the restarted engine compares it with the transport's at its first read
(LOS-9), so a bridge that may have lost something while the application was gone
shows it, and one that kept everything does not. While its engine holds *history
truncated* evidence (LOS-8, LOS-9), it SHOULD keep the cursor and instance it
persisted last rather than persist new ones: the new instance would read as the
one the cursor was read under, and a restart before the evidence ends would read
on past the loss. The restarted engine
still sends a resync request when it joins (RSY-1); a non-creator edits only once
bootstrapped — after a restart possibly by its own restored control state and its
first read (CTL-41) —, and until then its application prevents typing, or holds
what the person types outside the engine's document (CTL-42); and persisted content can
hold changes that never reached anyone else (SND-8).

### 6.4 Closing a document

Closing marks a document as finished. It is the only lifecycle transition after
creation, and it is a control action ([§7](#7-control-state)).

- **LIF-6** · *engine* — After it has applied a close, an engine MUST NOT send
  `edit` frames of its own, and a device of the creator MUST NOT issue further
  control operations; one it issued before and has not yet sent it still sends
  (CTL-26).
  The engine MUST still apply every valid `edit` frame it receives — an edit sent
  before the close may arrive after it — MUST still send heartbeats, MUST still
  accept a creator's `resync-response` and MUST still answer resync requests as
  [§8](#8-bootstrap-and-resync) prescribes.
  *Rationale:* a close and the edits sent just before it are unordered on the
  transport (TRN-10). Discarding an edit that arrives after the close would leave
  two receivers of the very same messages with different documents for good — one
  saw the edit first, the other the close. A close therefore ends *writing*, not
  *delivery*: the content can still change briefly after it, until the last edits
  sent before it have arrived. A fixed final text would need a cut across every
  sender, which the protocol cannot make without acknowledgements it does not
  have ([§3.3](#33-delivery-semantics)). Heartbeats continue because only a
  heartbeat reveals the loss of the close itself, or of an edit sent just before
  it (LOS-10, LOS-11). An application SHOULD show a closed document as still
  synchronising while its engine suspects a loss
  ([§10](#10-loss-detection)).
- **LIF-7** · *engine* — A close is permanent: nothing — no control frame and no
  control snapshot — reopens a closed document.
  *Rationale:* a reopen would be one more thing a forged or replayed message
  could do; a person who wants to continue creates a new document.

### 6.5 Declining an invitation

A joiner that cannot or will not take part says so in the channel, so that the
other participants' applications — the creator's above all — can at least see it.
The typical case is a profile the joiner's engine does not implement: the creator
can then invite again, with a new document of a profile the joiner implements,
since a document's own profile never changes.

- **DCL-1** · *application* — An application whose engine does not implement an
  invitation's profile SHOULD send a `decline` with the reason
  `unsupported-profile` and the profiles its engine implements. One that cannot
  read an invitation because it is of another version (INV-6) sends nothing in
  reply and SHOULD tell the person that the invitation comes from another version
  of TDSP. A person who does not want to join MAY decline with the reason
  `declined`.
  *Rationale:* without a message nobody learns why a participant never appears;
  with the list of implemented profiles the creator knows what to invite with. A
  `decline` reaches the creator only in a version both engines implement: the
  creator's engine rejects one written in another version (VER-1), and a reader
  cannot learn the document and channel from an invitation of a version it does not
  read. The reason `unsupported-version` stays defined, and a receiver accepts it,
  but this version gives an application no case in which to send it.
- **DCL-2** · *engine* — An engine MUST offer a decline operation that needs no
  join: given the documentId, the decliner's own MemberId and a transport whose
  bridge has the document bound, it sends exactly one `decline` frame — through
  the send scheduler, like every message (SND-2) — and keeps no document state.
  *Rationale:* the typical decliner cannot join, since it cannot read the
  document; a `decline` frame depends on no profile, so any engine can send one.
- **DCL-3** · *engine* — A receiving engine MUST NOT change any state because of a
  `decline`. It MUST report it to its application — sender, reason, profiles and
  text — and MUST report at most one `decline` per sender and document for as
  long as it runs; an application that keeps the declines it showed across a
  restart SHOULD show a sender's again only when its reason or text changed.
  *Rationale:* a decline is information, not authority, and anyone in the channel
  can send one; reporting each sender once keeps a forged or repeated decline
  from flooding what a person sees. An engine keeps no state of a decline (DCL-2),
  so after a restart it cannot know what it reported before; what a person saw is
  the application's to remember.
- **DCL-4** · *application* — An application MUST present a decline's `text` as the
  sender's own words and MUST NOT act on a decline automatically beyond showing
  it.
  *Rationale:* the text is untrusted input from another participant, and what to
  do about a decline — invite again, ignore it — is a person's decision.

The interface between application and engine is, informatively: the application
calls `decline(documentId, memberId, transport, { reason, profiles?, text? })`;
the engine reports each received decline through a notification the application
registers when it creates or joins the document.

There is no deletion. Removing a document from participants' devices cannot be
done by a message, and "prevent future retrieval" presupposes a stored history
the transport contract does not have ([§3.3](#33-delivery-semantics)).

## 7. Control state

*How it works (informative).* Only the creator decides who may edit, whether the
document is closed, and how often anyone sends. Each such decision is a **control
operation** on one **target**: a member, a member's right on a layer, the close or
the pace. The creator may decide from several devices; each device numbers its own
operations 1, 2, 3, … under a random tag of its own, so two devices never compete
for a number. A participant holds a set of operations and computes the control
state from it, as it computes the document from its updates: within the bounds,
in which order the operations arrived, and how often, changes nothing.

- **Which decision holds.** Every operation names what its device had seen of the
  creator's other devices (`seen`). A decision made in knowledge of another
  supersedes it; of two made without knowledge of each other, the narrower holds —
  for a member, revoked before `read` before `write` (§7.3).
- **What is missing.** A device counts without gaps, so a missing number is a lost
  operation, a *hole*. The highest number held without a gap, per device, is the
  **control vector**; requests and the creator's heartbeats carry it, so that a
  participant that lacks an operation can tell, and ask (§7.4).
- **Bounds.** The creator's account can name devices and targets at will, so a
  receiver bounds what it holds, and the creator's devices keep inside those
  bounds — a new target only up to a third of the bytes. A receiver pushed over the
  bytes anyway, or over 64 devices in a target's `seen`, is in a *capacity
  conflict*: it stops writing for good, and a person can continue in a new
  document (§7.4).
- **Bootstrap.** The creator's answer to a request carries its operations as a
  **snapshot**, which a receiver merges as a union; a union can never undo
  anything (§7.5).
- **When devices disagree.** A device restored from a backup can issue a second
  operation under a number it used before: receivers merge the two, and the device
  moves on to a new tag. A new device of the creator decides at once; members tell
  it which numbers exist, never what holds, and what only members hold it shows
  until a person confirms (§7.6).
- **Persisting, and refusing one's own edits.** A device of the creator persists an
  operation before it sends it, or holds its messages until it has (§7.7). An engine refuses to send an edit of its own
  that the control state does not allow, and the application keeps such a change
  out of the engine's document (§7.8).

### 7.1 What control state is

A document's control state is:

- a **membership map** from MemberId to `read` or `write` — who may edit;
- **rights on layers**: for a layer and a MemberId, `read` or `write`, where the
  creator set one that differs from the membership map (LAY-5);
- a **closed** flag;
- the **pace**: the shortest interval, in milliseconds, between two messages any
  participant sends for the document ([§9.1](#91-pacing)); 0 while the creator
  set none.

The creator is never in the membership map: its permission is `creator`, fixed
(LIF-2). A member on whose target a revoking operation holds (CTL-23) is
**revoked**; a MemberId the creator never named has an *unknown* permission.
Revoked is not unknown: CTL-13 refuses a revoked member's edits as it refuses a
reader's, and refuses nothing for an unknown permission after the bootstrap. Both
are absent from the map.

Control state is not a numbered log but a **set of control operations**, each
issued by one device of the creator and aimed at one **target**: `member:<id>`,
`layer:<layer id>:member:<id>`, `close` or `pace`. A layer id holds no colon, so
the first `:member:` after `layer:` ends it. The set is merged the way the
document's content is: the result depends on which operations a participant holds,
not on the order they arrived in, and a duplicate is inert. Every device of the
creator counts its own operations, so two devices never compete for a number, and
a device that lost its state is simply a new device.

- **CTL-1** · *engine* — Control state MUST be changed only by applying control
  operations from `control` frames or a control snapshot as this section
  prescribes.
  *Rationale:* a single path for authority is what makes it checkable.

### 7.2 Operations

- **CTL-20** · *engine* — A control operation MUST carry:
  - `device`, the tag of the creator device that issued it: 16 random bytes in
    base64url without padding, generated once by that device and persisted with its
    control state (CTL-26);
  - `counter`, that device's own count of its operations;
  - `target`;
  - `value`: for a member `"read"`, `"write"` or `null` (revoked); for a layer right
    `"read"`, `"write"` or `null` (inherit, LAY-5); for `close` `true`; for `pace` a
    uint32 of milliseconds;
  - `seen` (CTL-22), which names other creator devices only.

  A `control` frame, or a snapshot's operation, whose `seen` names its own `device`
  with a counter above 0 is malformed and MUST be rejected (FRM-6); an entry of 0
  is absent (FRM-14).
  *Rationale:* a tag per device instead of one counter per document is what lets
  several devices of the creator decide without a conflict; 16 random bytes make
  two devices choosing one tag negligible. A device's own earlier counters are
  implied (CTL-22); an entry for them at or above the operation's own counter
  would make the operation supersede itself, so that it held nowhere, and
  rejecting it keeps every receiver reading it alike.
- **CTL-21** · *engine* — A device of the creator MUST number its operations 1, 2,
  3, … under its tag without gaps, and MUST hold an operation it issues at once —
  as a change of its own that is not yet sent, like typed text (SND-6), not only
  once a send succeeded.
  *Rationale:* receivers see a missing counter as a lost message (LOS-10). An
  operation that holds only after its send succeeds would show the person nothing
  while the messenger is away, and what a device decided is as much its state as
  what it typed.
- **CTL-4** · *engine* — Only the creator MAY send a `control` frame; an operation on
  a member or on a member's right on a layer MUST NOT name the creator and MUST
  NOT carry the permission `creator` (the wire has no value for it).
  *Rationale:* the creator's role is fixed (LIF-2) and cannot be granted,
  transferred or revoked.
- **CTL-5** · *engine* — A receiver MUST apply a control operation if and only if
  (a) the `Delivery.sender` of the frame that carries it is exactly the document's
  creator, and (b) it does not name the creator. The comparison of sender and
  creator is exact equality of MemberIds. Device tags MUST be compared only within
  the creator's MemberId; they authenticate nothing.
  *Rationale:* (a) is the whole membership-integrity design: the messenger vouches
  for the sender, and a tag only tells the creator's own devices apart.
- **CTL-6** · *engine* — A receiver MUST reject — and report — a control frame from
  anyone but the creator, an operation that names the creator, and every control
  frame while it does not know the creator. An operation it already holds is
  inert.
  *Rationale:* a frame from a non-creator is an anomaly worth seeing; a duplicate
  is the expected result of a re-offered message, which the set makes harmless.
- **CTL-7** · *engine* — An engine MUST NOT reject an `edit` frame because its sender
  lacks `write` permission in the receiver's current control state.
  *Rationale:* a grant and the first edit made under it are unordered on the
  transport; rejecting on a grant that has not arrived yet would create a
  permanent gap in the document. Permissions are enforced by the sender's own
  engine (CTL-13), which is what honest participants run (§15.2).

### 7.3 Merging

Of two operations on one target, the later one should win when its device knew
the earlier, and the narrower when neither knew the other: the creator wanted at
most what one of its devices wanted. A Lamport clock orders totally and cannot
tell "concurrent" from "later": with "the higher clock wins", the wider of two
concurrent decisions holds whenever its clock happens to be the higher one. A
version vector per operation tells the two apart, and costs nothing while the
creator uses one device.

- **CTL-22** · *engine* — An operation O **supersedes** an operation P on the same
  target if and only if O's device had seen P when it issued O, or P is an earlier
  operation of O's own device. Every operation MUST carry `seen`: for each other
  creator device, the highest counter its device had seen from it without a gap;
  its own device's earlier counters are implied. A receiver MUST keep, per target,
  the element-wise maximum of what its operations had seen, each one's own
  `counter − 1` included, and MUST treat an operation as superseded exactly when
  that maximum covers its counter.
  *Rationale:* "seen" is what makes a decision a decision about what came before.
  A vector errs to the narrower side only when its device had a hole, and keeps at
  most one operation per creator device and target; naming the superseded
  operations instead would keep every replaced id until the holes heal.
- **CTL-23** · *engine* — The value of a target MUST be the narrowest value among
  the operations on it that no other operation on it supersedes:
  - for a member, revoked before `read` before `write`;
  - for a right on a layer, `read` before inherit (`null`) before `write`;
  - for `pace`, the longest interval.

  `close` holds once any operation sets it and MUST NOT be undone (LIF-7). The
  result MUST depend only on the set of operations held, not on their order or on
  duplicates.
  *Rationale:* a decision made in knowledge of another stands, even when it is
  wider; of two concurrent ones the narrower holds, so no more is granted than one
  of the creator's devices wanted. Concurrent decisions about one member are rare,
  and the creator sees the result. Revoked is the narrowest a member can be, so
  concurrent `read` and revoke give revoked, which CTL-13 refuses. On a layer,
  inherit means the permission on the document, which lies between `read` and
  `write` wherever it lets the member write at all. Ordered so, the narrowest value
  is the narrowest effective right whatever the permission on the document is; and
  a reset to inherit made in knowledge of a restriction supersedes it (CTL-22),
  while one made concurrently loses to it.
- **CTL-24** · *engine* — Two different operations under one `(device, counter)`
  on one target MUST be merged into one, which takes the narrowest of their values
  (CTL-23) and, for each other device, the highest counter either had seen. A
  receiver MUST report as an anomaly an operation that arrives — as a frame or in a
  snapshot — under a device and counter at which it holds another operation as one
  of a target's unsuperseded operations; it MAY forget such a place once nothing
  there is unsuperseded any more. A device of the creator MUST stop issuing under
  its tag, and continue under a new one, when it receives an operation under its
  own tag that is not one it holds as it issued it:
  - a counter above the last it issued;
  - an operation that differs from one it has not yet sent;
  - an operation that collides with one it holds, as above.

  *Rationale:* a device restored from an old backup reuses its tag and counter.
  Merging the two operations means nothing gets stuck and every participant
  agrees; merging them into one means a target holds at most one operation per
  device whatever a restored or broken device sends, which is what bounds a
  snapshot's heads (§7.5). The narrowest value is what keeping both would give. A
  superseded operation under a colliding place changes no value, so noticing
  collisions only where something still holds keeps what a receiver remembers
  bounded by what it holds (CTL-30), and makes a restored state, which holds only
  what a snapshot carries, notice what a live one notices. A device that restarted
  holds only its unsuperseded operations, not every one it sent (CTL-26), so a
  collision with one of those, or a counter it never reached, is what it can
  always tell; a new tag on any of them ends the collision for every later
  decision.

### 7.4 Holes and the control vector

A device's counters are gap-free, so a counter missing below one a participant
holds is a lost operation — a **hole** (LOS-10). The **control vector** is, for
every creator device that ever issued an operation, the highest counter held
without a gap; a device of which no counter is held without a gap — one known only
above a hole — is absent from it, never named with 0 (FRM-14). It is what requests
and the creator's heartbeats carry instead of 1.x's single control sequence
([§8.2](#82-requesting), [§9.3](#93-heartbeat)). The counters a participant holds
above a hole it keeps beside the vector: an operation superseded there is in no
target's heads any more, and only the counters show that it is held, and that the
hole is one (§7.5).

What a receiver holds is bounded (CTL-30), in bytes as CTL-34 measures; what it
keeps at a bound is fixed, so that receivers of the same operations agree
(CTL-35); a close is held whatever the bounds (CTL-36); and a device of the creator
issues nothing a receiver would refuse (CTL-37). A receiver pushed over the bytes
anyway, or over 64 devices in a target's `seen`, is in a capacity conflict (CTL-32).

- **CTL-30** · *engine* — A receiver MUST bound what it holds of control state to:
  - at most 64 creator devices — a device named only in what operations had seen
    (`seen`) is none of them;
  - at most 1 024 counters above a hole per device;
  - at most 5 002 targets of every kind together (5 000 members, the close and the
    pace, say; a right on a layer counts as a target of its own);
  - at most 3 MiB (3 145 728 bytes), measured as CTL-34 says.

  It MUST refuse and report an operation beyond a bound, except as CTL-35 and CTL-36
  say, and MUST NOT let it change the control state. An operation or a snapshot that would bring it over the bytes,
  or a target's `seen` over 64 devices, it MUST refuse as a whole: that is a
  capacity conflict (CTL-32). It MUST NOT refuse, for the bound on counters above a
  hole, the operation that fills the lowest hole of its device: the next counter
  after the highest one it holds without a gap.
  *Rationale:* the creator's account can name device tags and targets at will;
  without bounds a forged or broken creator application could exhaust every
  receiver's memory (§1.7, item 11). A hole wider than 1 024 is evidence enough,
  and a resync fills it. The operation that fills the hole only shrinks what lies
  above it; refusing it would let the bound block its own healing, so that only a
  snapshot could still close the hole. A device named only in `seen` holds no
  operation of its own here; counting it would let one operation push out the
  devices whose operations a receiver holds. A target's `seen` grows with every
  operation's, and devices that see different devices can name more than a
  snapshot carries. Giving up the devices beyond 64 would make what supersedes what
  depend on the order of arrival — an operation dropped as superseded while a
  device was still named would be kept where it arrived after —, so beyond the
  bound a receiver refuses, as beyond the bytes, and the conflict shows it. Honest
  devices name only devices they hold, at most 64; only creator devices beyond 64
  that do not agree on which they hold reach it. 3 MiB, and the close beside it, fit
  the 4 MiB of every binding with room for the rest of the frame — an answer's
  update goes in pieces of its own beside it (SND-17). A target takes about 110
  bytes at the least, so more than 5 002 targets would not fit in what one device
  issues.
- **CTL-34** · *engine* — The bytes of CTL-30 and CTL-37 MUST be measured in the control
  digest's form (LOS-12), without the close: the UTF-8 of the RFC 8785
  serialisation of the object holding exactly the receiver's snapshot's `vector`,
  `targets` and, where it has any, `aboveHoles` (§7.5), without `profile` and
  without extension fields, where:
  - `targets` leaves out `close`;
  - `aboveHoles` leaves out the counter of an operation on `close`;
  - `vector` names a device whose highest counter without a gap is that of its
    operation on `close` with the counter below, and not at all where that is 0.

  *Rationale:* receivers at the bound must agree to the byte. "JSON without
  whitespace" leaves the envelope of the object and the escapes open, and a frame's
  own spelling is the sender's; the digest's form fixes both. The close is left out
  because no bound may keep a document from being closed (CTL-36), and its counter
  with it, so that the close of a device that has only just joined — its first
  counter, a new entry in the vector — adds nothing either; where it fills a hole,
  counters move from `aboveHoles` into the vector, which is shorter. So a receiver
  that took the close as an operation and one that took it in a snapshot, restored
  or as a joiner, measure the same state alike.
- **CTL-35** · *engine* — At the bound on devices or on targets, for operations and
  snapshots alike, a receiver MUST keep the devices and targets whose tags or names
  come first in Unicode code point order — the close and the pace always —, giving
  up others it holds for them, and MUST refuse and report the rest.
  *Rationale:* keeping whatever came first at a bound would make what a receiver
  holds depend on the order of arrival, so that receivers of the same operations
  disagree; keeping the first in a fixed order makes it depend on the operations
  alone (CTL-23).
- **CTL-36** · *engine* — A receiver MUST hold a close, and pass it on, whatever the
  bounds:
  - also when the bound on devices gives up or refuses the device that issued it;
  - also when its device holds as many counters above a hole as the bound allows —
    it then holds the close without its counter;
  - also in a snapshot it refuses for the bytes, of which it then takes the close
    alone.

  Of the operations on `close` it MUST hold each device's latest only, of at most 64
  devices — those whose tags come first in Unicode code point order —, and no
  `seen` for `close`. Whichever it keeps, the document stays closed (LIF-7).
  *Rationale:* nothing undoes a close (LIF-7), so no bound may leave a receiver
  without one it was sent, and none may keep a document from being closed: a full
  document is one that may need closing most, and a reserve of bytes for the close
  would be used up by changes of the targets held and by unions as much. The close
  is bounded by the devices instead, one operation of each, since a device issues
  nothing after it (LIF-6). It is bounded by the devices it keeps a head of, not by
  those that sent one, since a forged or broken creator application can name a new
  device for every close, and a close that kept every head would hold more than
  any snapshot carries. Which heads it keeps changes nothing of what it does, so
  the first 64 in code point order are enough, as at the bound on devices; every
  device a receiver holds that closed is among them — among the first 64 of all
  devices named, it is among the first 64 of those that closed —, so the measure
  without the close stays exact (CTL-34). A close supersedes nothing but its own
  device's earlier close, so it needs no `seen`, which would grow with every device
  that closes.
- **CTL-37** · *engine* — A device of the creator MUST NOT issue:
  - an operation a receiver would refuse under CTL-30 and CTL-35;
  - an operation that adds a target — a member or a right on a layer it does not
    hold, or the first pace — and would bring its control state over 1 MiB
    (1 048 576 bytes), measured as CTL-34 says;
  - the close excepted, an operation after which a `resync-response` carrying its
    control snapshot beside an update that holds nothing would exceed its
    transport's `bounds.maxBytes` (SND-18).

  It MUST refuse the action and tell its application why. An operation on a target
  it holds — a revocation, a change of a right — it issues up to the 3 MiB a
  receiver holds, while there is room; the close always.
  *Rationale:* a control state no answer can carry could no longer bootstrap anyone
  (SND-18), although every operation in it went out; the place to stop it is where
  it would grow — but a document no joiner can bootstrap is still closed for
  everyone who holds it. Two bounds in bytes keep the common case free of conflict:
  devices of the creator that grow apart — up to three, each to 1 MiB of new
  targets and changing little of what they hold — still merge within the 3 MiB a
  receiver holds; more devices, or devices that change much of what they hold, can
  reach the conflict (CTL-32). Changing the rights of a full document is possible
  only while there is room; closing it always is. 1 MiB holds hundreds of members
  even with long ids.
- **CTL-32** · *engine, application* — A receiver that refuses an operation or a
  snapshot of the creator because it would bring its control state over the bytes
  of CTL-30, or a target's `seen` over its 64 devices, is in a **capacity
  conflict**, for good. Its engine MUST report it, and from then on:
  - MUST take no operation on a member or a right on a layer it does not hold — the
    close, the pace and operations on targets it holds it takes as before;
  - MUST refuse every edit of its own as CTL-13 refuses a reader's, on a device of
    the creator too;
  - MUST NOT issue an operation on a member or a right on a layer it does not hold.

  An answer whose snapshot it refused bootstraps nothing (CTL-13); its close it
  holds all the same (CTL-36). An application that persists the control state
  (CTL-26, CTL-39) MUST persist the conflict with it, and MUST show the conflict to
  the person for as long as it lasts; it SHOULD offer to continue in a new document
  created from the content (§6.2).
  *Rationale:* within the bounds a union does not depend on the order of arrival;
  beyond the bytes it does — two receivers of the same operations can hold
  different parts of them, each the first that came. No rule bounds what a receiver
  holds and keeps every decision too; cutting in a fixed order would take rights
  from people without anyone seeing it. So this is no automatic convergence but a
  state a person resolves. A receiver that could not hold a decision of the creator
  may lack one about itself, so it stops writing; every receiver of a union over the
  bytes reaches the conflict, in whatever order the operations arrive, since none
  can hold them all. Taking no new target keeps it from growing into what it
  refused; taking operations on what it holds keeps revocations working. A conflict
  that a restart forgot would let it write again on what it could not hold.

### 7.5 The control snapshot

The creator's `resync-response` carries its control state as the frame's `control`
object. A device answering another device of its own member passes on the control
state it holds in the same layout (RSY-8):

```json
{
  "profile": "yjs-paragraphs/1",
  "vector": { "Ms3dRk0ZyS7cH1qkM8fWNA": 3 },
  "targets": {
    "member:bob":   { "seen": { "Ms3dRk0ZyS7cH1qkM8fWNA": 1 },
                      "heads": [ { "device": "Ms3dRk0ZyS7cH1qkM8fWNA", "counter": 2,
                                   "value": "write", "seen": {} } ] },
    "member:carol": { "seen": { "Ms3dRk0ZyS7cH1qkM8fWNA": 2 },
                      "heads": [ { "device": "Ms3dRk0ZyS7cH1qkM8fWNA", "counter": 3,
                                   "value": "read", "seen": {} } ] }
  }
}
```

The layout is closed for its defined fields (FRM-9):

| Field | Required | Value |
|---|---|---|
| `profile` | yes | A profile id ([§5](#5-document-profiles)) |
| `vector` | yes | The responder's control vector (§7.4) |
| `targets` | yes | An object of at most 5 002 entries, each a target (`member:<MemberId>`, the MemberId 1–255 UTF-8 bytes; `layer:<layer id>:member:<MemberId>`; `close`; `pace`) mapped to an object with exactly `seen` and `heads`; never a member that is the creator, also not on a layer |
| `targets.*.seen` | yes | A control vector of at most 64 devices: the element-wise maximum of what the target's operations had seen (CTL-22); for `close`, empty (CTL-36) |
| `targets.*.heads` | yes | An array of at most 64 operations, the ones on the target nothing supersedes, at most one per device (CTL-24) — for `close`, each device's latest, of the 64 devices first in code point order (CTL-36) —, each with exactly `device`, `counter` (from 1), `value` (one the target can take) and `seen` (not naming its own `device`, CTL-20) |
| `aboveHoles` | no | An object of at most 64 entries, each a device tag mapped to the counters the responder holds of that device above its entry in `vector` (above 0 where the vector names none, FRM-14): 1 to 1 024 of them, ascending without repeats, those of heads among them. Present exactly when the responder holds such a counter |

A snapshot that breaks this layout — a defined field missing or of the wrong
type, a field without `.` that is not listed, a member named twice in the JSON,
the creator among the targets — rejects the whole `resync-response` (FRM-6).

- **CTL-25** · *engine* — A receiver MUST merge a control snapshot with what it
  holds as a union of operations:
  - it keeps every head and everything a target's operations had seen — of the close
    what CTL-36 keeps —, whatever the snapshot's `vector` names;
  - it counts a head above the vector, and every counter in `aboveHoles`, as held
    above a hole (§7.4);
  - it leaves out only what CTL-30 and CTL-35 refuse.

  It MUST apply a snapshot only from the creator, or from another device of its own
  member in an answer to its own request (RSY-12). A snapshot need not be newer
  than what the receiver holds.
  *Rationale:* a snapshot is how a joiner on a history-less transport, or an engine
  that found a hole, learns current state — no other member can forward it,
  because it must come from the creator. A device of one's own member is the
  exception: the messenger authenticates its MemberId like one's own, and whoever
  controls an account controls all of its devices anyway. A union cannot undo
  anything, so 1.x's snapshot floor, and its rule to pass state on only without a
  gap, have nothing left to prevent. Merged so, a snapshot gives what its
  operations applied as frames give, holes included: a joiner it bootstraps holds
  the rights a member that received the same operations holds, and a state
  restored from what it persisted (CTL-26, CTL-39) keeps the holes that keep it
  from bootstrapping itself (CTL-41). A device known only by a head above the
  vector, or only by what an operation had seen, is no device to drop: what it had
  seen is what supersedes an operation that arrives later (CTL-22).
- **CTL-10** · *engine* — A receiver MUST reject a creator's `resync-response`
  whose snapshot names a profile other than the document's — applying none of it,
  update included — and MUST report it to its application.
  *Rationale:* the profile a joiner learned from the invitation is only a claim of
  whoever wrote the invitation; the creator's snapshot is where the creator
  confirms it, and content of a different profile must never be applied.
- **CTL-15** · *engine* — A receiver MUST reject a `resync-response` whose snapshot
  breaks the layout above as a whole, applying neither its update nor any of its
  control state (FRM-6).
  *Rationale:* a snapshot half-applied leaves the receiver in a state the creator
  never had; an honest creator never sends an invalid snapshot, so rejecting it
  loses nothing that a later, valid answer does not bring.

### 7.6 A new device of the creator

Under CTL-22 a device that has seen nothing is concurrent with every earlier
decision: its grant would lose to any older, narrower right, and a creator who
lost every device would lose the creator role with it, although the messenger
still vouches for the account. Members cannot give such a device the control
state — they hold no authority — but they can tell it *what* to supersede. What
it learns so is a **report**: the control vector of a resync request, or the
control state in a member's answer to the device's own request (RSY-8).

- **CTL-28** · *engine* — A device of the creator has a **basis** for its control
  state once it:
  - created the document;
  - restored persisted control state that was a basis when it was persisted
    (CTL-26);
  - merged a snapshot of another of its devices (CTL-25); or
  - applied an operation of the creator that it did not issue.

  Reports and its own new operations are none, before a restart and after it.
  Until it has a basis it MUST answer a joiner with a control snapshot only when it
  decided about that joiner itself, and with `control: null` otherwise, and it MUST
  tell its application that its control state is unconfirmed.
  *Rationale:* on such a device every earlier member looks new. Handing a joiner
  its snapshot would bootstrap a member removed earlier with rights the device
  never knew about; answering without control state leaves the joiner waiting for
  a device that knows (CTL-13), as 1.x's waiting device did, but without making
  everyone else wait.
- **CTL-27** · *engine* — A device of the creator without a basis for its control
  state (CTL-28) MAY issue operations at once. For CTL-22 it MAY count as seen, for
  each other creator device, the highest counter a participant reports — in the
  control vector of a resync request, or of a member's answer to its own request —
  only ever raising what it counts as seen. Once it has a basis it MUST forget what
  it counted so and MUST NOT count reported counters as seen any more, but for the
  explicit confirmation of CTL-33. It MUST NOT take a value from a report into its
  control state: values come only from operations whose sender is the creator
  (CTL-5), read from the channel's history or issued by itself.
  *Rationale:* taking from members only what to supersede, never what holds, lets
  a new device decide at once without giving members authority. A report too low
  makes a result narrower, the direction CTL-23 prefers; a report too high matters
  only when a former creator device comes back and decides concurrently, whose
  decision then counts as superseded. A device with a basis that lags behind a
  member would otherwise supersede decisions it never saw — another device's
  revocation, say — and grant more than any device of the creator decided.
- **CTL-29** · *application* — An application MUST NOT present control state
  reported by anyone but the creator as the creator's decisions; it MAY show it as
  unconfirmed. On a device of the creator without a basis (CTL-28) it MUST NOT
  issue operations the person did not decide — an automatic grant to a newcomer,
  say — while the person's own decisions stay possible at once.
  *Rationale:* a report is a member's word. An application that grants newcomers a
  right by itself sees every earlier member as new on such a device, and a report
  would let its grant supersede an earlier removal; the person deciding knows
  whom they mean.
- **CTL-31** · *engine, application* — A device of the creator MUST compare a
  report (CTL-27) with what it holds, operation by operation under each device and
  counter, and MUST tell its application every place where the report holds an
  operation under a device and counter that the device holds as another operation
  (a *collision*, CTL-24), taking nothing else from the report. Its evidence of a
  member whose control digest differs at an equal control vector (LOS-12) is what
  makes it ask, and a member that holds control state answers a device of the
  creator with its report then (RSY-17). An application SHOULD let the person
  decide such a target again; the new operation supersedes both (CTL-22), and a
  collision only a member's report shows is a divergence of CTL-33.
  *Rationale:* a collision arises where a device of the creator goes on from an
  old state — restored from a backup, or copied to a new computer with its tag —
  and its two copies decide under one counter. Members who see both keep the
  narrower (CTL-24), but the creator's devices may never see the other copy's
  operation, and a member's state is no authority. Where it lies is all a report
  may say; a decision taken again ends it for everyone.
- **CTL-33** · *engine* — A device of the creator MUST make observable to its
  application every **divergence**: for each member's latest report (CTL-27), every
  target on which the report holds an operation that the device neither holds as
  one nothing supersedes nor supersedes by an operation it holds (CTL-22), with the
  member, the value the report gives the target (CTL-23) and the value the device
  gives it, for display only (CTL-29). It MUST offer an action, taken only on a
  person's explicit decision, that issues every diverging target but the close
  again:
  - with the value the person chooses for it — by default the value the device
    gives it, or, where it holds none, `null` for a member or a right on a layer
    and 0 for the pace;
  - counting as seen, for each other creator device, the highest counter of the
    operations the reports hold beyond it there;
  - under a new tag (CTL-24) where one of those operations is under its own tag
    above its counter.

  That action is the only place a device with a basis counts reported counters as
  seen, and still takes no value from a report but one the person chose.
  *Rationale:* automatic is only what a rule merges without a question of
  authority: two operations under one device and counter (CTL-24) and the union of
  snapshots (CTL-25). A decision of a device of the creator that vanished, held only
  by members, is the creator's word as much as any, but the device never saw it:
  deciding the target again supersedes it only when the new value is narrower
  (CTL-23), and otherwise the members keep the old one while the device shows its
  own. Only the person can say which stands; counting the reported counters as seen
  on that explicit decision makes the new one supersede the unknown one everywhere.
  A member's report can name counters that were never issued, as CTL-27 says; the
  person who confirms supersedes whatever lies there, which is what confirming
  means. The close is not issued again, since nothing undoes one (LIF-7); a
  divergence on it stays until the device closes too.
- **CTL-43** · *application* — An application MUST show divergences (CTL-33) to the
  person for as long as they last, and SHOULD offer the action of CTL-33, with the
  held and the reported value of each target to choose from.
  *Rationale:* a divergence ends only by a person's decision, which the person can
  make only when shown what diverges.

### 7.7 Persisting control state

- **CTL-26** · *engine, application* — A device of the creator MUST persist an
  operation it issues *before* it hands the operation to the transport, as part of
  its control state, together with:
  - its tag and its counter;
  - whether it had a basis for its control state (CTL-28);
  - the complete frames of its operations not yet known to be sent.

  It MUST keep each such frame as a pending change until the transport accepts it
  or refuses it for good (SND-6, SND-8). A restarted device MUST restore that state
  and send its pending frames again; what it restores is a basis only if it was one
  when persisted. The device that creates the document MUST persist its control
  state — its tag, counter 0 and its basis — before the start frame goes out,
  though nothing is decided yet. Persisting is not best-effort: when the
  application cannot persist, it MUST report the failure to the engine, and the
  engine MUST NOT issue the operation.
  *Rationale:* a counter that was never persisted with its operation would leave a
  hole nobody can fill, and a creator that forgot its grants hands joiners an
  empty membership map. A pending operation resent after a restart is inert where
  it already arrived. A state persisted by a device without a basis is still one
  without: restored as a basis, it would bootstrap joiners it never decided about
  with rights it never knew (CTL-28). A creator restarted without the state it
  persisted when it created the document would be a device without a basis.
- **CTL-38** · *application* — An application that can persist only asynchronously
  MAY, instead of persisting before the send (CTL-26), hold every message its
  engine sends, of any kind, until the control state the engine reported before it
  is durable; it MUST then tell the person while persisting fails and messages
  wait.
  *Rationale:* holding every message until the state is durable keeps what
  synchronous persisting keeps — nothing leaves the device that a restart would
  forget — where the application's storage only answers later, as a browser's
  does.
- **CTL-39** · *engine, application* — Any other participant MAY persist the control
  state its engine holds, with whether a bootstrap had completed (CTL-13) and
  whether it was in a capacity conflict (CTL-32), and restore it. Its engine then
  shows the rights it holds at once, but takes the restored state as no authority
  — it issues nothing (CTL-1) — and as a bootstrap only as CTL-41 says.
  *Rationale:* a non-creator holds no authority of its own to restore: what it
  restores is the creator's operations as it last held them, and a union cannot
  undo anything (CTL-25), so the creator's later answer only adds to it.
- **CTL-40** · *engine, application* — An engine MUST report every change of its
  control state to its application before it makes observable a cursor (§6.3)
  that reads past the delivery that brought the change. An application that
  restores control state together with content and a cursor MUST restore control
  state at least as new as that cursor: it persists a cursor only once the control
  state its engine reported before reaching it is persisted.
  *Rationale:* a cursor ahead of the control state restored with it would read on
  past a revocation that the restored state does not hold, and the read would not
  show it; the engine cannot tell, since delivery ids are opaque and unordered.

### 7.8 Refusing one's own edits

- **CTL-13** · *engine* — An engine MUST refuse to send an `edit` frame of its own,
  reporting the refusal and not retrying it:
  - when the document is closed;
  - when its own permission is explicitly `read`, on the document or on a layer the
    edit changes (LAY-5, LAY-6);
  - when its own permission on the document is revoked (§7.1);
  - while it is in a capacity conflict (CTL-32);
  - for anyone but the creator, before it is **bootstrapped**: by a
    `resync-response` to one of its own requests, from the creator or from another
    device of its own member, that carries control state it holds (CTL-30,
    CTL-32), or after a restart as CTL-41 says.

  Once bootstrapped, an *unknown* permission MUST NOT cause a refusal; a revoked one
  is not unknown.
  *Rationale:* before its bootstrap a joiner has neither the document's content
  nor its control state: an edit would compete with content it cannot see, and it
  may come from someone the creator has made read-only. For a first join waiting
  costs nothing: only the creator, or another device of the joiner's own member,
  can bootstrap it ([§8.3](#83-who-answers)), and with neither online the joiner
  has nothing to edit. After the bootstrap, refusing on an unknown permission
  would lock out everyone the creator has not named yet, while channel membership
  already decides who can post; a member the creator revoked is not one it has not
  named, and taking it for unknown would let concurrent `read` and revoke end in
  writing, against both intents. Rights stay as strong as the participants'
  engines (§15.2): a member who must not even read has to leave the channel.
- **CTL-41** · *engine* — After a restart, an engine that is not the creator is
  bootstrapped (CTL-13) also by control state of its own restored from an earlier
  bootstrap (CTL-39), once all of these hold:
  - it has read on from the cursor persisted with its content
    ([§6.3](#63-joining-a-document)) through a transport that offers
    `receiveSince`;
  - the answer was not `truncated`;
  - the transport's instance, where it offers one, was the one persisted with the
    cursor (LOS-9);
  - no creator device's counters have a hole (LOS-10).

  *Rationale:* a member that resumes content its application persisted
  ([§6.3](#63-joining-a-document)) does have something to edit, while the creator
  may be offline for hours. A non-creator that restored its control state and read
  on without a gap stands where one that never restarted stands: a revocation it
  has not received takes effect when it arrives, for both, and one that arrived
  meanwhile takes effect before any edit, since the read comes first. Where that
  read cannot rule out a gap — no cursor, a truncated answer, another instance, a
  hole — or nothing was restored, an answer bootstraps it again before it edits:
  without a cursor, overlapping answers prove nothing after a restart (LOS-8).
- **CTL-42** · *application* — While its engine would refuse an edit (CTL-13), an
  application MUST either prevent the person from typing or **hold** every change
  the person makes meanwhile outside the engine's document. An application that
  holds changes:
  1. MUST show the person that held changes are not merged yet, and where they
     are;
  2. MUST NOT apply a held change to the engine's document while the engine
     would refuse the edit, and MUST apply it, as a new local edit, once the
     engine would no longer refuse it;
  3. SHOULD let the person keep held changes outside the document, as a copy for
     instance, or discard them, while the engine refuses because the document is
     closed or the person's own permission is `read` or revoked;
  4. SHOULD tell the person when a held change did not survive the merge;
  5. SHOULD persist held changes locally across a restart.

  *Rationale:* holding lets a person go on while the creator is offline. A change
  the engine refuses stays in its document, so the application has to keep it out
  of there. Every later local change builds on it, which alone would fork the
  person's copy for good; and everything in that document can leave the device —
  not only in the engine's own edits but in its answers to resync requests, which
  carry the responder's state since the requester's (RSY-8), whatever the
  responder's own permission (RSY-10) and even before its own bootstrap: a
  non-creator answers the creator's requests, and a creator that restarts sends
  one (RSY-1, RSY-6). Holding keeps what preventing protects: a held change reaches
  others only after the bootstrap, merged by the CRDT like any concurrent edit, so
  it never competes with content the person cannot see, and a reader's change, or
  one made after a close, never leaves the device. Its cost is that of offline
  editing: the longer a change is held, the likelier it lands in content others
  deleted meanwhile, where the CRDT drops it.

1.x's CTL-2, CTL-3, CTL-8, CTL-9, CTL-11, CTL-12, CTL-14, CTL-16, CTL-17, CTL-18
and CTL-19 are withdrawn ([Appendix G](#appendix-g-changes-from-tdsp-1x)).

## 8. Bootstrap and resync

The CRDT tolerates delay, duplication and reordering completely. It does not
tolerate loss: a missing update leaves every later update from the same sender
pending, silently and permanently. And no transport is required to replay
history, so a joiner cannot catch up by reading old messages. Both problems have
one answer: an engine **asks**, and the creator **answers** with exactly what the
asker lacks.

### 8.1 The sequence

```text
  Bob (joining)          Bob's bridge      messenger     Alice's bridge    Alice (creator)
  1. bind to the channel ─►│
  2. resync-request: control null, empty state vector
     ─────────────────────►├──────────────►├─────────────►├───────────────►│
  3.                                                               only Alice answers
  4. resync-response: full snapshot + control snapshot + attribution overlay
     ◄─────────────────────┤◄──────────────┤◄─────────────┤◄───────────────┤
  5. content, permissions, pace and authorship present — bootstrap complete
```

The same exchange heals an established engine that noticed a gap
([§10](#10-loss-detection)); its request then carries a non-empty state vector
and the answer is a targeted diff.

### 8.2 Requesting

- **RSY-1** · *engine* — A joining engine MUST send a `resync-request` when it
  joins, whatever the transport, and MUST NOT make that conditional on whether the
  transport replays history.
  *Rationale:* a capability flag would create two code paths of which tests
  exercise only one; on a transport with history the request is a cheap
  redundancy, on one without it the only bootstrap that works.
- **RSY-16** · *engine* — A `resync-request` MUST carry:
  - a fresh random 64-bit `requestId`;
  - the requester's control vector (§7.4) and control digest: for anyone but the
    creator `null` until it is bootstrapped (CTL-13), whatever control state it
    holds; for a device of the creator always its own;
  - its current state vector and state digest (LOS-12);
  - its stream and number (LOS-13);
  - `force`: `true` while it holds *history truncated* evidence (LOS-8, LOS-9,
    LOS-19), `false` otherwise.

  A responder MUST treat copies of a request with the same `requestId` as one
  request.
  *Rationale:* the state vector lets the responder send only what is missing; the
  control vector lets it see which operations a requester lacks even when it lacks
  no content. `null` and an empty vector differ: a joiner of a document in which
  the creator never decided anything holds an empty one once answered, and is
  still answered before. A member restarted with the creator's operations it
  persisted holds them without being bootstrapped: with its vector it would get no
  answer when nothing is missing (RSY-17), and after a read that could not rule out
  a gap it would never be bootstrapped; `null` asks for the creator's word. A
  device of the creator decides its own control state, so its vector is what it
  holds. The id is the requester's own, not the messenger's delivery id: a
  requester does not always learn the id its message gets on the receiving side,
  and a duplicated delivery must not be answered twice. `force` is needed because
  after a truncated history the requester cannot tell what it lacks, and a
  responder that sees nothing missing would stay silent.
- **RSY-3** · *engine* — An engine MUST have at most one resync request of its own
  outstanding per document. A further request made while one is outstanding MUST
  be coalesced into it and send nothing, and no request MUST be sent sooner than
  the shortest interval the engine keeps to (SND-15) after its previous message.
  A request the floor holds back waits in the send scheduler, holding the slot,
  and goes out once the floor permits (SND-2); one a person asks for while the
  floor holds MAY be refused instead, and the engine MUST then tell the asker.
  *Rationale:* a request is a broadcast; a second one multiplies the answers on a
  budget where every message counts, and "ask again" is what every trigger — a
  person's click, loss detection, a joiner's retry — would otherwise do at once.
  An automatic request refused at the floor would be spent for nothing, and an
  engine that keeps writing would never get to ask (LOS-6); a person who clicks
  learns at once that it was too soon, where a click that silently waits looks
  like one that did nothing.
- **RSY-4** · *engine* — An outstanding request MUST expire after a bounded time,
  counted from when it was sent, and is then reported as *unanswered*. A request
  whose send failed MUST release the slot immediately without counting against the
  floor, and its outcome is *failed* (SND-10). The expiry SHOULD be derived from
  the engine's floor and expected latency
  ([Appendix B](#appendix-b-recommended-values)).
  *Rationale:* an unanswered request is an ordinary outcome — a responder answers
  only if it has something to give (RSY-17) — and must not block the next one
  forever. A request may wait for the floor before it goes out (RSY-3); counted
  from when it was asked for, its time to be answered would be shortened by that
  wait.
- **RSY-5** · *engine* — While a joining engine has not completed its bootstrap,
  it SHOULD repeat its request when one expires unanswered, with growing waits
  and a bounded number of attempts; it MUST NOT repeat it without bound. The
  automatic requests of a device of the creator on loss evidence (LOS-6) MUST NOT
  depend on its bootstrap: neither on whether it completed nor on whether its own
  attempts ran out.
  *Rationale:* the first request, or its answer, may itself be lost, or the creator
  may have been offline; an unbounded retry would spend the rate budget of a
  participant nobody can answer. A device of the creator edits and answers at
  once, so its evidence matters at once; a peer answers it only when it holds
  something it lacks (RSY-17), so its bootstrap requests may go unanswered for
  good without anything being wrong.

### 8.3 Who answers

- **RSY-6** · *engine* — Who answers whom:
  - The creator MUST answer resync requests from other members.
  - A non-creator MUST NOT answer a resync request unless the requester is the
    creator or its own member.
  - Every engine MUST answer requests from another device of its own member as the
    creator answers other members'.
  - An engine that does not know the creator MUST NOT answer any request.
  - An engine MUST NOT answer its own request, which it recognises by its
    `requestId`, not by its requester.

  *Rationale:* one possible responder makes a join cost exactly one answer instead
  of one per online member, removes every timing-dependent suppression rule, and
  leaves one attribution overlay. The exception exists because a creator may
  restart without the content it had — its application must persist the
  creator's control state (CTL-26) but need not persist content — and, even with
  persisted content, may lack what arrived while it was away; then only a peer
  can give it back. A member may run several devices under one MemberId; one of
  them can bring another up to date while the creator is offline, and only for
  that device's own member.
- **RSY-17** · *engine* — A responder MUST answer a request only if one of these
  holds, and then MUST answer it, even with nothing to add:
  - it holds content the requester's state vector lacks;
  - it would carry a control snapshot (RSY-8) holding operations the requester's
    control vector lacks;
  - the request's state vector holds every update the responder holds itself, and
    the request's state digest differs from its own;
  - it would carry control state, and the request's control vector equals its own
    and its control digest does not (LOS-12);
  - for the creator, and for a device that carries control state to another device
    of its own member: the request's control vector is `null`, or it has
    `force: true`.

  Otherwise a responder MUST stay silent, and MUST keep the request to reconsider
  later (RSY-9), since that may change.
  *Rationale:* an engine that is up to date gets no answer, which keeps resync
  traffic proportional to what is actually missing. A lost membership change
  leaves the content diff empty and still needs healing, which the control vector
  shows; a lost deletion leaves both vectors equal, or the requester ahead with
  insertions of its own, which only the digest shows, and the answer heals it,
  since the state since the requester's state vector carries the responder's whole
  record of deletions. Which of the two lacks something a digest does not tell; the
  other one's evidence makes it ask in turn. A requester ahead differs in digest
  by what it deleted of its own as well, so the answer may bring nothing: one
  message, and its whole answer ends the requester's evidence (LOS-18). A joiner is
  not up to date until it holds a control snapshot, whatever its state vector says:
  one that had seen every edit as it happened would otherwise ask, get no answer,
  and never complete its bootstrap.
- **RSY-8** · *engine* — An answer MUST be a `resync-response` whose `respondsTo`
  is the request's `requestId` and whose update is the responder's state since
  the requester's state vector. What it carries in `control`:
  - the creator's answer MUST carry its control snapshot, except as CTL-28 says for
    a device without a basis;
  - a non-creator answering another device of its own member MUST carry its own
    control state once it has been bootstrapped, and `null` before;
  - a member answering a device of the creator MAY carry the control state it
    holds, which counts there as a report only (CTL-27);
  - every other non-creator answer MUST set `control` to `null`.

  The answer SHOULD carry the responder's attribution overlay.
  *Rationale:* `respondsTo` lets the requester tell its own answer from answers to
  others (RSY-13, ATR-1); only the creator can issue control state. A device may
  pass on what it holds to its own member's other device, since a union cannot
  undo anything (CTL-25); a member's state helps a new device of the creator know
  what to supersede, and nothing more.
- **RSY-18** · *engine* — Every piece of an answer (RSY-8) MUST carry the
  responder's stream and the answer's number in it (LOS-13), and its own number,
  from 1 in the order the pieces are sent. The answer's last piece — the whole
  answer, when it is one — MUST carry the number of pieces, which is its own
  number, and the responder's state vector and state digest as it answered; every
  other piece MUST carry `null` there.
  *Rationale:* the state in the last piece tells the requester what it holds once
  every piece is there, so a piece that never arrives shows (LOS-4), where a
  bootstrap would otherwise look complete with the first piece that carried the
  snapshot; the numbers say it even where the requester already holds more than
  the responder and no state does (LOS-14). Two devices of one member may both
  answer, so a piece names its stream: by `respondsTo` alone their pieces would
  count as one answer.
- **RSY-9** · *engine* — A responder MUST answer at most one request per
  throttle interval per document. It MUST keep every request it may have to
  answer and has not answered — throttled, or with nothing to offer yet (RSY-17) —
  and reconsider it on later processing, independently of whether the request's
  delivery is offered again. A request counts as answered only once the transport
  has accepted the answer:
  - after a send failure that is worth retrying (§3.4) the request MUST be kept as
    before, under the time it was first heard (RSY-19);
  - after a permanent one it MUST be let go.

  A request for which its profile fails to compute an answer MUST be let go and
  reported to the application, and MUST NOT keep it from answering the others.
  *Rationale:* bounds the responder's traffic in the time domain however many
  requests arrive. Keeping the request itself is necessary because an engine
  processes each delivery once (TRN-8): a request skipped under the throttle and
  not kept would never be looked at again, and its requester would stay
  unanswered until its own request expired. A request kept after its answer failed
  would fail again on every later processing, and any member of the channel can
  send one (§1.7, item 11).
- **RSY-19** · *engine* — A responder MUST keep those requests (RSY-9) by their
  `requestId`, at most four per requester — a requester's fifth replaces its
  oldest and keeps the requester's place in the order —, and MUST serve requesters
  in turn: of the requests it keeps, it answers first one of the requester heard
  longest ago that it has not answered since, a requester just answered going to
  the end. It MUST bound what it keeps, by count and by age, dropping the oldest
  first ([Appendix B](#appendix-b-recommended-values)).
  *Rationale:* several devices of one member may each have a request outstanding
  (RSY-3) and are each to be answered (RSY-6); keeping one per requester would let
  them push each other out. Four per requester, and turns, keep a requester that
  repeats itself from pushing others back and from being pushed back itself; the
  bound keeps a flood of requests from growing a responder's memory — a dropped
  requester asks again (RSY-5, LOS-6).
- **RSY-10** · *engine* — A resync answer MUST NOT be refused because the document
  is closed or because the responder's own permission is `read`.
  *Rationale:* a closed document must still bootstrap a joiner (LIF-6); the creator
  is never read-only, and a peer answering the creator is restoring the creator's
  own content — as long as the peer's application keeps every change its engine
  refuses out of the engine's document (CTL-42), since the answer carries
  everything in it.
- **RSY-11** · *engine* — A resync answer MUST go through the send scheduler and wait
  for the floor like every other message (SND-2). A responder SHOULD NOT stop
  processing deliveries while its answer waits.
  *Rationale:* the provider's rate limit counts every message; an answer sent
  outside the scheduler can push the next edit into a refusal. The cost is stated:
  a joiner may wait up to one floor for its bootstrap.

### 8.4 Accepting an answer

- **RSY-12** · *engine* — Which answers an engine accepts:
  - An engine that is not the creator MUST accept a `resync-response` only if its
    sender is the creator, or its own member answering a request the engine itself
    made.
  - The creator MUST accept one from another member only if its `respondsTo` names
    a request the creator itself made.
  - An engine that does not know the creator MUST accept none.

  *Rationale:* the counterpart of RSY-6. Without the `respondsTo` check anyone
  could push content at the creator by sending an unsolicited "response".
- **RSY-13** · *engine* — An engine MUST apply:
  - the update of every accepted `resync-response`, including one that answers
    another member's request;
  - the control snapshot of every `resync-response` the creator sent, and of one
    from another device of its own member answering its own request (CTL-25).

  It MUST consider the attribution overlay only of a response that answers its own
  request (ATR-1, ATR-2), and MUST leave content applied from any other response
  unattributed (ATR-2).
  *Rationale:* content is a CRDT and harmless to apply twice; a snapshot from the
  creator is authoritative whoever asked for it; but an overlay only describes the
  document of the member who asked, and the responder did not write everything
  it sends.
- **RSY-14** · *engine* — An engine MUST consider its bootstrap complete:
  - once it has applied an answer to its own request that bootstraps it (CTL-13) —
    for a device of the creator any answer to its own request;
  - for a device of the creator also at once when it restored persisted content
    together with control state that had a basis (CTL-28).

  It MUST make "not yet bootstrapped" observable to the application.
  *Rationale:* a joiner whose creator is offline sees an empty document; the
  application must be able to say "waiting for the creator" rather than present
  an empty document as the real one. A device of the creator that restored its
  content and a basis holds what an answer would bring it; a peer that holds
  nothing it lacks rightly stays silent (RSY-17), so waiting for an answer would
  leave it unbootstrapped, and asking again, for good.
- **RSY-15** · *engine* — The first overlay an engine adopts for its bootstrap
  stands; a later answer's overlay MUST NOT replace it wholesale.
  *Rationale:* with one possible responder there is nothing to choose between, and
  a second wholesale replacement could overwrite attribution the engine has
  derived since.

## 9. Send scheduling

Real messengers refuse traffic that a naive "send on every typing pause"
policy produces: one measured provider refused after about 35 messages in 20
minutes, and without a retry a refused message is a lost one. The scheduler is one
component of the engine, above every bridge, so no bridge implements any of
it.

### 9.1 Pacing

Five numbers govern when an engine sends — its **pacing**:

| Parameter | Meaning |
|---|---|
| `minIntervalMs` | The floor: no two messages closer than this |
| `maxIntervalMs` | The longest a pending change may wait, counted from its oldest pending edit; no limit if absent |
| `minChars` | Do not send fewer changed characters than this, unless `maxIntervalMs` has passed |
| `maxChars` | Send as soon as the floor permits once this many changed characters are pending; no limit if absent |
| `expectedLatencyMs` | How long a message normally takes to arrive; this engine judges the others' silence by it ([§10](#10-loss-detection)). 0 = unknown |

An engine also has a local **quiet time** (`batchWindowMs` in the reference
implementation): the length of a typing pause after which a pending change may
go out.

Pacing is each participant's own. The one thing the participants share is the
**pace**: the shortest interval anyone sends at, which the creator may set as a
target of the control state ([§7.1](#71-what-control-state-is)). Where a messenger
shows every message in the group's chat, the pace keeps a document quiet for
everyone; where a provider is strict, each participant's own bounds still win.
What receivers need of a sender's pacing travels with each frame that owes a
follow-up: `due`, the time within which the sender will speak again (SND-14).

- **SND-1** · *engine* — An engine MUST make every pacing it runs consistent before
  running it:
  - a negative or non-numeric value falls back to its default, and so does a
    `minIntervalMs`, `minChars` or `expectedLatencyMs` that is not finite — only
    `maxIntervalMs` and `maxChars` may be unlimited;
  - `maxIntervalMs` is raised to at least `minIntervalMs`;
  - `minChars` is treated as 0 while `maxIntervalMs` is unlimited, and is lowered
    to at most `maxChars`.

  *Rationale:* no combination of values may starve a pending change — a change
  smaller than `minChars` with no deadline would otherwise never be sent.
- **SND-15** · *engine* — The creator MAY set the pace. An engine MUST NOT send
  faster than the larger of the pace and its own transport's
  `bounds.minIntervalMs`, and MAY send slower.
  *Rationale:* the pace lets the creator keep a document quiet; the own bounds
  still win, because they are the provider's limit and the creator cannot know
  everyone's provider (§1.7, item 13).
- **SND-16** · *engine* — The pacing an engine runs MUST be the engine's defaults,
  overridden by its transport profile's `pacing`, overridden by what its
  application chose; then made consistent (SND-1), with `minIntervalMs` raised to
  at least the transport's `bounds.minIntervalMs` and to the pace (SND-15). No
  pacing value but the pace is sent to anyone.
  *Rationale:* everything else about pacing concerns only the sender's own
  messages and its own judgement of others' silence; sharing it would need a
  grammar, an ordering and a clamp for every value, for the one thing receivers
  need, which `due` carries.
- **SND-14** · *engine* — Every `edit` and `control` frame MUST carry `due`: the
  milliseconds within which its sender will send another message at the latest,
  or 0 for no promise. A sender MUST set it to its `maxIntervalMs` when that is
  finite, and to 0 otherwise; a sender that announced a `due` above 0 MUST follow
  the frame within it by another frame of the same kind or by a heartbeat
  (SND-11, SND-23): a `resync-request` or `resync-response` keeps no such promise.
  *Rationale:* a receiver judges a sender's silence by what that sender promised
  (LOS-11), not by its own pacing; `due` is relative, so it needs no shared clock
  (LOS-7). The receiver ends the expectation only with a frame of the same source
  or a heartbeat that holds the frame (LOS-16), so that is what keeps the promise.
- **SND-2** · *engine* — Every message an engine sends — of every kind, the initial
  seed and resync answers included — MUST go through its send scheduler, and MUST
  NOT be sent sooner than the effective floor after the engine's previous message
  of any kind, nor while a hold after a refusal lasts (SND-7). This holds for a
  send an application asks for at once too — what is pending, or a last send
  before the engine stops —, which skips only the quiet time and `minChars`, and
  the wait for the person after a `needs-person` refusal (TRN-20).
  *Rationale:* the floor is the provider's rate limit, and the provider counts
  messages, not kinds; a single message that bypasses the scheduler — an explicit
  request to send at once among them — can push the next one into a refusal.
- **SND-20** · *engine* — A message that is not a local edit (a control frame, a
  resync request or answer, the seed) SHOULD go ahead of edits that are waiting.
  Its outcome goes to whoever sent it, and the scheduler does not retry
  it, except a control frame (CTL-26) and a piece of an answer sent in pieces
  (SND-17).
  *Rationale:* a piece is retried because the pieces before it are already out,
  and an answer missing one is incomplete.
- **SND-3** · *engine* — A pending change MUST be sent no later than the first
  moment at which the floor permits after either `maxIntervalMs` has passed since
  its oldest edit or `maxChars` changed characters are pending; otherwise it
  SHOULD be sent once the floor, the quiet time and `minChars` all permit.
  *Rationale:* `maxIntervalMs` closes the debounce's fault that continuous typing
  never sends; the floor closes its other fault, one message per pause.
- **SND-5** · *engine* — Changed characters MUST be counted from local edits only,
  never from applying remote updates.
  *Rationale:* a remote edit arriving must not make a local change look large
  enough to send early.

### 9.2 Keeping and retrying a refused send

- **SND-6** · *engine* — An engine MUST keep a pending change until a send of it has
  succeeded, and MUST merge later edits into it while it waits.
  *Rationale:* one lost update blinds every receiver to everything its author sends
  afterwards (PRF-5). CRDT updates merge and are idempotent, so resending a change
  that did in fact arrive is harmless.
- **SND-7** · *engine* — A send that failed with `rate-limited` or `unavailable`
  MUST be retried after an exponential back-off that is bounded and reset by a
  success, and MUST NOT be retried before a messenger-stated `retryAfterMs` has
  passed (up to a bounded maximum). A retry MUST wait for the floor and the
  back-off only, not for the quiet time or `minChars` again. Such a failure of any
  message — one the scheduler retries or not, a request, an answer, a heartbeat —
  MUST hold back the engine's next send of any kind for the back-off, or for what
  the messenger asked if that is longer.
  *Rationale:* the batch was already judged ready once; waiting for a new typing
  pause would delay it by up to the quiet time for nothing. A provider throttles
  the account, not one message: the next message of another kind would only run
  into the same refusal.
- **SND-8** · *engine* — A send that failed with `too-large` or `rejected`, and a
  change the engine itself refuses to send (CTL-13), MUST be dropped and reported
  to the application exactly once. Dropping ends the send job only: the change
  stays in the sender's document, and every later change builds on it. The engine
  MUST therefore expose that it holds *undistributed changes* until the transport
  has accepted its whole state (`resync()`) — every piece of it, when it is split —
  and nothing has been dropped since. A piece of that state refused for good keeps
  the mark; a dropped message that carries no change of the sender's own — a resync
  answer, a request, a heartbeat — MUST NOT set it.
  *Rationale:* retrying cannot help, and a change that is dropped silently is the
  failure this section exists to prevent. The CRDT cannot take a change back, so
  the author's copy diverges: receivers hold everything the author sends later as
  a pending gap no resync from the creator can fill, since only the author has
  the missing change. Sending the whole state once the cause is fixed — the
  permission restored, a smaller document, a working profile — heals it, because
  a full-state update depends on nothing before it. An answer that does not go out
  leaves its requester as it was, which asks again (RSY-5, LOS-6); nothing of the
  responder's own is missing anywhere.
- **SND-21** · *application* — While the engine exposes undistributed changes
  (SND-8), the application MUST show that the document holds them, MUST offer to
  send the whole state again, and MUST NOT show the document as synchronised. An
  application that keeps a document across restarts MUST keep the undistributed
  mark with it.
  *Rationale:* an application that merely avoids the word "synchronised" says
  nothing; the person has to learn that a change of theirs did not go out, and be
  able to send it once the cause is gone.
- **SND-22** · *engine* — A `too-large` refusal of a message within the `maxBytes`
  the transport's own profile declared MUST be reported, in addition to its report
  under SND-8, as a fault of the transport profile or its binding.
  *Rationale:* a refusal the profile said could not happen is not the sender's
  fault and must not look like it.
- **SND-9** · *engine* — After a `rate-limited` failure of a message of any kind an
  engine SHOULD widen the spacing between its later sends of every kind, and SHOULD
  relax it again after a run of successful sends.
  *Rationale:* a refusal is evidence that the current pace is too fast for this
  provider, whatever the pacing says.
- **SND-10** · *engine* — An engine MUST expose to the application whether it is
  idle, waiting for its send window, or retrying (with the failure count, the time
  of the next attempt and the last failure), and MUST report a failure as an error
  only when SND-8 drops a message. A resync request whose send fails is no error:
  it releases its slot (RSY-4), and its outcome, *failed*, MUST be observable until
  the engine's next request. A heartbeat whose send fails is neither retried nor
  reported (SND-12).
  *Rationale:* a change being retried is not yet lost; showing a sticky error for it
  teaches people to ignore errors. A request carries nothing of the engine's own,
  but a request that never goes out leaves a joiner waiting for the creator for
  ever: its outcome lets the application say so.

### 9.3 Heartbeat

A lost *final* message leaves no gap for anyone to see: nothing later from the
same sender is pending behind it. The heartbeat closes that hole.

- **SND-11** · *engine* — When its pacing has a finite `maxIntervalMs`, an engine
  owes one `heartbeat` once it:
  - has sent an `edit` (a piece of one included), a `control` frame or a
    `resync-response` in pieces;
  - or applied an answer — to its own request or to another's — which changed what
    it holds.

  A `resync-request` or a whole `resync-response` MUST NOT by itself make a
  heartbeat owed. A heartbeat carries its sender's state vector and state digest
  and, from a device of the creator, its control vector and control digest
  (otherwise `null`), and its stream and number (LOS-13).
  *Rationale:* one heartbeat after the last message is enough to reveal a lost
  final message (LOS-4, LOS-10) and costs one message per burst of activity; a
  repeating heartbeat would spend the rate budget of an idle document. After an
  answer that healed it, it tells the others the new state, so that what their
  evidence showed of the old one ends (LOS-12, LOS-18): its last report would
  otherwise stand for it, older than what it holds.
- **SND-23** · *engine* — An engine MUST send a heartbeat it owes by SND-11
  `maxIntervalMs` after the earlier of its last `edit` and its last `control` frame
  since its previous heartbeat — when it sent neither, after the last other
  message or answer that owes one —, and not inside the floor. For every heartbeat
  it owes (SND-11, SND-24):
  - a `resync-request` or a whole `resync-response` MUST NOT delay it: one that
    would push the heartbeat past its time goes after it;
  - the engine MUST NOT send another until something owes one again, and MUST NOT
    send one while a change is pending or being retried;
  - a close does not cancel a heartbeat that is owed (LIF-6).

  *Rationale:* the heartbeat is what a sender's `due` promises when nothing else
  follows (SND-14, LOS-11), so it counts from what promised: a request or an
  answer keeps no promise, and an `edit` and a `control` frame are two sources to
  a receiver, so a later one of one kind does not keep the other's. Counted from
  the last message of any kind, an answer to a joiner just after an edit would
  push the heartbeat past the edit's `due`, and every other participant would
  suspect the sender.
- **SND-24** · *engine* — An engine that hears a `resync-request` stating exactly
  its own state vector and state digest, while what it deleted within the state
  vector of its latest report (LOS-13) differs from what that report stated, owes
  a heartbeat that it MUST send as soon as the floor permits, whatever its
  `maxIntervalMs`; SND-23 applies to it otherwise.
  *Rationale:* without it, a report that crossed another's deletion, which the
  engine then received by an ordinary edit, would stand for the engine though older
  than what it holds: at everyone who holds that deletion it shows a difference in
  digests (LOS-12), and none of them can end it — nobody has anything to give them,
  so their requests go unanswered.
  A request that states what the engine holds is the sign that someone asks in
  vain, and only a newer report of that stream ends what it asks about.
- **SND-12** · *engine* — A heartbeat MUST count against the floor and MUST NOT be
  retried if its send fails.
  *Rationale:* a lost heartbeat is itself caught by the silence rule (LOS-11); a
  retried one would only compete with real changes.
- **SND-13** · *engine* — A heartbeat MUST NOT be applied as document content and
  MUST NOT change control state.
  *Rationale:* it is evidence, not authority, and it is accepted from any member.

### 9.4 Changes larger than one message

When the transport states `bounds.maxBytes`, no frame larger than that may be
sent. A change that does not fit travels as several messages:

- *Spreading* sends several pending updates as a sequence of merged prefixes, one
  per message, each the longest prefix whose frame still fits.
- *Splitting* is for a single update that does not fit by itself — one large
  paste, or the state a resync answer carries: the profile splits it into
  **pieces** (PRF-1, item 7), and each piece is an `edit`, or a `resync-response`
  to the same request.

Either way every message is a valid update the receiver applies as it arrives: a
piece that arrives before its predecessors is held by the CRDT like any update,
and a lost piece is an ordinary pending gap (LOS-2) that a resync heals. There is
no reassembly and no buffer of incomplete sets; 1.x's `fragment` kind, whose
frame was usable only once its last slice arrived, is gone.

`bounds.maxBytes` already includes whatever the bridge can carry beyond an
ordinary message body: where a messenger binding sends a large frame as an
attachment ([bindings/](bindings/)), the transport profile states the attachment's
limit, and the engine never needs to know how a frame of a given size travels.

- **SND-17** · *engine* — An engine MUST NOT send a frame larger than the transport's
  `bounds.maxBytes`:
  - it MUST spread a pending change over several messages when that suffices;
  - it MUST otherwise send an update as several frames of one piece each: several
    `edit` frames, or several `resync-response` frames with the same `respondsTo`.

  It MUST send the pieces of one update in order and ahead of any edit made after
  it, paced by the floor, and MUST NOT make them wait for a typing pause. A piece
  refused for good (SND-8) MUST drop the pieces of its update still to go.
  *Rationale:* a piece is useful on its own, so nothing waits for the last one; a
  later edit builds on the split change, and sent first it would arrive first and
  look like a gap to every receiver. The pieces after one that never goes out build
  on it, so a receiver would only hold them back as a gap; the change goes again
  whole (SND-8), and a requester missing a piece asks again (LOS-14).
- **SND-18** · *engine* — When a resync answer is split, its control snapshot and
  attribution overlay MUST travel in the last piece, or, when they do not fit
  beside it, in one more `resync-response` whose update holds nothing (PRF-1,
  item 4); when both do not fit there, the overlay is left out. A control
  snapshot that does not fit even alone makes the answer fail (SND-8); CTL-37
  keeps a device of the creator from issuing an operation after which it would
  not fit.
  *Rationale:* the requester's bootstrap completes with the snapshot (CTL-13), so
  it should come once the content it describes is on its way; attribution is
  display only (ATR-3) and yields first.
- **SND-19** · *application, engine* — An application MUST write content so that no
  single unit the document's profile cannot split exceeds the size the profile
  names for it (PRF-1, item 7). An engine MUST refuse an update it cannot split to
  fit as `too-large`, and report it (SND-8), as it MUST when not even one useful
  piece fits beside a frame's other fields.
  *Rationale:* without a reassembly, a unit larger than one message could not travel
  at all; requiring applications to write large content in pieces keeps large
  changes possible (§1.7, item 8) without a frame kind of its own. For
  `yjs-paragraphs/1` only content of length one — an embed, a binary — is such a
  unit, and a profile says how large it may be (Appendix A).

1.x's SND-4 and FRG-1 to FRG-8 are withdrawn
([Appendix G](#appendix-g-changes-from-tdsp-1x)).

## 10. Loss detection

*How it works (informative).* A receiver often holds what it needs to notice that
a message did not reach it. Loss detection makes that available as **evidence**,
never as a claim: every piece of evidence can have an innocent cause, such as a
message that is only late, or a participant who closed the application. The
converse holds too: no evidence is no claim of completeness, since a loss can
leave no trace an engine can see (§10.6).

- **What follows from evidence** (§10.1). Evidence is reported once it has
  persisted for a waiting time — a truncated history at once —, judged by when the
  receiver heard a message, and answered by a bounded number of resync requests.
- **What a receiver can see missing** (§10.2). An update whose predecessors it
  lacks (*pending gap*); a sender who promised a follow-up and sent none
  (*silence*); a report of updates it has not applied; a missing counter of a
  device of the creator.
- **Reports and streams** (§10.3). A heartbeat, a request and an answer's last
  piece each state their sender's state, its vectors and digests: they are
  *reports*. An engine numbers its reports in a *stream* that it begins anew each
  time it starts, so a receiver keeps the latest report of each stream and never
  takes one device of a member for another. Digests show what vectors cannot: a
  lost deletion (*diverged*), or two operations under one counter.
- **A history the bridge cut short** (§10.4). A bridge keeps a bounded window.
  When an engine's reads no longer overlap, or the bridge says that it truncated
  or restarted, the engine holds *history truncated* evidence and asks for a
  resync at once.
- **Answers in pieces** (§10.5). An answer to a request arrives in numbered
  pieces; one with a piece missing is *answer incomplete*.

### 10.1 Evidence, not claims

- **LOS-1** · *engine* — An engine MUST NOT report a message as lost; it MAY report
  evidence that something is missing. It MUST NOT report any evidence before it
  has persisted for a *waiting time* derived from its pacing's
  `expectedLatencyMs` ([Appendix B](#appendix-b-recommended-values)), except
  *history truncated* evidence (LOS-19).
  *Rationale:* a message that is merely late produces exactly the same evidence for
  a while; reporting it immediately would cry wolf on every slow network.
- **LOS-15** · *engine, application* — An engine MUST NOT expose the absence of
  evidence as "synchronised" or "complete", and an application MUST NOT present it
  so. The most an application may say is that nothing currently suggests a loss —
  and not that either while the outcome of the engine's last request is
  *unanswered* where LOS-20 ended the creator's evidence so: then it may only say
  that nobody it could ask had anything to give.
  *Rationale:* a loss can leave no trace an engine can see (§10.6), so no evidence
  is not completeness.
- **LOS-7** · *engine* — Loss evidence MUST be based on the time the receiver heard
  a message, not on the sender's clock.
  *Rationale:* clocks of different participants are not synchronised, and the
  missing edit may still be in flight behind a heartbeat that just arrived.
- **LOS-6** · *engine* — An engine SHOULD answer evidence by a resync request through
  its single request slot (RSY-3), automatically:
  - only after a conservative multiple of the waiting time;
  - with a bounded number of attempts per episode, and growing waits between them;
  - never while a request of its own is already outstanding.

  The application MAY switch the automatic request off.
  *Rationale:* asking costs messages against the same rate budget as editing;
  unbounded automatic requests would turn a noisy network into a traffic storm.

### 10.2 What a receiver can see missing

- **LOS-2** · *engine* — An engine MUST treat as evidence an update held pending
  because its causal predecessors are missing (a *pending gap*). A deletion of
  items the engine does not hold, which the CRDT holds back until they arrive
  (PRF-1, item 2), is one. The engine SHOULD name the member it is waiting for
  when it can tell.
  *Rationale:* this is the direct signature of a lost message in the middle of a
  sender's stream. A held deletion is one too: the insertion it deletes was lost,
  or is late.
- **LOS-11** · *engine* — A frame with `due` above 0 sets up an *expectation*: a
  further frame of its source, or a heartbeat that holds it (LOS-16), within the
  larger of that `due` and the pace (SND-15), measured from when the engine heard
  the frame. An engine
  MUST treat as evidence (*silence*) an expectation that nothing ended (LOS-16)
  within that time plus the waiting time LOS-1 derives from the engine's own
  `expectedLatencyMs`. The waiting time counts once, so the evidence is reported as
  soon as that has passed.
  - A `resync-request` or a `resync-response` MUST NOT set up an expectation, and a
    frame with `due` 0 sets up none.
  - Frames of the engine's own member count like anyone's, except its own coming
    back: an `edit` whose updates come only from the engine's own CRDT client, and
    a `control` frame under its own device tag.

  *Rationale:* after an edit, a follow-up is due by what its sender promised
  (SND-14); its absence is the only sign of a lost final message when the
  heartbeat itself was lost too. Judging by the sender's own promise, not by the
  receiver's pacing, is what lets pacing be each participant's own. The pace is a
  floor for everyone, though: a sender that learned a longer pace after it
  announced its `due` can no longer keep the shorter promise, and must not look
  silent for it. A receiver that counted a resync request as an edit would suspect
  every joiner of going quiet and ask for a resync itself — in a small group, more
  than a dozen messages for one join without a single edit. Another device of the
  engine's own member is a sender like any other, whose losses this device must
  notice too; a transport need not tell a sender the id its message is delivered
  under (RSY-16), so an engine may see its own frames again, and their content
  tells them apart.
- **LOS-16** · *engine* — An expectation (LOS-11) MUST end by each of these, for
  the frames named and for no other:
  - a heartbeat, for the frames it holds: an `edit` whose update its state vector
    holds (PRF-1, item 3), a `control` frame whose counter its control vector
    reaches;
  - a further frame, for the earlier frames of its own source: an `edit` for those
    whose updates come from the same CRDT clients, a `control` frame for those
    under its device tag;
  - an applied answer to the engine's own resync request, for every frame.

  *Rationale:* a member may write from several devices: a heartbeat that crossed
  another device's edit, or that device's next edit, says nothing about whether the
  device that wrote the first one fell silent; what a heartbeat holds, and where a
  frame comes from, does.
- **LOS-4** · *engine* — An engine MUST treat as evidence a report (LOS-13) — a
  heartbeat, a request or an answer's last piece (RSY-18) — whose state vector
  contains updates it has not applied, judged against its current document so
  that the evidence disappears when those updates arrive. It MUST judge the latest
  report of each of a member's streams (LOS-17), not only the member's latest, and
  the reports of its own member like anyone's.
  *Rationale:* it is the only direct evidence of a lost *final* message. A member
  may write from several devices: the report of one that never saw a change must
  not hide the report of the one that made it. And another device of one's own
  member is where a change this device missed shows. A request states what its
  sender holds as a heartbeat does.
- **LOS-10** · *engine* — An engine MUST treat as evidence a hole in a creator
  device's counter (§7.4), and a heartbeat from the creator whose control vector
  holds an entry above its own.
  *Rationale:* operations come only from the creator's devices, each counting
  without gaps, so a missing counter is a missing decision; the heartbeat makes
  even the last operation's loss visible. A heartbeat from a creator device that
  knows less is no evidence: a vector compares per device, so a lagging device
  shows only lower entries.

### 10.3 Reports and streams

- **LOS-13** · *engine* — An engine MUST choose a random stream tag (§4.3) each
  time it starts, and MUST number every heartbeat, request and answer it sends in
  that stream, from 1, each one higher than every earlier one:
  - a heartbeat and a request when it writes them;
  - an answer when it takes the state it answers from, every piece of that answer
    with the same number (RSY-18).

  A *report* is a heartbeat, a request or an answer's last piece — of an answer
  the engine does not accept (RSY-12) too, of which it applies nothing —: its
  sender's state, at that number.
  *Rationale:* a member may run several devices under one MemberId, and a later
  message of one says nothing about another's state. Within one stream the state
  only grows, so a newer report says at least what an older one did, and its
  number orders the two however the messenger delivered them. What a stream
  reveals is how many engines a member runs and when one starts.
- **LOS-17** · *engine* — An engine MUST keep the latest report of each of a
  member's streams — at least four streams per member, dropping the one it heard
  from least recently first ([Appendix B](#appendix-b-recommended-values)) —, MUST
  let a report replace only one of the same stream with a lower number, and MUST
  NOT take a report of its own stream as anyone's.
  *Rationale:* kept by member, the report of a device that lags behind would
  replace that of the device that deleted, and valid evidence would vanish. An older report
  offered again changes nothing.
- **LOS-18** · *engine* — What a stream's report shows (LOS-4, LOS-12, LOS-14) MUST
  end only:
  - when the engine's state no longer gives it, judged against its current state;
  - when a newer report of that stream shows nothing;
  - or when the engine has applied, whole (LOS-14), an answer of that stream to its
    own request: it then holds what that answer's last piece states, and neither
    that report nor a later one of the stream stating the same state is evidence of
    a difference in digests.

  A stream that falls silent is a sender that falls silent (§10.6): no time alone
  ends what its last report shows.
  *Rationale:* a whole answer is the one way a receiver knows it holds a sender's
  state although its own digest differs — by deletions of its own the sender had
  not seen — so it ends that false alarm without a second request.

**State digests.** A state vector counts what a sender inserted, not what it
deleted, and a control vector counts operations, not what they say. A lost update
that only deleted, or two different operations under one device and counter
(CTL-24), leave every vector equal. So heartbeats, requests and an answer's last
piece carry digests beside their vectors (LOS-12):

- a **digest** is the first 8 bytes of SHA-256 (FIPS 180-4), written as 16
  lowercase hex digits;
- the *state digest* is that of the profile's encoding of what the sender deleted
  (PRF-1, item 8);
- the *control digest* is that of the sender's control snapshot's `vector` and
  `targets` (§7.5) — not its `aboveHoles`, a hole being evidence of its own
  (LOS-10) —, every target's `heads` in order of `device` and then `counter`, no
  control vector in it with an entry of 0 (FRM-14), canonicalized by RFC 8785
  (JSON Canonicalization Scheme) and encoded as UTF-8.

A receiver that holds every insertion a sender's vector counts compares the
sender's state digest with that of what it deleted itself of those items, its own
control digest with the sender's at equal control vectors. Different digests are
evidence (LOS-12), a responder that sees them has something to offer (RSY-17), and
a device of the creator learns where two participants hold different operations
(CTL-31). While one participant lacks an insertion the other counts, the vectors
show that first, and the digests are compared once it has arrived.

- **LOS-12** · *engine* — An engine MUST treat as evidence:
  - (*diverged*) a report (LOS-13) whose state vector its own holds — every update it counts,
    the vectors equal or the engine's ahead — and whose state digest differs from
    the digest of what the engine deleted of the items that state vector counts
    (PRF-1, item 8). It is judged first when the engine can compare the two: as it
    hears the report, or once it holds every update the report's vector counts. A
    report that did not differ then is no such evidence.
  - a creator device's heartbeat or request whose control vector equals the
    engine's own and whose control digest does not — on a device of the creator, a
    member's request too (CTL-31).

  It MUST judge either against its current state, so that it disappears once the
  digests agree, and wait for it as LOS-1 says. A report the engine holds by a
  whole answer is no such evidence (LOS-18).
  *Rationale:* a vector counts what was inserted, or which operations were issued;
  a lost deletion, or two different operations under one device and counter
  (CTL-24), leave it equal. The digest is what differs then. A sender cannot have
  deleted what it never held, so a receiver that holds more compares only what the
  sender's vector counts: a lost deletion then shows although the receiver has
  edited since, where comparing at equal vectors only would wait for the vectors
  to meet, which nothing promises. While the receiver lacks an insertion the sender
  counts, the vectors show that first (LOS-4). The report is judged once: what the
  receiver deletes after that — the sender's own later edits among it — says
  nothing of what the sender held, and judged anew it would raise an alarm after
  every edit that deletes. A deletion of the receiver's own within that vector,
  which the sender had not yet received when it reported, makes the digests differ
  as well: a false alarm, which one whole answer of that stream ends, or its next
  report, which a request stating what it holds brings at once (SND-24).

### 10.4 A history the bridge cut short

- **LOS-8** · *engine* — An engine whose transport does not offer `receiveSince`
  MUST treat as evidence (*history truncated*):
  - a `receive` answer that shares no delivery with the previous non-empty answer
    it processed — everything it had seen has left the bridge's window, so
    deliveries may have come and gone unseen in between;
  - the first `receive` answer after one that failed.

  *Rationale:* a bounded window (BRG-17) can drop an edit *and* the heartbeat that
  follows it before an engine reads again; the engine then sees no pending gap, no
  silence (it never heard the edit) and no newer state vector, so LOS-2, LOS-4,
  LOS-10 and LOS-11 stay quiet while the document has diverged. The one thing the
  engine can still see is that the window moved past everything it knew. Overlap
  proves nothing after a bridge restart, though: a restarted bridge may offer old
  deliveries again (BRG-17), and one it offers again can overlap the previous
  answer while newer ones were lost. A restart is visible to an engine that polls
  as a failed `receive`, so that is evidence too; so is a bridge that could not
  reach its messenger, which costs one answered request when nothing was lost.
- **LOS-9** · *engine* — Where the transport can say what it lost:
  - An engine whose transport offers `receiveSince` MUST read through it, with the
    last `DeliveryId` of the latest answer that held one as the cursor (TRN-18,
    TRN-21). It MUST treat an answer with `truncated: true` as *history truncated*
    evidence, and MUST NOT apply LOS-8's comparison of answers then.
  - An engine whose transport offers `instance` (TRN-19), with or without
    `receiveSince`, MUST treat as such evidence too an `instance` other than the
    one that answered its previous read — after a restart, other than the one its
    application restored with the cursor (§6.3), where it restored one.

  Either is evidence on its own.
  *Rationale:* where the bridge can say that something slid out unseen, or that it
  restarted, the engine needs no guess: LOS-8's overlap heuristic, its "first
  answer after a failed one" case and its cost of a needless request after every
  outage go, and a restart between two polls becomes visible. A bridge may offer
  the instance without the cursor; its restart is evidence all the same. Restored
  with the cursor, the instance carries this across the engine's own restart: a
  bridge that lost something meanwhile has another epoch, one that kept its window
  the same. Read after the deliveries, it also shows what a bridge gave up while it
  answered them — an event of its messenger it read for this answer and could not
  enter — at this read, not one later, when a restored member would already have
  bootstrapped from its own state.
- **LOS-19** · *engine* — Unlike every other evidence of this section, *history
  truncated* evidence (LOS-8, LOS-9) needs no waiting time. An engine SHOULD answer
  it by a resync request with `force: true` (RSY-16) as soon as its request slot is
  free, and MUST report it as "not safely synchronised", never as "synchronised",
  until it has applied an answer to its own request that bootstraps it (CTL-13,
  RSY-14) — for a device of the creator any answer, for anyone else one with
  control state it takes (RSY-13) —, or, on a device of the creator, as LOS-20
  says.
  *Rationale:* the request forces an answer (`force: true`) because only an
  answer can end the evidence: an engine that lacks nothing would otherwise get
  none and warn for ever. For anyone but the creator that answer must carry control
  state: the window may have dropped a control operation, which an answer of
  content alone does not bring back. The rule does not promise healing: with the
  creator offline the request goes unanswered and the evidence stays.
- **LOS-20** · *engine, application* — For the creator, *history truncated*
  evidence also ends when a request it made after the evidence expired unanswered.
  What remains is the request's outcome, *unanswered* (RSY-4), which the engine
  MUST keep observable until its next request; an application SHOULD show it, and
  MUST NOT say then that nothing suggests a loss (LOS-15). The creator's copy may
  still lack a change of a member who is offline, until that member sends again
  (LOS-2, LOS-4, LOS-11) or answers a later request.
  *Rationale:* a peer answers the creator only when it holds content the creator
  lacks (RSY-6, RSY-17), so silence means nothing to recover, or nobody online to
  recover it from — and the engine cannot tell which.

### 10.5 Answers in pieces

- **LOS-14** · *engine* — An answer with every piece, up to the number its last one
  names, is *whole*. An engine MUST count, by stream and number (LOS-13), the
  pieces of each answer to its own request it applies; a piece MUST count once by
  its number, however often it arrives. It MUST treat as evidence (*answer
  incomplete*) an answer of which a piece is missing — its last piece arrived and
  one of a lower number did not, or pieces arrived and its last did not —, once no
  piece of it has arrived for the floor the engine keeps (SND-15) plus the waiting
  time of LOS-1, unless the engine holds what the last piece states anyway (LOS-4,
  LOS-12). It MUST make that evidence observable, and an answer that lacks a piece
  observable at once, as a transfer under way; it SHOULD answer the evidence as
  LOS-6 says.
  *Rationale:* a bootstrap completes with the piece that carries the snapshot
  (RSY-14), which may arrive first: trust is there before the content is. And a
  receiver that already holds more than the responder — its own edits, others' —
  cannot tell from a vector or a digest whether the rest arrived, since the missing
  piece may carry only deletions. Numbered pieces say it exactly, for the cost of a
  count. The responder sends its pieces at its own floor, which the receiver does
  not know but shares through the pace; it waits as long as one more piece would
  take it.
- **LOS-21** · *engine* — An engine MUST keep each answer it counts (LOS-14) by its
  sender, stream and number, bound to the request it answers, apart from every
  other answer and from the reports it keeps (LOS-17): a piece of another answer —
  of the same stream or another, to its own request or anyone's — ends nothing of
  it, and neither does dropping its stream's report. Its evidence MUST end only:
  - when the answer is whole;
  - when the engine holds what its last piece states;
  - or when it holds the state of that stream at a higher number: by a report of
    the stream it held when it could first compare it (LOS-12), or by a whole
    answer of the stream.

  *Rationale:* two answers of one stream are two transfers, and they overlap: a
  responder answers whoever asks, and a later answer may go to someone else and
  never be whole here. Within a stream the state only grows, so a later answer
  held whole, or a later report held, says the engine holds the earlier one's state
  too; a piece that is not the last states nothing, and cannot.
- **LOS-22** · *engine* — An answer whose pieces disagree — on the request they
  answer, on the count or on the state the last one states, or with a piece
  numbered above the count — MUST NOT be taken as whole, and its evidence MUST end
  only by a higher number of its stream. An engine MAY bound the answers it counts
  at once and the piece numbers it counts; an answer it gives up for the bound MUST
  stay evidence until the engine holds the state of its stream at its number or a
  higher one, and one with a piece numbered above the bound is never whole.
  *Rationale:* where an answer's pieces disagree, the engine cannot tell which of
  them states the answer; only its stream's later word can. A bound on what is
  counted keeps memory finite without letting evidence vanish: giving an answer up
  costs the engine the chance to see it whole, not the warning.

### 10.6 What loss detection cannot notice

*Informative.* A loss may leave no evidence, evidence that ends too soon, or
evidence nothing can end:

- **Before the first answer.** LOS-8 notices a window that moved on only while a
  previous answer exists to compare with, so a truncation between an engine's
  start and its first `receive` is covered by the joiner's bootstrap instead
  (RSY-1).
- **A bridge restart between two polls.** A bridge that restarts entirely between
  two polls of an engine — possible where an application polls rarely, as a
  browser does in a background tab — and whose new window overlaps the previous
  answer is not noticed, unless the transport offers `instance` (LOS-9).
- **Nobody to ask.** A resync heals only while the creator (or, for the creator's
  own request, a peer holding the content) is online. A message that reached
  *nobody* is recovered only when its author answers a request.
- **No promise.** A sender whose `maxIntervalMs` is not finite promises nothing
  (`due` 0) and sends no heartbeat, and the loss of its final message cannot be
  noticed at all.
- **Another device's heartbeat.** A heartbeat names its member, not its device: one
  that holds a frame ends the expectation of that frame, whichever of the member's
  devices sent it (LOS-16). So when one device's final message and its heartbeat
  are both lost while another device of that member, which did get the frame
  before, sends a heartbeat, the loss shows only through a gap (LOS-2), that
  device's next message or its restart (SND-8).
- **Deletions.** An update that only deleted is held by every state vector, so a
  heartbeat ends its expectation always.
- **A report that crossed a deletion.** A report that crossed a deletion the
  receiver holds stays evidence until its stream reports again — at once, once
  that stream hears a request stating what it holds (SND-24) — or answers the
  receiver whole (LOS-18); while that stream does not run, it stays, and the
  receiver's requests go unanswered.
- **Many engines of one member.** An engine keeps the reports of a bounded number
  of streams per member (LOS-17): a member running more engines at once than that
  can have one stream's evidence dropped — not that of an answer it counts
  (LOS-21).
- **A responder that stops.** An answer whose responder stops before its last piece
  — the application quits, or restarts with a new stream — stays evidence while
  that stream does not run: what another stream of the member holds says nothing
  of what this one sent, so whole answers from it do not end it; the old stream's
  own pieces, sent before it stopped and delivered late, still do.

## 11. Invitations

An invitation tells a joiner what to open: which messenger, which document,
which channel, and who the creator is. It is a **convenience for filling in the
join step, not a capability**: holding an invitation grants nothing, because
the joiner's bridge re-checks real channel membership when it binds (BRG-5) —
and for email, every message is checked against the closed participant set
([email binding](bindings/email.md)).

### 11.1 Content

| Field | Meaning | Required |
|---|---|---|
| messenger | Which binding: `signal`, `matrix` or `email` | Yes |
| documentId | The document | Yes |
| creatorMemberId | The creator's MemberId | Yes |
| channel reference | Signal, Matrix: the channel id (group id, room id). Email: the thread root `Message-ID`, every participant's address, and whether PGP is on | Yes |
| profile | The document's profile id ([§5](#5-document-profiles)) | Yes |

An invitation carries no pacing: the pace reaches a joiner with the creator's
control snapshot, and everything else about pacing is the joiner's own
([§9.1](#91-pacing)).

- **INV-1** · *application* — An invitation MUST carry the required fields above
  and MUST NOT carry a bridge address, a credential, or anything that identifies a
  participant's machine.
  *Rationale:* a bridge address is meaningful only on the machine that wrote it;
  the joiner's own application knows how to reach its own bridge.
- **INV-2** · *application* — An application SHOULD send the invitation itself,
  automatically, as an ordinary human-readable message into the document's
  channel (`sendInvitation`, [§3.2](#32-operations)), rather than asking the person
  to copy and paste it.
  *Rationale:* a pasted link can land in the wrong conversation; a readable message
  lets every member see that a document was shared and by whom.
- **INV-3** · *application* — Before joining, an application MUST show the person
  the document, the channel and the creator the invitation names, and MUST join
  only after the person confirms. It MUST show the creator so that the person can
  tell them from anyone else: by an identifier the messenger keeps unique — the
  MemberId, or a phone number, user name or address the messenger binds to it —
  or by a name the person gave that identity themselves, never only by a name the
  creator chose, such as the display name of a profile.
  *Rationale:* the creator named in the invitation becomes the one identity whose
  control frames the engine obeys (CTL-5); a forged invitation naming someone else
  as creator is the one way to hand that authority to the wrong person, and the
  person is the only one who can recognise it. A name the creator chose is exactly
  what a forger copies: shown alone, it asks the person to confirm without letting
  them tell.
### 11.2 Policy text (withdrawn)

TDSP 1.x carried the creator's sync policy in the invitation as a text with a
grammar (INV-4, INV-5). Both are withdrawn with the shared policy; the section
number stays so that references to §11.3 keep their meaning.

### 11.3 Invitation as a link

An application that expresses an invitation as a URL query — or as a URL
fragment (INV-8) — MUST use this form, so that one application can open
another's invitations. The query is
`application/x-www-form-urlencoded` as the WHATWG URL standard defines it (what
`URLSearchParams` reads and writes), and every value is UTF-8.

| Parameter | Field | Required | Value |
|---|---|---|---|
| `tdsp` | invitation version | yes | `2` |
| `provider` | messenger | yes | the binding's name: lowercase letters, digits, `.` and `-`, 1–64 characters, the first a letter or a digit |
| `documentId` | documentId | yes | 1–255 UTF-8 bytes |
| `creatorMemberId` | creatorMemberId | yes | 1–255 UTF-8 bytes |
| `channelId` | channel id | Signal, Matrix | 1–255 UTF-8 bytes |
| `threadRoot` | thread root `Message-ID` | email | the email binding's `Message-ID` form, at most 200 characters in all ([email binding](bindings/email.md)) |
| `recipients` | every participant's address, the creator's included | email | 1–64 distinct addresses, comma-separated |
| `pgp` | PGP is on | email, optional | `1` |
| `profile` | profile | yes | a profile id ([§5](#5-document-profiles)) |

This specification, in this version and every later one, defines parameter names
without a `.` only. A parameter whose name contains a `.` therefore never
collides with one it defines: an application that names its own parameters that
way, under a domain its author controls (`com.example.title`), keeps them apart
from every later addition, as a profile or layer id from outside this
specification is kept apart ([§5.5](#55-profiles-defined-outside-this-specification),
[§5.6](#56-layers)).

- **INV-6** · *application* — A reader MUST refuse an invitation in which a
  parameter of the table above appears more than once, a required one is missing
  or empty, or a value is outside its range; MUST ignore parameters the table does
  not define — 1.x's `policy` among them; and MUST treat a missing or other `tdsp`
  as an invitation it cannot read.
  *Rationale:* one reading for every link. A parameter named twice is exactly the
  place where two parsers pick different values; an unknown parameter is
  ignored because the same query also carries an application's own settings (a
  bridge override, say) and a later version's additions.
- **INV-7** · *application* — An application MUST NOT derive trust from an
  invitation beyond prefilling the join step: the creator it names takes effect
  only after the person confirms (INV-3), the profile is confirmed by the
  creator's snapshot (CTL-10), and membership is decided by the messenger and the
  bridge (BRG-5), not by holding the link. An invitation that names the person's
  own identity as the creator is no exception: the application MUST present it as
  that claim — that the invitation names the person as its creator — and MUST NOT
  take the document for one the person created on another device on the
  invitation's word alone.
  *Rationale:* a link can be forwarded into any conversation and edited by anyone
  who holds it, so it cannot prove which channel it came from; everything it
  claims is checked by something that can. An invitation that names the person
  themselves is the forgery a person can least recognise, since the creator it
  shows is them; told it is their own document, they would decide as its creator
  ([§7.6](#76-a-new-device-of-the-creator)) for a channel and a document someone
  else chose.
- **INV-8** · *application* — An application MAY carry this form as a link's
  fragment instead of its query. A reader SHOULD look for the form in both
  places; one that does MUST read the fragment when the fragment carries a
  `tdsp` parameter and the query otherwise, and MUST NOT combine parameters
  from the two.
  *Rationale:* a link's query reaches every server and log on its way, and
  link-preview fetchers read it; for an `https` link the fragment never leaves
  the browser or the application, though the page the link opens can read it.
  A reader that looks in one place only cannot open the other kind of link,
  and combining the two would let a parameter added to the visible query change
  an invitation carried in the fragment.
- **INV-9** · *application* — An application that brings a document to another
  device of the same person (ARC-5) MAY join it there without asking again
  (INV-3), when the person confirmed it on a device of theirs and the creator, the
  channel and the profile reach the other device from there, through that
  service, unchanged; it MUST NOT take them from anything else. The service then
  carries what INV-3 protects, so an application MUST use for it only storage the
  person's own account holds, whose provider is then trusted as the person's own
  machine is ([§15.2](#152-what-tdsp-assumes)).
  *Rationale:* INV-3 exists so that the person recognises the creator; asking
  again on every device of theirs adds nothing when the answer travels from the
  device where they gave it. But whoever can write into that service can name
  another creator, and with it hand the creator's authority to anyone; storage
  that only the person's devices and its provider write is no weaker than the
  machine the person confirmed on.

For a PGP email document the invitation additionally carries a signed and
encrypted block ([email binding](bindings/email.md)); where the block and the link
disagree, the block wins.

## 12. Bridges

What every bridge must do is a document of its own,
[bindings/bridges.md](bindings/bridges.md), with the requirements TDSP 1.x had
here (BRG-1 to BRG-17); the optional local bridge interface is
[bindings/local-bridge-interface.md](bindings/local-bridge-interface.md) (LBI-1 to
LBI-6). An engine implementer needs neither.

## 13. Messenger bindings

Each messenger binding is a document of its own:
[Signal](bindings/signal.md) (SIG), [Matrix](bindings/matrix.md) (MTX) and
[email](bindings/email.md) (EML). The common envelope and BND-1 to BND-3 are in
[bindings/bridges.md](bindings/bridges.md), with a comparison of the bindings. A
binding states its transport profile — the bounds and the suggested pacing
([§3.5](#35-transport-profile)) — and carries frames of this specification
unchanged; its envelope keeps its own version (`"tdsp": 1`,
[§2.2](#22-two-envelopes-two-readers)).

## 14. Versioning and extensibility

Three things carry a version, deliberately separate:

| What | Where | Changes when |
|---|---|---|
| The frame format | `tdsp` in every frame ([§4](#4-the-payload-frame)) | A frame field or a kind's meaning changes incompatibly |
| The envelope and bindings | `tdsp` in every envelope ([§13](bindings/bridges.md#13-messenger-bindings)) | An envelope field or a carrier changes incompatibly |
| A document profile | The major version in its id ([§5](#5-document-profiles)) | What the profile's bytes mean changes incompatibly |

The frame format is 2 in TDSP 2.0; the envelope and the one profile this
specification defines stay 1, because neither changed. The core, the bindings and
the local bridge interface are documents of their own ([bindings/](bindings/)),
each with its own version in its header; a binding names the core versions whose
frames it carries, and a change to one document needs no new version of another.

- **VER-1** · *all* — An incompatible change MUST increment the version that
  governs it. A receiver that does not implement a version MUST fail loudly — by
  reporting it locally with a named reason (FRM-7 for a frame, which an
  application shows the person, VER-4; BND-2 for a recognisable envelope of a
  bound document) — and MUST NOT skip silently, parse partially or fall back to a
  compatibility mode.
  Nothing is sent to the other participants because of it; a joiner that cannot
  read an invitation of another version tells its person instead
  ([§6.5](#65-declining-an-invitation), DCL-1).
  *Rationale:* every compatibility mode is a second protocol that must be
  specified, tested and secured. A message about a failure would be one more
  message anyone could provoke; the one case where the others must know — someone
  who cannot join a document of a profile it does not implement — has its own,
  deliberate message.
- **VER-2** · *all* — Kinds, targets, reasons and permissions not defined in this
  specification MUST NOT be used until a revision of it defines them. An extension
  field (FRM-9) is not such a value: its name keeps it apart.
  *Rationale:* two implementations inventing the same value for different meanings
  cannot be told apart on the wire.
- **VER-3** · *engine, application* — Until TDSP 2.0 is released, an implementation
  of this draft MUST write, in every frame's and every invitation's `tdsp`, a draft
  marker in place of `2`, MUST accept only that marker, and MUST name a new marker
  for every incompatible change of the draft. The marker of this draft is
  `de.wappensc.together.tdsp.probe.draft-5`.
  *Rationale:* a draft that wrote `2` would leave frames behind that a released 2.0
  reads as its own, although they may mean something else; a marker that is not a
  number makes every 1.x engine refuse a draft frame loudly (VER-1), and every
  released engine too.
- **VER-4** · *application* — An application MUST show the person each participant
  whose frames its engine rejects as `unsupported-version` (FRM-7): that this
  participant uses another version, and that what they write does not reach this
  document. It MUST NOT present the document as complete or that participant as
  merely silent while it shows nothing of it.
  *Rationale:* VER-1 has a receiver fail loudly, but an engine is loud only towards
  its application; a person who is shown nothing takes the other participant for
  absent and the document for everyone's. Every new version, and every update that
  reaches participants at different times, makes this happen in ordinary use. Only
  the person can resolve it, by updating one of the two applications.
- **VER-5** · *all* — A revision that defines a new value for a member's
  permission or for a right on a layer (VER-2) MUST define the capabilities each
  value grants — on a layer, for every permission on the document — and a merge of
  concurrent values (CTL-23, CTL-24) with these properties, for every permission on
  the document:
  - the merge grants no capability that one of the merged values withholds —
    exactly the capabilities they all grant, where some value grants exactly those,
    and otherwise a narrower set the revision names;
  - it is commutative, associative and idempotent;
  - a decision made in knowledge of another still supersedes it, wider or not
    (CTL-22), which is no merge;
  - a permission on the document that is revoked leaves no right on any layer
    (LAY-5).

  *Rationale:* of two concurrent decisions of the creator's devices, no more may
  hold than one of them wanted (CTL-23). In this version the values are ordered —
  revoked, `read`, `write`; `read`, inherit, `write` on a layer —, and the
  narrowest of them grants exactly what every one grants, whatever the permission
  on the document. A later right may not fit an order: "comment only" and "edit the
  text but not comment" each withhold what the other grants, and ranking one below
  the other would grant one of them more than its device wanted. Capabilities and
  their intersection say it for any set of rights.
- **VER-6** · *all* — A revision that defines such a value (VER-5) MUST keep older
  implementations from taking it for `write` or for inherit: as an incompatible
  change (VER-1, VER-3), or with a rule by which a creator's device issues the
  value only once it knows that every participant's engine reads it.
  *Rationale:* an older engine refuses a value it does not know (VER-2, FRM-6) and
  so takes nothing from it, but it also holds nothing of the decision, which a
  participant that reads it holds: the two then enforce different rights, unless
  the value waits until everyone reads it or the version says that they cannot
  work together.

A compatible addition — a new frame kind that older engines may reject as
`unknown-kind` without harm to the document, a new profile, or an extension field
older engines ignore (FRM-9) — does not increment a version, but needs a revision
of this specification (or, for a profile or an extension, its own definition,
FRM-12) that states why older implementations are unaffected. An extension that
older engines must not ignore is named in `crit` (FRM-10).

## 15. Security considerations

### 15.1 What a messenger must provide

A messenger is suitable for TDSP if and only if it offers all of these:

| Requirement | Why |
|---|---|
| Carry an opaque payload between the members of a channel | The payload is a frame the messenger must not need to understand |
| Accept a message for every member of the channel, and deliver it to them in the normal case | There is no server to fan out. A message lost now and then is recovered by TDSP ([§10](#10-loss-detection)); a messenger that routinely loses messages makes that recovery the normal path |
| An authenticated sender per message | Every authority check compares the sender against the creator |
| A stable, unique message identifier | De-duplication depends on it |
| A known maximum message size | The scheduler must split what does not fit |
| Immutable delivered messages, or a bridge that makes them so | An applied update cannot be retracted |

A binding that lacks one of these is not a TDSP binding. In particular, email
without PGP has no sender authentication (EML-9): it is an experimental
extension, not a conformant binding. Email with PGP authenticates a sender as
the holder of the key the creator's invitation pinned; that the key belongs to
the person named is established only by a fingerprint compared outside TDSP
(EML-8). Matrix in a plain room authenticates a sender only as far as the
homeserver is trusted, and protects nothing against it. In an encrypted room it
authenticates the sender's account by the device its identity signed, and adds
integrity and confidentiality against the homeserver — as far as every bridge
shares room keys only with devices their owners signed and accepts frames only
from them (MTX-4), and ignores what arrives unencrypted (MTX-5); a homeserver that
can add an unsigned device to an account gains nothing then
([§13.3](bindings/matrix.md#133-matrix)).

Not required: history, ordering, exactly-once delivery, per-message access
control, server-enforced membership, or any notion of a document.
Confidentiality is not on the list because TDSP *functions* without it — but
it is only *worth using* with it.

### 15.2 What TDSP assumes

1. **Participants are honest.** They run genuine software rather than a modified
   engine that speaks the same wire format, and each is responsible for the
   channel they take part in. A participant running modified software can ignore
   every rule of §7 in their own copy; every genuine engine still rejects what
   breaks the rules, so the document forks only in the modified engine's view.
2. **The local machine is trusted**, including every process running as the same
   user.
3. **The messenger is trusted for what it reports**: senders, channel membership and
   encryption state are taken as ground truth. Even a messenger with strong
   end-to-end encryption could misreport a sender, and TDSP would not notice.

### 15.3 What TDSP enforces itself

| Concern | Mechanism | Worth |
|---|---|---|
| Permissions | The creator grants and revokes; each engine refuses to send an edit before its bootstrap, while its own permission is `read` or revoked, and once the document is closed — not when its permission is merely unknown after the bootstrap (CTL-13) | Among cooperating engines only, and only while their applications keep what the engine refuses out of the engine's document, which a resync answer carries whole (CTL-42, RSY-10); receivers do not reject an edit for its sender's permission (CTL-7) |
| Rights on layers | The creator sets a member's right on a layer, or lets it inherit the permission on the document; each engine refuses to send a change of a layer on which its permission is `read`, of any layer once its permission on the document is revoked, and a change that touches such a layer whole (LAY-5, LAY-6, LAY-7) | As for permissions: among cooperating engines only; `read` hides nothing, every participant reads every layer it receives |
| Creator identity | Fixed; control operations and snapshots only from it (CTL-5, CTL-25); device tags tell its devices apart and authenticate nothing | Exactly as strong as the messenger's sender authentication |
| Replay of control frames | Control state is a set of operations (CTL-23) | A replayed operation is inert (CTL-6) |
| Close | Cooperating engines stop sending edits of their own; edits sent before the close still arrive and apply (LIF-6) | Among cooperating engines only, and only while their applications keep a change made after the close out of the engine's document (CTL-42) — a modified engine can keep sending edits, which genuine engines apply, exactly as with `read` (CTL-7) |
| Convergence | The CRDT | Unconditional, given the same set of updates — not given a lost one |
| Message immutability | Bridges refuse and record edits and withdrawals (BRG-12) | Where the messenger reveals them |
| No external connection | ARC-2, BRG-4 | As strong as its enforcement; see below |
| Resource exhaustion by peers | Bounded control state (CTL-30), and a capacity conflict beyond its bytes (CTL-32); bounded nesting and frame size, extensions included (FRM-11), bounded attachment fetches (BRG-14), bounded pre-verification reads (BRG-13); no reassembly buffer | Bounded, not prevented; beyond the bytes of control state a person resolves the conflict |

**Enforcing "no external connection".** The one security property TDSP owns
rather than inherits is only as good as the checks behind it, and no single check
sees everything. An implementation SHOULD combine several that fail
independently:

1. **A source scan** that finds every network primitive in its own code — ambient
   ones included, such as `fetch` or a socket constructor that no import reveals —
   and fails the build unless each is allowed twice: by an annotation at the call
   site and by an entry in a reviewed policy file that states why. Two places make
   a weakening deliberate rather than accidental.
2. **Dependency rules** that forbid the engine and the application to import any
   transport library, so the transport contract stays the only way out.
3. **A runtime guard in the test suite** that intercepts socket creation and fails
   any connection that is not to the loopback interface — including those made by
   third-party libraries, which a source scan does not read.
4. **A content security policy** for a browser-hosted application that allows
   connections to the loopback interface only.
5. **A test run with operating-system-level egress blocking**, which also catches
   native modules no language-level guard can see.

The reference implementation uses all five.

### 15.4 What is not guaranteed

- **Confidentiality beyond the channel's own.** If the channel is not end-to-end
  encrypted, neither is the document. Each participant can check the channel's
  encryption in their own messenger client, independently of what TDSP shows.
- **Protection against a malicious participant**, a compromised application or device,
  traffic analysis, or exfiltration from a participant's machine.
- **Availability** against someone who can drop messages — they can drop the resync
  too — or while the creator is offline.
- **Convergence beyond the bounds of control state.** Devices of the creator that
  grow apart beyond what a receiver holds leave a capacity conflict, which a person
  resolves (CTL-32), not a merged state.
- **Completeness without evidence.** A copy with no loss evidence may still lack a
  change: one no engine saw a trace of ([§10.6](#106-what-loss-detection-cannot-notice)), or,
  at the creator, one held only by a member who was offline when the creator
  asked (LOS-20).
- **Authorship.** Attribution is a display convenience (ATR-3).
- **Deletion** of content from participants' devices.
- **Metadata protection.** Who talks to whom, when and how much is as visible as the
  messenger makes it; the documentId is visible to the messenger and to every
  channel member.
- **Portability** of a document between messengers: bindings are messenger-specific
  state.

### 15.5 Specific threats

- **A forged or careless pace** can make a document slow, without bound — a floor of
  weeks is expressible. It can never make an engine exceed its own provider's
  limits (SND-15), and it comes from the creator alone. This is not new power:
  whoever can forge the creator can close the document. Nothing else about pacing
  is shared, so 1.x's forged policy, with its grammar, ordering and clamps, is gone.
- **Reported counters** (CTL-27, CTL-33): a member can report counters too low — a
  creator device's decision then counts as concurrent, and the result is narrower
  — or too high, which matters only when a former creator device comes back and
  decides concurrently; its decision then counts as superseded. A device counts
  reported counters only while it has no basis for its control state (CTL-28), or
  on a person's explicit confirmation of a divergence (CTL-33). Reports never carry
  authority: values come only from operations whose sender is the creator.
- **Many device tags**: the creator's account can name tags at will; CTL-30 bounds
  what a receiver holds, and refuses and reports the rest.
- **Extension fields** (FRM-9): a sender can ship bytes a receiver ignores, as it
  already could in a `decline`'s text; they count against `maxBytes` and the
  nesting limit (FRM-11), and nothing an extension carries is applied by an engine
  that does not implement it. An engine that does keeps nothing of it and passes
  nothing on (FRM-17), so a forged extension misleads at most the receivers of the
  one frame, and only as far as the extension's definition lets it.
- **A forged heartbeat** can cost one unnecessary resync request per floor, never
  more (RSY-3, LOS-6).
- **A forged invitation** naming a false creator hands control authority to that
  identity in the joiner's engine; INV-3 puts a person in the loop.
- **Attachments** let any member make other members fetch data; BRG-13 and BRG-14
  bound how much a bridge reads, and the fetch itself where the bridge makes it.
  Where a messenger's client fetches attachments before the bridge sees a message,
  as `signal-cli` does, only the client's own limit bounds that fetch, and the
  binding says so (BRG-14). Pieces are ordinary updates: an incomplete set occupies
  nothing beyond what the CRDT holds pending anyway.
- **An email document without PGP** has no sender authentication at all: anyone who
  can send mail with a forged `From` can issue control frames as the creator. The
  application MUST tell its user so, persistently.

---

## Appendix A. Profile `yjs-paragraphs/1`

*Normative for every engine that implements this profile.* A document of this
profile is a Yjs document holding plain paragraphs. It fixes the wire format, not
a library version: any implementation that reads and writes the encodings below
interoperates, whichever Yjs release — or independent implementation — it uses.

| PRF-1 item | In this profile |
|---|---|
| Update | A **Yjs update in encoding version 1**, as produced by `Y.encodeStateAsUpdate` and consumed by `Y.applyUpdate` (not the `…V2` functions). A full snapshot and an incremental change are the same format |
| Missing predecessors | Yjs holds such an update as pending (`store.pendingStructs`, `store.pendingDs`); the Yjs client ids an update carries name whose updates they are |
| State vector | A **Yjs state vector** as produced by `Y.encodeStateVector`. The empty document's is the single byte `00` (Base64 `AA==`) |
| Updates a state vector lacks | `Y.encodeStateAsUpdate(doc, stateVector)`; with the empty state vector this is byte-identical to the full state. The update that holds nothing, the full state of an empty `Y.Doc`, is the two bytes `00 00` (Base64 `AAA=`): no structs and an empty delete set |
| Reading without applying | An update is read as `Y.decodeUpdate` reads it, every struct and the whole delete set, and ends where its delete set ends; a state vector is read as `Y.decodeStateVector` reads it, and ends after its last entry. Yjs ignores bytes after either; a receiver of this profile rejects them (§4.4) |
| What a replica deleted | The update of no structs and the replica's whole delete set, as `Y.encodeStateAsUpdate(doc, Y.encodeStateVector(doc))` writes it in encoding version 1: `00` for no structs, the number of clients, and for each client in descending order of its id its id, the number of its ranges and each range's clock and length, ascending and merged, every number a variable-length unsigned integer. A document that deleted nothing gives the two bytes `00 00`. Of the items a state vector counts: the same, with each client's ranges cut at that client's clock in the state vector, and a client without ranges left out — within the replica's own state vector exactly the encoding of all it deleted |
| Initial state | One empty paragraph |
| Plain-text projection | The paragraphs' texts in document order, joined by a single `"\n"`; a paragraph's text is that of the `Y.XmlText` it holds, without formatting or embeds (YJS-4 for content YJS-1 forbids); offsets count **UTF-16 code units** |
| Splitting into pieces | Each piece a Yjs update in encoding version 1 holding one contiguous run of one client's structs, or a part of the delete set. A run is cut between structs and, where a struct alone is too large, inside it: the prefix written as a shortened copy, the suffix as Yjs writes any partial struct; text never cut inside a UTF-16 surrogate pair |
| Indivisible units | Content of length one — an embed, a binary, a format, a type, a subdocument. Its encoded struct must fit a piece: (`maxBytes` − an `edit` frame's other fields) × 3/4 bytes, about 3.1 MB at the bindings' 4 MiB. Text is never such a unit |
| Layers | Admitted: top-level shared types beside `content`, each named by a layer id ([§5.6](#56-layers)) |

- **YJS-1** · *engine, application* — A document of this profile MUST keep all its
  content in one `Y.XmlFragment` named `content`, whose children are
  `Y.XmlElement`s named `paragraph`, each holding one `Y.XmlText`, and MUST NOT add
  other element names or attributes. Beside `content` it MUST NOT hold a top-level
  shared type except a layer, named by its layer id ([§5.6](#56-layers)).
  *Rationale:* a peer that does not know an element can still merge it, but cannot
  render, project or attribute it, so participants would see different documents
  from the same state. A layer is different by definition: it is not content, and
  every peer keeps it (LAY-1) whether or not it shows it.
- **YJS-4** · *engine* — A receiver MUST NOT reject an update because what it
  holds breaks YJS-1, and MUST apply it like any other. It MUST project such
  content as it projects paragraphs: each child of `content`, whatever its name and
  attributes, is one paragraph whose text is that of the `Y.XmlText`s it holds
  directly, in order, without formatting or embeds; a `Y.XmlText` that is itself a
  child of `content` is a paragraph of its own text, and anything nested deeper
  adds nothing. A top-level type beside `content` that no layer id names is not in
  the projection, and a change of it is a change of the content (LAY-7).
  *Rationale:* a CRDT cannot refuse part of the state it converges to: a receiver
  that rejected such an update would fall behind everyone who applied it, and every
  later update of its writer would wait for it. Projected one way everywhere, the
  content keeps attribution offsets equal between engines (YJS-3), whatever an
  application then shows of it. Counted as content, a type that no layer names can
  be written only by those who may write the content.
- **YJS-2** · *engine* — Updates MUST be Yjs update encoding version 1.
  *Rationale:* version 2 is a different byte format under the same library; mixing
  them fails to decode.
- **YJS-3** · *engine* — Implementations MUST compute the projection and its offsets
  exactly as stated, including in languages whose native strings are not UTF-16.
  *Rationale:* the overlay's offsets are exchanged between engines; the same
  document projected with a different separator or unit shifts every attribution
  after the first non-ASCII character.

*Informative.* Yjs merges a client's consecutive insertions into one item, even
across transactions, so a long text is one item however it was typed; that is why
a split must be able to cut inside an item. Yjs also, now and then, keeps an update
back although everything it waits for has arrived — with ordinary shuffled edits as
with pieces, about one in three to four hundred in the reference implementation's
tests; applying it again, as a resync does, releases it. A pending gap is
evidence (LOS-2), so this heals like any loss.

*Informative.* Splitting or joining paragraphs, as editors write it in this
profile, deletes text and inserts it again as new items. A relative position into
the moved text then no longer finds it and falls to the edge of what remained, and
inline formatting a reader does not know is lost the same way. A layer that points
into this profile's content says in its definition (LAY-4) what a reader shows
then; an editor that implements the layer can re-anchor it in the same
transaction.

## Appendix B. Recommended values

*Informative.* The values the reference implementation uses. Each row names the
requirement it serves.

| Value | Recommended | Serves |
|---|---|---|
| Engine default pacing | floor 0, no `maxIntervalMs`, `minChars` 0, no `maxChars`, latency 0 | SND-16 |
| Quiet time (`batchWindowMs`) | 500 ms | SND-3 |
| Retry back-off | Starts at max(1 s, floor), doubles per consecutive failure, capped at `maxIntervalMs` or 10 min; `retryAfterMs` honoured up to 1 h; after `needs-person`, the cap at once | SND-7, TRN-20 |
| Adaptive spacing | ×1.5 per `rate-limited` refusal, from the floor or 1 s; relaxed ×1.5 after 8 consecutive successes | SND-9 |
| Resync response throttle | 1 000 ms per document per responder | RSY-9 |
| Requests kept to answer later | By request id, at most 4 per requester and 64 per document, each for at most 5 min; oldest dropped first; requesters served in turn | RSY-19 |
| Resync request expiry | floor + 2 × latency, at least 10 s | RSY-4 |
| Bootstrap retry | after 1, 2, 4, … expiries; at most 5 attempts | RSY-5 |
| Loss-evidence wait | 1 × `expectedLatencyMs`, or 5 s when it is 0 | LOS-1 |
| Streams kept per member | 4 for their reports, each with its latest; a fifth replaces the one heard from least recently; a stream with an answer counted or given up is kept besides | LOS-17, LOS-21 |
| Answers counted per member | 8 at once; a ninth gives up the one heard from least recently, which stays evidence by stream and number; 8 streams with answers given up, beyond them the member's evidence stays while the engine runs; piece numbers up to 2^20 | LOS-21, LOS-22 |
| Incomplete answer | evidence once no piece has arrived for the floor + the loss-evidence wait | LOS-14 |
| Automatic resync | at once for a truncated history; after 2 × latency for a gap, a report that shows we are behind or differs in digest, or an incomplete answer; after the overdue time + 3 × latency for silence; at most 3 per episode, each wait doubling, never longer than 10 min | LOS-6, LOS-19 |
| Control state bounds | 64 creator devices, 1 024 counters above a hole per device, 5 002 targets, 64 operations per target in a snapshot, a target's `seen` 64 devices, the close each device's latest of 64 devices without `seen`, 3 MiB held and 1 MiB for a device that adds a target, measured without the close, which holds always | CTL-30, CTL-34 to CTL-37 |
| Smallest useful piece | Below it, a change is refused rather than cut into pieces too small to carry anything | SND-19 |
| Incoming mail read | At most 10 MiB of one mail, by a partial IMAP fetch; a larger one is rejected unread (the largest mail a 4 MiB frame becomes is about 7.6 MiB) | BRG-13 |
| Signal daemon response | At most 16 Mi characters per JSON-RPC line from `signal-cli`, plus one socket read (a 4 MiB attachment is about 5.6 Mi in Base64); a longer line is dropped unread and the calls waiting fail | BRG-14 |
| Bridge retention | The newest 1 000 deliveries per document, and at most 64 Mi characters of their payload text; the newest always kept | BRG-17 |
| Engine memory of processed ids | What `receive` still returns, plus its own sends for up to 1 h until their echo; 1 024 resync request ids of others | TRN-8 |
| Matrix attachment download retry | 1, 2, 4 … s, at most 60 s apart, 8 attempts, at most 64 waiting | BRG-14 |
| Signal attachment read retry | 3 attempts, 0.5 s and 1.5 s apart | BRG-14 |
| Bridge ports | Signal 8787, Matrix 8788, email 8789 | — |

Suggested pacing per bridge (`minInterval` / `maxInterval` / `expectedLatency`,
then bounds; every one has `minChars` 0 and `maxChars` none). **Only the email interval is a decision; every other value is an
estimate.** Named presets — a slower one for a strict provider, say — are an
application's ([§3.5](#35-transport-profile)).

| Bridge | Pacing | Bounds |
|---|---|---|
| Email to a provider | 35 s / 120 s / 60 s — above the one message per 34 s one provider was measured to allow; TDSP 1.x suggested 30 s, which ran into refusals there | floor 15 s; 4 MiB (a mail of at most about 7.6 MiB: measured 1.81 mail bytes per frame byte with PGP, 1.39 without; sized for 8 MiB, below the roughly 10 MiB providers commonly accept) |
| Email or Matrix to a server on the same machine | 0 / none / 0 (no floor, no cap) | email none; Matrix no floor, 4 MiB |
| Matrix to a real homeserver | 1 s / 15 s / 5 s | floor 250 ms; 4 MiB. A homeserver limits by a burst and a sustained rate — Synapse by default 10 messages, then one every 5 s (`rc_message`) — so a person typing steadily is refused now and then, and the homeserver's wait (MTX-6) and the widened spacing (SND-9) take over; a floor at the sustained rate would slow every burst to one message per 5 s |
| Signal | 2 s / 20 s / 10 s | floor 500 ms; 4 MiB |

Measured sizes worth knowing: typed text costs about 10 bytes per character on
the wire, pasted text about 1, a full snapshot 1 to 9 depending on how
concurrently it was written. One measured email provider refused after about 35
messages in 20 minutes, with 8 to 35 seconds per hop.

## Appendix C. The bindings compared

Moved to [bindings/bridges.md](bindings/bridges.md#appendix-c-the-bindings-compared).

## Appendix D. Example frames

*Informative.* Produced by the reference encoder, documentId `doc-a1b2c3`,
profile `yjs-paragraphs/1`, from a creator device tagged `Ms3dRk0ZyS7cH1qkM8fWNA`
whose sender will send again within 30 seconds; until TDSP releases 2.0 the encoder
writes the draft marker where these show `2` (VER-3). The `edit` frame is in
[§4.5](#45-example).

`control` — the device's first operation, grant `bob` write:

```json
{"tdsp":2,"kind":"control","documentId":"doc-a1b2c3","device":"Ms3dRk0ZyS7cH1qkM8fWNA","counter":1,"target":"member:bob","value":"write","seen":{},"due":30000}
```

`control` — its second, the pace for everyone 30 seconds:

```json
{"tdsp":2,"kind":"control","documentId":"doc-a1b2c3","device":"Ms3dRk0ZyS7cH1qkM8fWNA","counter":2,"target":"pace","value":30000,"seen":{},"due":30000}
```

`control` — its third, the close:

```json
{"tdsp":2,"kind":"control","documentId":"doc-a1b2c3","device":"Ms3dRk0ZyS7cH1qkM8fWNA","counter":3,"target":"close","value":true,"seen":{},"due":30000}
```

`heartbeat` from that device after the edit of §4.5 (the state vector names one Yjs
client at clock 4; nothing was deleted, so the state digest is that of the two bytes
`00 00`; the control digest is that of the three operations above; it is the first
report of the device's engine, whose stream is `0c4f9a2be81d7365`):

```json
{"tdsp":2,"kind":"heartbeat","documentId":"doc-a1b2c3","control":{"Ms3dRk0ZyS7cH1qkM8fWNA":3},"controlDigest":"7aeabcc525c85aea","stateVector":"AYma9JgPBA==","stateDigest":"96a296d224f285c6","stream":"0c4f9a2be81d7365","sequence":1}
```

`resync-request` of a joiner with nothing, the first report of its engine:

```json
{"tdsp":2,"kind":"resync-request","documentId":"doc-a1b2c3","requestId":"5f3a9c0e12b47d68","control":null,"controlDigest":null,"force":false,"stateVector":"AA==","stateDigest":"96a296d224f285c6","stream":"7e0d5b31a9c4f286","sequence":1}
```

`decline` of a joiner whose engine implements another profile:

```json
{"tdsp":2,"kind":"decline","documentId":"doc-a1b2c3","reason":"unsupported-profile","profiles":["com.example.markdown/1"],"text":"My app cannot open this document."}
```

The `edit` frame of §4.5 as a Signal group message's body — the envelope, which
keeps its own version 1, with the frame as a JSON string:

```json
{"tdsp":1,"kind":"frame","documentId":"doc-a1b2c3","frame":"{\"tdsp\":2,\"kind\":\"edit\",\"documentId\":\"doc-a1b2c3\",\"update\":\"AQOJmvSYDwAHAQdjb250ZW50AwlwYXJhZ3JhcGgHAIma9JgPAAYEAIma9JgPAQJIaQA=\",\"due\":30000}"}
```

## Appendix E. Implementer checklists

*Informative.*

**A bridge for a new messenger.**

1. Check the messenger against [§15.1](#151-what-a-messenger-must-provide). The
   dealbreakers are an unauthenticated sender and an inability to carry an opaque
   payload. Write down its size and rate limits.
2. Decide how the account is provisioned, and keep its credentials in a private
   place ([§12.1](bindings/bridges.md#121-account-and-credentials)).
3. Write a binding ([§13](bindings/bridges.md#13-messenger-bindings)): account, security, envelope,
   carrier, delivery id, sender, inline limit, attachments, and how a message
   reaches the sender's own other devices (TRN-7).
4. Never parse the frame; route by the envelope's documentId; ignore what is not
   yours, silently.
5. Make delivered messages immutable and record every attempt to alter one.
6. Classify send failures (BRG-8); if the bridge runs in its own process, offer
   the local bridge interface ([§12.6](bindings/local-bridge-interface.md#126-the-local-bridge-interface-optional)):
   loopback only, loopback origins only.
7. Reach exactly one endpoint.
8. Serve a transport profile that states the limits you measured and a pacing you
   suggest, and say which values are estimates. Where the messenger has a position
   to resume from, offer a cursor (TRN-18), truncated also behind what the bridge
   skipped; offer an instance id that changes whenever the bridge may have lost
   something it held, on every restart if in doubt (TRN-19).
9. Pass the conformance suite with two real accounts, repeatedly.
10. Write down what the messenger cannot do; a gap is an error, never a silent
    no-op.

**An application on top of the engine.**

1. Everything goes through the transport contract; a socket "just for presence"
   ends the security model.
2. Generate documentIds from a secure random source, and choose each document's
   profile. A profile from outside this specification needs a public definition
   with test vectors (PRF-7), and ships with the application, never with a
   document (PRF-8). Keep layers you do not implement, and show that they are
   there (LAY-2).
3. Persist the creator's control state — with its device tag, its counter and the
   operations not yet sent (CTL-26) — and the list of documents the user has. On a
   creator device without a basis, decide nothing for the person (CTL-29).
4. Show the creator from an invitation — by an identifier the messenger keeps
   unique, not only by a name they chose — and let the person confirm before
   joining (INV-3); decline an invitation whose profile the engine does not
   implement, and show the declines others send. Tell the person when an
   invitation, or a participant's frames, come from another version (DCL-1,
   VER-4).
5. Show send status and loss evidence; show an error only for a dropped change,
   and show undistributed changes (SND-8, SND-21) until a resync has gone out —
   never "synchronised" meanwhile. Show an answer that lacks a piece (LOS-14) apart
   from a bootstrap: the trust may be there before all the content is.
6. While the engine would refuse an edit — before the bootstrap, while the
   person's permission is `read`, after a close — prevent typing, or hold what
   the person types outside the engine's document (CTL-42). One way to hold: keep
   a second replica that applies every update the engine's document applies, let
   the person edit that replica, and once the engine may edit, apply the
   replica's update since the engine's state vector to the engine's document as a
   local edit. The CRDT merges it with whatever arrived meanwhile; a text
   difference computed against an earlier state would instead undo or misplace
   what arrived since. The application knows what it held, so afterwards it can
   check whether that text is still there.
7. Write large embeds and binaries in parts no larger than the profile allows
   (SND-19), and offer pacing presets of your own; the transport suggests one
   pacing, and the creator may set the pace for everyone (SND-15).
8. Say, per messenger, what the channel does and does not protect — and never
   present attribution as authentication.

## Appendix F. Reference implementation

*Informative.* The reference engine of this draft is TypeScript, on Node.js and in
the browser:

| Part | Class | What it is |
|---|---|---|
| `messenger-port` | — | The transport contract with its optional cursor and instance, the transport profile, the send-failure classification, and the transport conformance suite ([§3.6](#36-conformance-suite)) |
| `messenger-mock` | adapter | An in-memory transport with fault injection — delay, duplication, loss, a moved-on window, a restarted bridge — offering the cursor and the instance |
| `document-protocol` | engine, application | The engine (`DocumentEngine`), and the invitation link's reader and writer (`parseInvitation`, `encodeInvitation`): frames, control state as operations, bootstrap and resync, send scheduling, pieces, loss detection, declines |
| `reconciliation` | engine | The profile `yjs-paragraphs/1` ([Appendix A](#appendix-a-profile-yjs-paragraphs1)), its splitting into pieces, and the attribution tracker |

The adapters and bridges of TDSP 1.x carry this draft's frames unchanged — the
envelope did not change — but serve 1.x's transport profile, which an engine of
this draft refuses (TRN-13), until they serve the form of
[§3.5](#35-transport-profile). Its conformance status — what has been verified,
and against what — is published with it (`CONFORMANCE.md`), not here.

## Appendix G. Changes from TDSP 1.x

*Informative.* Requirement by requirement, with the reason for each change; the
requirements themselves state their full rationale. An ID not listed keeps its
1.x text, but for references to sections or requirements that moved.

The changes have six reasons, which the tables below cite by letter:

- **A — One writer, one number.** 1.x numbered the creator's control actions in
  one gap-free sequence per document. That holds only while the creator uses one
  device: two devices, or one restored from a backup, issued different actions
  under the same number, which every receiver then had to detect and settle; a
  device that had not seen the current number could not decide at all until
  another device of the creator passed the state on — never, once those devices
  were gone. And an action held only after its send succeeded, so a creator
  without a connection saw nothing of a decision it had made. 2.0 counts
  operations per device, each naming what its device had seen, and merges them
  like the content ([§7](#7-control-state)).
- **B — A shared policy for a private matter.** 1.x carried the creator's whole
  sync policy to every participant — in a control action, in snapshots and in
  the invitation link — with a grammar, an order of precedence and a clamp for
  every value. Receivers need two things from it: when a sender will speak again,
  and how quiet the creator wants the document. 2.0 keeps exactly those (`due`,
  SND-14; the pace, SND-15); everything else is each participant's own (SND-16).
- **C — Closed layouts.** In 1.x every new field broke the wire, so the protocol
  could grow only by major version. 2.0 lets a field whose name contains `.` be
  ignored when unknown, unless its sender marks it critical (FRM-9 to FRM-12,
  FRM-15 to FRM-17).
- **D — Fragments.** A message too large for the messenger travelled as
  fragments that a receiver buffered and reassembled; one lost fragment lost the
  whole message, and the buffers needed bounds in memory and time of their own. 2.0
  splits a large update into pieces that are updates themselves, each useful on
  its own (PRF-1 item 7, SND-17).
- **E — Loss guessed, not known.** Without a position to resume from, an engine
  could only guess from overlapping answers whether something slid out of a
  bridge's window (LOS-8), and a bridge restart between two polls stayed
  invisible. A bridge whose messenger has such a position now says so (TRN-18,
  TRN-19).
- **F — One document for every messenger.** How frames travel on one messenger
  changes with that messenger. Kept in documents of their own, the bindings can
  change without a revision of the core, and the core describes only what every
  transport offers.

**Withdrawn**, with what takes their place:

| 1.x | Replaced by | Why |
|---|---|---|
| CTL-2, CTL-3 (a gap-free sequence of the creator, applied after the send) | CTL-20, CTL-21 | A: a tag and counter per device let several devices decide without a conflict, and an operation holds at once, so a decision shows while the messenger is away and goes out later. |
| CTL-8, CTL-9 (highest and contiguous sequence) | §7.4, LOS-10, RSY-16, SND-11 | A: one number cannot describe several devices; a control vector compares per device, so a device that knows less is not taken for a gap. |
| CTL-11 (the snapshot replaces, with a floor) | CTL-25 | A: a snapshot is merged as a union, which cannot undo anything; nothing is replaced, so no floor is needed to guard against an older snapshot. |
| CTL-12 (persistence with an outbox) | CTL-26 | A: an operation is persisted with its counter, as unsent until the messenger takes it; a separate outbox of whole frames is not needed. |
| CTL-14 (ordering policies) | — | B: no shared policy is left to order. |
| CTL-16 (clamping the creator's policy) | SND-15 | B: the one shared value, the pace, yields to each participant's own bounds; nothing else is shared that would need a clamp. |
| CTL-17, CTL-18 (conflicts under one number, devices continuing after an unbroken run) | CTL-22, CTL-23, CTL-24 | A: no two devices share a number. Concurrent decisions merge — one made in knowledge of another stands, of two concurrent ones the narrower holds — and a device restored from a backup that reuses its tag and counter is merged instead of stuck. |
| CTL-19 (a creator device without control state waits) | CTL-27, CTL-28, CTL-29 | A: waiting for another device of the creator could last for ever. A new device decides at once and takes from members only which counters to supersede, never what holds. |
| RSY-2 (`controlSequence` and `bootstrap` in a request) | RSY-16 | A: a request names what its sender holds per device (a control vector); `force` takes over from `bootstrap` after a truncated history. |
| RSY-7 (when to answer, by sequence and `bootstrap`) | RSY-17 | A: the same decision, made by comparing vectors. |
| SND-4 (the shared policy's precedence) | SND-15, SND-16 | B. |
| FRG-1 to FRG-8 (fragments and reassembly) | PRF-1 item 7, SND-17, SND-18, SND-19 | D. |
| LOS-3 (silence judged by the receiver's own policy) | LOS-11 | B: a receiver judges a sender's silence by what that sender promised (`due`), which is what lets pacing be each participant's own. |
| LOS-5 (a gap in the control sequence) | LOS-10 | A: a missing counter of one device is a missing decision; the heartbeat makes the loss of the last one visible. |
| INV-4, INV-5 (the policy in the invitation, its grammar) | — | B: an invitation carries no policy. |

**Kept, changed:**

| Requirement | Change | Why |
|---|---|---|
| FRM-2 | `"tdsp": 2` | The control frame, the heartbeat and the request change incompatibly; a 1.x engine must refuse a 2.0 frame loudly (VER-1) rather than misread it. |
| FRM-5, FRM-6 | Extension fields may be added; defined fields keep their one reading | C. |
| VER-2 | An extension field is not an undefined value | C: its name keeps it apart from values a revision may define. |
| CTL-1 | Operations instead of numbered actions | A. |
| CTL-5 | Without 1.x's condition (c), a sequence above the last for the target and above the snapshot floor | A: an operation counts in whatever order it arrives; which of two holds is decided by merging (CTL-23), not by arrival. |
| CTL-6, TRN-8 | An operation already held is inert, where 1.x judged a frame by its sequence | A: a duplicate is the expected result of a re-offered message, and a set makes it harmless without a sequence. |
| CTL-15 | The snapshot's layout: operations per target with a control vector and the counters held above a hole, and no policy | A, B; the counters, because an operation superseded above a hole is in no target's heads, and a state restored without them lost the hole. |
| RSY-8 (with RSY-18) | What `control` carries in an answer; a member reports the creator's counters; every piece names the responder's stream and its own number, the last the count | A: the reports are how a new device of the creator learns what to supersede (CTL-27). D, and a review of draft 2: a requester that holds more than the responder could not tell whether a piece was missing. |
| SND-2 (with SND-20) | A control frame is retried until the messenger takes it, and a piece of an answer; a send asked for at once keeps the floor | A: the operation already holds, so its send is owed, as an edit's is. And a conformance check: a send at once could push the next message into a refusal. |
| SND-1 | A floor, `minChars` or latency that is not finite falls back to its default | A conformance check: an infinite floor stopped every send. |
| SND-7, SND-9 | A refusal of a message of any kind holds back, and widens the spacing of, the next send of every kind | A conformance check: an answer refused as rate-limited went out again every second. |
| SND-8 (with SND-21 and SND-22), PRF-1 (item 7) | Pieces instead of fragments; a dropped answer, request or heartbeat leaves nothing undistributed; the application shows undistributed changes and offers to send the whole state again | D; and a conformance check: an application that only avoided the word "synchronised" met the rule while it showed everything as sent. |
| SND-10 | A request that fails to send is no error; its outcome is *failed* | A conformance check: a request is no change, and a failed one showed nowhere. |
| RSY-3, RSY-4 | A request the floor holds back waits; its expiry counts from when it was sent | A conformance check: an automatic request refused at the floor was spent, and an engine that kept writing never asked. |
| SND-11 (with SND-23 and SND-24) | The heartbeat follows pieces, not fragments, carries the control vector and its sender's stream, counts from the edit or control frame that promised it, and goes at once when a request states what the engine holds while its last report states otherwise | A, D; and a review of draft 2: counted from the last message of any kind, an answer to a joiner pushed it past the edit's `due`. |
| ARC-4 | Credentials stay away from the engine and from every component that renders what came through the channel; a sign-in form outside it may pass a typed password to the bridge | "The application" was read as every part of it, which no bridge needing a password can meet. |
| INV-3, INV-7 | The creator is shown by an identifier the messenger keeps unique, or a name the person gave; an invitation naming the person as creator is a claim | A self-chosen name is what a forger copies, and an invitation naming the person themselves is the forgery they can least recognise. |
| TRN-11, TRN-12 | Five reasons: `needs-person` for a refusal only a person can lift | An identity not trusted, a device not confirmed or no account was either retried without end (`unavailable`) or dropped (`rejected`); neither serves, and implementations chose differently. |
| LOS-1 | The waiting time comes from the engine's own pacing | B. |
| RSY-9 (with RSY-19) | Kept by request id, four per requester, served in turn | wappensc/tdsp#31: several devices of one member asking at once each get their answer. |
| LOS-4 | The latest report of each of a member's streams is judged — a heartbeat, a request, an answer's last piece —, those of one's own member too | wappensc/tdsp#31: a person may write from several devices, and one device's heartbeat must not hide another's. |
| LOS-8 (with LOS-19 and LOS-20) | Only without a cursor; a truncated history sets `force`, and ends for anyone but the creator only with an answer that brings control state | E: where the bridge offers a cursor, its answer replaces the guess (LOS-9). |
| INV-6 | `policy` is an unknown parameter | B. |
| TRN-13 | A transport profile is `{ bounds, pacing }` | B: a transport suggests its pacing; named presets belong to applications. |
| ATR-1 | Only an answer to a request made while the engine held nothing is adopted wholesale | An engine that restarted with content keeps the attribution it restored; 1.x left open whether its answer was a bootstrap response. |
| ATR-2, RSY-13 | Unattributed text is `authorId: null` in an overlay and no member's last edit | 1.x named an unattributed author but gave it no form on the wire; a MemberId invented for it is shown as a person by another implementation. |
| DCL-1 | No `decline` for an invitation of another version; the person is told instead | 1.x asked for `unsupported-version`, which no creator could receive: the creator's engine rejects a frame of another version (VER-1), and an invitation of another version cannot be read (INV-6). |
| FRM-7 | A rejection carries the delivery's sender | So that an application can say whom a version skew concerns (VER-4). |
| PRF-6, LIF-5 | Restored control state is what CTL-26 persists; an application marks a document it creates before the initial state goes out, and resumes one without control state as a new device of the creator | A: the persisted form changed with the control state, and a new device decides at once (CTL-27). Creating a document issues no operation, so without the mark a stop right after creating it left nothing that said it existed. |
| LAY-2 | A copy is the same document; a new document from its content, and an export, may leave layers out and say so | Whether continuing in a new document was a copy that must keep every layer was left open. |
| DCL-3 | At most one report per sender for as long as the engine runs; across a restart, what a person saw is the application's to remember | An engine keeps no state of a decline, so the 1.x wording could not be kept across a restart. |
| RSY-5, RSY-14 | A device of the creator is bootstrapped by any answer to its own request, and at once with restored content and a basis; its automatic requests on loss evidence do not depend on its bootstrap | A: a restarted device of the creator otherwise asked for a bootstrap no one owed it, and stopped asking about real evidence once those attempts ran out. |
| LIF-6 | After a close, an operation issued before it still goes out | A: it already holds on its device, and receivers must learn of it to agree. |
| CTL-13 | A revoked member is refused as a reader is, on the document and on every layer; only an unknown permission refuses nothing after the bootstrap | 1.x took a revoked member for one the creator had not named: with operations merged, concurrent `read` and revoke ended in writing, against both intents. |

**New:**

| Requirements | What | Why |
|---|---|---|
| FRM-14 | No entry of 0 in a control vector; one received is read as absent | The control digest is computed over the vectors a participant holds; two spellings of one state would make equal states look diverged. |
| FRM-13 | Which reason a frame with several faults is rejected for: the version before the kind, the kind before the fields | A frame of another version is judged by its version alone, which is what an application shows a person (VER-4). |
| FRM-9 to FRM-12 (with FRM-15 to FRM-17) | Extension fields, `crit`, their bounds and what a definition states; an extension is not passed on | C; wappensc/tdsp#71 V3: ignoring an extension is not passing it on. |
| FRM-15 to FRM-17 | Parts of FRM-9, FRM-10 and FRM-12 as requirements of their own: an extension's name (FRM-15), checking the value of an extension one implements (FRM-16), what an engine keeps and passes on of an extension (FRM-17) | Readability: each was a part of a longer requirement, and requires what it did there |
| ARC-5 | An application may carry a document between one person's devices through another service, and tells the person | ARC-1 concerns participants; it said nothing about one person's devices, which a messenger without history cannot bring up to date. |
| INV-9 | Joining on another device of the person without asking again, when the confirmation travels from where the person gave it | INV-3 protects the creator's identity; the service that carries it is trusted as the person's machine. |
| TRN-20 (with TRN-22) | A send refused as `needs-person` is kept, shown, and tried again when the application says the person acted, or after the longest back-off | The person can lift the refusal and waiting cannot; without its own handling it would spin or be dropped. |
| TRN-18 (with TRN-21), TRN-19 | An optional cursor with `truncated`, answered in the window's order, and truncated also behind what the bridge passed over; a bridge instance id, the epoch of the window, that changes whenever the bridge may have lost something | E: the engine continues after the last delivery an answer held; a gap the bridge skipped, or a loss in a restart, is what it cannot see by itself. |
| TRN-21, TRN-22 | Parts of TRN-18 and TRN-20 as requirements of their own: the order of a `receiveSince` answer (TRN-21), what the application shows while sending waits for the person (TRN-22) | Readability: each was a part of a longer requirement, and requires what it did there |
| CTL-20 to CTL-29 (with CTL-38 and CTL-40) | Operations, merging, the snapshot, persistence, a new device of the creator; reported counters only for a device without a basis; a basis persisted with the state, a cursor never restored ahead of the control state, and holding every message as the alternative to persisting synchronously | A. |
| CTL-33 | What only members hold shown to a device of the creator, with the values reported; resolved by an explicit confirmation that counts the reported counters as seen | A: deciding a target again superseded a vanished device's decision only when it was narrower; automatic is only what a rule merges without a question of authority. |
| PRF-1, item 9 | Reading an update and a state vector without applying them; one the profile cannot read, or with a byte after it, rejects its frame (§4.4) | A frame is checked whole before anything of it is applied (FRM-6), and CRDT libraries fail differently on bytes they cannot read: one throws, another has applied part already. |
| LOS-12, CTL-31; PRF-1, item 8 | State digests beside the vectors in heartbeats, requests and an answer's last piece; a receiver that holds a sender's vector compares what it deleted within it, and different digests are evidence and something to offer; a device of the creator learns of a collision from a report | wappensc/tdsp#71: a vector counts what was inserted or issued, so a lost deletion and two operations under one dot went unseen; the digest is a fixed 8 bytes. A review of draft 2: compared at equal vectors only, a lost deletion stayed unseen at a receiver that had edited since. |
| LOS-13, LOS-14 (with LOS-17, LOS-18, LOS-21 and LOS-22) | Streams: a heartbeat, a request and an answer name their sender's engine as it runs now and number its reports; a report replaces only an older one of its stream; an answer applied whole ends a difference in digests; an answer's pieces are numbered, the last with the count, and one with a piece missing is evidence, counted apart from the stream's reports and its other answers, until it is whole or the stream's state at a higher number is held; copies count once, pieces that disagree are never whole, an answer given up for a bound stays evidence | A review of draft 2: kept by member, a lagging device's report ended the evidence another device's had shown, and a receiver that held more than an answer could not tell whether a piece of it was missing. A review of draft 3: a piece of a later answer of the same stream, to someone else, ended the evidence of an incomplete one. |
| LAY-5, LAY-6 (with LAY-7) | A member's right on a layer, inherited from the document where the creator set none or reset it (`null`); of concurrent values `read` before inherit before `write` (CTL-23), the narrowest effective right whatever the permission on the document; none for a revoked member; enforced by the sending engine, a change that touches a layer it may not write refused whole | wappensc/tdsp#33 (L5) and #50 (no. 2): commenting on content one may only read, and its opposite, without a value beyond `read` and `write`. Ordered with inherit as the narrowest value, a concurrent reset undid a restriction and let a member write who should only read. |
| LAY-7 | Part of LAY-6 as a requirement of its own: how an engine tells what a change touches, and that it refuses or holds a change whole | Readability: it was a part of a longer requirement, and requires what it did there |
| CTL-30, CTL-32 | Bounds on device tags, targets, holes and bytes; the operation that fills a hole is never refused for them; at a bound, the first in code point order are kept, a close always; a creator issues nothing the bounds or one answer could not hold, a new target only up to 1 MiB of the 3 MiB a receiver holds; beyond the bytes, a capacity conflict: no new target, no edit of one's own, shown until a person resolves it; the bytes are measured without the close, which no bound refuses and every device of the creator can always issue; the close keeps each device's latest of 64 devices and no `seen`, and a target's `seen` over 64 devices is refused like the bytes | A: a set of operations would otherwise let a forged or broken creator application make every receiver keep anything (§1.7, item 11). Refusing a union over the bytes whole left receivers of the same operations with different rights; two bounds keep devices that grew apart mergeable, and the conflict names what is left. A review of draft 3: at the bound a full document could not be closed; the room between the two bounds was no reserve, since changes of targets held used it too. A review of draft 4: the close, out of the bytes, was bounded by nothing, and any target's `seen` could name more devices than a snapshot carries — states the own decoder refused. |
| CTL-34 to CTL-43 | Parts of CTL-30, CTL-26, CTL-13 and CTL-33 as requirements of their own: how the bytes are measured (CTL-34), what is kept at a bound (CTL-35), the close beyond every bound (CTL-36), what a device of the creator may issue (CTL-37), persisting asynchronously (CTL-38), the control state of any other participant (CTL-39), the control state and the cursor (CTL-40), the bootstrap after a restart (CTL-41), holding changes (CTL-42), showing divergences (CTL-43) | Readability: each was one clause of a longer requirement, and requires what it did there |
| RSY-16, RSY-17 | A control vector and `force` in requests, `null` until a member is bootstrapped, whatever it restored; when to answer | A. |
| RSY-18, RSY-19 | Parts of RSY-8 and RSY-9 as requirements of their own: the numbers and the state an answer's pieces carry (RSY-18), how the requests kept are keyed, ordered and bounded (RSY-19) | Readability: each was a part of a longer requirement, and requires what it did there |
| SND-14 to SND-16 | `due`, the pace, local pacing | B. |
| SND-17 to SND-19 | Pieces | D. |
| SND-20 to SND-24 | Parts of SND-2, SND-8 and SND-11 as requirements of their own: which messages go first and which are retried (SND-20), what the application shows of undistributed changes (SND-21), a refusal the profile ruled out (SND-22), when a heartbeat goes (SND-23), the heartbeat a request stating one's own state calls for (SND-24) | Readability: each was a part of a longer requirement, and requires what it did there |
| LOS-9 | The cursor and the instance id replace LOS-8's guess; a new instance is evidence on its own, with or without a cursor, and after a restart one other than the instance restored with the cursor (§6.3) | E: a bridge that offers an instance but no cursor still shows a restart; restored with the cursor, the instance shows what a bridge lost while the engine was gone. |
| LOS-10, LOS-11 (with LOS-16) | A gap per device; silence judged by `due`, or the pace when longer; another device of one's own member counts like anyone, one's own frames coming back do not; a heartbeat ends the expectations of the frames it holds, a further frame those of its own source | A, B; and wappensc/tdsp#31: a person may write from several devices, and each must notice the others' losses. |
| LOS-15 to LOS-22 | Parts of the opening of §10, LOS-11, LOS-13, LOS-8 and LOS-14 as requirements of their own: no evidence is no claim of completeness (LOS-15), what ends an expectation (LOS-16), which reports are kept (LOS-17), what ends what a report shows (LOS-18), answering a truncated history (LOS-19), its end at the creator (LOS-20), an answer counted apart and when its evidence ends (LOS-21), pieces that disagree, and bounds (LOS-22) | Readability: each was a part of a longer requirement, or of the section's opening, and requires what it did there |
| YJS-4 | A receiver applies content YJS-1 forbids, and projects it one way | A CRDT cannot refuse part of the state it converges to, and engines that project it differently disagree about every attribution offset after it. |
| VER-3 | The draft marker | A draft must never leave frames that a released 2.0 would read as its own. |
| VER-4 | An application shows whose frames are of another version | VER-1's loud failure reached only the application, and the person saw a silent participant instead. |
| VER-5 (new, with VER-6) | What a revision that defines a new right must define: capabilities per value, a merge that grants no more than every merged value, commutative, associative and idempotent, decisions in knowledge of others superseding, revocation first, and how older implementations are kept from reading it as `write` or inherit | An outside review of draft 3: a third right was not to be invented now, but the rules any later one must keep were to be laid down; a total order does not fit every model. |
| VER-6 | Part of VER-5 as a requirement of its own: keeping older implementations from taking a new value of a permission or a layer right for `write` or for inherit | Readability: it was a part of a longer requirement, and requires what it did there |

**Moved** into [bindings/](bindings/) (F): §12 (BRG-1 to BRG-17), §12.6 (LBI-1 to
LBI-6, the routes gaining an optional cursor and instance), §13 (BND-1 to BND-3,
SIG-1 to SIG-3, MTX-1 to MTX-4, EML-1 to EML-12) and Appendix C — unchanged in
substance, but for these:

| Requirements | Change | Why |
|---|---|---|
| BRG-1, BRG-8, LBI-6 | Five reasons of §3.4: a send while the bridge is not provisioned, and every refusal only a person can lift, is `needs-person`, `409` over the local bridge interface | 409 already meant a state the person ends, not one waiting ends (TRN-11). |
| BRG-2 | Provisioning keeps credentials from components that render what came through the channel, as ARC-4 | As ARC-4. |
| BRG-9; MTX-7 (new) | The choice between body and attachment may go by the size of the envelope as written; Matrix measures it so, at 32 000 bytes | Escapes in the envelope and Megolm's Base64 let a frame of 32 000 bytes exceed Matrix's 65 536 bytes per event, and a frame within `maxBytes` was refused as too large. |
| BRG-11, BRG-12, SIG-3 | The same message again (same id, same content) is dropped; another message under a delivered id is recorded, not delivered; a shared vocabulary of reasons; a bridge that drops messages of non-members asks the messenger anew each time | The texts did not tell the two apart, so a second message under one id was delivered or dropped without a record; and a remembered "not a member" dropped the first frames of whoever just joined. |
| BRG-14 | A binding says where the messenger's own client fetches attachments, a fetch the bridge cannot bound | §15.5 promised a bound that, on such a messenger, nothing enforces. |
| BRG-17 | A bridge may drop a delivery once the one reader it serves kept it | A bridge that keeps its window on disk need not keep a frame's text a second time; a cursor from before still reads as truncated. |
| BRG-18 (new) | A message a bridge cannot read never keeps it from reading the others; values nested too deep in a messenger's answer may be dropped | One deeply nested event in a Matrix `/sync` stopped a bridge for good: the answer never parsed, and its position never moved. |
| BND-1 | A binding states against whom each property holds, the provider's servers included | An encrypted Matrix room protected against the homeserver only in the wording; MTX-4 is where it does. |
| BND-3 | The 64 hexadecimal digits are ASCII | A Unicode test for hexadecimal digits takes full-width forms too, a second spelling of the same hash. |
| SIG-4, SIG-5 (new) | When a group send is accepted, from `signal-cli`'s result per recipient; a bridge reads a connection before `signal-cli` pushes into it | `signal-cli` reports a group message sent once one member got it, and hands each waiting message to a device once. |
| SIG-6 (new) | A bridge that receives through a subscription reads before it subscribes, again on every connection; it keeps its instance across ending the subscription only if it read up to the answer and its `signal-cli` hands on the message in hand | A subscription lets a bridge stop receiving without closing the connection; `signal-cli` 0.14.9 drops the message it is handling when the last subscription ends. |
| MTX-4 | Room keys only to devices their owners signed, the bridge's own device signed, frames only from signed devices (older sessions excepted); MTX-5 (new): an unencrypted TDSP event in an encrypted room is ignored | Shared with every device, as 1.x said, a key reached any device a homeserver added, and frames from such a device were delivered; Matrix clients now exclude unsigned devices (MSC4153), and a bridge that does not is not given keys by them. |
| MTX-6 (new) | The wait of a Matrix rate limit from the `Retry-After` header, the body's `retry_after_ms` only without one | Matrix 1.10 moved the wait into the header (MSC4041). |

**On the wire:** frames carry `"tdsp": 2`; `edit` and `control` frames carry
`due`; a `control` frame is one operation (`device`, `counter`, `target`, `value`,
`seen`) instead of a numbered action, and may aim at a member's right on a layer;
a `heartbeat` carries a control vector or
`null` instead of `controlSequence`; a `resync-request` carries a control vector or
`null` and `force` instead of `controlSequence` and `bootstrap`; a `heartbeat`, a
`resync-request` and every piece of a `resync-response` name their sender's stream
and a number in it, and every piece of an answer its own number, the last the
count; the snapshot is a
set of operations per target with a control vector and the counters held above a
hole; the `fragment` kind is gone;
any frame may carry extension fields and `crit`; a `heartbeat` and a
`resync-request` carry digests beside their vectors, and an answer's last piece the
responder's state vector and digest; an overlay's range may name no author
(`authorId: null`); a `resync-response`'s `update` is never empty,
and where nothing is lacking it is the profile's update that holds nothing; an
invitation carries `tdsp=2`
and no `policy`; a transport profile is `{ bounds, pacing }`. The envelope and the
profile `yjs-paragraphs/1` are unchanged.

**Not in 2.0**, though wappensc/tdsp#50 and #71 asked for them:

- *A base profile that keeps anchors.* Splitting a paragraph of `yjs-paragraphs/1`
  still moves the text after the split into new items (Appendix A). A profile
  defined outside this specification (§5.5) can keep anchors and formatting across
  splits, with one text for the whole document and paragraph breaks inside it.
- *A migration of 1.x documents.* This specification defines none. A 1.x document
  stays a 1.x document; an application that moves one to 2.0 creates a new document
  (§6.2) from its state and invites its members again.
- *A second, independently written implementation*, which would show whether this
  core is simpler to build than 1.x's ([CONFORMANCE.md](../../CONFORMANCE.md)).
