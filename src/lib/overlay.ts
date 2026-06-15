// Dictation chip controller (runs in the main window). The chip is a separate
// webview with its own JS context, so it can't read this window's store; instead
// we broadcast the assembled `{status, level, partial}` as a `dictation://update`
// event (the overlay listens for it) and drive the window's show/hide via Rust.
//
// Show/hide is gated by the Recording → indicator-position setting ("top" |
// "bottom" | "off"). The chip lingers briefly after a session so the final
// transcript (or an error) stays readable before it disappears.

import { useApp } from "./store";
import { isTauri, showOverlay, hideOverlay, setTrayState, playCue } from "./api";
import { chipTagFor } from "./profileTag";
import { homeTargetProfile } from "./dictation";
import type { DictationStatus } from "./types";

const ACTIVE: DictationStatus[] = ["listening", "transcribing", "injecting"];

let started = false;
let visible = false;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
// The edge the window was last placed at, so we only re-place (move the OS window) when it
// actually changes — the edge-peek itself is a pure CSS transform inside the chip.
let shownPos: "top" | "bottom" | undefined;

export async function initOverlayController(): Promise<void> {
  if (!isTauri || started) return;
  started = true;

  const { emit } = await import("@tauri-apps/api/event");

  useApp.subscribe((state, prev) => {
    // Forward the live chip state whenever the relevant fields change.
    if (
      state.status !== prev.status ||
      state.level !== prev.level ||
      state.partial !== prev.partial ||
      state.dictationError !== prev.dictationError ||
      state.activeProfile !== prev.activeProfile || // switching Profiles mid-session
      state.settings !== prev.settings // theme / position / preview / show-profile toggles
    ) {
      const rec = state.settings.recording;
      // Which Profile is dictating, for the chip's identity tag (+ its language /
      // stream-vs-batch mode). Resolved here because the overlay webview can't read
      // this store. Omitted entirely when the feature is off or no Profile is active.
      let chip: { profileTag?: string; language?: string; mode?: "stream" | "batch" } = {};
      // The Profile to label the chip with: the one dictating, or — for a persistent
      // idle dock — the home target it would launch (so standby previews that Profile).
      const chipProfile = state.activeProfile
        ? state.profiles.find((p) => p.id === state.activeProfile)
        : rec.persistentDock
          ? homeTargetProfile(state.profiles, state.settings.homeProfileId)
          : undefined;
      if (rec.showProfileOnOverlay && chipProfile) {
        const backend = state.backends.find((b) => b.id === chipProfile.backendId) ?? state.backends[0];
        chip = {
          profileTag: chipTagFor(chipProfile),
          // Effective language: a set per-Profile override wins; else the Backend's.
          language: chipProfile.language?.trim() ? chipProfile.language : backend?.language,
          mode: backend?.endpoint,
        };
      }
      void emit("dictation://update", {
        status: state.status,
        level: state.level,
        // "Live transcript in overlay" off → show the status label, not words.
        partial: rec.realtimePreview ? state.partial : "",
        dictationError: state.dictationError ?? "",
        // So the chip can pin itself to the correct edge of its window.
        position: rec.indicatorPosition,
        // So the chip can follow the app's dark/light theme.
        theme: state.settings.theme,
        // Overlay-chip behaviour (persistent dock / edge-peek / quick-launch).
        persistentDock: rec.persistentDock ?? false,
        overlayPeek: rec.overlayPeek ?? false,
        peekTimeoutSec: rec.peekTimeoutSec ?? 30,
        peekWhileActive: rec.peekWhileActive ?? false,
        dimAfterSec: rec.dimAfterSec ?? 10,
        hoverRevealMs: rec.hoverRevealMs ?? 1000,
        quickLaunch: rec.quickLaunch ?? [],
        ...chip,
      });
    }

    // On a status change, reflect it in the tray and play the matching cue —
    // the reliable status signal where the overlay can't be pinned.
    if (state.status !== prev.status) {
      void setTrayState(state.status);
      if (state.settings.general.soundEffects) {
        if (state.status === "listening" && prev.status !== "listening") void playCue("start");
        else if (state.status === "transcribing" && prev.status === "listening") void playCue("stop");
        else if (state.status === "error") void playCue("error");
      }
    }

    const pos = state.settings.recording.indicatorPosition;
    const persistent = state.settings.recording.persistentDock && pos !== "off";
    const active = ACTIVE.includes(state.status);
    const prevActive = ACTIVE.includes(prev.status);

    // Shown while a session is active, OR always (as a standby dot) when the dock is on.
    if (pos !== "off" && (active || persistent)) {
      clearTimeout(hideTimer);
      // (Re)place the window on first show, on session start, or when the edge changes. The
      // window is anchored flush against that edge and never moves again for the peek — the
      // edge-peek tuck is a pure CSS transform in the chip (Overlay.tsx), so it animates
      // reliably and can't desync with an OS window-move (which Wayland applies instantly).
      if (!visible || (active && !prevActive) || pos !== shownPos) {
        void showOverlay(pos);
        shownPos = pos;
      }
      visible = true;
      return;
    }

    // Inactive (and no persistent dock), or the overlay is disabled — hide it (with a
    // linger so the final transcript / error stays readable; immediately if turned off).
    if (visible) {
      clearTimeout(hideTimer);
      const delay = pos === "off" ? 0 : state.status === "error" ? 2400 : 1800;
      hideTimer = setTimeout(() => {
        visible = false;
        shownPos = undefined; // force a re-place (and re-anchor) on the next show
        void hideOverlay();
      }, delay);
    }
  });
}
