import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Mic, Hand, Pencil, Copy, Trash2, AlertTriangle, Info, Server, RotateCcw, Eraser } from "lucide-react";
import { useApp } from "@/lib/store";
import { Badge, Button, Card, ConfirmLeave, RouteBadge, DisclosureCard, EditorHeader, Labeled, ListScreenHeader, Notice, Segmented, SectionLabel, Select, TextArea, TextInput, Toggle } from "@/components/ui";
import { isDirty, useUnsavedGuard } from "@/lib/useUnsavedGuard";
import { HotkeyChips } from "@/components/HotkeyChips";
import { starterProfiles } from "@/lib/starters";
import { HotkeyCaptureControl } from "@/components/HotkeyCaptureControl";
import { DecodeFields } from "@/components/DecodeFields";
import { dictationControls, hasInsertionOverrides, FIELD_LABEL } from "@/components/DictationFields";
import { TranslationDefaultsEditor } from "@/components/TranslationFields";
import { LanguageSelect } from "@/components/LanguageSelect";
import { ModelPicker } from "@/components/ModelPicker";
import { OverrideProfilePicker } from "@/components/OverrideProfilePicker";
import { ReorderControls } from "@/components/ReorderControls";
import { languageLabel } from "@/lib/languages";
import { useBackendModels } from "@/lib/useBackendModels";
import { conflicts as chordConflicts, conflictsByProfile, quickAddPeer, QUICK_ADD_PEER_ID } from "@/lib/conflicts";
import { useHotkeyCapture } from "@/lib/useHotkeyCapture";
import { evdevStatus, type EvdevStatus } from "@/lib/api";
import { IS_LINUX, IS_WINDOWS } from "@/lib/platform";
import { deriveChipTag } from "@/lib/profileTag";
import { effectiveServerKind } from "@/lib/serverKind";
import { backendOptions, backendPrompt, effectiveServerUrl } from "@/lib/backends";
import { backendForProfile } from "@/lib/dictation";
import { liveAllowed } from "@/lib/streaming";
import { configuredRouteTargets } from "@/lib/overlay";
import { useOverrideContext } from "@/lib/useOverrideContext";
import type { Profile } from "@/lib/types";
import { cn } from "@/lib/cn";
import { safeDisplayText } from "@/lib/sanitize";
import { ownProp } from "@/lib/own";

