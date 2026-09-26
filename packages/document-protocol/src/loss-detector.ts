import type { MemberId } from "@tdsp/messenger-port";
import type { SyncPolicy } from "./sync-policy";

/**
 * Noticing that something may be missing (SPECIFICATION.md §10). A message a messenger accepted and never delivered is invisible to it, and the
 * CRDT tolerates delay, duplication and reordering completely but not loss: one missing
 * update leaves every later update from that sender unapplied, silently and permanently.
 * What a receiver *can* see is three kinds of evidence, each of which this class watches
 * for; none of them proves a loss, and none is believed before the wait it needs.
 *
 * - **A pending gap.** Later updates arrived, an earlier one did not. Indistinguishable
 *   from a late predecessor until it either arrives or does not, so it is reported only
 *   once it has lasted one `expectedLatencyMs`.
 * - **An overdue sender.** After an *edit* from S another message from S is due within
 *   `maxIntervalMs + expectedLatencyMs`: more edits, or the one heartbeat (which says
 *   "nothing further"). If neither comes, an edit or the heartbeat was lost — or S simply
 *   closed the application, which is why this is only ever *soft* evidence.
 * - **A heartbeat that shows we are behind.** The sender's state vector accounts for
 *   changes this document has not applied. The only evidence of a lost *final* message,
 *   since nothing later carries a gap.
 *
 * The class reads the world through the functions it is given and the clock, so it holds
 * only what cannot be recomputed: when each kind of evidence was first seen.
 */

/** How long to wait before believing evidence when the policy does not say how long a message takes. */
export const DEFAULT_LOSS_GRACE_MS = 5000;

/** How long a message is taken to need: the policy's expected latency, or a default when it does not say. */
export function lossGraceMs(policy: SyncPolicy): number {
  return policy.expectedLatencyMs > 0 ? policy.expectedLatencyMs : DEFAULT_LOSS_GRACE_MS;
}

export type SyncSuspicionKind =
  | "pending-gap"
  | "sender-overdue"
  | "behind-heartbeat"
  | "control-behind"
  /**
   * The bridge's window moved past everything this engine had read (SPECIFICATION.md
   * LOS-8): deliveries it never saw may have been dropped. Held until an answer to this
   * engine's own resync request has been applied.
   */
  | "history-truncated";

export interface SyncSuspicion {
  readonly kind: SyncSuspicionKind;
  /** Whose messages may be missing, when known. */
  readonly sender?: MemberId;
  /** When the evidence was first seen (epoch ms); the wait counts from here. */
  readonly since: number;
}

export interface LossDetectorOptions {
  readonly memberId: MemberId;
  /** The creator, if known: only its heartbeat's control sequence is believed, since only it issues them. */
  readonly creatorMemberId: () => MemberId | undefined;
  readonly policy: () => SyncPolicy;
  /** The client ids the document is waiting on (`pendingGapClients`). */
  readonly pendingGapClients: () => number[];
  /** Whether a sender's state vector accounts for changes the document lacks (`lacksUpdatesOf`). Throws on bytes that are not one. */
  readonly lacksUpdatesOf: (stateVector: Uint8Array) => boolean;
  /** The highest control sequence this client has seen. */
  readonly highestControlSequence: () => number;
  /** Control sequence numbers below the highest that never arrived. */
  readonly controlGaps: () => readonly number[];
  readonly now?: () => number;
}

interface Heard {
  readonly kind: "edit" | "heartbeat";
  readonly at: number;
}

interface HeartbeatSeen {
  readonly stateVector: Uint8Array;
  readonly at: number;
}

export class LossDetector {
  readonly #options: LossDetectorOptions;
  readonly #now: () => number;
  // The last thing heard from each other member that bears on "is a follow-up due".
  #heard = new Map<MemberId, Heard>();
  #heartbeats = new Map<MemberId, HeartbeatSeen>();
  // Which member authored which Yjs client id, learned from edit frames that carried
  // exactly one — a full-state answer has many authors and teaches nothing.
  #owners = new Map<number, MemberId>();
  #creatorControlSequence = 0;
  #gapSince: number | null = null;
  #controlBehindSince: number | null = null;

  constructor(options: LossDetectorOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
  }

  /** An edit or a control message from `sender` arrived: a follow-up is now due. */
  heardEdit(sender: MemberId): void {
    if (sender !== this.#options.memberId) {
      this.#heard.set(sender, { kind: "edit", at: this.#now() });
    }
  }

  /** `sender` said it has nothing further to send, and what it has. */
  heardHeartbeat(sender: MemberId, stateVector: Uint8Array, controlSequence: number): void {
    if (sender === this.#options.memberId) {
      return;
    }
    const at = this.#now();
    this.#heard.set(sender, { kind: "heartbeat", at });
    this.#heartbeats.set(sender, { stateVector, at });
    if (sender === this.#options.creatorMemberId()) {
      this.#creatorControlSequence = Math.max(this.#creatorControlSequence, controlSequence);
    }
  }

  /** `clientId` is `sender`'s: an edit frame from `sender` carried updates from that one client only. */
  learnClient(clientId: number, sender: MemberId): void {
    this.#owners.set(clientId, sender);
  }

  /** A resync answer was applied: soft evidence of silence is spent, since the state has just been handed over. */
  answered(): void {
    this.#heard.clear();
  }

  /**
   * Notes when evidence first appears and when it goes, so that the wait counts from
   * the first sighting. Call it after every poll.
   */
  observe(): void {
    const now = this.#now();
    if (this.#options.pendingGapClients().length > 0) {
      this.#gapSince ??= now;
    } else {
      this.#gapSince = null;
    }
    if (this.#controlIsBehind()) {
      this.#controlBehindSince ??= now;
    } else {
      this.#controlBehindSince = null;
    }
  }

  /** The evidence that has lasted long enough to be worth telling somebody about. */
  suspicions(): SyncSuspicion[] {
    const now = this.#now();
    const policy = this.#options.policy();
    const grace = lossGraceMs(policy);
    const found: SyncSuspicion[] = [];

    if (this.#gapSince !== null && now - this.#gapSince >= grace) {
      const owner = this.#options
        .pendingGapClients()
        .map((client) => this.#owners.get(client))
        .find((member) => member !== undefined);
      found.push({
        kind: "pending-gap",
        ...(owner === undefined ? {} : { sender: owner }),
        since: this.#gapSince,
      });
    }

    if (Number.isFinite(policy.maxIntervalMs)) {
      for (const [sender, heard] of this.#heard) {
        if (heard.kind === "edit" && now - heard.at >= policy.maxIntervalMs + grace) {
          found.push({ kind: "sender-overdue", sender, since: heard.at });
        }
      }
    }

    for (const [sender, heartbeat] of this.#heartbeats) {
      if (now - heartbeat.at >= grace && this.#isBehind(heartbeat.stateVector)) {
        found.push({ kind: "behind-heartbeat", sender, since: heartbeat.at });
      }
    }

    if (this.#controlBehindSince !== null && now - this.#controlBehindSince >= grace) {
      found.push({ kind: "control-behind", since: this.#controlBehindSince });
    }
    return found;
  }

  #isBehind(stateVector: Uint8Array): boolean {
    try {
      return this.#options.lacksUpdatesOf(stateVector);
    } catch {
      // Not a state vector: a heartbeat that says nothing usable is no evidence.
      return false;
    }
  }

  #controlIsBehind(): boolean {
    return (
      this.#options.highestControlSequence() < this.#creatorControlSequence ||
      this.#options.controlGaps().length > 0
    );
  }
}
