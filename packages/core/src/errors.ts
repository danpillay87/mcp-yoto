/**
 * A structured error surfaced to an MCP tool caller.
 *
 * Deliberately small in Phase 0 — the full Yoto-specific error taxonomy
 * (AUTH_EXPIRED, FORBIDDEN_SCOPE, INVALID_AUDIO, PORT_IN_USE, ...) lands in
 * Phase 1 alongside the real YotoClient, but every one of those errors will
 * be a YotoError so tool handlers have exactly one error shape to catch.
 */
export interface YotoErrorOptions {
  /** Machine-readable error code, SCREAMING_SNAKE_CASE (e.g. "AUTH_EXPIRED"). */
  code: string;
  /** Whether retrying the same request unchanged might succeed. */
  retryable?: boolean;
  /** A short, human-readable suggestion for what to do next. */
  hint?: string;
  /** The underlying error, if any. */
  cause?: unknown;
}

export class YotoError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly hint: string | undefined;

  constructor(message: string, options: YotoErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "YotoError";
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.hint = options.hint;
  }
}

export function isYotoError(value: unknown): value is YotoError {
  return value instanceof YotoError;
}
