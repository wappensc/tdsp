/**
 * The clock the engine measures every duration and every deadline on (SND-25, SPECIFICATION.md §1.6): a
 * floor, a back-off, a request's expiry, a turn, a wait for evidence, how long something is kept. It
 * never runs back: it reads the wall clock while that runs on, and where the wall clock jumped back —
 * as a time service may set it — it goes on from its last reading by the time the monotonic clock
 * (`performance.now()`) measured since. A jump forward it follows, as time that passed.
 *
 * Measured as differences of wall-clock readings, each of those spans would last as long again as
 * the wall clock went back: on a wall clock set back an hour, a request would stay outstanding, a
 * turn come and evidence count an hour late. Only CTL-45's control clock reads the wall clock itself; it has
 * rules of its own for a wall clock that jumps back.
 *
 * Times read from it stay inside the engine; what it reports to its application it reports on the
 * wall clock as it reads then (`toWall`). One engine shares one, so that times its parts take from
 * it compare with each other.
 */
export class SteadyClock {
  // How far this clock is ahead of the wall clock: 0 until the wall clock first went back.
  #skew = 0;
  #latest = Number.NEGATIVE_INFINITY;
  #latestMonotonic = 0;

  /** Now, in ms: the wall clock, never behind a time read before. */
  now(): number {
    const wall = Date.now();
    const monotonic = performance.now();
    let now = wall + this.#skew;
    if (now < this.#latest) {
      now = this.#latest + Math.max(0, monotonic - this.#latestMonotonic);
      this.#skew = now - wall;
    }
    this.#latest = now;
    this.#latestMonotonic = monotonic;
    return now;
  }

  /** A time read from this clock as the wall clock reads it now: as far from now as it is. */
  toWall(at: number): number;
  toWall(at: number | null): number | null;
  toWall(at: number | null): number | null {
    this.now();
    return at === null ? null : at - this.#skew;
  }
}