const ACTIVATION = {
  hold: { icon: Mic, label: "Push-to-talk", hint: "Hold the hotkey while you speak; release to stop." },
  handsfree: { icon: Hand, label: "Hands-free", hint: "Tap once to start, tap again to stop." },
} as const;

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
  onSave: (p: Profile) => void;
  onCancel: () => void;
}) {
  const backends = useApp((s) => s.backends);
  const connections = useApp((s) => s.connections);
  const evdevEnabled = useApp((s) => s.settings.general.evdevEnabled);
  const globalTypeAsISpeak = useApp((s) => s.settings.general.typeAsISpeak);
  const globalInsertMethod = useApp((s) => s.settings.general.insertMethod);
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
  // Each disclosure opens when it has something in it -- the same "open when
  // non-empty" rule the Backends editor uses for its two. The old combined
  // flag also watched model/language/endpoint/prompt/overrideProfile, which
  // now sit flat and need no flag at all.
  const [showDecode, setShowDecode] = useState(
    () => !!initial.decodeOverrides && Object.keys(initial.decodeOverrides).length > 0,
  );
  const [showInsertion, setShowInsertion] = useState(
    () => hasInsertionOverrides(initial.insertionOverrides) || initial.typeAsISpeak !== undefined,
  );
  // "Ask for target languages" lives inside this disclosure too — a profile whose only
  // translation setting is that toggle must open with it visible and read as "set".
  const [showTranslation, setShowTranslation] = useState(
    () =>
      (!!initial.translationOverrides && Object.keys(initial.translationOverrides).length > 0) ||
      initial.askTranslationTargets !== undefined,
  );
  const set = (patch: Partial<Profile>) => setP((x) => ({ ...x, ...patch }));
  // Resolve the target backend so the decode editor can show its defaults as the
  // inherited baseline and gate to the backend's detected capability.
  const backend = backends.find((b) => b.id === p.backendId);
  // The backend's advertised models feed the per-profile model override picker
  // (probes once per session when the connection cache is empty).
  const models = useBackendModels(backend);
  const serverKind = backend
    ? effectiveServerKind(backend, p.backendId ? ownProp(connections, p.backendId) : undefined)
    : "unknown";
  // The effective override-profile (Profile over Backend) and the caller's
  // capabilities, so the decode editor ghosts the profile's resolved values
  // (under the backend defaults) and gates on what this connection allows.
  const effectiveProfile = p.overrideProfile?.trim() ? p.overrideProfile.trim() : backend?.overrideProfile;
  const { caps, resolved, resolvedPrompt } = useOverrideContext({
    // Per-device address override wins for the actual requests (display
    // contexts elsewhere keep showing the canonical serverUrl).
    serverUrl: backend ? effectiveServerUrl(backend, useApp.getState().settings) : "",
    backendId: backend?.id ?? null,
    profileName: effectiveProfile,
    serverKind,
  });
  const inheritedDecode = { ...resolved, ...backend?.decodeOverrides };
  // The "Vocabulary / prompt" this profile inherits when it sets none: the backend's
  // own prompt, else the selected server override-profile's DEFAULT_PROMPT. Read
  // through the backend's TRI-state — a backend whose prompt is explicitly CLEARED
  // inherits nothing, so ghosting the server's DEFAULT_PROMPT under it would promise
  // a prompt this profile will never send (`backend.prompt || …` did exactly that,
  // because a clear and an unset prompt are the same empty string).
  const backendPromptOverride = backend ? backendPrompt(backend) : undefined;
  const inheritedPrompt = (backendPromptOverride ?? resolvedPrompt) ?? "";
  const promptOverridden = p.prompt !== undefined; // "" = explicit clear, value = set

  const { heldCodes, warn } = useHotkeyCapture({
    capturing,
    lowLevelActive,
    others,
    selfKind: p.activation === "handsfree" ? "handsfree" : "hold",
    onCommit: (codes) => {
      set({ hotkey: codes });
      setCapturing(false);
    },
    onCancel: () => setCapturing(false),
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
    onSave({
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
    });

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

      <div className="grid grid-cols-2 gap-4">
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
        <Labeled label="Activation">
          <Segmented
            value={p.activation}
            onChange={(v) => set({ activation: v })}
            options={[
              { value: "hold", label: "Push-to-talk" },
              { value: "handsfree", label: "Hands-free" },
            ]}
          />
        </Labeled>
        <Labeled label="Backend">
          <Select
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
                    ...backendOptions(backends),
                  ]
                : [{ value: "", label: "No backends — add one" }]
            }
          />
        </Labeled>
        <Labeled label="Shortcut">
          <HotkeyCaptureControl
            codes={p.hotkey}
            capturing={capturing}
            heldCodes={heldCodes}
            warn={warn}
            onToggle={() => setCapturing((c) => !c)}
            onClear={() => set({ hotkey: [] })}
          />
        </Labeled>
      </div>

      {/* Laid out like the Backends editor: the plain fields sit flat, and
          decode + translation each get their OWN disclosure. One combined
          "Overrides" fold meant the two screens that edit the SAME two
          settings groups looked nothing alike, and opening it produced four
          unrelated panels at once. */}
      <div className="mt-5">
        <div className="grid grid-cols-2 gap-4 rounded-xl border border-line bg-surface-2/40 p-4">
          <Labeled label="Language">
            <LanguageSelect
              ariaLabel="Language"
              value={p.language ?? ""}
              onChange={(v) => set({ language: v || undefined })}
              inheritLabel="Inherit from backend"
            />
          </Labeled>
          <Labeled label="Model">
            <ModelPicker
              ariaLabel="Model"
              value={p.model ?? ""}
              onChange={(v) => set({ model: v || undefined })}
              models={models}
              defaultLabel={
                backend?.model ? `Inherit · ${backend.model}` : "Inherit from backend"
              }
            />
          </Labeled>
          <div>
            <Labeled label="Endpoint">
              {/* Same switch as the Backends editor, plus the tri-state "Inherit" the other
                  overrides have — mirroring the Server-type Segmented's Auto sentinel. */}
              <Segmented
                value={p.endpoint ?? "inherit"}
                onChange={(v) => set({ endpoint: v === "inherit" ? undefined : v })}
                options={[
                  { value: "inherit", label: "Inherit" },
                  { value: "stream", label: "Streaming" },
                  { value: "batch", label: "Batch" },
                ]}
              />
            </Labeled>
            {/* Mirror the Backends editor's standard-server warning for a PROFILE-forced stream
                (an inherited stream endpoint already warns over there). */}
            {p.endpoint === "stream" && serverKind === "standard" && (
              <Notice className="mt-2">
                A standard Whisper server has no streaming endpoint — this override won’t work on{" "}
                <span className="font-medium">{safeDisplayText(backend?.name, 80) || "this backend"}</span>.
              </Notice>
            )}
          </div>
          <div>
            <div className="mb-2 flex items-center gap-1.5">
              {promptOverridden && (
                <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
              )}
              <label className="text-[12px] font-medium text-dim">Vocabulary / prompt</label>
              <div className="ml-auto flex items-center gap-2">
                {p.prompt !== "" && (
                  <button
                    type="button"
                    onClick={() => set({ prompt: "" })}
                    title="Override with empty (suppress the inherited prompt)"
                    className="ring-signal inline-flex items-center gap-1 rounded-md px-1 text-[11px] text-faint hover:text-text"
                  >
                    <Eraser className="size-3" /> clear
                  </button>
                )}
                {promptOverridden && (
                  <button
                    type="button"
                    onClick={() => set({ prompt: undefined })}
                    title="Reset to inherited"
                    className="ring-signal inline-flex items-center gap-1 rounded-md px-1 text-[11px] text-faint hover:text-text"
                  >
                    <RotateCcw className="size-3" /> reset
                  </button>
                )}
              </div>
            </div>
            <TextArea
              aria-label="Vocabulary / prompt"
              value={p.prompt ?? ""}
              onChange={(e) => set({ prompt: e.target.value })}
              rows={2}
              // Tri-state: empty an existing value → "" (clear, suppresses the
              // inherited prompt); reset → undefined (inherit, ghosts the baseline).
              placeholder={
                p.prompt === ""
                  ? "(cleared — no prompt sent)"
                  : inheritedPrompt || "Inherit from backend"
              }
            />
          </div>
        </div>
      </div>

      <div className="mt-5">
        <DisclosureCard
          open={showDecode}
          onToggle={() => setShowDecode((v) => !v)}
          title={
            <>
              Decode overrides{" "}
              {p.decodeOverrides && Object.keys(p.decodeOverrides).length ? (
                <span className="text-accent">· set</span>
              ) : (
                <span className="text-faint">· inherit backend</span>
              )}
            </>
          }
        >
          <p className="mb-3 text-[12px] text-dim">
            Only for this profile. Empty inherits the bound backend&apos;s defaults.
          </p>
          <DecodeFields
              value={p.decodeOverrides ?? {}}
              onChange={(v) => set({ decodeOverrides: Object.keys(v).length ? v : undefined })}
              inherited={inheritedDecode}
              serverKind={serverKind}
            canCustomize={caps?.can_request_decode_overrides}
          />
        </DisclosureCard>
      </div>

      <div className="mt-5">
        <DisclosureCard
          open={showInsertion}
          onToggle={() => setShowInsertion((v) => !v)}
          title={
            <>
              Insertion overrides{" "}
              {hasInsertionOverrides(p.insertionOverrides) || p.typeAsISpeak !== undefined ? (
                <span className="text-accent">· set</span>
              ) : (
                <span className="text-faint">· inherit global</span>
              )}
            </>
          }
        >
          <p className="mb-3 text-[12px] text-dim">
            Only for this profile. Inherit takes the Settings → Dictation default; an app rule
            still wins over both for the app you dictate into.
          </p>

          {/* "Type as I speak" is the profile-scoped replacement for the old global
              three-way. It only produces a distinct outcome on a STREAMING, HANDS-FREE
              profile, so the other combinations say why rather than silently doing nothing.
              Note the gate is on the PROFILE's activation for display only — the runtime
              value is what liveAllowed tests, because the Home button and the chip's
              quick-launch both start a hold profile hands-free. */}
          {(() => {
            const effEndpoint = p.endpoint ?? backend?.endpoint;
            const batch = effEndpoint === "batch";
            const hold = p.activation === "hold";
            const why = batch
              ? "Not available with a Batch endpoint: the audio is sent once, after you stop, so there are no live phrases to insert. Switch this profile's endpoint to Streaming to enable it."
              : hold
                ? "Push-to-talk holds the chord for the whole dictation, so injected keys would fold into it — these profiles always insert on release. The Home button and the chip's quick-launch run any profile hands-free, and this setting applies there."
                : undefined;
            return (
              <div className="mb-4">
                <Labeled label="Type as I speak">
                  <Segmented
                    ariaLabel="Type as I speak"
                    disabled={batch}
                    value={p.typeAsISpeak === true ? "on" : p.typeAsISpeak === false ? "off" : "inherit"}
                    onChange={(v) =>
                      set({ typeAsISpeak: v === "inherit" ? undefined : v === "on" })
                    }
                    options={[
                      { value: "inherit", label: "Inherit" },
                      { value: "on", label: "On" },
                      { value: "off", label: "Off" },
                    ]}
                  />
                </Labeled>
                <div className={cn("mt-1.5 text-[12px]", why ? "text-warn" : "text-dim")}>
                  {why ??
                    "Insert each phrase into the focused field as you talk, instead of waiting until the session ends."}
                </div>
              </div>
            );
          })()}

          {/* The same four controls as App Rules — one component, so the labels and the
              option order can't drift apart. Settings → Dictation keeps its own two-state rows. */}
          {(() => {
            const c = dictationControls({
              value: p.insertionOverrides ?? {},
              // Same rule as `save`: an empty override object is "inherit everything" and is
              // stored as absent — here too, or set-then-revert reads as unsaved forever.
              onChange: (v) => set({ insertionOverrides: hasInsertionOverrides(v) ? v : undefined }),
            });
            return (
              <div className="grid grid-cols-2 gap-4">
                <Labeled label={FIELD_LABEL.insertMethod}>{c.insertMethod}</Labeled>
                <Labeled label={FIELD_LABEL.pasteShortcut}>{c.pasteShortcut}</Labeled>
                <Labeled label={FIELD_LABEL.autoEnter}>{c.autoEnter}</Labeled>
                <Labeled label={FIELD_LABEL.restoreClipboard}>{c.restoreClipboard}</Labeled>
              </div>
            );
          })()}
        </DisclosureCard>
      </div>

      <div className="mt-5">
        <DisclosureCard
          open={showTranslation}
          onToggle={() => setShowTranslation((v) => !v)}
          title={
            <>
              Translation overrides{" "}
              {(p.translationOverrides && Object.keys(p.translationOverrides).length) ||
              p.askTranslationTargets !== undefined ? (
                <span className="text-accent">· set</span>
              ) : (
                <span className="text-faint">· inherit backend</span>
              )}
            </>
          }
        >
          <p className="mb-3 text-[12px] text-dim">
            Only for this profile. Empty inherits the bound backend&apos;s defaults;
            dictation injects every target.
          </p>
          <div className="mb-4 rounded-xl border border-line bg-surface-2/40 p-3.5">
            <Labeled label="Ask for target languages">
              <Toggle
                ariaLabel="Ask for target languages"
                checked={p.askTranslationTargets === true}
                onChange={(v) => set({ askTranslationTargets: v || undefined })}
              />
            </Labeled>
            <div className="mt-1.5 text-[12px] text-dim">
              {p.activation === "hold"
                ? "Asks after you release the shortcut, before the text is inserted — a prompt while the chord is held would swallow the keys. The targets below are preselected, so Enter inserts as this profile would; 0 inserts the original only; Esc inserts nothing and keeps the transcript in History."
                : "Asks before the microphone opens. The targets below are preselected, so pressing Enter does exactly what this profile does today; 0 starts without translating; Esc cancels and nothing starts."}
            </div>
          </div>
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
              inheritLabel={
                backend?.translationOverrides?.model
                  ? safeDisplayText(backend.translationOverrides.model, 60)
                  : "backend default"
            }
          />
        </DisclosureCard>
      </div>

      {/* Render unconditionally like the sibling Language/Decode blocks (disable-not-hide): if the
          bound backend was deleted (backendId cleared), a stored overrideProfile still applies to
          the fallback backend at dictation time, so the user must be able to SEE and clear it. With
          no resolvable backend the picker degrades to its free-text path (serverKind "unknown"). */}
      <div className="mt-5">
        <div className="rounded-xl border border-line bg-surface-2/40 p-4">
          <div className="mb-3 text-[12px] font-medium text-dim">
            Server override profile <span className="text-faint">· empty inherits the backend</span>
          </div>
          <OverrideProfilePicker
            serverUrl={backend ? effectiveServerUrl(backend, useApp.getState().settings) : ""}
            backendId={backend?.id ?? ""}
            serverKind={serverKind}
            canRequest={caps?.can_request_override_profile}
            value={p.overrideProfile ?? ""}
            inheritLabel="(inherit backend)"
            onChange={(v) => set({ overrideProfile: v.trim() ? v : undefined })}
          />
        </div>
      </div>

      <div className="mt-5 flex items-start gap-2 text-[12px] text-faint">
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
  const backendName = (id: string | null) =>
    safeDisplayText(backends.find((b) => b.id === id)?.name, 80) || "No backend";

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
  const onSave = (p: Profile) => {
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
        eyebrow="profiles"
        title="Profiles"
        showAdd={!draft}
        addLabel="Add profile"
        onAdd={startAdd}
      >
        Each profile is a way to dictate: push-to-talk or hands-free, its own shortcut and backend,
        with optional per-profile language and prompt.
      </ListScreenHeader>

      {draft ? (
        <div className="mt-8">
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
          <SectionLabel className="mb-3 mt-8">Configured</SectionLabel>
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
                  backendName={backendName(p.backendId)}
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
