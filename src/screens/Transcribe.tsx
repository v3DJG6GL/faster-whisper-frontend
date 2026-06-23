import { useEffect, useRef, useState } from "react";
import { UploadCloud, FileAudio, X, Loader2, Copy, Check } from "lucide-react";
import { useApp } from "@/lib/store";
import { Button, Card, Notice, PageHeader, Select } from "@/components/ui";
import { LANGUAGES } from "@/lib/languages";
import { pickAudioFile, transcribeFile, isTauri } from "@/lib/api";
import { stripControlChars } from "@/lib/sanitize";
import type { BatchResult } from "@/lib/types";

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export default function Transcribe() {
  const backends = useApp((s) => s.backends);
  const [backendId, setBackendId] = useState(backends[0]?.id ?? "");
  const [language, setLanguage] = useState(backends[0]?.language ?? "auto");
  const [filePath, setFilePath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BatchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Identifies the in-flight transcription. Removing/replacing the file (or a new run) bumps it,
  // so a request that resolves AFTER the user moved on can't strand its (now-stale) result/error
  // against a different/absent file. The file picker + the clear (X) are reachable during a run.
  const runId = useRef(0);
  // The "Copied" confirmation timer. Held in a ref so a rapid second Copy click clears the first
  // timer before re-arming — otherwise the stale timer fires mid-window and flips the label off
  // early (every other transient timer in the app is cleared the same way).
  const copyTimer = useRef<number | undefined>(undefined);

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

  const choose = async () => {
    let path: string | null;
    try {
      path = await pickAudioFile();
    } catch (e) {
      // pickAudioFile dynamic-imports @tauri-apps/plugin-dialog and calls open() — both can reject.
      // Leave the current selection unchanged and don't let it float as an unhandled rejection
      // (mirrors run()'s try/catch and Settings.changeRecDir's .catch). A cancel resolves to null, not a reject.
      console.error("pick audio file failed:", e);
      return;
    }
    if (path) {
      runId.current++; // a changed file abandons any in-flight run for the old file
      setFilePath(path);
      setResult(null);
      setError(null);
      setBusy(false);
    }
  };

  const clearFile = () => {
    runId.current++; // abandon any in-flight run — its result must not land against no file
    setFilePath(null);
    setResult(null);
    setError(null); // clear any stale error Notice from a prior failed run (matches choose())
    setBusy(false);
  };

  const run = async () => {
    if (!filePath || !backend) return;
    const myRun = ++runId.current;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await transcribeFile({
        serverUrl: backend.serverUrl,
        backendId: backend.id,
        model: backend.model,
        language,
        // Empty backend prompt = inherit the server DEFAULT_PROMPT → omit the field.
        prompt: backend.prompt || undefined,
        decodeOverrides: backend.decodeOverrides,
        overrideProfile: backend.overrideProfile,
        filePath,
      });
      // Only commit if this is still the current request — the user may have cleared/changed
      // the file (or started another run) while this one was in flight.
      if (runId.current === myRun) setResult(res);
    } catch (e) {
      if (runId.current === myRun) setError(String(e));
    } finally {
      if (runId.current === myRun) setBusy(false);
    }
  };

  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(stripControlChars(result.text));
    } catch (e) {
      console.error("clipboard copy failed:", e); // don't flash "Copied" if the write failed
      return;
    }
    setCopied(true);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  // Clear a still-pending "Copied" timer if the screen unmounts mid-window.
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
            value={backendId}
            onChange={(v) => {
              setBackendId(v);
              const b = backends.find((x) => x.id === v);
              if (b) setLanguage(b.language ?? "auto");
            }}
            options={backends.map((b) => ({ value: b.id, label: b.name }))}
          />
        </div>
        <div>
          <label className="mb-2 block text-[12px] font-medium text-dim">Language</label>
          <Select value={language} onChange={setLanguage} options={LANGUAGES} />
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
              {result.duration ? ` · ${result.duration.toFixed(1)}s` : ""}
            </div>
            <Button variant="ghost" size="sm" onClick={copy}>
              {copied ? <Check className="size-4 text-ok" /> : <Copy className="size-4" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <div className="select-text whitespace-pre-wrap text-[14px] leading-relaxed text-text">{result.text}</div>
        </Card>
      )}

      {result?.overridesIgnored && result.overridesIgnored.length > 0 && (
        <Notice className="mt-3">
          The server ignored {result.overridesIgnored.length} override
          {result.overridesIgnored.length === 1 ? "" : "s"} (locked by the server admin):{" "}
          <span className="font-mono text-[12px]">{result.overridesIgnored.join(", ")}</span>.
        </Notice>
      )}
    </div>
  );
}
