/**
 * network-policy: loopback — Zone A (docs/network-policy.md). Test infrastructure: creates a per-run room on the local Synapse container.
 */
import { BASE_URL } from "./config.ts";

/**
 * `POST /_matrix/client/v3/createRoom` — shared with
 * `provision-test-accounts.ts` so
 * `crypto.test.ts` can create its own disposable, always-empty-of-
 * members-except-the-creator room per run rather than reusing the
 * shared `rooms.encrypted` fixture — that fixture's membership
 * (`test-accounts.json`'s bob, and a live-test-added "carol") persists
 * across runs on the same test-server volume, which the history-caveat
 * test cannot tolerate: it depends on its third member joining *after*
 * a message already exists, every single run.
 */
export async function createRoom(
  creatorAccessToken: string,
  encrypted: boolean,
  name: string,
): Promise<string> {
  const response = await fetch(`${BASE_URL}/_matrix/client/v3/createRoom`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${creatorAccessToken}`,
    },
    body: JSON.stringify({
      preset: "private_chat",
      name,
      initial_state: encrypted
        ? [
            {
              type: "m.room.encryption",
              state_key: "",
              content: { algorithm: "m.megolm.v1.aes-sha2" },
            },
          ]
        : [],
    }),
  });
  const body = (await response.json()) as { room_id?: string; error?: string };
  if (!response.ok || !body.room_id) {
    throw new Error(
      `createRoom(encrypted=${encrypted}) failed: ${response.status} ${JSON.stringify(body)}`,
    );
  }
  return body.room_id;
}
