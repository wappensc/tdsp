import { describe, expect, it } from "vitest";
import {
  describeIntegrityEntry,
  describeInviteRejection,
  describeKeyComparison,
  describeKeyWarnings,
  describePgpStatus,
  formatFingerprint,
  type IntegrityReason,
  type InviteRejectionReason,
  isInviteRejectionReason,
  type KeyReportEntry,
  type PgpKeys,
  type PgpStatus,
  summarizeIntegrity,
} from "./integrity.ts";

// Listed in full on purpose, and typed as a `Record`, so adding a reason to
// `IntegrityReason` without deciding how it is worded and how severe it is
// fails to compile.
const EXPECTED: Record<IntegrityReason, "warning" | "alert"> = {
  "recipient-list-mismatch": "alert",
  "pgp-unsigned": "warning",
  "pgp-unencrypted": "alert",
  "pgp-undecipherable": "warning",
  "pgp-signature-invalid": "alert",
  "pgp-identity-changed": "alert",
  "pgp-unavailable": "warning",
  "pgp-disabled-locally": "warning",
  "message-id-reused": "alert",
  "message-too-large": "warning",
};

describe("describeIntegrityEntry", () => {
  it.each(Object.entries(EXPECTED))(
    "words %s, names the sender, and rates it %s",
    (reason, severity) => {
      const result = describeIntegrityEntry({
        messageId: "m1",
        sender: "mallory@example.org",
        reason: reason as IntegrityReason,
      });
      expect(result.severity).toBe(severity);
      expect(result.text).toContain("mallory@example.org");
      expect(result.text.length).toBeGreaterThan(40);
    },
  );

  it("keeps 'signed by a key the document does not hold' and 'signed by another participant's key' in distinct words", () => {
    const unknownKey = describeIntegrityEntry({
      messageId: "m1",
      sender: "bob@example.org",
      reason: "pgp-signature-invalid",
    });
    const otherParticipant = describeIntegrityEntry({
      messageId: "m2",
      sender: "bob@example.org",
      reason: "pgp-identity-changed",
    });
    expect(unknownKey.text).toContain("not signed by the key this document holds");
    expect(unknownKey.text).toContain("Only a new document can change a participant's key");
    expect(otherParticipant.text).toContain("impersonation");
    expect(unknownKey.text).not.toContain("impersonation");
    // The advice this used to give — import their key — cannot help any more:
    // the document's keys are the invitation's, not the user's.
    expect(unknownKey.text).not.toContain("check that you have their current key");
  });

  it("does not fail on an empty sender", () => {
    expect(
      describeIntegrityEntry({ messageId: "m1", sender: "", reason: "pgp-unsigned" }).text,
    ).toContain("an unknown sender");
  });
});

describe("describePgpStatus", () => {
  const base: PgpStatus = {
    enabled: true,
    gpgAvailable: true,
    missingKeysFor: [],
    sendBlockedReason: null,
  };

  it("says plainly that a PGP-off document is neither encrypted nor authenticated", () => {
    const result = describePgpStatus({ ...base, enabled: false });
    expect(result.state).toBe("off");
    expect(result.text).toContain("neither encrypted nor signed");
    expect(result.text).toContain("forged");
  });

  it("is ready only when PGP is on, gpg is there and nothing blocks sending — and still names what stays visible", () => {
    const result = describePgpStatus(base);
    expect(result.state).toBe("ready");
    expect(result.text).toContain("encrypted");
    expect(result.text).toContain("no forward secrecy");
  });

  it("surfaces the bridge's exact reason when sending is blocked", () => {
    const result = describePgpStatus({
      ...base,
      missingKeysFor: ["bob@example.org"],
      sendBlockedReason: "missing PGP key for bob@example.org — refusing to send",
    });
    expect(result.state).toBe("blocked");
    expect(result.text).toContain("bob@example.org");
  });

  it("reports a missing gpg as blocked, not as merely off", () => {
    const result = describePgpStatus({ ...base, gpgAvailable: false });
    expect(result.state).toBe("blocked");
    expect(result.text).toContain("no gpg");
  });

  it("never reports a PGP-off document as blocked, however gpg is set up", () => {
    expect(
      describePgpStatus({ ...base, enabled: false, gpgAvailable: false, sendBlockedReason: "x" })
        .state,
    ).toBe("off");
  });
});

