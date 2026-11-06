import { spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCryptoMachine, OwnDeviceUnsignedError } from "./crypto-machine.ts";
import { isOwnDeviceCrossSigned } from "./own-device-signature.ts";

/**
 * MTX-4's send gate (bindings/matrix.md): the bridge sends into an encrypted room only from a
 * device its account's identity signed. `isOwnDeviceCrossSigned` translates the check the
 * library's `Device.isCrossSignedByOwner()` makes for the own device (own-device-signature.ts
 * says why); it is compared with the library itself on the same answers, in a process of its own,
 * so that an upgrade of `@matrix-org/matrix-sdk-crypto-nodejs` that changes the library's verdict
 * fails here. And the bridge asks again once a /sync reports a change of its account's devices.
 * Security tests: only the CI role may change this file (.github/CODEOWNERS); every helper is
 * in it.
 */

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

/** Matrix's canonical JSON: keys sorted, no whitespace, integers only. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("not canonical");
  return JSON.stringify(value);
}

/** An Ed25519 key pair: its public key as Matrix writes it, and a signer of JSON objects. */
function keyPair() {
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519, randomBytes(32)]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = Buffer.from(
    createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32),
  )
    .toString("base64")
    .replace(/=+$/, "");
  const signJson = (value: Record<string, unknown>) => {
    const { signatures: _s, unsigned: _u, ...signed } = value;
    return sign(null, Buffer.from(canonicalJson(signed)), privateKey)
      .toString("base64")
      .replace(/=+$/, "");
  };
  return { publicKey, signJson };
}

type Keys = Record<string, unknown>;
type Pair = ReturnType<typeof keyPair>;

/** `value` with `signer`'s signature under `userId` added. */
function signedBy(value: Keys, userId: string, signer: Pair): Keys {
  const signatures = (value.signatures ?? {}) as Record<string, Record<string, string>>;
  return {
    ...value,
    signatures: {
      ...signatures,
      [userId]: { ...signatures[userId], [`ed25519:${signer.publicKey}`]: signer.signJson(value) },
    },
  };
}

/** A cross-signing key of `userId` with `usage`, signed by `signer` if one is given. */
function crossSigningKey(userId: string, usage: string, own: Pair, signer?: Pair): Keys {
  const key = {
    user_id: userId,
    usage: [usage],
    keys: { [`ed25519:${own.publicKey}`]: own.publicKey },
  };
  return signer === undefined ? key : signedBy(key, userId, signer);
}

/**
 * Run in a process of its own with the library's path: for each case a fresh `OlmMachine` is
 * given one `/keys/query` answer about its own device; prints, per case, the answer, the
 * machine's own device and `isCrossSignedByOwner()`. Every `Device` is held until the line is
 * printed, since one collected after its machine's `close()` aborts the process
 * (own-device-signature.ts); the exit code is not read.
 */
