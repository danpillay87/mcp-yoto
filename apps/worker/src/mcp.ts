/**
 * apps/worker's real `/mcp` endpoint -- the SDK v2 per-request-factory
 * stateless HTTP handler (`createMcpHandler`, confirmed against
 * node_modules/@modelcontextprotocol/server/dist/createMcpHandler-*.d.mts),
 * wired to packages/core's 14 tools with a "remote" `AuthAdapter` that reads
 * the Yoto access token straight out of `ctx.props` -- the plaintext-in-memory
 * value @cloudflare/workers-oauth-provider decrypts per request (see the big
 * comment in index.ts).
 *
 * `createMcpHandler` builds a brand-new `McpServer` per HTTP exchange from
 * the factory below (stateless: no session id, nothing held between
 * requests). It answers modern (2026-07-28, per-request-envelope) traffic
 * over its own single-exchange transport, and falls back to the "established
 * stateless idiom" for 2025-era traffic -- a fresh
 * `WebStandardStreamableHTTPServerTransport` with `sessionIdGenerator:
 * undefined` per POST. Because there is never a session, GET and DELETE (2025
 * session operations) are answered `405 Method not allowed`: this Worker has
 * nothing to hold a session's SSE stream open across, so that is the correct
 * behaviour, not a limitation we're working around.
 *
 * This module never writes the Yoto token anywhere: not to KV, not to a
 * variable outside the single request that needs it, and never to a log line
 * (see log.ts, the only module allowed to call console.*).
 */
import type {
  AuthAdapter,
  AuthStatus,
  Logger as CoreLogger,
  CreateToolsDeps,
} from "@mcp-yoto/core";
import { createServer, YotoClient, YotoError } from "@mcp-yoto/core";
import { createMcpHandler, type McpRequestContext } from "@modelcontextprotocol/server";
import type { Env, YotoProps } from "./config.js";
import { getConfig } from "./config.js";
import { createLogger, type LogField, type Logger as WorkerLogger } from "./log.js";
import { resolveAudio, resolveImage } from "./resolve.js";

/** Matches apps/worker/package.json's own version. */
const WORKER_VERSION = "0.1.0";

/** Reject a token this close to expiry so the client refreshes proactively. */
const EXPIRY_SKEW_SECONDS = 60;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Bridges apps/worker's own token-redacting `Logger` (log.ts) onto the
 * `Logger` shape packages/core expects. Non-scalar fields are stringified
 * rather than silently dropped -- log.ts's own value-shape scrub still
 * catches anything credential-shaped inside the resulting string, and its
 * field-NAME gate still redacts anything named like a secret outright.
 */
