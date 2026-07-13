//! The dictation chip overlay window (a separate transparent, always-on-top
//! webview defined in `tauri.conf.json` as label `overlay`).
//!
//! The chip's *content* is driven entirely from the main window, which broadcasts
//! a `dictation://update` event with the assembled `{status, level, partial}`.
//! Here we only own the *window*: showing it at the configured screen edge when
//! dictation starts and hiding it when it ends — never taking focus (focus would
//! break text injection into the previously-focused app).
//!
//! Placement is platform-specific:
//!   * **Windows / Linux-X11** — `set_position` + `set_always_on_top` work, so the
//!     chip is centred at the top (or bottom) and kept above other windows.
//!   * **KDE Wayland** — clients can't position themselves or force keep-above, so
//!     we install a small, reversible **KWin window rule** (matched on a unique,
//!     invisible chip title) that keeps the chip above, off the taskbar, and unable
//!     to steal focus, and forces its position. The position targets the *active*
//!     output (where the cursor / focused window is — `KWin.activeOutputName`), so
//!     on a multi-monitor desktop the chip follows you. See the `kwin` submodule.
//!   * **Other Wayland (GNOME)** — neither works; the chip is shown wherever the
//!     compositor puts it and the tray + sounds are the reliable status cue.

use tauri::{AppHandle, Manager, PhysicalPosition, WebviewWindow};

/// Logical size declared for the `overlay` window in tauri.conf.json. The chip pill is
/// centred in this (transparent, click-through) strip and capped to it; widened so a full
/// readout (tag │ lang · mode │ stats │ target) plus up to ~6 quick-launch buttons fits
/// on one line without the last button being clipped.
const CHIP_W: f64 = 820.0;
const CHIP_H: f64 = 132.0;
/// A unique, stable window title the KDE rule matches on. Invisible to the user:
/// the chip has no decorations and is hidden from the taskbar/switcher.
#[cfg(target_os = "linux")]
const CHIP_TITLE: &str = "fwf-dictation-chip";

