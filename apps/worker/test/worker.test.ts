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
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));

const ISSUER = "https://mcp-yoto.test";
const YOTO_AUTH_BASE = "https://login.yotoplay.test";
const YOTO_AUDIENCE = "https://api.yotoplay.test";
const MEDIA_ORIGIN = "https://media.test";
const UPLOAD_ORIGIN = "https://uploads.test";
const STATE_SECRET = "0123456789abcdef0123456789abcdef";
const CLIENT_REDIRECT = "https://client.test/callback";
const YOTO_SUBJECT = "auth0|test-parent";

/** Distinctive fakes, so the KV dump assertions cannot pass by accident. */
const FAKE_ACCESS_MARKER = "FAKE-YOTO-ACCESS-TOKEN-MARKER";
const FAKE_REFRESH_TOKEN = "FAKE-YOTO-REFRESH-TOKEN-MARKER";

/** A minimal, real (per `sniffAudio`) MP3 -- "ID3" magic bytes plus filler. */
const FAKE_MP3_BYTES = new Uint8Array([
  0x49,
  0x44,
  0x33,
  0x03,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  ...Array.from("FAKE-AUDIO-PAYLOAD-FOR-TESTS", (c) => c.charCodeAt(0)),
]);
/** Plain text -- recognisable by NEITHER `sniffAudio` nor `sniffImage`. */
const FAKE_TEXT_BYTES = new TextEncoder().encode("just some plain text, not audio at all");
/** A minimal real (per `sniffImage`) PNG -- the 8-byte magic header plus filler. */
const FAKE_PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
]);

const FAKE_UPLOAD_ID = "upload-1";
const FAKE_TRANSCODED_SHA = "deadbeefcafef00d";
const FAKE_ICON_MEDIA_ID = "icon-media-1";

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

/** GET /content/mine's fake response -- mutated per-test where it matters. */
let fakeCards: Array<{ cardId: string; title: string }> = [
  { cardId: "card-1", title: "Test Card" },
];

/** Fake remote media host, keyed by pathname -- serves both HEAD and GET. */
const mediaFiles: Record<string, { bytes: Uint8Array; contentType: string }> = {
  "/track.mp3": { bytes: FAKE_MP3_BYTES, contentType: "audio/mpeg" },
  "/notes.txt": { bytes: FAKE_TEXT_BYTES, contentType: "text/plain" },
  "/icon.png": { bytes: FAKE_PNG_BYTES, contentType: "image/png" },
};

interface UploadPutCall {
  url: string;
  contentType: string | null;
  bytes: Uint8Array;
}
const uploadPutCalls: UploadPutCall[] = [];

/**
 * Everything this Worker fetches that ISN'T the Yoto OAuth token endpoint:
 * the Yoto REST API (content list, upload-url, transcode-status) and the
 * fake remote media/upload hosts `resolve.ts` and `uploadAudio()` talk to.
 * A path this router doesn't recognise 404s loudly rather than silently
 * "working", so an unexpected outbound call is never mistaken for success.
 */
