/**
 * Is this address this machine? The one check behind the promise that this implementation
 * opens no external network connection (SPECIFICATION.md §12.6, the local bridge
 * interface; docs/network-policy.md): an adapter dials only a bridge on this machine, a bridge lets
 * only a page from this machine read its answers, and the email bridge speaks plaintext
 * only to a mail server on this machine.
 *
 * One module, so that the rule has one definition — and so that a third party's adapter
 * or bridge reuses the check rather than writing its own. It has no dependencies and runs
 * in the browser and in Node alike.
 *
 * **Only literal forms count**: `localhost`, an IPv4 address in `127.0.0.0/8`, and `::1`.
 * A *name* that resolves to a loopback address (`localtest.me`) does not: the decision is
 * made before any lookup, and a name is no promise about where it points. The comparison
 * is exact, so `localhost.evil.tld` — a perfectly resolvable public name — is refused.
 * `0.0.0.0` is refused too: it tells a server to listen everywhere and is never a place
 * to connect to. Where the rule errs, it errs towards refusing.
 */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Whether `host` — a bare host name or address, as a configuration file or a socket
 * states it — is this machine. Case and surrounding whitespace do not matter; an IPv6
 * address may carry its brackets (`[::1]`) or not, and may be written in full
 * (`0:0:0:0:0:0:0:1`).
 */
export function isLoopbackHost(host: string): boolean {
  let name = host.trim().toLowerCase();
  if (name.startsWith("[") && name.endsWith("]")) {
    name = name.slice(1, -1);
  }
  if (name === "localhost" || name === "::1" || name === "0:0:0:0:0:0:0:1") {
    return true;
  }
  const ipv4 = IPV4.exec(name);
  if (!ipv4) {
    return false;
  }
  const octets = ipv4.slice(1, 5).map(Number);
  return octets.every((octet) => octet <= 255) && octets[0] === 127;
}

/**
 * Whether `url` is an `http:` or `https:` address on this machine — where an adapter may
 * send a request. Any other scheme is refused even on a loopback host (`ws:`, `file:`,
 * `javascript:`), as is anything that is not a URL at all.
 *
 * `URL` normalises the host before the check: it lowercases it, keeps an IPv6 literal's
 * brackets and shortens `[0:0:0:0:0:0:0:1]` to `[::1]` (verified, not assumed).
 */
export function isLoopbackUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  return isLoopbackHost(parsed.hostname);
}

/**
 * Whether a request's `Origin` header names a page served from this machine — which page
 * a bridge lets read its answers. A bridge has no authentication of its own, so the
 * origin is what separates the participant's own page from any website the participant
 * happens to visit while the bridge runs.
 *
 * An origin is `scheme://host[:port]`, so this is {@link isLoopbackUrl}'s rule. The opaque
 * origin `"null"` (a sandboxed frame, a `file:` page) is never one.
 */
export function isLoopbackOrigin(origin: string): boolean {
  return isLoopbackUrl(origin);
}
