import { useEffect, useRef, useState } from "react";
import { UploadCloud, FileAudio, X, Loader2, Copy, Check, Clock } from "lucide-react";
import { useApp } from "@/lib/store";
import { Button, Card, Notice, PageHeader, Select } from "@/components/ui";
import { LANGUAGES } from "@/lib/languages";
import { fmtDuration, fmtTimestamp } from "@/lib/format";
import { pickAudioFile, transcribeFile, isTauri } from "@/lib/api";
import { backendOptions, effectiveServerUrl } from "@/lib/backends";
import { stripControlChars } from "@/lib/sanitize";
import type { BatchResult } from "@/lib/types";

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

export default function Transcribe() {
  const backends = useApp((s) => s.backends);
  const [backendId, setBackendId] = useState(backends[0]?.id ?? "");
  const [language, setLanguage] = useState(backends[0]?.language ?? "auto");
  const [filePath, setFilePath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BatchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showFullText, setShowFullText] = useState(false);
  const [showTimestamps, setShowTimestamps] = useState(false);
  const runId = useRef(0);
  const copyTimer = useRef<number | undefined>(undefined);
  // Prevents a double-click from opening two native file dialogs.
  const picking = useRef(false);

  useEffect(() => {
    if (backends.length && !backends.some((b) => b.id === backendId)) {
      setBackendId(backends[0].id);
      setLanguage(backends[0].language ?? "auto");
    }
  }, [backends, backendId]);

  const backend = backends.find((b) => b.id === backendId) ?? backends[0];

  const resetForInputChange = () => {
    runId.current++;
    setResult(null);
    setError(null);
    setBusy(false);
    setCopied(false);
    if (copyTimer.current) {
      window.clearTimeout(copyTimer.current);
      copyTimer.current = undefined;
    }
  };

  const choose = async () => {
    if (picking.current) return;
    picking.current = true;
    let path: string | null;
    try {
      path = await pickAudioFile();
    } catch (e) {
      console.error("pick audio file failed:", e);
      return;
    } finally {
      picking.current = false;
    }
    if (path) {
      resetForInputChange();
      setFilePath(path);
    }
  };

  const clearFile = () => {
    resetForInputChange();
    setFilePath(null);
  };

  const run = async () => {
    if (!filePath || !backend) return;
    const myRun = ++runId.current;
    setBusy(true);
    setError(null);
    setResult(null);
    setCopied(false);
    try {
      const res = await transcribeFile({
        serverUrl: effectiveServerUrl(backend, useApp.getState().settings),
        backendId: backend.id,
        model: backend.model,
        language,
        prompt: backend.prompt || undefined,
        decodeOverrides: backend.decodeOverrides,
        overrideProfile: backend.overrideProfile,
        filePath,
      });
      if (runId.current === myRun) {
        setResult(res);
        setShowFullText(false);
      }
    } catch (e) {
      if (runId.current === myRun) setError(String(e));
    } finally {
      if (runId.current === myRun) setBusy(false);
    }
  };

  const hasSegments = !!(result?.segments && result.segments.length > 0);

  const buildTimestampedText = (): string => {
    if (!result?.segments) return result?.text ?? "";
    return result.segments
      .map((seg) => `[${fmtTimestamp(seg.start)} → ${fmtTimestamp(seg.end)}]  ${seg.text.trim()}`)
      .join("\n");
  };

  const copy = async () => {
    if (!result) return;
    const text = showTimestamps && hasSegments ? buildTimestampedText() : result.text;
    try {
      await navigator.clipboard.writeText(stripControlChars(text));
    } catch (e) {
      console.error("clipboard copy failed:", e);
      return;
    }
    setCopied(true);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  return (
    <div className="mx-auto max-w-[820px] px-10 py-12">
      <PageHeader eyebrow="batch" title="Transcribe a file">
        Send an audio or video file to one of your backends via the batch endpoint.
      </PageHeader>

      {filePath ? (
        <div className="mt-8 grid w-full place-items-center rounded-card border border-dashed border-line-strong bg-surface/60 px-8 py-12">
          <div className="flex items-center gap-3 rounded-xl border border-line bg-surface-2 px-4 py-3">
            {/* Re-choose by clicking the file, remove with the X. Two SIBLING buttons — never a
                button nested in a button (invalid HTML) — so both are valid, focusable, and
                keyboard-operable (native Enter/Space; no manual key handling needed). */}
            <button
              type="button"
              onClick={choose}
              className="ring-signal flex items-center gap-3 rounded-lg text-left"
            >
              <FileAudio className="size-5 text-accent" />
              <span className="max-w-[360px] truncate text-[13px] text-text">{basename(filePath)}</span>
            </button>
            <button
              type="button"
              aria-label="Remove file"
              onClick={clearFile}
              className="ring-signal grid size-6 place-items-center rounded-lg text-faint transition-colors hover:text-rec"
            >
              <X className="size-4" />
            </button>
          </div>
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
          <div className="mt-4 text-[14px] text-text">Choose a file to transcribe</div>
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

      <div className="mt-6 flex items-center gap-3">
        <Button variant="accent" disabled={!filePath || busy || !isTauri} onClick={run}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          {busy ? "Transcribing…" : "Transcribe"}
        </Button>
        {!isTauri && <span className="text-[12px] text-faint">Available in the desktop app.</span>}
      </div>

      {error && (
        <Notice className="mt-6">{error}</Notice>
      )}

      {result && (
        <Card className="mt-6 p-5">
          <div className="mb-3 flex items-center justify-between">
            <div className="font-mono text-[11px] uppercase tracking-label text-faint">
              transcript
              {result.language ? ` · ${result.language}` : ""}
              {result.duration
                ? ` · ${result.duration < 60 ? `${result.duration.toFixed(1)}s` : fmtDuration(result.duration)}`
                : ""}
            </div>
            <div className="flex items-center gap-2">
              {hasSegments && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowTimestamps((v) => !v)}
                  aria-pressed={showTimestamps}
                >
                  <Clock className={`size-4 ${showTimestamps ? "text-accent" : ""}`} />
                  Timestamps
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={copy}>
                {copied ? <Check className="size-4 text-ok" /> : <Copy className="size-4" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>

          {showTimestamps && hasSegments ? (
            <div className="select-text text-[14px] leading-relaxed text-text">
              {result.segments!.map((seg, i) => (
                <div key={i} className="flex gap-3 py-0.5">
                  <span className="shrink-0 font-mono text-[12px] tabular-nums text-faint">
                    {fmtTimestamp(seg.start)}
                  </span>
                  <span className="whitespace-pre-wrap">{stripControlChars(seg.text.trim())}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="select-text whitespace-pre-wrap text-[14px] leading-relaxed text-text">
              {stripControlChars(showFullText ? result.text : result.text.slice(0, TRANSCRIPT_PREVIEW_CHARS))}
            </div>
          )}

          {!showTimestamps && !showFullText && result.text.length > TRANSCRIPT_PREVIEW_CHARS && (
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
