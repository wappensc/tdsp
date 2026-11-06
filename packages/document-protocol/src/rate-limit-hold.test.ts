import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import { TransportSendError } from "@tdsp/messenger-port";
import { getPlainText, insertPlainText } from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentEngine } from "./index";

/**
 * What ends the hold a refusal puts on every send (SPECIFICATION.md SND-7, SND-9, SND-12, TRN-20): a
 * send that went through, but only one that started after the hold began. Where a send takes longer
 * than the floor, sends overlap, and one under way as the provider refused another tells nothing of
 * what the provider allows since: its success must not lift a wait the provider asked for — an edit's,
 * a request's or a decision's alike —, nor the report's own back-off; and neither its success nor its
 * failure, for good or worth retrying, may end what the application is told of a refusal only the
 * person can lift.
 */

const DOC = "doc-1";
const MINUTE = 60_000;
const SEND_MS = 5_000;
const WAIT_MS = 10 * MINUTE;
/** A floor of 2 s, shorter than a send takes (SND-2). */
const OPTS = {
  batchWindowMs: 0,
  resyncResponseThrottleMs: 0,
  creatorMemberId: "alice",
  syncPolicy: { minIntervalMs: 2_000 },
};

/**
 * The in-memory transport, on which each of `member`'s sends takes 5 s, and whose provider refuses its
 * `refused`th send as rate-limited, asking it to wait 10 minutes. When each of its sends started, and
 * when the refusal came.
 */
function slowAndThrottled(port: InMemoryMessengerPort, member: string, refused: number) {
  const log = { startedAt: [] as number[], refusedAt: undefined as number | undefined };
  const send = port.send.bind(port);
  port.send = async (documentId, sender, payload) => {
    if (sender !== member) return send(documentId, sender, payload);
    log.startedAt.push(Date.now());
    const index = log.startedAt.length;
    await new Promise((resolve) => setTimeout(resolve, SEND_MS));
    if (index === refused) {
      log.refusedAt = Date.now();
      throw new TransportSendError("rate-limited", "slow down", WAIT_MS);
    }
    return send(documentId, sender, payload);
  };
  return log;
}

/**
 * The in-memory transport, on which `member`'s sends take `takes(kind)` ms, a resync request's 5 s
 * unless given; once `refuseNextEdit` is set, its next edit fails with it; reports fail as unavailable
 * while `refuseReports` is set. When each send started (with its kind), and when the edit was refused.
 */
function shaped(
  port: InMemoryMessengerPort,
  member: string,
  takes: (kind: string) => number = () => SEND_MS,
) {
  const log = {
    started: [] as { at: number; kind: string }[],
    refusedAt: undefined as number | undefined,
    refuseNextEdit: undefined as TransportSendError | undefined,
    refuseReports: false,
  };
  const send = port.send.bind(port);
  port.send = async (documentId, sender, payload) => {
    if (sender !== member) return send(documentId, sender, payload);
    const kind = (JSON.parse(payload) as { kind: string }).kind;
    log.started.push({ at: Date.now(), kind });
    await new Promise((resolve) => setTimeout(resolve, takes(kind)));
    const refusal = log.refuseNextEdit;
    if (refusal !== undefined && kind === "edit") {
      log.refuseNextEdit = undefined;
      log.refusedAt = Date.now();
      throw refusal;
    }
    if (log.refuseReports && kind === "heartbeat")
      throw new TransportSendError("unavailable", "not now");
    return send(documentId, sender, payload);
  };
  return log;
}

/**
 * The in-memory transport, on which `plan(kind, nth)` says how long `member`'s `nth` send of a kind
 * takes and with what it fails as it ends, if it does. When each send started and ended, with its kind,
 * its number and how it failed.
 */
