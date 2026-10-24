// The usage surfaces: the Home "Usage" strip (four sparkline tiles + small multiples
// by kind, off the fixed 30-day document) and the Statistics page (one filter bar —
// range · kind · with-stages — the measure tiles, the stacked columns by kind bucketed to
// the window, the Stages / Dictation / Calendar / Busy panels, off the page's own
// document). Both read from the store (fed by lib/usage.ts); with no backend reporting usage
// the Home strip hides and the page shows an empty state.
//
// Numbers come from lib/usageDerive.ts (pure, tested); this file only lays them out.
// The backend series is SPARSE (only days that had usage) — densified client-side into
// one point per calendar day so the charts plot against real dates and the ranges
// genuinely differ. Zero-dependency SVG.
//
// Chart conventions (validated palette, see app.css): one colour per job kind, text
// imports hatched neutral; a 2 px surface gap between stacked segments; thin marks; all
// text in the text tokens, never a series colour; the legend is always present.

import {

  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { useApp } from "@/lib/store";
import { Card, SectionLabel } from "@/components/ui";
import { cn } from "@/lib/cn";
import {
  fmtCompact,
  fmtDuration,
  localTodayDay,
  plural,
} from "@/lib/format";
import { TREND_DAYS, sameViewSource, viewSignature, viewStatsBackend, viewerTimeZone, yearPageQuery } from "@/lib/usage";
import { effectiveServerUrl } from "@/lib/backends";
import {
  KINDS,
  KIND_LABEL,
  SCOPE_LABEL,
  STAGE_CHIP_LABEL,
  addKinds,
  bucketMode,
  bucketize,
  densifyKinds,
  facetRows,
  translationRows,
  findStage,
  fmtTimeSaved,
  isDay,
  isFiltered,
  nonNeg,
  orderedStageRows,
  pct,
  type Rhythm,
  resolveWindow,
  safeTotals,
  stageAppliesToScope,
  targetShares,
  zeroKinds,
  type ChartMetric,
  type FacetRow,
  type UsagePageQuery,
  type UsageScope,
} from "@/lib/usageDerive";
import { ownProp } from "@/lib/own";
import { safeIdentityText } from "@/lib/sanitize";
import { BackendChips } from "@/components/stats/BackendChips";
import type { UsageKind, UsageKinds, UsageSeriesPoint, UsageStageKey, UsageStats } from "@/lib/types";
import { BusyPanel } from "@/components/stats/BusyPanel";
import { CalendarPanel } from "@/components/stats/CalendarPanel";
import { FilterBar } from "@/components/stats/FilterBar";
import { StackedChart } from "@/components/stats/StackedChart";
import { StatTile } from "@/components/stats/StatTiles";
import { fmtDateRange, fmtSpanDate, kindFill } from "@/components/stats/chartKit";
import { Eyebrow, HatchDef, Num, Panel, Pill, StageDot, Swatch } from "@/components/stats/primitives";
import { tileSpecs } from "@/components/stats/tileSpecs";

/** Window totals per kind: the densified series summed. */
function windowKinds(dense: readonly UsageKinds[]): UsageKinds {
  return dense.reduce((out, p) => addKinds(out, p), zeroKinds());
}

function StagesPanel({ stats, dense, scope, withS, rangeWord }: { stats: UsageStats; dense: readonly UsageKinds[]; scope: UsageScope; withS: readonly UsageStageKey[]; rangeWord: string }) {
  const win = windowKinds(dense);
  const media = win.file.sessions + win.url.sessions;
  const narrowed = withS.length > 0;
  return (
    <Panel
      title={`Stages · share of sessions that used them, ${rangeWord}`}
      // The stage rows are the document's own, which has no per-kind split (the Kind filter is
      // client-side): say so under a narrowed kind rather than let them read as filtered.
      right={<><Pill>{plural(Math.round(media || 0), "file & link session")} · {plural(Math.round(win.dictation.sessions || 0), "dictation")}</Pill><Pill>counts sessions</Pill>{scope !== "all" && <Pill>all kinds</Pill>}</>}
    >
      <div>
        {orderedStageRows(withS).map((row) => {
          const pinned = withS.includes(row.key);
          if (!stageAppliesToScope(row.key, scope)) {
            return (
              <div key={row.key} className="grid grid-cols-[160px_1fr] items-center gap-3.5 border-t border-line py-2.5 text-[12.5px]">
                <div className="flex items-center gap-2 text-dim">
                  <StageDot color="var(--c-line-strong)" />
                  {row.label}
                </div>
                <div className="text-faint">Files and links only — {SCOPE_LABEL[scope].toLowerCase()} sessions never use it.</div>
              </div>
            );
          }
          const st = findStage(stats.stages, row.key);
          if (!st) {
            return (
              <div key={row.key} className="grid grid-cols-[160px_1fr] items-center gap-3.5 border-t border-line py-2.5 text-[12.5px]">
                <div className="flex items-center gap-2 text-dim">
                  <StageDot color="var(--c-line-strong)" />
                  {row.label}
                </div>
                <div className="text-faint">Not used {rangeWord.startsWith("since ") ? rangeWord : `in ${rangeWord}`}. {row.emptyCopy}</div>
              </div>
            );
          }
          const share = pct(st.runs, st.of_runs);
          const runsWord = row.key === "translating" ? "session" : "file & link session";
          let detail: ReactNode;
          const rtf = <>RTF <Num>{st.audio_s > 0 ? (st.secs / st.audio_s).toFixed(2) : "–"}</Num></>;
          if (row.key === "translating") {
            detail = <>avg <Num>+{(st.secs / st.runs).toFixed(1)} s</Num> / run</>;
          } else if (row.key === "diarizing") {
            detail = <>{rtf}{st.speakers_avg != null && <> · avg <Num>{st.speakers_avg.toFixed(1)}</Num> speakers</>}</>;
          } else if (row.key === "vad") {
            detail = st.retained_avg != null ? <><Num>{Math.round((1 - st.retained_avg) * 100)} %</Num> of audio skipped</> : rtf;
          } else {
            detail = rtf;
          }
          const targets = row.key === "translating" ? targetShares(st) : [];
          const kept = row.key === "translating" ? (st.kept_original ?? 0) : 0;
          return (
            <div key={row.key} className="grid grid-cols-[160px_1fr_110px_150px] items-center gap-3.5 border-t border-line py-2.5 text-[12.5px] max-[820px]:grid-cols-2">
              <div className="flex items-center gap-2 font-semibold text-text">
                <StageDot color={row.colorVar} />
                {row.label}
                {pinned && <span className="rounded-pill border border-line px-1.5 font-mono text-[9.5px] font-normal uppercase tracking-label text-faint">filter</span>}
              </div>
              <div className="flex items-center gap-2.5">
                <div className="h-1.5 flex-1 overflow-hidden rounded-pill bg-line">
                  <i className="block h-full rounded-pill" style={{ width: `${share}%`, background: row.colorVar }} />
                </div>
                <span className="w-[150px] font-num text-[12px] text-text">
                  {share} % · {plural(Math.round(st.runs || 0), runsWord)}
                </span>
              </div>
              <div className="text-dim"><Num>{fmtDuration(st.audio_s)}</Num> audio</div>
              <div className="text-dim">{detail}</div>
              {(targets.length > 0 || kept > 0 || (narrowed && !pinned)) && (
                <div className="col-start-2 col-end-[-1] -mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-faint">
                  {narrowed && !pinned && <span>of the filtered sessions, {share} % were also {STAGE_CHIP_LABEL[row.key].toLowerCase()} ·</span>}
                  {targets.map((t, i) => (
                    <span key={`${i}:${t.code}`} className="rounded-pill border border-line px-2 py-px font-mono text-[11px] text-dim">
                      {t.code} {t.pct} %
                    </span>
                  ))}
                  {kept > 0 && <span>· {plural(Math.round(kept), "segment")} kept the original (translation guard)</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function HBars({ title, rows, empty }: { title: string; rows: FacetRow[]; empty?: ReactNode }) {
  return (
    <div>
      <Eyebrow className="mb-2 block">{title}</Eyebrow>
      {rows.length === 0 && empty ? (
        <div className="text-[12px] text-faint">{empty}</div>
      ) : (
        // Keyed by position: two distinct ids can share a label (both clipped, both "unknown").
        rows.map((r, i) => (
          <div key={`${i}:${r.label}`} className="grid grid-cols-[96px_1fr_44px] items-center gap-2 py-[3px] text-[12px] text-dim">
            <span className="truncate" title={r.title ?? r.label}>{r.label}</span>
            <div className="h-2 overflow-hidden rounded-pill bg-line">
              <i className="block h-full rounded-pill" style={{ width: `${r.pct}%`, background: r.dim ? "var(--c-faint)" : (r.colorVar ?? "var(--c-accent)") }} />
            </div>
            <span className="text-right font-num text-text">{fmtCompact(r.value)}</span>
          </div>
        ))
      )}
    </div>
  );
}

function DictationPanel({ stats, scope }: { stats: UsageStats; scope: UsageScope }) {
  const d = stats.dictation;
  const reportApp = useApp((s) => s.settings.recording.reportTargetApp !== false);
  // Files / Links / Text: the facets do not apply; one line, expandable, so the page's
  // shape stays put while the filter says what it says.
  const collapsible = scope !== "all" && scope !== "dictation";
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [scope]);
  if (collapsible && !open) {
    return (
      <Card className="mt-3.5 flex flex-wrap items-center gap-2.5 px-4 py-3">
        <Eyebrow>Dictation</Eyebrow>
        <span className="text-[12.5px] text-faint">Dictation details apply to dictation sessions.</span>
        <button type="button" onClick={() => setOpen(true)} className="ring-signal rounded-md px-1 text-[12.5px] text-dim underline underline-offset-4 hover:text-text">
          show
        </button>
      </Card>
    );
  }
  const act = d?.activation ?? { hold: 0, handsfree: 0, unreported: 0 };
  const del = d?.delivery ?? { typed: 0, clipboard: 0, none: 0, unreported: 0 };
  const apps = (stats.apps ?? [])
    .filter((a) => a && typeof a.app_id === "string")
    .slice(0, 4)
    // Identity fold, default cap: a blank or invisible-only id reads "unknown", and 80 leaves Rust's
    // 64-char cap + ellipsis uncut.
    .map((a) => ({ label: safeIdentityText(a.app_id) || "unknown", value: a.sessions }));
  return (
    <Panel
      title="Dictation"
      right={
        <>
          <Pill>{plural(Math.round(d?.sessions ?? 0), "session")}</Pill>
          <Pill>counts sessions</Pill>
          {collapsible && (
            <button type="button" onClick={() => setOpen(false)} className="ring-signal rounded-md px-1 text-[12px] text-faint underline underline-offset-4 hover:text-text">
              hide
            </button>
          )}
        </>
      }
    >
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3.5">
        <HBars
          title="Activation"
          rows={facetRows([
            { label: "Push-to-talk", value: act.hold },
            { label: "Hands-free", value: act.handsfree },
            ...((act.unreported ?? 0) > 0 ? [{ label: "Unreported", value: act.unreported ?? 0, dim: true }] : []),
          ])}
        />
        <HBars
          title="Landed as"
          rows={facetRows([
            { label: "Typed", value: del.typed },
            { label: "Clipboard", value: del.clipboard },
            { label: "Nothing", value: del.none, dim: true },
            ...(del.unreported > 0 ? [{ label: "Unreported", value: del.unreported, dim: true }] : []),
          ])}
        />
        <HBars
          title="Typed into"
          rows={facetRows(apps, true)}
          empty={reportApp ? "No app names yet — they appear once a dictation lands." : "Off — “Report the app I dictate into” is turned off in Settings."}
        />
        <HBars title="Translated into" rows={translationRows(d ?? {})} />
      </div>
    </Panel>
  );
}

/** The VIEWED backend (the user's pick, else the home target's) and its fixed 30-day series,
 *  shared by the Home strip + the Statistics page so they stay in sync. The chip readout is
 *  independent — it follows activeStatsBackend (lib/usage.ts): the dictating Profile's
 *  backend, else the home target's. */
function useUsageView() {
  const backends = useApp((s) => s.backends);
  const usage = useApp((s) => s.usage);
  // The poll's own rule (lib/usage.ts): the page's signature must name the backend it fetched.
  const viewBackend = useApp((s) => viewStatsBackend(s));
  const setView = useApp((s) => s.setUsageViewBackend);

  // Own-property reads throughout: a backend id of `constructor`/`toString`/… reads a function
  // off `Object.prototype`, which is truthy here and then hits `stats.series` undefined — a
  // throw in a render body, in a tree with no error boundary.
  const statsBackends = backends.filter((b) => !!ownProp(usage, b.id));
  const stats = viewBackend ? (ownProp(usage, viewBackend.id) ?? null) : null;
  // Per render, not inside the memo: an idle night leaves `stats` the same reference, and the
  // window must still move to the new day.
  const today = localTodayDay();
  const dense = useMemo(
    () => (stats ? densifyKinds(Array.isArray(stats.series) ? stats.series : [], TREND_DAYS, today) : []),
    [stats, today],
  );
  return { backends, statsBackends, viewBackend, setView, stats, dense };
}

const TREND_WORD = `${TREND_DAYS} days`;

/** One kind's 30-day bars on the shared scale — a link into Statistics with that kind. */
function KindMultiple({ kind, dense, max, hatchId }: { kind: UsageKind; dense: UsageSeriesPoint[]; max: number; hatchId: string }) {
  const W = 200;
  const H = 70;
  const n = dense.length;
  const bw = n ? W / n : 0;
  const sum = dense.reduce((s, p) => s + safeTotals(p[kind]).words, 0);
  return (
    <Link
      to={`/statistics?kind=${kind}`}
      className="ring-signal block rounded-[10px] px-1.5 py-1 transition-colors hover:bg-surface-2"
      title={`${KIND_LABEL[kind]} — open in Statistics`}
    >
      <div className="mb-1.5 flex items-center justify-between font-mono text-[10.5px] uppercase tracking-label text-faint">
        <span className="flex items-center gap-1.5"><Swatch kind={kind} />{KIND_LABEL[kind]}</span>
        <span className="font-num normal-case tracking-normal text-text">{fmtCompact(sum)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-[70px] w-full" aria-label={`${KIND_LABEL[kind]}: ${plural(Math.round(sum || 0), "word")} in ${TREND_WORD}`} role="img">
        <line x1={0} x2={W} y1={H - 6} y2={H - 6} stroke="var(--c-line)" />
        {dense.map((p, i) => {
          const v = safeTotals(p[kind]).words;
          if (!(v > 0) || !(max > 0)) return null;
          const h = ((H - 10) * v) / max;
          return <rect key={p.day} x={(i * bw + bw * 0.2).toFixed(1)} y={(H - 6 - h).toFixed(1)} width={(bw * 0.6).toFixed(1)} height={h.toFixed(1)} rx={1.5} fill={kindFill(kind, hatchId)} />;
        })}
      </svg>
    </Link>
  );
}

const HOME_TILES = new Set(["words", "audio_s", "sessions", "errors"]);

/** Home's usage strip; hidden entirely (no empty box) until some backend has usage stats. */
export function HomeUsageStrip() {
  const { backends, statsBackends, viewBackend, setView, stats, dense } = useUsageView();
  const hatchId = useId();
  if (!viewBackend || !stats) return null;
  // Home keeps the four headline figures; the Statistics page shows every measure.
  const tiles = tileSpecs(stats, dense, "all", false, TREND_WORD, TREND_DAYS).filter((t) => HOME_TILES.has(t.key));
  const last30 = dense.slice(-TREND_DAYS);
  const max = Math.max(0, ...last30.flatMap((p) => KINDS.map((k) => safeTotals(p[k]).words)));
  // The server's window-clamped figure — the same one the Statistics tile shows for 30 days.
  const saved = nonNeg(stats.time_saved_s);
  return (
    <section className="mt-8">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <SectionLabel className="!m-0">Usage</SectionLabel>
        <div className="flex flex-wrap items-center gap-2.5">
          <BackendChips backends={statsBackends} labelsFrom={backends} selectedId={viewBackend.id} onSelect={setView} />
          <Link
            to="/statistics"
            className="ring-signal flex items-center gap-1.5 rounded-pill border border-line px-3 py-1 font-mono text-[11px] text-dim transition-colors hover:border-line-strong hover:bg-surface hover:text-text"
          >
            View statistics
            <ArrowRight className="size-3.5" />
          </Link>
        </div>
      </div>
      <div className="grid grid-cols-4 gap-4">
        {tiles.map((t) => (
          <StatTile key={t.key} tile={t} spark />
        ))}
      </div>
      <Panel title={`By kind · ${TREND_WORD}`} right={<Pill>time saved {fmtTimeSaved(saved)}</Pill>} className="mt-3 px-4 pb-2.5 pt-3">
        <svg width="0" height="0" className="absolute" aria-hidden="true">
          <defs><HatchDef id={hatchId} /></defs>
        </svg>
        <div className="grid grid-cols-4 gap-3">
          {KINDS.map((k) => (
            <KindMultiple key={k} kind={k} dense={last30} max={max} hatchId={hatchId} />
          ))}
        </div>
      </Panel>
    </section>
  );
}

/** The range as the panels name it: `30 days` · `1 year` · `since 14. Feb. 2025` · a span. */
function rangeWord(q: UsagePageQuery, win: { from: number; to: number; days: number }): string {
  if (q.range === "all") return `since ${fmtSpanDate(win.from)}`;
  if (q.range === "custom") return fmtDateRange(win.from, win.to);
  if (q.range === "365") return "1 year";
  return `${q.range} days`;
}

/** Statistics page body: backend chips + the filter bar, the measure tiles, the stacked
 *  columns and the four panels. Friendly empty state when no backend has usage. */
export function StatisticsView({
  scope,
  onScope,
  query,
  onQuery,
  metric,
  onMetric,
  rhythm,
  onRhythm,
}: {
  scope: UsageScope;
  onScope: (s: UsageScope) => void;
  query: UsagePageQuery;
  onQuery: (q: UsagePageQuery) => void;
  metric: ChartMetric;
  onMetric: (m: ChartMetric) => void;
  rhythm: Rhythm;
  onRhythm: (r: Rhythm) => void;
}) {
  const { backends, statsBackends, viewBackend, setView, stats: base } = useUsageView();
  const view = useApp((s) => s.usageView);
  const settings = useApp((s) => s.settings);
  const today = localTodayDay();
  // The page's own document counts only when it answers THIS query against THIS backend;
  // until then a stand-in stays up, marked stale.
  const sig = viewBackend ? viewSignature(viewBackend, effectiveServerUrl(viewBackend, settings), query, viewerTimeZone()) : null;
  // A failed fetch for this signature keeps the last good document up (marked stale, filter bar
  // usable) and says so, instead of an "updating…" that never resolves; the next poll retries.
  const fresh = !!sig && view?.sig === sig && !view.failed && !!view.stats;
  const failed = !!sig && view?.sig === sig && !!view.failed;
  // Only a document from this backend + target may stand in while this one loads (another
  // server's numbers would read as this one's under its chip); else the backend's own poll document.
  const stats = fresh ? view!.stats : ((sameViewSource(view?.sig, sig) ? view!.stats : null) ?? base);
  const win = useMemo(() => {
    // An older server without the range echo deserialises a zeroed window (day 0 = 1970);
    // a real echo always spans at least one day, so anything else resolves locally.
    const r = stats?.range;
    // An out-of-range day would throw in the date formatters, so the echo must be whole.
    const echoed = fresh && !!r && isDay(r.from) && isDay(r.to) && r.to > 0 && r.to >= r.from && r.days === r.to - r.from + 1;
    if (echoed) return { from: r!.from, to: r!.to, days: r!.days, bounded: true };
    // "All time" resolves to today..today until the first day is known: a stand-in, not a span.
    const first = r?.first_day;
    const bounded = query.range !== "all" || (isDay(first) && first <= today);
    return { ...resolveWindow(query, today, r?.first_day), bounded };
  }, [fresh, stats, query, today, view]);
  // Points past the window's end are dropped BEFORE densifying: densifyKinds extends its end
  // to the latest data day, so a stand-in document's win.to+1 point would shift the whole span
  // a day later. With them gone it emits exactly win.from..win.to (win.days = to - from + 1).
  const dense = useMemo(
    () =>
      stats ? densifyKinds((Array.isArray(stats.series) ? stats.series : []).filter((p) => !!p && p.day <= win.to), win.days, win.to) : [],
    [stats, win],
  );
  const mode = bucketMode(win.days);
  const buckets = useMemo(() => bucketize(dense, mode), [dense, mode]);
  // The calendar's year: the page's own document when its range spans one, else the
  // separate 365-day document (lib/usage.ts refreshYear), which may still be on its way.
  const year = useApp((s) => s.usageYear);
  const yearQ = yearPageQuery(query);
  const yearSig = yearQ && viewBackend ? viewSignature(viewBackend, effectiveServerUrl(viewBackend, settings), yearQ, viewerTimeZone()) : null;
  // A failed year fetch is not fresh (the carried same-source year shows dimmed), not an empty
  // year — and it says it failed, as the filter bar does, instead of "loading…".
  const yearFresh = !yearQ ? fresh : !!yearSig && year?.sig === yearSig && !year.failed && !!year.stats;
  const yearFailed = !yearQ ? failed : !!yearSig && year?.sig === yearSig && !!year.failed;
  // yearSig shares sig's backend + target, so the same-source check against sig holds for it.
  const yearStats = !yearQ ? stats : (year && sameViewSource(year.sig, sig) ? year.stats : null);
  const yearWin = { from: today - 364, to: today };
  const yearDense = useMemo(
    () =>
      yearStats ? densifyKinds((Array.isArray(yearStats.series) ? yearStats.series : []).filter((p) => !!p && p.day <= today), 365, today) : [],
    [yearStats, today],
  );
  if (!viewBackend || !stats) {
    return (
      <Card className="grid place-items-center p-12 text-center">
        <div className="text-[14px] text-dim">No usage data yet.</div>
        <div className="mt-1.5 max-w-sm text-[12.5px] text-faint">
          Usage statistics appear here once you’ve dictated or transcribed against a backend that records them.
        </div>
      </Card>
    );
  }
  const word = rangeWord(query, win);
  const tiles = tileSpecs(stats, buckets, scope, true, query.range === "all" ? "all time" : query.range === "custom" ? "range" : word, win.days);
  const filtered = isFiltered(scope, query);
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <BackendChips backends={statsBackends} labelsFrom={backends} selectedId={viewBackend.id} onSelect={setView} />
        {failed ? <Pill>couldn’t load this range · showing older data</Pill> : !fresh && <Pill>updating…</Pill>}
      </div>
      <FilterBar
        scope={scope}
        onScope={onScope}
        query={query}
        onQuery={onQuery}
        metric={metric}
        onMetric={onMetric}
        today={today}
        firstDay={stats.range?.first_day}
        retentionDays={stats.range?.jobs_retention_days}
        stale={!fresh}
        failed={failed}
      />
      <div className={cn("grid grid-cols-4 gap-3 max-[860px]:grid-cols-2", !fresh && "opacity-70")}>
        {tiles.map((t) => (
          <StatTile key={t.key} tile={t} spark active={t.metric === metric} onPick={t.metric ? () => onMetric(t.metric!) : undefined} />
        ))}
      </div>
      <div className={cn(!fresh && "opacity-70")}>
        <StackedChart buckets={buckets} mode={mode} scope={scope} metric={metric} />
        <StagesPanel stats={stats} dense={dense} scope={scope} withS={query.with} rangeWord={word} />
        <DictationPanel stats={stats} scope={scope} />
      </div>
      {/* The calendar reads its own year document, so it gets its own wrapper keyed on that
          document's freshness: the whole card (grid, streak, legend counts) dims exactly once,
          and never on a fresh year while the page's range is still loading. */}
      <div className={cn(!yearFresh && "opacity-70")}>
        <CalendarPanel
          dense={yearDense}
          streaks={(yearStats ?? stats).streak}
          scope={scope}
          withS={query.with}
          from={yearWin.from}
          to={yearWin.to}
          mark={win.from <= yearWin.from && win.to >= yearWin.to ? null : { from: win.from, to: win.to, word }}
          filtered={filtered}
          metric={metric}
          stale={!yearFresh}
          failed={yearFailed}
        />
      </div>
      <div className={cn(!fresh && "opacity-70")}>
        <BusyPanel stats={stats} dense={dense} scope={scope} title={word} metric={metric} rhythm={rhythm} onRhythm={onRhythm} from={win.from} to={win.to} bounded={win.bounded} />
      </div>
    </>
  );
}
