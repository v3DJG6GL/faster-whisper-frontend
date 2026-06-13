import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence, MotionConfig } from "motion/react";
import { Waveform } from "@/components/Waveform";
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

// The chip morph: one element fluidly grows from a calm dot into the full pill
// (Motion `layout` → FLIP/transform, smooth on WebKit). Spring tuned snappy-but-
// settled (Apple-fluid). We deliberately DON'T use backdrop-blur — on WebKitGTK
// over a transparent window it re-blurs every frame during the resize (jitter)
// and barely shows behind a ~96% opaque fill anyway.
const MORPH = { type: "spring", stiffness: 380, damping: 30, mass: 0.8 } as const;

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
  const expanded =
    state.status === "transcribing" ||
    state.status === "injecting" ||
    state.status === "error" ||
    (state.status === "listening" && speaking);

  // Hover-to-reveal: holding the cursor over the chip for ≥1s expands it to show
  // the language + stream/batch detail beside the tag. (Under Tauri this only fires
  // once the chip's input region is shaped — see overlay.rs / setChipHitRegion;
  // in the browser preview there's no click-through, so it works directly.)
  const [hoverReveal, setHoverReveal] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onPointerEnter = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setHoverReveal(true), HOVER_REVEAL_MS);
  };
  const onPointerLeave = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setHoverReveal(false);
  };
  const detail = [state.language, state.mode].filter(Boolean).join(" · ");

  // After sitting armed-but-silent for a while, fade the chip down so it's
  // unobtrusive; any speech / state change snaps it back to full opacity.
  const [dimmed, setDimmed] = useState(false);
  useEffect(() => {
    setDimmed(false);
    if (expanded || state.status !== "listening") return;
    const t = setTimeout(() => setDimmed(true), 10000);
    return () => clearTimeout(t);
  }, [expanded, state.status]);

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
          layout
          layoutDependency={`${expanded}|${hoverReveal}|${state.profileTag ?? ""}`}
          onPointerEnter={onPointerEnter}
          onPointerLeave={onPointerLeave}
          style={{ borderRadius: 9999 }}
          animate={{ opacity: dimmed ? 0.4 : 1 }}
          transition={{ layout: MORPH, opacity: { duration: 0.7 } }}
          className={cn(
            // The chip shell is kept in BOTH states (a small dark pill when armed,
            // widening when you speak). Constant height so the dot's vertical centre
            // never shifts — only the width morphs (the chip grows out of the dot).
            "flex h-[46px] items-center overflow-hidden border border-line bg-panel/95 shadow-[0_10px_40px_-8px_rgba(0,0,0,0.55)]",
            expanded ? "px-5" : "px-[17px]",
            state.profileTag ? "gap-2.5" : expanded ? "gap-3" : "",
          )}
        >
          {/* The persistent status dot — the seed the pill grows out of. */}
          <motion.span
            layout
            layoutDependency={expanded}
            style={{ boxShadow: dotGlow }}
            className={cn(
              "size-3 shrink-0 rounded-full transition-colors duration-300",
              dotColorClass,
              !expanded && "animate-chip-breathe",
              state.status === "transcribing" && "animate-chip-think",
            )}
          />

          {/* Persistent active-Profile tag; hover (≥1s) reveals language · mode. */}
          {state.profileTag && (
            <motion.div
              layout
              className="flex shrink-0 items-center font-mono text-[11px] leading-none tracking-[0.12em]"
            >
              <span className="max-w-[140px] truncate uppercase text-accent/85">{state.profileTag}</span>
              {hoverReveal && detail && (
                <span className="ml-1.5 whitespace-nowrap normal-case text-faint">· {detail}</span>
              )}
            </motion.div>
          )}

          <AnimatePresence initial={false}>
            {expanded && (
              <motion.div
                key="body"
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -6 }}
                transition={{ duration: 0.2, delay: 0.05 }}
                className="flex items-center gap-3"
              >
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
                      className="h-6 w-[92px]"
                    />
                    <div className="min-w-0 max-w-[470px]">
                      {state.partial ? (
                        <div
                          ref={textRef}
                          dir="auto"
                          className="overflow-hidden whitespace-nowrap font-mono text-[12.5px] text-text"
                          style={
                            faded
                              ? {
                                  maskImage: "linear-gradient(to right, transparent, #000 28px)",
                                  WebkitMaskImage: "linear-gradient(to right, transparent, #000 28px)",
                                }
                              : undefined
                          }
                        >
                          {state.partial}
                        </div>
                      ) : (
                        <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-dim">
                          {label}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </div>
    </MotionConfig>
  );
}
