/**
 * A minimal, token-redacting logger with no node:* imports -- safe to use
 * from packages/core in either the Cloudflare Worker or the Node CLI.
 *
 * Redaction is deliberately aggressive: anything JWT-shaped (`eyJ...`) or a
 * long bearer-shaped token is replaced before it reaches whatever sink the
 * caller provides. The verification step in the plan greps real traffic
 * logs for `eyJ|ey[A-Za-z0-9_-]{20,}|refresh` and expects zero hits -- this
 * is the mechanism that keeps that grep clean.
 *
 * `createLogger()`'s sink defaults to a no-op: packages/core never writes to
 * stdout/stderr/console on its own (stdout on the CLI's stdio transport is
 * reserved for JSON-RPC frames only). The CLI injects a stderr sink and the
 * Worker injects a `console`/Workers-Logs sink at startup.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const TOKEN_PATTERN = /eyJ[a-zA-Z0-9_-]{10,}(?:\.[a-zA-Z0-9_-]{10,}){0,2}|[a-zA-Z0-9_-]{32,}/g;

export function redact(input: string): string {
  return input.replace(TOKEN_PATTERN, "[redacted]");
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  return JSON.parse(redact(JSON.stringify(value)));
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export type LogSink = (line: {
  level: LogLevel;
  message: string;
  data?: Record<string, unknown>;
}) => void;

export interface CreateLoggerOptions {
  /** Minimum level that reaches the sink. Default "info". */
  level?: LogLevel;
  /** Where a redacted line goes. Default a no-op (nothing is written). */
  sink?: LogSink;
}

const NOOP_SINK: LogSink = () => {};

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const minLevel = options.level ?? "info";
  const sink = options.sink ?? NOOP_SINK;

  function write(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    const safeMessage = redact(message);
    const safeData =
      data === undefined ? undefined : (redactValue(data) as Record<string, unknown>);
    sink({ level, message: safeMessage, data: safeData });
  }

  return {
    debug: (message, data) => write("debug", message, data),
    info: (message, data) => write("info", message, data),
    warn: (message, data) => write("warn", message, data),
    error: (message, data) => write("error", message, data),
  };
}

/** A logger that discards everything -- the default handed to code in tests. */
export const noopLogger: Logger = createLogger({ sink: NOOP_SINK });
