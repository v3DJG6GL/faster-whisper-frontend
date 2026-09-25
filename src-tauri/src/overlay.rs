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
//!   * **Windows / Linux-X11** — `set_position` works, so the chip is centred at the top (or
//!     bottom). Keep-above comes from the window's `alwaysOnTop` config flag; on Windows tao
//!     asserts that only once, at creation, so `win_topmost` re-pins the chip on every show
//!     and a slow watchdog repairs it if Windows misplaces it later (see win_topmost.rs).
//!   * **KDE Wayland** — clients can't position themselves or force keep-above, so
//!     we install a small, reversible **KWin window rule** (matched on a unique,
//!     invisible chip title) that keeps the chip above, off the taskbar, and unable
//!     to steal focus, and forces its position. The position targets the *active*
//!     output (where the cursor / focused window is — `KWin.activeOutputName`), so
//!     on a multi-monitor desktop the chip follows you. See the `kwin` submodule.
//!   * **Other Wayland (GNOME)** — neither works; the chip is shown wherever the
//!     compositor puts it and the tray + sounds are the reliable status cue.

use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, Manager, PhysicalPosition, WebviewWindow};

/// Logical size declared for the `overlay` window in tauri.conf.json. The chip pill is
/// centred in this (transparent, click-through) strip and capped to it; widened so a full
/// readout (tag │ lang · mode │ stats │ target) plus up to ~6 quick-launch buttons fits
/// on one line without the last button being clipped.
const CHIP_W: f64 = 820.0;
const CHIP_H: f64 = 132.0;

/// "Chip size" (Settings → Chip): one factor for the whole chip. It is applied as the overlay
/// WEBVIEW'S ZOOM, so none of the chip's layout (pill height, edge inset, tuck offset) has to
/// know about it — and text is re-laid-out at the real size, so it stays crisp. The WINDOW
/// never resizes with it: it is always sized for the largest factor (see `window_size`), and
/// the chip — centred, anchored to the screen edge — just grows inside it. A per-step window
/// resize + re-centre can't be tweened (Wayland applies it instantly, and the KWin rule that
/// re-centres lands a beat later), which made the chip jump sideways while rescaling.
/// The one place the factor leaks out is the hit region: the webview reports CSS px, the
/// window systems want window-logical px (= CSS px × zoom) — see `set_chip_hit_region`.
const CHIP_SCALE_MIN: f64 = 0.75;
const CHIP_SCALE_MAX: f64 = 2.0;
/// f64 bits of the zoom the webview holds right now — mid-tween this is the in-between value,
/// so a hit region reported during the tween converts with the zoom it was measured at.
static CHIP_SCALE: AtomicU64 = AtomicU64::new(0x3FF0_0000_0000_0000);
/// f64 bits of the factor last requested for the window (0 = never), so a re-show with an
/// unchanged size touches nothing.
static APPLIED_SCALE: AtomicU64 = AtomicU64::new(0);
/// Bumped by every scale change; a running tween stops as soon as it is no longer the latest.
static SCALE_TWEEN_GEN: AtomicU64 = AtomicU64::new(0);
const SCALE_TWEEN_MS: f64 = 220.0;
const SCALE_TWEEN_STEP_MS: u64 = 16;

pub(crate) fn clamp_scale(s: f64) -> f64 {
    if s.is_finite() {
        s.clamp(CHIP_SCALE_MIN, CHIP_SCALE_MAX)
    } else {
        1.0
    }
}

fn chip_scale() -> f64 {
    f64::from_bits(CHIP_SCALE.load(Ordering::Relaxed))
}

/// Logical size of the overlay window: room for the chip at the LARGEST "Chip size", the
/// width capped to the monitor so it never hangs off both sides (the pill caps itself to
/// 100vw). Click-through outside the chip's hit region, so the spare room costs nothing.
fn window_size(monitor_logical_w: f64) -> (f64, f64) {
    (
        (CHIP_W * CHIP_SCALE_MAX).min(monitor_logical_w.max(1.0)),
        CHIP_H * CHIP_SCALE_MAX,
    )
}

/// Logical width of the monitor the chip lives on (unbounded when it can't be read).
fn monitor_logical_w(win: &WebviewWindow) -> f64 {
    crate::winpos::monitor_of(win)
        .map(|m| m.size().width as f64 / m.scale_factor())
        .unwrap_or(f64::MAX)
}