function scripted(
  port: InMemoryMessengerPort,
  member: string,
  plan: (kind: string, nth: number) => { takes: number; fails?: TransportSendError },
) {
  const log = [] as { kind: string; nth: number; at: number; endedAt?: number; failed?: string }[];
  const send = port.send.bind(port);
  port.send = async (documentId, sender, payload) => {
    if (sender !== member) return send(documentId, sender, payload);
    const kind = (JSON.parse(payload) as { kind: string }).kind;
    const entry: (typeof log)[number] = {
      kind,
      nth: log.filter((s) => s.kind === kind).length + 1,
      at: Date.now(),
    };
    log.push(entry);
    const { takes, fails } = plan(kind, entry.nth);
    await new Promise((resolve) => setTimeout(resolve, takes));
    entry.endedAt = Date.now();
    if (fails !== undefined) {
      entry.failed = fails.reason;
      throw fails;
    }
    return send(documentId, sender, payload);
  };
  return log;
}

/** Alice creates "Plan" and lets Bob write; Bob joins and is bootstrapped. */
async function pair() {
  const port = new InMemoryMessengerPort();
  await port.createDocument(DOC, "alice");
  const alice = await DocumentEngine.create(DOC, "alice", port, undefined, OPTS);
  // Not waited for: the floor holds it back a moment, on fake time.
  alice.setMembership("bob", "write").catch(() => {});
  alice.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
  await run(10_000, [alice]);
  const bob = await DocumentEngine.join(DOC, "bob", port, undefined, OPTS);
  await run(30_000, [alice, bob]);
  expect(bob.hasCompletedBootstrap).toBe(true);
  return { port, alice, bob };
}

/**
 * Every engine polls every second for `ms`. A poll is not waited for, as the application's timer does
 * not wait: one may wait for a send, which takes its time.
 */
async function run(ms: number, engines: readonly DocumentEngine[]): Promise<void> {
  for (let passed = 0; passed < ms; passed += 1_000) {
    for (const engine of engines) void engine.sync().catch(() => {});
    await vi.advanceTimersByTimeAsync(1_000);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-26T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a rate-limit refusal while sends overlap (SND-7, SND-9)", () => {
  it("sends that take 5 s, one refused for 10 minutes while others are under way: none starts within those 10 minutes, and every edit arrives after them", {
    timeout: 60_000,
  }, async () => {
    const port = new InMemoryMessengerPort();
    await port.createDocument(DOC, "alice");
    const alice = await DocumentEngine.create(DOC, "alice", port, undefined, OPTS);
    // Not waited for: the floor holds it back a moment, on fake time.
    alice.setMembership("bob", "write").catch(() => {});
    alice.edit((fragment) => insertPlainText(fragment, 0, "Plan"));
    await run(10_000, [alice]);
    const bob = await DocumentEngine.join(DOC, "bob", port, undefined, OPTS);
    await run(30_000, [alice, bob]);
    expect(bob.hasCompletedBootstrap).toBe(true);
    const log = slowAndThrottled(port, "bob", 3);
    // Bob writes every second for 40 s: his edits, reports and the rest overlap on the slow transport.
    for (let second = 0; second < 40; second++) {
      bob.edit((fragment) => insertPlainText(fragment, 0, "x"));
      await run(1_000, [alice, bob]);
    }
    const refusedAt = log.refusedAt;
    expect(refusedAt).toBeDefined();
    // Sends overlapped: another had started before the refused one ended.
    expect(log.startedAt.filter((at) => at < (refusedAt as number)).length).toBeGreaterThan(3);
    await run(WAIT_MS + MINUTE, [alice, bob]);
    expect(
      log.startedAt.filter(
        (at) => at > (refusedAt as number) && at < (refusedAt as number) + WAIT_MS,
      ),
    ).toStrictEqual([]);
    expect(getPlainText(alice.fragment)).toBe(`${"x".repeat(40)}Plan`);
  });
});

