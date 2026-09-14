import { describe, expect, it } from "vitest";
import { isYotoError } from "../src/errors.js";
import { noopLogger } from "../src/logging.js";
import type { CreateToolsDeps } from "../src/tools/_helpers.js";
import { createDeviceTools } from "../src/tools/devices.js";
import { YotoClient } from "../src/yoto/client.js";
import { type FakeResponseSpec, makeFakeFetch } from "./helpers/fake-fetch.js";

/** Builds the CreateToolsDeps yoto_player_status actually reads (client), stubbing the rest. */
function buildDeps(responses: FakeResponseSpec[]): {
  deps: CreateToolsDeps;
  calls: { url: string; method: string | undefined }[];
} {
  const { fetch: fakeFetch, calls } = makeFakeFetch(responses);
  const client = new YotoClient({ getToken: async () => "fake-token", fetchImpl: fakeFetch });
  const deps: CreateToolsDeps = {
    mode: "cli",
    client,
    logger: noopLogger,
    auth: {
      mode: "cli",
      getAccessToken: async () => "fake-token",
      status: async () => ({ signedIn: true, mode: "cli" }),
    },
    resolveAudio: async () => {
      throw new Error("not used by yoto_player_status");
    },
    resolveImage: async () => {
      throw new Error("not used by yoto_player_status");
    },
  };
  return { deps, calls };
}

function getPlayerStatusTool(deps: CreateToolsDeps) {
  const tool = createDeviceTools(deps).find((t) => t.name === "yoto_player_status");
  if (!tool) throw new Error("yoto_player_status not registered by createDeviceTools");
  return tool;
}

