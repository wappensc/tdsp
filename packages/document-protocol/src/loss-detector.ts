import type { MemberId } from "@tdsp/messenger-port";
import type { ControlVector } from "./control-state";
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
 * - **An overdue sender.** After an *edit* from S another message from S is due within the `due` S
 *   announced plus this client's expected latency (LOS-11, LOS-16): more edits from the same
 *   source, or a heartbeat that holds the edit (which says "nothing further"). If neither comes, an
 *   edit or the heartbeat was lost — or S simply closed the application, which is why this is only
 *   ever *soft* evidence. A member may write from several devices, so the expectation is kept per
 *   source — the CRDT clients of an edit, the device tag of a control frame — and a heartbeat ends
 *   only those of the frames it holds.
 * - **A report that shows we are behind.** A heartbeat, a request or an answer's last piece
 *   whose state vector accounts for changes this document has not applied. The only evidence of a
 *   lost *final* message, since nothing later carries a gap.
 * - **A report whose state digest differs** where this client holds every insertion the report
 *   counts: a deletion one of the two lacks (LOS-12).
 * - **An incomplete answer** to this client's own request: one of its numbered pieces is missing
 *   (LOS-14).
 *
 * Reports are kept by their sender's **stream** — its engine as it runs now — and a report replaces
 * only an older one of the same stream (LOS-17): a member may run several devices, and the word of
 * one that lags behind must not end what another's showed. Evidence from a stream's report ends with
 * a newer report of that stream that shows none, with a complete answer of that stream to this
 * client's own request — which it then holds —, or once this client's state agrees with it
 * (LOS-18).
 *
 * An answer to this client's own request is a **transfer**, kept apart from the reports by its
 * sender, stream and number, and bound to the request it answers (LOS-21): a later answer of the same
 * stream — to someone else, or to another request of this client's — is another transfer, and a piece
 * of it, which states nothing, ends none. A transfer ends when it is whole, or when this client is
 * known to hold the state of its stream at its number or later: by its own last piece, by a report of
 * the stream it held when it could first compare it, or by a later whole answer of the stream —
 * within one stream the state only grows (LOS-13).
 *
 * Messages of this client's own member count like anyone's: they come from its other devices,
 * whose losses it must notice too (LOS-4, LOS-11). Its own messages coming back are the engine's
 * to leave out, since only the engine can tell them (an edit of its own Yjs client, a control
 * operation under its own device tag).
 *
 * The class reads the world through the functions it is given and the clock, so it holds
 * only what cannot be recomputed: when each kind of evidence was first seen.
 */

/**
 * How many streams of one member are kept for their reports, each with its latest (LOS-4, LOS-17): a
 * member may write from several devices, and the report of one that lacks a change must not hide the
 * report of the one that made it. A fifth replaces the stream heard from least recently, and what its
 * report showed goes with it: a bound, not a promise that every report's evidence stays. A stream with
 * a transfer counted or given up (LOS-21, LOS-22) is kept besides and does not count here.
 */
export const STREAMS_PER_MEMBER = 4;

/**
 * How many transfers of one member are counted at once (LOS-22). A ninth gives up the one heard from
 * least recently, which stays evidence by its stream and number until this client is known to hold
 * that stream's state at that number. As many streams are kept with transfers given up; beyond that
 * the oldest one's evidence becomes the member's, which stays as long as this engine runs.
 */
export const OPEN_TRANSFERS_PER_MEMBER = 8;

/**
 * The highest piece number counted (LOS-22). An answer with a piece numbered above it is never whole
 * here, like one whose pieces disagree. At the 4 MiB frames of the bindings that is 4 TiB of answer,
 * and still 4 GiB at frames of 4 KiB; the numbers kept grow only with the pieces that arrive.
 */
export const MAX_ANSWER_PIECES = 1_048_576;

/** How long to wait before believing evidence when the policy does not say how long a message takes. */
export const DEFAULT_LOSS_GRACE_MS = 5000;

