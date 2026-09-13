import type { McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { AuthAdapter } from "../auth.js";
import { isYotoError, toToolResult, YotoError } from "../errors.js";
import type { Logger } from "../logging.js";
import type { YotoClient } from "../yoto/client.js";
import type { AudioSource } from "../yoto/media.js";

/**
 * Which pre-generated icon (`apps/worker/public/icons/<group>.png`, made by
 * `scripts/gen-icons.mjs`) a tool is tagged with. Matches the plan's repo
 * layout file split (`src/tools/{auth,content,media,icons,devices,library}.ts`).
 */
export type ToolGroup = "server" | "auth" | "content" | "media" | "icons" | "devices" | "library";

/** All four hints are required on every tool -- see the plan's tool table. */
export interface ToolAnnotationsFull {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export const DEFAULT_ICON_BASE_URL =
  "https://raw.githubusercontent.com/danpillay87/mcp-yoto/main/apps/worker/public/icons";

/** One `audioFilePath` (CLI) or `audioUrl` (remote) input, whichever the running mode exposes. */
export type AudioInput = { audioFilePath: string } | { audioUrl: string };
/** One `imagePath` (CLI) or `imageUrl` (remote) input, whichever the running mode exposes. */
export type ImageInput = { imagePath: string } | { imageUrl: string };

/** What `resolveImage` hands back: fully-buffered bytes (icons are small; no need to stream). */
export interface ImageSource {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
  filename?: string;
}

/**
 * Everything a tool handler needs, injected once per server instance by the
 * entrypoint (`apps/cli` or `apps/worker`). packages/core never constructs
 * any of this itself -- see the plan's "runtime-agnostic" mandate.
 */
export interface CreateToolsDeps {
  auth: AuthAdapter;
  client: YotoClient;
  logger: Logger;
  /** Base URL the pre-generated tool icons are served from. Defaults to the GitHub-raw URL above. */
  iconBaseUrl?: string;
  /** Turns a CLI file path or a remote https URL into streamable audio bytes. */
  resolveAudio: (input: AudioInput) => Promise<AudioSource>;
  /** Turns a CLI file path or a remote https URL into buffered image bytes. */
  resolveImage: (input: ImageInput) => Promise<ImageSource>;
  mode: "cli" | "remote";
}

export interface ToolHandlerContext {
  logger: Logger;
}

export interface DefineToolSpec<TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny> {
  name: string;
  title: string;
  description: string;
  group: ToolGroup;
  annotations: ToolAnnotationsFull;
  inputSchema: TInput;
  outputSchema: TOutput;
  /** Renders a one-line human summary alongside the structured result. */
  summary: (output: z.infer<TOutput>, input: z.infer<TInput>) => string;
  handler: (input: z.infer<TInput>, ctx: ToolHandlerContext) => Promise<z.infer<TOutput>>;
}

/**
 * An un-parameterised spec, for the heterogeneous array `createTools()`
 * returns. Deliberately NOT `DefineToolSpec<any, any>`: instantiating that
 * generic with `any` sends `z.infer<TInput>`/`z.infer<TOutput>` (conditional
 * types) through TypeScript's distributive-over-`any` behaviour, which
 * collapses them to something other than plain `any` and produces spurious
 * "implicitly has an 'any' type" errors on parameters inside tool handler
 * bodies (e.g. `.map((track, index) => ...)`). A standalone interface using
 * literal `any` sidesteps that entirely.
 */
export interface AnyToolSpec {
  name: string;
  title: string;
  description: string;
  group: ToolGroup;
  annotations: ToolAnnotationsFull;
  inputSchema: z.ZodTypeAny;
  outputSchema: z.ZodTypeAny;
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool specs erase input/output to `any` by design -- see the interface doc comment.
  summary: (output: any, input: any) => string;
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool specs erase input/output to `any` by design -- see the interface doc comment.
  handler: (input: any, ctx: ToolHandlerContext) => Promise<any>;
}

/**
 * Registers one tool spec onto a real `McpServer`, matching the actual SDK
 * v2 `registerTool(name, config, cb)` API (confirmed against
 * node_modules/@modelcontextprotocol/server/dist/mcp-*.mjs): `config` takes
 * `{title, description, inputSchema, outputSchema, annotations, icons}` and
 * `inputSchema`/`outputSchema` accept a `z.object({...})` directly (no raw
 * shape needed -- `normalizeRawShapeSchema` inside the SDK accepts either).
 *
 * The SDK validates input against `inputSchema` and, on success, skips its
 * own output validation whenever the handler returns `isError: true` (see
 * `McpServer.validateToolOutput`) -- so returning a `YotoError`-shaped
 * result from a tool with an `outputSchema` is safe. Business-rule
 * failures the input schema itself can't express (e.g. "confirm must be
 * true") are surfaced as our own `VALIDATION` `YotoError`, not the SDK's
 * generic schema-mismatch error.
 */
export function defineTool(
  server: McpServer,
  spec: AnyToolSpec,
  deps: { logger: Logger; iconBaseUrl?: string },
): void {
  const iconBaseUrl = deps.iconBaseUrl ?? DEFAULT_ICON_BASE_URL;
  // Cast to a looser call signature at this one boundary: the real SDK's
  // `registerTool` overloads resolve a generic `TInput`/`TOutput` pair from
  // its own type parameters, which fights a *wrapper* function that is
  // itself generic over the same kind of schema. The runtime call is
  // unchanged (config/callback shapes match the SDK exactly, verified by
  // the contract test actually driving `tools/list`/`tools/call` over
  // `InMemoryTransport`) -- this only relaxes what the compiler checks here.
  const registerTool = server.registerTool.bind(server) as (
    name: string,
    config: {
      title: string;
      description: string;
      inputSchema: z.ZodTypeAny;
      outputSchema: z.ZodTypeAny;
      annotations: ToolAnnotationsFull;
      icons: Array<{ src: string; mimeType: string; sizes: string[] }>;
    },
    // biome-ignore lint/suspicious/noExplicitAny: see the cast rationale above.
    cb: (args: any) => Promise<any>,
  ) => void;
  registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      outputSchema: spec.outputSchema,
      annotations: spec.annotations,
      icons: [{ src: `${iconBaseUrl}/${spec.group}.png`, mimeType: "image/png", sizes: ["64x64"] }],
    },
    async (args) => {
      try {
        const output = await spec.handler(args, { logger: deps.logger });
        const text = spec.summary(output, args);
        return { content: [{ type: "text" as const, text }], structuredContent: output };
      } catch (error) {
        if (isYotoError(error)) return toToolResult(error);
        deps.logger.error(`Tool ${spec.name} failed unexpectedly`, {
          error: error instanceof Error ? error.message : String(error),
        });
        return toToolResult(
          new YotoError(error instanceof Error ? error.message : String(error), {
            code: "UPSTREAM_ERROR",
          }),
        );
      }
    },
  );
}
