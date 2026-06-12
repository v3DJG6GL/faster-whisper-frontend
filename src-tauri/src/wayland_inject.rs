//! Layout-correct text typing on Linux Wayland via the XDG RemoteDesktop portal.
//!
//! enigo's X11/XTEST text path can't type into native-Wayland windows, and sending
//! keysyms lets KWin pick a mismatched keymap (wrong symbols / y↔z). Instead we
//! read the machine's **active** XKB layout (`setxkbmap -query`), build that keymap
//! with libxkbcommon, look up the exact `(keycode, Shift/AltGr)` that produces each
//! character on it, and inject those **keycodes** via `NotifyKeyboardKeycode`. The
//! focused app interprets the keycode with the same layout, so every character —
//! `!`, `y`/`z`, AltGr symbols — comes out right, on any layout (CH-de, FR, US, …).
//! A persisted `restore_token` skips the consent dialog after the first grant.

use tauri::AppHandle;
use tokio::sync::Mutex;

/// In-memory cache of the portal restore-token (mirrored to disk).
#[derive(Default)]
pub struct WaylandTokenState(pub Mutex<Option<String>>);

#[cfg(target_os = "linux")]
mod imp {
    use super::WaylandTokenState;
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
    use xkbcommon::xkb;

    // evdev key codes (Linux input-event-codes), which the portal expects.
    const EVDEV_OFFSET: u32 = 8; // xkb keycode = evdev code + 8
    const KEY_TAB: i32 = 15;
    const KEY_ENTER: i32 = 28;
    const KEY_LEFTSHIFT: i32 = 42;
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

    pub async fn type_text(
        app: &AppHandle,
        state: &WaylandTokenState,
        text: &str,
        auto_enter: bool,
    ) -> Result<(), String> {
        let charmap = build_charmap().ok_or("could not build a keymap for the active layout")?;

        // Seed the in-memory token from disk on first use.
        {
            let mut guard = state.0.lock().await;
            if guard.is_none() {
                *guard = load_token(app);
            }
        }
        let token = state.0.lock().await.clone();

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
            *state.0.lock().await = Some(new_token.to_string());
        }

        // Inject one key event at a time. `kc!` sends a keycode press/release.
        macro_rules! kc {
            ($code:expr, $state:expr) => {
                proxy
                    .notify_keyboard_keycode(&session, $code, $state, Default::default())
                    .await
                    .map_err(|e| e.to_string())?
            };
        }

        for c in text.chars() {
            let Some(spec) = key_spec_for(c, &charmap) else {
                continue; // char not reachable on this layout — skip
            };
            if spec.shift {
                kc!(KEY_LEFTSHIFT, KeyState::Pressed);
                tokio::time::sleep(Duration::from_millis(4)).await;
            }
            if spec.altgr {
                kc!(KEY_RIGHTALT, KeyState::Pressed);
                tokio::time::sleep(Duration::from_millis(4)).await;
            }
            kc!(spec.keycode, KeyState::Pressed);
            tokio::time::sleep(Duration::from_millis(4)).await;
            kc!(spec.keycode, KeyState::Released);
            if spec.altgr {
                tokio::time::sleep(Duration::from_millis(4)).await;
                kc!(KEY_RIGHTALT, KeyState::Released);
            }
            if spec.shift {
                tokio::time::sleep(Duration::from_millis(4)).await;
                kc!(KEY_LEFTSHIFT, KeyState::Released);
            }
            tokio::time::sleep(Duration::from_millis(6)).await;
        }

        if auto_enter {
            kc!(KEY_ENTER, KeyState::Pressed);
            kc!(KEY_ENTER, KeyState::Released);
        }

        // Keep the session alive briefly so KWin processes the queued events
        // before we drop it (dropping closes the session immediately).
        tokio::time::sleep(Duration::from_millis(120)).await;
        Ok(())
    }
}

#[cfg(target_os = "linux")]
pub async fn type_text(
    app: &AppHandle,
    state: &WaylandTokenState,
    text: &str,
    auto_enter: bool,
) -> Result<(), String> {
    imp::type_text(app, state, text, auto_enter).await
}

#[cfg(not(target_os = "linux"))]
pub async fn type_text(
    _app: &AppHandle,
    _state: &WaylandTokenState,
    _text: &str,
    _auto_enter: bool,
) -> Result<(), String> {
    Err("Wayland text injection is only available on Linux".into())
}
