/**
 * Turns a parent-supplied `https://` URL into streamable audio bytes or
 * buffered image bytes -- apps/worker's half of packages/core's
 * `resolveAudio`/`resolveImage` contract (`AudioInput`/`ImageInput` resolve to
 * a file path in `apps/cli`; here they resolve to a URL, because a remote
 * connector has no filesystem to read from).
 *
 * Every outbound fetch from this Worker already goes through the
 * `global_fetch_strictly_public` compatibility flag (wrangler.toml), which
 * refuses connections to non-public IP ranges at the platform level. The
 * checks below are defence in depth on top of that platform guarantee: they
 * run before any network call so a blocked URL fails with a clear,
 * actionable `YotoError` instead of a generic fetch failure, and they keep
 * this module correct even if that flag is ever changed.
 *
 * Redirects are followed BY HAND (`fetchFollowingSafeRedirects`), with the
 * scheme and host re-validated on every hop and the chain capped. The default
 * `redirect: "follow"` would enforce those checks on hop 0 only, which is a
 * real hole the platform flag does not close: it bounds which IPs can be
 * reached, not whether the connection is still https. See that function.
 *
 * Audio is capped at 200 MB and streamed straight through to Yoto's upload
 * endpoint without ever buffering the whole file: the response body is
 * `tee()`'d into a small head-bytes read (sniffing the real format from the
 * first few KB, independent of whatever the URL's path claims) and the full
 * stream handed on to `uploadAudio()`. Images are capped at 5 MB and buffered
 * fully -- icons are small, and Yoto's upload endpoint wants the whole body
 * as one shot.
 */

import type { AudioInput, AudioSource, ImageInput, ImageSource } from "@mcp-yoto/core";
import { sniffAudio, sniffImage, YotoError } from "@mcp-yoto/core";

/** Per the plan's resolve.ts spec: audio 200 MB, images 5 MB. */
export const MAX_AUDIO_BYTES = 200 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** How many leading bytes to read before trusting a file's format. */
const SNIFF_BYTES = 4096;
/** Per the plan: 30s connect timeout on the remote fetch. */
const FETCH_TIMEOUT_MS = 30_000;
/**
 * Redirect hops we will follow before giving up. Every hop is re-validated by
 * `assertPublicHttpsUrl`, so this only bounds the work, not the safety.
 */
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function megabytes(bytes: number): string {
  return `${Math.ceil(bytes / (1024 * 1024))} MB`;
}

/**
 * IPv4 ranges that are never a legitimate remote-media host.
 *
 * Decimal, octal and hex-integer spellings (`2852039166`, `0x7f000001`,
 * `017700000001`, `127.1`) need no special handling here: WHATWG `URL`
 * normalises every one of them to dotted-decimal in `url.hostname` before this
 * function ever sees it. A test asserts that.
 */
function isPrivateIpv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const octets = match.slice(1, 5).map(Number);
  if (octets.some((value) => Number.isNaN(value) || value > 255)) return false;
  return isPrivateIpv4Octets(octets as [number, number, number, number]);
}

function isPrivateIpv4Octets(octets: [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 0) return true; // "this" network, incl. 0.0.0.0
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254 cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 carrier-grade NAT
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved, incl. 255.255.255.255
  return false;
}

/**
 * Expands an IPv6 literal into its eight 16-bit hextets, or `undefined` if it
 * is not one. Handles `::` compression and a trailing dotted-quad.
 */