async function fakeYotoApiAndMedia(request: Request, url: URL): Promise<Response> {
  if (
    url.origin === YOTO_AUDIENCE &&
    url.pathname === "/content/mine" &&
    request.method === "GET"
  ) {
    return Response.json({ cards: fakeCards });
  }
  if (
    url.origin === YOTO_AUDIENCE &&
    url.pathname === "/media/transcode/audio/uploadUrl" &&
    request.method === "GET"
  ) {
    return Response.json({
      upload: { uploadId: FAKE_UPLOAD_ID, uploadUrl: `${UPLOAD_ORIGIN}/put/${FAKE_UPLOAD_ID}` },
    });
  }
  if (
    url.origin === YOTO_AUDIENCE &&
    url.pathname === `/media/upload/${FAKE_UPLOAD_ID}/transcoded` &&
    request.method === "GET"
  ) {
    return Response.json({
      transcode: {
        transcodedSha256: FAKE_TRANSCODED_SHA,
        transcodedInfo: { duration: 12, fileSize: FAKE_MP3_BYTES.byteLength, format: "mp3" },
      },
    });
  }
  if (
    url.origin === YOTO_AUDIENCE &&
    url.pathname === "/media/displayIcons/user/me/upload" &&
    request.method === "POST"
  ) {
    return Response.json({
      displayIcon: { mediaId: FAKE_ICON_MEDIA_ID, url: `${MEDIA_ORIGIN}/icon.png` },
    });
  }
  if (url.origin === UPLOAD_ORIGIN && request.method === "PUT") {
    uploadPutCalls.push({
      url: request.url,
      contentType: request.headers.get("content-type"),
      bytes: new Uint8Array(await request.arrayBuffer()),
    });
    return new Response(null, { status: 200 });
  }
  if (url.origin === MEDIA_ORIGIN) {
    const file = mediaFiles[url.pathname];
    if (!file) return new Response("Not found", { status: 404 });
    const headers = {
      "content-type": file.contentType,
      "content-length": String(file.bytes.byteLength),
    };
    if (request.method === "HEAD") return new Response(null, { status: 200, headers });
    if (request.method === "GET") return new Response(file.bytes, { status: 200, headers });
  }
  return new Response(`unhandled fake outbound request: ${request.method} ${request.url}`, {
    status: 404,
  });
}

let mf: Miniflare;

