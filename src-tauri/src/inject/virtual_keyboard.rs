//! Layout- & Caps-independent text typing on Linux Wayland via the
//! `zwp_virtual_keyboard_v1` protocol (wlroots: sway/Hyprland; the `wtype`/`wvkbd` approach).
//!
//! The portal keycode path (`wayland.rs`) injects raw evdev codes that KWin
//! resolves under the LIVE seat state — so a locked Caps Lock inverts letter case,
//! and characters not reachable on the active layout don't type at all. Here we
//! instead UPLOAD OUR OWN one-shot keymap in which every needed character is its own
//! keycode bound directly to its keysym, on a single level whose key type CONSUMES
//! Shift+Lock. The compositor then types exactly those characters regardless of Caps
//! Lock, the active layout, or even a physically-held Shift. No portal consent dialog
//! either.
//!
//! GNOME does not implement this protocol and KWin does not offer it to us; `type_text`
//! returns Err there (and on any failure); `inject_text` falls back to the portal path only
//! when no key was transmitted yet (`VkError::after_typing == false`).
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
#[cfg_attr(windows, allow(dead_code))] // the consuming worker is Linux-only (zwp_virtual_keyboard)
pub struct VkJob {
    text: String,
    auto_enter: bool,
    reply: oneshot::Sender<Result<crate::inject::Landed, VkError>>,
    /// See `crate::inject::injection_epoch` — lets the per-key loop abandon a superseded job.
    epoch: u64,
    /// "Is one of our own windows focused right now?" — passed in because this job is served by
    /// the bare `std::thread` that owns the Wayland connection and has no `AppHandle`. Same
    /// predicate and cross-thread safety argument as `inject::OwnWindowFocused`.
    own_window_focused: std::sync::Arc<dyn Fn() -> bool + Send + Sync>,
}

#[cfg_attr(windows, allow(dead_code))] // Active is only constructed by the Linux worker startup
#[derive(Default)]
enum VkChannel {
    #[default]
    Unstarted,
    Active(mpsc::UnboundedSender<VkJob>),
    /// Determined unsupported (no protocol / init failed) — don't retry; fall back.
    Unavailable,
}

/// Managed state: the lazily-started channel to the virtual-keyboard thread.
#[derive(Default)]
pub struct VirtualKeyboard(Mutex<VkChannel>);