function parseIpv6(value: string): number[] | undefined {
  let text = value;
  const hextets: number[] = [];

  // A trailing dotted-quad (`::ffff:127.0.0.1`) contributes two hextets.
  const dotted = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  let tail: number[] = [];
  if (dotted?.[1]) {
    const octets = dotted[1].split(".").map(Number);
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined;
    tail = [
      ((octets[0] as number) << 8) | (octets[1] as number),
      ((octets[2] as number) << 8) | (octets[3] as number),
    ];
    text = `${text.slice(0, text.length - dotted[1].length - 1)}:`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const toHextets = (part: string): number[] | undefined => {
    if (part === "") return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (group === "" || !/^[0-9a-f]{1,4}$/.test(group)) return undefined;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };

  const head = toHextets(halves[0]?.replace(/:$/, "") ?? "");
  if (!head) return undefined;
  if (halves.length === 1) {
    hextets.push(...head, ...tail);
    return hextets.length === 8 ? hextets : undefined;
  }
  const rest = toHextets(halves[1]?.replace(/^:/, "").replace(/:$/, "") ?? "");
  if (!rest) return undefined;
  const known = head.length + rest.length + tail.length;
  if (known > 8) return undefined;
  hextets.push(...head, ...new Array(8 - known).fill(0), ...rest, ...tail);
  return hextets.length === 8 ? hextets : undefined;
}

/**
 * IPv6 loopback / link-local / unique-local ranges, plus every encoding that
 * smuggles an IPv4 address inside an IPv6 literal.
 *
 * The previous version string-matched `::ffff:1.2.3.4`, which could never fire:
 * WHATWG `URL` normalises an IPv4-mapped literal to HEX (`[::ffff:169.254.169.254]`
 * becomes `[::ffff:a9fe:a9fe]`), so the dotted branch was dead code and the
 * cloud metadata endpoint was reachable through it. It also missed `fe80::/10`
 * beyond the literal `fe80:` prefix, and the NAT64/6to4 embeddings. Parsing
 * the address properly is the only way to get this right.
 */
function isPrivateIpv6(host: string): boolean {
  const value = host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  const h = parseIpv6(value);
  if (!h) return false;

  const allZero = h.every((part) => part === 0);
  if (allZero) return true; // ::
  if (h.slice(0, 7).every((part) => part === 0) && h[7] === 1) return true; // ::1

  const embeddedV4 = (hi: number, lo: number): [number, number, number, number] => [
    (hi >> 8) & 0xff,
    hi & 0xff,
    (lo >> 8) & 0xff,
    lo & 0xff,
  ];

  // ::ffff:0:0/96 IPv4-mapped, and ::/96 IPv4-compatible (deprecated). Both put
  // the IPv4 address in the last two hextets.
  if (h.slice(0, 5).every((part) => part === 0) && (h[5] === 0xffff || h[5] === 0)) {
    return isPrivateIpv4Octets(embeddedV4(h[6] as number, h[7] as number));
  }
  // 64:ff9b::/96 and 64:ff9b:1::/48 NAT64 well-known prefixes.
  if (h[0] === 0x64 && h[1] === 0xff9b) {
    return isPrivateIpv4Octets(embeddedV4(h[6] as number, h[7] as number));
  }
  // 2002::/16 6to4 carries the IPv4 address in the next two hextets.
  if (h[0] === 0x2002) {
    return isPrivateIpv4Octets(embeddedV4(h[1] as number, h[2] as number));
  }

  const first = h[0] as number;
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  return isPrivateIpv4(host) || isPrivateIpv6(host);
}

/**
 * https-only, and blocks obviously private/loopback/link-local/metadata hosts
 * before any network call. This cannot catch DNS rebinding (a hostname's
 * resolved address isn't visible from here) -- that is exactly what the
 * Worker's `global_fetch_strictly_public` compatibility flag guards against.
 */
function assertPublicHttpsUrl(raw: string, field: "audioUrl" | "imageUrl"): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new YotoError(`"${raw}" is not a valid URL.`, { code: "VALIDATION" });
  }
  if (url.protocol !== "https:") {
    throw new YotoError(`${field} must be an https:// URL.`, { code: "VALIDATION" });
  }
  if (isBlockedHost(url.hostname)) {
    throw new YotoError(`${field} may not point at a private, loopback, or link-local address.`, {
      code: "VALIDATION",
    });
  }
  return url;
}