/// Position the chip horizontally centred and FLUSH against the chosen screen edge ("top" |
/// "bottom") of the monitor it currently lives on. The window's own edge then IS the screen
/// edge, so the webview can CSS-slide the chip between its resting inset and the edge-peek
/// tuck — where only the status dot's outer half stays on-screen (the rest is clipped by the
/// viewport). The window itself never moves for the peek: a Wayland window-move can't be
/// tweened, and KWin silently DROPS an off-output/negative forced position (so the old
/// "raise the window off the border" trick never actually applied). A no-op on native
/// Wayland (the compositor decides).
fn position(win: &WebviewWindow, edge: &str) {
    let monitor = match win.current_monitor() {
        Ok(Some(m)) => Some(m),
        _ => win.primary_monitor().ok().flatten(),
    };
    let Some(monitor) = monitor else { return };

    let scale = monitor.scale_factor();
    let m_pos = monitor.position();
    let m_size = monitor.size();
    let chip_w = (CHIP_W * scale) as i32;
    let chip_h = (CHIP_H * scale) as i32;

    let x = m_pos.x + ((m_size.width as i32 - chip_w) / 2).max(0);
    let y = if edge == "bottom" {
        m_pos.y + m_size.height as i32 - chip_h
    } else {
        m_pos.y
    };
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

/// Show the chip at the requested edge ("top" | "bottom"), without focusing it. The window is
/// anchored flush against that edge; the resting inset and the edge-peek tuck are pure CSS
/// inside the webview (see Overlay.tsx).
#[tauri::command]
pub fn show_overlay(app: AppHandle, position: String) {
    let Some(win) = app.get_webview_window("overlay") else {
        return;
    };
    self::position(&win, &position);
    let _ = win.set_always_on_top(true);

    #[cfg(target_os = "linux")]
    if kwin::is_kde_wayland() {
        let _ = win.set_title(CHIP_TITLE);
        let _ = win.show();
        ignore_cursor(&win);
        // ignore_cursor REPLACED the input shape with an empty one (whole window click-through);
        // restore the chip's hit region at once so a standby→session re-center doesn't leave the
        // chip unhoverable. The webview re-reports its exact bounds a beat later.
        reapply_last_hit_region(&win);
        // Pin the chip top/bottom-centre of the *active* output via a KWin rule.
        // This shells out (qdbus6 / kscreen-doctor / kwriteconfig6 / dbus-send), which
        // can BLOCK: a write to kwinrulesrc can D-Bus-activate a KDE helper (kded6,
        // kconf_update) that inherits the captured stdout pipe and never closes it, so
        // `.output()` waits on EOF forever. show_overlay is a *sync* Tauri command, so
        // it runs on the GTK/UI thread — a hang here freezes the whole app and every
        // queued command (text injection included). Do it on a detached thread; the
        // window is already shown, the rule only nudges it into position afterwards.
        std::thread::spawn(move || {
            kwin::place_chip(kwin::chip_position(&position, CHIP_W, CHIP_H));
        });
        return;
    }

    let _ = win.show();
    ignore_cursor(&win);
    #[cfg(target_os = "linux")]
    reapply_last_hit_region(&win);
    // Windows has no per-region input shape — the whole window stays click-through
    // and a poller flips cursor pass-through while the global cursor sits over the
    // chip rect (see win_hover). Clicking the now-interactive chip must not
    // ACTIVATE the window either (focus would break injection into the previously
    // focused app — the job KWin's acceptfocus=false rule does on Linux):
    // set_focusable(false) maps to WS_EX_NOACTIVATE.
    #[cfg(windows)]
    {
        let _ = win.set_focusable(false);
        win_hover::on_show(&app);
    }
}

// The edge-peek never moves the window. The window is anchored FLUSH against the screen edge
// (an on-output position KWin honours) and the chip slides between its resting inset and the
// dot-only tuck purely in CSS, clipped by the viewport edge (see Overlay.tsx). Two earlier
// approaches failed: moving the window for the peek teleported (Wayland can't tween a move),
// and raising the window off the border to fake the overflow was silently DROPPED by KWin
// (it discards a forced position whose top-left is outside every output).

/// Make the (display-only) chip click-through so the big mostly-transparent window
/// never swallows clicks meant for the app beneath. MUST be called only AFTER
/// `show()` — on GTK/KDE-Wayland calling it on a still-hidden (unrealized) window
/// unwraps a `None` in tao and aborts the whole app.
fn ignore_cursor(win: &WebviewWindow) {
    let _ = win.set_ignore_cursor_events(true);
}

/// Hide the chip.
#[tauri::command]
pub fn hide_overlay(app: AppHandle) {
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.hide();
    }
    #[cfg(windows)]
    win_hover::on_hide();
}

