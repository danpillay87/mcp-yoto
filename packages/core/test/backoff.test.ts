import { describe, expect, it } from "vitest";
import { computeFullJitterDelayMs, parseRetryAfterMs } from "../src/yoto/client.js";

describe("computeFullJitterDelayMs", () => {
  it("is 0 when the injected random() returns 0, regardless of attempt", () => {
    expect(computeFullJitterDelayMs(1, { random: () => 0 })).toBe(0);
    expect(computeFullJitterDelayMs(5, { random: () => 0 })).toBe(0);
  });

  it("doubles the upper bound each attempt (base 300ms) until it hits the cap", () => {
    const max = (attempt: number) => computeFullJitterDelayMs(attempt, { random: () => 1 });
    expect(max(1)).toBe(300); // 300 * 2^0
    expect(max(2)).toBe(600); // 300 * 2^1
    expect(max(3)).toBe(1200); // 300 * 2^2
    expect(max(4)).toBe(2400); // 300 * 2^3
  });

  it("never exceeds the cap even at a high attempt count", () => {
    expect(computeFullJitterDelayMs(10, { random: () => 1 })).toBe(8000);
    expect(computeFullJitterDelayMs(20, { random: () => 1 })).toBe(8000);
  });

  it("honours custom base/cap overrides", () => {
    expect(computeFullJitterDelayMs(1, { random: () => 1, base: 1000, cap: 1500 })).toBe(1000);
    expect(computeFullJitterDelayMs(2, { random: () => 1, base: 1000, cap: 1500 })).toBe(1500);
  });

  it("scales linearly with random() between 0 and the upper bound", () => {
    expect(computeFullJitterDelayMs(1, { random: () => 0.5 })).toBe(150);
  });
});

describe("parseRetryAfterMs", () => {
  const now = () => 1_700_000_000_000;

  it("returns undefined when there is no header", () => {
    expect(parseRetryAfterMs(null, now)).toBeUndefined();
  });

  it("parses a delta-seconds value", () => {
    expect(parseRetryAfterMs("5", now)).toBe(5000);
  });

  it("parses an HTTP-date value relative to the injected clock", () => {
    const future = new Date(now() + 12_000).toUTCString();
    expect(parseRetryAfterMs(future, now)).toBe(12_000);
  });

  it("clamps a past HTTP-date to 0 rather than a negative delay", () => {
    const past = new Date(now() - 5_000).toUTCString();
    expect(parseRetryAfterMs(past, now)).toBe(0);
  });

  it("returns undefined for a header it can't parse", () => {
    expect(parseRetryAfterMs("not-a-value-at-all!!", now)).toBeUndefined();
  });
});
