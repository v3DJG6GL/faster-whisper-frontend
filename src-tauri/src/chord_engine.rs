// Platform-neutral chord state machine shared by BOTH hotkey backends
// (evdev_hotkeys on Linux, win_hotkeys on Windows). The backends translate
// bindings into u16 key codes (evdev codes / Windows VKs — both u16), feed the
// current held-key set per key event, and dispatch the returned `Fire`s
// (emit "trigger", quickadd::show, ACTIVE_HOLDS bookkeeping). Keeping the
// dispatch here means the chord-family semantics below exist exactly once.
//
// Chord-family semantics (the designed nesting, mirrored by src/lib/conflicts.ts):
//   • A HOLD chord fires `Start` the instant its keys complete — zero added
//     latency — unless a strict-superset chord is already fully held (keys
//     arrived superset-first: the superset wins, the subset stays silent).
//   • A LATCH chord that strictly contains an actively-holding HOLD chord
//     fires `Reclassify` instead of `Toggle`: the running session upgrades
//     in place (hold → hands-free) — the hold is released WITHOUT a `Stop`.
//     Allowed at ANY time during the hold: an upgrade keeps the session, so
//     it is always safe.
//   • A QUICK-ADD chord that strictly contains an actively-holding HOLD chord
//     fires `Cancel` + `OpenQuickAdd` — but ONLY within GRACE of the hold's
//     start: the just-started blip of recording is discarded (nothing has
//     been inserted yet; insertion is per-phrase). Outside the window it is
//     ignored entirely — a stray Right Ctrl mid-dictation must not eat the
//     session, which keeps running and stops on the hold's real release.
//   • A hold suppressed-then-unsuppressed (superset pressed and released while
//     the root stays down) does NOT re-fire `Start`: holds start only on the
//     physical completion edge. (The old matcher restarted here — wrong for
//     the family: releasing Space out of Ctrl+Shift+Space would have begun a
//     phantom push-to-talk session.)

use std::collections::HashSet;
use std::time::{Duration, Instant};

/// How long after a hold's `Start` a quick-add superset may abort it. Mirrors
/// Vowen's "the longer combo wins if it arrives within that window".
pub const QUICK_ADD_GRACE: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChordKind {
    Hold { profile_id: String },
    Latch { profile_id: String },
    QuickAdd,
}

#[derive(Debug, Clone)]
pub struct ChordSpec {
    pub keys: Vec<u16>,
    pub kind: ChordKind,
}

/// What the backend must do after a key event, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fire {
    /// Hold began — emit "start" + note_hold(true).
    Start(String),
    /// Hold ended by real release — emit "stop" + note_hold(false).
    Stop(String),
    /// Hold handed its session to a superset — note_hold(false), NO "stop".
    ReleaseHold(String),
    /// Latch chord pressed with no hold to upgrade — emit "toggle".
    Toggle(String),
    /// Latch chord completed over a live hold — emit "reclassify" (the
    /// frontend upgrades in place, or toggles off when it's already latched).
    Reclassify(String),
    /// Quick-add aborted a nascent hold — emit "cancel" for the hold's profile.
    Cancel(String),
    /// Open the quick-add window.
    OpenQuickAdd,
}

pub struct Engine {
    chords: Vec<ChordSpec>,
    /// For each chord, the indices of chords that are a strict superset of it.
    supersets: Vec<Vec<usize>>,
    /// Inverse: for each chord, the indices of strict subsets.
    subsets: Vec<Vec<usize>>,
    /// hold: emitted Start; latch/quick-add: pressed (rising-edge debounce).
    active: Vec<bool>,
    /// Physical completion last event — edge detection for holds.
    fully_prev: Vec<bool>,
    /// When an active hold emitted Start (drives the quick-add grace window).
    started_at: Vec<Option<Instant>>,
    /// Reused per-event scratch (the matchers run on every keystroke system-wide).
    fully: Vec<bool>,
}