/// Shape the chip window's *input* region to a single rectangle = the visible chip
/// bounds (in the window's logical px, as measured by the webview). Only that
/// rectangle captures the cursor; the rest of the big transparent strip stays
/// click-through. This is what lets the chip be *hovered* (to reveal the active
/// Profile's language/mode) without the window swallowing clicks meant for apps
/// beneath it.
///
/// Linux applies it as a GDK input shape; Windows has no input-shape API, so the
/// rect instead feeds the `win_hover` poller, which flips whole-window cursor
/// pass-through at the rect's boundary. On any failure — or other platforms — it
/// falls back to full click-through (`set_ignore_cursor_events(true)`), i.e. the
/// persistent tag still shows, only hover-reveal is unavailable. Never panics.
#[tauri::command]
pub fn set_chip_hit_region(app: AppHandle, x: f64, y: f64, w: f64, h: f64, persist: bool) {
    let Some(win) = app.get_webview_window("overlay") else {
        return;
    };
    #[cfg(target_os = "linux")]
    {
        // Remember the latest requested region so a later (re)show can restore it: show_overlay
        // re-applies set_ignore_cursor_events(true), which REPLACES the input shape with an empty
        // one (whole window click-through) and would otherwise leave the chip unhoverable until
        // the webview happens to re-report. See reapply_last_hit_region / show_overlay.
        // persist=false is the TRANSIENT full-window hover hold (applied to keep the cursor inside
        // the shape through the body morph) — NOT the chip's real bounds, so we must NOT remember
        // it: a re-show that reapplied a full-window region would make the whole transparent strip
        // swallow clicks until the webview re-reports precise bounds.
        if persist {
            if let Ok(mut last) = LAST_HIT_REGION.lock() {
                *last = Some((x, y, w, h));
            }
        }
        let applied = apply_hit_region(&win, x, y, w, h).is_some();
        tracing::debug!("[overlay] hit_region x={x:.0} y={y:.0} w={w:.0} h={h:.0} applied={applied}");
        // If not applied, the GdkWindow isn't realized yet — a later retry will get
        // it. We must NOT fall back to `set_ignore_cursor_events` here: on an
        // unrealized window tao does `window().unwrap()` and ABORTS the whole app
        // (the same hazard `show_overlay` documents). The window was already made
        // click-through at show time, so doing nothing is safe.
    }
    #[cfg(windows)]
    {
        let _ = &win;
        win_hover::set_region(x, y, w, h, persist);
    }
    #[cfg(all(not(target_os = "linux"), not(windows)))]
    {
        let _ = (&win, x, y, w, h, persist);
    }
}

/// Is the cursor REALLY over the chip window right now, as the windowing system sees it?
/// The webview asks before acting on a held hover: WebKitGTK can drop the chip's
/// `pointerleave` when the input shape is reshaped mid-crossing (a quick graze over the
/// tucked dot races the full-window hover hold — see `set_chip_hit_region`'s persist=false
/// caller), stranding the webview's hover state true with the cursor long gone. GDK's
/// answer comes from compositor enter/leave events directly, so it stays correct even when
/// the DOM event was lost. Fails OPEN (true) whenever no confident answer is available —
/// this is a *cancellation* signal, and a query hiccup must not break a legitimate hover.
#[tauri::command]
pub fn chip_pointer_over(app: AppHandle) -> bool {
    let Some(win) = app.get_webview_window("overlay") else {
        return false;
    };
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::{DeviceExt, SeatExt, WidgetExt};
        let Ok(gtk_win) = win.gtk_window() else {
            return true;
        };
        let Some(gdk_win) = WidgetExt::window(&gtk_win) else {
            return true;
        };
        let Some(pointer) = gdk_win.display().default_seat().and_then(|s| s.pointer()) else {
            return true;
        };
        // The window under the pointer: on Wayland this is the surface holding pointer focus
        // (None whenever the cursor is over another app or nothing of ours); on X11 the
        // walk-from-root only finds our window when the cursor is actually over it. Compare
        // toplevels — the webview may own a child GdkWindow.
        let (under, _x, _y) = pointer.window_at_position();
        return under.is_some_and(|w| w.toplevel() == gdk_win);
    }
    #[cfg(windows)]
    {
        let _ = &win;
        return win_hover::cursor_in_chip(&app).unwrap_or(true);
    }
    #[cfg(all(not(target_os = "linux"), not(windows)))]
    {
        let _ = &win;
        true
    }
}

/// The most recent chip hit region (logical px) requested by the webview, so a (re)show can
/// restore it the instant `ignore_cursor` wipes the input shape (the webview also re-reports its
/// exact bounds a beat later). `Mutex::new` is const, so no lazy init is needed.
#[cfg(target_os = "linux")]
static LAST_HIT_REGION: std::sync::Mutex<Option<(f64, f64, f64, f64)>> = std::sync::Mutex::new(None);

/// Re-apply the last known chip hit region after a (re)show's `ignore_cursor` reset, so the chip
/// stays hoverable across a standby→session re-center without waiting on a webview round-trip.
/// No-op before the webview has ever reported a region (e.g. the very first show).
#[cfg(target_os = "linux")]
fn reapply_last_hit_region(win: &WebviewWindow) {
    if let Ok(last) = LAST_HIT_REGION.lock() {
        if let Some((x, y, w, h)) = *last {
            let _ = apply_hit_region(win, x, y, w, h);
        }
    }
}

