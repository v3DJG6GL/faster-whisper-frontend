import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence, MotionConfig } from "motion/react";
import { Check, X } from "lucide-react";
import { Waveform } from "@/components/Waveform";
import { setChipHitRegion, emitOverlayAction, showMainAtScreen } from "@/lib/api";
import { cn } from "@/lib/cn";
import { quickLaunchMeta } from "@/lib/screens";
import { newSpeakMemo, stepSpeaking } from "@/lib/speaking";
import { dictationVisual, type DictationTone } from "@/lib/dictationVisual";
import type { DictationStatus, ThemeName, OverlayQuickAction } from "@/lib/types";

interface ChipState {
  status: DictationStatus;
  level: number;
  partial: string;
  dictationError: string;
  position: "top" | "bottom" | "off";
  theme: ThemeName;
  // Active-Profile indicator (optional; absent when the feature is off / no Profile).
  profileTag?: string;
  language?: string;
  mode?: "stream" | "batch";
  // P16/D: the app dictation is typing into (→ readout) + why it's coerced to clipboard
  // ("blocked" by a per-app rule / "notEditable" by deep detection). Empty = nothing to show.
  targetTitle?: string;
  targetSkip?: "blocked" | "notEditable" | "";
  targetOnlySpeaking?: boolean; // hide the target unless the chip is expanded (actively dictating)
  // Overlay-chip behaviour, forwarded from settings via dictation://update.
  persistentDock: boolean;
  overlayPeek: boolean;
  peekTimeoutSec: number;
  peekWhileActive: boolean;
  dimAfterSec: number;
  hoverRevealMs: number;
  quickLaunch: OverlayQuickAction[];
}

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Maps a dictationVisual() tone token → the chip's dot fill class. The chip layers
// its own edge-tuck (peeked) / standby-dock presentation on top — see dotColorClass.
const TONE_BG: Record<DictationTone, string> = {
  faint: "bg-faint",
  accent: "bg-accent",
  live: "bg-live",
  dim: "bg-dim",
  rec: "bg-rec",
};

// After speech stops, the pill stays expanded this long before collapsing back to
// the dot — so the last words you spoke remain readable instead of vanishing the
// instant you pause. Stacks on top of SILENCE_HOLD_MS.
const COLLAPSE_LINGER_MS = 2000;

// The chip morph: one element fluidly grows from a calm dot into the full pill
// (Motion `layout` → FLIP/transform, smooth on WebKit). Spring tuned snappy-but-
// settled (Apple-fluid). We deliberately DON'T use backdrop-blur — on WebKitGTK
// over a transparent window it re-blurs every frame during the resize (jitter)
// and barely shows behind a ~96% opaque fill anyway.
// A short, monotonic tween rather than a spring: spring overshoot scales the pill
// past its target and bounces back, which re-rasterizes the rounded clip many times
// on WebKitGTK (the morph "flicker"). A brief ease-out is smooth and too quick to
// perceive any residual edge re-raster.
const MORPH = { type: "tween", duration: 0.2, ease: [0.22, 1, 0.36, 1] } as const;

// Deep-idle edge-peek: after the chip sits undisturbed for the user's peekTimeoutSec, it
// slides (in CSS) so only the status dot's outer half hugs the screen edge; any activity
// restores it. After a hover, hold off re-peeking this long so a hover-restore (which slides
// the chip away from the edge, out from under the cursor) can't immediately re-peek.
const PEEK_HOVER_GRACE_MS = 6000;

// Edge-peek geometry — pure CSS. The overlay window is anchored FLUSH against the screen edge
// (overlay.rs), so the webview's own edge IS the screen edge. At rest the chip is inset
// EDGE_MARGIN from it; tucked, it slides by PEEK_TUCK so the status dot's centre lands on the
// edge — only the dot's outer half stays on-screen, the rest clipped by the viewport (the
// reliable "half-dot at the border" a Wayland window-move can't give us). PEEK_TUCK = the
// container pad (pt-2/pb-2 = 8px) + half the 42px pill = the dot centre's offset from the
// chip's leading edge.
const EDGE_MARGIN = 28;
const PEEK_TUCK = 29;