/** How long a message is taken to need: the policy's expected latency, or a default when it does not say. */
export function lossGraceMs(policy: SyncPolicy): number {
  return policy.expectedLatencyMs > 0 ? policy.expectedLatencyMs : DEFAULT_LOSS_GRACE_MS;
}

export type SyncSuspicionKind =
  | "pending-gap"
  | "sender-overdue"
  /** A report — a heartbeat, a request or an answer's last piece — holds changes this client lacks (LOS-4). */
  | "behind-heartbeat"
  | "control-behind"
  /**
   * A sender whose state vector this client holds showed a state digest other than that of what
   * this client deleted of the items that vector counts (LOS-12): one of the two lacks something no
   * vector counts — a deletion, as a rule.
   */
  | "diverged"
  /**
   * An answer to this client's own request of which a piece is missing (LOS-14): its last piece
   * says how many there are, and one of them did not come — or pieces came and the last did not —
   * for longer than one more would take. The answer holds the bootstrap's trust once its last piece
   * is here (RSY-14), not all of what it carries.
   */
  | "answer-incomplete"
  /**
   * A control vector equal to this client's came with another control digest (LOS-12): two
   * participants hold different operations under one device and counter (CTL-24).
   */
  | "control-diverged"
  /**
   * The bridge's window moved past everything this engine had read (SPECIFICATION.md
   * LOS-8): deliveries it never saw may have been dropped. Held until an answer to this
   * engine's own resync request has been applied (LOS-19).
   */
  | "history-truncated";

export interface SyncSuspicion {
  readonly kind: SyncSuspicionKind;
  /** Whose messages may be missing, when known. */
  readonly sender?: MemberId;
  /** When the evidence was first seen (epoch ms); the wait counts from here. */
  readonly since: number;
  /**
   * For `sender-overdue`: the milliseconds the sender is judged by (LOS-11) — what it promised to
   * speak again within (SND-14), or the pace when that is longer.
   */
  readonly due?: number;
}

export interface LossDetectorOptions {
  /** The creator, if known: only its heartbeat's control vector is believed, since only it issues operations. */
  readonly creatorMemberId: () => MemberId | undefined;
  readonly policy: () => SyncPolicy;
  /** The client ids the document is waiting on (`pendingGapClients`). */
  readonly pendingGapClients: () => number[];
  /** Whether a sender's state vector accounts for changes the document lacks (`lacksUpdatesOf`). Throws on bytes that are not one. */
  readonly lacksUpdatesOf: (stateVector: Uint8Array) => boolean;
  /** Whether a creator device's counters have a hole here: one held above a missing one (LOS-10). */
  readonly controlHoles: () => boolean;
  /** Whether a creator heartbeat's control vector holds operations this client lacks (LOS-10). */
  readonly lacksControlOf: (vector: ControlVector) => boolean;
  /**
   * The digest of what this client deleted of the items `stateVector` counts (LOS-12), when this
   * client holds every insertion that vector counts; `undefined` when it does not, or when the
   * profile cannot restrict its deletions to a vector it does not equal. Throws on bytes that are
   * not a state vector.
   */
  readonly stateDigestWithin: (stateVector: Uint8Array) => string | undefined;
  /** Whether a control vector names exactly what this client holds of the creator's operations. */
  readonly sameControlVector: (vector: ControlVector) => boolean;
  /** This client's control digest (LOS-12). */
  readonly controlDigest: () => string;
  /** Whether this client is a device of the creator: it judges members' control digests too (CTL-31). */
  readonly isCreatorDevice: () => boolean;
  /**
   * The pace the creator set, if any (SND-15): no participant sends faster, so a sender may keep a
   * `due` it announced before it learned a longer pace only by the pace (LOS-11).
   */
  readonly pace?: () => number | undefined;
  readonly now?: () => number;
}

/** What a frame with `due` above 0 leaves open: a further frame of its source, or a heartbeat that holds it (LOS-11, LOS-16). */
interface Expectation {
  readonly at: number;
  /** The milliseconds within which its sender promised to speak again. */
  readonly due: number;
  /** Whether a heartbeat with this state vector and control vector holds the frame. */
  readonly heldBy: (stateVector: Uint8Array, control: ControlVector | null) => boolean;
}