describe("a send under way as another is refused ends nothing of the refusal (SND-7, SND-12, TRN-20)", () => {
  it("a request under way as an edit is refused as rate-limited, succeeding after the refusal, ends no hold: nothing starts within the 10 minutes asked for", {
    timeout: 60_000,
  }, async () => {
    const { port, alice, bob } = await pair();
    const log = shaped(port, "bob", (kind) => (kind === "resync-request" ? 10_000 : SEND_MS));
    void bob.requestResync().catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    await run(2_000, [alice, bob]);
    log.refuseNextEdit = new TransportSendError("rate-limited", "slow down", WAIT_MS);
    bob.edit((fragment) => insertPlainText(fragment, 0, "x"));
    await run(20_000, [alice, bob]);
    const refusedAt = log.refusedAt as number;
    expect(refusedAt).toBeDefined();
    // The request started before the refusal and ended after it.
    const request = log.started.find((s) => s.kind === "resync-request") as { at: number };
    expect(request.at).toBeLessThan(refusedAt);
    expect(request.at + 10_000).toBeGreaterThan(refusedAt);
    for (let second = 0; second < 30; second++) {
      bob.edit((fragment) => insertPlainText(fragment, 0, "y"));
      await run(1_000, [alice, bob]);
    }
    await run(WAIT_MS + MINUTE, [alice, bob]);
    expect(log.started.filter((s) => s.at > refusedAt && s.at < refusedAt + WAIT_MS)).toStrictEqual(
      [],
    );
    expect(getPlainText(alice.fragment)).toBe(`${"y".repeat(30)}xPlan`);
  });

  it("a request under way as a report is refused, succeeding after the refusal, ends no report back-off: the report waits on, its waits doubling (SND-12)", {
    timeout: 60_000,
  }, async () => {
    const { port, alice, bob } = await pair();
    const log = shaped(port, "bob", (kind) => (kind === "resync-request" ? 90_000 : SEND_MS));
    log.refuseReports = true;
    bob.edit((fragment) => insertPlainText(fragment, 0, "x"));
    await run(60_000, [alice, bob]);
    void bob.requestResync().catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    const request = log.started.find((s) => s.kind === "resync-request") as { at: number };
    expect(request).toBeDefined();
    await run(3 * MINUTE, [alice, bob]);
    // Reports were refused while the request was under way: its success ends none of their back-off.
    const ended = request.at + 90_000;
    const reports = log.started.filter((s) => s.kind === "heartbeat").map((s) => s.at);
    expect(reports.filter((at) => at > request.at && at < ended).length).toBeGreaterThan(0);
    expect(reports.filter((at) => at > ended && at <= ended + 20_000).length).toBeLessThanOrEqual(
      1,
    );
  });

  it("edits under way as one is refused as needs-person, succeeding after the refusal: sending is still shown as waiting for the person (TRN-20)", {
    timeout: 60_000,
  }, async () => {
    const { port, alice, bob } = await pair();
    const log = shaped(port, "bob");
    const states: string[] = [];
    for (let second = 0; second < 15; second++) {
      if (second === 3)
        log.refuseNextEdit = new TransportSendError("needs-person", "confirm this device");
      bob.edit((fragment) => insertPlainText(fragment, 0, "x"));
      await run(1_000, [alice, bob]);
      // The refused edit is kept: the failure counted for it stays with it (SND-7, TRN-20).
      if (log.refusedAt !== undefined)
        states.push(`${bob.sendStatus.state}/${bob.sendStatus.failures}`);
    }
    const refusedAt = log.refusedAt as number;
    expect(refusedAt).toBeDefined();
    // Sends overlapped: one that started before the refusal ended after it.
    expect(log.started.some((s) => s.at < refusedAt && s.at + SEND_MS > refusedAt)).toBe(true);
    expect(states.length).toBeGreaterThan(5);
    expect(new Set(states)).toStrictEqual(new Set(["needs-person/1"]));
    expect(bob.sendStatus.lastError).toBe("confirm this device");
  });

  it("a decision under way as an edit is refused as needs-person, succeeding after the refusal: sending is still shown as waiting for the person (TRN-20)", {
    timeout: 60_000,
  }, async () => {
    const { port, alice, bob } = await pair();
    const log = shaped(port, "alice", (kind) => (kind === "control" ? 10_000 : SEND_MS));
    log.refuseNextEdit = new TransportSendError("needs-person", "confirm this device");
    alice.setMembership("carol", "write").catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    await run(2_000, [alice, bob]);
    alice.edit((fragment) => insertPlainText(fragment, 0, "a"));
    await run(20_000, [alice, bob]);
    const refusedAt = log.refusedAt as number;
    expect(refusedAt).toBeDefined();
    const decision = log.started.find((s) => s.kind === "control") as { at: number };
    expect(decision.at).toBeLessThan(refusedAt);
    expect(decision.at + 10_000).toBeGreaterThan(refusedAt);
    expect(alice.sendStatus).toMatchObject({
      state: "needs-person",
      failures: 1,
      lastError: "confirm this device",
    });
  });

  for (const late of ["rejected", "unavailable"] as const) {
    it(`edits under way as one is refused as needs-person, one of them failing ${late} after the refusal: sending is still shown as waiting for the person (TRN-20)`, {
      timeout: 60_000,
    }, async () => {
      const { port, alice, bob } = await pair();
      // Edits take 5 s; the third is refused at once, the second fails as it ends, after that.
      const log = scripted(port, "bob", (kind, nth) =>
        kind !== "edit"
          ? { takes: SEND_MS }
          : nth === 3
            ? { takes: 0, fails: new TransportSendError("needs-person", "confirm this device") }
            : nth === 2
              ? { takes: SEND_MS, fails: new TransportSendError(late, `late ${late}`) }
              : { takes: SEND_MS },
      );
      const states: string[] = [];
      for (let second = 0; second < 25; second++) {
        bob.edit((fragment) => insertPlainText(fragment, 0, "x"));
        await run(1_000, [alice, bob]);
        if (log.some((s) => s.failed === "needs-person")) {
          states.push(
            `${bob.sendStatus.state}, ${bob.sendStatus.failures > 0 ? "counted" : "none counted"}: ${bob.sendStatus.lastError}`,
          );
        }
      }
      const refused = log.find((s) => s.failed === "needs-person") as { at: number };
      const second = log.find((s) => s.kind === "edit" && s.nth === 2) as {
        at: number;
        endedAt: number;
        failed: string;
      };
      // The second edit started before the refusal and failed after it.
      expect(second.at).toBeLessThan(refused.at);
      expect(second.endedAt).toBeGreaterThan(refused.at);
      expect(second.failed).toBe(late);
      expect(states.length).toBeGreaterThan(15);
      expect(new Set(states)).toStrictEqual(
        new Set(["needs-person, counted: confirm this device"]),
      );
      // Refused worth retrying, the second edit is counted beside the refused one; refused for good, not.
      expect(bob.sendStatus.failures).toBe(late === "unavailable" ? 2 : 1);
      // The hold for the person ends after the longest back-off; while the retry it lets go is under way,
      // the failure shown is still the one that waits for the person, with its words.
      await vi.advanceTimersByTimeAsync(9 * MINUTE);
      for (
        let second = 0;
        second < (3 * MINUTE) / 1_000 && !log.some((s) => s.kind === "edit" && s.nth === 4);
        second++
      ) {
        await run(1_000, [alice, bob]);
      }
      const retry = log.find((s) => s.kind === "edit" && s.nth === 4) as {
        at: number;
        endedAt?: number;
      };
      expect(retry.endedAt).toBeUndefined();
      expect(`${bob.sendStatus.state}: ${bob.sendStatus.lastError}`).toBe(
        "needs-person: confirm this device",
      );
    });
  }

  it("an edit under way as another is refused as needs-person, refused as needs-person too after the refusal: sending is shown as waiting for the person, with the later refusal's words (TRN-20)", {
    timeout: 60_000,
  }, async () => {
    const { port, alice, bob } = await pair();
    const log = scripted(port, "bob", (kind, nth) =>
      kind !== "edit"
        ? { takes: SEND_MS }
        : nth === 3
          ? { takes: 0, fails: new TransportSendError("needs-person", "confirm this device") }
          : nth === 2
            ? { takes: SEND_MS, fails: new TransportSendError("needs-person", "sign in again") }
            : { takes: SEND_MS },
    );
    for (let second = 0; second < 15; second++) {
      bob.edit((fragment) => insertPlainText(fragment, 0, "x"));
      await run(1_000, [alice, bob]);
    }
    const refusals = log
      .filter((s) => s.failed === "needs-person")
      .sort((a, b) => (a.endedAt as number) - (b.endedAt as number));
    expect(refusals.map((s) => s.nth)).toStrictEqual([3, 2]);
    expect(bob.sendStatus).toMatchObject({ state: "needs-person", lastError: "sign in again" });
  });

  it("a decision under way as an edit is refused as needs-person, refused for good after the refusal: sending is still shown as waiting for the person (TRN-20)", {
    timeout: 60_000,
  }, async () => {
    const { port, alice, bob } = await pair();
    // The decision takes 10 s and is refused as it ends; the edit after it is refused at once.
    const log = scripted(port, "alice", (kind) =>
      kind === "control"
        ? { takes: 10_000, fails: new TransportSendError("rejected", "not this one") }
        : kind === "edit"
          ? { takes: 0, fails: new TransportSendError("needs-person", "confirm this device") }
          : { takes: SEND_MS },
    );
    alice.setMembership("carol", "write").catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    await run(2_000, [alice, bob]);
    alice.edit((fragment) => insertPlainText(fragment, 0, "a"));
    await run(20_000, [alice, bob]);
    const refused = log.find((s) => s.failed === "needs-person") as { at: number };
    const decision = log.find((s) => s.kind === "control") as {
      at: number;
      endedAt: number;
      failed: string;
    };
    expect(decision.at).toBeLessThan(refused.at);
    expect(decision.endedAt).toBeGreaterThan(refused.at);
    expect(decision.failed).toBe("rejected");
    expect(alice.sendStatus).toMatchObject({
      state: "needs-person",
      failures: 1,
      lastError: "confirm this device",
    });
  });
});

