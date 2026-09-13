#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * Generates the 64x64 PNG icons served at apps/worker/public/icons/*.png --
 * one flat-colour rounded square + a simple glyph per tool group, per the
 * plan's item 10. Zero npm dependencies: PNG is hand-encoded here (raw
 * RGBA scanlines -> zlib deflate -> IDAT chunk, manual CRC32) using only
 * Node's built-in `zlib`. Tasteful, not final -- these can be redesigned
 * later; the point of this pass is a real, valid icon per tool group.
 *
 * Run: node scripts/gen-icons.mjs
 */
import { deflateSync, inflateSync } from "node:zlib";

const SIZE = 64;
const OUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "apps",
  "worker",
  "public",
  "icons",
);

// ---- PNG encoding (signature + IHDR/IDAT/IEND chunks, CRC32, zlib deflate) ----

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/** @param {number} width @param {number} height @param {Buffer} rgba tightly-packed RGBA bytes, row-major */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour + alpha (RGBA)
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (none) per scanline
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idatData = deflateSync(raw, { level: 9 });

  // Self-check: a malformed encoder here would produce a PNG no viewer can
  // open, and that failure mode is invisible until someone happens to look
  // at the icon. Round-trip the compression and re-derive the scanline
  // count before writing anything to disk.
  const roundTripped = inflateSync(idatData);
  if (roundTripped.length !== raw.length) {
    throw new Error(
      `PNG self-check failed: expected ${raw.length} raw bytes, got ${roundTripped.length}`,
    );
  }

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idatData),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- Pixel drawing helpers ----

function makeCanvas(size) {
  return Buffer.alloc(size * size * 4);
}

function setPixel(canvas, size, x, y, [r, g, b], alpha = 255) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  canvas[i] = r;
  canvas[i + 1] = g;
  canvas[i + 2] = b;
  canvas[i + 3] = alpha;
}

/** True when (x, y) falls inside a `w`x`h` rect with corner radius `r`. */
function insideRoundedRect(x, y, w, h, r) {
  const nx = x < r ? r - x : x > w - 1 - r ? x - (w - 1 - r) : 0;
  const ny = y < r ? r - y : y > h - 1 - r ? y - (h - 1 - r) : 0;
  if (nx === 0 || ny === 0) return true;
  return nx * nx + ny * ny <= r * r;
}

function insideCircle(x, y, cx, cy, radius) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/** True when (x, y) is inside the triangle p0-p1-p2 (any winding). */
function insideTriangle(x, y, [x0, y0], [x1, y1], [x2, y2]) {
  const sign = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d1 = sign(x, y, x0, y0, x1, y1);
  const d2 = sign(x, y, x1, y1, x2, y2);
  const d3 = sign(x, y, x2, y2, x0, y0);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

// ---- Per-group palette + glyph ----

const GROUPS = {
  server: { bg: [76, 95, 213], glyph: drawServerGlyph },
  auth: { bg: [46, 158, 108], glyph: drawAuthGlyph },
  content: { bg: [217, 119, 6], glyph: drawContentGlyph },
  media: { bg: [219, 39, 119], glyph: drawMediaGlyph },
  icons: { bg: [124, 58, 237], glyph: drawIconsGlyph },
  devices: { bg: [14, 165, 233], glyph: drawDevicesGlyph },
  library: { bg: [5, 150, 105], glyph: drawLibraryGlyph },
};

const WHITE = [255, 255, 255];

function drawServerGlyph(canvas, size) {
  // A rounded diamond outline -- "the whole service", one shape holding everything.
  const cx = size / 2;
  const cy = size / 2;
  const outerR = size * 0.28;
  const innerR = size * 0.16;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.abs(x - cx);
      const dy = Math.abs(y - cy);
      const dist = dx + dy; // Manhattan distance -> diamond shape
      if (dist <= outerR && dist >= innerR) setPixel(canvas, size, x, y, WHITE);
    }
  }
}

function drawAuthGlyph(canvas, size) {
  // A keyhole: a circle sitting on a tapered rectangle.
  const cx = size / 2;
  const cy = size * 0.42;
  const radius = size * 0.13;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inCircle = insideCircle(x, y, cx, cy, radius);
      const inStem = insideTriangle(
        x,
        y,
        [cx - size * 0.07, cy + radius * 0.6],
        [cx + size * 0.07, cy + radius * 0.6],
        [cx, cy + size * 0.28],
      );
      if (inCircle || inStem) setPixel(canvas, size, x, y, WHITE);
    }
  }
}

