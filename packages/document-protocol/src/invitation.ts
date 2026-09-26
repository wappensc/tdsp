import { isProfileId } from "./framing";
import { decodeSyncPolicyParam } from "./sync-policy";

/**
 * An invitation as a link's query (SPECIFICATION.md §11.3): what an application writes
 * into the chat message that invites a participant, and what another application — possibly
 * another implementation — reads back to fill in its join step. A convenience, not a
 * capability: nothing in it grants access, and the creator's own answer confirms what it
 * claims (CTL-10). One reading only: every field at most once, every value in its range,
 * parameters this version does not define ignored, since the same query also carries an
 * application's own settings (a bridge override, say).
 */

/** The invitation format this module reads and writes: the `tdsp` parameter. */
export const INVITATION_VERSION = 1;

/** The most participants an email invitation may name, as the email binding bounds them. */
export const MAX_INVITATION_RECIPIENTS = 64;

const MAX_ID_BYTES = 255;
const MESSAGE_ID = /^<[A-Za-z0-9._~+-]{1,100}@[A-Za-z0-9.-]{1,100}>$/;
const ADDRESS = /^[^\s,@]{1,64}@[^\s,@]{1,189}$/;

export interface Invitation {
  /** Which binding: `signal`, `matrix`, `email` — or another's own name. */
  readonly messenger: string;
  readonly documentId: string;
  readonly creatorMemberId: string;
  readonly profile: string;
  /** Signal, Matrix, and any binding with a channel to bind to: its id. */
  readonly channelId?: string;
  /** Email: the thread root's `Message-ID`. */
  readonly threadRoot?: string;
  /** Email: every participant's address, the creator's included. */
  readonly recipients?: readonly string[];
  /** Email: whether the document uses PGP. */
  readonly pgp?: boolean;
  /**
   * The creator's policy as policy text (§11.2) — only if it parsed: one that does not is
   * dropped, and the invitation still opens (INV-4, INV-5).
   */
  readonly policy?: string;
}

export type InvitationProblem =
  /** No `tdsp` and no `documentId`: an ordinary page load, not an invitation. */
  | "not-an-invitation"
  | "unsupported-version"
  | "missing-field"
  | "invalid-field"
  | "repeated-field";

export type ParsedInvitation =
  | { readonly ok: true; readonly invitation: Invitation }
  | { readonly ok: false; readonly problem: InvitationProblem; readonly message: string };

/** The parameters this version defines, in the order `encodeInvitation` writes them. */
const PARAMETERS = [
  "tdsp",
  "provider",
  "documentId",
  "creatorMemberId",
  "channelId",
  "threadRoot",
  "recipients",
  "pgp",
  "profile",
  "policy",
] as const;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function isId(value: string): boolean {
  const bytes = byteLength(value);
  return bytes >= 1 && bytes <= MAX_ID_BYTES;
}

/**
 * The invitation as query text, without a leading `?` — `application/x-www-form-urlencoded`
 * as the WHATWG URL standard defines it (what `URLSearchParams` writes), in a fixed order.
 * Throws for an invitation that would not read back as itself.
 */
export function encodeInvitation(invitation: Invitation): string {
  const params = new URLSearchParams();
  params.set("tdsp", String(INVITATION_VERSION));
  params.set("provider", invitation.messenger);
  params.set("documentId", invitation.documentId);
  params.set("creatorMemberId", invitation.creatorMemberId);
  if (invitation.channelId !== undefined) {
    params.set("channelId", invitation.channelId);
  }
  if (invitation.threadRoot !== undefined) {
    params.set("threadRoot", invitation.threadRoot);
  }
  if (invitation.recipients !== undefined) {
    params.set("recipients", invitation.recipients.join(","));
  }
  if (invitation.pgp === true) {
    params.set("pgp", "1");
  }
  params.set("profile", invitation.profile);
  if (invitation.policy !== undefined) {
    params.set("policy", invitation.policy);
  }
  const text = params.toString();
  const back = parseInvitation(text);
  if (!back.ok) {
    throw new Error(`not a valid invitation: ${back.message}`);
  }
  return text;
}

