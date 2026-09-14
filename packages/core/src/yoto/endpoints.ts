/**
 * Thin, typed wrappers around the Yoto endpoints the 15 tools need. Paths
 * and operationIds confirmed against https://yoto.dev/openapi.json
 * (fetched 2026-09-13) except where noted.
 */

import type { YotoClient } from "./client.js";
import type {
  Card,
  Device,
  DeviceStatus,
  FamilyLibraryGroup,
  Icon,
  TranscodedResponse,
  UploadUrlResponse,
} from "./types.js";
import {
  deviceStatusSchema,
  getCardResponseSchema,
  getDeviceConfigResponseSchema,
  listCardsResponseSchema,
  listDevicesResponseSchema,
  listFamilyLibraryResponseSchema,
  listPublicIconsResponseSchema,
  transcodedResponseSchema,
  uploadIconResponseSchema,
  uploadUrlResponseSchema,
  upsertCardResponseSchema,
} from "./types.js";

/** GET /content/mine (operationId `getUserSMyoContent`) -- scope `user:content:view`. */
export async function listMyCards(client: YotoClient): Promise<Card[]> {
  const result = await client.request({
    method: "GET",
    path: "/content/mine",
    schema: listCardsResponseSchema,
  });
  return result.cards;
}

/** GET /content/{cardId} (operationId `getContent`) -- scope `user:content:view`. */
export async function getCard(client: YotoClient, cardId: string): Promise<Card> {
  const result = await client.request({
    method: "GET",
    path: `/content/${encodeURIComponent(cardId)}`,
    schema: getCardResponseSchema,
  });
  return result.card;
}

/**
 * POST /content (operationId `createOrUpdateContent`) -- scope
 * `user:content:manage`. Creates a card when `body.cardId` is omitted,
 * updates it in place when present. Only retried on 5xx/network when
 * `body.cardId` is set (an update is idempotent; a create is not).
 */
export async function upsertCard(client: YotoClient, body: Record<string, unknown>): Promise<Card> {
  const result = await client.request({
    method: "POST",
    path: "/content",
    body,
    schema: upsertCardResponseSchema,
    idempotent: typeof body.cardId === "string" && body.cardId.length > 0,
  });
  return result.card;
}

/** DELETE /content/{cardId} (operationId `deleteContent`) -- scope `user:content:manage`. */
export async function deleteCard(client: YotoClient, cardId: string): Promise<void> {
  await client.request({
    method: "DELETE",
    path: `/content/${encodeURIComponent(cardId)}`,
    idempotent: true,
  });
}

/** GET /media/displayIcons/user/yoto (operationId `getPublicIcons`) -- scope `user:icons:manage`. */
export async function listPublicIcons(client: YotoClient): Promise<Icon[]> {
  const result = await client.request({
    method: "GET",
    path: "/media/displayIcons/user/yoto",
    schema: listPublicIconsResponseSchema,
  });
  return result.displayIcons;
}

/**
 * POST /media/displayIcons/user/me/upload (operationId `uploadCustomIcon`) --
 * scope `user:icons:manage`. Takes raw image bytes; the only documented
 * query params are `autoConvert` and `filename` (no `title` field exists on
 * this endpoint, so the tool's `title` input is sent as `filename`).
 */
export async function uploadCustomIcon(
  client: YotoClient,
  bytes: Uint8Array<ArrayBuffer>,
  contentType: string,
  options: { filename?: string; autoConvert?: boolean } = {},
): Promise<Icon> {
  const result = await client.request({
    method: "POST",
    path: "/media/displayIcons/user/me/upload",
    query: { autoConvert: options.autoConvert ?? false, filename: options.filename },
    // Wrapped in a Blob rather than passed as a raw Uint8Array: TypeScript's
    // lib.dom BodyInit union doesn't line up with the generic-parameterised
    // Uint8Array<ArrayBufferLike> this project's TS/lib versions infer for a
    // bare `Uint8Array` type, but a Blob sidesteps that friction cleanly and
    // uploads the identical bytes.
    rawBody: new Blob([bytes]),
    contentType,
    schema: uploadIconResponseSchema,
  });
  return result.displayIcon;
}

/** GET /device-v2/devices/mine (operationId `getDevices`) -- scope `family:devices:view`. */
export async function listDevices(client: YotoClient): Promise<Device[]> {
  const result = await client.request({
    method: "GET",
    path: "/device-v2/devices/mine",
    schema: listDevicesResponseSchema,
  });
  return result.devices;
}

/**
 * GET /device-v2/{deviceId}/config (operationId `getDeviceConfig`) -- scope
 * `family:devices:manage`, which this server never requests (see
 * auth.ts's YOTO_SCOPES). Expect a FORBIDDEN_SCOPE YotoError from
 * YotoClient in practice; tools/devices.ts turns that into a friendly hint.
 */
export async function getDeviceConfig(
  client: YotoClient,
  deviceId: string,
): Promise<Record<string, unknown>> {
  const result = await client.request({
    method: "GET",
    path: `/device-v2/${encodeURIComponent(deviceId)}/config`,
    schema: getDeviceConfigResponseSchema,
  });
  return result.device?.config ?? {};
}

/**
 * GET /device-v2/{deviceId}/status (operationId `getDeviceStatus`) -- scope
 * `family:device-status:view`. Yoto's openapi.json marks this endpoint
 * **deprecated**; it's still the only documented way to read a player's live
 * state (battery, volume, nightlight, card inserted, etc). See
 * tools/devices.ts (`yoto_player_status`) for the FORBIDDEN_SCOPE handling
 * and field normalisation, and deviceStatusSchema's doc comment for why
 * there's no playing/paused field to normalise from.
 */
export async function getDeviceStatus(client: YotoClient, deviceId: string): Promise<DeviceStatus> {
  return client.request({
    method: "GET",
    path: `/device-v2/${encodeURIComponent(deviceId)}/status`,
    schema: deviceStatusSchema,
    idempotent: true,
  });
}

/** GET /card/family/library/groups (operationId `getGroups`) -- scope `family:library:view`. */
export async function listFamilyLibrary(client: YotoClient): Promise<FamilyLibraryGroup[]> {
  const result = await client.request({
    method: "GET",
    path: "/card/family/library/groups",
    schema: listFamilyLibraryResponseSchema,
  });
  return result.groups;
}

/** GET /media/transcode/audio/uploadUrl (operationId `getAnUploadUrl`) -- scope `user:content:manage`. */
export async function getUploadUrl(
  client: YotoClient,
  options: { sha256?: string; filename?: string } = {},
): Promise<UploadUrlResponse> {
  return client.request({
    method: "GET",
    path: "/media/transcode/audio/uploadUrl",
    query: options,
    schema: uploadUrlResponseSchema,
  });
}

/**
 * GET /media/upload/{uploadId}/transcoded -- NOT in yoto.dev/openapi.json,
 * but proven in production by the old `yoto-mcp-server` (its
 * `uploadAndTranscodeAudio` polls this exact path). Ported per the plan's
 * instruction to carry over known-good endpoint behaviour the public spec
 * doesn't document.
 */
export async function getTranscodedStatus(
  client: YotoClient,
  uploadId: string,
  loudnorm: boolean,
): Promise<TranscodedResponse> {
  return client.request({
    method: "GET",
    path: `/media/upload/${encodeURIComponent(uploadId)}/transcoded`,
    query: { loudnorm },
    schema: transcodedResponseSchema,
    idempotent: true,
  });
}
