import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence, MotionConfig } from "motion/react";
import { Waveform } from "@/components/Waveform";
import { setChipHitRegion } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { DictationStatus, ThemeName } from "@/lib/types";

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
}

// Hold a hover this long before the chip reveals the language/mode detail line.
const HOVER_REVEAL_MS = 1000;

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Speaking detector (silence ⇄ speech) over the smoothed RMS level. Hysteresis +
// an asymmetric hold: expand fast when you start talking, collapse only after a
// short silence, so natural pauses between words don't make the chip flicker.
// Thresholds are the first thing to tune if it feels too eager/sluggish.
const SPEAK_HIGH = 0.08; // enter "speaking" above this (smoothed)
const SPEAK_LOW = 0.04; // candidate for "silent" below this …
const SILENCE_HOLD_MS = 900; // … but only after staying low this long

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
  });

  // Live updates from the Rust core when running under Tauri.
  useEffect(() => {
    if (!isTauri) return;
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
          });
        }),
      )
      .then((un) => {
        unlisten = un;
      })
      .catch(() => {});
    return () => unlisten?.();
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
      setState({ status: "listening", level, partial: sample.slice(0, chars), dictationError: "", position: "top", theme: "dark", profileTag: "SWISS-DE", language: "de-CH", mode: "stream" });
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, []);

  // Derive speaking vs silent from the level stream (only while listening).
  const [speaking, setSpeaking] = useState(false);
  const smooth = useRef(0);
  const belowSince = useRef<number | null>(null);
  useEffect(() => {
    if (state.status !== "listening") {
      smooth.current = 0;
      belowSince.current = null;
      if (speaking) setSpeaking(false);
      return;
    }
    smooth.current = smooth.current * 0.8 + state.level * 0.2;
    const s = smooth.current;
    const now = performance.now();
    if (s > SPEAK_HIGH) {
      belowSince.current = null;
      if (!speaking) setSpeaking(true);
    } else if (s < SPEAK_LOW) {
      if (belowSince.current == null) belowSince.current = now;
      if (speaking && now - belowSince.current >= SILENCE_HOLD_MS) setSpeaking(false);
    } else {
      belowSince.current = null; // between thresholds → hold current state
    }
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
  const onPointerEnter = () => {
    setHovering(true);
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setHoverReveal(true), HOVER_REVEAL_MS);
  };
  const onPointerLeave = () => {
    setHovering(false);
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setHoverReveal(false);
  };
  const detail = [state.language, state.mode].filter(Boolean).join(" · ");

  // Report the chip's on-screen bounds to Rust, which shapes the overlay window's
  // input region to just that rectangle — so only the chip captures the cursor and
  // the rest of the transparent strip stays click-through. Measured in CSS px from
  // the window's top-left (= the webview viewport), which maps to GDK's logical
  // coordinate space. No-op outside Tauri.
  const chipRef = useRef<HTMLDivElement>(null);
  const reportBounds = useCallback(() => {
    const el = chipRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) void setChipHitRegion(r.x, r.y, r.width, r.height);
  }, []);
  // Report bounds ONLY at settled moments — never mid-morph. A region that resizes
  // out from under the cursor causes hover enter/leave thrash (chip flickering
  // open/closed, "stuck" open, needing a click to wake). So updates come only from
  // the width animations settling (`onAnimationComplete`/`onExitComplete` below) plus
  // a few retries when a session starts or the chip moves (the overlay window
  // realizes its GdkWindow asynchronously on show).
  useEffect(() => {
    if (state.status === "idle") return;
    const ids = [0, 160, 420, 850].map((ms) => setTimeout(reportBounds, ms));
    return () => ids.forEach(clearTimeout);
  }, [reportBounds, state.status, state.position]);

  // After sitting armed-but-silent for a while, fade the chip down so it's
  // unobtrusive; any speech / state change snaps it back to full opacity.
  const [dimmed, setDimmed] = useState(false);
  useEffect(() => {
    setDimmed(false);
    // Don't fade while the cursor is on the chip — hovering should keep it fully
    // legible (and the reveal detail un-dimmed).
    if (expanded || hovering || state.status !== "listening") return;
    const t = setTimeout(() => setDimmed(true), 10000);
    return () => clearTimeout(t);
  }, [expanded, hovering, state.status]);

  // Keep the newest words in view: pin the preview to its right edge.
  const textRef = useRef<HTMLDivElement>(null);
  const [faded, setFaded] = useState(false);
  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.scrollLeft = el.scrollWidth;
    setFaded(el.scrollWidth - el.clientWidth > 2);
  }, [state.partial, expanded]);

  const label =
    state.status === "transcribing"
      ? "transcribing…"
      : state.status === "injecting"
        ? "inserting…"
        : "listening";

  // Status dot color (NEVER red while listening) via theme tokens + a soft glow.
  const dotColorClass =
    state.status === "error" ? "bg-rec" : speaking ? "bg-live" : "bg-accent";
  const dotGlow =
    state.status === "error"
      ? "0 0 10px rgba(255,92,70,0.5)"
      : speaking
        ? "0 0 12px rgba(54,208,122,0.5)"
        : !expanded
          ? "0 0 12px rgba(255,158,44,0.55)" // calm breathing ember
          : "0 0 8px rgba(255,158,44,0.4)";
  const barTone = speaking ? "live" : "accent";

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
          animate={{ opacity: dimmed ? 0.4 : 1 }}
          transition={{ opacity: { duration: 0.7 } }}
          // Width-driven morph — NOT Motion `layout`/FLIP. Children animate their WIDTH
          // (0 ↔ auto) and the content-sized pill reflows around them. Reflow is crisp:
          // no transform-scale (which re-rasterized/shimmered the small mono text), no
          // layout projection (which dropped the tag for a few frames on expand), and
          // no GPU layer (whose churn flickered after a few hovers). The pill stays
          // centred via the parent's justify-center, so the dot/tag translate (never
          // scale) as it grows.
          className="inline-flex h-[42px] items-center overflow-hidden border border-line bg-panel/95 px-3.5 shadow-[0_10px_40px_-8px_rgba(0,0,0,0.55)]"
        >
          {/* The persistent status dot — the seed the pill grows out of. */}
          <span
            style={{ boxShadow: dotGlow }}
            className={cn(
              "size-2.5 shrink-0 rounded-full transition-colors duration-300",
              dotColorClass,
              !expanded && "animate-chip-breathe",
              state.status === "transcribing" && "animate-chip-think",
            )}
          />

          {/* Persistent active-Profile tag; hover (≥1s) reveals "· language · mode",
              which animates its WIDTH open (clipped) so the text never scales. */}
          {state.profileTag && (
            <div className="ml-2 flex shrink-0 items-center font-mono text-[11px] leading-none tracking-[0.12em]">
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

          {/* Body (waveform + transcript) reveals by animating its WIDTH 0 → auto,
              clipping a natural-width (w-max) inner row so the content is revealed —
              never squished or scaled. Clean grow AND shrink, no empty-pill frame. */}
          <AnimatePresence onExitComplete={reportBounds}>
            {expanded && (
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
                  {state.profileTag && <span className="h-4 w-px shrink-0 bg-line" aria-hidden />}
                  {state.status === "error" ? (
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
                              className="overflow-hidden whitespace-nowrap font-mono text-[12.5px] text-text"
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