const LIBRARY_SIDE = String.raw`
import { createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
const lib = createRequire(import.meta.url)(process.argv[2]);
const { OlmMachine, UserId, DeviceId, KeysUploadRequest } = lib;
const USER = "@alice:example.org";
const DEVICE = "TDSPCOMPARE";
const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const unpadded = (b) => Buffer.from(b).toString("base64").replace(/=+$/, "");
function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (typeof v === "object" && v !== null) {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}
const signable = (v) => { const { signatures, unsigned, ...rest } = v; return canonical(rest); };
function pair() {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8, randomBytes(32)]), format: "der", type: "pkcs8" });
  const publicKey = unpadded(createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32));
  return { publicKey, signJson: (v) => unpadded(sign(null, Buffer.from(signable(v)), key)) };
}
function signedBy(v, signer) {
  const s = v.signatures ?? {};
  return { ...v, signatures: { ...s, [USER]: { ...s[USER], ["ed25519:" + signer.publicKey]: signer.signJson(v) } } };
}
function xsk(usage, own, signer, extra = {}) {
  const k = { user_id: USER, usage: [usage], keys: { ["ed25519:" + own.publicKey]: own.publicKey }, ...extra };
  return signer === undefined ? k : signedBy(k, signer);
}
const withoutSignatures = (v) => { const { signatures, ...rest } = v; return rest; };
const selfSignedBy = (v, key) => ({ ...v, signatures: { [USER]: { ["ed25519:" + DEVICE]: key.signJson(v) } } });
async function machine() {
  const olm = await OlmMachine.initialize(new UserId(USER), new DeviceId(DEVICE), mkdtempSync(join(tmpdir(), "ods-")), "p", 0);
  const upload = (await olm.outgoingRequests()).find((r) => r instanceof KeysUploadRequest);
  const deviceKeys = JSON.parse(upload.body).device_keys;
  const selfSign = async (v) => ({ ...v, signatures: JSON.parse((await olm.sign(signable(v))).asJSON()) });
  return { olm, deviceKeys, ed25519: olm.identityKeys.ed25519.toBase64(), selfSign };
}
async function cases(m) {
  const [master, ssk, usk, other] = [pair(), pair(), pair(), pair()];
  const answer = (device, over = {}) => ({
    device_keys: { [USER]: { [DEVICE]: device } },
    master_keys: { [USER]: xsk("master", master) },
    self_signing_keys: { [USER]: xsk("self_signing", ssk, master) },
    user_signing_keys: { [USER]: xsk("user_signing", usk, master) },
    failures: {},
    ...over,
  });
  const device = signedBy(m.deviceKeys, ssk);
  const foreign = pair();
  const foreignKeys = { ...withoutSignatures(m.deviceKeys), keys: { ...m.deviceKeys.keys, ["ed25519:" + DEVICE]: foreign.publicKey } };
  const otherId = await m.selfSign({ ...withoutSignatures(m.deviceKeys), device_id: "OTHERDEVICE" });
  const badKey = xsk("self_signing", ssk, undefined, { keys: { ["ed25519:" + ssk.publicKey]: ssk.publicKey, "ed25519:~bad": "bm90IGEga2V5" } });
  return [
    ["a valid chain", answer(device)],
    ["a member of the self-signing key that the master key signed too", answer(device, { self_signing_keys: { [USER]: xsk("self_signing", ssk, master, { "org.example.extra": "kept" }) } })],
    ["the device not signed by the self-signing key", answer(m.deviceKeys)],
    ["the device signed by another key under the self-signing key's id", answer({ ...m.deviceKeys, signatures: { [USER]: { ...m.deviceKeys.signatures[USER], ["ed25519:" + ssk.publicKey]: other.signJson(m.deviceKeys) } } })],
    ["the self-signing key signed by another key, not the master key", answer(device, { self_signing_keys: { [USER]: xsk("self_signing", ssk, other) } })],
    ["no user-signing key", answer(device, { user_signing_keys: {} })],
    ["the user-signing key not signed by the master key", answer(device, { user_signing_keys: { [USER]: xsk("user_signing", usk, other) } })],
    ["the self-signing key with the usage of a user-signing key", answer(device, { self_signing_keys: { [USER]: xsk("user_signing", ssk, master) } })],
    ["the self-signing key with a second usage", answer(device, { self_signing_keys: { [USER]: xsk("self_signing", ssk, master, { usage: ["self_signing", "user_signing"] }) } })],
    ["a member added to the device's keys after both signed them", answer({ ...device, "org.example.added": "after" })],
    ["the device's keys without the device's own signature", answer(signedBy(withoutSignatures(m.deviceKeys), ssk))],
    ["the device's keys publishing another key, signed by it", answer(signedBy(selfSignedBy(foreignKeys, foreign), ssk))],
    ["the device's keys naming another device, signed by this one", answer(signedBy(otherId, ssk))],
    ["a self-signing key of another user, signed by the master key", answer(device, { self_signing_keys: { [USER]: signedBy({ ...xsk("self_signing", ssk), user_id: "@bob:example.org" }, master) } })],
    ["a self-signing key with a second Ed25519 key that is no key", answer(device, { self_signing_keys: { [USER]: signedBy(badKey, master) } })],
  ];
}
const held = [];
const results = [];
const probe = await machine();
const count = (await cases(probe)).length;
for (let i = 0; i < count; i++) {
  const m = await machine();
  const [name, answer] = (await cases(m))[i];
  const query = m.olm.queryKeysForUsers([new UserId(USER)]);
  await m.olm.markRequestAsSent(query.id, query.type, JSON.stringify(answer));
  const device = await m.olm.getDevice(new UserId(USER), new DeviceId(DEVICE));
  held.push(device, m.olm);
  results.push({ name, answer, own: { userId: USER, deviceId: DEVICE, ed25519: m.ed25519 }, library: device?.isCrossSignedByOwner() === true });
}
process.stdout.write(JSON.stringify(results) + "\n");
`;