// "Stay hidden while dictating" (peekWhileActive): once a session is live, tuck the dot
// back to the edge after this short settle rather than waiting the full peekTimeoutSec — the
// chip is meant to stay hidden, so it shouldn't sit expanded for half a minute first.
const PEEK_ACTIVE_SETTLE_MS = 700;

/**
 * The dictation chip — a frameless, transparent, always-on-top window painted by
 * Rust at the top-center of the screen, fed `dictation://update` (status, level,
 * partial, error). Amber = mic-active (the OS "mic in use" convention); green =
 * actively speaking; red = error ONLY. Armed-but-silent is a calm dim-amber
 * breathing dot that smoothly EXPANDS into a pill with green voice-reactive bars +
 * transcript when you speak, and collapses back on silence.
 */
export default function Overlay() {
  const [state, setState] = useState<ChipState>({
    status: "listening",
    level: 0.2,
    partial: "",
    dictationError: "",
    position: "top",
    theme: "dark",
    persistentDock: false,
    overlayPeek: false,
    peekTimeoutSec: 30,
    peekWhileActive: false,
    dimAfterSec: 10,
    hoverRevealMs: 1000,
    quickLaunch: [],
  });

  // Live updates from the Rust core when running under Tauri.
  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<ChipState>("dictation://update", (e) => {
          const theme = e.payload.theme ?? "dark";
          // Follow the app's dark/light theme (the chip is a separate webview).
          document.documentElement.dataset.theme = theme;
          setState({
            ...e.payload,
            dictationError: e.payload.dictationError ?? "",
            position: e.payload.position ?? "top",
            theme,
            persistentDock: e.payload.persistentDock ?? false,
            overlayPeek: e.payload.overlayPeek ?? false,
            peekTimeoutSec: e.payload.peekTimeoutSec ?? 30,
            peekWhileActive: e.payload.peekWhileActive ?? false,
            dimAfterSec: e.payload.dimAfterSec ?? 10,
            hoverRevealMs: e.payload.hoverRevealMs ?? 1000,
            quickLaunch: e.payload.quickLaunch ?? [],
            targetTitle: e.payload.targetTitle ?? "",
            targetSkip: e.payload.targetSkip ?? "",
            targetOnlySpeaking: e.payload.targetOnlySpeaking ?? false,
          });
        }),
      )
      .then((un) => {
        // If the effect was torn down before listen() resolved (StrictMode's
        // mount→unmount→remount), drop the subscription instead of leaking it.
        if (cancelled) un();
        else unlisten = un;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Standalone demo animation (browser preview only).
  const raf = useRef(0);
  useEffect(() => {
    if (isTauri) return;
    const sample = "this is a live preview of the dictation chip";
    let t = 0;
    const tick = () => {
      t += 0.05;
      const level = Math.max(0, Math.min(1, 0.45 + 0.4 * Math.sin(t * 3) + (Math.random() - 0.5) * 0.25));
      const chars = Math.min(sample.length, Math.floor((t * 6) % (sample.length + 30)));
      setState({
        status: "listening",
        level,
        partial: sample.slice(0, chars),
        dictationError: "",
        position: "top",
        theme: "dark",
        profileTag: "SWISS-DE",
        language: "de-CH",
        mode: "stream",
        targetTitle: "Kate",
        targetSkip: "",
        targetOnlySpeaking: false,
        persistentDock: true,
        overlayPeek: false,
        peekTimeoutSec: 30,
        peekWhileActive: false,
        dimAfterSec: 10,
        hoverRevealMs: 1000,
        quickLaunch: [
          { id: "d1", kind: "screen", target: "profiles" },
          { id: "d2", kind: "screen", target: "backends" },
          { id: "d3", kind: "action", target: "toggle-dictation" },
        ],
      });
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, []);

  // Derive speaking vs silent from the level stream (only while listening), via the
  // SHARED detector so the chip agrees with the main-window surfaces (see lib/speaking).
  const [speaking, setSpeaking] = useState(false);
  const speakMemo = useRef(newSpeakMemo());
  useEffect(() => {
    const sp = stepSpeaking(speakMemo.current, state.level, state.status === "listening", performance.now());
    if (sp !== speaking) setSpeaking(sp);
  }, [state.level, state.status, speaking]);

  // Collapsed = armed but silent (or idle, when the window is hidden anyway).
  const wantExpanded =
    state.status === "transcribing" ||
    state.status === "injecting" ||
    state.status === "error" ||
    (state.status === "listening" && speaking);

  // Expand instantly when speech (or a state change) wants it; collapse only after a
  // linger, so the final words linger on screen rather than snapping shut on a pause.
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (wantExpanded) {
      setExpanded(true);
      return;
    }
    const t = setTimeout(() => setExpanded(false), COLLAPSE_LINGER_MS);
    return () => clearTimeout(t);
  }, [wantExpanded]);

  // Hover-to-reveal: holding the cursor over the chip for ≥1s expands it to show
  // the language + stream/batch detail beside the tag. (Under Tauri this only fires
  // once the chip's input region is shaped — see overlay.rs / setChipHitRegion;
  // in the browser preview there's no click-through, so it works directly.)
  const [hoverReveal, setHoverReveal] = useState(false);
  const [hovering, setHovering] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // After any hover, hold off the deep-idle peek for a grace period (anti-oscillation).
  const peekGraceUntil = useRef(0);
  // Deep-idle edge-peek: true when the chip has tucked to the screen edge (driven below).
  const [peeked, setPeeked] = useState(false);
  // True while restoring a *tucked* chip via hover — captured at pointer-enter (was it peeked?).
  // Anchors the restored pill flush to the edge so it stays under the edge-parked cursor through
  // the un-tuck slide; otherwise the pill slides inward to its rest inset and the cursor (still at
  // the edge) falls off it, dropping the hover before it can reveal. A non-tucked hover leaves it
  // false → the pill keeps its normal rest inset (no jump out from under the cursor).
  const [peekRestoring, setPeekRestoring] = useState(false);
  const onPointerEnter = () => {
    setHovering(true);
    setPeekRestoring(peeked); // remember whether the chip was tucked when this hover began
    peekGraceUntil.current = performance.now() + PEEK_HOVER_GRACE_MS;
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    // Hover-intent dwell: wait the configured delay before revealing — so a fly-over
    // doesn't expand the chip, and the reveal (detail + quick-launch) happens in ONE step.
    hoverTimer.current = setTimeout(() => setHoverReveal(true), state.hoverRevealMs);
  };
  const onPointerLeave = () => {
    setHovering(false);
    setPeekRestoring(false);
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setHoverReveal(false);
  };
  const detail = [state.language, state.mode].filter(Boolean).join(" · ");
  // P16/D target readout: overlay.ts only sends `targetTitle` while a session is active AND the
  // "Show injection target" setting is on, so its presence alone gates the chip's "→ app" segment.
  // A `targetSkip` reason means injection was coerced to the clipboard → tint the readout warn.
  const showTarget = !!state.targetTitle && (!state.targetOnlySpeaking || expanded);
  const targetWarn = !!state.targetSkip;
  const skipLabel = state.targetSkip === "blocked" ? "blocked" : "not a text field";

  // Report the chip's on-screen bounds to Rust, which shapes the overlay window's
  // input region to just that rectangle — so only the chip captures the cursor and
  // the rest of the transparent strip stays click-through. Measured in CSS px from
  // the window's top-left (= the webview viewport), which maps to GDK's logical
  // coordinate space. No-op outside Tauri.
  const chipRef = useRef<HTMLDivElement>(null);
  const reportBounds = useCallback(() => {
    // While hovering, hold the input region at the FULL window instead of the chip's
    // live bounds. WebKitGTK turns a GDK leave into a synthesized mouse-move and clears
    // :hover only by hit-testing it — so if the input region is reshaped (the body's
    // hover-expand) at the instant the cursor crosses the old boundary, that move lands
    // outside the new shape, the pointerleave is dropped, and `hovering`/`hoverReveal`
    // stick true: the chip stays expanded, never dims, never peeks, until the next hover.
    // A stable boundary STRICTLY LARGER than the grown pill (the whole window) keeps the
    // cursor inside the shape through the morph, so the eventual leave crosses the fixed
    // window edge and fires reliably. Reverts to the precise chip rect on leave (so the
    // strip is click-through again). Growing to full-window happens while the cursor is
    // safely interior (on the chip), so it never drops a crossing itself.
    if (hovering) {
      void setChipHitRegion(0, 0, window.innerWidth, window.innerHeight);
      return;
    }
    const el = chipRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) void setChipHitRegion(r.x, r.y, r.width, r.height);
  }, [hovering]);
  // Report bounds ONLY at settled moments — never mid-morph. A region that resizes
  // out from under the cursor causes hover enter/leave thrash (chip flickering
  // open/closed, "stuck" open, needing a click to wake). So updates come only from
  // the width animations settling (`onAnimationComplete`/`onExitComplete` below) plus
  // a few retries when a session starts or the chip moves (the overlay window
  // realizes its GdkWindow asynchronously on show).
  // The chip is interactive (hoverable / clickable) whenever it's on screen: during a
  // session, or — with the dock on — in standby too. Outside Tauri the calls no-op.
  const interactive = state.status !== "idle" || (state.persistentDock && state.position !== "off");
  // `state.status` MUST be a dependency: show_overlay re-applies set_ignore_cursor_events(true) on
  // every (re)show — including the standby→session re-center in overlay.ts — which WIPES the input
  // shape and makes the whole window click-through again. With the dock on, neither `interactive`
  // nor `peeked` changes on session start, so without `status` the shape was never re-applied and
  // the chip stayed unhoverable for the entire session. The late 1500ms retry guarantees the final
  // re-report lands AFTER show_overlay's click-through reset (the early retries can race it).
  useEffect(() => {
    if (!interactive) return;
    const ids = [0, 160, 420, 850, 1500].map((ms) => setTimeout(reportBounds, ms));
    return () => ids.forEach(clearTimeout);
  }, [reportBounds, interactive, state.status, state.position, peeked]);

  // Safety net for a lost pointerleave. `hovering`/`hoverReveal` are reset ONLY in
  // onPointerLeave, so any event that drops the leave strands them true (chip stuck
  // expanded, never dims, never peeks). The full-window hover region above prevents the
  // common morph-race; this covers the rarer case where the window hides at session end
  // (or its input shape is wiped on re-show) while the cursor is over the chip — when the
  // chip isn't interactive it can't be hovered, so clear the hover state to be sure it
  // comes back clean rather than stuck.
  useEffect(() => {
    if (interactive) return;
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setHovering(false);
    setHoverReveal(false);
    setPeekRestoring(false);
  }, [interactive]);

  // After sitting calm for `dimAfterSec`, fade the chip down so it's unobtrusive; any
  // speech / hover / state change snaps it back to full opacity. Applies to BOTH calm
  // resting states — an armed-but-silent session AND a docked standby dot — so the dock
  // dims when dictation is off too. 0 = never dim. (The amber/colour cue persists at 0.4,
  // so a live mic is still signalled.)
  const [dimmed, setDimmed] = useState(false);
  useEffect(() => {
    setDimmed(false);
    const restingCalm = (state.status === "listening" && !speaking) || state.status === "idle";
    if (expanded || hovering || !restingCalm || state.dimAfterSec <= 0) return;
    const t = setTimeout(() => setDimmed(true), state.dimAfterSec * 1000);
    return () => clearTimeout(t);
  }, [expanded, hovering, state.status, speaking, state.dimAfterSec]);

  // Keep the newest words in view: pin the preview to its right edge.
  const textRef = useRef<HTMLDivElement>(null);
  const [faded, setFaded] = useState(false);
  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.scrollLeft = el.scrollWidth;
    setFaded(el.scrollWidth - el.clientWidth > 2);
  }, [state.partial, expanded]);

  // Post-speech "working" phase: the server is finalizing the transcript and/or it's
  // being written out to the focused field. There's no audio to react to, so the chip
  // shows a self-driven processing motion (sweeping bars + a quicker pulsing dot)
  // rather than the frozen-looking bars it used to.
  const processing = state.status === "transcribing" || state.status === "injecting";
  const standby = state.status === "idle"; // only ever visible when persistentDock is on

  // One-shot "✓ done" flash when a session completes (finishing → idle) — but NOT when
  // it was cancelled (the ✕ / a hotkey-cancel sets `cancelling`). A single play that
  // stops reads as "finished", distinct from the looping processing motion.
  const prevStatus = useRef(state.status);
  const cancelling = useRef(false);
  const [justDone, setJustDone] = useState(false);
  useEffect(() => {
    const prev = prevStatus.current;
    prevStatus.current = state.status;
    if ((prev === "transcribing" || prev === "injecting") && state.status === "idle") {
      if (cancelling.current) {
        cancelling.current = false;
        return;
      }
      setJustDone(true);
      const t = setTimeout(() => setJustDone(false), 750);
      return () => clearTimeout(t);
    }
  }, [state.status]);

  const label =
    state.status === "transcribing"
      ? "finalizing…"
      : state.status === "injecting"
        ? "inserting…"
        : "listening";

  // Status dot colour (NEVER red while listening) via the SHARED dictationVisual()
  // mapping — so the chip, sidebar dot, Home button + waveforms all agree. The chip
  // layers its own presentation on top: a tucked (peeked) dot is SOLID so its visible
  // half reads (a hollow standby ring would all but vanish at half-size), and the
  // docked standby dot at rest is a hollow ring. Active states (error / speaking /
  // finishing) keep their tone even while tucked.
  const vis = dictationVisual(state.status, speaking);
  const dotColorClass =
    vis.state === "error" || vis.state === "speaking" || vis.state === "processing"
      ? TONE_BG[vis.tone]
      : peeked
        ? standby
          ? "bg-dim"
          : "bg-accent"
        : standby
          ? "border border-faint bg-transparent"
          : "bg-accent";
  const dotGlow =
    vis.state === "error"
      ? "0 0 10px rgba(255,92,70,0.5)"
      : vis.state === "speaking"
        ? "0 0 12px rgba(54,208,122,0.5)"
        : vis.state === "processing"
          ? "0 0 8px rgba(168,159,147,0.35)" // finishing: faint neutral
          : peeked
            ? standby
              ? "0 0 10px rgba(168,159,147,0.5)" // tucked idle: soft neutral halo
              : "0 0 12px rgba(255,158,44,0.6)" // tucked armed: amber halo
            : standby
              ? "none"
              : !expanded
                ? "0 0 12px rgba(255,158,44,0.55)" // calm breathing ember
                : "0 0 8px rgba(255,158,44,0.4)";
  const barTone = speaking ? "live" : "accent";

  // Deep-idle edge-peek driver: after the chip sits undisturbed for peekTimeoutSec, tuck it to
  // the edge; ANY activity — a status change (e.g. dictation starting), speech, finishing, a
  // hover, or disabling the feature — pops it back and re-arms the timer. The window never
  // moves (it's anchored flush at the edge, overlay.rs), so the tuck is a pure CSS transform:
  // it animates reliably and can't desync with an OS window-move. The hit-region effect above
  // re-reports the chip's bounds whenever `peeked` flips, so the tucked sliver stays hoverable.
  //
  // "Stay hidden while dictating" (peekWhileActive) flips this: active states no longer pop
  // it out, and status flips no longer bounce it — the dot stays tucked through the whole
  // session, conveying state via colour + pulse only. Hover and errors still override (so you
  // can always read the transcript / see a failure); completion settles back without popping.
  const lastPeekStatus = useRef(state.status);
  useEffect(() => {
    const statusChanged = lastPeekStatus.current !== state.status;
    lastPeekStatus.current = state.status;
    const activeStatus =
      state.status === "listening" || state.status === "transcribing" || state.status === "injecting";
    const keepMin = state.overlayPeek && state.peekWhileActive && state.position !== "off";
    // Only an undisturbed armed-but-silent session, or a persistent standby dock, ever peeks —
    // unless keep-minimized is on, where any active state stays tucked too. A tucked chip
    // un-tucks on hover via `hoverReveal` (the dwell-delayed hover-intent flag), NOT raw
    // `hovering` — so restoring it waits the SAME delay as the body/detail reveal. Keying it on
    // `hovering` made a tucked ("hidden") chip pop out the instant the cursor grazed it while a
    // resting ("minimized") dot correctly waited out hoverRevealMs; the two felt inconsistent and
    // a fly-over flicked the pill open. An error always pops out so its message is readable.
    const blocked =
      !state.overlayPeek ||
      state.position === "off" ||
      hoverReveal ||
      state.status === "error" ||
      (!keepMin && (speaking || processing || expanded));
    const eligible = !blocked && (standby || (keepMin ? activeStatus : state.status === "listening"));
    if (!eligible) {
      setPeeked(false);
      return;
    }
    // Normal mode bounces out on fresh activity (a status change) then re-arms; keep-minimized
    // glues the dot in place across the whole lifecycle (listening → finalizing → done).
    if (statusChanged && !keepMin) setPeeked(false);
    // Idle/standby honours the user's full inactivity timeout; a live keep-minimized session
    // tucks promptly instead. A recent hover extends either via the grace floor.
    const base =
      keepMin && activeStatus && !standby ? PEEK_ACTIVE_SETTLE_MS : state.peekTimeoutSec * 1000;
    const wait = Math.max(base, peekGraceUntil.current - performance.now());
    const t = setTimeout(() => setPeeked(true), wait);
    return () => clearTimeout(t);
  }, [
    state.overlayPeek,
    state.peekWhileActive,
    state.position,
    state.status,
    state.peekTimeoutSec,
    hovering,
    hoverReveal,
    speaking,
    processing,
    expanded,
    standby,
  ]);

  // Quick-launch: icon buttons shown when hovering the idle/standby chip (never while
  // peeked, speaking, finishing, or in error). Screen entries focus + navigate the main
  // window; action entries run a dictation action (routed through the main window).
  const hasQuickLaunch = state.quickLaunch.length > 0;
  const restingIdle = (state.status === "listening" && !speaking) || standby;
  // Gate quick-launch on the SAME delayed hover-intent as the language/mode detail (not raw
  // `hovering`), so the chip reveals everything in one step after the dwell — never expanding
  // abruptly under the cursor right as you reach for a button.
  const showQuickLaunch = restingIdle && hoverReveal && !peeked && hasQuickLaunch;
  const runQuickLaunch = (e: OverlayQuickAction) => {
    if (e.kind === "screen") void showMainAtScreen(e.target);
    else void emitOverlayAction(e.target);
  };

  // Edge-peek slide offset (CSS translateY). The window is anchored flush at the screen edge
  // (overlay.rs); at rest the chip is inset EDGE_MARGIN from it, and tucking slides it so the
  // status dot's centre lands on the edge — only the dot's outer half stays on-screen (the
  // rest is clipped by the viewport edge). Mirrored for the bottom edge.
  const restY = state.position === "bottom" ? -EDGE_MARGIN : EDGE_MARGIN;
  const tuckY = state.position === "bottom" ? PEEK_TUCK : -PEEK_TUCK;
  // Restoring a tucked chip via hover: anchor the pill FLUSH to the edge (not the rest inset) so
  // it expands right under the edge-parked cursor and the pill's pointer handlers keep the hover
  // alive through the slide. ±8 cancels the pt-2/pb-2 pad → pill flush at the very edge.
  const peekRestY = state.position === "bottom" ? 8 : -8;
  const slideY = peeked ? tuckY : peekRestoring ? peekRestY : restY;

  return (
    <MotionConfig reducedMotion="user">
      <div
        className={cn(
          "flex h-screen w-screen justify-center",
          state.position === "bottom" ? "items-end pb-2" : "items-start pt-2",
        )}
      >
        <motion.div
          ref={chipRef}
          onPointerEnter={onPointerEnter}
          onPointerLeave={onPointerLeave}
          style={{ borderRadius: 9999 }}
          // Vertical slide for the edge-peek (translateY — NOT scale, so the mono text never
          // re-rasterizes). reducedMotion="user" turns this into an instant set. Full opacity
          // when tucked so the lone half-dot stays crisp at the border.
          animate={{ opacity: peeked ? 1 : dimmed ? 0.4 : 1, y: slideY }}
          transition={{ opacity: { duration: 0.7 }, y: { duration: 0.5, ease: [0.4, 0, 0.2, 1] } }}
          // Width-driven morph — NOT Motion `layout`/FLIP. Children animate their WIDTH
          // (0 ↔ auto) and the content-sized pill reflows around them. Reflow is crisp:
          // no transform-scale (which re-rasterized/shimmered the small mono text), no
          // layout projection (which dropped the tag for a few frames on expand), and
          // no GPU layer (whose churn flickered after a few hovers). The pill stays
          // centred via the parent's justify-center, so the dot/tag translate (never
          // scale) as it grows.
          className={cn(
            "inline-flex h-[42px] items-center overflow-hidden border px-3.5 transition-colors duration-300",
            // Tucked: drop the pill chrome so ONLY the bare dot peeks below the border.
            peeked
              ? "border-transparent bg-transparent shadow-none"
              : "border-line bg-panel/95 shadow-[0_10px_40px_-8px_rgba(0,0,0,0.55)]",
          )}
        >
          {/* The persistent status dot — the seed the pill grows out of. A one-shot ✓
              replaces it the instant a session completes (a single play, not a loop). */}
          {justDone && !peeked ? (
            <motion.span
              key="done"
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={MORPH}
              className="flex shrink-0 text-live"
            >
              <Check className="size-4" strokeWidth={3} />
            </motion.span>
          ) : (
            <span
              style={{ boxShadow: dotGlow }}
              className={cn(
                "size-2.5 shrink-0 rounded-full transition-colors duration-300",
                dotColorClass,
                // Gentle breathing while a calm chip rests, AND while tucked-and-speaking (the
                // only liveness cue a minimized dot has). Finalizing pulses via chip-think below.
                ((!expanded && !standby && !showQuickLaunch && !peeked) || (peeked && speaking)) &&
                  "animate-chip-breathe",
                processing && "animate-chip-think",
              )}
            />
          )}

          {/* Identity row: the active-Profile tag (hover ≥1s reveals "· language · mode", which
              animates its WIDTH open so the text never scales) and/or the P16/D injection-target
              readout ("→ App", warn-tinted with a reason when coerced to the clipboard). */}
          {(state.profileTag || showTarget) && !peeked && (
            <div className="ml-2 flex shrink-0 items-center gap-2 font-mono text-[11px] leading-none tracking-[0.12em]">
              {state.profileTag && (
                <div className="flex items-center">
                  <span className="max-w-[140px] truncate uppercase text-accent/85">{state.profileTag}</span>
                  <AnimatePresence>
                    {hoverReveal && detail && (
                      <motion.span
                        key="detail"
                        initial={{ width: 0, opacity: 0 }}
                        animate={{ width: "auto", opacity: 1 }}
                        exit={{ width: 0, opacity: 0 }}
                        transition={MORPH}
                        onAnimationComplete={reportBounds}
                        className="inline-block overflow-hidden align-middle"
                      >
                        <span className="whitespace-nowrap pl-1.5 normal-case text-faint">· {detail}</span>
                      </motion.span>
                    )}
                  </AnimatePresence>
                </div>
              )}
              {showTarget && (
                <span
                  className={cn(
                    "flex items-center gap-1 normal-case",
                    targetWarn ? "text-warn" : "text-dim",
                  )}
                >
                  <span aria-hidden>→</span>
                  <span className="max-w-[130px] truncate">{state.targetTitle}</span>
                  {targetWarn && <span className="whitespace-nowrap">· {skipLabel}</span>}
                </span>
              )}
            </div>
          )}

          {/* Body (waveform + transcript) reveals by animating its WIDTH 0 → auto,
              clipping a natural-width (w-max) inner row so the content is revealed —
              never squished or scaled. Clean grow AND shrink, no empty-pill frame. */}
          <AnimatePresence onExitComplete={reportBounds}>
            {(expanded || showQuickLaunch) && !peeked && (
              <motion.div
                key="body"
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: "auto", opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                transition={MORPH}
                onAnimationComplete={reportBounds}
                className="overflow-hidden"
              >
                <div className="flex w-max items-center gap-3 pl-3">
                  {(state.profileTag || showTarget) && <span className="h-4 w-px shrink-0 bg-line" aria-hidden />}
                  {showQuickLaunch ? (
                    <div className="flex items-center gap-2">
                      {state.quickLaunch.map((e) => {
                        const { label, icon: Icon } = quickLaunchMeta(e);
                        return (
                          <button
                            key={e.id}
                            type="button"
                            title={label}
                            aria-label={label}
                            onClick={() => runQuickLaunch(e)}
                            className="ring-signal grid size-8 shrink-0 place-items-center rounded-lg text-faint transition-colors hover:bg-surface-2 hover:text-text"
                          >
                            <Icon className="size-4" />
                          </button>
                        );
                      })}
                    </div>
                  ) : state.status === "error" ? (
                    <div className="max-w-[520px] truncate font-mono text-[12.5px] text-rec">
                      <span aria-hidden className="mr-1.5">
                        ⚠
                      </span>
                      {state.dictationError || "error"}
                    </div>
                  ) : (
                    <>
                      <Waveform
                        level={state.level}
                        active={speaking}
                        processing={processing}
                        bars={11}
                        variant="bars"
                        tone={barTone}
                        className="h-6 w-[92px] shrink-0"
                      />
                      <div className="min-w-0 max-w-[470px]">
                        {state.partial ? (
                          // Left-edge fade via a STATIC overlay rather than a CSS mask:
                          // the transcript text/scroll changes several times a second,
                          // and re-evaluating a mask-image each time flickers on
                          // WebKitGTK. The overlay never repaints with the text.
                          <div className="relative">
                            <div
                              ref={textRef}
                              dir="auto"
                              className={cn(
                                "overflow-hidden whitespace-nowrap font-mono text-[12.5px]",
                                // While finishing, the text is captured (not live) — dim it.
                                processing ? "text-dim" : "text-text",
                              )}
                            >
                              {state.partial}
                            </div>
                            {faded && (
                              <div
                                aria-hidden
                                className="pointer-events-none absolute inset-y-0 left-0 w-7 bg-gradient-to-r from-panel to-panel/0"
                              />
                            )}
                          </div>
                        ) : (
                          <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-dim">
                            {label}
                          </div>
                        )}
                      </div>
                      {/* Cancel the in-flight finalize/insert. The chip can't call
                          cancelLive() directly (separate window), so route it through the
                          main window via an action event. */}
                      {processing && (
                        <button
                          type="button"
                          title="Cancel"
                          aria-label="Cancel dictation"
                          onClick={() => {
                            cancelling.current = true;
                            void emitOverlayAction("cancel-dictation");
                          }}
                          className="ring-signal grid size-8 shrink-0 place-items-center rounded-full text-faint transition-colors hover:text-text"
                        >
                          <X className="size-4" />
                        </button>
                      )}
                    </>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </div>
    </MotionConfig>
  );
}
