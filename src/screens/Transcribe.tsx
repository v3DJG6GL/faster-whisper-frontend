import { useEffect, useState } from "react";
import { UploadCloud, FileAudio, X, Loader2, Copy, Check } from "lucide-react";
import { useApp } from "@/lib/store";
import { Button, Card, Notice, PageHeader, Select } from "@/components/ui";
import { LANGUAGES } from "@/lib/languages";
import { pickAudioFile, transcribeFile, isTauri } from "@/lib/api";
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
    const path = await pickAudioFile();
    if (path) {
      setFilePath(path);
      setResult(null);
      setError(null);
    }
  };

  const clearFile = () => {
    setFilePath(null);
    setResult(null);
  };

  const run = async () => {
    if (!filePath || !backend) return;
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
      setResult(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.text);
    } catch (e) {
      console.error("clipboard copy failed:", e); // don't flash "Copied" if the write failed
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="mx-auto max-w-[820px] px-10 py-12">
      <PageHeader eyebrow="batch" title="Transcribe a file">
        Send an audio or video file to one of your backends via the batch endpoint.
      </PageHeader>

      <button
        type="button"
        onClick={choose}
        className="ring-signal mt-8 grid w-full place-items-center rounded-card border border-dashed border-line-strong bg-surface/60 px-8 py-12 text-center transition-colors hover:border-faint"
      >
        {filePath ? (
          <div className="flex items-center gap-3 rounded-xl border border-line bg-surface-2 px-4 py-3">
            <FileAudio className="size-5 text-accent" />
            <span className="max-w-[360px] truncate text-[13px] text-text">{basename(filePath)}</span>
            <span
              role="button"
              tabIndex={0}
              aria-label="Remove file"
              onClick={(e) => {
                e.stopPropagation();
                clearFile();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  clearFile();
                }
              }}
              className="grid size-6 place-items-center rounded-lg text-faint hover:text-rec"
            >
              <X className="size-4" />
            </span>
          </div>
        ) : (
          <>
            <div className="grid size-12 place-items-center rounded-2xl bg-surface-2 text-faint">
              <UploadCloud className="size-6" />
            </div>
            <div className="mt-4 text-[14px] text-text">Choose a file to transcribe</div>
            <div className="mt-1 text-[12.5px] text-dim">Audio or video — wav, mp3, m4a, ogg, webm, flac…</div>
          </>
        )}
      </button>

      <div className="mt-6 grid grid-cols-2 gap-4">
        <div>
          <label className="mb-2 block text-[12px] font-medium text-dim">Backend</label>
          <Select
            value={backendId}
            onChange={(v) => {
              setBackendId(v);
              const b = backends.find((x) => x.id === v);
              if (b) setLanguage(b.language);
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
