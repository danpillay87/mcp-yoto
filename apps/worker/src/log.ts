/**
 * Structured, token-redacting logging for the Worker.
 *
 * Rule for this whole app: nothing calls `console.*` directly. Every log goes
 * through `logEvent`, which (a) refuses secret-shaped FIELD NAMES and (b)
 * scrubs secret-shaped VALUES. Two independent gates, because either one alone
 * is one careless edit away from leaking a parent's Yoto token into Workers
 * Logs. `test/logging.test.ts` scans this directory's source and fails if a
 * bare `console.` call reappears.
 */
import type { Env, LogLevel } from "./config.js";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Field names that may never carry a value into a log line. */
const SECRET_NAME = /(token|secret|credential|password|verifier|code|assertion|authorization|jwt)/i;

/**
 * Value shapes that look like a credential:
 *  - a JWT (three base64url segments, or anything starting `eyJ`)
 *  - our own opaque tokens (`userId:grantId:random`)
 *  - any long unbroken base64url run
 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /eyJ[A-Za-z0-9_-]{4,}/g,
  /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /[A-Za-z0-9_-]{6,}:[A-Za-z0-9_-]{6,}:[A-Za-z0-9_-]{6,}/g,
  /[A-Za-z0-9_-]{28,}/g,
];

export const REDACTED = "[redacted]";

/** Replaces credential-shaped substrings. Exported for tests. */
export function scrub(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/** Only scalars are loggable; objects would smuggle props in wholesale. */
export type LogField = string | number | boolean | null | undefined;

function safeValue(name: string, value: LogField): LogField {
  if (value === undefined || value === null) return value;
  if (SECRET_NAME.test(name)) return REDACTED;
  if (typeof value === "string") return scrub(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  // Anything non-scalar is refused outright. `LogField` already forbids it at
  // compile time, but an object is exactly how a whole props bag would leak
  // past the field-name and value-shape gates, so the runtime refuses too.
  return REDACTED;
}

export interface Logger {
  debug(event: string, fields?: Record<string, LogField>): void;
  info(event: string, fields?: Record<string, LogField>): void;
  warn(event: string, fields?: Record<string, LogField>): void;
  error(event: string, fields?: Record<string, LogField>): void;
}

function emit(
  minLevel: LogLevel,
  level: LogLevel,
  event: string,
  fields: Record<string, LogField> | undefined,
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

  const line: Record<string, LogField> = { level, event: scrub(event) };
  if (fields) {
    for (const [name, value] of Object.entries(fields)) {
      line[name] = safeValue(name, value);
    }
  }

  const serialised = JSON.stringify(line);
  if (level === "error") {
    console.error(serialised);
  } else if (level === "warn") {
    console.warn(serialised);
  } else {
    console.log(serialised);
  }
}

/**
 * Builds a logger at the configured level. Reads LOG_LEVEL defensively: logging
 * must keep working even when the rest of the configuration is invalid, since
 * that is exactly when we need to see the failure.
 */
export function createLogger(env: Pick<Env, "LOG_LEVEL">): Logger {
  const raw = env.LOG_LEVEL;
  const minLevel: LogLevel =
    raw === "debug" || raw === "info" || raw === "warn" || raw === "error" ? raw : "info";

  return {
    debug: (event, fields) => emit(minLevel, "debug", event, fields),
    info: (event, fields) => emit(minLevel, "info", event, fields),
    warn: (event, fields) => emit(minLevel, "warn", event, fields),
    error: (event, fields) => emit(minLevel, "error", event, fields),
  };
}
