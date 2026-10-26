---
title: "Bridge logging"
summary: "How the Signal, Matrix and email bridges log through packages/bridge-log: one structured line per record, safe against injection, floods and secrets by construction, the event catalogue, the LOG_LEVEL, LOG_FORMAT and LOG_FILE settings, and what is never logged."
read_when:
  - "Running a bridge and reading or configuring its log"
  - "Adding or changing a log event in a bridge"
  - "Checking what a bridge never writes to its log"
---

# Bridge logging

`bridges/signal-bridge`, `bridges/matrix-bridge` and `bridges/email-bridge` log
through one small, dependency-free package, `@tdsp/bridge-log`
(`packages/bridge-log`). Nothing else in these processes writes to the console.
Browser code never imports it.

## Why it is more than `console.warn`

What these processes log is largely **attacker-influenced**: a rejected forged
message carries a sender, a document id and a reason, all chosen by whoever
sent it. The logger is built around that:

| Property | What it guarantees |
|---|---|
| **One record, one line** | Newlines and control characters in a field cannot start a fake line — JSON escapes them, and the text format quotes anything that isn't a plain identifier. A forged sender of `x\n{"level":"info","event":"all-clear"}` stays one `warn` record. |
| **Bounded fields** | A string longer than 500 characters is cut (`…(+N chars)`), so a megabyte-long forged sender cannot fill a disk. |
| **Fixed keys can't be overwritten** | A caller field named `time`, `level`, `component` or `event` is renamed with a trailing `_`. |
| **Secrets redacted by name** | Any field named like `password`, `passphrase`, `secret`, `token`, `authorization`, `credential` or `private` is written as `[redacted]`, at any depth. A safety net, **not** permission to pass one in. |
| **A flood is limited, and says so** | `warn` and `error` are limited per event name (default 20 per minute); the drop is itself logged as one `log-suppressed` line with a count, so suppression is never silent. `info` and `debug` are not limited. |
| **Logging never throws** | A closed stderr or a full disk cannot take a working bridge down. If the log file cannot be written, that is reported once on stderr and logging continues to stderr. |

## Configuration

