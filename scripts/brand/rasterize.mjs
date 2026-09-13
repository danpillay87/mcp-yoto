#!/usr/bin/env node
/**
 * Deterministic rasterizer for assets/brand/logo.svg.
 *
 * Reads assets/brand/logo.svg as the single source of truth and renders:
 *   - assets/brand/logo-<size>.png  for 1024, 512, 256, 128, 64, 32
 *   - assets/brand/social-preview.png (1280x640, logo + title/tagline)
 *
 * Uses @resvg/resvg-js (pinned in this folder's own package.json) so the
 * root workspace's lockfile is untouched. Run:
 *
 *   cd scripts/brand && npm install && npm run build
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FONT_STACK, PALETTE, renderSvgToPng } from "./lib/render.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRAND_DIR = join(HERE, "..", "..", "assets", "brand");
const LOGO_SVG_PATH = join(BRAND_DIR, "logo.svg");

const SIZES = [1024, 512, 256, 128, 64, 32];

function readLogoInnerMarkup() {
  const svg = readFileSync(LOGO_SVG_PATH, "utf8");
  const match = svg.match(/<svg[^>]*>([\s\S]*)<\/svg>/);
  if (!match) throw new Error(`Could not parse ${LOGO_SVG_PATH} as an SVG document`);
  return match[1];
}

function buildSocialPreviewSvg(logoInnerMarkup) {
  const width = 1280;
  const height = 640;
  const logoSize = 320;
  const logoX = 96;
  const logoY = (height - logoSize) / 2;
  const textX = logoX + logoSize + 64;

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${width}" height="${height}" fill="${PALETTE.cream}"/>
  <svg x="${logoX}" y="${logoY}" width="${logoSize}" height="${logoSize}" viewBox="0 0 512 512">
    ${logoInnerMarkup}
  </svg>
  <text x="${textX}" y="270" font-family="${FONT_STACK}" font-size="72" font-weight="700" letter-spacing="-1" fill="${PALETTE.plum}">mcp-<tspan fill="${PALETTE.orange}">yoto</tspan></text>
  <text x="${textX}" y="326" font-family="${FONT_STACK}" font-size="34" font-weight="700" fill="${PALETTE.orange}">Works with Yoto</text>
  <text x="${textX}" y="380" font-family="${FONT_STACK}" font-size="26" font-weight="400" fill="${PALETTE.plum}">Connect your Yoto library to Claude &amp; ChatGPT.</text>
  <text x="${textX}" y="560" font-family="${FONT_STACK}" font-size="20" font-weight="400" fill="${PALETTE.muted}">Independent, open-source &#8212; not affiliated with Yoto</text>
</svg>`;
}

function main() {
  if (!existsSync(BRAND_DIR)) mkdirSync(BRAND_DIR, { recursive: true });

  const logoSvgFull = readFileSync(LOGO_SVG_PATH, "utf8");
  const logoInnerMarkup = readLogoInnerMarkup();

  for (const size of SIZES) {
    const png = renderSvgToPng(logoSvgFull, size);
    const outPath = join(BRAND_DIR, `logo-${size}.png`);
    writeFileSync(outPath, png);
    console.log(`wrote ${outPath} (${png.length} bytes)`);
  }

  const socialSvg = buildSocialPreviewSvg(logoInnerMarkup);
  const socialPng = renderSvgToPng(socialSvg, 1280);
  const socialOutPath = join(BRAND_DIR, "social-preview.png");
  writeFileSync(socialOutPath, socialPng);
  console.log(`wrote ${socialOutPath} (${socialPng.length} bytes)`);
}

main();
