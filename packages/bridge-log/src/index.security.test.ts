import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger, isLogLevel, type LogRecord, loggerFromEnv } from "./index.ts";

function capture(options: Partial<Parameters<typeof createLogger>[0]> = {}) {
  const lines: string[] = [];
  const records: LogRecord[] = [];
  let time = Date.UTC(2026, 8, 20, 5, 0, 0);
  const logger = createLogger({
    component: "test-bridge",
    sink: (line, record) => {
      lines.push(line);
      records.push(record);
    },
    now: () => new Date(time),
    ...options,
  });
  return {
    logger,
    lines,
    records,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe("createLogger", () => {
  it("writes one JSON object per line with the fixed keys and the caller's fields", () => {
    const { logger, lines } = capture();
    logger.warn("control-message-rejected", { documentId: "doc-1", kind: "archived" });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual({
      time: "2026-09-20T05:00:00.000Z",
      level: "warn",
      component: "test-bridge",
      event: "control-message-rejected",
      documentId: "doc-1",
      kind: "archived",
    });
  });

  it("drops records below the configured level", () => {
    const { logger, records } = capture({ level: "warn" });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(records.map((r) => r.level)).toEqual(["warn", "error"]);
  });

  it("lets a child logger add fields to every record without changing its parent", () => {
    const { logger, records } = capture();
    const child = logger.child({ documentId: "doc-1" });
    child.info("a", { x: 1 });
    logger.info("b");
    expect(records[0]?.fields).toEqual({ documentId: "doc-1", x: 1 });
    expect(records[1]?.fields).toEqual({});
  });

  it("never lets a caller field overwrite the time, level, component or event", () => {
    const { logger, lines } = capture();
    logger.info("real-event", { time: "1970", level: "debug", component: "evil", event: "fake" });
    const parsed = JSON.parse(lines[0] as string);
    expect(parsed).toMatchObject({
      time: "2026-09-20T05:00:00.000Z",
      level: "info",
      component: "test-bridge",
      event: "real-event",
      time_: "1970",
      level_: "debug",
      component_: "evil",
      event_: "fake",
    });
  });

  describe("field values are untrusted", () => {
    it("cannot start a fake line in JSON, whatever newlines a forged sender contains", () => {
      const { logger, lines } = capture();
      logger.warn("x", { sender: 'mallory@example.org"\n{"level":"info","event":"all-clear"}' });
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain("\n");
      expect(JSON.parse(lines[0] as string).event).toBe("x");
    });

    it("cannot start a fake line in the text format either", () => {
      const { logger, lines } = capture({ format: "text" });
      logger.warn("x", { sender: "mallory\n2026-09-20T05:00:01.000Z INFO test-bridge all-clear" });
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain("\n");
      expect(lines[0]).toContain('sender="mallory\\n2026-09-20T05:00:01.000Z INFO');
    });

    it("leaves plain identifiers unquoted in the text format", () => {
      const { logger, lines } = capture({ format: "text" });
      logger.info("listening", { port: 8789, address: "alice@example.org" });
      expect(lines[0]).toBe(
        "2026-09-20T05:00:00.000Z INFO test-bridge listening port=8789 address=alice@example.org",
      );
    });

    it("cuts an attacker-sized string instead of writing it", () => {
      const { logger, lines } = capture({ maxFieldLength: 20 });
      logger.warn("x", { sender: "a".repeat(1_000_000) });
      expect(lines[0]?.length).toBeLessThan(200);
      expect(JSON.parse(lines[0] as string).sender).toBe(`${"a".repeat(20)}…(+999980 chars)`);
    });

    it("reduces an error to its name and message, and keeps the stack only at debug level", () => {
      const error = new Error("boom");
      const info = capture();
      info.logger.error("failed", { error });
      expect(info.records[0]?.fields.error).toEqual({ name: "Error", message: "boom" });
      const debug = capture({ level: "debug" });
      debug.logger.error("failed", { error });
      const logged = debug.records[0]?.fields.error as { stack?: string } | undefined;
      expect(logged?.stack).toContain("Error: boom");
    });

    it("survives values JSON cannot represent", () => {
      const { logger, lines } = capture();
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      logger.info("x", { big: 10n, fn: () => 1, circular, sym: Symbol("s") });
      const parsed = JSON.parse(lines[0] as string);
      expect(parsed.big).toBe("10");
      expect(parsed.fn).toBe("[function]");
      expect(parsed.sym).toBe("[symbol]");
      expect(typeof parsed.circular).toBe("object");
    });
  });

  describe("secrets", () => {
    it("redacts by field name, at the top level and nested", () => {
      const { logger, records } = capture();
      logger.info("x", {
        password: "hunter2",
        accessToken: "abc",
        nested: { Authorization: "Bearer x", ok: "visible" },
        passphrase: "p",
        privateKey: "k",
        documentId: "doc-1",
      });
      expect(records[0]?.fields).toEqual({
        password: "[redacted]",
        accessToken: "[redacted]",
        nested: { Authorization: "[redacted]", ok: "visible" },
        passphrase: "[redacted]",
        privateKey: "[redacted]",
        documentId: "doc-1",
      });
    });
  });

  describe("rate limiting", () => {
    it("limits warn and error per event, then says how many it dropped", () => {
      const { logger, records, advance } = capture({
        rateLimit: { maxPerWindow: 3, windowMs: 1000 },
      });
      for (let i = 0; i < 10; i++) {
        logger.warn("flood", { i });
      }
      expect(records.filter((r) => r.event === "flood")).toHaveLength(3);
      expect(records.some((r) => r.event === "log-suppressed")).toBe(false);

      advance(1500);
      logger.warn("flood", { i: 99 });
      const summary = records.find((r) => r.event === "log-suppressed");
      expect(summary?.fields).toEqual({
        suppressedEvent: "flood",
        suppressedLevel: "warn",
        suppressed: 7,
      });
      expect(records.filter((r) => r.event === "flood")).toHaveLength(4); // the new window started fresh
    });

    it("counts each event name separately, so one noisy event cannot silence another", () => {
      const { logger, records } = capture({ rateLimit: { maxPerWindow: 1, windowMs: 1000 } });
      logger.warn("a");
      logger.warn("a");
      logger.warn("b");
      expect(records.map((r) => r.event)).toEqual(["a", "b"]);
    });

    it("does not limit info or debug", () => {
      const { logger, records } = capture({
        level: "debug",
        rateLimit: { maxPerWindow: 1, windowMs: 1000 },
      });
      for (let i = 0; i < 5; i++) {
        logger.info("startup");
        logger.debug("detail");
      }
      expect(records).toHaveLength(10);
    });

    it("can be switched off", () => {
      const { logger, records } = capture({ rateLimit: false });
      for (let i = 0; i < 100; i++) {
        logger.warn("x");
      }
      expect(records).toHaveLength(100);
    });
  });

  it("never throws into the caller when the sink does", () => {
    const logger = createLogger({
      component: "c",
      sink: () => {
        throw new Error("stderr closed");
      },
    });
    expect(() => logger.error("x")).not.toThrow();
  });

  describe("log file", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "bridge-log-test-"));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("appends every line, and creates the file readable by its owner only", () => {
      const file = join(dir, "bridge.log");
      const { logger } = capture({ logFile: file });
      logger.warn("a", { documentId: "doc-1" });
      logger.info("b");
      const lines = readFileSync(file, "utf8").trim().split("\n");
      expect(lines.map((l) => JSON.parse(l).event)).toEqual(["a", "b"]);
      if (process.platform !== "win32") {
        expect(statSync(file).mode & 0o777).toBe(0o600);
      }
    });

    it("keeps logging to the sink, and does not throw, when the file cannot be written", () => {
      const { logger, lines } = capture({ logFile: join(dir, "no-such-dir", "bridge.log") });
      expect(() => logger.warn("a")).not.toThrow();
      expect(() => logger.warn("b")).not.toThrow();
      expect(lines).toHaveLength(2);
    });
  });
});