/// Push a changed factor into the webview zoom. No-op when unchanged. The first application
/// (and any while the chip is hidden) is set at once; a change on a visible chip is tweened —
/// short and monotonic (ease-out), one zoom step per frame — so dragging "Chip size" grows
/// the chip smoothly instead of snapping between steps.
fn apply_scale(win: &WebviewWindow, s: f64) {
    let prev = APPLIED_SCALE.swap(s.to_bits(), Ordering::Relaxed);
    if prev == s.to_bits() {
        return;
    }
    let gen = SCALE_TWEEN_GEN.fetch_add(1, Ordering::Relaxed) + 1;
    if prev == 0 || !win.is_visible().unwrap_or(false) {
        CHIP_SCALE.store(s.to_bits(), Ordering::Relaxed);
        let _ = win.set_zoom(s);
        return;
    }
    // From the zoom held NOW (a superseded tween's in-between value), so a drag never jumps back.
    let from = chip_scale();
    let win = win.clone();
    std::thread::spawn(move || {
        let start = std::time::Instant::now();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(SCALE_TWEEN_STEP_MS));
            if SCALE_TWEEN_GEN.load(Ordering::Relaxed) != gen {
                return;
            }
            let t = (start.elapsed().as_secs_f64() * 1000.0 / SCALE_TWEEN_MS).min(1.0);
            let z = from + (s - from) * (1.0 - (1.0 - t).powi(3));
            CHIP_SCALE.store(z.to_bits(), Ordering::Relaxed);
            let _ = win.set_zoom(z);
            if t >= 1.0 {
                return;
            }
        }
    });
}

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
    let Some(monitor) = crate::winpos::monitor_of(win) else {
        return;
    };

    let scale = monitor.scale_factor();
    let m_pos = monitor.position();
    let m_size = monitor.size();
    // The window's logical size (fixed — see `window_size`; width capped to the monitor).
    let (w, h) = window_size(m_size.width as f64 / scale);
    let chip_w = (w * scale) as i32;
    let chip_h = (h * scale) as i32;

    let x = m_pos.x + ((m_size.width as i32 - chip_w) / 2).max(0);
    let y = if edge == "bottom" {
        m_pos.y + m_size.height as i32 - chip_h
    } else {
        m_pos.y
    };
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

/// KDE-Wayland: pre-warm the chip's KWin placement rule at app startup, BEFORE the first
/// `show_overlay`. On the very first run the window otherwise maps UNRULED — KWin's default
/// placement centres it — and only snaps to its edge once `place_chip`'s detached thread
/// lands (hundreds of ms of external tool calls). On later runs the previous session's rule
/// persists in kwinrulesrc and already covers the first map, so this mainly fixes run one
/// (and a changed edge/monitor since last quit). Detached thread — the kwrite/dbus tools
/// can block (see `place_chip`'s comment); the show path never waits on this.
#[cfg(target_os = "linux")]
pub fn prewarm_chip_rule(cfg: &crate::config::Config) {
    use crate::config::IndicatorPosition;
    if !kwin::is_kde_wayland() {
        return;
    }
    let edge = match cfg.settings.recording.indicator_position {
        IndicatorPosition::Top => "top",
        IndicatorPosition::Bottom => "bottom",
        // Chip disabled: leave the user's kwinrulesrc untouched.
        IndicatorPosition::Off => return,
    };
    // (No monitor cap here — there is no window yet to ask; chip_position clamps x at 0.)
    let (w, h) = window_size(f64::MAX);
    std::thread::spawn(move || {
        kwin::place_chip(kwin::chip_position(edge, w, h));
    });
}

