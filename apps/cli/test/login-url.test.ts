import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * End-to-end proof of the `login` subcommand's stderr contract: with
 * YOTO_NO_BROWSER=1 (no browser to auto-open), the sign-in URL must reach
 * stderr immediately -- before the loopback callback ever arrives -- or a
 * headless user has nothing to click. Runs the real built binary, exactly
 * as a user would, rather than exercising main.ts's internals directly.
 *
 * Requires `dist/main.js` (this package's `build` script, or root
 * `npm run check`, builds it first); skipped rather than failing if it's
 * missing -- see test/stdio-purity.test.ts for the same convention.
 */
const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, "..", "bin", "mcp-yoto.mjs");
const distEntry = join(here, "..", "dist", "main.js");

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

describe("login writes the sign-in URL to stderr before waiting for the callback", () => {
  let tmpDir: string | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;

  afterEach(async () => {
    child?.kill();
    child = undefined;
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it.skipIf(!existsSync(distEntry))(
    "prints the sign-in prompt and the full authorize URL within 5s, with YOTO_NO_BROWSER=1 and no callback ever sent",
    async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "mcp-yoto-login-"));
      const tokenFile = join(tmpDir, "tokens.json");
      const port = await getFreePort();

      child = spawn(process.execPath, [binPath, "login"], {
        env: {
          ...process.env,
          YOTO_NO_BROWSER: "1",
          YOTO_REDIRECT_PORT: String(port),
          MCP_YOTO_TOKEN_FILE: tokenFile,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stderrText = "";
      const sawUrl = new Promise<void>((resolve) => {
        child?.stderr.on("data", (chunk: Buffer) => {
          stderrText += chunk.toString("utf-8");
          if (stderrText.includes("https://login.yotoplay.com/authorize?")) resolve();
        });
      });

      await Promise.race([
        sawUrl,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Timed out waiting for the sign-in URL on stderr")),
            5_000,
          ),
        ),
      ]);

      // Never sent a /callback request -- this proves the URL reached
      // stderr without the process ever hearing back from the browser.
      expect(stderrText).toContain(
        "Sign in to Yoto in your browser. If it did not open, use this link:",
      );
      expect(stderrText).toContain("https://login.yotoplay.com/authorize?");
    },
    10_000,
  );
});
