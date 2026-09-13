import { defineConfig } from "tsup";

/**
 * Bundles the single entry point that gets published to npm.
 *
 * `@mcp-yoto/core` is a private workspace package (see its package.json --
 * `"private": true`) that never reaches the npm registry, so anyone
 * installing `mcp-yoto` standalone (outside this monorepo) would fail to
 * resolve it at runtime unless its source is inlined here (`noExternal`).
 * Everything else this depends on -- the MCP SDK, zod, the optional native
 * keyring binding -- IS a real, independently-published package, so those
 * stay external and get resolved from the consumer's own node_modules at
 * install time (see package.json's dependencies/optionalDependencies).
 *
 * `tsc -b` (this package's own "build" step, run first) already produced
 * type-checked `.d.ts`/`.js` output for every module under dist/ across the
 * whole project-reference graph; this only needs to replace dist/main.js
 * with the self-contained bundle bin/mcp-yoto.mjs actually loads.
 */
export default defineConfig({
  entry: { main: "src/main.ts" },
  outDir: "dist",
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: false,
  dts: false,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  noExternal: ["@mcp-yoto/core"],
  external: ["@modelcontextprotocol/*", "@napi-rs/keyring", "zod"],
});
