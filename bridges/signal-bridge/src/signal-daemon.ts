/**
 * network-policy: loopback — Zone B (docs/network-policy.md). node:net is used only
 * for a Unix domain socket (a filesystem path, never host:port), so this
 * module opens no network connection at all.
 */
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { type Logger, loggerFromEnv } from "@tdsp/bridge-log";

/**
 * Manages one `signal-cli daemon --socket=...` child process and speaks
 * its JSON-RPC contract over that Unix domain socket — newline-delimited
 * JSON, the same wire format as `signal-cli`'s `jsonRpc` stdio mode
 * (per `signal-cli-jsonrpc(5)`, and verified).
 *
 * **Unix socket, not `--http`/TCP**: `--http=localhost:<port>` binds only to
 * loopback, but signal-cli's HTTP endpoint has **no authentication of its
 * own** (confirmed from its startup log), so *any other local process on
 * this machine* that knows or scans for the port could issue arbitrary
 * commands. A Unix socket, chmod'd owner-only right after creation,
 * closes two concrete gaps HTTP+TCP left open: another OS user account on
 * a shared machine, and routine TCP-port-scanning tools. It does **not**
 * close the "another process running as this same OS user" case — no
 * different from the trust boundary an SSH agent socket or a browser's
 * cookie store already relies on. That is a documented, accepted residual
 * (SPECIFICATION.md §15.2), not something papered over.
 *
 * Started with no `-a ACCOUNT`, `signal-cli` runs in **multi-account
 * mode**, required for `startLink`/`finishLink` (account-scoped commands
 * like `send`/`receive` then need an explicit `"account"` param once
 * linked — not yet needed by anything in this slice).
 */
export interface SignalDaemon {
  readonly socketPath: string;
  /** The spawned signal-cli process's PID — mainly for logging/observability and tests that need to inspect the OS process directly. */
  readonly pid: number | undefined;
  callRpc<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /**
   * Subscribes to unsolicited JSON-RPC notifications (an incoming
   * message push arrives as `{"method":"receive","params":{"envelope":...}}`
   * with no `id`) — `sync-state.ts`'s own `MessengerPort.receive()`
   * mapping is built entirely on top of this, since signal-cli's daemon
   * mode has no separate "poll for new messages" call the way Matrix's
   * `/sync` does; a linked account's incoming messages simply arrive on
   * this same persistent socket connection whenever Signal's servers
   * deliver them. Returns an unsubscribe function.
   */
  onNotification(handler: (method: string, params: unknown) => void): () => void;
  /** Closes the socket, sends SIGTERM, and waits for the process to actually exit. Idempotent. */
  stop(): Promise<void>;
}

export interface SignalDaemonOptions {
  /** Executable name or path — `SIGNAL_CLI_PATH`, defaults to "signal-cli" on PATH. */
  signalCliPath: string;
  /** `signal-cli --data-dir` — where its own linked-account state (and this socket) live. Created if missing. */
  dataDir: string;
  /** How long to wait for the socket to become connectable before giving up. */
  readyTimeoutMs?: number;
  /** Where `signal-cli`'s own output and this module's warnings go. Defaults to one configured from the environment. */
  logger?: Logger;
}

let nextRequestId = 0;

/**
 * A JSON-RPC error `signal-cli` answered a call with. `code` is `signal-cli`'s own
 * error code (5 is Signal's rate limit — see
 * `send-failure.ts`); the message is the text this bridge has always thrown.
 *
 * Not written as a TS constructor parameter property: this bridge runs under Node's
 * `--experimental-strip-types`, which only strips annotations (see `MatrixApiError`).
 */
export class SignalRpcError extends Error {
  readonly code: number;

  constructor(message: string, code: number) {
    super(message);
    this.name = "SignalRpcError";
    this.code = code;
  }
}

/**
 * One persistent connection, matching responses back to requests by id.
 * Kept persistent (not one connection per call) because unsolicited JSON-RPC
 * notifications (`method: "receive"`, no `id`) arrive on this same connection,
 * not a separate stream; `#handleLine` hands them to `onNotification` handlers.
 */
