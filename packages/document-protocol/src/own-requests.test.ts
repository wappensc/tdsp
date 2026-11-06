import { describe, expect, it } from "vitest";
import { MAX_OWN_REQUESTS, OWN_REQUEST_TTL_MS, OwnRequests } from "./own-requests";

/**
 * The requests an engine made itself, bounded by age and count (SPECIFICATION.md RSY-12, Appendix
 * B): an answer to one is taken as an answer to its own request while it keeps it; one whose answer
 * is still arriving in pieces it keeps past the age (LOS-14).
 */

const NONE_UNDER_WAY = (): boolean => false;

describe("the requests an engine keeps of its own (RSY-12)", () => {
  it("keeps a request for the age of Appendix B after it went out, and forgets it after", () => {
    const own = new OwnRequests();
    own.add("00000000000000a1", 1_000, true);
    expect(own.prune(1_000 + OWN_REQUEST_TTL_MS, NONE_UNDER_WAY)).toStrictEqual([]);
    expect(own.has("00000000000000a1")).toBe(true);
    expect(own.isBootstrap("00000000000000a1")).toBe(true);
    expect(own.prune(1_000 + OWN_REQUEST_TTL_MS + 1, NONE_UNDER_WAY)).toStrictEqual([
      "00000000000000a1",
    ]);
    expect(own.has("00000000000000a1")).toBe(false);
    expect(own.isBootstrap("00000000000000a1")).toBe(false);
  });

  it("keeps one past the age while an answer to it arrives in pieces", () => {
    const own = new OwnRequests();
    own.add("00000000000000a1", 0, false);
    own.add("00000000000000a2", 0, false);
    const later = 2 * OWN_REQUEST_TTL_MS;
    expect(own.prune(later, (id) => id === "00000000000000a2")).toStrictEqual(["00000000000000a1"]);
    expect(own.has("00000000000000a2")).toBe(true);
    expect(own.prune(later, NONE_UNDER_WAY)).toStrictEqual(["00000000000000a2"]);
  });

  it("keeps at most MAX_OWN_REQUESTS, the oldest forgotten first — one under way last", () => {
    const own = new OwnRequests();
    const id = (n: number) => n.toString(16).padStart(16, "0");
    for (let n = 0; n < MAX_OWN_REQUESTS + 10; n++) own.add(id(n), n, false);
    const forgotten = own.prune(MAX_OWN_REQUESTS + 10, (request) => request === id(0));
    expect(forgotten).toStrictEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(id));
    expect(own.size).toBe(MAX_OWN_REQUESTS);
    expect(own.has(id(0))).toBe(true);
    // Even one under way goes when nothing else is left to forget: the count holds.
    for (let n = 0; n < MAX_OWN_REQUESTS; n++) own.add(id(1_000 + n), 1_000 + n, false);
    own.prune(2_000, () => true);
    expect(own.size).toBe(MAX_OWN_REQUESTS);
  });

  it("forgets a request whose send failed at once", () => {
    const own = new OwnRequests();
    own.add("00000000000000a1", 0, true);
    own.delete("00000000000000a1");
    expect(own.has("00000000000000a1")).toBe(false);
    expect(own.isBootstrap("00000000000000a1")).toBe(false);
    expect(own.size).toBe(0);
  });
});
