import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The one integration test that proves the actual published contract: run
 * the real built binary as a real MCP client would, over real stdio, and
 * check what actually crossed the wire -- not what the code merely intends.
 *
 * Requires `dist/main.js` to already be built (this package's own `build`
 * script, or the root `npm run check`, which runs `tsc -b` before
 * `vitest run`). If it's missing, this test is skipped rather than failing
 * with a confusing "module not found" -- run `npm run build` first.
 */
const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, "..", "bin", "mcp-yoto.mjs");
const distEntry = join(here, "..", "dist", "main.js");

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: unknown;
}

function collectResponses(child: ChildProcessWithoutNullStreams) {
  const rawLines: string[] = [];
  const responses = new Map<number, JsonRpcMessage>();
  const waiters = new Map<number, (message: JsonRpcMessage) => void>();

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    rawLines.push(line);
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      return; // caught separately by the "every line parses" assertion below
    }
    if (typeof message.id === "number") {
      responses.set(message.id, message);
      waiters.get(message.id)?.(message);
    }
  });

  return {
    rawLines,
    waitFor(id: number, timeoutMs = 10_000): Promise<JsonRpcMessage> {
      const existing = responses.get(id);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timed out waiting for response id ${id}`)),
          timeoutMs,
        );
        waiters.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
    },
  };
}

describe("stdio purity", () => {
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
    "stdout carries only JSON-RPC frames (initialize + tools/list, 15 tools); stderr never carries a token-shaped string",
    async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "mcp-yoto-purity-"));
      const tokenFile = join(tmpDir, "tokens.json");

      child = spawn(process.execPath, [binPath], {
        env: {
          ...process.env,
          MCP_YOTO_TOKEN_FILE: tokenFile,
          LOG_LEVEL: "debug",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const stderrChunks: Buffer[] = [];
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      const { rawLines, waitFor } = collectResponses(child);

      function send(message: Record<string, unknown>): void {
        child?.stdin.write(`${JSON.stringify(message)}\n`);
      }

      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "mcp-yoto-stdio-purity-test", version: "0.0.0" },
        },
      });
      await waitFor(1);

      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const toolsResponse = await waitFor(2);

      child.stdin.end();

      // Every line on stdout must be a parseable JSON-RPC frame -- nothing
      // else (a stray console.log, a warning, a banner) is allowed through.
      expect(rawLines.length).toBeGreaterThan(0);
      for (const line of rawLines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Intentionally not wrapped in try/catch: a stray non-JSON stdout
        // line should fail this test loudly with JSON.parse's own error,
        // not be swallowed into a generic assertion failure.
        const parsed = JSON.parse(trimmed) as JsonRpcMessage;
        expect(parsed.jsonrpc).toBe("2.0");
      }

      const tools = (toolsResponse.result as { tools: Array<{ name: string }> } | undefined)?.tools;
      expect(tools).toBeDefined();
      expect(tools).toHaveLength(15);
      expect(tools?.map((t) => t.name)).toContain("yoto_status");

      const stderrText = Buffer.concat(stderrChunks).toString("utf-8");
      expect(stderrText).not.toMatch(/eyJ[a-zA-Z0-9_-]{10,}/);
      expect(stderrText).not.toMatch(/access_token|refresh_token/i);
    },
    20_000,
  );
});
