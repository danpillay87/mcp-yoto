/**
 * Turns a `TokenStore` into a live access token: reads the JWT's own `exp`
 * claim and trusts it over whatever `expiresAt` was persisted (ported from
 * the old yoto-mcp-server, which found a stored placeholder `expiresAt`
 * making a perfectly live token look dead), refreshes 10 minutes early so a
 * rejected refresh never leaves the caller with zero working credential,
 * and collapses concurrent callers onto one in-flight refresh so three
 * simultaneous tool calls never race Yoto's rotating refresh token against
 * itself.
 */
import { YotoError } from "@mcp-yoto/core";
import { postTokenRequest } from "./token-exchange.js";
import type { StoredTokens, TokenStore } from "./token-store.js";

const REFRESH_SKEW_MS = 10 * 60 * 1000;

export interface SessionConfig {
  clientId: string;
  authBase: string;
}

export interface SessionOptions {
  config: SessionConfig;
  tokenStore: TokenStore;
  /** Injected for tests; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected clock, for deterministic early-refresh tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** Reads the `exp` claim (ms since epoch) out of a JWT's payload, unverified -- we trust it because Yoto issued it to us. */
export function decodeJwtExpMs(token: string): number | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payloadJson = Buffer.from(parts[1] ?? "", "base64url").toString("utf-8");
    const payload = JSON.parse(payloadJson) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Manages the CLI's single Yoto session (there is only ever one -- no
 * multi-account support in this pass). One `Session` instance is created
 * per process and shared by every tool call via the `AuthAdapter`.
 */
export class Session {
  private readonly config: SessionConfig;
  private readonly tokenStore: TokenStore;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private inFlightRefresh: Promise<string> | undefined;

  constructor(options: SessionOptions) {
    this.config = options.config;
    this.tokenStore = options.tokenStore;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Returns a live access token, refreshing first if the current one is
   * within 10 minutes of expiry (or the store carries no readable expiry
   * at all, which fails safe by treating it as due for refresh).
   */
  async getAccessToken(): Promise<string> {
    const stored = await this.tokenStore.load();
    if (!stored) {
      throw new YotoError("Not signed in to Yoto.", {
        code: "NOT_AUTHENTICATED",
        hint: "Run yoto_sign_in.",
      });
    }

    const expiresAt = decodeJwtExpMs(stored.accessToken) ?? stored.expiresAt;
    const now = this.now();
    if (expiresAt !== undefined && expiresAt - REFRESH_SKEW_MS > now) {
      return stored.accessToken;
    }

    if (!stored.refreshToken) {
      // No refresh token on file: a live-but-soon-expiring token is still
      // usable, but once it's actually dead there is nothing left to try.
      if (expiresAt !== undefined && expiresAt > now) return stored.accessToken;
      throw new YotoError("Your Yoto session has expired.", {
        code: "AUTH_EXPIRED",
        hint: "Run yoto_sign_in.",
      });
    }

    return this.refresh(stored.refreshToken);
  }

  /** Single-flight: concurrent callers share the one in-flight refresh instead of each starting their own. */
  private refresh(refreshToken: string): Promise<string> {
    if (!this.inFlightRefresh) {
      this.inFlightRefresh = this.doRefresh(refreshToken).finally(() => {
        this.inFlightRefresh = undefined;
      });
    }
    return this.inFlightRefresh;
  }

  private async doRefresh(refreshToken: string): Promise<string> {
    const result = await postTokenRequest(this.fetchImpl, `${this.config.authBase}/oauth/token`, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.config.clientId,
    });

    if (!result.ok) {
      if (result.error?.error === "invalid_grant") {
        // Yoto has already invalidated this refresh token server-side (it's
        // rotating) -- there is nothing to retry. Clear the local store so
        // yoto_status reports "not signed in" rather than a token we know is dead.
        await this.tokenStore.clear();
        throw new YotoError("Yoto rejected the stored refresh token.", {
          code: "AUTH_EXPIRED",
          hint: "Run yoto_sign_in.",
        });
      }
      throw new YotoError(`Yoto token refresh failed (HTTP ${result.status}).`, {
        code: "UPSTREAM_ERROR",
        retryable: true,
        status: result.status,
      });
    }

    const data = result.data;
    const newTokens: StoredTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: data.expires_in !== undefined ? this.now() + data.expires_in * 1000 : undefined,
      scope: data.scope,
    };
    // Persist BEFORE returning: if the process dies right after this call,
    // the rotating refresh token Yoto just invalidated server-side must not
    // be lost along with it -- the new one has to be on disk first.
    await this.tokenStore.save(newTokens);
    return newTokens.accessToken;
  }
}
