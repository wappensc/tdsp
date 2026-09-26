import { type TransportProfile, transportPolicyProfile } from "@tdsp/messenger-port";

/**
 * The send policy (SPECIFICATION.md §9.1) and where its values come from. The scheduler
 * (`send-scheduler.ts`) only *applies* a `SyncPolicy`; this file decides which one
 * that is: the library's defaults, the transport's suggestion, what the creator chose,
 * and the transport's hard bounds over all of it.
 */

/** How often and how much a client sends. Set by the creator, clamped by the transport. */
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

/** Reproduces the pre-Decision-0019 behaviour exactly: a message after a typing pause, no floor, no cap. */
export const DEFAULT_SYNC_POLICY: SyncPolicy = {
  minIntervalMs: 0,
  maxIntervalMs: Number.POSITIVE_INFINITY,
  minChars: 0,
  maxChars: Number.POSITIVE_INFINITY,
  expectedLatencyMs: 0,
};

/**
 * Fills in defaults and makes the values consistent, so no combination can starve
 * a pending change:
 * - a value that is negative or not a number falls back to its default;
 * - `maxIntervalMs` is never below `minIntervalMs` (the floor wins);
 * - `minChars` is ignored while there is no `maxIntervalMs`, because nothing would
 *   ever force out a change smaller than it (a formatting-only edit is 0 characters);
 * - `minChars` is never above `maxChars`.
 */
export function resolveSyncPolicy(partial: Partial<SyncPolicy> = {}): SyncPolicy {
  const pick = (value: number | undefined, fallback: number): number =>
    value === undefined || Number.isNaN(value) || value < 0 ? fallback : value;
  const minIntervalMs = pick(partial.minIntervalMs, DEFAULT_SYNC_POLICY.minIntervalMs);
  const maxIntervalMs = Math.max(
    pick(partial.maxIntervalMs, DEFAULT_SYNC_POLICY.maxIntervalMs),
    minIntervalMs,
  );
  const maxChars = pick(partial.maxChars, DEFAULT_SYNC_POLICY.maxChars);
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
  // A transport's profile states a complete policy in its JSON form (SPECIFICATION.md §3.5).
  const suggested =
    transport === undefined
      ? undefined
      : syncPolicyFromJson(transportPolicyProfile(transport, transport.defaultProfile)?.values);
  return clampSyncPolicy(
    resolveSyncPolicy({ ...definedOnly(suggested), ...definedOnly(chosen) }),
    transport?.bounds,
  );
}

/**
 * A policy as JSON, which cannot say `Infinity`: "no limit" is `null`. This is how the
 * creator's policy rides in its control snapshot (`ControlSnapshot.policy`) and in an
 * invitation's signed block.
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
  return resolveSyncPolicy({ minIntervalMs, maxIntervalMs, minChars, maxChars, expectedLatencyMs });
}

/**
 * A policy as one short piece of text for a link: `30000,120000,0,inf,60000@7` — the
 * five numbers in order (`inf` for no limit) and, after `@`, the control sequence at
 * which the creator set it (`0` if it is the policy the document was created with).
 * Short on purpose: it sits in a human-readable chat message.
 */
export function encodeSyncPolicyParam(policy: SyncPolicy, sequence = 0): string {
  const text = (value: number): string =>
    Number.isFinite(value) ? String(Math.round(value)) : "inf";
  return `${[
    policy.minIntervalMs,
    policy.maxIntervalMs,
    policy.minChars,
    policy.maxChars,
    policy.expectedLatencyMs,
  ]
    .map(text)
    .join(",")}@${sequence}`;
}

/** The inverse of `encodeSyncPolicyParam`, or `undefined` for anything that is not exactly that form. */
export function decodeSyncPolicyParam(
  text: string,
): { readonly policy: SyncPolicy; readonly sequence: number } | undefined {
  // One spelling per value (SPECIFICATION.md §11.2): no surrounding space, no leading
  // zero, nothing above a uint32 — a link anyone can edit gets exactly one reading.
  const match = /^([^@]+)@(0|[1-9][0-9]{0,9})$/.exec(text);
  if (!match || Number(match[2]) > 0xffffffff) {
    return undefined;
  }
  const parts = (match[1] as string).split(",");
  if (parts.length !== 5) {
    return undefined;
  }
  const numbers = parts.map((part, index) => {
    if (part === "inf" && (index === 1 || index === 3)) {
      return null;
    }
    return /^(0|[1-9][0-9]{0,9})$/.test(part) && Number(part) <= 0xffffffff
      ? Number(part)
      : undefined;
  });
  if (numbers.some((value) => value === undefined)) {
    return undefined;
  }
  const [minIntervalMs, maxIntervalMs, minChars, maxChars, expectedLatencyMs] = numbers;
  const policy = syncPolicyFromJson({
    minIntervalMs,
    maxIntervalMs,
    minChars,
    maxChars,
    expectedLatencyMs,
  });
  const sequence = Number(match[2]);
  return policy === undefined || !Number.isSafeInteger(sequence) ? undefined : { policy, sequence };
}
