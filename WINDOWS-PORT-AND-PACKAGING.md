# M9 — Packaging + CI, and the Windows Port

> Status snapshot: **2026-07-07**. Originally a research-only doc (2026-06-18); the **core
> port + M9 work (§8) is now implemented** — see the checklist there. What remains is
> on-Windows testing and the optional parity polish.

---

## TL;DR

- **M9 is implemented** (2026-07-07): `bundle.windows` block, `.deb` runtime deps, Linux-only UI
  platform-gated, GitHub Actions CI (Linux **and** Windows checks per push, tag-driven installer
  releases). `pnpm tauri build` has been run on Linux — **deb + AppImage bundle clean** (9.4 MB /
  87 MB), control file verified.
- **A Windows build compiles and the core dictation loop runs out-of-the-box.** Every Linux-only
  crate is target-gated; every Linux module has a non-Linux stub. No porting work is needed just to
  get a running app. CI's `windows-latest` leg now keeps that claim honest on every push.
- **What does NOT auto-port** is the Linux/Wayland *input-plumbing niceties* (advanced evdev
  hotkeys, AT-SPI app/field detection, chip input-region shaping, Caps-Lock LED). All of these are
  **"needs a Windows implementation," not dead-ends** — Win32 / UI Automation / the Ctrl+C trick
  cover the equivalents. None block the core loop.
- Remaining before a Windows release: run the release workflow (or a local Windows build), smoke
  test the MSI/NSIS installers + the chip on real Windows (§6), then decide on the parity polish.

---

## 1. M9 — Packaging + CI

There was never a written spec for M9 — it was only a milestone *title* parked since the start.

### Already in place (from the M0 scaffold)

- `src-tauri/tauri.conf.json` → `bundle`:
  - `targets`: `["deb", "appimage", "msi"]`
  - `category` Utility, short/long descriptions, homepage, publisher
  - `license`: `AGPL-3.0-or-later`
  - icons wired (incl. `icon.ico` for Windows)
- `src-tauri/src/main.rs`: `windows_subsystem = "windows"` (suppresses the console window on Windows).
- WebView2 support is compiled in (the `webview2-com` dependency is pulled by Tauri).
- `README.md` already documents Windows 10/11 + Linux (x64) as target platforms.

### Missing — all resolved 2026-07-07

- ~~No CI at all~~ → `.github/workflows/ci.yml` (per-push `pnpm build` + `cargo check --locked` on
  ubuntu **and** windows runners, `cargo test` on Linux) and `release.yml` (tauri-action installer
  builds; `v*` tag → draft release gated on a `version.mjs` tag-vs-app-version check; manual run →
  artifacts). `packageManager` pinned in package.json for `pnpm/action-setup`.
- ~~No `bundle.windows` block~~ → WebView2 `downloadBootstrapper` (silent) + `nsis` target
  (per-user install) added; code-signing intentionally skipped (§8.3).
- ~~Unverified local build~~ → run on Linux 2026-07-07: **deb + AppImage bundle clean** on the
  first try. deb control verified (`Depends: libasound2, libxkbcommon0, libayatana-appindicator3-1,
  libwebkit2gtk-4.1-0, libgtk-3-0`; desktop file + hicolor icons in place). MSI/NSIS are skipped on
  Linux, as expected — the Windows leg of `release.yml` covers them (not yet exercised).
- ~~Linux `.deb` runtime deps~~ → declared `libasound2` (cpal) + `libxkbcommon0` (xkbcommon).
  Everything else in the dep tree is pure Rust (no libxdo — enigo 0.6 uses x11rb; no OpenSSL —
  rustls everywhere; evdev/AT-SPI/Wayland crates are syscall/zbus/pure-Rust). The bundler auto-adds
  webkit2gtk, gtk3, and (for the tray) libayatana-appindicator3-1 — don't re-declare those.

---

## 2. Windows portability — does it even compile?

**Yes.** `cargo build --target x86_64-pc-windows-msvc` would compile. Verified by reading
`src-tauri/Cargo.toml` and the module gating.

### Linux-only crates — all properly target-gated

All under `[target.'cfg(target_os = "linux")'.dependencies]`, so they are NOT pulled on Windows:
`ashpd`, `xkbcommon`, `evdev`, `gtk`, `wayland-client`, `wayland-protocols-misc`, `memfd`, `atspi`.

