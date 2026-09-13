import { describe, expect, it } from "vitest";
import { redact, tools, YotoClient, YotoError } from "../src/index.js";

describe("packages/core smoke", () => {
  it("exports a typed, empty tool registry (Phase 1 fills this in)", () => {
    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toHaveLength(0);
  });

  it("redacts JWT-shaped tokens before they reach any log line", () => {
    const message = "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123 leaked";
    expect(redact(message)).not.toContain("eyJ");
  });

  it("YotoError carries a machine-readable code and an optional hint", () => {
    const error = new YotoError("nope", { code: "AUTH_EXPIRED", hint: "run yoto_sign_in" });
    expect(error.code).toBe("AUTH_EXPIRED");
    expect(error.hint).toBe("run yoto_sign_in");
  });

  it("YotoClient stub reports its configured base URL", () => {
    const client = new YotoClient({ getToken: async () => "test-token" });
    expect(client.describe().baseUrl).toBe("https://api.yotoplay.com");
  });
});
