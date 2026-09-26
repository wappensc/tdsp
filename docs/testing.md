# Testing

The tests are split into three levels by what they need. Every test that needs something
outside the process skips itself cleanly when that thing is not there, so `pnpm run test`
is green on a bare machine and does more the more you give it.

| Level | Needs | Runs | Command |
| --- | --- | --- | --- |
| **L0** | Nothing outside the process | Everywhere, CI included | `pnpm run test:l0` |
| **L2** | A real messenger server on this machine: a local Synapse, a local Greenmail, `signal-cli`'s own daemon | CI and locally | `pnpm run test:l2` |
| **L4** | Real accounts at production services | Only when you ask for it; never in CI | `pnpm run test:l4-signal`, `pnpm run test:l4-email`, `pnpm run test:l4-email-bridges` |

Which file belongs to which level is listed explicitly in
[vitest.config.ts](../vitest.config.ts), not inferred from its name: a fake-backed test
and a live one often sit side by side. `pnpm run test` runs all three projects; the L2 and
L4 files skip what they cannot reach.

[CONFORMANCE.md](../CONFORMANCE.md) says which requirements each level has actually
verified.

## Prerequisites you set up yourself

Nothing in this repository contains an absolute path, and nothing in it sets one for you.
Every path below is relative to the root of your checkout, and every command is run
from there. What each developer of the test infrastructure provides on their own
machine:

- **`TDSP_ROOT`** — the absolute path of your checkout, set by you, for example in your
  shell profile:

  ```sh
  export TDSP_ROOT="$HOME/src/tdsp"
  ```

  It turns a path relative to the repository into an absolute one wherever a command
  runs somewhere else: `pnpm --filter <package> run start` runs in that package's own
  directory, so a relative path handed to a bridge would land there instead. The
  repository never sets or guesses it; the commands in this file that need it stop with
  `set TDSP_ROOT to your checkout` when it is missing.
- **For L2:** Docker, and optionally `gpg` and `signal-cli` on `PATH`.
- **For L4:** real accounts that are yours to use for testing — two Signal accounts, each
  with its phone at hand, and two dedicated mailboxes at a provider that offers SMTP and
  IMAP. None of them comes with the repository, and no test creates one. Each Signal
  bridge has to be linked to its account once **by a person scanning a QR code with that
  account's phone** (`pnpm run signal:link`, below); no script can take that step.
  L4 also needs `signal-cli` (Signal) and `gpg` (email) on `PATH`.

## L0

The engine against the in-memory transport (`packages/messenger-mock`, with deterministic
fault injection: delay, disconnect, duplication, reordering, loss, modification), the
adapters against fake bridges, the bridges against fake messengers, the published test
vectors, and the check tooling. A few L0 tests call a local `gpg` and skip without one.

```sh
pnpm install
pnpm run ci        # lint, depcruise, netcheck, licenses:check, typecheck, test
```

## L2 — local test servers

Needs Docker (Docker Desktop, OrbStack or a plain Docker Engine; `docker compose` must
work).

```sh
pnpm run matrix:up     # Synapse on 127.0.0.1:18008, with two provisioned test accounts
pnpm run email:up      # Greenmail: SMTP 127.0.0.1:13025, IMAP 127.0.0.1:13143
pnpm run test:l2
pnpm run matrix:down && pnpm run email:down
```

- **Matrix.** [infra/matrix-testserver](../infra/matrix-testserver) generates a Synapse
  configuration with federation off and relaxed rate limits, starts it, waits for it to
  be healthy and registers the test accounts. Generated secrets and the account tokens
  land in `infra/matrix-testserver/credentials/`, which is gitignored.
  `pnpm run test:l2` resets and restarts Synapse first (`pretest:l2`), so a full L2 run
  always starts from a fresh server.
- **Synapse's invite rate limiter.** Running one Matrix test file by hand many times in
  a row can trip Synapse's own invite limiter (`M_LIMIT_EXCEEDED` with a retry time of
  minutes). `pnpm run matrix:reset && pnpm run matrix:up` clears it. Normal use never
  gets near it.
- **Email.** [infra/email-testserver](../infra/email-testserver) runs Greenmail, an
  in-memory SMTP/IMAP server that accepts any login. The PGP tests additionally need
  `gpg` on `PATH` (GnuPG 2.2 or later; tested with 2.2.40, 2.4.4 and 2.5.22) and create
  throwaway keyrings under a temporary directory — your own keyring is never touched.
- **Signal.** There is no local Signal server. The L2 test for the Signal bridge starts
  a real `signal-cli` daemon (from `PATH`) and checks its own mechanics — the Unix
  socket, JSON-RPC, shutdown — without an account. It skips when `signal-cli` is not
  installed.

## L4 — real accounts

