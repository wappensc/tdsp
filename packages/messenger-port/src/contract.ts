import assert from "node:assert/strict";
import { type DocumentId, type MemberId, type MessengerPort, TransportSendError } from "./index.ts";

/**
 * The transport conformance suite (SPECIFICATION.md §3.6): a `MessengerPort` must behave the
 * same whichever adapter implements it, and this is what checks it. The mock's tests run
 * every case here against the in-memory transport; each bridge's tests run them against its
 * real messenger — a local Synapse and a local Greenmail, and real Signal accounts at L4
 * (docs/testing.md).
 *
 * Deliberately dependency-free — `node:assert/strict`, not a test framework's `expect` — so
 * that `messenger-port`, which every adapter depends on, never needs a test framework at run
 * time. A failing `assert` is what every test runner treats as a failed test, and a case can
 * also be called directly for a quick manual check.
 *
 * Each case receives a **fresh fixture of its own** (see `CreateContractFixture`) so that one
 * case's state cannot leak into the next. A fresh fixture is cheap: a new `documentId`
 * bound onto the same channel, not a new channel.
 *
 * `eventually` polls rather than asserting once: a real adapter's delivery can only be
 * observed after a real network round trip, sometimes more than one. A contract that only
 * checked the instant case would hold the mock to a stricter standard than any real adapter
 * can meet, which defeats the point of a *shared* contract.
 *
 * **What this suite covers.** The transport only: that a sent payload arrives unchanged with
 * the right sender, and that a send which can never succeed says so instead of inviting a
 * retry. Permissions, membership, the document's lifecycle and resync are application policy
 * carried in frames, so they are tested once, in `packages/document-protocol`, for every
 * transport at once rather than once per adapter.
 */

export interface MessengerPortContractFixture {
  /** A documentId neither `creatorPort` nor `memberPort` has called `createDocument`/`bind` on yet. */
  readonly documentId: DocumentId;
  readonly creatorPort: MessengerPort;
  readonly creatorId: MemberId;
  /** A second member of the same channel, on its own port. */
  readonly memberPort: MessengerPort;
  readonly memberId: MemberId;
}

export type CreateContractFixture = () => Promise<MessengerPortContractFixture>;

export interface MessengerPortContractCase {
  readonly name: string;
  readonly run: (fixture: MessengerPortContractFixture) => Promise<void>;
}

// A 15 s total budget (retries × delayMs): a local Synapse answers almost at once, but real
// Signal can take several seconds to deliver, even once the group session exists. The
// budget only bounds how long a genuinely failing case takes to fail — `eventually()`
// returns the moment `isDone` is true, so no passing case gets slower.
const DEFAULT_RETRIES = 30;
const DEFAULT_DELAY_MS = 500;

/** Polls `attempt` until it returns a truthy value, or fails the case. */
async function eventually<T>(
  attempt: () => Promise<T>,
  isDone: (value: T) => boolean,
  message: string,
  { retries = DEFAULT_RETRIES, delayMs = DEFAULT_DELAY_MS } = {},
): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < retries; i++) {
    last = await attempt();
    if (isDone(last)) {
      return last;
    }
    if (i < retries - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  assert.fail(`${message} (gave up after ${retries} attempts)`);
}

export const messengerPortContractCases: readonly MessengerPortContractCase[] = [
  {
    name: "a member's send() round-trips through the other member's receive()",
    run: async ({ documentId, creatorPort, creatorId, memberPort, memberId }) => {
      await creatorPort.createDocument(documentId, creatorId);
      // Quotes, a backslash, non-ASCII and an astral character: the payload is text the
      // transport must carry character for character (SPECIFICATION.md TRN-3),
      // through whatever escaping its envelope needs.
      const text = `{"hello":"from ${creatorId} \\ "quoted" äöü 😀","at":${Date.now()}}`;
      await creatorPort.send(documentId, creatorId, text);
      await eventually(
        () => memberPort.receive(documentId, memberId),
        (deliveries) => deliveries.some((d) => d.sender === creatorId && d.payload === text),
        `${memberId} never received ${creatorId}'s delivery`,
      );
    },
  },
  {
    // `document-protocol` keeps a change whose send failed and retries it (SND-6, SND-7). That is only right if the transport can say when retrying is pointless, and
    // the plainest such case is a document nobody registered: waiting does not create
    // it. An adapter that throws an unclassified error here would have its edits
    // retried forever, which is why this is part of the shared contract.
    name: "a send() for a document that was never registered is refused for good",
    run: async ({ documentId, creatorPort, creatorId }) => {
      // The fixture's own `documentId` is already bound by an adapter-specific step
      // (a room bound, a thread started), so it is not the one to use: a sibling
      // that nothing ever registered is.
      const unregistered = `${documentId}-never-registered`;
      let refusal: unknown;
      try {
        await creatorPort.send(unregistered, creatorId, "nobody is listening");
      } catch (error) {
        refusal = error;
      }
      assert.ok(refusal !== undefined, "send() for an unregistered document did not reject");
      assert.ok(
        refusal instanceof TransportSendError,
        `send() for an unregistered document rejected with something that is not a TransportSendError: ${String(refusal)}`,
      );
      assert.equal(
        refusal.retryable,
        false,
        `send() for an unregistered document said it was worth retrying (${refusal.reason})`,
      );
    },
  },
];
