/**
 * Typed environment + validated configuration for the mcp-yoto Worker.
 *
 * Cloudflare hands `env` to the fetch handler, not to module scope, so
 * "validate at startup" means "validate on first use inside an isolate and
 * cache the result per env object" -- which is what `getConfig()` does.
 */
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";

/**
 * Bindings and variables the Worker expects.
 *
 * `OAUTH_PROVIDER` is injected by `OAuthProvider` itself before it calls the
 * default handler or an API handler; it is never declared in wrangler.toml.
 */
export interface Env {
  /** KV namespace owned by @cloudflare/workers-oauth-provider. */
  OAUTH_KV: KVNamespace;
  /** Injected by OAuthProvider at request time. */
  OAUTH_PROVIDER: OAuthHelpers;
  /** Static assets binding (landing page + icons). */
  ASSETS: Fetcher;
  /** Public origin of this Worker, e.g. https://mcp-yoto.example.workers.dev. No trailing slash. */
  ISSUER: string;
  /** Yoto dev-app client id for the remote ("mcp-yoto") app. */
  YOTO_CLIENT_ID: string;
  /** Optional: Yoto public clients may have no secret. */
  YOTO_CLIENT_SECRET?: string;
  /** Secret used to derive the AES key that protects the upstream `state` blob. */
  STATE_SECRET: string;
  /** Optional override, defaults to https://login.yotoplay.com */
  YOTO_AUTH_BASE?: string;
  /** Optional override, defaults to https://api.yotoplay.com */
  YOTO_AUDIENCE?: string;
  /** debug | info | warn | error. Defaults to info. */
  LOG_LEVEL?: string;
}

export const DEFAULT_YOTO_AUTH_BASE = "https://login.yotoplay.com";
export const DEFAULT_YOTO_AUDIENCE = "https://api.yotoplay.com";

/**
 * Scopes requested at Yoto.
 *
 * `family:devices:control` and `family:devices:manage` are deliberately absent:
 * device-control scopes are the documented blocker for Yoto's Verified listing.
 * A test asserts they never appear.
 */
export const YOTO_SCOPES = [
  "profile",
  "offline_access",
  "user:content:view",
  "user:content:manage",
  "user:icons:manage",
  "family:library:view",
  "family:devices:view",
] as const;

export const YOTO_SCOPE_STRING: string = YOTO_SCOPES.join(" ");

/**
 * Scopes this Worker advertises as a protected resource. `offline_access` is an
 * authorization-server capability, not a resource permission, so RFC 9728
 * metadata omits it (see OAuthProviderOptions.resourceMetadata.scopes_supported).
 */
export const RESOURCE_SCOPES: string[] = YOTO_SCOPES.filter((s) => s !== "offline_access");

/** Our access tokens live ~55 minutes, under the 1h Yoto/Auth0 default. */
export const ACCESS_TOKEN_TTL_SECONDS = 55 * 60;
/** Grant/refresh lifetime. Grants carry a matching KV TTL, so they self-expire. */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
/**
 * How long a dynamically-registered client (DCR, `client:*` KV keys) stays
 * valid before the provider expires it. Security-review recommendation
 * (MEDIUM): without this, a DCR client registered once lives forever. Clients
 * that connect via CIMD (client_id_metadata_document -- what claude.ai
 * actually uses) are never stored in KV at all, so this TTL does not apply to
 * them; only genuine DCR registrations age out.
 */
export const CLIENT_REGISTRATION_TTL_SECONDS = 30 * 24 * 60 * 60;
/** The provider rejects any access-token TTL below this (KV minimum). */
export const MIN_ACCESS_TOKEN_TTL_SECONDS = 60;
/** How long an in-flight `state` blob stays valid. */
export const STATE_TTL_SECONDS = 10 * 60;
/** Refresh the Yoto token when it has less than this left. */
export const UPSTREAM_REFRESH_SKEW_SECONDS = 5 * 60;

/**
 * Application props stored per grant. Encrypted at rest by the provider under a
 * key wrapped with the client's own token -- see the comment in index.ts.
 *
 * NOTHING in here may ever reach a log line.
 */
export interface YotoProps {
  yotoAccessToken: string;
  yotoRefreshToken?: string;
  /** Unix seconds. */
  yotoExpiresAt: number;
  /** Space-separated scopes Yoto actually granted. */
  yotoScope: string;
  /** Pseudonymous Yoto subject, used only as the grant's user label. */
  yotoSub: string;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface WorkerConfig {
  /** Public origin, no trailing slash. */
  issuer: string;
  /** Exactly what must be registered at Yoto: `${issuer}/callback`. */
  redirectUri: string;
  /** RFC 9728 resource identifier: `${issuer}/mcp`. */
  resource: string;
  yotoClientId: string;
  yotoClientSecret?: string;
  yotoAuthBase: string;
  yotoAuthorizeUrl: string;
  yotoTokenUrl: string;
  yotoAudience: string;
  stateSecret: string;
  logLevel: LogLevel;
}

const httpsUrl = (label: string) =>
  z.string().refine(
    (value) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:";
      } catch {
        return false;
      }
    },
    { message: `${label} must be an absolute http(s) URL` },
  );

const envSchema = z.object({
  ISSUER: httpsUrl("ISSUER"),
  YOTO_CLIENT_ID: z.string().min(1, "YOTO_CLIENT_ID is required"),
  YOTO_CLIENT_SECRET: z.string().min(1).optional(),
  STATE_SECRET: z
    .string()
    .min(32, "STATE_SECRET must be at least 32 characters of high-entropy random text"),
  YOTO_AUTH_BASE: httpsUrl("YOTO_AUTH_BASE").optional(),
  YOTO_AUDIENCE: httpsUrl("YOTO_AUDIENCE").optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional(),
});

/** Thrown when the Worker is deployed with missing or malformed configuration. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const cache = new WeakMap<object, WorkerConfig>();

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/**
 * Validates and caches the Worker configuration.
 *
 * @throws {ConfigError} naming every variable that is missing or malformed.
 *   The message is safe to log: it contains variable NAMES only, never values.
 */
export function getConfig(env: Env): WorkerConfig {
  const cached = cache.get(env as unknown as object);
  if (cached) return cached;

  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => {
        const name = issue.path.join(".") || "(root)";
        return `${name}: ${issue.message}`;
      })
      .join("; ");
    throw new ConfigError(`mcp-yoto Worker is misconfigured -> ${details}`);
  }

  const issuer = stripTrailingSlash(parsed.data.ISSUER);
  const yotoAuthBase = stripTrailingSlash(parsed.data.YOTO_AUTH_BASE ?? DEFAULT_YOTO_AUTH_BASE);

  const config: WorkerConfig = {
    issuer,
    redirectUri: `${issuer}/callback`,
    resource: `${issuer}/mcp`,
    yotoClientId: parsed.data.YOTO_CLIENT_ID,
    yotoClientSecret: parsed.data.YOTO_CLIENT_SECRET,
    yotoAuthBase,
    yotoAuthorizeUrl: `${yotoAuthBase}/authorize`,
    yotoTokenUrl: `${yotoAuthBase}/oauth/token`,
    yotoAudience: stripTrailingSlash(parsed.data.YOTO_AUDIENCE ?? DEFAULT_YOTO_AUDIENCE),
    stateSecret: parsed.data.STATE_SECRET,
    logLevel: parsed.data.LOG_LEVEL ?? "info",
  };

  cache.set(env as unknown as object, config);
  return config;
}