/// Show the chip at the requested edge ("top" | "bottom"), without focusing it. The window is
/// anchored flush against that edge; the resting inset and the edge-peek tuck are pure CSS
/// inside the webview (see Overlay.tsx). `scale` is the "Chip size" factor; absent = keep
/// the current one.
#[tauri::command]
pub fn show_overlay(app: AppHandle, position: String, scale: Option<f64>) {
    let Some(win) = app.get_webview_window("overlay") else {
        return;
    };
    if let Some(s) = scale {
        apply_scale(&win, clamp_scale(s));
    }
    // Size before position: the centring reads the window size.
    // Only when it differs (first show, or a move to a narrower monitor) — never per show.
    let (w, h) = window_size(monitor_logical_w(&win));
    static SIZED_W: AtomicU64 = AtomicU64::new(0);
    if SIZED_W.swap(w.to_bits(), Ordering::Relaxed) != w.to_bits() {
        let _ = win.set_size(tauri::LogicalSize::new(w, h));
    }
    self::position(&win, &position);
    let _ = win.set_always_on_top(true);

    #[cfg(target_os = "linux")]
    if kwin::is_kde_wayland() {
        let _ = win.set_title(CHIP_TITLE);
        crate::winvis::notify(&win, "overlay", true);
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
            kwin::place_chip(kwin::chip_position(&position, w, h));
        });
        return;
    }

    // On Windows, apply cursor pass-through BEFORE show: tao's
    // set_ignore_cursor_events adds WS_EX_LAYERED, and toggling that on an
    // already-visible window leaves a stale (white) composite until the next
    // SWP_FRAMECHANGED. The "must call after show" hazard (comment above) is
    // GTK/KDE-Wayland-only and does not apply on Windows.
    #[cfg(windows)]
    ignore_cursor(&win);

    crate::winvis::notify(&win, "overlay", true);
    let _ = win.show();

    #[cfg(not(windows))]
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
        // The set_always_on_top(true) above is a no-op here and show() never raises — this
        // is what actually puts the chip on top (never activating it). See win_topmost.rs.
        crate::win_topmost::assert_topmost(&win);
        win_hover::on_show(&app);
    }
}

/// Re-pin the chip if Windows has let an ordinary window above it. Cheap, and a no-op while
/// the chip is hidden or correctly ordered. Any thread (hops to the main thread).
#[cfg(windows)]
pub fn repair_topmost(app: &AppHandle) {
    if !win_hover::is_visible() {
        return;
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(win) = handle.get_webview_window("overlay") {
            crate::win_topmost::repair_if_covered(&win);
        }
    });
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

/// A changed "Chip size" on a chip that is already up: only the webview zoom moves (tweened),
/// the window stays put — no re-show, no re-place.
#[tauri::command]
pub fn set_overlay_scale(app: AppHandle, scale: f64) {
    if let Some(win) = app.get_webview_window("overlay") {
        apply_scale(&win, clamp_scale(scale));
    }
}