describe("yoto_player_status", () => {
  it("uses the only device when deviceId is omitted, and resolves the active card's title", async () => {
    const { deps } = buildDeps([
      { status: 200, jsonBody: { devices: [{ deviceId: "d1", name: "Kitchen Yoto" }] } },
      {
        status: 200,
        jsonBody: {
          deviceId: "d1",
          activeCard: "card-1",
          cardInsertionState: 1,
          batteryLevelPercentage: 80,
          isCharging: false,
          userVolumePercentage: 50,
          nightlightMode: "off",
          isAudioDeviceConnected: false,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      { status: 200, jsonBody: { card: { cardId: "card-1", title: "Bedtime Stories" } } },
    ]);
    const tool = getPlayerStatusTool(deps);

    const output = await tool.handler({ refresh: false }, { logger: noopLogger });

    expect(output.deviceId).toBe("d1");
    expect(output.deviceName).toBe("Kitchen Yoto");
    expect(output.deviceCount).toBe(1);
    expect(output.deviceSelectionNote).toContain("only device");
    expect(output.activeCardId).toBe("card-1");
    expect(output.activeCardTitle).toBe("Bedtime Stories");
    expect(output.cardTitleNote).toBeUndefined();
    expect(output.cardInserted).toBe(true);
    expect(output.batteryLevel).toBe(80);
    expect(output.charging).toBe(false);
    expect(output.volume).toBe(50);
    expect(output.nightlightMode).toBe("off");
    expect(output.headphonesConnected).toBe(false);
    expect(output.lastSeen).toBe("2026-01-01T00:00:00.000Z");
    expect(output.refreshRequested).toBe(false);
    expect(output.refreshApplied).toBe(false);
    expect(output.refreshNote).toBeUndefined();
    expect(output.raw).toMatchObject({ deviceId: "d1", activeCard: "card-1" });
  });

  it("picks the first of several devices when deviceId is omitted, and says how many exist", async () => {
    const { deps } = buildDeps([
      {
        status: 200,
        jsonBody: {
          devices: [
            { deviceId: "d1", name: "Kitchen Yoto" },
            { deviceId: "d2", name: "Bedroom Yoto" },
          ],
        },
      },
      {
        status: 200,
        jsonBody: { deviceId: "d1", cardInsertionState: 0, updatedAt: "2026-01-01T00:00:00.000Z" },
      },
    ]);
    const tool = getPlayerStatusTool(deps);

    const output = await tool.handler({ refresh: false }, { logger: noopLogger });

    expect(output.deviceId).toBe("d1");
    expect(output.deviceCount).toBe(2);
    expect(output.deviceSelectionNote).toContain("first of 2");
    expect(output.cardInserted).toBe(false);
    expect(output.activeCardId).toBeUndefined();
  });

  describe("state", () => {
    it("reports active when the status response has an active card", async () => {
      const { deps } = buildDeps([
        { status: 200, jsonBody: { devices: [{ deviceId: "d1" }] } },
        {
          status: 200,
          jsonBody: {
            deviceId: "d1",
            activeCard: "card-1",
            isOnline: true,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      ]);
      const tool = getPlayerStatusTool(deps);

      const output = await tool.handler({ refresh: false }, { logger: noopLogger });

      expect(output.state).toBe("active");
    });

    it("reports idle when online with no active card", async () => {
      const { deps } = buildDeps([
        { status: 200, jsonBody: { devices: [{ deviceId: "d1" }] } },
        {
          status: 200,
          jsonBody: { deviceId: "d1", isOnline: true, updatedAt: "2026-01-01T00:00:00.000Z" },
        },
      ]);
      const tool = getPlayerStatusTool(deps);

      const output = await tool.handler({ refresh: false }, { logger: noopLogger });

      expect(output.state).toBe("idle");
    });

    it("reports offline from the status payload's own isOnline flag, even with an active card", async () => {
      const { deps } = buildDeps([
        { status: 200, jsonBody: { devices: [{ deviceId: "d1" }] } },
        {
          status: 200,
          jsonBody: {
            deviceId: "d1",
            activeCard: "card-1",
            isOnline: false,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
        { status: 403, jsonBody: { message: "forbidden" } },
      ]);
      const tool = getPlayerStatusTool(deps);

      const output = await tool.handler({ refresh: false }, { logger: noopLogger });

      // An offline signal wins over an active card -- showing "active" off stale
      // data on an unreachable player would be misleading.
      expect(output.state).toBe("offline");
    });

    it("falls back to the device list's online flag when the status payload omits isOnline", async () => {
      const { deps } = buildDeps([
        { status: 200, jsonBody: { devices: [{ deviceId: "d1", online: false }] } },
        {
          status: 200,
          jsonBody: { deviceId: "d1", updatedAt: "2026-01-01T00:00:00.000Z" },
        },
      ]);
      const tool = getPlayerStatusTool(deps);

      const output = await tool.handler({ refresh: false }, { logger: noopLogger });

      expect(output.state).toBe("offline");
    });

    it("reports unknown when there's no online signal at all and no active card", async () => {
      const { deps } = buildDeps([
        { status: 200, jsonBody: { devices: [{ deviceId: "d1" }] } },
        {
          status: 200,
          jsonBody: {
            deviceId: "d1",
            cardInsertionState: 1,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      ]);
      const tool = getPlayerStatusTool(deps);

      const output = await tool.handler({ refresh: false }, { logger: noopLogger });

      // Yoto's device-status endpoint has no playing/paused field, and here there's
      // no online signal either -- this must never be upgraded to a guess.
      expect(output.state).toBe("unknown");
    });
  });

  it("throws a clear NOT_FOUND when the family has no devices at all", async () => {
    const { deps } = buildDeps([{ status: 200, jsonBody: { devices: [] } }]);
    const tool = getPlayerStatusTool(deps);

    try {
      await tool.handler({ refresh: false }, { logger: noopLogger });
      expect.unreachable("expected yoto_player_status to throw");
    } catch (error) {
      expect(isYotoError(error)).toBe(true);
      if (isYotoError(error)) expect(error.code).toBe("NOT_FOUND");
    }
  });

  it("throws a clear NOT_FOUND when the given deviceId isn't on the account", async () => {
    const { deps } = buildDeps([{ status: 200, jsonBody: { devices: [{ deviceId: "d1" }] } }]);
    const tool = getPlayerStatusTool(deps);

    try {
      await tool.handler({ deviceId: "does-not-exist", refresh: false }, { logger: noopLogger });
      expect.unreachable("expected yoto_player_status to throw");
    } catch (error) {
      expect(isYotoError(error)).toBe(true);
      if (isYotoError(error)) expect(error.code).toBe("NOT_FOUND");
    }
  });

  it("falls back to a null card title with a note when the card fetch is forbidden", async () => {
    const { deps } = buildDeps([
      { status: 200, jsonBody: { devices: [{ deviceId: "d1" }] } },
      {
        status: 200,
        jsonBody: {
          deviceId: "d1",
          activeCard: "official-card-1",
          cardInsertionState: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      { status: 403, jsonBody: { message: "forbidden" } },
    ]);
    const tool = getPlayerStatusTool(deps);

    const output = await tool.handler({ refresh: false }, { logger: noopLogger });

    expect(output.activeCardId).toBe("official-card-1");
    expect(output.activeCardTitle).toBeNull();
    expect(output.cardTitleNote).toContain("FORBIDDEN_SCOPE");
  });

  it("surfaces a 403 on the status endpoint as a friendly FORBIDDEN_SCOPE error", async () => {
    const { deps } = buildDeps([
      { status: 200, jsonBody: { devices: [{ deviceId: "d1" }] } },
      { status: 403, jsonBody: { message: "forbidden" } },
    ]);
    const tool = getPlayerStatusTool(deps);

    try {
      await tool.handler({ refresh: false }, { logger: noopLogger });
      expect.unreachable("expected yoto_player_status to throw");
    } catch (error) {
      expect(isYotoError(error)).toBe(true);
      if (!isYotoError(error)) throw error;
      expect(error.code).toBe("FORBIDDEN_SCOPE");
      expect(error.hint).toContain("Yoto hasn't yet made the player-status permission available");
      expect(error.hint).not.toMatch(/sign (out|in)/i);
    }
  });

  it("accepts refresh: true but never applies it, and explains why in refreshNote", async () => {
    const { deps, calls } = buildDeps([
      { status: 200, jsonBody: { devices: [{ deviceId: "d1" }] } },
      {
        status: 200,
        jsonBody: { deviceId: "d1", cardInsertionState: 0, updatedAt: "2026-01-01T00:00:00.000Z" },
      },
    ]);
    const tool = getPlayerStatusTool(deps);

    const output = await tool.handler({ refresh: true }, { logger: noopLogger });

    expect(output.refreshRequested).toBe(true);
    expect(output.refreshApplied).toBe(false);
    expect(output.refreshNote).toContain("family:devices:control");
    // Only the device list + a plain status GET happened -- no POST to
    // command/status, which needs the control scope this server never asks for.
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.method === undefined || call.method === "GET")).toBe(true);
    expect(calls.some((call) => call.url.includes("command/status"))).toBe(false);
  });

  it("strips network identifiers (e.g. the home Wi-Fi name) out of the raw block", async () => {
    const { deps } = buildDeps([
      { status: 200, jsonBody: { devices: [{ deviceId: "d1" }] } },
      {
        status: 200,
        jsonBody: {
          deviceId: "d1",
          networkSsid: "The Pillay Household",
          isOnline: true,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    ]);
    const tool = getPlayerStatusTool(deps);

    const output = await tool.handler({ refresh: false }, { logger: noopLogger });

    expect(output.raw).not.toHaveProperty("networkSsid");
    // Everything else in the raw block survives the redaction pass.
    expect(output.raw).toMatchObject({ deviceId: "d1", isOnline: true });
  });
});
