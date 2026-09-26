import { appendFileSync } from "node:fs";

/**
 * Structured logging for the bridge processes (`bridges/signal-bridge`,
 * `bridges/matrix-bridge`, `bridges/email-bridge`) — the one place they write
 * anything an operator or a security review might need to read later.
 *
 * Node-only and dependency-free, never imported by browser code. Every
 * record is one line: JSON by default (machine-readable, greppable, and
 * immune to log injection because `JSON.stringify` escapes every control
 * character), or `key=value` text for a human at a terminal.
 *
 * Built for what these processes log, which is largely **attacker-
 * influenced**: a rejected forged message carries a sender, a document id,
 * a reason. So:
 *
 * - **Field values are untrusted.** Strings are truncated (a forged sender
 *   of a megabyte cannot fill the disk), newlines and control characters
 *   cannot start a fake log line in either format, and errors are reduced
 *   to name and message.
 * - **Secrets are redacted by field name** (`password`, `token`, `secret`,
 *   `passphrase`, `authorization`, `credential`, `private`) — a safety net,
 *   not a licence to pass them in: callers log identifiers, never message
 *   bodies, keys or credentials.
 * - **A flood cannot become a denial of service.** A forged-mail storm
 *   would otherwise emit a line per message; `warn` and `error` are limited
 *   per event name per window, and the drop is itself logged as one summary
 *   line — so suppression is visible, never silent.
 * - **Logging never throws into the caller.** A full disk or closed stderr
 *   must not take down a bridge that is otherwise working.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Readonly<Record<string, unknown>>;

export interface LogRecord {
  readonly time: string;
  readonly level: LogLevel;
  readonly component: string;
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every record — e.g. a document id for one request's worth of lines. */
  child(fields: LogFields): Logger;
}

export interface RateLimit {
  readonly maxPerWindow: number;
  readonly windowMs: number;
}

