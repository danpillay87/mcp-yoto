/**
 * The Yoto leg of the flow -- the ~150 lines of hand-written OAuth in this
 * project. @cloudflare/workers-oauth-provider is the authorization server the
 * MCP client talks to; this file makes the Worker a *client* of Yoto's Auth0
 * tenant and joins the two together.
 *
 *   GET /authorize  MCP client arrives -> validate -> 302 to Yoto's own login
 *                   and consent screen. We render nothing.
 *   GET /callback   Yoto returns -> exchange the code -> completeAuthorization
 *                   with the Yoto tokens as encrypted props -> 302 back to the
 *                   MCP client with our authorization code.
 *
 * No approval page of ours, and no server-side state: everything the callback
 * needs travels in the encrypted `state` blob (see state.ts).
 */
import {
  AuthorizationError,
  type AuthRequest,
  CimdFetchError,
  parseJwtJsonPart,
} from "@cloudflare/workers-oauth-provider";
import type { Context, Hono } from "hono";
import {
  type Env,
  getConfig,
  RESOURCE_SCOPES,
  STATE_TTL_SECONDS,
  type WorkerConfig,
  YOTO_SCOPE_STRING,
  type YotoProps,
} from "./config.js";
import { errorPage } from "./html.js";
import { createLogger } from "./log.js";
import { createCodeChallenge, createCodeVerifier, createNonce } from "./pkce.js";
import { decryptState, encryptState, StateError } from "./state.js";

type AppContext = Context<{ Bindings: Env }>;

/** Yoto's token endpoint response, as much of it as we rely on. */
export interface UpstreamTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

export class UpstreamError extends Error {
  readonly status: number;
  /** OAuth error code from the upstream body, when it sent one. */
  readonly code: string;
  readonly retryAfter?: string;
  constructor(status: number, code: string, retryAfter?: string) {
    super(`upstream token request failed: ${status} ${code}`);
    this.name = "UpstreamError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/**
 * POSTs to Yoto's token endpoint. Shared by the authorization-code exchange
 * here and the refresh in refresh.ts.
 *
 * `client_secret` is sent only when one is configured: Yoto may issue the
 * remote app as a public client, in which case PKCE is the only proof.
 */
export async function postYotoToken(
  config: WorkerConfig,
  params: Record<string, string>,
): Promise<UpstreamTokenResponse> {
  const form = new URLSearchParams({ client_id: config.yotoClientId, ...params });
  if (config.yotoClientSecret) form.set("client_secret", config.yotoClientSecret);

  const response = await fetch(config.yotoTokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: form.toString(),
  });

  if (!response.ok) {
    let code = "upstream_error";
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === "string") code = body.error;
    } catch {
      // A non-JSON error body tells us nothing we are allowed to log anyway.
    }
    throw new UpstreamError(
      response.status,
      code,
      response.headers.get("retry-after") ?? undefined,
    );
  }

  const body = (await response.json()) as UpstreamTokenResponse;
  if (typeof body.access_token !== "string" || body.access_token.length === 0) {
    throw new UpstreamError(response.status, "missing_access_token");
  }
  return body;
}

/**
 * Reads `sub` out of a JWT access token WITHOUT verifying its signature.
 *
 * This is safe precisely because we never make an authorization decision on it:
 * the value is only the label under which this grant is filed, so that a repeat
 * sign-in replaces the parent's previous grant instead of stacking up. Every
 * actual permission check happens at Yoto, against the token itself.
 */
