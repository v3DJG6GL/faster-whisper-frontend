import { useRef, useState } from "react";
import { Plus, AppWindow, Ban, Crosshair, Pencil, Trash2 } from "lucide-react";
import { useApp } from "@/lib/store";
import { Button, Card, Labeled, SectionLabel, Select, TextInput, Toggle } from "@/components/ui";
import { getFocusedOtherApp } from "@/lib/api";
import { PASTE_PRESETS, pasteKey, pasteCodes, pasteLabel } from "@/lib/paste";
import type { AppRule, InsertMethod } from "@/lib/types";
import { cn } from "@/lib/cn";

const METHOD_OPTIONS: { value: string; label: string }[] = [
  { value: "inherit", label: "Inherit global" },
  { value: "direct", label: "Direct typing" },
  { value: "paste", label: "Clipboard paste" },
  { value: "clipboard", label: "Clipboard only" },
];
const PASTE_OPTIONS: { value: string; label: string }[] = [
  { value: "inherit", label: "Inherit global" },
  ...PASTE_PRESETS.map((p) => ({ value: p.value, label: p.label })),
];

function blankAppRule(): AppRule {
  return { id: crypto.randomUUID(), appId: "", name: "", block: false };
}

function Editor({
  initial,
  onSave,
  onCancel,
}: {
  initial: AppRule;
  onSave: (r: AppRule) => void;
  onCancel: () => void;
}) {
  const globalMethod = useApp((s) => s.settings.general.insertMethod);
  const [r, setR] = useState<AppRule>(initial);
  const [capturing, setCapturing] = useState(false);
  const [captureMsg, setCaptureMsg] = useState<string | null>(null);
  // The label we last auto-filled from "Use current", so a later capture can refresh the label
  // unless the user hand-typed a custom one (then we leave it). See captureCurrent.
  const lastAutoName = useRef<string | undefined>(undefined);
  const set = (patch: Partial<AppRule>) => setR((x) => ({ ...x, ...patch }));

  // Fill appId (and a label) from the currently-focused window — exercises the KWin
  // active-window detection. Returns null on non-KWin / nothing focused.
  const captureCurrent = async () => {
    setCapturing(true);
    setCaptureMsg(null);
    try {
      const app = await getFocusedOtherApp();
      if (app?.appId) {
        const autoLabel = app.title || app.appId;
        // Update the label too, but keep a hand-typed custom one. We tell them apart by remembering
        // what we last auto-filled: if the current label is blank or still equals that, it's ours to
        // refresh; otherwise the user typed it, so leave it. Lets a second "Use current" on a
        // different app update BOTH the id and the label.
        setR((x) => ({
          ...x,
          appId: app.appId,
          name: !x.name?.trim() || x.name === lastAutoName.current ? autoLabel : x.name,
        }));
        lastAutoName.current = autoLabel;
      } else {
        setCaptureMsg("Couldn’t detect a focused app (needs KWin/Plasma). Type the id manually.");
      }
    } catch {
      setCaptureMsg("Couldn’t detect a focused app. Type the id manually.");
    } finally {
      setCapturing(false);
    }
  };

  const effectiveMethod = (r.insertMethod ?? globalMethod) as InsertMethod;
  const pasteRelevant = !r.block && effectiveMethod === "paste";
  const canSave = r.appId.trim().length > 0;

  const save = () => {
    if (!canSave) return;
    onSave({ ...r, appId: r.appId.trim(), name: r.name?.trim() ? r.name.trim() : undefined });
  };

  return (
    <Card className="p-6">
      <Labeled label="Application id">
        <div className="flex gap-2">
          <TextInput value={r.appId} onChange={(e) => set({ appId: e.target.value })} placeholder="e.g. org.kde.konsole, signal, code" />
          <Button variant="ghost" onClick={captureCurrent} disabled={capturing} title="Use the currently focused app">
            <Crosshair className="size-4" /> {capturing ? "Detecting…" : "Use current"}
          </Button>
        </div>
        {captureMsg && <div className="mt-1.5 text-[12px] text-warn">{captureMsg}</div>}
      </Labeled>

      <Labeled label="Label (optional)" className="mt-4">
        <TextInput value={r.name ?? ""} onChange={(e) => set({ name: e.target.value })} placeholder={r.appId || "Friendly name"} />
      </Labeled>

      <div className="mt-5 flex items-center justify-between rounded-xl border border-line bg-surface-2/40 px-4 py-3">
        <div className="mr-4">
          <div className="text-[13px] font-medium text-text">Never type into this app</div>
          <div className="mt-0.5 text-[12px] text-dim">
            Dictation is still captured, but nothing is inserted here — avoids firing stray actions.
          </div>
        </div>
        <Toggle checked={r.block} onChange={(v) => set({ block: v })} />
      </div>

      <Labeled label="Insert method" className="mt-4">
        <Select
          value={r.insertMethod ?? "inherit"}
          disabled={r.block}
          onChange={(v) => set({ insertMethod: v === "inherit" ? null : (v as InsertMethod) })}
          options={METHOD_OPTIONS}
        />
      </Labeled>

      <Labeled label="Paste shortcut" className="mt-4">
        <Select
          value={r.pasteShortcut ? pasteKey(r.pasteShortcut) : "inherit"}
          disabled={!pasteRelevant}
          onChange={(v) => set({ pasteShortcut: v === "inherit" ? null : pasteCodes(v) })}
          options={PASTE_OPTIONS}
        />
      </Labeled>

      <div className="mt-6 flex items-center justify-between">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="accent" onClick={save} disabled={!canSave}>
          Save rule
        </Button>
      </div>
    </Card>
  );
}

