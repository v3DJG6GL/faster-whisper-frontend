// "What this device syncs" — the granular per-setting sync switches, rendered
// entirely from the settings manifest (one switch per Settings row, identical
// label, nesting mirrored). Boxed group cards with tri-state masters: a
// collapsed card shows only its header + summary counts; the "Changed &
// default-off" view answers "what is NOT following my account?" (rows whose
// sync switch differs from its default OR is off) without expanding —
// group headers always stay visible so the per-group masters remain reachable.
//
// Reset tiers, one direct control each (no menus): a permanent ↺ on a row
// whose switch differs from its default, a "↺ N" pill on a group header with
// N changed switches, and a subdued "Restore all defaults…" with an inline
// confirm + Undo toast. Resets restore the SYNC SWITCHES to their default
// map (on for everything except machine-specific settings) — they never
// touch the settings' values, and like all sync switches they are
// per-device, so a reset does not sync anywhere.

import { Fragment, useMemo, useRef, useState } from "react";
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
  withLegacySubKeys,
  type SettingDef,
  type SettingId,
  type SyncGroup,
} from "@/lib/settingsManifest";
import { groupPanelState, type Gates } from "@/lib/sync/syncGates";
import { DisclosureToggle, Segmented, Toast, Toggle } from "@/components/ui";

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

const DEFS: readonly SettingDef[] = (MANIFEST as readonly SettingDef[]).filter((d) => !d.localOnly);

