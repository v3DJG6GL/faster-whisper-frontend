import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Mic, Hand, Pencil, Copy, Trash2, AlertTriangle, Info, Server, RotateCcw, Eraser } from "lucide-react";
import { useApp } from "@/lib/store";
import { Badge, Button, Card, DisclosureToggle, Labeled, ListScreenHeader, Notice, Segmented, SectionLabel, Select, TextInput, Toggle } from "@/components/ui";
import { HotkeyChips } from "@/components/HotkeyChips";
import { HotkeyCaptureControl } from "@/components/HotkeyCaptureControl";
import { DecodeFields } from "@/components/DecodeFields";
import { OverrideProfilePicker } from "@/components/OverrideProfilePicker";
import { ReorderControls } from "@/components/ReorderControls";
import { LANGUAGES, languageLabel } from "@/lib/languages";
import { conflictsByProfile, quickAddPeer, QUICK_ADD_PEER_ID } from "@/lib/conflicts";
import { useHotkeyCapture } from "@/lib/useHotkeyCapture";
import { evdevStatus, type EvdevStatus } from "@/lib/api";
import { IS_LINUX, IS_WINDOWS } from "@/lib/platform";
import { deriveChipTag } from "@/lib/profileTag";
import { effectiveServerKind } from "@/lib/serverKind";
import { effectiveServerUrl } from "@/lib/backends";
import { useOverrideContext } from "@/lib/useOverrideContext";
import type { Profile } from "@/lib/types";
import { cn } from "@/lib/cn";