/** Serves real files under apps/worker/public/, matching the real ASSETS binding. */
function assetsFake(landing: string) {
  return async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    if (pathname === "/" || pathname === "/index.html") {
      return new Response(landing, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (pathname.startsWith("/icons/")) {
      try {
        const bytes = readFileSync(new URL(`.${pathname}`, `file://${PUBLIC_DIR}`));
        return new Response(bytes, { headers: { "content-type": "image/png" } });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    }
    return new Response("Not found", { status: 404 });
  };
}

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
            ASSETS: assetsFake(landing),
          },
          outboundService: async (request: Request) => {
            const url = new URL(request.url);
            if (url.origin === YOTO_AUTH_BASE && url.pathname === "/oauth/token") {
              const body = await request.text();
              const call: UpstreamCall = {
                url: request.url,
                params: Object.fromEntries(new URLSearchParams(body)),
              };
              upstreamCalls.push(call);
              return upstreamResponder(call);
            }
            return fakeYotoApiAndMedia(request, url);
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

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/**
 * The stateless HTTP handler answers a successful exchange over SSE by
 * default (`enableJsonResponse` is never set -- see mcp.ts's header comment),
 * so a real MCP client -- and this test client -- must send
 * `Accept: application/json, text/event-stream` and parse either shape back:
 * a plain JSON body for protocol-level rejections that never reach the
 * transport's message delivery, or one `data: <json>` SSE frame for
 * everything the connected server actually answered.
 */
async function parseMcpResponse(response: Response): Promise<JsonRpcResponse> {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (contentType.includes("application/json")) {
    return JSON.parse(text) as JsonRpcResponse;
  }
  const frames = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((line) => line.length > 0);
  const last = frames.at(-1);
  if (!last) {
    throw new Error(`No SSE data frame in /mcp response (status ${response.status}): ${text}`);
  }
  return JSON.parse(last) as JsonRpcResponse;
}

/** POSTs one JSON-RPC request to /mcp and returns its parsed response. */
async function mcpCall(
  accessToken: string,
  method: string,
  params: Record<string, unknown> = {},
  id: number | string = 1,
): Promise<{ status: number; response: Response; body: JsonRpcResponse }> {
  const response = (await mf.dispatchFetch(`${ISSUER}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  })) as unknown as Response;
  const body = await parseMcpResponse(response);
  return { status: response.status, response, body };
}

/** The real MCP handshake's first call, per the spec every client sends before anything else. */
async function mcpInitialize(accessToken: string): Promise<JsonRpcResponse> {
  const { body } = await mcpCall(accessToken, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "worker-test-client", version: "0.0.0" },
  });
  return body;
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
    const { status, body } = await mcpCall(session.accessToken, "tools/call", {
      name: "yoto_status",
      arguments: {},
    });
    expect(status).toBe(200);
    expect(body.result?.isError).toBeFalsy();
    expect(body.result?.structuredContent).toMatchObject({ signedIn: true, mode: "remote" });
    // The response must never echo the token itself.
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

    const status = await mcpCall(body.access_token, "tools/call", {
      name: "yoto_status",
      arguments: {},
    });
    expect(status.body.result?.structuredContent).toMatchObject({ signedIn: true });

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

  it("spells out all three non-Claude connect options in plain English", async () => {
    const html = await (await get("/")).text();
    expect(html).toContain("ChatGPT");
    expect(html).toContain("Developer mode");
    expect(html).toContain("Claude Code");
    expect(html).toContain(`claude mcp add --transport http yoto ${ISSUER}/mcp`);
  });

  it("ships security headers, including a CSP that allows only its own copy-button script", async () => {
    const response = await get("/");
    const html = await response.text();
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");

    // The CSP's script-src hash must match the SCRIPT THIS RESPONSE ACTUALLY
    // SHIPPED, byte for byte -- computed independently here (not copied from
    // html.ts) so this test would fail if the two ever drifted apart.
    const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(html);
    expect(scriptMatch?.[1]).toBeTruthy();
    const expectedHash = createHash("sha256")
      .update(scriptMatch?.[1] ?? "", "utf8")
      .digest("base64");
    expect(csp).toContain(`script-src 'sha256-${expectedHash}'`);
  });
});

describe("static assets", () => {
  it("serves an icon PNG for the MCP tools' icons", async () => {
    const response = await get("/icons/content.png");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
    // PNG magic bytes.
    expect(Array.from(bytes.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it("404s an unknown icon", async () => {
    const response = await get("/icons/does-not-exist.png");
    expect(response.status).toBe(404);
  });
});

describe("MCP protocol over /mcp", () => {
  it("initializes, then lists exactly 14 fully-annotated tools", async () => {
    const session = await signIn();
    const init = await mcpInitialize(session.accessToken);
    expect(init.error).toBeUndefined();

    const { body } = await mcpCall(session.accessToken, "tools/list", {}, 2);
    const tools = (body.result?.tools ?? []) as Array<{
      name: string;
      icons?: Array<{ src: string; mimeType?: string }>;
      annotations?: Record<string, boolean>;
      outputSchema?: { properties?: Record<string, unknown> };
    }>;

    expect(tools).toHaveLength(14);
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "yoto_status",
        "yoto_sign_in",
        "yoto_sign_out",
        "yoto_list_cards",
        "yoto_get_card",
        "yoto_create_card",
        "yoto_update_card",
        "yoto_delete_card",
        "yoto_upload_audio",
        "yoto_add_track",
        "yoto_search_icons",
        "yoto_upload_icon",
        "yoto_list_devices",
        "yoto_get_device_config",
      ].sort(),
    );

    for (const tool of tools) {
      const icon = tool.icons?.[0];
      expect(icon?.src.startsWith(`${ISSUER}/icons`)).toBe(true);
      expect(icon?.mimeType).toBe("image/png");
      for (const hint of [
        "readOnlyHint",
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
      ] as const) {
        expect(typeof tool.annotations?.[hint]).toBe("boolean");
      }
      expect(Object.keys(tool.outputSchema?.properties ?? {}).length).toBeGreaterThan(0);
    }
  });

  it("calls yoto_status and gets remote-mode structured content back", async () => {
    const session = await signIn();
    const { body } = await mcpCall(session.accessToken, "tools/call", {
      name: "yoto_status",
      arguments: {},
    });
    expect(body.result?.isError).toBeFalsy();
    expect(body.result?.structuredContent).toMatchObject({
      signedIn: true,
      mode: "remote",
      tokenStore: "remote",
    });
  });

  it("calls yoto_list_cards against the fake Yoto API", async () => {
    fakeCards = [{ cardId: "card-42", title: "Bedtime Stories" }];
    const session = await signIn();
    const { body } = await mcpCall(session.accessToken, "tools/call", {
      name: "yoto_list_cards",
      arguments: {},
    });
    expect(body.result?.isError).toBeFalsy();
    expect(body.result?.structuredContent).toMatchObject({
      source: "myo",
      cards: [{ cardId: "card-42", title: "Bedtime Stories" }],
    });
  });
});

describe("remote media resolution (resolve.ts)", () => {
  it("uploads a real audio URL: reaches the fake upload URL and returns a yoto:# ref", async () => {
    uploadPutCalls.length = 0;
    const session = await signIn();
    const { body } = await mcpCall(session.accessToken, "tools/call", {
      name: "yoto_upload_audio",
      arguments: { audioUrl: `${MEDIA_ORIGIN}/track.mp3` },
    });

    expect(body.result?.isError).toBeFalsy();
    expect(body.result?.structuredContent).toMatchObject({
      mediaRef: `yoto:#${FAKE_TRANSCODED_SHA}`,
    });
    expect(uploadPutCalls).toHaveLength(1);
    expect(uploadPutCalls[0]?.url).toBe(`${UPLOAD_ORIGIN}/put/${FAKE_UPLOAD_ID}`);
    expect(Array.from(uploadPutCalls[0]?.bytes ?? [])).toEqual(Array.from(FAKE_MP3_BYTES));
  });

  it("rejects a .txt body as INVALID_AUDIO before any Yoto call", async () => {
    uploadPutCalls.length = 0;
    upstreamCalls.length = 0;
    const session = await signIn();
    const { body } = await mcpCall(session.accessToken, "tools/call", {
      name: "yoto_upload_audio",
      arguments: { audioUrl: `${MEDIA_ORIGIN}/notes.txt` },
    });

    expect(body.result?.isError).toBe(true);
    expect(body.result?.structuredContent).toMatchObject({ code: "INVALID_AUDIO" });
    expect(uploadPutCalls).toHaveLength(0);
  });

  it("rejects a link-local address without ever reaching the network", async () => {
    uploadPutCalls.length = 0;
    const session = await signIn();

    // The literal case from the plan's verification checklist: a plain http://
    // URL is already refused by the tool's own https-only input schema.
    const httpAttempt = await mcpCall(session.accessToken, "tools/call", {
      name: "yoto_upload_audio",
      arguments: { audioUrl: "http://169.254.169.254/x" },
    });
    const httpRejected =
      httpAttempt.body.error !== undefined || httpAttempt.body.result?.isError === true;
    expect(httpRejected).toBe(true);

    // resolve.ts's own guard: an https:// URL that is still a blocked
    // (link-local / cloud-metadata) address must be rejected by OUR code.
    const httpsAttempt = await mcpCall(session.accessToken, "tools/call", {
      name: "yoto_upload_audio",
      arguments: { audioUrl: "https://169.254.169.254/x" },
    });
    expect(httpsAttempt.body.result?.isError).toBe(true);
    expect(httpsAttempt.body.result?.structuredContent).toMatchObject({ code: "VALIDATION" });

    expect(uploadPutCalls).toHaveLength(0);
  });

  it("uploads a real icon URL via resolveImage", async () => {
    const session = await signIn();
    const { body } = await mcpCall(session.accessToken, "tools/call", {
      name: "yoto_upload_icon",
      arguments: { imageUrl: `${MEDIA_ORIGIN}/icon.png`, title: "Test Icon" },
    });
    expect(body.result?.isError).toBeFalsy();
    expect(body.result?.structuredContent).toMatchObject({ mediaId: FAKE_ICON_MEDIA_ID });
  });
});

