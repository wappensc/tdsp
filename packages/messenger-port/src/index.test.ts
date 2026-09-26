import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Delivery,
  parseTransportProfile,
  retainNewest,
  TransportSendError,
  transportPolicyProfile,
  transportSendErrorFromHttp,
} from "./index";

describe("TransportSendError", () => {
  it("is retryable exactly when waiting can help", () => {
    expect(new TransportSendError("rate-limited", "x").retryable).toBe(true);
    expect(new TransportSendError("unavailable", "x").retryable).toBe(true);
    expect(new TransportSendError("too-large", "x").retryable).toBe(false);
    expect(new TransportSendError("rejected", "x").retryable).toBe(false);
  });

  it("carries what the provider asked us to wait", () => {
    expect(new TransportSendError("rate-limited", "x", 4500).retryAfterMs).toBe(4500);
    expect(new TransportSendError("unavailable", "x").retryAfterMs).toBeUndefined();
  });
});

describe("transportSendErrorFromHttp", () => {
  const from = (status: number, retryAfter?: string | null) =>
    transportSendErrorFromHttp("send(doc-1)", status, "body text", retryAfter);

  it("keeps the message every adapter has always thrown", () => {
    expect(from(502).message).toBe("send(doc-1) failed: 502 body text");
  });

  it("maps 429 to rate-limited and 413 to too-large", () => {
    expect(from(429).reason).toBe("rate-limited");
    expect(from(413).reason).toBe("too-large");
  });

  it.each([400, 403, 404, 409, 422])(
    "maps %i to rejected: asking again changes nothing",
    (status) => {
      const error = from(status);
      expect(error.reason).toBe("rejected");
      expect(error.retryable).toBe(false);
    },
  );

  it.each([500, 502, 503, 504, 401, 408, 418])(
    "maps %i, and any status nobody classified, to unavailable: never drop a change on a failure nobody thought about",
    (status) => {
      const error = from(status);
      expect(error.reason).toBe("unavailable");
      expect(error.retryable).toBe(true);
    },
  );

  describe("Retry-After", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(Date.parse("2026-09-21T12:00:00Z"));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("reads a number of seconds", () => {
      expect(from(429, "7").retryAfterMs).toBe(7000);
      expect(from(429, "0.5").retryAfterMs).toBe(500);
    });

    it("reads an HTTP date", () => {
      expect(from(429, "Mon, 21 Sep 2026 12:00:30 GMT").retryAfterMs).toBe(30_000);
      expect(from(429, "Mon, 21 Sep 2026 11:00:00 GMT").retryAfterMs).toBe(0); // already past
    });

    it("ignores a header that is absent, empty or unreadable", () => {
      expect(from(429).retryAfterMs).toBeUndefined();
      expect(from(429, null).retryAfterMs).toBeUndefined();
      expect(from(429, "  ").retryAfterMs).toBeUndefined();
      expect(from(429, "soon").retryAfterMs).toBeUndefined();
      expect(from(429, "-3").retryAfterMs).toBeUndefined();
    });

    it("only a rate limit carries it", () => {
      expect(from(503, "7").retryAfterMs).toBeUndefined();
    });
  });
});

