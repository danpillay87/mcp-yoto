/**
 * SSRF / redirect-handling tests for apps/worker/src/resolve.ts -- the only
 * module in the Worker that fetches a URL a *caller* supplied.
 *
 * The interesting cases are the redirect ones. `resolve.ts` used to call
 * `fetch` with the default `redirect: "follow"`, which meant its https-only
 * and private-host checks were enforced on hop 0 and on nothing else: a public
 * https host the caller controls could answer `302 Location: http://...` (or
 * `-> 169.254.169.254`) and the Worker followed it. Every "redirects to" test
 * below fails against that version.
 *
 * `global_fetch_strictly_public` (wrangler.toml) independently refuses the
 * private-IP hops at the platform level, but it says nothing about an
 * https -> http downgrade, and these checks are meant to hold on their own.
 *
 * No network: `globalThis.fetch` is stubbed, and the stub asserts that the
 * caller asked for `redirect: "manual"` -- which is the fix itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_IMAGE_BYTES, resolveAudio, resolveImage } from "../src/resolve.js";

/** "ID3" magic plus filler -- recognised by `sniffAudio`. */
const MP3_BYTES = new Uint8Array([
  0x49,
  0x44,
  0x33,
  0x03,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  ...Array.from("FAKE-AUDIO-PAYLOAD", (c) => c.charCodeAt(0)),
]);
/** The 8-byte PNG magic header plus filler -- recognised by `sniffImage`. */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
]);

interface Hop {
  url: string;
  method: string;
  redirect: RequestRedirect | undefined;
}

let hops: Hop[] = [];

/**
 * Installs a fetch stub driven by a routing table of URL -> response.
 * Anything not in the table is a hard failure, so a test can never silently
 * reach a URL it did not intend to.
 */
function stubFetch(routes: Record<string, () => Response>): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    hops.push({ url, method: init?.method ?? "GET", redirect: init?.redirect });
    const route = routes[url];
    if (!route) throw new Error(`unstubbed fetch: ${url}`);
    return route();
  });
}

function redirectTo(location: string, status = 302): () => Response {
  // `new Response(null, { status: 302 })` is illegal in undici, so build the
  // headers by hand rather than letting Response validate a redirect status.
  return () => new Response(null, { status, headers: { location } }) as Response;
}

function body(bytes: Uint8Array, contentType: string): () => Response {
  return () =>
    new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: { "content-type": contentType, "content-length": String(bytes.byteLength) },
    });
}

