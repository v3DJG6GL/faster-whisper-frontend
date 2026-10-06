//! One policy for cpal stream errors, shared by every capture path.
//!
//! cpal calls the error callback from its audio thread, and a backend stuck in a bad state can
//! call it thousands of times a second: cpal 0.17's ALSA worker reported each POLLERR and polled
//! again without recovering, which wrote ~25k log lines/s and froze hands-free dictation. 0.18
//! recovers from that one, but the callback must never again be able to flood the log or keep a
//! dead stream "running". So:
//!
//! - `DeviceNotAvailable` / `StreamInvalidated` are terminal: the caller stops the stream.
//! - Everything else is logged, throttled: the first one at once, then one summary line with the
//!   number suppressed at most every [`LOG_EVERY`].
//! - An error storm (more than [`STORM_PER_SEC`] errors in each of [`STORM_SECS`] consecutive
//!   seconds) is treated as terminal too — no healthy stream reports errors at that rate.
//! - Terminal latches: once the gate has said so, every later error is Terminal again without
//!   another log line, so the errors cpal reports before the caller drops the stream stay quiet.

use cpal::ErrorKind;
use std::time::{Duration, Instant};

const LOG_EVERY: Duration = Duration::from_secs(5);
const STORM_PER_SEC: u32 = 200;
const STORM_SECS: u32 = 2;

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Logged (or counted); the stream keeps running.
    Continue,
    /// The stream is gone or unusable; stop it.
    Terminal,
}

pub struct ErrorGate {
    tag: &'static str,
    last_log: Option<Instant>,
    suppressed: u64,
    sec_start: Option<Instant>,
    sec_count: u32,
    hot_secs: u32,
    tripped: bool,
}

impl ErrorGate {
    pub fn new(tag: &'static str) -> Self {
        ErrorGate {
            tag,
            last_log: None,
            suppressed: 0,
            sec_start: None,
            sec_count: 0,
            hot_secs: 0,
            tripped: false,
        }
    }

    pub fn on_error(&mut self, kind: ErrorKind, msg: &str, now: Instant) -> Verdict {
        if self.tripped {
            return Verdict::Terminal;
        }
        if matches!(
            kind,
            ErrorKind::DeviceNotAvailable | ErrorKind::StreamInvalidated
        ) {
            tracing::warn!("[{}] device lost ({kind:?}): {msg}", self.tag);
            self.tripped = true;
            return Verdict::Terminal;
        }

        // Per-second buckets for the storm breaker. A hot bucket only counts toward a storm when
        // the next one follows straight on; a quiet gap in between resets the streak.
        match self.sec_start {
            Some(start) if now.duration_since(start) < Duration::from_secs(1) => {}
            _ => {
                if let Some(start) = self.sec_start {
                    let adjacent = now.duration_since(start) < Duration::from_secs(2);
                    if self.sec_count > STORM_PER_SEC && adjacent {
                        self.hot_secs += 1;
                    } else {
                        self.hot_secs = 0;
                    }
                }
                self.sec_start = Some(now);
                self.sec_count = 0;
            }
        }
        self.sec_count = self.sec_count.saturating_add(1);
        if self.hot_secs >= STORM_SECS {
            tracing::warn!(
                "[{}] error storm ({kind:?}, >{STORM_PER_SEC}/s for {STORM_SECS}s, last: {msg}); stopping the stream",
                self.tag
            );
            self.tripped = true;
            return Verdict::Terminal;
        }

        match self.last_log {
            Some(t) if now.duration_since(t) < LOG_EVERY => self.suppressed += 1,
            _ => {
                if self.suppressed > 0 {
                    tracing::warn!(
                        "[{}] stream error ({kind:?}): {msg} (+{} more since the last report)",
                        self.tag,
                        self.suppressed
                    );
                } else {
                    tracing::warn!("[{}] stream error ({kind:?}): {msg}", self.tag);
                }
                self.last_log = Some(now);
                self.suppressed = 0;
            }
        }
        Verdict::Continue
    }
}