export interface LoggerOptions {
  readonly component: string;
  /** Records below this level are dropped. Default `"info"`. */
  readonly level?: LogLevel;
  /** Default `"json"`. */
  readonly format?: "json" | "text";
  /** Where each finished line goes. Default: standard error, so standard output stays free. */
  readonly sink?: (line: string, record: LogRecord) => void;
  /** Also append every line here (created with mode 0600 — records name senders and documents). */
  readonly logFile?: string;
  /** Applies to `warn`/`error` only, per event name. Default 20 per 60 seconds; `false` disables. */
  readonly rateLimit?: RateLimit | false;
  /** Longest string kept in a field before it is cut. Default 500. */
  readonly maxFieldLength?: number;
  /** For tests. */
  readonly now?: () => Date;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const RESERVED = new Set(["time", "level", "component", "event"]);
const SECRET_KEY = /pass(word|phrase)?|secret|token|authorization|credential|private/i;
const DEFAULT_RATE_LIMIT: RateLimit = { maxPerWindow: 20, windowMs: 60_000 };
const MAX_DEPTH = 3;

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && Object.hasOwn(LEVEL_ORDER, value);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…(+${value.length - max} chars)`;
}

function sanitize(value: unknown, max: number, includeStack: boolean, depth: number): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  switch (typeof value) {
    case "string":
      return truncate(value, max);
    case "number":
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "function":
    case "symbol":
      return `[${typeof value}]`;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncate(value.message, max),
      ...(includeStack && value.stack ? { stack: truncate(value.stack, max * 4) } : {}),
    };
  }
  if (depth >= MAX_DEPTH) {
    return "[object]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitize(item, max, includeStack, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
    out[key] = SECRET_KEY.test(key) ? "[redacted]" : sanitize(inner, max, includeStack, depth + 1);
  }
  return out;
}

function textValue(value: unknown): string {
  if (typeof value === "string" && /^[A-Za-z0-9._:@/<>+#-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value) ?? "null";
}

function formatRecord(record: LogRecord, format: "json" | "text"): string {
  if (format === "json") {
    // Caller fields first so the four fixed keys can never be overwritten by them.
    return JSON.stringify({
      ...record.fields,
      time: record.time,
      level: record.level,
      component: record.component,
      event: record.event,
    });
  }
  const head = `${record.time} ${record.level.toUpperCase()} ${record.component} ${record.event}`;
  const rest = Object.entries(record.fields).map(([key, value]) => `${key}=${textValue(value)}`);
  return rest.length > 0 ? `${head} ${rest.join(" ")}` : head;
}

interface LimitState {
  windowStart: number;
  count: number;
  suppressed: number;
}

export function createLogger(options: LoggerOptions): Logger {
  const threshold = LEVEL_ORDER[options.level ?? "info"];
  const format = options.format ?? "json";
  const maxFieldLength = options.maxFieldLength ?? 500;
  const now = options.now ?? (() => new Date());
  const limit = options.rateLimit === false ? undefined : (options.rateLimit ?? DEFAULT_RATE_LIMIT);
  const limits = new Map<string, LimitState>();
  const includeStack = (options.level ?? "info") === "debug";
  let fileFailureReported = false;

  const sink =
    options.sink ??
    ((line: string) => {
      process.stderr.write(`${line}\n`);
    });

  function write(record: LogRecord): void {
    const line = formatRecord(record, format);
    try {
      sink(line, record);
    } catch {
      // Never let logging take the process down.
    }
    if (options.logFile) {
      try {
        appendFileSync(options.logFile, `${line}\n`, { mode: 0o600 });
      } catch (error) {
        if (!fileFailureReported) {
          fileFailureReported = true;
          try {
            process.stderr.write(
              `${options.component}: cannot write log file ${options.logFile}: ${error instanceof Error ? error.message : String(error)}\n`,
            );
          } catch {
            // Nothing left to try.
          }
        }
      }
    }
  }

  function emit(
    level: LogLevel,
    event: string,
    fields: LogFields | undefined,
    inherited: LogFields,
  ): void {
    if (LEVEL_ORDER[level] < threshold) {
      return;
    }
    const time = now();
    if (limit && LEVEL_ORDER[level] >= LEVEL_ORDER.warn) {
      const key = `${level}:${event}`;
      const state = limits.get(key) ?? { windowStart: time.getTime(), count: 0, suppressed: 0 };
      if (time.getTime() - state.windowStart >= limit.windowMs) {
        if (state.suppressed > 0) {
          write({
            time: time.toISOString(),
            level: "warn",
            component: options.component,
            event: "log-suppressed",
            fields: {
              suppressedEvent: event,
              suppressedLevel: level,
              suppressed: state.suppressed,
            },
          });
        }
        state.windowStart = time.getTime();
        state.count = 0;
        state.suppressed = 0;
      }
      limits.set(key, state);
      if (state.count >= limit.maxPerWindow) {
        state.suppressed += 1;
        return;
      }
      state.count += 1;
    }

    const merged: Record<string, unknown> = {};
    for (const [key, value] of Object.entries({ ...inherited, ...(fields ?? {}) })) {
      const safeKey = RESERVED.has(key) ? `${key}_` : key;
      merged[safeKey] = SECRET_KEY.test(key)
        ? "[redacted]"
        : sanitize(value, maxFieldLength, includeStack, 0);
    }
    write({
      time: time.toISOString(),
      level,
      component: options.component,
      event: truncate(String(event), 120),
      fields: merged,
    });
  }

  function build(inherited: LogFields): Logger {
    return {
      debug: (event, fields) => emit("debug", event, fields, inherited),
      info: (event, fields) => emit("info", event, fields, inherited),
      warn: (event, fields) => emit("warn", event, fields, inherited),
      error: (event, fields) => emit("error", event, fields, inherited),
      child: (fields) => build({ ...inherited, ...fields }),
    };
  }
  return build({});
}

/**
 * The logger a bridge process actually runs with, configured from its
 * environment: `LOG_LEVEL` (`debug|info|warn|error`, default `info`),
 * `LOG_FORMAT` (`json|text`; default `text` on an interactive terminal,
 * `json` otherwise) and `LOG_FILE` (also append every line to this path).
 * A bad value is reported once on standard error and the default is used —
 * a typo in `LOG_LEVEL` must not stop a bridge from starting.
 */
export function loggerFromEnv(
  component: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Logger {
  const problems: string[] = [];
  let level: LogLevel = "info";
  if (env.LOG_LEVEL !== undefined && env.LOG_LEVEL !== "") {
    if (isLogLevel(env.LOG_LEVEL)) {
      level = env.LOG_LEVEL;
    } else {
      problems.push(
        `LOG_LEVEL=${JSON.stringify(env.LOG_LEVEL)} is not one of debug|info|warn|error`,
      );
    }
  }
  let format: "json" | "text" = process.stderr.isTTY ? "text" : "json";
  if (env.LOG_FORMAT !== undefined && env.LOG_FORMAT !== "") {
    if (env.LOG_FORMAT === "json" || env.LOG_FORMAT === "text") {
      format = env.LOG_FORMAT;
    } else {
      problems.push(`LOG_FORMAT=${JSON.stringify(env.LOG_FORMAT)} is not json|text`);
    }
  }
  const logger = createLogger({
    component,
    level,
    format,
    ...(env.LOG_FILE ? { logFile: env.LOG_FILE } : {}),
  });
  for (const problem of problems) {
    logger.warn("invalid-log-configuration", { problem });
  }
  return logger;
}
