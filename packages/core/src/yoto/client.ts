import type { z } from "zod";
import { isYotoError, YotoError, type YotoErrorCode } from "../errors.js";
import type { Logger } from "../logging.js";
import { noopLogger } from "../logging.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface YotoClientOptions {
  /** Returns a valid Yoto access token, refreshing it first if needed. */
  getToken: () => Promise<string>;
  /** Injected so tests can supply a mock; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Defaults to https://api.yotoplay.com */
  baseUrl?: string;
  logger?: Logger;
  /** Injected clock, for deterministic backoff/timeout tests. Defaults to Date.now. */
  now?: () => number;
  /** Injected sleep, for deterministic backoff tests. Defaults to a real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions<T> {
  method: HttpMethod;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON-serialised as the body with `Content-Type: application/json`. */
  body?: unknown;
  /** A pre-built body (e.g. raw bytes for a media upload) -- takes priority over `body`. */
  rawBody?: BodyInit;
  /** `Content-Type` to send with `rawBody`. */
  contentType?: string;
  headers?: Record<string, string>;
  /** Parses and validates the response body. Omit for responses you don't care about (e.g. 204s). */
  schema?: z.ZodType<T>;
  /**
   * Whether this exact request is safe to retry after it may already have
   * reached the server. Defaults to `true` for GET and `false` otherwise --
   * a non-idempotent POST is NEVER retried once it has been sent, even on a
   * 5xx/429/network error, because we cannot tell whether Yoto's API
   * applied it before failing.
   */
  idempotent?: boolean;
}

const MAX_ATTEMPTS = 3;
const RETRY_AFTER_CAP_MS = 30_000;
const BACKOFF_BASE_MS = 300;
const BACKOFF_CAP_MS = 8_000;

/**
 * Full-jitter backoff delay for retry attempt `attempt` (1-based): a random
 * value in `[0, min(cap, base * 2^(attempt-1))]`. Exported standalone so
 * tests can exercise the maths with an injected `random` and without real
 * timers. See https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
 */
export function computeFullJitterDelayMs(
  attempt: number,
  options: { base?: number; cap?: number; random?: () => number } = {},
): number {
  const base = options.base ?? BACKOFF_BASE_MS;
  const cap = options.cap ?? BACKOFF_CAP_MS;
  const random = options.random ?? Math.random;
  const upperBound = Math.min(cap, base * 2 ** (attempt - 1));
  return random() * upperBound;
}

/** Parses a `Retry-After` header (seconds, or an HTTP-date) into milliseconds. */
export function parseRetryAfterMs(value: string | null, now: () => number): number | undefined {
  if (!value) return undefined;
  const asSeconds = Number(value);
  if (!Number.isNaN(asSeconds)) return Math.max(0, asSeconds * 1000);
  const asDate = Date.parse(value);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - now());
  return undefined;
}

