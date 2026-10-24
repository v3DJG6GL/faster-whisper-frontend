import { useEffect, useId, useRef, useState } from "react";
import { screenEyebrow, screenTitle } from "@/lib/screenRegistry";
import { useSearchParams } from "react-router-dom";
import { Server, Pencil, Copy, Trash2, Plug, Loader2 } from "lucide-react";
import { useApp } from "@/lib/store";
import { Badge, Button, Card, ConfirmLeave, DisclosureCard, EditorHeader, Labeled, ListScreenHeader, Notice, Segmented, SectionLabel, SetSummary, StatusDot, TextInput } from "@/components/ui";
import { OverrideHeader, OverrideText } from "@/components/OverrideField";
import { OVERRIDE_CONTROL_W } from "@/components/styles";
import { ServerInfoButton, ServerInfoPanel } from "@/components/ServerInfoPanel";
import { backendChips, ownModelName } from "@/lib/backendChipLabels";
import { countSet } from "@/lib/decodeKeys";
import { envDesc } from "@/lib/envDesc";
import { isDirty, useUnsavedGuard } from "@/lib/useUnsavedGuard";
import { DecodeFields } from "@/components/DecodeFields";
import { LiveDictationFields } from "@/components/LiveDictationFields";
import { TranslationDefaultsEditor } from "@/components/TranslationFields";
import { countTranslationOverrides, targetsLabel, wireCodes } from "@/lib/translationTargets";
import {
  inheritLabel, LOCKED_REASON, serverContextSegments, serverInherited, serverLanguageLabel, shortModelName,
} from "@/lib/inherit";
import { SpokenLanguagePicker } from "@/components/LanguagePicker";
import { ModelPicker } from "@/components/ModelPicker";
import { OverrideProfilePicker } from "@/components/OverrideProfilePicker";
import { ReorderControls } from "@/components/ReorderControls";
import { namedLanguage, offersMultilingual, spokenField, spokenText, spokenValue } from "@/lib/languages";
import { testConnection, setBackendKey, deleteBackendKey, syncPull } from "@/lib/api";
import type { Backend, ConnectionInfo } from "@/lib/types";
import type { SyncRemoteState } from "@/lib/sync/syncTypes";
import { restorableCategories } from "@/lib/sync/sync";
import { classifyConnection, effectiveServerKind } from "@/lib/serverKind";
import { authorityOf, backendForAddress, backendPrompt, backendPromptFields, effectiveLanguage, effectiveServerUrl, insecureUrlWarning, newBackendDraft, normalizeUrl, storedTypedUrl, stripUrlNoise, typedServerUrl } from "@/lib/backends";
import { backendDisplayName, peerDeviceName, safeDisplayText, safeIdentityText } from "@/lib/sanitize";
import { hasOwn, ownProp } from "@/lib/own";
import { useOverrideContext } from "@/lib/useOverrideContext";
import { credentialGeneration, forgetCredential, maxTranslationTargets, refreshCaps, requestCredentialGen } from "@/lib/capabilities";
import { useDecodeDefaults } from "@/lib/useDecodeDefaults";
import { useDebounced } from "@/lib/useDebounced";
import { RestoreFromServer, SyncedCategoryChips } from "@/components/sync/SettingsSync";
import { plural, relTime } from "@/lib/format";
import { imeComposing } from "@/lib/keys";
import { adoptWrittenKey, keyWriteOutcome } from "@/lib/backendKeyWrite";

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
  // Model suggestions come from `conn` below: no background model probe here — the editor's URL
  // may be mid-edit.
  const storedConn = useApp((s) => ownProp(s.connections, initial.id));
  const syncEnabled = useApp((s) => s.settings.sync?.enabled ?? false);
  // Same guard as `effectiveServerUrl`: an inherited value here would put a FUNCTION into a controlled input's `value`.
  const urlOverride = useApp((s) => {
    const raw = s.settings.sync?.urlOverrides?.[initial.id];
    return typeof raw === "string" ? raw : "";
  });
  const setUrlOverride = useApp((s) => s.setUrlOverride);
  const [b, setB] = useState<Backend>(initial);
  const [key, setKey] = useState(initialKey ?? "");
  // Whether a key is already in the keyring — the store's live flag, so a sync pull that adds or
  // removes one shows here at once. A connect-first add carries its typed key in `initialKey`
  // with `hasApiKey` already set, but that key only reaches the keyring on save — clearing the
  // field must not leave the "stored" placeholder or flag behind (doSave agrees).
  const keyStoredNow = useApp((s) => s.backends.find((x) => x.id === b.id)?.hasApiKey ?? false);
  const keyStored = keyStoredNow && !initialKey;
  // The draft's own key flag mirrors the flag the editor OPENED with, not the live one: `initial`
  // is mount-time, so typing a key and clearing it again must land back on it — with the live flag
  // a sync pull that added or removed the key meanwhile read as unsaved work. Display uses the
  // live `keyStored`; doSave derives the saved flag from the field and the live store itself.
  const keyStoredAtOpen = initial.hasApiKey && !initialKey;
  // The address this editor's requests actually go to (the override, else Server URL), reactive so
  // a change to "Address on this device" re-runs the effects below.
  const effUrl = urlOverride.trim() || b.serverUrl;
  // Debounce the typed key and the address before they drive the best-effort capability /
  // decode-default / override-profile lookups, so typing doesn't fire a burst of requests per keystroke.
  const debouncedKey = useDebounced(key, 400);
  // Debounced on the EFFECTIVE address: these probes (getCapabilities, getDecodeDefaults,
  // listOverrideProfiles) carry the bearer credential — the typed key, or the STORED keyring key
  // Rust resolves for this id — so on the canonical url they would reach the host this device was
  // redirected away from, and the picker would offer that host's override-profile names.
  const debouncedUrl = useDebounced(effUrl, 400);
  // What the probes send: a schemeless `host:8000` gets the `http://` it is saved with
  // (storedTypedUrl), or reqwest refuses it — in Server URL and in "Address on this device" alike,
  // as `effectiveServerUrl` resolves the override. One rule for both, so the live and debounced
  // values can never pick different branches mid-debounce.
  const probeUrl = storedTypedUrl(debouncedUrl);
  // The targets of the tests in flight; only those show Test busy, since the fields stay editable
  // mid-test. Every run is kept, not just the latest: retyping an older, still-running target must
  // show it busy again, or a click starts a duplicate run. The ref is the synchronous twin (two
  // clicks in one render). A blank-key run carries the stored key's generation, so a sync pull that
  // rotates the key frees Test at once (a typed key is its own credential: gen 0, never stale).
  const [testingTargets, setTestingTargets] = useState<readonly { url: string; key: string; gen: number }[]>([]);
  const inFlightTests = useRef(new Set<{ url: string; key: string; gen: number }>());
  const curGen = requestCredentialGen(b.id, key);
  const testing = testingTargets.some((t) => t.url === effUrl && t.key === key && t.gen === curGen);
  const [result, setResult] = useState<ConnectionInfo | null>(initialResult ?? null);
  // Bumped by each successful test that still matches the typed target: the hooks below key their
  // fetches on the target and on a rise to "full", so without it a Test of an unchanged, already-full
  // server (after changing its default model or decode defaults) would leave the inherited labels,
  // model chip and Multiple-languages offer on the old values until a reopen.
  const [testGen, setTestGen] = useState(0);
  // Drop a connection-test result once the tested target changes (URL or key edited): the in-flight
  // liveTarget guard only stops a result that RESOLVES after the edit — one that already committed
  // would keep showing the OLD server's classification / models / "Connected" under the new URL.
  // Skipped while the target the result belongs to is unchanged — which covers the mount (a
  // connect-first add arrives with the connect step's still-valid result) AND StrictMode's double
  // mount, where a "first run" flag would already be spent on the second pass and wipe it.
  // `runTest` moves this ref onto the target it actually tested, and `doSave` only writes the
  // result to the store when the ref still matches what was just persisted.
  // `gen` = the backend's credential generation when the verdict was earned: a sync pull that
  // rotates the STORED key (forgetCaps) changes neither the address nor the blank key field, so a
  // blank-key verdict is only still true while the generation is unchanged. `hadKey` = whether a
  // key was stored then: a pull that ADDS one to a keyless backend moves no generation.
  const storedHasKey = (id: string) => useApp.getState().backends.find((x) => x.id === id)?.hasApiKey ?? false;
  const resultTarget = useRef({ url: effUrl, key, gen: credentialGeneration(initial.id), hadKey: storedHasKey(initial.id) });
  useEffect(() => {
    if (resultTarget.current.url === effUrl && resultTarget.current.key === key) return;
    resultTarget.current = { url: effUrl, key, gen: credentialGeneration(initial.id), hadKey: storedHasKey(initial.id) };
    setResult(null);
    // Keyed on the EFFECTIVE address: editing "Address on this device" applies live (no save), and
    // the old server's version, username and decode gate must not stay beside the new address.
  }, [effUrl, key]);
  // Saving the API key to the OS keyring can fail (locked/absent Secret Service): see doSave.
  const [savingKey, setSavingKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  // Every disclosure starts closed (a manual draft is prefilled with localhost); its header's
  // "· n set" says whether it holds anything.
  const [showConnection, setShowConnection] = useState(false);
  const [showDefaults, setShowDefaults] = useState(false);
  const [showDecode, setShowDecode] = useState(false);
  const [showLive, setShowLive] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const infoId = useId();
  const reportApp = useApp((s) => s.settings.recording.reportTargetApp);
  const [showTranslation, setShowTranslation] = useState(false);
  const set = (patch: Partial<Backend>) => setB((x) => ({ ...x, ...patch }));
  const promptOverride = backendPrompt(b);
  const promptOverridden = promptOverride !== undefined;
  // The freshest verdict for the top card and the model list: this editor's test, else the
  // session cache (the list card's tests, the Transcribe screen's probes) — but the cache only
  // while the editor still points at the target it describes. An unsaved edit of Server URL or
  // API key drops `result` above but not the store entry, which would keep "Connected", the old
  // version chips and the old server's models beside the new address.
  const storedTarget = useRef({ url: effUrl, key });
  const storedFresh = storedTarget.current.url === effUrl && storedTarget.current.key === key;
  const stored = storedFresh ? storedConn : undefined;
  // A blank-key verdict also needs the stored key unrotated and neither added nor removed
  // (`resultTarget.gen` / `hadKey`): a pull that changes it moves neither address nor key field, so
  // the reset effect above never fires and the old caller's "Connected", chips and models would stay.
  const resultLive =
    result && (key || (resultTarget.current.gen === credentialGeneration(b.id) && resultTarget.current.hadKey === keyStoredNow))
      ? result
      : null;
  const conn = resultLive ?? stored;
  // `detected` = what the freshest verdict (this editor's test, else the fresh session cache)
  // inferred; `kind` = the effective classification (a manual override wins). `kind` gates the
  // decode-override editor.
  const detected = classifyConnection(conn);
  const kind = effectiveServerKind(b, conn);
  // The hooks below fetch for the DEBOUNCED target, so they get the kind last seen while that
  // target was settled: `kind` follows the live field at once, and a typo-then-revert would flip it
  // full → unknown → full, which counts as a rise and refetches an unchanged target (and a
  // paste + Test inside the debounce would refetch the old address). Holding it until the debounce
  // lands moves the kind change and the new address into the same render — one fetch.
  const hookKindRef = useRef(kind);
  if (debouncedUrl === effUrl && debouncedKey === key) hookKindRef.current = kind;
  const hookKind = hookKindRef.current;
  // Held the same way: a paste + Test inside the debounce window must not refetch the OLD target.
  const hookTestGenRef = useRef(testGen);
  if (debouncedUrl === effUrl && debouncedKey === key) hookTestGenRef.current = testGen;
  const hookTestGen = hookTestGenRef.current;
  // A blank key field probes with the STORED key: a sync pull that replaces it bumps the
  // generation, and the hooks below then re-ask as the new caller (as resultLive does) — they
  // and the override-profile picker apply that stored-key generation rule themselves.
  const { caps: ctxCaps } = useOverrideContext({
    serverUrl: probeUrl,
    backendId: b.id,
    apiKey: debouncedKey || null,
    serverKind: hookKind,
    refresh: hookTestGen,
  });
  // The hook reads a blank address as "the saved one" (right for its other callers), but here a
  // cleared field is "no address yet": don't keep the old server's limits and privacy panel.
  const caps = effUrl.trim() ? ctxCaps : null;
  // The model is typed too: debounce it like the address so typing doesn't fetch per character.
  const debouncedModel = useDebounced(b.model ?? "", 400);
  // What the server gives this backend's requests (its model + override profile) — the values
  // its blank decode fields and prompt inherit. Batch terms: the backend serves both.
  const decodeDefaults = useDecodeDefaults({
    serverUrl: probeUrl,
    backendId: b.id,
    apiKey: debouncedKey || null,
    model: debouncedModel,
    profileName: b.overrideProfile,
    serverKind: hookKind,
    refresh: hookTestGen,
  });
  const server = serverInherited(decodeDefaults);
  // The backend's own model, if it names one: on a full server the `whisper-1` alias (a new
  // backend's default) loads the server's DEFAULT_MODEL, so it reads as inherited, as the chips
  // and ModelPicker do. On a standard (OpenAI-compatible) server it is the real model sent.
  const ownModel = ownModelName(b.model, kind);
  // The header's device chip: /v1/models doesn't say which listed model is the server default, so
  // a backend on it gets the name the server resolved for exactly this request — only while the
  // address, key and model it was fetched for are still the ones typed (else the previous typing's
  // resolution would name the chip). Without it, modelDevice falls back to the listed consensus.
  const chipModel =
    !ownModel && decodeDefaults?.model && debouncedUrl === effUrl && debouncedKey === key && debouncedModel.trim() === b.model.trim()
      ? decodeDefaults.model
      : b.model;
  const chips = backendChips({ model: chipModel }, conn ?? undefined);
  // "Multiple languages" is the backend's default `multilingual` decode override.
  const multiOffered = offersMultilingual({
    canOverride: caps?.can_request_decode_overrides,
    locked: server.locked.has("multilingual"),
    standard: kind === "standard",
    // The model the server resolved when known: on the default model it is DEFAULT_MODEL, which
    // may be English-only.
    model: decodeDefaults?.model || debouncedModel,
  });
  // The coded value a request sends (a synced "english" / " de " reads English / German, " auto "
  // folds to Multiple languages like the picker); the stored value changes only on a pick —
  // spoken.pick uses the picked value, never this one.
  const sentLanguage = effectiveLanguage(undefined, b.language);
  const spoken = spokenField(sentLanguage, b.decodeOverrides, server.values.multilingual, multiOffered);
  // What a request on the language "Default" row inherits: that pick drops the backend's own
  // `multilingual`, so the server's (a locked one included) decides whether auto-detect runs as
  // Multiple languages — folded the way spokenField folds the picker's own rows.
  const multiInherited = server.values.multilingual === true;
  const promptLocked = server.prompt?.locked === true;

  // The Server URL / API-key fields stay editable during an in-flight test, so a result that
  // resolves after the user edits them describes a server they've already moved off: track the
  // live target and only commit a test whose URL+key still match.
  // The EFFECTIVE url on both sides: this screen shows the effective address, so a verdict earned
  // by testing `b.serverUrl` while an override points somewhere else would describe a different
  // host than the one displayed next to it.
  const liveTarget = useRef({ url: effUrl, key });
  liveTarget.current = { url: effUrl, key };

  const runTest = async () => {
    // A test of this exact target is already running: no duplicate run.
    const runGen = requestCredentialGen(b.id, key);
    for (const t of inFlightTests.current) if (t.url === effUrl && t.key === key && t.gen === runGen) return;
    const testedUrl = effUrl;
    const testedKey = key;
    // Taken BEFORE the await, as the list card's handleTest does: a pull that rotates the stored
    // key mid-test makes a blank-key verdict describe the old caller. The full generation (not
    // runGen) rides on the result: `resultLive` and doSave compare it once the key field is blanked.
    const gen = credentialGeneration(b.id);
    const run = { url: testedUrl, key: testedKey, gen: runGen };
    // Whether this run's answer still describes the target on screen. A blank-key run also needs
    // the stored key unrotated: once a pull rotates it, a new-caller run may already be out, and
    // this old-caller verdict landing after it must not replace its answer with one `resultLive`
    // hides (nor bump testGen). A typed key is gen 0 on both sides. Nor may the stored key
    // have come or gone: a pull that ADDS a key to a keyless backend moves no generation (the
    // list card's handleTest and useBackendModels guard the same flip).
    const hadKey = storedHasKey(b.id);
    const stillLive = () =>
      liveTarget.current.url === testedUrl &&
      liveTarget.current.key === testedKey &&
      requestCredentialGen(b.id, testedKey) === runGen &&
      (!!testedKey || storedHasKey(b.id) === hadKey);
    inFlightTests.current.add(run);
    setTestingTargets((ts) => [...ts, run]);
    try {
      const info = await testConnection({
        // The guards keep comparing the raw `testedUrl`; only the request gets the stored form
        // (a schemeless address gains http://, as doSave and `effectiveServerUrl` store/resolve it).
        serverUrl: storedTypedUrl(testedUrl),
        backendId: b.id,
        apiKey: testedKey || null,
      });
      // Local by default — the store gets this verdict in `doSave`, once the target it describes is the
      // one persisted. Writing it here would cache a DRAFT's verdict under the backend id: edit X,
      // retype the URL, Test, Cancel → `connections[X]` holds the other host's answer while X still
      // routes to the old one (and a tested-then-cancelled connect-first draft leaves an orphan entry).
      if (stillLive()) {
        resultTarget.current = { url: testedUrl, key: testedKey, gen, hadKey };
        setResult(info);
        // An unknown → full test bumps the hooks' rise counter in the same render: one refetch.
        if (info.ok) setTestGen((n) => n + 1);
        // The one case the store may take it now: the tested target is exactly the persisted
        // one (stored keyring key, same effective address, backend already saved), so the
        // verdict describes what the list card routes to — a Test-then-Cancel on an unedited
        // backend still refreshes "server came back / went away". The stored key is unrotated,
        // neither added nor removed: stillLive() above checked it, and nothing since awaits.
        const live = useApp.getState();
        const stored = live.backends.find((x) => x.id === b.id);
        if (
          stored &&
          !testedKey &&
          // Both sides in stored form first: a lenient `http:/host` override normalises to "" raw,
          // while `effectiveServerUrl` resolves it to `http://host`, so a raw compare never matches.
          typedServerUrl(testedUrl) === typedServerUrl(effectiveServerUrl(stored, live.settings))
        ) {
          setConnection(b.id, info);
        }
      }
    } catch (e) {
      // IPC reject (same guard the list card's handleTest carries) — surface the
      // failure so the editor doesn't just silently stop.
      if (stillLive()) {
        resultTarget.current = { url: testedUrl, key: testedKey, gen, hadKey };
        setResult({ ok: false, openMode: false, models: [], error: String(e) });
      }
    } finally {
      // Only this run's own marker: a run for another target keeps its spinner.
      inFlightTests.current.delete(run);
      setTestingTargets((ts) => ts.filter((t) => t !== run));
    }
  };

  // Write the API key to the keyring FIRST (awaited) and only commit + close on success, so a
  // keyring failure can't persist a backend whose "key" badge claims a key that isn't stored.
  // The latest draft and verdict, for `doSave` after its keyring await: the fields stay editable
  // while the write is parked behind a wallet prompt, and the render-time `b` would drop those edits.
  const latestB = useRef(b);
  latestB.current = b;
  const latestResult = useRef(result);
  latestResult.current = result;
  // Set on unmount (reset on mount, for StrictMode's mount → unmount → mount): a Save parked behind
  // the keyring outlives an exit the Cancel/Esc/back gates don't cover (the sidebar's guard).
  const left = useRef(false);
  useEffect(() => {
    left.current = false;
    return () => {
      left.current = true;
    };
  }, []);
  // One Save at a time: the sidebar can raise "Save and leave" while a Save's keyring write is
  // parked behind a wallet prompt. A second write (maybe a second prompt) would land after the
  // first save closed the editor, read as abandoned, and never run the navigation — so a caller
  // arriving mid-save shares the running one's result instead.
  const saving = useRef<Promise<boolean> | null>(null);
  const doSave = (): Promise<boolean> => {
    if (saving.current) return saving.current;
    const run = saveOnce();
    saving.current = run;
    const done = () => {
      if (saving.current === run) saving.current = null;
    };
    run.then(done, done);
    return run;
  };
  const saveOnce = async (): Promise<boolean> => {
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
      // Left during the write (sidebar → Discard; the editor unmounted): the user walked away from
      // this draft, so save nothing — onSave would persist it AND close whatever flow is open now.
      // Retyped during the write: the keyring holds the OLD key, so persisting now would claim
      // the new one. Keep the editor open; the next Save stores what is typed. Either way a backend
      // not in the store yet owns no keyring entry, so drop the one just written (as Onboarding
      // does); a saved one routes with it already — the store learns the key changed (its key
      // badge, the old caller's verdict and caps), and the retype message says so.
      const outcome = keyWriteOutcome({
        left: left.current,
        retyped: liveTarget.current.key !== key,
        inStore: useApp.getState().backends.some((x) => x.id === b.id),
      });
      if (outcome.kind !== "save") {
        if (outcome.rollBack) void deleteBackendKey(b.id).catch(() => {});
        if (outcome.keptInStore) adoptWrittenKey(b.id, useApp.getState(), forgetCredential);
        if (outcome.kind === "retyped") {
          setKeyError(
            outcome.rollBack
              ? "The API key changed while it was being saved, so nothing was stored. Save again to store the new key."
              : "The API key changed while it was being saved. The key typed before is stored and already in use for this backend; Save again to store the new one.",
          );
        }
        return false;
      }
    }
    const cur = latestB.current;
    const verdict = latestResult.current;
    const savedUrl = liveTarget.current.url;
    // Before onSave: a NEW key on a backend that already exists is a rotation the store can't see.
    const existed = useApp.getState().backends.some((x) => x.id === cur.id);
    // The keyring's truth for this backend now (the store re-derives it on every pull), not the
    // draft's flag, which is the mount-time one: no editor control removes a stored key.
    const liveHasKey = storedHasKey(cur.id);
    // A blank-key verdict was earned with the STORED key: still valid only if no sync pull has
    // rotated that key since (taken before the forgetCredential below bumps the generation itself),
    // nor may the stored key have come or gone. A typed-key verdict is exempt — it was tested with
    // the key just saved.
    const genOk =
      !!key || (resultTarget.current.gen === credentialGeneration(cur.id) && resultTarget.current.hadKey === liveHasKey);
    // Normalize on save (mirrors Profiles.save) so stray whitespace isn't persisted, sent to the
    // server (a padded profile name never matches a real one), or shown as a blank card.
    onSave({
      ...cur,
      // A connect-step key only reaches the keyring on THIS save — if the field
      // was cleared before saving, no key was ever stored, so don't claim one
      // (an EXISTING backend's blank field keeps whatever key the keyring holds now; a backend
      // not in the store yet holds none).
      hasApiKey: key.length > 0 || (initialKey ? false : liveHasKey),
      name: cur.name.trim() || "Untitled backend",
      serverUrl: storedTypedUrl(cur.serverUrl),
      model: cur.model.trim(),
      overrideProfile: cur.overrideProfile?.trim() ? cur.overrideProfile.trim() : undefined,
    });
    // upsertBackend evicts only when the URL or key PRESENCE changes; a rotated key keeps
    // hasApiKey true, so the old caller's connection, caps and usage (/v1/me is per-caller)
    // would stand for the session. Drop them as upsertBackend does — a verdict tested with the
    // new key is re-installed below (and forces a caps refresh); otherwise readers re-probe.
    if (key && existed) forgetCredential(cur.id);
    // Now that the target is persisted (upsertBackend's eviction has run inside onSave, and a
    // typed key reached the keyring above), cache the in-editor verdict — only if it still
    // describes the address + key that were just saved.
    if (verdict && resultTarget.current.url === savedUrl && resultTarget.current.key === key && genOk) {
      setConnection(cur.id, verdict);
    }
    return true;
  };

  // Unsaved-work guard, shared with the other editors. A typed API key counts as
  // unsaved work; "Address on this device" does not — it applies live and needs no
  // save. A draft arriving with a connect-step result is the connect-first add path:
  // the user has already paid for a connection test, so leaving would throw away
  // real work even untouched.
  const dirty = isDirty(b, initial) || key !== (initialKey ?? "") || initialResult != null;
  const guard = useUnsavedGuard(dirty);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Mid-composition the IME owns Esc (it cancels the candidate), not the editor.
      if (imeComposing(e)) return;
      if (e.key === "Escape" && !guard.asking && !savingKey) guard.guardExit(onCancel);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const serverModel = shortModelName(decodeDefaults?.model);

  return (
    <Card className="p-6">
      <EditorHeader
        // A no-op mid key-write, like Cancel and Esc: leaving would abandon the Save in flight.
        onBack={() => {
          if (!savingKey) guard.guardExit(onCancel);
        }}
        title={backendDisplayName(b.name)}
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
            <div className="truncate text-[14px] font-medium text-text">{backendDisplayName(b.name)}</div>
            <div className="truncate font-mono text-[11.5px] text-faint">{safeIdentityText(effUrl, 120) || "no address yet"}</div>
          </div>
          <span className="rounded-pill border border-line-strong px-2.5 py-0.5 text-[12px] text-dim" title={conn?.error}>
            {conn?.ok
              ? "Connected"
              : conn?.error
                ? "Error"
                : "Untested"}
          </span>
          <ServerInfoButton
            info={caps?.server_info}
            tested={!!conn?.ok && (caps != null || kind === "standard")}
            open={showInfo}
            onToggle={() => setShowInfo((v) => !v)}
            controls={infoId}
          />
        </div>
        {showInfo && caps?.server_info && <ServerInfoPanel id={infoId} info={caps.server_info} reportApp={reportApp} />}
      </div>

      <div className="mt-5">
        <DisclosureCard
          open={showConnection}
          onToggle={() => setShowConnection((v) => !v)}
          title="Connection"
          summary={<span className="text-faint">· {safeIdentityText(authorityOf(storedTypedUrl(effUrl))?.host, 60) || "no address"}</span>}
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
          {/* Per-device address override: connects THIS machine somewhere else while the canonical
              URL above stays shared through settings sync (e.g. localhost on the box running the
              server, a LAN IP elsewhere). Applied live via the store — device state, not part of the
              Backend being edited. Greyed out while sync is off, EXCEPT when one is set: it keeps
              routing every request regardless of sync (`effectiveServerUrl`), and a control that is
              in effect must stay editable so it can be cleared. */}
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
            {/* Not gated on syncEnabled: the override routes requests whether or not sync is on, and
                gets only the stored-form `http://` default, so it needs the warning as much as Server URL. */}
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
                  set({ hasApiKey: e.target.value.length > 0 || keyStoredAtOpen });
                }}
                placeholder={keyStored ? "•••••••••• (stored — leave blank to keep)" : "wk_… (optional)"}
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
                serverUrl={probeUrl}
                backendId={b.id}
                apiKey={debouncedKey || null}
                serverKind={hookKind}
                canRequest={caps?.can_request_override_profile}
                value={b.overrideProfile ?? ""}
                inheritLabel="Server default"
                onChange={(v) => set({ overrideProfile: v.trim() ? v : undefined })}
                refresh={hookTestGen}
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
              · {shortModelName(ownModel) ?? serverModel ?? "server model"} ·{" "}
              {spoken.value
                ? spokenText(spoken.value, 30)
                : safeDisplayText(serverLanguageLabel(decodeDefaults, multiInherited) ?? "server language", 30)}{" "}
              · {b.endpoint === "batch" ? "Batch" : "Streaming"}
            </span>
          }
          hint="What every profile on this backend starts from."
        >
          <OverrideHeader title="DEFAULT_MODEL" desc={envDesc("DEFAULT_MODEL")} overridden={!!ownModel}>
            <div className={OVERRIDE_CONTROL_W}>
              <ModelPicker
                ariaLabel="Model"
                // Trimmed, as a run sends it: a synced " small " is the listed model, not a
                // custom one the picker's blur would rewrite (as on Profiles).
                value={b.model.trim()}
                onChange={(v) => set({ model: v })}
                models={resultLive?.ok ? resultLive.models : stored?.ok ? stored.models : []}
                placeholder={serverModel ? inheritLabel(serverModel, "Default") : "whisper-1 / large-v3"}
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
                inheritLabel={inheritLabel(serverLanguageLabel(decodeDefaults, multiInherited), "Default")}
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
            languagePinned={namedLanguage(sentLanguage || String(decodeDefaults?.language?.value ?? ""))}
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
          summary={<SetSummary count={countTranslationOverrides(b.translationOverrides)} inherit="inherit server" />}
          hint="T2T defaults for runs and profiles on this backend (a profile can still override). Empty = the server's translation config."
        >
          <TranslationDefaultsEditor
            value={b.translationOverrides}
            onChange={(v) => set({ translationOverrides: v })}
            caps={caps}
            // The server's own values where it publishes them: TRANSLATE_TO from /v1/me (it seeds
            // the Transcribe page; dictation translates only into targets set here or on a
            // profile), TRANSLATION_CONTEXT_SEGMENTS from /v1/request-default-settings. The
            // targets are cut to the server's per-request cap, as `seedTargets` sends them.
            inherited={{
              targets: targetsLabel(
                wireCodes(caps?.translate_to_default).slice(0, maxTranslationTargets(caps)),
                "server default",
              ),
              model: "server default",
              contextSegments: serverContextSegments(decodeDefaults),
              includeOriginal: false,
            }}
            inheritedFrom="server"
          />
        </DisclosureCard>
      </div>

      {resultLive && <ConnResult info={resultLive} />}

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
          Connected — {plural(info.models.length, "model")}
          {info.openMode ? " · open mode (no auth)" : info.username ? ` · ${safeDisplayText(info.username, 60)}` : ""}.
        </>
      ) : (
        info.error
      )}
    </Notice>
  );
}

