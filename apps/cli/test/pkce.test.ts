import { describe, expect, it } from "vitest";
import { codeChallengeFromVerifier, createPkcePair, createState } from "../src/auth/pkce.js";

describe("pkce", () => {
  it("matches the RFC 7636 Appendix B S256 test vector", () => {
    // https://www.rfc-editor.org/rfc/rfc7636#appendix-B
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(codeChallengeFromVerifier(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("creates a verifier within RFC 7636's 43-128 char range with a matching S256 challenge", () => {
    const pair = createPkcePair();
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.verifier.length).toBeLessThanOrEqual(128);
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(codeChallengeFromVerifier(pair.verifier)).toBe(pair.challenge);
  });

  it("creates a fresh, unpredictable pair on every call", () => {
    const a = createPkcePair();
    const b = createPkcePair();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });

  it("creates a base64url-safe, non-empty state value each time", () => {
    const a = createState();
    const b = createState();
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });
});
