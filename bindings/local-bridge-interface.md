# TDSP bindings — The local bridge interface

**Specification · TDSP bindings 2.0 (draft) · 24 October 2026**

Part of TDSP 2.0, whose core is [SPECIFICATION.md](../SPECIFICATION.md). This
document holds what TDSP 1.4 had in §12.6 of its specification, unchanged in
substance but for the changes [Appendix G](../SPECIFICATION.md#appendix-g-changes-from-tdsp-1x)
of the core lists: its requirements keep their IDs, and its sections their numbers, so a
reference to either stays unambiguous. The requirement language and the
conformance classes are the core's ([§1.3](../SPECIFICATION.md#13-requirement-language),
[§1.4](../SPECIFICATION.md#14-conformance-classes)).

### 12.6 The local bridge interface (optional)

A bridge and its adapter may run in different processes — necessarily so when
the application is a web page ([§2.1](../SPECIFICATION.md#21-layers)), and usefully so when a bridge
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
([Appendix F](../SPECIFICATION.md#appendix-f-reference-implementation)) is this definition.

- **LBI-1** · *bridge* — A bridge offering this interface MUST listen on a loopback
  address only (such as `127.0.0.1` or `::1`), never on a wildcard or external
  interface.
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
| 409 | Refused until a person acts: not provisioned or not linked yet, signed out, an identity to trust, a device to confirm, storage full |
| 413 | Too large |
| 422 | Refused at message level |
| 429 | Rate-limited |
| 502 | Anything else that failed |
| 503 | A dependency is not configured; never for a send, which a bridge not provisioned refuses with 409 (BRG-1) |

**Routes.**

| Route | Purpose | Request | Response |
|---|---|---|---|
| `GET /health` | Liveness, and whether the bridge is provisioned; optionally the bridge instance → `instance` (TRN-19) | — | `{status:"ok", configured?: boolean, instance?: string}` |
| `GET /whoami` | The account's own MemberId | — | `{id}` |
| `GET /transport-profile` | The transport profile ([§3.5](../SPECIFICATION.md#35-transport-profile)) | — | the profile; 503 while unprovisioned |
| `GET /channels` | Channels for the picker → `listChannels` | — | `[{id, name, encrypted?}]` |
| `GET /members?channelId=` | A channel's members → `channelMembers`; by channel id, so not under `/channels/:documentId` | — | `[memberId]`; 404 for a channel this account is not in |
| `POST /channels/:documentId/bind` | Bind a document to a channel → `createDocument` | `{channelId, creator, profile}` | the binding |
| `POST /channels/:documentId/send` | → `send` | `{sender, payload}` — the frame's text; `sender` must be the bridge's own account (BRG-16), else 403 | `{deliveryId}` |
| `GET /channels/:documentId/deliveries` | → `receive` | — | `[{id, documentId, sender, payload}]` |
| `GET /channels/:documentId/deliveries-since?after=` | Optional → `receiveSince` (TRN-18, TRN-21); `after` absent for all still held | — | `{deliveries: [{id, documentId, sender, payload}], truncated: boolean}`; 404 where the bridge does not offer it |
| `POST /channels/:documentId/invite` | Send a human-readable invitation into the bound channel | `{actor, text}` — `actor` must be the bridge's own account and the document's creator, else 403 | `{deliveryId}` |
| `GET /channels/:documentId/integrity-log` | The integrity violations recorded (BRG-15) | — | a list of `{id, sender, reason, …}`, `reason` one of BRG-12's or one its binding names (SIG-4) |

Email has no pre-existing channel to bind to; starting and joining a thread
replace binding:

| Route | Purpose | Request | Response |
|---|---|---|---|
| `POST /threads/:documentId` | Start the thread: send the invitation, bind the document | `{recipients[], creator, profile, inviteText?, pgpEnabled?, threadRootMessageId?, policy?}` — `policy` is TDSP 1.x's; an application of TDSP 2.0 sends none | `{threadRootMessageId}` |
| `POST /threads/:documentId/join` | Join a thread from its invitation | `{recipients[], creator, profile, pgpEnabled?, threadRootMessageId}` | the binding (for PGP, including the invitation's profile, and a 1.x invitation's policy, which an application of TDSP 2.0 ignores) |

Provisioning routes are binding-specific: Signal's `GET /auth/status` and
`POST /auth/link`; email's `GET /mail/status`, `GET /pgp/status` and
`GET /pgp/keys`.

- **LBI-5** · *bridge* — A bridge MUST implement the routes above that apply to its
  messenger, with the request and response shapes given, and MUST NOT offer
  routes for membership, closing, deletion or resync ([§12.5](bridges.md#125-what-a-bridge-does-not-do)).
  *Rationale:* one interface shape lets any adapter drive any bridge.
- **LBI-6** · *bridge, adapter* — `POST …/send` MUST answer a failure with the
  status that classifies it: `429` (with `Retry-After` in seconds when the
  messenger stated a wait) for a rate limit, `413` for a message too large, `409`
  for a refusal only a person can lift, `400`, `403`, `404` or `422` for a refusal
  waiting cannot change, and `5xx` for everything else. An adapter MUST map `429`
  to `rate-limited`, with `Retry-After` passed on as `retryAfterMs` as TRN-11
  says, `413` to `too-large`, `409` to `needs-person`, `400`, `403`, `404` and
  `422` to `rejected`, and every other status to `unavailable`.
  *Rationale:* the classification of [§3.4](../SPECIFICATION.md#34-send-failures) has to survive the
  HTTP hop; an unclassified status landing on `unavailable` means a change is never
  dropped on a guess. `409` already answered a bridge not provisioned or not
  linked — a state the person ends, not one waiting ends — so it carries every
  refusal of that kind.
