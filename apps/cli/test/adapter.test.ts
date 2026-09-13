import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, YOTO_SCOPES } from "@mcp-yoto/core";
import { afterEach, describe, expect, it } from "vitest";
import { createCliAuthAdapter } from "../src/auth/adapter.js";
import type { CliConfig } from "../src/config.js";

/** Binds to an ephemeral port to find one that's free, then releases it. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function baseConfig(overrides: Partial<CliConfig>): CliConfig {
  return {
    clientId: "test-client",
    authBase: "https://login.example.test",
    audience: "https://api.example.test",
    redirectPort: 0,
    noBrowser: true,
    logLevel: "error",
    iconBaseUrl: "https://icons.example.test",
    scope: YOTO_SCOPES.join(" "),
    ...overrides,
  };
}

const okTokenFetch: typeof fetch = (async () =>
  new Response(
    JSON.stringify({
      access_token: "test-access-token",
      refresh_token: "test-refresh-token",
      expires_in: 3600,
      scope: YOTO_SCOPES.join(" "),
    }),
    { status: 200 },
  )) as typeof fetch;

describe("createCliAuthAdapter -- signIn", () => {
  let tmpDir: string | undefined;
  let occupier: Server | undefined;

  afterEach(async () => {
    if (occupier) {
      await new Promise<void>((resolve) => occupier?.close(() => resolve()));
      occupier = undefined;
    }
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("hands the authorize URL to onAuthorizeUrl synchronously -- before the loopback callback is ever awaited", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "mcp-yoto-adapter-"));
    const port = await getFreePort();
    const config = baseConfig({
      redirectPort: port,
      tokenFileOverride: join(tmpDir, "tokens.json"),
    });

    const adapter = await createCliAuthAdapter({
      config,
      logger: createLogger(),
      fetchImpl: okTokenFetch,
    });
    if (!adapter.signIn) throw new Error("adapter.signIn must be defined for the CLI adapter.");

    let capturedUrl: string | undefined;
    const signInPromise = adapter.signIn({
      openBrowser: false,
      onAuthorizeUrl: (url) => {
        capturedUrl = url;
      },
    });

    // signIn()'s synchronous prefix -- building the PKCE pair, the state,
    // and the authorize URL, then invoking onAuthorizeUrl -- has already run
    // by the time the call above returns a (still-pending) promise, because
    // the function doesn't hit its first `await` until it waits on the
    // loopback callback. So the URL must already be captured here, with
    // nothing done yet to satisfy that callback.
    expect(capturedUrl).toBeDefined();
    expect(capturedUrl).toMatch(/^https:\/\/login\.example\.test\/authorize\?/);
    const state = new URL(capturedUrl ?? "").searchParams.get("state");
    expect(state).toBeTruthy();

    // Now satisfy the callback the promise above is actually waiting on.
    const response = await fetch(`http://127.0.0.1:${port}/callback?code=test-code&state=${state}`);
    expect(response.status).toBe(200);

    const result = await signInPromise;
    expect(result.url).toBe(capturedUrl);
    expect(result.message).toBe("Signed in to Yoto.");
  });

  it("maps a busy loopback port to YotoError code PORT_IN_USE (not VALIDATION), keeping the hint", async () => {
    const port = await getFreePort();
    occupier = createServer((_req, res) => res.end("occupied"));
    await new Promise<void>((resolve) => occupier?.listen(port, "127.0.0.1", () => resolve()));

    tmpDir = await mkdtemp(join(tmpdir(), "mcp-yoto-adapter-"));
    const config = baseConfig({
      redirectPort: port,
      tokenFileOverride: join(tmpDir, "tokens.json"),
    });
    const adapter = await createCliAuthAdapter({
      config,
      logger: createLogger(),
      fetchImpl: okTokenFetch,
    });
    if (!adapter.signIn) throw new Error("adapter.signIn must be defined for the CLI adapter.");

    await expect(adapter.signIn({ openBrowser: false })).rejects.toMatchObject({
      name: "YotoError",
      code: "PORT_IN_USE",
      hint: expect.stringContaining("YOTO_REDIRECT_PORT"),
    });
  });
});