/// Hide the chip.
#[tauri::command]
pub fn hide_overlay(app: AppHandle) {
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.hide();
        crate::winvis::notify(&win, "overlay", false);
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
    // The webview measures in CSS px; with "Chip size" applied as webview zoom, one CSS px is
    // `zoom` window-logical px — the unit both the GDK input shape and the Windows cursor
    // poller work in. (The hover hold band is reported in CSS px too.)
    let s = chip_scale();
    let (x, y, w, h) = (x * s, y * s, w * s, h * s);
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
        tracing::debug!("[overlay] hit_region x={x:.0} y={y:.0} w={w:.0} h={h:.0} persist={persist} applied={applied}");
        // If not applied, the GdkWindow isn't realized yet — a later retry will get
        // it. We must NOT fall back to `set_ignore_cursor_events` here: on an
        // unrealized window tao does `window().unwrap()` and ABORTS the whole app
        // (the same hazard `show_overlay` documents). The window was already made
        // click-through at show time, so doing nothing is safe.
    }
    #[cfg(windows)]
    {
        let _ = &win;
        win_hover::set_region(&app, x, y, w, h, persist);
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
        let (under, x, y) = pointer.window_at_position();
        let toplevel_eq = under.as_ref().map(|w| w.toplevel() == gdk_win);
        tracing::debug!(
            "[overlay] pointer_over: under_some={} toplevel_eq={:?} at=({x:.0},{y:.0})",
            under.is_some(),
            toplevel_eq,
        );
        toplevel_eq == Some(true)
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
static LAST_HIT_REGION: std::sync::Mutex<Option<(f64, f64, f64, f64)>> =
    std::sync::Mutex::new(None);

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

/// Forward GDK-level pointer crossings on the overlay toplevel to the overlay webview as
/// `chip://pointer` (payload: is the cursor over the chip's hit region?). WebKitGTK's DOM
/// crossing events are NOT trustworthy here: when the tucked dot's tiny input region churns
/// quick enter/leave pairs (cursor micro-drift across a region edge), WebKit drops crossings
/// and is left believing the pointer never left — from then on genuine re-enters produce NO
/// `pointerenter` at all and the dot is dead to hovers. GDK's crossings come straight from
/// the compositor (observed correct throughout that failure), so the webview treats these
/// as the authoritative hover signal; its DOM handlers stay as a same-frame fast path (and
/// the only path on Windows, where win_hover polls the cursor instead).
#[cfg(target_os = "linux")]
fn install_crossing_forwarder(win: &WebviewWindow, gtk_win: &gtk::ApplicationWindow) {
    use gtk::prelude::{WidgetExt, WidgetExtManual};
    use tauri::{Emitter, Manager};
    static ONCE: std::sync::Once = std::sync::Once::new();
    let app = win.app_handle().clone();
    ONCE.call_once(move || {
        gtk_win.add_events(
            gtk::gdk::EventMask::ENTER_NOTIFY_MASK | gtk::gdk::EventMask::LEAVE_NOTIFY_MASK,
        );
        let enter_app = app.clone();
        gtk_win.connect_enter_notify_event(move |_, e| {
            // Grab/ungrab pseudo-crossings don't reflect real cursor travel — ignore them.
            if e.mode() == gtk::gdk::CrossingMode::Normal {
                tracing::debug!("[overlay] gdk enter at {:?}", e.position());
                let _ = enter_app.emit_to("overlay", "chip://pointer", true);
            }
            gtk::glib::Propagation::Proceed
        });
        // A leave of ANY mode means the cursor is no longer ours — always safe to clear.
        gtk_win.connect_leave_notify_event(move |_, e| {
            tracing::debug!(
                "[overlay] gdk leave mode={:?} at {:?}",
                e.mode(),
                e.position()
            );
            let _ = app.emit_to("overlay", "chip://pointer", false);
            gtk::glib::Propagation::Proceed
        });
    });
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
        // EXPECTED at startup: the webview reports the chip's bounds as soon as
        // it paints, which is before GTK realizes the overlay toplevel. The
        // caller does nothing and a later report applies the shape, so this is
        // a retry note, not a warning (it fired 5× per launch in the log view).
        tracing::debug!("[overlay] no GdkWindow yet (window not realized?)");
        return None;
    };
    install_crossing_forwarder(win, &gtk_win);
    let pad = 10.0;
    let rect = gtk::cairo::RectangleInt::new(
        (x - pad).floor() as i32,
        (y - pad).floor() as i32,
        (w + 2.0 * pad).ceil() as i32,
        (h + 2.0 * pad).ceil() as i32,
    );
    let region = gtk::cairo::Region::create_rectangle(&rect);
    gdk_win.input_shape_combine_region(&region, 0, 0);
    // A changed input region only reaches the compositor with the next surface COMMIT, and
    // nothing necessarily repaints right now (e.g. the enter-time full-window hover hold,
    // whose visuals change only after the dwell). Queue a redraw so the region goes live
    // within a frame — otherwise KWin keeps hit-testing the OLD region and a tiny tucked-dot
    // region stays in force, churning enter/leave on every micro-drift of the cursor.
    gtk_win.queue_draw();
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
    /// Mirror of the window's ACTUAL click-through state (= !ignore_cursor_events).
    /// Module-level, not a poller local: `show_overlay` forces
    /// `set_ignore_cursor_events(true)` on every (re)show, so the poller's belief
    /// must be reset with it — or a re-show while the cursor rests on the chip
    /// leaves `want == cached` and the chip permanently click-through. Linux's
    /// twin of this reset is `reapply_last_hit_region`.
    static INTERACTIVE: AtomicBool = AtomicBool::new(false);
    /// Latest webview-reported hit rect (window-logical px), INCLUDING transient
    /// persist=false hover holds, and the persistent rect a (re)show resets to —
    /// mirroring LAST_HIT_REGION's persist semantics on Linux.
    static REGION: Mutex<Option<(f64, f64, f64, f64)>> = Mutex::new(None);
    static PERSIST: Mutex<Option<(f64, f64, f64, f64)>> = Mutex::new(None);
    /// Window geometry (scale factor, outer x, outer y) cached at show / re-place time.
    /// `scale_factor` and `outer_position` are NOT cheap syscalls from the poller thread —
    /// each is a user message posted to the event loop plus a blocking channel read — and
    /// they only change when the chip is re-placed, so the 50 ms poll reads them from here
    /// and asks the event loop for the cursor position alone (three round-trips → one).
    static GEOM: Mutex<Option<(f64, i32, i32)>> = Mutex::new(None);

    /// Refresh the cached geometry from the window (main-thread or not — it is a one-off).
    fn refresh_geom(app: &AppHandle) {
        let Some(win) = app.get_webview_window("overlay") else {
            return;
        };
        if let (Ok(scale), Ok(pos)) = (win.scale_factor(), win.outer_position()) {
            if let Ok(mut g) = GEOM.lock() {
                *g = Some((scale, pos.x, pos.y));
            }
        }
    }

    pub fn set_region(app: &AppHandle, x: f64, y: f64, w: f64, h: f64, persist: bool) {
        refresh_geom(app);
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
        // show_overlay just called ignore_cursor() → the window IS click-through again.
        INTERACTIVE.store(false, Ordering::SeqCst);
        refresh_geom(app);
        VISIBLE.store(true, Ordering::SeqCst);
        if !POLLER.swap(true, Ordering::SeqCst) {
            let app = app.clone();
            if std::thread::Builder::new()
                .name("chip-hover-poll".into())
                .spawn(move || run(app))
                .is_err()
            {
                POLLER.store(false, Ordering::SeqCst);
            }
        }
    }

    pub fn on_hide() {
        VISIBLE.store(false, Ordering::SeqCst);
    }

    pub fn is_visible() -> bool {
        VISIBLE.load(Ordering::SeqCst)
    }

    /// Visible ticks between topmost checks: 40 × 50 ms ≈ 2 s. Slow on purpose — the check
    /// only ever repairs a verified-wrong z-order (win_topmost.rs), so there is nothing to
    /// gain from racing, and two eager always-on-top apps would flicker against each other.
    const TOPMOST_EVERY: u32 = 40;

    fn run(app: AppHandle) {
        let mut ticks: u32 = 0;
        loop {
            // Sample VISIBLE for the sleep cadence, then re-read AFTER waking so the
            // hover decision uses the current state, not one up to 250 ms stale.
            let visible = VISIBLE.load(Ordering::SeqCst);
            // 50 ms tracks hover-enter/leave comfortably; the per-tick cost is one
            // event-loop round-trip (cursor position — the geometry is cached, see GEOM).
            // Idle slowly while hidden.
            std::thread::sleep(std::time::Duration::from_millis(if visible {
                50
            } else {
                250
            }));
            let visible = VISIBLE.load(Ordering::SeqCst);
            if visible {
                ticks = ticks.wrapping_add(1);
                if ticks.is_multiple_of(TOPMOST_EVERY) {
                    #[cfg(windows)]
                    super::repair_topmost(&app);
                }
            }
            let want = visible && cursor_in_chip(&app).unwrap_or(false);
            if want != INTERACTIVE.load(Ordering::SeqCst) {
                INTERACTIVE.store(want, Ordering::SeqCst);
                // Window mutations go through the main thread, matching the rest of
                // the codebase (show_overlay's own GTK-hazard note).
                let handle = app.clone();
                if app
                    .run_on_main_thread(move || {
                        if let Some(win) = handle.get_webview_window("overlay") {
                            let _ = win.set_ignore_cursor_events(!want);
                        }
                    })
                    .is_err()
                {
                    // The hop never ran, so the window state did not change —
                    // un-lie the flag instead of leaving it permanently desynced.
                    INTERACTIVE.store(!want, Ordering::SeqCst);
                }
            }
        }
    }

    /// Is the global cursor inside the chip rect? Webview-logical rect → physical px
    /// (same 10 px forgiveness pad as the GDK shape). `None` = no confident answer (no rect
    /// yet, or a getter failed); each caller picks its own safe default — the hover poller
    /// reads it as "outside" (stay click-through), `chip_pointer_over` reads it as "inside"
    /// (fail OPEN: it is a cancellation signal, and a query hiccup must not break a hover).
    pub fn cursor_in_chip(app: &AppHandle) -> Option<bool> {
        let (x, y, w, h) = (*REGION.lock().ok()?)?;
        let cur = app.cursor_position().ok()?;
        let cached_geom = *GEOM.lock().ok()?;
        let (scale, px, py) = match cached_geom {
            Some(g) => g,
            None => {
                let win = app.get_webview_window("overlay")?;
                let pos = win.outer_position().ok()?;
                let fetched = (win.scale_factor().ok()?, pos.x, pos.y);
                if let Ok(mut g) = GEOM.lock() {
                    *g = Some(fetched);
                }
                fetched
            }
        };
        let pad = 10.0 * scale;
        let rx = px as f64 + x * scale - pad;
        let ry = py as f64 + y * scale - pad;
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
    pub use crate::kwin::is_kde_wayland;
    use crate::kwin::{config_tools, merge_general, reconfigure, set_key};

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
            let scale = o
                .get("scale")
                .and_then(|s| s.as_f64())
                .unwrap_or(1.0)
                .max(0.1);
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
