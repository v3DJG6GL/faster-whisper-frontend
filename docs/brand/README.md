# Brand assets

The mark is a five-bar level meter (amber gradient `#ffb95e → #ff9e2c`) on the
warm-dark Signal tile (`#262019 → #0e0d0b`, radius 224/1024).

| File | What it is |
|---|---|
| `mark.svg` | Icon-only mark, vector. Copy of the canonical `src-tauri/icons/icon.svg` (that one is the source of truth — the app icon set is generated from it; keep this copy in sync). |
| `mark.png` | Icon-only mark, 512 px raster (from the generated set). |
| `lockup.html` | Source for the full lockup — the app Sidebar's header (mark + "faster**whisper**" wordmark + DICTATION label) at 4× with the real Hubot Sans / Geist Mono. Regen commands are documented inside the file. |
| `lockup-dark.png` / `lockup-light.png` | Rendered lockups, transparent background, for dark/light grounds. The repo README serves them via a `prefers-color-scheme` `<picture>`. |

The in-app rendering of the same artwork lives in `BrandMark`
(`src/components/Sidebar.tsx`) — if the mark changes, update all three places:
`src-tauri/icons/icon.svg` (+ `pnpm tauri icon`), `BrandMark`, and this folder.
