import { useEffect, useRef, useState, type ReactNode } from "react";
import { Plus, Mic, Hand, Pencil, Copy, Trash2, Keyboard, AlertTriangle, Info, Server } from "lucide-react";
import { useApp } from "@/lib/store";
import { Button, Card, Kbd, Segmented, SectionLabel, Select, TextInput, Toggle } from "@/components/ui";
import { HotkeyChips } from "@/components/HotkeyChips";
import { LANGUAGES, languageLabel } from "@/lib/languages";
import { validateCodes, suspendShortcuts, reregisterShortcuts } from "@/lib/api";
import { MODIFIER_CODES, codeToToken, canonicalizeCodes, codesToLabels } from "@/lib/keys";
import { conflictsByProfile, findChordConflict } from "@/lib/conflicts";
import type { Profile } from "@/lib/types";
import { cn } from "@/lib/cn";

const ACTIVATION = {
  hold: { icon: Mic, label: "Push-to-talk", hint: "Hold the hotkey while you speak; release to stop." },
  latch: { icon: Hand, label: "Latch", hint: "Tap once to start, tap again to stop." },
} as const;

function blankProfile(backendId: string | null): Profile {
  return { id: crypto.randomUUID(), name: "New profile", activation: "hold", enabled: true, hotkey: [], backendId };
}

function Labeled({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label className="mb-2 block text-[12px] font-medium text-dim">{label}</label>
      {children}
    </div>
  );
}

/**
 * Hotkey-capture for the profile editor. Tracks held modifiers live; finalizes on
 * the first real key (or, with evdev, on release of a modifier-only chord). Warns
 * (never silently drops) on a clash with another profile or a non-registerable
 * chord. Suspends global hotkeys for the duration so a press only rebinds.
 */
