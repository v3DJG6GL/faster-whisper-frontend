import { useState, type ReactNode } from "react";
import { Plus, Server, Pencil, Trash2, Plug } from "lucide-react";
import { useApp } from "@/lib/store";
import { Button, Card, Segmented, SectionLabel, Select, StatusDot, TextInput } from "@/components/ui";
import { LANGUAGES, languageLabel } from "@/lib/languages";
import type { ModelProfile } from "@/lib/types";
import { cn } from "@/lib/cn";

function blankProfile(): ModelProfile {
  return {
    id: crypto.randomUUID(),
    name: "New server",
    serverUrl: "http://localhost:8000",
    hasApiKey: false,
    model: "whisper-1",
    endpoint: "stream",
    language: "auto",
    prompt: "",
    responseFormat: "verbose_json",
  };
}

function Badge({ children, tone }: { children: ReactNode; tone?: "accent" | "dim" }) {
  return (
    <span
      className={cn(
        "rounded-md px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-wider",
        tone === "accent" ? "bg-accent-soft text-accent" : "bg-surface-2 text-dim",
      )}
    >
      {children}
    </span>
  );
}

function Editor({ initial, onSave, onCancel }: { initial: ModelProfile; onSave: (p: ModelProfile) => void; onCancel: () => void }) {
  const [p, setP] = useState<ModelProfile>(initial);
  const [key, setKey] = useState("");
  const set = (patch: Partial<ModelProfile>) => setP((x) => ({ ...x, ...patch }));

  return (
    <Card className="p-6">
      <div className="flex items-center gap-2 text-text">
        <Server className="size-[18px] text-accent" />
        <span className="text-[14px] font-semibold">Server profile</span>
        <span className="text-[12px] text-dim">· faster-whisper / OpenAI-compatible</span>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-4">
        <Labeled label="Name">
          <TextInput value={p.name} onChange={(e) => set({ name: e.target.value })} placeholder="My server" />
        </Labeled>
        <Labeled label="Server URL">
          <TextInput value={p.serverUrl} onChange={(e) => set({ serverUrl: e.target.value })} placeholder="http://host:8000" />
        </Labeled>
        <Labeled label="Model">
          <TextInput value={p.model} onChange={(e) => set({ model: e.target.value })} placeholder="whisper-1 / large-v3" />
        </Labeled>
        <Labeled label="API key (optional)">
          <TextInput
            type="password"
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              set({ hasApiKey: e.target.value.length > 0 });
            }}
            placeholder={p.hasApiKey ? "•••••••••• (stored)" : "wk_…"}
          />
        </Labeled>
        <Labeled label="Language">
          <Select value={p.language} onChange={(v) => set({ language: v })} options={LANGUAGES} />
        </Labeled>
        <Labeled label="Endpoint">
          <Segmented
            value={p.endpoint}
            onChange={(v) => set({ endpoint: v })}
            options={[
              { value: "stream", label: "Streaming" },
              { value: "batch", label: "Batch" },
            ]}
          />
        </Labeled>
      </div>

      <Labeled label="Vocabulary / prompt (optional)" className="mt-4">
        <textarea
          value={p.prompt}
          onChange={(e) => set({ prompt: e.target.value })}
          rows={2}
          placeholder="Bias terms — names, jargon…"
          className="ring-signal w-full resize-none rounded-xl border border-line bg-surface-2 px-3.5 py-2.5 text-[13px] text-text placeholder:text-faint"
        />
      </Labeled>

      <div className="mt-6 flex items-center justify-between">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="accent" onClick={() => onSave(p)}>
          Save profile
        </Button>
      </div>
    </Card>
  );
}

function Labeled({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label className="mb-2 block text-[12px] font-medium text-dim">{label}</label>
      {children}
    </div>
  );
}

export default function SpeechModels() {
  const profiles = useApp((s) => s.profiles);
  const connections = useApp((s) => s.connections);
  const upsertProfile = useApp((s) => s.upsertProfile);
  const removeProfile = useApp((s) => s.removeProfile);
  const [editing, setEditing] = useState<ModelProfile | null>(null);

  return (
    <div className="mx-auto max-w-[820px] px-10 py-12">
      <div className="flex items-end justify-between">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-label text-accent">servers</div>
          <h1 className="mt-2 font-display text-[30px] font-bold tracking-tight text-text">Servers</h1>
          <p className="mt-2 max-w-md text-[13.5px] text-dim">
            Each profile points at a transcription server and carries its own model, language, and endpoint.
          </p>
        </div>
        {!editing && (
          <Button variant="accent" onClick={() => setEditing(blankProfile())}>
            <Plus className="size-4" /> Add profile
          </Button>
        )}
      </div>

      {editing ? (
        <div className="mt-8">
          <Editor
            initial={editing}
            onCancel={() => setEditing(null)}
            onSave={(p) => {
              upsertProfile(p);
              setEditing(null);
            }}
          />
        </div>
      ) : (
        <>
          <SectionLabel className="mb-3 mt-8">Configured</SectionLabel>
          <div className="flex flex-col gap-3">
            {profiles.map((p) => {
              const conn = connections[p.id];
              return (
                <Card key={p.id} className="flex items-center gap-4 p-5">
                  <div className="grid size-10 place-items-center rounded-xl bg-surface-2 text-accent">
                    <Server className="size-[18px]" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[14px] font-semibold text-text">{p.name}</span>
                      <Badge tone="accent">{p.endpoint}</Badge>
                      <Badge>{languageLabel(p.language)}</Badge>
                    </div>
                    <div className="mt-1 flex items-center gap-2 font-mono text-[12px] text-dim">
                      <span className="truncate">{p.serverUrl}</span>
                      <span className="text-faint">·</span>
                      <span className="text-faint">{p.model}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 text-[12px] text-dim">
                    <StatusDot tone={conn?.ok ? "ok" : conn?.error ? "warn" : "idle"} />
                    {conn?.ok ? "connected" : conn?.error ? "error" : "untested"}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="sm" title="Test connection">
                      <Plug className="size-4" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setEditing(p)}>
                      <Pencil className="size-4" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => removeProfile(p.id)}>
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </Card>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
