/**
 * The CLI's `AuthAdapter` (see @mcp-yoto/core's auth.ts): PKCE + loopback +
 * OS keychain, wired together into the shape packages/core's tools expect.
 * apps/worker implements the same interface completely differently (it
 * never signs in locally at all -- see the plan's "remote mode" notes);
 * neither app ever sees the other's implementation.
 */
import {
  type AuthAdapter,
  type AuthStatus,
  type Logger,
  type SignInResult,
  YOTO_SCOPES,
  YotoError,
} from "@mcp-yoto/core";
import type { CliConfig } from "../config.js";
import { awaitLoopbackCallback, LoopbackError } from "./loopback.js";
import { openInBrowser } from "./open-browser.js";
import { createPkcePair, createState } from "./pkce.js";
import { decodeJwtExpMs, Session } from "./session.js";
import { postTokenRequest } from "./token-exchange.js";
import { createTokenStore, type TokenStore } from "./token-store.js";

export interface CreateCliAuthAdapterOptions {
  config: CliConfig;
  logger: Logger;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** The `AuthAdapter` plus the underlying store, so `main.ts`'s `status`/`logout` subcommands can report its kind directly. */
export interface CliAuthAdapter extends AuthAdapter {
  readonly tokenStore: TokenStore;
  /**
   * Widens the base `AuthAdapter.signIn` opts with a CLI-only hook: called
   * synchronously with the authorize URL as soon as it's built, before the
   * loopback callback is ever awaited -- so a caller (main.ts's `login`
   * command) can print it immediately instead of waiting for sign-in to
   * finish. Optional and additive; the `yoto_sign_in` tool path never sets it.
   */
  signIn?(opts?: {
    openBrowser?: boolean;
    onAuthorizeUrl?: (url: string) => void;
  }): Promise<SignInResult>;
}

function redirectUri(port: number): string {
  return `http://127.0.0.1:${port}/callback`;
}

function loopbackErrorToYotoError(error: unknown): YotoError {
  if (error instanceof LoopbackError) {
    if (error.code === "PORT_IN_USE") {
      return new YotoError(error.message, { code: "PORT_IN_USE", hint: error.hint, cause: error });
    }
    if (error.code === "AUTH_TIMEOUT") {
      return new YotoError(error.message, { code: "VALIDATION", hint: error.hint, cause: error });
    }
    return new YotoError(error.message, { code: "UPSTREAM_ERROR", hint: error.hint, cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new YotoError(message, { code: "UPSTREAM_ERROR", cause: error });
}

export async function createCliAuthAdapter(
  options: CreateCliAuthAdapterOptions,
): Promise<CliAuthAdapter> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const tokenStore = await createTokenStore({
    account: options.config.clientId,
    logger: options.logger,
    fileOverride: options.config.tokenFileOverride,
  });
  const session = new Session({
    config: { clientId: options.config.clientId, authBase: options.config.authBase },
    tokenStore,
    fetchImpl,
    now,
  });

  async function signIn(opts?: {
    openBrowser?: boolean;
    onAuthorizeUrl?: (url: string) => void;
  }): Promise<SignInResult> {
    const { verifier, challenge } = createPkcePair();
    const state = createState();
    const port = options.config.redirectPort;

    const authorizeUrl = new URL(`${options.config.authBase}/authorize`);
    authorizeUrl.searchParams.set("audience", options.config.audience);
    authorizeUrl.searchParams.set("scope", YOTO_SCOPES.join(" "));
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", options.config.clientId);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("redirect_uri", redirectUri(port));
    authorizeUrl.searchParams.set("state", state);
    const url = authorizeUrl.toString();

    // Hand the URL to the caller synchronously, before anything below is
    // awaited -- so a caller who wants to print it (main.ts's `login`
    // command) can do so immediately, rather than waiting for the loopback
    // callback to land. The URL carries only a PKCE challenge and a state
    // nonce, both single-use and non-secret -- safe to print/log.
    opts?.onAuthorizeUrl?.(url);

    // Bind the loopback server BEFORE opening the browser -- a busy port
    // must fail loud, not send the user to a callback URL nothing is
    // listening on.
    const callbackPromise = awaitLoopbackCallback({ port, expectedState: state });

    const shouldOpenBrowser = (opts?.openBrowser ?? true) && !options.config.noBrowser;
    if (shouldOpenBrowser) openInBrowser(url);

    let code: string;
    try {
      ({ code } = await callbackPromise);
    } catch (error) {
      throw loopbackErrorToYotoError(error);
    }

    const result = await postTokenRequest(fetchImpl, `${options.config.authBase}/oauth/token`, {
      grant_type: "authorization_code",
      client_id: options.config.clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri(port),
    });

    if (!result.ok) {
      throw new YotoError(
        `Yoto rejected the sign-in code (HTTP ${result.status}${result.error?.error ? `: ${result.error.error}` : ""}).`,
        { code: "UPSTREAM_ERROR", status: result.status },
      );
    }

    await tokenStore.save({
      accessToken: result.data.access_token,
      refreshToken: result.data.refresh_token,
      expiresAt:
        result.data.expires_in !== undefined ? now() + result.data.expires_in * 1000 : undefined,
      scope: result.data.scope ?? YOTO_SCOPES.join(" "),
    });

    // ALWAYS return the URL, even after opening the browser automatically --
    // if the browser didn't actually open (headless box, no default handler
    // registered), the caller still has something to paste.
    return { url, message: "Signed in to Yoto." };
  }

  async function signOut(): Promise<void> {
    await tokenStore.clear();
  }

  return {
    mode: "cli",
    tokenStore,
    async getAccessToken() {
      return session.getAccessToken();
    },
    async status(): Promise<AuthStatus> {
      const stored = await tokenStore.load();
      if (!stored) {
        return {
          signedIn: false,
          mode: "cli",
          tokenStore: tokenStore.kind,
          hint: "Run yoto_sign_in to connect your Yoto account.",
        };
      }
      const expiresAt = decodeJwtExpMs(stored.accessToken) ?? stored.expiresAt;
      return {
        signedIn: true,
        mode: "cli",
        tokenStore: tokenStore.kind,
        expiresAt,
        scopes: stored.scope ? stored.scope.split(" ") : undefined,
      };
    },
    signIn,
    signOut,
  };
}
