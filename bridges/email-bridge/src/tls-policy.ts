import { isLoopbackHost } from "@tdsp/loopback";

/**
 * The bridge talks to a mail server over TLS, or not at all.
 *
 * `nodemailer` and `imapflow` both default to *opportunistic* STARTTLS when
 * `secure` is false: TLS if the server advertises it, plaintext otherwise. An
 * attacker who strips the `STARTTLS` capability from the server's greeting
 * therefore gets the bridge to send its password and every message in the
 * clear, with no error. This module removes that outcome by construction:
 *
 * - `secure: true` — implicit TLS from the first byte (SMTP 465, IMAP 993).
 * - `secure: false` towards any host but this machine — STARTTLS **required**:
 *   `requireTLS` (nodemailer) / `doSTARTTLS: true` (imapflow) make the
 *   connection fail, before any credential is sent, when the server does not
 *   offer it.
 * - Certificates are always verified (`rejectUnauthorized` is fixed to `true`
 *   here and there is no configuration that reaches it) and TLS 1.2 is the
 *   floor.
 *
 * Plaintext exists for exactly one case: a server on this machine (`localhost`,
 * `127.0.0.0/8`, `::1`) — the local Greenmail test server. Such a connection
 * never crosses a network, which is the same line the network-egress policy
 * draws for everything else (docs/network-policy.md). A *name* that merely resolves to a loopback
 * address is not exempt; only the literal forms are, so a hostname cannot be
 * used to talk their way past this.
 */

/** How one connection to a mail server is secured. */
export type TlsMode = "implicit" | "starttls-required" | "plaintext-loopback";

/**
 * The mode a connection to `host` gets. `requireTls` can only *tighten* it —
 * it forces STARTTLS on a loopback host, which is how the tests prove the
 * libraries really refuse a server that does not offer it. Nothing loosens a
 * remote host.
 */
export function tlsModeFor(host: string, secure: boolean, requireTls = false): TlsMode {
  if (secure) {
    return "implicit";
  }
  return requireTls || !isLoopbackHost(host) ? "starttls-required" : "plaintext-loopback";
}

/** The TLS settings shared by both libraries: verification always on, no old protocol versions. */
export const TLS_OPTIONS = { rejectUnauthorized: true, minVersion: "TLSv1.2" } as const;
