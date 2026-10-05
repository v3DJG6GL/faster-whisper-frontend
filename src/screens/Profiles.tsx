import { useEffect, useState } from "react";
import { screenEyebrow, screenTitle } from "@/lib/screenRegistry";
import { useSearchParams } from "react-router-dom";
import { Mic, Hand, Pencil, Copy, Trash2, AlertTriangle, Info, Server, Command } from "lucide-react";
import { useApp } from "@/lib/store";
import { Badge, Button, Card, ConfirmLeave, RouteBadge, DisclosureCard, EditorHeader, Labeled, ListScreenHeader, Notice, Segmented, SectionLabel, Select, SetSummary, TextInput, Toggle } from "@/components/ui";
import { OverrideHeader, OverrideText } from "@/components/OverrideField";
import { OVERRIDE_CONTROL_W } from "@/components/styles";
import { countSet } from "@/lib/decodeKeys";
import { envDesc } from "@/lib/envDesc";
import { isDirty, useUnsavedGuard } from "@/lib/useUnsavedGuard";
import { HotkeyChips } from "@/components/HotkeyChips";
import { starterProfiles } from "@/lib/starters";
import { TriggerTile } from "@/components/TriggerTile";
import { DecodeFields } from "@/components/DecodeFields";
import { LiveDictationFields } from "@/components/LiveDictationFields";
import { dictationControls, FIELD_LABEL } from "@/components/DictationFields";
import { hasInsertionOverrides, insertionSetCount } from "@/lib/dictation/insertion";
import { TranslationDefaultsEditor, type TranslationInherited } from "@/components/TranslationFields";
import { targetsLabel } from "@/lib/translationTargets";
import { inheritLabel, LOCKED_REASON, onOff, serverContextSegments, serverInherited, serverLanguageLabel } from "@/lib/inherit";
import { SpokenLanguagePicker } from "@/components/LanguagePicker";
import { ModelPicker } from "@/components/ModelPicker";
import { OverrideProfilePicker } from "@/components/OverrideProfilePicker";
import { ReorderControls } from "@/components/ReorderControls";
import { languageLabel, namedLanguage, offersMultilingual, spokenField, spokenLabel, spokenValue } from "@/lib/languages";
import { useBackendModels } from "@/lib/useBackendModels";
import { conflicts as chordConflicts, conflictsByProfile, findChordConflict, quickAddPeer, QUICK_ADD_PEER_ID } from "@/lib/hotkeyConflicts";
import { useHotkeyCapture } from "@/lib/useHotkeyCapture";
import { evdevStatus, type EvdevStatus } from "@/lib/api";
import { IS_LINUX, IS_WINDOWS } from "@/lib/platform";
import { deriveChipTag } from "@/lib/profileTag";
import { effectiveServerKind } from "@/lib/serverKind";
import { backendOptions, backendPrompt, effectiveServerUrl } from "@/lib/backends";
import { withBackendChips } from "@/lib/backendChipLabels";
import { backendForProfile } from "@/lib/dictation/dictation";
import { liveAllowed } from "@/lib/dictation/streaming";
import { configuredRouteTargets } from "@/lib/dictation/chipController";
import { useOverrideContext } from "@/lib/useOverrideContext";
import { useDecodeDefaults } from "@/lib/useDecodeDefaults";
import { NO_OVERRIDE_PROFILE, type Profile, type TranslationOverrides } from "@/lib/types";
import { cn } from "@/lib/cn";
import { safeDisplayText } from "@/lib/sanitize";
import { ownProp } from "@/lib/own";

const ACTIVATION = {
  hold: { icon: Mic, label: "Push-to-talk", hint: "Hold the hotkey while you speak; release to stop." },
  handsfree: { icon: Hand, label: "Hands-free", hint: "Tap once to start, tap again to stop." },
} as const;

/** What a profile's empty translation fields inherit: its backend's values. For the targets
 *  dictation stops at the backend — none there means no translation (streaming.ts trOv). */
function translationInherited(t: TranslationOverrides | undefined, serverContext: number | undefined): TranslationInherited {
  return {
    targets: targetsLabel(t?.translateTo, "no translation"),
    model: t?.model ? safeDisplayText(t.model, 60) : "server default",
    mode: t?.mode === "fluent" ? "Fluent" : t?.mode === "faithful" ? "Faithful" : undefined,
    contextSegments: t?.contextSegments ?? serverContext,
    glossary: t?.glossary,
    includeOriginal: t?.includeOriginal ?? false,
  };
}

/** Why a batch profile's live-dictation block does nothing. */
const LIVE_BATCH_REASON = "Live dictation only: this profile uses the Batch endpoint, which sends the audio once after you stop.";

function blankProfile(backendId: string | null): Profile {
  return { id: crypto.randomUUID(), name: "New profile", activation: "hold", enabled: true, hotkey: [], backendId };
}

// useHotkeyCapture moved to src/lib/useHotkeyCapture.ts (shared with the Settings
// "quick-add shortcut" row).

