import { useEffect, useRef, useState } from "react";
import {
  UploadCloud, FileAudio, X, Loader2, Copy, Check, Plus, RotateCcw, Download,
} from "lucide-react";
import { useApp } from "@/lib/store";
import {
  Button, Card, Notice, PageHeader, Segmented, Select, SettingRow, Stepper, Toggle,
} from "@/components/ui";
import { LANGUAGES } from "@/lib/languages";
import { fmtDuration, fmtTimestamp } from "@/lib/format";
import {
  pickAudioFiles, pickExportPath, saveTextFile, transcribeFile, isTauri,
} from "@/lib/api";
import { backendOptions, effectiveServerUrl } from "@/lib/backends";
import { effectiveServerKind } from "@/lib/serverKind";
import { stripControlChars, safeDisplayText } from "@/lib/sanitize";
import {
  EXPORT_EXTENSIONS, generateExport,
  type ExportFormat, type SpeakerColorMode,
} from "@/lib/transcriptExport";
import { cn } from "@/lib/cn";
import type { BatchResult, TranscribeOptions } from "@/lib/types";

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** How much of a returned transcript to lay out before the user asks for the rest.
 *
 *  The user picks the FILE; the server picks the RESPONSE — a small upload can be answered with a
 *  body up to the 32 MiB transport cap, and this card renders it wrapping, in one synchronous
 *  pass, with no error boundary to recover from a stalled renderer. A long transcript is also
 *  exactly what this screen is for, so this is a preview with an explicit "show the rest", not a
 *  truncation: `result.text` is untouched, and Copy still writes the FULL text. */
const TRANSCRIPT_PREVIEW_CHARS = 50_000;

/** Bound the "server ignored N overrides" list too — same untrusted response, same DOM. */
const MAX_IGNORED_SHOWN = 50;

/** Segment cap for the Timestamps/Speakers views — same renderer-stall reasoning as the
 *  character preview above (each segment is a DOM row; an hour of speech is ~1-2k rows,
 *  fine; a hostile response could carry far more). */
const MAX_SEGMENT_ROWS = 5_000;

type View = "text" | "time" | "speakers";
type ItemStatus = "queued" | "running" | "done" | "failed" | "cancelled";

interface QueueItem {
  path: string;
  status: ItemStatus;
  result?: BatchResult;
  error?: string;
}

/** Speaker chip tones, assigned by first appearance. Coral (--c-rec) stays
 *  reserved for the live recording pulse, per the design system. */
const SPEAKER_TONES = [
  { text: "text-accent", bg: "bg-accent-soft", dot: "bg-accent" },
  { text: "text-think", bg: "bg-think/15", dot: "bg-think" },
  { text: "text-live", bg: "bg-live/15", dot: "bg-live" },
  { text: "text-warn", bg: "bg-warn/10", dot: "bg-warn" },
  { text: "text-ok", bg: "bg-ok/10", dot: "bg-ok" },
] as const;

/** "SPEAKER_00" → "Speaker 1"; anything else verbatim (already bounded by Rust). */
function prettySpeaker(label: string): string {
  const m = /^SPEAKER_(\d+)$/.exec(label);
  return m ? `Speaker ${parseInt(m[1], 10) + 1}` : label;
}

/** Distinct speaker labels of a result, in first-appearance order. */
function speakersOf(result: BatchResult): string[] {
  if (result.speakers?.length) return result.speakers;
  const seen: string[] = [];
  for (const s of result.segments ?? []) {
    if (s.speaker && !seen.includes(s.speaker)) seen.push(s.speaker);
  }
  return seen;
}

