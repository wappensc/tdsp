import {
  decodeInvite,
  encodeInvite,
  extractArmoredMessage,
  type InvitePayload,
  MAX_INVITE_KEYS_LENGTH,
  normalizeAddress,
  recipientHeadersMatchClosedSet,
} from "./envelope.ts";
import type { GpgInvoker } from "./gpg-invoke.ts";
import {
  commitKeyring,
  discardKeyring,
  keyringPathFor,
  newPendingKeyringPath,
} from "./keyring-store.ts";
import type { MailReceiver } from "./mail-transport.ts";

/**
 * The creator's invitation to a PGP-enabled document, and a participant's
 * acceptance of it (SPECIFICATION.md EML-4).
 *
 * **The design in one paragraph.** The creator resolves every participant's
 * key from her own keyring, once, strictly (a missing or ambiguous key refuses
 * the document before anything is sent), and sends the whole set — each
 * address with its fingerprint, and the keys themselves — inside one block she
 * signs and encrypts to every other participant. A participant's bridge takes
 * the document's identities from *that* block and from nowhere else: it builds
 * a bridge-owned, per-document keyring from it, pins every participant from it,
 * and communicates only with those keys. The participant's own keyring is
 * consulted for exactly two things — their own secret key, and a *comparison*
 * (`key-report.ts`) that tells them where it disagrees with the creator. There
 * is no trust on first use any more: nobody is ever pinned by whatever
 * message arrives first.
 *
 * **What this does not do**, and the documentation must not suggest it does:
 * the invitation is an ordinary email. Whoever can forge it towards someone
 * who has never held the creator's key chooses that person's keys — first
 * contact with a document is trusted to the invitation, and is only as strong
 * as the fingerprints a human compared out of band.
 */

/** Why an invitation was refused. Also the wording keys in `packages/messenger-email` (kept identical by `integrity-vocabulary.test.ts`). */
export type InviteRejectionReason =
  /** Not a rejection of anything received: the invitation is not in this mailbox (yet). Retryable. */
  | "invite-not-found"
  /** The invitation's `From:` is not the creator the link names. */
  | "invite-not-from-creator"
  /** The invitation's own `To`/`Cc` headers don't reconstitute the participants the link names. */
  | "recipient-list-mismatch"
  /** No PGP block in the body: a plain invitation to a PGP-enabled document is a downgrade, refused. */
  | "invite-not-encrypted"
  /** Encrypted to a key this bridge does not hold — which is what a creator holding a different key for you looks like. */
  | "invite-undecipherable"
  | "invite-unsigned"
  | "invite-signature-invalid"
  /** Not a well-formed invitation for this document (or several PGP blocks — ambiguous about what was signed). */
  | "invite-malformed"
  /** What the creator signed disagrees with the link or the mail headers about who is taking part. */
  | "invite-participants-mismatch"
  /** The keys carried do not match the fingerprints signed: an extra, missing, duplicated or mislabelled key. */
  | "invite-key-set-invalid"
  /** Validly signed — by somebody other than the creator it names. */
  | "invite-signer-not-creator"
  /**
   * The user's own keyring holds a key for the creator's address, and it is not the key the
   * invitation names for the creator (SPECIFICATION.md EML-8): the one independent check
   * a joiner has, and it failed — a forged invitation, or one side holding a wrong key.
   */
  | "invite-creator-key-differs";

export type AcceptInviteResult =
  | { readonly ok: true; readonly accepted: AcceptedInvite }
  | {
      readonly ok: false;
      readonly reason: InviteRejectionReason;
      readonly error: string;
      /** The `From:` of the invitation, when one was found. */
      readonly sender?: string;
    };

export interface AcceptedInvite {
  readonly recipients: readonly string[];
  readonly creator: string;
  readonly profile: string;
  /** Normalized address → uppercase primary fingerprint, for every participant. */
  readonly pinnedFingerprints: Record<string, string>;
  readonly ownFingerprint: string;
  /** The document's own keyring, already moved to its final place. */
  readonly keyringPath: string;
  /** The creator's signed initial send policy, if the invitation carried one. */
  readonly policy?: string;
}

