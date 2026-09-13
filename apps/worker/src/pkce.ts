/**
 * PKCE (RFC 7636) helpers for the *upstream* leg of the flow -- the one where
 * this Worker is a client of Yoto. The downstream leg (MCP client -> us) is
 * PKCE-enforced by @cloudflare/workers-oauth-provider, not by this file.
 *
 * WebCrypto only: this runs in workerd.
 */

const VERIFIER_BYTES = 32;
const NONCE_BYTES = 16;

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return bytesToBase64Url(bytes);
}

export function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function randomToken(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) {
    // Index is always in range: the alphabet has 64 entries and we mask to 6 bits.
    out += BASE64URL_ALPHABET[byte & 0x3f] ?? "-";
  }
  return out;
}

/** A fresh PKCE `code_verifier` (RFC 7636 requires 43-128 unreserved chars). */
export function createCodeVerifier(): string {
  return randomToken(VERIFIER_BYTES * 2);
}

/** A single-use value that makes every `state` blob unique even for identical requests. */
export function createNonce(): string {
  return randomToken(NONCE_BYTES);
}

/** S256 challenge for a verifier. */
export async function createCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return bytesToBase64Url(new Uint8Array(digest));
}
