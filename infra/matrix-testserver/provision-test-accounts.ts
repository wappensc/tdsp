/**
 * network-policy: loopback — Zone A (docs/network-policy.md). Test infrastructure: provisions the shared test accounts on the local Synapse container.
 */
import { existsSync } from "node:fs";
import { BASE_URL, TEST_ACCOUNT_PASSWORD, TEST_ACCOUNTS, TEST_ACCOUNTS_PATH } from "./config.ts";
import { createRoom } from "./create-room.ts";
import { writeIntoCredentialsDir } from "./docker-fs.ts";
import { loginFresh } from "./login.ts";
import { registerAccount } from "./register.ts";

/**
 * Provisions "alice"/"bob" plus one unencrypted and one Megolm-encrypted
 * test room, both bob-joined — the fixture the Matrix bridge's live tests
 * use. Everything here is verified against a real v1.159.0 container, not
 * assumed from the documentation:
 *
 * - Registration uses Synapse's admin shared-secret API
 *   (`/_synapse/admin/v1/register`: `GET` for a nonce, `POST` with an
 *   HMAC-SHA1 `mac` over `nonce\0username\0password\0admin|notadmin`,
 *   keyed with `registration_shared_secret` from the generated
 *   `homeserver.yaml`) — not `register_new_matrix_user`'s CLI, since this
 *   needs to run non-interactively from a plain Node script with no extra
 *   dependency, and not the client-facing `/register` endpoint, which
 *   this server leaves closed (`enable_registration` unset, i.e. false).
 * - `POST /_matrix/client/v3/login` (`m.login.password`, in `login.ts`) is
 *   exercised too, not just registration's own returned token — a real
 *   login per account is what a real client does, not the admin API.
 * - A room's `m.room.encryption` state event, set once at creation via
 *   `initial_state`, is unset (a 404 on
 *   `GET .../state/m.room.encryption/`) for a plain room and present for
 *   an encrypted one — this is the read-only "is this existing room
 *   already encrypted" check binding relies on (a bridge never sets
 *   encryption on a room).
 *
 * Idempotent the same way `generate-config.ts` is: if `test-accounts.json`
 * already exists, provisioning is skipped — re-registering the same
 * usernames would just 400 with `M_USER_IN_USE` for no benefit. Delete it
 * (or run `matrix:reset`, which deletes all of `credentials/`) for a
 * clean re-provision.
 */

interface AccountRecord {
  userId: string;
  accessToken: string;
  password: string;
}

interface RoomsRecord {
  plain: string;
  encrypted: string;
}

async function login(username: string): Promise<AccountRecord> {
  // Delegates to login.ts's loginFresh — the
  // one-time device this creates at provisioning time is the account's
  // "primary" persisted device, the one test-accounts.json's own
  // accessToken names ever after. Crypto-machine-using test files mint
  // their *own*, separate fresh device per run instead of reusing this
  // one — see login.ts's own doc comment for why.
  const { userId, accessToken } = await loginFresh(username, TEST_ACCOUNT_PASSWORD);
  return { userId, accessToken, password: TEST_ACCOUNT_PASSWORD };
}

async function inviteAndJoin(
  inviter: AccountRecord,
  invitee: AccountRecord,
  roomId: string,
): Promise<void> {
  const inviteResponse = await fetch(
    `${BASE_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${inviter.accessToken}`,
      },
      body: JSON.stringify({ user_id: invitee.userId }),
    },
  );
  if (!inviteResponse.ok) {
    throw new Error(`invite into ${roomId} failed: ${inviteResponse.status}`);
  }
  const joinResponse = await fetch(
    `${BASE_URL}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${invitee.accessToken}`,
      },
      body: "{}",
    },
  );
  if (!joinResponse.ok) {
    throw new Error(`join ${roomId} failed: ${joinResponse.status}`);
  }
}

if (existsSync(TEST_ACCOUNTS_PATH)) {
  console.log(`${TEST_ACCOUNTS_PATH} already exists — skipping provisioning.`);
  process.exit(0);
}

for (const username of TEST_ACCOUNTS) {
  await registerAccount(username);
}
const [alice, bob] = await Promise.all(TEST_ACCOUNTS.map(login));
if (!alice || !bob) {
  throw new Error("expected exactly two TEST_ACCOUNTS (alice, bob)");
}

const plainRoomId = await createRoom(alice.accessToken, false, "tdsp test room (plain)");
await inviteAndJoin(alice, bob, plainRoomId);
const encryptedRoomId = await createRoom(alice.accessToken, true, "tdsp test room (encrypted)");
await inviteAndJoin(alice, bob, encryptedRoomId);

const rooms: RoomsRecord = { plain: plainRoomId, encrypted: encryptedRoomId };
// docker-fs.ts's writeIntoCredentialsDir, not a direct fs.writeFileSync —
// `generate-config.ts`'s own doc comment on `docker-fs.ts` covers why: on
// real Linux CI, `generate` leaves `credentials/` itself (not just the
// files in it) owned by uid 991, so a direct host-side write of a new
// file here fails with EACCES too, confirmed by a real failing run.
writeIntoCredentialsDir("test-accounts.json", JSON.stringify({ alice, bob, rooms }, null, 2));
console.log(`Provisioned alice/bob and two test rooms — see ${TEST_ACCOUNTS_PATH}`);
