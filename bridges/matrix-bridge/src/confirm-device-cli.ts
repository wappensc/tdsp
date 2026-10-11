/**
 * network-policy: loopback — Zone B (docs/network-policy.md). Asks the running bridge on
 * 127.0.0.1 which device it is (`GET /device`); a non-loopback bridge URL is refused. Every
 * homeserver call goes through matrix-api.ts.
 */
/**
 * `pnpm run matrix:confirm-device [bridge url]` — confirms the running bridge's Matrix device
 * with the account's cross-signing identity, using the account's recovery key
 * (docs/matrix-device-confirmation.md). Run in the bridge's directory, with its environment
 * (`MATRIX_HOMESERVER_URL`, `MATRIX_ACCESS_TOKEN`, from `.env` as the bridge reads them).
 *
 * The recovery key is read from the terminal without echo, or from the first line of standard
 * input when that is not a terminal. It never travels in an argument, an environment variable,
 * a file or the bridge's HTTP interface, and nothing here prints or stores it.
 */
import {
  confirmOwnDevice,
  DeviceConfirmationError,
  type OwnDevice,
} from "./device-confirmation.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function bridgeUrl(argument: string | undefined): string {
  const url = new URL(argument ?? `http://127.0.0.1:${process.env.PORT ?? 8788}`);
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`the bridge is reached on loopback only, not at ${url.origin}`);
  }
  return url.origin;
}

async function ownDevice(origin: string): Promise<OwnDevice> {
  const response = await fetch(`${origin}/device`).catch(() => {
    throw new Error(`no bridge answers at ${origin}: start it first, or name its URL`);
  });
  const body = (await response.json().catch(() => ({}))) as Partial<OwnDevice> & { error?: string };
  if (!response.ok || typeof body.deviceId !== "string" || typeof body.ed25519 !== "string") {
    throw new Error(
      `the bridge at ${origin} did not report its device: ${body.error ?? response.status}`,
    );
  }
  return { deviceId: body.deviceId, ed25519: body.ed25519 };
}

async function readRecoveryKey(): Promise<string> {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) {
    let text = "";
    for await (const chunk of stdin) {
      text += String(chunk);
      if (text.includes("\n")) {
        break;
      }
    }
    return (text.split("\n")[0] ?? "").trim();
  }
  stderr.write("Recovery key (not shown while you type): ");
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  return new Promise((resolve, reject) => {
    let key = "";
    const finish = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
    };
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") {
          finish();
          resolve(key.trim());
          return;
        }
        if (character === "\u0003") {
          finish();
          reject(new Error("cancelled"));
          return;
        }
        key = character === "\u007f" || character === "\b" ? key.slice(0, -1) : key + character;
      }
    };
    stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  const accessToken = process.env.MATRIX_ACCESS_TOKEN;
  if (accessToken === undefined) {
    throw new Error(
      "MATRIX_ACCESS_TOKEN is not configured: run this with the bridge's environment",
    );
  }
  const homeserverUrl = process.env.MATRIX_HOMESERVER_URL ?? "http://localhost:18008";
  const origin = bridgeUrl(process.argv[2]);
  const device = await ownDevice(origin);
  console.log(`Confirming device ${device.deviceId} of the bridge at ${origin}.`);
  const recoveryKey = await readRecoveryKey();
  const outcome = await confirmOwnDevice({ homeserverUrl, accessToken }, device, recoveryKey);
  console.log(
    outcome === "signed"
      ? `Device ${device.deviceId} is now signed by the account's self-signing key.`
      : `Device ${device.deviceId} was already signed by the account's self-signing key; nothing changed.`,
  );
}

main().catch((error: unknown) => {
  const message =
    error instanceof DeviceConfirmationError
      ? `${error.message} (${error.problem})`
      : error instanceof Error
        ? error.message
        : String(error);
  console.error(`matrix:confirm-device: ${message}`);
  process.exitCode = 1;
});
