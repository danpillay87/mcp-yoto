/**
 * Shared rasterization helpers for the brand scripts. Single source of truth
 * for the palette and the resvg wiring so logo, wordmark and tool-icon
 * renders never drift from each other.
 */
import { Resvg } from "@resvg/resvg-js";

// Palette also documented in assets/brand/README.md -- keep both in sync.
export const PALETTE = {
  orange: "#FF7A45", // primary brand colour -- tile/icon backgrounds
  cream: "#FFF3E3", // warm neutral -- glyph fill on orange
  plum: "#2B1F3D", // dark neutral -- text
  gold: "#FFC857", // accent -- used sparingly for a highlight per glyph
  muted: "#8A7F91", // muted plum -- fine print
};

export const FONT_STACK =
  "'Segoe UI Rounded', 'SF Pro Rounded', 'Nunito', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Rasterize an SVG string to PNG. `widthPx` is required and drives fitTo so
 * the output is exactly that many pixels wide (the source SVGs here are all
 * square, so height matches). Throws if resvg doesn't return a valid PNG --
 * a bad render should fail loudly, not write a broken file to disk.
 */
export function renderSvgToPng(svgString, widthPx) {
  const resvg = new Resvg(svgString, {
    fitTo: { mode: "width", value: widthPx },
    font: { loadSystemFonts: true, defaultFontFamily: "Segoe UI" },
  });
  const png = resvg.render().asPng();
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("resvg produced a buffer that is not a valid PNG (bad signature)");
  }
  return png;
}
