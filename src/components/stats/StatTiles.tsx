import { cn } from "@/lib/cn";
import { fmtFull } from "@/lib/format";
import { KIND_LABEL, KIND_VAR } from "@/lib/usageDerive";
import { linePath } from "@/components/stats/chartKit";
import { Swatch } from "@/components/stats/primitives";
import { type TileSpec } from "@/components/stats/tileSpecs";

function Sparkline({ vals, color }: { vals: number[]; color: string }) {
  const W = 132;
  const H = 30;
  const { d, area, X, Y, n } = linePath(vals, W, H, { l: 1, r: 1, t: 4, b: 2 }, Math.max(1, ...vals));
  if (!n) return null;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mt-2.5 h-[30px] w-full" aria-hidden="true">
      <path d={area} fill={color} opacity={0.12} />
      <path d={d} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={X(n - 1)} cy={Y(vals[n - 1])} r={2} fill={color} />
    </svg>
  );
}

// "dict" is the Words tile: a figure about you, not about the Dictation kind, so it wears the
// Signal colour like the chip's readout (D27). Kind series keep --c-chart-* (kindFill).
const TONE: Record<TileSpec["tone"], string> = { dict: "text-accent", ok: "text-ok", warn: "text-warn" };

/** A ledger figure's size: 22 px up to eight characters ("1h 04m", "51,239"), one step
 *  down for longer ones ("1,234,567") so they fit the row instead of truncating. */
const figureSize = (v: string) => (v.length > 8 ? "text-[18px]" : "text-[22px]");

/** A stat tile. With `onPick` it is a button that sets the page's measure; the active one
 *  wears the accent border and says "shown" (D35 A). */
export function StatTile({ tile, spark, active, onPick }: { tile: TileSpec; spark: boolean; active?: boolean; onPick?: () => void }) {
  const Icon = tile.icon;
  const body = (
    <>
      <div className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-label text-faint">
        <Icon className="size-3.5 shrink-0 opacity-80" />
        <span className="truncate">{tile.label}</span>
        {active && <span className="ml-auto shrink-0 text-[9.5px] text-accent">shown</span>}
      </div>
      {/* The ledger (D53 C): label / value rows at one size, right-aligned so the figures
          line up across tiles; per day is the quiet third row. The sparkline is pinned to
          the bottom so a tile with a legend does not push its neighbours' lines around. */}
      <div className="mt-3 grid grid-cols-[auto_1fr] items-baseline gap-x-3.5 gap-y-1.5">
        <span className="font-mono text-[10px] uppercase tracking-label text-faint">today</span>
        <span className={cn("truncate text-right font-num font-semibold leading-none", figureSize(tile.today), TONE[tile.tone])}>{tile.today}</span>
        <span className="font-mono text-[10px] uppercase tracking-label text-faint">{tile.rangeLabel}</span>
        <span className={cn("truncate text-right font-num font-semibold leading-none", figureSize(tile.range), TONE[tile.tone])}>{tile.range}</span>
        <span className="font-mono text-[10px] uppercase tracking-label text-faint">per day</span>
        <span className="truncate text-right font-num text-[12px] text-text">{tile.perDay}</span>
      </div>
      {tile.split && tile.split.length > 0 && (
        <>
          <div className="mt-2.5 flex h-[5px] overflow-hidden rounded-[3px] bg-surface-2" aria-hidden>
            {tile.split.map((r) => (
              <i key={r.kind} className="block h-full" style={{ width: `${(r.value / tile.split!.reduce((a, x) => a + x.value, 0)) * 100}%`, background: KIND_VAR[r.kind] }} />
            ))}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-2.5 gap-y-0.5 font-mono text-[11px] text-dim">
            {tile.split.map((r) => (
              <span key={r.kind} className="inline-flex items-center gap-1.5"><Swatch kind={r.kind} />{fmtFull(r.value)} {KIND_LABEL[r.kind].toLowerCase()}</span>
            ))}
          </div>
        </>
      )}
      {tile.note && <div className="mt-2 text-[12px] text-dim">{tile.note}</div>}
      {spark && <div className="mt-auto pt-2"><Sparkline vals={tile.spark} color={tile.sparkColor} /></div>}
    </>
  );
  const base = "relative flex min-w-0 flex-col rounded-card border bg-surface/80 p-4 text-left backdrop-blur-sm";
  if (onPick) {
    return (
      <button
        type="button"
        onClick={onPick}
        aria-pressed={!!active}
        title={active ? `Every chart measures ${tile.label}` : `Measure ${tile.label} on every chart`}
        className={cn(base, "ring-signal w-full transition-colors", active ? "border-accent" : "border-line hover:border-line-strong")}
      >
        {body}
      </button>
    );
  }
  return <div className={cn(base, "border-line", tile.wide && "col-span-2")}>{body}</div>;
}
