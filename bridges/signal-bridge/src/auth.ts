import { type Logger, loggerFromEnv } from "@tdsp/bridge-log";
import { readLinkedAccount } from "./account-store.ts";

/**
 * Auth/link state, exposed to the browser only as non-secret facts: the browser
 * never reads credentials; it only calls the bridge's local interface and learns
 * non-secret facts (bindings/bridges.md §12.1).
 */
export interface AuthStatus {
  linked: boolean;
  /**
   * The account's own ACI (UUID): a real incoming envelope's `sender` is the *UUID*
   * (`sourceUuid`, `signal-api.ts`'s `parseIncomingGroupMessage`), not
   * the E.164 phone number, so the UUID is the only identifier that
   * actually matches what shows up on the receive side. This is what
   * `server.ts` uses as this bridge's own `MemberId` (`/whoami`,
   * `creatorMemberId` comparisons, permission lookups) — never the phone
   * number, which stays purely internal (see `SignalAuth.phoneNumber`).
   */
  accountId?: string;
}

/** The one piece of `SignalDaemon` this module needs — kept narrow so tests can supply a minimal fake. */
export interface RpcCaller {
  callRpc<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

export interface SignalAuthOptions {
  /** How often a pending link asks `signal-cli` whether the account is there. */
  readonly linkPollMs?: number;
  /** How long a pending link is watched before it counts as failed. */
  readonly linkWatchMs?: number;
}

// signal-cli 0.14.9 waits up to 120 s for the phone to scan the code, then registers the
// device: five minutes leave room for both.
const DEFAULT_LINK_WATCH_MS = 5 * 60_000;

/**
 * Drives `signal-cli`'s `startLink`/`finishLink` JSON-RPC commands behind the bridge's own `/auth/link`+
 * `/auth/status` contract. `link()` intentionally does not await the full
 * linking process — `finishLink` blocks until a phone scans the returned
 * URI (or the provisioning session expires), which can take anywhere from
 * seconds to never. `POST /auth/link` needs to return the URI immediately
 * so the browser can render it as a QR code; `GET /auth/status` is what
 * the browser then polls to learn when linking actually completes.
 *
 * Completion is learnt from `listAccounts`, not from `finishLink`'s answer. Tried against
 * production Signal with `signal-cli` 0.14.9 in daemon mode: the device was registered, the
 * daemon listed the account to another connection, and `finishLink` still never answered
 * (its last step adds the new account to the daemon's open connections, and does not return).
 * `listAccounts` lists only accounts the daemon has fully loaded, so an account there is a
 * finished link.
 */
export class SignalAuth {
  #daemon: RpcCaller;
  #dataDir: string;
  #status: AuthStatus = { linked: false };
  /**
   * `signal-cli`'s own local multi-account selector (E.164 phone number)
   * — its JSON-RPC `account` param rejects a UUID
   * outright (`"Specified account does not exist"`), so every call that
   * addresses *this* linked identity locally (`listGroups`, `send`,
   * `sendSyncRequest`) needs the phone number, never the UUID. Kept
   * separate from `#status.accountId` (the UUID) specifically so the two
   * never get confused — `signal-api.ts` callers use this getter, never
   * `status.accountId`.
   */
  #phoneNumber: string | undefined;

  readonly #logger: Logger;
  readonly #linkPollMs: number;
  readonly #linkWatchMs: number;

  constructor(
    daemon: RpcCaller,
    dataDir: string,
    logger: Logger = loggerFromEnv("signal-bridge"),
    options: SignalAuthOptions = {},
  ) {
    this.#daemon = daemon;
    this.#dataDir = dataDir;
    this.#logger = logger;
    this.#linkPollMs = options.linkPollMs ?? 1000;
    this.#linkWatchMs = options.linkWatchMs ?? DEFAULT_LINK_WATCH_MS;
  }

  get status(): AuthStatus {
    return this.#status;
  }

  get phoneNumber(): string | undefined {
    return this.#phoneNumber;
  }

