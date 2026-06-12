import { useEffect, useRef, useState } from "react";
import { Waveform } from "@/components/Waveform";
import type { DictationStatus } from "@/lib/types";

interface ChipState {
  status: DictationStatus;
  level: number;
  partial: string;
}

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * The dictation chip — a frameless, transparent, always-on-top window painted by
 * Rust at the top-center of the screen. The Rust core emits `dictation://update`
 * events (status, audio level, live partial); outside Tauri we self-animate a
 * demo so the chip can be previewed standalone.
 */
export default function Overlay() {
  const [state, setState] = useState<ChipState>({ status: "listening", level: 0.2, partial: "" });

  // Live updates from the Rust core when running under Tauri.
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<ChipState>("dictation://update", (e) => setState(e.payload)),
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
      setState({ status: "listening", level, partial: sample.slice(0, chars) });
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, []);

  const recording = state.status === "listening";
  const label =
    state.status === "transcribing"
      ? "transcribing…"
      : state.status === "injecting"
        ? "inserting…"
        : state.status === "error"
          ? "error"
          : "listening";

  return (
    <div className="flex h-screen w-screen items-start justify-center pt-2">
      <div className="animate-chip-in flex w-full max-w-[440px] flex-col items-center gap-2">
        {/* The pill */}
        <div className="flex h-[52px] items-center gap-3 rounded-pill border border-white/10 bg-[#16140f]/95 pl-4 pr-5 shadow-[0_10px_40px_-8px_rgba(0,0,0,0.7)] backdrop-blur-xl">
          <span
            className={
              "size-2.5 shrink-0 rounded-full " +
              (state.status === "error" ? "bg-rec" : recording ? "bg-rec animate-rec-pulse" : "bg-accent")
            }
          />
          <Waveform
            level={state.level}
            active={recording}
            bars={7}
            variant="dots"
            tone={recording ? "rec" : "accent"}
            className="h-6 w-[88px]"
          />
          <div className="min-w-0 max-w-[260px]">
            {state.partial ? (
              <div className="truncate font-mono text-[12.5px] text-[#f3eee6]" dir="auto">
                {state.partial}
              </div>
            ) : (
              <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-[#a89f93]">
                {label}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
