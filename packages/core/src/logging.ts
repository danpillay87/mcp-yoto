/**
 * A minimal, token-redacting logger with no node:* imports — safe to use
 * from packages/core in either the Cloudflare Worker or the Node CLI.
 *
 * Redaction is deliberately aggressive: anything JWT-shaped (`eyJ...`) or a
 * long bearer-shaped token is replaced before it reaches console output,
 * stdout, or Workers Logs. The verification step in the plan greps real
 * traffic logs for `eyJ|ey[A-Za-z0-9_-]{20,}|refresh` and expects zero hits
 * — this is the mechanism that keeps that grep clean.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const TOKEN_PATTERN = /eyJ[a-zA-Z0-9_-]{10,}(?:\.[a-zA-Z0-9_-]{10,}){0,2}|[a-zA-Z0-9_-]{32,}/g;

export function redact(input: string): string {
  return input.replace(TOKEN_PATTERN, "[redacted]");
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

function write(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  const safeMessage = redact(message);
  const safeData: unknown =
    data === undefined ? undefined : JSON.parse(redact(JSON.stringify(data)));
  const line =
    safeData === undefined
      ? { level, message: safeMessage }
      : { level, message: safeMessage, data: safeData };
  // console.error, not console.log: on the CLI's stdio transport, stdout is
  // reserved for JSON-RPC frames only (see the plan's stdout-purity test).
  console.error(JSON.stringify(line));
}

export const logger: Logger = {
  debug: (message, data) => write("debug", message, data),
  info: (message, data) => write("info", message, data),
  warn: (message, data) => write("warn", message, data),
  error: (message, data) => write("error", message, data),
};
