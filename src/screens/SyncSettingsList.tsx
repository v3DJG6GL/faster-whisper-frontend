// "What this device syncs" — the granular per-setting sync switches, rendered
// entirely from the settings manifest (one switch per Settings row, identical
// label, nesting mirrored). Boxed group cards with tri-state masters: a
// collapsed card shows only its header + summary counts; the "Show changed
// & off only" filter answers "what is NOT following my account?" (rows whose
// value changed from default OR whose sync switch is off) without expanding —
// group headers always stay visible so the per-group masters remain reachable.
//
// Reset tiers, one direct control each (no menus): a permanent ↺ on a row
// whose switch differs from its default, a "↺ N" pill on a group header with
// N changed switches, and a subdued "Restore all defaults…" with an inline
// confirm + Undo toast. Resets restore the SYNC SWITCHES to their default
// map (on for everything except machine-specific settings) — they never
// touch the settings' values, and like all sync switches they are
// per-device, so a reset does not sync anywhere.

import { Fragment, useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/cn";
import { useApp } from "@/lib/store";
import {
  DEFAULT_SETTING_SYNC,
  MANIFEST,
  SYNC_GROUPS,
  SYNC_GROUP_LABEL,
  completeGates,
  settingsOfGroup,
  type SettingDef,
  type SettingId,
  type SyncGroup,
} from "@/lib/settingsManifest";
import type { Gates } from "@/lib/syncGates";
import { DisclosureToggle, Toast, Toggle } from "@/components/ui";

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

  const gates = useMemo(
    () => completeGates(settings.sync?.sub, settings.sync?.categories),
    [settings.sync],
  );
  // "Changed" on this screen means the SWITCH differs from its default —
  // not the setting's value; this list configures sync, not the settings.
  const changed = useMemo(() => {
    const set = new Set<SettingId>();
    for (const d of DEFS) {
      const id = d.id as SettingId;
      if (gates[id] !== DEFAULT_SETTING_SYNC[id]) set.add(id);
    }
    return set;
  }, [gates]);

  const [ui, setUi] = useState<UiState>(loadUiState);
  const patchUi = (p: Partial<UiState>) =>
    setUi((prev) => {
      const next = { ...prev, ...p, expanded: { ...prev.expanded, ...(p.expanded ?? {}) } };
      saveUiState(next);
      return next;
    });

  const [toast, setToast] = useState<{
    text: string;
    undo?: Partial<Record<SettingId, boolean>>;
  } | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  function setGates(patch: Partial<Record<SettingId, boolean>>) {
    const next = { ...gates, ...patch };
    // Persist the complete gate map plus the legacy mirror key, so an older
    // app version reading this config still sees the audio-folder intent.
    updateSync({ sub: { ...next, recordingsDir: next.audioFolder } });
  }

  /** Reset the given switches to their DEFAULT position (not to off). */
  function resetDefs(defs: readonly SettingDef[], label: string) {
    const undo = Object.fromEntries(
      defs.map((d) => [d.id, gates[d.id as SettingId]]),
    ) as Partial<Record<SettingId, boolean>>;
    setGates(
      Object.fromEntries(
        defs.map((d) => [d.id, DEFAULT_SETTING_SYNC[d.id as SettingId]]),
      ) as Partial<Record<SettingId, boolean>>,
    );
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

      {/* The list always renders — the master toggle sets switches, it never
          hides them; only Expand/Collapse and the filter control visibility. */}
      <>
        <div className="flex items-center gap-4 pb-2 text-[12px]">
            {/* Tri-state like the group masters: on = all expanded, off = all
                collapsed, mixed cycles mixed → expanded → collapsed. */}
            <label className="flex items-center gap-2 font-medium text-dim">
              <Toggle
                checked={
                  SYNC_GROUPS.every((g) => ui.expanded[g])
                    ? true
                    : SYNC_GROUPS.every((g) => !ui.expanded[g])
                      ? false
                      : "mixed"
                }
                ariaLabel="Expand all groups"
                onChange={(v) =>
                  patchUi({ expanded: Object.fromEntries(SYNC_GROUPS.map((g) => [g, v])) })
                }
              />
              Expand all
            </label>
            <span className="flex-1" />
            <label className="flex items-center gap-2 font-medium text-dim">
              Show changed &amp; off
              <Toggle
                checked={ui.changedOnly}
                ariaLabel="Show only changed and off switches"
                onChange={(v) => patchUi({ changedOnly: v })}
              />
            </label>
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
              onResetSetting={(def) => resetDefs([def], `“${def.label}” sync switch reset to default`)}
              onResetGroup={(defs) =>
                resetDefs(defs, `${defs.length} sync ${defs.length === 1 ? "switch" : "switches"} in ${SYNC_GROUP_LABEL[group]} reset to default`)
              }
            />
          ))}

          <div className="mt-4 flex items-center justify-end gap-3">
            {confirmAll ? (
              <>
                <span className="text-[12px] text-warn">
                  Reset {totalChanged} sync {totalChanged === 1 ? "switch" : "switches"} to
                  default? Your settings&rsquo; values stay untouched — this only changes what
                  this device syncs, and applies to this device only.
                </span>
                <button
                  type="button"
                  className="ring-signal rounded-lg border border-rec/40 px-3 py-1.5 text-[12px] font-semibold text-rec hover:bg-rec/10"
                  onClick={() => {
                    setConfirmAll(false);
                    resetDefs(
                      DEFS.filter((d) => changed.has(d.id as SettingId)),
                      `${totalChanged} sync ${totalChanged === 1 ? "switch" : "switches"} reset to default`,
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

      {toast && (
        <Toast
          actionLabel={toast.undo ? "Undo" : undefined}
          onAction={
            toast.undo
              ? () => {
                  setGates(toast.undo!);
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

  // Filter on → the group's exceptions (changed OR switch off), expansion
  // ignored; filter off → all rows when expanded, none when collapsed (the
  // header + summary IS the collapsed view). The header always renders so the
  // group master stays reachable in every mode.
  const isException = (d: SettingDef) =>
    !gates[d.id as SettingId] || changed.has(d.id as SettingId);
  const visible = changedOnly ? defs.filter(isException) : expanded ? defs : [];

  const summary =
    off.length === 0
      ? `all ${defs.length} synced`
      : `${on.length} synced · ${off.length} off${changedDefs.length ? ` · ${changedDefs.length} changed` : ""}`;

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
        {changedDefs.length > 0 && (
          <button
            type="button"
            title={`Reset ${changedDefs.length} ${changedDefs.length === 1 ? "switch" : "switches"} to default`}
            aria-label={`Reset ${changedDefs.length} changed ${changedDefs.length === 1 ? "switch" : "switches"} in ${SYNC_GROUP_LABEL[group]} to default`}
            onClick={() => onResetGroup(changedDefs)}
            className="ring-signal flex h-6 shrink-0 items-center gap-1 rounded-pill border border-line-strong px-2 font-mono text-[11px] tabular-nums text-dim hover:text-text"
          >
            <RotateCcw className="size-3" />
            {changedDefs.length}
          </button>
        )}
        <Toggle
          checked={master}
          ariaLabel={`Sync ${SYNC_GROUP_LABEL[group]}`}
          onChange={(v) =>
            onGateMany(
              Object.fromEntries(defs.map((d) => [d.id, v])) as Partial<Record<SettingId, boolean>>,
            )
          }
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
        // The one reset control: permanently visible while the switch differs
        // from its default (appears/disappears with the accent bar).
        <button
          type="button"
          title="Reset to default"
          aria-label={`Reset ${def.label} to default`}
          onClick={onReset}
          className="ring-signal grid size-7 shrink-0 place-items-center rounded-full border border-line-strong text-dim hover:text-text"
        >
          <RotateCcw className="size-3.5" />
        </button>
      )}
      <Toggle checked={gate} onChange={onGate} ariaLabel={`Sync ${def.label}`} />
    </div>
  );
}
