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

  // Tri-state like every GroupCard below: a boolean master read "Off" forever
  // on a stock install (machine-specific rows default off), and one click from
  // there overwrote the whole curated map with all-true — no confirm, no undo.
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
            On = all settings follow your account. Off = pick per setting below.
          </div>
        </div>
        <Toggle
          checked={master}
          ariaLabel="Sync everything"
          onChange={(v) => {
            const undo = Object.fromEntries(
              DEFS.map((d) => [d.id, gates[d.id as SettingId]]),
            ) as Partial<Record<SettingId, boolean>>;
            setGates(
              Object.fromEntries(DEFS.map((d) => [d.id, v])) as Partial<Record<SettingId, boolean>>,
            );
            setToast({
              text: v
                ? "Every setting now syncs, including machine-specific ones"
                : "Sync switched off for every setting",
              undo,
            });
          }}
        />
      </div>

      {/* The list always renders — the master toggle sets switches, it never
          hides them; only Expand/Collapse and the filter control visibility. */}
      <div className="flex items-center pb-2">
          {/* ONE view control — collapsed/expanded/exceptions are three
              values of the same state, so two switches always left a dead
              combination. Hand-toggled chevrons produce a mix no segment
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
            // A chevron in "Changed & default-off" mode was inert (that mode wins over
            // `expanded`): make it leave the mode, so the click does what the arrow shows.
            onToggleExpand={() =>
              patchUi({ changedOnly: false, expanded: { [group]: !ui.expanded[group] } })
            }
            onGate={(id, v) => setGates({ [id]: v } as Partial<Record<SettingId, boolean>>)}
            onGateMany={(patch) => setGates(patch)}
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
              className="ring-signal rounded-lg border border-line px-3 py-1.5 text-[12px] text-faint hover:text-dim disabled:opacity-40"
              onClick={() => setConfirmAll(true)}
            >
              Restore all defaults…
            </button>
          )}
        </div>

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


/** The disclosure contract for one group, in one place: which rows render,
 *  whether the panel is open, and whether the toggle honestly OWNS that panel.
 *  Filter on → the group's exceptions (changed OR switch off), expansion
 *  ignored, and the toggle drives nothing so it claims no `aria-controls`;
 *  filter off → all rows when expanded, none when collapsed (the header +
 *  summary IS the collapsed view). The header always renders so the group
 *  master stays reachable in every mode. */
export function groupPanelState(
  defs: SettingDef[],
  gates: Record<SettingId, boolean>,
  changed: ReadonlySet<SettingId>,
  expanded: boolean,
  changedOnly: boolean,
): { visible: SettingDef[]; panelOpen: boolean; owns: boolean } {
  const isException = (d: SettingDef) =>
    !gates[d.id as SettingId] || changed.has(d.id as SettingId);
  const visible = changedOnly ? defs.filter(isException) : expanded ? defs : [];
  const panelOpen = visible.length > 0;
  return { visible, panelOpen, owns: !changedOnly && panelOpen };
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
  const { visible, panelOpen, owns } = groupPanelState(defs, gates, changed, expanded, changedOnly);

  const summary =
    off.length === 0
      ? `all ${defs.length} synced`
      : `${on.length} synced · ${off.length} off${changedDefs.length ? ` · ${changedDefs.length} changed` : ""}`;

  const panelId = `sync-group-${group}`;
  // What the toggle CLAIMS must match what is on screen: in "changed & default-off" mode the
  // panel shows exceptions while `expanded` is false, and a collapsed group has no panel node
  // for `aria-controls` to point at. In that mode the toggle does not drive the panel, so it
  // owns none.
  return (
    <div className="mb-2.5 rounded-xl border border-line bg-surface px-4">
      <div className="flex items-center gap-3 py-2.5">
        <DisclosureToggle
          open={panelOpen}
          onToggle={onToggleExpand}
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
