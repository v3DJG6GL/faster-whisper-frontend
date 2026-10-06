import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { fmtBytes } from "@/lib/format";
import { type TranslateRunUi } from "@/lib/retroTranslate";
import { safeDisplayText } from "@/lib/sanitize";
import { cn } from "@/lib/cn";

/** m:ss (h:mm:ss beyond an hour) for the progress card's running clock. */
function fmtRunClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(s / 60);
  if (mm < 60) return `${mm}:${String(s % 60).padStart(2, "0")}`;
  return `${Math.floor(mm / 60)}:${String(mm % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Width of the amber model-phase lane in the stage bar, as a fraction —
 *  fixed so the teal translate segment always grows from the same origin. */
const MODEL_LANE = 0.15;

/** The retro-translate mini progress card ("Job Signals") — Processing-box
 *  design language: mono uppercase title, big amber %, Cancel pill, segmented
 *  stage bar (amber model phase → growing teal translate → hatched remainder),
 *  detail chips, and the live last-line readout. */
export function TranslateProgressCard({
  run,
  modeLabel,
  onCancel,
}: {
  run: TranslateRunUi;
  /** The run's requested mode ("fluent"/"faithful") — a detail chip. */
  modeLabel?: string;
  onCancel: () => void;
}) {
  // Self-ticking clock: polls drive most re-renders, but between chunks (or
  // against a backend without the progress entry) nothing else updates.
  const done = run.phase === "done";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // Done: the receipt reads the run's own endedAt — stop ticking.
    if (done) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [done]);
  const reconnecting = run.phase === "reconnecting";
  const lane = run.modelPhaseSeen ? MODEL_LANE : 0;
  const amberW = lane * run.modelPct;
  const tealW = (1 - lane) * (done ? 1 : run.pct);
  const stageText =
    run.phase === "starting"
      ? "Starting…"
      : run.phase === "downloading"
        ? "Downloading model…"
        : run.phase === "loading"
          ? "Loading model…"
          : run.phase === "reconnecting"
            ? "Connection lost — the server may still be working; retrying…"
            : done
              ? "Done"
              : "Translating…";
  // Download receipt chips: fraction, size, and average transfer speed.
  const dlChips: string[] = [];
  if (run.phase === "downloading" && run.totalBytes) {
    const got = run.totalBytes * run.modelPct;
    dlChips.push(`${Math.round(run.modelPct * 100)}% of ${fmtBytes(run.totalBytes)}`);
    const secs = run.dlStartedAt ? (now - run.dlStartedAt) / 1000 : 0;
    if (secs >= 2 && got > 0) dlChips.push(`${fmtBytes(got / secs)}/s`);
  }
  const chips: string[] = [
    ...(run.model ? [safeDisplayText(run.model.split("/").pop() ?? "", 40)] : []),
    ...(run.device ? [safeDisplayText(run.device, 16)] : []),
    ...(modeLabel ? [modeLabel] : []),
    ...dlChips,
  ];
  return (
    <div
      role="status"
      className={cn(
        "mb-2.5 rounded-xl border p-3.5",
        reconnecting ? "border-warn/40 bg-warn/5" : "border-line bg-surface-2/60",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="font-mono text-[10.5px] uppercase tracking-label text-faint">
          translate · {run.targets.join(", ")}
        </span>
        {!done && (
          <button
            type="button"
            onClick={onCancel}
            className="ring-signal inline-flex h-6 items-center rounded-pill border border-line bg-surface-2 px-2.5 text-[11.5px] font-medium text-dim hover:text-text"
          >
            Cancel
          </button>
        )}
      </div>
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {reconnecting ? (
          <span className="font-mono text-[20px] font-medium text-warn">reconnecting…</span>
        ) : done ? (
          <span className="inline-flex items-center gap-1.5 font-mono text-[20px] font-medium text-ok">
            <Check className="size-5" /> done
          </span>
        ) : (
          <span className="font-mono text-[20px] font-medium tabular-nums text-warn">
            {Math.round(run.pct * 100)}%
          </span>
        )}
        <span className="text-[12px] text-dim">{stageText}</span>
        {run.target && !done && (
          <span className="rounded-pill border border-[color:var(--c-translate)]/40 px-1.5 font-mono text-[10px] uppercase text-[color:var(--c-translate)]">
            {safeDisplayText(run.target, 8)}
            {typeof run.targetProgress === "number" ? ` ${Math.round(run.targetProgress * 100)}%` : ""}
          </span>
        )}
        {run.step && !done && (
          <span className="font-mono text-[11px] text-faint">{safeDisplayText(run.step, 48)}</span>
        )}
        <span className="flex-1" />
        <span className="font-mono text-[11px] tabular-nums text-faint">
          {done ? "took" : "running"} {fmtRunClock((done ? (run.endedAt ?? now) : now) - run.startedAt)}
        </span>
      </div>
      <div className={cn("mt-2.5 flex h-1.5 overflow-hidden rounded-pill", reconnecting && "opacity-50")}>
        {amberW > 0 && (
          <div className="bg-warn transition-all" style={{ width: `${amberW * 100}%` }} />
        )}
        <div
          className="bg-[color:var(--c-translate)] transition-all"
          style={{ width: `${tealW * 100}%` }}
        />
        {/* Hatched remainder — "known extent, not yet earned". */}
        <div
          className="flex-1 bg-surface-2 text-faint"
          style={{
            backgroundImage:
              "repeating-linear-gradient(135deg, transparent 0 5px, color-mix(in srgb, currentColor 25%, transparent) 5px 7px)",
          }}
        />
      </div>
      {chips.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {chips.map((c, i) => (
            <span
              key={i}
              className="rounded-pill border border-line bg-surface px-2 py-0.5 font-mono text-[10.5px] text-dim"
            >
              {c}
            </span>
          ))}
        </div>
      )}
      {/* Server warnings (quality guard "kept original" etc.) — compact amber
          line; the flagged transcript lines carry the per-segment detail. */}
      {(run.warnings?.length ?? 0) > 0 && (
        <div className="mt-2 font-mono text-[11px] text-warn">
          {run.warnings!.length === 1
            ? safeDisplayText(run.warnings![0], 160)
            : `${run.warnings!.length} warnings — some segments kept the original`}
        </div>
      )}
      {run.lastText && !done && (
        <div className="mt-2 truncate font-mono text-[11px] text-[color:var(--c-translate)]/90">
          {safeDisplayText(run.lastText, 200)}
        </div>
      )}
    </div>
  );
}
