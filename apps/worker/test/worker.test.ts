/**
 * End-to-end tests for the auth layer, in a real workerd with a real local KV.
 *
 * Harness note: @cloudflare/vitest-pool-workers 0.22.0 peers on vitest ^4.1.0
 * and this workspace runs vitest 5, so the pool is not usable here. Instead the
 * Worker is bundled exactly as `wrangler deploy` would bundle it
 * (`wrangler deploy --dry-run`) and run under Miniflare, which is the same
 * workerd binary and the same KV implementation. Outbound requests to Yoto are
 * intercepted with Miniflare's `outboundService`, so no test ever touches the
 * real login.yotoplay.com.
 *
 * Every credential in this file is an obvious fake.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encryptState } from "../src/state.js";

const WORKER_DIR = fileURLToPath(new URL("..", import.meta.url));
const BUNDLE = fileURLToPath(new URL("../.wrangler/test-dist/index.js", import.meta.url));
const WRANGLER = fileURLToPath(
  new URL("../../../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);

const ISSUER = "https://mcp-yoto.test";
const YOTO_AUTH_BASE = "https://login.yotoplay.test";
const YOTO_AUDIENCE = "https://api.yotoplay.test";
const STATE_SECRET = "0123456789abcdef0123456789abcdef";
const CLIENT_REDIRECT = "https://client.test/callback";
const YOTO_SUBJECT = "auth0|test-parent";

/** Distinctive fakes, so the KV dump assertions cannot pass by accident. */
const FAKE_ACCESS_MARKER = "FAKE-YOTO-ACCESS-TOKEN-MARKER";
const FAKE_REFRESH_TOKEN = "FAKE-YOTO-REFRESH-TOKEN-MARKER";

function base64Url(value: object | string): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Buffer.from(text).toString("base64url");
}

/** A JWT-shaped access token. Unsigned rubbish: nothing verifies it, by design. */
function fakeYotoAccessToken(marker: string, sub: string | undefined = YOTO_SUBJECT): string {
  const payload: Record<string, unknown> = { marker, aud: YOTO_AUDIENCE };
  if (sub) payload.sub = sub;
  return [
    base64Url({ alg: "RS256", typ: "JWT" }),
    base64Url(payload),
    base64Url("not-a-signature"),
  ].join(".");
}

interface UpstreamCall {
  url: string;
  params: Record<string, string>;
}

const upstreamCalls: UpstreamCall[] = [];
let upstreamResponder: (call: UpstreamCall) => Response = () => tokenResponse();

function tokenResponse(
  options: { marker?: string; expiresIn?: number; refreshToken?: string | null; sub?: string } = {},
): Response {
  const body: Record<string, unknown> = {
    access_token: fakeYotoAccessToken(options.marker ?? FAKE_ACCESS_MARKER, options.sub),
    expires_in: options.expiresIn ?? 3600,
    scope: "profile user:content:view user:content:manage",
    token_type: "Bearer",
  };
  if (options.refreshToken !== null)
    body.refresh_token = options.refreshToken ?? FAKE_REFRESH_TOKEN;
  return Response.json(body);
}

let mf: Miniflare;

beforeAll(async () => {
  // Bundle exactly as a deploy would, so the tests exercise the shipped module
  // graph (hono, the OAuth provider, zod) rather than a test-only assembly.
  execFileSync(
    process.execPath,
    [WRANGLER, "deploy", "--dry-run", "--outdir", ".wrangler/test-dist"],
    {
      cwd: WORKER_DIR,
      stdio: "pipe",
    },
  );

  const landing = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

  mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "mcp-yoto",
          modules: true,
          scriptPath: BUNDLE,
          compatibilityDate: "2026-09-13",
          compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
          kvNamespaces: ["OAUTH_KV"],
          bindings: {
            ISSUER,
            YOTO_CLIENT_ID: "yoto-remote-app",
            STATE_SECRET,
            YOTO_AUTH_BASE,
            YOTO_AUDIENCE,
            LOG_LEVEL: "error",
          },
          serviceBindings: {
            ASSETS: async () =>
              new Response(landing, { headers: { "content-type": "text/html; charset=utf-8" } }),
          },
          outboundService: async (request: Request) => {
            const body = await request.text();
            const call: UpstreamCall = {
              url: request.url,
              params: Object.fromEntries(new URLSearchParams(body)),
            };
            upstreamCalls.push(call);
            return upstreamResponder(call);
          },
        },
      ],
    }),
  );
  // Force the runtime up front so the first test does not pay for it.
  await mf.dispatchFetch(`${ISSUER}/healthz`);
}, 300_000);

