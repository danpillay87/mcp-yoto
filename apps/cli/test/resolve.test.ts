import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandHome, resolveAudio, resolveImage, toAbsolutePath } from "../src/resolve.js";

describe("path resolution", () => {
  it("expands a leading ~ to the home directory", () => {
    expect(expandHome("~")).toBe(homedir());
    expect(expandHome("~/audio/file.mp3")).toBe(resolvePath(homedir(), "audio/file.mp3"));
  });

  it("leaves an absolute path unchanged", () => {
    const absolute = resolvePath(homedir(), "somewhere", "file.mp3");
    expect(toAbsolutePath(absolute)).toBe(absolute);
  });

  it("resolves a relative path against the current working directory", () => {
    expect(toAbsolutePath("track.mp3")).toBe(resolvePath(process.cwd(), "track.mp3"));
  });

  it("leaves a UNC path unchanged", () => {
    const unc = "\\\\server\\share\\file.mp3";
    expect(toAbsolutePath(unc)).toBe(unc);
  });
});

describe("resolveAudio", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-yoto-resolve-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects a .txt file renamed to .mp3 as INVALID_AUDIO before any network call", async () => {
    const path = join(dir, "not-really-audio.mp3");
    await writeFile(path, "just some plain text, definitely not an mp3", "utf-8");

    await expect(resolveAudio({ audioFilePath: path })).rejects.toMatchObject({
      code: "INVALID_AUDIO",
    });
  });

  it("rejects a missing file as VALIDATION", async () => {
    const path = join(dir, "does-not-exist.mp3");
    await expect(resolveAudio({ audioFilePath: path })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("accepts a real MP3 (ID3-tagged) and reports the sniffed content type", async () => {
    const path = join(dir, "real.mp3");
    // Minimal ID3v2 header is enough for sniffAudio to recognise it as mp3.
    const id3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(100, 0)]);
    await writeFile(path, id3);

    const source = await resolveAudio({ audioFilePath: path });
    expect(source.contentType).toBe("audio/mpeg");
    expect(source.size).toBe(id3.byteLength);
    await source.stream.cancel();
  });

  it("rejects audioUrl input -- this CLI only reads local files", async () => {
    await expect(
      resolveAudio({ audioUrl: "https://example.test/track.mp3" }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });
});

describe("resolveImage", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-yoto-resolve-img-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects an unrecognised image format as INVALID_IMAGE", async () => {
    const path = join(dir, "not-an-image.png");
    await writeFile(path, "not a real png", "utf-8");
    await expect(resolveImage({ imagePath: path })).rejects.toMatchObject({
      code: "INVALID_IMAGE",
    });
  });

  it("accepts a real PNG and reports image/png", async () => {
    const path = join(dir, "real.png");
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0]);
    await writeFile(path, pngSignature);

    const source = await resolveImage({ imagePath: path });
    expect(source.contentType).toBe("image/png");
  });

  it("rejects imageUrl input -- this CLI only reads local files", async () => {
    await expect(resolveImage({ imageUrl: "https://example.test/icon.png" })).rejects.toMatchObject(
      {
        code: "VALIDATION",
      },
    );
  });
});