/// Apply a rectangular GDK input region to the overlay's underlying window. GDK
/// input regions live in the window's *logical* coordinate space (GDK applies
/// HiDPI scaling itself), so the webview's CSS-px `getBoundingClientRect` maps
/// straight through. A small pad makes the hit area forgiving at the chip edges.
#[cfg(target_os = "linux")]
fn apply_hit_region(win: &WebviewWindow, x: f64, y: f64, w: f64, h: f64) -> Option<()> {
    // `.window()` is a GtkWidget method (WidgetExt); `input_shape_combine_region`
    // is an inherent method on gdk::Window, so no gdk trait import is needed.
    use gtk::prelude::WidgetExt;

    let gtk_win = match win.gtk_window() {
        Ok(w) => w,
        Err(e) => {
            tracing::warn!("[overlay] gtk_window() failed: {e}");
            return None;
        }
    };
    let Some(gdk_win) = WidgetExt::window(&gtk_win) else {
        tracing::warn!("[overlay] no GdkWindow yet (window not realized?)");
        return None;
    };
    let pad = 10.0;
    let rect = gtk::cairo::RectangleInt::new(
        (x - pad).floor() as i32,
        (y - pad).floor() as i32,
        (w + 2.0 * pad).ceil() as i32,
        (h + 2.0 * pad).ceil() as i32,
    );
    let region = gtk::cairo::Region::create_rectangle(&rect);
    gdk_win.input_shape_combine_region(&region, 0, 0);
    Some(())
}

/// Windows stand-in for the GDK input shape: tao's only click-through control there
/// is whole-window `set_ignore_cursor_events`, so the chip would be either fully
/// click-through (never hoverable/clickable — the pre-fix behavior) or an
/// 820×132 click-stealing strip. Instead the window STAYS click-through and a
/// poller watches the global cursor against the webview-reported chip rect,
/// enabling cursor events exactly while the cursor is over the chip — so
/// hover-reveal and the quick-launch buttons work, while clicks anywhere else on
/// the transparent strip keep reaching the app beneath.
///
/// Pure tauri + std (no Win32 types), so it compiles on every platform and the
/// Linux dev loop type-checks it — only the call sites are `#[cfg(windows)]`.
#[cfg_attr(not(windows), allow(dead_code))]
mod win_hover {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    use tauri::{AppHandle, Manager};

    /// Chip visibility as driven by the show/hide commands, so the poller idles
    /// without touching window getters while the chip is hidden.
    static VISIBLE: AtomicBool = AtomicBool::new(false);
    /// One poller thread for the app's lifetime (spawned on the first show).
    static POLLER: AtomicBool = AtomicBool::new(false);
    /// Latest webview-reported hit rect (window-logical px), INCLUDING transient
    /// persist=false hover holds, and the persistent rect a (re)show resets to —
    /// mirroring LAST_HIT_REGION's persist semantics on Linux.
    static REGION: Mutex<Option<(f64, f64, f64, f64)>> = Mutex::new(None);
    static PERSIST: Mutex<Option<(f64, f64, f64, f64)>> = Mutex::new(None);

    pub fn set_region(x: f64, y: f64, w: f64, h: f64, persist: bool) {
        if let Ok(mut r) = REGION.lock() {
            *r = Some((x, y, w, h));
        }
        if persist {
            if let Ok(mut p) = PERSIST.lock() {
                *p = Some((x, y, w, h));
            }
        }
    }

    pub fn on_show(app: &AppHandle) {
        // A transient hover hold must not survive a re-show (it would make the whole
        // strip hover-activate) — reset to the persistent rect, like
        // reapply_last_hit_region does on Linux.
        if let (Ok(mut r), Ok(p)) = (REGION.lock(), PERSIST.lock()) {
            *r = *p;
        }
        VISIBLE.store(true, Ordering::SeqCst);
        if !POLLER.swap(true, Ordering::SeqCst) {
            let app = app.clone();
            let _ = std::thread::Builder::new()
                .name("chip-hover-poll".into())
                .spawn(move || run(app));
        }
    }