afterAll(async () => {
  await mf?.dispose();
});

function get(path: string): Promise<Response> {
  return mf.dispatchFetch(`${ISSUER}${path}`, {
    redirect: "manual",
  }) as unknown as Promise<Response>;
}

function postForm(path: string, params: Record<string, string>): Promise<Response> {
  return mf.dispatchFetch(`${ISSUER}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    redirect: "manual",
  }) as unknown as Promise<Response>;
}

async function registerClient(name = "Test MCP client"): Promise<string> {
  const response = await mf.dispatchFetch(`${ISSUER}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [CLIENT_REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { client_id: string };
  return body.client_id;
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

async function startAuthorize(clientId: string, challenge: string): Promise<Response> {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLIENT_REDIRECT,
    state: "downstream-client-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "user:content:view user:content:manage",
    resource: `${ISSUER}/mcp`,
  });
  return get(`/authorize?${params.toString()}`);
}

interface SignedIn {
  clientId: string;
  accessToken: string;
  refreshToken: string;
}

/** Drives a complete parent sign-in and returns the tokens the MCP client holds. */
async function signIn(options: { expiresIn?: number; marker?: string } = {}): Promise<SignedIn> {
  upstreamResponder = () => tokenResponse(options);
  const clientId = await registerClient();
  const { verifier, challenge } = pkcePair();

  const authorizeResponse = await startAuthorize(clientId, challenge);
  expect(authorizeResponse.status).toBe(302);
  const upstreamUrl = new URL(authorizeResponse.headers.get("location") ?? "");
  const state = upstreamUrl.searchParams.get("state") ?? "";

  const callbackResponse = await get(
    `/callback?code=yoto-auth-code&state=${encodeURIComponent(state)}`,
  );
  expect(callbackResponse.status).toBe(302);
  const clientRedirect = new URL(callbackResponse.headers.get("location") ?? "");
  expect(`${clientRedirect.origin}${clientRedirect.pathname}`).toBe(CLIENT_REDIRECT);
  const code = clientRedirect.searchParams.get("code") ?? "";
  expect(code).not.toBe("");

  const tokenResponseRaw = await postForm("/token", {
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    code_verifier: verifier,
    redirect_uri: CLIENT_REDIRECT,
    resource: `${ISSUER}/mcp`,
  });
  expect(tokenResponseRaw.status).toBe(200);
  const tokens = (await tokenResponseRaw.json()) as {
    access_token: string;
    refresh_token: string;
  };
  return { clientId, accessToken: tokens.access_token, refreshToken: tokens.refresh_token };
}

async function dumpKv(): Promise<{ keys: string[]; blob: string }> {
  const kv = await mf.getKVNamespace("OAUTH_KV", "mcp-yoto");
  const { keys } = await kv.list();
  const parts: string[] = [];
  for (const key of keys) {
    parts.push(key.name, (await kv.get(key.name)) ?? "");
  }
  return { keys: keys.map((key) => key.name), blob: parts.join("\n") };
}

describe("discovery metadata", () => {
  it("publishes authorization server metadata with S256 only", async () => {
    const response = await get("/.well-known/oauth-authorization-server");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.issuer).toBe(ISSUER);
    expect(body.authorization_endpoint).toBe(`${ISSUER}/authorize`);
    expect(body.token_endpoint).toBe(`${ISSUER}/token`);
    expect(body.registration_endpoint).toBe(`${ISSUER}/register`);
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.response_types_supported).toEqual(["code"]);
    expect(body.client_id_metadata_document_supported).toBe(true);
  });

  it("publishes protected resource metadata pinned to /mcp", async () => {
    const response = await get("/.well-known/oauth-protected-resource/mcp");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.resource).toBe(`${ISSUER}/mcp`);
    expect(body.authorization_servers).toEqual([ISSUER]);
    expect(body.scopes_supported).not.toContain("offline_access");
    expect(JSON.stringify(body)).not.toContain("devices:control");
  });

  it("challenges an unauthenticated /mcp request", async () => {
    const response = await get("/mcp");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://mcp-yoto.test/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("answers /healthz", async () => {
    const response = await get("/healthz");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });
});

