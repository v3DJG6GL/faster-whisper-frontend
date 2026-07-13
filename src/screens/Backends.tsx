import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Server, Pencil, Copy, Trash2, Plug, Loader2 } from "lucide-react";
import { useApp } from "@/lib/store";
import { Badge, Button, Card, DisclosureToggle, Labeled, ListScreenHeader, Notice, Segmented, SectionLabel, Select, StatusDot, TextInput } from "@/components/ui";
import { DecodeFields } from "@/components/DecodeFields";
import { OverrideProfilePicker } from "@/components/OverrideProfilePicker";
import { ReorderControls } from "@/components/ReorderControls";
import { LANGUAGES, languageLabel } from "@/lib/languages";
import { testConnection, setBackendKey, deleteBackendKey, syncPull } from "@/lib/api";
import type { Backend, ConnectionInfo } from "@/lib/types";
import type { SyncRemoteState } from "@/lib/syncTypes";
import { ALL_CATEGORIES } from "@/lib/sync";
import { classifyConnection, effectiveServerKind } from "@/lib/serverKind";
import { effectiveServerUrl, nameFromUrl, normalizeUrl } from "@/lib/backends";
import { useOverrideContext } from "@/lib/useOverrideContext";
import { RestoreFromServer, relTime } from "./SettingsSync";
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
  initialKey,
  initialResult,
  onSave,
  onCancel,
}: {
  initial: Backend;
  /** Connect-first add: the API key typed in the connect step, carried in so
   *  the editor's Save stores it (and the capability lookups use it). */
  initialKey?: string;
  /** Connect-first add: the connect step's still-current test result, shown as
   *  if the user had just pressed "Test connection". */
  initialResult?: ConnectionInfo | null;
  onSave: (b: Backend) => void;
  onCancel: () => void;
}) {
  const setConnection = useApp((s) => s.setConnection);
  const syncEnabled = useApp((s) => s.settings.sync?.enabled ?? false);
  const urlOverride = useApp((s) => s.settings.sync?.urlOverrides?.[initial.id] ?? "");
  const setUrlOverride = useApp((s) => s.setUrlOverride);
  const [b, setB] = useState<Backend>(initial);
  const [key, setKey] = useState(initialKey ?? "");
  // Debounce the typed key AND the server URL before they drive the best-effort capability /
  // override-profile lookups, so typing either field doesn't fire a burst of requests on every
  // keystroke (the URL drives two lookups — getCapabilities + listOverrideProfiles — per char).
  const [debouncedKey, setDebouncedKey] = useState(initialKey ?? "");
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
  const [result, setResult] = useState<ConnectionInfo | null>(initialResult ?? null);
  // Drop a connection-test result once the tested target changes (URL or key edited): the in-flight
  // liveTarget guard only stops a result that RESOLVES after the edit — one that already committed
  // would keep showing the OLD server's classification / models / "Connected" under the new URL.
  // Skipped on mount: a connect-first add arrives with the connect step's still-valid result, which
  // this effect's initial run would otherwise wipe.
  const resultIsInitial = useRef(true);
  useEffect(() => {
    if (resultIsInitial.current) {
      resultIsInitial.current = false;
      return;
    }
    setResult(null);
  }, [b.serverUrl, key]);
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
      // A connect-step key only reaches the keyring on THIS save — if the field
      // was cleared before saving, no key was ever stored, so don't claim one
      // (an EXISTING backend's blank field still means "keep the stored key").
      hasApiKey: key.length > 0 || (initialKey ? false : b.hasApiKey),
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

// ── Connect-first add flow ──────────────────────────────────────────────────
// "Add backend" no longer opens the blank editor: a connect step asks only for
// URL + key, then branches on what the server knows (mirrors first-run
// onboarding). Synced settings on the account → restore offer; otherwise the
// editor opens PREFILLED from the test result. Unlike onboarding, nothing is
// persisted until the editor's Save / the restore applies — cancelling anywhere
// leaves the config untouched.

type AddFlow =
  | { step: "connect" }
  | { step: "offer"; draft: Backend; key: string; info: ConnectionInfo; remote: SyncRemoteState }
  | { step: "edit"; draft: Backend; key?: string; info?: ConnectionInfo };

/** A draft Backend prefilled from a successful connection test: name from the
 *  host, the server's loaded model, batch endpoint for standard servers. */
function draftFromConnection(serverUrl: string, key: string, info: ConnectionInfo): Backend {
  return {
    id: crypto.randomUUID(),
    name: nameFromUrl(serverUrl),
    serverUrl,
    hasApiKey: key.length > 0,
    model: info.models.find((m) => m.loaded)?.id ?? info.models[0]?.id ?? "whisper-1",
    endpoint: classifyConnection(info) === "standard" ? "batch" : "stream",
    language: "auto",
    prompt: "",
    responseFormat: "verbose_json",
  };
}

function ConnectStep({
  onCancel,
  onManual,
  onDone,
}: {
  onCancel: () => void;
  onManual: () => void;
  onDone: (r: { draft: Backend; key: string; info: ConnectionInfo; remote?: SyncRemoteState }) => void;
}) {
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Fields stay editable during a test, so only act on a result whose target
  // still matches what's typed (mirrors the editor's liveTarget guard) — a slow
  // test must not decide the branch with a stale server's answer.
  const liveTarget = useRef({ url: "", key: "" });
  liveTarget.current = { url, key };

  const testAndContinue = async () => {
    if (busy) return;
    const typedUrl = url;
    const typedKey = key;
    const serverUrl = normalizeUrl(typedUrl);
    if (!serverUrl.replace(/^https?:\/\//i, "")) return;
    setBusy(true);
    setError(null);
    try {
      const info = await testConnection({ serverUrl, apiKey: typedKey || undefined });
      if (liveTarget.current.url !== typedUrl || liveTarget.current.key !== typedKey) return;
      if (!info.ok) {
        setError(info.error || "Couldn’t reach the server.");
        return;
      }
      const draft = draftFromConnection(serverUrl, typedKey, info);
      // Full backend → this account may have synced settings; discover, don't
      // ask (mirrors onboarding). Standard servers are never probed.
      if (info.bootId) {
        const p = await syncPull({ serverUrl, apiKey: typedKey || null });
        if (liveTarget.current.url !== typedUrl || liveTarget.current.key !== typedKey) return;
        if (p.ok && p.state?.blob) {
          onDone({ draft, key: typedKey, info, remote: p.state });
          return;
        }
      }
      onDone({ draft, key: typedKey, info });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-6">
      <div className="flex items-center gap-2 text-text">
        <Server className="size-[18px] text-accent" />
        <span className="text-[14px] font-semibold">Add backend</span>
        <span className="text-[12px] text-dim">· step 1 of 2 — connect</span>
      </div>
      <p className="mt-1.5 text-[12.5px] text-dim">
        Point at your server first — the rest fills itself in.
      </p>
      <div className="mt-5 flex max-w-[430px] flex-col gap-4">
        <Labeled label="Server URL">
          <TextInput
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://host:8000"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") void testAndContinue();
            }}
          />
        </Labeled>
        <Labeled label="API key · if your server requires one">
          <TextInput
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="wk_…"
            onKeyDown={(e) => {
              if (e.key === "Enter") void testAndContinue();
            }}
          />
        </Labeled>
      </div>
      {error && <Notice className="mt-4">{error}</Notice>}
      <div className="mt-6 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="accent" onClick={() => void testAndContinue()} disabled={busy || !url.trim()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
            Test &amp; continue
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
        <button
          className="ring-signal rounded text-[12px] text-dim underline decoration-line underline-offset-2 hover:text-text"
          onClick={onManual}
        >
          Enter details manually
        </button>
      </div>
    </Card>
  );
}

function RestoreOffer({
  draft,
  keyTyped,
  info,
  remote,
  onSkip,
  onDone,
}: {
  draft: Backend;
  keyTyped: string;
  info: ConnectionInfo;
  remote: SyncRemoteState;
  onSkip: () => void;
  onDone: () => void;
}) {
  const [restoring, setRestoring] = useState(false);

  // After the blob applied: make sure a backend for this server exists (the
  // restore may or may not have brought one — the backends category can be
  // deselected), surface the fresh test result on its card, and bind sync to it
  // (mirrors onboarding's restoreEverything).
  const finishRestore = async () => {
    const s = useApp.getState();
    const target = normalizeUrl(draft.serverUrl);
    let match = s.backends.find((b) => normalizeUrl(b.serverUrl) === target);
    if (!match) {
      let toAdd = draft;
      if (keyTyped) {
        try {
          await setBackendKey(draft.id, keyTyped);
        } catch (e) {
          // Don't lose an applied restore over a keyring failure — save the
          // backend keyless; the sync tab's no-key warning takes it from there.
          console.error("saving API key failed:", e);
          toAdd = { ...draft, hasApiKey: false };
        }
      }
      s.upsertBackend(toAdd);
      match = toAdd;
    }
    s.setConnection(match.id, info);
    s.updateSync({ enabled: true, backendId: match.id });
    onDone();
  };

  return (
    <Card className="p-6">
      <div className="flex items-center gap-2 text-text">
        <Server className="size-[18px] text-accent" />
        <span className="text-[14px] font-semibold">Add backend</span>
        <span className="text-[12px] text-dim">· step 2 of 2</span>
      </div>
      <div className="mt-4 flex items-center gap-2 font-mono text-[11px] text-dim">
        <StatusDot tone="ok" />
        <span>
          connected · faster-whisper-backend{info.serverVersion ? ` ${info.serverVersion}` : ""} ·{" "}
          {info.models.length} model{info.models.length === 1 ? "" : "s"}
          {info.username ? ` · ${info.username}` : ""}
        </span>
      </div>
      <div className="mt-4 max-w-[520px] rounded-card border border-accent/40 bg-accent-soft p-4">
        <div className="text-[13.5px] font-semibold text-text">This account has synced settings</div>
        <div className="mt-1 font-mono text-[11px] text-dim">
          last synced{remote.device ? ` from ${remote.device}` : ""}
          {remote.updated_at ? ` · ${relTime(remote.updated_at * 1000)}` : ""}
        </div>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {ALL_CATEGORIES.filter((c) => remote.blob?.[c] !== undefined).map((c) => (
            <span
              key={c}
              className="rounded-pill border border-line-strong px-2.5 py-0.5 font-mono text-[10px] text-dim"
            >
              {c === "appRules" ? "app rules" : c}
            </span>
          ))}
        </div>
        <div className="mt-3.5 flex items-center gap-2.5">
          <Button variant="accent" onClick={() => setRestoring(true)}>
            Restore…
          </Button>
          <Button variant="ghost" onClick={onSkip}>
            Just add this backend
          </Button>
        </div>
      </div>
      <p className="mt-3 max-w-[52ch] text-[12px] text-dim">
        Restoring lets you pick which parts to bring over — anything you choose replaces its local
        counterpart. Skipping simply continues to the editor.
      </p>
      {restoring && (
        <RestoreFromServer
          state={remote}
          onCancel={() => setRestoring(false)}
          onApplied={finishRestore}
        />
      )}
    </Card>
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
  const [flow, setFlow] = useState<AddFlow | null>(null);
  // Set of backend ids whose connection test is in flight. A Set (not a single id) so two
  // concurrent tests track independently — finishing one can't clear another's spinner, and
  // its late result can't be misattributed.
  const [testing, setTesting] = useState<ReadonlySet<string>>(new Set());

  // Deep link from the Home checklist: /backends?add=1 opens straight into the
  // connect step, then drops the param so back/refresh doesn't re-trigger it.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get("add") != null) {
      setFlow({ step: "connect" });
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

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
    setFlow(null);
  };

  return (
    <div className="mx-auto max-w-[820px] px-10 py-12">
      <ListScreenHeader
        eyebrow="backends"
        title="Backends"
        showAdd={!flow}
        addLabel="Add backend"
        onAdd={() => setFlow({ step: "connect" })}
      >
        A backend is a connection to a transcription server, with its own model, default
        language, and endpoint. Profiles point at one.
      </ListScreenHeader>

      {flow ? (
        <div className="mt-8">
          {flow.step === "connect" ? (
            <ConnectStep
              onCancel={() => setFlow(null)}
              onManual={() => setFlow({ step: "edit", draft: blankBackend() })}
              onDone={(r) =>
                setFlow(
                  r.remote
                    ? { step: "offer", draft: r.draft, key: r.key, info: r.info, remote: r.remote }
                    : { step: "edit", draft: r.draft, key: r.key, info: r.info },
                )
              }
            />
          ) : flow.step === "offer" ? (
            <RestoreOffer
              draft={flow.draft}
              keyTyped={flow.key}
              info={flow.info}
              remote={flow.remote}
              onSkip={() =>
                setFlow({ step: "edit", draft: flow.draft, key: flow.key, info: flow.info })
              }
              onDone={() => setFlow(null)}
            />
          ) : (
            <Editor
              initial={flow.draft}
              initialKey={flow.key}
              initialResult={flow.info}
              onCancel={() => setFlow(null)}
              onSave={(b) => {
                handleSave(b);
                // The connect step's test is still current when the URL wasn't
                // edited — show it on the list card instead of "untested".
                if (flow.info && b.serverUrl === flow.draft.serverUrl) {
                  setConnection(b.id, flow.info);
                }
              }}
            />
          )}
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
                    <Button variant="ghost" size="sm" title="Edit" onClick={() => setFlow({ step: "edit", draft: b })}>
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
