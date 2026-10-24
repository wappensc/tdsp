import type { TransportProfile } from "@tdsp/messenger-port";

/**
 * The pacing (SPECIFICATION.md §9.1) and where its values come from. The scheduler
 * (`send-scheduler.ts`) only *applies* a `SyncPolicy`; this file decides which one
 * that is: the library's defaults, the transport's suggested pacing, what the application
 * chose, and the transport's hard bounds over all of it (SND-16); the creator's pace is a
 * floor the engine adds (SND-15).
 */

/**
 * How often and how much this client sends: its own choice (SND-16), with the
 * creator's pace as a floor (SND-15), clamped by the transport's bounds.
 */
export interface SyncPolicy {
  /** A hard floor between two messages — the provider's rate limit. `0` = none. */
  readonly minIntervalMs: number;
  /** The longest a pending change waits before it is sent regardless of typing pauses. `Infinity` = none. */
  readonly maxIntervalMs: number;
  /** Do not send fewer changed characters than this, unless `maxIntervalMs` forces it. `0` = none. */
  readonly minChars: number;
  /** Send as soon as the floor permits once this many characters are pending. `Infinity` = none. */
  readonly maxChars: number;
  /** How long a message normally takes to arrive; the receiving side's wait before it suspects a loss. `0` = unknown. */
  readonly expectedLatencyMs: number;
}

/** The library's defaults: a message after a typing pause, no floor, no cap. */
export const DEFAULT_SYNC_POLICY: SyncPolicy = {
  minIntervalMs: 0,
  maxIntervalMs: Number.POSITIVE_INFINITY,
  minChars: 0,
  maxChars: Number.POSITIVE_INFINITY,
  expectedLatencyMs: 0,
};

/**
 * Fills in defaults and makes the values consistent, so no combination can starve
 * a pending change (SND-1):
 * - a value that is negative, not a number or not finite falls back to its default — except
 *   that `maxIntervalMs` and `maxChars` may be `Infinity`, which is how "no limit" is spelled
 *   inside the client; an infinite floor, `minChars` or latency would stop every send, or every
 *   wait for evidence, for good;
 * - `maxIntervalMs` is never below `minIntervalMs` (the floor wins);
 * - `minChars` is ignored while there is no `maxIntervalMs`, because nothing would
 *   ever force out a change smaller than it (a formatting-only edit is 0 characters);
 * - `minChars` is never above `maxChars`.
 */
export function resolveSyncPolicy(partial: Partial<SyncPolicy> = {}): SyncPolicy {
  const pick = (value: unknown, fallback: number, unlimited = false): number =>
    typeof value === "number" &&
    !Number.isNaN(value) &&
    value >= 0 &&
    (unlimited || Number.isFinite(value))
      ? value
      : fallback;
  const minIntervalMs = pick(partial.minIntervalMs, DEFAULT_SYNC_POLICY.minIntervalMs);
  const maxIntervalMs = Math.max(
    pick(partial.maxIntervalMs, DEFAULT_SYNC_POLICY.maxIntervalMs, true),
    minIntervalMs,
  );
  const maxChars = pick(partial.maxChars, DEFAULT_SYNC_POLICY.maxChars, true);
  const minChars = Number.isFinite(maxIntervalMs)
    ? Math.min(pick(partial.minChars, DEFAULT_SYNC_POLICY.minChars), maxChars)
    : 0;
  return {
    minIntervalMs,
    maxIntervalMs,
    minChars,
    maxChars,
    expectedLatencyMs: pick(partial.expectedLatencyMs, DEFAULT_SYNC_POLICY.expectedLatencyMs),
  };
}

/**
 * Applies a transport's hard bounds to a policy — over everything else, whoever set
 * the policy. Only the floor is enforced today; `maxBytes` is declared by the
 * transport and used once a change too large for one message can be split.
 */
