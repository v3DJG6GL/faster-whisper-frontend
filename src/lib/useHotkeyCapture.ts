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
    void suspendShortcuts();
    const pressed = new Set<string>();
    let peak: string[] = [];
    let done = false;
    const finalize = (codes: string[]) => {
      const clash = findChordConflict(codes, ref.current.others);
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
        void validateCodes(codes).then((ok) => {
          if (ok) ref.current.onCommit(codes);
          else {
            setWarn("Can’t register that — add a letter/digit, or enable evdev (Settings → Permissions) for modifier-only / AltGr");
            done = false;
          }
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
        if (cur.length > peak.length) peak = cur;
        setHeldCodes(cur);
        return;
      }
      // The user is holding modifiers here, so the passive learner skipped this key;
      // learn its layout label now so the committed chip shows the right keycap.
      learnLetter(e.code, e.key);
      if (!codeToToken(e.code) && !evdevActive) {
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
          finalize(peak);
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
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      void reregisterShortcuts();
    };
  }, [capturing, evdevActive]);

  return { heldCodes, warn };
}
