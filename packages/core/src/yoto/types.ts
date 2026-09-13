/**
 * Zod schemas for Yoto API payloads, shaped against
 * https://yoto.dev/openapi.json (fetched 2026-09-13) plus the fields the old
 * `yoto-mcp-server` was already relying on. Every object schema is
 * `z.looseObject(...)` -- Yoto's API returns plenty of fields we don't model
 * (club availability, cover art, edit settings, ...) and a strict schema
 * would throw those away or reject them outright. We parse, don't trust,
 * but we also don't want an API field Yoto adds tomorrow to break every
 * tool today.
 */
import { z } from "zod";

const displaySchema = z
  .looseObject({ icon16x16: z.string().nullable().optional() })
  .nullable()
  .optional();

export const trackSchema = z.looseObject({
  key: z.string(),
  title: z.string(),
  trackUrl: z.string(),
  type: z.string().optional(),
  duration: z.number().optional(),
  fileSize: z.number().optional(),
  channels: z.string().optional(),
  format: z.string().optional(),
  overlayLabel: z.string().optional(),
  display: displaySchema,
});
export type Track = z.infer<typeof trackSchema>;

export const chapterSchema = z.looseObject({
  key: z.string(),
  title: z.string(),
  overlayLabel: z.string().optional(),
  tracks: z.array(trackSchema).default([]),
  duration: z.number().optional(),
  fileSize: z.number().optional(),
  display: displaySchema,
});
export type Chapter = z.infer<typeof chapterSchema>;

export const cardContentSchema = z.looseObject({
  chapters: z.array(chapterSchema).default([]),
});

/** A card as it appears in `GET /content/mine` or the full `GET /content/{cardId}`. */
export const cardSchema = z.looseObject({
  cardId: z.string(),
  title: z.string(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  deleted: z.boolean().optional(),
  content: cardContentSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type Card = z.infer<typeof cardSchema>;

/** Alias kept for callers that only ever see the list shape (same schema -- see module doc). */
export const cardListItemSchema = cardSchema;
export type CardListItem = Card;

export const listCardsResponseSchema = z.looseObject({ cards: z.array(cardSchema).default([]) });
export const getCardResponseSchema = z.looseObject({ card: cardSchema });
export const upsertCardResponseSchema = z.looseObject({ card: cardSchema });

export const deviceSchema = z.looseObject({
  deviceId: z.string(),
  name: z.string().optional(),
  online: z.boolean().optional(),
  deviceFamily: z.string().optional(),
  deviceType: z.string().optional(),
  releaseChannel: z.string().optional(),
  description: z.string().optional(),
});
export type Device = z.infer<typeof deviceSchema>;
export const listDevicesResponseSchema = z.looseObject({
  devices: z.array(deviceSchema).default([]),
});

/**
 * Device config is deliberately fully unknown-tolerant: it's a large,
 * beta, frequently-changing bag of player settings (clock face, volume
 * limits, daily/radio links, ...) that this server only ever passes through
 * read-only via `yoto_get_device_config` -- see the plan's scope decision
 * (we don't request `family:devices:manage`, so writes are out of scope).
 */
export const deviceConfigSchema = z.record(z.string(), z.unknown());
export type DeviceConfig = z.infer<typeof deviceConfigSchema>;
export const getDeviceConfigResponseSchema = z.looseObject({
  device: z
    .looseObject({
      deviceId: z.string().optional(),
      config: deviceConfigSchema.optional(),
    })
    .optional(),
});

export const iconSchema = z.looseObject({
  mediaId: z.string(),
  displayIconId: z.string().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  publicTags: z.array(z.string()).optional(),
});
export type Icon = z.infer<typeof iconSchema>;
export const listPublicIconsResponseSchema = z.looseObject({
  displayIcons: z.array(iconSchema).default([]),
});
export const uploadIconResponseSchema = z.looseObject({ displayIcon: iconSchema });

export const familyLibraryGroupSchema = z.looseObject({
  groupId: z.string().optional(),
  name: z.string().optional(),
});
export type FamilyLibraryGroup = z.infer<typeof familyLibraryGroupSchema>;
export const listFamilyLibraryResponseSchema = z.looseObject({
  groups: z.array(familyLibraryGroupSchema).default([]),
});

export const uploadUrlResponseSchema = z.looseObject({
  upload: z.looseObject({
    uploadId: z.string(),
    uploadUrl: z.string().nullable(),
  }),
});
export type UploadUrlResponse = z.infer<typeof uploadUrlResponseSchema>;

/**
 * `GET /media/upload/{uploadId}/transcoded` -- undocumented in
 * yoto.dev/openapi.json but proven in production by the old
 * `yoto-mcp-server` (see its `uploadAndTranscodeAudio`). Ported as-is per
 * the plan's instruction to port "the upload/transcode flow and endpoint
 * knowledge" from that server.
 */
export const transcodedResponseSchema = z.looseObject({
  transcode: z.looseObject({
    transcodedSha256: z.string().optional(),
    transcodedInfo: z
      .looseObject({
        duration: z.number().optional(),
        fileSize: z.number().optional(),
        channels: z.string().optional(),
        format: z.string().optional(),
      })
      .optional(),
  }),
});
export type TranscodedResponse = z.infer<typeof transcodedResponseSchema>;