export function SyncSettingsList({ enabled }: { enabled: boolean }) {
  const sync = useApp((s) => s.settings.sync);
  const updateSync = useApp((s) => s.updateSync);

  const gates = useMemo(
    () => completeGates(sync?.sub, sync?.categories),
    [sync],
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
  const patchUi = (p: Partial<UiState>) => {
    // Compute next outside the updater so persistence can't run on a discarded
    // concurrent-render value (StrictMode invokes updaters twice).
    const next = { ...ui, ...p, expanded: { ...ui.expanded, ...(p.expanded ?? {}) } };
    setUi(next);
    saveUiState(next);
  };

  const [toast, setToast] = useState<{
    /** Keys the <Toast>: its auto-dismiss timer re-arms only on new text, so a
     *  repeat action with identical text kept the old deadline for the new Undo. */
    id: number;
    text: string;
    undo?: Partial<Record<SettingId, boolean>>;
  } | null>(null);
  const toastSeq = useRef(0);
  const [confirmAll, setConfirmAll] = useState(false);

  function setGates(patch: Partial<Record<SettingId, boolean>>) {
    // Any gate change disarms "Restore all defaults…": otherwise a confirm left open
    // while the changes were cleared another way resurfaces on the next switch flip.
    setConfirmAll(false);
    const next = { ...gates, ...patch };
    // Persist the complete gate map plus the legacy mirror keys, so an older
    // app version reading this config still sees the audio-folder and auto-stop intent.
    updateSync({ sub: withLegacySubKeys(next) });
  }

  /** Set the given switches in one step and raise an Undo toast that restores
   *  exactly those switches — shared by every bulk action below. */
  function setDefsWithUndo(
    defs: readonly SettingDef[],
    valueOf: (d: SettingDef) => boolean,
    label: string,
  ) {
    const undo = Object.fromEntries(
      defs.map((d) => [d.id, gates[d.id as SettingId]]),
    ) as Partial<Record<SettingId, boolean>>;
    setGates(
      Object.fromEntries(defs.map((d) => [d.id, valueOf(d)])) as Partial<
        Record<SettingId, boolean>
      >,
    );
    setToast({ id: ++toastSeq.current, text: label, undo });
  }

  /** Reset the given switches to their DEFAULT position (not to off). */
  function resetDefs(defs: readonly SettingDef[], label: string) {
    setDefsWithUndo(defs, (d) => DEFAULT_SETTING_SYNC[d.id as SettingId], label);
  }

  // Tri-state like every GroupCard below: a boolean master would read "Off" on a
  // stock install (machine-specific rows default off).
  const onDefs = DEFS.filter((d) => gates[d.id as SettingId]);
  const master: boolean | "mixed" =
    onDefs.length === DEFS.length ? true : onDefs.length === 0 ? false : "mixed";
  const totalChanged = changed.size;
  // The exceptions view's unit: switch changed from default, or default-off.
  const totalExceptions = DEFS.filter(
    (d) => !gates[d.id as SettingId] || changed.has(d.id as SettingId),
  ).length;

  return (
    // `inert`, not pointer-events-none alone: the latter blocked the mouse but left every
    // switch and ↺ tab-reachable and Space-activatable while sync was off.
    <div className={cn(!enabled && "opacity-40")} inert={!enabled}>
      <div className="flex items-center gap-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-medium text-text">Sync everything</div>
          <div className="text-[12px] text-faint">
            On = every setting follows your account. Off = none do. In between = your picks below.
          </div>
        </div>
        <Toggle
          checked={master}
          ariaLabel="Sync everything"
          onChange={(v) =>
            setDefsWithUndo(
              DEFS,
              () => v,
              v
                ? "Every setting now syncs, including machine-specific ones"
                : "Sync switched off for every setting",
            )
          }
        />
      </div>

      <div className="flex items-center pb-2">
          {/* ONE view control: collapsed/expanded/exceptions are three values
              of the same state. Hand-toggled chevrons produce a mix no segment
              matches ("custom"): none renders active until a segment snaps
              the whole list back. */}
          <Segmented
            value={
              ui.changedOnly
                ? "exceptions"
                : SYNC_GROUPS.every((g) => ui.expanded[g])
                  ? "expanded"
                  : SYNC_GROUPS.every((g) => !ui.expanded[g])
                    ? "collapsed"
                    : ("custom" as const)
            }
            onChange={(v) => {
              if (v === "exceptions") patchUi({ changedOnly: true });
              else
                patchUi({
                  changedOnly: false,
                  expanded: Object.fromEntries(
                    SYNC_GROUPS.map((g) => [g, v === "expanded"]),
                  ),
                });
            }}
            options={[
              { value: "collapsed", label: "Collapsed" },
              { value: "expanded", label: "Expanded" },
              {
                value: "exceptions",
                label: `Changed & default-off${totalExceptions > 0 ? ` · ${totalExceptions}` : ""}`,
              },
            ]}
            ariaLabel="List view"
          />
        </div>

        {SYNC_GROUPS.map((group) => (
          <GroupCard
            key={group}
            group={group}
            gates={gates}
            changed={changed}
            expanded={!!ui.expanded[group]}
            changedOnly={ui.changedOnly}
            // "Changed & default-off" mode wins over `expanded`, so a chevron click leaves
            // the mode and flips what the arrow SHOWS (`shownOpen`) — in that mode it can
            // differ from the hidden `expanded` flag.
            onToggleExpand={(shownOpen) =>
              patchUi({ changedOnly: false, expanded: { [group]: !shownOpen } })
            }
            onGate={(id, v) => setGates({ [id]: v } as Partial<Record<SettingId, boolean>>)}
            // Same contract as "Sync everything" above: a mixed group's master overwrites the
            // user's per-row picks (machine-specific rows included) in one click, so snapshot
            // them for an Undo toast instead of setting the gates silently.
            onGroupMaster={(defs, v) =>
              setDefsWithUndo(
                defs,
                () => v,
                v
                  ? `Every ${SYNC_GROUP_LABEL[group]} setting now syncs${defs.some((d) => d.machineSpecific) ? ", including machine-specific ones" : ""}`
                  : `Sync switched off for ${SYNC_GROUP_LABEL[group]}`,
              )
            }
            onResetSetting={(def) => resetDefs([def], `“${def.label}” sync switch reset to default`)}
            onResetGroup={(defs) =>
              resetDefs(defs, `${defs.length} sync ${defs.length === 1 ? "switch" : "switches"} in ${SYNC_GROUP_LABEL[group]} reset to default`)
            }
          />
        ))}

        <div className="mt-4 flex items-center justify-end gap-3">
          {confirmAll && totalChanged > 0 ? (
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
              className="ring-signal rounded-lg border border-line px-3 py-1.5 text-[12px] text-faint enabled:hover:text-dim disabled:opacity-40"
              onClick={() => setConfirmAll(true)}
            >
              Restore all defaults…
            </button>
          )}
        </div>

      {toast && (
        <Toast
          key={toast.id}
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
  onGroupMaster,
  onResetSetting,
  onResetGroup,
}: {
  group: SyncGroup;
  gates: Gates;
  changed: ReadonlySet<SettingId>;
  expanded: boolean;
  changedOnly: boolean;
  onToggleExpand: (shownOpen: boolean) => void;
  onGate: (id: SettingId, v: boolean) => void;
  onGroupMaster: (defs: readonly SettingDef[], v: boolean) => void;
  onResetSetting: (def: SettingDef) => void;
  onResetGroup: (defs: SettingDef[]) => void;
}) {
  const defs = settingsOfGroup(group);
  const on = defs.filter((d) => gates[d.id as SettingId]);
  const off = defs.filter((d) => !gates[d.id as SettingId]);
  const changedDefs = defs.filter((d) => changed.has(d.id as SettingId));
  const master: boolean | "mixed" =
    off.length === 0 ? true : on.length === 0 ? false : "mixed";

  const { visible, panelOpen, owns } = groupPanelState(defs, gates, changed, expanded, changedOnly);

  const summary =
    off.length === 0
      ? `all ${defs.length} synced`
      : `${on.length} synced · ${off.length} off${changedDefs.length ? ` · ${changedDefs.length} changed` : ""}`;

  const panelId = `sync-group-${group}`;
  // `aria-controls` only when the toggle owns the panel: a collapsed group has no panel node,
  // and in "changed & default-off" mode the toggle does not drive it.
  return (
    <div className="mb-2.5 rounded-xl border border-line bg-surface px-4">
      <div className="flex items-center gap-3 py-2.5">
        <DisclosureToggle
          open={panelOpen}
          onToggle={() => onToggleExpand(panelOpen)}
          ariaControls={owns ? panelId : undefined}
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
          onChange={(v) => onGroupMaster(defs, v)}
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
          className="ring-signal grid size-7 shrink-0 place-items-center rounded-full border border-line-strong text-dim hover:text-text"
        >
          <RotateCcw className="size-3.5" />
        </button>
      )}
      <Toggle checked={gate} onChange={onGate} ariaLabel={`Sync ${def.label}`} />
    </div>
  );
}
