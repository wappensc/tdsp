---
title: "Confirming the Matrix bridge's device"
summary: "Why Element users see nothing from an unconfirmed Matrix bridge (MSC4153), how pnpm run matrix:confirm-device signs the bridge's device with the account's self-signing key from Secret Storage, what it checks and keeps, and why interactive verification is left for later."
read_when:
  - "Setting up a Matrix bridge for an account that people also use in Element or another Matrix app"
  - "Element shows a TDSP bridge's messages as undecryptable, or warns about its device"
  - "Changing bridges/matrix-bridge/src/device-confirmation.ts or confirm-device-cli.ts"
  - "Considering interactive (emoji) device verification for the Matrix bridge"
---

# Confirming the Matrix bridge's device

## Why

The Matrix bridge logs in with an account and gets a device of its own. Matrix clients that
follow [MSC4153](https://github.com/matrix-org/matrix-spec-proposals/blob/main/proposals/4153-invisible-crypto.md)
hide every message from a device that its own account has not signed with its
cross-signing identity, and send it no room keys. Element made this its default, announced
for October 2026. People who read a document's room in Element then see nothing the bridge
posts, an invitation included.

Between bridges of this repository nothing changes: the crypto library the bridge uses
applies no such rule by default, and its L2 tests exchange encrypted frames between
unconfirmed devices. Confirming the device matters for the people in the room who use
another Matrix app.

The names in this file — MSC4153, cross-signing, self-signing key, Secret Storage, recovery
key — are Matrix's and Element's, not this repository's.

## How

The account must already have a cross-signing identity, as every account set up in Element
does. With the bridge running, in its directory and with its environment:

```sh
pnpm run matrix:confirm-device               # the bridge at http://127.0.0.1:$PORT (8788)
pnpm run matrix:confirm-device http://127.0.0.1:8790
```

The command asks for the account's **recovery key** (Element calls it that; it opens the
account's Secret Storage) and does not show it while it is typed. Piped into standard input,
the first line is read instead. It answers that the device is now signed, or that it already
was. A new access token from a new login is a new device, which needs confirming again.

The recovery key never travels in an argument, an environment variable, a file or the
bridge's HTTP interface, which applications reach (BRG-2). The command reaches the
homeserver through the bridge's own `matrix-api.ts` and the bridge only for `GET /device`,
on loopback; `network-policy.json` names both.

## What it does, and what it checks

1. It asks the running bridge which device it is: `GET /device` answers its device id and
   public Ed25519 key. This endpoint belongs to the Matrix bridge only; it is not part of
   the local bridge interface (`bindings/local-bridge-interface.md`, §12.6).
2. It checks that the access token belongs to that device.
3. It reads the account's Secret Storage key description and the encrypted
   **self-signing key**, and has the crypto library (`SecretStorageKey` of
   `@matrix-org/matrix-sdk-crypto-nodejs`) decrypt that one key with the recovery key. A
   recovery key that does not open Secret Storage signs nothing.
4. It checks that the decrypted key is the self-signing key the account publishes.
5. It checks that the device keys the homeserver lists for the device are the bridge's own:
   same device, same Ed25519 key as the bridge reported, and carrying the device's own valid
   signature. A homeserver therefore cannot get another device, or other keys, signed.
6. It signs those device keys (canonical JSON, Ed25519) and uploads the signature.

The master key and the user-signing key are never decrypted. The self-signing key is held
for the one signature and then dropped; nothing is stored. The Base64 text the library
returns cannot be cleared from memory, so the key stays in the process's memory until it
ends, which it does right after.

## Why not the library's own import

`OlmMachine.importSecretsFromSecretStorage` signs the device as well. It also keeps all
three private cross-signing keys, the master key included, in the bridge's crypto store,
and the library offers no way to remove them. That store is protected by file permissions
only. A copy of it would let anyone confirm any device of the account and verify other
people in its name, and unlike an access token, a leaked master key cannot be revoked
without resetting the identity. Signing with the self-signing key alone costs this module
canonical JSON and one Ed25519 signature; decrypting Secret Storage stays the library's.

Tried against a local Synapse: the library's `SignatureUploadRequest` wraps the signatures
in a `signed_keys` field, which `POST /keys/signatures/upload` does not take (Synapse
answers 200 and lists the refusal under `failures`). `uploadSignatures` therefore sends the
map the Matrix specification defines, and throws on any listed failure.

## Not done: interactive verification

The usual way to confirm a new device in Matrix is interactive verification: the bridge
asks the person's other Matrix app, both show the same emoji, and the person confirms in
both. No secret then leaves that app, and the bridge never holds a private cross-signing
key, not even for a moment.

`@matrix-org/matrix-sdk-crypto-nodejs` (0.6.6, the newest release) has no API for it.
Interactive verification would mean moving the bridge to another binding of the same Rust
library, such as `@matrix-org/matrix-sdk-crypto-wasm`, which does expose verification;
that has not been tried here. The move would replace `crypto-machine.ts`, change how the
crypto store is persisted, and need its own licence and network checks.

Within 1.x the reference implementation keeps such changes small: the recovery key works
with the library the bridge already uses and adds one module. Interactive verification
stays the better design and is the natural next step if the bridge moves to another crypto
binding.

## Tests

- `device-confirmation.test.ts` (L0): canonical JSON, and the Matrix specification's own
  JSON-signing test vectors.
- `device-confirmation.security.test.ts` (L0, CI role): only the bridge's own, genuine
  device keys are signed, only with the published self-signing key; a wrong recovery key,
  the master key in the self-signing key's place, another device, another user, another
  identity key, a swapped Curve25519 key or a missing or forged device signature signs
  nothing.
- `device-confirmation.live.test.ts` (L2): against a local Synapse, another device sets up
  an identity and Secret Storage as Element does; the bridge's device is then signed by the
  self-signing key, a second run changes nothing, a wrong recovery key changes nothing, and
  the bridge's crypto store holds no private cross-signing key afterwards. An account
  without an identity is refused.

**Not tried:** Element itself. That a signed device's messages are shown again rests on
MSC4153, not on a run with Element.
