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

/** Matches Wi-Fi/network-identifying key names -- ssid, bssid, any mac/ip address field. */
const NETWORK_IDENTIFIER_KEY = /ssid|bssid|mac|ip[_a-z]*address|wifi.*(ssid|mac)/i;

/**
 * Strips network-identifying fields (Wi-Fi SSID/BSSID, MAC/IP addresses, ...) from a raw
 * status object before it's echoed back in `raw` -- one level deep is enough, since
 * deviceStatusSchema is flat. Covers both the documented `networkSsid` field and anything
 * unlisted a live device might pass through (it's a loose/passthrough schema).
 */
function redactNetworkIdentifiers(
  status: z.infer<typeof deviceStatusSchema>,
): z.infer<typeof deviceStatusSchema> {
  const redacted = { ...status } as Record<string, unknown>;
  for (const key of Object.keys(redacted)) {
    if (NETWORK_IDENTIFIER_KEY.test(key)) delete redacted[key];
  }
  return redacted as z.infer<typeof deviceStatusSchema>;
}

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
    title: "Get a Yoto player's live status",
    description:
      "Live snapshot of one player: which card (if any) is loaded, battery level, " +
      "volume, nightlight mode, and whether headphones are connected. Uses a Yoto " +
      "endpoint Yoto has marked deprecated (no replacement published yet) -- may stop " +
      "working if Yoto removes it. That endpoint has no playing-vs-paused signal, so " +
      "`state` only reports whether the player looks active, idle, or offline (see the " +
      "state field for exactly what each value means), never real-time playback. " +
      "`refresh: true` is accepted but never honoured: asking a player to push a fresh " +
      "status needs the family:devices:control scope, which this server deliberately " +
      "never requests (it only asks for view-level access, to stay eligible for Yoto's " +
      "Verified listing) -- it always just reads whatever Yoto last recorded, and says " +
      "so via refreshNote. Network identifiers (e.g. the home Wi-Fi name) are removed " +
      "from the raw block.",
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
      state: z
        .enum(["active", "idle", "offline", "unknown"])
        .describe(
          "active: an active card is set. idle: the player looks online with no active " +
            "card. offline: the player is reporting (or was last seen) offline. unknown: " +
            "not enough signal to tell either way. Yoto's status endpoint has no " +
            "playing/paused field, so this can never distinguish playing from paused.",
        ),
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
        "The status response, for anything not surfaced above -- network identifiers " +
          "(e.g. the home Wi-Fi name) are stripped out before this is returned.",
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

      // Priority: an explicit offline signal always wins (showing "active" off stale
      // data on an unreachable player would be misleading), then an active card, then
      // a plain online signal, else there just isn't enough to go on.
      const onlineSignal = status.isOnline ?? device.online;
      const state: "active" | "idle" | "offline" | "unknown" =
        onlineSignal === false
          ? "offline"
          : status.activeCard
            ? "active"
            : onlineSignal === true
              ? "idle"
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
        raw: redactNetworkIdentifiers(status),
      };
    },
  };

  return [yotoListDevices, yotoGetDeviceConfig, yotoPlayerStatus];
}
