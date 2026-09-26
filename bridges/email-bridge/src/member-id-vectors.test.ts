import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalMemberId } from "./envelope.ts";

/**
 * The published email MemberId vectors (bridges/email-bridge/test-vectors/member-ids-v1.json),
 * checked against the reference bridge (SPECIFICATION.md EML-10, §3.6).
 */
const { addresses, lists } = JSON.parse(
  readFileSync(new URL("../test-vectors/member-ids-v1.json", import.meta.url), "utf8"),
) as {
  addresses: { name: string; address: string; memberId: string | null }[];
  lists: { name: string; participants: string[]; accepted: boolean }[];
};

/** What both participant routes of the bridge accept (server.ts): every one bare, no two alike. */
function acceptsList(participants: readonly string[]): boolean {
  const canonical = participants.map(canonicalMemberId);
  return (
    canonical.every((memberId) => memberId !== undefined) &&
    new Set(canonical).size === canonical.length
  );
}

describe("email MemberId vectors, version 1", () => {
  it.each(addresses.map((v) => [v.name, v] as const))("%s", (_name, vector) => {
    expect(canonicalMemberId(vector.address) ?? null).toBe(vector.memberId);
  });

  it.each(lists.map((v) => [v.name, v] as const))("list: %s", (_name, vector) => {
    expect(acceptsList(vector.participants)).toBe(vector.accepted);
  });
});
