import { useState } from "react";
import { ArrowUp, ArrowDown, Trash2, Plus } from "lucide-react";
import { swap } from "@/lib/arr";
import { Button, Select } from "@/components/ui";
import { VISIBLE_SCREENS, OVERLAY_ACTIONS, quickLaunchMeta } from "@/lib/screenRegistry";
import { safeDisplayText } from "@/lib/sanitize";
import type { OverlayQuickAction } from "@/lib/types";

const QUICK_LAUNCH_MAX = 6;

/** Editor for the overlay chip's quick-launch buttons: an ordered list of screens +
 *  dictation actions the user can add/reorder/remove (capped to fit the chip). */
export function QuickLaunchEditor({
  items,
  onChange,
  disabled,
}: {
  items: OverlayQuickAction[];
  onChange: (v: OverlayQuickAction[]) => void;
  disabled?: boolean;
}) {
  const [pick, setPick] = useState("");
  const used = new Set(items.map((e) => `${e.kind}:${e.target}`));
  const addable = [
    ...VISIBLE_SCREENS.map((s) => ({ value: `screen:${s.id}`, label: `Screen · ${s.label}` })),
    ...OVERLAY_ACTIONS.map((a) => ({ value: `action:${a.id}`, label: `Action · ${a.label}` })),
  ].filter((o) => !used.has(o.value));

  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    onChange(swap(items, i, j));
  };
  const add = () => {
    if (!pick) return;
    const [kind, target] = pick.split(":");
    onChange([
      ...items,
      {
        id: crypto.randomUUID(),
        kind: kind as "screen" | "action",
        target: target as OverlayQuickAction["target"],
      },
    ]);
    setPick("");
  };

  return (
    <div className="flex w-full flex-col gap-2">
      {items.length === 0 && (
        <div className="text-[12.5px] text-faint">No buttons yet — add screens or dictation actions below.</div>
      )}
      {items.map((e, i) => {
        const { label, icon: Icon } = quickLaunchMeta(e);
        return (
          <div
            key={e.id}
            className="flex items-center gap-2.5 rounded-xl border border-line bg-surface-2/40 px-3 py-2"
          >
            <Icon className="size-4 shrink-0 text-faint" />
            <span className="text-[13px] text-text">{label}</span>
            {/* `kind` is blob-authored: `withSettingsDefaults` type-checks it as a string but
                bounds neither its length nor its character set, and Rust round-trips the block
                without interpreting it. Its row-sibling `label` is already defanged by
                `quickLaunchMeta`; this one is rendered as a child two elements over. */}
            <span className="shrink-0 truncate font-mono text-[10px] uppercase tracking-label text-faint">
              {safeDisplayText(e.kind, 24)}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <Button variant="ghost" size="sm" title="Move up" onClick={() => move(i, -1)} disabled={disabled || i === 0}>
                <ArrowUp className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                title="Move down"
                onClick={() => move(i, 1)}
                disabled={disabled || i === items.length - 1}
              >
                <ArrowDown className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                title="Remove"
                onClick={() => onChange(items.filter((x) => x.id !== e.id))}
                disabled={disabled}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </div>
        );
      })}
      {items.length < QUICK_LAUNCH_MAX && addable.length > 0 && (
        <div className="flex items-center gap-2">
          <Select
            className="flex-1"
            value={pick}
            onChange={setPick}
            options={[{ value: "", label: "Add a button…" }, ...addable]}
            ariaLabel="Add a quick-launch button"
            disabled={disabled}
          />
          <Button size="sm" onClick={add} disabled={disabled || !pick}>
            <Plus className="size-3.5" /> Add
          </Button>
        </div>
      )}
    </div>
  );
}
