import type { TransportProfile } from "@tdsp/messenger-port";
import { ATTACHMENT_FRAME_LIMIT } from "./attachment.ts";

/**
 * What this bridge says about its own limits, served at `GET /transport-profile`:
 * the send policies it suggests and the bounds no policy may cross.
 *
 * **The intervals here are estimates**, not measurements: no run has been made to hit
 * Signal's own rate limit on purpose. `signal-cli` surfaces
 * that limit as a JSON-RPC error (code 5, see `send-failure.ts`), so a floor that is too
 * fast is corrected by the scheduler's adaptive spacing rather than by being right.
 *
 * **The size bound is a choice, not a limit of Signal.** A message body carries roughly
 * 1 350 bytes, of which about 800 are frame bytes once the envelope and Base64 are paid
 * for, so a frame up to 800 bytes rides in the body and a larger one, up
 * to 4 MiB, goes as an attachment with an envelope naming it (`attachment.ts`). The bound
 * is what the bridge will carry as one message that way, capped because what a peer may
 * make this bridge read into memory must be. A change larger than that is cut by
 * `document-protocol`.
 */

export const SIGNAL_PROFILE: TransportProfile = {
  bounds: { minIntervalMs: 500, maxBytes: ATTACHMENT_FRAME_LIMIT },
  profiles: [
    {
      id: "standard",
      label: "Standard",
      description: "At most one message every two seconds.",
      values: {
        minIntervalMs: 2_000,
        maxIntervalMs: 20_000,
        minChars: 0,
        maxChars: null,
        expectedLatencyMs: 10_000,
      },
    },
    {
      id: "constrained",
      label: "Constrained",
      description: "At most one message every ten seconds, for a slow connection.",
      values: {
        minIntervalMs: 10_000,
        maxIntervalMs: 60_000,
        minChars: 0,
        maxChars: null,
        expectedLatencyMs: 30_000,
      },
    },
  ],
  defaultProfile: "standard",
};
