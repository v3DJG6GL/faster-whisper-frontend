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
#[cfg_attr(windows, allow(dead_code))] // the consuming typer task is Linux-only (RemoteDesktop portal)
pub struct Job {
    text: String, // characters to type (empty for a paste chord)
    /// Injection generation this job belongs to; the typing loop abandons the rest of `text` once
    /// `crate::inject::injection_cancelled` reports it superseded. Without it a long transcript
    /// kept typing into whatever held focus long after the user cancelled.
    epoch: u64,
    paste: bool, // true → synthesize the paste chord instead of typing `text`
    // The paste chord as KeyboardEvent.code strings (modifiers first, main key last) — NOT pre-resolved
    // keycodes — so the MAIN letter key is resolved by KEYSYM against the active layout's charmap inside
    // session_loop (where the charmap is built). A fixed physical position would mis-paste on a layout
    // whose physical V position isn't keysym 'v' (Dvorak/Colemak/Bepo).
    chord_codes: Vec<String>,
    auto_enter: bool,
    reply: oneshot::Sender<Result<crate::inject::Landed, String>>,
}

/// Sender to the persistent RemoteDesktop typer task (started lazily on the first
/// direct-typing injection). Reusing one portal session across utterances is what
/// stops KDE from re-prompting for "Control input devices" on every segment.
#[derive(Default)]
#[cfg_attr(windows, allow(dead_code))] // only the Linux portal path reads the sender; managed state on all platforms
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
    use unicode_normalization::UnicodeNormalization;
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
        /// A dead-key prefix `(keycode, shift, altgr)` tapped before this key: the char exists only
        /// as a compose of that dead key and this base key — Spanish/French/Portuguese é/ê/ñ,
        /// Greek tonos ά/έ, which no level of any key carries. See the dead-key pass in
        /// `charmap_from_keymap`.
        dead: Option<(i32, bool, bool)>,
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
            // Owner-only: presenting this token re-acquires input-injection rights without
            // the portal's "Control input devices" consent dialog.
            let _ = crate::config::write_private(&p, token);
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

    /// The compositor's currently-ACTIVE XKB group index — 0 for a single layout, 1+ for the Nth
    /// layout of a multi-layout `us,de,…` config. The portal injects raw keycodes that KWin resolves
    /// under the LIVE active group, so `build_charmap` must look glyphs up in THIS group, not always
    /// group 0. Queried via X11 `XkbGetState` (KWin keeps XWayland's XKB state in sync with the
    /// Wayland layout). Defensive and best-effort: returns 0 on no X display / no XKB / any failure,
    /// so a single-layout machine — and every failure path — behaves exactly as before (group 0).
    /// libX11 is loaded with `dlopen`, so it's an OPTIONAL runtime dep, never a build/link requirement.
    fn active_xkb_group() -> u32 {
        use libc::{c_char, c_int, c_uint, c_void};
        unsafe {
            let lib = libc::dlopen(c"libX11.so.6".as_ptr(), libc::RTLD_NOW);
            if lib.is_null() {
                return 0;
            }
            let open = libc::dlsym(lib, c"XOpenDisplay".as_ptr());
            let close = libc::dlsym(lib, c"XCloseDisplay".as_ptr());
            let query = libc::dlsym(lib, c"XkbQueryExtension".as_ptr());
            let state_fn = libc::dlsym(lib, c"XkbGetState".as_ptr());
            if open.is_null() || close.is_null() || query.is_null() || state_fn.is_null() {
                libc::dlclose(lib);
                return 0;
            }
            let open: extern "C" fn(*const c_char) -> *mut c_void = std::mem::transmute(open);
            let close: extern "C" fn(*mut c_void) -> c_int = std::mem::transmute(close);
            let query: extern "C" fn(
                *mut c_void,
                *mut c_int,
                *mut c_int,
                *mut c_int,
                *mut c_int,
                *mut c_int,
            ) -> c_int = std::mem::transmute(query);
            let get_state: extern "C" fn(*mut c_void, c_uint, *mut u8) -> c_int =
                std::mem::transmute(state_fn);

            let dpy = open(std::ptr::null());
            if dpy.is_null() {
                libc::dlclose(lib);
                return 0;
            }
            let mut group: u32 = 0;
            // XkbGetState needs the XKB extension initialised on this display first; pass the 1.0
            // version we rely on (in/out args, the rest are ignored).
            let (mut op, mut ev, mut err, mut major, mut minor): (
                c_int,
                c_int,
                c_int,
                c_int,
                c_int,
            ) = (0, 0, 0, 1, 0);
            if query(dpy, &mut op, &mut ev, &mut err, &mut major, &mut minor) != 0 {
                // XkbStateRec begins with `unsigned char group;`. Read the first byte of an 8-aligned
                // buffer sized well past the struct (~16 bytes). XkbGetState returns Success (0).
                let mut buf = [0u64; 8];
                let ptr = buf.as_mut_ptr() as *mut u8;
                if get_state(dpy, 0x0100 /* XkbUseCoreKbd */, ptr) == 0 {
                    group = u32::from(*ptr);
                }
            }
            close(dpy);
            libc::dlclose(lib);
            group
        }
    }

    /// Build a character → (keycode, modifiers) map for the active layout. `composes: false` (a
    /// paste job, which only looks up the chord's ASCII letter) skips the compose table and the
    /// dead-key pass: they only add accented chars no key types directly.
    fn build_charmap(composes: bool) -> Option<HashMap<char, KeySpec>> {
        let (rules, model, layout, variant) = query_layout();
        // Look glyphs up in the ACTIVE layout group, not always group 0: with a multi-layout config
        // (us,de,…) the portal injects raw keycodes KWin resolves under the live group, so a group-0
        // charmap mistypes (y↔z, missing AltGr glyphs) whenever a non-first layout is active. 0 on a
        // single layout / any query failure ⇒ identical to the previous group-0-only behavior.
        let group = active_xkb_group();
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
        let compose = if composes { compose_table() } else { None };
        Some(charmap_from_keymap(&keymap, group, compose.as_ref()))
    }

    /// The compose table the focused app most likely resolves dead keys with: the one for the
    /// locale's character type (LC_ALL, then LC_CTYPE, then LANG — the precedence toolkits use),
    /// or the `C` table when none is set. `None` when no table compiles: the dead-key pass is then
    /// skipped and dead-key letters stay unreachable, as before.
    ///
    /// Compiled on a context of its own at `Critical` log level: the charmap is rebuilt per job,
    /// and a locale with no UTF-8 table (a Latin-1 `LANG=de_CH`, an uninstalled locale) would
    /// otherwise print a burst of xkbcommon errors on every dictation. The fallback is noted once.
    fn compose_table() -> Option<xkb::compose::Table> {
        static NOTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        let locale = ["LC_ALL", "LC_CTYPE", "LANG"]
            .iter()
            .filter_map(std::env::var_os)
            .find(|v| !v.is_empty())
            .unwrap_or_else(|| "C".into());
        let mut ctx = xkb::Context::new(xkb::CONTEXT_NO_FLAGS);
        ctx.set_log_level(xkb::LogLevel::Critical);
        let table =
            xkb::compose::Table::new_from_locale(&ctx, &locale, xkb::compose::COMPILE_NO_FLAGS)
                .ok();
        if table.is_none() && !NOTED.swap(true, std::sync::atomic::Ordering::Relaxed) {
            tracing::info!(
                ?locale,
                "no compose table for this locale; dead-key letters are not typed directly"
            );
        }
        table
    }

    /// The char → key map of `keymap` in layout group `group`. Split from `build_charmap` so tests
    /// can compile a real layout without `setxkbmap` or an X display.
    fn charmap_from_keymap(
        keymap: &xkb::Keymap,
        group: u32,
        compose: Option<&xkb::compose::Table>,
    ) -> HashMap<char, KeySpec> {
        let mut map: HashMap<char, KeySpec> = HashMap::new();
        // Dead keysyms (dead_acute, dead_circumflex, dead_tilde...) and the key that types each,
        // fewest-modifier occurrence wins, lowest keycode on a tie (de has dead_circumflex at
        // AltGr on ä and bare on ^: ê must not cost an AltGr chord). They produce no character
        // of their own, so the level scan below would otherwise drop them — and with them every
        // letter a layout types ONLY through one (es/pt ó, fr ê, gr έ), silently skipped from the
        // transcript.
        let mut deads: Vec<(xkb::Keysym, (i32, bool, bool))> = Vec::new();
        for kc in keymap.min_keycode().raw()..=keymap.max_keycode().raw() {
            let key = xkb::Keycode::new(kc);
            let num_layouts = keymap.num_layouts_for_key(key);
            if num_layouts == 0 {
                continue;
            }
            // Scan the effective group for this key: a key defining fewer groups than the active
            // index wraps back into range, as XKB's default RANGE_WRAP out-of-range action does.
            let g = group % num_layouts;
            // Only the 4 standard levels are encoded below (none / Shift / AltGr / Shift+AltGr).
            // Cap the scan: an ISO_Level5 layout (Neo, intl-extended) exposes 6-8 levels, and a
            // glyph reachable ONLY at level 4+ would be registered as `shift=false, altgr=false`
            // — a bare keypress that types that key's LEVEL-0 glyph instead. Leaving such glyphs
            // out of the map makes them fall back to the portal path rather than mis-type.
            let levels = keymap.num_levels_for_key(key, g).min(4);
            let caps_safe = key_is_caps_safe(keymap, key, g);
            for level in 0..levels {
                for sym in keymap.key_get_syms_by_level(key, g, level) {
                    if (0xfe50..=0xfe93).contains(&sym.raw()) {
                        let prefix = (
                            (kc - EVDEV_OFFSET) as i32,
                            level == 1 || level == 3,
                            level == 2 || level == 3,
                        );
                        let cost = |p: (i32, bool, bool)| u8::from(p.1) + u8::from(p.2);
                        match deads.iter_mut().find(|(d, _)| d == sym) {
                            Some(e) if cost(prefix) < cost(e.1) => e.1 = prefix,
                            Some(_) => {}
                            None => deads.push((*sym, prefix)),
                        }
                    }
                    let cp = xkb::keysym_to_utf32(*sym);
                    if cp == 0 {
                        continue;
                    }
                    if let Some(ch) = char::from_u32(cp) {
                        if ch.is_control() {
                            continue;
                        }
                        // First occurrence wins: lowest keycode, then lowest level on that key.
                        // Unlike the dead keys above, this is NOT fewest-modifier: every key found
                        // here types the glyph, and a cost-first pick would move ( and ) onto the
                        // keypad-paren keycodes.
                        map.entry(ch).or_insert(KeySpec {
                            keycode: (kc - EVDEV_OFFSET) as i32,
                            shift: level == 1 || level == 3,
                            altgr: level == 2 || level == 3,
                            lock: false,
                            caps_safe,
                            dead: None,
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
        // Dead-key pass, AFTER the Caps Lock capitals above: every char that a dead key composes
        // with a key we already type directly, and that no key types on its own. The compose table
        // is the same kind of table the focused app resolves the sequence with (see
        // `compose_table`). Directly typed chars and the Caps Lock capitals (Swiss-German Ü É À,
        // the proven route) always win: `or_insert`, and only plain level keys (no `lock`) serve
        // as bases. Bases are tried simplest key first (no modifier, then one), so the cheapest
        // sequence wins when two compose the same char.
        if let Some(table) = compose {
            let mut bases: Vec<(char, KeySpec)> = map
                .iter()
                .filter(|(_, s)| !s.lock)
                .map(|(&c, &s)| (c, s))
                .collect();
            bases.sort_by_key(|&(c, s)| (u8::from(s.shift) + u8::from(s.altgr), s.keycode, c));
            let mut state = xkb::compose::State::new(table, xkb::compose::STATE_NO_FLAGS);
            for &(dead_sym, prefix) in &deads {
                for &(base, spec) in &bases {
                    state.reset();
                    state.feed(dead_sym);
                    state.feed(xkb::utf32_to_keysym(base as u32));
                    if state.status() != xkb::compose::Status::Composed {
                        continue;
                    }
                    let Some(out) = state.utf8() else {
                        continue;
                    };
                    let mut chars = out.chars();
                    let (Some(ch), None) = (chars.next(), chars.next()) else {
                        continue; // a multi-char result is not one transcript char
                    };
                    // The typer's live-Caps compensation reads the case pair of the char it
                    // types, but Caps acts on the BASE key: keep only a composed char that pairs
                    // like its base (é/e, έ/ε). İ (lowercases to two chars), ǰ ẗ (uppercase to
                    // two) or ᾳ would come out as another glyph or a cancelled compose under
                    // Caps Lock — they stay unreachable, as before.
                    if ch.is_control() || case_pairs(ch) != case_pairs(base) {
                        continue;
                    }
                    map.entry(ch).or_insert(KeySpec {
                        dead: Some(prefix),
                        ..spec
                    });
                }
            }
        }

        map
    }

    /// Whether Caps Lock folds `c` to a different single char — the test the typer's live-Caps
    /// compensation applies (not merely `is_alphabetic`: caseless letters and ß → "SS" don't fold).
    fn case_pairs(c: char) -> bool {
        let lo: Vec<char> = c.to_lowercase().collect();
        let up: Vec<char> = c.to_uppercase().collect();
        lo.len() == 1 && up.len() == 1 && lo[0] != up[0]
    }

    fn key_spec_for(c: char, map: &HashMap<char, KeySpec>) -> Option<KeySpec> {
        match c {
            '\n' | '\r' => Some(KeySpec {
                keycode: KEY_ENTER,
                shift: false,
                altgr: false,
                lock: false,
                caps_safe: true,
                dead: None,
            }),
            '\t' => Some(KeySpec {
                keycode: KEY_TAB,
                shift: false,
                altgr: false,
                lock: false,
                caps_safe: true,
                dead: None,
            }),
            _ => map.get(&c).copied(),
        }
    }

    /// The keys that type `c`, each with the char it types: the char's own key when the layout
    /// has one, else a base char plus separately typed combining marks that are canonically
    /// equivalent to `c` — the Vietnamese `vn` layout types ệ as ê then U+0323 (combining dot
    /// below), and has no ệ key. The base takes as many of `c`'s marks as a single key carries
    /// (NFC of base + that subset); every mark left over must have a key of its own, typed after
    /// it in canonical order. `None` when no split is typeable.
    fn key_sequence(c: char, map: &HashMap<char, KeySpec>) -> Option<Vec<(char, KeySpec)>> {
        if let Some(spec) = key_spec_for(c, map) {
            return Some(vec![(c, spec)]);
        }
        let mut parts = std::iter::once(c).nfd();
        let base = parts.next()?;
        let marks: Vec<char> = parts.collect();
        if marks.is_empty() || marks.len() > 3 {
            return None;
        }
        // Subsets of the marks the base key takes, the largest first (fewest separate keys).
        let mut subsets: Vec<u32> = (0..1u32 << marks.len()).collect();
        subsets.sort_by_key(|m| std::cmp::Reverse(m.count_ones()));
        for subset in subsets {
            let taken = |i: usize| subset & (1 << i) != 0;
            let mut head = std::iter::once(base)
                .chain(
                    marks
                        .iter()
                        .enumerate()
                        .filter(|&(i, _)| taken(i))
                        .map(|(_, &m)| m),
                )
                .nfc();
            let (Some(ch), None) = (head.next(), head.next()) else {
                continue;
            };
            let Some(spec) = key_spec_for(ch, map) else {
                continue;
            };
            let rest: Option<Vec<(char, KeySpec)>> = marks
                .iter()
                .enumerate()
                .filter(|&(i, _)| !taken(i))
                .map(|(_, &m)| key_spec_for(m, map).map(|s| (m, s)))
                .collect();
            // The typed keys must still spell `c`: a taken mark that follows an untaken one of
            // the same combining class (ǖ = u + U+0308 + U+0304 typed as ū then U+0308) would
            // swap their order — another glyph.
            let Some(rest) = rest.filter(|rest| {
                std::iter::once(ch)
                    .chain(rest.iter().map(|&(m, _)| m))
                    .nfd()
                    .eq(std::iter::once(c).nfd())
            }) else {
                continue;
            };
            return Some(std::iter::once((ch, spec)).chain(rest).collect());
        }
        None
    }

    /// How many of `text`'s letters the active layout can type, and how many it cannot —
    /// `(reachable, unreachable)`. Only letters count: digits, punctuation, symbols and emoji say
    /// nothing about whether the layout fits the transcript's script.
    fn letter_reach(text: &str, map: &HashMap<char, KeySpec>) -> (usize, usize) {
        text.chars()
            .filter(|c| c.is_alphabetic())
            .fold((0, 0), |(yes, no), c| match key_sequence(c, map) {
                Some(_) => (yes + 1, no),
                None => (yes, no + 1),
            })
    }

    /// Should a typed job go on the clipboard instead, because the active layout cannot produce
    /// its letters? Two cases divert. Most letters are unreachable (Chinese on a US layout, digits
    /// or not). Or ANY unreachable letter belongs to a foreign word: a non-Latin script (Han,
    /// Kana, Hangul, Arabic, Hebrew, Thai, but also cased Cyrillic, Greek, Armenian...) on any
    /// layout, so "我在用iPhone 15 Pro Max" must not be typed as "iPhone 15 Pro Max", nor "Ich habe
    /// gestern Привет gesagt" lose "Привет", just because the Latin letters outnumber it — and,
    /// symmetrically, a Latin letter on a layout that types no basic Latin (Russian, Greek), so
    /// "Я купил новый iPhone вчера" keeps its "iPhone". Only stray Latin letters on a Latin
    /// layout (an accent a US layout lacks) are left to the per-character skip.
    fn divert_unreachable(text: &str, map: &HashMap<char, KeySpec>) -> bool {
        let (reachable, unreachable) = letter_reach(text, map);
        unreachable > 0 && (unreachable >= reachable || unreachable_foreign_word(text, map))
    }

    /// Does `text` hold a letter of a foreign word that the active layout cannot type? On any
    /// layout: a letter of a non-Latin script, from Greek (U+0370) up, cased or not. The Latin
    /// blocks above that floor (phonetic extensions, Latin Extended Additional/-C/-D/-E/-F/-G,
    /// super/subscript letters, letterlike symbols, the ﬁ ligatures, fullwidth Latin), the
    /// Latin-letter symbols Unicode also counts as alphabetic (circled Ⓜ, squared 🅿 emoji, math
    /// alphanumerics) and the Latin-context modifier letters below it (Hawaiʻi's ʻokina U+02BB)
    /// stay with the per-character skip. On a layout that types no basic Latin letter (Cyrillic,
    /// Greek...): also any unreachable Latin letter (ASCII, Latin-1, Latin Extended-A/-B) — there
    /// it is an English brand or name, not a stray accent. Modifier letters (the Belarusian
    /// apostrophe U+02BC a `by` layout cannot type) and µ ª º stay with the per-character skip.
    fn unreachable_foreign_word(text: &str, map: &HashMap<char, KeySpec>) -> bool {
        const LATIN_ABOVE_GREEK: [std::ops::RangeInclusive<u32>; 14] = [
            0x1D00..=0x1DFF,   // phonetic extensions (+ supplement), combining Latin letters
            0x1E00..=0x1EFF,   // Latin Extended Additional (Vietnamese ạ, Welsh ẁ)
            0x2070..=0x209F,   // superscript/subscript letters (ⁿ, ₐ)
            0x2100..=0x218F,   // letterlike symbols and number forms (ℓ, Ⅻ)
            0x2C60..=0x2C7F,   // Latin Extended-C
            0xA700..=0xA7FF,   // Latin Extended-D
            0xAB30..=0xAB6F,   // Latin Extended-E
            0xFB00..=0xFB06,   // Latin ligatures (ﬁ, ﬂ)
            0xFF21..=0xFF5A,   // fullwidth Latin letters
            0x2460..=0x24FF,   // enclosed alphanumerics (Ⓜ)
            0x10780..=0x107BF, // Latin Extended-F
            0x1D400..=0x1D7FF, // mathematical alphanumerics (𝐀)
            0x1DF00..=0x1DFFF, // Latin Extended-G
            0x1F100..=0x1F1FF, // enclosed alphanumeric supplement (🅰 🅿 emoji)
        ];
        let latin_layout = ('a'..='z').any(|l| map.contains_key(&l));
        text.chars().any(|c| {
            let u = c as u32;
            c.is_alphabetic()
                && key_sequence(c, map).is_none()
                && ((u >= 0x0370 && !LATIN_ABOVE_GREEK.iter().any(|r| r.contains(&u)))
                    || (!latin_layout
                        && (c.is_ascii_alphabetic() || (0x00C0..=0x024F).contains(&u))))
        })
    }

    /// Is this key a normal case-pair (its Shift level is the case-inverse of its base glyph)? Used so
    /// the live-Caps-Lock compensation knows whether pressing Shift actually cancels KWin's
    /// capitalization. A non-alphabetic base (digits, symbols) is unaffected by Caps → safe. A
    /// FOUR_LEVEL letter key (Swiss-German ü, whose Shift gives è — NOT Ü) is NOT safe.
    fn key_is_caps_safe(keymap: &xkb::Keymap, key: xkb::Keycode, group: u32) -> bool {
        let base = keymap
            .key_get_syms_by_level(key, group, 0)
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
            .key_get_syms_by_level(key, group, 1)
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

    /// Type `text` character-by-character (layout-correct keycodes). `epoch` is the
    /// cancellation generation the CALLER captured — see `submit`.
    pub async fn type_text(
        app: &AppHandle,
        typer: &WaylandTyper,
        text: &str,
        auto_enter: bool,
        epoch: u64,
    ) -> Result<crate::inject::Landed, String> {
        submit(
            app,
            typer,
            text.to_string(),
            false,
            Vec::new(),
            auto_enter,
            epoch,
        )
        .await
    }

    /// Synthesize Ctrl+V on the shared session (the caller has already set the
    /// clipboard). Raw keycodes via the portal — reliable on Wayland, where enigo's
    /// XTEST Ctrl+V mis-fires into the wrong shortcut (e.g. opening editor tabs).
    pub async fn paste(
        app: &AppHandle,
        typer: &WaylandTyper,
        chord_codes: Vec<String>,
        auto_enter: bool,
        epoch: u64,
    ) -> Result<crate::inject::Landed, String> {
        submit(
            app,
            typer,
            String::new(),
            true,
            chord_codes,
            auto_enter,
            epoch,
        )
        .await
    }

    fn is_modifier_code(code: &str) -> bool {
        matches!(
            code,
            "ControlLeft"
                | "ControlRight"
                | "ShiftLeft"
                | "ShiftRight"
                | "AltLeft"
                | "AltRight"
                | "MetaLeft"
                | "MetaRight"
                | "OSLeft"
                | "OSRight"
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
            // is honored on Wayland too — the X11 path (inject/mod.rs code_to_enigo) already maps all
            // letters, so without this the configured key was silently dropped to a Ctrl+V fallback.
            _ => return letter_keycode(code),
        })
    }

    /// evdev keycode for a single-letter `KeyboardEvent.code` (KeyA..KeyZ). Physical-position Linux
    /// input-event-codes (NOT alphabetical), mirroring hotkeys::evdev::imp::letter_key and the KEY_V
    /// const above (V == 47).
    fn letter_keycode(code: &str) -> Option<i32> {
        let letter = code.strip_prefix("Key").filter(|s| s.len() == 1)?;
        Some(match letter {
            "Q" => 16,
            "W" => 17,
            "E" => 18,
            "R" => 19,
            "T" => 20,
            "Y" => 21,
            "U" => 22,
            "I" => 23,
            "O" => 24,
            "P" => 25,
            "A" => 30,
            "S" => 31,
            "D" => 32,
            "F" => 33,
            "G" => 34,
            "H" => 35,
            "J" => 36,
            "K" => 37,
            "L" => 38,
            "Z" => 44,
            "X" => 45,
            "C" => 46,
            "V" => KEY_V,
            "B" => 48,
            "N" => 49,
            "M" => 50,
            _ => return None,
        })
    }
    /// The MAIN (non-modifier) key's keycode, resolved by KEYSYM via the active-layout charmap so the
    /// focused app receives the intended character (e.g. 'v' for Ctrl+V) regardless of physical layout —
    /// matching the X11 path (inject/mod.rs binds keysym 'v'). Falls back to the fixed physical position when
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
        // instead of pasting. Prepend Ctrl, mirroring the X11 path (inject/mod.rs paste_keystroke).
        if mods.is_empty() {
            mods.push(KEY_LEFTCTRL);
        }
        mods.extend(keys);
        mods
    }

    /// Is one of our own windows focused right now? The same predicate `inject_text` uses at its
    /// entry guard and at both X11/Windows sink guards — kept here rather than passed in because
    /// `session_loop` already owns an `AppHandle`. Safe from this task: Tauri's `is_focused` posts
    /// to the event loop and waits on a channel, so the toolkit call runs on the main thread
    /// whichever thread asks, and this task never blocks the event loop.
    fn own_window_focused(app: &AppHandle) -> bool {
        app.webview_windows()
            .iter()
            .any(|(label, w)| label.as_str() != "overlay" && w.is_focused().unwrap_or(false))
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
        epoch: u64,
    ) -> Result<crate::inject::Landed, String> {
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
        // The epoch is captured by the CALLER, at the top of `inject_text`, not here. Queuing
        // happens after up to ~1.2s of pre-work (the held-modifier wait, two focus IPCs, a
        // bounded clipboard read, the settle, and on the fallback path a failed VK attempt), and
        // a cancel landing in that window would otherwise bump the counter BEFORE this read — so
        // the job adopted the post-cancel generation and `injection_cancelled` was false for its
        // whole life. Capturing at entry closes that window; the counter is still monotonic, so a
        // cancel still cannot leak into the NEXT injection.
        tx.send(Job {
            text,
            paste,
            chord_codes,
            auto_enter,
            reply,
            epoch,
        })
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
            // Rebuild the charmap PER JOB, not once per session: a KDE keyboard-layout switch
            // mid-run (e.g. us→de) would otherwise leave a stale snapshot and garble direct-typed
            // text (y↔z, symbols) until an app restart. build_charmap is a cheap setxkbmap +
            // libxkbcommon compile (ms) next to a multi-second utterance, and the persistent portal
            // session stays open, so this adds no consent re-prompt. It resolves the ACTIVE XKB
            // group per job (active_xkb_group), so a multi-layout `us,de` with group 1 active types
            // correctly too — the group snapshot is re-read here every job alongside the rebuild.
            // A bare auto-Enter job (no text, no chord) presses only the constant KEY_ENTER and never
            // reads the map, so it skips the rebuild — and with it a keymap failure that would
            // otherwise fail an Enter that needs no keymap. Built on the blocking pool: setxkbmap,
            // XOpenDisplay and the xkb compile must not stall a runtime worker. A paste job reads
            // only the chord's letter key, so it skips the compose table and the dead-key pass.
            let charmap = if !job.paste && job.text.is_empty() {
                Some(HashMap::new())
            } else {
                let paste = job.paste;
                tokio::task::spawn_blocking(move || build_charmap(!paste))
                    .await
                    .ok()
                    .flatten()
            };
            let charmap = match charmap {
                Some(m) => m,
                None => {
                    let _ = job
                        .reply
                        .send(Err("could not build a keymap for the active layout".into()));
                    continue;
                }
            };
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
            let res: Result<crate::inject::Landed, String> = async {
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

                // Before the job, not just between characters: the paste branch below returns without
                // ever reaching the per-character check, and a bare auto-Enter job has no characters
                // to iterate — so without this a cancel that lands while the job sits in the queue
                // still fires Ctrl+V, or still presses Enter, with nothing to abandon mid-loop.
                if crate::inject::injection_cancelled(job.epoch) {
                    tracing::info!("[wayland-inject] cancelled before typing — dropping the job");
                    return Ok(crate::inject::Landed::Yes);
                }
                // Own-window re-check at the SINK, not only at `inject_text`'s entry. This is the
                // last Wayland arm without one: the paste branch got its guards at the clipboard
                // write and at the chord, and the X11/Windows twin got one per typed chunk — but
                // everything reaching HERE crossed the widest gap on any path. Between the entry
                // guard and this point sit the <=500ms held-modifier wait, the latch consume, the
                // `focused_app_now` snapshot read, `ensure_started`'s thread spawn + portal
                // session (and possibly the KDE "Control input devices" consent modal), and the
                // queue wait behind any job already typing. A focus change anywhere in there
                // otherwise types the server's transcript into our own settings, API-key or
                // dictionary fields — where `sanitize_injected` deliberately preserves `\n`, so
                // it commits them.
                //
                // `NothingWritten` is the truthful answer and makes the caller's re-send safe:
                // no key has been synthesized yet. For a PASTE job the caller has already written
                // the transcript to the clipboard, so `text.rs` turns this answer into an
                // on-clipboard divert rather than a landed paste.
                if own_window_focused(app) {
                    tracing::info!("[wayland-inject] skipped before typing: our own window holds focus");
                    return Ok(crate::inject::Landed::NothingWritten);
                }
                // A transcript whose LETTERS the active layout mostly cannot produce (Chinese on a
                // US layout, digits or not) used to skip them in the loop below, press auto-Enter
                // on what was left and report `Landed::Yes`: the text was lost with nothing on the
                // clipboard. Hand it over on the clipboard instead, before any key is synthesized —
                // an on-clipboard divert, not an error, so a live session keeps running. A letter
                // of a non-Latin script (Han, Kana, Hangul, Arabic, Hebrew, Thai, Cyrillic,
                // Greek...) always diverts, even inside a mostly Latin line: it is part of a foreign
                // word, not a stray accent. The rule is symmetric: on a layout that types no basic
                // Latin (Russian, Greek), an unreachable Latin letter ("iPhone" in a Russian line)
                // diverts too. Symbols (a "♪" or "…" phrase, curly quotes, an em dash, emoji) and a
                // few stray accented Latin letters in an otherwise typeable line on a Latin layout
                // are still skipped per character below.
                if !job.paste && !job.text.is_empty() {
                    let (reachable, unreachable) = letter_reach(&job.text, &charmap);
                    if divert_unreachable(&job.text, &charmap) {
                        tracing::warn!(
                            "[wayland-inject] {unreachable} of {} letter(s) are not on the active keyboard layout — putting the text on the clipboard instead of typing",
                            reachable + unreachable
                        );
                        // `own_window_focused` above is a main-thread round trip, so a cancel can
                        // land after the pre-job check. Re-ask right before the clipboard write,
                        // like every sibling transcript write in `text.rs`, or a cancelled
                        // transcript still replaces what the user had copied.
                        if crate::inject::injection_cancelled(job.epoch) {
                            tracing::info!("[wayland-inject] cancelled before the clipboard divert — dropping the job");
                            return Ok(crate::inject::Landed::Yes);
                        }
                        // No key was synthesized: a failed clipboard write is "nothing written"
                        // (the caller's re-send is safe), as in the sibling diverts.
                        if let Err(e) = crate::inject::text::persist_off_runtime(job.text.clone()).await {
                            tracing::warn!("[wayland-inject] clipboard divert failed: {e}");
                            return Ok(crate::inject::Landed::NothingWritten);
                        }
                        return Ok(crate::inject::Landed::OnClipboard);
                    }
                    if unreachable > 0 {
                        tracing::warn!(
                            "[wayland-inject] {unreachable} letter(s) not on the active layout will be skipped"
                        );
                    }
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
                    // The enigo sibling has `if auto_enter && !injection_cancelled(epoch)`
                    // (inject/mod.rs) — N1 gave that path a pre-job check, a per-chunk check AND a
                    // check before the auto-Enter. This path got the first two (K12 turned the
                    // in-loop `break` into a `return`) but never the third, so a cancel landing
                    // during the paste chord still submitted the transcript.
                    //
                    // The CANCEL check alone is not the same question as "is it still safe to
                    // press this". The chord above is ~80ms of real portal round trips (more for
                    // a custom 3-key chord), and Return is the one synthesized key that ACTS
                    // rather than inserts: in our own settings, API-key or dictionary UI it
                    // presses whatever button holds focus. Its three siblings each carry an
                    // own-window probe at this exact point — `inject/mod.rs` (X11/Windows), the
                    // portal typing arm above, and `virtual_keyboard.rs`'s `i == last` — and this
                    // arm was the one left with a cancel-only condition. `Landed::Yes` stays
                    // correct on the skip: the chord already landed the text, so reporting
                    // anything else would make the caller re-send and duplicate it.
                    if job.auto_enter && !crate::inject::injection_cancelled(job.epoch) {
                        if own_window_focused(app) {
                            tracing::info!(
                                "[wayland-inject] auto-Enter skipped: our own window took focus during the paste chord"
                            );
                        } else {
                            tokio::time::sleep(Duration::from_millis(6)).await;
                            press!(KEY_ENTER);
                            release!(KEY_ENTER);
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(40)).await;
                    return Ok(crate::inject::Landed::Yes);
                }
                // KWin interprets each injected keycode under the LIVE Caps Lock, and our
                // charmap only models Shift/AltGr (not Lock) — so with Caps ON, alphabetic
                // keys come out inverted-case. Compensate by flipping Shift for Lock-
                // affected (alphabetic) keys while Caps is on. (zwp_virtual_keyboard would
                // sidestep this, but KWin doesn't advertise it, so we're on this path.)
                let caps = caps_lock_on();
                // Characters actually sent to the compositor, and the countdown to the next focus
                // probe. See the probe below for why it is periodic rather than per character.
                let mut typed: usize = 0;
                for c in job.text.chars() {
                    // Between characters, not just before the job: this loop runs at roughly a
                    // hundred characters a second and follows the user's focus as they move.
                    if crate::inject::injection_cancelled(job.epoch) {
                        tracing::info!("[wayland-inject] cancelled mid-typing — stopping");
                        // RETURN, not break: `break` fell through to the unconditional auto-Enter
                        // below, so a cancelled transcript was truncated mid-sentence and then
                        // SUBMITTED. The virtual-keyboard path already returns here.
                        return Ok(crate::inject::Landed::Yes);
                    }
                    // Follow focus the same way, for the same reason: this loop runs for SECONDS
                    // on a long transcript, and a click into one of our own windows part-way
                    // through otherwise lands every remaining character there. The X11/Windows
                    // twin re-asks once per 512-char chunk (Q32); at ~10ms per character here,
                    // every 32 characters is the same ~third-of-a-second cadence. Periodic rather
                    // than per character on purpose — each probe is a round trip to the UI thread,
                    // and the notes record that coupling as the accepted cost of this mechanism.
                    //
                    // The already-typed prefix stays: re-sending it would duplicate text on screen
                    // (hazard P16), so the untyped tail is dropped and this reports `Yes` — the
                    // same trade Q32 settled for the mid-typing cancel right above.
                    //
                    // Below the `key_sequence` lookup, not above it: an unreachable character
                    // `continue`s without advancing `typed`, so a probe placed above re-fired on
                    // every character of an unreachable run (curly quotes, an em dash, emoji) —
                    // back to back, with no sleep between them — instead of once per 32 typed.
                    let Some(keys) = key_sequence(c, &charmap) else {
                        continue; // char not reachable on this layout — skip
                    };
                    if typed.is_multiple_of(32) && typed > 0 && own_window_focused(app) {
                        tracing::info!(
                            "[wayland-inject] stopped mid-typing: our own window took focus ({typed} chars in)"
                        );
                        return Ok(crate::inject::Landed::Yes);
                    }
                    // Counted HERE, the moment this character is committed to being typed — not at
                    // the bottom of the body. The `spec.lock` case below (a capital reachable only
                    // via a Caps Lock bracket: Swiss-German Ü/Ä/Ö, French È/É/À) once had its own
                    // branch ending in a `continue`, which jumped past a bottom-of-body increment —
                    // so those characters cost ~38ms each, MORE than a normal one, while counting
                    // zero. The transcript is remote and untrusted, so that is attacker-controllable
                    // rather than a cadence wobble: an all-lock-capital transcript held the counter
                    // at 0, the `typed > 0` term never became true, and the focus probe below never
                    // fired once for the whole job — leaving exactly the sink this guard was added
                    // to close.
                    typed += 1;

                    // One char can take several keys: a dead-key prefix (`spec.dead`), or a base
                    // letter plus separately typed combining marks (`key_sequence`). The cancel and
                    // focus checks above stay per transcript char, so a char is never left half
                    // composed by them.
                    for (ch, spec) in keys {
                        // Dead-key prefix (es/fr/pt é ê ñ, gr έ): tap the dead key with its own
                        // modifiers first; the app composes it with the base key pressed below.
                        // Through press!/release!, so a failure mid-tap is still released by the
                        // cleanup. The live Caps compensation below concerns the base key only —
                        // dead keysyms are not letters, so Caps does not change them.
                        if let Some((dead_key, dead_shift, dead_altgr)) = spec.dead {
                            if dead_shift {
                                press!(KEY_LEFTSHIFT);
                                tokio::time::sleep(Duration::from_millis(4)).await;
                            }
                            if dead_altgr {
                                press!(KEY_RIGHTALT);
                                tokio::time::sleep(Duration::from_millis(4)).await;
                            }
                            press!(dead_key);
                            tokio::time::sleep(Duration::from_millis(4)).await;
                            release!(dead_key);
                            if dead_altgr {
                                tokio::time::sleep(Duration::from_millis(4)).await;
                                release!(KEY_RIGHTALT);
                            }
                            if dead_shift {
                                tokio::time::sleep(Duration::from_millis(4)).await;
                                release!(KEY_LEFTSHIFT);
                            }
                            tokio::time::sleep(Duration::from_millis(6)).await;
                        }
                        // Capital reachable ONLY via Caps Lock (Swiss-German Ü/Ä/Ö, È/É/À): press the
                        // base key with Caps Lock effectively ON so KWin capitalizes the lowercase
                        // keysym. If Caps is currently OFF, bracket the press with a Caps Lock tap to
                        // flip it on and back (leaving the user's Caps state unchanged); if it's already
                        // ON, the press alone yields the capital. Shift/AltGr still apply (È = Lock+Shift).
                        //
                        // Otherwise: a live Caps Lock capitalizes alphabetic output. On a normal
                        // case-pair key the XOR below cancels it by pressing Shift; on a non-caps-safe
                        // FOUR_LEVEL key (Swiss-German ü, whose Shift gives è) pressing Shift would
                        // select the WRONG glyph, so flip Caps OFF for the press and use the glyph's own
                        // modifiers, then flip it back — symmetric to the lock case (which flips it ON
                        // for a capital). Gate on whether Caps actually case-FOLDS this char to a
                        // different single char — not merely is_alphabetic(), which is also true for
                        // caseless-script letters and for lowercase letters whose uppercase is
                        // multi-char (German 'ß' → "SS"). Caps doesn't change those glyphs, so the
                        // XOR-Shift below would wrongly select their shift-level keysym (e.g. German
                        // Shift+ß = '?', turning "Straße" into "Stra?e").
                        //
                        // Both cases press the same sequence and differ only in this pair.
                        let (flip_caps, needs_shift) = if spec.lock {
                            (!caps, spec.shift)
                        } else {
                            let caps_affects = caps && case_pairs(ch);
                            (
                                caps_affects && !spec.caps_safe,
                                spec.shift ^ (caps_affects && spec.caps_safe),
                            )
                        };
                        if flip_caps {
                            press!(KEY_CAPSLOCK);
                            // Caps Lock toggles on the PRESS, so mark it flipped here — before the
                            // release. If the release errors and bails the block, the cleanup tap
                            // below must still run, else Caps is left inverted system-wide.
                            caps_flipped = true;
                            release!(KEY_CAPSLOCK);
                            tokio::time::sleep(Duration::from_millis(6)).await;
                        }
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
                        if flip_caps {
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
                    }
                }
                // Same missing third check as the paste branch above. For a bare auto-Enter
                // job `job.text` is empty, so the per-character cancel check in the loop above
                // ran zero times and the pre-job check was the only earlier one — the charmap
                // build plus the portal keycode round trips sit in the gap it cannot cover, so
                // a cancel arriving there still pressed Return. (`virtual_keyboard.rs` closes the
                // same gap with the per-key `injection_cancelled` check inside its typing loop.)
                // The focus term is the sibling of the cancel term: the loop above probes every 32
                // characters, so up to 32 characters plus this Enter can still follow a focus
                // change — and an Enter is the one keystroke that ACTS rather than inserts, firing
                // whatever button holds focus in our own window (Q31's finding, on the arm that
                // reaches it after typing rather than bare).
                if job.auto_enter
                    && !crate::inject::injection_cancelled(job.epoch)
                    && !own_window_focused(app)
                {
                    press!(KEY_ENTER);
                    release!(KEY_ENTER);
                }
                // Let KWin process the queued events before the caller proceeds.
                tokio::time::sleep(Duration::from_millis(40)).await;
                Ok(crate::inject::Landed::Yes)
            }
            .await;

            // GUARANTEED cleanup: release anything still held (an error bailed out
            // mid-chord). Best-effort — release in reverse press order, ignoring
            // errors since we're already reporting the real failure.
            for code in held.iter().rev() {
                let _ = proxy
                    .notify_keyboard_keycode(
                        &session,
                        *code,
                        KeyState::Released,
                        Default::default(),
                    )
                    .await;
            }
            // The held loop only releases keycodes still pressed; a Caps Lock tap is press+release,
            // so its toggle survives. If we bailed mid lock-char with Caps left flipped, tap it once
            // more to restore the user's Caps Lock state.
            if caps_flipped {
                let _ = proxy
                    .notify_keyboard_keycode(
                        &session,
                        KEY_CAPSLOCK,
                        KeyState::Pressed,
                        Default::default(),
                    )
                    .await;
                let _ = proxy
                    .notify_keyboard_keycode(
                        &session,
                        KEY_CAPSLOCK,
                        KeyState::Released,
                        Default::default(),
                    )
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

    #[cfg(test)]
    mod tests {
        use super::*;

        fn us_letters() -> HashMap<char, KeySpec> {
            ('a'..='z')
                .enumerate()
                .map(|(i, c)| {
                    let spec = KeySpec {
                        keycode: 16 + i as i32,
                        shift: false,
                        altgr: false,
                        lock: false,
                        caps_safe: true,
                        dead: None,
                    };
                    (c, spec)
                })
                .collect()
        }

        /// A Russian layout: lowercase а..я plus ё, and the capital Я — no basic Latin.
        fn ru_letters() -> HashMap<char, KeySpec> {
            ('\u{430}'..='\u{44f}')
                .chain(['\u{451}', '\u{42f}'])
                .enumerate()
                .map(|(i, c)| {
                    let spec = KeySpec {
                        keycode: 16 + i as i32,
                        shift: false,
                        altgr: false,
                        lock: false,
                        caps_safe: true,
                        dead: None,
                    };
                    (c, spec)
                })
                .collect()
        }

        #[test]
        fn letter_reach_counts_a_script_the_layout_cannot_type_digits_or_not() {
            // Chinese on a US layout: the digits are typeable, the words are not — divert.
            assert_eq!(letter_reach("你好 世界\n", &us_letters()), (0, 4));
            assert_eq!(
                letter_reach("会议在3点开始。2026年预算", &us_letters()),
                (0, 9)
            );
        }

        #[test]
        fn letter_reach_ignores_symbols_and_whitespace() {
            // A music/ellipsis phrase or an em dash is skipped per character, never a reason to
            // divert a live phrase.
            assert_eq!(letter_reach("♪ … — 😀 \n\t", &us_letters()), (0, 0));
            assert_eq!(letter_reach("ab — c", &us_letters()), (3, 0));
        }

        #[test]
        fn letter_reach_keeps_a_mostly_typeable_line_typeable() {
            let (yes, no) = letter_reach("caf\u{e9} ole", &us_letters());
            assert!(no > 0 && no < yes);
            assert!(!divert_unreachable("caf\u{e9} ole", &us_letters()));
        }

        #[test]
        fn a_non_latin_script_letter_diverts_even_in_a_mostly_latin_line() {
            // 9 typeable letters vs 6 unreachable (P, P, M and 3 Han): not a majority, so only the
            // non-Latin rule diverts it. The Han words must not be dropped.
            assert!(unreachable_foreign_word(
                "我在用iPhone 15 Pro Max",
                &us_letters()
            ));
            assert!(divert_unreachable("我在用iPhone 15 Pro Max", &us_letters()));
            assert!(divert_unreachable("你好 世界", &us_letters()));
            // A stray accented cased letter is still skipped per character.
            assert!(!unreachable_foreign_word("caf\u{e9}", &us_letters()));
            assert!(!divert_unreachable("Caf\u{c9} au lait", &us_letters()));
            // A Latin-context modifier letter (the ʻokina) is not a non-Latin word.
            assert!(!unreachable_foreign_word(
                "I flew to Hawai\u{2bb}i today",
                &us_letters()
            ));
            assert!(!divert_unreachable(
                "I flew to Hawai\u{2bb}i today",
                &us_letters()
            ));
            // Latin Extended-D's caseless letters (U+A7F7 sideways I) stay with the per-character
            // skip too; Hebrew does not.
            assert!(!unreachable_foreign_word("a\u{a7f7}b", &us_letters()));
            assert!(unreachable_foreign_word("a\u{05d0}b", &us_letters()));
            // A squared-letter or circled-letter emoji is a symbol, not a word: skipped per
            // character, the rest typed.
            assert!(!divert_unreachable(
                "Park on level 3 \u{1f17f}\u{fe0f} near the \u{24c2} exit",
                &us_letters()
            ));
            // So is Vietnamese's ạ (Latin Extended Additional) in a Latin line.
            assert!(!divert_unreachable(
                "Ha\u{1ea1} is in Hanoi today",
                &us_letters()
            ));
        }

        #[test]
        fn a_cased_non_latin_word_diverts_even_in_a_mostly_latin_line() {
            // Cyrillic and Greek letters are cased, so a caseless test let them through: 19
            // typeable vs 7 unreachable (the capital I — us_letters has no capitals — and the 6
            // Cyrillic letters), and "Привет" was skipped letter by letter.
            assert!(divert_unreachable(
                "Ich habe gestern \u{41f}\u{440}\u{438}\u{432}\u{435}\u{442} gesagt",
                &us_letters()
            ));
            assert!(divert_unreachable(
                "hello \u{3ba}\u{3b1}\u{3bb}\u{3b7}\u{3bc}\u{3ad}\u{3c1}\u{3b1} world",
                &us_letters()
            ));
        }

        #[test]
        fn a_latin_word_diverts_on_a_layout_without_latin_letters() {
            // 16 typeable vs 6 unreachable: not a majority, so only the foreign-word rule keeps
            // "iPhone" from being skipped letter by letter on a Russian layout.
            let ru = ru_letters();
            assert!(divert_unreachable(
                "\u{42f} \u{43a}\u{443}\u{43f}\u{438}\u{43b} \u{43d}\u{43e}\u{432}\u{44b}\u{439} iPhone \u{432}\u{447}\u{435}\u{440}\u{430}",
                &ru
            ));
            assert!(!divert_unreachable(
                "\u{44f} \u{43a}\u{443}\u{43f}\u{438}\u{43b} \u{43d}\u{43e}\u{432}\u{44b}\u{439} \u{442}\u{435}\u{43b}\u{435}\u{444}\u{43e}\u{43d}",
                &ru
            ));
            // A modifier apostrophe (U+02BC, "сямʼя") is not a Latin word: skipped, no divert.
            assert!(!divert_unreachable(
                "\u{441}\u{44f}\u{43c}\u{2bc}\u{44f}",
                &ru
            ));
        }

        fn spec(keycode: i32, shift: bool, dead: Option<(i32, bool, bool)>) -> KeySpec {
            KeySpec {
                keycode,
                shift,
                altgr: false,
                lock: false,
                caps_safe: true,
                dead,
            }
        }

        /// A Latin layout typing a-z and A-Z, plus `extra` chars, each on a key of its own.
        fn latin_with(extra: &[(char, KeySpec)]) -> HashMap<char, KeySpec> {
            let mut map = us_letters();
            for (i, c) in ('A'..='Z').enumerate() {
                map.insert(c, spec(16 + i as i32, true, None));
            }
            map.extend(extra.iter().copied());
            map
        }

        /// Compile a real layout and its dead-key composes the way `build_charmap` does (group 0,
        /// the en_US.UTF-8 compose table). `None` — the test then skips — when this machine has no
        /// XKB data or compose table for it.
        fn real_charmap(layout: &str) -> Option<HashMap<char, KeySpec>> {
            let ctx = xkb::Context::new(xkb::CONTEXT_NO_FLAGS);
            let keymap = xkb::Keymap::new_from_names(
                &ctx,
                "evdev",
                "pc105",
                layout,
                "",
                None,
                xkb::KEYMAP_COMPILE_NO_FLAGS,
            )?;
            let table = xkb::compose::Table::new_from_locale(
                &ctx,
                std::ffi::OsStr::new("en_US.UTF-8"),
                xkb::compose::COMPILE_NO_FLAGS,
            )
            .ok()?;
            Some(charmap_from_keymap(&keymap, 0, Some(&table)))
        }

        #[test]
        fn caps_lock_capitals_win_over_composes_and_caps_unsafe_composes_stay_out() {
            // Swiss-German Ü É À: the proven Caps Lock bracket on the ü/é/à key, not dead key +
            // Shift+base (which the dead pass would also find).
            if let Some(ch) = real_charmap("ch") {
                for c in ['\u{dc}', '\u{c9}', '\u{c0}'] {
                    let spec = ch.get(&c).copied();
                    assert!(
                        spec.is_some_and(|s| s.lock && s.dead.is_none()),
                        "{c}: {:?}",
                        spec.map(|s| (s.lock, s.dead))
                    );
                }
            } else {
                eprintln!("skipped: no XKB data or compose table for `ch`");
            }
            // İ lowercases to two chars, so live-Caps compensation could not type it through
            // dead_abovedot + Shift+i: it is never registered as a compose.
            for layout in ["de", "fr", "es", "pl"] {
                if let Some(m) = real_charmap(layout) {
                    assert!(
                        m.get(&'\u{130}').is_none_or(|s| s.dead.is_none()),
                        "{layout}: \u{130} composed"
                    );
                    assert!(m.values().all(|s| !(s.lock && s.dead.is_some())));
                }
            }
            assert!(case_pairs('\u{e9}') && case_pairs('E'));
            assert!(!case_pairs('\u{130}') && !case_pairs('\u{1f0}') && !case_pairs('\u{df}'));
        }

        #[test]
        fn combining_mark_keys_type_a_letter_no_key_carries() {
            // vn: ê ô on keys of their own, the tone marks U+0301 / U+0323 as combining keys.
            let vn = latin_with(&[
                ('\u{ea}', spec(3, false, None)),
                ('\u{f4}', spec(4, false, None)),
                ('\u{301}', spec(5, false, None)),
                ('\u{323}', spec(6, false, None)),
            ]);
            // ệ = e + U+0323 + U+0302: ê takes the circumflex, the dot below is typed after it.
            let seq: Vec<char> = key_sequence('\u{1ec7}', &vn)
                .unwrap()
                .into_iter()
                .map(|(ch, _)| ch)
                .collect();
            assert_eq!(seq, ['\u{ea}', '\u{323}']);
            // ố = ô + U+0301; ó = o + U+0301.
            let seq: Vec<char> = key_sequence('\u{1ed1}', &vn)
                .unwrap()
                .into_iter()
                .map(|(ch, _)| ch)
                .collect();
            assert_eq!(seq, ['\u{f4}', '\u{301}']);
            assert_eq!(letter_reach("Vi\u{1ec7}t", &vn), (4, 0));
            assert!(!divert_unreachable("Vi\u{1ec7}t Nam", &vn));
            // A mark with no key of its own leaves the letter unreachable: ẽ needs U+0303.
            assert!(key_sequence('\u{1ebd}', &vn).is_none());
            // A letter on its own key is that one key.
            assert_eq!(key_sequence('a', &vn).map(|k| k.len()), Some(1));
            // ǖ = u + U+0308 + U+0304 (same combining class): ū then U+0308 would type another
            // glyph, so with no ü key the letter is unreachable; ü then U+0304 spells it.
            let macron = latin_with(&[
                ('\u{16b}', spec(3, false, None)),
                ('\u{308}', spec(4, false, None)),
            ]);
            assert!(key_sequence('\u{1d6}', &macron).is_none());
            let diaeresis = latin_with(&[
                ('\u{fc}', spec(3, false, None)),
                ('\u{304}', spec(4, false, None)),
            ]);
            let seq: Vec<char> = key_sequence('\u{1d6}', &diaeresis)
                .unwrap()
                .into_iter()
                .map(|(ch, _)| ch)
                .collect();
            assert_eq!(seq, ['\u{fc}', '\u{304}']);
        }

        #[test]
        fn a_real_dead_key_layout_types_its_accented_letters() {
            let Some(es) = real_charmap("es") else {
                eprintln!("skipped: no XKB data or compose table for `es`");
                return;
            };
            // The Spanish layout has no é/ó key: both come from dead_acute + the base letter.
            for c in ['\u{e9}', '\u{f3}', '\u{c9}'] {
                let spec = es.get(&c).copied();
                assert!(
                    spec.is_some_and(|s| s.dead.is_some()),
                    "{c} not via a dead key"
                );
            }
            // ñ has a key of its own and keeps it.
            assert!(es.get(&'\u{f1}').is_some_and(|s| s.dead.is_none()));
            if let Some(de) = real_charmap("de") {
                // de has dead_circumflex at AltGr on ä (AC11) and bare on ^ (TLDE, evdev 41): ê
                // takes the bare one.
                assert_eq!(
                    de.get(&'\u{ea}').and_then(|s| s.dead),
                    Some((41, false, false))
                );
            }
            assert!(!divert_unreachable(
                "La canci\u{f3}n est\u{e1} aqu\u{ed}",
                &es
            ));
            assert_eq!(
                letter_reach("La canci\u{f3}n est\u{e1} aqu\u{ed}", &es),
                (17, 0)
            );
            if let Some(fr) = real_charmap("fr") {
                // French ê: dead_circumflex + e.
                assert!(fr.get(&'\u{ea}').is_some_and(|s| s.dead.is_some()));
                assert!(!divert_unreachable("\u{ea}tre ou ne pas \u{ea}tre", &fr));
            }
            if let Some(vn) = real_charmap("vn") {
                // Vietnamese ệ ọ: a combining-mark key or a dead key after the base letter.
                assert!(key_sequence('\u{1ec7}', &vn).is_some());
                assert!(!divert_unreachable("Vi\u{1ec7}t Nam h\u{1ecd}c", &vn));
            }
            if let Some(gr) = real_charmap("gr") {
                assert!(gr.get(&'\u{3ad}').is_some_and(|s| s.dead.is_some()));
                assert!(!divert_unreachable(
                    "\u{39a}\u{3b1}\u{3bb}\u{3b7}\u{3bc}\u{3ad}\u{3c1}\u{3b1} \u{3c3}\u{3b5} \u{3cc}\u{3bb}\u{3bf}\u{3c5}\u{3c2}",
                    &gr
                ));
            }
        }
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
    _epoch: u64,
) -> Result<crate::inject::Landed, String> {
    Err("Wayland text injection is only available on Linux".into())
}

#[cfg(not(target_os = "linux"))]
pub async fn paste(
    _app: &tauri::AppHandle,
    _typer: &WaylandTyper,
    _chord_codes: Vec<String>,
    _auto_enter: bool,
    _epoch: u64,
) -> Result<crate::inject::Landed, String> {
    Err("Wayland text injection is only available on Linux".into())
}