function fingerprintOf(
  participants: InvitePayload["participants"],
  address: string,
): string | undefined {
  return participants.find((p) => normalizeAddress(p.address) === normalizeAddress(address))
    ?.fingerprint;
}

/**
 * Whether a keyring holds *exactly* the keys a participant list names, each
 * under its own address and no other. A problem is returned as text, not
 * thrown. Checked after every import, at the creator and at the participant
 * alike, because the block being imported is not trusted to be what its
 * signature list says it is: an extra key, a missing one, one key listed for
 * two people, or a key whose user id names somebody else would each let one
 * participant be mistaken for another.
 */
export async function verifyKeySet(
  keyring: GpgInvoker,
  participants: InvitePayload["participants"],
): Promise<string | undefined> {
  const listed = new Map<string, string>();
  for (const { address, fingerprint } of participants) {
    if ([...listed.values()].includes(fingerprint)) {
      return `one key (${fingerprint}) is listed for two participants`;
    }
    listed.set(address, fingerprint);
  }
  const held = new Set((await keyring.listAllKeys()).map((key) => key.fingerprint.toUpperCase()));
  for (const fingerprint of listed.values()) {
    if (!held.has(fingerprint)) {
      return `the key ${fingerprint} is listed but missing, unusable, or expired`;
    }
  }
  for (const fingerprint of held) {
    if (![...listed.values()].includes(fingerprint)) {
      return `the keys carry ${fingerprint}, which is not listed for anyone`;
    }
  }
  for (const [address, fingerprint] of listed) {
    const matching = (await keyring.listKeys(address)).map((key) => key.fingerprint.toUpperCase());
    if (matching.length !== 1 || matching[0] !== fingerprint) {
      return `${address} must map to exactly ${fingerprint} in the keyring, found ${matching.length === 0 ? "nothing" : matching.join(", ")}`;
    }
  }
  return undefined;
}

export interface CreateInviteParams {
  readonly documentId: string;
  /** This bridge's own mailbox address — the creator, and the signer. */
  readonly ownAddress: string;
  readonly recipients: readonly string[];
  readonly profile: string;
  readonly gpg: GpgInvoker;
  readonly bindStorePath: string;
  /** The creator's initial send policy, signed into the invitation. Opaque here. */
  readonly policy?: string;
}

export type CreateInviteResult =
  | {
      readonly ok: true;
      /** The signed and encrypted block, for the invitation email's body. */
      readonly armored: string;
      /** The document's keyring, built but **not yet in its final place** — `commitKeyring` it once the email is sent, `discardKeyring` it if sending fails. */
      readonly pendingKeyringPath: string;
      readonly pinnedFingerprints: Record<string, string>;
      readonly ownFingerprint: string;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: string;
      /** Members whose key the creator's keyring lacks — only set for that reason. */
      readonly missingKeysFor?: readonly string[];
    };

/**
 * The creator's side: choose one key per participant, strictly, from her own
 * keyring; build the document's keyring from what she is about to send (so
 * the creator and every participant hold *the same thing*, built the same
 * way); and produce the block she signs and encrypts. Sends nothing.
 */
