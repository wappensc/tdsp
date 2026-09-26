import type { TransportProfile } from "@tdsp/messenger-port";
import { ATTACHMENT_FRAME_LIMIT } from "./attachment.ts";

/**
 * What this bridge says about its own limits, served at `GET /transport-profile`:
 * the send policies it suggests and the bounds no policy may cross.
 *
 * **Which profile depends on the homeserver.** One on this machine (the local Synapse
 * test server) is configured not to throttle, so it gets no floor and one profile
 * holding the engine's own defaults. Any other
 * homeserver is a real one, which rate-limits: Synapse's documented default lets a
 * user send on the order of one message every five seconds sustained, with a burst
 * allowance, and answers `429 M_LIMIT_EXCEEDED` beyond it (the local test server's
 * invite limiter is the same mechanism).
 *
 * **Every number here except the size bound is an estimate**, not a measurement: no
 * real homeserver has been driven to its limit on purpose. A 1 s floor keeps
 * typing feeling live and relies on the scheduler's adaptive spacing (a 429 widens it)
 * to settle at whatever the homeserver really allows.
 *
 * **The size bound is a choice, not a limit of the homeserver.** An event body cannot carry
 * more than about 35 KB of frame (Matrix's 65 536-byte event limit, less the envelope and, in
 * an encrypted room, Megolm's Base64 expansion of an already Base64-encoded frame), so a frame
 * up to 32 000 bytes rides in the body and a larger one goes up as a media file with a
 * reference in the event (`attachment.ts`). The bound is what the bridge will carry as one
 * message that way, 4 MiB — capped because what a peer may make this bridge download must be.
 * A change larger than that is cut by `document-protocol`.
 */

const SIZE_BOUND = ATTACHMENT_FRAME_LIMIT;

export const MATRIX_HOMESERVER_PROFILE: TransportProfile = {
  bounds: { minIntervalMs: 250, maxBytes: SIZE_BOUND },
  profiles: [
    {
      id: "standard",
      label: "Standard",
      description: "At most one message a second, for a homeserver that rate-limits.",
      values: {
        minIntervalMs: 1_000,
        maxIntervalMs: 15_000,
        minChars: 0,
        maxChars: null,
        expectedLatencyMs: 5_000,
      },
    },
    {
      id: "constrained",
      label: "Constrained",
      description:
        "At most one message every five seconds, for a slow connection or a strict homeserver.",
      values: {
        minIntervalMs: 5_000,
        maxIntervalMs: 60_000,
        minChars: 0,
        maxChars: null,
        expectedLatencyMs: 15_000,
      },
    },
  ],
  defaultProfile: "standard",
};

export const MATRIX_LOCAL_PROFILE: TransportProfile = {
  bounds: { minIntervalMs: null, maxBytes: SIZE_BOUND },
  profiles: [
    {
      id: "local",
      label: "Local test homeserver",
      description: "A homeserver on this machine does not throttle.",
      values: {
        minIntervalMs: 0,
        maxIntervalMs: null,
        minChars: 0,
        maxChars: null,
        expectedLatencyMs: 0,
      },
    },
  ],
  defaultProfile: "local",
};

export function transportProfileFor(homeserverIsLocal: boolean): TransportProfile {
  return homeserverIsLocal ? MATRIX_LOCAL_PROFILE : MATRIX_HOMESERVER_PROFILE;
}
