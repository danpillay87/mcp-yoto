import { describe, expect, it } from "vitest";
import { decryptState, encryptState, type StateContext, StateError } from "../src/state.js";

const ctx: StateContext = {
  stateSecret: "0123456789abcdef0123456789abcdef",
  issuer: "https://mcp-yoto.example.workers.dev",
};

const REQUEST = {
  responseType: "code",
  clientId: "client-abc",
  redirectUri: "https://client.example/callback",
  scope: ["user:content:view"],
  state: "client-state-value",
  codeChallenge: "downstream-challenge",
  codeChallengeMethod: "S256",
  issuer: ctx.issuer,
};

const VERIFIER = "upstream-pkce-verifier-value-must-stay-secret";

function future(seconds = 600): number {
  return Math.floor(Date.now() / 1000) + seconds;
}

async function makeState(overrides: Partial<Parameters<typeof encryptState>[0]> = {}) {
  return encryptState(
    { req: REQUEST, verifier: VERIFIER, nonce: "nonce-1", exp: future(), ...overrides },
    ctx,
  );
}

describe("state", () => {
  it("round-trips the authorization request and the PKCE verifier", async () => {
    const payload = await decryptState(await makeState(), ctx);
    expect(payload.req.clientId).toBe("client-abc");
    expect(payload.req.redirectUri).toBe("https://client.example/callback");
    expect(payload.req.state).toBe("client-state-value");
    expect(payload.verifier).toBe(VERIFIER);
  });

  it("is opaque: the verifier does not appear in the encoded blob", async () => {
    const state = await makeState();
    expect(state).not.toContain(VERIFIER);
    expect(state).not.toContain("client-abc");
    // Not base64-JSON either -- decoding it must not yield readable text.
    const decoded = Buffer.from(state.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    );
    expect(decoded).not.toContain("verifier");
    expect(decoded).not.toContain("redirectUri");
  });

  it("produces a different blob every time (random IV + nonce)", async () => {
    expect(await makeState()).not.toBe(await makeState());
  });

  it("rejects a tampered blob", async () => {
    const state = await makeState();
    const tampered = `${state.slice(0, -4)}${state.slice(-4) === "AAAA" ? "BBBB" : "AAAA"}`;
    await expect(decryptState(tampered, ctx)).rejects.toBeInstanceOf(StateError);
  });

  it("rejects a blob encrypted for a different issuer (AAD binding)", async () => {
    const state = await encryptState(
      { req: REQUEST, verifier: VERIFIER, nonce: "n", exp: future() },
      { ...ctx, issuer: "https://someone-elses.workers.dev" },
    );
    await expect(decryptState(state, ctx)).rejects.toMatchObject({ reason: "invalid" });
  });

  it("rejects a blob made with a different STATE_SECRET", async () => {
    const state = await encryptState(
      { req: REQUEST, verifier: VERIFIER, nonce: "n", exp: future() },
      { ...ctx, stateSecret: "ffffffffffffffffffffffffffffffff" },
    );
    await expect(decryptState(state, ctx)).rejects.toMatchObject({ reason: "invalid" });
  });

  it("rejects an expired blob", async () => {
    const state = await makeState({ exp: Math.floor(Date.now() / 1000) - 1 });
    await expect(decryptState(state, ctx)).rejects.toMatchObject({ reason: "expired" });
  });

  it("rejects rubbish", async () => {
    await expect(decryptState("not-a-state", ctx)).rejects.toMatchObject({ reason: "malformed" });
    await expect(decryptState("", ctx)).rejects.toMatchObject({ reason: "malformed" });
  });
});