describe("the own device's signature, as the library judges it (MTX-4)", () => {
  it("gives the library's verdict on every answer, valid and broken", () => {
    const dir = mkdtempSync(join(tmpdir(), "own-device-signature-"));
    try {
      const script = join(dir, "library-side.mjs");
      writeFileSync(script, LIBRARY_SIDE);
      const library = createRequire(import.meta.url).resolve(
        "@matrix-org/matrix-sdk-crypto-nodejs",
      );
      const run = spawnSync(process.execPath, [script, library], {
        encoding: "utf8",
        timeout: 60_000,
      });
      const line = run.stdout.split("\n")[0] ?? "";
      expect(line, run.stderr).not.toBe("");
      const verdicts = JSON.parse(line) as Array<{
        name: string;
        answer: unknown;
        own: { userId: string; deviceId: string; ed25519: string };
        library: boolean;
      }>;
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
        ["the device's keys without the device's own signature", false],
        ["the device's keys publishing another key, signed by it", false],
        ["the device's keys naming another device, signed by this one", false],
        ["a self-signing key of another user, signed by the master key", false],
        ["a self-signing key with a second Ed25519 key that is no key", false],
      ]);
      for (const { name, answer, own, library } of verdicts) {
        expect(isOwnDeviceCrossSigned(answer, own), name).toBe(library);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});

describe("an answer the library cannot be given (MTX-4)", () => {
  const USER = "@alice:example.org";
  const DEVICE = "TDSPOWN";

  /** A valid answer about a device with key pair `device`, and the device as the bridge knows it. */
  function valid(device = keyPair()) {
    const [master, ssk, usk] = [keyPair(), keyPair(), keyPair()];
    const keys = {
      user_id: USER,
      device_id: DEVICE,
      algorithms: ["m.megolm.v1.aes-sha2"],
      keys: { [`ed25519:${DEVICE}`]: device.publicKey },
    };
    const selfSigned = {
      ...keys,
      signatures: { [USER]: { [`ed25519:${DEVICE}`]: device.signJson(keys) } },
    };
    return {
      own: { userId: USER, deviceId: DEVICE, ed25519: device.publicKey },
      answer: {
        device_keys: { [USER]: { [DEVICE]: signedBy(selfSigned, USER, ssk) } },
        master_keys: { [USER]: crossSigningKey(USER, "master", master) },
        self_signing_keys: { [USER]: crossSigningKey(USER, "self_signing", ssk, master) },
        user_signing_keys: { [USER]: crossSigningKey(USER, "user_signing", usk, master) },
      } as Record<string, Record<string, Keys>>,
    };
  }

  it("is signed for a valid answer", () => {
    const { answer, own } = valid();
    expect(isOwnDeviceCrossSigned(answer, own)).toBe(true);
  });

  it.each([
    ["no object", () => ({ ...valid(), answer: "signed" })],
    [
      "no device keys",
      () => {
        const v = valid();
        return { ...v, answer: { ...v.answer, device_keys: {} } };
      },
    ],
    [
      "a fraction in the device's keys, which canonical JSON cannot hold",
      () => {
        const v = valid();
        (v.answer.device_keys?.[USER]?.[DEVICE] as Keys).version = 1.5;
        return v;
      },
    ],
  ])("is not signed for %s", (_name, make) => {
    const { answer, own } = make();
    expect(isOwnDeviceCrossSigned(answer, own)).toBe(false);
  });
});

describe("a change of the account's own devices makes the next send ask again (MTX-4)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const USER = "@alice:example.org";
  const DEVICE = "TDSPGATE";

  it("refuses to send once a /sync lists the own devices as changed and the device is no longer signed", async () => {
    const [master, ssk, usk] = [keyPair(), keyPair(), keyPair()];
    let deviceKeys: Keys | undefined;
    let signed = true;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      if (url.endsWith("/account/whoami"))
        return Response.json({ user_id: USER, device_id: DEVICE });
      if (url.endsWith("/keys/upload")) {
        deviceKeys ??= body?.device_keys;
        return Response.json({ one_time_key_counts: { signed_curve25519: 50 } });
      }
      if (url.endsWith("/keys/query")) {
        const device =
          deviceKeys === undefined
            ? undefined
            : signed
              ? signedBy(deviceKeys, USER, ssk)
              : deviceKeys;
        return Response.json({
          device_keys: { [USER]: device === undefined ? {} : { [DEVICE]: device } },
          master_keys: { [USER]: crossSigningKey(USER, "master", master) },
          self_signing_keys: { [USER]: crossSigningKey(USER, "self_signing", ssk, master) },
          user_signing_keys: { [USER]: crossSigningKey(USER, "user_signing", usk, master) },
          failures: {},
        });
      }
      if (url.endsWith("/keys/claim")) return Response.json({ one_time_keys: {}, failures: {} });
      if (url.includes("/sendToDevice/")) return Response.json({});
      return new Response("unexpected", { status: 500 });
    });
    const store = mkdtempSync(join(tmpdir(), "own-device-gate-"));
    const crypto = await createCryptoMachine(
      { homeserverUrl: "http://homeserver.test", accessToken: "t" },
      store,
    );
    try {
      const room = "!room:example.org";
      await crypto.ensureRoomKeyShared(room, [USER]); // signed: it sends

      signed = false; // the device's signature is gone at the homeserver
      await crypto.ensureRoomKeyShared(room, [USER]); // no change reported yet: the verdict stands
      await crypto.receiveSync([], ["@bob:example.org"], [], {}); // another account's devices
      await crypto.ensureRoomKeyShared(room, [USER]); // still stands

      await crypto.receiveSync([], [USER], [], {}); // the own devices changed
      await expect(crypto.ensureRoomKeyShared(room, [USER])).rejects.toBeInstanceOf(
        OwnDeviceUnsignedError,
      );
    } finally {
      crypto.close();
      rmSync(store, { recursive: true, force: true });
    }
  });
});
