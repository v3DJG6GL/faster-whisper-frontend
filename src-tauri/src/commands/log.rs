//! Frontend diagnostic lines into the app log.

use crate::logging::FrameLineLimiter;
use std::sync::{Mutex, OnceLock};

/// Longest message `frontend_log` writes.
const FRONTEND_LOG_MAX: usize = 300;

/// Defang a frontend log line. The webview is ours, but whatever it logs lands in the support
/// log the user shares — so no control sequences or terminal escapes, no brackets or spaces
/// smuggled into the tag, and no unbounded lines.
fn sanitize_frontend_log(tag: &str, msg: &str) -> (String, String) {
    let tag_ok = (1..=16).contains(&tag.len()) && tag.bytes().all(|b| b.is_ascii_lowercase());
    let tag = if tag_ok { tag } else { "frontend" }.to_string();
    let msg = msg
        .chars()
        .filter(|c| (' '..='~').contains(c))
        .take(FRONTEND_LOG_MAX)
        .collect();
    (tag, msg)
}

/// One limiter for every line the webview sends, whatever its tag. The webview writes some of
/// its lines once per SERVER frame (a hard break's carry note per `final` + `boundary` pair),
/// so a streaming server flooding frames would grow the session log, which has no size cap,
/// through here as well. A window in time, not a count per session: an hours-long hands-free
/// session logs one such line per hard break and keeps them all.
static FRONTEND_LINES: OnceLock<Mutex<FrameLineLimiter>> = OnceLock::new();

/// The line that stands for `k` dropped webview lines.
fn suppressed_summary(k: u64) -> String {
    format!("[frontend] {k} further lines suppressed (flood)")
}

/// Account for one webview line at `now`: the report to write before it (lines dropped since
/// the last one), and whether the line itself is written. `now` is the core's clock — never a
/// value the webview sent. The lock is released before the caller writes anything.
fn admit_frontend_line(
    lines: &Mutex<FrameLineLimiter>,
    now: std::time::Instant,
) -> (Option<String>, bool) {
    let line = lines.lock().unwrap_or_else(|e| e.into_inner()).admit(now);
    (line.suppressed.map(suppressed_summary), line.log)
}

/// A diagnostic line from the frontend (e.g. the typed-baseline divergence notes), written to the
/// app log under `[tag]`. Uses the default target so the user's configured log level applies.
/// Callers send indices, lengths and character classes — never dictated text.
#[tauri::command]
pub fn frontend_log(level: String, tag: String, msg: String) {
    let now = std::time::Instant::now();
    let lines = FRONTEND_LINES.get_or_init(|| Mutex::new(FrameLineLimiter::new(now)));
    let (report, log) = admit_frontend_line(lines, now);
    if let Some(report) = report {
        tracing::warn!("{report}");
    }
    if !log {
        return;
    }
    let (tag, msg) = sanitize_frontend_log(&tag, &msg);
    match level.as_str() {
        "warn" | "warning" | "error" => tracing::warn!("[{tag}] {msg}"),
        _ => tracing::info!("[{tag}] {msg}"),
    }
}

#[cfg(test)]
mod tests {
    /// A flood of webview lines: the window's allowance passes, the rest is only counted, and
    /// the count is reported once, ahead of the next window's first line.
    #[test]
    fn frontend_lines_past_the_limit_are_counted_and_reported_once() {
        use super::{admit_frontend_line, FrameLineLimiter};
        use std::time::Duration;
        let max = FrameLineLimiter::MAX_LINES;
        assert_eq!(max, 20);
        let t0 = std::time::Instant::now();
        let lines = std::sync::Mutex::new(FrameLineLimiter::new(t0));
        for i in 0..max {
            assert_eq!(admit_frontend_line(&lines, t0), (None, true), "line {i}");
        }
        // The 21st and everything after it in the same second: not written, nothing reported.
        let late = t0 + FrameLineLimiter::WINDOW - Duration::from_millis(1);
        for at in [t0, late, late] {
            assert_eq!(admit_frontend_line(&lines, at), (None, false));
        }
        // The window rolls: one report for the three, and the line that came with it passes.
        let next = t0 + FrameLineLimiter::WINDOW;
        assert_eq!(
            admit_frontend_line(&lines, next),
            (
                Some("[frontend] 3 further lines suppressed (flood)".to_string()),
                true
            )
        );
        assert_eq!(admit_frontend_line(&lines, next), (None, true));
        // Said once: a later window has nothing left to report.
        let after = next + FrameLineLimiter::WINDOW;
        assert_eq!(admit_frontend_line(&lines, after), (None, true));
    }

    /// Lines at a real rate — one per hard break, for hours — all pass.
    #[test]
    fn frontend_lines_at_a_real_rate_all_pass() {
        use super::{admit_frontend_line, FrameLineLimiter};
        let t0 = std::time::Instant::now();
        let lines = std::sync::Mutex::new(FrameLineLimiter::new(t0));
        // Three lines every 2 s for four hours.
        for step in 0..7_200u64 {
            let now = t0 + std::time::Duration::from_secs(step * 2);
            for _ in 0..3 {
                assert_eq!(admit_frontend_line(&lines, now), (None, true), "{step}");
            }
        }
    }

    #[test]
    fn frontend_log_is_defanged() {
        use super::sanitize_frontend_log;
        assert_eq!(
            sanitize_frontend_log("typed", "diverged at 12/40"),
            ("typed".to_string(), "diverged at 12/40".to_string())
        );
        // A tag that is not 1-16 lowercase letters falls back, so it cannot forge a prefix.
        for bad in ["", "winclip]", "Typed", "a-b", "abcdefghijklmnopq"] {
            assert_eq!(sanitize_frontend_log(bad, "x").0, "frontend", "{bad:?}");
        }
        // Controls and non-ASCII are dropped; the message is capped.
        assert_eq!(
            sanitize_frontend_log("t", "a\x1b[31mb\nc\u{202e}d\u{fc}").1,
            "a[31mbcd"
        );
        assert_eq!(sanitize_frontend_log("t", &"x".repeat(1000)).1.len(), 300);
    }
}