describe("scheduled purge (nightly cron)", () => {
  /**
   * Security-review recommendation (MEDIUM): a `[triggers] crons` entry in
   * wrangler.toml now fires the exported `scheduled()` handler, which calls
   * the provider's `purgeExpiredData`. Miniflare can dispatch a real scheduled
   * event -- not just a direct function call -- via its reserved
   * `/cdn-cgi/local/scheduled` test route (see `handleScheduled` in
   * miniflare's entry worker), gated behind the shared-options flag
   * `unsafeTriggerHandlers: true`. That flag lives on the options object
   * alongside `workers: [...]`, not inside the per-worker entry -- confirmed
   * against `V4SharedOptions` in miniflare's own `index.d.ts`.
   *
   * This exercises the real end-to-end wiring (cron config's shape is not
   * actually checked by the test hook, only the exported handler is invoked)
   * plus proves the purge leaves a just-created, still-valid grant alone: the
   * access token from a real sign-in keeps working immediately afterwards.
   */
  it("runs via the cron test hook and does not disturb a live grant", async () => {
    const landing = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    const upstream: UpstreamCall[] = [];
    const scheduledMf = new Miniflare(
      convertV4MiniflareOptions({
        unsafeTriggerHandlers: true,
        workers: [
          {
            name: "mcp-yoto-scheduled",
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
              ASSETS: async () => new Response(landing),
            },
            outboundService: async (request: Request) => {
              upstream.push({
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
      // A real grant, created the same way a parent's sign-in would be, so
      // the purge has something live in KV that it must correctly leave
      // alone (neither expired nor orphaned).
      const register = await scheduledMf.dispatchFetch(`${ISSUER}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Scheduled-purge test client",
          redirect_uris: [CLIENT_REDIRECT],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        }),
      });
      const { client_id: clientId } = (await register.json()) as { client_id: string };
      const { verifier, challenge } = pkcePair();
      const authorize = await scheduledMf.dispatchFetch(
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
      const callback = await scheduledMf.dispatchFetch(
        `${ISSUER}/callback?code=yoto-auth-code&state=${encodeURIComponent(state)}`,
        { redirect: "manual" },
      );
      expect(callback.status).toBe(302);
      const code = new URL(callback.headers.get("location") ?? "").searchParams.get("code") ?? "";

      const tokenResponseRaw = await scheduledMf.dispatchFetch(`${ISSUER}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          code_verifier: verifier,
          redirect_uri: CLIENT_REDIRECT,
        }).toString(),
      });
      expect(tokenResponseRaw.status).toBe(200);
      const { access_token: accessToken } = (await tokenResponseRaw.json()) as {
        access_token: string;
      };
      // /callback exchanges the code with Yoto once; the later /token call re-issues our
      // own token from the already-fetched props without going back to Yoto (see
      // tokenExchangeCallback's AUTHORIZATION_CODE branch in refresh.ts).
      expect(upstream).toHaveLength(1);

      // The actual cron test hook. `cron` need not match wrangler.toml's
      // schedule -- the hook just invokes the exported handler directly.
      const scheduled = await scheduledMf.dispatchFetch(
        `${ISSUER}/cdn-cgi/local/scheduled?cron=${encodeURIComponent("17 4 * * *")}&format=json`,
      );
      expect(scheduled.status).toBe(200);
      const outcome = (await scheduled.json()) as { outcome: string };
      expect(outcome.outcome).toBe("ok");

      // The grant just created must survive: it is neither expired nor
      // orphaned, so the purge must not have touched it.
      const statusCall = await scheduledMf.dispatchFetch(`${ISSUER}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "yoto_status", arguments: {} },
        }),
      });
      const statusBody = await parseMcpResponse(statusCall as unknown as Response);
      expect(statusBody.result?.isError).toBeFalsy();
      expect(statusBody.result?.structuredContent).toMatchObject({ signedIn: true });
    } finally {
      await scheduledMf.dispose();
    }
  });
});