impl Engine {
    pub fn new(chords: Vec<ChordSpec>) -> Self {
        let sets: Vec<HashSet<u16>> = chords.iter().map(|c| c.keys.iter().copied().collect()).collect();
        let n = chords.len();
        let mut supersets = vec![Vec::new(); n];
        let mut subsets = vec![Vec::new(); n];
        for i in 0..n {
            for j in 0..n {
                if i != j && sets[j].len() > sets[i].len() && sets[i].iter().all(|c| sets[j].contains(c)) {
                    supersets[i].push(j);
                    subsets[j].push(i);
                }
            }
        }
        Engine {
            supersets,
            subsets,
            active: vec![false; n],
            fully_prev: vec![false; n],
            started_at: vec![None; n],
            fully: vec![false; n],
            chords,
        }
    }

    /// Profile ids of holds still active — the backend's end-of-stream cleanup
    /// emits their owed "stop" (see ACTIVE_HOLDS in each backend).
    pub fn active_holds(&self) -> Vec<String> {
        self.chords
            .iter()
            .zip(self.active.iter())
            .filter_map(|(c, &a)| match (&c.kind, a) {
                (ChordKind::Hold { profile_id }, true) => Some(profile_id.clone()),
                _ => None,
            })
            .collect()
    }

    /// The most recently started, still-active HOLD strictly contained in chord
    /// `j` — the handoff donor for a latch upgrade / quick-add abort.
    fn active_hold_subset(&self, j: usize) -> Option<usize> {
        self.subsets[j]
            .iter()
            .copied()
            .filter(|&i| self.active[i] && matches!(self.chords[i].kind, ChordKind::Hold { .. }))
            .max_by_key(|&i| self.started_at[i])
    }

