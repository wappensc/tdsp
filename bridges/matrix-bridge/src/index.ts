import { loggerFromEnv } from "@tdsp/bridge-log";
import type { CryptoMachine } from "./crypto-machine.ts";
import {
  createLiveServerDependencies,
  createServer,
  type MatrixRoomReader,
  type MatrixRoomWriter,
} from "./server.ts";
import type { SyncState } from "./sync-state.ts";

const log = loggerFromEnv("matrix-bridge");

// Entry point — run separately via
// `pnpm --filter @tdsp/matrix-bridge run start`, never bundled and
// never coupled to a browser application at build time. Only
// ever talks to the browser over localhost HTTP at runtime.
const port = Number(process.env.PORT ?? 8788);
const homeserverUrl = process.env.MATRIX_HOMESERVER_URL ?? "http://localhost:18008";
const accessToken = process.env.MATRIX_ACCESS_TOKEN;
const bindStorePath = process.env.MATRIX_BIND_STORE_PATH ?? "./credentials/tdsp-channels.json";

// No access token configured (it comes from the environment only) —
// /health still works and reports
// `configured: false`; anything touching Matrix itself fails loudly and
// clearly rather than with a confusing lower-level fetch error.
const notConfiguredError = () => Promise.reject(new Error("MATRIX_ACCESS_TOKEN is not configured"));
const unconfigured: {
  rooms: MatrixRoomReader;
  writer: MatrixRoomWriter;
  sync: SyncState;
  crypto: CryptoMachine | undefined;
} = {
  rooms: {
    listJoinedRoomSummaries: notConfiguredError,
    isJoinedMember: notConfiguredError,
    isEncrypted: notConfiguredError,
    whoami: notConfiguredError,
  },
  writer: {
    sendEdit: notConfiguredError,
    sendInviteMessage: notConfiguredError,
  },
  sync: {
    pollOnce: notConfiguredError,
    getDeliveries: () => [],
    getIntegrityLog: () => [],
  },
  crypto: undefined,
};

const { rooms, writer, sync, crypto } =
  accessToken === undefined
    ? unconfigured
    : await createLiveServerDependencies({ homeserverUrl, accessToken }, bindStorePath);

const server = createServer({ homeserverUrl, accessToken, rooms, writer, sync, bindStorePath });

// 127.0.0.1 explicitly (SPECIFICATION.md LBI-1), not the default all-interfaces
// bind. This process holds a real Matrix access token and answers
// unauthenticated requests; without the host argument it would be reachable
// from every device on the same network. (Verified: no host argument binds
// `::`, i.e. every interface, dual-stack.)
//
// IPv4 only, deliberately. Verified rather than assumed: on a host
// where `localhost` resolves to `::1` *first*, a `http://localhost:PORT`
// client still reaches this server, because Node's and the browser's
// happy-eyeballs fallback retries 127.0.0.1. Only an explicit
// `http://[::1]:PORT` fails — a form the adapters never use.
server.listen(port, "127.0.0.1", () => {
  log.info("listening", { url: `http://localhost:${port}` });
});

// Matrix's Client-Server API is plain HTTP, no local subprocess like
// bridges/signal-bridge's signal-cli daemon — but the native crypto binding
// (@matrix-org/matrix-sdk-crypto-nodejs) does hold real, non-Node
// resources: it aborts the process with SIGABRT on exit unless close()
// is called explicitly first, so this shutdown
// handler must call it, same graceful-shutdown discipline
// signal-daemon.ts established.
let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals): void => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  log.info("shutting-down", { signal });
  crypto?.close();
  server.close(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
