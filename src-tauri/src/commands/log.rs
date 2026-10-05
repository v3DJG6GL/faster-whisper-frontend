//! Frontend diagnostic lines into the app log.

/// Longest message `frontend_log` writes.
const FRONTEND_LOG_MAX: usize = 300;

/// Defang a frontend log line: the tag must be 1–16 lowercase ASCII letters (else "frontend"),
/// the message keeps printable ASCII only and at most `FRONTEND_LOG_MAX` characters. The webview
/// is ours, but whatever it logs lands in the support log the user shares — so no control
/// sequences or terminal escapes, no brackets or spaces smuggled into the tag, and no unbounded
/// lines.
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

/// A diagnostic line from the frontend (e.g. the typed-baseline divergence notes), written to the
/// app log under `[tag]`. Uses the default target so the user's configured log level applies.
/// Callers send indices, lengths and character classes — never dictated text.
#[tauri::command]
pub fn frontend_log(level: String, tag: String, msg: String) {
    let (tag, msg) = sanitize_frontend_log(&tag, &msg);
    match level.as_str() {
        "warn" | "warning" | "error" => tracing::warn!("[{tag}] {msg}"),
        _ => tracing::info!("[{tag}] {msg}"),
    }
}

#[cfg(test)]
mod tests {
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
