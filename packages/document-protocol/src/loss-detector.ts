import type { MemberId } from "@tdsp/messenger-port";
import { answerDelayMs, answerWindowMs } from "./answer-turn";
import { type Clock, compareClocks } from "./clock";
import { SteadyClock } from "./steady-clock";
import type { SyncPolicy } from "./sync-policy";

/**
 * Noticing that something may be missing (SPECIFICATION.md §10). A message a messenger accepted and never delivered is invisible to it, and the
 * CRDT tolerates delay, duplication and reordering completely but not loss: one missing
 * update leaves every later update from that sender unapplied, silently and permanently.
 * What a receiver *can* see is evidence, each kind of which this class watches for; none of it
 * proves a loss, and none is believed before the wait it needs. Silence is none: nothing a sender
 * sends says when it sends again.
 *
 * - **A pending gap.** Later updates arrived, an earlier one did not. Indistinguishable
 *   from a late predecessor until it either arrives or does not, so it is reported only
 *   once it has lasted one `expectedLatencyMs`.
 * - **A control clock above this client's** in a report of a device of the creator (LOS-10): a
 *   decision this client lacks. At an equal control clock, **another control digest** (LOS-12). A
 *   `control` frame is no evidence of either: it carries no number, and its control clock need not grow,
 *   so a frame arriving late cannot be told from a newer one.
 * - **A report that shows we are behind.** A report, a request or an answer's last piece
 *   whose state vector accounts for changes this document has not applied (LOS-4).
 * - **A report whose state digest differs** where this client holds every insertion the report
 *   counts: a deletion one of the two lacks (LOS-12).
 * - **An incomplete answer** to this client's own request: one of its numbered pieces is missing
 *   (LOS-14).
 *
 * Each piece of evidence is a **gap** of one **stream** (LOS-25): of one CRDT client's updates, of
 * the deletions or the control state one stream's reports show, of the creator's control clock, of
 * one answer, or of a history truncated.
 * A gap keeps the time it arose until it ends, and has tries of its own: requests to all, at most
 * MAX_GAP_TRIES, the first in a slot of its own after its wait, the waits between them doubling; then
 * it **rests** (LOS-6). A resting gap is woken by a frame that raises its **position** — the furthest
 * point of its stream this client knows of — or by any frame of the member that wrote its CRDT client
 * (LOS-2), at most once in WAKE_SPACING_MS, its request then in a slot of its own as a first try's;
 * and by an absence the application tells of — the start request or the return it brings — or a
 * request of the person, at once (LOS-26). Gaps are not kept across a restart: a starting engine
 * holds none that rests. A gap that no reachable participant can heal thus never spends the tries a
 * later loss of another stream needs.
 *
 * Reports are kept by their sender's **stream** — its engine as it runs now — and a report replaces
 * only an older one of the same stream (LOS-17): a member may run several devices, and the word of
 * one that lags behind must not end what another's showed. Evidence from a stream's report ends with
 * a newer report of that stream that shows none, with a complete answer of that stream to this
 * client's own request — which it then holds —, or once this client's state agrees with it
 * (LOS-18).
 *
 * Of a report's evidence, two kinds cannot tell a loss from a report that crossed what this client
 * received since, nor a stream that ended from one that is silent: a state digest that differs at a
 * state vector this client holds, and a control digest that differs at this client's control clock
 * (LOS-12). Those **lapse** once their stream has not been **heard** for longer than the absence
 * threshold (`absenceMs`, RSY-1): heard is a stream whose frame carrying its tag — a heartbeat, a
 * request, a piece of an answer — brings a number above every one heard of it before, so a frame
 * offered again, or an older one arriving late, does not count, nor does an `edit` or a `control`
 * frame, which carry no tag. A lapsed difference comes back only with a newer report of the stream
 * that still shows it. Its gap keeps its tries meanwhile, shown and asked for by nobody: it lapses, it
 * does not rest, and coming back gives it no new tries. Nothing else lapses: missing predecessors,
 * updates a report shows missing, an answer missing a piece or given up, a truncated history, a
 * control clock above this client's.
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
 * whose losses it must notice too (LOS-4). Its own messages coming back are the engine's
 * to leave out, since only the engine can tell them (an edit of its own Yjs client, a `control`
 * frame under its own device tag).
 *
 * The class reads the world through the functions it is given and the clock, so it holds
 * only what cannot be recomputed: when each gap arose, how far each stream is known, and the tries.
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

/** How many automatic requests to all one gap may cost before it rests (LOS-6, Appendix B). */
export const MAX_GAP_TRIES = 3;

/** The longest wait between two tries of a gap, whatever the doubling would give (LOS-6, Appendix B). */
export const GAP_SPACING_CAP_MS = 600_000;

/**
 * The shortest time between two wakes of one resting gap by a frame — one that raises its position, or
 * one of the member that wrote it (LOS-26, Appendix B).
 */
export const WAKE_SPACING_MS = 600_000;

/** How many CRDT clients the furthest clock named by a frame is kept for (LOS-25): the least recent goes first. */
export const MAX_CLIENT_POSITIONS = 1024;

/** How long a message is taken to need: the policy's expected latency, or a default when it does not say. */
export function lossGraceMs(policy: SyncPolicy): number {
  return policy.expectedLatencyMs > 0 ? policy.expectedLatencyMs : DEFAULT_LOSS_GRACE_MS;
}

export type SyncSuspicionKind =
  /** Updates of one CRDT client are held for a predecessor that did not come (LOS-2). */
  | "pending-gap"
  /** A report — a heartbeat, a request or an answer's last piece — holds changes this client lacks (LOS-4). */
  | "behind-heartbeat"
  /**
   * A report of a device of the creator stated a control clock above the greatest clock among the
   * registers this client holds (LOS-10): a decision it lacks.
   */
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
   * for longer than one more would take. The answer counts for the bootstrap once its last piece is
   * here (RSY-14), not for all of what it carries.
   */
  | "answer-incomplete"
  /**
   * A report of a device of the creator stated this client's control clock with another control digest
   * (LOS-12): a register or the close one of the two lacks, under clocks no greater than that one.
   */
  | "control-diverged"
  /**
   * The bridge's window moved past everything this engine had read (SPECIFICATION.md
   * LOS-8): deliveries it never saw may have been dropped. Held until an answer to this
   * engine's own resync request has been applied (LOS-19).
   */
  | "history-truncated";

