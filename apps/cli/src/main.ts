/**
 * `npx mcp-yoto` entrypoint (invoked via bin/mcp-yoto.mjs).
 *
 * stdout is reserved for JSON-RPC frames when running as an MCP server
 * (the default, no-subcommand mode) -- every diagnostic goes to stderr.
 * `status` is the one deliberate exception: it prints its `AuthStatus` JSON
 * to stdout, because it's meant to be piped/parsed by a human or script
 * checking sign-in state, not read by an MCP client. See test/stdio-purity.test.ts.
 */

import { createRequire } from "node:module";
import { type LogLevel as CoreLogLevel, createLogger, YotoClient } from "@mcp-yoto/core";
import { createCliAuthAdapter } from "./auth/adapter.js";
import { DEFAULT_CLIENT_ID, loadConfig } from "./config.js";
import { runStdioServer } from "./server.js";

export { DEFAULT_CLIENT_ID };

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const HELP_TEXT = `mcp-yoto ${version} -- MCP server for Yoto (cards, tracks, icons, devices)

Usage:
  npx mcp-yoto              Run the MCP server over stdio (for MCP clients)
  npx mcp-yoto login        Sign in to Yoto (opens your browser)
  npx mcp-yoto logout       Remove the locally stored Yoto credential
  npx mcp-yoto status       Print sign-in status as JSON (to stdout)
  npx mcp-yoto --version    Print the installed version
  npx mcp-yoto --help       Show this help

Environment variables:
  YOTO_CLIENT_ID       Override the Yoto dev-app client id
  YOTO_REDIRECT_PORT    Loopback port used during sign-in (default 8791;
                         must match the redirect URI registered at Yoto)
  YOTO_NO_BROWSER        Set to 1 to print the sign-in URL instead of
                         opening a browser automatically
  LOG_LEVEL              debug | info | warn | error (default info)
  MCP_YOTO_ICON_BASE     Base URL tool icons are served from

Your Yoto credential is stored in your OS keychain when available, or in a
local file otherwise (run "status" to see which). Nothing is ever printed
to stdout except JSON-RPC frames (default mode) or the "status" JSON.
`;

function stderrLogSink(line: {
  level: string;
  message: string;
  data?: Record<string, unknown>;
}): void {
  const suffix = line.data ? ` ${JSON.stringify(line.data)}` : "";
  process.stderr.write(`[mcp-yoto] ${line.level}: ${line.message}${suffix}\n`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [command] = argv;

  // --version/--help are diagnostics, not protocol traffic or the `status`
  // exception -- they go to stderr too, so stdout's contract never has a
  // third case to reason about.
  if (command === "--version" || command === "-v") {
    console.error(version);
    return;
  }
  if (command === "--help" || command === "-h") {
    console.error(HELP_TEXT);
    return;
  }

  const config = loadConfig();
  const logLevel: CoreLogLevel = config.logLevel;
  const logger = createLogger({ level: logLevel, sink: stderrLogSink });

  const auth = await createCliAuthAdapter({ config, logger });
  const client = new YotoClient({
    getToken: () => auth.getAccessToken(),
    baseUrl: config.audience,
    logger,
  });

  if (command === "login") {
    if (!auth.signIn) throw new Error("Sign-in isn't available on this connection.");
    const result = await auth.signIn({
      openBrowser: !config.noBrowser,
      // Fires synchronously as soon as the authorize URL is built, well
      // before the loopback callback ever arrives -- see adapter.ts. With
      // YOTO_NO_BROWSER=1 (or no default handler registered) this is the
      // only place the user ever sees the link.
      onAuthorizeUrl: (url) => {
        process.stderr.write(
          "Sign in to Yoto in your browser. If it did not open, use this link:\n",
        );
        process.stderr.write(`${url}\n`);
      },
    });
    if (result.url) process.stderr.write(`Sign-in URL: ${result.url}\n`);
    process.stderr.write(`${result.message}\n`);
    return;
  }

  if (command === "logout") {
    if (!auth.signOut) throw new Error("Sign-out isn't available on this connection.");
    await auth.signOut();
    process.stderr.write("Signed out of Yoto.\n");
    return;
  }

  if (command === "status") {
    const status = await auth.status();
    // The one deliberate non-MCP use of stdout -- see the file header comment.
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (command) {
    process.stderr.write(`Unknown command: ${command}\n\n${HELP_TEXT}`);
    process.exitCode = 1;
    return;
  }

  await runStdioServer({ auth, client, logger, iconBaseUrl: config.iconBaseUrl });
}
