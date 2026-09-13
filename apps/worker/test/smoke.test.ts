import { describe, expect, it } from "vitest";
import type { Env } from "../src/index.js";
import worker from "../src/index.js";

describe("apps/worker smoke", () => {
  it("answers 200 at /healthz", async () => {
    const env = {} as Env;
    const ctx = {} as ExecutionContext;
    const response = await worker.fetch(new Request("https://example.com/healthz"), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });
});