/**
 * The stream a gap is of (LOS-25), as a key: `content:<client>` — the updates of one CRDT client —;
 * `content-of:<member>:<stream>` — what one stream's reports count, where the profile cannot tell whose
 * —; `deletions:<member>:<stream>`; `control-report:<stream>` of the creator; `control-clock`;
 * `answer:<member>:<stream>:<number>`; `truncated`.
 */
export type GapKey = string;

export interface SyncSuspicion {
  readonly kind: SyncSuspicionKind;
  /** Whose messages may be missing, when known: who wrote what the gap lacks (LOS-2), else the stream that showed it. */
  readonly sender?: MemberId;
  /** When the gap arose, on the detector's clock (`now`); the wait counts from here. An engine's `syncHealth` reports it on the wall clock (epoch ms). */
  readonly since: number;
  /** The gap's stream (LOS-25). */
  readonly key: GapKey;
  /** How many requests to all were made for it (LOS-6). */
  readonly tries: number;
  /** It rests: its tries ran out and it asks no more by itself until woken (LOS-6, LOS-26). */
  readonly resting?: true;
}

export interface LossDetectorOptions {
  /**
   * The creator, if known: what any of its devices states of control state shows what this client
   * lacks, since only the creator decides and every member holds what reached it of that (LOS-10,
   * LOS-12). A member's control state is no evidence: the creator's devices hold the creator's state
   * (CTL-27, RSY-14).
   */
  readonly creatorMemberId: () => MemberId | undefined;
  readonly policy: () => SyncPolicy;
  /** The client ids the document is waiting on (`pendingGapClients`). */
  readonly pendingGapClients: () => number[];
  /** Whether a sender's state vector accounts for changes the document lacks (`lacksUpdatesOf`). Throws on bytes that are not one. */
  readonly lacksUpdatesOf: (stateVector: Uint8Array) => boolean;
  /**
   * Of the CRDT clients a state vector counts more of than the document holds, the clock it names for
   * each (LOS-4, LOS-25): a gap of each. Without it, what a report shows missing is a gap of the
   * stream that showed it. Throws on bytes that are not a state vector.
   */
  readonly clientsAhead?: (stateVector: Uint8Array) => ReadonlyMap<number, number>;
  /** This client's control clock: the greatest clock among the registers it holds (LOS-10). */
  readonly controlClock: () => Clock;
  /**
   * The digest of what this client deleted of the items `stateVector` counts (LOS-12), when this
   * client holds every insertion that vector counts; `undefined` when it does not, or when the
   * profile cannot restrict its deletions to a vector it does not equal. Throws on bytes that are
   * not a state vector.
   */
  readonly stateDigestWithin: (stateVector: Uint8Array) => string | undefined;
  /** This client's control digest (LOS-24). */
  readonly controlDigest: () => string;
  /** Since when this client's history is truncated (LOS-8, LOS-9, LOS-23), if it is: a gap of its own, asked for at once (LOS-19). */
  readonly truncatedSince?: () => number | undefined;
  /**
   * This client's own stream (LOS-13): the slot of each gap's first try derives from it (LOS-6), so
   * that devices holding the same gap ask at different times.
   */
  readonly stream: () => string;
  /**
   * The clock every wait is measured on, one that never runs back (SND-25, LOS-1) — its engine's, so
   * that the times it reports compare with the engine's; a `SteadyClock` of its own if not given. The times it reports (`since`) are on that clock.
   */
  readonly now?: () => number;
  /**
   * How long a stream may go unheard before what its report shows of a difference in digests lapses
   * (LOS-12): the absence threshold of RSY-1 (Appendix B), which a stream that ended can never cross
   * back over.
   */
  readonly absenceMs: number;
}

/**
 * What a heartbeat, a request or an answer's last piece said of its sender's state (LOS-4, LOS-12),
 * and where it stands in its sender's stream (LOS-13).
 */
export interface StateReport {
  readonly stream: string;
  readonly sequence: number;
  readonly stateVector: Uint8Array;
  readonly stateDigest: string;
  readonly controlClock: Clock | null;
  readonly controlDigest: string | null;
}

/**
 * The furthest a stream stated of its state, over its requests, its reports and the last pieces of
 * its answers (RSY-17, RSY-20): within a stream the state only grows (LOS-13), so the state of the
 * frame numbered highest is the furthest, however the frames arrived. Frames carry no time of sending,
 * and clocks may be off (§1.1): what a stream has to get is judged by what it stated, not by when.
 */
export interface StatedFurthest {
  /** The number of the frame `stateVector` is from. */
  readonly sequence: number;
  readonly stateVector: Uint8Array;
  /**
   * The state digests frames of the stream stated with exactly `stateVector`, at most
   * MAX_STATED_DIGESTS, the latest last: deletions only grow, so any of them that equals what a
   * responder deleted within that vector shows that the stream holds what the responder deleted.
   */
  readonly stateDigests: readonly string[];
  /** The greatest control clock it stated, `null` while it stated none (RSY-16). */
  readonly controlClock: Clock | null;
  /** The control digests it stated with `controlClock`, at most MAX_STATED_DIGESTS, the latest last. */
  readonly controlDigests: readonly string[];
}

/** How many digests a stream's furthest state keeps per vector, and per control clock. */
export const MAX_STATED_DIGESTS = 8;

/** `digests` with `digest`, the latest last, at most MAX_STATED_DIGESTS. */
function withDigest(digests: readonly string[], digest: string): readonly string[] {
  return [...digests.filter((known) => known !== digest), digest].slice(-MAX_STATED_DIGESTS);
}

