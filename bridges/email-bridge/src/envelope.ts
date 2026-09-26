/**
 * The `{tdsp:1, kind, documentId, ...}` JSON envelope (SPECIFICATION.md §13.1,
 * the same field names as the Matrix and Signal bridges' envelopes) carried as
 * an email's plain-text body, plus the mail-specific framing around it (§13.4):
 * a `Subject` built from the opaque `documentId` only — never a document title —
 * and a custom header repeating `documentId`, so that a receiving bridge finds a
 * thread's messages even when a relay mangles `References` (mail threading is
 * not fully reliable).
 *
 * A PGP-off document sends this envelope as unsigned, unencrypted plain
 * text. A PGP-enabled one sends the very same JSON, signed and encrypted
 * into one inline ASCII-armored OpenPGP message (`gpg-invoke.ts`'s
 * `signAndEncrypt()`) — the
 * envelope's own shape never changes; see `sync-state.ts` for how the
 * receiving side opens and verifies it.
 */

/**
 * One kind, and only one, named `"frame"` because it carries every frame
 * kind, not only edits (SPECIFICATION.md §13.1). Membership changes, the
 * close of a document and resync requests are frames inside this envelope's
 * opaque `frame`, opaque to this bridge like everything else it routes.
 */
export type EnvelopeKind = "frame";

export interface EmailEnvelope {
  readonly tdsp: 1;
  readonly kind: "frame";
  readonly documentId: string;
  readonly frame: string;
}

/**
 * The creator's invitation to a PGP-enabled document (SPECIFICATION.md EML-4),
 * the plaintext of the one signed-and-encrypted block in the thread's first
 * email. It is *not* an {@link EmailEnvelope}: it is read once, when a
 * participant joins, and never as a protocol message — `decodeEnvelope` does
 * not know the kind and ignores it, so a copy replayed into the thread later
 * does nothing.
 *
 * `participants` is the document's closed participant set with the key the
 * creator chose for each; `keys` carries exactly those public keys, armored.
 * Together they are the document's single source of truth for who is who.
 */
export interface InvitePayload {
  readonly tdsp: 1;
  readonly kind: "invite";
  readonly documentId: string;
  readonly creator: string;
  readonly profile: string;
  readonly participants: readonly { readonly address: string; readonly fingerprint: string }[];
  readonly keys: string;
  /**
   * The creator's initial send policy, inside what it signs (SPECIFICATION.md §11.2). An opaque
   * short text — `document-protocol` writes and reads it; this bridge only carries it.
   */
  readonly policy?: string;
}

/**
 * What a policy text may look like on its way through this bridge: digits, commas,
 * `inf` and one `@`, short. Checked *before the signature can be*, like everything
 * else read out of an invitation, so it is a shape check and nothing more; the
 * meaning is checked where it is used.
 */
const POLICY_TEXT = /^[0-9a-z,@]{1,200}$/;

/**
 * Whether `value` has the shape of a document profile id, `<name>/<major>`
 * (SPECIFICATION.md §5). Only the shape: which profiles exist is the engine's business,
 * and this bridge stores and repeats the id without interpreting it.
 */
export function isProfileText(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9.-]{0,99}\/[1-9][0-9]{0,5}$/.test(value);
}

export function isPolicyText(value: unknown): value is string {
  return typeof value === "string" && POLICY_TEXT.test(value);
}

/** Sanity limits on attacker-controlled input read before its signature could be checked. */
export const MAX_INVITE_PARTICIPANTS = 64;
export const MAX_INVITE_KEYS_LENGTH = 1024 * 1024;

export function encodeInvite(invite: InvitePayload): string {
  return JSON.stringify(invite);
}

/**
 * Strict parse of an invitation's plaintext — `undefined` for anything that
 * is not exactly that shape. The plaintext is read *before* the signature can
 * be checked (the keys that verify it are inside), so nothing here may be
 * taken at its word: sizes are bounded, addresses and fingerprints are
 * pattern-checked, and unknown extra fields are simply dropped.
 */