/**
 * The longest JSON-RPC line read from `signal-cli` (SPECIFICATION.md BRG-14): a 4 MiB
 * attachment is about 5.6 Mi characters of Base64, and nothing else it sends comes near. The
 * bridge checks an attachment's file size before asking for it; this bounds what it buffers in
 * case the answer is larger anyway, rather than trusting `signal-cli` to keep it small. Checked
 * per chunk read from the socket, so a line is buffered to at most this plus one chunk.
 */
export const MAX_RPC_LINE_CHARS = 16 * 1024 * 1024;

export class SocketRpcClient {
  #socket: Socket;
  #logger: Logger;
  #buffer = "";
  readonly #maxLineChars: number;
  // Inside a line that grew past the bound: its bytes are dropped until its end.
  #skipping = false;
  #pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  #notificationHandlers = new Set<(method: string, params: unknown) => void>();

  constructor(socket: Socket, logger: Logger, maxLineChars = MAX_RPC_LINE_CHARS) {
    this.#socket = socket;
    this.#logger = logger;
    this.#maxLineChars = maxLineChars;
    this.#socket.setEncoding("utf8");
    this.#socket.on("data", (chunk: string) => this.#handleChunk(chunk));
    this.#socket.on("close", () => {
      const closedError = new Error("signal-cli daemon socket closed");
      for (const pending of this.#pending.values()) {
        pending.reject(closedError);
      }
      this.#pending.clear();
    });
  }

  #handleChunk(chunk: string): void {
    this.#buffer += chunk;
    let newlineIndex = this.#buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.#buffer.slice(0, newlineIndex);
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      if (this.#skipping) {
        this.#skipping = false; // the end of the overlong line: read normally again
      } else {
        this.#handleLine(line);
      }
      newlineIndex = this.#buffer.indexOf("\n");
    }
    if (this.#buffer.length > this.#maxLineChars || (this.#skipping && this.#buffer.length > 0)) {
      this.#dropOverlongLine();
    }
  }

  /**
   * A line past the bound is never buffered whole (BRG-14): its bytes are dropped up to its end.
   * Which call it answers cannot be read without it, so every call still waiting fails — each is
   * retried by its caller, boundedly — and the connection stays usable for the next.
   */
  #dropOverlongLine(): void {
    this.#buffer = "";
    if (this.#skipping) {
      return;
    }
    this.#skipping = true;
    this.#logger.warn("signal-cli-line-too-long", { maxChars: this.#maxLineChars });
    const tooLong = new Error(
      `signal-cli sent a line longer than ${this.#maxLineChars} characters; it was not read`,
    );
    for (const pending of this.#pending.values()) {
      pending.reject(tooLong);
    }
    this.#pending.clear();
  }

  #handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }
    let message: {
      id?: string;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code: number; message: string };
    };
    try {
      message = JSON.parse(line);
    } catch {
      this.#logger.warn("signal-cli-unparseable-line", { line });
      return;
    }
    if (message.id === undefined) {
      // An unsolicited notification (e.g. an incoming-message "receive"
      // push) — `sync-state.ts` builds `receive()` on these via
      // onNotification(). Only ever a real notification if it names a
      // method; anything else is silently ignored rather than treated as
      // an error, the "unrecognized ⇒ dropped" rule for foreign traffic.
      if (typeof message.method === "string") {
        for (const handler of this.#notificationHandlers) {
          handler(message.method, message.params);
        }
      }
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) {
      return; // response to a call this client didn't make (or already handled) — ignore
    }
    this.#pending.delete(message.id);
    if (message.error) {
      pending.reject(
        new SignalRpcError(
          `signal-cli JSON-RPC error: ${message.error.message} (code ${message.error.code})`,
          message.error.code,
        ),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = String(nextRequestId++);
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      const request = params
        ? { jsonrpc: "2.0", method, id, params }
        : { jsonrpc: "2.0", method, id };
      this.#socket.write(`${JSON.stringify(request)}\n`);
    });
  }

  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.#notificationHandlers.add(handler);
    return () => {
      this.#notificationHandlers.delete(handler);
    };
  }

  close(): void {
    this.#socket.destroy();
  }
}

