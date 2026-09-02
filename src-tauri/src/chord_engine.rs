// Platform-neutral chord state machine shared by BOTH hotkey backends
// (evdev_hotkeys on Linux, win_hotkeys on Windows). The backends translate
// bindings into u16 key codes (evdev codes / Windows VKs — both u16), feed the
// current held-key set per key event, and dispatch the returned `Fire`s
// (emit "trigger", quickadd::show, ACTIVE_HOLDS bookkeeping). Keeping the
// chord-family DECISION here means those semantics exist exactly once;
// the DISPATCH of each `Fire` variant lives in each backend's `commit()`
// (evdev_hotkeys::commit and win_hotkeys::commit — both must be updated
// when a `Fire` arm changes).
//
// Chord-family semantics (the designed nesting, mirrored by src/lib/conflicts.ts):
//   • A HOLD chord fires `Start` the instant its keys complete — zero added
//     latency — unless a strict-superset chord is already fully held (keys
//     arrived superset-first: the superset wins, the subset stays silent).
//   • A HANDS-FREE chord that strictly contains an actively-holding HOLD chord
//     fires `Reclassify` instead of `Toggle`: the running session upgrades
//     in place (hold → hands-free) — the hold is released WITHOUT a `Stop`.
//     Allowed at ANY time during the hold: an upgrade keeps the session, so
//     it is always safe.
//   • The QUICK-ADD chord is a plain rising-edge chord, exactly like a
//     hands-free toggle with nothing to upgrade: it opens the window and takes
//     part in nesting only as an ordinary peer. (It used to be the third member
//     of the family — a superset that aborted a just-started hold within a grace
//     window. Nothing in the market nests a third chord over push-to-talk, the
//     starter profiles never used it, and it was the one nesting with edge cases
//     of its own — so it is gone, and hold ⊂ quick-add is an ordinary shadow
//     conflict again.)
//   • A hold suppressed-then-unsuppressed (superset pressed and released while
//     the root stays down) does NOT re-fire `Start`: holds start only on the
//     physical completion edge. (The old matcher restarted here — wrong for
//     the family: releasing Space out of Ctrl+Shift+Space would have begun a
//     phantom push-to-talk session.)
//
// Chords match by CONTAINMENT (`keys ⊆ held`), not by an exact modifier mask —
// that is what lets the nesting above work at all, and what keeps a hold alive
// while the user types during dictation. The containment has exactly one guard,
// `blocked_by_peer`: a chord may not fire while ANOTHER configured chord is also
// fully held, unless that other chord is one of its own strict subsets (i.e. the
// designed nesting above). Sequencing therefore decides an overlap — whichever
// chord completes FIRST fires, and the other is inert until it is released — and
// a genuinely simultaneous completion fires NOTHING, the same answer every
// OS-level registrar gives (`RegisterHotKey`, `XGrabKey`, `RegisterEventHotKey`
// all match an exact mask). Without the guard, chords that merely OVERLAP — a
// Ctrl+Super hands-free profile beside the factory Alt+Super quick-add, with Alt
// down for any reason — both went fully-held on the same transition and BOTH
// fired: dictation started and the quick-add window stole focus off one press.
// The old guard only consulted configured strict SUPERSETS, which is empty for
// every overlapping pair, so nothing arbitrated them.

use std::collections::HashSet;
use std::time::Instant;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChordKind {
    Hold { profile_id: String },
    HandsFree { profile_id: String },

    QuickAdd,
}

/// Allocation-free discriminant for the per-keystroke dispatch: `step` runs for
/// every key transition system-wide, and cloning `ChordKind` there heap-allocates
/// a `String` per chord per event (see the `fully` scratch comment).
#[derive(Clone, Copy, PartialEq, Eq)]
enum KindTag {
    Hold,
    HandsFree,
    QuickAdd,
}