describe("summarizeIntegrity", () => {
  const entry = (reason: IntegrityReason) => ({ messageId: "m", sender: "x@example.org", reason });

  it("says nothing when nothing was rejected", () => {
    expect(summarizeIntegrity([])).toBeNull();
  });

  it("is a warning when everything rejected looks like a communication problem", () => {
    const result = summarizeIntegrity([entry("pgp-undecipherable"), entry("pgp-unsigned")]);
    expect(result?.severity).toBe("warning");
    expect(result?.text).toBe("2 incoming messages were rejected instead of applied.");
  });

  it("is an alert, and counts them, as soon as one rejection looks like an attack", () => {
    const result = summarizeIntegrity([entry("pgp-undecipherable"), entry("pgp-identity-changed")]);
    expect(result?.severity).toBe("alert");
    expect(result?.text).toContain("2 incoming messages were rejected");
    expect(result?.text).toContain("1 of them looks like an attempt");
  });

  it("uses the singular for a single message", () => {
    expect(summarizeIntegrity([entry("pgp-identity-changed")])?.text).toBe(
      "1 incoming message was rejected instead of applied — it looks like an attempt to break this document's rules.",
    );
  });
});

// Listed in full and typed as a `Record`, like `EXPECTED` above: adding a reason
// without deciding its severity fails to compile.
const EXPECTED_INVITE: Record<InviteRejectionReason, "warning" | "alert"> = {
  "invite-not-found": "warning",
  "invite-not-from-creator": "alert",
  "recipient-list-mismatch": "alert",
  "invite-not-encrypted": "alert",
  "invite-undecipherable": "alert",
  "invite-unsigned": "alert",
  "invite-signature-invalid": "alert",
  "invite-malformed": "alert",
  "invite-participants-mismatch": "alert",
  "invite-key-set-invalid": "alert",
  "invite-signer-not-creator": "alert",
  "invite-creator-key-differs": "alert",
};

describe("describeInviteRejection", () => {
  it.each(Object.entries(EXPECTED_INVITE))("words %s and rates it %s", (reason, severity) => {
    const result = describeInviteRejection(reason as InviteRejectionReason, "alice@example.org");
    expect(result.severity).toBe(severity);
    expect(result.text.length).toBeGreaterThan(40);
  });

  it("tells a joiner whose key differs from the creator's that they cannot join, and to settle it outside the application", () => {
    const { text } = describeInviteRejection("invite-undecipherable", "alice@example.org");
    expect(text).toContain("alice@example.org");
    expect(text).toContain("cannot join");
    expect(text).toContain("outside this application");
  });

  it("does not call a not-yet-arrived invitation an attack", () => {
    expect(describeInviteRejection("invite-not-found").severity).toBe("warning");
    expect(describeInviteRejection("invite-not-found").text).toContain("try again");
  });

  it("recognises exactly the listed reasons", () => {
    for (const reason of Object.keys(EXPECTED_INVITE)) {
      expect(isInviteRejectionReason(reason)).toBe(true);
    }
    expect(isInviteRejectionReason("pgp-unsigned")).toBe(false);
    expect(isInviteRejectionReason(undefined)).toBe(false);
    expect(isInviteRejectionReason("toString")).toBe(false);
  });
});

describe("formatFingerprint", () => {
  it("groups a fingerprint in fours, the way people read it aloud", () => {
    expect(formatFingerprint("AB12CD34EF56AB78CD90AB12CD34EF56AB78CD90")).toBe(
      "AB12 CD34 EF56 AB78 CD90 AB12 CD34 EF56 AB78 CD90",
    );
  });
});