describe("a streak no kept change is left for ends (SND-10, SND-11)", () => {
  for (const answerRefused of [true, false]) {
    it(`the retry of the last kept edit, under way as ${answerRefused ? "an answer is refused as unavailable" : "nothing else is refused"}, goes through after that: idle, and the report owed goes 10 s later`, {
      timeout: 60_000,
    }, async () => {
      const { port, alice, bob } = await pair();
      // Bob's edit is refused at once as unavailable; its retry takes 90 s and goes through; his answer to
      // Alice's request is refused as unavailable as it goes, while the retry is under way.
      const log = scripted(port, "bob", (kind, nth) =>
        kind === "edit"
          ? nth === 1
            ? { takes: 0, fails: new TransportSendError("unavailable", "net down") }
            : { takes: 90_000 }
          : kind === "resync-response" && nth === 1 && answerRefused
            ? { takes: 0, fails: new TransportSendError("unavailable", "net down (answer)") }
            : { takes: 0 },
      );
      bob.edit((fragment) => insertPlainText(fragment, 0, "a"));
      await run(3_000, [alice, bob]);
      void alice.requestResync().catch(() => {});
      await run(10 * MINUTE, [alice, bob]);
      const retry = log.find((s) => s.kind === "edit" && s.nth === 2) as {
        at: number;
        endedAt: number;
      };
      expect(retry.endedAt).toBeDefined();
      const answer = log.find((s) => s.kind === "resync-response") as {
        at: number;
        failed?: string;
      };
      expect(answer).toBeDefined();
      if (answerRefused) {
        // The answer was refused while the retry was under way.
        expect(answer.failed).toBe("unavailable");
        expect(answer.at).toBeGreaterThan(retry.at);
        expect(answer.at).toBeLessThan(retry.endedAt);
      }
      expect(bob.sendStatus).toMatchObject({
        state: "idle",
        failures: 0,
        lastError: null,
        reportOwed: false,
      });
      const reports = log.filter((s) => s.kind === "heartbeat").map((s) => s.at - retry.endedAt);
      expect(reports.filter((after) => after > 0).slice(0, 1)).toStrictEqual([10_000]);
      expect(getPlainText(alice.fragment)).toBe("aPlan");
    });
  }
});
