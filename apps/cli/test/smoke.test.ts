import { describe, expect, it } from "vitest";
import { DEFAULT_CLIENT_ID } from "../src/main.js";

describe("apps/cli smoke", () => {
  it("ships the public Yoto PKCE client id as the stub default", () => {
    expect(DEFAULT_CLIENT_ID).toBe("xl4YsMpHEMnn7ubVhsRu8NhBwfUFPf8J");
  });
});