impl ChordKind {
    fn tag(&self) -> KindTag {
        match self {
            ChordKind::Hold { .. } => KindTag::Hold,
            ChordKind::HandsFree { .. } => KindTag::HandsFree,
            ChordKind::QuickAdd => KindTag::QuickAdd,
        }
    }
    /// The owning profile ("" for quick-add) — cloned only at a fire site.
    fn profile(&self) -> &str {
        match self {
            ChordKind::Hold { profile_id } | ChordKind::HandsFree { profile_id } => profile_id,
            ChordKind::QuickAdd => "",
        }
    }
}

impl ChordKind {
    /// May a chord of this kind be a strict SUBSET of one of kind `sup`? True for exactly
    /// the designed nesting — a hold inside a hands-free superset (the in-place upgrade).
    /// Every other nesting is a shadow: the shorter chord would fire on the way into the
    /// longer one, or two sessions would run at once. `src/lib/conflicts.ts` enforces the
    /// same rule in the Settings UI; this is its twin for the profile lists that never pass
    /// through the UI (a sync pull, an import), applied by both backends' `chords_from`.
    fn may_nest_in(&self, sup: &ChordKind) -> bool {
        matches!((self, sup), (ChordKind::Hold { .. }, ChordKind::HandsFree { .. }))
    }
}

#[derive(Debug, Clone)]
pub struct ChordSpec {
    pub keys: Vec<u16>,
    pub kind: ChordKind,
}

/// How two chords' key SETS relate (duplicates inside a `keys` Vec are ignored).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Relation {
    Same,
    /// The first is a strict subset of the second.
    Inside,
    /// The first strictly contains the second.
    Contains,
    Independent,
}

fn relation(a: &[u16], b: &[u16]) -> Relation {
    let a: HashSet<u16> = a.iter().copied().collect();
    let b: HashSet<u16> = b.iter().copied().collect();
    if a == b {
        Relation::Same
    } else if a.is_subset(&b) {
        Relation::Inside
    } else if b.is_subset(&a) {
        Relation::Contains
    } else {
        Relation::Independent
    }
}

/// Why `candidate` may not register beside an already-accepted `existing` chord — None when
/// the pair is fine. The backends run every candidate through this against each accepted
/// chord (first in config order wins, so the LATER one is the one dropped) and log the reason.
pub fn registration_conflict(existing: &ChordSpec, candidate: &ChordSpec) -> Option<&'static str> {
    match relation(&candidate.keys, &existing.keys) {
        Relation::Same => Some("has the same chord as an earlier one"),
        Relation::Inside if !candidate.kind.may_nest_in(&existing.kind) => {
            Some("is contained in an earlier chord and is not its push-to-talk root")
        }
        Relation::Contains if !existing.kind.may_nest_in(&candidate.kind) => {
            Some("contains an earlier chord and is not its hands-free upgrade")
        }
        _ => None,
    }
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
    /// Hands-free chord pressed with no hold to upgrade — emit "toggle".
    Toggle(String),
    /// Hands-free chord completed over a live hold — emit "reclassify" (the
    /// frontend upgrades in place, or toggles off when it's already hands-free).
    Reclassify(String),
    /// Open the quick-add window.
    OpenQuickAdd,
}

pub struct Engine {
    chords: Vec<ChordSpec>,
    /// For each chord, the indices of its strict subsets — the ONLY other chords
    /// allowed to be fully held while it fires (the designed nesting; see the
    /// module header and `blocked_by_peer`).
    subsets: Vec<Vec<usize>>,
    /// hold: emitted Start; hands-free/quick-add: pressed (rising-edge debounce).
    active: Vec<bool>,
    /// Physical completion last event — edge detection for holds.
    fully_prev: Vec<bool>,
    /// When an active hold emitted Start — picks the most recent hold as the
    /// handoff donor when a hands-free superset contains more than one.
    started_at: Vec<Option<Instant>>,
    /// Reused per-event scratch (the matchers run on every keystroke system-wide).
    fully: Vec<bool>,
    /// The indices of `fully` set this event — normally empty or a single entry, so
    /// `blocked_by_peer` walks that instead of all N chords on every keystroke.
    fully_now: Vec<usize>,
}

