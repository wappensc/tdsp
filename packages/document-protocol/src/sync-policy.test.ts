import type { TransportProfile } from "@tdsp/messenger-port";
import { describe, expect, it } from "vitest";
import {
  clampSyncPolicy,
  effectiveSyncPolicy,
  resolveSyncPolicy,
  syncPolicyFromJson,
  syncPolicyToJson,
} from "./sync-policy";

describe("resolveSyncPolicy", () => {
  it("defaults to a message after a typing pause, with no floor and no cap", () => {
    expect(resolveSyncPolicy()).toEqual({
      minIntervalMs: 0,
      maxIntervalMs: Number.POSITIVE_INFINITY,
      minChars: 0,
      maxChars: Number.POSITIVE_INFINITY,
      expectedLatencyMs: 0,
    });
  });

  it("falls back to the default for a negative or non-numeric value", () => {
    const policy = resolveSyncPolicy({ minIntervalMs: -5, maxChars: Number.NaN });
    expect(policy.minIntervalMs).toBe(0);
    expect(policy.maxChars).toBe(Number.POSITIVE_INFINITY);
  });

  it("falls back to the default for a value that is not finite, unless it may mean no limit (SND-1)", () => {
    // An infinite floor, minimum or latency would starve every pending change, or every wait for evidence.
    const policy = resolveSyncPolicy({
      minIntervalMs: Number.POSITIVE_INFINITY,
      maxIntervalMs: 60_000,
      minChars: Number.POSITIVE_INFINITY,
      expectedLatencyMs: Number.POSITIVE_INFINITY,
    });
    expect(policy).toEqual({
      minIntervalMs: 0,
      maxIntervalMs: 60_000,
      minChars: 0,
      maxChars: Number.POSITIVE_INFINITY,
      expectedLatencyMs: 0,
    });
    // Where Infinity is how "no limit" is spelled inside the client, it stays.
    expect(
      resolveSyncPolicy({
        maxIntervalMs: Number.POSITIVE_INFINITY,
        maxChars: Number.POSITIVE_INFINITY,
      }),
    ).toEqual(resolveSyncPolicy());
    // A value of another type, as an untyped caller may pass, is no number either.
    expect(resolveSyncPolicy({ minIntervalMs: "5000" as never }).minIntervalMs).toBe(0);
  });

  it("never lets maxIntervalMs sit below the floor — the floor wins", () => {
    const policy = resolveSyncPolicy({ minIntervalMs: 30_000, maxIntervalMs: 10_000 });
    expect(policy.maxIntervalMs).toBe(30_000);
  });

  it("ignores minChars while nothing would ever force a small change out", () => {
    expect(resolveSyncPolicy({ minChars: 50 }).minChars).toBe(0);
    expect(resolveSyncPolicy({ minChars: 50, maxIntervalMs: 60_000 }).minChars).toBe(50);
  });

  it("never lets minChars exceed maxChars", () => {
    const policy = resolveSyncPolicy({ minChars: 50, maxChars: 20, maxIntervalMs: 60_000 });
    expect(policy.minChars).toBe(20);
  });
});

/** A transport shaped like the email bridge: a floor of 15 s, 30 s suggested (SND-16). */
const EMAIL_LIKE: TransportProfile = {
  bounds: { minIntervalMs: 15_000, maxBytes: 100_000 },
  pacing: {
    minIntervalMs: 30_000,
    maxIntervalMs: 120_000,
    minChars: 0,
    maxChars: null,
    expectedLatencyMs: 60_000,
  },
};

