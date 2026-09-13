/**
 * Family-library support for `yoto_list_cards(source: "family")`. Kept
 * separate from tools/content.ts (which owns the 5 MYO-card tools) per the
 * plan's repo layout (`src/tools/{..., library}.ts`) since a family
 * "group" is a different shape from a MYO card -- a shared collection, not
 * something you can hand to `yoto_get_card`.
 */
import { z } from "zod";
import type { YotoClient } from "../yoto/client.js";
import { listFamilyLibrary } from "../yoto/endpoints.js";
import { familyLibraryGroupSchema } from "../yoto/types.js";

export const familyLibrarySummarySchema = z.object({
  groups: z.array(familyLibraryGroupSchema),
  note: z.string(),
});
export type FamilyLibrarySummary = z.infer<typeof familyLibrarySummarySchema>;

const FAMILY_LIBRARY_NOTE =
  "Family library groups are shared collections, not individual MYO cards -- " +
  'use yoto_get_card only with a cardId from source: "myo".';

export async function summariseFamilyLibrary(client: YotoClient): Promise<FamilyLibrarySummary> {
  const groups = await listFamilyLibrary(client);
  return { groups, note: FAMILY_LIBRARY_NOTE };
}
