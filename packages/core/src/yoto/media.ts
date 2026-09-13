import { YotoError } from "../errors.js";
import type { YotoClient } from "./client.js";
import { getTranscodedStatus, getUploadUrl } from "./endpoints.js";

/**
 * What an entrypoint hands packages/core once it has resolved a
 * `yoto_upload_audio`/`yoto_add_track` input (`audioFilePath` on the CLI,
 * `audioUrl` remotely) into actual bytes. packages/core never touches a
 * filesystem or does its own outbound fetch of a user-supplied URL -- that
 * stays in apps/cli and apps/worker (see tools/_helpers.ts's
 * `resolveAudio`), keeping this file fetch + WebCrypto only.
 */
export interface AudioSource {
  stream: ReadableStream<Uint8Array>;
  size: number;
  contentType: string;
  filename?: string;
}

export interface UploadAudioOptions {
  /** How often to poll the transcode-status endpoint. Default 750ms. */
  pollIntervalMs?: number;
  /** Give up and throw TRANSCODE_TIMEOUT after this long. Default 60_000ms. */
  timeoutMs?: number;
  loudnorm?: boolean;
  /** Injected clock, for deterministic timeout tests. Defaults to Date.now. */
  now?: () => number;
  /** Injected sleep, for deterministic poll tests. Defaults to a real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export interface UploadAudioResult {
  /** A `yoto:#<sha256>` reference usable as a track's `trackUrl`. */
  mediaRef: string;
  transcodedInfo: {
    duration?: number;
    fileSize?: number;
    channels?: string;
    format?: string;
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `GET uploadUrl` -> `PUT` the bytes -> poll `GET .../transcoded` until
 * `transcodedSha256` shows up. Mirrors the old `yoto-mcp-server`'s
 * `uploadAndTranscodeAudio`, generalised to stream from either a local file
 * (CLI) or a fetched remote URL (Worker) via the injected `AudioSource`.
 */
export async function uploadAudio(
  client: YotoClient,
  source: AudioSource,
  options: UploadAudioOptions = {},
): Promise<UploadAudioResult> {
  const pollIntervalMs = options.pollIntervalMs ?? 750;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const loudnorm = options.loudnorm ?? false;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;

  const { upload } = await getUploadUrl(client, { filename: source.filename });

  if (upload.uploadUrl) {
    const putHeaders: Record<string, string> = { "Content-Type": source.contentType };
    const putResponse = await client.fetchImpl(upload.uploadUrl, {
      method: "PUT",
      // `duplex: "half"` is required by fetch implementations (undici, the
      // Workers runtime) to stream a body, but isn't in lib.dom's RequestInit
      // type yet.
      // biome-ignore lint/suspicious/noExplicitAny: streaming-body fetch option missing from lib.dom types.
      ...({ duplex: "half" } as any),
      body: source.stream,
      headers: putHeaders,
    });
    if (!putResponse.ok) {
      throw new YotoError(`Uploading audio to Yoto's storage failed (HTTP ${putResponse.status})`, {
        code: "UPSTREAM_ERROR",
        retryable: true,
        status: putResponse.status,
      });
    }
  }
  // `uploadUrl: null` means Yoto already has a file matching this content's
  // SHA256 (dedup) -- nothing to PUT, go straight to polling transcode status.

  const deadline = now() + timeoutMs;
  for (;;) {
    const status = await getTranscodedStatus(client, upload.uploadId, loudnorm);
    const sha = status.transcode.transcodedSha256;
    if (sha) {
      return { mediaRef: `yoto:#${sha}`, transcodedInfo: status.transcode.transcodedInfo ?? {} };
    }
    if (now() >= deadline) {
      throw new YotoError("Yoto didn't finish transcoding the audio in time", {
        code: "TRANSCODE_TIMEOUT",
        retryable: true,
        hint: "Try again, or upload a shorter/smaller file.",
      });
    }
    await sleep(pollIntervalMs);
  }
}

export interface SniffResult {
  valid: true;
  format: string;
}

function bytesStartWith(
  bytes: Uint8Array<ArrayBuffer>,
  offset: number,
  pattern: number[],
): boolean {
  if (bytes.length < offset + pattern.length) return false;
  for (let i = 0; i < pattern.length; i++) {
    if (bytes[offset + i] !== pattern[i]) return false;
  }
  return true;
}

const ASCII = (text: string): number[] => Array.from(text, (c) => c.charCodeAt(0));

/**
 * Sniffs an audio file's real format from its first bytes, independent of
 * whatever extension the filename claims -- so a `.txt` renamed to `.mp3`
 * fails fast as INVALID_AUDIO before any network call, per the plan's
 * verification checklist.
 */
export function sniffAudio(bytes: Uint8Array<ArrayBuffer>, filename?: string): SniffResult {
  if (bytesStartWith(bytes, 0, ASCII("ID3"))) return { valid: true, format: "mp3" };
  if (bytes.length >= 2 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)
    return { valid: true, format: "mp3" };
  if (bytesStartWith(bytes, 4, ASCII("ftyp"))) return { valid: true, format: "m4a" };
  if (bytesStartWith(bytes, 0, ASCII("RIFF")) && bytesStartWith(bytes, 8, ASCII("WAVE"))) {
    return { valid: true, format: "wav" };
  }
  if (bytesStartWith(bytes, 0, ASCII("OggS"))) return { valid: true, format: "ogg" };
  throw new YotoError(
    `Could not recognise${filename ? ` "${filename}"` : " this file"} as a supported audio format`,
    { code: "INVALID_AUDIO", hint: "Supported formats: MP3, M4A/AAC, WAV, OGG." },
  );
}

/** Sniffs an image's real format from its first bytes for icon uploads. */
export function sniffImage(bytes: Uint8Array<ArrayBuffer>, filename?: string): SniffResult {
  if (bytesStartWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { valid: true, format: "png" };
  }
  if (bytesStartWith(bytes, 0, [0xff, 0xd8, 0xff])) return { valid: true, format: "jpeg" };
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.slice(0, 256))
    .trimStart()
    .toLowerCase();
  if (head.startsWith("<?xml") || head.startsWith("<svg")) return { valid: true, format: "svg" };
  throw new YotoError(
    `Could not recognise${filename ? ` "${filename}"` : " this file"} as a supported image format`,
    { code: "INVALID_IMAGE", hint: "Supported formats: PNG, JPEG, SVG." },
  );
}