  /**
   * `#status` is in-memory state, while `signal-cli`'s own `--data-dir` keeps a
   * linked account on disk across restarts. Without this, a restarted bridge (a
   * redeploy, a crash) would report `linked: false` and refuse every route that
   * depends on its identity until a new, unnecessary `/auth/link` completed.
   * `index.ts` calls this once at startup, before the HTTP server accepts
   * requests, so a restarted bridge recovers its real status immediately.
   */
  async initialize(): Promise<void> {
    const account = readLinkedAccount(this.#dataDir);
    if (account) {
      this.#applyAccount(account);
    }
  }

  async refreshLink(): Promise<void> {
    if (!this.#status.linked) {
      return; // a link that completes is taken in by #adoptListedAccount
    }
    const accounts = await this.#daemon.callRpc<unknown>("listAccounts");
    if (!Array.isArray(accounts)) {
      return; // no word from signal-cli, so the status stays linked (SIG-7)
    }
    const accountId = this.#status.accountId;
    const named = accounts.some((account) => {
      const { aci, number } = (account ?? {}) as { aci?: unknown; number?: unknown };
      return aci === accountId || (number !== undefined && number === this.#phoneNumber);
    });
    if (!named) {
      this.#status = { linked: false };
      this.#phoneNumber = undefined;
      this.#logger.warn("device-unlinked", {});
    }
  }

  async link(): Promise<{ linkingUri: string }> {
    const { deviceLinkUri } = await this.#daemon.callRpc<{ deviceLinkUri: string }>("startLink");

    let failed = false;
    void this.#daemon
      .callRpc("finishLink", { deviceLinkUri, deviceName: "TDSP bridge" })
      .then(() => this.#adoptListedAccount())
      .catch((error: unknown) => {
        failed = true;
        // Not surfaced to the browser here — it learns only via /auth/status staying
        // `linked: false`, and can retry POST /auth/link for a fresh URI (Signal's own link
        // URIs are only valid briefly). Logged so whoever runs the bridge can see why.
        if (!this.#status.linked) {
          this.#logger.error("device-link-failed", { error });
        }
      });
    void this.#watchLink(() => failed);

    return { linkingUri: deviceLinkUri };
  }

  /** Asks `signal-cli` for the account until it is there, the link failed, or the watch ends. */
  async #watchLink(failed: () => boolean): Promise<void> {
    const deadline = Date.now() + this.#linkWatchMs;
    while (!this.#status.linked && !failed()) {
      if (Date.now() >= deadline) {
        this.#logger.error("device-link-failed", {
          error: `no linked account within ${Math.round(this.#linkWatchMs / 1000)} s`,
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, this.#linkPollMs));
      try {
        await this.#adoptListedAccount();
      } catch {
        // A failed look is tried again at the next tick; the deadline bounds the whole watch.
      }
    }
  }

  /**
   * Takes the account `listAccounts` names, once: its ACI is the `MemberId`, its number
   * `signal-cli`'s local selector.
   */
  async #adoptListedAccount(): Promise<void> {
    const accounts = await this.#daemon.callRpc<unknown>("listAccounts");
    const first = Array.isArray(accounts)
      ? (accounts[0] as { number?: unknown; aci?: unknown } | undefined)
      : undefined;
    if (this.#status.linked || typeof first?.number !== "string" || typeof first.aci !== "string") {
      return;
    }
    this.#applyAccount({ number: first.number, uuid: first.aci });
    this.#logger.info("device-linked", {});
    // A freshly linked device's `listGroups` stays empty even for a group the account has
    // long belonged to, until another of the account's devices sends it over;
    // `sendSyncRequest` asks for that again, and `GET /channels` fills in shortly after.
    await this.#daemon.callRpc("sendSyncRequest", { account: first.number });
  }

  #applyAccount(account: { readonly number: string; readonly uuid: string }): void {
    this.#phoneNumber = account.number;
    this.#status = { linked: true, accountId: account.uuid };
  }
}
