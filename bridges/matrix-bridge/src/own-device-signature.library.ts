import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeviceId,
  KeysUploadRequest,
  OlmMachine,
  UserId,
} from "@matrix-org/matrix-sdk-crypto-nodejs";
import { ed25519PublicKey, signJson } from "./device-confirmation.ts";
import { isOwnDeviceCrossSigned } from "./own-device-signature.ts";

/**
 * Run by own-device-signature.test.ts in a process of its own (`node --experimental-strip-types`):
 * for each case, a fresh `OlmMachine` of `@matrix-org/matrix-sdk-crypto-nodejs` is given one
 * `/keys/query` answer about its own device, and `Device.isCrossSignedByOwner()` is compared with
 * `isOwnDeviceCrossSigned` on the same answer. Prints one JSON line of verdicts. A process of its
 * own, because a `Device` the library returned aborts the process once it is collected after its
 * machine's `close()` (own-device-signature.ts): every `Device` is held until the line is printed,
 * and the test reads the line, not the exit code.
 */

const USER = "@alice:example.org";
const DEVICE = "TDSPCOMPARE";

type Keys = Record<string, unknown>;
type Answer = {
  device_keys: Record<string, Record<string, Keys>>;
  master_keys: Record<string, Keys>;
  self_signing_keys: Record<string, Keys>;
  user_signing_keys?: Record<string, Keys>;
  failures: Record<string, never>;
};

const seed = () => new Uint8Array(randomBytes(32));

/** A cross-signing key of `usage`, signed by `signer` (or by no one). */
function crossSigningKey(
  usage: string,
  own: Uint8Array,
  signer: Uint8Array | undefined,
  extra: Keys = {},
): Keys {
  const publicKey = ed25519PublicKey(own);
  const key: Keys = {
    user_id: USER,
    usage: [usage],
    keys: { [`ed25519:${publicKey}`]: publicKey },
    ...extra,
  };
  if (signer !== undefined) {
    key.signatures = { [USER]: { [`ed25519:${ed25519PublicKey(signer)}`]: signJson(signer, key) } };
  }
  return key;
}

/** `deviceKeys` with the self-signing key's signature added to the device's own. */
function signedDevice(deviceKeys: Keys, selfSigning: Uint8Array): Keys {
  const signatures = deviceKeys.signatures as Record<string, Record<string, string>>;
  return {
    ...deviceKeys,
    signatures: {
      ...signatures,
      [USER]: {
        ...signatures[USER],
        [`ed25519:${ed25519PublicKey(selfSigning)}`]: signJson(selfSigning, deviceKeys),
      },
    },
  };
}

