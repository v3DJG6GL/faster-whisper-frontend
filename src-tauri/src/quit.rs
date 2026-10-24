//! The quit handshake. A real exit (`app.exit`) never fires the webview's `beforeunload`, so the
//! main window's pending writes would be lost on quit: History writes it has coalesced (up to
//! 2 s), History edits still in their 800 ms debounce, the 400 ms debounced config save and the
//! 300 ms debounced usage-outcome queue save. Tray "Quit" and the trayless main-window close
//! therefore ask the main window first: emit `app://before-quit`, wait (bounded) for its
//! `quit_ready` once it has landed all four, then run the usual exit sequence either way.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// How long the exit waits for the main window's `quit_ready` before going ahead regardless.
const READY_WAIT: Duration = Duration::from_millis(1500);

/// Set by the first quit request: a second Quit click while one is pending is a no-op.
static QUITTING: AtomicBool = AtomicBool::new(false);
static READY: Mutex<bool> = Mutex::new(false);
static READY_CV: Condvar = Condvar::new();

/// Drop any live dictation first (app.exit ends the process without running managed-state
/// destructors, so a mute_system session would otherwise leave the system audio muted), then exit.
fn exit_now(app: &AppHandle) {
    crate::session::cleanup_for_exit(app);
    app.exit(0);
}

/// Quit after giving the main window a chance to land its pending writes. Exits at once when
/// there is no main window to ask (or the ask can't be sent).
pub fn request_quit(app: &AppHandle) {
    if QUITTING.swap(true, Ordering::SeqCst) {
        return;
    }
    if app.get_webview_window("main").is_none()
        || app.emit_to("main", "app://before-quit", ()).is_err()
    {
        exit_now(app);
        return;
    }
    let waiter = app.clone();
    let spawned = std::thread::Builder::new()
        .name("quit-handshake".into())
        .spawn(move || {
            if !wait_ready(READY_WAIT) {
                tracing::warn!(
                    "[quit] main window did not confirm within {}ms; exiting anyway",
                    READY_WAIT.as_millis()
                );
            }
            // Exit on the main thread, as the no-handshake path does.
            let main = waiter.clone();
            if waiter.run_on_main_thread(move || exit_now(&main)).is_err() {
                exit_now(&waiter);
            }
        });
    if spawned.is_err() {
        exit_now(app);
    }
}

/// The main window has flushed (`quit_ready`): release the waiting exit.
pub fn signal_ready() {
    *READY.lock().unwrap_or_else(|e| e.into_inner()) = true;
    READY_CV.notify_all();
}

/// Block until `signal_ready` or `max` elapses; true when signalled.
fn wait_ready(max: Duration) -> bool {
    let ready = READY.lock().unwrap_or_else(|e| e.into_inner());
    let (_ready, res) = READY_CV
        .wait_timeout_while(ready, max, |r| !*r)
        .unwrap_or_else(|e| e.into_inner());
    !res.timed_out()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn wait_ready_returns_once_signalled_well_before_the_cap() {
        let t = std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(20));
            signal_ready();
        });
        let started = Instant::now();
        assert!(wait_ready(Duration::from_secs(10)));
        assert!(started.elapsed() < Duration::from_secs(5));
        t.join().unwrap();
    }
}
