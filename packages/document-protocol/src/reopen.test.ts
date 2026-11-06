import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import {
  type Delivery,
  type DeliveryId,
  type DocumentId,
  type MemberId,
  type MessengerPort,
  TransportSendError,
} from "@tdsp/messenger-port";
import { encodeUpdate, getPlainText, insertPlainText } from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFrame, type Frame } from "./framing";
import {
  DocumentEngine,
  type DocumentEngineOptions,
  type OwedReport,
  type PersistedControlState,
  REPORT_AFTER_MS,
} from "./index";

/**
 * Opening a document again after its device's last change was lost (SPECIFICATION.md SND-11, SND-27,
 * SND-28, RSY-1, CTL-13, §10.6): a start is an occasion to heal that loss in three cases only — the
 * report was still owed, and goes from what the application persisted; the device may still write, and
 * sends the content it restored; or it was away longer than RSY-1's absence, and its start request
 * shows what it holds. A report the transport accepted is owed no more, also where it was lost on its
 * way afterwards: a device that may no longer write, opened again soon, sends nothing that shows it.
 * Bob's device here persists what an application persists — control state, content, cursor, instance,
 * when its last read began and the report it owes — and starts again from it, consistent, without a
 * gap.
 */

const DOC = "doc-1";
/** 2026-10-26 10:00:00 UTC. */
const T = 1_793_008_800_000;
const MINUTE = 60_000;
const OPTS: DocumentEngineOptions = {
  batchWindowMs: 0,
  resyncResponseThrottleMs: 0,
  creatorMemberId: "alice",
  syncPolicy: { expectedLatencyMs: 2_000 },
};

interface Sent {
  readonly at: number;
  readonly id: DeliveryId;
  readonly device: string;
  readonly frame: Frame;
}

/** One channel, every send logged with the device that made it. */
class Net {
  readonly inner = new InMemoryMessengerPort();
  readonly log: Sent[] = [];
  readonly views: View[] = [];

  view(member: MemberId, device: string): View {
    const view = new View(this, member, device);
    this.views.push(view);
    return view;
  }

  /** What `device` sent of `kind`, from `since` on. */
  sent(device: string, kind: Frame["kind"], since = 0): Sent[] {
    return this.log.filter((s) => s.at >= since && s.device === device && s.frame.kind === kind);
  }
}

/**
 * One device's view of the channel, read from a cursor as a bridge's window is (TRN-18, TRN-19): it can
 * be offline — every send refused for now, as without a network —, and it can lose on the way here what
 * matches a rule, after the transport accepted it.
 */
class View implements MessengerPort {
  offline = false;
  readonly #hidden = new Set<DeliveryId>();
  readonly #rules: ((s: Sent) => boolean)[] = [];

  constructor(
    readonly net: Net,
    readonly member: MemberId,
    readonly device: string,
  ) {}

  /** Every delivery matching `rule` from now on never reaches this device. */
  loseAll(rule: (s: Sent) => boolean): void {
    this.#rules.push(rule);
  }

  createDocument(documentId: DocumentId, creator: MemberId): Promise<void> {
    return this.net.inner.createDocument(documentId, creator);
  }

