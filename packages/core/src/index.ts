import { McpServer } from "@modelcontextprotocol/server";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { type CreateToolsDeps, DEFAULT_ICON_BASE_URL, defineTool } from "./tools/_helpers.js";
import { createTools } from "./tools/index.js";

export type { AuthAdapter, AuthStatus, SignInResult, YotoScope } from "./auth.js";
export { authStatusSchema, signInResultSchema, YOTO_SCOPES } from "./auth.js";
export type { ToolErrorResult, YotoErrorCode, YotoErrorOptions } from "./errors.js";
export { isYotoError, toToolResult, YotoError } from "./errors.js";
export type { CreateLoggerOptions, Logger, LogLevel, LogSink } from "./logging.js";
export { createLogger, noopLogger, redact } from "./logging.js";
export { registerPrompts } from "./prompts.js";
export { registerResources } from "./resources.js";
export type { CardId } from "./schemas/index.js";
export { cardIdSchema } from "./schemas/index.js";
export type {
  AnyToolSpec,
  AudioInput,
  CreateToolsDeps,
  DefineToolSpec,
  ImageInput,
  ImageSource,
  ToolAnnotationsFull,
  ToolGroup,
  ToolHandlerContext,
} from "./tools/_helpers.js";
export { DEFAULT_ICON_BASE_URL, defineTool } from "./tools/_helpers.js";
export { createTools } from "./tools/index.js";
export type { HttpMethod, RequestOptions, YotoClientOptions } from "./yoto/client.js";
export { computeFullJitterDelayMs, parseRetryAfterMs, YotoClient } from "./yoto/client.js";
export {
  deleteCard,
  getCard,
  getDeviceConfig,
  getDeviceStatus,
  getTranscodedStatus,
  getUploadUrl,
  listDevices,
  listFamilyLibrary,
  listMyCards,
  listPublicIcons,
  uploadCustomIcon,
  upsertCard,
} from "./yoto/endpoints.js";
export type {
  AudioSource,
  SniffResult,
  UploadAudioOptions,
  UploadAudioResult,
} from "./yoto/media.js";
export { sniffAudio, sniffImage, uploadAudio } from "./yoto/media.js";
export * from "./yoto/types.js";

export interface CreateServerOptions {
  name: string;
  version: string;
  /** Shown to clients as the server's display name. Defaults to "Yoto". */
  title?: string;
  /** Base URL the pre-generated tool/server icons are served from. */
  iconBaseUrl?: string;
  websiteUrl?: string;
}

/**
 * Registers all 15 tools, the 3 resources, and the 2 prompts onto an
 * already-constructed `McpServer`. Split out from `createServer()` so a
 * caller that needs to build the `McpServer` itself (e.g. to pass
 * transport-specific options the plan hasn't decided on yet) can still
 * reuse this.
 */
export function registerAll(server: McpServer, deps: CreateToolsDeps): void {
  const iconBaseUrl = deps.iconBaseUrl ?? DEFAULT_ICON_BASE_URL;
  for (const spec of createTools(deps)) {
    defineTool(server, spec, { logger: deps.logger, iconBaseUrl });
  }
  registerResources(server, deps);
  registerPrompts(server);
}

/**
 * Constructs the `McpServer` (server-level `name`/`title`/`icons`/
 * `websiteUrl`, per the plan's Implementation schema) and registers
 * everything onto it. Both `apps/cli` and `apps/worker` call this with
 * their own `deps` (a CLI or remote `AuthAdapter`, a `YotoClient`, and
 * runtime-specific `resolveAudio`/`resolveImage`) -- packages/core never
 * constructs any of those itself.
 */
export function createServer(deps: CreateToolsDeps, options: CreateServerOptions): McpServer {
  const iconBaseUrl = deps.iconBaseUrl ?? options.iconBaseUrl ?? DEFAULT_ICON_BASE_URL;
  const server = new McpServer(
    {
      name: options.name,
      title: options.title ?? "Yoto",
      version: options.version,
      icons: [{ src: `${iconBaseUrl}/server.png`, mimeType: "image/png", sizes: ["64x64"] }],
      websiteUrl: options.websiteUrl ?? "https://github.com/danpillay87/mcp-yoto",
    },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );
  registerAll(server, { ...deps, iconBaseUrl });
  return server;
}
