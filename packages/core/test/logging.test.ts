import { describe, expect, it } from "vitest";
import { createLogger, redact } from "../src/logging.js";

describe("redact", () => {
  it("redacts JWT-shaped tokens", () => {
    const message =
      "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456ghi789jkl leaked";
    expect(redact(message)).not.toContain("eyJ");
    expect(redact(message)).toContain("[redacted]");
  });

  it("redacts long bearer-shaped opaque tokens even without a JWT prefix", () => {
    const message = `Authorization: Bearer ${"a".repeat(40)}`;
    expect(redact(message)).toBe("Authorization: Bearer [redacted]");
  });

  it("leaves short, ordinary text untouched", () => {
    expect(redact("cardId=abc123 status=ok")).toBe("cardId=abc123 status=ok");
  });
});

describe("createLogger", () => {
  it("defaults to a no-op sink -- nothing is written unless one is supplied", () => {
    const logger = createLogger();
    expect(() => logger.info("hello")).not.toThrow();
  });

  it("redacts both the message and any data fields before they reach the sink", () => {
    const lines: Array<{ level: string; message: string; data?: Record<string, unknown> }> = [];
    const logger = createLogger({ sink: (line) => lines.push(line) });
    const token = `ey${"J".repeat(2)}${"a".repeat(40)}`;
    logger.error("upstream failed", { token, cardId: "abc123" });
    expect(lines).toHaveLength(1);
    expect(JSON.stringify(lines[0])).not.toContain(token);
    expect(lines[0]?.data?.cardId).toBe("abc123");
  });

  it("filters out lines below the configured minimum level", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "warn", sink: (line) => lines.push(line.level) });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(lines).toEqual(["warn", "error"]);
  });
});
