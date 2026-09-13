/**
 * Builds the CLI's `McpServer` (all 14 `yoto_*` tools + resources + prompts,
 * via `@mcp-yoto/core`'s `createServer`) and serves it over stdio.
 *
 * `StdioServerTransport` lives at `@modelcontextprotocol/server/stdio`, NOT
 * `@modelcontextprotocol/node` (that package is Node-specific HTTP
 * transports for a server that speaks Streamable HTTP over `node:http` --
 * apps/worker's Cloudflare-hosted equivalent is `@modelcontextprotocol/hono`;
 * neither is stdio). Confirmed against the installed package's own
 * `dist/stdio.d.mts` -- see the report handed back after this phase.
 */

import { createRequire } from "node:module";
import { type AuthAdapter, createServer, type Logger, type YotoClient } from "@mcp-yoto/core";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { resolveAudio, resolveImage } from "./resolve.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

export interface CreateCliServerOptions {
  auth: AuthAdapter;
  client: YotoClient;
  logger: Logger;
  iconBaseUrl?: string;
}

export function createCliServer(options: CreateCliServerOptions) {
  return createServer(
    {
      auth: options.auth,
      client: options.client,
      logger: options.logger,
      iconBaseUrl: options.iconBaseUrl,
      resolveAudio,
      resolveImage,
      mode: "cli",
    },
    {
      name: "mcp-yoto",
      version,
      title: "Yoto (Works with Yoto)",
      iconBaseUrl: options.iconBaseUrl,
      websiteUrl: "https://github.com/danpillay87/mcp-yoto",
    },
  );
}

/** Connects the server to the current process's stdin/stdout. Never resolves until the transport closes. */
export async function runStdioServer(options: CreateCliServerOptions): Promise<void> {
  const server = createCliServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
