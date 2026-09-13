/**
 * Configuration for the `npx mcp-yoto` CLI, read from `process.env`.
 *
 * This is the ONE place in apps/cli that touches `process.env` directly --
 * every other module takes an explicit value (a `CliConfig`, a clock, a
 * `fetchImpl`) so it stays trivially testable without mutating globals.
 *
 * Mirrors apps/worker's config.ts decisions (same Yoto auth base, same
 * scope list) but is CLI-only: no KV, no OAuthProvider, no `Env` binding.
 */
import { YOTO_SCOPES } from "@mcp-yoto/core";

/**
 * Yoto's public PKCE client for the CLI's existing dev app -- safe to ship
 * in source (no client secret; PKCE is the confidentiality mechanism).
 * Overridable via YOTO_CLIENT_ID for anyone running their own registered
 * Yoto dev app.
 */
export const DEFAULT_CLIENT_ID = "xl4YsMpHEMnn7ubVhsRu8NhBwfUFPf8J";

export const YOTO_AUTH_BASE = "https://login.yotoplay.com";
export const AUDIENCE = "https://api.yotoplay.com";
export const DEFAULT_REDIRECT_PORT = 8791;
export const DEFAULT_ICON_BASE_URL =
  "https://raw.githubusercontent.com/danpillay87/mcp-yoto/main/apps/worker/public/icons";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface CliConfig {
  clientId: string;
  authBase: string;
  audience: string;
  /** Loopback port for PKCE sign-in. Must match the redirect URI registered at Yoto. */
  redirectPort: number;
  /** True when YOTO_NO_BROWSER is set -- print the sign-in URL instead of opening a browser. */
  noBrowser: boolean;
  logLevel: LogLevel;
  iconBaseUrl: string;
  /** Space-joined scopes this connection ever requests. Never devices:control/manage. */
  scope: string;
  /**
   * Advanced/testing override: forces the token store to a plain file at this
   * path, skipping the OS keychain entirely. Used by the stdio-purity test to
   * sandbox credential storage in a temp directory without touching a real
   * keychain or `~/.config/mcp-yoto`. Not documented as a normal user-facing
   * knob (see README's env var table), but harmless to set by hand too.
   */
  tokenFileOverride?: string;
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(
      `YOTO_REDIRECT_PORT must be an integer between 1 and 65535, got ${JSON.stringify(raw)}.`,
    );
  }
  return parsed;
}

function parseLogLevel(raw: string | undefined): LogLevel {
  return raw === "debug" || raw === "warn" || raw === "error" ? raw : "info";
}

function parseBoolFlag(raw: string | undefined): boolean {
  return raw === "1" || raw?.toLowerCase() === "true";
}

/** Reads and validates configuration from `env` (defaults to `process.env`). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): CliConfig {
  return {
    clientId: env.YOTO_CLIENT_ID || DEFAULT_CLIENT_ID,
    authBase: YOTO_AUTH_BASE,
    audience: AUDIENCE,
    redirectPort: parsePort(env.YOTO_REDIRECT_PORT, DEFAULT_REDIRECT_PORT),
    noBrowser: parseBoolFlag(env.YOTO_NO_BROWSER),
    logLevel: parseLogLevel(env.LOG_LEVEL),
    iconBaseUrl: env.MCP_YOTO_ICON_BASE || DEFAULT_ICON_BASE_URL,
    scope: YOTO_SCOPES.join(" "),
    tokenFileOverride: env.MCP_YOTO_TOKEN_FILE || undefined,
  };
}