### Cross-platform crates — all have Windows backends

- `cpal` — audio capture (WASAPI on Windows)
- `rodio` — audio playback (on cpal)
- `keyring` — secret store (`windows-native` backend enabled)
- `enigo` — text/keyboard injection (SendInput on Windows)
- `arboard` — clipboard

### Not started yet

- No `[target.'cfg(windows)'.dependencies]` section; no `windows` / `winapi` crate.

### Module gating

Every Linux-only module has a `#[cfg(target_os = "linux")]` real impl + a `#[cfg(not(...))]`
stub: `atspi_guard.rs`, `evdev_hotkeys.rs`, `virtual_keyboard.rs`, `wayland_inject.rs`,
`overlay.rs` (GTK), `quickadd.rs` (KWin). Grep summary: ~30 `target_os = "linux"` gates, ~8
`not(target_os = "linux")` fallbacks, zero `#[cfg(unix)]`, zero `#[cfg(windows)]` (fallbacks are
generic, so none needed yet).

---

## 3. What works on Windows out-of-the-box

The entire core product runs via existing cross-platform paths:

| Feature | Windows path |
|---|---|
| Global hotkeys | `tauri-plugin-global-shortcut` — **incl. hold-to-talk, latch/toggle, chords** |
| Text injection | `enigo` (SendInput) + clipboard paste |
| Audio capture | `cpal` (WASAPI) |
| Secrets | `keyring` (windows-native) |
| Clipboard | `arboard` |
| Suspend/resume recovery | generic `std::time` (`commands.rs:spawn_suspend_watch`) |
| Config (JSON) | `serde` — platform-irrelevant |
| Quick-add window | show/hide/title + global shortcut summon |
| Dictionary / pipeline rules / usage stats | backend HTTP — platform-irrelevant |
| Recordings dir / transcript sidecar / trim-silence / auto-stop | `cpal` + `std::fs` |

---

## 4. What degrades gracefully (Linux-only niceties — NOT blockers)

All properly `#[cfg(target_os = "linux")]`-gated; on Windows they no-op or fall back:

| Subsystem | Windows behavior |
|---|---|
| **Advanced evdev hotkeys** (modifier-only trigger, left/right distinction, AltGr, N-chord) | Fall back to plugin (normal chords + hold + latch still work) |
| **AT-SPI** (focused-app detection, "skip when not a text field" field guard, per-app rules screen) | Inert — typing allowed everywhere; per-app rules screen does nothing |
| **Wayland virtual-keyboard** (`zwp_virtual_keyboard`) | `enigo` paste fallback |
| **Wayland portal injection** (xdg RemoteDesktop) | `enigo` fallback |
| **Caps-Lock LED** (`/sys/class/leds`) | Not needed — enigo handles layout |
| **Wayland modifier-release gate** | enigo handles timing |
| **Chip input-region shaping** (GTK/GDK, `overlay.rs apply_hit_region`) | Whole-window cursor handling — **needs verification** (see §6) |
| **KWin "keep above" window rules** (chip + quick-add) | Native always-on-top covers it |

---

## 5. The three deep-dive questions (verified against code)

### Q1 — Can I use Ctrl/Alt/Shift keys on Windows?

**Yes, mostly.** The global-shortcut plugin reports both key-press and release, and the trigger
code already handles it (`triggers.rs:133–135`):
- ✅ Normal chords (Ctrl+Alt+D…), **hold-to-talk (push-to-talk)**, and **latch/toggle** all work.
- ❌ Only **modifier-only** bindings (just AltGr, a lone Ctrl-tap) and **left-vs-right** distinction
  need Linux-evdev (`triggers.rs:180,232`).

→ Activation modes are covered on Windows; only the exotic modifier-only / L-R bindings fall back.

### Q2 — AT-SPI: can't we use window detection instead?

**Portable, just not written yet — not impossible.**
- **Which app is focused** (per-app rules + chip "→ app" readout): Windows `GetForegroundWindow`
  → process name. Implement it and per-app rules + the target readout work on Windows.
- **"Is the focused element a text field?"** (the skip-when-not-editable guard): Windows
  **UI Automation (UIA)**. More work, and like AT-SPI it can be flaky, but doable.

→ Per-app rules aren't fundamentally Linux-only; they're inert only because the *detector* feeding
them is AT-SPI. Swap in a Win32 detector and they light up.