const HELD_BY_ANY = (): boolean => true;

/**
 * What a heartbeat, a request or an answer's last piece said of its sender's state (LOS-4, LOS-12),
 * and where it stands in its sender's stream (LOS-13).
 */
export interface StateReport {
  readonly stream: string;
  readonly sequence: number;
  readonly stateVector: Uint8Array;
  readonly stateDigest: string;
  readonly control: ControlVector | null;
  readonly controlDigest: string | null;
}

/** One piece of an answer (LOS-14), heard once its update was applied. */
export interface AnswerPiece {
  readonly stream: string;
  readonly sequence: number;
  readonly piece: number;
  /** In the last piece, how many the answer has; `null` in the others. */
  readonly pieces: number | null;
  /** In the last piece, the responder's state as it answered; `null` in the others. */
  readonly report: StateReport | null;
  /** Whether it answers this client's own request: only then are its pieces counted, and a whole one held. */
  readonly own: boolean;
  /** The request it answers (`respondsTo`): every piece of one answer names the same. */
  readonly request: string;
}

/** An answer to this client's own request of which a piece is still missing (LOS-14). */
export interface IncompleteAnswer {
  readonly sender: MemberId;
  /** How many of its pieces have arrived. */
  readonly received: number;
  /** How many it has, once its last piece has arrived; `null` before. */
  readonly pieces: number | null;
  /** When its most recent piece arrived (epoch ms). */
  readonly since: number;
}

interface KeptReport {
  readonly value: StateReport;
  readonly at: number;
  /** This client holds what it states: the last piece of an answer to its own request it applied whole. */
  held: boolean;
  /**
   * Whether its state digest differed from what this client had deleted within its vector when the
   * two could first be compared — at once, or once this client held every insertion the vector
   * counts (LOS-12); `undefined` until then. Only a report that differed then can show a
   * difference later: what this client deletes after that — the sender's own later edits among
   * it — says nothing of what the sender held.
   */
  differed: boolean | undefined;
  /** When the evidence it shows began, if an older report of its stream showed the same kind already. */
  readonly carried: { readonly behind: number | null; readonly diverged: number | null };
}

/** An answer of a stream to this client's own request, while a piece of it is missing (LOS-14). */
interface Transfer {
  /** The request it answers. */
  readonly request: string;
  /** The numbers of the pieces applied; a copy of one counts once. */
  readonly received: Set<number>;
  /** The highest of them. */
  highest: number;
  /** How many pieces it has, once its last piece is here; `null` before. */
  pieces: number | null;
  /** What its last piece states. */
  report: StateReport | null;
  /**
   * Its pieces disagree — on the request, the count or the state stated, a piece numbered above the
   * count or above MAX_ANSWER_PIECES, or a piece of its number answering someone else —: it is never
   * whole, and neither its own last piece nor anything of its number shows that this client holds it.
   */
  conflicting: boolean;
  /** When its most recent piece arrived. */
  lastAt: number;
}

/**
 * One stream of a member (LOS-13): its latest report, its transfers (LOS-14), and how far this client
 * is known to hold its state.
 */
