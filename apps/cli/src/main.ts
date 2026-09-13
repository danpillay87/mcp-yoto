/**
 * mcp-yoto CLI entrypoint (stdio). Phase 0 stub -- the real PKCE loopback +
 * OS-keychain-backed stdio server (see the plan's "CLI auth" section) lands
 * in Phase 2, built from the 14 yoto_* tools in @mcp-yoto/core.
 *
 * Known Phase 6 gap: @mcp-yoto/core is a private workspace package (not
 * published to npm), so the published `mcp-yoto` package will need a
 * bundling step (tsup/esbuild) to inline it -- npm will not resolve a
 * private workspace dependency for anyone who isn't inside this monorepo.
 * Not a Phase 0 concern; noted here so Phase 6 doesn't rediscover it.
 */

/**
 * Yoto's public PKCE client -- safe to ship in source (no client secret;
 * PKCE is the confidentiality mechanism here). Overridable via
 * YOTO_CLIENT_ID for anyone running their own registered Yoto dev app.
 */
export const DEFAULT_CLIENT_ID = "xl4YsMpHEMnn7ubVhsRu8NhBwfUFPf8J"; // public PKCE client — overridable via YOTO_CLIENT_ID

export async function main(): Promise<void> {
  console.error("mcp-yoto: scaffold stub -- the real stdio server lands in Phase 2.");
  process.exitCode = 1;
}