describe("parseTransportProfile (SPECIFICATION.md §3.5, TRN-13)", () => {
  const values = () => ({
    minIntervalMs: 30_000,
    maxIntervalMs: 120_000,
    minChars: 0,
    maxChars: null,
    expectedLatencyMs: 60_000,
  });
  const standard = () => ({
    id: "standard",
    label: "Standard",
    description: "One message per 30 s",
    values: values(),
  });
  const local = () => ({
    id: "local",
    label: "Local",
    description: "",
    values: {
      minIntervalMs: 0,
      maxIntervalMs: null,
      minChars: 0,
      maxChars: null,
      expectedLatencyMs: 0,
    },
  });
  const valid = () => ({
    bounds: { minIntervalMs: 15_000, maxBytes: 32_000 },
    profiles: [standard(), local()],
    defaultProfile: "standard",
  });
  /** `valid()` with the standard profile replaced by `entry`. */
  const withStandard = (entry: unknown) => ({ ...valid(), profiles: [entry, local()] });
  /** `valid()` with the standard profile's values changed. */
  const withValues = (changes: Record<string, unknown>) =>
    withStandard({ ...standard(), values: { ...values(), ...changes } });
  /** `valid()` with the standard profile's values missing one field. */
  const withoutValue = (key: string) => {
    const { [key]: _omitted, ...rest } = values() as Record<string, unknown>;
    return withStandard({ ...standard(), values: rest });
  };
  /** `valid()` with the standard profile missing one field. */
  const withoutField = (key: string) => {
    const { [key]: _omitted, ...rest } = standard() as Record<string, unknown>;
    return withStandard(rest);
  };

  it("reads a profile as the bridge sends it, unchanged", () => {
    expect(parseTransportProfile(valid())).toEqual(valid());
  });

  it("survives a round trip through JSON, which is how it travels", () => {
    expect(parseTransportProfile(JSON.parse(JSON.stringify(valid())))).toEqual(valid());
  });

  it("keeps the profiles in the order the bridge gave them — the order to offer them in", () => {
    const reversed = { ...valid(), profiles: [local(), standard()] };
    expect(parseTransportProfile(reversed)?.profiles.map((p) => p.id)).toEqual([
      "local",
      "standard",
    ]);
  });

  it("reads null as no bound and no limit", () => {
    const profile = parseTransportProfile({
      ...valid(),
      bounds: { minIntervalMs: null, maxBytes: null },
    });
    expect(profile?.bounds).toEqual({ minIntervalMs: null, maxBytes: null });
    expect(transportPolicyProfile(profile, "local")?.values.maxIntervalMs).toBeNull();
  });

  it.each([
    ["not an object", "profile"],
    ["null", null],
    ["an array", []],
    ["no bounds", { ...valid(), bounds: undefined }],
    ["no profiles", { ...valid(), profiles: undefined }],
    ["an empty list of profiles", { ...valid(), profiles: [] }],
    ["profiles as an object", { ...valid(), profiles: { standard: standard() } }],
    ["two profiles with one id", { ...valid(), profiles: [standard(), standard()] }],
    ["a profile without an id", withoutField("id")],
    ["a profile with an empty id", withStandard({ ...standard(), id: "" })],
    ["a default that names nothing", { ...valid(), defaultProfile: "nonexistent" }],
    ["no default", { ...valid(), defaultProfile: undefined }],
    ["a bound left out", { ...valid(), bounds: { minIntervalMs: 15_000 } }],
    ["bounds left out entirely", { ...valid(), bounds: {} }],
    ["a negative bound", { ...valid(), bounds: { minIntervalMs: -1, maxBytes: null } }],
    [
      "a bound that is not a number",
      { ...valid(), bounds: { minIntervalMs: null, maxBytes: "1" } },
    ],
    [
      "an infinite bound",
      { ...valid(), bounds: { minIntervalMs: Number.POSITIVE_INFINITY, maxBytes: null } },
    ],
    ["a misspelled bound", { ...valid(), bounds: { minIntervalMs: null, maxByte: 32_000 } }],
    ["a field the specification does not define", { ...valid(), somethingNew: 1 }],
    ["a profile without a label", withoutField("label")],
    ["a profile without a description", withoutField("description")],
    ["a policy value left out", withoutValue("minChars")],
    ["a policy that states nothing", withStandard({ ...standard(), values: {} })],
    ["a misspelled policy value", withValues({ maxChar: 5 })],
    ["null for a floor, which has no 'no limit'", withValues({ minIntervalMs: null })],
    ["null for the expected latency", withValues({ expectedLatencyMs: null })],
    ["a negative policy value", withValues({ minIntervalMs: -5 })],
    ["a policy value that is not a number", withValues({ maxChars: "lots" })],
  ])("refuses the whole profile for %s, rather than half-applying it", (_name, raw) => {
    expect(parseTransportProfile(raw)).toBeUndefined();
  });
});

describe("retainNewest (SPECIFICATION.md BRG-17)", () => {
  const delivery = (id: string, chars: number): Delivery => ({
    id,
    documentId: "doc-1",
    sender: "alice",
    payload: "x".repeat(chars),
  });

  it("drops the oldest until the count fits", () => {
    const list = ["a", "b", "c", "d"].map((id) => delivery(id, 1));
    retainNewest(list, { maxCount: 2, maxPayloadChars: 100 });
    expect(list.map((d) => d.id)).toEqual(["c", "d"]);
  });

  it("drops the oldest until the payload text fits", () => {
    const list = [delivery("a", 40), delivery("b", 40), delivery("c", 40)];
    retainNewest(list, { maxCount: 10, maxPayloadChars: 90 });
    expect(list.map((d) => d.id)).toEqual(["b", "c"]);
  });

  it("always keeps the newest, however large", () => {
    const list = [delivery("a", 1), delivery("b", 500)];
    retainNewest(list, { maxCount: 10, maxPayloadChars: 100 });
    expect(list.map((d) => d.id)).toEqual(["b"]);
  });
});
