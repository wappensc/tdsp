/**
 * The resync requests an engine made itself (SPECIFICATION.md RSY-12, RSY-16), by request id, with
 * when each went out, and whether it was a true bootstrap request — one made with an empty state
 * vector, whose answer's overlay the engine may adopt (RSY-15). An answer whose `respondsTo` names
 * one is an answer to the engine's own request: accepted whoever sent it, applied, its snapshot
 * merged (RSY-13, CTL-25).
 *
 * Bounded by age and count (RSY-12, Appendix B): a request is kept for OWN_REQUEST_TTL_MS after it
 * went out — far beyond the requester's expiry and the longest window and floor a responder may wait
 * (RSY-4, RSY-20, SND-15) — and past that while an answer to it is still arriving in pieces (LOS-14);
 * of more than MAX_OWN_REQUESTS the oldest are forgotten first, one under way last. An answer to a
 * request the engine forgot is one to a request it did not make: nothing of it is applied, and its
 * last piece is still a report that shows what the engine lacks (LOS-4, LOS-12).
 *
 * Pure: the caller passes the times and says which requests have an answer under way.
 */

/** How long a request of one's own is kept after it went out, at least (Appendix B): 30 min. */
export const OWN_REQUEST_TTL_MS = 30 * 60_000;

/** The most requests of one's own kept (Appendix B). */
export const MAX_OWN_REQUESTS = 256;

export class OwnRequests {
  // Insertion order is the order they went out in: the oldest first.
  readonly #madeAt = new Map<string, number>();
  readonly #bootstrap = new Set<string>();
  // The truncated history each one asked for with `force`, by the number the engine gave it (LOS-19).
  readonly #forced = new Map<string, number>();

  /** How many are kept. */
  get size(): number {
    return this.#madeAt.size;
  }

  /**
   * Notes a request of one's own, made at `at`; `bootstrap`: with an empty state vector (RSY-15).
   * Noted again — as it goes out —, it is kept from then on (RSY-12).
   */
  add(id: string, at: number, bootstrap: boolean): void {
    this.#madeAt.delete(id);
    this.#madeAt.set(id, at);
    if (bootstrap) this.#bootstrap.add(id);
    else this.#bootstrap.delete(id);
  }

  /**
   * Notes, as `id` is written, the truncated history it asks for with `force`, by the number the
   * engine gave it; `undefined` when it asks without (LOS-19).
   */
  forced(id: string, truncation: number | undefined): void {
    if (truncation === undefined) this.#forced.delete(id);
    else this.#forced.set(id, truncation);
  }

  /** The truncated history `id` asked for with `force` as it was written last, if any (LOS-19). */
  forcedFor(id: string): number | undefined {
    return this.#forced.get(id);
  }

  /** Forgets one, as when its send failed (SND-10). */
  delete(id: string): void {
    this.#madeAt.delete(id);
    this.#bootstrap.delete(id);
    this.#forced.delete(id);
  }

  /** Whether `id` names a request of one's own that is still kept. */
  has(id: string): boolean {
    return this.#madeAt.has(id);
  }

  /** Whether `id` names a true bootstrap request of one's own that is still kept (RSY-15). */
  isBootstrap(id: string): boolean {
    return this.#bootstrap.has(id);
  }

  /**
   * Forgets, at `now`, every request older than OWN_REQUEST_TTL_MS that `underWay` does not name —
   * one whose answer is still arriving in pieces —, and then the oldest beyond MAX_OWN_REQUESTS,
   * those not under way first. Returns the ids forgotten, in that order.
   */
  prune(now: number, underWay: (id: string) => boolean): string[] {
    const forgotten: string[] = [];
    for (const [id, at] of this.#madeAt) {
      if (now - at > OWN_REQUEST_TTL_MS && !underWay(id)) forgotten.push(id);
    }
    let excess = this.#madeAt.size - forgotten.length - MAX_OWN_REQUESTS;
    if (excess > 0) {
      const gone = new Set(forgotten);
      const left = [...this.#madeAt.keys()].filter((id) => !gone.has(id));
      for (const id of [
        ...left.filter((id) => !underWay(id)),
        ...left.filter((id) => underWay(id)),
      ]) {
        if (excess <= 0) break;
        forgotten.push(id);
        excess -= 1;
      }
    }
    for (const id of forgotten) this.delete(id);
    return forgotten;
  }
}
