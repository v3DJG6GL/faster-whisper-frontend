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
    paste: bool,  // true → synthesize the paste chord instead of typing `text`
    // The paste chord as KeyboardEvent.code strings (modifiers first, main key last) — NOT pre-resolved
    // keycodes — so the MAIN letter key is resolved by KEYSYM against the active layout's charmap inside
    // session_loop (where the charmap is built). A fixed physical position would mis-paste on a layout
    // whose physical V position isn't keysym 'v' (Dvorak/Colemak/Bepo).
    chord_codes: Vec<String>,
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
    const KEY_CAPSLOCK: i32 = 58;
    const KEY_V: i32 = 47;
    const KEY_RIGHTALT: i32 = 100; // AltGr / ISO_Level3_Shift

    #[derive(Clone, Copy)]
    struct KeySpec {
        keycode: i32,
        shift: bool,
        altgr: bool,
        /// The capital is reachable ONLY via Caps Lock, not Shift — e.g. Swiss-German Ü/Ä/Ö,
        /// whose keys use the XKB `FOUR_LEVEL` type (Shift gives è/à/é, and Lock isn't in the
        /// type's modifiers, so KWin capitalizes the lowercase keysym under Caps Lock). The
        /// typer brackets such a keypress with a Caps Lock toggle. See `build_charmap`.
        lock: bool,
        /// Does this key's Shift level produce the base glyph's case-inverse (a normal A–Z key)?
        /// When a live Caps Lock capitalizes alphabetic output, the typer cancels it by pressing
        /// Shift — but that only recovers the intended glyph on a case-pair key. On a FOUR_LEVEL key
        /// (ü, where Shift→è) pressing Shift selects the WRONG glyph, so for `caps_safe == false`
        /// the typer flips Caps OFF for the press instead. See the live-Caps branch in the typer.
        caps_safe: bool,
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
            // Only the 4 standard levels are encoded below (none / Shift / AltGr / Shift+AltGr).
            // Cap the scan: an ISO_Level5 layout (Neo, intl-extended) exposes 6-8 levels, and a
            // glyph reachable ONLY at level 4+ would be registered as `shift=false, altgr=false`
            // — a bare keypress that types that key's LEVEL-0 glyph instead. Leaving such glyphs
            // out of the map makes them fall back to the portal path rather than mis-type.
            let levels = keymap.num_levels_for_key(key, 0).min(4);
            let caps_safe = key_is_caps_safe(&keymap, key);
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
                            lock: false,
                            caps_safe,
                        });
                    }
                }
            }
        }

        // Second pass: capitals NOT directly on any level. On layouts like Swiss-German
        // (ch/de_nodeadkeys) the ü/ä/ö keys are XKB type `FOUR_LEVEL` — Shift yields è/à/é, and
        // the type doesn't consume Lock, so the capital Ü/Ä/Ö (and È/É/À) exists only because
        // KWin capitalizes the lowercase keysym while Caps Lock is on. The level scan above can't
        // see those, so each typed capital would be silently dropped. Recover them: for every
        // lowercase char we DID map, register its uppercase (if not already reachable) on the same
        // key with a `lock` flag — the typer presses it with Caps Lock toggled on for that key.
        let extras: Vec<(char, KeySpec)> = map
            .iter()
            .filter_map(|(&ch, &spec)| {
                if !ch.is_lowercase() {
                    return None;
                }
                let up: Vec<char> = ch.to_uppercase().collect();
                // Skip multi-char expansions (e.g. ß → "SS") — no single keypress produces those.
                if up.len() != 1 {
                    return None;
                }
                let u = up[0];
                if u == ch || map.contains_key(&u) {
                    return None; // capital already typeable via Shift (normal A–Z) — leave it.
                }
                Some((u, KeySpec { lock: true, ..spec }))
            })
            .collect();
        for (u, spec) in extras {
            map.entry(u).or_insert(spec);
        }
        Some(map)
    }

    fn key_spec_for(c: char, map: &HashMap<char, KeySpec>) -> Option<KeySpec> {
        match c {
            '\n' | '\r' => Some(KeySpec { keycode: KEY_ENTER, shift: false, altgr: false, lock: false, caps_safe: true }),
            '\t' => Some(KeySpec { keycode: KEY_TAB, shift: false, altgr: false, lock: false, caps_safe: true }),
            _ => map.get(&c).copied(),
        }
    }

    /// Is this key a normal case-pair (its Shift level is the case-inverse of its base glyph)? Used so
    /// the live-Caps-Lock compensation knows whether pressing Shift actually cancels KWin's
    /// capitalization. A non-alphabetic base (digits, symbols) is unaffected by Caps → safe. A
    /// FOUR_LEVEL letter key (Swiss-German ü, whose Shift gives è — NOT Ü) is NOT safe.
    fn key_is_caps_safe(keymap: &xkb::Keymap, key: xkb::Keycode) -> bool {
        let base = keymap
            .key_get_syms_by_level(key, 0, 0)
            .iter()
            .filter_map(|s| char::from_u32(xkb::keysym_to_utf32(*s)))
            .find(|c| c.is_alphabetic());
        let Some(base) = base.filter(|c| c.is_lowercase()) else {
            return true; // non-alphabetic (or already-uppercase) base → Caps doesn't mis-map it
        };
        let upper: Vec<char> = base.to_uppercase().collect();
        if upper.len() != 1 {
            return true; // multi-char expansion (e.g. ß) → leave to the normal/lock paths
        }
        // Safe iff the Shift (level 1) glyph IS that uppercase — the A–Z case-pair shape.
        keymap
            .key_get_syms_by_level(key, 0, 1)
            .iter()
            .filter_map(|s| char::from_u32(xkb::keysym_to_utf32(*s)))
            .any(|u| u == upper[0])
    }

    /// Is Caps Lock currently on? Read from the keyboard's `capslock` LED in sysfs —
    /// works on native Wayland without X, and reflects the compositor's lock state
    /// (KWin drives the hardware LED). We need it because the portal injects raw
    /// keycodes that KWin resolves under the LIVE Caps Lock, while our charmap only
    /// models Shift/AltGr. Best-effort: if no capslock LED is exposed, assume off.
    fn caps_lock_on() -> bool {
        let Ok(entries) = std::fs::read_dir("/sys/class/leds") else {
            return false;
        };
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().contains("capslock") {
                if let Ok(v) = std::fs::read_to_string(entry.path().join("brightness")) {
                    if v.trim().parse::<u32>().map(|n| n > 0).unwrap_or(false) {
                        return true;
                    }
                }
            }
        }
        false
    }

    /// Type `text` character-by-character (layout-correct keycodes).
    pub async fn type_text(
        app: &AppHandle,
        typer: &WaylandTyper,
        text: &str,
        auto_enter: bool,
    ) -> Result<(), String> {
        submit(app, typer, text.to_string(), false, Vec::new(), auto_enter).await
    }

    /// Synthesize Ctrl+V on the shared session (the caller has already set the
    /// clipboard). Raw keycodes via the portal — reliable on Wayland, where enigo's
    /// XTEST Ctrl+V mis-fires into the wrong shortcut (e.g. opening editor tabs).
    pub async fn paste(
        app: &AppHandle,
        typer: &WaylandTyper,
        chord_codes: Vec<String>,
        auto_enter: bool,
    ) -> Result<(), String> {
        submit(app, typer, String::new(), true, chord_codes, auto_enter).await
    }

    fn is_modifier_code(code: &str) -> bool {
        matches!(
            code,
            "ControlLeft" | "ControlRight" | "ShiftLeft" | "ShiftRight"
                | "AltLeft" | "AltRight" | "MetaLeft" | "MetaRight" | "OSLeft" | "OSRight"
        )
    }
    fn code_to_keycode(code: &str) -> Option<i32> {
        Some(match code {
            "ControlLeft" => KEY_LEFTCTRL,
            "ControlRight" => 97,
            "ShiftLeft" => KEY_LEFTSHIFT,
            "ShiftRight" => 54,
            "AltLeft" => 56,
            "AltRight" => KEY_RIGHTALT,
            "MetaLeft" | "OSLeft" => 125,
            "MetaRight" | "OSRight" => 126,
            "KeyV" => KEY_V,
            "Insert" => 110,
            // Any other letter (KeyA..KeyZ) so a custom paste shortcut whose main key isn't V/Insert
            // is honored on Wayland too — the X11 path (inject.rs code_to_enigo) already maps all
            // letters, so without this the configured key was silently dropped to a Ctrl+V fallback.
            _ => return letter_keycode(code),
        })
    }

    /// evdev keycode for a single-letter `KeyboardEvent.code` (KeyA..KeyZ). Physical-position Linux
    /// input-event-codes (NOT alphabetical), mirroring evdev_hotkeys::imp::letter_key and the KEY_V
    /// const above (V == 47).
    fn letter_keycode(code: &str) -> Option<i32> {
        let letter = code.strip_prefix("Key").filter(|s| s.len() == 1)?;
        Some(match letter {
            "Q" => 16, "W" => 17, "E" => 18, "R" => 19, "T" => 20, "Y" => 21, "U" => 22,
            "I" => 23, "O" => 24, "P" => 25, "A" => 30, "S" => 31, "D" => 32, "F" => 33,
            "G" => 34, "H" => 35, "J" => 36, "K" => 37, "L" => 38, "Z" => 44, "X" => 45,
            "C" => 46, "V" => KEY_V, "B" => 48, "N" => 49, "M" => 50,
            _ => return None,
        })
    }
    /// The MAIN (non-modifier) key's keycode, resolved by KEYSYM via the active-layout charmap so the
    /// focused app receives the intended character (e.g. 'v' for Ctrl+V) regardless of physical layout —
    /// matching the X11 path (inject.rs binds keysym 'v'). Falls back to the fixed physical position when
    /// the layout has no such keysym, or for a non-letter main key (Insert).
    fn main_key_keycode(code: &str, charmap: &HashMap<char, KeySpec>) -> Option<i32> {
        if let Some(letter) = code.strip_prefix("Key").filter(|s| s.len() == 1) {
            let ch = letter.chars().next().unwrap().to_ascii_lowercase();
            if let Some(spec) = charmap.get(&ch) {
                return Some(spec.keycode);
            }
        }
        code_to_keycode(code) // fixed-table fallback (Insert, or the physical letter position)
    }

    /// Map a KeyboardEvent.code chord (e.g. ["ControlLeft","ShiftLeft","KeyV"]) to evdev keycodes,
    /// modifiers first and the main key last. Modifiers map by fixed evdev position (layout-independent);
    /// the main key maps by keysym via `charmap` (see main_key_keycode). Falls back to Ctrl+V — the
    /// layout's own 'v' keycode — when no main key maps, so paste never silently no-ops.
    fn chord_to_keycodes(codes: &[String], charmap: &HashMap<char, KeySpec>) -> Vec<i32> {
        let (mut mods, mut keys) = (Vec::new(), Vec::new());
        for c in codes {
            if is_modifier_code(c) {
                if let Some(kc) = code_to_keycode(c) {
                    mods.push(kc);
                }
            } else if let Some(kc) = main_key_keycode(c, charmap) {
                keys.push(kc);
            }
        }
        if keys.is_empty() {
            let v = charmap.get(&'v').map(|s| s.keycode).unwrap_or(KEY_V);
            return vec![KEY_LEFTCTRL, v];
        }
        // A main key but no recognized modifier would press a BARE key — typing the literal char
        // instead of pasting. Prepend Ctrl, mirroring the X11 path (inject.rs paste_keystroke).
        if mods.is_empty() {
            mods.push(KEY_LEFTCTRL);
        }
        mods.extend(keys);
        mods
    }

    /// Queue a job for the persistent typer, starting the task (one consent dialog)
    /// on first use, and await its completion.
    async fn submit(
        app: &AppHandle,
        typer: &WaylandTyper,
        text: String,
        paste: bool,
        chord_codes: Vec<String>,
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
        tx.send(Job { text, paste, chord_codes, auto_enter, reply })
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
            // Set while we've tapped Caps Lock ON for a lock-char (Ü/Ä/Ö) but not yet tapped it
            // back; if an error bails out in that window, the cleanup below restores Caps Lock.
            let mut caps_flipped = false;

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
                    // Resolve the chord to keycodes HERE (the charmap is built) so the MAIN key maps by
                    // keysym against the active layout (e.g. 'v' for Ctrl+V) instead of a fixed physical
                    // position — matching the X11 path. Press in order, release in reverse.
                    let chord = chord_to_keycodes(&job.chord_codes, &charmap);
                    let n = chord.len();
                    for (i, &code) in chord.iter().enumerate() {
                        press!(code);
                        tokio::time::sleep(Duration::from_millis(if i + 1 == n { 4 } else { 6 })).await;
                    }
                    for &code in chord.iter().rev() {
                        tokio::time::sleep(Duration::from_millis(6)).await;
                        release!(code);
                    }
                    if job.auto_enter {
                        tokio::time::sleep(Duration::from_millis(6)).await;
                        press!(KEY_ENTER);
                        release!(KEY_ENTER);
                    }
                    tokio::time::sleep(Duration::from_millis(40)).await;
                    return Ok(());
                }
                // KWin interprets each injected keycode under the LIVE Caps Lock, and our
                // charmap only models Shift/AltGr (not Lock) — so with Caps ON, alphabetic
                // keys come out inverted-case. Compensate by flipping Shift for Lock-
                // affected (alphabetic) keys while Caps is on. (zwp_virtual_keyboard would
                // sidestep this, but KWin doesn't advertise it, so we're on this path.)
                let caps = caps_lock_on();
                for c in job.text.chars() {
                    let Some(spec) = key_spec_for(c, &charmap) else {
                        continue; // char not reachable on this layout — skip
                    };

                    // Capital reachable ONLY via Caps Lock (Swiss-German Ü/Ä/Ö, È/É/À): press the
                    // base key with Caps Lock effectively ON so KWin capitalizes the lowercase
                    // keysym. If Caps is currently OFF, bracket the press with a Caps Lock tap to
                    // flip it on and back (leaving the user's Caps state unchanged); if it's already
                    // ON, the press alone yields the capital. Shift/AltGr still apply (È = Lock+Shift).
                    if spec.lock {
                        let flip = !caps;
                        if flip {
                            press!(KEY_CAPSLOCK);
                            // Caps Lock toggles on the PRESS, so mark it flipped here — before the
                            // release. If the release errors and bails the block, the cleanup tap
                            // below must still run, else Caps is left inverted system-wide.
                            caps_flipped = true;
                            release!(KEY_CAPSLOCK);
                            tokio::time::sleep(Duration::from_millis(6)).await;
                        }
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
                        if flip {
                            tokio::time::sleep(Duration::from_millis(6)).await;
                            press!(KEY_CAPSLOCK);
                            // Symmetric to the opening tap: this PRESS toggles Caps back to the
                            // user's original state, so clear the flag here — before the release.
                            // Otherwise a failing release leaves caps_flipped set and the cleanup
                            // tap would re-invert Caps.
                            caps_flipped = false;
                            release!(KEY_CAPSLOCK);
                        }
                        tokio::time::sleep(Duration::from_millis(6)).await;
                        continue;
                    }

                    // A live Caps Lock capitalizes alphabetic output. On a normal case-pair key the
                    // XOR below cancels it by pressing Shift; on a non-caps-safe FOUR_LEVEL key
                    // (Swiss-German ü, whose Shift gives è) pressing Shift would select the WRONG
                    // glyph, so flip Caps OFF for the press and use the glyph's own modifiers, then
                    // flip it back — symmetric to the lock path above (which flips it ON for a capital).
                    // Gate on whether Caps actually case-FOLDS this char to a different single char —
                    // not merely is_alphabetic(), which is also true for caseless-script letters and for
                    // lowercase letters whose uppercase is multi-char (German 'ß' → "SS"). Caps doesn't
                    // change those glyphs, so the XOR-Shift below would wrongly select their shift-level
                    // keysym (e.g. German Shift+ß = '?', turning "Straße" into "Stra?e").
                    let caps_affects = caps && {
                        let lo: Vec<char> = c.to_lowercase().collect();
                        let up: Vec<char> = c.to_uppercase().collect();
                        lo.len() == 1 && up.len() == 1 && lo[0] != up[0]
                    };
                    let flip_caps_off = caps_affects && !spec.caps_safe;
                    if flip_caps_off {
                        press!(KEY_CAPSLOCK);
                        // Toggles OFF on press — mark flipped before the release so the cleanup tap
                        // restores Caps even if the release errors out mid-char.
                        caps_flipped = true;
                        release!(KEY_CAPSLOCK);
                        tokio::time::sleep(Duration::from_millis(6)).await;
                    }
                    let needs_shift = spec.shift ^ (caps_affects && spec.caps_safe);
                    if needs_shift {
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
                    if needs_shift {
                        tokio::time::sleep(Duration::from_millis(4)).await;
                        release!(KEY_LEFTSHIFT);
                    }
                    if flip_caps_off {
                        tokio::time::sleep(Duration::from_millis(6)).await;
                        press!(KEY_CAPSLOCK);
                        // Toggles Caps back ON — clear the flag before the release (symmetric to the
                        // opening tap) so the cleanup tap doesn't re-invert it.
                        caps_flipped = false;
                        release!(KEY_CAPSLOCK);
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
            // The held loop only releases keycodes still pressed; a Caps Lock tap is press+release,
            // so its toggle survives. If we bailed mid lock-char with Caps left flipped, tap it once
            // more to restore the user's Caps Lock state.
            if caps_flipped {
                let _ = proxy
                    .notify_keyboard_keycode(&session, KEY_CAPSLOCK, KeyState::Pressed, Default::default())
                    .await;
                let _ = proxy
                    .notify_keyboard_keycode(&session, KEY_CAPSLOCK, KeyState::Released, Default::default())
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
    _chord_codes: Vec<String>,
    _auto_enter: bool,
) -> Result<(), String> {
    Err("Wayland text injection is only available on Linux".into())
}
