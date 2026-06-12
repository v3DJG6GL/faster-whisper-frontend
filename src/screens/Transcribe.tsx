import { useState, useCallback, type DragEvent } from "react";
import { UploadCloud, FileAudio, X } from "lucide-react";
import { useApp } from "@/lib/store";
import { Button, Card, Select } from "@/components/ui";
import { LANGUAGES } from "@/lib/languages";
import { cn } from "@/lib/cn";

export default function Transcribe() {
  const profiles = useApp((s) => s.profiles);
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? "");
  const [language, setLanguage] = useState("auto");
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);

  const onDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) setFile(f);
  }, []);

  return (
    <div className="mx-auto max-w-[820px] px-10 py-12">
      <div className="font-mono text-[11px] uppercase tracking-label text-accent">batch</div>
      <h1 className="mt-2 font-display text-[30px] font-bold tracking-tight text-text">Transcribe a file</h1>
      <p className="mt-2 max-w-md text-[13.5px] text-dim">
        Drop an audio or video file to transcribe it with one of your servers. Uses the batch endpoint.
      </p>

      <Card
        className={cn(
          "mt-8 grid place-items-center border-dashed px-8 py-14 text-center transition-colors",
          dragging ? "border-accent bg-accent-soft" : "border-line-strong",
        )}
      >
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className="grid w-full place-items-center"
        >
          {file ? (
            <div className="flex items-center gap-3 rounded-xl border border-line bg-surface-2 px-4 py-3">
              <FileAudio className="size-5 text-accent" />
              <span className="max-w-[360px] truncate text-[13px] text-text">{file.name}</span>
              <button onClick={() => setFile(null)} className="ring-signal grid size-6 place-items-center rounded-lg text-faint hover:text-text">
                <X className="size-4" />
              </button>
            </div>
          ) : (
            <>
              <div className="grid size-12 place-items-center rounded-2xl bg-surface-2 text-faint">
                <UploadCloud className="size-6" />
              </div>
              <div className="mt-4 text-[14px] text-text">Drop a file here</div>
              <div className="mt-1 text-[12.5px] text-dim">Audio and video files supported</div>
            </>
          )}
        </div>
      </Card>

      <div className="mt-6 grid grid-cols-2 gap-4">
        <div>
          <label className="mb-2 block text-[12px] font-medium text-dim">Model profile</label>
          <Select
            value={profileId}
            onChange={setProfileId}
            options={profiles.map((p) => ({ value: p.id, label: p.name }))}
          />
        </div>
        <div>
          <label className="mb-2 block text-[12px] font-medium text-dim">Language</label>
          <Select value={language} onChange={setLanguage} options={LANGUAGES} />
        </div>
      </div>

      <div className="mt-6 flex items-center gap-3">
        <Button variant="accent" disabled={!file}>
          Transcribe
        </Button>
        <span className="text-[12px] text-faint">Sends a multipart POST to /v1/audio/transcriptions</span>
      </div>
    </div>
  );
}