/// A cpal error callback that runs `on_terminal` once the gate calls the error terminal.
pub fn error_callback(
    tag: &'static str,
    on_terminal: impl Fn() + Send + 'static,
) -> impl FnMut(cpal::Error) + Send + 'static {
    let mut gate = ErrorGate::new(tag);
    move |e| {
        let msg = e.to_string();
        if gate.on_error(e.kind(), &msg, Instant::now()) == Verdict::Terminal {
            on_terminal();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_loss_is_terminal_at_once() {
        let mut g = ErrorGate::new("t");
        let t0 = Instant::now();
        assert_eq!(
            g.on_error(ErrorKind::DeviceNotAvailable, "gone", t0),
            Verdict::Terminal
        );
        // Latched: a later error of any kind stays terminal.
        assert_eq!(g.on_error(ErrorKind::Xrun, "x", t0), Verdict::Terminal);
    }

    #[test]
    fn a_tripped_storm_stays_terminal_without_counting() {
        let mut g = ErrorGate::new("t");
        let t0 = Instant::now();
        let mut i = 0u64;
        loop {
            let now = t0 + Duration::from_millis(i);
            if g.on_error(ErrorKind::BackendError, "pollerr", now) == Verdict::Terminal {
                break;
            }
            i += 1;
        }
        let (count, suppressed) = (g.sec_count, g.suppressed);
        for j in 1..100u64 {
            let now = t0 + Duration::from_millis(i + j);
            assert_eq!(
                g.on_error(ErrorKind::BackendError, "pollerr", now),
                Verdict::Terminal
            );
        }
        assert_eq!((g.sec_count, g.suppressed), (count, suppressed));
    }

    #[test]
    fn hot_seconds_a_minute_apart_are_not_a_storm() {
        let mut g = ErrorGate::new("t");
        let t0 = Instant::now();
        // 300 errors in the first half second: one hot bucket.
        for i in 0..300u64 {
            let now = t0 + Duration::from_micros(i * 1_600);
            assert_eq!(g.on_error(ErrorKind::Xrun, "x", now), Verdict::Continue);
        }
        // Nothing until t = 60 s, then 1000/s for 1.5 s: only one more hot second follows on.
        for i in 0..1_500u64 {
            let now = t0 + Duration::from_secs(60) + Duration::from_millis(i);
            assert_eq!(g.on_error(ErrorKind::Xrun, "x", now), Verdict::Continue);
        }
    }

    #[test]
    fn sporadic_errors_keep_the_stream_and_throttle_the_log() {
        let mut g = ErrorGate::new("t");
        let t0 = Instant::now();
        for i in 0..50u64 {
            let now = t0 + Duration::from_millis(i * 100);
            assert_eq!(g.on_error(ErrorKind::Xrun, "x", now), Verdict::Continue);
        }
        // 5 s of xruns: the first was logged, the rest of that window was counted.
        assert_eq!(g.suppressed, 49);
        let later = t0 + Duration::from_millis(5_100);
        assert_eq!(g.on_error(ErrorKind::Xrun, "x", later), Verdict::Continue);
        assert_eq!(g.suppressed, 0);
    }

    #[test]
    fn a_busy_loop_is_cut_after_two_hot_seconds() {
        let mut g = ErrorGate::new("t");
        let t0 = Instant::now();
        let mut stopped_at = None;
        // 1000 errors/s, like a backend that never recovers.
        for i in 0..5_000u64 {
            let now = t0 + Duration::from_millis(i);
            if g.on_error(ErrorKind::BackendError, "pollerr", now) == Verdict::Terminal {
                stopped_at = Some(i);
                break;
            }
        }
        let ms = stopped_at.expect("storm never tripped");
        assert!((2_000..2_100).contains(&ms), "tripped at {ms} ms");
    }

    #[test]
    fn a_short_burst_does_not_trip_the_breaker() {
        let mut g = ErrorGate::new("t");
        let t0 = Instant::now();
        // One hot second, then quiet, then another hot second: never two in a row.
        for i in 0..1_000u64 {
            let now = t0 + Duration::from_micros(i * 900);
            assert_eq!(g.on_error(ErrorKind::Xrun, "x", now), Verdict::Continue);
        }
        let quiet = t0 + Duration::from_millis(1_500);
        assert_eq!(g.on_error(ErrorKind::Xrun, "x", quiet), Verdict::Continue);
        for i in 0..1_000u64 {
            let now = t0 + Duration::from_millis(3_000) + Duration::from_micros(i * 900);
            assert_eq!(g.on_error(ErrorKind::Xrun, "x", now), Verdict::Continue);
        }
    }
}
