/**
 * (Was smoke.test.ts, the Phase 0 stub check -- renamed rather than dropped.
 * The Worker's fetch handler can no longer be imported into plain Node because
 * the OAuth provider imports `cloudflare:workers`, so that job moved to
 * worker.test.ts, which runs the real bundle in workerd. What is left here is
 * the runtime-agnostic crypto the upstream leg depends on.)
 */
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  base64UrlDecode,
  base64UrlEncode,
  createCodeChallenge,
  createCodeVerifier,
  createNonce,
} from "../src/pkce.js";

describe("pkce", () => {
  it("produces a verifier in the RFC 7636 length range with unreserved chars only", () => {
    for (let i = 0; i < 20; i += 1) {
      const verifier = createCodeVerifier();
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      expect(verifier.length).toBeLessThanOrEqual(128);
      expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    }
  });

  it("produces a fresh verifier every time", () => {
    const seen = new Set(Array.from({ length: 50 }, () => createCodeVerifier()));
    expect(seen.size).toBe(50);
  });

  it("computes the S256 challenge the way an OAuth server will verify it", async () => {
    // Cross-checked against an independent implementation (node:crypto).
    const verifier = createCodeVerifier();
    const expected = createHash("sha256").update(verifier).digest("base64url");
    await expect(createCodeChallenge(verifier)).resolves.toBe(expected);
  });

  it("matches the RFC 7636 appendix B test vector", async () => {
    const challenge = await createCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("emits unpadded base64url", async () => {
    expect(await createCodeChallenge("x")).not.toContain("=");
    expect(await createCodeChallenge("x")).not.toMatch(/[+/]/);
  });

  it("round-trips arbitrary bytes through base64url", () => {
    for (let length = 0; length < 40; length += 1) {
      const bytes = new Uint8Array(randomBytes(length));
      expect(Array.from(base64UrlDecode(base64UrlEncode(bytes)))).toEqual(Array.from(bytes));
    }
  });

  it("agrees with node's base64url encoder", () => {
    const bytes = new Uint8Array(randomBytes(33));
    expect(base64UrlEncode(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
  });

  it("produces a distinct nonce each call", () => {
    const seen = new Set(Array.from({ length: 50 }, () => createNonce()));
    expect(seen.size).toBe(50);
  });
});
