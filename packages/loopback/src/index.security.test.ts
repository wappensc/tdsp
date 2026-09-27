import { describe, expect, it } from "vitest";
import { isLoopbackHost, isLoopbackOrigin, isLoopbackUrl } from "./index.ts";

/**
 * The cases that matter are the ones a naive check waves through: a public name that merely
 * starts with "localhost", a name that resolves to 127.0.0.1, an address that looks like
 * 127/8 and is not, the bind-side wildcard, and a scheme other than http.
 */
describe("isLoopbackHost", () => {
  it.each([
    "localhost",
    "LOCALHOST",
    " localhost ",
    "127.0.0.1",
    "127.5.6.7",
    "127.255.255.255",
    "::1",
    "[::1]",
    "0:0:0:0:0:0:0:1",
    "[0:0:0:0:0:0:0:1]",
  ])("accepts %s, a literal form of this machine", (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each([
    "mail.gmx.net",
    "evil.tld",
    "192.168.1.1",
    "10.0.0.1",
    "128.0.0.1",
    "27.0.0.1",
    "127.0.0.256",
    "127.0.0.999",
    "127.0.0.1.evil.example",
    "localhost.evil.example",
    "localhost-evil.tld",
    "localtest.me", // resolves to 127.0.0.1, but a name is never trusted to
    "0.0.0.0",
    "::ffff:127.0.0.1",
    "::",
    "[::1",
    "::1]",
    "",
  ])("refuses %s, which is not literally this machine", (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe("isLoopbackUrl", () => {
  it.each([
    "http://localhost:8788",
    "http://localhost",
    "http://LocalHost:8788",
    "http://127.0.0.1:8788",
    "http://127.1.2.3:9000",
    "https://127.0.0.1:8788",
    "http://[::1]:8788",
    "http://[0:0:0:0:0:0:0:1]:8788",
  ])("accepts the loopback destination %s", (url) => {
    expect(isLoopbackUrl(url)).toBe(true);
  });

  it.each([
    "https://evil.tld",
    "http://evil.example.com:18100",
    "http://192.168.1.10:8788",
    "http://10.0.0.5:8788",
    "http://0.0.0.0:8788",
    "http://128.0.0.1:8788",
    "http://27.0.0.1:8788",
    "http://127.0.0.999:8788",
    "http://localhost.evil.tld",
    "http://localhost-evil.tld",
    "http://127.0.0.1.evil.tld:8788",
    "not a url at all",
    "",
  ])("refuses the non-loopback destination %s", (url) => {
    expect(isLoopbackUrl(url)).toBe(false);
  });

  it.each([
    "javascript:fetch('//evil.tld')",
    "file://127.0.0.1/etc/passwd",
    "ws://127.0.0.1:8788",
    "ftp://localhost/",
  ])("refuses %s: a scheme other than http, even on a loopback host", (url) => {
    expect(isLoopbackUrl(url)).toBe(false);
  });
});

describe("isLoopbackOrigin", () => {
  it.each(["http://localhost:5173", "http://127.0.0.1:8789", "http://[::1]:5173"])(
    "accepts the loopback origin %s",
    (origin) => {
      expect(isLoopbackOrigin(origin)).toBe(true);
    },
  );

  it.each([
    "https://evil.tld",
    "http://192.168.1.10:5173",
    "http://localhost.evil.tld",
    "null",
    "",
  ])("refuses the origin %s", (origin) => {
    expect(isLoopbackOrigin(origin)).toBe(false);
  });
});
