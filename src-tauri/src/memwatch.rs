//! Webview memory in the log: every few minutes one `debug` line with each process's
//! private memory and its peak, plus the main window's current screen.
//!
//! Why: a main-window webview once peaked at 5.4 GB with nothing in the log to say when, or
//! on which screen. WebKitGTK runs every webview in its own `WebKitWebProcess` child, where
//! our own allocator stats cannot see it — /proc can. A spike also logs a `warn` (so it lands
//! in the log at the default level): once when a process crosses `WARN_ANON_MB` (re-armed
//! once it falls back under `REARM_ANON_MB`), and whenever a peak jumps by `WARN_PEAK_JUMP_MB`
//! between two samples. Linux only; `note_route` exists everywhere because the webview calls
//! it on every platform.

use std::sync::Mutex;

static ROUTE: Mutex<String> = Mutex::new(String::new());

/// The main window's current route (App.tsx, on every navigation), for the sample line.
#[tauri::command]
pub fn note_route(path: String) {
    // It goes into a log line: printable ASCII only, and short.
    let clean: String = path.chars().filter(|c| c.is_ascii_graphic()).take(80).collect();
    if let Ok(mut r) = ROUTE.lock() {
        *r = clean;
    }
}

#[cfg(target_os = "linux")]
pub fn spawn() {
    let _ = std::thread::Builder::new()
        .name("memwatch".into())
        .spawn(imp::run);
}

#[cfg(not(target_os = "linux"))]
pub fn spawn() {}

#[cfg(target_os = "linux")]
mod imp {
    use std::collections::HashMap;
    use std::time::Duration;

    const INTERVAL: Duration = Duration::from_secs(300);
    const WARN_ANON_MB: u64 = 1536;
    const REARM_ANON_MB: u64 = 1024;
    const WARN_PEAK_JUMP_MB: u64 = 1024;
    /// tauri.conf.json's creation order. WebKit starts one web process per webview as each
    /// window is built, so with exactly four children, pid order is this order; with any
    /// other count (a crashed and relaunched web process) the line falls back to pids.
    const LABELS: [&str; 4] = ["main", "overlay", "quickadd", "langpick"];

    #[derive(Default)]
    struct Seen {
        peak_mb: u64,
        warned: bool,
    }

    pub fn run() {
        let me = std::process::id();
        let mut seen: HashMap<u32, Seen> = HashMap::new();
        loop {
            std::thread::sleep(INTERVAL);
            sample(me, &mut seen);
        }
    }

    fn sample(me: u32, seen: &mut HashMap<u32, Seen>) {
        let mut web = children(me, "WebKitWebProces");
        web.sort_unstable();
        let route = super::ROUTE.lock().map(|r| r.clone()).unwrap_or_default();
        let mut line = format!("[mem] core {}M", anon_mb(me).unwrap_or(0));
        let mut alive = Vec::with_capacity(web.len());
        for (i, pid) in web.iter().copied().enumerate() {
            let (Some(anon), Some(peak)) = (anon_mb(pid), peak_mb(pid)) else { continue };
            alive.push(pid);
            let name = if web.len() == LABELS.len() { LABELS[i].to_string() } else { format!("web{pid}") };
            line.push_str(&format!(" | {name} {anon}M (peak {peak}M)"));
            let s = seen.entry(pid).or_insert_with(|| Seen { peak_mb: peak, warned: false });
            if anon >= WARN_ANON_MB && !s.warned {
                s.warned = true;
                tracing::warn!("[mem] {name} (pid {pid}) holds {anon}M private memory — screen {route}");
            } else if anon < REARM_ANON_MB {
                s.warned = false;
            }
            if peak >= s.peak_mb + WARN_PEAK_JUMP_MB {
                tracing::warn!(
                    "[mem] {name} (pid {pid}) peaked at {peak}M since the last sample (was {}M) — screen {route}",
                    s.peak_mb
                );
            }
            s.peak_mb = peak;
        }
        seen.retain(|pid, _| alive.contains(pid));
        for pid in children(me, "WebKitNetworkPr") {
            if let Some(anon) = anon_mb(pid) {
                line.push_str(&format!(" | network {anon}M"));
            }
        }
        if !route.is_empty() {
            line.push_str(&format!(" | screen {route}"));
        }
        tracing::debug!("{line}");
    }

    /// Direct children of `parent` whose comm (kernel-truncated to 15 bytes) is `comm`.
    fn children(parent: u32, comm: &str) -> Vec<u32> {
        let Ok(dir) = std::fs::read_dir("/proc") else { return Vec::new() };
        dir.flatten()
            .filter_map(|e| e.file_name().to_str()?.parse::<u32>().ok())
            .filter(|pid| {
                let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else { return false };
                // "pid (comm) state ppid …" — comm may itself hold spaces or parentheses.
                let (Some(open), Some(close)) = (stat.find('('), stat.rfind(')')) else { return false };
                let name = &stat[open + 1..close];
                let ppid = stat[close + 1..].split_whitespace().nth(1).and_then(|p| p.parse::<u32>().ok());
                name == comm && ppid == Some(parent)
            })
            .collect()
    }

    /// Proportional private (anonymous) memory — what the process itself allocated.
    fn anon_mb(pid: u32) -> Option<u64> {
        kb_field(&format!("/proc/{pid}/smaps_rollup"), "Pss_Anon:").map(|kb| kb / 1024)
    }

    /// The peak resident size over the process's life (VmHWM).
    fn peak_mb(pid: u32) -> Option<u64> {
        kb_field(&format!("/proc/{pid}/status"), "VmHWM:").map(|kb| kb / 1024)
    }

    fn kb_field(path: &str, key: &str) -> Option<u64> {
        let text = std::fs::read_to_string(path).ok()?;
        text.lines()
            .find_map(|l| l.strip_prefix(key))
            .and_then(|rest| rest.split_whitespace().next()?.parse().ok())
    }
}