export async function createInvite(params: CreateInviteParams): Promise<CreateInviteResult> {
  const { documentId, ownAddress, recipients, gpg } = params;
  const self = normalizeAddress(ownAddress);
  const fail = (
    error: string,
    missingKeysFor?: readonly string[],
  ): Extract<CreateInviteResult, { ok: false }> => ({
    ok: false,
    status: 422,
    error,
    ...(missingKeysFor === undefined ? {} : { missingKeysFor }),
  });

  const keysByAddress = new Map<string, readonly { fingerprint: string }[]>();
  const missing: string[] = [];
  for (const address of recipients) {
    // Sequential, not Promise.all: keeps this from spawning one gpg process
    // per participant at once.
    const keys = await gpg.listKeys(address);
    keysByAddress.set(address, keys);
    if (keys.length === 0) {
      missing.push(address);
    }
  }
  if (missing.length > 0) {
    return fail(`missing PGP key for ${missing.join(", ")} — refusing to send`, missing);
  }

  const ownSecretFingerprints = new Set(
    (await gpg.listSecretKeys(ownAddress)).map((key) => key.fingerprint.toUpperCase()),
  );
  if (ownSecretFingerprints.size === 0) {
    return fail(
      `no PGP secret key for ${ownAddress} in this bridge's keyring — cannot sign for ${documentId}, refusing to send`,
    );
  }

  const participants: { address: string; fingerprint: string }[] = [];
  for (const address of recipients) {
    let keys = keysByAddress.get(address) ?? [];
    if (normalizeAddress(address) === self) {
      // Her own entry is the key she can actually sign with.
      keys = keys.filter((key) => ownSecretFingerprints.has(key.fingerprint.toUpperCase()));
      if (keys.length === 0) {
        return fail(
          `no PGP secret key for ${ownAddress} in this bridge's keyring — cannot sign for ${documentId}, refusing to send`,
        );
      }
    }
    const only = keys.length === 1 ? keys[0] : undefined;
    if (!only) {
      return fail(
        `${keys.length} usable PGP keys match ${address} — refusing to guess which is theirs; remove all but the right one from your keyring`,
      );
    }
    participants.push({ address, fingerprint: only.fingerprint.toUpperCase() });
  }
  const ownFingerprint = fingerprintOf(participants, ownAddress);
  if (ownFingerprint === undefined) {
    return fail(`${ownAddress} is not one of the participants of ${documentId}`);
  }
  if (participants.every((p) => normalizeAddress(p.address) === self)) {
    return fail(`${documentId} needs at least one participant besides its creator`);
  }

  const pending = newPendingKeyringPath(params.bindStorePath);
  try {
    const keys = await gpg.exportKeys(participants.map((p) => p.fingerprint));
    const keyring = gpg.withKeyring(pending);
    await keyring.importKeys(keys);
    const problem = await verifyKeySet(keyring, participants);
    if (problem !== undefined) {
      discardKeyring(pending);
      return fail(`could not assemble the document's keyring: ${problem}`);
    }
    const payload: InvitePayload = {
      tdsp: 1,
      kind: "invite",
      documentId,
      creator: ownAddress,
      profile: params.profile,
      participants,
      keys,
      ...(params.policy === undefined ? {} : { policy: params.policy }),
    };
    const armored = await keyring.signAndEncrypt(
      encodeInvite(payload),
      ownFingerprint,
      participants.filter((p) => p.fingerprint !== ownFingerprint).map((p) => p.fingerprint),
    );
    return {
      ok: true,
      armored,
      pendingKeyringPath: pending,
      pinnedFingerprints: Object.fromEntries(
        participants.map((p) => [normalizeAddress(p.address), p.fingerprint]),
      ),
      ownFingerprint,
    };
  } catch (error) {
    discardKeyring(pending);
    throw error;
  }
}

export interface AcceptInviteParams {
  readonly documentId: string;
  readonly threadRootMessageId: string;
  /** This bridge's own mailbox address. */
  readonly ownAddress: string;
  /** What the invitation link *claims*. Never trusted: each is checked against what the creator signed. */
  readonly expected: {
    readonly creator: string;
    readonly recipients: readonly string[];
    readonly profile: string;
  };
  readonly gpg: GpgInvoker;
  readonly receiver: MailReceiver;
  readonly bindStorePath: string;
}

