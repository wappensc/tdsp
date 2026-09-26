import type { TransportProfile } from "@tdsp/messenger-port";
import { describe, expect, it } from "vitest";
import {
  clampSyncPolicy,
  decodeSyncPolicyParam,
  effectiveSyncPolicy,
  encodeSyncPolicyParam,
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

/** A transport shaped like the email provider profile: a floor of 15 s, 30 s suggested. */
const EMAIL_LIKE: TransportProfile = {
  bounds: { minIntervalMs: 15_000, maxBytes: 100_000 },
  profiles: [
    {
      id: "standard",
      label: "Standard",
      description: "",
      values: {
        minIntervalMs: 30_000,
        maxIntervalMs: 120_000,
        minChars: 0,
        maxChars: null,
        expectedLatencyMs: 60_000,
      },
    },
    {
      id: "patient",
      label: "Patient",
      description: "",
      values: {
        minIntervalMs: 60_000,
        maxIntervalMs: 300_000,
        minChars: 0,
        maxChars: null,
        expectedLatencyMs: 120_000,
      },
    },
  ],
  defaultProfile: "standard",
};

describe("effectiveSyncPolicy", () => {
  it("is the library's defaults when the transport says nothing and nothing was chosen", () => {
    expect(effectiveSyncPolicy(undefined, undefined)).toEqual(resolveSyncPolicy());
  });

  it("takes the transport's default profile when nothing was chosen", () => {
    const policy = effectiveSyncPolicy(EMAIL_LIKE, undefined);
    expect(policy.minIntervalMs).toBe(30_000);
    expect(policy.maxIntervalMs).toBe(120_000);
    expect(policy.expectedLatencyMs).toBe(60_000);
    expect(policy.minChars).toBe(0); // the profile's own value
  });

  it("lets what was chosen win over the transport's suggestion, value by value", () => {
    const policy = effectiveSyncPolicy(EMAIL_LIKE, { minIntervalMs: 45_000 });
    expect(policy.minIntervalMs).toBe(45_000);
    expect(policy.maxIntervalMs).toBe(120_000); // still the transport's
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
      profiles: [
        {
          id: "none",
          label: "None",
          description: "",
          values: {
            minIntervalMs: 0,
            maxIntervalMs: null,
            minChars: 0,
            maxChars: null,
            expectedLatencyMs: 0,
          },
        },
      ],
      defaultProfile: "none",
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

describe("a policy as JSON and as a link parameter", () => {
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

  it("round-trips through the short form a link carries", () => {
    const text = encodeSyncPolicyParam(standard, 7);
    expect(text).toBe("30000,120000,5,inf,60000@7");
    expect(decodeSyncPolicyParam(text)).toEqual({ policy: standard, sequence: 7 });
  });

  it("defaults the sequence to 0, the policy a document was created with", () => {
    expect(encodeSyncPolicyParam(standard).endsWith("@0")).toBe(true);
  });

  it.each([
    "",
    "30000,120000,5,inf,60000", // no sequence
    "30000,120000,5,inf@0", // four numbers
    "30000,120000,5,inf,60000,1@0", // six
    "30000,120000,5,inf,60000@x",
    "30000,120000,-5,inf,60000@0",
    "30000,120000,5,1.5,60000@0",
    "inf,120000,5,inf,60000@0", // the floor cannot be unlimited
    "30000,120000,5,inf,inf@0", // nor the latency
    "30000, 120000,5,inf,60000@0",
    "30000,120000,5,inf,60000@99999999999999999999",
  ])("refuses %j as a link parameter", (text) => {
    expect(decodeSyncPolicyParam(text)).toBeUndefined();
  });
});
