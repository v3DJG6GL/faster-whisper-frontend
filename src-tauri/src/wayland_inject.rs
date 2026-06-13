//! Layout-correct text typing on Linux Wayland via the XDG RemoteDesktop portal.
//!
//! enigo's X11/XTEST text path can't type into native-Wayland windows, and sending
//! keysyms lets KWin pick a mismatched keymap (wrong symbols / y↔z). Instead we
//! read the machine's **active** XKB layout (`setxkbmap -query`), build that keymap
//! with libxkbcommon, look up the exact `(keycode, Shift/AltGr)` that produces each
//! character on it, and inject those **keycodes** via `NotifyKeyboardKeycode`. The
//! focused app interprets the keycode with the same layout, so every character —
//! `!`, `y`/`z`, AltGr symbols — comes out right, on any layout (CH-de, FR, US, …).
//!
//! The portal session is opened **once** and reused for the whole app run by a
//! dedicated typer task: creating a fresh session per dictated segment makes KDE
//! re-prompt ("Konsole is asking … Control input devices") on every utterance,
//! because a restore_token can't be relied on (in `tauri dev` the binary has no
//! stable app-id). One session ⇒ at most one consent dialog per run.

use tokio::sync::{mpsc, oneshot, Mutex};

/// One typing request handed to the persistent typer task: type `text`, then an
/// optional Enter; `reply` carries the result back to the awaiting command.
pub struct Job {
    text: String, // characters to type (empty for a paste chord)
    paste: bool,  // true → synthesize Ctrl+V instead of typing `text`
    auto_enter: bool,
    reply: oneshot::Sender<Result<(), String>>,
}

/// Sender to the persistent RemoteDesktop typer task (started lazily on the first
/// direct-typing injection). Reusing one portal session across utterances is what
/// stops KDE from re-prompting for "Control input devices" on every segment.
#[derive(Default)]
pub struct WaylandTyper(pub Mutex<Option<mpsc::Sender<Job>>>);

#[cfg(target_os = "linux")]
mod imp {
    use super::{Job, WaylandTyper};
    use ashpd::desktop::{
        remote_desktop::{DeviceType, KeyState, RemoteDesktop, SelectDevicesOptions},
        PersistMode,
    };
    use ashpd::enumflags2::BitFlags;
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::Duration;
    use tauri::{AppHandle, Manager};
    use tokio::sync::{mpsc, oneshot};
    use xkbcommon::xkb;

    // evdev key codes (Linux input-event-codes), which the portal expects.
    const EVDEV_OFFSET: u32 = 8; // xkb keycode = evdev code + 8
    const KEY_TAB: i32 = 15;
    const KEY_ENTER: i32 = 28;
    const KEY_LEFTCTRL: i32 = 29;
    const KEY_LEFTSHIFT: i32 = 42;
    const KEY_V: i32 = 47;
    const KEY_RIGHTALT: i32 = 100; // AltGr / ISO_Level3_Shift

    #[derive(Clone, Copy)]
    struct KeySpec {
        keycode: i32,
        shift: bool,
        altgr: bool,
    }

    fn token_path(app: &AppHandle) -> Option<PathBuf> {
        app.path()
            .app_config_dir()
            .ok()
            .map(|d| d.join("wayland-restore.token"))
    }

    fn load_token(app: &AppHandle) -> Option<String> {
        let p = token_path(app)?;
        std::fs::read_to_string(p)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }

    fn save_token(app: &AppHandle, token: &str) {
        if let Some(p) = token_path(app) {
            if let Some(dir) = p.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(p, token);
        }
    }