function filenameFromUrl(url: URL): string | undefined {
  const last = url.pathname.split("/").pop();
  if (!last) return undefined;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // `redirect: "manual"` is load-bearing, not a style choice -- see
    // `fetchFollowingSafeRedirects`.
    return await fetch(url, { ...init, signal: controller.signal, redirect: "manual" });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches `startUrl`, following redirects OURSELVES so that every hop is
 * re-checked by `assertPublicHttpsUrl`.
 *
 * Why this is not `redirect: "follow"` (the default, and what this module used
 * to do): the scheme and host checks ran once, against the URL the parent
 * supplied, and the runtime then followed wherever that URL pointed. A public
 * `https://` host the caller controls could answer `302 Location: http://...`
 * and the Worker would follow it, sending the request in cleartext -- the
 * https-only rule was enforced on hop 0 only. `global_fetch_strictly_public`
 * does bound the damage (it refuses non-public IPs on every connection,
 * redirects included) but it says nothing about scheme downgrade, and this
 * module is supposed to stay correct even if that flag is ever changed.
 *
 * 3xx bodies are drained rather than leaked, and the hop count is capped.
 */
async function fetchFollowingSafeRedirects(
  startUrl: URL,
  init: RequestInit,
  field: "audioUrl" | "imageUrl",
): Promise<Response> {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetchWithTimeout(url.toString(), init);
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => {});
    // A 3xx with no Location is not a redirect we can follow; hand it back and
    // let the caller's own `response.ok` check reject it.
    if (!location) return response;

    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw new YotoError(`${field} redirected somewhere we could not read.`, {
        code: "VALIDATION",
      });
    }
    // The whole point: scheme + host are re-validated on EVERY hop.
    url = assertPublicHttpsUrl(next.toString(), field);
  }
  throw new YotoError(`${field} redirected more than ${MAX_REDIRECTS} times.`, {
    code: "VALIDATION",
    hint: "Use a direct link to the file.",
  });
}

