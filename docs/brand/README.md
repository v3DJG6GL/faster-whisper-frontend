# Brand assets

The icon is a five-bar level meter (amber gradient `#ffb95e → #ff9e2c`) on the
warm-dark Signal tile (`#262019 → #0e0d0b`, radius 224/1024). The bars lean 9°
forward — brand-family geometry shared with faster-whisper-backend's icon
("whisper bars, faster lean").

The wordmark follows the shared family grammar (same in the backend's logo):
light `faster` (weight 430) in ink + bold `whisper` (730) in the product accent,
then an accent `>` prompt before the tracked-caps role label (`> FRONTEND` here,
`> BACKEND` there). Each product keeps its own accent — amber for the frontend,
terminal green for the backend.

| File | What it is |
|---|---|
| `icon.svg` | Icon only, vector. Byte-identical copy of the canonical `src-tauri/icons/icon.svg` (that one is the source of truth — the app icon set is generated from it). |
| `icon.png` | Icon only, 512 px raster (from the generated set). |
| `logo-dark.svg` / `logo-light.svg` | Full logo (icon + wordmark), vector, wordmark converted to paths — renders everywhere with zero font dependencies. Regenerate with `python3 docs/brand/gen-logo-svg.py`. |
| `logo-dark.png` / `logo-light.png` | Full logo, raster (@2×, ~1060 px wide), transparent background. The repo README serves them via a `prefers-color-scheme` `<picture>`. |
| `logo.html` | Raster source — the app Sidebar's header at 4× with the real Hubot Sans / Geist Mono webfonts. Regen commands are documented inside the file. |
| `gen-logo-svg.py` | Vector source — draws the wordmark glyph outlines via fontTools and emits the two logo SVGs. |

If the icon changes, update every copy together:

- `src-tauri/icons/icon.svg` — the source of truth; regenerate the app icon set
  from it with `pnpm tauri icon src-tauri/icons/icon.svg`.
- `public/icon.svg` — the favicon `index.html` loads. `pnpm tauri icon` does
  **not** regenerate it; copy the svg over by hand.
- `docs/brand/icon.svg` (this folder) — plus `icon.png` and the logos above.
- `BrandMark` in `src/components/Sidebar.tsx` — the same artwork drawn in code.

The three svg files must stay byte-identical; CI (`.forgejo/workflows/ci.yml`)
fails if they differ.
