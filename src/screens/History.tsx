// Transcription history: every finished (or failed) batch run, stored locally
// as one JSON record per run. Rows are recognition cues (name · time ·
// duration · language · speakers · model · snippet); Open restores the FULL
// workbench state on the Transcribe screen. Search covers names AND corrected
// transcript text — a linear scan is plenty at this scale.

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Check, Download, RotateCcw, Search, Trash2, X,
} from "lucide-react";
import { Button, Card, PageHeader, Select, TextInput } from "@/components/ui";
import { useApp } from "@/lib/store";
import { fmtDuration } from "@/lib/format";
import { pickExportPath, saveTextFile } from "@/lib/api";
import {
  deleteRecord, loadHistory, recordEditedResult, recordText,
  useTranscriptHistory, type TranscriptRecord,
} from "@/lib/transcriptHistory";
import { addFiles, openHistoryRecord, useTranscribeRun } from "@/lib/transcribeRun";
import {
  DEFAULT_SPEAKER_COLORS, EXPORT_EXTENSIONS, generateExport, speakerOrder,
  type ExportFormat,
} from "@/lib/transcriptExport";
import { stripControlChars, safeDisplayText } from "@/lib/sanitize";
import { cn } from "@/lib/cn";

/** "Today" / "Yesterday" / a local date — the bucket a record sorts under. */
function dayBucket(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Earlier";
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function History() {
  const navigate = useNavigate();
  const records = useTranscriptHistory((s) => s.records);
  const loaded = useTranscriptHistory((s) => s.loaded);
  const running = useTranscribeRun((s) => s.running);
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);
  const [query, setQuery] = useState("");
  // Two-step delete: first click arms the row, second click deletes.
  const [armedDelete, setArmedDelete] = useState<string | null>(null);

  useEffect(() => {
    void loadHistory();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return records;
    return records.filter(
      (r) =>
        r.sourceName.toLowerCase().includes(q) ||
        recordText(r).toLowerCase().includes(q),
    );
  }, [records, query]);

  const buckets = useMemo(() => {
    const out: { label: string; items: TranscriptRecord[] }[] = [];
    for (const rec of filtered) {
      const label = dayBucket(rec.createdAt);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(rec);
      else out.push({ label, items: [rec] });
    }
    return out;
  }, [filtered]);

  const open = (rec: TranscriptRecord) => {
    if (openHistoryRecord(rec)) navigate("/transcribe");
  };

  const retry = (rec: TranscriptRecord) => {
    if (running) return;
    addFiles([rec.sourcePath]);
    navigate("/transcribe");
  };

  const quickExport = async (rec: TranscriptRecord) => {
    const t = settings.transcribe ?? {};
    const format = (t.exportFormat ?? "srt") as ExportFormat;
    const ext = EXPORT_EXTENSIONS[format];
    const stem = rec.sourceName.replace(/\.[^.]+$/, "");
    let path: string | null;
    try {
      path = await pickExportPath(`${stem}.${ext}`, format.toUpperCase(), ext);
    } catch (e) {
      console.error("history export dialog failed:", e);
      return;
    }
    if (!path) return;
    const order = speakerOrder(rec.result ?? { text: "" });
    try {
      const contents = generateExport(recordEditedResult(rec), {
        format,
        renames: rec.renames ?? {},
        speakerColors: order.length && (t.colorizeSpeakers ?? true) ? "line" : "off",
        speakerNames: t.showSpeakerNames ?? true,
        timestamps: t.showTimestamps ?? false,
        colors: Object.fromEntries(
          Object.entries(rec.speakerColors ?? {}).map(([l, i]) => [
            l,
            DEFAULT_SPEAKER_COLORS[i % DEFAULT_SPEAKER_COLORS.length],
          ]),
        ),
        wordTimestamps: t.wordTimestamps ?? false,
      });
      await saveTextFile(path, contents);
    } catch (e) {
      console.error("history export failed:", e);
    }
  };

  const retention = String(settings.transcribe?.historyRetentionDays ?? 0);

  return (
    <div className="mx-auto max-w-[820px] px-10 py-12">
      <PageHeader eyebrow="transcribe" title="History">
        Every transcription is kept here — stored only on this machine, with your
        corrections, speaker names and colors.
      </PageHeader>

      <div className="mt-8 flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <TextInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search names and transcript text…"
            aria-label="Search history"
            className="pl-10"
          />
        </div>
        <span className="shrink-0 font-mono text-[11px] text-faint">
          {records.length} transcript{records.length === 1 ? "" : "s"}
        </span>
        <Select
          value={retention}
          onChange={(v) =>
            updateSettings({
              transcribe: { ...settings.transcribe, historyRetentionDays: Number(v) },
            })
          }
          ariaLabel="Delete history after"
          className="w-36"
          options={[
            { value: "0", label: "Keep forever" },
            { value: "7", label: "7 days" },
            { value: "30", label: "30 days" },
            { value: "90", label: "90 days" },
            { value: "365", label: "1 year" },
          ]}
        />
      </div>

      {loaded && !records.length && (
        <Card className="mt-6 p-8 text-center text-[13px] text-dim">
          Nothing here yet — transcribe a file and it will be kept automatically.
        </Card>
      )}
      {loaded && records.length > 0 && !filtered.length && (
        <Card className="mt-6 p-8 text-center text-[13px] text-dim">
          No transcript matches "{safeDisplayText(query, 80)}".
        </Card>
      )}

      {buckets.map((bucket) => (
        <div key={bucket.label}>
          <div className="mt-6 font-mono text-[10.5px] uppercase tracking-label text-faint">
            {bucket.label}
          </div>
          <Card className="mt-2 px-5 py-1">
            {bucket.items.map((rec, i) => {
              const ok = rec.status === "done";
              const speakers = ok ? speakerOrder(rec.result ?? { text: "" }).length : 0;
              const edited =
                !!Object.keys(rec.edits ?? {}).length ||
                !!Object.keys(rec.speakerEdits ?? {}).length;
              const snippet = ok
                ? stripControlChars(recordText(rec)).slice(0, 160)
                : stripControlChars(rec.error ?? "failed").slice(0, 160);
              return (
                <div
                  key={rec.id}
                  className={cn(
                    "flex items-center gap-3 py-3",
                    i < bucket.items.length - 1 && "border-b border-line",
                  )}
                >
                  <span
                    className={cn(
                      "grid size-6 shrink-0 place-items-center rounded-full",
                      ok ? "bg-ok/15 text-ok" : "bg-rec/15 text-rec",
                    )}
                  >
                    {ok ? <Check className="size-3.5" /> : <X className="size-3.5" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2.5">
                      <span className="truncate text-[13px] font-medium text-text">
                        {safeDisplayText(rec.sourceName, 120)}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] text-faint">
                        {timeOf(rec.createdAt)}
                        {rec.result?.duration ? ` · ${fmtDuration(rec.result.duration)}` : ""}
                        {rec.language ? ` · ${safeDisplayText(rec.language, 12)}` : ""}
                        {speakers > 1 ? ` · ${speakers} speakers` : ""}
                        {rec.model ? ` · ${safeDisplayText(rec.model.split("/").pop() ?? rec.model, 40)}` : ""}
                      </span>
                      {edited && (
                        <span className="shrink-0 font-mono text-[11px] text-accent">· edited</span>
                      )}
                    </div>
                    <div className={cn("truncate text-[12px]", ok ? "text-faint" : "text-rec")}>
                      {snippet}
                    </div>
                  </div>
                  {ok && (
                    <Button
                      variant="ghost"
                      size="sm"
                      title="Export with your current format and display settings"
                      onClick={() => void quickExport(rec)}
                    >
                      <Download className="size-3.5" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={running}
                    title={
                      running
                        ? "Wait for the current run to finish"
                        : "Transcribe this file again with your current settings"
                    }
                    onClick={() => retry(rec)}
                  >
                    <RotateCcw className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={cn(armedDelete === rec.id && "text-rec")}
                    title={armedDelete === rec.id ? "Click again to delete from disk" : "Delete"}
                    onClick={() => {
                      if (armedDelete === rec.id) {
                        deleteRecord(rec.id);
                        setArmedDelete(null);
                      } else {
                        setArmedDelete(rec.id);
                      }
                    }}
                  >
                    <Trash2 className="size-3.5" />
                    {armedDelete === rec.id && "Delete?"}
                  </Button>
                  {ok && (
                    <Button
                      variant="default"
                      size="sm"
                      disabled={running}
                      title={running ? "Wait for the current run to finish" : "Open in the workbench"}
                      onClick={() => open(rec)}
                    >
                      Open
                    </Button>
                  )}
                </div>
              );
            })}
          </Card>
        </div>
      ))}
    </div>
  );
}
