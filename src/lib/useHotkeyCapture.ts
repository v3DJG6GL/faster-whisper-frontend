// Shared hotkey-capture hook. Tracks held modifiers live; finalizes on the first
// real key (or, with a low-level backend active, on release of a modifier-only
// chord). Warns (never silently drops) on a non-registerable chord. A chord that
// clashes with another binding ends the capture as `pending`: the trigger tile
// names the owner and offers to take the keys over (`acceptPending`, which calls
// `onTakeOver` with the owner's id) or to try again (Shortcut Field D82 R1). Suspends global hotkeys for the duration so a press only
// rebinds. `lowLevelActive` = the platform's raw-key backend owns the chords
// (Linux evdev when enabled+permitted; the always-on Windows keyboard hook), which
// distinguishes modifier sides and accepts modifier-only / AltGr chords — when
// false the plugin registers, so chords are validated against its accelerators.
//
// Used by the Profiles editor (dictation chords) and the Dictionary screen's
// QuickAddShortcutField (was the Settings "quick-add shortcut" row), so both
// behave identically. `others` is the set of bindings to
// check against for conflicts (e.g. the Profiles), passed as Profile[].

import { useEffect, useRef, useState } from "react";
import { safeDisplayText } from "@/lib/sanitize";
import { validateCodes, suspendShortcuts, reregisterShortcuts } from "./api";
import {
  MODIFIER_CODES,
  codeToToken,
  canonicalizeCodes,
  eventToCode,
  dropAltGrPhantom,
  altGrPhantomActive,
} from "./keys";
import { learnLetter } from "./keyboardLayout";
import { findChordConflict, type BindingKind, type ConflictKind } from "./hotkeyConflicts";
import type { Profile } from "./types";

