import { describe, expect, it, vi } from "vitest";
import { Session } from "../src/auth/session.js";
import type { StoredTokens, TokenStore } from "../src/auth/token-store.js";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.`;
}

class FakeTokenStore implements TokenStore {
  readonly kind = "file" as const;
  private tokens: StoredTokens | undefined;
  clearCalls = 0;
  saveCalls: StoredTokens[] = [];

  constructor(initial?: StoredTokens) {
    this.tokens = initial;
  }

  async load(): Promise<StoredTokens | undefined> {
    return this.tokens;
  }

  async save(tokens: StoredTokens): Promise<void> {
    this.saveCalls.push(tokens);
    this.tokens = tokens;
  }

  async clear(): Promise<void> {
    this.clearCalls += 1;
    this.tokens = undefined;
  }
}

const CONFIG = { clientId: "client-1", authBase: "https://login.example.test" };

describe("Session.getAccessToken", () => {
  it("returns the stored token as-is when its JWT exp is well beyond the 10-minute skew", async () => {
    const now = 1_000_000_000_000;
    const farExp = Math.floor(now / 1000) + 3600; // 1h from now
    const originalAccessToken = makeJwt({ exp: farExp });
    const store = new FakeTokenStore({
      accessToken: originalAccessToken,
      refreshToken: "rt",
    });
    const fetchImpl = vi.fn();
    const session = new Session({ config: CONFIG, tokenStore: store, fetchImpl, now: () => now });

    const token = await session.getAccessToken();
    expect(token).toBe(originalAccessToken);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes 10 minutes early when the JWT exp is inside the skew window, trusting exp over stored expiresAt", async () => {
    const now = 1_000_000_000_000;
    const soonExp = Math.floor(now / 1000) + 300; // 5 min from now -- inside the 10-min skew
    const newAccessToken = makeJwt({ exp: Math.floor(now / 1000) + 3600 });
    const store = new FakeTokenStore({
      accessToken: makeJwt({ exp: soonExp }),
      refreshToken: "rt-1",
      expiresAt: now + 3_600_000, // deliberately wrong/stale -- exp must win
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ access_token: newAccessToken, refresh_token: "rt-2", expires_in: 3600 }),
          {
            status: 200,
          },
        ),
    );
    const session = new Session({ config: CONFIG, tokenStore: store, fetchImpl, now: () => now });

    const token = await session.getAccessToken();
    expect(token).toBe(newAccessToken);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt-1");
    // The rotating refresh token must be persisted before the caller gets the new access token.
    expect(store.saveCalls).toHaveLength(1);
    expect(store.saveCalls[0]?.refreshToken).toBe("rt-2");
  });

  it("collapses three concurrent callers onto a single in-flight refresh", async () => {
    const now = 1_000_000_000_000;
    const soonExp = Math.floor(now / 1000) + 60;
    const store = new FakeTokenStore({
      accessToken: makeJwt({ exp: soonExp }),
      refreshToken: "rt",
    });

    let resolveFetch!: (response: Response) => void;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const session = new Session({ config: CONFIG, tokenStore: store, fetchImpl, now: () => now });

    const calls = Promise.all([
      session.getAccessToken(),
      session.getAccessToken(),
      session.getAccessToken(),
    ]);

    // Let all three calls reach the refresh path before the fetch resolves.
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    resolveFetch(
      new Response(
        JSON.stringify({
          access_token: makeJwt({ exp: soonExp + 3600 }),
          refresh_token: "rt-new",
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    );

    const results = await calls;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(new Set(results).size).toBe(1);
  });

  it("on invalid_grant: clears the store and throws AUTH_EXPIRED, with no retry", async () => {
    const now = 1_000_000_000_000;
    const soonExp = Math.floor(now / 1000) + 60;
    const store = new FakeTokenStore({
      accessToken: makeJwt({ exp: soonExp }),
      refreshToken: "dead-rt",
    });
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    );
    const session = new Session({ config: CONFIG, tokenStore: store, fetchImpl, now: () => now });

    await expect(session.getAccessToken()).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect(store.clearCalls).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // A subsequent call sees the cleared store -- not signed in, not another refresh attempt.
    await expect(session.getAccessToken()).rejects.toMatchObject({ code: "NOT_AUTHENTICATED" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws NOT_AUTHENTICATED when nothing has ever been signed in", async () => {
    const store = new FakeTokenStore(undefined);
    const session = new Session({ config: CONFIG, tokenStore: store, fetchImpl: vi.fn() });
    await expect(session.getAccessToken()).rejects.toMatchObject({ code: "NOT_AUTHENTICATED" });
  });
});