    /// The machine's active XKB layout (rules, model, layout, variant), via
    /// `setxkbmap -query` (KWin keeps XWayland in sync with the Wayland layout).
    fn query_layout() -> (String, String, String, String) {
        let mut rules = "evdev".to_string();
        let mut model = "pc105".to_string();
        let mut layout = "us".to_string();
        let mut variant = String::new();
        if let Ok(out) = Command::new("setxkbmap").arg("-query").output() {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                if let Some(v) = line.strip_prefix("rules:") {
                    rules = v.trim().to_string();
                } else if let Some(v) = line.strip_prefix("model:") {
                    model = v.trim().to_string();
                } else if let Some(v) = line.strip_prefix("layout:") {
                    layout = v.trim().to_string();
                } else if let Some(v) = line.strip_prefix("variant:") {
                    variant = v.trim().to_string();
                }
            }
        }
        (rules, model, layout, variant)
    }

    /// Build a character → (keycode, modifiers) map for the active layout.
    fn build_charmap() -> Option<HashMap<char, KeySpec>> {
        let (rules, model, layout, variant) = query_layout();
        let ctx = xkb::Context::new(xkb::CONTEXT_NO_FLAGS);
        let keymap = xkb::Keymap::new_from_names(
            &ctx,
            &rules,
            &model,
            &layout,
            &variant,
            None,
            xkb::KEYMAP_COMPILE_NO_FLAGS,
        )?;

        let mut map: HashMap<char, KeySpec> = HashMap::new();
        for kc in keymap.min_keycode().raw()..=keymap.max_keycode().raw() {
            let key = xkb::Keycode::new(kc);
            if keymap.num_layouts_for_key(key) == 0 {
                continue;
            }
            let levels = keymap.num_levels_for_key(key, 0);
            for level in 0..levels {
                for sym in keymap.key_get_syms_by_level(key, 0, level) {
                    let cp = xkb::keysym_to_utf32(*sym);
                    if cp == 0 {
                        continue;
                    }
                    if let Some(ch) = char::from_u32(cp) {
                        if ch.is_control() {
                            continue;
                        }
                        // First (lowest-level) occurrence wins.
                        map.entry(ch).or_insert(KeySpec {
                            keycode: (kc - EVDEV_OFFSET) as i32,
                            shift: level == 1 || level == 3,
                            altgr: level == 2 || level == 3,
                        });
                    }
                }
            }
        }
        Some(map)
    }

    fn key_spec_for(c: char, map: &HashMap<char, KeySpec>) -> Option<KeySpec> {
        match c {
            '\n' | '\r' => Some(KeySpec { keycode: KEY_ENTER, shift: false, altgr: false }),
            '\t' => Some(KeySpec { keycode: KEY_TAB, shift: false, altgr: false }),
            _ => map.get(&c).copied(),
        }
    }

    /// Type `text` character-by-character (layout-correct keycodes).
    pub async fn type_text(
        app: &AppHandle,
        typer: &WaylandTyper,
        text: &str,
        auto_enter: bool,
    ) -> Result<(), String> {
        submit(app, typer, text.to_string(), false, auto_enter).await
    }

    /// Synthesize Ctrl+V on the shared session (the caller has already set the
    /// clipboard). Raw keycodes via the portal — reliable on Wayland, where enigo's
    /// XTEST Ctrl+V mis-fires into the wrong shortcut (e.g. opening editor tabs).
    pub async fn paste(
        app: &AppHandle,
        typer: &WaylandTyper,
        auto_enter: bool,
    ) -> Result<(), String> {
        submit(app, typer, String::new(), true, auto_enter).await
    }

    /// Queue a job for the persistent typer, starting the task (one consent dialog)
    /// on first use, and await its completion.
    async fn submit(
        app: &AppHandle,
        typer: &WaylandTyper,
        text: String,
        paste: bool,
        auto_enter: bool,
    ) -> Result<(), String> {
        let tx = {
            let mut guard = typer.0.lock().await;
            let alive = matches!(guard.as_ref(), Some(tx) if !tx.is_closed());
            if !alive {
                let (tx, rx) = mpsc::channel::<Job>(16);
                let app2 = app.clone();
                tauri::async_runtime::spawn(async move { run_session(app2, rx).await });
                *guard = Some(tx);
            }
            guard.as_ref().unwrap().clone()
        };
        let (reply, reply_rx) = oneshot::channel();
        tx.send(Job { text, paste, auto_enter, reply })
            .await
            .map_err(|_| "wayland typer unavailable".to_string())?;
        reply_rx
            .await
            .map_err(|_| "wayland typer dropped the job".to_string())?
    }

    async fn run_session(app: AppHandle, rx: mpsc::Receiver<Job>) {
        if let Err(e) = session_loop(&app, rx).await {
            tracing::warn!("[wayland-inject] portal session closed: {e}");
        }
    }

    /// Own one RemoteDesktop session for the task's lifetime and serve typing jobs
    /// on it. Returns (ending the task) when the channel closes or the session
    /// dies — `type_text` then restarts it on the next request.
    async fn session_loop(app: &AppHandle, mut rx: mpsc::Receiver<Job>) -> Result<(), String> {
        let charmap = build_charmap().ok_or("could not build a keymap for the active layout")?;
        let token = load_token(app);

        let proxy = RemoteDesktop::new().await.map_err(|e| e.to_string())?;
        let session = proxy
            .create_session(Default::default())
            .await
            .map_err(|e| e.to_string())?;
        let opts = SelectDevicesOptions::default()
            .set_devices(BitFlags::from(DeviceType::Keyboard))
            .set_persist_mode(PersistMode::ExplicitlyRevoked)
            .set_restore_token(token.as_deref());
        proxy
            .select_devices(&session, opts)
            .await
            .map_err(|e| e.to_string())?;
        let selected = proxy
            .start(&session, None, Default::default())
            .await
            .map_err(|e| e.to_string())?
            .response()
            .map_err(|e| e.to_string())?;
        if let Some(new_token) = selected.restore_token() {
            save_token(app, new_token);
        }
        tracing::info!("[wayland-inject] persistent portal session ready");

        while let Some(job) = rx.recv().await {
            // Every keycode we press is recorded here so we can GUARANTEE a matching
            // release even if a portal call fails mid-chord. Without this, a failure
            // after `Ctrl↓`/`Shift↓` leaves that modifier logically DOWN system-wide
            // and wedges the desktop (clicks/drag/selection break) until a VT switch.
            let mut held: Vec<i32> = Vec::new();

            // `press!`/`release!` mirror the shared session and keep `held` in sync.
            // Both use `?`, so a failure bails out of the inner block — after which
            // the cleanup below releases whatever is still held.
            let res: Result<(), String> = async {
                macro_rules! press {
                    ($code:expr) => {{
                        let code: i32 = $code;
                        proxy
                            .notify_keyboard_keycode(&session, code, KeyState::Pressed, Default::default())
                            .await
                            .map_err(|e| e.to_string())?;
                        held.push(code);
                    }};
                }
                macro_rules! release {
                    ($code:expr) => {{
                        let code: i32 = $code;
                        proxy
                            .notify_keyboard_keycode(&session, code, KeyState::Released, Default::default())
                            .await
                            .map_err(|e| e.to_string())?;
                        if let Some(i) = held.iter().rposition(|&c| c == code) {
                            held.remove(i);
                        }
                    }};
                }

                if job.paste {
                    // Ctrl+V as raw keycodes (layout-independent).
                    press!(KEY_LEFTCTRL);
                    tokio::time::sleep(Duration::from_millis(6)).await;
                    press!(KEY_V);
                    tokio::time::sleep(Duration::from_millis(4)).await;
                    release!(KEY_V);
                    tokio::time::sleep(Duration::from_millis(6)).await;
                    release!(KEY_LEFTCTRL);
                    if job.auto_enter {
                        tokio::time::sleep(Duration::from_millis(6)).await;
                        press!(KEY_ENTER);
                        release!(KEY_ENTER);
                    }
                    tokio::time::sleep(Duration::from_millis(40)).await;
                    return Ok(());
                }
                for c in job.text.chars() {
                    let Some(spec) = key_spec_for(c, &charmap) else {
                        continue; // char not reachable on this layout — skip
                    };
                    if spec.shift {
                        press!(KEY_LEFTSHIFT);
                        tokio::time::sleep(Duration::from_millis(4)).await;
                    }
                    if spec.altgr {
                        press!(KEY_RIGHTALT);
                        tokio::time::sleep(Duration::from_millis(4)).await;
                    }
                    press!(spec.keycode);
                    tokio::time::sleep(Duration::from_millis(4)).await;
                    release!(spec.keycode);
                    if spec.altgr {
                        tokio::time::sleep(Duration::from_millis(4)).await;
                        release!(KEY_RIGHTALT);
                    }
                    if spec.shift {
                        tokio::time::sleep(Duration::from_millis(4)).await;
                        release!(KEY_LEFTSHIFT);
                    }
                    tokio::time::sleep(Duration::from_millis(6)).await;
                }
                if job.auto_enter {
                    press!(KEY_ENTER);
                    release!(KEY_ENTER);
                }
                // Let KWin process the queued events before the caller proceeds.
                tokio::time::sleep(Duration::from_millis(40)).await;
                Ok(())
            }
            .await;

            // GUARANTEED cleanup: release anything still held (an error bailed out
            // mid-chord). Best-effort — release in reverse press order, ignoring
            // errors since we're already reporting the real failure.
            for code in held.iter().rev() {
                let _ = proxy
                    .notify_keyboard_keycode(&session, *code, KeyState::Released, Default::default())
                    .await;
            }

            let failed = res.is_err();
            let _ = job.reply.send(res);
            if failed {
                // A keycode error means the session is gone (revoked / compositor
                // closed it). End the task so the next request re-creates it
                // (one fresh prompt) instead of failing every later segment.
                return Err("keycode injection failed (session likely revoked)".into());
            }
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
pub use imp::{paste, type_text};

#[cfg(not(target_os = "linux"))]
pub async fn type_text(
    _app: &tauri::AppHandle,
    _typer: &WaylandTyper,
    _text: &str,
    _auto_enter: bool,
) -> Result<(), String> {
    Err("Wayland text injection is only available on Linux".into())
}

#[cfg(not(target_os = "linux"))]
pub async fn paste(
    _app: &tauri::AppHandle,
    _typer: &WaylandTyper,
    _auto_enter: bool,
) -> Result<(), String> {
    Err("Wayland text injection is only available on Linux".into())
}