beforeEach(() => {
  hops = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("assertPublicHttpsUrl (hop 0)", () => {
  it("rejects a non-https scheme", async () => {
    await expect(resolveAudio({ audioUrl: "http://media.test/a.mp3" })).rejects.toThrow(
      /must be an https:\/\/ URL/,
    );
    expect(hops).toHaveLength(0);
  });

  it("rejects a file:// URL", async () => {
    await expect(resolveImage({ imageUrl: "file:///etc/passwd" })).rejects.toThrow(
      /must be an https:\/\/ URL/,
    );
  });

  it.each([
    "https://localhost/a.mp3",
    "https://127.0.0.1/a.mp3",
    "https://169.254.169.254/latest/meta-data/",
    "https://10.0.0.5/a.mp3",
    "https://192.168.1.1/a.mp3",
    "https://172.16.0.1/a.mp3",
    "https://0.0.0.0/a.mp3",
    "https://100.64.0.1/a.mp3",
    "https://255.255.255.255/a.mp3",
    "https://[::1]/a.mp3",
    "https://[::]/a.mp3",
    "https://[fd00::1]/a.mp3",
    "https://[fc00::1]/a.mp3",
    // fe80::/10 spans fe80-febf; a `startsWith("fe80:")` check missed these two.
    "https://[febf::1]/a.mp3",
    "https://[fe80:1::1]/a.mp3",
    // IPv4-mapped: `URL` normalises these to HEX, so a dotted-quad string match
    // never fired and the metadata endpoint was reachable through them.
    "https://[::ffff:169.254.169.254]/a.mp3",
    "https://[::ffff:127.0.0.1]/a.mp3",
    "https://[::ffff:10.0.0.1]/a.mp3",
    "https://[::ffff:a9fe:a9fe]/a.mp3",
    "https://[0:0:0:0:0:ffff:7f00:1]/a.mp3",
    // NAT64 and 6to4 embeddings of the same addresses.
    "https://[64:ff9b::7f00:1]/a.mp3",
    "https://[2002:7f00:1::]/a.mp3",
    "https://[2002:a9fe:a9fe::]/a.mp3",
  ])("rejects private/loopback/link-local host %s", async (url) => {
    await expect(resolveAudio({ audioUrl: url })).rejects.toThrow(
      /private, loopback, or link-local/,
    );
    // Nothing may reach the network -- these are refused before any fetch.
    expect(hops).toHaveLength(0);
  });

  it.each([
    // WHATWG URL normalises every integer spelling to dotted-decimal, so the
    // plain IPv4 check catches them. This test is what lets `isPrivateIpv4`
    // rely on that instead of re-implementing inet_aton.
    ["https://2852039166/a.mp3", "169.254.169.254"],
    ["https://0x7f000001/a.mp3", "127.0.0.1"],
    ["https://017700000001/a.mp3", "127.0.0.1"],
    ["https://127.1/a.mp3", "127.0.0.1"],
  ])("rejects obfuscated IPv4 spelling %s", async (url, normalised) => {
    expect(new URL(url).hostname).toBe(normalised);
    await expect(resolveAudio({ audioUrl: url })).rejects.toThrow(
      /private, loopback, or link-local/,
    );
    expect(hops).toHaveLength(0);
  });

  it("still allows an ordinary public host", async () => {
    stubFetch({ "https://media.test/a.mp3": body(MP3_BYTES, "audio/mpeg") });
    await expect(resolveAudio({ audioUrl: "https://media.test/a.mp3" })).resolves.toBeTruthy();
  });

  it.each([
    "https://[2001:4860:4860::8888]/a.mp3", // public DNS, must NOT be blocked
    "https://[2606:4700:4700::1111]/a.mp3",
  ])("does not over-block public IPv6 %s", async (url) => {
    stubFetch({ [url]: body(MP3_BYTES, "audio/mpeg") });
    await expect(resolveAudio({ audioUrl: url })).resolves.toBeTruthy();
  });

  it("rejects a path instead of a URL", async () => {
    await expect(resolveAudio({ audioPath: "/tmp/a.mp3" } as never)).rejects.toThrow(
      /needs audioUrl/,
    );
  });
});

describe("redirect handling", () => {
  it("asks the runtime for manual redirects (the fix)", async () => {
    stubFetch({
      "https://media.test/a.mp3": body(MP3_BYTES, "audio/mpeg"),
    });
    await resolveAudio({ audioUrl: "https://media.test/a.mp3" });
    expect(hops.length).toBeGreaterThan(0);
    // If ANY hop reverts to the default "follow", the per-hop checks below are
    // decorative -- the runtime would already have chased the chain for us.
    for (const hop of hops) expect(hop.redirect).toBe("manual");
  });

  it("refuses an https -> http downgrade on redirect", async () => {
    stubFetch({
      "https://media.test/a.mp3": redirectTo("http://media.test/real.mp3"),
    });
    await expect(resolveAudio({ audioUrl: "https://media.test/a.mp3" })).rejects.toThrow(
      /must be an https:\/\/ URL/,
    );
    // It must never have fetched the http:// target.
    expect(hops.map((h) => h.url)).not.toContain("http://media.test/real.mp3");
  });

  it("refuses a redirect to the cloud metadata endpoint", async () => {
    stubFetch({
      "https://media.test/a.mp3": redirectTo("https://169.254.169.254/latest/meta-data/"),
    });
    await expect(resolveAudio({ audioUrl: "https://media.test/a.mp3" })).rejects.toThrow(
      /private, loopback, or link-local/,
    );
    expect(hops.map((h) => h.url)).not.toContain("https://169.254.169.254/latest/meta-data/");
  });

  it.each([
    "https://127.0.0.1/secret",
    "https://localhost/secret",
    "https://10.1.2.3/secret",
    "https://[::1]/secret",
  ])("refuses a redirect to private host %s", async (target) => {
    stubFetch({ "https://media.test/i.png": redirectTo(target) });
    await expect(resolveImage({ imageUrl: "https://media.test/i.png" })).rejects.toThrow(
      /private, loopback, or link-local/,
    );
    expect(hops.map((h) => h.url)).not.toContain(target);
  });

  it("refuses a private target reached via a RELATIVE redirect", async () => {
    // A relative Location resolves against the current hop, so this one stays
    // on a public host -- proving relative hops are resolved, then re-checked.
    stubFetch({
      "https://media.test/a.mp3": redirectTo("/real.mp3"),
      "https://media.test/real.mp3": body(MP3_BYTES, "audio/mpeg"),
    });
    const out = await resolveAudio({ audioUrl: "https://media.test/a.mp3" });
    expect(out.contentType).toBe("audio/mpeg");
  });

  it("follows a legitimate cross-host https redirect (CDN case)", async () => {
    stubFetch({
      "https://media.test/a.mp3": redirectTo("https://cdn.media.test/real.mp3"),
      "https://cdn.media.test/real.mp3": body(MP3_BYTES, "audio/mpeg"),
    });
    const out = await resolveAudio({ audioUrl: "https://media.test/a.mp3" });
    expect(out.contentType).toBe("audio/mpeg");
    expect(hops.map((h) => h.url)).toContain("https://cdn.media.test/real.mp3");
  });

  it("gives up on a redirect loop instead of spinning", async () => {
    stubFetch({
      "https://media.test/a.mp3": redirectTo("https://media.test/b.mp3"),
      "https://media.test/b.mp3": redirectTo("https://media.test/a.mp3"),
    });
    await expect(resolveAudio({ audioUrl: "https://media.test/a.mp3" })).rejects.toThrow(
      /redirected more than/,
    );
    // Bounded: 5 hops for the HEAD precheck + 5 for the GET, plus first calls.
    expect(hops.length).toBeLessThanOrEqual(14);
  });

  it("handles each 3xx status the same way", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      hops = [];
      vi.unstubAllGlobals();
      stubFetch({
        "https://media.test/i.png": redirectTo("http://media.test/i.png", status),
      });
      await expect(resolveImage({ imageUrl: "https://media.test/i.png" })).rejects.toThrow(
        /must be an https:\/\/ URL/,
      );
    }
  });
});