    /// Advance the machine after a key event. `held` is the full set of
    /// currently-down key codes; `now` timestamps the event (injected so the
    /// grace window is unit-testable).
    pub fn step(&mut self, held: &HashSet<u16>, now: Instant) -> Vec<Fire> {
        let n = self.chords.len();
        for i in 0..n {
            self.fully[i] = self.chords[i].keys.iter().all(|c| held.contains(c));
        }
        let mut out = Vec::new();
        for i in 0..n {
            let fully = self.fully[i];
            let rising = fully && !self.fully_prev[i];
            let falling = !fully && self.fully_prev[i];
            let sup_fully = self.supersets[i].iter().any(|&j| self.fully[j]);
            match self.chords[i].kind.clone() {
                ChordKind::Hold { profile_id } => {
                    if rising && !sup_fully && !self.active[i] {
                        self.active[i] = true;
                        self.started_at[i] = Some(now);
                        out.push(Fire::Start(profile_id));
                    } else if falling && self.active[i] {
                        self.active[i] = false;
                        self.started_at[i] = None;
                        out.push(Fire::Stop(profile_id));
                    }
                    // Suppression by a superset (fully stays true) is NOT a stop,
                    // and suppression-lift is NOT a start — supersets act through
                    // their own arms below; the hold reacts only to its own edges.
                }
                ChordKind::Latch { profile_id } => {
                    let on = fully && !sup_fully;
                    if on && !self.active[i] {
                        self.active[i] = true;
                        if let Some(r) = self.active_hold_subset(i) {
                            // Upgrade: the hold hands its running session over.
                            self.active[r] = false;
                            self.started_at[r] = None;
                            if let ChordKind::Hold { profile_id: root } = &self.chords[r].kind {
                                out.push(Fire::ReleaseHold(root.clone()));
                            }
                            out.push(Fire::Reclassify(profile_id));
                        } else {
                            out.push(Fire::Toggle(profile_id));
                        }
                    } else if !fully {
                        // Re-arm on a real RELEASE only — not when a superset chord
                        // merely suppresses this one (fully still held, on=false).
                        self.active[i] = false;
                    }
                }
                ChordKind::QuickAdd => {
                    let on = fully && !sup_fully;
                    if on && !self.active[i] {
                        self.active[i] = true;
                        match self.active_hold_subset(i) {
                            Some(r) => {
                                let fresh = self.started_at[r]
                                    .map(|t| now.duration_since(t) < QUICK_ADD_GRACE)
                                    .unwrap_or(false);
                                if fresh {
                                    // Abort the nascent blip and open the window.
                                    self.active[r] = false;
                                    self.started_at[r] = None;
                                    if let ChordKind::Hold { profile_id: root } = &self.chords[r].kind {
                                        out.push(Fire::ReleaseHold(root.clone()));
                                        out.push(Fire::Cancel(root.clone()));
                                    }
                                    out.push(Fire::OpenQuickAdd);
                                }
                                // Outside the grace window: ignore entirely — the
                                // hold stays active and stops on its real release.
                            }
                            None => out.push(Fire::OpenQuickAdd),
                        }
                    } else if !fully {
                        self.active[i] = false;
                    }
                }
            }
        }
        self.fully_prev.copy_from_slice(&self.fully);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Arbitrary key codes for readability.
    const CTRL_L: u16 = 1;
    const SHIFT_L: u16 = 2;
    const SPACE: u16 = 3;
    const CTRL_R: u16 = 4;
    const KEY_H: u16 = 5;

    fn family() -> Engine {
        Engine::new(vec![
            ChordSpec { keys: vec![CTRL_L, SHIFT_L], kind: ChordKind::Hold { profile_id: "ptt".into() } },
            ChordSpec { keys: vec![CTRL_L, SHIFT_L, SPACE], kind: ChordKind::Latch { profile_id: "latch".into() } },
            ChordSpec { keys: vec![CTRL_L, SHIFT_L, CTRL_R], kind: ChordKind::QuickAdd },
        ])
    }

    /// Feed a sequence of (held-set, at) pairs, returning all fires flattened.
    fn run(e: &mut Engine, seq: &[(&[u16], Instant)]) -> Vec<Fire> {
        let mut out = Vec::new();
        for (keys, at) in seq {
            let held: HashSet<u16> = keys.iter().copied().collect();
            out.extend(e.step(&held, *at));
        }
        out
    }

    #[test]
    fn plain_hold_start_stop() {
        let mut e = family();
        let t = Instant::now();
        assert_eq!(
            run(&mut e, &[(&[CTRL_L], t), (&[CTRL_L, SHIFT_L], t), (&[CTRL_L], t), (&[], t)]),
            vec![Fire::Start("ptt".into()), Fire::Stop("ptt".into())]
        );
    }

    #[test]
    fn plain_latch_toggle_and_rearm() {
        let mut e = Engine::new(vec![ChordSpec {
            keys: vec![CTRL_L, KEY_H],
            kind: ChordKind::Latch { profile_id: "l".into() },
        }]);
        let t = Instant::now();
        let fires = run(
            &mut e,
            &[
                (&[CTRL_L], t),
                (&[CTRL_L, KEY_H], t), // toggle on
                (&[CTRL_L], t),        // release H → re-arm
                (&[CTRL_L, KEY_H], t), // toggle off
                (&[], t),
            ],
        );
        assert_eq!(fires, vec![Fire::Toggle("l".into()), Fire::Toggle("l".into())]);
    }

    #[test]
    fn latch_upgrade_hands_off_the_hold() {
        let mut e = family();
        let t = Instant::now();
        let fires = run(
            &mut e,
            &[
                (&[CTRL_L, SHIFT_L], t),        // PTT starts
                (&[CTRL_L, SHIFT_L, SPACE], t), // upgrade
                (&[CTRL_L, SHIFT_L], t),        // Space up — no phantom restart
                (&[], t),                       // full release — no stop (handed off)
            ],
        );
        assert_eq!(
            fires,
            vec![Fire::Start("ptt".into()), Fire::ReleaseHold("ptt".into()), Fire::Reclassify("latch".into())]
        );
    }

    #[test]
    fn latch_pressed_all_at_once_is_a_plain_toggle() {
        // Keys arriving Space-first: the hold completes already-suppressed, so
        // there is no session to hand off — the latch is a normal toggle.
        let mut e = family();
        let t = Instant::now();
        let fires = run(
            &mut e,
            &[(&[SPACE], t), (&[SPACE, CTRL_L], t), (&[SPACE, CTRL_L, SHIFT_L], t), (&[], t)],
        );
        assert_eq!(fires, vec![Fire::Toggle("latch".into())]);
    }

    #[test]
    fn second_family_press_reclassifies_again_for_toggle_off() {
        // While latched, pressing the family again: the root's Start is the
        // frontend's no-op (busy), and the latch completion must reclassify —
        // the frontend reads same-profile as toggle-off.
        let mut e = family();
        let t = Instant::now();
        run(&mut e, &[(&[CTRL_L, SHIFT_L], t), (&[CTRL_L, SHIFT_L, SPACE], t), (&[], t)]);
        let fires = run(&mut e, &[(&[CTRL_L, SHIFT_L], t), (&[CTRL_L, SHIFT_L, SPACE], t), (&[], t)]);
        assert_eq!(
            fires,
            vec![Fire::Start("ptt".into()), Fire::ReleaseHold("ptt".into()), Fire::Reclassify("latch".into())]
        );
    }

    #[test]
    fn quick_add_inside_grace_aborts_the_blip() {
        let mut e = family();
        let t = Instant::now();
        let fires = run(
            &mut e,
            &[
                (&[CTRL_L, SHIFT_L], t),
                (&[CTRL_L, SHIFT_L, CTRL_R], t + Duration::from_millis(200)),
                (&[], t + Duration::from_millis(300)),
            ],
        );
        assert_eq!(
            fires,
            vec![
                Fire::Start("ptt".into()),
                Fire::ReleaseHold("ptt".into()),
                Fire::Cancel("ptt".into()),
                Fire::OpenQuickAdd,
            ]
        );
    }

    #[test]
    fn quick_add_outside_grace_is_ignored_and_session_survives() {
        let mut e = family();
        let t = Instant::now();
        let fires = run(
            &mut e,
            &[
                (&[CTRL_L, SHIFT_L], t),
                (&[CTRL_L, SHIFT_L, CTRL_R], t + Duration::from_millis(900)), // ignored
                (&[CTRL_L, SHIFT_L], t + Duration::from_millis(1000)),        // RCtrl up — no restart
                (&[], t + Duration::from_millis(1100)),                       // real release → stop
            ],
        );
        assert_eq!(fires, vec![Fire::Start("ptt".into()), Fire::Stop("ptt".into())]);
    }

    #[test]
    fn quick_add_from_idle_opens_without_a_blip() {
        // RCtrl-first: the hold completes already-suppressed (no Start), and
        // quick-add opens with nothing to cancel.
        let mut e = family();
        let t = Instant::now();
        let fires = run(
            &mut e,
            &[(&[CTRL_R], t), (&[CTRL_R, CTRL_L], t), (&[CTRL_R, CTRL_L, SHIFT_L], t), (&[], t)],
        );
        assert_eq!(fires, vec![Fire::OpenQuickAdd]);
    }

    #[test]
    fn suppression_lift_does_not_restart_a_hold() {
        // Root held throughout; superset pressed and released. The old matcher
        // re-fired Start on the lift — the family must not.
        let mut e = family();
        let t = Instant::now();
        let fires = run(
            &mut e,
            &[
                (&[CTRL_L, SHIFT_L], t),
                (&[CTRL_L, SHIFT_L, SPACE], t), // handoff
                (&[CTRL_L, SHIFT_L], t),        // lift — silent
                (&[CTRL_L, SHIFT_L, SPACE], t), // re-press: latch re-armed → reclassify (no active hold → toggle)
                (&[], t),
            ],
        );
        assert_eq!(
            fires,
            vec![
                Fire::Start("ptt".into()),
                Fire::ReleaseHold("ptt".into()),
                Fire::Reclassify("latch".into()),
                Fire::Toggle("latch".into()),
            ]
        );
    }

    #[test]
    fn active_holds_reports_for_teardown() {
        let mut e = family();
        let t = Instant::now();
        run(&mut e, &[(&[CTRL_L, SHIFT_L], t)]);
        assert_eq!(e.active_holds(), vec!["ptt".to_string()]);
        run(&mut e, &[(&[], t)]);
        assert!(e.active_holds().is_empty());
    }
}
