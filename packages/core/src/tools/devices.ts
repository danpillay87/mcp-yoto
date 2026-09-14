import { z } from "zod";
import { isYotoError, YotoError } from "../errors.js";
import { getCard, getDeviceConfig, getDeviceStatus, listDevices } from "../yoto/endpoints.js";
import { deviceSchema, deviceStatusSchema } from "../yoto/types.js";
import type { AnyToolSpec, CreateToolsDeps } from "./_helpers.js";

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export function createDeviceTools(deps: CreateToolsDeps): AnyToolSpec[] {
  const yotoListDevices: AnyToolSpec = {
    name: "yoto_list_devices",
    title: "List your Yoto devices",
    description:
      "Lists the family's Yoto players -- name, online status, and device type. View-only.",
    group: "devices",
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: z.object({}),
    outputSchema: z.object({ devices: z.array(deviceSchema) }),
    summary: (output) => `${output.devices.length} device(s).`,
    handler: async () => ({ devices: await listDevices(deps.client) }),
  };

  const yotoGetDeviceConfig: AnyToolSpec = {
    name: "yoto_get_device_config",
    title: "Get a Yoto device's configuration",
    description:
      "Fetches one player's device configuration (clock face, volume limits, right-hand-" +
      "button shortcuts, etc). This is a beta Yoto endpoint that needs a device-management " +
      "scope this server intentionally never requests, so expect a FORBIDDEN_SCOPE result " +
      "with a hint rather than data.",
    group: "devices",
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: z.object({ deviceId: z.string().min(1) }),
    outputSchema: z.object({ config: z.record(z.string(), z.unknown()) }),
    summary: () => "Fetched device configuration.",
    handler: async (args) => {
      try {
        return { config: await getDeviceConfig(deps.client, args.deviceId) };
      } catch (error) {
        if (isYotoError(error) && error.code === "FORBIDDEN_SCOPE") {
          throw new YotoError("Device configuration needs a scope this connection doesn't have.", {
            code: "FORBIDDEN_SCOPE",
            status: error.status,
            hint:
              "Yoto's device-config endpoint is in beta and requires family:devices:manage, " +
              "which this server deliberately doesn't request (it only asks for " +
              "family:devices:view, to stay eligible for Yoto's Verified listing). Use the " +
              "Yoto app's right-hand-button shortcuts screen instead.",
          });
        }
        throw error;
      }
    },
  };

  const yotoPlayerStatus: AnyToolSpec = {
    name: "yoto_player_status",
    title: "What's playing on a Yoto player right now",
    description:
      "Live snapshot of one player: which card (if any) is loaded, battery level, " +
      "volume, nightlight mode, and whether headphones are connected. Reads Yoto's " +
      "device-status endpoint, which Yoto's own docs mark deprecated and which doesn't " +
      "expose a playing-vs-paused signal -- so `state` can only tell you whether a card " +
      "is inserted (\"stopped\" when there isn't one), not whether it's actively " +
      "playing. `refresh: true` is accepted but never honoured: asking a player to push " +
      "a fresh status needs the family:devices:control scope, which this server " +
      "deliberately never requests (see the plan's Verified-listing scope decision) -- " +
      "it always just reads whatever Yoto last recorded, and says so via refreshNote.",
    group: "devices",
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: z.object({
      deviceId: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Omit to use the family's only device, or the first one (by list order) if there are several.",
        ),
      refresh: z
        .boolean()
        .default(false)
        .describe(
          "Requests a fresh push from the player before reading. Currently never applied " +
            "(see the tool description) -- always falls through to a plain read.",
        ),
    }),
    outputSchema: z.object({
      deviceId: z.string(),
      deviceName: z.string().optional(),
      deviceCount: z.number().int().nonnegative(),
      deviceSelectionNote: z
        .string()
        .optional()
        .describe("Present when deviceId was omitted, saying which device was picked and why."),
      state: z.enum(["playing", "paused", "stopped", "unknown"]),
      activeCardId: z.string().optional(),
      activeCardTitle: z.string().nullable().optional(),
      cardTitleNote: z
        .string()
        .optional()
        .describe("Present when the card's title couldn't be fetched, e.g. an official card."),
      cardInserted: z.boolean().optional(),
      batteryLevel: z.number().optional().describe("Percentage, 0-100."),
      charging: z.boolean().optional(),
      volume: z.number().optional().describe("Percentage, 0-100."),
      nightlightMode: z.string().nullable().optional().describe('A hex colour, or "off".'),
      headphonesConnected: z.boolean().optional(),
      lastSeen: z.string().optional().describe("ISO timestamp of the player's last check-in."),
      refreshRequested: z.boolean(),
      refreshApplied: z
        .boolean()
        .describe("Always false today -- see refreshNote and the tool description."),
      refreshNote: z.string().optional(),
      raw: deviceStatusSchema.describe(
        "The untouched status response, for anything not surfaced above.",
      ),
    }),
    summary: (output) => {
      const card = output.activeCardTitle
        ? `"${output.activeCardTitle}"`
        : output.activeCardId
          ? `card ${output.activeCardId}`
          : "no card";
      const battery = output.batteryLevel !== undefined ? `, ${output.batteryLevel}% battery` : "";
      return `${output.deviceName ?? output.deviceId} -- ${output.state}, ${card}${battery}.`;
    },
    handler: async (args) => {
      const devices = await listDevices(deps.client);
      if (devices.length === 0) {
        throw new YotoError("No Yoto devices found on this family account.", {
          code: "NOT_FOUND",
          hint: "Add a player in the Yoto app, then try again.",
        });
      }

      let deviceSelectionNote: string | undefined;
      let device: (typeof devices)[number];
      if (args.deviceId) {
        const found = devices.find((d) => d.deviceId === args.deviceId);
        if (!found) {
          throw new YotoError(`Device ${args.deviceId} wasn't found on this family account.`, {
            code: "NOT_FOUND",
            hint: `Known devices: ${devices.map((d) => d.name ?? d.deviceId).join(", ")}.`,
          });
        }
        device = found;
      } else {
        // devices.length > 0 is guaranteed by the check above, so devices[0] always exists.
        device = devices[0] as (typeof devices)[number];
        deviceSelectionNote =
          devices.length === 1
            ? `Used the only device on this account: ${device.name ?? device.deviceId}.`
            : `No deviceId given -- used the first of ${devices.length} devices: ${device.name ?? device.deviceId}.`;
      }
      const deviceId = device.deviceId;

      const refreshNote = args.refresh
        ? "Skipped: asking a player to push a fresh status needs family:devices:control, " +
          "which this server deliberately never requests. Showing the last status Yoto has on file."
        : undefined;

      let status: z.infer<typeof deviceStatusSchema>;
      try {
        status = await getDeviceStatus(deps.client, deviceId);
      } catch (error) {
        if (isYotoError(error) && error.code === "FORBIDDEN_SCOPE") {
          throw new YotoError("Player status needs a scope this connection doesn't have.", {
            code: "FORBIDDEN_SCOPE",
            status: error.status,
            hint:
              "Yoto's device-status endpoint needs the family:device-status:view " +
              "permission -- sign out and back in to grant it.",
          });
        }
        throw error;
      }

      const state: "playing" | "paused" | "stopped" | "unknown" =
        status.cardInsertionState === undefined
          ? "unknown"
          : status.cardInsertionState === 0
            ? "stopped"
            : "unknown";
      const cardInserted =
        status.cardInsertionState === undefined ? undefined : status.cardInsertionState !== 0;

      let activeCardTitle: string | null | undefined;
      let cardTitleNote: string | undefined;
      if (status.activeCard) {
        try {
          const card = await getCard(deps.client, status.activeCard);
          activeCardTitle = card.title;
        } catch (error) {
          activeCardTitle = null;
          cardTitleNote = isYotoError(error)
            ? `Couldn't fetch this card's title (${error.code}) -- likely an official Yoto card rather than one of yours.`
            : "Couldn't fetch this card's title.";
        }
      }

      return {
        deviceId,
        deviceName: device?.name,
        deviceCount: devices.length,
        deviceSelectionNote,
        state,
        activeCardId: status.activeCard ?? undefined,
        activeCardTitle,
        cardTitleNote,
        cardInserted,
        batteryLevel: status.batteryLevelPercentage,
        charging: status.isCharging,
        volume: status.userVolumePercentage ?? status.systemVolumePercentage,
        nightlightMode: status.nightlightMode,
        headphonesConnected: status.isAudioDeviceConnected,
        lastSeen: status.updatedAt,
        refreshRequested: args.refresh,
        refreshApplied: false,
        refreshNote,
        raw: status,
      };
    },
  };

  return [yotoListDevices, yotoGetDeviceConfig, yotoPlayerStatus];
}
