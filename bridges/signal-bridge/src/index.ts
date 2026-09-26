import { join } from "node:path";
import { loggerFromEnv } from "@tdsp/bridge-log";
import { SignalAuth } from "./auth.ts";
import { createLiveServerDependencies, createServer } from "./server.ts";
import { startSignalDaemon } from "./signal-daemon.ts";

// Entry point — run separately via
// `pnpm --filter @tdsp/signal-bridge run start`, never bundled and
// never coupled to a browser application at build time. Only
// ever talks to the browser over localhost HTTP at runtime.
const log = loggerFromEnv("signal-bridge");
const port = Number(process.env.PORT ?? 8787);
const signalCliPath = process.env.SIGNAL_CLI_PATH ?? "signal-cli";
const dataDir = process.env.SIGNAL_CLI_CONFIG_DIR ?? "./credentials";
// The bind-store lives alongside, not inside, signal-cli's own
// data-dir (mirrors bridges/matrix-bridge/src/index.ts's identical choice)
// — signal-cli owns dataDir's contents entirely; this bridge's own
// routing state is not its business.
const bindStorePath = process.env.SIGNAL_BIND_STORE_PATH ?? "./credentials/tdsp-channels.json";

async function main(): Promise<void> {
  const daemon = await startSignalDaemon({ signalCliPath, dataDir, logger: log });
  const auth = new SignalAuth(daemon, dataDir, log);
  await auth.initialize();
  const server = createServer({
    auth,
    bindStorePath,
    ...createLiveServerDependencies(daemon, auth, bindStorePath, join(dataDir, "attachments")),
  });

  // 127.0.0.1 explicitly (SPECIFICATION.md LBI-1) — see bridges/matrix-bridge/src/index.ts.
  // signal-cli's own socket is already closed to other OS users (signal-daemon.ts);
  // the bridge's HTTP interface on all interfaces would leave the wider door open
  // next to the locked one.
  server.listen(port, "127.0.0.1", () => {
    log.info("listening", { url: `http://localhost:${port}` });
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log.info("shutting-down", { signal });
    server.close();
    await daemon.stop();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  log.error("failed-to-start", { error });
  process.exitCode = 1;
});
