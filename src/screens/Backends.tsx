import { useEffect, useRef, useState } from "react";
import { Server, Pencil, Copy, Trash2, Plug, Loader2 } from "lucide-react";
import { useApp } from "@/lib/store";
import { Badge, Button, Card, DisclosureToggle, Labeled, ListScreenHeader, Notice, Segmented, SectionLabel, Select, StatusDot, TextInput } from "@/components/ui";
import { DecodeFields } from "@/components/DecodeFields";
import { OverrideProfilePicker } from "@/components/OverrideProfilePicker";
import { ReorderControls } from "@/components/ReorderControls";
import { LANGUAGES, languageLabel } from "@/lib/languages";
import { testConnection, setBackendKey, deleteBackendKey } from "@/lib/api";
import type { Backend, ConnectionInfo } from "@/lib/types";
import { classifyConnection, effectiveServerKind } from "@/lib/serverKind";
import { effectiveServerUrl } from "@/lib/backends";
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

function Editor({
  initial,
  onSave,
  onCancel,
}: {
  initial: Backend;
  onSave: (b: Backend) => void;
  onCancel: () => void;
}) {
  const setConnection = useApp((s) => s.setConnection);
  const syncEnabled = useApp((s) => s.settings.sync?.enabled ?? false);
  const urlOverride = useApp((s) => s.settings.sync?.urlOverrides?.[initial.id] ?? "");
  const setUrlOverride = useApp((s) => s.setUrlOverride);
  const [b, setB] = useState<Backend>(initial);
  const [key, setKey] = useState("");
  // Debounce the typed key AND the server URL before they drive the best-effort capability /
  // override-profile lookups, so typing either field doesn't fire a burst of requests on every
  // keystroke (the URL drives two lookups — getCapabilities + listOverrideProfiles — per char).
  const [debouncedKey, setDebouncedKey] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedKey(key), 400);
    return () => clearTimeout(t);
  }, [key]);
  const [debouncedUrl, setDebouncedUrl] = useState(initial.serverUrl);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedUrl(b.serverUrl), 400);
    return () => clearTimeout(t);
  }, [b.serverUrl]);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ConnectionInfo | null>(null);
  // Drop a connection-test result once the tested target changes (URL or key edited): the in-flight
  // liveTarget guard only stops a result that RESOLVES after the edit — one that already committed
  // would keep showing the OLD server's classification / models / "Connected" under the new URL.
  // On mount result is already null, so this is a no-op there.
  useEffect(() => setResult(null), [b.serverUrl, key]);
  // Saving the API key to the OS keyring can fail (locked/absent Secret Service). Track it so we
  // keep the editor open with an error instead of persisting a backend whose "key" badge claims a
  // key that was never stored.
  const [savingKey, setSavingKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
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
    serverUrl: debouncedUrl,
    backendId: b.id,
    apiKey: debouncedKey || null,
    profileName: b.overrideProfile,
    serverKind: kind,
  });

  // The Server URL / API-key fields stay editable during an in-flight test (only the Test button
  // is disabled), so a result that resolves after the user edits them describes a server they've
  // already moved off. Track the live target and only commit a test whose URL+key still match
  // (mirrors Transcribe's runId guard); else effectiveServerKind / the status dot / the decode gate
  // would cache the old server's classification under this backend id.
  const liveTarget = useRef({ url: b.serverUrl, key });
  liveTarget.current = { url: b.serverUrl, key };

  const runTest = async () => {
    const testedUrl = b.serverUrl;
    const testedKey = key;
    setTesting(true);
    try {
      const info = await testConnection({
        serverUrl: testedUrl,
        backendId: b.id,
        apiKey: testedKey || null,
      });
      if (liveTarget.current.url === testedUrl && liveTarget.current.key === testedKey) {
        setResult(info);
        setConnection(b.id, info);
      }
    } finally {
      setTesting(false);
    }
  };

  // Write the API key to the keyring FIRST (awaited) and only commit + close on success, so a
  // keyring failure can't persist a backend whose "key" badge claims a key that isn't stored.
  const doSave = async () => {
    setKeyError(null);
    if (key) {
      setSavingKey(true);
      try {
        await setBackendKey(b.id, key);
      } catch (e) {
        console.error("saving API key failed:", e);
        setKeyError("Couldn't save the API key to the system keyring — the key was not stored. Try again.");
        return;
      } finally {
        setSavingKey(false);
      }
    }
    // Normalize on save (mirrors Profiles.save): trim the URL/model, default an empty name, and trim
    // the override-profile name → undefined when blank — so stray whitespace isn't persisted, sent to
    // the server (a padded value never matches a real profile), or shown as a blank card.
    onSave({
      ...b,
      name: b.name.trim() || "Untitled backend",
      serverUrl: b.serverUrl.trim(),
      model: b.model.trim(),
      overrideProfile: b.overrideProfile?.trim() ? b.overrideProfile.trim() : undefined,
    });
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
        {/* Per-device address override: connects THIS machine somewhere else while
            the canonical URL above stays shared through settings sync (classic
            case: localhost on the box running the server, a LAN IP elsewhere).
            Applied live via the store (it's device state, not part of the Backend
            being edited); grayed out (never hidden) while sync is off, where the
            canonical URL is already local-only. */}
        <Labeled label="Address on this device (optional)">
          <TextInput
            value={urlOverride}
            disabled={!syncEnabled}
            onChange={(e) => setUrlOverride(b.id, e.target.value)}
            placeholder={syncEnabled ? "override the synced URL here only" : "used with settings sync"}
          />
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
                  faster-whisper-backend
                  {/* Older builds identify via boot_id but don't report a version yet. */}
                  {result?.serverVersion && (
                    <span className="text-faint"> · {result.serverVersion}</span>
                  )}
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
        <Notice className="mt-3">
          A standard Whisper server has no streaming endpoint — switch Endpoint to{" "}
          <span className="font-medium">Batch</span>.
        </Notice>
      )}

      {result?.ok && result.models.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 text-[12px] font-medium text-dim">Models on this server — click to use</div>
          <div className="flex flex-wrap gap-2">
            {result.models.map((m) => (
              <button
                key={m.id}
                type="button"
                aria-pressed={b.model === m.id}
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
        <DisclosureToggle open={showDecode} onToggle={() => setShowDecode((v) => !v)}>
          Decode defaults
          {b.decodeOverrides && Object.keys(b.decodeOverrides).length ? (
            <span className="text-accent">· set</span>
          ) : (
            <span className="text-faint">· inherit server</span>
          )}
        </DisclosureToggle>
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
          serverUrl={debouncedUrl}
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

      {keyError && (
        <Notice className="mt-4">{keyError}</Notice>
      )}

      <div className="mt-6 flex items-center justify-between">
        <Button variant="ghost" onClick={onCancel} disabled={savingKey}>
          Cancel
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="default" onClick={runTest} disabled={testing}>
            {testing ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
            Test connection
          </Button>
          <Button variant="accent" onClick={() => void doSave()} disabled={savingKey}>
            Save backend
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ConnResult({ info }: { info: ConnectionInfo }) {
  return (
    <Notice tone={info.ok ? "ok" : "warn"} className="mt-4">
      {info.ok ? (
        <>
          Connected — {info.models.length} model{info.models.length === 1 ? "" : "s"}
          {info.openMode ? " · open mode (no auth)" : info.username ? ` · ${info.username}` : ""}.
        </>
      ) : (
        info.error
      )}
    </Notice>
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
      const info = await testConnection({
        serverUrl: effectiveServerUrl(b, useApp.getState().settings),
        backendId: b.id,
      });
      // Mirror the editor's liveTarget guard (+ upsertBackend's connection invalidation): a slow/
      // unreachable test can resolve AFTER the user edits this backend's URL/key (which drops the
      // stale connection) or removes it. Only commit if the backend still exists with the same target,
      // else we'd re-cache the OLD server's classification under this id (effectiveServerKind / status
      // dot / decode gate) or re-add a dangling connection for a removed backend.
      const cur = useApp.getState().backends.find((x) => x.id === b.id);
      if (cur && cur.serverUrl === b.serverUrl && cur.hasApiKey === b.hasApiKey) {
        setConnection(b.id, info);
      }
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
    void deleteBackendKey(id).catch((e) => console.error("delete backend key failed:", e));
  };

  const handleSave = (b: Backend) => {
    upsertBackend(b);
    setEditing(null);
  };

  return (
    <div className="mx-auto max-w-[820px] px-10 py-12">
      <ListScreenHeader
        eyebrow="backends"
        title="Backends"
        showAdd={!editing}
        addLabel="Add backend"
        onAdd={() => setEditing(blankBackend())}
      >
        A backend is a connection to a transcription server, with its own model, default
        language, and endpoint. Profiles point at one.
      </ListScreenHeader>

      {editing ? (
        <div className="mt-8">
          <Editor initial={editing} onCancel={() => setEditing(null)} onSave={handleSave} />
        </div>
      ) : (
        <>
          <SectionLabel className="mb-3 mt-8">Configured</SectionLabel>
          {backends.length === 0 ? (
            <Card className="p-8 text-center text-[13.5px] text-dim">
              No backends yet. Add one to point the app at a faster-whisper server.
            </Card>
          ) : (
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
                    <StatusDot tone={testing.has(b.id) ? "idle" : conn?.ok ? "ok" : conn?.error ? "warn" : "idle"} />
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
          )}
        </>
      )}
    </div>
  );
}
