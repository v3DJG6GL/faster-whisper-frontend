//! Webview memory in the log: every few minutes one `debug` line with each process's
//! private memory and its peak, plus the main window's current screen.
//!
//! Why: a main-window webview once peaked at 5.4 GB with nothing in the log to say when, or
//! on which screen. WebKitGTK runs every webview in its own `WebKitWebProcess` child, where
//! our own allocator stats cannot see it — /proc can. A spike also logs a `warn` (so it lands
//! in the log at the default level): once when a process crosses `WARN_ANON_MB` (re-armed
//! once it falls back under `REARM_ANON_MB`), and whenever a peak jumps by `WARN_PEAK_JUMP_MB`
//! between two samples (or, the first time a process is seen, when its peak is already over
//! `WARN_ANON_MB`); a peak warning is skipped when the same sample already logged the
//! crossing warning, so one spike is one warn line. Linux only; `note_route` exists everywhere because the webview calls
//! it on every platform.

use std::sync::Mutex;

static ROUTE: Mutex<String> = Mutex::new(String::new());

/// The main window's current route (App.tsx, on every navigation), for the sample line.
#[tauri::command]
pub fn note_route(path: String) {
    // It goes into a log line: printable ASCII only, and short.
    let clean: String = path
        .chars()
        .filter(|c| c.is_ascii_graphic())
        .take(80)
        .collect();
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
    /// window is built, so at the first sample with exactly four children, pid order is this
    /// order: the labels are pinned to those pids then, once per run. A process outside that set
    /// (e.g. a crashed and relaunched web process, which takes the newest pid) shows as
    /// `web<pid>` — even once every pinned process is gone: four relaunched pids in sorted order
    /// no longer say which window is which.
    const LABELS: [&str; 4] = ["main", "overlay", "quickadd", "langpick"];

    #[derive(Default)]
    struct Seen {
        peak_mb: u64,
        warned: bool,
    }

    pub fn run() {
        let me = std::process::id();
        let mut seen: HashMap<u32, Seen> = HashMap::new();
        let mut labels: HashMap<u32, &'static str> = HashMap::new();
        let mut pinned = false;
        loop {
            std::thread::sleep(INTERVAL);
            sample(me, &mut seen, &mut labels, &mut pinned);
        }
    }

    /// Pins `LABELS` to `web` (sorted) the first time exactly four web processes exist, and
    /// forgets pids that are gone, so the map stays bounded. `pinned` keeps it the first time
    /// only: the map empties again once every pinned pid is gone (all four relaunched, or one
    /// sample whose /proc read failed), and re-pinning then would name windows by relaunch order.
    fn pin_labels(labels: &mut HashMap<u32, &'static str>, pinned: &mut bool, web: &[u32]) {
        labels.retain(|pid, _| web.contains(pid));
        if !*pinned && web.len() == LABELS.len() {
            labels.extend(web.iter().copied().zip(LABELS));
            *pinned = true;
        }
    }

    fn label(labels: &HashMap<u32, &'static str>, pid: u32) -> String {
        labels
            .get(&pid)
            .map(|l| l.to_string())
            .unwrap_or_else(|| format!("web{pid}"))
    }

    fn sample(
        me: u32,
        seen: &mut HashMap<u32, Seen>,
        labels: &mut HashMap<u32, &'static str>,
        pinned: &mut bool,
    ) {
        let mut web = children(me, "WebKitWebProces");
        web.sort_unstable();
        pin_labels(labels, pinned, &web);
        let route = super::ROUTE.lock().map(|r| r.clone()).unwrap_or_default();
        let mut line = format!("[mem] core {}M", anon_mb(me).unwrap_or(0));
        let mut alive = Vec::with_capacity(web.len());
        for pid in web.iter().copied() {
            let (Some(anon), Some(peak)) = (anon_mb(pid), peak_mb(pid)) else {
                continue;
            };
            alive.push(pid);
            let name = label(labels, pid);
            line.push_str(&format!(" | {name} {anon}M (peak {peak}M)"));
            // A first-seen process (the first sample, or a relaunched web process) is seeded
            // with its current peak, so the jump check below cannot fire for it: a spike that
            // has already receded by then would otherwise only reach the debug line.
            let is_new = !seen.contains_key(&pid);
            let s = seen.entry(pid).or_insert_with(|| Seen {
                peak_mb: peak,
                warned: false,
            });
            // A spike that crosses the line usually also trips a peak warning below (VmHWM
            // never sits below Pss_Anon, and a fast climb jumps the peak too): the crossing
            // line carries the peak, so either peak warning is suppressed — one event, one
            // warn line.
            let mut warned_now = false;
            if anon >= WARN_ANON_MB && !s.warned {
                s.warned = true;
                warned_now = true;
                tracing::warn!(
                    "[mem] {name} (pid {pid}) holds {anon}M private memory (peak {peak}M) — screen {route}"
                );
            } else if anon < REARM_ANON_MB {
                s.warned = false;
            }
            if is_new && peak >= WARN_ANON_MB {
                if !warned_now {
                    tracing::warn!(
                        "[mem] {name} (pid {pid}) peaked at {peak}M since launch — screen {route}"
                    );
                }
            } else if !warned_now && peak >= s.peak_mb + WARN_PEAK_JUMP_MB {
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
        let Ok(dir) = std::fs::read_dir("/proc") else {
            return Vec::new();
        };
        dir.flatten()
            .filter_map(|e| e.file_name().to_str()?.parse::<u32>().ok())
            .filter(|pid| {
                let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
                    return false;
                };
                // "pid (comm) state ppid …" — comm may itself hold spaces or parentheses.
                let (Some(open), Some(close)) = (stat.find('('), stat.rfind(')')) else {
                    return false;
                };
                let name = &stat[open + 1..close];
                let ppid = stat[close + 1..]
                    .split_whitespace()
                    .nth(1)
                    .and_then(|p| p.parse::<u32>().ok());
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

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn labels_stay_on_their_pids_after_a_web_process_relaunch() {
            let (mut labels, mut pinned) = (HashMap::new(), false);
            pin_labels(&mut labels, &mut pinned, &[10, 11, 12, 13]);
            assert_eq!(label(&labels, 12), "quickadd");
            // quickadd's web process crashed; WebKit relaunched it with a newer pid, so the
            // count is four again but sorted order no longer matches creation order.
            let web = [10, 11, 13, 14];
            pin_labels(&mut labels, &mut pinned, &web);
            let names: Vec<String> = web.iter().map(|&p| label(&labels, p)).collect();
            assert_eq!(names, ["main", "overlay", "langpick", "web14"]);
        }

        #[test]
        fn labels_wait_for_exactly_four_web_processes() {
            let (mut labels, mut pinned) = (HashMap::new(), false);
            pin_labels(&mut labels, &mut pinned, &[10, 11]);
            assert_eq!(label(&labels, 10), "web10");
            pin_labels(&mut labels, &mut pinned, &[10, 11, 12, 13]);
            assert_eq!(label(&labels, 10), "main");
            assert_eq!(label(&labels, 13), "langpick");
        }

        #[test]
        fn labels_are_not_re_pinned_once_every_pinned_process_is_gone() {
            let names = |labels: &HashMap<u32, &'static str>, web: &[u32]| -> Vec<String> {
                web.iter().map(|&p| label(labels, p)).collect()
            };
            // One sample whose /proc read failed (no children), then four relaunched pids.
            let (mut labels, mut pinned) = (HashMap::new(), false);
            pin_labels(&mut labels, &mut pinned, &[10, 11, 12, 13]);
            pin_labels(&mut labels, &mut pinned, &[]);
            let web = [20, 21, 22, 23];
            pin_labels(&mut labels, &mut pinned, &web);
            assert_eq!(names(&labels, &web), ["web20", "web21", "web22", "web23"]);
            // All four relaunched between two samples.
            let (mut labels, mut pinned) = (HashMap::new(), false);
            pin_labels(&mut labels, &mut pinned, &[10, 11, 12, 13]);
            let web = [14, 15, 16, 17];
            pin_labels(&mut labels, &mut pinned, &web);
            assert_eq!(names(&labels, &web), ["web14", "web15", "web16", "web17"]);
        }
    }
}
