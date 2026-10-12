import { SignalMessengerPort } from "@tdsp/messenger-signal";
import { beforeAll, describe, expect, it } from "vitest";
// infra/ is test tooling, not a workspace package, so it is imported by relative path.
import { signalL4OwnDevicesReady } from "../../../infra/signal-l4/config.ts";
import { BODY_FRAME_LIMIT } from "./attachment.ts";

/**
 * L4 (docs/testing.md): two devices of one account over real production Signal — two bridges
 * linked to the same account, already running where `L4_SIGNAL_BRIDGE_A`/`_A2` say
 * (infra/signal-l4/config.ts). What only this can show: that Signal hands a message one device
 * sends to the account's other device as a sync transcript, in the shape this bridge parses, and
 * that the other device delivers it under the id the sending device got (SPECIFICATION.md SIG-3,
 * TRN-7) — an attachment frame included, which `signal-cli` must have stored for the transcript.
 *
 * Skipped unless both bridges are configured, reachable and linked. It sends a few real messages
 * into one group: the only one the account sees, or the one `L4_SIGNAL_GROUP` names.
 */
const devices = await signalL4OwnDevicesReady();
const available = devices !== undefined;

describe.skipIf(!available)("two devices of one account over real Signal (SIG-3)", () => {
  const firstPort = new SignalMessengerPort(devices?.first as string);
  const secondPort = new SignalMessengerPort(devices?.second as string);
  let account: string;
  let groupId: string;
  let counter = 0;

  /** A frame's text of `length` bytes: printable ASCII, distinguishable by `seed`. */
  const bytesOf = (length: number, seed: number): string =>
    Array.from({ length }, (_, i) =>
      String.fromCharCode(32 + (((i * 2654435761 + seed * 40503) >>> 24) % 95)),
    ).join("");

  beforeAll(async () => {
    const [{ id: first }, { id: second }] = await Promise.all([
      firstPort.whoami(),
      secondPort.whoami(),
    ]);
    if (first !== second) {
      throw new Error(
        "L4_SIGNAL_BRIDGE_A and L4_SIGNAL_BRIDGE_A2 act as two different accounts; link both to the same one",
      );
    }
    account = first;
    const channels = await firstPort.listChannels(account);
    const named = devices?.groupId;
    if (named !== undefined) {
      if (!channels.some((channel) => channel.id === named)) {
        throw new Error("the account is not in the group L4_SIGNAL_GROUP names");
      }
      groupId = named;
    } else if (channels.length === 1) {
      groupId = channels[0]?.id as string;
    } else {
      throw new Error(
        `the account sees ${channels.length} Signal groups; name the one to send into with L4_SIGNAL_GROUP`,
      );
    }
  }, 60_000);

  /** A document of its own bound onto the group on both devices. */
  async function freshDocument(): Promise<string> {
    counter += 1;
    const documentId = `signal-l4-own-devices-${counter}-${Date.now()}`;
    await Promise.all([
      firstPort.bind(documentId, groupId, account, "yjs-paragraphs/1"),
      secondPort.bind(documentId, groupId, account, "yjs-paragraphs/1"),
    ]);
    return documentId;
  }

  /** Polls `port` until it holds a delivery with `id`, or gives up after `timeoutMs`. */
  async function deliveryWithId(
    port: SignalMessengerPort,
    documentId: string,
    id: string,
    timeoutMs = 90_000,
  ) {
    const started = Date.now();
    for (;;) {
      const found = (await port.receive(documentId, account)).find((d) => d.id === id);
      if (found !== undefined || Date.now() - started > timeoutMs) {
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  it("delivers what one device sends on the other, under the id the sender got, from the account", async () => {
    const documentId = await freshDocument();
    const frame = bytesOf(200, 1);
    const id = await firstPort.send(documentId, account, frame);
    const delivered = await deliveryWithId(secondPort, documentId, id);
    expect(delivered).toEqual({ id, documentId, sender: account, payload: frame });
  }, 120_000);

  it("carries an attachment frame from the second device to the first, byte for byte", async () => {
    const documentId = await freshDocument();
    const frame = bytesOf(BODY_FRAME_LIMIT * 10, 2);
    const id = await secondPort.send(documentId, account, frame);
    const delivered = await deliveryWithId(firstPort, documentId, id);
    expect(delivered?.sender).toBe(account);
    expect(delivered?.payload === frame).toBe(true);
  }, 180_000);
});