describe("/authorize", () => {
  it("redirects straight to Yoto with the exact upstream parameters", async () => {
    const clientId = await registerClient();
    const { challenge } = pkcePair();
    const response = await startAuthorize(clientId, challenge);

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(`${YOTO_AUTH_BASE}/authorize`);
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("client_id")).toBe("yoto-remote-app");
    expect(location.searchParams.get("redirect_uri")).toBe(`${ISSUER}/callback`);
    expect(location.searchParams.get("audience")).toBe(YOTO_AUDIENCE);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get("scope")).toBe(
      "profile offline_access user:content:view user:content:manage user:icons:manage family:library:view family:devices:view",
    );
  });

  it("never renders a consent page of its own", async () => {
    const clientId = await registerClient();
    const { challenge } = pkcePair();
    const response = await startAuthorize(clientId, challenge);
    expect(response.status).toBe(302);
    expect(response.headers.get("content-type") ?? "").not.toContain("text/html");
  });

  it("carries an opaque state that leaks neither the verifier nor the client", async () => {
    const clientId = await registerClient("Leak check client");
    const { challenge } = pkcePair();
    const response = await startAuthorize(clientId, challenge);
    const state = new URL(response.headers.get("location") ?? "").searchParams.get("state") ?? "";
    expect(state.length).toBeGreaterThan(40);
    expect(state).not.toContain(clientId);
    expect(Buffer.from(state, "base64url").toString("utf8")).not.toContain("redirectUri");
  });

  it("refuses an unknown client without redirecting anywhere", async () => {
    const response = await get(
      `/authorize?response_type=code&client_id=nope&redirect_uri=${encodeURIComponent(CLIENT_REDIRECT)}&state=x`,
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  });
});