/** The cases, each an edit of a valid answer: its name and the answer. */
function cases(deviceKeys: Keys): Array<[string, Answer]> {
  const master = seed();
  const selfSigning = seed();
  const userSigning = seed();
  const other = seed();
  const valid = (): Answer => ({
    device_keys: { [USER]: { [DEVICE]: signedDevice(deviceKeys, selfSigning) } },
    master_keys: { [USER]: crossSigningKey("master", master, undefined) },
    self_signing_keys: { [USER]: crossSigningKey("self_signing", selfSigning, master) },
    user_signing_keys: { [USER]: crossSigningKey("user_signing", userSigning, master) },
    failures: {},
  });
  const edit = (change: (answer: Answer) => void): Answer => {
    const answer = valid();
    change(answer);
    return answer;
  };
  return [
    ["a valid chain", valid()],
    [
      "a member of the self-signing key that the master key signed too",
      edit((a) => {
        a.self_signing_keys[USER] = crossSigningKey("self_signing", selfSigning, master, {
          "org.example.extra": "kept",
        });
      }),
    ],
    [
      "the device not signed by the self-signing key",
      edit((a) => {
        (a.device_keys[USER] as Record<string, Keys>)[DEVICE] = deviceKeys;
      }),
    ],
    [
      "the device signed by another key under the self-signing key's id",
      edit((a) => {
        const device = signedDevice(deviceKeys, other) as {
          signatures: Record<string, Record<string, string>>;
        };
        const forged = device.signatures[USER]?.[`ed25519:${ed25519PublicKey(other)}`] as string;
        (a.device_keys[USER] as Record<string, Keys>)[DEVICE] = {
          ...deviceKeys,
          signatures: {
            [USER]: {
              ...(deviceKeys.signatures as Record<string, Record<string, string>>)[USER],
              [`ed25519:${ed25519PublicKey(selfSigning)}`]: forged,
            },
          },
        };
      }),
    ],
    [
      "the self-signing key signed by another key, not the master key",
      edit((a) => {
        a.self_signing_keys[USER] = crossSigningKey("self_signing", selfSigning, other);
      }),
    ],
    [
      "no user-signing key",
      edit((a) => {
        delete a.user_signing_keys;
      }),
    ],
    [
      "the user-signing key not signed by the master key",
      edit((a) => {
        (a.user_signing_keys as Record<string, Keys>)[USER] = crossSigningKey(
          "user_signing",
          userSigning,
          other,
        );
      }),
    ],
    [
      "the self-signing key with the usage of a user-signing key",
      edit((a) => {
        a.self_signing_keys[USER] = crossSigningKey("user_signing", selfSigning, master);
      }),
    ],
    [
      "the self-signing key with a second usage",
      edit((a) => {
        a.self_signing_keys[USER] = crossSigningKey("self_signing", selfSigning, master, {
          usage: ["self_signing", "user_signing"],
        });
      }),
    ],
    [
      "a member added to the device's keys after both signed them",
      edit((a) => {
        const device = (a.device_keys[USER] as Record<string, Keys>)[DEVICE] as Keys;
        device["org.example.added"] = "after";
      }),
    ],
  ];
}

/** Every `Device` the library returned, held so that none is collected before the line is printed. */
const held: unknown[] = [];

async function verdicts(): Promise<Array<{ name: string; ours: boolean; library: boolean }>> {
  const results: Array<{ name: string; ours: boolean; library: boolean }> = [];
  const probe = await machineWithKeys();
  const names = cases(probe.deviceKeys).map(([name]) => name);
  probe.close();
  for (const [index, name] of names.entries()) {
    const machine = await machineWithKeys();
    const [, answer] = cases(machine.deviceKeys)[index] as [string, Answer];
    const ours = isOwnDeviceCrossSigned(answer, {
      userId: USER,
      deviceId: DEVICE,
      ed25519: machine.ed25519,
    });
    const query = machine.olm.queryKeysForUsers([new UserId(USER)]);
    await machine.olm.markRequestAsSent(query.id, query.type, JSON.stringify(answer));
    const device = await machine.olm.getDevice(new UserId(USER), new DeviceId(DEVICE));
    held.push(device);
    results.push({ name, ours, library: device?.isCrossSignedByOwner() === true });
    machine.close();
  }
  return results;
}

/** A fresh machine of USER's DEVICE, and the device keys it would upload, signed by itself. */
async function machineWithKeys() {
  const dir = mkdtempSync(join(tmpdir(), "own-device-signature-"));
  const olm = await OlmMachine.initialize(new UserId(USER), new DeviceId(DEVICE), dir, "probe", 0);
  const upload = (await olm.outgoingRequests()).find(
    (request) => request instanceof KeysUploadRequest,
  );
  if (upload === undefined) {
    throw new Error("a fresh machine uploads its keys first");
  }
  const deviceKeys = (JSON.parse(upload.body) as { device_keys: Keys }).device_keys;
  return {
    olm,
    deviceKeys,
    ed25519: olm.identityKeys.ed25519.toBase64(),
    close() {
      olm.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

process.stdout.write(`${JSON.stringify(await verdicts())}\n`);
