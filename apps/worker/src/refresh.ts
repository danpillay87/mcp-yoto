/**
 * Keeping the Yoto tokens alive.
 *
 * The provider calls `tokenExchangeCallback` on BOTH the authorization-code
 * exchange and every refresh (verified against 0.10.3's handleAuthCodeGrant /
 * handleRefreshTokenGrant), which is what lets us pin the lifetime of the token
 * we issue to the lifetime of the Yoto token behind it, and swap in rotated
 * Yoto tokens without the MCP client ever noticing.
 *
 * API reality check: `TokenExchangeCallbackOptions` carries no `env` and no
 * `request` -- the provider invokes the callback with exactly one argument. The
 * Worker therefore captures `env` on the way in (see `rememberEnv`, called from
 * index.ts). That is sound because a deployment has exactly one `env` object
 * shared by every request; the capture is a transport, not per-request state.
 */
import {
  GrantType,
  OAuthError,
  type TokenExchangeCallbackOptions,
  type TokenExchangeCallbackResult,
} from "@cloudflare/workers-oauth-provider";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  type Env,
  getConfig,
  MIN_ACCESS_TOKEN_TTL_SECONDS,
  UPSTREAM_REFRESH_SKEW_SECONDS,
  type YotoProps,
} from "./config.js";
import { createLogger } from "./log.js";
import { postYotoToken, UpstreamError } from "./upstream.js";

let capturedEnv: Env | undefined;

/** Called at the top of every request so the callback can reach the bindings. */
export function rememberEnv(env: Env): void {
  capturedEnv = env;
}

/** Test seam. */
export function forgetEnv(): void {
  capturedEnv = undefined;
}

const REAUTH_MESSAGE = "Your Yoto sign-in has expired. Please reconnect the Yoto connector.";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Our access token must never outlive the Yoto token it fronts, and must never
 * be shorter than the provider's KV floor of 60s.
 */
export function cappedAccessTokenTtl(props: YotoProps, now: number): number {
  const upstreamRemaining = props.yotoExpiresAt - now;
  return Math.max(
    MIN_ACCESS_TOKEN_TTL_SECONDS,
    Math.min(ACCESS_TOKEN_TTL_SECONDS, upstreamRemaining),
  );
}

/**
 * Decides whether an upstream failure means "the parent must sign in again"
 * (invalid_grant, which MCP clients handle by restarting the OAuth flow) or
 * "try later" (temporarily_unavailable). Getting this wrong in the generous
 * direction sends parents round a re-auth loop that cannot succeed, so an
 * `invalid_client` -- our own misconfiguration -- is explicitly not re-auth.
 */
function isTerminalUpstreamFailure(error: UpstreamError): boolean {
  if (error.code === "invalid_grant") return true;
  if (error.code === "invalid_client") return false;
  return error.status === 400 || error.status === 401 || error.status === 403;
}

export async function tokenExchangeCallback(
  options: TokenExchangeCallbackOptions,
): Promise<TokenExchangeCallbackResult | undefined> {
  const env = capturedEnv;
  if (!env) {
    throw new OAuthError("server_error", {
      description: "Server is not ready to complete this request.",
      statusCode: 500,
    });
  }

  const config = getConfig(env);
  const log = createLogger(env);
  const props = options.props as YotoProps | undefined;
  const now = nowSeconds();

  // A grant not created by our /callback (or one whose props were cleared) has
  // nothing for us to align or rotate. Leave it exactly as it is.
  if (!props || typeof props.yotoAccessToken !== "string") return undefined;

  if (options.grantType === GrantType.AUTHORIZATION_CODE) {
    // Tokens are seconds old; only the lifetime needs aligning.
    return { accessTokenTTL: cappedAccessTokenTtl(props, now) };
  }

  if (options.grantType !== GrantType.REFRESH_TOKEN) return undefined;

  // KNOWN LOW-SEVERITY RACE, left unfixed (security review, Sep 2026): two
  // concurrent refreshes landing here at once can both pass this check and
  // both rotate the same upstream refresh token; worst case is one extra
  // re-auth prompt for the parent, never data loss, so it is not worth the
  // added complexity of a lock for how rarely two refreshes truly overlap.
  if (props.yotoExpiresAt - now > UPSTREAM_REFRESH_SKEW_SECONDS) {
    // Still comfortably valid: re-issue against the existing Yoto token rather
    // than burning a single-use rotating refresh token on every client refresh.
    log.debug("refresh.upstream_still_valid");
    return { accessTokenTTL: cappedAccessTokenTtl(props, now) };
  }

  if (!props.yotoRefreshToken) {
    log.warn("refresh.no_upstream_refresh_token");
    throw new OAuthError("invalid_grant", { description: REAUTH_MESSAGE });
  }

  let refreshed: Awaited<ReturnType<typeof postYotoToken>>;
  try {
    refreshed = await postYotoToken(config, {
      grant_type: "refresh_token",
      refresh_token: props.yotoRefreshToken,
    });
  } catch (error) {
    if (error instanceof UpstreamError) {
      if (isTerminalUpstreamFailure(error)) {
        log.warn("refresh.upstream_rejected", {
          status: error.status,
          upstream_error: error.code,
        });
        throw new OAuthError("invalid_grant", { description: REAUTH_MESSAGE });
      }
      if (error.status === 429) {
        throw new OAuthError("temporarily_unavailable", {
          description: "Yoto is rate limiting this connector. Please retry shortly.",
          statusCode: 429,
          headers: { "Retry-After": error.retryAfter ?? "60" },
        });
      }
      log.error("refresh.upstream_failed", { status: error.status, upstream_error: error.code });
    } else {
      log.error("refresh.upstream_unreachable");
    }
    throw new OAuthError("temporarily_unavailable", {
      description: "Yoto could not be reached. Please retry shortly.",
      statusCode: 503,
    });
  }

  const newProps: YotoProps = {
    ...props,
    yotoAccessToken: refreshed.access_token,
    // Yoto/Auth0 rotates refresh tokens; keep the old one only if none came back.
    yotoRefreshToken: refreshed.refresh_token ?? props.yotoRefreshToken,
    yotoExpiresAt: now + (refreshed.expires_in ?? 3600),
    yotoScope: refreshed.scope ?? props.yotoScope,
  };

  log.info("refresh.upstream_rotated", {
    rotated_refresh_token: Boolean(refreshed.refresh_token),
    lifetime_seconds: refreshed.expires_in ?? 3600,
  });

  // Never return refreshTokenTTL here: the provider rejects the whole refresh
  // with invalid_request if a callback tries to change it mid-grant.
  return { newProps, accessTokenTTL: cappedAccessTokenTtl(newProps, now) };
}
