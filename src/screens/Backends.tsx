import { useEffect, useId, useRef, useState } from "react";
import { screenEyebrow, screenTitle } from "@/lib/screens";
import { useSearchParams } from "react-router-dom";
import { Server, Pencil, Copy, Trash2, Plug, Loader2 } from "lucide-react";
import { useApp } from "@/lib/store";
import { Badge, Button, Card, ConfirmLeave, DisclosureCard, EditorHeader, Labeled, ListScreenHeader, Notice, Segmented, SectionLabel, SetSummary, StatusDot, TextInput } from "@/components/ui";
import { OverrideHeader, OverrideText, OVERRIDE_CONTROL_W } from "@/components/OverrideField";
import { ServerInfoButton, ServerInfoPanel } from "@/components/ServerInfoPanel";
import { backendChips } from "@/lib/backendChips";
import { countSet } from "@/lib/decodeKeys";
import { envDesc } from "@/lib/settingDesc";
import { isDirty, useUnsavedGuard } from "@/lib/useUnsavedGuard";
import { DecodeFields } from "@/components/DecodeFields";
import { LiveDictationFields } from "@/components/LiveDictationFields";
import { TranslationDefaultsEditor, targetsLabel } from "@/components/TranslationFields";
import {
  inheritLabel, LOCKED_REASON, serverContextSegments, serverInherited, serverLanguageLabel, shortModelName,
} from "@/lib/inherit";
import { SpokenLanguagePicker } from "@/components/LanguagePicker";
import { ModelPicker } from "@/components/ModelPicker";
import { OverrideProfilePicker } from "@/components/OverrideProfilePicker";
import { ReorderControls } from "@/components/ReorderControls";
import { languageLabel, namedLanguage, offersMultilingual, spokenField, spokenLabel } from "@/lib/languages";
import { testConnection, setBackendKey, deleteBackendKey, syncPull } from "@/lib/api";
import type { Backend, ConnectionInfo } from "@/lib/types";
import type { SyncRemoteState } from "@/lib/syncTypes";
import { ALL_CATEGORIES, migrateBlob } from "@/lib/sync";
import { classifyConnection, effectiveServerKind } from "@/lib/serverKind";
import { authorityOf, backendPrompt, backendPromptFields, effectiveServerUrl, insecureUrlWarning, newBackendDraft, normalizeUrl } from "@/lib/backends";
import { safeDisplayText, safeIdentityText } from "@/lib/sanitize";
import { hasOwn, ownProp } from "@/lib/own";
import { useOverrideContext } from "@/lib/useOverrideContext";
import { refreshCaps } from "@/lib/capabilities";
import { useDecodeDefaults } from "@/lib/useDecodeDefaults";
import { RestoreFromServer } from "@/components/SettingsSync";
import { relTime } from "@/lib/format";

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
  // Model suggestions: a fresh in-editor test wins; else the session cache
  // (fed by the list card's tests and the Transcribe screen's probes). No
  // background probe here — the editor's URL may be mid-edit.
  const storedConn = useApp((s) => ownProp(s.connections, initial.id));
  const syncEnabled = useApp((s) => s.settings.sync?.enabled ?? false);
  // Same guard: an inherited value here would put a FUNCTION into a controlled input's `value`.
  const urlOverride = useApp((s) => {
    const raw = s.settings.sync?.urlOverrides?.[initial.id];
    return typeof raw === "string" ? raw : "";
  });
  const setUrlOverride = useApp((s) => s.setUrlOverride);
  const [b, setB] = useState<Backend>(initial);
  const [key, setKey] = useState(initialKey ?? "");
  // The address this editor's requests ACTUALLY go to — the same rule `effectiveServerUrl`
  // applies, but reactive, so a change to "Address on this device" re-runs the effects below.
  // `runTest`, `liveTarget`, the list card and every transcription already resolve the override;
  // the probes driven from here did not, which is what sent the API key to the canonical host.
  const effUrl = urlOverride.trim() || b.serverUrl;
  // Debounce the typed key AND the server URL before they drive the best-effort capability /
  // override-profile lookups, so typing either field doesn't fire a burst of requests on every
  // keystroke (the URL drives two lookups — getCapabilities + listOverrideProfiles — per char).
  const [debouncedKey, setDebouncedKey] = useState(initialKey ?? "");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedKey(key), 400);
    return () => clearTimeout(t);
  }, [key]);
  // Debounced on the EFFECTIVE address. This value feeds `useOverrideContext` / `useDecodeDefaults`,
  // whose probes (getCapabilities, getDecodeDefaults, listOverrideProfiles) carry the bearer credential — the
  // typed key, or, when the field is blank, the STORED keyring key Rust resolves for this id. On
  // the canonical url those requests went to the very host a user had redirected this backend away
  // from, and the override-profile names the picker offered came from that host while the name
  // chosen was then sent to the other one. `Profiles.tsx` already resolves the override for
  // exactly this reason, and Q13/J8 fixed the same divergence on `runTest` and the card's address.
  const [debouncedUrl, setDebouncedUrl] = useState(
    () => urlOverride.trim() || initial.serverUrl,
  );
  useEffect(() => {
    const t = setTimeout(() => setDebouncedUrl(effUrl), 400);
    return () => clearTimeout(t);
  }, [effUrl]);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ConnectionInfo | null>(initialResult ?? null);
  // Drop a connection-test result once the tested target changes (URL or key edited): the in-flight
  // liveTarget guard only stops a result that RESOLVES after the edit — one that already committed
  // would keep showing the OLD server's classification / models / "Connected" under the new URL.
  // Skipped while the target the result belongs to is unchanged — which covers the mount (a
  // connect-first add arrives with the connect step's still-valid result) AND StrictMode's double
  // mount, where a "first run" flag would already be spent on the second pass and wipe it.
  // `runTest` moves this ref onto the target it actually tested, and `doSave` only writes the
  // result to the store when the ref still matches what was just persisted.
  const resultTarget = useRef({ url: effUrl, key });
  useEffect(() => {
    if (resultTarget.current.url === effUrl && resultTarget.current.key === key) return;
    resultTarget.current = { url: effUrl, key };
    setResult(null);
    // Keyed on the EFFECTIVE address, not the canonical one. Q13 moved `liveTarget` and
    // `runTest` onto `effectiveServerUrl` (which prefers `settings.sync.urlOverrides`) precisely
    // because the canonical url is not what gets tested — but this effect, whose job is to DROP a
    // committed result once the tested target changes, kept the two terms that fix declared
    // insufficient. So: run Test, get "Connected · <version> · <username>", then edit "Address on
    // this device" in the same editor (it applies live, no save) — the store's cached connection
    // is dropped, but this local `result` survived, so the version and username of the OLD server
    // stayed on screen next to the NEW address and kept gating the decode-override editor.
  }, [effUrl, key]);
  // Saving the API key to the OS keyring can fail (locked/absent Secret Service). Track it so we
  // keep the editor open with an error instead of persisting a backend whose "key" badge claims a
  // key that was never stored.
  const [savingKey, setSavingKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  // Every disclosure starts closed; its header's "· n set" says whether it holds anything.
  // Every disclosure starts closed (a manual draft is prefilled with localhost).
  const [showConnection, setShowConnection] = useState(false);
  const [showDefaults, setShowDefaults] = useState(false);
  const [showDecode, setShowDecode] = useState(false);
  const [showLive, setShowLive] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const infoId = useId();
  const reportApp = useApp((s) => s.settings.recording.reportTargetApp);
  const [showTranslation, setShowTranslation] = useState(false);
  const set = (patch: Partial<Backend>) => setB((x) => ({ ...x, ...patch }));
  // The prompt's tri-state view: undefined = inherit, "" = explicit clear, value = set.
  const promptOverride = backendPrompt(b);
  const promptOverridden = promptOverride !== undefined;
  // `detected` = what the last connection test inferred; `kind` = the effective
  // classification (a manual override wins). `kind` gates the decode-override editor.
  const detected = classifyConnection(result);
  // The freshest verdict for the top card and the model list: this editor's test, else the
  // session cache (the list card's tests, the Transcribe screen's probes).
  const conn = result ?? storedConn;
  const chips = backendChips(b, conn ?? undefined);
  const kind = effectiveServerKind(b, result);
  // Caller capabilities, for gating the decode editor.
  const { caps } = useOverrideContext({
    serverUrl: debouncedUrl,
    backendId: b.id,
    apiKey: debouncedKey || null,
    serverKind: kind,
  });
  // The model is typed too: debounce it like the address so typing doesn't fetch per character.
  const [debouncedModel, setDebouncedModel] = useState(initial.model ?? "");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedModel(b.model ?? ""), 400);
    return () => clearTimeout(t);
  }, [b.model]);
  // What the server gives this backend's requests (its model + override profile) — the values
  // its blank decode fields and prompt inherit. Batch terms: the backend serves both.
  const decodeDefaults = useDecodeDefaults({
    serverUrl: debouncedUrl,
    backendId: b.id,
    apiKey: debouncedKey || null,
    model: debouncedModel,
    profileName: b.overrideProfile,
    serverKind: kind,
  });
  const server = serverInherited(decodeDefaults);
  // "Multiple languages" is the backend's default `multilingual` decode override.
  const multiOffered = offersMultilingual({
    canOverride: caps?.can_request_decode_overrides,
    locked: server.locked.has("multilingual"),
    standard: kind === "standard",
    model: debouncedModel,
  });
  const spoken = spokenField(b.language, b.decodeOverrides, server.values.multilingual, multiOffered);
  const promptLocked = server.prompt?.locked === true;

  // The Server URL / API-key fields stay editable during an in-flight test (only the Test button
  // is disabled), so a result that resolves after the user edits them describes a server they've
  // already moved off. Track the live target and only commit a test whose URL+key still match
  // (mirrors Transcribe's runId guard); else effectiveServerKind / the status dot / the decode gate
  // would cache the old server's classification under this backend id.
  // The EFFECTIVE url on both sides: this screen shows the effective address, so a verdict earned
  // by testing `b.serverUrl` while an override points somewhere else described a different host
  // than the one displayed next to it.
  const liveTarget = useRef({ url: effUrl, key });
  liveTarget.current = { url: effUrl, key };

  const runTest = async () => {
    const testedUrl = effUrl;
    const testedKey = key;
    setTesting(true);
    try {
      const info = await testConnection({
        serverUrl: testedUrl,
        backendId: b.id,
        apiKey: testedKey || null,
      });
      // Local only — the store gets this verdict in `doSave`, once the target it describes is the
      // one persisted. Writing it here cached a DRAFT's verdict under the backend id: edit X, retype
      // the URL, Test, Cancel → `connections[X]` held the other host's answer while X still routed
      // to the old one (and a tested-then-cancelled connect-first draft left an orphan entry).
      if (liveTarget.current.url === testedUrl && liveTarget.current.key === testedKey) {
        resultTarget.current = { url: testedUrl, key: testedKey };
        setResult(info);
        // The one case the store may take it now: the tested target is exactly the persisted
        // one (stored keyring key, same effective address, backend already saved), so the
        // verdict describes what the list card routes to — a Test-then-Cancel on an unedited
        // backend still refreshes "server came back / went away".
        const live = useApp.getState();
        const stored = live.backends.find((x) => x.id === b.id);
        if (stored && !testedKey && normalizeUrl(testedUrl) === normalizeUrl(effectiveServerUrl(stored, live.settings))) {
          setConnection(b.id, info);
        }
      }
    } catch (e) {
      // IPC reject (same guard the list card's handleTest carries) — surface the
      // failure so the editor doesn't just silently stop.
      if (liveTarget.current.url === testedUrl && liveTarget.current.key === testedKey) {
        resultTarget.current = { url: testedUrl, key: testedKey };
        setResult({ ok: false, openMode: false, models: [], error: String(e) });
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
        return false; // nothing persisted — "Save and leave" must stay so the error is seen
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
    // Now that the target is persisted (upsertBackend's eviction has run inside onSave, and a
    // typed key reached the keyring above), cache the in-editor verdict — only if it still
    // describes the address + key that were just saved.
    if (result && resultTarget.current.url === effUrl && resultTarget.current.key === key) {
      setConnection(b.id, result);
    }
    return true;
  };

  // Unsaved-work guard, shared with the Profiles and Per-app rules editors. A
  // typed API key counts as unsaved work; "Address on this device" does not —
  // it applies live and needs no save. A draft arriving with a connect-step
  // result is the connect-first add path: the user has already paid for a
  // connection test, so leaving would throw away real work even untouched.
  const dirty = isDirty(b, initial) || key !== (initialKey ?? "") || initialResult != null;
  const guard = useUnsavedGuard(dirty);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !guard.asking && !savingKey) guard.guardExit(onCancel);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <Card className="p-6">
      <EditorHeader
        onBack={() => guard.guardExit(onCancel)}
        title={b.name.trim() || "New backend"}
        subtitle={
          chips.length ? (
            <span className="inline-flex items-center gap-1.5">
              {chips.map((c) => (
                <Badge key={c}>{c}</Badge>
              ))}
            </span>
          ) : (
            "Backend · faster-whisper / OpenAI-compatible"
          )
        }
        dirty={dirty}
        saveLabel="Save backend"
        onSave={() => void doSave()}
        saveDisabled={savingKey}
      />
      {guard.asking && (
        <ConfirmLeave
          what="backend"
          onSaveAndLeave={() => guard.saveAndLeave(doSave)}
          onDiscard={guard.leave}
          onStay={guard.stay}
        />
      )}

      {/* The backend at a glance: where it points, whether it answered, and — behind ⓘ — what
          this server allows and keeps (red dot while it records captures). */}
      <div className="mt-5 rounded-card border border-line bg-surface-2/40 px-[18px]">
        <div className="flex flex-wrap items-center gap-3 py-3">
          <StatusDot tone={conn?.ok ? "ok" : conn?.error ? "warn" : "idle"} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-medium text-text">{safeIdentityText(b.name, 80) || "New backend"}</div>
            <div className="truncate font-mono text-[11.5px] text-faint">{safeIdentityText(effUrl, 120) || "no address yet"}</div>
          </div>
          <span className="rounded-pill border border-line-strong px-2.5 py-0.5 text-[12px] text-dim" title={conn?.error}>
            {conn?.ok
              ? "Connected"
              : conn?.error
                ? "Error"
                : "Untested"}
          </span>
          <ServerInfoButton info={caps?.server_info} open={showInfo} onToggle={() => setShowInfo((v) => !v)} controls={infoId} />
        </div>
        {showInfo && caps?.server_info && <ServerInfoPanel id={infoId} info={caps.server_info} reportApp={reportApp} />}
      </div>

      <div className="mt-5">
        <DisclosureCard
          open={showConnection}
          onToggle={() => setShowConnection((v) => !v)}
          title="Connection"
          summary={<span className="text-faint">· {safeIdentityText(authorityOf(effUrl)?.host, 60) || "no address"}</span>}
        >
          <OverrideHeader title="Name" env={false}>
            <div className={OVERRIDE_CONTROL_W}>
              <TextInput aria-label="Name" value={b.name} onChange={(e) => set({ name: e.target.value })} placeholder="My backend" />
            </div>
          </OverrideHeader>
          <OverrideHeader title="Server URL" env={false}>
            <div className={OVERRIDE_CONTROL_W}>
              <TextInput aria-label="Server URL" value={b.serverUrl} onChange={(e) => set({ serverUrl: e.target.value })} placeholder="http://host:8000" />
            </div>
            {insecureUrlWarning(b.serverUrl) && <Notice className="mt-1">{insecureUrlWarning(b.serverUrl)}</Notice>}
          </OverrideHeader>
          {/* Per-device address override: connects THIS machine somewhere else while
              the canonical URL above stays shared through settings sync (classic
              case: localhost on the box running the server, a LAN IP elsewhere).
              Applied live via the store (it's device state, not part of the Backend
              being edited); grayed out (never hidden) while sync is off, where the
              canonical URL is already local-only.

              EXCEPT when one is actually set. The override applies whether or not sync is on and
              survives turning it off (see the warning note below, and `effectiveServerUrl`), so
              greying the box on `!syncEnabled` alone locked a value that was still routing every
              request: a user following the "override in use" badge on the card here to clear a
              misrouting address found a disabled field, with only "turn sync back on" or "delete
              the backend" as ways out. Never disable a control that is currently in effect. */}
          <OverrideHeader
            title="Address on this device"
            env={false}
            hint="Overrides the synced Server URL on this device only (e.g. localhost on the machine running the server)."
            overridden={!!urlOverride.trim()}
          >
            <div className={OVERRIDE_CONTROL_W}>
              <TextInput
                aria-label="Address on this device"
                value={urlOverride}
                disabled={!syncEnabled && !urlOverride.trim()}
                onChange={(e) => setUrlOverride(b.id, e.target.value)}
                placeholder={syncEnabled ? "override the synced URL here only" : "used with settings sync"}
              />
            </div>
            {!syncEnabled && urlOverride.trim() && (
              <Notice className="mt-1">
                Sync is off, but this address is still where this device sends everything for this
                backend. Clear the field to go back to the address above.
              </Notice>
            )}
            {/* This field bypasses normalizeUrl entirely — it goes to the transport verbatim — so
                it needs the warning at least as much as the canonical URL above. NOT gated on
                syncEnabled: `effectiveServerUrl` consults the override regardless of whether sync
                is on, and turning sync off does not clear it. The warning must track the address
                actually in use, not the toggle. */}
            {urlOverride.trim() && insecureUrlWarning(urlOverride) && (
              <Notice className="mt-1">{insecureUrlWarning(urlOverride)}</Notice>
            )}
          </OverrideHeader>
          <OverrideHeader title="API key" env={false}>
            <div className={OVERRIDE_CONTROL_W}>
              <TextInput
                aria-label="API key"
                type="password"
                value={key}
                onChange={(e) => {
                  setKey(e.target.value);
                  set({ hasApiKey: e.target.value.length > 0 || initial.hasApiKey });
                }}
                placeholder={initial.hasApiKey ? "•••••••••• (stored — leave blank to keep)" : "wk_… (optional)"}
              />
            </div>
          </OverrideHeader>
          <OverrideHeader
            title="Server type"
            env={false}
            overridden={!!b.kind && b.kind !== "auto"}
            note={
              detected === "unknown" ? (
                "Test the connection to detect"
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <StatusDot tone={detected === "full" ? "ok" : "warn"} />
                  {detected === "full" ? "faster-whisper-backend" : "Standard Whisper server"}
                  {b.kind && b.kind !== "auto" && " · manual"}
                </span>
              )
            }
          >
            <Segmented
              ariaLabel="Server type"
              value={b.kind ?? "auto"}
              onChange={(v) => set({ kind: v === "auto" ? undefined : v })}
              options={[
                { value: "auto", label: "Auto" },
                { value: "full", label: "Full" },
                { value: "standard", label: "Standard" },
              ]}
            />
          </OverrideHeader>
          <OverrideHeader title="Server override profile" env={false} overridden={!!b.overrideProfile} last>
            <div className={OVERRIDE_CONTROL_W}>
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
            </div>
          </OverrideHeader>
        </DisclosureCard>
      </div>

      <div className="mt-5">
        <DisclosureCard
          open={showDefaults}
          onToggle={() => setShowDefaults((v) => !v)}
          title="Defaults"
          summary={
            <span className="text-faint">
              · {shortModelName(b.model || decodeDefaults?.model) ?? "server model"} ·{" "}
              {safeDisplayText(spoken.value ? spokenLabel(spoken.value) : (serverLanguageLabel(decodeDefaults) ?? "server language"), 30)}{" "}
              · {b.endpoint === "batch" ? "Batch" : "Streaming"}
            </span>
          }
          hint="What every profile on this backend starts from."
        >
          <OverrideHeader title="DEFAULT_MODEL" desc={envDesc("DEFAULT_MODEL")} overridden={!!b.model.trim()}>
            <div className={OVERRIDE_CONTROL_W}>
              <ModelPicker
                ariaLabel="Model"
                value={b.model}
                onChange={(v) => set({ model: v })}
                models={result?.ok ? result.models : storedConn?.ok ? storedConn.models : []}
                placeholder={decodeDefaults?.model ? inheritLabel(shortModelName(decodeDefaults.model), "Default") : "whisper-1 / large-v3"}
              />
            </div>
          </OverrideHeader>
          <OverrideHeader title="DEFAULT_LANGUAGE" desc={envDesc("DEFAULT_LANGUAGE")}>
            <div className={OVERRIDE_CONTROL_W}>
              <SpokenLanguagePicker
                ariaLabel="Default language"
                value={spoken.value}
                multi={multiOffered}
                // "" = send no language: the server's DEFAULT_LANGUAGE (new backends start here).
                inheritLabel={inheritLabel(serverLanguageLabel(decodeDefaults), "Default")}
                onChange={(v) => {
                  const { language, overrides } = spoken.pick(v);
                  set({ language, decodeOverrides: overrides && Object.keys(overrides).length ? overrides : undefined });
                }}
              />
            </div>
          </OverrideHeader>
          <OverrideHeader title="Endpoint" env={false}>
            <Segmented
              ariaLabel="Endpoint"
              value={b.endpoint}
              onChange={(v) => set({ endpoint: v })}
              options={[
                { value: "stream", label: "Streaming" },
                { value: "batch", label: "Batch" },
              ]}
            />
            {kind === "standard" && b.endpoint === "stream" && (
              <Notice className="mt-1">
                A standard Whisper server has no streaming endpoint — switch Endpoint to{" "}
                <span className="font-medium">Batch</span>.
              </Notice>
            )}
          </OverrideHeader>
          {/* Tri-state, the same shape the Profile editor and the decode fields use:
              undefined = inherit the server's default prompt (omit the
              field), "" = explicit clear (send an empty prompt, so nothing is inherited),
              value = use it. Stored as `prompt` + `promptCleared` — see `backendPrompt`. */}
          <OverrideHeader
            title="DEFAULT_PROMPT"
            desc={envDesc("DEFAULT_PROMPT")}
            overridden={promptOverridden}
            lockReason={promptLocked ? LOCKED_REASON : undefined}
            onClear={() => set(backendPromptFields(""))}
            canClear={promptOverride !== ""}
            clearTitle="Override with empty (suppress the inherited prompt)"
            onReset={() => set(backendPromptFields(undefined))}
            note={promptLocked && promptOverridden ? "Ignored · locked by the server" : undefined}
            wide
            last
          >
            {/* Ghost the server's default prompt (its own, or the override profile's) as the
                inherited baseline; a cleared field says so instead. */}
            <OverrideText
              ariaLabel="Default vocabulary / prompt"
              rows={2}
              value={promptOverride}
              onChange={(v) => set(backendPromptFields(v))}
              inherited={server.prompt ? (server.prompt.value ?? "no prompt") : undefined}
              fixedLabel={promptLocked ? inheritLabel(server.prompt?.value ?? "no prompt", "Set by server") : undefined}
              title={promptLocked ? LOCKED_REASON : server.prompt?.source}
            />
          </OverrideHeader>
        </DisclosureCard>
      </div>

      <div className="mt-5">
        <DisclosureCard
          open={showDecode}
          onToggle={() => setShowDecode((v) => !v)}
          title="Decode defaults"
          summary={<SetSummary count={countSet(b.decodeOverrides, "decode")} inherit="inherit server" />}
          hint="Defaults for every profile that uses this backend (a profile can still override per field). Empty = the server's per-model config."
        >
          <DecodeFields
            value={b.decodeOverrides ?? {}}
            onChange={(v) => set({ decodeOverrides: Object.keys(v).length ? v : undefined })}
            inherited={server.values}
            sources={server.sources}
            locked={server.locked}
            known={server.known}
            languagePinned={namedLanguage(b.language || String(decodeDefaults?.language?.value ?? ""))}
            serverKind={kind}
            canCustomize={caps?.can_request_decode_overrides}
          />
        </DisclosureCard>
      </div>

      <div className="mt-5">
        <DisclosureCard
          open={showLive}
          onToggle={() => setShowLive((v) => !v)}
          title="Live dictation defaults"
          summary={<SetSummary count={countSet(b.decodeOverrides, "live")} inherit="inherit server" />}
          hint="Defaults for every streaming profile on this backend (a profile can still override per field). Empty = the server's config."
        >
          <LiveDictationFields
            value={b.decodeOverrides ?? {}}
            onChange={(v) => set({ decodeOverrides: Object.keys(v).length ? v : undefined })}
            inherited={server.values}
            sources={server.sources}
            locked={server.locked}
            known={server.known}
            disabledReason={
              kind === "standard" || caps?.can_request_decode_overrides === false
                ? "This connection can't send live dictation settings."
                : undefined
            }
          />
        </DisclosureCard>
      </div>

      <div className="mt-5">
        <DisclosureCard
          open={showTranslation}
          onToggle={() => setShowTranslation((v) => !v)}
          title="Translation defaults"
          summary={<SetSummary count={Object.keys(b.translationOverrides ?? {}).length} inherit="inherit server" />}
          hint="T2T defaults for runs and profiles on this backend (a profile can still override). Empty = the server's translation config."
        >
          <TranslationDefaultsEditor
            value={b.translationOverrides}
            onChange={(v) => set({ translationOverrides: v })}
            caps={caps}
            // The server's own values where it publishes them: TRANSLATE_TO from /v1/me (it seeds
            // the Transcribe page; dictation translates only into targets set here or on a
            // profile), TRANSLATION_CONTEXT_SEGMENTS from /v1/request-default-settings.
            inherited={{
              targets: targetsLabel(caps?.translate_to_default, "server default"),
              model: "server default",
              contextSegments: serverContextSegments(decodeDefaults),
              includeOriginal: false,
            }}
            inheritedFrom="server"
          />
        </DisclosureCard>
      </div>

      {result && <ConnResult info={result} />}

      {keyError && (
        <Notice className="mt-4">{keyError}</Notice>
      )}

      <div className="mt-6 flex items-center justify-between">
        <Button variant="ghost" onClick={() => guard.guardExit(onCancel)} disabled={savingKey}>
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
          {info.openMode ? " · open mode (no auth)" : info.username ? ` · ${safeDisplayText(info.username, 60)}` : ""}.
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
  const insecure = url.trim() ? insecureUrlWarning(url) : null;

  const testAndContinue = async () => {
    if (busy) return;
    const typedUrl = url;
    const typedKey = key;
    const serverUrl = normalizeUrl(typedUrl);
    if (!serverUrl.replace(/^https?:\/\//i, "")) {
      // Say so — a bare return left the flow's first button dead and silent for
      // `ftp://host`, `https:/host` or a lone `http://`.
      setError("Enter an address like http://host:8000 — that scheme isn’t supported.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const info = await testConnection({ serverUrl, apiKey: typedKey || undefined });
      if (liveTarget.current.url !== typedUrl || liveTarget.current.key !== typedKey) return;
      if (!info.ok) {
        setError(info.error || "Couldn’t reach the server.");
        return;
      }
      const draft = newBackendDraft({ serverUrl, hasApiKey: typedKey.length > 0, info });
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
      // Same guard as the resolved branches: a reject for an address the user has since retyped
      // must not be shown under the new one.
      if (liveTarget.current.url === typedUrl && liveTarget.current.key === typedKey) {
        setError(String(e));
      }
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
      {insecure && <Notice className="mt-4">{insecure}</Notice>}
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
          className="ring-signal rounded text-[12px] text-dim underline decoration-line underline-offset-2 hover:text-text disabled:pointer-events-none disabled:opacity-40"
          onClick={onManual}
          disabled={busy}
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
      s.upsertBackend(draft);
      match = draft;
    }
    // The key the user just typed and proved works belongs to whichever backend is bound —
    // the restored one for this server included. It used to be written only when a NEW
    // backend was minted, so the common case (the restore brought one for the same server)
    // ended with sync enabled against a backend this device held no credential for.
    if (keyTyped) {
      try {
        await setBackendKey(match.id, keyTyped);
        if (!match.hasApiKey) {
          const withKey = { ...match, hasApiKey: true };
          s.upsertBackend(withKey);
          match = withKey;
        }
      } catch (e) {
        // Don't lose an applied restore over a keyring failure — leave the backend
        // keyless; the sync tab's no-key warning takes it from there.
        console.error("saving API key failed:", e);
        if (!s.backends.some((b) => b.id === match!.id)) s.upsertBackend({ ...match, hasApiKey: false });
      }
    }
    // Cache the connect step's verdict only if the backend really routes to the address it
    // was tested against: a per-device URL override can send every request to host B while
    // the canonical address is host A (the invariant handleTest / onSave already keep).
    if (normalizeUrl(effectiveServerUrl(match, useApp.getState().settings)) === target) {
      useApp.getState().setConnection(match.id, info);
    }
    useApp.getState().updateSync({ enabled: true, backendId: match.id });
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
          connected · faster-whisper-backend{info.serverVersion ? ` ${safeDisplayText(info.serverVersion, 60)}` : ""} ·{" "}
          {info.models.length} model{info.models.length === 1 ? "" : "s"}
          {info.username ? ` · ${safeDisplayText(info.username, 60)}` : ""}
        </span>
      </div>
      <div className="mt-4 max-w-[520px] rounded-card border border-accent/40 bg-accent-soft p-4">
        <div className="text-[13.5px] font-semibold text-text">This account has synced settings</div>
        <div className="mt-1 font-mono text-[11px] text-dim">
          last synced{remote.device ? ` from ${safeDisplayText(remote.device, 60)}` : ""}
          {remote.updated_ts ? ` · ${relTime(remote.updated_ts * 1000)}` : ""}
        </div>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {ALL_CATEGORIES.filter((c) => (remote.blob ? migrateBlob(remote.blob) : {})[c] !== undefined).map((c) => (
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
  const caps = useApp((s) => s.caps);
  const reportApp = useApp((s) => s.settings.recording.reportTargetApp);
  // The list row's ⓘ: one backend's panel open at a time.
  const [infoOpen, setInfoOpen] = useState<string | null>(null);
  const infoBase = useId();
  // A row tested OK shows its ⓘ live: fetch the caps a list row never otherwise asks for.
  useEffect(() => {
    for (const b of backends) {
      if (ownProp(connections, b.id)?.ok && !hasOwn(caps, b.id)) void refreshCaps(b);
    }
  }, [backends, connections, caps]);
  // Subscribed, not read imperatively, so the card re-renders when an override changes.
  const urlOverrides = useApp((s) => s.settings.sync?.urlOverrides);
  /** Where requests for this backend ACTUALLY go — mirrors `effectiveServerUrl`, which the Test
   *  button on the same row already uses. */
  // Type-check the lookup, same reason as `effectiveServerUrl`: `?.` does not guard a
  // prototype-inherited value, and this open-coded twin threw identically.
  const effectiveUrl = (b: Backend) => {
    const raw = urlOverrides?.[b.id];
    return (typeof raw === "string" ? raw.trim() : "") || b.serverUrl;
  };
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
    const testedUrl = effectiveServerUrl(b, useApp.getState().settings);
    try {
      const info = await testConnection({
        serverUrl: testedUrl,
        backendId: b.id,
      });
      // Mirror the editor's liveTarget guard (+ upsertBackend's connection invalidation): a slow/
      // unreachable test can resolve AFTER the user edits this backend's URL/key (which drops the
      // stale connection) or removes it. Only commit if the backend still exists with the same target,
      // else we'd re-cache the OLD server's classification under this id (effectiveServerKind / status
      // dot / decode gate) or re-add a dangling connection for a removed backend.
      // The invalidation triple is serverUrl / hasApiKey / URL OVERRIDE, and the third term was
      // missing — while the request itself goes to the EFFECTIVE url, which prefers the override.
      // So editing "Address on this device" (applied live, no save needed) while a slow test was
      // in flight installed the old address's verdict under the repointed backend, and nothing
      // re-tests on its own: the green "connected" dot beside the new host was permanent.
      const cur = useApp.getState().backends.find((x) => x.id === b.id);
      const curUrl = cur ? effectiveServerUrl(cur, useApp.getState().settings) : null;
      if (cur && cur.serverUrl === b.serverUrl && cur.hasApiKey === b.hasApiKey && curUrl === testedUrl) {
        setConnection(b.id, info);
      }
    } catch (e) {
      console.error("test_connection failed", e);
      const cur2 = useApp.getState().backends.find((x) => x.id === b.id);
      const curUrl2 = cur2 ? effectiveServerUrl(cur2, useApp.getState().settings) : null;
      if (cur2 && cur2.serverUrl === b.serverUrl && cur2.hasApiKey === b.hasApiKey && curUrl2 === testedUrl) {
        setConnection(b.id, { ok: false, openMode: false, models: [], error: String(e) } as ConnectionInfo);
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
    <div className="page page-form">
      <ListScreenHeader
        eyebrow={screenEyebrow("backends")}
        title={screenTitle("backends")}
        icon={Server}
        showAdd={!flow}
        addLabel="Add backend"
        onAdd={() => setFlow({ step: "connect" })}
      >
        A backend that transcribes dictation and, with a <strong className="font-semibold text-text">faster-whisper-backend</strong> server,
        also transcribes audio or video files,
        <br />
        links to audio or video content, or text files, and optionally even translates and diarizes them.
      </ListScreenHeader>

      {flow ? (
        <div className="page-content">
          {flow.step === "connect" ? (
            <ConnectStep
              onCancel={() => setFlow(null)}
              onManual={() => setFlow({ step: "edit", draft: newBackendDraft() })}
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
                //
                // Both terms, canonical AND effective. "Address on this device" is applied LIVE
                // from inside this editor (`setUrlOverride`, no save needed) and
                // `effectiveServerUrl` prefers it, so checking only the canonical url caches host
                // A's verdict onto a backend that now routes to host B: a green "connected" dot
                // beside B's address on the card this file's own comment calls the audit surface,
                // with `effectiveServerKind` classifying B from A's answer — which gates the
                // decode-override editor and the endpoint warning. Permanent, since every
                // `setConnection` caller is a user gesture and nothing re-tests on its own. The
                // editor's stale-result effect and `handleTest` both already carry this term; this
                // commit path, the one that writes to the store, had neither.
                if (
                  flow.info &&
                  b.serverUrl === flow.draft.serverUrl &&
                  effectiveUrl(b) === flow.draft.serverUrl
                ) {
                  setConnection(b.id, flow.info);
                }
              }}
            />
          )}
        </div>
      ) : (
        <>
          <SectionLabel className="mb-3 mt-5">Configured</SectionLabel>
          {backends.length === 0 ? (
            <Card className="p-8 text-center text-[13.5px] text-dim">
              No backends yet. Add one to point the app at a faster-whisper server.
            </Card>
          ) : (
          <div className="flex flex-col gap-3">
            {backends.map((b, i) => {
              const conn = ownProp(connections, b.id);
              // Once per card, not five URL parses per render.
              const eff = effectiveUrl(b);
              const auth = authorityOf(eff);
              return (
                <Card key={b.id} className="p-5">
                  <div className="flex items-center gap-4">
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
                        <span className="truncate text-[14px] font-semibold text-text" title={safeDisplayText(b.name, 200)}>
                          {/* Sanitized like the address line below it, and for the same reason: a
                              rename raises no security change, so a name arrives on this card from
                              an unattended pull with no prompt — and bidi marks in it can make one
                              server read as another on the screen used to check where audio goes. */}
                          {/* `safeIdentityText`, like the address line below: the display filter
                              truncates with no marker and leaves whitespace runs to CSS, so
                              `"Work" + 100 spaces + "Evil"` renders as exactly `Work` on the very
                              card this comment calls the audit surface. */}
                          {safeIdentityText(b.name, 80)}
                        </span>
                        <Badge tone="accent">{b.endpoint}</Badge>
                        {/* "" = the backend leaves the language to the server. */}
                        <Badge>{b.language ? safeDisplayText(languageLabel(b.language), 40) : "server lang"}</Badge>
                        {b.hasApiKey && <Badge>key</Badge>}
                        {backendChips(b, conn).map((c) => (
                          <Badge key={c}>{c}</Badge>
                        ))}
                      </div>
                      <div className="mt-1 flex items-center gap-2 font-mono text-[12px] text-dim">
                        {/* The card is the audit surface — non-security sync categories still apply
                            silently, so this is where a user checks where dictation goes. Two ways
                            that went wrong. A URL's real authority is whatever follows the last `@`,
                            and the truncate class hides the tail, so `http://localhost:8000@evil.tld/v1`
                            read as loopback — hence the parsed host and the badge. And this line
                            showed the CANONICAL address while every request goes to
                            `effectiveServerUrl`, which prefers a per-backend URL override: the
                            override applies whether or not sync is on, survives turning sync off,
                            and the Test button beside this line already used it. So the row could
                            name one host while the audio and the bearer key went to another. Show
                            the address actually used, and say so when it isn't the configured one. */}
                        <span className="truncate" title={safeDisplayText(eff, 200)}>
                          {safeIdentityText(auth?.host, 80) || safeIdentityText(eff, 80)}
                        </span>
                        {auth?.hasUserinfo && (
                          <Badge tone="warn">address hides the real host</Badge>
                        )}
                        {eff !== b.serverUrl && (
                          <span title={`Configured: ${safeDisplayText(b.serverUrl, 200)}`}>
                            <Badge tone="warn">override in use</Badge>
                          </span>
                        )}
                        {/* No model = the server's default: no separator dangling before nothing. */}
                        {b.model.trim() && (
                          <>
                            <span className="text-faint">·</span>
                            <span className="text-faint">{safeDisplayText(b.model, 80)}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex w-24 items-center justify-end gap-1.5 text-[12px] text-dim" title={conn?.error}>
                      <StatusDot tone={testing.has(b.id) ? "idle" : conn?.ok ? "ok" : conn?.error ? "warn" : "idle"} />
                      {testing.has(b.id) ? "testing…" : conn?.ok ? "connected" : conn?.error ? "error" : "untested"}
                    </div>
                    <div className="flex items-center gap-1">
                      <ServerInfoButton
                        info={ownProp(caps, b.id)?.server_info}
                        open={infoOpen === b.id}
                        onToggle={() => setInfoOpen((cur) => (cur === b.id ? null : b.id))}
                        controls={`${infoBase}-${b.id}`}
                      />
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
                  </div>
                  {infoOpen === b.id && ownProp(caps, b.id)?.server_info && (
                    <div className="mt-4 border-t border-line pt-4">
                      <ServerInfoPanel id={`${infoBase}-${b.id}`} info={ownProp(caps, b.id)?.server_info} reportApp={reportApp} />
                    </div>
                  )}
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
