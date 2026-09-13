/**
 * mcp-yoto Cloudflare Worker -- Phase 3: the auth layer.
 *
 * @cloudflare/workers-oauth-provider 0.10.3 is the authorization server the MCP
 * client (claude.ai, ChatGPT, Cursor, ...) talks to. It owns /token, /register,
 * both .well-known documents, PKCE, DCR, CIMD and all of the crypto. We own
 * exactly two routes -- /authorize and /callback -- which hand the parent to
 * Yoto's own login page and bring the resulting Yoto tokens back as `props`.
 *
 * HOW PROPS ARE PROTECTED AT REST (the claim PRIVACY.md makes, stated exactly):
 *
 *   `completeAuthorization({ props })` -> the provider generates a FRESH
 *   AES-256-GCM key per grant, encrypts the JSON props with it, and stores only
 *   the ciphertext in KV as `grant.encryptedProps`. The key itself is never
 *   stored: it is WRAPPED (AES-KW) with a key derived by HMAC-SHA256 over the
 *   bearer-token STRING -- the authorization code first, then the refresh token
 *   on the grant and the access token on each token record
 *   (`wrapKeyWithToken` / `deriveKeyFromToken` in the library's
 *   dist/oauth-provider.js; README: "props are encrypted with AES-GCM using key
 *   material wrapped by the corresponding secret token"). KV stores only the
 *   SHA-256 HASH of each token, never the token, so the contents of KV alone do
 *   not yield the unwrapping key.
 *
 *   Consequence, stated honestly: an operator reading a KV dump cannot decrypt
 *   a parent's Yoto tokens. That is NOT the same as being cryptographically
 *   locked out -- the HMAC key used by `deriveKeyFromToken` is a hard-coded
 *   constant inside the published npm package, not a per-deployment secret, so
 *   anyone holding a live client token (from a request header, a debug log, or
 *   modified Worker code) can decrypt the matching KV record. The protection is
 *   "nothing readable is stored", not "the operator is mathematically excluded".
 *   `userId`, `metadata`, scopes and timestamps are stored in PLAINTEXT by
 *   design, so the grant's Yoto subject id IS readable in KV. See PRIVACY.md.
 */
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  ConfigError,
  type Env,
  getConfig,
  REFRESH_TOKEN_TTL_SECONDS,
  RESOURCE_SCOPES,
  YOTO_SCOPES,
  type YotoProps,
} from "./config.js";
import { errorPage, escapeHtml, withSecurityHeaders } from "./html.js";
import { createLogger } from "./log.js";
import { rememberEnv, tokenExchangeCallback } from "./refresh.js";
import { registerUpstreamRoutes } from "./upstream.js";

export type { Env } from "./config.js";

/**
 * PLACEHOLDER for Phase 4, where the MCP TypeScript SDK v2 stateless
 * Streamable HTTP handler replaces the body of this fetch. It exists now only
 * to prove that the provider decrypts `props` and hands them over on a real
 * authenticated request. It reports WHETHER a token arrived and never what it
 * is: the token must not appear in the response, the logs, or anywhere else.
 */
// Not annotated as ExportedHandler<Env>: that type makes `fetch` optional, and
// the provider's apiHandler requires it. The inferred literal type has it.
const mcpHandler = {
  fetch(_request: Request, _env: Env, ctx: ExecutionContext): Response {
    const props = (ctx as ExecutionContext & { props?: Partial<YotoProps> }).props;
    return Response.json({
      ok: true,
      phase: "placeholder",
      hasProps: typeof props?.yotoAccessToken === "string" && props.yotoAccessToken.length > 0,
    });
  },
};

const app = new Hono<{ Bindings: Env }>();

registerUpstreamRoutes(app);

/** Landing page. Static file, with the deployment's own URLs substituted in. */
app.get("/", async (c) => {
  const issuer = getConfig(c.env).issuer;
  const asset = await c.env.ASSETS.fetch(new Request(new URL("/index.html", c.req.url)));
  if (!asset.ok) {
    return errorPage(500, "Page unavailable", "The landing page could not be loaded.");
  }
  const html = (await asset.text())
    .replaceAll("__MCP_URL_ENCODED__", encodeURIComponent(`${issuer}/mcp`))
    .replaceAll("__MCP_URL__", escapeHtml(`${issuer}/mcp`))
    .replaceAll("__ISSUER__", escapeHtml(issuer));
  return withSecurityHeaders(
    new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
    "public, max-age=300",
  );
});

/** Everything else falls through to static assets (icons). */
app.all("*", async (c) => {
  const asset = await c.env.ASSETS.fetch(c.req.raw);
  if (asset.status === 404) return c.text("Not found", 404);
  const out = new Response(asset.body, asset);
  out.headers.set("x-content-type-options", "nosniff");
  return out;
});

const defaultHandler: ExportedHandler<Env> = {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
};

function createProvider(env: Env): OAuthProvider<Env> {
  const config = getConfig(env);
  const log = createLogger(env);

  return new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: mcpHandler,
    defaultHandler,

    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",

    accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,

    scopesSupported: [...YOTO_SCOPES],
    resourceMetadata: {
      resource: config.resource,
      authorization_servers: [config.issuer],
      scopes_supported: RESOURCE_SCOPES,
      bearer_methods_supported: ["header"],
      resource_name: "Yoto (mcp-yoto)",
    },

    // MCP 2026-07-28 prefers CIMD; the compatibility flag that makes the
    // outbound metadata fetch SSRF-safe is set in wrangler.toml.
    clientIdMetadataDocumentEnabled: true,

    // Explicit rather than defaulted: S256 only, no implicit flow, ever.
    allowPlainPKCE: false,
    allowImplicitFlow: false,

    tokenExchangeCallback,

    onError: ({ code, status }) => {
      log.warn("oauth.error_response", { oauth_error: code, status });
    },
  });
}

const providers = new WeakMap<object, OAuthProvider<Env>>();

function getProvider(env: Env): OAuthProvider<Env> {
  const key = env as unknown as object;
  const existing = providers.get(key);
  if (existing) return existing;
  const provider = createProvider(env);
  providers.set(key, provider);
  return provider;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // The provider calls tokenExchangeCallback with no access to `env`; this is
    // where the callback gets it. Must run before anything can reach /token.
    rememberEnv(env);

    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      try {
        getConfig(env);
      } catch (error) {
        const detail = error instanceof ConfigError ? error.message : "configuration unavailable";
        // Names of missing variables only -- never their values.
        return new Response(detail, { status: 503, headers: { "content-type": "text/plain" } });
      }
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    }

    try {
      return await getProvider(env).fetch(request, env, ctx);
    } catch (error) {
      if (error instanceof ConfigError) {
        createLogger(env).error("worker.misconfigured");
        return new Response(error.message, {
          status: 503,
          headers: { "content-type": "text/plain" },
        });
      }
      throw error;
    }
  },

  /**
   * Defence in depth for KV TTLs. No cron trigger is configured yet (Phase 6);
   * grants and tokens already self-expire via their KV TTL.
   */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const result = await getProvider(env).purgeExpiredData(env, { batchSize: 100 });
    createLogger(env).info("purge.completed", {
      grants_purged: result.grantsPurged,
      tokens_purged: result.tokensPurged,
      done: result.done,
    });
  },
} satisfies ExportedHandler<Env>;