describe("content checks survive the redirect rewrite", () => {
  it("rejects a file whose bytes are not audio, whatever the name says", async () => {
    const text = new TextEncoder().encode("this is definitely not an mp3 file at all");
    stubFetch({ "https://media.test/a.mp3": body(text, "audio/mpeg") });
    await expect(resolveAudio({ audioUrl: "https://media.test/a.mp3" })).rejects.toThrow();
  });

  it("accepts a real PNG and returns its bytes", async () => {
    stubFetch({ "https://media.test/i.png": body(PNG_BYTES, "image/png") });
    const out = await resolveImage({ imageUrl: "https://media.test/i.png" });
    expect(out.bytes.byteLength).toBe(PNG_BYTES.byteLength);
  });

  it("enforces the image cap on the stream even when content-length lies", async () => {
    const huge = new Uint8Array(MAX_IMAGE_BYTES + 1024);
    huge.set(PNG_BYTES, 0);
    stubFetch({
      "https://media.test/i.png": () =>
        // Understates its own size by three orders of magnitude.
        new Response(huge as unknown as BodyInit, {
          status: 200,
          headers: { "content-type": "image/png", "content-length": "10" },
        }),
    });
    await expect(resolveImage({ imageUrl: "https://media.test/i.png" })).rejects.toThrow(
      /exceeded the .* limit/,
    );
  });
});
