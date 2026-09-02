import { useEffect, useRef, useState } from "react";
import { AppWindow, Ban, Crosshair, Pencil, Trash2 } from "lucide-react";
import { useApp } from "@/lib/store";
import { Button, Card, ConfirmLeave, EditorHeader, Labeled, ListScreenHeader, Notice, SectionLabel, TextInput, Toggle } from "@/components/ui";
import { isDirty, useUnsavedGuard } from "@/lib/useUnsavedGuard";
import { getFocusedOtherApp } from "@/lib/api";
import { pasteLabel } from "@/lib/paste";
import { dictationControls, FIELD_LABEL, METHOD_OPTIONS } from "@/components/DictationFields";
import { IS_WINDOWS } from "@/lib/platform";
import type { AppRule } from "@/lib/types";
import { cn } from "@/lib/cn";
import { normalizeAppId, safeIdentityText } from "@/lib/sanitize";

// App ids differ per platform: AT-SPI application names on Linux, lowercased exe
// basenames on Windows — show examples the local detector will actually produce.
const APP_ID_PLACEHOLDER = IS_WINDOWS
  ? "e.g. chrome, code, notepad"
  : "e.g. org.kde.konsole, signal, code";
const DETECT_FAILED_MSG = IS_WINDOWS
  ? "Couldn’t detect a focused app yet. Click into the target app once, come back, and retry — or type the id manually."
  : "Couldn’t detect a focused app (needs KWin/Plasma). Type the id manually.";

function blankAppRule(): AppRule {
  return { id: crypto.randomUUID(), appId: "", name: "", block: false };
}

const pruneInherit = (x: AppRule): AppRule => ({
  ...x,
  // The optional label too: saved blank as `undefined`, so a typed-then-cleared label must
  // not read as unsaved forever.
  name: x.name?.trim() ? x.name : undefined,
  insertMethod: x.insertMethod ?? undefined,
  pasteShortcut: x.pasteShortcut ?? undefined,
  autoEnter: x.autoEnter ?? undefined,
  restoreClipboard: x.restoreClipboard ?? undefined,
});

