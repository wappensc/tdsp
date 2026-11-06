import { readFileSync } from "node:fs";
import {
  type Delivery,
  type DeliveryId,
  type DocumentId,
  type MemberId,
  type MessengerPort,
  type TransportProfile,
  TransportSendError,
} from "@tdsp/messenger-port";
import {
  applyUpdate,
  createDocument,
  deletePlainText,
  encodeStateVector,
  encodeUpdate,
  encodeUpdateSince,
  getFragment,
  getPlainText,
  insertPlainText,
} from "@tdsp/reconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnswerTurn, AnswerTurnInput } from "./answer-turn";
import type { Clock } from "./clock";
import { base64ToBytes, CURRENT_FRAME_VERSION } from "./framing";
import { DocumentEngine, type OwedReport, type PersistedControlState } from "./index";
import type { LossDetectorOptions } from "./loss-detector";
import type { Register } from "./registers";

/**
 * The published flow vectors (test-vectors/flows-v2.json), driven through the reference engine:
 * several devices, each an engine, on a channel whose deliveries the vector controls, under a clock
 * the vector advances (SPECIFICATION.md §3.6). What the file's `format` says is what this runner
 * does; a vector that fails here is a wrong vector or an engine bug.
 */

// Each member's delay before its turn (RSY-20), fixed by the vector as a test configuration: the
// engine derives it from the request's id and its own stream, which a vector cannot know beforehand.
const delays = vi.hoisted(() => ({ byMember: new Map<string, number>() }));
// Each device's slot for a gap's first try (LOS-6), fixed the same way: the detector derives it from
// the gap and its engine's stream. The slot of the device being started is bound to the stream of the
// detector its engine makes; `answerTurn` calls the module's own `answerDelayMs`, which stays derived.
const slots = vi.hoisted(() => ({
  starting: undefined as number | undefined,
  byStream: new Map<() => string, number>(),
}));
vi.mock("./answer-turn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./answer-turn")>();
  return {
    ...actual,
    answerTurn: (input: AnswerTurnInput): AnswerTurn => {
      const turn = actual.answerTurn(input);
      const delay = delays.byMember.get(input.self);
      return turn.kind === "turn" && delay !== undefined
        ? { kind: "turn", at: input.heardAt + delay }
        : turn;
    },
    answerDelayMs: (key: string, stream: string, windowMs: number): number => {
      for (const [streamOf, slot] of slots.byStream) if (streamOf() === stream) return slot;
      return actual.answerDelayMs(key, stream, windowMs);
    },
  };
});
vi.mock("./loss-detector", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./loss-detector")>();
  class LossDetector extends actual.LossDetector {
    constructor(options: LossDetectorOptions) {
      super(options);
      if (slots.starting !== undefined) slots.byStream.set(options.stream, slots.starting);
    }
  }
  return { ...actual, LossDetector };
});

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Step = Record<string, Json>;

interface DeviceSpec {
  readonly member: MemberId;
  readonly answerDelayMs?: number;
  readonly firstTrySlotMs?: number;
}

interface Flow {
  readonly name: string;
  readonly group: number;
  readonly requirements: readonly string[];
  readonly prelude?: string;
  readonly cursor?: boolean;
  readonly maxBytes?: number;
  readonly devices?: Readonly<Record<string, DeviceSpec>>;
  readonly steps: readonly Step[];
}

interface FlowFile {
  readonly format: { readonly version: number };
  readonly version: string;
  readonly profile: string;
  readonly documentId: DocumentId;
  readonly creator: MemberId;
  readonly start: number;
  readonly config: {
    readonly pollMs: number;
    readonly pacing: TransportProfile["pacing"];
    readonly quietMs: number;
    readonly answerThrottleMs: number;
    readonly transportKeepsMs: number;
  };
  readonly preludes: Readonly<
    Record<string, { devices: Record<string, DeviceSpec>; steps: Step[] }>
  >;
  readonly flows: readonly Flow[];
}

const file = JSON.parse(
  readFileSync(new URL("../test-vectors/flows-v2.json", import.meta.url), "utf8"),
) as FlowFile;

/** A text as a vector writes it: as it is, or `{"repeat": text, "times": n}`, that text n times over. */
type Text = string | { readonly repeat: string; readonly times: number };

function isRepeat(value: Json | undefined): value is { repeat: string; times: number } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.repeat === "string"
  );
}

function textOf(value: Text): string {
  return typeof value === "string" ? value : value.repeat.repeat(value.times);
}

/**
 * A text seen, against a repeat expected: the repeat itself where they are equal, so that the
 * comparison shows it as the vector writes it, and where they are not, where they part — not
 * megabytes of either.
 */
function seenAgainst(seen: string, want: { repeat: string; times: number }): Json {
  const expected = textOf(want);
  if (seen === expected) return want;
  let at = 0;
  while (at < seen.length && seen[at] === expected[at]) at += 1;
  return `(${seen.length} code units, not the ${expected.length} of the repeat: they part at ${at})`;
}

