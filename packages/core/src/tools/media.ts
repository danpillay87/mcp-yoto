import { z } from "zod";
import { cardIdSchema } from "../schemas/index.js";
import { getCard, upsertCard } from "../yoto/endpoints.js";
import { uploadAudio } from "../yoto/media.js";
import { cardSchema } from "../yoto/types.js";
import type { AnyToolSpec, AudioInput, CreateToolsDeps } from "./_helpers.js";

const httpsUrl = z
  .string()
  .url()
  .refine((value) => value.startsWith("https://"), { message: "Must be an https:// URL." });

/**
 * Mode-aware media input: the CLI can read a local file, so it exposes
 * `audioFilePath`; the remote connector has no filesystem, so it exposes
 * `audioUrl` instead (declared openly in each tool's description, per the
 * plan's correction that claude.ai/ChatGPT uploads take a URL, not a path).
 */
function audioInputSchema(mode: CreateToolsDeps["mode"]) {
  return mode === "cli"
    ? z.object({
        audioFilePath: z
          .string()
          .min(1)
          .describe("Absolute path to a local audio file (MP3, M4A/AAC, WAV, or OGG)."),
      })
    : z.object({
        audioUrl: httpsUrl.describe(
          "An https:// URL to an audio file (MP3, M4A/AAC, WAV, or OGG) -- this connector " +
            "runs remotely, so give a link, not a file path.",
        ),
      });
}

function toAudioInput(
  mode: CreateToolsDeps["mode"],
  args: { audioFilePath?: string; audioUrl?: string },
): AudioInput {
  return mode === "cli"
    ? { audioFilePath: args.audioFilePath as string }
    : { audioUrl: args.audioUrl as string };
}

export function createMediaTools(deps: CreateToolsDeps): AnyToolSpec[] {
  const yotoUploadAudio: AnyToolSpec = {
    name: "yoto_upload_audio",
    title: "Upload audio to Yoto",
    description:
      "Uploads an audio file to Yoto and waits for it to finish transcoding, returning a " +
      "yoto:#<sha256> mediaRef usable as a track when creating or updating a card. " +
      (deps.mode === "cli"
        ? "Runs locally, so it takes a file path."
        : "This connector runs remotely, so it takes a link, not a file path."),
    group: "media",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: audioInputSchema(deps.mode).extend({
      loudnorm: z.boolean().optional().describe("Apply loudness normalisation. Default false."),
    }),
    outputSchema: z.object({
      mediaRef: z.string(),
      duration: z.number().optional(),
      fileSize: z.number().optional(),
      format: z.string().optional(),
    }),
    summary: (output) =>
      `Uploaded audio -- ${output.mediaRef}${output.duration ? ` (${output.duration}s)` : ""}.`,
    handler: async (args) => {
      const source = await deps.resolveAudio(toAudioInput(deps.mode, args));
      const result = await uploadAudio(deps.client, source, { loudnorm: args.loudnorm });
      return {
        mediaRef: result.mediaRef,
        duration: result.transcodedInfo.duration,
        fileSize: result.transcodedInfo.fileSize,
        format: result.transcodedInfo.format,
      };
    },
  };

  const yotoAddTrack: AnyToolSpec = {
    name: "yoto_add_track",
    title: "Add a track to a Yoto card",
    description:
      "Uploads an audio file and appends it as a new chapter/track on an existing MYO card. " +
      (deps.mode === "cli"
        ? "Runs locally, so it takes a file path."
        : "This connector runs remotely, so it takes a link, not a file path."),
    group: "media",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: audioInputSchema(deps.mode).extend({
      cardId: cardIdSchema,
      trackTitle: z.string().optional(),
      iconRef: z
        .string()
        .optional()
        .describe("A yoto:#<mediaId> icon reference, e.g. from yoto_upload_icon."),
    }),
    outputSchema: z.object({ card: cardSchema }),
    summary: (output) => `Added a track to "${output.card.title}" (${output.card.cardId}).`,
    handler: async (args) => {
      const source = await deps.resolveAudio(toAudioInput(deps.mode, args));
      const uploaded = await uploadAudio(deps.client, source);
      const existing = await getCard(deps.client, args.cardId);
      const chapters = existing.content?.chapters ?? [];
      const nextNumber = chapters.length + 1;
      const key = String(nextNumber).padStart(2, "0");
      const title = args.trackTitle ?? source.filename ?? `Track ${nextNumber}`;
      const newChapter = {
        key,
        title,
        overlayLabel: String(nextNumber),
        ...(args.iconRef ? { display: { icon16x16: args.iconRef } } : {}),
        tracks: [
          {
            key,
            title,
            trackUrl: uploaded.mediaRef,
            type: "audio",
            overlayLabel: String(nextNumber),
            ...(args.iconRef ? { display: { icon16x16: args.iconRef } } : {}),
          },
        ],
      };
      const card = await upsertCard(deps.client, {
        ...existing,
        cardId: args.cardId,
        content: { ...existing.content, chapters: [...chapters, newChapter] },
      });
      return { card };
    },
  };

  return [yotoUploadAudio, yotoAddTrack];
}