interface StreamRecord {
  /** Its latest report; `null` while only pieces of a transfer have come. */
  report: KeptReport | null;
  /** The state of the stream's last answer this client applied whole: a later report that says the same is held too. */
  heldState: {
    readonly sequence: number;
    readonly stateVector: Uint8Array;
    readonly stateDigest: string;
  } | null;
  /**
   * The highest number of the stream whose state this client is known to hold: by a whole answer, by
   * a report it held when it could first compare it, or by a transfer's last piece stating what it
   * holds. Within a stream the state only grows, so a transfer of this number or lower brings nothing
   * this client lacks (LOS-13).
   */
  covered: number;
  /** Its transfers with a piece missing, by number. */
  readonly transfers: Map<number, Transfer>;
  /** Its transfers given up for OPEN_TRANSFERS_PER_MEMBER, as one: the highest number among them, since when, and whether one disagreed. */
  givenUp: { sequence: number; since: number; conflicting: boolean } | null;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

type StatedState = Pick<StateReport, "stateVector" | "stateDigest">;

function sameState(a: StatedState, b: StatedState): boolean {
  return sameBytes(a.stateVector, b.stateVector) && a.stateDigest === b.stateDigest;
}

function whole(transfer: Transfer): boolean {
  // Without a disagreement every number is at most the count, so as many numbers as the count are all of them.
  return (
    !transfer.conflicting && transfer.pieces !== null && transfer.received.size === transfer.pieces
  );
}

/** Whether a transfer, or transfers given up, of `sequence` end once this client holds the stream's state at `covered`. */
function coveredBy(covered: number, sequence: number, conflicting: boolean): boolean {
  // At its own number only by its own last piece, which a transfer that disagrees does not have.
  return sequence < covered || (sequence === covered && !conflicting);
}

export class LossDetector {
  readonly #options: LossDetectorOptions;
  readonly #now: () => number;
  // What each member's sources still owe: the latest frame of each with `due` above 0 (LOS-11).
  #expected = new Map<MemberId, Map<string, Expectation>>();
  // Each member's streams, the one heard from least recently first (LOS-17): the latest report of
  // each, at most STREAMS_PER_MEMBER kept for that alone, and the transfers of each (LOS-14).
  #streams = new Map<MemberId, Map<string, StreamRecord>>();
  // Members whose transfers were given up beyond what is kept by stream, and since when: evidence for
  // as long as this engine runs, since no stream is left to show it ended (LOS-22).
  #givenUp = new Map<MemberId, number>();
  // Which member authored which Yjs client id, learned from edit frames that carried
  // exactly one — a full-state answer has many authors and teaches nothing.
  #owners = new Map<number, MemberId>();
  #creatorControl: ControlVector = {};
  #gapSince: number | null = null;
  #controlBehindSince: number | null = null;

  constructor(options: LossDetectorOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
  }