L4 tests send real traffic through real accounts. They never start by accident: each
needs explicit configuration, and the email tests need an explicit opt-in on top.

### Signal

Signal has no test server. A bridge becomes an additional device of a real Signal account,
and **only a person holding that account's phone can make it one**, by scanning a QR code.
The tests therefore never start or link a bridge; you give them two that are already
running and linked. Linking is needed once per bridge — the link lives in the bridge's data
directory from then on, across restarts — and it is the one step of the whole setup no
script can do for you.

1. Install [`signal-cli`](https://github.com/AsamK/signal-cli) (tested with 0.14.7) where
   the bridges run. It is not part of this repository and is licensed separately (GPL-3.0).
2. Start two bridges, each in a terminal of its own, each with its own port, data
   directory and bind store — two bridges sharing one would overwrite each other's
   documents:

   ```sh
   cd "${TDSP_ROOT:?set TDSP_ROOT to your checkout}"
   PORT=8787 \
   SIGNAL_CLI_CONFIG_DIR="$TDSP_ROOT/infra/signal-l4/credentials/a" \
   SIGNAL_BIND_STORE_PATH="$TDSP_ROOT/infra/signal-l4/credentials/a/tdsp-channels.json" \
     pnpm --filter @tdsp/signal-bridge run start
   ```

   and the same with `PORT=8797` and `credentials/b` for the second one. `credentials/`
   is gitignored: the linked account's keys live there. The bridge creates the directory
   and puts `signal-cli`'s socket in it, and a Unix socket path may be at most 103 bytes
   on macOS (107 on Linux), so keep `TDSP_ROOT` short enough for
   `$TDSP_ROOT/infra/signal-l4/credentials/a/bridge.sock` to fit.

3. **Link each bridge — a person with the phone does this.** From the repository root:

   ```sh
   pnpm run signal:link http://127.0.0.1:8787
   ```

   [infra/signal-l4/link.ts](../infra/signal-l4/link.ts) asks the bridge for a device
   link and draws it as a QR code in the terminal. On the phone of the account this
   bridge is to use, open the Signal app → **Settings → Linked devices → Link new
   device** and scan the code. The command waits (up to ten minutes; run it again for a
   fresh code), reports the account the bridge now acts as, and lists the Signal groups
   the account can see — a freshly linked device learns them from the phone within a few
   seconds. Repeat with `http://127.0.0.1:8797` and the **other** account's phone.

   - The phone is required. Signal Desktop cannot link a device, not even on the same
     machine: only the primary device can authorize a new one.
   - The terminal must show the whole code; enlarge the window or reduce the font if it
     wraps. The link is printed below the code too, to be turned into a QR code another
     way if needed.
   - The command only talks to the bridge on a loopback address, so for a bridge on
     another machine run it through the tunnel (see "Bridges on two machines" below):
     the code then appears on the machine you are sitting at.
   - Running it against a bridge that is already linked changes nothing; it reports the
     account and its groups, which makes it the way to check a bridge later.
   - A linked device can read everything the account receives from then on. Use
     throwaway accounts, and remove the device on the phone (Linked devices) when you
     are done with it.

4. Create **one** Signal group containing the two accounts, and make sure each account is
   in no other group: the tests take the one group the creator's account can see and
   refuse to run when there is more than one, rather than sending test traffic into a
   real conversation. `pnpm run signal:link` lists what each account sees.
5. Run:

   ```sh
   L4_SIGNAL_BRIDGE_A=http://127.0.0.1:8787 L4_SIGNAL_BRIDGE_B=http://127.0.0.1:8797 \
     pnpm run test:l4-signal
   ```

Both URLs must be loopback addresses; a bridge on another machine is reached through a
tunnel, never directly.

### Email

Two real mailboxes at a real provider, in one of two arrangements:

- **Bridges started by the test** (`pnpm run test:l4-email`): two bridge processes on
  this machine, and throwaway PGP keys generated for the run. The quickest to set up.
- **Bridges already running** (`pnpm run test:l4-email-bridges`): two bridges you started,
  typically each on a machine of its own with its own mailbox and its own PGP key — two
  separate hosts, two separate keyrings, coordinating only through the provider. See
  "Against running bridges" below.

Both run the same scenarios, and both draw on the same sending allowance of the same two
mailboxes (see the end of this section).

#### Bridges started by the test

1. Create two **dedicated** mailboxes. The tests read the whole inbox of both and leave
   the mails they send behind.
2. Copy the template and fill it in:

   ```sh
   cd "${TDSP_ROOT:?set TDSP_ROOT to your checkout}"
   mkdir -p infra/email-l4/credentials
   cp infra/email-l4/.env.l4.email.example infra/email-l4/credentials/.env.l4.email
   chmod 600 infra/email-l4/credentials/.env.l4.email
   ```

   `credentials/` is gitignored, and a test asserts that it stays so. The bridge talks
   to a real mail server over verified TLS only; there is no setting to relax that.
3. Run `pnpm run test:l4-email` from the repository root. It sets `L4_EMAIL=1`; without that, even a complete
   credentials file is ignored.

#### Against running bridges

The test knows no credentials here; each bridge holds its own mailbox and reports its own
address.

1. On each machine, start a bridge with its mailbox in its environment — `ADDRESS`, the
   `SMTP_*` and `IMAP_*` variables, and `GNUPGHOME` (see the top of
   `bridges/email-bridge/src/index.ts`; a `.env` file in `bridges/email-bridge/` is read
   too). The first bridge plays the document's creator. For the PGP scenario, each
   bridge's `GNUPGHOME` holds a secret key for its own address, and the creator's also
   holds the other address's public key.
2. Make both reachable from the machine running the tests on a loopback address — a
   bridge listens on `127.0.0.1` only, so one on another machine is reached through a
   tunnel, for example `ssh -N -L 9292:127.0.0.1:8789 other-machine` (see "Bridges on
   two machines" below).
3. Run, from the repository root:

   ```sh
   L4_EMAIL_BRIDGE_A=http://127.0.0.1:9291 L4_EMAIL_BRIDGE_B=http://127.0.0.1:9292 \
     pnpm run test:l4-email-bridges
   ```

   The test runs only when both answer and report a configured mailbox; the TLS check is
   strict, as for any real provider.

#### Sending volume

The default run sends about a dozen mails. The shared transport contract suite adds about
forty more and is a separate opt-in, `L4_EMAIL_CONTRACT=1`, with `L4_EMAIL_PACE_MS` to
wait between cases: providers throttle senders, and one did after roughly 35 mails in 20
minutes. Leave time between runs, and remember that every run against the same accounts
draws on the same allowance.

### Bridges on two machines

The L4 tests run where you sit, but the bridges can run anywhere. On this machine is the
quickest to set up; each on a machine of its own — two virtual machines, or two computers —
is the arrangement closest to real use: two hosts, two keyrings, two data directories,
coordinating only through the messenger. Both Signal and email support it, and it is set up
once and then kept.

**On each of the two machines, once:**

1. A checkout of this repository, Node.js 22.6 or later and pnpm; `pnpm install`; and
   `TDSP_ROOT` set to that checkout (each machine has its own path).
2. `signal-cli` for Signal, `gpg` for email.
3. Signal: start the bridge as in step 2 of the Signal section, on port 8787. Email: put
   the machine's mailbox into `bridges/email-bridge/.env` (`ADDRESS`, `SMTP_*`, `IMAP_*`,
   and `GNUPGHOME` with a key pair for that address; the creator's machine also imports
   the other address's public key), and start the bridge with
   `pnpm --filter @tdsp/email-bridge run start` — it listens on 8789.
4. Keep the bridges running, for example with the machine's service manager (launchd,
   systemd). That is outside this repository; a bridge needs nothing but its environment
   and its data directory.

**On the machine running the tests:**

5. Open a tunnel to each machine, since a bridge listens on `127.0.0.1` only:

   ```sh
   ssh -N -L 9191:127.0.0.1:8787 -L 9291:127.0.0.1:8789 machine-a
   ssh -N -L 9192:127.0.0.1:8787 -L 9292:127.0.0.1:8789 machine-b
   ```

6. **Link the two Signal bridges — a person with each account's phone does this**,
   through the tunnels, so the QR code appears on the screen in front of you:

   ```sh
   pnpm run signal:link http://127.0.0.1:9191   # scan with account A's phone
   pnpm run signal:link http://127.0.0.1:9192   # scan with account B's phone
   ```

   Once per machine; again only if a bridge's data directory is lost or the device is
   removed on the phone.
7. Create the one Signal group of the two accounts (step 4 of the Signal section).
8. Run the tests against the tunnels:

   ```sh
   L4_SIGNAL_BRIDGE_A=http://127.0.0.1:9191 L4_SIGNAL_BRIDGE_B=http://127.0.0.1:9192 \
     pnpm run test:l4-signal
   L4_EMAIL_BRIDGE_A=http://127.0.0.1:9291 L4_EMAIL_BRIDGE_B=http://127.0.0.1:9292 \
     pnpm run test:l4-email-bridges
   ```

   The email run draws on the same sending allowance as `pnpm run test:l4-email` when
   both use the same mailboxes; run the one you need, or leave about twenty minutes
   between them.

## Network access during tests

Every test runs under a guard that refuses any connection to a non-loopback address,
third-party libraries included, and CI additionally runs the whole suite as a user the
kernel allows no outside connection. A test that needs a real service therefore talks to
a bridge on loopback, and the bridge — which is allowed its one configured endpoint —
reaches the service. See [network-policy.md](network-policy.md).