function Editor({
  initial,
  others,
  onSave,
  onCancel,
}: {
  initial: Profile;
  others: Profile[];
  /** `takeovers`: bindings whose shortcut this profile took ("Use it here") — cleared on save. */
  onSave: (p: Profile, takeovers: string[]) => void;
  onCancel: () => void;
}) {
  const backends = useApp((s) => s.backends);
  const connections = useApp((s) => s.connections);
  const evdevEnabled = useApp((s) => s.settings.general.evdevEnabled);
  const globalTypeAsISpeak = useApp((s) => s.settings.general.typeAsISpeak);
  const globalInsertMethod = useApp((s) => s.settings.general.insertMethod);
  const globalPasteShortcut = useApp((s) => s.settings.general.pasteShortcut);
  const globalAutoEnter = useApp((s) => s.settings.general.autoEnter);
  const globalRestoreClipboard = useApp((s) => s.settings.general.restoreClipboard);
  // A low-level backend owns the chords when evdev is enabled AND permitted (Linux) or always on
  // Windows (the hook backend) — same gate as the Dictionary screen's QuickAddShortcutField
  // (formerly the Settings quick-add row), so both rebind surfaces accept the same chords (useHotkeyCapture commits modifier-only / AltGr chords ONLY then).
  // Gating on `evdevEnabled` alone would let this editor accept a chord that can't fire when
  // evdev is toggled on but not permitted.
  const [evdev, setEvdev] = useState<EvdevStatus | null>(null);
  useEffect(() => {
    void evdevStatus().then(setEvdev).catch(() => {}); // match Settings' chain; ignore an IPC reject
  }, []);
  const lowLevelActive = IS_WINDOWS || (!!evdev?.permitted && evdevEnabled);
  const [p, setP] = useState<Profile>(initial);
  const [capturing, setCapturing] = useState(false);
  // Shortcuts taken from other bindings in this edit ("Use it here"); applied with Save, so
  // Cancel leaves them untouched.
  const [takeovers, setTakeovers] = useState<string[]>([]);
  // Every disclosure starts closed; its header's "· n set" says whether it holds anything.
  const [showDecode, setShowDecode] = useState(false);
  const [showLive, setShowLive] = useState(false);
  const [showInsertion, setShowInsertion] = useState(false);
  const [showTranslation, setShowTranslation] = useState(false);
  const set = (patch: Partial<Profile>) => setP((x) => ({ ...x, ...patch }));
  // Resolve the target backend so the decode editor can show its defaults as the
  // inherited baseline and gate to the backend's detected capability.
  const boundBackend = backends.find((b) => b.id === p.backendId);
  // Dictation runs a profile whose backend is gone (or unset) on the FIRST backend
  // (dictation.ts backendForProfile) — preview that one too, and say so on the field.
  const backend = boundBackend ?? backends[0];
  // The backend's advertised models feed the per-profile model override picker
  // (probes once per session when the connection cache is empty).
  const models = useBackendModels(backend);
  const serverKind = backend
    ? effectiveServerKind(backend, p.backendId ? ownProp(connections, p.backendId) : undefined)
    : "unknown";
  // The effective override-profile (Profile over Backend) and the caller's
  // capabilities, so the decode editor gates on what this connection allows.
  const effectiveProfile = p.overrideProfile?.trim() ? p.overrideProfile.trim() : backend?.overrideProfile;
  // Per-device address override wins for the actual requests (display
  // contexts elsewhere keep showing the canonical serverUrl).
  const serverUrl = backend ? effectiveServerUrl(backend, useApp.getState().settings) : "";
  const { caps } = useOverrideContext({ serverUrl, backendId: backend?.id ?? null, serverKind });
  // What the server gives this profile's requests (its model + override profile), with the
  // backend's defaults over it — in live dictation's terms when the profile streams.
  const decodeDefaults = useDecodeDefaults({
    serverUrl,
    backendId: backend?.id ?? null,
    model: p.model?.trim() || backend?.model,
    profileName: effectiveProfile,
    serverKind,
  });
  const streams = (p.endpoint ?? backend?.endpoint ?? "stream") === "stream";
  const server = serverInherited(decodeDefaults, backend?.decodeOverrides, streams ? "stream" : "batch", "Backend default");
  // "Multiple languages" is the profile's `multilingual` decode override over its backend's —
  // sent with every request, the streaming handshake included.
  const multiOffered = offersMultilingual({
    canOverride: caps?.can_request_decode_overrides,
    locked: server.locked.has("multilingual"),
    standard: serverKind === "standard",
    model: p.model?.trim() || backend?.model,
  });
  const multiInherited = typeof server.values.multilingual === "boolean" ? server.values.multilingual : undefined;
  const spoken = spokenField(p.language ?? "", p.decodeOverrides, multiInherited, multiOffered);
  // The "Vocabulary / prompt" this profile inherits when it sets none: the backend's
  // own prompt, else the server's default prompt. Read through the backend's TRI-state —
  // a backend whose prompt is explicitly CLEARED inherits nothing, so ghosting the server's
  // DEFAULT_PROMPT under it would promise a prompt this profile will never send. A prompt
  // the server locks wins over both (the request's prompt is ignored).
  const backendPromptOverride = backend ? backendPrompt(backend) : undefined;
  const promptLocked = server.prompt?.locked === true;
  const inheritedPrompt = (promptLocked ? server.prompt?.value : (backendPromptOverride ?? server.prompt?.value)) ?? "";
  // Unknown (server unreachable, backend inherits) leaves the bare "Inherit".
  const inheritedPromptText =
    promptLocked || backendPromptOverride !== undefined || decodeDefaults ? inheritedPrompt || "no prompt" : undefined;
  const promptOverridden = p.prompt !== undefined; // "" = explicit clear, value = set

  const capture = useHotkeyCapture({
    capturing,
    lowLevelActive,
    // A binding whose keys this edit already took no longer clashes.
    others: others.map((o) => (takeovers.includes(o.id) ? { ...o, hotkey: [] } : o)),
    selfKind: p.activation === "handsfree" ? "handsfree" : "hold",
    onCommit: (codes) => {
      set({ hotkey: codes });
      setCapturing(false);
    },
    onCancel: () => setCapturing(false),
    onTakeOver: (id) => setTakeovers((t) => (t.includes(id) ? t : [...t, id])),
  });

  const Glyph = ACTIVATION[p.activation].icon;

  // Unsaved-work guard: this form runs well past a screen height, and until it
  // grew a top exit the only way out was a Cancel button below the fold — while
  // a sidebar click discarded everything in silence.
  const dirty = isDirty(p, initial);
  const guard = useUnsavedGuard(dirty);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Not while capturing a chord — Esc cancels the capture there.
      if (e.key === "Escape" && !capturing && !guard.asking) guard.guardExit(onCancel);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const save = () =>
    onSave(
      {
      ...p,
      name: p.name.trim() || "Untitled profile",
      // Empty = derive the chip tag from the name → store as undefined (omitted).
      tag: p.tag?.trim() ? p.tag.trim() : undefined,
      // Empty override = inherit from the Backend → store as undefined (omitted).
      model: p.model?.trim() ? p.model.trim() : undefined,
      language: p.language?.trim() ? p.language : undefined,
      // prompt is tri-state: undefined = inherit, "" = explicit clear (suppress the
      // inherited prompt), value = override. Preserve "" — do NOT prune it to
      // undefined, or "clear" would silently become "inherit".
      prompt: p.prompt,
      overrideProfile: p.overrideProfile?.trim() ? p.overrideProfile.trim() : undefined,
      // An override object with nothing in it is "inherit everything" — store it as absent,
      // or `isDirty` reports a change the moment the disclosure is opened.
      insertionOverrides: hasInsertionOverrides(p.insertionOverrides) ? p.insertionOverrides : undefined,
      },
      // Only a take-over the saved chord still needs: re-recording something else since
      // leaves the other binding alone.
      takeovers.filter((id) => {
        const o = others.find((x) => x.id === id);
        return !!o && !!findChordConflict(p.hotkey, [o], !lowLevelActive, p.activation === "handsfree" ? "handsfree" : "hold");
      }),
    );

  return (
    <Card className="p-6">
      <EditorHeader
        onBack={() => guard.guardExit(onCancel)}
        title={p.name.trim() || "New profile"}
        subtitle={
          <span className="inline-flex items-center gap-1.5">
            <Glyph className="size-3 text-accent" />
            Dictation profile · {ACTIVATION[p.activation].hint}
          </span>
        }
        dirty={dirty}
        saveLabel="Save profile"
        onSave={save}
      />
      {guard.asking && (
        <ConfirmLeave
          what="profile"
          onSaveAndLeave={() => guard.saveAndLeave(save)}
          onDiscard={guard.leave}
          onStay={guard.stay}
        />
      )}

      {/* Shortcut Field D80 B: the shortcut and how its keys behave are one object, beside the
          profile's name — a tile across the full width was mostly empty strip. Name and tag are
          short, so they take a third and the tile two. */}
      <div className="grid grid-cols-3 items-start gap-4">
        <div className="flex flex-col gap-4">
          <Labeled label="Name">
            <TextInput value={p.name} onChange={(e) => set({ name: e.target.value })} placeholder="Email — German" />
          </Labeled>
          <Labeled label="Chip tag">
            <TextInput
              value={p.tag ?? ""}
              // A blank (or whitespace-only) tag is stored as absent — the save path trims — or a
              // set-then-clear read as "unsaved" forever (the sibling controls normalise alike).
              onChange={(e) => set({ tag: e.target.value.trim() ? e.target.value : undefined })}
              placeholder={deriveChipTag(p.name) || "From name"}
              maxLength={16}
            />
          </Labeled>
        </div>
        <div className="col-span-2">
          <TriggerTile
            purpose="dictation"
            codes={p.hotkey}
            capturing={capturing}
            capture={capture}
            activation={p.activation}
            onActivationChange={(v) => set({ activation: v })}
            onToggle={() => setCapturing((c) => !c)}
            onRetry={() => {
              capture.dismissPending();
              setCapturing(true);
            }}
            onClear={() => set({ hotkey: [] })}
          />
        </div>
      </div>

      {/* What the platform's hotkey backend can bind: right under the trigger tile, across the
          full width (in the narrow name column it took several lines). */}
      <div className="mt-3 flex items-start gap-2 text-[12px] text-faint">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        {IS_LINUX ? (
          <>
            On Wayland, push-to-talk (and modifier-only / AltGr chords) need the evdev backend (Settings →
            Permissions). Hands-free works everywhere; you can also bind it in your desktop’s shortcut settings.
          </>
        ) : (
          <>
            Every chord type works globally on Windows — push-to-talk, hands-free, modifier-only (like
            Ctrl+Shift), and left/right-specific modifiers.
          </>
        )}
      </div>

      {/* Laid out like the Backends editor: the plain fields are rows in one card, and decode,
          insertion and translation each get their OWN disclosure (all closed when the editor
          opens; the open one is accented). */}
      <div className="mt-5 rounded-card border border-line bg-surface-2/40 px-[18px] py-1">
        <OverrideHeader title="Backend" env={false}>
          <div className={OVERRIDE_CONTROL_W}>
            <Select
              ariaLabel="Backend"
              value={backends.some((b) => b.id === p.backendId) ? p.backendId! : ""}
              onChange={(v) => set({ backendId: v || null })}
              options={
                backends.length
                  ? [
                      // Surface an orphaned/cleared backendId (e.g. its backend was deleted)
                      // so the shown value matches state instead of silently picking the first.
                      ...(backends.some((b) => b.id === p.backendId)
                        ? []
                        : [{ value: "", label: "No backend" }]),
                      // This Select DECIDES which server a profile sends its audio and key to,
                      // and a backend rename raises no SecurityChange — so a hostile sync server
                      // can relabel the options silently. Same defanging as the sync-server
                      // picker, for the same reason.
                      ...withBackendChips(backendOptions(backends), backends, connections),
                    ]
                  : [{ value: "", label: "No backends — add one" }]
              }
            />
          </div>
          {!boundBackend && backend && (
            <Notice className="mt-1">
              {p.backendId
                ? "The backend this profile used was deleted."
                : "No backend picked for this profile."}{" "}
              Dictation uses “{safeDisplayText(backend.name, 60) || "your first backend"}” (your first
              backend) until you pick one.
            </Notice>
          )}
        </OverrideHeader>
        <OverrideHeader title="DEFAULT_LANGUAGE" desc={envDesc("DEFAULT_LANGUAGE")} overridden={!!p.language}>
          <div className={OVERRIDE_CONTROL_W}>
            <SpokenLanguagePicker
              ariaLabel="Language"
              value={spoken.value}
              multi={multiOffered}
              onChange={(v) => {
                const { language, overrides } = spoken.pick(v);
                set({ language: language || undefined, decodeOverrides: overrides && Object.keys(overrides).length ? overrides : undefined });
              }}
              inheritLabel={inheritLabel(
                !backend
                  ? undefined
                  : backend.language === ""
                    ? // The backend leaves it to the server: name the server's language.
                      serverLanguageLabel(decodeDefaults)
                    : spokenLabel(spokenValue(backend.language || "auto", undefined, multiInherited)),
              )}
            />
          </div>
        </OverrideHeader>
        <OverrideHeader title="DEFAULT_MODEL" desc={envDesc("DEFAULT_MODEL")} overridden={!!p.model}>
          <div className={OVERRIDE_CONTROL_W}>
            <ModelPicker
              ariaLabel="Model"
              value={p.model ?? ""}
              onChange={(v) => set({ model: v || undefined })}
              models={models}
              defaultLabel={inheritLabel(
                backend?.model || (p.model ? undefined : decodeDefaults?.model) || (backend ? "server model" : undefined),
              )}
            />
          </div>
        </OverrideHeader>
        <OverrideHeader title="Endpoint" env={false} overridden={p.endpoint !== undefined}>
          {/* Same switch as the Backends editor, plus the tri-state "Inherit" the other
              overrides have — mirroring the Server-type Segmented's Auto sentinel. */}
          <Segmented
            ariaLabel="Endpoint"
            value={p.endpoint ?? "inherit"}
            onChange={(v) => set({ endpoint: v === "inherit" ? undefined : v })}
            options={[
              {
                value: "inherit",
                label: inheritLabel(backend ? (backend.endpoint === "batch" ? "Batch" : "Streaming") : undefined),
              },
              { value: "stream", label: "Streaming" },
              { value: "batch", label: "Batch" },
            ]}
          />
          {/* Mirror the Backends editor's standard-server warning for a PROFILE-forced stream
              (an inherited stream endpoint already warns over there). */}
          {p.endpoint === "stream" && serverKind === "standard" && (
            <Notice className="mt-1">
              A standard Whisper server has no streaming endpoint — this override won’t work on{" "}
              <span className="font-medium">{safeDisplayText(backend?.name, 80) || "this backend"}</span>.
            </Notice>
          )}
        </OverrideHeader>
        <OverrideHeader
          title="DEFAULT_PROMPT"
          desc={envDesc("DEFAULT_PROMPT")}
          overridden={promptOverridden}
          lockReason={promptLocked ? LOCKED_REASON : undefined}
          onClear={() => set({ prompt: "" })}
          canClear={p.prompt !== ""}
          clearTitle="Override with empty (suppress the inherited prompt)"
          onReset={() => set({ prompt: undefined })}
          note={promptLocked && promptOverridden ? "Ignored · locked by the server" : undefined}
          wide
        >
          {/* Tri-state: empty an existing value → "" (clear, suppresses the inherited prompt);
              reset → undefined (inherit, ghosts the baseline). */}
          <OverrideText
            ariaLabel="Vocabulary / prompt"
            rows={2}
            value={p.prompt}
            onChange={(v) => set({ prompt: v })}
            inherited={inheritedPromptText}
            fixedLabel={promptLocked ? inheritLabel(inheritedPromptText, "Set by server") : undefined}
            title={promptLocked ? LOCKED_REASON : backendPromptOverride === undefined ? server.prompt?.source : "Backend default"}
          />
        </OverrideHeader>
        {/* Rendered unconditionally (disable-not-hide): if the bound backend was deleted
            (backendId cleared), a stored overrideProfile still applies to the fallback backend at
            dictation time, so the user must be able to SEE and clear it. With no resolvable
            backend the picker degrades to its free-text path (serverKind "unknown"). */}
        <OverrideHeader title="Server override profile" env={false} overridden={!!p.overrideProfile} last>
          <div className={OVERRIDE_CONTROL_W}>
            <OverrideProfilePicker
              serverUrl={backend ? effectiveServerUrl(backend, useApp.getState().settings) : ""}
              backendId={backend?.id ?? ""}
              serverKind={serverKind}
              canRequest={caps?.can_request_override_profile}
              value={p.overrideProfile ?? ""}
              inheritLabel={
                backend?.overrideProfile === NO_OVERRIDE_PROFILE
                  ? "Inherit · none"
                  : inheritLabel(backend?.overrideProfile || (backend ? "server default" : undefined))
              }
              onChange={(v) => set({ overrideProfile: v.trim() ? v : undefined })}
            />
          </div>
        </OverrideHeader>
      </div>

      <div className="mt-5">
        <DisclosureCard
          open={showDecode}
          onToggle={() => setShowDecode((v) => !v)}
          title="Decode overrides"
          summary={<SetSummary count={countSet(p.decodeOverrides, "decode")} inherit="inherit backend" />}
          hint="Only for this profile. Empty inherits the bound backend's defaults."
        >
          <DecodeFields
            value={p.decodeOverrides ?? {}}
            onChange={(v) => set({ decodeOverrides: Object.keys(v).length ? v : undefined })}
            inherited={server.values}
            sources={server.sources}
            locked={server.locked}
            pinned={server.pinned}
            ignored={server.ignored}
            known={server.known}
            languagePinned={namedLanguage(p.language || backend?.language || String(decodeDefaults?.language?.value ?? ""))}
            serverKind={serverKind}
            canCustomize={caps?.can_request_decode_overrides}
          />
        </DisclosureCard>
      </div>

      <div className="mt-5">
        <DisclosureCard
          open={showLive}
          onToggle={() => setShowLive((v) => !v)}
          title="Live dictation overrides"
          summary={
            !streams ? (
              <span className="text-faint">· not used with Batch</span>
            ) : (
              <SetSummary count={countSet(p.decodeOverrides, "live")} inherit="inherit backend" />
            )
          }
          hint={!streams ? LIVE_BATCH_REASON : "Only for this profile. Empty inherits the bound backend's defaults."}
        >
          <LiveDictationFields
            value={p.decodeOverrides ?? {}}
            onChange={(v) => set({ decodeOverrides: Object.keys(v).length ? v : undefined })}
            inherited={server.values}
            sources={server.sources}
            locked={server.locked}
            known={server.known}
            disabledReason={
              !streams
                ? LIVE_BATCH_REASON
                : serverKind === "standard" || caps?.can_request_decode_overrides === false
                  ? "This connection can't send live dictation settings."
                  : undefined
            }
            preview
          />
        </DisclosureCard>
      </div>

      <div className="mt-5">
        <DisclosureCard
          open={showInsertion}
          onToggle={() => setShowInsertion((v) => !v)}
          title="Insertion overrides"
          summary={
            <SetSummary
              count={insertionSetCount(p.insertionOverrides) + (p.typeAsISpeak !== undefined ? 1 : 0)}
              inherit="inherit global"
            />
          }
          hint="Only for this profile. Inherit takes the Settings → Dictation default; an app rule still wins over both for the app you dictate into."
        >
          {/* "Type as I speak" is the profile-scoped replacement for the old global three-way.
              It only produces a distinct outcome on a STREAMING, HANDS-FREE profile, so the other
              combinations say why (tooltip) rather than silently doing nothing. The gate is on
              the PROFILE's activation for display only — the runtime value is what liveAllowed
              tests, because the Home button and the chip's quick-launch both start a hold
              profile hands-free. */}
          {(() => {
            const effEndpoint = p.endpoint ?? backend?.endpoint;
            const batch = effEndpoint === "batch";
            const hold = p.activation === "hold";
            const why = batch
              ? "Not available with a Batch endpoint: the audio is sent once, after you stop, so there are no live phrases to insert. Switch this profile's endpoint to Streaming to enable it."
              : hold
                ? "Push-to-talk holds the chord for the whole dictation, so injected keys would fold into it — these profiles always insert on release. The Home button and the chip's quick-launch run any profile hands-free, and this setting applies there."
                : undefined;
            // The same four controls as App Rules — one component, so the labels and the
            // option order can't drift apart. Settings → Dictation keeps its own two-state rows.
            const c = dictationControls({
              value: p.insertionOverrides ?? {},
              // Same rule as `save`: an empty override object is "inherit everything" and is
              // stored as absent — here too, or set-then-revert reads as unsaved forever.
              onChange: (v) => set({ insertionOverrides: hasInsertionOverrides(v) ? v : undefined }),
              inherited: {
                insertMethod: globalInsertMethod,
                pasteShortcut: globalPasteShortcut,
                autoEnter: globalAutoEnter,
                restoreClipboard: globalRestoreClipboard,
              },
            });
            const ov = p.insertionOverrides ?? {};
            return (
              <div>
                <OverrideHeader
                  title="Type as I speak"
                  env={false}
                  hint={
                    why ??
                    "Insert each phrase into the focused field as you talk, instead of waiting until the session ends."
                  }
                  overridden={p.typeAsISpeak !== undefined}
                  disabled={batch}
                  disabledTitle={why}
                  note={hold && !batch ? "Push-to-talk inserts on release" : undefined}
                >
                  <Segmented
                    ariaLabel="Type as I speak"
                    disabled={batch}
                    value={p.typeAsISpeak === true ? "on" : p.typeAsISpeak === false ? "off" : "inherit"}
                    onChange={(v) => set({ typeAsISpeak: v === "inherit" ? undefined : v === "on" })}
                    options={[
                      { value: "inherit", label: inheritLabel(onOff(globalTypeAsISpeak)) },
                      { value: "on", label: "On" },
                      { value: "off", label: "Off" },
                    ]}
                  />
                </OverrideHeader>
                <OverrideHeader title={FIELD_LABEL.insertMethod} env={false} overridden={ov.insertMethod !== undefined}>
                  <div className={OVERRIDE_CONTROL_W}>{c.insertMethod}</div>
                </OverrideHeader>
                <OverrideHeader title={FIELD_LABEL.pasteShortcut} env={false} overridden={ov.pasteShortcut !== undefined}>
                  <div className={OVERRIDE_CONTROL_W}>{c.pasteShortcut}</div>
                </OverrideHeader>
                <OverrideHeader title={FIELD_LABEL.autoEnter} env={false} overridden={ov.autoEnter !== undefined}>
                  {c.autoEnter}
                </OverrideHeader>
                <OverrideHeader
                  title={FIELD_LABEL.restoreClipboard}
                  env={false}
                  overridden={ov.restoreClipboard !== undefined}
                  last
                >
                  {c.restoreClipboard}
                </OverrideHeader>
              </div>
            );
          })()}
        </DisclosureCard>
      </div>

      <div className="mt-5">
        <DisclosureCard
          open={showTranslation}
          onToggle={() => setShowTranslation((v) => !v)}
          title="Translation overrides"
          summary={
            <SetSummary
              count={Object.keys(p.translationOverrides ?? {}).length + (p.askTranslationTargets !== undefined ? 1 : 0)}
              inherit="inherit backend"
            />
          }
          hint="Only for this profile. Empty inherits the bound backend's defaults; dictation injects every target."
        >
          <OverrideHeader
            title="Ask for target languages"
            env={false}
            hint={
              p.activation === "hold"
                ? "Asks after you release the shortcut, before the text is inserted — a prompt while the chord is held would swallow the keys. The targets below are preselected, so Enter inserts as this profile would; 0 inserts the original only; Esc inserts nothing and keeps the transcript in History."
                : "Asks before the microphone opens. The targets below are preselected, so pressing Enter does exactly what this profile does today; 0 starts without translating; Esc cancels and nothing starts."
            }
            overridden={p.askTranslationTargets !== undefined}
          >
            <Toggle
              ariaLabel="Ask for target languages"
              checked={p.askTranslationTargets === true}
              onChange={(v) => set({ askTranslationTargets: v || undefined })}
            />
          </OverrideHeader>
          <TranslationDefaultsEditor
            value={p.translationOverrides}
            onChange={(v) => set({ translationOverrides: v })}
            caps={caps}
            // Resolved with the SAME predicate the session uses (`liveAllowed`): the
            // profile's own opinion else the Dictation-tab default, a streaming endpoint,
            // and a delivery that is safe while the chord may still be held — a push-to-talk
            // profile typing via paste/direct inserts on release, so its Mode is honoured.
            // (An app rule can still override the method per window; the editor can't
            // know the window, so profile-else-global is the closest honest read.)
            liveInsert={liveAllowed({
              wants: p.typeAsISpeak ?? globalTypeAsISpeak,
              endpoint: p.endpoint ?? backend?.endpoint ?? "stream",
              activation: p.activation,
              method: p.insertionOverrides?.insertMethod ?? globalInsertMethod,
            })}
            inherited={translationInherited(backend?.translationOverrides, serverContextSegments(decodeDefaults))}
            inheritedModel={backend?.translationOverrides?.model}
            inheritedFrom={backend?.translationOverrides?.contextSegments !== undefined ? "backend" : "server"}
          />
        </DisclosureCard>
      </div>

      <div className="mt-6 flex items-center justify-between">
        <Button variant="ghost" onClick={() => guard.guardExit(onCancel)}>
          Cancel
        </Button>
        <Button variant="accent" onClick={save}>
          Save profile
        </Button>
      </div>
    </Card>
  );
}

