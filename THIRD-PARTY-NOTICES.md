# Third-party notices

TDSP's own code is licensed under the MIT License ([LICENSE](LICENSE)).

**This repository contains no third-party code.** It declares dependencies, which your
package manager fetches at install time, and two of its bridges run programs you install
yourself. This file lists both, so that anyone who packages and distributes a bridge or a
package from this repository knows what comes with it and under which license. Each npm
package carries its own license text and copyright notice in its `LICENSE` file; whoever
distributes it has to keep those.

The two tables below are generated from [third-party-licenses.json](third-party-licenses.json)
and the resolved dependency tree by `pnpm run licenses:generate`. Everything else here is
written by hand.

## What the license check enforces

`pnpm run licenses:check` (part of `pnpm run ci`, and blocking in CI) walks the real,
resolved production dependency tree of every package and bridge and compares it with
`third-party-licenses.json`:

- **A new dependency, a changed version or a changed license** fails as "not recorded" or
  "no longer matches". Fix: update the entry in `third-party-licenses.json`, run
  `pnpm run licenses:generate`, commit both files.
- **An entry that is no longer a dependency** fails as stale. Fix: remove it.
- **A license outside `allowedLicenses`** (`MIT`, `MIT-0`, `Apache-2.0`, `BSD-2-Clause`,
  `BSD-3-Clause`, `ISC`) fails on its own, in the same run, whether or not the package is
  recorded. Recording it silences only the first violation; the build stays red until
  the dependency is removed or `allowedLicenses` is widened — a visible, one-line change
  to a checked-in file that a reviewer sees. A copyleft license cannot arrive quietly,
  whether with a new dependency or through a relicensed version of an existing one.
- **A dependency offering a choice of licenses** (an SPDX expression such as
  `(MIT OR EUPL-1.1+)`) is recorded with the full expression unchanged, plus an
  `electedLicense` naming the one this project uses it under. Only the elected license has
  to be allowed, and a change to the upstream expression still fails the check.
- **Two versions of the same package** resolved at once get one entry each.

What the check cannot see: the programs under "External programs" below live outside the
npm dependency graph. It only checks that their entries are complete; keeping the tested
version current is a manual step.

## External programs (not included)

A bridge runs these as separate programs, over their command-line or JSON-RPC interface.
No code in this repository links, copies or adapts them, so their licenses do not extend
to it. **If you distribute a bridge together with one of them, that is a distribution of
that program in its own right**, and its license's terms (for GPL and AGPL: the
corresponding source, the license text, no further restrictions) apply to that part.

<!-- GENERATED:EXTERNAL-COMPONENTS:START -->

