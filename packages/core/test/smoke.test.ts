import { describe, expect, it } from "vitest";
import { createServer, createTools, YOTO_SCOPES, YotoClient } from "../src/index.js";
import { createLogger } from "../src/logging.js";

/**
 * A light "does the public API surface hang together" check -- the real
 * coverage for each piece lives in errors/logging/scopes/sniffers/backoff/
 * yoto-client/yoto-media/contract.test.ts. This file used to assert the
 * Phase-0 stub shapes (an empty `tools` array, `YotoClient.describe()`) --
 * both were replaced in Phase 1, so this now checks the Phase-1 shapes
 * instead.
 */
describe("packages/core public API", () => {
  it("createTools() builds all 15 tool specs for a given mode", () => {
    const deps = {
      mode: "cli" as const,
      client: new YotoClient({ getToken: async () => "token" }),
      logger: createLogger(),
      auth: {
        mode: "cli" as const,
        getAccessToken: async () => "token",
        status: async () => ({ signedIn: false, mode: "cli" as const }),
      },
      resolveAudio: async () => {
        throw new Error("not exercised in this smoke test");
      },
      resolveImage: async () => {
        throw new Error("not exercised in this smoke test");
      },
    };
    const tools = createTools(deps);
    expect(tools).toHaveLength(15);
    expect(new Set(tools.map((t) => t.name)).size).toBe(15);
  });

  it("createServer() builds a real McpServer without throwing", () => {
    const deps = {
      mode: "remote" as const,
      client: new YotoClient({ getToken: async () => "token" }),
      logger: createLogger(),
      auth: {
        mode: "remote" as const,
        getAccessToken: async () => "token",
        status: async () => ({ signedIn: false, mode: "remote" as const }),
      },
      resolveAudio: async () => {
        throw new Error("not exercised in this smoke test");
      },
      resolveImage: async () => {
        throw new Error("not exercised in this smoke test");
      },
    };
    const server = createServer(deps, { name: "mcp-yoto-smoke", version: "0.0.0" });
    expect(server.isConnected()).toBe(false);
  });

  it("YOTO_SCOPES is a non-empty, readonly tuple", () => {
    expect(YOTO_SCOPES.length).toBeGreaterThan(0);
  });
});
