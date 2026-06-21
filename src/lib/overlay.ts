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
import { backendForProfile, homeTargetProfile } from "./dictation";
import { activeStatsBackend } from "./usage";
import { fmtCompact, fmtDuration } from "./format";
import type { DictationStatus, OverlayStatsMetric, UsageStats } from "./types";

/** Build the chip's tiny usage readout (today's value) for the chosen metric. */
function chipStatsLine(u: UsageStats, metric: OverlayStatsMetric): string {
  const words = `${fmtCompact(u.today.words)} words`;
  const mins = `${fmtDuration(u.today.audio_s)} today`;
  if (metric === "audio") return mins;
  if (metric === "both") return `${fmtCompact(u.today.words)}w · ${fmtDuration(u.today.audio_s)}`;
  return words;
}

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
      state.warming !== prev.warming || // mic warm-up gate (chip "warming up…")
      state.level !== prev.level ||
      state.partial !== prev.partial ||
      state.dictationError !== prev.dictationError ||
      state.activeProfile !== prev.activeProfile || // switching Profiles mid-session
      state.profiles !== prev.profiles || // a rename/tag/language edit changes the chip identity tag
      state.backends !== prev.backends || // a bound-backend language/endpoint edit changes language/mode
      state.targetApp !== prev.targetApp || // injection target (chip "→ app" readout)
      state.targetSkip !== prev.targetSkip ||
      state.lastInsert !== prev.lastInsert || // per-phrase "inserted" pulse trigger
      state.sessionOutcome !== prev.sessionOutcome || // end-of-session done marker
      state.usage !== prev.usage || // P28: refreshed usage stats → update the chip readout
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
        const backend = backendForProfile(chipProfile, state.backends);
        chip = {
          profileTag: chipTagFor(chipProfile),
          // Effective language: a set per-Profile override wins; else the Backend's.
          language: chipProfile.language?.trim() ? chipProfile.language : backend?.language,
          mode: backend?.endpoint,
        };
      }
      // P28: a tiny usage readout (today's words/minutes) for the chip, gated by the
      // setting. Scoped to the same backend the stats controller tracks; omitted when
      // off or the backend has no usage yet (standard/old server, not fetched).
      let statsLine: string | undefined;
      if (rec.showStatsOnOverlay) {
        const sb = activeStatsBackend(state);
        const u = sb ? state.usage[sb.id] : null;
        if (u) statsLine = chipStatsLine(u, rec.overlayStatsMetric);
      }
      // P16/D: the app being injected into (+ why, if it's coerced to clipboard), gated by the
      // setting and sent only while a session is active so the standby dock shows no stale target.
      const tgt = rec.showTargetOnOverlay && ACTIVE.includes(state.status) ? state.targetApp : null;
      void emit("dictation://update", {
        status: state.status,
        warming: state.warming, // mic opening but not yet capturing → chip shows "warming up…"
        level: state.level,
        // "Live transcript in overlay" off → show the status label, not words. In "on hover"
        // mode the words are still sent but the chip only surfaces them while hovered.
        partial: rec.realtimePreview ? state.partial : "",
        previewOnHover: rec.realtimePreview && rec.realtimePreviewOnHover,
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
        // The injection target app title + a skip reason ("blocked" / "notEditable") for the
        // warn-tinted hint. Empty when the feature's off, no app is known, or the session's idle.
        targetTitle: tgt?.title ?? "",
        targetSkip: tgt ? (state.targetSkip ?? "") : "",
        targetOnlySpeaking: rec.showTargetOnlySpeaking,
        // When on, the chip reveals the target only while hovered (vs. always shown).
        targetOnHover: rec.showTargetOnOverlay && rec.showTargetOnHover,
        // P19: per-phrase "inserted" pulse + truthful end-of-session done marker. Sent
        // UNGATED by ACTIVE — the done marker must reach the chip on the idle transition.
        lastInsert: state.lastInsert,
        sessionOutcome: state.sessionOutcome,
        statsLine: statsLine ?? "",
        // When on, the chip reveals the readout only while hovered (vs. always shown).
        statsOnHover: rec.showStatsOnOverlay && rec.overlayStatsOnHover,
        // When on, the chip reveals the Profile tag only while hovered (vs. always shown).
        profileOnHover: rec.showProfileOnOverlay && rec.showProfileOnHover,
        ...chip,
      });
    }

    // Reflect status in the tray tooltip — the reliable status cue on chip-less platforms
    // (GNOME / non-KDE Wayland). Fire on a warming change too so the cold-mic warm-up reads
    // "warming up…" there like every other surface, instead of falsely claiming "recording…".
    if (state.status !== prev.status || state.warming !== prev.warming) {
      void setTrayState(state.warming && state.status === "listening" ? "warming" : state.status);
    }
    // Cues stay keyed on status TRANSITIONS only (not warming), so a warm-up flip can't re-fire them.
    if (state.status !== prev.status) {
      if (state.settings.general.soundEffects) {
        // Only chime "stop" if the mic actually went live this session — a session ENDED during
        // warm-up (stopLive sets {transcribing, warming:false} in one update, mic never live) would
        // otherwise play a "stop" with no preceding "start".
        if (state.status === "transcribing" && prev.status === "listening" && state.micLive) void playCue("stop");
        else if (state.status === "error") void playCue("error");
      }
    }
    // The "start" cue fires when the mic actually goes LIVE — gated on the micLive edge (real audio
    // flowed, or the warm-up safety timeout fired), NOT merely on warming clearing: a session that
    // DIES during warm-up (a teardown clears warming with the mic never live) must not chime "start".
    // On a cold Bluetooth mic this is ~1–2s after arming, so the "go" lines up with real capture.
    if (state.settings.general.soundEffects && state.micLive && !prev.micLive) {
      void playCue("start");
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
