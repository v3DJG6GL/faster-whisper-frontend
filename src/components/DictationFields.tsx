// The insertion controls for the two OVERRIDE layers of the cascade — the Profile editor
// (per task) and App Rules (per target app) — which share the tri-state "Inherit" shape.
// Settings → Dictation, the global default the two inherit from, has no inherit state and
// keeps its own two-state rows; it imports `METHOD_OPTIONS` so the method's labels and
// order are pinned there too, and takes its row labels from the same manifest entries.
//
// One module because the surfaces had already drifted: App Rules called the method
// "Insert method" while Settings called it "Insertion method", and listed the same three
// options in a DIFFERENT order, with nothing pinning either. Labels now come from the
// settings manifest, so a rename reaches every surface by construction.
//
// Two structural rules, both learned from DecodeFields:
//  1. The cells are plain FUNCTIONS called inline, never nested components. Rendering them
//     as <Cell/> gives a fresh element type each keystroke, remounting the focused control.
//  2. This yields BARE Select/Toggle elements and lets each surface wrap them. SettingRow
//     and Labeled auto-clone an accessible name onto a DIRECT Select/Toggle child; a
//     fragment or wrapper here would silently strip the name on all three screens at once.

import { PASTE_PRESETS, pasteKey, pasteCodes } from "@/lib/paste";
import { Segmented, Select } from "@/components/ui";
import { SETTING } from "@/lib/settingsManifest";
import type { InsertMethod, InsertionOverrides } from "@/lib/types";

const INHERIT = "inherit";

export const METHOD_OPTIONS: { value: InsertMethod; label: string }[] = [
  { value: "paste", label: "Clipboard paste" },
  { value: "direct", label: "Direct typing" },
  { value: "clipboard", label: "Clipboard only" },
];

/** Labels for the four rows, from the manifest so the Sync list can never disagree. */
export const FIELD_LABEL = {
  insertMethod: SETTING.insertMethod.label,
  pasteShortcut: SETTING.pasteShortcut.label,
  autoEnter: SETTING.pressEnterAfter.label,
  restoreClipboard: SETTING.restoreClipboard.label,
} as const;

export interface DictationFieldsProps {
  value: InsertionOverrides;
  onChange: (next: InsertionOverrides) => void;
  /** Disable everything (e.g. an App Rule with "never type into this app" on). */
  disabled?: boolean;
}

/** The four insertion controls as an object of ready-to-place elements, so each surface
 *  can lay them out in its own row component without this one owning the chrome.
 *
 *  Deliberately NOT a component that renders rows: Settings uses SettingRow, the Profile
 *  editor uses a Labeled grid, and App Rules uses its own flat stack. Returning elements
 *  keeps one definition of each CONTROL while leaving the three layouts alone. */
export function dictationControls({ value, onChange, disabled }: DictationFieldsProps) {
  // A cleared control writes `undefined` and the key is PRUNED: "inherit" is the ABSENCE of a
  // value, which is what makes a later change to the layer below propagate. (App Rules map the
  // absence onto its stored `null` on the way out — that layer's own concern.) The prune also
  // drops a `null` that arrives inside `value` from App Rule state.
  const set = (patch: Partial<InsertionOverrides>) => {
    const next = { ...value, ...patch } as InsertionOverrides;
    for (const k of Object.keys(next) as (keyof InsertionOverrides)[]) {
      if (next[k] === undefined || next[k] === null) delete next[k];
    }
    onChange(next);
  };

  // A tri-state boolean, as Inherit / On / Off. Three explicit states, never a checkbox:
  // "not configured" and "explicitly off" are different answers, and a two-state control
  // cannot tell them apart — the classic scoped-settings bug. `methodDisabled` is the same
  // gate the paste-shortcut control and Settings → Dictation apply: an explicit method on
  // THIS layer that makes the control moot greys it; a mere inherit does not.
  const boolControl = (key: "autoEnter" | "restoreClipboard", methodDisabled: boolean) => (
    <Segmented
      ariaLabel={FIELD_LABEL[key]}
      disabled={disabled || methodDisabled}
      value={value[key] === true ? "on" : value[key] === false ? "off" : INHERIT}
      onChange={(v) => set({ [key]: v === INHERIT ? undefined : v === "on" } as Partial<InsertionOverrides>)}
      options={[
        { value: INHERIT, label: "Inherit" },
        { value: "on", label: "On" },
        { value: "off", label: "Off" },
      ]}
    />
  );

  return {
    insertMethod: (
      <Select
        ariaLabel={FIELD_LABEL.insertMethod}
        disabled={disabled}
        value={value.insertMethod ?? INHERIT}
        onChange={(v) => set({ insertMethod: v === INHERIT ? undefined : (v as InsertMethod) })}
        options={[{ value: INHERIT, label: "Inherit" }, ...METHOD_OPTIONS]}
      />
    ),
    pasteShortcut: (
      <Select
        ariaLabel={FIELD_LABEL.pasteShortcut}
        // Only "Clipboard paste" sends a chord. Inherit is left enabled: the effective
        // method may still be paste via the layer below, and disabling the control would
        // hide that the inherited chord is what will be sent.
        disabled={disabled || value.insertMethod === "direct" || value.insertMethod === "clipboard"}
        value={value.pasteShortcut ? pasteKey(value.pasteShortcut) : INHERIT}
        onChange={(v) => set({ pasteShortcut: v === INHERIT ? undefined : pasteCodes(v) })}
        options={[
          { value: INHERIT, label: "Inherit" },
          ...PASTE_PRESETS.map((p) => ({ value: p.value, label: p.label })),
        ]}
      />
    ),
    // No Enter to send when nothing is typed; no clipboard to restore unless pasting. Same
    // reasoning as the chord above: an explicit method on this layer disables them; a mere
    // inherit does not (mirrors Settings → Dictation's gates).
    autoEnter: boolControl("autoEnter", value.insertMethod === "clipboard"),
    restoreClipboard: boolControl(
      "restoreClipboard",
      value.insertMethod === "direct" || value.insertMethod === "clipboard",
    ),
  };
}

/** Does this layer override anything? Drives the "· set" / "· inherit" disclosure suffix. */
export function hasInsertionOverrides(v: InsertionOverrides | undefined): boolean {
  return !!v && Object.values(v).some((x) => x !== undefined && x !== null);
}
