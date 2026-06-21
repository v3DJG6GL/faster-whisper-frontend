//! Layout- & Caps-independent text typing on Linux Wayland via the wlroots/KWin
//! `zwp_virtual_keyboard_v1` protocol (the `wtype`/`wvkbd` approach).
//!
//! The portal keycode path (`wayland_inject.rs`) injects raw evdev codes that KWin
//! resolves under the LIVE seat state — so a locked Caps Lock inverts letter case,
//! and characters not reachable on the active layout don't type at all. Here we
//! instead UPLOAD OUR OWN one-shot keymap in which every needed character is its own
//! keycode bound directly to its keysym, on a single level whose key type CONSUMES
//! Shift+Lock. The compositor then types exactly those characters regardless of Caps
//! Lock, the active layout, or even a physically-held Shift. No portal consent dialog
//! either.
//!
//! GNOME does not implement this protocol; `type_text` returns Err there (and on any
//! failure), so `inject_text` falls back to the portal path.
//!
//! wayland-client is synchronous and its `EventQueue` isn't `Send` across awaits, so
//! the connection lives on a dedicated OS thread served over a channel — mirroring
//! how `WaylandTyper` keeps one portal session for the app's lifetime.

use tokio::sync::{mpsc, oneshot, Mutex};

/// A virtual-keyboard typing failure. `after_typing` is true only if keys had ALREADY been
/// transmitted to the compositor when it failed — the caller must NOT re-type the whole text via
/// the portal then (it would duplicate the already-landed prefix); surface the error instead. A
/// false value (protocol unavailable / keymap upload failed / thread gone — nothing typed yet) is
/// safe to fall back to the portal.
pub struct VkError {
    pub message: String,
    pub after_typing: bool,
}

/// One typing request handed to the virtual-keyboard thread.
pub struct VkJob {
    text: String,
    auto_enter: bool,
    reply: oneshot::Sender<Result<(), VkError>>,
}

enum VkChannel {
    Unstarted,
    Active(mpsc::UnboundedSender<VkJob>),
    /// Determined unsupported (no protocol / init failed) — don't retry; fall back.
    Unavailable,
}

impl Default for VkChannel {
    fn default() -> Self {
        VkChannel::Unstarted
    }
}

/// Managed state: the lazily-started channel to the virtual-keyboard thread.
#[derive(Default)]
pub struct VirtualKeyboard(Mutex<VkChannel>);

/// Type `text` (then an optional Enter) via the virtual keyboard. Err means the protocol is
/// unavailable or the job failed; check `VkError::after_typing` before falling back to the portal —
/// when it's true, some keys already landed and re-typing would duplicate them. The setup/plumbing
/// failures here are all "nothing typed yet" (after_typing: false).
pub async fn type_text(vk: &VirtualKeyboard, text: &str, auto_enter: bool) -> Result<(), VkError> {
    let tx = ensure_started(vk)
        .await
        .map_err(|message| VkError { message, after_typing: false })?;
    let (reply, reply_rx) = oneshot::channel();
    tx.send(VkJob { text: text.to_string(), auto_enter, reply })
        .map_err(|_| VkError { message: "virtual keyboard thread gone".into(), after_typing: false })?;
    reply_rx
        .await
        .map_err(|_| VkError { message: "virtual keyboard dropped the job".into(), after_typing: false })?
}