| Component | Version (as tested) | License | Source | Distribution |
| --- | --- | --- | --- | --- |
| [signal-cli](https://github.com/AsamK/signal-cli) | 0.14.7 | GPL-3.0-only | https://github.com/AsamK/signal-cli | Not included in this repository: bridges/signal-bridge needs a separately installed signal-cli and runs it as a separate program over its command line and JSON-RPC interface; no code here links it. The version is the one the bridge is tested with. Whoever distributes the bridge together with signal-cli takes on signal-cli's license for that part. |
| [libsignal-client](https://github.com/signalapp/libsignal) | as vendored by the signal-cli release above | AGPL-3.0-only | https://github.com/signalapp/libsignal | Part of signal-cli's own distribution; not included in this repository and not linked by any code here. |
| [GnuPG](https://gnupg.org) | 2.2, 2.4 and 2.5 (tested: 2.2.40, 2.4.4, 2.5.22) | GPL-3.0-or-later | https://gnupg.org | Not included in this repository: bridges/email-bridge runs the user's own installed gpg as a separate program, for PGP-enabled documents only; no code here links it. |

<!-- GENERATED:EXTERNAL-COMPONENTS:END -->

## npm dependencies

The production (non-development) dependencies of the packages and bridges, with every
further dependency they pull in. All are under permissive licenses. Development tooling
(TypeScript, Vitest, Biome, dependency-cruiser, and `qrcode` for the Signal link
script) is not distributed and not listed, and
neither is the test-only infrastructure under `infra/` — the local Synapse (AGPL-3.0) and
Greenmail (Apache-2.0) run as containers for testing and are never part of a bridge.

<!-- GENERATED:PACKAGES:START -->

| Component | Version | License | Source |
| --- | --- | --- | --- |
| @matrix-org/matrix-sdk-crypto-nodejs | 0.6.6 | Apache-2.0 | https://github.com/matrix-org/matrix-rust-sdk-crypto-nodejs |
| @pinojs/redact | 0.4.0 | MIT | https://github.com/pinojs/redact |
| @selderee/plugin-htmlparser2 | 0.12.0 | MIT | https://github.com/mxxii/selderee |
| @zone-eu/mailsplit | 5.4.16 | (MIT OR EUPL-1.1+) | https://github.com/zone-eu/mailsplit |
| @zone-eu/mailsplit | 5.4.17 | (MIT OR EUPL-1.1+) | https://github.com/zone-eu/mailsplit |
| agent-base | 7.1.4 | MIT | https://github.com/TooTallNate/proxy-agents |
| atomic-sleep | 1.0.0 | MIT | https://github.com/davidmarkclements/atomic-sleep |
| debug | 4.4.3 | MIT | https://github.com/debug-js/debug |
| deepmerge-ts | 8.0.2 | BSD-3-Clause | https://github.com/RebeccaStevens/deepmerge-ts |
| dom-serializer | 2.0.0 | MIT | https://github.com/cheeriojs/dom-serializer |
| domelementtype | 2.3.0 | BSD-2-Clause | https://github.com/fb55/domelementtype |
| domhandler | 5.0.3 | BSD-2-Clause | https://github.com/fb55/domhandler |
| domutils | 3.2.2 | BSD-2-Clause | https://github.com/fb55/domutils |
| encoding-japanese | 2.3.0 | MIT | https://github.com/polygonplanet/encoding.js |
| encoding-japanese | 2.4.0 | MIT | https://github.com/polygonplanet/encoding.js |
| entities | 4.5.0 | BSD-2-Clause | https://github.com/fb55/entities |
| entities | 7.0.1 | BSD-2-Clause | https://github.com/fb55/entities |
| he | 1.2.0 | MIT | https://github.com/mathiasbynens/he |
| html-to-text | 10.0.1 | MIT | https://github.com/html-to-text/node-html-to-text |
| htmlparser2 | 10.1.0 | MIT | https://github.com/fb55/htmlparser2 |
| https-proxy-agent | 7.0.6 | MIT | https://github.com/TooTallNate/proxy-agents |
| iconv-lite | 0.7.3 | MIT | https://github.com/pillarjs/iconv-lite |
| imapflow | 1.7.8 | MIT | https://github.com/postalsys/imapflow |
| ip-address | 10.7.2 | MIT | https://github.com/beaugunderson/ip-address |
| isomorphic.js | 0.2.5 | MIT | https://github.com/dmonad/isomorphic.js |
| leac | 0.7.0 | MIT | https://github.com/mxxii/leac |
| lib0 | 0.2.117 | MIT | https://github.com/dmonad/lib0 |
| libbase64 | 1.3.0 | MIT | https://github.com/nodemailer/libbase64 |
| libmime | 5.4.3 | MIT | https://github.com/nodemailer/libmime |
| libmime | 5.4.4 | MIT | https://github.com/nodemailer/libmime |
| libqp | 2.1.1 | MIT | https://github.com/nodemailer/libqp |
| linkify-it | 5.0.2 | MIT | https://github.com/markdown-it/linkify-it |
| mailparser | 3.9.28 | MIT | https://github.com/nodemailer/mailparser |
| ms | 2.1.3 | MIT | https://github.com/vercel/ms |
| node-downloader-helper | 2.1.11 | MIT | https://github.com/hgouveia/node-downloader-helper |
| nodemailer | 10.0.10 | MIT-0 | https://github.com/nodemailer/nodemailer |
| nodemailer | 7.0.13 | MIT-0 | https://github.com/nodemailer/nodemailer |
| on-exit-leak-free | 2.1.2 | MIT | https://github.com/mcollina/on-exit-or-gc |
| parseley | 0.13.1 | MIT | https://github.com/mxxii/parseley |
| peberminta | 0.10.0 | MIT | https://github.com/mxxii/peberminta |
| pino | 10.3.1 | MIT | https://github.com/pinojs/pino |
| pino-abstract-transport | 3.0.0 | MIT | https://github.com/pinojs/pino-abstract-transport |
| pino-std-serializers | 7.1.0 | MIT | ssh://git@github.com/pinojs/pino-std-serializers |
| process-warning | 5.1.0 | MIT | https://github.com/fastify/process-warning |
| punycode.js | 2.3.1 | MIT | https://github.com/mathiasbynens/punycode.js |
| quick-format-unescaped | 4.0.4 | MIT | https://github.com/davidmarkclements/quick-format |
| real-require | 0.2.0 | MIT | https://github.com/pinojs/real-require |
| real-require | 1.0.0 | MIT | https://github.com/pinojs/real-require |
| safe-stable-stringify | 2.5.0 | MIT | https://github.com/BridgeAR/safe-stable-stringify |
| safer-buffer | 2.1.2 | MIT | https://github.com/ChALkeR/safer-buffer |
| selderee | 0.12.0 | MIT | https://github.com/mxxii/selderee |
| smart-buffer | 4.2.0 | MIT | https://github.com/JoshGlazebrook/smart-buffer |
| socks | 2.8.9 | MIT | https://github.com/JoshGlazebrook/socks |
| sonic-boom | 4.2.1 | MIT | https://github.com/pinojs/sonic-boom |
| split2 | 4.2.0 | ISC | https://github.com/mcollina/split2 |
| thread-stream | 4.2.0 | MIT | https://github.com/mcollina/thread-stream |
| tlds | 1.261.0 | MIT | https://github.com/stephenmathieson/node-tlds |
| uc.micro | 2.1.0 | MIT | https://github.com/markdown-it/uc.micro |
| yjs | 13.6.32 | MIT | https://github.com/yjs/yjs |

<!-- GENERATED:PACKAGES:END -->

`@matrix-org/matrix-sdk-crypto-nodejs` is used only by `bridges/matrix-bridge` and ships
only where that bridge does. `matrix-js-sdk` is not a dependency: the bridge talks to the
Matrix Client-Server API directly.
