import { z } from "zod";

/**
 * Placeholder schemas for Phase 0. The real Yoto content/card/device/icon
 * schemas that back all 15 `yoto_*` tools land in Phase 1
 * (packages/core/src/yoto/types.ts), built out alongside YotoClient.
 */
export const cardIdSchema = z.string().min(1, "cardId must not be empty");

export type CardId = z.infer<typeof cardIdSchema>;
