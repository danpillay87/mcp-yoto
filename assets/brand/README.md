# mcp-yoto brand assets

Not affiliated with Yoto. This is an independent, open-source project — "Works with Yoto"
describes compatibility, not endorsement. Do not use Yoto's own logo, wordmark, or anything
that implies official status; these assets are this project's own mark only.

## Files

- `logo.svg` — full tile: rounded square (512×512 viewBox) with the pixel-art play-triangle motif. Source of truth for every rasterised size below.
- `logo-mark.svg` — the play-triangle motif only, transparent background, recoloured to sit on a light page.
- `wordmark.svg` — "mcp-yoto" as text, rounded geometric sans (system font stack — no embedded fonts).
- `logo-1024.png`, `logo-512.png`, `logo-256.png`, `logo-128.png`, `logo-64.png`, `logo-32.png` — rasterised from `logo.svg`.
- `social-preview.png` — 1280×640 GitHub social-preview card (logo + title + tagline).
- `tool-icons/*.png` — 64×64 icons for the seven MCP tool groups (server, auth, content, media, icons, devices, library), same style and palette as the logo. These are a proposal for `apps/worker/public/icons` — copy them over rather than editing them in place, since that folder belongs to another workstream.

Regenerate everything with:

```
cd scripts/brand
npm install
npm run build             # logo sizes + social preview
npm run build:tool-icons  # the seven tool-group icons
```

## Palette

| Swatch | Name | Hex | Use |
|---|---|---|---|
| 🟧 | Orange (primary) | `#FF7A45` | Tile/icon backgrounds, the "yoto" half of the wordmark |
| 🟨 | Gold (accent) | `#FFC857` | Small highlight details only — used sparingly, never as a base fill |
| ⬜ | Cream (neutral, light) | `#FFF3E3` | Glyph fill on orange, page background for the social card |
| 🟪 | Plum (neutral, dark) | `#2B1F3D` | Text, the "mcp-" half of the wordmark |
| ◻️ | Muted plum | `#8A7F91` | Fine print (e.g. the "not affiliated" line on the social card) |

Deliberately distinct from Yoto's own house colours — this is a warm, kid-friendly palette in
its own right, not a lookalike.

## Motif

A chunky, pixel-art play triangle (an 8-row staircase on a 12×12 grid) — unmistakably an
audio/"play" shape at any size, including a 16 px favicon. Check any future edit at 32 px and
64 px before accepting it: if the silhouette doesn't read as "play" in one word, iterate.
