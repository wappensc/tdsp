# TDSP — Together Document Sync Protocol

**Specification · TDSP 2.0 · 6 November 2026**

## 1. Introduction

### 1.1 What TDSP is

TDSP synchronises a collaboratively edited document between a small group of
participants by carrying CRDT updates inside ordinary messages of a messenger
the participants already use — a Signal group, a Matrix room, an email thread.
There is no TDSP server, no WebSocket and no peer-to-peer connection: every
byte of document data that passes between participants travels as a message of
that messenger, and every participant's engine merges what arrives locally.

Three consequences shape everything below:

- **Confidentiality and sender authentication are inherited, not added.** A
  TDSP document is exactly as confidential as the channel it rides on, and a
  message's sender is exactly as authentic as the messenger makes it. TDSP adds
  no encryption of its own; where a messenger has none, as email, its binding
  may add it — the [email binding](bindings/email.md)'s optional PGP, without
  which email is no conformant binding (EML-9).
- **The transport is assumed to be poor.** Messages may be delayed by tens of
  seconds, duplicated, reordered, rate-limited, size-limited and lost, and a
  newly joined participant may see nothing that was sent before it joined. Loss
  and reordering are rare, though, and TDSP heals a loss at the next occasion —
  the typical one, a lost last change, by the report that follows each phase of
  writing ([§9.3](#93-the-report)). Every mechanism in this specification is built
  for that transport; a better one simply converges faster.
- **The participants cooperate.** TDSP is a protocol for a small group of people
  who edit a document together, each running software that follows this
  specification. It is built for what goes wrong without anyone intending it —
  lost, duplicated and reordered messages, devices offline for days, crashes,
  restored copies, clocks that are off — and assumes nothing worse of the
  participants ([§15.2](#152-what-tdsp-assumes)). A participant whose software
  ignores these rules can write what its permission forbids, change rights or
  close the document for everyone, and TDSP neither prevents nor detects it
  ([§15.4](#154-what-is-not-guaranteed)). Who takes part at all is the
  messenger's to decide ([§6.6](#66-who-takes-part), LIF-9): a group protects
  itself by removing such a participant from the channel and continuing in a new
  document.

The name is deliberately about the *document*, not the carrier: the carrier is
replaceable ([§2.1](#21-layers)).

### 1.2 Status of this document

This is **TDSP 2.0**, the core of the protocol. It changes the wire of
TDSP 1.x incompatibly, in four places, and keeps every use case 1.x covers
([§1.7](#17-what-must-stay)):

- **Control state is a register per target** ([§7](#7-control-state)), merged
  like the content, instead of a numbered log with one writer. Every device of the
  creator decides under a tag of its own and orders each decision by a clock; of
  two decisions on one target the later holds, and the result depends on the set,
  not on the order. 1.x's gap-free sequence, its outbox, its conflicts under one
  number go. Under the assumption of cooperating participants
  ([§1.1](#11-what-tdsp-is)), any participant can bring a new device up to date,
  its rights included: each passes on what reached it of the creator's decisions,
  and the device merges it as it merges the creator's own
  ([§7.5](#75-the-control-snapshot)). The creator's devices hold her state: a new
  device of hers takes it only from another of them or from a backup, and where
  none is left the document is closed and continued as a new one
  ([§7.6](#76-a-new-device-of-the-creator)).
- **No shared sync policy** ([§9.1](#91-pacing)): the creator sets one number for
  everyone, the *pace*; everything else about pacing is each participant's own.
- **Extension fields** ([§4.4](#44-decoding-and-rejection)): a field whose name
  contains `.` is ignored when unknown, unless the frame lists it in `crit`, so a
  later addition needs no new major version.
- **Pieces instead of fragments** ([§9.4](#94-changes-larger-than-one-message)):
  the profile splits a large update into pieces that are updates themselves; the
  `fragment` kind and its reassembly go.

The transport contract gains an optional cursor and a bridge instance id
([§3.2](#32-operations)), a fifth send failure, `needs-person`
([§3.4](#34-send-failures)), its transport profile becomes bounds and one suggested
pacing ([§3.5](#35-transport-profile)), and a transport carries frames of at least
4 MiB (TRN-23); none of these travels between participants. An application may carry
a document between one person's devices through another service (ARC-5), the one
connection beyond the bridge that ARC-2 allows. The bridges and the messenger
bindings, and the optional local bridge interface, are documents of their own
([bindings/](bindings/)), versioned apart; their envelope is unchanged. What changed
from 1.x, requirement by requirement, is [Appendix
G](#appendix-g-changes-from-tdsp-1x). A later version changes the wire only as
[§14](#14-versioning-and-extensibility) describes.

Frames and invitations carry the version `2`. The drafts of 2.0 carried a draft
marker in its place; a 2.0 engine refuses their frames and invitations as another
version, as every 1.x engine does, and reads control state they persisted as none
(VER-3).

TDSP adds no security layer of its own; its security properties are those of
the messenger it runs on, plus what [§15.3](#153-what-tdsp-enforces-itself)
enforces. No property below is stronger than the tests and the threat model
behind it.

This document is self-contained: every requirement states its reason. It
depends on no other document except the standards it cites (RFC 2119, RFC 8174,
RFC 3629, RFC 4648, RFC 5234, RFC 7493, RFC 8259, RFC 8785, FIPS 180-4, the
WHATWG URL Standard, and ECMAScript (ECMA-262) for what its `\s` and `JSON.parse`
mean where [§11.3](#113-invitation-as-a-link) and [Appendix A](#appendix-a-profile-yjs-paragraphs1)
name them) and, for the one profile it defines, Yjs update encoding
version 1 as [Appendix A](#appendix-a-profile-yjs-paragraphs1) pins it; a bridge or adapter
implementer also reads the binding of their messenger ([bindings/](bindings/)).
[§14](#14-versioning-and-extensibility) lists each part's version, and which parts
are stable and which stay drafts.
A reference implementation exists; [Appendix F](#appendix-f-reference-implementation)
names its parts. Where it deviates from this document, this document states the
intended behaviour. A second reading of the text that is no engine passes the
published test vectors ([§3.6](#36-conformance-suite), Appendix F), but no second,
independently written engine has yet exchanged frames with the reference, so
interoperability between engines is specified, not yet demonstrated.

### 1.3 Requirement language

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**,
**SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **NOT RECOMMENDED**, **MAY** and
**OPTIONAL** in this document are to be interpreted as described in BCP 14
(RFC 2119, RFC 8174) when, and only when, they appear in all capitals, as shown
here.

Every requirement has this form:

> **FRM-8** · *engine* — A receiver MUST … .
> *Rationale:* why the requirement exists.

- The **ID** is stable and never reused. A withdrawn requirement's ID is named as
  withdrawn at the end of the section it belonged to. The prefix names the
  section's topic. An ID this version carries over from TDSP 1.x keeps its topic,
  though not always its text; what 2.0 withdrew, changed or added is listed in
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
| **engine** | The protocol engine for one document on one device of a participant: frames, control state, bootstrap and resync, send scheduling, splitting into pieces, loss detection ([§4](#4-the-payload-frame)–[§10](#10-loss-detection)) |
| **adapter** | Implements the transport contract ([§3](#3-the-transport-contract)) for one messenger, by talking to its bridge |
| **bridge** | Holds one messenger account's credentials, speaks the messenger's own protocol, and carries frames in the messenger binding's envelope ([bindings/](bindings/)) |

A requirement of the class *all* binds every class, and whoever defines what it
governs: a profile, an extension, a revision of this specification.

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
| **Channel member** | Someone in a document's channel as the messenger reports it, whether or not they joined the document |
| **Device** | One installation of an application, holding an engine of its own for a document. A member may run several devices under one MemberId; for an engine, the others are devices of its **own member** |
| **Creator** | The one participant who created a document. Fixed at creation, never transferable; the document's single authority ([§2.3](#23-the-creator-is-the-single-authority)) |
| **Engine** | The component that runs the protocol for one document on one device ([§1.4](#14-conformance-classes)) |
| **Messenger** | The system that carries messages between participants — a messaging service, or any other message system with the properties of [§15.1](#151-what-a-messenger-must-provide) |
| **Channel** | The messenger-level conversation a document rides on: a Signal group, a Matrix room, an email thread with a participant set fixed when it starts, which only its creator can shrink. Set up by people, not by TDSP — but for an email thread, which the creator's bridge starts with the invitation ([email binding](bindings/email.md)) |
| **Binding** | The association of a documentId with a channel, held by a bridge; also, a messenger binding: how frames travel on one messenger ([bindings/](bindings/)) |
| **Delivery** | One received message, as the transport contract presents it: an id, a documentId, a sender and a payload |
| **Frame** | The payload of one delivery: a JSON object ([§4](#4-the-payload-frame)) |
| **Envelope** | The messenger-level wrapper around a frame, read only by bridges ([bindings/bridges.md](bindings/bridges.md)) |
| **Profile** | What a document's content bytes mean: its CRDT, structure and text projection, named by an id such as `yjs-paragraphs/1` ([§5](#5-document-profiles)) |
| **Update** | An opaque CRDT update: the unit of document change |
| **Piece** | A part of an update its profile split off, itself an update ([§9.4](#94-changes-larger-than-one-message)) |
| **Layer** | Data beside a document's content — comments, review notes — that every engine keeps and passes on, named by a layer id ([§5.6](#56-layers)) |
| **State vector** | A compact summary of which updates a CRDT replica has seen |
| **Control state** | A document's membership map, rights on layers, closed flag, pace and reason for the close, set only by the creator, as a register per target and a closed flag ([§7](#7-control-state)) |
| **Target** | What a decision is about: a member, a member's right on a layer, the pace, or the reason for the close ([§7.1](#71-what-control-state-is)) |
| **Creator device** | A device of the creator, named by a random **device tag**; a device that lost its state is a new device ([§7.2](#72-registers-and-the-clock)) |
| **Decision, register** | One decision of one creator device about one target; a **register** holds the latest on its target, with the decision's value, clock and device ([§7.2](#72-registers-and-the-clock)) |
| **Clock** | A pair `[ms, counter]` that orders decisions ([§7.2](#72-registers-and-the-clock)) |
| **Control clock** | The greatest clock among the registers a participant holds ([§7](#7-control-state)) |
| **Bootstrapped** | A device that holds the document's control state as it was passed on to it, or that it created: by creating the document, by merging an answer to its own request that carried one — on a device of the creator, only another device of the creator's —, by restoring a bootstrapped state — on a device that is not the creator's only as CTL-41 allows —, or, on a device of the creator, by being carried one from another device of the creator (ARC-5; RSY-14) |
| **Pace** | The shortest interval between two messages one engine sends for a document; set by the creator ([§9.1](#91-pacing)) |
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
  that message — a frame as `not-json` ([§4.4](#44-decoding-and-rejection)), an
  envelope as no envelope (BND-2) — and finds that out before it parses (JSN-1).
  No message this specification defines needs more than a handful of levels.
- Base64 is the standard alphabet with padding (RFC 4648 §4), and only its
  canonical form: the bits the padding discards are zero, so one text encodes one
  byte string. A device tag is base64url without padding (RFC 4648 §5) and the
  one exception to that form: 22 characters of its alphabet, compared as a
  string, the four bits its last character carries beyond 16 bytes unchecked.
- Strings are **UTF-8** (RFC 3629). A length "in bytes" is the length of that
  UTF-8 encoding; a length "in characters" counts Unicode code points.
- An integer field is a JSON number written as digits alone, without a sign, a
  fraction or an exponent: `-0`, `1.0` and `1e3` are none.
- A grammar is ABNF (RFC 5234).
- A duration named `…Ms` is in milliseconds; SND-25 says on which clock it is
  measured.

- **JSN-1** · *all* — A receiver of a JSON text this specification defines SHOULD
  find out in one pass over the text whether it nests deeper than 32 levels,
  before it hands the text to a parser that recurses once per level.
  *Rationale:* such a parser can exhaust its stack on a few kilobytes.
- **SND-25** · *engine* — An engine MUST measure every duration and wait this
  specification sets — a floor, a back-off, a request's expiry, a turn, a wait for
  evidence, how long something is kept — on a clock that does not run back, not as
  the difference of two wall-clock readings. A jump of the wall clock forward MAY
  count as time that passed. Only CTL-45's control clock reads the wall clock
  itself, by rules of its own for a wall clock that jumps back; what an engine
  reports to its application it MAY state on the wall clock.
  *Rationale:* a time service may set the wall clock back. Measured as the
  difference of two wall-clock readings, every such span would last as long again
  as the clock went back: on a wall clock set back an hour, a request would stay
  outstanding, a turn come and evidence count an hour late, and the next message,
  a decision included, wait that hour.

### 1.7 What must stay

*Informative.* TDSP 2.0 is checked against this list: every change was made so
that each item still holds. It is what 1.x covers, with one addition (the
service of item 12, ARC-5), and what an implementation of 2.0 can be tested
against.

1. **Three messengers**: Signal (no history, 800 inline bytes, attachments),
   Matrix (encrypted and plain rooms), email with PGP. Further bindings stay
   possible.
2. **One creator as the single authority**, no consensus, no second channel, no
   keys or signatures of TDSP's own. "Sender equals creator" stays the one check.
3. **Permissions** `read`, `write`, creator; grant and revoke at any time; close
   is final.
4. **Joining without history** (Signal) and with it (Matrix, email), from an
   invitation as a link or a message.
5. **Loss, duplicates, reordering**: convergence, loss evidence, healing by
   resync; no acknowledgements.
6. **One member on several devices**, the creator included; any participant
   brings a new device up to date while the creator is offline, its rights
   included.
7. **Persistence**: the creator restarts with its control state; any member
   restarts with persisted content shown at once; undistributed changes stay
   visible.
8. **Large changes**: megabytes at once arrive, and so does a bootstrap answer for
   a large document.
9. **External profiles and layers.**
10. **Attribution** as display, never as authentication.
11. **Bounded resources** against anything a peer sends.
12. **No external connection** but to the chosen messenger — and, where an
    application carries a document between one person's devices, to the service
    the person was told of (ARC-5).
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
| Application | Rendering, local undo grouping, showing attribution and status, choosing the profile | The engine's state is converged | Reach the network, but for the service of ARC-5; present attribution as authentication |
| Engine | Frames, bootstrap, resync, de-duplication, scheduling, control state, attribution overlay | A payload handed down is accepted by the messenger or visibly refused, where accepted means neither delivered nor applied ([§3.3](#33-delivery-semantics)) | Parse an envelope; open a network connection |
| Adapter | Mapping the transport contract onto its bridge | Its bridge is reachable | Parse a frame |
| Bridge | Credentials, the messenger's protocol, routing by documentId, message immutability | The messenger delivers to channel members and names senders | Parse a frame; reach any host but its one messenger endpoint |
| Messenger | Delivery, sender authentication, encryption, channel membership | — | — |

A useful test for where something belongs: **a rule about the document — who may
do what, and when — belongs in the engine; a fact about the messenger belongs in
the bridge.** Permissions are such a rule. A message size limit is a fact.

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
  (LBI-1, [local bridge interface](bindings/local-bridge-interface.md)). The one
  exception is an application's connection to the service through which it
  carries a document between one person's devices (ARC-5), for carrying it.
  *Rationale:* TDSP promises that it opens no external connection of its own; the
  only component that talks to the outside world is the bridge, and it talks only
  to its messenger (BRG-4, [bindings/bridges.md](bindings/bridges.md)). The
  service of ARC-5 carries nothing between participants: it is storage the person
  was told of, through which no one but the person and that storage's provider
  reads or writes the document.
- **ARC-3** · *adapter, bridge* — An adapter or bridge MUST NOT parse, validate or
  act on the content of a frame. It routes by the envelope's documentId and
  hands the frame on unchanged.
  *Rationale:* the frame format and every protocol rule then live in exactly one
  place, the engine; a bridge that interprets frames is a second, divergent
  implementation of the protocol, and the transport stops being replaceable.
- **ARC-4** · *application, adapter, bridge* — Messenger credentials (keys,
  tokens, passwords, linked-device state, keyrings):
  - SHOULD be held by a component separated from the one that renders document
    content — a separate process, an XPC service or an equivalent
    operating-system boundary;
  - MUST NOT be passed to the engine or to any component that renders document
    content or anything else received through the channel.

  A sign-in form of the application MAY take a password the person types and hand
  it to the bridge, when the form runs outside such a component and keeps nothing
  of it.
  *Rationale:* the component that renders untrusted content should not be able to
  speak as the user on the messenger; a process boundary makes that a property
  of the system rather than of the code's discipline. It is a SHOULD because a
  single-process program without untrusted rendering has no such component to
  separate. What matters is which component holds a credential, not which program
  it belongs to: a bridge reached as a separate process has no window of its own,
  and the form the person types a password into belongs to the application; it is
  safe there as long as nothing that renders what others sent can reach it.
- **ARC-5** · *application* — ARC-1 governs what passes between participants. An
  application MAY carry a document's content and binding between the devices of
  one person through another service (storage of the person's own account at
  another provider, say), as it may keep a backup there; it MAY carry the control
  state that way only between devices of the document's creator. It MUST tell the
  person, before it first does so, that the document's content is then stored
  there, as confidential as that service makes it rather than as the channel does,
  and MUST use for it only storage through which no one but the person, and the
  provider of that storage, reads or writes the document. An application that
  carries the control state of a device of the creator MUST have the receiving
  device continue under a new tag of its own (CTL-20), never under a tag the carried
  state holds: it gives that state to its engine as a snapshot carried from another
  device of the creator (CTL-25), not as the device's own persisted state (CTL-26),
  and with it whether that state was bootstrapped there (RSY-14).
  *Rationale:* a person's own devices are one participant, so ARC-1's reason — that
  confidentiality and sender authentication between participants come from the
  messenger — does not reach them; a person who uses several devices needs their
  documents on each, and a messenger without history cannot bring a new device up to
  date by itself. What the other service changes is where a copy lies, and TDSP
  protects nothing beyond the channel ([§15.4](#154-what-is-not-guaranteed)): the
  person has to know which service that is. A device that went on under a tag the
  carried state holds would decide under one tag with the device the state came
  from: the two would meet where both decide at one clock, which CTL-22 settles
  alike for every receiver, though their registers still converge. A tag of its own
  spares that and costs nothing. The carried state holds the creator's decisions
  only as far as the service keeps it so, not because a messenger authenticated it:
  whoever can write there, its provider included, can hand the creator's device
  registers it then passes on as its own ([§15.3](#153-what-tdsp-enforces-itself)).
  A member's control state is the creator's registers as its engine received them;
  carried through another service it would be that service's word, and a member's
  engine takes control state only from the channel (CTL-25) or, on the same device,
  from what it persisted (CTL-39).

### 2.2 Two wrappers, two readers

One message on the wire carries two nested wrappers with different readers.
Confusing them is the most common way to get this stack wrong.

```text
  messenger message   (a Signal group text · a Matrix event · an email)
  └── envelope   {"tdsp":1,"kind":"frame","documentId":"…","frame":"<the frame as a JSON string>"}
      │          read by the BRIDGE: routing
      └── frame  {"tdsp":2,"kind":"edit","documentId":"…","update":"<Base64>"}
          │      read by the ENGINE: verification and interpretation
          └── update   opaque CRDT bytes, read by the document's PROFILE
```

The two version fields are kept apart on purpose. The envelope's `tdsp` is the
envelope's own version and stays `1`: the envelope did not change, so a bridge of
1.x carries frames of 2.0 unchanged, though an engine of 2.0 refuses the
transport profile it serves (TRN-13,
[Appendix F](#appendix-f-reference-implementation)). The frame's `tdsp` is this
specification's version (FRM-2, VER-1).

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
| Grants, changes and revokes `read`/`write`, on the document and on its layers ([§7](#7-control-state)) | Edits, if permitted |
| Closes the document ([§6.4](#64-closing-a-document)) | Observes that it is closed |
| Decides, from any of its devices; the later decision holds | Merges them by their clocks |
| Sets the pace: the shortest interval anyone sends at ([§9.1](#91-pacing)) | Keeps to it and to their own bridge's bounds; the rest of their pacing is their own |
| Answers every request at once, every joiner's bootstrap included ([§8](#8-bootstrap-and-resync)) | Asks; answers its own member's devices at once, and anyone's after a wait when asked by all ([§8.3](#83-who-answers)) |

The gain is that **membership integrity reduces to one comparison**: does a
delivery's authenticated sender equal the one creator identity every
participant learned from the invitation? There is no consensus protocol, no
shared server and no key agreement about who may decide. Authority means whose
decisions cooperating engines follow, not protection against a participant who
ignores them ([§1.1](#11-what-tdsp-is), [§15.4](#154-what-is-not-guaranteed)).

The cost is stated as plainly: **the creator is a single point of
availability.** While the creator is offline, nobody can be granted anything. A
new device is brought up by any participant who holds the document, asked by all
([§8.3](#83-who-answers)), with the content and what that participant holds of the
creator's decisions ([§7.5](#75-the-control-snapshot)); a decision that reached no
one online reaches it later. That is a delay, not a loss: the participants who
already hold the document keep converging among themselves. A creator who lost a
device is not lost as the creator: a new device of hers is brought up by another
of her devices, or from a backup ([§7.6](#76-a-new-device-of-the-creator)). Her
devices hold the document's rights; one who lost every device and every backup
closes the document and continues in a new one (CTL-46).

## 3. The transport contract

The transport contract — `MessengerPort` in the reference implementation — is
the interface between an engine and an adapter ([§2.1](#21-layers)). It expresses
what a messenger can do, never a vendor API, and it carries no rule about the
document: permissions, lifecycle and resync are frames, not methods.

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
| `sendInvitation(documentId, sender, text)` → `DeliveryId` | Optional. Sends a human-readable invitation ([§11](#11-invitations)) into the document's bound channel as `sender`, who must be the bridge's own account (BRG-16) and the document's creator (the invite route of the [local bridge interface](bindings/local-bridge-interface.md#126-the-local-bridge-interface-optional)). A binding whose invitation *is* how its channel begins — email: the thread's root message — has no separate step and omits it |

Creating a channel or changing its members is no operation of this contract:
where an application does it ([§6.6](#66-who-takes-part), LIF-9), it does so
through its bridge's own provisioning, as it binds a channel.

- **TRN-5** · *adapter* — `createDocument` MUST NOT change the membership,
  permissions or configuration of any existing channel.
  *Rationale:* binding a document administers no channel. Changing a channel people
  set up as a side effect would need powers the participants did not grant and
  would make TDSP responsible for access control it cannot enforce; where an
  application creates a channel or changes its members, it does so deliberately,
  through its bridge's own operations on the channel (§6.6, LIF-9).
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
  - control state is registers, of which merging one again changes nothing
    (CTL-6);
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
  either only in memory, say — and SHOULD stay the same otherwise, also across a
  restart that kept both.
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
- **TRN-17** · *adapter, engine* — `channelMembers` MUST answer the channel's
  members as the messenger reports them at the moment of the call, this account
  included, and MUST refuse a channel this account is not in rather than answer
  for it. It is a snapshot: who joined or left between two calls is not reported.
  An engine MUST NOT call it.
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

- **TRN-10** · *engine, application* — An engine MUST NOT depend for correctness
  on ordering, exactly-once delivery, history replay or loss notification by the
  transport, and MUST treat a successful `send` as "accepted by the messenger",
  never as "delivered" or "applied": it MUST expect that an accepted message
  never reaches some members, and an application MUST NOT show a sent change as
  received by everyone.
  *Rationale:* none of the supported messengers provides all four, and Signal
  provides no history at all; a mechanism that needs one of them works on some
  messengers and fails silently on others.

### 3.4 Send failures

A refused send must say whether trying again can help, because the engine keeps
and retries what can succeed later, drops what cannot (SND-6, SND-8), and waits
for the person where only the person can help (TRN-20).

| Reason | Meaning | Retryable |
|---|---|---|
| `rate-limited` | The messenger is throttling; may carry `retryAfterMs`, the wait the messenger asked for (TRN-11) | Yes |
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
  message, and MUST NOT report the change as dropped. After such a refusal of any
  message it MUST NOT send anything — no message of any kind — sooner than its
  longest back-off ([Appendix B](#appendix-b-recommended-values)), unless its
  application asks it to send now (TRN-22); where it keeps nothing of the message
  refused (SND-20), it MUST still expose that sending waits for the person, with the
  transport's message, while that wait lasts.
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
  can carry, attachments included where the binding has them; at least 4 MiB
  (TRN-23). Larger changes are sent as pieces
  ([§9.4](#94-changes-larger-than-one-message)). `null` for none.
- `pacing` — a complete pacing ([§9.1](#91-pacing)): all five values, `null` only
  for `maxIntervalMs` or `maxChars` without a limit. A suggestion, unlike the
  bounds. Named presets, their labels and descriptions belong to the application,
  not to the transport.

Every field is required. "No bound" and "no limit" are spelled `null`, never by
leaving a field out.

- **TRN-13** · *adapter, engine* — A transport profile MUST be validated as a whole:
  a missing field, a field that is not defined, a number that is negative or not
  finite, or `null` where it is not allowed MUST make the whole profile invalid,
  and an invalid profile MUST cause the call that obtained it to fail rather than
  be treated as "no profile".
  *Rationale:* falling back to no limits on a garbled profile means sending faster
  than the messenger allows, which is how messages get refused and lost. Requiring
  every field closes the quiet version of the same fault: a misspelled optional
  field would otherwise read as "no bound".
- **TRN-14** · *engine* — An engine MUST obtain the transport profile, if the adapter
  offers one, before it registers a document it creates (`createDocument`) or sends
  its first frame, and MUST fail the creation or join of a document if that fails.
  *Rationale:* same as TRN-13; an engine that starts sending before it knows the
  floor can exhaust a provider's budget in its first minute; one that registers a
  document before it knows the transport may leave it registered where it fails.
- **TRN-23** · *adapter, engine* — A transport MUST carry frames of at least 4 MiB
  (4 194 304 bytes): its profile's `bounds.maxBytes` MUST be `null` or at least
  that. An engine MUST fail the creation or join of a document on a transport whose
  profile states less, with an error of its own that names the bound, before it
  registers the document (TRN-14).
  *Rationale:* an answer carries its responder's control state whole (SND-18). A
  device of the creator keeps what it decides within what one answer carries
  (CTL-37), but two of her devices decide apart, and their merge may hold more than
  either did — more than an answer of a small transport carries, and still within
  what every receiver holds (CTL-30): nobody new could be bootstrapped, and nothing
  would say so. At 4 MiB the most a receiver holds, 3 MiB, fits one answer with room
  to spare (§7.4). Refused when the document is created or joined, a transport too
  small is a fault its person sees at once, not one that shows only once the control
  state has grown. Every binding of this version carries 4 MiB
  ([bindings/](bindings/)).
- **TRN-15** · *adapter* — An adapter that has no profile MUST return `undefined`
  (or not offer the operation); the engine then applies its own defaults
  ([Appendix B](#appendix-b-recommended-values)).
  *Rationale:* the in-memory test transport has no limits and must not be forced
  to invent some. (A bridge in front of a server on the same machine answers a
  profile with no floor and a pacing equal to the engine's defaults, which has
  the same effect.)

### 3.6 Conformance suite

The transport conformance suite is these cases; the reference implementation
exports them from `packages/messenger-port/src/contract.ts`. Each runs with a
fresh fixture of two ports, a creator and a member, and polls for up to 15
seconds because real adapters deliver asynchronously:

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
polls, and ordering. Rules that are the engine's — a read-only member does not
send, only the creator changes membership, nothing is sent after a close — are
tested once in the engine's own suite, not per adapter.

For the wire itself, the reference implementation publishes versioned **test
vectors** (informative): `packages/document-protocol/test-vectors/frames-v2.json`,
frames that must decode to a given kind and frames that must be rejected with a
given reason from [§4.4](#44-decoding-and-rejection), each read by a receiver
whose document has the profile the file names; `invitations-v2.json`
for the link of [§11.3](#113-invitation-as-a-link); and `control-v2.json`,
registers and the value their merge gives each target, in any order and as a
snapshot ([§7](#7-control-state)), with the rights those registers give — the
permissions, not what a closed document takes (LAY-5). The bindings publish their own
([bindings/](bindings/)). An implementation in another language shows it reads
the wire as this specification does by passing them; the reference
implementation checks itself against the same files.

Beside them, in the same directory, it publishes **behaviour vectors**
(informative), which fix no wire and are not in the wire lock:
`clock-v2.json`, the algorithm of CTL-45 as pure functions; `digests-v2.json`,
the control digest through its RFC 8785 text and the state digest from what a
replica deleted (LOS-24, [Appendix A](#appendix-a-profile-yjs-paragraphs1));
`updates-v2.json`, bytes that are or are not an update or a state vector of
`yjs-paragraphs/1` (Appendix A, *Reading without applying*); and
`flows-v2.json`, flows of several devices on one channel — their initial state,
a fixed time, inputs in delivery order, and what each device must then show and
must have sent — in five groups: answers to all, decisions of two devices of the
creator, what bootstraps a device, bounds, Unicode and bytes, and healing at the
next occasion. The file says how to run them, with fixed waits instead of random
time, and each device's turn (RSY-20) and the place of its gaps' first tries
(LOS-6) fixed instead of derived. An update sent in pieces is checked by its content
and by each piece's bound, not by how many pieces it took or where they were cut
(SND-17).
The published vectors, the wire's and these, are what "checked against the
vectors" means ([CONFORMANCE.md](CONFORMANCE.md)): an implementation that passes
them reads, merges, digests, orders and recovers as this specification does,
which is no exchange with a second engine. [Appendix F](#appendix-f-reference-implementation)
names a checker that reads them.

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
| `resync-response` | the creator; another device of the requester's own member; any member answering a request to all ([§8.3](#83-who-answers)) | An update, a control snapshot and an attribution overlay |
| `control` | a device of the creator only | One or more registers, and the close flag ([§7](#7-control-state)) |
| `heartbeat` | any member | A report: the sender's state vector and state digest — from a bootstrapped device of the creator also its control clock and control digest —, its stream and number, and optionally its last `edit`'s update again ([§9.3](#93-the-report)) |
| `decline` | any member of the channel, joined or not | Why an invitation was declined ([§6.5](#65-declining-an-invitation)) |

The `fragment` kind of TDSP 1.x is gone: a change larger than one message travels
as pieces, each an ordinary `edit` or `resync-response`
([§9.4](#94-changes-larger-than-one-message)).

### 4.3 Kind-specific fields

"Base64" is a string of Base64 text; "uint32" is a JSON integer from 0 to
4 294 967 295, written as an integer field ([§1.6](#16-notation)); a "device tag" is 22
characters of base64url without padding, the encoding of 16 random bytes
([§7.2](#72-registers-and-the-clock)), read as §1.6 says: in its alphabet, its spare
bits unchecked; a "clock" is an array of exactly two JSON
integers `[ms, counter]`, `ms` from 0 to 2^48 − 1 and `counter` from 0 to 65 535
(CTL-45); a "register" is an object of exactly `value`, `clock` and `device`
(CTL-20); a "stream tag" is 16 lowercase hex digits, chosen at random by an engine
each time it starts (LOS-13); a "digest" is 16 lowercase hex digits (LOS-24).

| Kind | Field | Type | Meaning |
|---|---|---|---|
| `edit` | `update` | Base64, not empty | A CRDT update, or a piece of one ([§5](#5-document-profiles)) |
| `resync-request` | `requestId` | 16 lowercase hex digits | Random, chosen by the requester, new for every request; what the answer names (RSY-16) |
| | `controlClock` | clock or `null` | The requester's control clock; `null` until it is bootstrapped (RSY-16, RSY-14) |
| | `controlDigest` | digest or `null` | The digest of the requester's control state (LOS-24); `null` exactly when `controlClock` is |
| | `all` | boolean | Whether any member may answer the request (RSY-16) |
| | `force` | boolean | `true` when the requester needs an answer even if it seems to lack nothing: its history was truncated, or it gave up what it held for missing predecessors (LOS-8, LOS-9, LOS-23) |
| | `stateVector` | Base64 | The requester's state vector |
| | `stateDigest` | digest | The digest of what the requester deleted (LOS-12) |
| | `stream` | stream tag | The requester's stream (LOS-13) |
| | `sequence` | uint32, at least 1 | This report's number in that stream (LOS-13) |
| `resync-response` | `respondsTo` | 16 lowercase hex digits | The `requestId` of the request answered |
| | `update` | Base64, not empty | The responder's state since the requester's state vector (RSY-8), or one piece of it; the update that holds nothing (PRF-1, item 4) where the requester lacks nothing, and in a piece that carries only the snapshot and the overlay (SND-18) |
| | `control` | object or `null` | The responder's control snapshot, in the layout of [§7.5](#75-the-control-snapshot), or `null`, as RSY-8 says: `null` before its bootstrap (RSY-14) and in a capacity conflict (CTL-32) |
| | `attribution` | object or `null` | The responder's attribution overlay, in the layout of [§5.4](#54-attribution-overlay); `null` for none |
| | `stateVector` | Base64 or `null` | In an answer's last piece, the responder's state vector as it answered; `null` in the others (RSY-18) |
| | `stateDigest` | digest or `null` | Beside `stateVector`, the digest of what the responder deleted; `null` exactly when `stateVector` is |
| | `stream` | stream tag | The responder's stream, the same in every piece of the answer (LOS-13) |
| | `sequence` | uint32, at least 1 | The answer's number in that stream, the same in every piece (LOS-13) |
| | `piece` | uint32, at least 1 | This piece's number in the answer, 1, 2, 3, … in the order sent (LOS-14) |
| | `pieces` | uint32 or `null` | In an answer's last piece, how many pieces the answer has — that piece's own number; `null` in the others, and exactly when `stateVector` is (RSY-18) |
| `control` | `device` | device tag | The device of the creator that sends the frame |
| | `targets` | object of 0 to 5 002 entries, whatever their targets | Each a target — `member:<MemberId>` (the MemberId 1 to 255 bytes), `layer:<layer id>:member:<MemberId>` ([§5.6](#56-layers)), `pace` or `close-reason` ([§7.3](#73-merging)) — mapped to a register (CTL-20): the registers the device decided with this frame, and any others it holds that it adds; never a target that names the creator |
| | `closed` | boolean | The device's close flag after this frame; a frame whose `targets` is empty carries `true` |
| | `controlClock` | clock or `null` | The device's control clock after this frame; `null` from a device of the creator that is not bootstrapped (RSY-14) |
| | `controlDigest` | digest or `null` | The device's control digest after this frame (LOS-24); `null` exactly when `controlClock` is |
| `heartbeat` | `controlClock` | clock or `null` | The control clock of a device of the creator that is bootstrapped; `null` from anyone else (SND-11, RSY-14) |
| | `controlDigest` | digest or `null` | The digest of that device's control state (LOS-24); `null` exactly when `controlClock` is |
| | `stateVector` | Base64 | The sender's state vector |
| | `stateDigest` | digest | The digest of what the sender deleted (LOS-12) |
| | `stream` | stream tag | The sender's stream (LOS-13) |
| | `sequence` | uint32, at least 1 | This report's number in that stream (LOS-13) |
| | `update` | Base64, not empty | optional, never `null`: the update of the sender's last `edit` frame, as it went out (SND-27) |
| `decline` | `reason` | `"unsupported-profile"`, `"unsupported-version"`, `"declined"` or `"other"` | Why ([§6.5](#65-declining-an-invitation)) |
| | `profiles` | array of profile ids, at most 16 | optional, never `null`: the document profiles the sender implements |
| | `text` | string, at most 500 characters | optional, never `null`: a human-readable explanation |

- **FRM-5** · *engine* — A sender MUST write exactly the fields its frame's kind
  defines — the common ones, every required one, and an optional one only where
  it has a value — and no other field whose name has no `.`. It MAY add extension
  fields and `crit` (FRM-9 to FRM-12, FRM-15 to FRM-17).
  *Rationale:* a layout with a single reading of its defined fields is what lets
  two independent implementations interoperate; where something new is needed, an
  extension field says so by its name instead of hiding in an undefined one.

FRM-14 is withdrawn.

### 4.4 Decoding and rejection

A receiver parses a frame, then checks that it belongs to the document the
delivery was routed to. Each failure has a name, so that an implementation's
report — and a test — can tell a version mismatch from a malformed message:

| Reason | When |
|---|---|
| `not-json` | The payload is not valid UTF-8, not valid JSON, not a JSON object, or not I-JSON: an object names a member twice, or a string holds an unpaired surrogate; or it nests arrays and objects more than 32 deep ([§1.6](#16-notation)) |
| `unsupported-version` | `tdsp` is missing or is not 2 — 1.x's 1 and a draft's marker (VER-3) among them |
| `unknown-kind` | `kind` is not one of §4.2 |
| `missing-field` | A field the kind requires is absent — in the frame, a snapshot, a register, an overlay or one of its ranges |
| `invalid-field` | A field has the wrong type or a value the layout forbids — an integer out of range, Base64 that does not decode or is not in its canonical form ([§1.6](#16-notation)), an empty `update`, an `update` or `stateVector` the document's profile does not read as exactly one update or state vector (PRF-1, item 9; bytes after a complete one included), a device tag that is not 22 base64url characters, an unknown `target`, a `value` its target cannot take, a clock that is not an array of exactly two integers in their ranges, a register, a snapshot or an overlay that is not an object, a register with a field besides `value`, `clock` and `device` (extension fields aside), a `control` frame without registers and without `closed: true`, a `controlClock` and `controlDigest` of which only one is `null`, an unknown `reason`, an overlong `text`, a `crit` that is not a list of 1 to 16 distinct names of extensions the frame carries, an answer's `pieces` that is not `null` and differs from its `piece`, a `pieces` without `stateVector` or a `stateVector` without `pieces`, a snapshot or overlay that breaks its layout (§5.4, §7.5) — or the frame, a snapshot or an overlay has a field whose name has no `.` and that its layout does not define; or an extension the receiver implements and `crit` names has a value its definition forbids (FRM-16) |
| `unsupported-extension` | `crit` names an extension the receiver does not implement (FRM-10) |
| `document-mismatch` | The frame's documentId is not the document the delivery was routed to |
| `profile-mismatch` | A `resync-response`'s control snapshot that the receiver would merge (CTL-25) names a profile other than the document's (CTL-10) |

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
  wrongly; see [§2.2](#22-two-wrappers-two-readers).
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
  receiver MUST ignore an extension it does not implement — in a frame, a
  snapshot, its registers, and an attribution overlay alike, wherever a layout
  names its fields — and MUST NOT let it change how it reads any defined field. The
  keys of an object whose keys are data are not field names: a snapshot's and a
  `control` frame's `targets` and an overlay's `lastEditBySender` are keyed by
  targets and MemberIds, and a target such as `member:@bob:example.org` is a
  target, not an extension, though it contains `.`.
  *Rationale:* closed layouts make every addition a wire break, and a protocol that
  can grow only by major version collects wishes until the break is big enough. A
  name with `.` cannot collide with a field this specification defines, which never
  has one (also for invitations, [§11.3](#113-invitation-as-a-link), INV-6).
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
  for answers). Below a frame's top level — in a snapshot, its registers, and an
  overlay — this version defines no place for an extension an engine implements;
  there, every extension is ignored (FRM-9).
  *Rationale:* ignoring is not passing on: an extension that rode along in state
  would reach, in a relayed snapshot (CTL-25), receivers that never saw the frame
  it came with, and a receiver that does not implement it would have dropped it on
  the way. One frame, one sender, one meaning is what a receiver can check.

### 4.5 Example

A real `edit` frame for documentId `doc-a1b2c3`, produced by the reference
encoder. Its update is the whole state of a new `yjs-paragraphs/1` document
whose first paragraph holds "Hi" — one Yjs client, clocks 0 to 3:

```json
{"tdsp":2,"kind":"edit","documentId":"doc-a1b2c3","update":"AQOJmvSYDwAHAQdjb250ZW50AwlwYXJhZ3JhcGgHAIma9JgPAAYEAIma9JgPAQJIaQA="}
```

The Yjs update is 50 bytes and its Base64 text 68; the frame is 130 bytes, the
other 62 being the field names, the kind, the documentId and JSON punctuation.
[Appendix D](#appendix-d-example-frames) has one frame of each other kind.

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
length is bounded. A profile defined outside this specification should begin its
name with a reverse domain name its definer controls (`com.example.markdown/1`,
PRF-7).
An incompatible change to a profile is a new major version, and a new profile id.
This specification defines one profile, `yjs-paragraphs/1`, in
[Appendix A](#appendix-a-profile-yjs-paragraphs1).

### 5.1 What a profile must define

- **PRF-1** · *all* — A profile MUST define:
  1. an **update** encoding, such that applying a set of updates in any order,
     with duplicates, yields the same state (convergence), and an update whose
     causal predecessors are missing is held rather than rejected;
  2. how to tell that updates are being held for **missing predecessors**, and,
     where the CRDT allows it, whose, and how far an update carries each writer —
     the position of a gap of that writer (LOS-25); and always how many bytes they
     take, and how to give them up (LOS-23);
  3. a **state vector** encoding that summarises which updates a replica holds;
  4. how to encode **the updates a state vector lacks** of those a replica applied,
     not those it holds for missing predecessors — where the empty state vector
     yields the full state — and how to tell whether a state vector holds
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
neither overlap nor leave a gap; `ranges` may be empty (`[]`), as for an
empty projection. Every value of `lastEditBySender` is a uint32,
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
  made while the engine held content (the response healed only part of a gap, or
  it answers a member or a creator that restarted with content), the engine:
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

- **PRF-7** · *all* — An application MUST NOT use a profile defined
  outside this specification unless the profile has a public definition at a
  stable location, under terms that let anyone implement it. The definition MUST
  cover every item of PRF-1 and the document's structure, at the level of detail
  of [Appendix A](#appendix-a-profile-yjs-paragraphs1), and MUST come with test
  vectors: updates, the state they yield together, and that state's plain-text
  projection. A published definition MUST NOT change incompatibly; an
  incompatible change is a new major version, and a new profile id. The id's name
  SHOULD begin with a reverse domain name its definer controls, as an extension's
  does (FRM-15).
  *Rationale:* the id is all a peer is told about the content. An id whose meaning
  cannot be looked up is the covert extension point FRM-5 rules out for frames,
  and without test vectors two implementations of one id cannot tell whether
  they agree; if they do not, their documents diverge silently. A domain its
  definer controls keeps two definers from choosing one id.
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
in the grammar of [§5](#5-document-profiles). A layer defined outside this
specification should begin its name with a reverse domain name its definer
controls (`com.example.comments/1`, LAY-4); this specification defines no layer. A
profile says whether, and where, it admits layers; `yjs-paragraphs/1` does
([Appendix A](#appendix-a-profile-yjs-paragraphs1)). No frame, invitation or
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
  copies, restores or migrates a document (the document itself, under its
  documentId, on another device or in another store), and SHOULD show the person
  that the document holds data it does not display. A new document created from a
  document's content ([§6.2](#62-creating-a-document)), and an export out of TDSP,
  are not copies in this sense: they MAY leave layers out, and SHOULD tell the
  person that they do.
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
- **LAY-4** · *all* — An application MUST NOT use a layer unless the layer
  has a public definition at a stable location, under terms that let anyone
  implement it, stating its structure, what in the content it points into and how,
  and what a reader shows when that content is gone or has moved. The definition
  MUST come with test vectors and MUST NOT change incompatibly; an incompatible
  change is a new major version, and a new layer id. The id's name SHOULD begin
  with a reverse domain name its definer controls (FRM-15). A layer SHOULD point
  into the content by the CRDT's own relative positions.
  *Rationale:* as for a profile (PRF-7), a peer that implements a layer must be
  able to find out what it means, two implementations must be able to check that
  they agree, and two definers must not choose one id. A relative position
  follows edits to the text it points into; where it cannot, the definition says
  what the reader does instead of guessing.

The creator may give a member a **right on a layer** that differs from the
member's permission on the document: `read` or `write`, as a decision on
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
  - a layer on which its permission is `read`;
  - the content, while its permission on the document is `read`;
  - anything, while its permission on the document is revoked;

  a permission that no register gives counting as `read` once the engine is
  bootstrapped (CTL-13).

  *Rationale:* as with the permission on the document, receivers do not reject an
  edit for its sender's right on a layer (CTL-7): grant and change are unordered,
  and the rights are as strong as the participants' engines (§15.2). `read` hides
  nothing: whoever is in the channel reads every layer. In `yjs-paragraphs/1` an
  editor re-anchors a layer when it splits a paragraph (Appendix A); a member who
  may write the content and only read the layer cannot, and the layer's definition
  says what a reader shows then (LAY-4).
- **LAY-7** · *engine, application* — An engine MUST tell what a change touches
  (LAY-6) from the change itself as it makes it, by the parts of the document the
  profile names (YJS-1: `content` is the content, a top-level type named by a
  layer id is that layer, and any other top-level type counts as content, YJS-4).
  A change that touches several parts and may not be sent for one of them MUST be
  refused whole (LAY-6), and an application that holds changes (CTL-42) holds it
  whole. An engine MUST NOT merge, into one message, changes it may send with
  changes it may not.
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
  (SND-2); a failed send of it fails the creation (SND-20).
  *Rationale:* on a messenger that does replay history, participants who were
  already listening then hold the document without a resync; on one that does
  not, the creator's bootstrap answer carries the same state anyway.

### 6.3 Joining a document

A joiner's application reads an invitation and has its bridge bind the document
to the named channel, which re-checks that the joiner is really a member of it
(BRG-5). If its engine does not implement the invitation's profile, it declines
the invitation, through the binding just made ([§6.5](#65-declining-an-invitation),
DCL-2); otherwise it creates an engine with the invitation's creator and profile,
and the engine bootstraps ([§8](#8-bootstrap-and-resync)).

- **LIF-4** · *engine* — An engine MUST NOT be created, for joining, without the
  creator's MemberId.
  *Rationale:* without it no control frame and no resync response can be
  accepted (CTL-5, RSY-12); the engine would silently never converge.
- **LIF-5** · *application* — A creator resuming its own document after a restart
  MUST rejoin it as creator with its persisted control state (CTL-26), and MUST
  NOT create it anew while it holds that state. An application MUST:
  - persist that it creates a document — its documentId, and that it is the
    creator — before it creates the engine that sends the initial state;
  - create a document so marked for which it persisted no control state anew,
    under its documentId: by CTL-26 and CTL-38 nothing of it went out.

  *Rationale:* creating anew seeds an empty document over real content and
  starts a control state that knows none of the creator's earlier decisions. A
  document marked as created for which no control state was persisted sent nothing
  (CTL-26, CTL-38): created anew, under the same documentId and in the same
  channel, it loses nothing; resumed as a device that is not bootstrapped, it would
  wait for an answer no one can give (RSY-14). With the mark, a stop before then
  leaves a document the application creates anew, never one it forgets or joins.

An application may also persist a document's content and show it at once after a
restart, and any participant's control state (CTL-39); TDSP requires only the
creator's (CTL-26).

- **LIF-8** · *application* — An application that persists a document's content
  SHOULD persist with it:
  - with a transport that offers `receiveSince` (TRN-18), the cursor its engine had
    reached when the content was taken — never one ahead of the control state the
    application restores with the content (CTL-40);
  - with a transport that offers `instance` (TRN-19), the instance its engine held
    with that cursor;
  - when its engine began the last read for the document that reached the
    messenger and whose deliveries the content holds, or an earlier time, by the
    device's clock — not when the content was taken.

  A read that a bridge answered from what it held while it could not reach its
  messenger (TRN-7) does not count; where the application cannot tell, it persists
  an earlier time it can vouch for — the start of a read after which the messenger
  accepted a send, say —, or one so early that the next start counts as a return
  (RSY-21). While its engine holds *history truncated* evidence (LOS-8, LOS-9), it SHOULD
  keep the cursor and instance it persisted last rather than persist new ones.
  When it starts the engine from persisted content, it SHOULD tell it that time,
  how long its transport keeps a message for a device that is away, where its
  binding or the application knows it, and that it had unbound the document from
  its channel since, where it did (RSY-21). While the engine runs, an application
  that knows how long its transport keeps a message SHOULD tell the engine when a
  read reaches the messenger again after the last read that did began longer ago
  than that — counted from that read's start or from an earlier time, as above
  (RSY-21).
  *Rationale:* with the cursor a restarted engine reads on and learns whether its
  transport still holds everything since; with the instance, compared at its first
  read (LOS-9), a bridge that may have lost something meanwhile shows it. While
  that evidence lasts, a new instance would read as the one the cursor was read
  under, and a restart would read on past the loss. Where the transport cannot tell
  what it no longer holds, the time and how long it keeps tell the engine that it
  may lack something, and an unbound document received nothing at all (RSY-21).
  The content may be taken after the last read that reached the messenger — the
  person typed on through an outage, or a bridge answered from its window —, so the
  time it was taken could hide a return; counted from the start of that read, or
  earlier, the absence is at least as long as it was. The same time tells a running
  engine of an absence it cannot see by itself (RSY-1, LIF-12).
- **LIF-12** · *application* — An application SHOULD tell its engine when it stops
  using the document — its person closes it, or the application ends — and before
  its device sleeps, so that a report owed goes as soon as it may (SND-11). While
  the engine runs, it SHOULD tell it, once a read reaches the messenger again, how
  long before that the last read that did began, counted as LIF-8 counts it
  (RSY-1, RSY-21). It SHOULD offer its person to synchronise now: to send what
  waits and make a request of its own (RSY-3), which wakes every resting gap
  (LOS-26).
  *Rationale:* a device closed or put to sleep before its report went keeps it owed
  until it opens the document again (SND-28), and the others meanwhile miss a last
  change they may have lost. A running engine cannot see that its device slept or
  had no network (RSY-1, RSY-21). A gap rests after its tries (LOS-6), and the
  person may know what the engine cannot — that another device is online again —;
  synchronising now is their way to ask.

After a restart the engine asks as RSY-1 says and sends a report it owed
(SND-28); anyone but the creator edits only once bootstrapped (CTL-41), its
application holding what the person types until then (CTL-42); persisted content
can hold changes that never reached anyone else (SND-8).

### 6.4 Closing a document

Closing marks a document as finished. It is the only lifecycle transition after
creation, and it is a decision of the creator ([§7](#7-control-state)).

- **LIF-6** · *engine, application* — After it has applied a close, an engine MUST
  NOT send `edit` frames of its own, and a device of the creator MUST NOT make
  further decisions but on the reason for the close (CTL-23); a frame it made
  before and has not yet sent it still sends (CTL-26). The engine MUST still:
  - apply every valid `edit` frame it receives, and every update a report carries
    (SND-27) — an edit sent before the close may arrive after it;
  - send its reports (SND-11), which carry again what it sent last before the
    close (SND-27);
  - accept a `resync-response` as RSY-12 says;
  - answer resync requests as [§8](#8-bootstrap-and-resync) prescribes.

  A device of the creator that holds the close sends it again as LIF-11 says. An
  application SHOULD show a closed document as still synchronising while its
  engine suspects a loss ([§10](#10-loss-detection)).
  *Rationale:* a close and the edits sent just before it are unordered on the
  transport (TRN-10): discarding an edit that arrives after the close would leave
  two receivers of the same messages with different documents for good. A close
  therefore ends *writing*, not *delivery*; a fixed final text would need a cut
  across every sender, and acknowledgements the protocol does not have
  ([§3.3](#33-delivery-semantics)). Reports go on, since the one that ends the last
  phase carries its last message again (SND-27), and a device of the creator gives
  the close again to whoever writes on (LIF-11).
- **LIF-7** · *engine* — A close is permanent: nothing — no control frame and no
  control snapshot — reopens a closed document. Its reason (CTL-23) may change
  after it, and reopens nothing.
  *Rationale:* a reopen would be one more thing a forged or replayed message
  could do; a person who wants to continue creates a new document, which the
  reason `continued` tells the others.
- **LIF-11** · *engine* — A device of the creator that holds the document closed
  and reads an `edit` frame it did not send itself MUST send its close again: a
  `control` frame under its own tag (CTL-20) with `closed: true`, the register on
  `close-reason` it holds, if any, and its control clock and control digest as
  RSY-14 says. It is no decision: it raises no clock (CTL-45), and a device that
  has no tag yet takes one and persists it as for a decision (CTL-26). It MUST send
  it at most once per member that wrote in 10 minutes
  ([Appendix B](#appendix-b-recommended-values)), and at most once per read,
  however many wrote in it: the one it sends serves every member that wrote in that
  read, and counts as the one in 10 minutes of each it was due for; an edit read in
  its first read after it started (CTL-41) sends none.
  *Rationale:* a member that lost the close, its repeat and the report after them
  (SND-27) writes on, and no edit shows that a close came before it (TRN-10). A
  device of the creator that sees it write gives the close again, in a frame every
  receiver merges as a duplicate where it arrived before (CTL-6). Only a device of
  the creator can: a member's answer names a request (RSY-16), a member's report
  states no control clock (SND-11), and a `control` frame is the only kind that
  carries the close itself. Once per member in 10 minutes bounds what a writer whose
  messages keep getting lost costs; one frame reaches everyone, so one per read
  serves all who wrote in it. What a first read after a start brings may have been
  written long before, by members that hold the close since; a member that still
  writes without it writes again.

There is no deletion. Removing a document from participants' devices cannot be
done by a message, and "prevent future retrieval" presupposes a stored history
the transport contract does not have ([§3.3](#33-delivery-semantics)).

### 6.5 Declining an invitation

A joiner that cannot or will not take part says so in the channel, so that the
other participants' applications — the creator's above all — can at least see it.
The typical case is a profile the joiner's engine does not implement: the creator
can then invite again, with a new document of a profile the joiner implements.

- **DCL-1** · *application* — An application:
  - whose engine does not implement an invitation's profile SHOULD send a `decline`
    with the reason `unsupported-profile` and the profiles its engine implements;
  - that cannot read an invitation because it is of another version (INV-6) sends
    nothing in reply and SHOULD tell the person that the invitation comes from
    another version of TDSP.

  A person who does not want to join MAY decline with the reason `declined`.
  *Rationale:* without a message nobody learns why a participant never appears;
  with the list of implemented profiles the creator knows what to invite with. A
  `decline` reaches the creator only in a version both engines implement (VER-1),
  and an invitation one cannot read names no document and channel to answer in;
  so `unsupported-version`, defined and accepted, has no case to be sent in yet.
- **DCL-2** · *engine* — An engine MUST offer a decline operation that needs no
  join: given the documentId, the decliner's own MemberId and a transport whose
  bridge has the document bound, it sends exactly one `decline` frame — through
  the send scheduler, like every message (SND-2) — and keeps no document state.
  *Rationale:* the typical decliner cannot join, since it cannot read the
  document; a `decline` frame depends on no profile, so any engine can send one.
- **DCL-3** · *engine, application* — A receiving engine MUST NOT change any
  state because of a `decline`. It MUST report it to its application — sender,
  reason, profiles and text — and MUST report at most one `decline` per sender and
  document for as long as it runs; an application that keeps the declines it
  showed across a restart SHOULD show a sender's again only when its reason or
  text changed.
  *Rationale:* a decline is information, not authority, and anyone in the channel
  can send one; reporting each sender once keeps a forged or repeated decline
  from flooding what a person sees. The engine keeps no state of a decline (DCL-2),
  so what a person saw before a restart is the application's to remember.
- **DCL-4** · *application* — An application MUST present a decline's `text` as the
  sender's own words and MUST NOT act on a decline automatically beyond showing
  it.
  *Rationale:* the text is untrusted input from another participant, and what to
  do about a decline — invite again, ignore it — is a person's decision.

The interface between application and engine is, informatively: the application
calls `decline(documentId, memberId, transport, { reason, profiles?, text? })`;
the engine reports each received decline through a notification the application
registers when it creates or joins the document.

### 6.6 Who takes part

Who takes part in a document is the channel's: the messenger delivers every frame
to the members of the document's channel and to no one else ([§3.2](#32-operations)),
and whoever it removes from the channel receives nothing new, whatever any engine
does ([§15.2](#152-what-tdsp-assumes)). Who of them may write is the creator's
control state ([§7](#7-control-state)). Neither the engine nor the transport
contract creates a channel or changes its members (TRN-5); an application may,
through what its bridge offers on the channel itself
([bindings §12.5](bindings/bridges.md#125-what-a-bridge-does-not-do)) — under the
email binding, the creator's bridge starts the thread with the invitation
([§1.5](#15-terminology)) —, and then keeps the two in step.

- **LIF-9** · *application* — An application that adds a person to a document's
  channel or removes one, where its messenger lets it, MUST keep the control state
  in step: it MUST give a person it adds a permission before it sends that person
  the invitation, and MUST revoke a person's permission (`null`) before or as it
  removes the person from the channel, unless its engine refuses the revocation
  (LIF-6, CTL-27). An application that lets its person revoke
  a member SHOULD offer to remove that member from the channel with it. Where its
  transport names a person's MemberId only once the person accepts the
  messenger's own invitation to the channel, it MAY add the person before it can
  give a permission: that invitation of the messenger is then neither the TDSP
  invitation ([§11](#11-invitations)) nor its precondition. It MUST then decide the
  person's permission as soon as the MemberId is known; until then the person
  counts as unknown, which reads (CTL-13). An invitation sent into the channel
  reaches everyone in it, so the application MUST send it only once every person
  it is meant for holds a permission, except as follows.

  *Invitation first.* Into a channel it made for the document as its creator, in
  which everyone is a person the invitation is meant for, the application MAY send
  the invitation before the permissions, and before the initial state once the
  creator's control state is persisted (CTL-26), and MUST then give the
  permissions right after the initial state; until a person's permission arrives,
  the person reads (CTL-13).
  *Rationale:* the channel is the boundary the messenger enforces (§15.2), while
  within it rights are as strong as the participants' engines (§15.3). A permission
  given before the invitation lets the joiner write once bootstrapped (CTL-13); a
  revocation kept as a register tells a person added again by other means from one
  the creator admitted (LIF-10). Where the messenger names a person only once it
  accepted its invitation, the permission comes after, and the person reads until
  then — the safe side. A revocation before the removal lets the person's devices
  learn of it while they still read, and no more: a frame the messenger accepted
  (TRN-6) is not one a device received or showed (SIG-4), and what the person sees
  after the removal is the messenger's. Where the engine refuses the revocation —
  the document closed (LIF-6), or a device of the creator before its bootstrap
  (CTL-27) —, the removal stands alone. In a channel made for the document nobody
  can read the invitation who is not meant to, and sent first it is the first thing
  its members see; a joiner faster than the permissions reads until they arrive.
  Sent after the control state is persisted, an invitation whose initial state a
  stop held back leaves a document its creator resumes (LIF-5), never one it creates
  anew, and one whose initial state failed, a document its engine sends again
  (SND-20).
- **LIF-10** · *application* — An application whose transport offers
  `channelMembers` (TRN-17) SHOULD compare the channel's members with the control
  state its engine holds, once bootstrapped (RSY-14), and MUST then show the person as
  an inconsistency:
  - every channel member but the creator that no register on a member
    (`member:<id>`) names;
  - every member whose register gives `read` or `write` who is not in the channel;
  - every channel member whose register on a member is revoked (`null`), but one
    the application is removing from the channel at that moment, which it SHOULD
    show as a removal under way.

  It MUST NOT change the control state or the channel because of it without its
  person's decision; for a revoked member in the channel it SHOULD offer to remove
  that member again, or to admit it with a new permission. Where its binding cannot
  add a member to the channel, or cannot remove one, it MUST show that instead and
  SHOULD offer continuing in a new document (§6.2).
  *Rationale:* where applications keep both in step (LIF-9), each inconsistency
  arises only from a change made outside them, in the messenger, or from one that
  was lost or failed; only a person can tell which and decide. A revoked member in
  the channel matters most: its register keeps a cooperating engine from writing,
  but the person still receives every frame (§15.2), and a modified engine of theirs
  can still write (CTL-7); it arises where the removal failed after the revocation,
  which LIF-9 allows, or where someone took the person back in the messenger. A
  member being removed may still be listed for a moment. A person admitted again
  holds a permission before its invitation (LIF-9), so it shows as not in the
  channel until it joins, never as revoked. Before the bootstrap everyone would look
  unnamed, and the creator has no register on a member (CTL-4). Where the binding
  cannot remove a member, offering to would offer what cannot be done; a new
  document is then the way to a channel without that member
  ([§15.4](#154-what-is-not-guaranteed)).

## 7. Control state

*How it works (informative).* Only the creator decides who may edit, whether the
document is closed, and how often anyone sends, from as many devices as it likes,
each under a random tag of its own. The latest decision on each **target** — a
member, a member's right on a layer, the pace, or why the document was closed — is
a **register** carrying a **clock** (§7.2); beside the registers stands a one-way
**closed** flag. Every participant keeps one register per target and merges
registers as it merges updates: the greater clock holds, and order and repetition
change nothing (§7.3). What a receiver holds is bounded (§7.4). An answer carries
the answering device's registers as a **snapshot** (§7.5); a new device of the
creator takes her state only from another of her devices or its own (§7.6). A
decision is persisted before it is sent (§7.7), and an engine refuses to send an
edit the control state does not allow (§7.8).

### 7.1 What control state is

A document's control state is a **register** per target — the latest decision on
a member, on a member's right on a layer, on the pace, or on the reason for the
close — and a **closed** flag. From them follow:

- a **membership map** from MemberId to `read` or `write` — who may edit;
- **rights on layers**: for a layer and a MemberId, `read` or `write`, where the
  creator set one; elsewhere the member's permission on the document holds on the
  layer (LAY-5);
- whether the document is **closed**;
- the **pace**: the shortest interval, in milliseconds, between two messages one
  engine sends for the document ([§9.1](#91-pacing)); 0 while the creator set
  none;
- the **reason for the close**: why the creator closed the document, shown once it
  is closed (CTL-23).

The targets are `member:<id>`, `layer:<layer id>:member:<id>`, `pace` and
`close-reason`. A layer id holds no colon, so the first `:member:` after `layer:`
ends it. The creator is
never a target: its permission is `creator`, fixed (LIF-2). A member whose register
holds `null` is **revoked**; a MemberId that no register on a member names has an *unknown*
permission, which refuses its edits as `read` does (CTL-13). Revoked is not
unknown: a register holds `null`, which tells a member the creator removed from one
it has not named yet (LIF-10). Both are absent from the map.

Control state is merged as the content is: the result depends on which registers
a participant received, not on their order, and merging one again changes nothing.
A device of the creator that lost its state is simply a new device, under a tag of
its own.

- **CTL-1** · *engine* — Control state MUST change only as this section prescribes:
  by a decision a device of the creator makes itself (CTL-21), by merging registers
  of `control` frames and snapshots (CTL-22, CTL-25), and by restoring what was
  persisted (CTL-26, CTL-39).
  *Rationale:* a single path for authority is what makes it checkable.

### 7.2 Registers and the clock

- **CTL-20** · *engine* — A **register** holds the latest decision on one target:
  `value` — for a member `"read"`, `"write"` or `null` (revoked); for a right on a
  layer `"read"`, `"write"` or `null` (inherit, LAY-5); for `pace` a uint32 of
  milliseconds; for `close-reason` a string of 1 to 128 UTF-8 bytes (CTL-23) —;
  `clock`, the clock of the decision (CTL-45); and `device`, the tag
  of the device of the creator that made it: 16 random bytes in base64url without
  padding, generated once by that device and persisted with its control state
  (CTL-26). A `control` frame MUST carry the registers its device decided in it, at
  least one unless it carries the close, and MAY carry other registers its device
  holds.
  *Rationale:* one register per target is all a receiver needs to keep, whatever
  was decided before; the tag orders two decisions made at one clock (CTL-22). With
  16 random bytes, the chance that two devices choose one tag is negligible.
- **CTL-21** · *engine* — A device of the creator MUST give every decision on a
  target a clock greater than its own clock, than the clock of every register it
  holds on that target, and MUST hold a decision at once — as
  a change of its own that is not yet sent, like typed text (SND-6), not only once a
  send succeeded.
  *Rationale:* a decision made in knowledge of another must hold over it wherever
  both arrive, and a clock above every clock its device knew for that target says
  so. What a device decided is as much its state as what it typed.
- **CTL-45** · *engine* — A **clock** is a pair `[ms, counter]` of integers, `ms`
  from 0 to 2^48 − 1 and `counter` from 0 to 65 535; one clock is greater than
  another when its `ms` is, or both `ms` are equal and its `counter` is. A device of
  the creator MUST keep a clock of its own, `own`, persist it with its control state
  (CTL-26), and form it and the clock of each of its decisions (CTL-21) as this
  algorithm says, with the **span** of 24 hours; where a decision's clock cannot be
  formed, it MUST refuse the decision and tell its application:

  ```text
  MAX_MS = 2^48 − 1    MAX_COUNTER = 65 535    SPAN = 86 400 000 (24 h)
  now     : the device's wall clock, in ms since 1970-01-01 UTC
  next(c) = [c.ms, c.counter + 1]   if c.counter < MAX_COUNTER
          = [c.ms + 1, 0]           else, if c.ms < MAX_MS
          = none                    else
  wall    = [min(max(floor(now), 0), MAX_MS), 0]
  cap     = [min(wall.ms + SPAN, MAX_MS), MAX_COUNTER]      the end of the span
  raise(c): own ← max(own, min(c, cap))

  after restoring its control state (CTL-26) or merging registers (CTL-22,
  CTL-25):                                raise(its control clock)
  deciding on a target T (CTL-21):
    C ← {wall, next(own)} ∪ {next(r.clock) : r a register it holds on T}
    if none ∈ C: refuse the decision
    clock ← max(C)
    own   ← max(wall, next(own), min(clock, cap))
  ```

  Its control clock is the greatest clock among the registers it holds, `[0, 0]`
  where it holds none (RSY-16). `own` never falls: a wall clock that jumps back
  lowers `wall` and `cap`, not `own`, and each decision lies above the one before.
  A clock lies beyond the span when it is greater than `cap`, that is when its `ms`
  exceeds `wall.ms + SPAN`; `raise` never takes `own` there, and only a decision's
  `next(own)` may, one step per decision. A receiver MUST NOT refuse, drop or set
  aside a register it merges (CTL-22, CTL-25) because its clock lies ahead of the
  receiver's own time.
  *Rationale:* a clock above every clock its device has seen on a target orders each
  decision after everything that device knew of it, however far the wall clocks
  disagree; the wall clock makes the later of two concurrent decisions hold where
  the clocks are roughly right. The span keeps one register far ahead — from a
  clock that is off, or a broken application of the creator — from dragging every
  clock of the creator along: only a decision on that register's own target lies
  further ahead, and made in knowledge of it, it still holds over it. Every decision
  raises `own`, so no two decisions of a device on one target share a clock. Two
  integers stay exact in every JSON parser. A receiver that filtered registers by
  its own time would hold what another does not, for good. A clock at the end of
  its range orders no further decision; the person continues in a new document
  (§6.2). Restore and merge raise `own` alike: a register beyond the span when it
  came lifts `own` once the wall clock has caught up.
- **CTL-4** · *engine* — A participant other than the creator MUST NOT send a
  `control` frame; a register on a member or on a member's right on a layer MUST
  NOT name the creator and MUST NOT carry the permission `creator` (the wire has no
  value for it).
  *Rationale:* the creator's role is fixed (LIF-2) and cannot be granted,
  transferred or revoked.
- **CTL-5** · *engine* — A receiver MUST take a register into its control state if
  and only if it does not name the creator and it comes (a) in a `control` frame
  whose `Delivery.sender` is exactly the document's creator, or (b) in a snapshot
  it merges (CTL-25). The comparison of sender and creator is exact equality of
  MemberIds; device tags only order registers (CTL-22) and authenticate nothing.
  *Rationale:* (a) is the whole membership-integrity design: the messenger vouches
  for the sender. A snapshot is what its sender holds of the creator's registers,
  which cooperating participants pass on as they received them (§1.1, CTL-25).
- **CTL-6** · *engine* — A receiver MUST reject — and report — a control frame from
  anyone but the creator, a control frame with a register that names the creator,
  and every control frame while it does not know the creator. Merging a register it
  already holds changes nothing.
  *Rationale:* a frame from a non-creator is an anomaly worth seeing; a duplicate
  is the expected result of a re-offered message, which merging makes harmless.
- **CTL-7** · *engine* — An engine MUST NOT reject an `edit` frame, nor the update
  a report carries (SND-27), because its sender lacks `write` permission in the
  receiver's current control state.
  *Rationale:* a grant and the first edit made under it are unordered on the
  transport; rejecting on a grant not yet arrived would leave a permanent gap.
  Permissions are enforced by the sender's own engine (CTL-13), which cooperating
  participants run (§1.1, §15.2). A report carries again only an update that went
  out (SND-27), so it opens no way past CTL-13; judged by the receiver's rights,
  receivers that learnt of a revocation at different times would diverge.

### 7.3 Merging

Of two decisions on one target, the one made in knowledge of the other should
hold: every device of the creator gives a decision a clock above everything it
holds of that target (CTL-21), so the greater clock says it. Of two made without
knowledge of each other, the later by the deciding devices' clocks holds; only one
device deciding twice at one clock leaves a tie, which every receiver breaks alike.

- **CTL-22** · *engine* — Of two registers on one target, the one with the greater
  clock MUST hold; at equal clocks, the one whose `device` comes later in Unicode
  code point order; at equal clock and `device`, the one with the narrower value
  (CTL-23). A receiver MUST keep per target only the register that holds, and the
  result MUST depend only on the set of registers it received, not on their order
  or on duplicates.
  *Rationale:* a decision made in knowledge of another holds over it (CTL-21); of
  two concurrent ones the later by the deciding devices' clocks holds, not the
  narrower: within the channel rights are as strong as the participants' engines
  (§15.3), and who takes part is the channel's (§15.2). The order is total, so
  every receiver of the same registers holds the same. Equal clock and tag mean one
  device decided twice at one clock — a state put back from a backup —, and the
  narrower value gives every receiver the same result.
- **CTL-23** · *engine, application* — Where CTL-22 needs the narrower of two
  values, it MUST order them so: for a member, revoked (`null`) before `read`
  before `write`; for a right on a layer, `read` before inherit (`null`) before
  `write`; for `pace`, the longer interval before the shorter; for `close-reason`,
  the greater string in Unicode code point order before the smaller. The close is
  no register but a flag, which holds once a device of the creator set it, which a
  receiver takes only as CTL-5 says, and which nothing undoes (LIF-7). Why the
  creator closed the document is the register on `close-reason`:
  - A device of the creator MUST set as its value only a code of the table below,
    or an application's own reason (`application-reason` below, such as
    `com.example.moved/1`), of at most 128 UTF-8 bytes.
  - It MUST set it only in the `control` frame that carries its close, or once it
    holds the document closed; before, its engine MUST refuse it as `not-closed`
    and tell its application.
  - A receiver MUST take a register on `close-reason` whose value is a string of 1
    to 128 UTF-8 bytes as it takes every register (CTL-5, CTL-22), whatever the
    value names and whether it holds the document closed or not; any other value
    breaks the layout of its frame or snapshot.
  - An engine MUST NOT present a register on `close-reason` to its application as
    the reason for the close (`closeReason`), and an application MUST NOT show one,
    before the document is closed. An application SHOULD show a reason it does not
    know as a close without a known reason.

  An application's reason is named as FRM-15 names an extension, in this grammar,
  with `major` as in [§5](#5-document-profiles):

  ```abnf
  application-reason = label 1*("." label) "/" major  ; at most 128 bytes
  label              = 1*(%x61-7A / DIGIT / "-")      ; lowercase letters, digits, "-"
  ```

  *Rationale:* at a tie, the narrower value grants no more than either decision
  did; ordered so on a layer, it is the narrower effective right whatever the
  permission on the document (LAY-5). A reason grants nothing, so any order every
  receiver applies alike will do, and a one-way flag needs none. As a register, a
  reason merges alike everywhere and can still change after the close. One that
  arrives without the close is taken all the same, so that what a receiver holds
  depends only on the registers it received, and shown only once the close holds;
  it stays part of the persisted control state (CTL-26, CTL-39). A receiver takes
  any string: a later revision may define further codes (VER-5), and refusing one
  would refuse its frame, the close with it. The codes hold neither `.` nor `/`, so
  no application's reason reads as one; the grammar gives each one spelling, as §5
  does to a profile id.

The codes of `close-reason`:

| Code | Why the creator closed the document |
|---|---|
| `finished` | The work on it is done; its content stays as the edits sent before the close leave it (LIF-6). |
| `continued` | It goes on in a new document, created from its content ([§6.2](#62-creating-a-document)). |
| `creator-state-lost` | Her devices no longer hold the document's rights (CTL-46). |
| `capacity-conflict` | A device of the creator is in a capacity conflict (CTL-32), in which no one new can take part. |

### 7.4 Bounds

What a receiver holds is bounded (CTL-30), in bytes as CTL-34 measures; the close
and its reason lie outside every bound (CTL-36), and a device of the creator
decides nothing a receiver would refuse (CTL-37). A receiver pushed over a bound
anyway is in a capacity conflict (CTL-32).

Every transport carries frames of at least 4 MiB (TRN-23), so an answer carries a
control state at its bound with about 1 MiB to spare for the rest of the piece that
carries it (SND-18): the responder's state vector above all (RSY-18), which gains
an entry for every session that wrote (LOS-27). That room holds roughly 75 000 such
sessions. This is an estimate, not a promise; it takes an entry at about 10.5 bytes
— a client id of 8 bytes, as a 53-bit one takes, and a clock of 2 or 3 —, written in
Base64 at 4 characters for 3 bytes, and about 600 bytes for the frame's other
fields, the pace and the reason for the close among them. With the 32-bit client
ids Yjs draws, an entry takes about 7 bytes and the room about 110 000 sessions; a
control state far below its bound leaves room for several times as many. What
decides is the bytes of the whole frame as encoded, not this count. Beyond it no
answer of that responder carries its control state (SND-18), so it bootstraps
nobody new, and a device of the creator decides nothing but a close without a
reason (CTL-36, CTL-37); no state of the protocol marks it
([§15.4](#154-what-is-not-guaranteed)).

- **CTL-30** · *engine* — A receiver MUST bound the control state it holds to at
  most 5 000 targets on members and on rights on layers together, beside which the
  pace and the reason for the close always have room, and to at most 3 MiB
  (3 145 728 bytes), measured as CTL-34 says. A `control` frame or a snapshot that
  would bring it over either bound it MUST refuse as a whole — a capacity conflict
  (CTL-32) —, taking its close and its reason all the same (CTL-36). The requests of its own it keeps are bounded as RSY-12 says.
  *Rationale:* without bounds a broken application of the creator could exhaust
  every receiver's memory (§1.7, item 11). Beyond them the merge would depend on
  the order of arrival, so a receiver refuses rather than give up a target, which
  would take a right from someone unseen. 3 MiB fit the 4 MiB every transport
  carries (TRN-23), beside the rest of an answer (§7.4); 5 000 members are far more
  than the small group TDSP serves (§1.1).
- **CTL-34** · *engine* — The bytes of CTL-30 and CTL-37 MUST be measured
  over the targets on members and on rights on layers that a control state holds,
  each at a fixed width whatever its register: 14 bytes, those of
  `{"targets":{}}`, and for each such target the UTF-8 of its name as RFC 8785
  serialises a key, 1 for the colon and 86 for its register, and 1 for each comma
  between two. 86 bytes are those of the longest register other than one on the
  reason for the close, each register holding exactly `value`, `clock` and `device`
  (LOS-24): a pace of 2^32 − 1 ms at the greatest clock. Neither the pace nor the
  reason for the close is measured, as neither is counted (CTL-30), nor the close,
  `profile` and extension fields.
  *Rationale:* receivers at a bound must agree to the byte, whatever the order of
  arrival: at a fixed width the measure depends only on which targets are held, and
  a register on a target held — a revocation — never changes it. RFC 8785 fixes the
  escapes of a name.
- **CTL-36** · *engine* — The close lies outside every bound: a receiver MUST take
  it from every `control` frame and snapshot whose registers it may take (CTL-5),
  one it refuses for its bounds included (CTL-30), and a
  device of the creator MUST be able to issue it whatever its control state holds
  (CTL-37). The reason for the close (CTL-23) lies outside them too: a receiver MUST
  take its register wherever it takes the close, in a capacity conflict too
  (CTL-32), and a device of the creator MUST be able to set it with its close or
  after it whatever its control state holds — but where an answer could no longer
  carry it (CTL-37): there its engine MUST refuse the close with that reason, or
  the reason after the close, as a whole, as `too-large`, and tell its
  application, which may close without a reason.
  *Rationale:* nothing undoes a close (LIF-7), so no bound may leave a receiver
  without one it was sent, or keep a document from being closed, and its reason
  goes with it. Unlike the close, a reason adds to every answer, and a control
  state no answer can carry bootstraps no one (SND-18).
- **CTL-37** · *engine* — A device of the creator MUST NOT make a decision that a
  receiver would refuse under CTL-30; one that adds a target — a member or a right
  on a layer it holds no register for — and would bring its control state over
  1 MiB (1 048 576 bytes), measured as CTL-34 says; or one, other than the close,
  after which a `resync-response` carrying its snapshot beside an
  update that holds nothing would exceed its transport's `bounds.maxBytes`
  (SND-18). It MUST refuse the action and tell its application why; refusing it is
  no capacity conflict of its own.
  *Rationale:* a control state no answer can carry could no longer bootstrap anyone
  (SND-18), and the place to stop it is where it would grow. The 1 MiB, a third of
  what a receiver holds, bounds bytes only: with names shorter than about 120 bytes
  the 5 000 targets bind first, and two devices that each add 2 501 targets reach a
  capacity conflict (CTL-32).
- **CTL-32** · *engine, application* — A receiver that refuses a `control` frame or
  a snapshot for the bounds of CTL-30 is in a **capacity
  conflict**, for good. Its engine MUST report it, and from then on MUST take no
  register on a member or on a right on a layer it holds none for — the close and
  its reason, the pace and registers on targets it holds it takes as before —; MUST refuse every
  edit of its own as CTL-13 refuses a reader's, on a device of the creator too; MUST
  NOT decide on a member or a right on a layer it holds no register for; and MUST
  answer every request with `control: null`, a device of the creator's included
  (RSY-8). An answer whose snapshot it refused still bootstraps it (RSY-14), into
  the conflict; its close and its reason it holds all the same (CTL-36). An
  application that persists the control state (CTL-26, CTL-39) MUST persist the
  conflict with it, MUST show it for as long as it lasts, and SHOULD offer to
  continue in a new document created from the content (§6.2).
  *Rationale:* every receiver of the same targets reaches the conflict in whatever
  order they arrive (CTL-34). A receiver that could not hold a decision of the
  creator may lack one about itself, so it stops writing; taking no new target
  keeps it from growing, and taking registers on what it holds keeps revocations
  working. It hands on no control state, which it knows lacks something. A
  conflict a restart forgot would let it write again.

### 7.5 The control snapshot

An answer carries its responder's control state as the frame's `control` object,
from every responder that is bootstrapped and in no capacity conflict (RSY-8,
CTL-32):

```json
{
  "profile": "yjs-paragraphs/1",
  "closed": false,
  "targets": {
    "member:bob":   { "value": "write", "clock": [1793008800000, 0], "device": "Ms3dRk0ZyS7cH1qkM8fWNA" },
    "pace":         { "value": 30000,   "clock": [1793008800000, 1], "device": "Ms3dRk0ZyS7cH1qkM8fWNA" },
    "member:carol": { "value": "read",  "clock": [1793008860000, 0], "device": "Ms3dRk0ZyS7cH1qkM8fWNA" }
  }
}
```

The layout is closed for its defined fields (FRM-9):

| Field | Required | Value |
|---|---|---|
| `profile` | yes | A profile id ([§5](#5-document-profiles)) |
| `closed` | yes | The sender's close flag |
| `targets` | yes | An object of at most 5 002 entries — 5 000 members and rights on layers, the pace and the reason for the close —, each a target (`member:<MemberId>`, the MemberId 1–255 UTF-8 bytes; `layer:<layer id>:member:<MemberId>`; `pace`; `close-reason`) mapped to a register of exactly `value` (one the target can take), `clock` (CTL-45) and `device` (a device tag); never a member that is the creator, also not on a layer |

A snapshot that breaks this layout — a defined field missing (`missing-field`) or
of the wrong type, a field without `.` that is not listed, a member named twice in
the JSON, the creator among the targets — rejects the whole `resync-response`
(FRM-6). The layout counts entries, not what they name: 5 002 targets on members,
none on the pace or the reason, break no layout, only the bound of CTL-30.

- **CTL-25** · *engine* — A receiver MUST merge the snapshot of every
  `resync-response` it accepts (RSY-12), whoever sent it, and, on a device of the
  creator, one its application carried to it from another device of the creator
  (ARC-5): register by register (CTL-22), and its close as CTL-23 says, whatever
  its clocks, leaving out only what CTL-30 refuses. It MUST refuse a carried
  snapshot for which a `resync-response` carrying it would be rejected (CTL-10,
  CTL-15). A snapshot need not be newer than what the receiver holds.
  *Rationale:* a snapshot is how a joiner on a history-less transport learns the
  current state, passed on as it reached its responder (§1.1); the creator's
  identity stays the only one whose `control` frames count (CTL-5). A merge never
  takes back a register with a greater clock, so an older snapshot is harmless, and
  a joiner it bootstraps holds the rights a member that received the same frames
  holds. A carried snapshot is as much the creator's as its service keeps it
  (ARC-5).
- **CTL-10** · *engine* — A receiver MUST reject a `resync-response` whose snapshot
  it would merge (CTL-25) when the snapshot names a profile other than the
  document's — applying none of it, update included — and MUST report it to its
  application.
  *Rationale:* the profile a joiner learned from the invitation is only a claim of
  whoever wrote the invitation; the snapshot of the answer that bootstraps it
  (RSY-14) is where it learns the document's own, and content of a different
  profile must never be applied.
- **CTL-15** · *engine* — A receiver MUST reject a `resync-response` whose snapshot
  breaks the layout above as a whole, applying neither its update nor any of its
  control state (FRM-6).
  *Rationale:* a snapshot half-applied leaves the receiver in a state the creator
  never had; a cooperating participant never sends an invalid snapshot (§1.1), so
  rejecting it loses nothing that a later, valid answer does not bring.

### 7.6 A new device of the creator

The creator's devices hold the document's authoritative control state: only they
decide (CTL-1), and a device of the creator that holds nothing yet takes that state
only from another of her devices or its own restored or carried state (RSY-14,
CTL-26, ARC-5). Members' answers bring it the content and the registers they hold
(CTL-25), but not the creator's whole: a decision of a lost device that reached
only some members may be missing from all of them. Until it is bootstrapped it
decides nothing but the close and its reason (CTL-27); where no device and no
backup of hers holds the state, the document is closed and continued as a new one
(CTL-46, CTL-43).

- **CTL-27** · *engine* — A device of the creator that is not bootstrapped (RSY-14)
  MUST NOT make a decision other than the close and its reason (CTL-23): it MUST
  refuse every other decision its person makes, as `not-bootstrapped`, and MUST
  take the registers of an answer to its own request as any device does (CTL-25).
  It MAY edit the content (CTL-13).
  *Rationale:* a decision made before the bootstrap would hold, by its later clock,
  over decisions of the creator the device does not hold yet (CTL-22), on a state
  that may lack some of them for good. The close needs no state: it holds whatever
  else was decided (CTL-23), and it is how a document whose creator kept no state
  ends (CTL-46). Content is the CRDT's, and an edit of the creator's competes with
  nothing she may not write.
- **CTL-46** · *application* — The creator keeps the document's control state: an
  application of the creator MUST persist it (CTL-26) and SHOULD let its person
  keep it on more than one device or in a backup that restores it (ARC-5). Where no
  device of the creator and no backup holds it any more, the document MUST NOT be
  continued with rights taken from members (RSY-14): the application closes it,
  SHOULD with the reason `creator-state-lost` (CTL-23), and continues in a new
  document (CTL-43).
  *Rationale:* every right is a decision of the creator, and only her devices hold
  them all; members hold what reached them. A state rebuilt from members could lack
  a decision for good, with no one able to complete it, while a new document starts
  from rights the creator decides again, on the content as the members hold it.
  The reason tells the others why the document ends and that it goes on elsewhere
  for that reason.
- **CTL-43** · *application* — On a device of the creator, an application MUST
  show the person, while the device is not bootstrapped (RSY-14), that the
  document's rights are not known yet and that only the close and its reason can
  be decided (CTL-27). Once its attempts ran out (RSY-5) while it is still not
  bootstrapped — no other device of the creator answered —, the application MUST
  show that, MUST ask the person whether another device of hers, or a backup,
  still holds the document, and SHOULD offer to close the document and continue it
  as a new one (CTL-46). When its person says that another device of hers, or a
  backup, still holds the document, it SHOULD ask again (RSY-5). Until it is
  bootstrapped, it MAY keep its person from editing, or hold the person's edits as
  CTL-42 holds those its engine refuses, applying them once it is bootstrapped and
  keeping them apart (CTL-42, item 3) if the document is closed. What else it
  shows of the control state stands where it arises: a capacity conflict
  (CTL-32), a member the channel and the rights disagree on (LIF-10), attempts
  that ran out (RSY-5).
  *Rationale:* whether the creator's other devices are lost or only switched off,
  only the person knows; asked first, she opens the other device where there is
  one, and closes only where none is left. A device she opens again answers only a
  request it reads, and attempts that ran out make no more until one of her devices
  writes (RSY-5): asking again then reaches it. Its engine refuses none of her edits
  (CTL-27), so holding them is the application's choice, made as CTL-42 says.

### 7.7 Persisting control state

- **CTL-26** · *engine, application* — A device of the creator MUST persist a
  decision *before* it hands it to the transport, as part of its control state,
  together with its tag and its clock (CTL-45), whether it is bootstrapped
  (RSY-14), the version it is written under (VER-3), and the complete `control` frames not yet
  known to be sent; it MUST
  keep each such frame as a pending change until the transport accepts it or
  refuses it for good (SND-6, SND-8). A restarted device MUST restore that state
  and send its pending frames again; what it restores is bootstrapped only if it
  was when persisted. The device that creates the document MUST persist its
  control state — its tag, its clock, bootstrapped — before the initial state goes
  out (LIF-3). Persisting is not best-effort: when the application cannot persist,
  it MUST report the failure to the engine, and the engine MUST NOT make the
  decision.
  *Rationale:* a decision never persisted is lost for the person who made it, while
  it may have reached others; a clock not persisted could give the next decision a
  clock below one already sent, which would then not hold. A pending frame sent
  again after a restart merges as a duplicate where it arrived. A state persisted
  by a device that was not bootstrapped is still one that is not: restored as
  bootstrapped, it would answer others with less than the creator decided (RSY-8).
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
  state its engine holds, with whether its bootstrap had completed (RSY-14) and
  whether it was in a capacity conflict (CTL-32), and restore it on that device,
  never on another (ARC-5). Its engine then shows the rights it holds at once, but
  takes the restored state as no authority — it decides nothing (CTL-1) — and as a
  bootstrap only as CTL-41 says.
  *Rationale:* a non-creator holds no authority of its own to restore: what it
  restores is the creator's registers as it last held them, and a merge cannot
  undo anything (CTL-25), so a later answer only adds to it.
- **CTL-40** · *engine, application* — An engine MUST report every change of its
  control state to its application before it makes observable a cursor (§6.3, LIF-8)
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
  - when its own permission is `read` on a part the edit changes — on the document
    for a change of the content, on a layer for a change of that layer (LAY-5,
    LAY-6, LAY-7) —, a permission on the document that no register gives counting
    as `read`;
  - when its own permission on the document is revoked (§7.1);
  - while it is in a capacity conflict (CTL-32);
  - for anyone but the creator, before it is bootstrapped (RSY-14).

  *Rationale:* before its bootstrap a joiner has neither the content nor the control
  state: an edit would compete with content it cannot see, and may come from
  someone the creator made read-only. Waiting costs little: any member asked by all
  can bootstrap it ([§8.3](#83-who-answers)), and with no one online it has nothing
  to edit. The creator names everyone it admits (LIF-9), so a member not named yet
  waits as a reader — the safe side of not knowing. A revoked member's register
  keeps it so, and concurrent `read` and revoke end where CTL-22 says, never in
  writing for want of a value. A member who must not even read has to leave the
  channel (§15.2, §15.3).
- **CTL-41** · *engine* — After a restart, an engine that is not the creator is
  bootstrapped (CTL-13) also by control state of its own restored from an earlier
  bootstrap (CTL-39), once all of these hold:
  - it has read on from the cursor persisted with its content
    ([§6.3](#63-joining-a-document), LIF-8) through a transport that offers
    `receiveSince`;
  - the `receiveSince` answer that read on was not `truncated`;
  - the transport's instance, where it offers one, was the one persisted with the
    cursor (LOS-9).

  *Rationale:* a member that resumes content its application persisted
  ([§6.3](#63-joining-a-document)) does have something to edit, while the creator
  may be offline for hours. A non-creator that restored its control state and read
  on without a gap stands where one that never restarted stands: a revocation it
  has not received takes effect when it arrives, for both, and one that arrived
  meanwhile takes effect before any edit, since the read comes first. Where that
  read cannot rule out a gap — no cursor, a truncated answer, another instance —
  or nothing was restored, an answer bootstraps it again before it edits:
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
     closed, the person's own permission is `read` or revoked — not merely
     unknown, for which a decision may still come —, or it is in a capacity
     conflict (CTL-32);
  4. SHOULD tell the person when a held change did not survive the merge;
  5. SHOULD persist held changes locally across a restart.

  *Rationale:* holding lets a person go on while the creator is offline. A change
  in the engine's document could leave the device — in its edits and in its answers,
  which carry the responder's state whatever its own permission (RSY-8, RSY-10), a
  member answering any request to all (RSY-6, RSY-21) —, and every later change
  would build on it. A held change reaches others only after the bootstrap, merged
  by the CRDT like any concurrent edit, and a reader's change, or one made after a
  close, never leaves the device. The cost is that of offline editing: a change held
  long may land in content others deleted meanwhile.

1.x's CTL-2, CTL-3, CTL-8, CTL-9, CTL-11, CTL-12, CTL-14, CTL-16, CTL-17, CTL-18
and CTL-19 are withdrawn ([Appendix G](#appendix-g-changes-from-tdsp-1x)).

CTL-24, CTL-28, CTL-29, CTL-31, CTL-33 and CTL-35, requirements of an earlier
draft of 2.0, are withdrawn ([CHANGELOG.md](CHANGELOG.md)); 1.x had none of
them.

## 8. Bootstrap and resync

The CRDT tolerates delay, duplication and reordering completely. It does not
tolerate loss: a missing update leaves every later update from the same sender
pending, silently and permanently. And no transport is required to replay
history, so a joiner cannot catch up by reading old messages. Both problems have
one answer: an engine **asks**. A joiner asks first the creator and the other
devices of its own member, which **answer** at once with exactly what it lacks;
when none does, it asks everyone, and one member answers. Every other request —
for a gap, at a start, after a return, or its person's — asks everyone at once.

### 8.1 The sequence

```text
  Bob (joining)          Bob's bridge      messenger     Alice's bridge    Alice (creator)
  1. bind to the channel ─►│
  2. resync-request: control clock null, empty state vector, all false
     ─────────────────────►├──────────────►├─────────────►├───────────────►│
  3.                                                       Alice answers at once
  4. resync-response: full snapshot + control snapshot + attribution overlay
     ◄─────────────────────┤◄──────────────┤◄─────────────┤◄───────────────┤
  5. content, permissions, pace and authorship present — bootstrap complete
```

With the creator offline and no other device of Bob's own member at hand, step 3
does not happen:

```text
  Bob (joining)                    messenger                 Carol, Dave (members)
  2. resync-request, all false ───►│─────────────────────────►│  not theirs to answer
  3. it expires unanswered
  4. resync-request, all true ────►│─────────────────────────►│  each waits for its turn
  5.                                                          Dave's turn comes first
     resync-response from Dave ◄───│◄─────────────────────────┤  Carol hears it; holding no more
                                                                 than it, she stays silent
  6. content, permissions and pace present, as Dave holds them — bootstrap complete
```

The same exchange heals an established engine that noticed a gap
([§10](#10-loss-detection)); its request then carries a non-empty state vector,
asks all, and the answer is a targeted diff.

### 8.2 Requesting

- **RSY-1** · *engine* — A joining engine MUST send a `resync-request` when it
  joins, whatever the transport, and MUST NOT make that conditional on whether the
  transport replays history. An engine that starts again from what its application
  persisted ([§6.3](#63-joining-a-document)) MUST, once its first read is done
  (CTL-41), send one as a joiner does while it is not bootstrapped; bootstrapped,
  it MUST send a **start request** — to all (RSY-21), stating its own state
  (RSY-16) — when its last read that reached the messenger began longer before
  than an absence it chooses, as [Appendix B](#appendix-b-recommended-values)
  recommends (LIF-8), or when that time is not known, or when it holds a gap
  (LOS-25); it MUST NOT send one otherwise, nor repeat one that went unanswered —
  a return asks again as RSY-21 says. A running engine that is bootstrapped and is
  told of an absence longer than that (LIF-12) MUST send a start request as one
  that starts does.
  *Rationale:* a capability flag would create two code paths of which tests
  exercise only one; on a transport with history the request is a cheap
  redundancy, on one without it the only bootstrap that works. A bootstrapped
  engine away only briefly reads what came meanwhile (TRN-18), and what it still
  lacks shows as a gap (LOS-25), so a request at every start would cost a round of
  answers for nothing. After a longer absence, or not knowing how long, it may lack
  what nothing shows yet — a last change whose report was lost too (SND-27) —, and
  asks once, after its first read, so as not to be answered with what that read
  brought. Repeated, it would ask the same participants again; a later gap has
  tries of its own (LOS-6).
- **RSY-16** · *engine* — A `resync-request` MUST carry:
  - a fresh random 64-bit `requestId`;
  - the requester's control clock — the greatest clock among the registers it
    holds — and its control digest (LOS-24), or `null` for both until it is
    bootstrapped (RSY-14), whatever it restored;
  - its current state vector and state digest (LOS-12);
  - its stream and number (LOS-13);
  - `force`: `true` while it holds *history truncated* evidence (LOS-8, LOS-9,
    LOS-23), `false` otherwise;
  - `all`: whether any member may answer it (RSY-6), as RSY-21 says.

  A responder MUST treat copies of a request with the same `requestId` as one
  request.
  *Rationale:* the state vector lets the responder send only what is missing; the
  control clock and digest show a lacking register where no content is missing.
  `null` differs from `[0, 0]`, which a joiner holds once answered in a document
  without decisions. A device not bootstrapped may hold registers without the whole:
  with its clock it might get no answer (RSY-17); `null` asks for the whole. The id
  is the requester's own, since a requester does not always learn the delivery id
  its message gets, and a duplicate must not be answered twice. `force`: after a truncated history the
  requester cannot tell what it lacks, and a responder that sees nothing missing
  would stay silent.
- **RSY-21** · *engine* — A requester MUST set `all` to `false` in the first
  request of its bootstrap (RSY-5) unless it returns (below), and to `true` in
  every other request: the repeats of its bootstrap, every request for a gap
  (LOS-6, LOS-26), a start request (RSY-1), a request of its person (RSY-3) and
  every request while it returns. An engine **returns** when it starts
  from content its application persisted ([§6.3](#63-joining-a-document)) after it
  was away longer than its transport keeps a message for a device that is away —
  counted as LIF-8 says, never from when that content was taken —, or after its
  application had unbound the document from its channel and binds it again; a
  device of the creator returns too when it starts from control state that was
  bootstrapped (CTL-26, ARC-5) without content. An engine that keeps running
  returns too when its application tells it of such an absence once a read reaches
  the messenger again (LIF-8, LIF-12). A return wakes every resting gap (LOS-25, LOS-26); a
  return ends once a request of it
  that asks all was answered, or two such requests expired (RSY-4) — not one whose
  send failed, which asked nobody.
  *Rationale:* a joiner's first question is for the whole document, which the
  creator's devices and its own member's give at once (RSY-6); everyone is asked
  only when none of them answered or what answered did not help. A gap heals
  through whoever holds what is missing, where loss is rare mostly a member, so a
  request that asked only the creator would mostly spend a try (LOS-6). A request
  to all costs a wait and may cost several answers, so it is made only for a gap, a
  start, a return or the person's word. What members wrote while a device was away
  longer than its transport keeps, or while the document was unbound, is lost to it
  where nothing shows it (LOS-9), and those who answer at once may lack it too: only
  a member asked by all brings it (RSY-20). A device of the creator that starts
  from its control state alone lacks everything, and returns too. An answer to a
  return may be lost while the members that heard it stay silent, so a second
  request follows one that expired; a bootstrap that returns asks all at once, or
  an answer of the creator's or its own device would end the return before any
  member was asked. What a return cannot recover is named in
  [§10.6](#106-what-loss-detection-cannot-notice).
- **RSY-3** · *engine* — An engine MUST have at most one resync request of its own
  outstanding per document. A further request made while one is outstanding MUST
  be coalesced into it and send nothing, and a request MUST NOT be sent sooner
  than the engine's floor (SND-16) after its previous message.
  A request the floor holds back waits in the send scheduler, holding the slot,
  and goes out once the floor permits (SND-2); one a person asks for while the
  floor holds MAY be refused instead, and the engine MUST then tell the asker.
  *Rationale:* a request is a broadcast; a second one multiplies the answers on a
  budget where every message counts, and every trigger — a person's click, loss
  detection, a joiner's retry — would otherwise ask at once. An automatic request
  refused at the floor would be spent for nothing, and an engine that keeps
  writing would never get to ask (LOS-6); a person who clicks learns at once that
  it was too soon.
- **RSY-4** · *engine* — An outstanding request MUST expire after a bounded time,
  counted from when it was sent, and is then reported as *unanswered*. An answer
  ends it before, but for a request to all made in the bootstrap (RSY-5): an answer
  that does not bootstrap the requester (RSY-14) leaves that request outstanding. A request
  whose send failed MUST release the slot immediately without counting against the
  slot's floor, and its outcome is *failed* (SND-10); the send floor (SND-2) counts
  the attempt. That bounded time is the time a
  request may wait for an answer: where another requirement counts from it
  (RSY-5, RSY-21), it passes at the same moment whether the request was answered or not,
  and only a request that went out has it. The expiry SHOULD be derived from
  the engine's floor and expected latency, and for a request with `all` also from
  the time a member may wait before it answers (RSY-20;
  [Appendix B](#appendix-b-recommended-values)).
  *Rationale:* an unanswered request is an ordinary outcome — a responder answers
  only if it has something to give (RSY-17) — and must not block the next one
  forever. Counted from when it was asked for, its time would be shortened by a
  wait for the floor (RSY-3). Members answer a request to all at their turns
  (RSY-20), so an answer that ends nothing — content alone — must not cut that wait
  short.
- **RSY-5** · *engine, application* — While a joining engine has not completed its
  bootstrap, it SHOULD repeat its request once the time its latest request may wait
  (RSY-4) has passed while it is not bootstrapped, whether or not that request was
  answered, with growing waits and a bounded number of attempts, the repeats asking
  all (RSY-21); it MUST NOT repeat it without bound. Once its attempts ran out, it
  SHOULD make one further request, to all, when, after its latest request that
  went out had its time (RSY-4), it reads a frame of a participant that did not
  answer that request — on a device of the creator, only of another device of the
  creator —, or, whoever answered, a `control` frame, a report or a request of a
  device of the creator other than itself that states a control clock; at most one
  per expiry, each after a wait at least double the one before, counted on from
  its attempts, up to a longest wait as [Appendix
  B](#appendix-b-recommended-values) recommends; it MUST NOT make a further request
  after a shorter wait than that doubling gives. A further request whose send
  failed for a reason worth retrying (§3.4) counts for nothing, as such an attempt
  does, and is made again once the send back-off allows (SND-7); one refused for
  good counts. While its attempts ran out and it
  has not completed its bootstrap, its application MUST show that, and SHOULD offer
  its person to ask again; its attempts have run out from when the last of them
  released the slot (RSY-4), and not while a request of its own is outstanding, a
  further one or its person's. The automatic requests of a device of the creator on
  loss evidence (LOS-6) MUST NOT depend on its bootstrap: neither on whether it
  completed nor on whether its own attempts ran out. An engine that returns
  (RSY-21) SHOULD ask all again until its return ends, once the request before had
  the time an answer may take (RSY-4) — one still in its bootstrap by the requests
  of its bootstrap. The application MAY switch the repeats and
  the further request of this requirement off, with the automatic requests of LOS-6
  and LOS-26; the requests RSY-1 requires and a return's requests (RSY-21, above) go
  all the same, but for a device still in its bootstrap, which asks again only as
  its bootstrap does, also when it returns: with the repeats off, its first request
  is its one.
  *Rationale:* the first request, or its answer, may be lost, or the creator
  offline; an unbounded retry would spend the rate budget of a participant nobody
  can answer. An answer without control state bootstraps nobody (RSY-14), so the
  engine asks on after one as after silence. A frame read after the attempts ran
  out, from someone who did not answer the latest request, shows that someone who
  may hold the document is there again, so a joiner may wait however long the
  others are away (§6.3). Who answered has given what it holds; but content alone
  from one device must not keep a joiner from its bootstrap while members write,
  nor members' answers keep a device of the creator from her other device, the only
  one that can bootstrap it (RSY-14). Her devices share one MemberId, so who
  answered does not tell which of them did; a frame that states a control clock
  comes from one that is bootstrapped, and so could. With the waits doubling, a
  participant that writes on and never answers costs a few requests an hour. Answers
  that end nothing spend the attempts for good, which only the person can tell. A
  device of the creator edits and answers at once, so its evidence matters at once,
  while its own bootstrap requests may rightly go unanswered (RSY-17). A device in
  its bootstrap asks for the whole anyway, so its return adds nothing to it.
- **RSY-22** · *engine* — An engine about to make an automatic request for gaps
  (LOS-6, LOS-26) — as it is for a gap once the gap's wait passed, or for a further
  try once the wait since the try before passed (after a request let go, once that
  one had its time), also while the gap waits for its place (LOS-6) — MUST NOT make
  it when it heard, within the time that request would wait for an answer (RSY-4),
  another's request to all that reaches no further than its own would on each of
  those gaps' streams (LOS-25): one whose state vector this engine's holds there —
  for a gap of deletions, whose state digest is also this engine's, or whose state
  vector this engine's holds with more —, and whose control clock is `null`, lower
  than its own, or its own with its control digest. The request it let go counts as made
  for those gaps (LOS-6); it accepts the answers to the one it heard (RSY-12), and
  makes no request for a gap until that one had the time it may wait. Requests of
  its bootstrap, and one for a truncated history, which asks with `force`
  (LOS-19), are not let go so; nor is any for a request it read in its first read
  after it started (CTL-41), or in the read before its application told it of a
  return or of an absence longer than RSY-1's (LIF-12), which it may still answer
  (RSY-20).
  *Rationale:* where several devices lack the same change, each would ask, and
  every member that holds it would answer each (RSY-20). A request that asks for no
  more than this engine would is answered with all it lacks on those streams, and
  the answer reaches everyone: five devices with the same gap cost one request and
  one answer. One that reaches further is no
  stand-in; the bootstrap asks for a whole the other may not need, and a truncated
  history for what no state vector can say. A request read as an engine catches up
  may have been sent long before, its answers gone, and no clock tells (RSY-17).

### 8.3 Who answers

- **RSY-6** · *engine* — Who answers whom:
  - Every device of the creator MUST answer requests from other devices, as RSY-17
    says.
  - Every engine MUST answer requests from another device of its own member as the
    creator's devices answer.
  - Any other engine MUST NOT answer a request unless it carries `all: true`, and
    answers one that does as RSY-17 says, at its turn (RSY-20).
  - An engine that does not know the creator MUST NOT answer any request.
  - An engine MUST NOT answer its own request, which it recognises by its
    `requestId`, not by its requester.

  *Rationale:* any participant may bring a new device up to date: content is the
  CRDT's, and what a member's answer carries of control state is what reached it of
  the creator's decisions, passed on as received (§1.1). But every answer is a
  message against everyone's budget, and some messengers show each in the group's
  chat: so the creator's devices and the requester's own answer at once, one of
  them usually at hand, and everyone else only when asked by all, at its turn
  (RSY-20). A creator restarted without content (CTL-26), or lacking what arrived
  while it was away, gets it back from a member asked by all.
- **RSY-20** · *engine* — An engine that may answer a request only because it
  carries `all` (RSY-6) MUST NOT answer it before its **turn**: the time it heard
  the request plus a delay it derives from the request's `requestId` and its own
  stream (LOS-13), spread evenly over a window
  ([Appendix B](#appendix-b-recommended-values)). It MUST keep the request until
  then (RSY-9), and a copy of it keeps the turn it has. It MUST let the request go
  unanswered at its turn when last pieces (RSY-18) of `resync-response`s it heard
  before it, from anyone, whose `respondsTo` names that request — whether or not it
  would accept them (RSY-12) — **hold** what it would give:
  - where RSY-17 lets it answer for content — its first or third case —, one that
    holds the engine's content as it heard it, together with the furthest the
    requesting stream had stated then (RSY-17): its state vector or the stream's
    counts every update the engine held, its state digest is the engine's within its
    state vector (LOS-24), and where the engine held more than it, a state digest the
    stream stated is the engine's within the stream's vector. Where the answer counts
    updates the engine lacked, the engine compares the digests once it holds them;
    one it could not compare before it was heard longer ago than a request to all
    may wait (RSY-4) holds nothing;
  - where RSY-17 lets it answer for control state — its second or fourth case —,
    one whose snapshot holds, on every target the engine held a register for as it
    heard it, that register or one that holds over it (CTL-22), and the close where
    the engine held it.

  It MAY judge only the first answers it heard of a request ([Appendix
  B](#appendix-b-recommended-values)).

  Otherwise it MUST answer at its turn: a piece that is not the last, an answer
  that holds less, a report or a request, whatever it carries, silence it for
  nothing. An answer it accepts because it let a request of its own go for that
  request (RSY-22) it compares once it applied it. Where RSY-17
  gives it nothing to offer at its turn — judged by the furthest the requesting
  stream stated by then —, it MUST let the request go then. Once it
  has sent a piece of its answer, it sends the rest (SND-17).
  *Rationale:* a delay derived from the request and the responder's stream spreads
  the members' answers without any of them knowing who else is there; two devices
  of one member run different streams. A member that holds more than the first
  answer may be the only one left that can give it (§10.6); members that hold the
  same — the usual case — stay silent, so a request to all usually costs one
  answer, two when turns lie closer than a message takes (RSY-13). Kept past its
  turn with nothing to offer, a request would count every later change of the
  member — the requester's own among them — as content it lacks, and every member
  whose turn had passed would answer with its whole snapshot. Content is judged as
  the answer is heard, with what the requester stated, since the requester holds
  both once the answer arrived: a member that holds beyond it only the requester's
  own change stays silent, and an update that reaches it later reaches the requester
  the same way (§10.6). A digest compares deletions within one vector only (LOS-24),
  so deletions wait only where the answer counts updates the member lacked, and a
  member whose turn comes before it holds them may still answer. Control state is
  compared register by register. An answer may come after the requester's expiry
  (RSY-4); it asks once more — a message more, nothing lost.
- **RSY-17** · *engine* — A responder that RSY-6 lets answer a request MUST answer
  it only if one of these holds, and then MUST answer it, even with nothing to
  add:
  - it holds content the requester's state vector lacks;
  - it would carry control state (RSY-8), and the request's control clock is below
    the greatest clock among the registers it holds, or equal to it with another
    control digest (LOS-24);
  - the request's state vector holds every update the responder holds itself, and
    the request's state digest differs from its own;
  - it would carry control state, and the request's control clock is `null` or the
    request has `force: true`.

  The state vector, state digest, control clock and control digest these cases
  name are the furthest the requesting stream stated (LOS-13), in the request or in
  any request, report or last piece of an answer of that stream the responder
  heard: the state vector of the frame numbered highest, a state digest that
  differs only where none the stream stated with exactly that vector is the
  responder's, the greatest control clock it stated, and a control digest that
  differs only where none it stated with that clock is the responder's.

  Otherwise a responder MUST stay silent, and MUST keep the request to reconsider
  later (RSY-9), since that may change: one it may answer only because it carries
  `all` until its turn (RSY-20); any other, while the responder is not bootstrapped
  (RSY-14), as long as its requester may wait for an answer (RSY-4) — a bootstrapped
  responder MUST let it go. It MUST NOT reconsider a request first heard longer ago
  than that time, as it reckons RSY-4's expiry for itself.
  *Rationale:* an engine that is up to date gets no answer, which keeps resync
  traffic proportional to what is missing. A lost decision shows by the control
  clock, or at an equal clock by the digest; a lost deletion only by the digest,
  which does not tell which of the two lacks it — the other's evidence makes it ask
  in turn (LOS-12) —: the state since the requester's state vector carries the
  responder's whole record of deletions, so the answer heals it or brings nothing,
  one message, and ends the evidence (LOS-18). A member's request is evidence of
  control state for no one ([§10.6](#106-what-loss-detection-cannot-notice)). A
  device that saw every edit is still not up to date until it is bootstrapped
  (RSY-14), so anyone RSY-6 lets answer answers one that states no control clock
  with its snapshot (RSY-8). A request may be read long after it was sent, its
  requester having got what it asked for since; frames carry no time of sending,
  and clocks may be off (§1.1), so no clock decides. Within a stream the state only
  grows (LOS-13), so the frame numbered highest states the furthest however the
  frames arrived; deletions only grow, so a digest the stream stated that is the
  responder's shows it holds the responder's deletions; control state likewise, by
  its clock. A bootstrapped responder with nothing to give lacks what the requester
  lacks, and whoever brings it answers that request or the responder's own, which
  every device hears; kept, the request would cost a second answer to one gap. What
  a responder not bootstrapped holds may still grow.
- **RSY-8** · *engine* — An answer MUST be a `resync-response` whose `respondsTo`
  is the request's `requestId` and whose update is the responder's state since
  the requester's state vector. In `control` it MUST carry its snapshot (§7.5)
  once it is bootstrapped (RSY-14) and while it is in no capacity conflict
  (CTL-32), and `null` otherwise. The answer SHOULD carry the responder's
  attribution overlay.
  *Rationale:* `respondsTo` lets the requester tell its own answer from answers to
  others (RSY-13, ATR-1). A bootstrapped device passes on what reached it of the
  creator's decisions, and a merge undoes nothing (CTL-25). A device not
  bootstrapped, or in a capacity conflict, knows that its state may lack something:
  a device bootstrapped by it would write though it may lack a decision about
  itself, and pass the gap on (CTL-32). What decides is completeness, not trust.
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
  the responder (LOS-14). Two devices of one member, or two members asked by all,
  may both answer, so a piece names its stream: by `respondsTo` alone their pieces
  would count as one answer.
- **RSY-9** · *engine* — A responder MUST answer at most one request per
  throttle interval per document. It MUST keep every request it may have to
  answer and has not answered — throttled, before its turn (RSY-20), or with
  nothing to offer yet (RSY-17) — and reconsider it on later processing, until
  RSY-17 or RSY-20 lets it go, independently of whether the request's delivery is
  offered again. Of each requesting stream (LOS-13) only its latest request
  counts: a request numbered below one of its stream it heard before it MUST let
  go, and one numbered above lets go what it keeps of that stream's earlier ones.
  A request counts as answered only once the transport
  has accepted the answer:
  - after a send failure that is worth retrying (§3.4) the request MUST be kept as
    before, under the time it was first heard (RSY-19);
  - after a permanent one it MUST be let go.

  A request for which its profile fails to compute an answer MUST be let go and
  reported to the application once, naming the request, and MUST NOT keep it from
  answering the others.
  *Rationale:* bounds the responder's traffic however many requests arrive. An
  engine processes each delivery once (TRN-8), so a request skipped under the
  throttle and not kept would not be looked at again; one kept after its answer
  failed would fail on every later processing, and anyone in the channel can send
  one (§1.7, item 11). A requester that asked again has moved on, and its latest
  request asks for what it still lacks; an earlier one read late — after an outage,
  or as a restarted responder reads again — would cost an answer for nothing. No
  clock decides which is stale (RSY-17): the stream's own numbers do.
- **RSY-19** · *engine* — A responder MUST keep those requests (RSY-9) by their
  `requestId`, at most four per requester (a requester's fifth replaces its
  oldest and keeps the requester's place in the order), and MUST serve requesters
  in turn: of the requests it keeps, it answers first one of the requester heard
  longest ago that it has not answered since, a requester just answered going to
  the end. It MUST bound what it keeps, by count and by age, dropping the oldest
  first ([Appendix B](#appendix-b-recommended-values)).
  *Rationale:* several devices of one member may each have a request outstanding
  (RSY-3) and are each to be answered (RSY-6); keeping one per requester would let
  them push each other out. Four per requester, and turns, keep a requester that
  repeats itself from pushing others back; the bound keeps a flood of requests from
  growing a responder's memory — a dropped requester asks again (RSY-5, LOS-6).
- **RSY-10** · *engine* — A resync answer MUST NOT be refused because the document
  is closed or because the responder's own permission is `read`.
  *Rationale:* a closed document must still bootstrap a joiner (LIF-6); the creator
  is never read-only, and a member answering a request to all restores content the
  requester lacks — as long as the member's application keeps every change its
  engine refuses out of the engine's document (CTL-42), since the answer carries
  everything in it.
- **RSY-11** · *engine* — A resync answer MUST go through the send scheduler and wait
  for the floor like every other message (SND-2). A responder SHOULD NOT stop
  processing deliveries while its answer waits.
  *Rationale:* the provider's rate limit counts every message; an answer sent
  outside the scheduler can push the next edit into a refusal. The cost is stated:
  a joiner may wait up to one floor for its bootstrap.

### 8.4 Accepting an answer

- **RSY-12** · *engine* — An engine MUST accept every `resync-response` the
  creator sent, every `resync-response` whose `respondsTo` names a request the
  engine itself made, whoever sent it, and every `resync-response` whose
  `respondsTo` names another's request to all for which it let a request of its
  own go (RSY-22). An engine that does not know the creator MUST accept none.
  It MUST bound the requests it keeps for this, its own and those it let its own
  go for, by an age and a count of its own
  ([Appendix B](#appendix-b-recommended-values)): it MAY forget one that went out,
  or was heard, longer ago than that age and to which no answer is still arriving
  in pieces (LOS-14), and beyond that count it forgets the oldest first. An answer
  to a request it forgot is one to a request it did not make.
  *Rationale:* the counterpart of RSY-6: anyone may answer a request to all, so
  anyone's answer to one's own request is accepted. Its content is an update anyone
  in the channel could have sent as an edit (CTL-7), and its control state is
  merged as CTL-25 says; without the `respondsTo` check, anyone could push content
  by a response nobody asked for. A device that let its request go for another's
  asked through that one (RSY-22). A later answer is not applied, but its last piece
  is a report, which shows what the engine lacks as a gap (LOS-4, LOS-25). Only
  answers one asked for, or let one's own go for, are reassembled, so what an engine
  holds in pieces stays bounded (LOS-22); kept without bound, the requests of an
  engine that runs for months would grow with every one it makes.
- **RSY-13** · *engine* — An engine MUST apply:
  - the update of every accepted `resync-response`, the creator's answers to other
    members' requests included, and of every answer to one request when several
    arrive;
  - the control snapshot of every accepted `resync-response`, as CTL-25 says.

  It MUST consider the attribution overlay only of a response that answers its own
  request (ATR-1, ATR-2) — the first one it adopts stands (RSY-15) — and MUST leave
  content applied from any other response unattributed (ATR-2).
  *Rationale:* content is a CRDT and harmless to apply twice, so the answers of two
  members asked by all merge, their control state too, the later register holding
  (CTL-22); but an overlay only describes the document of the member who asked, and
  the responder did not write everything it sends.
- **RSY-14** · *engine* — An engine MUST consider its bootstrap complete — it is
  **bootstrapped** — once it:
  - created the document (LIF-3);
  - applied an answer to its own request that carries control state (CTL-25,
    RSY-8), also one whose snapshot brings it into a capacity conflict (CTL-32) —
    a device of the creator: only an answer of another device of the creator;
  - a device of the creator: restored control state that was bootstrapped when it
    was persisted (CTL-26), or that its application carried to it from another
    device of the creator where it was bootstrapped (ARC-5);
  - anyone else: by its own restored control state after a restart, as CTL-41
    says.

  Its own decisions, an answer without control state and an answer to someone
  else's request — one it let its own request go for (RSY-22) included — bootstrap
  nothing. Until it is bootstrapped it MUST state `null` as its control clock and
  control digest in every frame that has them (RSY-16, SND-11), MUST answer with
  `control: null` (RSY-8), and MUST make "not yet bootstrapped" observable to its
  application.
  *Rationale:* a joiner nobody has answered yet sees an empty document; the
  application must be able to say "waiting for the group" rather than present it as
  the real one. A device that is not bootstrapped holds at most part of the control
  state: offered as the whole, it would bootstrap others with less than the creator
  decided. Members' answers bring a device of the creator the content and, merged,
  the registers they hold (CTL-25), yet a decision of a lost device may have reached
  only some of them (§7.6), so only another device of the creator, or its own
  restored or carried state, bootstraps it; restored or carried, at once, and
  without content it returns (RSY-21). An answer bootstraps a device only when it
  answers its own request, which states the responder's state as it answers:
  without a cursor overlapping reads prove nothing (LOS-8), and a member restarted
  without one would be bootstrapped by re-reading an old answer, past a revocation a
  gap may have hidden (CTL-41).
- **RSY-15** · *engine* — The first overlay an engine adopts for its bootstrap
  stands; a later answer's overlay MUST NOT replace it wholesale.
  *Rationale:* whichever answer bootstrapped the engine, a second wholesale
  replacement could overwrite attribution the engine has derived since.

### 8.5 The bootstrap in one table

What a bootstrap takes stands in §7 and §8; this table states it in one place and
adds no rule: each cell restates the requirement it cites. An *answer* is a
`resync-response` the device accepts (RSY-12); *its request* is one of its own
(RSY-16). Who writes, and when, CTL-13, CTL-27 and CTL-32 say.

| Answer | What it takes (RSY-13) | Over the bounds (CTL-30) | *History truncated* (LOS-19) | Its bootstrap (RSY-14, RSY-21) |
|---|---|---|---|---|
| Anyone's, to its request, with control state — to a device of the creator, only another device of the creator's | The update, and the snapshot merged (CTL-25) | Refused: a capacity conflict (CTL-32) | Ends, for a request sent with `force` after it was last found | Complete, in a conflict too, and the request ends (RSY-4) |
| A member's, to a request of a device of the creator, with control state | As above | As above | Ends, for a request sent with `force` after it was last found | Goes on: merged, but not bootstrapped (RSY-14); once its attempts ran out, its application asks for another device of the creator (CTL-43) |
| The creator's, to another's request | As above | As above | Stays | Goes on |
| Anyone's, to another's request to all for which it let a request of its own go (RSY-22) | As above | As above | Stays | Goes on |
| Anyone else's, to another's request | Nothing: not accepted (RSY-12); its last piece is a report (LOS-13) | — | Stays | Goes on |
| Anyone's, to its request, with `control: null`: from a device not bootstrapped, or in a capacity conflict (RSY-8) | Content only | — | Stays | Goes on: a request to all stays outstanding (RSY-4), and the next one asks all (RSY-21) |
| No answer: its own state restored after a restart (CTL-26, CTL-39), or carried from another device of the creator (ARC-5) | As persisted | As persisted (CTL-32) | A truncated read keeps anyone but the creator from completing | A device of the creator: complete at once where it was bootstrapped, its request going out as RSY-1 says, to all where it holds no content (RSY-21); anyone else: once it read on from its cursor without a gap (CTL-41) |

1.x's RSY-2 and RSY-7 are withdrawn
([Appendix G](#appendix-g-changes-from-tdsp-1x)).

## 9. Send scheduling

Real messengers refuse traffic that a naive "send on every typing pause" policy
produces: one measured provider refused after about 35 messages in 20 minutes, and
without a retry a refused message is a lost one. The scheduler is one component of
the engine, above every bridge, so no bridge implements any of it.

### 9.1 Pacing

Five numbers govern when an engine sends — its **pacing**:

| Parameter | Meaning |
|---|---|
| `minIntervalMs` | The floor: no two messages closer than this |
| `maxIntervalMs` | The longest a pending change may wait, counted from its oldest pending edit; `null` for no limit |
| `minChars` | Do not send fewer changed characters than this, unless `maxIntervalMs` has passed |
| `maxChars` | Send as soon as the floor permits once this many changed characters are pending; `null` for no limit |
| `expectedLatencyMs` | How long a message normally takes to arrive; the waiting time of this engine's evidence derives from it (LOS-1). 0 = unknown |

An engine also has a local **quiet time** (`batchWindowMs` in the reference
implementation): the length of a typing pause after which a pending change may go
out.

Pacing is each participant's own. The one thing the participants share is the
**pace**: the shortest interval anyone sends at, which the creator may set as a
target of the control state ([§7.1](#71-what-control-state-is)). Where a messenger
shows every message in the group's chat, the pace keeps a document quiet for
everyone; where a provider is strict, each participant's own bounds still win.
Receivers need nothing else of a sender's pacing.

- **SND-1** · *engine* — An engine MUST make every pacing it runs consistent before
  running it:
  - a negative or non-numeric value falls back to its default, and so does a
    `minIntervalMs`, `minChars` or `expectedLatencyMs` that is not finite — only
    `maxIntervalMs` and `maxChars` may be unlimited;
  - `maxIntervalMs` is raised to at least `minIntervalMs`;
  - `minChars` is treated as 0 while `maxIntervalMs` is unlimited, and is lowered to
    at most `maxChars`.

  *Rationale:* no combination of values may starve a pending change — a change
  smaller than `minChars` with no deadline would otherwise never be sent.
- **SND-15** · *engine* — The creator MAY set the pace. An engine MUST NOT send
  faster than the larger of the pace and its own transport's `bounds.minIntervalMs`,
  and MAY send slower. It MUST bound the pace it runs ([Appendix
  B](#appendix-b-recommended-values); 10 minutes recommended) and run a longer one
  as that bound, here and wherever it judges by the pace (SND-16, LOS-14).
  *Rationale:* the pace keeps a document quiet; the own bounds still win, since they
  are the provider's limit and the creator cannot know everyone's provider (§1.7,
  item 13). A pace of days would hold every participant's reports and answers, a
  joiner's bootstrap among them, for as long. What a receiver judges by the pace —
  how long the pieces of an answer may take (LOS-14) — is its own waiting, so
  engines that bound it differently never misjudge each other.
- **SND-16** · *engine* — The pacing an engine runs MUST be the engine's defaults,
  overridden by its transport profile's `pacing`, overridden by what its application
  chose; then `minIntervalMs` raised to at least the transport's
  `bounds.minIntervalMs` and to the pace it runs (SND-15); and the result made
  consistent (SND-1). Its `minIntervalMs` is the engine's **floor**. No pacing value
  but the pace is sent to anyone.
  *Rationale:* the rest of pacing concerns only the sender's own messages; receivers
  need none of it, and sharing it would need a grammar, an order and a clamp for
  every value.
- **SND-2** · *engine* — Every message an engine sends — of every kind, the initial
  seed and resync answers included — MUST go through its send scheduler, and MUST
  NOT be sent sooner than the engine's floor (SND-16) after its previous message of
  any kind, nor while a hold after a refusal lasts (SND-7). This holds for a send an
  application asks for at once too (what is pending, or a last send before the
  engine stops), which skips only the quiet time and `minChars`, and the wait for
  the person after a `needs-person` refusal (TRN-20).
  *Rationale:* the floor is the provider's rate limit, and the provider counts
  messages, not kinds: one message that bypasses the scheduler can push the next
  into a refusal.
- **SND-20** · *engine* — A message that is not a local edit (a control frame, a
  resync request or answer, the seed) SHOULD go ahead of edits that are waiting; a
  report goes after them (SND-11). Its outcome goes to whoever sent it, and the
  scheduler does not retry it, except a control frame (CTL-26), a piece of an answer
  sent in pieces (SND-17) and a report (SND-12). The seed is no pending change
  (SND-6): a failed send of it MUST fail the document's creation (LIF-3) — but where
  the creator's application sent the invitation before it, into a channel made for
  the document (LIF-9). There the engine MUST keep the document, count its content
  as undistributed (SND-21) and send it whole once it can, as it sends restored
  content (LIF-5).
  *Rationale:* a piece is retried because the pieces before it are out. A seed that
  failed before anyone was invited (§6.2) is replaced by a new document, not created
  again: its documentId stays marked (LIF-5), and it may have reached someone
  listening. Where the invitation went first, those invited would hold one to a
  document that never starts.
- **SND-3** · *engine* — A pending change MUST be sent no later than the first
  moment at which the floor permits after either `maxIntervalMs` has passed since
  its oldest edit or `maxChars` changed characters are pending. Beyond that it
  SHOULD be sent once the floor, the quiet time and `minChars` all permit.
  *Rationale:* `maxIntervalMs` closes the debounce's fault that continuous typing
  never sends; the floor closes its other fault, one message per pause.
- **SND-5** · *engine* — Changed characters MUST be counted from local edits only,
  never from applying remote updates.
  *Rationale:* a remote edit arriving must not make a local change look large enough
  to send early.

### 9.2 Keeping and retrying a refused send

- **SND-6** · *engine* — An engine MUST keep a pending change until a send of it has
  succeeded, and MUST merge later edits into it while it waits.
  *Rationale:* one lost update blinds every receiver to everything its author sends
  afterwards (PRF-5). CRDT updates merge and are idempotent, so resending a change
  that did in fact arrive is harmless.
- **SND-7** · *engine* — A send the scheduler retries (SND-6, SND-12, SND-20) that
  failed with `rate-limited` or `unavailable` MUST be retried after an exponential
  back-off that is bounded and reset by a success, and MUST NOT be retried before a
  messenger-stated `retryAfterMs` has passed (up to a bounded maximum). A retry MUST
  wait for the floor and the back-off only, not for the quiet time or `minChars`
  again. Such a failure of any message, retried or not, MUST hold back the engine's
  next send of any kind for the back-off, or for what the messenger asked if that is
  longer — except a report (SND-11) whose send failed with `unavailable`: that holds
  back only its own retry, by a back-off of its own (SND-12). A `rate-limited`
  failure, the wait the messenger asked for, the spacing it widens (SND-9) and a
  `needs-person` refusal (TRN-20) hold back every send, a report's among them. A
  success resets a back-off and ends a hold, and a success or a drop (SND-8) ends the
  failure the engine exposes (SND-10, TRN-20), only where its send began after the
  failure; that failure ends too once no message the scheduler retries waits or is
  under way.
  *Rationale:* the batch was judged ready once; waiting for a new typing pause would
  delay it for nothing. A provider throttles the account, not one message, so the
  next message of another kind would run into the same refusal, and a send under
  way when the refusal came says nothing of it. A report that could not reach the
  messenger says nothing of the account, and a change made meanwhile goes first
  anyway (SND-12).
- **SND-8** · *engine* — A send that failed with `too-large` or `rejected`, and a
  change the engine itself refuses to send (CTL-13), MUST be dropped and reported to
  the application exactly once. Dropping ends the send job only: the change stays in
  the sender's document, and every later change builds on it. The engine MUST
  therefore expose that it holds *undistributed changes* until the transport has
  accepted its whole state (`resync()`) — every piece of it, when it is split — and
  nothing has been dropped since. A piece of that state refused for good keeps the
  mark; a dropped message that carries no change of the sender's own — a resync
  answer, a request, a report, whatever update it carries again (SND-27) — MUST NOT
  set it.
  *Rationale:* retrying cannot help, and a change dropped silently is the failure
  this section exists to prevent. The CRDT cannot take a change back: receivers hold
  everything its author sends later as a pending gap only the author can fill, until
  the whole state, sent once the cause is fixed, heals it — a full-state update
  depends on nothing before it. A dropped answer, request or report leaves nothing
  of the sender's own missing (RSY-5, LOS-6, SND-27).
- **SND-21** · *application* — While the engine exposes undistributed changes
  (SND-8), the application MUST show that the document holds them, MUST offer to
  send the whole state again, and MUST NOT show the document as synchronised. An
  application that keeps a document across restarts MUST keep the undistributed mark
  with it.
  *Rationale:* the person has to learn that a change of theirs did not go out, and
  be able to send it once the cause is gone; merely avoiding the word "synchronised"
  says nothing.
- **SND-22** · *engine* — A `too-large` refusal of a message within the `maxBytes`
  the transport's own profile declared MUST be reported, in addition to its report
  under SND-8, as a fault of the transport profile or its binding.
  *Rationale:* a refusal the profile said could not happen is not the sender's fault
  and must not look like it.
- **SND-9** · *engine* — After a `rate-limited` failure of a message of any kind an
  engine SHOULD widen the spacing between its later sends of every kind, and SHOULD
  relax it again after a run of successful sends.
  *Rationale:* a refusal is evidence that the current pace is too fast for this
  provider, whatever the pacing says.
- **SND-10** · *engine* — An engine MUST expose to the application whether it is
  idle, waiting for its send window, or retrying (with the failure count, the time
  of the next attempt and the last failure), and MUST report a failure as an error
  only when SND-8 drops a message. A resync request whose send fails is no error: it
  releases its slot (RSY-4), and its outcome, *failed*, MUST be observable until the
  engine's next request. A report whose send fails is retried as SND-12 says, is
  reported to no one, and is not shown as retrying: what the status shows is the
  person's changes, and that sending waits for the person while a `needs-person`
  refusal of any message holds it (TRN-20). A report owed still counts among what has not gone out for an
  application that waits for that before it ends (SND-28).
  *Rationale:* a change being retried is not yet lost, and a sticky error for it
  teaches people to ignore errors. A request that never goes out leaves a joiner
  waiting for ever: its outcome lets the application say so.

### 9.3 The report

A lost *final* message leaves no gap for anyone to see: nothing later from the same
sender is pending behind it. The report after each phase of a sender's own writing
carries that message again.

- **SND-11** · *engine* — An engine **owes** one **report** — a `heartbeat` frame —
  for each **phase** of its own sending, and MUST send each report it owes once it
  is **due**. A phase begins with an `edit` frame (a piece of one included) or a
  `control` frame of its own that the transport accepted, and goes on with each
  further one; its report is owed from that first frame on (SND-28). The phase ends,
  and its report is due, once a **report delay**, as [Appendix
  B](#appendix-b-recommended-values) recommends, has passed since the last of them
  while no change of its own waits, is under way — its first try as a retry — or is
  retried (SND-6, SND-17); the report then
  goes, whatever the engine's pacing, as soon as the floor permits. A report is owed
  and due at once — it goes as soon as the floor permits, and still only once no
  change of its own waits or is under way —:
  - for a phase not yet reported, when its application stops using the document, or
    tells it that its device is about to sleep (LIF-12);
  - on a device of the creator, once a merge — of a `control` frame of another
    device of the creator (CTL-22), or of an answer's snapshot, to its own request
    or to another's (CTL-25) — changed its control digest while it is
    bootstrapped, and once an answer bootstrapped it (RSY-14) where its control
    digest then differs from the one the answer stated;
  - as SND-24 says.

  It MUST NOT send more than one report per phase but in these cases: once one went,
  none until a new phase begins or one of them comes. A send of the whole state —
  the seed (LIF-3), restored content, `resync()` (SND-8) — is no local change: it
  neither begins nor prolongs a phase. Nor do a close sent again (LIF-11), a
  request, an answer or a report, and reading owes nothing. A report carries its
  sender's state vector and state digest, from a device of the creator that is
  bootstrapped (RSY-14) its control clock and control digest (`null` otherwise), its
  stream and number (LOS-13), and what SND-27 says.
  *Rationale:* one report after a phase shows what a lost final message leaves
  unseen (LOS-4, LOS-10) and, carrying it again (SND-27), heals it, also where its
  sender goes offline right after; it costs one message per pause in writing, and
  reading none. "Nothing of its own waits" keeps a change and its report from going
  as two messages where the floor is long — under a pace of 35 seconds only a pause
  about that long brings a report —, and a report ahead of a change it holds would
  show an update receivers cannot have yet (LOS-4). Closing and sleeping cut the
  delay short; the delay says only when the report goes, not from when it is owed
  (SND-28). Whoever missed the seed is bootstrapped by
  an answer (RSY-14); repeated, the largest message there is would double. Control
  state is judged by reports only (LOS-10), and a member's report states no control
  clock, so what a device of the creator merged — a member's answer, a `control`
  frame of another of her devices — spreads by her report (LOS-12), also where it
  left her control clock where it was: one message however many merges come, healed
  when lost by her next report or request (§10.6).
- **SND-27** · *engine* — The report that ends a phase (SND-11), and only that, MUST
  carry again, once, the last message of its own local changes and decisions that
  the transport accepted in that phase:
  - where that message was an `edit` frame, its update, in `update`, byte for byte
    as it went out, and nothing else — never a change the engine did not send or
    refused (CTL-13, SND-8, SND-26) —; it MUST carry none where that edit was a
    piece of a split update (SND-17), or where the report would exceed
    `bounds.maxBytes` with it;
  - where that message was a `control` frame, of a device of the creator, that frame
    again, unchanged, before the report, which then carries no `update`.

  Every other report MUST carry no `update`. A receiver MUST check and apply a
  carried update as an `edit` frame's (CTL-7, LIF-6, FRM-6; PRF-1, item 9), and
  judge the report after it (LOS-4, LOS-12).
  *Rationale:* a receiver that lost the last change of a phase — the typical loss,
  which nothing later of its sender shows — takes it from the report, without asking
  and whether or not its sender is still online; one that has it notices nothing,
  since the CRDT takes a duplicate as nothing. The requirement lies with the sender,
  since a receiver may not judge an update by its own rights (CTL-7): only what went
  out is carried, so a reader or a revoked member carries nothing, and after a
  revocation or the close a repeat is a duplicate delivery. A piece is no whole
  change, a report too large would not go, and repeated in every report the change
  would cost its bytes for nothing. A report carries no registers, so a decision
  sent last goes again as itself.
- **SND-28** · *engine, application* — A report stays owed (SND-11) until the
  transport accepted it, or refused it for good (SND-12). An engine MUST
  make whether one is owed, and what it would carry again (SND-27) — nothing, for a
  report that ends no phase —, observable to its application whenever that changes,
  from when it is owed, not only once it is due. An application that persists the
  document's content MUST persist that with it, on this device only, and give it
  back when it starts the engine from that content; the engine MUST then send that
  report, with what it carries again, as soon as a report due at once may go
  (SND-11).
  *Rationale:* owed from its first frame, not from when it is due, a report survives
  a device that is ended within the report delay. A device that sleeps, loses its
  network or is ended before its report went sends it the next time it opens the
  document: an opportunity, no promise, for a receiver that lost its last change or
  decision (SND-27, LOS-10, LOS-12), which heals where the report arrives. A report
  the transport accepted is owed no longer, whether or not it arrived (TRN-10), and
  opening the document then brings none
  ([§10.6](#106-what-loss-detection-cannot-notice)). Carried across a restart,
  under a new stream and a new client id (LOS-13, LOS-27), what the report carries
  is still a copy of an edit that went out (SND-27) — on this device only, since no
  other device sent it (ARC-5).
- **SND-24** · *engine* — An engine that hears a `resync-request` stating exactly
  its own state vector and state digest, while what it deleted within the state
  vector of its latest report (LOS-13) differs from what that report stated, owes a
  report at once (SND-11).
  *Rationale:* a report that crossed another's deletion, which the engine then
  received by an edit, would stand for the engine though older than what it holds,
  and show everyone who holds that deletion a difference in digests (LOS-12) that
  nobody can end: nobody has anything to give them, so their requests go unanswered
  and their gaps rest (LOS-6). A request that states what the engine holds is the
  sign that someone asks in vain, and only a newer report of that stream ends it.
- **SND-12** · *engine* — A report MUST go through the send scheduler and count
  against the floor like every message (SND-2). One whose send failed for a reason
  worth retrying stays owed and MUST go again after the back-off (SND-7). The
  messages of a report go one after the other (SND-27); while one waits, a change of
  its own goes first, and the report stays owed and goes with the report that ends
  the phase that change begins (SND-11). Once its application tells it of a return
  (RSY-21) or that a read reached the messenger again (LIF-12), the back-off of the
  report's retries ends, and it goes as soon as the floor and a wait the messenger
  asked for (SND-7) permit. One refused for good is given up and sets no
  undistributed mark (SND-8).
  *Rationale:* retried, a report lost to a passing refusal goes as soon as the
  messenger takes messages again, after an absence at once, not only at the next
  opening (SND-28). It never holds a change back: the next report carries the
  change.
- **SND-13** · *engine* — A report's state MUST NOT be applied as document content
  and MUST NOT change control state; the update it carries is applied as an edit's
  (SND-27).
  *Rationale:* its state is evidence, not authority, and it is accepted from any
  member; the update it carries is a copy of an edit that went out, and taken as
  one.

### 9.4 Changes larger than one message

When the transport states `bounds.maxBytes`, no frame larger than that may be sent.
A change that does not fit travels as several messages:

- *Spreading* sends several pending updates as a sequence of merged prefixes, one
  per message, each a prefix whose frame fits.
- *Splitting* is for a single update that does not fit by itself — one large paste,
  or the state a resync answer carries: the profile splits it into **pieces**
  (PRF-1, item 7), and each piece is an `edit`, or a `resync-response` to the same
  request.

Either way every message carries a valid update, applied as it arrives; a lost piece
is an ordinary pending gap (LOS-2), and there is no reassembly. How many messages
a change takes is the sender's, each no larger than `bounds.maxBytes`, which
includes whatever the bridge can carry beyond a message body, an attachment among
it ([bindings/](bindings/)).

- **SND-17** · *engine* — An engine MUST NOT send a frame larger than the
  transport's `bounds.maxBytes`:
  - it MUST spread a pending change over several messages when that suffices;
  - it MUST otherwise send an update as several frames of one piece each: several
    `edit` frames, or several `resync-response` frames with the same `respondsTo`.

  It MUST send the pieces of one update in order and ahead of any edit made after
  it, paced by the floor, and MUST NOT make them wait for a typing pause. A piece
  refused for good (SND-8) MUST drop the pieces of its update still to go.
  *Rationale:* a piece is useful on its own, so nothing waits for the last one; a
  later edit builds on the split change, and sent first it would look like a gap to
  every receiver. The pieces after one that never goes out build on it, so receivers
  would only hold them back; the change goes again whole (SND-8), and a requester
  missing a piece asks again (LOS-14).
- **SND-18** · *engine* — When a resync answer is split, its control snapshot and
  attribution overlay MUST travel in the last piece, or, when they do not fit beside
  it, in one more `resync-response` whose update holds nothing (PRF-1, item 4); when
  both do not fit there, the overlay is left out. A control snapshot that does not
  fit even alone makes the answer fail (SND-8); CTL-37 keeps a device of the creator
  from making a decision after which it would not fit.
  *Rationale:* the requester's bootstrap completes with the snapshot (CTL-13), so it
  should come once the content it describes is on its way; attribution is display
  only (ATR-3) and yields first.
- **SND-19** · *application, engine* — An application MUST write content so that no
  single unit the document's profile cannot split exceeds the size the profile names
  for it (PRF-1, item 7). An engine MUST refuse an update it cannot split to fit as
  `too-large`, and report it (SND-8), as it MUST when not even one useful piece fits
  beside a frame's other fields.
  *Rationale:* without a reassembly, a unit larger than one message could not travel
  at all; writing large content in pieces keeps large changes possible (§1.7, item
  8) without a frame kind of its own. For `yjs-paragraphs/1` only content of length
  one — an embed, a binary — is such a unit, and a profile says how large it may be
  (Appendix A).
- **SND-26** · *engine* — An engine MUST NOT send a change of its own that its
  document's profile does not read as exactly one update (PRF-1, item 9; for
  `yjs-paragraphs/1`, Appendix A, "Reading without applying"). It MUST refuse it as
  `unreadable` and report it (SND-8), and MUST NOT merge it with any other change
  into one message.
  *Rationale:* every receiver would refuse such a frame (FRM-6), and with it every
  change merged into it. Refused, the change still stays in the replica that made
  it: later changes of that replica build on it and wait at receivers for it
  (LOS-23), and its answers carry it. So an application must not make such a change
  (YJS-1); the refusal tells it that it did, so that it can undo it.

1.x's SND-4 and FRG-1 to FRG-8 are withdrawn ([Appendix
G](#appendix-g-changes-from-tdsp-1x)). SND-14 and SND-23, requirements of an
earlier draft of 2.0, are withdrawn: no frame promises a follow-up, so
there is no `due` to keep ([CHANGELOG.md](CHANGELOG.md)).

## 10. Loss detection

*How it works (informative).* A receiver often holds what it needs to notice that a
message did not reach it. Loss detection makes that available as **evidence**, never
as a claim: every piece of evidence can have an innocent cause, a message only late
among them, and no evidence is no claim of completeness either (§10.6).

Evidence is a **gap** of one stream (§10.1): an update whose predecessors are
missing, a report — a `heartbeat`, a request or an answer's last piece — of what the
receiver has not applied, of a digest that differs, or, from a device of the
creator, of a control clock above every clock the receiver holds (§10.2, §10.3), a
history the bridge cut short (§10.4), an answer missing a piece (§10.5). A `control`
frame is no evidence; a difference in digests, which cannot say which side lacks
something, lapses once its stream falls silent (LOS-12). Each gap is asked for at
most three times, then **rests** until something wakes it. Most often none of it is
needed: the report after each phase carries the phase's last message again (§9.3).

### 10.1 Evidence, not claims

- **LOS-1** · *engine* — An engine MUST NOT report a message as lost; it MAY report
  evidence that something is missing. It MUST NOT report any evidence before it has
  persisted for a *waiting time* derived from its pacing's `expectedLatencyMs`
  ([Appendix B](#appendix-b-recommended-values)), except *history truncated*
  evidence (LOS-19).
  *Rationale:* a message that is merely late produces exactly the same evidence for
  a while; reporting it immediately would cry wolf on every slow network.
- **LOS-15** · *engine, application* — An engine MUST NOT expose the absence of
  evidence as "synchronised" or "complete", and an application MUST NOT present it
  so. The most an application may say is that nothing currently suggests a loss —
  and not even that on a device of the creator whose evidence LOS-20 ended by a
  request that went *unanswered*, while that is its last request's outcome: then it
  may only say that nobody it could ask had anything to give.
  *Rationale:* a loss can leave no trace an engine can see (§10.6), so no evidence
  is not completeness.
- **LOS-7** · *engine* — Loss evidence MUST be based on the time the receiver heard
  a message, not on the sender's clock.
  *Rationale:* clocks of different participants are not synchronised, and the
  missing edit may still be in flight behind a report that just arrived.
- **LOS-25** · *engine* — A **gap** is evidence of what the engine lacks of one
  **stream**, kept and tried apart from every other:
  - of the updates of one CRDT client (LOS-2, LOS-4), where the profile tells whose
    (PRF-1, items 2 and 4), else of the reports of the one stream that showed it;
  - of the deletions one stream's report shows (LOS-12);
  - of the control state one stream of the creator states in its reports, or of the
    creator's control clock (LOS-10, LOS-12);
  - of an answer missing a piece (LOS-14);
  - of a history truncated (LOS-8, LOS-9, LOS-23).

  Its **position** is the furthest point of its stream the engine knows of: the
  clock of that client a frame names — an update carried by a report (SND-27)
  included —, the number of that stream's latest report, the creator's control
  clock; a gap of an answer or of a truncated history has none. A gap keeps the time
  it arose until it ends (LOS-18) — a lapse is no end (LOS-12) —; a gap of the same
  stream after that is a new one. Gaps are not kept across a restart: a starting
  engine holds none, and what its first read shows arises anew. An engine MUST bound the CRDT clients whose
  positions it keeps, forgetting the one named least recently first ([Appendix
  B](#appendix-b-recommended-values)).
  *Rationale:* losses of different writers are independent: one that nobody
  reachable can heal says nothing of the next. Kept apart, each has its tries
  (LOS-6) and its rest (LOS-26), and a writer who writes again moves only its own
  gap's position. Kept from when it arose, a gap shown again and again is not judged
  as new each time (LOS-1). Every start writes under a new client (LOS-27), so their
  number grows with the sessions that wrote.
- **LOS-6** · *engine, application* — An engine SHOULD answer each gap (LOS-25) by
  resync requests to all through its single request slot (RSY-3), automatically: the
  first once the gap has lasted a conservative multiple of the waiting time (LOS-1)
  and then its **place**, derived from the gap and its own stream as RSY-20 derives
  a turn — at once for a truncated history (LOS-19) —; each further one once a wait
  has passed since the try before, the first twice the expiry of a request that does
  not ask all (RSY-4; Appendix B: floor + 2 × latency, at least 10 s), each at least
  double the one before, up to a longest wait as
  [Appendix B](#appendix-b-recommended-values) recommends, and after a request let
  go for another's (RSY-22) also once that one had its time, then its place; never
  while a request of its own is outstanding. It
  MUST NOT make more than three automatic requests for one gap, nor wait less
  between two of them than that doubling gives. A gap's wait is the multiple of
  LOS-1, without its place: from when it passed, the gap is about to be asked for,
  and while it waits for its place another's request to all may stand in for its
  try (RSY-22). A request counts as a try of every gap whose wait had passed
  when it went out, or when it was let go for another's (RSY-22), its place come or
  not; one whose send failed for a reason worth retrying (§3.4) counts for none, one
  refused for good counts. After three, the gap **rests**: the engine asks for it no
  more by itself until it is woken (LOS-26). The application MAY switch the
  automatic requests of this requirement and LOS-26 off, as RSY-5 says.
  *Rationale:* asking costs messages against the same rate budget as editing;
  unbounded automatic requests would turn a noisy network into a traffic storm. A
  gap that nobody reachable can heal must not spend the tries a later loss of
  another stream needs: each gap has its own, and resting, it costs nothing until
  its stream moves on. A loss at the messenger leaves the same gap at every receiver;
  placed apart, one of them asks first at each try, and the others let theirs go
  for its request (RSY-22): one request and one answer, where all would otherwise
  ask at once. Where some ask before hearing each other, each may let its next try
  go for one of those requests, its answers over: a cost only where those answers
  were lost too.
- **LOS-26** · *engine, application* — An engine MUST make a resting gap (LOS-6)
  observable, and its application MUST show it and SHOULD offer its person to
  synchronise now (LIF-12). An engine SHOULD wake a resting gap — one request to all
  for it, timed from the frame that woke it as its first was from when it arose
  (LOS-6), after which it rests again — when it reads a frame that raises the gap's position (LOS-25), or, for a
  gap of a CRDT client, a frame of the member it names as that client's writer
  (LOS-2); it MUST NOT wake a gap so more than once in 10 minutes, counted from its
  previous wake: a frame read sooner wakes it once the 10 minutes passed. A frame of
  anyone else that states the same position again wakes nothing. An absence its
  application tells it of that is longer than RSY-1's, or a return (RSY-1, RSY-21),
  and a request of its person (RSY-3) wake every resting gap at once; the request it
  brings, or the person's, is theirs.
  *Rationale:* a gap rests because nobody who could heal it answered; a frame that
  moves its stream on, or one of the writer's member — under a new client id after
  a restart (LOS-27), still holding what it wrote (RSY-17) —, shows that someone who
  holds what is missing is there again. Once in 10 minutes bounds what a writer
  whose lost change stays lost costs while it writes on; the first wake does not
  wait 10 minutes after the last try. Timed so, the devices one frame wakes ask once (RSY-22). An absence and the person's request ask anyway; a gap without a position
  waits for them. A resting gap stays evidence (LOS-15): the person may know what the
  engine cannot — that another device is online again.

### 10.2 What a receiver can see missing

- **LOS-2** · *engine* — An engine MUST treat as evidence an update held pending
  because its causal predecessors are missing (a *pending gap*). A deletion of items
  the engine does not hold, which the CRDT holds back until they arrive (PRF-1, item
  2), is one. The engine SHOULD name the member it is waiting for when it can tell.
  *Rationale:* this is the direct signature of a lost message in the middle of a
  sender's stream. A held deletion is one too: the insertion it deletes was lost, or
  is late.
- **LOS-23** · *engine* — An engine MUST bound the bytes its profile holds for
  missing predecessors, as the profile measures them (PRF-1, item 2; [Appendix
  B](#appendix-b-recommended-values)). When they exceed the bound, it MUST give up
  all it holds so, as the profile gives them up, and MUST treat that as *history
  truncated* evidence, with the consequences of LOS-19 and LOS-20.
  *Rationale:* anyone in the channel can send updates whose predecessors never come,
  since receivers do not reject an edit for its sender's permission (CTL-7); held
  without a bound, they would take a receiver's memory unseen (§1.7, item 11). What
  is given up is as if the engine had missed those deliveries, so it asks as after a
  truncated history: the forced answer carries every update its state vector lacks,
  from a responder that applied them, and ends the evidence even where the responder
  holds none of them.
- **LOS-4** · *engine* — An engine MUST treat as evidence — a gap of each client
  whose updates it holds fewer of (LOS-25) — a report (LOS-13) — a `heartbeat`, a
  request or an answer's last piece (RSY-18) — whose state vector contains updates
  it has not applied, judged against its current document, after applying an update
  the report carries (SND-27), so that the evidence disappears when those updates
  arrive. It MUST judge the latest report of each of a member's streams (LOS-17),
  not only the member's latest, and the reports of its own member like anyone's.
  *Rationale:* it is the direct evidence of a lost *final* message whose repeat in
  the report was lost or did not fit (SND-27), and of someone else's change that the
  reporter holds. A device of a member that never saw a change must not hide the
  report of the one that made it, and another device of one's own member is where a
  change this device missed shows. Judged before the update it carries, every report
  would show its own repeat as missing.
- **LOS-10** · *engine* — An engine MUST treat as evidence a report (LOS-13) of a
  device of the creator whose control clock is above the greatest clock among the
  registers the engine holds. A `control` frame is no evidence, of this kind or of
  LOS-12's.
  *Rationale:* every decision raises its device's clock (CTL-21), and the report
  that ends its phase states that clock and its digest (SND-11), so a lost decision
  shows by that report or a later one (LOS-12); a clock that lags is no evidence,
  since its device may simply know less. A `control` frame carries no number that
  orders it among its device's frames, nor need its clock rise (LIF-11), so one that
  arrives late cannot be told from a current one; a report can (LOS-13, LOS-17).
  Only the creator decides (CTL-5), so her devices' clocks are what control state is
  measured by; a member's report says only what reached that member
  ([§15.4](#154-what-is-not-guaranteed), CTL-46).

### 10.3 Reports and streams

- **LOS-13** · *engine* — An engine MUST choose a random stream tag (§4.3) each time
  it starts, and MUST number every `heartbeat`, request and answer it sends in that
  stream, from 1, each one higher than every earlier one:
  - a `heartbeat` and a request when it writes them;
  - an answer when it takes the state it answers from, every piece of that answer
    with the same number (RSY-18).

  A *report* is a `heartbeat` — the report of SND-11 —, a request or an answer's
  last piece — of an answer the engine does not accept (RSY-12) too, of which it
  applies nothing —: its sender's state, at that number.
  *Rationale:* a member may run several devices under one MemberId, and a later
  message of one says nothing about another's state. Within one stream the state
  only grows, so a newer report says at least what an older one did, and its number
  orders the two however the messenger delivered them. What a stream reveals is how
  many engines a member runs and when one starts.
- **LOS-27** · *engine* — Where its profile names CRDT clients (Appendix A), an
  engine MUST write its own changes under a client id of its own drawn each time it
  starts, never under one a restored state holds.
  *Rationale:* as a device that takes over carried control state decides under a tag
  of its own (ARC-5): two engines under one client id — one state restored twice, or
  restored while its engine wrote on elsewhere — would give two different updates
  the same clock, which the CRDT takes as one, and a gap's position (LOS-25) would
  no longer be one writer's. A new id at each start costs about 10 bytes in every
  state vector for each session that wrote.
- **LOS-17** · *engine* — An engine MUST keep the latest report of each of a
  member's streams (at least four streams per member, dropping the one it heard from
  least recently first, [Appendix B](#appendix-b-recommended-values)), MUST let a
  report replace only one of the same stream with a lower number, and MUST NOT take
  a report of its own stream as anyone's.
  *Rationale:* kept by member, the report of a device that lags behind would replace
  that of the device that deleted, and valid evidence would vanish. An older report
  offered again changes nothing.
- **LOS-18** · *engine* — Evidence that another participant's report (LOS-4, LOS-10,
  LOS-12, LOS-14) shows MUST end only:
  - when the engine's state no longer gives it, judged against its current state;
  - when a newer report of that stream shows nothing;
  - when the engine has applied, whole (LOS-14), an answer of that stream to a
    request it made, or let its own go for (RSY-22), or holds what its last piece
    states, or the stream's state at a higher number (LOS-21): it then holds what
    that answer's last piece states. That answer covers the state up to its number
    and later reports of that same state, not any newer state of the stream: no
    report it covers is evidence of a difference in digests, whichever arrived
    first.

  Evidence of LOS-12 also lapses as LOS-12 says. Evidence that does not end rests
  once its tries ran out (LOS-6) and is woken as LOS-26 says. Evidence of the
  engine's own state, a pending gap (LOS-2), ends only when the gap does.
  *Rationale:* a whole answer, or one whose last piece's state it held, is the one
  way a receiver knows it holds a sender's state although its own digest differs —
  by deletions of its own the sender had not seen —, so it ends that false alarm
  without a second request. Its number orders
  it among its stream's reports however they arrive (LOS-13): one that comes after a
  newer report covers that report only where it states the same. Where it holds a
  stream's state at a higher number — every insertion that vector counts, and the
  same deletions within it —, nothing of an answer numbered in between is missing
  here, since a stream's state only grows: ending that answer's evidence, of a
  missing piece or of control state, loses nothing, and only a false alarm and its
  request go. Evidence nobody reachable can heal does not end by being asked about:
  it rests until it is woken (LOS-26).

**State digests.** A state vector counts what a sender inserted, not what it
deleted, and a control clock says how late the latest decision is, not what was
decided; so reports carry digests beside them (LOS-12).

- **LOS-24** · *engine* — A **digest** MUST be the first 8 bytes of SHA-256 (FIPS
  180-4) of its input, written as 16 lowercase hex digits, where:
  - the *state digest*'s input is the profile's encoding of what the sender deleted
    (PRF-1, item 8);
  - the *control digest*'s input is the object holding exactly the sender's `closed`
    flag and its `targets` (§7.5), `{"closed": …, "targets": {…}}`, each register
    exactly its `value`, `clock` and `device` — without `profile` and extension
    fields —, canonicalized by RFC 8785 (JSON Canonicalization Scheme) and encoded
    as UTF-8.

  *Rationale:* a receiver compares a digest another implementation computed with its
  own, so both must digest the same bytes, and only what both hold — the registers
  and the close. Eight bytes keep every report small; two different states share a
  digest only by chance, and then a difference goes unseen until either state
  changes.
- **LOS-12** · *engine* — An engine MUST treat as evidence:
  - (*diverged*) a report (LOS-13) whose state vector its own holds — every update
    it counts, the vectors equal or the engine's ahead — and whose state digest
    differs from the digest (LOS-24) of what the engine deleted of the items that
    state vector counts (PRF-1, item 8). It is judged first when the engine can
    compare the two: as it hears the report, or once it holds every update the
    report's vector counts. A report that did not differ then is no such evidence.
  - a report (LOS-13) of a device of the creator whose control clock equals the
    greatest clock among the registers the engine holds and whose control digest
    differs from the engine's own (LOS-24).

  It MUST judge each against its current state, so that it disappears once the
  digests agree, and wait for it as LOS-1 says. Of the creator, each stream's latest
  report that states control state is judged — the last piece of an answer states
  none —; a `control` frame is evidence of neither kind (LOS-10). Evidence of either
  kind ends as LOS-18 says, and a report the engine holds by a whole answer is none
  (LOS-18). Evidence of either kind MUST also **lapse** once the report's stream has
  not been **heard** for longer than the absence of RSY-1, as [Appendix
  B](#appendix-b-recommended-values) recommends: a stream is heard when a frame that
  names it — a `heartbeat`, a `resync-request`, a piece of a `resync-response` —
  brings a number above every one the engine heard of that stream (LOS-13); a frame
  offered again or an older one is not, and `edit` and `control` frames name no
  stream. Lapsed, it is no evidence and asks nothing, and no request made meanwhile
  is a try of it (LOS-6); only a newer report of that stream that still differs
  brings it back (LOS-17), as the gap it was, with its time and the tries it had,
  and that report wakes it as a frame that raises its position does (LOS-26). No
  other evidence lapses.
  *Rationale:* a lost deletion, a lost close, or a register lost under a clock no
  greater than one received, leave vector and clock equal; the digest is what
  differs then. Compared only at equal clocks, it leaves out a sender whose clock
  lags; after a decision, the report that ends its device's phase follows (SND-11).
  A sender cannot have deleted what it never held, so a receiver that holds more
  compares only what the sender's vector counts, and a lost deletion shows although
  the receiver edited since; while it lacks an insertion the sender counts, the
  vectors show that first (LOS-4). Judged once, a report raises no alarm for what
  the receiver deletes later. A deletion of the receiver's own the sender had not
  yet received makes the digests differ too: a false alarm, which a whole answer of
  that stream ends, or its next report, which a request stating what it holds brings
  at once (SND-24). A difference in digests cannot say which side lacks something,
  and the report of a stream that no longer runs — an earlier run of its device,
  read late — would show it for good; so it lapses with its stream's silence, and a
  stream that runs reports again after each phase of its own writing (SND-11), which
  brings back what still differs. A frame offered again says nothing new of its
  stream, so it keeps nothing alive; and back with the tries it had, a stream that
  falls silent and reports again, time after time, earns no new tries each time.
  What lapses is only what a digest shows: a missing update, a higher control clock
  or a missing piece says which side lacks what.

### 10.4 A history the bridge cut short

- **LOS-8** · *engine* — An engine whose transport does not offer `receiveSince`
  MUST treat as evidence (*history truncated*):
  - a `receive` answer that shares no delivery with the previous non-empty answer it
    processed — everything it had seen has left the bridge's window, so deliveries
    may have come and gone unseen in between;
  - the first `receive` answer after one that failed.

  *Rationale:* a bounded window (BRG-17) can drop an edit *and* the report that
  follows it before an engine reads again; then LOS-2, LOS-4 and LOS-10 stay quiet
  while the document has diverged. What the engine can still see is that the window
  moved past everything it knew — for an engine nobody else writes to, once its own
  report comes back in a read. Overlap proves nothing after a bridge restart, which
  may offer old deliveries again (BRG-17); a restart shows to an engine that polls
  as a failed `receive`, and so does a bridge that could not reach its messenger,
  which costs one answered request when nothing was lost.
- **LOS-9** · *engine* — Where the transport can say what it lost:
  - An engine whose transport offers `receiveSince` MUST read through it, with the
    last `DeliveryId` of the latest answer that held one as the cursor (TRN-18,
    TRN-21). It MUST treat an answer with `truncated: true` as *history truncated*
    evidence, and MUST NOT apply LOS-8's comparison of answers then.
  - An engine whose transport offers `instance` (TRN-19), with or without
    `receiveSince`, MUST treat as such evidence too an `instance` other than the one
    that answered its previous read — after a restart, other than the one its
    application restored with the cursor (LIF-8), where it restored one.

  Either is evidence on its own.
  *Rationale:* where the bridge can say that something slid out unseen, or that it
  restarted, the engine needs no guess, nor a needless request after every outage,
  and a restart between two polls shows. Restored with the cursor, the instance
  carries this across the engine's own restart; read after the deliveries, it shows
  what a bridge gave up while it answered them at this read, before a restored
  member would bootstrap from its own state.
- **LOS-19** · *engine* — Unlike every other evidence of this section, *history
  truncated* evidence (LOS-8, LOS-9, LOS-23) needs no waiting time. An engine SHOULD
  answer it by a resync request with `force: true` (RSY-16) as soon as its request
  slot is free, and the further tries of its gap as LOS-6 says, and MUST report it
  as "not safely synchronised", never as "synchronised", until it has applied an
  answer that carries control state (CTL-25) to its own request sent with `force`
  after the history was last found truncated, or, on a device of the creator, as
  LOS-20 says. An answer with content alone ends it for no one. Each time the engine
  finds its history truncated anew, also while the evidence stands, an answer to a
  request sent before ends nothing; the evidence keeps the time it was first found,
  and its gap its tries: one that rests is not woken by it (LOS-26).
  While the evidence stands, a bridge that answers `truncated` again for the same
  cursor (TRN-18) tells of the same loss.
  *Rationale:* only an answer can end the evidence, and an engine that lacks nothing
  would get none without `force`. It must carry control state: the window may have
  dropped a decision of the creator, which content alone does not bring back. An
  answer to a request sent before, also one sent with `force` for an earlier
  truncation, whether that one still stands or has ended, may have been taken before
  what the window dropped was sent, and nothing in it says when. With nobody online who holds the document, the request
  goes unanswered and the evidence stays.
- **LOS-20** · *engine, application* — For the creator, *history truncated* evidence
  also ends when a request with `all` (RSY-21) it sent after the history was last
  found truncated expired unanswered. What remains is the request's outcome, *unanswered* (RSY-4), which the
  engine MUST keep observable until its next request; an application SHOULD show it,
  and MUST NOT say then that nothing suggests a loss (LOS-15). The creator's copy
  may still lack a change of a member who is offline, until that member sends again
  (LOS-2, LOS-4) or answers a later request.
  *Rationale:* only a request to all reaches the members, and a member answers the
  creator only when it holds something the creator lacks (RSY-6, RSY-17), so silence
  means nothing to recover, or nobody online to recover it from — and the engine
  cannot tell which.

### 10.5 Answers in pieces

- **LOS-14** · *engine* — An answer with every piece, up to the number its last one
  names, is *whole*. An engine MUST count, by stream and number (LOS-13), the pieces
  of each answer to its own request it applies; a piece MUST count once by its
  number, however often it arrives. It MUST treat as evidence (*answer incomplete*)
  an answer of which a piece is missing (its last piece arrived and one of a lower
  number did not, or pieces arrived and its last did not), once no piece of it has
  arrived for the engine's floor (SND-16) plus the waiting time of LOS-1, unless the
  engine holds what the last piece states anyway (LOS-4, LOS-12). It MUST make that
  evidence observable, and an answer that lacks a piece observable at once, as a
  transfer under way; it SHOULD answer the evidence as LOS-6 says.
  *Rationale:* a bootstrap completes with the piece that carries the snapshot
  (RSY-14), which may arrive first; and a receiver that holds more than the
  responder cannot tell from a vector or a digest whether the rest arrived, since a
  missing piece may carry only deletions. Numbered pieces say it exactly, for the
  cost of a count. The receiver waits as long as one more piece would take at the
  pace it shares with the responder.
- **LOS-21** · *engine* — An engine MUST keep each answer it counts (LOS-14) by its
  sender, stream and number, bound to the request it answers, apart from every other
  answer and from the reports it keeps (LOS-17): a piece of another answer — of the
  same stream or another, to its own request or anyone's — ends nothing of it, and
  neither does dropping its stream's report. Its evidence MUST end only:
  - when the answer is whole;
  - when the engine holds what its last piece states;
  - or when it holds the state of that stream at a higher number: by a report of the
    stream it held when it could first compare it (LOS-12), or by a whole answer of
    the stream.

  *Rationale:* two answers of one stream are two transfers, and they overlap: a
  responder answers whoever asks, and a later answer may go to someone else and
  never be whole here. Within a stream the state only grows, so a later answer held
  whole, or a later report held, says the engine holds the earlier one's state too;
  a piece that is not the last states nothing.
- **LOS-22** · *engine* — An answer whose pieces disagree — on the request they
  answer, on the count or on the state the last one states, or with a piece numbered
  above the count — MUST NOT be taken as whole, and its evidence MUST end only by a
  higher number of its stream. An engine MAY bound the answers it counts at once and
  the piece numbers it counts; an answer it gives up for the bound MUST stay
  evidence until the engine holds the state of its stream at its number or a higher
  one, and one with a piece numbered above the bound is never whole.
  *Rationale:* where an answer's pieces disagree, the engine cannot tell which of
  them states the answer; only its stream's later word can. A bound on what is
  counted keeps memory finite without letting evidence vanish: giving an answer up
  costs the chance to see it whole, not the warning.

### 10.6 What loss detection cannot notice

*Informative.* A loss may leave no evidence, or evidence that rests before the loss
heals (LOS-6, LOS-25). Closing it takes three steps, and TDSP promises none of them
by a time: the first and the last wait for a message that may not come.

1. **It can be detected** once the receiver gets a message that shows it: an update
   that builds on what was lost, which then waits for it (a pending gap, LOS-2); a
   report of someone who applied it, whose state vector counts it (LOS-4) or, over
   the same insertions, whose state digest differs (LOS-12); or, for a decision, a
   report of a device of the creator that holds it (LOS-10, LOS-12) — not a
   `control` frame. An edit that does not build on what was lost shows nothing. Most
   often no detection is needed: the report after a phase carries its last edit
   again (SND-27).
2. **A resync is requested** once that evidence has lasted its waiting time, within
   the tries of its gap (LOS-6), unless the application switched them off.
3. **The state is restored** once an answer that holds what was lost arrives whole
   and is applied: to that request, from a responder it reaches who is online and
   holds it ([§8.3](#83-who-answers)) — or an answer to another's request to all for
   which the engine let its own go (RSY-22), or, by chance, the creator's answer to
   another's.

Control state has a narrower limit: evidence of it judges only the clocks a device
of the creator states in its reports (LOS-10, LOS-12), never in its `control`
frames; a member states its control clock only in a request (RSY-16), which is
evidence of control state for no one. The cases below are instances of these steps
and limits, not occasions for rules of their own:

- **Before the first answer.** LOS-8 notices a window that moved on only against a
  previous answer, so a truncation between an engine's start and its first `receive`
  is covered by the joiner's bootstrap instead (RSY-1).
- **A bridge restart between two polls** whose new window overlaps the previous
  answer — possible where an application polls rarely, as a browser does in a
  background tab — is not noticed, unless the transport offers `instance` (LOS-9).
- **Nobody to ask.** A resync heals only while someone who holds what is missing is
  online and answers (RSY-6, RSY-21); a message that reached *nobody* comes back
  only from its author. The creator's truncated history ends with a request to all
  nobody answered (LOS-20), and her copy may still lack a change of a member who is
  offline.
- **An answer only the others heard.** Members waiting for their turn fall silent
  once they heard an answer that holds what they would give (RSY-20), whether or not
  it reached the requester. One lost on the way to the requester alone leaves it to
  ask again where it still asks (RSY-5, LOS-6), a return once more (RSY-21); where
  that answer is lost as well, what such a member holds shows only by a later
  message of it (step 1). An answer of which only some pieces arrive is evidence
  (LOS-14).
- **An answer heard before a later update.** A member asked by all judges an
  answer as heard (RSY-20): an update reaching it afterwards is in no answer it
  heard, and the requester gets it only once a later message of someone who holds it
  shows it (step 1). Judged anew, any later change would have members answer.
- **A request the creator or one's own member answered.** The first request of a
  bootstrap asks only the creator's devices and the requester's own (RSY-6, RSY-21),
  and their answer ends the bootstrap (CTL-13, RSY-14). What the answering device
  lacks — a change that reached members only — the requester lacks too; it shows
  only once a later message of a member that holds it shows it (step 1).
- **A register only members hold** — a decision of a lost device of the creator
  that reached none of her other devices — shows only once a later decision of hers
  brings the clocks level, at a request and an answer per such decision
  ([§15.4](#154-what-is-not-guaranteed), "Rights beyond the creator's devices").
- **A request read late.** Frames carry no time of sending, and clocks may be off
  (§1.1), so no clock tells how long a request waited. A responder that reads it
  late judges it by its stream: only its latest request counts (RSY-9), answered
  only where the furthest its stream stated since still lacks something (RSY-17); a
  stream that stated nothing since is answered with what it may hold already — a
  message, nothing lost. An engine lets no request it read as it caught up stand in
  for its own (RSY-22).
- **Automatic requests switched off** (RSY-5): an engine keeps its evidence until
  its person asks or a request that goes all the same does; its gaps stay until
  they heal.
- **A resting gap** is woken by a frame that raises its position, or by a frame of
  the member it names as the writer, at most once in 10 minutes (LOS-26); a change
  whose author never returns and that nobody else holds stays missing, and its gap
  stays shown while the engine runs (LOS-25).
- **A lost last change and its report.** A last change whose report was lost too, or
  did not carry it (SND-27), shows by that report's state vector where the report
  arrived (LOS-4). Its sender opening the document again is an opportunity to
  heal it, no promise, in three cases only: a report still owed (SND-28), which goes
  even where the device may no longer write; stored content, which a device that
  may still write sends whole (SND-8); or a start request (RSY-1), which shows what
  the device holds, so that a receiver that lacks the change asks all and the device
  answers, read-only or closed too (RSY-10). A report the transport accepted is owed
  no longer (TRN-10). Otherwise the change shows once a later message of its sender
  builds on it (step 1), or once someone synchronises now (LIF-12).
- **A lost decision** shows only by a report, not by its `control` frame; what that
  leaves unseen, and when a restart helps, [§15.4](#154-what-is-not-guaranteed)
  says ("Evidence of a lost decision").
- **A long outage its application cannot see** — a bridge answered its reads from
  its window while it could not reach its messenger —, or one on a transport whose
  retention the application does not know, brings no return (RSY-21, LIF-12): what
  the messenger no longer held shows only where the bridge can tell (TRN-18,
  TRN-19), or by a later message of a member that wrote then (step 1).
- **A wall clock set forward.** A clock that does not run back (SND-25) may still
  count a jump of the wall clock forward as time that passed. A correction forward
  by more than the age an engine keeps its own requests (RSY-12) can make it forget
  one early; an answer that comes after is one to a request it did not make, whose
  last piece still shows what the engine lacks (LOS-4), and it asks again (LOS-6).
- **What waits for missing predecessors** beyond the bound is given up (LOS-23): an
  update that only its writer holds comes back only when the writer sends again or
  answers a request.
- **Two devices of the creator at once.** A report whose control clock lags is left
  out of the comparison (LOS-10, LOS-12), so a decision lost under a clock below
  another device's later decision that the receiver holds shows by neither device's
  report until one of them holds both; the one that merges the other's then reports
  at once (SND-11).
- **Deletions.** An update that only deleted is held by every state vector: its loss
  shows by the digest only once the receiver holds every insertion the report counts
  (LOS-12), and the report after its phase carries it again where it was the last
  change (SND-27).
- **An ambiguous difference** in digests (LOS-12) lapses once its stream falls
  silent: a real one stays unseen until that stream reports again and still differs.
  One who writes on without a pause sends only `edit` frames, which name no stream,
  so theirs may lapse meanwhile; the report that ends their phase brings it back
  (SND-11). A false one, of a report
  that crossed a deletion the receiver holds, lasts until its stream reports again —
  at once on a request that states what it holds (SND-24) — or answers the receiver
  whole (LOS-18); of a stream that will not run again, only the lapse ends it. How
  long the silence must last is recommended, not required (Appendix B).
- **A missed close.** A member that lost the close, the close its device sent again
  as its phase ended (SND-27) and the report after it, whose control clock or digest
  showed the close (LOS-10, LOS-12), writes on; a device of the creator that holds
  the close and reads its edit sends the close again (LIF-11). With no device of the
  creator online, nobody does until the member asks or one of them comes back
  ([§15.4](#154-what-is-not-guaranteed)).
- **Many engines of one member.** An engine keeps the reports of a bounded number of
  streams per member (LOS-17): a member running more engines at once than that can
  have one stream's evidence dropped — not that of an answer it counts (LOS-21).
- **A responder that stops** before its last piece leaves its answer evidence while
  its stream does not run: another stream of the member says nothing of what this
  one sent (LOS-21).

1.x's LOS-3 and LOS-5 are withdrawn ([Appendix
G](#appendix-g-changes-from-tdsp-1x)). LOS-11 and LOS-16, requirements of an
earlier draft of 2.0, are withdrawn: no frame promises a follow-up, so
silence is evidence of nothing ([CHANGELOG.md](CHANGELOG.md)).

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
  tell them from anyone else, never only by a name the creator chose, such as the
  display name of a profile:
  - by an identifier the messenger keeps unique — the MemberId, or a phone number,
    user name or address the messenger binds to it;
  - or by a name the person gave that identity themselves.

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

- **INV-10** · *application* — An application that expresses an invitation as a
  URL query — or as a URL fragment (INV-8) — MUST use this form: the query or
  fragment is `application/x-www-form-urlencoded` as the WHATWG URL standard
  defines it (what `URLSearchParams` reads and writes), every value is UTF-8, and
  it carries the invitation in the parameters of the table below.
  *Rationale:* so that one application can open another's invitations.

| Parameter | Field | Required | Value |
|---|---|---|---|
| `tdsp` | invitation version | yes | `2` |
| `provider` | messenger | yes | the binding's name: lowercase letters, digits, `.` and `-`, 1–64 characters, the first a letter or a digit |
| `documentId` | documentId | yes | 1–255 UTF-8 bytes |
| `creatorMemberId` | creatorMemberId | yes | 1–255 UTF-8 bytes |
| `channelId` | channel id | every binding but email | 1–255 UTF-8 bytes |
| `threadRoot` | thread root `Message-ID` | email | the email binding's `Message-ID` form, at most 200 characters in all ([email binding](bindings/email.md)) |
| `recipients` | every participant's address, the creator's included | email | 1–64 addresses, comma-separated, distinct in lower case; each a local part of 1–64 and a domain of 1–189 UTF-16 code units joined by `@`, neither holding `,`, `@` or white space (ECMAScript's `\s`); a reader does not check that the creator is among them |
| `pgp` | PGP is on | email, optional | `1` |
| `profile` | profile | yes | a profile id ([§5](#5-document-profiles)) |

This specification, in this version and every later one, defines parameter names
without a `.` only. A parameter whose name contains a `.` therefore never
collides with one it defines: an application that names its own parameters that
way, under a domain its author controls (`com.example.title`), keeps them apart
from every later addition, as a profile or layer id from outside this
specification is kept apart ([§5.5](#55-profiles-defined-outside-this-specification),
[§5.6](#56-layers)).

A `provider` the table does not name is read as Signal and Matrix are: it
requires `channelId`. A parameter of the table that the link's binding does not
require is still checked for its range where present and read into the
invitation.

- **INV-6** · *application* — A reader:
  - MUST refuse an invitation in which a parameter of the table above appears more
    than once, a required one is missing or empty, or a value is outside its range;
  - MUST ignore parameters the table does not define — 1.x's `policy` among them;
  - MUST treat a missing or other `tdsp` as an invitation it cannot read.

  A refused link has the first of these problems that applies, in this order:
  `repeated-field`, a parameter of the table appears more than once;
  `not-an-invitation`, neither `tdsp` nor `documentId` is present — an ordinary
  page load, not an invitation; `unsupported-version`, `tdsp` is missing or other;
  `missing-field`, `provider`, `documentId`, `creatorMemberId` or `profile` is
  missing or empty; `invalid-field`, a value present is outside its range, an
  empty one included; `missing-field`, a parameter the link's binding requires is
  missing.

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
encrypted block ([email binding](bindings/email.md)); a join whose link disagrees
with the block is refused (EML-5).

## 12. Bridges

What every bridge must do is a document of its own,
[bindings/bridges.md](bindings/bridges.md), with the requirements TDSP 1.x had
here (BRG-1 to BRG-17) and one new one (BRG-18); the optional local bridge
interface is [bindings/local-bridge-interface.md](bindings/local-bridge-interface.md)
(LBI-1 to LBI-6). An engine implementer needs neither.

## 13. Messenger bindings

Each messenger binding is a document of its own:
[Signal](bindings/signal.md) (SIG), [Matrix](bindings/matrix.md) (MTX) and
[email](bindings/email.md) (EML). The common envelope and BND-1 to BND-4 are in
[bindings/bridges.md](bindings/bridges.md), with a comparison of the bindings. A
binding states its transport profile — the bounds and the suggested pacing
([§3.5](#35-transport-profile)) — and carries frames of this specification
unchanged; its envelope keeps its own version (`"tdsp": 1`,
[§2.2](#22-two-wrappers-two-readers)).

## 14. Versioning and extensibility

Four things on the wire carry a version, deliberately separate:

| What | Where | Changes when |
|---|---|---|
| The frame format | `tdsp` in every frame ([§4](#4-the-payload-frame)) | A frame field or a kind's meaning changes incompatibly |
| The invitation link | `tdsp` in every invitation ([§11.3](#113-invitation-as-a-link)) | A parameter's meaning changes incompatibly |
| The envelope | `tdsp` in every envelope ([§13.1](bindings/bridges.md#131-the-common-envelope)) | An envelope field's meaning changes incompatibly |
| A document profile | The major version in its id ([§5](#5-document-profiles)) | What the profile's bytes mean changes incompatibly |

The frame format and the invitation are 2 in TDSP 2.0; the envelope and the one
profile this specification defines stay 1, because neither changed. The
documents carry versions of their own: the core, the bindings and the local
bridge interface ([bindings/](bindings/)) each have one in their header, which
changes with what the document requires — how a binding carries a frame, say. A
binding names the core versions whose frames it carries, and a change to one
document needs no new version of another.

The parts of TDSP 2.0, their versions, and which of them are stable:

| Part | Version | Status |
|---|---|---|
| Core (this document) | 2.0; frames and invitations `tdsp` 2 | Stable |
| Profile `yjs-paragraphs/1` ([Appendix A](#appendix-a-profile-yjs-paragraphs1)) | 1; Yjs update encoding version 1, by Yjs 13.6.33 | Stable |
| Bridges and the envelope ([bridges.md](bindings/bridges.md)) | Bindings 2.0; envelope `tdsp` 1 | Stable |
| Signal binding ([signal.md](bindings/signal.md)) | Bindings 2.0 | Stable |
| Matrix binding ([matrix.md](bindings/matrix.md)) | Bindings 2.0; `EncryptedFile` v2 of the Matrix Client-Server API v1.19 | Stable |
| Email binding ([email.md](bindings/email.md)) | Bindings 2.0 | Stable, but for the layout of a mail, which stays a draft: an incompatible change of the layout increments the email binding's version, and until the layout is specified, email bridges interoperate only within one release of this repository |
| Local bridge interface ([local-bridge-interface.md](bindings/local-bridge-interface.md)) | Bindings 2.0 | Draft; optional. An incompatible change increments its version, and until it is stable, adapters and bridges interoperate only within one release of this repository |
| The wire's test vectors ([§3.6](#36-conformance-suite)): frames, invitations, control | `frames-v2.json`, `invitations-v2.json`, `control-v2.json`; `tdsp` 2 | Stable and in the wire lock |
| Behaviour vectors ([§3.6](#36-conformance-suite)): clock, digests, updates, flows | `clock-v2.json`, `digests-v2.json`, `updates-v2.json`, `flows-v2.json` | Informative and not in the wire lock |

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
  field (FRM-9) is not such a value, nor an application's reason for the close
  named as CTL-23 says: their names keep them apart.
  *Rationale:* two implementations inventing the same value for different meanings
  cannot be told apart on the wire.
- **VER-3** · *engine, application* — An engine MUST write `2` in every frame's
  and every invitation's `tdsp` (FRM-2, [§11.3](#113-invitation-as-a-link)). The
  drafts of 2.0 wrote a draft marker there instead, the last of them
  `de.wappensc.together.tdsp.probe.draft-10`; a frame or an invitation under such
  a marker is of another version (`unsupported-version`). An engine MUST persist
  its control state (CTL-26, CTL-39) with `2` in its `tdsp`, and MUST read control
  state persisted under a draft marker, or under none, as none: a device of the
  creator then starts as a new device (CTL-27), anyone else waits for an answer
  (RSY-14).
  *Rationale:* no draft wrote `2`, so no draft frame passes for 2.0; a marker that
  is not a number made every 1.x engine refuse a draft frame loudly (VER-1), as a
  2.0 engine does. A persisted state is as much its version's own as a frame: the
  frames of a draft's document are refused, so its control state would govern a
  document nobody can continue, and its registers or its bootstrap may mean
  something else. Read as none, a draft's document is continued as a new one
  ([§6.2](#62-creating-a-document)), as a document of any other version is.
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
  value grants — on a layer, for every permission on the document —, its place in
  the order CTL-23 uses at a tie, before every value that grants all of its
  capabilities and more, and that a revoked permission on the document leaves no
  right on any layer (LAY-5). A later minor revision MAY define further codes for
  the reason for the close (CTL-23), without a new marker or version (VER-1): an
  engine of this revision takes a code it does not know, and its application shows
  the close without a known reason.
  *Rationale:* of two decisions the later holds, wider or not (CTL-22), so values
  need no merge, only a total order for a tie, which every receiver must apply
  alike. A tie means one device decided twice at one clock — a state put back from
  a backup, a copy under one tag —, so whichever value holds was one of that
  device's decisions; ordered by what each grants where two values compare, the tie
  grants no more than either did. In this version the values compare (revoked,
  `read`, `write`; `read`, inherit, `write` on a layer). A later right may not:
  "comment only" and "edit the text but not comment" each withhold what the other
  grants, and the order then only has to be the same everywhere. Capabilities say
  what a value grants on the document and on each layer, whatever the permission on
  the document, which its name alone does not. A reason for the close grants
  nothing: a code a receiver does not know costs its person the reason, not the
  close.
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
of this specification (or, for a profile, a layer or an extension, its own
definition: PRF-7, LAY-4, FRM-12) that states why older implementations are
unaffected. An extension that older engines must not ignore is named in `crit`
(FRM-10).

## 15. Security considerations

### 15.1 What a messenger must provide

A messenger is suitable for TDSP if and only if it offers all of these:

| Requirement | Why |
|---|---|
| Carry an opaque payload between the members of a channel | The payload is a frame the messenger must not need to understand |
| Accept a message for every member of the channel, and deliver it to them in the normal case | There is no server to fan out. A message lost now and then is recovered by TDSP ([§10](#10-loss-detection)); a messenger that routinely loses messages makes that recovery the normal path |
| An authenticated sender per message | Every authority check compares the sender against the creator |
| A stable, unique message identifier | De-duplication depends on it |
| A known maximum message size, of at least 4 MiB per frame, attachments included (TRN-23) | The scheduler must split what does not fit, and an answer must carry the control state whole (SND-18) |
| Immutable delivered messages, or a bridge that makes them so | An applied update cannot be retracted |

A binding that lacks one of these is not a TDSP binding. In particular, email
without PGP has no sender authentication (EML-9): it is an experimental mode,
not a conformant binding. Email with PGP authenticates a sender as the holder of
the key the creator's invitation pinned; that the key belongs to the person
named is established only by a fingerprint compared outside TDSP (EML-8,
EML-13). Matrix in a plain room authenticates a sender only as far as the
homeserver is trusted, and protects nothing against it. In an encrypted room it
authenticates the sender's account by the device the account's identity signed,
and adds integrity and confidentiality against the homeserver — as far as every
bridge shares room keys only with devices their owners signed and accepts frames
only from them (MTX-4), and ignores TDSP events that arrive unencrypted (MTX-5).
That protects against a device the homeserver adds to an account, not against an
identity it puts in place of the account's: the homeserver can reset an account's
identity, and the identity a bridge meets on first contact is its word. Against
that holds only an identity a bridge remembered and holds to until a person agrees
to another (MTX-4, a SHOULD), or one a person verified outside TDSP
([§13.3](bindings/matrix.md#133-matrix)). A device's signature confirms no person.

Not required: history, ordering, exactly-once delivery, per-message access
control, server-enforced membership, or any notion of a document.
Confidentiality is not on the list because TDSP *functions* without it — but
it is only *worth using* with it.

### 15.2 What TDSP assumes

1. **Participants cooperate** ([§1.1](#11-what-tdsp-is)). They
   run genuine software rather than a modified engine that speaks the same wire
   format, and each is responsible for the channel they take part in. A genuine
   engine still rejects a control frame that does not come from the creator, but
   applies a modified engine's edits (CTL-7) and merges the control state its
   answers carry (CTL-25): such an engine can write what its permission forbids, or
   after a close, and hand on rights or a close the creator never decided
   ([§15.4](#154-what-is-not-guaranteed)).
2. **The local machine is trusted**, including every process running as the same
   user.
3. **The messenger is trusted for what it reports**: senders, channel membership and
   encryption state are taken as ground truth. Even a messenger with strong
   end-to-end encryption could misreport a sender, and TDSP would not notice.
4. **A service that carries a document between one person's devices** (ARC-5) is
   trusted as that person's machine is (INV-9): whoever can write there can hand
   the person's other devices a creator to obey, the creator's control state, and a
   binding to a channel the person never chose, into which the device then sends
   what the person writes — a loss of confidentiality, not only of authority.
5. **Who takes part is the channel's**, as the messenger enforces it
   ([§6.6](#66-who-takes-part)): whoever it admits receives every frame, whoever it
   removes receives nothing new. TDSP enforces no membership of its own;
   applications keep rights in step with the channel (LIF-9, LIF-10), and where the
   channel cannot remove a revoked member, nothing does
   ([§15.4](#154-what-is-not-guaranteed)).

### 15.3 What TDSP enforces itself

| Concern | Mechanism | Worth |
|---|---|---|
| Permissions | The creator grants and revokes; each engine but a device of the creator refuses to send an edit before its bootstrap, and each refuses one while its own permission is `read` or revoked, in a capacity conflict, and once the document is closed — also when its permission is unknown after the bootstrap, which counts as `read` (CTL-13, CTL-32) | Among cooperating engines only, and only while their applications keep what the engine refuses out of the engine's document, which a resync answer carries whole (CTL-42, RSY-10); receivers do not reject an edit for its sender's permission (CTL-7) |
| Rights on layers | The creator sets a member's right on a layer, or lets it inherit the permission on the document; each engine refuses to send a change of a layer on which its permission is `read`, of any layer once its permission on the document is revoked, and a change that touches such a layer whole (LAY-5, LAY-6, LAY-7) | As for permissions: among cooperating engines only; `read` hides nothing, every participant reads every layer it receives |
| Creator identity | Fixed; `control` frames only from it (CTL-5); the snapshot of an answer is what its sender holds of the creator's decisions, merged as such (CTL-25); only her devices bootstrap a device of the creator (RSY-14, CTL-46), and once bootstrapped it merges members' answers as any device does (CTL-25, RSY-12); device tags tell its devices apart and authenticate nothing | Exactly as strong as the messenger's sender authentication, among cooperating participants (§15.2); a snapshot carried between the creator's devices (ARC-5) as strong as the service that carries it |
| Replay of control frames | Control state is registers ([§7.1](#71-what-control-state-is), CTL-22) | A replayed register changes nothing (CTL-6) |
| Close | Cooperating engines stop sending edits of their own; edits sent before the close still arrive and apply (LIF-6) | Among cooperating engines only, and only while their applications keep a change made after the close out of the engine's document (CTL-42) — a modified engine can keep sending edits, which genuine engines apply, exactly as with `read` (CTL-7) |
| Convergence | The CRDT | Unconditional, given the same set of updates — not given a lost one |
| Message immutability | Bridges refuse and record edits and withdrawals (BRG-12); in a room once seen encrypted, a Matrix bridge takes no unencrypted event at all (MTX-5) | Where the messenger reveals them, and after a bridge's restart under the ids it kept; the sender of a Matrix redaction is the homeserver's word (MTX-5) |
| No external connection | ARC-2, BRG-4; an application that carries a document between one person's devices also reaches that service (ARC-5) | As strong as its enforcement; see below |
| Resource exhaustion | Bounded control state (CTL-30), and a capacity conflict beyond its bytes or its targets (CTL-32); bounded nesting and frame size, extensions included (FRM-11), bounded attachment fetches (BRG-14), bounded pre-verification reads (BRG-13); what is held for missing predecessors bounded (LOS-23); no reassembly buffer | Bounded, not prevented; beyond the bytes or the targets of control state a person resolves the conflict |

**Enforcing "no external connection".** The one security property TDSP owns
rather than inherits is only as good as the checks behind it, and no single check
sees everything.

- **SEC-1** · *all* — An implementation SHOULD combine several checks of "no
  external connection" (ARC-2, BRG-4) that fail independently, such as those
  below.
  *Rationale:* each check misses what another sees: a source scan does not read
  third-party code, a runtime guard sees only what the tests run, and egress
  blocking only the machine and the run it guards.

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
   connections to the loopback interface only — and, where it carries documents
   between one person's devices, to that service (ARC-5).
5. **A test run with operating-system-level egress blocking**, which also catches
   native modules no language-level guard can see.

The reference implementation uses all five.

### 15.4 What is not guaranteed

- **Confidentiality beyond the channel's own.** If the channel is not end-to-end
  encrypted, neither is the document. Each participant can check the channel's
  encryption in their own messenger client, independently of what TDSP shows. A
  copy an application carries between one person's devices through another
  service (ARC-5) is as confidential as that service makes it.
- **Protection against a participant whose software ignores this
  specification**, a compromised application or device, traffic analysis, or
  exfiltration from a participant's machine. Such a participant can spoil content
  and control state for everyone — write what its permission forbids, set rights,
  close the document — and TDSP neither prevents nor detects it; the way out is to
  remove it from the channel and continue in a new document (§6.2, LIF-9).
- **One document for all participants.** A participant whose software ignores
  this specification can give different participants different content under one
  CRDT identifier; their documents then differ for good, and neither the state
  vector, nor the state digest, nor loss detection shows it.
- **Availability** against someone who can drop messages — they can drop the resync
  too — or of decisions while the creator is offline: any member can bring a new
  device up then — a new device of the creator excepted (CTL-46) —, but nobody can
  be granted anything. A joiner whose reachable devices are all in a capacity
  conflict waits for a device of the creator that is not, for good where hers are
  in it too (CTL-32); her person, who sees the conflict, continues in a new
  document.
- **Convergence beyond the bounds of control state.** Devices of the creator that
  grow apart beyond what a receiver holds leave a capacity conflict, which a person
  resolves (CTL-32), not a merged state.
- **A bootstrap beyond what one answer carries.** Every transport carries at least
  4 MiB (TRN-23), and an answer carries a control state at its bound beside the
  responder's state vector, which grows with every session that wrote (LOS-27):
  roughly 75 000 such sessions at 4 MiB, an estimate whose assumptions §7.4 states,
  where the bytes of the whole frame as encoded decide. Beyond it no answer carries
  the control state, nobody new is bootstrapped, and no state of the protocol says
  so; a device of the creator then decides nothing but a close without a reason
  (CTL-37).
- **Which of two concurrent decisions holds**: the later by the deciding devices'
  clocks, which may be wrong; the narrower is not preferred (CTL-22).
- **Rights beyond the creator's devices.** The creator's devices hold the
  document's rights (CTL-46). A creator who loses every device and every backup
  closes the document and continues in a new one, on the content the members hold.
  A decision of a lost device of hers that reached only members stays with them; a
  member that holds such a register sees the difference only once a later decision
  of the creator brings the clocks level, and asks once for each later decision: a
  request and an answer per decision, where a content gap's cost is bounded to a
  request in 10 minutes (LOS-26). Only a new decision on that target, or that
  member's answer to a request of a device of the creator, heals it, and the member
  passes the register on to every device it answers. What a device of the creator
  merged from a member's answer goes on only by its report, a later request, a start
  request or its return (SND-11, RSY-1, RSY-21).
- **Evidence of a lost decision.** Control state is judged only by reports, never
  by `control` frames (LOS-10, LOS-12). A lost decision shows only with the report
  that ends its device's phase, once that device pauses (a report delay after its
  last edit or decision; SND-11, 10 s recommended).
  Where the decision, its repeat and that report are all lost at a receiver, the
  decision stays there without evidence until a later report or a request makes
  the control state known, or an answer brings the missing registers; a restart
  creates that opportunity only where such an exchange actually falls due with it —
  a report owed (SND-28) or a start request (RSY-1) —, and stored content sent again
  carries no rights. A difference in digests lapses once its stream falls silent
  (LOS-12), so a real one of a silent stream stays unseen until that stream reports
  again; how long the silence must last is recommended (Appendix B), not required.
- **A close a member missed.** A member that lost the close, its repeat and the
  report after them (SND-27), while no device of the creator is online, writes on
  until it asks or hears the close again (LIF-11); everyone takes its edits (LIF-6),
  so a document closed as `continued` may still change.
- **Completeness without evidence.** A copy with no loss evidence may still lack a
  change: one no engine saw a trace of ([§10.6](#106-what-loss-detection-cannot-notice)),
  one held only by a member offline when the creator asked (LOS-20), or whose
  answers to both of a return's requests were lost (RSY-21); a last change whose
  report was lost too, for which its device opening the document again is an
  opportunity, not a promise, and only where the report was still owed (SND-28) —
  not once the transport accepted it, however it fared (TRN-10) —, the device still
  writes and sends its stored content, or a start request falls due (RSY-1); and
  what a resting gap lacks, until it is woken (LOS-26).
- **A revocation where the channel cannot remove the member.** Where the channel
  cannot remove a revoked member — under a binding that offers no removal, or an
  application that does not administer the channel — a concurrent grant may undo
  a revocation (CTL-22), and nothing else stops that member (LIF-9, LIF-10).
- **Authorship.** Attribution is a display convenience (ATR-3).
- **Deletion** of content from participants' devices.
- **Metadata protection.** Who talks to whom, when and how much is as visible as the
  messenger makes it; the documentId is visible to the messenger and to every
  channel member.
- **Portability** of a document between messengers: bindings are messenger-specific
  state.

### 15.5 Specific threats

- **A forged or careless pace** can make a document slow, though no slower than
  the bound each engine sets on the pace it runs (SND-15; 10 minutes recommended).
  It can never make an engine exceed its own provider's limits (SND-15), and it
  comes from the creator alone: whoever can forge the creator can close the
  document. Nothing else about pacing is shared.
- **A clock far ahead.** A device of the creator whose clock runs ahead wins
  concurrent decisions until the others catch up (CTL-22). A register far in the
  future — from a broken application of the creator, which members pass on as any
  register (CTL-25), or from a participant whose software ignores this
  specification ([§15.4](#154-what-is-not-guaranteed)) — holds until a decision on
  its target made in knowledge of it, which takes a clock above it (CTL-21,
  CTL-45); no receiver sets it aside (CTL-45), and no device's own clock runs more
  than a day ahead for it. At the end of the range no decision on that target is
  possible; the person continues in a new document (§6.2).
- **Many device tags and targets**: the creator's account can name tags and
  targets at will; CTL-30 bounds what a receiver holds, and refuses and reports the
  rest.
- **Updates whose predecessors never come** — the rest lost, or sent by software
  that ignores this specification —: LOS-23 bounds what a receiver holds of them,
  and gives it up as a truncated history, which costs a forced resync; no answer
  passes them on (Appendix A).
- **Extension fields** (FRM-9): a sender can ship bytes a receiver ignores, as it
  already could in a `decline`'s text; they count against `maxBytes` and the
  nesting limit (FRM-11), and nothing an extension carries is applied by an engine
  that does not implement it. An engine that does keeps nothing of it and passes
  nothing on (FRM-17), so a forged extension misleads at most the receivers of the
  one frame, and only as far as the extension's definition lets it.
- **A forged invitation** naming a false creator hands control authority to that
  identity in the joiner's engine; INV-3 puts a person in the loop. One that names
  the person themselves as its creator is presented as that claim (INV-7); only what
  the person confirmed on a device of theirs, carried unchanged, lets another device
  join without asking again (INV-9).
- **Attachments** let any member make other members fetch data; BRG-13 and BRG-14
  bound how much a bridge reads, and the fetch itself where the bridge makes it.
  Where a messenger's client fetches attachments before the bridge sees a message,
  as `signal-cli` does, only the client's own limit bounds that fetch, and the
  binding says so (BRG-14). Pieces are ordinary updates: an incomplete set occupies
  nothing beyond what the CRDT holds pending anyway.
- **An email document without PGP** has no sender authentication at all: anyone who
  can send mail with a forged `From` can issue control frames as the creator
  (SEC-2).

- **SEC-2** · *application* — An application that creates or opens an email
  document without PGP MUST tell the person so, persistently, as EML-9 labels the
  experimental mode: the document has no sender authentication.
  *Rationale:* anyone who can send mail with a forged `From` can issue control
  frames as the creator.

---

## Appendix A. Profile `yjs-paragraphs/1`

*Normative for every engine that implements this profile.* A document of this
profile is a Yjs document holding plain paragraphs. Its updates and state vectors
are **Yjs update encoding version 1**, the normative reference for which is Yjs
13.6.33 ([source](https://github.com/yjs/yjs/tree/v13.6.33/src): in `utils/`
`encoding.js`, `updates.js`, `UpdateEncoder.js`, `UpdateDecoder.js`, `DeleteSet.js`; in
`structs/` `Item.js` (`readItemContent`, `Item.integrate`) and the content kinds'
`Content*.js`; the type readers in `types/`; with lib0 for its numbers, strings and
`Any` values, which the reference implementation resolves as 0.2.117 — informative,
since what Yjs 13.6.33 reads is the reference): its structs, content kinds,
variable-length integers and strings, which bytes it reads as an update, and what a
replica that applies them holds — deleting a type deletes what it holds
(`ContentType.js`). *Informative:* yrs, the Rust implementation in y-crdt, reads and
writes the same encoding independently (`Update::decode_v1`, `encode_v1`,
`StateVector::decode_v1`; [yrs 0.28.0](https://docs.rs/yrs/0.28.0/yrs/)), not tested
by the reference implementation; it draws 53-bit client ids where Yjs 13 draws
32-bit ones, and the encoding carries either.
The rows below fix what this profile adds to the encoding; any implementation that
reads and writes it so interoperates, whichever library it uses. A library function
named below is an informative example, not a definition.

| PRF-1 item, or §5.6 | In this profile |
|---|---|
| Update | A **Yjs update in encoding version 1**, not version 2: the structs — the number of clients, and for each the number of its structs, its client id, the clock of its first struct and the structs — then a delete set, laid out as in *What a replica deleted*, though a received one need not be in that order or merged. A full snapshot and an incremental change are the same format. *Informative:* Yjs writes it with `Y.encodeStateAsUpdate` and applies it with `Y.applyUpdate`, yrs with `encode_state_as_update_v1` and `Update::decode_v1` |
| Missing predecessors | A struct is held, not applied, while a struct of its client before it, or an item it names — its left origin, its right origin or its parent — has not arrived; the later structs of its client in that update are held with it. A delete range is held, as far as it reaches beyond the items of its client the replica holds. Whose updates they are: for a held struct, the client whose struct is missing; for a held range, the client it names. How far an update carries a client: the clock after its last struct of that client; an update that only deletes carries none. What they take (LOS-23) is the length of two updates in encoding version 2: one of all held structs with an empty delete set, and one of all held ranges with no structs, each part held later merged into what was held before as Yjs 13.6.33 merges updates of that encoding. Nothing sends these bytes; they only measure. Giving them up drops both, as if those updates had never arrived. *Informative:* these are the two updates Yjs keeps, `store.pendingStructs.update` and `store.pendingDs` |
| State vector | In encoding version 1: the number of entries, then for each a client id and the clock after the last struct of that client the replica has applied, every number a variable-length unsigned integer; held structs are not counted. Yjs writes the entries in descending order of client id; a reader takes them in any order. The empty document's is the single byte `00` (Base64 `AA==`). *Informative:* `Y.encodeStateVector`; yrs `state_vector().encode_v1()` |
| Updates a state vector lacks | An update of every struct the replica applied, from each client's clock in the state vector on — a struct that clock falls inside written from that clock —, and of the delete set of its applied items; nothing held for missing predecessors. With the empty state vector this is the full state. The update that holds nothing, the full state of an empty document, is the two bytes `00 00` (Base64 `AAA=`): no structs and an empty delete set. *Informative:* `Y.encodeStateAsUpdate(doc, stateVector)` while `store.pendingStructs` and `store.pendingDs` are empty; it adds what they hold |
| Initial state | One empty paragraph |
| Plain-text projection | The paragraphs' texts in document order, joined by a single `"\n"`; a paragraph's text is that of the `Y.XmlText` it holds, without formatting or embeds (YJS-4 for content YJS-1 forbids); offsets count **UTF-16 code units** |
| Splitting into pieces | Each piece a Yjs update in encoding version 1 holding one contiguous run of one client's structs, or a part of the delete set. A run is cut between structs and, where a struct alone is too large, inside it: the prefix written as a shortened copy, the suffix as Yjs writes any partial struct; text never cut inside a UTF-16 surrogate pair |
| Indivisible units | Content of length one — an embed, a binary, a format, a type, a subdocument. Its encoded struct must fit a piece: (`maxBytes` − an `edit` frame's other fields) × 3/4 bytes, just under 3 MiB at the bindings' 4 MiB. Text is never such a unit |
| What a replica deleted | The update of no structs and the replica's whole delete set, in encoding version 1: `00` for no structs, the number of clients, and for each client in descending order of its id its id, the number of its ranges and each range's clock and length, ascending and merged, every number a variable-length unsigned integer. A document that deleted nothing gives the two bytes `00 00`. Of the items a state vector counts: the same, with each client's ranges cut at that client's clock in the state vector, and a client without ranges left out — within the replica's own state vector exactly the encoding of all it deleted |
| Reading without applying | An update is read whole — every struct with its content, then the delete set — and ends after the delete set's last range; a state vector ends after its last entry. A struct is a skip only where its info byte is 10 itself, and a parent-info number other than 1 names an item by its id, as 0 does. Bytes are not an update, or not a state vector, where encoding version 1 does not read them so: among them a number or a length that runs past the end, a string that is not UTF-8, a struct whose content kind (the low five bits of its info byte) the encoding does not define — 10 with any of the high three bits set among them —, JSON content that does not parse, and a tag of a shared type or of an `Any` value the encoding does not define. What it adds to what Yjs reads: a variable-length integer anywhere above 2^53 − 1 (of a signed one, its magnitude), or longer than the 8 bytes that 2^53 − 1 takes, whatever its value; an end beyond 2^53 − 1, of a client's structs the clock of its first struct plus the lengths of them all (a skip's and a collected struct's as written, an item's that of its content, a string's in UTF-16 code units) and of a delete range its clock plus its length; and JSON content or an `Any` value nested more than 32 levels. The end keeps a replica that applies an update at clocks its state vector can carry; an update that goes on with a client starts at most at the clock the replica holds for it, or it is held, so one update at a time keeps the bound for all of them. Each JSON text (an entry of JSON content, an embed, a format's value) and each `Any` value (of `Any` content, a subdocument's options) counts on its own, as [§1.6](#16-notation) counts a frame: arrays and objects, the outermost the first level, an empty one too. JSON content parses as ECMAScript's `JSON.parse` does, without §1.6's I-JSON restrictions; an entry of JSON content that is the text `undefined` is Yjs's undefined value. A receiver of this profile also rejects any byte after a complete update or state vector, which Yjs ignores (§4.4). *Informative:* `Y.decodeUpdate` and `Y.decodeStateVector` read so but for these bounds: lib0 checks an integer's range only between its bytes, reads a long run of zero bytes as NaN, and reads `Any` values by recursion, one level per call, and Yjs adds a struct's length to its clock without a bound; the vectors of `updates-v2.json` ([§3.6](#36-conformance-suite)) show each |
| Layers | Admitted: top-level shared types beside `content`, each named by a layer id ([§5.6](#56-layers)) |

- **YJS-1** · *engine, application* — A document of this profile MUST keep all its
  content in one `Y.XmlFragment` named `content`, whose children are
  `Y.XmlElement`s named `paragraph`, each holding one `Y.XmlText`, and MUST NOT add
  other element names or attributes. Beside `content` it MUST NOT hold a top-level
  shared type except a layer, named by its layer id ([§5.6](#56-layers)). It MUST NOT
  hold, in `content` or in a layer, JSON content or an `Any` value nested more than
  32 levels, counted as "Reading without applying" below counts them.
  *Rationale:* a peer that does not know an element can still merge it, but cannot
  render, project or attribute it, so participants would see different documents
  from the same state. A layer is different by definition: it is not content, and
  every peer keeps it (LAY-1) whether or not it shows it. A value nested deeper is
  one Yjs writes and applies, but no receiver of this profile reads (FRM-6): the
  replica that holds it could give it to nobody (SND-26).
- **YJS-4** · *engine* — A receiver MUST NOT reject an update because what it
  holds breaks YJS-1, and MUST apply it like any other. It MUST project such
  content as it projects paragraphs:
  - each child of `content`, whatever its name and attributes, is one paragraph
    whose text is that of the `Y.XmlText`s it holds directly, in order, without
    formatting or embeds;
  - a `Y.XmlText` that is itself a child of `content` is a paragraph of its own
    text;
  - anything nested deeper adds nothing.

  A top-level type beside `content` that no layer id names is not in the
  projection, and a change of it is a change of the content (LAY-7).
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

*Informative.* The values the reference implementation uses, and one for an
application, each with the requirement it serves. A row marked *required* repeats
a number the requirement states itself: the bounds of control state (CTL-30,
CTL-36, CTL-37), the 4 MiB every transport carries (TRN-23), the span of a
device's own clock (CTL-45), four requests kept per
requester (RSY-19), at least four streams per member (LOS-17), and what bounds
what loss detection costs — one report per phase (SND-11), three tries per gap,
each wait at least double the one before (LOS-6, RSY-5), 10 min between two wakes
of a gap (LOS-26), and between two closes sent again to one member and one per read
(LIF-11). Every
other value — the report delay (SND-11), the absence before a start request
and the longest wait between two tries among them — is a recommendation: an
implementation chooses its own (§1.3).

| Value | Recommended | Serves |
|---|---|---|
| Engine default pacing | floor 0, no `maxIntervalMs`, `minChars` 0, no `maxChars`, latency 0 | SND-16, TRN-15 |
| Quiet time (`batchWindowMs`) | 500 ms | SND-3 |
| Retry back-off | From max(1 s, floor), doubling per consecutive failure, capped at `maxIntervalMs` or 10 min; `retryAfterMs` honoured up to 1 h; after `needs-person`, the cap at once | SND-7, TRN-20 |
| Adaptive spacing | ×1.5 per `rate-limited` refusal, from the floor or 1 s; relaxed ×1.5 after 8 consecutive successes | SND-9 |
| Resync response throttle | 1 000 ms per document per responder | RSY-9 |
| Requests kept to answer later | By request id, at most 4 per requester (*required*) and 64 per document, each for at most 5 min — 5 min past its turn where it has one — and none past its requester's wait (RSY-17); oldest dropped first | RSY-17, RSY-19, RSY-20 |
| Resync request expiry | floor + 2 × latency, at least 10 s; for a request to all, that plus the answer window | RSY-4 |
| Bootstrap retry | after 1, 2, 4, … expiries; at most 5 attempts, each repeat asking all; then one further request to all on a frame of a participant that did not answer the latest (RSY-5) — on a device of the creator, of another of her devices —, or, whoever answered, on a `control` frame, report or request of another device of the creator that states a control clock, the waits at least doubling on (*required*), never longer than 10 min | RSY-5, RSY-21 |
| Answer window | 6 × the responder's own `expectedLatencyMs`, at least 30 s and at most 5 min | RSY-20 |
| A member's wait before its turn | ⌊window × h / 2^32⌋, `h` the first 4 bytes, big-endian, of SHA-256 over the UTF-8 of `requestId` + `:` + its own stream; with a 60 s window, request `c41d07e9a2b85f36` and stream `0c4f9a2be81d7365`, 26 075 ms. At its turn it judges the first 4 answers it heard of the request | RSY-20 |
| Loss-evidence wait | 1 × `expectedLatencyMs`, or 5 s when it is 0 | LOS-1 |
| Held for missing predecessors | 32 MiB of pending structures and deletions; beyond, all given up as a truncated history | LOS-23 |
| Streams kept per member | 4 for their reports (at least 4 *required*), each with its latest, the furthest it stated, with at most 8 state digests at that vector and 8 control digests at its greatest control clock, and when it was last heard; a fifth replaces the one heard from least recently; one with an answer counted or given up kept besides | LOS-12, LOS-17, LOS-21, RSY-17 |
| A difference in digests lapses | Once its stream was not heard for longer than the absence before a start request, 10 min | LOS-12 |
| Answers counted per member | 8 at once, a ninth giving up the one heard from least recently, which stays evidence; 8 streams with answers given up, beyond them the member's evidence stays while the engine runs; piece numbers up to 2^20 | LOS-21, LOS-22 |
| Incomplete answer | evidence once no piece has arrived for the floor + the loss-evidence wait | LOS-14 |
| Automatic resync | Per gap: at once for a truncated history, else after 2 × the loss-evidence wait and its place in the answer window, derived from the gap and its own stream as a member's turn is; at most 3 requests (*required*), all to all, each wait counted from the try before, the first 2 × the expiry of a request not to all (floor + 2 × latency, at least 10 s), each at least double the one before (*required*), never longer than 10 min, after a request let go for another's also until that one expired, then its place; then the gap rests, woken by a frame that raises its position or, for a CRDT client's gap, by a frame of the member named as its writer, its request timed from that frame as a first try's, at most once per gap in 10 min (*required*), from its previous wake, a frame read sooner waking it once the 10 min passed, and at once by the person or by a return or an absence longer than the one before a start request that the application tells of, with the request they bring; none where another's request to all reaches no further (RSY-22). After a return, one request to all, one expiry after the latest | LOS-6, LOS-18, LOS-19, LOS-25, LOS-26, RSY-5, RSY-21, RSY-22 |
| Report | Owed from the first `edit` or `control` frame of its own the transport accepted in a phase; due a report delay, 10 s, after the last, once nothing of its own waits; at most one per phase (*required*); at once, as soon as SND-11 lets it, in the cases SND-11 and SND-24 name; while owed and refused for a reason worth retrying, again after the retry back-off, which a read that reached the messenger again ends | SND-11, SND-12, SND-24, SND-28 |
| Start request | After more than 10 min away, counted as LIF-8 says, when that is not known, or with a gap; once | RSY-1 |
| Close sent again | At most once per member that writes in 10 min and once per read (both *required*); none for the first read after a start | LIF-11 |
| Positions of CRDT clients kept | 1 024 clients; the one named least recently goes first | LOS-25 |
| Others' requests to all kept | 16, the oldest dropped first, each for a request to all's expiry | RSY-22 |
| Pace bound | 10 min: a longer pace runs as 10 min, for sending and in the floor an incomplete answer is judged by | SND-15, LOS-14 |
| Control state bounds (*required*) | 5 000 targets on members and rights on layers beside the pace and the reason, 5 002 in a snapshot or `control` frame; the reason 1 to 128 UTF-8 bytes; 3 MiB held, 1 MiB for a decision that adds a target, measured as CTL-34 says; the close and its reason outside every bound | CTL-23, CTL-30, CTL-34, CTL-36, CTL-37 |
| Smallest transport (*required*) | `bounds.maxBytes` `null` or at least 4 194 304 bytes; a creation or join on a smaller one fails | TRN-23 |
| Own clock of a device of the creator (*required*) | At most 24 h ahead of its wall clock, but for one step per decision | CTL-45 |
| Own clock running ahead | Advice, no requirement: an application of the creator tells its person when the device's own clock, as persisted (CTL-26), lies more than 1 h ahead of its wall clock: its decisions then hold over concurrent ones for that long | CTL-45, CTL-22 |
| Smallest useful piece | 16 bytes of update; where a frame's other fields leave less room, the change is refused | SND-19 |
| Incoming mail read | At most 10 MiB of one mail, by a partial IMAP fetch; a larger one rejected unread (a 4 MiB frame becomes at most about 7.6 MiB) | BRG-13 |
| Signal daemon response | At most 16 Mi characters per JSON-RPC line from `signal-cli`, plus one socket read (a 4 MiB attachment is about 5.6 Mi in Base64); a longer line is dropped and the calls waiting fail | BRG-14 |
| Bridge retention | The newest 1 000 deliveries per document, and at most 64 Mi characters of their payload text; the newest always kept | BRG-17 |
| Engine memory of processed ids | What `receive` still returns, its own sends for up to 1 h until their echo, and 1 024 request ids of others and of its own it no longer keeps | TRN-8, RSY-6 |
| Requests of one's own kept | Each for 30 min after it went out, longer while an answer arrives in pieces; at most 256, the oldest dropped first, one with an answer under way last | RSY-12 |
| Matrix attachment download retry | 1, 2, 4 … s, at most 60 s apart, 8 attempts, at most 64 waiting | BRG-14 |
| Signal attachment read retry | 3 attempts, 0.5 s and 1.5 s apart | BRG-14 |
| Bridge ports | Signal 8787, Matrix 8788, email 8789 | — |

Suggested pacing per bridge (`minInterval` / `maxInterval` / `expectedLatency`,
then bounds; `minChars` 0 and `maxChars` none). **Only the email interval is a
decision; every other value is an estimate.** Named presets are an application's
([§3.5](#35-transport-profile)).

| Bridge | Pacing | Bounds |
|---|---|---|
| Email to a provider | 35 s / 120 s / 60 s — above the one message per 34 s one provider was measured to allow; 1.x's 30 s ran into refusals there | floor 15 s; 4 MiB (a mail of at most about 7.6 MiB: 1.81 mail bytes per frame byte with PGP, 1.39 without, below the roughly 10 MiB providers accept) |
| Email or Matrix to a server on the same machine | 0 / none / 0 (no floor, no cap) | email none; Matrix no floor, 4 MiB |
| Matrix to a real homeserver | 1 s / 15 s / 5 s | floor 250 ms; 4 MiB. Synapse limits by a burst of 10 messages, then one every 5 s (`rc_message`), so steady typing is refused now and then, and the homeserver's wait (MTX-6) and the widened spacing (SND-9) take over; a floor at the sustained rate would slow every burst |
| Signal | 2 s / 20 s / 10 s | floor 500 ms; 4 MiB |

Measured: typed text costs about 10 bytes per character on the wire, pasted text
about 1, a full snapshot 1 to 9 depending on how concurrently it was written. One
email provider refused after about 35 messages in 20 minutes, 8 to 35 s per hop.

## Appendix C. The bindings compared

Moved to [bindings/bridges.md](bindings/bridges.md#appendix-c-the-bindings-compared).

## Appendix D. Example frames

*Informative.* Produced by the reference encoder, documentId `doc-a1b2c3`,
profile `yjs-paragraphs/1`, from a device of the creator tagged
`Ms3dRk0ZyS7cH1qkM8fWNA`, which is bootstrapped. The `edit` frame is in
[§4.5](#45-example).

`control` — the device's first decision, at 10:00 UTC on 26 October 2026: `bob`
may write. The register's clock is the wall clock in milliseconds, its counter 0;
the frame states the device's control clock and control digest after it:

```json
{"tdsp":2,"kind":"control","documentId":"doc-a1b2c3","device":"Ms3dRk0ZyS7cH1qkM8fWNA","targets":{"member:bob":{"value":"write","clock":[1793008800000,0],"device":"Ms3dRk0ZyS7cH1qkM8fWNA"}},"closed":false,"controlClock":[1793008800000,0],"controlDigest":"106166478695c222"}
```

`control` — its second, in the same millisecond, the pace for everyone 30 seconds:
the clock is the one after the device's own, its counter one higher:

```json
{"tdsp":2,"kind":"control","documentId":"doc-a1b2c3","device":"Ms3dRk0ZyS7cH1qkM8fWNA","targets":{"pace":{"value":30000,"clock":[1793008800000,1],"device":"Ms3dRk0ZyS7cH1qkM8fWNA"}},"closed":false,"controlClock":[1793008800000,1],"controlDigest":"f1bd21d9458955ff"}
```

`control` — its third, a minute later, `carol` may read:

```json
{"tdsp":2,"kind":"control","documentId":"doc-a1b2c3","device":"Ms3dRk0ZyS7cH1qkM8fWNA","targets":{"member:carol":{"value":"read","clock":[1793008860000,0],"device":"Ms3dRk0ZyS7cH1qkM8fWNA"}},"closed":false,"controlClock":[1793008860000,0],"controlDigest":"8d243bc3f8bf3126"}
```

`heartbeat` from that device, the first report of its engine, whose stream is
`0c4f9a2be81d7365`. The edit of §4.5, the document's whole state, went out before the
decisions and began no phase (SND-11); the device then had no network until after
its third decision, so the three `control` frames went out one after another once
it had, and the phase they began ended a report delay after the last of them. That
frame went again just before the report, which therefore carries no `update`
(SND-27). The state vector names one Yjs client at clock 4; nothing was deleted, so
the state digest is that of the two bytes `00 00`; the control clock is the
greatest clock among the three registers, the control digest that of the three:

```json
{"tdsp":2,"kind":"heartbeat","documentId":"doc-a1b2c3","controlClock":[1793008860000,0],"controlDigest":"8d243bc3f8bf3126","stateVector":"AYma9JgPBA==","stateDigest":"96a296d224f285c6","stream":"0c4f9a2be81d7365","sequence":1}
```

`heartbeat` from `bob`, a member, after his one edit, which added "!" after "Hi"
(his Yjs client 2357911131, clock 0): it carries that edit's update again, as it went
out, so a receiver that lost the edit takes it from the report; a member states no
control clock; it is the second report of his engine, whose first was his request as a
joiner:

```json
{"tdsp":2,"kind":"heartbeat","documentId":"doc-a1b2c3","controlClock":null,"controlDigest":null,"stateVector":"Aoma9JgPBNu8q+QIAQ==","stateDigest":"96a296d224f285c6","stream":"3b8e1f0a7c5d2946","sequence":2,"update":"AQHbvKvkCACEiZr0mA8DASEA"}
```

`control` — then the close, a frame without registers; the control clock stays, the
control digest is that of the same registers, closed:

```json
{"tdsp":2,"kind":"control","documentId":"doc-a1b2c3","device":"Ms3dRk0ZyS7cH1qkM8fWNA","targets":{},"closed":true,"controlClock":[1793008860000,0],"controlDigest":"c3d2af7d419e5c5a"}
```

`resync-request` of a joiner with nothing, the first report of its engine:

```json
{"tdsp":2,"kind":"resync-request","documentId":"doc-a1b2c3","requestId":"5f3a9c0e12b47d68","controlClock":null,"controlDigest":null,"all":false,"force":false,"stateVector":"AA==","stateDigest":"96a296d224f285c6","stream":"7e0d5b31a9c4f286","sequence":1}
```

`resync-request` of the same joiner after that request went unanswered, with a new
`requestId` and `all` set, its engine's second report:

```json
{"tdsp":2,"kind":"resync-request","documentId":"doc-a1b2c3","requestId":"c41d07e9a2b85f36","controlClock":null,"controlDigest":null,"all":true,"force":false,"stateVector":"AA==","stateDigest":"96a296d224f285c6","stream":"7e0d5b31a9c4f286","sequence":2}
```

`decline` of a joiner whose engine implements another profile:

```json
{"tdsp":2,"kind":"decline","documentId":"doc-a1b2c3","reason":"unsupported-profile","profiles":["com.example.markdown/1"],"text":"My app cannot open this document."}
```

The `edit` frame of §4.5 as a Signal group message's body — the envelope, which
keeps its own version 1, with the frame as a JSON string:

```json
{"tdsp":1,"kind":"frame","documentId":"doc-a1b2c3","frame":"{\"tdsp\":2,\"kind\":\"edit\",\"documentId\":\"doc-a1b2c3\",\"update\":\"AQOJmvSYDwAHAQdjb250ZW50AwlwYXJhZ3JhcGgHAIma9JgPAAYEAIma9JgPAQJIaQA=\"}"}
```

## Appendix E. Implementer checklists

*Informative.*

**A bridge for a new messenger.**

1. Check the messenger against [§15.1](#151-what-a-messenger-must-provide). The
   dealbreakers are an unauthenticated sender and an inability to carry an opaque
   payload. Write down its size and rate limits, and against whom it protects
   senders, integrity and confidentiality, its own servers included (BND-1).
2. Decide how the account is provisioned, and keep its credentials in a private
   place, away from the engine and from whatever renders what the channel carries
   ([§12.1](bindings/bridges.md#121-account-and-credentials), BRG-2, ARC-4).
3. Write a binding ([§13](bindings/bridges.md#13-messenger-bindings)): account, security, envelope,
   carrier, delivery id, sender, inline limit, attachments, and how a message
   reaches the sender's own other devices (TRN-7).
4. Never parse the frame; route by the envelope's documentId, and take a frame
   only from the channel its document is bound to; ignore what is not yours,
   silently (BRG-10). A message you cannot read never stops you from reading the
   others (BRG-18).
5. Make delivered messages immutable and record every attempt to alter one
   (BRG-11, BRG-12). Bound what you keep of each document (BRG-17).
6. Resolve a send only once the messenger accepted it as its binding defines
   accepted (TRN-6), and classify send failures (BRG-8): a refusal only a person
   can lift is `needs-person`, `409` over the local bridge interface (LBI-6). If
   the bridge runs in its own process, offer the local bridge interface
   ([§12.6](bindings/local-bridge-interface.md#126-the-local-bridge-interface-optional)):
   loopback only, loopback origins only.
7. Reach exactly one endpoint, and fetch attachments only from it, bounded and
   checked before anything else is done with them (BRG-14).
8. Serve a transport profile with the limits you measured and a pacing you
   suggest, saying which values are estimates. Where the messenger has a position
   to resume from, offer a cursor (TRN-18); offer an instance id that changes
   whenever the bridge may have lost something, on every restart if in doubt
   (TRN-19).
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
3. Persist the creator's control state with its tag, its clock and the decisions
   not yet sent (CTL-26), or hold every message until it is durable (CTL-38), and
   the list of documents, marking one as the person's own before its initial state
   goes out and creating anew one so marked without persisted control state
   (LIF-5). Persist a capacity conflict and show it (CTL-32). Persist the cursor
   and the instance with content, never a cursor ahead of the control state, and
   when the last read that reached the messenger began; tell a restarted engine
   that time, how long the transport keeps a message and whether the document was
   unbound meanwhile (LIF-8, CTL-40, RSY-21). Persist the undistributed mark with
   the content (SND-21), and the report owed, on this device only (SND-28). On a
   device of the creator not bootstrapped, show that the rights are not known
   yet; once its attempts ran out, ask whether another device
   of hers or a backup holds the document, ask again when she says one does, and
   offer to close it and continue in a new one (CTL-27, CTL-43, CTL-46). Show the
   reason for the close only once it is closed (CTL-23).
4. Show the creator from an invitation by an identifier the messenger keeps
   unique, and let the person confirm before joining (INV-3); one that names the
   person as its creator is that claim, nothing more (INV-7). Decline an invitation
   whose profile the engine does not implement, and show others' declines. Tell the
   person when an invitation, or a participant's frames, come from another version
   (DCL-1, VER-4).
5. Show send status and loss evidence; show an error only for a dropped change,
   and undistributed changes until a resync went out, with an offer to send the
   whole state again (SND-8, SND-21). Show when sending waits for the person, and
   tell the engine once they acted (TRN-22). Never present no evidence as
   "synchronised", nor as "nothing suggests a loss" while the creator's last
   request went unanswered (LOS-15, LOS-20). Show an answer that lacks a piece
   (LOS-14), and a gap that rests, with an offer to synchronise now (LOS-26,
   LIF-12); bootstrap attempts that ran out, with an offer to ask again (RSY-5);
   and a closed document as still synchronising while there is loss evidence
   (LIF-6). Tell the engine when the person closes the document and before the
   device sleeps (SND-11, LIF-12).
6. While the engine would refuse an edit (CTL-13), prevent typing, or hold what
   the person types outside the engine's document (CTL-42). One way to hold: a
   second replica that applies every update the engine's document applies, which
   the person edits; once the engine may edit, apply the replica's update since the
   engine's state vector as a local edit, which the CRDT merges with whatever
   arrived meanwhile — a text difference against an earlier state would undo or
   misplace it.
7. Write large embeds and binaries in parts no larger than the profile allows
   (SND-19), and offer pacing presets of your own; the transport suggests one
   pacing, and the creator may set the pace for everyone (SND-15).
8. Say, per messenger, what the channel protects — an email document without PGP
   persistently (EML-9, SEC-2), the creator key's fingerprint in every trust state
   (EML-13) — and never present attribution as authentication.
9. Before carrying a document between one person's devices through another
   service, tell the person; carry control state only between devices of the
   creator (ARC-5), and join on another device without asking again only with
   what the person confirmed, carried unchanged (INV-9).
10. Keep the channel and the rights in step, and show where they differ: a
    permission before the invitation, a revocation before or as you remove a
    person, neither changed for a difference without the person (LIF-9, LIF-10).
11. Tell a running engine how long it was away once a read reaches the messenger
    again after the device slept or had no network: after an absence longer than
    RSY-1's it asks all once, and after longer than the transport keeps a message
    it returns (LIF-12, RSY-1, RSY-21).

## Appendix F. Reference implementation

*Informative.* The reference implementation of TDSP 2.0 is TypeScript: its
engine runs on Node.js and in the browser, its bridges on Node.js.

| Part | Class | What it is |
|---|---|---|
| `messenger-port` | — | The transport contract with its optional cursor and instance, the transport profile, the send-failure classification, and the transport conformance suite ([§3.6](#36-conformance-suite)) |
| `messenger-mock` | adapter | An in-memory transport with fault injection — delay, duplication, loss, a moved-on window, a restarted bridge — offering the cursor and the instance; for tests only |
| `document-protocol` | engine, application | The engine (`DocumentEngine`), and the invitation link's reader and writer (`parseInvitation`, `encodeInvitation`): frames, control state as registers, bootstrap and resync, send scheduling, pieces, loss detection, declines |
| `reconciliation` | engine | The profile `yjs-paragraphs/1` ([Appendix A](#appendix-a-profile-yjs-paragraphs1)), its splitting into pieces, and the attribution tracker |
| `messenger-signal`, `messenger-matrix`, `messenger-email` | adapter | The adapters, each an HTTP client of its bridge through the [local bridge interface](bindings/local-bridge-interface.md) |
| `bridges/signal-bridge`, `bridges/matrix-bridge`, `bridges/email-bridge` | bridge | The bridges, one per binding ([bindings/](bindings/)), each offering the local bridge interface on loopback |
| `loopback` | adapter, bridge | The one check of whether an address is a loopback address, as the local bridge interface defines it |
| `bridge-log` | bridge | The bridges' structured log. Its callers log identifiers, never message bodies, keys or credentials; as a safety net it redacts a field whose name suggests a secret (`password`, `token`, `secret`, `credential`, …), cuts every string at a bound, and escapes control characters so that a value cannot begin a line of its own |

The adapters and bridges carry 2.0's frames unchanged, since the envelope
did not change, and serve the transport profile of [§3.5](#35-transport-profile)
(TRN-13); of what 2.0's bindings changed or added they implement part. Beside the
implementation, the repository holds a small checker in Swift,
[conformance/swift-checker/](conformance/swift-checker/), which by its authors'
account was written from this specification, the bindings and the vector files
alone, not from the reference implementation: it reads frames and invitations,
merges registers, computes digests and runs the clock, and is no engine, so it is
a second reading of the text, not a second engine exchanging with the first. The
implementation's conformance status — what has been verified, and against what,
the checker's runs included — is published with it (`CONFORMANCE.md`), not here.

## Appendix G. Changes from TDSP 1.x

*Informative.* Requirement by requirement, with the reason for each change; the
requirements themselves state their full rationale. An ID not listed keeps its
1.x text, but for references to sections or requirements that moved.

The changes have nine reasons, which the tables below cite by letter:

- **A — One writer, one number.** 1.x numbered the creator's control actions in
  one gap-free sequence per document. That holds only while the creator uses one
  device: two devices, or one restored from a backup, issued different actions
  under one number, and a device that had not seen the current number could not
  decide at all. And an action held only after its send succeeded. 2.0 keeps per
  target the latest decision of any device of the creator, ordered by a clock
  that follows both the time and what the device had seen, and merges it like the
  content ([§7](#7-control-state)).
- **B — A shared policy for a private matter.** 1.x carried the creator's whole
  sync policy to every participant, with a grammar, a precedence and a clamp for
  every value. Receivers need one thing from it: how quiet the creator wants the
  document. 2.0 keeps exactly that (the pace, SND-15); everything else is each
  participant's own (SND-16).
- **C — Closed layouts.** In 1.x every new field broke the wire. 2.0 lets a field
  whose name contains `.` be ignored when unknown, unless its sender marks it
  critical (FRM-9 to FRM-12, FRM-15 to FRM-17).
- **D — Fragments.** A message too large for the messenger travelled as
  fragments that a receiver buffered and reassembled; one lost fragment lost the
  whole message. 2.0 splits a large update into pieces that are updates
  themselves (PRF-1 item 7, SND-17).
- **E — Loss guessed, not known.** Without a position to resume from, an engine
  could only guess whether something slid out of a bridge's window (LOS-8), and a
  bridge restart between two polls stayed invisible. A bridge whose messenger has
  such a position now says so (TRN-18, TRN-19).
- **F — One document for every messenger.** Kept in documents of their own, the
  bindings can change without a revision of the core, and the core describes only
  what every transport offers.
- **G — The channel is the boundary.** Whoever is removed from a channel receives
  nothing new. 1.x let a member the creator had not named write; 2.0 has it wait
  as a reader, and an application keeps the channel and the rights in step
  ([§6.6](#66-who-takes-part)).
- **H — Anyone may bring a new device up.** In 1.x only the creator, or another
  device of the asker's own member, could bootstrap a device. In 2.0 anyone in the
  channel may, passing on what reached it of the creator's decisions (§1.1) — a
  new device of the creator excepted, which only another of her devices or her own
  state brings up (CTL-46) ([§8.3](#83-who-answers),
  [§7.6](#76-a-new-device-of-the-creator)).
- **I — Loss is rare, and heals at the next occasion.** 1.x had every sender
  promise a follow-up and every receiver judge the silence after it. Where loss is
  rare, the typical loss is a sender's last change, which nothing later of it
  shows. 2.0 sends one report after each phase of a sender's own writing, which
  carries that change again (SND-11, SND-27), and asks for every other gap of one
  stream at most three times before it rests until that stream or its writer's
  member moves on, an absence or the person (LOS-25, LOS-26).

**Withdrawn**, with what takes their place:

| 1.x | Replaced by | Why |
|---|---|---|
| CTL-2, CTL-3 (a gap-free sequence of the creator, applied after the send) | CTL-20, CTL-21, CTL-45 | A: registers ordered by a clock and a device tag let several devices decide without a conflict, and a decision holds at once, so it shows while the messenger is away. |
| CTL-8, CTL-9 (highest and contiguous sequence) | LOS-10, LOS-12, RSY-16, SND-11 | A: one number cannot describe several devices; a clock and a digest can. |
| CTL-11 (the snapshot replaces, with a floor) | CTL-25 | A: a snapshot merged register by register undoes nothing, so it needs no floor. |
| CTL-12 (persistence with an outbox) | CTL-26 | A: a decision is persisted with the device's clock, its frame as unsent until the messenger takes it. |
| CTL-14 (ordering policies) | — | B: no shared policy is left to order. |
| CTL-16 (clamping the creator's policy) | SND-15 | B: the one shared value, the pace, yields to each participant's own bounds. |
| CTL-17, CTL-18 (conflicts under one number, devices continuing after an unbroken run) | CTL-22, CTL-23 | A: no two devices share a number; concurrent decisions merge, the later by the deciding devices' clocks, and a device restored from a backup is merged alike everywhere instead of stuck. |
| CTL-19 (a creator device without control state waits) | CTL-27, CTL-46, RSY-14 | A, H: the creator's devices hold all of her decisions, members only what reached them. A new device of the creator is bootstrapped by another of her devices or its own restored or carried state, merges members' answers meanwhile and decides nothing but the close and its reason; without any device or backup of hers, the document is closed and continued as a new one. |
| RSY-2 (`controlSequence` and `bootstrap` in a request) | RSY-16 | A: a request states its sender's control clock and control digest; `force` takes over from `bootstrap` after a truncated history. |
| RSY-7 (when to answer, by sequence and `bootstrap`) | RSY-17 | A: the same decision, made by comparing clocks and digests. |
| SND-4 (the shared policy's precedence) | SND-15, SND-16 | B. |
| FRG-1 to FRG-8 (fragments and reassembly) | PRF-1 item 7, SND-17, SND-18, SND-19 | D. |
| LOS-3 (silence judged by the receiver's own policy) | — | B, I: no silence is judged; a report follows each phase of writing (SND-11) and carries its last change again (SND-27). |
| LOS-5 (a gap in the control sequence) | LOS-10 | A: a control clock of a device of the creator above every clock held is a missing decision; the report after the device's phase shows the last one lost (SND-11, SND-27). |
| INV-4, INV-5 (the policy in the invitation, its grammar) | — | B: an invitation carries no policy. |

**Kept, changed:**

| Requirement | Change | Why |
|---|---|---|
| FRM-2 | `"tdsp": 2` | The control frame, the heartbeat and the request change incompatibly; a 1.x engine must refuse a 2.0 frame loudly (VER-1). |
| FRM-5, FRM-6 | Extension fields may be added; defined fields keep their one reading | C. |
| VER-2 | An extension field is not an undefined value, nor an application's reason for the close (CTL-23) | C: their names keep them apart from values a revision may define. |
| CTL-7 | Nor is the update a report carries rejected for its sender's permission | I: a report carries again only what went out (SND-27); judged by the receiver's rights, receivers that knew of a revocation at different times would diverge. |
| CTL-1 | Registers instead of numbered actions | A. |
| CTL-5 | Without 1.x's condition (c); a register is taken from the creator's `control` frames and from the snapshot of an answer the receiver merges (CTL-25); device tags only order registers | A: a register counts in whatever order it arrives, its clock deciding which holds (CTL-22). H: cooperating participants pass on what reached them of the creator's decisions (§1.1), which a device merges from whoever answers it, a new device of the creator too (CTL-25, CTL-27). |
| CTL-6, TRN-8 | A register already held is inert, where 1.x judged a frame by its sequence | A: a duplicate is the expected result of a re-offered message. |
| CTL-15 | The snapshot's layout: the close flag and one register per target; no policy | A, B. |
| RSY-6, RSY-12, RSY-13 | Any member answers a request that asks all, at its turn; the requester takes its answer, control state included (CTL-25), as does a device that let its own request go for that one (RSY-22); only an answer to its own request bootstraps a device (RSY-14) | H; and a device restarted without a cursor would otherwise be bootstrapped by an old answer past a revocation (CTL-41, LOS-8). I: several devices with the same gap ask once. |
| RSY-8 (with RSY-18) | An answer carries the responder's snapshot from any responder that is bootstrapped and in no capacity conflict, `null` otherwise; every piece names the responder's stream and its own number, the last the count | H: a member's answer is how a new device goes on while the creator is offline, a new device of the creator's excepted (CTL-46); a device that may lack something must not bootstrap another. D: a requester that holds more than the responder could not tell whether a piece is missing. |
| SND-2 (with SND-20) | Which messages are retried is a requirement of its own (SND-20): a control frame until the messenger takes it, and a piece of an answer; not the seed, whose failed send fails the creation (LIF-3), unless the invitation went first (LIF-9) and its content stays undistributed. A send asked for at once keeps the floor | A: the decision already holds, so its send is owed. The seed goes out before anyone is invited; once the invitation went first, those invited must get its content. |
| SND-1 | A floor, `minChars` or latency that is not finite falls back to its default | A conformance check: an infinite floor stopped every send. |
| SND-7, SND-9 | A refusal of a message of any kind holds back, and widens the spacing of, the next send of every kind | A conformance check: an answer refused as rate-limited went out again every second. |
| SND-8 (with SND-21 and SND-22), PRF-1 (item 7) | Pieces instead of fragments; a dropped answer, request or report leaves nothing undistributed. What the application shows (SND-21) and a refusal the profile ruled out (SND-22) are requirements of their own | D; and a conformance check: an application that only avoided the word "synchronised" met the rule while it showed everything as sent. |
| SND-10 | A request that fails to send is no error, its outcome *failed*; a failed report is retried (SND-12) and reported to no one | A conformance check: a request is no change, and a failed one showed nowhere. |
| RSY-3, RSY-4 | A request the floor holds back waits; its expiry counts from its send, for a request to all with the answer window (RSY-20), and passes alike whether it was answered or not; an answer ends a request, but for a bootstrap request to all it does not bootstrap; a failed send releases the slot | A conformance check: an automatic request refused at the floor was spent, and an engine that kept writing never asked; an answer that ends nothing must not cut the members' turns short, and what RSY-5 and RSY-21 count from a request must not depend on its answer. |
| SND-11 (with SND-24) | The heartbeat is the report at the end of each phase of the sender's own writing, at most one per phase, a report delay after its last `edit` or `control` frame once nothing of its own waits; at once on close, before sleep, after every merge that changed a bootstrapped device of the creator's control digest — a `control` frame of another of her devices too —, after a bootstrap that left it other than the answer stated, and as SND-24 says; nothing but its own changes begins a phase | I: the typical loss, a lost last change, heals by the report, without a request and also where the sender goes offline at once; reading costs no report. A register that reached a device of the creator only in a member's answer, or in another device's frame under her greatest clock, reaches the members by her report, since members state no control clock and a `control` frame is no evidence (LOS-10). |
| SND-12, SND-13 | A report goes through the scheduler, is retried while owed but never ahead of a change of its own, and marks nothing undistributed; the update it carries is applied as an edit's | I: a report lost to a passing refusal would wait, owed, until the device opens the document again. |
| RSY-1 | A restarted engine asks as a joiner while it is not bootstrapped; bootstrapped, it sends one start request, to all, after its first read, only after a longer absence (Appendix B), not knowing how long, or holding a gap; a running engine told of such an absence too | I: a device away briefly reads what came meanwhile, and what it still lacks shows as a gap. |
| ARC-4 | Credentials stay away from the engine and from every component that renders what came through the channel; a sign-in form outside it may pass a password to the bridge | "The application" was read as every part of it, which no bridge needing a password can meet. |
| ARC-2 | Names its one exception: the service through which an application carries a document between one person's devices (ARC-5) | ARC-5 allows that service, which ARC-2 forbade without the exception. |
| INV-3, INV-7 | The creator is shown by an identifier the messenger keeps unique, or a name the person gave; an invitation naming the person as creator is a claim | A self-chosen name is what a forger copies, and an invitation naming the person themselves is the forgery they can least recognise. |
| TRN-11, TRN-12 | Five reasons: `needs-person` for a refusal only a person can lift | An untrusted identity, an unconfirmed device or no account was retried without end or dropped; implementations chose differently. |
| LOS-1 | The waiting time comes from the engine's own pacing | B. |
| RSY-9 (with RSY-19) | Kept by request id, four per requester instead of one, of each stream only its latest, served in turn (RSY-19); a request the profile cannot answer is let go and reported | wappensc/tdsp#31: several devices of one member asking at once each get their answer; a request read late must not cost an answer for what a later one asks; and one the profile could not answer failed again on every later processing. |
| LOS-2 | A deletion the CRDT holds back until what it deletes arrives is a pending gap | The text left open whether a held deletion was one; it is the same signature of a lost or late insertion. |
| LOS-4 | The latest report of each of a member's streams is judged, after the update it carries; each client it shows behind is a gap of its own (LOS-25) | wappensc/tdsp#31: one device's report must not hide another's. I: judged before what it carries, a report would show its own repeat missing. |
| LOS-8 (with LOS-19 and LOS-20) | Only without a cursor; a truncated history sets `force` and ends only with an answer that carries control state, to a request sent with `force` after it was last found; while the creator's request that ended it is *unanswered*, an application does not say that nothing suggests a loss (LOS-15, LOS-20) | E: a cursor replaces the guess (LOS-9). An unanswered request may mean that nobody who could answer was online. |
| INV-6 (with §11.3) | `policy` is an unknown parameter; a refused link names the first of its problems in a stated order; `channelId` is required by every binding but email | B; and one reading for every link: two readers must name the same problem, and a reader of an unknown provider cannot tell whether a channel id is needed. |
| TRN-13 | A transport profile is `{ bounds, pacing }` | B: a transport suggests its pacing; named presets belong to applications. |
| TRN-10, TRN-17, DCL-3, LOS-6 | The class names everyone the requirement binds: an application too (TRN-10, DCL-3, LOS-6), an engine too (TRN-17) | Each has a sentence for a class its tag did not name. |
| PRF-1 (item 4), with its class | A profile names the update that holds nothing, which a `resync-response` carries where the requester lacks nothing; the state since a vector holds only what a replica applied; PRF-1 binds whoever defines a profile (*all*) | An empty `update` is `invalid-field`; what waits for missing predecessors would only count against a receiver's bounds (LOS-23); and a profile is defined by someone other than an engine. |
| CTL-10 | A snapshot that names another profile is rejected from whoever answers | Every accepted snapshot is merged (CTL-25) and may bootstrap the receiver (RSY-12, RSY-14). |
| ATR-1 | Only an answer to a request made while the engine held nothing is adopted wholesale | An engine that restarted with content keeps the attribution it restored; 1.x left open whether its answer was a bootstrap response. |
| ATR-2, RSY-13 | Unattributed text is `authorId: null` in an overlay and no member's last edit | 1.x named an unattributed author but gave it no form on the wire; a MemberId invented for it is shown as a person by another implementation. |
| DCL-1, VER-1 | No `decline` for an invitation of another version; the person is told instead | No creator could receive 1.x's `unsupported-version`: its engine rejects a frame of another version (VER-1). |
| FRM-7 | A rejection carries the delivery's sender | So that an application can say whom a version skew concerns (VER-4). |
| PRF-6, LIF-5 | Restored control state is what CTL-26 persists; an application marks a document it creates before the initial state goes out, and creates one so marked without persisted control state anew | A: the persisted form changed. Without the mark a stop right after creating left nothing that said the document existed; without persisted control state nothing of it went out (CTL-26, CTL-38), and a device of the creator resumed without state would wait for an answer no one can give (RSY-14). |
| LAY-2 | A copy is the same document; a new document from its content, and an export, may leave layers out and say so | Whether continuing in a new document was a copy that must keep every layer was left open. |
| PRF-7, LAY-4 | The id of a profile or a layer defined outside this specification should begin with a reverse domain name its definer controls (FRM-15); both are of the class *all* | Two definers must not choose one id; a definition binds its definer, whom only *all* names (§1.4). |
| DCL-3 | At most one report per sender for as long as the engine runs; across a restart, what a person saw is the application's to remember | An engine keeps no state of a decline, so the 1.x wording could not be kept across a restart. |
| RSY-5, RSY-14 | Bootstrapped alike for every device: by creating the document, by an answer to its own request that carries control state — for a device of the creator, only another of hers —, or by a restored or carried bootstrapped state (CTL-41); never by content alone, its own decisions or an answer to someone else; until then it asks on, its repeats asking all, and hands on no control state; once the attempts ran out, one further request to all on a frame of a participant that did not answer the latest request — on a device of the creator, of another of hers —, or, whoever answered, on a `control` frame, report or request of another device of the creator that states a control clock, the waits at least doubling up to a longest wait (Appendix B); the application shows attempts that ran out. A device of the creator asks for its gaps whatever its bootstrap | A: 1.x waited for the creator alone, a joiner stopped asking before anyone came back, and unbounded asking would spend the budget of a participant nobody can answer; answers that end nothing must not keep everyone else's frames from bringing the further request. H: any member's answer brings a new device up without the creator, a new device of the creator excepted (CTL-46). |
| LIF-6 | After a close, a decision made before it still goes out, reports go and are applied, and a device of the creator sends the close again (LIF-11); the application is named as it shows a closed document | A: the decision holds on its device, and receivers must learn of it to agree; edits sent before the close still arrive. I: the report repeats the last change before the close, or the close itself. |
| CTL-13 (with CTL-42) | A revoked member is refused as a reader is, on the document and on every layer; `read` refuses only a change of the part it is set on; after the bootstrap an unknown permission refuses as `read` does. Holding changes is a requirement of its own (CTL-42), also after a revocation or in a capacity conflict | A: with decisions of several devices merged, concurrent `read` and revoke could end in writing. G: a member the creator has not named yet waits as a reader. A member may read the content and still comment on a layer (LAY-5). |
| YJS-1 | A document of `yjs-paragraphs/1` holds no JSON content or `Any` value nested more than 32 levels | No receiver of the profile reads such an update (Appendix A); SND-26 refuses the change. |

**New:**

| Requirements | What | Why |
|---|---|---|
| FRM-13 | Which reason a frame with several faults is rejected for: the version before the kind, the kind before the fields | A frame of another version is judged by its version alone, which is what an application shows a person (VER-4). |
| FRM-9 to FRM-12 (with FRM-15 to FRM-17) | Extension fields, `crit`, their bounds and what a definition states: an extension's name (FRM-15), checking the value of an extension one implements (FRM-16); an extension is not passed on (FRM-17) | C; wappensc/tdsp#71: ignoring an extension is not passing it on. |
| ARC-5 | An application may carry a document's content and binding between one person's devices through another service, and tells the person; control state only between devices of the creator, which continue under a new tag and are bootstrapped by it only if it was bootstrapped there (with CTL-25, RSY-14) | ARC-1 concerns participants, not one person's devices, which a messenger without history cannot bring up to date. Two devices under one tag would meet at every decision made at one clock (CTL-22). A member takes control state only from the channel or from what it persisted on that device (CTL-39). |
| INV-9 | Joining on another device of the person without asking again, when the confirmation travels from where the person gave it | INV-3 protects the creator's identity; the service that carries it is trusted as the person's machine. |
| INV-10 | The `MUST` of §11.3's opening as a requirement of its own | Without an ID §1.3 left it informative; the content is unchanged |
| TRN-20 (with TRN-22) | A send refused as `needs-person` is kept, shown, and tried again when the person acted, or after the longest back-off (TRN-22) | The person can lift the refusal and waiting cannot. |
| TRN-23 (with TRN-14) | A transport carries frames of at least 4 MiB; an engine fails the creation or join of a document on a smaller one, and obtains the profile before it registers a document it creates | Two devices of the creator decide apart, and their merge may hold more than an answer of a small transport carries, within the bounds every receiver holds (CTL-30): nobody new could be bootstrapped, and nothing would say so. A refused transport keeps no document registered. |
| TRN-18 (with TRN-21), TRN-19 | An optional cursor with `truncated`, in the window's order (TRN-21); a bridge instance id that changes whenever the bridge may have lost something | E: the engine continues after the last delivery it read; a gap the bridge skipped, or a loss in a restart, it cannot see by itself. |
| CTL-20 to CTL-23, CTL-25 to CTL-27, CTL-43, CTL-45, CTL-46 (with CTL-38) | Registers with a clock and a device tag, the later clock holding, the narrower value only at a tie; a device's own clock, at most 24 hours ahead of its wall clock, above every register of the target it decides (CTL-45); every answer's snapshot merged register by register; persistence with the clock, or holding every message instead (CTL-38); a new device of the creator merges answers but is bootstrapped only by another of her devices or its own state, decides nothing but the close and its reason before (CTL-27), and its application asks for another device and offers to close as `creator-state-lost` (CTL-43, CTL-46) | A: a clock above everything its device knew orders a decision after what it saw, whatever the wall clocks say; the span keeps one register far ahead from dragging every clock along. H: what members pass on brings a new device the creator's decisions; a new device of the creator's takes her state only from her devices (CTL-46). |
| CTL-23 (with CTL-36, LIF-6, LIF-7, VER-5) | A register on `close-reason`, set by a device of the creator with its close or after it, refused before as `not-closed`: one of four codes or an application's own (`application-reason`, as FRM-15 names an extension), of at most 128 bytes, the greater string at a tie; presented and shown only once the document is closed; outside every bound like the close; a later minor revision may add codes | A person who sees a document closed learns why, in their own language, and an application can tell its own close from the person's. As a register it needs no merge of its own; a newer code costs an older receiver the reason, never the close. |
| CTL-39, CTL-41 (with LIF-8 and CTL-40) | Any participant may persist its control state and restore it on that device; a member that read on from the cursor persisted with its content without a gap is bootstrapped by it; never a cursor ahead of the control state restored with it (CTL-40) | E: a restarted 1.x member waited for the creator before it edited. One that reads on without a gap stands where one that never restarted stands; a cursor ahead would read past a revocation unseen. |
| LIF-8 (with RSY-21) | An application persists with content when the last read that reached the messenger began, and tells a restarted engine that time, how long its transport keeps a message and whether it unbound the document; a running one it tells of a read that reaches the messenger again | E, H: where a transport cannot tell what it no longer holds, the time tells the engine that it may lack something (RSY-21); a device that slept cannot see its absence. |
| RSY-20, RSY-21 | Any member answers a request to all at a turn derived from the request and its own stream, falls silent once it heard an answer that holds what it would give, and lets the request go at its turn with nothing to offer; every request asks all but the first of a bootstrap, and that one too in a return — a restart after longer than the transport keeps, or of a document unbound meanwhile, or of a device of the creator without content, and such an outage of a running engine —, which wakes every resting gap a running engine holds and ends once a request of it to all was answered or two expired | H: those who answer at once are asked first; asked all, the members' answers spread so that one usually suffices. A gap heals only through whoever holds what is missing, mostly a member (I). A returning device may lack what nothing shows, and an answer may be lost on its way to it alone. |
| LIF-9, LIF-10 | An application keeps the channel and the rights in step — a permission before the invitation, a revocation before or as it removes a person —, compares the two, shows where they differ and changes neither without its person; where the binding cannot add or remove a member, it shows that | G: within the channel rights are as strong as the participants' engines; who takes part at all is the channel's. |
| PRF-1, item 9 | Reading an update and a state vector without applying them; one the profile cannot read rejects its frame (§4.4) | A frame is checked whole before anything of it applies (FRM-6), and CRDT libraries fail differently on bytes they cannot read. |
| LOS-12; PRF-1, item 8 | State and control digests beside the state vector and the control clock in reports, requests and an answer's last piece; a receiver compares what it deleted within a sender's vector, control digests at equal clocks, of reports only, never of `control` frames; evidence ends as LOS-18 says, and a difference lapses once its stream was not heard for the absence of RSY-1 | wappensc/tdsp#71: a vector counts what was inserted and a clock how late the latest decision is, so a lost deletion, close or register under an equal clock went unseen; the digest costs 8 bytes. Compared at equal vectors only, a lost deletion would stay unseen at a receiver that has edited since. A `control` frame carries nothing that orders it among its device's frames, so one that arrives late would show a difference that is none; a report of a stream that no longer runs would show one for good. |
| LOS-13, LOS-14 (with LOS-17, LOS-18, LOS-21 and LOS-22) | Streams: reports, requests and answers name their sender's engine as it runs and number its frames; a report replaces only an older one of its stream; an answer applied whole, or whose last piece's state or a later one is held, ends a difference in digests up to its number (LOS-18); an answer's pieces are numbered, the last with the count, and one with a piece missing is evidence until it is whole or the stream's state at a higher number is held | Kept by member, a lagging device's report would end the evidence another device's had shown, and a receiver that holds more than an answer could not tell whether a piece is missing. |
| LAY-5, LAY-6 (with LAY-7), CTL-4 | A member's right on a layer, inherited from the document where none is set or it was reset (`null`); at a tie `read` before inherit before `write` (CTL-23), the narrowest effective right; none for a revoked member; enforced by the sending engine, a change touching a layer it may not write refused whole (LAY-7); no register names the creator (CTL-4) | wappensc/tdsp#33 (L5) and #50 (no. 2): commenting on content one may only read, and its opposite. With inherit as the narrowest value at a tie, a reset and a restriction could let a member write who should only read. |
| CTL-30, CTL-32 (with CTL-34, CTL-36, CTL-37) | Bounds: 5 000 members and rights on layers, beside the pace and the reason, and 3 MiB, measured at a fixed width per target; a creator decides nothing the bounds or one answer could not hold, a new target only up to 1 MiB; beyond them, a capacity conflict: no new target, no edit of one's own, no control state handed on, shown until a person resolves it; the close and its reason outside every bound, the reason only where an answer can still carry it (CTL-36) | A: registers of any number of devices would otherwise let a broken creator application make every receiver keep anything (§1.7, item 11). Refusing what passes the bounds whole keeps receivers of the same registers alike, in any order; a full document must still be closable, and say why. |
| RSY-16, RSY-17 | A control clock and digest, `force` and `all` in requests, `null` until the requester is bootstrapped; when to answer, judged by the furthest the requesting stream stated; no held request reconsidered after its requester's wait | A: a device that holds everything but is not bootstrapped would otherwise never be answered; a request read late must not be answered with what its requester holds by then; reconsidered without end, an unanswered request would be answered by every member after the next change. |
| SND-15, SND-16 | The pace, local pacing; each engine bounds the pace it runs (10 min recommended) | B; a pace of days would hold every report and answer for as long; what a receiver judges by the pace is its own waiting, so differing bounds raise no false alarm. |
| SND-27, SND-28 | The report that ends a phase carries its last `edit` again, byte for byte, where it is whole and fits, or follows its last `control` frame sent again; a receiver applies it as an edit; a report is owed from the first frame of its phase until the transport accepted it or refused it for good, observable, persisted with the content on that device, and sent at the next start | I: one message per pause, and a lost last change heals whether its sender is still online or not; only what went out is carried. |
| SND-26 | An engine refuses a change of its own that its profile does not read as one update, reports it and merges it with no other | Every receiver would refuse it (FRM-6), and with it every change sent in the same message; the sender alone would hold it, and could bootstrap no one. |
| SND-25 | Every duration is measured on a clock that does not run back; only CTL-45's clock reads the wall clock (§1.6) | Measured on a wall clock set back, every wait would last as long again. |
| SND-17 to SND-19 | Pieces | D. |
| LOS-9 | The cursor and the instance id replace LOS-8's guess; a new instance is evidence, after a restart one other than the instance restored (§6.3) | E: a restarted bridge shows even without a cursor. |
| LOS-10 | A control clock of the creator above every clock held, stated in a report; a `control` frame is no evidence | A. A register that only members hold stays with them (CTL-46, §10.6). A report orders itself by its stream and number (LOS-13), a `control` frame not at all. |
| LOS-25, LOS-26 (with LOS-6, LOS-18) | A gap of one stream with its position; its first request after its own place in the answer window, at most three requests to all per gap, the waits at least doubling up to a longest wait (Appendix B), then it rests, shown, until a frame that raises its position, or a frame of the member named as the writer of its CRDT client, wakes it, at most once in 10 min, or an absence longer than a start request's or a return the application tells of, or the person, does | I: a gap nobody reachable can heal must not spend the tries of a later loss of another stream, and resting costs nothing until its writer is back — under a new client id after a restart, but the same member. Placed apart, receivers with the same gap ask once (RSY-22). |
| LOS-27 | A new CRDT client id at every start | I: two engines under one client id would give two updates one clock, and a gap's position would not be one writer's. |
| RSY-22 | An automatic request for gaps is let go when another's request to all heard within its expiry reaches no further, and counts as made; the answers to that one are taken | I: five devices with the same gap cost one request and one answer. |
| LIF-11 | A device of the creator that holds the close sends it again, at most once per member in 10 min and once per read, when someone edits the closed document, but not for what its first read after a start brings | I: a member that lost the close, its repeat and the report after them writes on, and nobody can tell from an edit that a close came before it. |
| LIF-12 | An application tells its engine when the person stops using the document and before sleep, tells a running engine how long it was away, and offers to synchronise now | I: the report goes before the device does; a running engine cannot see its absence; the person may know that another device is online again. |
| LOS-15 | The `MUST NOT` of §10's opening as a requirement of its own | Without an ID §1.3 left it informative; the content is unchanged but for the creator's unanswered request (LOS-20) |
| LOS-23 (with PRF-1, item 2) | What an engine holds for missing predecessors is bounded, given up beyond as *history truncated*; a profile says how | 1.x bounded the buffer of fragments; pieces wait in the CRDT's pending structures, which anyone in the channel can fill. |
| LOS-24 | The definition of a digest, of the state digest and of the control digest | A definition every receiver compares across implementations needs an ID |
| YJS-4 | A receiver applies content YJS-1 forbids, and projects it one way | A CRDT cannot refuse part of the state it converges to, and engines that project it differently disagree about every attribution offset after it. |
| VER-3 | The drafts of 2.0 are another version, their persisted control state none | A draft must never leave frames, nor a persisted state, that the released 2.0 reads as its own. |
| VER-4 | An application shows whose frames are of another version | VER-1's loud failure reached only the application, and the person saw a silent participant instead. |
| VER-5 (with VER-6) | What a revision that defines a new right must define (VER-6); a later minor revision may define further codes of `close-reason` | The rules any later right must keep are laid down now; the later decision holds, so a value needs only a place for a tie. |
| SEC-1, SEC-2 | The `SHOULD` of §15.3 and the `MUST` of §15.5 (email without PGP) as requirements of their own | Without an ID §1.3 left them informative; the content is unchanged |
| JSN-1 | The `SHOULD` of §1.6 to check the nesting depth in one pass, as a requirement of its own | Without an ID §1.3 left it informative; the content is unchanged |

**Moved** into [bindings/](bindings/) (F): §12 (BRG-1 to BRG-17), §12.6 (LBI-1 to
LBI-6, the routes gaining an optional cursor and instance), §13 (BND-1 to BND-3,
SIG-1 to SIG-3, MTX-1 to MTX-4, EML-1 to EML-12) and Appendix C — unchanged in
substance, but for these, and with BRG-18, BND-4, SIG-4 to SIG-7, MTX-5 to MTX-7,
EML-13 and EML-14 new:

| Requirements | Change | Why |
|---|---|---|
| BRG-1, BRG-8, LBI-6 | Five reasons of §3.4: a send while the bridge is not provisioned, and every refusal only a person can lift, is `needs-person`, `409` locally; where the messenger reports such a refusal as one that passes, the bridge says `unavailable` until it can tell them apart; `Retry-After` reaches the engine as `retryAfterMs` (LBI-6, TRN-11) | 409 meant a state the person ends (TRN-11); taken for `needs-person` at once, a passing refusal would hold every message for the longest back-off. |
| BRG-2 | Provisioning keeps credentials from components that render what came through the channel, as ARC-4 | As ARC-4. |
| BRG-9; MTX-7 (new) | The choice between body and attachment may go by the size of the envelope as written; Matrix measures it so, at 32 000 bytes | Escapes in the envelope and Megolm's Base64 let a frame of 32 000 bytes exceed Matrix's 65 536 bytes per event, and a frame within `maxBytes` was refused as too large. |
| BRG-11, BRG-12, SIG-3 | The same message again (same id, same content) is dropped; another message under a delivered id is recorded, not delivered; content is compared before anything is fetched — in the body by its bytes, an attachment by its hash, an encrypted file also by key and iv —, and what it is compared by is kept with a delivery id kept across a restart; nothing is recorded for a message the bridge does not take (BRG-10, MTX-5); a shared vocabulary of reasons; membership asked anew each time | The texts did not tell the two apart, and a remembered "not a member" dropped the first frames of whoever just joined. An encrypted file's hash is that of its ciphertext; an id kept without what it was compared by cannot tell a message presented again from a replaced one. |
| BRG-14 | A binding says where the messenger's own client fetches attachments, a fetch the bridge cannot bound | §15.5 promised a bound that, on such a messenger, nothing enforces. |
| BRG-15 | The integrity log holds violations and notices, each with a `kind`; a notice names the `recipient` it concerns; so does the local bridge interface's route | A recipient a send skipped (SIG-4) is nothing done to the channel. |
| BRG-17 | A bridge may drop a delivery once the one reader it serves kept it | A bridge that keeps its window on disk need not keep a frame's text a second time; a cursor from before still reads as truncated. |
| BRG-18 (new) | A message a bridge cannot read never keeps it from reading the others; values nested too deep in a messenger's answer may be dropped | One deeply nested event in a Matrix `/sync` stopped a bridge for good: the answer never parsed, and its position never moved. |
| LBI-1 | A bridge listens on a loopback address only, such as `127.0.0.1` or `::1`: any address of §12.6's definition, not only these two | The definition already took in `localhost` and all of `127.0.0.0/8`, and naming two addresses read as excluding the others. |
| BND-1 | A binding states against whom each property holds, the provider's servers included; the Signal and email bindings say so, as inherited or as added | An encrypted Matrix room protected against the homeserver only in the wording; MTX-4 is where it does. |
| BND-3 | The 64 hexadecimal digits are ASCII | A Unicode test for hexadecimal digits takes full-width forms too, a second spelling of the same hash. |
| BND-4 (new) | The `MAY` of §13.1 to carry a frame as an attachment, as a requirement of its own | A `MAY` without an ID, which §1.3 left informative although it was meant to apply; the content is unchanged |
| EML-13 (new) | The part of 1.x's EML-8 on what an application shows of the creator's key, as a requirement of its own | It was a part of a longer requirement, and requires what it did there |
| EML-1, EML-2; EML-14 (new) | The participant set only shrinks: the creator's bridge sends a removal notice into the thread, and every bridge removes that participant from the set it holds, never adding one back; a message is taken when its sender is in that set and its recipients cover it, beyond it only participants already removed | Without "removal wins" (§15.4) a revocation alone may be undone by a concurrent grant; the channel's removal ends what a person receives (§6.6), and an email thread had none. |
| SIG-4, SIG-5 (new) | When a group send is accepted, by `signal-cli`'s result per recipient, each recipient skipped as an identity to trust a notice (BRG-15); a bridge reads a connection before `signal-cli` pushes into it | `signal-cli` reports a group message sent once one member got it, and hands each waiting message to a device once; a member whose identity changed receives nothing while every send succeeds. |
| SIG-7 (new) | A send `signal-cli` refuses because it cannot load the account is `unavailable` while the bridge's link status, which SIG-7 defines, shows the device linked, `needs-person` once it shows it unlinked | `signal-cli` refuses so for a passing failure and for an unlinked device alike; only the second waits for the person. |
| SIG-6 (new) | A bridge that receives through a subscription reads before it subscribes, on every connection, and keeps its instance across ending it only if its `signal-cli` hands on the message in hand | `signal-cli` 0.14.9 drops the message it is handling when the last subscription ends. |
| MTX-4, MTX-5 (new) | Room keys only to devices their owners signed, the bridge's own signed, frames only from signed devices, and none to or from a changed identity until a person agrees; MTX-5 (new): an unencrypted TDSP event in an encrypted room is ignored without a record, and that the room was seen encrypted is persisted | A key shared with every device reached any device a homeserver added; Matrix clients now exclude unsigned devices (MSC4153). A homeserver can place an unencrypted event under any member's name. |
| MTX-6 (new) | The wait of a Matrix rate limit from the `Retry-After` header, the body's `retry_after_ms` only without one | Matrix 1.10 moved the wait into the header (MSC4041). |

**On the wire:** frames carry `"tdsp": 2`; a `control` frame carries registers
(`targets`, each a `value`, a `clock` and a `device`), the flag `closed` and its
device's `controlClock` and `controlDigest` instead of a numbered action, and may
aim at a member's right on a layer and at the reason for the close
(`close-reason`); a `heartbeat` carries a control clock and control digest or
`null` instead of `controlSequence`, and may carry `update`, its sender's last
edit again; a `resync-request` carries a control clock and control
digest or `null`, `force` and `all` instead of `controlSequence` and `bootstrap`;
a `heartbeat`, a `resync-request` and every piece of a `resync-response` name
their sender's stream and a number in it, and every piece of an answer its own
number, the last the count; the snapshot is one register per target with the flag
`closed`; the `fragment` kind is gone;
any frame may carry extension fields and `crit`; a `heartbeat` and a
`resync-request` carry a state digest beside their state vector, and an answer's
last piece the responder's state vector and digest; an overlay's range may name no author
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
  core is simpler to build than 1.x's ([CONFORMANCE.md](CONFORMANCE.md)).

Also not in 2.0, and possible without a change of this core: *carrying a document
between one person's devices over TDSP* (ARC-5) — through a channel of only that
person's devices, with a profile of its own, instead of another provider's
storage.
