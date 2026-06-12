//! Direct Unicode text typing on Linux Wayland via the XDG RemoteDesktop portal.
//!
//! enigo's X11/XTEST text path can't type arbitrary Unicode into native-Wayland
//! windows (KWin's XWayland doesn't honor the keycode remapping), so on Wayland we
//! type each character as a Unicode keysym (`0x01000000 | codepoint`) through the
//! portal, which KWin resolves itself via `NotifyKeyboardKeysym` (no libei/EIS).
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
    use std::path::PathBuf;
    use std::time::Duration;
    use tauri::{AppHandle, Manager};

    const KEYSYM_RETURN: i32 = 0xFF0D;
    const KEYSYM_SHIFT_L: i32 = 0xFFE1;

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

    /// Map a character to a (base keysym, needs_shift) pair. We hold Shift
    /// ourselves around the *unshifted* keysym rather than sending the shifted
    /// keysym directly — KWin's auto-shift handling desyncs by one event. Letters
    /// are layout-independent (Shift + lowercase = uppercase); German umlauts use
    /// the lowercase Latin-1 keysym + Shift for the capital. Other Latin-1 chars
    /// pass through bare; higher codepoints use the Unicode keysym range.
    fn char_to_key(c: char) -> (i32, bool) {
        match c {
            '\n' | '\r' => (KEYSYM_RETURN, false),
            '\t' => (0xFF09, false),
            'A'..='Z' => (c.to_ascii_lowercase() as i32, true),
            'Ä' => (0xE4, true),
            'Ö' => (0xF6, true),
            'Ü' => (0xFC, true),
            c if (c as u32) <= 0xFF => (c as i32, false),
            c => ((0x0100_0000_u32 | c as u32) as i32, false),
        }
    }

    pub async fn type_text(
        app: &AppHandle,
        state: &WaylandTokenState,
        text: &str,
        auto_enter: bool,
    ) -> Result<(), String> {
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

        for c in text.chars() {
            let (ks, shift) = char_to_key(c);
            if shift {
                proxy
                    .notify_keyboard_keysym(&session, KEYSYM_SHIFT_L, KeyState::Pressed, Default::default())
                    .await
                    .map_err(|e| e.to_string())?;
                tokio::time::sleep(Duration::from_millis(6)).await;
            }
            proxy
                .notify_keyboard_keysym(&session, ks, KeyState::Pressed, Default::default())
                .await
                .map_err(|e| e.to_string())?;
            tokio::time::sleep(Duration::from_millis(6)).await;
            proxy
                .notify_keyboard_keysym(&session, ks, KeyState::Released, Default::default())
                .await
                .map_err(|e| e.to_string())?;
            if shift {
                tokio::time::sleep(Duration::from_millis(6)).await;
                proxy
                    .notify_keyboard_keysym(&session, KEYSYM_SHIFT_L, KeyState::Released, Default::default())
                    .await
                    .map_err(|e| e.to_string())?;
            }
            tokio::time::sleep(Duration::from_millis(8)).await;
        }

        if auto_enter {
            proxy
                .notify_keyboard_keysym(&session, KEYSYM_RETURN, KeyState::Pressed, Default::default())
                .await
                .map_err(|e| e.to_string())?;
            proxy
                .notify_keyboard_keysym(&session, KEYSYM_RETURN, KeyState::Released, Default::default())
                .await
                .map_err(|e| e.to_string())?;
        }
        // Keep the session alive briefly so KWin finishes processing the queued
        // events before we drop it (dropping closes the session immediately).
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