function ProfileRow({
  p,
  backendName,
  backendLanguage,
  backendTargets,
  conflictText,
  canUp,
  canDown,
  onMoveUp,
  onMoveDown,
  onEdit,
  onDuplicate,
  onRemove,
}: {
  p: Profile;
  backendName: string;
  /** The bound Backend's language — the fallback half of the effective-language
   *  resolution the chip does (a set Profile override wins). Resolved by the parent,
   *  which holds the backend list. */
  backendLanguage?: string;
  /** The bound Backend's translate-to defaults — the inherited half of the route. */
  backendTargets?: string[];
  conflictText: string | null;
  canUp: boolean;
  canDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const updateProfile = useApp((s) => s.updateProfile);
  const meta = ACTIVATION[p.activation];
  const Glyph = meta.icon;
  const effLangCode = p.language?.trim() ? p.language : backendLanguage;
  const effLang = effLangCode ? languageLabel(effLangCode) : "";
  return (
    <Card className={cn("p-5", conflictText && "border-warn/40")}>
      <div className="flex items-center gap-4">
        <ReorderControls canUp={canUp} canDown={canDown} onUp={onMoveUp} onDown={onMoveDown} />
        <div
          className={cn(
            "grid size-10 place-items-center rounded-xl",
            p.activation === "handsfree" ? "bg-accent-soft text-accent" : "bg-surface-2 text-accent",
          )}
        >
          <Glyph className="size-[18px]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-semibold text-text">{safeDisplayText(p.name, 80)}</span>
            {p.tag?.trim() && <Badge tone="accent">{safeDisplayText(p.tag.trim(), 40)}</Badge>}
            <Badge>{meta.label}</Badge>
            {/* The dictation ROUTE, not just the input language: a translating profile's
                row would otherwise say "German" about output that lands in French. The
                effective language mirrors chipPayload's resolution exactly (profile
                override, else the bound backend), so the row can't disagree with the chip. */}
            <RouteBadge
              source={effLang}
              targets={configuredRouteTargets(p, { translationOverrides: { translateTo: backendTargets } })}
            />
            {p.model && <Badge>{safeDisplayText(p.model.split("/").pop() ?? p.model, 40)}</Badge>}
            {p.endpoint && <Badge>{p.endpoint}</Badge>}
          </div>
          <div className="mt-1.5 flex items-center gap-3">
            <HotkeyChips codes={p.hotkey} />
            <span className="inline-flex items-center gap-1 truncate text-[12px] text-dim">
              <Server className="size-3.5 text-faint" />
              {backendName}
            </span>
          </div>
        </div>
        <Toggle ariaLabel={`Enable ${safeDisplayText(p.name, 80)}`} checked={p.enabled} onChange={(v) => updateProfile(p.id, { enabled: v })} />
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" title="Edit" onClick={onEdit}>
            <Pencil className="size-4" />
          </Button>
          <Button variant="ghost" size="sm" title="Duplicate" onClick={onDuplicate}>
            <Copy className="size-4" />
          </Button>
          <Button variant="ghost" size="sm" title="Remove" onClick={onRemove}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>
      {conflictText && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-[12px] text-warn">
          <AlertTriangle className="size-3.5 shrink-0" />
          {conflictText}
        </div>
      )}
    </Card>
  );
}