  /**
   * An edit or a control message from `sender` arrived, promising a follow-up within `due`
   * milliseconds, or none for 0 (SND-14): judged by what the sender announced, not by this
   * client's own pacing (LOS-11). It ends what the earlier frame of the same `source` left open
   * (LOS-16), and `heldBy` says which heartbeat holds it. Without them, every frame of the sender
   * is one source and every heartbeat holds it.
   */
  heardEdit(
    sender: MemberId,
    due: number,
    source = "",
    heldBy: (stateVector: Uint8Array, control: ControlVector | null) => boolean = HELD_BY_ANY,
  ): void {
    const expected = this.#expected.get(sender) ?? new Map<string, Expectation>();
    if (due > 0) {
      expected.set(source, { at: this.#now(), due, heldBy });
    } else {
      expected.delete(source);
    }
    this.#expected.set(sender, expected);
  }

  /**
   * `sender` said it has nothing further to send, and what it has: the frames it holds owe nothing
   * more (LOS-16). What it says of its state is a report (`heardReport`).
   */
  heardHeartbeat(sender: MemberId, stateVector: Uint8Array, control: ControlVector | null): void {
    const expected = this.#expected.get(sender);
    for (const [source, expectation] of expected ?? []) {
      if (this.#holds(expectation, stateVector, control)) {
        expected?.delete(source);
      }
    }
    if (sender === this.#options.creatorMemberId() && control !== null) {
      // The creator's devices may be several: what any of them holds counts (SND-11).
      const merged: Record<string, number> = { ...this.#creatorControl };
      for (const [device, counter] of Object.entries(control)) {
        merged[device] = Math.max(merged[device] ?? 0, counter);
      }
      this.#creatorControl = merged;
    }
  }

  /**
   * A heartbeat or a request said what `sender` holds (LOS-4, LOS-12), at its place in its stream
   * (LOS-17): it replaces the stream's report only when it is newer, so a copy offered again, or an
   * older one that arrives late, changes nothing. Judged against this client's current state.
   */
  heardReport(sender: MemberId, report: StateReport): void {
    this.#keepReport(sender, report);
    this.#bound(sender);
  }

  /**
   * A piece of an answer was applied (LOS-14). Its last piece is the responder's report, as a
   * heartbeat's (LOS-4, LOS-12). Of an answer to this client's own request the pieces are counted, as
   * a transfer of their own: one missing is evidence, and once all of them are here this client holds
   * what the last one states, so no digest of it is evidence any longer — a difference then only
   * shows what this client deleted itself (LOS-18). A piece that is not the last states nothing, and
   * ends no other transfer, of its stream or another.
   */
  heardAnswerPiece(sender: MemberId, piece: AnswerPiece): void {
    const counted = piece.own ? this.#count(sender, piece) : undefined;
    if (!piece.own) {
      // One answer answers one request: a piece of a counted one's number answering someone else
      // contradicts it.
      const transfer = this.#streams.get(sender)?.get(piece.stream)?.transfers.get(piece.sequence);
      if (transfer !== undefined) {
        transfer.conflicting = true;
      }
    }
    if (piece.report !== null) {
      this.#keepReport(sender, piece.report);
    }
    if (counted !== undefined && whole(counted.transfer)) {
      this.#holdWhole(counted.record, piece.sequence, counted.transfer);
    }
    this.#bound(sender);
  }

  /**
   * The answers to this client's own requests of which a piece is still missing, at once, before any
   * wait (LOS-14): what an application may show as a transfer under way. Transfers given up for the
   * bound are not among them; they are evidence still (`suspicions`).
   */
  incompleteAnswers(): IncompleteAnswer[] {
    const found: IncompleteAnswer[] = [];
    for (const [sender, streams] of this.#streams) {
      for (const record of streams.values()) {
        this.#cover(record);
        for (const transfer of record.transfers.values()) {
          found.push({
            sender,
            received: transfer.received.size,
            pieces: transfer.conflicting ? null : transfer.pieces,
            since: transfer.lastAt,
          });
        }
      }
    }
    return found;
  }

  /**
   * The record of `sender`'s `stream`, a new one if none is kept; it becomes the one heard from most
   * recently. What is kept is bounded afterwards (`#bound`), once a transfer this one may begin counts.
   */
  #record(sender: MemberId, stream: string): StreamRecord {
    const streams = this.#streams.get(sender) ?? new Map<string, StreamRecord>();
    this.#streams.set(sender, streams);
    const record: StreamRecord = streams.get(stream) ?? {
      report: null,
      heldState: null,
      covered: 0,
      transfers: new Map(),
      givenUp: null,
    };
    streams.delete(stream);
    streams.set(stream, record);
    return record;
  }

  /**
   * A report of `sender`, kept when it is its stream's latest (LOS-17): a newer one replaces the
   * stream's report, a copy or an older one that arrives late changes nothing.
   */
  #keepReport(sender: MemberId, report: StateReport): void {
    const record = this.#record(sender, report.stream);
    if (record.report === null || report.sequence > record.report.value.sequence) {
      record.report = this.#kept(record, report);
    }
  }

  /**
   * A piece of an answer to this client's own request, counted in its transfer (LOS-14) — none when
   * this client is known to hold the stream's state at the answer's number already.
   */
  #count(
    sender: MemberId,
    piece: AnswerPiece,
  ): { record: StreamRecord; transfer: Transfer } | undefined {
    const record = this.#record(sender, piece.stream);
    this.#cover(record);
    if (piece.sequence <= record.covered) {
      return undefined;
    }
    const now = this.#now();
    let transfer = record.transfers.get(piece.sequence);
    if (transfer === undefined) {
      transfer = {
        request: piece.request,
        received: new Set(),
        highest: 0,
        pieces: null,
        report: null,
        conflicting: false,
        lastAt: now,
      };
      record.transfers.set(piece.sequence, transfer);
    }
    transfer.lastAt = now;
    if (piece.request !== transfer.request || piece.piece > MAX_ANSWER_PIECES) {
      transfer.conflicting = true;
    } else {
      transfer.received.add(piece.piece);
      transfer.highest = Math.max(transfer.highest, piece.piece);
    }
    if (piece.pieces !== null) {
      if (
        (transfer.pieces !== null && transfer.pieces !== piece.pieces) ||
        (transfer.report !== null &&
          piece.report !== null &&
          !sameState(transfer.report, piece.report))
      ) {
        transfer.conflicting = true;
      }
      transfer.pieces ??= piece.pieces;
      transfer.report ??= piece.report;
    }
    if (transfer.pieces !== null && transfer.highest > transfer.pieces) {
      transfer.conflicting = true;
    }
    return { record, transfer };
  }