### Q3 — Selected-text detection for quick-add?

Today the quick-add seed reads the focused element's selection via **AT-SPI**, falling back to the
**Wayland PRIMARY ("highlight") selection** (`commands.rs:686,731`). Both are Linux-only → on
Windows quick-add would **open empty** (no auto-grab of the highlighted word).

Windows path: **UIA TextPattern**, or the universal trick — **simulate Ctrl+C and read the
clipboard** (save/restore it). The Ctrl+C trick is the pragmatic one. Recoverable.

---

## 6. Chip overlay on Windows — the one real unknown

The chip renders and live-updates fine. The thing to **verify/adapt**: its **click-through
input-region shaping** is done via GTK/GDK (`overlay.rs`), Linux-only. On Windows it falls back to
whole-window cursor handling. Tauri's `ignore_cursor_events` is per-window there, so we must
confirm the **hover-reveal + quick-launch buttons stay interactive without the chip stealing clicks
from the desktop behind it.** Likely a small tweak, but it's the chip's one genuine unknown.

---

## 7. Frontend / UI copy gaps — resolved 2026-07-07

All gated on a new `src/lib/platform.ts` (`IS_LINUX`, synchronous UA sniff — WebKitGTK vs
WebView2 — so there's no first-paint flash):

- ~~Deep field detection~~ → row hidden off Linux (AT-SPI-backed, would be a dead switch).
- ~~Hardware hotkeys (evdev)~~ → the whole Permissions block hidden off Linux (`/dev/input` can
  never exist there); the on-Linux unavailable badge now reads "Unavailable".
- ~~Quick-add shortcut help~~ → the Wayland/evdev sentence renders only on Linux.
- ~~Profiles Wayland note~~ → Linux keeps the evdev guidance; Windows gets what actually registers
  (hold/latch/chords work; modifier-only + left/right-specific don't).
- ~~Per-app-rules screen~~ → `linuxOnly` flag on its `ScreenDef`; `VISIBLE_SCREENS` filters it out
  of the Sidebar + quick-launch picker. `SCREENS` stays complete so paths/labels of entries saved
  on another OS still resolve. The chip's "→ app" readout needs no gate — the `atspi_guard` stub
  returns `None` off Linux, so it simply never renders.

---

## 8. The work breakdown

### Core port + M9 (gets a shippable Windows build)

1. **Build & verify** — ◐ Linux half done 2026-07-07 (deb + AppImage clean, first try; see §1).
   The Windows half runs via `release.yml` — **still needs a first run + an installer smoke test
   on real Windows.**
2. **`bundle.windows` block** — ✅ done (WebView2 silent downloadBootstrapper, NSIS per-user).
3. **Code-signing** — ⏭ skipped deliberately: unsigned → SmartScreen warning, acceptable for a
   FOSS tool. Revisit only if it ever matters.
4. **UI copy gating** — ✅ done (see §7).
5. **CI** — ✅ done (`ci.yml` + `release.yml`; see §1). First `ci.yml` run (2026-07-07, run
   28873617044): **both legs green** — windows-latest 7m18s, ubuntu-latest 9m36s. `release.yml`
   still unexercised (needs a tag or manual dispatch).

### Optional Windows-parity polish (after the basic port runs)

- Win32 focused-app detection → enables per-app rules + chip target readout.
- UIA field guard → "skip when not a text field".
- Selected-text quick-add seed → UIA TextPattern or the Ctrl+C + clipboard trick.

---

## 9. Caveats / standing notes

- A **Linux code review won't catch Windows-specific issues** — those paths aren't compiled or run
  here. The port needs its own on-Windows testing.
- `/code-review ultra` is user-triggered and billed; the assistant cannot launch it (it can run a
  plain multi-agent review instead).
- Verification state of this doc: Cargo target-gating confirmed by reading `Cargo.toml`; module
  gating confirmed by source audit; Linux release build + deb/AppImage bundling verified locally
  (2026-07-07). **The "compiles on Windows" claim is now machine-verified** — `ci.yml`'s
  `windows-latest` leg (MSVC `cargo check --locked` against the real `dist/`) passed on its first
  run (2026-07-07). Still unverified: the MSI/NSIS *installers* (first `release.yml` run) and the
  Windows *runtime* (needs real hardware — §6 chip click-through especially).
