#!/usr/bin/env node
/**
 * Renders the seven tool-group icons (64x64 PNG) into
 * assets/brand/tool-icons/<group>.png, in the same rounded-square / single
 * clean glyph style and palette as assets/brand/logo.svg -- smooth shapes,
 * no pixel blocks.
 *
 * These are a proposal for the placeholder set in apps/worker/public/icons
 * (owned by another agent/session) -- deliberately written outside that
 * folder so it can review and copy them over rather than being overwritten
 * mid-edit. Each glyph is a plain, literal shape (server = three bars, key,
 * card, waveform, grid of dots, player with two dials, stacked cards) chosen
 * to avoid the "looks like a toilet" silhouette flagged on the previous
 * placeholder set.
 *
 * Run: cd scripts/brand && npm install && npm run build:tool-icons
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PALETTE, renderSvgToPng } from "./lib/render.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "..", "assets", "brand", "tool-icons");

const SIZE = 64;
const { orange, cream, gold } = PALETTE;

// Each glyph is inner SVG markup only -- the rounded-square orange tile is
// shared and added once in buildIconSvg().
const GLYPHS = {
  // Server: three plain horizontal bars, middle one picked out in gold.
  server: `
    <rect x="12" y="15" width="40" height="9" rx="4.5" fill="${cream}"/>
    <rect x="12" y="27.5" width="40" height="9" rx="4.5" fill="${gold}"/>
    <rect x="12" y="40" width="40" height="9" rx="4.5" fill="${cream}"/>
  `,
  // Key: a ring (punched hole = bg colour), a shaft, one rounded tooth.
  auth: `
    <circle cx="22" cy="32" r="11" fill="${cream}"/>
    <circle cx="22" cy="32" r="5" fill="${orange}"/>
    <rect x="30" y="29" width="23" height="6" rx="3" fill="${cream}"/>
    <rect x="41" y="35" width="8" height="9" rx="3" fill="${cream}"/>
  `,
  // Card: a single flat rounded rect with a circular "window", like a MYO card.
  content: `
    <rect x="14" y="10" width="36" height="44" rx="6" fill="${cream}"/>
    <circle cx="32" cy="32" r="8" fill="${orange}"/>
    <circle cx="32" cy="32" r="3" fill="${gold}"/>
  `,
  // Waveform: five bars, tallest (gold) in the centre.
  media: `
    <rect x="9"  y="23" width="6" height="18" rx="3" fill="${cream}"/>
    <rect x="19" y="17" width="6" height="30" rx="3" fill="${cream}"/>
    <rect x="29" y="11" width="6" height="42" rx="3" fill="${gold}"/>
    <rect x="39" y="17" width="6" height="30" rx="3" fill="${cream}"/>
    <rect x="49" y="23" width="6" height="18" rx="3" fill="${cream}"/>
  `,
  // Icon grid: 2x2 dots, one picked out in gold.
  icons: `
    <circle cx="21" cy="21" r="8" fill="${cream}"/>
    <circle cx="43" cy="21" r="8" fill="${gold}"/>
    <circle cx="21" cy="43" r="8" fill="${cream}"/>
    <circle cx="43" cy="43" r="8" fill="${cream}"/>
  `,
  // Player: a rounded-square body with two round dial buttons on the top
  // edge -- the actual silhouette of a Yoto player, not a bowl/seat shape.
  devices: `
    <rect x="14" y="20" width="36" height="32" rx="8" fill="${cream}"/>
    <circle cx="24" cy="20" r="7" fill="${gold}"/>
    <circle cx="40" cy="20" r="7" fill="${gold}"/>
  `,
  // Library: three cards fanned/stacked to read as "a library of cards".
  library: `
    <rect x="8"  y="8"  width="32" height="40" rx="6" fill="${cream}"/>
    <rect x="16" y="14" width="32" height="40" rx="6" fill="${gold}"/>
    <rect x="24" y="20" width="32" height="40" rx="6" fill="${cream}"/>
  `,
};

function buildIconSvg(glyphMarkup) {
  return `<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${SIZE}" height="${SIZE}" rx="16" ry="16" fill="${orange}"/>
  ${glyphMarkup}
</svg>`;
}

function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  for (const [group, glyphMarkup] of Object.entries(GLYPHS)) {
    const svg = buildIconSvg(glyphMarkup);
    const png = renderSvgToPng(svg, SIZE);
    const outPath = join(OUT_DIR, `${group}.png`);
    writeFileSync(outPath, png);
    console.log(`wrote ${outPath} (${png.length} bytes)`);
  }
}

main();
