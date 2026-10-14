import { useReducer } from "react";
import { useApp } from "@/lib/store";
import { Button, MicroLabel } from "@/components/ui";
import { useTranscribeRun } from "@/lib/transcribeRun";
import { useTranscriptHistory } from "@/lib/transcript/transcriptHistory";
import { openHistoryRecord } from "@/lib/transcribeRun";
import { langText, langTexts } from "@/lib/languages";
import { safeDisplayText } from "@/lib/sanitize";
import { cancelTextTranslation } from "@/lib/api";
import { cancelTranslateRun, isTranslateCancelled, translateCtls } from "@/lib/retroTranslate";

/** Retro-translate runs whose transcript is NOT the one on screen: a slim
 *  strip in the Processing-card design language, so a run started on another
 *  record (same-URL siblings, or a record since closed) stays visible and
 *  reachable instead of silently running headless. Its Cancel is the viewer
 *  card's own (cancelTranslateRun): during a new transcription Open is refused,
 *  so a run whose viewer is closed is stopped from here. */
export function OtherTranslateRuns({ excludeKeys }: { excludeKeys: (string | null)[] }) {
  const trRuns = useApp((s) => s.trRuns);
  const records = useTranscriptHistory((s) => s.records);
  const running = useTranscribeRun((s) => s.running); // openHistoryRecord refuses mid-run
  // A cancel only flips the module-scope ctl's flag: re-render so the row shows it at once.
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const entries = Object.entries(trRuns).filter(([k]) => !excludeKeys.includes(k));
  if (entries.length === 0) return null;
  return (
    <div className="mt-3 rounded-xl border border-line bg-surface-2/60 px-3.5 py-2.5">
      <MicroLabel>translating elsewhere</MicroLabel>
      {entries.map(([key, { run }]) => {
        // Runs key by record id (or, before one exists, by source path).
        const rec = records.find((r) => r.id === key || r.sourcePath === key);
        // Gated on the SANITIZED target (joiners dropped): a code that strips to blank would leave a stray arrow.
        const tgt = langText(run.target ?? "", 12).trim();
        const cancelling = run.phase !== "done" && isTranslateCancelled(key);
        return (
          <div key={key} className="flex items-center gap-3 py-1">
            <span className="size-1.5 shrink-0 rounded-full bg-[color:var(--c-translate)]" />
            <span className="min-w-0 truncate font-mono text-[11.5px] text-text">
              {safeDisplayText(run.title ?? rec?.sourceName ?? key, 60)}
            </span>
            <span className="shrink-0 font-mono text-[11px] uppercase text-dim">
              {langTexts(run.targets).join(", ")}
              {tgt && run.phase !== "done" ? (
                <span className="text-[color:var(--c-translate)]"> → {tgt}</span>
              ) : null}
            </span>
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-[color:var(--c-translate)]">
              {run.phase === "done" ? "done" : cancelling ? "cancelling…" : `${Math.round(run.pct * 100)}%`}
            </span>
            <span className="flex-1" />
            {run.phase !== "done" && translateCtls.has(key) && (
              // Not `disabled`: set by the press that cancels, it would drop a keyboard user's
              // focus from the FOCUSED button to <body>. The click is a no-op instead.
              <Button
                variant="ghost"
                size="sm"
                className={cancelling ? "opacity-40" : undefined}
                onClick={() => !cancelling && cancelTranslateRun(key, cancelTextTranslation) && rerender()}
              >
                {cancelling ? "Cancelling…" : "Cancel"}
              </Button>
            )}
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
