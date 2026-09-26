/**
 * At most one resync request of this client's own is outstanding per document, however
 * often anything asks for one (SPECIFICATION.md RSY-3). A resync request is a broadcast on a budget where every message counts, so
 * a second one only multiplies the answers; a manual click and an automatic request share
 * this one slot, which is what makes repeated clicks cost nothing.
 *
 * - **Single flight.** While a request is outstanding and has not expired, another is
 *   coalesced into it: nothing is sent.
 * - **Expiry.** A request that nobody answered stops holding the slot after a while, so the
 *   person can ask again. "No answer" is a normal outcome — a responder answers only if it has
 *   something the requester lacks — and the status says so.
 * - **Rate floor.** No request sooner than one floor after this client's previous message of
 *   any kind, since it is a message on the same budget as everything else; an expired request
 *   does not lift it.
 */

export type ResyncRefusal = "in-flight" | "rate-floor";

export type ResyncOutcome =
  | { readonly sent: true }
  | { readonly sent: false; readonly reason: ResyncRefusal };

export interface ResyncStatus {
  /** `requested`: a request is outstanding and still may be answered. */
  readonly state: "idle" | "requested";
  /** When the outstanding request was made, else `null`. */
  readonly requestedAt: number | null;
  /** When it stops holding the slot, else `null`. */
  readonly expiresAt: number | null;
  /** Whether the outstanding (or, when idle, the most recent) request was made by the client itself rather than a person. */
  readonly automatic: boolean;
  /** What became of the most recent request: someone answered it, or nobody did before it expired. `null` before any. */
  readonly lastOutcome: "answered" | "unanswered" | null;
}

export class ResyncGate {
  readonly #now: () => number;
  #outstanding: { at: number; expiresAt: number; automatic: boolean } | null = null;
  #lastRequestAt: number | null = null;
  #lastAutomatic = false;
  #lastOutcome: "answered" | "unanswered" | null = null;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  /**
   * Takes the slot if it is free, marking it *before* the request is sent, so two callers in
   * the same tick cannot both send. Call `abort()` if the send then fails.
   */
  begin(options: {
    expiryMs: number;
    floorMs: number;
    automatic: boolean;
    /** When the client last sent any other message: the floor counts from that too. */
    lastMessageAt?: number | null;
  }): ResyncOutcome {
    const now = this.#now();
    this.#settle(now);
    if (this.#outstanding !== null) {
      return { sent: false, reason: "in-flight" };
    }
    const lastAt = Math.max(this.#lastRequestAt ?? -Infinity, options.lastMessageAt ?? -Infinity);
    if (Number.isFinite(lastAt) && now - lastAt < options.floorMs) {
      return { sent: false, reason: "rate-floor" };
    }
    this.#outstanding = {
      at: now,
      expiresAt: now + options.expiryMs,
      automatic: options.automatic,
    };
    this.#lastRequestAt = now;
    this.#lastAutomatic = options.automatic;
    return { sent: true };
  }

  /** The send failed: nothing went out, so nothing is outstanding and the floor is not used up. */
  abort(previousRequestAt: number | null): void {
    this.#outstanding = null;
    this.#lastRequestAt = previousRequestAt;
  }

  /** When the most recent request was made, for `abort()`. */
  get lastRequestAt(): number | null {
    return this.#lastRequestAt;
  }

  /** A response to this client's own request was applied. */
  answered(): void {
    this.#outstanding = null;
    this.#lastOutcome = "answered";
  }

  status(): ResyncStatus {
    this.#settle(this.#now());
    return {
      state: this.#outstanding === null ? "idle" : "requested",
      requestedAt: this.#outstanding?.at ?? null,
      expiresAt: this.#outstanding?.expiresAt ?? null,
      automatic: this.#outstanding?.automatic ?? this.#lastAutomatic,
      lastOutcome: this.#lastOutcome,
    };
  }

  /** Whether the slot is free right now (and would be even ignoring the rate floor). */
  get isFree(): boolean {
    this.#settle(this.#now());
    return this.#outstanding === null;
  }

  #settle(now: number): void {
    if (this.#outstanding !== null && now >= this.#outstanding.expiresAt) {
      this.#outstanding = null;
      this.#lastOutcome = "unanswered";
    }
  }
}
