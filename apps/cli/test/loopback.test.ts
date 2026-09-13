import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitLoopbackCallback, LoopbackError } from "../src/auth/loopback.js";

/** Binds to an ephemeral port to find one that's free, then releases it. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function requestCallback(port: number, query: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/callback${query}`);
}

describe("loopback", () => {
  let occupier: Server | undefined;

  afterEach(async () => {
    if (occupier) {
      await new Promise<void>((resolve) => occupier?.close(() => resolve()));
      occupier = undefined;
    }
  });

  it("binds the port before returning, and rejects PORT_IN_USE when it's already taken", async () => {
    const port = await getFreePort();
    occupier = createServer((_req, res) => res.end("occupied"));
    await new Promise<void>((resolve) => occupier?.listen(port, "127.0.0.1", () => resolve()));

    await expect(awaitLoopbackCallback({ port, expectedState: "s" })).rejects.toMatchObject({
      code: "PORT_IN_USE",
    });
  });

  it("responds 400 and rejects on a state mismatch -- no code/token is returned", async () => {
    const port = await getFreePort();
    const promise = awaitLoopbackCallback({ port, expectedState: "expected-state" });
    // The HTTP round trip below settles this rejection before the assertions
    // get a chance to attach their own handler -- pin a no-op catch now so
    // Node never sees it as briefly unhandled.
    promise.catch(() => {});

    const response = await requestCallback(port, "?code=abc123&state=wrong-state");
    expect(response.status).toBe(400);

    await expect(promise).rejects.toBeInstanceOf(LoopbackError);
    await expect(promise).rejects.toMatchObject({ code: "CALLBACK_ERROR" });
  });

  it("serves the success page and resolves with the code on a matching state", async () => {
    const port = await getFreePort();
    const promise = awaitLoopbackCallback({ port, expectedState: "good-state" });

    const response = await requestCallback(port, "?code=the-code&state=good-state");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("You're signed in");

    const result = await promise;
    expect(result.code).toBe("the-code");
  });

  it("rejects with AUTH_TIMEOUT once the injected timeout fires, without waiting 300s for real", async () => {
    const port = await getFreePort();
    let firedCallback: (() => void) | undefined;
    let capturedMs: number | undefined;
    const fakeSetTimeout = ((callback: () => void, ms: number) => {
      firedCallback = callback;
      capturedMs = ms;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    const fakeClearTimeout = (() => {}) as typeof clearTimeout;

    const promise = awaitLoopbackCallback({
      port,
      expectedState: "s",
      timeoutMs: 300_000,
      setTimeoutImpl: fakeSetTimeout,
      clearTimeoutImpl: fakeClearTimeout,
    });

    // The real (non-faked) server bind is async I/O -- poll with real timers
    // until it has registered the injected timeout, then fire it by hand.
    await vi.waitFor(() => expect(firedCallback).toBeDefined(), { timeout: 2_000 });
    expect(capturedMs).toBe(300_000);
    firedCallback?.();

    await expect(promise).rejects.toMatchObject({ code: "AUTH_TIMEOUT" });
  });

  it("always closes the server -- the port is free again immediately after resolving", async () => {
    const port = await getFreePort();
    const promise = awaitLoopbackCallback({ port, expectedState: "s" });
    await requestCallback(port, "?code=x&state=s");
    await promise;

    // If the server were still listening, binding the same port again would fail.
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => resolve());
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  });
});