Environment variables, read once at startup (see each bridge's `.env.example`):

| Variable | Values | Default |
|---|---|---|
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error` | `info` |
| `LOG_FORMAT` | `json`, `text` | `text` on an interactive terminal, else `json` |
| `LOG_FILE` | a path | none — stderr only |

A bad value is reported once (`invalid-log-configuration`) and the default is
used: a typo must not stop a bridge from starting. `LOG_FILE` is created with
mode `0600` and **is never rotated** — the lines name senders and document ids
(metadata), so treat the file as sensitive and rotate it externally.

## Record shape

```json
{"time":"2026-09-20T05:12:45.000Z","level":"warn","component":"email-bridge","event":"message-rejected","reason":"pgp-signature-invalid","documentId":"doc-1","messageId":"<m1@example.org>","sender":"mallory@example.org"}
```

`time`, `level`, `component` and `event` are always present; everything else is
the event's own fields. Event names are stable and lower-kebab-case, so they can
be grepped or alerted on.

## Events

| Event | Level | Bridge | Meaning |
|---|---|---|---|
| `listening`, `shutting-down` | info | all | Lifecycle; `listening` carries the URL, `shutting-down` the signal. |
| `failed-to-start` | error | signal | The bridge could not start; carries the error. |
| `message-rejected` | warn | email | An inbound message was rejected instead of applied, with one of the integrity-log reasons (SPECIFICATION.md EML-2, EML-3, BRG-12). Fields: `reason`, `documentId`, `messageId`, `sender`. Logged once per message. Also served at `GET /channels/:documentId/integrity-log` — the log is what survives a restart. |
| `unsupported-envelope-version` | warn | all | A recognisable TDSP envelope of another version (`tdsp` a number other than 1) arrived for a document this bridge has bound; it was not delivered (SPECIFICATION.md BND-2, VER-1). Fields: `documentId`, `version`, and the message's `eventId` (Matrix) or `messageId` (email). The usual cause is a participant running a newer bridge. |
| `mail-tls` | info | email | At startup, once a mailbox is configured: how the SMTP and IMAP connections are secured (`implicit`, `starttls-required`, or `plaintext-loopback` — the last only ever for a server on this machine). Fields: `smtp`, `imap`. |
| `invite-rejected` | warn | email | A participant's bridge refused a PGP document's invitation when joining (bindings/email.md EML-5, EML-8). Fields: `reason` (one of the `invite-*` reasons, or `recipient-list-mismatch`), `documentId`, `messageId`, `sender`, `detail`. Nothing is stored for a refused invitation. |
| `key-deviation` | warn | email | On joining a PGP document, the user's own keyring holds a *different* key for a participant than the creator's invitation named. Fields: `documentId`, `address`, `creatorSent`, `inYourKeyring`. The document keeps using the creator's key; this is the notice, not a refusal. Also served live at `GET /pgp/keys`. |
| `creator-key-unverified` | warn | email | On joining, the user's own keyring holds no key for the document's creator, so nothing independent backs the invitation. Fields: `documentId`, `creator`, `fingerprint`. |
| `sent-copy-failed` | warn | email | A frame mail went out, but its copy could not be put into the account's sent folder (bindings/email.md EML-12), so another device of this address will not see it there; a resync still brings it. The send stands and is not retried. Fields: `documentId`, `messageId`, `error`. |
| `key-comparison-failed` | warn | email | Comparing the creator's keys with the user's keyring failed after a successful join (the join stands). Fields: `documentId`, `error`. |
| `attachment-unavailable` | warn | matrix, signal | A frame sent as a media file or a Signal attachment (bindings/bridges.md BRG-14) could not be downloaded, and for a reason that will not pass (the file is gone, forbidden, or the request was refused); the frame is dropped, which loss detection treats as a lost message. Field: `status`. Neither the file's address nor a key is ever logged. |
| `attachment-rejected` | warn | matrix, signal | A downloaded media file was not what its event said and was dropped: `reason` is `too-large`, `size-mismatch`, `hash-mismatch` (altered or swapped) or `malformed` (an unusable key or IV). Field: `reason` (for Signal also `not-one-attachment`, `malformed`). |
| `attachment-given-up` | warn | matrix | A download that kept failing transiently (rate limit, timeout, server error, network) was abandoned after eight tries. Field: `attempts`. |
| `attachment-failed` | warn | signal | Reading a received attachment failed in a way nothing anticipated; the frame is dropped. Field: `error`. |
| `attachment-file-missing` | warn | signal | A received attachment's file was not where `signal-cli` should have put it (`<data dir>/attachments/<id>`); read anyway through `getAttachment`, but a wrong directory would leave every plaintext frame on disk unnoticed and unremoved. |
| `attachment-file-not-deleted` | warn | signal | The plaintext file of an attachment that was read could not be deleted. Field: `error`. |
| `signal-cli-output` | info | signal | Text `signal-cli` wrote to its own stderr. |
| `signal-cli-unparseable-line` | warn | signal | A line from the daemon that was not valid JSON-RPC. |
| `signal-cli-line-too-long` | warn | signal | A line from the daemon longer than the bridge reads (BRG-14); dropped unread, and the calls waiting on the daemon failed. |
| `signal-cli-sigkill-escalation` | warn | signal | `signal-cli` did not exit within 5 s of SIGTERM and was killed (a pending device-link session is the known cause). |
| `device-linked` | info | signal | A device link completed: `signal-cli` lists the account. No fields. |
| `device-link-failed` | error | signal | Completing a device link failed, or no account appeared within five minutes; carries the error. |
| `signal-cli-lost` | error | signal | The `signal-cli` daemon exited, its socket closed, or it pushed more before the bridge read it than the bridge keeps (SIG-5): the bridge can neither receive nor send, and ends with exit code 1, so that whoever runs it starts it again under a new instance (TRN-19). Field: `reason`. |
| `signal-cli-early-notifications-dropped` | warn | signal | More notifications arrived before the bridge's handlers existed than it keeps (SIG-5, bounded in count and characters); followed by `signal-cli-lost`. Fields: `kept`, `chars`. |
| `notification-unreadable` | warn | signal | A handler threw on a notification from `signal-cli`; the lines after it and the other handlers are read on (BRG-18). Fields: `method`, `error`. |
| `event-unreadable` | warn | matrix | Reading one event of a `/sync` round threw; the round's other events are delivered (BRG-18). Fields: `roomId`, `eventId`, `error`. |
| `attachment-unreadable` | warn | matrix | Reading an attachment that waited for another try threw; it is given up on (BRG-18). Field: `error`. |
| `message-unreadable` | warn | email | Reading one mail threw; the thread's other mails go on, and the mail is read again on the next poll, three times at most (BRG-18). Fields: `documentId`, `messageId`, `attempts`, `error`. |
| `to-device-event-too-deep` | warn | matrix | A to-device event nested deeper than SPECIFICATION.md §1.6 allows was left out of what the crypto machine reads. Field: `type`. |
| `integrity-violation` | warn | matrix, signal | An entry was recorded in a document's integrity log (BRG-12, BRG-15). Fields: `documentId`, the message's `eventId` (Matrix) or `id` (Signal), `reason`. |
| `edit-unattributed`, `delete-unattributed`, `redaction-unattributed`, `replacement-unattributed` | warn | matrix, signal | An edit, a remote delete, a redaction or another event under a delivered id that cannot be attributed to a document: of a message this bridge did not deliver, or from a room or group the document is not bound to (BRG-10, BRG-12). Nothing is recorded. Fields: the event or target id, `sender`. |
| `encrypted-event-redacted-before-delivery` | warn | matrix | An encrypted event was already redacted when the bridge first saw it; nothing is left to route it by. Field: `eventId`. |
| `unencrypted-frame-in-encrypted-room` | warn | matrix | A TDSP event arrived unencrypted in a room the bridge has seen encrypted, and was ignored (MTX-5). Fields: `roomId`, `eventId`, `sender`. |
| `log-suppressed` | warn | all | The rate limit dropped `suppressed` records of `suppressedEvent`. |
| `invalid-log-configuration` | warn | all | A `LOG_*` value was not recognised. |

## What is deliberately never logged

Message bodies and payloads, document content, key material (public or
private), passphrases, access tokens and mailbox credentials.
Identifiers (document ids, sender addresses, message ids) are logged because
diagnosing a rejection needs them; they are also exactly the metadata a log
reader should be assumed to learn.

## What this is not

- **Not a user-facing surface.** What an application shows is served by each
  bridge's `GET /channels/:documentId/integrity-log` (bindings/bridges.md BRG-15); the
  log is for whoever runs the bridge.
- **Not tamper-evident.** A plain file, written by the process it describes; a
  compromised bridge or a same-user process can alter it (the same-OS-user
  boundary of SPECIFICATION.md §15.2).
- **Not an audit trail with retention guarantees.** No rotation, no shipping.