/**
 * Reads an invitation from a query (with or without its `?`), strictly (§11.3): a parameter
 * this version defines that appears twice, is empty or out of range rejects the invitation;
 * a policy that does not parse is dropped instead (INV-4); a parameter it does not define is
 * ignored.
 */
export function parseInvitation(query: string | URLSearchParams): ParsedInvitation {
  const params = typeof query === "string" ? new URLSearchParams(query) : query;
  const fail = (problem: InvitationProblem, message: string): ParsedInvitation => ({
    ok: false,
    problem,
    message,
  });
  for (const name of PARAMETERS) {
    if (params.getAll(name).length > 1) {
      return fail("repeated-field", `the invitation names ${name} more than once`);
    }
  }
  const value = (name: (typeof PARAMETERS)[number]): string | undefined =>
    params.get(name) ?? undefined;

  const version = value("tdsp");
  if (version === undefined && value("documentId") === undefined) {
    return fail("not-an-invitation", "no invitation in this query");
  }
  if (version !== String(INVITATION_VERSION)) {
    return fail(
      "unsupported-version",
      version === undefined
        ? "the invitation says no version (tdsp)"
        : `invitation version ${version}, this application reads ${INVITATION_VERSION}`,
    );
  }
  const required = (name: "provider" | "documentId" | "creatorMemberId" | "profile") => {
    const found = value(name);
    return found === undefined || found === "" ? undefined : found;
  };
  const messenger = required("provider");
  const documentId = required("documentId");
  const creatorMemberId = required("creatorMemberId");
  const profile = required("profile");
  if (!messenger || !documentId || !creatorMemberId || !profile) {
    return fail(
      "missing-field",
      "an invitation needs provider, documentId, creatorMemberId and profile",
    );
  }
  if (!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(messenger)) {
    return fail("invalid-field", `provider ${JSON.stringify(messenger)} is not a binding name`);
  }
  if (!isId(documentId) || !isId(creatorMemberId)) {
    return fail("invalid-field", "documentId and creatorMemberId must be 1..255 UTF-8 bytes");
  }
  if (!isProfileId(profile)) {
    return fail("invalid-field", `profile ${JSON.stringify(profile)} is not a profile id`);
  }

  const invitation: {
    -readonly [K in keyof Invitation]: Invitation[K];
  } = { messenger, documentId, creatorMemberId, profile };

  const channelId = value("channelId");
  if (channelId !== undefined) {
    if (!isId(channelId)) {
      return fail("invalid-field", "channelId must be 1..255 UTF-8 bytes");
    }
    invitation.channelId = channelId;
  }
  const threadRoot = value("threadRoot");
  if (threadRoot !== undefined) {
    if (!MESSAGE_ID.test(threadRoot)) {
      return fail("invalid-field", "threadRoot is not a Message-ID of the email binding's form");
    }
    invitation.threadRoot = threadRoot;
  }
  const recipients = value("recipients");
  if (recipients !== undefined) {
    const list = recipients.split(",");
    if (
      list.length > MAX_INVITATION_RECIPIENTS ||
      !list.every((address) => ADDRESS.test(address)) ||
      new Set(list.map((address) => address.toLowerCase())).size !== list.length
    ) {
      return fail(
        "invalid-field",
        `recipients must be 1..${MAX_INVITATION_RECIPIENTS} distinct addresses, comma-separated`,
      );
    }
    invitation.recipients = list;
  }
  const pgp = value("pgp");
  if (pgp !== undefined) {
    if (pgp !== "1") {
      return fail("invalid-field", "pgp is 1 when present");
    }
    invitation.pgp = true;
  }
  if (messenger === "email") {
    if (!invitation.threadRoot || !invitation.recipients) {
      return fail("missing-field", "an email invitation needs threadRoot and recipients");
    }
  } else if (invitation.channelId === undefined) {
    return fail("missing-field", `a ${messenger} invitation needs channelId`);
  }
  const policy = value("policy");
  if (policy !== undefined && decodeSyncPolicyParam(policy) !== undefined) {
    invitation.policy = policy;
  }
  return { ok: true, invitation };
}