function useHotkeyCapture(opts: {
  capturing: boolean;
  evdevActive: boolean;
  others: Profile[];
  onCommit: (codes: string[]) => void;
  onCancel: () => void;
}): { heldCodes: string[]; warn: string | null } {
  const { capturing, evdevActive } = opts;
  const [heldCodes, setHeldCodes] = useState<string[]>([]);
  const [warn, setWarn] = useState<string | null>(null);
  // Keep the latest callbacks/others without retriggering the capture effect
  // (which would re-add listeners + re-suspend hotkeys on every render).
  const ref = useRef(opts);
  ref.current = opts;

  useEffect(() => {
    if (!capturing) {
      setHeldCodes([]);
      setWarn(null);
      return;
    }
    void suspendShortcuts();
    const pressed = new Set<string>();
    let peak: string[] = [];
    let done = false;
    const finalize = (codes: string[]) => {
      const clash = findChordConflict(codes, ref.current.others);
      if (clash) {
        setWarn(
          clash.kind === "duplicate"
            ? `Same shortcut as “${clash.name}”`
            : `Overlaps “${clash.name}” — one chord shadows the other`,
        );
        done = false;
        return;
      }
      if (evdevActive) {
        ref.current.onCommit(codes);
      } else {
        void validateCodes(codes).then((ok) => {
          if (ok) ref.current.onCommit(codes);
          else {
            setWarn("Can’t register that — add a letter/digit, or enable evdev (Settings → Permissions) for modifier-only / AltGr");
            done = false;
          }
        });
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        ref.current.onCancel();
        return;
      }
      if (MODIFIER_CODES.has(e.code)) {
        pressed.add(e.code);
        const cur = canonicalizeCodes([...pressed]);
        if (cur.length > peak.length) peak = cur;
        setHeldCodes(cur);
        return;
      }
      if (!codeToToken(e.code) && !evdevActive) {
        setWarn("That key can’t be a global shortcut — try another");
        return;
      }
      done = true;
      finalize(canonicalizeCodes([...pressed, e.code]));
    };
    const onKeyUp = (e: KeyboardEvent) => {
      e.preventDefault();
      pressed.delete(e.code);
      setHeldCodes(canonicalizeCodes([...pressed]));
      if (!done && pressed.size === 0 && peak.length > 0) {
        if (evdevActive) {
          done = true;
          finalize(peak);
        } else {
          setWarn("Modifier-only chords need the evdev backend (Settings → Permissions)");
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      void reregisterShortcuts();
    };
  }, [capturing, evdevActive]);

  return { heldCodes, warn };
}

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
  const evdevActive = useApp((s) => s.settings.general.evdevEnabled);
  const [p, setP] = useState<Profile>(initial);
  const [capturing, setCapturing] = useState(false);
  const [showOverrides, setShowOverrides] = useState(!!(initial.language || initial.prompt));
  const set = (patch: Partial<Profile>) => setP((x) => ({ ...x, ...patch }));

  const { heldCodes, warn } = useHotkeyCapture({
    capturing,
    evdevActive,
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
      // Empty override = inherit from the Backend → store as undefined (omitted).
      language: p.language?.trim() ? p.language : undefined,
      prompt: p.prompt?.trim() ? p.prompt : undefined,
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
            value={p.backendId ?? ""}
            onChange={(v) => set({ backendId: v || null })}
            options={
              backends.length
                ? backends.map((b) => ({ value: b.id, label: b.name }))
                : [{ value: "", label: "No backends — add one" }]
            }
          />
        </Labeled>
        <Labeled label="Shortcut">
          <div className="flex items-center gap-2">
            {capturing ? (
              <div className="flex min-h-10 flex-1 items-center gap-2 rounded-xl border border-accent/60 bg-accent-soft/40 px-3 py-1.5 ring-2 ring-accent/25">
                <span className="size-2 animate-pulse rounded-full bg-accent" />
                <span className="inline-flex items-center gap-1">
                  {codesToLabels(heldCodes).map((k, i) => (
                    <span key={i} className="inline-flex items-center gap-1">
                      {i > 0 && <span className="text-faint">+</span>}
                      <Kbd>{k}</Kbd>
                    </span>
                  ))}
                  {heldCodes.length > 0 && <span className="text-faint">+</span>}
                  <Kbd>…</Kbd>
                </span>
                <span className={cn("ml-1 text-[12px]", warn ? "text-rec" : "text-dim")}>
                  {warn ?? "Press your shortcut · Esc to cancel"}
                </span>
              </div>
            ) : (
              <div className="flex flex-1 items-center">
                <HotkeyChips codes={p.hotkey} />
              </div>
            )}
            <Button variant="ghost" size="sm" onClick={() => setCapturing((c) => !c)}>
              <Keyboard className="size-4" /> {capturing ? "Cancel" : "Rebind"}
            </Button>
          </div>
        </Labeled>
      </div>

      <button
        type="button"
        onClick={() => setShowOverrides((v) => !v)}
        className="ring-signal mt-5 inline-flex items-center gap-1.5 rounded-lg text-[12.5px] font-medium text-dim hover:text-text"
      >
        <span className={cn("transition-transform", showOverrides && "rotate-90")}>›</span>
        Overrides {p.language || p.prompt ? <span className="text-accent">· set</span> : <span className="text-faint">· inherit backend</span>}
      </button>

      {showOverrides && (
        <div className="mt-3 grid grid-cols-2 gap-4 rounded-xl border border-line bg-surface-2/40 p-4">
          <Labeled label="Language">
            <Select
              value={p.language ?? ""}
              onChange={(v) => set({ language: v })}
              options={[{ value: "", label: "Inherit from backend" }, ...LANGUAGES]}
            />
          </Labeled>
          <Labeled label="Vocabulary / prompt">
            <textarea
              value={p.prompt ?? ""}
              onChange={(e) => set({ prompt: e.target.value })}
              rows={2}
              placeholder="Inherit from backend"
              className="ring-signal w-full resize-none rounded-xl border border-line bg-surface-2 px-3.5 py-2.5 text-[13px] text-text placeholder:text-faint"
            />
          </Labeled>
        </div>
      )}

      <div className="mt-5 flex items-start gap-2 text-[12px] text-faint">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        On Wayland, push-to-talk (and modifier-only / AltGr chords) need the evdev backend (Settings → Permissions).
        Latch works everywhere; you can also bind it in your desktop’s shortcut settings.
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
  onEdit,
  onDuplicate,
  onRemove,
}: {
  p: Profile;
  backendName: string;
  conflictText: string | null;
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
            <span className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-wider text-dim">
              {meta.label}
            </span>
            {p.language && (
              <span className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-wider text-dim">
                {languageLabel(p.language)}
              </span>
            )}
          </div>
          <div className="mt-1.5 flex items-center gap-3">
            <HotkeyChips codes={p.hotkey} />
            <span className="inline-flex items-center gap-1 truncate text-[12px] text-dim">
              <Server className="size-3.5 text-faint" />
              {backendName}
            </span>
          </div>
        </div>
        <Toggle checked={p.enabled} onChange={(v) => updateProfile(p.id, { enabled: v })} />
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Profile | null>(null);

  const conflicts = conflictsByProfile(profiles);
  const nameOf = (id: string) => profiles.find((p) => p.id === id)?.name ?? "another profile";
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
      <div className="flex items-end justify-between">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-label text-accent">profiles</div>
          <h1 className="mt-2 font-display text-[30px] font-bold tracking-tight text-text">Profiles</h1>
          <p className="mt-2 max-w-md text-[13.5px] text-dim">
            Each profile is a way to dictate: push-to-talk or latch, its own shortcut and backend,
            with optional per-profile language and prompt.
          </p>
        </div>
        {!draft && (
          <Button variant="accent" onClick={startAdd}>
            <Plus className="size-4" /> Add profile
          </Button>
        )}
      </div>

      {draft ? (
        <div className="mt-8">
          <Editor
            initial={draft}
            others={profiles.filter((p) => p.id !== editingId)}
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
              {profiles.map((p) => (
                <ProfileRow
                  key={p.id}
                  p={p}
                  backendName={backendName(p.backendId)}
                  conflictText={conflictText(p.id)}
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
