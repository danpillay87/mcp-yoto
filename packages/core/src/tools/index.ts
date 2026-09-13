import type { ToolDefinition } from "./_helpers.js";

/**
 * The 14 `yoto_*` tool definitions (see the plan's tool table:
 * yoto_status, yoto_sign_in, yoto_sign_out, yoto_list_cards, yoto_get_card,
 * yoto_create_card, yoto_update_card, yoto_delete_card, yoto_upload_audio,
 * yoto_add_track, yoto_search_icons, yoto_upload_icon, yoto_list_devices,
 * yoto_get_device_config) land here in Phase 1, each built with
 * defineTool() from ./_helpers.js. Phase 0 exports an empty, typed registry
 * so apps/worker and apps/cli have a stable import to build against.
 */
// biome-ignore lint/suspicious/noExplicitAny: an empty Phase-0 registry has no concrete tool type to point at yet.
export const tools: ToolDefinition<any>[] = [];
