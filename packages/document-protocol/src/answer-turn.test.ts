import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type AnswerTurnInput,
  answerAction,
  answerDelayMs,
  answerTurn,
  answerWindowMs,
  MAX_ANSWER_WINDOW_MS,
  MIN_ANSWER_WINDOW_MS,
} from "./answer-turn";

/**
 * Who answers a resync request, and when (RSY-6, RSY-20): the
 * creator's devices and the requester's own devices at once; everyone else only when the request
 * carries `all`, at a turn derived from the request and its own stream, and silent once another
 * answered first.
 */

/** 16 lowercase hex digits from a seed, as `requestId` and stream are (LOS-13, RSY-16). */
function hexId(seed: number): string {
  return createHash("sha256").update(`id-${seed}`).digest("hex").slice(0, 16);
}

const base: AnswerTurnInput = {
  self: "bob",
  creator: "alice",
  requester: "carol",
  ownRequest: false,
  all: false,
  requestId: "c41d07e9a2b85f36",
  stream: "0c4f9a2be81d7365",
  heardAt: 1_000_000,
  expectedLatencyMs: 10_000,
};

describe("the window over which members' turns are spread", () => {
  it("is 6 × the expected latency, at least 30 s and at most 5 min", () => {
    expect(answerWindowMs(10_000)).toBe(60_000); // Signal's suggested latency
    expect(answerWindowMs(5_000)).toBe(30_000); // a Matrix homeserver's
    expect(answerWindowMs(60_000)).toBe(300_000); // email's
    expect(answerWindowMs(7_500)).toBe(45_000);
    expect(answerWindowMs(1)).toBe(MIN_ANSWER_WINDOW_MS);
    expect(answerWindowMs(3_600_000)).toBe(MAX_ANSWER_WINDOW_MS);
  });

  it("is the least for a latency that is unknown, negative or not finite (SND-1)", () => {
    for (const latency of [0, -5_000, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(answerWindowMs(latency), String(latency)).toBe(MIN_ANSWER_WINDOW_MS);
    }
  });
});

describe("a member's delay before its turn", () => {
  it("is ⌊window · h / 2^32⌋, h the first 4 bytes of SHA-256 over <requestId>:<stream>", () => {
    // The example of Appendix B (RSY-20), computed with Node's SHA-256.
    expect(answerDelayMs("c41d07e9a2b85f36", "0c4f9a2be81d7365", 60_000)).toBe(26_075);
    expect(answerDelayMs("c41d07e9a2b85f36", "a91b3e70d24c6f58", 60_000)).toBe(6_436);
    for (let i = 0; i < 200; i++) {
      const [requestId, stream] = [hexId(2 * i), hexId(2 * i + 1)];
      const h = createHash("sha256").update(`${requestId}:${stream}`).digest().readUInt32BE(0);
      expect(answerDelayMs(requestId, stream, 300_000)).toBe(Math.floor((300_000 * h) / 2 ** 32));
    }
  });

  it("is the same for the same request and stream, so a request offered again keeps its turn", () => {
    const turn = answerTurn({ ...base, all: true });
    expect(answerTurn({ ...base, all: true })).toEqual(turn);
  });

  it("lies within the window, spread evenly over it", () => {
    const window = 60_000;
    const bins = new Array<number>(10).fill(0);
    const requests = 10_000;
    for (let i = 0; i < requests; i++) {
      const delay = answerDelayMs(hexId(i), "0c4f9a2be81d7365", window);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(window);
      const bin = Math.floor((delay * bins.length) / window);
      bins[bin] = (bins[bin] ?? 0) + 1;
    }
    for (const count of bins) {
      expect(count).toBeGreaterThan(0.85 * (requests / bins.length));
      expect(count).toBeLessThan(1.15 * (requests / bins.length));
    }
  });

  it("differs between devices, two of one member included, and between requests", () => {
    const streams = [1, 2, 3, 4, 5].map((i) => hexId(100 + i));
    const delays = streams.map((stream) => answerDelayMs(base.requestId, stream, 60_000));
    expect(new Set(delays).size).toBe(streams.length);
    const again = streams.map((stream) => answerDelayMs("5f3a9c0e12b47d68", stream, 60_000));
    expect(again).not.toEqual(delays);
  });
});

describe("who answers a request (RSY-6)", () => {
  it("every device of the creator, at once, whoever asks and with or without all", () => {
    expect(answerTurn({ ...base, self: "alice" })).toEqual({ kind: "at-once" });
    expect(answerTurn({ ...base, self: "alice", requester: "alice" })).toEqual({ kind: "at-once" });
    expect(answerTurn({ ...base, self: "alice", all: true })).toEqual({ kind: "at-once" });
  });

  it("another device of the requester's own member, at once", () => {
    expect(answerTurn({ ...base, self: "carol" })).toEqual({ kind: "at-once" });
  });

  it("any other member only when the request carries all, at its turn — also when the creator asks", () => {
    expect(answerTurn(base)).toEqual({ kind: "never" });
    expect(answerTurn({ ...base, requester: "alice" })).toEqual({ kind: "never" });
    expect(answerTurn({ ...base, all: true })).toEqual({ kind: "turn", at: base.heardAt + 26_075 });
    expect(answerTurn({ ...base, requester: "alice", all: true })).toEqual({
      kind: "turn",
      at: base.heardAt + 26_075,
    });
  });

  it("nobody that does not know the creator, and nobody to its own request", () => {
    expect(answerTurn({ ...base, creator: undefined, all: true })).toEqual({ kind: "never" });
    expect(answerTurn({ ...base, creator: undefined, self: "carol" })).toEqual({ kind: "never" });
    expect(answerTurn({ ...base, ownRequest: true, self: "alice" })).toEqual({ kind: "never" });
    expect(answerTurn({ ...base, ownRequest: true, all: true })).toEqual({ kind: "never" });
  });
});

describe("what a responder does with a request it keeps", () => {
  const turn = { kind: "turn", at: 5_000 } as const;

  it("waits for its turn, then answers", () => {
    expect(answerAction(turn, 4_999, undefined)).toBe("wait");
    expect(answerAction(turn, 5_000, undefined)).toBe("answer");
    expect(answerAction(turn, 9_000, undefined)).toBe("answer");
  });

  it("falls silent when it heard anyone's answer before its turn", () => {
    expect(answerAction(turn, 4_000, 3_000)).toBe("drop");
    expect(answerAction(turn, 9_000, 4_999)).toBe("drop");
    // An answer heard once its turn had come does not take back what it owes (RSY-17).
    expect(answerAction(turn, 9_000, 5_000)).toBe("answer");
  });

  it("answers at once when it answers at once, whoever else answered; never when it may not", () => {
    expect(answerAction({ kind: "at-once" }, 0, 0)).toBe("answer");
    expect(answerAction({ kind: "never" }, 1e12, undefined)).toBe("drop");
  });

  it("makes a request to all cost about one answer among five members, not five", () => {
    const members = ["bob", "carol", "dave", "eve", "frank"];
    const transit = 2_000; // how long an answer takes to reach the others
    const requests = 1_000;
    let answers = 0;
    let unanswered = 0;
    for (let r = 0; r < requests; r++) {
      const requestId = hexId(10_000 + r);
      const turns = members.map((self, i) =>
        answerTurn({
          ...base,
          self,
          requester: "newcomer",
          requestId,
          stream: hexId(20_000 + 5 * r + i),
          all: true,
        }),
      );
      // Each member answers at its turn unless an answer reached it before; the first answer
      // reaches everyone `transit` later.
      const at = turns.map((t) =>
        t.kind === "turn" ? t.at : t.kind === "at-once" ? base.heardAt : Number.POSITIVE_INFINITY,
      );
      const first = Math.min(...at);
      let sent = 0;
      for (const [i, t] of turns.entries()) {
        const heard = (at[i] as number) === first ? undefined : first + transit;
        if (answerAction(t, at[i] as number, heard) === "answer") sent++;
      }
      if (sent === 0) unanswered++;
      answers += sent;
    }
    expect(unanswered).toBe(0);
    expect(answers / requests).toBeGreaterThanOrEqual(1);
    expect(answers / requests).toBeLessThan(1.3);
  });
});