/** The furthest a stream stated (StatedFurthest), once `report` of it is heard too. */
export function furtherStated(known: StatedFurthest | null, report: StateReport): StatedFurthest {
  let { sequence, stateVector, stateDigests } = known ?? {
    sequence: report.sequence,
    stateVector: report.stateVector,
    stateDigests: [],
  };
  if (sameBytes(report.stateVector, stateVector)) {
    stateDigests = withDigest(stateDigests, report.stateDigest);
    sequence = Math.max(sequence, report.sequence);
  } else if (report.sequence > sequence) {
    ({ sequence, stateVector } = report);
    stateDigests = [report.stateDigest];
  }
  let controlClock = known?.controlClock ?? null;
  let controlDigests = known?.controlDigests ?? [];
  if (report.controlClock !== null && report.controlDigest !== null) {
    const order = controlClock === null ? 1 : compareClocks(report.controlClock, controlClock);
    if (order > 0) {
      controlClock = report.controlClock;
      controlDigests = [report.controlDigest];
    } else if (order === 0) {
      controlDigests = withDigest(controlDigests, report.controlDigest);
    }
  }
  return { sequence, stateVector, stateDigests, controlClock, controlDigests };
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
  /** Whether it answers a request this client made or adopted (RSY-12, RSY-22): only then are its pieces counted, and a whole one held. */
  readonly own: boolean;
  /** The request it answers (`respondsTo`): every piece of one answer names the same. */
  readonly request: string;
  /**
   * The responder's control state, as its snapshot carried it in this piece and this client merged
   * it: its control clock and digest (LOS-24); `null` or absent when the piece carried none.
   */
  readonly control?: MergedControl | null;
}

/** A control state a piece of an answer carried, which this client merged (LOS-18). */
interface MergedControl {
  readonly clock: Clock;
  readonly digest: string;
}

/** An answer to this client's own request of which a piece is still missing (LOS-14). */
export interface IncompleteAnswer {
  readonly sender: MemberId;
  /** How many of its pieces have arrived. */
  readonly received: number;
  /** How many it has, once its last piece has arrived; `null` before. */
  readonly pieces: number | null;
  /** When its most recent piece arrived, on the detector's clock; in an engine's `syncHealth` on the wall clock (epoch ms). */
  readonly since: number;
}

/** How far a stream is known (LOS-25): a CRDT client's clock or a report's number, or a control clock. */
type Position = number | Clock | null;

/** A gap of one stream (LOS-25), and what was asked for it (LOS-6, LOS-26). */
interface Gap {
  kind: SyncSuspicionKind;
  /** Who wrote what it lacks (LOS-2), where known; else the stream that showed it. */
  author: MemberId | undefined;
  /** When it arose: kept until it ends. */
  since: number;
  /** The furthest point of its stream known; it only rises. */
  position: Position;
  /** Requests to all made for it, at most MAX_GAP_TRIES. */
  tries: number;
  lastTryAt: number | null;
  /**
   * When its latest try was a request let go for another's (RSY-22): when that one's time to wait for
   * an answer ends. Its further try is due in its place after that, as a woken gap's is after the wake,
   * so that the devices that let theirs go for one request ask one after another again (LOS-6).
   */
  adoptedUntil: number | null;
  lastWakeAt: number | null;
  /**
   * Woken: a request is due for it although it rests — by a frame that raised its position or one of
   * the member that wrote it, or by `wakeAll`.
   */
  wake: boolean;
  /**
   * When a frame woke it: its request is due in a slot of its own after that, as a first try's is
   * after the gap arose (LOS-6, LOS-26), so that devices woken by the same frame ask one after another.
   */
  wokenAt: number | null;
  /** Woken by an absence the application told of or by the person (`wakeAll`): at once, without WAKE_SPACING_MS or a slot. */
  forced: boolean;
  /**
   * What shows it lapsed (LOS-12): it is neither shown nor asked for, and a request to all is no try of
   * it; it keeps its tries until a newer report of its stream shows it again, or it ends.
   */
  lapsed: boolean;
}

/** What one piece of evidence shows of a gap, as found now. */
interface Evidence {
  kind: SyncSuspicionKind;
  author: MemberId | undefined;
  since: number;
  position: Position;
  /** It lapsed: its stream was not heard for longer than the absence threshold (LOS-12). */
  lapsed: boolean;
}

interface KeptReport {
  readonly value: StateReport;
  readonly at: number;
  /**
   * This client holds what it states: the last piece of an answer to its own request it applied
   * whole, or whose state it held as it was covered (LOS-18).
   */
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
  /** What it shows of a difference in digests lapsed, its stream unheard for too long (LOS-12). */
  lapsed: boolean;
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
  /** The control state a piece of it carried, which this client merged: it covers only once the answer is whole (LOS-18). */
  control: MergedControl | null;
}

/**
 * One stream of a member (LOS-13): its latest report, its transfers (LOS-14), and how far this client
 * is known to hold its state.
 */
