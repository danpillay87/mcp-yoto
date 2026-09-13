/**
 * PKCE (RFC 7636) helpers for the CLI's loopback sign-in flow. Node-only
 * (`node:crypto`) -- apps/cli is allowed node: imports, unlike
 * packages/core, which stays fetch + WebCrypto only.
 */
import { createHash, randomBytes } from "node:crypto";

/** RFC 7636 S256 `code_challenge` for a given `code_verifier`. Exported standalone for tests. */
export function codeChallengeFromVerifier(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** A fresh PKCE pair: a 32-byte random verifier (well within RFC 7636's 43-128 char range), S256 challenge. */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: codeChallengeFromVerifier(verifier) };
}

/** A single-use value correlating the loopback callback with the request that started it. */
export function createState(): string {
  return randomBytes(16).toString("base64url");
}