export function clampSyncPolicy(
  policy: SyncPolicy,
  bounds: TransportProfile["bounds"] | undefined,
): SyncPolicy {
  if (
    bounds === undefined ||
    bounds.minIntervalMs === null ||
    policy.minIntervalMs >= bounds.minIntervalMs
  ) {
    return policy;
  }
  return resolveSyncPolicy({ ...policy, minIntervalMs: bounds.minIntervalMs });
}

/** `values` without the keys whose value is `undefined`, so spreading it over defaults never erases one. */
export function definedOnly(values: Partial<SyncPolicy> | undefined): Partial<SyncPolicy> {
  const result: { -readonly [K in keyof SyncPolicy]?: number } = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    if (value !== undefined) {
      result[key as keyof SyncPolicy] = value;
    }
  }
  return result;
}

/**
 * The policy a client actually runs: the library's defaults, under the transport's
 * default profile, under what was chosen explicitly (the creator's values, or an
 * invitation's), all made consistent, then clamped to the transport's bounds. A
 * transport that says nothing leaves the library's defaults, and nothing chosen leaves
 * the transport's.
 */
export function effectiveSyncPolicy(
  transport: TransportProfile | undefined,
  chosen: Partial<SyncPolicy> | undefined,
): SyncPolicy {
  // A transport's profile states a complete policy in its JSON form. Its raw values go under
  // the application's, and the result is made consistent once (SND-16): made consistent on its
  // own first, the suggestion would lose a value — a `minChars` without a longest wait, a longest
  // wait below its own floor — that the application's choice makes meaningful again.
  const suggested = transport === undefined ? undefined : rawSyncPolicyFromJson(transport.pacing);
  return clampSyncPolicy(
    resolveSyncPolicy({ ...definedOnly(suggested), ...definedOnly(chosen) }),
    transport?.bounds,
  );
}

/**
 * A policy as JSON, which cannot say `Infinity`: "no limit" is `null`. This is how a transport
 * states its suggested pacing (SND-16).
 */
export interface SyncPolicyJson {
  readonly minIntervalMs: number;
  readonly maxIntervalMs: number | null;
  readonly minChars: number;
  readonly maxChars: number | null;
  readonly expectedLatencyMs: number;
}

export function syncPolicyToJson(policy: SyncPolicy): SyncPolicyJson {
  const bounded = (value: number): number | null => (Number.isFinite(value) ? value : null);
  return {
    minIntervalMs: policy.minIntervalMs,
    maxIntervalMs: bounded(policy.maxIntervalMs),
    minChars: policy.minChars,
    maxChars: bounded(policy.maxChars),
    expectedLatencyMs: policy.expectedLatencyMs,
  };
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Reads a policy off the wire (a snapshot, an invitation), or `undefined` if it is not
 * one. Strict, like `parseTransportProfile`: one field that is wrong makes the whole
 * policy unusable rather than half of it applied. Always returned consistent
 * (`resolveSyncPolicy`).
 */
export function syncPolicyFromJson(raw: unknown): SyncPolicy | undefined {
  const values = rawSyncPolicyFromJson(raw);
  return values === undefined ? undefined : resolveSyncPolicy(values);
}

/** `syncPolicyFromJson` before it is made consistent: every value as the JSON states it. */
function rawSyncPolicyFromJson(raw: unknown): SyncPolicy | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const json = raw as Record<string, unknown>;
  const minIntervalMs = nonNegativeNumber(json.minIntervalMs);
  const minChars = nonNegativeNumber(json.minChars);
  const expectedLatencyMs = nonNegativeNumber(json.expectedLatencyMs);
  const maxIntervalMs =
    json.maxIntervalMs === null ? Number.POSITIVE_INFINITY : nonNegativeNumber(json.maxIntervalMs);
  const maxChars =
    json.maxChars === null ? Number.POSITIVE_INFINITY : nonNegativeNumber(json.maxChars);
  if (
    minIntervalMs === undefined ||
    minChars === undefined ||
    expectedLatencyMs === undefined ||
    maxIntervalMs === undefined ||
    maxChars === undefined
  ) {
    return undefined;
  }
  return { minIntervalMs, maxIntervalMs, minChars, maxChars, expectedLatencyMs };
}