describe("effectiveSyncPolicy", () => {
  it("is the library's defaults when the transport says nothing and nothing was chosen", () => {
    expect(effectiveSyncPolicy(undefined, undefined)).toEqual(resolveSyncPolicy());
  });

  it("takes the transport's suggested pacing when nothing was chosen", () => {
    const policy = effectiveSyncPolicy(EMAIL_LIKE, undefined);
    expect(policy.minIntervalMs).toBe(30_000);
    expect(policy.maxIntervalMs).toBe(120_000);
    expect(policy.expectedLatencyMs).toBe(60_000);
    expect(policy.minChars).toBe(0); // the suggestion's own value
  });

  it("lets what was chosen win over the transport's suggestion, value by value", () => {
    const policy = effectiveSyncPolicy(EMAIL_LIKE, { minIntervalMs: 45_000 });
    expect(policy.minIntervalMs).toBe(45_000);
    expect(policy.maxIntervalMs).toBe(120_000); // still the transport's
  });

  it("lays what was chosen over the transport's raw values, and only then makes them consistent (SND-16)", () => {
    // The transport's minChars counts once the application gives a longest wait; made consistent
    // on its own first, it would already have been dropped for want of one.
    const minCharsOnly: TransportProfile = {
      bounds: { minIntervalMs: null, maxBytes: null },
      pacing: {
        minIntervalMs: 0,
        maxIntervalMs: null,
        minChars: 50,
        maxChars: null,
        expectedLatencyMs: 0,
      },
    };
    expect(effectiveSyncPolicy(minCharsOnly, { maxIntervalMs: 30_000 }).minChars).toBe(50);
    // A suggested longest wait below the suggested floor is raised only if the floor that is run
    // is above it: here the application's lower floor leaves the transport's 20 s standing.
    const inverted: TransportProfile = {
      bounds: { minIntervalMs: null, maxBytes: null },
      pacing: {
        minIntervalMs: 30_000,
        maxIntervalMs: 20_000,
        minChars: 0,
        maxChars: null,
        expectedLatencyMs: 0,
      },
    };
    const policy = effectiveSyncPolicy(inverted, { minIntervalMs: 10_000 });
    expect(policy.minIntervalMs).toBe(10_000);
    expect(policy.maxIntervalMs).toBe(20_000);
  });

  it("does not let an explicit undefined erase the transport's suggestion", () => {
    const policy = effectiveSyncPolicy(EMAIL_LIKE, { minIntervalMs: undefined });
    expect(policy.minIntervalMs).toBe(30_000);
  });

  it("clamps a value below the transport's floor up to it, whoever chose it", () => {
    expect(effectiveSyncPolicy(EMAIL_LIKE, { minIntervalMs: 0 }).minIntervalMs).toBe(15_000);
    expect(effectiveSyncPolicy(EMAIL_LIKE, { minIntervalMs: 14_999 }).minIntervalMs).toBe(15_000);
  });

  it("leaves a value at or above the floor alone", () => {
    expect(effectiveSyncPolicy(EMAIL_LIKE, { minIntervalMs: 15_000 }).minIntervalMs).toBe(15_000);
    expect(effectiveSyncPolicy(EMAIL_LIKE, { minIntervalMs: 300_000 }).minIntervalMs).toBe(300_000);
  });

  it("keeps maxIntervalMs from ending up below a floor that was raised", () => {
    // 5 s asked for, raised to 15 s; and the transport suggested a max of 120 s, which stays.
    const policy = effectiveSyncPolicy(EMAIL_LIKE, { minIntervalMs: 5_000, maxIntervalMs: 8_000 });
    expect(policy.minIntervalMs).toBe(15_000);
    expect(policy.maxIntervalMs).toBe(15_000); // the floor wins
  });

  it("applies the bounds even to a transport with no suggestions of its own", () => {
    const boundsOnly: TransportProfile = {
      bounds: { minIntervalMs: 1000, maxBytes: null },
      pacing: {
        minIntervalMs: 0,
        maxIntervalMs: null,
        minChars: 0,
        maxChars: null,
        expectedLatencyMs: 0,
      },
    };
    expect(effectiveSyncPolicy(boundsOnly, { minIntervalMs: 100 }).minIntervalMs).toBe(1000);
    expect(effectiveSyncPolicy(boundsOnly, undefined).minIntervalMs).toBe(1000);
  });

  it("accepts an unbounded chosen value (Infinity is how 'no limit' is spelled inside the client)", () => {
    const policy = effectiveSyncPolicy(EMAIL_LIKE, { maxIntervalMs: Number.POSITIVE_INFINITY });
    expect(policy.maxIntervalMs).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("clampSyncPolicy", () => {
  it("returns the same policy when there is nothing to enforce", () => {
    const policy = resolveSyncPolicy({ minIntervalMs: 5 });
    expect(clampSyncPolicy(policy, undefined)).toBe(policy);
    expect(clampSyncPolicy(policy, { minIntervalMs: null, maxBytes: null })).toBe(policy);
    expect(clampSyncPolicy(policy, { minIntervalMs: null, maxBytes: 10 })).toBe(policy);
  });
});

describe("a policy as JSON", () => {
  const standard = resolveSyncPolicy({
    minIntervalMs: 30_000,
    maxIntervalMs: 120_000,
    minChars: 5,
    expectedLatencyMs: 60_000,
  });

  it("round-trips through JSON, where 'no limit' is null", () => {
    const json = syncPolicyToJson(standard);
    expect(json.maxChars).toBeNull();
    expect(syncPolicyFromJson(JSON.parse(JSON.stringify(json)))).toEqual(standard);
  });

  it("refuses a policy with one field wrong, rather than applying the rest", () => {
    const good = syncPolicyToJson(standard);
    for (const bad of [
      { ...good, minIntervalMs: -1 },
      { ...good, minIntervalMs: null }, // the floor cannot be unlimited
      { ...good, minChars: "5" },
      { ...good, expectedLatencyMs: Number.NaN },
      { ...good, maxChars: undefined },
      "policy",
      null,
      [],
    ]) {
      expect(syncPolicyFromJson(bad)).toBeUndefined();
    }
  });

  it("makes a policy it reads consistent, so a hostile one cannot starve a pending change", () => {
    const read = syncPolicyFromJson({ ...syncPolicyToJson(standard), maxIntervalMs: 1000 });
    expect(read?.maxIntervalMs).toBe(30_000); // never below the floor
  });
});