function Editor({
  initial,
  onSave,
  onCancel,
}: {
  initial: AppRule;
  onSave: (r: AppRule) => void;
  onCancel: () => void;
}) {
  const [r, setR] = useState<AppRule>(initial);
  const [capturing, setCapturing] = useState(false);
  const [captureMsg, setCaptureMsg] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // The label we last auto-filled from "Use current", so a later capture can refresh the label
  // unless the user hand-typed a custom one (then we leave it). See captureCurrent.
  const lastAutoName = useRef<string | undefined>(undefined);
  const set = (patch: Partial<AppRule>) => setR((x) => ({ ...x, ...patch }));

  // Fill appId (and a label) from the most recently focused OTHER window (ours took
  // focus when the user clicked here) — AT-SPI on Linux, win_focus on Windows.
  // Returns null when the detector has seen nothing yet.
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
        setCaptureMsg(DETECT_FAILED_MSG);
      }
    } catch {
      setCaptureMsg("Couldn’t detect a focused app. Type the id manually.");
    } finally {
      setCapturing(false);
    }
  };

  // Same normalizer the two inbound floors use, so all three agree on what the stored key is.
  // `trim()` alone was not enough: an invisible character survives it, and this screen renders the
  // id through a filter that deletes such characters — so the rule read armed and matched nothing.
  const canSave = normalizeAppId(r.appId).length > 0;

  const save = () => {
    if (!canSave) {
      setSaveError("A non-empty application id is required before saving.");
      return false; // nothing persisted — "Save and leave" must stay
    }
    setSaveError(null);
    onSave({ ...r, appId: normalizeAppId(r.appId), name: r.name?.trim() ? r.name.trim() : undefined });
    return true;
  };

  // Unsaved-work guard, shared with the Profiles and Backends editors: a
  // sidebar click used to discard a half-written rule in silence.
  // `null` and absent both mean "inherit" for the four override keys (types.ts), and the
  // controls write `null` on every change — so compare with both spellings pruned, or a
  // set-then-revert reads as unsaved forever.
  const dirty = isDirty(pruneInherit(r), pruneInherit(initial));
  const guard = useUnsavedGuard(dirty);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !guard.asking) guard.guardExit(onCancel);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <Card className="p-6">
      <EditorHeader
        onBack={() => guard.guardExit(onCancel)}
        title={r.name?.trim() || r.appId || "New rule"}
        subtitle={r.block ? "Per-app rule · never type here" : "Per-app rule"}
        dirty={dirty}
        saveLabel="Save rule"
        onSave={save}
        saveDisabled={!canSave}
      />
      {guard.asking && (
        <ConfirmLeave
          what="rule"
          onSaveAndLeave={() => guard.saveAndLeave(save)}
          onDiscard={guard.leave}
          onStay={guard.stay}
        />
      )}
      {saveError && <Notice tone="warn" className="mb-3">{saveError}</Notice>}
      <Labeled label="Application id">
        <div className="flex gap-2">
          <TextInput value={r.appId} onChange={(e) => { set({ appId: e.target.value }); setSaveError(null); }} placeholder={APP_ID_PLACEHOLDER} />
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
        <Toggle ariaLabel="Never type into this app" checked={r.block} onChange={(v) => set({ block: v })} />
      </div>

      {/* The same four controls as the Profile editor — one component, so the labels and
          the option order can't drift apart. Settings → Dictation keeps its own two-state
          rows and shares only the manifest labels and METHOD_OPTIONS.

          "Inherit" here means the ACTIVE PROFILE's value, or the global default when the
          profile doesn't override it either. No resolved value is shown beside it, unlike
          the Profile editor's: which profile is active differs per session, so there is no
          single answer to show. */}
      {(() => {
        const c = dictationControls({
          value: {
            insertMethod: r.insertMethod ?? undefined,
            pasteShortcut: r.pasteShortcut ?? undefined,
            autoEnter: r.autoEnter ?? undefined,
            restoreClipboard: r.restoreClipboard ?? undefined,
          },
          onChange: (v: import("@/lib/types").InsertionOverrides) =>
            set({
              insertMethod: v.insertMethod ?? null,
              pasteShortcut: v.pasteShortcut ?? null,
              autoEnter: v.autoEnter ?? null,
              restoreClipboard: v.restoreClipboard ?? null,
            }),
          disabled: r.block,
        });
        return (
          <>
            <Labeled label={FIELD_LABEL.insertMethod} className="mt-4">{c.insertMethod}</Labeled>
            <Labeled label={FIELD_LABEL.pasteShortcut} className="mt-4">{c.pasteShortcut}</Labeled>
            <Labeled label={FIELD_LABEL.autoEnter} className="mt-4">{c.autoEnter}</Labeled>
            <Labeled label={FIELD_LABEL.restoreClipboard} className="mt-4">{c.restoreClipboard}</Labeled>
          </>
        );
      })()}

      <div className="mt-6 flex items-center justify-between">
        <Button variant="ghost" onClick={() => guard.guardExit(onCancel)}>
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
  // Only the rule's OWN method can be judged here: the cascade is constraint > rule >
  // profile > global, and which Profile is active differs per session — so a rule that
  // inherits its method may well resolve to paste, and its saved chord is listed. Hidden
  // only when this rule itself forces direct/clipboard typing (or blocks).
  const pasteRelevant = !r.block && r.insertMethod !== "direct" && r.insertMethod !== "clipboard";
  const summary = r.block
    ? "Blocked — never typed here"
    : [
        r.insertMethod ? METHOD_OPTIONS.find((m) => m.value === r.insertMethod)?.label : "Inherit method",
        pasteRelevant && r.pasteShortcut ? pasteLabel(r.pasteShortcut) : null,
        // Only when overridden — an inherited value would just repeat the default on every row.
        r.autoEnter == null ? null : r.autoEnter ? "Enter" : "no Enter",
        r.restoreClipboard == null ? null : r.restoreClipboard ? "restore clipboard" : "keep clipboard",
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
            {/* This screen is where a user audits which apps are forced onto direct typing or
                blocked, and app rules sync with NO consent gate — so both identity strings are
                peer-authored. Bidi/invisible marks here let one rule read as another app. */}
            <span className="truncate text-[14px] font-semibold text-text">
              {safeIdentityText(r.name?.trim(), 80) || safeIdentityText(r.appId, 80)}
            </span>
            <span className="truncate rounded-md bg-surface-2 px-2 py-0.5 font-mono text-[10.5px] text-dim">
              {safeIdentityText(r.appId, 80)}
            </span>
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
    <div className="page page-form">
      <ListScreenHeader
        eyebrow="app rules"
        title="Per-app rules"
        showAdd={!draft}
        addLabel="Add rule"
        onAdd={startAdd}
      >
        Override how dictation inserts into specific apps — block it entirely, force a method, or set the
        paste shortcut (terminals need Ctrl+Shift+V). Matched by the focused window’s app id.
      </ListScreenHeader>

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
