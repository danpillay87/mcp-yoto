import { describe, expect, it } from "vitest";
import { YOTO_SCOPES } from "../src/auth.js";

describe("YOTO_SCOPES", () => {
  it("never requests a device-control scope -- required for Yoto's Verified listing", () => {
    for (const scope of YOTO_SCOPES) {
      expect(scope).not.toContain("devices:control");
      expect(scope).not.toContain("devices:manage");
    }
  });

  it("requests exactly the scopes the plan decided on, plus device-status:view", () => {
    expect([...YOTO_SCOPES].sort()).toEqual(
      [
        "profile",
        "offline_access",
        "user:content:view",
        "user:content:manage",
        "user:icons:manage",
        "family:library:view",
        "family:devices:view",
        "family:device-status:view",
      ].sort(),
    );
  });
});