/**
 * The participant's side. Reads the invitation named by the link's
 * `Message-ID` from *this* mailbox, and either returns everything a bind
 * record needs — with the document's keyring already in its final place — or
 * a reason and leaves nothing behind.
 *
 * Opening it takes two passes, because the keys that verify the creator's
 * signature are inside what she signed. Pass one opens it *without trusting
 * it*, in a keyring holding only this user's own public key (exported by
 * exact fingerprint from their keyring: `gpg` needs the public half beside a
 * secret key to use it — verified on GnuPG 2.2.40, 2.4.4 and 2.5.22). Pass two
 * builds the document's keyring from the keys pass one revealed, checks that
 * they are exactly what the fingerprint list says, and only then *verifies*
 * the very same message against it: a good signature, by the key the list
 * gives the creator, or the invitation is refused.
 */
export async function acceptInvite(params: AcceptInviteParams): Promise<AcceptInviteResult> {
  const { documentId, threadRootMessageId, ownAddress, expected, gpg, receiver } = params;
  const reject = (
    reason: InviteRejectionReason,
    error: string,
    sender?: string,
  ): AcceptInviteResult => ({
    ok: false,
    reason,
    error,
    ...(sender === undefined ? {} : { sender }),
  });

  const roots = (await receiver.fetchThreadMessages(documentId)).filter(
    (message) => message.messageId === threadRootMessageId,
  );
  if (roots.length === 0) {
    return reject(
      "invite-not-found",
      `no message with the Message-ID ${threadRootMessageId} for ${documentId} is in this mailbox (yet) — the invitation may not have arrived`,
    );
  }
  const root = roots[0];
  if (root === undefined || roots.length > 1) {
    return reject(
      "invite-malformed",
      `several messages carry the Message-ID ${threadRootMessageId} — refusing to guess which is the invitation`,
    );
  }
  const sender = root.from;
  if (root.tooLarge) {
    return reject(
      "invite-malformed",
      `the invitation ${threadRootMessageId} is larger than this bridge reads (BRG-13); it was not opened`,
      sender,
    );
  }

  if (normalizeAddress(root.from) !== normalizeAddress(expected.creator)) {
    return reject(
      "invite-not-from-creator",
      `the invitation was sent by ${root.from}, not by the document's creator ${expected.creator}`,
      sender,
    );
  }
  if (!recipientHeadersMatchClosedSet(root.from, root.to, root.cc, expected.recipients)) {
    return reject(
      "recipient-list-mismatch",
      "the invitation's To/Cc headers do not match the participants named in the link",
      sender,
    );
  }
  const block = extractArmoredMessage(root.text);
  if (block === "none") {
    return reject(
      "invite-not-encrypted",
      "the invitation carries no PGP-encrypted block — the invitation to a PGP-enabled document must be signed and encrypted",
      sender,
    );
  }
  if (block === "several") {
    return reject("invite-malformed", "the invitation carries more than one PGP block", sender);
  }

  const ownSecretKeys = await gpg.listSecretKeys(ownAddress);
  if (ownSecretKeys.length === 0) {
    return reject(
      "invite-undecipherable",
      `no PGP secret key for ${ownAddress} in this bridge's keyring, so the invitation cannot be opened`,
      sender,
    );
  }

  const pendingOwn = newPendingKeyringPath(params.bindStorePath);
  const pendingDocument = newPendingKeyringPath(params.bindStorePath);
  let committed = false;
  try {
    // Pass one: open it, trusting nothing.
    const ownRing = gpg.withKeyring(pendingOwn);
    await ownRing.importKeys(await gpg.exportKeys(ownSecretKeys.map((key) => key.fingerprint)));
    const opened = await ownRing.decryptUnverified(block.block);
    if (!opened.decrypted || opened.plaintext === undefined) {
      return reject(
        "invite-undecipherable",
        "the invitation is not encrypted to a key you hold — the creator has a different key for you than the one in your keyring",
        sender,
      );
    }
    const invite = decodeInvite(opened.plaintext);
    if (invite === undefined || invite.documentId !== documentId) {
      return reject(
        "invite-malformed",
        `the invitation's content is not a valid invitation for ${documentId}`,
        sender,
      );
    }

    // What was signed must agree with the link and with the mail headers.
    const signed = new Set(invite.participants.map((p) => normalizeAddress(p.address)));
    const claimed = new Set(expected.recipients.map(normalizeAddress));
    const creatorFingerprint = fingerprintOf(invite.participants, invite.creator);
    const ownFingerprint = fingerprintOf(invite.participants, ownAddress);
    if (
      normalizeAddress(invite.creator) !== normalizeAddress(expected.creator) ||
      invite.profile !== expected.profile ||
      signed.size !== invite.participants.length ||
      signed.size !== claimed.size ||
      [...signed].some((address) => !claimed.has(address)) ||
      creatorFingerprint === undefined ||
      ownFingerprint === undefined
    ) {
      return reject(
        "invite-participants-mismatch",
        "what the creator signed (participants, creator, schema version) does not match the link and the mail headers",
        sender,
      );
    }

    // Pass two: the keyring the document will use, built from what was carried…
    if (invite.keys.length > MAX_INVITE_KEYS_LENGTH) {
      return reject("invite-malformed", "the invitation's key block is too large", sender);
    }
    const documentRing = gpg.withKeyring(pendingDocument);
    try {
      await documentRing.importKeys(invite.keys);
    } catch (error) {
      return reject(
        "invite-key-set-invalid",
        `the keys in the invitation could not be imported: ${error instanceof Error ? error.message : String(error)}`,
        sender,
      );
    }
    const problem = await verifyKeySet(documentRing, invite.participants);
    if (problem !== undefined) {
      return reject("invite-key-set-invalid", problem, sender);
    }

    // … and only now is the same message *verified* against it.
    const verified = await documentRing.decryptAndVerify(block.block);
    if (!verified.decrypted) {
      return reject(
        "invite-undecipherable",
        "the invitation lists a key for you that you do not hold the secret key for",
        sender,
      );
    }
    if (verified.signature === "missing") {
      return reject("invite-unsigned", "the invitation carries no PGP signature", sender);
    }
    if (
      verified.signature !== "valid" ||
      verified.signerFingerprint === undefined ||
      verified.payload === undefined
    ) {
      return reject(
        "invite-signature-invalid",
        "the invitation's signature could not be verified against the keys it carries",
        sender,
      );
    }
    if (verified.signerFingerprint.toUpperCase() !== creatorFingerprint) {
      return reject(
        "invite-signer-not-creator",
        `the invitation is signed by ${verified.signerFingerprint}, not by the key the creator ${invite.creator} is listed with (${creatorFingerprint})`,
        sender,
      );
    }
    if (verified.payload.trim() !== opened.plaintext.trim()) {
      return reject("invite-malformed", "the invitation changed between two readings", sender);
    }
    if (!(await gpg.hasSecretKey(ownFingerprint))) {
      return reject(
        "invite-undecipherable",
        `the invitation lists the key ${ownFingerprint} for you, but you do not hold its secret key`,
        sender,
      );
    }

    const keyringPath = keyringPathFor(params.bindStorePath, documentId);
    commitKeyring(pendingDocument, keyringPath);
    committed = true;
    return {
      ok: true,
      accepted: {
        recipients: invite.participants.map((p) => p.address),
        creator: invite.creator,
        profile: invite.profile,
        pinnedFingerprints: Object.fromEntries(
          invite.participants.map((p) => [normalizeAddress(p.address), p.fingerprint]),
        ),
        ownFingerprint,
        keyringPath,
        ...(invite.policy === undefined ? {} : { policy: invite.policy }),
      },
    };
  } finally {
    discardKeyring(pendingOwn);
    if (!committed) {
      discardKeyring(pendingDocument);
    }
  }
}