async fn ensure_started(vk: &VirtualKeyboard) -> Result<mpsc::UnboundedSender<VkJob>, String> {
    let mut guard = vk.0.lock().await;
    match &*guard {
        VkChannel::Active(tx) if !tx.is_closed() => return Ok(tx.clone()),
        VkChannel::Unavailable => return Err("virtual keyboard unsupported".into()),
        _ => {}
    }

    #[cfg(target_os = "linux")]
    {
        let (tx, rx) = mpsc::unbounded_channel::<VkJob>();
        let (init_tx, init_rx) = oneshot::channel::<Result<(), String>>();
        // A dedicated thread owns the (sync, !Send-across-await) Wayland connection.
        std::thread::spawn(move || imp::run_thread(rx, init_tx));
        match init_rx.await {
            Ok(Ok(())) => {
                *guard = VkChannel::Active(tx.clone());
                Ok(tx)
            }
            Ok(Err(e)) => {
                *guard = VkChannel::Unavailable;
                Err(e)
            }
            Err(_) => {
                *guard = VkChannel::Unavailable;
                Err("virtual keyboard init crashed".into())
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        *guard = VkChannel::Unavailable;
        Err("virtual keyboard is Linux-only".into())
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::{VkError, VkJob};
    use memfd::MemfdOptions;
    use std::collections::HashMap;
    use std::io::Write;
    use std::os::fd::AsFd;
    use std::time::{Duration, Instant};
    use tokio::sync::{mpsc, oneshot};
    use wayland_client::{
        globals::{registry_queue_init, GlobalListContents},
        protocol::{wl_registry, wl_seat::WlSeat},
        Connection, Dispatch, EventQueue, QueueHandle,
    };
    use wayland_protocols_misc::zwp_virtual_keyboard_v1::client::{
        zwp_virtual_keyboard_manager_v1::ZwpVirtualKeyboardManagerV1,
        zwp_virtual_keyboard_v1::ZwpVirtualKeyboardV1,
    };

    /// Dispatch sink — we drive the keyboard with requests and ignore all events.
    struct St;

    impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for St {
        fn event(
            _: &mut Self,
            _: &wl_registry::WlRegistry,
            _: wl_registry::Event,
            _: &GlobalListContents,
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
        }
    }
    wayland_client::delegate_noop!(St: ignore WlSeat);
    wayland_client::delegate_noop!(St: ignore ZwpVirtualKeyboardManagerV1);
    wayland_client::delegate_noop!(St: ignore ZwpVirtualKeyboardV1);

    /// Serve typing jobs until the channel closes or the connection dies.
    pub fn run_thread(mut rx: mpsc::UnboundedReceiver<VkJob>, init: oneshot::Sender<Result<(), String>>) {
        let mut conn = match VkConn::new() {
            Ok(c) => {
                let _ = init.send(Ok(()));
                c
            }
            Err(e) => {
                let _ = init.send(Err(e));
                return;
            }
        };
        while let Some(job) = rx.blocking_recv() {
            let res = conn.type_text(&job.text, job.auto_enter);
            let _ = job.reply.send(res);
        }
    }

    struct VkConn {
        conn: Connection,
        queue: EventQueue<St>,
        state: St,
        vk: ZwpVirtualKeyboardV1,
        start: Instant,
    }

    impl VkConn {
        fn new() -> Result<Self, String> {
            let conn = Connection::connect_to_env().map_err(|e| format!("no Wayland connection: {e}"))?;
            let (globals, mut queue) =
                registry_queue_init::<St>(&conn).map_err(|e| format!("registry init failed: {e}"))?;
            let qh = queue.handle();
            // The deciding bind: absent on GNOME → caller falls back to the portal.
            let mgr: ZwpVirtualKeyboardManagerV1 = globals
                .bind(&qh, 1..=1, ())
                .map_err(|_| "zwp_virtual_keyboard_manager_v1 not advertised (compositor unsupported)".to_string())?;
            let seat: WlSeat = globals
                .bind(&qh, 1..=8, ())
                .map_err(|e| format!("no wl_seat: {e}"))?;
            let vk = mgr.create_virtual_keyboard(&seat, &qh, ());
            let mut state = St;
            // Flush the create + settle the protocol objects.
            queue.roundtrip(&mut state).map_err(|e| format!("roundtrip failed: {e}"))?;
            Ok(Self { conn, queue, state, vk, start: Instant::now() })
        }

        fn type_text(&mut self, text: &str, auto_enter: bool) -> Result<(), VkError> {
            // Helper: an error raised BEFORE any key was transmitted (keymap upload, limit, the
            // pre-key roundtrip) is safe to fall back to the portal. `before` builds those.
            let before = |e: String| VkError { message: e, after_typing: false };
            // Each character → its keysym name; skip non-printing control chars (Enter
            // and Tab map to their named keysyms, matching the portal path).
            let mut order: Vec<String> = text.chars().filter_map(keysym_name).collect();
            if auto_enter {
                order.push("Return".to_string());
            }
            if order.is_empty() {
                return Ok(());
            }
            // Distinct symbols, in first-seen order → one keycode each (xkb = idx + 8).
            let mut unique: Vec<String> = Vec::new();
            let mut idx_of: HashMap<String, u32> = HashMap::new();
            for name in &order {
                if !idx_of.contains_key(name) {
                    idx_of.insert(name.clone(), unique.len() as u32);
                    unique.push(name.clone());
                }
            }
            // xkb keycodes top out at 255 (8 + 247); far beyond any real dictation.
            if unique.len() > 248 {
                return Err(before(format!("{} distinct symbols exceeds the keymap limit", unique.len())));
            }

            let keymap = build_keymap(&unique);
            let (mfd, size) = keymap_fd(&keymap).map_err(before)?;
            self.vk.keymap(1 /* WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1 */, mfd.as_file().as_fd(), size);
            // Ensure the compositor has read + compiled the keymap before we send keys.
            self.queue.roundtrip(&mut self.state).map_err(|e| before(e.to_string()))?;
            drop(mfd);

            // Zero our own modifier state. Belt-and-suspenders: on wlroots this clears any
            // Caps the seat adopted from us; on KWin the seat keeps the physical Caps, so
            // the real Caps-immunity comes from the keymap's Lock-consuming key type.
            self.vk.modifiers(0, 0, 0, 0);

            // Once the FIRST press-flush succeeds, key events have been transmitted — a later flush
            // failure (compositor crash mid-typing) leaves an already-landed prefix, so the portal
            // must NOT re-type the whole text (it would duplicate it). Track that with `emitted`.
            let mut emitted = false;
            for name in &order {
                let code = idx_of[name];
                let t = self.start.elapsed().as_millis() as u32;
                self.vk.key(t, code, 1); // pressed
                // A failed press-flush BEFORE the first success transmitted nothing → safe fallback.
                self.conn.flush().map_err(|e| VkError { message: e.to_string(), after_typing: emitted })?;
                emitted = true; // a key-down was transmitted (the char likely registered on key-down)
                std::thread::sleep(Duration::from_millis(3));
                let t = self.start.elapsed().as_millis() as u32;
                self.vk.key(t, code, 0); // released
                self.conn.flush().map_err(|e| VkError { message: e.to_string(), after_typing: true })?;
                std::thread::sleep(Duration::from_millis(5));
            }
            // Drain so the compositor has processed everything before we report done.
            self.queue.roundtrip(&mut self.state).map_err(|e| VkError { message: e.to_string(), after_typing: emitted })?;
            Ok(())
        }
    }

    /// Character → XKB keysym name. Enter/Tab use named keysyms; other control chars
    /// are skipped; everything else becomes its Unicode keysym (`U00E4` = ä, …), which
    /// types that exact character no matter the layout or Caps Lock.
    fn keysym_name(ch: char) -> Option<String> {
        match ch {
            '\n' | '\r' => Some("Return".to_string()),
            '\t' => Some("Tab".to_string()),
            c if c.is_control() => None,
            c => Some(format!("U{:04X}", c as u32)),
        }
    }

    /// A minimal XKB keymap: each symbol on its own keycode at a single level, with a
    /// custom key type that CONSUMES Shift+Lock so the symbol is produced verbatim under
    /// a held Shift or a locked Caps. (A bare single-symbol key would infer ONE_LEVEL,
    /// which avoids level-shifting but does NOT consume Lock — libxkbcommon would still
    /// upper-case letters while Caps is on; see the type comment below.)
    fn build_keymap(unique: &[String]) -> String {
        let max_kc = 8 + unique.len() - 1; // unique is non-empty here
        let mut s = String::new();
        s.push_str("xkb_keymap {\n");
        s.push_str("xkb_keycodes \"(unnamed)\" {\n");
        s.push_str("minimum = 8;\n");
        s.push_str(&format!("maximum = {max_kc};\n"));
        for i in 0..unique.len() {
            let kc = 8 + i;
            s.push_str(&format!("<K{kc}> = {kc};\n"));
        }
        s.push_str("};\n");
        // Custom 1-level key type that CONSUMES Shift+Lock (every combo → Level1). A bare
        // single-symbol key infers ONE_LEVEL, whose modifier mask is empty, so Lock (Caps)
        // is never "consumed" — and libxkbcommon then upper-cases the keysym whenever the
        // compositor reports Caps as effective-active. KWin keeps the seat's physical Caps
        // regardless of our modifiers(0,0,0,0), so without consuming Lock here, lowercase
        // letters would type as uppercase while Caps Lock is on.
        s.push_str("xkb_types \"(unnamed)\" {\n");
        s.push_str("    include \"complete\"\n");
        s.push_str("    type \"FWF_LOCKPROOF\" {\n");
        s.push_str("        modifiers = Shift+Lock;\n");
        s.push_str("        map[None] = Level1;\n");
        s.push_str("        map[Shift] = Level1;\n");
        s.push_str("        map[Lock] = Level1;\n");
        s.push_str("        map[Shift+Lock] = Level1;\n");
        s.push_str("        level_name[Level1] = \"Any\";\n");
        s.push_str("    };\n");
        s.push_str("};\n");
        s.push_str("xkb_compatibility \"(unnamed)\" { include \"complete\" };\n");
        s.push_str("xkb_symbols \"(unnamed)\" {\n");
        for (i, name) in unique.iter().enumerate() {
            let kc = 8 + i;
            s.push_str(&format!("key <K{kc}> {{ type=\"FWF_LOCKPROOF\", [ {name} ] }};\n"));
        }
        s.push_str("};\n");
        s.push_str("};\n");
        s
    }

    /// Write the keymap (NUL-terminated) to a memfd the compositor can mmap.
    fn keymap_fd(keymap: &str) -> Result<(memfd::Memfd, u32), String> {
        let mut data = keymap.as_bytes().to_vec();
        data.push(0); // libxkbcommon expects a NUL-terminated buffer
        let mfd = MemfdOptions::default()
            .create("fwf-keymap")
            .map_err(|e| format!("memfd: {e}"))?;
        {
            let mut f = mfd.as_file();
            f.write_all(&data).map_err(|e| format!("keymap write: {e}"))?;
        }
        Ok((mfd, data.len() as u32))
    }

    #[cfg(test)]
    mod tests {
        use super::{build_keymap, keysym_name};
        use xkbcommon::xkb;

        // The virtual-keyboard path only runs on compositors that advertise the
        // protocol (wlroots: sway/Hyprland) — never on the dev machine (KWin), so the
        // generated keymap is otherwise untested. Verify it (a) compiles in the SAME
        // library the compositor uses, and (b) types each character verbatim even with
        // Caps Lock locked — i.e. the FWF_LOCKPROOF key type really suppresses the
        // capitalization transform. A regression here would silently type nothing (or
        // wrong case) for wlroots users.
        #[test]
        fn generated_keymap_compiles_and_is_caps_immune() {
            let chars = ['a', 'A', 'z', 'Q', '1', '!', 'ä', 'Ä', 'ß'];
            let mut unique: Vec<String> = Vec::new();
            for &c in &chars {
                let n = keysym_name(c).expect("printable char");
                if !unique.contains(&n) {
                    unique.push(n);
                }
            }
            let km_str = build_keymap(&unique);

            let ctx = xkb::Context::new(xkb::CONTEXT_NO_FLAGS);
            let keymap = xkb::Keymap::new_from_string(
                &ctx,
                km_str,
                xkb::KEYMAP_FORMAT_TEXT_V1,
                xkb::KEYMAP_COMPILE_NO_FLAGS,
            )
            .expect("generated keymap must compile in libxkbcommon");

            let caps = keymap.mod_get_index(xkb::MOD_NAME_CAPS);
            for &c in &chars {
                let idx = unique.iter().position(|n| *n == keysym_name(c).unwrap()).unwrap();
                let kc = xkb::Keycode::new((idx + 8) as u32);
                for caps_on in [false, true] {
                    let mut state = xkb::State::new(&keymap);
                    if caps_on {
                        state.update_mask(0, 0, 1 << caps, 0, 0, 0);
                    }
                    let got = state.key_get_utf8(kc);
                    assert_eq!(got, c.to_string(), "char {c:?} (caps_on={caps_on}) typed as {got:?}");
                }
            }
        }
    }
}
