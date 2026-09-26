import type { TransportProfile } from "@tdsp/messenger-port";
import type { TlsMode } from "./tls-policy.ts";

/**
 * What this bridge says about its own limits, served at `GET /transport-profile`:
 * the send policies it suggests and the bounds no policy may cross.
 * `document-protocol` clamps every policy — the creator's, an invitation's, a message
 * from someone who might be forging it — to the bounds, so a bad policy can make a
 * document slower but never make a client exceed what its mail provider tolerates.
 *
 * **Which profile depends on what is behind this bridge.** A mail server on this
 * machine (`tls === "plaintext-loopback"`: the local Greenmail test server) has no
 * sending limit, so it gets no bounds and one profile holding the engine's own
 * defaults — no floor, no cap. Every field is still written, "none" as `null` (SPECIFICATION.md §3.5). Anything else is a provider.
 *
 * **What is measured and what is not.** The one figure behind the provider profile is
 * a *measurement of one provider*: GMX refused to send after roughly 35 mails in 20
 * minutes on new accounts, about one per 34 s, and a message took 8 to 35 s to
 * arrive. The **30 s floor is a decision**, taken from several independent sources
 * on providers' limits rather than measured first. Everything else — the 120 s
 * deadline, the 60 s latency (about twice the slowest hop seen), the 15 s bound and the
 * "patient" profile — is an **estimate**, to be replaced by numbers from a second
 * provider.
 *
 * **The size bound** makes a change too large for one mail be split into fragments rather
 * than refused by the provider and dropped (SPECIFICATION.md §15.1, FRG-1). It is sized
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
  profiles: [
    {
      id: "standard",
      label: "Standard",
      description:
        "One message at most every 30 seconds — sized for a provider that refuses after about 35 mails in 20 minutes.",
      values: {
        minIntervalMs: 30_000,
        maxIntervalMs: 120_000,
        minChars: 0,
        maxChars: null,
        expectedLatencyMs: 60_000,
      },
    },
    {
      id: "patient",
      label: "Patient",
      description:
        "One message at most every minute, for a stricter provider or a document with many participants.",
      values: {
        minIntervalMs: 60_000,
        maxIntervalMs: 300_000,
        minChars: 0,
        maxChars: null,
        expectedLatencyMs: 120_000,
      },
    },
  ],
  defaultProfile: "standard",
};

export const EMAIL_LOCAL_PROFILE: TransportProfile = {
  bounds: { minIntervalMs: null, maxBytes: null },
  profiles: [
    {
      id: "local",
      label: "Local test server",
      description: "A mail server on this machine has no sending limit.",
      values: {
        minIntervalMs: 0,
        maxIntervalMs: null,
        minChars: 0,
        maxChars: null,
        expectedLatencyMs: 0,
      },
    },
  ],
  defaultProfile: "local",
};

export function transportProfileFor(tls: TlsMode): TransportProfile {
  return tls === "plaintext-loopback" ? EMAIL_LOCAL_PROFILE : EMAIL_PROVIDER_PROFILE;
}
