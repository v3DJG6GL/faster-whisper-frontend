import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";

/**
 * The signature motif — a live level meter rendered on canvas. Used both as the
 * dictation chip's voice indicator and as ambient instrument readouts across the
 * app. Reacts to `level` (0..1 RMS); idles with a gentle breathing baseline.
 */
export function Waveform({
  level,
  active,
  bars = 5,
  variant = "bars",
  tone = "accent",
  className,
}: {
  level: number;
  active: boolean;
  bars?: number;
  variant?: "bars" | "dots";
  tone?: "accent" | "rec" | "dim" | "live";
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const levelRef = useRef(level);
  const activeRef = useRef(active);
  levelRef.current = level;
  activeRef.current = active;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Under "reduce motion", freeze to a static silhouette (no wobble, no
    // amplitude reaction) — the loop keeps running only so tone/active changes
    // still repaint, but every frame is identical, so there's no perceived motion.
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    const heights = new Array(bars).fill(0.16);
    const phases = heights.map((_, i) => (i / bars) * Math.PI * 2 + Math.random());
    let t = 0;
    let color = "#ff9e2c";
    let colorTick = 0;
    let raf = 0;

    const rr = (x: number, y: number, w: number, h: number, r: number) => {
      const rad = Math.min(r, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + rad, y);
      ctx.arcTo(x + w, y, x + w, y + h, rad);
      ctx.arcTo(x + w, y + h, x, y + h, rad);
      ctx.arcTo(x, y + h, x, y, rad);
      ctx.arcTo(x, y, x + w, y, rad);
      ctx.closePath();
    };

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) {
        raf = requestAnimationFrame(draw);
        return;
      }
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      if (colorTick % 30 === 0) color = getComputedStyle(canvas).color || color;
      colorTick++;
      ctx.fillStyle = color;

      const isActive = activeRef.current;
      // Perceptual curve: loudness ≈ amplitude^0.7, so quiet speech still moves it.
      const lvl = Math.pow(Math.max(0, Math.min(1, levelRef.current)), 0.7);
      const mid = (bars - 1) / 2;
      if (!reduce) t += isActive ? 0.16 : 0.05;
      const slot = w / bars;
      const bw = variant === "dots" ? Math.min(slot * 0.4, h * 0.22) : Math.max(2.5, slot * 0.42);

      for (let i = 0; i < bars; i++) {
        // Center-boost: middle bars run taller → the classic VU-meter "smile".
        const edge = mid === 0 ? 0 : Math.abs(i - mid) / mid; // 0 centre … 1 edge
        const cb = 1 - 0.35 * edge;
        const wobble = Math.sin(t + phases[i]) * 0.5 + 0.5;
        let target: number;
        if (reduce) {
          target = (0.18 + 0.3 * (1 - edge)) * (isActive ? 1 : 0.85);
        } else if (isActive) {
          target = Math.max(0.14, Math.min(1, lvl * (0.55 + 0.9 * wobble) * cb));
        } else {
          target = (0.12 + 0.05 * wobble) * cb;
        }
        heights[i] += reduce ? target - heights[i] : (target - heights[i]) * 0.25;
        const x = (i + 0.5) * slot;
        ctx.globalAlpha = isActive ? 1 : 0.55;
        if (variant === "dots") {
          const r = bw / 2 + heights[i] * (h * 0.16);
          ctx.beginPath();
          ctx.arc(x, h / 2, r, 0, Math.PI * 2);
          ctx.fill();
        } else {
          const bh = Math.max(bw, heights[i] * h * 0.92);
          rr(x - bw / 2, (h - bh) / 2, bw, bh, bw / 2);
          ctx.fill();
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [bars, variant]);

  return (
    <canvas
      ref={ref}
      aria-hidden
      className={cn(
        tone === "rec"
          ? "text-rec"
          : tone === "live"
            ? "text-live"
            : tone === "dim"
              ? "text-faint"
              : "text-accent",
        className,
      )}
    />
  );
}