export function decodeInvite(text: string): InvitePayload | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const c = parsed as Record<string, unknown>;
  if (
    c.tdsp !== 1 ||
    c.kind !== "invite" ||
    typeof c.documentId !== "string" ||
    typeof c.creator !== "string" ||
    !isPlainAddress(c.creator) ||
    !isProfileText(c.profile) ||
    typeof c.keys !== "string" ||
    c.keys.length === 0 ||
    c.keys.length > MAX_INVITE_KEYS_LENGTH ||
    !Array.isArray(c.participants) ||
    c.participants.length === 0 ||
    c.participants.length > MAX_INVITE_PARTICIPANTS ||
    (c.policy !== undefined && !isPolicyText(c.policy))
  ) {
    return undefined;
  }
  const participants: { address: string; fingerprint: string }[] = [];
  for (const entry of c.participants as unknown[]) {
    if (typeof entry !== "object" || entry === null) {
      return undefined;
    }
    const { address, fingerprint } = entry as Record<string, unknown>;
    if (
      typeof address !== "string" ||
      !isPlainAddress(address) ||
      typeof fingerprint !== "string" ||
      !/^[0-9A-Fa-f]{40}$/.test(fingerprint)
    ) {
      return undefined;
    }
    participants.push({ address, fingerprint: fingerprint.toUpperCase() });
  }
  return {
    tdsp: 1,
    kind: "invite",
    documentId: c.documentId,
    creator: c.creator,
    profile: c.profile as string,
    participants,
    keys: c.keys,
    ...(c.policy === undefined ? {} : { policy: c.policy as string }),
  };
}

/** One bare address: no whitespace, angle brackets, commas or quotes, exactly one `@`. */
function isPlainAddress(value: string): boolean {
  return value.length <= 254 && /^[^\s<>,;"@]+@[^\s<>,;"@]+$/.test(value);
}

const ARMORED_MESSAGE = /-----BEGIN PGP MESSAGE-----[\s\S]*?-----END PGP MESSAGE-----/g;

/**
 * The one armored OpenPGP message inside an invitation's body — the
 * human-readable text comes first, the block after it. `none` when there is
 * no block (a plain invite, which a PGP-enabled document must refuse), and
 * `several` when there is more than one, which is ambiguous about what was
 * signed and is refused too.
 */
export function extractArmoredMessage(
  body: string,
): { readonly block: string } | "none" | "several" {
  const blocks = body.match(ARMORED_MESSAGE) ?? [];
  if (blocks.length === 0) {
    return "none";
  }
  const [only] = blocks;
  return blocks.length === 1 && only !== undefined ? { block: only } : "several";
}

/** The invitation email's body: readable text first (with the invitation link), then the armored block. */
export function composeInviteBody(humanText: string, armored: string): string {
  return `${humanText.trimEnd()}\n\n${armored.trim()}\n`;
}

/** The custom header name every framed email carries, lowercase to match how `mailparser`'s `Headers` map and `imapflow`'s `search({ header })` both key header names. */
export const DOCUMENT_HEADER = "x-tdsp-document";

export function encodeEnvelope(envelope: EmailEnvelope): string {
  return JSON.stringify(envelope);
}

/**
 * Parses a message body as an `EmailEnvelope` — returns `undefined` for
 * anything that isn't valid, recognized `{tdsp:1,...}` JSON, mirroring
 * `bridges/matrix-bridge`'s/`bridges/signal-bridge`'s own "unrecognized ⇒
 * silently ignored" rule (`SPECIFICATION.md` §12.5, BRG-13): a
 * human-readable invite email, or any other plain message that happens
 * to land in the same thread, must never crash or be mistaken for a
 * protocol message.
 */
/**
 * A recognisable TDSP envelope of another version in `text` — `tdsp` a number other than 1,
 * `documentId` a string — or `undefined` (SPECIFICATION.md BND-2). Reported for the
 * thread's own document and not delivered; anything else that is not an envelope stays silent.
 */
export function foreignEnvelopeVersion(
  text: string,
): { documentId: string; version: number } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const candidate = parsed as Record<string, unknown>;
  return typeof candidate.tdsp === "number" &&
    candidate.tdsp !== 1 &&
    typeof candidate.documentId === "string"
    ? { documentId: candidate.documentId, version: candidate.tdsp }
    : undefined;
}

export function decodeEnvelope(text: string): EmailEnvelope | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.tdsp !== 1 || typeof candidate.documentId !== "string") {
    return undefined;
  }
  switch (candidate.kind) {
    case "frame":
      return typeof candidate.frame === "string"
        ? {
            tdsp: 1,
            kind: candidate.kind,
            documentId: candidate.documentId,
            frame: candidate.frame,
          }
        : undefined;
    default:
      return undefined;
  }
}