  /**
   * A transfer is whole: this client holds what its last piece states (LOS-18), so does every report
   * of the stream that states the same, and every transfer of the stream up to its number ends.
   */
  #holdWhole(record: StreamRecord, sequence: number, transfer: Transfer): void {
    record.transfers.delete(sequence);
    record.covered = Math.max(record.covered, sequence);
    const stated = transfer.report;
    if (stated === null) {
      return;
    }
    if (record.heldState === null || record.heldState.sequence <= sequence) {
      record.heldState = {
        sequence,
        stateVector: stated.stateVector,
        stateDigest: stated.stateDigest,
      };
    }
    const kept = record.report;
    if (kept !== null && kept.value.sequence >= sequence && sameState(kept.value, stated)) {
      kept.held = true;
    }
    this.#cover(record);
  }

  /**
   * How far this client is known to hold the stream's state, raised by what it holds now — a report
   * it held when it could first compare it (LOS-12, LOS-21), or a transfer's last piece (LOS-14) —; the
   * transfers, and those given up, it covers end.
   */
  #cover(record: StreamRecord): void {
    const kept = record.report;
    if (kept !== null && kept.value.sequence > record.covered && this.#holdsReport(kept)) {
      record.covered = kept.value.sequence;
    }
    for (const [sequence, transfer] of record.transfers) {
      if (
        sequence > record.covered &&
        !transfer.conflicting &&
        transfer.report !== null &&
        this.#holdsState(transfer.report)
      ) {
        record.covered = sequence;
      }
    }
    for (const [sequence, transfer] of record.transfers) {
      if (coveredBy(record.covered, sequence, transfer.conflicting)) {
        record.transfers.delete(sequence);
      }
    }
    if (
      record.givenUp !== null &&
      coveredBy(record.covered, record.givenUp.sequence, record.givenUp.conflicting)
    ) {
      record.givenUp = null;
    }
  }

  /**
   * Keeps what is kept of `sender` bounded: at most OPEN_TRANSFERS_PER_MEMBER transfers, giving up the
   * one heard from least recently — its evidence kept by stream and number —, as many streams with
   * transfers given up — the oldest one's evidence becoming the member's —, and STREAMS_PER_MEMBER
   * streams kept for their reports alone, dropping the one heard from least recently (LOS-17, LOS-22).
   */
  #bound(sender: MemberId): void {
    const streams = this.#streams.get(sender);
    if (streams === undefined) {
      return;
    }
    const open = (): { record: StreamRecord; sequence: number; transfer: Transfer }[] =>
      [...streams.values()].flatMap((record) =>
        [...record.transfers].map(([sequence, transfer]) => ({ record, sequence, transfer })),
      );
    for (let counted = open(); counted.length > OPEN_TRANSFERS_PER_MEMBER; counted = open()) {
      const oldest = counted.reduce((a, b) => (b.transfer.lastAt < a.transfer.lastAt ? b : a));
      oldest.record.transfers.delete(oldest.sequence);
      const before = oldest.record.givenUp;
      oldest.record.givenUp = {
        sequence: Math.max(before?.sequence ?? 0, oldest.sequence),
        since: Math.min(before?.since ?? oldest.transfer.lastAt, oldest.transfer.lastAt),
        conflicting: (before?.conflicting ?? false) || oldest.transfer.conflicting,
      };
    }
    const givenUp = [...streams.values()].filter((record) => record.givenUp !== null);
    for (const record of givenUp.slice(
      0,
      Math.max(0, givenUp.length - OPEN_TRANSFERS_PER_MEMBER),
    )) {
      const since = (record.givenUp as NonNullable<StreamRecord["givenUp"]>).since;
      this.#givenUp.set(sender, Math.min(this.#givenUp.get(sender) ?? since, since));
      record.givenUp = null;
    }
    const plain = [...streams].filter(
      ([, record]) => record.transfers.size === 0 && record.givenUp === null,
    );
    for (const [stream] of plain.slice(0, Math.max(0, plain.length - STREAMS_PER_MEMBER))) {
      streams.delete(stream);
    }
  }

  /**
   * A report as kept: held when it states what the stream's last whole answer did; and with the
   * start of the evidence the stream's previous report showed, when it showed the same kind, so that
   * a newer report saying the same does not make it wait again (LOS-1).
   */
  #kept(record: StreamRecord, report: StateReport): KeptReport {
    const held = record.heldState !== null && sameState(record.heldState, report);
    const previous = record.report;
    return {
      value: report,
      at: this.#now(),
      held,
      differed: this.#digestDiffers(report),
      carried: {
        behind:
          previous !== null && this.#isBehind(previous.value.stateVector)
            ? this.#since(previous, "behind")
            : null,
        diverged:
          previous !== null && this.#divergedIn(previous)
            ? this.#since(previous, "diverged")
            : null,
      },
    };
  }

  #since(report: KeptReport, kind: "behind" | "diverged"): number {
    return report.carried[kind] ?? report.at;
  }

  /**
   * Whether this client holds what a report states: by a whole answer of its stream, or because it
   * held every insertion and deletion within the report's vector when it could first compare them —
   * what it deletes after that it still holds (LOS-12, LOS-18).
   */
  #holdsReport(report: KeptReport): boolean {
    report.differed ??= this.#digestDiffers(report.value);
    return report.held || (!this.#isBehind(report.value.stateVector) && report.differed === false);
  }

  /** Whether this client holds now what a transfer's last piece states — from other answers or edits, say (LOS-14). */
  #holdsState(report: StateReport): boolean {
    return !this.#isBehind(report.stateVector) && this.#digestDiffers(report) === false;
  }

  /** `clientId` is `sender`'s: an edit frame from `sender` carried updates from that one client only. */
  learnClient(clientId: number, sender: MemberId): void {
    this.#owners.set(clientId, sender);
  }

  /** A resync answer was applied: soft evidence of silence is spent, since the state has just been handed over. */
  answered(): void {
    this.#expected.clear();
  }

  /**
   * Notes when evidence first appears and when it goes, so that the wait counts from
   * the first sighting. Call it after every poll.
   */
  observe(): void {
    const now = this.#now();
    // A report that could not be compared when it was heard is judged once it can be (LOS-12).
    for (const streams of this.#streams.values()) {
      for (const record of streams.values()) {
        const report = record.report;
        if (report !== null && report.differed === undefined) {
          report.differed = this.#digestDiffers(report.value);
        }
      }
    }
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

    // The larger of what the sender promised and the pace, plus this client's latency once (LOS-11):
    // a sender that learned a longer pace after its frame cannot keep a shorter promise.
    const pace = this.#options.pace?.() ?? 0;
    for (const [sender, expected] of this.#expected) {
      // One suspicion per member, from its source silent the longest.
      const overdue = [...expected.values()]
        .filter((expectation) => now - expectation.at >= Math.max(expectation.due, pace) + grace)
        .sort((a, b) => a.at - b.at)[0];
      if (overdue !== undefined) {
        found.push({
          kind: "sender-overdue",
          sender,
          since: overdue.at,
          due: Math.max(overdue.due, pace),
        });
      }
    }

    // One suspicion of each kind per member: from its stream whose evidence began first.
    const earliest = (times: readonly number[]): number | undefined =>
      times.length === 0 ? undefined : Math.min(...times);
    for (const [sender, streams] of this.#streams) {
      for (const record of streams.values()) {
        this.#cover(record);
      }
      const reports = [...streams.values()].flatMap((record) =>
        record.report === null ? [] : [record.report],
      );
      const behind = earliest(
        reports
          .filter((report) => this.#isBehind(report.value.stateVector))
          .map((report) => this.#since(report, "behind"))
          .filter((since) => now - since >= grace),
      );
      if (behind !== undefined) {
        found.push({ kind: "behind-heartbeat", sender, since: behind });
      }
      const diverged = earliest(
        reports
          .filter((report) => this.#divergedIn(report))
          .map((report) => this.#since(report, "diverged"))
          .filter((since) => now - since >= grace),
      );
      if (diverged !== undefined) {
        found.push({ kind: "diverged", sender, since: diverged });
      }
      // The creator's word on control state counts for everyone; a member's only on a device of
      // the creator, which learns of a collision no other way (CTL-31).
      if (sender === this.#options.creatorMemberId() || this.#options.isCreatorDevice()) {
        const controlDiverged = earliest(
          reports
            .filter((report) => now - report.at >= grace && this.#controlDivergedIn(report.value))
            .map((report) => report.at),
        );
        if (controlDiverged !== undefined) {
          found.push({ kind: "control-diverged", sender, since: controlDiverged });
        }
      }
      // A piece missing for longer than one more would take: the floor between two messages, which
      // the pace raises for everyone (SND-15), and the waiting time (LOS-1, LOS-14). A transfer given
      // up for the bound is still unresolved, not ended.
      const givenUp = this.#givenUp.get(sender);
      const incomplete = earliest(
        [
          ...[...streams.values()].flatMap((record) => [
            ...[...record.transfers.values()].map((transfer) => transfer.lastAt),
            ...(record.givenUp === null ? [] : [record.givenUp.since]),
          ]),
          ...(givenUp === undefined ? [] : [givenUp]),
        ]
          .map((at) => at + policy.minIntervalMs)
          .filter((since) => now - since >= grace),
      );
      if (incomplete !== undefined) {
        found.push({ kind: "answer-incomplete", sender, since: incomplete });
      }
    }

    if (this.#controlBehindSince !== null && now - this.#controlBehindSince >= grace) {
      found.push({ kind: "control-behind", since: this.#controlBehindSince });
    }
    return found;
  }

  #holds(
    expectation: Expectation,
    stateVector: Uint8Array,
    control: ControlVector | null,
  ): boolean {
    try {
      return expectation.heldBy(stateVector, control);
    } catch {
      // Not a state vector: a heartbeat that says nothing usable holds nothing.
      return false;
    }
  }

  /**
   * Whether a report's state digest differs from what this client deleted of the items its state
   * vector counts, where this client holds all of them (LOS-12). Not for a report this client holds
   * by a whole answer: a difference then is a deletion of its own the stream had not seen (LOS-18).
   */
  #divergedIn(report: KeptReport): boolean {
    report.differed ??= this.#digestDiffers(report.value);
    return !report.held && report.differed === true && this.#digestDiffers(report.value) === true;
  }

  /**
   * Whether `report`'s state digest differs from what this client deleted within its vector, now:
   * `undefined` when the two cannot be compared — this client lacks an insertion the vector counts,
   * or its profile cannot restrict its deletions —, `false` for bytes that are not a state vector.
   */
  #digestDiffers(report: StateReport): boolean | undefined {
    try {
      const within = this.#options.stateDigestWithin(report.stateVector);
      return within === undefined ? undefined : report.stateDigest !== within;
    } catch {
      return false; // not a state vector: no evidence
    }
  }

  #controlDivergedIn(report: StateReport): boolean {
    return (
      report.control !== null &&
      report.controlDigest !== null &&
      this.#options.sameControlVector(report.control) &&
      report.controlDigest !== this.#options.controlDigest()
    );
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
    return this.#options.controlHoles() || this.#options.lacksControlOf(this.#creatorControl);
  }
}