    pub fn on_hide() {
        VISIBLE.store(false, Ordering::SeqCst);
    }

    fn run(app: AppHandle) {
        // Whether the window currently RECEIVES cursor events (= !ignore_cursor_events).
        let mut interactive = false;
        loop {
            let visible = VISIBLE.load(Ordering::SeqCst);
            // 50 ms tracks hover-enter/leave comfortably (GetCursorPos + GetWindowRect
            // are cheap syscalls); idle slowly while hidden.
            std::thread::sleep(std::time::Duration::from_millis(if visible { 50 } else { 250 }));
            let want = visible && cursor_in_chip(&app).unwrap_or(false);
            if want != interactive {
                interactive = want;
                // Window mutations go through the main thread, matching the rest of
                // the codebase (show_overlay's own GTK-hazard note).
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    if let Some(win) = handle.get_webview_window("overlay") {
                        let _ = win.set_ignore_cursor_events(!want);
                    }
                });
            }
        }
    }

    /// Is the global cursor inside the chip rect? Webview-logical rect → physical px
    /// (same 10 px forgiveness pad as the GDK shape). None (no rect yet / any getter
    /// failure) reads as "outside" — the window stays click-through.
    pub fn cursor_in_chip(app: &AppHandle) -> Option<bool> {
        let (x, y, w, h) = (*REGION.lock().ok()?)?;
        let win = app.get_webview_window("overlay")?;
        let cur = app.cursor_position().ok()?;
        let pos = win.outer_position().ok()?;
        let scale = win.scale_factor().ok()?;
        let pad = 10.0 * scale;
        let rx = pos.x as f64 + x * scale - pad;
        let ry = pos.y as f64 + y * scale - pad;
        Some(
            cur.x >= rx
                && cur.x < rx + w * scale + 2.0 * pad
                && cur.y >= ry
                && cur.y < ry + h * scale + 2.0 * pad,
        )
    }
}

/// KDE-specific overlay placement via a KWin window rule. On native Wayland a
/// client can't position its own window or force "keep above"; KWin ignores both.
/// The portable fix on KDE is a *window rule*, which KWin applies compositor-side.
/// We write one (merged into the user's `~/.config/kwinrulesrc` without clobbering
/// their existing rules) and ask KWin to reload. The rule only ever matches our
/// chip, identified by its unique title.
#[cfg(target_os = "linux")]
mod kwin {
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    // Generic KConfig/KWin primitives are shared with quickadd::kwin via crate::kwin.
    use crate::kwin::{config_tools, merge_general, reconfigure, set_key};
    pub use crate::kwin::is_kde_wayland;

    /// KConfig group (and `rules=` entry) for our rule. A fixed name keeps the
    /// operation idempotent — re-runs update the same entry instead of piling up.
    const GROUP: &str = "fwf-dictation-chip";
    /// Whether the (position-independent) rule body has been written this session.
    static INSTALLED: AtomicBool = AtomicBool::new(false);
    /// The last logical position we forced, so we only reconfigure KWin when the
    /// active output actually changes (avoids churn on every dictation).
    static LAST_POS: Mutex<Option<(i32, i32)>> = Mutex::new(None);

    /// Connector name of the output the user is on (cursor / focused window), via
    /// KWin's D-Bus. e.g. "DP-1". None if KWin isn't reachable.
    fn active_output_name() -> Option<String> {
        for q in ["qdbus6", "qdbus-qt6", "qdbus"] {
            if let Ok(out) = Command::new(q)
                .args(["org.kde.KWin", "/KWin", "org.kde.KWin.activeOutputName"])
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .output()
            {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !s.is_empty() {
                    return Some(s);
                }
            }
        }
        None
    }