interface StreamRecord {
  /** Its latest report; `null` while only pieces of a transfer have come. */
  report: KeptReport | null;
  /**
   * Of its latest report that stated control state — a heartbeat's or a request's; an answer's last
   * piece states none —, the control clock and digest, and since when this client's control state has
   * differed from what its reports stated at an equal clock, over every such report of the stream that
   * showed it (LOS-12, LOS-25).
   */
  control: {
    sequence: number;
    clock: Clock;
    digest: string;
    since: number | null;
    lapsed: boolean;
  } | null;
  /**
   * The highest number heard of the stream in a frame carrying its tag — a heartbeat, a request, a
   * piece of an answer —, and when this client first heard it (LOS-13): how long the stream has been
   * silent, for the lapse of a difference in digests (LOS-12).
   */
  heard: { readonly sequence: number; readonly at: number } | null;
  /**
   * The state of the stream's last answer this client applied whole, or held as its last piece states
   * it: a later report that says the same is held too.
   */
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
  /**
   * The control state the newest whole answer of this stream of the creator held as it answered, at
   * the answer's number, which this client merged (LOS-18): a report of the stream numbered no higher,
   * or stating the same, is no evidence.
   */
  controlSettled: {
    readonly sequence: number;
    readonly clock: Clock;
    readonly digest: string;
  } | null;
  /** The furthest it stated of its state (RSY-20); `null` while only pieces of a transfer have come. */
  furthest: StatedFurthest | null;
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

/** Whether `next` lies further along a stream than `known` (LOS-25): `null` is no position. */
function raises(next: Position, known: Position): boolean {
  if (next === null) return false;
  if (known === null) return true;
  if (typeof next === "number" || typeof known === "number") {
    return typeof next === "number" && typeof known === "number" && next > known;
  }
  return compareClocks(next, known) > 0;
}

/** The further of two positions of one stream. */
function further(a: Position, b: Position): Position {
  return raises(b, a) ? b : a;
}

/** The CRDT client whose updates a gap lacks, for a gap of one client's updates (`content:<client>`, LOS-25). */
function clientOf(key: GapKey): number | undefined {
  const match = /^content:(\d+)$/.exec(key);
  return match === null ? undefined : Number(match[1]);
}

export class LossDetector {
  readonly #options: LossDetectorOptions;
  readonly #now: () => number;
  // Each member's streams, the one heard from least recently first (LOS-17): the latest report of
  // each, at most STREAMS_PER_MEMBER kept for that alone, and the transfers of each (LOS-14).
  #streams = new Map<MemberId, Map<string, StreamRecord>>();
  // Members whose transfers were given up beyond what is kept by stream, and since when: evidence for
  // as long as this engine runs, since no stream is left to show it ended (LOS-22).
  #givenUp = new Map<MemberId, number>();
  // Which member authored which Yjs client id, learned from edit frames that carried
  // exactly one — a full-state answer has many authors and teaches nothing.
  #owners = new Map<number, MemberId>();
  // The furthest clock of each CRDT client an update heard named (LOS-25), the least recent first,
  // at most MAX_CLIENT_POSITIONS.
  #clientClocks = new Map<number, number>();
  // The greatest control clock the creator stated, by any of its devices (LOS-10).
  #creatorClock: Clock | undefined;
  #controlBehindSince: number | null = null;
  // The gaps, by their stream (LOS-25), in the order they arose.
  readonly #gaps = new Map<GapKey, Gap>();

  constructor(options: LossDetectorOptions) {
    this.#options = options;
    const clock = options.now === undefined ? new SteadyClock() : undefined;
    this.#now = options.now ?? (() => (clock as SteadyClock).now());
  }

  /**
   * `sender` stated a control clock in a report — a heartbeat or a request: the creator's, by any of its
   * devices, counts (LOS-10, SND-11).
   */
  heardControlClock(sender: MemberId, controlClock: Clock | null): void {
    if (sender !== this.#options.creatorMemberId() || controlClock === null) {
      return;
    }
    if (this.#creatorClock === undefined || compareClocks(controlClock, this.#creatorClock) > 0) {
      this.#creatorClock = controlClock;
    }
  }

