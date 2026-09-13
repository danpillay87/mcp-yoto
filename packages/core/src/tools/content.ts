import { z } from "zod";
import { YotoError } from "../errors.js";
import { cardIdSchema } from "../schemas/index.js";
import { deleteCard, getCard, listMyCards, upsertCard } from "../yoto/endpoints.js";
import { cardSchema } from "../yoto/types.js";
import type { AnyToolSpec, CreateToolsDeps } from "./_helpers.js";
import { summariseFamilyLibrary } from "./library.js";

export function createContentTools(deps: CreateToolsDeps): AnyToolSpec[] {
  const yotoListCards: AnyToolSpec = {
    name: "yoto_list_cards",
    title: "List your Yoto cards",
    description:
      "Lists cards in your own MYO (Make Your Own) library, or the shared family " +
      "library's groups. Family groups are collections, not individual cards -- see " +
      'the returned note when source is "family".',
    group: "content",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      source: z.enum(["myo", "family"]).default("myo"),
      limit: z.number().int().positive().max(200).optional(),
      cursor: z.string().optional().describe("Reserved for future pagination; currently unused."),
    }),
    outputSchema: z.object({
      source: z.enum(["myo", "family"]),
      cards: z.array(cardSchema).optional(),
      groups: z
        .array(z.looseObject({ groupId: z.string().optional(), name: z.string().optional() }))
        .optional(),
      note: z.string().optional(),
    }),
    summary: (output) =>
      output.source === "family"
        ? `${output.groups?.length ?? 0} family library group(s).`
        : `${output.cards?.length ?? 0} card(s) in your MYO library.`,
    handler: async (args) => {
      if (args.source === "family") {
        const { groups, note } = await summariseFamilyLibrary(deps.client);
        return { source: "family" as const, groups, note };
      }
      const cards = await listMyCards(deps.client);
      return { source: "myo" as const, cards: args.limit ? cards.slice(0, args.limit) : cards };
    },
  };

  const yotoGetCard: AnyToolSpec = {
    name: "yoto_get_card",
    title: "Get a Yoto card's details",
    description: "Fetches one MYO card's full details, including every chapter and track.",
    group: "content",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({ cardId: cardIdSchema }),
    outputSchema: z.object({ card: cardSchema }),
    summary: (output) =>
      `"${output.card.title}" -- ${output.card.content?.chapters.length ?? 0} chapter(s).`,
    handler: async (args) => ({ card: await getCard(deps.client, args.cardId) }),
  };

  const yotoCreateCard: AnyToolSpec = {
    name: "yoto_create_card",
    title: "Create a new Yoto card",
    description:
      "Creates a new MYO card with the given title, and optionally an initial set of " +
      "tracks (each a mediaRef from yoto_upload_audio, one track per chapter) and a " +
      "default icon for those chapters.",
    group: "content",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      title: z.string().min(1),
      tracks: z
        .array(
          z.object({
            mediaRef: z
              .string()
              .min(1)
              .describe("A yoto:#<sha256> reference from yoto_upload_audio."),
            title: z.string().optional(),
          }),
        )
        .optional(),
      iconRef: z
        .string()
        .optional()
        .describe("A yoto:#<mediaId> icon reference, e.g. from yoto_upload_icon."),
    }),
    outputSchema: z.object({ card: cardSchema }),
    summary: (output) => `Created "${output.card.title}" (${output.card.cardId}).`,
    handler: async (args) => {
      const tracks: Array<{ mediaRef: string; title?: string }> = args.tracks ?? [];
      const chapters = tracks.map((track, index) => {
        const key = String(index + 1).padStart(2, "0");
        const title = track.title ?? args.title;
        return {
          key,
          title,
          overlayLabel: String(index + 1),
          ...(args.iconRef ? { display: { icon16x16: args.iconRef } } : {}),
          tracks: [
            {
              key,
              title,
              trackUrl: track.mediaRef,
              type: "audio",
              overlayLabel: String(index + 1),
              ...(args.iconRef ? { display: { icon16x16: args.iconRef } } : {}),
            },
          ],
        };
      });
      const card = await upsertCard(deps.client, { title: args.title, content: { chapters } });
      return { card };
    },
  };

  const yotoUpdateCard: AnyToolSpec = {
    name: "yoto_update_card",
    title: "Update a Yoto card",
    description:
      "Shallow-merges patch fields (e.g. title, or a full replacement content.chapters " +
      "array to rename/reorder tracks or set icons) onto an existing card, then saves it.",
    group: "content",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      cardId: cardIdSchema,
      patch: z
        .record(z.string(), z.unknown())
        .describe("Fields to merge onto the existing card, e.g. { title } or { content }."),
    }),
    outputSchema: z.object({ card: cardSchema }),
    summary: (output) => `Updated "${output.card.title}" (${output.card.cardId}).`,
    handler: async (args) => {
      const existing = await getCard(deps.client, args.cardId);
      const merged = { ...existing, ...args.patch, cardId: args.cardId };
      const card = await upsertCard(deps.client, merged);
      return { card };
    },
  };

  const yotoDeleteCard: AnyToolSpec = {
    name: "yoto_delete_card",
    title: "Delete a Yoto card",
    description:
      "Permanently deletes a MYO card from the parent's Yoto library. Requires confirm: true.",
    group: "content",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      cardId: cardIdSchema,
      confirm: z.boolean().describe("Must be true -- this permanently deletes the card."),
    }),
    outputSchema: z.object({ cardId: z.string(), deleted: z.boolean() }),
    summary: (output) => `Deleted card ${output.cardId}.`,
    handler: async (args) => {
      if (!args.confirm) {
        throw new YotoError("Pass confirm: true to delete this card.", {
          code: "VALIDATION",
          hint: "This permanently deletes the card from the parent's Yoto library.",
        });
      }
      await deleteCard(deps.client, args.cardId);
      return { cardId: args.cardId, deleted: true };
    },
  };

  return [yotoListCards, yotoGetCard, yotoCreateCard, yotoUpdateCard, yotoDeleteCard];
}
