import {
  DeviceId,
  DeviceLists,
  EncryptionSettings,
  KeysClaimRequest,
  KeysQueryRequest,
  KeysUploadRequest,
  OlmMachine,
  RoomId,
  ToDeviceRequest,
  UserId,
} from "@matrix-org/matrix-sdk-crypto-nodejs";
import {
  claimKeys,
  type MatrixApiConfig,
  queryKeys,
  sendToDevice,
  uploadKeys,
  whoami,
} from "./matrix-api.ts";

/**
 * Wraps `@matrix-org/matrix-sdk-crypto-nodejs`'s `OlmMachine` — the
 * native (N-API, not WASM) sibling package to the one `matrix-js-sdk`
 * depends on internally, chosen over it specifically because it alone
 * offers real Node persistence: `matrix-js-sdk`'s own bundled WASM crypto
 * has no working Node store at all. `OlmMachine` is a sans-IO state machine: every method here that
 * changes its state can produce `outgoingRequests()` the caller must
 * actually send and feed back via `markRequestAsSent()` — `matrix-api.ts`'s
 * plain `fetch()` calls are the transport, verified against a real Synapse
 * and two real accounts.
 *
 * **Verified, not assumed from the type declarations**: a
 * `shareRoomKey()` call fails silently (produces to-device requests that
 * the *receiver* cannot actually decrypt) unless `getMissingSessions()`
 * has first been used to establish a 1:1 Olm session with the target
 * device — the library's own types do not make this ordering requirement
 * obvious; without it a real encrypt/decrypt round trip fails with "Can't
 * find the room key to decrypt the event".
 */
export interface CryptoMachine {
  readonly userId: string;
  readonly deviceId: string;
  /**
   * Ensures the given room's current Megolm outbound session (creating
   * one if needed) has been shared with every one of `memberUserIds`'
   * devices — call this before every {@link encryptRoomEvent}, not just
   * once, since a newly-bound room or a member who joined since the
   * last share otherwise never receives the key (this is *why* a
   * message sent before a member joins stays permanently undecryptable
   * to them — the Megolm history caveat (SPECIFICATION.md §13.3), tested live in
   * `crypto.test.ts`, and unrelated to Matrix's own transport history:
   * even with full transport history, no Megolm key was ever shared
   * with a device that didn't exist as a share target yet).
   */
  ensureRoomKeyShared(roomId: string, memberUserIds: readonly string[]): Promise<void>;
  /** `content` is the *inner*, still-TDSP-specific event content (the same shape a plaintext send would use) — this returns the `m.room.encrypted` event's own content, ready to `PUT` as `m.room.encrypted`. */
  encryptRoomEvent(roomId: string, innerEventType: string, content: unknown): Promise<unknown>;
  /** `rawEvent` is the full `m.room.encrypted` timeline event as received via `/sync`. Returns the decrypted inner event's `content`/`type`/`sender` on success, or a reason string (never throws) on failure — the "no key" case (the Megolm history caveat) is an expected, not exceptional, outcome. */
  decryptRoomEvent(
    rawEvent: unknown,
    roomId: string,
  ): Promise<
    { ok: true; content: unknown; type: string; sender: string } | { ok: false; reason: string }
  >;
  /** Feeds one `/sync` round's to-device events and device-list changes into the machine — must be called every poll, even when both are empty, so the machine's own missing-one-time-key bookkeeping (`oneTimeKeyCounts`) stays current. */
  receiveSync(
    toDeviceEvents: readonly unknown[],
    deviceListsChanged: readonly string[],
    deviceListsLeft: readonly string[],
    oneTimeKeyCounts: Readonly<Record<string, number>>,
  ): Promise<void>;
  /** Must be called before the process exits — the native binding aborts with `SIGABRT` otherwise. */
  close(): void;
}