  /**
   * An update named how far each CRDT client it carries reaches (LOS-25): in an `edit` frame, a
   * report's or an answer's. One that names a client further than known raises the position of its
   * gap, which wakes it if it rests (LOS-26).
   */
  heardClocks(clocks: ReadonlyMap<number, number>): void {
    for (const [client, clock] of clocks) {
      const known = this.#clientClocks.get(client);
      this.#clientClocks.delete(client);
      this.#clientClocks.set(client, known === undefined ? clock : Math.max(known, clock));
    }
    for (const oldest of this.#clientClocks.keys()) {
      if (this.#clientClocks.size <= MAX_CLIENT_POSITIONS) break;
      this.#clientClocks.delete(oldest);
    }
  }

  /**
   * A heartbeat or a request said what `sender` holds (LOS-4, LOS-12), at its place in its stream
   * (LOS-17): it replaces the stream's report only when it is newer, so a copy offered again, or an
   * older one that arrives late, changes nothing — nor does it count as the stream heard (LOS-12).
   * Judged against this client's current state.
   */
  heardReport(sender: MemberId, report: StateReport): void {
    this.#hear(this.#record(sender, report.stream), report.sequence);
    this.#keepReport(sender, report);
    this.#bound(sender);
    this.heardControlClock(sender, report.controlClock);
  }

  /**
   * A piece of an answer was applied (LOS-14). Its last piece is the responder's report, as a
   * heartbeat's (LOS-4, LOS-12). Of an answer to this client's own request the pieces are counted, as
   * a transfer of their own: one missing is evidence, and once all of them are here this client holds
   * what the last one states, so no digest of it is evidence any longer — a difference then only
   * shows what this client deleted itself (LOS-18). A piece that is not the last states nothing, and
   * ends no other transfer, of its stream or another. The control state of the creator's snapshot a
   * counted piece carried covers what the stream stated up to the answer's number once the answer is
   * whole, or at once where this client holds the stream's state at that number already (LOS-18).
   */
  heardAnswerPiece(sender: MemberId, piece: AnswerPiece): void {
    // Heard before anything of it is kept, so that a difference the stream's report showed lapses
    // first if the stream was silent too long (LOS-12). A stream kept for nothing yet is heard where a
    // piece begins to keep it: a counted one, or a last one, which states its sender's state.
    const heard =
      this.#streams.get(sender)?.get(piece.stream) ??
      (piece.own || piece.report !== null ? this.#record(sender, piece.stream) : undefined);
    if (heard !== undefined) this.#hear(heard, piece.sequence);
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
    const control = piece.control ?? null;
    if (piece.own && control !== null && sender === this.#options.creatorMemberId()) {
      if (counted !== undefined) {
        counted.transfer.control ??= control;
      } else {
        this.#mergedControlOf(this.#record(sender, piece.stream), piece.sequence, control);
      }
    }
    if (counted !== undefined && whole(counted.transfer)) {
      this.#holdWhole(counted.record, piece.sequence, counted.transfer);
    }
    this.#bound(sender);
  }

  /**
   * A frame of `sender`'s `stream` that carries its tag and states nothing the detector keeps — a piece
   * of an answer that is not the last, to another's request — brought `sequence` (LOS-13): the stream
   * is heard, if it is kept (LOS-12).
   */
  heardStream(sender: MemberId, stream: string, sequence: number): void {
    const record = this.#streams.get(sender)?.get(stream);
    if (record !== undefined) this.#hear(record, sequence);
  }

  /**
   * A frame of the record's stream carrying its tag brought `sequence` (LOS-13). Above every number
   * heard of the stream before, the stream is heard now — once what its report showed of a difference
   * in digests lapsed, if it was silent for longer than the absence threshold (LOS-12). A frame offered
   * again, or an older one arriving late, is not heard: a mere repeat must not keep the evidence.
   */
  #hear(record: StreamRecord, sequence: number): void {
    if (record.heard !== null && sequence <= record.heard.sequence) return;
    this.#lapse(record);
    record.heard = { sequence, at: this.#now() };
  }

  /**
   * The record's stream has not been heard for longer than the absence threshold (RSY-1): what its
   * latest report shows of a difference in digests, at a vector or a control clock this client holds,
   * lapses (LOS-12). It comes back only with a newer report, which replaces this one (LOS-17).
   */
  #lapse(record: StreamRecord): void {
    if (record.heard === null || this.#now() - record.heard.at <= this.#options.absenceMs) return;
    if (record.report !== null) record.report.lapsed = true;
    if (record.control !== null) record.control.lapsed = true;
  }

  /**
   * The requests of this client's own that an answer is still arriving to in pieces (LOS-14): kept
   * while it does, however long ago they went out (RSY-12). Transfers given up for the bound are not
   * among them.
   */
  requestsUnderWay(): ReadonlySet<string> {
    const found = new Set<string>();
    for (const streams of this.#streams.values()) {
      for (const record of streams.values()) {
        for (const transfer of record.transfers.values()) found.add(transfer.request);
      }
    }
    return found;
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
      control: null,
      heldState: null,
      covered: 0,
      transfers: new Map(),
      givenUp: null,
      controlSettled: null,
      furthest: null,
      heard: null,
    };
    streams.delete(stream);
    streams.set(stream, record);
    return record;
  }

  /**
   * The furthest `sender`'s `stream` stated of its state (RSY-20), while the stream is kept (LOS-17);
   * `undefined` for one not kept. Asking changes nothing of what is kept.
   */
  statedFurthest(sender: MemberId, stream: string): StatedFurthest | undefined {
    return this.#streams.get(sender)?.get(stream)?.furthest ?? undefined;
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
    record.furthest = furtherStated(record.furthest, report);
    // What the creator states of control state is judged from its stream's latest report that states
    // any: a report that shows the same difference again keeps the time the first showed it (LOS-25).
    // One numbered no higher than a whole answer whose control state this client merged is covered by
    // it (LOS-18).
    if (
      sender === this.#options.creatorMemberId() &&
      report.controlClock !== null &&
      report.controlDigest !== null &&
      (record.control === null || report.sequence > record.control.sequence) &&
      (record.controlSettled === null || report.sequence > record.controlSettled.sequence)
    ) {
      const settled = record.controlSettled;
      const same =
        settled !== null &&
        compareClocks(settled.clock, report.controlClock) === 0 &&
        settled.digest === report.controlDigest;
      if (settled !== null && !same) record.controlSettled = null;
      const differs = this.#controlDivergedIn(report) && !same;
      record.control = {
        sequence: report.sequence,
        clock: report.controlClock,
        digest: report.controlDigest,
        since: differs ? (record.control?.since ?? this.#now()) : null,
        lapsed: false,
      };
    }
  }

  /**
   * A whole answer of the record's stream of the creator, numbered `sequence`, carried control state
   * this client merged — or this client held the stream's state at that number already: it holds what
   * that stream held as it answered (LOS-18). That covers the stream's reports that state control state
   * numbered no higher, and those that state exactly that clock and digest (`controlSettled`); not a
   * newer report that states another state, which stays evidence, nor what a newer answer covered.
   */
  #mergedControlOf(record: StreamRecord, sequence: number, control: MergedControl): void {
    const settled = record.controlSettled;
    if (settled === null || sequence > settled.sequence) {
      record.controlSettled = { sequence, clock: control.clock, digest: control.digest };
    }
    if (record.control !== null && record.control.sequence <= sequence) {
      record.control = null;
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
        control: null,
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
    if (transfer.control !== null) this.#mergedControlOf(record, sequence, transfer.control);
    if (transfer.report === null) {
      return;
    }
    this.#holdState(record, sequence, transfer.report);
    this.#cover(record);
  }

  /**
   * This client holds what the stream stated at `sequence`, by an answer of that number: so does
   * every report of the stream numbered no lower that states the same, whatever this client deleted
   * since (LOS-18).
   */
  #holdState(record: StreamRecord, sequence: number, stated: StateReport): void {
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
  }

  /**
   * How far this client is known to hold the stream's state, raised by what it holds now — a report
   * it held when it could first compare it (LOS-12, LOS-21), or a transfer's last piece (LOS-14) —; the
   * transfers, and those given up, it covers end, and what the last piece of one states, where this
   * client holds it, it holds as by a whole answer (LOS-18).
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
        // Where it holds now every insertion and deletion the last piece states, it holds that state
        // as a whole answer would have brought it: a difference a later report of that state shows is
        // what it deleted itself (LOS-18). Not where it does not: what the missing pieces carried
        // may be what it lacks.
        if (
          !transfer.conflicting &&
          transfer.report !== null &&
          this.#holdsState(transfer.report)
        ) {
          this.#holdState(record, sequence, transfer.report);
        }
        // This client holds the stream's state at its number, and merged the control state it carried.
        if (!transfer.conflicting && transfer.control !== null) {
          this.#mergedControlOf(record, sequence, transfer.control);
        }
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
      lapsed: false,
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

  /**
   * A frame of `sender` was read, not this client's own coming back: it wakes every resting gap of a
   * CRDT client `sender` is known to have written (LOS-2, LOS-26), under the bound a frame that raises
   * the gap's position has, at most once in WAKE_SPACING_MS. Its writer holds what the gap lacks and
   * is there again, though after a start it writes under a client of its own (LOS-27), and nothing of
   * the gap's stream moves on. A lapsed gap comes back only with a newer report of its stream (LOS-12).
   */
  heardFrom(sender: MemberId): void {
    for (const [key, gap] of this.#gaps) {
      const client = clientOf(key);
      if (gap.lapsed || client === undefined) continue;
      if (gap.tries >= MAX_GAP_TRIES && this.#owners.get(client) === sender) {
        this.#wake(gap);
      }
    }
  }

  /**
   * Notes when evidence first appears and when it goes, so that the wait counts from
   * the first sighting. Call it after every poll.
   */
  observe(): void {
    // A report that could not be compared when it was heard is judged once it can be (LOS-12).
    for (const streams of this.#streams.values()) {
      for (const record of streams.values()) {
        const report = record.report;
        if (report !== null && report.differed === undefined) {
          report.differed = this.#digestDiffers(report.value);
        }
      }
    }
    this.#reconcile();
  }

  /**
   * The gaps as the evidence shows them now (LOS-25): one that shows no longer ends, a new one arises
   * with no tries, and one whose stream a frame carried further than known has its position raised —
   * which wakes it, if it rests (LOS-26).
   */
  #reconcile(): void {
    const found = this.#evidence();
    for (const key of this.#gaps.keys()) {
      if (!found.has(key)) this.#gaps.delete(key);
    }
    for (const [key, evidence] of found) {
      const gap = this.#gaps.get(key);
      if (gap === undefined) {
        this.#gaps.set(key, {
          ...evidence,
          tries: 0,
          lastTryAt: null,
          adoptedUntil: null,
          lastWakeAt: null,
          wake: false,
          wokenAt: null,
          forced: false,
        });
        continue;
      }
      // Lapsed, it is neither shown nor asked for, and keeps its tries (LOS-12).
      gap.lapsed = evidence.lapsed;
      gap.kind = evidence.kind;
      gap.author = evidence.author ?? gap.author;
      // What an answer missing a piece waits for moves with each piece that comes (LOS-14).
      if (gap.kind === "answer-incomplete") gap.since = evidence.since;
      if (raises(evidence.position, gap.position)) {
        gap.position = evidence.position;
        if (gap.tries >= MAX_GAP_TRIES) this.#wake(gap);
      }
    }
  }

  /** A frame woke a resting gap: its request is due in its slot from now on, unless it was woken already (LOS-26). */
  #wake(gap: Gap): void {
    if (gap.wake) return;
    gap.wake = true;
    gap.wokenAt = this.#now();
  }

  /** Every piece of evidence there is now, by the gap it is of (LOS-25), with when it began and its stream's position. */
  #evidence(): Map<GapKey, Evidence> {
    const now = this.#now();
    const policy = this.#options.policy();
    const found = new Map<GapKey, Evidence>();
    const add = (key: GapKey, evidence: Evidence): void => {
      const had = found.get(key);
      if (had === undefined) {
        found.set(key, evidence);
        return;
      }
      had.since = Math.min(had.since, evidence.since);
      had.position = further(had.position, evidence.position);
      had.author ??= evidence.author;
      had.lapsed &&= evidence.lapsed;
      // What this client's own state shows names the gap first (LOS-2).
      if (evidence.kind === "pending-gap") had.kind = "pending-gap";
    };
    for (const client of this.#options.pendingGapClients()) {
      add(`content:${client}`, {
        kind: "pending-gap",
        author: this.#owners.get(client),
        since: now,
        position: this.#clientClocks.get(client) ?? null,
        lapsed: false,
      });
    }
    const creator = this.#options.creatorMemberId();
    for (const [sender, streams] of this.#streams) {
      for (const [stream, record] of streams) {
        this.#cover(record);
        this.#lapse(record);
        const report = record.report;
        if (report !== null && this.#isBehind(report.value.stateVector)) {
          const since = this.#since(report, "behind");
          const ahead = this.#clientsAhead(report.value.stateVector);
          if (ahead === undefined || ahead.size === 0) {
            add(`content-of:${sender}:${stream}`, {
              kind: "behind-heartbeat",
              author: sender,
              since,
              position: report.value.sequence,
              lapsed: false,
            });
          } else {
            for (const [client, clock] of ahead) {
              add(`content:${client}`, {
                kind: "behind-heartbeat",
                author: this.#owners.get(client) ?? sender,
                since,
                position: Math.max(clock, this.#clientClocks.get(client) ?? 0),
                lapsed: false,
              });
            }
          }
        }
        // A difference in digests at a vector this client holds lapses with its stream's silence (LOS-12).
        if (report !== null && this.#divergedIn(report)) {
          add(`deletions:${sender}:${stream}`, {
            kind: "diverged",
            author: sender,
            since: this.#since(report, "diverged"),
            position: report.value.sequence,
            lapsed: report.lapsed,
          });
        }
        // What a device of the creator states of control state shows what this client lacks (LOS-12):
        // only it decides. A newer report that shows the same keeps the time the first showed it. At
        // this client's clock, it lapses with its stream's silence.
        if (sender === creator) {
          const since = this.#creatorReportDivergence(record);
          const control = record.control;
          if (since !== undefined && control !== null) {
            add(`control-report:${stream}`, {
              kind: "control-diverged",
              author: sender,
              since,
              position: control.sequence,
              lapsed: control.lapsed,
            });
          }
        }
        // A piece missing for longer than one more would take: the floor between two messages, which
        // the pace raises for everyone (SND-15), and the waiting time (LOS-1, LOS-14). A transfer given
        // up for the bound is still unresolved, not ended.
        for (const [sequence, transfer] of record.transfers) {
          add(`answer:${sender}:${stream}:${sequence}`, {
            kind: "answer-incomplete",
            author: sender,
            since: transfer.lastAt + policy.minIntervalMs,
            position: null,
            lapsed: false,
          });
        }
        if (record.givenUp !== null) {
          add(`answer:${sender}:${stream}:${record.givenUp.sequence}`, {
            kind: "answer-incomplete",
            author: sender,
            since: record.givenUp.since + policy.minIntervalMs,
            position: null,
            lapsed: false,
          });
        }
      }
      const givenUp = this.#givenUp.get(sender);
      if (givenUp !== undefined) {
        add(`answer:${sender}`, {
          kind: "answer-incomplete",
          author: sender,
          since: givenUp + policy.minIntervalMs,
          position: null,
          lapsed: false,
        });
      }
    }
    if (this.#controlIsBehind()) {
      this.#controlBehindSince ??= now;
      add("control-clock", {
        kind: "control-behind",
        author: undefined,
        since: this.#controlBehindSince,
        position: this.#creatorClock ?? null,
        lapsed: false,
      });
    } else {
      this.#controlBehindSince = null;
    }
    const truncated = this.#options.truncatedSince?.();
    if (truncated !== undefined) {
      add("truncated", {
        kind: "history-truncated",
        author: undefined,
        since: truncated,
        position: null,
        lapsed: false,
      });
    }
    return found;
  }

  /** The clients a state vector counts more of than this client holds, or `undefined` when the profile cannot tell. */
  #clientsAhead(stateVector: Uint8Array): ReadonlyMap<number, number> | undefined {
    const ahead = this.#options.clientsAhead;
    if (ahead === undefined) return undefined;
    try {
      return ahead(stateVector);
    } catch {
      return undefined; // not a state vector: no evidence
    }
  }

  /** The gaps that have lasted long enough to be worth telling somebody about: a truncated history at once (LOS-19). */
  suspicions(): SyncSuspicion[] {
    this.#reconcile();
    const now = this.#now();
    const grace = lossGraceMs(this.#options.policy());
    const found: SyncSuspicion[] = [];
    for (const [key, gap] of this.#gaps) {
      if (gap.lapsed || (gap.kind !== "history-truncated" && now - gap.since < grace)) continue;
      found.push({
        kind: gap.kind,
        ...(gap.author === undefined ? {} : { sender: gap.author }),
        since: gap.since,
        key,
        tries: gap.tries,
        ...(gap.tries >= MAX_GAP_TRIES ? { resting: true as const } : {}),
      });
    }
    return found;
  }

  /** Whether this client holds any gap, however new, that has not lapsed (RSY-1, LOS-12). */
  get hasGaps(): boolean {
    this.#reconcile();
    return [...this.#gaps.values()].some((gap) => !gap.lapsed);
  }

  /**
   * How long a gap waits before a request counts for it: a conservative multiple of the waiting time,
   * none for a truncated history (LOS-6, LOS-19).
   */
  #firstWait(gap: Gap): number {
    return gap.kind === "history-truncated" ? 0 : 2 * lossGraceMs(this.#options.policy());
  }

  /**
   * How long after it arose a gap's first try is due (LOS-6): its wait, and then a slot derived from the
   * gap and this client's own stream as a member's turn is from a request and its stream (RSY-20),
   * spread evenly over the answer window. Devices that hold the same gap — a change the messenger lost
   * for all of them — so ask one after another, and one that hears another's request first lets its own
   * go for it (RSY-22), however close together they heard what showed the gap. A truncated history asks
   * at once (LOS-19).
   */
  #firstTryAfter(key: GapKey, gap: Gap): number {
    return this.#firstWait(gap) + this.#place(key, gap);
  }

  /** A gap's place (LOS-6): derived from the gap and this client's own stream over the answer window; none for a truncated history. */
  #place(key: GapKey, gap: Gap): number {
    if (gap.kind === "history-truncated") return 0;
    const window = answerWindowMs(this.#options.policy().expectedLatencyMs);
    return answerDelayMs(key, this.#options.stream(), window);
  }

  /**
   * When a further try of a gap that still has tries is about to be made (LOS-6): once `expiry` times
   * two to the tries made passed since the try before, never more than GAP_SPACING_CAP_MS — and, where
   * that try was a request let go for another's, once that one had the time it may wait (RSY-22).
   */
  #furtherTryFrom(gap: Gap, expiry: number): number {
    const spaced =
      (gap.lastTryAt as number) + Math.min(GAP_SPACING_CAP_MS, expiry * 2 ** gap.tries);
    return gap.adoptedUntil === null ? spaced : Math.max(spaced, gap.adoptedUntil);
  }

  /**
   * When a further try of a gap is due (LOS-6): once it is about to be made; where the try before was
   * a request let go for another's, in its place after that, as a first try's is after its wait —
   * the devices that let theirs go for one request would otherwise all ask again at once, when it
   * expired (RSY-22).
   */
  #furtherTryAt(key: GapKey, gap: Gap, expiry: number): number {
    const from = this.#furtherTryFrom(gap, expiry);
    return gap.adoptedUntil === null ? from : from + this.#place(key, gap);
  }

  /**
   * When the request of a resting gap a frame woke is due (LOS-26): once WAKE_SPACING_MS passed since
   * its last wake, a wait and a slot after it was woken, as its first try after it arose (LOS-6) — so
   * that devices that read the same frame ask one after another, and those that hear another's
   * request first let theirs go for it (RSY-22).
   */
  #wokenTryAt(key: GapKey, gap: Gap): number {
    const spaced = (gap.lastWakeAt ?? Number.NEGATIVE_INFINITY) + WAKE_SPACING_MS;
    const woken = Math.max(gap.wokenAt ?? this.#now(), spaced);
    return woken + this.#firstTryAfter(key, gap);
  }

  /**
   * The gaps a request is due for now (LOS-6, LOS-26), `expiry` being how long a request that does not
   * ask all waits for an answer (RSY-4): a gap's first try once it has lasted its wait and its slot; each
   * further one `expiry` times two to the tries made after the one before, never more than
   * GAP_SPACING_CAP_MS — after a try let go for another's request, once that one expired and then its
   * slot (RSY-22) —; once MAX_GAP_TRIES were made, none — but for a resting gap that was woken: by a
   * frame, at most once in WAKE_SPACING_MS and in its slot after the wake; by `wakeAll`, at once.
   */
  dueGaps(now: number, expiry: number): GapKey[] {
    this.#reconcile();
    const due: GapKey[] = [];
    for (const [key, gap] of this.#gaps) {
      if (gap.lapsed) continue;
      if (gap.tries === 0) {
        if (now - gap.since >= this.#firstTryAfter(key, gap)) due.push(key);
      } else if (gap.tries < MAX_GAP_TRIES) {
        if (now >= this.#furtherTryAt(key, gap, expiry)) due.push(key);
      } else if (gap.wake && (gap.forced || now >= this.#wokenTryAt(key, gap))) {
        due.push(key);
      }
    }
    return due;
  }

  /**
   * The gaps whose first try, whose further try after one let go for another's request, or whose
   * request after a wake by a frame, waits for its slot alone now (LOS-6, LOS-26), `expiry` as
   * `dueGaps` takes it: they lasted their wait, so a request is about to be made for them, and
   * another's request to all that reaches no further on them may be let go for already, its answers
   * taken as they come (RSY-22).
   */
  awaitingSlot(now: number, expiry: number): GapKey[] {
    this.#reconcile();
    const waiting: GapKey[] = [];
    for (const [key, gap] of this.#gaps) {
      if (gap.lapsed) continue; // asked for by nobody, let go for nobody's either (LOS-12)
      if (gap.tries === 0) {
        const lasted = now - gap.since;
        if (lasted >= this.#firstWait(gap) && lasted < this.#firstTryAfter(key, gap))
          waiting.push(key);
      } else if (gap.tries < MAX_GAP_TRIES) {
        if (now >= this.#furtherTryFrom(gap, expiry) && now < this.#furtherTryAt(key, gap, expiry))
          waiting.push(key);
      } else if (gap.wake && !gap.forced) {
        const at = this.#wokenTryAt(key, gap);
        if (now < at && now >= at - this.#firstTryAfter(key, gap) + this.#firstWait(gap))
          waiting.push(key);
      }
    }
    return waiting;
  }

  /**
   * A request of this client's own to all went out at `now`, was refused for good, or was let go for
   * another's that reaches no further (LOS-6, RSY-22): a try of each gap in `keys`, or, without them,
   * of every gap whose wait had passed, its slot come or not — the request states what this client
   * holds, so it asks for that gap too —; a resting one that was woken counts it as its wake, and
   * rests on (LOS-26). `adoptedUntil`, for one let go, is when the other's request had the time it may
   * wait: a further try of those gaps comes in their slot after it (RSY-22).
   */
  tried(now: number, keys?: readonly GapKey[], adoptedUntil?: number): void {
    const gaps = (
      keys === undefined
        ? [...this.#gaps.values()].filter((gap) => now - gap.since >= this.#firstWait(gap))
        : keys.flatMap((key) => this.#gaps.get(key) ?? [])
    ).filter((gap) => !gap.lapsed);
    for (const gap of gaps) {
      if (gap.tries < MAX_GAP_TRIES) {
        gap.tries += 1;
        gap.lastTryAt = now;
        gap.adoptedUntil = adoptedUntil ?? null;
      } else if (gap.wake) {
        gap.wake = false;
        gap.wokenAt = null;
        gap.forced = false;
        gap.lastWakeAt = now;
      }
    }
  }

  /**
   * An absence the application tells of — the start request or the return it brings — or the person
   * wakes every resting gap at once: the next request to all is theirs (LOS-26).
   */
  wakeAll(): void {
    this.#reconcile();
    for (const gap of this.#gaps.values()) {
      // A lapsed one is asked for by nobody (LOS-12): the request of this wake is not its.
      if (gap.tries >= MAX_GAP_TRIES && !gap.lapsed) {
        gap.wake = true;
        gap.forced = true;
      }
    }
  }

  /**
   * When the latest report that states control state of a stream of the creator began to differ from
   * this client's control state at an equal clock (LOS-12), judged now; one that does not differ now
   * ends, and so does one stating what a whole answer of that stream held as it answered (LOS-18).
   */
  #creatorReportDivergence(record: StreamRecord): number | undefined {
    const control = record.control;
    if (control === null) return undefined;
    const settled = record.controlSettled;
    if (
      settled !== null &&
      compareClocks(settled.clock, control.clock) === 0 &&
      settled.digest === control.digest
    ) {
      control.since = null;
      return undefined;
    }
    if (this.#controlDivergedIn({ controlClock: control.clock, controlDigest: control.digest })) {
      control.since ??= this.#now();
      return control.since;
    }
    control.since = null;
    return undefined;
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

  /** A report whose control clock equals this client's and whose control digest does not (LOS-12). */
  #controlDivergedIn(report: Pick<StateReport, "controlClock" | "controlDigest">): boolean {
    return (
      report.controlClock !== null &&
      report.controlDigest !== null &&
      compareClocks(report.controlClock, this.#options.controlClock()) === 0 &&
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

  /** Whether the creator stated a control clock above this client's (LOS-10). */
  #controlIsBehind(): boolean {
    return (
      this.#creatorClock !== undefined &&
      compareClocks(this.#creatorClock, this.#options.controlClock()) > 0
    );
  }
}
