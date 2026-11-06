import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ed25519PublicKey, signJson } from "./device-confirmation.ts";
import { isOwnDeviceCrossSigned } from "./own-device-signature.ts";

/**
 * `isOwnDeviceCrossSigned`, the translation of the library's `Device.isCrossSignedByOwner()` for
 * the bridge's own device (bindings/matrix.md MTX-4; own-device-signature.ts says why it exists).
 * Compared with the library itself on the same answers, in a process of its own, so that an
 * upgrade of `@matrix-org/matrix-sdk-crypto-nodejs` that changes the library's verdict fails here.
 */

describe("the own device's signature, as the library judges it", () => {
  it("gives the library's verdict on every case of own-device-signature.library.ts", () => {
    const script = fileURLToPath(new URL("./own-device-signature.library.ts", import.meta.url));
    // The script's process aborts when it ends (own-device-signature.ts): its exit code says
    // nothing, the line it printed before says everything.
    const run = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", script],
      {
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    const line = run.stdout.split("\n")[0] ?? "";
    expect(line, run.stderr).not.toBe("");
    const verdicts = JSON.parse(line) as Array<{ name: string; ours: boolean; library: boolean }>;
    expect(verdicts.map(({ name, library }) => [name, library])).toStrictEqual([
      ["a valid chain", true],
      ["a member of the self-signing key that the master key signed too", true],
      ["the device not signed by the self-signing key", false],
      ["the device signed by another key under the self-signing key's id", false],
      ["the self-signing key signed by another key, not the master key", false],
      ["no user-signing key", false],
      ["the user-signing key not signed by the master key", false],
      ["the self-signing key with the usage of a user-signing key", false],
      ["the self-signing key with a second usage", false],
      ["a member added to the device's keys after both signed them", false],
    ]);
    for (const { name, ours, library } of verdicts) {
      expect(ours, name).toBe(library);
    }
  }, 90_000);
});

describe("what the library cannot be asked about: an answer that is no answer", () => {
  const USER = "@alice:example.org";
  const DEVICE = "TDSPOWN";
  const seed = () => new Uint8Array(randomBytes(32));
  const deviceSeed = seed();
  const own = { userId: USER, deviceId: DEVICE, ed25519: ed25519PublicKey(deviceSeed) };

  /** A valid answer about `own`, with its master, self-signing and user-signing keys. */
  type Keys = Record<string, unknown>;
  interface Answer {
    device_keys: Record<string, Record<string, Keys>>;
    master_keys: Record<string, Keys>;
    self_signing_keys: Record<string, Keys>;
    user_signing_keys: Record<string, Keys>;
  }

  function answer(): Answer {
    const [master, selfSigning, userSigning] = [seed(), seed(), seed()];
    const subkey = (usage: string, key: Uint8Array) => {
      const value: Record<string, unknown> = {
        user_id: USER,
        usage: [usage],
        keys: { [`ed25519:${ed25519PublicKey(key)}`]: ed25519PublicKey(key) },
      };
      value.signatures = {
        [USER]: { [`ed25519:${ed25519PublicKey(master)}`]: signJson(master, value) },
      };
      return value;
    };
    const device: Record<string, unknown> = {
      user_id: USER,
      device_id: DEVICE,
      algorithms: ["m.megolm.v1.aes-sha2"],
      keys: { [`ed25519:${DEVICE}`]: own.ed25519 },
    };
    device.signatures = {
      [USER]: {
        [`ed25519:${DEVICE}`]: signJson(deviceSeed, device),
        [`ed25519:${ed25519PublicKey(selfSigning)}`]: signJson(selfSigning, device),
      },
    };
    return {
      device_keys: { [USER]: { [DEVICE]: device } },
      master_keys: {
        [USER]: {
          user_id: USER,
          usage: ["master"],
          keys: { [`ed25519:${ed25519PublicKey(master)}`]: ed25519PublicKey(master) },
        },
      },
      self_signing_keys: { [USER]: subkey("self_signing", selfSigning) },
      user_signing_keys: { [USER]: subkey("user_signing", userSigning) },
    };
  }

  it("is signed for a valid answer", () => {
    expect(isOwnDeviceCrossSigned(answer(), own)).toBe(true);
  });

  it.each([
    ["no object", () => "signed"],
    ["no device keys", () => ({ ...answer(), device_keys: {} })],
    [
      "another device's keys under its id",
      () => {
        const a = answer();
        (a.device_keys[USER]?.[DEVICE] as Record<string, unknown>).device_id = "OTHER";
        return a;
      },
    ],
    [
      "a master key that is no Ed25519 key",
      () => {
        const a = answer();
        (a.master_keys[USER] as Record<string, unknown>).keys = { "ed25519:short": "c2hvcnQ" };
        return a;
      },
    ],
    [
      "a fraction in the device's keys, which canonical JSON cannot hold",
      () => {
        const a = answer();
        (a.device_keys[USER]?.[DEVICE] as Record<string, unknown>).version = 1.5;
        return a;
      },
    ],
  ])("is not signed for %s", (_name, make) => {
    expect(isOwnDeviceCrossSigned(make(), own)).toBe(false);
  });

  it("is not signed where the device's keys are another device's, though validly signed", () => {
    expect(isOwnDeviceCrossSigned(answer(), { ...own, ed25519: ed25519PublicKey(seed()) })).toBe(
      false,
    );
  });
});