export function useHotkeyCapture(opts: {
  capturing: boolean;
  lowLevelActive: boolean;
  others: Profile[];
  /** What the chord being bound will behave as — decides whether a nesting with
   *  another binding is the designed hold ⊂ hands-free nesting (allowed) or a real
   *  shadow conflict — quick-add nests with nothing (see hotkeyConflicts.ts). */
  selfKind: BindingKind;
  onCommit: (codes: string[]) => void;
  onCancel: () => void;
  /** "Use it here" on a clash: clear the binding with this id (a profile, or QUICK_ADD_PEER_ID). */
  onTakeOver: (otherId: string) => void;
}): {
  heldCodes: string[];
  warn: string | null;
  pending: PendingChord | null;
  acceptPending: () => void;
  dismissPending: () => void;
} {
  const { capturing, lowLevelActive } = opts;
  const [heldCodes, setHeldCodes] = useState<string[]>([]);
  const [warn, setWarn] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingChord | null>(null);
  // Keep the latest callbacks/others without retriggering the capture effect
  // (which would re-add listeners + re-suspend hotkeys on every render).
  const ref = useRef(opts);
  ref.current = opts;

  useEffect(() => {
    if (!capturing) {
      setHeldCodes([]);
      setWarn(null);
      return;
    }
    setPending(null); // a new capture replaces an unanswered clash
    void suspendShortcuts().catch((e) => console.error("suspendShortcuts failed", e));
    const pressed = new Set<string>();
    let peak: string[] = [];
    let done = false;
    // A validateCodes() resolution that lands after the user cancels (Escape) or the
    // capture effect tears down must not commit the abandoned chord (mirrors the
    // cancelled-flag guard in useOverrideContext).
    let cancelled = false;
    const finalize = (codes: string[]) => {
      // A registerable chord that clashes with another binding ends the capture as `pending`
      // (the tile offers "Use it here" / "Try again"); a free one commits.
      const settle = () => {
        // No low-level backend ⇒ the plugin registers and collapses L/R modifier sides, so collapse
        // them for the clash check too (a side-only-different chord would otherwise warn-free yet collide).
        const clash = findChordConflict(codes, ref.current.others, !lowLevelActive, ref.current.selfKind);
        if (clash) {
          // The name is peer/blob-authored (`sanitizeProfiles` type-checks it but does not bound it),
          // and this is the sentence the user reads to decide whether to take the keys over — so it
          // gets the same defanging as the conflict banner's copy in Profiles.tsx.
          setPending({
            codes,
            otherId: clash.id,
            otherName: safeDisplayText(clash.name, 60) || "another profile",
            kind: clash.kind,
          });
          ref.current.onCancel();
          return;
        }
        ref.current.onCommit(codes);
      };
      if (lowLevelActive) {
        settle();
      } else {
        void validateCodes(codes)
          .then((ok) => {
            if (cancelled) return; // capture torn down / cancelled while validating
            if (ok) settle();
            else {
              setWarn("Can’t register that — add a letter/digit, or enable evdev (Settings → Permissions) for modifier-only / AltGr");
              done = false;
            }
          })
          .catch((e) => {
            // A rejected validateCodes (IPC failure) would otherwise wedge the capture: `done` was set
            // true by the keydown caller, so the keyup modifier-only fallback is skipped and nothing
            // commits or warns — the pill hangs on the held chord. Reset + surface so the user can retry.
            if (cancelled) return;
            console.error("validateCodes failed", e);
            setWarn("Couldn’t check that shortcut — try again.");
            done = false;
          });
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        ref.current.onCancel();
        return;
      }
      // eventToCode (not e.code): software-injected chords (SpeechMike-style
      // companion apps) arrive with no scancode, so e.code is ""/"Unidentified".
      const code = eventToCode(e);
      const altGr = altGrPhantomActive(e);
      if (MODIFIER_CODES.has(code)) {
        pressed.add(code);
        // Keep `pressed` and the displayed set in sync: once AltGr is in play the
        // phantom ControlLeft must leave the held set too, or its later keyup
        // (pressed.delete) would diverge from what the pill showed.
        if (altGr && code === "AltRight") pressed.delete("ControlLeft");
        const cur = canonicalizeCodes(dropAltGrPhantom([...pressed], altGr));
        // >= (not >) so a LATER equal-length modifier set wins the tie: on a same-count swap mid-capture
        // (release LeftShift, press LeftAlt while LeftCtrl stays down) peak must track the most-recent
        // maximal set the pill shows (setHeldCodes(cur)), else the keyup fallback commits the abandoned
        // earlier combo. Safe: peak is cleared on real-key press / conflicting retry / blur.
        if (cur.length >= peak.length) peak = cur;
        setHeldCodes(cur);
        return;
      }
      // The user is holding modifiers here, so the passive learner skipped this key;
      // learn its layout label now so the committed chip shows the right keycap.
      learnLetter(code, e.key);
      // A real (non-modifier) key was attempted this hold, so this is no longer a modifier-only
      // chord. Clear `peak` (only ever consumed by the keyup fallback below, which never holds
      // non-modifier keys) so that if this key is rejected as unmappable OR conflicts — leaving
      // `done` false — a later modifier release can't fall into the keyup modifier-only path and
      // silently commit the leftover bare modifier (e.g. Ctrl+Backquote rejected → bare Ctrl bound).
      peak = [];
      // Reject an unmappable key (Backquote, Minus, ContextMenu, …) in BOTH modes. The evdev branch
      // of finalize() commits with no validateCodes gate, so without this an unmappable key under
      // evdev would commit a binding that can never fire. Safe: evdev's non-modifier mappable set
      // equals codeToToken's acceptable set (pinned by every_bindable_code_maps_to_an_evdev_key);
      // modifier-only / AltGr chords return early above and commit via the keyup path.
      if (!codeToToken(code)) {
        setWarn("That key can’t be a global shortcut — try another");
        return;
      }
      done = true;
      finalize(canonicalizeCodes(dropAltGrPhantom([...pressed, code], altGr)));
    };
    const onKeyUp = (e: KeyboardEvent) => {
      e.preventDefault();
      pressed.delete(eventToCode(e));
      setHeldCodes(canonicalizeCodes([...pressed]));
      if (!done && pressed.size === 0 && peak.length > 0) {
        if (lowLevelActive) {
          done = true;
          // Consume `peak` before finalizing: `peak` is a monotonic high-water mark, so if this chord
          // does not end the capture, a retry with an equal-or-shorter modifier-only chord (never
          // exceeds peak.length, so the keydown branch doesn't update it) would re-finalize the OLD
          // stale chord. Clear it so the next attempt rebuilds from scratch; when the capture ends
          // (commit, or a clash parked as `pending`) clearing is harmless. (Complements the
          // real-key-press clear — this is the modifier-only sibling.)
          const chord = peak;
          peak = [];
          finalize(chord);
        } else {
          setWarn("Modifier-only chords need the evdev backend (Settings → Permissions)");
        }
      }
    };
    // If focus is stolen mid-chord (alt-tab, an OS/global-shortcut modifier grab), the matching
    // keyup never arrives — drop the in-progress chord so a phantom-held modifier can't poison the
    // next captured binding, and reset `peak` (which otherwise only ever grows within a session).
    const onBlur = () => {
      pressed.clear();
      peak = [];
      setHeldCodes([]);
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      void reregisterShortcuts().catch((e) => console.error("reregisterShortcuts failed", e));
    };
  }, [capturing, lowLevelActive]);

  const acceptPending = () => {
    if (!pending) return;
    ref.current.onTakeOver(pending.otherId);
    ref.current.onCommit(pending.codes);
    setPending(null);
  };
  const dismissPending = () => setPending(null);

  return { heldCodes, warn, pending, acceptPending, dismissPending };
}

/** A recorded chord another binding already owns, waiting for "Use it here" / "Try again". */
export interface PendingChord {
  codes: string[];
  otherId: string;
  /** Display-safe name of the owner (profile name, or "Quick add"). */
  otherName: string;
  kind: ConflictKind;
}
