import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Segmented } from "@/components/ui";
import { cn } from "@/lib/cn";
import { fmtFull } from "@/lib/format";
import {
  CHART_METRICS, KINDS, METRIC_LABEL, RANGE_LABEL, RANGE_PRESETS, SCOPE_LABEL, STAGE_CHIP_LABEL, STAGE_KEYS,
  bucketMode, dayToIso, isFiltered, isoToDay, resolveWindow, spanPresets, MAX_SPAN_DAYS, type ChartMetric,
  type RangePreset, type UsagePageQuery, type UsageScope,
} from "@/lib/usageDerive";
import { useOutsidePress } from "@/lib/useOutsidePress";
import type { UsageStageKey } from "@/lib/types";
import { BUCKET_WORD, fmtDateRange } from "@/components/stats/chartKit";
import { Eyebrow, Pill } from "@/components/stats/primitives";

/* ── the filter bar ──────────────────────────────────────────────────────── */

const STAGE_DOT: Record<UsageStageKey, string> = {
  translating: "var(--c-translate)",
  diarizing: "var(--c-diarize)",
  separating: "var(--c-separate)",
  vad: "var(--c-think)",
};

function CustomSpanPopover({ from, to, today, onApply, onCancel }: { from: number; to: number; today: number; onApply: (from: number, to: number) => void; onCancel: () => void }) {
  const [f, setF] = useState(dayToIso(from));
  const [t, setT] = useState(dayToIso(to));
  const fd = isoToDay(f);
  const td = isoToDay(t);
  const ok = fd !== undefined && td !== undefined && fd <= td && td - fd < MAX_SPAN_DAYS;
  const days = ok ? td - fd + 1 : 0;
  const mode = ok ? bucketMode(days) : "day";
  return (
    <div className="mt-2.5 w-max max-w-full rounded-[12px] border border-line-strong bg-surface p-3.5 shadow-[0_16px_40px_-16px_rgba(0,0,0,0.9)]" role="dialog" aria-label="Custom range">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 font-mono text-[10.5px] uppercase tracking-label text-faint">
          From
          <input type="date" value={f} max={t} onChange={(e) => setF(e.target.value)} className="ring-signal rounded-[8px] border border-line-strong bg-panel px-2 py-1 font-mono text-[12.5px] normal-case tracking-normal text-text" />
        </label>
        <label className="flex flex-col gap-1 font-mono text-[10.5px] uppercase tracking-label text-faint">
          To
          <input type="date" value={t} min={f} onChange={(e) => setT(e.target.value)} className="ring-signal rounded-[8px] border border-line-strong bg-panel px-2 py-1 font-mono text-[12.5px] normal-case tracking-normal text-text" />
        </label>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {spanPresets(today).map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => {
              setF(dayToIso(p.from));
              setT(dayToIso(p.to));
            }}
            className="ring-signal rounded-pill border border-line-strong px-2.5 py-0.5 text-[12px] text-dim hover:text-text"
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="mt-2.5 flex items-center gap-2 text-[11.5px] text-faint">
        <span>{ok ? `${days} ${days === 1 ? "day" : "days"} · shown by ${BUCKET_WORD[mode]}` : "Pick a start on or before the end, at most 10 years apart."}</span>
        <span className="flex-1" />
        <button type="button" onClick={onCancel} className="ring-signal rounded-pill border border-line-strong px-3 py-1 text-[12px] text-dim hover:text-text">
          Cancel
        </button>
        <button
          type="button"
          disabled={!ok}
          onClick={() => ok && onApply(fd, td)}
          className="ring-signal rounded-pill bg-accent px-3 py-1 text-[12px] font-semibold text-accent-ink disabled:opacity-40"
        >
          Apply
        </button>
      </div>
    </div>
  );
}

/** True while the sentinel above the bar has scrolled out of the nearest scroll ancestor —
 *  i.e. the sticky bar is pinned. (`scroll-state()` container queries would do this in CSS,
 *  but WebKitGTK does not ship them.) */
function useStuck(): [RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    let root: HTMLElement | null = el.parentElement;
    while (root && !/(auto|scroll)/.test(getComputedStyle(root).overflowY)) root = root.parentElement;
    const io = new IntersectionObserver(([e]) => setStuck(!e.isIntersecting), { root, threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, stuck];
}

/** One value on the condensed rail: eyebrow + value, a button that reopens the full bar. */
function RailChip({ label, accent, onClick, children }: { label: string; accent?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "ring-signal inline-flex items-center gap-1.5 rounded-pill border bg-surface-2 px-2.5 py-0.5 text-[12px] text-text transition-colors hover:border-line-strong",
        accent ? "border-accent" : "border-line",
      )}
    >
      <span className="font-mono text-[9.5px] uppercase tracking-label text-faint">{label}</span>
      {children}
    </button>
  );
}