/// Type `text` (then an optional Enter) via the virtual keyboard. On Err, check
/// `VkError::after_typing` before falling back to the portal; the setup/plumbing failures here
/// are all "nothing typed yet".
/// `epoch` is captured by the CALLER at the top of `inject_text`, not here: queuing happens
/// after up to ~1.2s of pre-work, and a cancel landing in that window would otherwise be read
/// as this job's own starting generation.
pub async fn type_text(
    vk: &VirtualKeyboard,
    text: &str,
    auto_enter: bool,
    epoch: u64,
    own_window_focused: std::sync::Arc<dyn Fn() -> bool + Send + Sync>,
) -> Result<crate::inject::Landed, VkError> {
    let tx = ensure_started(vk).await.map_err(|message| VkError {
        message,
        after_typing: false,
    })?;
    let (reply, reply_rx) = oneshot::channel();
    tx.send(VkJob {
        text: text.to_string(),
        auto_enter,
        reply,
        epoch,
        own_window_focused,
    })
    .map_err(|_| VkError {
        message: "virtual keyboard thread gone".into(),
        after_typing: false,
    })?;
    reply_rx.await.map_err(|_| VkError {
        message: "virtual keyboard dropped the job".into(),
        after_typing: false,
    })?
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
    pub fn run_thread(
        mut rx: mpsc::UnboundedReceiver<VkJob>,
        init: oneshot::Sender<Result<(), String>>,
    ) {
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
            let res = conn.type_text(
                &job.text,
                job.auto_enter,
                job.epoch,
                job.own_window_focused.as_ref(),
            );
            let failed = res.is_err();
            let _ = job.reply.send(res);
            if failed {
                // Most type_text errors are a failed roundtrip/flush — the wl connection is likely dead.
                // Break so rx drops; ensure_started sees the closed channel (tx.is_closed) and respawns
                // a fresh connection on the next call (mirrors wayland::session_loop's self-heal),
                // instead of every later injection silently falling back to the portal. A non-fatal
                // one (the size cap, a memfd failure) just costs one reconnect.
                break;
            }
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
            let conn =
                Connection::connect_to_env().map_err(|e| format!("no Wayland connection: {e}"))?;
            let (globals, mut queue) = registry_queue_init::<St>(&conn)
                .map_err(|e| format!("registry init failed: {e}"))?;
            let qh = queue.handle();
            // The deciding bind: absent on GNOME and KWin → caller falls back to the portal.
            let mgr: ZwpVirtualKeyboardManagerV1 = globals.bind(&qh, 1..=1, ()).map_err(|_| {
                "zwp_virtual_keyboard_manager_v1 not advertised (compositor unsupported)"
                    .to_string()
            })?;
            let seat: WlSeat = globals
                .bind(&qh, 1..=8, ())
                .map_err(|e| format!("no wl_seat: {e}"))?;
            let vk = mgr.create_virtual_keyboard(&seat, &qh, ());
            let mut state = St;
            // Flush the create + settle the protocol objects.
            queue
                .roundtrip(&mut state)
                .map_err(|e| format!("roundtrip failed: {e}"))?;
            Ok(Self {
                conn,
                queue,
                state,
                vk,
                start: Instant::now(),
            })
        }

        fn type_text(
            &mut self,
            text: &str,
            auto_enter: bool,
            epoch: u64,
            own_window_focused: &(dyn Fn() -> bool + Send + Sync),
        ) -> Result<crate::inject::Landed, VkError> {
            // Helper: an error raised BEFORE any key was transmitted (the size limit below) is safe
            // to fall back to the portal. `before` builds those; the per-batch keymap upload
            // decides by `emitted` instead.
            let before = |e: String| VkError {
                message: e,
                after_typing: false,
            };
            // Bound the input BEFORE the per-character allocation below. `order` is one heap
            // `String` per input character, ~50-60 bytes each against 1 byte of ASCII input — so
            // a transcript at the 32 MiB body cap becomes ~1.8 GB here, and the per-keymap
            // batching further down does not bound it. Too large falls back to the portal path,
            // which holds the text as one `String`. 1 MiB is ~2 hours of typing at this loop's
            // 8ms/key — no real dictation approaches it.
            const MAX_VK_TEXT_BYTES: usize = 1 << 20;
            if text.len() > MAX_VK_TEXT_BYTES {
                return Err(before(
                    "transcript too large for the virtual keyboard".into(),
                ));
            }
            // Control chars dropped, Enter/Tab named: the same mapping as the portal path.
            let mut order: Vec<String> = text.chars().filter_map(keysym_name).collect();
            if auto_enter {
                order.push("Return".to_string());
            }
            if order.is_empty() {
                return Ok(crate::inject::Landed::Yes);
            }
            // Before the keymap upload, not only between keys: a cancel that already landed
            // then costs no memfd / keymap roundtrip (the in-loop check covers the bare
            // auto-Enter job's single element either way). `Ok(Landed::Yes)` and not
            // an error, because an error here reports `after_typing: false` and the portal
            // fallback would then type the very text the user cancelled.
            if crate::inject::injection_cancelled(epoch) {
                tracing::info!("[vkbd] cancelled before typing — dropping the job");
                return Ok(crate::inject::Landed::Yes);
            }
            // Own-window re-check at the sink, the sibling of the cancel check above and of the
            // guard the X11/Windows and Wayland-paste arms already carry. `inject_text`'s last
            // own-window check (right after the held-modifier wait) ran before the latch consume,
            // the `focused_app_now` snapshot read and `ensure_started`'s thread spawn + Wayland
            // connect — and this job may also have queued behind another. `NothingWritten` is
            // truthful (no key has been transmitted) and makes the caller's re-send safe rather
            // than duplicating text.
            if own_window_focused() {
                tracing::info!("[vkbd] skipped before typing: our own window holds focus");
                return Ok(crate::inject::Landed::NothingWritten);
            }
            // Once the FIRST press-flush succeeds, key events have been transmitted — a later flush
            // failure (compositor crash mid-typing) leaves an already-landed prefix, so the portal
            // must NOT re-type the whole text (it would duplicate it). Track that with `emitted`.
            let mut emitted = false;
            let last = order.len() - 1;
            // The keymap cap is per UPLOAD, not per job: a long CJK dictation easily has more
            // distinct symbols, and the portal would skip every character the layout cannot
            // produce (or is unavailable on wlroots). So the job is typed in consecutive batches,
            // each with its own keymap.
            for batch in split_batches(&order, MAX_KEYMAP_SYMBOLS) {
                // A keymap failure is only "nothing typed yet" for the first batch; after that, a
                // prefix has landed and the portal must not re-type the whole text.
                let fail = |message: String| VkError {
                    message,
                    after_typing: emitted,
                };
                // Distinct symbols, in first-seen order → one keycode each (xkb = idx + 8).
                let mut unique: Vec<String> = Vec::new();
                let mut idx_of: HashMap<&str, u32> = HashMap::new();
                for name in &order[batch.clone()] {
                    if !idx_of.contains_key(name.as_str()) {
                        idx_of.insert(name, unique.len() as u32);
                        unique.push(name.clone());
                    }
                }

                let keymap = build_keymap(&unique);
                let (mfd, size) = keymap_fd(&keymap).map_err(fail)?;
                self.vk.keymap(
                    1, /* WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1 */
                    mfd.as_file().as_fd(),
                    size,
                );
                // Ensure the compositor has read + compiled the keymap before we send keys.
                self.queue
                    .roundtrip(&mut self.state)
                    .map_err(|e| fail(e.to_string()))?;
                drop(mfd);

                // Zero our own modifier state. Belt-and-suspenders: on wlroots this clears any
                // Caps the seat adopted from us; the real Caps-immunity (a seat that keeps the
                // physical Caps) comes from the keymap's Lock-consuming key type.
                self.vk.modifiers(0, 0, 0, 0);

                for (i, name) in order.iter().enumerate().take(batch.end).skip(batch.start) {
                    // Follow focus while typing, not only before the job. This loop runs at ~8ms
                    // per key, so a long transcript occupies it for seconds and a click into one
                    // of our own windows part-way through otherwise lands every remaining key
                    // there. Probed every 64 keys (~0.5s) rather than per key, because each probe
                    // is a round trip to the UI thread and that coupling is the accepted cost of
                    // this mechanism.
                    //
                    // Also probed immediately before every Return whatever the count, a line
                    // break in the text and the FINAL key of an auto-Enter job alike (see
                    // `probes_focus_before`).
                    let probe_here = probes_focus_before(i, name) || (auto_enter && i == last);
                    if probe_here && own_window_focused() {
                        tracing::info!("[vkbd] stopped: our own window took focus ({i} keys in)");
                        // The prefix already on screen stays — re-sending it would duplicate text —
                        // so the tail is dropped and this reports as landed, like the mid-typing
                        // cancel below. With nothing emitted yet the truthful answer is
                        // `NothingWritten`, which makes a re-send safe.
                        return Ok(if emitted {
                            crate::inject::Landed::Yes
                        } else {
                            crate::inject::Landed::NothingWritten
                        });
                    }
                    // Same mid-typing cancellation as the portal path. `Ok(Landed::Yes)` whether
                    // or not a key went out: only an Err with `after_typing: false` reaches the
                    // portal fallback in inject/text.rs, so the landed prefix is never re-typed;
                    // and a user cancel is not a transport failure, so run_thread must not tear
                    // the connection down for it. Also covers a bare auto-Enter job
                    // (`order == ["Return"]`) cancelled during the keymap upload since the
                    // pre-loop check — nothing is synthesized.
                    if crate::inject::injection_cancelled(epoch) {
                        tracing::info!("[vkbd] cancelled mid-typing — stopping");
                        return Ok(crate::inject::Landed::Yes);
                    }
                    let code = idx_of[name.as_str()];
                    let t = self.start.elapsed().as_millis() as u32;
                    // Pressed. A failed press-flush BEFORE the first success transmitted nothing →
                    // safe fallback.
                    self.vk.key(t, code, 1);
                    self.conn.flush().map_err(|e| VkError {
                        message: e.to_string(),
                        after_typing: emitted,
                    })?;
                    emitted = true; // a key-down was transmitted (the char likely registered on key-down)
                    std::thread::sleep(Duration::from_millis(3));
                    let t = self.start.elapsed().as_millis() as u32;
                    self.vk.key(t, code, 0); // released
                    self.conn.flush().map_err(|e| VkError {
                        message: e.to_string(),
                        after_typing: true,
                    })?;
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
            // Drain so the compositor has processed everything before we report done.
            self.queue.roundtrip(&mut self.state).map_err(|e| VkError {
                message: e.to_string(),
                after_typing: emitted,
            })?;
            Ok(crate::inject::Landed::Yes)
        }
    }

    /// Whether the typing loop asks who holds focus before key `i` (keysym `name`) of the job:
    /// every 64 keys (see the loop for the cadence), and before every Return whatever the count.
    /// Return is the one keystroke that ACTS rather than inserts, so firing it into our own window
    /// presses whatever button holds focus there; a line break in the transcript types one just
    /// like the auto-Enter does.
    fn probes_focus_before(i: usize, name: &str) -> bool {
        i > 0 && (i.is_multiple_of(64) || name == "Return")
    }

    /// Distinct symbols one uploaded keymap can hold: xkb keycodes run 8..=255.
    const MAX_KEYMAP_SYMBOLS: usize = 248;

    /// Split `order` into consecutive ranges, each with at most `cap` distinct names, so each can
    /// be typed under its own keymap. The ranges are contiguous, in order, and cover `order`.
    fn split_batches(order: &[String], cap: usize) -> Vec<std::ops::Range<usize>> {
        let mut batches = Vec::new();
        let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
        let mut start = 0;
        for (i, name) in order.iter().enumerate() {
            if !seen.contains(name.as_str()) {
                if seen.len() == cap {
                    batches.push(start..i);
                    start = i;
                    seen.clear();
                }
                seen.insert(name);
            }
        }
        if start < order.len() {
            batches.push(start..order.len());
        }
        batches
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
    /// a held Shift or a locked Caps (see the type comment below).
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
        // compositor reports Caps as effective-active. A seat can keep the physical Caps
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
            s.push_str(&format!(
                "key <K{kc}> {{ type=\"FWF_LOCKPROOF\", [ {name} ] }};\n"
            ));
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
            f.write_all(&data)
                .map_err(|e| format!("keymap write: {e}"))?;
        }
        Ok((mfd, data.len() as u32))
    }

    #[cfg(test)]
    mod tests {
        use super::{
            build_keymap, keysym_name, probes_focus_before, split_batches, MAX_KEYMAP_SYMBOLS,
        };
        use xkbcommon::xkb;

        // A line break inside the transcript types Return, which presses whatever button holds
        // focus in our own window: it is probed before like the auto-Enter, not only on the
        // 64-key cadence. The very first key is covered by the check before the job.
        #[test]
        fn a_line_break_in_the_text_probes_focus_before_its_return() {
            let order: Vec<String> = "Hi team,\nthanks\r"
                .chars()
                .filter_map(keysym_name)
                .collect();
            let probed: Vec<usize> = order
                .iter()
                .enumerate()
                .filter(|&(i, name)| probes_focus_before(i, name))
                .map(|(i, _)| i)
                .collect();
            assert_eq!(probed, [8, 15]);
            assert!(probes_focus_before(64, "U0061"));
            assert!(!probes_focus_before(63, "U0061"));
            assert!(!probes_focus_before(0, "Return"));
        }

        // A job with more distinct symbols than one keymap holds (a long CJK dictation) is typed
        // in batches instead of being rejected: each batch fits the keymap cap, and together they
        // cover the input in order.
        #[test]
        fn split_batches_caps_distinct_symbols_per_batch() {
            let order: Vec<String> = (0..300u32)
                .map(|i| keysym_name(char::from_u32(0x4e00 + i).unwrap()).unwrap())
                .collect();
            let batches = split_batches(&order, MAX_KEYMAP_SYMBOLS);
            assert_eq!(batches.len(), 2);
            let mut joined: Vec<String> = Vec::new();
            for b in &batches {
                let distinct: std::collections::HashSet<&String> =
                    order[b.clone()].iter().collect();
                assert!(distinct.len() <= MAX_KEYMAP_SYMBOLS);
                joined.extend_from_slice(&order[b.clone()]);
            }
            assert_eq!(joined, order);

            // Repeats of already-seen symbols never start a new batch.
            let mut small = vec!["a".to_string(), "b".to_string(), "a".to_string()];
            assert_eq!(split_batches(&small, 2), vec![0..3]);
            small.push("c".to_string());
            assert_eq!(split_batches(&small, 2), vec![0..3, 3..4]);
            assert!(split_batches(&[], 2).is_empty());
        }

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
                let idx = unique
                    .iter()
                    .position(|n| *n == keysym_name(c).unwrap())
                    .unwrap();
                let kc = xkb::Keycode::new((idx + 8) as u32);
                for caps_on in [false, true] {
                    let mut state = xkb::State::new(&keymap);
                    if caps_on {
                        state.update_mask(0, 0, 1 << caps, 0, 0, 0);
                    }
                    let got = state.key_get_utf8(kc);
                    assert_eq!(
                        got,
                        c.to_string(),
                        "char {c:?} (caps_on={caps_on}) typed as {got:?}"
                    );
                }
            }
        }
    }
}