async function processOutgoingRequests(
  machine: OlmMachine,
  config: MatrixApiConfig,
): Promise<void> {
  // Looped, not a single pass: marking one request as sent can make the
  // machine produce further requests (e.g. a keys/query response
  // revealing devices that then need a keys/claim); a real exchange needs
  // more than one round to converge.
  for (let round = 0; round < 10; round++) {
    const requests = await machine.outgoingRequests();
    if (requests.length === 0) {
      return;
    }
    for (const request of requests) {
      // `instanceof`, not a switch on `request.type`: the package's own
      // `.d.ts` declares `RequestType` as an *ambient* `const enum`
      // (no member access allowed under this project's `isolatedModules`/
      // `verbatimModuleSyntax`). Each request class is a real, importable value though,
      // so narrowing on the class works exactly as well.
      let response: string;
      if (request instanceof KeysUploadRequest) {
        response = await uploadKeys(config, request.body);
      } else if (request instanceof KeysQueryRequest) {
        response = await queryKeys(config, request.body);
      } else if (request instanceof KeysClaimRequest) {
        response = await claimKeys(config, request.body);
      } else if (request instanceof ToDeviceRequest) {
        response = await sendToDevice(config, request.eventType, request.txnId, request.body);
      } else {
        // SignatureUpload/RoomMessage/KeysBackup: not produced by any
        // operation this module performs (no cross-signing, no
        // `send_message` helper, no key backup) — if one ever appears,
        // that is a real gap, not something to silently half-handle.
        throw new Error(`unhandled OlmMachine outgoing request: ${request.constructor.name}`);
      }
      await machine.markRequestAsSent(request.id, request.type, response);
    }
  }
  throw new Error("processOutgoingRequests did not converge after 10 rounds");
}

export async function createCryptoMachine(
  config: MatrixApiConfig,
  storePath: string,
): Promise<CryptoMachine> {
  const { userId, deviceId } = await whoami(config);
  const machine = await OlmMachine.initialize(
    new UserId(userId),
    new DeviceId(deviceId),
    storePath,
    // A fixed, non-secret passphrase: this store lives under the
    // already-gitignored credentials/ tree, protected
    // by filesystem permissions the same way the rest of that tree is —
    // not by this passphrase, which exists because the library requires
    // one, not as an independent secret worth managing separately.
    "tdsp-matrix-bridge",
    0, // StoreType.Sqlite
  );

  // Upload this device's own keys immediately — every later
  // shareRoomKey/encrypt call assumes it's already done.
  await processOutgoingRequests(machine, config);

  return {
    userId,
    deviceId,

    async ensureRoomKeyShared(roomId, memberUserIds) {
      const memberIds = memberUserIds.map((id) => new UserId(id));
      await machine.updateTrackedUsers(memberIds);
      await processOutgoingRequests(machine, config);

      const missingSessions = await machine.getMissingSessions(memberIds);
      if (missingSessions) {
        const response = await claimKeys(config, missingSessions.body);
        await machine.markRequestAsSent(missingSessions.id, missingSessions.type, response);
      }

      const shareRequests = await machine.shareRoomKey(
        new RoomId(roomId),
        memberIds,
        new EncryptionSettings(),
      );
      for (const request of shareRequests) {
        const response = await sendToDevice(config, request.eventType, request.txnId, request.body);
        await machine.markRequestAsSent(request.id, request.type, response);
      }
      await processOutgoingRequests(machine, config);
    },

    async encryptRoomEvent(roomId, innerEventType, content) {
      const encrypted = await machine.encryptRoomEvent(
        new RoomId(roomId),
        innerEventType,
        JSON.stringify(content),
      );
      return JSON.parse(encrypted);
    },

    async decryptRoomEvent(rawEvent, roomId) {
      try {
        const decrypted = await machine.decryptRoomEvent(
          JSON.stringify(rawEvent),
          new RoomId(roomId),
        );
        const parsed = JSON.parse(decrypted.event) as { content: unknown; type: string };
        return {
          ok: true,
          content: parsed.content,
          type: parsed.type,
          sender: decrypted.sender?.toString() ?? "",
        };
      } catch (error) {
        // Expected, not exceptional: the Megolm history caveat
        // ("a newly joined member cannot decrypt messages sent before
        // they joined") surfaces exactly here — see crypto.test.ts.
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },

    async receiveSync(toDeviceEvents, deviceListsChanged, deviceListsLeft, oneTimeKeyCounts) {
      await machine.receiveSyncChanges(
        JSON.stringify(toDeviceEvents),
        new DeviceLists(
          deviceListsChanged.map((id) => new UserId(id)),
          deviceListsLeft.map((id) => new UserId(id)),
        ),
        oneTimeKeyCounts,
        [],
      );
      await processOutgoingRequests(machine, config);
    },

    close() {
      machine.close();
    },
  };
}
