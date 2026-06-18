import { useEffect, useState, type ReactNode } from "react";
import { Plus, Server, Pencil, Copy, Trash2, Plug, Loader2, Check, AlertTriangle } from "lucide-react";
import { useApp } from "@/lib/store";
import { Button, Card, Labeled, Segmented, SectionLabel, Select, StatusDot, TextInput } from "@/components/ui";
import { DecodeFields } from "@/components/DecodeFields";
import { OverrideProfilePicker } from "@/components/OverrideProfilePicker";
import { ReorderControls } from "@/components/ReorderControls";
import { LANGUAGES, languageLabel } from "@/lib/languages";
import { testConnection, setBackendKey, deleteBackendKey } from "@/lib/api";
import type { Backend, ConnectionInfo } from "@/lib/types";
import { classifyConnection, effectiveServerKind } from "@/lib/serverKind";
import { useOverrideContext } from "@/lib/useOverrideContext";
import { cn } from "@/lib/cn";

function blankBackend(): Backend {
  return {
    id: crypto.randomUUID(),
    name: "New backend",
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

function Editor({
  initial,
  onSave,
  onCancel,
}: {
  initial: Backend;
  onSave: (b: Backend, typedKey: string) => void;
  onCancel: () => void;
}) {
  const setConnection = useApp((s) => s.setConnection);
  const [b, setB] = useState<Backend>(initial);
  const [key, setKey] = useState("");
  // Debounce the typed key before it drives the best-effort capability / override-profile
  // lookups, so typing an API key doesn't fire a burst of requests on every keystroke.
  const [debouncedKey, setDebouncedKey] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedKey(key), 400);
    return () => clearTimeout(t);
  }, [key]);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ConnectionInfo | null>(null);
  const [showDecode, setShowDecode] = useState(
    () => !!initial.decodeOverrides && Object.keys(initial.decodeOverrides).length > 0,
  );
  const set = (patch: Partial<Backend>) => setB((x) => ({ ...x, ...patch }));
  // `detected` = what the last connection test inferred; `kind` = the effective
  // classification (a manual override wins). `kind` gates the decode-override editor.
  const detected = classifyConnection(result);
  const kind = effectiveServerKind(b, result);
  // Caller capabilities + the selected override-profile's resolved values, for
  // gating the decode editor and ghosting its inherited defaults.
  const { caps, resolved, resolvedPrompt } = useOverrideContext({
    serverUrl: b.serverUrl,
    backendId: b.id,
    apiKey: debouncedKey || null,
    profileName: b.overrideProfile,
    serverKind: kind,
  });

  const runTest = async () => {
    setTesting(true);
    try {
      const info = await testConnection({
        serverUrl: b.serverUrl,
        backendId: b.id,
        apiKey: key || null,
      });
      setResult(info);
      setConnection(b.id, info);
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card className="p-6">
      <div className="flex items-center gap-2 text-text">
        <Server className="size-[18px] text-accent" />
        <span className="text-[14px] font-semibold">Backend</span>
        <span className="text-[12px] text-dim">· faster-whisper / OpenAI-compatible</span>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-4">
        <Labeled label="Name">
          <TextInput value={b.name} onChange={(e) => set({ name: e.target.value })} placeholder="My backend" />
        </Labeled>
        <Labeled label="Server URL">
          <TextInput value={b.serverUrl} onChange={(e) => set({ serverUrl: e.target.value })} placeholder="http://host:8000" />
        </Labeled>
        <Labeled label="Model">
          <TextInput value={b.model} onChange={(e) => set({ model: e.target.value })} placeholder="whisper-1 / large-v3" />
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
        <Labeled label="Default language">
          <Select value={b.language} onChange={(v) => set({ language: v })} options={LANGUAGES} />
        </Labeled>
        <Labeled label="Endpoint">
          <Segmented
            value={b.endpoint}
            onChange={(v) => set({ endpoint: v })}
            options={[
              { value: "stream", label: "Streaming" },
              { value: "batch", label: "Batch" },
            ]}
          />
        </Labeled>
        <Labeled label="Server type">
          <Segmented
            value={b.kind ?? "auto"}
            onChange={(v) => set({ kind: v === "auto" ? undefined : v })}
            options={[
              { value: "auto", label: "Auto" },
              { value: "full", label: "Full" },
              { value: "standard", label: "Standard" },
            ]}
          />
        </Labeled>
        <Labeled label="Detected">
          <div className="flex h-10 items-center gap-2 text-[12.5px]">
            {detected === "unknown" ? (
              <span className="text-faint">Test the connection to detect</span>
            ) : detected === "full" ? (
              <>
                <StatusDot tone="ok" />
                <span className="text-dim">
                  faster-whisper <span className="text-faint">· boot id</span>
                </span>
              </>
            ) : (
              <>
                <StatusDot tone="warn" />
                <span className="text-dim">Standard Whisper server</span>
              </>
            )}
            {b.kind && b.kind !== "auto" && <span className="text-faint">· manual</span>}
          </div>
        </Labeled>
      </div>

      {kind === "standard" && b.endpoint === "stream" && (
        <div className="mt-3 flex items-start gap-2 rounded-xl border border-warn/30 bg-warn/5 px-3.5 py-2.5 text-[12.5px] text-warn">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            A standard Whisper server has no streaming endpoint — switch Endpoint to{" "}
            <span className="font-medium">Batch</span>.
          </div>
        </div>
      )}

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
                  b.model === m.id
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

      <Labeled label="Default vocabulary / prompt (optional)" className="mt-4">
        <textarea
          value={b.prompt}
          onChange={(e) => set({ prompt: e.target.value })}
          rows={2}
          // Ghost the selected server override-profile's DEFAULT_PROMPT as the
          // inherited baseline; empty here means "inherit the server prompt".
          placeholder={resolvedPrompt || "Bias terms — names, jargon…"}
          className="ring-signal w-full resize-none rounded-xl border border-line bg-surface-2 px-3.5 py-2.5 text-[13px] text-text placeholder:text-faint"
        />
      </Labeled>

      <div className="mt-5">
        <button
          type="button"
          onClick={() => setShowDecode((v) => !v)}
          className="ring-signal inline-flex items-center gap-1.5 rounded-lg text-[12.5px] font-medium text-dim hover:text-text"
        >
          <span className={cn("transition-transform", showDecode && "rotate-90")}>›</span>
          Decode defaults
          {b.decodeOverrides && Object.keys(b.decodeOverrides).length ? (
            <span className="text-accent">· set</span>
          ) : (
            <span className="text-faint">· inherit server</span>
          )}
        </button>
        {showDecode && (
          <div className="mt-3 rounded-xl border border-line bg-surface-2/40 p-4">
            <p className="mb-3 text-[12px] text-dim">
              Defaults for every profile that uses this backend (a profile can still
              override per field). Empty = the server&apos;s per-model config.
            </p>
            <DecodeFields
              value={b.decodeOverrides ?? {}}
              onChange={(v) => set({ decodeOverrides: Object.keys(v).length ? v : undefined })}
              inherited={resolved}
              serverKind={kind}
              canCustomize={caps?.can_request_decode_overrides}
            />
          </div>
        )}
      </div>

      <Labeled label="Server override profile" className="mt-5">
        <OverrideProfilePicker
          serverUrl={b.serverUrl}
          backendId={b.id}
          apiKey={debouncedKey || null}
          serverKind={kind}
          canRequest={caps?.can_request_override_profile}
          value={b.overrideProfile ?? ""}
          inheritLabel="Server default"
          onChange={(v) => set({ overrideProfile: v.trim() ? v : undefined })}
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
          <Button variant="accent" onClick={() => onSave(b, key)}>
            Save backend
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

export default function Backends() {
  const backends = useApp((s) => s.backends);
  const connections = useApp((s) => s.connections);
  const upsertBackend = useApp((s) => s.upsertBackend);
  const removeBackend = useApp((s) => s.removeBackend);
  const duplicateBackend = useApp((s) => s.duplicateBackend);
  const moveBackend = useApp((s) => s.moveBackend);
  const setConnection = useApp((s) => s.setConnection);
  const [editing, setEditing] = useState<Backend | null>(null);
  // Set of backend ids whose connection test is in flight. A Set (not a single id) so two
  // concurrent tests track independently — finishing one can't clear another's spinner, and
  // its late result can't be misattributed.
  const [testing, setTesting] = useState<ReadonlySet<string>>(new Set());

  const handleTest = async (b: Backend) => {
    setTesting((s) => new Set(s).add(b.id));
    try {
      const info = await testConnection({ serverUrl: b.serverUrl, backendId: b.id });
      setConnection(b.id, info);
    } finally {
      setTesting((s) => {
        const next = new Set(s);
        next.delete(b.id);
        return next;
      });
    }
  };

  const handleRemove = (id: string) => {
    removeBackend(id);
    void deleteBackendKey(id);
  };

  const handleSave = (b: Backend, typedKey: string) => {
    upsertBackend(b);
    if (typedKey) void setBackendKey(b.id, typedKey);
    setEditing(null);
  };

  return (
    <div className="mx-auto max-w-[820px] px-10 py-12">
      <div className="flex items-end justify-between">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-label text-accent">backends</div>
          <h1 className="mt-2 font-display text-[30px] font-bold tracking-tight text-text">Backends</h1>
          <p className="mt-2 max-w-md text-[13.5px] text-dim">
            A backend is a connection to a transcription server, with its own model, default
            language, and endpoint. Profiles point at one.
          </p>
        </div>
        {!editing && (
          <Button variant="accent" onClick={() => setEditing(blankBackend())}>
            <Plus className="size-4" /> Add backend
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
            {backends.map((b, i) => {
              const conn = connections[b.id];
              return (
                <Card key={b.id} className="flex items-center gap-4 p-5">
                  <ReorderControls
                    canUp={i > 0}
                    canDown={i < backends.length - 1}
                    onUp={() => moveBackend(b.id, "up")}
                    onDown={() => moveBackend(b.id, "down")}
                  />
                  <div className="grid size-10 place-items-center rounded-xl bg-surface-2 text-accent">
                    <Server className="size-[18px]" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[14px] font-semibold text-text">{b.name}</span>
                      <Badge tone="accent">{b.endpoint}</Badge>
                      <Badge>{languageLabel(b.language)}</Badge>
                      {b.hasApiKey && <Badge>key</Badge>}
                    </div>
                    <div className="mt-1 flex items-center gap-2 font-mono text-[12px] text-dim">
                      <span className="truncate">{b.serverUrl}</span>
                      <span className="text-faint">·</span>
                      <span className="text-faint">{b.model}</span>
                    </div>
                  </div>
                  <div className="flex w-24 items-center justify-end gap-1.5 text-[12px] text-dim" title={conn?.error}>
                    <StatusDot tone={conn?.ok ? "ok" : conn?.error ? "warn" : "idle"} />
                    {testing.has(b.id) ? "testing…" : conn?.ok ? "connected" : conn?.error ? "error" : "untested"}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="sm" title="Test connection" onClick={() => handleTest(b)} disabled={testing.has(b.id)}>
                      {testing.has(b.id) ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
                    </Button>
                    <Button variant="ghost" size="sm" title="Edit" onClick={() => setEditing(b)}>
                      <Pencil className="size-4" />
                    </Button>
                    <Button variant="ghost" size="sm" title="Duplicate" onClick={() => duplicateBackend(b.id)}>
                      <Copy className="size-4" />
                    </Button>
                    <Button variant="ghost" size="sm" title="Remove" onClick={() => handleRemove(b.id)}>
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