function connectOnce(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => {
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

async function waitForSocket(
  socketPath: string,
  timeoutMs: number,
  logger: Logger,
): Promise<SocketRpcClient> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const socket = await connectOnce(socketPath);
      return new SocketRpcClient(socket, logger);
    } catch (error) {
      lastError = error; // socket file not created yet, or not accepting connections yet — retry
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `signal-cli daemon socket did not become connectable within ${timeoutMs}ms (${socketPath}): ${reason}`,
  );
}

export async function startSignalDaemon(options: SignalDaemonOptions): Promise<SignalDaemon> {
  const { signalCliPath, dataDir, readyTimeoutMs = 15_000 } = options;
  const logger = options.logger ?? loggerFromEnv("signal-bridge");
  mkdirSync(dataDir, { recursive: true });

  const socketPath = join(dataDir, "bridge.sock");
  // A stale socket file from an unclean previous shutdown would make
  // signal-cli fail to bind (EADDRINUSE) — remove it first; harmless if
  // nothing was listening on it, which is exactly the unclean-shutdown case.
  rmSync(socketPath, { force: true });

  // No `-a`/`--account`: multi-account mode —
  // required so `startLink`/`finishLink` are available at all.
  const child = spawn(signalCliPath, ["--data-dir", dataDir, "daemon", `--socket=${socketPath}`], {
    stdio: ["ignore", "ignore", "pipe"], // signal-cli logs exclusively to stderr; stdout is unused.
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    // Surfaced, not swallowed — a real startup failure (wrong path,
    // unwritable data dir) must be visible, not just show up as a
    // mysterious "never became ready" timeout below.
    logger.info("signal-cli-output", { text: chunk.toString().trimEnd() });
  });

  const earlyExit = new Promise<never>((_, reject) => {
    child.once("exit", (code, signal) => {
      reject(
        new Error(
          `signal-cli daemon exited early (code ${code}, signal ${signal}) before becoming ready`,
        ),
      );
    });
    child.once("error", reject);
  });

  const client = await Promise.race([waitForSocket(socketPath, readyTimeoutMs, logger), earlyExit]);

  // Tighten from signal-cli's own default (0755 — owner rwx, group/other
  // r-x) to owner-only. Narrow, unavoidable TOCTOU window between
  // signal-cli creating the socket file and this call; acceptable for a
  // local dev tool and documented as such, not ignored.
  chmodSync(socketPath, 0o600);

  async function callRpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    return client.call<T>(method, params);
  }

  function onNotification(handler: (method: string, params: unknown) => void): () => void {
    return client.onNotification(handler);
  }

  async function stop(): Promise<void> {
    client.close();
    if (child.exitCode !== null || child.signalCode !== null) {
      return; // already exited — stop() may be called more than once (e.g. shutdown + afterEach)
    }
    child.kill("SIGTERM");
    if (await waitForExit(child, 5_000)) {
      return;
    }
    // signal-cli does NOT reliably exit on
    // SIGTERM alone while a device-link provisioning session (finishLink)
    // is in flight — it logs "shutting down" but the process never
    // actually terminates (its own open connection to Signal's
    // provisioning server apparently outlives the signal handler).
    // Escalating here is what keeps *this* stop() call — and therefore
    // the bridge's own shutdown handler — from hanging forever over a
    // condition outside this bridge's control.
    logger.warn("signal-cli-sigkill-escalation", {
      reason:
        "did not exit within 5s of SIGTERM (a pending device-link session is the known cause)",
    });
    child.kill("SIGKILL");
    await waitForExit(child, 5_000);
  }

  return { socketPath, pid: child.pid, callRpc, onNotification, stop };
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
