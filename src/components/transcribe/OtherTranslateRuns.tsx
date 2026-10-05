import { useApp } from "@/lib/store";
import { Button } from "@/components/ui";
import { useTranscribeRun } from "@/lib/transcribeRun";
import { useTranscriptHistory } from "@/lib/transcript/transcriptHistory";
import { openHistoryRecord } from "@/lib/transcribeRun";
import { safeDisplayText } from "@/lib/sanitize";

/** Retro-translate runs whose transcript is NOT the one on screen: a slim
 *  strip in the Processing-card design language, so a run started on another
 *  record (same-URL siblings, or a record since closed) stays visible and
 *  reachable instead of silently running headless. */
export function OtherTranslateRuns({ excludeKeys }: { excludeKeys: (string | null)[] }) {
  const trRuns = useApp((s) => s.trRuns);
  const records = useTranscriptHistory((s) => s.records);
  const running = useTranscribeRun((s) => s.running); // openHistoryRecord refuses mid-run
  const entries = Object.entries(trRuns).filter(([k]) => !excludeKeys.includes(k));
  if (entries.length === 0) return null;
  return (
    <div className="mt-3 rounded-xl border border-line bg-surface-2/60 px-3.5 py-2.5">
      <div className="mb-1.5 font-mono text-[10.5px] uppercase tracking-label text-faint">
        translating elsewhere
      </div>
      {entries.map(([key, { run }]) => {
        // Runs key by record id (or, before one exists, by source path).
        const rec = records.find((r) => r.id === key || r.sourcePath === key);
        return (
          <div key={key} className="flex items-center gap-3 py-1">
            <span className="size-1.5 shrink-0 rounded-full bg-[color:var(--c-translate)]" />
            <span className="min-w-0 truncate font-mono text-[11.5px] text-text">
              {safeDisplayText(run.title ?? rec?.sourceName ?? key, 60)}
            </span>
            <span className="shrink-0 font-mono text-[11px] uppercase text-dim">
              {run.targets.join(", ")}
              {run.target && run.phase !== "done" ? (
                <span className="text-[color:var(--c-translate)]"> → {safeDisplayText(run.target, 8)}</span>
              ) : null}
            </span>
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-[color:var(--c-translate)]">
              {run.phase === "done" ? "done" : `${Math.round(run.pct * 100)}%`}
            </span>
            <span className="flex-1" />
            {rec && (
              <Button variant="ghost" size="sm" disabled={running} onClick={() => openHistoryRecord(rec)}>
                Open
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
