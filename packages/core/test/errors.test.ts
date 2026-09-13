import { describe, expect, it } from "vitest";
import { isYotoError, toToolResult, YotoError } from "../src/errors.js";

describe("YotoError", () => {
  it("carries a machine-readable code, retryable flag, hint and status", () => {
    const error = new YotoError("nope", {
      code: "AUTH_EXPIRED",
      hint: "run yoto_sign_in",
      retryable: true,
      status: 401,
    });
    expect(error.code).toBe("AUTH_EXPIRED");
    expect(error.hint).toBe("run yoto_sign_in");
    expect(error.retryable).toBe(true);
    expect(error.status).toBe(401);
    expect(error.name).toBe("YotoError");
  });

  it("defaults retryable to false", () => {
    const error = new YotoError("nope", { code: "VALIDATION" });
    expect(error.retryable).toBe(false);
  });

  it("isYotoError distinguishes YotoError from a plain Error", () => {
    expect(isYotoError(new YotoError("x", { code: "NOT_FOUND" }))).toBe(true);
    expect(isYotoError(new Error("x"))).toBe(false);
    expect(isYotoError("x")).toBe(false);
    expect(isYotoError(undefined)).toBe(false);
  });
});

describe("toToolResult", () => {
  it("turns a YotoError into an isError result with structured code/message/hint", () => {
    const result = toToolResult(
      new YotoError("Card not found", { code: "NOT_FOUND", hint: "check the cardId" }),
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      code: "NOT_FOUND",
      message: "Card not found",
      hint: "check the cardId",
    });
    expect(result.content[0]?.text).toContain("NOT_FOUND");
    expect(result.content[0]?.text).toContain("check the cardId");
  });

  it("wraps an unknown thrown value as UPSTREAM_ERROR", () => {
    const result = toToolResult("a plain string throw");
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("UPSTREAM_ERROR");
    expect(result.structuredContent.message).toBe("a plain string throw");
  });

  it("wraps a plain Error as UPSTREAM_ERROR using its message", () => {
    const result = toToolResult(new Error("boom"));
    expect(result.structuredContent).toEqual({ code: "UPSTREAM_ERROR", message: "boom" });
  });
});