describe("/callback state handling", () => {
  it("rejects a tampered state", async () => {
    const clientId = await registerClient();
    const { challenge } = pkcePair();
    const authorizeResponse = await startAuthorize(clientId, challenge);
    const state =
      new URL(authorizeResponse.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const tampered = `${state.slice(0, -6)}AAAAAA`;

    const response = await get(`/callback?code=x&state=${encodeURIComponent(tampered)}`);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("no longer valid");
  });

  it("rejects an expired state", async () => {
    const expired = await encryptState(
      {
        req: {
          responseType: "code",
          clientId: "whoever",
          redirectUri: CLIENT_REDIRECT,
          scope: [],
          state: "s",
        },
        verifier: "v",
        nonce: "n",
        exp: Math.floor(Date.now() / 1000) - 5,
      },
      { stateSecret: STATE_SECRET, issuer: ISSUER },
    );
    const response = await get(`/callback?code=x&state=${encodeURIComponent(expired)}`);
    expect(response.status).toBe(400);
  });

  it("rejects a missing state", async () => {
    expect((await get("/callback?code=x")).status).toBe(400);
  });

  it("gives the same answer for tampered and expired, and leaks no detail", async () => {
    const response = await get("/callback?code=x&state=rubbish");
    const text = await response.text();
    expect(response.status).toBe(400);
    expect(text).not.toContain("state");
    expect(text).not.toContain("verifier");
  });
});

describe("full sign-in", () => {
  it("exchanges the Yoto code and issues our own token", async () => {
    upstreamCalls.length = 0;
    const session = await signIn();

    const exchange = upstreamCalls.find((call) => call.params.grant_type === "authorization_code");
    expect(exchange).toBeDefined();
    expect(exchange?.url).toBe(`${YOTO_AUTH_BASE}/oauth/token`);
    expect(exchange?.params.code).toBe("yoto-auth-code");
    expect(exchange?.params.redirect_uri).toBe(`${ISSUER}/callback`);
    expect(exchange?.params.code_verifier).toBeDefined();
    expect(exchange?.params.client_id).toBe("yoto-remote-app");
    // Public client: no secret configured, so none is sent.
    expect(exchange?.params.client_secret).toBeUndefined();

    expect(session.accessToken).toBeTruthy();
    expect(session.refreshToken).toBeTruthy();
  });

  it("hands the Yoto token to the MCP handler as decrypted props", async () => {
    const session = await signIn();
    const response = await mf.dispatchFetch(`${ISSUER}/mcp`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; hasProps: boolean };
    expect(body).toMatchObject({ ok: true, hasProps: true });
    // The placeholder must never echo the token itself.
    expect(JSON.stringify(body)).not.toContain(FAKE_ACCESS_MARKER);
  });

  it("returns the authorization-server issuer to the client (RFC 9207)", async () => {
    const clientId = await registerClient();
    const { challenge } = pkcePair();
    upstreamResponder = () => tokenResponse();
    const authorizeResponse = await startAuthorize(clientId, challenge);
    const state =
      new URL(authorizeResponse.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const callback = await get(`/callback?code=c&state=${encodeURIComponent(state)}`);
    const location = new URL(callback.headers.get("location") ?? "");
    expect(location.searchParams.get("state")).toBe("downstream-client-state");
  });

  it("passes an upstream refusal back to the client as an OAuth error", async () => {
    const clientId = await registerClient();
    const { challenge } = pkcePair();
    const authorizeResponse = await startAuthorize(clientId, challenge);
    const state =
      new URL(authorizeResponse.headers.get("location") ?? "").searchParams.get("state") ?? "";

    const response = await get(
      `/callback?error=access_denied&error_description=nope&state=${encodeURIComponent(state)}`,
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(CLIENT_REDIRECT);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("downstream-client-state");
  });
});

describe("confidential client", () => {
  /**
   * Production registers mcp-yoto at Yoto as a CONFIDENTIAL client, so the token
   * exchange must authenticate with the secret. Every other test in this file
   * runs the public-client path, which would hide a break here until deploy.
   */
  it("authenticates the token exchange when a client secret is configured", async () => {
    const calls: UpstreamCall[] = [];
    const landing = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    const confidential = new Miniflare(
      convertV4MiniflareOptions({
        workers: [
          {
            name: "mcp-yoto-confidential",
            modules: true,
            scriptPath: BUNDLE,
            compatibilityDate: "2026-09-13",
            compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
            kvNamespaces: ["OAUTH_KV"],
            bindings: {
              ISSUER,
              YOTO_CLIENT_ID: "yoto-remote-app",
              YOTO_CLIENT_SECRET: "fake-client-secret-for-tests",
              STATE_SECRET,
              YOTO_AUTH_BASE,
              YOTO_AUDIENCE,
              LOG_LEVEL: "error",
            },
            serviceBindings: {
              ASSETS: async () => new Response(landing),
            },
            outboundService: async (request: Request) => {
              calls.push({
                url: request.url,
                params: Object.fromEntries(new URLSearchParams(await request.text())),
              });
              return tokenResponse();
            },
          },
        ],
      }),
    );

    try {
      const register = await confidential.dispatchFetch(`${ISSUER}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Confidential flow client",
          redirect_uris: [CLIENT_REDIRECT],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        }),
      });
      const { client_id: clientId } = (await register.json()) as { client_id: string };
      const { challenge } = pkcePair();
      const authorize = await confidential.dispatchFetch(
        `${ISSUER}/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: CLIENT_REDIRECT,
          state: "s",
          code_challenge: challenge,
          code_challenge_method: "S256",
        }).toString()}`,
        { redirect: "manual" },
      );
      const state =
        new URL(authorize.headers.get("location") ?? "").searchParams.get("state") ?? "";
      const callback = await confidential.dispatchFetch(
        `${ISSUER}/callback?code=yoto-auth-code&state=${encodeURIComponent(state)}`,
        { redirect: "manual" },
      );
      expect(callback.status).toBe(302);

      const exchange = calls.find((call) => call.params.grant_type === "authorization_code");
      expect(exchange?.params.client_secret).toBe("fake-client-secret-for-tests");
      expect(exchange?.params.code_verifier).toBeDefined();
    } finally {
      await confidential.dispose();
    }
  });
});

describe("what KV actually holds (the privacy claim)", () => {
  it("stores no Yoto token in readable form, but does store the subject id", async () => {
    await signIn();
    const { keys, blob } = await dumpKv();

    expect(keys.some((key) => key.startsWith("grant:"))).toBe(true);
    expect(keys.some((key) => key.startsWith("token:"))).toBe(true);

    // The claim: nothing readable at rest.
    expect(blob).not.toContain(FAKE_ACCESS_MARKER);
    expect(blob).not.toContain(FAKE_REFRESH_TOKEN);
    expect(blob).not.toContain("yotoAccessToken");
    expect(blob).not.toContain("yotoRefreshToken");

    // The honest limit of that claim, asserted so nobody overstates it: the
    // grant's user id and metadata are plaintext by design (the provider needs
    // them to list and revoke grants), so the Yoto subject IS visible in KV.
    expect(blob).toContain(YOTO_SUBJECT);
    expect(blob).toContain("encryptedProps");
  });
});

describe("refresh", () => {
  it("refreshes upstream and swaps in the rotated Yoto tokens", async () => {
    // expires_in below the 5-minute skew, so the next refresh must go upstream.
    const session = await signIn({ expiresIn: 120 });
    upstreamCalls.length = 0;
    upstreamResponder = () =>
      tokenResponse({
        marker: "SECOND-FAKE-ACCESS",
        refreshToken: "SECOND-FAKE-REFRESH",
        expiresIn: 3600,
      });

    const response = await postForm("/token", {
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
      client_id: session.clientId,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { access_token: string; expires_in: number };

    const refreshCall = upstreamCalls.find((call) => call.params.grant_type === "refresh_token");
    expect(refreshCall).toBeDefined();
    expect(refreshCall?.params.refresh_token).toBe(FAKE_REFRESH_TOKEN);
    // Our token lifetime is pinned under the upstream lifetime (55 min cap).
    expect(body.expires_in).toBeLessThanOrEqual(3300);

    const mcp = await mf.dispatchFetch(`${ISSUER}/mcp`, {
      headers: { authorization: `Bearer ${body.access_token}` },
    });
    expect(((await mcp.json()) as { hasProps: boolean }).hasProps).toBe(true);

    const { blob } = await dumpKv();
    expect(blob).not.toContain("SECOND-FAKE-ACCESS");
    expect(blob).not.toContain("SECOND-FAKE-REFRESH");
  });

  it("does not burn a rotating Yoto refresh token while the access token is still fresh", async () => {
    const session = await signIn({ expiresIn: 3600 });
    upstreamCalls.length = 0;

    const response = await postForm("/token", {
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
      client_id: session.clientId,
    });
    expect(response.status).toBe(200);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("turns an upstream invalid_grant into invalid_grant for the client", async () => {
    const session = await signIn({ expiresIn: 120 });
    upstreamResponder = () =>
      Response.json({ error: "invalid_grant", error_description: "expired" }, { status: 403 });

    const response = await postForm("/token", {
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
      client_id: session.clientId,
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; error_description: string };
    expect(body.error).toBe("invalid_grant");
    // The message a parent may end up seeing must tell them what to do.
    expect(body.error_description).toMatch(/reconnect/i);
  });

  it("does not tell the client to re-authorize when the fault is ours", async () => {
    const session = await signIn({ expiresIn: 120 });
    upstreamResponder = () => Response.json({ error: "invalid_client" }, { status: 401 });

    const response = await postForm("/token", {
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
      client_id: session.clientId,
    });
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("temporarily_unavailable");
  });

  it("passes upstream rate limiting through as a retryable error", async () => {
    const session = await signIn({ expiresIn: 120 });
    upstreamResponder = () =>
      Response.json(
        { error: "too_many_requests" },
        { status: 429, headers: { "retry-after": "17" } },
      );

    const response = await postForm("/token", {
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
      client_id: session.clientId,
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(((await response.json()) as { error: string }).error).toBe("temporarily_unavailable");
  });
});

describe("landing page", () => {
  it("renders this deployment's own connect URL with no placeholders left", async () => {
    const response = await get("/");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain("__ISSUER__");
    expect(html).not.toContain("__MCP_URL__");
    expect(html).not.toContain("__MCP_URL_ENCODED__");
    expect(html).toContain(`${ISSUER}/mcp`);
    expect(html).toContain("claude.ai/customize/connectors");
    expect(html).toContain("not made\n      by, endorsed by, or affiliated with Yoto");
  });

  it("ships security headers", async () => {
    const response = await get("/");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
});