export function readSubject(accessToken: string): string | undefined {
  const parts = accessToken.split(".");
  const payload = parts[1];
  if (parts.length !== 3 || !payload) return undefined;
  try {
    const claims = parseJwtJsonPart(payload);
    return typeof claims.sub === "string" && claims.sub.length > 0 ? claims.sub : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The provider's own token format is `userId:grantId:secret`, so a `:` in the
 * user id produces tokens that cannot be parsed back. Everything outside a
 * conservative allowlist is folded to `_`.
 */
export function sanitiseUserId(subject: string): string {
  return subject.replace(/[^A-Za-z0-9._~@|-]/g, "_").slice(0, 128);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Terminal OAuth error redirect back to the MCP client (RFC 6749 §4.1.2.1). */
function oauthErrorRedirect(request: AuthRequest, code: string, description: string): Response {
  const redirect = new URL(request.redirectUri);
  redirect.searchParams.set("error", code);
  redirect.searchParams.set("error_description", description);
  if (request.state) redirect.searchParams.set("state", request.state);
  if (request.issuer) redirect.searchParams.set("iss", request.issuer);
  return Response.redirect(redirect.toString(), 302);
}

/**
 * GET /authorize -- entry point for the MCP client.
 */
export async function handleAuthorize(c: AppContext): Promise<Response> {
  const config = getConfig(c.env);
  const log = createLogger(c.env);

  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  } catch (error) {
    if (error instanceof CimdFetchError) {
      log.warn("authorize.client_metadata_unavailable");
      return errorPage(
        400,
        "Could not verify your app",
        "We could not read the identity document your AI app published, so we stopped before sending you to Yoto.",
      );
    }
    if (!(error instanceof AuthorizationError)) throw error;
    // Field names carrying "code"/"token"/"secret" are redacted wholesale by the
    // logger, so error codes travel under names that cannot be confused for one.
    log.warn("authorize.rejected", {
      oauth_error: error.code,
      redirectable: Boolean(error.redirectUri),
    });
    if (!error.redirectUri) {
      // Unknown client or unregistered redirect: never bounce the browser to an
      // address we have not validated.
      return errorPage(400, "That sign-in request is not valid", error.description);
    }
    const redirect = new URL(error.redirectUri);
    redirect.searchParams.set("error", error.code);
    redirect.searchParams.set("error_description", error.description);
    if (error.state) redirect.searchParams.set("state", error.state);
    if (error.issuer) redirect.searchParams.set("iss", error.issuer);
    return Response.redirect(redirect.toString(), 302);
  }

  const client = await c.env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  if (!client) {
    log.warn("authorize.unknown_client");
    return errorPage(
      400,
      "That sign-in request is not valid",
      "Your AI app is not registered with this server. Try removing and re-adding the connector.",
    );
  }

  const verifier = createCodeVerifier();
  const challenge = await createCodeChallenge(verifier);
  const state = await encryptState(
    { req: oauthRequest, verifier, nonce: createNonce(), exp: nowSeconds() + STATE_TTL_SECONDS },
    config,
  );

  const upstream = new URL(config.yotoAuthorizeUrl);
  upstream.searchParams.set("response_type", "code");
  upstream.searchParams.set("client_id", config.yotoClientId);
  upstream.searchParams.set("redirect_uri", config.redirectUri);
  upstream.searchParams.set("scope", YOTO_SCOPE_STRING);
  upstream.searchParams.set("audience", config.yotoAudience);
  upstream.searchParams.set("code_challenge", challenge);
  upstream.searchParams.set("code_challenge_method", "S256");
  upstream.searchParams.set("state", state);

  log.info("authorize.redirect_to_yoto", { client_name: client.clientName ?? "unnamed" });
  return Response.redirect(upstream.toString(), 302);
}

/**
 * GET /callback -- Yoto sends the parent back here.
 */
export async function handleCallback(c: AppContext): Promise<Response> {
  const config = getConfig(c.env);
  const log = createLogger(c.env);
  const url = new URL(c.req.url);

  const rawState = url.searchParams.get("state");
  if (!rawState) {
    log.warn("callback.state_missing");
    return errorPage(
      400,
      "This sign-in link is no longer valid",
      "We could not match this page to a sign-in that started here.",
    );
  }

  let payload: Awaited<ReturnType<typeof decryptState>>;
  try {
    payload = await decryptState(rawState, config);
  } catch (error) {
    const reason = error instanceof StateError ? error.reason : "invalid";
    log.warn("callback.state_rejected", { reason });
    // Deliberately identical wording for tampered, expired and malformed.
    return errorPage(
      400,
      "This sign-in link is no longer valid",
      "Sign-in links last ten minutes and can only be used once. Please start again from your AI app.",
    );
  }

  const oauthRequest = payload.req;

  const upstreamError = url.searchParams.get("error");
  if (upstreamError) {
    log.info("callback.upstream_declined", { upstream_error: upstreamError });
    return oauthErrorRedirect(
      oauthRequest,
      upstreamError === "access_denied" ? "access_denied" : "server_error",
      "Yoto did not complete the sign-in.",
    );
  }

  const code = url.searchParams.get("code");
  if (!code) {
    log.warn("callback.code_missing");
    return oauthErrorRedirect(
      oauthRequest,
      "server_error",
      "Yoto did not return an authorization code.",
    );
  }

  let tokens: UpstreamTokenResponse;
  try {
    tokens = await postYotoToken(config, {
      grant_type: "authorization_code",
      code,
      code_verifier: payload.verifier,
      redirect_uri: config.redirectUri,
    });
  } catch (error) {
    const status = error instanceof UpstreamError ? error.status : 0;
    const upstreamCode = error instanceof UpstreamError ? error.code : "network_error";
    log.error("callback.token_exchange_failed", { status, upstream_error: upstreamCode });
    return oauthErrorRedirect(
      oauthRequest,
      "server_error",
      "We could not finish signing you in to Yoto. Please try again.",
    );
  }

  const subject = readSubject(tokens.access_token);
  const userId = subject
    ? sanitiseUserId(subject)
    : `yoto-anon-${createNonce()}`; /* Opaque upstream token: fall back to a
       one-off label rather than failing the parent. The only cost is that a
       later sign-in cannot supersede this grant, so it lingers until its TTL. */

  const grantedUpstream = tokens.scope ? tokens.scope.split(" ").filter(Boolean) : [];
  const requested = oauthRequest.scope.length > 0 ? oauthRequest.scope : RESOURCE_SCOPES;
  const granted = requested.filter((scope) => RESOURCE_SCOPES.includes(scope));
  if (grantedUpstream.length > 0) {
    const missing = granted.filter((scope) => !grantedUpstream.includes(scope));
    if (missing.length > 0) log.warn("callback.upstream_scope_narrower", { count: missing.length });
  }

  const props: YotoProps = {
    yotoAccessToken: tokens.access_token,
    yotoRefreshToken: tokens.refresh_token,
    yotoExpiresAt: nowSeconds() + (tokens.expires_in ?? 3600),
    yotoScope: tokens.scope ?? YOTO_SCOPE_STRING,
    yotoSub: userId,
  };

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    userId,
    metadata: { label: "Yoto", authorizedAt: new Date().toISOString() },
    scope: granted,
    props,
  });

  log.info("callback.grant_issued", {
    subject_source: subject ? "jwt" : "fallback",
    scope_count: granted.length,
    has_refresh_token: Boolean(tokens.refresh_token),
  });

  return Response.redirect(redirectTo, 302);
}

export function registerUpstreamRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get("/authorize", handleAuthorize);
  app.get("/callback", handleCallback);
}
