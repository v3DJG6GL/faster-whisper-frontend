import { useState, type ReactNode } from "react";
import { Plus, Server, Pencil, Trash2, Plug, Loader2, Check, AlertTriangle } from "lucide-react";
import { useApp } from "@/lib/store";
import { Button, Card, Segmented, SectionLabel, Select, StatusDot, TextInput } from "@/components/ui";
import { LANGUAGES, languageLabel } from "@/lib/languages";
import { testConnection, setProfileKey, deleteProfileKey } from "@/lib/api";
import type { ConnectionInfo, ModelProfile } from "@/lib/types";
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

function Labeled({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label className="mb-2 block text-[12px] font-medium text-dim">{label}</label>
      {children}
    </div>
  );
}

function Editor({
  initial,
  onSave,
  onCancel,
}: {
  initial: ModelProfile;
  onSave: (p: ModelProfile, typedKey: string) => void;
  onCancel: () => void;
}) {
  const setConnection = useApp((s) => s.setConnection);
  const [p, setP] = useState<ModelProfile>(initial);
  const [key, setKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ConnectionInfo | null>(null);
  const set = (patch: Partial<ModelProfile>) => setP((x) => ({ ...x, ...patch }));

  const runTest = async () => {
    setTesting(true);
    try {
      const info = await testConnection({
        serverUrl: p.serverUrl,
        profileId: p.id,
        apiKey: key || null,
      });
      setResult(info);
      setConnection(p.id, info);
    } finally {
      setTesting(false);
    }
  };

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
              set({ hasApiKey: e.target.value.length > 0 || initial.hasApiKey });
            }}
            placeholder={initial.hasApiKey ? "•••••••••• (stored — leave blank to keep)" : "wk_…"}
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

      {result?.ok && result.models.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 text-[12px] font-medium text-dim">Models on this server — click to use</div>
          <div className="flex flex-wrap gap-2">
            {result.models.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => set({ model: m.id })}
                className={cn(
                  "ring-signal rounded-pill border px-3 py-1 font-mono text-[12px] transition-colors",
                  p.model === m.id
                    ? "border-accent bg-accent-soft text-accent"
                    : "border-line bg-surface-2 text-dim hover:text-text",
                )}
              >
                {m.id}
                {m.loaded && <span className="ml-1.5 text-ok">●</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      <Labeled label="Vocabulary / prompt (optional)" className="mt-4">
        <textarea
          value={p.prompt}
          onChange={(e) => set({ prompt: e.target.value })}
          rows={2}
          placeholder="Bias terms — names, jargon…"
          className="ring-signal w-full resize-none rounded-xl border border-line bg-surface-2 px-3.5 py-2.5 text-[13px] text-text placeholder:text-faint"
        />
      </Labeled>

      {result && <ConnResult info={result} />}

      <div className="mt-6 flex items-center justify-between">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="default" onClick={runTest} disabled={testing}>
            {testing ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
            Test connection
          </Button>
          <Button variant="accent" onClick={() => onSave(p, key)}>
            Save profile
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ConnResult({ info }: { info: ConnectionInfo }) {
  return (
    <div
      className={cn(
        "mt-4 flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-[12.5px]",
        info.ok ? "border-ok/30 bg-ok/5 text-ok" : "border-warn/30 bg-warn/5 text-warn",
      )}
    >
      {info.ok ? <Check className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" />}
      <div>
        {info.ok ? (
          <>
            Connected — {info.models.length} model{info.models.length === 1 ? "" : "s"}
            {info.openMode ? " · open mode (no auth)" : info.username ? ` · ${info.username}` : ""}.
          </>
        ) : (
          info.error
        )}
      </div>
    </div>
  );
}

export default function SpeechModels() {
  const profiles = useApp((s) => s.profiles);
  const connections = useApp((s) => s.connections);
  const upsertProfile = useApp((s) => s.upsertProfile);
  const removeProfile = useApp((s) => s.removeProfile);
  const setConnection = useApp((s) => s.setConnection);
  const [editing, setEditing] = useState<ModelProfile | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  const handleTest = async (p: ModelProfile) => {
    setTestingId(p.id);
    try {
      const info = await testConnection({ serverUrl: p.serverUrl, profileId: p.id });
      setConnection(p.id, info);
    } finally {
      setTestingId(null);
    }
  };

  const handleRemove = (id: string) => {
    removeProfile(id);
    void deleteProfileKey(id);
  };

  const handleSave = (p: ModelProfile, typedKey: string) => {
    upsertProfile(p);
    if (typedKey) void setProfileKey(p.id, typedKey);
    setEditing(null);
  };

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
          <Editor initial={editing} onCancel={() => setEditing(null)} onSave={handleSave} />
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
                      {p.hasApiKey && <Badge>key</Badge>}
                    </div>
                    <div className="mt-1 flex items-center gap-2 font-mono text-[12px] text-dim">
                      <span className="truncate">{p.serverUrl}</span>
                      <span className="text-faint">·</span>
                      <span className="text-faint">{p.model}</span>
                    </div>
                  </div>
                  <div className="flex w-24 items-center justify-end gap-1.5 text-[12px] text-dim" title={conn?.error}>
                    <StatusDot tone={conn?.ok ? "ok" : conn?.error ? "warn" : "idle"} />
                    {testingId === p.id ? "testing…" : conn?.ok ? "connected" : conn?.error ? "error" : "untested"}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="sm" title="Test connection" onClick={() => handleTest(p)} disabled={testingId === p.id}>
                      {testingId === p.id ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
                    </Button>
                    <Button variant="ghost" size="sm" title="Edit" onClick={() => setEditing(p)}>
                      <Pencil className="size-4" />
                    </Button>
                    <Button variant="ghost" size="sm" title="Remove" onClick={() => handleRemove(p.id)}>
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
