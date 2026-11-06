import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import { TransportSendError } from "@tdsp/messenger-port";
import { encodeUpdate, getPlainText, insertPlainText } from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFrame } from "./framing";
import { DocumentEngine, type PersistedControlState } from "./index";

/**
 * A start does not wait for its request to go out (SPECIFICATION.md RSY-1, RSY-3, RSY-6, SND-7): `join`
 * resolves once its first read is done, the request taking the slot and waiting in the send scheduler
 * for as long as it must — here for the 30 minutes a transport asked for when it refused, as
 * rate-limited, the answer the first read made a device of the creator give at once, a wait that holds
 * back every send. The engine is its application's from the start: it reads, holds what it restored,
 * and shows that its request waits.
 */

const DOC = "doc-1";
const OPTS = { batchWindowMs: 0, resyncResponseThrottleMs: 0, creatorMemberId: "alice" };
const MINUTE = 60_000;
const WAIT_MS = 30 * MINUTE;

/**
 * The in-memory transport, whose provider throttles `member`'s account for 30 minutes from now: it
 * refuses each of its messages as rate-limited, asking it to wait until then. When each of its requests
 * went out.
 */
function throttling(
  port: InMemoryMessengerPort,
  member: string,
): { readonly requestsAt: number[] } {
  const requestsAt: number[] = [];
  const until = Date.now() + WAIT_MS;
  const send = port.send.bind(port);
  port.send = async (documentId, sender, payload) => {
    if (sender === member) {
      if (Date.now() < until)
        throw new TransportSendError("rate-limited", "slow down", until - Date.now());
      if (decodeFrame(payload).kind === "resync-request") requestsAt.push(Date.now());
    }
    return send(documentId, sender, payload);
  };
  return { requestsAt };
}

/** Every engine polls every 10 s for `ms`. */
async function run(ms: number, engines: readonly DocumentEngine[]): Promise<void> {
  for (let passed = 0; passed < ms; passed += 10_000) {
    await vi.advanceTimersByTimeAsync(10_000);
    for (const engine of engines) await engine.sync();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-26T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a start whose transport holds back every send for 30 minutes (RSY-1, SND-7)", () => {
  it("join resolves after its first read, its start request waiting in the scheduler; the request goes once the wait is over, and the answer the read owed with it", async () => {
    const port = new InMemoryMessengerPort();
    let saved: PersistedControlState | undefined;
    const alice = await DocumentEngine.create(DOC, "alice", port, undefined, {
      ...OPTS,
      onControlStateChange: (state) => (saved = state),
    });
    for (const member of ["bob", "carol"]) await alice.setMembership(member, "write");
    alice.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
    const bob = await DocumentEngine.join(DOC, "bob", port, undefined, OPTS);
    await run(MINUTE, [alice, bob]);
    // Alice stops. Not knowing when her last read began, she owes a start request as she starts
    // again (RSY-1).
    const kept = {
      controlState: saved as PersistedControlState,
      restore: { state: encodeUpdate(alice.document) },
    };
    alice.dispose();
    // Carol joins meanwhile; her first request asks the creator's devices and her own, none there.
    const carol = await DocumentEngine.join(DOC, "carol", port, undefined, OPTS);
    await run(5_000, [bob, carol]);
    expect(carol.hasCompletedBootstrap).toBe(false);
    // Alice's first read brings Carol's request, which she answers at once (RSY-6); the transport
    // refuses that answer as rate-limited, for 30 minutes: every send waits that long.
    const refused = throttling(port, "alice");
    const t0 = Date.now();
    let restarted: DocumentEngine | undefined;
    DocumentEngine.join(DOC, "alice", port, undefined, { ...OPTS, ...kept }).then(
      (engine) => (restarted = engine),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(restarted).toBeDefined();
    const back = restarted as DocumentEngine;
    expect(getPlainText(back.fragment)).toBe("Plan");
    expect(back.syncHealth.resync.state).toBe("requested");
    await run(WAIT_MS + MINUTE, [back, bob, carol]);
    expect(refused.requestsAt).toHaveLength(1);
    expect((refused.requestsAt[0] as number) - t0).toBeGreaterThanOrEqual(WAIT_MS);
    expect(carol.hasCompletedBootstrap).toBe(true);
  });
});

describe("a joiner whose first request waits in the scheduler (RSY-1, RSY-3, SND-7)", () => {
  /** Alice's "Plan", Dave named a writer, her first sends gone out. */
  async function plan(port: InMemoryMessengerPort): Promise<DocumentEngine> {
    const alice = await DocumentEngine.create(DOC, "alice", port, undefined, OPTS);
    await alice.setMembership("dave", "write");
    alice.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
    await run(20_000, [alice]);
    return alice;
  }

  it("join resolves after its first read though its transport refuses the request as rate-limited for 30 minutes; the request goes once, after the wait, and bootstraps it", async () => {
    const port = new InMemoryMessengerPort();
    const alice = await plan(port);
    const refused = throttling(port, "dave");
    const t0 = Date.now();
    let joined: DocumentEngine | undefined;
    DocumentEngine.join(DOC, "dave", port, undefined, OPTS).then((engine) => (joined = engine));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(joined).toBeDefined();
    const dave = joined as DocumentEngine;
    expect(dave.hasCompletedBootstrap).toBe(false);
    expect(dave.syncHealth.resync.state).toBe("requested");
    await run(WAIT_MS + MINUTE, [alice, dave]);
    expect(refused.requestsAt).toHaveLength(1);
    expect((refused.requestsAt[0] as number) - t0).toBeGreaterThanOrEqual(WAIT_MS);
    expect(dave.hasCompletedBootstrap).toBe(true);
    expect(getPlainText(dave.fragment)).toBe("Plan");
  });

  it("join resolves after its first read though its transport takes 60 s to accept the request", async () => {
    const port = new InMemoryMessengerPort();
    const alice = await plan(port);
    const send = port.send.bind(port);
    port.send = async (documentId, sender, payload) => {
      if (sender === "dave") await new Promise((resolve) => setTimeout(resolve, MINUTE));
      return send(documentId, sender, payload);
    };
    let joined: DocumentEngine | undefined;
    DocumentEngine.join(DOC, "dave", port, undefined, OPTS).then((engine) => (joined = engine));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(joined).toBeDefined();
    const dave = joined as DocumentEngine;
    await run(2 * MINUTE, [alice, dave]);
    expect(dave.hasCompletedBootstrap).toBe(true);
  });
});