const HINTS: Partial<Record<YotoErrorCode, string>> = {
  AUTH_EXPIRED: "Run yoto_sign_in to refresh your Yoto session.",
  FORBIDDEN_SCOPE: "This connection doesn't have the Yoto scope this action needs.",
  RATE_LIMITED: "Yoto is rate-limiting requests right now; try again shortly.",
  NOT_FOUND: "That Yoto resource wasn't found.",
  UPSTREAM_ERROR: "Yoto's API returned an unexpected error.",
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class YotoClient {
  private readonly getToken: () => Promise<string>;
  readonly fetchImpl: typeof fetch;
  readonly baseUrl: string;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(options: YotoClientOptions) {
    this.getToken = options.getToken;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.baseUrl = options.baseUrl ?? "https://api.yotoplay.com";
    this.logger = options.logger ?? noopLogger;
    this.now = options.now ?? (() => Date.now());
    this.sleepImpl = options.sleep ?? defaultSleep;
  }

  private buildUrl(path: string, query?: RequestOptions<unknown>["query"]): string {
    const url = new URL(path.startsWith("http") ? path : `${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async toUpstreamError(response: Response, code: YotoErrorCode): Promise<YotoError> {
    let detail = "";
    try {
      const text = await response.text();
      if (text) {
        try {
          const parsed = JSON.parse(text) as { message?: string; error?: string };
          detail = parsed.message ?? parsed.error ?? text;
        } catch {
          detail = text;
        }
      }
    } catch {
      // Body already consumed or unreadable -- fall back to a status-only message.
    }
    const retryable = code === "RATE_LIMITED" || code === "UPSTREAM_ERROR";
    return new YotoError(`Yoto API returned ${response.status}${detail ? `: ${detail}` : ""}`, {
      code,
      retryable,
      status: response.status,
      hint: HINTS[code],
    });
  }

  private async parseBody<T>(
    response: Response,
    schema: z.ZodType<T> | undefined,
    method: HttpMethod,
    path: string,
  ): Promise<T> {
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch (cause) {
      throw new YotoError(`Yoto returned invalid JSON for ${method} ${path}`, {
        code: "UPSTREAM_ERROR",
        cause,
        hint: "This may be a transient Yoto API issue -- try again.",
      });
    }
    if (!schema) return json as T;
    const result = schema.safeParse(json);
    if (!result.success) {
      throw new YotoError(`Yoto's response for ${method} ${path} didn't match the expected shape`, {
        code: "UPSTREAM_ERROR",
        cause: result.error,
        hint: "Yoto may have changed their API response shape.",
      });
    }
    return result.data;
  }

  async request<T = unknown>(options: RequestOptions<T>): Promise<T> {
    const idempotent = options.idempotent ?? options.method === "GET";
    const url = this.buildUrl(options.path, options.query);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        const token = await this.getToken();
        const headers: Record<string, string> = {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...options.headers,
        };
        let body: BodyInit | undefined;
        if (options.rawBody !== undefined) {
          body = options.rawBody;
          if (options.contentType) headers["Content-Type"] = options.contentType;
        } else if (options.body !== undefined) {
          body = JSON.stringify(options.body);
          headers["Content-Type"] = "application/json";
        }
        response = await this.fetchImpl(url, { method: options.method, headers, body });
      } catch (cause) {
        if (isYotoError(cause)) throw cause;
        if (!idempotent || attempt >= MAX_ATTEMPTS) {
          throw new YotoError(`Network request to Yoto failed: ${options.method} ${options.path}`, {
            code: "UPSTREAM_ERROR",
            retryable: true,
            cause,
            hint: "Check network connectivity and try again.",
          });
        }
        this.logger.warn("Yoto request failed, retrying", {
          method: options.method,
          path: options.path,
          attempt,
        });
        await this.sleepImpl(computeFullJitterDelayMs(attempt));
        continue;
      }

      if (response.ok) {
        return this.parseBody(response, options.schema, options.method, options.path);
      }

      if (response.status === 429) {
        if (!idempotent || attempt >= MAX_ATTEMPTS) {
          throw await this.toUpstreamError(response, "RATE_LIMITED");
        }
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), this.now);
        await this.sleepImpl(
          Math.min(retryAfterMs ?? computeFullJitterDelayMs(attempt), RETRY_AFTER_CAP_MS),
        );
        continue;
      }

      if (response.status >= 500) {
        if (!idempotent || attempt >= MAX_ATTEMPTS) {
          throw await this.toUpstreamError(response, "UPSTREAM_ERROR");
        }
        await this.sleepImpl(computeFullJitterDelayMs(attempt));
        continue;
      }

      if (response.status === 401) throw await this.toUpstreamError(response, "AUTH_EXPIRED");
      if (response.status === 403) throw await this.toUpstreamError(response, "FORBIDDEN_SCOPE");
      if (response.status === 404) throw await this.toUpstreamError(response, "NOT_FOUND");
      throw await this.toUpstreamError(response, "UPSTREAM_ERROR");
    }

    // Unreachable -- the loop above always returns or throws -- but keeps the
    // function's return type honest without a non-null assertion.
    throw new YotoError(`Request to Yoto failed after ${MAX_ATTEMPTS} attempts`, {
      code: "UPSTREAM_ERROR",
    });
  }

  /**
   * Generic cursor-pagination helper. None of the 15 tools' endpoints
   * currently paginate (Yoto returns full collections for content/devices/
   * icons), but this keeps the shape ready for the day one does, and is
   * exercised directly in tests.
   */
  async *paginate<T>(
    fetchPage: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor?: string }>,
  ): AsyncGenerator<T, void, undefined> {
    let cursor: string | undefined;
    do {
      const page = await fetchPage(cursor);
      for (const item of page.items) yield item;
      cursor = page.nextCursor;
    } while (cursor);
  }
}