export default function Profiles() {
  const profiles = useApp((s) => s.profiles);
  const backends = useApp((s) => s.backends);
  const upsertProfile = useApp((s) => s.upsertProfile);
  const updateProfile = useApp((s) => s.updateProfile);
  const updateGeneral = useApp((s) => s.updateGeneral);
  const removeProfile = useApp((s) => s.removeProfile);
  const duplicateProfile = useApp((s) => s.duplicateProfile);
  const moveProfile = useApp((s) => s.moveProfile);
  const quickAddHotkey = useApp((s) => s.settings.general.quickAddHotkey);
  const evdevEnabled = useApp((s) => s.settings.general.evdevEnabled);
  // A low-level backend is live when evdev is enabled AND permitted (Linux) or always on Windows
  // (same gate as the Editor + Rust's apply_bindings). When only the plugin is live it collapses
  // L/R modifier sides, so the per-card conflict banner must collapse too — else a side-only-
  // different chord shows no conflict here yet silently clobbers one binding under the plugin.
  const [evdev, setEvdev] = useState<EvdevStatus | null>(null);
  useEffect(() => {
    void evdevStatus().then(setEvdev).catch(() => {});
  }, []);
  const lowLevelActive = IS_WINDOWS || (!!evdev?.permitted && evdevEnabled);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Profile | null>(null);
  // Checklist path: the suggested-starters card can be waved off for this visit.
  const [startersDismissed, setStartersDismissed] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  // Open the editor for a profile deep-linked from elsewhere (Home's Edit button →
  // /profiles?edit=<id>). Consume the param once so navigating back here later
  // doesn't reopen the editor.
  useEffect(() => {
    const id = searchParams.get("edit");
    if (!id) return;
    const p = profiles.find((x) => x.id === id);
    if (p) {
      setDraft(p);
      setEditingId(p.id);
      // Consume the param ONLY once the target profile exists. The store boots with seeded default
      // profiles and hydrates the real config async; consuming it on a not-yet-found id would strip
      // the deep link before hydration, so the editor would never open. An invalid id just lingers
      // harmlessly (no state change, no loop).
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, profiles, setSearchParams]);

  // Feed the per-card banner the SAME synthetic quick-add peer the Editor (others, below) and the
  // save-gate (persistence.ts) use, so a profile whose chord collides with the global quick-add
  // chord shows a banner on its own card — not just the global save freeze. All three conflict
  // surfaces now agree.
  const conflictPeers =
    quickAddHotkey.length > 0 ? [...profiles, quickAddPeer(quickAddHotkey)] : profiles;
  const conflicts = conflictsByProfile(conflictPeers, !lowLevelActive);
  // `||` not `??`: safeDisplayText returns "" for a non-string, so the fallback still applies.
  const nameOf = (id: string) =>
    id === QUICK_ADD_PEER_ID
      ? "Quick add"
      : safeDisplayText(profiles.find((p) => p.id === id)?.name, 60) || "another profile";
  const conflictText = (id: string): string | null => {
    const list = conflicts.get(id);
    if (!list || list.length === 0) return null;
    const c = list[0];
    return c.kind === "duplicate"
      ? `Same shortcut as “${nameOf(c.otherId)}” — resolve to save & register.`
      : `Overlaps “${nameOf(c.otherId)}” — one chord shadows the other.`;
  };

  const startAdd = () => {
    const p = blankProfile(backends[0]?.id ?? null);
    setDraft(p);
    setEditingId(p.id);
  };
  const startEdit = (p: Profile) => {
    setDraft(p);
    setEditingId(p.id);
  };
  const onSave = (p: Profile, takeovers: string[]) => {
    // "Use it here": the bindings this profile took its shortcut from lose theirs.
    for (const id of takeovers) {
      if (id === QUICK_ADD_PEER_ID) updateGeneral({ quickAddHotkey: [] });
      else updateProfile(id, { hotkey: [] });
    }
    upsertProfile(p);
    setDraft(null);
    setEditingId(null);
  };
  const onCancel = () => {
    setDraft(null);
    setEditingId(null);
  };

  return (
    <div className="page page-form">
      <ListScreenHeader
        eyebrow={screenEyebrow("profiles")}
        title={screenTitle("profiles")}
        icon={Command}
        showAdd={!draft}
        addLabel="Add profile"
        onAdd={startAdd}
      >
        Each profile allows you to dictate, push-to-talk or hands-free, with its own shortcut and backend.
        <br />
        You can choose a different language and prompt for each profile.
        <br />
        When using a <strong className="font-semibold text-text">faster-whisper-backend</strong> server, you can even configure
        options to automatically translate the transcriptions into your desired language!
      </ListScreenHeader>

      {draft ? (
        <div className="page-content">
          <Editor
            // Remount when the edited target changes (e.g. a deep link swaps draft while the editor
            // stays mounted) so Editor's useState(initial) re-seeds instead of stranding the prior
            // profile's fields. Normally draft just toggles null↔value, so this is inert.
            key={editingId}
            initial={draft}
            // Include the global quick-add shortcut as a pseudo-profile so capturing a chord that
            // clashes with it is WARNED: the evdev matcher silently drops the quick-add chord when
            // it duplicates a profile chord (profiles register first), so a rebind could otherwise
            // kill quick-add with no warning. Symmetric with the Dictionary screen's QuickAddShortcutField (was the Settings quick-add row), which
            // already checks against the profiles.
            others={[
              ...profiles.filter((p) => p.id !== editingId),
              ...(quickAddHotkey.length > 0 ? [quickAddPeer(quickAddHotkey)] : []),
            ]}
            onSave={onSave}
            onCancel={onCancel}
          />
        </div>
      ) : (
        <>
          <SectionLabel className="mb-3 mt-5">Configured</SectionLabel>
          {profiles.length === 0 ? (
            backends.length > 0 && !startersDismissed ? (
              // Checklist path: suggest the starter pair as amber-edged drafts on the
              // screen the user will manage them on forever. Created only on Keep.
              <Card className="border-accent/40 p-5">
                <div className="text-[13.5px] font-semibold text-text">Suggested starters</div>
                <div className="mt-0.5 text-[12.5px] text-dim">
                  Push-to-talk (hold <HotkeyChips codes={["ControlLeft", "ShiftLeft"]} />) and Hands-free
                  (tap <HotkeyChips codes={["ControlLeft", "MetaLeft"]} /> to start and stop). Keep them,
                  then edit anything.
                </div>
                <div className="mt-4 flex items-center gap-2.5">
                  <Button
                    variant="accent"
                    onClick={() => {
                      // The suggestion's chords are fixed; the quick-add chord is not.
                      // Commit a colliding starter UNBOUND rather than writing a
                      // conflict that freezes every save on the persistence gate.
                      const qa = quickAddHotkey.length > 0 ? [quickAddPeer(quickAddHotkey)] : [];
                      for (const p of starterProfiles(backends[0]?.id ?? null)) {
                        const clash = chordConflicts([...qa, p], !lowLevelActive).length > 0;
                        upsertProfile(clash ? { ...p, hotkey: [] } : p);
                      }
                    }}
                  >
                    Keep these
                  </Button>
                  <Button variant="ghost" onClick={() => setStartersDismissed(true)}>
                    Start from scratch
                  </Button>
                </div>
              </Card>
            ) : (
              <Card className="p-8 text-center text-[13.5px] text-dim">
                No profiles yet. Add one to start dictating.
              </Card>
            )
          ) : (
            <div className="flex flex-col gap-3">
              {profiles.map((p, i) => (
                <ProfileRow
                  key={p.id}
                  p={p}
                  backendName={safeDisplayText(backendForProfile(p, backends)?.name, 80) || "No backend"}
                  backendLanguage={backendForProfile(p, backends)?.language}
                  backendTargets={backendForProfile(p, backends)?.translationOverrides?.translateTo}
                  conflictText={conflictText(p.id)}
                  canUp={i > 0}
                  canDown={i < profiles.length - 1}
                  onMoveUp={() => moveProfile(p.id, "up")}
                  onMoveDown={() => moveProfile(p.id, "down")}
                  onEdit={() => startEdit(p)}
                  onDuplicate={() => duplicateProfile(p.id)}
                  onRemove={() => removeProfile(p.id)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
