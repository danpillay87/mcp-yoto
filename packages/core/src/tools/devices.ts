import { z } from "zod";
import { isYotoError, YotoError } from "../errors.js";
import { getDeviceConfig, listDevices } from "../yoto/endpoints.js";
import { deviceSchema } from "../yoto/types.js";
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

  return [yotoListDevices, yotoGetDeviceConfig];
}
