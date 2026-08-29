// "What this device syncs" — the granular per-setting sync switches, rendered
// entirely from the settings manifest (one switch per Settings row, identical
// label, nesting mirrored). Boxed group cards with tri-state masters and
// exception-first collapse: a collapsed card hides only rows that are
// ON-and-at-default; anything off or changed stays visible, so "what is NOT
// following my account?" needs no expanding.
//
// Reset tiers: hover ↺ / row menu (single setting, instant), group menu
// ("Reset group"), and a subdued "Restore all defaults…" with an inline
// confirm + Undo toast. Resets flow through the normal store setters →
// debounced save → sync push, deliberately: a reset IS a settings change.

import { Fragment, useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/cn";
import { useApp } from "@/lib/store";
import type { AppSettings } from "@/lib/types";
import {
  MANIFEST,
  SYNC_GROUPS,
  SYNC_GROUP_LABEL,
  completeGates,
  isChanged,
  patchFor,
  settingsOfGroup,
  snapshotOf,
  type ResetPatch,
  type SettingDef,
  type SettingId,
  type SyncGroup,
} from "@/lib/settingsManifest";
import type { Gates } from "@/lib/syncGates";
import { DisclosureToggle, RowMenu, Toast, Toggle } from "@/components/ui";

const UI_STATE_KEY = "fwf.syncUi.v1";

interface UiState {
  expanded: Partial<Record<SyncGroup, boolean>>;
  changedOnly: boolean;
}

function loadUiState(): UiState {
  try {
    const raw = localStorage.getItem(UI_STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UiState>;
      return { expanded: parsed.expanded ?? {}, changedOnly: parsed.changedOnly ?? false };
    }
  } catch {
    /* unavailable/malformed — defaults */
  }
  return { expanded: {}, changedOnly: false };
}

function saveUiState(s: UiState): void {
  try {
    localStorage.setItem(UI_STATE_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

const DEFS: readonly SettingDef[] = MANIFEST;

export function SyncSettingsList({ enabled }: { enabled: boolean }) {
  const settings = useApp((s) => s.settings);
  const updateSync = useApp((s) => s.updateSync);
  const updateGeneral = useApp((s) => s.updateGeneral);
  const updateRecording = useApp((s) => s.updateRecording);
  const updateLogging = useApp((s) => s.updateLogging);
  const updateSettings = useApp((s) => s.updateSettings);
  /** Transcribe settings ride the opaque settings.transcribe blob (merge-patch). */
  const updateTranscribe = (patch: Partial<NonNullable<AppSettings["transcribe"]>>) =>
    updateSettings({ transcribe: { ...settings.transcribe, ...patch } });

  const gates = useMemo(
    () => completeGates(settings.sync?.sub, settings.sync?.categories),
    [settings.sync],
  );
  const changed = useMemo(() => {
    const set = new Set<SettingId>();
    for (const d of DEFS) if (isChanged(settings, d)) set.add(d.id as SettingId);
    return set;
  }, [settings]);

  const [ui, setUi] = useState<UiState>(loadUiState);
  const patchUi = (p: Partial<UiState>) =>
    setUi((prev) => {
      const next = { ...prev, ...p, expanded: { ...prev.expanded, ...(p.expanded ?? {}) } };
      saveUiState(next);
      return next;
    });

  const [toast, setToast] = useState<{ text: string; undo?: ResetPatch } | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  function setGates(patch: Partial<Record<SettingId, boolean>>) {
    const next = { ...gates, ...patch };
    // Persist the complete gate map plus the legacy mirror key, so an older
    // app version reading this config still sees the audio-folder intent.
    updateSync({ sub: { ...next, recordingsDir: next.audioFolder } });
  }

  function applyPatch(patch: ResetPatch) {
    if (patch.general) updateGeneral(patch.general);
    if (patch.recording) updateRecording(patch.recording);
    if (patch.transcribe) updateTranscribe(patch.transcribe);
    if (patch.logging) updateLogging(patch.logging);
    if (patch.settings) updateSettings(patch.settings);
  }

  function resetDefs(defs: readonly SettingDef[], label: string) {
    const undo = snapshotOf(settings, defs);
    applyPatch(patchFor(defs));
    setToast({ text: label, undo });
  }

  const allOn = DEFS.every((d) => gates[d.id as SettingId]);
  const totalChanged = changed.size;

  return (
    <div className={cn(!enabled && "pointer-events-none opacity-40")} aria-disabled={!enabled}>
      {/* Sync everything: on = every switch on and the list folds away. */}
      <div className="flex items-center gap-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-medium text-text">Sync everything</div>
          <div className="text-[12px] text-faint">
            On = all settings follow your account. Off = pick per setting below.
          </div>
        </div>
        <Toggle
          checked={allOn}
          ariaLabel="Sync everything"
          onChange={(v) =>
            setGates(Object.fromEntries(DEFS.map((d) => [d.id, v])) as Partial<
              Record<SettingId, boolean>
            >)
          }
        />
      </div>

      {!allOn && (
        <>
          <div className="flex items-center gap-4 pb-2 text-[12px]">
            <button
              type="button"
              className="ring-signal font-semibold text-accent hover:underline disabled:text-faint disabled:no-underline"
              disabled={SYNC_GROUPS.every((g) => ui.expanded[g])}
              onClick={() =>
                patchUi({ expanded: Object.fromEntries(SYNC_GROUPS.map((g) => [g, true])) })
              }
            >
              Expand all
            </button>
            <button
              type="button"
              className="ring-signal font-semibold text-accent hover:underline disabled:text-faint disabled:no-underline"
              disabled={SYNC_GROUPS.every((g) => !ui.expanded[g])}
              onClick={() =>
                patchUi({ expanded: Object.fromEntries(SYNC_GROUPS.map((g) => [g, false])) })
              }
            >
              Collapse all
            </button>
            <span className="flex-1" />
            <button
              type="button"
              aria-pressed={ui.changedOnly}
              className={cn(
                "ring-signal font-semibold hover:underline",
                ui.changedOnly ? "text-accent" : "text-dim",
              )}
              onClick={() => patchUi({ changedOnly: !ui.changedOnly })}
            >
              Show changed only{totalChanged > 0 ? ` (${totalChanged})` : ""}
            </button>
          </div>

          {SYNC_GROUPS.map((group) => (
            <GroupCard
              key={group}
              group={group}
              gates={gates}
              changed={changed}
              expanded={!!ui.expanded[group]}
              changedOnly={ui.changedOnly}
              onToggleExpand={() => patchUi({ expanded: { [group]: !ui.expanded[group] } })}
              onGate={(id, v) => setGates({ [id]: v } as Partial<Record<SettingId, boolean>>)}
              onGateMany={(patch) => setGates(patch)}
              onResetSetting={(def) => resetDefs([def], `Reset “${def.label}” to default`)}
              onResetGroup={(defs) =>
                resetDefs(defs, `Reset ${defs.length} ${defs.length === 1 ? "setting" : "settings"} in ${SYNC_GROUP_LABEL[group]}`)
              }
            />
          ))}

          <div className="mt-4 flex items-center justify-end gap-3">
            {confirmAll ? (
              <>
                <span className="text-[12px] text-warn">
                  Reset {totalChanged} changed {totalChanged === 1 ? "setting" : "settings"} to
                  factory defaults? Servers, profiles, dictionary and app rules are untouched —
                  and the reset syncs to your other devices.
                </span>
                <button
                  type="button"
                  className="ring-signal rounded-lg border border-rec/40 px-3 py-1.5 text-[12px] font-semibold text-rec hover:bg-rec/10"
                  onClick={() => {
                    setConfirmAll(false);
                    resetDefs(
                      DEFS.filter((d) => changed.has(d.id as SettingId)),
                      `Reset ${totalChanged} ${totalChanged === 1 ? "setting" : "settings"} to defaults`,
                    );
                  }}
                >
                  Reset
                </button>
                <button
                  type="button"
                  className="ring-signal rounded-lg border border-line px-3 py-1.5 text-[12px] text-dim hover:text-text"
                  onClick={() => setConfirmAll(false)}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={totalChanged === 0}
                className="ring-signal rounded-lg border border-line px-3 py-1.5 text-[12px] text-faint hover:text-dim disabled:opacity-40"
                onClick={() => setConfirmAll(true)}
              >
                Restore all defaults…
              </button>
            )}
          </div>
        </>
      )}

      {toast && (
        <Toast
          actionLabel={toast.undo ? "Undo" : undefined}
          onAction={
            toast.undo
              ? () => {
                  applyPatch(toast.undo!);
                  setToast(null);
                }
              : undefined
          }
          onDismiss={() => setToast(null)}
        >
          {toast.text}
        </Toast>
      )}
    </div>
  );
}

function GroupCard({
  group,
  gates,
  changed,
  expanded,
  changedOnly,
  onToggleExpand,
  onGate,
  onGateMany,
  onResetSetting,
  onResetGroup,
}: {
  group: SyncGroup;
  gates: Gates;
  changed: ReadonlySet<SettingId>;
  expanded: boolean;
  changedOnly: boolean;
  onToggleExpand: () => void;
  onGate: (id: SettingId, v: boolean) => void;
  onGateMany: (patch: Partial<Record<SettingId, boolean>>) => void;
  onResetSetting: (def: SettingDef) => void;
  onResetGroup: (defs: SettingDef[]) => void;
}) {
  const defs = settingsOfGroup(group);
  const on = defs.filter((d) => gates[d.id as SettingId]);
  const off = defs.filter((d) => !gates[d.id as SettingId]);
  const changedDefs = defs.filter((d) => changed.has(d.id as SettingId));
  const master: boolean | "mixed" =
    off.length === 0 ? true : on.length === 0 ? false : "mixed";

  // Exceptions stay visible while collapsed: off OR changed rows.
  const isException = (d: SettingDef) =>
    !gates[d.id as SettingId] || changed.has(d.id as SettingId);
  const visible = changedOnly
    ? defs.filter((d) => changed.has(d.id as SettingId))
    : expanded
      ? defs
      : defs.filter(isException);

  const summary =
    off.length === 0
      ? `all ${defs.length} synced`
      : `${on.length} synced · ${off.length} off${changedDefs.length ? ` · ${changedDefs.length} changed` : ""}`;

  if (changedOnly && visible.length === 0) return null;

  const panelId = `sync-group-${group}`;
  return (
    <div className="mb-2.5 rounded-xl border border-line bg-surface px-4">
      <div className="flex items-center gap-3 py-2.5">
        <DisclosureToggle
          open={expanded}
          onToggle={onToggleExpand}
          ariaControls={panelId}
          className="text-[13px] font-semibold text-text"
        >
          {SYNC_GROUP_LABEL[group]}
        </DisclosureToggle>
        <span className="ml-auto font-mono text-[11px] tabular-nums text-faint">{summary}</span>
        <Toggle
          checked={master}
          ariaLabel={`Sync ${SYNC_GROUP_LABEL[group]}`}
          onChange={(v) =>
            onGateMany(
              Object.fromEntries(defs.map((d) => [d.id, v])) as Partial<Record<SettingId, boolean>>,
            )
          }
        />
        <RowMenu
          ariaLabel={`${SYNC_GROUP_LABEL[group]} options`}
          items={[
            {
              label: changedDefs.length
                ? `Reset group (${changedDefs.length} changed)`
                : "Reset group — nothing changed",
              disabled: changedDefs.length === 0,
              onSelect: () => onResetGroup(changedDefs),
            },
          ]}
        />
      </div>
      {visible.length > 0 && (
        <div id={panelId} className="border-t border-line pb-1.5">
          {visible.map((def, i) => (
            <Fragment key={def.id}>
              {expanded && !changedOnly && def.section && visible[i - 1]?.section !== def.section && (
                <div className="pt-2.5 font-mono text-[10px] uppercase tracking-label text-faint">
                  {def.section}
                </div>
              )}
              <SettingSwitchRow
                def={def}
                gate={gates[def.id as SettingId]}
                isChanged={changed.has(def.id as SettingId)}
                indent={!!def.parent && expanded && !changedOnly}
                onGate={(v) => onGate(def.id as SettingId, v)}
                onReset={() => onResetSetting(def)}
              />
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

function SettingSwitchRow({
  def,
  gate,
  isChanged,
  indent,
  onGate,
  onReset,
}: {
  def: SettingDef;
  gate: boolean;
  isChanged: boolean;
  indent: boolean;
  onGate: (v: boolean) => void;
  onReset: () => void;
}) {
  return (
    <div
      className={cn(
        "group relative flex items-center gap-3 border-b border-line py-2 last:border-b-0",
        indent && "pl-9",
        isChanged && "border-l-2 border-l-accent pl-2.5",
        isChanged && indent && "pl-9",
      )}
    >
      {indent && (
        // connector elbow: this option belongs to the row above (mirrors the
        // same nesting on the Settings tab).
        <span
          aria-hidden
          className="absolute left-3.5 top-[-4px] h-[24px] w-[12px] rounded-bl-lg border-b border-l border-line-strong"
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-text">
          {def.label}
          {isChanged && <span className="sr-only"> (changed from default)</span>}
        </div>
        {def.desc && <div className="text-[11.5px] text-faint">{def.desc}</div>}
      </div>
      {isChanged && (
        <button
          type="button"
          title="Reset to default"
          aria-label={`Reset ${def.label} to default`}
          onClick={onReset}
          className="ring-signal grid size-7 shrink-0 place-items-center rounded-full border border-line-strong text-dim opacity-0 transition-opacity hover:text-text focus-visible:opacity-100 group-hover:opacity-100 motion-reduce:opacity-100"
        >
          <RotateCcw className="size-3.5" />
        </button>
      )}
      <Toggle checked={gate} onChange={onGate} ariaLabel={`Sync ${def.label}`} />
      {def.fields.length > 0 && (
        <RowMenu
          ariaLabel={`${def.label} options`}
          items={[
            {
              label: isChanged ? "Reset to default" : "Reset to default — already default",
              disabled: !isChanged,
              onSelect: onReset,
            },
          ]}
        />
      )}
    </div>
  );
}
