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

function megabytes(bytes: number): string {
  return `${Math.ceil(bytes / (1024 * 1024))} MB`;
}

/** IPv4 ranges that are never a legitimate remote-media host. */
function isPrivateIpv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const octets = match.slice(1, 5).map(Number);
  if (octets.some((value) => Number.isNaN(value) || value > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 0) return true; // "this" network
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254 cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 carrier-grade NAT
  return false;
}

/** IPv6 loopback/link-local/unique-local ranges, plus IPv4-mapped addresses. */
function isPrivateIpv6(host: string): boolean {
  const value = host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (value === "::1" || value === "::") return true;
  if (value.startsWith("fe80:")) return true; // link-local
  if (value.startsWith("fc") || value.startsWith("fd")) return true; // unique local, fc00::/7
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(value);
  if (mapped?.[1]) return isPrivateIpv4(mapped[1]);
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
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
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
async function precheckSize(url: URL): Promise<number | undefined> {
  try {
    const head = await fetchWithTimeout(url.toString(), { method: "HEAD" });
    return head.ok ? declaredContentLength(head) : undefined;
  } catch {
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

  const precheckLength = await precheckSize(url);
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
    response = await fetchWithTimeout(url.toString(), { method: "GET" });
  } catch (cause) {
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

  const precheckLength = await precheckSize(url);
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
    response = await fetchWithTimeout(url.toString(), { method: "GET" });
  } catch (cause) {
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