// Connect-first add flow: a connect step asks only for URL + key, then branches on what the
// server knows (mirrors first-run onboarding). Synced settings on the account → restore offer;
// otherwise the editor opens PREFILLED from the test result. Unlike onboarding, nothing is
// persisted until the editor's Save / the restore applies.

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
  // The targets of the tests in flight (mirrors the Editor's testingTargets): only those targets
  // show the buttons busy, so correcting a mistyped address mid-test re-enables Test, Cancel and
  // the manual link at once instead of after the old request times out. Every run is kept, not
  // just the latest: typing an older, still-running target back must show it busy again, or
  // Cancel would unmount with that run free to pass its liveTarget guard. The ref is the
  // synchronous twin: two Enter key-repeats in one render must not start two runs.
  const [testing, setTesting] = useState<readonly { url: string; key: string }[]>([]);
  const inFlight = useRef(new Set<{ url: string; key: string }>());
  const busy = testing.some((t) => t.url === url && t.key === key);
  const [error, setError] = useState<string | null>(null);
  // Fields stay editable during a test, so only act on a result whose target still matches what's
  // typed (mirrors the editor's liveTarget guard) — a slow test must not decide the branch with a
  // stale server's answer. Cancel/manual are enabled only while the typed target differs from
  // every run in flight, so after an unmount this stays frozen at a differing value and each
  // stale run stops here.
  const liveTarget = useRef({ url: "", key: "" });
  liveTarget.current = { url, key };
  const insecure = url.trim() ? insecureUrlWarning(url) : null;

  const testAndContinue = async () => {
    for (const t of inFlight.current) if (t.url === url && t.key === key) return;
    const typedUrl = url;
    const typedKey = key;
    // Lenient `http:/host` is canonicalised as the editor does (the warning above already judges it so).
    const serverUrl = typedServerUrl(typedUrl);
    if (!serverUrl.replace(/^https?:\/\//i, "")) {
      // Say what is wrong rather than leaving the button silent. A lone `http://` has a supported
      // scheme and no host: name the missing host. Only a scheme followed by a slash is called one —
      // `host:80o0`, `host:port` or `host:` is a bad port, not a bad scheme.
      const typed = stripUrlNoise(typedUrl.trim());
      setError(
        !typed
          ? "Enter the server’s address, like http://host:8000."
          : /^https?:/i.test(storedTypedUrl(typedUrl))
          ? "Enter the server’s host too, like http://host:8000."
          : /^[a-z][a-z0-9+.-]*:[\\/]/i.test(typed)
            ? "Enter an address like http://host:8000 — that scheme isn’t supported."
            : "Enter an address like http://host:8000 — the port after “:” must be a number.",
      );
      return;
    }
    const run = { url: typedUrl, key: typedKey };
    inFlight.current.add(run);
    setTesting((ts) => [...ts, run]);
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
        // Same gate as onboarding's offer: only a blob with something to restore opens it.
        if (p.ok && p.state?.blob && restorableCategories(p.state.blob).length > 0) {
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
      inFlight.current.delete(run);
      setTesting((ts) => ts.filter((t) => t !== run));
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
              if (!imeComposing(e) && e.key === "Enter") void testAndContinue();
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
              if (!imeComposing(e) && e.key === "Enter") void testAndContinue();
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
  // Filtered and trimmed before the truthiness test: a device named only spaces or invisible
  // characters would otherwise print a dangling "last synced from ", and one named "This device"
  // would credit this device with the server copy (`peerDeviceName`).
  const device = peerDeviceName(remote.device);

  // After the blob applied: make sure a backend for this server exists (the
  // restore may or may not have brought one — the backends category can be
  // deselected), surface the fresh test result on its card, and bind sync to it
  // (mirrors onboarding's restoreEverything).
  const finishRestore = async () => {
    const s = useApp.getState();
    const target = normalizeUrl(draft.serverUrl);
    let match = backendForAddress(s.backends, draft.serverUrl);
    if (!match) {
      s.upsertBackend(draft);
      match = draft;
    }
    // The key the user just typed and proved works belongs to whichever backend is bound —
    // the restored one for this server included, or sync ends up enabled against a backend this
    // device holds no credential for.
    if (keyTyped) {
      // A key written over an EXISTING keyed backend is a rotation upsertBackend can't see
      // (key presence is unchanged), so the old caller's caps/usage/connection would stand.
      const rotated = !!match.hasApiKey && s.backends.some((b) => b.id === match!.id);
      try {
        await setBackendKey(match.id, keyTyped);
        // Drop them as Editor.doSave does; the verdict tested with this key is re-installed
        // below (forcing a caps refresh), otherwise readers re-probe.
        if (rotated) forgetCredential(match.id);
        if (!match.hasApiKey) {
          const withKey = { ...match, hasApiKey: true };
          s.upsertBackend(withKey);
          match = withKey;
        }
      } catch (e) {
        // Don't lose an applied restore over a keyring failure: a new backend is left keyless
        // (the sync tab's no-key warning takes it from there), an existing one keeps whatever key it had.
        console.error("saving API key failed:", e);
        if (!s.backends.some((b) => b.id === match!.id)) s.upsertBackend({ ...match, hasApiKey: false });
      }
    }
    // Cache the connect step's verdict only if the backend really routes to the address it
    // was tested against: a per-device URL override can send every request to host B while
    // the canonical address is host A (the invariant handleTest / Editor.doSave already keep).
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
          {plural(info.models.length, "model")}
          {info.username ? ` · ${safeDisplayText(info.username, 60)}` : ""}
        </span>
      </div>
      <div className="mt-4 max-w-[520px] rounded-card border border-accent/40 bg-accent-soft p-4">
        <div className="text-[13.5px] font-semibold text-text">This account has synced settings</div>
        <div className="mt-1 font-mono text-[11px] text-dim">
          last synced{device ? ` from ${device}` : ""}
          {remote.updated_ts ? ` · ${relTime(remote.updated_ts * 1000)}` : ""}
        </div>
        <SyncedCategoryChips blob={remote.blob} />
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
          keyFor={keyTyped ? draft.serverUrl : undefined}
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
  /** Where requests for this backend ACTUALLY go — mirrors `effectiveServerUrl`, including its
   *  type check on the lookup: `?.` does not guard a prototype-inherited value. */
  const effectiveUrl = (b: Backend) => {
    const raw = urlOverrides?.[b.id];
    return (typeof raw === "string" ? storedTypedUrl(raw) : "") || b.serverUrl;
  };
  const upsertBackend = useApp((s) => s.upsertBackend);
  const removeBackend = useApp((s) => s.removeBackend);
  const duplicateBackend = useApp((s) => s.duplicateBackend);
  const moveBackend = useApp((s) => s.moveBackend);
  const setConnection = useApp((s) => s.setConnection);
  const [flow, setFlow] = useState<AddFlow | null>(null);
  // The targets of the list tests in flight (mirrors the Editor's testingTargets): a row shows
  // "testing…" only while a run for its CURRENT target is out, so repointing a backend mid-test
  // (Server URL save, key rotation, a live "Address on this device" override) frees its Test at
  // once instead of spinning for an address nothing is testing — that run's result is dropped by
  // the guards in handleTest anyway. Per run, not per id: two concurrent tests track
  // independently, finishing one can't clear another's spinner. The ref is the synchronous twin:
  // two clicks in one render must not start two runs for the same target.
  type ListRun = { id: string; serverUrl: string; url: string; hasKey: boolean; gen: number };
  const [testing, setTesting] = useState<readonly ListRun[]>([]);
  const inFlight = useRef(new Set<ListRun>());
  const rowTesting = (b: Backend, url: string) => {
    const gen = credentialGeneration(b.id);
    return testing.some(
      (t) => t.id === b.id && t.serverUrl === b.serverUrl && t.url === url && t.hasKey === b.hasApiKey && t.gen === gen,
    );
  };

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
    const testedUrl = effectiveServerUrl(b, useApp.getState().settings);
    // A key rotated and saved mid-test passes the serverUrl / hasApiKey / URL checks below, so the
    // credential generation catches it; the save emptied this backend's connection, and the old
    // key's verdict would sit there for the session.
    const gen = credentialGeneration(b.id);
    const run: ListRun = { id: b.id, serverUrl: b.serverUrl, url: testedUrl, hasKey: b.hasApiKey, gen };
    for (const t of inFlight.current) {
      if (t.id === run.id && t.serverUrl === run.serverUrl && t.url === run.url && t.hasKey === run.hasKey && t.gen === run.gen) return;
    }
    inFlight.current.add(run);
    setTesting((ts) => [...ts, run]);
    try {
      const info = await testConnection({
        serverUrl: testedUrl,
        backendId: b.id,
      });
      // Mirror the editor's liveTarget guard (+ upsertBackend's connection invalidation): a slow/
      // unreachable test can resolve AFTER the user edits this backend's URL, key or live "Address
      // on this device" override (the request went to the EFFECTIVE url), or removes it. Only commit
      // if the backend still exists with the same target, else we'd re-cache the OLD server's
      // classification under this id (effectiveServerKind / status dot / decode gate) or re-add a
      // dangling connection for a removed backend — and nothing re-tests on its own.
      const cur = useApp.getState().backends.find((x) => x.id === b.id);
      const curUrl = cur ? effectiveServerUrl(cur, useApp.getState().settings) : null;
      if (cur && cur.serverUrl === b.serverUrl && cur.hasApiKey === b.hasApiKey && curUrl === testedUrl && credentialGeneration(b.id) === gen) {
        setConnection(b.id, info);
      }
    } catch (e) {
      console.error("test_connection failed", e);
      const cur2 = useApp.getState().backends.find((x) => x.id === b.id);
      const curUrl2 = cur2 ? effectiveServerUrl(cur2, useApp.getState().settings) : null;
      if (cur2 && cur2.serverUrl === b.serverUrl && cur2.hasApiKey === b.hasApiKey && curUrl2 === testedUrl && credentialGeneration(b.id) === gen) {
        setConnection(b.id, { ok: false, openMode: false, models: [], error: String(e) } as ConnectionInfo);
      }
    } finally {
      inFlight.current.delete(run);
      setTesting((ts) => ts.filter((t) => t !== run));
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
              // Editor.doSave caches the connect step's verdict (its `initialResult`) only while it
              // still describes the saved address AND key, so nothing is cached here.
              onSave={(b) => handleSave(b)}
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
              const rowBusy = rowTesting(b, eff);
              // Sanitized BEFORE the presence test: a synced model of only format characters
              // (an RLM) would otherwise leave the separator dangling before nothing.
              const rowModel = safeDisplayText(ownModelName(b.model, effectiveServerKind(b, conn)), 80).trim();
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
                        <span className="truncate text-[14px] font-semibold text-text" title={backendDisplayName(b.name, 200)}>
                          {/* `safeIdentityText` (via backendDisplayName), like the address line
                              below: a rename raises no security change, so a name arrives from an
                              unattended pull with no prompt, and bidi marks or a whitespace run
                              (`"Work" + 100 spaces + "Evil"` renders as `Work` under the plain
                              display filter) could make one server read as another on the card
                              used to check where audio goes. */}
                          {backendDisplayName(b.name)}
                        </span>
                        <Badge tone="accent">{b.endpoint}</Badge>
                        {/* "" = the backend leaves the language to the server. A set language that
                            sanitizes to blank (or to joiners only) is still sent verbatim, so it
                            reads "??", not "server lang". It labels the coded value that is sent
                            (effectiveLanguage), so a synced "english" / " de " reads English /
                            German as the picker does. Multiple languages is "auto" + the
                            multilingual flag: the badge folds the backend's OWN flag back (else it
                            reads "Auto-detect"). Unlike the editor's Defaults summary it has no
                            server caps, so it neither drops a flag the model cannot honour nor
                            shows an inherited server default. */}
                        <Badge>
                          {b.language
                            ? spokenText(
                                spokenValue(
                                  effectiveLanguage(undefined, b.language),
                                  typeof b.decodeOverrides?.multilingual === "boolean" ? b.decodeOverrides.multilingual : undefined,
                                  undefined,
                                ),
                                40,
                              )
                            : "server lang"}
                        </Badge>
                        {b.hasApiKey && <Badge>key</Badge>}
                        {backendChips(b, conn).map((c) => (
                          <Badge key={c}>{c}</Badge>
                        ))}
                      </div>
                      <div className="mt-1 flex items-center gap-2 font-mono text-[12px] text-dim">
                        {/* The card is the audit surface — non-security sync categories still apply
                            silently, so this is where a user checks where dictation goes. A URL's
                            real authority follows the last `@` and the truncate class hides the
                            tail (`http://localhost:8000@evil.tld/v1` reads as loopback), hence the
                            parsed host and the badge. It shows the address requests actually use
                            (`effectiveServerUrl` prefers a per-backend override, sync on or off),
                            flagged when it isn't the configured one. */}
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
                        {/* No model = the server's default: no separator dangling before nothing. The
                            `whisper-1` alias on a full server is the server's default too (as in the
                            editor header), not a model it offers. */}
                        {rowModel && (
                          <>
                            <span className="text-faint">·</span>
                            <span className="text-faint">{rowModel}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex w-24 items-center justify-end gap-1.5 text-[12px] text-dim" title={conn?.error}>
                      <StatusDot tone={rowBusy ? "idle" : conn?.ok ? "ok" : conn?.error ? "warn" : "idle"} />
                      {rowBusy ? "testing…" : conn?.ok ? "connected" : conn?.error ? "error" : "untested"}
                    </div>
                    <div className="flex items-center gap-1">
                      <ServerInfoButton
                        info={ownProp(caps, b.id)?.server_info}
                        tested={!!conn?.ok && (ownProp(caps, b.id) != null || effectiveServerKind(b, conn) === "standard")}
                        open={infoOpen === b.id}
                        onToggle={() => setInfoOpen((cur) => (cur === b.id ? null : b.id))}
                        controls={`${infoBase}-${b.id}`}
                      />
                      <Button variant="ghost" size="sm" title="Test connection" onClick={() => handleTest(b)} disabled={rowBusy}>
                        {rowBusy ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
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
