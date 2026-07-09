import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import { PRIDE_RAINBOW_STOPS } from "@/lib/prideFlag";

/**
 * The signature motif — a live level meter rendered on canvas. Used both as the
 * dictation chip's voice indicator and as ambient instrument readouts across the
 * app. Reacts to `level` (0..1 RMS); idles with a gentle breathing baseline.
 *
 * `pride`: a quiet solidarity touch — while the meter is ACTIVE (dictating) and you
 * HOVER it, the bars flicker between their normal colour and the rainbow Pride flag,
 * settling on it; they fade back when you leave or the session ends. No effect at idle.
 * Off by default; honours prefers-reduced-motion (no flicker).
 */

// Flicker envelope (fraction-of-duration → flag opacity). Dips toward the normal colour,
// spikes toward the flag, then settles fully on the flag — a tube-warming-up flicker.
const FLICKER_MS = 700;
const FLK: [number, number][] = [
  [0, 0.12], [0.08, 0.85], [0.11, 0.12], [0.19, 0.95], [0.22, 0.25],
  [0.31, 1], [0.35, 0.4], [0.42, 1], [0.49, 0.6], [0.57, 1], [1, 1],
];
function flicker(elapsedMs: number): number {
  const f = Math.min(1, elapsedMs / FLICKER_MS);
  for (let i = 1; i < FLK.length; i++) {
    if (f <= FLK[i][0]) {
      const [t0, o0] = FLK[i - 1];
      const [t1, o1] = FLK[i];
      const k = t1 === t0 ? 1 : (f - t0) / (t1 - t0);
      return o0 + (o1 - o0) * k;
    }
  }
  return 1;
}

// A vertical 6-stripe rainbow gradient (hard bands) spanning the meter height. The plain
// Pride flag is uniform horizontally, so one gradient fills every bar identically — no
// tiling, no stretched chevron. Each bar is a centred window into it: taller spikes reveal
// more of the flag (toward red at the top, violet at the bottom).
function buildRainbow(ctx: CanvasRenderingContext2D, h: number): CanvasGradient {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  const n = PRIDE_RAINBOW_STOPS.length;
  PRIDE_RAINBOW_STOPS.forEach((c, i) => {
    g.addColorStop(i / n, c);
    g.addColorStop((i + 1) / n, c);
  });
  return g;
}

export function Waveform({
  level,
  active,
  processing = false,
  bars = 5,
  variant = "bars",
  tone = "accent",
  pride = false,
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
  tone?: "accent" | "rec" | "dim" | "live" | "think";
  /** Reveal the Pride flag through the bars while hovered (see component note). */
  pride?: boolean;
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
  // Pride hover-reveal state (all refs so the draw loop reads them without re-subscribing).
  const prideOnRef = useRef(pride);
  prideOnRef.current = pride;
  // `tone === "live"` is the green/speaking state — the only time the flag reveals.
  const toneRef = useRef(tone);
  toneRef.current = tone;
  const hoverRef = useRef(false);
  const hoverStartRef = useRef(0);

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
    // Pride rainbow gradient (rebuilt on size change) + current flag-mix (0..1).
    let prideGrad: CanvasGradient | null = null;
    let prideGradH = 0;
    let prideMix = 0;
    let prevEligible = false;

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

      // Pride flag-mix: only while the meter is GREEN (actively speaking) — never at idle
      // or while armed-but-silent. While hovered, flicker between the normal colour and the
      // rainbow, settling on it; fade back out on leave or when you stop speaking.
      const prideEligible = prideOnRef.current && toneRef.current === "live";
      // Becoming active while already hovering should still play the flicker from the top.
      if (prideEligible && !prevEligible && hoverRef.current) hoverStartRef.current = performance.now();
      prevEligible = prideEligible;
      let prideAnimating = false;
      if (prideEligible && hoverRef.current) {
        const el = performance.now() - hoverStartRef.current;
        prideMix = reduce ? 1 : flicker(el);
        prideAnimating = !reduce && el < FLICKER_MS;
      } else {
        prideMix = reduce ? 0 : prideMix * 0.7; // quick fade back to the normal colour
        if (prideMix < 0.01) prideMix = 0;
        prideAnimating = prideMix > 0;
      }
      if (prideMix > 0 && (!prideGrad || prideGradH !== h)) {
        prideGrad = buildRainbow(ctx, h);
        prideGradH = h;
      }
      const flag = prideMix > 0 ? prideGrad : null;

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
        const baseAlpha = isActive ? 1 : isProcessing ? 0.92 : 0.55;
        // Build the bar shape, then fill it with the normal colour and (cross-faded by
        // prideMix) the flag pattern. The pattern is anchored to the canvas origin, so
        // each bar reveals the flag column at its x — together rebuilding the flag.
        if (variant === "dots") {
          const r = bw / 2 + heights[i] * (h * 0.16);
          ctx.beginPath();
          ctx.arc(x, h / 2, r, 0, Math.PI * 2);
        } else {
          const bh = Math.max(bw, heights[i] * h * 0.92);
          rr(x - bw / 2, (h - bh) / 2, bw, bh, bw / 2);
        }
        ctx.globalAlpha = baseAlpha * (1 - prideMix);
        ctx.fillStyle = color;
        ctx.fill();
        if (flag) {
          ctx.globalAlpha = baseAlpha * prideMix;
          ctx.fillStyle = flag;
          ctx.fill();
        }
      }
      // Keep animating only while there's something to animate — a live level meter,
      // the processing sweep, or a Pride flicker/fade in progress. Once idle and visually
      // settled, park the loop: a static silhouette costs the renderer nothing, and leaving
      // a canvas repainting every frame for hours is exactly what bloated WebKitGTK.
      const needsAnimation = (!reduce && (isActive || isProcessing)) || prideAnimating;
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
    // The loop self-parks when idle and only re-reads the canvas size inside draw, so a resize
    // while parked would leave a stale (blurry/clipped) backing store until an unrelated re-kick.
    // Re-kick on any size change so draw re-syncs the backing store, then it re-parks.
    const ro = new ResizeObserver(() => kick());
    ro.observe(canvas);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
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
      onMouseEnter={
        pride
          ? () => {
              hoverRef.current = true;
              hoverStartRef.current = performance.now();
              // Only wake the loop when it would actually reveal (green). At idle the loop
              // stays parked, so hovering causes no redraw at all.
              if (toneRef.current === "live") kickRef.current();
            }
          : undefined
      }
      onMouseLeave={
        pride
          ? () => {
              hoverRef.current = false;
              if (toneRef.current === "live") kickRef.current();
            }
          : undefined
      }
      className={cn(
        tone === "rec"
          ? "text-rec"
          : tone === "live"
            ? "text-live"
            : tone === "think"
              ? "text-think"
              : tone === "dim"
                ? "text-faint"
                : "text-accent",
        className,
      )}
    />
  );
}
