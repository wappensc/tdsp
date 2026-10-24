import type { TransportProfile } from "@tdsp/messenger-port";
import type { TlsMode } from "./tls-policy.ts";

/**
 * What this bridge says about its own limits, served at `GET /transport-profile`
 * (SPECIFICATION.md §3.5): the bounds no pacing may cross and the pacing it suggests.
 * `document-protocol` clamps every pacing — the pace the creator sets and each participant's
 * own — to the bounds, so nothing can make a client exceed what its mail provider
 * tolerates (SND-15).
 *
 * **Which profile depends on what is behind this bridge.** A mail server on this
 * machine (`tls === "plaintext-loopback"`: the local Greenmail test server) has no
 * sending limit, so it gets no bounds and a pacing equal to the engine's own defaults — no
 * floor, no cap (TRN-15). Every field is still written, "none" as `null` (SPECIFICATION.md
 * §3.5). Anything else is a provider.
 *
 * **What is measured and what is not.** The one figure behind the provider profile is
 * a *measurement of one provider*: GMX refused to send after roughly 35 mails in 20
 * minutes on new accounts, about one per 34 s, and a message took 8 to 35 s to
 * arrive. The **30 s floor is a decision**, taken from several independent sources
 * on providers' limits rather than measured first. Everything else — the 120 s
 * deadline, the 60 s latency (about twice the slowest hop seen) and the 15 s bound — is an
 * **estimate**, to be replaced by numbers from a second provider. A slower pacing for a
 * stricter provider is the application's to offer (§3.5).
 *
 * **The size bound** makes a change too large for one mail go as pieces rather than be
 * refused by the provider and dropped (SPECIFICATION.md §9.4). It is sized
 * for a mail of at most 8 MiB, a margin below the roughly 10 MiB providers commonly accept
 * (not verified against one). Measured with nodemailer and gpg on an incompressible 1 MiB
 * frame: a mail is 1.39 bytes per frame byte without PGP (Base64 in the JSON envelope, then
 * quoted-printable) and 1.81 with PGP (the ASCII armour on top, compression off — the worst
 * case). 8 MiB / 1.81 is about 4.4 MiB, so the bound is 4 MiB — a mail of at most about 7.6 MiB,
 * and the same bound the Signal and Matrix bridges state. The largest frame sent through a
 * real provider so far is 6 KB.
 */

export const EMAIL_PROVIDER_PROFILE: TransportProfile = {
  bounds: { minIntervalMs: 15_000, maxBytes: 4 * 1024 * 1024 },
  // One message at most every 30 seconds — sized for a provider that refuses after about 35
  // mails in 20 minutes.
  pacing: {
    minIntervalMs: 30_000,
    maxIntervalMs: 120_000,
    minChars: 0,
    maxChars: null,
    expectedLatencyMs: 60_000,
  },
};

export const EMAIL_LOCAL_PROFILE: TransportProfile = {
  bounds: { minIntervalMs: null, maxBytes: null },
  pacing: {
    minIntervalMs: 0,
    maxIntervalMs: null,
    minChars: 0,
    maxChars: null,
    expectedLatencyMs: 0,
  },
};

export function transportProfileFor(tls: TlsMode): TransportProfile {
  return tls === "plaintext-loopback" ? EMAIL_LOCAL_PROFILE : EMAIL_PROVIDER_PROFILE;
}