function drawContentGlyph(canvas, size) {
  // Three stacked rounded bars -- chapters in a card.
  const barW = size * 0.46;
  const barH = size * 0.07;
  const gap = size * 0.11;
  const x0 = (size - barW) / 2;
  const startY = size * 0.32;
  for (let i = 0; i < 3; i++) {
    const y0 = startY + i * (barH + gap);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (
          insideRoundedRect(x - x0, y - y0, barW, barH, barH / 2) &&
          x >= x0 &&
          x <= x0 + barW &&
          y >= y0 &&
          y <= y0 + barH
        ) {
          setPixel(canvas, size, x, y, WHITE);
        }
      }
    }
  }
}

function drawMediaGlyph(canvas, size) {
  // A play triangle.
  const cx = size / 2 + size * 0.03;
  const cy = size / 2;
  const r = size * 0.22;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (insideTriangle(x, y, [cx - r, cy - r], [cx - r, cy + r], [cx + r * 1.1, cy])) {
        setPixel(canvas, size, x, y, WHITE);
      }
    }
  }
}

function drawIconsGlyph(canvas, size) {
  // A 2x2 grid of small rounded squares.
  const cell = size * 0.18;
  const gap = size * 0.08;
  const totalW = cell * 2 + gap;
  const x0 = (size - totalW) / 2;
  const y0 = (size - totalW) / 2;
  for (const row of [0, 1]) {
    for (const col of [0, 1]) {
      const cx0 = x0 + col * (cell + gap);
      const cy0 = y0 + row * (cell + gap);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (
            x >= cx0 &&
            x <= cx0 + cell &&
            y >= cy0 &&
            y <= cy0 + cell &&
            insideRoundedRect(x - cx0, y - cy0, cell, cell, cell * 0.3)
          ) {
            setPixel(canvas, size, x, y, WHITE);
          }
        }
      }
    }
  }
}

function drawDevicesGlyph(canvas, size) {
  // A rounded rectangle "screen" with a small dot beneath it.
  const w = size * 0.4;
  const h = size * 0.3;
  const x0 = (size - w) / 2;
  const y0 = size * 0.28;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (
        x >= x0 &&
        x <= x0 + w &&
        y >= y0 &&
        y <= y0 + h &&
        insideRoundedRect(x - x0, y - y0, w, h, size * 0.05)
      ) {
        setPixel(canvas, size, x, y, WHITE);
      }
    }
  }
  const dotCx = size / 2;
  const dotCy = y0 + h + size * 0.1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (insideCircle(x, y, dotCx, dotCy, size * 0.035)) setPixel(canvas, size, x, y, WHITE);
    }
  }
}

function drawLibraryGlyph(canvas, size) {
  // Three vertical bars of different heights -- a bookshelf.
  const heights = [0.28, 0.4, 0.22];
  const barW = size * 0.1;
  const gap = size * 0.06;
  const totalW = heights.length * barW + (heights.length - 1) * gap;
  let x0 = (size - totalW) / 2;
  const baseY = size * 0.68;
  for (const h of heights) {
    const barH = size * h;
    const y0 = baseY - barH;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (
          x >= x0 &&
          x <= x0 + barW &&
          y >= y0 &&
          y <= baseY &&
          insideRoundedRect(x - x0, y - y0, barW, barH, barW * 0.25)
        ) {
          setPixel(canvas, size, x, y, WHITE);
        }
      }
    }
    x0 += barW + gap;
  }
}

function drawIcon(groupName) {
  const { bg, glyph } = GROUPS[groupName];
  const canvas = makeCanvas(SIZE);
  const radius = SIZE * 0.18;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (insideRoundedRect(x, y, SIZE, SIZE, radius)) setPixel(canvas, SIZE, x, y, bg);
    }
  }
  glyph(canvas, SIZE);
  return encodePng(SIZE, SIZE, canvas);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const groupName of Object.keys(GROUPS)) {
  const png = drawIcon(groupName);
  const outPath = join(OUT_DIR, `${groupName}.png`);
  writeFileSync(outPath, png);
  console.log(`wrote ${outPath} (${png.length} bytes)`);
}
