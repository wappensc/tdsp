/**
 * Who answers a resync request, and when (SPECIFICATION.md RSY-6, RSY-20; Appendix B):
 *
 * - **At once:** every device of the creator, and every other device of the requester's own
 *   member — they hold the whole, and one of them is usually at hand.
 * - **At its turn, and only when the request carries `all`:** everyone else. Its turn is the time
 *   it heard the request plus a delay it derives from the request's `requestId` and its own stream
 *   (LOS-13), spread evenly over a window of 6 × its expected latency, at least 30 s and at most
 *   5 min. Before its turn it falls silent once it hears answers to that request that hold what it
 *   would give — its content and its control state as it held them, with what the requester stated
 *   (RSY-20). Every request carries `all` but the first of a bootstrap outside a return (RSY-21).
 * - **Never:** an engine that does not know the creator, and an engine to its own request.
 *
 * A delay derived from the request and the responder's stream spreads the members' answers without
 * any of them knowing who else is there, and a request offered again keeps its turn; two devices of
 * one member have different streams, so different turns. The first answer silences the others that
 * hold no more than it does, so a request to all usually costs one answer — on a messenger that
 * shows every message in the group's chat, that is what keeps a bootstrap from flooding it —, and a
 * member that holds what it lacks still answers.
 *
 * Whether a responder has anything to answer (RSY-17), and the throttle (RSY-9), apply besides;
 * this module only says whether and when it may. Pure: the caller passes the times.
 */

import type { MemberId } from "@tdsp/messenger-port";
import { sha256 } from "./digest";

/** The least window over which members' turns are spread. */
export const MIN_ANSWER_WINDOW_MS = 30_000;

/** The greatest window over which members' turns are spread. */
export const MAX_ANSWER_WINDOW_MS = 300_000;

/** The window, in multiples of the expected latency. */
export const ANSWER_WINDOW_LATENCIES = 6;

/**
 * The window over which members' turns are spread: 6 × `expectedLatencyMs`, at least 30 s and at
 * most 5 min. A latency that is negative, not finite or 0 (unknown) counts as 0, as pacing reads it
 * (SND-1), and gives the least window.
 */
export function answerWindowMs(expectedLatencyMs: number): number {
  const latency =
    Number.isFinite(expectedLatencyMs) && expectedLatencyMs > 0 ? expectedLatencyMs : 0;
  return Math.min(
    Math.max(ANSWER_WINDOW_LATENCIES * latency, MIN_ANSWER_WINDOW_MS),
    MAX_ANSWER_WINDOW_MS,
  );
}

const textEncoder = new TextEncoder();

/**
 * How long after hearing a request a member waits before its turn: ⌊window · h / 2^32⌋, `h` the
 * first 4 bytes, big-endian, of SHA-256 over the UTF-8 of `<requestId>:<stream>`. From 0 up to
 * the window, never the window itself; spread evenly, since the stream is random (LOS-13) and
 * SHA-256 mixes it with the request.
 */
export function answerDelayMs(requestId: string, stream: string, windowMs: number): number {
  const hash = sha256(textEncoder.encode(`${requestId}:${stream}`));
  const h = new DataView(hash.buffer, hash.byteOffset, 4).getUint32(0);
  return Math.floor((windowMs * h) / 2 ** 32);
}

/** Whether, and when, an engine may answer one request. */
export type AnswerTurn =
  | { readonly kind: "never" }
  | { readonly kind: "at-once" }
  | { readonly kind: "turn"; readonly at: number };

export interface AnswerTurnInput {
  /** The answering engine's own member. */
  readonly self: MemberId;
  /** The document's creator; `undefined` when the engine does not know it. */
  readonly creator: MemberId | undefined;
  /** The member that sent the request. */
  readonly requester: MemberId;
  /** Whether the request is one this engine made itself, by its `requestId` (RSY-6). */
  readonly ownRequest: boolean;
  /** The request's `all`: whether any member may answer it. */
  readonly all: boolean;
  readonly requestId: string;
  /** The answering engine's own stream (LOS-13). */
  readonly stream: string;
  /** When the engine first heard the request (RSY-19). */
  readonly heardAt: number;
  /** The answering engine's own expected latency (§3.5). */
  readonly expectedLatencyMs: number;
}

/** Whether, and when, an engine may answer a request (RSY-6, RSY-20). */
export function answerTurn(input: AnswerTurnInput): AnswerTurn {
  if (input.creator === undefined || input.ownRequest) {
    return { kind: "never" };
  }
  if (input.self === input.creator || input.self === input.requester) {
    return { kind: "at-once" };
  }
  if (!input.all) {
    return { kind: "never" };
  }
  const delay = answerDelayMs(
    input.requestId,
    input.stream,
    answerWindowMs(input.expectedLatencyMs),
  );
  return { kind: "turn", at: input.heardAt + delay };
}

/**
 * What an engine does with a request it keeps, at `now` (RSY-9, RSY-20): `answer` it, `wait` for its
 * turn, or `drop` it. One that may answer only because of `all` drops it when, before its turn, it
 * heard the last pieces of answers from anyone whose `respondsTo` names the request — whether it
 * accepts them or not — that hold what it would give; `answerHeardAt` is when it had first heard
 * such answers, which the caller tells. Those that answer at once are not silenced by another's
 * answer. An answer whose first piece went out is sent to the end (SND-17) and asks this no more.
 */
export function answerAction(
  turn: AnswerTurn,
  now: number,
  answerHeardAt: number | undefined,
): "answer" | "wait" | "drop" {
  switch (turn.kind) {
    case "never":
      return "drop";
    case "at-once":
      return "answer";
    case "turn":
      if (answerHeardAt !== undefined && answerHeardAt < turn.at) {
        return "drop";
      }
      return now >= turn.at ? "answer" : "wait";
  }
}