    /// Logical geometry (x, y, width, height) of the active output, read straight
    /// from KDE so it matches KWin's own coordinate space. `pos` is logical; `size`
    /// is physical, so logical size = size / scale.
    fn active_output_geometry() -> Option<(i32, i32, i32, i32)> {
        let name = active_output_name()?;
        let out = Command::new("kscreen-doctor")
            .arg("--json")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
        for o in v.get("outputs")?.as_array()? {
            if o.get("name").and_then(|n| n.as_str()) != Some(name.as_str()) {
                continue;
            }
            let pos = o.get("pos")?;
            let size = o.get("size")?;
            let scale = o.get("scale").and_then(|s| s.as_f64()).unwrap_or(1.0).max(0.1);
            let x = pos.get("x")?.as_i64()? as i32;
            let y = pos.get("y")?.as_i64()? as i32;
            let w = (size.get("width")?.as_f64()? / scale).round() as i32;
            let h = (size.get("height")?.as_f64()? / scale).round() as i32;
            return Some((x, y, w, h));
        }
        None
    }

    /// Top-left logical position to pin the chip at, on the active output — flush against the
    /// chosen edge. The top-left stays ON the output, which KWin honours: it silently DROPS a
    /// forced position whose top-left falls outside every output (so a negative/off-border
    /// anchor never applies). The resting inset and the edge-peek tuck are pure CSS in the
    /// webview (see Overlay.tsx), so the window itself never moves for the peek.
    pub fn chip_position(edge: &str, w: f64, h: f64) -> Option<(i32, i32)> {
        let (ox, oy, ow, oh) = active_output_geometry()?;
        let cw = w as i32;
        let ch = h as i32;
        let x = ox + ((ow - cw) / 2).max(0);
        let y = if edge == "bottom" {
            oy + (oh - ch).max(0)
        } else {
            oy
        };
        Some((x, y))
    }

    /// Write the position-independent rule body (strength 2 = "Force").
    fn write_rule_body(writer: &str) {
        let rule: &[(&str, &str)] = &[
            ("Description", "faster-whisper dictation chip"),
            ("title", super::CHIP_TITLE),
            ("titlematch", "1"),   // exact title match
            ("wmclassmatch", "0"), // ignore window class
            ("above", "true"),
            ("aboverule", "2"),
            ("skiptaskbar", "true"),
            ("skiptaskbarrule", "2"),
            ("skipswitcher", "true"),
            ("skipswitcherrule", "2"),
            ("skippager", "true"),
            ("skippagerrule", "2"),
            ("acceptfocus", "false"),
            ("acceptfocusrule", "2"),
        ];
        for (k, v) in rule {
            set_key(writer, GROUP, k, v);
        }
    }

    /// Install the chip rule (once) and force its position to `pos` (when known),
    /// reloading KWin only when something actually changed.
    pub fn place_chip(pos: Option<(i32, i32)>) {
        // Serialize: show_overlay spawns this on a thread, so two back-to-back shows (rapid stop→start
        // or a profile switch) would run two place_chip threads racing on the EXTERNAL kwinrulesrc
        // file — concurrent kwriteconfig6 read-modify-writes can lose an update and reconfigure() can
        // reload a half-written rule. The in-memory INSTALLED/LAST_POS guards don't cover the file.
        static PLACE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = PLACE_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        // Need both tools; if we can't read existing rules we must not rewrite the
        // `rules=` list, or we'd silently drop the user's other window rules.
        let Some((writer, reader)) = config_tools() else {
            return;
        };

        let mut need_reconfigure = false;

        if !INSTALLED.swap(true, Ordering::Relaxed) {
            merge_general(writer, reader, GROUP);
            write_rule_body(writer);
            need_reconfigure = true;
        }

        if let Some((x, y)) = pos {
            if let Ok(mut last) = LAST_POS.lock() {
                if *last != Some((x, y)) {
                    set_key(writer, GROUP, "position", &format!("{x},{y}"));
                    set_key(writer, GROUP, "positionrule", "2");
                    *last = Some((x, y));
                    need_reconfigure = true;
                }
            }
        }

        if need_reconfigure {
            reconfigure();
        }
    }
}