/** The UTF-8 bytes of each frame a device sent where the flow has `maxBytes`, which `$pieces` bounds. */
const bytesOf = new WeakMap<object, number>();

/** One message on the channel: who sent it, from which device, and for whom it is lost. */
interface Entry {
  readonly id: DeliveryId;
  readonly sender: MemberId;
  readonly device: string | undefined;
  readonly payload: string;
  /** Its place on the channel: what a device that started later never sees. */
  readonly at: number;
  readonly lostFor: ReadonlySet<string>;
}

/** The next frame of `kind` from device `from` reaches nobody of `for` — only a last piece, if so. */
interface Loss {
  readonly from: string;
  readonly kind: string;
  readonly lastPiece: boolean;
  readonly for: ReadonlySet<string> | "everyone";
}

class Channel {
  readonly entries: Entry[] = [];
  readonly losses: Loss[] = [];
  #next = 0;

  put(
    sender: MemberId,
    device: string | undefined,
    payload: string,
    everyone: readonly string[],
  ): DeliveryId {
    const frame = JSON.parse(payload) as { kind: string; pieces?: number | null };
    const index = this.losses.findIndex(
      (loss) =>
        loss.from === device &&
        loss.kind === frame.kind &&
        (!loss.lastPiece || (frame.pieces !== undefined && frame.pieces !== null)),
    );
    let lostFor = new Set<string>();
    if (index >= 0) {
      const loss = this.losses.splice(index, 1)[0] as Loss;
      lostFor = new Set(loss.for === "everyone" ? everyone : loss.for);
    }
    this.#next += 1;
    const id = `d${this.#next}`;
    this.entries.push({ id, sender, device, payload, at: this.entries.length, lostFor });
    return id;
  }
}

/** A persisted state as a vector writes it: a device of the creator's (CTL-26) or a member's (CTL-39). */
interface PersistedSpec {
  readonly device?: string;
  readonly clock?: Clock;
  readonly bootstrapped?: boolean;
  readonly closed: boolean;
  readonly targets: Json;
}

/** One device: an engine of `member`, its port onto the channel, and what its application persisted. */
class Device {
  engine: DocumentEngine | undefined;
  online = true;
  /** When its running engine started: the transport shows a new engine nothing sent before. */
  since = 0;
  /** The cursor its application persisted with its content (LIF-8), where the flow offers one. */
  cursor: DeliveryId | undefined;
  readonly sent: Record<string, Json>[] = [];
  checked = 0;
  persisted: PersistedControlState | undefined;
  content: Uint8Array | undefined;
  /** The report its engine owed when its application last kept the content (SND-28), on this device only. */
  owedReport: OwedReport | undefined;
  /**
   * When its last read that reached the messenger began (LIF-8), what a restart and `online` tell its
   * engine; unknown before its first engine in the flow, which starts from state its application read
   * just before.
   */
  readAt: number | undefined;

  constructor(
    readonly name: string,
    readonly spec: DeviceSpec,
    readonly run: Run,
  ) {}

  port(): MessengerPort {
    const run = this.run;
    const eligible = (entry: Entry) => entry.device !== this.name && !entry.lostFor.has(this.name);
    const port: MessengerPort = {
      createDocument: async () => {},
      transportProfile: async () => ({
        bounds: { minIntervalMs: null, maxBytes: run.maxBytes },
        pacing: file.config.pacing,
      }),
      listChannels: async () => [],
      send: async (_documentId, sender, payload) => {
        if (!this.online) {
          throw new TransportSendError("unavailable", `${this.name} is offline`);
        }
        const bytes = run.maxBytes === null ? undefined : new TextEncoder().encode(payload).length;
        if (run.maxBytes !== null && (bytes as number) > run.maxBytes) {
          throw new TransportSendError("too-large", `${this.name}: over ${run.maxBytes} bytes`);
        }
        const sent = JSON.parse(payload) as Record<string, Json>;
        if (bytes !== undefined) bytesOf.set(sent, bytes);
        this.sent.push(sent);
        if (process.env.FLOWS_TRACE !== undefined) trace(this.name, payload);
        return run.channel.put(sender, this.name, payload, [...run.devices.keys()]);
      },
      receive: async (documentId): Promise<readonly Delivery[]> =>
        run.channel.entries
          .filter((entry) => eligible(entry) && entry.at >= this.since)
          .map((entry) => ({
            id: entry.id,
            documentId,
            sender: entry.sender,
            payload: entry.payload,
          })),
    };
    if (run.cursor) {
      // A transport that keeps every message and reads on from a cursor (TRN-18): from a cursor it
      // issued, what came after it; without one, what came since the engine started.
      port.receiveSince = async (documentId, _member, after) => {
        const from =
          after === undefined ? -1 : run.channel.entries.findIndex((entry) => entry.id === after);
        const entries =
          after === undefined
            ? run.channel.entries.filter((entry) => entry.at >= this.since)
            : run.channel.entries.slice(from + 1);
        return {
          truncated: after !== undefined && from < 0,
          deliveries: entries.filter(eligible).map((entry) => ({
            id: entry.id,
            documentId,
            sender: entry.sender,
            payload: entry.payload,
          })),
        };
      };
    }
    return port;
  }

