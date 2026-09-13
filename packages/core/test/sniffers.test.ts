import { describe, expect, it } from "vitest";
import { isYotoError } from "../src/errors.js";
import { sniffAudio, sniffImage } from "../src/yoto/media.js";

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

describe("sniffAudio", () => {
  it("recognises an MP3 by its ID3 header", () => {
    expect(sniffAudio(bytes(0x49, 0x44, 0x33, 0x03, 0x00)).format).toBe("mp3");
  });

  it("recognises an MP3 by its MPEG frame sync (0xFFFB)", () => {
    expect(sniffAudio(bytes(0xff, 0xfb, 0x90, 0x00)).format).toBe("mp3");
  });

  it("recognises M4A/AAC by its ftyp box", () => {
    const buf = new Uint8Array(12);
    buf.set([0, 0, 0, 0x18], 0);
    buf.set([0x66, 0x74, 0x79, 0x70], 4); // "ftyp"
    expect(sniffAudio(buf).format).toBe("m4a");
  });

  it("recognises WAV by its RIFF/WAVE headers", () => {
    const buf = new Uint8Array(12);
    buf.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
    buf.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
    expect(sniffAudio(buf).format).toBe("wav");
  });

  it("recognises OGG by its OggS header", () => {
    expect(sniffAudio(bytes(0x4f, 0x67, 0x67, 0x53)).format).toBe("ogg");
  });

  it("throws INVALID_AUDIO for a .txt file renamed .mp3 -- pre-network, per the plan's verification checklist", () => {
    const textBytes = new TextEncoder().encode("just plain text, not audio at all");
    try {
      sniffAudio(textBytes, "lullaby.mp3");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(isYotoError(error)).toBe(true);
      if (isYotoError(error)) {
        expect(error.code).toBe("INVALID_AUDIO");
        expect(error.message).toContain("lullaby.mp3");
      }
    }
  });
});

describe("sniffImage", () => {
  it("recognises PNG by its signature", () => {
    expect(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)).format).toBe("png");
  });

  it("recognises JPEG by its SOI marker", () => {
    expect(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0)).format).toBe("jpeg");
  });

  it("recognises SVG by its leading <svg tag", () => {
    const svgBytes = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>");
    expect(sniffImage(svgBytes).format).toBe("svg");
  });

  it("recognises SVG with a leading XML prolog", () => {
    const svgBytes = new TextEncoder().encode('<?xml version="1.0"?><svg></svg>');
    expect(sniffImage(svgBytes).format).toBe("svg");
  });

  it("throws INVALID_IMAGE for an unrecognised format", () => {
    try {
      sniffImage(new TextEncoder().encode("not an image"), "icon.png");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(isYotoError(error)).toBe(true);
      if (isYotoError(error)) expect(error.code).toBe("INVALID_IMAGE");
    }
  });
});
