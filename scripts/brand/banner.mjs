#!/usr/bin/env node
/**
 * Deterministic rasterizer for assets/brand/yoto-banner.svg.
 *
 * Reads the 1600x900 banner SVG (source of truth, hand-authored in the same
 * visual language as social-preview.png: cream page, single rounded-square /
 * play-triangle mark on the left, wordmark + tagline on the right) and
 * renders assets/brand/yoto-banner-1600x900.png at exactly 1600x900.
 *
 * Uses the same @resvg/resvg-js wiring as rasterize.mjs / tool-icons.mjs
 * (scripts/brand/lib/render.mjs) so this never drifts from the other brand
 * renders. Run:
 *
 *   cd scripts/brand && npm install && npm run build:banner
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSvgToPng } from "./lib/render.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRAND_DIR = join(HERE, "..", "..", "assets", "brand");
const BANNER_SVG_PATH = join(BRAND_DIR, "yoto-banner.svg");
const BANNER_PNG_PATH = join(BRAND_DIR, "yoto-banner-1600x900.png");

const WIDTH = 1600;
const HEIGHT = 900;

function main() {
  const svg = readFileSync(BANNER_SVG_PATH, "utf8");
  const png = renderSvgToPng(svg, WIDTH);

  // The source SVG's viewBox is exactly 1600x900 (16:9), and renderSvgToPng
  // fits to width, so height should fall out exact -- verify rather than
  // assume, per the IHDR bytes resvg actually wrote.
  const ihdrWidth = png.readUInt32BE(16);
  const ihdrHeight = png.readUInt32BE(20);
  if (ihdrWidth !== WIDTH || ihdrHeight !== HEIGHT) {
    throw new Error(
      `rendered PNG is ${ihdrWidth}x${ihdrHeight}, expected ${WIDTH}x${HEIGHT} -- check yoto-banner.svg's viewBox`,
    );
  }

  writeFileSync(BANNER_PNG_PATH, png);
  console.log(`wrote ${BANNER_PNG_PATH} (${png.length} bytes, ${ihdrWidth}x${ihdrHeight})`);
}

main();
