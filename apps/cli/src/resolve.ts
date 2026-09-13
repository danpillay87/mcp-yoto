/**
 * Turns a `yoto_upload_audio`/`yoto_upload_icon`-style CLI input
 * (`audioFilePath` / `imagePath`) into the streamable bytes packages/core's
 * tools expect (`AudioSource` / `ImageSource`), per `CreateToolsDeps`'s
 * `resolveAudio`/`resolveImage` in `@mcp-yoto/core`. The remote connector
 * has its own version of this file that fetches an `https://` URL instead
 * -- this one only ever touches the local filesystem, and never makes a
 * network call, so it can (and must) reject an unsupported file before any
 * upload attempt.
 */
import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve as resolvePath } from "node:path";
import { Readable } from "node:stream";
import {
  type AudioInput,
  type AudioSource,
  type ImageInput,
  type ImageSource,
  sniffAudio,
  sniffImage,
  YotoError,
} from "@mcp-yoto/core";

const MAX_AUDIO_BYTES = 500 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const SNIFF_BYTES = 4096;

/** Expands a leading `~` to the user's home directory. Exported for tests. */
export function expandHome(rawPath: string): string {
  if (rawPath === "~") return homedir();
  if (rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
    return resolvePath(homedir(), rawPath.slice(2));
  }
  return rawPath;
}

/** `~` expansion, then absolute-as-is (including UNC `\\server\share\...`), else resolved against the cwd. Exported for tests. */
export function toAbsolutePath(rawPath: string): string {
  const expanded = expandHome(rawPath);
  if (expanded.startsWith("\\\\") || isAbsolute(expanded)) return expanded;
  return resolvePath(process.cwd(), expanded);
}

async function readHead(path: string, length: number): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function statOrValidationError(path: string, label: string): Promise<{ size: number }> {
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(path);
  } catch (error) {
    throw new YotoError(`Could not find the ${label} at "${path}".`, {
      code: "VALIDATION",
      cause: error,
      hint: "Check the path and try again.",
    });
  }
  if (!stats.isFile()) {
    throw new YotoError(`"${path}" is not a file.`, { code: "VALIDATION" });
  }
  return { size: stats.size };
}

function audioContentType(format: string): string {
  switch (format) {
    case "mp3":
      return "audio/mpeg";
    case "m4a":
      return "audio/mp4";
    case "wav":
      return "audio/wav";
    case "ogg":
      return "audio/ogg";
    default:
      return "application/octet-stream";
  }
}

function imageContentType(format: string): string {
  switch (format) {
    case "png":
      return "image/png";
    case "jpeg":
      return "image/jpeg";
    case "svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

/**
 * Resolves a `yoto_upload_audio`/`yoto_add_track` input to a streamed local
 * file. Sniffs the real format from the file's first bytes -- not the
 * extension -- and throws `INVALID_AUDIO` before opening a stream or
 * touching the network, so a `.txt` renamed to `.mp3` fails fast.
 */
export async function resolveAudio(input: AudioInput): Promise<AudioSource> {
  if ("audioUrl" in input) {
    throw new YotoError("This CLI reads local files -- pass audioFilePath, not audioUrl.", {
      code: "VALIDATION",
      hint: "audioUrl is for the remote (paste-a-link) connector only.",
    });
  }
  const path = toAbsolutePath(input.audioFilePath);
  const { size } = await statOrValidationError(path, "audio file");
  if (size > MAX_AUDIO_BYTES) {
    throw new YotoError(
      `"${path}" is ${(size / (1024 * 1024)).toFixed(1)} MB, over the 500 MB limit.`,
      {
        code: "VALIDATION",
      },
    );
  }

  const head = await readHead(path, SNIFF_BYTES);
  const sniffed = sniffAudio(head as Uint8Array<ArrayBuffer>, basename(path));

  const stream = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>;
  return {
    stream,
    size,
    contentType: audioContentType(sniffed.format),
    filename: basename(path),
  };
}

/**
 * Resolves a `yoto_upload_icon` input to fully-buffered local bytes (icons
 * are small -- no need to stream). Same sniff-before-anything-else
 * discipline as `resolveAudio`.
 */
export async function resolveImage(input: ImageInput): Promise<ImageSource> {
  if ("imageUrl" in input) {
    throw new YotoError("This CLI reads local files -- pass imagePath, not imageUrl.", {
      code: "VALIDATION",
      hint: "imageUrl is for the remote (paste-a-link) connector only.",
    });
  }
  const path = toAbsolutePath(input.imagePath);
  const { size } = await statOrValidationError(path, "image file");
  if (size > MAX_IMAGE_BYTES) {
    throw new YotoError(`"${path}" is over the 5 MB icon limit.`, { code: "VALIDATION" });
  }

  const buffer = await readFile(path);
  const bytes = new Uint8Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  ) as Uint8Array<ArrayBuffer>;
  const sniffed = sniffImage(bytes, basename(path));

  return { bytes, contentType: imageContentType(sniffed.format), filename: basename(path) };
}