  options(restore?: {
    controlState?: PersistedControlState;
    content?: Uint8Array;
    returning?: boolean;
  }) {
    const lastRead = this.readAt ?? Date.now();
    const readAt =
      restore?.returning === true
        ? Math.min(lastRead, Date.now() - file.config.transportKeepsMs - 1)
        : lastRead;
    return {
      batchWindowMs: file.config.quietMs,
      resyncResponseThrottleMs: file.config.answerThrottleMs,
      creatorMemberId: file.creator,
      transportRetentionMs: file.config.transportKeepsMs,
      onControlStateChange: (state: PersistedControlState) => {
        this.persisted = state;
      },
      ...(restore?.controlState !== undefined ? { controlState: restore.controlState } : {}),
      ...(restore?.content !== undefined
        ? {
            restore: {
              state: restore.content,
              readAt,
              ...(this.cursor !== undefined ? { cursor: this.cursor } : {}),
              ...(this.owedReport !== undefined ? { owedReport: this.owedReport } : {}),
            },
          }
        : {}),
    };
  }

  get running(): DocumentEngine {
    if (this.engine === undefined) throw new Error(`${this.name} is not running`);
    return this.engine;
  }

  /**
   * What its application keeps of the content, with the cursor read so far (LIF-8, CTL-40) and the
   * report its engine owes, if any (SND-28).
   */
  keep(): void {
    if (this.engine === undefined) return;
    this.content = encodeUpdate(this.engine.document);
    this.cursor = this.engine.cursor;
    this.owedReport = this.engine.owedReport;
  }
}

class Run {
  readonly channel = new Channel();
  readonly devices = new Map<string, Device>();
  constructor(
    readonly cursor: boolean,
    readonly maxBytes: number | null,
  ) {}

  device(name: string): Device {
    const device = this.devices.get(name);
    if (device === undefined) throw new Error(`no device ${name}`);
    return device;
  }

