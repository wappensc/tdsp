# TDSP — Together Document Sync Protocol

**Specification · TDSP 1.0 · 26 September 2026**

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
  exception, [§13.4](#134-email)).
- **The transport is assumed to be poor.** Messages may be delayed by tens of
  seconds, duplicated, reordered, rate-limited, size-limited and lost, and a
  newly joined participant may see nothing that was sent before it joined.
  Every mechanism in this specification is built for that transport; a better
  one simply converges faster.

The name is deliberately about the *document*, not the carrier: the carrier is
replaceable ([§2.1](#21-layers)).

### 1.2 Status of this document

This is **TDSP 1.0**. A later version changes the wire only as
[§14](#14-versioning-and-extensibility) describes.

TDSP adds no security layer of its own; its security properties are those of
the messenger it runs on, plus what [§15.3](#153-what-tdsp-enforces-itself)
enforces. No property below is stronger than the tests and the threat model
behind it.

This document is self-contained: every requirement states its reason. It
depends on no other document except the standards it cites (RFC 2119, RFC 8174,
RFC 3629, RFC 4648, RFC 8259) and, for the one profile it defines, the Yjs
encodings named in [Appendix A](#appendix-a-profile-yjs-paragraphs1). A
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
  *withdrawn*; an ID is never reused. The prefix names the section's topic.
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
| **engine** | The protocol engine for one document at one participant: frames, control state, bootstrap and resync, send scheduling, fragmentation, loss detection ([§4](#4-the-payload-frame)–[§10](#10-loss-detection)) |
| **adapter** | Implements the transport contract ([§3](#3-the-transport-contract)) for one messenger, by talking to its bridge |
| **bridge** | Holds one messenger account's credentials, speaks the messenger's own protocol, and carries frames in the messenger binding's envelope ([§13](#13-messenger-bindings)) |

A product may implement several classes at once. It conforms to a class when
it satisfies every MUST and MUST NOT requirement of that class, including those
of the messenger binding it uses. The local bridge interface of
[§12](#126-the-local-bridge-interface-optional) is an option: its requirements
bind an adapter and a bridge that communicate across a process boundary through
it, and no one else.

### 1.5 Terminology

| Term | Meaning |
|---|---|
| **Document** | One collaboratively edited text, identified by a **documentId** and bound to exactly one channel |
| **Participant**, **member** | A person taking part in a document, identified by a **MemberId**: the messenger's own identity for them (a Signal account, a Matrix user id, an email address) |
| **Creator** | The one participant who created a document. Fixed at creation, never transferable; the document's single authority ([§2.3](#23-the-creator-is-the-single-authority)) |
| **Engine** | The component that runs the protocol for one document ([§1.4](#14-conformance-classes)) |
| **Messenger** | The system that carries messages between participants — a messaging service, or any other message system with the properties of [§15.1](#151-what-a-messenger-must-provide) |
| **Channel** | The messenger-level conversation a document rides on: a Signal group, a Matrix room, an email thread with a fixed participant set. Set up by people, not by TDSP |
| **Binding** | The association of a documentId with a channel, held by a bridge; also, a messenger binding: how frames travel on one messenger ([§13](#13-messenger-bindings)) |
| **Delivery** | One received message, as the transport contract presents it: an id, a documentId, a sender and a payload |
| **Frame** | The payload of one delivery: a JSON object ([§4](#4-the-payload-frame)) |
| **Envelope** | The messenger-level wrapper around a frame, read only by bridges ([§13.1](#131-the-common-envelope)) |
| **Profile** | What a document's content bytes mean: its CRDT, structure and text projection, named by an id such as `yjs-paragraphs/1` ([§5](#5-document-profiles)) |
| **Update** | An opaque CRDT update: the unit of document change |
| **State vector** | A compact summary of which updates a CRDT replica has seen |
| **Control state** | A document's membership map, closed flag and send policy, set only by the creator ([§7](#7-control-state)) |
| **Control sequence** | The creator-issued counter that orders control messages ([§7.2](#72-sequence-numbers-and-targets)) |
| **Sync policy** | The five numbers that govern when an engine sends ([§9.1](#91-the-sync-policy)) |
| **Transport profile** | A bridge's statement of its messenger's limits and suggested policies ([§3.5](#35-transport-profile)) |
| **Bootstrap** | A joining engine obtaining the current document and control state ([§8](#8-bootstrap-and-resync)) |
| **Resync** | A request for, and answer with, what an engine is missing ([§8](#8-bootstrap-and-resync)) |
| **Invitation** | The information a joiner needs to open a document, sent as a human-readable message ([§11](#11-invitations)) |

### 1.6 Notation

- JSON is RFC 8259, restricted to I-JSON (RFC 7493) in what matters for a single
  reading: no object names a member twice, and no string holds an unpaired
  surrogate. Base64 is the standard alphabet with padding (RFC 4648 §4), and only
  its canonical form: the bits the padding discards are zero, so one text encodes
  one byte string.
- Strings are **UTF-8** (RFC 3629). A length "in bytes" is the length of that
  UTF-8 encoding; a length "in characters" counts Unicode code points.
- An integer field is a JSON number without a fraction or an exponent.
- A duration named `…Ms` is in milliseconds.

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
  ───────── in-process call, or the local bridge interface (§12) ─────
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
([§13.4](#134-email)).

**Why a bridge, and when a process boundary.** The bridge holds the credentials —
a linked Signal device, a Matrix access token and crypto store, a mail password
and a PGP keyring — and speaks the messenger's own protocol. How the adapter
reaches it is an implementation choice. In a native or server-side program the
adapter and the bridge can be one library, called in-process. A web page cannot
do that: it can open no raw TCP connection (SMTP, IMAP), load no native crypto
module, start no process and read no keyring, so its only way to those
capabilities is an HTTP request to a process on the same machine. For that case,
and for reusing a bridge from another language, [§12](#126-the-local-bridge-interface-optional)
defines an optional local HTTP interface. A separate process also keeps the
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
  (LBI-1).
  *Rationale:* TDSP promises that it opens no external connection of its own; the
  only component that talks to the outside world is the bridge, and it talks only
  to its messenger (BRG-4).
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
  to the engine or the application.
  *Rationale:* the component that renders untrusted content should not be able to
  speak as the user on the messenger; a process boundary makes that a property
  of the system rather than of the code's discipline. It is a SHOULD because a
  single-process program without untrusted rendering has no such component to
  separate.

### 2.2 Two envelopes, two readers

One message on the wire carries two nested wrappers with different readers.
Confusing them is the most common way to get this stack wrong.

```text
  messenger message   (a Signal group text · a Matrix event · an email)
  └── envelope   {"tdsp":1,"kind":"frame","documentId":"…","frame":"<the frame as a JSON string>"}
      │          read by the BRIDGE: routing
      └── frame  {"tdsp":1,"kind":"edit","documentId":"…","update":"<Base64>"}
          │      read by the ENGINE: verification and interpretation
          └── update   opaque CRDT bytes, read by the document's PROFILE
```


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
| Issues numbered control messages | Applies them, and notices a gap in the numbers |
| Sets the send policy and carries it in the invitation ([§9](#9-send-scheduling)) | Adopts it, clamped to their own bridge's limits |
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
a policy change at layer 4 and needs no wire change.

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
| `createDocument(documentId, creator)` | Registers the document with the adapter and records `creator` as its creator. Does not create, reconfigure or post into a channel; binding a channel is a bridge operation ([§12.3](#122-binding-a-document)) |
| `send(documentId, sender, payload)` → `DeliveryId` | Broadcasts one frame to every member of the document's channel. Resolves once the messenger has accepted it |
| `receive(documentId, member)` → `Delivery[]` | Returns the deliveries recorded for the document so far |
| `listChannels(member)` → `RawChannel[]` | The channels this account can see, to populate a picker. Answers "which channels exist", never "which documents do I have" |
| `transportProfile()` → `TransportProfile \| undefined` | Optional. The messenger's limits and suggested policies ([§3.5](#35-transport-profile)) |
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
  returned before. It MAY include the receiving member's own messages.
  *Rationale:* a cumulative, unfiltered answer over a bounded window is the
  simplest contract a bridge can meet: filtering is where messages get lost, and
  de-duplication is cheap at the engine. The window keeps a long-lived document's
  answer from growing without end; what slides out before an engine read it is a
  lost message, which loss detection notices in the cases [§10](#10-loss-detection)
  names (LOS-8) and a resync then recovers — not in every case, as §10's limits say.
- **TRN-8** · *engine* — An engine MUST process each `Delivery.id` at most once while
  `receive` keeps returning it, and MUST tolerate receiving its own messages. It MAY
  forget an id once `receive` no longer returns it, except the ids of its own
  recent sends, whose echo may still be on its way. Because a forgotten delivery
  can be offered again (BRG-17), processing a frame a second time MUST NOT change
  the document or control state again: content is a CRDT; a control frame or
  snapshot at or below the engine's control sequence is inert (CTL-5, CTL-6,
  CTL-11); a decline is reported once per sender (DCL-3); an overlay is adopted
  once (RSY-15). A resync request is recognised by its `requestId` (RSY-2) while
  the engine remembers it; one old enough to be forgotten may be answered again.
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
   authentication is worth ([Appendix C](#appendix-c-the-bindings-compared)).

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
and retries what can succeed later and drops what cannot (SND-6, SND-8).

| Reason | Meaning | Retryable |
|---|---|---|
| `rate-limited` | The messenger is throttling. MAY carry `retryAfterMs`, the wait the messenger asked for | Yes |
| `unavailable` | The bridge or the messenger could not be reached or failed | Yes |
| `too-large` | The payload exceeds what one message can carry | No |
| `rejected` | Refused for a reason waiting cannot change: unknown document, forbidden sender, malformed request | No |

- **TRN-11** · *adapter* — A failed `send` MUST reject with one of the four reasons
  above, and SHOULD carry `retryAfterMs` when the messenger stated a wait.
  *Rationale:* the classification is a fact about the messenger that only the
  transport side knows.
- **TRN-12** · *engine* — An engine MUST treat a send failure that carries none of
  the four reasons as `unavailable`.
  *Rationale:* the fault this classification exists to remove is dropping a
  change on an unfamiliar failure; wrongly retrying costs a bounded back-off,
  wrongly dropping costs the document.

### 3.5 Transport profile

A bridge knows its messenger's limits; the engine needs them to schedule sends.
The transport profile carries them:

```json
{
  "bounds":   { "minIntervalMs": 15000, "maxBytes": 4194304 },
  "profiles": [
    { "id": "standard", "label": "Standard", "description": "…",
      "values": { "minIntervalMs": 30000, "maxIntervalMs": 120000,
                  "minChars": 0, "maxChars": null,
                  "expectedLatencyMs": 60000 } }
  ],
  "defaultProfile": "standard"
}
```

- `bounds.minIntervalMs` — the shortest interval between two sends the messenger
  tolerates: a hard floor over every policy. `null` for none.
- `bounds.maxBytes` — the largest frame, in bytes of its UTF-8 text, one message
  can carry, attachments included where the binding has them. Larger frames are
  split by the engine ([§9.4](#94-changes-larger-than-one-message)). `null` for
  none.
- `profiles` — a non-empty array of named sync policies
  ([§9.1](#91-the-sync-policy)) the bridge suggests, in the order an application
  should offer them — an array because a JSON object's member order is not
  something a parser has to keep. Each has an `id` (a non-empty string, unique in
  the array), a `label`, a `description` and `values`, a complete policy: all five
  values, `null` only for `maxIntervalMs` or `maxChars` without a limit.
  `defaultProfile` is the `id` of the one that applies when the creator chooses
  none.

Every field is required. "No bound" and "no limit" are spelled `null`, never by
leaving a field out.

- **TRN-13** · *adapter, engine* — A transport profile MUST be validated as a whole:
  a missing field, a field that is not defined, a number that is negative or not
  finite, `null` where it is not allowed, an empty `profiles` array, two profiles
  with one `id`, a profile without a string `id`, `label` and `description`, or a
  `defaultProfile` that names no profile MUST make the whole
  profile invalid, and an invalid profile MUST cause the call to fail rather than
  be treated as "no profile".
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
  profile with no floor and one policy equal to the engine's defaults, which has
  the same effect.)

### 3.6 Conformance suite

`packages/messenger-port/src/contract.ts` exports the transport conformance
cases. Each runs with a fresh fixture of two ports, a creator and a member, and
polls for up to 15 seconds because real adapters deliver asynchronously:

1. A member's `send()` arrives in the other member's `receive()` unchanged,
   with the right `sender`.
2. A `send()` for a document that was never registered is refused with a
   `TransportSendError` whose reason is not retryable.

- **TRN-16** · *adapter* — An adapter MUST pass the conformance suite against its
  real messenger, with two real accounts, repeatedly.
  *Rationale:* asynchronous delivery makes an intermittent failure a real defect,
  not noise; one green run proves little.

Deliberately not covered: `listChannels`, the stability of `Delivery.id` across
polls, and ordering. Rules that are application policy — a read-only member does
not send, only the creator changes membership, nothing is sent after a close —
are tested once in the engine's own suite, not per adapter.

For the wire itself, the reference implementation publishes versioned **test
vectors** (informative): `packages/document-protocol/test-vectors/frames-v1.json`
— frames that must decode to a given kind, and frames that must be rejected with
a given reason from [§4.4](#44-decoding-and-rejection) — and `invitations-v1.json`
for the link of [§11.3](#113-invitation-as-a-link); and, for the email binding,
`bridges/email-bridge/test-vectors/member-ids-v1.json` for the canonical MemberId of
EML-10. An implementation in another
language shows it reads the wire as this specification does by passing them; the
reference implementation checks itself against the same files.

## 4. The payload frame

Every payload an engine sends, and every payload it accepts, is exactly one
frame: a JSON object (RFC 8259) serialised as text. Binary data inside it — CRDT
updates, state vectors, the slices of a fragmented frame — is Base64 (RFC 4648
§4, with padding).

The frame is text for the reason the envelope is: a message that looks like text
should behave like text, it can be read and debugged with ordinary tools, and one
encoding runs through the whole stack. It costs little. The envelope carries the
frame as a JSON *string*, not as Base64 ([§13.1](#131-the-common-envelope)), so
the CRDT bytes are Base64-encoded exactly once on their way to the messenger, and
the field names add a few dozen bytes to a message whose limits are counted in
messages rather than bytes.

### 4.1 Common fields

Every frame has these three fields:

| Field | Type | Meaning |
|---|---|---|
| `tdsp` | integer | The frame format version: 1 |
| `kind` | string | What the frame is ([§4.2](#42-kinds)) |
| `documentId` | string | The document, 1 to 255 bytes in UTF-8 |

- **FRM-1** · *engine* — Every payload an engine passes to `send()` MUST be exactly
  one frame as defined in this section, serialised as UTF-8 JSON text, and an engine
  MUST NOT process a payload that does not decode as one.
  *Rationale:* a single framed format with no unframed fallback means a payload
  from an unrelated protocol, an old version or a corrupted message fails loudly
  instead of reaching the CRDT, which would otherwise apply it or crash unpredictably.
- **FRM-2** · *engine* — A sender MUST write `"tdsp": 1`.
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
| `edit` | any member permitted to write | A CRDT update |
| `resync-request` | any member | What the requester already has ([§8](#8-bootstrap-and-resync)) |
| `resync-response` | the creator; a peer only to the creator ([§8.3](#83-who-answers)) | An update, a control snapshot and an attribution overlay |
| `control` | the creator only | A membership change, the close, or a policy change ([§7](#7-control-state)) |
| `heartbeat` | any member | The sender's latest control sequence and state vector ([§9.3](#93-heartbeat)) |
| `fragment` | any member | One slice of another frame ([§9.4](#94-changes-larger-than-one-message)) |
| `decline` | any member of the channel, joined or not | Why an invitation was declined ([§6.5](#65-declining-an-invitation)) |

### 4.3 Kind-specific fields

"Base64" is a string of Base64 text; "uint32" is a JSON integer from 0 to
4 294 967 295, written without a fraction or an exponent.

| Kind | Field | Type | Meaning |
|---|---|---|---|
| `edit` | `update` | Base64, not empty | A CRDT update ([§5](#5-document-profiles)) |
| `resync-request` | `requestId` | 16 lowercase hex digits | Random, chosen by the requester, new for every request; what the answer names (RSY-2) |
| | `bootstrap` | boolean | `true` when the requester needs an answer even if its state vector looks current: before its bootstrap (RSY-14), or with *history truncated* evidence (LOS-8) |
| | `controlSequence` | uint32 | The requester's contiguous control sequence (CTL-9) |
| | `stateVector` | Base64 | The requester's state vector |
| `resync-response` | `respondsTo` | 16 lowercase hex digits | The `requestId` of the request answered |
| | `update` | Base64 | What the requester lacks |
| | `control` | object or `null` | The creator's control snapshot, in the layout of [§7.4](#74-the-control-snapshot); `null` from anyone else |
| | `attribution` | object or `null` | The responder's attribution overlay, in the layout of [§5.4](#54-attribution-overlay); `null` for none |
| `control` | `sequence` | uint32, at least 1 | The creator's control sequence ([§7.2](#72-sequence-numbers-and-targets)) |
| | `action` | `"membership"`, `"close"` or `"policy"` | |
| | `member` | string, 1–255 bytes | membership only: the member concerned |
| | `permission` | `"read"`, `"write"` or `null` | membership only: `null` revokes |
| | `policy` | object | policy only: a sync policy ([§9.1](#91-the-sync-policy)) with all five values; `null` only as the value of `maxIntervalMs` or `maxChars`, for "no limit" |
| `heartbeat` | `controlSequence` | uint32 | The creator's highest issued control sequence; 0 from anyone else |
| | `stateVector` | Base64 | The sender's state vector |
| `fragment` | `messageId` | 16 lowercase hex digits | Random; the same for every fragment of one frame |
| | `index` | integer, 0 ≤ index < total | This slice's position |
| | `total` | integer, 1–65 535 | How many slices the frame was cut into |
| | `slice` | Base64, not empty | The bytes of this slice of the fragmented frame's UTF-8 text |
| `decline` | `reason` | `"unsupported-profile"`, `"unsupported-version"`, `"declined"` or `"other"` | Why ([§6.5](#65-declining-an-invitation)) |
| | `profiles` | array of profile ids, at most 16 | optional: the document profiles the sender implements |
| | `text` | string, at most 500 characters | optional: a human-readable explanation |

A `control` frame carries, besides `sequence` and `action`, exactly the fields
its action needs:

| `action` | Required | Forbidden |
|---|---|---|
| `membership` | `member`, `permission` (`null` revokes) | `policy` |
| `policy` | `policy` | `member`, `permission` |
| `close` | — | `member`, `permission`, `policy` |

- **FRM-5** · *engine* — A sender MUST write exactly the fields its frame's kind
  defines — the common ones, every required one, and an optional one only where
  it has a value — and nothing else.
  *Rationale:* a layout with a single reading is what lets two independent
  implementations interoperate; an extra field would be a covert, unversioned
  extension point.

### 4.4 Decoding and rejection

A receiver parses a frame, then checks that it belongs to the document the
delivery was routed to. Each failure has a name, so that an implementation's
report — and a test — can tell a version mismatch from a malformed message:

| Reason | When |
|---|---|
| `not-json` | The payload is not valid UTF-8, not valid JSON, not a JSON object, or not I-JSON: an object names a member twice, or a string holds an unpaired surrogate ([§1.6](#16-notation)) |
| `unsupported-version` | `tdsp` is missing or is not 1 |
| `unknown-kind` | `kind` is not one of §4.2 |
| `missing-field` | A field the kind requires is absent |
| `invalid-field` | A field has the wrong type or a value the layout forbids — an integer out of range, Base64 that does not decode, an empty `update` or `slice`, `index ≥ total`, an unknown `action`, `reason` or `permission`, an overlong `text`, a snapshot or overlay that breaks its layout (§5.4, §7.4) — or the frame, a snapshot, a policy or an overlay has a field its layout does not define |
| `document-mismatch` | The frame's documentId is not the document the delivery was routed to |

- **FRM-6** · *engine* — A receiver MUST reject a frame for each condition in the
  table above and MUST NOT apply any part of a rejected frame, attempt a partial
  parse or fall back to another interpretation. It MUST check the whole frame —
  a `resync-response`'s snapshot, its policy and its overlay included — before it
  applies anything of it. An optional part may be absent or `null` where its
  layout says so; one that is present and invalid rejects the frame.
  *Rationale:* every best-effort parse is a place where two implementations
  disagree about what a message meant; a document that forks silently is worse
  than one that reports an error.
- **FRM-7** · *engine* — A rejection MUST be reported to the application as an
  error that carries the reason. Nothing is sent to the other participants.
  *Rationale:* by the time a frame reaches the engine, the bridge has already
  routed it here on purpose (BRG-10); a frame that then fails is evidence of a
  version skew, a misrouting bug or an attack, and all three need to be seen —
  locally. Telling the sender over the channel would be one more message anyone
  could provoke.
- **FRM-8** · *engine* — A receiver MUST compare the frame's documentId with the
  document the delivery was routed to and reject a mismatch
  (`document-mismatch`), even though the bridge routed by an equal value.
  *Rationale:* this verification copy is what catches a bridge that routes
  wrongly; see [§2.2](#22-two-envelopes-two-readers).

### 4.5 Example

A real `edit` frame for documentId `doc-a1b2c3`, produced by the reference
encoder. Its update is the whole state of a new `yjs-paragraphs/1` document
whose first paragraph holds "Hi" — one Yjs client, clocks 0 to 3:

```json
{"tdsp":1,"kind":"edit","documentId":"doc-a1b2c3","update":"AQOJmvSYDwAHAQdjb250ZW50AwlwYXJhZ3JhcGgHAIma9JgPAAYEAIma9JgPAQJIaQA="}
```

The Yjs update is 50 bytes and its Base64 text 68; the frame is 130 bytes, the
other 62 being the field names, the kind, the documentId and JSON punctuation. [Appendix D](#appendix-d-example-frames)
has one frame of each other kind.

## 5. Document profiles

The engine treats the document's content as opaque: it moves CRDT updates and
state vectors, and asks a small set of questions about them. What the bytes
mean — which CRDT, which document structure, how text is projected for
attribution — is fixed by the document's **profile**.

A profile is named by an id of the form `<name>/<major>`, for example
`yjs-paragraphs/1`. The name is lowercase letters, digits, `.` and `-`; a profile
defined outside this specification uses a reverse-DNS name under a domain its
author controls (`com.example.markdown/1`). An incompatible change to a profile is
a new major version, and a new profile id. This specification defines one profile,
`yjs-paragraphs/1`, in [Appendix A](#appendix-a-profile-yjs-paragraphs1).

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
     updates a replica lacks;
  5. the **initial state** a creator seeds a new document with;
  6. a deterministic **plain-text projection** of the document and the unit its
     offsets count in, for attribution ([§5.4](#54-attribution-overlay)).

  *Rationale:* these are exactly the operations bootstrap, resync, the heartbeat,
  loss detection and attribution use; a CRDT that offers them can carry a TDSP
  document, whatever else it does.

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

The profile travels in the invitation ([§11](#11-invitations)) and in the
creator's control snapshot ([§7.4](#74-the-control-snapshot)), which lets a joiner
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
`[start, end)`; `lastEditBySender` maps a MemberId to the offset just after that
member's most recent edit. `null` means "no attribution offered".

The layout is closed: an overlay has exactly `ranges` and `lastEditBySender`; each
range has exactly `start`, `end` (uint32) and `authorId` (1–255 UTF-8 bytes); the
first range starts at 0, each further range starts where the previous one ended,
and no range is empty (`end > start`), so the ranges neither overlap nor leave a
gap. Every value of `lastEditBySender` is a uint32, keyed by a MemberId. An
overlay that breaks this rejects the whole frame (FRM-6).

- **ATR-1** · *engine* — When a bootstrap response is applied to a document whose
  projection length equals the total length the overlay's ranges describe, the
  engine SHOULD adopt the overlay's ranges wholesale.
  *Rationale:* at a true bootstrap the overlay describes exactly the document the
  joiner has just received.
- **ATR-2** · *engine* — When the lengths differ — the response healed only part
  of a gap, or it answers a restarted creator that already holds content — the engine MUST
  NOT adopt ranges wholesale, MUST leave its own and normally received ranges
  unchanged, and MUST attribute content it cannot place to an *unattributed*
  author rather than to the responder.
  *Rationale:* the overlay's offsets are into the responder's view, not the
  receiver's; a confident misattribution is worse than none.
- **ATR-3** · *engine, application* — Attribution MUST NOT be presented or used as
  authentication of authorship.
  *Rationale:* the overlay is the responder's claim about *other people's* text,
  and nothing verifies it; only a delivery's own sender is authenticated, and
  only as far as the messenger is ([§15](#15-security-considerations)).

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
  MUST rejoin it as creator with its persisted control state (CTL-12), and MUST
  NOT create it anew.
  *Rationale:* creating anew seeds an empty document over real content and
  restarts the control sequence at 1, after which every participant rejects the
  creator's frames as stale.

### 6.4 Closing a document

Closing marks a document as finished. It is the only lifecycle transition after
creation, and it is a control action ([§7](#7-control-state)).

- **LIF-6** · *engine* — After it has applied a close, an engine MUST NOT send
  `edit` frames of its own, and a creator MUST NOT issue further control frames.
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
  it (LOS-3). An application SHOULD show a closed document as still
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
  invitation's profile, or its frame or envelope version, SHOULD send a `decline`
  with the reason `unsupported-profile` or `unsupported-version` and the profiles
  its engine implements. A person who does not want to join MAY decline with the
  reason `declined`.
  *Rationale:* without a message nobody learns why a participant never appears;
  with the list of implemented profiles the creator knows what to invite with.
- **DCL-2** · *engine* — An engine MUST offer a decline operation that needs no
  join: given the documentId, the decliner's own MemberId and a transport whose
  bridge has the document bound, it sends exactly one `decline` frame — through
  the send scheduler, like every message (SND-2) — and keeps no document state.
  *Rationale:* the typical decliner cannot join, since it cannot read the
  document; a `decline` frame depends on no profile, so any engine can send one.
- **DCL-3** · *engine* — A receiving engine MUST NOT change any state because of a
  `decline`. It MUST report it to its application — sender, reason, profiles and
  text — and MUST report at most one `decline` per sender and document.
  *Rationale:* a decline is information, not authority, and anyone in the channel
  can send one; reporting each sender once keeps a forged or repeated decline
  from flooding what a person sees.
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

### 7.1 What control state is

A document's control state is:

- a **membership map** from MemberId to `read` or `write` — who may edit;
- a **closed** flag;
- the **sync policy** the creator set ([§9.1](#91-the-sync-policy)), with the
  control sequence it was set at (`policySequence`, 0 for the policy the document
  was created with);
- the control **sequence** it is current as of.

The creator is never in the membership map: its permission is `creator`, fixed
(LIF-2). A MemberId absent from the map has an *unknown* permission.

- **CTL-1** · *engine* — Control state MUST be changed only by applying a
  `control` frame or a control snapshot as this section prescribes.
  *Rationale:* a single path for authority is what makes it checkable.

### 7.2 Sequence numbers and targets

Every control frame carries a **sequence number** issued by the creator. One
counter per document suffices because only the creator issues control frames.
Each frame has a **target**: the member it names (membership), the close
(close), or the policy (policy).

- **CTL-2** · *engine* — The creator MUST number its control frames 1, 2, 3, …
  without gaps, MUST send them one at a time, and MUST NOT consume a number for a
  frame whose send failed.
  *Rationale:* receivers treat a missing number as a lost message (CTL-8); a
  skipped number would look like a loss to every receiver forever.
- **CTL-3** · *engine* — The creator MUST apply its own control frame only after
  the send has succeeded.
  *Rationale:* otherwise the creator's state claims a change no one else can ever
  receive.
- **CTL-4** · *engine* — Only the creator MAY send a `control` frame; a membership
  frame MUST NOT name the creator and MUST NOT carry the permission `creator`
  (the wire has no value for it).
  *Rationale:* the creator's role is fixed (LIF-2) and cannot be granted,
  transferred or revoked.
- **CTL-5** · *engine* — A receiver MUST apply a `control` frame if and only if
  (a) its `Delivery.sender` is exactly the document's creator, (b) it does not
  name the creator, and (c) its sequence is greater than both the last sequence
  applied *for the same target* and the snapshot floor (CTL-11). The comparison of
  sender and creator is exact equality of MemberIds.
  *Rationale:* (a) is the whole membership-integrity design. (c) per target makes a
  replayed frame inert while a late frame for a member nobody has mentioned since
  still applies; a single global "last applied" would drop that late frame for good.
- **CTL-6** · *engine* — A receiver MUST reject — and report — a control frame from
  anyone but the creator, a control frame that names the creator, and every
  control frame while it does not know the creator. It MUST drop a stale frame
  (condition (c) fails) silently.
  *Rationale:* a frame from a non-creator is an anomaly worth seeing; a stale
  frame is the expected result of a duplicate or replay, which is exactly what the
  sequence number exists to make harmless.
- **CTL-7** · *engine* — An engine MUST NOT reject an `edit` frame because its sender
  lacks `write` permission in the receiver's current control state.
  *Rationale:* a grant and the first edit made under it are unordered on the
  transport; rejecting on a grant that has not arrived yet would create a
  permanent gap in the document. Permissions are enforced by the sender's own
  engine (CTL-13), which is what honest participants run (§15.2).

### 7.3 Noticing a lost control frame

- **CTL-8** · *engine* — A receiver MUST track the highest control sequence it has
  seen and the highest **contiguous** sequence — the largest *n* such that every
  number from 1 to *n* has been applied or covered by a snapshot — and MUST treat
  any number below the highest seen that has not arrived as a gap.
  *Rationale:* the creator's numbering is gap-free (CTL-2), so a hole in what a
  receiver holds is proof that something was lost.
- **CTL-9** · *engine* — The `controlSequence` an engine puts in its resync requests
  MUST be its highest contiguous sequence; the `controlSequence` the creator puts
  in its heartbeat MUST be its highest issued sequence. Receivers MUST believe a
  heartbeat's `controlSequence` only when the heartbeat is from the creator.
  *Rationale:* the first tells the creator whether a requester is behind on
  control state even when it lacks no content; the second makes even the *last*
  control frame's loss detectable; only the creator's own claim about its counter
  is evidence.

### 7.4 The control snapshot

The creator's `resync-response` carries its whole control state as the frame's
`control` object:

```json
{
  "profile": "yjs-paragraphs/1",
  "sequence": 7,
  "closed": false,
  "members": { "bob": "write", "carol": "read" },
  "policy": { "minIntervalMs": 30000, "maxIntervalMs": 120000, "minChars": 0,
              "maxChars": null, "expectedLatencyMs": 60000 },
  "policySequence": 4
}
```

The layout is closed:

| Field | Required | Value |
|---|---|---|
| `profile` | yes | A profile id ([§5](#5-document-profiles)) |
| `sequence` | yes | uint32: the creator's highest issued control sequence |
| `closed` | yes | `true` or `false` |
| `members` | yes | An object of at most 10 000 entries, each a MemberId (1–255 UTF-8 bytes) mapped to `"read"` or `"write"`; never the creator |
| `policy` | together with `policySequence` | A sync policy with all five values; `null` only for `maxIntervalMs` and `maxChars`, meaning "no limit" (JSON cannot spell infinity) |
| `policySequence` | together with `policy` | uint32, no greater than `sequence` |

A snapshot that breaks this layout — a field not listed, `policy` without
`policySequence` or the reverse, a member named twice in the JSON, the creator
among the members — rejects the whole `resync-response` (FRM-6).

- **CTL-10** · *engine* — A receiver MUST reject a creator's `resync-response`
  whose snapshot names a profile other than the document's — applying none of it,
  update included — and MUST report it to its application.
  *Rationale:* the profile a joiner learned from the invitation is only a claim of
  whoever wrote the invitation; the creator's snapshot is where the creator
  confirms it, and content of a different profile must never be applied.

- **CTL-11** · *engine* — A receiver MUST apply a control snapshot only from the
  creator and only if its `sequence` is at least the highest sequence the receiver
  has applied. Applying it MUST replace the membership map wholesale, MUST set
  closed if the snapshot says closed and MUST NOT reopen (LIF-7), and MUST raise
  the snapshot floor to `sequence`: afterwards any control frame numbered at or
  below it is stale for every target.
  *Rationale:* a snapshot is how a joiner on a history-less transport, or an engine
  that found a gap, learns current state — no peer can forward it, because it must
  come from the creator. Raising the floor stops an old frame from undoing what
  the snapshot established.
- **CTL-12** · *engine, application* — The creator's application MUST persist the
  creator's control state (sequence, members, closed, policy, policySequence)
  whenever it changes and MUST restore it when the creator's engine restarts. It
  MUST also persist each control frame the creator is about to send — the
  complete frame — *before* the frame is handed to the transport, and keep it
  until the transport has accepted or refused it (the **outbox**). A restarted
  creator whose persisted state holds such a pending frame MUST send that very
  frame again, byte for byte, before it issues any other control frame, and MUST
  NOT issue a different frame under the pending frame's number. Persisting is
  not best-effort: when the application cannot persist the state or the pending
  frame, it MUST report the failure to the engine, and the engine MUST NOT hand
  the frame to the transport; the number stays free, and a frame already pending
  from a restart stays pending. An engine MUST
  accept restored control state only when it is the creator; a non-creator MUST
  re-learn control state from the creator. A creator whose persisted state is
  lost restarts from sequence 0, and its next frames are stale or conflicts
  (CTL-17) wherever the old ones arrived; this version does not recover that
  state, so an application SHOULD tell the person rather than resume silently.
  *Rationale:* a creator that restarts at sequence 1 has every frame rejected,
  and one that forgot its grants sends joiners an empty membership map. The
  outbox closes the gap between "the messenger accepted the frame" and "the
  application recorded that it did": a crash there leaves a number that may
  already be delivered, and giving it to another action would show receivers two
  different statements under one version. Resending the identical frame is
  harmless — receivers drop the copy as stale — while a refused send frees the
  number, since the messenger took nothing. A non-creator's persisted sequence may
  sit above a gap it never noticed and would mark the lost frame stale forever.
- **CTL-13** · *engine, application* — An engine MUST refuse to send an `edit`
  frame of its own (reporting the refusal, not retrying it) when the document is
  closed, when its own permission is explicitly `read`, or — for anyone but the
  creator — before a creator's `resync-response` to one of its own requests has
  bootstrapped it. Once bootstrapped, an *unknown* permission MUST NOT cause a
  refusal. An application MUST NOT let a person type while its engine would
  refuse the edit.
  *Rationale:* before its bootstrap a joiner has neither the document's content
  nor its control state: an edit would compete with content it cannot see, and it
  may come from someone the creator has made read-only. Waiting costs nothing,
  because only the creator can bootstrap a joiner anyway ([§8.3](#83-who-answers))
  — with the creator offline, a joiner has nothing to edit. After the bootstrap,
  refusing on an unknown permission would lock out everyone the creator has not
  named yet, while channel membership already decides who can post. A refused
  edit stays in the local copy and every later local change builds on it, so the
  refusal alone would fork the person's copy for good; the application has to
  prevent the typing. After a restart a non-creator re-learns its control state
  from the creator (CTL-12) and is bootstrapped again before it edits.

### 7.5 The policy action

A policy change is a control action rather than a frame kind, so it inherits
creator-only acceptance, ordering, replay protection, gap detection and the
snapshot. Its ordering is by its own sequence (`policySequence`) rather than per
target, because an invitation also carries a policy with a sequence
([§11](#11-invitations)).

- **CTL-14** · *engine* — An engine MUST run a policy from a control frame, a
  snapshot or an invitation only if it runs no creator-set policy yet or the new
  policy's sequence is greater than that of the policy it runs.
  *Rationale:* a stale link must yield to a newer policy from the creator, and a
  fresh link must not be overwritten by an older snapshot. The control sequence
  is the policy's version; no separate number is needed.
- **CTL-15** · *engine* — A receiver MUST reject a `resync-response` whose snapshot
  breaks the layout above — its policy included — as a whole, applying neither its
  update nor any of its control state (FRM-6).
  *Rationale:* a snapshot half-applied — members taken, policy dropped — leaves the
  receiver in a state the creator never had; an honest creator never sends an
  invalid snapshot, so rejecting it loses nothing that a later, valid answer does
  not bring.
- **CTL-16** · *engine* — The creator MUST NOT broadcast a policy that its own
  transport profile's bounds forbid, and every receiver MUST clamp a received
  policy to its own bounds before running it (SND-4).
  *Rationale:* a policy can make a document slower but must never make any
  participant exceed their own provider's limits, which the creator cannot know.
- **CTL-17** · *engine* — A receiver MUST remember the frame it received under each
  control sequence, and MUST reject — and report as a conflict — a control frame
  from the creator whose sequence it already holds with a different frame. A
  creator MUST NOT send a control frame under a number it has already seen a
  different frame under.
  *Rationale:* two different frames under one number mean the creator's
  application reused it (CTL-12 prevents that for an honest creator); which one
  a receiver keeps would otherwise depend on delivery order, and receivers would
  disagree without anyone noticing. Seeing it and reporting it is all a receiver
  can do; a creator that has read its own earlier frames can refuse before
  sending.

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
  2. resync-request: controlSequence 0, empty state vector
     ─────────────────────►├──────────────►├─────────────►├───────────────►│
  3.                                                               only Alice answers
  4. resync-response: full snapshot + control snapshot + attribution overlay
     ◄─────────────────────┤◄──────────────┤◄─────────────┤◄───────────────┤
  5. content, permissions, policy and authorship present — bootstrap complete
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
- **RSY-2** · *engine* — A `resync-request` MUST carry a fresh random 64-bit
  `requestId`, the requester's contiguous control sequence (CTL-9), its current
  state vector, and `bootstrap: true` while it has not completed its bootstrap
  (RSY-14) or while it holds *history truncated* evidence (LOS-8) — whenever it
  needs an answer even if its state vector looks current — and `false` otherwise. A responder MUST treat copies of a request with the same
  `requestId` as one request.
  *Rationale:* the state vector lets the responder send only what is missing; the
  control sequence lets the creator see that a requester is behind on control
  state even when it lacks no content. The id is the requester's own, not the
  messenger's delivery id: a requester does not always learn the id its message
  gets on the receiving side, a request cut into fragments has no single one, and
  a duplicated delivery must not be answered twice. The `bootstrap` flag is needed
  because a state vector cannot say it: a joiner that already received every edit
  as it was sent looks up to date, yet still lacks the creator's control snapshot
  and overlay, and without the flag would never be answered (RSY-7).
- **RSY-3** · *engine* — An engine MUST have at most one resync request of its own
  outstanding per document. A further request made while one is outstanding MUST
  be coalesced into it and send nothing, and no request MUST be sent sooner than
  the policy's `minIntervalMs` after the engine's previous message.
  *Rationale:* a request is a broadcast; a second one multiplies the answers on a
  budget where every message counts, and "ask again" is what every trigger — a
  person's click, loss detection, a joiner's retry — would otherwise do at once.
- **RSY-4** · *engine* — An outstanding request MUST expire after a bounded time
  and is then reported as *unanswered*; a request whose send failed MUST release
  the slot immediately without counting against the floor. The expiry SHOULD be
  derived from the policy's floor and expected latency
  ([Appendix B](#appendix-b-recommended-values)).
  *Rationale:* an unanswered request is an ordinary outcome — a responder answers
  only if it has something to give (RSY-7) — and must not block the next one
  forever.
- **RSY-5** · *engine* — While a joining engine has not completed its bootstrap,
  it SHOULD repeat its request when one expires unanswered, with growing waits
  and a bounded number of attempts; it MUST NOT repeat it without bound.
  *Rationale:* the first request, or its answer, may itself be lost, or the creator
  may have been offline; an unbounded retry would spend the rate budget of a
  participant nobody can answer.

### 8.3 Who answers

- **RSY-6** · *engine* — The creator MUST answer resync requests from other
  members. A non-creator MUST NOT answer a resync request unless the requester is
  the creator. An engine that does not know the creator MUST NOT answer any
  request. An engine MUST NOT answer its own request.
  *Rationale:* one possible responder makes a join cost exactly one answer instead
  of one per online member, removes every timing-dependent suppression rule, and
  leaves one attribution overlay. The exception exists because a creator's
  content lives in memory: after a restart only a peer can give it back.
- **RSY-7** · *engine* — A responder MUST answer a request only if it holds content
  the requester's state vector lacks or — for the creator only — it has issued a
  control sequence greater than the requester's, or the request has `bootstrap:
  true`. The creator MUST answer every request with `bootstrap: true`. Otherwise a responder
  MUST stay silent, and MUST keep the request to reconsider later (RSY-9), since
  that may change.
  *Rationale:* an engine that is up to date gets no answer, which keeps resync
  traffic proportional to what is actually missing. A joiner is not up to date
  until it holds the creator's control snapshot, whatever its state vector says:
  before this rule a joiner that had seen every edit as it happened asked, got no
  answer, and could never complete its bootstrap.
- **RSY-8** · *engine* — An answer MUST be a `resync-response` whose `respondsTo`
  is the request's `requestId` and whose update is the responder's state since
  the requester's state vector. The creator's answer MUST carry its control
  snapshot in `control`; a non-creator's answer MUST set `control` to `null`. The answer SHOULD carry the
  responder's attribution overlay.
  *Rationale:* `respondsTo` lets the requester tell its own answer from answers to
  others (RSY-13, ATR-1); only the creator can issue control state.
- **RSY-9** · *engine* — A responder MUST answer at most one request per
  throttle interval per document. It MUST keep every request it may have to
  answer and has not answered — throttled, or with nothing to offer yet (RSY-7) —
  and reconsider it on later processing, independently of whether the request's
  delivery is offered again. A request counts as answered only once the transport
  has accepted the answer: after a send failure that is worth retrying (§3.4) the
  request MUST be kept as before, under the time it was first heard; after a
  permanent one it MUST be let go. It MUST keep at most one such request per requester:
  a newer request from the same requester replaces the older one and keeps its
  place in the order. It MUST bound what it keeps, by count and by age, dropping
  the oldest first ([Appendix B](#appendix-b-recommended-values)).
  *Rationale:* bounds the responder's traffic in the time domain however many
  requests arrive. Keeping the request itself is necessary because an engine
  processes each delivery once (TRN-8): a request skipped under the throttle and
  not kept would never be looked at again, and its requester would stay
  unanswered until its own request expired. One entry per requester, in its
  original place, keeps a requester that repeats itself from pushing others back
  and from being pushed back itself; the bound keeps a flood of requests from
  growing a responder's memory — a dropped requester asks again (RSY-5, LOS-6).
- **RSY-10** · *engine* — A resync answer MUST NOT be refused because the document
  is closed or because the responder's own permission is `read`.
  *Rationale:* a closed document must still bootstrap a joiner (LIF-6); the creator
  is never read-only, and a peer answering the creator is restoring the creator's
  own content.
- **RSY-11** · *engine* — A resync answer MUST go through the send scheduler and wait
  for the floor like every other message (SND-2). A responder SHOULD NOT stop
  processing deliveries while its answer waits.
  *Rationale:* the provider's rate limit counts every message; an answer sent
  outside the scheduler can push the next edit into a refusal. The cost is stated:
  a joiner may wait up to one floor for its bootstrap.

### 8.4 Accepting an answer

- **RSY-12** · *engine* — An engine that is not the creator MUST accept a
  `resync-response` only if its sender is the creator. The creator MUST accept one
  from another member only if its `respondsTo` names a request the creator itself
  made. An engine that does not know the creator MUST accept none.
  *Rationale:* the counterpart of RSY-6. Without the `respondsTo` check anyone
  could push content at the creator by sending an unsolicited "response".
- **RSY-13** · *engine* — An engine MUST apply the update of every accepted
  `resync-response`, including one that answers another member's request, and
  MUST apply the control snapshot of every `resync-response` the creator sent
  (CTL-11). It MUST consider the attribution overlay only of a response that
  answers its own request (ATR-1, ATR-2), and MUST attribute content applied from
  any other response to the unattributed author.
  *Rationale:* content is a CRDT and harmless to apply twice; a snapshot from the
  creator is authoritative whoever asked for it; but an overlay only describes the
  document of the member who asked, and the responder did not write everything
  it sends.
- **RSY-14** · *engine* — An engine MUST consider its bootstrap complete once it
  has applied an answer to its own request, and MUST make "not yet bootstrapped"
  observable to the application.
  *Rationale:* a joiner whose creator is offline sees an empty document; the
  application must be able to say "waiting for the creator" rather than present
  an empty document as the real one.
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

### 9.1 The sync policy

| Parameter | Meaning |
|---|---|
| `minIntervalMs` | The floor: no two messages closer than this |
| `maxIntervalMs` | The longest a pending change may wait, counted from its oldest pending edit; no limit if absent |
| `minChars` | Do not send fewer changed characters than this, unless `maxIntervalMs` has passed |
| `maxChars` | Send as soon as the floor permits once this many changed characters are pending; no limit if absent |
| `expectedLatencyMs` | How long a message normally takes to arrive; used by receivers to judge loss evidence ([§10](#10-loss-detection)). 0 = unknown |

An engine also has a local **quiet time** (`batchWindowMs` in the reference
implementation): the length of a typing pause after which a pending change may
go out. It is not part of the shared policy.

- **SND-1** · *engine* — An engine MUST make every policy it runs consistent before
  running it: a negative or non-numeric value falls back to its default,
  `maxIntervalMs` is raised to at least `minIntervalMs`, `minChars` is treated as
  0 while `maxIntervalMs` is unlimited, and `minChars` is lowered to at most
  `maxChars`.
  *Rationale:* no combination of values may starve a pending change — a change
  smaller than `minChars` with no deadline would otherwise never be sent.
- **SND-2** · *engine* — Every message an engine sends — of every kind, the initial
  seed and resync answers included — MUST go through its send scheduler, and MUST
  NOT be sent sooner than the effective floor after the engine's previous message
  of any kind. A message that is not a local edit (a control frame, a resync
  request or answer, the seed) SHOULD go ahead of edits that are waiting, and is
  not retried by the scheduler: its outcome goes to whoever sent it.
  *Rationale:* the floor is the provider's rate limit, and the provider counts
  messages, not kinds; a single message that bypasses the scheduler can push the
  next one into a refusal. The cost is stated rather than hidden: a control
  operation completes only once its message has gone out, up to one floor later.
- **SND-3** · *engine* — A pending change MUST be sent no later than the first
  moment at which the floor permits after either `maxIntervalMs` has passed since
  its oldest edit or `maxChars` changed characters are pending; otherwise it
  SHOULD be sent once the floor, the quiet time and `minChars` all permit.
  *Rationale:* `maxIntervalMs` closes the debounce's fault that continuous typing
  never sends; the floor closes its other fault, one message per pause.
- **SND-4** · *engine* — The policy an engine runs MUST be: the engine's defaults,
  overridden by the transport profile's default profile, overridden by the policy
  chosen by the creator (from a control frame, a snapshot or the invitation),
  made consistent (SND-1), then clamped so that `minIntervalMs` is at least the
  transport's `bounds.minIntervalMs`.
  *Rationale:* the transport's bounds are the one fact that must win over
  everyone's choice, including the creator's, because exceeding them loses
  messages.
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
  back-off only, not for the quiet time or `minChars` again.
  *Rationale:* the batch was already judged ready once; waiting for a new typing
  pause would delay it by up to the quiet time for nothing.
- **SND-8** · *engine, application* — A send that failed with `too-large` or
  `rejected`, and a change the engine itself refuses to send (CTL-13), MUST be
  dropped and reported to the application exactly once. Dropping ends the send
  job only: the change stays in the sender's document, and every later change
  builds on it. The engine MUST therefore expose that it holds *undistributed
  changes* until the transport has accepted its whole state (`resync()`) — every
  fragment of it, when it is cut — and nothing has been dropped since; a fragment
  of that state refused for good keeps the mark. The application MUST NOT show the
  document as synchronised while the engine does. A `too-large` refusal of a message within the `maxBytes` the
  transport's own profile declared MUST additionally be reported as a fault of
  the transport profile or its binding. An application that keeps a document
  across restarts MUST keep the undistributed mark with it.
  *Rationale:* retrying cannot help, and a change that is dropped silently is the
  failure this section exists to prevent. The CRDT cannot take a change back, so
  the author's copy diverges: receivers hold everything the author sends later as
  a pending gap no resync from the creator can fill, since only the author has
  the missing change. Sending the whole state once the cause is fixed — the
  permission restored, a smaller document, a working profile — heals it, because
  a full-state update depends on nothing before it. A refusal the profile said
  could not happen is not the sender's fault and must not look like it.
- **SND-9** · *engine* — After a `rate-limited` failure an engine SHOULD widen the
  spacing between its later sends, and SHOULD relax it again after a run of
  successful sends.
  *Rationale:* a refusal is evidence that the current pace is too fast for this
  provider, whatever the policy says.
- **SND-10** · *engine* — An engine MUST expose to the application whether it is
  idle, waiting for its send window, or retrying (with the failure count, the time
  of the next attempt and the last failure), and MUST report a failure as an error
  only when a change is dropped.
  *Rationale:* a change being retried is not yet lost; showing a sticky error for it
  teaches people to ignore errors.

### 9.3 Heartbeat

A lost *final* message leaves no gap for anyone to see: nothing later from the
same sender is pending behind it. The heartbeat closes that hole.

- **SND-11** · *engine* — When the policy has a finite `maxIntervalMs`, an engine
  that has sent an `edit` or a `fragment` — or, for the creator, a `control` frame —
  owes one `heartbeat`, carrying its state vector and, for the creator, its highest
  issued control sequence (otherwise 0). It MUST send it `maxIntervalMs` after its
  last message of any kind, and not inside the floor. A `resync-request` or a whole
  `resync-response` MUST NOT by itself make a heartbeat owed. It MUST NOT send another
  until it has sent something that owes one again, MUST NOT send one while a change
  is pending or being retried. A close does not cancel a heartbeat that is owed
  (LIF-6).
  *Rationale:* one heartbeat after the last message is enough to reveal a lost
  final message (LOS-4) and costs one message per burst of activity; a repeating
  heartbeat would spend the rate budget of an idle document. Which messages owe a
  heartbeat must be exactly the messages after which receivers expect one (LOS-3):
  the two sides are one rule.
- **SND-12** · *engine* — A heartbeat MUST count against the floor and MUST NOT be
  retried if its send fails.
  *Rationale:* a lost heartbeat is itself caught by the silence rule (LOS-3); a
  retried one would only compete with real changes.
- **SND-13** · *engine* — A heartbeat MUST NOT be applied as document content and
  MUST NOT change control state.
  *Rationale:* it is evidence, not authority, and it is accepted from any member.

### 9.4 Changes larger than one message

When the transport states `bounds.maxBytes`, no frame larger than that may be
sent. A change that does not fit is **spread** or **cut**:

- *Spreading* sends several pending updates as a sequence of merged prefixes, one
  per message, each the longest prefix whose frame still fits. Each piece is a
  valid update, so the receiver applies each as it arrives and always holds a
  usable prefix.
- *Cutting* is for a single update that does not fit by itself (one large paste),
  and for a resync answer: the whole frame's UTF-8 text is cut into byte slices,
  each carried Base64-encoded in a `fragment` frame, which the receiver
  reassembles.

`bounds.maxBytes` already includes whatever the bridge can carry beyond an
ordinary message body: where a messenger binding sends a large frame as an
attachment ([§13.2](#132-signal), [§13.3](#133-matrix)), the transport profile
states the attachment's limit, and the engine never needs to know how a frame of a
given size travels.

- **FRG-1** · *engine* — An engine MUST NOT send a frame larger than the transport's
  `bounds.maxBytes`. It MUST spread a pending change over several messages when
  that suffices, and MUST cut a single frame into fragments only when spreading
  cannot make it fit.
  *Rationale:* a spread change is useful piece by piece and survives the loss of a
  later piece better; a fragmented frame is applied only when its last fragment
  arrives, so one lost fragment loses the whole frame.
- **FRG-2** · *engine* — Fragments MUST carry a fresh random 64-bit `messageId`
  (16 lowercase hex digits) per fragmented frame, `total` equal to the number of fragments and `index` from
  0; every fragment frame MUST fit `bounds.maxBytes`; a fragment MUST NOT contain
  a fragment.
  *Rationale:* a random id keeps two senders' — or two frames' — fragments from
  being combined; nesting would allow unbounded reassembly depth.
- **FRG-3** · *engine* — An engine MUST send a cut frame's fragments in order and
  ahead of any edit made after the change that was cut, paced by the floor, and
  MUST NOT make them wait for a typing pause.
  *Rationale:* a later edit builds on the cut change; sent first, it would arrive
  first and look like a gap to every receiver.
- **FRG-4** · *engine* — When not even one byte of a slice fits beside a fragment's
  other fields, the engine MUST drop the change and report it (SND-8).
  *Rationale:* such a transport cannot carry the change at all, and pretending
  otherwise would retry forever.

### 9.5 Reassembly

- **FRG-5** · *engine* — A receiver MUST reassemble fragments keyed by sender and
  `messageId`, in any order, tolerating duplicates, and MUST handle the
  reassembled frame exactly as if it had arrived whole from that sender —
  including all checks of [§4.4](#44-decoding-and-rejection).
  *Rationale:* fragmentation must not become a way around any rule a whole frame
  is subject to.
- **FRG-6** · *engine* — A receiver MUST discard a fragment set whose fragments
  disagree about `total`, or that holds two different slices under one `index`,
  and MUST reject a reassembled frame that is itself a `fragment`. A slice that
  arrives again unchanged is a duplicate and changes nothing. A sender that
  resends a fragment MUST resend it byte for byte.
  *Rationale:* disagreeing fragments cannot be reassembled into one meaning; two
  different slices at one position mean two messages claim one id, and keeping
  whichever came first would decide between them by accident.
- **FRG-7** · *engine* — A receiver MUST bound the memory it holds for incomplete
  fragment sets — per sender, in total and in time — and MUST drop the oldest
  incomplete set first when a bound is reached.
  *Rationale:* everything in the buffer was sent by other people; unbounded, it is
  a memory exhaustion attack. A set dropped this way is a lost message, which loss
  detection treats like any other.
- **FRG-8** · *engine* — A receiver SHOULD expose the progress of an incomplete
  fragment set (fragments received of total) to the application.
  *Rationale:* a large change spread at a provider's rate can take minutes, and
  must not look like silence.

## 10. Loss detection

The information to notice a loss exists at the receiver. Loss detection makes it
available — as **evidence**, never as a claim, because every piece of evidence
can have an innocent cause (a late message, a participant who closed the
application). The converse holds too: **no evidence is not a claim of
completeness.** A loss can leave no trace an engine can see (the limits at the
end of this section), so an engine MUST NOT expose the absence of evidence as
"synchronised" or "complete", and an application MUST NOT present it so; the
most it may say is that nothing currently suggests a loss.

- **LOS-1** · *engine* — An engine MUST NOT report a message as lost; it MAY report
  evidence that something is missing, and MUST NOT report any evidence before it
  has persisted for a waiting time derived from the policy's `expectedLatencyMs`
  ([Appendix B](#appendix-b-recommended-values)).
  *Rationale:* a message that is merely late produces exactly the same evidence for
  a while; reporting it immediately would cry wolf on every slow network.
- **LOS-2** · *engine* — An engine MUST treat as evidence an update held pending
  because its causal predecessors are missing (a *pending gap*), and SHOULD name
  the member it is waiting for when it can tell.
  *Rationale:* this is the direct signature of a lost message in the middle of a
  sender's stream.
- **LOS-3** · *engine* — When the policy has a finite `maxIntervalMs`, an engine MUST
  treat as evidence a sender from whom an `edit`, `fragment` or `control` frame was
  received and neither a further message nor a heartbeat within `maxIntervalMs`
  plus the expected latency (*silence*). A heartbeat, and an applied answer to the
  engine's own resync request, MUST end that expectation. A `resync-request` or
  `resync-response` MUST NOT create it.
  *Rationale:* after an edit, a follow-up is due by SND-11; its absence is the only
  sign of a lost final message when the heartbeat itself was lost too. The sets of
  messages that owe a heartbeat (SND-11) and that create an expectation here must be
  the same: a receiver that counted a resync request as an edit would suspect
  every joiner of going quiet and ask for a resync itself — in a small group,
  more than a dozen messages for one join without a single edit.
- **LOS-4** · *engine* — An engine MUST treat as evidence a heartbeat whose state
  vector contains updates it has not applied, judged against its current document
  so that the evidence disappears when those updates arrive.
  *Rationale:* it is the only direct evidence of a lost *final* message.
- **LOS-5** · *engine* — An engine MUST treat as evidence a gap in the creator's
  control sequence (CTL-8), including one revealed by the creator's heartbeat.
  *Rationale:* control messages come only from the creator, so a missing number is
  a missing decision.
- **LOS-6** · *engine* — An engine SHOULD answer evidence by a resync request through
  its single request slot (RSY-3), automatically, only after a conservative
  multiple of the waiting time, with a bounded number of attempts per episode and
  growing waits between them, and never while a request of its own is already
  outstanding. The automatic request MAY be switched off by the application.
  *Rationale:* asking costs messages against the same rate budget as editing;
  unbounded automatic requests would turn a noisy network into a traffic storm.
- **LOS-7** · *engine* — Loss evidence MUST be based on the time the receiver heard
  a message, not on the sender's clock.
  *Rationale:* clocks of different participants are not synchronised, and the
  missing edit may still be in flight behind a heartbeat that just arrived.
- **LOS-8** · *engine* — An engine MUST treat as evidence (*history truncated*) a
  `receive` answer that shares no delivery with the previous non-empty answer it
  processed — everything it had seen has left the bridge's window, so deliveries
  may have come and gone unseen in between — and the first `receive` answer after
  one that failed. Unlike LOS-2 to LOS-5 this evidence needs no waiting time: an
  engine SHOULD answer it by a resync request with `bootstrap: true` (RSY-2) as
  soon as its request slot is free, and MUST report it until an answer to its own
  request has been applied — as "not safely synchronised", never as
  "synchronised". For the creator the evidence also ends when a request it made
  after the evidence expired unanswered: a peer answers the creator only when it
  holds content the creator lacks (RSY-6, RSY-7), so silence means nothing to
  recover, or nobody online to recover it from — and the engine cannot tell
  which. What remains is the request's outcome, *unanswered* (RSY-4), which the
  engine MUST keep observable until its next request; an application SHOULD show
  it. The creator's copy may then still lack a change of a member who is offline,
  until that member sends again (LOS-2 to LOS-4) or answers a later request.
  *Rationale:* a bounded window (BRG-17) can drop an edit *and* the heartbeat that
  follows it before an engine reads again; the engine then sees no pending gap,
  no silence (it never heard the edit) and no newer state vector, so LOS-2 to
  LOS-5 stay quiet while the document has diverged. The one thing the engine can still see is that the
  window moved past everything it knew. Overlap proves nothing after a bridge
  restart, though: a restarted bridge may offer old deliveries again (BRG-17), and
  one it offers again can overlap the previous answer while newer ones were lost.
  A restart is visible to an engine
  that polls as a failed `receive`, so that is evidence too; so is a bridge that
  could not reach its messenger, which costs one answered request when nothing
  was lost. The request forces an answer (`bootstrap: true`) because only an
  answer can end the evidence: an engine that lacks nothing would otherwise get
  none and warn for ever. The rule does not promise healing: with the creator
  offline the request goes unanswered and the evidence stays.

Honest limits: LOS-8 notices a window that moved on only while a previous answer
exists to compare with, so a truncation between an engine's start and its first
`receive` is covered by the joiner's bootstrap instead (RSY-1). A bridge that
restarts entirely between two polls of an engine — possible where an application
polls rarely, as a browser does in a background tab — and whose new window
overlaps the previous answer is not noticed; a bridge interface that reported
its restarts would close this, and this version does not define one. A resync heals only while the creator (or, for the creator's own
request, a peer holding the content) is online. A message that reached *nobody*
is recovered only when its author answers a request. Without a finite
`maxIntervalMs` there is no heartbeat, and a lost final message cannot be
noticed at all.

## 11. Invitations

An invitation tells a joiner what to open: which messenger, which document,
which channel, and who the creator is. It is a **convenience for filling in the
join step, not a capability**: holding an invitation grants nothing, because
the joiner's bridge re-checks real channel membership when it binds (BRG-5) —
and for email, every message is checked against the closed participant set
([§13.4](#134-email)).

### 11.1 Content

| Field | Meaning | Required |
|---|---|---|
| messenger | Which binding: `signal`, `matrix` or `email` | Yes |
| documentId | The document | Yes |
| creatorMemberId | The creator's MemberId | Yes |
| channel reference | Signal, Matrix: the channel id (group id, room id). Email: the thread root `Message-ID`, every participant's address, and whether PGP is on | Yes |
| profile | The document's profile id ([§5](#5-document-profiles)) | Yes |
| policy | The creator's sync policy and the sequence it was set at, as policy text (§11.2) | No |

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
  only after the person confirms.
  *Rationale:* the creator named in the invitation becomes the one identity whose
  control frames the engine obeys (CTL-5); a forged invitation naming someone else
  as creator is the one way to hand that authority to the wrong person, and the
  person is the only one who can recognise it.
- **INV-4** · *engine, application* — A policy from an invitation MUST be treated
  as the creator's choice with the invitation's sequence (CTL-14) and clamped like
  any other (SND-4); an invitation whose policy does not parse MUST still open,
  without a policy.
  *Rationale:* the policy has exactly the trust of the creator's identity in the
  same invitation, and the creator's own answer corrects it once it arrives.

### 11.2 Policy text

A compact text form of a policy, short enough for a chat message:

```abnf
policy-text   = number "," limit "," number "," limit "," number "@" sequence
number        = uint32                  ; minIntervalMs, minChars, expectedLatencyMs
limit         = uint32 / "inf"          ; maxIntervalMs, maxChars; "inf" = no limit
sequence      = uint32                  ; control sequence the policy was set at; 0 = initial
uint32        = "0" / %x31-39 *9DIGIT   ; no leading zero; at most 4294967295
```

Example: `30000,120000,0,inf,60000@0`. The field order is `minIntervalMs`,
`maxIntervalMs`, `minChars`, `maxChars`, `expectedLatencyMs`.

- **INV-5** · *engine, application* — A policy text that does not match the grammar
  exactly MUST be treated as absent.
  *Rationale:* the text arrives from a link anyone can edit; a half-parsed policy is
  a policy nobody chose.

### 11.3 Invitation as a link

An application that expresses an invitation as a URL query MUST use this form,
so that one application can open another's invitations. The query is
`application/x-www-form-urlencoded` as the WHATWG URL standard defines it (what
`URLSearchParams` reads and writes), and every value is UTF-8.

| Parameter | Field | Required | Value |
|---|---|---|---|
| `tdsp` | invitation version | yes | `1` |
| `provider` | messenger | yes | the binding's name: lowercase letters, digits, `.` and `-`, 1–64 characters |
| `documentId` | documentId | yes | 1–255 UTF-8 bytes |
| `creatorMemberId` | creatorMemberId | yes | 1–255 UTF-8 bytes |
| `channelId` | channel id | Signal, Matrix | 1–255 UTF-8 bytes |
| `threadRoot` | thread root `Message-ID` | email | the email binding's `Message-ID` form ([§13.4](#134-email)) |
| `recipients` | every participant's address, the creator's included | email | 1–64 distinct addresses, comma-separated |
| `pgp` | PGP is on | email, optional | `1` |
| `profile` | profile | yes | a profile id ([§5](#5-document-profiles)) |
| `policy` | policy text | no | §11.2 |

- **INV-6** · *application* — A reader MUST refuse an invitation in which a
  parameter of the table above appears more than once, a required one is missing
  or empty, or a value is outside its range; MUST ignore a `policy` that does not
  parse (INV-4, INV-5); MUST ignore parameters the table does not define; and MUST
  treat a missing or other `tdsp` as an invitation it cannot read.
  *Rationale:* one reading for every link. A parameter named twice is exactly the
  place where two parsers pick different values; an unknown parameter is
  ignored because the same query also carries an application's own settings (a
  bridge override, say) and a later version's additions.
- **INV-7** · *application* — An application MUST NOT derive trust from an
  invitation beyond prefilling the join step: the creator it names takes effect
  only after the person confirms (INV-3), the profile is confirmed by the
  creator's snapshot (CTL-10), and membership is decided by the messenger and the
  bridge (BRG-5), not by holding the link.
  *Rationale:* a link can be forwarded into any conversation and edited by anyone
  who holds it, so it cannot prove which channel it came from; everything it
  claims is checked by something that can.

For a PGP email document the invitation additionally carries a signed and
encrypted block ([§13.4](#134-email)); where the block and the link disagree,
the block wins.

## 12. Bridges

A bridge is where TDSP meets one messenger account. Everything in this section
applies to every bridge, whether its adapter calls it in-process or across a
process boundary; the local HTTP interface of
[§12.6](#126-the-local-bridge-interface-optional) is an option on top.

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
  capability ([§11](#11-invitations)); failing at bind time makes a stale id fail
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
  four reasons of [§3.4](#34-send-failures), mapping what its messenger said.
  *Rationale:* only the bridge knows whether its messenger's refusal will pass
  (a rate limit, an outage) or not (a size limit, a forbidden sender).
- **BRG-9** · *bridge* — A bridge that supports attachments MUST choose between the
  message body and an attachment by the frame's size alone, MUST state the largest
  frame it carries either way as `bounds.maxBytes`, and MUST refuse a larger frame
  as `too-large`.
  *Rationale:* how a payload travels is the bridge's business; the engine sees only
  one number, and a refusal it can classify.

### 12.4 Receiving

- **BRG-10** · *bridge* — A bridge MUST route by the envelope's documentId. It MUST
  ignore silently — without an error and without an integrity record — a message
  that is not a TDSP envelope, an envelope of an unknown kind, an unparseable
  body, and an envelope for a documentId it has no binding for.
  *Rationale:* a channel is shared with human conversation and possibly with other
  documents; none of those is an anomaly.
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
  limits of [§10](#10-loss-detection)) — so the simpler rule is to let loss
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

### 12.6 The local bridge interface (optional)

A bridge and its adapter may run in different processes — necessarily so when
the application is a web page ([§2.1](#21-layers)), and usefully so when a bridge
is to be reused from another language. For that case this section defines a
local HTTP interface. Its requirements bind an adapter and a bridge that
communicate through it, and no one else.

**Process and network model.**

In this section a **loopback address** is, literally and compared exactly,
`localhost`, an IPv4 address in `127.0.0.0/8`, or `::1`. A name that merely
resolves to one (`localtest.me`) is not, nor is one that begins with
`localhost` (`localhost.example`), nor `0.0.0.0`. A **loopback origin** is an
`http` or `https` origin whose host is a loopback address; the opaque origin
`null` is not one. The reference implementation's `loopback` module
([Appendix F](#appendix-f-reference-implementation)) is this definition.

- **LBI-1** · *bridge* — A bridge offering this interface MUST listen on a loopback
  address only (`127.0.0.1` or `::1`), never on a wildcard or external interface.
  *Rationale:* the interface has no authentication (LBI-2); loopback-only confines
  it to the user's own machine.
- **LBI-2** · *bridge* — The interface has no authentication of its own; its trust
  boundary is the operating-system user account. It MUST NOT offer any route that
  returns a credential.
  *Rationale:* anything running as the same user could read the credential files
  directly, so a token would add ceremony, not security — the same boundary an
  SSH agent socket relies on. Not returning credentials keeps a compromised page
  from exfiltrating them through the interface.
- **LBI-3** · *bridge* — A bridge MUST answer a cross-origin request with
  `Access-Control-Allow-Origin` only when the request's `Origin` is a loopback
  origin, echoing that origin, and MUST answer `OPTIONS` preflight requests with
  204.
  *Rationale:* a browser-hosted application must be able to call its bridge, and
  no web page from anywhere else may.
- **LBI-4** · *adapter* — An adapter MUST refuse to talk to a bridge whose
  configured address is not an `http` or `https` URL whose host is a loopback
  address.
  *Rationale:* the adapter's half of LBI-1; a misconfigured address must not send
  document content across a network.

**Conventions.** Request and response bodies are JSON. The frame is a JSON
string; other binary data is Base64. An error response is
`{"error": "<message>"}`. `:documentId` is one URL-encoded path segment. An
unknown route answers 404.

| Status | Meaning |
|---|---|
| 400 | A malformed field |
| 403 | Not permitted |
| 404 | Unknown document, channel or route |
| 409 | Not provisioned or not linked yet |
| 413 | Too large |
| 422 | Refused at message level |
| 429 | Rate-limited |
| 502 | Anything else that failed |
| 503 | A dependency is not configured |

**Routes.**

| Route | Purpose | Request | Response |
|---|---|---|---|
| `GET /health` | Liveness, and whether the bridge is provisioned | — | `{status:"ok", configured?: boolean}` |
| `GET /whoami` | The account's own MemberId | — | `{id}` |
| `GET /transport-profile` | The transport profile ([§3.5](#35-transport-profile)) | — | the profile; 503 while unprovisioned |
| `GET /channels` | Channels for the picker → `listChannels` | — | `[{id, name, encrypted?}]` |
| `POST /channels/:documentId/bind` | Bind a document to a channel → `createDocument` | `{channelId, creator, profile}` | the binding |
| `POST /channels/:documentId/send` | → `send` | `{sender, payload}` — the frame's text; `sender` must be the bridge's own account (BRG-16), else 403 | `{deliveryId}` |
| `GET /channels/:documentId/deliveries` | → `receive` | — | `[{id, documentId, sender, payload}]` |
| `POST /channels/:documentId/invite` | Send a human-readable invitation into the bound channel | `{actor, text}` — `actor` must be the bridge's own account and the document's creator, else 403 | `{deliveryId}` |
| `GET /channels/:documentId/integrity-log` | The integrity violations recorded (BRG-15) | — | a list of `{id, sender, reason, …}` |

Email has no pre-existing channel to bind to; starting and joining a thread
replace binding:

| Route | Purpose | Request | Response |
|---|---|---|---|
| `POST /threads/:documentId` | Start the thread: send the invitation, bind the document | `{recipients[], creator, profile, inviteText?, pgpEnabled?, threadRootMessageId?, policy?}` | `{threadRootMessageId}` |
| `POST /threads/:documentId/join` | Join a thread from its invitation | `{recipients[], creator, profile, pgpEnabled?, threadRootMessageId}` | the binding (for PGP, including the invitation's policy and profile) |

Provisioning routes are binding-specific: Signal's `GET /auth/status` and
`POST /auth/link`; email's `GET /mail/status`, `GET /pgp/status` and
`GET /pgp/keys`.

- **LBI-5** · *bridge* — A bridge MUST implement the routes above that apply to its
  messenger, with the request and response shapes given, and MUST NOT offer
  routes for membership, closing, deletion or resync ([§12.5](#125-what-a-bridge-does-not-do)).
  *Rationale:* one interface shape lets any adapter drive any bridge.
- **LBI-6** · *bridge, adapter* — `POST …/send` MUST answer a failure with the
  status that classifies it: `429` (with `Retry-After` in seconds when the
  messenger stated a wait) for a rate limit, `413` for a message too large, `400`,
  `403`, `404`, `409` or `422` for a refusal waiting cannot change, and `5xx` for
  everything else. An adapter MUST map `429` to `rate-limited`, `413` to
  `too-large`, `400`, `403`, `404`, `409` and `422` to `rejected`, and every other
  status to `unavailable`.
  *Rationale:* the classification of [§3.4](#34-send-failures) has to survive the
  HTTP hop; an unclassified status landing on `unavailable` means a change is never
  dropped on a guess.

## 13. Messenger bindings

A binding says how a frame travels on one messenger: the envelope, the carrier,
the delivery id, the sender, how the account is provisioned, and what the bridge
must refuse. Two implementations of the same binding interoperate; two bindings
never do.

- **BND-1** · *bridge* — A binding MUST state how it meets each requirement of
  [§15.1](#151-what-a-messenger-must-provide) — sender authentication, integrity,
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
  envelope — `tdsp` missing or not a number, `kind` not `"frame"` (where the
  binding has a `kind`), `documentId` or `frame` not a string, both or neither of
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
| Inline limit | A frame of at most 800 bytes rides in the body as `frame` |
| Attachment | A larger frame, up to 4 MiB, is the message's only attachment; the envelope carries `"attachment": {"size": <bytes>, "sha256": "<64 hex digits>"}` in place of `frame` |
| Immutability | An `editMessage` or a remote delete targeting a delivered message is an integrity violation |

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
| Body, PGP on | The same JSON, signed and encrypted to every participant as one inline ASCII-armoured OpenPGP message |
| MemberId, sender | The email address in its canonical form (EML-10); the `From` address, canonicalised |
| Delivery id | The `Message-ID` |
| Message-ID | `<local@domain>`, at most 200 characters, local part and domain from `[A-Za-z0-9._~+-]` and `[A-Za-z0-9.-]` |
| Invitation | The thread's first message: human-readable text with the invitation link; with PGP, followed by exactly one armoured block, signed by the creator and encrypted to each participant, whose plaintext is `{"tdsp":1, "kind":"invite", documentId, creator, profile, participants: [{address, fingerprint}], keys, policy?}` |
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
  [§15.1](#151-what-a-messenger-must-provide): it has no sender authentication.
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

The email binding without PGP is the weakest on every axis: `From` is as
forgeable as any header, and a document is as confidential as plain email.

## 14. Versioning and extensibility

Three things carry a version, deliberately separate:

| What | Where | Changes when |
|---|---|---|
| The frame format | `tdsp` in every frame ([§4](#4-the-payload-frame)) | A frame field or a kind's meaning changes incompatibly |
| The envelope and bindings | `tdsp` in every envelope ([§13](#13-messenger-bindings)) | An envelope field or a carrier changes incompatibly |
| A document profile | The major version in its id ([§5](#5-document-profiles)) | What the profile's bytes mean changes incompatibly |

All three are 1 in TDSP 1.0.

- **VER-1** · *all* — An incompatible change MUST increment the version that
  governs it. A receiver that does not implement a version MUST fail loudly — by
  reporting it locally with a named reason (FRM-7 for a frame; BND-2 for a
  recognisable envelope of a bound document) — and
  MUST NOT skip silently, parse partially or fall back to a compatibility mode.
  Nothing is sent to the other participants because of it; a joiner that sees the
  incompatibility in an invitation declines instead ([§6.5](#65-declining-an-invitation)).
  *Rationale:* every compatibility mode is a second protocol that must be
  specified, tested and secured. A message about a failure would be one more
  message anyone could provoke; the one case where the others must know — someone
  who cannot join — has its own, deliberate message.
- **VER-2** · *all* — Kinds, actions, reasons and permissions not defined in this
  specification MUST NOT be used until a revision of it defines them.
  *Rationale:* two implementations inventing the same value for different meanings
  cannot be told apart on the wire.

A compatible addition — a new frame kind that older engines may reject as
`unknown-kind` without harm to the document, or a new profile — does not
increment a version, but needs a revision of this specification (or, for a
profile, its own definition) that states why older implementations are
unaffected.

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
(EML-8). Matrix authenticates a sender as far as the
homeserver is trusted, and adds integrity and confidentiality against the
homeserver only in an encrypted room ([§13.3](#133-matrix)).

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
| Permissions | The creator grants and revokes; each engine refuses to send an edit before its bootstrap, while its own permission is `read`, and once the document is closed — not when its permission is merely unknown after the bootstrap (CTL-13) | Among cooperating engines only; receivers do not reject an edit for its sender's permission (CTL-7) |
| Creator identity | Fixed; control frames and snapshots only from it (CTL-5, CTL-11) | Exactly as strong as the messenger's sender authentication |
| Replay of control frames | Per-target sequence numbers (CTL-5) | A replayed frame is inert |
| Close | Cooperating engines stop sending edits of their own; edits sent before the close still arrive and apply (LIF-6) | Among cooperating engines only — a modified engine can keep sending edits, which genuine engines apply, exactly as with `read` (CTL-7) |
| Convergence | The CRDT | Unconditional, given the same set of updates — not given a lost one |
| Message immutability | Bridges refuse and record edits and withdrawals (BRG-12) | Where the messenger reveals them |
| No external connection | ARC-2, BRG-4 | As strong as its enforcement; see below |
| Resource exhaustion by peers | Bounded reassembly (FRG-7), bounded attachment fetches (BRG-14), bounded pre-verification reads (BRG-13) | Bounded, not prevented |

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
- **Completeness without evidence.** A copy with no loss evidence may still lack a
  change: one no engine saw a trace of ([§10](#10-loss-detection)'s limits), or,
  at the creator, one held only by a member who was offline when the creator
  asked (LOS-8).
- **Authorship.** Attribution is a display convenience (ATR-3).
- **Deletion** of content from participants' devices.
- **Metadata protection.** Who talks to whom, when and how much is as visible as the
  messenger makes it; the documentId is visible to the messenger and to every
  channel member.
- **Portability** of a document between messengers: bindings are messenger-specific
  state.

### 15.5 Specific threats

- **A forged or careless policy** can make a document slow, without bound — a floor of
  weeks is expressible. It can never make an engine exceed its own provider's
  limits (SND-4). This is not new power: whoever can forge the creator can close
  the document.
- **A forged heartbeat** can cost one unnecessary resync request per floor, never
  more (RSY-3, LOS-6).
- **A forged invitation** naming a false creator hands control authority to that
  identity in the joiner's engine; INV-3 puts a person in the loop.
- **Fragments and attachments** let any member make other members hold and fetch
  data; FRG-7, BRG-13 and BRG-14 bound how much.
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
| Updates a state vector lacks | `Y.encodeStateAsUpdate(doc, stateVector)`; with the empty state vector this is byte-identical to the full state |
| Initial state | One empty paragraph |
| Plain-text projection | The paragraphs' texts in document order, joined by a single `"\n"`; offsets count **UTF-16 code units** |

- **YJS-1** · *engine, application* — A document of this profile MUST keep all its
  content in one `Y.XmlFragment` named `content`, whose children are
  `Y.XmlElement`s named `paragraph`, each holding one `Y.XmlText`, and MUST NOT add
  other top-level shared types, element names or attributes.
  *Rationale:* a peer that does not know an element can still merge it, but cannot
  render, project or attribute it, so participants would see different documents
  from the same state.
- **YJS-2** · *engine* — Updates MUST be Yjs update encoding version 1.
  *Rationale:* version 2 is a different byte format under the same library; mixing
  them fails to decode.
- **YJS-3** · *engine* — Implementations MUST compute the projection and its offsets
  exactly as stated, including in languages whose native strings are not UTF-16.
  *Rationale:* the overlay's offsets are exchanged between engines; the same
  document projected with a different separator or unit shifts every attribution
  after the first non-ASCII character.

## Appendix B. Recommended values

*Informative.* The values the reference implementation uses. Each row names the
requirement it serves.

| Value | Recommended | Serves |
|---|---|---|
| Engine default policy | floor 0, no `maxIntervalMs`, `minChars` 0, no `maxChars`, latency 0 | SND-4 |
| Quiet time (`batchWindowMs`) | 500 ms | SND-3 |
| Retry back-off | Starts at max(1 s, floor), doubles per consecutive failure, capped at `maxIntervalMs` or 10 min; `retryAfterMs` honoured up to 1 h | SND-7 |
| Adaptive spacing | ×1.5 per `rate-limited` refusal, from the floor or 1 s; relaxed ×1.5 after 8 consecutive successes | SND-9 |
| Resync response throttle | 1 000 ms per document per responder | RSY-9 |
| Requests kept to answer later | One per requester, at most 64 per document, each for at most 5 min; oldest dropped first | RSY-9 |
| Resync request expiry | floor + 2 × latency, at least 10 s | RSY-4 |
| Bootstrap retry | after 1, 2, 4, … expiries; at most 5 attempts | RSY-5 |
| Loss-evidence wait | 1 × `expectedLatencyMs`, or 5 s when it is 0 | LOS-1 |
| Automatic resync | at once for a truncated history; after 2 × latency for a gap or a heartbeat that shows we are behind; after the overdue time + 3 × latency for silence; at most 3 per episode, each wait doubling, never longer than 10 min | LOS-6, LOS-8 |
| Reassembly bounds | 4 incomplete frames per sender, 32 MiB in total, 6 h; oldest dropped first | FRG-7 |
| Incoming mail read | At most 10 MiB of one mail, by a partial IMAP fetch; a larger one is rejected unread (the largest mail a 4 MiB frame becomes is about 7.6 MiB) | BRG-13 |
| Signal daemon response | At most 16 Mi characters per JSON-RPC line from `signal-cli`, plus one socket read (a 4 MiB attachment is about 5.6 Mi in Base64); a longer line is dropped unread and the calls waiting fail | BRG-14 |
| Bridge retention | The newest 1 000 deliveries per document, and at most 64 Mi characters of their payload text; the newest always kept | BRG-17 |
| Engine memory of processed ids | What `receive` still returns, plus its own sends for up to 1 h until their echo; 1 024 resync request ids of others | TRN-8 |
| Matrix attachment download retry | 1, 2, 4 … s, at most 60 s apart, 8 attempts, at most 64 waiting | BRG-14 |
| Signal attachment read retry | 3 attempts, 0.5 s and 1.5 s apart | BRG-14 |
| Bridge ports | Signal 8787, Matrix 8788, email 8789 | — |

Shipped transport profiles (`minInterval` / `maxInterval` / `expectedLatency`,
then bounds; every one has `minChars` 0 and `maxChars` none). **Only the email interval is a decision; every other value is an
estimate.**

| Bridge | Profiles | Bounds |
|---|---|---|
| Email to a provider | `standard` 30 s / 120 s / 60 s; `patient` 60 s / 300 s / 120 s | floor 15 s; 4 MiB (a mail of at most about 7.6 MiB: measured 1.81 mail bytes per frame byte with PGP, 1.39 without; sized for 8 MiB, below the roughly 10 MiB providers commonly accept) |
| Email or Matrix to a server on the same machine | `local` 0 / none / 0 (no floor, no cap) | email none; Matrix no floor, 4 MiB |
| Matrix to a real homeserver | `standard` 1 s / 15 s / 5 s; `constrained` 5 s / 60 s / 15 s | floor 250 ms; 4 MiB |
| Signal | `standard` 2 s / 20 s / 10 s; `constrained` 10 s / 60 s / 30 s | floor 500 ms; 4 MiB |

Measured sizes worth knowing: typed text costs about 10 bytes per character on
the wire, pasted text about 1, a full snapshot 1 to 9 depending on how
concurrently it was written. One measured email provider refused after about 35
messages in 20 minutes, with 8 to 35 seconds per hop.

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

## Appendix D. Example frames

*Informative.* Produced by the reference encoder, documentId `doc-a1b2c3`,
profile `yjs-paragraphs/1`. The `edit` frame is in [§4.5](#45-example).

`control`, membership — grant `bob` write, sequence 1:

```json
{"tdsp":1,"kind":"control","documentId":"doc-a1b2c3","sequence":1,"action":"membership","member":"bob","permission":"write"}
```

`control`, close — sequence 3:

```json
{"tdsp":1,"kind":"control","documentId":"doc-a1b2c3","sequence":3,"action":"close"}
```

`heartbeat` from the creator — latest control sequence 3, after the edit of §4.5
(the state vector names one Yjs client at clock 4):

```json
{"tdsp":1,"kind":"heartbeat","documentId":"doc-a1b2c3","controlSequence":3,"stateVector":"AYma9JgPBA=="}
```

`resync-request` of a joiner with nothing:

```json
{"tdsp":1,"kind":"resync-request","documentId":"doc-a1b2c3","requestId":"5f3a9c0e12b47d68","bootstrap":true,"controlSequence":0,"stateVector":"AA=="}
```

`decline` of a joiner whose engine implements another profile:

```json
{"tdsp":1,"kind":"decline","documentId":"doc-a1b2c3","reason":"unsupported-profile","profiles":["com.example.markdown/1"],"text":"My app cannot open this document."}
```

The `edit` frame of §4.5 as a Signal group message's body — the envelope, with the
frame as a JSON string:

```json
{"tdsp":1,"kind":"frame","documentId":"doc-a1b2c3","frame":"{\"tdsp\":1,\"kind\":\"edit\",\"documentId\":\"doc-a1b2c3\",\"update\":\"AQOJmvSYDwAHAQdjb250ZW50AwlwYXJhZ3JhcGgHAIma9JgPAAYEAIma9JgPAQJIaQA=\"}"}
```

## Appendix E. Implementer checklists

*Informative.*

**A bridge for a new messenger.**

1. Check the messenger against [§15.1](#151-what-a-messenger-must-provide). The
   dealbreakers are an unauthenticated sender and an inability to carry an opaque
   payload. Write down its size and rate limits.
2. Decide how the account is provisioned, and keep its credentials in a private
   place ([§12.1](#121-account-and-credentials)).
3. Write a binding ([§13](#13-messenger-bindings)): account, security, envelope,
   carrier, delivery id, sender, inline limit, attachments.
4. Never parse the frame; route by the envelope's documentId; ignore what is not
   yours, silently.
5. Make delivered messages immutable and record every attempt to alter one.
6. Classify send failures (BRG-8); if the bridge runs in its own process, offer
   the local bridge interface ([§12.6](#126-the-local-bridge-interface-optional)):
   loopback only, loopback origins only.
7. Reach exactly one endpoint.
8. Serve a transport profile that states the limits you measured, and say which
   values are estimates.
9. Pass the conformance suite with two real accounts, repeatedly.
10. Write down what the messenger cannot do; a gap is an error, never a silent
    no-op.

**An application on top of the engine.**

1. Everything goes through the transport contract; a socket "just for presence"
   ends the security model.
2. Generate documentIds from a secure random source, and choose each document's
   profile.
3. Persist the creator's control state and the list of documents the user has.
4. Show the creator from an invitation and let the person confirm before joining;
   decline an invitation whose profile the engine does not implement, and show
   the declines others send.
5. Show send status and loss evidence; show an error only for a dropped change,
   and show undistributed changes (SND-8) until a resync has gone out — never
   "synchronised" meanwhile.
6. Say, per messenger, what the channel does and does not protect — and never
   present attribution as authentication.

## Appendix F. Reference implementation

*Informative.* A reference implementation of every conformance class exists, in
TypeScript on Node.js and in the browser:

| Part | Class | What it is |
|---|---|---|
| `messenger-port` | — | The transport contract, the transport profile, the send-failure classification, and the transport conformance suite ([§3.6](#36-conformance-suite)) |
| `document-protocol` | engine, application | The engine (`DocumentEngine`), and the invitation link's reader and writer (`parseInvitation`, `encodeInvitation`): frames, control state, bootstrap and resync, send scheduling, fragments, loss detection, declines |
| `reconciliation` | engine | The profile `yjs-paragraphs/1` ([Appendix A](#appendix-a-profile-yjs-paragraphs1)) and the attribution tracker |
| `messenger-signal`, `messenger-matrix`, `messenger-email` | adapter | One adapter per binding, speaking the local bridge interface |
| `signal-bridge`, `matrix-bridge`, `email-bridge` | bridge | One bridge per binding, each offering the local bridge interface ([§12.6](#126-the-local-bridge-interface-optional)) |
| `bridge-log` | bridge | Structured logging for bridges that never logs a credential or a document's content |
| `loopback` | adapter, bridge | The one check of whether an address is this machine: which bridge an adapter may reach, which page may read a bridge's answers ([§12.6](#126-the-local-bridge-interface-optional)) |

Its conformance status — what has been verified against a real messenger and
what has not — is published with it (`CONFORMANCE.md`), not here.