impl Engine {
    pub fn new(chords: Vec<ChordSpec>) -> Self {
        let sets: Vec<HashSet<u16>> = chords.iter().map(|c| c.keys.iter().copied().collect()).collect();
        let n = chords.len();
        let mut subsets = vec![Vec::new(); n];
        for i in 0..n {
            for j in 0..n {
                if i != j && sets[j].len() > sets[i].len() && sets[i].iter().all(|c| sets[j].contains(c)) {
                    subsets[j].push(i);
                }
            }
        }
        Engine {
            subsets,
            active: vec![false; n],
            fully_prev: vec![false; n],
            started_at: vec![None; n],
            fully: vec![false; n],
            fully_now: Vec::new(),
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
    /// `j` — the handoff donor for a hands-free upgrade.
    fn active_hold_subset(&self, j: usize) -> Option<usize> {
        self.subsets[j]
            .iter()
            .copied()
            .filter(|&i| self.active[i] && matches!(self.chords[i].kind, ChordKind::Hold { .. }))
            .max_by_key(|&i| self.started_at[i])
    }

    /// May chord `i` fire right now, given everything else that is fully held?
    ///
    /// No, if any OTHER chord is also complete and is not one of `i`'s own strict
    /// subsets. A strict subset is exempt because that IS the designed nesting: the
    /// hands-free chord Ctrl+Shift+Space fires while its Ctrl+Shift hold is complete,
    /// which is the whole handoff. Everything else — a strict SUPERSET (which wins over
    /// its subset, as before), or a mere OVERLAP like Alt+Super beside Ctrl+Super — makes
    /// the press ambiguous, and an ambiguous press must do nothing rather than everything.
    ///
    /// Gates only the RISING arms. A hold that already started still stops on its own
    /// falling edge, so a peer chord completing mid-dictation can never strand a session.
    fn blocked_by_peer(&self, i: usize) -> bool {
        self.fully_now
            .iter()
            .any(|&j| j != i && !self.subsets[i].contains(&j))
    }

    /// The keys of every chord bound to `profile_id`, unioned, in the backend's own code
    /// namespace. The backends use this to snapshot the FIRING chord's own modifiers
    /// (`triggers::snapshot_trigger_mods`) instead of every modifier that happens to be down —
    /// so holding an unrelated Ctrl to scroll cannot read as "the dictation chord is still held".
    pub fn keys_for_profile(&self, profile_id: &str) -> Vec<u16> {
        let mut out: Vec<u16> = Vec::new();
        for c in &self.chords {
            let owner = match &c.kind {
                ChordKind::Hold { profile_id } | ChordKind::HandsFree { profile_id } => {
                    Some(profile_id.as_str())
                }
                ChordKind::QuickAdd => None,
            };
            if owner == Some(profile_id) {
                for &k in &c.keys {
                    if !out.contains(&k) {
                        out.push(k);
                    }
                }
            }
        }
        out
    }
}

/// The teardown-latch predicate both backends share: does any key of `keys` that is a
/// shortcut MODIFIER (`is_mod`) still read as down (`down`)? Only modifiers matter — they are
/// the keys the injection gate folds into, and a chord's non-modifier member (Space, a letter)
/// held alone cannot make the next phrase type into a live shortcut. `any`, not `all`: a
/// staggered release parks the first key-up in the debouncer while the second modifier is
/// still physically down, and a latch that read that as "released" let the transcript be typed
/// into a live Ctrl. It fails toward arming; the empty chord reads as released.
pub fn any_chord_mod_down(
    keys: &[u16],
    is_mod: impl Fn(u16) -> bool,
    down: impl Fn(u16) -> bool,
) -> bool {
    keys.iter().copied().filter(|&k| is_mod(k)).any(down)
}

impl Engine {
    /// Advance the machine after a key event. `held` is the full set of
    /// currently-down key codes; `now` stamps a new hold's `started_at`, which
    /// `active_hold_subset` uses to pick the most recent hold as the handoff donor
    /// (injected so tests can order holds deterministically).
    pub fn step(&mut self, held: &HashSet<u16>, now: Instant) -> Vec<Fire> {
        let n = self.chords.len();
        for i in 0..n {
            self.fully[i] = self.chords[i].keys.iter().all(|c| held.contains(c));
        }
        self.fully_now.clear();
        self.fully_now.extend((0..n).filter(|&i| self.fully[i]));
        let mut out = Vec::new();
        for i in 0..n {
            let fully = self.fully[i];
            let rising = fully && !self.fully_prev[i];
            let falling = !fully && self.fully_prev[i];
            let blocked = self.blocked_by_peer(i);
            match self.chords[i].kind.tag() {
                KindTag::Hold => {
                    if rising && !blocked && !self.active[i] {
                        self.active[i] = true;
                        self.started_at[i] = Some(now);
                        out.push(Fire::Start(self.chords[i].kind.profile().to_string()));
                    } else if falling && self.active[i] {
                        self.active[i] = false;
                        self.started_at[i] = None;
                        out.push(Fire::Stop(self.chords[i].kind.profile().to_string()));
                    }
                    // Suppression by a peer (fully stays true) is NOT a stop, and
                    // suppression-lift is NOT a start — a superset acts through its
                    // own arm below; the hold reacts only to its own edges.
                }
                KindTag::HandsFree => {
                    // Edge, not level: a chord that completed while suppressed by a
                    // peer must stay silent — suppression-lift is NOT a start.
                    let on = rising && !blocked;
                    if on && !self.active[i] {
                        self.active[i] = true;
                        if let Some(r) = self.active_hold_subset(i) {
                            // Upgrade: the hold hands its running session over.
                            self.active[r] = false;
                            self.started_at[r] = None;
                            if let ChordKind::Hold { profile_id: root } = &self.chords[r].kind {
                                out.push(Fire::ReleaseHold(root.clone()));
                            }
                            out.push(Fire::Reclassify(self.chords[i].kind.profile().to_string()));
                        } else {
                            out.push(Fire::Toggle(self.chords[i].kind.profile().to_string()));
                        }
                    } else if !fully {
                        // Re-arm on a real RELEASE only — not when a peer chord
                        // merely suppresses this one (fully still held, on=false).
                        self.active[i] = false;
                    }
                }
                KindTag::QuickAdd => {
                    // Same edge + re-arm discipline as hands-free, with nothing to hand off.
                    let on = rising && !blocked;
                    if on && !self.active[i] {
                        self.active[i] = true;
                        out.push(Fire::OpenQuickAdd);
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
    const KEY_H: u16 = 5;
    const SUPER_L: u16 = 6;
    const ALT_L: u16 = 7;

    /// The designed family: a push-to-talk hold nested in a hands-free superset, with an
    /// independent quick-add chord beside them (the starter shape, quick-add on Alt+Super).
    fn family() -> Engine {
        Engine::new(vec![
            ChordSpec { keys: vec![CTRL_L, SHIFT_L], kind: ChordKind::Hold { profile_id: "ptt".into() } },
            ChordSpec { keys: vec![CTRL_L, SHIFT_L, SPACE], kind: ChordKind::HandsFree { profile_id: "handsfree".into() } },
            ChordSpec { keys: vec![ALT_L, SUPER_L], kind: ChordKind::QuickAdd },
        ])
    }

    /// The factory Windows set as the field report ran it: push-to-talk Ctrl+Shift,
    /// hands-free Ctrl+Super, quick-add Alt+Super. NOTHING nests here — the chords merely
    /// OVERLAP on Super, the topology the old superset-only guard could not arbitrate and
    /// which no other test covers.
    fn overlapping() -> Engine {
        Engine::new(vec![
            ChordSpec { keys: vec![CTRL_L, SHIFT_L], kind: ChordKind::Hold { profile_id: "ptt".into() } },
            ChordSpec { keys: vec![CTRL_L, SUPER_L], kind: ChordKind::HandsFree { profile_id: "hf".into() } },
            ChordSpec { keys: vec![ALT_L, SUPER_L], kind: ChordKind::QuickAdd },
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
    fn plain_handsfree_toggle_and_rearm() {
        let mut e = Engine::new(vec![ChordSpec {
            keys: vec![CTRL_L, KEY_H],
            kind: ChordKind::HandsFree { profile_id: "l".into() },
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
    fn handsfree_upgrade_hands_off_the_hold() {
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
            vec![Fire::Start("ptt".into()), Fire::ReleaseHold("ptt".into()), Fire::Reclassify("handsfree".into())]
        );
    }

    #[test]
    fn handsfree_pressed_all_at_once_is_a_plain_toggle() {
        // Keys arriving Space-first: the hold completes already-suppressed, so
        // there is no session to hand off — the hands-free chord is a normal toggle.
        let mut e = family();
        let t = Instant::now();
        let fires = run(
            &mut e,
            &[(&[SPACE], t), (&[SPACE, CTRL_L], t), (&[SPACE, CTRL_L, SHIFT_L], t), (&[], t)],
        );
        assert_eq!(fires, vec![Fire::Toggle("handsfree".into())]);
    }

    #[test]
    fn second_family_press_reclassifies_again_for_toggle_off() {
        // While hands-free, pressing the family again: the root's Start is the
        // frontend's no-op (busy), and the hands-free completion must reclassify —
        // the frontend reads same-profile as toggle-off.
        let mut e = family();
        let t = Instant::now();
        run(&mut e, &[(&[CTRL_L, SHIFT_L], t), (&[CTRL_L, SHIFT_L, SPACE], t), (&[], t)]);
        let fires = run(&mut e, &[(&[CTRL_L, SHIFT_L], t), (&[CTRL_L, SHIFT_L, SPACE], t), (&[], t)]);
        assert_eq!(
            fires,
            vec![Fire::Start("ptt".into()), Fire::ReleaseHold("ptt".into()), Fire::Reclassify("handsfree".into())]
        );
    }


    /// Quick-add is a plain rising-edge chord: press opens, and it re-arms only on a real
    /// release — exactly the hands-free discipline, with no hold to hand off.
    #[test]
    fn quick_add_opens_on_each_press_and_rearms_on_release() {
        let mut e = family();
        let t = Instant::now();
        let fires = run(
            &mut e,
            &[
                (&[ALT_L], t),
                (&[ALT_L, SUPER_L], t), // open
                (&[ALT_L], t),          // Super up → re-arm
                (&[ALT_L, SUPER_L], t), // open again
                (&[], t),
            ],
        );
        assert_eq!(fires, vec![Fire::OpenQuickAdd, Fire::OpenQuickAdd]);
    }

    /// The lift of a superset-only key must not fire the nested chord: only the
    /// Hold arm was edge-gated; HandsFree/QuickAdd used the level and fired on
    /// suppression-lift (dictation starting behind a just-opened quick-add window).
    #[test]
    fn suppression_lift_does_not_fire_handsfree_or_quick_add() {
        let t = Instant::now();
        // hands-free nested in quick-add: lifting the extra key must not toggle dictation.
        let mut e = Engine::new(vec![
            ChordSpec { keys: vec![CTRL_L, SHIFT_L], kind: ChordKind::HandsFree { profile_id: "hf".into() } },
            ChordSpec { keys: vec![CTRL_L, SHIFT_L, SPACE], kind: ChordKind::QuickAdd },
        ]);
        assert_eq!(
            run(&mut e, &[(&[SPACE], t), (&[SPACE, CTRL_L], t), (&[SPACE, CTRL_L, SHIFT_L], t), (&[CTRL_L, SHIFT_L], t), (&[], t)]),
            vec![Fire::OpenQuickAdd]
        );
        // quick-add nested in hands-free: lifting the extra key must not open the window.
        let mut e2 = Engine::new(vec![
            ChordSpec { keys: vec![CTRL_L, SHIFT_L, SPACE], kind: ChordKind::QuickAdd },
            ChordSpec { keys: vec![CTRL_L, SHIFT_L, SPACE, KEY_H], kind: ChordKind::HandsFree { profile_id: "hf".into() } },
        ]);
        assert_eq!(
            run(&mut e2, &[(&[KEY_H], t), (&[KEY_H, CTRL_L], t), (&[KEY_H, CTRL_L, SHIFT_L], t), (&[KEY_H, CTRL_L, SHIFT_L, SPACE], t), (&[CTRL_L, SHIFT_L, SPACE], t), (&[], t)]),
            vec![Fire::Toggle("hf".into())]
        );
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
                (&[CTRL_L, SHIFT_L, SPACE], t), // re-press: hands-free re-armed → reclassify (no active hold → toggle)
                (&[], t),
            ],
        );
        assert_eq!(
            fires,
            vec![
                Fire::Start("ptt".into()),
                Fire::ReleaseHold("ptt".into()),
                Fire::Reclassify("handsfree".into()),
                Fire::Toggle("handsfree".into()),
            ]
        );
    }

    /// The reported bug. Alt is down for any reason (a menu, an Alt+Tab, a key-up the
    /// Windows hook lost behind an RDP capture hook) and the user presses their hands-free
    /// chord: Ctrl+Super and Alt+Super complete on the SAME transition. The old matcher
    /// fired BOTH — dictation started and the quick-add window stole focus off one press.
    #[test]
    fn one_press_never_fires_two_overlapping_chords() {
        let mut e = overlapping();
        let t = Instant::now();
        assert_eq!(
            run(
                &mut e,
                &[(&[ALT_L], t), (&[ALT_L, CTRL_L], t), (&[ALT_L, CTRL_L, SUPER_L], t), (&[], t)]
            ),
            vec![]
        );
    }

    /// Only a SIMULTANEOUS completion is ambiguous. Completed one at a time, the first one
    /// through fires and the loser stays inert until the keys lift — so the overlap costs
    /// the user nothing in ordinary sequential use.
    #[test]
    fn whichever_overlapping_chord_completes_first_wins() {
        let t = Instant::now();
        let mut e = overlapping();
        assert_eq!(
            run(
                &mut e,
                &[(&[CTRL_L], t), (&[CTRL_L, SUPER_L], t), (&[CTRL_L, SUPER_L, ALT_L], t), (&[], t)]
            ),
            vec![Fire::Toggle("hf".into())]
        );
        let mut e2 = overlapping();
        assert_eq!(
            run(
                &mut e2,
                &[(&[ALT_L], t), (&[ALT_L, SUPER_L], t), (&[ALT_L, SUPER_L, CTRL_L], t), (&[], t)]
            ),
            vec![Fire::OpenQuickAdd]
        );
    }

    /// A tap of Super during push-to-talk completes the hands-free chord — which is NOT a
    /// superset of the hold, so it is not the designed `Reclassify` upgrade but a plain
    /// `Toggle`, and the frontend's toggle arm CANCELS a busy session. The hold must ride
    /// it out and stop on its own release.
    #[test]
    fn an_overlapping_chord_cannot_cancel_a_live_hold() {
        let mut e = overlapping();
        let t = Instant::now();
        let fires = run(
            &mut e,
            &[
                (&[CTRL_L, SHIFT_L], t),          // PTT starts
                (&[CTRL_L, SHIFT_L, SUPER_L], t), // hands-free completes over it — inert
                (&[CTRL_L, SHIFT_L], t),          // Super up — no phantom toggle
                (&[], t),                         // real release → stop
            ],
        );
        assert_eq!(fires, vec![Fire::Start("ptt".into()), Fire::Stop("ptt".into())]);
    }

    /// Every branch of the shared latch predicate: fully held / fully released / a staggered
    /// release with one modifier still down / only the plain key down / the empty chord.
    #[test]
    fn the_teardown_latch_arms_on_any_modifier_still_down_and_never_on_a_plain_key() {
        // Modifiers 1 and 2, plain key 9.
        let is_mod = |k: u16| k == 1 || k == 2;
        let chord = [1u16, 2, 9];
        let down_all = |_k: u16| true;
        let down_none = |_k: u16| false;
        let down_second_mod = |k: u16| k == 2;
        let down_plain_only = |k: u16| k == 9;
        assert!(any_chord_mod_down(&chord, is_mod, down_all), "fully held ⇒ arm");
        assert!(!any_chord_mod_down(&chord, is_mod, down_none), "fully released ⇒ don't arm");
        assert!(any_chord_mod_down(&chord, is_mod, down_second_mod), "staggered release ⇒ arm");
        assert!(!any_chord_mod_down(&chord, is_mod, down_plain_only), "only the plain key ⇒ don't arm");
        assert!(!any_chord_mod_down(&[], is_mod, down_all), "empty chord ⇒ don't arm");
    }

    /// The guard arbitrates CHORDS, it does not turn matching into an exact modifier mask:
    /// an unrelated key being down must still leave a chord free to fire, or dictation would
    /// die the moment the user rests a finger anywhere (and every nested family would break).
    #[test]
    fn an_unrelated_held_key_still_lets_a_chord_fire() {
        let mut e = overlapping();
        let t = Instant::now();
        assert_eq!(
            run(
                &mut e,
                &[(&[KEY_H], t), (&[KEY_H, CTRL_L], t), (&[KEY_H, CTRL_L, SHIFT_L], t), (&[KEY_H], t)]
            ),
            vec![Fire::Start("ptt".into()), Fire::Stop("ptt".into())]
        );
    }

    /// The registration filter is the UI conflict rule (`conflicts.ts`) for lists that skip
    /// the UI: exactly one nesting is allowed, a hold inside a hands-free superset.
    #[test]
    fn registration_allows_only_the_hold_in_handsfree_nesting() {
        let hold = |k: &[u16]| ChordSpec { keys: k.to_vec(), kind: ChordKind::Hold { profile_id: "h".into() } };
        let hf = |k: &[u16]| ChordSpec { keys: k.to_vec(), kind: ChordKind::HandsFree { profile_id: "f".into() } };
        let qa = |k: &[u16]| ChordSpec { keys: k.to_vec(), kind: ChordKind::QuickAdd };
        // The designed family, in either config order.
        assert_eq!(registration_conflict(&hold(&[CTRL_L, SHIFT_L]), &hf(&[CTRL_L, SHIFT_L, SPACE])), None);
        assert_eq!(registration_conflict(&hf(&[CTRL_L, SHIFT_L, SPACE]), &hold(&[CTRL_L, SHIFT_L])), None);
        // Directional: hands-free inside a hold is a shadow.
        assert!(registration_conflict(&hf(&[CTRL_L, SHIFT_L]), &hold(&[CTRL_L, SHIFT_L, SPACE])).is_some());
        // hold ⊂ hold — two sessions would run at once.
        assert!(registration_conflict(&hold(&[CTRL_L, SHIFT_L]), &hold(&[CTRL_L, SHIFT_L, SPACE])).is_some());
        // hands-free ⊂ hands-free, and quick-add nested either way.
        assert!(registration_conflict(&hf(&[CTRL_L, SHIFT_L]), &hf(&[CTRL_L, SHIFT_L, SPACE])).is_some());
        assert!(registration_conflict(&hold(&[CTRL_L, SHIFT_L]), &qa(&[CTRL_L, SHIFT_L, KEY_H])).is_some());
        assert!(registration_conflict(&qa(&[ALT_L, SUPER_L]), &hf(&[ALT_L, SUPER_L, KEY_H])).is_some());
        // Same set, duplicates inside the Vec notwithstanding.
        assert!(registration_conflict(&hold(&[CTRL_L, SHIFT_L]), &hf(&[CTRL_L, CTRL_L, SHIFT_L])).is_some());
        // Overlap and disjoint are not registration conflicts (the peer guard arbitrates them).
        assert_eq!(registration_conflict(&hf(&[CTRL_L, SUPER_L]), &qa(&[ALT_L, SUPER_L])), None);
        assert_eq!(registration_conflict(&hold(&[CTRL_L, SHIFT_L]), &qa(&[ALT_L, SUPER_L])), None);
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
