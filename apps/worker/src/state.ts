/**
 * The `state` parameter we hand to Yoto.
 *
 * Constraints that drove this design:
 *  - NOTHING may be stored server-side for an in-flight authorization. A KV
 *    write per click is both a storage liability and a failure mode.
 *  - The PKCE `code_verifier` travels inside `state`, so `state` must be
 *    confidential, not merely signed. Base64 JSON would hand the verifier to
 *    anyone who can read a browser URL bar, a referrer header or a proxy log.
 *  - The blob must be bound to this deployment and expire on its own.
 *
 * So: AES-256-GCM, key derived with HKDF-SHA256 from the `STATE_SECRET`
 * deployment secret, AAD bound to the issuer, explicit `exp` inside the
 * plaintext, random 96-bit IV prepended. Rotating STATE_SECRET invalidates
 * in-flight sign-ins only (10 minutes of them) -- it touches no issued grant.
 *
 * The provider exposes no helper for this: @cloudflare/workers-oauth-provider
 * 0.10.3 exports no signing/encryption utility for application state (checked
 * against its .d.ts export list), so this is ours to own.
 */
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { base64UrlDecode, base64UrlEncode } from "./pkce.js";

const IV_BYTES = 12;
const STATE_VERSION = 1;
const HKDF_INFO = "mcp-yoto/state/v1";

export interface StatePayload {
  /** Format version, so a future change can be rejected rather than misread. */
  v: number;
  /** The MCP client's original authorization request, returned by parseAuthRequest. */
  req: AuthRequest;
  /** PKCE verifier for the Yoto leg. Confidential. */
  verifier: string;
  /** Single-use uniqueness value. */
  nonce: string;
  /** Unix seconds. */
  exp: number;
}

export type StateFailure = "malformed" | "invalid" | "expired" | "unsupported_version";

export class StateError extends Error {
  readonly reason: StateFailure;
  constructor(reason: StateFailure) {
    super(`state ${reason}`);
    this.name = "StateError";
    this.reason = reason;
  }
}

async function deriveStateKey(secret: string, issuer: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const baseKey = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      // Salt is the deployment identity, so the same secret on two Workers
      // yields two different keys.
      salt: encoder.encode(issuer),
      info: encoder.encode(HKDF_INFO),
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function additionalData(issuer: string): Uint8Array {
  return new TextEncoder().encode(`mcp-yoto|state|v${STATE_VERSION}|${issuer}`);
}

export interface StateContext {
  stateSecret: string;
  issuer: string;
}

export async function encryptState(
  payload: Omit<StatePayload, "v">,
  ctx: StateContext,
): Promise<string> {
  const key = await deriveStateKey(ctx.stateSecret, ctx.issuer);
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);
  const plaintext = new TextEncoder().encode(JSON.stringify({ v: STATE_VERSION, ...payload }));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: additionalData(ctx.issuer) },
      key,
      plaintext,
    ),
  );
  const packed = new Uint8Array(iv.length + ciphertext.length);
  packed.set(iv, 0);
  packed.set(ciphertext, iv.length);
  return base64UrlEncode(packed);
}

/**
 * @throws {StateError} for anything that is not a currently valid blob issued
 *   by this deployment. Callers must treat every failure identically: a
 *   tampered state is indistinguishable from an expired one on the wire.
 */
export async function decryptState(
  value: string,
  ctx: StateContext,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<StatePayload> {
  let packed: Uint8Array;
  try {
    packed = base64UrlDecode(value);
  } catch {
    throw new StateError("malformed");
  }
  if (packed.length <= IV_BYTES) throw new StateError("malformed");

  const key = await deriveStateKey(ctx.stateSecret, ctx.issuer);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: packed.subarray(0, IV_BYTES),
        additionalData: additionalData(ctx.issuer),
      },
      key,
      packed.subarray(IV_BYTES),
    );
  } catch {
    throw new StateError("invalid");
  }

  let parsed: StatePayload;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext)) as StatePayload;
  } catch {
    throw new StateError("invalid");
  }

  if (parsed.v !== STATE_VERSION) throw new StateError("unsupported_version");
  if (typeof parsed.exp !== "number" || parsed.exp <= nowSeconds) throw new StateError("expired");
  if (typeof parsed.verifier !== "string" || !parsed.req) throw new StateError("invalid");

  return parsed;
}
