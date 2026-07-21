//! Release debounce for the hotkey backends — erases key-switch chatter before
//! it reaches the chord engine.
//!
//! A worn keyboard switch can "bounce" on contact: the OS sees a phantom
//! release + re-press pair (observed: a release ~4-30 ms after the chord
//! completed, physically impossible for a human). Fed straight into the chord
//! engine, that pair fires `Stop` then `Start`; the frontend records the Stop
//! during the ~30 ms start prologue and drops the re-press Start, so a
//! push-to-talk session dies instantly with 0 audio (and a latch chord
//! double-toggles). This module sits IN FRONT of the backends' held-set:
//! a key-UP for a held key is deferred by [`RELEASE_DEBOUNCE`]; if the same
//! key comes back down within the window, both events are erased — as if the
//! key never left. Key-DOWNS are never delayed, so chord-start latency is
//! untouched; only the release (the PTT stop) fires [`RELEASE_DEBOUNCE`] later,
//! which is imperceptible.
//!
//! Platform-neutral (key ids are the backends' u16 space — evdev codes or
//! Windows VKs) with an injected `Instant`, mirroring `chord_engine::Engine`.

use std::collections::HashMap;
use std::time::{Duration, Instant};

/// How long a key-up is held back waiting for a bounce re-press. Sized for
/// worn-switch chatter as seen at the OS level (20-100 ms class; the keyboard
/// controller's firmware already ate the ~5 ms electrical bounce — anything
/// that reaches us survived that filter). Dedicated chatter filters run
/// 100-300 ms (KeyboardChatterBlocker, GNOME BounceKeys); we stay at 50 ms
/// because that's the whole latency budget an imperceptible PTT stop allows,
/// and no human can release + re-press a key that fast, so nothing legitimate
/// is ever merged.
pub const RELEASE_DEBOUNCE: Duration = Duration::from_millis(50);

pub struct Debouncer {
    window: Duration,
    /// key → deadline at which its deferred release commits.
    pending: HashMap<u16, Instant>,
}

impl Debouncer {
    pub fn new(window: Duration) -> Self {
        Self { window, pending: HashMap::new() }
    }

    /// Feed one raw transition. `Some((key, down))` = commit it to the held-set /
    /// engine now; `None` = absorbed (a deferred release, or the re-press that
    /// cancelled one). `held` = whether the key is currently in the caller's
    /// COMMITTED held-set: ups for keys not held pass straight through (they are
    /// no-ops downstream anyway), which guarantees a down is only ever swallowed
    /// as the second half of a true held→up→down bounce pair.
    pub fn on_event(&mut self, key: u16, down: bool, held: bool, now: Instant) -> Option<(u16, bool)> {
        if down {
            if self.pending.remove(&key).is_some() {
                return None; // bounce pair erased — the key never (observably) left
            }
            Some((key, true))
        } else if !held {
            Some((key, false))
        } else {
            // First up wins: a duplicate up from the second Windows feed must not
            // push the deadline out (and the dual feeds can deliver one physical
            // bounce as up/down/up/down — each pair cancels above, net no-op).
            self.pending.entry(key).or_insert(now + self.window);
            None
        }
    }

    /// Drain and return every deferred release whose window has elapsed — the
    /// caller commits each as a key-up.
    pub fn expire(&mut self, now: Instant) -> Vec<u16> {
        let due: Vec<u16> = self
            .pending
            .iter()
            .filter(|(_, &dl)| dl <= now)
            .map(|(&k, _)| k)
            .collect();
        for k in &due {
            self.pending.remove(k);
        }
        due
    }

    /// Earliest pending deadline, driving the backend's timed wait
    /// (`recv_timeout` / `timeout_at`). `None` = nothing pending, wait forever.
    pub fn next_deadline(&self) -> Option<Instant> {
        self.pending.values().min().copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const K: u16 = 42; // arbitrary key id
    const J: u16 = 29;

    fn at(base: Instant, ms: u64) -> Instant {
        base + Duration::from_millis(ms)
    }

    #[test]
    fn bounce_pair_is_erased() {
        let t = Instant::now();
        let mut d = Debouncer::new(RELEASE_DEBOUNCE);
        assert_eq!(d.on_event(K, true, false, t), Some((K, true))); // press commits
        assert_eq!(d.on_event(K, false, true, at(t, 10)), None); // phantom up deferred
        assert_eq!(d.on_event(K, true, true, at(t, 14)), None); // re-press cancels it
        assert_eq!(d.next_deadline(), None); // nothing pending
        assert!(d.expire(at(t, 1000)).is_empty()); // and nothing ever commits
    }

    #[test]
    fn real_release_commits_after_the_window() {
        let t = Instant::now();
        let mut d = Debouncer::new(RELEASE_DEBOUNCE);
        d.on_event(K, true, false, t);
        assert_eq!(d.on_event(K, false, true, t), None);
        assert_eq!(d.next_deadline(), Some(t + RELEASE_DEBOUNCE));
        assert!(d.expire(at(t, 49)).is_empty()); // window not elapsed
        assert_eq!(d.expire(at(t, 50)), vec![K]); // commits as a key-up
        assert_eq!(d.next_deadline(), None);
    }

    #[test]
    fn duplicate_ups_collapse_to_one_release_at_the_first_deadline() {
        // The two Windows feeds both deliver the same physical release.
        let t = Instant::now();
        let mut d = Debouncer::new(RELEASE_DEBOUNCE);
        d.on_event(K, true, false, t);
        assert_eq!(d.on_event(K, false, true, t), None);
        assert_eq!(d.on_event(K, false, true, at(t, 5)), None); // dup must NOT extend
        assert_eq!(d.next_deadline(), Some(t + RELEASE_DEBOUNCE));
        assert_eq!(d.expire(at(t, 50)), vec![K]);
    }

    #[test]
    fn double_delivered_bounce_nets_to_nothing() {
        // One physical bounce interleaved by the dual feeds as up,down,up,down.
        let t = Instant::now();
        let mut d = Debouncer::new(RELEASE_DEBOUNCE);
        d.on_event(K, true, false, t);
        assert_eq!(d.on_event(K, false, true, at(t, 10)), None);
        assert_eq!(d.on_event(K, true, true, at(t, 12)), None);
        assert_eq!(d.on_event(K, false, true, at(t, 13)), None);
        assert_eq!(d.on_event(K, true, true, at(t, 15)), None);
        assert!(d.expire(at(t, 1000)).is_empty());
    }

    #[test]
    fn up_for_an_unheld_key_passes_through() {
        // Backend-restart transient: a release for a key the fresh held-set never
        // saw — must not park in pending (its "down" would then be swallowed).
        let t = Instant::now();
        let mut d = Debouncer::new(RELEASE_DEBOUNCE);
        assert_eq!(d.on_event(K, false, false, t), Some((K, false)));
        assert_eq!(d.on_event(K, true, false, t), Some((K, true))); // next press commits
    }

    #[test]
    fn multiple_keys_pend_independently() {
        let t = Instant::now();
        let mut d = Debouncer::new(RELEASE_DEBOUNCE);
        d.on_event(K, true, false, t);
        d.on_event(J, true, false, t);
        d.on_event(K, false, true, t);
        d.on_event(J, false, true, at(t, 20));
        assert_eq!(d.next_deadline(), Some(t + RELEASE_DEBOUNCE));
        assert_eq!(d.expire(at(t, 55)), vec![K]); // only K's window elapsed
        assert_eq!(d.next_deadline(), Some(at(t, 20) + RELEASE_DEBOUNCE));
        assert_eq!(d.expire(at(t, 70)), vec![J]);
    }
}
