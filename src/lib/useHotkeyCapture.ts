// Shared hotkey-capture hook. Tracks held modifiers live; finalizes on the first
// real key (or, with evdev active, on release of a modifier-only chord). Warns
// (never silently drops) on a clash with another binding or a non-registerable
// chord. Suspends global hotkeys for the duration so a press only rebinds.
//
// Used by the Profiles editor (dictation chords) and the Settings "quick-add
// shortcut" row, so both behave identically. `others` is the set of bindings to
// check against for conflicts (e.g. the Profiles), passed as Profile[].

import { useEffect, useRef, useState } from "react";
import { validateCodes, suspendShortcuts, reregisterShortcuts } from "./api";
import { MODIFIER_CODES, codeToToken, canonicalizeCodes } from "./keys";
import { learnLetter } from "./keyboardLayout";
import { findChordConflict } from "./conflicts";
import type { Profile } from "./types";

export function useHotkeyCapture(opts: {
  capturing: boolean;
  evdevActive: boolean;
  others: Profile[];
  onCommit: (codes: string[]) => void;
  onCancel: () => void;
}): { heldCodes: string[]; warn: string | null } {
  const { capturing, evdevActive } = opts;
  const [heldCodes, setHeldCodes] = useState<string[]>([]);
  const [warn, setWarn] = useState<string | null>(null);
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
    void suspendShortcuts().catch((e) => console.error("suspendShortcuts failed", e));
    const pressed = new Set<string>();
    let peak: string[] = [];
    let done = false;
    // A validateCodes() resolution that lands after the user cancels (Escape) or the
    // capture effect tears down must not commit the abandoned chord (mirrors the
    // cancelled-flag guard in useOverrideContext).
    let cancelled = false;
    const finalize = (codes: string[]) => {
      // evdev inactive ⇒ the plugin backend collapses L/R modifier sides, so collapse them for the
      // clash check too (a side-only-different chord would otherwise warn-free yet collide).
      const clash = findChordConflict(codes, ref.current.others, !evdevActive);
      if (clash) {
        setWarn(
          clash.kind === "duplicate"
            ? `Same shortcut as “${clash.name}”`
            : `Overlaps “${clash.name}” — one chord shadows the other`,
        );
        done = false;
        return;
      }
      if (evdevActive) {
        ref.current.onCommit(codes);
      } else {
        void validateCodes(codes)
          .then((ok) => {
            if (cancelled) return; // capture torn down / cancelled while validating
            if (ok) ref.current.onCommit(codes);
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
      if (MODIFIER_CODES.has(e.code)) {
        pressed.add(e.code);
        const cur = canonicalizeCodes([...pressed]);
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
      learnLetter(e.code, e.key);
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
      if (!codeToToken(e.code)) {
        setWarn("That key can’t be a global shortcut — try another");
        return;
      }
      done = true;
      finalize(canonicalizeCodes([...pressed, e.code]));
    };
    const onKeyUp = (e: KeyboardEvent) => {
      e.preventDefault();
      pressed.delete(e.code);
      setHeldCodes(canonicalizeCodes([...pressed]));
      if (!done && pressed.size === 0 && peak.length > 0) {
        if (evdevActive) {
          done = true;
          // Consume `peak` before finalizing: on a CONFLICTING modifier-only chord, finalize sets
          // done=false and keeps capture open, but `peak` (a monotonic high-water mark) would stay —
          // so a retry with an equal-or-shorter modifier-only chord (never exceeds peak.length, so
          // line ~92 doesn't update it) would re-finalize the OLD stale chord. Clear it so the next
          // attempt rebuilds from scratch; on a successful commit capture ends anyway, so clearing is
          // harmless. (Complements the real-key-press clear — this is the modifier-only sibling.)
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
  }, [capturing, evdevActive]);

  return { heldCodes, warn };
}
