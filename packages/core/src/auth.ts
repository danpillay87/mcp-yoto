import { z } from "zod";

/**
 * The scopes this server ever requests. Deliberately excludes
 * `family:devices:control` and `family:devices:manage` -- see the plan's
 * "Scopes" decision row: no device-control scopes, so the server is
 * eligible for Yoto's Verified listing. `yoto_get_device_config` therefore
 * expects a 403 in practice (device config needs `family:devices:manage`)
 * and turns that into a friendly FORBIDDEN_SCOPE result rather than a raw
 * failure -- see tools/devices.ts.
 *
 * `family:device-status:view` (the scope yoto.dev/openapi.json lists for
 * GET /device-v2/{deviceId}/status, used by `yoto_player_status`) is
 * deliberately NOT requested: a live sign-in on 2026-09-14 with it in the
 * list was refused by Yoto with `access_denied` before any consent screen,
 * i.e. Yoto does not currently grant it to third-party apps. Requesting it
 * breaks sign-in for everyone, so the tool surfaces FORBIDDEN_SCOPE instead.
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

export type YotoScope = (typeof YOTO_SCOPES)[number];

export const authStatusSchema = z.object({
  signedIn: z.boolean(),
  mode: z.enum(["cli", "remote"]),
  tokenStore: z.enum(["keychain", "file", "remote"]).optional(),
  expiresAt: z.number().optional(),
  scopes: z.array(z.string()).optional(),
  hint: z.string().optional(),
});
export type AuthStatus = z.infer<typeof authStatusSchema>;

export const signInResultSchema = z.object({
  url: z.string().optional(),
  message: z.string(),
});
export type SignInResult = z.infer<typeof signInResultSchema>;

/**
 * Implemented once per entrypoint: `apps/cli` backs this with PKCE +
 * loopback + OS keychain; `apps/worker` backs it by reading
 * `ctx.props` (decrypted by `@cloudflare/workers-oauth-provider`) and never
 * implements `signIn`/`signOut` at all -- there is nothing to run locally in
 * remote mode, so those tools return a message instead of an error. See
 * tools/auth.ts.
 */
export interface AuthAdapter {
  readonly mode: "cli" | "remote";
  getAccessToken(): Promise<string>;
  status(): Promise<AuthStatus>;
  signIn?(opts?: { openBrowser?: boolean }): Promise<SignInResult>;
  signOut?(): Promise<void>;
}