describe("loggerFromEnv", () => {
  function fromEnv(env: Record<string, string>) {
    const lines: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const logger = loggerFromEnv("env-bridge", env);
      logger.info("hello");
      logger.debug("hidden");
    } finally {
      process.stderr.write = original;
    }
    return lines;
  }

  it("defaults to info, JSON when stderr is not a terminal", () => {
    const lines = fromEnv({});
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "").event).toBe("hello");
  });

  it("honours LOG_LEVEL and LOG_FORMAT", () => {
    const lines = fromEnv({ LOG_LEVEL: "debug", LOG_FORMAT: "text" });
    expect(lines.map((l) => l.trim().split(" ")[3])).toEqual(["hello", "hidden"]);
  });

  it("reports a bad value once and starts anyway with the default", () => {
    const lines = fromEnv({ LOG_LEVEL: "verbose", LOG_FORMAT: "xml" });
    const events = lines.map((l) => JSON.parse(l).event);
    expect(events).toEqual(["invalid-log-configuration", "invalid-log-configuration", "hello"]);
  });
});

describe("isLogLevel", () => {
  it("accepts exactly the four levels", () => {
    expect(["debug", "info", "warn", "error"].every(isLogLevel)).toBe(true);
    expect(isLogLevel("verbose")).toBe(false);
    expect(isLogLevel(undefined)).toBe(false);
    expect(isLogLevel("toString")).toBe(false);
  });
});
