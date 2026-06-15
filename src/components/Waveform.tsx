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
  processing = false,
  bars = 5,
  variant = "bars",
  tone = "accent",
  className,
}: {
  level: number;
  active: boolean;
  /** Indeterminate "working" motion (a soft bump sweeping across the bars), driven by
   *  the clock rather than `level`. For the post-speech transcribing / writing-out
   *  phase, where there's no audio to react to but the system is still busy. */
  processing?: boolean;
  bars?: number;
  variant?: "bars" | "dots";
  tone?: "accent" | "rec" | "dim" | "live";
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const levelRef = useRef(level);
  const activeRef = useRef(active);
  const processingRef = useRef(processing);
  levelRef.current = level;
  activeRef.current = active;
  processingRef.current = processing;
  // Re-arms the draw loop after it has parked itself (idle + settled). Set by the
  // setup effect; called from the [active, processing] and [tone] effects below.
  const kickRef = useRef<() => void>(() => {});
  // Recompute the resolved CSS color on the next frame (set when `tone` changes),
  // instead of polling getComputedStyle on a timer for the whole session.
  const colorDirtyRef = useRef(true);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Under "reduce motion", freeze to a static silhouette (no wobble, no amplitude
    // reaction). Combined with the idle-parking below, the loop settles in a frame
    // or two and then stops entirely — no perceived motion and no ongoing repaint.
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    const heights = new Array(bars).fill(0.16);
    const phases = heights.map((_, i) => (i / bars) * Math.PI * 2 + Math.random());
    let t = 0;
    let color = "#ff9e2c";
    let raf = 0;
    let running = false;

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

      if (colorDirtyRef.current) {
        color = getComputedStyle(canvas).color || color;
        colorDirtyRef.current = false;
      }
      ctx.fillStyle = color;

      const isActive = activeRef.current;
      const isProcessing = processingRef.current && !isActive;
      // Perceptual curve: loudness ≈ amplitude^0.7, so quiet speech still moves it.
      const lvl = Math.pow(Math.max(0, Math.min(1, levelRef.current)), 0.7);
      const mid = (bars - 1) / 2;
      if (!reduce) t += isProcessing ? 0.14 : isActive ? 0.16 : 0.05;
      const slot = w / bars;
      const bw = variant === "dots" ? Math.min(slot * 0.4, h * 0.22) : Math.max(2.5, slot * 0.42);

      // Processing: a soft Gaussian bump that scans left↔right across the bars. Self-
      // driven (ignores `level`), so it reads unmistakably as "machine working" — a
      // distinct gait from the audio-reactive listening bars.
      const span = bars + 2;
      const sweep = ((t * 1.0) % (span * 2));
      const center = (sweep < span ? sweep : span * 2 - sweep) - 1; // bounce -1 … bars

      let maxStep = 0; // largest bar movement this frame → lets the loop detect "settled"
      for (let i = 0; i < bars; i++) {
        // Center-boost: middle bars run taller → the classic VU-meter "smile".
        const edge = mid === 0 ? 0 : Math.abs(i - mid) / mid; // 0 centre … 1 edge
        const cb = 1 - 0.35 * edge;
        const wobble = Math.sin(t + phases[i]) * 0.5 + 0.5;
        let target: number;
        if (reduce) {
          target = isProcessing ? 0.4 : (0.18 + 0.3 * (1 - edge)) * (isActive ? 1 : 0.85);
        } else if (isProcessing) {
          const d = i - center;
          const bump = Math.exp(-(d * d) / (2 * 1.3 * 1.3));
          target = Math.max(0.16, Math.min(1, 0.2 + 0.72 * bump));
        } else if (isActive) {
          target = Math.max(0.14, Math.min(1, lvl * (0.55 + 0.9 * wobble) * cb));
        } else {
          // Static idle silhouette (no wobble) so the bars actually converge and the
          // loop can park itself, rather than breathing — i.e. repainting — forever.
          target = 0.14 * cb;
        }
        const delta = reduce ? target - heights[i] : (target - heights[i]) * 0.25;
        heights[i] += delta;
        if (Math.abs(delta) > maxStep) maxStep = Math.abs(delta);
        const x = (i + 0.5) * slot;
        ctx.globalAlpha = isActive ? 1 : isProcessing ? 0.92 : 0.55;
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
      // Keep animating only while there's something to animate — a live level meter
      // or the processing sweep. Once idle and visually settled, park the loop: a
      // static silhouette costs the renderer nothing, and leaving a canvas repainting
      // every frame for hours is exactly what bloated the shared WebKitGTK renderer.
      const needsAnimation = !reduce && (isActive || isProcessing);
      if (!needsAnimation && maxStep < 0.001) {
        running = false;
        raf = 0;
        return;
      }
      raf = requestAnimationFrame(draw);
    };
    const kick = () => {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(draw);
    };
    kickRef.current = kick;
    kick();
    return () => {
      running = false;
      cancelAnimationFrame(raf);
    };
  }, [bars, variant]);

  // Restart the (self-parking) loop whenever it has something to animate again, or
  // when the colour must be re-resolved after a tone change.
  useEffect(() => {
    kickRef.current();
  }, [active, processing]);
  useEffect(() => {
    colorDirtyRef.current = true;
    kickRef.current();
  }, [tone]);

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
