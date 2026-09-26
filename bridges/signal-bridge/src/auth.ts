import { type Logger, loggerFromEnv } from "@tdsp/bridge-log";
import { readLinkedAccount } from "./account-store.ts";

/**
 * Auth/link state, exposed to the browser only as non-secret facts: the browser
 * never reads credentials; it only calls the bridge's local interface and learns
 * non-secret facts (SPECIFICATION.md §12.1).
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

/**
 * Drives `signal-cli`'s `startLink`/`finishLink` JSON-RPC commands behind the bridge's own `/auth/link`+
 * `/auth/status` contract. `link()` intentionally does not await the full
 * linking process — `finishLink` blocks until a phone scans the returned
 * URI (or the provisioning session expires), which can take anywhere from
 * seconds to never. `POST /auth/link` needs to return the URI immediately
 * so the browser can render it as a QR code; `GET /auth/status` is what
 * the browser then polls to learn when linking actually completes.
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

  constructor(daemon: RpcCaller, dataDir: string, logger: Logger = loggerFromEnv("signal-bridge")) {
    this.#daemon = daemon;
    this.#dataDir = dataDir;
    this.#logger = logger;
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

  async link(): Promise<{ linkingUri: string }> {
    const { deviceLinkUri } = await this.#daemon.callRpc<{ deviceLinkUri: string }>("startLink");

    void this.#daemon
      .callRpc("finishLink", { deviceLinkUri, deviceName: "TDSP bridge" })
      .then(() => {
        // finishLink's own response only echoes deviceLinkUri back
        // (per signal-cli's own man page), not the linked account's
        // identity — account-store.ts's file read is what learns it (see
        // that module's doc comment for why this is not a JSON-RPC call).
        const account = readLinkedAccount(this.#dataDir);
        if (!account) {
          throw new Error(
            "finishLink resolved but accounts.json still has no linked account — signal-cli may not have flushed it to disk yet",
          );
        }
        this.#applyAccount(account);
        // A freshly linked device's `listGroups` stays empty even for a group
        // the account has long belonged to: signal-cli does not push existing
        // group/contact state to a new linked device by itself.
        // `sendSyncRequest` asks another of this account's devices to send it
        // over; `GET /channels` fills in a few seconds later.
        return this.#daemon.callRpc("sendSyncRequest", { account: account.number });
      })
      .catch((error: unknown) => {
        // Not surfaced to the browser here — it learns only via
        // /auth/status staying `linked: false`, and can retry POST
        // /auth/link for a fresh URI (Signal's own link URIs are only
        // valid briefly). Logged so whoever runs the bridge can see why
        // linking didn't complete.
        this.#logger.error("device-link-failed", { error });
      });

    return { linkingUri: deviceLinkUri };
  }

  #applyAccount(account: { readonly number: string; readonly uuid: string }): void {
    this.#phoneNumber = account.number;
    this.#status = { linked: true, accountId: account.uuid };
  }
}
