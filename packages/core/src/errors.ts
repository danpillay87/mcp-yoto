/**
 * A structured error surfaced to an MCP tool caller.
 *
 * Every failure path in packages/core -- YotoClient's HTTP mapping, the media
 * upload/transcode pipeline, auth adapters, and tool-level business
 * validation (e.g. "pass confirm: true") -- throws exactly one shape:
 * YotoError. `toToolResult()` is the single place that turns one into the
 * `{content, structuredContent, isError}` shape the MCP SDK expects back
 * from a tool handler.
 */
export type YotoErrorCode =
  | "NOT_AUTHENTICATED"
  | "AUTH_EXPIRED"
  | "RATE_LIMITED"
  | "UPSTREAM_ERROR"
  | "NOT_FOUND"
  | "FORBIDDEN_SCOPE"
  | "INVALID_AUDIO"
  | "INVALID_IMAGE"
  | "TRANSCODE_TIMEOUT"
  | "VALIDATION"
  | "UNSUPPORTED_IN_MODE";

export interface YotoErrorOptions {
  /** Machine-readable error code. */
  code: YotoErrorCode;
  /** Whether retrying the same request unchanged might succeed. Default false. */
  retryable?: boolean;
  /** A short, human-readable suggestion for what to do next. */
  hint?: string;
  /** The upstream HTTP status code, when this wraps an API response. */
  status?: number;
  /** The underlying error, if any. */
  cause?: unknown;
}

export class YotoError extends Error {
  readonly code: YotoErrorCode;
  readonly retryable: boolean;
  readonly hint: string | undefined;
  readonly status: number | undefined;

  constructor(message: string, options: YotoErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "YotoError";
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.hint = options.hint;
    this.status = options.status;
  }
}

export function isYotoError(value: unknown): value is YotoError {
  return value instanceof YotoError;
}

/**
 * The shape a failed tool call hands back to the MCP SDK. Deliberately
 * carries `structuredContent` too (not just text) even though the SDK skips
 * output-schema validation whenever `isError` is true (see
 * `McpServer.validateToolOutput`) -- a machine-readable `code` is exactly
 * what an LLM caller needs to decide whether to retry, re-auth, or give up.
 */
export interface ToolErrorResult {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: { code: YotoErrorCode | "UPSTREAM_ERROR"; message: string; hint?: string };
}

export function toToolResult(error: unknown): ToolErrorResult {
  if (isYotoError(error)) {
    const suffix = error.hint ? ` (${error.hint})` : "";
    return {
      isError: true,
      content: [{ type: "text", text: `${error.code}: ${error.message}${suffix}` }],
      structuredContent: { code: error.code, message: error.message, hint: error.hint },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: `UPSTREAM_ERROR: ${message}` }],
    structuredContent: { code: "UPSTREAM_ERROR", message },
  };
}