export default function Transcribe() {
  const backends = useApp((s) => s.backends);
  const connections = useApp((s) => s.connections);
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);

  const [backendId, setBackendId] = useState(backends[0]?.id ?? "");
  const [language, setLanguage] = useState(backends[0]?.language ?? "auto");
  const [files, setFiles] = useState<string[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [view, setView] = useState<View>("text");
  const [copied, setCopied] = useState(false);
  // Reset per result, so a new (possibly huge) transcript starts collapsed again.
  const [showFullText, setShowFullText] = useState(false);
  // Per-run stage options, seeded from the persisted screen defaults.
  const [diarize, setDiarize] = useState(() => settings.transcribe?.diarize ?? false);
  const [numSpeakers, setNumSpeakers] = useState(() => settings.transcribe?.numSpeakers ?? 0);
  const [translate, setTranslate] = useState(() => settings.transcribe?.translate ?? false);
  // Per-file speaker renames (label → display name). Ephemeral by design —
  // renames describe ONE recording's voices, not a persistent mapping.
  const [renames, setRenames] = useState<Record<string, Record<string, string>>>({});
  const [editingSpeaker, setEditingSpeaker] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // Export panel state, seeded from the persisted screen defaults.
  const [showExport, setShowExport] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>(
    () => settings.transcribe?.exportFormat ?? "srt",
  );
  const [colorMode, setColorMode] = useState<SpeakerColorMode>(
    () => settings.transcribe?.speakerColorMode ?? "off",
  );
  const [wordTs, setWordTs] = useState(() => settings.transcribe?.wordTimestamps ?? false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);

  // Abandons in-flight work: the pump loop and every commit site compare
  // against the CURRENT epoch, so a stale completion can't strand its result
  // against changed inputs (same idea as the old single-run runId).
  const epochRef = useRef(0);
  const runningRef = useRef(false);
  // The options of the current/last run, so Retry re-runs a failed file with
  // the same stages instead of silently dropping them.
  const optionsRef = useRef<TranscribeOptions | undefined>(undefined);
  const queueRef = useRef<QueueItem[]>(queue);
  queueRef.current = queue;
  // The "Copied" confirmation timer. Held in a ref so a rapid second Copy click clears the first
  // timer before re-arming — otherwise the stale timer fires mid-window and flips the label off
  // early (every other transient timer in the app is cleared the same way).
  const copyTimer = useRef<number | undefined>(undefined);
  // Prevents a double-click from opening two native file dialogs.
  const picking = useRef(false);

  // The store boots with a seeded backend, then config hydration (and later edits/removals)
  // can replace the list with different ids. Re-sync the selection when the current id falls
  // out of the list, so the Backend dropdown and language don't reference a backend that's gone.
  useEffect(() => {
    if (backends.length && !backends.some((b) => b.id === backendId)) {
      setBackendId(backends[0].id);
      setLanguage(backends[0].language ?? "auto");
    }
  }, [backends, backendId]);

  const backend = backends.find((b) => b.id === backendId) ?? backends[0];
  const serverKind = backend ? effectiveServerKind(backend, connections[backend.id]) : "unknown";
  // "unknown" must never gate (serverKind.ts contract) — only a PROVEN
  // standard server hides the full-backend-only stages.
  const isStandard = serverKind === "standard";

  const busy = queue.some((it) => it.status === "running" || it.status === "queued");
  const doneCount = queue.filter((it) => it.status === "done").length;
  const selected = queue.find((it) => it.path === selectedPath && it.status === "done");
  const result = selected?.result ?? null;

  const persistOptions = (patch: Partial<NonNullable<typeof settings.transcribe>>) => {
    updateSettings({ transcribe: { ...settings.transcribe, ...patch } });
  };

  const resetForInputChange = () => {
    epochRef.current++;
    setQueue([]);
    setSelectedPath(null);
    setCopied(false);
    if (copyTimer.current) {
      window.clearTimeout(copyTimer.current);
      copyTimer.current = undefined;
    }
  };

  const choose = async () => {
    if (picking.current || busy) return;
    picking.current = true;
    let paths: string[];
    try {
      paths = await pickAudioFiles();
    } catch (e) {
      console.error("pick audio files failed:", e);
      return;
    } finally {
      picking.current = false;
    }
    if (paths.length) {
      resetForInputChange(); // changed inputs abandon any settled results
      setFiles((prev) => [...prev, ...paths.filter((p) => !prev.includes(p))]);
    }
  };

  const removeFile = (path: string) => {
    if (busy) return;
    resetForInputChange();
    setFiles((prev) => prev.filter((p) => p !== path));
  };

  const patchItem = (path: string, patch: Partial<QueueItem>) => {
    setQueue((q) => q.map((it) => (it.path === path ? { ...it, ...patch } : it)));
  };

  const pump = async (epoch: number, options: TranscribeOptions | undefined) => {
    if (runningRef.current || !backend) return;
    runningRef.current = true;
    try {
      while (epoch === epochRef.current) {
        const next = queueRef.current.find((it) => it.status === "queued");
        if (!next) break;
        patchItem(next.path, { status: "running" });
        try {
          const res = await transcribeFile({
            serverUrl: effectiveServerUrl(backend, useApp.getState().settings),
            backendId: backend.id,
            model: backend.model,
            language,
            // Empty backend prompt = inherit the server DEFAULT_PROMPT → omit the field.
            prompt: backend.prompt || undefined,
            decodeOverrides: backend.decodeOverrides,
            overrideProfile: backend.overrideProfile,
            filePath: next.path,
            options,
          });
          if (epoch !== epochRef.current) return;
          patchItem(next.path, { status: "done", result: res });
          setSelectedPath(next.path); // follow the latest finished file
          setShowFullText(false);
        } catch (e) {
          if (epoch !== epochRef.current) return;
          patchItem(next.path, { status: "failed", error: String(e) });
        }
      }
    } finally {
      runningRef.current = false;
    }
  };

  const run = () => {
    if (!files.length || !backend || busy) return;
    const epoch = ++epochRef.current;
    setSelectedPath(null);
    setCopied(false);
    const items: QueueItem[] = files.map((path) => ({ path, status: "queued" }));
    setQueue(items);
    queueRef.current = items; // pump may start before the state render lands
    const options: TranscribeOptions | undefined =
      diarize || translate
        ? {
            ...(translate
              ? { task: "translate" as const, useTranslationsEndpoint: isStandard }
              : {}),
            ...(diarize && !isStandard
              ? { diarize: true, ...(numSpeakers > 0 ? { numSpeakers } : {}) }
              : {}),
          }
        : undefined;
    optionsRef.current = options;
    void pump(epoch, options);
  };

  const cancelRemaining = () => {
    setQueue((q) =>
      q.map((it) => (it.status === "queued" ? { ...it, status: "cancelled" } : it)),
    );
  };

  const retry = (path: string) => {
    if (busy) return;
    patchItem(path, { status: "queued", error: undefined });
    void pump(epochRef.current, optionsRef.current);
  };

  // ── selected-result derivations ──────────────────────────────────────────
  const speakers = result ? speakersOf(result) : [];
  const hasSegments = !!result?.segments?.length;
  const hasSpeakers = speakers.length > 0;
  const effectiveView: View =
    view === "speakers" && !hasSpeakers ? "text" : view === "time" && !hasSegments ? "text" : view;
  const fileRenames = (selectedPath && renames[selectedPath]) || {};
  const displayName = (label: string) =>
    safeDisplayText(fileRenames[label]?.trim() || prettySpeaker(label));
  const toneOf = (label: string) => SPEAKER_TONES[Math.max(0, speakers.indexOf(label)) % SPEAKER_TONES.length];

  const commitRename = () => {
    if (editingSpeaker && selectedPath) {
      const name = stripControlChars(renameDraft).trim();
      setRenames((r) => ({
        ...r,
        [selectedPath]: { ...r[selectedPath], [editingSpeaker]: name },
      }));
    }
    setEditingSpeaker(null);
  };

  const copyText = (): string => {
    if (!result) return "";
    if (effectiveView === "time" && result.segments) {
      return result.segments
        .map((s) => `[${fmtTimestamp(s.start)} → ${fmtTimestamp(s.end)}]  ${s.text.trim()}`)
        .join("\n");
    }
    if (effectiveView === "speakers" && result.segments) {
      return result.segments
        .map((s) => {
          const who = s.speaker ? `${displayName(s.speaker)}: ` : "";
          return `[${fmtTimestamp(s.start)}]  ${who}${s.text.trim()}`;
        })
        .join("\n");
    }
    return result.text;
  };

  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(stripControlChars(copyText()));
    } catch (e) {
      console.error("clipboard copy failed:", e); // don't flash "Copied" if the write failed
      return;
    }
    setCopied(true);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  const doExport = async () => {
    if (!result || !selectedPath) return;
    setSaveError(null);
    const ext = EXPORT_EXTENSIONS[exportFormat];
    const stem = basename(selectedPath).replace(/\.[^.]+$/, "");
    let path: string | null;
    try {
      path = await pickExportPath(`${stem}.${ext}`, exportFormat.toUpperCase(), ext);
    } catch (e) {
      console.error("export save dialog failed:", e);
      return;
    }
    if (!path) return; // cancelled
    try {
      const contents = generateExport(result, {
        format: exportFormat,
        renames: fileRenames,
        speakerColors: hasSpeakers ? colorMode : "off",
        wordTimestamps: wordTs,
      });
      await saveTextFile(path, contents);
    } catch (e) {
      setSaveError(String(e));
      return;
    }
    setSaved(true);
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => setSaved(false), 1500);
  };

  // Clear still-pending confirmation timers if the screen unmounts mid-window.
  useEffect(
    () => () => {
      window.clearTimeout(copyTimer.current);
      window.clearTimeout(saveTimer.current);
    },
    [],
  );

  // ── render ───────────────────────────────────────────────────────────────
  const viewOptions: { value: View; label: string }[] = [
    { value: "text", label: "Text" },
    ...(hasSegments ? [{ value: "time" as const, label: "Timestamps" }] : []),
    ...(hasSpeakers ? [{ value: "speakers" as const, label: "Speakers" }] : []),
  ];

  return (
    <div className="mx-auto max-w-[820px] px-10 py-12">
      <PageHeader eyebrow="batch" title="Transcribe a file">
        Send audio or video files to one of your backends via the batch endpoint.
      </PageHeader>

      {files.length ? (
        <div className="mt-8 grid w-full place-items-center rounded-card border border-dashed border-line-strong bg-surface/60 px-8 py-8">
          <div className="flex max-w-full flex-wrap items-center justify-center gap-3">
            {files.map((path) => (
              <div
                key={path}
                className="flex items-center gap-3 rounded-xl border border-line bg-surface-2 px-4 py-3"
              >
                <FileAudio className="size-5 shrink-0 text-accent" />
                <span className="max-w-[300px] truncate text-[13px] text-text">{basename(path)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${basename(path)}`}
                  disabled={busy}
                  onClick={() => removeFile(path)}
                  className="ring-signal grid size-6 place-items-center rounded-lg text-faint transition-colors hover:text-rec disabled:opacity-40"
                >
                  <X className="size-4" />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={choose}
            disabled={busy}
            className="ring-signal mt-4 inline-flex items-center gap-1.5 rounded-lg text-[12.5px] font-medium text-dim hover:text-text disabled:opacity-40"
          >
            <Plus className="size-3.5" /> Add more files
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={choose}
          className="ring-signal mt-8 grid w-full place-items-center rounded-card border border-dashed border-line-strong bg-surface/60 px-8 py-12 text-center transition-colors hover:border-faint"
        >
          <div className="grid size-12 place-items-center rounded-2xl bg-surface-2 text-faint">
            <UploadCloud className="size-6" />
          </div>
          <div className="mt-4 text-[14px] text-text">Choose files to transcribe</div>
          <div className="mt-1 text-[12.5px] text-dim">Audio or video — wav, mp3, m4a, ogg, webm, flac…</div>
        </button>
      )}

      <div className="mt-6 grid grid-cols-2 gap-4">
        <div>
          <label className="mb-2 block text-[12px] font-medium text-dim">Backend</label>
          <Select
            ariaLabel="Backend"
            value={backendId}
            onChange={(v) => {
              // A backend change is an input change: abandon any in-flight run + clear stale
              // results, else the prior backend's transcript/error shows under the new selection.
              resetForInputChange();
              setBackendId(v);
              const b = backends.find((x) => x.id === v);
              if (b) setLanguage(b.language ?? "auto");
            }}
            options={backendOptions(backends)}
          />
        </div>
        <div>
          <label className="mb-2 block text-[12px] font-medium text-dim">Language</label>
          <Select
            ariaLabel="Language"
            value={language}
            onChange={(v) => {
              resetForInputChange();
              setLanguage(v);
            }}
            options={LANGUAGES}
          />
        </div>
      </div>

      <div className="mt-6">
        <div className="mb-2.5 font-mono text-[11px] uppercase tracking-label text-faint">processing</div>
        <Card className="px-5 py-1">
          {!isStandard && (
            <SettingRow
              title="Speaker diarization"
              desc="Label who is speaking in each segment. Runs on the server after transcription."
            >
              <div className="flex items-center gap-4">
                {diarize && (
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] text-dim">Speakers</span>
                    <Stepper
                      value={numSpeakers}
                      onChange={(v) => {
                        setNumSpeakers(v);
                        persistOptions({ numSpeakers: v });
                      }}
                      min={0}
                      max={32}
                      zeroLabel="auto"
                      ariaLabel="Expected speakers"
                    />
                  </div>
                )}
                <Toggle
                  checked={diarize}
                  ariaLabel="Speaker diarization"
                  onChange={(v) => {
                    setDiarize(v);
                    persistOptions({ diarize: v });
                  }}
                />
              </div>
            </SettingRow>
          )}
          <SettingRow
            title="Translate to English"
            desc="Whisper's translate task instead of transcribing in the source language."
            last
          >
            <Toggle
              checked={translate}
              ariaLabel="Translate to English"
              onChange={(v) => {
                setTranslate(v);
                persistOptions({ translate: v });
              }}
            />
          </SettingRow>
        </Card>
      </div>

      <div className="mt-6 flex items-center gap-3">
        <Button variant="accent" disabled={!files.length || busy || !isTauri} onClick={run}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          {busy
            ? "Transcribing…"
            : files.length > 1
              ? `Transcribe ${files.length} files`
              : "Transcribe"}
        </Button>
        {busy && (
          <Button variant="default" onClick={cancelRemaining}>
            Cancel remaining
          </Button>
        )}
        {busy && queue.length > 1 && (
          <span className="font-mono text-[11px] text-faint">
            {doneCount} of {queue.length} done
          </span>
        )}
        {!isTauri && <span className="text-[12px] text-faint">Available in the desktop app.</span>}
      </div>

      {queue.length > 1 && (
        <Card className="mt-6 px-5 py-1">
          {queue.map((it, i) => (
            <div
              key={it.path}
              className={cn(
                "flex items-center gap-3 py-3",
                i < queue.length - 1 && "border-b border-line",
              )}
            >
              <span
                className={cn(
                  "grid size-6 shrink-0 place-items-center rounded-full",
                  it.status === "done" && "bg-ok/15 text-ok",
                  it.status === "running" && "bg-think/15 text-think",
                  it.status === "failed" && "bg-rec/15 text-rec",
                  (it.status === "queued" || it.status === "cancelled") && "bg-surface-2 text-faint",
                )}
              >
                {it.status === "done" ? (
                  <Check className="size-3.5" />
                ) : it.status === "running" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : it.status === "failed" ? (
                  <X className="size-3.5" />
                ) : (
                  <span className="font-mono text-[11px]">{i + 1}</span>
                )}
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-[13px]",
                  it.status === "cancelled" ? "text-faint line-through" : "text-text",
                )}
              >
                {basename(it.path)}
              </span>
              {it.status === "done" && it.result && (
                <span className="font-mono text-[11px] text-faint">
                  {it.result.duration
                    ? it.result.duration < 60
                      ? `${it.result.duration.toFixed(0)}s`
                      : fmtDuration(it.result.duration)
                    : ""}
                  {it.result.language ? ` · ${it.result.language}` : ""}
                  {speakersOf(it.result).length
                    ? ` · ${speakersOf(it.result).length} speakers`
                    : ""}
                </span>
              )}
              {it.status === "running" && (
                <span className="font-mono text-[11px] text-think">transcribing…</span>
              )}
              {it.status === "cancelled" && (
                <span className="font-mono text-[11px] text-faint">cancelled</span>
              )}
              {it.status === "failed" && (
                <>
                  <span
                    className="max-w-[240px] truncate font-mono text-[11px] text-rec"
                    title={stripControlChars(it.error ?? "")}
                  >
                    {stripControlChars(it.error ?? "failed")}
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => retry(it.path)} disabled={busy}>
                    <RotateCcw className="size-3.5" /> Retry
                  </Button>
                </>
              )}
              {it.status === "done" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn(it.path === selectedPath && "text-accent")}
                  onClick={() => {
                    setSelectedPath(it.path);
                    setShowFullText(false);
                  }}
                >
                  {it.path === selectedPath ? "Viewing" : "View"}
                </Button>
              )}
            </div>
          ))}
        </Card>
      )}

      {queue.length === 1 && queue[0].status === "failed" && (
        <Notice className="mt-6">{stripControlChars(queue[0].error ?? "Transcription failed.")}</Notice>
      )}

      {result && (
        <Card className="mt-6 p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="font-mono text-[11px] uppercase tracking-label text-faint">
              transcript
              {queue.length > 1 && selectedPath ? ` · ${basename(selectedPath)}` : ""}
              {result.language ? ` · ${result.language}` : ""}
              {result.duration
                ? ` · ${result.duration < 60 ? `${result.duration.toFixed(1)}s` : fmtDuration(result.duration)}`
                : ""}
              {hasSpeakers ? ` · ${speakers.length} speakers` : ""}
            </div>
            <div className="flex items-center gap-2">
              {viewOptions.length > 1 && (
                <div
                  role="group"
                  aria-label="Transcript view"
                  className="inline-flex rounded-pill border border-line bg-surface-2 p-[3px]"
                >
                  {viewOptions.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      aria-pressed={o.value === effectiveView}
                      onClick={() => setView(o.value)}
                      className={cn(
                        "ring-signal rounded-pill px-3 py-0.5 text-[12px] font-medium transition-colors",
                        o.value === effectiveView
                          ? "bg-accent text-accent-ink"
                          : "text-dim hover:text-text",
                      )}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              )}
              <Button variant="ghost" size="sm" onClick={copy}>
                {copied ? <Check className="size-4 text-ok" /> : <Copy className="size-4" />}
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={() => setShowExport((v) => !v)}
                aria-expanded={showExport}
              >
                <Download className="size-4" />
                Export · {exportFormat.toUpperCase()}
              </Button>
            </div>
          </div>

          {showExport && (
            <div className="mb-4 flex flex-wrap items-end gap-4 rounded-xl border border-line bg-surface-2/60 p-4">
              <div>
                <label className="mb-2 block text-[12px] font-medium text-dim">Format</label>
                <Select
                  ariaLabel="Export format"
                  className="w-32"
                  value={exportFormat}
                  onChange={(v) => {
                    setExportFormat(v);
                    persistOptions({ exportFormat: v });
                  }}
                  options={[
                    { value: "srt", label: "SRT" },
                    { value: "vtt", label: "VTT" },
                    { value: "txt", label: "TXT" },
                    { value: "lrc", label: "LRC" },
                    { value: "json", label: "JSON" },
                  ]}
                />
              </div>
              {(exportFormat === "lrc" || exportFormat === "json") &&
                !!result.words?.length && (
                  <div className="flex h-10 items-center gap-2.5">
                    <Toggle
                      checked={wordTs}
                      ariaLabel="Word timestamps"
                      onChange={(v) => {
                        setWordTs(v);
                        persistOptions({ wordTimestamps: v });
                      }}
                    />
                    <span className="text-[12.5px] text-dim">Word timestamps</span>
                  </div>
                )}
              {hasSpeakers && (exportFormat === "srt" || exportFormat === "vtt") && (
                <div>
                  <label className="mb-2 block text-[12px] font-medium text-dim">
                    Speaker colors
                  </label>
                  <Segmented
                    ariaLabel="Speaker colors"
                    value={colorMode}
                    onChange={(v) => {
                      setColorMode(v);
                      persistOptions({ speakerColorMode: v });
                    }}
                    options={[
                      { value: "off", label: "Off" },
                      { value: "name", label: "Name" },
                      { value: "line", label: "Line" },
                      { value: "line-only", label: "Line only" },
                    ]}
                  />
                </div>
              )}
              <Button variant="accent" size="sm" className="h-10" onClick={doExport}>
                {saved ? <Check className="size-4" /> : <Download className="size-4" />}
                {saved ? "Saved" : "Save file"}
              </Button>
              {saveError && (
                <span className="text-[12px] text-warn">{stripControlChars(saveError)}</span>
              )}
            </div>
          )}

          {effectiveView === "speakers" && (
            <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-line pb-3">
              {speakers.map((label) => {
                const tone = toneOf(label);
                return editingSpeaker === label ? (
                  <input
                    key={label}
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      else if (e.key === "Escape") setEditingSpeaker(null);
                    }}
                    aria-label={`Rename ${prettySpeaker(label)}`}
                    className="ring-signal h-7 w-36 rounded-pill border border-accent/40 bg-surface-2 px-3 text-[12px] text-text outline-none"
                  />
                ) : (
                  <button
                    key={label}
                    type="button"
                    title="Rename this speaker"
                    onClick={() => {
                      setEditingSpeaker(label);
                      setRenameDraft(fileRenames[label] ?? "");
                    }}
                    className={cn(
                      "ring-signal inline-flex items-center gap-1.5 rounded-pill py-0.5 pl-2 pr-2.5 text-[12px] font-medium",
                      tone.text,
                      tone.bg,
                    )}
                  >
                    <span className={cn("size-[7px] rounded-full", tone.dot)} />
                    {displayName(label)}
                  </button>
                );
              })}
              <span className="text-[11.5px] text-faint">
                click a name to rename — renames apply to Copy and exports
              </span>
            </div>
          )}

          {/* `transport::batch` deliberately leaves `text` untouched ("that IS the output"), so
              bidi overrides and other invisible format characters from an untrusted server reach
              this node by design. The Copy button above already strips them; without the same
              treatment here what the user READS can be reordered relative to what they paste. */}
          {effectiveView === "text" ? (
            <div className="select-text whitespace-pre-wrap text-[14px] leading-relaxed text-text">
              {stripControlChars(showFullText ? result.text : result.text.slice(0, TRANSCRIPT_PREVIEW_CHARS))}
            </div>
          ) : (
            <div className="select-text text-[14px] leading-relaxed text-text">
              {(result.segments ?? []).slice(0, MAX_SEGMENT_ROWS).map((seg, i) => (
                <div key={i} className="flex gap-3 py-0.5">
                  <span className="shrink-0 pt-0.5 font-mono text-[12px] tabular-nums text-faint">
                    {fmtTimestamp(seg.start)}
                  </span>
                  {effectiveView === "speakers" && seg.speaker && (
                    <span
                      className={cn(
                        "mt-0.5 inline-flex shrink-0 items-center gap-1.5 self-start rounded-pill py-0.5 pl-2 pr-2.5 text-[12px] font-medium",
                        toneOf(seg.speaker).text,
                        toneOf(seg.speaker).bg,
                      )}
                    >
                      <span className={cn("size-[7px] rounded-full", toneOf(seg.speaker).dot)} />
                      {displayName(seg.speaker)}
                    </span>
                  )}
                  <span className="whitespace-pre-wrap">{stripControlChars(seg.text.trim())}</span>
                </div>
              ))}
            </div>
          )}

          {effectiveView === "text" && !showFullText && result.text.length > TRANSCRIPT_PREVIEW_CHARS && (
            <div className="mt-3 flex items-center gap-3">
              <Button variant="ghost" size="sm" onClick={() => setShowFullText(true)}>
                Show full transcript
              </Button>
              <span className="text-[12px] text-faint">
                Showing the first {TRANSCRIPT_PREVIEW_CHARS.toLocaleString()} of{" "}
                {result.text.length.toLocaleString()} characters. Copy always copies all of it.
              </span>
            </div>
          )}
        </Card>
      )}

      {result?.warnings && result.warnings.length > 0 && (
        <Notice className="mt-3">
          {result.warnings.map((w, i) => (
            <div key={i}>{w}</div>
          ))}
        </Notice>
      )}

      {result?.overridesIgnored && result.overridesIgnored.length > 0 && (
        <Notice className="mt-3">
          The server ignored {result.overridesIgnored.length} override
          {result.overridesIgnored.length === 1 ? "" : "s"} (locked by the server admin):{" "}
          <span className="font-mono text-[12px]">
            {result.overridesIgnored.slice(0, MAX_IGNORED_SHOWN).join(", ")}
          </span>
          {result.overridesIgnored.length > MAX_IGNORED_SHOWN ? " …" : ""}.
        </Notice>
      )}
    </div>
  );
}