function toCoreLogger(logger: WorkerLogger): CoreLogger {
  const wrap =
    (fn: (event: string, fields?: Record<string, LogField>) => void) =>
    (message: string, data?: Record<string, unknown>): void => {
      if (!data) {
        fn(message);
        return;
      }
      const fields: Record<string, LogField> = {};
      for (const [key, value] of Object.entries(data)) {
        fields[key] =
          value === null ||
          value === undefined ||
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
            ? value
            : safeStringify(value);
      }
      fn(message, fields);
    };
  return {
    debug: wrap(logger.debug),
    info: wrap(logger.info),
    warn: wrap(logger.warn),
    error: wrap(logger.error),
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * The "remote" `AuthAdapter`: `getAccessToken()` returns the props token
 * as-is (refreshing it is the OAuth provider's job via `tokenExchangeCallback`
 * in refresh.ts, not ours), and returns `AUTH_EXPIRED` early -- inside the
 * 60s skew -- so the client refreshes proactively rather than racing an
 * upstream 401. There is no `signIn`/`signOut`: packages/core's
 * tools/auth.ts renders "connect from your client's settings" guidance
 * instead whenever `deps.mode === "remote"`.
 */
function buildAuthAdapter(props: Partial<YotoProps> | undefined): AuthAdapter {
  return {
    mode: "remote",

    async getAccessToken(): Promise<string> {
      const token = props?.yotoAccessToken;
      if (!token) {
        throw new YotoError(
          "Not signed in. Connect this server from your AI client's connector settings.",
          { code: "NOT_AUTHENTICATED" },
        );
      }
      if (
        typeof props?.yotoExpiresAt === "number" &&
        props.yotoExpiresAt - EXPIRY_SKEW_SECONDS <= nowSeconds()
      ) {
        throw new YotoError("Your Yoto session has expired.", {
          code: "AUTH_EXPIRED",
          hint: "Your AI client should refresh this connection automatically; if it doesn't, reconnect it.",
        });
      }
      return token;
    },

    async status(): Promise<AuthStatus> {
      const signedIn =
        typeof props?.yotoAccessToken === "string" && props.yotoAccessToken.length > 0;
      return {
        signedIn,
        mode: "remote",
        tokenStore: "remote",
        expiresAt: props?.yotoExpiresAt,
        scopes: props?.yotoScope ? props.yotoScope.split(" ").filter(Boolean) : undefined,
        hint: signedIn
          ? undefined
          : "Connect this server from your AI client's connector settings -- it redirects to Yoto's own login page.",
      };
    },
  };
}

function buildDeps(env: Env, props: Partial<YotoProps> | undefined): CreateToolsDeps {
  const config = getConfig(env);
  const logger = toCoreLogger(createLogger(env));
  const auth = buildAuthAdapter(props);
  const client = new YotoClient({
    getToken: () => auth.getAccessToken(),
    baseUrl: config.yotoAudience,
    // YotoClient stores this and calls it as `this.fetchImpl(...)` -- a
    // METHOD call, so passing `fetch` (or `globalThis.fetch`) directly would
    // invoke it with the wrong receiver and the Workers runtime throws
    // "Illegal invocation" (it checks the caller identity `fetch` normally
    // gets from being called bare). Wrapping it in a free function restores
    // a receiver-less call at the actual call site.
    fetchImpl: (...args: Parameters<typeof fetch>) => fetch(...args),
    logger,
  });
  return {
    auth,
    client,
    logger,
    mode: "remote",
    iconBaseUrl: `${config.issuer}/icons`,
    resolveAudio,
    resolveImage,
  };
}

/**
 * `McpServerFactory`: called fresh for every HTTP exchange (never reused, so
 * building it here is exactly the "cheap per request" option the plan
 * allows -- nothing here is cached across requests, which is also what keeps
 * a token from ever ending up in a shared, isolate-lifetime cache).
 */
function buildMcpServer(env: Env, ctx: McpRequestContext) {
  const props = (ctx.authInfo?.extra as { yotoProps?: Partial<YotoProps> } | undefined)?.yotoProps;
  const deps = buildDeps(env, props);
  // `deps.iconBaseUrl` (set in buildDeps) already wins over this per
  // createServer()'s own fallback order -- passed again here only for the
  // server-level icon/websiteUrl, not the per-tool icons.
  return createServer(deps, {
    name: "mcp-yoto",
    version: WORKER_VERSION,
    title: "Yoto (Works with Yoto)",
    websiteUrl: getConfig(env).issuer,
  });
}

type McpHandler = ReturnType<typeof createMcpHandler>;
const handlers = new WeakMap<object, McpHandler>();

/**
 * The handler itself holds no per-request state (no token, no props) --
 * only the factory closure over `env` and the SDK's own subscription bus --
 * so caching one per `env` object (the same pattern `index.ts` uses for the
 * `OAuthProvider`) is safe and keyed on nothing user-specific.
 */
function getMcpHandler(env: Env): McpHandler {
  const key = env as unknown as object;
  const existing = handlers.get(key);
  if (existing) return existing;
  const log = createLogger(env);
  const handler = createMcpHandler((ctx) => buildMcpServer(env, ctx), {
    onerror: (error) => log.error("mcp.handler_error", { message: error.message }),
  });
  handlers.set(key, handler);
  return handler;
}

/**
 * The `apiHandler` passed to `OAuthProvider` in index.ts. By the time this
 * runs, the provider has already validated the caller's own bearer token and
 * decrypted the grant's `props` into `ctx.props` -- seeing this handler run
 * at all is proof of that. `props` is read once, passed through as the SDK's
 * own `AuthInfo.extra`, and never stored anywhere outside this one request.
 */
export const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx as ExecutionContext & { props?: Partial<YotoProps> }).props;
    return getMcpHandler(env).fetch(request, {
      authInfo: {
        token: props?.yotoAccessToken ?? "",
        clientId: "remote",
        scopes: props?.yotoScope ? props.yotoScope.split(" ").filter(Boolean) : [],
        expiresAt: props?.yotoExpiresAt,
        extra: { yotoProps: props },
      },
    });
  },
};
