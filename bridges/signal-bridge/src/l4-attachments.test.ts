import { SignalMessengerPort } from "@tdsp/messenger-signal";
import { beforeAll, describe, expect, it } from "vitest";
// infra/ is test tooling, not a workspace package, so it is imported by relative path.
import { signalL4Ready } from "../../../infra/signal-l4/config.ts";
import { ATTACHMENT_FRAME_LIMIT, BODY_FRAME_LIMIT } from "./attachment.ts";

/**
 * L4 (docs/testing.md): attachments over real production Signal, through the same two
 * configured bridges as `l4-contract.test.ts`. What only this can show: that `signal-cli`
 * accepts a data-URI attachment through JSON-RPC `send`, that the other account receives it in
 * the shape this bridge parses, that `getAttachment` answers the way `signal-api.ts` reads it,
 * and that Signal carries a frame of the largest size the bridge states.
 *
 * Skipped unless both bridges are configured, reachable and linked. It sends a handful of real
 * messages into the one group the two test accounts share, and provokes no rate limit.
 */
const bridges = await signalL4Ready();
const available = bridges !== undefined;

describe.skipIf(!available)("attachments over real Signal", () => {
  const creatorPort = new SignalMessengerPort(bridges?.creator as string);
  const memberPort = new SignalMessengerPort(bridges?.member as string);
  let creatorId: string;
  let memberId: string;
  let groupId: string;
  let counter = 0;

  // Not compressible, and different per seed, so a swap between two frames would show.
  /** A frame's text of `length` bytes: printable ASCII, distinguishable by `seed`. */
  const bytesOf = (length: number, seed: number): string =>
    Array.from({ length }, (_, i) =>
      String.fromCharCode(32 + (((i * 2654435761 + seed * 40503) >>> 24) % 95)),
    ).join("");

  beforeAll(async () => {
    [{ id: creatorId }, { id: memberId }] = await Promise.all([
      creatorPort.whoami(),
      memberPort.whoami(),
    ]);
    const channels = await creatorPort.listChannels(creatorId);
    if (channels.length !== 1) {
      throw new Error(
        `expected exactly one shared Signal group between the two L4 test accounts, found ${channels.length}`,
      );
    }
    groupId = channels[0]?.id as string;
  }, 60_000);

  /** A document of its own bound onto the shared group on both bridges. */
  async function freshDocument(): Promise<string> {
    counter += 1;
    const documentId = `signal-l4-attach-${counter}-${Date.now()}`;
    await Promise.all([
      creatorPort.bind(documentId, groupId, creatorId, "yjs-paragraphs/1"),
      memberPort.bind(documentId, groupId, creatorId, "yjs-paragraphs/1"),
    ]);
    return documentId;
  }

  /** Polls `port` until it holds `count` deliveries, or gives up after `timeoutMs`. */
  async function deliveriesOf(
    port: SignalMessengerPort,
    documentId: string,
    member: string,
    count: number,
    timeoutMs = 90_000,
  ) {
    const started = Date.now();
    for (;;) {
      const deliveries = await port.receive(documentId, member);
      if (deliveries.length >= count || Date.now() - started > timeoutMs) {
        return deliveries;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  const same = (a: string | undefined, b: string) => a === b;

  it("carries a frame of exactly the body limit in the message and one byte over it as an attachment, byte for byte", async () => {
    const documentId = await freshDocument();
    const inline = bytesOf(BODY_FRAME_LIMIT, 1);
    const attached = bytesOf(BODY_FRAME_LIMIT + 1, 2);
    await creatorPort.send(documentId, creatorId, inline);
    await creatorPort.send(documentId, creatorId, attached);
    const deliveries = await deliveriesOf(memberPort, documentId, memberId, 2);
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every((d) => d.sender === creatorId)).toBe(true);
    const payloads = deliveries.map((d) => d.payload);
    expect(payloads.some((p) => same(p, inline))).toBe(true);
    expect(payloads.some((p) => same(p, attached))).toBe(true);
  }, 120_000);

  it("carries a 100 000-byte frame from one account to the other, and one back the other way", async () => {
    const documentId = await freshDocument();
    const there = bytesOf(100_000, 3);
    const back = bytesOf(100_000, 4);
    const t0 = Date.now();
    await creatorPort.send(documentId, creatorId, there);
    const atMember = await deliveriesOf(memberPort, documentId, memberId, 1);
    console.log(`signal attachment 100 KB, creator to member: ${Date.now() - t0} ms`);
    expect(same(atMember[0]?.payload, there)).toBe(true);
    expect(atMember[0]?.sender).toBe(creatorId);

    const t1 = Date.now();
    await memberPort.send(documentId, memberId, back);
    // The creator's own bridge also holds its own message (Signal returns the sender's sync copy
    // as nothing, so only the member's arrives): wait for one from the member.
    const atCreator = await deliveriesOf(creatorPort, documentId, creatorId, 1);
    console.log(`signal attachment 100 KB, member to creator: ${Date.now() - t1} ms`);
    const fromMember = atCreator.find((d) => d.sender === memberId);
    expect(same(fromMember?.payload, back)).toBe(true);
  }, 180_000);

  it("carries a frame of exactly the bound, 4 MiB, and refuses one byte over it before anything is sent", async () => {
    const documentId = await freshDocument();
    const atBound = bytesOf(ATTACHMENT_FRAME_LIMIT, 5);
    const t0 = Date.now();
    await creatorPort.send(documentId, creatorId, atBound);
    const deliveries = await deliveriesOf(memberPort, documentId, memberId, 1, 150_000);
    console.log(`signal attachment 4 MiB, creator to member: ${Date.now() - t0} ms`);
    expect(deliveries).toHaveLength(1);
    expect(same(deliveries[0]?.payload, atBound)).toBe(true);

    // One byte over: the bridge says 413 and nothing goes to Signal.
    const refusal = await creatorPort
      .send(documentId, creatorId, bytesOf(ATTACHMENT_FRAME_LIMIT + 1, 6))
      .catch((error: unknown) => error);
    expect((refusal as { retryable?: boolean }).retryable).toBe(false);
    expect((refusal as { reason?: string }).reason).toBe("too-large");
  }, 300_000);

  it("states the bound it now carries", async () => {
    const profile = await creatorPort.transportProfile();
    expect(profile?.bounds.maxBytes).toBe(ATTACHMENT_FRAME_LIMIT);
  });
});