describe("describeKeyWarnings", () => {
  const entry = (overrides: Partial<KeyReportEntry> = {}): KeyReportEntry => ({
    address: "carol@example.org",
    fingerprint: "C".repeat(40),
    isYou: false,
    isCreator: false,
    comparison: "match",
    localFingerprints: ["C".repeat(40)],
    ...overrides,
  });
  const keys = (entries: KeyReportEntry[]): PgpKeys => ({
    enabled: true,
    gpgAvailable: true,
    ownFingerprint: "B".repeat(40),
    creator: "alice@example.org",
    entries,
  });

  it("says nothing when everything matches", () => {
    expect(describeKeyWarnings(keys([entry()]))).toEqual([]);
  });

  it("says nothing for a key the user's keyring simply lacks — normal for someone new", () => {
    expect(
      describeKeyWarnings(keys([entry({ comparison: "missing-locally", localFingerprints: [] })])),
    ).toEqual([]);
  });

  it("raises an alert naming both keys and the address when the user's keyring holds a different one, saying it must be settled outside the application", () => {
    const [warning, ...rest] = describeKeyWarnings(
      keys([entry({ comparison: "different-locally", localFingerprints: ["D".repeat(40)] })]),
    );
    expect(rest).toEqual([]);
    expect(warning?.severity).toBe("alert");
    expect(warning?.address).toBe("carol@example.org");
    expect(warning?.text).toContain("CCCC CCCC");
    expect(warning?.text).toContain("DDDD DDDD");
    expect(warning?.text).toContain("outside this application");
    expect(warning?.text).toContain("uses the creator's key");
  });

  it("says a differing key for the creator may mean a forged invitation", () => {
    const [warning] = describeKeyWarnings(
      keys([
        entry({
          address: "alice@example.org",
          isCreator: true,
          comparison: "different-locally",
          localFingerprints: ["D".repeat(40)],
        }),
      ]),
    );
    expect(warning?.text).toContain("forged");
    expect(warning?.text).toContain("not that one");
  });

  it("warns, less sharply, when the creator's own key is not in the user's keyring — nothing independent backs the invitation", () => {
    const [warning] = describeKeyWarnings(
      keys([
        entry({
          address: "alice@example.org",
          isCreator: true,
          comparison: "missing-locally",
          localFingerprints: [],
        }),
      ]),
    );
    expect(warning?.severity).toBe("warning");
    expect(warning?.text).toContain("nothing independent confirms");
    expect(warning?.text).toContain("trust on first use");
  });

  it("never calls a key verified: a match is consistency, not verification (EML-8)", () => {
    const states = ["match", "missing-locally", "different-locally"] as const;
    for (const comparison of states) {
      const badge = describeKeyComparison(entry({ isCreator: true, comparison }));
      expect(badge).not.toMatch(/(?<!not )verified|authenticated/i);
      for (const warning of describeKeyWarnings(
        keys([entry({ isCreator: true, comparison, localFingerprints: ["D".repeat(40)] })]),
      )) {
        expect(warning.text).not.toMatch(/(?<!not |be )verified|authenticated/i);
      }
    }
    expect(describeKeyComparison(entry({ comparison: "match" }))).toContain("not verified");
  });

  it("gives nothing to compare for a PGP-off document or a bridge without gpg", () => {
    expect(describeKeyWarnings({ enabled: false })).toEqual([]);
    expect(describeKeyWarnings({ enabled: true, gpgAvailable: false })).toEqual([]);
  });

  it("badges each comparison in words", () => {
    expect(describeKeyComparison(entry({ comparison: "match" }))).toContain("same key");
    expect(describeKeyComparison(entry({ comparison: "missing-locally" }))).toContain("not in");
    expect(describeKeyComparison(entry({ comparison: "different-locally" }))).toContain("DIFFERS");
  });
});