function RuleRow({ r, onEdit, onRemove }: { r: AppRule; onEdit: () => void; onRemove: () => void }) {
  const globalMethod = useApp((s) => s.settings.general.insertMethod);
  // Mirror the editor's `pasteRelevant`: a saved paste shortcut only fires when paste is the
  // effective method, so don't list it for a rule that resolves to direct/clipboard typing.
  const pasteRelevant = !r.block && (r.insertMethod ?? globalMethod) === "paste";
  const summary = r.block
    ? "Blocked — never typed here"
    : [
        r.insertMethod ? METHOD_OPTIONS.find((m) => m.value === r.insertMethod)?.label : "Inherit method",
        pasteRelevant && r.pasteShortcut ? pasteLabel(r.pasteShortcut) : null,
      ]
        .filter(Boolean)
        .join(" · ");
  return (
    <Card className={cn("p-5", r.block && "border-warn/40")}>
      <div className="flex items-center gap-4">
        <div
          className={cn(
            "grid size-10 place-items-center rounded-xl",
            r.block ? "bg-warn/10 text-warn" : "bg-surface-2 text-accent",
          )}
        >
          {r.block ? <Ban className="size-[18px]" /> : <AppWindow className="size-[18px]" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-semibold text-text">{r.name?.trim() || r.appId}</span>
            <span className="truncate rounded-md bg-surface-2 px-2 py-0.5 font-mono text-[10.5px] text-dim">{r.appId}</span>
          </div>
          <div className="mt-1 truncate text-[12px] text-dim">{summary}</div>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" title="Edit" onClick={onEdit}>
            <Pencil className="size-4" />
          </Button>
          <Button variant="ghost" size="sm" title="Remove" onClick={onRemove}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>
    </Card>
  );
}

export default function AppRules() {
  const appRules = useApp((s) => s.appRules);
  const upsertAppRule = useApp((s) => s.upsertAppRule);
  const removeAppRule = useApp((s) => s.removeAppRule);
  const [draft, setDraft] = useState<AppRule | null>(null);

  const startAdd = () => {
    setDraft(blankAppRule());
  };
  const startEdit = (r: AppRule) => {
    setDraft(r);
  };
  const onSave = (r: AppRule) => {
    upsertAppRule(r);
    setDraft(null);
  };
  const onCancel = () => {
    setDraft(null);
  };

  return (
    <div className="mx-auto max-w-[820px] px-10 py-12">
      <div className="flex items-end justify-between">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-label text-accent">app rules</div>
          <h1 className="mt-2 font-display text-[30px] font-bold tracking-tight text-text">Per-app rules</h1>
          <p className="mt-2 max-w-md text-[13.5px] text-dim">
            Override how dictation inserts into specific apps — block it entirely, force a method, or set the
            paste shortcut (terminals need Ctrl+Shift+V). Matched by the focused window’s app id.
          </p>
        </div>
        {!draft && (
          <Button variant="accent" onClick={startAdd}>
            <Plus className="size-4" /> Add rule
          </Button>
        )}
      </div>

      {draft ? (
        <div className="mt-8">
          <Editor initial={draft} onSave={onSave} onCancel={onCancel} />
        </div>
      ) : (
        <>
          <SectionLabel className="mb-3 mt-8">Rules</SectionLabel>
          {appRules.length === 0 ? (
            <Card className="p-8 text-center text-[13.5px] text-dim">
              No rules yet. Add one to control how a specific app receives dictation.
            </Card>
          ) : (
            <div className="flex flex-col gap-3">
              {appRules.map((r) => (
                <RuleRow key={r.id} r={r} onEdit={() => startEdit(r)} onRemove={() => removeAppRule(r.id)} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