  /** `"$request:bob"` is bob's latest request id, `"$request:bob#1"` its first. */
  resolve(value: Json): Json {
    if (typeof value === "string") {
      const match = /^\$request:([^#]+)(?:#(\d+))?$/.exec(value);
      if (match === null) return value;
      const ids = this.device(match[1] as string)
        .sent.filter((frame) => frame.kind === "resync-request")
        .map((frame) => frame.requestId as string);
      const id = match[2] === undefined ? ids.at(-1) : ids[Number(match[2]) - 1];
      if (id === undefined) throw new Error(`${value}: no such request`);
      return id;
    }
    if (Array.isArray(value)) return value.map((item) => this.resolve(item));
    if (value !== null && typeof value === "object") {
      const out: Record<string, Json> = {};
      for (const [key, item] of Object.entries(value)) {
        if (key === "$targets") Object.assign(out, expandTargets(item as unknown as TargetRun));
        else out[key] = this.resolve(item);
      }
      return out;
    }
    return value;
  }

  /** One poll interval: the clock moves on, then every online device in order reads and runs. */
  async tick(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    for (const device of this.devices.values()) {
      if (device.engine !== undefined && device.online) {
        device.readAt = Date.now();
        await device.engine.sync();
        await vi.advanceTimersByTimeAsync(0);
        device.keep();
      }
    }
  }

  async wait(ms: number): Promise<void> {
    const poll = file.config.pollMs;
    for (let passed = 0; passed < ms; passed += poll) {
      await this.tick(Math.min(poll, ms - passed));
    }
  }

  async start(
    name: string,
    how: "create" | "join",
    restore?: { controlState?: PersistedControlState; content?: Uint8Array; returning?: boolean },
  ): Promise<void> {
    const device = this.device(name);
    device.since = this.channel.entries.length;
    const options = device.options(restore);
    device.readAt = Date.now();
    slots.starting = device.spec.firstTrySlotMs;
    try {
      device.engine =
        how === "create"
          ? await DocumentEngine.create(
              file.documentId,
              device.spec.member,
              device.port(),
              undefined,
              options,
            )
          : await DocumentEngine.join(
              file.documentId,
              device.spec.member,
              device.port(),
              undefined,
              options,
            );
    } finally {
      slots.starting = undefined;
    }
    await vi.advanceTimersByTimeAsync(0);
    device.keep();
  }
}

/** `{"pattern": "member:m{n}", "from": 1, "to": 3, "register": {…}}`: targets m1, m2, m3, alike. */
interface TargetRun {
  readonly pattern: string;
  readonly from: number;
  readonly to: number;
  readonly register: Json;
}

function expandTargets(run: TargetRun): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (let n = run.from; n <= run.to; n++)
    out[run.pattern.replace("{n}", String(n))] = run.register;
  return out;
}

function persistedOf(spec: PersistedSpec, run: Run): PersistedControlState {
  return {
    tdsp: CURRENT_FRAME_VERSION,
    profile: file.profile,
    control: {
      closed: spec.closed,
      targets: run.resolve(spec.targets) as unknown as Record<string, Register>,
    },
    ...(spec.device !== undefined ? { device: spec.device } : {}),
    ...(spec.clock !== undefined ? { clock: spec.clock } : {}),
    ...(spec.bootstrapped !== undefined ? { bootstrapped: spec.bootstrapped } : {}),
  };
}

/** With FLOWS_TRACE set, every frame sent, briefly: what an author of a vector reads to write one. */
function trace(device: string, payload: string): void {
  const f = JSON.parse(payload) as Record<string, Json>;
  const brief: Record<string, Json> = { kind: f.kind ?? null };
  for (const key of [
    "requestId",
    "respondsTo",
    "all",
    "force",
    "controlClock",
    "piece",
    "pieces",
    "closed",
    "targets",
    "sequence",
  ]) {
    if (key in f) brief[key] = f[key] as Json;
  }
  // A report carries its sender's last edit again, or not (SND-27): its size says which.
  if (f.kind === "heartbeat")
    brief.update = typeof f.update === "string" ? f.update.length : "(absent)";
  if (f.control !== undefined) {
    const c = f.control as Record<string, Json> | null;
    brief.control =
      c === null ? null : { closed: c.closed ?? null, targets: Object.keys(c.targets as object) };
  }
  console.log(`${Date.now() - file.start} ${device} ${JSON.stringify(brief)}`);
}

const RIGHTS = ["write", "read", "revoked", "unknown"];

/** What a vector's `expect` names of one device, read from its engine as the format says. */
function observe(device: Device, wanted: Record<string, Json>): Record<string, Json> {
  const engine = device.running;
  const seen: Record<string, Json> = {};
  for (const key of Object.keys(wanted)) {
    switch (key) {
      case "text":
        seen.text = getPlainText(engine.fragment);
        break;
      case "bootstrapped":
        seen.bootstrapped = engine.hasCompletedBootstrap;
        break;
      case "standing":
        seen.standing = engine.controlStanding.kind;
        break;
      case "closed":
        seen.closed = engine.closed;
        break;
      case "mayEdit":
        seen.mayEdit = engine.mayEdit;
        break;
      case "conflict":
        seen.conflict = engine.capacityConflict;
        break;
      case "rights":
        seen.rights = Object.fromEntries(
          Object.keys(wanted.rights as Record<string, Json>).map((member) => {
            const right = engine.rightOf(member);
            expect(RIGHTS).toContain(right);
            return [member, right];
          }),
        );
        break;
      case "controlClock":
        seen.controlClock = [...engine.controlClock];
        break;
      case "registers": {
        const targets = engine.controlState.targets as Record<string, Register>;
        seen.registers = Object.fromEntries(
          Object.entries(wanted.registers as Record<string, Record<string, Json> | null>).map(
            ([target, want]) => {
              const held = targets[target];
              if (held === undefined) return [target, null];
              return [
                target,
                {
                  value: held.value,
                  ...(want !== null && "clock" in want ? { clock: [...held.clock] } : {}),
                  ...(want !== null && "device" in want ? { device: held.device } : {}),
                },
              ];
            },
          ),
        );
        break;
      }
      case "targetCount":
        seen.targetCount = Object.keys(engine.controlState.targets).length;
        break;
      case "evidence":
        seen.evidence = [
          ...new Set(engine.syncHealth.suspicions.map((suspicion) => suspicion.kind)),
        ].sort();
        break;
      case "resting":
        // The gaps whose tries ran out, which it asks for no more until one is woken (LOS-6, LOS-26).
        seen.resting = [
          ...new Set(
            engine.syncHealth.suspicions
              .filter((gap) => gap.resting === true)
              .map((gap) => gap.kind),
          ),
        ].sort();
        break;
      case "reportOwed":
        seen.reportOwed = engine.owedReport !== undefined;
        break;
      case "closeReason":
        seen.closeReason = engine.closeReason ?? null;
        break;
      case "transfers":
        seen.transfers = engine.syncHealth.incompleteAnswers.length;
        break;
      case "persisted": {
        const persisted = device.persisted;
        const want = wanted.persisted as Record<string, Json>;
        seen.persisted = Object.fromEntries(
          Object.keys(want).map((field) => {
            switch (field) {
              case "bootstrapped":
                // Persisted as bootstrapped (CTL-26, RSY-14): nothing persisted is not.
                return [field, persisted?.bootstrapped === true];
              case "targets":
                return [field, Object.keys(persisted?.control.targets ?? {}).sort()];
              case "closed":
                return [field, persisted?.control.closed ?? null];
              default:
                throw new Error(`unknown persisted field ${field}`);
            }
          }),
        );
        break;
      }
      default:
        throw new Error(`unknown expectation ${key}`);
    }
  }
  return seen;
}

/** A frame's fields a matcher names, each a dotted path into its JSON; `control.targets` as names. */
function fieldsOf(frame: Record<string, Json>, wanted: Record<string, Json>): Record<string, Json> {
  return Object.fromEntries(
    Object.keys(wanted).map((path) => {
      let value: Json | undefined = frame;
      for (const part of path.split(".")) {
        value =
          value !== null && typeof value === "object" && !Array.isArray(value)
            ? value[part]
            : undefined;
      }
      if (
        path.endsWith("targets") &&
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        return [path, Object.keys(value).sort()];
      }
      // "(present)" matches any value the frame has: what no vector can fix, as an update's bytes.
      if (wanted[path] === "(present)" && value !== undefined) return [path, "(present)"];
      return [path, value === undefined ? "(absent)" : value];
    }),
  );
}

/** What a `$pieces` matcher asks of one update sent in pieces. */
interface PiecesSpec {
  readonly atLeast: number;
  readonly text?: Text;
}

/**
 * The frames of one update sent in pieces, from `got[at]` on, as a `$pieces` matcher sees them (SND-17,
 * RSY-18, SND-18): the matcher itself where they hold what it asks; otherwise, in its place, what they
 * show — the first value of a field that differs from it, their number, and what else breaks the format.
 * How many there are and where the update is cut is the implementation's (Appendix A).
 */
function piecesSeen(
  got: readonly Record<string, Json>[],
  at: number,
  matcher: Record<string, Json>,
  maxBytes: number | null,
): { seen: Record<string, Json>; taken: number } {
  const { $pieces, ...fields } = matcher;
  const spec = $pieces as unknown as PiecesSpec;
  const run: Record<string, Json>[] = [];
  for (let index = at; index < got.length; index++) {
    const frame = got[index] as Record<string, Json>;
    run.push(frame);
    if (frame.pieces !== null && frame.pieces !== undefined) break; // the last piece states their number
  }
  const seen: Record<string, Json> = {};
  for (const key of Object.keys(fields)) {
    const differing = run
      .map((frame) => fieldsOf(frame, fields)[key] as Json)
      .find((value) => value !== fields[key]);
    seen[key] = differing === undefined ? (fields[key] as Json) : differing;
  }
  const broken: string[] = [];
  run.forEach((frame, index) => {
    const last = index === run.length - 1;
    if (frame.piece !== index + 1)
      broken.push(`piece ${index + 1} numbered ${JSON.stringify(frame.piece)}`);
    if (frame.pieces !== (last ? run.length : null))
      broken.push(`piece ${index + 1} states pieces ${JSON.stringify(frame.pieces)}`);
    if (!last && "control" in frame && frame.control !== null)
      broken.push(`piece ${index + 1} carries control state before the last`);
    const bytes = bytesOf.get(frame);
    if (maxBytes !== null && (bytes === undefined || bytes > maxBytes))
      broken.push(`piece ${index + 1} has ${bytes} bytes`);
  });
  const pieces: Record<string, Json> = {
    atLeast: run.length >= spec.atLeast ? spec.atLeast : `(${run.length} pieces)`,
  };
  if (spec.text !== undefined) {
    const doc = createDocument();
    for (const frame of run) applyUpdate(doc, base64ToBytes(frame.update as string) as Uint8Array);
    const text = getPlainText(getFragment(doc));
    pieces.text = isRepeat(spec.text as Json)
      ? seenAgainst(text, spec.text as { repeat: string; times: number })
      : text;
  }
  if (broken.length > 0) pieces.broken = broken;
  seen.$pieces = pieces;
  return { seen, taken: run.length };
}

/**
 * What `got` shows against the matchers of `list`, in order: each matcher the fields it names of one
 * frame, a `$pieces` matcher the frames of one update in pieces; a frame no matcher is left for shows
 * its kind. Equal to `list` where every frame matches.
 */
function framesSeen(
  got: readonly Record<string, Json>[],
  list: readonly Record<string, Json>[],
  maxBytes: number | null,
): Json[] {
  const seen: Json[] = [];
  let at = 0;
  for (const matcher of list) {
    if (at >= got.length) break;
    if ("$pieces" in matcher) {
      const { seen: pieces, taken } = piecesSeen(got, at, matcher, maxBytes);
      seen.push(pieces);
      at += taken;
    } else {
      seen.push(fieldsOf(got[at] as Record<string, Json>, matcher));
      at += 1;
    }
  }
  for (; at < got.length; at++)
    seen.push(fieldsOf(got[at] as Record<string, Json>, { kind: null }));
  return seen;
}

async function settle(promise: Promise<unknown>): Promise<"done" | "refused" | "waiting"> {
  let outcome: "done" | "refused" | "waiting" = "waiting";
  promise.then(
    () => {
      outcome = "done";
    },
    () => {
      outcome = "refused";
    },
  );
  await vi.advanceTimersByTimeAsync(0);
  return outcome;
}

async function runStep(run: Run, step: Step): Promise<void> {
  const [op] = Object.keys(step);
  const arg = step[op as string] as Json;
  switch (op) {
    case "create":
      await run.start(arg as string, "create");
      return;
    case "join": {
      const control = step.control as PersistedSpec | undefined;
      const content = step.content as string | undefined;
      await run.start(arg as string, "join", {
        ...(control !== undefined ? { controlState: persistedOf(control, run) } : {}),
        ...(content !== undefined ? { content: base64ToBytes(content) as Uint8Array } : {}),
      });
      return;
    }
    case "wait":
      await run.wait(arg as number);
      return;
    case "edit": {
      const engine = run.device(arg as string).running;
      const insert = step.insert as [number, Text] | undefined;
      const remove = step.delete as [number, number] | undefined;
      engine.edit((fragment) => {
        if (remove !== undefined) deletePlainText(fragment, remove[0], remove[1]);
        if (insert !== undefined) insertPlainText(fragment, insert[0], textOf(insert[1]));
      });
      await vi.advanceTimersByTimeAsync(0);
      return;
    }
    case "decide":
    case "close": {
      const engine = run.device(arg as string).running;
      const target = step.target as string;
      const value = step.value as "read" | "write" | null;
      const done =
        op === "close"
          ? engine.closeDocument(step.reason === undefined ? undefined : (step.reason as string))
          : target === "pace"
            ? engine.setPace(step.value as number)
            : target.startsWith("member:")
              ? engine.setMembership(target.slice("member:".length), value)
              : (() => {
                  const [, layer, member] = /^layer:(.+):member:(.+)$/.exec(
                    target,
                  ) as RegExpExecArray;
                  return engine.setLayerRight(layer as string, member as string, value);
                })();
      const outcome = await settle(done);
      // Only a refusal is the protocol's (CTL-45, CTL-37, CTL-32); when a send completes is the scheduler's.
      expect(outcome === "refused", `${op} on ${arg} refused`).toBe(step.refused === true);
      return;
    }
    case "offline":
      run.device(arg as string).online = false;
      return;
    case "online": {
      // Its application tells the running engine how long ago its last read that reached the
      // messenger began (LIF-12).
      const device = run.device(arg as string);
      device.online = true;
      device.engine?.noteAbsence(Date.now() - (device.readAt ?? Date.now()));
      await vi.advanceTimersByTimeAsync(0);
      return;
    }
    case "report": {
      // Its application tells the engine that the device is about to sleep (LIF-12): the report it
      // owes goes as soon as the floor permits (SND-11).
      const outcome = await settle(run.device(arg as string).running.reportNow());
      expect(outcome, `the report of ${arg}`).not.toBe("refused");
      return;
    }
    case "syncNow":
      // Its person asks to synchronise now (LIF-12): what waits goes, and a request to all of its
      // own, which wakes every resting gap (RSY-3, LOS-26).
      await settle(run.device(arg as string).running.flush());
      await settle(run.device(arg as string).running.requestResync());
      return;
    case "lose": {
      const rule = arg as { from: string; kind: string; for?: string[]; lastPiece?: boolean };
      run.channel.losses.push({
        from: rule.from,
        kind: rule.kind,
        lastPiece: rule.lastPiece === true,
        for: rule.for === undefined ? "everyone" : new Set(rule.for),
      });
      return;
    }
    case "inject": {
      const frame = step.frame as Json;
      const payload =
        typeof frame === "string"
          ? (run.resolve(frame) as string)
          : JSON.stringify(run.resolve(frame));
      run.channel.put(arg as MemberId, undefined, payload, []);
      return;
    }
    case "stop": {
      // The close (SND-11): what waits goes, then the report owed; what could not go stays owed.
      const device = run.device(arg as string);
      device.running.dispose();
      await vi.advanceTimersByTimeAsync(0);
      device.keep();
      device.engine = undefined;
      return;
    }
    case "restart": {
      const device = run.device(arg as string);
      if (device.engine !== undefined) {
        device.engine.dispose();
        await vi.advanceTimersByTimeAsync(0);
        device.keep();
        device.engine = undefined;
      }
      await run.start(device.name, "join", {
        ...(device.persisted !== undefined ? { controlState: device.persisted } : {}),
        ...(step.content === false || device.content === undefined
          ? {}
          : { content: device.content }),
        returning: step.returning === true,
      });
      await vi.advanceTimersByTimeAsync(0);
      return;
    }
    case "settled":
      // The prelude's end: what it sent is not the flow's.
      for (const device of run.devices.values()) device.checked = device.sent.length;
      return;
    case "clock":
      vi.setSystemTime(Date.now() + (arg as number));
      return;
    case "expect":
      for (const [name, wanted] of Object.entries(arg as Record<string, Record<string, Json>>)) {
        const want = run.resolve(wanted) as Record<string, Json>;
        const seen = observe(run.device(name), want);
        if (isRepeat(want.text)) seen.text = seenAgainst(seen.text as string, want.text);
        expect(seen, name).toStrictEqual(want);
      }
      return;
    case "sent":
      // A list: every frame the device sent since its last check, in order. An object by kind: only
      // the frames of the kinds it names, each list in order (`[]`: none of that kind).
      for (const [name, wanted] of Object.entries(arg as Record<string, Json>)) {
        const device = run.device(name);
        const frames = device.sent.slice(device.checked);
        device.checked = device.sent.length;
        // Reports are left out of a list; an object names them as `heartbeat` where it checks them.
        const lists: [string, Record<string, Json>[], Record<string, Json>[]][] = Array.isArray(
          wanted,
        )
          ? [
              [
                "all",
                frames.filter((frame) => frame.kind !== "heartbeat"),
                wanted as Record<string, Json>[],
              ],
            ]
          : Object.entries(wanted as Record<string, Json>).map(([kind, list]) => [
              kind,
              frames.filter((frame) => frame.kind === kind),
              (list as Record<string, Json>[]).map((matcher) => ({ kind, ...matcher })),
            ]);
        for (const [kind, got, list] of lists) {
          const resolved = run.resolve(list as Json) as Record<string, Json>[];
          expect(
            framesSeen(got, resolved, run.maxBytes),
            `what ${name} sent (${kind})`,
          ).toStrictEqual(resolved);
        }
      }
      return;
    default:
      throw new Error(`unknown step ${op}`);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(file.start);
  delays.byMember.clear();
  slots.byStream.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the runner's `$pieces` matcher, on frame lists made for it (SND-17, RSY-18, SND-18)", () => {
  /** "abcdef" in three updates, each building on the one before: what three pieces of an answer carry. */
  function threeUpdates(last = "ef"): string[] {
    const doc = createDocument();
    const updates: string[] = [];
    let before = encodeStateVector(doc);
    for (const [at, part] of [
      [0, "ab"],
      [2, "cd"],
      [4, last],
    ] as const) {
      insertPlainText(getFragment(doc), at, part);
      updates.push(Buffer.from(encodeUpdateSince(doc, before)).toString("base64"));
      before = encodeStateVector(doc);
    }
    return updates;
  }

  /** Three pieces of one answer, well formed, each `bytes` long on the wire; `change` alters them. */
  function pieces(
    change: (frames: Record<string, Json>[]) => void = () => {},
    bytes = 100,
  ): Record<string, Json>[] {
    const frames: Record<string, Json>[] = threeUpdates().map((update, index) => ({
      kind: "resync-response",
      respondsTo: "r1",
      piece: index + 1,
      pieces: index === 2 ? 3 : null,
      update,
      control: index === 2 ? { closed: false, targets: {} } : null,
    }));
    change(frames);
    for (const frame of frames) bytesOf.set(frame, bytes);
    return frames;
  }

  const matcher: Record<string, Json> = {
    kind: "resync-response",
    respondsTo: "r1",
    $pieces: { atLeast: 3, text: "abcdef" },
  };
  /** What the runner shows of `got` against the matcher alone. */
  const seen = (got: Record<string, Json>[], maxBytes: number | null = 1_000): Json =>
    framesSeen(got, [matcher], maxBytes)[0] as Json;

  it("three well-formed pieces match it", () => {
    expect(framesSeen(pieces(), [matcher], 1_000)).toStrictEqual([matcher]);
    expect(framesSeen(pieces(), [matcher], null)).toStrictEqual([matcher]);
  });

  it("pieces numbered other than 1, 2, 3 break it", () => {
    const got = pieces((frames) => {
      frames.forEach((frame, index) => {
        frame.piece = index + 2;
      });
    });
    expect(seen(got)).toMatchObject({
      $pieces: { broken: ["piece 1 numbered 2", "piece 2 numbered 3", "piece 3 numbered 4"] },
    });
  });

  it("a count stated before the last piece, or a wrong one in it, breaks it", () => {
    const early = pieces((frames) => ((frames[1] as Record<string, Json>).pieces = 3));
    // The piece that states a count ends the run: two pieces, the third left over.
    expect(framesSeen(early, [matcher], 1_000)).toStrictEqual([
      {
        kind: "resync-response",
        respondsTo: "r1",
        $pieces: { atLeast: "(2 pieces)", text: "abcd", broken: ["piece 2 states pieces 3"] },
      },
      { kind: "resync-response" },
    ]);
    const wrong = pieces((frames) => ((frames[2] as Record<string, Json>).pieces = 4));
    expect(seen(wrong)).toMatchObject({ $pieces: { broken: ["piece 3 states pieces 4"] } });
  });

  it("control state before the last piece breaks it", () => {
    const got = pieces(
      (frames) => ((frames[0] as Record<string, Json>).control = { closed: false, targets: {} }),
    );
    expect(seen(got)).toMatchObject({
      $pieces: { broken: ["piece 1 carries control state before the last"] },
    });
  });

  it("a piece larger than the transport's largest message breaks it, where the flow has one", () => {
    expect(seen(pieces(undefined, 1_001))).toMatchObject({
      $pieces: {
        broken: ["piece 1 has 1001 bytes", "piece 2 has 1001 bytes", "piece 3 has 1001 bytes"],
      },
    });
    expect(seen(pieces(undefined, 1_001), null)).toStrictEqual(matcher);
  });

  it("fewer pieces than it asks for at least break it", () => {
    expect(
      framesSeen(pieces(), [{ ...matcher, $pieces: { atLeast: 4, text: "abcdef" } }], 1_000),
    ).toStrictEqual([
      {
        kind: "resync-response",
        respondsTo: "r1",
        $pieces: { atLeast: "(3 pieces)", text: "abcdef" },
      },
    ]);
  });

  it("pieces that together carry another text break it", () => {
    const other = threeUpdates("eX");
    const got = pieces((frames) => {
      frames.forEach((frame, index) => {
        frame.update = other[index] as string;
      });
    });
    expect(seen(got)).toMatchObject({ $pieces: { text: "abcdeX" } });
  });

  it("a field it names that differs in any piece, not only the first, breaks it", () => {
    const got = pieces((frames) => ((frames[2] as Record<string, Json>).respondsTo = "r2"));
    expect(seen(got)).toMatchObject({ respondsTo: "r2" });
  });
});

describe("flow vectors, at version 2", () => {
  it("name the version and profile, in the format this runner reads", () => {
    expect(file.version).toBe(2);
    expect(file.profile).toBe("yjs-paragraphs/1");
    expect(file.format.version).toBe(3);
  });

  it("fix a device's first-try slot for its detector alone: its answer turn stays derived", async () => {
    // The mock above stands in for the detector's `answerDelayMs`; `answerTurn` calls the module's own
    // (RSY-20), so a fixed slot leaves a member's turn as the engine derives it.
    const mocked = await import("./answer-turn");
    const actual = await vi.importActual<typeof import("./answer-turn")>("./answer-turn");
    const stream = "AAAAAAAAAAAAAAAAAAAAAA";
    const derived = actual.answerDelayMs("request", stream, 30_000);
    slots.byStream.set(() => stream, derived + 1);
    expect(mocked.answerDelayMs("gap", stream, 30_000)).toBe(derived + 1);
    const turn = mocked.answerTurn({
      self: "zed",
      creator: "alice",
      requester: "bob",
      ownRequest: false,
      all: true,
      requestId: "request",
      stream,
      heardAt: 0,
      expectedLatencyMs: 5000,
    });
    expect(turn).toStrictEqual({ kind: "turn", at: derived });
  });

  it("hold every case group, and no fewer flows than 2.0 has", () => {
    // A flow dropped, or a group left empty, is a case lost for every other engine (§3.6).
    expect(file.flows.length).toBeGreaterThanOrEqual(28);
    expect([...new Set(file.flows.map((flow) => flow.group))].sort()).toStrictEqual([
      1, 2, 3, 4, 5,
    ]);
    for (const flow of file.flows) expect(flow.requirements.length, flow.name).toBeGreaterThan(0);
  });

  // A flow of several devices over minutes of their time, one of them megabytes in pieces, takes seconds,
  // more where suites run side by side: the default of 5 s is no bound of the engine's.
  it.each(file.flows.map((flow) => [`${flow.group}. ${flow.name}`, flow] as const))(
    "%s",
    { timeout: 60_000 },
    async (_name, flow) => {
      const prelude = flow.prelude === undefined ? undefined : file.preludes[flow.prelude];
      const run = new Run(flow.cursor === true, flow.maxBytes ?? null);
      for (const [name, spec] of Object.entries({ ...prelude?.devices, ...flow.devices })) {
        run.devices.set(name, new Device(name, spec, run));
        if (spec.answerDelayMs !== undefined) delays.byMember.set(spec.member, spec.answerDelayMs);
      }
      try {
        const steps = [...(prelude?.steps ?? []), { settled: null }, ...flow.steps];
        for (const [index, step] of steps.entries()) {
          try {
            await runStep(run, step);
          } catch (error) {
            throw new Error(
              `step ${index + 1} ${JSON.stringify(step).slice(0, 300)}: ${(error as Error).message}`,
              {
                cause: error,
              },
            );
          }
        }
      } finally {
        for (const device of run.devices.values()) device.engine?.dispose();
      }
    },
  );
});
