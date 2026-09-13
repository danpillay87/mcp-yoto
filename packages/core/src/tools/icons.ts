import { z } from "zod";
import { listPublicIcons, uploadCustomIcon } from "../yoto/endpoints.js";
import { iconSchema } from "../yoto/types.js";
import type { AnyToolSpec, CreateToolsDeps } from "./_helpers.js";

const httpsUrl = z
  .string()
  .url()
  .refine((value) => value.startsWith("https://"), { message: "Must be an https:// URL." });

export function createIconTools(deps: CreateToolsDeps): AnyToolSpec[] {
  const yotoSearchIcons: AnyToolSpec = {
    name: "yoto_search_icons",
    title: "Search Yoto's icon catalogue",
    description:
      "Searches Yoto's public catalogue of 16x16 pixel-art icons by title or tag, for use " +
      "as a chapter/track icon (iconRef) when creating or updating a card.",
    group: "icons",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      query: z.string().optional().describe("Free-text match against the icon's title and tags."),
      tags: z.array(z.string()).optional().describe("Icon must carry every one of these tags."),
      limit: z.number().int().positive().max(100).optional(),
    }),
    outputSchema: z.object({ icons: z.array(iconSchema) }),
    summary: (output) => `${output.icons.length} icon(s) found.`,
    handler: async (args) => {
      const all = await listPublicIcons(deps.client);
      let filtered = all;
      if (args.query) {
        const query = args.query.toLowerCase();
        filtered = filtered.filter(
          (icon) =>
            icon.title?.toLowerCase().includes(query) ||
            icon.publicTags?.some((tag) => tag.toLowerCase().includes(query)),
        );
      }
      if (args.tags?.length) {
        const wantedTags: string[] = args.tags;
        filtered = filtered.filter((icon) =>
          wantedTags.every((tag: string) => icon.publicTags?.includes(tag)),
        );
      }
      return { icons: args.limit ? filtered.slice(0, args.limit) : filtered };
    },
  };

  const imageInputShape =
    deps.mode === "cli"
      ? {
          imagePath: z
            .string()
            .min(1)
            .describe("Absolute path to a local image file (PNG, JPEG, or SVG)."),
        }
      : {
          imageUrl: httpsUrl.describe(
            "An https:// URL to an image file (PNG, JPEG, or SVG) -- this connector runs " +
              "remotely, so give a link, not a file path.",
          ),
        };

  const yotoUploadIcon: AnyToolSpec = {
    name: "yoto_upload_icon",
    title: "Upload a custom Yoto icon",
    description:
      "Uploads a custom 16x16 pixel-art icon to your Yoto account, returning a mediaId " +
      "usable as an iconRef on cards and tracks. " +
      (deps.mode === "cli"
        ? "Runs locally, so it takes a file path."
        : "This connector runs remotely, so it takes a link, not a file path."),
    group: "icons",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      ...imageInputShape,
      title: z.string().min(1).describe("Sent to Yoto as the uploaded file's name."),
      autoConvert: z
        .boolean()
        .optional()
        .describe("Let Yoto auto-convert the image to its 16x16 icon format. Default false."),
    }),
    outputSchema: z.object({ mediaId: z.string(), url: z.string().optional() }),
    summary: (output) => `Uploaded icon -- ${output.mediaId}.`,
    handler: async (args) => {
      const input =
        deps.mode === "cli" ? { imagePath: args.imagePath } : { imageUrl: args.imageUrl };
      const image = await deps.resolveImage(input);
      const icon = await uploadCustomIcon(deps.client, image.bytes, image.contentType, {
        filename: args.title,
        autoConvert: args.autoConvert,
      });
      return { mediaId: icon.mediaId, url: icon.url };
    },
  };

  return [yotoSearchIcons, yotoUploadIcon];
}