const CLEARSIGN_HEADER = "-----BEGIN PGP SIGNED MESSAGE-----";
const ENCRYPTED_HEADER = "-----BEGIN PGP MESSAGE-----";

export type PgpFormat = "encrypted" | "clearsigned" | "plain";

/**
 * What a message body *claims* to be — only a shape check, never a
 * verification. `sync-state.ts` uses it to tell apart rejections a user
 * needs told apart: a message with no PGP protection at all, one that is
 * signed but not encrypted (a downgrade of what a PGP-enabled document
 * requires), and one that is properly armored and still has to survive
 * `gpg`.
 */
export function pgpFormatOf(text: string): PgpFormat {
  const start = text.trimStart();
  if (start.startsWith(ENCRYPTED_HEADER)) {
    return "encrypted";
  }
  if (start.startsWith(CLEARSIGN_HEADER)) {
    return "clearsigned";
  }
  return "plain";
}

/**
 * Whether `value` is a `Message-ID` this bridge is willing to put on the
 * wire or store as a thread root: `<local@domain>` in a deliberately narrow
 * alphabet, at most 200 characters. Narrower than RFC 5322 allows — every id
 * this implementation generates is `<uuid@domain>` — and checked at both edges: the
 * `POST /threads` and `/join` routes (which take one from the browser, and
 * from an invitation link an attacker may have crafted) and the SMTP sender.
 * Verified rather than assumed: `nodemailer` accepts a Message-ID containing a
 * CR/LF and returns it verbatim, though it did not let an injected header
 * reach the wire in any case tried — so this is correctness and defence in
 * depth, not the only thing standing between a link and a header injection.
 */
export function isValidMessageId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 200 &&
    /^<[A-Za-z0-9._~+-]{1,100}@[A-Za-z0-9.-]{1,100}>$/.test(value)
  );
}

export function subjectForDocument(documentId: string): string {
  return `tdsp document ${documentId}`;
}

/**
 * The one address normalization every comparison and every key of a
 * per-address map in this bridge (e.g. `pinnedFingerprints`) goes
 * through, so `Alice@Example.org` in one header and `alice@example.org`
 * in another can never be treated as two different people.
 */
export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * The canonical email MemberId of a participant the bridge is given (SPECIFICATION.md
 * EML-10) — `normalizeAddress` of a bare address — or `undefined` when `address` is not one:
 * a display name (`Alice <alice@example.org>`), angle brackets, a comment, a second `@`, space
 * inside, or an empty part. Those are refused, not repaired, since a sender is always compared
 * as the bare address the mail parser reads from `From:`. An alias (`alice+docs@…`) is a
 * MemberId of its own: a bridge cannot know which addresses reach one mailbox.
 *
 * Lower-casing the local part assumes a provider that does not tell `Alice@` from `alice@` —
 * true of the providers this was built against, not guaranteed by RFC 5321; the binding is
 * scoped to such providers.
 */
export function canonicalMemberId(address: string): string | undefined {
  const canonical = normalizeAddress(address);
  const match = /^([^\s@<>()[\]",;:\\]{1,64})@([^\s@<>()[\]",;:\\]{1,253})$/.exec(canonical);
  if (!match) {
    return undefined;
  }
  const domain = match[2] as string;
  return domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")
    ? undefined
    : canonical;
}

/**
 * The transport-level recipient check (SPECIFICATION.md EML-2): the sender plus everyone a message was
 * actually addressed to must together reconstitute exactly `closedSet` —
 * no fewer (someone silently excluded) and no more (someone outside the
 * original participants). PGP/MIME signs the message body, never these
 * outer `To`/`Cc` headers, so this check runs independently of, and
 * prior to, any signature verification (`sync-state.ts`).
 *
 * Addresses are compared case-insensitively (the domain part of an
 * email address always is; the local part technically isn't per RFC
 * 5321; the binding is scoped to providers that treat it as
 * case-insensitive, SPECIFICATION.md EML-10).
 */
export function recipientHeadersMatchClosedSet(
  sender: string,
  to: readonly string[],
  cc: readonly string[],
  closedSet: readonly string[],
): boolean {
  const actual = new Set([sender, ...to, ...cc].map(normalizeAddress));
  const expected = new Set(closedSet.map(normalizeAddress));
  if (actual.size !== expected.size) {
    return false;
  }
  for (const address of actual) {
    if (!expected.has(address)) {
      return false;
    }
  }
  return true;
}
