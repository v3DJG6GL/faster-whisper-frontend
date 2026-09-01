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

/** The inherit sentinel. One spelling everywhere — App Rules used to say "Inherit global",
 *  which stopped being true the moment a Profile layer existed between the two. */
export const INHERIT = "inherit";

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

/** How an override layer stores "inherit": Profile omits the key, AppRule stores `null`.
 *  Both resolve identically through `??`; this only decides what a cleared control writes. */
export type InheritSentinel = "undefined" | "null";

export interface DictationFieldsProps {
  value: InsertionOverrides;
  onChange: (next: InsertionOverrides) => void;
  /** What a cleared control writes back — see InheritSentinel. */
  sentinel?: InheritSentinel;
  /** Disable everything (e.g. an App Rule with "never type into this app" on). */
  disabled?: boolean;
}

/** The four insertion controls as an object of ready-to-place elements, so each surface
 *  can lay them out in its own row component without this one owning the chrome.
 *
 *  Deliberately NOT a component that renders rows: Settings uses SettingRow, the Profile
 *  editor uses a Labeled grid, and App Rules uses its own flat stack. Returning elements
 *  keeps one definition of each CONTROL while leaving the three layouts alone. */
export function dictationControls({ value, onChange, sentinel = "undefined", disabled }: DictationFieldsProps) {
  const cleared = sentinel === "null" ? null : undefined;
  // The patch is nullable because a cleared control may write AppRule's `null` sentinel;
  // both spellings are pruned below, so the stored shape stays clean either way.
  const set = (patch: { [K in keyof InsertionOverrides]?: InsertionOverrides[K] | null }) => {
    const next = { ...value, ...patch } as InsertionOverrides;
    // Prune cleared keys rather than storing a sentinel: "inherit" is the ABSENCE of a
    // value, which is what makes a later change to the layer below propagate. Storing
    // `undefined` explicitly would also make `isDirty` see a change on first open.
    for (const k of Object.keys(next) as (keyof InsertionOverrides)[]) {
      if (next[k] === undefined || next[k] === null) delete next[k];
    }
    onChange(next);
  };

  // A tri-state boolean, as Inherit / On / Off. Three explicit states, never a checkbox:
  // "not configured" and "explicitly off" are different answers, and a two-state control
  // cannot tell them apart — the classic scoped-settings bug.
  const boolControl = (key: "autoEnter" | "restoreClipboard") => (
    <Segmented
      ariaLabel={FIELD_LABEL[key]}
      disabled={disabled}
      value={value[key] === true ? "on" : value[key] === false ? "off" : INHERIT}
      onChange={(v) => set({ [key]: v === INHERIT ? cleared : v === "on" } as Partial<InsertionOverrides>)}
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
        onChange={(v) => set({ insertMethod: v === INHERIT ? cleared : (v as InsertMethod) })}
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
        onChange={(v) => set({ pasteShortcut: v === INHERIT ? cleared : pasteCodes(v) })}
        options={[
          { value: INHERIT, label: "Inherit" },
          ...PASTE_PRESETS.map((p) => ({ value: p.value, label: p.label })),
        ]}
      />
    ),
    // No Enter to send when nothing is typed. Same reasoning as the chord above: an
    // explicit "Clipboard only" here disables it; a mere inherit does not.
    autoEnter: boolControl("autoEnter"),
    restoreClipboard: boolControl("restoreClipboard"),
  };
}

/** Does this layer override anything? Drives the "· set" / "· inherit" disclosure suffix. */
export function hasInsertionOverrides(v: InsertionOverrides | undefined): boolean {
  return !!v && Object.values(v).some((x) => x !== undefined && x !== null);
}