/** The page's one filter bar: Range · Kind + With · Measure on three rows, pinned to the
 *  top of the scroll container. Once pinned it condenses to a one-line rail of the current
 *  values (D30 B); Edit or any chip reopens the full bar as an overlay beneath the rail, so
 *  the page does not reflow; Escape or a click outside closes it. */
export function FilterBar({
  scope,
  onScope,
  query,
  onQuery,
  metric,
  onMetric,
  today,
  firstDay,
  retentionDays,
  stale,
}: {
  scope: UsageScope;
  onScope: (s: UsageScope) => void;
  query: UsagePageQuery;
  onQuery: (q: UsagePageQuery) => void;
  metric: ChartMetric;
  onMetric: (m: ChartMetric) => void;
  today: number;
  firstDay: number | null | undefined;
  retentionDays: number | undefined;
  stale: boolean;
}) {
  const [custom, setCustom] = useState(false);
  const [sentinelRef, stuck] = useStuck();
  const barRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // Un-pinning shows the full bar inline again; the overlay has nothing left to do.
  useEffect(() => { if (!stuck) setOpen(false); }, [stuck]);
  useOutsidePress([barRef], open, () => setOpen(false));
  const win = resolveWindow(query, today, firstDay);
  const pickRange = (r: RangePreset) => {
    if (r === "custom") {
      setCustom(true);
      return;
    }
    setCustom(false);
    onQuery({ range: r, with: query.with });
  };
  const toggleStage = (k: UsageStageKey) => {
    const set = new Set(query.with);
    if (set.has(k)) set.delete(k);
    else set.add(k);
    onQuery({ ...query, with: STAGE_KEYS.filter((x) => set.has(x)) });
  };
  const anySet = isFiltered(scope, query) || query.range !== "30";
  const clearAll = () => {
    setCustom(false);
    onScope("all");
    onQuery({ range: "30", with: [] });
  };
  const spanText =
    query.range === "all"
      ? `${fmtDateRange(win.from, win.to)} · ${fmtFull(win.days)} days · since the first ${firstDay == null ? "run" : "dictation"}`
      : `${fmtDateRange(win.from, win.to)} · ${fmtFull(win.days)} ${win.days === 1 ? "day" : "days"}${query.range === "custom" ? " · custom" : ""}`;
  const rangeChip = query.range === "all" ? "All time" : query.range === "custom" ? fmtDateRange(win.from, win.to) : RANGE_LABEL[query.range];
  const clearButton = (
    <button type="button" onClick={clearAll} className="ring-signal rounded-md px-1 text-[12px] text-faint underline underline-offset-4 hover:text-text">
      Clear
    </button>
  );
  const row = "flex flex-wrap items-center gap-x-3.5 gap-y-2.5";
  const full = (
    <>
      <div className={row}>
        <Eyebrow>Range</Eyebrow>
        <Segmented
          value={custom ? "custom" : query.range}
          onChange={pickRange}
          ariaLabel="Range"
          options={RANGE_PRESETS.map((r) => ({ value: r, label: RANGE_LABEL[r] }))}
        />
        {/* While pinned, the rail's top line carries the span and Clear. */}
        {!stuck && (
          <span className="ml-auto flex items-center gap-2">
            {anySet && clearButton}
            <Pill>{spanText}</Pill>
          </span>
        )}
      </div>
      <div className={cn(row, "mt-2.5")}>
        <Eyebrow>Kind</Eyebrow>
        <Segmented
          value={scope}
          onChange={onScope}
          ariaLabel="Kind"
          options={(["all", ...KINDS] as UsageScope[]).map((s) => ({ value: s, label: SCOPE_LABEL[s] }))}
        />
        <Eyebrow>With</Eyebrow>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Stages every session must have used">
          {STAGE_KEYS.map((k) => {
            const on = query.with.includes(k);
            return (
              <button
                key={k}
                type="button"
                aria-pressed={on}
                onClick={() => toggleStage(k)}
                className={cn(
                  "ring-signal inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-0.5 text-[12px] transition-colors",
                  on ? "border-solid border-line-strong bg-surface-2 text-text" : "border-dashed border-line-strong text-dim hover:text-text",
                )}
              >
                <i className="inline-block size-2 rounded-full" style={{ background: STAGE_DOT[k] }} />
                {STAGE_CHIP_LABEL[k]}
              </button>
            );
          })}
        </div>
      </div>
      <div className={cn(row, "mt-2.5")}>
        <Eyebrow>Measure</Eyebrow>
        <Segmented
          value={metric}
          onChange={onMetric}
          ariaLabel="Measure — what every chart counts"
          options={CHART_METRICS.map((m) => ({ value: m, label: METRIC_LABEL[m] }))}
        />
      </div>
      {custom && (
        <CustomSpanPopover
          from={query.range === "custom" && query.from !== undefined ? query.from : win.from}
          to={query.range === "custom" && query.to !== undefined ? query.to : win.to}
          today={today}
          onApply={(from, to) => {
            setCustom(false);
            onQuery({ range: "custom", from, to, with: query.with });
          }}
          onCancel={() => setCustom(false)}
        />
      )}
      {query.with.length > 0 && (
        <div className="mt-2 text-[11.5px] text-faint">
          Stage filters cover the last {fmtFull(retentionDays || 365)} days: every number on this page now counts only sessions that were{" "}
          {query.with.map((k) => STAGE_CHIP_LABEL[k].toLowerCase()).join(" and ")}.
        </div>
      )}
    </>
  );
  // The whole top line toggles the full bar. Its buttons handle their own clicks — the
  // chips and Show / Hide toggle too, Clear clears — so the line ignores a click that
  // started on a button rather than toggling twice (or undoing a Clear's intent).
  const toggleBar = () => setOpen((o) => !o);
  const rail = (
    <div
      className="flex cursor-pointer flex-wrap items-center gap-2"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        toggleBar();
      }}
    >
      <RailChip label="Range" onClick={toggleBar}>{rangeChip}</RailChip>
      <RailChip label="Kind" onClick={toggleBar}>{SCOPE_LABEL[scope]}</RailChip>
      {query.with.length > 0 && (
        <RailChip label="With" onClick={toggleBar}>
          {query.with.map((k) => (
            <span key={k} className="inline-flex items-center gap-1">
              <i className="inline-block size-2 rounded-full" style={{ background: STAGE_DOT[k] }} />
              {STAGE_CHIP_LABEL[k]}
            </span>
          ))}
        </RailChip>
      )}
      <RailChip label="Measure" accent onClick={toggleBar}>{METRIC_LABEL[metric]}</RailChip>
      {stale && <Pill>updating…</Pill>}
      {/* Top-right: the resolved span (the full bar's Range row shows it while open, so the
          rail drops it then) and the one button that opens / closes the full bar. Clear
          lives in the full bar only. */}
      <span className="ml-auto flex items-center gap-2">
        {/* Clear only while the full bar is open under the rail (its own Clear steps aside
            then), left of Hide: the collapsed rail is a readout, not a place to reset from. */}
        {open && anySet && clearButton}
        <Pill>{spanText}</Pill>
        <button
          type="button"
          onClick={toggleBar}
          aria-expanded={open}
          className="ring-signal inline-flex items-center gap-1 rounded-md border border-line-strong bg-surface py-0.5 pl-2.5 pr-1.5 text-[12px] text-text transition-colors hover:bg-surface-2"
        >
          {/* "Show" and "Hide" differ by a pixel or two; a fixed label width keeps the
              button (and Clear beside it) from shifting on every toggle. */}
          <span className="inline-block w-[2.6em] text-left">{open ? "Hide" : "Show"}</span>
          {open ? <ChevronUp className="size-3.5 text-dim" aria-hidden /> : <ChevronDown className="size-3.5 text-dim" aria-hidden />}
        </button>
      </span>
    </div>
  );
  return (
    <>
      <div ref={sentinelRef} className="h-px" aria-hidden />
      <div
        ref={barRef}
        className="sticky top-0 z-30 mb-4"
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
      >
        <div
          className={cn(
            "relative rounded-[12px] border border-line bg-surface/95 px-3 backdrop-blur-sm transition-shadow motion-reduce:transition-none",
            stuck ? "rounded-t-none border-t-transparent py-1.5 shadow-[0_14px_34px_-20px_rgba(0,0,0,0.7)]" : "py-2.5",
            // Open: the full bar hangs off this line's bottom edge, so its bottom corners
            // square off and its own bottom border goes — otherwise the rail's rounded
            // corners peek out above the panel underneath.
            stuck && open && "rounded-b-none border-b-transparent shadow-none",
          )}
        >
          {stuck ? rail : full}
          {stuck && open && (
            <div className="absolute inset-x-[-1px] top-full rounded-b-[12px] border border-t-0 border-line-strong bg-surface px-3 py-2.5 shadow-[0_20px_40px_-20px_rgba(0,0,0,0.7)]">
              {full}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
