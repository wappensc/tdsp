import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Delivery,
  deliveriesAfter,
  jsonTextTooDeep,
  jsonValueTooDeep,
  MAX_JSON_NESTING,
  parseTransportProfile,
  retainNewest,
  TransportSendError,
  transportSendErrorFromHttp,
} from "./index";

describe("TransportSendError", () => {
  it("is retryable exactly when waiting can help", () => {
    expect(new TransportSendError("rate-limited", "x").retryable).toBe(true);
    expect(new TransportSendError("unavailable", "x").retryable).toBe(true);
    expect(new TransportSendError("too-large", "x").retryable).toBe(false);
    expect(new TransportSendError("rejected", "x").retryable).toBe(false);
  });

  it("keeps a refusal only a person can lift, and says it waits for the person (TRN-11, TRN-20)", () => {
    const refusal = new TransportSendError("needs-person", "an identity to trust");
    expect(refusal.retryable).toBe(true);
    expect(refusal.needsPerson).toBe(true);
    for (const reason of ["rate-limited", "unavailable", "too-large", "rejected"] as const) {
      expect(new TransportSendError(reason, "x").needsPerson).toBe(false);
    }
  });

  it("counts a reason outside the five as unavailable: worth retrying (TRN-12)", () => {
    // An adapter written without these types, or an error decoded from another process, may carry
    // a reason nobody classified; dropping the change on it is what TRN-12 forbids.
    const unknown = new TransportSendError("timeout" as never, "x");
    expect(unknown.retryable).toBe(true);
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

  it("maps 409 to needs-person: a state the person ends, not one waiting ends (LBI-6)", () => {
    const error = from(409);
    expect(error.reason).toBe("needs-person");
    expect(error.needsPerson).toBe(true);
  });

  it.each([400, 403, 404, 422])("maps %i to rejected: asking again changes nothing", (status) => {
    const error = from(status);
    expect(error.reason).toBe("rejected");
    expect(error.retryable).toBe(false);
  });

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

describe("parseTransportProfile (SND-16; TRN-13)", () => {
  const pacing = () => ({
    minIntervalMs: 30_000,
    maxIntervalMs: 120_000,
    minChars: 0,
    maxChars: null,
    expectedLatencyMs: 60_000,
  });
  const valid = () => ({ bounds: { minIntervalMs: 15_000, maxBytes: 32_000 }, pacing: pacing() });
  const withPacing = (changes: Record<string, unknown>) => ({
    ...valid(),
    pacing: { ...pacing(), ...changes },
  });
  const withoutPacing = (key: string) => {
    const { [key]: _omitted, ...rest } = pacing() as Record<string, unknown>;
    return { ...valid(), pacing: rest };
  };

  it("reads a profile as the bridge sends it, unchanged", () => {
    expect(parseTransportProfile(valid())).toEqual(valid());
  });

  it("survives a round trip through JSON, which is how it travels", () => {
    expect(parseTransportProfile(JSON.parse(JSON.stringify(valid())))).toEqual(valid());
  });

  it("reads null as no bound and no limit", () => {
    const profile = parseTransportProfile({
      bounds: { minIntervalMs: null, maxBytes: null },
      pacing: { ...pacing(), maxIntervalMs: null },
    });
    expect(profile?.bounds).toEqual({ minIntervalMs: null, maxBytes: null });
    expect(profile?.pacing.maxIntervalMs).toBeNull();
  });

  it.each([
    ["not an object", "profile"],
    ["null", null],
    ["an array", []],
    ["no bounds", { ...valid(), bounds: undefined }],
    ["no pacing", { ...valid(), pacing: undefined }],
    [
      "1.x's named profiles instead of pacing",
      { bounds: valid().bounds, profiles: [], defaultProfile: "standard" },
    ],
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
    ["a field the draft does not define", { ...valid(), somethingNew: 1 }],
    ["a pacing value left out", withoutPacing("minChars")],
    ["a pacing that states nothing", { ...valid(), pacing: {} }],
    ["a misspelled pacing value", withPacing({ maxChar: 5 })],
    ["null for a floor, which has no 'no limit'", withPacing({ minIntervalMs: null })],
    ["null for the expected latency", withPacing({ expectedLatencyMs: null })],
    ["a negative pacing value", withPacing({ minIntervalMs: -5 })],
    ["a pacing value that is not a number", withPacing({ maxChars: "lots" })],
  ])("refuses the whole profile for %s, rather than half-applying it", (_name, raw) => {
    expect(parseTransportProfile(raw)).toBeUndefined();
  });
});

describe("retainNewest (bindings/bridges.md BRG-17)", () => {
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

describe("deliveriesAfter (TRN-18, TRN-21)", () => {
  const delivery = (id: string) => ({ id, documentId: "doc-1", sender: "alice", payload: id });
  // A window that took in five deliveries and dropped the oldest two (BRG-17).
  const window = ["d3", "d4", "d5"].map(delivery);
  const ids = (answer: { deliveries: readonly { id: string }[] }) =>
    answer.deliveries.map((d) => d.id);

  it("answers what came after the cursor, oldest first, in the window's own order", () => {
    const answer = deliveriesAfter(window, "d3", { appended: 5 });
    expect(ids(answer)).toEqual(["d4", "d5"]);
    expect(answer.truncated).toBe(false);
    expect(ids(deliveriesAfter(window, "d5", { appended: 5 }))).toEqual([]);
  });

  it("answers the whole window, not truncated, without a cursor", () => {
    expect(deliveriesAfter(window, undefined, { appended: 5 })).toEqual({
      deliveries: window,
      truncated: false,
    });
  });

  it("reads a cursor the window dropped, or never held, as truncated, and answers the whole window", () => {
    expect(deliveriesAfter(window, "d1", { appended: 5 })).toEqual({
      deliveries: window,
      truncated: true,
    });
    expect(deliveriesAfter(window, "never-issued", { appended: 5 }).truncated).toBe(true);
  });

  it("reads a cursor at or before where the bridge passed over messages as truncated, and one after as not", () => {
    // The bridge passed over part of its messenger's answer once it had taken in four deliveries.
    expect(deliveriesAfter(window, "d3", { appended: 5, passedOverAt: 4 }).truncated).toBe(true);
    expect(deliveriesAfter(window, "d4", { appended: 5, passedOverAt: 4 }).truncated).toBe(true);
    expect(deliveriesAfter(window, "d5", { appended: 5, passedOverAt: 4 }).truncated).toBe(false);
    expect(ids(deliveriesAfter(window, "d3", { appended: 5, passedOverAt: 4 }))).toEqual([
      "d4",
      "d5",
    ]);
  });
});

describe("the nesting limit of TDSP's JSON (SPECIFICATION.md §1.6)", () => {
  const nested = (levels: number, inner = "") => "[".repeat(levels) + inner + "]".repeat(levels);

  it("allows 32 levels and refuses 33, in text and in a parsed value alike", () => {
    expect(MAX_JSON_NESTING).toBe(32);
    expect(jsonTextTooDeep(nested(32))).toBe(false);
    expect(jsonTextTooDeep(nested(33))).toBe(true);
    expect(jsonValueTooDeep(JSON.parse(nested(32)))).toBe(false);
    expect(jsonValueTooDeep(JSON.parse(nested(33)))).toBe(true);
  });

  it("counts objects and arrays together, and the outermost one as the first level", () => {
    const mixed = (levels: number) => `${'{"a":'.repeat(levels)}1${"}".repeat(levels)}`;
    expect(jsonTextTooDeep(`[${mixed(31)}]`)).toBe(false);
    expect(jsonTextTooDeep(`[${mixed(32)}]`)).toBe(true);
    expect(jsonValueTooDeep({ frame: "x", attachment: { file: { hashes: {} } } })).toBe(false);
    expect(jsonTextTooDeep("1")).toBe(false);
    expect(jsonValueTooDeep(null)).toBe(false);
  });

  it("does not count brackets inside a string, escaped quotes included", () => {
    const text = JSON.stringify({ frame: `"${"[{".repeat(1000)}\\"` });
    expect(jsonTextTooDeep(text)).toBe(false);
  });

  it("measures depth, not size: many shallow siblings pass", () => {
    const wide = `[${Array.from({ length: 10_000 }, () => "[[]]").join(",")}]`;
    expect(jsonTextTooDeep(wide)).toBe(false);
    expect(jsonValueTooDeep(JSON.parse(wide))).toBe(false);
  });

  it("answers for a million levels without recursing, and for text that is not JSON at all", () => {
    expect(jsonTextTooDeep(nested(1_000_000))).toBe(true);
    expect(jsonTextTooDeep("[".repeat(1_000_000))).toBe(true); // never closed
    expect(jsonValueTooDeep(JSON.parse(nested(1_000_000)))).toBe(true);
    expect(jsonTextTooDeep("hello, not JSON ]]]")).toBe(false);
  });
});
