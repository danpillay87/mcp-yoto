import { describe, expect, it } from "vitest";
import { z } from "zod";
import { isYotoError } from "../src/errors.js";
import { YotoClient } from "../src/yoto/client.js";
import { makeFakeFetch } from "./helpers/fake-fetch.js";

function makeClient(
  fetchImpl: typeof fetch,
  overrides: Partial<ConstructorParameters<typeof YotoClient>[0]> = {},
) {
  return new YotoClient({
    getToken: async () => "test-access-token",
    fetchImpl,
    sleep: async () => {}, // no real waiting in tests
    ...overrides,
  });
}

const pingSchema = z.object({ ok: z.boolean() });

describe("YotoClient retries", () => {
  it("retries a 429 honouring Retry-After, then succeeds", async () => {
    const { fetch: fakeFetch, calls } = makeFakeFetch([
      { status: 429, headers: { "retry-after": "1" } },
      { status: 200, jsonBody: { ok: true } },
    ]);
    const client = makeClient(fakeFetch);
    const result = await client.request({
      method: "GET",
      path: "/content/mine",
      schema: pingSchema,
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("retries 5xx up to the attempt cap, then succeeds on the third try", async () => {
    const { fetch: fakeFetch, calls } = makeFakeFetch([
      { status: 500, textBody: "server error" },
      { status: 502, textBody: "bad gateway" },
      { status: 200, jsonBody: { ok: true } },
    ]);
    const client = makeClient(fakeFetch);
    const result = await client.request({
      method: "GET",
      path: "/content/mine",
      schema: pingSchema,
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(3);
  });

  it("gives up as UPSTREAM_ERROR after exhausting retries on persistent 5xx", async () => {
    const { fetch: fakeFetch, calls } = makeFakeFetch([
      { status: 500 },
      { status: 500 },
      { status: 500 },
    ]);
    const client = makeClient(fakeFetch);
    await expect(client.request({ method: "GET", path: "/content/mine" })).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
    expect(calls).toHaveLength(3);
  });

  it("never retries a non-idempotent POST after it has been sent, even on a 500", async () => {
    const { fetch: fakeFetch, calls } = makeFakeFetch([{ status: 500, textBody: "boom" }]);
    const client = makeClient(fakeFetch);
    await expect(
      client.request({ method: "POST", path: "/content", body: { title: "x" } }),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(calls).toHaveLength(1);
  });

  it("does retry a POST explicitly marked idempotent (e.g. an update-in-place)", async () => {
    const { fetch: fakeFetch, calls } = makeFakeFetch([
      { status: 500 },
      { status: 200, jsonBody: { ok: true } },
    ]);
    const client = makeClient(fakeFetch);
    const result = await client.request({
      method: "POST",
      path: "/content",
      body: { cardId: "abc" },
      idempotent: true,
      schema: pingSchema,
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });
});

describe("YotoClient status-code mapping", () => {
  it("maps 401 to AUTH_EXPIRED", async () => {
    const { fetch: fakeFetch } = makeFakeFetch([{ status: 401, jsonBody: { message: "expired" } }]);
    const client = makeClient(fakeFetch);
    await expect(client.request({ method: "GET", path: "/content/mine" })).rejects.toMatchObject({
      code: "AUTH_EXPIRED",
    });
  });

  it("maps 403 to FORBIDDEN_SCOPE", async () => {
    const { fetch: fakeFetch } = makeFakeFetch([{ status: 403 }]);
    const client = makeClient(fakeFetch);
    await expect(
      client.request({ method: "GET", path: "/device-v2/x/config" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_SCOPE" });
  });

  it("maps 404 to NOT_FOUND", async () => {
    const { fetch: fakeFetch } = makeFakeFetch([{ status: 404 }]);
    const client = makeClient(fakeFetch);
    await expect(client.request({ method: "GET", path: "/content/nope" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("maps every other 4xx to UPSTREAM_ERROR", async () => {
    const { fetch: fakeFetch } = makeFakeFetch([{ status: 418 }]);
    const client = makeClient(fakeFetch);
    await expect(client.request({ method: "GET", path: "/content/mine" })).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
  });

  it("wraps a zod parse failure as UPSTREAM_ERROR with a hint", async () => {
    const { fetch: fakeFetch } = makeFakeFetch([
      { status: 200, jsonBody: { unexpected: "shape" } },
    ]);
    const client = makeClient(fakeFetch);
    const strictSchema = z.object({ cards: z.array(z.unknown()) });
    try {
      await client.request({ method: "GET", path: "/content/mine", schema: strictSchema });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(isYotoError(error)).toBe(true);
      if (isYotoError(error)) {
        expect(error.code).toBe("UPSTREAM_ERROR");
        expect(error.hint).toBeTruthy();
      }
    }
  });

  it("wraps a network failure (fetch throws) as retryable UPSTREAM_ERROR", async () => {
    const client = makeClient((async () => {
      throw new Error("network down");
    }) as typeof fetch);
    await expect(client.request({ method: "GET", path: "/content/mine" })).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
      retryable: true,
    });
  });
});

describe("YotoClient.paginate", () => {
  it("yields items across multiple pages until nextCursor is absent", async () => {
    const client = makeClient((async () => new Response("{}", { status: 200 })) as typeof fetch);
    const pages: Array<{ items: number[]; nextCursor?: string }> = [
      { items: [1, 2], nextCursor: "p2" },
      { items: [3], nextCursor: undefined },
    ];
    let call = 0;
    const items: number[] = [];
    for await (const item of client.paginate(async () => pages[call++] ?? { items: [] })) {
      items.push(item);
    }
    expect(items).toEqual([1, 2, 3]);
  });
});
