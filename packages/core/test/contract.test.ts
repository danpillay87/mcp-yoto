import { describe, expect, it } from "vitest";
import { createServer } from "../src/index.js";
import { createLogger } from "../src/logging.js";
import type { CreateToolsDeps } from "../src/tools/_helpers.js";
import { YotoClient } from "../src/yoto/client.js";
import { makeFakeFetch } from "./helpers/fake-fetch.js";
import { connectMinimalClient } from "./helpers/rpc-client.js";

interface WireTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: { type: string; properties?: Record<string, unknown>; required?: string[] };
  outputSchema?: { type?: string; properties?: Record<string, unknown> };
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  icons?: Array<{ src: string; mimeType?: string; sizes?: string[] }>;
}

function buildDeps(mode: "cli" | "remote"): CreateToolsDeps {
  const { fetch: fakeFetch } = makeFakeFetch([
    { status: 200, jsonBody: { cards: [] } }, // yoto_status's reachability probe
    { status: 200, jsonBody: { cards: [{ cardId: "card-1", title: "Test Card" }] } }, // yoto_list_cards
  ]);
  const client = new YotoClient({ getToken: async () => "fake-token", fetchImpl: fakeFetch });
  return {
    mode,
    client,
    logger: createLogger(),
    auth: {
      mode,
      getAccessToken: async () => "fake-token",
      status: async () => ({
        signedIn: true,
        mode,
        tokenStore: mode === "cli" ? "keychain" : "remote",
      }),
      signIn: mode === "cli" ? async () => ({ message: "signed in" }) : undefined,
      signOut: mode === "cli" ? async () => {} : undefined,
    },
    resolveAudio: async () => ({
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      size: 0,
      contentType: "audio/mpeg",
    }),
    resolveImage: async () => ({ bytes: new Uint8Array(), contentType: "image/png" }),
  };
}

const EXPECTED_TOOL_NAMES = [
  "yoto_status",
  "yoto_sign_in",
  "yoto_sign_out",
  "yoto_list_cards",
  "yoto_get_card",
  "yoto_create_card",
  "yoto_update_card",
  "yoto_delete_card",
  "yoto_upload_audio",
  "yoto_add_track",
  "yoto_search_icons",
  "yoto_upload_icon",
  "yoto_list_devices",
  "yoto_get_device_config",
  "yoto_player_status",
];

describe.each(["cli", "remote"] as const)("mcp-yoto server contract (%s mode)", (mode) => {
  async function setup() {
    const deps = buildDeps(mode);
    const server = createServer(deps, { name: "mcp-yoto-test", version: "0.0.0-test" });
    const client = await connectMinimalClient(server);
    return { client, deps };
  }

  it("advertises exactly the 15 yoto_* tools, each fully annotated", async () => {
    const { client } = await setup();
    const { tools } = await client.request<{ tools: WireTool[] }>("tools/list");

    expect(tools).toHaveLength(15);
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());

    for (const tool of tools) {
      expect(tool.name).toMatch(/^yoto_[a-z0-9_]+$/);
      expect(tool.title?.length ?? 0).toBeGreaterThan(0);
      expect(tool.description?.length ?? 0).toBeGreaterThanOrEqual(40);

      expect(tool.annotations).toBeDefined();
      expect(typeof tool.annotations?.readOnlyHint).toBe("boolean");
      expect(typeof tool.annotations?.destructiveHint).toBe("boolean");
      expect(typeof tool.annotations?.idempotentHint).toBe("boolean");
      expect(typeof tool.annotations?.openWorldHint).toBe("boolean");

      expect(tool.icons?.[0]?.mimeType).toBe("image/png");
      expect(tool.icons?.[0]?.src).toContain(".png");

      expect(tool.outputSchema).toBeDefined();
      expect(Object.keys(tool.outputSchema?.properties ?? {}).length).toBeGreaterThan(0);
    }

    await client.close();
  });

  it(`exposes ${mode === "cli" ? "*Path" : "*Url"} fields on the media/icon tools`, async () => {
    const { client } = await setup();
    const { tools } = await client.request<{ tools: WireTool[] }>("tools/list");
    const byName = new Map(tools.map((t) => [t.name, t]));

    const uploadAudioProps = byName.get("yoto_upload_audio")?.inputSchema.properties ?? {};
    const addTrackProps = byName.get("yoto_add_track")?.inputSchema.properties ?? {};
    const uploadIconProps = byName.get("yoto_upload_icon")?.inputSchema.properties ?? {};

    if (mode === "cli") {
      expect(uploadAudioProps).toHaveProperty("audioFilePath");
      expect(uploadAudioProps).not.toHaveProperty("audioUrl");
      expect(addTrackProps).toHaveProperty("audioFilePath");
      expect(uploadIconProps).toHaveProperty("imagePath");
    } else {
      expect(uploadAudioProps).toHaveProperty("audioUrl");
      expect(uploadAudioProps).not.toHaveProperty("audioFilePath");
      expect(addTrackProps).toHaveProperty("audioUrl");
      expect(uploadIconProps).toHaveProperty("imageUrl");
    }

    await client.close();
  });

  it("lists the 3 resources and 2 prompts", async () => {
    const { client } = await setup();
    const { resources } = await client.request<{ resources: Array<{ uri: string }> }>(
      "resources/list",
    );
    const { resourceTemplates } = await client.request<{
      resourceTemplates: Array<{ name: string }>;
    }>("resources/templates/list");
    const { prompts } = await client.request<{ prompts: Array<{ name: string }> }>("prompts/list");

    expect(resources.map((r) => r.uri)).toEqual(
      expect.arrayContaining(["yoto://cards", "yoto://icons/public"]),
    );
    expect(resourceTemplates.length).toBeGreaterThanOrEqual(1);
    expect(prompts.map((p) => p.name).sort()).toEqual(["audit_card", "bedtime_playlist_card"]);

    await client.close();
  });

  it("calls yoto_status and gets structured, schema-valid content back", async () => {
    const { client } = await setup();
    const result = await client.request<{
      structuredContent: { signedIn: boolean; mode: string; apiReachable?: boolean };
      isError?: boolean;
    }>("tools/call", { name: "yoto_status", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.signedIn).toBe(true);
    expect(result.structuredContent.mode).toBe(mode);
    expect(result.structuredContent.apiReachable).toBe(true);

    await client.close();
  });

  it("calls yoto_list_cards and gets the fake card back as structured content", async () => {
    const { client } = await setup();
    // Drain yoto_status's reachability probe first so it consumes the first
    // queued fake-fetch response, leaving the card list for this call.
    await client.request("tools/call", { name: "yoto_status", arguments: {} });

    const result = await client.request<{
      structuredContent: { source: string; cards?: Array<{ cardId: string; title: string }> };
    }>("tools/call", { name: "yoto_list_cards", arguments: {} });

    expect(result.structuredContent.source).toBe("myo");
    expect(result.structuredContent.cards).toEqual([{ cardId: "card-1", title: "Test Card" }]);

    await client.close();
  });
});
