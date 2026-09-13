import type { AnyToolSpec, CreateToolsDeps } from "./_helpers.js";
import { createAuthTools } from "./auth.js";
import { createContentTools } from "./content.js";
import { createDeviceTools } from "./devices.js";
import { createIconTools } from "./icons.js";
import { createMediaTools } from "./media.js";

/**
 * Builds all 14 `yoto_*` tool specs (see the plan's tool table), mode-aware
 * where the CLI and remote connector differ (file path vs. https URL for
 * media inputs; sign-in/out behaviour). None of this touches a real
 * `McpServer` -- that's `registerAll()` in index.ts, which calls
 * `defineTool()` on each spec this returns.
 */
export function createTools(deps: CreateToolsDeps): AnyToolSpec[] {
  return [
    ...createAuthTools(deps),
    ...createContentTools(deps),
    ...createMediaTools(deps),
    ...createIconTools(deps),
    ...createDeviceTools(deps),
  ];
}