const ACTIVATION = {
  hold: { icon: Mic, label: "Push-to-talk", hint: "Hold the hotkey while you speak; release to stop." },
  latch: { icon: Hand, label: "Latch", hint: "Tap once to start, tap again to stop." },
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
  // A low-level backend owns the chords when evdev is enabled AND permitted (Linux) or always on
  // Windows (the hook backend) — same gate as the Settings quick-add row, so both rebind surfaces
  // accept the same chords (useHotkeyCapture commits modifier-only / AltGr chords ONLY then).
  // Gating on `evdevEnabled` alone would let this editor accept a chord that can't fire when
  // evdev is toggled on but not permitted.
  const [evdev, setEvdev] = useState<EvdevStatus | null>(null);
  useEffect(() => {
    void evdevStatus().then(setEvdev).catch(() => {}); // match Settings' chain; ignore an IPC reject
  }, []);
  const lowLevelActive = IS_WINDOWS || (!!evdev?.permitted && evdevEnabled);
  const [p, setP] = useState<Profile>(initial);
  const [capturing, setCapturing] = useState(false);
  const [showOverrides, setShowOverrides] = useState(
    // prompt is tri-state: `!== undefined` so an explicit clear ("") still counts
    // as a set override (a truthy check would treat clear as "inherit").
    !!(initial.language || initial.endpoint || initial.prompt !== undefined || initial.overrideProfile ||
      (initial.decodeOverrides && Object.keys(initial.decodeOverrides).length)),
  );
  const set = (patch: Partial<Profile>) => setP((x) => ({ ...x, ...patch }));
  // Resolve the target backend so the decode editor can show its defaults as the
  // inherited baseline and gate to the backend's detected capability.
  const backend = backends.find((b) => b.id === p.backendId);
  const serverKind = backend
    ? effectiveServerKind(backend, p.backendId ? connections[p.backendId] : undefined)
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
  // own prompt, else the selected server override-profile's DEFAULT_PROMPT.
  const inheritedPrompt = (backend?.prompt || resolvedPrompt) ?? "";
  const promptOverridden = p.prompt !== undefined; // "" = explicit clear, value = set

  const { heldCodes, warn } = useHotkeyCapture({
    capturing,
    lowLevelActive,
    others,
    onCommit: (codes) => {
      set({ hotkey: codes });
      setCapturing(false);
    },
    onCancel: () => setCapturing(false),
  });

  const Glyph = ACTIVATION[p.activation].icon;

  const save = () =>
    onSave({
      ...p,
      name: p.name.trim() || "Untitled profile",
      // Empty = derive the chip tag from the name → store as undefined (omitted).
      tag: p.tag?.trim() ? p.tag.trim() : undefined,
      // Empty override = inherit from the Backend → store as undefined (omitted).
      language: p.language?.trim() ? p.language : undefined,
      // prompt is tri-state: undefined = inherit, "" = explicit clear (suppress the
      // inherited prompt), value = override. Preserve "" — do NOT prune it to
      // undefined, or "clear" would silently become "inherit".
      prompt: p.prompt,
      overrideProfile: p.overrideProfile?.trim() ? p.overrideProfile.trim() : undefined,
    });

  return (
    <Card className="p-6">
      <div className="flex items-center gap-2 text-text">
        <Glyph className="size-[18px] text-accent" />
        <span className="text-[14px] font-semibold">Dictation profile</span>
        <span className="text-[12px] text-dim">· {ACTIVATION[p.activation].hint}</span>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-4">
        <Labeled label="Name">
          <TextInput value={p.name} onChange={(e) => set({ name: e.target.value })} placeholder="Email — German" />
        </Labeled>
        <Labeled label="Chip tag">
          <TextInput
            value={p.tag ?? ""}
            onChange={(e) => set({ tag: e.target.value })}
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
              { value: "latch", label: "Latch" },
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
                    ...backends.map((b) => ({ value: b.id, label: b.name })),
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

      <DisclosureToggle open={showOverrides} onToggle={() => setShowOverrides((v) => !v)} className="mt-5">
        Overrides{" "}
        {p.language || p.endpoint || p.prompt !== undefined || p.overrideProfile || (p.decodeOverrides && Object.keys(p.decodeOverrides).length) ? (
          <span className="text-accent">· set</span>
        ) : (
          <span className="text-faint">· inherit backend</span>
        )}
      </DisclosureToggle>

      {showOverrides && (
        <>
          <div className="mt-3 grid grid-cols-2 gap-4 rounded-xl border border-line bg-surface-2/40 p-4">
            <Labeled label="Language">
              <Select
                value={p.language ?? ""}
                onChange={(v) => set({ language: v })}
                options={[{ value: "", label: "Inherit from backend" }, ...LANGUAGES]}
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
                  <span className="font-medium">{backend?.name ?? "this backend"}</span>.
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
              <textarea
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
                className="ring-signal w-full resize-none rounded-xl border border-line bg-surface-2 px-3.5 py-2.5 text-[13px] text-text placeholder:text-faint"
              />
            </div>
          </div>
          <div className="mt-3 rounded-xl border border-line bg-surface-2/40 p-4">
            <div className="mb-3 text-[12px] font-medium text-dim">
              Decode overrides <span className="text-faint">· empty inherits the backend</span>
            </div>
            <DecodeFields
              value={p.decodeOverrides ?? {}}
              onChange={(v) => set({ decodeOverrides: Object.keys(v).length ? v : undefined })}
              inherited={inheritedDecode}
              serverKind={serverKind}
              canCustomize={caps?.can_request_decode_overrides}
            />
          </div>
          {/* Render unconditionally like the sibling Language/Decode blocks (disable-not-hide): if the
              bound backend was deleted (backendId cleared), a stored overrideProfile still applies to
              the fallback backend at dictation time, so the user must be able to SEE and clear it. With
              no resolvable backend the picker degrades to its free-text path (serverKind "unknown"). */}
          <div className="mt-3 rounded-xl border border-line bg-surface-2/40 p-4">
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
        </>
      )}

      <div className="mt-5 flex items-start gap-2 text-[12px] text-faint">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        {IS_LINUX ? (
          <>
            On Wayland, push-to-talk (and modifier-only / AltGr chords) need the evdev backend (Settings →
            Permissions). Latch works everywhere; you can also bind it in your desktop’s shortcut settings.
          </>
        ) : (
          <>
            Every chord type works globally on Windows — push-to-talk, latch, modifier-only (like
            Ctrl+Shift), and left/right-specific modifiers.
          </>
        )}
      </div>

      <div className="mt-6 flex items-center justify-between">
        <Button variant="ghost" onClick={onCancel}>
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
  return (
    <Card className={cn("p-5", conflictText && "border-warn/40")}>
      <div className="flex items-center gap-4">
        <ReorderControls canUp={canUp} canDown={canDown} onUp={onMoveUp} onDown={onMoveDown} />
        <div
          className={cn(
            "grid size-10 place-items-center rounded-xl",
            p.activation === "latch" ? "bg-accent-soft text-accent" : "bg-surface-2 text-accent",
          )}
        >
          <Glyph className="size-[18px]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-semibold text-text">{p.name}</span>
            {p.tag?.trim() && <Badge tone="accent">{p.tag.trim()}</Badge>}
            <Badge>{meta.label}</Badge>
            {p.language && <Badge>{languageLabel(p.language)}</Badge>}
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
        <Toggle ariaLabel={`Enable ${p.name}`} checked={p.enabled} onChange={(v) => updateProfile(p.id, { enabled: v })} />
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
  const nameOf = (id: string) =>
    id === QUICK_ADD_PEER_ID ? "Quick add" : (profiles.find((p) => p.id === id)?.name ?? "another profile");
  const backendName = (id: string | null) => backends.find((b) => b.id === id)?.name ?? "No backend";

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
    <div className="mx-auto max-w-[820px] px-10 py-12">
      <ListScreenHeader
        eyebrow="profiles"
        title="Profiles"
        showAdd={!draft}
        addLabel="Add profile"
        onAdd={startAdd}
      >
        Each profile is a way to dictate: push-to-talk or latch, its own shortcut and backend,
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
            // kill quick-add with no warning. Symmetric with the Settings quick-add row, which
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
            <Card className="p-8 text-center text-[13.5px] text-dim">
              No profiles yet. Add one to start dictating.
            </Card>
          ) : (
            <div className="flex flex-col gap-3">
              {profiles.map((p, i) => (
                <ProfileRow
                  key={p.id}
                  p={p}
                  backendName={backendName(p.backendId)}
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