  async send(documentId: DocumentId, sender: MemberId, payload: string): Promise<DeliveryId> {
    if (this.offline) throw new TransportSendError("unavailable", `${this.device} is offline`);
    const id = await this.net.inner.send(documentId, sender, payload);
    const sent: Sent = { at: Date.now(), id, device: this.device, frame: decodeFrame(payload) };
    this.net.log.push(sent);
    for (const view of this.net.views) {
      if (view !== this && view.#rules.some((rule) => rule(sent))) view.#hidden.add(id);
    }
    return id;
  }

  async receive(documentId: DocumentId, member: MemberId): Promise<readonly Delivery[]> {
    if (this.offline) throw new TransportSendError("unavailable", `${this.device} is offline`);
    return (await this.net.inner.receive(documentId, member)).filter(
      (d) => !this.#hidden.has(d.id),
    );
  }

  async receiveSince(
    documentId: DocumentId,
    member: MemberId,
    after: DeliveryId | undefined,
  ): Promise<{ readonly deliveries: readonly Delivery[]; readonly truncated: boolean }> {
    const visible = await this.receive(documentId, member);
    if (after === undefined) return { deliveries: visible, truncated: false };
    const at = visible.findIndex((delivery) => delivery.id === after);
    return at === -1
      ? { deliveries: visible, truncated: true }
      : { deliveries: visible.slice(at + 1), truncated: false };
  }

  instance(): Promise<string> {
    return this.net.inner.instance();
  }

  listChannels(member: MemberId) {
    return this.net.inner.listChannels(member);
  }
}

async function run(ms: number, engines: readonly DocumentEngine[], step = 1_000): Promise<void> {
  for (let passed = 0; passed < ms; passed += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - passed));
    for (const engine of engines) {
      await engine.sync().catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T);
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * What became of the report that ends Bob's phase: `unsent` — his device ended before the report
 * delay passed, and nothing more left it —; `refused` — his device lost its network, and every try
 * of the report was refused for now (SND-12) —; `lost` — the transport accepted it, and it was lost on
 * its way, as the change was.
 */
type Fate = "unsent" | "refused" | "lost";

/**
 * Alice creates "Plan" and lets Bob write; Bob joins, and everything settles. Bob's last change, "!",
 * is accepted by the transport and lost on its way to Alice, and so is everything else that device
 * sends; the report that ends his phase meets `fate`, and the device stops. What his application
 * persisted, as it stops, and the report it says he owes then.
 */
async function lastChangeLost(fate: Fate) {
  const net = new Net();
  await net.inner.createDocument(DOC, "alice");
  const aliceView = net.view("alice", "a1");
  const alice = await DocumentEngine.create(DOC, "alice", aliceView, undefined, OPTS);
  await alice.setMembership("bob", "write");
  alice.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
  let controlState: PersistedControlState | undefined;
  const bobView = net.view("bob", "b1");
  const bob = await DocumentEngine.join(DOC, "bob", bobView, undefined, {
    ...OPTS,
    onControlStateChange: (state) => {
      controlState = state;
    },
  });
  await run(MINUTE, [alice, bob]);
  expect(bob.hasCompletedBootstrap).toBe(true);
  expect(getPlainText(alice.fragment)).toBe("Plan");
  aliceView.loseAll((s) => s.device === "b1");
  bob.edit((fragment) => insertPlainText(fragment, 4, "!"));
  await vi.advanceTimersByTimeAsync(0);
  expect(net.sent("b1", "edit")).toHaveLength(1);
  let readAt = Date.now();
  if (fate === "refused") {
    bobView.offline = true;
    await run(REPORT_AFTER_MS + 10_000, [alice]);
  } else if (fate === "lost") {
    await run(REPORT_AFTER_MS + 10_000, [alice, bob]);
    readAt = Date.now();
    expect(net.sent("b1", "heartbeat")).toHaveLength(1);
  }
  const owed: OwedReport | undefined = bob.owedReport;
  const restore = {
    state: encodeUpdate(bob.document),
    cursor: bob.cursor,
    instance: bob.instance,
    readAt,
    ...(owed === undefined ? {} : { owedReport: owed }),
  };
  if (fate === "unsent") {
    bobView.offline = true; // ended: nothing more leaves that device
  } else {
    bob.dispose();
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(getPlainText(alice.fragment)).toBe("Plan");
  expect(alice.syncHealth.suspicions).toStrictEqual([]);
  return { net, alice, owed, controlState: controlState as PersistedControlState, restore };
}

/** What Alice decides while Bob's device is away: nothing, Bob reads only, or the close. */
type Meanwhile = "nothing" | "read-only" | "closed";

async function decideMeanwhile(alice: DocumentEngine, meanwhile: Meanwhile): Promise<void> {
  if (meanwhile === "read-only") await alice.setMembership("bob", "read");
  if (meanwhile === "closed") await alice.closeDocument();
}

/** Bob's device starts again from what it persisted, `awayMs` after its last read began. */
async function reopen(
  lost: Awaited<ReturnType<typeof lastChangeLost>>,
  meanwhile: Meanwhile,
  awayMs: number,
) {
  const { net, alice, controlState, restore } = lost;
  await decideMeanwhile(alice, meanwhile);
  await run(restore.readAt + awayMs - Date.now(), [alice], 10_000);
  const since = Date.now();
  const bob = await DocumentEngine.join(DOC, "bob", net.view("bob", "b2"), undefined, {
    ...OPTS,
    controlState,
    restore,
  });
  await run(3 * MINUTE, [alice, bob]);
  expect(bob.hasCompletedBootstrap).toBe(true);
  expect(getPlainText(bob.fragment)).toBe("Plan!");
  expect(bob.closed).toBe(meanwhile === "closed");
  expect(bob.mayEdit).toBe(meanwhile === "nothing");
  return { bob, since };
}

describe("a report still owed when the device stopped goes as it opens again, whatever it may do now (SND-28, SND-27, SND-12)", () => {
  for (const fate of ["unsent", "refused"] as const) {
    for (const meanwhile of ["nothing", "read-only", "closed"] as const) {
      it(`${fate}, then ${meanwhile} meanwhile: the report carries the lost change, and Alice holds it`, async () => {
        const lost = await lastChangeLost(fate);
        expect(lost.owed?.update).toBeDefined();
        const { since } = await reopen(lost, meanwhile, MINUTE);
        expect(lost.net.sent("b2", "heartbeat", since)).toHaveLength(1);
        expect(getPlainText(lost.alice.fragment)).toBe("Plan!");
      });
    }
  }
});

describe("a report the transport accepted, then lost on its way, is owed no more (SND-28, TRN-10)", () => {
  it("with the write right, the device sends the content it restored as it opens again, and Alice holds the change (SND-8, CTL-13)", async () => {
    const lost = await lastChangeLost("lost");
    expect(lost.owed).toBeUndefined();
    const { since } = await reopen(lost, "nothing", MINUTE);
    expect(lost.net.sent("b2", "heartbeat", since)).toStrictEqual([]);
    expect(lost.net.sent("b2", "edit", since).length).toBeGreaterThan(0);
    expect(getPlainText(lost.alice.fragment)).toBe("Plan!");
  });

  for (const meanwhile of ["read-only", "closed"] as const) {
    it(`${meanwhile} meanwhile and opened again within 10 minutes, the device sends nothing that shows the change: Alice lacks it and sees no loss (RSY-1, CTL-13)`, async () => {
      const lost = await lastChangeLost("lost");
      const { since } = await reopen(lost, meanwhile, MINUTE);
      for (const kind of ["edit", "heartbeat", "resync-request"] as const) {
        expect(lost.net.sent("b2", kind, since), kind).toStrictEqual([]);
      }
      expect(getPlainText(lost.alice.fragment)).toBe("Plan");
      expect(lost.alice.syncHealth.suspicions).toStrictEqual([]);
    });

    it(`${meanwhile} meanwhile and opened again after more than 10 minutes away, its start request shows Alice what she lacks, and an answer brings it (RSY-1, LOS-4)`, async () => {
      const lost = await lastChangeLost("lost");
      const { since } = await reopen(lost, meanwhile, 11 * MINUTE);
      expect(lost.net.sent("b2", "resync-request", since).length).toBeGreaterThan(0);
      expect(getPlainText(lost.alice.fragment)).toBe("Plan!");
    });
  }
});