function declaredContentLength(response: Response): number | undefined {
  const raw = response.headers.get("content-length");
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Best-effort pre-check: HEAD first (some hosts refuse it, so a failure here
 * is never fatal -- the real cap is enforced on the GET response, and again
 * while streaming, regardless of what this returns).
 */
async function precheckSize(url: URL, field: "audioUrl" | "imageUrl"): Promise<number | undefined> {
  try {
    const head = await fetchFollowingSafeRedirects(url, { method: "HEAD" }, field);
    return head.ok ? declaredContentLength(head) : undefined;
  } catch {
    // Includes a redirect this URL is not allowed to make. Swallowing that is
    // safe: the GET below walks the same chain and rejects it for real.
    return undefined;
  }
}

/** Reads at least `limit` bytes from the front of `stream` (or all of it, if shorter). */
async function readHeadBytes(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    // Done with this branch -- release it so tee()'s buffering for it stops.
    await reader.cancel().catch(() => {});
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged as Uint8Array<ArrayBuffer>;
}

/**
 * Wraps a stream with a running byte-count guard: defence in depth against a
 * server that lies about (or omits) `Content-Length`. Never buffers more than
 * one chunk at a time.
 */
function capStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onExceeded: () => Error,
): ReadableStream<Uint8Array> {
  let total = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > maxBytes) {
          controller.error(onExceeded());
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

/**
 * Remote-mode `resolveAudio`: fetches `audioUrl`, sniffs its real format from
 * the first ~4KB via a `tee()`'d branch, and hands the *other* branch on as a
 * live stream -- so a `.txt` renamed `.mp3` fails as `INVALID_AUDIO` before
 * any Yoto call, and a real file is never buffered in full.
 */
export async function resolveAudio(input: AudioInput): Promise<AudioSource> {
  if (!("audioUrl" in input)) {
    throw new YotoError("This connector runs remotely and needs audioUrl, not a file path.", {
      code: "VALIDATION",
    });
  }
  const url = assertPublicHttpsUrl(input.audioUrl, "audioUrl");
  const filename = filenameFromUrl(url);

  const precheckLength = await precheckSize(url, "audioUrl");
  if (precheckLength !== undefined && precheckLength > MAX_AUDIO_BYTES) {
    throw new YotoError(
      `That audio file is ${megabytes(precheckLength)}, over the ${megabytes(MAX_AUDIO_BYTES)} limit.`,
      {
        code: "INVALID_AUDIO",
        hint: "Upload a smaller file.",
      },
    );
  }

  let response: Response;
  try {
    response = await fetchFollowingSafeRedirects(url, { method: "GET" }, "audioUrl");
  } catch (cause) {
    // A rejected redirect hop is a deliberate, specific refusal -- don't bury
    // it under the generic "could not download" message.
    if (cause instanceof YotoError) throw cause;
    throw new YotoError(`Could not download audio from ${url.hostname}.`, {
      code: "INVALID_AUDIO",
      cause,
      hint: "Check the URL is reachable and try again.",
    });
  }
  if (!response.ok || !response.body) {
    throw new YotoError(
      `Could not download audio from ${url.hostname} (HTTP ${response.status}).`,
      {
        code: "INVALID_AUDIO",
        status: response.status,
      },
    );
  }

  const size = precheckLength ?? declaredContentLength(response);
  if (size !== undefined && size > MAX_AUDIO_BYTES) {
    await response.body.cancel().catch(() => {});
    throw new YotoError(
      `That audio file is ${megabytes(size)}, over the ${megabytes(MAX_AUDIO_BYTES)} limit.`,
      {
        code: "INVALID_AUDIO",
        hint: "Upload a smaller file.",
      },
    );
  }

  const capped = capStream(
    response.body,
    MAX_AUDIO_BYTES,
    () =>
      new YotoError(`Audio download exceeded the ${megabytes(MAX_AUDIO_BYTES)} limit.`, {
        code: "INVALID_AUDIO",
      }),
  );
  const [sniffBranch, uploadBranch] = capped.tee();

  const head = await readHeadBytes(sniffBranch, SNIFF_BYTES);
  sniffAudio(head, filename); // Throws INVALID_AUDIO before any Yoto call.

  return {
    stream: uploadBranch,
    size: size ?? 0,
    contentType: response.headers.get("content-type") ?? "application/octet-stream",
    filename,
  };
}

/**
 * Remote-mode `resolveImage`: fetches `imageUrl`, buffers it fully (icons are
 * small), and sniffs its real format before returning.
 */
export async function resolveImage(input: ImageInput): Promise<ImageSource> {
  if (!("imageUrl" in input)) {
    throw new YotoError("This connector runs remotely and needs imageUrl, not a file path.", {
      code: "VALIDATION",
    });
  }
  const url = assertPublicHttpsUrl(input.imageUrl, "imageUrl");
  const filename = filenameFromUrl(url);

  const precheckLength = await precheckSize(url, "imageUrl");
  if (precheckLength !== undefined && precheckLength > MAX_IMAGE_BYTES) {
    throw new YotoError(
      `That image is ${megabytes(precheckLength)}, over the ${megabytes(MAX_IMAGE_BYTES)} limit.`,
      {
        code: "INVALID_IMAGE",
        hint: "Upload a smaller image.",
      },
    );
  }

  let response: Response;
  try {
    response = await fetchFollowingSafeRedirects(url, { method: "GET" }, "imageUrl");
  } catch (cause) {
    // A rejected redirect hop is a deliberate, specific refusal -- don't bury
    // it under the generic "could not download" message.
    if (cause instanceof YotoError) throw cause;
    throw new YotoError(`Could not download that image from ${url.hostname}.`, {
      code: "INVALID_IMAGE",
      cause,
      hint: "Check the URL is reachable and try again.",
    });
  }
  if (!response.ok || !response.body) {
    throw new YotoError(
      `Could not download that image from ${url.hostname} (HTTP ${response.status}).`,
      {
        code: "INVALID_IMAGE",
        status: response.status,
      },
    );
  }

  const size = precheckLength ?? declaredContentLength(response);
  if (size !== undefined && size > MAX_IMAGE_BYTES) {
    await response.body.cancel().catch(() => {});
    throw new YotoError(
      `That image is ${megabytes(size)}, over the ${megabytes(MAX_IMAGE_BYTES)} limit.`,
      {
        code: "INVALID_IMAGE",
        hint: "Upload a smaller image.",
      },
    );
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new YotoError(`That image exceeded the ${megabytes(MAX_IMAGE_BYTES)} limit.`, {
        code: "INVALID_IMAGE",
      });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  sniffImage(bytes as Uint8Array<ArrayBuffer>, filename); // Throws INVALID_IMAGE before any Yoto call.

  return {
    bytes: bytes as Uint8Array<ArrayBuffer>,
    contentType: response.headers.get("content-type") ?? "application/octet-stream",
    filename,
  };
}
