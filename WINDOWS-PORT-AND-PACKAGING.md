# M9 — Packaging + CI, and the Windows Port

> Status snapshot: **2026-06-18**. Research-only document — nothing here is implemented yet.
> Captures everything found while assessing what it takes to ship a packaged build and a
> working Windows release. Written so a fresh session can pick up without re-investigating.

---

## TL;DR

- **Packaging is ~mostly configured already** (from the M0 scaffold). The real gaps are: no CI,
  no Windows-specific bundle block, and we've **never actually run `pnpm tauri build`** to confirm
  installers come out clean.
- **A Windows build compiles and the core dictation loop runs out-of-the-box.** Every Linux-only
  crate is target-gated; every Linux module has a non-Linux stub. No porting work is needed just to
  get a running app.
- **What does NOT auto-port** is the Linux/Wayland *input-plumbing niceties* (advanced evdev
  hotkeys, AT-SPI app/field detection, chip input-region shaping, Caps-Lock LED). All of these are
  **"needs a Windows implementation," not dead-ends** — Win32 / UI Automation / the Ctrl+C trick
  cover the equivalents. None block the core loop.
- Recommended sequence: **finish small features → run code reviews on Linux → then port.** A Linux
  review will NOT catch Windows-specific issues (those paths aren't compiled/run here), so the port
  still needs its own on-Windows testing.

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

### Missing

- **No CI at all** — there is no `.github/workflows/` directory; nothing builds automatically.
- **No `bundle.windows` block** — no WebView2 runtime install strategy, no NSIS config, no
  code-signing certificate config.
- **Unverified local build** — `pnpm tauri build` has never been run; installer output is unconfirmed.
- **Linux `.deb` runtime deps** — should declare evdev / AT-SPI / GTK runtime dependencies; needs checking.

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

## 7. Frontend / UI copy gaps (Windows users would see Linux jargon)

- `src/screens/Settings.tsx:477` — "Deep field detection" ("uses accessibility"), no platform qualifier.
- `src/screens/Settings.tsx:791–792` — "Hardware hotkeys (evdev)" mentions `/dev/input` + "input
  group" (shows a "Linux only" badge, at least).
- `src/screens/Settings.tsx:343` — quick-add shortcut help references evdev/Wayland.
- `src/screens/Profiles.tsx:265` — "On Wayland… need the evdev backend" note.
- Good news: **no hardcoded Linux paths** in the frontend, **no** `navigator.platform` checks.
- The per-app-rules screen would be inert on Windows → should be gated/hidden.

---

## 8. The work breakdown

### Core port + M9 (gets a shippable Windows build)

1. **Build & verify** — run `pnpm tauri build` on Windows (or cross/CI); confirm the MSI (and/or
   NSIS) produce a working installer. *(Biggest unknown — never done.)*
2. **`bundle.windows` block** in `tauri.conf.json` — WebView2 install mode (+ optional NSIS target). *(Small.)*
3. **Code-signing (optional)** — unsigned → Windows SmartScreen warning. Needs a cert; skipping is
   acceptable for a FOSS tool.
4. **UI copy gating** — hide/qualify the Linux-only controls (evdev options, deep field detection,
   per-app rules) on Windows so users don't see dead switches.
5. **CI** — GitHub Actions: `windows-latest` (+ `ubuntu-latest`) runners to build installers,
   optionally publish them on a version tag. *(This is the "CI" half of M9.)*

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
- Verification state of this doc: Cargo target-gating confirmed by reading `Cargo.toml`; `cargo
  check` passes on Linux; module gating confirmed by source audit. The Windows *build itself* is
  still unverified.
